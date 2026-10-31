/* =========================================================
   儀器管理系統：客戶儀器維修保養／校正紀錄
   ========================================================= */
// 儀器管理系統的查看權限：業務只看自己；管理員／工程師可依 Firestore Rules 查看全部。
function canViewAllEquipment() {
    return canManageEquipmentCapability();
}

window.loadEquipmentFromCloud = function(reset = true) {
    const generation = ++equipmentLoadGeneration;
    const requestedRole = currentUserRole, requestedUid = currentUser?.uid;
    equipmentPageLoading = true;
    if (reset) {
        equipmentCursor = null;
        equipmentHasMore = false;
    }
    let query = db.collection('equipment');
    if (canViewAllEquipment()) {
        query = query.orderBy('customerName');
    } else {
        query = currentUserCode ? query.where('salesCode', '==', currentUserCode) : query.where('salesName', '==', currentUserName);
    }
    query = query.limit(DEFAULT_LIST_LIMIT);
    if (!reset && equipmentCursor) query = query.startAfter(equipmentCursor);

    const moreButton = document.getElementById('equipmentLoadMoreBtn');
    const refreshButton = document.getElementById('equipmentRefreshBtn');
    if (moreButton) { moreButton.disabled = true; moreButton.textContent = '載入中…'; }
    if (refreshButton) { refreshButton.disabled = true; refreshButton.textContent = '更新中…'; }

    return firestoreReadWithTimeout(query.get(), '儀器清單').then(snapshot => {
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole || requestedUid !== currentUser?.uid) return;
        const nextRows = snapshot.docs
            .map(doc => ({ id:doc.id, ...doc.data() }))
            .filter(data => data.active !== false);
        equipmentList = reset ? nextRows : [...equipmentList, ...nextRows.filter(row => !equipmentList.some(existing => existing.id === row.id))];
        equipmentCursor = snapshot.docs.length ? snapshot.docs[snapshot.docs.length - 1] : equipmentCursor;
        equipmentHasMore = snapshot.size === DEFAULT_LIST_LIMIT;
        if (!canViewAllEquipment()) {
            equipmentList.sort((a, b) => (a.customerName || '').localeCompare(b.customerName || '', 'zh-Hant'));
        }
        writeAppDataCache('equipment', equipmentList);
        renderEquipmentList();
    }).catch(err => {
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole || requestedUid !== currentUser?.uid) return;
        mainPageLoadFailed('equipment');
        console.error(err);
        alert(err?.code === 'firestore-read-timeout'
            ? '儀器資料讀取逾時，請重新進入此頁重試。'
            : '讀取儀器資料失敗，請確認 Firestore 權限設定。');
    }).finally(() => {
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole || requestedUid !== currentUser?.uid) return;
        equipmentPageLoading = false;
        if (moreButton) {
            moreButton.style.display = equipmentHasMore && !equipmentSearchActive ? '' : 'none';
            moreButton.disabled = false;
            moreButton.textContent = '載入更多';
        }
        if (refreshButton) {
            refreshButton.disabled = false;
            refreshButton.textContent = '↻ 更新';
        }
    });
};

window.loadMoreEquipment = function() {
    // 搜尋模式會自動把所有索引候選讀完；這個按鈕只負責一般列表的 50 筆分頁。
    if (equipmentSearchActive) return;
    if (!equipmentHasMore || !equipmentCursor) return;
    loadEquipmentFromCloud(false);
};

function addMonths(dateStr, months) {
    if (!dateStr) return null;
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    d.setMonth(d.getMonth() + months);
    return d;
}

function getEquipmentStatus(eq) {
    if (eq.noMaintenance) return { status: 'none', dueDate: null };

    const baseDate = eq.lastServiceDate || eq.installDate;
    const cycle = parseInt(eq.cycleMonths) || 12;
    const due = addMonths(baseDate, cycle);
    if (!due) return { status: 'unknown', dueDate: null };

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const diffDays = Math.round((due - today) / (1000 * 60 * 60 * 24));

    if (diffDays < 0) return { status: 'overdue', dueDate: due, diffDays };
    if (diffDays <= 30) return { status: 'soon', dueDate: due, diffDays };
    return { status: 'ok', dueDate: due, diffDays };
}

