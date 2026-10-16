let forecastLoading = false;
let forecastSaveInProgress = false;
let forecastProgressSaveInProgress = false;

function forecastStatusLabel(status) {
    return ({ active: '進行中', won: 'Win', lost: 'Lost' })[status] || status || '進行中';
}

function forecastStageLabel(stage) {
    return ({
        stage1: 'Stage 1',
        stage2: 'Stage 2',
        stage3: 'Stage 3',
        stage4: 'Stage 4',
        stage5: 'Stage 5'
    })[stage] || '未設定';
}

function forecastTodayLabel(date = new Date()) {
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${mm}/${dd}`;
}

function forecastNowIso() {
    return new Date().toISOString();
}

function buildForecastProgressText(text, fallback = '立案') {
    const content = String(text || '').trim() || fallback;
    return `${forecastTodayLabel()} ${content}`;
}

function normalizeForecastBrand(value) {
    return resolveBrandName(value);
}

let forecastBrandFilterSignature = '';
let forecastSalesFilterSignature = '';

function populateForecastBrandFilter() {
    const select = document.getElementById('forecastBrandFilter');
    if (!select) return [];

    const current = select.value;
    const brands = getPrimaryBrandNames();
    const signature = JSON.stringify(brands);
    if (signature !== forecastBrandFilterSignature) {
        select.innerHTML = '<option value="">全部廠牌</option>' + brands.map(brand =>
            `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`
        ).join('') + `<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
        forecastBrandFilterSignature = signature;
    }

    if (brands.includes(current) || current === OTHER_BRAND_OPTION_KEY) select.value = current;
    else if (current) select.value = '';
    return brands;
}

function forecastOwnSalesName() {
    return stripPhoneSuffix(currentUserName || '').trim();
}

function forecastSalesCodeForName(name) {
    const normalizedName = stripPhoneSuffix(name || '').trim();
    if (!normalizedName) return '';
    if (normalizedName === forecastOwnSalesName() && currentUserCode) return String(currentUserCode);
    const match = salesList.find(person =>
        String(person.role || 'sales').toLowerCase() === 'sales'
        && stripPhoneSuffix(person.name || '') === normalizedName
        && person.active !== false
    );
    return String(match?.code || '');
}

function populateForecastSalesFilter() {
    const select = document.getElementById('forecastSalesFilter');
    if (!select) return;

    const canSeeAll = canViewAllData('forecast');
    const ownName = forecastOwnSalesName();

    if (!canSeeAll) {
        const label = ownName || '我的案件';
        const signature = JSON.stringify(['own', ownName, label]);
        if (signature !== forecastSalesFilterSignature) {
            select.innerHTML = `<option value="${escapeAttr(ownName)}">${escapeHtml(label)}</option>`;
            forecastSalesFilterSignature = signature;
        }
        select.value = ownName;
        select.disabled = true;
        return;
    }

    const current = select.value;
    const names = new Set();

    salesList
        .filter(person => String(person.role || 'sales').toLowerCase() === 'sales' && person.active !== false)
        .forEach(person => {
            const name = stripPhoneSuffix(person.name || '');
            if (name) names.add(name);
        });

    const forecastRows = forecastHistorySearchActive ? forecastHistorySearchResults : forecastCache;
    forecastRows.forEach(item => {
        const name = stripPhoneSuffix(item.salesName || '');
        if (name) names.add(name);
    });

    select.disabled = false;
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const signature = JSON.stringify(['all', sortedNames]);

    if (signature !== forecastSalesFilterSignature) {
        select.innerHTML = '<option value="">全部負責業務</option>' + sortedNames.map(name =>
            `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`
        ).join('');
        forecastSalesFilterSignature = signature;
    }

    if ([...select.options].some(option => option.value === current)) select.value = current;
    else select.value = '';
}

window.handleForecastStatusFilterChange = function() {
    loadForecasts(true);
};

window.handleForecastSalesFilterChange = function() {
    loadForecasts(true);
};

window.handleForecastBrandFilterChange = function() {
    renderForecastList();
};

function populateForecastBrandDropdown(selectedBrand = '') {
    const select = document.getElementById('forecastBrand');
    if (!select) return;

    const selected = normalizeForecastBrand(selectedBrand);
    populateBrandSelect(select, '請選擇廠牌', true, getPrimaryBrandNames());
    if (selected) selectBrandInDropdown(select, selected);
    else {
        select.value = '';
        const otherInput = document.getElementById('forecastBrandOther');
        if (otherInput) {
            otherInput.value = '';
            otherInput.style.display = 'none';
        }
    }
    onForecastBrandSelectChange();
}

window.onForecastBrandSelectChange = function() {
    const select = document.getElementById('forecastBrand');
    const otherInput = document.getElementById('forecastBrandOther');
    if (!select || !otherInput) return;
    if (select.value === '其他') {
        otherInput.style.display = '';
    } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
    }
};

