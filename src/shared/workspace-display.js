// Shared order/purchase presentation; uses only the already loaded record.
function purchaseProductSummary(item, quantity, quantityLabel = '數量') {
    const name = item.itemName || item.name || item.itemCode || item.itemId || '未命名品項';
    const reference = [item.brand || item.brandName, item.itemCode ? '貨號 ' + item.itemCode : ''].filter(Boolean).join(' · ');
    return `<div class="workflow-product"><strong>${escapeHtml(name)}</strong><small class="purchase-item-description">${escapeHtml(reference)}</small><span class="workflow-quantity">${escapeHtml(quantityLabel)} ${Number(quantity || 0)}</span></div>`;
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

