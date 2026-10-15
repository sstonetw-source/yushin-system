// Order delivery mutations. UI owns input/feedback; this service owns protected writes.
function assertOrderDeliveryIncrease(order,item,qty) {
    if(qty<=0)return;
    if(orderInventorySyncIncomplete(order))throw new Error('訂單庫存尚未同步完成');
    if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')return;
    const single=normalizedOrderItems(order).length===1;
    const gross=savedDeliveryRecords(order).filter(row=>row.itemId===item.itemId||(!row.itemId&&single))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const shippable=globalThis.YushinFulfillment.dispatchState({deliveredQty:gross,
        reservedQty:item.reservedQty,dispatchPreparedQty:item.dispatchPreparedQty}).shippable;
    if(qty>shippable+1e-9)throw new Error(`${item.itemName||'品項'} 目前已打單可出貨數量只有 ${shippable}。`);
}

async function completeOrderDelivery(orderId,today) {
    const actor=deliveryActor(),now=new Date().toISOString(),recordId=deliveryRecordId();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        if (normalizedOrderStatus(order) !== 'normal') throw new Error('這筆訂單已取消。');
        if(orderInventorySyncIncomplete(order))throw new Error('訂單庫存尚未同步完成');
        const transactionItems=normalizedOrderItems(order);
        // UI 已阻擋多品項一鍵送貨；transaction 仍要以最新資料再次驗證，
        // 避免 stale cache 或另一端剛修改品項後寫入無法歸屬品項的送貨紀錄。
        if (transactionItems.length !== 1) throw new Error('多品項訂單不能一鍵完成送貨，請逐品項登錄。');
        if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('這筆舊資料已視為全數送貨。');
        const total = orderQuantity(order);
        const records = savedDeliveryRecords(order).slice();
        const {effectiveDelivered}=orderDeliveryProjection(order);
        const remaining = Math.max(0, total - effectiveDelivered);
        if (!total) throw new Error('訂單數量必須大於 0，才能登錄送貨。');
        if (remaining <= 0) {savedOrder=order;return;}
        assertOrderDeliveryIncrease(order,transactionItems[0],remaining);
        const record = { id: recordId, itemId:transactionItems[0].itemId, date: today, qty: remaining, notes: '一鍵完成剩餘送貨', createdBy: actor, createdAt: now };
        records.push(record);
        const history = { action: 'create', source: 'quick_complete', recordId: record.id, before: null, after: record, by: actor, at: now };
        const statusEntries = [];
        const deliveryItem=transactionItems[0];
        const itemOrder={...order,...deliveryItem,deliveryRecords:records.filter(row=>row.itemId===deliveryItem.itemId),isDelivered:false};
        const inventoryResult=await applyInventoryDeliveryInTransaction(transaction, ref, itemOrder, remaining, actor, orderId);
        record.lotAllocations=inventoryResult?.lotAllocations||[];
        record.cogs=Number(inventoryResult?.cogs||0);
        records[records.length-1]=record;
        const nextItems=transactionItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
        const grossAfterDelivery = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
        const effectiveAfterDelivery = orderDeliveryProjection({...order,deliveryRecords:records,isDelivered:false}).effectiveDelivered;
        const updates = {
            items:nextItems, deliveryRecords: records, deliveredQty: grossAfterDelivery, isDelivered: effectiveAfterDelivery >= total,
            deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history)
        };
        if (statusEntries.length) updates.statusHistory = firebase.firestore.FieldValue.arrayUnion(...statusEntries);
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = {
            ...order, ...updates,
            deliveryHistory: [...(order.deliveryHistory || []), history],
            statusHistory: [...(order.statusHistory || []), ...statusEntries]
        };
    });
    return savedOrder;
}

async function cancelOrderDeliveries(orderId) {
    const actor=deliveryActor(),now=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        // 前端雖已擋多品項，但 transaction 必須再次依最新 Firestore 資料驗證，
        // 避免 stale cache／重複操作把整張訂單的庫存還原到錯誤品項。
        if (normalizedOrderItems(order).length !== 1) throw new Error('只有單品項訂單可以一鍵取消全部送貨，請逐品項更正送貨紀錄。');
        if (returnedQuantity(order) > 0) throw new Error('這筆訂單已有退貨紀錄，請先更正退貨紀錄。');
        if (!savedDeliveryRecords(order).length&&!order.isDelivered) {savedOrder=order;return;}
        const progress = deliveryProgressInfo(order);
        if (progress.state !== 'complete') throw new Error('這筆訂單目前不是全數已送貨狀態。');
        const before = savedDeliveryRecords(order).length
            ? { records: savedDeliveryRecords(order), deliveredQty: progress.delivered }
            : { legacyEstimated: true, estimatedDate: order.orderDate || '', deliveredQty: progress.delivered };
        const history = { action: 'cancel_all', source: 'quick_toggle', before, after: { records: [], deliveredQty: 0 }, by: actor, at: now };
        const currentItems=normalizedOrderItems(order);
        const deliveryItem=currentItems[0];
        const itemOrder={...order,...deliveryItem,deliveryRecords:savedDeliveryRecords(order),isDelivered:false};
        const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, itemOrder, -progress.delivered, actor, orderId, savedDeliveryRecords(order));
        const nextItems=currentItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
        const updates = { items:nextItems, deliveryRecords: [], deliveredQty: 0, isDelivered: false, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
    });
    return savedOrder;
}