function fmtDate(d) {
    if (!d) return '－';
    if (typeof d === 'string') return d;
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}/${mm}/${dd}`;
}

const statusLabel = { ok: '正常', soon: '即將到期', overdue: '已逾期', unknown: '尚無紀錄', none: '免保養' };
const statusClass = { ok: 'status-ok', soon: 'status-soon', overdue: 'status-overdue', unknown: 'status-unknown', none: 'status-none' };

async function runEquipmentSearch() {
    const generation = ++equipmentSearchGeneration;
    const input = document.getElementById('eqSearchInput');
    const status = document.getElementById('equipmentSearchStatus');
    const moreButton = document.getElementById('equipmentLoadMoreBtn');
    const rawKeyword = input?.value || '';
    const normalized = normalizeFullHistorySearchValue(rawKeyword);

    if (!normalized) {
        equipmentSearchActive = false;
        equipmentSearchLoading = false;
        equipmentSearchKeyword = '';
        equipmentSearchResults = [];
        if (status) status.textContent = '';
        if (moreButton) {
            moreButton.style.display = equipmentHasMore ? '' : 'none';
            moreButton.disabled = false;
            moreButton.textContent = '載入更多';
        }
        renderEquipmentList();
        return;
    }

    const queryToken = fullHistoryQueryToken('equipment', rawKeyword);
    if (!queryToken) {
        equipmentSearchActive = false;
        equipmentSearchLoading = false;
        equipmentSearchResults = [];
        if (status) status.textContent = '目前帳號缺少可用的資料歸屬資訊，無法搜尋全部儀器。';
        renderEquipmentList();
        return;
    }

    equipmentSearchLoading = true;
    equipmentSearchActive = true;
    equipmentSearchKeyword = rawKeyword;
    equipmentSearchResults = [];
    const records = new Map();
    let cursor = null;
    let checked = 0;
    let lastIntermediateRenderAt = 0;
    if (status) status.textContent = '正在搜尋全部儀器…';
    if (moreButton) moreButton.style.display = 'none';
    renderEquipmentList();

    try {
        while (true) {
            let query = db.collection('equipment').where('searchTokens', 'array-contains', queryToken);
            if (!canViewAllEquipment()) {
                if (currentUserCode) query = query.where('salesCode', '==', currentUserCode);
                else if (currentUser?.uid) query = query.where('ownerUid', '==', currentUser.uid);
            }
            query = query.limit(DEFAULT_LIST_LIMIT);
            if (cursor) query = query.startAfter(cursor);

            const snapshot = await firestoreReadWithTimeout(query.get(), '儀器索引搜尋');
            if (generation !== equipmentSearchGeneration) return;

            checked += snapshot.size;
            snapshot.forEach(doc => {
                const data = { id:doc.id, ...doc.data() };
                if (data.active !== false && fullHistoryRecordMatches('equipment', data, rawKeyword)) records.set(doc.id, data);
            });
            const now = Date.now();
            if (now - lastIntermediateRenderAt >= 100 || snapshot.size < DEFAULT_LIST_LIMIT) {
                lastIntermediateRenderAt = now;
                equipmentSearchResults = [...records.values()]
                    .sort((a,b)=>String(a.customerName||'').localeCompare(String(b.customerName||''),'zh-Hant'));
                renderEquipmentList();
            }
            if (status) status.textContent = `全資料搜尋中：已檢查 ${checked} 筆候選資料，找到 ${records.size} 筆…`;

            if (snapshot.size < DEFAULT_LIST_LIMIT) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
            await Promise.resolve();
        }

        if (generation !== equipmentSearchGeneration) return;
        equipmentSearchResults = [...records.values()]
            .sort((a,b)=>String(a.customerName||'').localeCompare(String(b.customerName||''),'zh-Hant'));
        renderEquipmentList();
        if (status) status.textContent = `全資料搜尋完成：找到 ${records.size} 筆`;
    } catch (err) {
        if (generation !== equipmentSearchGeneration) return;
        console.error('儀器全資料搜尋失敗：', err);
        equipmentSearchActive = false;
        equipmentSearchResults = [];
        if (status) status.textContent = '儀器搜尋索引尚未補齊，請管理員到資料庫管理執行搜尋索引補建。';
        renderEquipmentList();
    } finally {
        if (generation === equipmentSearchGeneration) {
            equipmentSearchLoading = false;
            if (!equipmentSearchActive && moreButton) moreButton.style.display = equipmentHasMore ? '' : 'none';
        }
    }
}

window.scheduleEquipmentSearch = function() {
    clearTimeout(equipmentSearchTimer);
    const keyword = document.getElementById('eqSearchInput')?.value || '';
    if (!normalizeFullHistorySearchValue(keyword)) return runEquipmentSearch();
    equipmentSearchTimer = scheduleListSearch(equipmentSearchTimer, () => runEquipmentSearch());
};

let equipmentFilterOptionsSignature = '';

function populateEquipmentListFilters() {
    const salesSelect = document.getElementById('eqSalesFilter');
    const brandSelect = document.getElementById('eqBrandFilter');
    if (!salesSelect || !brandSelect) return [];
    const canSeeAll = canViewAllEquipment();
    salesSelect.style.display = canSeeAll ? '' : 'none';
    if (!canSeeAll) salesSelect.value = '';
    const selectedSales = salesSelect.value;
    const names = [...new Set([
        ...salesList.filter(isSelectableCommercialOwner).map(person => stripPhoneSuffix(person.name || '')),
        ...equipmentList.map(item => stripPhoneSuffix(item.salesName || '')),
        ...equipmentSearchResults.map(item => stripPhoneSuffix(item.salesName || ''))
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const selectedBrand = brandSelect.value;
    const brands = getPrimaryBrandNames();
    const signature = JSON.stringify([canSeeAll, names, brands]);
    if (signature !== equipmentFilterOptionsSignature) {
        if (canSeeAll) {
            salesSelect.innerHTML = '<option value="">全部負責業務</option>' + names.map(name =>
                `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
        }
        brandSelect.innerHTML = '<option value="">全部廠牌</option>' + brands.map(brand =>
            `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('')
            + `<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
        equipmentFilterOptionsSignature = signature;
    }
    if (canSeeAll && names.includes(selectedSales)) salesSelect.value = selectedSales;
    else if (canSeeAll && salesSelect.value && !names.includes(salesSelect.value)) salesSelect.value = '';
    if (brands.includes(selectedBrand) || selectedBrand === OTHER_BRAND_OPTION_KEY) brandSelect.value = selectedBrand;
    else if (brandSelect.value && !brands.includes(brandSelect.value)) brandSelect.value = '';
    return brands;
}

