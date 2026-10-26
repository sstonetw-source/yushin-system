// Shared order/purchase presentation; uses only the already loaded record.
function purchaseProductSummary(item, quantity, quantityLabel = '數量') {
    const name = item.itemName || item.name || item.itemCode || item.itemId || '未命名品項';
    const reference = [item.brand || item.brandName, item.itemCode ? '貨號 ' + item.itemCode : ''].filter(Boolean).join(' · ');
    return `<div class="workflow-product"><strong>${escapeHtml(name)}</strong><small class="purchase-item-description">${escapeHtml(reference)}</small>${quantityLabel===null?'':`<span class="workflow-quantity">${escapeHtml(quantityLabel)} ${Number(quantity || 0)}</span>`}</div>`;
}

// Shared record reference. No extra reads and no synthetic document numbers.
function workflowRecordSummary(record, date) {
    const number = record?.orderNo || record?.poNo || '';
    return `<div class="workflow-record">${number ? `<strong>${escapeHtml(number)}</strong>` : ''}<time>${escapeHtml(date || '—')}</time></div>`;
}

// Local work-queue filtering uses only the records already authorized and loaded.
function workflowLineMatchesSearch(record, item, query) {
    const keyword = String(query || '').trim().toLocaleLowerCase();
    if (!keyword) return true;
    return [record?.orderNo, record?.poNo, record?.customerName, record?.customer,
        record?.salesName, item?.itemName, item?.name, item?.itemCode,
        item?.brand, item?.brandName].filter(Boolean).join(' ').toLocaleLowerCase().includes(keyword);
}


// Native modal owns focus/Escape; all business controls keep their original handlers.
function bindOrderDetailDrawer(row) {
    const panel = row.querySelector('.order-detail-panel');
    const dialog = panel?.querySelector('.order-detail-drawer');
    if (!dialog) return;
    const trigger = panel.querySelector(':scope > summary');
    const close = () => { if (dialog.open) dialog.close(); panel.open = false; trigger.setAttribute('aria-expanded', 'false'); };
    panel.addEventListener('toggle', () => {
        trigger.setAttribute('aria-expanded', String(panel.open));
        if (panel.open && dialog.isConnected && !dialog.open) dialog.showModal();
        else if (!panel.open && dialog.open) dialog.close();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) { panel.open = false; trigger.setAttribute('aria-expanded', 'false'); } });
    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-order-drawer-close]')) close();
        // Existing delivery/history forms are outside this modal. Release modal focus first.
        else if (event.target.closest('button[onclick]')) close();
        else if (event.target === dialog) {
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
        }
    });
    if (panel.open && !dialog.open) dialog.showModal();
}

function organizeOrderRowActions(row, stage) {
    const area = row.querySelector('.order-compact-actions');
    if (!area) return;
    const buttons = [...area.querySelectorAll(':scope > button')];
    const preferred = {arrival:'openOrderDirectShipReceipt',ordering:'openSelfOrderModal',shipping:'Delivery',delivery:'Delivery',billing:'toggleOrderStatus'}[stage];
    const primary = preferred ? buttons.find(button => (button.getAttribute('onclick') || '').includes(preferred)) : null;
    buttons.forEach(button => {
        button.classList.toggle('btn-secondary', button !== primary);
        button.classList.toggle('order-primary-action', button === primary);
    });
}

// Presentation only: quantities use their actual work-stage definition.
function workflowQuantitySummary(quantity, label) {
    return `<span class="workflow-quantity">${escapeHtml(label)} ${escapeHtml(Number(quantity||0))}</span>`;
}
function workflowAmountSummary(item, quantity, options = {}) {
    const qty=Number(quantity||0),unit=Number(options.unit ?? item.unitPrice ?? 0);
    const total=options.total ?? Math.round((unit*qty+Number.EPSILON)*100)/100;
    const money=value=>escapeHtml(Number(value).toLocaleString('zh-TW',{maximumFractionDigits:2}));
    return `<div class="workflow-amount"><small>${escapeHtml(options.label||'單價')} NT$ ${money(unit)} × ${escapeHtml(qty)}</small><strong>${escapeHtml(options.totalLabel||'品項小計')} NT$ ${money(total)}</strong></div>`;
}

function workflowWorkCategoryLabel(category) {
    return {ordering:'待採購',arrival:'待到貨',dispatch:'待打單',shipping:'已打單',delivery:'待送達',billing:'待核銷',complete:'已完成',closed:'已結束'}[category] || category;
}