let forecastReloadRequested = false;
let forecastLoadGeneration = 0;
window.loadForecasts = async function(reset = true) {
    if (!canAccessPage('forecast')) return;
    if (forecastLoading) { if (reset) { forecastReloadRequested = true; forecastLoadGeneration++; } return; }
    const generation = ++forecastLoadGeneration;
    const requestedRole = currentUserRole, requestedUid = currentUser?.uid;

    if (reset) {
        forecastCursor = null;
        forecastHasMore = true;
    }

    if (!forecastHasMore) return;

    forecastLoading = true;
    const button = document.getElementById('forecastLoadMoreBtn');

    if (button) {
        button.disabled = true;
        button.innerText = '載入中…';
    }
    try {
        if (canViewAllData('forecast')) await ensureSalesListLoaded();
        else populateForecastSalesFilter();
        if (canViewAllData('forecast')) populateForecastSalesFilter();

        const status = document.getElementById('forecastStatusFilter')?.value || 'active';
        const selectedSalesName = document.getElementById('forecastSalesFilter')?.value || '';

        let query = db.collection('forecasts').orderBy('updatedAt', 'desc');

        if (status !== 'all') {
            query = query.where('status', '==', status);
        }

        if (!canViewAllData('forecast')) {
            if (currentUserCode) query = query.where('salesCode', '==', currentUserCode);
            else query = query.where('ownerUid', '==', currentUser?.uid || '');
        } else if (selectedSalesName) {
            const selectedSalesCode = forecastSalesCodeForName(selectedSalesName);
            if (selectedSalesCode) {
                query = query.where('salesCode', '==', selectedSalesCode);
            } else if (selectedSalesName === forecastOwnSalesName() && currentUser?.uid) {
                query = query.where('ownerUid', '==', currentUser.uid);
            }
        }

        query = query.limit(DEFAULT_LIST_LIMIT);

        if (forecastCursor) {
            query = query.startAfter(forecastCursor);
        }

        const snapshot = await firestoreReadWithTimeout(query.get(), 'Forecast 清單');

        if (generation !== forecastLoadGeneration || requestedRole !== currentUserRole || requestedUid !== currentUser?.uid) return;
        if (!snapshot.empty) {
            forecastCursor = snapshot.docs[snapshot.docs.length - 1];
        }

        if (generation !== forecastLoadGeneration || requestedRole !== currentUserRole || requestedUid !== currentUser?.uid) return;
        const records = new Map((reset ? [] : forecastCache).map(item => [item.id, item]));
        snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));

        forecastCache = [...records.values()].sort(
            (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        );

        forecastHasMore = snapshot.size === DEFAULT_LIST_LIMIT;

        populateForecastBrandFilter();
        populateForecastSalesFilter();
        writeAppDataCache('forecasts', forecastCache);
        renderForecastList();
    } catch (err) {
        if (generation === forecastLoadGeneration && requestedRole === currentUserRole && requestedUid === currentUser?.uid) mainPageLoadFailed('forecast');
        console.error('讀取 Forecast 失敗', err);
        if (generation === forecastLoadGeneration && requestedRole === currentUserRole && requestedUid === currentUser?.uid) alert('讀取 Forecast 失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        forecastLoading = false;

        if (button) {
            button.disabled = false;
            button.innerText = '載入更多（每次 50 筆）';
            button.style.display = forecastHasMore ? '' : 'none';
        }
        if (forecastReloadRequested) { forecastReloadRequested = false; loadForecasts(true); }
    }
};

let forecastHistorySearchActive = false;
let forecastHistorySearchLoading = false;
let forecastHistorySearchCursor = null;
let forecastHistorySearchKeyword = '';
let forecastHistorySearchResults = [];
let forecastHistorySearchTimer = null;
let forecastHistorySearchGeneration = 0;

function updateForecastHistorySearchStatus(message = '') {
    const status = document.getElementById('forecastHistorySearchStatus');
    if (status) status.textContent = message;
}

async function runForecastHistorySearch(reset = true) {
    const input = document.getElementById('forecastSearch');
    const rawKeyword = input?.value || '';
    const normalized = normalizeFullHistorySearchValue(rawKeyword);
    const generation = ++forecastHistorySearchGeneration;
    if (!normalized) {
        forecastHistorySearchActive = false;
        forecastHistorySearchLoading = false;
        forecastHistorySearchKeyword = '';
        forecastHistorySearchResults = [];
        forecastHistorySearchCursor = null;
        updateForecastHistorySearchStatus('');
        renderForecastList();
        return;
    }
    const queryToken = fullHistoryQueryToken('forecast', rawKeyword);
    if (!queryToken) {
        forecastHistorySearchActive = false;
        forecastHistorySearchLoading = false;
        updateForecastHistorySearchStatus('目前帳號缺少可用的資料歸屬資訊，無法搜尋完整 Forecast。');
        renderForecastList();
        return;
    }

    forecastHistorySearchLoading = true;
    forecastHistorySearchActive = true;
    forecastHistorySearchKeyword = rawKeyword;
    forecastHistorySearchResults = [];
    forecastHistorySearchCursor = null;
    const records = new Map();
    let cursor = null;
    let checked = 0;
    let lastIntermediateRenderAt = 0;
    updateForecastHistorySearchStatus('正在搜尋全部 Forecast…');
    renderForecastList();

    try {
        while (true) {
            let query = scopedHistorySearchQuery('forecasts', queryToken).limit(DEFAULT_LIST_LIMIT);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), 'Forecast 索引搜尋');
            if (generation !== forecastHistorySearchGeneration) return;

            checked += snapshot.size;
            snapshot.forEach(doc => {
                const data = { id: doc.id, ...doc.data() };
                if (fullHistoryRecordMatches('forecast', data, rawKeyword)) records.set(doc.id, data);
            });
            const now = Date.now();
            if (now - lastIntermediateRenderAt >= 100 || snapshot.size < DEFAULT_LIST_LIMIT) {
                lastIntermediateRenderAt = now;
                forecastHistorySearchResults = [...records.values()].sort(
                    (a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))
                );
                renderForecastList();
            }
            updateForecastHistorySearchStatus(`全歷史搜尋中：已檢查 ${checked} 筆候選資料，找到 ${records.size} 筆…`);

            if (snapshot.size < DEFAULT_LIST_LIMIT) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
            forecastHistorySearchCursor = cursor;
            await Promise.resolve();
        }
        if (generation !== forecastHistorySearchGeneration) return;
        forecastHistorySearchCursor = null;
        forecastHistorySearchResults = [...records.values()].sort(
            (a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||''))
        );
        updateForecastHistorySearchStatus(`全歷史搜尋完成：找到 ${records.size} 筆`);
    } catch (err) {
        if (generation !== forecastHistorySearchGeneration) return;
        console.error('Forecast 全歷史搜尋失敗：', err);
        forecastHistorySearchActive = false;
        forecastHistorySearchCursor = null;
        updateForecastHistorySearchStatus('搜尋失敗；若為舊資料，請管理員確認搜尋索引已補建。');
        renderForecastList();
    } finally {
        if (generation === forecastHistorySearchGeneration) {
            forecastHistorySearchLoading = false;
            renderForecastList();
        }
    }
}

window.scheduleForecastHistorySearch = function() {
    clearTimeout(forecastHistorySearchTimer);
    const keyword = document.getElementById('forecastSearch')?.value || '';
    if (!normalizeFullHistorySearchValue(keyword)) return runForecastHistorySearch(true);
    forecastHistorySearchTimer = scheduleListSearch(forecastHistorySearchTimer, () => runForecastHistorySearch(true));
};

