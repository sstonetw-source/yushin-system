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
        if (productBrandBrowseCurrent) reloadCurrentProductBrand();
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

// 管理員銷售統計以「訂單」為準，避免把尚未成交的估價單也算進營收。
function readTradeAnalysisFilters() {
    const {start,end}=salesStatisticsQueryWindow();
    return {start,end,sales:document.getElementById('salesStatsSalesFilter')?.value||'',
        brand:document.getElementById('salesStatsBrandFilter')?.value||'',
        line:document.getElementById('salesStatsLineFilter')?.value||'',
        type:document.getElementById('salesStatsTypeFilter')?.value||''};
}
function tradeAnalysisQueryKey(tab, filters) {
    return JSON.stringify([currentUser?.uid||'',tab,...(tab==='inventory'?[]:[filters.start,filters.end])]);
}
function applyTradeAnalysisSnapshot(snapshot) {
    salesStatisticsOrders=snapshot.orders;
    inventoryAnalysisSupplyOrders=snapshot.supplies;
    inventoryAnalysisDirectShipSupplyOrders=snapshot.supplies.filter(row=>row.fulfillmentType==='DIRECT_SHIP');
    inventoryAnalysisReceipts=[];
    inventoryAnalysisLots=snapshot.lots;
    inventoryAnalysisLotCosts=new Map(snapshot.lotCosts.map(row=>[row.id,row]));
    tradeAnalysisWarehouseStocks=snapshot.stocks;
    tradeAnalysisSourceOrders=new Map(snapshot.sourceOrders.map(row=>[row.id,row]));
    snapshot.products.forEach(row=>cacheProductLookupItem(productMasterDocToPriceItem({id:row.id,data:()=>row})));
    rebuildPriceItemLookup();
}
window.loadSalesStatistics = function(force = false) {
    if (currentUserRole !== 'admin') return Promise.resolve();
    if(force){tradeAnalysisSnapshots.clear();tradeAnalysisRevision++;}
    if (salesStatisticsLoadPromise) return salesStatisticsLoadPromise;
    const filters=tradeAnalysisAppliedFilters||(tradeAnalysisAppliedFilters=readTradeAnalysisFilters());
    const tab=tradeAnalysisTab, key=tradeAnalysisQueryKey(tab,filters);
    if(!document.getElementById('salesStatsStart').value)document.getElementById('salesStatsStart').value=filters.start;
    if(!document.getElementById('salesStatsEnd').value)document.getElementById('salesStatsEnd').value=filters.end;
    if(tab!=='inventory'&&filters.start>filters.end){
        tradeAnalysisReady=false;
        resetSimpleTradeAnalysisDetail();
        setTradeAnalysisLoading(false);
        document.querySelectorAll('.trade-analysis-cards strong').forEach(el=>el.textContent='－');
        document.getElementById('tradeAnalysisStatus').textContent='起日不可晚於迄日。';
        return Promise.resolve();
    }
    const cached=tradeAnalysisSnapshots.get(key);
    if(cached&&Date.now()-cached.loadedAt<60000){
        applyTradeAnalysisSnapshot(cached);
        tradeAnalysisLoadedKey=key;tradeAnalysisReady=true;
        renderSalesStatistics();setTradeAnalysisLoading(false);
        return Promise.resolve();
    }
    tradeAnalysisReady=false;setTradeAnalysisLoading(true);
    const requestedRole=currentUserRole, requestedUid=currentUser?.uid, revision=tradeAnalysisRevision;
    const stillAuthorized=()=>requestedRole===currentUserRole&&requestedUid===currentUser?.uid;
    salesStatisticsLoadPromise=loadTradeAnalysisSnapshot(tab,filters).then(snapshot=>{
        if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid || revision!==tradeAnalysisRevision) return;
        snapshot.loadedAt=Date.now();
        // Keep only the current period for each tab; never accumulate history in memory.
        for(const [oldKey,value] of tradeAnalysisSnapshots)if(value.tab===tab)tradeAnalysisSnapshots.delete(oldKey);
        tradeAnalysisSnapshots.set(key,snapshot);
        if(key!==tradeAnalysisQueryKey(tradeAnalysisTab,tradeAnalysisAppliedFilters))return;
        applyTradeAnalysisSnapshot(snapshot);
        tradeAnalysisLoadedKey=key;tradeAnalysisReady=true;
        renderSalesStatistics();
    }).catch(err=>{
        if(!stillAuthorized()||key!==tradeAnalysisQueryKey(tradeAnalysisTab,tradeAnalysisAppliedFilters))return;
        tradeAnalysisReady=false;
        document.getElementById('tradeAnalysisStatus').textContent='讀取失敗：'+(err.message||err)+'。請按查詢重試。';
        document.querySelectorAll('.trade-analysis-cards strong').forEach(el=>el.textContent='讀取失敗');
    }).finally(()=>{
        salesStatisticsLoadPromise = null;
        if(!stillAuthorized())return;
        setTradeAnalysisLoading(false);
        if(key!==tradeAnalysisQueryKey(tradeAnalysisTab,tradeAnalysisAppliedFilters)||revision!==tradeAnalysisRevision)loadSalesStatistics();
    });
    return salesStatisticsLoadPromise;
};

async function readDocumentsByIds(collectionName, ids, chunkSize = 30) {
    const uniqueIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))];
    const jobs=[];
    for(let i=0;i<uniqueIds.length;i+=chunkSize){
        const batch=uniqueIds.slice(i,i+chunkSize);
        jobs.push(async()=>{
            const snap=await firestoreReadWithTimeout(db.collection(collectionName==='supplyOrders'&&currentUserRole==='warehouse'&&permissionRulesReady?'receivingSupplyOrders':collectionName).where(firebase.firestore.FieldPath.documentId(),'in',batch).get(),collectionName+' 指定文件');
            return snap.docs.map(doc=>({...doc.data(),id:doc.id}));
        });
    }
    return (await runReadJobs(jobs,4)).flat();
}

async function readTradeAnalysisSuppliesByOrders(ids) {
    const unique=[...new Set(ids.filter(Boolean))],rows=[];
    for(let i=0;i<unique.length;i+=30){
        rows.push(...await readQueryInBatches(supplyOrdersCollection().where('orderId','in',unique.slice(i,i+30))));
    }
    return rows;
}
async function readTradeAnalysisLotCosts(ids) {
    const costs=await readDocumentsByIds('inventoryLotCosts',ids);
    const roots=await readDocumentsByIds('inventoryLotCosts',costs.map(row=>row.costSourceLotId));
    const byId=new Map([...costs,...roots].map(row=>[row.id,row]));
    const effective=costs.map(row=>row.costSourceLotId?{...byId.get(row.costSourceLotId),id:row.id}:row);
    const sources=await readDocumentsByIds('supplyOrders',effective.filter(row=>row.unitCost===undefined).map(row=>row.costSourceSupplyId));
    const supplies=new Map(sources.map(row=>[row.id,row]));
    return effective.map(row=>row.unitCost===undefined&&row.costSourceSupplyId
        ? {...row,unitCost:supplies.get(row.costSourceSupplyId)?.unitCost}:row);
}
async function loadTradeAnalysisSnapshot(tab, {start,end}) {
    const snapshot={tab,orders:[],supplies:[],lots:[],lotCosts:[],stocks:[],sourceOrders:[],products:[]};
    // Each tab reads only the sources used by its cohort/current-stock calculation.
    if(tab==='purchasing'){
        snapshot.supplies=await readQueryInBatches(supplyOrdersCollection()
            .where('orderDate','>=',start).where('orderDate','<=',end).orderBy('orderDate','desc'));
        snapshot.sourceOrders=await readDocumentsByIds('orders',snapshot.supplies.map(row=>row.orderId));
    }else if(tab==='selling'){
        snapshot.orders=await readQueryInBatches(db.collection('orders')
            .where('orderDate','>=',start).where('orderDate','<=',end).orderBy('orderDate','desc'));
        const lines=snapshot.orders.flatMap(salesStatisticOrderLines);
        const events=line=>[...savedDeliveryRecords(line),...savedReturnRecords(line)];
        const lotIds=lines.flatMap(line=>events(line).flatMap(row=>(row.lotAllocations||[]).map(a=>a.lotId)));
        const directOrderIds=lines.filter(line=>events(line).some(row=>!(row.lotAllocations||[]).length)).map(line=>line.id);
        [snapshot.lotCosts,snapshot.supplies]=await Promise.all([
            readTradeAnalysisLotCosts(lotIds),readTradeAnalysisSuppliesByOrders(directOrderIds)
        ]);
    }else if(tab==='inventory'){
        [snapshot.stocks,snapshot.lots]=await Promise.all([
            readQueryInBatches(db.collection('warehouseStocks').where('onHand','>',0).orderBy('onHand')),
            readQueryInBatches(db.collection('inventoryLots').where('remainingQty','>',0).orderBy('remainingQty'))
        ]);
        snapshot.lotCosts=await readTradeAnalysisLotCosts(snapshot.lots.map(row=>row.costLotId||row.id));
        // Transfer lots may reference their root cost, while valuation looks up the lot ID.
        const costs=new Map(snapshot.lotCosts.map(row=>[row.id,row]));
        snapshot.lotCosts=snapshot.lots.map(row=>({...costs.get(row.costLotId||row.id),id:row.id}));
    }
    const records=[...snapshot.supplies,...snapshot.stocks,...snapshot.lots,
        ...snapshot.orders.flatMap(salesStatisticOrderLines),...snapshot.sourceOrders.flatMap(salesStatisticOrderLines)];
    snapshot.products=await readDocumentsByIds('products',records.map(row=>row.productId||row.productKey));
    return snapshot;
}

function protectedAllocationCost(records) {
    return (Array.isArray(records) ? records : []).reduce((sum, record) => {
        return sum + (Array.isArray(record.lotAllocations) ? record.lotAllocations : []).reduce((allocationSum, allocation) => {
            const lotCost = inventoryAnalysisLotCosts.get(allocation.lotId);
            return allocationSum + Number(allocation.qty || 0) * Number(lotCost?.unitCost || 0);
        }, 0);
    }, 0);
}

function protectedHistoricalCogs(start, end) {
    return salesStatisticsOrders.reduce((sum, order) => {
        if (normalizedOrderStatus(order) !== 'normal') return sum;
        const delivered = savedDeliveryRecords(order).filter(record => dateInStatsRange(record.date, start, end));
        const returned = savedReturnRecords(order).filter(record => dateInStatsRange(record.date, start, end));
        return sum + protectedAllocationCost(delivered) - protectedAllocationCost(returned);
    }, 0);
}

function inventoryAnalysisTotals(start,end) {
    let purchase = 0;
    inventoryAnalysisReceipts.forEach(receipt => {
        const lotCost = inventoryAnalysisLotCosts.get(receipt.lotId);
        purchase += Number(receipt.qty || 0) * Number(lotCost?.unitCost || 0);
    });
    // 原廠直送不進倉庫，因此採購成本直接由 supplyOrders 的實際到貨量計入；
    // 未到貨的訂購量仍是在途，不能提前算成期間採購。
    inventoryAnalysisDirectShipSupplyOrders.forEach(supply => {
        purchase += Number(supply.receivedQty || 0) * Number(supply.unitCost || 0);
    });
    const sales = salesStatisticsOrders.flatMap(salesStatisticOrderLines).reduce((sum, order) => {
        const contribution = calculateOrderStatsContribution(order, start, end);
        return sum + contribution.actualSales;
    }, 0);
    const stockValue = inventoryAnalysisLots.reduce((sum, lot) => {
        const lotCost = inventoryAnalysisLotCosts.get(lot.id);
        return sum + Number(lot.remainingQty || 0) * Number(lotCost?.unitCost || 0);
    }, 0);
    // 在途價值直接由 supplyOrders 的未到貨數量計算；PO 文件不再維護到貨狀態。
    const incoming = inventoryAnalysisSupplyOrders
        .filter(supply => (supply.fulfillmentType || 'WAREHOUSE') !== 'DIRECT_SHIP')
        .filter(supply => !isPurchaseTerminalStatus(supply.status))
        .reduce((sum, supply) => {
            const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
            return sum + remaining * Number(supply.unitCost || 0);
        }, 0);
    const cogs = protectedHistoricalCogs(start, end);
    return { purchase, sales, difference: sales - purchase, stockValue, incoming, cogs, grossProfit:sales-cogs };
}
function renderInventoryAnalysisSummary(start,end){
    const t=inventoryAnalysisTotals(start,end);
    const ids={
        invAnalysisPurchases:t.purchase,
        invAnalysisSales:t.sales,
        invAnalysisDifference:t.difference,
        invAnalysisGrossProfit:t.grossProfit,
        invAnalysisStockValue:t.stockValue,
        invAnalysisIncoming:t.incoming
    };
    Object.entries(ids).forEach(([id,v])=>{
        const el=document.getElementById(id);
        if(el)el.innerText=formatStatsMoney(v);
    });
    const rate=document.getElementById('invAnalysisGrossProfitRate');
    if(rate)rate.innerText=t.sales?`毛利率 ${(t.grossProfit/t.sales*100).toFixed(1)}%`:'毛利率 －';
}

function salesAmount(order) {
    const total = parseFloat(String(order.totalPrice == null ? '' : order.totalPrice).replace(/,/g, ''));
    if (Number.isFinite(total)) return total;
    return (parseFloat(order.qty) || 0) * (parseFloat(order.unitPrice) || 0);
}

// 訂單的 costPrice 是「每單位含稅進貨成本」，故需乘上數量才是該筆訂單的總成本。
function normalizeItemCode(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function normalizeItemCodeLoose(value) {
    return normalizeItemCode(value).replace(/[\-_.\/]+/g, '');
}

function findPriceItemByCodeValue(value, preferredBrand = '') {
    const normalized = normalizeItemCode(value);
    const loose = normalizeItemCodeLoose(value);
    if (!normalized && !loose) return null;
    const preferredKey = normalizeBrandLookupKey(resolveBrandName(preferredBrand || ''));
    const candidates = priceList.filter(item => {
        if (item.status === 'INACTIVE' || item.active === false) return false;
        const codeMatches = normalizeItemCode(item.model) === normalized
            || (!!loose && normalizeItemCodeLoose(item.model) === loose);
        if (!codeMatches) return false;
        if (!preferredKey) return true;
        return normalizeBrandLookupKey(resolveBrandName(item.brand || '')) === preferredKey;
    });
    return candidates.length === 1 ? candidates[0] : null;
}

function cacheProductLookupItem(item) {
    if (!item) return null;
    const productId = item.productId || stableProductId(item);
    const next = normalizeProductMasterItem({ ...item, productId });
    priceList = priceList.filter(row => (row.productId || stableProductId(row)) !== productId);
    if (next.status !== 'INACTIVE' && next.active !== false) priceList.push(next);
    productCodeMatchCache.delete(normalizeItemCodeLoose(next.model || ''));
    rebuildPriceItemLookup();
    return next;
}

async function findProductsByCode(value, options = {}) {
    const normalized = normalizeItemCodeLoose(value);
    if (!normalized) return [];
    if (productCodeMatchCache.has(normalized)) return productCodeMatchCache.get(normalized);
    try {
        // Only page exact-code matches, never scan the product catalogue.
        const active = [];
        let cursor = null;
        while (true) {
            let query = db.collection('products').where('normalizedPartNo', '==', normalized).limit(50);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '產品主檔貨號查詢');
            active.push(...snapshot.docs.map(productMasterDocToPriceItem)
                .filter(item => item.status !== 'INACTIVE' && item.active !== false));
            if (snapshot.size < 50) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
        }
        const merged = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
        active.forEach(item => merged.set(item.productId || stableProductId(item), item));
        priceList = [...merged.values()];
        rebuildPriceItemLookup();
        productCodeMatchCache.set(normalized, active);
        return active;
    } catch (err) {
        console.warn('產品主檔貨號查詢失敗：', err);
        if (options.throwOnError) throw err;
        return [];
    }
}

function selectProductCodeMatch(matches, preferredBrand = '') {
    const preferredKey = normalizeBrandLookupKey(resolveBrandName(preferredBrand || ''));
    if (preferredKey) {
        const preferred = matches.filter(item =>
            normalizeBrandLookupKey(resolveBrandName(item.brand || '')) === preferredKey
        );
        return preferred.length === 1 ? preferred[0] : null;
    }
    return matches.length === 1 ? matches[0] : null;
}

async function findProductByCode(value, preferredBrand = '') {
    return selectProductCodeMatch(await findProductsByCode(value), preferredBrand);
}

function applyQuoteProductMatch(row, match) {
    if (!row || !match) return false;

    const codeInput = row.querySelector('.item-model');
    const lookupBrand = productLookupBrand(codeInput, quoteRowBrandValue(row));
    codeInput.dataset.matchedProductCode = normalizeItemCodeLoose(match.model || codeInput.value);
    if (!lookupBrand) codeInput.dataset.autofillBrand = normalizeBrandLookupKey(resolveBrandName(match.brand || ''));
    row.querySelector('.item-en').value = match.nameEn || '';
    row.querySelector('.item-cn').value = match.nameCn || '';
    row.querySelector('.item-model').value = match.model || row.querySelector('.item-model').value || '';

    const brandSelect = row.querySelector('.item-brand');
    if (brandSelect && match.brand) {
        selectBrandInDropdown(brandSelect, resolveBrandName(match.brand));
        onQuoteBrandSelectChange(brandSelect);
    }

    row.querySelector('.item-product-line').value = match.productLine || '';
    row.querySelector('.item-product-type').value = match.productType || '';
    row.querySelector('.item-product-id').value = match.productId || stableProductId(match);
    const brandIdInput = row.querySelector('.item-brand-id');
    if (brandIdInput) brandIdInput.value = match.brandId || brandIdForName(match.brand || '');
    row.querySelector('.item-spec').value = match.spec || match.specification || '';

    const priceInput = row.querySelector('.inc-price');
    if (priceInput && match.price !== undefined && match.price !== null && String(match.price).trim() !== '') {
        priceInput.value = match.price;
        onIncPriceChange(priceInput);
    } else {
        if (priceInput) { priceInput.value = ''; onIncPriceChange(priceInput); }
        else calculateTotals();
    }
    refreshQuoteWarehouseStock(row);
    return true;
}

window.onItemModelInput = function(input) {
    clearTimeout(quoteProductChecks.get(input)?.timer);
    clearChangedProductDetails(input, 'quote');
    queueProductCodeSuggestions(input.value);
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    const row = input.closest('tr');
    clearProductStockHint(row?.querySelector('.quote-warehouse-stock-hint'));
    ['.item-product-id', '.item-product-line', '.item-product-type'].forEach(key => {
        const field = row?.querySelector(key); if (field) field.value = '';
    });
    input.dataset.autofillStatus = input.value.trim() ? 'checking' : '';
    const check = {};
    quoteProductChecks.set(input, check);
    if (input.value.trim()) check.timer = setTimeout(() => onItemModelChange(input), 180);
};

function stableProductId(item) {
    const canonicalBrand = resolveBrandName(item?.brand || item?.brandName || '');
    const brand = normalizeBrandLookupKey(canonicalBrand);
    const code = normalizeItemCode(item?.model || item?.manufacturerPartNo || item?.sku || '');
    if (code) return `prd:${encodeURIComponent(brand)}:${encodeURIComponent(code)}`;
    const name = String(item?.nameCn || item?.productName || item?.nameEn || '').normalize('NFKC').trim().toLocaleLowerCase();
    return `prd:${encodeURIComponent(brand)}:name:${encodeURIComponent(name)}`;
}

function normalizeProductTypeValue(value) {
    const raw = String(value || '').normalize('NFKC').trim();
    if (!raw) return '';
    const key = raw.replace(/[\s_-]+/g, '').toLocaleLowerCase();
    const aliases = {
        instrument:'Instrument', instruments:'Instrument', 儀器:'Instrument', 仪器:'Instrument', 機器:'Instrument', 机器:'Instrument',
        reagent:'Reagent', reagents:'Reagent', 試劑:'Reagent', 试剂:'Reagent',
        consumable:'Consumable', consumables:'Consumable', 耗材:'Consumable', 消耗品:'Consumable',
        accessory:'Accessory', accessories:'Accessory', 配件:'Accessory', 附件:'Accessory',
        service:'Service', services:'Service', 服務:'Service', 服务:'Service', 維修:'Service', 维修:'Service'
    };
    return aliases[key] || raw;
}

function normalizeProductMasterItem(item) {
    const status = String(item.status || '').trim().toUpperCase();
    const active = item.active !== false && status !== 'INACTIVE';
    return {
        ...item,
        productId: item.productId || stableProductId(item),
        sku: item.sku || item.model || '',
        supplier: String(item.supplier || '').trim(),
        spec: item.spec || '',
        unit: String(item.unit || item.uom || '').trim(),
        productLine: String(item.productLine || '').trim(),
        productType: normalizeProductTypeValue(item.productType || item.category || ''),
        source: String(item.source || '').trim().toUpperCase(),
        status: status || (active ? 'ACTIVE' : 'INACTIVE'),
        inventoryTracked: !!item.inventoryTracked,
        lotTracked: !!item.lotTracked,
        expiryTracked: !!item.expiryTracked,
        active
    };
}

function normalizeProductMasterList(items) {
    return (items || []).map(normalizeProductMasterItem);
}

function brandMasterEntryForName(value) {
    const key = normalizeBrandLookupKey(resolveBrandName(value));
    return getUnifiedBrandEntries(true).find(entry => normalizeBrandLookupKey(entry.name) === key) || null;
}

function brandIdForName(value) {
    return brandMasterEntryForName(value)?.id || '';
}

function productMasterForRecord(record = {}) {
    const productId = String(record?.productId || '').trim();
    if (productId) {
        const product = priceList.find(item =>
            String(item.productId || '') === productId
            && item.status !== 'INACTIVE' && item.active !== false
        );
        if (product) return product;
    }
    return findPriceItemForOrder(record);
}

function brandIdentityForRecord(record = {}) {
    const product = productMasterForRecord(record);
    if (product) {
        const brand = resolveBrandName(product.brand || '');
        return { brand, brandId: product.brandId || brandIdForName(brand) };
    }
    const savedBrandId = String(record?.brandId || '').trim();
    if (savedBrandId) {
        const entry = getUnifiedBrandEntries(true).find(item => item.id === savedBrandId);
        if (entry) return { brand: entry.name, brandId: entry.id };
    }
    const brand = resolveBrandName(record?.brand || '');
    return { brand, brandId: brandIdForName(brand) };
}



async function findProductForPurchaseItem(item) {
    const productId = String(item?.productId || '').trim();
    if (productId) {
        const cached = priceList.find(product => String(product.productId || '') === productId);
        if (cached) return cached;
        try {
            const snap = await firestoreReadWithTimeout(
                db.collection('products').doc(productId).get(),
                '採購產品主檔'
            );
            if (snap.exists) {
                const product = productMasterDocToPriceItem(snap);
                if (product.status !== 'INACTIVE' && product.active !== false) return cacheProductLookupItem(product);
            }
        } catch (err) {
            console.warn('採購產品主檔 productId 查詢失敗：', err);
        }
    }
    const code = item?.itemCode || item?.productCode || item?.code || item?.model || '';
    return code ? await findProductByCode(code) : null;
}

async function preloadPurchaseCostsForItems(purchaseItems = []) {
    // 只解析這次採購單真正會用到的品項；不要因來源訂單還有其他品項就全部查 Product Master / 成本。
    // 已解析成本仍保留在本次登入快取，第二次開同品項不再重查。
    const resolved = await Promise.all((purchaseItems || []).map(async item => ({
        item,
        product: await findProductForPurchaseItem(item)
    })));
    const products = new Map();
    resolved.forEach(({ item, product }) => {
        if (!product) return;
        const id = product.productId || item.productId || stableProductId(product);
        if (id) products.set(id, product);
    });
    await Promise.all([...products.entries()].map(async ([id, item]) => {
        if (purchaseCostCache.has(id)) return;
        const cost = await loadVisibleProductCost(item);
        if (cost !== null && Number.isFinite(cost)) purchaseCostCache.set(id, cost);
    }));
    resolved.forEach(({item, product}) => {
        if (!product) return;
        const id = product.productId || item.productId || stableProductId(product);
        item.productId = id;
        const cost = purchaseCostCache.get(id);
        if (cost !== undefined && cost !== null && Number.isFinite(Number(cost))) item.unitPrice = Number(cost);
    });
}

function productMasterDocToPriceItem(doc) {
    const data = doc.data ? doc.data() : doc;
    const brand = resolveBrandName(data.brandName || data.brand || '');
    const priceListActive = isBrandPriceListActive(brand);
    return normalizeProductMasterItem({
        productId: data.productId || doc.id || '',
        brandId: data.brandId || '',
        brand,
        model: data.manufacturerPartNo || data.sku || '',
        sku: data.manufacturerPartNo || data.sku || '',
        nameCn: data.productName || data.nameCn || '',
        nameEn: data.nameEn || '',
        productLine: data.productLine || '',
        productType: data.productType || data.category || '',
        spec: data.specification || data.spec || '',
        unit: data.unit || data.uom || '',
        price: priceListActive ? (data.listPrice ?? data.price ?? 0) : 0,
        priceListActive,
        supplier: data.supplier || '',
        inventoryTracked: data.inventoryTracked === true,
        lotTracked: data.lotTracked === true,
        expiryTracked: data.expiryTracked === true,
        source: data.source || '',
        status: data.status || (data.active === false ? 'INACTIVE' : 'ACTIVE'),
        active: data.active !== false && data.status !== 'INACTIVE'
    });
}

const visibleProductCostCache = new Map();
const visibleProductCostPending = new Map();
let visibleProductCostGeneration = 0;
function invalidateVisibleProductCosts() { visibleProductCostGeneration++; visibleProductCostCache.clear(); visibleProductCostPending.clear(); }

