// Service billing keeps the original order visible until the server confirms.
async function toggleServiceOrderBilling(order,newValue){
    const key=order.id+':isBilled',pendingSet=pendingOrderStatusKeys;
    if(pendingSet.has(key))return;
    const uid=currentUser?.uid,role=currentUserRole,generation=sessionDataGeneration;
    const current=()=>uid===currentUser?.uid&&role===currentUserRole&&generation===sessionDataGeneration;
    let confirmed=false;
    try{
        const saved=pendingServiceBillingIntent();
        if(saved&&saved.intent.orderId!==order.id)throw Error('請先確認訂單 '+saved.intent.orderId+' 的前次服務核銷結果。');
        const intent=saved?.intent||{orderId:order.id,operationId:'service-bill-'+crypto.randomUUID(),
            isBilled:newValue,expectedIsBilled:order.isBilled===true,
            billingDate:newValue?(orderBillingDate(order)||localDateString()):''};
        pendingSet.add(key);renderOrdersList();
        const committed=await commitServiceBillingIntent(intent);
        if(!current())return;
        confirmed=true;
        const latest=ordersCache.find(o=>o.id===order.id);
        if(latest)Object.assign(latest,committed.order);
        pendingSet.delete(key);
        writeAppDataCache('orders',ordersCache);renderOrdersList();
        if(currentDeliveryOrderId===order.id){renderDeliveryModal();renderOrderLifecycleModal();}
    }catch(error){
        if(current()){
            pendingSet.delete(key);
            if(confirmed)alert('服務核銷已確認，畫面更新失敗，請重新載入：'+error.message);
            else alert('服務核銷尚未確認：'+error.message+' 若回覆不明，請再按原核銷按鈕確認前次結果。');
        }
    }finally{if(current())pendingSet.delete(key);}
}

window.toggleOrderStatus = function(orderId, field, newValue) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (field !== 'isBilled') {
        alert('訂貨、到貨與送貨狀態已由 V2 採購／入庫／打單流程自動管理。');
        return;
    }
    const o = ordersCache.find(x => x.id === orderId);
    if (!o || !canEditPage('orders.list')) return;
    if((o.items||[]).some(item=>String(item?.productType||'').trim().toUpperCase()==='SERVICE')) {
        return toggleServiceOrderBilling(o,newValue);
    }
    const pendingKey = `${orderId}:isBilled`;
    if (pendingOrderStatusKeys.has(pendingKey)) return;
    if (normalizedOrderStatus(o) !== 'normal') { alert('已取消的訂單不能更改進度。'); return; }

    const billingDate = newValue ? (orderBillingDate(o) || localDateString()) : '';
    const previousWorkFilter = activeOrderWorkFilter;
    const previous = {
        isBilled: o.isBilled,
        billingDate: o.billingDate || '',
        status: o.status,
        statusHistory: [...(o.statusHistory || [])]
    };
    const actor = currentUserName || currentUser?.email || '未知使用者';
    const timestamp = new Date().toISOString();
    const logEntry = { field:'isBilled', value:newValue, label:newValue ? '已核銷' : '取消已核銷', by:actor, at:timestamp };

    o.isBilled = newValue;
    o.billingDate = billingDate;
    if (!newValue && activeOrderWorkFilter === 'complete') activeOrderWorkFilter = 'billing';
    if (newValue && activeOrderWorkFilter === 'billing' && deliveryProgressInfo(o).state === 'complete') activeOrderWorkFilter = 'complete';
    o.statusHistory = [...previous.statusHistory, logEntry];
    pendingOrderStatusKeys.add(pendingKey);
    writeAppDataCache('orders', ordersCache);
    renderOrdersList();

    setOrderBillingStatus(orderId,newValue,billingDate,logEntry,timestamp).then(committed => {
        Object.assign(o, committed);
        pendingOrderStatusKeys.delete(pendingKey);
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    }).catch(err => {
        Object.assign(o, previous);
        pendingOrderStatusKeys.delete(pendingKey);
        activeOrderWorkFilter = previousWorkFilter;
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) {
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        alert('更新狀態失敗，已還原：' + err.message);
    });
};

