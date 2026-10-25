function populateOrderOwnerSelect() {
    const wrap = document.getElementById('orderOwnerWrap');
    const select = document.getElementById('orderOwnerUid');
    if (!wrap || !select) return;
    wrap.style.display = currentUserRole === 'purchaser' ? '' : 'none';
    if (currentUserRole !== 'purchaser') return;
    const salespeople = salesList.filter(isSelectableCommercialOwner);
    select.replaceChildren(new Option('請選擇負責業務', ''));
    salespeople.forEach(person => select.add(new Option(`${person.name}（${person.code}・${ROLE_LABELS[person.role]}）`, person.uid)));
    select.value = salespeople.some(person => person.uid === requestedOrderOwnerUid) ? requestedOrderOwnerUid : '';
}

function orderDraftStorageKey() {
    return `${ORDER_DRAFT_STORAGE_PREFIX}:${currentUser?.uid || 'anonymous'}`;
}

function pendingOrderCreateKey() {
    return `${orderDraftStorageKey()}:pending_order_id`;
}

async function createOrResumeNewOrder(data) {
    const key=pendingOrderCreateKey();
    const forecast=window._orderModalForecastContext;
    const legacyForecastKey=forecast?`${orderDraftStorageKey()}:forecast:${forecast.id}:pending_order_id`:'';
    let orderId=localStorage.getItem(key)|| (legacyForecastKey&&localStorage.getItem(legacyForecastKey));
    if(!orderId){
        orderId=db.collection('orders').doc().id;
        // 記下編號後才寫入雲端；斷線後重試仍會指向同一張訂單。
        localStorage.setItem(key,orderId);
    }
    localStorage.setItem(key,orderId);
    const linkForecast=!!forecast&&data.sourceType===DOCUMENT_TYPES.FORECAST&&data.sourceId===forecast.id;
    if(linkForecast)data.sourceDocumentSyncStatus='completed';
    return commitOrderCreation(orderId,data,{actorUid:currentUser?.uid,actorRole:currentUserRole,
        linkForecast,expectedForecastUpdatedAt:linkForecast?forecast.updatedAt||'':''}).then(committed=>{
            if(legacyForecastKey&&localStorage.getItem(legacyForecastKey)===committed.id)localStorage.removeItem(legacyForecastKey);
            return committed;
        });
}

function orderDraftFieldValue(id) {
    return document.getElementById(id)?.value ?? '';
}

function collectOrderDraft() {
    return {
        savedAt:new Date().toISOString(),
        ownerUid:orderDraftFieldValue('orderOwnerUid'),
        date:orderDraftFieldValue('orderDateInput'),customerName:orderDraftFieldValue('orderCustomer'),
        itemCode:orderDraftFieldValue('orderItemCode'),itemName:orderDraftFieldValue('orderItemName'),itemNameEn:orderDraftFieldValue('orderItemNameEn'),productLine:orderDraftFieldValue('orderProductLine'),spec:orderDraftFieldValue('orderSpec'),
        brand:getBrandFieldValue('orderBrand','orderBrandOther'),qty:orderDraftFieldValue('orderQty'),
        supplier:orderDraftFieldValue('orderSelfSupplier'),unitPrice:orderDraftFieldValue('orderUnitPrice'),costPrice:orderDraftFieldValue('orderCostPrice'),
        procurementType:orderDraftFieldValue('orderProcurementType')||'PURCHASING_PO',
        selfOrderConfirmed:orderDraftFieldValue('orderSelfOrderConfirmed')==='confirmed',remarks:orderDraftFieldValue('orderRemarks'),
        fulfillmentType:orderDraftFieldValue('orderFulfillmentType')||'WAREHOUSE',warehouseId:orderDraftFieldValue('orderWarehouse'),
        transactionType:orderDraftFieldValue('orderTransactionType'),invoiceTitle:orderDraftFieldValue('orderInvoiceTitle'),
        productId:window._orderModalProductId||'',items:newOrderDraftItems,
        shippingInstructions:window.orderShippingInstructions?.()||{},
        sourceLink:window._orderModalSourceLink||null,
        quoteContext:window._orderModalQuoteContext||null,
        forecastContext:window._orderModalForecastContext||null,
        returnReorderSource:window._orderModalReturnReorder||null
    };
}

function readOrderDraft() {
    try {
        const value=JSON.parse(localStorage.getItem(orderDraftStorageKey())||'null');
        return value&&typeof value==='object'?value:null;
    } catch (_) { return null; }
}

function saveOrderDraft() {
    if(restoringOrderDraft||!document.getElementById('orderModalOverlay')?.classList.contains('active'))return;
    try { localStorage.setItem(orderDraftStorageKey(),JSON.stringify(collectOrderDraft())); }
    catch (err) { console.warn('保存訂單重試資料失敗：',err); }
}

function clearSavedOrderDraft(options={}) {
    localStorage.removeItem(orderDraftStorageKey());
    if(options.clearPending) localStorage.removeItem(pendingOrderCreateKey());
}

function setOrderModalItem(item={}) {
    const normalized=normalizeNewOrderItem(item);
    document.getElementById('orderItemCode').value=normalized.itemCode||'';
    document.getElementById('orderItemName').value=normalized.itemName||'';
    const nameEn=document.getElementById('orderItemNameEn');if(nameEn)nameEn.value=normalized.itemNameEn||'';
    const spec=document.getElementById('orderSpec');if(spec)spec.value=normalized.spec||'';
    const productLineField=document.getElementById('orderProductLine');if(productLineField)productLineField.value=normalized.productLine||'';
    const codeInput=document.getElementById('orderItemCode');
    codeInput.dataset.productLine=normalized.productLine||'';
    codeInput.dataset.productType=normalized.productType||'';
    codeInput.dataset.serviceKind=normalized.serviceKind||'';
    codeInput.dataset.productMasterMatched=normalized.productMasterMatched===true?'1':'0';
    delete codeInput.dataset.autofillBrand;
    codeInput.dataset.matchedProductCode=normalizeItemCodeLoose(normalized.itemCode);
    codeInput.dataset.preserveOrderPriceCode=normalizeItemCodeLoose(normalized.itemCode);
    codeInput.dataset.productCheckStatus=normalized.productCheckStatus||'';
    if(normalized.brand)selectBrandInDropdown(document.getElementById('orderBrand'),normalized.brand);
    else document.getElementById('orderBrand').value='';
    onOrderBrandSelectChange();
    if (normalized.productId) codeInput.dataset.autofillBrand=normalizeBrandLookupKey(resolveBrandName(normalized.brand||''));
    document.getElementById('orderQty').value=normalized.qty||1;
    document.getElementById('orderUnitPrice').value=normalized.unitPrice??'';
    document.getElementById('orderTotalPrice').value=normalized.totalPrice||0;
    const supplierInput=document.getElementById('orderSelfSupplier');if(supplierInput)supplierInput.value=normalized.supplier||'';
    document.getElementById('orderCostPrice').value=normalized.costPrice??'';
    const procurement=document.getElementById('orderProcurementType');if(procurement)procurement.value=normalized.procurementType||'PURCHASING_PO';
    const confirmed=document.getElementById('orderSelfOrderConfirmed');if(confirmed)confirmed.value=normalized.selfOrderConfirmed===true?'confirmed':'pending';
    onOrderProcurementTypeChange();
    if(normalized.procurementType==='SALES_SELF_ORDER')document.getElementById('orderCostPrice').value=normalized.costPrice??'';
    document.getElementById('orderFulfillmentType').value=normalized.fulfillmentType||'WAREHOUSE';
    populateOrderWarehouseOptions(normalized.warehouseId||'');
    onOrderFulfillmentChange();
    if(normalized.deliveryPlan)window.setOrderShippingInstructions?.(normalized.deliveryPlan);
    window.syncOrderEntrySelfStatus?.();
    window._orderModalProductId=normalized.productId||'';
    onOrderItemCodeChange(codeInput);
    refreshOrderWarehouseStock();
}