async function loadVisibleProductCost(item) {
    const productId = item?.productId || stableProductId(item || {});
    if (!productId) return null;
    if (typeof isBrandPriceListActive === 'function' && !isBrandPriceListActive(item?.brandName || item?.brand || '')) return null;
    if (currentUserRole !== 'admin' && currentUserRole !== 'purchaser') return null;
    const cacheKey = `${currentUserRole || ''}||${productId}`;
    if (visibleProductCostCache.has(cacheKey)) return visibleProductCostCache.get(cacheKey);
    if (visibleProductCostPending.has(cacheKey)) return visibleProductCostPending.get(cacheKey);
    const generation = visibleProductCostGeneration;
    const request = (async () => {
    try {
        const doc = await firestoreReadWithTimeout(
            db.collection('productCosts').doc(productId).get(),
            '產品成本'
        );
        if (!doc.exists) {
            if (generation === visibleProductCostGeneration) visibleProductCostCache.set(cacheKey, null);
            return null;
        }
        const value = (doc.data() || {}).standardCost;
        const parsed = value === undefined || value === null || String(value).trim() === '' ? NaN : Number(value);
        const cost = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
        if (generation === visibleProductCostGeneration) visibleProductCostCache.set(cacheKey, cost);
        return cost;
    } catch (_) {
        return null;
    }
    })();
    visibleProductCostPending.set(cacheKey, request);
    try { return await request; }
    finally { if (visibleProductCostPending.get(cacheKey) === request) visibleProductCostPending.delete(cacheKey); }
}

function setOrderCostFieldForProduct(item) {
    const wrap = document.getElementById('orderCostFieldWrap');
    const input = document.getElementById('orderCostPrice');
    if (!wrap || !input) return;
    const selfOrder = document.getElementById('orderProcurementType')?.value === 'SALES_SELF_ORDER';
    const statusWrap=document.getElementById('orderSelfStatusWrap');if(statusWrap)statusWrap.hidden=!selfOrder;
    const supplierWrap=document.getElementById('orderSelfSupplierWrap');if(supplierWrap)supplierWrap.style.display=selfOrder?'':'none';
    const supplierInput=document.getElementById('orderSelfSupplier');if(supplierInput&&!supplierInput.value&&item?.supplier)supplierInput.value=item.supplier;
    const authorized = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    wrap.style.display = selfOrder || authorized ? '' : 'none';
    input.readOnly = !selfOrder;
    input.placeholder = selfOrder ? '尚未下訂可先留白，已下訂可填 0' : '選擇產品後帶入標準成本';
    const label = wrap.querySelector('label');
    if (label && label.firstChild) label.firstChild.textContent = selfOrder ? '含稅單位成本 ' : '含稅標準成本（參考） ';
    if (!selfOrder) input.value = '';
}
window.onOrderProcurementTypeChange = function() {
    const input = document.getElementById('orderCostPrice');
    if (input) { input.value = ''; delete input.dataset.autofillCost; }
    applyOrderProductCost(findPriceItemForOrder({itemCode:document.getElementById('orderItemCode')?.value || '',brand:getBrandFieldValue('orderBrand','orderBrandOther')}));
};
let orderCostRequestGeneration = 0;
async function applyOrderProductCost(item) {
    const generation = ++orderCostRequestGeneration;
    const openingGeneration = orderModalOpenGeneration;
    setOrderCostFieldForProduct(item);
    const input = document.getElementById('orderCostPrice');
    if (!input || !item) return;
    const selfOrder = document.getElementById('orderProcurementType')?.value === 'SALES_SELF_ORDER';
    const initialValue = input.value;
    // A manually entered transaction cost remains authoritative, including zero.
    if (selfOrder && initialValue !== '' && initialValue !== input.dataset.autofillCost) return;
    input.value = '';
    delete input.dataset.autofillCost;
    const cost = await loadVisibleProductCost(item);
    if (generation !== orderCostRequestGeneration || openingGeneration !== orderModalOpenGeneration || input.value !== '') return;
    if (cost !== null && Number.isFinite(cost) && cost >= 0) {
        input.value = String(cost);
        input.dataset.autofillCost = String(cost);
    }
}

function clearQuickProductButton(input) {
    input?.parentElement?.querySelector?.('.quick-product-inline')?.remove();
}

function clearProductMatchChoices(input) {
    input?.parentElement?.querySelector?.('.product-match-choices')?.remove();
}

function showQuickProductButton(input, mode) {
    if (!input || !input.parentElement) return;
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    const wrap = document.createElement('div');
    wrap.className = 'quick-product-inline';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:#6b7280;';
    const hint = document.createElement('span');
    hint.textContent = mode === 'quote' ? '未建檔（估價可直接繼續）' : '此貨號尚未建立產品';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-small btn-secondary quick-product-create-btn';
    button.textContent = mode === 'quote' ? '＋ 建立' : '＋ 快速建立';
    button.onclick = () => openQuickProductCreate(mode, input);
    wrap.append(hint, button);
    input.parentElement.appendChild(wrap);
}

function showProductMatchChoices(input, matches, mode) {
    if (!input || !input.parentElement || !Array.isArray(matches) || matches.length < 2) return;
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    const wrap = document.createElement('div');
    wrap.className = 'product-match-choices';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:#6b7280;';
    const hint = document.createElement('span');
    hint.textContent = '同一貨號有多個廠牌，請選擇：';
    wrap.appendChild(hint);
    matches.slice(0, 6).forEach(match => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-small btn-secondary';
        button.textContent = [resolveBrandName(match.brand || ''), match.nameCn || match.nameEn || match.model || '產品'].filter(Boolean).join('｜');
        button.onclick = async () => {
            clearProductMatchChoices(input);
            input.value = match.model || input.value;
            if (mode === 'quote') {
                input.dataset.autofillStatus = 'matched';
                applyQuoteProductMatch(input.closest('tr'), match);
            } else {
                await applyOrderProductMatch(input, match);
            }
        };
        wrap.appendChild(button);
    });
    input.parentElement.appendChild(wrap);
}

function ensureQuickProductModal() {
    let panel = document.getElementById('quickProductOverlay');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'quickProductOverlay';
    panel.className = 'quick-product-inline-panel no-print';
    panel.innerHTML = `
      <div class="quick-product-inline-head">
        <div>
          <strong>快速建立產品</strong>
          <span>不離開目前單據；填完後直接帶回原本貨號欄位。</span>
        </div>
        <button type="button" class="btn-small btn-secondary" onclick="closeQuickProductCreate()">收合</button>
      </div>
      <div class="quick-product-inline-grid">
        <label>廠牌<input id="quickProductBrand" type="text" list="quickProductBrandList" autocomplete="off"><datalist id="quickProductBrandList"></datalist></label>
        <label>貨號<input id="quickProductCode" type="text" autocomplete="off"></label>
        <label class="quick-product-span-2">中文品名<input id="quickProductName" type="text" autocomplete="off"></label>
        <label class="quick-product-span-2">英文品名<input id="quickProductNameEn" type="text" autocomplete="off"></label>
        <label>規格<input id="quickProductSpec" type="text" autocomplete="off"></label>
        <label>建議售價（選填）<input id="quickProductPrice" type="number" min="0"></label>
        <input id="quickProductLine" type="hidden">
      </div>
      <div class="quick-product-inline-actions">
        <button type="button" id="saveQuickProductBtn" onclick="saveQuickProduct()">儲存並帶入</button>
        <button type="button" class="btn-secondary" onclick="closeQuickProductCreate()">稍後再補</button>
      </div>`;
    panel.addEventListener('input', saveQuickProductDraft);
    panel.addEventListener('change', saveQuickProductDraft);
    return panel;
}

const QUICK_PRODUCT_FIELDS = ['Brand', 'Code', 'Name', 'NameEn', 'Spec', 'Line', 'Price'];
function quickProductDraftKey() {
    return currentUser?.uid ? `quick-product-draft:${currentUser.uid}` : '';
}
function saveQuickProductDraft() {
    const key = quickProductDraftKey();
    if (!key) return;
    const fields = Object.fromEntries(QUICK_PRODUCT_FIELDS.map(field => [field, document.getElementById(`quickProduct${field}`)?.value || '']));
    try { localStorage.setItem(key, JSON.stringify(fields)); }
    catch (err) { console.warn('無法暫存產品草稿：', err); }
}
function readQuickProductDraft() {
    try { return JSON.parse(localStorage.getItem(quickProductDraftKey()) || 'null'); }
    catch (_) { return null; }
}
function clearQuickProductDraft() {
    const key = quickProductDraftKey();
    if (key) localStorage.removeItem(key);
}



window.openQuickProductCreate = function(mode, input) {
    const panel = ensureQuickProductModal();
    if (panel.classList.contains('active') && quickProductTarget?.input !== input) saveQuickProductDraft();

    quickProductTarget = { mode, input, row: mode === 'quote' ? input.closest('tr') : null };
    const anchor = mode === 'quote' ? input.closest('.field-row') : input.parentElement;
    if (anchor?.parentElement) anchor.insertAdjacentElement('afterend', panel);

    const brandList = document.getElementById('quickProductBrandList');
    if (brandList) brandList.innerHTML = getUnifiedBrandNames(false).map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
    const currentBrand = mode === 'quote'
        ? quoteRowBrandValue(input.closest('tr'))
        : getBrandFieldValue('orderBrand', 'orderBrandOther');
    document.getElementById('quickProductBrand').value = currentBrand || '';
    document.getElementById('quickProductCode').value = input.value.trim();
    document.getElementById('quickProductName').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-cn')?.value || '')
        : (document.getElementById('orderItemName')?.value || '');
    document.getElementById('quickProductNameEn').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-en')?.value || '')
        : (document.getElementById('orderItemNameEn')?.value || '');
    document.getElementById('quickProductSpec').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-spec')?.value || '')
        : (document.getElementById('orderSpec')?.value || '');
    document.getElementById('quickProductLine').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-product-line')?.value || '')
        : (document.getElementById('orderProductLine')?.value || '');
    document.getElementById('quickProductPrice').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.inc-price')?.value || '')
        : (document.getElementById('orderUnitPrice')?.value || '');

    const draft = readQuickProductDraft();
    if (draft && normalizeItemCodeLoose(draft.Code) === normalizeItemCodeLoose(input.value.trim())
        && normalizeBrandLookupKey(resolveBrandName(draft.Brand)) === normalizeBrandLookupKey(resolveBrandName(currentBrand))) {
        QUICK_PRODUCT_FIELDS.forEach(field => {
            const node = document.getElementById(`quickProduct${field}`);
            if (node) node.value = draft[field] || '';
        });
    }
    panel.classList.add('active');
};

window.closeQuickProductCreate = function() {
    const panel = document.getElementById('quickProductOverlay');
    if (panel?.classList.contains('active')) saveQuickProductDraft();
    if (panel) panel.classList.remove('active');
    quickProductTarget = null;
};

window.saveQuickProduct = async function() {
    const brand = resolveBrandName(document.getElementById('quickProductBrand')?.value || '');
    const code = String(document.getElementById('quickProductCode')?.value || '').trim();
    const productName = String(document.getElementById('quickProductName')?.value || '').trim();
    const productNameEn = String(document.getElementById('quickProductNameEn')?.value || '').trim();
    const specification = String(document.getElementById('quickProductSpec')?.value || '').trim();
    const productLine = String(document.getElementById('quickProductLine')?.value || '').trim();
    const priceRaw = document.getElementById('quickProductPrice')?.value ?? '';
    if (!brand || !code || !productName) {
        alert('請填寫廠牌、貨號與品名。');
        return;
    }
    const brandEntry = brandMasterEntryForName(brand);

    const button = document.getElementById('saveQuickProductBtn');
    const actorUid=currentUser?.uid;
    const state = beginActionButton(button, '檢查中…');
    if (!state) return;
    try {
    const normalizedPartNo = normalizeItemCodeLoose(code);
    const duplicate = await findDuplicateProductMaster(brand,code);
    if(currentUser?.uid!==actorUid)throw new Error('登入身分已變更，請以原帳號確認產品建檔結果。');
    if (duplicate) {
        const existing = productMasterDocToPriceItem(duplicate);
        if(existing.status==='INACTIVE'||existing.active===false)throw new Error('此廠牌與貨號的產品已停用，請由主檔管理人員確認，不可重新新增或直接帶入。');
        alert('這個廠牌與貨號已存在，系統會直接使用現有產品。');
        syncSavedProductMaster(duplicate.id,duplicate.data());
        refreshPriceDatalists();
        productCodeMatchCache.delete(normalizedPartNo);
        if (quickProductTarget?.mode === 'quote') applyQuoteProductMatch(quickProductTarget.row, existing);
        if (quickProductTarget?.mode === 'order') {
            quickProductTarget.input.value = existing.model || code;
            orderProductCheckGeneration++;
            await applyOrderProductMatch(quickProductTarget.input, existing);
            checkNewOrderDraftProducts();
        }
        clearQuickProductButton(quickProductTarget?.input);
        closeQuickProductCreate();
        clearQuickProductDraft();
        return;
    }

    const productId = stableProductId({ brand, model: code });
    const now = new Date().toISOString();
    const productDoc = {
        productId,
        brandId: brandEntry?.id || '',
        brandName: brand,
        manufacturerPartNo: code,
        normalizedPartNo,
        productName,
        nameEn: productNameEn,
        specification,
        productLine,
        productLineId: productLine,
        category: '',
        productType: '',
        supplier: '',
        listPrice: Number(priceRaw) || 0,
        status: 'TEMPORARY',
        active: true,
        source: 'QUICK_CREATE',
        createdAt: now,
        createdBy: currentUser?.uid || '',
        updatedAt: now,
        updatedBy: currentUser?.uid || ''
    };
        if (button) button.textContent = '儲存中…';
        await db.runTransaction(async tx=>{
            const ref=db.collection('products').doc(productId);
            const prior=await tx.get(ref);
            if(currentUser?.uid!==actorUid)throw new Error('登入身分已變更。');
            if(prior.exists)throw new Error('其他人已建立這筆產品，請重新查詢貨號後使用既有主檔。');
            tx.set(ref,productDoc);
        });
        if(currentUser?.uid!==actorUid)return;
        const item = productMasterDocToPriceItem({ id: productId, data: () => productDoc });
        syncSavedProductMaster(productId,productDoc);
        refreshPriceDatalists();
        productCodeMatchCache.delete(normalizedPartNo);
        if (quickProductTarget?.mode === 'quote') applyQuoteProductMatch(quickProductTarget.row, item);
        if (quickProductTarget?.mode === 'order') {
            quickProductTarget.input.value = code;
            orderProductCheckGeneration++;
            await applyOrderProductMatch(quickProductTarget.input, item);
            checkNewOrderDraftProducts();
        }
        clearQuickProductButton(quickProductTarget?.input);
        closeQuickProductCreate();
        clearQuickProductDraft();
    } catch (err) {
        alert('快速新增產品失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        endActionButton(button, state);
    }
};

function rebuildPriceItemLookup() {
    priceItemLookup = new Map();
    const codeBuckets = new Map();
    priceList.forEach(item => {
        if (item.status === 'INACTIVE' || item.active === false) return;
        const code = normalizeItemCode(item.model);
        if (!code) return;
        const brand = normalizeBrandLookupKey(resolveBrandName(item.brand || ''));
        const bucket = codeBuckets.get(code) || [];
        bucket.push(item);
        codeBuckets.set(code, bucket);
        if (brand) {
            const key = `brand:${brand}:${code}`;
            // Never silently select the first of multiple active identities.
            priceItemLookup.set(key, priceItemLookup.has(key) ? null : item);
        }
    });
    codeBuckets.forEach((items, code) => {
        if (items.length === 1) priceItemLookup.set(`code:${code}`, items[0]);
    });
}

function findPriceItemForOrder(order = {}) {
    const savedProductId = String(order.productId || '').trim();
    if (savedProductId) {
        const byId = priceList.find(item =>
            String(item.productId || '') === savedProductId
            && item.status !== 'INACTIVE' && item.active !== false
        );
        if (byId) return byId;
    }
    const code = normalizeItemCode(order.itemCode);
    if (!code) return null;
    const orderBrand = normalizeBrandLookupKey(resolveBrandName(order.brand || ''));
    if (orderBrand) return priceItemLookup.get(`brand:${orderBrand}:${code}`) || null;
    return priceItemLookup.get(`code:${code}`) || null;
}

function productLineForOrder(order) {
    if ((order.brand || '').trim() === '維修') return '維修';
    // 銷售分析以 Product Master 為分類真實來源；業務不需要在訂單上判斷或維護產品線。
    const match = findPriceItemForOrder(order);
    const masterLine = (match?.productLine || '').trim();
    if (masterLine) return masterLine;
    // 只有 Product Master 暫時查不到時，才沿用訂單內既有的背景快照。
    const savedLine = (order.productLine || '').trim();
    return savedLine && savedLine !== '未分類' ? savedLine : '未分類';
}

function productTypeForOrder(order) {
    const match = findPriceItemForOrder(order);
    const masterType = (match?.productType || '').trim();
    if (masterType) return masterType;
    const savedType = (order.productType || '').trim();
    return savedType && savedType !== '未分類' ? savedType : '未分類';
}

function statisticBrandForOrder(order) {
    const identity = brandIdentityForRecord(order);
    const brand = identity.brand;
    return statisticBrandAliasLookup().get(normalizeStatisticBrandKey(brand)) || '其他廠牌';
}

function salesStatisticOrderLines(order) {
    const items = normalizedOrderItems(order);
    if (items.length <= 1) return [order];
    return items.map(item => ({
        ...order,
        items: [item], orderSchemaVersion: 2,
        itemId: item.itemId, itemCode: item.itemCode || '', itemName: item.itemName || '',
        productId: item.productId || order.productId || '',
        brand: item.brand || '', productLine: item.productLine || '', productType: item.productType || '',
        procurementType: item.procurementType || order.procurementType || 'PURCHASING_PO',
        qty: Number(item.qty || 0), unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.totalPrice || 0), costPrice: item.costPrice, costSource: item.costSource || order.costSource || '',
        deliveryRecords: savedDeliveryRecords(order).filter(row => row.itemId === item.itemId),
        returnRecords: savedReturnRecords(order).filter(row => row.itemId === item.itemId),
        isDelivered: !!order.isDelivered && savedDeliveryRecords(order).length === 0
    }));
}

function newSalesStatsMetric() {
    return { actualSales: 0, pendingSales: 0, totalSales: 0, actualCost: 0, pendingCost: 0, totalCost: 0, profit: 0, missingCostIds: new Set(), orderIds: new Set(), estimatedSales: 0, estimatedIds: new Set() };
}

function orderUnitSalesAmount(order) {
    const qty = orderQuantity(order);
    return qty ? salesAmount(order) / qty : (parseFloat(order.unitPrice) || 0);
}

function orderStatsProductId(order) {
    const saved = String(order?.productId || '').trim();
    if (saved) return saved;
    const match = findPriceItemForOrder(order || {});
    return String(match?.productId || '').trim();
}

function orderUnitCostForStats(order) {
    if ((order?.procurementType || 'PURCHASING_PO') === 'SALES_SELF_ORDER') {
        const manual = Number(order.costPrice);
        return Number.isFinite(manual) && manual >= 0 ? manual : null;
    }
    const productId = orderStatsProductId(order);
    const standardCost = productId ? Number(purchaseCostCache.get(productId)) : NaN;
    return Number.isFinite(standardCost) && standardCost >= 0 ? standardCost : null;
}

function orderHasCost(order) {
    return orderUnitCostForStats(order) !== null;
}

function dateInStatsRange(date, start, end) {
    return !!date && (!start || date >= start) && (!end || date <= end);
}

function calculateOrderStatsContribution(order, start, end) {
    const empty = { actualQty: 0, pendingQty: 0, actualSales: 0, pendingSales: 0, actualCost: 0, pendingCost: 0, estimatedSales: 0, estimated: false };
    const cancelled = normalizedOrderStatus(order) !== 'normal';
    const totalQty = orderQuantity(order);
    if (!totalQty) return empty;
    const unitSales = orderUnitSalesAmount(order);
    const resolvedUnitCost = orderUnitCostForStats(order);
    const unitCost = resolvedUnitCost === null ? 0 : resolvedUnitCost;
    const cutoff = end || localDateString();
    let actualQty = 0;
    let deliveredByCutoff = 0;
    let estimatedQty = 0;
    const deliveries = savedDeliveryRecords(order);
    if (deliveries.length) {
        deliveries.forEach(record => {
            const qty = parseFloat(record.qty) || 0;
            if (dateInStatsRange(record.date, start, end)) actualQty += qty;
            if (record.date && record.date <= cutoff) deliveredByCutoff += qty;
        });
    } else if (order.isDelivered) {
        // 舊版只留下已送貨布林值，以訂單日期當作推估送貨日。
        const legacyDate = order.orderDate || '';
        if (dateInStatsRange(legacyDate, start, end)) { actualQty += totalQty; estimatedQty += totalQty; }
        if (legacyDate && legacyDate <= cutoff) deliveredByCutoff += totalQty;
    }
    let returnedByCutoff = 0;
    savedReturnRecords(order).forEach(record => {
        const qty = parseFloat(record.qty) || 0;
        if (dateInStatsRange(record.date, start, end)) actualQty -= qty;
        if (record.date && record.date <= cutoff) returnedByCutoff += qty;
    });
    const orderExistsByCutoff = !order.orderDate || order.orderDate <= cutoff;
    const effectiveDelivered = Math.max(0, deliveredByCutoff - returnedByCutoff);
    // 取消／作廢只終止尚未履約的餘額；取消前已實際送貨、退貨仍屬正式歷史。
    const settledReturnQty=savedReturnRecords(order).filter(r=>r.settlement==='CLOSE'&&r.date&&r.date<=cutoff).reduce((sum,r)=>sum+Number(r.qty||0),0);
    const pendingQty = !cancelled && orderExistsByCutoff ? Math.max(0, totalQty - Math.min(totalQty, effectiveDelivered + settledReturnQty)) : 0;
    return {
        actualQty, pendingQty,
        actualSales: actualQty * unitSales,
        pendingSales: pendingQty * unitSales,
        actualCost: actualQty * unitCost,
        pendingCost: pendingQty * unitCost,
        estimatedSales: estimatedQty * unitSales,
        estimated: estimatedQty !== 0
    };
}

function addSalesStatsContribution(metric, order, contribution) {
    metric.actualSales += contribution.actualSales;
    metric.pendingSales += contribution.pendingSales;
    metric.actualCost += contribution.actualCost;
    metric.pendingCost += contribution.pendingCost;
    metric.totalSales = metric.actualSales + metric.pendingSales;
    metric.totalCost = metric.actualCost + metric.pendingCost;
    metric.profit = metric.totalSales - metric.totalCost;
    if (contribution.actualSales || contribution.pendingSales) metric.orderIds.add(order.id);
    if (!orderHasCost(order) && (contribution.actualQty || contribution.pendingQty)) {
        metric.missingCostIds.add(`${order.id}:${orderStatsProductId(order) || order.itemId || 'unknown'}`);
    }
    if (contribution.estimated) {
        metric.estimatedSales += contribution.estimatedSales;
        metric.estimatedIds.add(order.id);
    }
}

function formatStatsMoney(value) {
    const rounded = Math.round(value);
    return `${rounded < 0 ? '-NT$ ' : 'NT$ '}${Math.abs(rounded).toLocaleString()}`;
}

function renderSalesStatsRows(tbodyId, values, grandTotal) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const entries = Object.entries(values).sort((a, b) => b[1].totalSales - a[1].totalSales);
    tbody.innerHTML = entries.length
        ? entries.map(([name, metric]) => {
            const incompleteCost = metric.missingCostIds.size > 0;
            const rate = incompleteCost ? '待補成本' : metric.totalSales ? (metric.profit / metric.totalSales * 100).toFixed(1) + '%' : '－';
            const share = grandTotal ? (metric.totalSales / grandTotal * 100).toFixed(1) + '%' : '－';
            const costText = `${formatStatsMoney(metric.totalCost)}${incompleteCost ? `（少 ${metric.missingCostIds.size} 筆）` : ''}`;
            return `<tr><td>${escapeHtml(name)}</td><td>${formatStatsMoney(metric.actualSales)}</td><td>${formatStatsMoney(metric.pendingSales)}</td><td>${formatStatsMoney(metric.totalSales)}</td><td>${costText}</td><td>${incompleteCost ? '待補成本' : formatStatsMoney(metric.profit)}</td><td>${rate}</td><td>${share}</td></tr>`;
        }).join('')
        : '<tr><td colspan="8" style="color:#888;">尚無資料</td></tr>';
}

let tradeAnalysisLoadedKey = '';
const tradeAnalysisSnapshots = new Map();
let tradeAnalysisRevision = 0;
let tradeAnalysisAppliedFilters = null;
let tradeAnalysisSimpleRows = [];
let tradeAnalysisSimplePage = 0;
let tradeAnalysisFiltersPending = false;
let tradeAnalysisReady = false;
let tradeAnalysisReport = null;
let tradeAnalysisDetailKind = '';
let tradeAnalysisDetailReport = null;
let tradeAnalysisSourceOrders = new Map();
let tradeAnalysisTab = 'purchasing';
let tradeAnalysisSensitiveVisible = true;
let tradeAnalysisWarehouseStocks = [];
const TRADE_ANALYSIS_LABELS = {incoming:'待到貨採購',purchases:'已進貨（收貨）',pending:'待送貨訂單',sales:'已銷貨（送貨）',stock:'目前庫存'};

