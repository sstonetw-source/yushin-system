/* =========================================================
   產品：產品主檔搜尋與管理
   - 直接查 Firestore products，不依賴目前已載入的快取
   - 管理員／採購可編輯、停用與重新啟用；不永久刪除歷史關聯
   - 不讀 productCosts，避免一般業務畫面暴露成本
   ========================================================= */
let productManagementResults = [];
const productManagementSelection = new Map();
let productManagementSearchInProgress = false;
let productManagementSearchTimer = null;
let productManagementSearchGeneration = 0;
const PRODUCT_MANAGEMENT_RENDER_STEP = 100;
let productManagementVisibleLimit = PRODUCT_MANAGEMENT_RENDER_STEP;

let pendingProductMasterLoading = false;
let pendingProductMasterRows = [];
let pendingProductMasterIgnoredItems = [];
let productBatchMaintenanceInProgress = false;
let productManagementSourceMode = 'none';

function setProductBatchMaintenanceBusy(busy) {
    productBatchMaintenanceInProgress = !!busy;
    document.querySelectorAll('#productBatchMaintenance button').forEach(button => {
        button.disabled = productBatchMaintenanceInProgress;
    });
}

function canManagePendingProductMaster() {
    return currentUserRole === 'admin' || currentUserRole === 'purchaser';
}

function canDeleteProductMaster() {
    // 管理員切成其他角色視角時也不能誤觸永久刪除。
    return trueUserRole === 'admin' && currentUserRole === 'admin';
}

function updatePendingProductMasterButton() {
    const allowed = canManagePendingProductMaster();
    const tools = document.getElementById('productManagementTools');
    const createButton = document.getElementById('createProductMasterBtn');
    const inactiveWrap = document.getElementById('productManagementInactiveWrap');
    const batchMaintenance = document.getElementById('productBatchMaintenance');
    if (tools) tools.style.display = allowed ? '' : 'none';
    if (createButton) createButton.style.display = allowed ? '' : 'none';
    if (inactiveWrap) inactiveWrap.style.display = allowed ? '' : 'none';
    if (batchMaintenance) batchMaintenance.style.display = allowed ? '' : 'none';
}

function updateProductSearchControls() {
    const selected = !!document.getElementById('productManagementSearchBrand')?.value;
    const input = document.getElementById('productManagementSearch');
    const button = document.getElementById('productManagementSearchBtn');
    // Exact product-code lookup works without a brand; selecting one narrows the result.
    if (input) input.disabled = false;
    const frequentButton = document.getElementById('productManagementFrequentBtn');
    if (frequentButton) frequentButton.disabled = !selected || productManagementSearchInProgress;
    if (button) button.disabled = productManagementSearchInProgress || !String(input?.value || '').trim();
}

window.onProductSearchBrandChange = function() {
    clearProductManagementSearch();
    updateProductSearchControls();
    return loadFrequentProducts(document.getElementById('productManagementSearchBrand')?.value);
};

// Discover only quick-created products, one bounded page when Other is opened.
const quickProductBrowserBrands = { key:'', rows:[], cursor:null, hasMore:true, loaded:false, loading:false, error:'' };
function resetQuickProductBrowserBrands() {
    const key=[currentUser?.uid||'',currentUserRole,sessionDataGeneration].join(':');
    if (quickProductBrowserBrands.key!==key) Object.assign(quickProductBrowserBrands,{key,rows:[],cursor:null,hasMore:true,loaded:false,loading:false,error:''});
    return quickProductBrowserBrands;
}
async function loadQuickProductBrowserBrands(more=false) {
    if (!canAccessPage('products')) return;
    const state=resetQuickProductBrowserBrands();
    if(state.loading||(!more&&state.loaded)||(more&&!state.hasMore))return;
    const key=state.key;state.loading=true;state.error='';renderProductBrandBrowser();
    try {
        let query=db.collection('products').where('source','==','QUICK_CREATE').limit(50);
        if(state.cursor)query=query.startAfter(state.cursor);
        const page=await firestoreReadWithTimeout(query.get(),'其他廠牌');
        if(resetQuickProductBrowserBrands().key!==key)return;
        state.rows.push(...page.docs.map(doc=>({id:doc.id,...doc.data()})));
        state.cursor=page.docs.at(-1)||state.cursor;state.hasMore=page.size===50;state.loaded=true;
    } catch(err) {
        if(state.key===key)state.error='其他廠牌載入失敗，請重試。';
    } finally { if(state.key===key){state.loading=false;renderProductBrandBrowser();} }
}
function productBrowserBrandEntries() {
    const entries=new Map(getUnifiedBrandEntries(false).filter(entry=>entry?.name&&entry.active!==false).map(entry=>[normalizeBrandLookupKey(entry.name),entry]));
    const state=resetQuickProductBrowserBrands();
    [...state.rows,...productManagementResults].forEach(product=>{
        if(product.active===false||product.status==='INACTIVE')return;
        const name=resolveBrandName(product.brandName||product.brand||'');
        const key=normalizeBrandLookupKey(name);
        if(key&&!entries.has(key))entries.set(key,{name,active:true});
    });
    return [...entries.values()].sort((a,b)=>a.name.localeCompare(b.name,'zh-Hant'));
}
let productSearchOtherBrandsExpanded = false;
window.selectProductSearchBrand = function(brand) {
    const field = document.getElementById('productManagementSearchBrand');
    if (!field) return;
    field.value = brand;
    onProductSearchBrandChange();
};
window.toggleProductSearchOtherBrands = function() {
    productSearchOtherBrandsExpanded = !productSearchOtherBrandsExpanded;
    renderProductBrandBrowser();
    if(productSearchOtherBrandsExpanded)void loadQuickProductBrowserBrands();
};
window.renderProductBrandBrowser = function() {
    const container = document.getElementById('productSearchBrandButtons');
    const selected = document.getElementById('productManagementSearchBrand')?.value || '';
    updateProductSearchControls();
    if (!container) return;
    const entries = productBrowserBrandEntries();
    const primaryKeys = new Set(getPrimaryBrandNames().map(normalizeBrandLookupKey));
    const primary = entries.filter(entry => primaryKeys.has(normalizeBrandLookupKey(entry.name)));
    const others = entries.filter(entry => !primaryKeys.has(normalizeBrandLookupKey(entry.name)));
    const button = entry => `<button type="button" class="product-brand-button${entry.name === selected ? ' active' : ''}" aria-pressed="${entry.name === selected}" onclick="selectProductSearchBrand(${inlineJsValue(entry.name)})">${escapeHtml(entry.name)}</button>`;
    let html = primary.map(button).join('');
    {
        const selectedOther = others.some(entry => entry.name === selected);
        html += `<button type="button" class="product-brand-button${selectedOther ? ' active' : ''}" aria-expanded="${productSearchOtherBrandsExpanded}" onclick="toggleProductSearchOtherBrands()">其他${productSearchOtherBrandsExpanded ? ' ▲' : ' ▼'}${selectedOther && !productSearchOtherBrandsExpanded ? '：' + escapeHtml(selected) : ''}</button>`;
        if (productSearchOtherBrandsExpanded) {
            html += others.map(button).join('');
            const state=resetQuickProductBrowserBrands();
            if(state.loading)html+='<span role="status">正在載入其他廠牌…</span>';
            else if(state.error)html+=`<button type="button" class="btn-secondary" onclick="loadQuickProductBrowserBrands(true)">${escapeHtml(state.error)}</button>`;
            else if(state.loaded&&state.hasMore)html+='<button type="button" class="btn-secondary" onclick="loadQuickProductBrowserBrands(true)">載入更多其他廠牌</button>';
        }
    }
    container.innerHTML = html || '<span>目前沒有可選擇的廠牌。</span>';
};

async function ensureProductBrandBrowserLoaded() {
    try {
        await loadBrandMaster();
        renderProductBrandBrowser();
    } catch (err) {
        mainPageLoadFailed('products');
        console.warn('產品主檔廠牌瀏覽載入失敗：', err);
        const container = document.getElementById('productSearchBrandButtons');
        if (container) container.innerHTML = '<span class="product-brand-browser-empty">廠牌載入失敗，請稍後再試。</span>';
    }
}

function pendingProductKey(item = {}) {
    const brand = normalizeBrandLookupKey(resolveBrandName(item.brand || ''));
    const code = normalizeItemCodeLoose(item.itemCode || item.model || '');
    const name = String(item.itemName || item.nameCn || item.nameEn || '').normalize('NFKC').trim().toLocaleLowerCase();
    return code ? `${brand}::${code}` : `${brand}::name:${name}`;
}