async function saveOrderDeliveryRecord(orderId,{date,qty,notes='',editId='',itemId='',recordId}) {
    if(!date||typeof qty!=='number'||!Number.isFinite(qty)||qty<=0)
        throw new Error('請填寫送貨日期與大於 0 的送貨數量。');
    if(!editId&&(typeof recordId!=='string'||!recordId.trim()))throw new Error('缺少送貨作業識別碼，請重新開啟表單。');
    const actor=deliveryActor(),now=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('請先取消舊資料的歷史推估送貨紀錄。');
        const records = savedDeliveryRecords(order).slice();
        if(!editId&&(order.deliveryHistory||[]).some(row=>row.action==='delete'&&row.recordId===recordId))
            throw new Error('這筆送貨作業已更正撤銷，不能重試為新的送貨。');
        // A lost response may be retried with the same form attempt ID.
        // Never reinterpret an existing ID as a second physical shipment.
        const submitted=!editId&&records.find(row=>row.id===recordId);
        if(submitted){
            if(submitted.date!==date||Number(submitted.qty)!==qty||String(submitted.notes||'')!==notes
                ||(itemId&&normalizedOrderItems(order).length>1&&submitted.itemId!==itemId))
                throw new Error('這個送貨識別碼已有不同內容，請重新查詢送貨紀錄。');
            savedOrder=order;return;
        }
        const existingIndex = records.findIndex(item => item.id === editId);
        if (editId && existingIndex < 0) throw new Error('這筆送貨紀錄已被其他人修改或刪除，請重新開啟後再試。');
        if (normalizedOrderStatus(order) !== 'normal' && existingIndex < 0) throw new Error('已取消的訂單不能新增送貨紀錄。');
        const previous = existingIndex >= 0 ? records[existingIndex] : null;
        const orderItems=normalizedOrderItems(order);
        // Select only the recorded item: never silently substitute the first item.
        const requestedItemId=previous?.itemId||(orderItems.length===1?orderItems[0]?.itemId:itemId)||'';
        const targetItem=orderItems.find(item=>item.itemId===requestedItemId);
        if(!targetItem)throw new Error('找不到指定送貨品項，請重新開啟訂單確認。');
        if(previous&&previous.itemId===targetItem.itemId&&previous.date===date
            &&Number(previous.qty)===qty&&String(previous.notes||'')===notes){savedOrder=order;return;}
        const itemOtherDelivered=records.filter(r=>r.id!==editId&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
        const itemReturns=savedReturnRecords(order).filter(r=>(!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId);
        const itemReturned=itemReturns.reduce((s,r)=>s+Number(r.qty||0),0);
        // 退貨後補送必須以「有效送貨量」驗證，而不是歷史累計送貨量。
        // 例如訂購10、曾送10、退2，可再補送2；歷史送貨會成為12，但有效送貨仍是10。
        const itemGrossAfter=itemOtherDelivered+qty;
        if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 累計送貨數量不能低於已登錄的退貨數量 ${itemReturned}。`);
        const itemEffectiveAfter=globalThis.YushinFulfillment.projectOrderDelivery({grossDeliveredQty:itemGrossAfter,returnedQty:itemReturned,returnRecords:itemReturns}).effectiveDelivered;
        if(itemEffectiveAfter>Number(targetItem.qty||0)+1e-9)throw new Error(`${targetItem.itemName||'品項'} 有效送貨數量將超過訂單數量。`);
        assertOrderDeliveryIncrease(order,targetItem,qty-Number(previous?.qty||0));
        const record = previous
            ? { ...previous, itemId:targetItem.itemId, date, qty, notes, updatedBy: actor, updatedAt: now }
            : { id: recordId, itemId:targetItem.itemId, date, qty, notes, createdBy: actor, createdAt: now };
        if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
        const totalDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
        const total = orderQuantity(order);
        if (!total) throw new Error('訂單數量必須大於 0，才能登錄送貨。');
        const effectiveTotalDelivered=orderDeliveryProjection({...order,deliveryRecords:records,isDelivered:false}).effectiveDelivered;
        if (effectiveTotalDelivered > total + 1e-9) throw new Error(`有效送貨數量 ${effectiveTotalDelivered} 超過訂單數量 ${total}。`);
        const alreadyReturned = returnedQuantity(order);
        if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`累計送貨數量不能低於已登錄的退貨數量 ${alreadyReturned}。`);
        const action = previous ? 'edit' : 'create';
        const history = { action, recordId: record.id, before: previous, after: record, by: actor, at: now };
        const updates = { deliveryRecords: records, deliveredQty: totalDelivered, isDelivered: effectiveTotalDelivered >= total, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
        const deliveryDelta = qty - Number(previous?.qty || 0);
        if(deliveryDelta){
            const itemRecords=records.filter(r=>r.itemId===targetItem.itemId);
            const itemOrder={...order,...targetItem,qty:Number(targetItem.qty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
            const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction,itemOrder,deliveryDelta,actor,orderId,deliveryDelta<0&&previous?[previous]:null);
            const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            updates.items=syncedItems;
            if(deliveryDelta>0){
                record.lotAllocations=[...(previous?.lotAllocations||[]),...(inventoryResult.lotAllocations||[])];
                record.cogs=Number(previous?.cogs||0)+Number(inventoryResult.cogs||0);
                const recordIndex=records.findIndex(r=>r.id===record.id);
                if(recordIndex>=0)records[recordIndex]=record;
                updates.deliveryRecords=records;
            } else if(previous){
                const reversed=(inventoryResult.lotAllocations||[]).map(row=>({...row,qty:Math.abs(Number(row.qty||0))}));
                record.lotAllocations=globalThis.YushinInventory.allocationsAfterReversal(previous.lotAllocations||[],reversed);
                record.cogs=record.lotAllocations.reduce((sum,row)=>sum+Number(row.cost??(Number(row.qty||0)*Number(row.unitCost||0))),0);
                const recordIndex=records.findIndex(r=>r.id===record.id);
                if(recordIndex>=0)records[recordIndex]=record;
                updates.deliveryRecords=records;
            }
        }
        // Build the sentinel only after stock accounting populated the final record.
        updates.deliveryHistory=firebase.firestore.FieldValue.arrayUnion(history);
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
    });
    return savedOrder;
}

async function correctOrderDeliveryRecord(orderId,recordId,correctionReason) {
    if(typeof correctionReason!=='string'||!correctionReason.trim())throw new Error('請填寫誤登更正原因。');
    const actor=deliveryActor(),now=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        const records = savedDeliveryRecords(order);
        const removed = records.find(item => item.id === recordId);
        if (!removed) {
            if((order.deliveryHistory||[]).some(row=>row.action==='delete'&&row.recordId===recordId)) {savedOrder=order;return;}
            throw new Error('找不到這筆送貨紀錄。');
        }
        const next = records.filter(item => item.id !== recordId);
        const totalDelivered = next.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
        const alreadyReturned = returnedQuantity(order);
        if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`刪除後的送貨數量會低於已登錄的退貨數量 ${alreadyReturned}，請先更正退貨紀錄。`);
        const history = { action: 'delete', recordId, before: removed, after: null, reason: correctionReason.trim(), by: actor, at: now };
        const orderItems=normalizedOrderItems(order);
        const targetItem=orderItems.find(item=>item.itemId===removed.itemId) || (orderItems.length===1?orderItems[0]:null);
        if(!targetItem)throw new Error('找不到原送貨品項，無法安全還原庫存。');
        const itemRecords=records.filter(r=>((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId));
        const itemGrossAfter=itemRecords.filter(r=>r.id!==recordId).reduce((sum,row)=>sum+Number(row.qty||0),0);
        const itemReturned=savedReturnRecords(order)
            .filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
            .reduce((sum,row)=>sum+Number(row.qty||0),0);
        if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 刪除後的送貨數量會低於已登錄的退貨數量 ${itemReturned}，請先更正退貨紀錄。`);
        const itemOrder={...order,...targetItem,itemId:targetItem.itemId,qty:Number(targetItem.qty||targetItem.orderedQty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
        const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, itemOrder, -Number(removed.qty || 0), actor, orderId, [removed]);
        const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
        const effectiveDelivered=orderDeliveryProjection({...order,deliveryRecords:next,isDelivered:false}).effectiveDelivered;
        const updates = { items:syncedItems, deliveryRecords: next, deliveredQty: totalDelivered, isDelivered: effectiveDelivered >= orderQuantity(order) && orderQuantity(order) > 0, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
    });
    return savedOrder;
}