window.renderEquipmentList = function() {
    const tbody = document.getElementById('eqListBody');
    const keyword = (document.getElementById('eqSearchInput').value || '').toLowerCase();
    const statusFilter = document.getElementById('eqStatusFilter').value;
    const brands = populateEquipmentListFilters();
    const salesFilter = document.getElementById('eqSalesFilter')?.value || '';
    const brandFilter = document.getElementById('eqBrandFilter')?.value || '';

    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    const source = equipmentSearchActive ? equipmentSearchResults : equipmentList;
    source.forEach(eq => {
        const searchable = `${eq.customerName || ''} ${eq.brand || ''} ${eq.salesName || ''} ${eq.model || ''} ${eq.serialNo || ''} ${eq.assetId || ''} ${eq.location || ''} ${eq.notes || ''}`.toLowerCase();
        // 全資料搜尋已由 searchTokens + fullHistoryRecordMatches 完成，不再以畫面欄位二次縮小結果。
        if (!equipmentSearchActive && keyword && !searchable.includes(keyword)) return;
        if (salesFilter && stripPhoneSuffix(eq.salesName || '') !== salesFilter) return;
        if (brandFilter && orderBrandFilterValue(eq.brand, brands) !== brandFilter) return;

        const { status, dueDate } = getEquipmentStatus(eq);
        if (statusFilter !== 'all' && status !== statusFilter) return;

        shown++;
        const tr = document.createElement('tr');
        tr.className = 'clickable-row';
        tr.onclick = () => openEquipmentModal(eq.id);
        tr.innerHTML = `
            <td data-th="編號">${escapeHtml(eq.assetId || '－')}</td>
            <td data-th="客戶">${escapeHtml(eq.customerName || '')}</td>
            <td data-th="廠牌">${escapeHtml(eq.brand || '－')}</td>
            <td data-th="型號/序號">${escapeHtml(eq.model || '')} / ${escapeHtml(eq.serialNo || '')}</td>
            <td data-th="負責業務">${escapeHtml(eq.salesName || '未指定')}</td>
            <td data-th="放置地點">${escapeHtml(eq.location || '')}</td>
            <td data-th="最近保養/校正">${fmtDate(eq.lastServiceDate)}</td>
            <td data-th="下次到期">${fmtDate(dueDate)}</td>
            <td data-th="狀態"><span class="status-badge ${statusClass[status]}">${statusLabel[status]}</span></td>
            <td class="no-print" data-th="操作">
                <button type="button" class="btn-small" onclick="event.stopPropagation(); quickAddMaintenanceLog('${eq.id}')">🔧 保養</button>
                <button type="button" class="btn-danger" onclick="event.stopPropagation(); deleteEquipment('${eq.id}')">停用</button>
            </td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);

    document.getElementById('eqEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

function escapeHtml(str) {
    const div = document.createElement('div');
    div.innerText = str;
    return div.innerHTML;
}

// 依「業務代號」當編號前綴（格式 EQ-代號-00001），每個業務各自獨立編號。
// 這是必要的設計：一般業務只看得到自己的儀器清單，如果編號單純依序累加，
// 不同業務各自算出來的「下一個編號」會撞在一起（例如兩人都算出 EQ00001）；
// 用代號當前綴後，就算彼此看不到對方的資料，編號也不會重複。
function getNextAssetId(salesName, selectedCode = '') {
    const code = selectedCode || (salesName === currentUserName ? currentUserCode : '') || 'NA';
    const prefix = `EQ-${code}-`;

    let maxSeq = 0;
    equipmentList.forEach(eq => {
        if ((eq.assetId || '').startsWith(prefix)) {
            const seq = parseInt(eq.assetId.slice(prefix.length), 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        }
    });
    return prefix + String(maxSeq + 1).padStart(5, '0');
}

// 型號輸入時，若價目表中有對應資料，自動帶入廠牌
// 保養週期勾選「免保養」時，週期輸入框變成不可用（畫面上直接顯示「免保養」的意思），
// 狀態計算與到期提醒也會直接略過，不會再出現「即將到期／已逾期」
window.onEqNoMaintenanceChange = function() {
    const checkbox = document.getElementById('eqNoMaintenance');
    const cycleInput = document.getElementById('eqCycle');
    if (!checkbox || !cycleInput) return;
    cycleInput.disabled = checkbox.checked;
};

window.onEqModelChange = function() {
    const modelInput = document.getElementById('eqModel');
    const brandSelect = document.getElementById('eqBrand');
    if (!modelInput || !brandSelect) return;

    const model = modelInput.value.trim();
    if (!model) return;

    const match = priceItemLookup.get(`code:${normalizeItemCode(model)}`);
    if (match && match.brand) {
        selectBrandInDropdown(brandSelect, match.brand);
        onEqBrandSelectChange();
    }
};

window.openEquipmentModal = function(eqId) {
    const eq = eqId ? equipmentList.find(item => item.id === eqId) : null;
    if (eqId && !eq) return;

    const overlay = document.getElementById('eqModalOverlay');
    if (!overlay) return;
    overlay.dataset.editId = eqId || '';
    delete overlay.dataset.pendingCreateId;
    overlay.classList.add('active');
    currentEquipmentId = eqId || null;

    document.getElementById('eqSaveHint').innerText = '';
    const deleteBtn = document.getElementById('eqModalDeleteBtn');
    const logSection = document.getElementById('eqLogSection');
    const brandSelect = document.getElementById('eqBrand');
    if (brandSelect) brandSelect.value = '';
    onEqBrandSelectChange();

    if (eq) {
        document.getElementById('eqModalTitle').innerText = `${eq.customerName || ''} － ${eq.model || '編輯儀器'}`;
        document.getElementById('eqCustomer').value = eq.customerName || '';
        document.getElementById('eqModel').value = eq.model || '';
        document.getElementById('eqSerial').value = eq.serialNo || '';
        document.getElementById('eqSales').value = eq.salesName || '';
        document.getElementById('eqLocation').value = eq.location || '';
        document.getElementById('eqInstallDate').value = eq.installDate || '';
        document.getElementById('eqCycle').value = eq.cycleMonths || 12;
        document.getElementById('eqNoMaintenance').checked = !!eq.noMaintenance;
        onEqNoMaintenanceChange();
        document.getElementById('eqLastService').value = eq.lastServiceDate || '';
        document.getElementById('eqNotes').value = eq.notes || '';

        deleteBtn.style.display = 'inline-block';
        logSection.style.display = 'block';
        renderEquipmentLogTable(eq);
        document.getElementById('eqLogDate').value = '';
        document.getElementById('eqLogTech').value = '';
        document.getElementById('eqLogDesc').value = '';
    } else {
        document.getElementById('eqModalTitle').innerText = '新增儀器';
        ['eqCustomer', 'eqModel', 'eqSerial', 'eqSales', 'eqLocation', 'eqInstallDate', 'eqLastService', 'eqNotes'].forEach(id => {
            document.getElementById(id).value = '';
        });
        document.getElementById('eqCycle').value = 12;
        document.getElementById('eqNoMaintenance').checked = false;
        onEqNoMaintenanceChange();
        if (!canViewAllEquipment()) document.getElementById('eqSales').value = currentUserName || '';
        deleteBtn.style.display = 'none';
        logSection.style.display = 'none';
    }

    deferUntilAfterPaint(() => {
        if (!overlay.classList.contains('active') || overlay.dataset.editId !== (eqId || '')) return;
        populateEquipmentSalesDropdown();
        populateEquipmentBrandDropdown();
        populateOrderCustomerSuggestions();
        if (eq?.brand) {
            selectBrandInDropdown(document.getElementById('eqBrand'), eq.brand);
            onEqBrandSelectChange();
        }
        if (eq?.salesName) document.getElementById('eqSales').value = eq.salesName;
        else if (!canViewAllEquipment()) document.getElementById('eqSales').value = currentUserName || '';
    }, '儀器表單背景初始化');
};

window.closeEquipmentModal = function() {
    document.getElementById('eqModalOverlay').classList.remove('active');
    currentEquipmentId = null;
};

function renderEquipmentLogTable(eq) {
    const logBody = document.getElementById('eqLogBody');
    logBody.innerHTML = '';
    const logs = (eq.logs || []).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (logs.length === 0) {
        logBody.innerHTML = '<tr><td colspan="5" style="color:#888;">尚無紀錄</td></tr>';
    } else {
        logs.forEach((log) => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${fmtDate(log.date)}</td>
                <td>${escapeHtml(log.type || '')}</td>
                <td>${escapeHtml(log.tech || '')}</td>
                <td style="text-align:left;">${escapeHtml(log.desc || '')}</td>
                <td class="no-print"><button type="button" class="btn-danger" onclick="deleteEquipmentLog('${eq.id}', ${equipmentLogRealIndex(eq, log)})">刪除</button></td>
            `;
            logBody.appendChild(tr);
        });
    }
}