window.updateOrderBillingDate = function(orderId, value) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order || !order.isBilled || !canEditPage('orders.list')) return;
    if((order.items||[]).some(item=>String(item?.productType||'').trim().toUpperCase()==='SERVICE')) {
        alert('服務核銷日期修改尚未開放。');renderOrdersList();return;
    }
    if (!isValidOrderBillingDate(value)) { alert('請選擇正確的核銷日期。'); renderOrdersList(); return; }
    const pendingKey=`${orderId}:billingDate`;
    if(pendingOrderStatusKeys.has(pendingKey))return;
    const previous = order.billingDate || '';
    if (previous === value) return;
    const previousHistory=[...(order.fieldEditHistory||[])];
    const history = {
        field: 'billingDate', label: '修改核銷日期', before: previous || orderBillingDate(order), after: value,
        by: currentUserName || currentUser?.email || '未知使用者', at: new Date().toISOString()
    };
    pendingOrderStatusKeys.add(pendingKey);
    order.billingDate = value;
    order.fieldEditHistory = [...previousHistory,history];
    writeAppDataCache('orders', ordersCache);
    renderOrdersList();
    changeOrderBillingDate(orderId,value,history).then(committed=>{
        Object.assign(order,committed);
        pendingOrderStatusKeys.delete(pendingKey);
        writeAppDataCache('orders',ordersCache);
        renderOrdersList();
    }).catch(err=>{
        if(order.billingDate===value){
            order.billingDate=previous;
            order.fieldEditHistory=previousHistory;
        }
        pendingOrderStatusKeys.delete(pendingKey);
        writeAppDataCache('orders',ordersCache);
        renderOrdersList();
        alert('更新核銷日期失敗，已還原：'+err.message);
    });
};

function formatOrderStatusTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

