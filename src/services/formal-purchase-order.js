// Document preparation writes only the versioned PO snapshot, never supply/demand/stock.
function formalPurchaseDocumentIntent(record) {
    const ignored = new Set(['id','createdAt','updatedAt','lastOutputAt','lastOutputType','supplyOrderIds',
        'status','documentOnly','documentRevision','confirmedAt','confirmedByUid']);
    const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
    return JSON.stringify(canonical(Object.fromEntries(Object.entries(record).filter(([key]) => !ignored.has(key)))));
}
async function saveFormalPurchaseDocument(record, {actorUid=currentUser?.uid,actorRole=currentUserRole,expectedRevision=0}={}) {
    const check = () => {
        if (!actorUid || actorUid!==currentUser?.uid || actorRole!==currentUserRole
            || !canCreatePurchaseOrderCapability() || !canAccessPage('orders.po'))
            throw Error('登入身分或採購權限已變更。');
    };
    check();
    record=JSON.parse(JSON.stringify(record));
    if (!record?.poNo || record.poNo.includes('/') || !record.vendorName?.trim()
        || !Array.isArray(record.items) || !record.items.length
        || record.items.some(item=>!Number.isFinite(Number(item.qty)) || Number(item.qty)<=0
            || item.unitPrice===null || item.unitPrice==='' || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice)<0))
        throw Error('採購文件的單號、供應商、數量或價格不完整。');
    delete record.id; delete record.supplyOrderIds;
    record={...record,status:'DRAFT',documentOnly:true,documentRevision:1,createdByUid:actorUid,createdByRole:actorRole};
    let saved;
    await runRoleTransaction(async tx=>{
        check();
        const ref=db.collection('purchaseOrders').doc(record.poNo),snapshot=await tx.get(ref);
        check();
        if (snapshot.exists) {
            saved=snapshot.data();
            if(saved.status!=='DRAFT' || saved.documentOnly!==true)
                throw Error('這個單號已確認採購，請開啟原單核對。');
            record.createdByUid=saved.createdByUid;record.createdByRole=saved.createdByRole;
            if(formalPurchaseDocumentIntent(saved)===formalPurchaseDocumentIntent(record))return;
            if(!Number.isSafeInteger(expectedRevision) || expectedRevision<1
                || expectedRevision!==(saved.documentRevision||1))
                throw Error('這個單號已有不同內容，請重新載入原文件後再編輯。');
            saved={...record,createdAt:saved.createdAt,documentRevision:expectedRevision+1,updatedAt:new Date().toISOString()};
            tx.set(ref,saved);return;
        }
        saved=record;tx.set(ref,record);
    });
    check();return {id:saved.poNo,...saved};
}
// Authoritative PO, supply commitments and source-order linkage. Incoming remains a separate checkpoint.
async function commitFormalPurchaseEmulator(poRecord,actorUid,assertActor) {
    const local=host=>['localhost','127.0.0.1'].includes(host);
    if(typeof APP_ENVIRONMENT==='undefined'||APP_ENVIRONMENT!=='emulator'
        ||!local(globalThis.location?.hostname)||typeof firebase==='undefined'||!firebase.functions)
        throw new Error('採購後端試點僅限明確啟用的本機 Emulator。');
    const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
    if(auth.app?.options?.projectId!=='demo-yushin'||functions.app?.options?.projectId!=='demo-yushin'
        ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
        throw new Error('採購必須使用 demo-yushin 本機登入與 Functions Emulator。');
    const check=()=>{assertActor();if(auth.currentUser?.uid!==actorUid)throw new Error('實際登入身分已變更，請以原帳號核對採購結果。');};
    check();
    if(poRecord.items.length>5||poRecord.items.some(item=>!item.orderId||!item.itemId
        ||(item.sourceType&&item.sourceType!=='SALES_ORDER')
        ||!['WAREHOUSE','DIRECT_SHIP'].includes(item.fulfillmentType||'WAREHOUSE')))
        throw new Error('採購後端試點目前只支援 1–5 個客戶訂單實體入庫或直送品項。');
    const request={poNo:poRecord.poNo,poDate:poRecord.poDate,
        supplier:poRecord.supplierName||poRecord.vendorName,
        items:poRecord.items.map(item=>({orderId:item.orderId,itemId:item.itemId,
            qty:Number(item.qty),unitCost:Number(item.unitPrice)})),
        document:{company:poRecord.company,supplierSnapshot:poRecord.supplierSnapshot,
            expectedDate:poRecord.expectedDate||'',expectedDateSource:poRecord.expectedDateSource||'',
            lineScheduleDates:poRecord.items.map(item=>item.scheduleDate||'')}};
    if(poRecord.documentRevision)request.documentRevision=poRecord.documentRevision;
    functions.useEmulator('127.0.0.1',5001);
    // A failed/unknown Callable never falls through to the old client writer.
    const reply=await functions.httpsCallable('commitV2FormalPurchase')(request);check();
    const result=reply?.data,ids=request.items.map((_,index)=>formalSupplyOrderId(request.poNo,index));
    if(!['committed','already-applied'].includes(result?.status)||result.poNo!==request.poNo
        ||JSON.stringify(result.supplyOrderIds)!==JSON.stringify(ids))
        throw new Error('採購回覆不明確，請保留原單號核對，勿另建新單。');
    const read=async(name,id)=>{
        const snapshot=await db.collection(name).doc(id).get({source:'server'});check();
        if(!snapshot.exists)throw new Error('採購可能已提交，但回讀資料不完整，請保留原單號核對。');
        return {id,...snapshot.data()};
    };
    const saved=await read('purchaseOrders',request.poNo);
    const committedSourceOrders=[];for(const id of [...new Set(request.items.map(item=>item.orderId))])committedSourceOrders.push(await read('orders',id));
    const committedSupplyOrders=[];for(const id of ids)committedSupplyOrders.push(await read('supplyOrders',id));
    check();return {poRecord:saved,committedSourceOrders,committedSupplyOrders};
}
async function commitFormalPurchaseOrder(poRecord, {actorUid=currentUser?.uid,actorRole=currentUserRole}={}) {
        // Validate numbers before JSON snapshotting: JSON turns NaN/Infinity into null.
        if(poRecord && Array.isArray(poRecord.items) && poRecord.items.some(item=>
            ['demandRequestedQty','demandOrderedQty','demandReceivedQty'].some(key=>
                item[key]!==undefined && item[key]!==null
                && (!Number.isFinite(Number(item[key])) || Number(item[key])<0))))
            throw new Error('採購需求數量不正確。');
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
        if(globalThis.YUSHIN_FORMAL_PURCHASE_EMULATOR===true)
            return commitFormalPurchaseEmulator(poRecord,actorUid,assertActor);
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
            if (poSnapshot.exists && poSnapshot.data().status==='DRAFT' && poSnapshot.data().documentOnly===true) {
                const draft=poSnapshot.data();
                if (formalPurchaseDocumentIntent(draft)!==formalPurchaseDocumentIntent(poRecord))
                    throw Error('採購文件與確認內容不同，請重新開啟原單。');
                poRecord={...poRecord,status:'ORDERED',documentOnly:false,
                    confirmedAt:now,confirmedByUid:actorUid};
            } else if (poSnapshot.exists) {
                const saved=poSnapshot.data();
                const ignored=new Set(['id','createdAt','updatedAt','lastOutputAt','lastOutputType','supplyOrderIds','status','documentOnly','confirmedAt','confirmedByUid']);
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
                        || data.sourceId!==(item.orderId||item.sourceId||('MANUAL_PO:'+poDocumentId+':'+index)) || data.sourceItemId!==(item.itemId||item.sourceItemId||''))
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
            // Stock POs do not necessarily update a source sales order. Lock each
            // deterministic demand document inside this transaction before writing
            // any supply or PO records; competing POs will then conflict/retry.
            // Independent direct-stock purchases get their own per-PO demand ID.
            const stockDemands=new Map();
            const stockDemandInputs=new Map();
            poRecord.items.forEach((item,index)=>{
                const sourceType=item.sourceType||(item.orderId?'SALES_ORDER':'STOCK_REPLENISHMENT');
                if(!['SALES_ORDER','STOCK_REPLENISHMENT'].includes(sourceType))
                    throw new Error('採購需求來源類型不正確。');
                if(sourceType!=='STOCK_REPLENISHMENT')return;
                const sourceId=String(item.sourceId||'').trim()||('MANUAL_PO:'+poDocumentId+':'+index);
                const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType,sourceId});
                if(item.demandId&&item.demandId!==demandId)throw new Error('採購需求識別與品項來源不符，請重新開啟採購單。');
                if(!poIncomingKey(item))throw new Error('庫存採購缺少有效產品識別。');
                if([...stockDemandInputs.values()].some(row=>row.demandId===demandId))
                    throw new Error('同一補貨需求請合併為單一採購列，避免重複承諾。');
                stockDemandInputs.set(index,{sourceId,demandId});
            });
            await Promise.all([...stockDemandInputs.values()].map(async ({demandId})=>{
                const ref=procurementDemandRef(demandId);
                if(!ref)throw new Error('採購需求文件識別不正確。');
                const snap=await transaction.get(ref);
                stockDemands.set(demandId,{ref,data:snap.exists?snap.data():null});
            }));
            assertActor();
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
                    const input=stockDemandInputs.get(itemIndex);
                    const snapshot=stockDemands.get(input.demandId)?.data;
                    const requestedQty=Number(item.demandRequestedQty??item.qty??0);
                    const orderedQty=Number(item.demandOrderedQty||0);
                    const receivedQty=Number(item.demandReceivedQty||0);
                    if(![requestedQty,orderedQty,receivedQty].every(value=>Number.isFinite(value)&&value>=0))
                        throw new Error('庫存補貨需求數量不正確。');
                    if(snapshot){
                        if(snapshot.demandId!==input.demandId||snapshot.sourceType!==sourceType
                            ||snapshot.sourceId!==input.sourceId||snapshot.sourceItemId!==''
                            ||snapshot.productKey!==poIncomingKey(item))
                            throw new Error('既有庫存補貨需求識別與品項不一致，請先核對紀錄。');
                        if(snapshot.status==='CANCELLED')throw new Error('此補貨需求已取消，請先恢復後再建立採購單。');
                        if(![snapshot.requestedQty,snapshot.orderedQty,snapshot.receivedQty].every(value=>typeof value==='number'&&Number.isFinite(value)&&value>=0)
                            ||snapshot.orderedQty>snapshot.requestedQty||snapshot.receivedQty>snapshot.orderedQty)
                            throw new Error('既有補貨需求數量不一致，請先核對供應紀錄。');
                    }
                    // Persisted commitments win over stale modal values. A previously
                    // stored demand cannot silently grow from an old browser snapshot.
                    // Independent/manual POs use unique IDs and start from zero.
                    demandProjection=globalThis.YushinProcurementDemand.normalizeDemand({
                        demandId:input.demandId,sourceType,sourceId:input.sourceId,sourceItemId:'',
                        requestedQty:snapshot?Math.max(snapshot.orderedQty,Math.min(snapshot.requestedQty,requestedQty)):requestedQty,
                        orderedQty:snapshot?snapshot.orderedQty:orderedQty,
                        receivedQty:snapshot?snapshot.receivedQty:receivedQty,
                        scheduleDate:snapshot?.scheduleDate||String(item.demandScheduleDate||item.requiredByDate||'').trim()
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
                const demandRef=sourceType==='STOCK_REPLENISHMENT'
                    ?stockDemands.get(demandProjection.demandId)?.ref
                    :procurementDemandRef(demandProjection.demandId);
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
                    sourceId:sourceType==='STOCK_REPLENISHMENT'?demandProjection.sourceId:(item.orderId||item.sourceId||''),
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
