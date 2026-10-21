/* =========================================================
   產生採購單：採購把選好的訂單品項，整理成一張要發給供應商的「採購單」，
   格式跟估價單相同，但抬頭是供應商、單價預設帶「含稅成本」而不是賣客戶的售價，
   而且單價在這裡還可以再調整；也可以切換又鑫／辰星／鼎新，套用各公司的抬頭資訊跟單號代碼
   ========================================================= */
let poItems = [];
let poAllItems = [];
let poCurrentCompany = 'yushin';
let poEditingId = null;
let poSaveInProgress = false;
let poDirectStockMode = false;
let poIncomingSyncPending = false;
let poNoGeneration = 0;
let poDirectStockOpenGeneration = 0;
let poNoReady = false;
let poNoLoading = false;

function updatePoSaveStatus(message = '', isError = false) {
    const status = document.getElementById('poSaveStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#b42318' : '#12502b';
}

function updatePoSaveButton() {
    const button = document.getElementById('printPurchaseOrderBtn');
    if (!button) return;
    const waitingForNumber = !poEditingId && !poNoReady;
    const copyButton = document.getElementById('poCopyAsNewBtn');
    if (copyButton) copyButton.disabled = poSaveInProgress;
    button.disabled = poSaveInProgress || waitingForNumber;
    button.textContent = waitingForNumber
        ? (poNoLoading ? '產生單號中…' : '單號未就緒')
        : poEditingId ? '📄 下載 PDF' : '📄 建立採購單並下載 PDF';
}

function purchaseItemsFromSavedPo(po) {
    const sourceItems = [po?.items, po?.orderItems, po?.purchaseItems, po?.lineItems, po?.products]
        .find(items => Array.isArray(items) && items.length)
        || ((po?.itemName || po?.productName || po?.itemCode || po?.productCode) ? [po] : []);
    return sourceItems.map((item, index) => ({
        ...item,
        orderId: item.orderId || item.sourceOrderId || '',
        orderItemIndex: item.orderItemIndex ?? index,
        itemName: item.itemName || item.productName || item.name || item.nameCn || '',
        itemCode: item.itemCode || item.productCode || item.code || item.model || '',
        productId: item.productId || '',
        brand: item.brand || item.manufacturer || '',
        brandId: item.brandId || '',
        qty: parseFloat(item.qty ?? item.quantity ?? item.count) || 1,
        unitPrice: parseFloat(item.unitPrice ?? item.costPrice ?? item.cost ?? item.purchasePrice) || 0
    })).filter(item => item.itemName || item.itemCode);
}

// 將不同時期的訂單品項格式統一成採購單使用的格式。舊資料是一張訂單一個
// itemName/itemCode/qty；新版或匯入資料可能使用 items、orderItems 或 products。
// 只在讀取時轉換，不回寫原訂單，避免 Phase 1 變成資料模型遷移。
function purchaseItemsFromOrder(order) {
    const collections = [order?.items, order?.orderItems, order?.lineItems, order?.products];
    const sourceItems = collections.find(items => Array.isArray(items) && items.length) || [order || {}];
    return sourceItems.map((item, index) => {
        const itemCode = item.itemCode || item.productCode || item.code || item.model || order.itemCode || order.productCode || '';
        const itemName = item.itemName || item.productName || item.name || item.nameCn || order.itemName || order.productName || '';
        const brand = item.brand || item.manufacturer || order.brand || '';
        const qtyValue = item.qty ?? item.quantity ?? item.count ?? (sourceItems.length === 1 ? order.qty ?? order.quantity : 1);
        let cost = parseFloat(item.costPrice ?? item.cost ?? item.purchasePrice ?? (sourceItems.length === 1 ? order.costPrice : NaN));
        {
            const savedProductId = item.productId || order.productId || '';
            const normalizedCode = normalizeItemCode(itemCode);
            const normalizedBrand = String(brand || '').trim().toLocaleLowerCase();
            const priceMatch = (savedProductId && priceList.find(product => product.productId === savedProductId))
                || (normalizedBrand && priceItemLookup.get(`brand:${normalizedBrand}:${normalizedCode}`))
                || priceItemLookup.get(`code:${normalizedCode}`);
            const productId = savedProductId || priceMatch?.productId || (priceMatch ? stableProductId(priceMatch) : '');
            const secureCost = productId ? purchaseCostCache.get(productId) : null;
            if (secureCost !== undefined && secureCost !== null) cost = Number(secureCost);
            else if ((!Number.isFinite(cost) || cost < 0) && priceMatch) {
                cost = parseFloat(priceMatch.cost ?? priceMatch.costPrice ?? priceMatch.purchasePrice);
            }
        }
        const parsedQty=parseFloat(qtyValue);
        const fullQty=Number.isFinite(parsedQty)&&parsedQty>0?parsedQty:1;
        const procurementType=item.procurementType||order.procurementType||'PURCHASING_PO';
        if(procurementType==='SALES_SELF_ORDER') return null;
        // 待採購數量必須與採購頁、訂單工作狀態共用同一公式。
        // shortageQty 會在到貨時下降，不能再直接減累計 supplyOrderedQty，
        // 否則「部分採購已全部到貨、但仍有剩餘缺口」會被誤算成 0。
        const remainingPurchase=remainingProcurementQty(order,item);
        return {
            orderId: order.id,
            orderItemIndex: index,
            itemId:item.itemId||`item-${index+1}`,
            itemName,
            itemCode,
            productId: item.productId || order.productId || '',
            brand,
            brandId: item.brandId || order.brandId || '',
            qty: remainingPurchase,
            productLine: item.productLine || order.productLine || '',
            ownerUid: order.ownerUid || '',
            salesCode: order.salesCode || '',
            salesName: order.salesName || '',
            fulfillmentType: item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE',
            warehouseId: item.warehouseId || order.warehouseId || '',
            unitPrice: Number.isFinite(cost) && cost >= 0 ? cost : null,
            procurementType
        };
    }).filter(item => item && (item.itemName || item.itemCode) && Number(item.qty||0)>0);
}

function bestPurchaseOrderCompany(selectedOrders, items, preferredCompany) {
    const companies = ['yushin', 'morningstar', 'MULTI-LIFE'];
    const savedCompanies = [...new Set(selectedOrders.map(order => order.company).filter(company => companies.includes(company)))];
    if (savedCompanies.length === 1 && items.some(item => isCompanyBrandAllowed(savedCompanies[0], item.brand))) return savedCompanies[0];
    if (companies.includes(preferredCompany) && items.some(item => isCompanyBrandAllowed(preferredCompany, item.brand))) return preferredCompany;
    return companies
        .map(company => ({ company, count: items.filter(item => isCompanyBrandAllowed(company, item.brand)).length }))
        .sort((a, b) => b.count - a.count)[0]?.company || 'yushin';
}

async function openProductManagementProductsInPurchase(products) {
    if (!canEditPage('orders.po') || !products.length) return false;
    const button = actionButtonFromEventOrSelector();
    const state = beginActionButton(button, '載入採購品項…');
    if (button && !state) return false;
    try {
        // Refresh only selected products; never trust a stale selection or scan all costs.
        const refreshed = await Promise.all(products.map(async selected => {
            const id = selected.productId || selected.id;
            const [productSnap, costSnap] = await Promise.all([
                firestoreReadWithTimeout(db.collection('products').doc(id).get(), '讀取採購產品'),
                firestoreReadWithTimeout(db.collection('productCosts').doc(id).get(), '讀取標準成本')
            ]);
            if (!productSnap.exists || productSnap.data().active === false || productSnap.data().status === 'INACTIVE') {
                throw new Error('所選產品已停用或不存在，請重新選取。');
            }
            const costValue = costSnap.exists ? costSnap.data().standardCost ?? costSnap.data().costPrice : null;
            const cost = costValue === null || costValue === undefined ? NaN : Number(costValue);
            return { ...productSnap.data(), productId:id, purchaseCost:Number.isFinite(cost) && cost >= 0 ? cost : null };
        }));
        // The modal opens synchronously before warehouse suggestions finish loading.
        const opening = openDirectStockPurchase(refreshed[0]);
        poItems = refreshed.map(product => ({ ...emptyDirectPoItem(),
            ...productManagementSource(product), unitPrice:product.purchaseCost }));
        poAllItems = poItems;
        renderPoItemsTable();
        updatePoModeUI();
        await opening;
        return true;
    } catch (err) {
        showActionFeedback('加入採購單失敗：' + err.message, 'warning');
        return false;
    } finally { endActionButton(button, state); }
}

window.addProductManagementToPurchase = async function(productId) {
    await openProductManagementProductsInPurchase([{ productId }]);
};

window.addProductManagementSelectionToPurchase = async function() {
    const products = selectedProductManagementProducts();
    if (await openProductManagementProductsInPurchase(products)) clearProductManagementSelection();
};

window.openDirectStockPurchase = async function(product = null) {
    if (!canEditPage('orders.po')) return;
    const openingGeneration = ++poDirectStockOpenGeneration;
    poDirectStockMode = true;
    poEditingId = null;
    poIncomingSyncPending = false;
    poAllItems = [];
    poItems = [];
    document.getElementById('poVendorName').value = '';
    document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
    document.getElementById('poDate').value = localDateString();
    clearPoExpectedDate();
    switchPoCompany(currentCompany || 'yushin', null, true);
    generatePoNo();
    addDirectPoItem();
    if(product){
        poItems[0]={...poItems[0],productId:product.productId||product.id,
            itemCode:product.manufacturerPartNo||product.sku||product.model||'',
            itemName:product.productName||product.nameCn||product.nameEn||'',
            brand:resolveBrandName(product.brandName||product.brand||''),
            brandId:product.brandId||'',productLine:product.productLine||'',productType:product.productType||'',
            unitPrice:null};
        renderPoItemsTable();
    }
    updatePoModeUI();
    updatePoSaveStatus('這張採購單尚未建立。確認品項、供應商與單價後，按「建立採購單並下載 PDF」；建立成功後自動列入待到貨。');
    document.getElementById('poModalOverlay').classList.add('active');

    // 備貨單的空白表單不依賴雲端主檔，先立即顯示；供應商與預設倉庫在背景補齊。
    // 不重畫使用者已經開始輸入的表格，避免慢網路回來時洗掉尚未觸發 change 的文字。
    await loadSupplierWarehouseMasters();
    if (openingGeneration !== poDirectStockOpenGeneration || !poDirectStockMode || poEditingId) return;
    const warehouseId = defaultWarehouse()?.id || '';
    poItems.forEach(item => {
        if (!item.warehouseId) item.warehouseId = warehouseId;
    });
    populatePoVendorSuggestions();
    updatePoModeUI();
};

function emptyDirectPoItem() {
    return {
        orderId:'', sourceType:'STOCK_REPLENISHMENT', sourceId:'',
        itemName:'', itemCode:'', productId:'', brand:'', brandId:'', qty:1, unitPrice:null, supplier:'',
        productLine:'', fulfillmentType:'WAREHOUSE', warehouseId:defaultWarehouse()?.id || ''
    };
}

window.addDirectPoItem = function() {
    poDirectStockMode = true;
    poItems.push(emptyDirectPoItem());
    poAllItems = poItems;
    window.autoFillPoExpectedDate(poItems);
    renderPoItemsTable();
    updatePoModeUI();
};

window.onDirectPoCodeChange = async function(idx, value) {
    if (!poItems[idx]) return;
    const requestedCode = String(value || '').trim();
    const preferredBrand = resolveBrandName(poItems[idx].brand || '');
    poItems[idx] = {
        ...poItems[idx],
        itemCode: requestedCode,
        itemName: '',
        productId: '',
        brand: preferredBrand,
        brandId: brandIdForName(preferredBrand),
        unitPrice: null,
        supplier: '',
        productLine: ''
    };
    poAllItems = poItems;
    const match = requestedCode ? await findProductByCode(requestedCode, preferredBrand) : null;
    if (!poItems[idx] || String(poItems[idx].itemCode || '').trim() !== requestedCode) return;
    if (match) {
        const secureCost = await loadVisibleProductCost(match);
        if (!poItems[idx] || String(poItems[idx].itemCode || '').trim() !== requestedCode) return;
        poItems[idx] = {
            ...poItems[idx],
            itemCode: match.model || requestedCode,
            itemName: match.nameCn || match.nameEn || '',
            productId: match.productId || stableProductId(match),
            brand: resolveBrandName(match.brand || ''),
            brandId: match.brandId || brandIdForName(match.brand || ''),
            unitPrice: secureCost !== null && Number.isFinite(secureCost)
                ? secureCost
                : match.cost !== null && match.cost !== undefined && match.cost !== '' && Number.isFinite(Number(match.cost)) ? Number(match.cost) : null,
            supplier: match.supplier || '',
            productLine: match.productLine || '',
            fulfillmentType: poItems[idx].fulfillmentType || 'WAREHOUSE',
            warehouseId: poItems[idx].warehouseId || defaultWarehouse()?.id || ''
        };
        const mappedSupplier = supplierForProduct(
            match.brand,
            match.productLine,
            match.productId || stableProductId(match),
            match.model || requestedCode
        );
        if (!document.getElementById('poVendorName').value && mappedSupplier) {
            document.getElementById('poVendorName').value = mappedSupplier.purchaseHeaderName || mappedSupplier.supplierName || '';
        } else if (!document.getElementById('poVendorName').value && match.supplier) {
            document.getElementById('poVendorName').value = match.supplier;
        }
    }
    poAllItems = poItems;
    window.autoFillPoExpectedDate(poItems);
    renderPoItemsTable();
};

window.updateDirectPoText = function(idx, field, value) {
    if (!poItems[idx]) return;
    poItems[idx][field] = field === 'brand' ? resolveBrandName(value) : String(value || '').trim();
    if (field === 'brand') {
        poItems[idx].brandId = brandIdForName(poItems[idx].brand);
        if (poItems[idx].itemCode) {
            onDirectPoCodeChange(idx, poItems[idx].itemCode);
            return;
        }
    }
    poAllItems = poItems;
    window.autoFillPoExpectedDate(poItems);
};

function updatePoModeUI() {
    const leadDays=document.getElementById('poLeadDays');
    if(leadDays)leadDays.disabled=!!poEditingId;
    const addBtn = document.getElementById('poAddStockItemBtn');
    const hint = document.getElementById('poModeHint');
    const brandList = document.getElementById('poBrandList');
    const overlay = document.getElementById('poModalOverlay');
    const title = document.getElementById('poModalTitle');
    const existingBanner = document.getElementById('poExistingBanner');
    const existingNumber = document.getElementById('poExistingNumber');
    const copyBtn = document.getElementById('poCopyAsNewBtn');
    if (brandList) brandList.innerHTML = getUnifiedBrandNames(false).map(name => `<option value="${escapeAttr(name)}"></option>`).join('');

    const viewingExisting = !!poEditingId;
    overlay?.classList.toggle('po-viewing-existing', viewingExisting);
    if (title) title.textContent = viewingExisting ? '查看採購單' : '建立採購單';
    if (existingBanner) existingBanner.style.display = viewingExisting ? 'flex' : 'none';
    if (existingNumber) existingNumber.textContent = viewingExisting ? (document.getElementById('poNo')?.innerText || poEditingId) : '';

    const savedPo = viewingExisting ? poListCache.find(po => po.id === poEditingId) : null;
    const canCopySafely = !!savedPo && canCreatePurchaseOrderCapability() && canEditPage('orders.po');
    if (copyBtn) { copyBtn.style.display = canCopySafely ? '' : 'none'; copyBtn.disabled = poSaveInProgress; }
    const timelineBtn = document.getElementById('poViewHistoryBtn');
    if (timelineBtn) timelineBtn.style.display = viewingExisting ? '' : 'none';
    const cancelBtn = document.getElementById('poCancelOutstandingBtn');
    const hasOutstanding = !!savedPo && !isPurchaseTerminalStatus(savedPo.status) && purchaseItemsFromSavedPo(savedPo).some((_, index) => Number(purchaseHistoryItemReceiptProgress(savedPo, index).remainingQty) > 0);
    if (cancelBtn) cancelBtn.style.display = canCopySafely && hasOutstanding ? '' : 'none';
    const supplierContact = savedPo ? purchaseOrderSupplierContact(savedPo) : purchaseOrderSupplierContact({vendorName:document.getElementById('poVendorName')?.value||''});

    if (addBtn) addBtn.style.display = !viewingExisting && poDirectStockMode ? '' : 'none';
    if (hint) hint.textContent = viewingExisting
        ? '這是已建立的正式採購單。內容鎖定不直接修改；可重新匯出 PDF。'
        : poDirectStockMode
            ? '建立庫存採購採購單：可一次加入多個品項；建立後會列入在途庫存。'
            : '訂單採購：品項來自業務訂單，可調整採購數量與進貨單價。';
    updatePoSaveButton();
}


function clearPoExpectedDate() {
    const days=document.getElementById('poLeadDays');
    if(days)days.value='';
    const input=document.getElementById('poExpectedDate');
    if(!input)return;
    input.value='';
    delete input.dataset.expectedDateSource;
    syncPoLeadDays();
}

window.markPoExpectedDateManual = function() {
    const input=document.getElementById('poExpectedDate');
    if(input)input.dataset.expectedDateSource='manual';
};

window.autoFillPoExpectedDate = function(items = poItems, preferredSupplierId = '') {
    const input=document.getElementById('poExpectedDate');
    if(!input || poEditingId)return input?.value||'';
    if(input.dataset.expectedDateSource==='manual') {
        if(document.getElementById('poLeadDays')?.value!=='')window.setPoLeadDays();
        return input.value||'';
    }
    if(!globalThis.YushinSupplier?.purchaseExpectedDate)return '';

    const vendorName=String(document.getElementById('poVendorName')?.value||'').trim();
    const liveSupplier=supplierForVendorName(vendorName);
    const supplierId=String(preferredSupplierId||liveSupplier?.id||liveSupplier?.supplierId||'').trim();
    const supplier=supplierMasterCache.find(item =>
        String(item.id||item.supplierId||'')===supplierId
    )||liveSupplier||null;
    const orderDate=String(document.getElementById('poDate')?.value||'').trim();
    const expected=globalThis.YushinSupplier.purchaseExpectedDate(
        items||[],
        supplier||0,
        orderDate
    );

    if(expected){
        input.value=expected;
        input.dataset.expectedDateSource='lead-time';
    }else if(input.dataset.expectedDateSource==='lead-time'){
        input.value='';
        delete input.dataset.expectedDateSource;
    }
    syncPoLeadDays();
    return expected;
};

function syncPoLeadDays() {
    const days=document.getElementById('poLeadDays');
    const date=document.getElementById('poExpectedDate')?.value;
    const ordered=document.getElementById('poDate')?.value;
    if(days)days.value=date&&ordered?Math.max(0,(Date.parse(date)-Date.parse(ordered))/86400000):'';
    const hint=document.getElementById('poExpectedDateHint');
    if(hint)hint.textContent=date?`預計 ${date} 到貨`:'未設定交期';
}

window.setPoLeadDays = function() {
    if(poEditingId)return;
    const days=document.getElementById('poLeadDays');
    const date=document.getElementById('poExpectedDate');
    const ordered=document.getElementById('poDate')?.value;
    if(!days||!date)return;
    const value=Number(days.value);
    if(days.value===''||!ordered){date.value='';delete date.dataset.expectedDateSource;}
    else if(Number.isInteger(value)&&value>=0){
        const expected=new Date(ordered+'T00:00:00Z');
        expected.setUTCDate(expected.getUTCDate()+value);
        date.value=expected.toISOString().slice(0,10);
        date.dataset.expectedDateSource='manual';
    }else{
        date.value='';delete date.dataset.expectedDateSource;
        const hint=document.getElementById('poExpectedDateHint');
        if(hint)hint.textContent='請輸入 0 或以上的整數天數';
        return;
    }
    const hint=document.getElementById('poExpectedDateHint');
    if(hint)hint.textContent=date.value?`預計 ${date.value} 到貨`:'未設定交期';
};

function poItemsWithScheduleDates(items = [], supplierId = '', orderDate = '', headerExpectedDate = '', expectedDateSource = '') {
    const manualHeader = expectedDateSource === 'manual'
        || (!!headerExpectedDate && expectedDateSource !== 'lead-time');
    const supplier=supplierMasterCache.find(item =>
        String(item.id||item.supplierId||'')===String(supplierId||'')
    )||null;
    return (items || []).map(item => {
        let scheduleDate = '';
        if (manualHeader) {
            scheduleDate = headerExpectedDate || '';
        } else if (supplier && globalThis.YushinSupplier?.itemExpectedArrivalDate) {
            scheduleDate = globalThis.YushinSupplier.itemExpectedArrivalDate(item,supplier,orderDate);
        }
        return { ...item, scheduleDate };
    });
}

async function autoFillPoSupplier(items) {
    await loadSupplierWarehouseMasters();
    const rows=items||[];
    const resolved = rows.map(item => supplierForProduct(
        item.brand,
        item.productLine,
        item.productId,
        item.itemCode
    )).filter(Boolean);
    if (!resolved.length) {
        window.autoFillPoExpectedDate(rows,'__unresolved__');
        return '';
    }
    const ids = [...new Set(resolved.map(item => item.id || item.supplierId))];
    if (ids.length !== 1) {
        window.autoFillPoExpectedDate(rows,'__multiple__');
        return '';
    }
    const supplier = resolved[0];
    const header = supplier.purchaseHeaderName || supplier.supplierName || '';
    const input = document.getElementById('poVendorName');
    if (input && header) input.value = header;
    window.autoFillPoExpectedDate(rows,ids[0]);
    return header;
}

function populatePoVendorSuggestions() {
    const list = document.getElementById('poVendorSuggestions');
    if (!list) return;
    const vendorsByKey = new Map();
    const addVendor = name => {
        const value=String(name||'').trim();
        if(!value)return;
        const key=value.normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase();
        if(!vendorsByKey.has(key))vendorsByKey.set(key,value);
    };
    supplierMasterCache.forEach(supplier=>addVendor(supplier.purchaseHeaderName||supplier.supplierName));
    poListCache.forEach(po=>addVendor(po.vendorName));
    list.innerHTML = '';
    [...vendorsByKey.values()]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
        .forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            list.appendChild(option);
        });
}