window.saveEquipmentFromModal = async function() {
    if (equipmentActionsPending.has('save')) return;
    const editId = document.getElementById('eqModalOverlay').dataset.editId;
    if (editId && equipmentActionsPending.has(editId)) return;
    const ownerOption = document.getElementById('eqSales').selectedOptions?.[0];
    const ownerUid = ownerOption?.dataset.ownerUid || '';
    const ownerCode = ownerOption?.dataset.salesCode || '';
    const savedEquipment = editId ? equipmentList.find(item => item.id === editId) : null;
    const data = {
        customerName: document.getElementById('eqCustomer').value.trim(),
        customerId: customerIdForName(document.getElementById('eqCustomer').value.trim()),
        brand: getBrandFieldValue('eqBrand', 'eqBrandOther'),
        model: document.getElementById('eqModel').value.trim(),
        serialNo: document.getElementById('eqSerial').value.trim(),
        salesName: ownerCode ? document.getElementById('eqSales').value.trim() : (savedEquipment?.salesName || ''),
        salesCode: ownerCode || savedEquipment?.salesCode || '',
        location: document.getElementById('eqLocation').value.trim(),
        installDate: document.getElementById('eqInstallDate').value,
        cycleMonths: parseInt(document.getElementById('eqCycle').value) || 12,
        noMaintenance: document.getElementById('eqNoMaintenance').checked,
        lastServiceDate: document.getElementById('eqLastService').value,
        notes: document.getElementById('eqNotes').value.trim()
    };

    if (!data.customerName || !data.model) {
        alert('請至少填寫客戶名稱與型號');
        return;
    }
    if (document.getElementById('eqBrand').value === '其他' && !data.brand) {
        alert('已選擇「其他」廠牌，請輸入廠牌名稱');
        return;
    }

    data.customerId = syncCustomerMaster(data.customerName, { salesCode: data.salesCode }) || data.customerId;
    data.searchTokens = buildFullHistorySearchTokens('equipment', data);
    const overlay = document.getElementById('eqModalOverlay');
    const ref = db.collection('equipment').doc(editId || overlay.dataset.pendingCreateId || undefined);
    if (!editId) overlay.dataset.pendingCreateId = ref.id;
    await runEquipmentAction(editId || 'save', '儀器儲存', data.customerName + '／' + data.model, async () => {
        await db.runTransaction(async tx => {
            const snapshot = await tx.get(ref);
            if (snapshot.exists) tx.update(ref, data);
            else tx.set(ref, { ...data, ...(ownerUid ? {ownerUid} : {}), assetId: getNextAssetId(data.salesName, data.salesCode), logs: [] });
        });
        const stillEditing = overlay.dataset.editId === editId && (editId || overlay.dataset.pendingCreateId === ref.id);
        if (stillEditing) { overlay.dataset.editId = ref.id; currentEquipmentId = ref.id; }
        rememberRecentCustomerName(data.customerName);
        loadEquipmentFromCloudThenReopen(ref.id, stillEditing);
    }, document.getElementById('eqSaveBtn'));
};

