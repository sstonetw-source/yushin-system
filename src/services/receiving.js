function receiptOperationStorageKey(supplyId, ownerUid = currentUser?.uid || '') {
    return `yushin-receipt-operation:${ownerUid}:${String(supplyId || '')}`;
}
function ensureReceiptOperationId(supplyId) {
    const key=receiptOperationStorageKey(supplyId);
    let operationId='';
    try { operationId=sessionStorage.getItem(key)||''; } catch (_) {}
    if(!operationId){
        operationId=`receipt-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
        try { sessionStorage.setItem(key,operationId); } catch (_) {}
    }
    poReceiptOperationId=operationId;
    return operationId;
}
function clearReceiptOperationId(supplyId, completedOperationId = '', ownerUid = currentUser?.uid || '') {
    try {
        const key=receiptOperationStorageKey(supplyId,ownerUid);
        if(!completedOperationId||sessionStorage.getItem(key)===completedOperationId)sessionStorage.removeItem(key);
    } catch (_) {}
    if(currentUser?.uid===ownerUid&&(!completedOperationId||poReceiptOperationId===completedOperationId))poReceiptOperationId='';
}
window.closePoReceiptBatch = function() {
    document.getElementById('poReceiptBatchOverlay')?.classList.remove('active');
    const body=document.getElementById('poReceiptBatchBody');
    if(body)body.innerHTML='';
    poReceiptTargetId='';
};


window.receiveSupplyOrder = function(supplyId) {
    if (!canReceiveInventoryCapability()) { alert('您沒有到貨入庫權限。'); return; }
    if (receiptTaskBlocksSupply(supplyId)) return;
    const supply=pendingSupplyCache.find(row=>row.id===supplyId);
    if(!supply)return;
    const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
    if(remaining<=0){alert('這筆訂貨已全部入庫。');return;}
    poReceiptTargetId='supply:'+supplyId;
    ensureReceiptOperationId(supplyId);
    const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
    const title=document.getElementById('poReceiptBatchTitle');
    if(title)title.textContent=directShip ? `原廠直送到貨｜${supply.internalNo||supplyId}` : `到貨入庫｜${supply.internalNo||supplyId}`;
    const body=document.getElementById('poReceiptBatchBody');
    body.innerHTML=`<tr data-index="0">
      <td><input type="checkbox" class="po-receive-select" checked></td>
      <td>${escapeHtml(supply.itemCode||'')}</td>
      <td>${escapeHtml(supply.itemName||'')}</td>
      <td>${Number(supply.qty||0)}</td><td>${Number(supply.receivedQty||0)}</td><td>${remaining}</td>
      <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
      <td><input type="text" class="po-receive-lot" placeholder="批號"></td>
      <td><input type="date" class="po-receive-expiry"></td>
    </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

async function allocateFreeReceiptStockToShortages(productKey,warehouseId,maxQty,actor,excludeOrderId='',receiptId='',checkpointCollection='receipts',allocationGuard=null) {
    allocationGuard?.();
    if(!['receipts','stockTransfers'].includes(checkpointCollection))throw new Error('庫存分配進度來源不正確。');
    let remaining=Math.max(0,Number(maxQty||0)),allocatedQty=0;
    const affectedOrderIds = new Set();
    const skippedCandidateIds = new Set();
    let completionReason='exhausted';
    if(!remaining||!productKey||!warehouseId)return {allocatedQty:0,unallocatedQty:remaining,affectedOrderIds:[]};
    const compare=globalThis.YushinReservation?.compareReservationPriority;
    if(!compare)throw new Error('庫存分配核心未載入，請重新載入後重試分配。');
    // Allocate one live shortage at a time. Re-reading candidates after every successful
    // transaction preserves oldest-first ordering even when multiple receipts run concurrently.
    // 已失效／取消的最舊候選只跳過，不可阻塞後面的正常缺貨訂單。
    while(remaining>0){
        allocationGuard?.();
        const oldestCandidate=async status=>{
            let candidate=null,cursor=null;
            while(true){
                let q=db.collection('inventoryReservations').where('productKey','==',productKey).where('status','==',status).limit(50);
                if(cursor)q=q.startAfter(cursor);
                const page=await firestoreReadWithTimeout(q.get(),'庫存預留候選');
                for(const doc of page.docs){
                    const row={...doc.data(),id:doc.id};
                    if(row.orderId===excludeOrderId||row.warehouseId!==warehouseId||!(Number(row.shortageQty||0)>0)||skippedCandidateIds.has(row.id))continue;
                    if(!candidate||compare(row,candidate)<0)candidate=row;
                }
                if(page.size<50)break;
                const last=page.docs[page.docs.length-1];
                if(!last||last.id===cursor?.id)throw new Error('庫存預留分頁未前進，請重新載入後重試分配。');
                cursor=last;
            }
            return candidate;
        };
        const candidates=await Promise.all([oldestCandidate('shortage'),oldestCandidate('active')]);
        const candidate=candidates.filter(Boolean).sort(compare)[0];
        if(!candidate){completionReason='no-demand';break;}
        let took=0,skipCandidate=false,stopAllocation=false;
        await runRoleTransaction(async tx=>{
            took=0;skipCandidate=false;stopAllocation=false;
            allocationGuard?.();
            const orderRef=db.collection('orders').doc(candidate.orderId);
            const reservationRef=db.collection('inventoryReservations').doc(candidate.id);
            const invRef=db.collection('inventory').doc(encodeURIComponent(productKey));
            const whRef=db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey));
            const receiptRef=receiptId?db.collection(checkpointCollection).doc(receiptId):null;
            const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:candidate.orderId,sourceItemId:candidate.itemId});
            const demandRef=procurementDemandRef(demandId);
            const [orderSnap,resSnap,invSnap,whSnap,receiptSnap]=await Promise.all([
                tx.get(orderRef),tx.get(reservationRef),tx.get(invRef),tx.get(whRef),
                receiptRef?tx.get(receiptRef):Promise.resolve(null)
            ]);
            const demandSnap=await tx.get(demandRef);
            allocationGuard?.();
            if(!orderSnap.exists||!resSnap.exists||!whSnap.exists||!invSnap.exists){skipCandidate=true;return;}
            if(receiptRef&&!receiptSnap?.exists){completionReason='deferred';stopAllocation=true;return;}
            const reservation=resSnap.data();
            if(reservation.productKey!==productKey||reservation.warehouseId!==warehouseId){skipCandidate=true;return;}
            const liveShortage=Math.max(0,Number(reservation.shortageQty||0));
            const order={id:orderSnap.id,...orderSnap.data()};
            if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order)||liveShortage<=0){skipCandidate=true;return;}
            const inv=inventoryNumbers(invSnap.exists?invSnap.data():{}),wh=inventoryNumbers(whSnap.data());
            const receipt=receiptSnap?.exists?(receiptSnap.data()||{}):null;
            const receiptTarget=receiptRef?Math.max(0,Number(receipt?.autoAllocationQty||0)):remaining;
            const receiptAllocated=receiptRef?Math.max(0,Number(receipt?.autoAllocatedQty||0)):0;
            const receiptRemaining=receiptRef?Math.max(0,receiptTarget-receiptAllocated):remaining;
            const items=normalizedOrderItems(order);
            const index=items.findIndex(item=>item.itemId===reservation.itemId);
            if(index<0){skipCandidate=true;return;}
            const item=items[index],oldReserved=Number(item.reservedQty||0);
            if(inventoryProductKey(item)!==productKey||item.warehouseId!==warehouseId||item.transferPendingId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'){skipCandidate=true;return;}
            const oldShortage=Math.max(0,Number(item.shortageQty??liveShortage));
            // 已向供應商下訂的缺口不能再占用補貨，否則現貨與待到貨重複涵蓋同一需求。
            if(Math.abs(oldReserved-Number(reservation.quantity||0))>1e-9||Math.abs(oldShortage-liveShortage)>1e-9)throw new Error('訂單與庫存預留數量不一致，請由管理員檢查後重試。');
            const uncovered=remainingProcurementQty(order,item);
            if(uncovered<=0){skipCandidate=true;return;}
            const take=Math.min(remaining,receiptRemaining,liveShortage,oldShortage,uncovered,Math.max(0,wh.available),Math.max(0,inv.available));
            if(take<=0){completionReason='exhausted';stopAllocation=true;return;}
            items[index]={...item,reservedQty:oldReserved+take,shortageQty:Math.max(0,oldShortage-take)};
            const now=new Date().toISOString();
            const nextOrder={...order,items,updatedAt:now};
            tx.update(orderRef,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
            const demand=procurementDemandForOrderItem(nextOrder,items[index]);
            tx.set(demandRef,procurementDemandDocument({...(demandSnap.exists?demandSnap.data():{}),...demand},{
                sourceItemIndex:index,productId:item.productId||'',productKey,
                itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
                fulfillmentType:'WAREHOUSE',warehouseId,ownerUid:order.ownerUid||'',
                salesCode:order.salesCode||'',salesName:order.salesName||''
            },{createdAt:demandSnap.exists?demandSnap.data().createdAt:order.createdAt||now,updatedAt:now}),{merge:true});
            tx.update(reservationRef,{quantity:Number(reservation.quantity||0)+take,shortageQty:Math.max(0,liveShortage-take),status:'active',updatedAt:now});
            if(invSnap.exists)tx.update(invRef,{reserved:inv.reserved+take,updatedAt:now});
            tx.update(whRef,{reserved:wh.reserved+take,updatedAt:now});
            if(receiptRef){
                const nextAllocated=receiptAllocated+take;
                tx.update(receiptRef,{
                    autoAllocatedQty:nextAllocated,
                    allocationCompleted:nextAllocated>=receiptTarget,
                    allocationUpdatedAt:now
                });
            }
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(allocationGuard?'reserve_from_free_stock':'reserve_from_receipt',take,candidate.orderId,productKey,actor,{
                warehouseId,itemId:reservation.itemId||'',fulfillmentType:'WAREHOUSE',
                ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',
                ...(checkpointCollection==='receipts'?{receiptId:receiptId||''}:{transferId:receiptId||''})
            }));
            took=take;
        });
        if(took>0){invalidateWarehouseStockCache(productKey,warehouseId);allocatedQty+=took;remaining-=took;affectedOrderIds.add(candidate.orderId);continue;}
        if(skipCandidate){
            // 避免同一輪一直選到已取消／失效的舊 reservation；改看下一個候選。
            skippedCandidateIds.add(candidate.id);
            continue;
        }
        if(stopAllocation)break;
        break;
    }
    return {allocatedQty,unallocatedQty:remaining,affectedOrderIds:[...affectedOrderIds],completionReason};
}

