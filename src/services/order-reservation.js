function orderReservationSummary(order) {
    const items=normalizedOrderItems(order);
    return {
        reservedQty:items.reduce((sum,item)=>sum+Math.max(0,Number(item.reservedQty||0)),0),
        shortageQty:items.reduce((sum,item)=>sum+Math.max(0,Number(item.shortageQty||0)),0)
    };
}

function orderItemProcurementDemandDocument(order, item, currentDemand, now) {
    const dispatch=globalThis.YushinFulfillment.dispatchState(normalizedOrderItems(order).find(row=>row.itemId===item.itemId)||item);
    const demand=procurementDemandForOrderItem(order,item,dispatch);
    // A historical mismatch must be audited, not repaired by erasing supplier facts.
    if(currentDemand&&(Number(currentDemand.orderedQty||0)>demand.orderedQty||Number(currentDemand.receivedQty||0)>demand.receivedQty)){
        throw new Error('採購需求與訂單供應進度不一致，請先稽核供應紀錄後重試。');
    }
    return procurementDemandDocument(demand,{
        productId:item.productId||'',productKey:inventoryProductKey(item),
        itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
        fulfillmentType:item.fulfillmentType||order.fulfillmentType||'WAREHOUSE',
        warehouseId:(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'
            ? '' : (item.warehouseId||order.warehouseId||defaultWarehouse()?.id||''),
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',salesName:order.salesName||'',
        // Existing demand dates are independent of supplier ETA.
        scheduleDate:currentDemand?.scheduleDate||demand.scheduleDate||item.requiredByDate||item.scheduleDate||order.requiredByDate||order.expectedDate||''
    },{createdAt:currentDemand?.createdAt||order.createdAt||now,updatedAt:now});
}

async function persistOrderProcurementDemands(orderId, order, items = [], initialization = null) {
    const orderRef=db.collection('orders').doc(orderId);
    // The arguments carry identity only; live quantities and lifecycle always come from Firestore.
    const itemIds=items.map((item,index)=>String(item.itemId||`item-${index+1}`));
    for(const itemId of itemIds){
        const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
        const ref=procurementDemandRef(demandId);
        await runRoleTransaction(async tx=>{
            const orderSnap=await tx.get(orderRef);
            if(!orderSnap.exists)throw new Error('訂單已不存在，無法同步採購需求。');
            const liveOrder={id:orderId,...orderSnap.data()};
            // Only initialization transports supply this fence. Cancellation and
            // restoration retain their existing live-source demand projection.
            if(initialization){
                if(currentUser?.uid!==initialization.actorUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
                if(!initialization.syncAttemptId||liveOrder.inventoryReservationStatus!=='pending'
                    ||String(liveOrder.inventoryReservationAttemptId||'')!==initialization.syncAttemptId)
                    throw new Error('已有較新的庫存同步工作，請更新這筆訂單後確認結果。');
                if(normalizedOrderStatus(liveOrder)!=='normal')throw new Error('訂單已取消／作廢，停止後續同步。');
            }
            const currentSnap=await tx.get(ref);
            const current=currentSnap.exists?currentSnap.data():null;
            const item=normalizedOrderItems(liveOrder).find(row=>row.itemId===itemId);
            if(!item)throw new Error('訂單品項已變更，請重新讀取後重試同步。');
            const now=new Date().toISOString();
            if(normalizedOrderStatus(liveOrder)!=='normal'){
                if(current){
                    const cancelled=globalThis.YushinProcurementDemand.cancelDemand(current);
                    tx.set(ref,procurementDemandDocument({...current,...cancelled},{},{createdAt:current.createdAt||now,updatedAt:now}),{merge:true});
                }
                return;
            }
            const doc=orderItemProcurementDemandDocument(liveOrder,item,current,now);
            // Do not create empty demands, but clear an existing demand when stock covers it.
            if(current||doc.requestedQty>0||doc.orderedQty>0||doc.receivedQty>0)tx.set(ref,doc,{merge:true});
        });
    }
    invalidateProcurementDemandQueue();
}

async function syncOrderProcurementDemandLifecycle(orderId, order, lifecycleStatus) {
    // Cancellation and restoration use the same live-source projection, not competing batch formulas.
    await persistOrderProcurementDemands(orderId,order,normalizedOrderItems(order));
}

async function reserveInventoryForNewOrder(orderId, order, actorUid = currentUser?.uid) {
    const orderRef=db.collection('orders').doc(orderId);
    const snapshot=await firestoreReadWithTimeout(orderRef.get(),'讀取待同步訂單');
    if(!snapshot.exists)throw new Error('訂單已不存在，無法同步庫存。');
    const liveOrder={id:orderId,...snapshot.data()};
    const expectedAttemptId=String(order.inventoryReservationAttemptId||'');
    if(expectedAttemptId&&liveOrder.inventoryReservationStatus!=='completed'
        &&(liveOrder.inventoryReservationStatus!=='pending'||String(liveOrder.inventoryReservationAttemptId||'')!==expectedAttemptId))
        throw new Error('已有較新的庫存同步工作，請更新這筆訂單後確認結果。');
    if(!normalizedOrderItems(liveOrder).length)
        throw new Error('訂單缺少正式 items 品項資料，請重新建立訂單。');

    // The authenticated whole-order Callable is the ONLY initial reservation
    // writer. A disabled gate or ambiguous response must never use browser SDK
    // stock/demand transactions, including in Preview and older clients.
    if(typeof orderReservationBackendEnabled!=='function'||!orderReservationBackendEnabled())
        throw new Error('新訂單預留後端尚未啟用，舊版逐筆 SDK 寫入已停用；請保留原操作編號並聯絡管理員。');
    const committed=await commitNewOrderReservationPreview(orderId,liveOrder,actorUid);
    if(committed!==true)
        throw new Error('後端預留旗標可能已變更，尚無提交確認；請保留原同步識別碼核對，禁止回退舊交易。');

    const latest=await firestoreReadWithTimeout(orderRef.get(),'讀取後端庫存同步結果');
    if(!latest.exists||currentUser?.uid!==actorUid)
        throw new Error('訂單已變更，請更新後確認同步結果。');
    if(String(latest.data().inventoryReservationAttemptId||'')!==String(liveOrder.inventoryReservationAttemptId||''))
        throw new Error('後端預留已回覆，但訂單已有較新的同步識別碼；請以原憑證核對，不得繼續舊操作。');
    if(latest.data().inventoryReservationStatus!=='completed')
        throw new Error('後端尚未確認整單預留完成；請保留原同步識別碼核對，不得自行補寫庫存。');
    Object.assign(order,{id:orderId,...latest.data()});
    if(normalizedOrderStatus(order)!=='normal')throw new Error('訂單已取消／作廢，停止後續自行訂貨。');
    for(const row of normalizedOrderItems(order)){
        if((row.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
            ||String(row.productType||'').toUpperCase()==='SERVICE')continue;
        const key=inventoryProductKey(row),warehouseId=row.warehouseId||order.warehouseId;
        if(key&&warehouseId)invalidateWarehouseStockCache(key,warehouseId);
    }
    await registerInitialSelfOrders(orderId,order,actorUid);
    return {...orderReservationSummary(order),items:order.items};
}

