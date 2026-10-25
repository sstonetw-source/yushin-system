/* =========================================================
   管理員雲端後台：人員、廠牌、進銷存、倉庫與資料庫管理
   ========================================================= */
window.switchAdminTab = function(tab, el) {
    document.querySelectorAll('#admin-system .sub-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.admin-panel').forEach(p => p.style.display = 'none');
    document.getElementById(`admin-${tab}`).style.display = 'block';

    if (tab === 'sales') reloadSalesFromUsers();
    if (tab === 'products') loadProductManagementOverview();
    if (tab === 'health') updatePendingProductMasterButton();
    // 代理廠牌設定只需要價目表，不應順便全量讀取 orders。
    if (tab === 'agencies') Promise.all([ensureBrandSettingsLoaded(), loadSupplierWarehouseMasters()]).then(() => {
        renderKeyStatisticBrands();
        renderBrandAliasManager();
        renderCompanyAgencyBrandSettings();
        renderSupplierMappingAdmin();
        renderWarehouseMasterAdmin();
    });
    // 每次進入分析頁重讀範圍內交易及目前餘額，避免過時快取。
    if (tab === 'statistics') ensureBrandSettingsLoaded().then(async () => {
        tradeAnalysisFiltersPending=false;
        tradeAnalysisAppliedFilters=readTradeAnalysisFilters();
        await loadSalesStatistics(true);
    }).catch(err => console.error('進銷存分析載入失敗：', err));
    if (tab === 'warehouses') loadSupplierWarehouseMasters(true).then(renderWarehouseMasterAdmin);
    if (tab === 'transfer') ensureSalesListLoaded().then(populateTransferDropdowns);
};

let inventoryReceivingVisible = false;
let activeProductImportBatch = null;
// productManagementOverviewRows is retained for the Product Master editor compatibility layer.
// The admin price-list page uses its own lightweight Brand Master rows instead of loading every product.
let productManagementOverviewRows = [];
let priceListManagementRows = [];
let priceListHistoryRows = [];
let priceListHistoryFilter = '';
let pendingPriceListUploadBrand = '';
let productOverviewLimit = 200;
let productOverviewLoading = false;
let brandProductDeleteRunning = false;

window.openInventoryReceiving = function() {
    if (!canAccessPage('inventory')) return alert('需要倉庫頁權限才能收貨。');
    switchMainTab('inventory-system', document.querySelector('[data-main-nav="inventory"]'));
    switchInventoryWorkView(true);
};
window.switchInventoryWorkView = async function(receiving) {
    if (receiving && !canReceiveInventoryCapability()) return;
    inventoryReceivingVisible = receiving;
    document.getElementById('inventoryStockPanel').style.display = receiving ? 'none' : '';
    document.getElementById('inventoryReceivingPanel').style.display = receiving ? '' : 'none';
    if (!receiving) return;
    renderPurchasingReceivingWorkList(null, null, null, null, true);
    try {
        await loadPurchasingReceivingQueue(true);
        renderPurchasingReceivingWorkList(null, null, null, null, true);
    } catch (err) {
        const status = document.getElementById('inventoryReceivingStatus');
        status.textContent = '待收貨載入失敗：' + err.message;
        const retry = document.createElement('button');
        retry.textContent = '重試';
        retry.onclick = () => switchInventoryWorkView(true);
        status.appendChild(retry);
    }
};

