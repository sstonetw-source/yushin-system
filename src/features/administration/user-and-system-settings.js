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
                    ? `<span class="status-badge status-soon" style="margin-right:6px;">下次登入須改密碼</span><button type="button" class="btn-small btn-secondary" onclick="toggleMustChangePassword(${inlineJsValue(u.uid)}, false)">取消要求</button>`
                    : `<button type="button" class="btn-small" onclick="toggleMustChangePassword(${inlineJsValue(u.uid)}, true)">🔒 強制下次登入改密碼</button>`}
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
    if(trueUserRole!=='admin'||currentUserRole!=='admin')return;
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
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
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
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    if (!confirm(`確定要寄送密碼重設信到 ${email} 嗎？`)) return;
    firebase.auth().sendPasswordResetEmail(email).then(() => {
        alert(`密碼重設信已寄出到 ${email}。`);
    }).catch(err => {
        alert('寄送失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    });
};

// 業務代號主檔在管理頁載入時僅唯讀，避免覆蓋已完成的交接。

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
    return readCollectionInBatches('users').then(rows => {
        if (generation !== sessionDataGeneration) return;
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
        if (document.getElementById('admin-statistics')?.style.display === 'block') populateSalesStatisticsFilters();
        renderAdminSalesTable();
    }).catch(err => {
        if (generation !== sessionDataGeneration) return;
        mainPageLoadFailed('admin');
        console.error('重新載入人員資料失敗：', err);
        allUsersCache = [];
        renderAdminSalesTable();
    });
};

// The user directory is shared by both personnel tabs. Sales codes are only needed for handover.
let adminTransferLoad = null;
function loadAdminTransferPanel() {
    const generation = sessionDataGeneration;
    if (adminTransferLoad?.generation === generation) return adminTransferLoad.request;
    const result = document.getElementById('transferResult');
    const preview = document.getElementById('transferPreviewBtn');
    resetTransferPreview();
    preview.disabled = true;
    result.innerText = '正在讀取人員與業務代號…';
    const request = Promise.all([reloadSalesFromUsers(), loadSalesCodeMaster()]).then(() => {
        if (generation !== sessionDataGeneration) return;
        if (!allUsersCache.length) throw new Error('無法取得人員名單');
        populateTransferDropdowns();
        preview.disabled = false;
    }).catch(err => {
        if (generation === sessionDataGeneration) result.innerText = '載入失敗：' + err.message + '。請重新開啟業務交接分頁。';
    }).finally(() => {
        if (adminTransferLoad?.request === request) adminTransferLoad = null;
    });
    adminTransferLoad = { generation, request };
    return request;
}

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
        allUsersCache.filter(u => u.name && u.active !== false && !u.disabled).map(u => `<option value="${escapeAttr(u.uid)}">${escapeHtml(u.name)}｜${escapeHtml(u.email || u.uid)}</option>`).join('');
    if ([...codeSelect.options].some(o => o.value === codeValue)) codeSelect.value = codeValue;
    if ([...userSelect.options].some(o => o.value === userValue)) userSelect.value = userValue;
    resetTransferPreview();
}