window.closePurchaseOrderModal = function() {
    poDirectStockOpenGeneration++;
    poNoGeneration++;
    poNoLoading = false;
    poNoReady = false;
    document.getElementById('poModalOverlay').classList.remove('active');
};

// 切換採購單要用哪間公司的抬頭／單號代碼（又鑫 YS／辰星 MS／鼎新 DS），跟估價單的公司切換邏輯一致
window.switchPoCompany = function(compKey, el, skipNoGen) {
    poCurrentCompany = compKey;
    document.querySelectorAll('#poModalOverlay .sub-nav .sub-tab').forEach(t => t.classList.remove('active'));
    const targetTab = document.getElementById(`po-sub-${compKey}`);
    if (targetTab) targetTab.classList.add('active');
    else if (el) el.classList.add('active');

    const info = companyData[compKey];
    if (info) {
        document.getElementById('poCompTitle').innerText = info.title;
        document.getElementById('poCompSub').innerText = info.sub;
        document.getElementById('poCompAddr').innerText = info.addr;
        document.getElementById('poCompContact').innerHTML = info.contact;
    }

    // 依管理員設定，採購單只帶入該分公司代理的廠牌；切換分公司時立即重新篩選。
    if (!skipNoGen && poAllItems.length) {
        poItems = poAllItems.filter(item => isCompanyBrandAllowed(compKey, item.brand));
        renderPoItemsTable();
    }

    // 重新列印「採購訂單」裡舊有的採購單時，要沿用當初存的單號，不能在這裡重新產生一個新的
    if (!skipNoGen) generatePoNo();
};

