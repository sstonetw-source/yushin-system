async function applyInventoryDeliveryDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, reversalRecords) {
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
    const currentReservation=globalThis.YushinReservation.assertLegacyReservationLocation(
        reservationSnap.exists?reservationSnap.data():{}, {warehouseId,productKey});
    const newReservedRemaining=Math.max(0,currentReservation-deltaQty);
    const reservedDelta=newReservedRemaining-currentReservation;
    const now = new Date().toISOString();
    let lotAllocations=[],cogs=0;

    if (deltaQty > 0) {
        if (order.requireStockReservation === true && (!invSnap.exists || inv.onHand < deltaQty || inv.reserved < deltaQty || wh.reserved < deltaQty || currentReservation < deltaQty)) throw new Error('庫存或訂單預留數量不足，請先確認庫存資料後再出貨。');
        if (wh.onHand < deltaQty) throw new Error(`庫存不足：${warehouseMasterCache.find(w=>w.id===warehouseId)?.warehouseName || warehouseId} 現有 ${wh.onHand}，本次需出貨 ${deltaQty}。`);
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
        // Several delivery records (or an increased record) can refer to one lot.
        // Read/update that document once with the total reversal, not last-write-wins.
        const restoreByLot=new Map();
        for(const row of reversal.allocations)restoreByLot.set(row.lotId,(restoreByLot.get(row.lotId)||0)+row.qty);
        const lotContexts=await Promise.all([...restoreByLot].map(async([lotId,qty])=>{
            const lotRef=db.collection('inventoryLots').doc(lotId);
            return {row:{lotId,qty},lotRef,lotSnap:await transaction.get(lotRef)};
        }));
        for(const {row,lotRef,lotSnap} of lotContexts){
            if(!lotSnap.exists)throw new Error(`找不到原出貨批次 ${row.lotNo||row.lotId}，無法安全還原庫存。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)+row.qty,updatedAt:now});
        }
        cogs=-reversal.totalCost;
    }

    if (invSnap.exists) transaction.set(invRef,{onHand:Math.max(0,inv.onHand-deltaQty),reserved:Math.max(0,inv.reserved+reservedDelta),incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:wh.onHand-deltaQty,reserved:Math.max(0,wh.reserved+reservedDelta),incoming:wh.incoming,updatedAt:now},{merge:true});
    const movementRef=db.collection('inventoryMovements').doc();
    transaction.set(movementRef,inventoryMovementRecord(deltaQty>0?'ship':'ship_reversal',-deltaQty,sourceId,productKey,actor,{
        warehouseId,itemId:deliveryItemId,fulfillmentType:'WAREHOUSE',reservedDelta,lotAllocations,costPending:true,
        warehouseStockId:whRef.id,inventoryDocId:invRef.id,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    }));

    transaction.set(deliveryReservationRef,{...inventoryReservationPayload(sourceId,order,newReservedRemaining,newReservedRemaining>0?'active':'fulfilled'),itemId:deliveryItemId,warehouseId},{merge:true});
    return { reservedDelta,newReservedQty:newReservedRemaining,lotAllocations,cogs,movementId:movementRef.id };
}
function applyInventoryDeliveryInTransaction(transaction, orderRef, order, deliveryQty, actor, sourceId) {
    return applyInventoryDeliveryDeltaInTransaction(transaction, order, deliveryQty, actor, sourceId);
}

async function applyInventoryReturnDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, previousReturnRecord) {
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
    if (deltaQty < 0 && wh.onHand < Math.abs(deltaQty)) {
        throw new Error('刪除／縮減退貨後會造成庫存小於 0。');
    }
    const now=new Date().toISOString();
    let lotAllocations=[],cogs=0;
    if(deltaQty>0){
        // Editing a return increases only the new delta; its original lots are already returned.
        const priorReturns = savedReturnRecords(order).filter(record => !previousReturnRecord || record.id !== previousReturnRecord.id);
        if (previousReturnRecord) priorReturns.push(previousReturnRecord);
        const available=globalThis.YushinInventory.availableReturnAllocations(savedDeliveryRecords(order),priorReturns);
        const plan=globalThis.YushinInventory.reverseLotAllocations([{qty:available.reduce((sum,row)=>sum+Number(row.qty||0),0),lotAllocations:available}],deltaQty);
        lotAllocations=plan.allocations;cogs=plan.totalCost;
        const lotContexts=await Promise.all(lotAllocations.map(async row=>{
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            return {row,lotRef,lotSnap:await transaction.get(lotRef)};
        }));
        for(const {row,lotRef,lotSnap} of lotContexts){
            if(!lotSnap.exists)throw new Error(`找不到原出貨批次 ${row.lotNo||row.lotId}，無法辦理退貨。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)+row.qty,updatedAt:now});
        }
    }else{
        const plan=globalThis.YushinInventory.reverseLotAllocations(previousReturnRecord?[previousReturnRecord]:[],Math.abs(deltaQty));
        lotAllocations=plan.allocations.map(row=>({...row,qty:-row.qty,cost:-row.cost}));cogs=-plan.totalCost;
        const lotContexts=await Promise.all(plan.allocations.map(async row=>{
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            return {row,lotRef,lotSnap:await transaction.get(lotRef)};
        }));
        for(const {row,lotRef,lotSnap} of lotContexts){
            if(!lotSnap.exists||Number(lotSnap.data().remainingQty||0)<row.qty)throw new Error(`批次 ${row.lotNo||row.lotId} 庫存不足，無法刪除／縮減退貨。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)-row.qty,updatedAt:now});
        }
    }
    // 正常訂單退貨後要把商品重新保留給原訂單，供補送使用。
    // 已取消／作廢訂單只把退貨放回自由庫存，不能重新占住庫存；若遇到殘留預留也一併釋放。
    const currentReservation=globalThis.YushinReservation.assertLegacyReservationLocation(
        reservationSnap.exists?reservationSnap.data():{}, {warehouseId,productKey});
    const returnKeepsReservation=normalizedOrderStatus(order)==='normal';
    const nextReservation=returnKeepsReservation?(order.customerReturnSettlement==='CLOSE'?currentReservation:Math.max(0,currentReservation+deltaQty)):0;
    const reservationDelta=nextReservation-currentReservation;
    const nextReserved=Math.max(0,inv.reserved+reservationDelta);
    const nextWarehouseReserved=Math.max(0,wh.reserved+reservationDelta);
    if (invSnap.exists) transaction.set(invRef,{onHand:Math.max(0,inv.onHand+deltaQty),reserved:nextReserved,incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:wh.onHand+deltaQty,reserved:nextWarehouseReserved,incoming:wh.incoming,updatedAt:now},{merge:true});
    const reservationStatus=returnKeepsReservation?(nextReservation>0?'active':'fulfilled'):'released';
    transaction.set(reservationRef,{...inventoryReservationPayload(sourceId,order,nextReservation,reservationStatus),itemId:deliveryItemId,warehouseId},{merge:true});
    transaction.set(db.collection('inventoryMovements').doc(),{
        type:deltaQty>0?'return_in':'return_reversal',qty:deltaQty,productKey,warehouseId,
        fulfillmentType:'WAREHOUSE',sourceType:DOCUMENT_TYPES.ORDER,sourceId,
        createdAt:now,createdBy:actor,lotAllocations,costPending:true,reservationDelta,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    });
    return {lotAllocations,cogs,reservationDelta,newReservedQty:nextReservation};
}

