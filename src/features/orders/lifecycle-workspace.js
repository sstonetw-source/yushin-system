function confirmOrderCancellation(order) {
        const progress=deliveryProgressInfo(order);
        if(progress.remaining<=0){alert('這筆訂單已無剩餘未送貨數量。已送貨品項請使用退貨流程。');return false;}
        const items=normalizedOrderItems(order);
        const reserved=items.reduce((sum,item)=>sum+Math.max(0,Number(item.reservedQty||0)),0);
        const incoming=items.reduce((sum,item)=>sum+Math.max(0,Number(item.supplyOrderedQty||0)-Number(item.receivedQty||0)),0);
        const documents=[...new Set(items.flatMap(item=>item.purchaseDocumentNos||[]))];
        const action=progress.delivered>0?'取消剩餘未送貨數量':'取消訂單';
        const message=[`${action}：${progress.remaining} 個。`, `釋放庫存預留：${reserved} 個；已到貨的貨仍留在庫存。`,
            incoming>0?`尚有 ${incoming} 個採購未到貨；已建立採購單不會自動取消，請到採購待到貨確認：供應商同意取消，或保留採購轉庫存。`:'',
            documents.length?`關聯採購單：${documents.join('、')}`:'',
            progress.delivered>0?'已送貨與退貨紀錄保留，已送出的貨不會自動退回庫存。':''].filter(Boolean).join('\n\n');
        return confirm(message);
}

window.quickSetOrderLifecycle = async function(orderId, nextStatus) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    if (!['normal', 'cancelled'].includes(nextStatus)) return;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder) return;
    if(cachedOrder.inventoryReservationStatus==='pending'){showActionFeedback('這筆訂單庫存仍在同步，請完成或重試同步後再變更狀態。','warning');return;}
    if (pendingLifecycleOrderIds.has(orderId) || normalizedOrderStatus(cachedOrder) === nextStatus) return;
    if(nextStatus==='cancelled'&&!confirmOrderCancellation(cachedOrder))return;
    pendingLifecycleOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
        const savedOrder=await setOrderLifecycleStatus(orderId,nextStatus);
        // The lifecycle transaction already synchronizes stock and purchase demand.
        normalizedOrderItems(savedOrder).forEach(item=>{
            const productKey=inventoryProductKey(item);
            const warehouseId=(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||savedOrder.warehouseId||'');
            if(productKey&&warehouseId) invalidateWarehouseStockCache(productKey,warehouseId);
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        const syncedOrder = { id: orderId, ...savedOrder };
        if (index >= 0) ordersCache[index] = syncedOrder;
        syncOrderIntoPurchasingCaches(syncedOrder);
        writeAppDataCache('orders', ordersCache);
        pendingLifecycleOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    } catch (err) {
        pendingLifecycleOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert(`${nextStatus === 'normal' ? '恢復' : '取消'}訂單失敗：` + err.message);
    }
};

