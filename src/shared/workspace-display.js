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
        item?.brand, item?.brandName, item?.purchaseDocumentNo, item?.supplier, item?.supplierName].filter(Boolean).join(' ').toLocaleLowerCase().includes(keyword);
}


// Native modal owns focus/Escape; all business controls keep their original handlers.
function bindOrderDetailDrawer(row) {
    const panel = row.querySelector('.order-detail-panel');
    const dialog = panel?.querySelector('.order-detail-drawer');
    if (!dialog) return;
    row.classList.add('workflow-detail-row');
    row.tabIndex = 0;
    row.setAttribute('aria-haspopup', 'dialog');
    row.setAttribute('aria-label', [row.dataset.menuTitle, '開啟訂單明細'].filter(Boolean).join(' · '));
    const open = () => {
        if (!dialog.isConnected || dialog.open) return;
        panel.open = true;
        dialog.showModal();
    };
    const close = () => { if (dialog.open) dialog.close(); panel.open = false; };
    row.addEventListener('click', event => {
        if (event.defaultPrevented || event.target.closest('button, a, label, input, select, textarea, summary, details, dialog, [contenteditable], [role="button"]')) return;
        open();
    });
    row.addEventListener('keydown', event => {
        if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
        event.preventDefault();
        if (!event.repeat) open();
    });
    dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) panel.open = false; });
    dialog.addEventListener('click', event => {
        if (event.target.closest('[data-order-drawer-close]')) close();
        // Existing delivery/history forms are outside this modal. Release modal focus first.
        else if (event.target.closest('button[onclick]')) close();
        else if (event.target === dialog) {
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
        }
    });
    if (panel.open) open();
}

function organizeOrderRowActions(row, stage) {
    const area = row.querySelector('.order-compact-actions');
    if (!area) return;
    const buttons = [...area.querySelectorAll(':scope > button')];
    const preferred = {arrival:'openOrderDirectShipReceipt',ordering:'openSelfOrderModal',shipping:'Delivery',delivery:'Delivery',billing:'toggleOrderStatus'}[stage];
    const serviceAction={dispatch:'PREPARE',shipping:'DELIVER'}[stage];
    const primary = buttons.find(button=>serviceAction&&button.dataset.serviceAction===serviceAction)
        || (preferred ? buttons.find(button => (button.getAttribute('onclick') || '').includes(preferred)) : null);
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
    return `<div class="workflow-amount">NT$ ${money(unit)} × ${escapeHtml(qty)}＝<strong>NT$ ${money(total)}</strong></div>`;
}