window.renderForecastList = function() {
    const body = document.getElementById('forecastListBody');
    if (!body) return;

    const keyword = (document.getElementById('forecastSearch')?.value || '').trim().toLocaleLowerCase();
    const brandFilter = document.getElementById('forecastBrandFilter')?.value || '';
    const selectableBrands = getPrimaryBrandNames();
    const salesFilter = document.getElementById('forecastSalesFilter')?.value || '';
    const statusFilter = document.getElementById('forecastStatusFilter')?.value || 'active';

    body.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    // 搜尋模式必須使用後端全歷史結果，不能只迭代目前載入的 50 筆 forecastCache。
    const forecastRows = forecastHistorySearchActive ? forecastHistorySearchResults : forecastCache;
    forecastRows.forEach(item => {
        const brand = normalizeForecastBrand(item.brand || '');
        const salesName = stripPhoneSuffix(item.salesName || '');

        const searchable = `
            ${item.customerName || ''}
            ${brand}
            ${item.productName || ''}
            ${item.latestProgress || ''}
            ${salesName}
            ${forecastStageLabel(item.stage)}
            ${forecastStatusLabel(item.status)}
        `.toLocaleLowerCase();

        if (!forecastHistorySearchActive && keyword && !searchable.includes(keyword)) return;
        if (brandFilter && orderBrandFilterValue(brand, selectableBrands) !== brandFilter) return;
        if (salesFilter && salesName !== salesFilter) return;
        if (item.status !== statusFilter) return;

        shown++;

        const row = document.createElement('tr');

        if (item.status === 'lost') row.classList.add('forecast-row-lost');
        if (item.status === 'won') row.classList.add('forecast-row-won');

        const statusClass = item.status === 'won'
            ? 'forecast-status-won'
            : item.status === 'lost'
                ? 'forecast-status-lost'
                : 'forecast-status-active';

        const actions = `
            <button type="button" class="btn-small btn-secondary" onclick="openForecastHistoryModal(${inlineJsValue(item.id)})">紀錄</button>
            ${canEditPage('forecast') ? `
                <button type="button" class="btn-small" onclick="openForecastProgressModal(${inlineJsValue(item.id)})">＋進度</button>
                <button type="button" class="btn-small btn-secondary" onclick="openForecastModal(${inlineJsValue(item.id)})">編輯</button>
                <button type="button" class="btn-small btn-secondary" onclick="createQuoteFromForecast(${inlineJsValue(item.id)})">轉估價</button>
                <button type="button" class="btn-small btn-secondary" onclick="createOrderFromForecast(${inlineJsValue(item.id)})">轉訂單</button>
            ` : ''}
            ${trueUserRole === 'admin' && currentUserRole === 'admin' ? `<button type="button" class="btn-small danger-menu-item" onclick="permanentlyDeleteForecast(${inlineJsValue(item.id)})">永久刪除</button>` : ''}
        `;

        const estimatedAmount = Number(item.estimatedAmount || 0);
        const updatedDate = dateOnlyFromTimestamp(item.latestProgressAt || item.updatedAt || item.createdAt)
            .replace(/-/g, '/');

        row.innerHTML = `
            <td class="forecast-mobile-summary">
                <div class="forecast-card-heading">
                    <div class="forecast-card-customer">
                        <strong>${escapeHtml(item.customerName || '')}</strong>
                        ${brand ? `<span>｜${escapeHtml(brand)}</span>` : ''}
                    </div>
                    ${estimatedAmount > 0 ? `<div class="forecast-card-amount">NT$ ${estimatedAmount.toLocaleString()}</div>` : ''}
                </div>
                <div class="forecast-card-product">${escapeHtml(item.productName || '')}</div>
                <div class="forecast-card-badges">
                    <span class="forecast-stage-badge">${escapeHtml(forecastStageLabel(item.stage))}</span>
                    <span class="forecast-status-badge ${statusClass}">${escapeHtml(forecastStatusLabel(item.status))}</span>
                </div>
                <div class="forecast-card-progress">${escapeHtml(item.latestProgress || '尚未更新進度')}</div>
                <div class="forecast-card-meta">
                    ${escapeHtml(salesName || '未指定負責業務')}${updatedDate ? ` · ${escapeHtml(updatedDate)} 更新` : ''}
                </div>
            </td>
            <td data-th="客戶" class="forecast-desktop-cell">${escapeHtml(item.customerName || '')}</td>
            <td data-th="廠牌" class="forecast-desktop-cell">${escapeHtml(brand || '')}</td>
            <td data-th="產品／品項" class="forecast-desktop-cell">${escapeHtml(item.productName || '')}</td>
            <td data-th="預估金額" class="forecast-desktop-cell">${estimatedAmount.toLocaleString()}</td>
            <td data-th="Stage" class="forecast-desktop-cell"><span class="forecast-stage-badge">${escapeHtml(forecastStageLabel(item.stage))}</span></td>
            <td data-th="狀態" class="forecast-desktop-cell"><span class="forecast-status-badge ${statusClass}">${escapeHtml(forecastStatusLabel(item.status))}</span></td>
            <td data-th="最新進度" class="forecast-progress-cell forecast-desktop-cell">${escapeHtml(item.latestProgress || '')}</td>
            <td data-th="業務" class="forecast-desktop-cell">${escapeHtml(salesName)}</td>
            <td data-th="操作" class="no-print forecast-actions"><div class="action-button-group">${actions}</div></td>
        `;

        fragment.appendChild(row);
    });
    body.appendChild(fragment);

    const hint = document.getElementById('forecastEmptyHint');
    if (hint) hint.style.display = shown ? 'none' : 'block';
};

window.openForecastModal = function(id = '') {
    if (!canCreateForecastCapability() || !canEditPage('forecast')) return;

    const item = id ? forecastCache.find(entry => entry.id === id) : null;
    const overlay = document.getElementById('forecastModalOverlay');
    if (!overlay) return;
    overlay.classList.add('active');

    document.getElementById('forecastId').value = item?.id || '';
    document.getElementById('forecastCustomer').value = item?.customerName || '';
    populateForecastBrandDropdown(item?.brand || '');
    document.getElementById('forecastProduct').value = item?.productName || '';
    document.getElementById('forecastAmount').value = item?.estimatedAmount || '';
    document.getElementById('forecastStage').value = item?.stage || 'stage1';
    document.getElementById('forecastStatus').value = item?.status || 'active';
    document.getElementById('forecastProgress').value = '';

    const workflowSection = document.getElementById('forecastWorkflowSection');
    if (workflowSection) workflowSection.style.display = item ? 'none' : '';
    const currentProgressSection = document.getElementById('forecastCurrentProgressSection');
    if (currentProgressSection) currentProgressSection.style.display = 'none';

    document.getElementById('forecastModalTitle').innerText = item ? '編輯 Forecast' : '新增 Forecast';
};

window.closeForecastModal = function() {
    document.getElementById('forecastModalOverlay')?.classList.remove('active');
};

