// Central authority for cancellation/restoration of an order and its stock holds.
async function setOrderLifecycleStatus(orderId,nextStatus,details=null) {
    if(!['normal','cancelled'].includes(nextStatus))throw new Error('不支援的訂單狀態。');
    // Quick actions change status only; the form may also amend date/reason.
    const date=details===null?localDateString():details.date;
    const reason=details===null?'':String(details.reason||'').trim();
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)
        ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
        ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)
        throw new Error('請填寫正確的狀態日期。');
    const actor=deliveryActor(),at=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
        const statusChanged=previous.status!==nextStatus;
        if (!statusChanged&&(details===null||(previous.date===date&&previous.reason===reason))) {
            savedOrder=order;
            return;
        }
        if(statusChanged&&nextStatus==='cancelled'&&deliveryProgressInfo(order).remaining<=0)throw new Error('訂單已無剩餘未送貨數量，請重新確認。');
         const history = {
            action: statusChanged&&nextStatus === 'normal' ? 'restore' : 'status_change',
            before: previous,
            after: { status: nextStatus, date, reason },
            by: actor,
            at
        };
        const reservationLifecycle=statusChanged
            ?await adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor):null;
        const updates = {
            items:reservationLifecycle?.items||order.items||[],
            itemCount:(reservationLifecycle?.items||normalizedOrderItems(order)).length,
            orderSchemaVersion:2,
            status: nextStatus === 'cancelled' ? BUSINESS_STATUS.CANCELLED : BUSINESS_STATUS.ACTIVE,
            orderStatus: nextStatus,
            orderStatusDate: date,
            orderStatusReason: reason,
            updatedAt: history.at,
            orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(history)
        };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, orderLifecycleHistory: [...(order.orderLifecycleHistory || []), history] };
    });
    return savedOrder;
}

