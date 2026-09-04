// 三個公司的估價專用章圖片，直接以 Base64 內嵌（避免產生 PDF 時外部圖片造成畫布跨來源污染，無法匯出）
const STAMP_YUSHIN = "assets/stamps/yushin.png";
const STAMP_MORNINGSTAR = "assets/stamps/morningstar.png";
const STAMP_MULTI_LIFE = "assets/stamps/multi-life.png";


// app.js - 估價單系統 / 儀器管理系統 核心邏輯

const firebaseConfig = {
    apiKey: "AIzaSyAmGAU2spWI54ujLyIFTWiX-mXyuau7Vps",
    authDomain: "yu-shing-company.firebaseapp.com",
    projectId: "yu-shing-company",
    storageBucket: "yu-shing-company.firebasestorage.app",
    messagingSenderId: "22622213823",
    appId: "1:22622213823:web:c3f0a9c367a88e271ed80a",
    measurementId: "G-861X26VW6M"
};

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();

// 登入一次之後，不用每次重新輸入帳號密碼：明確指定用「LOCAL」持久化方式，
// 登入狀態會存在瀏覽器本機，關掉分頁、關掉瀏覽器、甚至重開手機，只要沒有登出，
// 下次打開網址還是會自動維持登入狀態（不用再輸入一次帳號密碼）
firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(err => {
    console.error('設定登入持久化失敗：', err);
});

let currentCompany = 'yushin';
let restoringQuoteDraft = false;  // 還原本機草稿的過程中，暫停「重新產生單號」之類的副作用，避免蓋掉草稿裡存的資料
let salesList = [
    { name: "預設業務", code: "01", phone: "0912345678" }
];
let priceList = [];
let activeBrandFilter = 'ALL';
let currentUser = null;      // 目前登入的 Firebase Auth 使用者物件
let currentUserRole = null;  // 'admin' / 'sales' / 'purchaser' / 'engineer' —— 目前實際套用在畫面上的「有效身份」
let trueUserRole = null;     // 真正登入帳號的身份；只有這個是 admin，才能用下面的「檢視身份」切換功能
let mustChangePassword = false;  // 管理員要求這個帳號下次登入必須先改密碼
const ROLE_LABELS = { admin: '管理員', sales: '業務', purchaser: '採購', engineer: '工程師' };
const PERMISSION_LEVELS = { none: 0, view: 1, edit: 2 };
const PERMISSION_PAGES = [
    { key: 'quote', label: '📄 估價單系統', system: true },
    { key: 'quote.create', label: '　建立估價單' },
    { key: 'quote.my', label: '　我的估價單' },
    { key: 'orders', label: '📦 訂單管理系統', system: true },
    { key: 'orders.list', label: '　業務訂單' },
    { key: 'orders.po', label: '　採購訂單' },
    { key: 'equipment', label: '🔬 儀器管理系統', system: true },
    { key: 'admin', label: '⚙️ 管理員雲端後台', system: true }
];
// 權限不在 HTML 內提供預設值，唯一來源是 Firestore settings/rolePermissions。
// 管理員固定保留完整權限，避免誤設後無人能再進入後台修正。
let rolePermissions = {};
let roleDataScopes = {};
let currentUserName = '';    // 目前登入者自己的業務姓名（來自 users 集合）
let currentUserPhone = '';   // 目前登入者自己的電話
let currentUserCode = '';    // 目前登入者自己的業務代號
let appInitialized = false;  // 避免每次登入狀態變化都重複初始化頁面資料
let pendingTab = null;
let salesListLoadPromise = null;
let priceListLoadPromise = null;
let clientHistoryLoadPromise = null;
let quoteFormInitialized = false;

// 儀器管理系統狀態
let equipmentList = [];
let currentEquipmentId = null;

// 管理員後台狀態
let allQuotesCache = [];
let allUsersCache = [];
let salesStatisticsOrders = [];
let keyStatisticBrands = [];
let companyAgencyBrands = { yushin: [], morningstar: [], 'MULTI-LIFE': [] };
let companyAgencyBrandsConfigured = false;
let hiddenBrands = [];       // 舊欄位，保留避免舊資料丟失，畫面已經不再使用黑名單模式
let visibleBrands = [];      // 廠牌管理：白名單模式，勾選（或手動新增）的廠牌才會出現在下拉選單裡
let brandVisibilityConfigured = false;  // 是否已經存過顯示設定；未設定時預設全部顯示，相容既有資料

// 印章圖片常數定義在 stamps-data.js（需在此檔案之前載入）。
// 這裡用防禦性寫法讀取：萬一該檔案沒被正確載入（例如部署時漏傳、路徑錯誤），
// 也只會讓印章顯示空白，不會讓整個 app.js 因為 ReferenceError 而執行中斷、導致登入等功能全部失效。
const _stampYushin = (typeof STAMP_YUSHIN !== 'undefined') ? STAMP_YUSHIN : '';
const _stampMorningstar = (typeof STAMP_MORNINGSTAR !== 'undefined') ? STAMP_MORNINGSTAR : '';
const _stampMultiLife = (typeof STAMP_MULTI_LIFE !== 'undefined') ? STAMP_MULTI_LIFE : '';
if (!_stampYushin || !_stampMorningstar || !_stampMultiLife) {
    console.warn('[提醒] stamps-data.js 沒有正確載入，印章圖片會顯示空白。請確認該檔案有跟 index.html／app.js 放在同一個資料夾並一起部署。');
}

const companyData = {
    yushin: {
        title: "又鑫生物科技有限公司",
        sub: "YU SHING BIO-TECH CO., LTD.",
        addr: "地址：臺北市中山區民生東路1段58號9樓之1",
        contact: "Tel: (02)2100-1008 &nbsp;|&nbsp; Fax: (02)2522-1018 &nbsp;|&nbsp; 統編: 12698994",
        prefix: "YS",
        stamp: _stampYushin
    },
    morningstar: {
        title: "辰星生物科技有限公司",
        sub: "MORNINGSTAR BIO-TECH CO., LTD.",
        addr: "地址：臺北市中正區重慶南路3段21號9樓",
        contact: "統編: 83468656",
        prefix: "MS",
        stamp: _stampMorningstar
    },
    "MULTI-LIFE": {
        title: "鼎新生物科技有限公司",
        sub: "MULTI-LIFE BIOTECHNOLOGY LTD.",
        addr: "地址：臺北市中山區南京東路1段34號7樓",
        contact: "Tel: (02)2568-2059 &nbsp;|&nbsp; Fax: (02)2521-7595 &nbsp;|&nbsp; 統編: 25127434",
        prefix: "DS",
        stamp: _stampMultiLife
    }
};

window.addEventListener('DOMContentLoaded', () => {
    const printBtn = document.getElementById('printBtn');
    if (printBtn) {
        printBtn.addEventListener('click', handleSaveAndPrint);
    }

    const pwInput = document.getElementById('loginPassword');
    if (pwInput) {
        pwInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') handleLogin();
        });
    }

    // 僅查看模式：保留搜尋、篩選、重新整理與開啟明細，攔截會改動資料的控制項。
    const blockReadonlyEdit = event => {
        const section = event.target.closest?.('.content-section');
        if (!section || !section.classList.contains('active')) return;
        const pageKey = getActivePermissionPage();
        if (!pageKey || canEditPage(pageKey)) return;
        const control = event.target.closest('button, input, textarea, select');
        if (!control) return;
        if (control.closest('.sub-nav')) return;
        if (control.closest('.toolbar') && control.type !== 'file' && control.tagName !== 'BUTTON') return;
        if (control.tagName === 'BUTTON') {
            const action = control.getAttribute('onclick') || '';
            const isMutation = /(save|delete|add|toggle|handle|print|generate|upload|transfer|cleanup)/i.test(action) || /^open\w+\(\s*\)\s*;?$/.test(action.trim());
            if (!isMutation) return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.type === 'click' || event.type === 'change') alert('此分頁目前僅可查看，沒有修改權限。');
    };
    document.addEventListener('click', blockReadonlyEdit, true);
    document.addEventListener('change', blockReadonlyEdit, true);
    document.addEventListener('input', blockReadonlyEdit, true);

    // 估價單表單的草稿自動儲存：只要在「建立估價單」區塊裡打字/選擇/切換任何東西，
    // 都會（debounce 一下）把目前整份內容存到本機瀏覽器，這樣關掉分頁重開也不會不見。
    // 用事件代理監聽整個面板一次，不用每個欄位個別加 oninput，qty/單價這類數字輸入
    // 已經在 calculateTotals() 裡存過了，這裡再存一次是安全的（等於覆蓋同樣的內容）。
    const quoteCreatePanel = document.getElementById('quoteCreatePanel');
    if (quoteCreatePanel) {
        let draftSaveTimer = null;
        const scheduleDraftSave = () => {
            clearTimeout(draftSaveTimer);
            draftSaveTimer = setTimeout(() => { if (!restoringQuoteDraft) saveQuoteDraft(); }, 400);
        };
        quoteCreatePanel.addEventListener('input', scheduleDraftSave);
        quoteCreatePanel.addEventListener('change', scheduleDraftSave);
    }

    // 監控登入狀態：未登入顯示登入畫面，登入後依角色初始化系統
    firebase.auth().onAuthStateChanged(function(user) {
        if (user) {
            currentUser = user;
            db.collection('users').doc(user.uid).get().then(doc => {
                if (!doc.exists) throw new Error('找不到此 UID 對應的 users 文件');
                const d = doc.data() || {};
                currentUserRole = d.role || 'sales';
                trueUserRole = currentUserRole;
                currentUserName = d.name || '';
                currentUserPhone = d.phone || '';
                currentUserCode = d.code || '';
                mustChangePassword = !!d.mustChangePassword;
                loadRolePermissions().finally(() => {
                    showApp();
                    if (mustChangePassword) openChangePasswordModal(true);
                });

                // 把自己的登入 Email 同步存回自己的 users 文件，這樣管理員雲端後台才查得到每個帳號的 Email
                // （用來寄送密碼重設信）；只寫自己的資料，不影響、也不需要動到別人的帳號
                if (user.email && d.email !== user.email) {
                    db.collection('users').doc(user.uid).set({ email: user.email }, { merge: true })
                        .catch(err => console.error('同步 Email 失敗：', err));
                }
            }).catch(err => {
                console.error('讀取登入帳號資料失敗：', err);
                currentUserRole = 'sales';
                trueUserRole = 'sales';
                currentUserName = '';
                currentUserPhone = '';
                currentUserCode = '';
                showApp();
                setTimeout(() => alert('無法讀取帳號資料：' + (err.message || err)), 0);
            });
        } else {
            currentUser = null;
            currentUserRole = null;
            trueUserRole = null;
            currentUserName = '';
            currentUserPhone = '';
            currentUserCode = '';
            showLoginScreen();
        }
    });
});

function loadRolePermissions() {
    return db.collection('settings').doc('rolePermissions').get().then(doc => {
        if (!doc.exists) return;
        rolePermissions = doc.exists ? (doc.data().roles || {}) : {};
        roleDataScopes = doc.exists ? (doc.data().dataScopes || {}) : {};
    }).catch(err => console.warn('讀取身份權限設定失敗，將不授予任何非管理員權限：', err));
}

function getPagePermission(pageKey, role = currentUserRole) {
    if (role === 'admin') return 'edit';
    const direct = rolePermissions[role]?.[pageKey] || 'none';
    const parentKey = pageKey.includes('.') ? pageKey.split('.')[0] : '';
    if (!parentKey) return direct;
    const parent = rolePermissions[role]?.[parentKey] || 'none';
    return PERMISSION_LEVELS[parent] < PERMISSION_LEVELS[direct] ? parent : direct;
}

function canAccessPage(pageKey) {
    return PERMISSION_LEVELS[getPagePermission(pageKey)] >= PERMISSION_LEVELS.view;
}

function canEditPage(pageKey) {
    return getPagePermission(pageKey) === 'edit';
}

function canViewAllData(dataType, role = currentUserRole) {
    return role === 'admin' || roleDataScopes[role]?.[dataType] === 'all';
}

function getDataScope(dataType, role = currentUserRole) {
    if (role === 'admin') return 'all';
    return roleDataScopes[role]?.[dataType] || 'none';
}

function belongsToCurrentUser(salesName, ownerUid) {
    if (ownerUid && currentUser?.uid) return ownerUid === currentUser.uid;
    if (!currentUserName) return false;
    return stripPhoneSuffix(salesName || '') === stripPhoneSuffix(currentUserName);
}

function getActivePermissionPage() {
    const section = document.querySelector('.content-section.active');
    if (!section) return '';
    if (section.id === 'quote-system') return document.getElementById('myQuotesPanel')?.style.display === 'block' ? 'quote.my' : 'quote.create';
    if (section.id === 'order-system') return document.getElementById('poListPanel')?.style.display === 'block' ? 'orders.po' : 'orders.list';
    if (section.id === 'equipment-system') return 'equipment';
    if (section.id === 'admin-system') return 'admin';
    return '';
}

function applyPermissionVisibility() {
    document.querySelectorAll('[data-permission-page]').forEach(el => {
        el.style.display = canAccessPage(el.dataset.permissionPage) ? '' : 'none';
    });
    const adminTab = document.getElementById('navAdminTab');
    if (adminTab) adminTab.style.display = trueUserRole === 'admin' && currentUserRole === 'admin' ? '' : 'none';
    const quoteListTab = document.getElementById('qsub-my');
    if (quoteListTab) quoteListTab.innerText = canViewAllData('quotes') ? '📋 全部估價單' : '📋 我的估價單';
    populatePurchaserOrderFilters();
    updateReadonlyNotice();
}

function updateReadonlyNotice() {
    document.querySelectorAll('.readonly-notice').forEach(el => el.remove());
    const pageKey = getActivePermissionPage();
    const section = document.querySelector('.content-section.active');
    if (!section || !pageKey || canEditPage(pageKey)) return;
    const notice = document.createElement('div');
    notice.className = 'readonly-notice no-print';
    notice.style.display = 'block';
    notice.innerText = '🔒 此分頁目前為「僅可查看」，您可以瀏覽與搜尋，但不能新增、修改或刪除資料。';
    section.prepend(notice);
}

function firstAccessibleMainPage() {
    return ['quote', 'orders', 'equipment'].find(canAccessPage) || (currentUserRole === 'admin' ? 'admin' : '');
}

function showLoginScreen() {
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    if (loginScreen) loginScreen.style.display = 'flex';
    if (appContainer) appContainer.style.display = 'none';

    const pwField = document.getElementById('loginPassword');
    if (pwField) pwField.value = '';
}

function showApp() {
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    if (loginScreen) loginScreen.style.display = 'none';
    if (appContainer) appContainer.style.display = 'block';

    const label = document.getElementById('authUserLabel');
    if (label) {
        label.innerText = `${currentUser.email}（${ROLE_LABELS[currentUserRole] || '業務'}）`;
    }

    // 「檢視身份」下拉選單：只有真正的管理員帳號才看得到，可以切換畫面上要用哪種身份的視角來檢視系統，
    // 方便管理員確認/測試各角色實際看到的畫面跟權限是否正確；這只是切換前端顯示邏輯，
    // 不會真的改變 Firebase 帳號本身的角色，Firestore 安全規則仍然是照登入帳號真正的角色在判斷
    const viewAsSelect = document.getElementById('viewAsRoleSelect');
    if (viewAsSelect) {
        viewAsSelect.style.display = trueUserRole === 'admin' ? '' : 'none';
        viewAsSelect.value = currentUserRole;
    }

    applyPermissionVisibility();
    const activeSection = document.querySelector('.content-section.active');
    const activeMainKey = activeSection ? { 'quote-system':'quote', 'order-system':'orders', 'equipment-system':'equipment', 'admin-system':'admin' }[activeSection.id] : '';
    if (activeMainKey && !canAccessPage(activeMainKey)) {
        const fallback = firstAccessibleMainPage();
        const fallbackId = { quote:'quote-system', orders:'order-system', equipment:'equipment-system', admin:'admin-system' }[fallback];
        if (fallbackId) {
            document.getElementById('noPermissionMessage')?.remove();
            setTimeout(() => actuallySwitchMainTab(fallbackId), 0);
        } else {
            document.querySelectorAll('.content-section').forEach(section => section.classList.remove('active'));
            if (!document.getElementById('noPermissionMessage')) {
                const message = document.createElement('div');
                message.id = 'noPermissionMessage';
                message.className = 'content-section active';
                message.innerHTML = '<div class="empty-hint">此身份尚未由管理員授予任何系統權限，請聯絡管理員設定。</div>';
                appContainer.appendChild(message);
            }
        }
    }

    // 只有採購／管理員才看得到「產生訂購單」按鈕跟業務訂單裡的成本/利潤欄位
    const generatePoBtn = document.getElementById('generatePoBtn');
    if (generatePoBtn) {
        generatePoBtn.style.display = (currentUserRole === 'purchaser' || currentUserRole === 'admin') ? '' : 'none';
    }
    const purchaseOrderActionBar = document.getElementById('purchaseOrderActionBar');
    if (purchaseOrderActionBar) {
        purchaseOrderActionBar.style.display = (currentUserRole === 'purchaser' || currentUserRole === 'admin') ? '' : 'none';
    }
    const orderCostFieldWrap = document.getElementById('orderCostFieldWrap');
    if (orderCostFieldWrap) {
        orderCostFieldWrap.style.display = (currentUserRole === 'purchaser' || currentUserRole === 'admin') ? '' : 'none';
    }
    const osubPo = document.getElementById('osub-po');
    if (osubPo) osubPo.style.display = canAccessPage('orders.po') ? '' : 'none';

    if (!appInitialized) {
        appInitialized = true;
        initDate();
    }
    if (activeMainKey && canAccessPage(activeMainKey)) initializePageData(activeMainKey);
}

function initializePageData(mainKey) {
    if (mainKey === 'quote') ensureQuoteFormInitialized();
    if (mainKey === 'orders') Promise.all([ensureSalesListLoaded(), ensurePriceListLoaded()]).then(loadOrdersFromCloud);
    if (mainKey === 'equipment') Promise.all([ensureSalesListLoaded(), ensurePriceListLoaded()]).then(() => {
        populateEquipmentSalesDropdown();
        loadEquipmentFromCloud();
    });
    if (mainKey === 'admin') ensureSalesListLoaded().then(reloadSalesFromUsers);
}

function ensureSalesListLoaded() {
    if (!salesListLoadPromise) salesListLoadPromise = initSalesList();
    return salesListLoadPromise;
}

function ensurePriceListLoaded() {
    if (!priceListLoadPromise) priceListLoadPromise = loadPriceListFromCloud();
    return priceListLoadPromise;
}

function ensureClientHistoryLoaded() {
    if (!clientHistoryLoadPromise) clientHistoryLoadPromise = loadClientHistory();
    return clientHistoryLoadPromise;
}

function ensureQuoteFormInitialized() {
    if (quoteFormInitialized) return;
    quoteFormInitialized = true;
    Promise.all([ensureSalesListLoaded(), ensurePriceListLoaded(), ensureClientHistoryLoaded()]).finally(() => {
        const draft = loadQuoteDraft();
        if (draft) restoreQuoteDraft(draft);
        else {
            const savedValidDays = localStorage.getItem('quote_valid_days');
            if (savedValidDays) document.getElementById('validDays').value = savedValidDays;
            if (!document.getElementById('quoteItems').rows.length) addQuoteRow();
            switchCompany('yushin');
        }
    });
}


window.openChangePasswordModal = function(forced) {
    const overlay = document.getElementById('changePasswordOverlay');
    if (!overlay) return;
    document.getElementById('newPassword').value = '';
    document.getElementById('confirmNewPassword').value = '';
    const msg = document.getElementById('changePasswordMessage');
    msg.style.color = '#c00';
    msg.innerText = forced ? '管理員要求您重新設定密碼，請設定新密碼後才能繼續使用系統。' : '';
    overlay.dataset.forced = forced ? '1' : '';
    const cancelBtn = document.getElementById('changePasswordCancelBtn');
    if (cancelBtn) cancelBtn.style.display = forced ? 'none' : '';
    overlay.classList.add('active');
};

window.closeChangePasswordModal = function() {
    const overlay = document.getElementById('changePasswordOverlay');
    // 被管理員強制要求修改密碼時，不能按取消跳過，一定要先設好新密碼才能關閉這個視窗
    if (overlay && overlay.dataset.forced === '1') return;
    if (overlay) overlay.classList.remove('active');
};

// 密碼修改成功後，不管是不是強制模式，一律真正關閉視窗（跳過強制檢查）
function forceCloseChangePasswordModal() {
    const overlay = document.getElementById('changePasswordOverlay');
    if (!overlay) return;
    overlay.dataset.forced = '';
    const cancelBtn = document.getElementById('changePasswordCancelBtn');
    if (cancelBtn) cancelBtn.style.display = '';
    overlay.classList.remove('active');
}

