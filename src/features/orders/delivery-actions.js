let deliveryCreateAttempt = null;

window.quickCompleteDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    if (pendingDeliveryOrderIds.has(orderId)) return;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if(deliveryConfirmationProtectedMode()){
        openDeliveryModal(orderId);openPartialDeliveryForm();return;
    }
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
        const savedOrder=await completeOrderDelivery(orderId,today);
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
    if(deliveryConfirmationProtectedMode()){alert('v2 送達須逐筆撤銷，不可回補已寄出的庫存。');return;}
    const orderId = orderIdOverride || currentDeliveryOrderId;
    if (pendingDeliveryOrderIds.has(orderId)) return;
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
        const savedOrder=await cancelOrderDeliveries(orderId);
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
    const v2=deliveryConfirmationProtectedMode();
    let confirmation=null,reversal=null,pendingError='';
    if(v2)try{confirmation=pendingV2DeliveryConfirmation(order.id);reversal=pendingV2DeliveryReversal(order.id);}
    catch(error){pendingError=error.message;}
    const editable = canManageOrderLifecycleCapability() && canEditPage('orders.list') && !pendingError;
    const deliveryItems=normalizedOrderItems(order);
    const physicalDeliveryItems=deliveryItems.filter(item=>String(item.productType||'').trim().toUpperCase()!=='SERVICE');
    const isEditing = !!document.getElementById('deliveryEditId').value;
    document.getElementById('deliveryFormPanel').style.display = editable && physicalDeliveryItems.length>0
        && (normalizedOrderStatus(order) === 'normal' || isEditing) && (deliveryPartialFormOpen || isEditing) ? '' : 'none';
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
        <button type="button" class="workflow-step ${progress.state==='complete'?'done':progress.state==='partial'?'partial':''}" ${editableSteps&&progress.remaining>0&&physicalDeliveryItems.length?'onclick="openPartialDeliveryForm()"':'disabled'}><span>3</span>${escapeHtml(progress.label)}</button>
        <button type="button" class="workflow-step ${order.isBilled?'done':''}" ${editableSteps?`onclick="toggleOrderProgressStatus('isBilled', ${!order.isBilled})"`:'disabled'}><span>4</span>${order.isBilled?'已核銷':'未核銷'}</button>`;
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
    const serviceNotice=deliveryItems.some(item=>String(item.productType||'').trim().toUpperCase()==='SERVICE')
        ? '<div style="margin-top:8px;padding:8px;background:#f4f2ed;border-radius:5px;">此訂單含服務品項：檢體、委外器材、維修與報告均不算商品送貨；目前的送貨數量僅供實體商品作業參考。服務完工及交付須另有憑證，不能在這裡標記完成。</div>' : '';
    document.getElementById('deliveryOrderSummary').innerHTML = itemSummary + serviceNotice + `
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
        select.innerHTML=physicalDeliveryItems.map(item=>`<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemCode||'')} ${escapeHtml(item.itemName||'')}</option>`).join('');
        if(physicalDeliveryItems.some(item=>item.itemId===current))select.value=current;
        select.style.display='';
    }else{
        const select=document.getElementById('deliveryItemId');if(select)select.style.display='none';
    }

    // The existing delivery form selects a real immutable shipment only in
    // the isolated v2 demo. Never infer arrival from an inventory debit.
    if(deliveryConfirmationProtectedMode()){
        let host=document.getElementById('deliveryShipmentSelection');
        if(!host){
            host=document.createElement('label');host.id='deliveryShipmentSelection';
            host.textContent='客戶實際收到的出貨批次';
            const field=document.createElement('select');field.id='deliveryShipmentId';field.style.marginBottom='8px';
            host.appendChild(field);deliveryForm.insertBefore(host,deliveryForm.firstChild);
        }
        const field=document.getElementById('deliveryShipmentId');
        const frozen=confirmation;
        const rawItems=order.items||[],selectedItemId=frozen?.itemId
            ||document.getElementById('deliveryItemId')?.value
            ||(rawItems.length===1?rawItems[0].itemId:'');
        const old=field.value;
        try{
            const projected=globalThis.YushinFulfillment.projectOrderShipmentReturns({
                orderId:order.id,items:rawItems,shipments:order.warehouseShipmentRecords||[],
                deliveries:order.deliveryRecords||[],returns:order.returnRecords||[]});
            const part=projected.items.find(row=>row.itemId===selectedItemId);
            const options=(part?.shipments||[]).filter(row=>row.pendingQty>0||row.shipmentId===frozen?.shipmentId);
            field.innerHTML='<option value="">請選擇原倉庫出貨</option>'+options.map(row=>{
                const origin=(order.warehouseShipmentRecords||[]).find(s=>s.id===row.shipmentId);
                return `<option value="${escapeAttr(row.shipmentId)}">${escapeHtml(origin?.date||'')}／${escapeHtml(origin?.warehouseId||'')}／待確認 ${row.pendingQty}</option>`;
            }).join('');
            field.value=frozen?.shipmentId||(options.some(row=>row.shipmentId===old)?old:'');
            field.disabled=!!frozen;
        }catch(error){
            field.innerHTML='<option value="">無法核對來源出貨：'+escapeHtml(error.message)+'</option>';
            field.disabled=true;
        }
        const itemSelect=document.getElementById('deliveryItemId');
        if(itemSelect&&rawItems.length>1){
            if(frozen)itemSelect.value=frozen.itemId;
            itemSelect.disabled=!!frozen;
            itemSelect.onchange=()=>renderDeliveryModal();
        }
        if(frozen){
            document.getElementById('deliveryDate').value=frozen.date;
            document.getElementById('deliveryQty').value=frozen.quantity;
            document.getElementById('deliveryNotes').value=frozen.notes;
        }
    }else document.getElementById('deliveryShipmentSelection')?.remove();
    const tbody = document.getElementById('deliveryRecordsBody');
    const partialButton = document.getElementById('openPartialDeliveryBtn');
    if (partialButton) partialButton.style.display = editable && !locked && progress.remaining > 0 && physicalDeliveryItems.length ? '' : 'none';
    const records = savedDeliveryRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (records.length) {
        tbody.innerHTML = records.map(record => `<tr>
            <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td>
            <td>${record.itemId ? escapeHtml(deliveryItemNameById.get(record.itemId)||record.itemId)+'<br>' : ''}${escapeHtml(record.notes || '')}</td>
            <td>${escapeHtml(record.createdBy || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(record.createdAt))}</span></td>
            <td>${editable && !v2 ? `<details class="order-record-actions"><summary>操作</summary><button type="button" class="btn-small btn-secondary" onclick="editDeliveryRecord(${inlineJsValue(record.id)})">編輯</button> <button type="button" class="btn-danger" onclick="deleteDeliveryRecord(${inlineJsValue(record.id)})">更正誤登</button></details>` : editableSteps && (globalThis.YUSHIN_V2_DELIVERY_EMULATOR===true || (typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'&&globalThis.YUSHIN_PREVIEW_DELIVERY_REVERSAL===true)) && record.sourceType==='WAREHOUSE_SHIPMENT_CONFIRMATION' && !order.returnRecords?.length && !confirmation && !reversal ? `<button type="button" class="btn-danger" onclick="deleteDeliveryRecord(${inlineJsValue(record.id)})">撤銷送達確認</button>` : '僅可查看'}</td>
        </tr>`).join('');
    } else if (progress.isLegacyEstimated) {
        tbody.innerHTML = `<tr><td>${escapeHtml(order.orderDate || '')}<br><span class="delivery-estimated">歷史推估</span></td><td>${progress.total}</td><td>舊版已送貨資料</td><td>－</td><td>${editable ? '<button type="button" class="btn-secondary" onclick="clearLegacyDelivery()">取消此推估</button>' : '僅可查看'}</td></tr>`;
    } else {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#888;">尚無送貨紀錄。</td></tr>';
    }
    if(deliveryConfirmationProtectedMode()){
        if(pendingError)tbody.insertAdjacentHTML('beforeend',`<tr><td colspan="5">${escapeHtml(pendingError)}</td></tr>`);
        if(reversal)tbody.insertAdjacentHTML('beforeend',`<tr><td colspan="5">前次送達撤銷結果待確認。${editable&&!syncing?`<button type="button" class="btn-secondary" onclick="deleteDeliveryRecord(${inlineJsValue(reversal.deliveryRecordId)})">確認撤銷結果</button>`:''}</td></tr>`);
    }
    labelOrderProgressRecords('deliveryRecordsBody', ['送貨日期', '數量', '備註', '登錄人／時間', '操作']);
    document.getElementById('deliveryFormHint').innerText = progress.isLegacyEstimated
        ? '請先取消舊資料推估，再登錄正確的分批送貨紀錄。'
        : `目前最多還可登錄 ${progress.remaining} 個。`;
    if(v2&&(reversal||pendingError))document.getElementById('deliveryFormPanel').style.display='none';
    if(v2)
        document.getElementById('deliveryFormHint').innerText=pendingError||(reversal?'前次撤銷結果待確認，請點選確認撤銷結果。':confirmation
            ? '前次送達結果未確認：使用原出貨批次及原操作識別碼重試。'
            : '只確認客戶實際收到的數量；不會再次扣除倉庫實貨。');
    if(v2)for(const id of ['deliveryDate','deliveryQty','deliveryNotes'])
        document.getElementById(id).disabled=!!confirmation||!!reversal||!!pendingError||syncing;
}