window.saveForecast = async function() {
    if (forecastSaveInProgress || !canCreateForecastCapability() || !canEditPage('forecast')) return;

    const id = document.getElementById('forecastId').value;
    const existing = id ? forecastCache.find(item => item.id === id) : null;

    const customerName = document.getElementById('forecastCustomer').value.trim();
    const brand = normalizeForecastBrand(getBrandFieldValue('forecastBrand', 'forecastBrandOther'));
    const brandId = brandIdForName(brand);
    const productName = document.getElementById('forecastProduct').value.trim();

    if (!customerName) {
        alert('請填寫客戶名稱。');
        return;
    }

    if (!brand) {
        alert('請選擇廠牌。');
        return;
    }

    if (!productName) {
        alert('請填寫產品／品項。');
        return;
    }

    const stage = existing?.stage || document.getElementById('forecastStage').value || 'stage1';
    const status = existing?.status || 'active';

    const now = forecastNowIso();
    const estimatedAmount = Number(document.getElementById('forecastAmount').value) || 0;

    forecastSaveInProgress = true;
    const button = document.getElementById('saveForecastBtn');

    if (button) {
        button.disabled = true;
        button.innerText = '儲存中…';
    }

    try {
        const ref = id ? db.collection('forecasts').doc(id) : db.collection('forecasts').doc();

        if (!existing) {
            const rawProgress = '';
            const latestProgress = buildForecastProgressText('', '立案');

            const record = {
                customerName,
                customerId: syncCustomerMaster(customerName, { salesCode: currentUserCode || '' }),
                brand,
                brandId,
                productName,
                estimatedAmount,
                stage,
                status,
                closedAt: status === 'active' ? null : now,
                latestProgress,
                latestProgressAt: now,
                salesName: currentUserName || '',
                salesCode: currentUserCode || '',
                ownerUid: currentUser?.uid || '',
                productId: '',
                createdAt: now,
                ...commercialCreatorFields(),
                updatedAt: now,
                ...linkedDocumentFields('', '', [])
            };
            record.searchTokens = buildFullHistorySearchTokens('forecast', record);

            const batch = db.batch();
            batch.set(ref, record);

            batch.set(ref.collection('progress').doc(), {
                text: rawProgress || '立案',
                displayText: latestProgress,
                stage,
                status,
                createdAt: now,
                createdByUid: currentUser?.uid || '',
                createdByName: currentUserName || ''
            });

            await batch.commit();

            forecastCache = [{ id: ref.id, ...record }, ...forecastCache];
        } else {
            const updateData = {
                customerName,
                customerId: syncCustomerMaster(customerName, { salesCode: existing.salesCode || currentUserCode || '' }),
                brand,
                brandId,
                productName,
                estimatedAmount,
                updatedAt: now
            };
            updateData.searchTokens = buildFullHistorySearchTokens('forecast', { ...existing, ...updateData });

            const batch = db.batch();
            batch.set(ref, updateData, { merge: true });

            const changes = [];
            if ((existing.customerName || '') !== customerName) changes.push(`客戶：${existing.customerName || '－'} → ${customerName || '－'}`);
            if ((existing.brand || '') !== brand) changes.push(`廠牌：${existing.brand || '－'} → ${brand || '－'}`);
            if ((existing.productName || '') !== productName) changes.push(`品項：${existing.productName || '－'} → ${productName || '－'}`);
            if (Number(existing.estimatedAmount || 0) !== estimatedAmount) changes.push(`金額：${Number(existing.estimatedAmount || 0).toLocaleString()} → ${estimatedAmount.toLocaleString()}`);

            if (changes.length) {
                batch.set(ref.collection('progress').doc(), {
                    text: `基本資料更新：${changes.join('；')}`,
                    displayText: `${forecastTodayLabel()} 基本資料更新：${changes.join('；')}`,
                    stage: existing.stage || 'stage1',
                    status: existing.status || 'active',
                    isSystemEntry: true,
                    createdAt: now,
                    createdByUid: currentUser?.uid || '',
                    createdByName: currentUserName || ''
                });
            }

            await batch.commit();

            forecastCache = [
                { ...existing, ...updateData },
                ...forecastCache.filter(item => item.id !== id)
            ];
        }

        forecastCache.sort(
            (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        );

        closeForecastModal();
        populateForecastBrandFilter();
        populateForecastSalesFilter();
        renderForecastList();
    } catch (err) {
        console.error('Forecast 儲存失敗', err);
        alert('Forecast 儲存失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        forecastSaveInProgress = false;

        if (button) {
            button.disabled = false;
            button.innerText = '儲存';
        }
    }
};

window.permanentlyDeleteForecast = async function(id) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    const item=forecastCache.find(row=>row.id===id);
    if(!confirm(`永久刪除 Forecast「${item?.customerName||id}」及其進度紀錄？此操作無法復原。`))return;
    try{
        await deleteCollectionInBatches(`forecasts/${id}/progress`);
        await db.collection('forecasts').doc(id).delete();
        forecastCache=forecastCache.filter(row=>row.id!==id);
        forecastHistorySearchResults=forecastHistorySearchResults.filter(row=>row.id!==id);
        renderForecastList();
    }catch(err){alert('永久刪除失敗：'+(err.message||err));}
};

window.permanentlyDeleteQuote = async function(quoteNo) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    if(!confirm(`永久刪除估價單「${quoteNo}」？此操作無法復原；已建立的 Forecast／訂單不會連帶刪除。`))return;
    try{
        await db.collection('quotes').doc(quoteNo).delete();
        myQuotesCache=myQuotesCache.filter(row=>row.quoteNo!==quoteNo);
        quoteHistorySearchResults=quoteHistorySearchResults.filter(row=>row.quoteNo!==quoteNo);
        renderMyQuotesList();
    }catch(err){alert('永久刪除失敗：'+(err.message||err));}
};