window.handleChangePassword = function() {
    const newPassword = document.getElementById('newPassword').value;
    const confirmPassword = document.getElementById('confirmNewPassword').value;
    const msg = document.getElementById('changePasswordMessage');
    msg.style.color = '#c00';

    if (!currentUser) {
        msg.innerText = '目前沒有登入帳號。';
        return;
    }
    if (newPassword.length < 6) {
        msg.innerText = '新密碼至少需要 6 個字元。';
        return;
    }
    if (newPassword !== confirmPassword) {
        msg.innerText = '兩次輸入的新密碼不一致。';
        return;
    }

    currentUser.updatePassword(newPassword).then(() => {
        msg.style.color = '#187a2f';
        msg.innerText = '密碼修改成功。';

        const overlay = document.getElementById('changePasswordOverlay');
        const wasForced = overlay && overlay.dataset.forced === '1';

        if (wasForced) {
            // 清掉「強制修改密碼」的記號，這樣下次登入就不會再被擋
            db.collection('users').doc(currentUser.uid).set({ mustChangePassword: false }, { merge: true })
                .catch(err => console.error('清除強制改密碼記號失敗：', err))
                .finally(() => {
                    mustChangePassword = false;
                    setTimeout(forceCloseChangePasswordModal, 800);
                });
        } else {
            setTimeout(closeChangePasswordModal, 800);
        }
    }).catch(err => {
        console.error(err);
        if (err && err.code === 'auth/requires-recent-login') {
            msg.innerText = '為了安全，請先登出再重新登入後再修改密碼。';
        } else if (err && err.code === 'auth/weak-password') {
            msg.innerText = '密碼強度不足，請使用至少 6 個字元。';
        } else {
            msg.innerText = '修改密碼失敗：' + (err.message || '請稍後再試');
        }
    });
};

window.handleForgotPassword = function() {
    const emailInput = document.getElementById('loginEmail');
    const errorEl = document.getElementById('loginError');
    const email = (emailInput.value || '').trim();
    if (!email) {
        if (errorEl) errorEl.innerText = '請先輸入帳號 Email，再點選「忘記密碼」。';
        emailInput.focus();
        return;
    }

    if (errorEl) errorEl.innerText = '正在寄送密碼重設信…';
    firebase.auth().sendPasswordResetEmail(email).then(() => {
        if (errorEl) errorEl.innerText = '密碼重設信已寄出，請至 Email 收信並依指示設定新密碼。';
    }).catch(err => {
        console.error(err);
        if (errorEl) {
            if (err && err.code === 'auth/invalid-email') {
                errorEl.innerText = 'Email 格式不正確。';
            } else {
                errorEl.innerText = '無法寄出密碼重設信，請確認 Email 是否正確或聯絡管理員。';
            }
        }
    });
};

window.handleLogin = function() {
    const email = (document.getElementById('loginEmail').value || '').trim();
    const password = document.getElementById('loginPassword').value || '';
    const errorEl = document.getElementById('loginError');
    if (errorEl) errorEl.innerText = '';

    if (!email || !password) {
        if (errorEl) errorEl.innerText = '請輸入帳號與密碼';
        return;
    }

    firebase.auth().signInWithEmailAndPassword(email, password).catch(() => {
        if (errorEl) errorEl.innerText = '登入失敗，請確認帳號密碼是否正確。';
    });
};

window.handleLogout = function() {
    firebase.auth().signOut();
};

/* =========================================================
   主分頁切換
   ========================================================= */
window.switchMainTab = function(tabId, el) {
    actuallySwitchMainTab(tabId, el);
};

// 「檢視身份」切換：只是把畫面上用來判斷權限/欄位的 currentUserRole 換成別的角色，
// 讓管理員可以確認/測試各角色實際看到的畫面長怎樣。真正的身份還是 trueUserRole，
// 這裡不會改動 Firebase 帳號本身，Firestore 的存取權限仍然是照登入帳號真正的角色在判斷。
window.switchViewRole = function(role) {
    if (trueUserRole !== 'admin') return;
    currentUserRole = role;
    showApp();

    // 重新整理跟身份有關的資料快取，這樣不管接下來切到哪個分頁，看到的都已經是這個模擬身份該有的範圍
    loadMyQuotesFromCloud();
    loadOrdersFromCloud();
    loadEquipmentFromCloud();

    // 如果目前正在看管理員後台，但模擬身份已經不是管理員，就先跳轉離開，避免卡在打不開的分頁
    const activeSection = document.querySelector('.content-section.active');
    if (activeSection && activeSection.id === 'admin-system' && currentUserRole !== 'admin') {
        actuallySwitchMainTab('quote-system');
    }
};

function actuallySwitchMainTab(tabId, el) {
    const mainKey = { 'quote-system':'quote', 'order-system':'orders', 'equipment-system':'equipment', 'admin-system':'admin' }[tabId];
    if (!mainKey || !canAccessPage(mainKey) || (mainKey === 'admin' && trueUserRole !== 'admin')) {
        alert('您沒有權限進入這個系統。');
        return;
    }

    document.querySelectorAll('.content-section').forEach(el2 => el2.classList.remove('active'));
    document.querySelectorAll('.nav-tab').forEach(el2 => el2.classList.remove('active'));

    document.getElementById(tabId).classList.add('active');
    if (el) {
        el.classList.add('active');
    } else {
        const tab = document.querySelector(`.nav-tab[data-permission-page="${mainKey}"]`);
        if (tab) tab.classList.add('active');
    }

    if (tabId === 'equipment-system') {
        initializePageData('equipment');
    } else if (tabId === 'order-system') {
        const orderView = canAccessPage('orders.list') ? 'list' : 'po';
        switchOrderView(orderView, document.getElementById(orderView === 'list' ? 'osub-list' : 'osub-po'));
        initializePageData('orders');
    } else if (tabId === 'quote-system') {
        initializePageData('quote');
        const quoteView = canAccessPage('quote.create') ? 'create' : 'my';
        switchQuoteView(quoteView, document.getElementById(quoteView === 'create' ? 'qsub-create' : 'qsub-my'));
    } else if (tabId === 'admin-system') {
        initializePageData('admin');
    }
    updateReadonlyNotice();
}

/* =========================================================
   估價單系統
   ========================================================= */
// 業務名單來源改為 users 集合（與登入帳號綁定，name/code/phone/role 皆存在同一份文件）
function initSalesList() {
    return db.collection('users').get().then(snapshot => {
        const list = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            if (d.name && d.code) {
                list.push({ uid: doc.id, code: d.code, name: d.name, phone: d.phone || '', role: d.role || 'sales' });
            }
        });

        if (list.length > 0) {
            list.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
            salesList = list;
            populateSalesDropdown();
            populateEquipmentSalesDropdown();
        }
    }).catch(err => {
        console.error('讀取 users 人員名單失敗：', err);
        salesList = [];
        populateSalesDropdown();
        populateEquipmentSalesDropdown();
    });
}

function applyCompanyTheme(compKey, el) {
    currentCompany = compKey;
    document.querySelectorAll('.company-sub-nav .sub-tab').forEach(t => t.classList.remove('active'));

    const targetTab = document.getElementById(`sub-${compKey}`);
    if (targetTab) {
        targetTab.classList.add('active');
    } else if (el) {
        el.classList.add('active');
    }

    const info = companyData[compKey];
    if (info) {
        document.getElementById('compTitle').innerText = info.title;
        document.getElementById('compSub').innerText = info.sub;
        document.getElementById('compAddr').innerText = info.addr;
        document.getElementById('compContact').innerHTML = info.contact;
        document.getElementById('companyStamp').src = info.stamp;
    }

    const printableEl = document.getElementById('printableQuote');
    printableEl.classList.remove('theme-yushin', 'theme-morningstar', 'theme-MULTI-LIFE');
    printableEl.classList.add(`theme-${compKey}`);

    populateQuoteBrandDropdowns();
}

// 手動切換公司分頁時，套用主題之外還要重新產生一個新單號（原本的行為）
window.switchCompany = function(compKey, el) {
    applyCompanyTheme(compKey, el);
    generateQuoteNo();
};

function initDate() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    document.getElementById('quoteDate').value = `${yyyy}/${mm}/${dd}`;
}

function getFormattedDateCode() {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
}

window.generateQuoteNo = async function() {
    const info = companyData[currentCompany];
    const dateStr = getFormattedDateCode();

    const salesInput = document.getElementById('salesName');
    let salesCode = "01";

    if (salesInput && salesInput.value) {
        const typedName = salesInput.value.trim();
        if (typedName === currentUserName && currentUserCode) {
            // 輸入的就是自己，直接用登入時已經取得的代號，不依賴 salesList 是否有正確收錄自己
            salesCode = currentUserCode;
        } else {
            const match = salesList.find(s => s.name === typedName);
            if (match && match.code) salesCode = match.code;
        }
    }

    const prefix = `${info.prefix}-${dateStr}-${salesCode}-`;

    try {
        const snapshot = await db.collection('quotes')
            .where('quoteNo', '>=', prefix)
            .where('quoteNo', '<=', prefix + '\uf8ff')
            .get();

        // 用「目前已存在的最大流水號 + 1」而非「筆數 + 1」：
        // 因為 Firestore 是拿 quoteNo 當文件 ID，如果中間有一張估價單被刪除，
        // 用筆數計算會讓新單號跟既有的某張估價單撞號，寫入時直接覆蓋掉那張舊資料
        let maxSeq = 0;
        snapshot.forEach(doc => {
            const seqStr = (doc.data().quoteNo || '').split('-').pop();
            const seq = parseInt(seqStr, 10);
            if (!isNaN(seq) && seq > maxSeq) {
                maxSeq = seq;
            }
        });
        const count = maxSeq + 1;
        document.getElementById('quoteNo').value = `${prefix}${String(count).padStart(2, '0')}`;
    } catch (e) {
        document.getElementById('quoteNo').value = `${prefix}01`;
    }
    if (!restoringQuoteDraft) saveQuoteDraft();
};

window.onSalesChange = function() {
    generateQuoteNo();
    updateSalesPhoneDisplay();
};

// 建立估價單時，「負責業務」只顯示角色為業務或工程師的人員；
// 管理員與採購不會出現在這個選單中。舊版 sales.csv 沒有角色資料時，仍視為業務保留相容性。
function populateSalesDropdown() {
    const select = document.getElementById('salesName');
    if (!select) return;

    const visibleList = salesList.filter(s => {
        const role = (s.role || 'sales').toLowerCase();
        return role === 'sales' || role === 'engineer';
    });

    const currentValue = select.value;
    select.innerHTML = '<option value="">請選擇業務</option>';
    visibleList.forEach(s => {
        if (s.name) {
            const option = document.createElement('option');
            option.value = s.name;
            option.text = s.name;
            select.appendChild(option);
        }
    });

    // 如果有等待中的草稿業務姓名（頁面載入時從本機草稿還原的），優先套用這個，只套用一次
    let valueToApply = currentValue;
    if (window._pendingDraftSalesName !== undefined) {
        valueToApply = window._pendingDraftSalesName;
        delete window._pendingDraftSalesName;
    }
    // 若原本選的人仍在名單裡就保留選擇，否則清空，絕不自動帶入
    select.value = visibleList.some(s => s.name === valueToApply) ? valueToApply : '';

    // 還原草稿的過程中不要重新產生單號，沿用草稿裡存的那組
    if (!restoringQuoteDraft) generateQuoteNo();
    updateSalesPhoneDisplay();
}

// 依目前輸入的業務姓名，更新旁邊顯示的電話號碼
function updateSalesPhoneDisplay() {
    const input = document.getElementById('salesName');
    const phoneSpan = document.getElementById('salesPhone');
    if (!input || !phoneSpan) return;

    const match = salesList.find(s => s.name === input.value.trim());
    phoneSpan.innerText = match ? (match.phone || '') : '';
}

function populateEquipmentSalesDropdown() {
    const select = document.getElementById('eqSales');
    if (!select) return;
    select.innerHTML = '<option value="">未指定業務</option>';
    const visibleList = salesList; // 顯示全部業務
    visibleList.forEach(s => {
        if (s.name) {
            const option = document.createElement('option');
            option.value = s.name;
            option.text = s.name;
            select.appendChild(option);
        }
    });
}

function loadPriceListFromCloud() {
    const priceDoc = db.collection('settings').doc('prices');
    // 新版每個廠牌各存一份文件；舊版仍保留從同一文件的 list 欄位讀取，避免既有資料失效。
    const pricesPromise = priceDoc.get().then(doc => {
        const meta = doc.exists ? doc.data() : {};
        if (meta.storage === 'brands' && Array.isArray(meta.brands)) {
            // 資料量大的廠牌會被拆成多份分片文件（price-brand-xxx、price-brand-xxx-part1...），
            // 這裡依 chunkCount 展開所有分片 ID 一起讀回，再合併成完整清單。
            const chunkDocIds = [];
            meta.brands.forEach(brand => {
                const count = brand.chunkCount || 1;
                for (let i = 0; i < count; i++) {
                    chunkDocIds.push(i === 0 ? brand.id : `${brand.id}-part${i}`);
                }
            });
            return Promise.all(chunkDocIds.map(id =>
                db.collection('settings').doc(id).get()
            )).then(docs => {
                const replacementBrands = new Set(meta.brands.map(brand => brand.name));
                const legacyItems = Array.isArray(meta.list) ? meta.list.filter(item => !replacementBrands.has((item.brand || '').trim())) : [];
                priceList = legacyItems.concat(docs.flatMap(brandDoc => {
                    const data = brandDoc.exists ? brandDoc.data() : {};
                    return Array.isArray(data.items) ? data.items : [];
                }));
                refreshPriceDatalists();
                renderKeyStatisticBrands();
            });
        }
        priceList = meta.list || [];
        refreshPriceDatalists();
        renderKeyStatisticBrands();
    }).catch(() => {});
    return Promise.all([pricesPromise, loadSalesStatisticsSettings(), loadCompanyAgencyBrandSettings()]);
}

function loadCompanyAgencyBrandSettings() {
    return db.collection('settings').doc('companyAgencyBrands').get().then(doc => {
        companyAgencyBrandsConfigured = doc.exists;
        const data = doc.exists ? doc.data() : {};
        const saved = data.companies || {};
        companyAgencyBrands = {
            yushin: saved.yushin || [],
            morningstar: saved.morningstar || [],
            'MULTI-LIFE': saved['MULTI-LIFE'] || []
        };
        // visibleBrands 欄位存在（即使是空陣列）才代表管理員存過白名單設定；沒有這個欄位時維持全部顯示，相容既有資料
        brandVisibilityConfigured = doc.exists && Array.isArray(data.visibleBrands);
        visibleBrands = data.visibleBrands || [];
        renderBrandVisibilitySettings();
        renderCompanyAgencyBrandSettings();
        refreshPriceDatalists();
    }).catch(() => {
        companyAgencyBrandsConfigured = false;
        brandVisibilityConfigured = false;
        visibleBrands = [];
    });
}

function loadSalesStatisticsSettings() {
    return db.collection('settings').doc('salesStatistics').get().then(doc => {
        keyStatisticBrands = doc.exists ? (doc.data().keyBrands || []) : [];
        renderKeyStatisticBrands();
        if (salesStatisticsOrders.length) renderSalesStatistics();
    }).catch(() => {
        keyStatisticBrands = [];
        renderKeyStatisticBrands();
    });
}

function refreshPriceDatalists() {
    const cnList = document.getElementById('priceNameCnList');
    const enList = document.getElementById('priceNameEnList');
    const modelList = document.getElementById('priceModelList');
    if (!cnList || !enList) return;
    cnList.innerHTML = '';
    enList.innerHTML = '';
    if (modelList) modelList.innerHTML = '';
    priceList.forEach(p => {
        if (p.nameCn) {
            const opt = document.createElement('option');
            opt.value = p.nameCn;
            cnList.appendChild(opt);
        }
        if (p.nameEn) {
            const opt = document.createElement('option');
            opt.value = p.nameEn;
            enList.appendChild(opt);
        }
        if (p.model && modelList) {
            const opt = document.createElement('option');
            opt.value = p.model;
            modelList.appendChild(opt);
        }
    });
    populateOrderBrandDropdown();
    populateEquipmentBrandDropdown();
    populateQuoteBrandDropdowns();
}

// 廠牌下拉選單共用邏輯：選項來自價格表出現過的所有廠牌，最後固定加一個「其他」讓使用者自行輸入；
// 「廠牌管理」存過白名單設定後，改成只列出被勾選（或手動新增）的廠牌，其餘只能透過「其他」自行輸入
function getPriceListBrands(includeMaintenance = false) {
    let brandsSet;
    if (brandVisibilityConfigured) {
        brandsSet = new Set(visibleBrands);
    } else {
        brandsSet = new Set();
        priceList.forEach(p => {
            if (p.brand && p.brand.trim()) brandsSet.add(p.brand.trim());
        });
    }
    if (includeMaintenance) brandsSet.add('維修');
    return Array.from(brandsSet).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

// 給「廠牌管理」設定畫面用：列出價目表裡出現過的廠牌，加上目前已經手動新增（但價目表裡沒有）的自訂廠牌，
// 這樣管理員才看得到全部可以勾選/取消的項目
function getAllPriceListBrandsRaw() {
    const brandsSet = new Set();
    priceList.forEach(p => {
        if (p.brand && p.brand.trim()) brandsSet.add(p.brand.trim());
    });
    visibleBrands.forEach(b => { if (b) brandsSet.add(b); });
    return Array.from(brandsSet).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

// 分公司代理廠牌清單裡的「其他廠牌」是特殊項目，代表這間公司是否開放「其他（自行輸入）」，不是一個真的廠牌名稱
const OTHER_BRAND_OPTION_KEY = '其他廠牌';

function isCompanyBrandAllowed(company, brand) {
    // 「維修」屬服務項目，可由三間分公司開立；尚未建立設定時保留既有的全部廠牌行為。
    if (brand === '維修' || !companyAgencyBrandsConfigured) return true;
    return (companyAgencyBrands[company] || []).includes(brand);
}

function isCompanyOtherOptionAllowed(company) {
    if (!companyAgencyBrandsConfigured) return true;
    return (companyAgencyBrands[company] || []).includes(OTHER_BRAND_OPTION_KEY);
}

function getCompanySelectableBrands(company) {
    return getPriceListBrands(true).filter(brand => isCompanyBrandAllowed(company, brand));
}

// 估價單的廠牌只使用價目表中已有的廠牌；載入舊估價單時若廠牌已不在價目表，
// 仍暫時顯示該舊值，避免一開啟舊單就把歷史資料洗掉。
function quoteBrandOptions(selectedBrand) {
    const selected = (selectedBrand || '').trim();
    const brands = getCompanySelectableBrands(currentCompany);
    if (selected && selected !== '其他' && !brands.includes(selected)) brands.push(selected);
    const showOtherOption = isCompanyOtherOptionAllowed(currentCompany) || selected === '其他';
    return ['<option value="">請選擇廠牌</option>']
        .concat(brands.map(brand => `<option value="${escapeAttr(brand)}"${brand === selected ? ' selected' : ''}>${escapeHtml(brand)}</option>`))
        .concat(showOtherOption ? `<option value="其他"${selected === '其他' ? ' selected' : ''}>其他（自行輸入）</option>` : '')
        .join('');
}

function populateBrandSelect(select, placeholderText, includeMaintenance = false) {
    if (!select) return;
    const currentValue = select.value;
    select.innerHTML = `<option value="">${placeholderText}</option>`;
    getPriceListBrands(includeMaintenance).forEach(b => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.text = b;
        select.appendChild(opt);
    });
    const otherOpt = document.createElement('option');
    otherOpt.value = '其他';
    otherOpt.text = '其他（自行輸入）';
    select.appendChild(otherOpt);
    if ([...select.options].some(o => o.value === currentValue)) select.value = currentValue;
}

// 依價格表比對到的廠牌，補進下拉選單（如果原本不在清單裡）並選取，永遠排在「其他」之前
function selectBrandInDropdown(select, brandName) {
    if (!select || !brandName) return;
    if (![...select.options].some(o => o.value === brandName)) {
        const opt = document.createElement('option');
        opt.value = brandName;
        opt.text = brandName;
        const otherOption = [...select.options].find(o => o.value === '其他');
        if (otherOption) select.insertBefore(opt, otherOption);
        else select.appendChild(opt);
    }
    select.value = brandName;
}

function populateOrderBrandDropdown() {
    populateBrandSelect(document.getElementById('orderBrand'), '請選擇廠牌', true);
    onOrderBrandSelectChange();
}

function populateQuoteBrandDropdowns() {
    document.querySelectorAll('#quoteItems .item-brand').forEach(select => {
        const currentValue = select.value;
        select.innerHTML = quoteBrandOptions(currentValue);
        select.value = currentValue;
    });
}

function quoteRowBrandValue(row) {
    const select = row.querySelector('.item-brand');
    if (!select) return '';
    if (select.value !== '其他') return select.value.trim();
    return (row.querySelector('.item-brand-other')?.value || '').trim();
}

window.onQuoteBrandSelectChange = function(select) {
    const row = select.closest('tr');
    const otherInput = row?.querySelector('.item-brand-other');
    if (!otherInput) return;
    const isOther = select.value === '其他';
    otherInput.style.display = isOther ? '' : 'none';
    if (!isOther) otherInput.value = '';
};

function populateEquipmentBrandDropdown() {
    populateBrandSelect(document.getElementById('eqBrand'), '請選擇廠牌');
    onEqBrandSelectChange();
}

// 廠牌選單選到「其他」時，顯示旁邊的文字輸入框讓使用者自行輸入；選別的廠牌就隱藏並清空
window.onOrderBrandSelectChange = function() {
    const select = document.getElementById('orderBrand');
    const otherInput = document.getElementById('orderBrandOther');
    if (!select || !otherInput) return;
    if (select.value === '其他') {
        otherInput.style.display = '';
    } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
    }
};

