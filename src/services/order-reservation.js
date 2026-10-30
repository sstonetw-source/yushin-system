async function reserveSingleOrderItem(orderId, order, item, itemIndex, actorUid = currentUser?.uid) {
    const itemId=String(item.itemId||`item-${itemIndex+1}`);
    if(!globalThis.YushinReservation?.planReservation){
        throw new Error('Reservation core 未載入，無法計算庫存預留。');
    }
    const orderRef=db.collection('orders').doc(orderId);
    const syncUid=actorUid;
    const syncAttemptId=String(order.inventoryReservationAttemptId||'');
    const actor=currentUserName||currentUser?.email||'';
    let result,stockToInvalidate=null;
    let releasedStock=null;

    await runRoleTransaction(async tx=>{
        result=undefined;stockToInvalidate=null;releasedStock=null;
        // Read the current source in every retry. Never publish a caller's full-item snapshot.
        const orderSnap=await tx.get(orderRef);
        if(currentUser?.uid!==syncUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
        if(!orderSnap.exists)throw new Error('訂單已不存在，無法同步庫存。');
        order={id:orderId,...orderSnap.data()};
        if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消／作廢的訂單不可同步庫存。');
        itemIndex=(order.items||[]).findIndex((row,index)=>String(row.itemId||`item-${index+1}`)===itemId);
        if(itemIndex<0)throw new Error('訂單品項已變更，請重新讀取後重試同步。');
        item={...order.items[itemIndex],itemId};
        if(order.inventoryReservationStatus==='completed'){result=item;return;}
        if(syncAttemptId&&(order.inventoryReservationStatus!=='pending'||String(order.inventoryReservationAttemptId||'')!==syncAttemptId))
            throw new Error('已有較新的庫存同步工作，請更新這筆訂單後確認結果。');
        if(item.transferPendingId)throw new Error('調撥途中不可重新配置訂單庫存。');
        const normalized=normalizedOrderItems(order)[itemIndex];
        const orderedQty=Math.max(0,Number(normalized.qty||0));
        const effectiveDelivered=Math.max(0,Number(normalized.deliveredQty||0)-Number(normalized.returnedQty||0));
        const requested=Math.max(0,orderedQty-effectiveDelivered);
        const productKey=inventoryProductKey(item);
        let warehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';
        const now=new Date().toISOString();
        const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
        const demandRef=procurementDemandRef(demandId);
        const demandSnap=await tx.get(demandRef);
        const currentDemand=demandSnap.exists?demandSnap.data():null;
        const publish=nextItem=>{
            if(currentUser?.uid!==syncUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
            result=nextItem;
            const items=order.items.map((row,index)=>index===itemIndex?nextItem:row);
            const nextOrder={...order,items};
            const updates={items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now};
            const demandDoc=orderItemProcurementDemandDocument(nextOrder,nextItem,currentDemand,now);
            if(currentDemand||demandDoc.requestedQty>0||demandDoc.orderedQty>0||demandDoc.receivedQty>0)tx.set(demandRef,demandDoc,{merge:true});
            tx.update(orderRef,updates);
        };
        // Service master data is not physical stock. Verify it against the live
        // product document before skipping warehouse reservation and procurement.
        // An old physical/supplier commitment must be audited, not erased.
        if(String(item.productType||'').trim().toUpperCase()==='SERVICE'){
            const productId=String(item.productId||'').trim();
            if(!productId||productId.includes('/'))throw new Error('服務型品項缺少有效產品主檔。');
            if((item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE')
                throw new Error('服務型品項尚不支援原廠直送或實貨履約入口。');
            const [productSnap,reservationSnap]=await Promise.all([
                tx.get(db.collection('products').doc(productId)),
                tx.get(db.collection('inventoryReservations').doc(`${orderId}__${itemId}`))
            ]);
            if(!productSnap.exists||productSnap.data().active===false
                ||String(productSnap.data().productType||productSnap.data().type||'').trim().toUpperCase()!=='SERVICE')
                throw new Error('服務型品項與啟用的產品主檔不符，不能建立虛擬實貨。');
            const hasProgress=[reservationSnap.exists?reservationSnap.data().quantity:0,
                item.reservedQty,item.dispatchPreparedQty,item.warehouseShippedQty,
                item.supplyOrderedQty,item.receivedQty,currentDemand?.orderedQty,currentDemand?.receivedQty]
                .some(value=>value!==undefined&&value!==null&&Number(value)!==0);
            if(hasProgress)throw new Error('服務型品項已有實貨預留或供應進度，請先稽核，不能自動抹除。');
            publish({...item,orderedQty,reservedQty:0,shortageQty:0,
                inventoryProductKey:'',warehouseId:'',reservationStatus:'not_required'});
            return;
        }
        // Verify the inverse case, too: a Service product must not be disguised
        // as Goods and accidentally allocated company stock. Only live master
        // data, re-read inside the transaction, can determine this boundary.
        if(item.productId){
            const productId=String(item.productId).trim();
            if(!productId||productId.includes('/'))throw new Error('產品主檔識別碼不正確。');
            const productSnap=await tx.get(db.collection('products').doc(productId));
            if(productSnap.exists&&String(productSnap.data().productType||productSnap.data().type||'').trim().toUpperCase()==='SERVICE')
                throw new Error('產品主檔為服務型，訂單品項不可冒充商品預留實貨；請修正產品類型後重試。');
        }
        if(!productKey){publish({...item,orderedQty,reservedQty:0,shortageQty:requested,inventoryProductKey:'',reservationError:'missing_product_master'});return;}
        if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'){
            publish({...item,orderedQty,reservedQty:0,shortageQty:0,inventoryProductKey:productKey,warehouseId:'',reservationStatus:'not_required'});return;
        }
        if(!warehouseId)throw new Error('找不到有效倉庫，無法安全配置庫存。');
        const aggregateRef=inventoryRefFor(item);
        const reservationRef=db.collection('inventoryReservations').doc(`${orderId}__${itemId}`);
        const aggregateSnap=aggregateRef?await tx.get(aggregateRef):null;
        const reservationSnap=await tx.get(reservationRef);
        const aggregate=inventoryNumbers(aggregateSnap?.exists?aggregateSnap.data():{});
        const existing=reservationSnap.exists?reservationSnap.data():{};
        const canChoose=globalThis.YushinReservation.reservationLocationCanChange({...item,
            deliveredQty:Math.max(Number(item.deliveredQty||0),Number(normalized.deliveredQty||0)),
            returnedQty:Math.max(Number(item.returnedQty||0),Number(normalized.returnedQty||0))},existing,currentDemand||{});
        const candidateIds=[...new Set([warehouseId,...(canChoose?warehouseMasterCache
            .filter(w=>w.active!==false&&!w.systemCustody&&!String(w.id).startsWith('custody-')).map(w=>w.id):[])])].filter(Boolean);
        const warehouseContexts=await Promise.all(candidateIds.map(async id=>{
            const ref=db.collection('warehouseStocks').doc(warehouseStockDocId(id,productKey));
            const [master,snapshot]=await Promise.all([tx.get(db.collection('warehouses').doc(id)),tx.get(ref)]);
            return {id,ref,snapshot,master:master.exists?{...master.data(),id}:null};
        }));
        if(canChoose){
          const eligibleLocations=warehouseContexts.filter(row=>row.master&&globalThis.YushinReservation.physicalWarehouse(row.master));
          const availableAtEligibleLocations=eligibleLocations
              .reduce((sum,row)=>sum+inventoryNumbers(row.snapshot.exists?row.snapshot.data():{}).available,0);
          if(eligibleLocations.length&&aggregateSnap?.exists&&aggregate.available>availableAtEligibleLocations+1e-8)
              throw new Error('公司可用庫存與啟用分倉可用量不一致，請先核對分倉庫存或停用倉庫，避免誤列待採購。');
          const selection=globalThis.YushinReservation.selectSingleWarehouse({
            warehouses:warehouseContexts.map(row=>row.master).filter(Boolean),
            stocks:Object.fromEntries(warehouseContexts.map(row=>[row.id,row.snapshot.exists?row.snapshot.data():{}])),
            currentWarehouseId:warehouseId,requestedQty:requested,aggregateAvailableQty:aggregateSnap?.exists?aggregate.available:0
          });
          if(selection.requiresMultipleLocations){
            // Read-only diagnostic from the existing reservation Core. This plan is
            // not a reservation ledger and must not mutate stock or demand.
            const preview=globalThis.YushinReservation.planMultiWarehouseReservation({
              warehouses:eligibleLocations.map(row=>row.master),
              stocks:Object.fromEntries(eligibleLocations.map(row=>[row.id,row.snapshot.exists?row.snapshot.data():{}])),
              currentWarehouseId:warehouseId,requestedQty:requested,
              aggregateStock:aggregateSnap?.exists?aggregateSnap.data():{onHand:0,reserved:0}
            });
            const names=new Map(eligibleLocations.map(row=>[row.id,row.master.warehouseName||row.id]));
            const detail=preview.allocations.map(row=>String(names.get(row.warehouseId)||row.warehouseId)+' '+row.qty).join('、');
            throw new Error('此品項需要多倉分配：需求 '+requested+'、目前各倉可配置 '+preview.allocatedQty
              +(detail?'（'+detail+'）':'')+'、仍缺 '+preview.shortageQty
              +'。現行系統尚未啟用同一品項的多倉預留及分批出貨；請先核對並完成實體倉庫調撥後重試，未變更任何預留或採購需求。');
          }
          warehouseId=selection.warehouseId;
        }
        const selected=warehouseContexts.find(row=>row.id===warehouseId);
        if(!selected?.master||!globalThis.YushinReservation.physicalWarehouse(selected.master))throw new Error('找不到啟用的庫存倉庫，請先確認倉庫主檔後重試。');
        const warehouseRef=selected.ref,warehouseSnap=selected.snapshot;
        const warehouse=inventoryNumbers(warehouseSnap.exists?warehouseSnap.data():{});
        const existingQty=existing.quantity===undefined?0:existing.quantity;
        const oldProductKey=String(existing.productKey||'');
        const oldWarehouseId=String(existing.warehouseId||'');
        const sameStock=oldProductKey===productKey&&oldWarehouseId===warehouseId;
        if(existingQty>0&&sameStock&&(!aggregateSnap?.exists||!warehouseSnap?.exists)){
            throw new Error('既有預留缺少對應公司或分倉庫存，請先稽核後重試。');
        }

        const plan=globalThis.YushinReservation.planReservation({
            requestedQty:requested,
            existingQty,
            sameStock,
            availableQty:aggregateSnap?.exists?Math.min(warehouse.available,aggregate.available+(oldProductKey===productKey&&!sameStock?existingQty:0)):0,
            inTransitQty:Math.max(0,Number(item.supplyOrderedQty||0)-Number(item.receivedQty||0))
        });

        let oldAggregateRef=null,oldAggregateSnap=null,oldAggregate=null;
        let oldWarehouseRef=null,oldWarehouseSnap=null,oldWarehouse=null;
        if(plan.releaseQty>0&&!sameStock){
            if(!oldProductKey||!oldWarehouseId){
                throw new Error('舊庫存預留缺少產品或倉庫資訊，無法安全重新分配。');
            }
            oldAggregateRef=oldProductKey===productKey
                ? aggregateRef
                : db.collection('inventory').doc(encodeURIComponent(oldProductKey));
            oldWarehouseRef=db.collection('warehouseStocks').doc(warehouseStockDocId(oldWarehouseId,oldProductKey));
            oldAggregateSnap=oldProductKey===productKey
                ? aggregateSnap
                : await tx.get(oldAggregateRef);
            oldWarehouseSnap=await tx.get(oldWarehouseRef);
            if(!oldWarehouseSnap?.exists){
                throw new Error('找不到舊庫存預留所在倉庫，無法安全重新分配。');
            }
            oldAggregate=inventoryNumbers(oldAggregateSnap?.exists?oldAggregateSnap.data():{});
            oldWarehouse=inventoryNumbers(oldWarehouseSnap.data());
        }

        // Share the lifecycle balance contract; raw snapshots must be checked
        // before any clamping or release can hide a corrupt reservation account.
        if(!sameStock)globalThis.YushinReservation.validateReservationBalance({
            existingQty:0,
            aggregateStock:aggregateSnap?.exists?aggregateSnap.data():undefined,
            warehouseStock:warehouseSnap.exists?warehouseSnap.data():undefined
        });
        globalThis.YushinReservation.validateReservationBalance({
            existingQty,itemReservedQty:Object.hasOwn(item,'reservedQty')?item.reservedQty:existingQty,
            aggregateStock:sameStock?(aggregateSnap?.exists?aggregateSnap.data():undefined):oldAggregateSnap?.data(),
            warehouseStock:sameStock?(warehouseSnap.exists?warehouseSnap.data():undefined):oldWarehouseSnap?.data()
        });

        if(aggregateRef&&aggregateSnap?.exists){
            let nextReserved=aggregate.reserved;
            if(plan.releaseQty>0&&oldProductKey===productKey)nextReserved=nextReserved-plan.releaseQty;
            nextReserved+=plan.additionalReserveQty;
            if(nextReserved!==aggregate.reserved)tx.update(aggregateRef,{reserved:nextReserved,updatedAt:now});
        }
        if(plan.releaseQty>0&&oldProductKey&&oldProductKey!==productKey&&oldAggregateRef&&oldAggregateSnap?.exists){
            tx.update(oldAggregateRef,{reserved:oldAggregate.reserved-plan.releaseQty,updatedAt:now});
        }

        if(warehouseRef&&warehouseSnap?.exists){
            let nextReserved=warehouse.reserved;
            if(plan.releaseQty>0&&sameStock)nextReserved=nextReserved-plan.releaseQty;
            nextReserved+=plan.additionalReserveQty;
            if(nextReserved!==warehouse.reserved)tx.update(warehouseRef,{reserved:nextReserved,updatedAt:now});
        }
        if(plan.releaseQty>0&&!sameStock&&oldWarehouseRef&&oldWarehouseSnap?.exists){
            tx.update(oldWarehouseRef,{reserved:oldWarehouse.reserved-plan.releaseQty,updatedAt:now});
            releasedStock={productKey:oldProductKey,warehouseId:oldWarehouseId};
        }

        if(plan.releaseQty>0){
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(
                'release',-plan.releaseQty,orderId,oldProductKey||productKey,actor,
                {
                    reason:'reservation_reconcile',warehouseId:oldWarehouseId||warehouseId,itemId,
                    fulfillmentType:'WAREHOUSE',ownerUid:order.ownerUid||currentUser?.uid||'',
                    salesCode:order.salesCode||salesCodeForName(order.salesName)||''
                }
            ));
        }
        if(plan.additionalReserveQty>0){
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(
                'reserve',plan.additionalReserveQty,orderId,productKey,actor,
                {
                    warehouseId,itemId,fulfillmentType:'WAREHOUSE',
                    ownerUid:order.ownerUid||currentUser?.uid||'',
                    salesCode:order.salesCode||salesCodeForName(order.salesName)||''
                }
            ));
        }

        tx.set(reservationRef,{
            orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
            itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
            ownerUid:order.ownerUid||currentUser?.uid||'',
            salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
            orderDate:order.orderDate||'',quantity:plan.reservedQty,shortageQty:plan.shortageQty,
            status:plan.status,warehouseId,updatedAt:now
        },{merge:true});

        publish({...item,itemId,orderedQty,reservedQty:plan.reservedQty,shortageQty:plan.shortageQty,inventoryProductKey:productKey,warehouseId});
        stockToInvalidate={productKey,warehouseId};
    });

    if(releasedStock)invalidateWarehouseStockCache(releasedStock.productKey,releasedStock.warehouseId);
    if(stockToInvalidate)invalidateWarehouseStockCache(stockToInvalidate.productKey,stockToInvalidate.warehouseId);
    invalidateProcurementDemandQueue();
    return result;
}
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
    const items=normalizedOrderItems(liveOrder);
    if(!items.length)throw new Error('訂單缺少正式 items 品項資料，請重新建立訂單。');
    // Explicit Preview pilot: the Admin SDK writer owns the entire initial
    // stock/reservation/demand transaction. Never fall back to the legacy
    // per-item Firestore SDK writer if a response is lost or an error occurs.
    if(typeof orderReservationBackendPreviewEnabled==='function'
        &&orderReservationBackendPreviewEnabled()){
        await commitNewOrderReservationPreview(orderId,liveOrder,actorUid);
        const latest=await firestoreReadWithTimeout(orderRef.get(),'讀取後端庫存同步結果');
        if(!latest.exists||currentUser?.uid!==actorUid)
            throw new Error('訂單已變更，請更新後確認同步結果。');
        if(String(latest.data().inventoryReservationAttemptId||'')!==String(liveOrder.inventoryReservationAttemptId||''))
            throw new Error('後端預留已回覆，但訂單已有較新的同步識別碼；請以原憑證核對，不得繼續舊操作。');
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
    if(items.some(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'
        &&String(item.productType||'').trim().toUpperCase()!=='SERVICE')){
        await loadWarehouseMaster(true);
        if(!warehouseMasterLoadPromise)throw new Error('倉庫主檔讀取失敗，請重試同步。');
    }
    if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
    // Preview-only grouped initial reservation; all existing per-item demand
    // reconciliation still runs using fresh snapshots and original checkpoints.
    // Historical isolated Service tests do not load the optional adapter.
    // In the real built app it is defined immediately before this Service.
    if(typeof commitInitialGroupedReservationPreview==='function')
        await commitInitialGroupedReservationPreview(orderId,liveOrder,actorUid);
    for(let i=0;i<items.length;i++)await reserveSingleOrderItem(orderId,liveOrder,items[i],i,actorUid);
    // Each item transaction has already published stock, reservation, order and demand atomically.
    // Read the result for self-order processing and UI; never overwrite the source with reservedItems.
    const latest=await firestoreReadWithTimeout(orderRef.get(),'讀取庫存同步結果');
    if(!latest.exists)throw new Error('訂單已不存在。');
    if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
    Object.assign(order,{id:orderId,...latest.data()});
    if(normalizedOrderStatus(order)!=='normal')throw new Error('訂單已取消／作廢，停止後續自行訂貨。');
    await registerInitialSelfOrders(orderId,order,actorUid);
    return {...orderReservationSummary(order),items:order.items};
}

