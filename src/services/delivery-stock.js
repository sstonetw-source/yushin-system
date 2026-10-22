async function applyInventoryDeliveryDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, reversalRecords) {
    // Customer service is not company-owned stock, including parts bought for the job.
    if(String(order.productType||order.type||'').trim().toUpperCase()==='SERVICE')throw new Error('服務型品項不得走一般商品出貨或庫存還原；請先完成服務作業流程。');
    if(order.transferPendingId)throw new Error('此品項尚在倉庫調撥途中，請目的倉先確認收貨。');
    const deliveryPlan=globalThis.YushinWarehouseLogistics?.plan(order.deliveryPlan||order.shippingInstructions||{});
    if(deltaQty>0&&(order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'&&deliveryPlan?.mode==='PICKUP'&&order.warehouseId&&order.warehouseId!==defaultWarehouse()?.id&&!String(order.warehouseId).startsWith('custody-'))throw new Error('主倉自領品項仍在分倉，請先完成調回主倉與收貨。');
    if(deltaQty>0&&globalThis.YushinWarehouseLogistics?.businessDeliveryState&&typeof canReceiveInventoryCapability==='function'&&!canReceiveInventoryCapability()){
        const state=globalThis.YushinWarehouseLogistics.businessDeliveryState(order,order,{shippable:deltaQty},defaultWarehouse()?.id||'');
        if(!state.shippable)throw new Error(state.deliveryWait+'，目前不能登錄已送貨。');
    }
    if (!deltaQty || (order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return { reservedDelta:0,newReservedQty:Math.max(0,Number(order.reservedQty||0)),lotAllocations:[],cogs:0 };
    const productKey = inventoryProductKey(order);
    const warehouseId = order.warehouseId || defaultWarehouse()?.id || '';
    const invRef = inventoryRefFor(order);
    const whRef = warehouseId ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)) : null;
    if (!invRef || !whRef) throw new Error('此訂單尚未指定有效倉庫，無法進行庫存出貨。');

    const deliveryItemId=String(order.itemId||'').trim();
    if(!deliveryItemId) throw new Error('出貨品項缺少 itemId，無法安全對應庫存預留紀錄。');
    const deliveryReservationRef=db.collection('inventoryReservations').doc(`${sourceId}__${deliveryItemId}`);
    const invSnap = await transaction.get(invRef);
    const whSnap = await transaction.get(whRef);
    const reservationSnap = await transaction.get(deliveryReservationRef);
    if (!whSnap.exists) throw new Error('指定倉庫沒有這個產品的分倉庫存，請先入庫或以庫存調整建立分倉數量。');

    const inv = inventoryNumbers(invSnap.exists ? invSnap.data() : {}), wh = inventoryNumbers(whSnap.data());
    const stockPlan=deltaQty>0?globalThis.YushinReservation.planReservationIssue({
        productKey,warehouseId,qty:deltaQty,reservation:reservationSnap.exists?reservationSnap.data():{},
        aggregateStock:invSnap.exists?invSnap.data():undefined,warehouseStock:whSnap.data(),
        requireReservation:order.requireStockReservation===true,itemReservedQty:order.reservedQty
    }):globalThis.YushinReservation.planReservationReturn({operation:'SHIP_REVERSAL',deltaQty:-deltaQty,
        orderStatus:normalizedOrderStatus(order),productKey,warehouseId,reservation:reservationSnap.exists?reservationSnap.data():{},
        aggregateStock:invSnap.exists?invSnap.data():undefined,warehouseStock:whSnap.data(),itemReservedQty:order.reservedQty
    });
    const newReservedRemaining=stockPlan.reservation.quantity;
    const reservedDelta=stockPlan.reservedDelta;
    const now = new Date().toISOString();
    let lotAllocations=[],cogs=0;

    if (deltaQty > 0) {
        // Web Firestore transactions accept document references, not queries.
        // Discover IDs, then re-read every candidate in the transaction so concurrent
        // delivery/receipt changes force a retry before any stock is written.
        const lotQuery=await db.collection('inventoryLots').where('productKey','==',productKey).where('warehouseId','==',warehouseId).where('remainingQty','>',0).get();
        const lotSnapshots=await Promise.all(lotQuery.docs.map(doc=>transaction.get(doc.ref)));
        const lotDocs=lotSnapshots.filter(doc=>doc.exists).map(doc=>({id:doc.id,...doc.data()}))
            .filter(l=>l.productKey===productKey&&l.warehouseId===warehouseId&&Number(l.remainingQty||0)>0);
        if(!lotDocs.length)throw new Error('此庫存尚未建立批次成本資料，請先完成入庫／期初庫存批次建檔後再送貨。');
        const allocation=globalThis.YushinInventory.allocateLots(lotDocs.map(lot=>({...lot,unitCost:0})),deltaQty);
        lotAllocations=allocation.allocations;cogs=allocation.totalCost;
        lotAllocations.forEach(row=>{
            const lot=lotDocs.find(x=>x.id===row.lotId);
            transaction.update(db.collection('inventoryLots').doc(row.lotId),{remainingQty:Number(lot.remainingQty||0)-row.qty,updatedAt:now});
        });
    } else {
        const restoreQty=Math.abs(deltaQty);
        const sourceRecords=Array.isArray(reversalRecords)&&reversalRecords.length?reversalRecords:savedDeliveryRecords(order);
        const reversal=globalThis.YushinInventory.reverseLotAllocations(sourceRecords,restoreQty);
        lotAllocations=reversal.allocations.map(row=>({...row,qty:-row.qty,cost:-row.cost}));
        const lotIds=[...new Set(reversal.allocations.map(row=>row.lotId))];
        const lotContexts=await Promise.all(lotIds.map(async lotId=>{
            const lotRef=db.collection('inventoryLots').doc(lotId);
            return {lotId,lotRef,lotSnap:await transaction.get(lotRef)};
        }));
        const restored=globalThis.YushinInventory.planLotRestoration({productKey,warehouseId,
            allocations:reversal.allocations,lots:lotContexts.filter(row=>row.lotSnap.exists)
                .map(row=>({...row.lotSnap.data(),id:row.lotId}))});
        for(const row of restored)transaction.update(db.collection('inventoryLots').doc(row.lotId),{remainingQty:row.remainingQty,updatedAt:now});
        cogs=-reversal.totalCost;
    }

    if (invSnap.exists) transaction.set(invRef,{onHand:stockPlan.aggregateStock.onHand,reserved:stockPlan.aggregateStock.reserved,incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:stockPlan.warehouseStock.onHand,reserved:stockPlan.warehouseStock.reserved,incoming:wh.incoming,updatedAt:now},{merge:true});
    const movementRef=db.collection('inventoryMovements').doc();
    transaction.set(movementRef,inventoryMovementRecord(deltaQty>0?'ship':'ship_reversal',-deltaQty,sourceId,productKey,actor,{
        warehouseId,itemId:deliveryItemId,fulfillmentType:'WAREHOUSE',reservedDelta,lotAllocations,costPending:true,
        warehouseStockId:whRef.id,inventoryDocId:invRef.id,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    }));

    transaction.set(deliveryReservationRef,{...stockPlan.reservation,...inventoryReservationPayload(sourceId,order,newReservedRemaining,stockPlan.reservation.status),itemId:deliveryItemId,warehouseId},{merge:true});
    return { reservedDelta,newReservedQty:newReservedRemaining,lotAllocations,cogs,movementId:movementRef.id };
}
function applyInventoryDeliveryInTransaction(transaction, orderRef, order, deliveryQty, actor, sourceId) {
    return applyInventoryDeliveryDeltaInTransaction(transaction, order, deliveryQty, actor, sourceId);
}

async function applyInventoryReturnDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, previousReturnRecord) {
    if(String(order.productType||order.type||'').trim().toUpperCase()==='SERVICE')throw new Error('服務型品項不得走一般商品退貨入庫；客戶器材與檢體不是公司庫存。');
    if (!deltaQty || (order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return {lotAllocations:[],cogs:0};
    const productKey = inventoryProductKey(order);
    const warehouseId = order.warehouseId || defaultWarehouse()?.id || '';
    const invRef = inventoryRefFor(order);
    const whRef = warehouseId ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)) : null;
    if (!invRef || !whRef) throw new Error('此訂單沒有可追蹤的出貨倉庫。');
    const deliveryItemId=String(order.itemId||'').trim();
    if(!deliveryItemId) throw new Error('退貨品項缺少 itemId，無法安全對應庫存預留紀錄。');
    const reservationRef=db.collection('inventoryReservations').doc(`${sourceId}__${deliveryItemId}`);
    const invSnap = await transaction.get(invRef);
    const whSnap = await transaction.get(whRef);
    const reservationSnap = await transaction.get(reservationRef);
    if (!whSnap.exists) throw new Error('找不到原出貨倉庫庫存。');
    const inv=inventoryNumbers(invSnap.exists?invSnap.data():{}), wh=inventoryNumbers(whSnap.data());
    const stockPlan=globalThis.YushinReservation.planReservationReturn({operation:'CUSTOMER_RETURN',deltaQty,
        orderStatus:normalizedOrderStatus(order),settlement:order.customerReturnSettlement||'REPLACE',
        productKey,warehouseId,reservation:reservationSnap.exists?reservationSnap.data():{},
        aggregateStock:invSnap.exists?invSnap.data():undefined,warehouseStock:whSnap.data(),itemReservedQty:order.reservedQty
    });
    const now=new Date().toISOString();
    let lotAllocations=[],cogs=0;
    let selectedAllocations;
    if(deltaQty>0){
        // Editing a return increases only the new delta; its original lots are already returned.
        const priorReturns = savedReturnRecords(order).filter(record => !previousReturnRecord || record.id !== previousReturnRecord.id);
        if (previousReturnRecord) priorReturns.push(previousReturnRecord);
        const available=globalThis.YushinInventory.availableReturnAllocations(savedDeliveryRecords(order),priorReturns);
        const plan=globalThis.YushinInventory.reverseLotAllocations([{qty:available.reduce((sum,row)=>sum+Number(row.qty||0),0),lotAllocations:available}],deltaQty);
        selectedAllocations=plan.allocations;lotAllocations=plan.allocations;cogs=plan.totalCost;
    }else{
        const plan=globalThis.YushinInventory.reverseLotAllocations(previousReturnRecord?[previousReturnRecord]:[],Math.abs(deltaQty));
        selectedAllocations=plan.allocations;
        lotAllocations=plan.allocations.map(row=>({...row,qty:-row.qty,cost:-row.cost}));cogs=-plan.totalCost;
    }
    const lotIds=[...new Set(selectedAllocations.map(row=>row.lotId))];
    const lotContexts=await Promise.all(lotIds.map(async lotId=>{
        const lotRef=db.collection('inventoryLots').doc(lotId);
        return {lotId,lotRef,lotSnap:await transaction.get(lotRef)};
    }));
    const restored=globalThis.YushinInventory.planLotRestoration({productKey,warehouseId,
        allocations:selectedAllocations,direction:deltaQty>0?1:-1,
        lots:lotContexts.filter(row=>row.lotSnap.exists).map(row=>({...row.lotSnap.data(),id:row.lotId}))});
    for(const row of restored)transaction.update(db.collection('inventoryLots').doc(row.lotId),{remainingQty:row.remainingQty,updatedAt:now});
    const nextReservation=stockPlan.reservation.quantity,reservationDelta=stockPlan.reservedDelta;
    transaction.set(invRef,{onHand:stockPlan.aggregateStock.onHand,reserved:stockPlan.aggregateStock.reserved,incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:stockPlan.warehouseStock.onHand,reserved:stockPlan.warehouseStock.reserved,incoming:wh.incoming,updatedAt:now},{merge:true});
    transaction.set(reservationRef,{...stockPlan.reservation,...inventoryReservationPayload(sourceId,order,nextReservation,stockPlan.reservation.status),itemId:deliveryItemId,warehouseId},{merge:true});
    transaction.set(db.collection('inventoryMovements').doc(),{
        type:deltaQty>0?'return_in':'return_reversal',qty:deltaQty,productKey,warehouseId,
        fulfillmentType:'WAREHOUSE',sourceType:DOCUMENT_TYPES.ORDER,sourceId,
        createdAt:now,createdBy:actor,lotAllocations,costPending:true,reservationDelta,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    });
    return {lotAllocations,cogs,reservationDelta,newReservedQty:nextReservation};
}