function setTradeAnalysisLoading(loading) {
    const query=document.getElementById('tradeAnalysisQueryBtn');
    if(query){query.disabled=loading;query.textContent=loading?'查詢中…':'查詢';}
    ['tradeAnalysisToggleBtn','tradeAnalysisWorkbookBtn'].forEach(id=>{
        const button=document.getElementById(id);if(button)button.disabled=loading||!tradeAnalysisReady||tradeAnalysisFiltersPending;
    });
    if(loading){
        closeTradeAnalysisDetail();
        resetSimpleTradeAnalysisDetail();
        document.querySelectorAll('.trade-analysis-cards strong').forEach(el=>el.textContent='讀取中…');
        document.getElementById('tradeAnalysisStatus').textContent='正在讀取此分頁所需資料…';
    }
}
window.markTradeAnalysisFiltersPending = function() {
    tradeAnalysisFiltersPending=true;
    setTradeAnalysisLoading(!!salesStatisticsLoadPromise);
    document.getElementById('tradeAnalysisStatus').textContent='篩選條件已變更，請按「查詢」；下方仍為上次查詢結果。';
};
function resetSimpleTradeAnalysisDetail() {
    tradeAnalysisSimplePage=0;
    const panel=document.getElementById('tradeAnalysisSimpleDetail');if(panel)panel.hidden=true;
    const button=document.getElementById('tradeAnalysisToggleBtn');
    if(button){button.textContent='查看明細';button.setAttribute('aria-expanded','false');}
    const body=document.getElementById('unifiedBrandAnalyticsBody');if(body)body.innerHTML='';
}
window.toggleSimpleTradeAnalysisDetail = function() {
    if(!tradeAnalysisReady||salesStatisticsLoadPromise||tradeAnalysisFiltersPending)return;
    const panel=document.getElementById('tradeAnalysisSimpleDetail');panel.hidden=!panel.hidden;
    document.getElementById('tradeAnalysisToggleBtn').textContent=panel.hidden?'查看明細':'收合明細';
    document.getElementById('tradeAnalysisToggleBtn').setAttribute('aria-expanded',String(!panel.hidden));
    if(!panel.hidden)renderSimpleTradeAnalysisPage();
};
window.changeSimpleTradeAnalysisPage = function(delta) {
    if(!tradeAnalysisReady||salesStatisticsLoadPromise||tradeAnalysisFiltersPending)return;
    const last=Math.max(0,Math.ceil(tradeAnalysisSimpleRows.length/50)-1);
    tradeAnalysisSimplePage=Math.max(0,Math.min(last,tradeAnalysisSimplePage+delta));
    renderSimpleTradeAnalysisPage();
};
function renderSimpleTradeAnalysisPage() {
    const quantity=tradeAnalysisTab==='inventory';
    const cols=quantity?['現有數量','已預留數量','可用數量']:simpleTradeAnalysisLabels().filter(label=>label!=='毛利率');
    document.getElementById('tradeAnalysisTableHead').innerHTML='<tr>'+['廠牌','貨號','品名',...cols].map(label=>`<th>${escapeHtml(label)}</th>`).join('')+'</tr>';
    const rows=tradeAnalysisSimpleRows.slice(tradeAnalysisSimplePage*50,(tradeAnalysisSimplePage+1)*50);
    document.getElementById('unifiedBrandAnalyticsBody').innerHTML=rows.map(row=>`<tr><td>${escapeHtml(row.brand)}</td><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td>${(quantity?row.quantities:row.values).slice(0,cols.length).map(value=>`<td>${value===null?'待補成本':quantity?value:formatStatsMoney(value)}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${cols.length+3}">沒有符合條件的資料。</td></tr>`;
    const pages=Math.max(1,Math.ceil(tradeAnalysisSimpleRows.length/50));
    document.getElementById('tradeAnalysisPageStatus').textContent=`第 ${tradeAnalysisSimplePage+1} / ${pages} 頁，共 ${tradeAnalysisSimpleRows.length} 筆`;
    document.getElementById('tradeAnalysisPrevBtn').disabled=tradeAnalysisSimplePage===0;
    document.getElementById('tradeAnalysisNextBtn').disabled=tradeAnalysisSimplePage>=pages-1;
}
function simpleTradeAnalysisLabels() {
    return tradeAnalysisTab==='purchasing'?['採購金額','實際到貨金額','未到貨金額']:tradeAnalysisTab==='selling'
        ? ['銷售金額','實際出貨金額','未出貨金額',...(tradeAnalysisSensitiveVisible?['毛利','毛利率']:[])]
        : ['現有庫存金額','已預留庫存金額','可用庫存金額'];
}

window.toggleTradeAnalysisSensitive = function() {
    if(currentUserRole!=='admin')return;
    tradeAnalysisSensitiveVisible=!tradeAnalysisSensitiveVisible;
    const button=document.getElementById('tradeAnalysisSensitiveBtn');
    if(button){button.textContent=tradeAnalysisSensitiveVisible?'隱藏毛利':'顯示毛利';button.setAttribute('aria-pressed',String(!tradeAnalysisSensitiveVisible));}
    renderSalesStatistics();
};

function tradeAnalysisCost(value) {
    if(value===null||value===undefined||value==='')return null;
    const n=Number(value);
    return Number.isFinite(n)&&n>=0?n:null;
}

function buildTradeAnalysisRows() {
    const rows=[];
    const supplies=new Map(inventoryAnalysisSupplyOrders.map(row=>[row.id,row]));
    const metadata=(record={})=>{
        const product=findPriceItemForOrder(record);
        return {
            brand:statisticBrandForOrder(record),rawBrand:brandIdentityForRecord(record).brand,
            line:productLineForOrder(record),type:productTypeForOrder(record),
            code:record.itemCode||product?.model||'',name:record.itemName||product?.nameCn||product?.nameEn||'',
            productId:record.productId||product?.productId||''
        };
    };
    const push=(kind,record,qty,unitPrice,extra={})=>{
        rows.push({...metadata(record),kind,qty,unitPrice,amount:unitPrice===null?null:qty*unitPrice,...extra});
    };
    salesStatisticsOrders.flatMap(salesStatisticOrderLines).forEach(order=>{
        const common={customer:order.customerName||'',supplier:'',documentNo:order.orderNo||order.quoteNo||order.id,orderId:order.id,
            sales:stripPhoneSuffix(order.salesName)||'未指定負責業務',sourceId:order.id,itemId:order.itemId||''};
        const unit=orderUnitSalesAmount(order);
        const deliveries = savedDeliveryRecords(order);
        deliveries.forEach(record=>push('sales',order,Number(record.qty||0),unit,{...common,date:record.date,event:'送貨',eventId:record.id||'',status:'已送貨'}));
        if (!deliveries.length && order.isDelivered) {
            push('sales',order,orderQuantity(order),unit,{...common,date:order.orderDate || '',event:'舊資料推估送貨',eventId:'legacy-delivery',status:'已送貨（日期推估）',estimated:true});
        }
        savedReturnRecords(order).forEach(record=>push('sales',order,-Number(record.qty||0),unit,{...common,date:record.date,event:'退貨',eventId:record.id||'',status:'已退貨'}));
        const contribution=calculateOrderStatsContribution(order,'',localDateString());
        if(contribution.pendingQty>0)push('pending',order,contribution.pendingQty,unit,{...common,date:order.orderDate||'',event:'未送貨餘額',status:'待送貨'});
    });
    const supplyContext=(supply={})=>{
        const order=tradeAnalysisSourceOrders.get(supply.orderId)||salesStatisticsOrders.find(row=>row.id===supply.orderId);
        const line=order&&salesStatisticOrderLines(order).find(row=>row.itemId===supply.itemId||row.productId===supply.productId);
        return {record:{...line,...supply,productLine:supply.productLine||line?.productLine||'',productType:supply.productType||line?.productType||''},
            extra:{customer:order?.customerName||'',supplier:supply.supplier||'',documentNo:supply.purchaseDocumentNo||supply.internalNo||supply.id||'',
                orderId:supply.orderId||'',customerOrderNo:order?.orderNo||order?.quoteNo||supply.orderId||'',sales:stripPhoneSuffix(order?.salesName||supply.salesName)||'',sourceId:supply.id||'',
                fulfillment:supply.fulfillmentType==='DIRECT_SHIP'?'原廠直送':'倉庫到貨'}};
    };
    inventoryAnalysisSupplyOrders.forEach(supply=>{
        if(isPurchaseTerminalStatus(supply.status))return;
        const qty=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
        if(!qty)return;
        const context=supplyContext(supply);
        push('incoming',context.record,qty,tradeAnalysisCost(supply.unitCost),{...context.extra,date:supply.orderDate||'',expectedDate:supply.expectedDate||'',event:'未到貨餘額',status:'待到貨'});
    });
    inventoryAnalysisReceipts.forEach(receipt=>{
        const supply=supplies.get(receipt.supplyOrderId)||{};
        const context=supplyContext(supply);
        const lotCost=inventoryAnalysisLotCosts.get(receipt.lotId);
        const cost=receipt.fulfillmentType==='DIRECT_SHIP'?tradeAnalysisCost(supply.unitCost):tradeAnalysisCost(lotCost?.unitCost);
        push('purchases',{...context.record,...receipt,productId:receipt.productId||supply.productId||''},Number(receipt.qty||0),cost,{...context.extra,sourceId:receipt.supplyOrderId||'',date:receipt.receiptDate,event:'到貨',status:'已到貨',eventId:receipt.id,lotNo:receipt.lotNo||''});
    });
    inventoryAnalysisLots.forEach(lot=>{
        const supply=lot.sourceType==='SUPPLY_ORDER'?supplies.get(lot.sourceId)||{}:{};
        const context=supplyContext(supply);
        const lotCost=inventoryAnalysisLotCosts.get(lot.id);
        push('stock',{...context.record,...lot},Number(lot.remainingQty||0),tradeAnalysisCost(lotCost?.unitCost),{
            ...context.extra,date:localDateString(),event:'在庫',status:'在庫',lotNo:lot.lotNo||'',expiryDate:lot.expiryDate||'',warehouseId:lot.warehouseId||'',eventId:lot.id});
    });
    return rows;
}

function buildTradeAnalysisReport(rows = buildTradeAnalysisRows()) {
    const {start,end}=salesStatisticsQueryWindow();
    const filters={start,end,sales:document.getElementById('salesStatsSalesFilter')?.value||'',brand:document.getElementById('salesStatsBrandFilter')?.value||'',
        line:document.getElementById('salesStatsLineFilter')?.value||'',type:document.getElementById('salesStatsTypeFilter')?.value||''};
    return {...globalThis.YushinTradeAnalysis.summarize(rows,filters),filters};
}

function tradeAnalysisExportRows(report,kind) {
    return report.details[kind].map(row=>({
        '交易日期':row.date||'','類別':TRADE_ANALYSIS_LABELS[kind],'交易':row.event,'客戶':row.customer||'','供應商':row.supplier||'',
        '單號':row.documentNo||'','關聯客戶訂單':row.customerOrderNo||'','負責業務':row.sales||'','統計廠牌':row.brand,'實際廠牌':row.rawBrand,
        '產品線':row.line,'產品類型':row.type,'貨號':row.code,'品名':row.name,'數量':row.qty,
        '單價／成本':row.unitPrice===null?'待補成本':row.unitPrice,'金額':row.amount===null?'待補成本':row.amount,
        '狀態':row.status,'到貨方式':row.fulfillment||'','預計到貨日':row.expectedDate||'','倉庫':row.warehouseId||'',
        '批號':row.lotNo||'','效期':row.expiryDate||'','來源紀錄ID':row.sourceId||'','交易紀錄ID':row.eventId||''
    }));
}

window.openTradeAnalysisDetail = function(kind) {
    if(currentUserRole!=='admin'||!tradeAnalysisReady||salesStatisticsLoadPromise||!TRADE_ANALYSIS_LABELS[kind])return;
    tradeAnalysisDetailKind=kind;
    tradeAnalysisDetailReport=tradeAnalysisReport;
    const report=tradeAnalysisDetailReport;
    const detailRows=tradeAnalysisExportRows(report,kind);
    const columns=['交易日期','客戶','供應商','單號','業務','實際廠牌','產品線','產品類型','貨號','品名','數量','單價／成本','金額','交易'];
    document.getElementById('tradeAnalysisDetailTitle').textContent=TRADE_ANALYSIS_LABELS[kind]+'明細';
    document.getElementById('tradeAnalysisDetailSummary').textContent=`共 ${detailRows.length} 筆，合計 ${formatStatsMoney(report.totals[kind])}`+(report.missing[kind]?`；${report.missing[kind]} 筆待補成本，未計入金額`:'')+'。'+(['sales','purchases'].includes(kind)?`期間：${report.filters.start} 至 ${report.filters.end}`:'目前全部餘額');
    document.getElementById('tradeAnalysisDetailHead').innerHTML='<tr>'+columns.map(name=>`<th>${escapeHtml(name)}</th>`).join('')+'</tr>';
    const visible=detailRows.slice(0,100);
    document.getElementById('tradeAnalysisDetailBody').innerHTML=visible.length?visible.map(row=>'<tr>'+columns.map(name=>`<td>${escapeHtml(String(row[name]??''))}</td>`).join('')+'</tr>').join(''):`<tr><td colspan="${columns.length}">沒有符合條件的明細。</td></tr>`;
    if(detailRows.length>100)document.getElementById('tradeAnalysisDetailSummary').textContent+=' 畫面顯示前 100 筆；匯出包含全部明細。';
    document.getElementById('tradeAnalysisDetailOverlay').classList.add('active');
};
window.closeTradeAnalysisDetail = function() {
    document.getElementById('tradeAnalysisDetailOverlay')?.classList.remove('active');
};

async function writeTradeAnalysisWorkbook(report,kinds,button) {
    if(currentUserRole!=='admin'||!report||!kinds.length||kinds.some(kind=>!TRADE_ANALYSIS_LABELS[kind]))return;
    const state=beginActionButton(button,'匯出中…');
    if(button&&!state)return;
    try{
        await ensureXlsxLoaded();
        const wb=XLSX.utils.book_new();
        const filters=report.filters;
        const summary=[
            {'項目':'已完成交易期間','內容':`${filters.start} 至 ${filters.end}`},
            {'項目':'未完成及庫存','內容':'目前全部餘額'},
            ...[['業務',filters.sales||'全部負責業務'],['廠牌',filters.brand||'全部廠牌'],['產品線',filters.line||'全部產品線'],['產品類型',filters.type||'全部類型']].map(([name,value])=>({'項目':name,'內容':value})),
            {'項目':'金額口徑','內容':'銷售含稅；採購及庫存依紀錄單位成本；不混合加總不同單位數量。'},
            {'項目':'負責業務篩選範圍','內容':'只篩銷貨與待送貨；進貨、待到貨、庫存為公司共同數字。'},
            ...kinds.map(kind=>({'項目':TRADE_ANALYSIS_LABELS[kind],'內容':report.totals[kind],'明細筆數':report.details[kind].length,'待補成本筆數':report.missing[kind]}))
        ];
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summary),'篩選與總計');
        kinds.forEach(kind=>{
            const rows=tradeAnalysisExportRows(report,kind);
            rows.push({'交易':'總計','金額':report.totals[kind],'狀態':report.missing[kind]?`有 ${report.missing[kind]} 筆待補成本`:'完整'});
            const sheet=XLSX.utils.json_to_sheet(rows);
            sheet['!cols']=Object.keys(rows[0]).map(name=>({wch:['品名','客戶','供應商'].includes(name)?28:18}));
            XLSX.utils.book_append_sheet(wb,sheet,TRADE_ANALYSIS_LABELS[kind]);
        });
        XLSX.writeFile(wb,`進銷存-${kinds.length===1?TRADE_ANALYSIS_LABELS[kinds[0]]:'全部明細'}-${filters.start}-${filters.end}.xlsx`);
    }catch(err){alert('匯出失敗：'+(err.message||err));}
    finally{if(button)endActionButton(button,state);}
}
window.exportTradeAnalysisDetail = function() {
    return writeTradeAnalysisWorkbook(tradeAnalysisDetailReport,[tradeAnalysisDetailKind],document.getElementById('tradeAnalysisExport'));
};
window.exportTradeAnalysis = async function() {
    if(currentUserRole!=='admin'||!tradeAnalysisReady||salesStatisticsLoadPromise||tradeAnalysisFiltersPending)return;
    const button=document.getElementById('tradeAnalysisWorkbookBtn');
    const state=beginActionButton(button,'匯出中…');if(!state)return;
    try {
        const filters={...tradeAnalysisAppliedFilters},tab=tradeAnalysisTab;
        const rows=buildSimpleTradeAnalysis(filters);
        const labels=simpleTradeAnalysisLabels().filter(label=>label!=='毛利率');
        const data=rows.map(r=>({'單號':r.documentNo,'廠牌':r.brand,'貨號':r.code,'品名':r.name,'產品線':r.line,'產品類型':r.type,'倉庫':r.warehouse,...Object.fromEntries(labels.map((l,i)=>[l,r.values[i]===null?'待補成本':r.values[i]])),...(r.quantities?{'現有數量':r.quantities[0],'已預留數量':r.quantities[1],'可用數量':r.quantities[2]}:{})}));
        const totals=labels.map((_,i)=>rows.reduce((n,r)=>n+(r.values[i]??0),0));
        const missing=rows.some(r=>r.values.some(v=>v===null));
        data.push({'品名':'總計',...Object.fromEntries(labels.map((l,i)=>[l,i===3&&missing?'待補成本':totals[i]]))});
        const {start,end}=filters;
        const scope=[{'項目':'期間','內容':tradeAnalysisTab==='inventory'?'目前庫存':`${start} 至 ${end} 成立的單據，目前履約進度`},{'項目':'廠牌','內容':filters.brand||'全部'},{'項目':'產品線','內容':filters.line||'全部'},{'項目':'產品類型','內容':filters.type||'全部'},{'項目':'業務','內容':tradeAnalysisTab==='selling'?(filters.sales||'全部'):'公司共同數字'},{'項目':'估值說明','內容':document.getElementById('tradeAnalysisScope').textContent},{'項目':'資料完整性','內容':missing?'缺少成本的金額未計入；毛利待補成本':'完整'}];
        if(tradeAnalysisTab==='selling'&&labels.includes('毛利'))scope.push({'項目':'毛利率','內容':missing?'待補成本':totals[1]?totals[3]/totals[1]:0});
        await ensureXlsxLoaded();
        if(currentUserRole!=='admin'||(tab==='selling'&&labels.includes('毛利')&&!tradeAnalysisSensitiveVisible))
            throw new Error('登入身份或毛利顯示設定已變更，請確認後重新匯出。');
        const wb=XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(scope),'篩選與總計');
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(data),'品項明細');
        XLSX.writeFile(wb,`進銷存分析_${tab}_${localDateString()}.xlsx`);
    }catch(err){alert('匯出失敗：'+(err.message||err));}finally{endActionButton(button,state);}
};

