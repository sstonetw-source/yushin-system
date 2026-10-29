function deliveryRecordId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function deliveryActor() {
    return currentUserName || currentUser?.email || '未知使用者';
}

function localDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function normalizeBusinessDate(value) {
    if (!value) return '';
    const raw = String(value).trim().replace(/\//g, '-');
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return dateOnlyFromTimestamp(value);
}

function unifiedPeriodRange(key = 'this-year') {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (key === 'all') return { start: '', end: '' };
    if (key === 'this-month') return { start: fmt(new Date(y, m, 1)), end: fmt(new Date(y, m + 1, 0)) };
    if (key === 'last-month') return { start: fmt(new Date(y, m - 1, 1)), end: fmt(new Date(y, m, 0)) };
    if (key === 'this-quarter') {
        const qStart = Math.floor(m / 3) * 3;
        return { start: fmt(new Date(y, qStart, 1)), end: fmt(new Date(y, qStart + 3, 0)) };
    }
    if (key === 'last-year') return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    return { start: `${y}-01-01`, end: `${y}-12-31` };
}

function dateInUnifiedPeriod(value, key = 'this-year') {
    const date = normalizeBusinessDate(value);
    const { start, end } = unifiedPeriodRange(key);
    if (!start && !end) return true;
    return !!date && (!start || date >= start) && (!end || date <= end);
}

let orderProgressHistoryExpanded = false;
let currentOrderHistoryId = null;
let orderLifecycleFormOpen = false;
let orderReturnFormOpen = false;
window.selectOrderProgressTab = function(tab) {
    if (!['delivery', 'returns'].includes(tab)) return;
    ['delivery', 'returns'].forEach(name => {
        document.getElementById(`orderProgressPanel-${name}`).hidden = name !== tab;
        const button = document.getElementById(`orderProgressTab-${name}`);
        button.setAttribute('aria-selected', String(name === tab));
    });
};
window.showAllOrderProgressHistory = function() {
    orderProgressHistoryExpanded = true;
    const order = ordersCache.find(o => o.id === currentOrderHistoryId);
    if (order) renderOrderStatusHistory(order);
};
function labelOrderProgressRecords(bodyId, labels) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    Array.from(body.rows).forEach(row => Array.from(row.cells).forEach((cell, i) => {
        if (cell.colSpan === 1) cell.dataset.label = labels[i];
    }));
}
window.closeOrderLifecycleForm = function() {
    orderLifecycleFormOpen = false;
    document.getElementById('orderStatusEditPanel').style.display = 'none';
};
window.openOrderLifecycleForm = function() {
    const order = ordersCache.find(o => o.id === currentLifecycleOrderId);
    if (!order || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (lifecycleProtectedMode()){
        try{if(!pendingV2OrderLifecycle(order.id)&&normalizedOrderStatus(order)==='normal'&&deliveryProgressInfo(order).remaining<=0)return;}
        catch(err){alert(err.message);return;}
    }else if (normalizedOrderStatus(order) === 'normal' && deliveryProgressInfo(order).remaining <= 0) return;
    selectOrderProgressTab('returns');
    orderLifecycleFormOpen = true;
    document.getElementById('orderLifecycleStatus').value = normalizedOrderStatus(order) === 'normal' ? 'cancelled' : 'normal';
    renderOrderLifecycleModal();
};
window.openReturnForm = function() {
    const order = ordersCache.find(o => o.id === currentLifecycleOrderId);
    if (!order || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (!normalizedOrderItems(order).some(item => returnItemDeliveredQty(order, item.itemId) - returnItemReturnedQty(order, item.itemId) - customerReturnPendingQty(order, item.itemId) > 0)) return;
    selectOrderProgressTab('returns');
    orderReturnFormOpen = true;
    document.getElementById('returnCancelEditBtn').style.display = '';
    renderOrderLifecycleModal();
    document.getElementById('returnDate').focus();
};

window.openDeliveryModal = function(orderId) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order) return;
    if(orderInventorySyncIncomplete(order)){showActionFeedback('這筆訂單庫存尚未同步完成，請先完成或重試同步。','warning');return;}
    currentDeliveryOrderId = orderId;
    currentLifecycleOrderId = orderId;
    orderProgressHistoryExpanded = false;
    orderLifecycleFormOpen = false;
    orderReturnFormOpen = false;
    selectOrderProgressTab('delivery');
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryModalTitle').innerText = `訂單進度：${order.customerName || order.itemName || '訂單'}`;
    document.getElementById('orderLifecycleStatus').value = normalizedOrderStatus(order);
    document.getElementById('orderLifecycleDate').value = order.orderStatusDate || localDateString();
    document.getElementById('orderLifecycleReason').value = order.orderStatusReason || '';
    resetDeliveryForm();
    resetReturnForm();
    renderDeliveryModal();
    renderOrderLifecycleModal();
    window.renderOrderDeliverySettingsButton?.(order);
    document.getElementById('deliveryModalOverlay').classList.add('active');
};

window.closeDeliveryModal = function() {
    currentDeliveryOrderId = null;
    currentLifecycleOrderId = null;
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryModalOverlay').classList.remove('active');
};

window.prepareOrderLifecycle = function(orderId, status) {
    openDeliveryModal(orderId);
    openOrderLifecycleForm();
    if (!orderLifecycleFormOpen) return;
    document.getElementById('orderLifecycleStatus').value = status;
    document.getElementById('orderLifecycleDate').value = localDateString();
    document.getElementById('orderLifecycleReason').value = '';
    onOrderLifecycleStatusChange();
    document.getElementById('orderStatusEditPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('orderLifecycleReason').focus();
};