function workflowWorkCategoryLabel(category) {
    return {ordering:'待採購',arrival:'待到貨',dispatch:'待打單',shipping:'待送貨',delivery:'待送達',billing:'待核銷',complete:'已完成',closed:'已結束'}[category] || category;
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
    return `<details class="order-detail-panel"><summary hidden></summary><dialog class="order-detail-drawer" aria-label="訂單明細"><header class="order-drawer-heading"><h3>訂單明細</h3><button type="button" class="btn-secondary" data-order-drawer-close autofocus>關閉</button></header><div class="order-detail-content"><section class="order-drawer-section"><h4>訂單摘要</h4><dl class="order-drawer-summary">${field('客戶',order.customerName||order.customer)}${field('負責業務',order.salesName)}${field('訂單日期',order.orderDate)}${field('訂單總額（含稅）',order.totalPrice==null?'待確認':'NT$ '+order.totalPrice)}</dl></section><section class="order-drawer-section"><h4>全部訂單品項</h4><div class="workflow-price-breakdown">${items.map(item=>`<div>${purchaseProductSummary(item,0,null)}${workflowSalesAmount(order,item)}<small>交付方式：${escapeHtml(globalThis.YushinOrderEntry?.deliveryLabel(item,order.shippingInstructions||{})||'未填寫')}</small></div>`).join('')}</div></section><section class="order-drawer-section"><h4>交易與備註</h4>${workflowCommercialSummary(order)}<dl class="order-drawer-summary">${field('訂單備註',order.remarks)}</dl></section><section class="order-drawer-section"><button type="button" class="btn-secondary" onclick="openOrderStatusHistory(${inlineJsValue(order.id)})">查看操作紀錄</button></section></div></dialog></details>`;
}
// Keep stage-specific action handlers and quantities; only reorganize the presentation.
function organizePurchasingOrderRow(row, order, item, finance) {
    row.classList.add('workflow-order-context-row');
    row.dataset.menuTitle=[order?.customerName,order?.orderNo,order?.orderDate].filter(Boolean).join(' · ');
    row.dataset.menuScope='整張訂單操作';
    const cells=[...row.children],find=label=>cells.find(cell=>cell.dataset.th===label);
    const product=cells.find(cell=>/品項$/.test(cell.dataset.th||''));
    if (!product) return;
    product.dataset.th='產品資訊';
    const date=find('需求日期');if(date) date.dataset.th='訂單日期';
    const customer=find('客戶／用途')||find('客戶');if(customer) customer.dataset.th='客戶名稱';
    const quantity=find('數量'),progress=find('到貨進度');
    if (progress) { progress.dataset.th='進度'; quantity?.remove(); }
    else if (quantity) quantity.dataset.th='進度';
    const money=document.createElement('td');money.dataset.th='金額（含稅）';money.className='order-money-cell';
    renderPurchaseWorkAmount(money, order, item, finance);
    const commercial=document.createElement('td');commercial.dataset.th='交易方式';commercial.textContent=order?.transactionType || '—';
    const actions=find('操作');
    const area=actions?.querySelector('.workflow-inline-actions')||actions;
    area?.classList.add('workflow-inline-actions');
    if (order&&area) area.insertAdjacentHTML('afterbegin',workflowPurchaseOrderDetails(order));
    [find('訂單日期')||find('需求日期'),customer,product,find('負責業務'),money,commercial,progress||quantity,actions].filter(Boolean).forEach(cell=>row.appendChild(cell));
    bindOrderDetailDrawer(row);
}

// Compact stock list, with complete warehouse/lot evidence retained in a modal.
window.organizeInventoryList=function(body,chosenWarehouse){
 const table=body.closest('table');if(table?.tHead)table.tHead.rows[0].innerHTML='<th>產品資訊</th><th>倉庫</th><th>現有庫存</th><th>已預留</th><th>可用庫存</th><th>在途</th><th>操作</th>';
 for(const row of body.children){
  const cells=[...row.children];if(cells.length!==13)continue;
  const title=[cells[1].querySelector('strong')?.textContent,cells[0].textContent].filter(Boolean).join(' · ');
  row.dataset.menuTitle=title+' · '+(chosenWarehouse?(document.getElementById('inventoryWarehouseFilter')?.selectedOptions[0]?.textContent||'所選倉庫'):'全部倉庫合計');row.dataset.menuScope='庫存品項操作';
  const details=document.createElement('dialog');details.className='order-detail-drawer inventory-detail-dialog';details.setAttribute('aria-label','庫存明細');
  details.innerHTML=`<header class="order-drawer-heading"><h3>庫存明細</h3><button type="button" class="btn-secondary" onclick="this.closest('dialog').close()">關閉</button></header><div class="order-detail-content"><section class="order-drawer-section"><h4>${escapeHtml(title)}</h4><dl class="order-drawer-summary"></dl></section></div>`;
  const list=details.querySelector('dl');for(const cell of cells.slice(3,12)){const group=document.createElement('div'),term=document.createElement('dt'),value=document.createElement('dd');term.textContent=cell.dataset.th;while(cell.firstChild)value.append(cell.firstChild);group.append(term,value);list.append(group);}
  // Restore metrics to visible cells while originals remain in the evidence drawer.
  for(const index of [4,5,6,9])cells[index].innerHTML=list.children[index-3].querySelector('dd').innerHTML;
  const product=cells[1];product.dataset.th='產品資訊';product.querySelectorAll('.inventory-mobile-summary,.inventory-mobile-brand').forEach(el=>el.remove());product.insertAdjacentHTML('beforeend',`<small>${escapeHtml(cells[2].textContent)} · 貨號 ${escapeHtml(cells[0].textContent)}</small>`);
  const warehouse=document.createElement('td');warehouse.dataset.th='倉庫';warehouse.textContent=chosenWarehouse?(document.getElementById('inventoryWarehouseFilter')?.selectedOptions[0]?.textContent||'所選倉庫'):'全部倉庫合計';
  const actions=cells[12],area=actions.querySelector('.inventory-row-actions');
  if(area){const more=document.createElement('details');more.className='inventory-more-menu';more.innerHTML='<summary>更多</summary><div class="inventory-more-menu-popover"></div>';for(const control of [...area.children])if(!control.classList.contains('inventory-details-toggle'))more.lastElementChild.append(control);if(more.lastElementChild.children.length)area.append(more);area.append(details);}
  if(row.dataset.warehousePending==='true'){for(const i of [4,5,6,9]){cells[i].textContent='待確認';list.children[i-3].querySelector('dd').textContent='待確認';}warehouse.append('（資料待確認）');}
  row.replaceChildren(product,warehouse,cells[4],cells[5],cells[6],cells[9],actions);row.classList.add('inventory-compact-row');
 }
};