window.onEqBrandSelectChange = function() {
    const select = document.getElementById('eqBrand');
    const otherInput = document.getElementById('eqBrandOther');
    if (!select || !otherInput) return;
    if (select.value === '其他') {
        otherInput.style.display = '';
    } else {
        otherInput.style.display = 'none';
        otherInput.value = '';
    }
};

// 取得目前廠牌欄位真正的值：選了「其他」就取旁邊文字框的內容，否則直接取下拉選單的值
function getBrandFieldValue(selectId, otherInputId) {
    const select = document.getElementById(selectId);
    if (!select) return '';
    if (select.value === '其他') {
        const otherInput = document.getElementById(otherInputId);
        return otherInput ? otherInput.value.trim() : '';
    }
    return select.value.trim();
}

// 新增訂單時輸入「貨號」，依價格表帶出廠牌與品名
window.onOrderItemCodeChange = function(input) {
    const value = input.value.trim();
    if (!value) return;
    const match = priceList.find(p => p.model && p.model.trim() === value);
    if (!match) return;

    if (match.brand) {
        selectBrandInDropdown(document.getElementById('orderBrand'), match.brand);
        onOrderBrandSelectChange();
    }

    const itemNameInput = document.getElementById('orderItemName');
    if (itemNameInput) itemNameInput.value = match.nameCn || match.nameEn || '';

    // 產品線只隨訂單資料保存供後台統計，不額外出現在業務端的廠牌下拉選單。
    input.dataset.productLine = match.productLine || '';
    input.dataset.productType = match.productType || '';

    // 價目表如果有登記這個貨號的成本，自動帶進「含稅成本」欄位（只有採購／管理員看得到這個欄位）
    const costInput = document.getElementById('orderCostPrice');
    if (costInput && match.cost) costInput.value = match.cost;
};

// 客戶名稱自動完成：僅抓「最近 10 筆」估價單取樣，避免隨估價單累積而讀取量無上限增長
function loadClientHistory() {
    return db.collection('quotes').orderBy('quoteNo', 'desc').limit(10).get().then(snapshot => {
        const clientListDatalist = document.getElementById('clientList');
        if (!clientListDatalist) return;

        const clients = new Set();
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.clientName) clients.add(data.clientName);
        });

        clientListDatalist.innerHTML = '';
        clients.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c;
            clientListDatalist.appendChild(opt);
        });
    }).catch(() => {});
}

window.saveToStorage = function() {
    const validDays = document.getElementById('validDays').value;
    localStorage.setItem('quote_valid_days', validDays);
};

window.addQuoteRow = function(itemData = {}) {
    const tbody = document.getElementById('quoteItems');
    const rowCount = tbody.rows.length + 1;
    const tr = document.createElement('tr');

    tr.innerHTML = `
        <td data-th="項次">${rowCount}</td>
        <td>
            <div class="item-input-group">
                <div class="field-row">
                    <label>英文品名：</label>
                    <input type="text" class="item-en" list="priceNameEnList" value="${itemData.nameEn || ''}">
                </div>
                <div class="field-row">
                    <label>中文品名：</label>
                    <input type="text" class="item-cn" list="priceNameCnList" value="${itemData.nameCn || ''}" onchange="onItemCnChange(this)">
                </div>

                <div class="item-row-pair">
                    <div>
                        <label>貨號：</label>
                        <input type="text" class="item-model" list="priceModelList" value="${itemData.model || ''}" onchange="onItemModelChange(this)">
                    </div>
                    <div class="item-brand-field">
                        <label>廠牌：</label>
                        <select class="item-brand" onchange="onQuoteBrandSelectChange(this)">${quoteBrandOptions(itemData.brand)}</select>
                        <input type="text" class="item-brand-other" placeholder="請輸入廠牌" style="display:none;margin-top:4px;width:100%;box-sizing:border-box;">
                        <input type="hidden" class="item-product-line" value="${itemData.productLine || ''}">
                        <input type="hidden" class="item-product-type" value="${itemData.productType || ''}">
                    </div>
                </div>

                <div class="field-row">
                    <label>規格：</label>
                    <textarea class="item-spec" placeholder=" ">${itemData.spec || ''}</textarea>
                </div>
            </div>
        </td>
        <td data-th="數量"><input type="number" class="qty" value="${itemData.qty || 1}" min="1" oninput="calculateTotals()"></td>
        <td data-th="含稅單價"><input type="number" class="inc-price" value="${itemData.price || 0}" oninput="onIncPriceChange(this)"></td>
        <td data-th="未稅單價"><input type="number" class="ex-price" value="${itemData.exPrice || ((itemData.price || 0) / 1.05).toFixed(2)}" oninput="onExPriceChange(this)"></td>
        <td data-th="含稅小計"><input type="number" class="subtotal-inc" value="${itemData.subtotal || 0}" readonly style="background-color: #f9f9f9;"></td>
        <td class="no-print"><button type="button" class="btn-danger" onclick="removeQuoteRow(this)">刪除</button></td>
    `;

    tbody.appendChild(tr);
    onQuoteBrandSelectChange(tr.querySelector('.item-brand'));
    calculateTotals();
};

window.onItemCnChange = function(input) {
    const match = priceList.find(p => p.nameCn === input.value);
    if (!match) return;
    const row = input.closest('tr');
    row.querySelector('.item-en').value = match.nameEn || '';
    row.querySelector('.item-model').value = match.model || '';
    row.querySelector('.item-brand').value = match.brand || '';
    row.querySelector('.item-product-line').value = match.productLine || '';
    row.querySelector('.item-product-type').value = match.productType || '';
    if (match.price) {
        row.querySelector('.inc-price').value = match.price;
        onIncPriceChange(row.querySelector('.inc-price'));
    }
};

window.onItemModelChange = function(input) {
    const value = input.value.trim();
    if (!value) return;
    const match = priceList.find(p => p.model && p.model.trim() === value);
    if (!match) return;
    const row = input.closest('tr');
    row.querySelector('.item-en').value = match.nameEn || '';
    row.querySelector('.item-cn').value = match.nameCn || '';
    row.querySelector('.item-brand').value = match.brand || '';
    row.querySelector('.item-product-line').value = match.productLine || '';
    row.querySelector('.item-product-type').value = match.productType || '';
    if (match.price) {
        row.querySelector('.inc-price').value = match.price;
        onIncPriceChange(row.querySelector('.inc-price'));
    }
};

window.onIncPriceChange = function(input) {
    const row = input.closest('tr');
    const incPrice = parseFloat(input.value) || 0;
    const exPriceInput = row.querySelector('.ex-price');

    exPriceInput.value = (incPrice / 1.05).toFixed(2);
    calculateTotals();
};

// 帶入舊估價單時，畫面上顯示的是那張單當初存下來的舊價格，不會自動比對現在的價目表。
// 這個功能讓使用者可以一次把整張單的品項，都重新依「貨號」→「中文品名」的順序去比對目前的價目表，
// 有找到就更新單價（連帶更新英文品名/廠牌），找不到的品項維持原樣不動，最後跳出更新結果讓使用者確認
window.refreshAllItemPricesFromPriceList = function() {
    const rows = document.querySelectorAll('#quoteItems tr');
    if (rows.length === 0) {
        alert('目前沒有任何品項可以更新。');
        return;
    }
    if (!confirm(`確定要把目前這 ${rows.length} 個品項，都依貨號／中文品名重新比對現在的價目表、更新單價嗎？\n找不到對應品項的列不會被更動；已經比對到的列，原本的單價會被目前價目表的價格蓋掉。`)) {
        return;
    }

    let updated = 0;
    let notFound = 0;

    rows.forEach(row => {
        const modelInput = row.querySelector('.item-model');
        const cnInput = row.querySelector('.item-cn');
        const model = (modelInput.value || '').trim();
        const cn = (cnInput.value || '').trim();

        // 優先用貨號比對（比較不會撞名），貨號比對不到才退而用中文品名比對
        let match = model ? priceList.find(p => p.model && p.model.trim() === model) : null;
        if (!match && cn) match = priceList.find(p => p.nameCn === cn);

        if (!match) {
            notFound++;
            return;
        }

        row.querySelector('.item-en').value = match.nameEn || '';
        row.querySelector('.item-cn').value = match.nameCn || '';
        row.querySelector('.item-model').value = match.model || '';
        row.querySelector('.item-brand').value = match.brand || '';
        row.querySelector('.item-product-line').value = match.productLine || '';
        row.querySelector('.item-product-type').value = match.productType || '';
        if (match.price) {
            const incPriceInput = row.querySelector('.inc-price');
            incPriceInput.value = match.price;
            onIncPriceChange(incPriceInput);
            updated++;
        }
    });

    calculateTotals();

    let msg = `已更新 ${updated} 個品項的單價。`;
    if (notFound > 0) msg += `\n有 ${notFound} 個品項在目前的價目表裡找不到對應的貨號／品名，維持原本的舊價格，請自行確認是否需要手動處理。`;
    alert(msg);
};

window.onExPriceChange = function(input) {
    const row = input.closest('tr');
    const exPrice = parseFloat(input.value) || 0;
    const incPriceInput = row.querySelector('.inc-price');

    incPriceInput.value = Math.round(exPrice * 1.05 * 100) / 100;
    calculateTotals();
};

window.removeQuoteRow = function(btn) {
    const row = btn.closest('tr');
    row.remove();
    reorderRows();
    calculateTotals();
};

function reorderRows() {
    const rows = document.querySelectorAll('#quoteItems tr');
    rows.forEach((row, index) => {
        row.cells[0].innerText = index + 1;
    });
}

window.calculateTotals = function() {
    let subtotalSum = 0;
    const rows = document.querySelectorAll('#quoteItems tr');

    rows.forEach(row => {
        const qty = parseFloat(row.querySelector('.qty').value) || 0;
        const incPrice = parseFloat(row.querySelector('.inc-price').value) || 0;

        const incSubtotal = qty * incPrice;
        row.querySelector('.subtotal-inc').value = Math.round(incSubtotal);

        subtotalSum += incSubtotal;
    });

    const discountRateInput = document.getElementById('discountRateInput');
    const discountRate = parseFloat(discountRateInput.value) || 0;
    const discountedTotal = subtotalSum * (1 - discountRate / 100);

    const totalEx = discountedTotal / 1.05;
    const tax = discountedTotal - totalEx;

    document.getElementById('subtotalAmount').innerText = Math.round(totalEx).toLocaleString();
    document.getElementById('taxAmount').innerText = Math.round(tax).toLocaleString();
    document.getElementById('grandTotal').innerText = Math.round(discountedTotal).toLocaleString();
    document.getElementById('chineseTotal').innerText = `合計新台幣 ${numberToChineseWords(Math.round(discountedTotal))}元整`;

    saveQuoteDraft();
};

const QUOTE_DRAFT_STORAGE_KEY = 'quote_draft_v1';

// 把目前畫面上的估價單內容（表頭資訊＋所有品項）整份存到本機瀏覽器（localStorage），
// 這樣就算關掉分頁、關掉瀏覽器、甚至重開電腦，只要是同一台裝置、同一個瀏覽器，
// 重新打開系統時都能接著剛剛還沒印完的那張繼續打，不會憑空消失。
// 只有按「製作下一張估價單」才會真的清空、換成全新的草稿。
function saveQuoteDraft() {
    try {
        const items = Array.from(document.querySelectorAll('#quoteItems tr')).map(row => ({
            nameEn: row.querySelector('.item-en')?.value || '',
            nameCn: row.querySelector('.item-cn')?.value || '',
            model: row.querySelector('.item-model')?.value || '',
            brand: quoteRowBrandValue(row),
            productLine: row.querySelector('.item-product-line')?.value || '',
            productType: row.querySelector('.item-product-type')?.value || '',
            spec: row.querySelector('.item-spec')?.value || '',
            qty: row.querySelector('.qty')?.value || '',
            price: row.querySelector('.inc-price')?.value || '',
            exPrice: row.querySelector('.ex-price')?.value || '',
            subtotal: row.querySelector('.subtotal-inc')?.value || ''
        }));

        const draft = {
            company: currentCompany,
            clientName: document.getElementById('clientName')?.value || '',
            ordererName: document.getElementById('ordererName')?.value || '',
            salesName: document.getElementById('salesName')?.value || '',
            quoteDate: document.getElementById('quoteDate')?.value || '',
            quoteNo: document.getElementById('quoteNo')?.value || '',
            discountRate: document.getElementById('discountRateInput')?.value || '0',
            validDays: document.getElementById('validDays')?.value || '90',
            items
        };
        localStorage.setItem(QUOTE_DRAFT_STORAGE_KEY, JSON.stringify(draft));
    } catch (e) {
        console.error('儲存估價單草稿失敗：', e);
    }
}

function loadQuoteDraft() {
    try {
        const raw = localStorage.getItem(QUOTE_DRAFT_STORAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (e) {
        console.error('讀取估價單草稿失敗：', e);
        return null;
    }
}

// 把儲存的草稿套回畫面上：先套用公司主題（不重新產生單號，沿用草稿裡存的那組），
// 再逐一還原表頭欄位跟每一列品項
function restoreQuoteDraft(draft) {
    restoringQuoteDraft = true;
    applyCompanyTheme(draft.company || 'yushin');

    document.getElementById('clientName').value = draft.clientName || '';
    document.getElementById('ordererName').value = draft.ordererName || '';
    document.getElementById('quoteDate').value = draft.quoteDate || '';
    document.getElementById('discountRateInput').value = draft.discountRate || 0;
    document.getElementById('validDays').value = draft.validDays || 90;

    document.getElementById('quoteItems').innerHTML = '';
    if (draft.items && draft.items.length) {
        draft.items.forEach(item => addQuoteRow(item));
    } else {
        addQuoteRow();
    }

    // 單號沿用草稿裡存的那組，不重新產生；業務欄位要等 populateSalesDropdown 把選單填好之後才還原得了，
    // 這裡先记住待會兒要設定的值
    document.getElementById('quoteNo').value = draft.quoteNo || '';
    window._pendingDraftSalesName = draft.salesName || '';

    calculateTotals();
    restoringQuoteDraft = false;
}

function numberToChineseWords(num) {
    if (num === 0) return '零';
    const digit = ['零', '壹', '貳', '參', '肆', '伍', '陸', '柒', '捌', '玖'];
    const unit = ['', '拾', '佰', '仟', '萬', '拾', '佰', '仟', '億'];
    let s = '';
    let numStr = num.toString();
    for (let i = 0; i < numStr.length; i++) {
        let n = numStr[numStr.length - 1 - i];
        s = digit[n] + unit[i] + s;
    }
    return s;
}

window.handleSaveAndPrint = function() {
    const quoteNo = document.getElementById('quoteNo').value.trim();
    const clientName = document.getElementById('clientName').value;
    const ordererName = document.getElementById('ordererName').value.trim();

    if (!quoteNo) {
        alert('請填寫估價單號！');
        return;
    }

    if (!document.getElementById('salesName').value) {
        alert('請從下拉選單選擇負責業務！');
        return;
    }

    const quoteBrandOtherMissing = [...document.querySelectorAll('#quoteItems tr')]
        .some(row => row.querySelector('.item-brand')?.value === '其他' && !quoteRowBrandValue(row));
    if (quoteBrandOtherMissing) {
        alert('已選擇「其他」廠牌，請輸入廠牌名稱。');
        return;
    }
    const quoteHasUnassignedBrand = [...document.querySelectorAll('#quoteItems tr')]
        .some(row => {
            const brand = quoteRowBrandValue(row);
            if (!brand) return false;
            // 這個品項當初是用「其他（自行輸入）」填的自訂廠牌名稱（例如 EMS），不是價目表裡的正式廠牌，
            // 只要目前公司有開放「其他廠牌」，這種自訂名稱本來就不會出現在正式廠牌清單裡，不能當作違規
            return !isCompanyBrandAllowed(currentCompany, brand) && !isCompanyOtherOptionAllowed(currentCompany);
        });
    if (quoteHasUnassignedBrand) {
        alert('此估價單含有不屬於目前分公司代理的廠牌，請切換分公司或更換廠牌。');
        return;
    }

    // PDF/列印輸出的檔名：單號 + 客戶名稱（訂購人），客戶名稱本身不會出現在印出的內容裡
    // 檔名格式：YS/DS/MS-日期-業務代號-估價單編號-客戶名稱（quoteNo 本身已經是前四段，這裡補上客戶名稱）
    const originalQuoteTitle = document.title;
    document.title = ordererName ? `${quoteNo}-${ordererName}` : quoteNo;

    const selectedSalesName = document.getElementById('salesName').value;
    const selectedSales = salesList.find(s => stripPhoneSuffix(s.name) === stripPhoneSuffix(selectedSalesName));
    const quoteData = {
        quoteNo: quoteNo,
        company: currentCompany,
        clientName: clientName,
        ordererName: ordererName,
        salesName: selectedSalesName,
        ownerUid: selectedSales?.uid || (belongsToCurrentUser(selectedSalesName) ? currentUser?.uid || '' : ''),
        quoteDate: document.getElementById('quoteDate').value,
        validDays: document.getElementById('validDays').value,
        discountRate: document.getElementById('discountRateInput').value,
        grandTotal: document.getElementById('grandTotal').innerText,
        items: []
    };

    document.querySelectorAll('#quoteItems tr').forEach(row => {
        quoteData.items.push({
            nameEn: row.querySelector('.item-en').value,
            nameCn: row.querySelector('.item-cn').value,
            model: row.querySelector('.item-model').value,
            brand: quoteRowBrandValue(row),
            productLine: row.querySelector('.item-product-line').value,
            productType: row.querySelector('.item-product-type').value,
            spec: row.querySelector('.item-spec').value,
            qty: row.querySelector('.qty').value,
            price: row.querySelector('.inc-price').value,
            exPrice: row.querySelector('.ex-price').value,
            subtotal: row.querySelector('.subtotal-inc').value
        });
    });

    prepareQuoteForPrint();

    // 列印用的內容本來就是畫面上現有的資料，不需要等雲端存檔完成才印出來——
    // 之前的寫法是「等 Firestore 寫入完成（不管成功或失敗）才 print()」，
    // 遇到網路慢或 Firestore 回應慢時，點下去要等好幾秒才會跳出列印/PDF視窗，感覺速度很慢。
    // 改成：立刻列印，雲端存檔在背景進行；如果存檔失敗才另外提示，不會再讓列印被網路卡住。
    //
    // 這裡用兩次 requestAnimationFrame 而不是完全同步呼叫 window.print()：
    // 剛剛把 document.title 改成單號、也才剛用 JS 插入/更新完負責業務的鏡像文字，
    // 如果馬上同步呼叫 print()，手機瀏覽器有時候來不及把這些變動畫面「刷新」出來，
    // 存出來的 PDF 檔名還是用最原始的網頁標題、內容也可能是修改前的舊畫面。
    // 等兩次畫面重繪（約一兩個影格、感覺不出延遲）以後才印，能確保標題與畫面都已經更新好。
    window._quoteOriginalTitle = originalQuoteTitle;

    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            window.print();
        });
    });

    db.collection('quotes').doc(quoteNo).set(quoteData).catch(err => {
        console.error('儲存估價單到雲端失敗：', err);
        alert('提醒：這張估價單剛剛存到雲端失敗（' + err.message + '）。列印內容不受影響，但建議稍後檢查網路連線後，再按一次「存檔並列印」，確保雲端資料庫也有存到這筆紀錄。');
    });
};