function assertOrderEligibleForPermanentDelete(order) {
    // Display normalization clamps invalid values and derives delivery projections.
    // Destructive operations must inspect the stored facts before that conversion.
    for(const item of (Array.isArray(order?.items)?order.items:[])){
        if(!item||typeof item!=='object')throw new Error('訂單原始品項格式異常，請先核對資料。');
        for(const field of ['qty','orderedQty','reservedQty','supplyOrderedQty','receivedQty','dispatchPreparedQty','deliveredQty','returnedQty']){
            if(!Object.prototype.hasOwnProperty.call(item,field))continue;
            const value=item[field];
            if(!['number','string'].includes(typeof value)||String(value).trim()===''
                ||!Number.isFinite(Number(value))||Number(value)<0)
                throw new Error('訂單原始品項數量異常，請先核對資料再永久刪除。');
        }
        if(['supplyOrderedQty','receivedQty','dispatchPreparedQty','deliveredQty','returnedQty']
            .some(field=>Number(item[field]??0)!==0))
            throw new Error('訂單原始品項已有採購、到貨、打單、交付或退貨紀錄，不可永久刪除。');
        if(item.transferPendingId||item.custodyTransferId)
            throw new Error('訂單品項仍有調撥關聯，請先核對調撥紀錄，不可永久刪除。');
    }
    const items=normalizedOrderItems(order);
    if(items.some((item,index)=>Number(order.items[index].reservedQty??0)!==Number(item.reservedQty??0)))
        throw new Error('訂單原始預留數量與有效需求不一致，請先核對庫存。');
    if(!items.length)throw new Error('此訂單缺少正式品項，無法安全永久刪除，請由管理員先核對原始資料。');
    if(['pending','failed'].includes(order.inventoryReservationStatus)
        || ['pending','failed'].includes(order.sourceDocumentSyncStatus))
        throw new Error('訂單仍有待完成的庫存或來源文件同步，不能永久刪除。');
    if(order.sourceId||order.sourceLink||order.quoteContext
        || (Array.isArray(order.linkedDocuments)&&order.linkedDocuments.some(row=>row?.id)))
        throw new Error('訂單已連結估價單、Forecast 或其他正式文件；不能直接永久刪除，以免來源資料失去關聯。');
    if(order.isDelivered||order.isBilled||savedDeliveryRecords(order).length||savedReturnRecords(order).length
        || (order.deliveryHistory||[]).length||(order.returnHistory||[]).length)
        throw new Error('訂單已有出貨、退貨或核銷紀錄，請保留商業歷史，不得永久刪除。');
    if(items.some(item=>Number(item.supplyOrderedQty||0)>0||Number(item.receivedQty||0)>0
        || (item.purchaseDocumentNos||[]).length>0||(item.selfOrderNos||[]).length>0
        || (item.orderEvents||[]).length>0||(item.receiptEvents||[]).length>0
        || Number(item.deliveredQty||0)>0))
        throw new Error('訂單已有採購、到貨或交付紀錄，不能永久刪除。');
    const ids=items.map((item,index)=>String(item.itemId||`item-${index+1}`));
    if(new Set(ids).size!==ids.length)throw new Error('訂單品項識別碼重複，無法安全清除關聯資料。');
    return {items,ids};
}

async function deleteUnfulfilledOrderAtomically(orderId,actor) {
    return runRoleTransaction(async tx=>{
        const orderRef=db.collection('orders').doc(orderId);
        const orderSnap=await tx.get(orderRef);
        if(!orderSnap.exists)throw new Error('訂單已刪除，請重新整理。');
        const liveOrder={id:orderId,...orderSnap.data()};
        const {items,ids}=assertOrderEligibleForPermanentDelete(liveOrder);
        const dependencies=[];
        for(let i=0;i<ids.length;i++){
            const item=items[i],itemId=ids[i],productKey=inventoryProductKey(item);
            const reservationRef=db.collection('inventoryReservations').doc(`${orderId}__${itemId}`);
            const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
            const demandRef=procurementDemandRef(demandId);
            const reservationSnap=await tx.get(reservationRef);
            const demandSnap=await tx.get(demandRef);
            if(reservationSnap.exists){
                const reservation=reservationSnap.data();
                if(reservation.orderId!==orderId||reservation.itemId!==itemId
                    ||reservation.productKey!==productKey)
                    throw new Error('預留紀錄與來源訂單不一致，請先核對資料。');
                if(normalizedOrderStatus(liveOrder)==='cancelled'
                    && (!['number','string'].includes(typeof reservation.quantity)
                        ||String(reservation.quantity).trim()===''||Number(reservation.quantity)!==0))
                    throw new Error('已取消訂單仍占用庫存，請先核對預留再刪除。');
            }
            if(demandSnap.exists){
                const demand=demandSnap.data();
                if(demand.sourceType!=='SALES_ORDER'||demand.sourceId!==orderId
                    ||demand.sourceItemId!==itemId||demand.productKey!==productKey
                    ||demand.ownerUid!==liveOrder.ownerUid||demand.salesCode!==liveOrder.salesCode
                    ||(demand.demandId&&demand.demandId!==demandId))
                    throw new Error('採購需求與訂單來源不一致，不能刪除其他來源資料。');
                if(demand.orderedQty!==0||demand.receivedQty!==0)
                    throw new Error('採購需求已有供應商承諾、收貨事實或數量異常，不可永久刪除訂單。請先核對採購需求。');
            }
            dependencies.push({reservationRef,demandRef});
        }
        if(normalizedOrderStatus(liveOrder)!=='cancelled'){
            await adjustInventoryReservationForLifecycle(tx,orderId,liveOrder,'cancelled',actor,{skipDemandSync:true});
        }else if(items.some(item=>Number(item.reservedQty||0)!==0)){
            throw new Error('已取消訂單的預留投影不為零，請先核對庫存。');
        }
        for(const {reservationRef,demandRef} of dependencies){
            tx.delete(reservationRef);
            tx.delete(demandRef);
        }
        tx.delete(orderRef);
        return {id:orderId,itemCount:items.length};
    });
}

window.permanentlyDeleteOrder = async function(orderId) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    if (pendingLifecycleOrderIds.has(orderId)) return;
    const order=ordersCache.find(row=>row.id===orderId);
    if(!order)return alert('找不到這筆訂單，請重新整理。');
    try{assertOrderEligibleForPermanentDelete(order);}
    catch(error){return alert('無法永久刪除：'+error.message);}
    if(!confirm(`永久刪除訂單「${order.orderNo||orderId}」？將在同一交易中釋放庫存並清除訂單、預留及未採購的需求。此操作無法復原。`))return;
    const button=actionButtonFromEventOrSelector();
    const buttonState=beginActionButton(button,'刪除中…');
    pendingLifecycleOrderIds.add(orderId);
    try{
        renderOrdersList();
        // Legacy supplier entries can survive stale order-item projections.
        // A bounded read is justified only for this rare destructive admin action.
        const linkedSupplies=await firestoreReadWithTimeout(
            db.collection('supplyOrders').where('orderId','==',orderId).limit(1).get(),'檢查訂單供應商紀錄');
        if(!linkedSupplies.empty)throw new Error('系統仍有此訂單的供應商紀錄，不能永久刪除。請先核對採購單。');
        await deleteUnfulfilledOrderAtomically(orderId,deliveryActor());
        ordersCache=ordersCache.filter(row=>row.id!==orderId);
        orderHistorySearchResults=orderHistorySearchResults.filter(row=>row.id!==orderId);
        showActionFeedback('訂單及未採購的關聯資料已永久刪除。');
    }catch(err){
        alert('永久刪除失敗：'+(err.message||err)+'\n沒有將部分刪除視為完成，請重新核對訂單與庫存。');
    }finally{
        pendingLifecycleOrderIds.delete(orderId);
        endActionButton(button,buttonState);
        renderOrdersList();
    }
};