const equipmentActionsPending = new Set();
function actionFailureMessage(action, err, record = '') {
    const code = String(err?.code || '');
    const reason = code.includes('permission-denied') ? '目前帳號沒有執行此操作的權限。'
        : code.includes('unavailable') || code.includes('deadline-exceeded') ? '網路或資料庫暫時無法連線。'
        : !code && err?.message && !/network|offline|Firebase|quota|permission|unavailable/i.test(err.message) ? err.message
        : '資料庫未確認操作成功。';
    return `${action}失敗${record ? '（' + record + '）' : ''}：${reason}請保留目前資料，確認連線或權限後重試；若持續失敗，請聯絡管理員。`;
}
async function runEquipmentAction(key, action, label, callback, button) {
    if (equipmentActionsPending.has(key)) return false;
    equipmentActionsPending.add(key);
    const state = beginActionButton(button, '處理中…');
    const hint = document.getElementById('eqSaveHint');
    if (hint) hint.textContent = action + '中…';
    try {
        await callback();
        if (hint) hint.textContent = '✓ ' + action + '完成：' + label;
        showActionFeedback(action + '完成：' + label);
        return true;
    } catch (err) {
        console.error(action, label, err);
        const message = actionFailureMessage(action, err, label);
        if (hint) hint.textContent = message;
        alert(message);
        return false;
    } finally {
        equipmentActionsPending.delete(key);
        endActionButton(button, state);
    }
}
async function mutateEquipmentLogs(eqId, transform) {
    const ref = db.collection('equipment').doc(eqId);
    let saved;
    await db.runTransaction(async tx => {
        const snapshot = await tx.get(ref);
        if (!snapshot.exists) throw new Error('儀器已不存在。');
        const data = snapshot.data();
        const updates = transform(data);
        tx.update(ref, updates);
        saved = { ...data, ...updates, id: eqId };
    });
    const index = equipmentList.findIndex(item => item.id === eqId);
    if (index >= 0) equipmentList[index] = saved;
    writeAppDataCache('equipment', equipmentList);
    renderEquipmentList();
    if (currentEquipmentId === eqId) openEquipmentModal(eqId);
}

