/* ---------- 業務名單管理（唯讀，資料來源為 users 集合，與登入帳號綁定） ---------- */
// 這裡顯示 users 集合裡「所有」帳號（包含還沒填 name/code、只能登入沒被列進業務下拉選單的人），
// 讓你能一眼看出目前有哪些帳號對這個系統有登入權限；下拉選單用的業務清單（salesList）不受影響，仍只取有填 name+code 的人

window.renderAdminSalesTable = function() {
    const tbody = document.getElementById('adminSalesBody');
    const cards = document.getElementById('adminSalesCardList');
    tbody.innerHTML = '';
    const mobileCards = [];
    allUsersCache.forEach((u) => {
        const tr = document.createElement('tr');
        const hasProfile = !!u.name;
        const name = escapeHtml(u.name || '（尚未設定姓名）');
        const uid = escapeAttr(u.uid);
        const uidArg = inlineJsValue(u.uid);
        const email = u.email ? escapeHtml(u.email) : '<span style="color:#c0392b;font-size:11px;">尚未取得（需等對方登入一次才會同步）</span>';
        const roleOptions = ['admin','sales','purchaser','warehouse','engineer'].map(role =>
            `<option value="${role}" ${u.role === role ? 'selected' : ''}>${escapeHtml(ROLE_LABELS[role])}</option>`
        ).join('');
        const roleSelect = id => `<select id="${id}" aria-label="身分" onchange="saveAdminUserRole(${uidArg}, this)">${roleOptions}</select>`;
        const delivery = u.deliveryDefaults?.mode === 'SALES_SHIP' ? '寄到業務地址' : '主倉領貨';
        const deliveryButton = label => `<button type="button" class="btn-small btn-secondary" onclick="openSalesDeliveryDefaults(${uidArg})">${label}</button>`;
        const passwordButton = u.mustChangePassword
            ? `<button type="button" class="btn-small btn-secondary" onclick="toggleMustChangePassword(${uidArg}, false)">取消改密碼要求</button>`
            : `<button type="button" class="btn-small" onclick="toggleMustChangePassword(${uidArg}, true)">強制下次登入改密碼</button>`;
        const resetButton = u.email
            ? `<button type="button" class="btn-small btn-secondary" onclick="sendPasswordResetToUser(${inlineJsValue(u.email)})">寄送密碼重設信</button>`
            : '';
        const copyButton = label => `<button type="button" class="btn-small btn-secondary admin-uid-copy" data-copy-label="${label}" onclick="copyAdminUserUid(${inlineJsValue(u.uid)}, this)" aria-label="複製完整帳號 UID">${label}</button>`;
        const passwordStatus = u.mustChangePassword ? '<span class="status-badge status-soon">下次登入須改密碼</span>' : '';
        tr.innerHTML = `
            <td data-label="代號">${escapeHtml(u.code || '—')}</td>
            <td data-label="姓名">${name}</td>
            <td data-label="電話">${escapeHtml(u.phone || '—')}</td>
            <td data-label="Email">${email}</td>
            <td data-label="身份">${roleSelect(`adminUserRole-${uid}`)}</td>
            <td data-label="領貨／地址">${deliveryButton(delivery)}</td>
            <td data-label="密碼" class="admin-user-password-actions">
                ${passwordStatus}
                <button type="button" class="btn-small btn-secondary admin-account-trigger" onclick="this.nextElementSibling.showModal()">帳號操作</button>
                <dialog class="admin-account-dialog" aria-label="帳號管理" onclick="if(event.target.closest('.admin-account-menu-content button')) this.close()">
                    <div class="admin-account-dialog-heading"><strong>帳號管理</strong><button type="button" class="btn-small btn-secondary" onclick="this.closest('dialog').close()">關閉</button></div>
                    <div class="admin-account-menu-content">${passwordButton}${resetButton}</div>
                </dialog>
            </td>
            <td data-label="帳號 UID" class="admin-user-uid" style="font-family:monospace;font-size:11px;color:${hasProfile ? '#999' : '#c0392b'};">
                <span class="admin-uid-value" title="${uid}">${escapeHtml(u.uid)}</span>
                ${copyButton('複製')}
            </td>
        `;
        tbody.appendChild(tr);
        mobileCards.push(`<article class="admin-mobile-card">
            <header class="admin-card-heading">
                <h4>${name}</h4>
                <span class="admin-card-badge is-role" id="adminUserRoleBadge-${uid}">${escapeHtml(ROLE_LABELS[u.role] || u.role || '業務')}</span>
            </header>
            <p class="admin-card-email">${email}</p>
            ${u.code || u.phone ? `<p class="admin-card-meta">${[u.code, u.phone].filter(Boolean).map(escapeHtml).join(' · ')}</p>` : ''}
            <div class="admin-card-delivery"><span>領貨與收件</span><span>${delivery}</span></div>
            ${passwordStatus}
            <div class="admin-card-actions">
                <button type="button" class="btn-secondary" aria-controls="adminUserSettings-${uid}" aria-expanded="false" onclick="toggleAdminUserCardPanel(this)">編輯設定</button>
                <button type="button" aria-controls="adminUserAccount-${uid}" aria-expanded="false" onclick="toggleAdminUserCardPanel(this)">帳號操作</button>
            </div>
            <div class="admin-card-menu" id="adminUserSettings-${uid}" hidden>
                <label class="admin-card-role-field" for="adminMobileUserRole-${uid}">身分 ${roleSelect(`adminMobileUserRole-${uid}`)}</label>
                ${deliveryButton('編輯領貨與收件設定')}
            </div>
            <div class="admin-card-menu" id="adminUserAccount-${uid}" hidden>
                ${passwordButton}
                ${resetButton}
                ${copyButton('複製帳號 UID')}
            </div>
        </article>`);
    });
    if (cards) cards.innerHTML = mobileCards.join('') || '<p>目前沒有人員資料。</p>';
};