window.openForecastProgressModal = function(id) {
    if (!canEditPage('forecast')) return;

    const item = forecastCache.find(entry => entry.id === id);
    if (!item) return;

    document.getElementById('forecastProgressId').value = item.id;
    document.getElementById('forecastProgressText').value = '';
    document.getElementById('forecastProgressStage').value = item.stage || 'stage1';
    document.getElementById('forecastProgressStatus').value = item.status || 'active';

    const summary = document.getElementById('forecastProgressSummary');
    if (summary) {
        summary.innerHTML = `
            <strong>${escapeHtml(item.customerName || '')}</strong>
            <span>${escapeHtml(item.brand || '')}</span>
            <span>${escapeHtml(item.productName || '')}</span>
            <div style="margin-top:6px;color:#666;">
                目前：${escapeHtml(forecastStageLabel(item.stage))} ／ ${escapeHtml(forecastStatusLabel(item.status))}
            </div>
        `;
    }

    document.getElementById('forecastProgressOverlay').classList.add('active');

    setTimeout(() => {
        document.getElementById('forecastProgressText')?.focus();
    }, 0);
};

window.closeForecastProgressModal = function() {
    document.getElementById('forecastProgressOverlay')?.classList.remove('active');
};

window.saveForecastProgress = async function() {
    if (forecastProgressSaveInProgress || !canEditPage('forecast')) return;

    const id = document.getElementById('forecastProgressId').value;
    const item = forecastCache.find(entry => entry.id === id);

    if (!item) {
        alert('找不到這筆 Forecast。');
        return;
    }

    const progressText = document.getElementById('forecastProgressText').value.trim();

    if (!progressText) {
        alert('請輸入最新進度。');
        return;
    }

    let stage = document.getElementById('forecastProgressStage').value || item.stage || 'stage1';
    const status = document.getElementById('forecastProgressStatus').value || item.status || 'active';

    if (status === 'won') {
        stage = 'stage5';
    }

    const now = forecastNowIso();
    const displayText = buildForecastProgressText(progressText);

    forecastProgressSaveInProgress = true;
    const button = document.getElementById('saveForecastProgressBtn');

    if (button) {
        button.disabled = true;
        button.innerText = '儲存中…';
    }

    try {
        const forecastRef = db.collection('forecasts').doc(id);
        const progressRef = forecastRef.collection('progress').doc();
        const batch = db.batch();

        const forecastUpdate = {
            latestProgress: displayText,
            latestProgressAt: now,
            stage,
            status,
            updatedAt: now
        };
        forecastUpdate.searchTokens = buildFullHistorySearchTokens('forecast', { ...item, ...forecastUpdate });
        batch.update(forecastRef, forecastUpdate);

        batch.set(progressRef, {
            text: progressText,
            displayText,
            previousStage: item.stage || '',
            stage,
            previousStatus: item.status || 'active',
            status,
            createdAt: now,
            createdByUid: currentUser?.uid || '',
            createdByName: currentUserName || ''
        });

        await batch.commit();

        Object.assign(item, {
            latestProgress: displayText,
            latestProgressAt: now,
            stage,
            status,
            updatedAt: now
        });

        forecastCache.sort(
            (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        );

        closeForecastProgressModal();
        populateForecastBrandFilter();
        populateForecastSalesFilter();
        renderForecastList();
    } catch (err) {
        console.error('Forecast 進度更新失敗', err);
        alert('Forecast 進度更新失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        forecastProgressSaveInProgress = false;

        if (button) {
            button.disabled = false;
            button.innerText = '儲存進度';
        }
    }
};

window.openForecastStageInfo = function() {
    document.getElementById('forecastStageInfoOverlay')?.classList.add('active');
};

window.closeForecastStageInfo = function() {
    document.getElementById('forecastStageInfoOverlay')?.classList.remove('active');
};

window.openForecastHistoryModal = async function(id) {
    const forecast = forecastCache.find(item => item.id === id);
    const overlay = document.getElementById('forecastHistoryOverlay');
    const body = document.getElementById('forecastHistoryBody');
    const title = document.getElementById('forecastHistoryTitle');
    if (!forecast || !overlay || !body) return;

    if (title) title.textContent = `紀錄｜${forecast.customerName || ''}｜${forecast.productName || ''}`;
    body.innerHTML = '<tr><td colspan="5">讀取中…</td></tr>';
    overlay.classList.add('active');

    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('forecasts').doc(id).collection('progress')
                .orderBy('createdAt', 'desc')
                .limit(100)
                .get(),
            'Forecast 歷史紀錄'
        );

        const rows = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        body.innerHTML = rows.length ? rows.map(row => `<tr>
            <td>${escapeHtml(dateOnlyFromTimestamp(row.createdAt) || '')}</td>
            <td style="text-align:left;">${escapeHtml(row.displayText || row.text || '')}</td>
            <td>${escapeHtml(forecastStageLabel(row.stage || forecast.stage || 'stage1'))}</td>
            <td>${escapeHtml(forecastStatusLabel(row.status || forecast.status || 'active'))}</td>
            <td>${escapeHtml(row.createdByName || '')}</td>
        </tr>`).join('') : '<tr><td colspan="5" style="color:#888;">目前沒有更新紀錄。</td></tr>';
    } catch (err) {
        body.innerHTML = `<tr><td colspan="5">讀取失敗：${escapeHtml(err.message || String(err))}</td></tr>`;
    }
};

window.closeForecastHistoryModal = function() {
    document.getElementById('forecastHistoryOverlay')?.classList.remove('active');
};