// Amount projections share the purchase document tax and rounding rules.
function purchaseWorkMoney(value) {
    return 'NT$ ' + value.toLocaleString('zh-TW', {maximumFractionDigits:2});
}

function purchaseSupplyCost(supply, qty) {
    const value = supply.unitCost;
    if (!(qty > 0) || value == null || String(value).trim() === '' || !Number.isFinite(Number(value)) || Number(value) < 0) return null;
    return globalThis.YushinSupplier.purchaseAmountMetadata([{qty, unitPrice:Number(value)}]).totalIncTax;
}

function purchaseWorkAmounts(order, item, {qty, supplies = [], estimate = false, stock = false, service = false, incomplete = false}) {
    const rawItem = order?.items?.find((row, index) => String(row.itemId || `item-${index + 1}`) === item.itemId);
    const price = String((rawItem ? rawItem.unitPrice : item.unitPrice) ?? '').replace(/,/g,'').trim();
    const sales = !stock && order && qty > 0 && price !== '' && Number.isFinite(Number(price))
        ? Math.round((Number(price) * qty + Number.EPSILON) * 100) / 100 : null;
    const costs = supplies.map(supply => purchaseSupplyCost(supply, supply.qty));
    const cost = !incomplete && costs.length && costs.every(value => value !== null)
        ? costs.reduce((total, value) => total + value, 0) : null;
    const ratio = sales > 0 && cost !== null ? cost / sales * 100 : null;
    return {sales, cost, ratio, estimate, stock, service};
}

function purchaseWorkAmountMarkup(amounts, showCost, loading = false) {
    const {sales, cost, ratio, estimate, stock, service} = amounts;
    const salesText = stock ? '—' : sales === null ? '待確認' : purchaseWorkMoney(sales);
    const costText = loading ? '讀取中…' : service ? '—' : cost === null ? '成本待確認' : purchaseWorkMoney(cost);
    const ratioText = stock || service || sales === 0 ? '—'
        : loading ? '讀取中…' : ratio === null ? '待確認' : ratio.toLocaleString('zh-TW', {maximumFractionDigits:2}) + '%';
    return `<div class="workflow-amount purchase-work-amount"><strong>銷售金額：${salesText}</strong>${showCost
        ? `<span>${estimate ? '預估' : ''}採購成本：${costText}</span><span>${estimate ? '預估' : ''}成本率：${ratioText}</span>` : ''}</div>`;
}

function purchaseHistoryFinancialSummary(po,item,quantity){
    if(!['purchaser','admin'].includes(currentUserRole))return '';
    const order=item.orderId?receivingSourceOrderForItem(item):null;
    const salesItem=order?normalizedOrderItems(order).find(row=>row.itemId===item.itemId):null;
    const {cost,sales,ratio}=purchaseWorkAmounts(order,salesItem||{},{
        qty:quantity, supplies:[{qty:quantity,unitCost:item.unitPrice}], stock:!item.orderId
    });
    return `<details class="purchase-financial-details"><summary>採購成本（含稅）：${cost===null?'待確認':purchaseWorkMoney(cost)}</summary><small>比較數量：${escapeHtml(quantity)}（採購數量）</small><small>銷售金額（含稅）：${sales===null?'—':purchaseWorkMoney(sales)}</small><small>成本率：${ratio===null?'—':ratio.toLocaleString('zh-TW',{maximumFractionDigits:2})+'%'}</small></details>`;
}