window.toggleAdminUserCardPanel = function(button) {
    const shouldOpen = button.getAttribute('aria-expanded') === 'false';
    for (const control of button.parentElement.children) {
        const open = control === button && shouldOpen;
        control.setAttribute('aria-expanded', String(open));
        document.getElementById(control.getAttribute('aria-controls')).hidden = !open;
    }
};

window.copyAdminUserUid = async function(uid, button) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    try {
        if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
        await navigator.clipboard.writeText(String(uid));
        if (button) {
            button.textContent = '已複製';
            window.setTimeout(() => { if (button.isConnected) button.textContent = button.dataset.copyLabel || '複製'; }, 1800);
        }
    } catch (err) {
        // 舊版瀏覽器或非安全來源不支援剪貼簿時，仍允許手動複製完整 UID。
        window.prompt('複製完整帳號 UID：', String(uid));
    }
};

window.saveAdminUserRole=async function(uid, selectEl){
    if(trueUserRole!=='admin'||currentUserRole!=='admin')return;
    const desktopSelect = document.getElementById(`adminUserRole-${uid}`);
    const mobileSelect = document.getElementById(`adminMobileUserRole-${uid}`);
    const selects = [desktopSelect, mobileSelect].filter(Boolean);
    const select = selectEl || desktopSelect;
    const user = allUsersCache.find(x => x.uid === uid);
    const previousRole = user?.role || 'sales';
    const role = select?.value || 'sales';
    if (role === previousRole) return;
    selects.forEach(control => { control.disabled = true; });
    try {
        await db.collection('users').doc(uid).set({
            role,
            capabilities:role==='engineer'?['business','engineering']:role==='sales'?['business']:[],
            updatedAt:new Date().toISOString()
        },{merge:true});
        if (user) user.role = role;
        selects.forEach(control => {
            control.value = role;
            control.title = '角色已更新';
        });
        const badge = document.getElementById(`adminUserRoleBadge-${uid}`);
        if (badge) badge.textContent = ROLE_LABELS[role];
    } catch (err) {
        selects.forEach(control => { control.value = previousRole; });
        alert('更新失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        selects.forEach(control => { control.disabled = false; });
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