window.deleteEquipment = async function(eqId) {
    const eq = equipmentList.find(item => item.id === eqId);
    if (!eq || equipmentActionsPending.has(eqId)) return;
    if (!confirm('確定要停用這台儀器嗎？既有維修／保養紀錄會保留，可由管理員後續恢復。')) return;
    await runEquipmentAction(eqId, '儀器停用', eq.assetId || eq.model || eqId, async () => {
        const now = new Date().toISOString();
        await db.collection('equipment').doc(eqId).update({active:false, disabledAt:now,
            disabledByUid:currentUser?.uid || '', disabledBy:currentUserName || currentUser?.email || '', updatedAt:now});
        equipmentList = equipmentList.filter(item => item.id !== eqId);
        writeAppDataCache('equipment', equipmentList);
        renderEquipmentList();
        if (currentEquipmentId === eqId) closeEquipmentModal();
    }, actionButtonFromEventOrSelector('#eqModalDeleteBtn'));
};

function equipmentLogRealIndex(eq, log) {
    return (eq.logs || []).indexOf(log);
}
function appendEquipmentLog(data, log) {
    const updates = { logs: [...(data.logs || []), log] };
    if ((log.type === '保養' || log.type === '校正') && (!data.lastServiceDate || log.date >= data.lastServiceDate)) updates.lastServiceDate = log.date;
    return updates;
}
window.addEquipmentLogFromModal = async function() {
    const eqId = currentEquipmentId;
    if (!eqId || equipmentActionsPending.has(eqId)) return;
    const log = { date:document.getElementById('eqLogDate').value,
        type:document.getElementById('eqLogType').value,
        tech:document.getElementById('eqLogTech').value.trim(),
        desc:document.getElementById('eqLogDesc').value.trim(), id:lifecycleRecordId() };
    if (!log.date) return alert('請選擇日期');
    await runEquipmentAction(eqId, '新增維修紀錄', eqId,
        () => mutateEquipmentLogs(eqId, data => appendEquipmentLog(data, log)), document.getElementById('eqAddLogBtn'));
};

// 列表操作欄的「🔧 保養」：不開視窗，直接記一筆今天日期的保養紀錄
window.quickAddMaintenanceLog = async function(eqId) {
    const eq = equipmentList.find(e => e.id === eqId);
    if (!eq || equipmentActionsPending.has(eqId)) return;
    const dateStr = localDateString();
    if (!confirm(`確定要為「${eq.customerName || ''} ${eq.model || ''}」新增一筆今天(${dateStr})的保養紀錄嗎？`)) return;
    const log = { date:dateStr, type:'保養', tech:'', desc:'', id:lifecycleRecordId() };
    await runEquipmentAction(eqId, '新增保養紀錄', eq.assetId || eq.model || eqId,
        () => mutateEquipmentLogs(eqId, data => appendEquipmentLog(data, log)), actionButtonFromEventOrSelector());
};

window.deleteEquipmentLog = async function(eqId, logIndex) {
    const eq = equipmentList.find(e => e.id === eqId);
    const target = eq?.logs?.[logIndex];
    if (!target || equipmentActionsPending.has(eqId)) return;
    if (!confirm('確定要刪除這筆紀錄嗎？')) return;
    const fingerprint = JSON.stringify(target);
    await runEquipmentAction(eqId, '刪除維修紀錄', eq.assetId || eq.model || eqId, () => mutateEquipmentLogs(eqId, data => {
        const logs = [...(data.logs || [])];
        const index = logs.findIndex(log => target.id ? log.id === target.id : JSON.stringify(log) === fingerprint);
        if (index < 0) throw new Error('紀錄已變更，請重新開啟儀器後確認。');
        logs.splice(index, 1);
        return { logs };
    }), actionButtonFromEventOrSelector());
};