// 採購單號格式：PO-{公司代碼}-{日期}-{採購代號}-{流水號}，跟估價單單號的組成方式一致，
// 例如又鑫、代號 03 的採購，會是 PO-YS-20260824-03-01。
// 流水號是真的依照雲端已經產生過幾張採購單去算「目前最大流水號 + 1」，不是隨機亂數，
// 邏輯跟估價單的 generateQuoteNo 一致，這樣才能保證同一天同一間公司不會撞號
window.generatePoNo = async function() {
    const info = companyData[poCurrentCompany];
    if (!info) return '';
    const generation = ++poNoGeneration;
    const dateStr = getFormattedDateCode();
    const purchaserCode = currentUserCode || '01';
    const prefix = `PO-${info.prefix}-${dateStr}-${purchaserCode}-`;
    const numberEl = document.getElementById('poNo');

    poNoReady = false;
    poNoLoading = true;
    if (numberEl) numberEl.innerText = '產生中…';
    updatePoSaveButton();

    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('purchaseOrders')
                .where('poNo', '>=', prefix)
                .where('poNo', '<=', prefix + '\uf8ff')
                .orderBy('poNo', 'desc')
                .limit(1)
                .get(),
            '採購單號'
        );

        // 使用者可能在查詢尚未回來時切換公司、關閉視窗或開啟另一張單。
        // 舊查詢結果不得再覆蓋目前畫面。
        if (generation !== poNoGeneration) return '';

        let maxSeq = 0;
        snapshot.forEach(doc => {
            const seqStr = (doc.data().poNo || '').split('-').pop();
            const seq = parseInt(seqStr, 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        });
        const nextNo = `${prefix}${String(maxSeq + 1).padStart(2, '0')}`;
        if (numberEl) numberEl.innerText = nextNo;
        poNoReady = true;
        return nextNo;
    } catch (e) {
        if (generation !== poNoGeneration) return '';
        // 查不到目前最大流水號時不能直接假設 01；那可能撞到已存在的正式 PO。
        if (numberEl) numberEl.innerText = '—';
        poNoReady = false;
        updatePoSaveStatus('採購單號讀取失敗，請切換公司或重新開啟後再試。', true);
        return '';
    } finally {
        if (generation === poNoGeneration) {
            poNoLoading = false;
            updatePoSaveButton();
        }
    }
};