async function forecastProductMatchAsync(item) {
    const productId = String(item?.productId || '').trim();
    if (productId) {
        const cached = priceList.find(product => String(product.productId || '') === productId);
        if (cached) return cached;
        try {
            const snap = await firestoreReadWithTimeout(
                db.collection('products').doc(productId).get(),
                'Forecast 產品主檔'
            );
            if (snap.exists) {
                const product = productMasterDocToPriceItem(snap);
                if (product.status !== 'INACTIVE' && product.active !== false) return cacheProductLookupItem(product);
            }
        } catch (err) {
            console.warn('Forecast 產品主檔查詢失敗：', err);
        }
    }
    return forecastProductMatch(item);
}

function forecastProductMatch(item) {
    const key = String(item.productName || '').trim().toLocaleLowerCase();

    return priceList.find(product =>
        [product.model, product.nameCn, product.nameEn].some(
            value => String(value || '').trim().toLocaleLowerCase() === key
        )
    ) || null;
}

window.createQuoteFromForecast = async function(id) {
    const forecast = forecastCache.find(item => item.id === id);
    if (!forecast) return;

    const match = await forecastProductMatchAsync(forecast);

    actuallySwitchMainTab('quote-system', null, { preserveSubView: false });

    document.getElementById('clientName').value = forecast.customerName || '';
    document.getElementById('ordererName').value = forecast.customerName || '';

    if (!document.querySelector('#quoteItems tr')) {
        addQuoteRow();
    }

    const target = document.querySelector('#quoteItems tr');

    if (target) {
        target.querySelector('.item-cn').value = match?.nameCn || forecast.productName || '';
        target.querySelector('.item-en').value = match?.nameEn || '';
        target.querySelector('.item-model').value = match?.model || '';
        target.querySelector('.item-product-id').value = match?.productId || forecast.productId || '';

        const brandSelect = target.querySelector('.item-brand');
        const forecastBrand = normalizeForecastBrand(forecast.brand || match?.brand || '');

        if (brandSelect && forecastBrand) {
            selectBrandInDropdown(brandSelect, forecastBrand);
            onQuoteBrandSelectChange(brandSelect);
        }

        target.querySelector('.item-product-line').value = match?.productLine || '';
        target.querySelector('.item-product-type').value = match?.productType || '';
        refreshQuoteWarehouseStock(target);
        target.querySelector('.item-spec').value = match?.spec || '';

        if (match?.price) {
            target.querySelector('.inc-price').value = match.price;
        }

        calculateTotals();
    }

    window._pendingForecastQuoteLink = { forecastId: forecast.id };
};

async function forecastOrderItems(forecast) {
    if (Array.isArray(forecast.items) && forecast.items.length) return forecast.items;

    // 舊 Forecast 由估價單建立時沒有保存 items；從來源估價單補抓，讓既有資料也能正確拆單。
    if (forecast.sourceType === DOCUMENT_TYPES.QUOTE && forecast.sourceId) {
        const quoteSnap = await firestoreReadWithTimeout(
            db.collection('quotes').doc(forecast.sourceId).get(),
            'Forecast 來源估價單'
        );
        const quote = quoteSnap.exists ? quoteSnap.data() : null;
        if (Array.isArray(quote?.items) && quote.items.length) {
            const items = quote.items.map(item => ({
                nameCn: item.nameCn || '',
                nameEn: item.nameEn || '',
                model: item.model || '',
                brand: resolveBrandName(item.brand || ''),
                brandId: item.brandId || brandIdForName(item.brand || ''),
                productId: item.productId || '',
                productLine: item.productLine || '',
                productType: item.productType || '',
                spec: item.spec || '',
                qty: Number(item.qty || 1),
                price: parseMoney(item.price),
                subtotal: parseMoney(item.subtotal)
            }));
            // 背景補回 Forecast，之後不必每次重新讀估價單。
            db.collection('forecasts').doc(forecast.id).set({ items }, { merge: true }).catch(() => {});
            forecast.items = items;
            return items;
        }
    }

    const match = await forecastProductMatchAsync(forecast);
    return [{
        nameCn: match?.nameCn || forecast.productName || '',
        nameEn: match?.nameEn || '',
        model: match?.model || '',
        brand: normalizeForecastBrand(forecast.brand || match?.brand || ''),
        brandId: match?.brandId || forecast.brandId || brandIdForName(forecast.brand || match?.brand || ''),
        productId: match?.productId || forecast.productId || '',
        productLine: match?.productLine || '',
        productType: match?.productType || '',
        spec: match?.spec || '',
        qty: 1,
        price: parseMoney(match?.price || forecast.estimatedAmount || 0),
        subtotal: parseMoney(match?.price || forecast.estimatedAmount || 0)
    }];
}

function forecastItemToOrderSource(forecast, item) {
    const match = item.model ? findPriceItemForOrder({ itemCode: item.model, brand: item.brand }) : null;
    const qty = Number(item.qty || 1) || 1;
    const unitPrice = parseMoney(item.price || match?.price || 0);
    const totalPrice = parseMoney(item.subtotal || (unitPrice * qty));
    return {
        customerName: forecast.customerName || '',
        ownerUid: forecast.ownerUid || '',
        itemName: item.nameCn || item.nameEn || item.model || forecast.productName || '',
        itemCode: item.model || '',
        brand: normalizeForecastBrand(item.brand || forecast.brand || match?.brand || ''),
        brandId: item.brandId || match?.brandId || forecast.brandId || brandIdForName(item.brand || forecast.brand || match?.brand || ''),
        qty,
        unitPrice,
        totalPrice,
        sourceType: DOCUMENT_TYPES.FORECAST,
        sourceId: forecast.id,
        productId: item.productId || match?.productId || '',
        productMasterMatched: !!(item.productId || match?.productId),
        productLine: item.productLine || match?.productLine || '',
        productType: item.productType || match?.productType || '',
        spec: item.spec || match?.spec || '',
        supplier: match?.supplier || ''
    };
}

