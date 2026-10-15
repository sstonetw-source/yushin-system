window.quickCompleteDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if(orderInventorySyncIncomplete(cachedOrder)){showActionFeedback('訂單庫存尚未同步完成，請先完成同步。','warning');return;}
    const cachedProgress = deliveryProgressInfo(cachedOrder);
    if (normalizedOrderStatus(cachedOrder) !== 'normal') { alert('已取消的訂單不能送貨。'); return; }
    if (cachedProgress.state === 'complete') return quickCancelAllDelivery(orderId);
    if (cachedProgress.remaining <= 0) return;
    const fulfillment=fulfillmentProgressInfo(cachedOrder);
    const allItems=normalizedOrderItems(cachedOrder);
    const warehouseItems=allItems.filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP');
    if (allItems.length > 1) {
        alert('多品項訂單請逐品項登錄送貨，確保送貨與退貨都能追蹤到正確品項。');
        openDeliveryModal(orderId);
        openPartialDeliveryForm();
        return;
    }
    if (warehouseItems.length && fulfillment.shippable < cachedProgress.remaining) {
        alert(fulfillment.shippable > 0
            ? `目前只有 ${fulfillment.shippable} 個已完成打單可出貨，請使用分批送貨。`
            : '目前尚未完成打單，不能送貨。');
        if (fulfillment.shippable > 0) { openDeliveryModal(orderId); openPartialDeliveryForm(); }
        return;
    }
    const today = localDateString();
    const optimisticBefore = {
        deliveryRecords: savedDeliveryRecords(cachedOrder).slice(), deliveredQty: cachedOrder.deliveredQty,
        isDelivered: cachedOrder.isDelivered, statusHistory: [...(cachedOrder.statusHistory || [])]
    };
    const optimisticActor = deliveryActor();
    const optimisticAt = new Date().toISOString();
    cachedOrder.deliveryRecords = [...optimisticBefore.deliveryRecords, { id: `pending-${Date.now()}`, itemId:allItems[0].itemId, date: today, qty: cachedProgress.remaining, notes: '一鍵完成剩餘送貨', createdBy: optimisticActor, createdAt: optimisticAt }];
    cachedOrder.deliveredQty = cachedProgress.total;
    cachedOrder.isDelivered = true;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
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
            const alreadyDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const alreadyReturned = returnedQuantity(order);
            const effectiveDelivered = Math.max(0, alreadyDelivered - alreadyReturned);
            const remaining = Math.max(0, total - effectiveDelivered);
            if (!total || remaining <= 0) throw new Error('這筆訂單已無尚未送貨數量。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const record = { id: deliveryRecordId(), itemId:transactionItems[0].itemId, date: today, qty: remaining, notes: '一鍵完成剩餘送貨', createdBy: actor, createdAt: now };
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
            const effectiveAfterDelivery = Math.max(0, grossAfterDelivery - returnedQuantity(order));
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
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        pendingDeliveryOrderIds.delete(orderId);
        if (currentDeliveryOrderId === orderId) {
            resetDeliveryForm();
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        renderOrdersList();
    } catch (err) {
        cachedOrder.deliveryRecords = optimisticBefore.deliveryRecords;
        cachedOrder.deliveredQty = optimisticBefore.deliveredQty;
        cachedOrder.isDelivered = optimisticBefore.isDelivered;
        cachedOrder.statusHistory = optimisticBefore.statusHistory;
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert('一鍵送貨失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

window.quickCancelAllDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (returnedQuantity(cachedOrder) > 0) { alert('這筆訂單已有退貨紀錄，請先從 ⋯ 中更正或刪除退貨紀錄。'); return; }
    if (normalizedOrderItems(cachedOrder).length > 1) {
        alert('舊版多品項訂單不能使用一鍵取消全部送貨，請逐品項更正送貨紀錄，避免庫存還原到錯誤品項。');
        openDeliveryModal(orderId);
        return;
    }
    const optimisticBefore = { deliveryRecords: savedDeliveryRecords(cachedOrder).slice(), deliveredQty: cachedOrder.deliveredQty, isDelivered: cachedOrder.isDelivered };
    cachedOrder.deliveryRecords = [];
    cachedOrder.deliveredQty = 0;
    cachedOrder.isDelivered = false;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
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
            const progress = deliveryProgressInfo(order);
            if (progress.state !== 'complete') throw new Error('這筆訂單目前不是全數已送貨狀態。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
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
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        pendingDeliveryOrderIds.delete(orderId);
        if (currentDeliveryOrderId === orderId) {
            resetDeliveryForm();
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        renderOrdersList();
    } catch (err) {
        cachedOrder.deliveryRecords = optimisticBefore.deliveryRecords;
        cachedOrder.deliveredQty = optimisticBefore.deliveredQty;
        cachedOrder.isDelivered = optimisticBefore.isDelivered;
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert('取消已送貨失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function renderDeliveryModal() {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order) return;
    const editable = canManageOrderLifecycleCapability() && canEditPage('orders.list');
    const isEditing = !!document.getElementById('deliveryEditId').value;
    document.getElementById('deliveryFormPanel').style.display = editable && (normalizedOrderStatus(order) === 'normal' || isEditing) && (deliveryPartialFormOpen || isEditing) ? '' : 'none';
    const progress = deliveryProgressInfo(order);
    const lifecycle = orderLifecycleInfo(order);
    const locked = lifecycle.status !== 'normal';
    const syncing = pendingDeliveryOrderIds.has(order.id);
    const editableSteps = editable && !locked && !syncing;
    const purchase=purchaseProgressInfo(order);
    const fulfillment=fulfillmentProgressInfo(order);
    document.getElementById('orderWorkflowSteps').innerHTML = `
        <button type="button" class="workflow-step ${['ordered','not_required','direct'].includes(purchase.state)?'done':purchase.state==='partial'?'partial':''}" disabled><span>1</span>${escapeHtml(purchase.label)}</button>
        <button type="button" class="workflow-step ${['ready','direct','complete'].includes(fulfillment.state)?'done':fulfillment.state==='partial'?'partial':''}" disabled><span>2</span>${escapeHtml(fulfillment.label)}</button>
        <button type="button" class="workflow-step ${progress.state==='complete'?'done':progress.state==='partial'?'partial':''}" ${editableSteps&&progress.remaining>0?'onclick="openPartialDeliveryForm()"':'disabled'}><span>3</span>${escapeHtml(progress.label)}</button>
        <button type="button" class="workflow-step ${order.isBilled?'done':''}" ${editableSteps?`onclick="toggleOrderProgressStatus('isBilled', ${!order.isBilled})"`:'disabled'}><span>4</span>${order.isBilled?'已核銷':'未核銷'}</button>`;
    const deliveryItems=normalizedOrderItems(order);
    const deliveryItemNameById=new Map(deliveryItems.map(item=>[item.itemId,item.itemName||item.itemId||'']));
    const itemSummary=deliveryItems.map(item=>{
        const grossDelivered=savedDeliveryRecords(order)
            .filter(r=>(r.itemId||((deliveryItems.length===1&&deliveryItems[0]?.itemId)||''))===item.itemId)
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
        const returned=savedReturnRecords(order)
            .filter(r=>(r.itemId||((deliveryItems.length===1&&deliveryItems[0]?.itemId)||''))===item.itemId)
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
        const delivered=Math.max(0,grossDelivered-returned);
        return `<div><strong>${escapeHtml(item.itemName||'未命名品項')}</strong>（${escapeHtml(item.itemCode||'無貨號')}）<br>訂單數量 ${Number(item.qty||0)}｜已送 ${grossDelivered}｜退貨 ${returned}｜有效已送 ${delivered}</div>`;
    }).join('');
    document.getElementById('deliveryOrderSummary').innerHTML = itemSummary + `
        <div style="margin-top:6px;">目前狀態：${escapeHtml(lifecycle.label)}｜已送 ${progress.delivered}/${progress.total}｜未送 ${progress.remaining}</div>
        ${progress.isLegacyEstimated ? '<br><span class="delivery-estimated">這是舊版「已送貨」資料，日期暫以訂單日期推估。</span>' : ''}`;
    const deliveryForm=document.getElementById('deliveryFormPanel');
    if(deliveryForm&&deliveryItems.length>1){
        let select=document.getElementById('deliveryItemId');
        if(!select){
            select=document.createElement('select');select.id='deliveryItemId';select.style.marginBottom='8px';
            deliveryForm.insertBefore(select,deliveryForm.firstChild);
        }
        const current=select.value;
        select.innerHTML=deliveryItems.map(item=>`<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemCode||'')} ${escapeHtml(item.itemName||'')}</option>`).join('');
        if(deliveryItems.some(item=>item.itemId===current))select.value=current;
        select.style.display='';
    }else{
        const select=document.getElementById('deliveryItemId');if(select)select.style.display='none';
    }

    const tbody = document.getElementById('deliveryRecordsBody');
    const partialButton = document.getElementById('openPartialDeliveryBtn');
    if (partialButton) partialButton.style.display = editable && !locked && progress.remaining > 0 ? '' : 'none';
    const records = savedDeliveryRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (records.length) {
        tbody.innerHTML = records.map(record => `<tr>
            <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td>
            <td>${record.itemId ? escapeHtml(deliveryItemNameById.get(record.itemId)||record.itemId)+'<br>' : ''}${escapeHtml(record.notes || '')}</td>
            <td>${escapeHtml(record.createdBy || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(record.createdAt))}</span></td>
            <td>${editable ? `<details class="order-record-actions"><summary>操作</summary><button type="button" class="btn-small btn-secondary" onclick="editDeliveryRecord(${inlineJsValue(record.id)})">編輯</button> <button type="button" class="btn-danger" onclick="deleteDeliveryRecord(${inlineJsValue(record.id)})">更正誤登</button></details>` : '僅可查看'}</td>
        </tr>`).join('');
    } else if (progress.isLegacyEstimated) {
        tbody.innerHTML = `<tr><td>${escapeHtml(order.orderDate || '')}<br><span class="delivery-estimated">歷史推估</span></td><td>${progress.total}</td><td>舊版已送貨資料</td><td>－</td><td>${editable ? '<button type="button" class="btn-secondary" onclick="clearLegacyDelivery()">取消此推估</button>' : '僅可查看'}</td></tr>`;
    } else {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#888;">尚無送貨紀錄。</td></tr>';
    }
    labelOrderProgressRecords('deliveryRecordsBody', ['送貨日期', '數量', '備註', '登錄人／時間', '操作']);
    document.getElementById('deliveryFormHint').innerText = progress.isLegacyEstimated
        ? '請先取消舊資料推估，再登錄正確的分批送貨紀錄。'
        : `目前最多還可登錄 ${progress.remaining} 個。`;
}

window.editDeliveryRecord = function(recordId) {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    const record = savedDeliveryRecords(order).find(item => item.id === recordId);
    if (!record) return;
    const orderItems=normalizedOrderItems(order);
    const targetItem=orderItems.find(item=>item.itemId===record.itemId) || (orderItems.length===1?orderItems[0]:null);
    if(!targetItem){alert('找不到這筆送貨紀錄對應的品項，無法安全編輯。');return;}
    document.getElementById('deliveryEditId').value = record.id;
    const itemSelect=document.getElementById('deliveryItemId');
    if(itemSelect){
        itemSelect.value=targetItem.itemId;
        itemSelect.disabled=true;
        itemSelect.style.display=orderItems.length>1?'':'none';
    }
    document.getElementById('deliveryDate').value = record.date || localDateString();
    document.getElementById('deliveryQty').value = record.qty;
    document.getElementById('deliveryNotes').value = record.notes || '';
    document.getElementById('deliveryFormTitle').innerText = '編輯送貨紀錄';
    document.getElementById('deliveryCancelEditBtn').style.display = '';
    document.getElementById('deliveryFormPanel').style.display = '';
    const otherDelivered=savedDeliveryRecords(order)
        .filter(row=>row.id!==recordId&&((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const returned=savedReturnRecords(order)
        .filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const otherNetDelivered=Math.max(0,otherDelivered-returned);
    const maxQty=Math.max(0,Number(targetItem.qty||targetItem.orderedQty||0)-otherNetDelivered);
    document.getElementById('deliveryFormHint').innerText = `此筆最多可改為 ${maxQty} 個。`;
};

window.saveDeliveryRecord = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    const orderId = currentDeliveryOrderId;
    const date = document.getElementById('deliveryDate').value;
    const qty = parseFloat(document.getElementById('deliveryQty').value);
    const notes = document.getElementById('deliveryNotes').value.trim();
    const editId = document.getElementById('deliveryEditId').value;
    if (!orderId || !date || !Number.isFinite(qty) || qty <= 0) {
        alert('請填寫送貨日期與大於 0 的送貨數量。');
        return;
    }
    if (pendingDeliveryOrderIds.has(orderId)) return;
    const saveButton = document.querySelector('[onclick="saveDeliveryRecord()"]');
    pendingDeliveryOrderIds.add(orderId);
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = '儲存中…'; }
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('請先取消舊資料的歷史推估送貨紀錄。');
            const records = savedDeliveryRecords(order).slice();
            const existingIndex = records.findIndex(item => item.id === editId);
            if (editId && existingIndex < 0) throw new Error('這筆送貨紀錄已被其他人修改或刪除，請重新開啟後再試。');
            if (normalizedOrderStatus(order) !== 'normal' && existingIndex < 0) throw new Error('已取消的訂單不能新增送貨紀錄。');
            const now = new Date().toISOString();
            const actor = deliveryActor();
            const previous = existingIndex >= 0 ? records[existingIndex] : null;
            const orderItems=normalizedOrderItems(order);
            // Select only the recorded item: never silently substitute the first item.
            const requestedItemId=previous?.itemId||(orderItems.length===1?orderItems[0]?.itemId:document.getElementById('deliveryItemId')?.value)||'';
            const targetItem=orderItems.find(item=>item.itemId===requestedItemId);
            if(!targetItem)throw new Error('找不到指定送貨品項，請重新開啟訂單確認。');
            const itemOtherDelivered=records.filter(r=>r.id!==editId&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
            const itemReturned=savedReturnRecords(order).filter(r=>r.settlement!=='CLOSE'&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
            // 退貨後補送必須以「有效送貨量」驗證，而不是歷史累計送貨量。
            // 例如訂購10、曾送10、退2，可再補送2；歷史送貨會成為12，但有效送貨仍是10。
            const itemGrossAfter=itemOtherDelivered+qty;
            if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 累計送貨數量不能低於已登錄的退貨數量 ${itemReturned}。`);
            const itemOtherNetDelivered=Math.max(0,itemOtherDelivered-itemReturned);
            if(itemOtherNetDelivered+qty>Number(targetItem.qty||0)+1e-9)throw new Error(`${targetItem.itemName||'品項'} 有效送貨數量將超過訂單數量。`);
            if((targetItem.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
                const preparedQty=Number(targetItem.dispatchPreparedQty||0);
                if(itemOtherNetDelivered+qty>preparedQty+1e-9)throw new Error(`${targetItem.itemName||'品項'} 目前已打單可出貨數量只有 ${Math.max(0,preparedQty-itemOtherNetDelivered)}。`);
            }
            const record = previous
                ? { ...previous, itemId:targetItem.itemId, date, qty, notes, updatedBy: actor, updatedAt: now }
                : { id: deliveryRecordId(), itemId:targetItem.itemId, date, qty, notes, createdBy: actor, createdAt: now };
            if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
            const totalDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const total = orderQuantity(order);
            if (!total) throw new Error('訂單數量必須大於 0，才能登錄送貨。');
            const closedReturned=savedReturnRecords(order).filter(r=>r.settlement==='CLOSE').reduce((sum,r)=>sum+Number(r.qty||0),0);
            const effectiveTotalDelivered=Math.max(0,totalDelivered-returnedQuantity(order)+closedReturned);
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
                    record.lotAllocations=inventoryResult.lotAllocations||[];
                    record.cogs=Number(inventoryResult.cogs||0);
                    const recordIndex=records.findIndex(r=>r.id===record.id);
                    if(recordIndex>=0)records[recordIndex]=record;
                    updates.deliveryRecords=records;
                } else if(previous){
                    const reversed=(inventoryResult.lotAllocations||[]).map(row=>({...row,qty:Math.abs(Number(row.qty||0))}));
                    record.lotAllocations=window.YushinInventory.allocationsAfterReversal(previous.lotAllocations||[],reversed);
                    record.cogs=record.lotAllocations.reduce((sum,row)=>sum+Number(row.cost??(Number(row.qty||0)*Number(row.unitCost||0))),0);
                    const recordIndex=records.findIndex(r=>r.id===record.id);
                    if(recordIndex>=0)records[recordIndex]=record;
                    updates.deliveryRecords=records;
                }
            }
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('送貨紀錄儲存失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingDeliveryOrderIds.delete(orderId);
        if (saveButton) { saveButton.disabled = false; saveButton.textContent = '💾 儲存送貨紀錄'; }
    }
};

window.deleteDeliveryRecord = async function(recordId) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    const correctionReason = prompt('僅限更正誤登的送貨紀錄，會同步回補原出貨庫存並保留異動軌跡。實際已送出的貨請申請退貨。\n\n請輸入誤登更正原因：');
    if (!correctionReason || !correctionReason.trim()) return;
    const orderId = currentDeliveryOrderId;
    if (!orderId || pendingDeliveryOrderIds.has(orderId)) return;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const records = savedDeliveryRecords(order);
            const removed = records.find(item => item.id === recordId);
            if (!removed) throw new Error('找不到這筆送貨紀錄。');
            const next = records.filter(item => item.id !== recordId);
            const totalDelivered = next.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const alreadyReturned = returnedQuantity(order);
            if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`刪除後的送貨數量會低於已登錄的退貨數量 ${alreadyReturned}，請先更正退貨紀錄。`);
            const actor = deliveryActor();
            const now = new Date().toISOString();
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
            const effectiveDelivered=Math.max(0,totalDelivered-returnedQuantity(order));
            const updates = { items:syncedItems, deliveryRecords: next, deliveredQty: totalDelivered, isDelivered: effectiveDelivered >= orderQuantity(order) && orderQuantity(order) > 0, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('刪除失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
    }
};

window.clearLegacyDelivery = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    if (!confirm('確定取消這筆舊資料的「已送貨」推估嗎？取消後請重新登錄正確送貨日期與數量。')) return;
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order) return;
    if (returnedQuantity(order) > 0) { alert('這筆訂單已有退貨紀錄，請先更正或刪除退貨紀錄。'); return; }
    if (pendingDeliveryOrderIds.has(order.id)) return;
    pendingDeliveryOrderIds.add(order.id);
    try {
        const savedOrder=await clearOrderLegacyDeliveryEstimate(order.id);
        const index=ordersCache.findIndex(item=>item.id===order.id);
        if(index>=0)ordersCache[index]={id:order.id,...savedOrder};
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('取消歷史推估失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingDeliveryOrderIds.delete(order.id);
        renderOrdersList();
    }
};

function lifecycleRecordId() {
    return deliveryRecordId();
}

window.openOrderLifecycleModal = function(orderId) {
    openDeliveryModal(orderId);
};

window.closeOrderLifecycleModal = function() {
    closeDeliveryModal();
};

window.onOrderLifecycleStatusChange = function() {
    const status = document.getElementById('orderLifecycleStatus').value;
    document.getElementById('orderLifecycleReason').placeholder = status === 'normal' ? '恢復說明（選填）' : '取消原因（選填）';
};

function returnItemDeliveredQty(order,itemId) {
    const items=normalizedOrderItems(order);
    return savedDeliveryRecords(order)
        .filter(record=>(record.itemId||((items.length===1&&items[0]?.itemId)||''))===itemId)
        .reduce((sum,record)=>sum+Number(record.qty||0),0);
}

function returnItemReturnedQty(order,itemId,excludeRecordId='') {
    const items=normalizedOrderItems(order);
    return savedReturnRecords(order)
        .filter(record=>record.id!==excludeRecordId&&(record.itemId||((items.length===1&&items[0]?.itemId)||''))===itemId)
        .reduce((sum,record)=>sum+Number(record.qty||0),0);
}

function populateReturnItemOptions(order,selectedItemId='') {
    const select=document.getElementById('returnItemId');
    if(!select||!order)return;
    const items=normalizedOrderItems(order);
    const options=items.filter(item=>returnItemDeliveredQty(order,item.itemId)>0);
    select.innerHTML=options.map(item=>`<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemCode||item.itemName||item.itemId)}｜${escapeHtml(item.itemName||'')}</option>`).join('');
    const preferred=selectedItemId||options[0]?.itemId||'';
    if(preferred&&options.some(item=>item.itemId===preferred))select.value=preferred;
    select.disabled=!!document.getElementById('returnEditId')?.value;
}

window.updateReturnFormHint = function() {
    const order=ordersCache.find(item=>item.id===currentLifecycleOrderId);
    const hint=document.getElementById('returnFormHint');
    if(!order||!hint)return;
    const items=normalizedOrderItems(order);
    const selectedItemId=document.getElementById('returnItemId')?.value||(items.length===1?items[0]?.itemId:'');
    const editId=document.getElementById('returnEditId')?.value||'';
    if(!selectedItemId){hint.innerText='請先選擇要退貨的品項。';return;}
    const item=items.find(row=>row.itemId===selectedItemId);
    const delivered=returnItemDeliveredQty(order,selectedItemId);
    const otherReturned=returnItemReturnedQty(order,selectedItemId,editId);
    hint.innerText=`${item?.itemName||item?.itemCode||'此品項'}目前最多還可登錄 ${Math.max(0,delivered-otherReturned-(typeof customerReturnPendingQty==='function'?customerReturnPendingQty(order,selectedItemId):0))} 個退貨（已扣除待收申請）。`;
};

window.resetReturnForm = function() {
    orderReturnFormOpen = false;
    document.getElementById('returnFormPanel').style.display = 'none';
    document.getElementById('returnEditId').value = '';
    document.getElementById('returnDate').value = localDateString();
    document.getElementById('returnQty').value = '';
    document.getElementById('returnReason').value = '';
    document.getElementById('returnFormTitle').innerText = '新增退貨申請';
    document.getElementById('returnCancelEditBtn').style.display = 'none';
    const order=ordersCache.find(item=>item.id===currentLifecycleOrderId);
    populateReturnItemOptions(order);
    updateReturnFormHint();
};

function renderOrderLifecycleStatusOptions(order) {
    const select = document.getElementById('orderLifecycleStatus');
    const progress = deliveryProgressInfo(order);
    const currentStatus = normalizedOrderStatus(order);
    const selected = select.value || currentStatus;
    const canCancel = progress.remaining > 0;
    const cancelLabel = currentStatus === 'cancelled' ? '已取消'
        : progress.grossDelivered > 0 ? '取消剩餘未送貨數量' : '取消訂單';
    select.innerHTML = '<option value="normal">正常</option>'
        + (canCancel || currentStatus === 'cancelled' ? `<option value="cancelled">${cancelLabel}</option>` : '');
    select.value = selected === 'cancelled' && (canCancel || currentStatus === 'cancelled') ? 'cancelled' : 'normal';
    const hint = document.getElementById('orderLifecycleStatusHint');
    if (hint) hint.innerText = canCancel
        ? (progress.grossDelivered > 0 ? '僅取消剩餘未送貨數量；已送貨部分請申請退貨。' : '')
        : '已無剩餘未送貨數量，不能取消訂單；已送貨部分請申請退貨。';
}

function renderOrderLifecycleModal() {
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    if (!order) return;
    const editable = canManageOrderLifecycleCapability() && canEditPage('orders.list');
    const info = orderLifecycleInfo(order);
    renderOrderLifecycleStatusOptions(order);
    const canCancel = deliveryProgressInfo(order).remaining > 0;
    const cancelled = normalizedOrderStatus(order) !== 'normal';
    document.getElementById('orderStatusEditPanel').style.display = editable && orderLifecycleFormOpen && (canCancel || cancelled) ? '' : 'none';
    const lifecycleButton = document.getElementById('openLifecycleFormBtn');
    lifecycleButton.hidden = !editable || (!canCancel && !cancelled);
    lifecycleButton.textContent = cancelled ? '恢復訂單' : deliveryProgressInfo(order).grossDelivered > 0 ? '取消剩餘未送數量' : '取消訂單';
    const canReturn = normalizedOrderItems(order).some(item => returnItemDeliveredQty(order, item.itemId) - returnItemReturnedQty(order, item.itemId) - customerReturnPendingQty(order, item.itemId) > 0);
    document.getElementById('openReturnFormBtn').hidden = !editable || !canReturn;
    document.getElementById('orderLifecycleActionHint').textContent = !canCancel && !cancelled ? '已無剩餘未送貨數量；退貨請建立申請，由倉庫頁確認實收。' : '取消僅處理未送貨數量；已送貨部分請申請退貨。';
    const isEditingReturn = !!document.getElementById('returnEditId').value;
    document.getElementById('returnFormPanel').style.display = editable && (orderReturnFormOpen || isEditingReturn) && (info.effectiveDelivered > 0 || isEditingReturn) ? '' : 'none';
    const records = savedReturnRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const tbody = document.getElementById('returnRecordsBody');
    tbody.innerHTML = records.length ? records.map(record => `<tr>
        <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td><td>${escapeHtml(record.reason || '')}</td>
        <td>${escapeHtml(record.createdBy || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(record.createdAt))}</span></td>
        <td>僅可查看</td>
    </tr>`).join('') : '<tr><td colspan="5" style="color:#888;">尚無退貨紀錄。</td></tr>';
    labelOrderProgressRecords('returnRecordsBody', ['退貨日期', '數量', '原因／備註', '登錄人／時間', '操作']);
    const editingRecord=records.find(record=>record.id===document.getElementById('returnEditId')?.value);
    populateReturnItemOptions(order,editingRecord?.itemId||'');
    updateReturnFormHint();
    onOrderLifecycleStatusChange();
}

window.saveOrderLifecycleStatus = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    if (!order) return;
    const nextStatus = document.getElementById('orderLifecycleStatus').value;
    const date = document.getElementById('orderLifecycleDate').value;
    const reason = document.getElementById('orderLifecycleReason').value.trim();
    if (!date) { alert('請填寫狀態日期。'); return; }
    const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
    if (previous.status === nextStatus && previous.date === date && previous.reason === reason) return;
    if (pendingLifecycleOrderIds.has(order.id)) return;
    if(nextStatus==='cancelled'&&previous.status!=='cancelled'&&!confirmOrderCancellation(order))return;
    const saveButton = document.getElementById('orderLifecycleSaveBtn');
    pendingLifecycleOrderIds.add(order.id);
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    try {
        const savedOrder=await setOrderLifecycleStatus(order.id,nextStatus,{date,reason});
        // The lifecycle transaction already synchronizes stock and purchase demand.
        const index = ordersCache.findIndex(item => item.id === order.id);
        if (index >= 0) ordersCache[index] = { id: order.id, ...savedOrder };
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('訂單狀態儲存失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingLifecycleOrderIds.delete(order.id);
        if (saveButton) { saveButton.disabled = false; saveButton.innerText = '💾 儲存狀態'; }
    }
};

// Customer return mutations are owned by modules/customer-cancellations.js.

window.updateOrderField = function(orderId, field, value) {
    const o = ordersCache.find(x => x.id === orderId);
    if (!o || !canEditPage('orders.list')) return;
    if (field === 'costPrice' && (o.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER') {
        alert('公司標準成本請在採購／成本資料維護，不寫入業務可讀的訂單文件。');
        renderOrdersList();
        return;
    }
    const previousValue = o ? o[field] : undefined;
    if (String(previousValue ?? '') === String(value ?? '')) return;
    const labels = { costPrice: '修改單位成本', transactionType: '修改交易方式', invoiceTitle: '修改發票抬頭', remarks: '修改備註' };
    const history = {
        field, label: labels[field] || `修改${field}`,
        before: previousValue ?? '', after: value ?? '',
        by: currentUserName || currentUser?.email || '未知使用者', at: new Date().toISOString()
    };

    o[field] = value;
    o.fieldEditHistory = [...(o.fieldEditHistory || []), history];
    if (field === 'transactionType') renderOrdersList();

    db.collection('orders').doc(orderId).update({ [field]: value, fieldEditHistory: firebase.firestore.FieldValue.arrayUnion(history) }).catch(err => {
        o[field] = previousValue;
        o.fieldEditHistory = (o.fieldEditHistory || []).filter(item => item !== history);
        if (field === 'transactionType') renderOrdersList();
        alert('更新失敗，已還原：' + err.message);
    });
};

window.deleteOrder = function(orderId) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        if (canManageOrderLifecycleCapability()) prepareOrderLifecycle(orderId, 'cancelled');
        else alert('只有管理員可永久刪除訂單。');
        return;
    }
    const order = ordersCache.find(item => item.id === orderId);
    if (!order || !canEditPage('orders.list')) return;
    if (!isDeletableOrderDraft(order)) {
        alert('這筆訂單已有來源或流程紀錄，不能直接刪除，請改用取消。');
        prepareOrderLifecycle(orderId, 'cancelled');
        return;
    }
    if (!confirm('確定要刪除這筆尚未進入流程的草稿訂單嗎？')) return;
    runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        if (!isDeletableOrderDraft(snapshot.data())) throw new Error('這筆訂單已有新的流程紀錄，不能刪除，請改用取消。');
        transaction.delete(ref);
    }).then(() => {
        ordersCache = ordersCache.filter(item => item.id !== orderId);
        renderOrdersList();
    }).catch(err => alert('刪除失敗：' + err.message));
};

let newOrderDraftItems = [];
const ORDER_DRAFT_STORAGE_PREFIX = 'order_draft_v2';
let requestedOrderOwnerUid = '';
let orderModalOpenGeneration = 0;