function collectPendingProductRowsFromDocument(doc, sourceType) {
    const items = Array.isArray(doc.items) ? doc.items : [];
    const date = doc.orderDate || doc.quoteDate || doc.createdAt || '';
    const reference = sourceType === 'order' ? (doc.id || '') : (doc.quoteNo || doc.id || '');
    return items
        .filter(item => item.productMasterMatched !== true)
        .map(item => ({
            key: pendingProductKey(item),
            sourceType,
            reference,
            date,
            itemCode: item.itemCode || item.model || '',
            itemName: item.itemName || item.nameCn || item.nameEn || '',
            brand: item.brand || ''
        }))
        .filter(row => row.itemCode || row.itemName);
}

function setProductManagementTableMode(mode = 'products') {
    const head = document.getElementById('productManagementHead');
    if (!head) return;
    head.dataset.mode = mode;
    head.innerHTML = mode === 'pending'
        ? '<tr><th>貨號</th><th>品名</th><th>廠牌</th><th>來源</th><th>最近使用</th><th>次數</th><th class="no-print">操作</th></tr>'
        : '<tr><th class="no-print product-selection-head"><input id="productManagementSelectVisible" type="checkbox" aria-label="選取目前顯示的產品" onchange="toggleVisibleProductManagementSelection(this.checked)"></th><th>貨號</th><th>品名</th><th>廠牌</th><th>產品線</th><th>類型</th><th>規格</th><th>建議售價</th><th>狀態</th><th class="no-print">操作</th></tr>';
    const moreRow = document.getElementById('productManagementMoreRow');
    if (moreRow && mode === 'pending') moreRow.style.display = 'none';
    updateProductManagementSelectionBar();
}

function renderPendingProductMasterRows() {
    const host=document.getElementById('pendingProductHealthResults');
    if(host)host.innerHTML='<div class="table-wrap"><table><thead><tr><th>貨號</th><th>品名</th><th>廠牌</th><th>來源</th><th>最近使用</th><th>次數</th><th>操作</th></tr></thead><tbody id="pendingProductHealthBody"></tbody></table></div>';
    const body = document.getElementById('pendingProductHealthBody');
    if (!body) return;
    if (!pendingProductMasterRows.length) {
        body.innerHTML = '<tr><td colspan="7" class="empty-hint">目前沒有待補產品主檔的近期品項。</td></tr>';
        return;
    }
    const canIgnore = trueUserRole === 'admin' && currentUserRole === 'admin';
    body.innerHTML = pendingProductMasterRows.map((row,index) => `<tr>
        <td data-th="貨號">${escapeHtml(row.itemCode || '－')}</td>
        <td data-th="品名">${escapeHtml(row.itemName || '－')}</td>
        <td data-th="廠牌">${escapeHtml(row.brand || '－')}</td>
        <td data-th="來源">${escapeHtml(row.sources.join('、'))}</td>
        <td data-th="最近使用">${escapeHtml(row.latestDate || '－')}</td>
        <td data-th="次數">${row.count}</td>
        <td data-th="操作" class="no-print product-pending-actions">
            ${canManagePendingProductMaster() ? `<button type="button" class="btn-small" onclick="openPendingProductMasterEditor(${index})">補主檔</button>` : ''}
            ${canIgnore ? `<button type="button" class="btn-small btn-secondary" onclick="ignorePendingProductMaster(${index})">移除待補</button>` : ''}
        </td>
    </tr>`).join('');
}

async function loadIgnoredPendingProducts() {
    const snap = await firestoreReadWithTimeout(
        db.collection('settings').doc('productMasterPending').get(),
        '已移除待補產品'
    );
    const rows = snap.exists && Array.isArray(snap.data()?.ignoredItems) ? snap.data().ignoredItems : [];
    pendingProductMasterIgnoredItems = rows.filter(item => item?.key);
    return pendingProductMasterIgnoredItems;
}

function ignoredPendingProductKeys() {
    return new Set((pendingProductMasterIgnoredItems || []).map(item => String(item.key || '')));
}

window.ignorePendingProductMaster = async function(index) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    const row = pendingProductMasterRows[index];
    if (!row) return;
    const key = row.key || pendingProductKey(row);
    const label = [row.brand, row.itemCode, row.itemName].filter(Boolean).join(' / ');
    if (!confirm(`從「待補產品」移除「${label || '此品項'}」？\n\n只會移除待補提醒，不會刪除原估價單、訂單或其他歷史資料。`)) return;
    try {
        await loadIgnoredPendingProducts();
        const now = new Date().toISOString();
        const next = pendingProductMasterIgnoredItems
            .filter(item => item.key !== key)
            .concat([{ key, brand:row.brand || '', itemCode:row.itemCode || '', itemName:row.itemName || '', ignoredAt:now }])
            .slice(-500);
        await db.collection('settings').doc('productMasterPending').set({
            ignoredItems: next,
            updatedAt: now,
            updatedBy: currentUser?.uid || ''
        }, { merge:true });
        pendingProductMasterIgnoredItems = next;
        pendingProductMasterRows.splice(index, 1);
        renderPendingProductMasterRows();
        const status = document.getElementById('productManagementSearchStatus');
        if (status) status.textContent = '已從待補清單移除；來源估價單／訂單未變更。';
    } catch (err) {
        console.error('移除待補產品失敗：', err);
        alert('移除待補產品失敗：' + (err?.message || err));
    }
};

window.openIgnoredPendingProducts = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    const button = actionButtonFromEventOrSelector('#ignoredPendingProductBtn');
    const buttonState = beginActionButton(button, '載入中…');
    if (button && !buttonState) return;
    try {
        await loadIgnoredPendingProducts();
        let overlay = document.getElementById('ignoredPendingProductOverlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'ignoredPendingProductOverlay';
            overlay.className = 'eq-modal-overlay no-print';
            overlay.innerHTML = `
                <div class="eq-modal-box" style="max-width:760px;">
                    <div class="product-ignored-head"><h3>已移除待補產品</h3><div style="display:flex;gap:8px;"><button type="button" class="btn-secondary" onclick="clearIgnoredPendingProducts()">清空記錄</button><button type="button" class="btn-secondary" onclick="closeIgnoredPendingProducts()">✕ 關閉</button></div></div>
                    <p class="product-ignored-note">這裡只是待補提醒的忽略清單，不會刪除來源估價單或訂單。可隨時恢復。</p>
                    <div id="ignoredPendingProductList"></div>
                </div>`;
            overlay.addEventListener('click', event => { if (event.target === overlay) closeIgnoredPendingProducts(); });
            document.body.appendChild(overlay);
        }
        const list = document.getElementById('ignoredPendingProductList');
        const visibleItems = pendingProductMasterIgnoredItems.filter(item => item.archived !== true);
        list.innerHTML = visibleItems.length
            ? visibleItems.slice().reverse().map(item => `
                <div class="product-ignored-row">
                    <div><strong>${escapeHtml(item.brand || '未指定廠牌')} / ${escapeHtml(item.itemCode || '無貨號')}</strong><span>${escapeHtml(item.itemName || '')}</span></div>
                    <button type="button" class="btn-small" onclick="restoreIgnoredPendingProduct(${inlineJsValue(item.key)})">恢復待補</button>
                </div>`).join('')
            : '<div class="empty-hint">目前沒有已移除的待補產品。</div>';
        overlay.classList.add('active');
    } catch (err) {
        alert('讀取已移除待補產品失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
};


window.clearIgnoredPendingProducts = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    try {
        await loadIgnoredPendingProducts();
        const visibleItems = pendingProductMasterIgnoredItems.filter(item => item.archived !== true);
        if (!visibleItems.length) return;
        if (!confirm(`清空「已移除待補」中的 ${visibleItems.length} 筆記錄？\n\n這些品項仍會保持不再出現在待補清單，只會把這個歷史列表清空。`)) return;
        const now = new Date().toISOString();
        const next = pendingProductMasterIgnoredItems.map(item =>
            item.archived === true ? item : { ...item, archived:true, clearedAt:now }
        );
        await db.collection('settings').doc('productMasterPending').set({
            ignoredItems: next,
            updatedAt: now,
            updatedBy: currentUser?.uid || ''
        }, { merge:true });
        pendingProductMasterIgnoredItems = next;
        await openIgnoredPendingProducts();
        const status = document.getElementById('productManagementSearchStatus');
        if (status) status.textContent = '已清空「已移除待補」顯示記錄；這些品項仍維持不列入待補。';
    } catch (err) {
        console.error('清空已移除待補產品失敗：', err);
        alert('清空已移除待補產品失敗：' + (err?.message || err));
    }
};

window.closeIgnoredPendingProducts = function() {
    document.getElementById('ignoredPendingProductOverlay')?.classList.remove('active');
};

window.restoreIgnoredPendingProduct = async function(key) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    await loadIgnoredPendingProducts();
    const next = pendingProductMasterIgnoredItems.filter(item => item.key !== key);
    try {
        await db.collection('settings').doc('productMasterPending').set({
            ignoredItems: next,
            updatedAt: new Date().toISOString(),
            updatedBy: currentUser?.uid || ''
        }, { merge:true });
        pendingProductMasterIgnoredItems = next;
        await openIgnoredPendingProducts();
    } catch (err) {
        alert('恢復待補產品失敗：' + (err?.message || err));
    }
};