async function createForecastOrdersDirectly(forecast, items) {
    const synchronizationUid=currentUser?.uid;
    const synchronizationRole=currentUserRole;
    const assertCreationActor=()=>{if(!synchronizationUid||currentUser?.uid!==synchronizationUid||currentUserRole!==synchronizationRole)throw new Error('登入帳號或角色已變更，請以原身分確認 Forecast 轉單結果。');};
    assertCreationActor();
    const now = new Date().toISOString();
    const orderDate = localDateString();
    const normalizedItems = items.map((item, index) => {
        const source = forecastItemToOrderSource(forecast, item);
        return { ...normalizeNewOrderItem(source), itemId:`item-${index + 1}`, sourceItemIndex:index };
    }).filter(item => item.itemName || item.itemCode);
    if (!normalizedItems.length) throw new Error('Forecast 沒有可轉成訂單的品項。');
    assertOrderItemCount(normalizedItems);

    const unmatchedItem=normalizedItems.find(item=>item.productMasterMatched!==true||!item.productId);
    if(unmatchedItem){
        throw new Error(`Forecast 品項「${unmatchedItem.itemName||unmatchedItem.itemCode||'未命名品項'}」尚未對應產品主檔，請先建立／對應產品後再轉訂單。`);
    }

    const firstItem=normalizedItems[0];
    const totalPrice=normalizedItems.reduce((sum,item)=>sum+Number(item.totalPrice||0),0);
    const pendingKey=`${ORDER_DRAFT_STORAGE_PREFIX}:${synchronizationUid}:forecast:${forecast.id}:pending_order_id`;
    let pendingId=localStorage.getItem(pendingKey);
    if(!pendingId){
        pendingId=db.collection('orders').doc().id;
        localStorage.setItem(pendingKey,pendingId);
    }
    const orderData={
        orderDate,
        createdAt:now,
        ...commercialCreatorFields(),
        // 內部訂單不受公司／品牌限制；若來源估價單有公司，只保留作為來源紀錄。
        company:forecast.company||'',
        customerName:forecast.customerName||'',
        customerId:forecast.customerId||customerIdForName(forecast.customerName||''),
        brand:firstItem.brand||'',
        brandId:firstItem.brandId||brandIdForName(firstItem.brand||''),
        itemCode:firstItem.itemCode||'',
        itemCodeKey:normalizeHistoryItemCode(firstItem.itemCode||''),
        itemName:firstItem.itemName||'',
        productLine:firstItem.productLine||'',
        productType:firstItem.productType||'',
        selfOrderAtCreation:true,
        procurementType:firstItem.procurementType||'PURCHASING_PO',
        fulfillmentType:firstItem.fulfillmentType||'WAREHOUSE',
        warehouseId:firstItem.warehouseId||'',
        qty:Number(firstItem.qty||0),
        unitPrice:Number(firstItem.unitPrice||0),
        totalPrice,
        items:normalizedItems,
        productIds:productIdsFromItems(normalizedItems),
        itemCount:normalizedItems.length,
        orderSchemaVersion:2,
        productMasterMatched:true,
        productId:firstItem.productId||'',
        supplier:firstItem.supplier||'',
        spec:firstItem.spec||'',
        status:BUSINESS_STATUS.ACTIVE,
        ...grossAmountMetadata(totalPrice),
        transactionType:'',
        invoiceTitle:'',
        quoteNo:'',
        ...linkedDocumentFields(
            DOCUMENT_TYPES.FORECAST,
            forecast.id,
            [documentLink(DOCUMENT_TYPES.FORECAST,forecast.id,'source')]
        ),
        salesName:forecast.salesName||currentUserName||'',
        salesCode:forecast.salesCode||currentUserCode||'',
        ownerUid:forecast.ownerUid||currentUser?.uid||'',
        isDelivered:false,
        isBilled:false,
        billingDate:'',
        inventoryReservationStatus:'pending',
        inventoryReservationError:'',
        inventoryReservationUpdatedAt:now,
        // Forecast backlink is committed atomically with this order below.
        sourceDocumentSyncStatus:'completed',sourceDocumentSyncError:'',sourceDocumentSyncUpdatedAt:now
    };
    orderData.searchTokens=buildFullHistorySearchTokens('order',orderData);

    const committed=await commitOrderCreation(pendingId,orderData,{
        actorUid:synchronizationUid,actorRole:synchronizationRole,linkForecast:true,
        expectedForecastUpdatedAt:forecast.updatedAt||''
    });
    assertCreationActor();
    const created=[committed];
    const reservationResults = await Promise.all(created.map(async order => {
        try {
            await synchronizeOrderInventory(order.id, order.data, synchronizationUid);
            return { id:order.id, status:'completed' };
        } catch (err) {
            return { id:order.id, status:'failed', error:String(err?.message||err) };
        }
    }));

    assertCreationActor();
    ordersCache=[
        ...created.map(order=>({id:order.id,...order.data})),
        ...ordersCache.filter(order=>!created.some(createdOrder=>createdOrder.id===order.id))
    ].sort((x,y)=>String(y.orderDate||'').localeCompare(String(x.orderDate||'')));

    if(!reservationResults.some(result=>result.status==='failed')&&localStorage.getItem(pendingKey)===committed.id)localStorage.removeItem(pendingKey);
    return {
        created,
        reservationFailures:reservationResults.filter(result=>result.status==='failed')
    };
}

window.createOrderFromForecast = async function(id) {
    const requestedUid=currentUser?.uid,requestedRole=currentUserRole;
    const assertConversionActor=()=>{if(requestedUid!==currentUser?.uid||requestedRole!==currentUserRole)throw new Error('登入帳號或角色已變更，請重新開啟 Forecast。');};
    const forecast = forecastCache.find(item => item.id === id);
    if (!forecast) return;

    try {
        const items = await forecastOrderItems(forecast);
        assertConversionActor();
        if (!items.length) {
            alert('此 Forecast 沒有可帶入訂單的品項。');
            return;
        }

        if (items.length === 1) {
            // 單品項仍開啟新增訂單視窗，讓使用者最後確認／補資料再儲存。
            openOrderModal(forecastItemToOrderSource(forecast, items[0]));
            return;
        }

        if (!confirm(`此 Forecast 含 ${items.length} 個品項，將建立 1 張多品項訂單。確定繼續？`)) return;
        const result = await createForecastOrdersDirectly(forecast, items);
        assertConversionActor();
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        if (result.reservationFailures.length) {
            alert(`已建立 1 張含 ${items.length} 個品項的訂單；庫存預留未完成，訂單已標記為「庫存同步失敗」，請由管理員或採購在訂單頁重新同步，請勿重複建立訂單。`);
        } else {
            alert(`已將 Forecast 的 ${items.length} 個品項建立為 1 張訂單，庫存預留已同步。`);
        }
        if (canAccessPage('orders.po') && canCreatePurchaseOrderCapability()) {
            loadPendingPurchaseOrders(true).catch(refreshErr => console.error('Forecast 轉訂單後採購背景刷新失敗', refreshErr));
        }
    } catch (err) {
        console.error('Forecast 轉訂單失敗', err);
        alert('Forecast 轉訂單失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};