window.showCustomerOrderHistory = async function(customerName) {
    const customerKey = normalizeFullHistorySearchValue(customerName);
    if (!customerKey) return;
    const overlay = document.getElementById('customerOrderHistoryOverlay');
    const title = document.getElementById('customerOrderHistoryTitle');
    const summary = document.getElementById('customerTransactionSummary');
    const tbody = document.getElementById('customerOrderHistoryBody');
    const quoteTbody = document.getElementById('customerQuoteHistoryBody');
    if (title) title.innerText = `客戶近期交易摘要：${customerName}`;
    if (summary) summary.innerHTML = '<div class="customer-summary-card"><span>資料狀態</span><strong>讀取完整歷史中…</strong></div>';
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:#888;">讀取訂單歷史中…</td></tr>';
    if (quoteTbody) quoteTbody.innerHTML = '<tr><td colspan="6" style="color:#888;">讀取估價歷史中…</td></tr>';
    if (overlay) overlay.classList.add('active');

    try {
        const orderToken = fullHistoryQueryToken('order', customerName);
        const quoteToken = fullHistoryQueryToken('quote', customerName);
        const [orderSnap, quoteSnap] = await Promise.all([
            orderToken
                ? firestoreReadWithTimeout(scopedHistorySearchQuery('orders', orderToken).limit(DEFAULT_LIST_LIMIT).get(), '客戶訂單歷史')
                : Promise.resolve({ docs: [] }),
            quoteToken
                ? firestoreReadWithTimeout(scopedHistorySearchQuery('quotes', quoteToken).limit(DEFAULT_LIST_LIMIT).get(), '客戶估價歷史')
                : Promise.resolve({ docs: [] })
        ]);
        const exactCustomerKey = normalizeCustomerKey(customerName);
        const orders = (orderSnap.docs || [])
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(order => normalizeCustomerKey(order.customerName || order.customer || '') === exactCustomerKey)
            .sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')));
        const quotes = (quoteSnap.docs || [])
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(quote => [quote.ordererName, quote.clientName].some(value => normalizeCustomerKey(value) === exactCustomerKey))
            .sort((a, b) => String(b.quoteDate || b.quoteNo || '').localeCompare(String(a.quoteDate || a.quoteNo || '')));
        const quoteItems = quotes.flatMap(quote => (quote.items || []).map(item => ({ quote, item })))
            .sort((a, b) => String(b.quote.quoteDate || b.quote.quoteNo || '').localeCompare(String(a.quote.quoteDate || a.quote.quoteNo || '')));
        const recentDates = [...orders.map(order => order.orderDate), ...quotes.map(quote => quote.quoteDate)].filter(Boolean).sort().reverse();
        const latestOrder = orders[0];
        const latestQuoteItem = quoteItems[0];
        const latestPrice = latestOrder
            ? `NT$ ${Number(parseFloat(String(latestOrder.unitPrice ?? '').replace(/,/g, '')) || 0).toLocaleString()}`
            : latestQuoteItem ? `NT$ ${Number(parseFloat(String(latestQuoteItem.item.price ?? '').replace(/,/g, '')) || 0).toLocaleString()}` : '－';
        const latestProduct = latestOrder?.itemName || latestQuoteItem?.item?.nameCn || latestQuoteItem?.item?.nameEn || '－';
        if (summary) summary.innerHTML = `
            <div class="customer-summary-card"><span>最近交易日</span><strong>${escapeHtml(recentDates[0] || '－')}</strong></div>
            <div class="customer-summary-card"><span>最近購買／估價品項</span><strong>${escapeHtml(latestProduct)}</strong></div>
            <div class="customer-summary-card"><span>上次單價</span><strong>${escapeHtml(latestPrice)}</strong></div>
            <div class="customer-summary-card"><span>最近估價</span><strong>${escapeHtml(quotes[0] ? `${quotes[0].quoteNo || '－'}／${quotes[0].quoteDate || '－'}` : '－')}</strong></div>`;
        if (tbody) tbody.innerHTML = orders.length ? orders.slice(0, 20).map(order => `
            <tr><td>${escapeHtml(order.orderDate || '')}</td><td>${escapeHtml(order.brand || '')}</td><td>${escapeHtml(order.itemCode || '')}</td><td>${escapeHtml(order.itemName || '')}</td><td>${escapeHtml(String(order.qty || ''))}</td><td>${escapeHtml(String(order.totalPrice || ''))}</td><td>${deliveryProgressInfo(order).delivered>0 ? (deliveryProgressInfo(order).state==='complete'?'已送貨':'部分送貨') : fulfillmentProgressInfo(order).shippable>0 ? '可出貨' : fulfillmentProgressInfo(order).pendingDispatch>0 ? '待打單' : purchaseProgressInfo(order).label}</td></tr>
        `).join('') : '<tr><td colspan="7" style="color:#888;">目前沒有訂單紀錄。</td></tr>';
        if (quoteTbody) quoteTbody.innerHTML = quoteItems.length ? quoteItems.slice(0, 20).map(({ quote, item }) => `
            <tr><td>${escapeHtml(quote.quoteDate || '')}</td><td>${escapeHtml(quote.quoteNo || '')}</td><td>${escapeHtml(item.nameCn || item.nameEn || item.model || '')}</td><td>${escapeHtml(String(item.qty || ''))}</td><td>${escapeHtml(String(item.price || ''))}</td><td>${quote.dealClosed ? '已成交' : '估價中'}</td></tr>
        `).join('') : '<tr><td colspan="6" style="color:#888;">目前沒有估價紀錄。</td></tr>';
    } catch (err) {
        console.error('讀取客戶完整交易歷史失敗：', err);
        if (summary) summary.innerHTML = '<div class="customer-summary-card"><span>資料狀態</span><strong>讀取失敗</strong></div>';
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:#888;">無法讀取完整訂單歷史。</td></tr>';
        if (quoteTbody) quoteTbody.innerHTML = '<tr><td colspan="6" style="color:#888;">無法讀取完整估價歷史。</td></tr>';
    }
};

window.closeCustomerOrderHistory = function() {
    document.getElementById('customerOrderHistoryOverlay').classList.remove('active');
};