window.editDeliveryRecord = function(recordId) {
    if(deliveryConfirmationProtectedMode()){alert('v2 送達紀錄不可直接編輯；請走送達更正流程。');return;}
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
    const itemId=deliveryConfirmationProtectedMode()
        ? (ordersCache.find(row=>row.id===orderId)?.items?.length===1
            ? ordersCache.find(row=>row.id===orderId).items[0].itemId
            : document.getElementById('deliveryItemId')?.value||'')
        : document.getElementById('deliveryItemId')?.value||'';
    const shipmentChoice=document.getElementById('deliveryShipmentId')?.value||'';
    const fingerprint=JSON.stringify([orderId,itemId,shipmentChoice,date,qty,notes]);
    if(!editId&&deliveryCreateAttempt?.fingerprint!==fingerprint)
        deliveryCreateAttempt={fingerprint,recordId:deliveryRecordId()};
    const frozen=deliveryConfirmationProtectedMode()?pendingV2DeliveryConfirmation(orderId):null;
    const recordId=frozen?.operationId||editId||deliveryCreateAttempt.recordId;
    const shipmentId=frozen?.shipmentId||document.getElementById('deliveryShipmentId')?.value||'';
    const saveButton = document.querySelector('[onclick="saveDeliveryRecord()"]');
    pendingDeliveryOrderIds.add(orderId);
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = '儲存中…'; }
    try {
        const custodyV3=globalThis.YUSHIN_V3_CUSTODY_DELIVERY_EMULATOR===true
            &&ordersCache.find(row=>row.id===orderId)?.items?.length===1
            &&!!ordersCache.find(row=>row.id===orderId)?.items?.[0]?.custodyTransferId;
        const savedOrder=await saveOrderDeliveryRecord(orderId,{date,qty,notes,editId,itemId,recordId,shipmentId,custodyV3});
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
        if(deliveryConfirmationProtectedMode()&&currentDeliveryOrderId===orderId)renderDeliveryModal();
    }
};