// 列印前的整理工作：
// 1) 同步每個 input 的 value「屬性」= 目前實際輸入值
//    （CSS 的 :has(input[value=""]) 只認 HTML 屬性，屬性從建立輸入框當下就凍結了，
//     使用者之後打的字只會更新瀏覽器內部的值、不會回寫屬性，導致有填品名/貨號的列印時仍被誤判為空而整列隱藏）
// 2) 讓「規格」文字框依實際內容自動撐高，避免固定高度把多行文字裁切、疊在一起
// 3) 英文品名/中文品名/貨號/廠牌需要保留原本的輸入／選擇功能，
//    太長的文字會被裁掉看不見，所以在旁邊插入一份可換行、顯示完整內容的鏡像文字，
//    列印時蓋過輸入框顯示（純 CSS @media print 控制顯示/隱藏，不用另外還原）
function prepareQuoteForPrint() {
    const root = document.getElementById('printableQuote');
    if (!root) return;

    root.querySelectorAll('input').forEach(el => {
        el.setAttribute('value', el.value);
    });

    root.querySelectorAll('textarea').forEach(el => {
        el.style.height = 'auto';
        el.style.height = (el.scrollHeight + 2) + 'px';
    });

    ['.item-en', '.item-cn', '.item-model', '.item-brand'].forEach(sel => {
        root.querySelectorAll(sel).forEach(input => {
            let mirror = input.nextElementSibling;
            if (!mirror || !mirror.classList.contains('print-text-mirror')) {
                mirror = document.createElement('span');
                mirror.className = 'print-text-mirror';
                input.insertAdjacentElement('afterend', mirror);
            }
            mirror.textContent = sel === '.item-brand' ? quoteRowBrandValue(input.closest('tr')) : input.value;
        });
    });

    // 「負責業務」是下拉選單，原生 select 版面寬度不受控，列印時容易跟旁邊的電話號碼中間拉開一大段空白，
    // 看起來像「隔了很遠」而不是緊接在名字後面；改成插入一份純文字鏡像（名字＋電話會排在同一行、緊接著）
    const salesSelect = document.getElementById('salesName');
    if (salesSelect) {
        let salesMirror = salesSelect.nextElementSibling;
        if (!salesMirror || !salesMirror.classList.contains('sales-name-print-mirror')) {
            salesMirror = document.createElement('span');
            salesMirror.className = 'sales-name-print-mirror';
            salesSelect.insertAdjacentElement('afterend', salesMirror);
        }
        salesMirror.textContent = salesSelect.value || '';
    }
}

window.loadQuoteFromCloud = function() {
    const qNo = document.getElementById('searchQuoteNo').value.trim();
    if (!qNo) {
        alert('請輸入要查詢的估價單號');
        return;
    }
    fetchAndFillQuote(qNo);
};

function fetchAndFillQuote(qNo) {
    db.collection('quotes').doc(qNo).get().then(doc => {
        if (doc.exists) {
            const data = doc.data();
            if (!canViewAllData('quotes') && !belongsToCurrentUser(data.salesName, data.ownerUid)) {
                alert('您只能查看自己的估價單。');
                return;
            }
            actuallySwitchMainTab('quote-system');
            switchQuoteView('create');
            document.getElementById('quoteNo').value = data.quoteNo;
            document.getElementById('clientName').value = data.clientName;
            document.getElementById('ordererName').value = data.ordererName || '';
            document.getElementById('salesName').value = data.salesName;
            updateSalesPhoneDisplay();
            document.getElementById('quoteDate').value = data.quoteDate;
            document.getElementById('validDays').value = data.validDays;
            document.getElementById('discountRateInput').value = data.discountRate || 0;
            if (data.company) {
                switchCompany(data.company);
            }

            document.getElementById('quoteItems').innerHTML = '';
            data.items.forEach(item => addQuoteRow(item));
        } else {
            alert('找不到該估價單');
        }
    }).catch(() => {
        alert('無法從雲端讀取');
    });
}

/* ---------- 我的估價單（只列出目前登入者自己名下的估價單） ---------- */
let myQuotesCache = [];

window.switchQuoteView = function(view, el) {
    const pageKey = view === 'create' ? 'quote.create' : 'quote.my';
    if (!canAccessPage(pageKey)) { alert('您沒有權限查看這個分頁。'); return; }
    document.querySelectorAll('#quote-system > .sub-nav .sub-tab').forEach(t => t.classList.remove('active'));
    const targetEl = el || document.getElementById(view === 'create' ? 'qsub-create' : 'qsub-my');
    if (targetEl) targetEl.classList.add('active');

    document.getElementById('quoteCreatePanel').style.display = view === 'create' ? 'block' : 'none';
    document.getElementById('myQuotesPanel').style.display = view === 'my' ? 'block' : 'none';

    if (view === 'my') {
        loadMyQuotesFromCloud();
    }
    updateReadonlyNotice();
};

window.loadMyQuotesFromCloud = function() {
    const hint = document.getElementById('myQuotesEmptyHint');

    if (getDataScope('quotes') === 'none') {
        myQuotesCache = [];
        document.getElementById('myQuotesBody').innerHTML = '';
        hint.style.display = 'block';
        hint.innerText = '管理員尚未設定此身份的估價單資料查看範圍。';
        return;
    }

    if (canViewAllData('quotes')) {
        db.collection('quotes').get().then(snapshot => {
            myQuotesCache = [];
            snapshot.forEach(doc => myQuotesCache.push({ id: doc.id, ...doc.data() }));
            myQuotesCache.sort((a, b) => (b.quoteNo || '').localeCompare(a.quoteNo || ''));
            renderMyQuotesList();
        }).catch(err => {
            console.error(err);
            alert('讀取估價單失敗，請確認 Firestore 權限設定。');
        });
        return;
    }

    const ownQueries = [db.collection('quotes').where('ownerUid', '==', currentUser.uid).get()];
    if (currentUserName) ownQueries.push(db.collection('quotes').where('salesName', '>=', currentUserName).where('salesName', '<=', currentUserName + '\uf8ff').get());
    Promise.all(ownQueries).then(snapshots => {
        const records = new Map();
        snapshots.forEach(snapshot => snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() })));
        myQuotesCache = [...records.values()];
        // 使用 quoteNo 排序，確保同天產生的單據也能按序號正確排列（最新的在最前）
myQuotesCache.sort((a, b) => (b.quoteNo || '').localeCompare(a.quoteNo || ''));
        renderMyQuotesList();
        if (!currentUserName && myQuotesCache.length === 0) {
            hint.style.display = 'block';
            hint.innerText = '目前找不到以此帳號建立的新式紀錄。若要顯示舊估價單，請管理員在 users 帳號資料補上姓名，以便比對舊資料的負責業務。';
        }
    }).catch(err => {
        console.error(err);
        alert('讀取我的估價單失敗，請確認 Firestore 權限設定。');
    });
};