function restoreSavedOrderDraft(){
    const draft=readOrderDraft();if(!draft)return;
    restoringOrderDraft=true;
    try {
        requestedOrderOwnerUid = draft.ownerUid || '';
        window._orderModalSourceLink = draft.sourceLink || null;
        window._orderModalReturnReorder = draft.returnReorderSource || null;
        window._orderModalQuoteContext = draft.quoteContext || null;
        window._orderModalForecastContext = draft.forecastContext || null;
        populateOrderOwnerSelect();
        document.getElementById('orderDateInput').value=draft.date||'';
        document.getElementById('orderCustomer').value=draft.customerName||'';
        const remarks=document.getElementById('orderRemarks');if(remarks)remarks.value=draft.remarks||'';
        setOrderModalItem(draft);
        window.setOrderShippingInstructions?.(draft.shippingInstructions||{});
        document.getElementById('orderTransactionType').value=draft.transactionType||'';
        const invoice=document.getElementById('orderInvoiceTitle');invoice.value=draft.invoiceTitle||'';invoice.disabled=draft.transactionType!=='直';
        newOrderDraftItems=Array.isArray(draft.items)?draft.items.map(normalizeNewOrderItem):[];
        renderNewOrderDraftItems();
        checkNewOrderDraftProducts();
        const title=document.getElementById('orderModalTitle');if(title)title.innerText='新增訂單（續傳未完成）';
    } finally { restoringOrderDraft=false; }
}

function updateOrderDraftRecoveryBanner(source = null) {
    const banner = document.getElementById('orderDraftRecoveryBanner');
    const message = document.getElementById('orderDraftRecoveryMessage');
    if (!banner) return;
    const pendingId = localStorage.getItem(pendingOrderCreateKey());
    const draft = pendingId ? readOrderDraft() : null;
    const shouldShow = !source && !!pendingId && !!draft;
    banner.style.display = shouldShow ? '' : 'none';
    if (!shouldShow || !message) return;
    const savedAt = draft.savedAt ? new Date(draft.savedAt) : null;
    const timeText = savedAt && !Number.isNaN(savedAt.getTime())
        ? savedAt.toLocaleString('zh-TW', { hour12:false })
        : '';
    message.textContent = timeText
        ? `發現上次儲存未完成的訂單（${timeText}）。為避免重複下單，請先恢復確認或放棄這次重試。`
        : '發現上次儲存未完成的訂單。為避免重複下單，請先恢復確認或放棄這次重試。';
}

window.restoreSavedOrderDraftFromBanner = function() {
    populateOrderBrandDropdown();
    populateOrderOwnerSelect();
    restoreSavedOrderDraft();
    const banner = document.getElementById('orderDraftRecoveryBanner');
    if (banner) banner.style.display = 'none';
    const draft = readOrderDraft();
    loadWarehouseMaster().then(() => {
        populateOrderWarehouseOptions(draft?.warehouseId || '');
        refreshOrderWarehouseStock();
    }).catch(err => console.warn('恢復訂單草稿時讀取倉庫失敗：', err));
};

window.discardSavedOrderDraftFromBanner = async function() {
    const button = document.getElementById('discardOrderDraftBtn');
    const pendingId = localStorage.getItem(pendingOrderCreateKey());
    if (button) {
        button.disabled = true;
        button.textContent = '確認中…';
    }
    try {
        if (pendingId) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('orders').doc(pendingId).get(),
                '確認未完成訂單'
            );
            if (snapshot.exists) {
                alert('這筆訂單已經存在雲端，為避免重複下單，系統不會直接清除續傳資料。請先回訂單列表確認該筆訂單。');
                return;
            }
        }
        clearSavedOrderDraft({ clearPending:true });
        updateOrderDraftRecoveryBanner();
        showActionFeedback('未完成訂單重試資料已清除。');
    } catch (err) {
        alert('目前無法確認未完成訂單狀態，為避免資料重複，暫不清除：' + (err?.message || err));
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = '放棄這次重試';
        }
    }
};