let productOverviewCursor=null, productOverviewHasMore=false, productOverviewGeneration=0, productOverviewReloadRequested=false;
window.loadProductManagementOverview = async function() {
    if (currentUserRole !== 'admin') return;
    if (productOverviewLoading) return;
    const status = document.getElementById('productOverviewStatus');
    productOverviewLoading = true;
    if (status) status.textContent = '正在讀取價目表狀態…';
    try {
        const historyRequest = firestoreReadWithTimeout(
            db.collection('priceHistory').orderBy('createdAt', 'desc').limit(100).get(),
            '價目表操作紀錄'
        );
        const [, historySnapshot] = await Promise.all([loadBrandMaster(), historyRequest]);
        priceListManagementRows = getUnifiedBrandEntries(false)
            .filter(entry => entry?.name && entry.active !== false)
            .sort((a,b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-Hant'));
        priceListHistoryRows = (historySnapshot.docs || [])
            .map(doc => ({ id:doc.id, ...doc.data() }))
            .filter(row => row.recordType === 'PRICE_LIST');
        renderProductManagementOverview();
        renderPriceListHistory();
    } catch (err) {
        console.error('價目表管理載入失敗：', err);
        if (status) status.textContent = '價目表狀態載入失敗：' + (err?.message || err);
    } finally {
        productOverviewLoading = false;
    }
};

function priceListDateLabel(value) {
    const text = String(value || '');
    if (!text) return '—';
    return text.slice(0, 16).replace('T', ' ');
}

function priceListStatusLabel(row) {
    if (row.priceListDeletedAt && !row.priceListFile) return '已刪除';
    if (row.priceListActive === false) return '停用';
    if (row.priceListFile || row.priceListManaged) return '啟用';
    return '無版本紀錄';
}

window.renderProductManagementOverview = function() {
    const body = document.getElementById('productOverviewBody');
    const status = document.getElementById('productOverviewStatus');
    if (!body) return;
    const rows = priceListManagementRows;
    const activeCount = rows.filter(row => row.priceListManaged && row.priceListActive !== false && !row.priceListDeletedAt).length;
    const disabledCount = rows.filter(row => row.priceListActive === false && !!row.priceListFile).length;
    const deletedCount = rows.filter(row => !!row.priceListDeletedAt && !row.priceListFile).length;
    if (status) status.textContent = `共 ${rows.length} 個廠牌｜啟用價目表 ${activeCount}｜停用 ${disabledCount}｜已刪除 ${deletedCount}`;
    body.innerHTML = rows.length ? rows.map(row => {
        const hasCurrent = !!row.priceListFile;
        const state = priceListStatusLabel(row);
        const toggleLabel = row.priceListActive === false ? '啟用' : '停用';
        return `<tr>
            <td data-th="廠牌"><strong>${escapeHtml(row.name)}</strong></td>
            <td data-th="目前價目表">${escapeHtml(row.priceListFile || '尚未建立版本紀錄')}</td>
            <td data-th="檔案品項數">${row.priceListManaged ? Number(row.priceListProductCount || 0).toLocaleString() : '—'}</td>
            <td data-th="最後更新">${escapeHtml(priceListDateLabel(row.priceListUpdatedAt || row.priceListDeletedAt))}</td>
            <td data-th="狀態"><span class="price-list-state">${escapeHtml(state)}</span></td>
            <td data-th="操作" class="no-print">
                <div class="price-list-action-group">
                    <button type="button" class="btn-small" onclick="openPriceListUploadForBrand(${inlineJsValue(row.name)})">上傳新版</button>
                    <button type="button" class="btn-small btn-secondary" onclick="showPriceListHistoryForBrand(${inlineJsValue(row.name)})">紀錄</button>
                    <button type="button" class="btn-small btn-secondary" onclick="togglePriceListActive(${inlineJsValue(row.name)}, ${row.priceListActive === false ? 'true' : 'false'}, this)" ${!hasCurrent && !row.priceListManaged ? 'title="尚未有版本紀錄，仍可用來停用既有舊價目資料"' : ''}>${toggleLabel}</button>
                    <button type="button" class="btn-small btn-danger" onclick="deleteEntirePriceList(${inlineJsValue(row.name)}, this)">刪除整個價目表</button>
                </div>
            </td>
        </tr>`;
    }).join('') : '<tr><td colspan="6" style="color:#888;">尚未建立任何廠牌。</td></tr>';
};

function renderPriceListHistory() {
    const body = document.getElementById('priceListHistoryBody');
    const label = document.getElementById('priceListHistoryFilterLabel');
    if (!body) return;
    const filterKey = normalizeBrandLookupKey(priceListHistoryFilter || '');
    const rows = priceListHistoryRows.filter(row => !filterKey || normalizeBrandLookupKey(row.brand || '') === filterKey);
    if (label) label.textContent = priceListHistoryFilter ? `目前顯示：${priceListHistoryFilter}` : '顯示全部廠牌';
    const actionLabels = { IMPORT:'上傳／更新', DISABLE:'停用', ENABLE:'啟用', DELETE:'刪除價目表' };
    body.innerHTML = rows.length ? rows.map(row => `<tr>
        <td data-th="時間">${escapeHtml(priceListDateLabel(row.createdAt))}</td>
        <td data-th="廠牌">${escapeHtml(row.brand || '')}</td>
        <td data-th="動作">${escapeHtml(actionLabels[row.action] || row.action || '')}</td>
        <td data-th="檔案">${escapeHtml(row.file || '—')}</td>
        <td data-th="品項數">${Number(row.productCount || 0).toLocaleString()}</td>
        <td data-th="操作者">${escapeHtml(row.createdBy || row.createdByUid || '—')}</td>
    </tr>`).join('') : '<tr><td colspan="6" style="color:#888;">沒有符合的價目表操作紀錄。</td></tr>';
}

window.showPriceListHistoryForBrand = function(brand) {
    priceListHistoryFilter = resolveBrandName(brand || '');
    renderPriceListHistory();
    const details = document.getElementById('priceListHistoryDetails');
    if (details) {
        details.open = true;
        details.scrollIntoView?.({ behavior:'smooth', block:'nearest' });
    }
};

window.openPriceListUploadForBrand = function(brand = '') {
    if (currentUserRole !== 'admin') return;
    pendingPriceListUploadBrand = resolveBrandName(brand || '');
    const input = document.getElementById('productImportExcelInput');
    if (!input) return;
    input.value = '';
    input.click();
};

window.bulkSetProductActive = async function(active, button) {
    if (currentUserRole !== 'admin' || brandProductDeleteRunning) return;
    const ids = [...document.querySelectorAll('#productOverviewBody input:checked')].map(el=>el.value);
    if (!ids.length) return alert('請先勾選要處理的產品。');
    if (!confirm(`確定${active ? '恢復' : '停用'}勾選的 ${ids.length} 個產品？不會刪除舊訂單或成本資料。`)) return;
    button.disabled = true;
    let completed = 0;
    try {
        for (let offset=0; offset<ids.length; offset+=200) {
            const slice = ids.slice(offset,offset+200);
            const batch = db.batch();
            slice.forEach(id=>batch.update(db.collection('products').doc(id), {active, status:active?'ACTIVE':'INACTIVE', updatedAt:new Date().toISOString(), updatedBy:currentUser.uid}));
            await batch.commit();
            completed += slice.length;
            slice.forEach(id=>{
                const row = productManagementOverviewRows.find(item=>item.id===id);
                if (row) {row.active=active;row.status=active?'ACTIVE':'INACTIVE';}
                priceList.forEach(item=>{if(item.productId===id){item.active=active;item.status=active?'ACTIVE':'INACTIVE';}});
            });
        }
        refreshPriceDatalists();
        renderProductManagementOverview();
        invalidateProductFrequentCache();
        if (productManagementSourceMode === 'frequent') clearProductManagementSearch({ preserveInput:true });
        alert(`已${active ? '恢復' : '停用'} ${completed} 個產品，可重新匯入修正資料。`);
    } catch(err) {
        renderProductManagementOverview();
        alert(`已完成 ${completed} 個；剩餘處理失敗：${err.message}`);
    } finally { button.disabled=false; }
};

async function productMasterRemovalReferences(productId) {
    const operational=await productMasterOperationalBlockers(productId);
    if(operational.length)return operational;
    const queries=['orders','quotes','supplyOrders','inventoryLots','procurementDemands'].flatMap(collection=>
        [db.collection(collection).where('productId','==',productId).limit(1),
         ...(['orders','quotes'].includes(collection)?[db.collection(collection).where('productIds','array-contains',productId).limit(1)]:[db.collection(collection).where('productKey','==',productId).limit(1)])]);
    const snapshots=await Promise.all(queries.map(query=>firestoreReadWithTimeout(query.get(),'檢查歷史產品關聯')));
    return snapshots.some(snap=>snap.docs.length)?['保留歷史單據／庫存關聯']:[];
}

function updateBrandPriceListCache(brand, patch) {
    const canonical = resolveBrandName(brand);
    const id = brandMasterEntryForName(canonical)?.id || brandMasterDocumentId(canonical);
    const index = brandMasterCache.findIndex(item =>
        item.id === id
    );
    if (index >= 0) brandMasterCache[index] = normalizeBrandMasterRecord(id, { ...brandMasterCache[index], ...patch, name:canonical });
    else brandMasterCache.push(normalizeBrandMasterRecord(id, { name:canonical, active:true, ...patch }));
    invalidateBrandDerivedCaches();
}

function priceListEventRecord(brand, action, details = {}, createdAt = new Date().toISOString()) {
    return {
        recordType:'PRICE_LIST',
        brand:resolveBrandName(brand),
        action,
        file:String(details.file || ''),
        batchId:String(details.batchId || ''),
        productCount:Math.max(0, Number(details.productCount || 0)),
        productWrites:Math.max(0, Number(details.productWrites || 0)),
        costWrites:Math.max(0, Number(details.costWrites || 0)),
        createdAt,
        createdByUid:currentUser?.uid || '',
        createdBy:currentUser?.email || currentUserName || ''
    };
}

async function commitPriceListBrandEvent(brand, action, metadata, details = {}) {
    const canonical = resolveBrandName(brand);
    const now = new Date().toISOString();
    const brandRef = db.collection('brands').doc(brandMasterEntryForName(canonical)?.id || brandMasterDocumentId(canonical));
    const historyRef = db.collection('priceHistory').doc();
    const patch = { name:canonical, ...metadata, updatedAt:now };
    const batch = db.batch();
    batch.set(brandRef, patch, { merge:true });
    batch.set(historyRef, priceListEventRecord(canonical, action, details, now));
    await batch.commit();
    updateBrandPriceListCache(canonical, patch);
    priceListHistoryRows.unshift({ id:historyRef.id, ...priceListEventRecord(canonical, action, details, now) });
}

async function markPriceListImportComplete(brand, productCount, saveResult = {}) {
    const batchInfo = activeProductImportBatch || {};
    await commitPriceListBrandEvent(brand, 'IMPORT', {
        priceListManaged:true,
        priceListFile:String(batchInfo.file || ''),
        priceListBatchId:String(batchInfo.id || ''),
        priceListUpdatedAt:String(batchInfo.date || new Date().toISOString()),
        priceListProductCount:Math.max(0, Number(productCount || 0)),
        priceListActive:true,
        priceListDeletedAt:'',
        priceListLastAction:'IMPORT'
    }, {
        file:batchInfo.file || '',
        batchId:batchInfo.id || '',
        productCount,
        productWrites:saveResult.productWrites,
        costWrites:saveResult.costWrites
    });
}

function clearBrandPriceCaches(brand, productIds = []) {
    const canonicalKey = normalizeBrandLookupKey(resolveBrandName(brand));
    const idSet = new Set(productIds.filter(Boolean));
    priceList = priceList.filter(item => {
        const id = item.productId || stableProductId(item);
        if (idSet.has(id)) return false;
        return normalizeBrandLookupKey(resolveBrandName(item.brand || '')) !== canonicalKey;
    });
    productCodeMatchCache.clear();
    idSet.forEach(id => purchaseCostCache.delete(id));
    invalidateVisibleProductCosts();
    refreshPriceDatalists();
    rebuildPriceItemLookup();
}

window.togglePriceListActive = async function(brand, active, button) {
    if (!canDeleteProductMaster() || brandProductDeleteRunning || productMasterMigrationRunning) return;
    const canonical = resolveBrandName(brand);
    if (!canonical) return;
    const actionText = active ? '啟用' : '停用';
    if (!confirm(`確定${actionText}「${canonical}」價目表？\n\n產品主檔、歷史單據與庫存資料不會改動；${active ? '啟用後可再次帶入目前保存的建議售價與標準成本。' : '停用期間產品仍可查詢，但不再由價目表自動帶入價格／標準成本。'}`)) return;
    const original = button?.textContent || actionText;
    if (button) { button.disabled = true; button.textContent = '處理中…'; }
    try {
        const entry = brandMasterEntryForName(canonical);
        await commitPriceListBrandEvent(canonical, active ? 'ENABLE' : 'DISABLE', {
            priceListManaged:true,
            priceListActive:!!active,
            priceListUpdatedAt:entry?.priceListUpdatedAt || '',
            priceListLastAction:active ? 'ENABLE' : 'DISABLE'
        }, {
            file:entry?.priceListFile || '',
            batchId:entry?.priceListBatchId || '',
            productCount:entry?.priceListProductCount || 0
        });
        clearBrandPriceCaches(canonical);
        renderProductManagementOverview();
        renderPriceListHistory();
        markMainPageDirty('products');
    } catch (err) {
        alert(`${actionText}價目表失敗：${err?.message || err}`);
    } finally {
        if (button) { button.disabled = false; button.textContent = original; }
    }
};

async function readProductsForPriceListBrand(brand) {
    const canonical = resolveBrandName(brand);
    const entry = brandMasterEntryForName(canonical);
    const names = dedupeBrandsCaseInsensitive([canonical, ...(entry?.aliases || [])]).filter(Boolean);
    const rows = new Map();
    for (const field of ['brandName', 'brand']) {
        for (const name of names) {
            try {
                const found = await readQueryInBatches(
                    db.collection('products').where(field, '==', name).orderBy(firebase.firestore.FieldPath.documentId()),
                    300
                );
                found.forEach(row => rows.set(row.id, row));
            } catch (err) {
                console.warn(`讀取 ${field}=${name} 的價目表產品失敗：`, err);
            }
        }
    }
    return [...rows.values()];
}

async function readProductCostsForBackup(productIds) {
    const costs = [];
    for (let offset=0; offset<productIds.length; offset+=20) {
        const docs = await Promise.all(productIds.slice(offset, offset+20).map(id =>
            firestoreReadWithTimeout(db.collection('productCosts').doc(id).get(), '價目表成本備份')
        ));
        docs.forEach(doc => { if (doc.exists) costs.push({ id:doc.id, ...doc.data() }); });
    }
    return costs;
}

window.deleteEntirePriceList = async function(brand, button) {
    if (!canDeleteProductMaster() || brandProductDeleteRunning || productMasterMigrationRunning) return;
    const canonical = resolveBrandName(brand);
    if (!canonical) return;
    brandProductDeleteRunning = true;
    const original = button?.textContent || '刪除整個價目表';
    if (button) { button.disabled = true; button.textContent = '讀取價目表…'; }
    const clearedIds = new Set();
    try {
        const rows = await readProductsForPriceListBrand(canonical);
        const typed = prompt(`即將刪除「${canonical}」整個價目表。\n\n會清除：建議售價、標準成本。\n會保留：產品主檔、品名／規格、歷史估價單／訂單、實際採購價、庫存批次成本、庫存與廠牌設定。\n\n目前找到 ${rows.length} 個此廠牌產品主檔。\n\n輸入完整廠牌名稱「${canonical}」確認，或取消：`);
        if (typed !== canonical) return;

        const productIds = rows.map(row => row.id).filter(Boolean);
        if (button) button.textContent = '準備價目表備份…';
        const costs = await readProductCostsForBackup(productIds);
        const entry = brandMasterEntryForName(canonical);
        const backup = {
            format:'YUSHIN_PRICE_LIST_BACKUP',
            version:1,
            brand:canonical,
            createdAt:new Date().toISOString(),
            currentPriceList:{
                file:entry?.priceListFile || '',
                batchId:entry?.priceListBatchId || '',
                updatedAt:entry?.priceListUpdatedAt || '',
                productCount:entry?.priceListProductCount || 0
            },
            prices:rows.map(row => ({
                productId:row.id,
                manufacturerPartNo:row.manufacturerPartNo || row.sku || '',
                productName:row.productName || row.nameCn || row.nameEn || '',
                brandName:row.brandName || row.brand || canonical,
                listPrice:row.listPrice ?? row.price ?? null,
                lastImportBatch:row.lastImportBatch || '',
                lastImportFile:row.lastImportFile || '',
                lastImportedAt:row.lastImportedAt || ''
            })),
            productCosts:costs
        };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type:'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `價目表備份-${canonical.replace(/[\\/:*?"<>|]/g,'_')}-${Date.now()}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);

        if (!confirm(`已觸發「${canonical}」價目表備份下載。\n\n按「確定」後會清除 ${rows.length} 個產品主檔的建議售價，並刪除 ${costs.length} 筆標準成本資料。產品主檔本身不會刪除。\n\n確定繼續嗎？`)) return;

        const now = new Date().toISOString();
        for (let offset=0; offset<rows.length; offset+=200) {
            if (!canDeleteProductMaster()) throw new Error('管理員權限已變更，已停止處理。');
            const slice = rows.slice(offset, offset+200);
            const batch = db.batch();
            slice.forEach(row => {
                batch.set(db.collection('products').doc(row.id), {
                    listPrice:firebase.firestore.FieldValue.delete(),
                    price:firebase.firestore.FieldValue.delete(),
                    priceListRemovedAt:now,
                    updatedAt:now,
                    updatedBy:currentUser?.uid || ''
                }, { merge:true });
                batch.delete(db.collection('productCosts').doc(row.id));
            });
            if (button) button.textContent = `清除價格 ${Math.min(offset+slice.length, rows.length)}/${rows.length}…`;
            await batch.commit();
            slice.forEach(row => clearedIds.add(row.id));
        }

        await commitPriceListBrandEvent(canonical, 'DELETE', {
            priceListManaged:true,
            priceListFile:'',
            priceListBatchId:'',
            priceListUpdatedAt:now,
            priceListProductCount:0,
            priceListActive:false,
            priceListDeletedAt:now,
            priceListLastAction:'DELETE'
        }, {
            file:entry?.priceListFile || '',
            batchId:entry?.priceListBatchId || '',
            productCount:rows.length
        });

        clearBrandPriceCaches(canonical, productIds);
        productManagementResults = productManagementResults.map(row =>
            clearedIds.has(row.id || row.productId)
                ? { ...row, listPrice:undefined, price:0, priceListRemovedAt:now }
                : row
        );
        if (productManagementResults.length) renderProductManagementResults();
        markMainPageDirty('products');
        renderProductManagementOverview();
        renderPriceListHistory();
        alert(`「${canonical}」價目表已刪除。\n\n已清除建議售價與標準成本；產品主檔與歷史交易資料完整保留。之後可直接上傳新版價目表。`);
    } catch (err) {
        alert(`刪除價目表中斷：已處理 ${clearedIds.size} 筆。\n${err?.message || err}\n\n已完成的批次不會自動回復；可保留剛下載的備份並重新執行此操作。`);
    } finally {
        if (clearedIds.size) {
            const now = new Date().toISOString();
            productManagementResults = productManagementResults.map(row =>
                clearedIds.has(row.id || row.productId)
                    ? { ...row, listPrice:undefined, price:0, priceListRemovedAt:now }
                    : row
            );
            clearBrandPriceCaches(canonical, [...clearedIds]);
            if (productManagementResults.length) renderProductManagementResults();
            markMainPageDirty('products');
        }
        brandProductDeleteRunning = false;
        if (button) { button.disabled = false; button.textContent = original; }
    }
};

// 舊的「移除整個廠牌產品」會刪除 Product Master，已由價目表管理流程取代。
window.deleteEntireBrandProducts = function() {
    alert('「移除整個廠牌產品」已停用。請使用「刪除整個價目表」；產品主檔不會再從價目表管理頁刪除。');
};


function renderBrandAliasManager() {
    const body = document.getElementById('brandAliasManagerBody');
    if (!body) return;
    const entries = getUnifiedBrandEntries(false);
    body.innerHTML = entries.length ? entries.map(entry => `
        <tr>
            <td><strong>${escapeHtml(entry.name)}</strong></td>
            <td><input type="text" class="brand-alias-input" value="${escapeAttr((entry.aliases || []).join(', '))}" placeholder="例如：Beckman, Beckman Coulter Life Sciences" style="width:100%;box-sizing:border-box;"></td>
            <td class="no-print"><button type="button" class="btn-small btn-secondary" onclick="saveBrandAliases(${inlineJsValue(entry.name)}, this)">儲存別名</button></td>
        </tr>`).join('') : '<tr><td colspan="3" style="color:#888;">尚未建立廠牌主檔。</td></tr>';
}

window.saveBrandAliases = async function(brandName, button) {
    if (currentUserRole !== 'admin') return;
    const canonical = resolveBrandName(brandName);
    const row = button?.closest?.('tr');
    const raw = String(row?.querySelector('.brand-alias-input')?.value || '');
    const aliases = dedupeBrandsCaseInsensitive(
        raw.split(/[,，\n]+/).map(value => String(value || '').trim()).filter(Boolean)
    ).filter(alias => String(alias).trim() !== canonical);
    if (aliases.length > 9) {
        alert('每個標準廠牌最多設定 9 個別名，請刪除不必要的名稱。');
        return;
    }
    const canonicalKey = normalizeBrandLookupKey(canonical);
    const conflict = getUnifiedBrandEntries(false).find(entry => {
        if (normalizeBrandLookupKey(entry.name) === canonicalKey) return false;
        const otherKeys = [entry.name, ...(entry.aliases || [])].map(normalizeBrandLookupKey);
        return aliases.some(alias => otherKeys.includes(normalizeBrandLookupKey(alias)));
    });
    if (conflict) {
        alert(`別名已屬於另一個標準廠牌「${conflict.name}」。每個別名只能對應一個廠牌主檔。`);
        return;
    }
    const state = beginActionButton(button, '儲存中…');
    if (!state) return;
    try {
        await upsertBrandMaster(canonical, { aliases, replaceAliases:true, active:true });
        renderBrandAliasManager();
        renderProductBrandBrowser();
        populateQuoteBrandDropdowns();
        populateOrderBrandDropdown();
        populateEquipmentBrandDropdown();
        if (typeof populateForecastBrandDropdown === 'function')
            populateForecastBrandDropdown(document.getElementById('forecastBrand')?.value || '');
        if (salesStatisticsOrders.length) renderSalesStatistics();
        showActionFeedback(`已更新「${canonical}」廠牌別名。別名只用來辨識輸入，系統會統一顯示標準名稱。`);
    } catch (err) {
        console.error('儲存廠牌別名失敗：', err);
        alert('儲存廠牌別名失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, state);
    }
};

function renderKeyStatisticBrands() {
    const container = document.getElementById('keyStatisticBrands');
    if (!container) return;
    const brands = [...keyStatisticBrands];
    container.innerHTML = brands.map(brand => `<div class="stat-brand-card">
            <div class="stat-brand-card-head"><span>${escapeHtml(brand)}</span><label><input type="checkbox" checked onchange="removeStatisticBrand(${inlineJsValue(brand)})"> 獨立統計</label></div>
        </div>`).join('');
    renderOtherStatisticBrands();
}

function normalizeStatisticBrandKey(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\-_]+/g, '');
}

function statisticBrandAliasLookup() {
    const lookup = new Map();
    const masterEntries = getUnifiedBrandEntries(false);
    keyStatisticBrands.forEach(brand => {
        const canonical = resolveBrandName(brand) || brand;
        lookup.set(normalizeStatisticBrandKey(canonical), canonical);
        lookup.set(normalizeStatisticBrandKey(brand), canonical);

        const master = masterEntries.find(entry => normalizeBrandLookupKey(entry.name) === normalizeBrandLookupKey(canonical));
        const aliases = dedupeBrandsCaseInsensitive([
            ...(keyStatisticBrandAliases[brand] || []),
            ...(keyStatisticBrandAliases[canonical] || []),
            ...(master?.aliases || [])
        ]);
        aliases.forEach(alias => lookup.set(normalizeStatisticBrandKey(alias), canonical));
    });
    return lookup;
}

function rawBrandsWithOrderCounts() {
    const entries = new Map();

    // 即使某廠牌目前還沒有訂單，只要已存在 Brand Master，也要能在設定頁看到，
    // 並明確選擇要獨立統計或歸入「其他廠牌」。
    getUnifiedBrandEntries(false).forEach(entry => {
        const key = normalizeStatisticBrandKey(entry.name);
        if (key && !entries.has(key)) entries.set(key, { name: entry.name, count: 0 });
    });

    const lines = salesStatisticsOrders.flatMap(salesStatisticOrderLines);
    lines.forEach(order => {
        const brand = String(order.brand || '').trim();
        if (!brand) return;
        const key = normalizeStatisticBrandKey(brand);
        if (!entries.has(key)) entries.set(key, { name: brand, count: 0 });
        entries.get(key).count++;
    });
    return [...entries.values()];
}

function renderOtherStatisticBrands() {
    const container = document.getElementById('otherStatisticBrands');
    if (!container) return;
    const lookup = statisticBrandAliasLookup();
    const allOthers = rawBrandsWithOrderCounts().filter(item => !lookup.has(normalizeStatisticBrandKey(item.name)))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
    const query = String(document.getElementById('otherStatisticBrandSearch')?.value || '').normalize('NFKC').trim().toLocaleLowerCase();
    const count = document.getElementById('otherStatisticBrandCount');
    if (count) count.textContent = `共 ${allOthers.length} 個其他廠牌`;

    const matches=allOthers.filter(item=>!query||String(item.name||'').normalize('NFKC').toLocaleLowerCase().includes(query));
    container.innerHTML=matches.map(item=>`<div class="stat-brand-other-row"><span>${escapeHtml(item.name)}</span><label><input type="checkbox" onchange="promoteStatisticBrand(${inlineJsValue(item.name)})"> 獨立統計</label></div>`).join('')||'<p>沒有符合的廠牌。</p>';
}

window.promoteStatisticBrand = function(brand) {
    if (!includesBrandCaseInsensitive(keyStatisticBrands, brand)) keyStatisticBrands.push(brand);
    renderKeyStatisticBrands();
};

window.removeStatisticBrand = function(brand) {
    keyStatisticBrands = keyStatisticBrands.filter(value => value !== brand);
    renderKeyStatisticBrands();
};

window.addStatisticBrand = function() {
    const input = document.getElementById('newStatisticBrandName');
    const brand = String(input?.value || '').trim();
    const independent = document.getElementById('newStatisticBrandIndependent')?.checked === true;
    if (!brand) { alert('請輸入廠牌名稱。'); return; }
    const existing = getUnifiedBrandEntries(false).find(entry =>
        normalizeBrandLookupKey(entry.name) === normalizeBrandLookupKey(brand)
        || (entry.aliases || []).some(alias => normalizeBrandLookupKey(alias) === normalizeBrandLookupKey(brand))
    );

    if (existing) {
        if (independent && !includesBrandCaseInsensitive(keyStatisticBrands, existing.name)) {
            keyStatisticBrands.push(existing.name);
        } else if (!independent) {
            alert('這個廠牌已存在於廠牌主檔。');
            return;
        }
    } else {
        brandMasterCache.push(normalizeBrandMasterRecord('', {
            name: brand,
            aliases: [],
            isKeyBrand: independent,
            companies: [],
            active: true
        }));
        if (independent) keyStatisticBrands.push(brand);
    }

    input.value = '';
    const independentInput = document.getElementById('newStatisticBrandIndependent');
    if (independentInput) independentInput.checked = false;
    renderKeyStatisticBrands();
};

window.syncBrandsFromProductMaster = async function() {
    if (currentUserRole !== 'admin') return;
    const button = document.getElementById('syncBrandsFromProductsBtn');
    const status = document.getElementById('syncBrandsFromProductsStatus');
    const buttonState = beginActionButton(button, '同步中…');
    if (button && !buttonState) return;

    try {
        await loadBrandMaster();
        const brands = new Map();
        let cursor = null;
        let scanned = 0;
        const pageSize = 300;

        while (true) {
            let query = db.collection('products')
                .orderBy(firebase.firestore.FieldPath.documentId())
                .limit(pageSize);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '產品主檔廠牌同步');
            if (snapshot.empty) break;

            snapshot.docs.forEach(doc => {
                const data = doc.data() || {};
                const name = String(data.brandName || data.brand || '').trim();
                const key = normalizeBrandLookupKey(name);
                if (!key || ['其他', '其他廠牌', '維修'].some(skip => normalizeBrandLookupKey(skip) === key)) return;
                if (!brands.has(key)) brands.set(key, name);
            });

            scanned += snapshot.size;
            if (status) status.textContent = `正在掃描產品主檔：已讀取 ${scanned} 筆，找到 ${brands.size} 個廠牌…`;
            cursor = snapshot.docs[snapshot.docs.length - 1];
            if (snapshot.size < pageSize) break;
            await Promise.resolve();
        }

        const missing = [...brands.values()].filter(name => !brandMasterEntryForName(name));
        for (let i = 0; i < missing.length; i++) {
            if (status) status.textContent = `正在補齊廠牌主檔：${i + 1}/${missing.length} ${missing[i]}`;
            await upsertBrandMaster(missing[i], { active:true });
        }

        populateQuoteBrandDropdowns();
        populateOrderBrandDropdown();
        populateEquipmentBrandDropdown();
        if (typeof populateForecastBrandDropdown === 'function')
            populateForecastBrandDropdown(document.getElementById('forecastBrand')?.value || '');
        renderKeyStatisticBrands();
        renderBrandAliasManager();
        renderCompanyAgencyBrandSettings();

        const message = `同步完成：掃描 ${scanned} 筆產品，辨識 ${brands.size} 個廠牌，新增 ${missing.length} 個廠牌主檔；既有獨立統計與報價公司限制未變更。`;
        if (status) status.textContent = message;
        showActionFeedback(message);
    } catch (err) {
        console.error('從產品主檔同步廠牌失敗：', err);
        if (status) status.textContent = '同步失敗：' + (err?.message || err);
        alert('同步廠牌失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
};

window.saveKeyStatisticBrands = async function() {
    if (currentUserRole !== 'admin') return;
    const selected = normalizeThermoBrandList(keyStatisticBrands);
    const aliases = {};
    selected.forEach(brand => { aliases[brand] = dedupeBrandsCaseInsensitive(keyStatisticBrandAliases[brand] || []); });
    try {
        await db.collection('settings').doc('salesStatistics').set({ keyBrands: selected, brandAliases: aliases }, { merge: true });
        keyStatisticBrands = selected;
        keyStatisticBrandAliases = aliases;
        await syncLegacyBrandSettingsToMaster();
        refreshBusinessBrandControls();
        if (salesStatisticsOrders.length) renderSalesStatistics();
        renderKeyStatisticBrands();
        renderCompanyAgencyBrandSettings();
        alert('已儲存廠牌與進銷存統計設定，並同步廠牌主檔。');
    } catch (err) {
        alert('儲存設定失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function renderCompanyAgencyBrandSettings() {
    const container = document.getElementById('companyAgencyBrandSettings');
    if (!container) return;
    const brands = getUnifiedBrandNames(false);
    const companies = ['yushin', 'morningstar', 'MULTI-LIFE'];
    container.innerHTML = companies.map(company => {
        const info = companyData[company];
        const selected = companyAgencyBrands[company] || [];
        const brandChoices = brands.length ? brands.map(brand =>
            `<label style="display:inline-block;margin:5px 12px 5px 0;font-size:13px;"><input type="checkbox" class="company-agency-brand" data-company="${company}" value="${escapeAttr(brand)}" ${includesBrandCaseInsensitive(selected, brand) ? 'checked' : ''}> ${escapeHtml(brand)}</label>`
        ).join('') : '<span style="color:#888;font-size:13px;">請先建立廠牌主檔廠牌。</span>';
        return `<div style="padding:12px 0;border-bottom:1px solid #ddd;"><strong>${escapeHtml(info.title)}（${escapeHtml(info.prefix)}）</strong><div style="margin-top:6px;">${brandChoices}</div></div>`;
    }).join('');
}

window.saveCompanyAgencyBrands = async function() {
    if (currentUserRole !== 'admin') return;
    const companies = ['yushin', 'morningstar', 'MULTI-LIFE'];
    const next = { yushin: [], morningstar: [], 'MULTI-LIFE': [] };
    document.querySelectorAll('.company-agency-brand:checked').forEach(input => next[input.dataset.company].push(input.value));
    companies.forEach(company => { next[company] = normalizeThermoBrandList(next[company]); });
    try {
        await db.collection('settings').doc('companyAgencyBrands').set({ companies: next }, { merge: true });
        companyAgencyBrands = next;
        companyAgencyBrandsConfigured = true;
        await syncLegacyBrandSettingsToMaster();
        refreshBusinessBrandControls();
        alert('已儲存各廠牌的報價公司限制。未勾選任何公司的廠牌維持不限制。');
    } catch (err) {
        alert('儲存設定失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function salesStatisticsQueryWindow() {
    const end = document.getElementById('salesStatsEnd')?.value || localDateString();
    const currentQuarterStartMonth = new Date().getMonth();
    const defaultStart = `${new Date().getFullYear()}-${String(currentQuarterStartMonth + 1).padStart(2, '0')}-01`;
    const start = document.getElementById('salesStatsStart')?.value || defaultStart;
    return { start, end };
}

async function preloadSalesStatisticsProductCosts(orders = []) {
    const formalLines = (orders || []).flatMap(salesStatisticOrderLines)
        .filter(order => (order.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER');
    if (!formalLines.length) return;
    await preloadPurchaseCostsForItems(formalLines);
}