window.loadPendingProductMaster = async function() {
    if (!canManagePendingProductMaster() || pendingProductMasterLoading) return;
    const button = document.getElementById('pendingProductMasterBtn');
    const status = document.getElementById('pendingProductHealthStatus');
    pendingProductMasterLoading = true;
    if (button) { button.disabled = true; button.textContent = '讀取中…'; }
    if (status) status.textContent = '正在讀取近期待補品項…';
    try {
        await loadIgnoredPendingProducts();
        const ignoredKeys = ignoredPendingProductKeys();
        // 只有主動按下才查；兩個集合各最多 50 張，不掃描全部歷史資料。
        const [quoteSnap, orderSnap] = await Promise.all([
            firestoreReadWithTimeout(
                db.collection('quotes').where('productMasterMatched', '==', false).limit(50).get(),
                '待補產品主檔－估價單'
            ),
            firestoreReadWithTimeout(
                db.collection('orders').where('productMasterMatched', '==', false).limit(50).get(),
                '待補產品主檔－訂單'
            )
        ]);
        let rows = [
            ...(quoteSnap.docs || []).flatMap(doc => collectPendingProductRowsFromDocument({ id:doc.id, ...doc.data() }, 'quote')),
            ...(orderSnap.docs || []).flatMap(doc => collectPendingProductRowsFromDocument({ id:doc.id, ...doc.data() }, 'order'))
        ];

        // 交易文件上的 matched=false 是當時快照；之後若主檔已補齊，待補清單不應一直殘留。
        // 這段只在使用者主動按「待補 Product Master」時執行，且用貨號分批查詢，不影響日常頁面效能。
        const uniqueCodes = [...new Set(rows.map(row => normalizeItemCodeLoose(row.itemCode)).filter(Boolean))];
        const existingKeys = new Set();
        for (let i = 0; i < uniqueCodes.length; i += 10) {
            const chunk = uniqueCodes.slice(i, i + 10);
            const snap = await firestoreReadWithTimeout(
                db.collection('products').where('normalizedPartNo', 'in', chunk).get(),
                '核對待補產品主檔'
            );
            snap.docs.forEach(doc => {
                const data = doc.data() || {};
                if (data.status === 'INACTIVE' || data.active === false) return;
                existingKeys.add(`${normalizeBrandLookupKey(data.brandName || data.brand || '')}::${data.normalizedPartNo || normalizeItemCodeLoose(data.manufacturerPartNo || data.sku || '')}`);
            });
        }
        rows = rows.filter(row => {
            if (ignoredKeys.has(row.key)) return false;
            const code = normalizeItemCodeLoose(row.itemCode);
            if (!code) return true;
            return !existingKeys.has(`${normalizeBrandLookupKey(row.brand || '')}::${code}`);
        });

        const grouped = new Map();
        rows.forEach(row => {
            const key = row.key || `${row.sourceType}::${row.reference}::${row.itemCode}::${row.itemName}`;
            const current = grouped.get(key) || {
                key,
                itemCode:row.itemCode, itemName:row.itemName, brand:row.brand,
                latestDate:'', count:0, sources:[]
            };
            current.count += 1;
            if (String(row.date || '') > String(current.latestDate || '')) current.latestDate = row.date || '';
            const sourceLabel = row.sourceType === 'order' ? '訂單' : '估價單';
            if (!current.sources.includes(sourceLabel)) current.sources.push(sourceLabel);
            if (!current.itemCode && row.itemCode) current.itemCode = row.itemCode;
            if (!current.itemName && row.itemName) current.itemName = row.itemName;
            if (!current.brand && row.brand) current.brand = row.brand;
            grouped.set(key, current);
        });
        pendingProductMasterRows = [...grouped.values()]
            .sort((a,b) => String(b.latestDate || '').localeCompare(String(a.latestDate || '')))
            .slice(0, 100);
        renderPendingProductMasterRows();
        const input = document.getElementById('productManagementSearch');
        if (input) input.value = '';
        if (status) status.textContent = pendingProductMasterRows.length
            ? `待補產品主檔：${pendingProductMasterRows.length} 個近期品項。`
            : '目前沒有近期待補品項。';
    } catch (err) {
        console.error('讀取待補產品主檔失敗：', err);
        if (status) status.textContent = '待補清單讀取失敗，請稍後再試。';
    } finally {
        pendingProductMasterLoading = false;
        if (button) { button.disabled = false; button.textContent = '待補產品主檔'; }
    }
};

function productManagementRow(product, duplicate = false) {
    const productId = product.productId || product.id || '';
    const brand = resolveBrandName(product.brandName || product.brand || '');
    const price = isBrandPriceListActive(brand) ? Number(product.listPrice ?? product.price ?? 0) : 0;
    const status = product.status || (product.active === false ? 'INACTIVE' : 'ACTIVE');
    const inactive = status === 'INACTIVE' || product.active === false;
    const selected = !!productId && productManagementSelection.has(productId);
    const canQuote = !inactive && canEditPage('quote.create');
    const canOrder = !inactive && canEditPage('orders.list');
    const canDelete = !!productId && canDeleteProductMaster();
    return `<tr class="${selected ? 'is-selected' : ''}${inactive ? ' is-inactive' : ''}">
      <td data-th="選取" class="no-print product-management-select-cell"><input type="checkbox" ${selected ? 'checked' : ''} ${productId && !inactive && (canQuote || canOrder || canEditPage('orders.po')) ? '' : 'disabled'} aria-label="選取 ${escapeAttr(product.productName || product.nameCn || product.nameEn || product.manufacturerPartNo || product.sku || '產品')}" onchange="toggleProductManagementSelection(${inlineJsValue(productId)}, this.checked)"></td>
      <td data-th="貨號">${escapeHtml(product.manufacturerPartNo || product.sku || '')}</td>
      <td data-th="品名">${escapeHtml(product.productName || product.nameCn || product.nameEn || '')}</td>
      <td data-th="廠牌">${escapeHtml(brand)}</td>
      <td data-th="產品線">${escapeHtml(product.productLine || '未分類')}</td>
      <td data-th="類型">${escapeHtml(product.productType || product.category || '未分類')}</td>
      <td data-th="規格">${escapeHtml(product.specification || product.spec || '')}</td>
      <td data-th="建議售價">${price ? price.toLocaleString() : '－'}</td>
      <td data-th="狀態">${product.isFrequentlySold === true ? '常賣・' : ''}${inactive ? '停用' : duplicate ? '重複主檔・請核對' : escapeHtml(status === 'TEMPORARY' ? '待補主檔' : '啟用')}</td>
      <td data-th="操作" class="no-print product-management-actions">
        ${productId ? `<button type="button" class="btn-small btn-secondary" onclick="copyProductInformation(${inlineJsValue(productId)}, this)">複製資訊</button>` : ''}
        ${productId && canManagePendingProductMaster() ? `<button type="button" class="btn-small btn-secondary" ${inactive && !product.isFrequentlySold ? 'disabled' : ''} onclick="setProductFrequentlySold(${inlineJsValue(productId)}, ${product.isFrequentlySold !== true}, this)">${product.isFrequentlySold === true ? '移出常賣' : '設為常賣'}</button>` : ''}
        ${productId ? `<button type="button" class="btn-small btn-secondary" onclick="openProduct360(${inlineJsValue(productId)})">庫存</button>` : ''}
        ${canManagePendingProductMaster() ? `<button type="button" class="btn-small btn-secondary" onclick="openProductMasterEditor(${inlineJsValue(productId)})">編輯</button>` : ''}
        ${canDelete ? `<button type="button" class="btn-small btn-danger" onclick="deleteProductMaster(${inlineJsValue(productId)})">刪除</button>` : ''}
      </td>
    </tr>`;
}


let product360LoadGeneration = 0;

function closeProduct360() {
    product360LoadGeneration++;
    document.getElementById('product360Overlay')?.classList.remove('active');
}
window.closeProduct360 = closeProduct360;