// Read-only commercial context from the authorized source order; never infer missing prices.
function workflowCommercialSummary(order) {
    if (!order) return '<span class="record-reference">來源訂單待同步</span>';
    return `<div class="workflow-commercial"><strong>交易方式：${escapeHtml(order.transactionType || '未填寫')}</strong><small>發票抬頭：${escapeHtml(order.invoiceTitle || '未填寫')}</small></div>`;
}
function workflowSalesAmount(order, item) {
    if (!order || item.unitPrice === null || item.unitPrice === undefined || String(item.unitPrice).trim()==='' || !Number.isFinite(Number(item.unitPrice))) return '<span class="record-reference">銷售金額待確認</span>';
    const qty=Number(item.orderedQty ?? item.qty);
    if (!Number.isFinite(qty)) return '<span class="record-reference">訂購數量待確認</span>';
    return workflowAmountSummary(item,qty,{label:'含稅單價',totalLabel:'品項小計（含稅）'});
}
function workflowPurchaseOrderDetails(order) {
    if (!order) return '';
    const field=(label,value)=>`<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value || '未填寫')}</dd></div>`;
    const items=normalizedOrderItems(order);
    return `<details class="order-detail-panel"><summary aria-haspopup="dialog" aria-expanded="false">明細</summary><dialog class="order-detail-drawer" aria-label="訂單明細"><header class="order-drawer-heading"><h3>訂單明細</h3><button type="button" class="btn-secondary" data-order-drawer-close autofocus>關閉</button></header><div class="order-detail-content"><section class="order-drawer-section"><h4>訂單摘要</h4><dl class="order-drawer-summary">${field('單號',order.orderNo)}${field('客戶',order.customerName||order.customer)}${field('負責業務',order.salesName)}${field('訂單日期',order.orderDate)}${field('訂單總額（含稅）',order.totalPrice==null?'待確認':'NT$ '+order.totalPrice)}</dl></section><section class="order-drawer-section"><h4>全部訂單品項</h4><div class="workflow-price-breakdown">${items.map(item=>`<div>${purchaseProductSummary(item,0,null)}${workflowSalesAmount(order,item)}<small>交付方式：${escapeHtml(globalThis.YushinOrderEntry?.deliveryLabel(item,order.shippingInstructions||{})||'未填寫')}</small></div>`).join('')}</div></section><section class="order-drawer-section"><h4>交易與備註</h4>${workflowCommercialSummary(order)}<dl class="order-drawer-summary">${field('訂單備註',order.remarks)}</dl></section><section class="order-drawer-section"><button type="button" class="btn-secondary" onclick="openOrderStatusHistory(${inlineJsValue(order.id)})">查看操作紀錄</button></section></div></dialog></details>`;
}
// Keep stage-specific action handlers and quantities; only reorganize the presentation.
function organizePurchasingOrderRow(row, order, item) {
    row.classList.add('workflow-order-context-row');
    const cells=[...row.children],find=label=>cells.find(cell=>cell.dataset.th===label);
    const product=cells.find(cell=>/品項$/.test(cell.dataset.th||''));
    if (!product) return;
    product.dataset.th='產品資訊';
    const date=find('需求日期');if(date) date.dataset.th='訂單日期';
    const customer=find('客戶／用途');if(customer) customer.dataset.th='客戶';
    const quantity=find('數量'),progress=find('到貨進度');
    if (progress) { progress.dataset.th='進度'; quantity?.remove(); }
    else if (quantity) quantity.dataset.th='進度';
    const money=document.createElement('td');money.dataset.th='銷售金額';money.className='order-money-cell';money.innerHTML=workflowSalesAmount(order,item);
    const commercial=document.createElement('td');commercial.dataset.th='交易／開票資料';commercial.innerHTML=workflowCommercialSummary(order);
    const actions=find('操作');
    const area=actions?.querySelector('.workflow-inline-actions')||actions;
    if (order&&area) area.insertAdjacentHTML('afterbegin',workflowPurchaseOrderDetails(order));
    [find('合併'),find('訂單日期')||find('需求日期'),find('客戶')||find('客戶／用途'),product,find('負責業務'),money,commercial,progress||quantity,actions].filter(Boolean).forEach(cell=>row.appendChild(cell));
    row.closest('table')?.classList.add('workflow-order-context-table');
    bindOrderDetailDrawer(row);
}