function renderPoItemsTable() {
    const tbody = document.getElementById('poItemsBody');
    tbody.innerHTML = '';
    poItems.forEach((item, idx) => {
        const missingPrice = item.unitPrice === null || item.unitPrice === undefined || item.unitPrice === '' || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0;
        const tr = document.createElement('tr');
        if (poDirectStockMode) {
            tr.innerHTML = `
                <td style="border:1px solid #999;padding:4px;"><input type="text" value="${escapeAttr(item.itemName||'')}" placeholder="品名" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'itemName',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="priceModelList" value="${escapeAttr(item.itemCode||'')}" placeholder="貨號" style="width:100%;box-sizing:border-box;" onchange="onDirectPoCodeChange(${idx},this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="poBrandList" value="${escapeAttr(item.brand||'')}" placeholder="廠牌" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'brand',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" min="0.0001" step="any" value="${item.qty||1}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx},'qty',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" min="0" step="0.01" value="${missingPrice?'':item.unitPrice}" placeholder="未稅進貨單價" class="${missingPrice?'po-missing-price':''}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx},'unitPrice',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;text-align:right;">${(Number(item.qty||0)*Number(item.unitPrice||0)).toFixed(0)}</td>
                <td class="no-print" style="border:1px solid #999;padding:4px;text-align:center;"><button type="button" class="btn-small btn-danger" onclick="removePoItem(${idx})">刪除</button></td>
            `;
        } else {
            tr.innerHTML = `
                <td style="border:1px solid #999;padding:4px;"><input type="text" value="${escapeAttr(item.itemName||'')}" placeholder="品名" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'itemName',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="priceModelList" value="${escapeAttr(item.itemCode||'')}" placeholder="貨號" style="width:100%;box-sizing:border-box;" onchange="onDirectPoCodeChange(${idx},this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="poBrandList" value="${escapeAttr(item.brand||'')}" placeholder="廠牌" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'brand',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" step="1" value="${item.qty}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx}, 'qty', this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" min="0.01" step="0.01" value="${missingPrice ? '' : item.unitPrice}" placeholder="請填進貨單價" class="${missingPrice ? 'po-missing-price' : ''}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx}, 'unitPrice', this.value)">${missingPrice ? '<small class="po-missing-price-hint">缺少成本</small>' : ''}</td>
                <td style="border:1px solid #999;padding:4px;text-align:right;">${(item.qty * item.unitPrice).toFixed(0)}</td>
                <td class="no-print" style="border:1px solid #999;padding:4px;text-align:center;"><button type="button" class="btn-small btn-danger" onclick="removePoItem(${idx})">刪除</button></td>
            `;
        }
        tbody.appendChild(tr);
    });
    recalcPoTotals();
}

