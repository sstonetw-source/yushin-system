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