function renderProduct360(product, inventory, warehouseDocs) {
    const content = document.getElementById('product360Content');
    const title = document.getElementById('product360Title');
    if (!content) return;

    const id = String(product.productId || product.id || '');
    const brand = product.brandName || product.brand || '';
    const code = product.manufacturerPartNo || product.sku || '';
    const name = product.productName || product.nameCn || product.nameEn || '';
    if (title) title.textContent = `${brand || '產品主檔'} · ${code || name}`;

    const warehouseRows = warehouseDocs.map(row => {
        const n = inventoryNumbers(row);
        const master = warehouseMasterCache.find(item => item.id === row.warehouseId);
        return { ...n, warehouseName:master?.warehouseName || row.warehouseName || row.warehouseId || '倉庫' };
    });
    const hasWarehouseFacts = warehouseRows.length > 0;
    const aggregate = inventoryNumbers(inventory || {});
    const stock = hasWarehouseFacts ? {
        onHand:warehouseRows.reduce((sum,row)=>sum+row.onHand,0),
        reserved:warehouseRows.reduce((sum,row)=>sum+row.reserved,0),
        incoming:warehouseRows.reduce((sum,row)=>sum+row.incoming,0),
        available:warehouseRows.reduce((sum,row)=>sum+row.available,0)
    } : aggregate;
    stock.projected = inventoryProjectedStock(stock);
    const safetyStock = Math.max(0, Number(inventory?.safetyStock || 0));

    const warehouseHtml = warehouseRows.length
        ? warehouseRows.map(row => `<div class="product-360-warehouse"><strong>${escapeHtml(row.warehouseName)}</strong><span>現有 ${row.onHand}　預留 ${row.reserved}　可用 ${row.available}　在途 ${row.incoming}　預計 ${inventoryProjectedStock(row)}</span></div>`).join('')
        : '<div class="product-360-empty">目前沒有分倉庫存。</div>';

    content.innerHTML = `
      <div class="product-360-grid">
        <section class="product-360-card">
          <h4>庫存狀況</h4>
          <div class="product-360-metrics">
            <div><span>現有</span><strong>${stock.onHand}</strong></div>
            <div><span>預留</span><strong>${stock.reserved}</strong></div>
            <div><span>可用</span><strong>${stock.available}</strong></div>
            <div><span>在途</span><strong>${stock.incoming}</strong></div>
            <div><span>預計庫存</span><strong>${stock.projected}</strong></div>
            <div><span>安全庫存</span><strong>${safetyStock}</strong></div>
            <div><span>庫存策略</span><strong class="product-360-policy">${escapeHtml(inventoryStockPolicyLabel(inventoryStockPolicy(inventory || {})))}</strong></div>
          </div>
          <div class="product-360-warehouse-list">${warehouseHtml}</div>
        </section>
      </div>`;
}

window.openProduct360 = async function(productId) {
    if (!canAccessPage('products')) return;
    const generation = ++product360LoadGeneration;
    const overlay = document.getElementById('product360Overlay');
    const content = document.getElementById('product360Content');
    const title = document.getElementById('product360Title');
    if (!overlay || !content) return;
    overlay.classList.add('active');
    if (title) title.textContent = '庫存狀態';
    content.innerHTML = '<div class="product-360-loading">正在讀取庫存狀況…</div>';

    try {
        const id = String(productId || '').trim();
        let product = productManagementResults.find(item => String(item.productId || item.id || '') === id);
        if (!product) {
            const snap = await firestoreReadWithTimeout(db.collection('products').doc(id).get(), 'Product 360 主檔');
            if (snap.exists) product = { id:snap.id, ...snap.data() };
        }
        if (!product) throw new Error('找不到這筆產品主檔。');

        const [inventorySnap, warehouseSnap] = await Promise.all([
            firestoreReadWithTimeout(db.collection('inventory').doc(encodeURIComponent(id)).get(), '產品庫存'),
            firestoreReadWithTimeout(db.collection('warehouseStocks').where('productKey','==',id).limit(50).get(), '產品分倉庫存'),
            loadWarehouseMaster().catch(() => warehouseMasterCache)
        ]);

        if (generation !== product360LoadGeneration) return;
        renderProduct360(
            product,
            inventorySnap.exists ? inventorySnap.data() : {},
            warehouseSnap.docs.map(doc => ({ id:doc.id, ...doc.data() }))
        );
    } catch (err) {
        if (generation !== product360LoadGeneration) return;
        console.error('Product 360 載入失敗：', err);
        content.innerHTML = `<div class="product-360-error" role="alert">${escapeHtml(productOperationErrorMessage('產品庫存讀取', err))}</div>`;
    }
};

function updateProductManagementSelectionBar() {
    const bar = document.getElementById('productManagementSelectionBar');
    const countEl = document.getElementById('productManagementSelectionCount');
    const quoteBtn = document.getElementById('productManagementBatchQuoteBtn');
    const orderBtn = document.getElementById('productManagementBatchOrderBtn');
    const purchaseBtn = document.getElementById('productManagementBatchPurchaseBtn');
    const head = document.getElementById('productManagementHead');
    const productMode = !head || head.dataset.mode !== 'pending';
    const count = productManagementSelection.size;
    if (countEl) countEl.textContent = `已選 ${count} 項`;
    if (bar) bar.hidden = !productMode;
    [quoteBtn, orderBtn, purchaseBtn].forEach(button => { if (button) button.disabled = count === 0; });
    if (quoteBtn) quoteBtn.hidden = !canEditPage('quote.create');
    if (orderBtn) orderBtn.hidden = !canEditPage('orders.list');
    if (purchaseBtn) purchaseBtn.hidden = !canEditPage('orders.po');

    const visible = productManagementResults.slice(0, productManagementVisibleLimit)
        .filter(product => product.productId || product.id);
    const selectedVisible = visible.filter(product => productManagementSelection.has(product.productId || product.id)).length;
    const selectVisible = document.getElementById('productManagementSelectVisible');
    if (selectVisible) {
        selectVisible.checked = visible.length > 0 && selectedVisible === visible.length;
        selectVisible.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
        selectVisible.disabled = visible.length === 0;
    }
}

function toggleProductManagementSelection(productId, checked) {
    const id = String(productId || '');
    const product = productManagementResults.find(item => (item.productId || item.id) === id);
    if (checked && product) productManagementSelection.set(id, { ...product });
    else productManagementSelection.delete(id);
    const input = [...document.querySelectorAll('.product-management-select-cell input[type="checkbox"]')]
        .find(node => node.getAttribute('onchange')?.includes(`'${id}'`));
    input?.closest('tr')?.classList.toggle('is-selected', productManagementSelection.has(id));
    updateProductManagementSelectionBar();
}

function toggleVisibleProductManagementSelection(checked) {
    productManagementResults.slice(0, productManagementVisibleLimit).forEach(product => {
        const id = product.productId || product.id || '';
        if (!id) return;
        if (checked) productManagementSelection.set(id, { ...product });
        else productManagementSelection.delete(id);
    });
    renderProductManagementResults();
}

function clearProductManagementSelection() {
    productManagementSelection.clear();
    document.querySelectorAll('.product-management-select-cell input[type="checkbox"]').forEach(input => { input.checked = false; });
    document.querySelectorAll('.product-management-table tr.is-selected').forEach(row => row.classList.remove('is-selected'));
    updateProductManagementSelectionBar();
}

function selectedProductManagementProducts() {
    return [...productManagementSelection.values()];
}

function productIdsFromItems(items = []) {
    return [...new Set((Array.isArray(items) ? items : [])
        .map(item => String(item?.productId || '').trim())
        .filter(Boolean))];
}

function updateProductManagementMoreButton() {
    const row = document.getElementById('productManagementMoreRow');
    const button = document.getElementById('productManagementMoreBtn');
    if (!row || !button) return;

    if (productManagementSourceMode === 'frequent') {
        row.style.display = productFrequentActive?.state.hasMore ? '' : 'none';
        button.disabled = productManagementSearchInProgress;
        button.textContent = '載入更多常賣品項（20 筆）';
        return;
    }
    if (productManagementSourceMode === 'search') {
        row.style.display = productManagementActiveSearch?.hasMore ? '' : 'none';
        button.disabled = productManagementSearchInProgress;
        button.textContent = '載入更多符合結果（50 筆）';
        return;
    }
    const visible = Math.min(productManagementVisibleLimit, productManagementResults.length);
    const hasMore = productManagementResults.length > visible;
    row.style.display = hasMore ? '' : 'none';
    button.disabled = productManagementSearchInProgress;
    button.textContent = hasMore
        ? `載入更多結果（目前 ${visible} / ${productManagementResults.length}）`
        : '載入更多結果';
}

function renderProductManagementResults() {
    if(productManagementSourceMode==='frequent')productManagementResults=productManagementResults.filter(row=>isVisibleFrequentProduct(row,productFrequentActive?.brand));
    setProductManagementTableMode('products');
    const body = document.getElementById('productManagementBody');
    if (!body) return;
    const identityCounts = new Map();
    const identity = product => JSON.stringify([normalizeBrandLookupKey(resolveBrandName(product.brandName || product.brand || '')), normalizeItemCodeLoose(product.manufacturerPartNo || product.sku || '')]);
    productManagementResults.filter(product => product.active !== false && product.status !== 'INACTIVE').forEach(product => {
        const key = identity(product);
        identityCounts.set(key, (identityCounts.get(key) || 0) + 1);
    });
    const visibleResults = productManagementResults.slice(0, productManagementVisibleLimit);
    body.innerHTML = visibleResults.length
        ? visibleResults.map(product => productManagementRow(product, (identityCounts.get(identity(product)) || 0) > 1)).join('')
        : productManagementSourceMode === 'search' && productManagementActiveSearch?.hasMore
            ? '<tr><td colspan="10" class="empty-hint">目前符合產品皆停用，可載入更多符合結果。</td></tr>'
            : '<tr><td colspan="10" class="empty-hint">查無符合產品。</td></tr>';
    updateProductManagementMoreButton();
    updateProductManagementSelectionBar();
}