window.updatePoItem = function(idx, field, value) {
    if (!poItems[idx]) return;
    poItems[idx][field] = field === 'unitPrice' && String(value).trim() === '' ? null : parseFloat(value);
    renderPoItemsTable();
};

window.removePoItem = function(idx) {
    const removed = poItems[idx];
    poItems.splice(idx, 1);
    poAllItems = poAllItems.filter(item => item !== removed);
    window.autoFillPoExpectedDate(poItems);
    renderPoItemsTable();
};

function recalcPoTotals() {
    const amounts=globalThis.YushinSupplier.purchaseAmountMetadata(poItems);
    document.getElementById('poSubtotal').innerText = amounts.subtotalExTax.toLocaleString();
    document.getElementById('poTax').innerText = amounts.taxAmount.toLocaleString();
    document.getElementById('poGrandTotal').innerText = amounts.totalIncTax.toLocaleString();
}

function formalSupplyOrderId(purchaseOrderId, itemIndex) {
    return `po-${encodeURIComponent(String(purchaseOrderId||''))}-${Number(itemIndex||0)}`;
}

function assertPurchaseLinesAvailable(order, lines) {
    if(orderInventorySyncIncomplete(order))throw new Error('來源訂單庫存尚未同步完成，請稍後再採購。');
    if (normalizedOrderStatus(order) !== 'normal') throw new Error('來源訂單已取消或作廢。');
    const sourceItems = normalizedOrderItems(order);
    const requestedByIndex = new Map();
    for (const line of lines) {
        const index = Number(line.orderItemIndex);
        const source = sourceItems[index];
        const sourceItemCode = String(source?.itemCode || '').trim();
        const lineItemCode = String(line?.itemCode || '').trim();
        const stableItemMismatch = !!(line?.itemId && source?.itemId && line.itemId !== source.itemId);
        if (!Number.isInteger(index) || !source || stableItemMismatch
            || (sourceItemCode && lineItemCode && sourceItemCode !== lineItemCode)) {
            throw new Error('來源訂單品項已變更，請重新建立採購單。');
        }
        requestedByIndex.set(index, (requestedByIndex.get(index) || 0) + Number(line.qty || 0));
    }
    for (const [index, qty] of requestedByIndex) {
        const source = sourceItems[index];
        const remaining = remainingProcurementQty(order, source);
        if (!(qty > 0) || qty > remaining + 1e-9) throw new Error('待採購數量已變更，請重新開啟來源訂單。');
    }
}

function poPdfFileName(poNo, vendorName) {
    const raw = [poNo, vendorName].filter(Boolean).join('-') || '採購單';
    return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.pdf';
}

function normalizePoPdfFields(root) {
    const expected=root.querySelector('#poExpectedDate');
    if(expected){const label=expected.parentElement.querySelector('label[style]');if(label)label.style.display='';}
    root.querySelectorAll('.no-print').forEach(node => node.remove());
    root.querySelectorAll('input').forEach(input => {
        const span = document.createElement('span');
        span.className = 'po-pdf-field-value';
        span.textContent = input.value || '';
        input.replaceWith(span);
    });
    root.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
}