async function reverseV2DeliveryRecord(recordId){
    if(!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))return alert('此操作僅限訂單負責業務或管理員。');
    const orderId=currentDeliveryOrderId;
    if(!orderId||pendingDeliveryOrderIds.has(orderId))return;
    pendingDeliveryOrderIds.add(orderId);
    try{
        const pending=pendingV2DeliveryReversal(orderId);
        if(pending&&pending.deliveryRecordId!==recordId)throw Error('請先確認前次送達撤銷結果。');
        const reason=pending?.reason||prompt('撤銷客戶送達確認後，貨品仍維持已寄出，不會回補倉庫庫存。\n請填寫撤銷原因：');
        if(!reason?.trim())return;
        const saved=await reverseV2ShipmentDeliveryEmulator(orderId,recordId,{
            reason,date:pending?.date||localDateString(),operationId:pending?.operationId||deliveryRecordId()});
        const index=ordersCache.findIndex(row=>row.id===orderId);
        if(index>=0)ordersCache[index]={id:orderId,...saved};
        if(currentDeliveryOrderId===orderId){resetDeliveryForm();renderOrderLifecycleModal();}
    }catch(error){alert('送達撤銷尚未確認：'+error.message+'\n請使用原操作核對結果。');}
    finally{
        pendingDeliveryOrderIds.delete(orderId);
        if(currentDeliveryOrderId===orderId)renderDeliveryModal();
        renderOrdersList();
    }
}