window.toggleOrderProgressStatus = function(field, newValue) {
    const orderId = currentDeliveryOrderId;
    if (!orderId || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    toggleOrderStatus(orderId, field, newValue);
    renderDeliveryModal();
};

window.resetDeliveryForm = function() {
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryFormPanel').style.display = 'none';
    document.getElementById('deliveryEditId').value = '';
    document.getElementById('deliveryDate').value = localDateString();
    document.getElementById('deliveryQty').value = '';
    document.getElementById('deliveryNotes').value = '';
    document.getElementById('deliveryFormTitle').innerText = '新增送貨紀錄';
    document.getElementById('deliveryCancelEditBtn').style.display = 'none';
    const itemSelect=document.getElementById('deliveryItemId');
    if(itemSelect)itemSelect.disabled=false;
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    const progress = deliveryProgressInfo(order || {});
    document.getElementById('deliveryFormHint').innerText = `目前最多還可登錄 ${progress.remaining} 個。`;
};

window.openPartialDeliveryForm = function() {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (normalizedOrderStatus(order) !== 'normal') { alert('已取消的訂單不能新增送貨紀錄。'); return; }
    const progress = deliveryProgressInfo(order);
    if (progress.remaining <= 0) { alert('這筆訂單已全數送貨。'); return; }
    selectOrderProgressTab('delivery');
    deliveryPartialFormOpen = true;
    document.getElementById('deliveryFormPanel').style.display = '';
    document.getElementById('deliveryQty').value = '';
    document.getElementById('deliveryDate').focus();
};

window.openPartialDeliveryForOrder = function(orderId) {
    if (!canManageOrderLifecycleCapability()) return;
    openDeliveryModal(orderId);
    openPartialDeliveryForm();
};

window.openReturnManagement = function(orderId) {
    if (!canManageOrderLifecycleCapability()) return;
    openDeliveryModal(orderId);
    openReturnForm();
    if (!orderReturnFormOpen) return;
    const form = document.getElementById('returnFormPanel');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('returnDate').focus();
};

window.openOrderStatusHistory = function(orderId) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order) return;
    currentOrderHistoryId = orderId;
    orderProgressHistoryExpanded = false;
    document.getElementById('orderHistoryModalTitle').innerText = `操作紀錄：${order.orderNo || order.customerName || '訂單'}`;
    renderOrderStatusHistory(order);
    document.getElementById('orderHistoryModalOverlay').classList.add('active');
};
window.closeOrderStatusHistory = function() {
    currentOrderHistoryId = null;
    document.getElementById('orderHistoryModalOverlay').classList.remove('active');
};