let pendingSalesTransfer = null;
window.resetTransferPreview = function() {
    pendingSalesTransfer = null;
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

window.previewSalesTransfer = function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin' || document.getElementById('transferPreviewBtn')?.disabled) return;
    const { salesCode, target, currentHolder } = getTransferSelection();
    const resultEl = document.getElementById('transferResult');
    const executeBtn = document.getElementById('transferExecuteBtn');
    pendingSalesTransfer = null;
    if (executeBtn) executeBtn.style.display = 'none';
    if (!salesCode || !target || !currentHolder?.uid) {
        resultEl.innerText = '請選擇已有原負責人的業務代號及接手同仁。';
        return;
    }
    if (currentHolder.uid === target.uid) {
        resultEl.innerText = '這位同仁目前已經是此業務代號的負責業務。';
        return;
    }
    if (target.active === false || target.disabled || (target.code && String(target.code) !== String(salesCode))) {
        resultEl.innerText = '接手同仁已停用或持有其他業務代號，請先確認人員設定。';
        return;
    }
    // Retain one operation ID across network retries; changing the selection invalidates it.
    const operationId = window.crypto?.randomUUID?.() ||
        ('transfer-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2));
    pendingSalesTransfer = { operationId, salesCode:String(salesCode),
        expectedFromUid:currentHolder.uid, targetUid:target.uid };
    resultEl.innerText =
        '業務代號：' + salesCode + '\n原負責人：' + (currentHolder.name || currentHolder.uid) +
        '\n接手同仁：' + target.name + '\n\n' +
        '交接將由後端在同一筆交易中修改業務代號主檔與兩位同仁設定，保留不可重複的操作紀錄。\n' +
        '歷史 salesName／建立者不改寫；缺少 salesCode 的舊資料不會在交接時自動補寫，需另行受控整理。';
    if (executeBtn) executeBtn.style.display = '';
};

window.executeSalesTransfer = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    const generation = sessionDataGeneration;
    const { salesCode, target, currentHolder } = getTransferSelection();
    const resultEl = document.getElementById('transferResult');
    const button = document.getElementById('transferExecuteBtn');
    const intent = pendingSalesTransfer;
    if (button?.disabled) return;
    if (!button || !intent || intent.salesCode !== String(salesCode) ||
        intent.targetUid !== target?.uid || intent.expectedFromUid !== currentHolder?.uid) {
        resultEl.innerText = '交接內容已變更，請重新檢查。';
        return;
    }
    if (!confirm('確定將業務代號「' + salesCode + '」由「' + currentHolder.name + '」交接給「' + target.name + '」嗎？')) return;
    button.disabled = true;
    resultEl.innerText = '正在由後端驗證並交接…';
    try {
        const callable = firebase.app().functions('asia-east1').httpsCallable('transferSalesCodeOwner');
        const response = await callable(intent);
        if (!['completed','already-applied'].includes(response?.data?.status))
            throw new Error('後端未確認交接完成');
        if (generation !== sessionDataGeneration) return;
        pendingSalesTransfer = null;
        button.style.display = 'none';
        salesListLoadPromise = null;
        await loadAdminTransferPanel();
        if (generation !== sessionDataGeneration) return;
        const refreshError = resultEl.innerText;
        resultEl.innerText = '交接完成：' + salesCode + ' 現由 ' + target.name + ' 負責。' + (refreshError ? '\n' + refreshError : '');
    } catch (err) {
        if (generation !== sessionDataGeneration) return;
        console.error('業務交接後端失敗：',err);
        resultEl.innerText = '交接未確認完成：' + (err.message || err) +
            '\n請先重新檢查目前負責人；若為網路中斷，可保留相同操作 ID 重試，不會重複交接。';
    } finally { button.disabled = false; }
};

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

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
    if (!confirm('此操作只匯出指定集合，並非完整資料庫備份；會讀取大量資料，可能增加 Firebase 讀取量。確定繼續嗎？')) return;

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
    button.innerText = '正在整理部分資料匯出…';
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
            scope: 'partial-selected-collections',
            completeDatabaseBackup: false,
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
        link.download = `partial-data-export-${localStamp}.json`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.innerText = `部分資料匯出完成：共 ${documentCount} 筆文件，檔案大小約 ${formatBytes(blob.size)}。此檔案不是完整資料庫備份。`;
    } catch (err) {
        console.error('下載資料庫備份失敗：', err);
        status.innerText = '備份失敗：' + err.message;
        alert('無法完成備份，請確認 Firestore 權限與網路連線。');
    } finally {
        button.disabled = false;
        button.innerText = '⬇️ 下載部分資料匯出';
    }
};

// 僅供離線檔案檢查：正式交易文件不得由瀏覽器逐筆補回。
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
    const file = input?.files?.[0];
    if (!file) return;
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    try {
        if (file.size > 50 * 1024 * 1024) throw new Error('檔案超過 50 MB，請使用受控的伺服器端檢查。');
        status.textContent = '正在檢查匯出檔案…';
        const backup = JSON.parse(await file.text());
        const documents = validateBackupDocuments(backup);
        const scope = backup.scope === 'partial-selected-collections' || backup.completeDatabaseBackup === false
            ? '部分資料匯出' : '舊版匯出檔案（完整性未知）';
        status.textContent = `${scope}；匯出時間：${backup.createdAt || '未記錄'}；檔案共 ${backup.documentCount} 筆，其中 ${documents.length} 筆為非帳號／設定文件。格式檢查完成，沒有讀寫雲端資料。正式還原須由具備交易完整性檢查的受控後端流程執行。`;
    } catch (err) { status.textContent = `檔案檢查失敗：${err.message}`; }
    finally { input.value = ''; }
};