async function refreshAffectedOrderCaches(orderIds = []) {
    const ids=[...new Set(orderIds.filter(Boolean))];
    if(!ids.length)return;
    const cacheUid=currentUser?.uid||'',cacheRole=currentUserRole;
    const refreshedOrders=await readDocumentsByIds('orders',ids);
    if(!cacheUid||currentUser?.uid!==cacheUid||currentUserRole!==cacheRole)throw new Error('登入帳號或角色已變更，請重新載入訂單清單。');
    refreshedOrders.forEach(order=>{
        const index=ordersCache.findIndex(row=>row.id===order.id);
        if(index>=0)ordersCache[index]=order;else ordersCache.unshift(order);
        syncOrderIntoPurchasingCaches(order, { render:false });
    });
    ordersCache.sort((a,b)=>(b.orderDate||'').localeCompare(a.orderDate||''));
    writeAppDataCache('orders',ordersCache);
    if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
}

async function receiveSupplyOrderRecord(supplyId,qty,lotNo='',expiryDate='',operationId='') {
    const now=new Date().toISOString(),actor=deliveryActor();
    const operationKey=String(operationId||'').trim();
    if(!operationKey)throw new Error('缺少到貨操作識別碼，請重新開啟待到貨視窗後再試。');
    let receivedProductKey='',receivedWarehouseId='',sourceOrderId='',sourceOrderStatus='',reservedForSource=0,alreadyProcessed=false,processedReceipt=null;
    const affectedOrderIds = new Set();
    await runRoleTransaction(async tx=>{
        const supplyRef=supplyOrdersCollection().doc(supplyId);
        const receiptRef=db.collection('receipts').doc(operationKey);
        const supplySnap=await tx.get(supplyRef);
        const receiptSnap=await tx.get(receiptRef);
        if(!supplySnap.exists)throw new Error('找不到供應紀錄。');
        const supply=supplySnap.data();
        if(!canConfirmSupplyReceipt(supply))throw new Error('原廠直送由該訂單負責業務確認；倉庫收貨僅限採購、倉管或管理員。');
        if (!globalThis.YushinSupply?.normalize || !globalThis.YushinReceiving?.buildReceiptSnapshot
            || !globalThis.YushinProcurementDemand?.applyReceipt) {
            throw new Error('Supply／Receiving／Procurement Demand core 未載入，無法建立可追溯的到貨紀錄。');
        }
        const demandRef=procurementDemandRef(supply.demandId||'');
        const demandSnap=demandRef?await tx.get(demandRef):null;
        const procurement=globalThis.YushinSupply.normalize({...supply,id:supplyId});
        const updateDemandReceipt=(receiptQty)=>{
            if(!demandRef)return;
            const fallbackRequested=Math.max(
                Number(supply.qty||0),
                Number(supply.receivedQty||0)+Number(receiptQty||0)
            );
            const baseDemand=demandSnap?.exists
                ? demandSnap.data()
                : globalThis.YushinProcurementDemand.normalizeDemand({
                    demandId:supply.demandId||'',
                    sourceType:supply.sourceType||(supply.orderId?'SALES_ORDER':'STOCK_REPLENISHMENT'),
                    sourceId:supply.sourceId||supply.orderId||'',
                    sourceItemId:supply.sourceItemId||supply.itemId||'',
                    requestedQty:fallbackRequested,
                    orderedQty:Math.max(fallbackRequested,Number(supply.qty||0)),
                    receivedQty:Number(supply.receivedQty||0),
                    scheduleDate:''
                });
            const receiptDemandPlan=globalThis.YushinProcurementDemand.applyReceipt(baseDemand,receiptQty);
            if(receiptDemandPlan.appliedQty!==Number(receiptQty||0)){
                throw new Error('採購需求收貨數量已變更，請重新整理後再試。');
            }
            if(demandSnap?.exists){
                const next=receiptDemandPlan.demand;
                tx.update(demandRef,{receivedQty:next.receivedQty,remainingToReceiveQty:next.remainingToReceiveQty,perReceived:next.perReceived,status:next.status,updatedAt:now});
                return;
            }
            if(['sales','engineer'].includes(currentUserRole))throw new Error('直送供應缺少採購需求紀錄，請由採購確認後再重試。');
            const demandDoc=procurementDemandDocument(receiptDemandPlan.demand,{
                sourceItemIndex:Number.isInteger(supply.orderItemIndex)?supply.orderItemIndex:baseDemand.sourceItemIndex,
                productId:supply.productId||'',
                productKey:supply.productKey||'',
                itemCode:supply.itemCode||'',
                itemName:supply.itemName||'',
                brand:supply.brand||'',
                fulfillmentType:supply.fulfillmentType||'WAREHOUSE',
                warehouseId:(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(supply.warehouseId||''),
                ownerUid:supply.ownerUid||'',
                salesCode:supply.salesCode||'',
                salesName:supply.salesName||'',
                scheduleDate:baseDemand.scheduleDate||''
            },{
                createdAt:baseDemand.createdAt||supply.createdAt||now,
                updatedAt:now
            });
            tx.set(demandRef,demandDoc,{merge:true});
        };
        const buildReceipt=(event={})=>globalThis.YushinReceiving.buildReceiptSnapshot(procurement,{
            supplyOrderId:supplyId,
            receiptDate:localDateString(),
            createdAt:now,
            createdBy:actor,
            ...event
        });
        if (supply.orderId) affectedOrderIds.add(supply.orderId);
        // 已成功提交過的同一 receiptId 必須先走冪等重試；即使之後取消了剩餘未到貨，
        // 也不能把已完成的到貨重試誤判成新的「取消後收貨」。
        if(receiptSnap.exists){
            const receipt=receiptSnap.data()||{};
            if(String(receipt.supplyOrderId||'')!==String(supplyId))throw new Error('到貨操作識別碼衝突，請重新開啟待到貨視窗。');
            alreadyProcessed=true;
            processedReceipt=receipt;
            if((receipt.fulfillmentType||supply.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
                receivedProductKey=String(receipt.productKey||supply.productKey||supply.productId||'').trim();
                receivedWarehouseId=String(receipt.warehouseId||supply.warehouseId||'').trim();
                sourceOrderId=receipt.orderId||supply.orderId||'';
            }
            return;
        }
        if (isPurchaseTerminalStatus(supply.status)) {
            throw new Error(String(supply.status||'').toUpperCase()==='CLOSED'
                ? '此供應紀錄已結案，不能再確認到貨。'
                : '此供應紀錄已取消，不能再確認到貨。');
        }
        const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
        if(qty<=0||qty>remaining)throw new Error(`本次到貨數量不可超過 ${remaining}。`);
        const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        if(directShip){
            if(!supply.orderId||!supply.itemId)throw new Error('原廠直送紀錄缺少來源訂單／品項。');
            const orderRef=db.collection('orders').doc(supply.orderId);
            const orderSnap=await tx.get(orderRef);
            if(!orderSnap.exists)throw new Error('找不到來源訂單。');
            const order=orderSnap.data();
            if(currentUserRole!=='admin'&&order.ownerUid!==currentUser?.uid)throw new Error('只有此訂單負責業務可確認直送到貨。');
            if(normalizedOrderStatus(order)!=='normal')throw new Error('來源訂單已取消，不能繼續確認到貨；請先處理／恢復來源訂單。');
            const items=normalizedOrderItems(order);
            const itemIndex=items.findIndex(item=>item.itemId===supply.itemId);
            if(itemIndex<0)throw new Error('找不到來源訂單品項。');
            const item=items[itemIndex];
            // Purchase Receipt / Delivery are cumulative ERP events. A replacement after a return
            // can legitimately make gross delivered quantity exceed the original ordered quantity.
            // Completion is decided from net delivered (gross - returns), not by truncating history.
            const delivered=Number(item.deliveredQty||0)+qty;
            items[itemIndex]={
                ...item,
                receivedQty:Number(item.receivedQty||0)+qty,
                deliveredQty:delivered,
                directShipDeliveredQty:Number(item.directShipDeliveredQty||0)+qty,
                receiptEvents:[
                    ...(item.receiptEvents||[]),
                    {id:operationKey,at:now,date:localDateString(),qty,sourceId:supplyId,by:actor,fulfillmentType:'DIRECT_SHIP'}
                ]
            };
            const deliveryRecord={
                id:`direct-${operationKey}`,receiptId:operationKey,itemId:supply.itemId,itemIndex,date:localDateString(),qty,
                notes:'原廠直送到貨確認',createdBy:actor,createdAt:now,sourceType:'DIRECT_SHIP_RECEIPT',sourceId:supplyId
            };
            const deliveryRecords=[...savedDeliveryRecords(order),deliveryRecord];
            const grossDelivered=deliveryRecords.reduce((sum,row)=>sum+Number(row.qty||0),0);
            const returned=returnedQuantity(order);
            const total=orderQuantity({...order,items});
            const nextOrder={
                ...order,items,itemCount:items.length,orderSchemaVersion:2,
                deliveryRecords,deliveredQty:grossDelivered,
                isDelivered:Math.max(0,grossDelivered-returned)>=total&&total>0,
                updatedAt:now
            };
            tx.update(orderRef,{
                items,itemCount:items.length,orderSchemaVersion:2,
                deliveryRecords,deliveredQty:grossDelivered,isDelivered:nextOrder.isDelivered,
                ...orderWorkIndexFields(nextOrder),updatedAt:now
            });
            const receiptPlan=globalThis.YushinSupply.applyReceipt(procurement,qty);
            const receivedQty=receiptPlan.record.receivedQty;
            tx.update(supplyRef,{receivedQty,status:receiptPlan.record.status,updatedAt:now});
            updateDemandReceipt(qty);
            tx.set(receiptRef,buildReceipt({
                receiptId:operationKey,
                operationId:operationKey,
                qty,
                cumulativeReceivedQty:receivedQty,
                fulfillmentType:'DIRECT_SHIP',
                warehouseId:''
            }));
            return;
        }
        const productKey=supply.productKey||supply.productId||(supply.itemCode?`code:${normalizeHistoryItemCode(supply.itemCode)}`:'');
        if(!productKey)throw new Error('此品項缺少 產品識別碼／貨號。');
        const warehouseId=supply.warehouseId||defaultWarehouse()?.id||'';
        if(!warehouseId)throw new Error('此供應紀錄尚未指定入庫倉庫，無法安全入庫。');
        receivedProductKey=productKey;receivedWarehouseId=warehouseId;sourceOrderId=supply.orderId||'';
        const invRef=db.collection('inventory').doc(encodeURIComponent(productKey));
        const whRef=warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)):null;
        const invSnap=await tx.get(invRef);
        const whSnap=whRef?await tx.get(whRef):null;
        const inv=inventoryNumbers(invSnap.exists?invSnap.data():{});
        const wh=inventoryNumbers(whSnap?.exists?whSnap.data():{});
        let order=null,items=[],itemIndex=-1,reserveQty=0;
        if(supply.orderId){
            const orderRef=db.collection('orders').doc(supply.orderId);
            const reservationRef=db.collection('inventoryReservations').doc(`${supply.orderId}__${supply.itemId}`);
            const orderSnap=await tx.get(orderRef);
            const reservationSnap=await tx.get(reservationRef);
            if(orderSnap.exists){
                order=orderSnap.data();
                sourceOrderStatus=normalizedOrderStatus(order);
                if(sourceOrderStatus!=='normal'&&supply.customerCancellationDisposition!=='KEEP_STOCK')throw new Error('請先由採購確認供應商答覆，保留採購轉庫存後再收貨。');
                // 倉庫型採購即使來源訂單已取消，供應商仍可能照常出貨。
                // 此時貨照常入庫，但不可再占回已取消訂單；整批視為自由庫存。
                items=normalizedOrderItems(order);itemIndex=items.findIndex(item=>item.itemId===supply.itemId);
                if(itemIndex>=0){
                    const item=items[itemIndex];
                    if(sourceOrderStatus==='normal'){
                        if(!reservationSnap.exists)throw new Error('來源訂單缺少庫存預留紀錄，無法安全入庫。');
                        const reservation=reservationSnap.data();
                        const currentReserved=Math.max(0,Number(reservation.quantity||0));
                        const receiptPlan=window.YushinReceiving.applyReceiptToOrderItem({...item,reservedQty:currentReserved},qty);
                        const next=receiptPlan.item;
                        reserveQty=receiptPlan.reservedDelta;
                        reservedForSource=reserveQty;
                        items[itemIndex]={
                            ...next,
                            reservedQty:next.reservedQty,
                            receiptEvents:[
                                ...(item.receiptEvents||[]),
                                {id:operationKey,at:now,date:localDateString(),qty,sourceId:supplyId,by:actor,fulfillmentType:'WAREHOUSE'}
                            ]
                        };
                        const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                        tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                        tx.set(reservationRef,{
                            orderId:supply.orderId,itemId:supply.itemId,orderNo:order.orderNo||order.quoteNo||supply.orderId,
                            productKey,itemCode:supply.itemCode||'',itemName:supply.itemName||'',customerName:order.customerName||'',
                            ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',salesName:order.salesName||'',orderDate:order.orderDate||'',
                            quantity:Number(next.reservedQty||0),shortageQty:Number(next.shortageQty||0),
                            status:Number(next.reservedQty||0)>0?'active':'shortage',warehouseId,updatedAt:now
                        },{merge:true});
                    }else{
                        // 取消中的來源訂單不重新占庫存，但仍同步實際到貨摘要。
                        // 這樣日後恢復訂單時，不會把已經到倉的數量再次誤判成在途採購。
                        const receiptPlan=window.YushinReceiving.applyReceiptToOrderItem({...item,reservedQty:0},qty);
                        items[itemIndex]={
                            ...item,
                            receivedQty:receiptPlan.item.receivedQty,
                            receiptEvents:[
                                ...(item.receiptEvents||[]),
                                {id:operationKey,at:now,date:localDateString(),qty,sourceId:supplyId,by:actor,fulfillmentType:'WAREHOUSE',sourceOrderStatus:'cancelled'}
                            ]
                        };
                        const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                        tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                    }
                }
            }
        }
        const receiptPlan=globalThis.YushinSupply.applyReceipt(procurement,qty);
        const registeredIncoming=Math.max(0,Number(supply.incomingRegisteredQty||0));
        const incomingRelease=receiptPlan.incomingReleaseQty;
        const embeddedLots=[...(invSnap.exists?(invSnap.data().lots||[]):[])];
        const embeddedIndex=embeddedLots.findIndex(l=>(l.lotNo||'')===lotNo&&(l.expiryDate||'')===expiryDate);
        if(embeddedIndex>=0)embeddedLots[embeddedIndex]={...embeddedLots[embeddedIndex],qty:Number(embeddedLots[embeddedIndex].qty||0)+qty};
        else embeddedLots.push({lotNo,expiryDate,qty,receivedAt:now,sourceSupplyId:supplyId});
        {
          const nextInventory={...(invSnap.exists?invSnap.data():{}),productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:inv.onHand+qty,reserved:inv.reserved+reserveQty,incoming:Math.max(0,inv.incoming-incomingRelease),lots:embeddedLots,updatedAt:now};
          nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
          tx.set(invRef,nextInventory,{merge:true});
        }
        if(whRef)tx.set(whRef,{warehouseId,productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:wh.onHand+qty,reserved:wh.reserved+reserveQty,incoming:Math.max(0,wh.incoming-incomingRelease),updatedAt:now},{merge:true});
        const lotRef=db.collection('inventoryLots').doc();
        tx.set(lotRef,{productKey,productId:supply.productId||'',warehouseId,lotNo,expiryDate,receivedQty:qty,remainingQty:qty,supplier:supply.supplier||'',sourceType:'SUPPLY_ORDER',sourceId:supplyId,receivedAt:now});
        tx.set(db.collection('inventoryLotCosts').doc(lotRef.id),{lotId:lotRef.id,productKey,productId:supply.productId||'',warehouseId,...(currentUserRole==='warehouse'&&permissionRulesReady?{costSourceSupplyId:supplyId}:{unitCost:Number(supply.unitCost||0)}),sourceType:'SUPPLY_ORDER',sourceId:supplyId,createdAt:now,createdBy:actor});
        const autoAllocationQty=Math.max(0,Number(qty||0)-reserveQty);
        tx.set(receiptRef,buildReceipt({
            receiptId:operationKey,
            operationId:operationKey,
            qty,
            cumulativeReceivedQty:receiptPlan.record.receivedQty,
            productKey,
            warehouseId,
            fulfillmentType:'WAREHOUSE',
            extra:{
                sourceOrderStatus,
                autoAllocationQty,
                autoAllocatedQty:0,
                allocationCompleted:autoAllocationQty===0,
                lotId:lotRef.id,
                lotNo,
                expiryDate
            }
        }));
        tx.set(db.collection('inventoryMovements').doc(),{type:'receipt',qty,productKey,warehouseId,lotNo,expiryDate,sourceType:'SUPPLY_ORDER',sourceId:supplyId,receiptId:operationKey,createdAt:now,createdBy:actor,ownerUid:supply.ownerUid||'',salesCode:supply.salesCode||''});
        updateDemandReceipt(qty);
        tx.update(supplyRef,{
            receivedQty:receiptPlan.record.receivedQty,
            incomingRegisteredQty:receiptPlan.record.incomingRegisteredQty,
            status:receiptPlan.record.status,
            updatedAt:now
        });
    });
    if (receivedProductKey && receivedWarehouseId) invalidateWarehouseStockCache(receivedProductKey, receivedWarehouseId);

    // Replenishment / excess receipt stock automatically serves oldest outstanding shortages.
    // The physical receipt is already committed before this phase. If this follow-up is interrupted,
    // the same immutable receiptId is reused to count prior allocations and only the remainder is retried.
    let freeQty=receivedProductKey&&receivedWarehouseId?Math.max(0,Number(qty||0)-reservedForSource):0;
    if(alreadyProcessed){
        const allocationTarget=Math.max(0,Number(processedReceipt?.autoAllocationQty||0));
        if(allocationTarget>0){
            const priorMovements=await readQueryInBatches(
                db.collection('inventoryMovements').where('receiptId','==',operationKey)
            );
            const alreadyAllocated=priorMovements
                .filter(row=>row.type==='reserve_from_receipt')
                .reduce((sum,row)=>sum+Math.max(0,Number(row.qty||0)),0);
            let reconciledAllocated=alreadyAllocated;
            await runRoleTransaction(async tx=>{
                const receiptRef=db.collection('receipts').doc(operationKey);
                const receiptSnap=await tx.get(receiptRef);
                if(!receiptSnap.exists)return;
                const receipt=receiptSnap.data()||{};
                const currentAllocated=Math.max(0,Number(receipt.autoAllocatedQty||0));
                reconciledAllocated=Math.max(currentAllocated,alreadyAllocated);
                if(reconciledAllocated!==currentAllocated){
                    tx.update(receiptRef,{
                        autoAllocatedQty:reconciledAllocated,
                        allocationCompleted:reconciledAllocated>=allocationTarget,
                        allocationUpdatedAt:new Date().toISOString()
                    });
                }
            });
            freeQty=Math.max(0,allocationTarget-reconciledAllocated);
        }else{
            freeQty=0;
        }
    }
    if(freeQty>0){
        try{
            const allocation=await allocateFreeReceiptStockToShortages(
                receivedProductKey,receivedWarehouseId,freeQty,actor,sourceOrderId,operationKey
            );
            allocation.affectedOrderIds.forEach(id=>affectedOrderIds.add(id));
        }catch(allocationErr){
            const error=new Error(
                '到貨已完成，但其他缺貨訂單的自動庫存分配尚未完成：'
                +(allocationErr?.message||allocationErr)
                +'。請再按一次「確認到貨」重試；系統不會重複入庫。'
            );
            error.code='receipt-allocation-pending';
            error.receiptCommitted=true;
            error.affectedOrderIds=[...affectedOrderIds];
            throw error;
        }
    }
    return [...affectedOrderIds];
}