function createPoPdfStage() {
    const source = document.getElementById('printablePO');
    if (!source) throw new Error('找不到採購單內容');

    const stage = document.createElement('div');
    stage.className = 'quote-pdf-stage po-pdf-stage';
    const documentNode = document.createElement('div');
    documentNode.className = 'po-pdf-document po-pdf-page';
    const text = id => document.getElementById(id)?.textContent || '';
    const value = id => document.getElementById(id)?.value || '';
    documentNode.innerHTML = `
        <div class="header-container"><div class="header-info">
            <h1>${escapeHtml(text('poCompTitle'))}</h1><h2>${escapeHtml(text('poCompSub'))}</h2>
            <p>${escapeHtml(text('poCompAddr'))}</p><p>${escapeHtml(text('poCompContact'))}</p>
        </div></div>
        <h2 style="text-align:center;letter-spacing:10px;margin:10px 0;">採 購 單</h2>
        <div class="meta-row-three">
            <div>抬頭：${escapeHtml(value('poVendorName'))}</div>
            <div>採購人員：${escapeHtml(text('poBuyerName'))}</div>
            <div>採購日期：${escapeHtml(value('poDate'))}</div>
        </div>
        <div class="meta-row-three"><div>預計到貨日：${escapeHtml(value('poExpectedDate'))}</div><div>單號：${escapeHtml(text('poNo'))}</div></div>
        <table style="width:100%;margin-top:8px;border-collapse:collapse;">
            <thead><tr><th>品名 / 規格</th><th>貨號</th><th>廠牌</th><th>數量</th><th>單價</th><th>小計</th></tr></thead>
            <tbody>${poItems.map(item => `<tr><td>${escapeHtml(item.itemName||'')}${item.spec?`<br>${escapeHtml(item.spec)}`:''}</td><td>${escapeHtml(item.itemCode||'')}</td><td>${escapeHtml(item.brand||'')}</td><td>${Number(item.qty||0)}</td><td>${Number(item.unitPrice||0).toLocaleString('zh-TW')}</td><td>${(Number(item.qty||0)*Number(item.unitPrice||0)).toLocaleString('zh-TW')}</td></tr>`).join('')}</tbody>
        </table>
        <div class="po-total-section" style="text-align:right;margin-top:10px;">
            <p>未稅合計：NT$ ${escapeHtml(text('poSubtotal'))}</p><p>營業稅（5%）：NT$ ${escapeHtml(text('poTax'))}</p><p><b>總計金額：NT$ ${escapeHtml(text('poGrandTotal'))}</b></p>
        </div>`;
    stage.appendChild(documentNode);
    document.body.appendChild(stage);
    return { stage, documentNode };
}

function createPoPdfPage(stage, source, includeHeader = false) {
    const page = document.createElement('div');
    page.className = 'po-pdf-page';

    const sourceTable = source.querySelector('table');
    if (includeHeader) {
        for (const child of [...source.children]) {
            if (child === sourceTable) break;
            page.appendChild(child.cloneNode(true));
        }
    }

    const table = sourceTable.cloneNode(false);
    table.removeAttribute('id');
    const thead = sourceTable.querySelector('thead');
    if (thead) table.appendChild(thead.cloneNode(true));
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    page.appendChild(table);
    stage.appendChild(page);
    return { page, tbody };
}

function paginatePoPdfDocument(stage, source) {
    const sourceTable = source.querySelector('table');
    if (!sourceTable) return [source];
    const rows = [...sourceTable.querySelectorAll('tbody tr')];
    const summary = source.querySelector('.po-total-section');
    const maxHeight = quotePdfPageHeightPx(stage);

    source.style.display = 'none';
    const pages = [];
    let current = createPoPdfPage(stage, source, true);
    pages.push(current);

    for (const row of rows) {
        const clone = row.cloneNode(true);
        current.tbody.appendChild(clone);
        if (current.page.scrollHeight > maxHeight && current.tbody.children.length > 1) {
            clone.remove();
            current = createPoPdfPage(stage, source, false);
            pages.push(current);
            current.tbody.appendChild(clone);
        }
    }

    if (summary) {
        const summaryClone = summary.cloneNode(true);
        current.page.appendChild(summaryClone);
        if (current.page.scrollHeight > maxHeight) {
            summaryClone.remove();
            const donor = current;
            const finalPage = createPoPdfPage(stage, source, false);
            pages.push(finalPage);
            finalPage.page.appendChild(summaryClone);

            // 與估價單相同：最後一頁優先保留合計區，再把前頁最後的品項往後搬，
            // 只要超出 A4 可用高度就立即放回，避免產生大片空白或切到合計內容。
            while (donor.tbody.lastElementChild) {
                const candidate = donor.tbody.lastElementChild;
                finalPage.tbody.prepend(candidate);
                if (finalPage.page.scrollHeight > maxHeight) {
                    donor.tbody.appendChild(candidate);
                    break;
                }
            }
        }
    }

    source.remove();
    return pages.map(entry => entry.page);
}

async function printSavedPoDocument(poNo, vendorName) {
    const options=arguments[2]||{};
    let stage = null;
    const button = document.getElementById('printPurchaseOrderBtn');
    const download = options.download !== false;
    const modalGeneration = poDirectStockOpenGeneration;
    const exportingPoId = poEditingId;
    try {
        if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
            throw new Error('PDF 元件尚未載入');
        }

        if (button) {
            button.disabled = true;
            button.innerText = download ? '準備 PDF…' : '準備附件…';
        }
        updatePoSaveStatus(download ? '正在準備採購單 PDF…' : '正在準備郵件附件…');

        const exportDom = createPoPdfStage();
        stage = exportDom.stage;
        await waitForPdfImages(exportDom.documentNode);

        const isSinglePage = exportDom.documentNode.scrollHeight <= quotePdfPageHeightPx(stage) - 12;
        const pages = isSinglePage ? [exportDom.documentNode] : paginatePoPdfDocument(stage, exportDom.documentNode);
        if (!isSinglePage) await waitForPdfImages(stage);

        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const scale = isMobile ? 1.15 : 1.65;
        const pdf = new window.jspdf.jsPDF({ orientation:'portrait', unit:'mm', format:'a4', compress:!isSinglePage });

        await addDocumentPagesToPdf(pdf, pages, {
            scale,
            isolateRoot:stage,
            onProgress: (pageNo, pageCount) => {
                if (button) button.innerText = `正在產生 PDF… ${pageNo}/${pageCount}`;
                updatePoSaveStatus(`正在產生採購單 PDF… ${pageNo}/${pageCount}`);
            }
        });

        const fileName=poPdfFileName(poNo, vendorName);
        const blob=pdf.output('blob');
        if(download){
            if (button) button.innerText = '正在下載 PDF…';
            if (await window.DocumentDownloads.savePdf('purchase', pdf, fileName) === false) {
                updatePoSaveStatus('採購單 PDF 已產生；已取消匯出');
                return {blob,fileName};
            }
            updatePoSaveStatus('✓ 採購單 PDF 已產生');
            if(poDirectStockOpenGeneration===modalGeneration&&poEditingId===exportingPoId)closePurchaseOrderModal();
            showActionFeedback(`採購單 ${poNo} PDF 已匯出。`,'success');
        }else{
            updatePoSaveStatus('✓ 採購單 PDF 附件已準備');
        }
        return {blob,fileName};
    } finally {
        stage?.remove();
    }
}