function populateSalesStatisticsFilters(rows = buildTradeAnalysisRows()) {
    const brand = document.getElementById('salesStatsBrandFilter')?.value || '';
    const classified = rows.filter(row=>!brand||row.brand===brand);
    const selects = [
        { id: 'salesStatsSalesFilter', label: '全部負責業務', values: rows.filter(row=>['sales','pending'].includes(row.kind)).map(row=>row.sales) },
        { id: 'salesStatsBrandFilter', label: '全部廠牌', values: [...getPrimaryBrandNames(), OTHER_BRAND_OPTION_KEY] },
        { id: 'salesStatsTypeFilter', label: '全部產品類型', values: classified.map(row=>row.type) },
        { id: 'salesStatsLineFilter', label: '全部產品線', values: classified.map(row=>row.line) }
    ];
    selects.forEach(({id,label,values})=>{
        const select=document.getElementById(id);
        if(!select)return;
        const selected=select.value;
        const options=[...new Set([...values,selected].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-Hant'));
        select.innerHTML=`<option value="">${label}</option>`+options.map(value=>`<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join('');
        if(options.includes(selected))select.value=selected;
    });
}

window.renderAdminStatistics = function() {
    if(currentUserRole!=='admin')return;
    tradeAnalysisAppliedFilters=readTradeAnalysisFilters();
    tradeAnalysisFiltersPending=false;
    resetSimpleTradeAnalysisDetail();
    return loadSalesStatistics();
};

window.setSalesStatisticsPeriod = function(period) {
    const now = new Date();
    const year = now.getFullYear();
    let start = '', end = '';
    if (period === 'month') {
        start = localDateString().slice(0,7)+'-01';
        end = localDateString();
    } else if (/^q[1-4]$/.test(period)) {
        const quarter = parseInt(period.slice(1), 10);
        const firstMonth = (quarter - 1) * 3 + 1;
        const lastDay = new Date(year, firstMonth + 2, 0).getDate();
        start = `${year}-${String(firstMonth).padStart(2, '0')}-01`;
        end = `${year}-${String(firstMonth + 2).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else if (period === 'ytd') {
        start = `${year}-01-01`;
        end = localDateString();
    } else if (period === 'custom') {
        return;
    }
    document.getElementById('salesStatsStart').value = start;
    document.getElementById('salesStatsEnd').value = end;
    markTradeAnalysisFiltersPending();
};

function buildSalesStatisticsReport() {
    const start = document.getElementById('salesStatsStart')?.value || '';
    const end = document.getElementById('salesStatsEnd')?.value || '';
    const salesFilter = document.getElementById('salesStatsSalesFilter')?.value || '';
    const brandFilter = document.getElementById('salesStatsBrandFilter')?.value || '';
    const typeFilter = document.getElementById('salesStatsTypeFilter')?.value || '';
    const lineFilter = document.getElementById('salesStatsLineFilter')?.value || '';
    const byBrand = {}, bySales = {}, byType = {}, byLine = {}, byTransaction = {};
    const total = newSalesStatsMetric();
    const details = [];

    salesStatisticsOrders.flatMap(salesStatisticOrderLines).forEach(order => {
        const sales = stripPhoneSuffix(order.salesName) || '未指定負責業務';
        const line = productLineForOrder(order);
        const type = productTypeForOrder(order);
        const brand = statisticBrandForOrder(order);
        const transaction = order.transactionType || '未選擇';
        if ((salesFilter && sales !== salesFilter) || (brandFilter && brand !== brandFilter) || (typeFilter && type !== typeFilter) || (lineFilter && line !== lineFilter)) return;
        const contribution = calculateOrderStatsContribution(order, start, end);
        if (!contribution.actualSales && !contribution.pendingSales && !contribution.actualQty && !contribution.pendingQty) return;
        addSalesStatsContribution(total, order, contribution);
        if (!byBrand[brand]) byBrand[brand] = newSalesStatsMetric();
        if (!bySales[sales]) bySales[sales] = newSalesStatsMetric();
        if (!byType[type]) byType[type] = newSalesStatsMetric();
        if (!byLine[line]) byLine[line] = newSalesStatsMetric();
        if (!byTransaction[transaction]) byTransaction[transaction] = newSalesStatsMetric();
        addSalesStatsContribution(byBrand[brand], order, contribution);
        addSalesStatsContribution(bySales[sales], order, contribution);
        addSalesStatsContribution(byType[type], order, contribution);
        addSalesStatsContribution(byLine[line], order, contribution);
        addSalesStatsContribution(byTransaction[transaction], order, contribution);
        details.push({ order, sales, brand, type, line, transaction, contribution });
    });

    return {
        start, end, salesFilter, brandFilter, typeFilter, lineFilter,
        total, byBrand, bySales, byType, byLine, byTransaction, details
    };
}

function renderUnifiedBrandAnalytics() {
    if(tradeAnalysisReady&&!salesStatisticsLoadPromise)renderSalesStatistics();
}

window.switchTradeAnalysisTab = function(tab) {
    if(!['purchasing','selling','inventory'].includes(tab))return;
    tradeAnalysisTab=tab;
    const sensitiveButton=document.getElementById('tradeAnalysisSensitiveBtn');if(sensitiveButton)sensitiveButton.hidden=tab!=='selling';
    document.getElementById('salesStatsSalesField').hidden=tab!=='selling';
    document.querySelectorAll('[data-analysis-period]').forEach(el=>el.hidden=tab==='inventory');
    document.querySelectorAll('[data-analysis-tab]').forEach(el=>{
        el.classList.toggle('active',el.dataset.analysisTab===tab);
        el.setAttribute('aria-selected',String(el.dataset.analysisTab===tab));
    });
    renderAdminStatistics();
};

function buildSimpleTradeAnalysis(filters = readTradeAnalysisFilters()) {
    const {start,end,brand,line,sales,type}=filters;
    const matches=row=>(!brand||statisticBrandForOrder(row)===brand)&&(!line||productLineForOrder(row)===line)&&(!type||productTypeForOrder(row)===type);
    const lotsByStock=new Map();
    inventoryAnalysisLots.forEach(l=>{const key=JSON.stringify([l.warehouseId,l.productKey||l.productId]);if(!lotsByStock.has(key))lotsByStock.set(key,[]);lotsByStock.get(key).push(l);});
    const rows=[];
    const add=(record,values)=>rows.push({documentNo:record.purchaseDocumentNo||record.orderNo||record.id||'',warehouse:record.warehouseId||'',code:record.itemCode||findPriceItemForOrder(record)?.model||record.productKey||'',name:record.itemName||findPriceItemForOrder(record)?.nameCn||'',brand:statisticBrandForOrder(record),line:productLineForOrder(record),type:productTypeForOrder(record),...values});
    if(tradeAnalysisTab==='purchasing')inventoryAnalysisSupplyOrders.forEach(row=>{
        const order=tradeAnalysisSourceOrders.get(row.orderId);
        const item=order?normalizedOrderItems(order).find(item=>String(item.itemId||'')===String(row.itemId||'')):null;
        row={...order,...item,...row};
        if(!matches(row)||!dateInStatsRange(row.orderDate,start,end)||!['ORDERED','PARTIAL_RECEIPT','RECEIVED','CLOSED','CANCELLED'].includes(row.status))return;
        const ordered=Math.max(0,Number(row.qty||0)),received=Math.min(ordered,Math.max(0,Number(row.receivedQty||0)));
        const qty=isPurchaseTerminalStatus(row.status)?received:ordered;
        const unit=tradeAnalysisCost(row.unitCost);
        add(row,{values:[unit===null?null:qty*unit,unit===null?null:received*unit,unit===null?null:(qty-received)*unit],zeroCost:unit===0 && qty>0});
    });
    if(tradeAnalysisTab==='selling')salesStatisticsOrders.flatMap(salesStatisticOrderLines).forEach(row=>{
        if(!matches(row)||!dateInStatsRange(row.orderDate,start,end)||(sales&&stripPhoneSuffix(row.salesName)!==sales))return;
        const c=calculateOrderStatsContribution(row,'',localDateString());
        if(normalizedOrderStatus(row)!=='normal'&&!c.actualQty)return;
        const unit=orderUnitSalesAmount(row),actual=c.actualQty*unit,pending=c.pendingQty*unit;
        let cost=0,known=true,zeroCost=false;
        const records=[...savedDeliveryRecords(row).map(r=>({...r,sign:1})),...savedReturnRecords(row).map(r=>({...r,sign:-1}))];
        records.forEach(r=>{
            const allocations=r.lotAllocations||[];
            if(!allocations.length){
                const supplies=inventoryAnalysisSupplyOrders.filter(s=>s.orderId===row.id&&s.itemId===row.itemId&&s.fulfillmentType==='DIRECT_SHIP'&&s.status!=='CANCELLED');
                const costs=supplies.map(s=>tradeAnalysisCost(s.unitCost));
                if(supplies.length===1&&costs[0]!==null){cost+=r.sign*Number(r.qty||0)*costs[0];if(costs[0]===0&&Number(r.qty||0)>0)zeroCost=true;}else known=false;
                return;
            }
            if(Math.abs(allocations.reduce((n,a)=>n+Number(a.qty||0),0)-Number(r.qty||0))>0.000001)known=false;
            allocations.forEach(a=>{const u=tradeAnalysisCost(inventoryAnalysisLotCosts.get(a.lotId)?.unitCost);if(u===null)known=false;else {cost+=r.sign*Number(a.qty||0)*u;if(u===0&&Number(a.qty||0)>0)zeroCost=true;}});
        });
        if(row.isDelivered&&!savedDeliveryRecords(row).length)known=false;
        add(row,{values:[actual+pending,actual,pending,known?actual-cost:null],actual,zeroCost});
    });
    if(tradeAnalysisTab==='inventory')tradeAnalysisWarehouseStocks.forEach(stock=>{
        const lots=lotsByStock.get(JSON.stringify([stock.warehouseId,stock.productKey||stock.productId]))||[];
        const record={...lots[0],...stock,productId:stock.productId||lots[0]?.productId||stock.productKey};if(!matches(record))return;
        const onHand=Number(stock.onHand||0),reserved=Number(stock.reserved||0);
        let value=0,known=lots.length>0,zeroCost=false;
        lots.forEach(l=>{const cost=tradeAnalysisCost(inventoryAnalysisLotCosts.get(l.id)?.unitCost);if(cost===null)known=false;else {value+=Number(l.remainingQty||0)*cost;if(cost===0&&Number(l.remainingQty||0)>0)zeroCost=true;}});
        if(Math.abs(lots.reduce((n,l)=>n+Number(l.remainingQty||0),0)-onHand)>0.000001)known=false;
        const unit=known&&onHand?value/onHand:null;
        add(record,{values:[unit===null?null:value,unit===null?null:reserved*unit,unit===null?null:(onHand-reserved)*unit],quantities:[onHand,reserved,onHand-reserved],zeroCost});
    });
    return rows;
}

window.renderSalesStatistics = function() {
    if(currentUserRole!=='admin'||!tradeAnalysisReady)return;
    const stockMetadata=new Map(inventoryAnalysisLots.map(lot=>[JSON.stringify([lot.warehouseId,lot.productKey||lot.productId]),lot]));
    const records=tradeAnalysisTab==='selling'?salesStatisticsOrders.flatMap(salesStatisticOrderLines):tradeAnalysisTab==='purchasing'
        ?inventoryAnalysisSupplyOrders.map(row=>{
            const order=tradeAnalysisSourceOrders.get(row.orderId);
            const item=order?normalizedOrderItems(order).find(item=>String(item.itemId||'')===String(row.itemId||'')):null;
            return {...order,...item,...row};
        }):tradeAnalysisWarehouseStocks.map(row=>({...stockMetadata.get(JSON.stringify([row.warehouseId,row.productKey||row.productId])),...row}));
    populateSalesStatisticsFilters(records.map(row=>({kind:tradeAnalysisTab==='selling'?'sales':'stock',brand:statisticBrandForOrder(row),
        sales:stripPhoneSuffix(row.salesName),line:productLineForOrder(row),type:productTypeForOrder(row)})));
    const rows=buildSimpleTradeAnalysis(tradeAnalysisAppliedFilters);
    tradeAnalysisSimpleRows=rows;
    resetSimpleTradeAnalysisDetail();
    const labels=simpleTradeAnalysisLabels();
    const totals=labels.map((_,i)=>rows.reduce((n,row)=>n+(row.values[i]??0),0));
    const missing=rows.filter(row=>row.values.some(value=>value===null)).length;
    document.getElementById('tradeAnalysisCards').innerHTML=labels.map((label,i)=>{
        const text=i===4?(missing?'待補成本':totals[1]?((totals[3]/totals[1])*100).toFixed(1)+'%':'－'):(i===3&&missing?'待補成本':formatStatsMoney(totals[i]));
        return `<div class="sales-stat-card"><span>${label}</span><strong>${escapeHtml(text)}</strong></div>`;
    }).join('');
    document.getElementById('tradeAnalysisScope').textContent=tradeAnalysisTab==='inventory'?'目前分倉數量；預留金額以同品項同倉批次加權平均成本估值。':'依所選期間成立日期篩選，顯示目前累計到貨／出貨進度。取消／結案未履約餘額不計入總額；退貨扣回實際出貨。銷售沿用含稅金額，毛利以可確認的實際批次／直送採購成本計算。';
    const filters=tradeAnalysisAppliedFilters;
    const scope=tradeAnalysisTab==='inventory'?'目前庫存':`${filters.start} 至 ${filters.end} 成立的單據`;
    document.getElementById('tradeAnalysisStatus').textContent=scope+`｜共 ${rows.length} 筆`+(missing?`；${missing} 筆缺少成本或批次數量不一致，金額僅加總可確認成本。${tradeAnalysisTab==='selling'?'毛利與毛利率待補成本後顯示。':''}`:'')+(rows.some(row=>row.zeroCost)?`；${rows.filter(row=>row.zeroCost).length} 筆採用零成本，請確認是否為贈品或尚待補登。`:'');
    if(tradeAnalysisFiltersPending)markTradeAnalysisFiltersPending();
};

function salesStatsMetricExportRows(values, grandTotal, label) {
    return Object.entries(values)
        .sort((a, b) => b[1].totalSales - a[1].totalSales)
        .map(([name, metric]) => ({
            [label]: name,
            '實際送貨金額': Math.round(metric.actualSales),
            '待出貨金額': Math.round(metric.pendingSales),
            '總金額': Math.round(metric.totalSales),
            '總成本': Math.round(metric.totalCost),
            '毛利': metric.missingCostIds.size ? '待補成本' : Math.round(metric.profit),
            '毛利率': metric.missingCostIds.size ? '待補成本' : metric.totalSales ? (metric.profit / metric.totalSales * 100).toFixed(1) + '%' : '－',
            '占比': grandTotal ? (metric.totalSales / grandTotal * 100).toFixed(1) + '%' : '－',
            '成本未填筆數': metric.missingCostIds.size,
            '歷史推估金額': Math.round(metric.estimatedSales)
        }));
}

window.exportSalesStatisticsExcel = async function() {
    populateSalesStatisticsFilters();
    const report = buildSalesStatisticsReport();
    if (!report.start || !report.end) {
        alert('請先選擇統計起訖日期。');
        return;
    }
    if (!report.details.length) {
        alert('目前的日期與篩選條件沒有可匯出的季報資料。');
        return;
    }
    try {
        await ensureXlsxLoaded();
        const { total } = report;
        const summaryRows = [
            { '項目': '統計期間', '內容': `${report.start} 至 ${report.end}` },
            { '項目': '負責業務篩選', '內容': report.salesFilter || '全部負責業務' },
            { '項目': '廠牌篩選', '內容': report.brandFilter || '全部廠牌' },
            { '項目': '類型篩選', '內容': report.typeFilter || '全部類型' },
            { '項目': '產品線篩選', '內容': report.lineFilter || '全部產品線' },
            { '項目': '有效訂單筆數', '內容': total.orderIds.size },
            { '項目': '實際送貨金額', '內容': Math.round(total.actualSales) },
            { '項目': '待出貨金額', '內容': Math.round(total.pendingSales) },
            { '項目': '總金額', '內容': Math.round(total.totalSales) },
            { '項目': '總成本', '內容': Math.round(total.totalCost) },
            { '項目': '毛利', '內容': total.missingCostIds.size ? '待補成本' : Math.round(total.profit) },
            { '項目': '毛利率', '內容': total.missingCostIds.size ? '待補成本' : total.totalSales ? (total.profit / total.totalSales * 100).toFixed(1) + '%' : '－' },
            { '項目': '成本未填筆數', '內容': total.missingCostIds.size },
            { '項目': '歷史推估金額', '內容': Math.round(total.estimatedSales) },
            { '項目': '歷史推估筆數', '內容': total.estimatedIds.size }
        ];
        const detailRows = report.details
            .sort((a, b) => (a.order.orderDate || '').localeCompare(b.order.orderDate || ''))
            .map(({ order, sales, brand, type, line, transaction, contribution }) => {
                const hasCost = orderHasCost(order);
                const totalSales = contribution.actualSales + contribution.pendingSales;
                const totalCost = contribution.actualCost + contribution.pendingCost;
                return {
                    '訂單日期': order.orderDate || '',
                    '來源估價單': order.quoteNo || '',
                    '採購單號': order.purchaseOrderNo || '',
                    '客戶名稱': order.customerName || '',
                    '負責業務': sales,
                    '統計廠牌': brand,
                    '原始廠牌': order.brand || '',
                    '產品類型': type,
                    '產品線': line,
                    '貨號': order.itemCode || '',
                    '品名': order.itemName || '',
                    '交易方式': transaction,
                    '訂單數量': orderQuantity(order),
                    '期間實際送貨數量': contribution.actualQty,
                    '截至迄日待出貨數量': contribution.pendingQty,
                    '實際送貨金額': Math.round(contribution.actualSales),
                    '待出貨金額': Math.round(contribution.pendingSales),
                    '總金額': Math.round(totalSales),
                    '總成本': Math.round(totalCost),
                    '毛利': hasCost ? Math.round(totalSales - totalCost) : '待補成本',
                    '毛利率': hasCost && totalSales ? ((totalSales - totalCost) / totalSales * 100).toFixed(1) + '%' : hasCost ? '－' : '待補成本',
                    '成本狀態': hasCost ? '已填' : '未填',
                    '資料註記': contribution.estimated ? '歷史推估資料' : ''
                };
            });
        const workbook = XLSX.utils.book_new();
        const appendSheet = (rows, name, widths) => {
            const sheet = XLSX.utils.json_to_sheet(rows);
            sheet['!cols'] = widths.map(width => ({ wch: width }));
            XLSX.utils.book_append_sheet(workbook, sheet, name);
        };
        appendSheet(summaryRows, '摘要', [18, 24]);
        appendSheet(salesStatsMetricExportRows(report.byBrand, total.totalSales, '廠牌'), '廠牌', [18, 16, 16, 16, 16, 16, 12, 12, 14, 16]);
        appendSheet(salesStatsMetricExportRows(report.bySales, total.totalSales, '業務'), '業務', [18, 16, 16, 16, 16, 16, 12, 12, 14, 16]);
        appendSheet(salesStatsMetricExportRows(report.byTransaction, total.totalSales, '交易方式'), '交易方式', [18, 16, 16, 16, 16, 16, 12, 12, 14, 16]);
        appendSheet(detailRows, '訂單明細', [12, 16, 16, 22, 12, 14, 14, 14, 14, 16, 28, 12, 12, 18, 18, 16, 16, 16, 16, 16, 12, 14, 16]);
        XLSX.writeFile(workbook, `銷售季報_${report.start}_至_${report.end}.xlsx`);
    } catch (err) {
        console.error('匯出季報失敗：', err);
        alert('匯出季報失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function renderMissingCostOrders() {
    const tbody = document.getElementById('missingCostOrdersBody');
    const summary = document.getElementById('missingCostOrdersSummary');
    if (!tbody || !summary) return;
    const report = buildSalesStatisticsReport();
    const missingRows = report.details.filter(({ order }) => !orderHasCost(order));
    summary.innerText = `${report.start || '未指定'} 至 ${report.end || '未指定'}，依目前篩選條件共 ${missingRows.length} 筆。請填寫每單位含稅進貨成本。`;
    tbody.innerHTML = missingRows.length ? missingRows.map(({ order, sales, brand }) => `
        <tr>
            <td>${escapeHtml(order.orderDate || '')}</td>
            <td>${escapeHtml(order.customerName || '')}</td>
            <td>${escapeHtml(sales)}</td>
            <td>${escapeHtml(brand)}</td>
            <td class="missing-cost-product"><strong>${escapeHtml(order.itemName || '－')}</strong><br><small>${escapeHtml(order.itemCode || '')}</small></td>
            <td>${escapeHtml(String(orderQuantity(order)))}</td>
            <td>${formatStatsMoney(salesAmount(order))}</td>
            <td><input type="number" min="0" step="0.01" class="missing-cost-input" aria-label="${escapeAttr(order.itemName || '訂單')}單位成本" onchange="saveMissingCostFromStats(${inlineJsValue(order.id)},${inlineJsValue(order.itemId || '')},${inlineJsValue(orderStatsProductId(order))},${inlineJsValue(order.procurementType || 'PURCHASING_PO')}, this)"><small class="missing-cost-save-state"></small></td>
        </tr>
    `).join('') : '<tr><td colspan="8" style="color:#888;padding:18px;">目前篩選範圍內沒有缺少成本的訂單。</td></tr>';
}

window.openMissingCostOrders = function() {
    renderMissingCostOrders();
    document.getElementById('missingCostOrdersOverlay')?.classList.add('active');
};

window.closeMissingCostOrders = function() {
    document.getElementById('missingCostOrdersOverlay')?.classList.remove('active');
};

window.saveMissingCostFromStats = async function(orderId, itemId, productId, procurementType, input) {
    if (currentUserRole !== 'admin' && currentUserRole !== 'purchaser') {
        alert('只有採購或管理員可以補填成本。');
        renderMissingCostOrders();
        return;
    }
    const cost = Number(input.value);
    if (input.value === '' || !Number.isFinite(cost) || cost < 0) {
        alert('請輸入大於或等於 0 的單位成本。');
        input.focus();
        return;
    }
    const state = input.parentElement?.querySelector('.missing-cost-save-state');
    input.disabled = true;
    if (state) state.innerText = '儲存中…';
    try {
        if (procurementType === 'SALES_SELF_ORDER') {
            const original = salesStatisticsOrders.find(order => order.id === orderId) || ordersCache.find(order => order.id === orderId);
            if (!original) throw new Error('找不到原訂單。');
            const updates = {
                costPrice: cost,
                costSource: 'manual_transaction_cost_correction',
                updatedAt: new Date().toISOString()
            };
            if (Array.isArray(original.items) && original.items.length) {
                updates.items = original.items.map((item, index) => {
                    const sameItem = itemId ? item.itemId === itemId : index === 0;
                    return sameItem ? { ...item, costPrice:cost, costSource:'manual_transaction_cost_correction' } : item;
                });
            }
            await db.collection('orders').doc(orderId).set(updates, { merge:true });
            const applyLocal = order => {
                if (!order) return;
                order.costPrice = cost;
                order.costSource = 'manual_transaction_cost_correction';
                if (updates.items) order.items = updates.items;
            };
            applyLocal(salesStatisticsOrders.find(order => order.id === orderId));
            applyLocal(ordersCache.find(order => order.id === orderId));
        } else {
            const resolvedProductId = String(productId || '').trim();
            if (!resolvedProductId) throw new Error('這筆訂單找不到產品主檔，無法安全寫入標準成本。');
            const line = salesStatisticsOrders.flatMap(salesStatisticOrderLines)
                .find(order => order.id === orderId && orderStatsProductId(order) === resolvedProductId);
            await db.collection('productCosts').doc(resolvedProductId).set({
                productId: resolvedProductId,
                productLineId: line?.productLine || '',
                standardCost: cost,
                salesVisible: false,
                source: 'STATS_COST_UPDATE',
                updatedAt: new Date().toISOString(),
                updatedBy: currentUser?.uid || ''
            }, { merge:true });
            purchaseCostCache.set(resolvedProductId, cost);
            invalidateVisibleProductCosts();
        }
        renderSalesStatistics();
        renderMissingCostOrders();
    } catch (err) {
        input.disabled = false;
        if (state) state.innerText = '儲存失敗';
        alert('成本儲存失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function inlineJsValue(value) { return escapeAttr(JSON.stringify(String(value ?? ''))); }
function escapeAttr(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 早期估價單/訂單的「業務」欄位存的是「姓名 電話」黏在一起的舊格式（例如「周博恩 0937-907-169」），
// 訂單管理系統的「負責業務」欄位只需要顯示姓名，這裡統一去掉後面的電話號碼
function stripPhoneSuffix(name) {
    if (!name) return '';
    return name.toString().replace(/\s+\d[\d\-]{6,}\s*$/, '').trim();
}

// 點選清單資料列時保留灰底選取狀態；按鈕、輸入框與下拉選單維持原本操作，不會誤切換列。
function bindListRowSelection(row) {
    row.addEventListener('click', event => {
        if (event.target.closest('button, input, select, textarea, label, a, details, summary')) return;
        const tbody = row.parentElement;
        tbody?.querySelectorAll('tr.list-row-selected').forEach(selected => selected.classList.remove('list-row-selected'));
        row.classList.add('list-row-selected');
    });
}

/* ---------- 業務名單管理（唯讀，資料來源為 users 集合，與登入帳號綁定） ---------- */
// 這裡顯示 users 集合裡「所有」帳號（包含還沒填 name/code、只能登入沒被列進業務下拉選單的人），
// 讓你能一眼看出目前有哪些帳號對這個系統有登入權限；下拉選單用的業務清單（salesList）不受影響，仍只取有填 name+code 的人

window.renderAdminSalesTable = function() {
    const tbody = document.getElementById('adminSalesBody');
    tbody.innerHTML = '';
    const roleLabel = ROLE_LABELS;
    allUsersCache.forEach((u) => {
        const tr = document.createElement('tr');
        const hasProfile = !!u.name;
        tr.innerHTML = `
            <td data-label="代號">${escapeHtml(u.code || '—')}</td>
            <td data-label="姓名">${escapeHtml(u.name || '（尚未設定姓名）')}</td>
            <td data-label="電話">${escapeHtml(u.phone || '—')}</td>
            <td data-label="Email">${u.email ? escapeHtml(u.email) : '<span style="color:#c0392b;font-size:11px;">尚未取得（需等對方登入一次才會同步）</span>'}</td>
            <td data-label="身份"><select id="adminUserRole-${escapeAttr(u.uid)}" onchange="saveAdminUserRole(${inlineJsValue(u.uid)}, this)">${['admin','sales','purchaser','warehouse','engineer'].map(role=>`<option value="${role}" ${u.role===role?'selected':''}>${escapeHtml(roleLabel[role])}</option>`).join('')}</select></td>
            <td data-label="領貨／地址"><button type="button" class="btn-small btn-secondary" onclick="openSalesDeliveryDefaults(${inlineJsValue(u.uid)})">${u.deliveryDefaults?.mode==='SALES_SHIP'?'寄到業務地址':'主倉領貨'}</button></td>
            <td data-label="密碼" class="admin-user-password-actions">
                ${u.mustChangePassword
                    ? `<span class="status-badge status-soon" style="margin-right:6px;">下次登入須改密碼</span><button type="button" class="btn-small btn-secondary" onclick="toggleMustChangePassword('${u.uid}', false)">取消要求</button>`
                    : `<button type="button" class="btn-small" onclick="toggleMustChangePassword('${u.uid}', true)">🔒 強制下次登入改密碼</button>`}
                <br>
                ${u.email
                    ? `<button type="button" class="btn-small btn-secondary" style="margin-top:4px;" onclick="sendPasswordResetToUser(${inlineJsValue(u.email)})">📧 寄送密碼重設信</button>`
                    : ''}
            </td>
            <td data-label="帳號 UID" class="admin-user-uid" style="font-family:monospace;font-size:11px;color:${hasProfile ? '#999' : '#c0392b'};">${escapeHtml(u.uid)}</td>
        `;
        tbody.appendChild(tr);
    });
};

window.saveAdminUserRole=async function(uid, selectEl){
    if(trueUserRole!=='admin')return;
    const select=selectEl||document.getElementById(`adminUserRole-${uid}`);
    const user=allUsersCache.find(x=>x.uid===uid);
    const previousRole=user?.role||'sales';
    const role=select?.value||'sales';
    if(role===previousRole)return;
    if(select)select.disabled=true;
    try{
        await db.collection('users').doc(uid).set({
            role,
            capabilities:role==='engineer'?['business','engineering']:role==='sales'?['business']:[],
            updatedAt:new Date().toISOString()
        },{merge:true});
        if(user) user.role=role;
        if(select)select.title='角色已更新';
    } catch(err) {
        if(select)select.value=previousRole;
        alert('更新失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        if(select)select.disabled=false;
    }
};

// 強制某帳號下次登入時必須先修改密碼才能使用系統。
// 說明：前端 Firebase Auth SDK 沒有「管理員直接幫別人設定新密碼」的權限（那需要後端 Admin SDK／Cloud Function，
// 這個系統目前沒有後端），所以做法是：先在該帳號的資料上做記號，等他本人下次登入時，
// 系統會強制跳出「修改密碼」視窗、擋住其他操作，直到他自己設好新密碼為止。
window.toggleMustChangePassword = function(uid, value) {
    const msg = value ? '確定要要求這個帳號下次登入時必須先修改密碼嗎？' : '確定要取消這個要求嗎？';
    if (!confirm(msg)) return;

    db.collection('users').doc(uid).set({ mustChangePassword: value }, { merge: true }).then(() => {
        reloadSalesFromUsers();
    }).catch(err => {
        alert('設定失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    });
};

// 寄送 Firebase 官方的密碼重設信到指定 Email，對方收信後可以自己點連結設定新密碼
// （適合對方忘記密碼、登不進來的情況；跟「強制下次登入改密碼」是兩種互補的做法）
window.sendPasswordResetToUser = function(email) {
    if (!confirm(`確定要寄送密碼重設信到 ${email} 嗎？`)) return;
    firebase.auth().sendPasswordResetEmail(email).then(() => {
        alert(`密碼重設信已寄出到 ${email}。`);
    }).catch(err => {
        alert('寄送失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    });
};

async function syncSalesCodeMasterFromUsers() {
    if (trueUserRole !== 'admin') return;
    const now = new Date().toISOString();
    for (const person of salesList.filter(item => item.code)) {
        await db.collection('salesCodes').doc(String(person.code)).set({
            code: String(person.code),
            currentUserUid: person.uid || '',
            currentUserName: person.name || '',
            active: true,
            updatedAt: now
        }, { merge: true });
    }
}

async function loadSalesCodeMaster() {
    const generation = sessionDataGeneration;
    const rows = await readCollectionInBatches('salesCodes');
    if (generation !== sessionDataGeneration) return [];
    salesCodeMasterCache = rows
        .filter(item => item.active !== false)
        .sort((x, y) => String(x.code || x.id).localeCompare(String(y.code || y.id), 'zh-Hant'));
    return salesCodeMasterCache;
}

window.reloadSalesFromUsers = function() {
    const generation = sessionDataGeneration;
    return readCollectionInBatches('users').then(async rows => {
        if (generation !== sessionDataGeneration) return;
        salesList = rows
            .filter(d => d.name && d.code)
            .map(d => ({ uid:d.id, code:d.code, name:d.name, phone:d.phone || '', role:d.role || 'sales', active:d.active !== false }))
            .sort((a,b)=>String(a.code||'').localeCompare(String(b.code||'')));

        allUsersCache = rows.map(d => ({
            uid:d.id, code:d.code || '', name:d.name || '', phone:d.phone || '',
            role:d.role || 'sales', email:d.email || '', disabled:!!d.disabled,
            active:d.active !== false, mustChangePassword:!!d.mustChangePassword,
            deliveryDefaults:d.deliveryDefaults || {}
        })).sort((a,b)=>{
            if (a.name && !b.name) return -1;
            if (!a.name && b.name) return 1;
            return String(a.code||'').localeCompare(String(b.code||'')) || a.uid.localeCompare(b.uid);
        });

        // Admin users 查詢同時就是一般頁面的 salesList 資料來源，兩邊共用，不再重查 users。
        applySalesRows(rows);
        salesListLoadPromise = Promise.resolve(salesList);
        if (trueUserRole === 'admin') await syncSalesCodeMasterFromUsers().catch(err => console.warn('同步業務代號主檔失敗：', err));
        if (generation !== sessionDataGeneration) return;
        await loadSalesCodeMaster().catch(err => { console.warn('讀取業務代號主檔失敗：', err); salesCodeMasterCache = []; });
        if (generation !== sessionDataGeneration) return;
        renderAdminSalesTable();
        populateTransferDropdowns();
    }).catch(err => {
        if (generation !== sessionDataGeneration) return;
        mainPageLoadFailed('admin');
        console.error('重新載入人員資料失敗：', err);
        allUsersCache = [];
        renderAdminSalesTable();
    });
};

/* ---------- 業務代號交接：資料歸屬維持 salesCode，只更換代號目前負責業務 ---------- */
function populateTransferDropdowns() {
    const codeSelect = document.getElementById('transferFromSales');
    const userSelect = document.getElementById('transferToSales');
    if (!codeSelect || !userSelect) return;

    const codeValue = codeSelect.value;
    const userValue = userSelect.value;
    const codeRows = salesCodeMasterCache.length
        ? salesCodeMasterCache
        : salesList.filter(s => s.code).map(s => ({ code: s.code, currentUserName: s.name, currentUserUid: s.uid }));
    codeSelect.innerHTML = '<option value="">請選擇業務代號</option>' +
        codeRows.map(s => `<option value="${escapeAttr(s.code || s.id)}">${escapeHtml(s.code || s.id)}｜${escapeHtml(s.currentUserName || '未指派')}</option>`).join('');
    userSelect.innerHTML = '<option value="">請選擇接手同仁</option>' +
        allUsersCache.filter(u => u.name).map(u => `<option value="${escapeAttr(u.uid)}">${escapeHtml(u.name)}｜${escapeHtml(u.email || u.uid)}</option>`).join('');
    if ([...codeSelect.options].some(o => o.value === codeValue)) codeSelect.value = codeValue;
    if ([...userSelect.options].some(o => o.value === userValue)) userSelect.value = userValue;
    resetTransferPreview();
}

window.resetTransferPreview = function() {
    const btn = document.getElementById('transferExecuteBtn');
    const result = document.getElementById('transferResult');
    if (btn) btn.style.display = 'none';
    if (result) result.innerText = '';
};

function getTransferSelection() {
    const salesCode = document.getElementById('transferFromSales')?.value || '';
    const targetUid = document.getElementById('transferToSales')?.value || '';
    const master = salesCodeMasterCache.find(item => String(item.code || item.id) === String(salesCode)) || null;
    const currentHolder = master?.currentUserUid
        ? allUsersCache.find(u => u.uid === master.currentUserUid) || { uid: master.currentUserUid, name: master.currentUserName || '', code: salesCode }
        : salesList.find(s => String(s.code) === String(salesCode)) || null;
    const target = allUsersCache.find(u => u.uid === targetUid) || null;
    return { salesCode, targetUid, currentHolder, target, master };
}

async function legacySalesDocsInPages(collectionName, salesName, onPage, pageSize = 200) {
    let cursor = null;
    while (true) {
        let query = db.collection(collectionName)
            .where('salesName', '==', salesName)
            .orderBy(firebase.firestore.FieldPath.documentId())
            .limit(pageSize);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(
            query.get(),
            collectionName + ' 舊業務資料'
        );
        if (snap.empty) break;
        await onPage(snap.docs);
        cursor = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) break;
    }
}

async function countLegacyRecordsForSalesCode(person) {
    if (!person?.name) return { quotes:0, orders:0, forecasts:0, equipment:0, total:0 };
    const configs = [
        ['quotes','quotes'], ['orders','orders'], ['forecasts','forecasts'], ['equipment','equipment']
    ];
    const counts = {};
    await Promise.all(configs.map(async ([key, collection]) => {
        let count = 0;
        await legacySalesDocsInPages(collection, person.name, docs => {
            count += docs.filter(doc => !doc.data().salesCode).length;
        });
        counts[key] = count;
    }));
    counts.total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    return counts;
}

window.previewSalesTransfer = async function() {
    const { salesCode, target, currentHolder } = getTransferSelection();
    const resultEl = document.getElementById('transferResult');
    const executeBtn = document.getElementById('transferExecuteBtn');
    executeBtn.style.display = 'none';

    if (!salesCode || !target) {
        resultEl.innerText = '請先選擇要交接的業務代號與接手同仁。';
        return;
    }
    if (currentHolder?.uid === target.uid) {
        resultEl.innerText = '這位同仁目前已經是此業務代號的負責業務。';
        return;
    }
    if (target.code && String(target.code) !== String(salesCode)) {
        resultEl.innerText = `接手同仁目前已有業務代號 ${target.code}。請先完成該代號的交接或解除後，再接手 ${salesCode}，避免同一帳號同時擁有兩個代號。`;
        return;
    }

    resultEl.innerText = '檢查舊資料中…';
    try {
        const counts = await countLegacyRecordsForSalesCode(currentHolder);
        resultEl.innerText =
            `業務代號：${salesCode}\n目前負責業務：${currentHolder?.name || '未指定'}\n接手同仁：${target.name}\n\n` +
            `舊資料需要補上 salesCode：${counts.total} 筆\n` +
            `・估價單 ${counts.quotes || 0}\n・訂單 ${counts.orders || 0}\n・Forecast ${counts.forecasts || 0}\n・儀器 ${counts.equipment || 0}\n\n` +
            '交接後歷史 salesName/createdBy 不會被改寫；資料歸屬只改由此業務代號的現任負責業務接手。';
        executeBtn.style.display = '';
    } catch (err) {
        resultEl.innerText = '檢查失敗：' + err.message;
    }
};

async function backfillSalesCodeForLegacyRecords(person, salesCode) {
    if (!person?.name || !salesCode) return 0;
    const collections = ['quotes','orders','forecasts','equipment'];
    let total = 0;
    const migratedAt = new Date().toISOString();
    for (const collection of collections) {
        await legacySalesDocsInPages(collection, person.name, async docs => {
            const refs = docs.filter(doc => !doc.data().salesCode).map(doc => doc.ref);
            if (!refs.length) return;
            await runFirestoreBatchUpdates(refs, { salesCode, ownershipMigratedAt: migratedAt });
            total += refs.length;
        });
    }
    return total;
}

window.executeSalesTransfer = async function() {
    const { salesCode, target, currentHolder } = getTransferSelection();
    const resultEl = document.getElementById('transferResult');
    const button = document.getElementById('transferExecuteBtn');
    if (!salesCode || !target || !button) return;

    if (!confirm(`確定把業務代號「${salesCode}」交接給「${target.name}」嗎？\n歷史交易內容與原建立人不會改寫；此代號的新舊資料會改由接手同仁查看與管理。`)) return;

    button.disabled = true;
    resultEl.innerText = '交接中…';
    try {
        const migrated = await backfillSalesCodeForLegacyRecords(currentHolder, salesCode);
        const now = new Date().toISOString();
        const codeRef = db.collection('salesCodes').doc(String(salesCode));
        const codeSnap = await firestoreReadWithTimeout(
            codeRef.get(),
            '業務代號交接紀錄'
        );
        const history = Array.isArray(codeSnap.data()?.handoffHistory) ? codeSnap.data().handoffHistory : [];
        const entry = {
            fromUid: currentHolder?.uid || '',
            fromName: currentHolder?.name || '',
            toUid: target.uid,
            toName: target.name || '',
            at: now,
            byUid: currentUser?.uid || '',
            byName: currentUserName || ''
        };

        const batch = db.batch();
        batch.set(codeRef, {
            code: String(salesCode),
            currentUserUid: target.uid,
            currentUserName: target.name || '',
            active: true,
            handoffHistory: [...history, entry],
            updatedAt: now
        }, { merge: true });
        batch.set(db.collection('users').doc(target.uid), { code: String(salesCode), codeAssignedAt: now }, { merge: true });
        if (currentHolder?.uid && currentHolder.uid !== target.uid) {
            batch.set(db.collection('users').doc(currentHolder.uid), {
                code: '',
                previousSalesCode: String(salesCode),
                codeHandedOffAt: now
            }, { merge: true });
        }
        await batch.commit();

        resultEl.innerText = `交接完成。業務代號 ${salesCode} 現由 ${target.name} 負責；另補上 ${migrated} 筆舊資料的 salesCode。歷史姓名與操作紀錄均保留。`;
        button.style.display = 'none';
        button.disabled = false;
        salesListLoadPromise = null;
        await reloadSalesFromUsers();
    } catch (err) {
        console.error(err);
        resultEl.innerText = '交接失敗：' + err.message;
        button.disabled = false;
    }
};

// 依 Firestore batch 500 筆上限，自動切批次執行文件更新
function runFirestoreBatchUpdates(refs, updateData) {
    const CHUNK = 450;
    const chunks = [];
    for (let i = 0; i < refs.length; i += CHUNK) {
        chunks.push(refs.slice(i, i + CHUNK));
    }
    let chain = Promise.resolve();
    chunks.forEach(chunk => {
        chain = chain.then(() => {
            const batch = db.batch();
            chunk.forEach(ref => batch.update(ref, updateData));
            return batch.commit();
        });
    });
    return chain;
}

/* ---------- 資料庫用量估算 ---------- */
function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// 統計各集合的文件數與內容大小；這是「文件 JSON 內容」的估計值，
// 跟 Firebase 主控台的實際帳單用量（還包含索引等額外儲存空間）不完全相同，僅供大致參考
window.calculateStorageUsage = async function() {
    const tbody = document.getElementById('storageUsageBody');
    tbody.innerHTML = '<tr><td colspan="3" style="color:#888;">計算中，請稍候…</td></tr>';

    const collections = [
        { key: 'quotes', label: '估價單' }, { key: 'forecasts', label: 'Forecast' },
        { key: 'orders', label: '訂單' }, { key: 'purchaseOrders', label: '採購單' },
        { key: 'procurementDemands', label: '採購需求' },
        { key: 'supplyOrders', label: '供應／訂貨紀錄' }, { key: 'receipts', label: '收貨紀錄' }, { key: 'customerReturnReceipts', label: '客戶退貨實收紀錄' },
        { key: 'dispatchRecords', label: '出貨打單紀錄' }, { key: 'inventory', label: '庫存彙總' },
        { key: 'inventoryLots', label: '庫存批次' }, { key: 'inventoryLotCosts', label: '受保護批次成本' },
        { key: 'inventoryReservations', label: '庫存預留' }, { key: 'inventoryMovements', label: '庫存異動' },
        { key: 'warehouseStocks', label: '分倉庫存' }, { key: 'stockTransferRequests', label: '備貨調回需求' }, { key: 'stockTransfers', label: '倉庫調撥' }, { key: 'products', label: '產品主檔' },
        { key: 'productCosts', label: '受保護產品成本' }, { key: 'equipment', label: '儀器' },
        { key: 'users', label: '人員／使用者帳號' }, { key: 'settings', label: '系統設定' }
    ];

    try {
        let totalBytes = 0, totalDocs = 0;
        const rows = [];
        for (let i = 0; i < collections.length; i++) {
            const c = collections[i];
            tbody.innerHTML = `<tr><td colspan="3" style="color:#888;">正在分批讀取 ${escapeHtml(c.label)}（${i + 1}/${collections.length}）…</td></tr>`;
            const records = await readCollectionInBatches(c.key);
            const bytes = records.reduce((sum, row) => {
                const { id, ...data } = row;
                return sum + new Blob([JSON.stringify(data)]).size;
            }, 0);
            totalBytes += bytes;
            totalDocs += records.length;
            rows.push({ label:c.label, count:records.length, bytes });
        }
        tbody.innerHTML = rows.map(r => `
            <tr><td>${escapeHtml(r.label)}</td><td>${r.count}</td><td>${formatBytes(r.bytes)}</td></tr>
        `).join('') + `
            <tr style="font-weight:bold;background:#f5f5f5;"><td>總計</td><td>${totalDocs}</td><td>${formatBytes(totalBytes)}</td></tr>
        `;
    } catch (err) {
        tbody.innerHTML = `<tr><td colspan="3" style="color:#cc0000;">計算失敗：${escapeHtml(err.message)}</td></tr>`;
    }
};

/* ---------- 資料庫備份 ---------- */
function backupSerializableValue(value) {
    if (value === null || value === undefined || typeof value !== 'object') return value;
    if (typeof value.toDate === 'function') return { __type: 'timestamp', value: value.toDate().toISOString() };
    if (value instanceof Date) return { __type: 'date', value: value.toISOString() };
    if (Array.isArray(value)) return value.map(backupSerializableValue);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, backupSerializableValue(item)]));
}

window.downloadDatabaseBackup = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        alert('只有管理員可以下載資料庫備份。');
        return;
    }
    if (!confirm('下載備份會讀取目前資料庫的全部資料，可能增加 Firebase 本日讀取量。建議每月或重大修改前執行，確定繼續嗎？')) return;

    const button = document.getElementById('databaseBackupBtn');
    const status = document.getElementById('databaseBackupStatus');
    const collections = [
        'quotes', 'forecasts', 'orders', 'purchaseOrders', 'procurementDemands', 'equipment', 'users', 'settings',
        'brands', 'productLines', 'products', 'productCosts', 'priceHistory', 'customers', 'salesCodes',
        'suppliers', 'brandSupplierMappings', 'warehouses', 'warehouseStocks',
        'inventory', 'inventoryLots', 'inventoryLotCosts', 'inventoryReservations',
        'inventoryMovements', 'receipts', 'customerReturnReceipts', 'supplyOrders', 'dispatchRecords', 'deliveries', 'auditLogs', 'purchaseOrderCommunications'
    ];
    button.disabled = true;
    button.innerText = '正在整理備份…';
    status.innerText = '讀取雲端資料中，請不要關閉頁面。';
    try {
        const data = {};
        let documentCount = 0;
        for (let i = 0; i < collections.length; i++) {
            const name = collections[i];
            status.innerText = `正在分批備份 ${name}（${i + 1}/${collections.length}）…`;
            const records = await readCollectionInBatches(name);
            data[name] = records.map(row => {
                const { id, ...recordData } = row;
                return { id, path:`${name}/${id}`, data:backupSerializableValue(recordData) };
            });
            documentCount += records.length;
        }
        // Read Forecast progress through each authorized parent path. A collection-group query
        // cannot safely prove the parent-specific Firestore rule for every possible progress path.
        data.forecastProgress = [];
        for (let i = 0; i < (data.forecasts || []).length; i++) {
            const forecast = data.forecasts[i];
            status.innerText = `正在備份 Forecast 進度（${i + 1}/${data.forecasts.length}）…`;
            const progressRows = await readQueryInBatches(db.collection('forecasts').doc(forecast.id).collection('progress'));
            progressRows.forEach(row => {
                const { id, ...recordData } = row;
                data.forecastProgress.push({
                    id,
                    path:`forecasts/${forecast.id}/progress/${id}`,
                    data:backupSerializableValue(recordData)
                });
            });
            documentCount += progressRows.length;
        }
        const createdAt = new Date();
        const backup = {
            format: 'yu-shing-firestore-backup',
            version: 1,
            projectId: firebaseConfig.projectId,
            createdAt: createdAt.toISOString(),
            createdBy: currentUser?.email || currentUserName || '',
            documentCount,
            collections: data
        };
        const localStamp = `${createdAt.getFullYear()}${String(createdAt.getMonth() + 1).padStart(2, '0')}${String(createdAt.getDate()).padStart(2, '0')}-${String(createdAt.getHours()).padStart(2, '0')}${String(createdAt.getMinutes()).padStart(2, '0')}${String(createdAt.getSeconds()).padStart(2, '0')}`;
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `database-backup-${localStamp}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.innerText = `備份已下載，共 ${documentCount} 筆文件，檔案大小約 ${formatBytes(blob.size)}。`;
    } catch (err) {
        console.error('下載資料庫備份失敗：', err);
        status.innerText = '備份失敗：' + err.message;
        alert('無法完成備份，請確認 Firestore 權限與網路連線。');
    } finally {
        button.disabled = false;
        button.innerText = '⬇️ 下載資料庫備份';
    }
};

// A restore never overwrites live documents. Identity and permission settings require
// separate administrator review, so the browser cannot recreate them from an old file.
let pendingDatabaseBackup = null;
const RESTORABLE_BACKUP_COLLECTIONS = new Set([
    'quotes','forecasts','orders','purchaseOrders','procurementDemands','equipment','brands','productLines',
    'products','productCosts','priceHistory','customers','salesCodes','suppliers',
    'brandSupplierMappings','warehouses','warehouseStocks','inventory','inventoryLots',
    'inventoryLotCosts','inventoryReservations','inventoryMovements',
    'receipts','customerReturnReceipts','supplyOrders','dispatchRecords','deliveries','auditLogs','forecastProgress'
]);
function restoreBackupValue(value) {
    if (Array.isArray(value)) return value.map(restoreBackupValue);
    if (value && typeof value === 'object') {
        if (Object.keys(value).length === 2 && (value.__type === 'timestamp' || value.__type === 'date')) {
            const date = new Date(value.value);
            if (!Number.isFinite(date.getTime())) throw new Error('備份包含無效日期。');
            return value.__type === 'timestamp' ? firebase.firestore.Timestamp.fromDate(date) : date;
        }
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, restoreBackupValue(item)]));
    }
    return value;
}
function validateBackupDocuments(backup) {
    if (backup?.format !== 'yu-shing-firestore-backup' || backup.version !== 1 ||
        !backup.collections || typeof backup.collections !== 'object' || Array.isArray(backup.collections)) {
        throw new Error('檔案不是支援的資料庫備份格式。');
    }
    if (backup.projectId && backup.projectId !== firebaseConfig.projectId) throw new Error('備份屬於不同 Firebase 專案。');
    const docs = [], seen = new Set();
    for (const [collection, rows] of Object.entries(backup.collections)) {
        if (!RESTORABLE_BACKUP_COLLECTIONS.has(collection) && collection !== 'users' && collection !== 'settings')
            throw new Error(`未知的集合：${collection}`);
        if (!Array.isArray(rows)) throw new Error(`${collection} 不是文件清單。`);
        for (const row of rows) {
            const segments = String(row?.path || '').split('/');
            const validPath = collection === 'forecastProgress'
                ? segments.length === 4 && segments[0] === 'forecasts' && segments[2] === 'progress'
                : segments.length === 2 && segments[0] === collection;
            if (!validPath || segments.some(part => !part || part === '.' || part === '..') || row.id !== segments.at(-1) ||
                !row.data || typeof row.data !== 'object' || Array.isArray(row.data) || seen.has(row.path)) {
                throw new Error(`無效或重複的文件路徑：${row?.path || collection}`);
            }
            seen.add(row.path);
            if (seen.size > 10000) throw new Error('備份超過 10,000 筆，請改用受控的伺服器端還原。');
            if (collection !== 'users' && collection !== 'settings') docs.push({ path: row.path, data: restoreBackupValue(row.data) });
        }
    }
    if (seen.size !== backup.documentCount) throw new Error('備份文件數量與檔案記錄不符。');
    return docs;
}
window.previewDatabaseBackupUpload = async function(input) {
    const status = document.getElementById('databaseBackupUploadStatus');
    const restore = document.getElementById('databaseBackupRestoreBtn');
    pendingDatabaseBackup = null;
    if (restore) restore.style.display = 'none';
    const file = input?.files?.[0];
    if (!file) return;
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    try {
        if (file.size > 50 * 1024 * 1024) throw new Error('檔案超過 50 MB，請改用受控的伺服器端還原。');
        status.textContent = '正在檢查備份檔案…';
        const backup = JSON.parse(await file.text());
        const documents = validateBackupDocuments(backup);
        pendingDatabaseBackup = documents;
        status.textContent = `備份時間：${backup.createdAt || '未記錄'}；共 ${backup.documentCount} 筆，其中 ${documents.length} 筆可補回。上傳檢查不會改動雲端資料。補回時只建立目前不存在的文件；帳號及系統設定不會由檔案還原。`;
        if (restore && documents.length) restore.style.display = '';
    } catch (err) { status.textContent = `備份檢查失敗：${err.message}`; }
    finally { input.value = ''; }
};
window.restoreMissingDatabaseBackupDocuments = async function() {
    const docs = pendingDatabaseBackup;
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin' || !docs?.length) return;
    if (!confirm(`將逐筆檢查 ${docs.length} 筆備份文件，只補回目前不存在的文件；現有文件不會覆蓋，帳號與系統設定不會還原。過程可能耗時並增加讀寫量。確定執行嗎？`)) return;
    const button = document.getElementById('databaseBackupRestoreBtn');
    const status = document.getElementById('databaseBackupUploadStatus');
    button.disabled = true;
    let created = 0, skipped = 0;
    try {
        for (const row of docs) {
            const ref = db.doc(row.path);
            // A transaction makes repeat clicks and retries safe even if another user writes concurrently.
            const inserted = await runRoleTransaction(async transaction => {
                const existing = await transaction.get(ref);
                if (existing.exists) return false;
                transaction.set(ref, row.data);
                return true;
            });
            if (inserted) created++; else skipped++;
            if ((created + skipped) % 20 === 0) status.textContent = `補回中：已檢查 ${created + skipped}/${docs.length}，新增 ${created}，略過既有 ${skipped}。`;
        }
        status.textContent = `補回完成：新增 ${created}，略過既有 ${skipped}。帳號與系統設定未還原。`;
        pendingDatabaseBackup = null;
        button.style.display = 'none';
    } catch (err) {
        status.textContent = `補回中斷：新增 ${created}，略過既有 ${skipped}。${err.message} 可重新上傳同一備份繼續，既有文件不會覆蓋。`;
    } finally { button.disabled = false; }
};

/* ---------- 估價單／訂單全歷史搜尋索引補建 ---------- */
let orderSearchIndexMigrationRunning = false;
let orderSearchIndexAwaitingConfirmation = false;
let orderSearchIndexConfirmationTimer = null;

window.backfillOrderSearchIndex = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        alert('只有管理員可以執行搜尋索引補建。');
        return;
    }
    if (orderSearchIndexMigrationRunning) return;
    const button = document.getElementById('orderSearchIndexMigrationBtn');
    const status = document.getElementById('orderSearchIndexMigrationStatus');
    if (!orderSearchIndexAwaitingConfirmation) {
        orderSearchIndexAwaitingConfirmation = true;
        if (status) status.innerText = '這會逐批檢查舊估價單、Forecast、訂單與儀器，只補建搜尋索引，不修改金額、狀態或流程。請在 10 秒內再按一次確認開始。';
        if (button) button.innerText = '確認開始補建';
        clearTimeout(orderSearchIndexConfirmationTimer);
        orderSearchIndexConfirmationTimer = setTimeout(() => {
            if (orderSearchIndexMigrationRunning) return;
            orderSearchIndexAwaitingConfirmation = false;
            if (button) button.innerText = '建立／修正全歷史搜尋索引';
            if (status?.innerText.includes('請在 10 秒內')) status.innerText = '已取消：未在時間內再次確認。';
        }, 10000);
        return;
    }
    orderSearchIndexAwaitingConfirmation = false;
    clearTimeout(orderSearchIndexConfirmationTimer);
    orderSearchIndexMigrationRunning = true;
    if (button) { button.disabled = true; button.innerText = '補建中…'; }
    let scanned = 0, updated = 0;
    try {
        for (const collectionName of ['quotes','orders','forecasts','equipment']) {
            let cursor = null;
            while (true) {
                let query = db.collection(collectionName).orderBy(firebase.firestore.FieldPath.documentId()).limit(200);
                if (cursor) query = query.startAfter(cursor);
                const snapshot = await firestoreReadWithTimeout(
                    query.get(),
                    collectionName + ' 搜尋索引補建'
                );
                if (snapshot.empty) break;
                const batch = db.batch();
                let writes = 0;
                snapshot.docs.forEach(doc => {
                    const data = doc.data() || {};
                    const type = collectionName === 'quotes' ? 'quote'
                        : collectionName === 'forecasts' ? 'forecast'
                        : collectionName === 'equipment' ? 'equipment' : 'order';
                    const searchTokens = buildFullHistorySearchTokens(type, { id: doc.id, ...data });
                    const update = {};
                    if (JSON.stringify(data.searchTokens || []) !== JSON.stringify(searchTokens)) update.searchTokens = searchTokens;
                    if (collectionName === 'orders') {
                        const sourceCode = data.itemCode || data.productCode || data.model || '';
                        const normalized = normalizeHistoryItemCode(sourceCode);
                        if (normalized && data.itemCodeKey !== normalized) update.itemCodeKey = normalized;
                    }
                    scanned += 1;
                    if (Object.keys(update).length) {
                        batch.update(doc.ref, update);
                        writes += 1;
                        updated += 1;
                    }
                });
                if (writes) await batch.commit();
                cursor = snapshot.docs[snapshot.docs.length - 1];
                if (status) status.innerText = `${collectionName === 'quotes' ? '估價單' : collectionName === 'forecasts' ? 'Forecast' : collectionName === 'equipment' ? '儀器' : '訂單'}：已檢查 ${scanned} 筆，更新 ${updated} 筆搜尋索引…`;
                if (snapshot.size < 200) break;
            }
        }
        if (status) status.innerText = `完成：共檢查 ${scanned} 筆估價單／Forecast／訂單／儀器，建立或修正 ${updated} 筆全歷史搜尋索引。`;
    } catch (err) {
        console.error('全歷史搜尋索引補建失敗：', err);
        if (status) status.innerText = `補建中斷：已檢查 ${scanned} 筆、更新 ${updated} 筆。可重新執行，已完成資料不會重複修改。`;
        alert('搜尋索引補建未完成，請確認 Firestore 權限與網路連線後再試。');
    } finally {
        orderSearchIndexMigrationRunning = false;
        if (button) { button.disabled = false; button.innerText = '建立／修正全歷史搜尋索引'; }
    }
};

/* ---------- Product Master：正式主檔與資料維護 ---------- */
let productMasterMigrationRunning = false;

function productItemWithoutCost(item) {
    const clean = { ...item };
    delete clean.cost;
    delete clean.standardCost;
    delete clean.purchaseCost;
    return clean;
}

function productMasterRecordFromItem(item, source = 'PRODUCT_MASTER') {
    const normalized = normalizeProductMasterItem(item);
    const brand = resolveBrandName(normalized.brand || '');
    const brandEntry = brandMasterEntryForName(brand);
    const status = normalized.active === false ? 'INACTIVE' : 'ACTIVE';
    return {
        productId: normalized.productId || stableProductId(normalized),
        brandId: brandEntry?.id || '',
        brandName: brand,
        manufacturerPartNo: normalized.model || normalized.sku || '',
        normalizedPartNo: normalizeItemCodeLoose(normalized.model || normalized.sku || ''),
        productName: normalized.nameCn || normalized.nameEn || '',
        nameEn: normalized.nameEn || '',
        productLine: normalized.productLine || '',
        productLineId: normalized.productLine || '',
        category: normalized.productType || '',
        productType: normalized.productType || '',
        specification: normalized.spec || '',
        unit: normalized.unit || '',
        listPrice: Number(normalized.price || 0),
        inventoryTracked: !!normalized.inventoryTracked,
        lotTracked: !!normalized.lotTracked,
        expiryTracked: !!normalized.expiryTracked,
        status,
        active: status === 'ACTIVE',
        source: String(normalized.source || source || 'PRODUCT_MASTER').toUpperCase(),
        ...(normalized.createdAt ? { createdAt: normalized.createdAt } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser?.uid || ''
    };
}

async function readCollectionForMigration(name, pageSize = 300) {
    const rows = [];
    let cursor = null;
    while (true) {
        let query = db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(pageSize);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(
            query.get(),
            name + ' 遷移資料'
        );
        if (snap.empty) break;
        snap.docs.forEach(doc => rows.push({ ref:doc.ref, id:doc.id, data:doc.data() || {} }));
        cursor = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) break;
    }
    return rows;
}

// 共用批次寫入：Firestore 單一 write batch 有筆數上限，因此大型 Product Master／成本更新分批提交。
// 各操作需可安全重跑；若中途網路失敗，已完成的批次保留，使用者可再次執行未完成部分。
async function commitMigrationBatch(operations, chunkSize = 400) {
    const safeOperations = Array.isArray(operations)
        ? operations.filter(operation => typeof operation === 'function')
        : [];
    if (!safeOperations.length) return 0;

    const safeChunkSize = Math.max(1, Math.min(400, Number(chunkSize) || 400));
    let committed = 0;
    for (let i = 0; i < safeOperations.length; i += safeChunkSize) {
        const chunk = safeOperations.slice(i, i + safeChunkSize);
        const batch = db.batch();
        chunk.forEach(operation => operation(batch));
        try {
            await batch.commit();
        } catch (err) {
            err.committedOperations = committed;
            err.totalOperations = safeOperations.length;
            throw err;
        }
        committed += chunk.length;
    }
    return committed;
}
function recordContainsEmbeddedCost(record) {
    return !!record && (record.cogs !== undefined || (Array.isArray(record.lotAllocations) && record.lotAllocations.some(row => row && (row.cost !== undefined || row.unitCost !== undefined))));
}
function inventoryCostMigrationPlan(lots, inventory, receipts, movements, orders = [], warehouseStocks = []) {
    return {
        legacyLots: lots.filter(row => row.data.unitCost !== undefined),
        legacyInventory: inventory.filter(row => row.data.unitCost !== undefined || row.data.cost !== undefined || (Array.isArray(row.data.lots) && row.data.lots.some(lot => lot && (lot.unitCost !== undefined || lot.cost !== undefined)))),
        legacyWarehouseStocks: warehouseStocks.filter(row => row.data.unitCost !== undefined || row.data.cost !== undefined),
        legacyReceipts: receipts.filter(row => row.data.unitCost !== undefined || row.data.purchaseNetAmount !== undefined),
        legacyMovements: movements.filter(row => row.data.unitCost !== undefined || row.data.purchaseNetAmount !== undefined || row.data.cogs !== undefined),
        legacyOrders: orders.filter(row => [...(row.data.deliveryRecords || []), ...(row.data.returnRecords || [])].some(recordContainsEmbeddedCost))
    };
}
async function readCollectionInBatches(collectionName, batchSize = 500) {
    const rows = [];
    let cursor = null;
    while (true) {
        let query = db.collection(collectionName).orderBy(firebase.firestore.FieldPath.documentId()).limit(batchSize);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), collectionName + ' 批次資料');
        snap.forEach(doc => rows.push({ id:doc.id, ...doc.data() }));
        if (snap.size < batchSize) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return rows;
}

async function readQueryInBatches(baseQuery, batchSize = 500) {
    const rows = [];
    let cursor = null;
    while (true) {
        let query = baseQuery.limit(batchSize);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), '批次查詢資料');
        snap.forEach(doc => rows.push({ id:doc.id, ...doc.data() }));
        if (snap.size < batchSize) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return rows;
}

function systemAuditProductKey(record = {}) {
    return String(record.productKey || record.productId || '').trim();
}

const TEST_DATA_RESET_DELETE_COLLECTIONS = [
    'orders','purchaseOrders','procurementDemands','supplyOrders','inventoryReservations','inventoryLots','inventoryLotCosts',
    'receipts','customerReturnReceipts','dispatchRecords','deliveries','inventoryMovements','auditLogs','receivingSupplyOrders'
];
// Immutable operational evidence cannot be partially deleted by the client.
const TEST_DATA_RESET_PROTECTED_COLLECTIONS = ['stockTransfers','stockTransferRequests','stockOperations'];
async function assertClientTestResetSafe() {
    for (const name of TEST_DATA_RESET_PROTECTED_COLLECTIONS) {
        const snap = await firestoreReadWithTimeout(db.collection(name).limit(1).get(), `${name} 初始化安全檢查`);
        if (!snap.empty) throw new Error('系統已有調撥或庫存交易憑證，不能使用前台初始化。請使用後端完整初始化流程，避免留下部分清除資料。');
    }
}
let testDataResetPreviewState = null;

async function countCollectionDocuments(name) {
    let count = 0, cursor = null;
    while (true) {
        let query = db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(500);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), `${name} 文件數量`);
        count += snap.size;
        if (snap.size < 500) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return count;
}

async function deleteCollectionInBatches(name, onProgress) {
    let deleted = 0;
    while (true) {
        const snap = await firestoreReadWithTimeout(
            db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(300).get(),
            `${name} 清除批次`
        );
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted += snap.size;
        if (onProgress) onProgress(deleted);
        if (snap.size < 300) break;
    }
    return deleted;
}

async function resetStockCollection(name, status) {
    let cursor = null, updated = 0;
    while (true) {
        let query = db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(300);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), `${name} 庫存歸零批次`);
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(doc => batch.set(doc.ref, {
            onHand:0, reserved:0, available:0, incoming:0, shortage:0,
            updatedAt:new Date().toISOString(), resetBy:currentUser.uid
        }, {merge:true}));
        await batch.commit();
        updated += snap.size;
        if (status) status.textContent = `庫存歸零中：${name} ${updated} 筆…`;
        if (snap.size < 300) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return updated;
}

window.previewTestDataReset = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有真正的管理員可以執行系統初始化。');
    const button=document.getElementById('testDataResetPreviewBtn');
    const preview=document.getElementById('testDataResetPreview');
    const wrap=document.getElementById('testDataResetConfirmWrap');
    const status=document.getElementById('testDataResetStatus');
    if(!button||button.disabled)return;
    button.disabled=true;if(wrap)wrap.style.display='none';if(status)status.textContent='';
    try{
        testDataResetPreviewState=null;
        await assertClientTestResetSafe();
        const counts={};
        for(const name of ['quotes',...TEST_DATA_RESET_DELETE_COLLECTIONS,'forecasts','inventory','warehouseStocks']){
            if(preview)preview.textContent=`正在檢查 ${name}…`;
            counts[name]=await countCollectionDocuments(name);
        }
        const forecasts=await readCollectionInBatches('forecasts');
        let progressCount=0;
        for(const forecast of forecasts){
            progressCount += await countCollectionDocuments(`forecasts/${forecast.id}/progress`);
        }
        counts.forecastProgress=progressCount;
        testDataResetPreviewState={counts,checkedAt:new Date().toISOString()};
        const deleteTotal=TEST_DATA_RESET_DELETE_COLLECTIONS.reduce((sum,name)=>sum+(counts[name]||0),0)+(counts.forecasts||0)+progressCount;
        if(preview)preview.textContent=
            `待永久刪除：${deleteTotal} 筆營運文件\n`+
            `Forecast ${counts.forecasts||0}（進度 ${progressCount}）、訂單 ${counts.orders||0}、採購單 ${counts.purchaseOrders||0}、供應／自購 ${counts.supplyOrders||0}\n`+
            `庫存交易相關 ${deleteTotal-(counts.forecasts||0)-progressCount-(counts.orders||0)-(counts.purchaseOrders||0)-(counts.supplyOrders||0)} 筆\n`+
            `另將 inventory ${counts.inventory||0} 筆、warehouseStocks ${counts.warehouseStocks||0} 筆數量歸零。\nMaster Data、帳號、角色、倉庫與系統設定保留。\n`+
            `保留估價單 ${counts.quotes||0} 筆，內容與成交狀態維持原樣；其中指向已清除 Forecast／訂單的連結將無法開啟。`;
        if(wrap)wrap.style.display='';
    }catch(err){
        console.error('檢查測試資料失敗：',err);
        if(preview)preview.textContent='檢查失敗：'+(err.message||err);
        testDataResetPreviewState=null;
    }finally{button.disabled=false;}
};

window.executeTestDataReset = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有真正的管理員可以執行系統初始化。');
    const input=document.getElementById('testDataResetConfirmInput');
    const button=document.getElementById('testDataResetExecuteBtn');
    const status=document.getElementById('testDataResetStatus');
    if(!testDataResetPreviewState)return alert('請先執行「檢查待清除資料」。');
    if((input?.value||'').trim()!=='保留估價單清除測試資料')return alert('確認文字不正確。');
    if(!confirm(`最後確認：保留 ${testDataResetPreviewState.counts.quotes||0} 筆估價單，永久清除其他測試營運資料並將庫存歸零？此操作無法復原。`))return;
    button.disabled=true;
    try{
        await assertClientTestResetSafe();
        const forecasts=await readCollectionInBatches('forecasts');
        for(let i=0;i<forecasts.length;i++){
            const forecast=forecasts[i];
            if(status)status.textContent=`清除 Forecast 進度 ${i+1}/${forecasts.length}…`;
            await deleteCollectionInBatches(`forecasts/${forecast.id}/progress`);
        }
        for(const name of TEST_DATA_RESET_DELETE_COLLECTIONS){
            if(status)status.textContent=`清除 ${name}…`;
            await deleteCollectionInBatches(name,n=>{if(status)status.textContent=`清除 ${name}：已刪除 ${n} 筆…`;});
        }
        await deleteCollectionInBatches('forecasts');
        await resetStockCollection('inventory',status);
        await resetStockCollection('warehouseStocks',status);

        forecastCache=[]; forecastHistorySearchResults=[];
        ordersCache=[]; orderHistorySearchResults=[]; pendingPurchaseCache=[]; purchasingDispatchCache=[];
        poListCache=[]; supplyReceivingCache=[]; receivingSourceOrderStatusCache=new Map(); inventoryCache=[];
        orderPaginationState=null; loadedMainPages.clear();
        testDataResetPreviewState=null;
        if(input)input.value='';
        document.getElementById('testDataResetConfirmWrap').style.display='none';
        document.getElementById('testDataResetPreview').textContent='';
        if(status)status.textContent='初始化完成：估價單已保留，其他測試營運資料已清除，庫存與分倉數量已歸零。請重新整理以更新畫面。';
    }catch(err){
        console.error('系統初始化失敗：',err);
        if(status)status.textContent='初始化中斷：'+(err.message||err)+'\n請不要繼續建立新資料，先重新檢查剩餘資料後再執行一次。';
    }finally{button.disabled=false;}
};

let systemDataAuditIssues = [];

function systemAuditItemCode(record = {}) {
    const explicit=record.manufacturerPartNo||record.itemCode||record.sku;
    if(explicit)return String(explicit);
    let key=String(record.productKey||record.productId||record.id||'');
    try { key=decodeURIComponent(key); } catch (_) {}
    if(key.includes('__'))key=key.split('__').pop();
    if(key.startsWith('code:'))return key.slice(5);
    if(key.startsWith('prd:'))return key.split(':').slice(2).join(':');
    return key;
}
function systemAuditActionLabel(issue) {
    if(issue.target?.kind==='product')return '編輯產品';
    if(issue.target?.kind==='duplicates')return '比較重複產品';
    if(issue.type.includes('找不到產品主檔'))return '查找／補建產品';
    return '查看並處理';
}
window.openSystemAuditIssue = async function(index) {
    if(trueUserRole!=='admin'||currentUserRole!=='admin')return;
    const issue=systemDataAuditIssues[index];
    if(!issue?.target)return;
    if(issue.target.kind==='product')return openProductMasterEditor(issue.target.record.id);
    let overlay=document.getElementById('systemAuditIssueOverlay');
    if(!overlay){
        overlay=document.createElement('div');overlay.id='systemAuditIssueOverlay';overlay.className='modal-overlay';
        overlay.addEventListener('click',event=>{if(event.target===overlay)overlay.classList.remove('active');});
        document.body.appendChild(overlay);
    }
    const target=issue.target,record=target.record||{},code=systemAuditItemCode(record);
    const action=(label,kind,value='')=>`<button type="button" class="btn-small" onclick="followSystemAuditShortcut(${index},'${kind}',${Number(value)||0})">${escapeHtml(label)}</button>`;
    const actions=[];
    if(target.kind==='duplicates')target.records.forEach((product,i)=>actions.push(action(`編輯 ${product.manufacturerPartNo||product.sku||product.id}（${i+1}）`,'duplicate',i)));
    if(issue.type.includes('找不到產品主檔'))actions.push(action('查找產品','product-search'),action('補建產品','product-new'));
    if(['inventory','stock','supply','demand','reservation'].includes(target.kind)&&code)actions.push(action('查看此品項庫存','inventory'));
    if(target.kind==='order')actions.push(action('開啟來源訂單','order'));
    if(target.kind==='reservation'&&(record.orderId||record.sourceId))actions.push(action('開啟來源訂單','order'));
    if(target.kind==='purchase')actions.push(action('開啟採購單追蹤','purchase'));
    if(target.kind==='supply'&&record.purchaseDocumentId)actions.push(action('開啟採購單追蹤','purchase'));
    if(target.kind==='demand'){
        if(record.sourceType==='SALES_ORDER'&&record.sourceId)actions.push(action('開啟來源訂單','order'));
        (target.supplies||[]).forEach((supply,i)=>{if(supply.purchaseDocumentId)actions.push(action(`開啟供應採購單 ${supply.internalNo||i+1}`,'demand-purchase',i));});
    }
    if(issue.type.includes('倉庫'))actions.push(action('設定倉庫','warehouses'));
    if(target.kind==='user')actions.push(action('人員管理','sales'));
    const guidance=issue.type.includes('找不到產品主檔')?'先查找是否已有正確產品；確認缺少時可補建。建立後請重新執行健康檢查，確認來源資料是否已正確連結。'
        :target.kind==='duplicates'?'逐筆比較產品資料，確認保留的產品後，可在產品管理停用重複品項。'
        :target.kind==='product'?'修改後請重新執行健康檢查。'
        :'先核對下列來源資料，再開啟對應畫面處理；沒有提供編輯入口的關聯異常，需要確認原因後修正。';
    const rows=target.kind==='duplicates'?target.records:[record,...(target.supplies||[])];
    const fields=[['id','紀錄識別碼'],['brand','廠牌'],['brandName','廠牌'],['itemCode','貨號'],['manufacturerPartNo','貨號'],['itemName','品名'],['productName','品名'],['productKey','產品識別碼'],['productId','產品識別碼'],['orderId','來源訂單'],['sourceId','來源識別碼'],['demandId','採購需求'],['purchaseDocumentId','採購單'],['warehouseId','倉庫'],['requestedQty','需求量'],['orderedQty','已採購數量'],['qty','數量'],['receivedQty','已到貨'],['onHand','現有量'],['reserved','預留量']];
    overlay.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="資料健康處理" style="max-width:780px;max-height:85vh;overflow:auto;"><div style="display:flex;justify-content:space-between;gap:12px;"><h3>${escapeHtml(issue.type)}</h3><button type="button" class="btn-secondary" onclick="document.getElementById('systemAuditIssueOverlay').classList.remove('active')">關閉</button></div><p>${escapeHtml(issue.detail)}</p><p>${escapeHtml(guidance)}</p><div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;">${actions.join('')}</div>${rows.map(row=>`<div class="table-wrap"><table><tbody>${fields.filter(([key])=>row[key]!==undefined&&row[key]!==null&&String(row[key])!=='').map(([key,label])=>`<tr><th>${escapeHtml(label)}</th><td style="overflow-wrap:anywhere;">${escapeHtml(String(row[key]))}</td></tr>`).join('')}</tbody></table></div>`).join('')}<p style="font-size:12px;color:#666;">資料為本次檢查的快照。完成後回到資料健康，重新檢查即可確認結果。</p></div>`;
    overlay.classList.add('active');
};
window.followSystemAuditShortcut = async function(index,kind,recordIndex=0) {
    if(trueUserRole!=='admin'||currentUserRole!=='admin')return;
    const issue=systemDataAuditIssues[index];if(!issue?.target)return;
    const target=issue.target,record=target.record||{},code=systemAuditItemCode(record);
    try{
        if(kind==='duplicate')await openProductMasterEditor(target.records[recordIndex]?.id);
        else if(kind==='product-new')populateProductMasterEditor({}, {source:'MANUAL',brand:record.brandName||record.brand||'',itemCode:code,itemName:record.productName||record.itemName||''});
        else if(kind==='product-search'){
            if(!code){showActionFeedback('來源未記錄貨號，請在產品頁用廠牌或品名查找。','warning');}
            switchMainTab('product-system',document.querySelector('[data-main-nav="products"]'));
            document.getElementById('productManagementSearch').value=code||record.itemName||record.productName||'';
            if(document.getElementById('productManagementSearch').value)await searchProductManagement();
        }else if(kind==='inventory'){
            switchMainTab('inventory-system',document.querySelector('[data-main-nav="inventory"]'));
            await switchInventoryWorkView(false);
            ['inventoryBrandFilter','inventoryPolicyFilter'].forEach(id=>{document.getElementById(id).value='';});
            document.getElementById('inventoryStateFilter').value='all';
            document.getElementById('inventorySearch').value=code;
            await runInventoryUnifiedSearchNow();
        }else if(kind==='order'){
            const id=target.kind==='order'?record.id:record.orderId||record.sourceId;
            const snap=await firestoreReadWithTimeout(db.collection('orders').doc(id).get(),'讀取來源訂單');
            if(!snap.exists)throw new Error('來源訂單已不存在，請核對檢查結果中的來源識別碼。');
            ordersCache=ordersCache.filter(row=>row.id!==id).concat({id:snap.id,...snap.data()});
            openDeliveryModal(id);
        }else if(kind==='purchase'||kind==='demand-purchase'){
            const id=kind==='demand-purchase'?target.supplies[recordIndex]?.purchaseDocumentId:target.kind==='purchase'?record.id:record.purchaseDocumentId;
            await openPurchaseOrderTimeline(id);
        }else if(kind==='warehouses'||kind==='sales'){
            switchAdminTab(kind,document.getElementById(`admin-sub-${kind}`));
        }else return;
        document.getElementById('systemAuditIssueOverlay')?.classList.remove('active');
    }catch(err){showActionFeedback('無法開啟處理畫面：'+(err.message||err),'warning');}
};

window.runSystemDataAudit = async function() {
    if (trueUserRole !== 'admin') return;
    const button = document.getElementById('systemDataAuditBtn');
    const status = document.getElementById('systemDataAuditStatus');
    const results = document.getElementById('systemDataAuditResults');
    if (!button || !status || !results || button.disabled) return;
    button.disabled = true;
    button.textContent = '檢查中…';
    status.textContent = '讀取主檔與關聯資料中…';
    results.innerHTML = '';
    systemDataAuditIssues = [];
    document.getElementById('systemAuditIssueOverlay')?.classList.remove('active');
    try {
        const [products, users, warehouses, orders, purchaseOrders, procurementDemands, supplyOrders, inventory, warehouseStocks, reservations] = await Promise.all([
            readCollectionInBatches('products'),
            readCollectionInBatches('users'),
            readCollectionInBatches('warehouses'),
            readCollectionInBatches('orders'),
            readCollectionInBatches('purchaseOrders'),
            readCollectionInBatches('procurementDemands'),
            readCollectionInBatches('supplyOrders'),
            readCollectionInBatches('inventory'),
            readCollectionInBatches('warehouseStocks'),
            readCollectionInBatches('inventoryReservations')
        ]);
        const issues = [];
        const productIds = new Set();
        const productCodes = new Set();
        const duplicateProducts = new Map();
        products.forEach(product => {
            const id = String(product.productId || product.id || '').trim();
            if (id) productIds.add(id);
            const brand = String(product.brandName || product.brand || '').trim();
            const rawCode = String(product.manufacturerPartNo || product.itemCode || product.sku || '').trim();
            const code = normalizeItemCodeLoose(rawCode);
            const name = String(product.productName || product.nameCn || product.nameEn || '').trim();
            const label = [brand || '未設定廠牌', rawCode || id || '未設定貨號'].join(' / ');
            if (!brand) issues.push({ target:{kind:'product',record:product}, type:'產品主檔缺少廠牌', detail:label });
            if (!rawCode) issues.push({ target:{kind:'product',record:product}, type:'產品主檔缺少貨號', detail:label });
            if (!name) issues.push({ target:{kind:'product',record:product}, type:'產品主檔缺少品名', detail:label });
            if (code) productCodes.add(code);
            const duplicateKey = normalizeBrandLookupKey(brand) + '|' + code;
            if (code) {
                const list = duplicateProducts.get(duplicateKey) || [];
                list.push(product);
                duplicateProducts.set(duplicateKey, list);
            }
        });
        duplicateProducts.forEach((list, key) => {
            if (list.length > 1) issues.push({ target:{kind:'duplicates',records:list}, type:'產品主檔重複', detail:`${key}：${list.length} 筆` });
        });

        const validRoles = new Set(['admin','sales','purchaser','warehouse','engineer']);
        users.forEach(user => {
            if (!validRoles.has(String(user.role || ''))) issues.push({ target:{kind:'user',record:user}, type:'人員角色異常', detail:`${user.name || user.email || user.id}：${user.role || '未設定'}` });
        });

        const orderIds = new Set(orders.map(order => String(order.id || '').trim()).filter(Boolean));
        const warehouseIds = new Set(warehouses.filter(w => w.active !== false).map(w => String(w.warehouseId || w.id || '').trim()).filter(Boolean));
        const knownProduct = record => {
            const key = systemAuditProductKey(record);
            const code = normalizeItemCodeLoose(record.itemCode || record.manufacturerPartNo || '');
            return !key && !code ? true : (productIds.has(key) || productCodes.has(code));
        };

        orders.forEach(order => {
            if(String(order.inventoryReservationStatus||'')==='failed'){
                issues.push({ target:{kind:'order',record:order},type:'訂單庫存同步失敗',detail:`${order.orderNo||order.id}｜${order.inventoryReservationError||'庫存預留未完成'}`});
            }
            const orderItems=normalizedOrderItems(order);
            if(!orderItems.length&&!knownProduct(order))issues.push({ target:{kind:'order',record:order}, type:'訂單找不到產品主檔', detail:`${order.orderNo || order.id}｜${order.itemCode || order.productKey || ''}` });
            orderItems.forEach((item,index)=>{
                if(!knownProduct(item))issues.push({ target:{kind:'order',record:order},type:'訂單品項找不到產品主檔',detail:`${order.orderNo||order.id}｜第 ${index+1} 項｜${item.itemCode||item.productId||''}`});
            });
            if ((order.fulfillmentType || '') === 'WAREHOUSE' && order.warehouseId && !warehouseIds.has(String(order.warehouseId))) {
                issues.push({ target:{kind:'order',record:order}, type:'訂單倉庫不存在', detail:`${order.orderNo || order.id}｜${order.warehouseId}` });
            }
        });

        const supplyIds = new Set(supplyOrders.map(row => String(row.id || '').trim()).filter(Boolean));
        const orderById = new Map(orders.map(order => [String(order.id || '').trim(), order]));
        const demandById = new Map(procurementDemands.map(demand => [String(demand.demandId || '').trim(), demand]).filter(([id]) => id));
        const suppliesByDemand = new Map();
        supplyOrders.forEach(supply => {
            const demandId=String(supply.demandId||'').trim();
            if(!demandId)return;
            const rows=suppliesByDemand.get(demandId)||[];
            rows.push(supply);
            suppliesByDemand.set(demandId,rows);
        });

        procurementDemands.forEach(demand => {
            const demandId=String(demand.demandId||'').trim();
            const sourceType=String(demand.sourceType||'').trim();
            const sourceId=String(demand.sourceId||'').trim();
            const sourceItemId=String(demand.sourceItemId||'').trim();
            const requested=Math.max(0,Number(demand.requestedQty||0));
            const ordered=Math.max(0,Number(demand.orderedQty||0));
            const received=Math.max(0,Number(demand.receivedQty||0));
            if(!demandId)issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求缺少識別碼', detail:demand.id || '未知文件' });
            const linkedSupplies=suppliesByDemand.get(demandId)||[];
            if(demandId&&linkedSupplies.length&&globalThis.YushinProcurementDemand?.reconcileLinkedSupplies){
                const linkedProjection=globalThis.YushinProcurementDemand.reconcileLinkedSupplies(demand,linkedSupplies);
                if(Math.abs(linkedProjection.orderedQty-ordered)>1e-9||Math.abs(linkedProjection.receivedQty-received)>1e-9){
                    issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]},
                        type:'採購需求與供應紀錄不同步',
                        detail:`${demandId}｜採購需求已採購 ${ordered}／已到 ${received}；供應紀錄回推已採購 ${linkedProjection.orderedQty}／已到 ${linkedProjection.receivedQty}`
                    });
                }
            }
            if(received>ordered||ordered>requested){
                issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求數量異常', detail:`${demandId || demand.id}｜需求 ${requested}／已採購 ${ordered}／已到 ${received}` });
            }
            if(sourceType==='SALES_ORDER'){
                const sourceOrder=orderById.get(sourceId);
                if(!sourceOrder){
                    issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求來源訂單不存在', detail:`${demandId || demand.id}｜${sourceId || '未指定'}` });
                }else if(sourceItemId&&!normalizedOrderItems(sourceOrder).some(item=>String(item.itemId||'')===sourceItemId)){
                    issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求來源品項不存在', detail:`${demandId || demand.id}｜${sourceId}／${sourceItemId}` });
                }
            }else if(sourceType==='STOCK_REPLENISHMENT'&&!knownProduct(demand)){
                issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'補庫需求找不到產品主檔', detail:`${demandId || demand.id}｜${demand.itemCode || demand.productKey || sourceId}` });
            }
        });

        purchaseOrders.forEach(po => {
            const itemOrderIds=[...new Set(purchaseItemsFromSavedPo(po).map(item=>String(item.orderId||'').trim()).filter(Boolean))];
            itemOrderIds.forEach(sourceOrderId => {
                if (!orderIds.has(sourceOrderId)) issues.push({ target:{kind:'purchase',record:po}, type:'採購單文件來源訂單不存在', detail:`${po.poNo || po.id}｜${sourceOrderId}` });
            });
            (Array.isArray(po.supplyOrderIds)?po.supplyOrderIds:[]).forEach(supplyId => {
                const id=String(supplyId||'').trim();
                if(id&&!supplyIds.has(id))issues.push({ target:{kind:'purchase',record:po}, type:'採購單文件找不到供應紀錄', detail:`${po.poNo || po.id}｜${id}` });
            });
        });

        supplyOrders.forEach(supply => {
            const sourceOrderId=String(supply.orderId||'').trim();
            const demandId=String(supply.demandId||'').trim();
            if(!demandId)issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄缺少採購需求', detail:`${supply.internalNo || supply.id}｜未記錄 demandId` });
            else if(!demandById.has(demandId))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄找不到採購需求', detail:`${supply.internalNo || supply.id}｜${demandId}` });
            if(sourceOrderId&&!orderIds.has(sourceOrderId))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄來源訂單不存在', detail:`${supply.internalNo || supply.id}｜${sourceOrderId}` });
            if(!knownProduct(supply))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄找不到產品主檔', detail:`${supply.internalNo || supply.id}｜${supply.itemCode || supply.productKey || ''}` });
            const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
            const warehouseId=String(supply.warehouseId||'').trim();
            if(!directShip&&(!warehouseId||!warehouseIds.has(warehouseId)))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄倉庫異常', detail:`${supply.internalNo || supply.id}｜${warehouseId || '未指定'}` });
            const qty=Math.max(0,Number(supply.qty||0));
            const received=Math.max(0,Number(supply.receivedQty||0));
            if(!(qty>0)||received>qty)issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄數量異常', detail:`${supply.internalNo || supply.id}｜採購數量 ${qty}／已到 ${received}` });
        });

        inventory.forEach(item => {
            // inventory 只保留產品索引／總覽快取；實際數量以 warehouseStocks 為準。
            // 健康檢查不可再把 aggregate cache 的 onHand / reserved 當成正式庫存錯誤。
            if (!knownProduct(item)) issues.push({ target:{kind:'inventory',record:item}, type:'庫存索引找不到產品主檔', detail:`${item.itemCode || item.id}` });
            const policy=String(item.stockPolicy||'ORDER_ONLY').toUpperCase();
            const safetyStock=Number(item.safetyStock||0);
            if(!Object.values(INVENTORY_STOCK_POLICIES).includes(policy)){
                issues.push({ target:{kind:'inventory',record:item}, type:'庫存策略異常', detail:`${item.itemCode || item.id}｜${policy || '未設定'}` });
            }else if(policy===INVENTORY_STOCK_POLICIES.SAFETY_STOCK && !(safetyStock>0)){
                issues.push({ target:{kind:'inventory',record:item}, type:'安全庫存設定異常', detail:`${item.itemCode || item.id}｜安全庫存 ${safetyStock}` });
            }else if(policy!==INVENTORY_STOCK_POLICIES.SAFETY_STOCK && safetyStock>0){
                issues.push({ target:{kind:'inventory',record:item}, type:'庫存策略與安全庫存不一致', detail:`${item.itemCode || item.id}｜${inventoryStockPolicyLabel(policy)}／安全庫存 ${safetyStock}` });
            }
        });

        warehouseStocks.forEach(stock => {
            if (stock.warehouseId && !warehouseIds.has(String(stock.warehouseId))) issues.push({ target:{kind:'stock',record:stock}, type:'分倉指向不存在倉庫', detail:`${stock.id}｜${stock.warehouseId}` });
            if (!knownProduct(stock)) issues.push({ target:{kind:'stock',record:stock}, type:'分倉找不到產品主檔', detail:`${stock.id}` });
            const n = inventoryNumbers(stock);
            if (n.onHand < 0 || n.reserved < 0 || n.reserved > n.onHand) issues.push({ target:{kind:'stock',record:stock}, type:'分倉數量異常', detail:`${stock.id}｜現有 ${n.onHand}／預留 ${n.reserved}` });
        });

        reservations.filter(r => r.status === 'active').forEach(reservation => {
            const orderId = String(reservation.orderId || reservation.sourceId || reservation.id || '').trim();
            if (orderId && !orderIds.has(orderId)) issues.push({ target:{kind:'reservation',record:reservation}, type:'庫存預留來源訂單不存在', detail:`${reservation.orderNo || reservation.id}｜${orderId}` });
            if (!knownProduct(reservation)) issues.push({ target:{kind:'reservation',record:reservation}, type:'庫存預留找不到產品主檔', detail:`${reservation.orderNo || reservation.id}｜${reservation.productKey || reservation.itemCode || ''}` });
        });

        const counts = `Product ${products.length}、人員 ${users.length}、訂單 ${orders.length}、採購單文件 ${purchaseOrders.length}、採購需求 ${procurementDemands.length}、供應紀錄 ${supplyOrders.length}、庫存索引 ${inventory.length}、分倉 ${warehouseStocks.length}、預留 ${reservations.length}`;
        status.textContent = issues.length ? `檢查完成：${counts}。發現 ${issues.length} 項需確認。` : `檢查完成：${counts}。未發現上述關聯異常。`;
        systemDataAuditIssues = issues;
        results.innerHTML = issues.length
            ? '<div class="table-wrap"><table><thead><tr><th>類型</th><th>內容</th><th>處理</th></tr></thead><tbody>' + issues.slice(0,500).map((issue,index) => `<tr><td>${escapeHtml(issue.type)}</td><td>${escapeHtml(issue.detail)}</td><td><button type="button" class="btn-small" onclick="openSystemAuditIssue(${index})">${escapeHtml(systemAuditActionLabel(issue))}</button></td></tr>`).join('') + '</tbody></table></div>' + (issues.length > 500 ? `<div style="font-size:12px;color:#666;margin-top:6px;">畫面只顯示前 500 項，共 ${issues.length} 項。</div>` : '')
            : '<div style="padding:10px;background:#f4f8f4;border-radius:6px;">目前未發現需要處理的資料關聯異常。</div>';
    } catch (err) {
        console.error('系統資料檢查失敗：', err);
        status.textContent = '檢查失敗：' + err.message;
    } finally {
        button.disabled = false;
        button.textContent = '執行資料檢查';
    }
};

window.previewInventoryCostMigration = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有管理員可以執行庫存成本隔離。');
    const status=document.getElementById('inventoryCostMigrationStatus'), runButton=document.getElementById('inventoryCostMigrationBtn'), previewButton=document.getElementById('inventoryCostMigrationPreviewBtn');
    if(previewButton)previewButton.disabled=true;if(runButton)runButton.disabled=true;if(status)status.innerText='正在分頁掃描舊庫存成本欄位…';
    try{
        // Array.map 會額外傳入 index；不可直接把 readCollectionForMigration 當 callback，
        // 否則第一個集合會把 index 0 誤當 pageSize，造成 Firestore limit(0) 失敗。
        const [lots,inventory,receipts,movements,orders,warehouseStocks]=await Promise.all(
            ['inventoryLots','inventory','receipts','inventoryMovements','orders','warehouseStocks']
                .map(name => readCollectionForMigration(name))
        );
        const plan=inventoryCostMigrationPlan(lots,inventory,receipts,movements,orders,warehouseStocks);window._inventoryCostMigrationPlan=plan;
        const total=plan.legacyLots.length+plan.legacyInventory.length+plan.legacyWarehouseStocks.length+plan.legacyReceipts.length+plan.legacyMovements.length+plan.legacyOrders.length;
        if(status)status.innerText=`預覽完成：批次成本 ${plan.legacyLots.length}、庫存文件 ${plan.legacyInventory.length}、分倉成本 ${plan.legacyWarehouseStocks.length}、收貨 ${plan.legacyReceipts.length}、異動 ${plan.legacyMovements.length}、舊訂單成本 ${plan.legacyOrders.length}。\n`+(total?'請先執行「庫存成本隔離」，完成後再部署新版 Firestore Rules。':'沒有發現舊成本欄位，可直接進行新版 Rules 驗證。');
        if(runButton)runButton.disabled=total===0;
    }catch(err){console.error('庫存成本隔離預覽失敗：',err);if(status)status.innerText='預覽失敗：'+(err.message||err);}
    finally{if(previewButton)previewButton.disabled=false;}
};
window.runInventoryCostMigration = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有管理員可以執行庫存成本隔離。');
    const plan=window._inventoryCostMigrationPlan;if(!plan)return alert('請先按「預覽庫存成本隔離」。');
    if(!confirm('確定執行庫存成本隔離？\n\n舊 inventoryLots 成本會搬到 inventoryLotCosts；公開庫存、收貨與異動文件中的成本欄位會移除。此步驟應在部署新版 Firestore Rules 前完成。'))return;
    const status=document.getElementById('inventoryCostMigrationStatus'),runButton=document.getElementById('inventoryCostMigrationBtn'),previewButton=document.getElementById('inventoryCostMigrationPreviewBtn');
    if(runButton)runButton.disabled=true;if(previewButton)previewButton.disabled=true;
    const del=firebase.firestore.FieldValue.delete(),ops=[],now=new Date().toISOString(),by=currentUser?.uid||'';
    plan.legacyLots.forEach(row=>{const d=row.data;ops.push(batch=>batch.set(db.collection('inventoryLotCosts').doc(row.id),{lotId:row.id,productKey:d.productKey||'',productId:d.productId||'',warehouseId:d.warehouseId||'',unitCost:Number(d.unitCost||0),sourceType:d.sourceType||'LEGACY_MIGRATION',sourceId:d.sourceId||'',migratedAt:now,migratedBy:by},{merge:true}));ops.push(batch=>batch.update(row.ref,{unitCost:del,costMigratedAt:now}));});
    plan.legacyInventory.forEach(row=>{const patch={costSanitizedAt:now};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.cost!==undefined)patch.cost=del;if(Array.isArray(row.data.lots))patch.lots=row.data.lots.map(lot=>{if(!lot||typeof lot!=='object')return lot;const {unitCost,cost,...rest}=lot;return rest;});ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyWarehouseStocks.forEach(row=>{const patch={costSanitizedAt:now};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.cost!==undefined)patch.cost=del;ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyReceipts.forEach(row=>{const patch={costSanitizedAt:now};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.purchaseNetAmount!==undefined)patch.purchaseNetAmount=del;ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyMovements.forEach(row=>{const patch={costSanitizedAt:now,costPending:true};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.purchaseNetAmount!==undefined)patch.purchaseNetAmount=del;if(row.data.cogs!==undefined)patch.cogs=del;ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyOrders.forEach(row=>{
        const sanitizeRecord=record=>{
            if(!record||typeof record!=='object')return record;
            const {cogs,...rest}=record;
            if(Array.isArray(rest.lotAllocations)) rest.lotAllocations=rest.lotAllocations.map(allocation=>{
                if(!allocation||typeof allocation!=='object')return allocation;
                const {cost,unitCost,...safe}=allocation;
                return safe;
            });
            return rest;
        };
        ops.push(batch=>batch.update(row.ref,{
            deliveryRecords:(row.data.deliveryRecords||[]).map(sanitizeRecord),
            returnRecords:(row.data.returnRecords||[]).map(sanitizeRecord),
            costSanitizedAt:now
        }));
    });
    try{if(status)status.innerText=`正在隔離 ${ops.length} 筆寫入，請不要關閉頁面…`;await commitMigrationBatch(ops);window._inventoryCostMigrationPlan=null;if(status)status.innerText='庫存成本隔離完成。正在重新檢查…';await window.previewInventoryCostMigration();}
    catch(err){console.error('庫存成本隔離失敗：',err);if(status)status.innerText='隔離中斷：'+(err.message||err)+'。流程可重複執行。';if(runButton)runButton.disabled=false;}
    finally{if(previewButton)previewButton.disabled=false;}
};
// Product Master 以單一標準 Excel 作為人工維護入口；匯入時依 productId 增量新增／更新，不刪除未出現在檔案中的產品。
function setPriceUploadProgress(percent, status, keepVisible = true) {
    const wrap = document.getElementById('priceUploadProgress');
    const statusEl = document.getElementById('priceUploadStatus');
    const percentEl = document.getElementById('priceUploadPercent');
    const bar = document.getElementById('priceUploadProgressBar');
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    if (wrap && statusEl && percentEl && bar) {
        wrap.style.display = keepVisible ? '' : 'none';
        statusEl.innerText = status;
        percentEl.innerText = `${safePercent}%`;
        bar.style.width = `${safePercent}%`;
    }
    const batchStatus = document.getElementById('productBatchMaintenanceStatus');
    if (batchStatus) {
        batchStatus.textContent = status ? `${status} ${safePercent}%` : '';
        batchStatus.style.color = /失敗|錯誤|中斷/.test(String(status || '')) ? '#b42318' : '#12502b';
    }
}

const PRODUCT_MASTER_IMPORT_FIELDS = [
    'productId','brandId','brandName','manufacturerPartNo','normalizedPartNo','productName','nameEn',
    'productLine','productLineId','category','productType','specification','unit','listPrice',
    'inventoryTracked','lotTracked','expiryTracked','status','active','source'
];

function productImportValueEqual(field, currentValue, nextValue) {
    if (field === 'listPrice') return Number(currentValue || 0) === Number(nextValue || 0);
    if (['inventoryTracked','lotTracked','expiryTracked','active'].includes(field)) return !!currentValue === !!nextValue;
    return String(currentValue ?? '') === String(nextValue ?? '');
}

// 只核對本次匯入的文件；正式儲存仍重新讀取，避免沿用過期預覽。

async function loadExistingProductImportState(productIds = [], costProductIds = []) {
    const uniqueProductIds = [...new Set((productIds || []).map(id => String(id || '').trim()).filter(Boolean))];
    const uniqueCostProductIds = [...new Set((costProductIds || []).map(id => String(id || '').trim()).filter(Boolean))];
    const existingProducts = new Map();
    const existingCosts = new Map();

    // 每次最多四個查詢，每個查詢最多 30 個指定 ID，避免大量檔案串行等待或無限制併發。
    for (const [collectionName, requestedIds, target, label] of [
        ['products', uniqueProductIds, existingProducts, '產品匯入產品比對'],
        ['productCosts', uniqueCostProductIds, existingCosts, '產品匯入成本比對']
    ]) {
        for (let offset = 0; offset < requestedIds.length; offset += 120) {
            const queries = [];
            for (let i = offset; i < Math.min(offset + 120, requestedIds.length); i += 30) {
                const ids = requestedIds.slice(i, i + 30);
                queries.push(firestoreReadWithTimeout(
                    db.collection(collectionName).where(firebase.firestore.FieldPath.documentId(), 'in', ids).get(),
                    label
                ));
            }
            const results = await Promise.all(queries);
            results.forEach(snapshot => snapshot.docs.forEach(doc => target.set(doc.id, doc.data() || {})));
        }
    }
    return { existingProducts, existingCosts };
}

// 匯入以廠牌＋貨號辨識產品，沿用雲端文件 ID，成本與訂單引用才能指向同一筆。
async function resolveProductImportIdentities(items) {
    const codeFor = item => normalizeItemCodeLoose(item.model || item.manufacturerPartNo || item.sku || '');
    const rows = items.filter(item => item.model || item.manufacturerPartNo || item.sku);
    if (!rows.length) return;
    const keyFor = item => normalizeBrandLookupKey(resolveBrandName(item.brand || item.brandName || '')) + '::' + codeFor(item);
    const seen = new Set();
    rows.forEach(item => {
        const key = keyFor(item);
        if (seen.has(key)) throw new Error(`貨號「${item.model || item.sku}」在檔案中重複出現（忽略大小寫與符號）。尚未寫入產品或成本。`);
        seen.add(key);
    });
    const codes = [...new Set(rows.map(codeFor))];
    const matches = new Map();
    for (let offset = 0; offset < codes.length; offset += 120) {
        const queries = [];
        for (let i = offset; i < Math.min(offset + 120, codes.length); i += 30) {
            queries.push(firestoreReadWithTimeout(
                db.collection('products').where('normalizedPartNo', 'in', codes.slice(i, i + 30)).get(),
                '產品匯入廠牌與貨號比對'
            ));
        }
        const snapshots = await Promise.all(queries);
        snapshots.forEach(snapshot => snapshot.docs.forEach(doc => {
            const data = doc.data() || {};
            const key = keyFor(data);
            if (!matches.has(key)) matches.set(key, new Map());
            matches.get(key).set(doc.id, data);
        }));
    }
    rows.forEach(item => {
        const candidates = matches.get(keyFor(item));
        if (candidates?.size > 1) throw new Error(`廠牌「${item.brand}」貨號「${item.model || item.sku}」已有 ${candidates.size} 筆產品，無法決定成本應更新哪一筆。請先核對重複產品；本次尚未寫入產品或成本。`);
        if (candidates?.size === 1) item.productId = candidates.keys().next().value;
    });
}

async function syncImportedBrandToFormalProductMaster(imported, storedBrand) {
    const canWriteFormalMaster = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    if (!canWriteFormalMaster) return { productWrites:0, costWrites:0, unchangedRows:0 };

    const normalizedItems = normalizeProductMasterList((imported || []).map(item => ({ ...item, brand: storedBrand })));
    await resolveProductImportIdentities(normalizedItems);
    const productIds = [...new Set(normalizedItems.map(item => item.productId).filter(Boolean))];
    const costProductIds = [...new Set(normalizedItems.filter(item => item.standardCostProvided === true).map(item => item.productId).filter(Boolean))];
    const { existingProducts, existingCosts } = await loadExistingProductImportState(productIds, costProductIds);

    const now = new Date().toISOString();
    const updatedBy = currentUser?.uid || '';
    const operations = [];
    let productWrites = 0;
    let costWrites = 0;
    let unchangedRows = 0;

    normalizedItems.forEach(item => {
        const product = productMasterRecordFromItem(item, 'PRODUCT_IMPORT');
        product.status = item.active === false ? 'INACTIVE' : 'ACTIVE';
        product.active = product.status === 'ACTIVE';
        // 建議售價是選填欄位：匯入既有產品時留白代表「不變更」，
        // 新產品留白則不建立 listPrice，避免把未知價格寫成 0。
        if (item.listPriceProvided !== true) delete product.listPrice;

        const existingProduct = existingProducts.get(product.productId);
        let productPatch = null;
        if (!existingProduct) {
            productPatch = product;
        } else {
            const changed = {};
            PRODUCT_MASTER_IMPORT_FIELDS.forEach(field => {
                if (field === 'listPrice' && item.listPriceProvided !== true) return;
                if (!productImportValueEqual(field, existingProduct[field], product[field])) changed[field] = product[field];
            });
            if (Object.keys(changed).length) productPatch = { ...changed, updatedAt:now, updatedBy };
        }

        if (activeProductImportBatch && productPatch) productPatch = { ...(productPatch || {}), lastImportBatch:activeProductImportBatch.id, lastImportFile:activeProductImportBatch.file, lastImportedAt:activeProductImportBatch.date };
        let costPatch = null;
        if (item.standardCostProvided === true) {
            const standardCost = Number(item.standardCost);
            const existingCost = existingCosts.get(product.productId);
            const nextCost = {
                productId: product.productId,
                productLineId: product.productLineId || product.productLine || '',
                standardCost,
                salesVisible: false
            };
            const changedCost = {};
            Object.keys(nextCost).forEach(field => {
                const current = existingCost?.[field];
                const next = nextCost[field];
                const equal = field === 'standardCost' ? Number(current ?? NaN) === Number(next) : String(current ?? '') === String(next ?? '');
                if (!equal) changedCost[field] = next;
            });
            if (!existingCost || Object.keys(changedCost).length) {
                costPatch = {
                    ...(existingCost ? changedCost : nextCost),
                    source:'PRODUCT_IMPORT',
                    updatedAt:now,
                    updatedBy
                };
            }
        }

        if (!productPatch && !costPatch) {
            unchangedRows += 1;
            return;
        }
        if (productPatch) productWrites += 1;
        if (costPatch) costWrites += 1;
        operations.push(batch => {
            if (productPatch) batch.set(db.collection('products').doc(product.productId), productPatch, { merge:true });
            if (costPatch) batch.set(db.collection('productCosts').doc(product.productId), costPatch, { merge:true });
        });
    });

    await commitMigrationBatch(operations, 200);
    return { productWrites, costWrites, unchangedRows, items:normalizedItems };
}

async function saveProductMasterBrand(imported, brand) {
    brand = resolveBrandName(brand);
    if (!brandMasterEntryForName(brand)) {
        if (currentUserRole === 'admin') {
            await upsertBrandMaster(brand, { active:true });
        } else {
            throw new Error(`廠牌「${brand}」尚未建立廠牌主檔，請先由管理員建立廠牌。`);
        }
    }
    const normalizedItems = normalizeProductMasterList((imported || []).map(item => ({ ...item, brand })));
    const syncResult = await syncImportedBrandToFormalProductMaster(normalizedItems, brand);
    (syncResult.items || normalizedItems).map(productItemWithoutCost).forEach(item => cacheProductLookupItem(item));
    return { brand, ...syncResult };
}


let pendingPriceImportPreview = null;

async function summarizeProductMasterImport(groups, errors = []) {
    const rows = groups.flatMap(group => group.imported.map(raw => normalizeProductMasterItem({ ...raw, brand: group.brand })));
    await resolveProductImportIdentities(rows);
    const uniqueProductIds = [...new Set(rows.map(item => String(item.productId || '').trim()).filter(Boolean))];
    const costProductIds = [...new Set(rows.filter(item => item.standardCostProvided === true).map(item => String(item.productId || '').trim()).filter(Boolean))];
    const { existingProducts, existingCosts } = await loadExistingProductImportState(uniqueProductIds, costProductIds);

    const labels = {
        brandId:'廠牌', brandName:'廠牌', manufacturerPartNo:'貨號', normalizedPartNo:'貨號',
        productName:'中文品名', nameEn:'英文品名', specification:'規格',
        productLine:'產品線', productLineId:'產品線', productType:'產品類型', category:'產品類型',
        unit:'單位', listPrice:'建議售價', inventoryTracked:'庫存管理',
        lotTracked:'批號管理', expiryTracked:'效期管理', status:'啟用狀態', active:'啟用狀態'
    };
    const groupStats = new Map();
    const details = [];
    let added = 0, updated = 0, unchanged = 0, inactive = 0;

    rows.forEach(item => {
        const product = productMasterRecordFromItem(item, 'PRODUCT_IMPORT');
        product.status = item.active === false ? 'INACTIVE' : 'ACTIVE';
        product.active = product.status === 'ACTIVE';
        if (item.listPriceProvided !== true) delete product.listPrice;
        if (!item.active) inactive += 1;

        const existingProduct = existingProducts.get(product.productId);
        const changedFields = [];
        if (existingProduct) {
            PRODUCT_MASTER_IMPORT_FIELDS.forEach(field => {
                if (field === 'listPrice' && item.listPriceProvided !== true) return;
                if (!productImportValueEqual(field, existingProduct[field], product[field])) {
                    const label = labels[field] || field;
                    if (!changedFields.includes(label)) changedFields.push(label);
                }
            });
        }

        if (item.standardCostProvided === true) {
            const existingCost = existingCosts.get(product.productId);
            const nextCost = Number(item.standardCost);
            if (!existingCost || Number(existingCost.standardCost ?? NaN) !== nextCost) {
                changedFields.push('標準成本');
            }
        }

        let action = '不變';
        if (!existingProduct) {
            action = '新增';
            added += 1;
        } else if (changedFields.length) {
            action = '更新';
            updated += 1;
        } else {
            unchanged += 1;
        }

        const groupKey = normalizeBrandLookupKey(item.brand) + '::' + String(item.productLine || '').toLocaleLowerCase();
        if (!groupStats.has(groupKey)) {
            groupStats.set(groupKey, {
                brand:item.brand || '',
                productLine:item.productLine || '',
                count:0, added:0, updated:0, unchanged:0
            });
        }
        const stats = groupStats.get(groupKey);
        stats.count += 1;
        if (action === '新增') stats.added += 1;
        else if (action === '更新') stats.updated += 1;
        else stats.unchanged += 1;

        details.push({
            action,
            brand:item.brand || '',
            productLine:item.productLine || '',
            code:item.model || item.manufacturerPartNo || '',
            name:item.nameCn || item.nameEn || '',
            changedFields
        });
    });

    return {
        total:rows.length,
        added,
        updated,
        unchanged,
        inactive,
        costRows:rows.filter(item => item.standardCostProvided === true).length,
        errorCount:errors.length,
        errors:[...errors],
        brands:[...groupStats.values()],
        details
    };
}

async function confirmProductMasterImport(groups, errors = []) {
    if (errors.length) {
        const errorLines = errors.slice(0, 10).map((message, index) => `錯誤 ${index + 1}｜${message}`);
        const moreErrors = errors.length - errorLines.length;
        setPriceUploadProgress(0, `匯入檔有 ${errors.length} 筆錯誤；尚未讀取或寫入雲端。`, false);
        alert([
            '產品匯入檢查',
            '',
            ...errorLines,
            moreErrors > 0 ? `…另有 ${moreErrors} 筆錯誤未展開` : '',
            '',
            '有錯誤的匯入檔不會寫入雲端。請修正 Excel 後重新選擇檔案。'
        ].filter(Boolean).join('\n'));
        return false;
    }
    setPriceUploadProgress(62, '正在比對現有產品主檔，產生匯入差異預覽…');
    const summary = await summarizeProductMasterImport(groups, errors);
    pendingPriceImportPreview = summary;

    const groupLines = summary.brands.map(item =>
        `${item.brand} / ${item.productLine || '未分類'}：${item.count} 筆（新增 ${item.added}／更新 ${item.updated}／不變 ${item.unchanged}）`
    );
    const changedLines = summary.details
        .filter(item => item.action !== '不變')
        .slice(0, 15)
        .map(item => `${item.action}｜${item.brand} ${item.code || item.name || '未命名'}${item.changedFields.length ? '｜' + item.changedFields.join('、') : ''}`);
    const errorLines = summary.errors.slice(0, 10).map((message, index) => `錯誤 ${index + 1}｜${message}`);
    const moreChanged = summary.details.filter(item => item.action !== '不變').length - changedLines.length;
    const moreErrors = summary.errorCount - errorLines.length;

    const preview = [
        '產品匯入預覽（差異預覽）',
        '',
        ...groupLines,
        '',
        `合計 ${summary.total} 筆：新增 ${summary.added}／更新 ${summary.updated}／不變 ${summary.unchanged}／錯誤 ${summary.errorCount}`,
        `停用標記 ${summary.inactive} 筆；${summary.costRows} 筆含標準成本。`,
        '產品資料與建議售價寫入 products；標準成本寫入受保護的 productCosts。',
        '實際採購價、歷史訂單與庫存批次成本不會被覆蓋。',
        changedLines.length ? '' : null,
        changedLines.length ? '變更明細：' : null,
        ...changedLines,
        moreChanged > 0 ? `…另有 ${moreChanged} 筆變更未展開` : null,
        errorLines.length ? '' : null,
        errorLines.length ? '錯誤明細：' : null,
        ...errorLines,
        moreErrors > 0 ? `…另有 ${moreErrors} 筆錯誤未展開` : null
    ].filter(line => line !== null).join('\n');

    if (summary.errorCount > 0) {
        setPriceUploadProgress(0, `匯入預覽發現 ${summary.errorCount} 筆錯誤；未寫入任何資料。`, false);
        alert(preview + '\n\n有錯誤的匯入檔不會寫入雲端。請修正 Excel 後重新選擇檔案。');
        return false;
    }

    return confirm(preview + '\n\n確認後才會寫入雲端；未出現在檔案中的產品不會被刪除或停用。確定執行匯入嗎？');
}

// Preserve formatted identifiers without converting numeric prices or costs to display text.
function isProductImportPlaceholderCode(value) {
    const key = String(value || '').normalize('NFKC').trim().toLocaleLowerCase()
        .replace(/\s*\/\s*/g, '/')
        .replace(/\s+/g, ' ');
    return key === 'not available/custom item';
}

function normalizeImportedProductCode(brand, value) {
    const code = String(value ?? '').normalize('NFKC').trim();
    if (!code) return '';
    const canonicalBrand = normalizeBrandLookupKey(resolveBrandName(brand || ''));
    // Roche material numbers are 11 digits. Excel commonly stores a leading-zero code
    // as a number, turning e.g. 03654672103 into 3654672103 before import.
    if (canonicalBrand === normalizeBrandLookupKey('Roche') && /^\d{10}$/.test(code)) return `0${code}`;
    return code;
}

function productImportSheetRows(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval:'', raw:true });
    const displayed = XLSX.utils.sheet_to_json(sheet, { defval:'', raw:false });
    const identifierHeaders = new Set(['貨號', '型號', 'catno.', 'catno', 'catalogno.', 'catalogno']);
    return rows.map((row, index) => {
        const result = { ...row };
        Object.keys(row).forEach(header => {
            const key = String(header).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
            if (!identifierHeaders.has(key)) return;
            const raw = row[header];
            const formatted = String(displayed[index]?.[header] ?? '').trim();
            result[header] = typeof raw === 'number'
                ? (/^\d+$/.test(formatted) ? formatted : String(raw))
                : String(raw ?? '').trim();
        });
        return result;
    });
}

window.downloadProductMasterTemplate = async function() {
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }
    const headers = ['廠牌','產品線','貨號','中文品名','英文品名','規格','產品類型','單位','建議售價（含稅）','標準成本（含稅）','啟用','庫存管理','批號管理','效期管理'];
    const example = ['Beckman Coulter','Centrifuge','EXAMPLE-001','範例中文品名','Example Product','96 tests','Consumable','EA','1000','600','是','是','否','否'];
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    ws.C2.z = '@';
    ws['!cols'] = [22,20,18,28,32,24,14,10,16,16,10,12,12,12].map(wch => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '產品資料');
    XLSX.writeFile(wb, '又鑫_Product_Import.xlsx');
};
window.downloadProductPriceUpdateTemplate = async function() {
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }
    const ws = XLSX.utils.aoa_to_sheet([
        ['貨號','建議售價（含稅）'],
        ['EXAMPLE-001','1200']
    ]);
    ws.A2.z = '@';
    ws['!cols'] = [{ wch:20 }, { wch:18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '價格更新');
    XLSX.writeFile(wb, '廠牌名稱-價格更新.xlsx');
};

window.downloadProductCostUpdateTemplate = async function() {
    if (!canManagePendingProductMaster()) return;
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }
    const ws = XLSX.utils.aoa_to_sheet([
        ['貨號','標準成本（含稅）'],
        ['EXAMPLE-001','600']
    ]);
    ws.A2.z = '@';
    ws['!cols'] = [{ wch:20 }, { wch:18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '成本更新');
    XLSX.writeFile(wb, '廠牌名稱-成本更新.xlsx');
};

window.handleProductPriceExcelUpload = async function(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!(currentUserRole === 'admin' || currentUserRole === 'purchaser')) {
        alert('只有管理員或採購可以批次更新建議售價。');
        input.value = '';
        return;
    }
    if (productBatchMaintenanceInProgress) {
        input.value = '';
        return;
    }
    setProductBatchMaintenanceBusy(true);
    try {
        await ensureXlsxLoaded();
        setPriceUploadProgress(5, '讀取建議售價更新檔…');
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(buffer), { type:'array' });
        const brand = String(file.name || '')
            .replace(/-價格更新.(xlsx|xls)$/i, '')
            .replace(/.(xlsx|xls)$/i, '')
            .normalize('NFKC').trim();
        if (!brand) throw new Error('請將檔名設為「廠牌名稱-價格更新.xlsx」。');

        const normalizeHeader = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
        const rows = [];
        workbook.SheetNames.forEach(sheetName => {
            productImportSheetRows(workbook.Sheets[sheetName]).forEach(row => {
                const entries = Object.entries(row);
                const find = names => {
                    const wanted = new Set(names.map(normalizeHeader));
                    const pair = entries.find(([key]) => wanted.has(normalizeHeader(key)));
                    return pair ? pair[1] : '';
                };
                const code = String(find(['貨號','型號','Cat No.','Catalog No.'])).trim();
                const rawPrice = find(['建議售價（含稅）','建議售價','含稅單價','單價','價格']);
                if (!code && String(rawPrice).trim() === '') return;
                const price = Number(String(rawPrice).replace(/,/g,'').trim());
                if (!code || !Number.isFinite(price) || price < 0) {
                    throw new Error(`價格更新檔有無效資料：貨號「${code || '空白'}」、價格「${rawPrice}」。`);
                }
                rows.push({ code, price });
            });
        });
        if (!rows.length) throw new Error('檔案中沒有可更新的貨號與建議售價。');

        const deduped = [...new Map(rows.map(row => [normalizeItemCodeLoose(row.code), row])).values()];
        setPriceUploadProgress(25, `核對 ${deduped.length} 個貨號…`);
        const resolved = [];
        const missing = [];
        for (let i = 0; i < deduped.length; i += 10) {
            const chunk = deduped.slice(i, i + 10);
            const codes = chunk.map(row => normalizeItemCodeLoose(row.code));
            const snap = await firestoreReadWithTimeout(
                db.collection('products').where('normalizedPartNo', 'in', codes).get(),
                '批次建議售價貨號核對'
            );
            const docs = snap.docs.map(doc => ({ id:doc.id, ...doc.data() }));
            chunk.forEach(row => {
                const normalizedCode = normalizeItemCodeLoose(row.code);
                const matches = docs.filter(doc =>
                    normalizeItemCodeLoose(doc.manufacturerPartNo || doc.sku || '') === normalizedCode &&
                    normalizeBrandLookupKey(doc.brandName || doc.brand || '') === normalizeBrandLookupKey(brand)
                );
                if (matches.length === 1) resolved.push({ product:matches[0], price:row.price });
                else missing.push(row.code);
            });
        }
        if (missing.length) {
            throw new Error(`有 ${missing.length} 個貨號找不到「${brand}」唯一產品主檔：${missing.slice(0,10).join('、')}${missing.length > 10 ? '…' : ''}。未寫入任何資料。`);
        }

        const changed = resolved.filter(({product, price}) => Number(product.listPrice || 0) !== price);
        if (!changed.length) {
            setPriceUploadProgress(100, '檔案中的建議售價都已是最新值。');
            input.value = '';
            return;
        }
        if (!confirm(`建議售價增量更新\n\n廠牌：${brand}\n檔案共 ${deduped.length} 筆\n實際需要更新 ${changed.length} 筆\n\n只會修改這些產品的 listPrice，不會動品名、規格、分類或其他產品。確定更新嗎？`)) {
            setPriceUploadProgress(0, '已取消，未修改資料。', false);
            input.value = '';
            return;
        }

        const now = new Date().toISOString();
        const operations = changed.map(({product, price}) => batch => {
            batch.set(db.collection('products').doc(product.id || product.productId), {
                listPrice:price,
                updatedAt:now,
                updatedBy:currentUser?.uid || ''
            }, { merge:true });
        });
        setPriceUploadProgress(60, `更新 ${changed.length} 筆建議售價…`);
        await commitMigrationBatch(operations);

        changed.forEach(({product, price}) => {
            const id = product.id || product.productId;
            const cached = priceList.find(item => (item.productId || '') === id);
            if (cached) cached.price = price;
            const result = productManagementResults.find(item => (item.productId || item.id) === id);
            if (result) result.listPrice = price;
        });
        rebuildPriceItemLookup();
        if (productManagementResults.length) renderProductManagementResults();
        setPriceUploadProgress(100, `完成：已更新 ${changed.length} 筆建議售價；其他產品主檔未變更。`);
        input.value = '';
    } catch (err) {
        console.error('建議售價增量更新失敗：', err);
        const message = productOperationErrorMessage('建議售價更新（' + file.name + '）', err)
            + (err.totalOperations ? ` 已確認完成 ${err.committedOperations}／${err.totalOperations} 筆；其餘結果待確認。請重新匯入同一檔案，系統會核對後更新。` : '');
        setPriceUploadProgress(0, message);
        alert(message);
        input.value = '';
    } finally {
        setProductBatchMaintenanceBusy(false);
    }
};


window.handleProductCostExcelUpload = async function(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!canManagePendingProductMaster()) {
        alert('只有管理員或採購可以批次更新產品成本。');
        input.value = '';
        return;
    }
    if (productBatchMaintenanceInProgress) {
        input.value = '';
        return;
    }
    setProductBatchMaintenanceBusy(true);
    try {
        await ensureXlsxLoaded();
        setPriceUploadProgress(5, '讀取成本更新檔…');
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(buffer), { type:'array' });
        const brand = String(file.name || '')
            .replace(/-成本更新\.(xlsx|xls)$/i, '')
            .replace(/\.(xlsx|xls)$/i, '')
            .normalize('NFKC').trim();
        if (!brand) throw new Error('請將檔名設為「廠牌名稱-成本更新.xlsx」。');

        const normalizeHeader = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
        const rows = [];
        workbook.SheetNames.forEach(sheetName => {
            productImportSheetRows(workbook.Sheets[sheetName]).forEach(row => {
                const entries = Object.entries(row);
                const find = names => {
                    const wanted = new Set(names.map(normalizeHeader));
                    const pair = entries.find(([key]) => wanted.has(normalizeHeader(key)));
                    return pair ? pair[1] : '';
                };
                const code = String(find(['貨號','型號','Cat No.','Catalog No.'])).trim();
                const rawCost = find(['標準成本（含稅）','標準成本','含稅成本','成本','進貨成本']);
                if (!code && String(rawCost).trim() === '') return;
                const cost = Number(String(rawCost).replace(/,/g,'').trim());
                if (!code || !Number.isFinite(cost) || cost < 0) {
                    throw new Error(`成本更新檔有無效資料：貨號「${code || '空白'}」、成本「${rawCost}」。`);
                }
                rows.push({ code, cost });
            });
        });
        if (!rows.length) throw new Error('檔案中沒有可更新的貨號與標準成本。');

        const deduped = [...new Map(rows.map(row => [normalizeItemCodeLoose(row.code), row])).values()];
        setPriceUploadProgress(25, `核對 ${deduped.length} 個貨號…`);
        const resolved = [];
        const missing = [];
        for (let i = 0; i < deduped.length; i += 10) {
            const chunk = deduped.slice(i, i + 10);
            const codes = chunk.map(row => normalizeItemCodeLoose(row.code));
            const snap = await firestoreReadWithTimeout(
                db.collection('products').where('normalizedPartNo', 'in', codes).get(),
                '批次產品成本貨號核對'
            );
            const docs = snap.docs.map(doc => ({ id:doc.id, ...doc.data() }));
            chunk.forEach(row => {
                const normalizedCode = normalizeItemCodeLoose(row.code);
                const matches = docs.filter(doc =>
                    normalizeItemCodeLoose(doc.manufacturerPartNo || doc.sku || '') === normalizedCode &&
                    normalizeBrandLookupKey(doc.brandName || doc.brand || '') === normalizeBrandLookupKey(brand)
                );
                if (matches.length === 1) resolved.push({ product:matches[0], cost:row.cost });
                else missing.push(row.code);
            });
        }
        if (missing.length) {
            throw new Error(`有 ${missing.length} 個貨號找不到「${brand}」唯一產品主檔：${missing.slice(0,10).join('、')}${missing.length > 10 ? '…' : ''}。未寫入任何成本資料。`);
        }

        const existingCosts = new Map();
        for (let i = 0; i < resolved.length; i += 10) {
            const ids = resolved.slice(i, i + 10).map(({product}) => product.id || product.productId);
            const snap = await firestoreReadWithTimeout(
                db.collection('productCosts')
                    .where(firebase.firestore.FieldPath.documentId(), 'in', ids)
                    .get(),
                '既有產品成本核對'
            );
            snap.docs.forEach(doc => existingCosts.set(doc.id, doc.data() || {}));
        }
        const changed = resolved.filter(({product, cost}) => {
            const id = product.id || product.productId;
            return Number(existingCosts.get(id)?.standardCost ?? NaN) !== cost;
        });
        if (!changed.length) {
            setPriceUploadProgress(100, '檔案中的標準成本都已是最新值。');
            input.value = '';
            return;
        }
        if (!confirm(`產品成本增量更新\n\n廠牌：${brand}\n檔案共 ${deduped.length} 筆\n實際需要更新 ${changed.length} 筆\n\n只會修改 productCosts 的 standardCost，不會修改產品主檔、建議售價或歷史訂單。確定更新嗎？`)) {
            setPriceUploadProgress(0, '已取消，未修改成本資料。', false);
            input.value = '';
            return;
        }

        const now = new Date().toISOString();
        const operations = changed.map(({product, cost}) => batch => {
            const productId = product.id || product.productId;
            batch.set(db.collection('productCosts').doc(productId), {
                productId,
                productLineId: product.productLineId || product.productLine || '',
                standardCost: cost,
                salesVisible: false,
                source: 'COST_UPDATE',
                updatedAt: now,
                updatedBy: currentUser?.uid || ''
            }, { merge:true });
        });
        setPriceUploadProgress(60, `更新 ${changed.length} 筆標準成本…`);
        await commitMigrationBatch(operations);
        visibleProductCostCache.clear();
        setPriceUploadProgress(100, `完成：已更新 ${changed.length} 筆標準成本；產品主檔與建議售價未變更。`);
        input.value = '';
    } catch (err) {
        console.error('產品成本增量更新失敗：', err);
        const message = productOperationErrorMessage('產品成本更新（' + file.name + '）', err)
            + (err.totalOperations ? ` 已確認完成 ${err.committedOperations}／${err.totalOperations} 筆；其餘結果待確認。請重新匯入同一檔案，系統會核對後更新。` : '');
        setPriceUploadProgress(0, message);
        alert(message);
        input.value = '';
    } finally {
        setProductBatchMaintenanceBusy(false);
    }
};

window.handlePriceExcelUpload = async function(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const requestedBrand = pendingPriceListUploadBrand;
    pendingPriceListUploadBrand = '';
    if (brandProductDeleteRunning) {
        alert('正在處理價目表，請完成後再匯入。');
        input.value = '';
        return;
    }
    if (!(currentUserRole === 'admin' || currentUserRole === 'purchaser')) {
        alert('只有管理員或採購可以匯入產品主檔。');
        input.value = '';
        return;
    }

    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        input.value = '';
        return;
    }
    if (productMasterMigrationRunning) {
        input.value = '';
        return;
    }
    productMasterMigrationRunning = true;
    setProductBatchMaintenanceBusy(true);

    setPriceUploadProgress(0, '準備讀取產品匯入…');
    const reader = new FileReader();
    reader.onprogress = function(event) {
        if (!event.lengthComputable) return;
        // 檔案讀取階段使用 0～50%，保留後半段顯示資料整理與同一廠牌多產品線的雲端儲存進度。
        setPriceUploadProgress((event.loaded / event.total) * 50, '讀取 Excel 檔案中…');
    };
    reader.onload = async function(e) {
        try {
            setPriceUploadProgress(55, '正在整理產品、售價與標準成本…');
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            const normalizePriceHeader = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
            const getField = (row, keys) => {
                for (const k of keys) {
                    if (row[k] !== undefined && row[k] !== '') return row[k];
                }
                const wanted = new Set(keys.map(normalizePriceHeader));
                const matchedKey = Object.keys(row).find(key => wanted.has(normalizePriceHeader(key)));
                if (matchedKey !== undefined && row[matchedKey] !== '') return row[matchedKey];
                return '';
            };

            // 全形英數字／空白轉半形，避免輸入法不小心切到全形模式時，
            // 「Ｂiorad」和「Biorad」被系統誤判成兩個不同的廠牌。
            const toHalfWidth = (str) => String(str || '')
                .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
                .replace(/\u3000/g, ' ')
                .trim();

            // 標準格式以欄位為主。廠牌空白仍可由檔名補；產品線為選填，
            // 不從分頁名稱自動推導，避免沒有產品線的廠牌被誤分類。
            const fallbackBrand = toHalfWidth(String(file.name || '').replace(/\.(xlsx|xls)$/i, '').replace(/^(Product Master|Product Import|又鑫_Product_Import)$/i, ''));
            const brandGroupsMap = new Map();
            const seenProductIds = new Set();
            const importErrors = [];
            let skippedPlaceholderRows = 0;
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                const rows = productImportSheetRows(sheet);

                rows.forEach(row => {
                    const nameCn = String(getField(row, ['中文品名', '品名', '中文名稱'])).trim();
                    const nameEn = String(getField(row, ['英文品名', '英文名稱'])).trim();
                    const rawModel = String(getField(row, ['貨號', '型號'])).trim();
                    if (!rawModel) return;
                    if (isProductImportPlaceholderCode(rawModel)) {
                        skippedPlaceholderRows += 1;
                        return;
                    }

                    const rawBrand = toHalfWidth(getField(row, ['廠牌', '品牌', 'Brand']) || fallbackBrand);
                    const brand = resolveBrandName(rawBrand);
                    if (!brand) { importErrors.push(`貨號「${rawModel}」缺少廠牌。請填寫「廠牌」欄位。`); return; }
                    const model = normalizeImportedProductCode(brand, rawModel);
                    const productLine = toHalfWidth(getField(row, ['產品線', 'Product Line', 'ProductLine']));

                    const productType = normalizeProductTypeValue(getField(row, ['類型', '產品類型', '品項類型', '機器/耗材', '仪器/耗材', 'Type']));
                    const spec = String(getField(row, ['規格', '规格', 'Spec', 'Specification'])).trim();
                    const unit = String(getField(row, ['單位', 'Unit', 'UOM'])).trim();
                    const activeRaw = String(getField(row, ['啟用', '启用', 'Active', 'Status'])).trim().toLocaleLowerCase();
                    const yes = value => ['1', 'true', 'yes', 'y', '是', '啟用', '启用'].includes(String(value || '').trim().toLocaleLowerCase());
                    const inventoryTracked = yes(getField(row, ['庫存管理', '库存管理', 'Inventory Tracked', 'Inventory']));
                    const lotTracked = yes(getField(row, ['批號管理', '批号管理', 'Lot Tracked', 'Lot']));
                    const expiryTracked = yes(getField(row, ['效期管理', 'Expiry Tracked', 'Expiry']));

                    const priceRaw = getField(row, ['建議售價（含稅）', '建議售價', '含稅單價', '單價', '價格']);
                    const listPriceProvided = String(priceRaw ?? '').trim() !== '';
                    const price = listPriceProvided ? Number(String(priceRaw).replace(/,/g, '').trim()) : null;
                    if (listPriceProvided && (!Number.isFinite(price) || price < 0)) { importErrors.push(`貨號「${model}」的建議售價格式不正確。`); return; }

                    const standardCostRaw = getField(row, ['標準成本（含稅）', '標準成本', '含稅成本', '成本', '進貨成本']);
                    const standardCostProvided = String(standardCostRaw ?? '').trim() !== '';
                    const standardCost = standardCostProvided ? Number(String(standardCostRaw).replace(/,/g, '').trim()) : null;
                    if (standardCostProvided && (!Number.isFinite(standardCost) || standardCost < 0)) { importErrors.push(`貨號「${model}」的標準成本格式不正確。`); return; }

                    const importedItem = {
                        nameCn, nameEn, model, brand, productType, productLine, spec, unit,
                        inventoryTracked, lotTracked, expiryTracked,
                        active: activeRaw ? !['0','false','no','n','否','停用'].includes(activeRaw) : true,
                        price, listPriceProvided, standardCost, standardCostProvided, source:'PRODUCT_IMPORT'
                    };
                    const importProductId = stableProductId(importedItem);
                    if (seenProductIds.has(importProductId)) { importErrors.push(`貨號「${model}」在檔案中重複出現。每個廠牌／貨號請只保留一列。`); return; }
                    seenProductIds.add(importProductId);
                    const groupKey = `${normalizeBrandLookupKey(brand)}::${productLine.toLocaleLowerCase()}`;
                    if (!brandGroupsMap.has(groupKey)) brandGroupsMap.set(groupKey, { brand, productLine, imported:[] });
                    brandGroupsMap.get(groupKey).imported.push(importedItem);
                });
            });
            const brandGroups = [...brandGroupsMap.values()];

            if (requestedBrand) {
                const requestedKey = normalizeBrandLookupKey(resolveBrandName(requestedBrand));
                const unexpected = brandGroups.filter(group => normalizeBrandLookupKey(resolveBrandName(group.brand)) !== requestedKey);
                if (unexpected.length) {
                    setPriceUploadProgress(0, `檔案廠牌與「${requestedBrand}」不一致，尚未寫入雲端。`, false);
                    alert(`你是從「${requestedBrand}」點選上傳新版，但檔案內包含其他廠牌：${[...new Set(unexpected.map(group => group.brand))].join('、')}。\n\n請確認檔案後重新上傳。`);
                    input.value = '';
                    return;
                }
            }

            if (!brandGroups.length && !importErrors.length) {
                setPriceUploadProgress(0, '找不到可上傳的產品資料。');
                alert('無法從 Excel 辨識出有效資料。請確認每筆產品至少有廠牌與貨號。');
                input.value = '';
                return;
            }

            if (!await confirmProductMasterImport(brandGroups, importErrors)) {
                setPriceUploadProgress(0, '已取消，尚未寫入雲端。', false);
                input.value = '';
                return;
            }

            activeProductImportBatch = { id:`import-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, file:file.name, date:new Date().toISOString() };
            const savedBrands = [];
            const imported = brandGroups.flatMap(group => group.imported);
            const itemsByBrand = new Map();
            imported.forEach(item => {
                const key = normalizeBrandLookupKey(item.brand);
                if (!itemsByBrand.has(key)) itemsByBrand.set(key, { brand:item.brand, items:[] });
                itemsByBrand.get(key).items.push(item);
            });

            let savedCount = 0;
            let totalProductWrites = 0;
            let totalCostWrites = 0;
            let totalUnchangedRows = 0;
            const priceListMetadataWarnings = [];
            for (const { brand, items } of itemsByBrand.values()) {
                setPriceUploadProgress(70 + (savedCount / Math.max(1, itemsByBrand.size)) * 20, `正在儲存「${brand}」的 ${items.length} 筆產品／售價／成本…`);
                const saveResult = await saveProductMasterBrand(items, brand);
                const storedBrand = saveResult.brand;
                try {
                    await markPriceListImportComplete(storedBrand, items.length, saveResult);
                } catch (metadataErr) {
                    console.warn('價目表版本紀錄寫入失敗：', storedBrand, metadataErr);
                    priceListMetadataWarnings.push(`${storedBrand}：${metadataErr?.message || metadataErr}`);
                }
                totalProductWrites += saveResult.productWrites;
                totalCostWrites += saveResult.costWrites;
                totalUnchangedRows += saveResult.unchangedRows;
                const normalizedImported = saveResult.items || normalizeProductMasterList(items.map(item => ({ ...item, brand: storedBrand })));
                const visibleImported = normalizedImported.map(productItemWithoutCost);

                // 以 productId 增量合併本機快取。只上傳幾筆時，不可把同廠牌其他產品從目前畫面暫時移除。
                // 建議售價留白時，雲端與本機快取都保留既有售價，避免畫面暫時變成 0／空白。
                const merged = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
                visibleImported.forEach(item => {
                    const id = item.productId || stableProductId(item);
                    const previous = merged.get(id);
                    if (item.listPriceProvided !== true && previous) {
                        merged.set(id, { ...previous, ...item, price:previous.price });
                    } else {
                        merged.set(id, item);
                    }
                });
                priceList = [...merged.values()];

                const lineCount = new Set(items.map(item => item.productLine || '')).size;
                savedBrands.push(`${storedBrand}（${items.length} 筆／${lineCount} 個產品線；產品寫入 ${saveResult.productWrites}、成本寫入 ${saveResult.costWrites}）`);
                savedCount += 1;
            }

            if (totalCostWrites) {
                invalidateVisibleProductCosts();
                purchaseCostCache.clear();
            }
            refreshPriceDatalists();
            renderCompanyAgencyBrandSettings();
            loadProductManagementOverview();
            const skippedText = skippedPlaceholderRows ? `；略過無正式貨號 ${skippedPlaceholderRows} 筆` : '';
            setPriceUploadProgress(100, `完成：檢查 ${imported.length} 筆；產品寫入 ${totalProductWrites}、標準成本寫入 ${totalCostWrites}、完全無變動 ${totalUnchangedRows} 筆${skippedText}。`);
            alert(`產品匯入完成：\n${savedBrands.join('\n')}\n\n已記錄本次匯入批次；未出現在檔案中的產品不會被刪除或停用。標準成本與實際採購價分開保存。${skippedPlaceholderRows ? `\n已略過「Not Available/Custom Item」等無正式貨號列：${skippedPlaceholderRows} 筆。` : ''}${priceListMetadataWarnings.length ? `\n\n注意：產品資料已匯入，但以下價目表版本紀錄失敗：\n${priceListMetadataWarnings.join('\n')}` : ''}`);
        } catch (err) {
            setPriceUploadProgress(0, '儲存雲端失敗，請稍後再試。');
            alert('上傳失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
        } finally {
            activeProductImportBatch = null;
            productMasterMigrationRunning = false;
            setProductBatchMaintenanceBusy(false);
            input.value = '';
        }
    };
    reader.onerror = function() {
        productMasterMigrationRunning = false;
        setProductBatchMaintenanceBusy(false);
        setPriceUploadProgress(0, '讀取 Excel 檔案失敗。');
        alert('讀取 Excel 檔案失敗，請重新選擇檔案。');
        input.value = '';
    };
    reader.readAsArrayBuffer(file);
};


// ===== 2026-10-02：手機功能選單自動收合 =====
window.collapseMobileMainNav = function() {
    const nav = document.querySelector('.nav-tabs');
    if (!nav?.classList.contains('mobile-open')) return;
    nav.classList.remove('mobile-open');
    const toggle = nav.querySelector('.mobile-nav-toggle');
    toggle?.setAttribute('aria-expanded', 'false');
    toggle?.setAttribute('aria-label', '開啟功能選單');
};

(function bindMobileMainNavAutoCollapse() {
    const nav = document.querySelector('.nav-tabs');
    const app = document.getElementById('appContainer');
    if (!nav || !app) return;

    document.addEventListener('pointerdown', event => {
        if (!nav.classList.contains('mobile-open')) return;
        if (nav.contains(event.target)) return;
        collapseMobileMainNav();
    }, { passive:true });

    app.addEventListener('scroll', () => {
        if (nav.classList.contains('mobile-open')) collapseMobileMainNav();
    }, { passive:true });
})();

window.configureDocumentDownloadFolder = async function(kind) {
    try { await window.DocumentDownloads.choose(kind); }
    catch (err) { if(err.name !== 'AbortError') alert('設定下載資料夾失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。'); }
};
window.resetDocumentDownloadFolder = async function(kind) {
    try { await window.DocumentDownloads.reset(kind); }
    catch (err) { alert('重設下載資料夾失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。'); }
};