window.openSupplyReceipt = function(supplyId) {
    if (receiptTaskBlocksSupply(supplyId)) return;
    const supply = supplyReceivingCache.find(row => row.id === supplyId);
    if (!supply) { alert('找不到這筆待到貨紀錄，請重新整理。'); return; }
    if (!canConfirmSupplyReceipt(supply)) { showActionFeedback('原廠直送請由該訂單負責業務確認到貨。','warning');return; }

    const ordered = Math.max(0, Number(supply.qty || 0));
    const received = Math.max(0, Number(supply.receivedQty || 0));
    const remaining = Math.max(0, ordered - received);
    if (remaining <= 0) { alert('此品項已全部到貨。'); return; }

    const directShip = (supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
    poReceiptTargetId = `supply:${supply.id}`;
    ensureReceiptOperationId(supply.id);
    const body = document.getElementById('poReceiptBatchBody');
    const title = document.getElementById('poReceiptBatchTitle');
    if (title) title.textContent = directShip
        ? `原廠直送到貨｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`
        : `到貨入庫｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`;
    body.innerHTML = `
        <tr data-index="0">
            <td><input type="checkbox" class="po-receive-select" checked></td>
            <td>${escapeHtml(supply.itemCode || '')}</td>
            <td>${escapeHtml(supply.itemName || '')}</td>
            <td>${ordered}</td><td>${received}</td><td>${remaining}</td>
            <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
            <td><input type="text" class="po-receive-lot" placeholder="批號" ${directShip ? 'disabled' : ''}></td>
            <td><input type="date" class="po-receive-expiry" ${directShip ? 'disabled' : ''}></td>
        </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

const receiptTaskJobs = new Map();
const restoredReceiptTaskUsers = new Set();

function receiptTaskKey(supplyId, ownerUid = currentUser?.uid || '') {
    return `${ownerUid}:${supplyId}`;
}
function persistReceiptTasks(ownerUid) {
    try {
        const jobs=[...receiptTaskJobs.values()].filter(job=>job.ownerUid===ownerUid&&job.state!=='done');
        sessionStorage.setItem(`yushin-receipt-tasks:${ownerUid}`,JSON.stringify(jobs));
    } catch(err) { console.warn('無法暫存背景到貨工作，請保持頁面開啟：',err); }
}
function restoreReceiptTasks() {
    const uid=currentUser?.uid;
    if(!uid||restoredReceiptTaskUsers.has(uid))return;
    restoredReceiptTaskUsers.add(uid);
    try {
        const jobs=JSON.parse(sessionStorage.getItem(`yushin-receipt-tasks:${uid}`)||'[]');
        if(Array.isArray(jobs))jobs.forEach(job=>{
            if(job.ownerUid!==uid||typeof job.supplyId!=='string'||!job.supplyId||typeof job.operationBase!=='string'||!job.operationBase||!Array.isArray(job.entries)||!job.entries.length
                ||job.entries.some(entry=>!Number.isFinite(entry.qty)||entry.qty<=0||!Number.isInteger(entry.itemIndex)||entry.itemIndex<0))return;
            const key=receiptTaskKey(job.supplyId,uid);
            if(!receiptTaskJobs.has(key))receiptTaskJobs.set(key,{...job,state:'error',error:'上次處理結果尚未確認；可用原資料重試，系統不會重複入庫。'});
        });
    } catch(err) { console.warn('背景到貨暫存讀取失敗：',err); }
}
function renderReceiptTasks() {
    const panel=document.getElementById('receiptTaskStatus');
    if(!panel)return;
    const jobs=[...receiptTaskJobs.values()].filter(job=>job.ownerUid===currentUser?.uid);
    panel.hidden=!jobs.length;
    panel.innerHTML=jobs.map(job=>`<div class="receipt-task ${job.state==='error'?'receipt-task-error':''}">
        <span>${escapeHtml(job.label)}：${job.state==='error'?escapeHtml(job.error):'到貨處理中，可繼續其他操作；請保持頁面開啟。'}</span>
        ${job.state==='error'&&canReceiveInventoryCapability()?`<button type="button" class="btn-small" onclick="retryReceiptTask(${inlineJsValue(job.supplyId)})">用原資料重試</button>`:''}
    </div>`).join('');
    document.querySelectorAll('button[data-receipt-supply]').forEach(button=>{
        const job=receiptTaskJobs.get(receiptTaskKey(button.dataset.receiptSupply));
        button.disabled=!!job||button.dataset.receiptConfirmed==='true';
        if(job)button.textContent=job.state==='error'?'到貨待確認':'到貨處理中…';
    });
}
function receiptTaskBlocksSupply(supplyId) {
    restoreReceiptTasks();
    const job=receiptTaskJobs.get(receiptTaskKey(supplyId));
    if(!job)return false;
    renderReceiptTasks();
    showActionFeedback(job.state==='error'?'這筆到貨結果待確認，請使用上方「用原資料重試」。':'這筆到貨正在背景處理，其他品項可繼續操作。','warning');
    return true;
}
window.retryReceiptTask = function(supplyId) {
    if(!canReceiveInventoryCapability())return;
    const job=receiptTaskJobs.get(receiptTaskKey(supplyId));
    if(!job||job.state!=='error')return;
    return runReceiptTask(job);
};
window.addEventListener('beforeunload',event=>{
    if([...receiptTaskJobs.values()].some(job=>job.state==='running')){
        event.preventDefault();event.returnValue='';
    }
});

async function refreshReceiptTaskViews(affectedOrderIds) {
    markMainPageDirty('inventory','orders.list','orders.po','admin');
    const refreshes=[];
    // 已開始的查詢可能早於這次到貨；等它結束後再讀最新資料，避免合併成過期的刷新。
    const pendingReads=[purchasingReceivingLoadPromise,activeReceivingSupplyLoadPromise].filter(Boolean);
    if(pendingReads.length)await Promise.allSettled(pendingReads);
    if(inventoryReceivingVisible&&document.getElementById('inventory-system')?.classList.contains('active'))refreshes.push(loadPurchasingReceivingQueue(true));
    else if(canAccessPage('inventory')&&document.getElementById('inventory-system')?.classList.contains('active'))refreshes.push(loadInventory(true));
    if(getDataScope('orders')!=='none')refreshes.push(refreshAffectedOrderCaches([...affectedOrderIds]));
    const results=await Promise.allSettled(refreshes);
    if(results.some(result=>result.status==='rejected'))showActionFeedback('到貨已完成；部分畫面同步失敗，重新進入該頁會再載入。','warning');
}

async function runReceiptTask(job) {
    if(job.state==='running'||job.ownerUid!==currentUser?.uid||(!canReceiveInventoryCapability()&&!['sales','engineer'].includes(currentUserRole)))return;
    job.state='running';job.error='';
    persistReceiptTasks(job.ownerUid);
    renderReceiptTasks();
    const affectedOrderIds=new Set();
    const supplyId=job.supplyId;
    try {
        for(const entry of job.entries){
            if(currentUser?.uid!==job.ownerUid||(!canReceiveInventoryCapability()&&!['sales','engineer'].includes(currentUserRole)))throw new Error('登入身份已變更，請以原帳號確認到貨結果。');
            const operationId=`${job.operationBase}-${entry.itemIndex}`;
            const ids=await receiveSupplyOrderRecord(supplyId,entry.qty,entry.lotNo,entry.expiryDate,operationId);
            ids.forEach(id=>affectedOrderIds.add(id));
        }
        // 核心資料已確認完成後才移除暫存。保留同一個 operationId 供網路中斷重試。
        clearReceiptOperationId(supplyId,job.operationBase,job.ownerUid);
        job.state='done';
        receiptTaskJobs.delete(receiptTaskKey(supplyId,job.ownerUid));
        persistReceiptTasks(job.ownerUid);
        if(currentUser?.uid!==job.ownerUid)return;
        // 暫時移除這筆舊到貨列；部分到貨餘額由後續查詢帶回，不用舊快取推算數量。
        supplyReceivingCache=supplyReceivingCache.filter(row=>row.id!==supplyId);
        pendingSupplyCache=pendingSupplyCache.filter(row=>row.id!==supplyId);
        document.querySelectorAll('button[data-receipt-supply]').forEach(button=>{
            if(button.dataset.receiptSupply===supplyId){button.dataset.receiptConfirmed='true';button.disabled=true;button.textContent='到貨已確認';}
        });
        renderReceiptTasks();
        showActionFeedback(`${job.label}：到貨已確認。`,'success');
        await refreshReceiptTaskViews(affectedOrderIds);
    } catch(err) {
        if(job.state==='done'){
            if(currentUser?.uid===job.ownerUid)showActionFeedback('到貨已確認；畫面同步失敗，重新進入該頁會再載入。','warning');
            return;
        }
        // 後續分配可能尚未完成；原收貨資料與識別碼必須保留，不能換成新的一筆。
        job.state='error';
        job.error=err?.code==='receipt-allocation-pending'&&err?.receiptCommitted
            ? '已入庫，庫存分配尚未完成。請用原資料重試。'
            : `結果待確認：${err.message||err}。請用原資料重試。`;
        persistReceiptTasks(job.ownerUid);
        if(currentUser?.uid===job.ownerUid)renderReceiptTasks();
    }
}

window.savePoReceiptBatch = async function() {
    const poId=poReceiptTargetId;
    if(!poId?.startsWith('supply:')){alert('到貨必須從供應紀錄進入，請重新開啟待到貨品項。');return;}
    const supplyId=poId.slice(7);
    if(receiptTaskBlocksSupply(supplyId))return;
    const rows=[...document.querySelectorAll('#poReceiptBatchBody tr')].filter(row=>row.querySelector('.po-receive-select')?.checked);
    const entries=rows.map(row=>({itemIndex:Number(row.dataset.index),qty:Number(row.querySelector('.po-receive-qty')?.value||0),
        lotNo:(row.querySelector('.po-receive-lot')?.value||'').trim(),expiryDate:row.querySelector('.po-receive-expiry')?.value||''}));
    if(!entries.length||entries.some((entry,index)=>!Number.isFinite(entry.qty)||entry.qty<=0||entry.qty>Number(rows[index].querySelector('.po-receive-qty')?.max)||!Number.isInteger(entry.itemIndex))){
        alert('請勾選到貨品項，數量須大於 0 且不可超過未收數量。');return;
    }
    const operationBase=poReceiptOperationId||ensureReceiptOperationId(supplyId);
    const supply=supplyReceivingCache.find(row=>row.id===supplyId)||pendingSupplyCache.find(row=>row.id===supplyId);
    if(!supply||!canConfirmSupplyReceipt(supply)){showActionFeedback('目前沒有這筆到貨確認權限，請重新開啟訂單。','warning');return;}
    const job={supplyId,operationBase,entries,ownerUid:currentUser.uid,label:supply?.itemCode||supply?.itemName||supplyId,state:'queued',error:''};
    receiptTaskJobs.set(receiptTaskKey(supplyId),job);
    persistReceiptTasks(job.ownerUid);
    // 關閉視窗前先保存獨立快照；後續開啟另一筆不會覆寫這筆的數量、批號或識別碼。
    closePoReceiptBatch();
    showActionFeedback('已開始背景確認到貨，可繼續其他操作；請保持頁面開啟。');
    return runReceiptTask(job);
};