function loadEquipmentFromCloudThenReopen(eqId, reopen = true) {
    // Editing a record must not reload the entire equipment history.
    firestoreReadWithTimeout(
        db.collection('equipment').doc(eqId).get(),
        '儀器單筆資料'
    ).then(snapshot => {
        if (!snapshot.exists) throw new Error('找不到儀器資料。');
        const saved={ id:snapshot.id, ...snapshot.data() };
        const index=equipmentList.findIndex(item=>item.id===eqId);
        if(index>=0)equipmentList[index]=saved; else equipmentList.unshift(saved);
        renderEquipmentList();
        if (reopen && currentEquipmentId === eqId) openEquipmentModal(eqId);
        return null;
    }).catch(err => {
        alert('重新載入儀器失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    });
    return;

}

// 依 Firestore batch 500 筆上限，自動切批次執行「依儀器編號」更新／新增（不刪除任何既有資料）
function runEquipmentUpsertBatch(ops) {
    const CHUNK = 450;
    const chunks = [];
    for (let i = 0; i < ops.length; i += CHUNK) {
        chunks.push(ops.slice(i, i + CHUNK));
    }

    let chain = Promise.resolve();
    chunks.forEach(chunk => {
        chain = chain.then(() => {
            const batch = db.batch();
            chunk.forEach(op => {
                if (op.type === 'update') {
                    batch.set(db.collection('equipment').doc(op.docId), op.data, { merge: true });
                } else {
                    batch.set(db.collection('equipment').doc(), op.data);
                }
            });
            return batch.commit();
        });
    });
    return chain;
}

// 儀器管理系統：批次上傳 Excel（依「儀器編號」比對：比對到既有紀錄就更新、比對不到就新增；
// 不會刪除任何既有資料，維修保養／校正紀錄也會被保留。一般業務只能新增/更新自己名下的儀器，管理員可操作全部）
window.handleEquipmentExcelUpload = async function(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        input.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const sheet = workbook.Sheets[firstSheetName];
            const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

            if (!rows.length) {
                alert('Excel 檔案中沒有讀取到任何資料。');
                input.value = '';
                return;
            }

            const normalizeHeader = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
            const getField = (row, keys) => {
                for (const k of keys) {
                    if (row[k] !== undefined && row[k] !== '') return row[k];
                }
                const wanted = new Set(keys.map(normalizeHeader));
                const matchedKey = Object.keys(row).find(key => wanted.has(normalizeHeader(key)));
                if (matchedKey !== undefined && row[matchedKey] !== '') return row[matchedKey];
                return '';
            };

            // 依權限範圍建立「儀器編號 -> 文件ID」索引；一般角色不讀取其他業務資料。
            const existingPromise = canViewAllEquipment()
                ? readCollectionInBatches('equipment')
                : readQueryInBatches(
                    currentUserCode
                        ? db.collection('equipment').where('salesCode', '==', currentUserCode).orderBy('salesCode')
                        : db.collection('equipment').where('salesName', '==', currentUserName).orderBy('salesName')
                );

            existingPromise.then(records => {
                const idMap = new Map();
                const maxSeqByPrefix = {}; // 各業務代號前綴各自獨立計算目前最大流水號
                records.forEach(record => {
                    const d = record || {};
                    if (d.assetId) {
                        idMap.set(d.assetId, d.id);
                        const m = d.assetId.match(/^(EQ-[^-]+-)(\d+)$/);
                        if (m) {
                            const prefix = m[1];
                            const seq = parseInt(m[2], 10);
                            if (!maxSeqByPrefix[prefix] || seq > maxSeqByPrefix[prefix]) {
                                maxSeqByPrefix[prefix] = seq;
                            }
                        }
                    }
                });

                function nextIdForSales(salesName) {
                    const match = salesList.find(s => s.name === salesName);
                    const code = (match && match.code) ? match.code : 'NA';
                    const prefix = `EQ-${code}-`;
                    const next = (maxSeqByPrefix[prefix] || 0) + 1;
                    maxSeqByPrefix[prefix] = next;
                    return prefix + String(next).padStart(5, '0');
                }

                const updateOps = [];
                const insertRecords = [];
                let skipCount = 0;

                rows.forEach(row => {
                    const customerName = String(getField(row, ['客戶名稱', '客戶'])).trim();
                    const model = String(getField(row, ['型號'])).trim();
                    if (!customerName || !model) {
                        skipCount++;
                        return;
                    }

                    const assetIdInFile = String(getField(row, ['儀器編號', '編號'])).trim();
                    const cycleRaw = String(getField(row, ['保養週期', '週期'])).trim();
                    const isNoMaintenance = /免保養|不保養|不用保養|無需保養/.test(cycleRaw);
                    const recordData = {
                        customerName: customerName,
                        brand: String(getField(row, ['廠牌', '品牌'])).trim(),
                        model: model,
                        serialNo: String(getField(row, ['序號'])).trim(),
                        // 一般業務批次上傳一律歸在自己名下，忽略 Excel 裡填的負責業務；管理員則照 Excel 內容
                        salesName: (currentUserRole === 'admin')
                            ? String(getField(row, ['負責業務', '業務'])).trim()
                            : currentUserName,
                        location: String(getField(row, ['放置地點', '地點'])).trim(),
                        installDate: String(getField(row, ['安裝日期'])).trim(),
                        cycleMonths: parseInt(cycleRaw) || 12,
                        noMaintenance: isNoMaintenance,
                        lastServiceDate: String(getField(row, ['最近保養日期', '最近保養'])).trim(),
                        notes: String(getField(row, ['備註'])).trim()
                    };

                    recordData.salesCode = salesCodeForName(recordData.salesName);
                    recordData.searchTokens = buildFullHistorySearchTokens('equipment', { ...recordData, assetId:assetIdInFile });

                    const matchedId = assetIdInFile ? idMap.get(assetIdInFile) : null;
                    if (matchedId) {
                        updateOps.push({ docId: matchedId, data: recordData });
                    } else {
                        const assetId = assetIdInFile || nextIdForSales(recordData.salesName);
                        insertRecords.push({
                            ...recordData,
                            assetId,
                            searchTokens: buildFullHistorySearchTokens('equipment', { ...recordData, assetId }),
                            logs: []
                        });
                    }
                });

                if (updateOps.length === 0 && insertRecords.length === 0) {
                    alert('無法辨識出有效儀器資料，請確保表頭有「客戶名稱」與「型號」。');
                    input.value = '';
                    return;
                }

                const allOps = [
                    ...updateOps.map(u => ({ type: 'update', docId: u.docId, data: u.data })),
                    ...insertRecords.map(r => ({ type: 'insert', data: r }))
                ];

                runEquipmentUpsertBatch(allOps).then(() => {
                    let msg = `批次處理完成：更新 ${updateOps.length} 筆、新增 ${insertRecords.length} 筆`;
                    if (skipCount > 0) msg += `、略過 ${skipCount} 筆（缺少客戶名稱或型號）`;
                    msg += '。既有資料不會被刪除，維修保養紀錄也會保留。';
                    alert(msg);
                    input.value = '';
                    loadEquipmentFromCloud();
                }).catch(err => {
                    alert('批次寫入 Firestore 失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
                    input.value = '';
                });
            }).catch(err => {
                alert('讀取現有儀器資料失敗，無法進行比對：' + err.message);
                input.value = '';
            });

        } catch (err) {
            alert('讀取 Excel 檔案失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
            input.value = '';
        }
    };
    reader.readAsArrayBuffer(file);
};

// 儀器管理系統：批量下載 Excel（欄位與批次上傳格式相同，可編輯後重新上傳）
window.exportEquipmentExcel = async function() {
    if (!(equipmentSearchActive ? equipmentSearchResults : equipmentList).length) {
        alert('目前沒有儀器資料可以下載。');
        return;
    }

    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }

    const brands = getPrimaryBrandNames();
    const sales = document.getElementById('eqSalesFilter')?.value || '';
    const brand = document.getElementById('eqBrandFilter')?.value || '';
    const statusFilter = document.getElementById('eqStatusFilter')?.value || 'all';
    const exportSource = (equipmentSearchActive ? equipmentSearchResults : equipmentList).filter(eq =>
        (!sales || stripPhoneSuffix(eq.salesName || '') === sales) &&
        (!brand || orderBrandFilterValue(eq.brand, brands) === brand) &&
        (statusFilter === 'all' || getEquipmentStatus(eq).status === statusFilter));
    if(!exportSource.length){alert('目前篩選條件沒有儀器資料可以下載。');return;}
    const rows = exportSource.map(eq => {
        const { status, dueDate } = getEquipmentStatus(eq);
        return {
            '儀器編號': eq.assetId || '',
            '客戶名稱': eq.customerName || '',
            '廠牌': eq.brand || '',
            '型號': eq.model || '',
            '序號': eq.serialNo || '',
            '負責業務': eq.salesName || '',
            '放置地點': eq.location || '',
            '安裝日期': eq.installDate || '',
            '保養週期': eq.noMaintenance ? '免保養' : (eq.cycleMonths || 12),
            '最近保養日期': eq.lastServiceDate || '',
            '下次到期': fmtDate(dueDate),
            '狀態': statusLabel[status] || '',
            '備註': eq.notes || ''
        };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '儀器清單');
    XLSX.writeFile(wb, `儀器清單_${getFormattedDateCode()}.xlsx`);
};

