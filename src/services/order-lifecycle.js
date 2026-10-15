// Central authority for cancellation/restoration of an order and its stock holds.
async function setOrderLifecycleStatus(orderId,nextStatus) {
    if(!['normal','cancelled'].includes(nextStatus))throw new Error('不支援的訂單狀態。');
    const date=localDateString(),actor=deliveryActor(),at=new Date().toISOString();
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
            if (previous.status === nextStatus) { savedOrder = order; return; }
            if(nextStatus==='cancelled'&&deliveryProgressInfo(order).remaining<=0)throw new Error('訂單已無剩餘未送貨數量，請重新確認。');
             const history = {
                action: nextStatus === 'normal' ? 'restore' : 'status_change',
                before: previous,
                after: { status: nextStatus, date, reason: '' },
                by: actor,
                at
            };
            const reservationLifecycle=await adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor);
            const updates = {
                items:reservationLifecycle?.items||order.items||[],
                itemCount:(reservationLifecycle?.items||normalizedOrderItems(order)).length,
                orderSchemaVersion:2,
                status: nextStatus === 'cancelled' ? BUSINESS_STATUS.CANCELLED : BUSINESS_STATUS.ACTIVE,
                orderStatus: nextStatus,
                orderStatusDate: date,
                orderStatusReason: '',
                updatedAt: history.at,
                orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(history)
            };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, orderLifecycleHistory: [...(order.orderLifecycleHistory || []), history] };
        });
    return savedOrder;
}