window.deleteDeliveryRecord = async function(recordId) {
    if(globalThis.YUSHIN_V2_DELIVERY_EMULATOR===true
        ||(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'&&globalThis.YUSHIN_PREVIEW_DELIVERY_REVERSAL===true))
        return reverseV2DeliveryRecord(recordId);
    if(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview')return alert('Preview 送達撤銷尚未開放，禁止改用舊交易。');
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    const correctionReason = prompt('僅限更正誤登的送貨紀錄，會同步回補原出貨庫存並保留異動軌跡。實際已送出的貨請申請退貨。\n\n請輸入誤登更正原因：');
    if (!correctionReason || !correctionReason.trim()) return;
    const orderId = currentDeliveryOrderId;
    if (!orderId || pendingDeliveryOrderIds.has(orderId)) return;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    try {
        const savedOrder=await correctOrderDeliveryRecord(orderId,recordId,correctionReason);
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
    if(deliveryConfirmationProtectedMode())return alert('v2 送達不可使用歷史推估清除功能。');
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
    let pendingCancel=false;
    if(lifecycleProtectedMode()){try{pendingCancel=pendingV2OrderLifecycle(order.id)?.nextStatus==='cancelled';}catch(_){/* visible error rendered below */}}
    const cancelLabel = currentStatus === 'cancelled' ? '已取消'
        : progress.grossDelivered > 0 ? '取消剩餘未送貨數量' : '取消訂單';
    select.innerHTML = '<option value="normal">正常</option>'
        + (canCancel || currentStatus === 'cancelled' || pendingCancel ? `<option value="cancelled">${cancelLabel}</option>` : '');
    select.value = selected === 'cancelled' && (canCancel || currentStatus === 'cancelled' || pendingCancel) ? 'cancelled' : 'normal';
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
    const reorderButton=document.getElementById('reorderAfterReturnBtn');
    if(reorderButton)reorderButton.hidden=!editable||!savedReturnRecords(order).some(row=>row.settlement==='CLOSE'&&Number(row.qty)>0);
    document.getElementById('orderLifecycleActionHint').textContent = !canCancel && !cancelled ? '已無剩餘未送貨數量；退貨請建立申請，由倉庫頁確認實收。' : '取消僅處理未送貨數量；已送貨部分請申請退貨。';
    if(lifecycleProtectedMode()){
        let retry,error;
        try{retry=pendingV2OrderLifecycle(order.id);}catch(err){error=err.message;}
        if(retry||error){
            document.getElementById('orderLifecycleActionHint').textContent=error||'前次取消／恢復結果未確認；請以原操作核對，不會重新建立作業。';
            lifecycleButton.hidden=!editable||!!error;
            lifecycleButton.textContent='確認前次取消／恢復結果';
            document.getElementById('orderStatusEditPanel').style.display=editable&&orderLifecycleFormOpen&&!error?'':'none';
        }
        for(const [id,value] of [['orderLifecycleStatus',retry?.nextStatus],['orderLifecycleDate',retry?.date],['orderLifecycleReason',retry?.reason]]){
            const input=document.getElementById(id);
            input.disabled=!!retry||!!error;
            if(retry)input.value=value;
        }
        const save=document.getElementById('orderLifecycleSaveBtn');
        if(save){save.disabled=!editable||!!error||pendingLifecycleOrderIds.has(order.id);save.innerText=retry?'確認前次結果':'💾 儲存狀態';}
    }
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
    let retry;
    try{retry=lifecycleProtectedMode()?pendingV2OrderLifecycle(order.id):null;}catch(err){alert(err.message);return;}
    if (!retry&&previous.status === nextStatus && previous.date === date && previous.reason === reason) return;
    if (pendingLifecycleOrderIds.has(order.id)) return;
    if(!retry&&nextStatus==='cancelled'&&previous.status!=='cancelled'&&!confirmOrderCancellation(order))return;
    const saveButton = document.getElementById('orderLifecycleSaveBtn');
    pendingLifecycleOrderIds.add(order.id);
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    let committed=false;
    try {
        const savedOrder=await setOrderLifecycleStatus(order.id,nextStatus,{date,reason});
        committed=true;
        // The lifecycle transaction already synchronizes stock and purchase demand.
        applySavedOrderLifecycle(order.id,savedOrder);
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert((committed?'訂單狀態已確認，但畫面更新失敗；請重新讀取，勿重建作業：':'訂單狀態結果未確認：') + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingLifecycleOrderIds.delete(order.id);
        if (saveButton) { saveButton.disabled = false; saveButton.innerText = '💾 儲存狀態'; }
        if(lifecycleProtectedMode())renderOrderLifecycleModal();
    }
};

// Customer return mutations are owned by modules/customer-cancellations.js.

window.orderCommercialEditPending=new Set();
async function updateOrderCommercialField(orderId,field,value){
    if(!['transactionType','invoiceTitle','remarks'].includes(field)||typeof value!=='string')return;
    if(window.orderCommercialEditPending.has(orderId))return;
    const cached=ordersCache.find(order=>order.id===orderId);
    if(!cached||!globalThis.YushinOrderCommercialDetails.canEdit(cached)){alert('這筆訂單已到貨、進入交付流程，或目前帳號無法修改。');renderOrdersList();return;}
    if(field==='transactionType'&&!['直','借','扣'].includes(value)){alert('請選擇直、借或扣。');renderOrdersList();return;}
    const uid=currentUser?.uid,role=currentUserRole,prior=cached[field]??'';
    if(String(prior)===String(value??''))return;
    const history={field,label:{transactionType:'修改交易方式',invoiceTitle:'修改發票抬頭',remarks:'修改訂單備註'}[field],before:prior,after:value??'',by:currentUserName||currentUser?.email||'未知使用者',at:new Date().toISOString()};
    window.orderCommercialEditPending.add(orderId);renderOrdersList();
    try{
        const saved=await runRoleTransaction(async tx=>{
            const ref=db.collection('orders').doc(orderId),snapshot=await tx.get(ref);
            if(uid!==currentUser?.uid||role!==currentUserRole)throw Error('登入身分已變更，請重新開啟訂單。');
            if(!snapshot.exists)throw Error('找不到這筆訂單。');
            const order=snapshot.data();
            if((order[field]??'')===value)return order;
            if(!globalThis.YushinOrderCommercialDetails.canEdit(order))throw Object.assign(Error('訂單已到貨或進入交付流程，不能修改。'),{latestOrder:order});
            if((order[field]??'')!==prior)throw Object.assign(Error('這個欄位已被其他人修改，已更新為最新資料，請重新確認。'),{latestOrder:order});
            tx.update(ref,{[field]:value,fieldEditHistory:firebase.firestore.FieldValue.arrayUnion(history)});
            return {...order,[field]:value,fieldEditHistory:[...(order.fieldEditHistory||[]),history]};
        });
        if(uid===currentUser?.uid&&role===currentUserRole){cached[field]=saved[field];cached.fieldEditHistory=saved.fieldEditHistory||[];showActionFeedback('訂單資料已儲存。');}
    }catch(err){if(err.latestOrder&&uid===currentUser?.uid&&role===currentUserRole)Object.assign(cached,err.latestOrder);alert(productOperationErrorMessage('訂單資料更新',err));}
    finally{window.orderCommercialEditPending.delete(orderId);if(uid===currentUser?.uid&&role===currentUserRole)renderOrdersList();}
}

window.updateOrderField = function(orderId, field, value) {
    if(['transactionType','invoiceTitle','remarks'].includes(field))return updateOrderCommercialField(orderId,field,value);
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