window.printPurchaseOrder = async function() {
    if (poSaveInProgress) return;
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    if (globalThis.YUSHIN_FORMAL_PURCHASE_EMULATOR === true) {
        try { if (pendingFormalPurchase()) { await recoverFormalPurchase(); return; } }
        catch (error) { updatePoSaveStatus(error.message, true); return; }
    }
    const leadDaysInput=document.getElementById('poLeadDays');
    if(!poEditingId&&leadDaysInput?.value&&(!Number.isInteger(Number(leadDaysInput.value))||Number(leadDaysInput.value)<0)){
        updatePoSaveStatus('預計交期請輸入 0 或以上的整數天數。',true);
        return;
    }
    if (!poEditingId && !poNoReady) {
        updatePoSaveStatus(poNoLoading ? '採購單號仍在產生中，完成後即可列印 / 存為 PDF。' : '採購單號尚未就緒，請切換公司或重新開啟後再試。', !poNoLoading);
        return;
    }
    const actorUid=currentUser?.uid, actorRole=currentUserRole;
    poSaveInProgress = true;
    try { await window.DocumentDownloads.prepare('purchase'); }
    catch (err) { updatePoSaveStatus(err.message, true); return; }
    finally { poSaveInProgress = false; }
    if (poEditingId) {
        const savedPo = poListCache.find(po => po.id === poEditingId);
        if (!savedPo) { alert('找不到已儲存的採購單，請重新整理。'); return; }
        if (!poIncomingSyncPending) {
            const button = document.getElementById('printPurchaseOrderBtn');
            poSaveInProgress = true;
            try {
                await printSavedPoDocument(savedPo.poNo, savedPo.vendorName);
                db.collection('purchaseOrders').doc(savedPo.id).set({
                    lastOutputAt: new Date().toISOString(),
                    lastOutputType: 'PDF'
                }, { merge:true }).catch(err => console.warn('更新採購單輸出時間失敗：', err));
            } catch (err) {
                console.error('產生採購單 PDF 失敗：', err);
                updatePoSaveStatus('產生採購單 PDF 失敗：' + (err?.message || err), true);
            } finally {
                poSaveInProgress = false;
                if (button) button.disabled = false;
                updatePoSaveButton();
            }
            return;
        }
        const button = document.getElementById('printPurchaseOrderBtn');
        poSaveInProgress = true;
        if (button) { button.disabled = true; button.innerText = '同步雲端後開啟列印…'; }
        try {
            await registerPurchaseIncoming(savedPo.id, savedPo, {actorUid,actorRole,onStockCommitted:invalidateWarehouseStockCache});
            poIncomingSyncPending = false;
            updatePoSaveStatus(`採購單 ${savedPo.poNo} 已同步雲端，正在產生 PDF…`);
            await printSavedPoDocument(savedPo.poNo, savedPo.vendorName);
        } catch (err) {
            updatePoSaveStatus(`採購單已同步雲端，但在途庫存同步仍未完成：${err.message}`, true);
        } finally {
            poSaveInProgress = false;
            if (button) button.disabled = false;
            updatePoSaveButton();
        }
        return;
    }
    if (poItems.length === 0) {
        alert('目前沒有任何品項，請先選取或不要刪光所有品項。');
        return;
    }
    if (poItems.some(item => !Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0)) {
        alert('每個採購品項的數量都必須大於 0。');
        return;
    }
    if (poDirectStockMode && poItems.some(item => (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP')) {
        alert('新增庫存採購單是公司庫存採購，不能設定為原廠直送。');
        return;
    }
    if (poDirectStockMode && poItems.some(item => !String(item.warehouseId || defaultWarehouse()?.id || '').trim())) {
        alert('新增庫存採購單必須指定入庫倉庫，請先建立或選擇倉庫。');
        return;
    }
    if (poDirectStockMode) {
        const unmatchedStockItems = poItems.filter(item => {
            const productId = String(item.productId || '').trim();
            const match = findPriceItemForOrder({ itemCode:item.itemCode || '', brand:item.brand || '' });
            if (!productId || !match) return true;
            const matchedProductId = String(match.productId || stableProductId(match) || '').trim();
            return matchedProductId !== productId
                || normalizeBrandLookupKey(match.brand || '') !== normalizeBrandLookupKey(item.brand || '');
        });
        if (unmatchedStockItems.length) {
            alert('庫存採購的每個品項都必須對應產品主檔。請重新選擇有效貨號後再建立採購單。');
            return;
        }
    }
    if (poItems.some(item => (item.fulfillmentType || 'WAREHOUSE') !== 'DIRECT_SHIP' && !String(item.warehouseId || defaultWarehouse()?.id || '').trim())) {
        alert('入庫品項必須有倉庫，請先在倉庫管理建立預設倉庫。');
        return;
    }
    const invalidIdentityItems = poItems.filter(item => !String(item.itemCode||'').trim() || !String(item.itemName||'').trim() || !String(item.brand||'').trim());
    if (invalidIdentityItems.length) {
        alert('請完成每個採購品項的貨號、品名與廠牌。');
        return;
    }
    const missingPriceItems = poItems.filter(item => item.unitPrice === null || item.unitPrice === undefined || item.unitPrice === '' || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0);
    if (missingPriceItems.length) {
        alert(`以下品項尚未填入有效的進貨單價：${missingPriceItems.map(item => item.itemName || item.itemCode || '未命名品項').join('、')}`);
        return;
    }
    // 訂單裡存的廠牌，如果當初是透過估價單「其他（自行輸入）」填的自訂名稱，不會出現在正式廠牌清單裡；
    // 只要目前公司有開放「其他廠牌」，這種自訂名稱就不能當作違規
    if (poItems.some(item => !isCompanyBrandAllowed(poCurrentCompany, item.brand) && !isCompanyOtherOptionAllowed(poCurrentCompany))) {
        alert('採購單含有不屬於目前分公司代理的廠牌，請切換分公司或移除該品項。');
        return;
    }
    const vendorName = document.getElementById('poVendorName').value.trim();
    if (!vendorName) {
        alert('請填寫供應商名稱。');
        return;
    }
    const poNo = document.getElementById('poNo').innerText.trim();
    if (!poNo || poNo === '產生中…' || poNo === '—') {
        updatePoSaveStatus('採購單號尚未就緒，請切換公司或重新開啟後再試。', true);
        return;
    }
    const orderIds = [...new Set(poItems.map(item => item.orderId).filter(Boolean))];
    const supplierContact = supplierForVendorName(vendorName);
    if (!globalThis.YushinSupplier?.snapshotForPurchaseOrder) {
        throw new Error('Supplier core 未載入，無法建立供應商快照。');
    }
    const supplierSnapshot=globalThis.YushinSupplier.snapshotForPurchaseOrder(
        supplierContact||{},
        {supplierName:vendorName,purchaseHeaderName:vendorName}
    );
    const poDate=document.getElementById('poDate').value;
    const expectedDateInput=document.getElementById('poExpectedDate');
    const expectedDate=expectedDateInput?.value||'';
    const expectedDateSource=expectedDateInput?.dataset.expectedDateSource
        || (expectedDate ? 'manual' : '');
    const scheduledPoItems=poItemsWithScheduleDates(
        poItems,
        supplierSnapshot.supplierId||'',
        poDate,
        expectedDate,
        expectedDateSource
    );
    const poRecord = {
        poNo,
        company: poCurrentCompany,
        vendorName:supplierSnapshot.purchaseHeaderName||vendorName,
        supplierId:supplierSnapshot.supplierId||'',
        supplierName:supplierSnapshot.supplierName||vendorName,
        supplierEmail:supplierSnapshot.email||'',
        supplierSnapshot,
        buyerName: document.getElementById('poBuyerName').innerText || currentUserName || '',
        poDate,
        expectedDate,
        expectedDateSource,
        scheduleDate:expectedDate,
        purchaseType: poItems.every(item => !item.orderId) ? 'stock' : 'order',
        items: scheduledPoItems.map(item => {
            const brand = resolveBrandName(item.brand || '');
            return { ...item, brand, brandId:item.brandId || brandIdForName(brand) };
        }),
        ...globalThis.YushinSupplier.purchaseAmountMetadata(scheduledPoItems),
        createdAt: new Date().toISOString(),
        lastOutputAt: new Date().toISOString(),
        lastOutputType: 'PDF',
        ...linkedDocumentFields(orderIds.length === 1 ? DOCUMENT_TYPES.ORDER : '', orderIds.length === 1 ? orderIds[0] : '', orderIds.map(orderId => documentLink(DOCUMENT_TYPES.ORDER, orderId, 'source')))
    };
    poRecord.searchTokens=purchaseOrderSearchTokens(poRecord);
    const button = document.getElementById('printPurchaseOrderBtn');
    poSaveInProgress = true;
    if (button) {
        button.disabled = true;
        button.innerText = '同步雲端中…';
    }
    updatePoSaveStatus('正在同步採購單到雲端…');
    let poCommitted = false;
    try {
        const poDocumentId = poNo;
        rememberFormalPurchase(poRecord, actorUid, actorRole);
        const commitPromise = commitFormalPurchaseOrder(poRecord, {actorUid,actorRole});

        // 採購單會同時改寫來源訂單與供應紀錄，不能像估價單一樣「先印再存」：
        // 若 iPhone 在列印畫面直接關閉頁面，背景 transaction 可能尚未完成，會造成紙本已下單但系統沒有紀錄。
        // 只等待這個最小且必要的核心 transaction；在途庫存仍於列印後背景同步。
        updatePoSaveStatus('正在確認並儲存採購單…');
        const {poRecord:committedRecord,committedSourceOrders,committedSupplyOrders} = await commitPromise;
        Object.assign(poRecord,committedRecord);
        poCommitted = true;
        const savedPo = cacheCommittedFormalPurchase({poRecord,committedSourceOrders,committedSupplyOrders});
        poEditingId = savedPo.id;
        poIncomingSyncPending = true;
        updatePoModeUI();
        updatePoSaveStatus(`採購單 ${poNo} 已同步雲端；正在產生 PDF，在途庫存稍後背景同步…`);

        // 核心 transaction 完成後才輸出 PDF，確保使用者拿到的正式文件一定有對應的系統紀錄。
        // PDF 使用與估價單相同的逐頁 Canvas → jsPDF 流程，不再依賴瀏覽器列印視窗。
        await printSavedPoDocument(poNo, vendorName);

        // PO 與來源訂單已在上方同一個 transaction 成功提交；列印不等待第二段在途庫存同步。
        // 在途同步以 PO id 冪等處理，失敗時仍可由同一張 PO 重試，不會重複建立採購單。
        registerPurchaseIncoming(poDocumentId, poRecord, {actorUid,actorRole,onStockCommitted:invalidateWarehouseStockCache})
            .then(() => {
                if (currentUser?.uid !== actorUid || currentUserRole !== actorRole) return;
                clearFormalPurchasePending(poDocumentId, actorUid, actorRole);
                if(poEditingId===poDocumentId)poIncomingSyncPending = false;
                if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
                if(poEditingId===poDocumentId){
                    updatePoSaveStatus(`採購單 ${poNo} 已建立；在途庫存同步完成。`);
                    updatePoSaveButton();
                }
            })
            .catch(err => {
                if (currentUser?.uid !== actorUid || currentUserRole !== actorRole) return;
                console.error('採購單在途庫存背景同步失敗：', err);
                if(poEditingId===poDocumentId){
                    poIncomingSyncPending = true;
                    updatePoSaveStatus(`採購單已同步雲端，但在途庫存同步未完成：${err.message}。請由這張採購單重試同步，不要另建一張。`, true);
                    updatePoSaveButton();
                }
                showActionFeedback(`採購單 ${poNo} 已建立；在途同步未完成，請開啟這張採購單重試。`,'warning');
            });
    } catch (err) {
        console.error('儲存採購單紀錄失敗：', err);
        updatePoSaveStatus(poCommitted
            ? `採購單已同步雲端，但在途庫存同步未完成：${err.message}`
            : globalThis.YUSHIN_FORMAL_PURCHASE_EMULATOR === true
                ? `採購結果尚未確認，請保留原單號並確認前次結果：${err.message}`
                : `採購單未建立：${err.message}`, true);
        alert(poCommitted
            ? '採購單已同步雲端，但在途庫存同步未完成。請在這張採購單按「重試同步在途庫存」，不要另建一張：' + err.message
            : globalThis.YUSHIN_FORMAL_PURCHASE_EMULATOR === true
                ? '採購結果尚未確認，請勿另建採購單；請使用「確認前次採購結果」核對：' + err.message
                : '無法產生採購單：' + err.message);
    } finally {
        poSaveInProgress = false;
        if (button) {
            button.disabled = false;
        }
        updatePoSaveButton();
        renderFormalPurchaseRecovery();
    }
};

// 「製作下一張估價單」：手動觸發，不會因為誤按列印視窗的取消鈕就被清空。
// 按下後會先確認，避免不小心點到把還沒印的內容洗掉；確認後清空表單、單號跳下一號，
// 並且立刻把這個「全新、還是空的」狀態存成本機草稿，這樣萬一使用者按完馬上關網頁，
// 重開時看到的會是這張全新的空白單，而不是被清掉的上一張。