window.loadMoreProductManagementResults = async function() {
    if (productManagementSourceMode === 'frequent') { await loadFrequentProducts(productFrequentActive?.brand, true); return; }
    if (productManagementSourceMode === 'search') { await searchProductManagement(true); return; }

    productManagementVisibleLimit += PRODUCT_MANAGEMENT_RENDER_STEP;
    renderProductManagementResults();
    const status = document.getElementById('productManagementSearchStatus');
    if (status && productManagementResults.length) {
        const visible = Math.min(productManagementVisibleLimit, productManagementResults.length);
        status.textContent = visible < productManagementResults.length
            ? `共 ${productManagementResults.length} 筆；目前顯示 ${visible} 筆。`
            : `完成，共 ${productManagementResults.length} 筆。`;
    }
};

window.clearProductManagementSearch = function(options = {}) {
    clearTimeout(productManagementSearchTimer);
    productManagementSearchGeneration++;
    productManagementSearchInProgress = false;
    productManagementResults = [];
    productManagementVisibleLimit = PRODUCT_MANAGEMENT_RENDER_STEP;
    productManagementSourceMode = 'none';
    productManagementActiveSearch = null;
    pendingProductMasterRows = [];
    renderProductBrandBrowser();
    setProductManagementTableMode('products');
    const input = document.getElementById('productManagementSearch');
    const status = document.getElementById('productManagementSearchStatus');
    const body = document.getElementById('productManagementBody');
    const button = document.getElementById('productManagementSearchBtn');
    if (input && !options.preserveInput) input.value = '';
    if (status) status.textContent = '';
    if (body) body.innerHTML = '<tr><td colspan="10" class="empty-hint">尚未搜尋產品。</td></tr>';
    if (button) button.textContent = '搜尋產品';
    updateProductSearchControls();
};

const productManagementSearchCache = new Map();
let productManagementActiveSearch = null;
window.queueProductManagementSearch = function() {};

window.searchProductManagement = async function(loadMore = false) {
    if (productManagementSearchInProgress || !canAccessPage('products')) return;
    const brand = String(document.getElementById('productManagementSearchBrand')?.value || '').trim();
    const input = document.getElementById('productManagementSearch');
    const button = document.getElementById('productManagementSearchBtn');
    const status = document.getElementById('productManagementSearchStatus');
    const raw = String(input?.value || '').trim();
    if (!raw) {
        if (status) status.textContent = '請輸入完整貨號；可直接搜尋全部廠牌，或先選擇廠牌縮小範圍。';
        return;
    }
    const generation = ++productManagementSearchGeneration;
    const role = currentUserRole, uid = currentUser?.uid;
    clearTimeout(productManagementSearchTimer);
    pendingProductMasterRows = [];
    productManagementSourceMode = 'search';
    productManagementSearchInProgress = true;
    if (!loadMore) {
        const body = document.getElementById('productManagementBody');
        if (body) body.innerHTML = '<tr><td colspan="10" class="empty-hint" role="status">正在搜尋產品…</td></tr>';
    }
    renderProductBrandBrowser();
    if (button) { button.disabled = true; button.textContent = '搜尋中…'; }
    if (status) status.textContent = '正在查詢完整貨號…';
    const canSeeInactive = canManagePendingProductMaster()
        && document.getElementById('productManagementShowInactive')?.checked === true;
    const normalizedCode = normalizeItemCodeLoose(raw);
    if (!normalizedCode) {
        if (status) status.textContent = '請輸入有效貨號。';
        productManagementSearchInProgress = false;
        if (button) button.textContent = '搜尋產品';
        updateProductSearchControls();
        return;
    }
    const cacheKey = JSON.stringify([uid, role, brand, normalizedCode, canSeeInactive]);
    let state = productManagementSearchCache.get(cacheKey);
    if (!state || Date.now() - state.at > 300000) state = { map:new Map(), cursor:null, hasMore:false, at:Date.now() };
    productManagementActiveSearch = state;
    const isCurrent = () => generation === productManagementSearchGeneration && role === currentUserRole && uid === currentUser?.uid;
    try {
        if (!state.loaded || (loadMore && state.hasMore)) {
            const storedBrandNames = brand
                ? dedupeBrandsCaseInsensitive([brand, ...(brandMasterEntryForName(brand)?.aliases || [])]).slice(0, 10)
                : [];
            // Read only matching normalized codes; the optional brand is filtered locally.
            // This uses the existing single-field index without scanning a catalogue.
            let query = db.collection('products')
                .where('normalizedPartNo', '==', normalizedCode)
                .limit(50);
            if (state.cursor) query = query.startAfter(state.cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '廠牌與完整貨號搜尋');
            if (!isCurrent()) return;
            snapshot.docs.forEach(doc => {
                const data = { id:doc.id, ...doc.data() };
                if (brand && !storedBrandNames.some(name => normalizeBrandLookupKey(name) === normalizeBrandLookupKey(data.brandName || data.brand || ''))) return;
                if (!canSeeInactive && (data.status === 'INACTIVE' || data.active === false)) return;
                state.map.set(doc.id, data);
            });
            state.hasMore = snapshot.size === 50;
            state.cursor = snapshot.docs[snapshot.docs.length - 1] || state.cursor;
            state.loaded = true;
            productManagementSearchCache.set(cacheKey, state);
            if (productManagementSearchCache.size > 20) productManagementSearchCache.delete(productManagementSearchCache.keys().next().value);
        }
        if (!isCurrent()) return;
        productManagementResults = [...state.map.values()];
        productManagementVisibleLimit = Math.max(PRODUCT_MANAGEMENT_RENDER_STEP, productManagementResults.length);
        renderProductManagementResults();
        if (status) status.textContent = productManagementResults.length
            ? `${brand || '全部廠牌'}：完整貨號 ${raw}，找到 ${productManagementResults.length} 筆${state.hasMore ? '，可載入更多符合結果' : ''}。`
            : state.hasMore ? '目前符合貨號的產品皆停用，可載入更多符合結果。' : `${brand || '全部廠牌'}：查無完整貨號 ${raw}，請確認廠牌與貨號。`;
    } catch (err) {
        if (!isCurrent()) return;
        console.error('產品管理搜尋失敗：', err);
        productManagementResults = [];
        productManagementActiveSearch = null;
        renderProductManagementResults();
        if (status) status.textContent = productOperationErrorMessage('產品搜尋', err);
    } finally {
        if (isCurrent()) {
            productManagementSearchInProgress = false;
            if (button) button.textContent = '搜尋產品';
            updateProductSearchControls();
            updateProductManagementMoreButton();
        }
    }
};

