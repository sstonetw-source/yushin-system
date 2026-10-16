// Authoritative PO, supply commitments and source-order linkage. Incoming remains a separate checkpoint.
async function commitFormalPurchaseOrder(poRecord, {actorUid=currentUser?.uid,actorRole=currentUserRole}={}) {
        poRecord=JSON.parse(JSON.stringify(poRecord));
        if (!poRecord || typeof poRecord.poNo!=='string' || !poRecord.poNo.trim() || poRecord.poNo.includes('/')
            || !String(poRecord.vendorName||'').trim() || !Array.isArray(poRecord.items) || !poRecord.items.length)
            throw new Error('採購單號、供應商或品項不完整。');
        for (const item of poRecord.items) {
            if (!Number.isFinite(Number(item.qty)) || Number(item.qty)<=0
                || item.unitPrice===null || item.unitPrice===undefined || item.unitPrice===''
                || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice)<0)
                throw new Error('請填寫有效採購數量與單價（可填 0）。');
        }
        const assertActor=()=>{
            if (!actorUid || currentUser?.uid!==actorUid || currentUserRole!==actorRole)
                throw new Error('登入身份已變更，請以原帳號重新確認採購單。');
            if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) throw new Error('目前無採購作業權限。');
        };
        assertActor();
        const actorName=currentUserName||currentUser?.email||'', now=poRecord.createdAt||new Date().toISOString();
        const poNo=poRecord.poNo, vendorName=poRecord.vendorName, poDocumentId=poNo;
        const orderIds=[...new Set(poRecord.items.map(item=>item.orderId).filter(Boolean))];
        let committedSourceOrders = [];
        let committedSupplyOrders = [];
        await runRoleTransaction(async transaction => {
            assertActor();
            committedSourceOrders = [];
            committedSupplyOrders = [];
            const plannedDemands=new Map();
            const demandWrites=new Map();
            const poRef = db.collection('purchaseOrders').doc(poDocumentId);
            const orderRefs = orderIds.map(orderId => db.collection('orders').doc(orderId));
            const poSnapshot = await transaction.get(poRef);
            const orderSnapshots = await Promise.all(orderRefs.map(ref => transaction.get(ref)));
            assertActor();
            if (poSnapshot.exists) {
                const saved=poSnapshot.data();
                const ignored=new Set(['createdAt','lastOutputAt','lastOutputType','supplyOrderIds']);
                const intent=record=>Object.fromEntries(Object.keys(poRecord).filter(key=>!ignored.has(key)).map(key=>[key,record[key]]));
                const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
                    ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
                if (JSON.stringify(canonical(intent(saved)))!==JSON.stringify(canonical(intent(poRecord))))
                    throw new Error(`採購單號 ${poNo} 已存在且內容不同，請先核對原單。`);
                const ids=poRecord.items.map((_,index)=>formalSupplyOrderId(poDocumentId,index));
                if (JSON.stringify(saved.supplyOrderIds)!==JSON.stringify(ids)) throw new Error('既有採購單供應連結不完整，請先核對原單。');
                const supplies=await Promise.all(ids.map(id=>transaction.get(supplyOrdersCollection().doc(id))));
                assertActor();
                supplies.forEach((snapshot,index)=>{
                    const data=snapshot.exists?snapshot.data():null;
                    const item=poRecord.items[index];
                    if (!data || data.purchaseDocumentId!==poDocumentId || data.createdByUid!==actorUid || data.type!=='PURCHASING_PO'
                        || Number(data.qty)!==Number(item.qty) || Number(data.unitCost)!==Number(item.unitPrice)
                        || data.productKey!==poIncomingKey(item) || data.supplier!==(poRecord.supplierName||vendorName)
                        || data.sourceId!==(item.orderId||item.sourceId||'') || data.sourceItemId!==(item.itemId||item.sourceItemId||''))
                        throw new Error('既有採購供應紀錄與本次作業不符，請先核對原單。');
                    committedSupplyOrders.push({id:ids[index],...data});
                });
                committedSourceOrders=orderSnapshots.filter(snapshot=>snapshot.exists).map(snapshot=>({id:snapshot.id,...snapshot.data()}));
                poRecord=saved;
                return;
            }
            orderSnapshots.forEach((snapshot, index) => {
                if (!snapshot.exists) throw new Error('來源訂單已不存在。');
                assertPurchaseLinesAvailable(snapshot.data(), poRecord.items.filter(item => item.orderId === orderIds[index]));
            });
            const supplyOrderIds = [];
            poRecord.items.forEach((item,itemIndex)=>{
                const sourceType=item.sourceType||(item.orderId?'SALES_ORDER':'STOCK_REPLENISHMENT');
                let demandProjection;
                let sourceOrderForDemand=null;
                let sourceItemForDemand=null;
                if(sourceType==='SALES_ORDER'){
                    const sourceSnapshot=orderSnapshots.find(snapshot=>snapshot.id===item.orderId);
                    if(!sourceSnapshot?.exists)throw new Error('採購需求找不到來源訂單。');
                    sourceOrderForDemand={id:sourceSnapshot.id,...sourceSnapshot.data()};
                    const sourceItems=normalizedOrderItems(sourceOrderForDemand);
                    sourceItemForDemand=sourceItems.find(row=>row.itemId===item.itemId)
                        || sourceItems[Number(item.orderItemIndex||0)];
                    if(!sourceItemForDemand)throw new Error('採購需求找不到來源訂單品項。');
                    demandProjection=procurementDemandForOrderItem(sourceOrderForDemand,sourceItemForDemand);
                }else{
                    demandProjection=globalThis.YushinProcurementDemand.normalizeDemand({
                        demandId:item.demandId||globalThis.YushinProcurementDemand.demandIdForSource({
                            sourceType,sourceId:item.sourceId||item.productId||item.itemCode||''
                        }),
                        sourceType,
                        sourceId:item.sourceId||item.productId||item.itemCode||'',
                        sourceItemId:'',
                        requestedQty:Number(item.demandRequestedQty??item.qty??0),
                        orderedQty:Number(item.demandOrderedQty||0),
                        receivedQty:Number(item.demandReceivedQty||0),
                        // Stock replenishment has no customer required-by date by default.
                        // item.scheduleDate here is supplier ETA and must not become demand timing.
                        scheduleDate:String(item.demandScheduleDate||item.requiredByDate||'').trim()
                    });
                }
                if (plannedDemands.has(demandProjection.demandId)) {
                    if (sourceType!=='SALES_ORDER') throw new Error('同一補貨需求請合併為單一採購列，避免重複承諾。');
                    demandProjection=plannedDemands.get(demandProjection.demandId);
                }
                const demandOrderPlan=globalThis.YushinProcurementDemand.applyOrder(demandProjection,Number(item.qty||0));
                if(demandOrderPlan.appliedQty!==Number(item.qty||0)){
                    throw new Error('採購需求數量已變更，請重新整理後再建立採購單。');
                }
                plannedDemands.set(demandProjection.demandId,demandOrderPlan.demand);
                const demandRef=procurementDemandRef(demandProjection.demandId);
                const demandDoc=procurementDemandDocument(demandOrderPlan.demand,{
                    productId:item.productId||sourceItemForDemand?.productId||'',
                    productKey:poIncomingKey(item)||inventoryProductKey(sourceItemForDemand||{}),
                    itemCode:item.itemCode||sourceItemForDemand?.itemCode||'',
                    itemName:item.itemName||sourceItemForDemand?.itemName||'',
                    brand:resolveBrandName(item.brand||sourceItemForDemand?.brand||''),
                    fulfillmentType:item.fulfillmentType||sourceItemForDemand?.fulfillmentType||'WAREHOUSE',
                    warehouseId:(item.fulfillmentType||sourceItemForDemand?.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'
                        ? '' : (item.warehouseId||sourceItemForDemand?.warehouseId||defaultWarehouse()?.id||''),
                    ownerUid:item.ownerUid||sourceOrderForDemand?.ownerUid||'',
                    salesCode:item.salesCode||sourceOrderForDemand?.salesCode||'',
                    salesName:item.salesName||sourceOrderForDemand?.salesName||'',
                    // Preserve Material Request required-by timing. Do not overwrite it
                    // with this PO line's vendor delivery estimate.
                    scheduleDate:demandProjection.scheduleDate
                        ||sourceItemForDemand?.requiredByDate
                        ||sourceItemForDemand?.scheduleDate
                        ||sourceOrderForDemand?.requiredByDate
                        ||sourceOrderForDemand?.expectedDate
                        ||''
                },{
                    createdAt:sourceOrderForDemand?.createdAt||poRecord.createdAt,
                    updatedAt:poRecord.createdAt
                });

                const supplyId=formalSupplyOrderId(poDocumentId,itemIndex);
                const supplyRef=supplyOrdersCollection().doc(supplyId);
                supplyOrderIds.push(supplyId);
                const supplyRecord={
                    // ERPNext-style：採購方式與需求來源分開。
                    // 正式採購單永遠是 PURCHASING_PO；是否為客戶需求或備庫由 sourceType 表示。
                    type:'PURCHASING_PO',
                    method:'PURCHASING_PO',
                    sourceType,
                    sourceId:item.orderId||item.sourceId||'',
                    sourceItemId:item.itemId||item.sourceItemId||'',
                    demandId:demandProjection.demandId||'',
                    internalNo:poNo,
                    purchaseDocumentId:poDocumentId,
                    purchaseDocumentNo:poNo,
                    status:'ORDERED',
                    orderId:item.orderId||'',
                    itemId:item.itemId||'',
                    orderItemIndex:Number(item.orderItemIndex||0),
                    ownerUid:item.ownerUid||'',
                    salesCode:item.salesCode||'',
                    salesName:item.salesName||'',
                    productId:item.productId||'',
                    productKey:poIncomingKey(item),
                    itemCode:item.itemCode||'',
                    itemName:item.itemName||'',
                    brand:resolveBrandName(item.brand||''),
                    brandId:item.brandId||brandIdForName(item.brand||''),
                    qty:Number(item.qty||0),
                    receivedQty:0,
                    incomingRegisteredQty:0,
                    supplier:poRecord.supplierName||vendorName,
                    supplierId:poRecord.supplierId||'',
                    supplierEmail:poRecord.supplierEmail||'',
                    unitCost:Number(item.unitPrice||0),
                    orderDate:poRecord.poDate,
                    expectedDate:item.scheduleDate||poRecord.expectedDate||'',
                    scheduleDate:item.scheduleDate||poRecord.scheduleDate||poRecord.expectedDate||'',
                    fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                    warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||defaultWarehouse()?.id||''),
                    createdAt:poRecord.createdAt,
                    updatedAt:poRecord.createdAt,
                    createdByUid:actorUid,
                    createdBy:actorName,
                    createdByRole:actorRole
                };
                transaction.set(supplyRef,supplyRecord);
                if(demandRef)demandWrites.set(demandProjection.demandId,{ref:demandRef,doc:demandDoc});
                committedSupplyOrders.push({id:supplyId,...supplyRecord});
            });
            poRecord.supplyOrderIds=supplyOrderIds;
            demandWrites.forEach(({ref,doc})=>transaction.set(ref,doc,{merge:true}));
            transaction.set(poRef, poRecord);
            orderSnapshots.forEach((snapshot, index) => {
                if (snapshot.exists) {
                    const orderData = snapshot.data();
                    const orderedLines=poRecord.items.filter(item=>item.orderId===snapshot.id);
                    const nextItems=normalizedOrderItems(orderData).map((item,itemIndex)=>{
                        const matches=orderedLines.filter(line=>Number(line.orderItemIndex)===itemIndex);
                        const orderedQty=matches.reduce((sum,line)=>sum+Number(line.qty||0),0);
                        const currentSupplyOrdered=Math.max(0,Number(item.supplyOrderedQty||0));
                        const cumulative=currentSupplyOrdered+orderedQty;
                        const identityLine=matches.find(line=>line.itemId&&item.itemId&&line.itemId===item.itemId)||matches[0];
                        return orderedQty>0?{
                            ...item,
                            // 採購單可補齊來源訂單原本缺少的產品識別資料；已有值不覆蓋，
                            // 避免「來源貨號空白 → 採購頁可填 → 儲存又被擋住」的死路流程。
                            productId:item.productId||identityLine?.productId||'',
                            itemCode:item.itemCode||identityLine?.itemCode||'',
                            itemName:item.itemName||identityLine?.itemName||'',
                            brand:item.brand||resolveBrandName(identityLine?.brand||''),
                            brandId:item.brandId||identityLine?.brandId||brandIdForName(item.brand||identityLine?.brand||''),
                            productLine:item.productLine||identityLine?.productLine||'',
                            supplyOrderedQty:cumulative,
                            purchaseDocumentNos:[...new Set([...(item.purchaseDocumentNos||[]),poNo])],
                            orderedAt:item.orderedAt && item.orderedAt < poRecord.poDate ? item.orderedAt : poRecord.poDate,
                            orderEvents:[
                                ...(item.orderEvents||[]).filter(event=>event.id!==poDocumentId),
                                {id:poDocumentId,type:'PURCHASING_PO',at:now,date:poRecord.poDate||'',qty:orderedQty,documentNo:poNo,by:poRecord.buyerName||actorName}
                            ]
                        }:item;
                    });
                    const nextOrderData={...orderData,items:nextItems,itemCount:nextItems.length,orderSchemaVersion:2};
                    const orderUpdates = {
                        items:nextItems,itemCount:nextItems.length,orderSchemaVersion:2,
                        ...orderWorkIndexFields(nextOrderData),
                        linkedDocuments: normalizeDocumentLinks([...(orderData.linkedDocuments || []), documentLink(DOCUMENT_TYPES.PURCHASE_ORDER, poDocumentId, 'document')])
                    };
                    transaction.update(orderRefs[index], orderUpdates);
                    committedSourceOrders.push({id:snapshot.id,...orderData,...orderUpdates});
                }
            });
        });

        return {poRecord,committedSourceOrders,committedSupplyOrders};
}
// Formal purchase service end.