window.renderMyQuotesList = function() {
    const tbody = document.getElementById('myQuotesBody');
    const searchInput = document.getElementById('myQuoteSearch');
    const keyword = (searchInput.value || '').toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;

    const isAdminViewingAll = canViewAllData('quotes');
    const salesHeader = document.getElementById('myQuotesSalesHeader');
    if (salesHeader) salesHeader.style.display = isAdminViewingAll ? '' : 'none';

    myQuotesCache.forEach(q => {
        const searchable = `${q.quoteNo || ''} ${q.clientName || ''} ${q.ordererName || ''} ${q.salesName || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;
        shown++;

        const tr = document.createElement('tr');
        bindListRowSelection(tr);
        
        // --- 修改這裡：根據狀態顯示不同按鈕 ---
        const statusCell = q.dealClosed
            ? '<span style="color:#2e7d32;font-weight:bold;">✓ 已成交</span>'
            : '<span style="color:#888;">未成交</span>';

        const actionBtn = q.dealClosed
            ? `<button type="button" class="btn-small btn-secondary" style="background-color: #666;" onclick="unmarkQuoteAsDeal('${q.quoteNo}')">❌ 取消成交</button>`
            : `<button type="button" class="btn-small" onclick="markQuoteAsDeal('${q.quoteNo}')">✅ 成交</button>`;
        // ------------------------------------

        tr.innerHTML = `
            <td>${escapeHtml(q.quoteNo || '')}</td>
            <td>${escapeHtml(q.clientName || '')}</td>
            <td>${escapeHtml(q.ordererName || '')}</td>
            ${isAdminViewingAll ? `<td>${escapeHtml(stripPhoneSuffix(q.salesName))}</td>` : ''}
            <td>${escapeHtml(q.quoteDate || '')}</td>
            <td>${escapeHtml(q.grandTotal || '')}</td>
            <td>${statusCell}</td>
            <td class="no-print">
                <button type="button" class="btn-small" onclick="openQuoteFromAdmin('${q.quoteNo}')">載入</button>
                ${actionBtn}
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('myQuotesEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

// 成交：標記估價單為已成交，並把裡面每一個品項匯入訂單管理系統（一次性動作，避免重複匯入）
window.markQuoteAsDeal = function(quoteNo) {
    if (!confirm(`確定要將估價單 ${quoteNo} 標記為成交嗎？裡面的品項會自動匯入訂單管理系統。`)) return;

    db.collection('quotes').doc(quoteNo).get().then(doc => {
        if (!doc.exists) {
            alert('找不到這張估價單');
            return;
        }
        const q = doc.data();
        if (q.dealClosed) {
            alert('這張估價單已經標記過成交了。');
            return;
        }

        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

        const batch = db.batch();
        (q.items || []).forEach(item => {
            if (!item.nameCn && !item.nameEn && !item.model) return;
            const orderRef = db.collection('orders').doc();
            const orderData = {
                orderDate: todayStr,
                customerName: q.ordererName || '',
                brand: item.brand || '',
                productLine: item.productLine || '',
                productType: item.productType || '',
                itemCode: item.model || '',
                itemName: item.nameCn || item.nameEn || '',
                qty: item.qty || '',
                unitPrice: item.price || '',
                totalPrice: item.subtotal || '',
                transactionType: '',
                invoiceTitle: q.clientName || '',
                quoteNo: quoteNo,
                salesName: stripPhoneSuffix(q.salesName),
                ownerUid: q.ownerUid || salesList.find(s => stripPhoneSuffix(s.name) === stripPhoneSuffix(q.salesName))?.uid || ''
            };
            // 價目表如果有登記這個貨號的成本，自動帶進這筆訂單的「含稅成本」，不用採購再手動查一次
            const priceMatch = item.model ? priceList.find(p => p.model && p.model.trim() === item.model.trim()) : null;
            if (priceMatch && priceMatch.cost) orderData.costPrice = priceMatch.cost;
            batch.set(orderRef, orderData);
        });

        batch.update(db.collection('quotes').doc(quoteNo), { dealClosed: true, dealClosedAt: todayStr });

        batch.commit().then(() => {
            alert('已標記成交，品項已匯入訂單管理系統。');
            loadMyQuotesFromCloud();
        }).catch(err => {
            alert('匯入失敗：' + err.message);
        });
    }).catch(err => {
        alert('讀取估價單失敗：' + err.message);
    });
};

window.unmarkQuoteAsDeal = function(quoteNo) {
    if (!confirm(`確定要取消估價單 ${quoteNo} 的成交狀態嗎？這將會自動刪除訂單管理系統中對應的項目。`)) return;

    db.collection('orders').where('quoteNo', '==', quoteNo).get().then(snapshot => {
        const batch = db.batch();
        snapshot.forEach(doc => batch.delete(doc.ref)); // 刪除訂單

        const quoteRef = db.collection('quotes').doc(quoteNo);
        batch.update(quoteRef, { dealClosed: false, dealClosedAt: null });

        return batch.commit();
    }).then(() => {
        alert('成交狀態已取消。');
        loadMyQuotesFromCloud();
    }).catch(err => {
        alert('取消失敗：' + err.message);
    });
};
/* =========================================================
   訂單管理系統
   ========================================================= */
let ordersCache = [];

// 訂單資料範圍由管理員在身份權限中設定：只看自己或查看所有人
window.loadOrdersFromCloud = function() {
    if (getDataScope('orders') === 'none') {
        ordersCache = [];
        renderOrdersList();
        return;
    }
    const queries = canViewAllData('orders')
        ? [db.collection('orders').get()]
        : [db.collection('orders').where('ownerUid', '==', currentUser.uid).get()];
    if (!canViewAllData('orders') && currentUserName) {
        queries.push(db.collection('orders').where('salesName', '>=', currentUserName).where('salesName', '<=', currentUserName + '\uf8ff').get());
    }
    Promise.all(queries).then(snapshots => {
        const records = new Map();
        snapshots.forEach(snapshot => snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() })));
        ordersCache = [...records.values()];
        
        // 排序：日期由新到舊 (倒序)
        ordersCache.sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
        
        renderOrdersList();
    }).catch(err => {
        console.error("讀取訂單失敗：", err);
        alert('讀取訂單資料失敗，請確認 Firestore 權限設定。');
    });
};

// 依「成本」跟「單價（售價）」計算利潤% = (售價－成本) / 成本 × 100，也就是以成本為基準的加成率
function formatProfitPercent(unitPrice, costPrice) {
    const price = parseFloat(unitPrice);
    const cost = parseFloat(costPrice);
    if (!isFinite(price) || !isFinite(cost) || cost <= 0) return '－';
    const percent = ((price - cost) / cost) * 100;
    return percent.toFixed(1) + '%';
}

// 輸入含稅成本的當下（還沒存雲端前），先在畫面上即時算出利潤%，打字就能馬上看到，不用等存檔
window.updateOrderProfitDisplay = function(orderId, costValue) {
    const o = ordersCache.find(x => x.id === orderId);
    if (!o) return;
    const span = document.getElementById('orderProfit_' + orderId);
    if (span) span.innerText = formatProfitPercent(o.unitPrice, costValue);
};

// 能查看所有人訂單的身份，可依業務與廠牌篩選。
function populatePurchaserOrderFilters() {
    const wrap = document.getElementById('purchaserOrderFilters');
    const salesSelect = document.getElementById('orderSalesFilter');
    const brandSelect = document.getElementById('orderBrandFilter');
    if (!wrap || !salesSelect || !brandSelect) return;

    const enabled = canViewAllData('orders');
    wrap.style.display = enabled ? '' : 'none';
    if (!enabled) return;

    const salesValue = salesSelect.value;
    const brandValue = brandSelect.value;
    const sales = [...new Set(ordersCache.map(o => stripPhoneSuffix(o.salesName)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const brands = [...new Set(ordersCache.map(o => (o.brand || '').trim()).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));

    salesSelect.innerHTML = '<option value="">全部業務</option>' + sales.map(name =>
        `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
    brandSelect.innerHTML = '<option value="">全部廠牌</option>' + brands.map(brand =>
        `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('');
    if (sales.includes(salesValue)) salesSelect.value = salesValue;
    if (brands.includes(brandValue)) brandSelect.value = brandValue;
}

window.renderOrdersList = function() {
    const tbody = document.getElementById('ordersBody');
    const searchInput = document.getElementById('orderSearch');
    if (!tbody || !searchInput) return;

    const canGeneratePo = currentUserRole === 'purchaser' || currentUserRole === 'admin';
    const selectHeader = document.getElementById('orderSelectHeader');
    if (selectHeader) selectHeader.style.display = canGeneratePo ? '' : 'none';
    const costHeader = document.getElementById('orderCostHeader');
    if (costHeader) costHeader.style.display = canGeneratePo ? '' : 'none';
    const profitHeader = document.getElementById('orderProfitHeader');
    if (profitHeader) profitHeader.style.display = canGeneratePo ? '' : 'none';

    populatePurchaserOrderFilters();
    const salesFilter = document.getElementById('orderSalesFilter')?.value || '';
    const brandFilter = document.getElementById('orderBrandFilter')?.value || '';
    const progressFilter = document.getElementById('orderProgressFilter')?.value || '';

    const keyword = (searchInput.value || '').toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;

    ordersCache.forEach(o => {
        const searchable = `${o.customerName || ''} ${o.brand || ''} ${o.itemCode || ''} ${o.itemName || ''} ${o.quoteNo || ''} ${o.salesName || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;
        if (salesFilter && stripPhoneSuffix(o.salesName) !== salesFilter) return;
        if (brandFilter && (o.brand || '') !== brandFilter) return;
        if (progressFilter === 'unordered' && o.isOrdered) return;
        if (progressFilter === 'ordered-undelivered' && (!o.isOrdered || o.isDelivered)) return;
        shown++;

        const tr = document.createElement('tr');
        bindListRowSelection(tr);
        tr.innerHTML = `
            ${canGeneratePo ? `<td class="no-print" data-th="選取"><input type="checkbox" class="order-select-checkbox" data-order-id="${o.id}"></td>` : ''}
            <td data-th="訂單日期">${escapeHtml(o.orderDate || '')}</td>
            <td data-th="客戶名稱">${o.customerName ? `<button type="button" class="btn-small btn-secondary" onclick="showCustomerOrderHistory('${escapeAttr(o.customerName)}')">${escapeHtml(o.customerName)}</button>` : ''}</td>
            <td data-th="負責業務">${escapeHtml(stripPhoneSuffix(o.salesName))}</td>
            <td data-th="廠牌">${escapeHtml(o.brand || '')}</td>
            <td data-th="貨號">${escapeHtml(o.itemCode || '')}</td>
            <td data-th="品名">${escapeHtml(o.itemName || '')}</td>
            <td data-th="數量">${escapeHtml(String(o.qty || ''))}</td>
            <td data-th="單價">${escapeHtml(String(o.unitPrice || ''))}</td>
            <td data-th="總價">${escapeHtml(String(o.totalPrice || ''))}</td>
            ${canGeneratePo ? `
            <td class="no-print" data-th="含稅成本"><input type="number" step="0.01" class="order-cost-input" data-order-id="${o.id}" value="${o.costPrice != null ? o.costPrice : ''}" oninput="updateOrderProfitDisplay('${o.id}', this.value)" onchange="updateOrderField('${o.id}','costPrice', this.value === '' ? null : parseFloat(this.value))"></td>
            <td class="no-print" data-th="利潤%"><span id="orderProfit_${o.id}">${formatProfitPercent(o.unitPrice, o.costPrice)}</span></td>` : ''}
            <td data-th="交易方式">
                <select onchange="updateOrderField('${o.id}','transactionType',this.value)">
                    <option value="" ${!o.transactionType ? 'selected' : ''}>未選擇</option>
                    <option value="直" ${o.transactionType === '直' ? 'selected' : ''}>直</option>
                    <option value="借" ${o.transactionType === '借' ? 'selected' : ''}>借</option>
                    <option value="扣" ${o.transactionType === '扣' ? 'selected' : ''}>扣</option>
                </select>
            </td>
            <td data-th="抬頭"><input type="text" value="${escapeAttr(o.invoiceTitle || '')}" onchange="updateOrderField('${o.id}','invoiceTitle',this.value)" ${o.transactionType === '直' ? '' : 'disabled'}></td>
            <td data-th="備註"><input type="text" value="${escapeAttr(o.remarks || '')}" placeholder="備註" onchange="updateOrderField('${o.id}','remarks',this.value)"></td>
            <td class="no-print" data-th="操作">
                <button type="button" class="btn-small ${o.isOrdered ? 'status-ok' : 'btn-secondary'}" onclick="toggleOrderStatus('${o.id}', 'isOrdered', ${!o.isOrdered})">已訂貨</button>
                <button type="button" class="btn-small ${o.isDelivered ? 'status-ok' : 'btn-secondary'}" onclick="toggleOrderStatus('${o.id}', 'isDelivered', ${!o.isDelivered})">已送貨</button>
                <button type="button" class="btn-small ${o.isBilled ? 'status-ok' : 'btn-secondary'}" onclick="toggleOrderStatus('${o.id}', 'isBilled', ${!o.isBilled})">已報帳</button>
                <button type="button" class="btn-danger" onclick="deleteOrder('${o.id}')">刪除</button>
            </td>
            <td class="no-print" data-th="訂購人">${escapeHtml(o.isOrdered ? (o.orderedBy || '') : '')}</td>
            <td class="no-print" data-th="訂購單">${o.purchaseOrderNo ? `<button type="button" class="btn-small btn-secondary" onclick="openPurchaseOrderFromOrder('${escapeAttr(o.purchaseOrderNo)}')">${escapeHtml(o.purchaseOrderNo)}</button>` : '－'}</td>
            <td class="no-print" data-th="狀態紀錄">${renderOrderStatusLog(o)}</td>
        `;
        tbody.appendChild(tr);
    });
    document.getElementById('ordersEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

window.toggleAllOrderSelect = function(checkbox) {
    document.querySelectorAll('.order-select-checkbox').forEach(cb => { cb.checked = checkbox.checked; });
};

// 訂單管理系統的子分頁：「業務訂單」跟「採購訂單」（已經產生過的訂購單紀錄，只有採購／管理員看得到）
window.switchOrderView = function(view, el) {
    const pageKey = view === 'po' ? 'orders.po' : 'orders.list';
    if (!canAccessPage(pageKey)) { alert('您沒有權限查看這個分頁。'); return; }
    document.querySelectorAll('#order-system .sub-nav .sub-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');

    document.getElementById('orderListPanel').style.display = view === 'list' ? 'block' : 'none';
    document.getElementById('poListPanel').style.display = view === 'po' ? 'block' : 'none';

    if (view === 'po') loadMyPurchaseOrders();
    updateReadonlyNotice();
};

let poListCache = [];

// 「採購訂單」列出所有已經產生過的訂購單紀錄（不分是誰產生的，只要是採購／管理員都看得到全部）
window.loadMyPurchaseOrders = function() {
    db.collection('purchaseOrders').get().then(snapshot => {
        poListCache = [];
        snapshot.forEach(doc => poListCache.push({ id: doc.id, ...doc.data() }));
        poListCache.sort((a, b) => (b.poNo || '').localeCompare(a.poNo || ''));
        renderPoList();
    }).catch(err => {
        console.error(err);
        alert('讀取訂購單紀錄失敗，請確認 Firestore 權限設定。');
    });
};

window.renderPoList = function() {
    const tbody = document.getElementById('poListBody');
    const searchInput = document.getElementById('poListSearch');
    if (!tbody || !searchInput) return;
    const keyword = (searchInput.value || '').toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;

    poListCache.forEach(po => {
        const searchable = `${po.poNo || ''} ${po.vendorName || ''} ${po.buyerName || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;
        shown++;

        const items = po.items || [];
        const subtotal = items.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
        const grandTotal = Math.round(subtotal) + Math.round(subtotal * 0.05);
        const companyInfo = companyData[po.company];
        const companyLabel = companyInfo ? `${companyInfo.title}（${companyInfo.prefix}）` : (po.company || '');

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(po.poNo || '')}</td>
            <td>${escapeHtml(companyLabel)}</td>
            <td>${escapeHtml(po.vendorName || '')}</td>
            <td>${escapeHtml(po.buyerName || '')}</td>
            <td>${escapeHtml(po.poDate || '')}</td>
            <td>${items.length}</td>
            <td>${grandTotal.toLocaleString()}</td>
            <td class="no-print"><button type="button" class="btn-small" onclick="reprintPurchaseOrder('${escapeAttr(po.id)}')">🖨️ 重新列印</button></td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('poListEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

// 把「採購訂單」裡一筆舊的訂購單紀錄，重新載回訂購單視窗，維持原本的單號，方便再列印一次
window.reprintPurchaseOrder = function(poId) {
    const po = poListCache.find(p => p.id === poId);
    if (!po) return;

    poItems = (po.items || []).map(item => ({ ...item }));
    poAllItems = poItems;
    switchPoCompany(po.company || 'yushin', null, true);

    document.getElementById('poVendorName').value = po.vendorName || '';
    document.getElementById('poBuyerName').innerText = po.buyerName || '';
    document.getElementById('poDate').value = po.poDate || '';
    document.getElementById('poNo').innerText = po.poNo || '';

    renderPoItemsTable();
    document.getElementById('poModalOverlay').classList.add('active');
};

// 從原始訂單上的訂購單號直接開啟該張訂購單，避免還要切分頁搜尋。
window.openPurchaseOrderFromOrder = function(poNo) {
    const open = po => {
        if (!po) { alert('找不到這張訂購單紀錄。'); return; }
        if (!poListCache.some(item => item.id === po.id)) poListCache.push(po);
        reprintPurchaseOrder(po.id);
    };
    const cached = poListCache.find(po => po.poNo === poNo || po.id === poNo);
    if (cached) { open(cached); return; }
    db.collection('purchaseOrders').doc(poNo).get().then(doc => open(doc.exists ? { id: doc.id, ...doc.data() } : null))
        .catch(err => alert('讀取訂購單失敗：' + err.message));
};

/* =========================================================
   產生訂購單：採購把選好的訂單品項，整理成一張要發給供應商的「訂購單」，
   格式跟估價單相同，但抬頭是廠商、單價預設帶「含稅成本」而不是賣客戶的售價，
   而且單價在這裡還可以再調整；也可以切換又鑫／辰星／鼎新，套用各公司的抬頭資訊跟單號代碼
   ========================================================= */
let poItems = [];
let poAllItems = [];
let poCurrentCompany = 'yushin';

window.openPurchaseOrderModal = function() {
    const checked = Array.from(document.querySelectorAll('.order-select-checkbox:checked'));
    if (checked.length === 0) {
        alert('請先在業務訂單左邊勾選要放進訂購單的品項。');
        return;
    }

    poAllItems = checked.map(cb => {
        const o = ordersCache.find(x => x.id === cb.dataset.orderId);
        if (!o) return null;
        let cost = parseFloat(o.costPrice);
        // 這筆訂單本身還沒填成本的話，再用貨號查一次目前的價目表，價目表如果有登記成本就直接帶入
        if (!isFinite(cost) || cost <= 0) {
            const priceMatch = o.itemCode ? priceList.find(p => p.model && p.model.trim() === o.itemCode.trim()) : null;
            if (priceMatch && priceMatch.cost) cost = parseFloat(priceMatch.cost);
        }
        return {
            orderId: o.id,
            itemName: o.itemName || '',
            itemCode: o.itemCode || '',
            brand: o.brand || '',
            qty: parseFloat(o.qty) || 1,
            // 單價優先帶「含稅成本」；如果連價目表都查不到成本，退回用原本賣客戶的單價，避免直接帶 0 出去
            unitPrice: isFinite(cost) && cost > 0 ? cost : (parseFloat(o.unitPrice) || 0)
        };
    }).filter(Boolean);
    poItems = poAllItems;

    document.getElementById('poVendorName').value = '';
    document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
    const today = new Date();
    document.getElementById('poDate').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // 預設用估價單系統目前選的那間公司，比較符合平常的使用情境
    switchPoCompany(currentCompany || 'yushin');
    document.getElementById('poModalOverlay').classList.add('active');
};

window.closePurchaseOrderModal = function() {
    document.getElementById('poModalOverlay').classList.remove('active');
};

// 切換訂購單要用哪間公司的抬頭／單號代碼（又鑫 YS／辰星 MS／鼎新 DS），跟估價單的公司切換邏輯一致
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

    // 依管理員設定，訂購單只帶入該分公司代理的廠牌；切換分公司時立即重新篩選。
    if (!skipNoGen && poAllItems.length) {
        poItems = poAllItems.filter(item => isCompanyBrandAllowed(compKey, item.brand));
        renderPoItemsTable();
    }

    // 重新列印「採購訂單」裡舊有的訂購單時，要沿用當初存的單號，不能在這裡重新產生一個新的
    if (!skipNoGen) generatePoNo();
};

// 訂購單號格式：PO-{公司代碼}-{日期}-{採購代號}-{流水號}，跟估價單單號的組成方式一致，
// 例如又鑫、代號 03 的採購，會是 PO-YS-20260824-03-01。
// 流水號是真的依照雲端已經產生過幾張訂購單去算「目前最大流水號 + 1」，不是隨機亂數，
// 邏輯跟估價單的 generateQuoteNo 一致，這樣才能保證同一天同一間公司不會撞號
window.generatePoNo = async function() {
    const info = companyData[poCurrentCompany];
    if (!info) return;
    const dateStr = getFormattedDateCode();
    const purchaserCode = currentUserCode || '01';
    const prefix = `PO-${info.prefix}-${dateStr}-${purchaserCode}-`;

    try {
        const snapshot = await db.collection('purchaseOrders')
            .where('poNo', '>=', prefix)
            .where('poNo', '<=', prefix + '\uf8ff')
            .get();

        let maxSeq = 0;
        snapshot.forEach(doc => {
            const seqStr = (doc.data().poNo || '').split('-').pop();
            const seq = parseInt(seqStr, 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        });
        document.getElementById('poNo').innerText = `${prefix}${String(maxSeq + 1).padStart(2, '0')}`;
    } catch (e) {
        document.getElementById('poNo').innerText = `${prefix}01`;
    }
};

function renderPoItemsTable() {
    const tbody = document.getElementById('poItemsBody');
    tbody.innerHTML = '';
    poItems.forEach((item, idx) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td style="border:1px solid #999;padding:4px;">${escapeHtml(item.itemName)}</td>
            <td style="border:1px solid #999;padding:4px;">${escapeHtml(item.itemCode)}</td>
            <td style="border:1px solid #999;padding:4px;">${escapeHtml(item.brand)}</td>
            <td style="border:1px solid #999;padding:4px;"><input type="number" step="1" value="${item.qty}" style="width:100%;box-sizing:border-box;" oninput="updatePoItem(${idx}, 'qty', this.value)"></td>
            <td style="border:1px solid #999;padding:4px;"><input type="number" step="0.01" value="${item.unitPrice}" style="width:100%;box-sizing:border-box;" oninput="updatePoItem(${idx}, 'unitPrice', this.value)"></td>
            <td style="border:1px solid #999;padding:4px;text-align:right;">${(item.qty * item.unitPrice).toFixed(0)}</td>
            <td class="no-print" style="border:1px solid #999;padding:4px;text-align:center;"><button type="button" class="btn-small btn-danger" onclick="removePoItem(${idx})">刪除</button></td>
        `;
        tbody.appendChild(tr);
    });
    recalcPoTotals();
}

window.updatePoItem = function(idx, field, value) {
    if (!poItems[idx]) return;
    poItems[idx][field] = parseFloat(value) || 0;
    renderPoItemsTable();
};

window.removePoItem = function(idx) {
    const removed = poItems[idx];
    poItems.splice(idx, 1);
    poAllItems = poAllItems.filter(item => item !== removed);
    renderPoItemsTable();
};

function recalcPoTotals() {
    const subtotal = poItems.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
    const tax = Math.round(subtotal * 0.05);
    const grandTotal = Math.round(subtotal) + tax;
    document.getElementById('poSubtotal').innerText = Math.round(subtotal).toLocaleString();
    document.getElementById('poTax').innerText = tax.toLocaleString();
    document.getElementById('poGrandTotal').innerText = grandTotal.toLocaleString();
}

window.printPurchaseOrder = function() {
    if (poItems.length === 0) {
        alert('目前沒有任何品項，請先選取或不要刪光所有品項。');
        return;
    }
    // 訂單裡存的廠牌，如果當初是透過估價單「其他（自行輸入）」填的自訂名稱，不會出現在正式廠牌清單裡；
    // 只要目前公司有開放「其他廠牌」，這種自訂名稱就不能當作違規
    if (poItems.some(item => !isCompanyBrandAllowed(poCurrentCompany, item.brand) && !isCompanyOtherOptionAllowed(poCurrentCompany))) {
        alert('訂購單含有不屬於目前分公司代理的廠牌，請切換分公司或移除該品項。');
        return;
    }
    const vendorName = document.getElementById('poVendorName').value.trim();
    if (!vendorName) {
        alert('請填寫抬頭（要下單的廠商名稱）。');
        return;
    }
    const poNo = document.getElementById('poNo').innerText.trim();
    if (!poNo) {
        alert('訂購單號尚未產生，請稍候再試。');
        return;
    }

    // PDF 檔名：單號＋抬頭，跟估價單的檔名邏輯一致
    const originalTitle = document.title;
    const safeFileName = `${poNo}＋${vendorName}`
        .replace(/[\\/:*?"<>|]/g, '_')
        .replace(/[\u0000-\u001F]/g, '')
        .trim();
    document.title = safeFileName;

    document.body.classList.add('printing-po');

    // 不用等雲端存檔完成才輸出——列印用的內容本來就是畫面上現有的資料，
    // 等 Firestore 寫入完成才印，網路慢的時候會感覺輸出速度變很慢（估價單之前就是同樣的問題）。
    // 這裡改成：畫面確實刷新過一輪（讓上面的檔名變更生效）後立刻印，雲端存檔改成背景進行。
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            window.print();
        });
    });

    // 背景把這張訂購單存到雲端（不擋列印），主要是為了讓「採購訂單」有紀錄、「流水號」能正確累計，
    // 下一張訂購單才不會撞號；存檔失敗不影響這次列印，只是這張不會出現在「採購訂單」列表裡，
    // 下一張單號也可能重複，需要的話可以之後手動微調
    db.collection('purchaseOrders').doc(poNo).set({
        poNo,
        company: poCurrentCompany,
        vendorName,
        buyerName: document.getElementById('poBuyerName').innerText || currentUserName || '',
        poDate: document.getElementById('poDate').value,
        items: poItems.map(item => ({ ...item })),
        createdAt: new Date().toISOString()
    }).then(() => {
        // 每個原始訂單回寫對應訂購單號；同一張訂購單可涵蓋多筆訂單。
        const orderIds = [...new Set(poItems.map(item => item.orderId).filter(Boolean))];
        return Promise.all(orderIds.map(orderId => db.collection('orders').doc(orderId).update({ purchaseOrderNo: poNo })));
    }).then(() => {
        ordersCache.forEach(order => {
            if (poItems.some(item => item.orderId === order.id)) order.purchaseOrderNo = poNo;
        });
        renderOrdersList();
    }).catch(err => {
        console.error('儲存訂購單紀錄失敗：', err);
    });

    // afterprint 會還原標題，避免影響系統其他頁面的瀏覽器標題
    window._poOriginalTitle = originalTitle;
};

window.addEventListener('afterprint', () => {
    document.body.classList.remove('printing-po');
    if (window._poOriginalTitle !== undefined) {
        document.title = window._poOriginalTitle;
        delete window._poOriginalTitle;
    }
});

// 列印/存 PDF 之後，只還原瀏覽器分頁標題，不再自動清空表單——
// 瀏覽器沒辦法告訴網頁「使用者是真的按了列印，還是按了取消」，這兩種情況都會觸發同一個事件，
// 如果自動清空，不小心點到取消也會被清空，很不方便。改成用下面「製作下一張估價單」按鈕，
// 由使用者自己決定什麼時候真的要開始寫下一張
window.addEventListener('afterprint', () => {
    if (window._quoteOriginalTitle !== undefined) {
        document.title = window._quoteOriginalTitle;
        delete window._quoteOriginalTitle;
    }
});

// 「製作下一張估價單」：手動觸發，不會因為誤按列印視窗的取消鈕就被清空。
// 按下後會先確認，避免不小心點到把還沒印的內容洗掉；確認後清空表單、單號跳下一號，
// 並且立刻把這個「全新、還是空的」狀態存成本機草稿，這樣萬一使用者按完馬上關網頁，
// 重開時看到的會是這張全新的空白單，而不是被清掉的上一張。
window.startNextQuote = function() {
    if (!confirm('確定要開始製作下一張估價單嗎？目前畫面上的內容將會被清空（如果還沒列印/存檔，請先確認已經處理好）。')) return;
    resetQuoteFormForNextOne();
    saveQuoteDraft();
};

function resetQuoteFormForNextOne() {
    document.getElementById('clientName').value = '';
    document.getElementById('ordererName').value = '';
    document.getElementById('discountRateInput').value = 0;
    document.getElementById('validDays').value = 90;

    document.getElementById('quoteItems').innerHTML = '';
    addQuoteRow();
    calculateTotals();

    // 單號直接把目前這組號碼的流水號 +1，不重新查一次雲端——
    // 因為上一張單的雲端存檔是背景進行、不保證這時候已經真的寫進 Firestore，
    // 這時如果重新查詢「目前最大流水號」，很可能還查到上一張存檔前的舊資料，算出來的下一號反而會撞號
    const quoteNoInput = document.getElementById('quoteNo');
    const parts = (quoteNoInput.value || '').split('-');
    const lastPart = parts[parts.length - 1];
    const lastSeq = parseInt(lastPart, 10);
    if (parts.length >= 2 && !isNaN(lastSeq)) {
        parts[parts.length - 1] = String(lastSeq + 1).padStart(lastPart.length, '0');
        quoteNoInput.value = parts.join('-');
    }
}

// 新增：處理狀態切換的函數
// 先在畫面上立即反應（樂觀更新），不用等雲端回應才變色，感覺上會快很多；
// 如果雲端寫入失敗，才把狀態復原並提示錯誤
window.toggleOrderStatus = function(orderId, field, newValue) {
    const o = ordersCache.find(x => x.id === orderId);
    const previousValue = o ? o[field] : undefined;
    const previousOrderedBy = o ? o.orderedBy : undefined;
    const previousHistory = o ? [...(o.statusHistory || [])] : [];
    const statusLabel = { isOrdered: '已訂貨', isDelivered: '已送貨', isBilled: '已報帳' }[field] || field;
    const actor = currentUserName || currentUser?.email || '未知使用者';
    const timestamp = new Date().toISOString();
    const logEntry = { field, value: newValue, label: `${newValue ? statusLabel : `取消${statusLabel}`}`, by: actor, at: timestamp };
    const updates = { [field]: newValue, statusHistory: firebase.firestore.FieldValue.arrayUnion(logEntry) };

    if (field === 'isOrdered') {
        // 訂購人記錄實際按下「已訂貨」的人；取消已訂貨時一併清除，避免留下過期紀錄。
        updates.orderedBy = newValue ? (currentUserName || '') : '';
    }

    if (o) {
        o[field] = newValue;
        if (field === 'isOrdered') o.orderedBy = updates.orderedBy;
        o.statusHistory = [...previousHistory, logEntry];
    }
    renderOrdersList();

    db.collection('orders').doc(orderId).update(updates).catch(err => {
        if (o) {
            o[field] = previousValue;
            if (field === 'isOrdered') o.orderedBy = previousOrderedBy;
            o.statusHistory = previousHistory;
        }
        renderOrdersList();
        alert('更新狀態失敗，已還原：' + err.message);
    });
};

function formatOrderStatusTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderOrderStatusLog(order) {
    const latest = {};
    (order.statusHistory || []).forEach(entry => { latest[entry.field] = entry; });
    const fields = [
        ['isOrdered', '訂貨'],
        ['isDelivered', '送貨'],
        ['isBilled', '報帳']
    ];
    const lines = fields.map(([field, label]) => {
        const entry = latest[field];
        if (!entry || !entry.value) return `${label}：－`;
        return `${label}：${escapeHtml(entry.by || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(entry.at))}</span>`;
    });
    return `<div style="line-height:1.45;min-width:116px;">${lines.join('<hr style="border:0;border-top:1px solid #ddd;margin:3px 0;">')}</div>`;
}

window.showCustomerOrderHistory = function(customerName) {
    const orders = ordersCache.filter(order => order.customerName === customerName)
        .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
    document.getElementById('customerOrderHistoryTitle').innerText = `客戶採購紀錄：${customerName}`;
    const tbody = document.getElementById('customerOrderHistoryBody');
    tbody.innerHTML = orders.length ? orders.map(order => `
        <tr><td>${escapeHtml(order.orderDate || '')}</td><td>${escapeHtml(order.brand || '')}</td><td>${escapeHtml(order.itemCode || '')}</td><td>${escapeHtml(order.itemName || '')}</td><td>${escapeHtml(String(order.qty || ''))}</td><td>${escapeHtml(String(order.totalPrice || ''))}</td><td>${order.isDelivered ? '已送貨' : order.isOrdered ? '已訂貨' : '未訂貨'}</td></tr>
    `).join('') : '<tr><td colspan="7" style="color:#888;">目前沒有採購紀錄。</td></tr>';
    document.getElementById('customerOrderHistoryOverlay').classList.add('active');
};

window.closeCustomerOrderHistory = function() {
    document.getElementById('customerOrderHistoryOverlay').classList.remove('active');
};

window.updateOrderField = function(orderId, field, value) {
    const o = ordersCache.find(x => x.id === orderId);
    const previousValue = o ? o[field] : undefined;

    if (o) o[field] = value;
    if (field === 'transactionType') renderOrdersList();

    db.collection('orders').doc(orderId).update({ [field]: value }).catch(err => {
        if (o) o[field] = previousValue;
        if (field === 'transactionType') renderOrdersList();
        alert('更新失敗，已還原：' + err.message);
    });
};

window.deleteOrder = function(orderId) {
    if (!confirm('確定要刪除這筆訂單嗎？')) return;
    db.collection('orders').doc(orderId).delete().then(() => {
        loadOrdersFromCloud();
    }).catch(err => {
        alert('刪除失敗：' + err.message);
    });
};

window.openOrderModal = function() {
    populateOrderBrandDropdown();
    const today = new Date();
    document.getElementById('orderDateInput').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    ['orderCustomer', 'orderBrand', 'orderBrandOther', 'orderItemCode', 'orderItemName', 'orderInvoiceTitle'].forEach(id => {
        document.getElementById(id).value = '';
    });
    onOrderBrandSelectChange();
    document.getElementById('orderQty').value = 1;
    document.getElementById('orderUnitPrice').value = 0;
    document.getElementById('orderTotalPrice').value = 0;
    document.getElementById('orderCostPrice').value = '';
    document.getElementById('orderTransactionType').value = '';
    document.getElementById('orderInvoiceTitle').disabled = true;
    document.getElementById('orderModalOverlay').classList.add('active');
};

window.closeOrderModal = function() {
    document.getElementById('orderModalOverlay').classList.remove('active');
};

window.calcOrderTotal = function() {
    const qty = parseFloat(document.getElementById('orderQty').value) || 0;
    const price = parseFloat(document.getElementById('orderUnitPrice').value) || 0;
    document.getElementById('orderTotalPrice').value = (qty * price).toFixed(0);
};

window.saveNewOrder = function() {
    const itemCode = document.getElementById('orderItemCode').value.trim();
    const priceMatch = itemCode ? priceList.find(p => p.model && p.model.trim() === itemCode) : null;
    const data = {
        orderDate: document.getElementById('orderDateInput').value,
        customerName: document.getElementById('orderCustomer').value.trim(),
        brand: getBrandFieldValue('orderBrand', 'orderBrandOther'),
        itemCode: itemCode,
        itemName: document.getElementById('orderItemName').value.trim(),
        productLine: (priceMatch && priceMatch.productLine) || '',
        productType: (priceMatch && priceMatch.productType) || '',
        qty: document.getElementById('orderQty').value,
        unitPrice: document.getElementById('orderUnitPrice').value,
        totalPrice: document.getElementById('orderTotalPrice').value,
        transactionType: document.getElementById('orderTransactionType').value,
        invoiceTitle: document.getElementById('orderInvoiceTitle').value.trim(),
        quoteNo: '',
        salesName: currentUserName || '',
        ownerUid: currentUser?.uid || ''
    };
    const costInputVal = document.getElementById('orderCostPrice').value;
    if (costInputVal !== '') data.costPrice = parseFloat(costInputVal);

    if (!data.orderDate || !data.itemName) {
        alert('請至少填寫訂單日期與品名');
        return;
    }
    if (document.getElementById('orderBrand').value === '其他' && !data.brand) {
        alert('已選擇「其他」廠牌，請輸入廠牌名稱');
        return;
    }

    db.collection('orders').add(data).then(() => {
        closeOrderModal();
        loadOrdersFromCloud();
    }).catch(err => {
        alert('新增失敗：' + err.message);
    });
};

// 匯出指定日期區間的訂單（供採購下單使用），不受畫面上目前的搜尋關鍵字影響
window.exportOrdersByDate = function() {
    const start = document.getElementById('exportStartDate').value;
    const end = document.getElementById('exportEndDate').value;
    if (!start || !end) {
        alert('請選擇起訖日期');
        return;
    }

    // Firestore 不支援同時對兩個不同欄位做範圍查詢，日期區間已經用掉唯一的範圍條件，
    // 所以業務姓名這邊改成撈出區間內全部訂單後，在前端依身分過濾（同時比對新舊兩種業務欄位格式）
    db.collection('orders')
        .where('orderDate', '>=', start)
        .where('orderDate', '<=', end)
        .get().then(snapshot => {
            const rows = [];
            snapshot.forEach(doc => {
                const o = doc.data();
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
                    '來源估價單': o.quoteNo || '',
                    '業務': stripPhoneSuffix(o.salesName)
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
            alert('匯出失敗：' + err.message);
        });
};

/* =========================================================
   儀器管理系統：客戶儀器維修保養／校正紀錄
   ========================================================= */
// 儀器管理系統的查看權限：業務只能看到自己名下的儀器，管理員／工程師／採購可看到全部
function canViewAllEquipment() {
    return currentUserRole === 'admin' || currentUserRole === 'engineer' || currentUserRole === 'purchaser';
}

window.loadEquipmentFromCloud = function() {
    let query = db.collection('equipment');
    if (canViewAllEquipment()) {
        query = query.orderBy('customerName');
    } else {
        query = query.where('salesName', '==', currentUserName);
    }
    query.get().then(snapshot => {
        equipmentList = [];
        snapshot.forEach(doc => {
            equipmentList.push({ id: doc.id, ...doc.data() });
        });
        if (!canViewAllEquipment()) {
            equipmentList.sort((a, b) => (a.customerName || '').localeCompare(b.customerName || '', 'zh-Hant'));
        }
        renderEquipmentList();
    }).catch(err => {
        console.error(err);
        alert('讀取儀器資料失敗，請確認 Firestore 權限設定。');
    });
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

window.renderEquipmentList = function() {
    const tbody = document.getElementById('eqListBody');
    const keyword = (document.getElementById('eqSearchInput').value || '').toLowerCase();
    const statusFilter = document.getElementById('eqStatusFilter').value;

    tbody.innerHTML = '';
    let shown = 0;

    equipmentList.forEach(eq => {
        const searchable = `${eq.customerName || ''} ${eq.brand || ''} ${eq.salesName || ''} ${eq.model || ''} ${eq.serialNo || ''} ${eq.assetId || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;

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
                <button type="button" class="btn-danger" onclick="event.stopPropagation(); deleteEquipment('${eq.id}')">刪除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

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
function getNextAssetId(salesName) {
    const match = salesList.find(s => s.name === salesName);
    const code = (match && match.code) ? match.code : 'NA';
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

    const match = priceList.find(p => (p.model || '').trim().toLowerCase() === model.toLowerCase());
    if (match && match.brand) {
        selectBrandInDropdown(brandSelect, match.brand);
        onEqBrandSelectChange();
    }
};

window.openEquipmentModal = function(eqId) {
    populateEquipmentSalesDropdown();
    populateEquipmentBrandDropdown();

    const overlay = document.getElementById('eqModalOverlay');
    overlay.dataset.editId = eqId || '';
    overlay.classList.add('active');
    currentEquipmentId = eqId || null;

    document.getElementById('eqSaveHint').innerText = '';
    const deleteBtn = document.getElementById('eqModalDeleteBtn');
    const logSection = document.getElementById('eqLogSection');

    if (eqId) {
        const eq = equipmentList.find(e => e.id === eqId);
        if (!eq) return;
        document.getElementById('eqModalTitle').innerText = `${eq.customerName || ''} － ${eq.model || '編輯儀器'}`;
        document.getElementById('eqCustomer').value = eq.customerName || '';
        document.getElementById('eqModel').value = eq.model || '';
        // 既有資料的廠牌如果不在價格表清單裡（例如舊資料、已停產品項），就落到「其他」並帶出原本文字
        const eqBrandSelect = document.getElementById('eqBrand');
        if (eq.brand && ![...eqBrandSelect.options].some(o => o.value === eq.brand)) {
            eqBrandSelect.value = '其他';
            onEqBrandSelectChange();
            document.getElementById('eqBrandOther').value = eq.brand;
        } else {
            eqBrandSelect.value = eq.brand || '';
            onEqBrandSelectChange();
        }
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
        document.getElementById('eqBrand').value = '';
        onEqBrandSelectChange();
        document.getElementById('eqCycle').value = 12;
        document.getElementById('eqNoMaintenance').checked = false;
        onEqNoMaintenanceChange();
        // 一般業務新增儀器時，自動帶出自己的名字；管理員／工程師／採購新增時可自行從下拉選單挑選負責業務
        if (!canViewAllEquipment()) {
            document.getElementById('eqSales').value = currentUserName || '';
        }
        deleteBtn.style.display = 'none';
        logSection.style.display = 'none';
    }
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

window.saveEquipmentFromModal = function() {
    const editId = document.getElementById('eqModalOverlay').dataset.editId;
    const data = {
        customerName: document.getElementById('eqCustomer').value.trim(),
        brand: getBrandFieldValue('eqBrand', 'eqBrandOther'),
        model: document.getElementById('eqModel').value.trim(),
        serialNo: document.getElementById('eqSerial').value.trim(),
        salesName: document.getElementById('eqSales').value.trim(),
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

    const ref = editId ? db.collection('equipment').doc(editId) : db.collection('equipment').doc();
    const payload = editId ? data : { ...data, assetId: getNextAssetId(data.salesName), logs: [] };

    ref.set(payload, { merge: true }).then(() => {
        const savedId = editId || ref.id;
        loadEquipmentFromCloudThenReopen(savedId);
        document.getElementById('eqSaveHint').innerText = '✓ 已儲存';
    }).catch(err => {
        alert('儲存失敗：' + err.message);
    });
};

window.deleteEquipment = function(eqId) {
    if (!confirm('確定要刪除這台儀器的所有紀錄嗎？此動作無法復原。')) return;
    db.collection('equipment').doc(eqId).delete().then(() => {
        loadEquipmentFromCloud();
        closeEquipmentModal();
    }).catch(err => {
        alert('刪除失敗：' + err.message);
    });
};

function equipmentLogRealIndex(eq, log) {
    return (eq.logs || []).indexOf(log);
}

window.addEquipmentLogFromModal = function() {
    if (!currentEquipmentId) return;
    const date = document.getElementById('eqLogDate').value;
    const type = document.getElementById('eqLogType').value;
    const tech = document.getElementById('eqLogTech').value.trim();
    const desc = document.getElementById('eqLogDesc').value.trim();

    if (!date) {
        alert('請選擇日期');
        return;
    }

    const eq = equipmentList.find(e => e.id === currentEquipmentId);
    const newLog = { date, type, tech, desc };
    const updatedLogs = [...(eq.logs || []), newLog];

    const updates = { logs: updatedLogs };
    if ((type === '保養' || type === '校正') && (!eq.lastServiceDate || date >= eq.lastServiceDate)) {
        updates.lastServiceDate = date;
    }

    db.collection('equipment').doc(currentEquipmentId).update(updates).then(() => {
        loadEquipmentFromCloudThenReopen(currentEquipmentId);
    }).catch(err => {
        alert('新增紀錄失敗：' + err.message);
    });
};

// 列表操作欄的「🔧 保養」：不開視窗，直接記一筆今天日期的保養紀錄
window.quickAddMaintenanceLog = function(eqId) {
    const eq = equipmentList.find(e => e.id === eqId);
    if (!eq) return;

    const today = new Date();
    const dateStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    if (!confirm(`確定要為「${eq.customerName || ''} ${eq.model || ''}」新增一筆今天(${dateStr})的保養紀錄嗎？`)) return;

    const newLog = { date: dateStr, type: '保養', tech: '', desc: '' };
    const updatedLogs = [...(eq.logs || []), newLog];

    db.collection('equipment').doc(eqId).update({ logs: updatedLogs, lastServiceDate: dateStr }).then(() => {
        loadEquipmentFromCloud();
    }).catch(err => {
        alert('新增保養紀錄失敗：' + err.message);
    });
};

window.deleteEquipmentLog = function(eqId, logIndex) {
    if (!confirm('確定要刪除這筆紀錄嗎？')) return;
    const eq = equipmentList.find(e => e.id === eqId);
    if (!eq) return;
    const updatedLogs = (eq.logs || []).filter((_, idx) => idx !== logIndex);
    db.collection('equipment').doc(eqId).update({ logs: updatedLogs }).then(() => {
        loadEquipmentFromCloudThenReopen(eqId);
    }).catch(err => {
        alert('刪除失敗：' + err.message);
    });
};

function loadEquipmentFromCloudThenReopen(eqId) {
    let query = db.collection('equipment');
    if (canViewAllEquipment()) {
        query = query.orderBy('customerName');
    } else {
        query = query.where('salesName', '==', currentUserName);
    }
    query.get().then(snapshot => {
        equipmentList = [];
        snapshot.forEach(doc => equipmentList.push({ id: doc.id, ...doc.data() }));
        if (!canViewAllEquipment()) {
            equipmentList.sort((a, b) => (a.customerName || '').localeCompare(b.customerName || '', 'zh-Hant'));
        }
        renderEquipmentList();
        openEquipmentModal(eqId);
    });
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

// 儀器管理系統：批量上傳 Excel（依「儀器編號」比對：比對到既有紀錄就更新、比對不到就新增；
// 不會刪除任何既有資料，維修保養／校正紀錄也會被保留。一般業務只能新增/更新自己名下的儀器，管理員可操作全部）
window.handleEquipmentExcelUpload = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;

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

            const getField = (row, keys) => {
                for (const k of keys) {
                    if (row[k] !== undefined && row[k] !== '') return row[k];
                }
                return '';
            };

            // 依權限範圍（一般業務只查自己名下的、管理員查全部）建立「儀器編號 -> 文件ID」比對索引
            let existingQuery = db.collection('equipment');

            existingQuery.get().then(snapshot => {
                const idMap = new Map();
                const maxSeqByPrefix = {}; // 各業務代號前綴各自獨立計算目前最大流水號
                snapshot.forEach(doc => {
                    const d = doc.data();
                    if (d.assetId) {
                        idMap.set(d.assetId, doc.id);
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
                        // 一般業務批量上傳一律歸在自己名下，忽略 Excel 裡填的負責業務；管理員則照 Excel 內容
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

                    const matchedId = assetIdInFile ? idMap.get(assetIdInFile) : null;
                    if (matchedId) {
                        updateOps.push({ docId: matchedId, data: recordData });
                    } else {
                        insertRecords.push({
                            ...recordData,
                            assetId: assetIdInFile || nextIdForSales(recordData.salesName),
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
                    let msg = `批量處理完成：更新 ${updateOps.length} 筆、新增 ${insertRecords.length} 筆`;
                    if (skipCount > 0) msg += `、略過 ${skipCount} 筆（缺少客戶名稱或型號）`;
                    msg += '。既有資料不會被刪除，維修保養紀錄也會保留。';
                    alert(msg);
                    input.value = '';
                    loadEquipmentFromCloud();
                }).catch(err => {
                    alert('批量寫入 Firestore 失敗：' + err.message);
                    input.value = '';
                });
            }).catch(err => {
                alert('讀取現有儀器資料失敗，無法進行比對：' + err.message);
                input.value = '';
            });

        } catch (err) {
            alert('讀取 Excel 檔案失敗：' + err.message);
            input.value = '';
        }
    };
    reader.readAsArrayBuffer(file);
};

// 儀器管理系統：批量下載 Excel（欄位與批量上傳格式相同，可編輯後重新上傳）
window.exportEquipmentExcel = function() {
    if (!equipmentList.length) {
        alert('目前沒有儀器資料可以下載。');
        return;
    }

    const rows = equipmentList.map(eq => {
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

/* =========================================================
   管理員雲端後台：業務名單、價格表、估價單記錄管理
   ========================================================= */
window.switchAdminTab = function(tab, el) {
    document.querySelectorAll('#admin-system .sub-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.admin-panel').forEach(p => p.style.display = 'none');
    document.getElementById(`admin-${tab}`).style.display = 'block';

    if (tab === 'sales') ensureSalesListLoaded().then(reloadSalesFromUsers);
    if (tab === 'prices') ensurePriceListLoaded().then(renderAdminPricesTable);
    if (tab === 'agencies') ensurePriceListLoaded().then(() => { renderKeyStatisticBrands(); renderBrandVisibilitySettings(); renderCompanyAgencyBrandSettings(); });
    if (tab === 'statistics') ensurePriceListLoaded().then(loadSalesStatistics);
    if (tab === 'quotes') loadAllQuotesFromCloud();
    if (tab === 'transfer') ensureSalesListLoaded().then(populateTransferDropdowns);
    if (tab === 'storage') resetCleanupPreview();
    if (tab === 'permissions') renderRolePermissions();
};

function renderRolePermissions() {
    const tbody = document.getElementById('rolePermissionsBody');
    if (!tbody) return;
    const roles = ['sales', 'purchaser', 'engineer', 'admin'];
    tbody.innerHTML = PERMISSION_PAGES.map(page => {
        const cells = roles.map(role => {
            const value = getPagePermission(page.key, role);
            const disabled = (role === 'admin' || page.key === 'admin') ? 'disabled' : '';
            return `<td><select class="permission-select" data-role="${role}" data-page="${page.key}" ${disabled}>
                <option value="none" ${value === 'none' ? 'selected' : ''}>禁止查看</option>
                <option value="view" ${value === 'view' ? 'selected' : ''}>僅可查看</option>
                <option value="edit" ${value === 'edit' ? 'selected' : ''}>可編輯</option>
            </select></td>`;
        }).join('');
        return `<tr class="${page.system ? 'permission-system-row' : ''}"><td>${page.label}</td>${cells}</tr>`;
    }).join('');

    const scopeBody = document.getElementById('roleDataScopesBody');
    if (scopeBody) {
        const roles = ['sales', 'purchaser', 'engineer', 'admin'];
        const types = [{ key:'quotes', label:'📄 估價單' }, { key:'orders', label:'📦 訂單' }];
        scopeBody.innerHTML = types.map(type => {
            const cells = roles.map(role => {
                const value = role === 'admin' ? 'all' : (roleDataScopes[role]?.[type.key] || 'none');
                return `<td><select class="permission-select data-scope-select" data-role="${role}" data-type="${type.key}" ${role === 'admin' ? 'disabled' : ''}>
                    <option value="none" ${value === 'none' ? 'selected' : ''}>尚未授權</option>
                    <option value="own" ${value === 'own' ? 'selected' : ''}>只看自己的</option>
                    <option value="all" ${value === 'all' ? 'selected' : ''}>查看所有人</option>
                </select></td>`;
            }).join('');
            return `<tr><td>${type.label}</td>${cells}</tr>`;
        }).join('');
    }
}

window.saveRolePermissions = function() {
    if (trueUserRole !== 'admin') return;
    const next = JSON.parse(JSON.stringify(rolePermissions));
    ['sales', 'purchaser', 'engineer'].forEach(role => { if (!next[role]) next[role] = {}; });
    document.querySelectorAll('#rolePermissionsBody .permission-select:not([disabled])').forEach(select => {
        next[select.dataset.role][select.dataset.page] = select.value;
    });
    const nextScopes = JSON.parse(JSON.stringify(roleDataScopes));
    ['sales', 'purchaser', 'engineer'].forEach(role => { if (!nextScopes[role]) nextScopes[role] = {}; });
    document.querySelectorAll('#roleDataScopesBody .data-scope-select:not([disabled])').forEach(select => {
        nextScopes[select.dataset.role][select.dataset.type] = select.value;
    });
    // 主系統若禁止查看，其子分頁也一併禁止，避免留下無法進入的孤立設定。
    ['sales', 'purchaser', 'engineer'].forEach(role => {
        if (next[role].quote === 'none') { next[role]['quote.create'] = 'none'; next[role]['quote.my'] = 'none'; }
        if (next[role].orders === 'none') { next[role]['orders.list'] = 'none'; next[role]['orders.po'] = 'none'; }
    });
    const status = document.getElementById('permissionSaveStatus');
    if (status) status.innerText = '儲存中…';
    db.collection('settings').doc('rolePermissions').set({ roles: next, dataScopes: nextScopes, updatedAt: firebase.firestore.FieldValue.serverTimestamp(), updatedBy: currentUser.uid }).then(() => {
        rolePermissions = next;
        roleDataScopes = nextScopes;
        renderRolePermissions();
        applyPermissionVisibility();
        loadMyQuotesFromCloud();
        loadOrdersFromCloud();
        if (status) status.innerText = '已儲存';
    }).catch(err => {
        if (status) status.innerText = '';
        alert('儲存權限設定失敗：' + err.message);
    });
};

function renderKeyStatisticBrands() {
    const container = document.getElementById('keyStatisticBrands');
    if (!container) return;
    const brands = getPriceListBrands();
    container.innerHTML = brands.length ? brands.map(brand => `
        <label style="font-size:13px;"><input type="checkbox" class="key-statistic-brand" value="${escapeAttr(brand)}" ${keyStatisticBrands.includes(brand) ? 'checked' : ''}> ${escapeHtml(brand)}</label>
    `).join('') : '<span style="font-size:13px;color:#888;">請先上傳含廠牌資料的價目表。</span>';
}

window.saveKeyStatisticBrands = function() {
    if (currentUserRole !== 'admin') return;
    const selected = [...document.querySelectorAll('.key-statistic-brand:checked')].map(input => input.value);
    db.collection('settings').doc('salesStatistics').set({ keyBrands: selected }).then(() => {
        keyStatisticBrands = selected;
        if (salesStatisticsOrders.length) renderSalesStatistics();
        alert('已儲存重點代理廠牌設定。');
    }).catch(err => alert('儲存設定失敗：' + err.message));
};

function renderCompanyAgencyBrandSettings() {
    const container = document.getElementById('companyAgencyBrandSettings');
    if (!container) return;
    const brands = getAllPriceListBrandsRaw();
    const companies = ['yushin', 'morningstar', 'MULTI-LIFE'];
    container.innerHTML = companies.map(company => {
        const info = companyData[company];
        const selected = companyAgencyBrands[company] || [];
        const brandChoices = brands.length ? brands.map(brand =>
            `<label style="display:inline-block;margin:5px 12px 5px 0;font-size:13px;"><input type="checkbox" class="company-agency-brand" data-company="${company}" value="${escapeAttr(brand)}" ${selected.includes(brand) ? 'checked' : ''}> ${escapeHtml(brand)}</label>`
        ).join('') : '<span style="color:#888;font-size:13px;">請先上傳含廠牌資料的價目表。</span>';
        const otherChoice = `<label style="display:inline-block;margin:5px 12px 5px 0;font-size:13px;padding-left:10px;border-left:2px solid #ccc;"><input type="checkbox" class="company-agency-brand" data-company="${company}" value="${escapeAttr(OTHER_BRAND_OPTION_KEY)}" ${selected.includes(OTHER_BRAND_OPTION_KEY) ? 'checked' : ''}> 其他廠牌（開放自行輸入）</label>`;
        return `<div style="padding:12px 0;border-bottom:1px solid #ddd;"><strong>${escapeHtml(info.title)}（${escapeHtml(info.prefix)}）</strong><div style="margin-top:6px;">${brandChoices}${otherChoice}</div></div>`;
    }).join('');
}

function renderBrandVisibilitySettings() {
    const container = document.getElementById('brandVisibilitySettings');
    if (!container) return;
    const brands = getAllPriceListBrandsRaw();
    const checklistHtml = brands.length
        ? brands.map(brand =>
            `<label style="display:inline-block;margin:5px 16px 5px 0;font-size:13px;"><input type="checkbox" class="brand-visible-checkbox" value="${escapeAttr(brand)}" ${visibleBrands.includes(brand) ? 'checked' : ''}> ${escapeHtml(brand)}</label>`
          ).join('')
        : '<span style="color:#888;font-size:13px;">尚未有任何廠牌，可以先在下面手動新增。</span>';

    container.innerHTML = `
        <div>${checklistHtml}</div>
        <div style="margin-top:10px;">
            <input type="text" id="newVisibleBrandInput" placeholder="輸入新廠牌名稱（價目表沒有也可以）" style="width:240px;">
            <button type="button" class="btn-secondary" onclick="addCustomVisibleBrand()">＋ 新增廠牌</button>
        </div>
    `;
}

// 手動新增一個廠牌到「顯示」清單，就算價目表裡完全沒有這個廠牌的品項也可以先加進來、之後就能在下拉選單選到；
// 這裡只是先加進畫面上的勾選清單，還是要按「儲存廠牌顯示設定」才會真的存檔生效
window.addCustomVisibleBrand = function() {
    const input = document.getElementById('newVisibleBrandInput');
    const name = (input.value || '').trim();
    if (!name) return;
    if (!visibleBrands.includes(name)) visibleBrands.push(name);
    input.value = '';
    renderBrandVisibilitySettings();
};

window.saveBrandVisibilitySettings = function() {
    if (currentUserRole !== 'admin') return;
    const next = Array.from(document.querySelectorAll('.brand-visible-checkbox:checked')).map(input => input.value);
    db.collection('settings').doc('companyAgencyBrands').set({ visibleBrands: next }, { merge: true }).then(() => {
        visibleBrands = next;
        brandVisibilityConfigured = true;
        refreshPriceDatalists();
        alert('已儲存廠牌顯示設定。');
    }).catch(err => alert('儲存設定失敗：' + err.message));
};

window.saveCompanyAgencyBrands = function() {
    if (currentUserRole !== 'admin') return;
    const companies = ['yushin', 'morningstar', 'MULTI-LIFE'];
    const next = { yushin: [], morningstar: [], 'MULTI-LIFE': [] };
    document.querySelectorAll('.company-agency-brand:checked').forEach(input => next[input.dataset.company].push(input.value));
    db.collection('settings').doc('companyAgencyBrands').set({ companies: next }, { merge: true }).then(() => {
        companyAgencyBrands = next;
        companyAgencyBrandsConfigured = true;
        populateQuoteBrandDropdowns();
        alert('已儲存各分公司的代理廠牌設定。');
    }).catch(err => alert('儲存設定失敗：' + err.message));
};

// 管理員銷售統計以「訂單」為準，避免把尚未成交的估價單也算進營收。
window.loadSalesStatistics = function() {
    if (currentUserRole !== 'admin') return;
    const totalEl = document.getElementById('salesStatsSalesInc');
    if (totalEl) totalEl.innerText = '讀取中…';

    db.collection('orders').get().then(snapshot => {
        salesStatisticsOrders = [];
        snapshot.forEach(doc => salesStatisticsOrders.push({ id: doc.id, ...doc.data() }));
        renderSalesStatistics();
    }).catch(err => {
        console.error('讀取銷售統計失敗：', err);
        if (totalEl) totalEl.innerText = '讀取失敗';
        alert('讀取銷售統計失敗，請確認 Firestore 權限設定。');
    });
};

function salesAmount(order) {
    const total = parseFloat(String(order.totalPrice == null ? '' : order.totalPrice).replace(/,/g, ''));
    if (Number.isFinite(total)) return total;
    return (parseFloat(order.qty) || 0) * (parseFloat(order.unitPrice) || 0);
}

// 訂單的 costPrice 是「每單位含稅進貨成本」，故需乘上數量才是該筆訂單的總成本。
function costAmount(order) {
    return (parseFloat(order.costPrice) || 0) * (parseFloat(order.qty) || 0);
}

function productLineForOrder(order) {
    if ((order.brand || '').trim() === '維修') return '維修';
    if ((order.productLine || '').trim()) return order.productLine.trim();
    // 舊訂單沒有產品線時，仍可依貨號回查目前價目表；查不到才列為未分類。
    const match = (order.itemCode || '').trim() && priceList.find(p => p.model && p.model.trim() === order.itemCode.trim());
    return (match && match.productLine) ? match.productLine.trim() : '未分類';
}

function productTypeForOrder(order) {
    if ((order.productType || '').trim()) return order.productType.trim();
    // 舊訂單沒有類型時，同樣可依貨號回查目前價目表；仍找不到才歸到未分類。
    const match = (order.itemCode || '').trim() && priceList.find(p => p.model && p.model.trim() === order.itemCode.trim());
    return (match && match.productType) ? match.productType.trim() : '未分類';
}

function statisticBrandForOrder(order) {
    const brand = (order.brand || '').trim();
    return brand && keyStatisticBrands.includes(brand) ? brand : '其他';
}

function newSalesStatsMetric() {
    return { salesInc: 0, salesEx: 0, costInc: 0, costEx: 0, profit: 0 };
}

function addSalesStatsMetric(metric, order) {
    const salesInc = salesAmount(order);
    const costInc = costAmount(order);
    metric.salesInc += salesInc;
    metric.salesEx += salesInc / 1.05;
    metric.costInc += costInc;
    metric.costEx += costInc / 1.05;
    metric.profit += salesInc - costInc;
}

function renderSalesStatsRows(tbodyId, values) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const entries = Object.entries(values).sort((a, b) => b[1].salesInc - a[1].salesInc);
    tbody.innerHTML = entries.length
        ? entries.map(([name, metric]) => {
            const rate = metric.salesInc ? (metric.profit / metric.salesInc * 100).toFixed(1) + '%' : '－';
            return `<tr><td>${escapeHtml(name)}</td><td>NT$ ${Math.round(metric.salesInc).toLocaleString()}</td><td>NT$ ${Math.round(metric.costInc).toLocaleString()}</td><td>NT$ ${Math.round(metric.profit).toLocaleString()}</td><td>${rate}</td></tr>`;
        }).join('')
        : '<tr><td colspan="5" style="color:#888;">尚無資料</td></tr>';
}

function populateSalesStatisticsFilters() {
    const selects = [
        { id: 'salesStatsSalesFilter', label: '全部業務', values: salesStatisticsOrders.map(o => stripPhoneSuffix(o.salesName) || '未指定業務') },
        { id: 'salesStatsBrandFilter', label: '全部廠牌', values: [...keyStatisticBrands, '其他'] },
        { id: 'salesStatsTypeFilter', label: '全部類型', values: salesStatisticsOrders.map(productTypeForOrder) },
        { id: 'salesStatsLineFilter', label: '全部產品線', values: salesStatisticsOrders.map(productLineForOrder) }
    ];
    selects.forEach(({ id, label, values }) => {
        const select = document.getElementById(id);
        if (!select) return;
        const selected = select.value;
        const options = [...new Set(values)].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
        select.innerHTML = `<option value="">${label}</option>` + options.map(value =>
            `<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join('');
        if (options.includes(selected)) select.value = selected;
    });
}

window.renderSalesStatistics = function() {
    const start = document.getElementById('salesStatsStart')?.value || '';
    const end = document.getElementById('salesStatsEnd')?.value || '';
    populateSalesStatisticsFilters();
    const salesFilter = document.getElementById('salesStatsSalesFilter')?.value || '';
    const brandFilter = document.getElementById('salesStatsBrandFilter')?.value || '';
    const typeFilter = document.getElementById('salesStatsTypeFilter')?.value || '';
    const lineFilter = document.getElementById('salesStatsLineFilter')?.value || '';
    const bySales = {}, byType = {}, byLine = {};
    const total = newSalesStatsMetric();
    let count = 0;

    salesStatisticsOrders.forEach(order => {
        const date = order.orderDate || '';
        if ((start && date < start) || (end && date > end)) return;
        const sales = stripPhoneSuffix(order.salesName) || '未指定業務';
        const line = productLineForOrder(order);
        const type = productTypeForOrder(order);
        const brand = statisticBrandForOrder(order);
        if ((salesFilter && sales !== salesFilter) || (brandFilter && brand !== brandFilter) || (typeFilter && type !== typeFilter) || (lineFilter && line !== lineFilter)) return;
        addSalesStatsMetric(total, order);
        count++;
        if (!bySales[sales]) bySales[sales] = newSalesStatsMetric();
        if (!byType[type]) byType[type] = newSalesStatsMetric();
        if (!byLine[line]) byLine[line] = newSalesStatsMetric();
        addSalesStatsMetric(bySales[sales], order);
        addSalesStatsMetric(byType[type], order);
        addSalesStatsMetric(byLine[line], order);
    });

    const countEl = document.getElementById('salesStatsOrderCount');
    const setMetric = (id, value) => { const el = document.getElementById(id); if (el) el.innerText = `NT$ ${Math.round(value).toLocaleString()}`; };
    setMetric('salesStatsSalesInc', total.salesInc);
    setMetric('salesStatsSalesEx', total.salesEx);
    setMetric('salesStatsCostInc', total.costInc);
    setMetric('salesStatsCostEx', total.costEx);
    setMetric('salesStatsProfit', total.profit);
    const rateEl = document.getElementById('salesStatsProfitRate');
    if (rateEl) rateEl.innerText = total.salesInc ? (total.profit / total.salesInc * 100).toFixed(1) + '%' : '－';
    if (countEl) countEl.innerText = `共 ${count} 筆訂單`;
    renderSalesStatsRows('salesStatsBySales', bySales);
    renderSalesStatsRows('salesStatsByType', byType);
    renderSalesStatsRows('salesStatsByLine', byLine);
};

function escapeAttr(str) {
    return (str || '').toString().replace(/"/g, '&quot;');
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
        if (event.target.closest('button, input, select, textarea, label, a')) return;
        const tbody = row.parentElement;
        tbody?.querySelectorAll('tr.list-row-selected').forEach(selected => selected.classList.remove('list-row-selected'));
        row.classList.add('list-row-selected');
    });
}

/* ---------- 業務名單管理（唯讀，資料來源為 users 集合，與登入帳號綁定） ---------- */
// 這裡顯示 users 集合裡「所有」帳號（包含還沒填 name/code、只能登入沒被列進業務下拉選單的人），
// 讓你能一眼看出目前有哪些帳號對這個系統有登入權限；下拉選單用的業務清單（salesList）不受影響，仍只取有填 name+code 的人
function loadAllUsersForAdmin() {
    return db.collection('users').get().then(snapshot => {
        allUsersCache = [];
        snapshot.forEach(doc => {
            const d = doc.data();
            allUsersCache.push({
                uid: doc.id,
                code: d.code || '',
                name: d.name || '',
                phone: d.phone || '',
                role: d.role || 'sales',
                email: d.email || '',
                disabled: !!d.disabled,
                mustChangePassword: !!d.mustChangePassword
            });
        });
        allUsersCache.sort((a, b) => {
            if (a.name && !b.name) return -1;
            if (!a.name && b.name) return 1;
            return (a.code || '').localeCompare(b.code || '') || a.uid.localeCompare(b.uid);
        });
    }).catch(() => {
        allUsersCache = [];
    });
}

window.renderAdminSalesTable = function() {
    const tbody = document.getElementById('adminSalesBody');
    tbody.innerHTML = '';
    const roleLabel = ROLE_LABELS;
    allUsersCache.forEach((u) => {
        const tr = document.createElement('tr');
        const hasProfile = !!u.name;
        tr.innerHTML = `
            <td>${escapeHtml(u.code || '—')}</td>
            <td>${escapeHtml(u.name || '（尚未設定姓名）')}</td>
            <td>${escapeHtml(u.phone || '—')}</td>
            <td>${u.email ? escapeHtml(u.email) : '<span style="color:#c0392b;font-size:11px;">尚未取得（需等對方登入一次才會同步）</span>'}</td>
            <td>${escapeHtml(roleLabel[u.role] || u.role || '業務')}</td>
            <td>
                ${u.mustChangePassword
                    ? `<span class="status-badge status-soon" style="margin-right:6px;">下次登入須改密碼</span><button type="button" class="btn-small btn-secondary" onclick="toggleMustChangePassword('${u.uid}', false)">取消要求</button>`
                    : `<button type="button" class="btn-small" onclick="toggleMustChangePassword('${u.uid}', true)">🔒 強制下次登入改密碼</button>`}
                <br>
                ${u.email
                    ? `<button type="button" class="btn-small btn-secondary" style="margin-top:4px;" onclick="sendPasswordResetToUser('${escapeAttr(u.email)}')">📧 寄送密碼重設信</button>`
                    : ''}
            </td>
            <td style="font-family:monospace;font-size:11px;color:${hasProfile ? '#999' : '#c0392b'};">${escapeHtml(u.uid)}</td>
        `;
        tbody.appendChild(tr);
    });
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
        alert('設定失敗：' + err.message);
    });
};

// 寄送 Firebase 官方的密碼重設信到指定 Email，對方收信後可以自己點連結設定新密碼
// （適合對方忘記密碼、登不進來的情況；跟「強制下次登入改密碼」是兩種互補的做法）
window.sendPasswordResetToUser = function(email) {
    if (!confirm(`確定要寄送密碼重設信到 ${email} 嗎？`)) return;
    firebase.auth().sendPasswordResetEmail(email).then(() => {
        alert(`密碼重設信已寄出到 ${email}。`);
    }).catch(err => {
        alert('寄送失敗：' + err.message);
    });
};

window.reloadSalesFromUsers = function() {
    return Promise.all([initSalesList(), loadAllUsersForAdmin()]).then(renderAdminSalesTable);
};

/* ---------- 人員異動交接：把某位業務名下的資料整批轉移給新業務 ---------- */
function populateTransferDropdowns() {
    const fromSelect = document.getElementById('transferFromSales');
    const toSelect = document.getElementById('transferToSales');
    if (!fromSelect || !toSelect) return;

    const fromValue = fromSelect.value;
    const toValue = toSelect.value;
    const optionsHtml = '<option value="">請選擇</option>' +
        salesList.filter(s => s.name).map(s => `<option value="${escapeAttr(s.name)}">${escapeHtml(s.name)}</option>`).join('');
    fromSelect.innerHTML = optionsHtml;
    toSelect.innerHTML = optionsHtml;
    if (salesList.some(s => s.name === fromValue)) fromSelect.value = fromValue;
    if (salesList.some(s => s.name === toValue)) toSelect.value = toValue;

    resetTransferPreview();
}

// 選項或範圍勾選有變動時，先把「查詢筆數」的結果隱藏，避免用舊的筆數誤按執行
window.resetTransferPreview = function() {
    const btn = document.getElementById('transferExecuteBtn');
    const result = document.getElementById('transferResult');
    if (btn) btn.style.display = 'none';
    if (result) result.innerText = '';
};

function getTransferSelection() {
    const fromName = document.getElementById('transferFromSales').value;
    const toName = document.getElementById('transferToSales').value;
    const scopes = [];
    if (document.getElementById('transferQuotes').checked) scopes.push({ key: 'quotes', label: '估價單', collection: 'quotes' });
    if (document.getElementById('transferOrders').checked) scopes.push({ key: 'orders', label: '訂單', collection: 'orders' });
    if (document.getElementById('transferEquipment').checked) scopes.push({ key: 'equipment', label: '儀器', collection: 'equipment' });
    return { fromName, toName, scopes };
}

window.previewSalesTransfer = function() {
    const { fromName, toName, scopes } = getTransferSelection();
    const resultEl = document.getElementById('transferResult');
    const executeBtn = document.getElementById('transferExecuteBtn');
    executeBtn.style.display = 'none';

    if (!fromName || !toName) {
        resultEl.innerText = '請先選擇原業務與新業務。';
        return;
    }
    if (fromName === toName) {
        resultEl.innerText = '原業務與新業務不能是同一個人。';
        return;
    }
    if (scopes.length === 0) {
        resultEl.innerText = '請至少勾選一種要轉移的資料範圍。';
        return;
    }

    resultEl.innerText = '查詢中…';

    Promise.all(scopes.map(s => db.collection(s.collection).where('salesName', '==', fromName).get()))
        .then(snapshots => {
            const counts = scopes.map((s, i) => ({ ...s, count: snapshots[i].size }));
            const totalCount = counts.reduce((sum, c) => sum + c.count, 0);

            if (totalCount === 0) {
                resultEl.innerText = `「${fromName}」目前在勾選的範圍內沒有任何資料，不需要轉移。`;
                return;
            }

            resultEl.innerText = `查詢結果（將把「${fromName}」轉移給「${toName}」）：\n` +
                counts.map(c => `・${c.label}：${c.count} 筆`).join('\n') +
                `\n共 ${totalCount} 筆。確認無誤後請按「確認執行轉移」。`;
            executeBtn.style.display = '';
        })
        .catch(err => {
            console.error(err);
            resultEl.innerText = '查詢失敗：' + err.message;
        });
};

window.executeSalesTransfer = function() {
    const { fromName, toName, scopes } = getTransferSelection();
    const resultEl = document.getElementById('transferResult');
    if (!fromName || !toName || fromName === toName || scopes.length === 0) return;

    if (!confirm(`確定要把「${fromName}」名下勾選的資料（${scopes.map(s => s.label).join('、')}）全部改成掛在「${toName}」名下嗎？\n這個動作會直接修改雲端資料，執行後無法一鍵復原，請確認已經按過「查詢筆數」核對過範圍。`)) return;

    document.getElementById('transferExecuteBtn').disabled = true;
    resultEl.innerText = '轉移中，請稍候…';

    Promise.all(scopes.map(s => db.collection(s.collection).where('salesName', '==', fromName).get()))
        .then(snapshots => {
            const updateChains = scopes.map((s, i) => {
                const refs = snapshots[i].docs.map(d => d.ref);
                return runFirestoreBatchUpdates(refs, { salesName: toName }).then(() => ({ label: s.label, count: refs.length }));
            });
            return Promise.all(updateChains);
        })
        .then(results => {
            const totalCount = results.reduce((sum, r) => sum + r.count, 0);
            resultEl.innerText = `轉移完成，共更新 ${totalCount} 筆：\n` +
                results.map(r => `・${r.label}：${r.count} 筆`).join('\n');
            document.getElementById('transferExecuteBtn').style.display = 'none';
            document.getElementById('transferExecuteBtn').disabled = false;

            // 若其他分頁的資料快取已經載入過，順便刷新，避免畫面顯示轉移前的舊資料
            if (typeof allQuotesCache !== 'undefined' && allQuotesCache.length) loadAllQuotesFromCloud();
            if (typeof ordersCache !== 'undefined' && ordersCache.length) loadOrdersFromCloud();
            if (typeof equipmentList !== 'undefined' && equipmentList.length) loadEquipmentFromCloud();
        })
        .catch(err => {
            console.error(err);
            resultEl.innerText = '轉移過程發生錯誤，部分資料可能已經轉移、部分尚未完成，請重新查詢筆數確認目前狀態：' + err.message;
            document.getElementById('transferExecuteBtn').disabled = false;
        });
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

// 依 Firestore batch 500 筆上限，自動切批次執行文件刪除
function runFirestoreBatchDeletes(refs) {
    const CHUNK = 450;
    const chunks = [];
    for (let i = 0; i < refs.length; i += CHUNK) {
        chunks.push(refs.slice(i, i + CHUNK));
    }
    let chain = Promise.resolve();
    chunks.forEach(chunk => {
        chain = chain.then(() => {
            const batch = db.batch();
            chunk.forEach(ref => batch.delete(ref));
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
window.calculateStorageUsage = function() {
    const tbody = document.getElementById('storageUsageBody');
    tbody.innerHTML = '<tr><td colspan="3" style="color:#888;">計算中，請稍候…（資料量大時可能需要幾秒到十幾秒）</td></tr>';

    const collections = [
        { key: 'quotes', label: '估價單' },
        { key: 'orders', label: '訂單' },
        { key: 'equipment', label: '儀器' },
        { key: 'users', label: '業務／使用者帳號' },
        { key: 'settings', label: '價格表等系統設定' }
    ];

    Promise.all(collections.map(c => db.collection(c.key).get()))
        .then(snapshots => {
            let totalBytes = 0;
            let totalDocs = 0;
            const rows = collections.map((c, i) => {
                let bytes = 0;
                snapshots[i].forEach(doc => {
                    bytes += new Blob([JSON.stringify(doc.data())]).size;
                });
                totalBytes += bytes;
                totalDocs += snapshots[i].size;
                return { label: c.label, count: snapshots[i].size, bytes };
            });

            tbody.innerHTML = rows.map(r => `
                <tr><td>${escapeHtml(r.label)}</td><td>${r.count}</td><td>${formatBytes(r.bytes)}</td></tr>
            `).join('') + `
                <tr style="font-weight:bold;background:#f5f5f5;"><td>總計</td><td>${totalDocs}</td><td>${formatBytes(totalBytes)}</td></tr>
            `;
        })
        .catch(err => {
            tbody.innerHTML = `<tr><td colspan="3" style="color:#cc0000;">計算失敗：${escapeHtml(err.message)}</td></tr>`;
        });
};

/* ---------- 批量清理舊資料 ---------- */
// 支援 YYYY/MM/DD 或 YYYY-MM-DD 兩種常見日期字串格式（估價單的日期是手動輸入的文字欄位，格式不完全統一），
// 統一轉成 Date 物件方便比較，避免直接用 Firestore 字串範圍查詢時因格式不一致而漏抓
function parseFlexibleDate(str) {
    if (!str) return null;
    const m = str.toString().trim().match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (!m) return null;
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return isNaN(d.getTime()) ? null : d;
}

const CLEANUP_DATE_FIELD = { quotes: 'quoteDate', orders: 'orderDate' };
const CLEANUP_LABEL = { quotes: '估價單', orders: '訂單' };

// 換了要清理的集合或日期，先把上一次查詢的結果／解鎖狀態清掉，避免用舊的筆數誤按刪除
window.resetCleanupPreview = function() {
    const resultEl = document.getElementById('cleanupResult');
    const confirmArea = document.getElementById('cleanupConfirmArea');
    const confirmInput = document.getElementById('cleanupConfirmInput');
    const executeBtn = document.getElementById('cleanupExecuteBtn');
    if (resultEl) resultEl.innerText = '';
    if (confirmArea) confirmArea.style.display = 'none';
    if (confirmInput) confirmInput.value = '';
    if (executeBtn) executeBtn.disabled = true;
};

window.onCleanupConfirmInput = function() {
    const input = document.getElementById('cleanupConfirmInput');
    const btn = document.getElementById('cleanupExecuteBtn');
    btn.disabled = input.value.trim() !== '確定刪除';
};

// 抓出目前設定的集合＋日期範圍內符合條件的文件（在前端過濾日期，避免格式不一致漏抓）
function getMatchingCleanupDocs() {
    const collectionKey = document.getElementById('cleanupCollection').value;
    const startStr = document.getElementById('cleanupStartDate').value;
    const endStr = document.getElementById('cleanupEndDate').value;
    const dateField = CLEANUP_DATE_FIELD[collectionKey];

    if (!startStr || !endStr) return Promise.reject(new Error('請選擇起訖日期'));

    const start = new Date(startStr);
    const end = new Date(endStr);
    end.setHours(23, 59, 59, 999);

    return db.collection(collectionKey).get().then(snapshot => {
        const matched = [];
        snapshot.forEach(doc => {
            const d = parseFlexibleDate(doc.data()[dateField]);
            if (d && d >= start && d <= end) matched.push(doc.ref);
        });
        return matched;
    });
}

window.previewDataCleanup = function() {
    const resultEl = document.getElementById('cleanupResult');
    document.getElementById('cleanupConfirmArea').style.display = 'none';

    const startStr = document.getElementById('cleanupStartDate').value;
    const endStr = document.getElementById('cleanupEndDate').value;
    if (!startStr || !endStr) {
        resultEl.innerText = '請選擇起訖日期。';
        return;
    }

    const collectionKey = document.getElementById('cleanupCollection').value;
    resultEl.innerText = '查詢中…';

    getMatchingCleanupDocs().then(refs => {
        if (refs.length === 0) {
            resultEl.innerText = `${startStr} 至 ${endStr} 範圍內沒有符合的${CLEANUP_LABEL[collectionKey]}資料，不需要清理。`;
            return;
        }
        resultEl.innerText = `${startStr} 至 ${endStr} 範圍內共有 ${refs.length} 筆${CLEANUP_LABEL[collectionKey]}資料。\n` +
            `這個動作會直接從雲端刪除，無法復原，建議先自行匯出備份。\n` +
            `確認要刪除的話，請在下方輸入「確定刪除」解鎖按鈕。`;
        document.getElementById('cleanupConfirmArea').style.display = 'block';
        document.getElementById('cleanupConfirmInput').value = '';
        document.getElementById('cleanupExecuteBtn').disabled = true;
    }).catch(err => {
        resultEl.innerText = '查詢失敗：' + err.message;
    });
};

window.executeDataCleanup = function() {
    const input = document.getElementById('cleanupConfirmInput');
    if (input.value.trim() !== '確定刪除') return;

    const collectionKey = document.getElementById('cleanupCollection').value;
    const startStr = document.getElementById('cleanupStartDate').value;
    const endStr = document.getElementById('cleanupEndDate').value;
    const resultEl = document.getElementById('cleanupResult');

    if (!confirm(`最後確認：即將刪除 ${startStr} 至 ${endStr} 範圍內的所有${CLEANUP_LABEL[collectionKey]}資料，這個動作無法復原，確定要繼續嗎？`)) return;

    document.getElementById('cleanupExecuteBtn').disabled = true;
    resultEl.innerText = '刪除中，請稍候…';

    getMatchingCleanupDocs().then(refs => {
        return runFirestoreBatchDeletes(refs).then(() => refs.length);
    }).then(count => {
        resultEl.innerText = `已刪除 ${count} 筆${CLEANUP_LABEL[collectionKey]}資料。`;
        document.getElementById('cleanupConfirmArea').style.display = 'none';

        if (collectionKey === 'quotes' && typeof allQuotesCache !== 'undefined' && allQuotesCache.length) loadAllQuotesFromCloud();
        if (collectionKey === 'orders' && typeof ordersCache !== 'undefined' && ordersCache.length) loadOrdersFromCloud();
    }).catch(err => {
        resultEl.innerText = '刪除過程發生錯誤，部分資料可能已刪除、部分尚未完成，請重新查詢筆數確認目前狀態：' + err.message;
        document.getElementById('cleanupExecuteBtn').disabled = false;
    });
};

/* ---------- 價格表管理 ---------- */
window.renderAdminPricesTable = function() {
    renderBrandTabs();
    renderKeyStatisticBrands();

    const tbody = document.getElementById('adminPricesBody');
    tbody.innerHTML = '';

    priceList.forEach((p) => {
        if (activeBrandFilter !== 'ALL' && (p.brand || '未分類') !== activeBrandFilter) {
            return;
        }

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${escapeHtml(p.nameCn || '')}</td>
            <td>${escapeHtml(p.nameEn || '')}</td>
            <td>${escapeHtml(p.model || '')}</td>
            <td>${escapeHtml(p.brand || '')}</td>
            <td>${escapeHtml(p.productType || '')}</td>
            <td>${escapeHtml(p.productLine || '')}</td>
            <td>${(p.price || 0).toLocaleString()}</td>
            <td>${p.cost ? p.cost.toLocaleString() : '<span style="color:#bbb;">未提供</span>'}</td>
        `;
        tbody.appendChild(tr);
    });
};

function renderBrandTabs() {
    const tabsContainer = document.getElementById('priceBrandTabs');
    if (!tabsContainer) return;

    const brandsSet = new Set();
    priceList.forEach(p => {
        if (p.brand && p.brand.trim()) {
            brandsSet.add(p.brand.trim());
        }
    });

    const brands = Array.from(brandsSet);
    let html = `<div class="brand-tab ${activeBrandFilter === 'ALL' ? 'active' : ''}" onclick="switchBrandTab('ALL')">全部 (${priceList.length})</div>`;

    brands.forEach(b => {
        const count = priceList.filter(p => (p.brand || '').trim() === b).length;
        html += `<div class="brand-tab ${activeBrandFilter === b ? 'active' : ''}" onclick="switchBrandTab('${escapeAttr(b)}')">${escapeHtml(b)} (${count})<span class="brand-tab-delete no-print" onclick="event.stopPropagation(); deletePriceBrand('${escapeAttr(b)}')" title="刪除此廠牌價格資料">✕</span></div>`;
    });

    tabsContainer.innerHTML = html;
}

window.switchBrandTab = function(brandName) {
    activeBrandFilter = brandName;
    renderAdminPricesTable();
};

window.deletePriceBrand = async function(brandName) {
    if (!confirm(`確定要刪除「${brandName}」整個廠牌的價格資料嗎？此動作無法復原。`)) return;
    try {
        const priceDoc = db.collection('settings').doc('prices');
        const doc = await priceDoc.get();
        const meta = doc.exists ? doc.data() : {};
        const brands = Array.isArray(meta.brands) ? meta.brands : [];
        const entry = brands.find(b => b.name === brandName);

        if (entry) {
            const chunkCount = entry.chunkCount || 1;
            for (let i = 0; i < chunkCount; i++) {
                const docId = i === 0 ? entry.id : `${entry.id}-part${i}`;
                await db.collection('settings').doc(docId).delete().catch(() => {});
            }
            const remainingBrands = brands.filter(b => b.id !== entry.id);
            await priceDoc.set({ brands: remainingBrands, updatedAt: new Date().toISOString() }, { merge: true });
        } else {
            // 舊版資料可能還存在 settings/prices 文件的 list 欄位裡，一併清掉。
            const legacyList = Array.isArray(meta.list) ? meta.list.filter(item => (item.brand || '').trim() !== brandName) : [];
            await priceDoc.set({ list: legacyList, updatedAt: new Date().toISOString() }, { merge: true });
        }

        priceList = priceList.filter(p => (p.brand || '').trim() !== brandName);
        if (activeBrandFilter === brandName) activeBrandFilter = 'ALL';
        refreshPriceDatalists();
        renderAdminPricesTable();
        renderCompanyAgencyBrandSettings();
        alert(`已刪除「${brandName}」的價格資料。`);
    } catch (err) {
        alert('刪除失敗：' + err.message);
    }
};

// 價格表僅能透過上傳 Excel 整批更新，不開放在網頁上逐筆編輯／新增／刪除
function setPriceUploadProgress(percent, status, keepVisible = true) {
    const wrap = document.getElementById('priceUploadProgress');
    const statusEl = document.getElementById('priceUploadStatus');
    const percentEl = document.getElementById('priceUploadPercent');
    const bar = document.getElementById('priceUploadProgressBar');
    if (!wrap || !statusEl || !percentEl || !bar) return;
    wrap.style.display = keepVisible ? '' : 'none';
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    statusEl.innerText = status;
    percentEl.innerText = `${safePercent}%`;
    bar.style.width = `${safePercent}%`;
}

function priceBrandDocumentId(brand) {
    return `price-brand-${encodeURIComponent(brand)}`;
}

// 將一個廠牌的品項陣列依 JSON 大小切成多份，每份控制在 maxBytes 以內，
// 避免超過 Firestore 單一文件 1MB 的硬限制（保留安全緩衝）。
function chunkPriceItems(imported, maxBytes) {
    const chunks = [];
    let current = [];
    let currentSize = 2; // 陣列外層的中括號
    imported.forEach(item => {
        const itemSize = new Blob([JSON.stringify(item)]).size + 1; // +1 估算逗號
        if (current.length && currentSize + itemSize > maxBytes) {
            chunks.push(current);
            current = [];
            currentSize = 2;
        }
        current.push(item);
        currentSize += itemSize;
    });
    if (current.length) chunks.push(current);
    return chunks.length ? chunks : [[]];
}

async function savePriceBrandList(imported, brand) {
    const maxBytes = 700 * 1024; // 留緩衝空間給欄位名稱等額外開銷，避免貼近 1MB 上限
    const chunks = chunkPriceItems(imported, maxBytes);
    const priceDoc = db.collection('settings').doc('prices');
    const brandId = priceBrandDocumentId(brand);
    const chunkDocId = (index) => index === 0 ? brandId : `${brandId}-part${index}`;

    for (let i = 0; i < chunks.length; i++) {
        setPriceUploadProgress(85 + Math.round(((i + 1) / chunks.length) * 10), `正在儲存「${brand}」價目表（第 ${i + 1}/${chunks.length} 個分片）…`);
        await db.collection('settings').doc(chunkDocId(i)).set({
            brand, items: chunks[i], updatedAt: new Date().toISOString(),
            chunkIndex: i, chunkCount: chunks.length
        });
    }

    const doc = await priceDoc.get();
    const meta = doc.exists ? doc.data() : {};
    const brands = Array.isArray(meta.brands) ? meta.brands.filter(item => item.id !== brandId) : [];
    const previousEntry = Array.isArray(meta.brands) ? meta.brands.find(item => item.id === brandId) : null;
    const previousChunkCount = (previousEntry && previousEntry.chunkCount) || 1;

    // 若這次上傳的分片數比上次少，刪除多出來的舊分片文件，避免留下用不到的雲端資料。
    for (let i = chunks.length; i < previousChunkCount; i++) {
        await db.collection('settings').doc(chunkDocId(i)).delete().catch(() => {});
    }

    brands.push({ id: brandId, name: brand, chunkCount: chunks.length });
    brands.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    return priceDoc.set({
        // 舊版 list 暫時保留，尚未個別上傳的廠牌仍可正常讀取；同廠牌的新資料會優先取代舊資料。
        storage: 'brands', brands, updatedAt: new Date().toISOString()
    }, { merge: true });
}

window.handlePriceExcelUpload = function(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    setPriceUploadProgress(0, '準備讀取價格表…');
    const reader = new FileReader();
    reader.onprogress = function(event) {
        if (!event.lengthComputable) return;
        // 檔案讀取階段使用 0～50%，保留後半段顯示資料整理與雲端儲存（多廠牌需逐一儲存，會分段顯示進度）。
        setPriceUploadProgress((event.loaded / event.total) * 50, '讀取 Excel 檔案中…');
    };
    reader.onload = async function(e) {
        try {
            setPriceUploadProgress(55, '正在整理價格資料…');
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            const getField = (row, keys) => {
                for (const k of keys) {
                    if (row[k] !== undefined && row[k] !== '') return row[k];
                }
                return '';
            };

            // 全形英數字／空白轉半形，避免輸入法不小心切到全形模式時，
            // 「Ｂiorad」和「Biorad」被系統誤判成兩個不同的廠牌。
            const toHalfWidth = (str) => String(str || '')
                .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
                .replace(/\u3000/g, ' ')
                .trim();

            // 每個工作表視為一個廠牌，工作表名稱即為廠牌名稱。
            const brandGroups = [];
            workbook.SheetNames.forEach(sheetName => {
                const brand = toHalfWidth(sheetName);
                if (!brand) return;
                const sheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
                const imported = [];

                rows.forEach(row => {
                    const nameCn = String(getField(row, ['中文品名', '品名', '中文名稱'])).trim();
                    const nameEn = String(getField(row, ['英文品名', '英文名稱'])).trim();
                    const model = String(getField(row, ['貨號', '型號'])).trim();
                    const productType = String(getField(row, ['類型', '產品類型', '品項類型', 'Type'])).trim();
                    const productLine = String(getField(row, ['產品線', '產品類別', 'Product Line'])).trim();

                    const price = parseFloat(getField(row, ['含稅單價', '單價', '價格'])) || 0;
                    const costRaw = getField(row, ['含稅成本', '成本', '進貨成本']);
                    const cost = costRaw === '' ? null : parseFloat(costRaw) || 0;

                    if (nameCn || nameEn || model) {
                        imported.push({ nameCn, nameEn, model, brand, productType, productLine, price, cost });
                    }
                });

                if (imported.length) brandGroups.push({ brand, imported });
            });

            if (!brandGroups.length) {
                setPriceUploadProgress(0, '找不到可上傳的價格資料。');
                alert('無法從 Excel 辨識出有效的價格資料。請確認每個工作表的名稱就是廠牌名稱，且內容包含品名或貨號等欄位。');
                input.value = '';
                return;
            }

            const savedBrands = [];
            for (let i = 0; i < brandGroups.length; i++) {
                const { brand, imported } = brandGroups[i];
                const basePercent = 55 + Math.round((i / brandGroups.length) * 40);
                setPriceUploadProgress(basePercent, `正在儲存「${brand}」（${i + 1}/${brandGroups.length} 個廠牌）的 ${imported.length} 筆資料…`);
                await savePriceBrandList(imported, brand);
                // 直接更新本機清單，其他廠牌不受這次上傳影響。
                priceList = priceList.filter(item => (item.brand || '').trim() !== brand).concat(imported);
                savedBrands.push(`${brand}（${imported.length} 筆）`);
            }

            activeBrandFilter = 'ALL';
            refreshPriceDatalists();
            renderAdminPricesTable();
            renderCompanyAgencyBrandSettings();
            setPriceUploadProgress(100, `完成：已更新 ${savedBrands.length} 個廠牌的價格資料。`);
            alert(`已成功上傳：\n${savedBrands.join('\n')}`);
        } catch (err) {
            setPriceUploadProgress(0, '儲存雲端失敗，請稍後再試。');
            alert('上傳失敗：' + err.message);
        } finally {
            input.value = '';
        }
    };
    reader.onerror = function() {
        setPriceUploadProgress(0, '讀取 Excel 檔案失敗。');
        alert('讀取 Excel 檔案失敗，請重新選擇檔案。');
        input.value = '';
    };
    reader.readAsArrayBuffer(file);
};

/* ---------- 估價單記錄管理 ---------- */
window.loadAllQuotesFromCloud = function() {
    // 將排序欄位從 quoteDate 改為 quoteNo
db.collection('quotes').orderBy('quoteNo', 'desc').get().then(snapshot => {
        allQuotesCache = [];
        snapshot.forEach(doc => allQuotesCache.push({ id: doc.id, ...doc.data() }));
        renderAdminQuotesList();
    }).catch(err => {
        console.error(err);
        alert('讀取估價單記錄失敗，請確認 Firestore 權限設定。');
    });
};

window.renderAdminQuotesList = function() {
    const tbody = document.getElementById('adminQuotesBody');
    const searchInput = document.getElementById('adminQuoteSearch');
    if (!tbody || !searchInput) return;
    const keyword = (searchInput.value || '').toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;

    allQuotesCache.forEach(q => {
        const searchable = `${q.quoteNo || ''} ${q.clientName || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;
        shown++;
        const tr = document.createElement('tr');
        bindListRowSelection(tr);
        tr.innerHTML = `
            <td>${escapeHtml(q.quoteNo || '')}</td>
            <td>${escapeHtml((companyData[q.company] || {}).prefix || q.company || '')}</td>
            <td>${escapeHtml(q.clientName || '')}</td>
            <td>${escapeHtml(q.salesName || '')}</td>
            <td>${escapeHtml(q.quoteDate || '')}</td>
            <td>${escapeHtml(q.grandTotal || '')}</td>
            <td class="no-print">
                <button type="button" class="btn-small" onclick="openQuoteFromAdmin('${q.quoteNo}')">載入</button>
                <button type="button" class="btn-danger" onclick="deleteQuoteFromAdmin('${q.quoteNo}')">刪除</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('adminQuotesEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

window.openQuoteFromAdmin = function(quoteNo) {
    fetchAndFillQuote(quoteNo);
};

window.deleteQuoteFromAdmin = function(quoteNo) {
    if (!confirm(`確定要刪除估價單 ${quoteNo} 嗎？此動作無法復原。`)) return;
    db.collection('quotes').doc(quoteNo).delete().then(() => {
        loadAllQuotesFromCloud();
    }).catch(err => {
        alert('刪除失敗：' + err.message);
    });
};

window.exportQuotesCSV = function() {
    const keyword = (document.getElementById('adminQuoteSearch').value || '').toLowerCase();
    const rows = allQuotesCache.filter(q => {
        const searchable = `${q.quoteNo || ''} ${q.clientName || ''}`.toLowerCase();
        return !keyword || searchable.includes(keyword);
    });

    if (rows.length === 0) {
        alert('沒有資料可以匯出');
        return;
    }

    const header = ['單號', '公司', '客戶', '業務', '日期', '總計'];
    const csvRows = [header.join(',')];
    rows.forEach(q => {
        const line = [q.quoteNo, q.company, q.clientName, q.salesName, q.quoteDate, q.grandTotal]
            .map(v => `"${(v || '').toString().replace(/"/g, '""')}"`)
            .join(',');
        csvRows.push(line);
    });

    const csvContent = '\uFEFF' + csvRows.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `估價單記錄_${getFormattedDateCode()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
};
