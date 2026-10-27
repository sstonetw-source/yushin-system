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
            .map(d => ({ uid:d.id, code:d.code, name:d.name, phone:d.phone || '', deliveryDefaults:d.deliveryDefaults || {}, role:d.role || 'sales', active:d.active !== false }))
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