function ensureProductMasterEditor() {
    let overlay = document.getElementById('productMasterEditorOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'productMasterEditorOverlay';
    overlay.className = 'eq-modal-overlay no-print';
    const serviceKindLabels = {BIOPLEX_LAB:'Bio-Plex 代工',PIPETTE_CALIBRATION:'Pipette 校正',
        TISSUE_SLICING:'組織切片代工',ONSITE_REPAIR:'到府設備維修'};
    const serviceKindOptions = Object.keys(globalThis.YushinServiceWork?.STEPS || {})
        .map(kind => `<option value="${escapeAttr(kind)}">${escapeHtml(serviceKindLabels[kind] || kind)}</option>`).join('');
    overlay.innerHTML = `
      <div class="eq-modal-box" style="max-width:760px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <h3 id="productMasterEditorTitle" style="margin:0;">產品主檔</h3>
          <button type="button" class="btn-secondary" onclick="closeProductMasterEditor()">✕ 關閉</button>
        </div>
        <input type="hidden" id="pmEditProductId">
        <input type="hidden" id="pmEditCreatedAt">
        <input type="hidden" id="pmEditSource">
        <div class="form-grid" style="margin-top:14px;">
          <div><label>廠牌 *</label><input id="pmEditBrand" type="text" list="pmBrandList" autocomplete="off"><datalist id="pmBrandList"></datalist></div>
          <div><label>原廠貨號 *</label><input id="pmEditCode" type="text" autocomplete="off"></div>
          <div><label>中文品名 *</label><input id="pmEditNameCn" type="text" autocomplete="off"></div>
          <div><label>英文品名</label><input id="pmEditNameEn" type="text" autocomplete="off"></div>
          <div style="grid-column:1/-1;"><label>規格／包裝</label><input id="pmEditSpec" type="text" autocomplete="off"></div>
          <div><label>產品線</label><input id="pmEditProductLine" type="text" placeholder="選填，例如：Flow Cytometry"></div>
          <div><label>產品類型</label><input id="pmEditProductType" type="text" list="pmProductTypeList" placeholder="例如：Reagent" oninput="updateProductMasterServiceFields()"></div>
          <datalist id="pmProductTypeList">
            <option value="Instrument"></option><option value="Reagent"></option><option value="Consumable"></option>
            <option value="Accessory"></option><option value="Service"></option>
          </datalist>
          <div id="pmEditServiceKindField" hidden>
            <label>服務類型 *</label>
            <select id="pmEditServiceKind"><option value="">請選擇服務類型</option>${serviceKindOptions}</select>
            <small>服務不會建立商品庫存、批號或一般出貨；完成證據依服務類型處理。</small>
          </div>
          <div><label>建議售價（含稅）</label><input id="pmEditListPrice" type="number" min="0" step="0.01"></div>
          <div id="pmEditCostField" hidden><label>標準成本</label><input id="pmEditCost" type="number" min="0" step="0.01"><small>選填；只帶入新採購單，既有單據保留原價。</small></div>
          <div><label>狀態</label>
            <select id="pmEditStatus"><option value="ACTIVE">啟用</option><option value="INACTIVE">停用</option></select>
          </div>
          <div style="grid-column:1/-1;display:flex;gap:16px;flex-wrap:wrap;">
            <label><input id="pmEditInventoryTracked" type="checkbox"> 庫存管理</label>
            <label><input id="pmEditLotTracked" type="checkbox"> 批號管理</label>
            <label><input id="pmEditExpiryTracked" type="checkbox"> 效期管理</label>
          </div>
        </div>
        <div id="pmEditMeta" style="margin-top:10px;font-size:12px;color:#666;"></div>
        <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;">
          <button type="button" id="saveProductMasterEditorBtn" onclick="saveProductMasterEditor()">儲存主檔</button>
          <button type="button" class="btn-secondary" onclick="closeProductMasterEditor()">取消</button>
        </div>
      </div>`;
    overlay.addEventListener('click', event => { if (event.target === overlay) closeProductMasterEditor(); });
    document.body.appendChild(overlay);
    return overlay;
}

function updateProductMasterServiceFields() {
    const isService = String(document.getElementById('pmEditProductType')?.value || '').trim().toUpperCase() === 'SERVICE';
    const kindField = document.getElementById('pmEditServiceKindField');
    if (kindField) kindField.hidden = !isService;
    for (const id of ['pmEditInventoryTracked','pmEditLotTracked','pmEditExpiryTracked']) {
        const input = document.getElementById(id);
        if (!input) continue;
        if (isService) input.checked = false;
        input.disabled = isService;
    }
}

function populateProductMasterEditor(product = {}, options = {}) {
    const overlay = ensureProductMasterEditor();
    const source = product.source || options.source || 'MANUAL';
    document.getElementById('pmEditProductId').value = product.productId || product.id || '';
    document.getElementById('pmEditCreatedAt').value = product.createdAt || '';
    document.getElementById('pmEditSource').value = source;
    const existingIdentity = !!(product.productId || product.id);
    const brandInput = document.getElementById('pmEditBrand');
    const codeInput = document.getElementById('pmEditCode');
    const brandList = document.getElementById('pmBrandList');
    if (brandList) brandList.innerHTML = getUnifiedBrandNames(false)
        .map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
    brandInput.value = product.brandName || product.brand || options.brand || '';
    codeInput.value = product.manufacturerPartNo || product.sku || options.itemCode || '';
    brandInput.disabled = existingIdentity;
    codeInput.disabled = existingIdentity;
    document.getElementById('pmEditNameCn').value = product.productName || product.nameCn || options.itemName || '';
    document.getElementById('pmEditNameEn').value = product.nameEn || '';
    document.getElementById('pmEditSpec').value = product.specification || product.spec || '';
    document.getElementById('pmEditProductLine').value = product.productLine || '';
    document.getElementById('pmEditProductType').value = product.productType || product.category || '';
    document.getElementById('pmEditServiceKind').value = product.serviceKind || '';
    document.getElementById('pmEditListPrice').value = product.listPrice ?? product.price ?? '';
    const costInput = document.getElementById('pmEditCost');
    costInput.value = options.standardCost ?? '';
    costInput.dataset.originalValue = costInput.value;
    document.getElementById('pmEditCostField').hidden = !(trueUserRole === 'admin' && currentUserRole === 'admin');
    document.getElementById('pmEditStatus').value = product.status === 'INACTIVE' || product.active === false ? 'INACTIVE' : 'ACTIVE';
    document.getElementById('pmEditInventoryTracked').checked = product.inventoryTracked === true;
    document.getElementById('pmEditLotTracked').checked = product.lotTracked === true;
    document.getElementById('pmEditExpiryTracked').checked = product.expiryTracked === true;
    updateProductMasterServiceFields();
    document.getElementById('productMasterEditorTitle').textContent = product.productId || product.id ? '編輯產品主檔' : '建立產品主檔';
    document.getElementById('pmEditMeta').textContent =
        `來源：${source || 'MANUAL'}${product.updatedAt ? '　最後更新：' + product.updatedAt : ''}`
        + (existingIdentity ? '　｜　廠牌與原廠貨號為產品身分；如貨號或廠牌建錯，請停用舊產品後建立正確產品。' : '');
    overlay.classList.add('active');
}

window.openNewProductMasterEditor = function() {
    if (!canManagePendingProductMaster()) return;
    populateProductMasterEditor({}, { source:'MANUAL' });
};

window.openProductMasterEditor = async function(productId) {
    if (!canManagePendingProductMaster()) return;
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '載入產品…');
    if (button && !buttonState) return;
    try {
        let product = productManagementResults.find(item => (item.productId || item.id) === productId);
        if (!product && productId) {
            const snap = await firestoreReadWithTimeout(db.collection('products').doc(productId).get(), '讀取產品主檔');
            if (snap.exists) product = { id:snap.id, ...snap.data() };
        }
        if (!product) { alert('找不到這筆產品主檔。'); return; }
        let standardCost = null;
        if (trueUserRole === 'admin' && currentUserRole === 'admin') {
            const costSnap = await firestoreReadWithTimeout(db.collection('productCosts').doc(productId).get(), '讀取產品成本');
            if (costSnap.exists) standardCost = costSnap.data().standardCost ?? null;
        }
        populateProductMasterEditor(product, { standardCost });
    } catch (err) {
        alert('讀取產品主檔失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
};

window.setProductMasterActive = async function(productId, active) {
    if (!canManagePendingProductMaster()) return;
    const id = String(productId || '').trim();
    if (!id) return;

    let product = productManagementResults.find(item => (item.productId || item.id) === id);
    if (!product) {
        const snap = await firestoreReadWithTimeout(db.collection('products').doc(id).get(), '讀取產品主檔');
        if (snap.exists) product = { id:snap.id, ...snap.data() };
    }
    if (!product) { alert('找不到這筆產品主檔。'); return; }

    const brand = product.brandName || product.brand || '';
    const code = product.manufacturerPartNo || product.sku || '';
    const name = product.productName || product.nameCn || product.nameEn || '';
    if (!active && !confirm(`確定停用「${brand} / ${code} ${name}」？\n\n停用後不再提供估價單、訂單或產品選用，但歷史單據與關聯資料會保留。`)) return;

    const button = actionButtonFromEventOrSelector();
    const state = beginActionButton(button, active ? '啟用中…' : '停用中…');
    if (button && !state) return;
    try {
        const now = new Date().toISOString();
        const patch = {
            status: active ? 'ACTIVE' : 'INACTIVE',
            active: !!active,
            updatedAt: now,
            updatedBy: currentUser?.uid || ''
        };
        await db.collection('products').doc(id).set(patch, { merge:true });

        const next = { ...product, ...patch, productId:product.productId || id };
        invalidateProductFrequentCache();
        productManagementSearchCache.clear();
        cacheProductLookupItem(productMasterDocToPriceItem({ id, data:() => next }));
        if (!active) productManagementSelection.delete(id);

        const index = productManagementResults.findIndex(item => (item.productId || item.id) === id);
        if (index >= 0) productManagementResults[index] = next;

        const showInactive = document.getElementById('productManagementShowInactive')?.checked === true;
        if (!active && !showInactive) {
            productManagementResults = productManagementResults.filter(item => (item.productId || item.id) !== id);
        }
        renderProductManagementResults();

        const statusEl = document.getElementById('productManagementSearchStatus');
        if (statusEl) statusEl.textContent = active
            ? `已重新啟用產品主檔：${brand} / ${code}`
            : `已停用產品主檔：${brand} / ${code}；歷史資料保留。`;
        showActionFeedback(active ? '產品已重新啟用。' : '產品已停用，不再提供日常選用。');
    } catch (err) {
        console.error('更新產品主檔狀態失敗：', err);
        alert('更新產品狀態失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, state);
    }
};

async function productMasterOperationalBlockers(productId) {
    const id = String(productId || '').trim();
    if (!id) return ['缺少產品識別碼'];

    const [inventorySnap, warehouseSnap, reservationSnap, demandSnap, supplySnap, lotSnap] = await Promise.all([
        firestoreReadWithTimeout(db.collection('inventory').doc(encodeURIComponent(id)).get(), '檢查產品庫存'),
        firestoreReadWithTimeout(db.collection('warehouseStocks').where('productKey', '==', id).limit(100).get(), '檢查分倉庫存'),
        firestoreReadWithTimeout(db.collection('inventoryReservations').where('productKey', '==', id).limit(100).get(), '檢查庫存預留'),
        firestoreReadWithTimeout(db.collection('procurementDemands').where('productId', '==', id).limit(100).get(), '檢查採購需求'),
        firestoreReadWithTimeout(supplyOrdersCollection().where('productId', '==', id).limit(100).get(), '檢查在途供應'),
        firestoreReadWithTimeout(db.collection('inventoryLots').where('productId', '==', id).limit(100).get(), '檢查批號庫存')
    ]);

    const blockers = [];
    const inventory = inventorySnap.exists ? (inventorySnap.data() || {}) : {};
    if (Number(inventory.onHand || 0) > 0 || Number(inventory.reserved || 0) > 0 || Number(inventory.incoming || 0) > 0) {
        blockers.push('仍有庫存／預留／在途數量');
    }

    if (warehouseSnap.docs.some(doc => {
        const data = doc.data() || {};
        return Number(data.onHand || 0) > 0 || Number(data.reserved || 0) > 0 || Number(data.incoming || 0) > 0;
    })) blockers.push('仍有分倉庫存');

    if (reservationSnap.docs.some(doc => {
        const data = doc.data() || {};
        return String(data.status || 'active').toLowerCase() === 'active' && Number(data.quantity || 0) > 0;
    })) blockers.push('仍有有效訂單預留');

    if (demandSnap.docs.some(doc => {
        const data = doc.data() || {};
        return String(data.status || '').toUpperCase() !== 'CANCELLED'
            && (Number(data.remainingToOrderQty || 0) > 0 || Number(data.remainingToReceiveQty || 0) > 0);
    })) blockers.push('仍有未完成採購需求');

    if (supplySnap.docs.some(doc => {
        const data = doc.data() || {};
        const status = String(data.status || '').toUpperCase();
        return !['CANCELLED', 'CLOSED', 'RECEIVED'].includes(status)
            && Math.max(0, Number(data.qty || 0) - Number(data.receivedQty || 0)) > 0;
    })) blockers.push('仍有未完成訂貨／在途供應');

    if (lotSnap.docs.some(doc => Number((doc.data() || {}).remainingQty || 0) > 0)) {
        blockers.push('仍有可用批號庫存');
    }

    return [...new Set(blockers)];
}

window.deleteProductMaster = async function(productId) {
    if (!canDeleteProductMaster()) {
        alert('只有管理員可以永久刪除產品主檔。');
        return;
    }

    const id = String(productId || '').trim();
    if (!id) return;
    let product = productManagementResults.find(item => (item.productId || item.id) === id);
    if (!product) {
        const snap = await firestoreReadWithTimeout(db.collection('products').doc(id).get(), '讀取產品主檔');
        if (snap.exists) product = { id:snap.id, ...snap.data() };
    }
    if (!product) {
        alert('找不到這筆產品主檔，可能已經被刪除。');
        return;
    }

    const brand = product.brandName || product.brand || '';
    const code = product.manufacturerPartNo || product.sku || '';
    const name = product.productName || product.nameCn || product.nameEn || '';
    if (!confirm(`確定永久刪除「${brand} / ${code} ${name}」？\n\n系統會先檢查庫存、預留、採購需求與在途供應；有未完成關聯時不允許刪除。歷史估價單／訂單與價格歷史不會被刪除。`)) return;

    const button = actionButtonFromEventOrSelector();
    const state = beginActionButton(button, '檢查中…');
    if (button && !state) return;

    try {
        const blockers = await productMasterOperationalBlockers(id);
        if (blockers.length) {
            alert('目前不能刪除這筆產品主檔：\n• ' + blockers.join('\n• ') + '\n\n請先完成或取消相關庫存／採購流程；若只是不要再使用此品項，請改用「停用」。');
            return;
        }

        if (button) button.textContent = '刪除中…';
        const batch = db.batch();
        batch.delete(db.collection('products').doc(id));
        // 標準成本與 Product Master 同生命週期；實際採購價格與歷史價格紀錄保留。
        batch.delete(db.collection('productCosts').doc(id));
        await batch.commit();

        invalidateProductFrequentCache();
        productManagementSearchCache.clear();
        productManagementSelection.delete(id);
        productManagementResults = productManagementResults.filter(item => (item.productId || item.id) !== id);
        priceList = priceList.filter(item => (item.productId || stableProductId(item)) !== id);
        [...visibleProductCostCache.keys()].forEach(key => {
            if (String(key).endsWith(`||${id}`)) visibleProductCostCache.delete(key);
        });
        refreshPriceDatalists();
        renderProductManagementResults();

        const statusEl = document.getElementById('productManagementSearchStatus');
        if (statusEl) statusEl.textContent = `已永久刪除產品主檔：${brand} / ${code}；歷史估價單、訂單與價格歷史保留。`;
        showActionFeedback('產品主檔已刪除。');
    } catch (err) {
        console.error('刪除產品主檔失敗：', err);
        alert('刪除產品主檔失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, state);
    }
};

window.openPendingProductMasterEditor = function(index) {
    if (!canManagePendingProductMaster()) return;
    const row = pendingProductMasterRows[index];
    if (!row) return;
    populateProductMasterEditor({}, {
        source:'MANUAL',
        brand:row.brand || '',
        itemCode:row.itemCode || '',
        itemName:row.itemName || ''
    });
};

window.closeProductMasterEditor = function() {
    document.getElementById('productMasterEditorOverlay')?.classList.remove('active');
    const brandInput = document.getElementById('pmEditBrand');
    const codeInput = document.getElementById('pmEditCode');
    if (brandInput) brandInput.disabled = false;
    if (codeInput) codeInput.disabled = false;
};

async function findDuplicateProductMaster(brand, code, excludeId = '') {
    const normalizedPartNo=normalizeItemCodeLoose(code);
    const brandKey=normalizeBrandLookupKey(resolveBrandName(brand));
    let cursor=null;
    while(true){
        let query=db.collection('products').where('normalizedPartNo','==',normalizedPartNo).limit(50);
        if(cursor)query=query.startAfter(cursor);
        const page=await firestoreReadWithTimeout(query.get(),'產品主檔重複貨號檢查');
        const duplicate=page.docs.find(doc=>doc.id!==excludeId&&normalizeBrandLookupKey(resolveBrandName(doc.data().brandName||doc.data().brand||''))===brandKey);
        if(duplicate)return duplicate;
        if(page.size<50)return null;
        cursor=page.docs[page.docs.length-1];
    }
}

function syncSavedProductMaster(productId, record) {
    if (typeof resetQuickProductBrowserBrands==='function') {
        const state=resetQuickProductBrowserBrands(),prior=state.rows.find(row=>row.id===productId);
        if(record.source==='QUICK_CREATE'||prior){
            state.rows=state.rows.filter(row=>row.id!==productId);
            state.rows.push({...prior,...record,id:productId});
        }
    }
    invalidateProductFrequentCache();
    cacheProductLookupItem(productMasterDocToPriceItem({id:productId,data:()=>record}));
    productManagementSearchCache.clear();
    productManagementSearchGeneration++;
    productManagementSearchInProgress=false;
    productManagementActiveSearch=null;
    const existing=productManagementResults.find(item=>(item.productId||item.id)===productId);
    const next={id:productId,isFrequentlySold:existing?.isFrequentlySold===true,...record};
    const index=productManagementResults.findIndex(item=>(item.productId||item.id)===productId);
    if(index>=0)productManagementResults[index]=next;
    else productManagementResults.unshift(next);
    renderProductManagementResults();
    if (typeof renderProductBrandBrowser==='function') renderProductBrandBrowser();
    updateProductSearchControls();
    updateProductManagementMoreButton();
}

window.saveProductMasterEditor = async function() {
    if (!canManagePendingProductMaster()) return;
    const button = document.getElementById('saveProductMasterEditorBtn');
    const brand = resolveBrandName(document.getElementById('pmEditBrand').value || '');
    const code = String(document.getElementById('pmEditCode').value || '').trim();
    const productName = String(document.getElementById('pmEditNameCn').value || '').trim();
    const productLine = String(document.getElementById('pmEditProductLine').value || '').trim();
    const productType = normalizeProductTypeValue(document.getElementById('pmEditProductType').value || '');
    const isService = String(productType).toUpperCase() === 'SERVICE';
    const serviceKind = String(document.getElementById('pmEditServiceKind')?.value || '').trim();
    if (isService && !Object.prototype.hasOwnProperty.call(globalThis.YushinServiceWork?.STEPS || {}, serviceKind)) {
        alert('服務型產品請選擇有效的服務類型，才能建立服務案件。');
        document.getElementById('pmEditServiceKind')?.focus();
        return;
    }
    if (!brand || !code || !productName) {
        alert('請至少完成廠牌、原廠貨號與中文品名。');
        return;
    }
    if (!brandMasterEntryForName(brand)) {
        alert('此廠牌不在啟用中的廠牌主檔，請先到「廠牌管理」建立廠牌。');
        return;
    }

    const costInput = document.getElementById('pmEditCost');
    const costText = String(costInput?.value || '').trim();
    const costChanged = trueUserRole === 'admin' && currentUserRole === 'admin'
        && costText !== String(costInput?.dataset.originalValue || '');
    if (costChanged && (!costText || !Number.isFinite(Number(costText)) || Number(costText) < 0)) {
        alert('標準成本請輸入零或正數；若不修改，請保留原值。');
        return;
    }
    const state = beginActionButton(button, '檢查中…');
    if (!state) return;
    try {
    const originalId = String(document.getElementById('pmEditProductId').value || '').trim();
    const normalizedPartNo = normalizeItemCodeLoose(code);
    const duplicate = await findDuplicateProductMaster(brand,code,originalId);
    if (duplicate) {
        alert('這個廠牌與貨號已經存在於產品主檔，請直接編輯既有產品。');
        return;
    }

    const productId = originalId || stableProductId({ brand, model:code });
    const now = new Date().toISOString();
    const status = document.getElementById('pmEditStatus').value === 'INACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const brandEntry = brandMasterEntryForName(brand);
    const record = {
        productId,
        brandId: brandEntry?.id || '',
        brandName: brand,
        manufacturerPartNo: code,
        normalizedPartNo,
        productName,
        nameEn: String(document.getElementById('pmEditNameEn').value || '').trim(),
        specification: String(document.getElementById('pmEditSpec').value || '').trim(),
        productLine,
        productLineId: productLine,
        productType,
        category: productType,
        serviceKind: isService ? serviceKind : '',
        listPrice: Number(document.getElementById('pmEditListPrice').value || 0),
        inventoryTracked: !isService && document.getElementById('pmEditInventoryTracked').checked,
        lotTracked: !isService && document.getElementById('pmEditLotTracked').checked,
        expiryTracked: !isService && document.getElementById('pmEditExpiryTracked').checked,
        status,
        active: status === 'ACTIVE',
        source: String(document.getElementById('pmEditSource').value || 'MANUAL').toUpperCase(),
        createdAt: document.getElementById('pmEditCreatedAt').value || now,
        ...(originalId ? {} : { createdBy: currentUser?.uid || '' }),
        updatedAt: now,
        updatedBy: currentUser?.uid || ''
    };

        if (button) button.textContent = '儲存中…';
        await db.runTransaction(async transaction => {
            const costRef = db.collection('productCosts').doc(productId);
            const previousCost = costChanged ? await transaction.get(costRef) : null;
            transaction.set(db.collection('products').doc(productId), record, { merge:true });
            if (costChanged) {
                const standardCost = Number(costText);
                transaction.set(costRef, { productId, productLineId:productLine, standardCost, salesVisible:false,
                    source:'PRODUCT_EDITOR', updatedAt:now, updatedBy:currentUser?.uid || '' }, { merge:true });
                transaction.set(db.collection('priceHistory').doc(), { productId, type:'STANDARD_COST_UPDATE',
                    previousCost:previousCost.exists ? previousCost.data().standardCost ?? null : null,
                    standardCost, source:'PRODUCT_EDITOR', updatedAt:now, updatedBy:currentUser?.uid || '' });
            }
        });
        if (costChanged) {
            invalidateVisibleProductCosts();
            purchaseCostCache.set(productId, Number(costText));
        }
        syncSavedProductMaster(productId,record);
        const overviewIndex = productManagementOverviewRows.findIndex(item => (item.id || item.productId) === productId);
        if (overviewIndex >= 0) productManagementOverviewRows[overviewIndex] = { ...productManagementOverviewRows[overviewIndex], ...record, id:productId };
        else if (!originalId) productManagementOverviewRows.unshift({ ...record, id:productId });
        if (document.getElementById('productOverviewScope')) renderProductManagementOverview();
        closeProductMasterEditor();
        const statusEl = document.getElementById('productManagementSearchStatus');
        if (statusEl) statusEl.textContent = status === 'INACTIVE'
            ? `已停用產品主檔：${brand} / ${code}；估價與訂單不再自動帶入。`
            : `已儲存產品主檔：${brand} / ${code}`;
    } catch (err) {
        console.error('儲存產品主檔失敗：', err);
        alert('儲存產品主檔失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, state);
    }
};

function productManagementSource(product) {
    const brand = resolveBrandName(product.brandName || product.brand || '');
    const unitPrice = isBrandPriceListActive(brand) ? Number(product.listPrice ?? product.price ?? 0) : 0;
    return {
        productId: product.productId || product.id || '',
        model: product.manufacturerPartNo || product.sku || '',
        itemCode: product.manufacturerPartNo || product.sku || '',
        nameCn: product.productName || product.nameCn || '',
        nameEn: product.nameEn || '',
        itemName: product.productName || product.nameCn || product.nameEn || '',
        brand,
        brandId: product.brandId || brandIdForName(brand),
        spec: product.specification || product.spec || '',
        price: unitPrice,
        unitPrice,
        qty: 1,
        productLine: product.productLine || '',
        productType: product.productType || product.category || '',
        serviceKind: product.serviceKind || '',
        productMasterMatched: true
    };
}

function quoteProductManagementRowIsEmpty(row) {
    if (!row) return false;
    const textSelectors = ['.item-model', '.item-cn', '.item-en', '.item-spec', '.item-product-id'];
    const hasText = textSelectors.some(selector => String(row.querySelector(selector)?.value || '').trim());
    const qty = Number(row.querySelector('.qty')?.value || 0);
    const price = Number(row.querySelector('.inc-price')?.value || 0);
    return !hasText && qty <= 1 && price === 0;
}

function openProductManagementProductsInQuote(products) {
    if (!Array.isArray(products) || !products.length || !canEditPage('quote.create')) return;
    actuallySwitchMainTab('quote-system', document.querySelector('[data-main-nav="quote"]'));
    switchQuoteView('create', document.getElementById('qsub-create'), { skipHistory: true });
    ensureQuoteFormInitialized();
    [...document.querySelectorAll('#quoteItems tr')].filter(quoteProductManagementRowIsEmpty).forEach(row => row.remove());
    products.forEach(product => addQuoteRow(productManagementSource(product)));
    calculateTotals();
    saveQuoteDraft();
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.addProductManagementToQuote = function addProductManagementToQuote(productId) {
    const product = productManagementResults.find(item => (item.productId || item.id) === productId);
    if (!product || !canEditPage('quote.create')) return;
    openProductManagementProductsInQuote([product]);
};

window.addProductManagementToOrder = function addProductManagementToOrder(productId) {
    const product = productManagementResults.find(item => (item.productId || item.id) === productId);
    if (!product || !canEditPage('orders.list')) return;
    openOrderWorkspace(document.querySelector('[data-main-nav="orders"]'));
    openOrderModal(productManagementSource(product));
};

window.addProductManagementSelectionToQuote = function addProductManagementSelectionToQuote() {
    const products = selectedProductManagementProducts();
    if (!products.length) return;
    if (!canEditPage('quote.create')) {
        alert('您沒有建立估價單的權限。');
        return;
    }
    openProductManagementProductsInQuote(products);
    clearProductManagementSelection();
};

window.addProductManagementSelectionToOrder = function addProductManagementSelectionToOrder() {
    const products = selectedProductManagementProducts();
    if (!products.length) return;
    if (!canEditPage('orders.list')) {
        alert('您沒有建立訂單的權限。');
        return;
    }
    const sources = products.map(productManagementSource);
    openOrderWorkspace(document.querySelector('[data-main-nav="orders"]'));
    openOrderModal(sources[0]);
    newOrderDraftItems = sources.slice(1).map(normalizeNewOrderItem);
    renderNewOrderDraftItems();
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = `新增訂單（${sources.length} 個品項）`;
    clearProductManagementSelection();
};

window.openOrderWorkspace = function(el) {
    if (!canAccessPage('orders.list')) { alert('您沒有權限查看訂單。'); return; }
    switchMainTab('order-system', el);
};

window.openPurchasingWorkspace = function(el) {
    if (!canAccessPage('orders.po')) { alert('您沒有權限查看採購。'); return; }
    switchMainTab('purchasing-system', el);
};