function renderOrderStatusHistory(order) {
    const tbody = document.getElementById('orderStatusHistoryBody');
    if (!tbody) return;
    const entries = [];
    const createdAt=order.createdAt||order.orderDate||'';
    if(createdAt){
        entries.push({
            at:createdAt,
            action:'建立訂單',
            by:order.createdByName||order.createdBy||order.creatorName||order.salesName||'',
            detail:[order.orderNo||order.id||'',order.customerName||''].filter(Boolean).join('｜')
        });
    }
    normalizedOrderItems(order).forEach(item=>{
        const itemLabel=[item.itemCode||'',item.itemName||''].filter(Boolean).join(' ');
        const orderEvents=Array.isArray(item.orderEvents)?item.orderEvents:[];
        orderEvents.forEach(event=>{
            const action=event.type==='SALES_SELF_ORDER'?'業務自行訂貨':'已採購';
            const detail=[itemLabel,event.documentNo||'',event.qty!=null?(`數量 ${event.qty}`):''].filter(Boolean).join('｜');
            entries.push({at:event.at||event.date||item.orderedAt||'',action,by:event.by||'',detail});
        });
        // 已有 orderedAt 的既有資料仍可顯示一筆採購時間，不要求回補歷史事件。
        if(!orderEvents.length&&item.orderedAt&&Number(item.supplyOrderedQty||0)>0){
            const documentNos=[...(item.purchaseDocumentNos||[]),...(item.manualOrderNos||[]),...(item.selfOrderNos||[])].filter(Boolean);
            entries.push({at:item.orderedAt,action:(item.procurementType||'')==='SALES_SELF_ORDER'?'業務自行訂貨':'已採購',by:'',detail:[itemLabel,documentNos.join('、'),`累計 ${Number(item.supplyOrderedQty||0)}`].filter(Boolean).join('｜')});
        }
        (item.receiptEvents||[]).forEach(event=>{
            const action=event.fulfillmentType==='DIRECT_SHIP'?'原廠直送到貨':'採購入庫';
            const detail=[itemLabel,event.qty!=null?(`到貨 ${event.qty}`):'',event.sourceOrderStatus==='cancelled'?'來源訂單已取消，轉自由庫存':''].filter(Boolean).join('｜');
            entries.push({at:event.at||event.date||'',action,by:event.by||'',detail});
        });
    });
    (order.statusHistory || []).forEach(item => entries.push({ at: item.at, action: item.label || '進度變更', by: item.by, detail: '' }));
    (order.deliveryHistory || []).forEach(item => {
        const action = { create: '新增送貨', edit: '修改送貨', delete: '刪除送貨', cancel_all: '取消全部送貨', clear_legacy_estimate: '取消歷史推估' }[item.action] || '送貨異動';
        const record = item.after || item.before || {};
        const detail = record.qty != null ? `${record.date || ''}／${record.qty} 個${record.notes ? `／${record.notes}` : ''}` : '';
        entries.push({ at: item.at, action, by: item.by, detail });
    });
    (order.returnHistory || []).forEach(item => {
        const action = { create: '新增退貨', edit: '修改退貨', delete: '刪除退貨' }[item.action] || '退貨異動';
        const record = item.after || item.before || {};
        entries.push({ at: item.at, action, by: item.by, detail: `${record.date || ''}${record.qty != null ? `／${record.qty} 個` : ''}${record.reason ? `／${record.reason}` : ''}` });
    });
    const deliveryHistoryRecordIds=new Set((order.deliveryHistory||[]).flatMap(item=>[item.after?.id,item.before?.id]).filter(Boolean));
    savedDeliveryRecords(order).forEach(record=>{
        if(record.id&&deliveryHistoryRecordIds.has(record.id))return;
        entries.push({at:record.createdAt||record.date||'',action:'送貨紀錄',by:record.createdBy||'',detail:`${record.date||''}${record.qty!=null?`／${record.qty} 個`:''}${record.notes?`／${record.notes}`:''}`});
    });
    const returnHistoryRecordIds=new Set((order.returnHistory||[]).flatMap(item=>[item.after?.id,item.before?.id]).filter(Boolean));
    savedReturnRecords(order).forEach(record=>{
        if(record.id&&returnHistoryRecordIds.has(record.id))return;
        entries.push({at:record.createdAt||record.date||'',action:'退貨紀錄',by:record.createdBy||'',detail:`${record.date||''}${record.qty!=null?`／${record.qty} 個`:''}${record.reason?`／${record.reason}`:''}`});
    });
    (order.orderLifecycleHistory || []).forEach(item => {
        const statusLabels = { normal: '恢復正常', cancelled: '取消訂單', voided: '取消訂單' };
        const after = item.after || {};
        entries.push({ at: item.at, action: statusLabels[after.status] || '訂單狀態變更', by: item.by, detail: `${after.date || ''}${after.reason ? `／${after.reason}` : ''}` });
    });
    (order.fieldEditHistory || []).forEach(item => entries.push({ at: item.at, action: item.label || '修改資料', by: item.by, detail: `${item.before ?? '－'} → ${item.after ?? '－'}` }));
    // 採購／到貨狀態由 supplyOrders、receipts、reservation 與 dispatch qty 推導。
    if (order.isBilled && !(order.statusHistory || []).some(item => item.field === 'isBilled')) {
        entries.push({ at: orderBillingDate(order) || order.orderDate || '', action: '核銷（歷史推估）', by: '舊資料未記錄', detail: '依目前核銷狀態推估' });
    }
    if (order.isDelivered && !savedDeliveryRecords(order).length && !(order.deliveryHistory || []).length) {
        entries.push({ at: order.orderDate || '', action: '送貨（歷史推估）', by: '舊資料未記錄', detail: '依目前訂單狀態推估，日期暫用訂單日期' });
    }
    for(const h of order.logisticsHistory||[])entries.push({at:h.at,action:h.action,by:h.by,detail:h.detail||''});
    entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    tbody.innerHTML = entries.length ? (orderProgressHistoryExpanded ? entries : entries.slice(0, 5)).map(item => `<tr><td>${escapeHtml(formatOrderStatusTime(item.at))}</td><td>${escapeHtml(item.action || '')}</td><td>${escapeHtml(item.by || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`).join('') : '<tr><td colspan="4" style="color:#888;">尚無操作紀錄。</td></tr>';
    document.getElementById('orderHistoryMoreBtn').hidden = orderProgressHistoryExpanded || entries.length <= 5;
    labelOrderProgressRecords('orderStatusHistoryBody', ['時間', '動作', '操作人', '說明']);
}