function normalizeNewOrderItem(item = {}) {
    const match=findPriceItemForOrder(item);
    const qty=Math.max(0,Number(item.qty||0));
    const unitPrice=item.unitPrice===null || item.unitPrice===undefined || String(item.unitPrice).trim()==='' ? null : Number(item.unitPrice);
    const productId=String(item.productId||match?.productId||'').trim();
    const productType=match?.productType||item.productType||'';
    // Service kind is a snapshot only; the Service writer rechecks live Product Master.
    const serviceKind=String(productType).trim().toUpperCase()==='SERVICE'
        ? (match?.serviceKind||item.serviceKind||'') : '';
    const brand=resolveBrandName(match?.brand||item.brand||'');
    return {
        ...item,itemId:item.itemId||`item-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        itemCode:String(item.itemCode||'').trim(),itemCodeKey:normalizeHistoryItemCode(item.itemCode||''),itemName:String(item.itemName||'').trim(),
        brand,brandId:match?.brandId||item.brandId||brandIdForName(brand),qty,orderedQty:qty,unitPrice,totalPrice:qty*unitPrice,
        productId,productLine:match?.productLine||item.productLine||'',productType,serviceKind,
        productMasterMatched:!!productId && (!!match || item.productMasterMatched === true),
        supplier:item.supplier||match?.supplier||'',spec:match?.spec||item.spec||'',
        procurementType:item.procurementType||'PURCHASING_PO', fulfillmentType:item.fulfillmentType||'WAREHOUSE',
        warehouseId:(item.fulfillmentType||'WAREHOUSE')==='WAREHOUSE' && String(productType).trim().toUpperCase()!=='SERVICE' ? String(item.warehouseId||'') : ''
    };
}

function currentOrderModalItem() {
    const codeInput=document.getElementById('orderItemCode');
    const item={supplier:document.getElementById('orderSelfSupplier')?.value.trim()||'',itemCode:codeInput.value,itemName:document.getElementById('orderItemName').value,itemNameEn:document.getElementById('orderItemNameEn')?.value||'',productLine:codeInput.dataset.productLine||document.getElementById('orderProductLine')?.value||'',productType:codeInput.dataset.productType||'',serviceKind:codeInput.dataset.serviceKind||'',productMasterMatched:codeInput.dataset.productMasterMatched==='1',productCheckStatus:codeInput.dataset.productCheckStatus||'',spec:document.getElementById('orderSpec')?.value||'',brand:getBrandFieldValue('orderBrand','orderBrandOther'),qty:document.getElementById('orderQty').value,unitPrice:document.getElementById('orderUnitPrice').value,procurementType:document.getElementById('orderProcurementType')?.value||'PURCHASING_PO',fulfillmentType:document.getElementById('orderFulfillmentType')?.value||'WAREHOUSE',warehouseId:document.getElementById('orderWarehouse')?.value||'',productId:window._orderModalProductId||''};
    item.selfOrderConfirmed=document.getElementById('orderSelfOrderConfirmed')?.value==='confirmed';
    item.deliveryPlan=window.orderShippingInstructions?.()||{};
    item.deliveryCustomerName=document.getElementById('orderCustomer')?.value.trim()||'';
    const cost=document.getElementById('orderCostPrice').value;if(item.procurementType==='SALES_SELF_ORDER'&&cost!=='')item.costPrice=Number(cost);
    return normalizeNewOrderItem(item);
}

function orderItemProductStatus(item) {
    if (['checking','error','ambiguous','missing'].includes(item.productCheckStatus)) return item.productCheckStatus;
    return item.productMasterMatched && item.productId ? 'matched' : 'missing';
}
function orderItemProductStatusLabel(item) {
    return {checking:'檢查中…',error:'查詢失敗',ambiguous:'待選擇產品',missing:'未建檔',matched:'已建檔'}[orderItemProductStatus(item)];
}
function renderNewOrderDraftItems(){
    const body=document.getElementById('newOrderItemsBody'),wrap=document.getElementById('newOrderItemsWrap');if(!body||!wrap)return;
    const current=currentOrderModalItem();
    window.refreshOrderEntrySummary?.();
    const currentStatus=document.getElementById('orderProductCheckStatus');
    if(currentStatus) {
        const status=orderItemProductStatus(current);
        currentStatus.innerHTML=current.itemCode ? `<span>${orderItemProductStatusLabel(current)}</span>${status==='error'?`<button type="button" class="btn-small btn-secondary" onclick="onOrderItemCodeChange(document.getElementById('orderItemCode'))">重試</button>`:''}` : '';
    }
    const summary=document.getElementById('orderProductCheckSummary');
    const items=[...newOrderDraftItems,...(current.itemName?[current]:[])];
    const unfinished=items.filter(item=>orderItemProductStatus(item)!=='matched').length;
    if(summary) summary.textContent=items.length ? `共 ${items.length} 個品項，${unfinished ? `${unfinished} 個尚待完成產品檢查或建檔` : '全部已建檔'}` : '';
    wrap.style.display=newOrderDraftItems.length?'':'none';
    body.innerHTML=newOrderDraftItems.map((item,index)=>{
        const status=orderItemProductStatus(item);
        const action=status==='missing'?`<button type="button" class="btn-small btn-secondary" onclick="quickCreateNewOrderDraftItem(${index})">快速建立</button>`
            : ['ambiguous','error'].includes(status)?`<button type="button" class="btn-small btn-secondary" onclick="editNewOrderDraftItem(${index})">${status==='error'?'重試':'選擇產品'}</button>`:'';
        return `<tr><td data-th="貨號">${escapeHtml(item.itemCode||'')}</td><td data-th="品名">${escapeHtml(item.itemName||'')}</td><td data-th="廠牌">${escapeHtml(item.brand||'')}</td><td data-th="數量">${item.qty}</td><td data-th="單價">${item.unitPrice===null?'待確認':Number(item.unitPrice).toLocaleString()}</td><td data-th="產品狀態" class="order-product-status" data-status="${status}">${orderItemProductStatusLabel(item)}</td><td data-th="訂貨／交付">${item.procurementType==='SALES_SELF_ORDER'?(item.selfOrderConfirmed?'自行訂貨・已下訂':'自行訂貨・尚未下訂'):'交由採購'}／${globalThis.YushinOrderEntry.deliveryLabel(item)}</td><td data-th="操作">${action}<button type="button" class="btn-small btn-secondary" onclick="editNewOrderDraftItem(${index})">編輯</button> <button type="button" class="btn-danger btn-small" onclick="removeNewOrderDraftItem(${index})">移除</button></td></tr>`;
    }).join('');
}
let orderDraftProductCheckGeneration=0;
async function checkNewOrderDraftProducts() {
    const generation=++orderDraftProductCheckGeneration;
    const opening=orderModalOpenGeneration;
    const items=[...newOrderDraftItems];
    items.forEach(item=>{item.productCheckStatus='checking';});
    renderNewOrderDraftItems();
    // Exact code queries use the shared cache; repeated codes in the quote share one read.
    for(const item of items) {
        const code=item.itemCode,brand=item.brand;
        try {
            const matches=await findProductsByCode(code,{throwOnError:true});
            if(opening!==orderModalOpenGeneration||generation!==orderDraftProductCheckGeneration) return;
            if(!newOrderDraftItems.includes(item)||item.itemCode!==code||item.brand!==brand) continue;
            const match=selectProductCodeMatch(matches,brand);
            if(match) Object.assign(item,{productId:match.productId||stableProductId(match),productMasterMatched:true,
                brandId:match.brandId||item.brandId,productLine:match.productLine||item.productLine,productType:match.productType||item.productType,serviceKind:match.serviceKind||'',productCheckStatus:'matched'});
            else Object.assign(item,{productId:'',productMasterMatched:false,productCheckStatus:!brand&&matches.length>1?'ambiguous':'missing'});
        } catch(err) {
            if(opening!==orderModalOpenGeneration||generation!==orderDraftProductCheckGeneration) return;
            if(newOrderDraftItems.includes(item)&&item.itemCode===code&&item.brand===brand) item.productCheckStatus='error';
        }
        renderNewOrderDraftItems();
    }
}
window.quickCreateNewOrderDraftItem=function(index){
    editNewOrderDraftItem(index);
    const input=document.getElementById('orderItemCode');
    if(input?.value.trim()) openQuickProductCreate('order',input);
};

window.editNewOrderDraftItem=function(index){
    const item=newOrderDraftItems[index];
    if(!item)return;
    const current=currentOrderModalItem();
    if(current.itemName)newOrderDraftItems[index]=current;else newOrderDraftItems.splice(index,1);
    setOrderModalItem(item);
    renderNewOrderDraftItems();
    checkNewOrderDraftProducts();
};
window.removeNewOrderDraftItem=function(index){newOrderDraftItems.splice(index,1);renderNewOrderDraftItems();};
window.addCurrentOrderItemToDraft=function(){
    const item=currentOrderModalItem();
    const validation=globalThis.YushinOrderEntry.validateItem(item);
    if(!validation.valid){alert(validation.message);document.getElementById(validation.field)?.focus();return;}
    if(String(item.productType||'').trim().toUpperCase()==='SERVICE'){
        if(item.fulfillmentType!=='WAREHOUSE'){alert('服務型品項尚不支援原廠直送或實貨履約入口。');return;}
        item.deliveryPlan={};item.warehouseId='';
    }else{
        try { globalThis.YushinWarehouseLogistics.validatePlan(item.deliveryPlan,true); } catch(err) { alert(err.message); const details=document.getElementById('orderRecipientDetails');if(details)details.open=true;return; }
    }
    if(!item.itemName||item.qty<=0){alert('請先完成目前品項的品名與數量。');return;}
    if(item.productMasterMatched!==true||!item.productId||orderItemProductStatus(item)!=='matched'){alert('正式訂單品項必須先對應產品主檔。請輸入既有貨號，或使用「快速新增產品」完成基本產品資料。');return;}
    const duplicateIndex=newOrderDraftItems.findIndex(existing=>globalThis.YushinOrderEntry.sameDraftItem(existing,item));
    if(duplicateIndex>=0){newOrderDraftItems[duplicateIndex]={...newOrderDraftItems[duplicateIndex],qty:Number(newOrderDraftItems[duplicateIndex].qty||0)+Number(item.qty||0)};newOrderDraftItems[duplicateIndex].totalPrice=Number(newOrderDraftItems[duplicateIndex].qty||0)*Number(newOrderDraftItems[duplicateIndex].unitPrice||0);}
    else newOrderDraftItems.push(item);renderNewOrderDraftItems();
    ['orderItemCode','orderItemName','orderItemNameEn','orderProductLine','orderSpec'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const nextCodeInput=document.getElementById('orderItemCode');
    if(nextCodeInput.dataset.autofillBrand){document.getElementById('orderBrand').value='';onOrderBrandSelectChange();}
    const nextSelfStatus=document.getElementById('orderSelfOrderConfirmed');if(nextSelfStatus)nextSelfStatus.value=window.defaultOrderEntrySelfOrderStatus?.()||'pending';
    for(const id of ['orderSelfSupplier','orderCostPrice']){const field=document.getElementById(id);if(field){field.value='';delete field.dataset.autofillCost;}}
    window.syncOrderEntrySelfStatus?.();
    delete nextCodeInput.dataset.productLine;delete nextCodeInput.dataset.productType;delete nextCodeInput.dataset.serviceKind;delete nextCodeInput.dataset.productMasterMatched;delete nextCodeInput.dataset.productCheckStatus;delete nextCodeInput.dataset.preserveOrderPriceCode;delete nextCodeInput.dataset.matchedProductCode;delete nextCodeInput.dataset.autofillBrand;
    clearQuickProductButton(nextCodeInput);clearProductMatchChoices(nextCodeInput);
    renderNewOrderDraftItems();
    document.getElementById('orderQty').value=1;document.getElementById('orderUnitPrice').value='';document.getElementById('orderTotalPrice').value=0;window._orderModalProductId='';
};

window.openOrderModal = function(source = null) {
    window._orderModalReturnReorder = null;
    window._orderModalForecastContext = null;
    const overlay = document.getElementById('orderModalOverlay');
    if (!overlay) return;
    const openingGeneration = ++orderModalOpenGeneration;
    const openingCode=document.getElementById('orderItemCode');
    if(openingCode){delete openingCode.dataset.matchedProductCode;delete openingCode.dataset.autofillBrand;delete openingCode.dataset.productCheckStatus;delete openingCode.dataset.preserveOrderPriceCode;clearQuickProductButton(openingCode);clearProductMatchChoices(openingCode);}
    const recoveryBanner = document.getElementById('orderDraftRecoveryBanner');
    if (recoveryBanner) recoveryBanner.style.display = 'none';

    // 第一階段只做輕量欄位重設並立即顯示；主檔與輔助清單延後到首幀之後。
    overlay.classList.add('active');
    requestedOrderOwnerUid = source?.ownerUid || '';
    newOrderDraftItems = [];
    renderNewOrderDraftItems();

    window.setOrderShippingInstructions?.(source?.shippingInstructions||{});
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = source?.sourceType === DOCUMENT_TYPES.FORECAST ? 'Forecast 轉訂單' : '新增訂單';
    const today = new Date();
    document.getElementById('orderDateInput').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    ['orderCustomer', 'orderBrand', 'orderBrandOther', 'orderItemCode', 'orderItemName', 'orderItemNameEn', 'orderProductLine', 'orderSpec', 'orderInvoiceTitle'].forEach(id => {
        const field = document.getElementById(id);
        if (field) field.value = '';
    });
    onOrderBrandSelectChange();
    const selfStatus=document.getElementById('orderSelfOrderConfirmed');if(selfStatus)selfStatus.value=source?.selfOrderConfirmed===true?'confirmed':source?.selfOrderConfirmed===false?'pending':window.defaultOrderEntrySelfOrderStatus?.()||'pending';
    window.syncOrderEntrySelfStatus?.();
    const productDetails=document.getElementById('orderProductDetails');if(productDetails)productDetails.open=false;
    const recipientDetails=document.getElementById('orderRecipientDetails');if(recipientDetails)recipientDetails.open=false;
    const remarks=document.getElementById('orderRemarks');if(remarks)remarks.value=source?.remarks||'';
    document.getElementById('orderQty').value = 1;
    document.getElementById('orderUnitPrice').value = '';
    document.getElementById('orderTotalPrice').value = 0;
    const supplierInput=document.getElementById('orderSelfSupplier');if(supplierInput)supplierInput.value=source?.supplier||'';
    document.getElementById('orderCostPrice').value = '';
    delete document.getElementById('orderCostPrice').dataset.autofillCost;
    const procurement = document.getElementById('orderProcurementType');
    if (procurement) procurement.value = source?.procurementType || 'PURCHASING_PO';
    onOrderProcurementTypeChange();
    document.getElementById('orderFulfillmentType').value = source?.fulfillmentType || 'WAREHOUSE';
    document.getElementById('orderWarehouse').value = source?.warehouseId || '';
    onOrderFulfillmentChange();
    document.getElementById('orderTransactionType').value = '';
    document.getElementById('orderInvoiceTitle').disabled = true;
    window._orderModalSourceLink = source?.sourceType && source?.sourceId
        ? { sourceType: source.sourceType, sourceId: source.sourceId }
        : null;
    window._orderModalProductId = source?.productId || '';

    if (source) {
        document.getElementById('orderCustomer').value = source.customerName || '';
        const codeInput = document.getElementById('orderItemCode');
        codeInput.value = source.itemCode || '';
        codeInput.dataset.productLine = source.productLine || '';
        codeInput.dataset.productType = source.productType || '';
        codeInput.dataset.serviceKind = source.serviceKind || '';
        codeInput.dataset.matchedProductCode=normalizeItemCodeLoose(source.itemCode||'');
        if (source.productId) codeInput.dataset.autofillBrand=normalizeBrandLookupKey(resolveBrandName(source.brand||''));
        codeInput.dataset.preserveOrderPriceCode=normalizeItemCodeLoose(source.itemCode||'');
        codeInput.dataset.productCheckStatus='checking';
        codeInput.dataset.productMasterMatched = (source.productMasterMatched === true || !!source.productId) ? '1' : '0';
        document.getElementById('orderItemName').value = source.itemName || '';
        const nameEn = document.getElementById('orderItemNameEn');
        if (nameEn) nameEn.value = source.itemNameEn || source.nameEn || '';
        const spec = document.getElementById('orderSpec');
        if (spec) spec.value = source.spec || source.specification || '';
        document.getElementById('orderProductLine').value = source.productLine || '';
        document.getElementById('orderQty').value = source.qty || 1;
        document.getElementById('orderUnitPrice').value = source.unitPrice ?? '';
        if (currentUserRole === 'admin' || currentUserRole === 'purchaser') {
            document.getElementById('orderCostPrice').value = source.costPrice ?? '';
        }
        const total = source.totalPrice !== undefined && source.totalPrice !== null && source.totalPrice !== ''
            ? source.totalPrice
            : (Number(source.qty || 1) * Number(source.unitPrice || 0));
        document.getElementById('orderTotalPrice').value = total || 0;
    }

    deferUntilAfterPaint(async () => {
        if (openingGeneration !== orderModalOpenGeneration || !overlay.classList.contains('active')) return;

        populateOrderOwnerSelect();
        window.initializeOrderDeliveryDefaults?.(source?.shippingInstructions);
        if (currentUserRole === 'purchaser') {
            ensureSalesListLoaded()
                .then(() => {
                    if (openingGeneration === orderModalOpenGeneration) {populateOrderOwnerSelect();window.initializeOrderDeliveryDefaults?.(source?.shippingInstructions);}
                })
                .catch(err => console.error('讀取負責業務名單失敗：', err));
        }

        populateOrderBrandDropdown();
        if (source?.brand) {
            selectBrandInDropdown(document.getElementById('orderBrand'), source.brand);
            onOrderBrandSelectChange();
        }
        populateOrderCustomerSuggestions();
        updateOrderDraftRecoveryBanner(source);
        if(source?.itemCode && document.getElementById('orderItemCode').value===source.itemCode) onOrderItemCodeChange(document.getElementById('orderItemCode'));
        checkNewOrderDraftProducts();

        try {
            await loadWarehouseMaster();
            if (openingGeneration !== orderModalOpenGeneration || !overlay.classList.contains('active')) return;
            populateOrderWarehouseOptions(source?.warehouseId || '');
            if (source?.fulfillmentType === 'WAREHOUSE' && source?.warehouseId) {
                const warehouse = document.getElementById('orderWarehouse');
                if (warehouse) warehouse.value = source.warehouseId;
            }
            refreshOrderWarehouseStock();
            window.initializeOrderDeliveryDefaults?.(source?.shippingInstructions);
        } catch (err) {
            console.warn('新增訂單：倉庫主檔載入失敗，先保留目前表單。', err);
        }

        if (openingGeneration !== orderModalOpenGeneration || !overlay.classList.contains('active')) return;
    }, '新增訂單背景初始化');
};

let customerMasterSuggestionTimer = null;
let customerMasterSuggestionResults = [];

window.queueCustomerMasterSuggestions = function(value) {
    clearTimeout(customerMasterSuggestionTimer);
    const raw = String(value || '').trim();
    if (raw.length < 2) {
        customerMasterSuggestionResults = [];
        populateOrderCustomerSuggestions();
        return;
    }
    customerMasterSuggestionTimer = scheduleListSearch(customerMasterSuggestionTimer, () => searchCustomerMasterSuggestions(raw));
};

async function searchCustomerMasterSuggestions(raw) {
    const keyword = String(raw || '').trim();
    if (keyword.length < 2) return;
    try {
        // Customer Master 的 document id 由標準化客戶名稱產生，因此可用 documentId 前綴查詢，
        // 不需要為了自動完成載入整個 customers collection。
        const prefix = customerIdForName(keyword);
        const snapshot = await firestoreReadWithTimeout(
            db.collection('customers')
                .orderBy(firebase.firestore.FieldPath.documentId())
                .startAt(prefix)
                .endAt(prefix + '\uf8ff')
                .limit(20)
                .get(),
            '客戶主檔建議'
        );
        // 使用者可能在等待期間繼續輸入；舊查詢結果不可覆蓋新的關鍵字。
        const currentValues = [
            document.getElementById('orderCustomer')?.value,
            document.getElementById('eqCustomer')?.value
        ].map(value => String(value || '').trim());
        if (!currentValues.includes(keyword)) return;
        customerMasterSuggestionResults = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(item => item.active !== false && item.name)
            .map(item => item.name)
            .slice(0, 20);
        populateOrderCustomerSuggestions();
    } catch (err) {
        console.warn('客戶主檔建議查詢失敗：', err);
    }
}

function populateOrderCustomerSuggestions() {
    const list = document.getElementById('orderCustomerSuggestions');
    if (!list) return;
    const customersByKey = new Map();
    // 空白欄位只提供少量近期候選；完整客戶資料由輸入 2 個字後查 Customer Master。
    // 這樣歷史訂單／估價／儀器增加後，開啟表單不會為了 datalist 掃完整快取與整份 DOM。
    const names = [
        ...getRecentCustomerNames(),
        ...customerMasterSuggestionResults,
        ...ordersCache.slice(0, 20).map(order => order.customerName),
        ...equipmentList.slice(0, 20).map(equipment => equipment.customerName),
        ...myQuotesCache.slice(0, 20).map(quote => quote.clientName),
        ...myQuotesCache.slice(0, 20).map(quote => quote.ordererName)
    ];
    names.forEach(value => {
        const name = String(value || '').trim();
        if (!name) return;
        const key = name.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
        if (!customersByKey.has(key)) customersByKey.set(key, name);
    });
    list.innerHTML = '';
    [...customersByKey.values()].forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            list.appendChild(option);
        });
}

const RECENT_CUSTOMERS_STORAGE_KEY = 'recent_customer_names_v1';

function customerNameKey(value) {
    return String(value || '').trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
}

function getRecentCustomerNames() {
    try {
        const saved = JSON.parse(localStorage.getItem(RECENT_CUSTOMERS_STORAGE_KEY) || '[]');
        return Array.isArray(saved) ? saved.map(value => String(value || '').trim()).filter(Boolean).slice(0, 20) : [];
    } catch (_) {
        return [];
    }
}

function rememberRecentCustomerName(value) {
    const name = String(value || '').trim();
    if (!name) return;
    const key = customerNameKey(name);
    const recent = getRecentCustomerNames().filter(item => customerNameKey(item) !== key);
    localStorage.setItem(RECENT_CUSTOMERS_STORAGE_KEY, JSON.stringify([name, ...recent].slice(0, 20)));
    populateOrderCustomerSuggestions();
}

window.reorderAfterReturn = function(orderId) {
    if(!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))return;
    const source=ordersCache.find(order=>order.id===orderId);
    if(!source||!savedReturnRecords(source).some(row=>row.settlement==='CLOSE'&&Number(row.qty)>0)){
        alert('請先由倉庫確認退貨實收，再從原訂單重新下單。');return;
    }
    window.closeDeliveryModal?.();
    openOrderModal();
    window._orderModalReturnReorder={orderId};
    document.getElementById('orderModalTitle').innerText='退貨後重新下單';
    document.getElementById('orderCustomer').value=source.customerName||'';
    document.getElementById('orderTransactionType').value=source.transactionType||'';
    const invoice=document.getElementById('orderInvoiceTitle');
    invoice.value=source.invoiceTitle||'';invoice.disabled=source.transactionType!=='直';
    document.getElementById('orderRemarks').value=`退貨後重新下單，原訂單：${source.orderNo||orderId}。請重新確認商品、數量與價格。`;
    saveOrderDraft();
};

window.copyOrderAsNew = function(orderId) {
    const source = ordersCache.find(order => order.id === orderId);
    if (!source) {
        alert('找不到要複製的訂單，請重新整理後再試。');
        return;
    }
    openOrderModal();
    if (currentUserRole === 'purchaser') {
        requestedOrderOwnerUid = source.ownerUid || '';
        populateOrderOwnerSelect();
    }
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = '複製成新訂單';
    document.getElementById('orderCustomer').value = source.customerName || '';
    const copiedItems=normalizedOrderItems(source).map(item=>normalizeNewOrderItem(globalThis.YushinOrderEntry.copyItem(item,source.shippingInstructions)));
    const first=copiedItems[0]||normalizeNewOrderItem(source);
    // 複製訂單要沿用正式的品項填入流程，才能保留 Product Master 身分、
    // 訂貨方式、倉庫與品項屬性；不可只複製畫面文字後再依目前快取猜產品。
    setOrderModalItem(first);
    newOrderDraftItems=copiedItems.slice(1);renderNewOrderDraftItems();
    const transactionType = source.transactionType || '';
    document.getElementById('orderTransactionType').value = transactionType;
    const invoiceInput = document.getElementById('orderInvoiceTitle');
    invoiceInput.value = source.invoiceTitle || '';
    invoiceInput.disabled = transactionType !== '直';
};

window.closeOrderModal = function(options = {}) {
    orderModalOpenGeneration++;
    document.getElementById('orderModalOverlay').classList.remove('active');
    if (!options.preserveSource) {
        window._orderModalSourceLink = null;
        window._orderModalReturnReorder = null;
    window._orderModalForecastContext = null;
        window._orderModalQuoteContext = null;
        window._orderModalProductId = '';
    }
};

window.calcOrderTotal = function() {
    const qty = parseFloat(document.getElementById('orderQty').value) || 0;
    const price = parseFloat(document.getElementById('orderUnitPrice').value) || 0;
    document.getElementById('orderTotalPrice').value = (qty * price).toFixed(0);
};

let newOrderSaveInProgress = false;

let actionFeedbackTimer = null;
function showActionFeedback(message, type = 'success') {
    let status = document.getElementById('actionFeedback');
    if (!status) {
        status = document.createElement('div');
        status.id = 'actionFeedback';
        status.setAttribute('role', 'status');
        document.body.appendChild(status);
    }
    status.className = `action-feedback ${type === 'warning' ? 'warning' : 'success'}`;
    status.textContent = message;
    status.hidden = false;
    clearTimeout(actionFeedbackTimer);
    actionFeedbackTimer = setTimeout(() => { status.hidden = true; }, 6000);
}

window.saveNewOrder = function() {
    if (newOrderSaveInProgress) return;
    const currentItem=currentOrderModalItem();
    const items=[...newOrderDraftItems,...(currentItem.itemName?[currentItem]:[])].map(item=>({...item}));
    if(!items.length){alert('請至少輸入一個訂單品項。');return;}
    try { assertOrderItemCount(items); } catch (err) { alert(err.message); return; }
    if(items.some(item=>!item.itemName||Number(item.qty||0)<=0)){alert('每個品項都必須有品名及大於 0 的數量。');return;}
    const unfinished=items.map((item,index)=>({item,index})).filter(({item})=>item.productMasterMatched!==true||!item.productId||orderItemProductStatus(item)!=='matched');
    if(unfinished.length){
        alert('以下品項尚未完成產品檢查或建檔：\n'+unfinished.map(({item,index})=>`第 ${index+1} 項 ${item.itemCode||item.itemName}（${orderItemProductStatusLabel(item)}）`).join('\n')+'\n請先完成，再儲存訂單。');
        const first=unfinished[0];if(first.index<newOrderDraftItems.length)editNewOrderDraftItem(first.index);
        document.getElementById('orderItemCode')?.scrollIntoView({block:'center',behavior:'smooth'});
        document.getElementById('orderItemCode')?.focus();
        return;
    }
    if(items.some(item=>item.fulfillmentType==='WAREHOUSE'&&String(item.productType||'').trim().toUpperCase()!=='SERVICE'&&warehouseMasterCache.length&&!item.warehouseId)){alert('請為每個倉庫出貨品項選擇倉庫。');return;}
    const assistedOwner = currentUserRole === 'purchaser'
        ? salesList.find(person => person.uid === document.getElementById('orderOwnerUid')?.value
            && isSelectableCommercialOwner(person))
        : null;
    if (currentUserRole === 'purchaser' && !assistedOwner) { alert('請先選擇有效的負責業務。'); return; }
    if(currentUserRole==='purchaser'&&items.some(item=>item.procurementType==='SALES_SELF_ORDER'&&item.selfOrderConfirmed===true)){alert('採購可代建自行訂貨訂單；已向供應商下訂由負責業務確認。');return;}
    if(!document.getElementById('orderCustomer').value.trim()){alert('請填寫客戶名稱。');document.getElementById('orderCustomer')?.focus();return;}
    for(let index=0;index<items.length;index++) {
        const validation=globalThis.YushinOrderEntry.validateItem(items[index]);
        if(!validation.valid){alert(`第 ${index+1} 項：${validation.message}`);if(index<newOrderDraftItems.length)editNewOrderDraftItem(index);document.getElementById(validation.field)?.focus();return;}
    }
    const tradeValidation=globalThis.YushinOrderEntry.validateTrade({transactionType:document.getElementById('orderTransactionType')?.value},{requireInvoiceTitle:false});
    if(!tradeValidation.valid){alert(tradeValidation.message);const details=document.getElementById('orderTradeDetails');if(details)details.open=true;document.getElementById('orderTransactionType')?.focus();return;}
    let shippingInstructions;
    try {
        const fallback=window.orderShippingInstructions?.()||{};
        for(const item of items) {
            if(String(item.productType||'').trim().toUpperCase()==='SERVICE'){
                if(item.fulfillmentType==='DIRECT_SHIP')throw new Error('服務型品項不屬於原廠直送實貨，請選擇一般服務處理。');
                item.deliveryPlan={};item.warehouseId='';
                continue;
            }
            const plan=item.deliveryPlan||fallback;
            if(plan.mode==='CUSTOMER_SHIP'&&item.deliveryCustomerName&&item.deliveryCustomerName!==document.getElementById('orderCustomer').value.trim())throw new Error('客戶已更換，請編輯各品項並重新確認收件資訊。');
            if(item.fulfillmentType==='DIRECT_SHIP'&&plan.mode!=='CUSTOMER_SHIP')throw new Error('原廠直送請設定客戶收件資訊。');
            item.deliveryPlan=globalThis.YushinWarehouseLogistics.validatePlan(plan,true);
        }
        shippingInstructions=items.find(item=>String(item.productType||'').trim().toUpperCase()!=='SERVICE')?.deliveryPlan||{};
    } catch(err) {alert(err.message);const details=document.getElementById('orderRecipientDetails');if(details)details.open=true;return;}
    items.forEach(item=>{delete item.productCheckStatus;});
    const firstItem=items[0];
    const itemCode = firstItem.itemCode;
    let data = {
        shippingInstructions:shippingInstructions||{},
        orderDate: document.getElementById('orderDateInput').value,
        createdAt: new Date().toISOString(),
        ...commercialCreatorFields(),
        company: window._orderModalQuoteContext?.company || '',
        customerName: document.getElementById('orderCustomer').value.trim(),
        remarks:document.getElementById('orderRemarks')?.value.trim()||'',
        customerId: customerIdForName(document.getElementById('orderCustomer').value.trim()),
        brand: firstItem.brand,
        brandId: firstItem.brandId || brandIdForName(firstItem.brand),
        itemCode: itemCode,
        itemCodeKey: normalizeHistoryItemCode(itemCode),
        itemName: firstItem.itemName,
        productLine: firstItem.productLine || '',
        productType: '',
        selfOrderAtCreation:true,
        procurementType:firstItem.procurementType||'PURCHASING_PO',
        fulfillmentType:firstItem.fulfillmentType,warehouseId:firstItem.warehouseId||'',qty:firstItem.qty,unitPrice:firstItem.unitPrice,
        totalPrice:items.reduce((sum,item)=>sum+Number(item.totalPrice||0),0),items,itemCount:items.length,orderSchemaVersion:2,
        productMasterMatched:items.length > 0 && items.every(item => item.productMasterMatched === true),
        status: BUSINESS_STATUS.ACTIVE,
        ...grossAmountMetadata(items.reduce((sum,item)=>sum+Number(item.totalPrice||0),0)),
        transactionType: document.getElementById('orderTransactionType').value,
        invoiceTitle: document.getElementById('orderInvoiceTitle').value.trim(),
        quoteNo: window._orderModalQuoteContext?.quoteNo || '',
        ...linkedDocumentFields(window._orderModalSourceLink?.sourceType || '', window._orderModalSourceLink?.sourceId || '', window._orderModalSourceLink ? [documentLink(window._orderModalSourceLink.sourceType, window._orderModalSourceLink.sourceId, 'source')] : []),
        productId: firstItem.productId || '',
        salesName: assistedOwner?.name || window._orderModalQuoteContext?.salesName || window._orderModalForecastContext?.salesName || currentUserName || '',
        salesCode: assistedOwner?.code || window._orderModalQuoteContext?.salesCode || window._orderModalForecastContext?.salesCode || currentUserCode || '',
        ownerUid: assistedOwner?.uid || window._orderModalQuoteContext?.ownerUid || window._orderModalForecastContext?.ownerUid || currentUser?.uid || '',
        isDelivered: false,
        isBilled: false,
        billingDate: ''
    };
    if(window._orderModalReturnReorder)data.returnReorderSource={...window._orderModalReturnReorder};
    if (firstItem.procurementType === 'SALES_SELF_ORDER'
        && firstItem.costPrice !== undefined && firstItem.costPrice !== null
        && String(firstItem.costPrice).trim() !== '') {
        data.costPrice = Number(firstItem.costPrice);
        data.costSource = hasBusinessCapability()
            ? 'business_manual_transaction_cost'
            : 'manual_transaction_cost';
    }

    if (!data.orderDate || !data.itemName) {
        alert('請至少填寫訂單日期與品名');
        return;
    }
    if (data.fulfillmentType === 'WAREHOUSE' && String(firstItem.productType||'').trim().toUpperCase()!=='SERVICE' && warehouseMasterCache.length && !data.warehouseId) {
        alert('請選擇出貨倉庫；若由原廠直接送客戶，請改選「原廠直送客戶」。');
        return;
    }
    if (document.getElementById('orderBrand').value === '其他' && !data.brand) {
        alert('已選擇「其他」廠牌，請輸入廠牌名稱');
        return;
    }

    data.customerId = syncCustomerMaster(data.customerName, { salesCode: data.salesCode });
    const priceMatch = findPriceItemForOrder(data);
    data.productLine = firstItem.productLine || (priceMatch && priceMatch.productLine) || '';
    data.productType = firstItem.productType || (priceMatch && priceMatch.productType) || '';
    if (priceMatch) {
        data.productId = priceMatch.productId || stableProductId(priceMatch);
        data.supplier = priceMatch.supplier || '';
        data.spec = priceMatch.spec || '';
    }
    ensureOrderItemCompatibility(data);
    data.searchTokens = buildFullHistorySearchTokens('order', data);
    data.inventoryReservationStatus = 'pending';
    data.inventoryReservationUpdatedAt = new Date().toISOString();
    if([DOCUMENT_TYPES.QUOTE,DOCUMENT_TYPES.FORECAST].includes(data.sourceType)&&data.sourceId){
        data.sourceDocumentSyncStatus='pending';
        data.sourceDocumentSyncError='';
        data.sourceDocumentSyncUpdatedAt=data.inventoryReservationUpdatedAt;
    }

    const saveButton = document.getElementById('saveNewOrderBtn');
    const savingGeneration=orderModalOpenGeneration;
    const savingUid=currentUser?.uid;
    const savedDraftKey=orderDraftStorageKey();
    const savedPendingKey=pendingOrderCreateKey();
    saveOrderDraft();
    newOrderSaveInProgress = true;
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '建立中…'; }
    let createdOrderId = '';
    return createOrResumeNewOrder(data).then(async docRef => {
        createdOrderId = docRef.id;
        data=docRef.data;
        newOrderSaveInProgress=false;
        if(saveButton){saveButton.disabled=false;saveButton.innerText='建立訂單';}
        // 正式文件確認寫入後即釋放表單；庫存與來源文件同步使用這份獨立快照。
        pendingOrderReservationIds.add(docRef.id);
        if(currentUser?.uid===savingUid){
            rememberRecentCustomerName(data.customerName);
            const savedOrder = { id:docRef.id, ...data };
            ordersCache = [savedOrder, ...ordersCache.filter(order=>order.id!==docRef.id)]
                .sort((a,b)=>(b.orderDate||'').localeCompare(a.orderDate||''));
            writeAppDataCache('orders',ordersCache);
            renderOrdersList();
            if(localStorage.getItem(savedPendingKey)===docRef.id)localStorage.removeItem(savedPendingKey);
            if(savingGeneration===orderModalOpenGeneration){
                localStorage.removeItem(savedDraftKey);
                closeOrderModal();
            }
            showActionFeedback('訂單已建立，庫存正在背景同步；可繼續建立其他訂單。','success');
        }
        let reservation;
        try {
            if(currentUser?.uid!==savingUid)throw new Error('登入身份已變更，請以原帳號重試同步');
            if(data.inventoryReservationStatus==='completed'){
                reservation=orderReservationSummary(data);
            }else{
                reservation = await synchronizeOrderInventory(docRef.id, data, savingUid);
            }
        } catch (reservationErr) {
            throw new Error(`訂單已建立，但庫存預留未完成：${reservationErr?.message||reservationErr}。請從訂單清單重試同步，勿重複建立。`);
        }
        data.inventoryProductKey = inventoryProductKey(data);
        rememberRecentCustomerName(data.customerName);
        const quoteSyncError=await syncNewOrderSourceDocuments(docRef.id,data,savingUid);
        pendingOrderReservationIds.delete(docRef.id);
        if(currentUser?.uid!==savingUid)return;
        // 單筆回填已完成的庫存資料，不重新查詢整份清單，也不碰下一張訂單的表單。
        const savedOrder = { id: docRef.id, ...data };
        ordersCache = [savedOrder, ...ordersCache.filter(order => order.id !== docRef.id)]
            .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        syncOrderIntoPurchasingCaches(savedOrder);
        if (quoteSyncError) {
            showActionFeedback('訂單已建立，庫存預留已同步，但來源估價單未標記成交。請勿重複建立訂單，請檢查來源估價單：' + quoteSyncError.message,'warning');
        } else {
            const automaticallyOrdered = Array.isArray(data.items) && data.items.some(item=>
                item.procurementType==='SALES_SELF_ORDER' && Number(item.supplyOrderedQty||0)>0);
            showActionFeedback(automaticallyOrdered
                ? '訂單已建立；自行訂貨已記錄為已採購，等待到貨。'
                : '訂單已建立，庫存預留已同步。', 'success');
        }
    }).catch(err => {
        pendingOrderReservationIds.delete(createdOrderId);
        if(currentUser?.uid!==savingUid)return;
        if (createdOrderId) {
            const cachedOrder=ordersCache.find(order=>order.id===createdOrderId);
            if(cachedOrder)Object.assign(cachedOrder,data);
            writeAppDataCache('orders',ordersCache);
            renderOrdersList();
            showActionFeedback(`訂單已建立，但庫存同步未完成。請在該筆訂單按「重試同步」，不要另建一張：${err.message}`,'warning');
        } else {
            alert('儲存狀態尚未確認；請按儲存重試同一張訂單，勿另開新單：' + err.message);
        }
    }).finally(() => {
        if(!createdOrderId){
            newOrderSaveInProgress = false;
            if (saveButton) { saveButton.disabled = false; saveButton.innerText = '建立訂單'; }
        }
    });
};

// 匯出指定日期區間的訂單（供採購下單使用），不受畫面上目前的搜尋關鍵字影響
window.exportOrdersByDate = async function() {
    const start = document.getElementById('exportStartDate').value;
    const end = document.getElementById('exportEndDate').value;
    if (!start || !end) {
        alert('請選擇起訖日期');
        return;
    }
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }

    // 在查詢階段限制自己的訂單，與資料庫權限規則一致。
    if (start > end) return alert('起日不可晚於迄日。');
    let exportQuery = db.collection('orders')
        .where('orderDate', '>=', start)
        .where('orderDate', '<=', end)
        .orderBy('orderDate', 'desc');
    if (!canViewAllData('orders')) {
        if(currentUserCode) exportQuery=exportQuery.where('salesCode','==',currentUserCode);
        else exportQuery=db.collection('orders').where('ownerUid','==',currentUser.uid);
    }
    readQueryInBatches(exportQuery).then(async records => {
            const rows = [];
            records.forEach(o => {
                if((o.orderDate||'')<start||(o.orderDate||'')>end)return;
                if (!canViewAllData('orders') && !belongsToCurrentUser(o.salesName, o.ownerUid)) {
                    return;
                }
                rows.push({
                    '訂單日期': o.orderDate || '',
                    '客戶名稱': o.customerName || '',
                    '廠牌': o.brand || '',
                    '產品線': productLineForOrder(o),
                    '貨號': o.itemCode || '',
                    '品名': o.itemName || '',
                    '數量': o.qty || '',
                    '單價': o.unitPrice || '',
                    '總價': o.totalPrice || '',
                    '交易方式': o.transactionType || '',
                    '抬頭': o.invoiceTitle || '',
                    '核銷日期': orderBillingDate(o),
                    '來源估價單': o.quoteNo || '',
                    '負責業務': stripPhoneSuffix(o.salesName)
                });
            });

            if (!rows.length) {
                alert('這個日期區間內沒有訂單資料。');
                return;
            }

            rows.sort((a, b) => (a['訂單日期'] || '').localeCompare(b['訂單日期'] || ''));

            const ws = XLSX.utils.json_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '訂單');
            XLSX.writeFile(wb, `訂單_${start}_至_${end}.xlsx`);
        }).catch(err => {
            alert('匯出失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
        });
};

