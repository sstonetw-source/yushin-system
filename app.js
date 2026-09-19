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
let priceCatalogMeta = [];
let priceItemLookup = new Map();
let currentUser = null;      // 目前登入的 Firebase Auth 使用者物件
let currentUserRole = null;  // 'admin' / 'sales' / 'purchaser' / 'warehouse' / 'engineer' —— 目前實際套用在畫面上的「有效身份」
let trueUserRole = null;     // 真正登入帳號的身份；只有這個是 admin，才能用下面的「檢視身份」切換功能
let mustChangePassword = false;  // 管理員要求這個帳號下次登入必須先改密碼
const ROLE_LABELS = { admin: '管理員', sales: '業務', purchaser: '採購', warehouse: '倉管', engineer: '工程師' };
const PERMISSION_LEVELS = { none: 0, view: 1, edit: 2 };
const PERMISSION_PAGES = [
    { key: 'forecast', label: '📈 Forecast', system: true },
    { key: 'quote', label: '📄 估價單系統', system: true },
    { key: 'quote.create', label: '　建立估價單' },
    { key: 'quote.my', label: '　我的估價單' },
    { key: 'orders', label: '📦 訂單管理系統', system: true },
    { key: 'orders.list', label: '　業務訂單' },
    { key: 'orders.po', label: '　採購訂單' },
    { key: 'inventory', label: '📦 庫存管理', system: true },
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
let productMasterLoadPromise = null;
let productMasterCache = [];
let quickProductTarget = null;
let clientHistoryLoadPromise = null;
let quoteFormInitialized = false;
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_CURRENCY = 'TWD';
const DEFAULT_TAX_RATE = 0.05;
const BUSINESS_STATUS = Object.freeze({
    ACTIVE: 'active',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    VOIDED: 'voided'
});

function parseMoney(value) {
    const number = Number(String(value ?? '').replace(/,/g, '').trim());
    return Number.isFinite(number) ? number : 0;
}

function grossAmountMetadata(grossValue, taxRate = DEFAULT_TAX_RATE, currency = DEFAULT_CURRENCY) {
    const gross = Math.round(parseMoney(grossValue));
    const net = Math.round(gross / (1 + taxRate));
    return {
        currency,
        taxRate,
        priceIncludesTax: true,
        subtotalExTax: net,
        taxAmount: gross - net,
        totalIncTax: gross
    };
}

function netAmountMetadata(netValue, taxRate = DEFAULT_TAX_RATE, currency = DEFAULT_CURRENCY) {
    const net = Math.round(parseMoney(netValue));
    const tax = Math.round(net * taxRate);
    return {
        currency,
        taxRate,
        priceIncludesTax: false,
        subtotalExTax: net,
        taxAmount: tax,
        totalIncTax: net + tax
    };
}
const XLSX_SCRIPT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
let xlsxLoadPromise = null;

// Excel 功能實際被使用時才下載 SheetJS，避免拖慢首頁開啟速度。
function ensureXlsxLoaded() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (xlsxLoadPromise) return xlsxLoadPromise;
    xlsxLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = XLSX_SCRIPT_URL;
        script.async = true;
        script.onload = () => resolve(window.XLSX);
        script.onerror = () => {
            xlsxLoadPromise = null;
            reject(new Error('Excel 元件下載失敗，請檢查網路後再試一次。'));
        };
        document.head.appendChild(script);
    });
    return xlsxLoadPromise;
}

// 儀器管理系統狀態
let equipmentList = [];
let currentEquipmentId = null;
let equipmentLoadGeneration = 0;

// 管理員後台狀態
let allQuotesCache = [];
let allUsersCache = [];
let salesCodeMasterCache = [];
let salesStatisticsOrders = [];
let salesStatisticsLoadPromise = null;
let inventoryAnalysisReceipts = [];
let inventoryAnalysisStocks = [];
let keyStatisticBrands = [];
let keyStatisticBrandAliases = {};
const DEFAULT_KEY_STATISTIC_BRANDS = ['Roche', 'Tanbead', 'Qiagen', 'Bio-Rad', 'Beckman', 'Thermo'];
const DEFAULT_STATISTIC_BRAND_ALIASES = { 'Bio-Rad': ['Biorad', 'Bio Rad', 'BIO-RAD'], 'Thermo': ['Thermo Fisher', 'Thermo Fisher Scientific'] };
let companyAgencyBrands = { yushin: [], morningstar: [], 'MULTI-LIFE': [] };
let companyAgencyBrandsConfigured = false;
// Phase 1：Brand Master 為全系統正式廠牌來源；尚未完成舊資料移轉前，仍合併價目表／統計／分公司舊設定以保持相容。
let brandMasterCache = [];
let brandMasterLoadPromise = null;
let supplierMasterCache = [];
let supplierMappingCache = [];
let warehouseMasterCache = [];
let supplierWarehouseLoadPromise = null;
let hiddenBrands = [];       // 舊欄位，保留避免舊資料丟失，畫面已經不再使用黑名單模式

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

const comparisonCompanyData = {
    yushin: { ...companyData.yushin, label: '又鑫', logo: 'assets/logo-yushin.png' },
    morningstar: { ...companyData.morningstar, label: '辰星', logo: 'assets/logo-morningstar.png' },
    'MULTI-LIFE': { ...companyData['MULTI-LIFE'], label: '鼎新', logo: 'assets/logo-dingxin.png' },
    youfu: {
        label: '優服', title: '優服生物科技有限公司', sub: 'Youfu Service Biotech. Ltd.',
        addr: '地址：臺中市西區臺灣大道二段285號14樓之3', contact: '電話：0983-385-729 &nbsp;|&nbsp; 統編：91050632',
        logo: '', stamp: 'assets/comparison/youfu-stamp.png'
    },
    yihder: {
        label: '裕德', title: '裕德科技有限公司', sub: 'SCILAB TECHNOLOGY CO., LTD.',
        addr: '地址：235 新北市中和區中山路二段365巷2弄1號', contact: 'Tel：02-2226-7636 &nbsp;|&nbsp; Fax：02-2226-4718 &nbsp;|&nbsp; 統編：27901117',
        logo: 'assets/comparison/yihder-logo.png', stamp: 'assets/comparison/yihder-stamp.png', logoIsHeader: true
    },
    kangning: {
        label: '康寧', title: '康寧生物科技股份有限公司', sub: 'CONEW BIOTECHNOLOGY INC.',
        addr: '', contact: '',
        logo: 'assets/comparison/kangning-logo.png', stamp: 'assets/comparison/kangning-stamp.png', logoIsHeader: true
    },
    wiseregen: {
        label: '思睿', title: '思睿股份有限公司', sub: 'WiseRegen Co., Ltd.',
        addr: '地址：臺北市中山區民生東路一段58號9樓之1', contact: 'TEL：0920-095-000 &nbsp;|&nbsp; 統編：93753406',
        logo: '', stamp: 'assets/comparison/wiseregen-stamp.png'
    }
};
const COMPARISON_COMPANY_ORDER = ['yushin', 'morningstar', 'MULTI-LIFE', 'youfu', 'yihder', 'kangning', 'wiseregen'];

window.addEventListener('DOMContentLoaded', () => {
    if (!history.state?.yushinApp) {
        history.replaceState({ yushinApp: true, tabId: '', scrollY: 0 }, '', location.href);
    }
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

    // 訂單「更多操作」選單：一次只開一個，點擊外部、完成選擇或按 Esc 都會收起。
    document.addEventListener('toggle', event => {
        const openedMenu = event.target.closest?.('.order-more-menu');
        if (!openedMenu?.open) return;
        document.querySelectorAll('.order-more-menu[open]').forEach(menu => {
            if (menu !== openedMenu) menu.open = false;
        });
    }, true);
    document.addEventListener('click', event => {
        const menu = event.target.closest?.('.order-more-menu');
        if (!menu) {
            document.querySelectorAll('.order-more-menu[open]').forEach(openMenu => { openMenu.open = false; });
            return;
        }
        if (event.target.closest('.order-more-menu-popover button')) menu.open = false;
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll('.order-more-menu[open]').forEach(menu => { menu.open = false; });
    });

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

function salesCodeForName(salesName) {
    const normalizedName = stripPhoneSuffix(salesName || '');
    if (!normalizedName) return '';
    if (normalizedName === stripPhoneSuffix(currentUserName || '') && currentUserCode) return currentUserCode;
    const match = salesList.find(person => stripPhoneSuffix(person.name || '') === normalizedName);
    return String(match?.code || '').trim();
}

function normalizeCustomerKey(value) {
    return String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function customerIdForName(value) {
    const key = normalizeCustomerKey(value);
    return key ? `cus:${encodeURIComponent(key).slice(0, 180)}` : '';
}

function syncCustomerMaster(customerName, extra = {}) {
    const name = String(customerName || '').trim();
    const customerId = customerIdForName(name);
    if (!customerId || !currentUser) return customerId;

    // 主交易不等待 Customer Master 寫入，避免新增估價／訂單被次要同步拖慢。
    if (currentUserRole === 'admin' || currentUserRole === 'sales') {
        db.collection('customers').doc(customerId).set({
            customerId,
            name,
            active: true,
            lastSalesCode: extra.salesCode || currentUserCode || '',
            updatedAt: new Date().toISOString()
        }, { merge: true }).catch(err => console.warn('Customer Master 同步失敗：', err));
    }
    return customerId;
}

function belongsToCurrentUser(salesName, ownerUid, salesCode = '') {
    if (salesCode && currentUserCode) return String(salesCode) === String(currentUserCode);
    if (ownerUid && currentUser?.uid) return ownerUid === currentUser.uid;
    if (!currentUserName) return false;
    return stripPhoneSuffix(salesName || '') === stripPhoneSuffix(currentUserName);
}

function getActivePermissionPage() {
    const section = document.querySelector('.content-section.active');
    if (!section) return '';
    if (section.id === 'quote-system') return document.getElementById('myQuotesPanel')?.style.display === 'block' ? 'quote.my' : 'quote.create';
    if (section.id === 'order-system') return document.getElementById('poListPanel')?.style.display === 'block' ? 'orders.po' : 'orders.list';
    if (section.id === 'forecast-system') return 'forecast';
    if (section.id === 'inventory-system') return 'inventory';
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
    return ['forecast', 'quote', 'orders', 'inventory', 'equipment'].find(canAccessPage) || (currentUserRole === 'admin' ? 'admin' : '');
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
    const activeMainKey = activeSection ? { 'forecast-system':'forecast', 'quote-system':'quote', 'order-system':'orders', 'inventory-system':'inventory', 'equipment-system':'equipment', 'admin-system':'admin' }[activeSection.id] : '';
    if (activeMainKey && !canAccessPage(activeMainKey)) {
        const fallback = firstAccessibleMainPage();
        const fallbackId = { forecast:'forecast-system', quote:'quote-system', orders:'order-system', inventory:'inventory-system', equipment:'equipment-system', admin:'admin-system' }[fallback];
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
    if (mainKey === 'forecast') Promise.all([ensureSalesListLoaded(), ensurePriceListLoaded()]).then(() => loadForecasts(true));
    if (mainKey === 'quote') ensureQuoteFormInitialized();
    if (mainKey === 'orders') Promise.all([ensureSalesListLoaded(), ensurePriceListLoaded()]).then(loadOrdersFromCloud);
    if (mainKey === 'inventory') loadInventory(true);
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
let restoringBrowserNavigation = false;

function currentAppNavigationState() {
    const active = document.querySelector('.content-section.active');
    const tabId = active?.id || '';
    const state = { yushinApp: true, tabId, scrollY: window.scrollY || 0 };
    if (tabId === 'quote-system') state.quoteView = document.getElementById('myQuotesPanel')?.style.display === 'block' ? 'my' : 'create';
    if (tabId === 'order-system') state.orderView = document.getElementById('poListPanel')?.style.display === 'block' ? 'po' : 'list';
    return state;
}

function pushAppNavigationState(extra = {}) {
    if (restoringBrowserNavigation) return;
    const current = currentAppNavigationState();
    history.replaceState({ ...(history.state || {}), ...current, scrollY: window.scrollY || 0 }, '', location.href);
    history.pushState({ ...current, ...extra, yushinApp: true, scrollY: 0 }, '', location.href);
}

window.switchMainTab = function(tabId, el) {
    if (document.querySelector('.content-section.active')?.id !== tabId) pushAppNavigationState({ tabId });
    actuallySwitchMainTab(tabId, el, { preserveSubView: true });
};

window.addEventListener('popstate', event => {
    const state = event.state;
    if (!state?.yushinApp || !currentUser) return;
    restoringBrowserNavigation = true;
    try {
        if (state.tabId) actuallySwitchMainTab(state.tabId, null, { preserveSubView: true, skipReload: true });
        if (state.tabId === 'quote-system' && state.quoteView) switchQuoteView(state.quoteView, null, { skipHistory: true, skipReload: true });
        if (state.tabId === 'order-system' && state.orderView) switchOrderView(state.orderView, null, { skipHistory: true, skipReload: true });
        requestAnimationFrame(() => window.scrollTo(0, Number(state.scrollY) || 0));
    } finally {
        restoringBrowserNavigation = false;
    }
});

// 「檢視身份」切換：只是把畫面上用來判斷權限/欄位的 currentUserRole 換成別的角色，
// 讓管理員可以確認/測試各角色實際看到的畫面長怎樣。真正的身份還是 trueUserRole，
// 這裡不會改動 Firebase 帳號本身，Firestore 的存取權限仍然是照登入帳號真正的角色在判斷。
window.switchViewRole = function(role) {
    if (trueUserRole !== 'admin') return;
    currentUserRole = role;
    // 先清掉前一個視角的分頁狀態，避免非同步查詢完成前短暫顯示不屬於新視角的資料。
    myQuotesCache = [];
    myQuotesPaginationState = null;
    ordersCache = [];
    orderPaginationState = null;
    forecastCache = [];
    forecastCursor = null;
    forecastHasMore = true;
    inventoryCache = [];
    inventoryCursor = null;
    inventoryHasMore = true;
    pendingInventoryCache = [];
    equipmentList = [];
    const activeSection = document.querySelector('.content-section.active');
    if (activeSection?.id === 'order-system') renderOrdersList();
    if (activeSection?.id === 'quote-system' && document.getElementById('myQuotesPanel')?.style.display === 'block') renderMyQuotesList();
    if (activeSection?.id === 'forecast-system') renderForecastList();
    if (activeSection?.id === 'inventory-system') { renderInventoryList(); renderPendingInventoryItems(); }
    if (activeSection?.id === 'equipment-system') renderEquipmentList();
    showApp();

    // showApp 只會重新載入目前正在看的模組；其他模組等使用者切入時再載入。
    // 避免管理員每切換一次檢視身份，就同時查詢估價單、訂單與全部儀器。

    // 如果目前正在看管理員後台，但模擬身份已經不是管理員，就先跳轉離開，避免卡在打不開的分頁
    if (activeSection && activeSection.id === 'admin-system' && currentUserRole !== 'admin') {
        actuallySwitchMainTab('quote-system');
    }
};

function actuallySwitchMainTab(tabId, el, options = {}) {
    const mainKey = { 'forecast-system':'forecast', 'quote-system':'quote', 'order-system':'orders', 'inventory-system':'inventory', 'equipment-system':'equipment', 'admin-system':'admin' }[tabId];
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

    if (tabId === 'inventory-system') {
        if (!options.skipReload) loadInventory(true);
    } else if (tabId === 'forecast-system') {
        if (!options.skipReload) loadForecasts(true);
    } else if (tabId === 'equipment-system') {
        if (!options.skipReload) initializePageData('equipment');
    } else if (tabId === 'order-system') {
        const orderView = canAccessPage('orders.list') ? 'list' : 'po';
        if (!options.preserveSubView) switchOrderView(orderView, document.getElementById(orderView === 'list' ? 'osub-list' : 'osub-po'), { skipHistory: true });
        if (!options.skipReload) initializePageData('orders');
    } else if (tabId === 'quote-system') {
        if (!options.skipReload) initializePageData('quote');
        const quoteView = canAccessPage('quote.create') ? 'create' : 'my';
        if (!options.preserveSubView) switchQuoteView(quoteView, document.getElementById(quoteView === 'create' ? 'qsub-create' : 'qsub-my'), { skipHistory: true });
    } else if (tabId === 'admin-system') {
        if (!options.skipReload) initializePageData('admin');
    }
    updateReadonlyNotice();
}

/* =========================================================
   Forecast：業務機會追蹤
   - Stage 1~5
   - 狀態：進行中 / Win / Lost
   - 最新進度自動帶日期
   - 完整進度歷史存於 forecasts/{id}/progress
   - 不要求預計成交日期，也不直接異動庫存
   ========================================================= */
let forecastCache = [];
let forecastCursor = null;
let forecastHasMore = true;
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

function populateForecastBrandFilter() {
    const select = document.getElementById('forecastBrandFilter');
    if (!select) return;

    const current = select.value;
    const brands = new Map();

    getPriceListBrands(false).forEach(brand => {
        const key = String(brand || '').trim().toLocaleLowerCase();
        if (key && !brands.has(key)) brands.set(key, brand);
    });

    forecastCache.forEach(item => {
        const brand = normalizeForecastBrand(item.brand || '');
        const key = brand.toLocaleLowerCase();
        if (key && !brands.has(key)) brands.set(key, brand);
    });

    select.innerHTML = '<option value="">全部廠牌</option>';
    [...brands.values()]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
        .forEach(brand => {
            const option = document.createElement('option');
            option.value = brand;
            option.textContent = brand;
            select.appendChild(option);
        });

    if ([...select.options].some(option => option.value === current)) {
        select.value = current;
    }
}

function populateForecastSalesFilter() {
    const select = document.getElementById('forecastSalesFilter');
    if (!select) return;

    const canSeeAll = canViewAllData('forecast');
    if (!canSeeAll) {
        const label = currentUserName || '我的 Forecast';
        select.innerHTML = `<option value="${escapeAttr(currentUserName || '')}">${escapeHtml(label)}</option>`;
        select.value = currentUserName || '';
        select.disabled = true;
        return;
    }

    const current = select.value;
    const names = new Set();

    salesList.forEach(person => {
        const name = stripPhoneSuffix(person.name || '');
        if (name) names.add(name);
    });

    forecastCache.forEach(item => {
        const name = stripPhoneSuffix(item.salesName || '');
        if (name) names.add(name);
    });

    select.disabled = false;
    select.innerHTML = '<option value="">全部業務</option>';

    [...names]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
        .forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });

    if ([...select.options].some(option => option.value === current)) {
        select.value = current;
    }
}

function populateForecastBrandDropdown(selectedBrand = '') {
    const input = document.getElementById('forecastBrand');
    const list = document.getElementById('forecastBrandList');
    if (!input || !list) return;

    const selected = normalizeForecastBrand(selectedBrand);
    const entries = getUnifiedBrandEntries(false)
        .sort((x, y) => Number(y.isKeyBrand) - Number(x.isKeyBrand) || x.name.localeCompare(y.name, 'zh-Hant'));

    list.innerHTML = '';
    entries.forEach(entry => {
        const option = document.createElement('option');
        option.value = entry.name;
        option.label = entry.isKeyBrand ? '重點代理' : '廠牌';
        list.appendChild(option);
    });

    input.value = selected || '';
}

window.loadForecasts = async function(reset = true) {
    if (forecastLoading || !canAccessPage('forecast')) return;

    if (reset) {
        forecastCache = [];
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
        await Promise.all([ensureSalesListLoaded(), ensurePriceListLoaded()]);

        const status = document.getElementById('forecastStatusFilter')?.value || 'active';

        let query = db.collection('forecasts').orderBy('updatedAt', 'desc');

        if (status !== 'all') {
            query = query.where('status', '==', status);
        }

        if (!canViewAllData('forecast')) {
            if (currentUserCode) query = query.where('salesCode', '==', currentUserCode);
            else query = query.where('ownerUid', '==', currentUser?.uid || '');
        }

        query = query.limit(DEFAULT_LIST_LIMIT);

        if (forecastCursor) {
            query = query.startAfter(forecastCursor);
        }

        const snapshot = await query.get();

        if (!snapshot.empty) {
            forecastCursor = snapshot.docs[snapshot.docs.length - 1];
        }

        const records = new Map(forecastCache.map(item => [item.id, item]));
        snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));

        forecastCache = [...records.values()].sort(
            (a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
        );

        forecastHasMore = snapshot.size === DEFAULT_LIST_LIMIT;

        populateForecastBrandFilter();
        populateForecastSalesFilter();
        renderForecastList();
    } catch (err) {
        console.error('讀取 Forecast 失敗', err);
        alert('讀取 Forecast 失敗：' + err.message);
    } finally {
        forecastLoading = false;

        if (button) {
            button.disabled = false;
            button.innerText = '載入更多（每次 50 筆）';
            button.style.display = forecastHasMore ? '' : 'none';
        }
    }
};

window.renderForecastList = function() {
    const body = document.getElementById('forecastListBody');
    if (!body) return;

    const keyword = (document.getElementById('forecastSearch')?.value || '').trim().toLocaleLowerCase();
    const brandFilter = document.getElementById('forecastBrandFilter')?.value || '';
    const salesFilter = document.getElementById('forecastSalesFilter')?.value || '';
    const stageFilter = document.getElementById('forecastStageFilter')?.value || '';
    const periodFilter = document.getElementById('forecastPeriodFilter')?.value || 'this-year';

    body.innerHTML = '';
    let shown = 0;

    forecastCache.forEach(item => {
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

        if (keyword && !searchable.includes(keyword)) return;
        if (brandFilter && brand.toLocaleLowerCase() !== brandFilter.toLocaleLowerCase()) return;
        if (salesFilter && salesName !== salesFilter) return;
        if (stageFilter && item.stage !== stageFilter) return;
        // 進行中 Forecast 是目前 pipeline，跨年度持續顯示；Win/Lost 才依結案/更新時間套用統計期間。
        if (item.status !== 'active' && !dateInUnifiedPeriod(item.closedAt || item.latestProgressAt || item.updatedAt || item.createdAt, periodFilter)) return;

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
            <button type="button" class="btn-small btn-secondary" onclick="openForecastHistoryModal('${escapeAttr(item.id)}')">紀錄</button>
            ${canEditPage('forecast') ? `
                <button type="button" class="btn-small" onclick="openForecastProgressModal('${escapeAttr(item.id)}')">＋進度</button>
                <button type="button" class="btn-small btn-secondary" onclick="openForecastModal('${escapeAttr(item.id)}')">編輯</button>
                <button type="button" class="btn-small btn-secondary" onclick="createQuoteFromForecast('${escapeAttr(item.id)}')">轉估價</button>
                <button type="button" class="btn-small btn-secondary" onclick="createOrderFromForecast('${escapeAttr(item.id)}')">轉訂單</button>
            ` : ''}
        `;

        row.innerHTML = `
            <td data-th="客戶">${escapeHtml(item.customerName || '')}</td>
            <td data-th="廠牌">${escapeHtml(brand || '')}</td>
            <td data-th="產品／品項">${escapeHtml(item.productName || '')}</td>
            <td data-th="預估金額">${Number(item.estimatedAmount || 0).toLocaleString()}</td>
            <td data-th="Stage"><span class="forecast-stage-badge">${escapeHtml(forecastStageLabel(item.stage))}</span></td>
            <td data-th="狀態"><span class="forecast-status-badge ${statusClass}">${escapeHtml(forecastStatusLabel(item.status))}</span></td>
            <td data-th="最新進度" class="forecast-progress-cell">${escapeHtml(item.latestProgress || '')}</td>
            <td data-th="業務">${escapeHtml(salesName)}</td>
            <td data-th="操作" class="no-print forecast-actions">${actions}</td>
        `;

        body.appendChild(row);
    });

    const hint = document.getElementById('forecastEmptyHint');
    if (hint) hint.style.display = shown ? 'none' : 'block';
};

window.openForecastModal = function(id = '') {
    if (!canEditPage('forecast')) return;

    const item = id ? forecastCache.find(entry => entry.id === id) : null;

    document.getElementById('forecastId').value = item?.id || '';
    document.getElementById('forecastCustomer').value = item?.customerName || '';
    populateForecastBrandDropdown(item?.brand || '');
    document.getElementById('forecastProduct').value = item?.productName || '';
    document.getElementById('forecastAmount').value = item?.estimatedAmount || '';
    document.getElementById('forecastStage').value = item?.stage || 'stage1';
    document.getElementById('forecastStatus').value = item?.status || 'active';

    const workflowSection = document.getElementById('forecastWorkflowSection');
    const newProgressSection = document.getElementById('forecastNewProgressSection');
    const currentProgressSection = document.getElementById('forecastCurrentProgressSection');
    const progressInput = document.getElementById('forecastProgress');

    if (item) {
        // 編輯只處理基本資料。Stage／狀態／最新進度統一由「＋進度」修改，避免兩個入口互相覆蓋。
        if (workflowSection) workflowSection.style.display = 'none';
        if (newProgressSection) newProgressSection.style.display = 'none';
        if (currentProgressSection) currentProgressSection.style.display = 'none';
        if (progressInput) progressInput.value = '';
    } else {
        if (workflowSection) workflowSection.style.display = '';
        if (newProgressSection) newProgressSection.style.display = '';
        if (currentProgressSection) currentProgressSection.style.display = 'none';
        if (progressInput) progressInput.value = '';
    }

    document.getElementById('forecastModalTitle').innerText = item ? '編輯 Forecast' : '新增 Forecast';
    document.getElementById('forecastModalOverlay').classList.add('active');
};

window.closeForecastModal = function() {
    document.getElementById('forecastModalOverlay')?.classList.remove('active');
};

window.saveForecast = async function() {
    if (forecastSaveInProgress || !canEditPage('forecast')) return;

    const id = document.getElementById('forecastId').value;
    const existing = id ? forecastCache.find(item => item.id === id) : null;

    const customerName = document.getElementById('forecastCustomer').value.trim();
    const brand = normalizeForecastBrand(document.getElementById('forecastBrand').value);
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

    let stage = existing?.stage || document.getElementById('forecastStage').value || 'stage1';
    const status = existing?.status || document.getElementById('forecastStatus').value || 'active';

    if (!existing && status === 'won') {
        stage = 'stage5';
    }

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
            const rawProgress = document.getElementById('forecastProgress').value.trim();
            const latestProgress = buildForecastProgressText(rawProgress, '立案');

            const record = {
                customerName,
                customerId: syncCustomerMaster(customerName, { salesCode: currentUserCode || '' }),
                brand,
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
                updatedAt: now,
                ...linkedDocumentFields('', '', [])
            };

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
                productName,
                estimatedAmount,
                updatedAt: now
            };

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
        alert('Forecast 儲存失敗：' + err.message);
    } finally {
        forecastSaveInProgress = false;

        if (button) {
            button.disabled = false;
            button.innerText = '儲存';
        }
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

        batch.update(forecastRef, {
            latestProgress: displayText,
            latestProgressAt: now,
            stage,
            status,
            updatedAt: now
        });

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
        alert('Forecast 進度更新失敗：' + err.message);
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
        const snapshot = await db.collection('forecasts').doc(id).collection('progress')
            .orderBy('createdAt', 'desc')
            .limit(100)
            .get();

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

function forecastProductMatch(item) {
    const key = String(item.productName || '').trim().toLocaleLowerCase();

    return priceList.find(product =>
        [product.model, product.nameCn, product.nameEn].some(
            value => String(value || '').trim().toLocaleLowerCase() === key
        )
    ) || null;
}

window.createQuoteFromForecast = function(id) {
    const forecast = forecastCache.find(item => item.id === id);
    if (!forecast) return;

    const match = forecastProductMatch(forecast);

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
        const quoteSnap = await db.collection('quotes').doc(forecast.sourceId).get();
        const quote = quoteSnap.exists ? quoteSnap.data() : null;
        if (Array.isArray(quote?.items) && quote.items.length) {
            const items = quote.items.map(item => ({
                nameCn: item.nameCn || '',
                nameEn: item.nameEn || '',
                model: item.model || '',
                brand: resolveBrandName(item.brand || ''),
                productId: item.productId || '',
                productLine: item.productLine || '',
                productType: item.productType || '',
                spec: item.spec || '',
                qty: Number(item.qty || 1),
                unit: item.unit || '',
                price: parseMoney(item.price),
                subtotal: parseMoney(item.subtotal)
            }));
            // 背景補回 Forecast，之後不必每次重新讀估價單。
            db.collection('forecasts').doc(forecast.id).set({ items }, { merge: true }).catch(() => {});
            forecast.items = items;
            return items;
        }
    }

    const match = forecastProductMatch(forecast);
    return [{
        nameCn: match?.nameCn || forecast.productName || '',
        nameEn: match?.nameEn || '',
        model: match?.model || '',
        brand: normalizeForecastBrand(forecast.brand || match?.brand || ''),
        productId: match?.productId || forecast.productId || '',
        productLine: match?.productLine || '',
        productType: match?.productType || '',
        spec: match?.spec || '',
        qty: 1,
        unit: match?.unit || '',
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
        itemName: item.nameCn || item.nameEn || item.model || forecast.productName || '',
        itemCode: item.model || '',
        brand: normalizeForecastBrand(item.brand || forecast.brand || match?.brand || ''),
        qty,
        unit: item.unit || match?.unit || '',
        unitPrice,
        totalPrice,
        costPrice: parseMoney(match?.cost || 0) || '',
        sourceType: DOCUMENT_TYPES.FORECAST,
        sourceId: forecast.id,
        productId: item.productId || match?.productId || '',
        productLine: item.productLine || match?.productLine || '',
        productType: item.productType || match?.productType || '',
        spec: item.spec || match?.spec || '',
        supplier: match?.supplier || ''
    };
}

async function createForecastOrdersDirectly(forecast, items) {
    const now = new Date().toISOString();
    const orderDate = localDateString();
    const batch = db.batch();
    const createdOrders = [];
    const links = [];

    items.forEach(item => {
        const source = forecastItemToOrderSource(forecast, item);
        if (!source.itemName && !source.itemCode) return;

        const orderRef = db.collection('orders').doc();
        const orderData = {
            orderDate,
            createdAt: now,
            company: currentCompany || 'yushin',
            customerName: forecast.customerName || '',
            customerId: forecast.customerId || customerIdForName(forecast.customerName || ''),
            brand: source.brand,
            itemCode: source.itemCode,
            itemCodeKey: normalizeHistoryItemCode(source.itemCode),
            itemName: source.itemName,
            productId: source.productId || '',
            productLine: source.productLine || '',
            productType: source.productType || '',
            spec: source.spec || '',
            supplier: source.supplier || '',
            qty: source.qty,
            unit: source.unit || '',
            unitPrice: source.unitPrice,
            totalPrice: source.totalPrice,
            costPrice: source.costPrice === '' ? null : source.costPrice,
            status: BUSINESS_STATUS.ACTIVE,
            ...grossAmountMetadata(source.totalPrice),
            transactionType: '',
            invoiceTitle: '',
            quoteNo: '',
            ...linkedDocumentFields(DOCUMENT_TYPES.FORECAST, forecast.id, [
                documentLink(DOCUMENT_TYPES.FORECAST, forecast.id, 'source')
            ]),
            salesName: forecast.salesName || currentUserName || '',
            salesCode: forecast.salesCode || currentUserCode || '',
            ownerUid: forecast.ownerUid || currentUser?.uid || '',
            isOrdered: false,
            isArrived: false,
            isDelivered: false,
            isBilled: false,
            invoiceDate: ''
        };
        batch.set(orderRef, orderData);
        createdOrders.push({ id: orderRef.id, data: orderData });
        links.push(documentLink(DOCUMENT_TYPES.ORDER, orderRef.id, 'created'));
    });

    if (!createdOrders.length) throw new Error('Forecast 沒有可轉成訂單的品項。');

    batch.set(db.collection('forecasts').doc(forecast.id), {
        linkedDocuments: firebase.firestore.FieldValue.arrayUnion(...links),
        updatedAt: now
    }, { merge: true });

    await batch.commit();
    await Promise.all(createdOrders.map(entry => reserveInventoryForNewOrder(entry.id, entry.data)));

    ordersCache = [
        ...createdOrders.map(entry => ({ id: entry.id, ...entry.data })),
        ...ordersCache.filter(order => !createdOrders.some(entry => entry.id === order.id))
    ].sort((x, y) => String(y.orderDate || '').localeCompare(String(x.orderDate || '')));

    return createdOrders;
}

window.createOrderFromForecast = async function(id) {
    const forecast = forecastCache.find(item => item.id === id);
    if (!forecast) return;

    try {
        const items = await forecastOrderItems(forecast);
        if (!items.length) {
            alert('此 Forecast 沒有可帶入訂單的品項。');
            return;
        }

        if (items.length === 1) {
            // 單品項仍開啟新增訂單視窗，讓使用者最後確認／補資料再儲存。
            openOrderModal(forecastItemToOrderSource(forecast, items[0]));
            return;
        }

        if (!confirm(`此 Forecast 含 ${items.length} 個品項，將拆成 ${items.length} 筆訂單。確定繼續？`)) return;
        const created = await createForecastOrdersDirectly(forecast, items);
        renderOrdersList();
        alert(`已將 Forecast 的 ${created.length} 個品項拆成 ${created.length} 筆訂單。`);
    } catch (err) {
        console.error('Forecast 轉訂單失敗', err);
        alert('Forecast 轉訂單失敗：' + err.message);
    }
};


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
            .orderBy('quoteNo', 'desc')
            .limit(1)
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
                const replacementBrands = new Set(meta.brands.map(brand => String(brand.name || '').trim().toLocaleLowerCase()));
                const legacyItems = Array.isArray(meta.list) ? meta.list.filter(item => !replacementBrands.has((item.brand || '').trim().toLocaleLowerCase())) : [];
                priceList = normalizeProductMasterList(legacyItems.concat(docs.flatMap(brandDoc => {
                    const data = brandDoc.exists ? brandDoc.data() : {};
                    return Array.isArray(data.items) ? data.items : [];
                })));
                refreshPriceDatalists();
                renderKeyStatisticBrands();
            });
        }
        priceList = normalizeProductMasterList(meta.list || []);
        refreshPriceDatalists();
        renderKeyStatisticBrands();
    }).catch(() => {});
    return Promise.all([pricesPromise, loadSalesStatisticsSettings(), loadCompanyAgencyBrandSettings(), loadBrandMaster()]).then(async result => {
        // 正式 Product Master 以 products 集合為優先；舊 settings/prices 暫時保留做過渡來源。
        await loadProductMasterOverlay();
        refreshPriceDatalists();
        renderKeyStatisticBrands();
        renderCompanyAgencyBrandSettings();
        return result;
    });
}

function loadCompanyAgencyBrandSettings() {
    return db.collection('settings').doc('companyAgencyBrands').get().then(doc => {
        companyAgencyBrandsConfigured = doc.exists;
        const data = doc.exists ? doc.data() : {};
        const saved = data.companies || {};
        companyAgencyBrands = {
            yushin: normalizeThermoBrandList(saved.yushin || []),
            morningstar: normalizeThermoBrandList(saved.morningstar || []),
            'MULTI-LIFE': normalizeThermoBrandList(saved['MULTI-LIFE'] || [])
        };
        // 舊設定曾將 thermo 以小寫存進雲端；載入時統一分公司代理設定的名稱。
        const rawCompanies = {
            yushin: saved.yushin || [],
            morningstar: saved.morningstar || [],
            'MULTI-LIFE': saved['MULTI-LIFE'] || []
        };
        const needsThermoCleanup = JSON.stringify(companyAgencyBrands) !== JSON.stringify(rawCompanies);
        if (needsThermoCleanup && currentUserRole === 'admin') {
            db.collection('settings').doc('companyAgencyBrands').set({
                companies: companyAgencyBrands
            }, { merge: true }).catch(err => console.error('清理小寫 thermo 設定失敗：', err));
        }
        renderCompanyAgencyBrandSettings();
        refreshPriceDatalists();
    }).catch(() => {
        companyAgencyBrandsConfigured = false;
    });
}

function loadSalesStatisticsSettings() {
    return db.collection('settings').doc('salesStatistics').get().then(doc => {
        const savedBrands = doc.exists ? (doc.data().keyBrands || []) : DEFAULT_KEY_STATISTIC_BRANDS;
        keyStatisticBrands = normalizeThermoBrandList(savedBrands).filter(brand => normalizeStatisticBrandKey(brand) !== normalizeStatisticBrandKey('維修'));
        const savedAliases = doc.exists && doc.data().brandAliases ? doc.data().brandAliases : {};
        const aliasBrands = new Set([...Object.keys(DEFAULT_STATISTIC_BRAND_ALIASES), ...Object.keys(savedAliases)]);
        keyStatisticBrandAliases = {};
        aliasBrands.forEach(brand => {
            keyStatisticBrandAliases[brand] = dedupeBrandsCaseInsensitive([
                ...(DEFAULT_STATISTIC_BRAND_ALIASES[brand] || []),
                ...(savedAliases[brand] || [])
            ]);
        });
        if (doc.exists && JSON.stringify(keyStatisticBrands) !== JSON.stringify(savedBrands) && currentUserRole === 'admin') {
            db.collection('settings').doc('salesStatistics').set({ keyBrands: keyStatisticBrands }, { merge: true })
                .catch(err => console.error('清理重點代理廠牌的小寫 thermo 失敗：', err));
        }
        renderKeyStatisticBrands();
        if (salesStatisticsOrders.length) renderSalesStatistics();
    }).catch(() => {
        keyStatisticBrands = DEFAULT_KEY_STATISTIC_BRANDS.slice();
        keyStatisticBrandAliases = JSON.parse(JSON.stringify(DEFAULT_STATISTIC_BRAND_ALIASES));
        renderKeyStatisticBrands();
    });
}

function refreshPriceDatalists() {
    rebuildPriceItemLookup();
    const cnList = document.getElementById('priceNameCnList');
    const enList = document.getElementById('priceNameEnList');
    const modelList = document.getElementById('priceModelList');
    if (!cnList || !enList) return;
    const cnOptions = [];
    const enOptions = [];
    const modelOptions = [];
    priceList.forEach(p => {
        if (p.nameCn) cnOptions.push(`<option value="${escapeAttr(p.nameCn)}"></option>`);
        if (p.nameEn) enOptions.push(`<option value="${escapeAttr(p.nameEn)}"></option>`);
        if (p.model && modelList) modelOptions.push(`<option value="${escapeAttr(p.model)}"></option>`);
    });
    // 大型價格表改用一次性寫入，避免逐筆新增數萬個選項反覆觸發瀏覽器排版。
    cnList.innerHTML = cnOptions.join('');
    enList.innerHTML = enOptions.join('');
    if (modelList) modelList.innerHTML = modelOptions.join('');
    populateOrderBrandDropdown();
    populateEquipmentBrandDropdown();
    populateQuoteBrandDropdowns();
}

// 舊函式名稱保留供既有模組呼叫；實際候選廠牌已統一由 Brand Master 相容層提供。
function getPriceListBrands(includeMaintenance = false) {
    return getUnifiedBrandNames(includeMaintenance);
}

function dedupeBrandsCaseInsensitive(brands) {
    const unique = new Map();
    (brands || []).forEach(value => {
        const brand = String(value || '').trim();
        const key = brand.toLocaleLowerCase();
        if (brand && !unique.has(key)) unique.set(key, brand);
    });
    return [...unique.values()];
}

function normalizeBrandLookupKey(value) {
    return String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[\s\-_]+/g, '');
}

function normalizeBrandMasterRecord(id, data = {}) {
    const name = String(data.name || data.brand || id || '').trim();
    return {
        id: id || '',
        name,
        aliases: dedupeBrandsCaseInsensitive(data.aliases || []),
        isKeyBrand: data.isKeyBrand === true,
        companies: Array.isArray(data.companies) ? data.companies.filter(Boolean) : [],
        active: data.active !== false
    };
}

function getUnifiedBrandEntries(includeMaintenance = false) {
    const entries = new Map();

    const upsert = (name, patch = {}) => {
        const cleanName = String(name || '').trim();
        if (!cleanName) return;
        if (!includeMaintenance && normalizeBrandLookupKey(cleanName) === normalizeBrandLookupKey('維修')) return;

        // Brand Master 先載入；後續價目表／舊設定若只是 master alias，
        // 直接歸到 canonical entry，不再產生第二個看似不同的廠牌。
        const cleanKey = normalizeBrandLookupKey(cleanName);
        const aliasOwner = [...entries.values()].find(entry =>
            (entry.aliases || []).some(alias => normalizeBrandLookupKey(alias) === cleanKey)
        );
        const canonicalName = aliasOwner?.name || cleanName;
        const key = normalizeBrandLookupKey(canonicalName);
        const existing = entries.get(key) || aliasOwner || {
            id: '',
            name: canonicalName,
            aliases: [],
            isKeyBrand: false,
            companies: [],
            active: true
        };

        if (patch.id && !existing.id) existing.id = patch.id;
        if (patch.name && patch.preferName) existing.name = String(patch.name).trim() || existing.name;
        existing.aliases = dedupeBrandsCaseInsensitive([...(existing.aliases || []), ...(patch.aliases || [])])
            .filter(alias => normalizeBrandLookupKey(alias) !== normalizeBrandLookupKey(existing.name));
        existing.isKeyBrand = existing.isKeyBrand || patch.isKeyBrand === true;
        existing.companies = [...new Set([...(existing.companies || []), ...(patch.companies || [])])];
        if (patch.active === false) existing.active = false;
        entries.set(key, existing);
    };

    // 正式 Brand Master 優先決定顯示名稱。
    brandMasterCache.filter(item => item && item.active !== false).forEach(item => {
        upsert(item.name, { ...item, preferName: true });
    });

    // 舊資料相容層：價目表、統計設定、分公司代理設定在完成移轉前仍納入候選品牌。
    priceList.forEach(item => upsert(item.brand));
    keyStatisticBrands.forEach(name => upsert(name, {
        isKeyBrand: true,
        aliases: keyStatisticBrandAliases[name] || []
    }));
    Object.entries(keyStatisticBrandAliases).forEach(([name, aliases]) => upsert(name, { aliases }));

    ['yushin', 'morningstar', 'MULTI-LIFE'].forEach(company => {
        (companyAgencyBrands[company] || []).forEach(name => {
            if (name !== OTHER_BRAND_OPTION_KEY && name !== '其他') upsert(name, { companies: [company] });
        });
    });

    if (includeMaintenance) upsert('維修');
    return [...entries.values()]
        .filter(item => item.active !== false)
        .sort((x, y) => x.name.localeCompare(y.name, 'zh-Hant'));
}

function getUnifiedBrandNames(includeMaintenance = false) {
    return getUnifiedBrandEntries(includeMaintenance).map(item => item.name);
}

function stableMasterId(prefix, value) {
    const normalized = String(value || '').normalize('NFKC').trim().toLocaleLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
    return prefix + ':' + (normalized || Date.now().toString(36));
}

function warehouseStockDocId(warehouseId, productKey) {
    return encodeURIComponent(String(warehouseId || '')) + '__' + encodeURIComponent(String(productKey || ''));
}

function defaultWarehouse() {
    return warehouseMasterCache.find(item => item.active !== false && item.isDefault) || warehouseMasterCache.find(item => item.active !== false) || null;
}

async function loadSupplierWarehouseMasters(force = false) {
    if (supplierWarehouseLoadPromise && !force) return supplierWarehouseLoadPromise;
    supplierWarehouseLoadPromise = Promise.all([
        db.collection('suppliers').limit(500).get(),
        db.collection('brandSupplierMappings').limit(1000).get(),
        db.collection('warehouses').limit(50).get()
    ]).then(([suppliers, mappings, warehouses]) => {
        supplierMasterCache = suppliers.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(item => item.active !== false);
        supplierMappingCache = mappings.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(item => item.active !== false);
        warehouseMasterCache = warehouses.docs.map(doc => ({ id: doc.id, ...doc.data() })).filter(item => item.active !== false);
        supplierMasterCache.sort((a,b)=>String(a.supplierName||'').localeCompare(String(b.supplierName||''),'zh-Hant'));
        warehouseMasterCache.sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||String(a.warehouseName||'').localeCompare(String(b.warehouseName||''),'zh-Hant'));
        renderSupplierMappingAdmin();
        renderWarehouseMasterAdmin();
        populateOrderWarehouseOptions();
        return { suppliers:supplierMasterCache, mappings:supplierMappingCache, warehouses:warehouseMasterCache };
    }).catch(err => {
        supplierWarehouseLoadPromise = null;
        console.warn('讀取供應商／倉庫主檔失敗：', err);
        return { suppliers:[], mappings:[], warehouses:[] };
    });
    return supplierWarehouseLoadPromise;
}

function supplierForProduct(brand, productLine = '') {
    const brandKey = normalizeBrandLookupKey(resolveBrandName(brand));
    const lineKey = String(productLine || '').normalize('NFKC').trim().toLocaleLowerCase();
    const candidates = supplierMappingCache.filter(item =>
        normalizeBrandLookupKey(item.brandName || item.brand || '') === brandKey
    );
    const lineMatch = candidates.find(item => String(item.productLine || '').normalize('NFKC').trim().toLocaleLowerCase() === lineKey && lineKey);
    const fallback = candidates.find(item => !String(item.productLine || '').trim() && item.isDefault !== false) || candidates.find(item => !String(item.productLine || '').trim());
    const mapping = lineMatch || fallback || null;
    if (!mapping) return null;
    return supplierMasterCache.find(item => item.id === mapping.supplierId || item.supplierId === mapping.supplierId) || null;
}

function renderSupplierMappingAdmin() {
    const body = document.getElementById('supplierMappingBody');
    if (!body) return;
    body.innerHTML = supplierMappingCache.length ? supplierMappingCache.map(mapping => {
        const supplier = supplierMasterCache.find(item => item.id === mapping.supplierId || item.supplierId === mapping.supplierId) || {};
        return `<tr>
            <td>${escapeHtml(mapping.brandName || '')}</td>
            <td>${escapeHtml(mapping.productLine || '預設')}</td>
            <td>${escapeHtml(supplier.supplierName || mapping.supplierName || '')}</td>
            <td>${escapeHtml(supplier.purchaseHeaderName || supplier.supplierName || '')}</td>
            <td><button type="button" class="btn-small btn-danger" onclick="disableSupplierMapping('${escapeAttr(mapping.id)}')">停用</button></td>
        </tr>`;
    }).join('') : '<tr><td colspan="5" style="color:#888;">尚未設定供應商對應。</td></tr>';
}

function renderWarehouseMasterAdmin() {
    const body = document.getElementById('warehouseMasterBody');
    if (!body) return;
    body.innerHTML = warehouseMasterCache.length ? warehouseMasterCache.map(item => `<tr>
        <td>${escapeHtml(item.warehouseName || '')}</td>
        <td>${item.isDefault ? '是' : ''}</td>
        <td>${item.active === false ? '停用' : '啟用'}</td>
        <td><button type="button" class="btn-small btn-danger" onclick="disableWarehouseMaster('${escapeAttr(item.id)}')">停用</button></td>
    </tr>`).join('') : '<tr><td colspan="4" style="color:#888;">尚未建立倉庫。</td></tr>';
}

window.saveSupplierMapping = async function() {
    if (trueUserRole !== 'admin') return;
    const supplierName = String(document.getElementById('supplierMasterName')?.value || '').trim();
    const purchaseHeaderName = String(document.getElementById('supplierMasterHeader')?.value || '').trim() || supplierName;
    const brandName = resolveBrandName(document.getElementById('supplierMappingBrand')?.value || '');
    const productLine = String(document.getElementById('supplierMappingLine')?.value || '').trim();
    const status = document.getElementById('supplierMappingStatus');
    if (!supplierName || !brandName) {
        if (status) status.innerText = '請至少填寫供應商名稱與廠牌。';
        return;
    }
    try {
        const supplierId = stableMasterId('sup', supplierName);
        const mappingId = stableMasterId('bsm', brandName + '|' + (productLine || 'default'));
        const now = new Date().toISOString();
        const batch = db.batch();
        batch.set(db.collection('suppliers').doc(supplierId), { supplierId, supplierName, purchaseHeaderName, active:true, updatedAt:now }, { merge:true });
        batch.set(db.collection('brandSupplierMappings').doc(mappingId), {
            mappingId, brandName, productLine, supplierId, isDefault:!productLine, active:true, updatedAt:now
        }, { merge:true });
        await batch.commit();
        supplierWarehouseLoadPromise = null;
        await loadSupplierWarehouseMasters(true);
        if (status) status.innerText = '供應商對應已儲存。';
    } catch (err) {
        if (status) status.innerText = '儲存失敗：' + err.message;
    }
};

window.disableSupplierMapping = async function(id) {
    if (trueUserRole !== 'admin' || !id) return;
    await db.collection('brandSupplierMappings').doc(id).set({ active:false, updatedAt:new Date().toISOString() }, { merge:true });
    supplierWarehouseLoadPromise = null;
    await loadSupplierWarehouseMasters(true);
};

window.saveWarehouseMaster = async function() {
    if (trueUserRole !== 'admin') return;
    const name = String(document.getElementById('warehouseMasterName')?.value || '').trim();
    const makeDefault = !!document.getElementById('warehouseMasterDefault')?.checked;
    const status = document.getElementById('warehouseMasterStatus');
    if (!name) { if (status) status.innerText = '請輸入倉庫名稱。'; return; }
    try {
        const id = stableMasterId('wh', name);
        const now = new Date().toISOString();
        if (makeDefault) {
            const defaults = warehouseMasterCache.filter(item => item.isDefault && item.id !== id);
            const batch = db.batch();
            defaults.forEach(item => batch.set(db.collection('warehouses').doc(item.id), { isDefault:false, updatedAt:now }, { merge:true }));
            batch.set(db.collection('warehouses').doc(id), { warehouseId:id, warehouseName:name, isDefault:true, active:true, updatedAt:now }, { merge:true });
            await batch.commit();
        } else {
            await db.collection('warehouses').doc(id).set({ warehouseId:id, warehouseName:name, isDefault:false, active:true, updatedAt:now }, { merge:true });
        }
        supplierWarehouseLoadPromise = null;
        await loadSupplierWarehouseMasters(true);
        if (status) status.innerText = '倉庫已儲存。';
        const input=document.getElementById('warehouseMasterName'); if(input) input.value='';
    } catch (err) {
        if (status) status.innerText = '儲存失敗：' + err.message;
    }
};

window.disableWarehouseMaster = async function(id) {
    if (trueUserRole !== 'admin' || !id) return;
    await db.collection('warehouses').doc(id).set({ active:false, isDefault:false, updatedAt:new Date().toISOString() }, { merge:true });
    supplierWarehouseLoadPromise = null;
    await loadSupplierWarehouseMasters(true);
};

function populateOrderWarehouseOptions(selected = '') {
    const select = document.getElementById('orderWarehouse');
    if (!select) return;
    const current = selected || select.value;
    select.innerHTML = '<option value="">請選擇倉庫</option>' + warehouseMasterCache
        .filter(item => item.active !== false)
        .map(item => `<option value="${escapeAttr(item.id)}">${escapeHtml(item.warehouseName || item.id)}${item.isDefault ? '（預設）' : ''}</option>`).join('');
    if (warehouseMasterCache.some(item => item.id === current)) select.value = current;
    else if (defaultWarehouse()) select.value = defaultWarehouse().id;
}

async function warehouseStockSnapshot(productKey, warehouseId) {
    if (!productKey || !warehouseId) return null;
    const ref = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId, productKey));
    const snap = await ref.get().catch(() => null);
    return snap && snap.exists ? { id:snap.id, ...snap.data() } : null;
}

window.refreshOrderWarehouseStock = async function() {
    const hint = document.getElementById('orderWarehouseStockHint');
    const fulfillment = document.getElementById('orderFulfillmentType')?.value || 'WAREHOUSE';
    if (!hint) return;
    if (fulfillment === 'DIRECT_SHIP') {
        hint.innerText = '原廠直送：不占用、不入庫、不出庫；採購與銷售紀錄仍會保留。';
        return;
    }
    const code = document.getElementById('orderItemCode')?.value || '';
    const match = findPriceItemByCodeValue(code);
    const key = match ? (match.productId || stableProductId(match)) : '';
    if (!key) { hint.innerText = '輸入貨號後會顯示各倉庫可用庫存。'; return; }
    await loadSupplierWarehouseMasters();
    const rows = [];
    for (const warehouse of warehouseMasterCache) {
        const stock = await warehouseStockSnapshot(key, warehouse.id);
        const onHand = Number(stock?.onHand || 0), reserved = Number(stock?.reserved || 0);
        rows.push(`${warehouse.warehouseName || warehouse.id}：${Math.max(0,onHand-reserved)} 可用（現有 ${onHand}）`);
    }
    hint.innerText = rows.length ? rows.join(' ｜ ') : '尚未建立倉庫；可先到管理員後台 → 廠牌管理建立。';
};

window.onOrderFulfillmentChange = function() {
    const type = document.getElementById('orderFulfillmentType')?.value || 'WAREHOUSE';
    const wrap = document.getElementById('orderWarehouseWrap');
    if (wrap) wrap.style.display = type === 'WAREHOUSE' ? '' : 'none';
    refreshOrderWarehouseStock();
};


function resolveBrandName(value) {
    const input = String(value || '').trim();
    if (!input) return '';
    const key = normalizeBrandLookupKey(input);

    for (const entry of getUnifiedBrandEntries(true)) {
        if (normalizeBrandLookupKey(entry.name) === key) return entry.name;
        if ((entry.aliases || []).some(alias => normalizeBrandLookupKey(alias) === key)) return entry.name;
    }
    return input;
}

function loadBrandMaster() {
    if (brandMasterLoadPromise) return brandMasterLoadPromise;
    brandMasterLoadPromise = db.collection('brands').limit(500).get().then(snapshot => {
        brandMasterCache = snapshot.docs
            .map(doc => normalizeBrandMasterRecord(doc.id, doc.data()))
            .filter(item => item.name && item.active !== false);
        return brandMasterCache;
    }).catch(err => {
        console.warn('讀取 Brand Master 失敗，暫時沿用既有廠牌設定：', err);
        brandMasterCache = [];
        return brandMasterCache;
    });
    return brandMasterLoadPromise;
}

function brandMasterDocumentId(name) {
    const normalized = normalizeBrandLookupKey(name) || 'brand';
    return encodeURIComponent(normalized).slice(0, 180);
}

async function upsertBrandMaster(name, patch = {}) {
    const canonicalName = String(name || '').trim();
    if (!canonicalName || canonicalName === '其他' || canonicalName === OTHER_BRAND_OPTION_KEY || canonicalName === '維修') return;
    const id = brandMasterDocumentId(canonicalName);
    const current = brandMasterCache.find(item => normalizeBrandLookupKey(item.name) === normalizeBrandLookupKey(canonicalName));
    const payload = {
        name: current?.name || canonicalName,
        aliases: patch.replaceAliases
            ? dedupeBrandsCaseInsensitive(patch.aliases || [])
            : dedupeBrandsCaseInsensitive([...(current?.aliases || []), ...(patch.aliases || [])]),
        isKeyBrand: patch.isKeyBrand ?? current?.isKeyBrand ?? false,
        companies: patch.replaceCompanies
            ? [...new Set(patch.companies || [])]
            : [...new Set([...(current?.companies || []), ...(patch.companies || [])])],
        active: patch.active ?? current?.active ?? true,
        updatedAt: new Date().toISOString()
    };
    await db.collection('brands').doc(id).set(payload, { merge: true });
    const next = normalizeBrandMasterRecord(id, payload);
    const index = brandMasterCache.findIndex(item => item.id === id || normalizeBrandLookupKey(item.name) === normalizeBrandLookupKey(canonicalName));
    if (index >= 0) brandMasterCache[index] = { ...brandMasterCache[index], ...next };
    else brandMasterCache.push(next);
}

async function syncLegacyBrandSettingsToMaster() {
    if (currentUserRole !== 'admin') return;
    const names = getUnifiedBrandNames(false);
    for (const name of names) {
        const canonical = resolveBrandName(name);
        const companies = ['yushin', 'morningstar', 'MULTI-LIFE'].filter(company =>
            includesBrandCaseInsensitive(companyAgencyBrands[company] || [], canonical)
        );
        const isKeyBrand = keyStatisticBrands.some(brand => normalizeBrandLookupKey(resolveBrandName(brand)) === normalizeBrandLookupKey(canonical));
        const aliases = keyStatisticBrandAliases[canonical] || keyStatisticBrandAliases[name] || [];
        await upsertBrandMaster(canonical, { companies, isKeyBrand, aliases, replaceCompanies: true, replaceAliases: true });
    }
}


function normalizeThermoBrandList(brands) {
    return dedupeBrandsCaseInsensitive((brands || []).map(value =>
        String(value || '').trim().toLocaleLowerCase() === 'thermo' ? 'Thermo' : value
    ));
}

function includesBrandCaseInsensitive(brands, brand) {
    const key = String(brand || '').trim().toLocaleLowerCase();
    return (brands || []).some(value => String(value || '').trim().toLocaleLowerCase() === key);
}

// 價格表原始廠牌清單僅供價格資料管理使用；一般模組請改走 Brand Master 相容層。
function getAllPriceListBrandsRaw() {
    return dedupeBrandsCaseInsensitive(priceList.map(p => p.brand))
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

// 分公司代理廠牌清單裡的「其他廠牌」是特殊項目，代表這間公司是否開放「其他（自行輸入）」，不是一個真的廠牌名稱
const OTHER_BRAND_OPTION_KEY = '其他廠牌';

function isCompanyBrandAllowed(company, brand) {
    // 「維修」可由三間分公司開立；尚未建立設定時保留既有的全部廠牌行為。
    const normalizedBrand = String(brand || '').trim();
    if (normalizedBrand === '維修' || normalizedBrand === '其他' || normalizedBrand === OTHER_BRAND_OPTION_KEY || !companyAgencyBrandsConfigured) return true;

    // 「其他」的訂單會保存使用者實際輸入的廠牌名稱，因此不能只靠品牌名稱判斷。
    // 只有明確列在任一分公司代理清單中的品牌才受公司限制；
    // 未被任何分公司列為代理品牌者，一律視為「其他廠牌」，三家公司都可發單。
    const assignedToAnyCompany = ['yushin', 'morningstar', 'MULTI-LIFE']
        .some(key => includesBrandCaseInsensitive(companyAgencyBrands[key], normalizedBrand));
    if (!assignedToAnyCompany) return true;

    return includesBrandCaseInsensitive(companyAgencyBrands[company], normalizedBrand);
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
    const raw = select.value !== '其他'
        ? select.value.trim()
        : (row.querySelector('.item-brand-other')?.value || '').trim();
    return resolveBrandName(raw);
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
    const raw = select.value === '其他'
        ? (document.getElementById(otherInputId)?.value || '').trim()
        : select.value.trim();
    return resolveBrandName(raw);
}

// 新增訂單與估價單共用同一套 Product Master 貨號比對；第一次開啟也會等待價格表完成載入，不需手動重新整理。
window.onOrderItemCodeChange = async function(input) {
    const value = input.value.trim();
    if (!value) return;
    await ensurePriceListLoaded().catch(() => {});
    const match = findPriceItemByCodeValue(value);
    if (!match) {
        input.dataset.autofillStatus = 'not-found';
        setOrderCostFieldForProduct(null);
        showQuickProductButton(input, 'order');
        return;
    }

    clearQuickProductButton(input);
    input.dataset.autofillStatus = 'matched';
    input.value = match.model || value;
    window._orderModalProductId = match.productId || stableProductId(match);

    if (match.brand) {
        selectBrandInDropdown(document.getElementById('orderBrand'), resolveBrandName(match.brand));
        onOrderBrandSelectChange();
    }

    const itemNameInput = document.getElementById('orderItemName');
    if (itemNameInput) itemNameInput.value = match.nameCn || match.nameEn || '';
    const unitInput = document.getElementById('orderUnit');
    if (unitInput) unitInput.value = match.unit || '';
    const priceInput = document.getElementById('orderUnitPrice');
    if (priceInput && match.price !== undefined && match.price !== null && String(match.price).trim() !== '') {
        priceInput.value = match.price;
        calcOrderTotal();
    }

    input.dataset.productLine = match.productLine || '';
    input.dataset.productType = match.productType || '';

    await applyOrderProductCost(match);
};

let orderItemCodeTimer = null;
window.onOrderItemCodeInput = function(input) {
    clearTimeout(orderItemCodeTimer);
    orderItemCodeTimer = setTimeout(() => onOrderItemCodeChange(input), 180);
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
        populateOrderCustomerSuggestions();
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
                    <label>貨號：</label>
                    <input type="text" class="item-model" list="priceModelList" value="${itemData.model || ''}" oninput="onItemModelInput(this)" onchange="onItemModelChange(this)">
                </div>
                <div class="field-row">
                    <label>中文品名：</label>
                    <input type="text" class="item-cn" list="priceNameCnList" value="${itemData.nameCn || ''}" onchange="onItemCnChange(this)">
                </div>
                <div class="field-row">
                    <label>英文品名：</label>
                    <input type="text" class="item-en" list="priceNameEnList" value="${itemData.nameEn || ''}">
                </div>

                <div class="item-row-pair">
                    <div class="item-brand-field">
                        <label>廠牌：</label>
                        <select class="item-brand" onchange="onQuoteBrandSelectChange(this)">${quoteBrandOptions(itemData.brand)}</select>
                        <input type="text" class="item-brand-other" placeholder="請輸入廠牌" style="display:none;margin-top:4px;width:100%;box-sizing:border-box;">
                        <input type="hidden" class="item-product-line" value="${itemData.productLine || ''}">
                        <input type="hidden" class="item-product-type" value="${itemData.productType || ''}">
                        <input type="hidden" class="item-product-id" value="${itemData.productId || ''}">
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

window.onItemCnChange = async function(input) {
    await ensurePriceListLoaded().catch(() => {});
    const value = input.value.trim();
    const match = priceList.find(p => String(p.nameCn || '').trim() === value);
    if (!match) return;
    applyQuoteProductMatch(input.closest('tr'), match);
};

window.onItemModelChange = async function(input) {
    const value = input.value.trim();
    if (!value) return;

    await ensurePriceListLoaded().catch(() => {});
    const match = findPriceItemByCodeValue(value);
    if (!match) {
        input.dataset.autofillStatus = 'not-found';
        showQuickProductButton(input, 'quote');
        return;
    }

    clearQuickProductButton(input);
    input.dataset.autofillStatus = 'matched';
    applyQuoteProductMatch(input.closest('tr'), match);
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
        let match = model ? findPriceItemByCodeValue(model) : null;
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

function currentQuoteOutputValidation() {
    if (!document.getElementById('quoteNo').value.trim()) return '請先填寫估價單號。';
    if (!document.getElementById('salesName').value) return '請先從下拉選單選擇負責業務。';
    const rows = [...document.querySelectorAll('#quoteItems tr')];
    if (!rows.some(row => (row.querySelector('.item-cn')?.value || row.querySelector('.item-en')?.value || row.querySelector('.item-model')?.value).trim())) return '請至少填寫一個品項。';
    if (rows.some(row => row.querySelector('.item-brand')?.value === '其他' && !quoteRowBrandValue(row))) return '已選擇「其他」廠牌，請輸入廠牌名稱。';
    const hasUnassignedBrand = rows.some(row => {
        const brand = quoteRowBrandValue(row);
        return brand && !isCompanyBrandAllowed(currentCompany, brand) && !isCompanyOtherOptionAllowed(currentCompany);
    });
    if (hasUnassignedBrand) return '此估價單含有不屬於目前分公司代理的廠牌，請先更換廠牌或分公司。';
    const total = parseFloat((document.getElementById('grandTotal').innerText || '').replace(/,/g, '')) || 0;
    if (total <= 0) return '含稅總金額必須大於 0。';
    return '';
}

function collectCurrentQuoteRecord() {
    const salesName = document.getElementById('salesName').value;
    const selectedSales = salesList.find(s => stripPhoneSuffix(s.name) === stripPhoneSuffix(salesName));
    const record = {
        quoteNo: document.getElementById('quoteNo').value.trim(), company: currentCompany,
        clientName: document.getElementById('clientName').value, ordererName: document.getElementById('ordererName').value.trim(),
        salesName, salesCode: selectedSales?.code || salesCodeForName(salesName),
        ownerUid: selectedSales?.uid || (belongsToCurrentUser(salesName, '', selectedSales?.code || salesCodeForName(salesName)) ? currentUser?.uid || '' : ''),
        quoteDate: document.getElementById('quoteDate').value, createdAt: new Date().toISOString(),
        ...linkedDocumentFields(window._pendingForecastQuoteLink ? DOCUMENT_TYPES.FORECAST : '', window._pendingForecastQuoteLink?.forecastId || '', window._pendingForecastQuoteLink ? [documentLink(DOCUMENT_TYPES.FORECAST, window._pendingForecastQuoteLink.forecastId, 'source')] : []), validDays: document.getElementById('validDays').value,
        discountRate: document.getElementById('discountRateInput').value, grandTotal: document.getElementById('grandTotal').innerText,
        items: []
    };
    document.querySelectorAll('#quoteItems tr').forEach(row => record.items.push({
        nameEn: row.querySelector('.item-en').value, nameCn: row.querySelector('.item-cn').value,
        model: row.querySelector('.item-model').value, brand: quoteRowBrandValue(row),
        productLine: row.querySelector('.item-product-line').value, productType: row.querySelector('.item-product-type').value,
        productId: row.querySelector('.item-product-id')?.value || '', spec: row.querySelector('.item-spec').value, qty: row.querySelector('.qty').value,
        price: row.querySelector('.inc-price').value, exPrice: row.querySelector('.ex-price').value,
        subtotal: row.querySelector('.subtotal-inc').value
    }));
    return record;
}

function comparisonBaseTotal() {
    return parseFloat((document.getElementById('grandTotal')?.innerText || '').replace(/,/g, '')) || 0;
}

function roundedComparisonTotal(percent) {
    return Math.ceil((comparisonBaseTotal() * (1 + Math.max(0, parseFloat(percent) || 0) / 100)) / 1000) * 1000;
}

function setComparisonCompanyOptions(select, selected, blocked) {
    const available = COMPARISON_COMPANY_ORDER.filter(key => key !== currentCompany && (key === selected || key !== blocked));
    select.innerHTML = available.map(key => `<option value="${key}" ${key === selected ? 'selected' : ''}>${escapeHtml(comparisonCompanyData[key].label)}</option>`).join('');
    if (!available.includes(selected)) select.value = available[0] || '';
}

window.openThreeQuoteDialog = function() {
    const validationMessage = currentQuoteOutputValidation();
    if (validationMessage) { alert(validationMessage); return; }
    const available = COMPARISON_COMPANY_ORDER.filter(key => key !== currentCompany);
    document.getElementById('comparisonPercent2').value = 10;
    document.getElementById('comparisonPercent3').value = 15;
    setComparisonCompanyOptions(document.getElementById('comparisonCompany2'), available[0] || '', available[1] || '');
    setComparisonCompanyOptions(document.getElementById('comparisonCompany3'), available[1] || available[0] || '', available[0] || '');
    updateThreeQuoteDialog();
    document.getElementById('threeQuoteOverlay').classList.add('active');
};

window.closeThreeQuoteDialog = function() {
    document.getElementById('threeQuoteOverlay').classList.remove('active');
};

window.updateThreeQuoteDialog = function() {
    const select2 = document.getElementById('comparisonCompany2');
    const select3 = document.getElementById('comparisonCompany3');
    let company2 = select2.value;
    let company3 = select3.value;
    if (company2 === company3) company3 = COMPARISON_COMPANY_ORDER.find(key => key !== currentCompany && key !== company2) || '';
    setComparisonCompanyOptions(select2, company2, company3);
    company2 = select2.value;
    setComparisonCompanyOptions(select3, company3, company2);
    const percent2 = Math.max(0, parseFloat(document.getElementById('comparisonPercent2').value) || 0);
    const percent3 = Math.max(0, parseFloat(document.getElementById('comparisonPercent3').value) || 0);
    document.getElementById('threeQuoteBaseSummary').innerHTML = `第一張：<strong>${escapeHtml(comparisonCompanyData[currentCompany]?.label || '')}</strong>／折扣後含稅總額 <strong>NT$ ${comparisonBaseTotal().toLocaleString()}</strong>`;
    document.getElementById('comparisonTotal2').innerText = `NT$ ${roundedComparisonTotal(percent2).toLocaleString()}`;
    document.getElementById('comparisonTotal3').innerText = `NT$ ${roundedComparisonTotal(percent3).toLocaleString()}`;
};

function comparisonItemsForTotal(targetTotal) {
    const discountRate = Math.max(0, parseFloat(document.getElementById('discountRateInput').value) || 0);
    const items = [...document.querySelectorAll('#quoteItems tr')].map(row => {
        const qty = parseFloat(row.querySelector('.qty').value) || 0;
        const price = parseFloat(row.querySelector('.inc-price').value) || 0;
        return {
            name: row.querySelector('.item-cn').value.trim() || row.querySelector('.item-en').value.trim(),
            model: row.querySelector('.item-model').value.trim(), qty,
            weight: Math.max(0, qty * price * (1 - discountRate / 100))
        };
    }).filter(item => item.name || item.model);
    const weightTotal = items.reduce((sum, item) => sum + item.weight, 0);
    let allocated = 0;
    return items.map((item, index) => {
        const amount = index === items.length - 1 ? targetTotal - allocated : Math.round(targetTotal * (weightTotal ? item.weight / weightTotal : 1 / items.length));
        allocated += amount;
        return { ...item, amount, unitPrice: item.qty ? amount / item.qty : 0 };
    });
}

function formatComparisonMoney(value) {
    return Number(value || 0).toLocaleString('zh-TW', { maximumFractionDigits: 4 });
}

function renderComparisonQuotePage(companyKey, percent, variant) {
    const company = comparisonCompanyData[companyKey];
    const total = roundedComparisonTotal(percent);
    const items = comparisonItemsForTotal(total);
    const showLogo = company.logo && !['yihder', 'kangning'].includes(companyKey);
    const logo = showLogo ? `<img class="comparison-company-logo" src="${escapeAttr(company.logo)}" alt="${escapeAttr(company.title)} Logo">` : '';
    const stamp = company.stamp
        ? `<img src="${escapeAttr(company.stamp)}" alt="${escapeAttr(company.title)} 估價單章">`
        : `<div class="comparison-css-stamp">${escapeHtml(company.label)}估價專用章</div>`;
    const textHeader = company.logoIsHeader && variant === 'a' && showLogo ? '' : `<h1>${escapeHtml(company.title)}</h1>${company.sub ? `<h2>${escapeHtml(company.sub)}</h2>` : ''}`;
    const headerIdentity = variant === 'b'
        ? `<div class="comparison-company-identity">${logo}<div class="comparison-company-name">${textHeader}</div></div>`
        : `${logo}${textHeader}`;
    return `<section class="comparison-quote-page comparison-style-${variant}">
        <header class="comparison-quote-header"><div class="comparison-company-block">${headerIdentity}${company.addr ? `<p>${escapeHtml(company.addr)}</p>` : ''}${company.contact ? `<p>${company.contact}</p>` : ''}</div>${variant === 'a' ? '<div class="comparison-document-title">QUOTATION</div>' : ''}</header>
        <div class="comparison-quote-meta">${document.getElementById('clientName').value.trim() ? `<div><span>${variant === 'a' ? 'CUSTOMER' : '抬頭'}</span><strong>${escapeHtml(document.getElementById('clientName').value)}</strong></div>` : ''}<div><span>${variant === 'a' ? 'DATE' : '報價日期'}</span><strong>${escapeHtml(document.getElementById('quoteDate').value || '')}</strong></div></div>
        <div class="comparison-product-list">${items.map(item => `<article class="comparison-product-item">${variant === 'a' ? `<div class="comparison-product-main"><strong class="comparison-product-name">${escapeHtml(item.name || '－')}</strong><span class="comparison-product-model">MODEL：${escapeHtml(item.model || '－')}</span></div>` : `<span class="comparison-product-model">型號：${escapeHtml(item.model || '－')}</span><strong class="comparison-product-name">${escapeHtml(item.name || '－')}</strong>`}<span class="comparison-unit-price">${variant === 'a' ? 'UNIT' : '單價'} NT$ ${formatComparisonMoney(item.unitPrice)}</span><span class="comparison-product-qty">${variant === 'a' ? 'QTY' : '數量'} ${escapeHtml(String(item.qty || 0))}</span><strong class="comparison-product-subtotal">${variant === 'a' ? 'SUBTOTAL' : '小計'} NT$ ${formatComparisonMoney(item.amount)}</strong></article>`).join('')}</div>
        <div class="comparison-quote-total-row"><span>${variant === 'a' ? 'TOTAL (TAX INCLUDED)' : '含稅總金額'}</span><strong>NT$ ${total.toLocaleString()}</strong></div>
        <div class="comparison-quote-chinese-total">合計新台幣 ${numberToChineseWords(total)}元整</div>
        <div class="comparison-quote-stamp">${stamp}</div>
    </section>`;
}

function waitForQuoteImages() {
    const printableQuote = document.getElementById('printableQuote');
    const activeMainLogo = [...printableQuote.querySelectorAll('.company-logo')]
        .find(img => getComputedStyle(img).display !== 'none');
    const mainStamp = document.getElementById('companyStamp');
    const images = [
        activeMainLogo,
        mainStamp?.getAttribute('src') ? mainStamp : null,
        ...document.querySelectorAll('#comparisonQuotePrintPages img')
    ].filter(Boolean);
    return Promise.all(images.map(img => {
        img.loading = 'eager';
        if (img.complete && img.naturalWidth > 0) return Promise.resolve({ ok: true, img });
        return new Promise(resolve => {
            let timer;
            const done = ok => {
                clearTimeout(timer);
                img.onload = null;
                img.onerror = null;
                resolve({ ok, img });
            };
            img.onload = () => done(true);
            img.onerror = () => done(false);
            timer = setTimeout(() => done(img.complete && img.naturalWidth > 0), 5000);
        });
    }));
}

window.printThreeQuotes = async function() {
    const validationMessage = currentQuoteOutputValidation();
    if (validationMessage) { alert(validationMessage); return; }
    const company2 = document.getElementById('comparisonCompany2').value;
    const company3 = document.getElementById('comparisonCompany3').value;
    if (!company2 || !company3 || company2 === company3 || company2 === currentCompany || company3 === currentCompany) {
        alert('三張估價單必須選擇不同公司。'); return;
    }
    const percent2 = Math.max(0, parseFloat(document.getElementById('comparisonPercent2').value) || 0);
    const percent3 = Math.max(0, parseFloat(document.getElementById('comparisonPercent3').value) || 0);
    const quoteData = collectCurrentQuoteRecord();
    const printButton = document.getElementById('threeQuotePrintBtn');
    printButton.disabled = true;
    printButton.innerText = '準備 Logo 與印章中…';
    document.getElementById('comparisonQuotePrintPages').innerHTML = renderComparisonQuotePage(company2, percent2, 'a') + renderComparisonQuotePage(company3, percent3, 'b');
    prepareQuoteForPrint();
    const imageResults = await waitForQuoteImages();
    printButton.disabled = false;
    printButton.innerText = '列印三頁／存為 PDF';
    const failedImages = imageResults.filter(result => !result.ok);
    if (failedImages.length) {
        const labels = failedImages.map(result => result.img.alt || result.img.getAttribute('src') || '未知圖片');
        alert(`以下圖片未能載入，已暫停列印：\n${labels.join('\n')}\n\n請重新整理頁面後再試。`);
        return;
    }
    closeThreeQuoteDialog();
    document.body.classList.add('printing-three-quotes');
    const originalTitle = document.title;
    document.title = `${quoteData.quoteNo}-${quoteData.ordererName || quoteData.clientName || ''}-三家估價`;
    window._quoteOriginalTitle = originalTitle;
    requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    db.collection('quotes').doc(quoteData.quoteNo).set(quoteData).catch(err => {
        console.error('儲存第一張正式估價單失敗：', err);
        alert('提醒：三頁列印內容不受影響，但第一張正式估價單存入雲端失敗，請稍後再試。');
    });
};

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
        customerId: syncCustomerMaster(ordererName || clientName, { salesCode: selectedSales?.code || salesCodeForName(selectedSalesName) }),
        salesName: selectedSalesName,
        salesCode: selectedSales?.code || salesCodeForName(selectedSalesName),
        ownerUid: selectedSales?.uid || (belongsToCurrentUser(selectedSalesName, '', selectedSales?.code || salesCodeForName(selectedSalesName)) ? currentUser?.uid || '' : ''),
        quoteDate: document.getElementById('quoteDate').value,
        createdAt: new Date().toISOString(),
        ...linkedDocumentFields(window._pendingForecastQuoteLink ? DOCUMENT_TYPES.FORECAST : '', window._pendingForecastQuoteLink?.forecastId || '', window._pendingForecastQuoteLink ? [documentLink(DOCUMENT_TYPES.FORECAST, window._pendingForecastQuoteLink.forecastId, 'source')] : []),
        validDays: document.getElementById('validDays').value,
        discountRate: document.getElementById('discountRateInput').value,
        grandTotal: document.getElementById('grandTotal').innerText,
        status: BUSINESS_STATUS.ACTIVE,
        ...grossAmountMetadata(document.getElementById('grandTotal').innerText),
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
            productId: row.querySelector('.item-product-id')?.value || '',
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

    db.collection('quotes').doc(quoteNo).set(quoteData).then(() => {
        if (quoteData.sourceType === DOCUMENT_TYPES.FORECAST && quoteData.sourceId) {
            return db.collection('forecasts').doc(quoteData.sourceId).set({
                linkedDocuments: firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.QUOTE, quoteNo, 'created')),
                updatedAt: new Date().toISOString()
            }, { merge: true });
        }
    }).catch(err => {
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
function markQuotePrintPagination() {
    const root = document.getElementById('printableQuote');
    const table = document.getElementById('itemTable');
    const tbody = document.getElementById('quoteItems');
    if (!root || !table || !tbody) return;

    root.classList.remove('quote-multipage-print');
    tbody.querySelectorAll('tr').forEach(row => row.classList.remove('quote-print-page-break'));

    const rows = [...tbody.querySelectorAll('tr')].filter(row => {
        const text = [
            row.querySelector('.item-en')?.value,
            row.querySelector('.item-cn')?.value,
            row.querySelector('.item-model')?.value,
            row.querySelector('.item-spec')?.value
        ].join('').trim();
        return !!text;
    });
    if (!rows.length) return;

    // A4 可列印高度約 277mm。以目前 190mm 固定寬度先量實際 DOM 高度，
    // 首頁需扣除公司抬頭與客戶資料；最後一頁需額外保留有效期限、印章與總計。
    const pxPerMm = 96 / 25.4;
    const printableHeight = 277 * pxPerMm;
    const headerHeight = (root.querySelector('.header-container')?.getBoundingClientRect().height || 0)
        + (root.querySelector('.meta-section')?.getBoundingClientRect().height || 0)
        + (table.querySelector('thead')?.getBoundingClientRect().height || 0);
    const footerHeight = (root.querySelector('.footer-note')?.getBoundingClientRect().height || 0)
        + (root.querySelector('.bottom-layout')?.getBoundingClientRect().height || 0)
        + 14 * pxPerMm;
    const repeatedHeaderHeight = table.querySelector('thead')?.getBoundingClientRect().height || 0;
    const firstCapacity = Math.max(120, printableHeight - headerHeight - 8 * pxPerMm);
    const nextCapacity = Math.max(120, printableHeight - repeatedHeaderHeight - 8 * pxPerMm);

    let pageUsed = 0;
    let capacity = firstCapacity;
    const rowHeights = rows.map(row => Math.ceil(row.getBoundingClientRect().height || row.scrollHeight || 0));

    rows.forEach((row, index) => {
        const rowHeight = Math.max(rowHeights[index], 18);
        const remainingRowsHeight = rowHeights.slice(index).reduce((sum, h) => sum + Math.max(h, 18), 0);
        const reserveFooterNow = remainingRowsHeight + footerHeight <= capacity - pageUsed;
        const required = rowHeight + (reserveFooterNow ? footerHeight : 0);
        if (pageUsed > 0 && pageUsed + required > capacity) {
            row.classList.add('quote-print-page-break');
            pageUsed = 0;
            capacity = nextCapacity;
        }
        pageUsed += rowHeight;
    });

    // 若最後一頁的品項加上總計／印章仍放不下，把最後一個完整品項移到下一頁；
    // 不拆列，也避免總計被擠出頁面。
    if (pageUsed + footerHeight > capacity && rows.length > 1) {
        rows[rows.length - 1].classList.add('quote-print-page-break');
    }
    root.classList.toggle('quote-multipage-print', rows.some(row => row.classList.contains('quote-print-page-break')));
}

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

    // 只在列印時隱藏沒有內容的品項資訊，編輯畫面仍保留所有輸入欄位。
    root.querySelectorAll('#quoteItems tr').forEach(row => {
        const toggleEmpty = (element, value) => element?.classList.toggle('print-empty-field', !String(value || '').trim());
        toggleEmpty(row.querySelector('.item-en')?.closest('.field-row'), row.querySelector('.item-en')?.value);
        toggleEmpty(row.querySelector('.item-cn')?.closest('.field-row'), row.querySelector('.item-cn')?.value);
        toggleEmpty(row.querySelector('.item-model')?.closest('.item-row-pair > div'), row.querySelector('.item-model')?.value);
        toggleEmpty(row.querySelector('.item-brand-field'), quoteRowBrandValue(row));
        toggleEmpty(row.querySelector('.item-spec')?.closest('.field-row'), row.querySelector('.item-spec')?.value);
    });

    markQuotePrintPagination();

    const clientRow = document.getElementById('clientName')?.closest('.meta-row');
    clientRow?.classList.toggle('print-empty-field', !document.getElementById('clientName').value.trim());

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
        salesSelect.closest('.meta-row-three > div')?.classList.toggle('print-empty-field', !salesSelect.value.trim());
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

window.copyQuoteAsNew = async function(quoteNo) {
    if (!canEditPage('quote.create')) {
        alert('您目前沒有建立估價單的權限。');
        return;
    }
    let source = myQuotesCache.find(quote => quote.quoteNo === quoteNo)
        || allQuotesCache.find(quote => quote.quoteNo === quoteNo);
    try {
        if (!source) {
            const snapshot = await db.collection('quotes').doc(quoteNo).get();
            if (!snapshot.exists) throw new Error('找不到這張估價單。');
            source = { id: snapshot.id, ...snapshot.data() };
        }
        if (!canViewAllData('quotes') && !belongsToCurrentUser(source.salesName, source.ownerUid)) {
            throw new Error('您只能複製自己的估價單。');
        }
        await ensureSalesListLoaded();
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create', document.getElementById('qsub-create'));
        applyCompanyTheme(source.company || 'yushin');
        document.getElementById('clientName').value = source.clientName || '';
        document.getElementById('ordererName').value = source.ordererName || '';
        document.getElementById('discountRateInput').value = source.discountRate || 0;
        document.getElementById('validDays').value = source.validDays || 90;
        initDate();

        const salesSelect = document.getElementById('salesName');
        const availableSales = [...salesSelect.options].map(option => option.value);
        if (currentUserName && availableSales.includes(currentUserName)) salesSelect.value = currentUserName;
        else if (availableSales.includes(source.salesName || '')) salesSelect.value = source.salesName;
        else salesSelect.value = '';
        updateSalesPhoneDisplay();

        const itemsBody = document.getElementById('quoteItems');
        itemsBody.innerHTML = '';
        if (Array.isArray(source.items) && source.items.length) source.items.forEach(item => addQuoteRow(item));
        else addQuoteRow();
        calculateTotals();
        await generateQuoteNo();
        saveQuoteDraft();
    } catch (err) {
        alert('無法複製估價單：' + err.message);
    }
};

/* ---------- 我的估價單（只列出目前登入者自己名下的估價單） ---------- */
let myQuotesCache = [];
let myQuotesPaginationState = null;
let myQuotesPageLoading = false;
let myQuotesReloadRequested = false;

window.switchQuoteView = function(view, el, options = {}) {
    const pageKey = view === 'create' ? 'quote.create' : 'quote.my';
    const previousView = document.getElementById('myQuotesPanel')?.style.display === 'block' ? 'my' : 'create';
    if (!options.skipHistory && previousView !== view) pushAppNavigationState({ tabId: 'quote-system', quoteView: view });
    if (!canAccessPage(pageKey)) { alert('您沒有權限查看這個分頁。'); return; }
    document.querySelectorAll('#quote-system > .sub-nav .sub-tab').forEach(t => t.classList.remove('active'));
    const targetEl = el || document.getElementById(view === 'create' ? 'qsub-create' : 'qsub-my');
    if (targetEl) targetEl.classList.add('active');

    document.getElementById('quoteCreatePanel').style.display = view === 'create' ? 'block' : 'none';
    document.getElementById('myQuotesPanel').style.display = view === 'my' ? 'block' : 'none';

    if (view === 'my' && !options.skipReload && myQuotesCache.length === 0) {
        loadMyQuotesFromCloud();
    }
    updateReadonlyNotice();
};

function createMyQuotesPaginationState() {
    const sources = [];
    if (canViewAllData('quotes')) {
        // 全公司估價單直接由 Firestore 依日期分頁，不能先按公司／單號分組後才在前端重排。
        sources.push({ cursor: null, query: () => db.collection('quotes').orderBy('quoteDate', 'desc') });
    } else {
        if (currentUserCode) sources.push({ cursor: null, query: () => db.collection('quotes').where('salesCode', '==', currentUserCode).orderBy('quoteDate', 'desc') });
        if (currentUser?.uid) sources.push({ cursor: null, query: () => db.collection('quotes').where('ownerUid', '==', currentUser.uid).orderBy('quoteDate', 'desc') });
        if (currentUserName) sources.push({ cursor: null, query: () => db.collection('quotes').where('salesName', '>=', currentUserName).where('salesName', '<=', currentUserName + '\uf8ff').orderBy('quoteDate', 'desc') });
    }
    return { sources, sourceIndex: 0 };
}

function updateMyQuotesLoadMoreButton() {
    const button = document.getElementById('myQuotesLoadMoreBtn');
    if (!button) return;
    const hasMore = !!myQuotesPaginationState && myQuotesPaginationState.sourceIndex < myQuotesPaginationState.sources.length;
    button.style.display = hasMore ? '' : 'none';
    button.disabled = myQuotesPageLoading;
    button.innerText = myQuotesPageLoading ? '載入中…' : '載入更多（每次 50 筆）';
}

async function loadMyQuotesPage(reset) {
    const hint = document.getElementById('myQuotesEmptyHint');
    if (myQuotesPageLoading) {
        if (reset) myQuotesReloadRequested = true;
        return;
    }
    if (getDataScope('quotes') === 'none') {
        myQuotesCache = [];
        myQuotesPaginationState = null;
        document.getElementById('myQuotesBody').innerHTML = '';
        hint.style.display = 'block';
        hint.innerText = '管理員尚未設定此身份的估價單資料查看範圍。';
        updateMyQuotesLoadMoreButton();
        return;
    }
    if (reset || !myQuotesPaginationState) {
        myQuotesPaginationState = createMyQuotesPaginationState();
        myQuotesCache = [];
    }
    myQuotesPageLoading = true;
    const requestedRole = currentUserRole;
    updateMyQuotesLoadMoreButton();
    const records = new Map(myQuotesCache.map(quote => [quote.id, quote]));
    let remainingReads = DEFAULT_LIST_LIMIT;
    try {
        while (remainingReads > 0 && myQuotesPaginationState.sourceIndex < myQuotesPaginationState.sources.length) {
            const source = myQuotesPaginationState.sources[myQuotesPaginationState.sourceIndex];
            const requested = remainingReads;
            let query = source.query().limit(requested);
            if (source.cursor) query = query.startAfter(source.cursor);
            const snapshot = await query.get();
            if (requestedRole !== currentUserRole) {
                myQuotesReloadRequested = true;
                return;
            }
            if (!snapshot.empty) {
                source.cursor = snapshot.docs[snapshot.docs.length - 1];
                snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));
                myQuotesCache = [...records.values()];
            }
            remainingReads -= snapshot.size;
            if (snapshot.size < requested) myQuotesPaginationState.sourceIndex++;
        }
        myQuotesCache.sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'quoteDate', 'quoteNo'));
        renderMyQuotesList();
        if (!currentUserName && myQuotesCache.length === 0) {
            hint.style.display = 'block';
            hint.innerText = '目前找不到以此帳號建立的新式紀錄。若要顯示舊估價單，請管理員在 users 帳號資料補上姓名，以便比對舊資料的負責業務。';
        }
    } catch (err) {
        console.error(err);
        myQuotesCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'quoteDate', 'quoteNo'));
        renderMyQuotesList();
        alert('讀取我的估價單失敗，請確認 Firestore 權限設定。');
    } finally {
        myQuotesPageLoading = false;
        updateMyQuotesLoadMoreButton();
        if (myQuotesReloadRequested) {
            myQuotesReloadRequested = false;
            loadMyQuotesPage(true);
        }
    }
}

window.loadMyQuotesFromCloud = function() {
    return loadMyQuotesPage(true);
};

window.loadMoreMyQuotes = function() {
    return loadMyQuotesPage(false);
};

window.renderMyQuotesList = function() {
    const tbody = document.getElementById('myQuotesBody');
    const searchInput = document.getElementById('myQuoteSearch');
    const keyword = (searchInput.value || '').toLowerCase();
    const periodFilter = document.getElementById('myQuotePeriodFilter')?.value || 'this-year';
    tbody.innerHTML = '';
    let shown = 0;

    const isAdminViewingAll = canViewAllData('quotes');
    const salesHeader = document.getElementById('myQuotesSalesHeader');
    if (salesHeader) salesHeader.style.display = isAdminViewingAll ? '' : 'none';

    myQuotesCache.forEach(q => {
        const itemSearchText = (q.items || []).map(item => `${item.brand || ''} ${item.model || ''} ${item.nameCn || ''} ${item.nameEn || ''} ${item.spec || ''}`).join(' ');
        const searchable = `${q.quoteNo || ''} ${q.clientName || ''} ${q.ordererName || ''} ${q.salesName || ''} ${itemSearchText}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;
        if (q.dealClosed && !dateInUnifiedPeriod(q.quoteDate || q.createdAt, periodFilter)) return;
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
                <button type="button" class="btn-small btn-secondary" onclick="copyQuoteAsNew('${escapeAttr(q.quoteNo)}')">複製</button>
                ${canEditPage('forecast') ? `<button type="button" class="btn-small btn-secondary" onclick="createForecastFromQuote('${escapeAttr(q.quoteNo)}')">Forecast</button>` : ''}
                ${actionBtn}
            </td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('myQuotesEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

// 成交：標記估價單為已成交，並把裡面每一個品項匯入訂單管理系統（一次性動作，避免重複匯入）
window.createForecastFromQuote = async function(quoteNo) {
    if (!canEditPage('forecast')) {
        alert('您沒有 Forecast 編輯權限。');
        return;
    }

    try {
        const cached = myQuotesCache.find(q => q.quoteNo === quoteNo) || allQuotesCache.find(q => q.quoteNo === quoteNo);
        const q = cached || (await db.collection('quotes').doc(quoteNo).get()).data();

        if (!q) {
            throw new Error('找不到估價單');
        }

        const existing = await db.collection('forecasts')
            .where('sourceType', '==', DOCUMENT_TYPES.QUOTE)
            .where('sourceId', '==', quoteNo)
            .limit(1)
            .get();

        if (!existing.empty) {
            alert('這張估價單已建立 Forecast。');
            return;
        }

        const now = forecastNowIso();
        const items = q.items || [];

        const productName = items
            .map(item => item.nameCn || item.nameEn || item.model)
            .filter(Boolean)
            .join('、');

        const brands = dedupeBrandsCaseInsensitive(
            items.map(item => resolveBrandName(item.brand)).filter(Boolean)
        );

        const brand = brands.length === 1 ? brands[0] : brands.join(' / ');
        const status = q.dealClosed ? 'won' : 'active';
        const stage = q.dealClosed ? 'stage5' : 'stage2';
        const displayProgress = `${forecastTodayLabel()} 由估價單建立`;

        const ref = db.collection('forecasts').doc();

        const forecastCustomerName = q.ordererName || q.clientName || '';
        const record = {
            customerName: forecastCustomerName,
            customerId: q.customerId || syncCustomerMaster(forecastCustomerName, { salesCode: q.salesCode || salesCodeForName(q.salesName) }),
            brand,
            productName,
            // Forecast 主列表維持一筆，但保留估價單每個品項的 snapshot，轉訂單時才能拆回多筆。
            items: items.map(item => ({
                nameCn: item.nameCn || '',
                nameEn: item.nameEn || '',
                model: item.model || '',
                brand: resolveBrandName(item.brand || ''),
                productId: item.productId || '',
                productLine: item.productLine || '',
                productType: item.productType || '',
                spec: item.spec || '',
                qty: Number(item.qty || 1),
                unit: item.unit || '',
                price: parseMoney(item.price),
                subtotal: parseMoney(item.subtotal)
            })),
            estimatedAmount: Number(String(q.grandTotal || '').replace(/,/g, '')) || 0,
            stage,
            status,
            closedAt: status === 'active' ? null : now,
            latestProgress: displayProgress,
            latestProgressAt: now,
            salesName: q.salesName || currentUserName || '',
            salesCode: q.salesCode || salesCodeForName(q.salesName) || currentUserCode || '',
            ownerUid: q.ownerUid || currentUser?.uid || '',
            createdAt: now,
            updatedAt: now,
            ...linkedDocumentFields(
                DOCUMENT_TYPES.QUOTE,
                quoteNo,
                [documentLink(DOCUMENT_TYPES.QUOTE, quoteNo, 'source')]
            )
        };

        const batch = db.batch();

        batch.set(ref, record);

        batch.set(ref.collection('progress').doc(), {
            text: '由估價單建立',
            displayText: displayProgress,
            stage,
            status,
            createdAt: now,
            createdByUid: currentUser?.uid || '',
            createdByName: currentUserName || ''
        });

        batch.update(db.collection('quotes').doc(quoteNo), {
            linkedDocuments: normalizeDocumentLinks([
                ...(q.linkedDocuments || []),
                documentLink(DOCUMENT_TYPES.FORECAST, ref.id, 'created')
            ])
        });

        await batch.commit();

        alert('已從估價單建立 Forecast。');
    } catch (err) {
        console.error('建立 Forecast 失敗', err);
        alert('建立 Forecast 失敗：' + err.message);
    }
};

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
        const createdOrderLinks = [];
        const createdOrders = [];
        (q.items || []).forEach(item => {
            if (!item.nameCn && !item.nameEn && !item.model) return;
            const orderRef = db.collection('orders').doc();
            createdOrderLinks.push(documentLink(DOCUMENT_TYPES.ORDER, orderRef.id, 'created'));
            const orderData = {
                orderDate: todayStr,
                createdAt: new Date().toISOString(),
                company: q.company || '',
                customerName: q.ordererName || q.clientName || '',
                customerId: q.customerId || customerIdForName(q.ordererName || q.clientName || ''),
                brand: resolveBrandName(item.brand || ''),
                productLine: item.productLine || '',
                productType: item.productType || '',
                productId: item.productId || '',
                itemCode: item.model || '',
                itemCodeKey: normalizeHistoryItemCode(item.model || ''),
                itemName: item.nameCn || item.nameEn || '',
                qty: item.qty || '',
                unitPrice: item.price || '',
                totalPrice: item.subtotal || '',
                status: BUSINESS_STATUS.ACTIVE,
                ...grossAmountMetadata(item.subtotal || 0),
                transactionType: '',
                invoiceTitle: q.clientName || '',
                quoteNo: quoteNo,
                ...linkedDocumentFields(DOCUMENT_TYPES.QUOTE, quoteNo, [
                    documentLink(DOCUMENT_TYPES.QUOTE, quoteNo, 'source')
                ]),
                salesName: stripPhoneSuffix(q.salesName),
                salesCode: q.salesCode || salesCodeForName(q.salesName),
                ownerUid: q.ownerUid || salesList.find(s => stripPhoneSuffix(s.name) === stripPhoneSuffix(q.salesName))?.uid || '',
                isOrdered: false,
                isArrived: false,
                isDelivered: false,
                isBilled: false,
                invoiceDate: ''
            };
            // Product Master 關聯保留；成本依代理/非代理與角色處理，避免代理產品成本寫入業務可讀的訂單文件。
            const priceMatch = item.model ? findPriceItemForOrder({ itemCode: item.model, brand: resolveBrandName(item.brand || '') }) : null;
            if (priceMatch) {
                orderData.productId = orderData.productId || priceMatch.productId || stableProductId(priceMatch);
                orderData.unit = priceMatch.unit || '';
                orderData.supplier = priceMatch.supplier || '';
                orderData.spec = item.spec || priceMatch.spec || '';
                orderData.authorizationType = authorizationTypeForProduct(priceMatch);
                const canCarryCost = currentUserRole === 'admin' || currentUserRole === 'purchaser'
                    || authorizationTypeForProduct(priceMatch) === 'NON_AUTHORIZED';
                if (canCarryCost && priceMatch.cost !== undefined && priceMatch.cost !== null && String(priceMatch.cost).trim() !== '') {
                    orderData.costPrice = priceMatch.cost;
                }
            }
            batch.set(orderRef, orderData);
            createdOrders.push({ id: orderRef.id, data: orderData });
        });

        batch.update(db.collection('quotes').doc(quoteNo), {
            dealClosed: true,
            dealClosedAt: todayStr,
            status: BUSINESS_STATUS.COMPLETED,
            linkedDocuments: normalizeDocumentLinks([...(q.linkedDocuments || []), ...createdOrderLinks])
        });

        batch.commit().then(async () => {
            await Promise.all(createdOrders.map(entry => reserveInventoryForNewOrder(entry.id, entry.data)));
            alert('已標記成交，品項已匯入訂單管理系統並完成可用庫存保留。');
            loadMyQuotesFromCloud();
        }).catch(err => {
            alert('匯入失敗：' + err.message);
        });
    }).catch(err => {
        alert('讀取估價單失敗：' + err.message);
    });
};

window.unmarkQuoteAsDeal = async function(quoteNo) {
    if (!confirm(
        `確定要取消估價單 ${quoteNo} 的成交狀態嗎？相關訂單將標記為取消並釋放已預留庫存，不會永久刪除。`
    )) return;

    try {
        const snapshot = await db.collection('orders')
            .where('quoteNo', '==', quoteNo)
            .get();

        const actor = deliveryActor();
        const cancelledAt = new Date().toISOString();
        const cancelledDate = localDateString();

        // 每筆來源訂單沿用正式的訂單生命週期與庫存釋放邏輯
        for (const doc of snapshot.docs) {
            await db.runTransaction(async transaction => {
                const orderRef = db.collection('orders').doc(doc.id);
                const orderSnap = await transaction.get(orderRef);

                if (!orderSnap.exists) return;

                const order = orderSnap.data();

                // 已取消的訂單不重複釋放庫存
                if (normalizedOrderStatus(order) === 'cancelled') return;

                await adjustInventoryReservationForLifecycle(
                    transaction,
                    doc.id,
                    order,
                    'cancelled',
                    actor
                );

                const history = {
                    action: 'status_change',
                    before: {
                        status: normalizedOrderStatus(order),
                        date: order.orderStatusDate || '',
                        reason: order.orderStatusReason || ''
                    },
                    after: {
                        status: 'cancelled',
                        date: cancelledDate,
                        reason: '來源估價單取消成交'
                    },
                    by: actor,
                    at: cancelledAt
                };

                transaction.update(orderRef, {
                    status: 'cancelled',
                    orderStatus: 'cancelled',
                    orderStatusDate: cancelledDate,
                    orderStatusReason: '來源估價單取消成交',
                    cancelledAt,
                    cancelledBy: actor,
                    cancelReason: '來源估價單取消成交',
                    orderLifecycleHistory:
                        firebase.firestore.FieldValue.arrayUnion(history),
                    linkedDocuments:
                        normalizeDocumentLinks(order.linkedDocuments || [])
                });
            });
        }

        // 所有來源訂單處理完成後，才解除估價單成交狀態
        await db.collection('quotes').doc(quoteNo).update({
            dealClosed: false,
            dealClosedAt: null,
            status: BUSINESS_STATUS.ACTIVE
        });

        alert('成交狀態已取消；相關訂單已保留並標記為取消，預留庫存已同步釋放。');
        loadMyQuotesFromCloud();

    } catch (err) {
        alert('取消失敗：' + err.message);
    }
};
/* =========================================================
   訂單管理系統
   ========================================================= */
let ordersCache = [];
let currentDeliveryOrderId = null;
let currentLifecycleOrderId = null;
let deliveryPartialFormOpen = false;
const pendingDeliveryOrderIds = new Set();
const pendingLifecycleOrderIds = new Set();
const pendingReturnOrderIds = new Set();
// 同一個狀態欄位寫入期間不接受第二次操作，避免手機連點造成兩個 Firestore
// transaction 交錯，最後畫面被較慢回來的舊結果覆蓋。
const pendingOrderStatusKeys = new Set();
let activeOrderWorkFilter = 'all';
let activeOrderPeriod = 'this-year';
let orderPaginationState = null;
let orderPageLoading = false;
let orderReloadRequested = false;

function dateOnlyFromTimestamp(value) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// 所有公司共用同一套時間排序：先依業務日期，再依建立時間。
// company 不參與排序，避免又鑫／辰星／鼎新的紀錄被分組後破壞真正的時間順序。
// 舊資料若沒有 createdAt，最後才以單號／文件 id 做穩定排序。
const DOCUMENT_TYPES = Object.freeze({ FORECAST: 'forecast', QUOTE: 'quote', ORDER: 'order', PURCHASE_ORDER: 'purchaseOrder', RECEIPT: 'receipt', INVENTORY_MOVEMENT: 'inventoryMovement' });

function documentLink(type, id, relation = 'related') {
    return { type, id: String(id || ''), relation };
}

function normalizeDocumentLinks(links) {
    const unique = new Map();
    (Array.isArray(links) ? links : []).forEach(link => {
        if (!link?.type || !link?.id) return;
        const normalized = documentLink(link.type, link.id, link.relation || 'related');
        unique.set(`${normalized.type}:${normalized.id}:${normalized.relation}`, normalized);
    });
    return [...unique.values()];
}

function linkedDocumentFields(sourceType = '', sourceId = '', links = []) {
    return {
        sourceType: sourceType || '',
        sourceId: String(sourceId || ''),
        linkedDocuments: normalizeDocumentLinks(links)
    };
}


function legacyDocumentLinks(record, type) {
    const links = [...(record?.linkedDocuments || [])];
    if (type === DOCUMENT_TYPES.ORDER) {
        if (record?.quoteNo) links.push(documentLink(DOCUMENT_TYPES.QUOTE, record.quoteNo, 'source'));
        if (record?.purchaseOrderNo) links.push(documentLink(DOCUMENT_TYPES.PURCHASE_ORDER, record.purchaseOrderNo, 'created'));
    }
    if (type === DOCUMENT_TYPES.PURCHASE_ORDER) {
        purchaseItemsFromSavedPo(record).forEach(item => {
            if (item.orderId) links.push(documentLink(DOCUMENT_TYPES.ORDER, item.orderId, 'source'));
        });
    }
    return normalizeDocumentLinks(links);
}

function documentLinksFor(record, type) {
    return legacyDocumentLinks(record || {}, type);
}

function compareBusinessRecordsNewestFirst(a, b, dateField, numberField) {
    const dateCompare = String(b?.[dateField] || '').localeCompare(String(a?.[dateField] || ''));
    if (dateCompare) return dateCompare;
    const createdCompare = String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
    if (createdCompare) return createdCompare;
    return String(b?.[numberField] || b?.id || '').localeCompare(String(a?.[numberField] || a?.id || ''));
}

// 開發票日期同時視為收款與完成日期。舊資料優先由「已報帳」操作紀錄推回日期；
// 若舊資料完全沒有操作紀錄，才暫以訂單日期顯示，避免既有完成訂單從統計消失。
function orderInvoiceDate(order) {
    if (order?.invoiceDate) return order.invoiceDate;
    const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
    const billedEntry = [...history].reverse().find(entry => entry.field === 'isBilled' && entry.value);
    return dateOnlyFromTimestamp(billedEntry?.at) || (order?.isBilled ? order.orderDate || '' : '');
}

function orderPeriodRange() {
    if (activeOrderPeriod === 'custom') {
        return {
            start: document.getElementById('orderPeriodStart')?.value || '',
            end: document.getElementById('orderPeriodEnd')?.value || ''
        };
    }
    return unifiedPeriodRange(activeOrderPeriod);
}

function dateInOrderPeriod(date) {
    const { start, end } = orderPeriodRange();
    if (!start && !end) return true;
    return !!date && (!start || date >= start) && (!end || date <= end);
}

function orderMatchesWorkPeriod(order, category = orderWorkCategory(order)) {
    if (category === 'billing') return true;
    if (category === 'complete') return dateInOrderPeriod(orderInvoiceDate(order));
    return dateInOrderPeriod(order.orderDate || '');
}

window.changeOrderPeriod = function(value) {
    activeOrderPeriod = ['this-month', 'last-month', 'this-quarter', 'this-year', 'last-year', 'custom', 'all'].includes(value) ? value : 'this-year';
    const custom = document.getElementById('orderCustomPeriod');
    if (custom) custom.style.display = activeOrderPeriod === 'custom' ? 'flex' : 'none';
    if (activeOrderPeriod === 'custom') {
        const start = document.getElementById('orderPeriodStart');
        const end = document.getElementById('orderPeriodEnd');
        const year = new Date().getFullYear();
        if (start && !start.value) start.value = `${year}-01-01`;
        if (end && !end.value) end.value = dateOnlyFromTimestamp(new Date().toISOString());
    }
    renderOrdersList();
};

let inventoryCache=[], inventoryCursor=null, inventoryHasMore=true, inventoryLoading=false, inventoryLedgerCache=[], pendingInventoryCache=[];
function expiryDays(date){if(!date)return null;return Math.ceil((new Date(date+'T23:59:59')-new Date())/86400000);}
function lotStatus(lot){const d=expiryDays(lot.expiryDate);if(d===null)return '';if(d<0)return '已過期';if(d<=30)return '30天內';if(d<=60)return '60天內';if(d<=90)return '90天內';return '';}
function fefoLots(stock){return [...(stock.lots||[])].filter(l=>Number(l.qty||0)>0).sort((a,b)=>String(a.expiryDate||'9999-12-31').localeCompare(String(b.expiryDate||'9999-12-31')));}
window.loadInventory=async function(reset=true){
 if(inventoryLoading||!canAccessPage('inventory'))return;if(reset){inventoryCache=[];inventoryCursor=null;inventoryHasMore=true;} inventoryLoading=true;
 try{let q=db.collection('inventory').orderBy('updatedAt','desc').limit(DEFAULT_LIST_LIMIT);if(inventoryCursor)q=q.startAfter(inventoryCursor);const s=await q.get();if(!s.empty)inventoryCursor=s.docs[s.docs.length-1];s.forEach(d=>{const x={id:d.id,...d.data()};const i=inventoryCache.findIndex(v=>v.id===d.id);if(i>=0)inventoryCache[i]=x;else inventoryCache.push(x);});inventoryHasMore=s.size===DEFAULT_LIST_LIMIT;
 const [m,pending]=await Promise.all([
 db.collection('inventoryMovements').orderBy('createdAt','desc').limit(DEFAULT_LIST_LIMIT).get(),
 db.collection('pendingInventoryItems').where('status','==','pending-arrival').limit(100).get()
 ]);inventoryLedgerCache=m.docs.map(d=>({id:d.id,...d.data()}));pendingInventoryCache=pending.docs.map(d=>({id:d.id,...d.data()}));renderInventoryList();renderInventoryLedger();renderPendingInventoryItems();
 }catch(e){alert('讀取庫存失敗：'+e.message);}finally{inventoryLoading=false;const b=document.getElementById('inventoryLoadMoreBtn');if(b)b.style.display=inventoryHasMore?'':'none';}
};
window.renderInventoryList=function(){const body=document.getElementById('inventoryListBody');if(!body)return;const k=(document.getElementById('inventorySearch')?.value||'').toLowerCase();body.innerHTML='';inventoryCache.forEach(x=>{const lots=fefoLots(x);const text=`${x.itemCode||''} ${x.itemName||''} ${x.brand||''} ${lots.map(l=>l.lotNo).join(' ')}`.toLowerCase();if(k&&!text.includes(k))return;const n=inventoryNumbers(x);const lotHtml=lots.slice(0,3).map(l=>`${escapeHtml(l.lotNo||'無批號')} ${escapeHtml(l.expiryDate||'')} ${lotStatus(l)?'['+lotStatus(l)+']':''}`).join('<br>');const reserved=n.reserved>0?`<button type="button" class="link-button inventory-reserved-link" onclick="openInventoryReservationDetails('${escapeAttr(x.productKey||x.id||'')}')">${n.reserved}</button>`:'0';body.insertAdjacentHTML('beforeend',`<tr><td data-th="貨號">${escapeHtml(x.itemCode||'')}</td><td data-th="品名">${escapeHtml(x.itemName||'')}</td><td data-th="廠牌">${escapeHtml(x.brand||'')}</td><td data-th="現有庫存">${n.onHand}</td><td data-th="已占用">${reserved}</td><td data-th="可用庫存">${n.available}</td><td data-th="在途">${n.incoming}</td><td data-th="批號／效期">${lotHtml}</td></tr>`);});};

window.renderPendingInventoryItems=function(){const body=document.getElementById('pendingInventoryBody');const hint=document.getElementById('pendingInventoryEmptyHint');if(!body)return;body.innerHTML=pendingInventoryCache.map(x=>`<tr><td data-th="貨號">${escapeHtml(x.itemCode||'')}</td><td data-th="品名">${escapeHtml(x.itemName||'')}</td><td data-th="廠牌">${escapeHtml(x.brand||'')}</td><td data-th="在途數量">${Number(x.incomingQty||0)}</td><td data-th="供應商">${escapeHtml(x.supplier||'')}</td><td data-th="狀態">待到貨／待建檔</td></tr>`).join('');if(hint)hint.style.display=pendingInventoryCache.length?'none':'block';};
window.renderInventoryLedger=function(){const b=document.getElementById('inventoryLedgerBody');if(!b)return;b.innerHTML=inventoryLedgerCache.map(x=>`<tr><td>${escapeHtml(x.createdAt||'')}</td><td>${escapeHtml(x.productKey||'')}</td><td>${escapeHtml(x.type||'')}</td><td>${Number(x.qty||0)}</td><td>${escapeHtml((x.sourceType||'')+' '+(x.sourceId||''))}</td><td>${escapeHtml(x.createdBy||'')}</td></tr>`).join('');};
let inventoryAdjustmentRows = [];

window.openInventoryAdjustment = async function() {
    if (!canEditPage('inventory')) return;
    await ensurePriceListLoaded().catch(() => {});
    inventoryAdjustmentRows = [{ itemCode:'', itemName:'', brand:'', qty:0, lotNo:'', expiryDate:'' }];
    document.getElementById('inventoryAdjustmentType').value = 'initial';
    renderInventoryAdjustmentRows();
    document.getElementById('inventoryAdjustmentOverlay')?.classList.add('active');
};

window.closeInventoryAdjustment = function() {
    document.getElementById('inventoryAdjustmentOverlay')?.classList.remove('active');
};

window.addInventoryAdjustmentRow = function() {
    inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', qty:0, lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.removeInventoryAdjustmentRow = function(idx) {
    inventoryAdjustmentRows.splice(idx,1);
    if (!inventoryAdjustmentRows.length) inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', qty:0, lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.onInventoryAdjustmentCode = async function(idx, value) {
    await ensurePriceListLoaded().catch(() => {});
    const match = findPriceItemByCodeValue(value);
    inventoryAdjustmentRows[idx].itemCode = String(value||'').trim();
    if (match) {
        inventoryAdjustmentRows[idx].itemCode = match.model || value;
        inventoryAdjustmentRows[idx].itemName = match.nameCn || match.nameEn || '';
        inventoryAdjustmentRows[idx].brand = resolveBrandName(match.brand || '');
        inventoryAdjustmentRows[idx].productId = match.productId || stableProductId(match);
    }
    renderInventoryAdjustmentRows();
};

window.updateInventoryAdjustmentRow = function(idx, field, value) {
    if (!inventoryAdjustmentRows[idx]) return;
    inventoryAdjustmentRows[idx][field] = field === 'qty' ? Number(value||0) : String(value||'').trim();
};

function renderInventoryAdjustmentRows() {
    const body=document.getElementById('inventoryAdjustmentRows');
    if(!body)return;
    body.innerHTML=inventoryAdjustmentRows.map((row,idx)=>`
      <tr>
        <td><input type="text" list="priceModelList" value="${escapeAttr(row.itemCode||'')}" onchange="onInventoryAdjustmentCode(${idx},this.value)"></td>
        <td><input type="text" value="${escapeAttr(row.itemName||'')}" onchange="updateInventoryAdjustmentRow(${idx},'itemName',this.value)"></td>
        <td><input type="text" list="poBrandList" value="${escapeAttr(row.brand||'')}" onchange="updateInventoryAdjustmentRow(${idx},'brand',this.value)"></td>
        <td><input type="number" step="any" value="${row.qty||''}" onchange="updateInventoryAdjustmentRow(${idx},'qty',this.value)"></td>
        <td><input type="text" value="${escapeAttr(row.lotNo||'')}" onchange="updateInventoryAdjustmentRow(${idx},'lotNo',this.value)" placeholder="批號"></td>
        <td><input type="date" value="${escapeAttr(row.expiryDate||'')}" onchange="updateInventoryAdjustmentRow(${idx},'expiryDate',this.value)"></td>
        <td><button type="button" class="btn-small btn-danger" onclick="removeInventoryAdjustmentRow(${idx})">刪除</button></td>
      </tr>`).join('');
}

window.saveInventoryAdjustmentBatch = async function() {
    const type=document.getElementById('inventoryAdjustmentType').value;
    const rows=inventoryAdjustmentRows.filter(row=>row.itemCode&&Number(row.qty));
    if(!rows.length){alert('請至少輸入一筆貨號與數量。');return;}
    const actor=currentUserName||currentUser?.email||'';
    const button=document.getElementById('saveInventoryAdjustmentBatchBtn');
    if(button){button.disabled=true;button.textContent='儲存中…';}
    try{
      for(const row of rows){
        const match=findPriceItemByCodeValue(row.itemCode);
        if(!match) throw new Error(`Product Master 找不到貨號 ${row.itemCode}`);
        let delta=Number(row.qty||0);
        if(type==='scrap') delta=-Math.abs(delta);
        const key=match.productId||stableProductId(match);
        const ref=db.collection('inventory').doc(encodeURIComponent(key));
        await db.runTransaction(async tx=>{
          const s=await tx.get(ref), old=s.exists?s.data():{}, n=inventoryNumbers(old);
          if(n.onHand+delta<0) throw new Error(`${row.itemCode} 異動後庫存不可小於 0`);
          let lots=[...(old.lots||[])];
          if(row.lotNo||row.expiryDate){
            const li=lots.findIndex(l=>(l.lotNo||'')===row.lotNo&&(l.expiryDate||'')===row.expiryDate);
            if(li>=0) lots[li]={...lots[li],qty:Number(lots[li].qty||0)+delta};
            else lots.push({lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',qty:delta});
          }
          tx.set(ref,{productKey:key,productId:key,itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:resolveBrandName(row.brand||match.brand||''),onHand:n.onHand+delta,reserved:n.reserved,incoming:n.incoming,lots,updatedAt:new Date().toISOString()},{merge:true});
          tx.set(db.collection('inventoryMovements').doc(),{type,qty:delta,productKey:key,itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:resolveBrandName(row.brand||match.brand||''),lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',sourceType:'manual',sourceId:'',createdAt:new Date().toISOString(),createdBy:actor});
        });
      }
      closeInventoryAdjustment();
      await loadInventory(true);
      alert(`已完成 ${rows.length} 筆庫存異動。`);
    }catch(e){alert('庫存異動失敗：'+e.message);}
    finally{if(button){button.disabled=false;button.textContent='確認儲存';}}
};

function inventoryProductKey(record) {
    return String(record?.productId || (record?.itemCode ? `code:${normalizeHistoryItemCode(record.itemCode)}` : '')).trim();
}
function inventoryRefFor(record) {
    const key = inventoryProductKey(record);
    return key ? db.collection('inventory').doc(encodeURIComponent(key)) : null;
}
function inventoryNumbers(data = {}) {
    const onHand = Number(data.onHand || 0), reserved = Number(data.reserved || 0), incoming = Number(data.incoming || 0);
    return { onHand, reserved, available: onHand - reserved, incoming };
}
function inventoryMovementRecord(type, qty, orderId, productKey, actor, extra = {}) {
    return { type, qty: Number(qty || 0), productKey, sourceType: DOCUMENT_TYPES.ORDER, sourceId: orderId, createdAt: new Date().toISOString(), createdBy: actor, ...extra };
}

function inventoryReservationPayload(orderId, order, reservedQty, status = 'active') {
    return {
        orderId,
        orderNo: order.orderNo || order.quoteNo || orderId,
        productKey: inventoryProductKey(order),
        itemCode: order.itemCode || '',
        itemName: order.itemName || '',
        customerName: order.customerName || '',
        salesCode: order.salesCode || salesCodeForName(order.salesName),
        salesName: order.salesName || '',
        orderDate: order.orderDate || '',
        quantity: Math.max(0, Number(reservedQty || 0)),
        status,
        updatedAt: new Date().toISOString()
    };
}

function reservationDocRef(orderId) {
    return db.collection('inventoryReservations').doc(String(orderId));
}

window.openInventoryReservationDetails = async function(productKey) {
    const overlay = document.getElementById('inventoryReservationOverlay');
    const body = document.getElementById('inventoryReservationBody');
    const title = document.getElementById('inventoryReservationTitle');
    if (!overlay || !body) return;
    body.innerHTML = '<tr><td colspan="7">讀取中…</td></tr>';
    if (title) title.innerText = '已占用訂單';
    overlay.classList.add('active');
    try {
        const snapshot = await db.collection('inventoryReservations').where('productKey', '==', productKey).limit(100).get();
        const rows = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(item => item.status === 'active' && Number(item.quantity || 0) > 0)
            .sort((x, y) => String(y.orderDate || '').localeCompare(String(x.orderDate || '')));
        body.innerHTML = rows.length ? rows.map(item => `<tr>
            <td>${escapeHtml(item.orderNo || item.orderId || item.id)}</td>
            <td>${escapeHtml(item.customerName || '')}</td>
            <td>${escapeHtml(item.itemCode || '')}</td>
            <td>${escapeHtml(item.itemName || '')}</td>
            <td>${Number(item.quantity || 0)}</td>
            <td>${escapeHtml(item.salesName || item.salesCode || '')}</td>
            <td>${escapeHtml(item.orderDate || '')}</td>
        </tr>`).join('') : '<tr><td colspan="7" style="color:#888;">目前沒有有效占用訂單。</td></tr>';
    } catch (err) {
        body.innerHTML = `<tr><td colspan="7">讀取失敗：${escapeHtml(err.message || String(err))}</td></tr>`;
    }
};

window.closeInventoryReservationDetails = function() {
    document.getElementById('inventoryReservationOverlay')?.classList.remove('active');
};
function orderReservedQuantity(order) {
    if (normalizedOrderStatus(order) !== 'normal') return 0;
    return Math.max(0, orderQuantity(order) - deliveredQuantity(order));
}

async function reserveInventoryForNewOrder(orderId, order) {
    const ref = inventoryRefFor(order);
    const requested = orderQuantity(order);
    if (!ref || !requested) return { reservedQty: 0, shortageQty: requested };

    const productKey = inventoryProductKey(order);
    const actor = currentUserName || currentUser?.email || '';
    let result;

    await db.runTransaction(async tx => {
        const snap = await tx.get(ref);

        // 新產品在「訂單成立」時不建立正式 inventory 主檔。
        // 先把整筆需求列為 shortage；等 PO 送出後進 pendingInventoryItems，到貨時才一鍵建檔。
        if (!snap.exists) {
            tx.update(db.collection('orders').doc(orderId), {
                inventoryReservedQty: 0,
                inventoryShortageQty: requested,
                inventoryProductKey: productKey
            });
            tx.set(reservationDocRef(orderId), inventoryReservationPayload(orderId, order, 0, 'shortage'), { merge: true });
            result = { reservedQty: 0, shortageQty: requested };
            return;
        }

        const stock = inventoryNumbers(snap.data());
        const reservable = Math.max(0, Math.min(requested, stock.available));
        const shortage = Math.max(0, requested - reservable);

        tx.update(ref, {
            reserved: stock.reserved + reservable,
            updatedAt: new Date().toISOString()
        });

        if (reservable) {
            const movement = db.collection('inventoryMovements').doc();
            tx.set(movement, inventoryMovementRecord('reserve', reservable, orderId, productKey, actor));
        }

        tx.update(db.collection('orders').doc(orderId), {
            inventoryReservedQty: reservable,
            inventoryShortageQty: shortage,
            inventoryProductKey: productKey
        });
        tx.set(reservationDocRef(orderId), inventoryReservationPayload(orderId, order, reservable, reservable > 0 ? 'active' : 'shortage'), { merge: true });
        result = { reservedQty: reservable, shortageQty: shortage };
    });
    return result;
}

function orderQuantity(order) {
    const qty = parseFloat(order?.qty);
    return Number.isFinite(qty) && qty > 0 ? qty : 0;
}

function savedDeliveryRecords(order) {
    return Array.isArray(order?.deliveryRecords) ? order.deliveryRecords : [];
}

function deliveredQuantity(order) {
    const records = savedDeliveryRecords(order);
    if (records.length) return records.reduce((sum, record) => sum + (parseFloat(record.qty) || 0), 0);
    // 舊資料只有「已送貨」布林值：視為全數送貨，但不在未確認前改寫雲端資料。
    return order?.isDelivered ? orderQuantity(order) : 0;
}

function deliveryProgressInfo(order) {
    const total = orderQuantity(order);
    const delivered = Math.min(deliveredQuantity(order), total || deliveredQuantity(order));
    const remaining = Math.max(0, total - delivered);
    const isLegacyEstimated = !!order?.isDelivered && savedDeliveryRecords(order).length === 0;
    const state = total > 0 && delivered >= total ? 'complete' : delivered > 0 ? 'partial' : 'none';
    const label = state === 'complete' ? `已送 ${delivered}/${total}` : state === 'partial' ? `部分 ${delivered}/${total}` : `未送 0/${total || 0}`;
    return { total, delivered, remaining, state, label, isLegacyEstimated };
}

function savedReturnRecords(order) {
    return Array.isArray(order?.returnRecords) ? order.returnRecords : [];
}

function returnedQuantity(order) {
    return savedReturnRecords(order).reduce((sum, record) => sum + (parseFloat(record.qty) || 0), 0);
}

function normalizedOrderStatus(order) {
    // UI 將取消／作廢視為同一個「不可繼續履約」狀態；底層 status 仍保留 cancelled / voided 以利稽核。
    const canonical = order?.status || '';
    const legacy = order?.orderStatus || '';
    if ([BUSINESS_STATUS.CANCELLED, BUSINESS_STATUS.VOIDED, 'cancelled', 'voided'].includes(canonical)
        || ['cancelled', 'voided'].includes(legacy)) return 'cancelled';
    return 'normal';
}

function orderLifecycleInfo(order) {
    const delivered = deliveredQuantity(order);
    const returned = Math.min(returnedQuantity(order), delivered);
    const effectiveDelivered = Math.max(0, delivered - returned);
    const status = normalizedOrderStatus(order);
    if (status === 'cancelled') return { status, label: '已取消', css: 'invalid', delivered, returned, effectiveDelivered };
    if (returned > 0 && effectiveDelivered <= 0) return { status, label: '全數退貨', css: 'invalid', delivered, returned, effectiveDelivered };
    if (returned > 0) return { status, label: '部分退貨', css: 'returned', delivered, returned, effectiveDelivered };
    return { status, label: '正常', css: 'normal', delivered, returned, effectiveDelivered };
}

function orderProgressInfo(order) {
    const lifecycle = orderLifecycleInfo(order);
    const delivery = deliveryProgressInfo(order);
    if (lifecycle.status !== 'normal' || lifecycle.returned > 0) return { label: lifecycle.label, css: lifecycle.css === 'returned' ? 'partial' : 'invalid' };
    if (delivery.delivered > 0 && delivery.state === 'partial') return { label: `部分送貨 ${delivery.delivered}/${delivery.total}`, css: 'partial' };
    if (delivery.state === 'complete') return order.isBilled ? { label: '已完成', css: 'complete' } : { label: '已送貨・待報帳', css: 'active' };
    if (order.isArrived) return { label: '已到貨・待送貨', css: 'active' };
    if (order.isOrdered) return { label: '已訂貨・待到貨', css: 'active' };
    return { label: '待訂貨', css: 'pending' };
}

function isDeletableOrderDraft(order) {
    if (!order || order.quoteNo || order.purchaseOrderNo) return false;
    if (order.isOrdered || order.isArrived || order.isDelivered || order.isBilled) return false;
    if (savedDeliveryRecords(order).length || savedReturnRecords(order).length) return false;
    if ((order.statusHistory || []).length || (order.deliveryHistory || []).length || (order.returnHistory || []).length || (order.orderLifecycleHistory || []).length) return false;
    return normalizedOrderStatus(order) === 'normal';
}

function orderWorkCategory(order) {
    const lifecycle = orderLifecycleInfo(order);
    const delivery = deliveryProgressInfo(order);
    if (lifecycle.status !== 'normal' || (lifecycle.returned > 0 && lifecycle.effectiveDelivered <= 0)) return 'closed';
    if (delivery.state === 'complete') return order.isBilled ? 'complete' : 'billing';
    if (delivery.delivered > 0 || order.isArrived) return 'delivery';
    if (order.isOrdered) return 'arrival';
    return 'ordering';
}

function orderWorkAmount(order, category) {
    const totalQty = orderQuantity(order);
    const unitSales = totalQty ? salesAmount(order) / totalQty : (parseFloat(order.unitPrice) || 0);
    if (category === 'delivery') return Math.max(0, totalQty - deliveredQuantity(order)) * unitSales;
    if (category === 'billing' || category === 'complete') return orderLifecycleInfo(order).effectiveDelivered * unitSales;
    return salesAmount(order);
}

window.setOrderWorkFilter = function(filter) {
    activeOrderWorkFilter = activeOrderWorkFilter === filter && filter !== 'all' ? 'all' : filter;
    renderOrdersList();
};

function renderOrderWorkCards(orders) {
    const container = document.getElementById('orderWorkCards');
    if (!container) return;
    const definitions = [
        ['all', '全部'], ['ordering', '待訂貨'], ['arrival', '待到貨'], ['delivery', '待送貨'],
        ['billing', '待報帳'], ['complete', '已完成'], ['closed', '異常／已關閉']
    ];
    const metrics = Object.fromEntries(definitions.map(([key]) => [key, { count: 0, amount: 0 }]));
    orders.forEach(order => {
        const category = orderWorkCategory(order);
        const amount = orderWorkAmount(order, category);
        if (dateInOrderPeriod(order.orderDate || '')) {
            metrics.all.count++;
            metrics.all.amount += salesAmount(order);
        }
        if (orderMatchesWorkPeriod(order, category)) {
            metrics[category].count++;
            metrics[category].amount += amount;
        }
    });
    container.innerHTML = definitions.map(([key, label]) => `<button type="button" class="order-work-card ${activeOrderWorkFilter === key ? 'active' : ''}" onclick="setOrderWorkFilter('${key}')"><span>${label}</span><strong>${metrics[key].count} 筆</strong><small>${formatStatsMoney(metrics[key].amount)}</small></button>`).join('');
}

function createOrderPaginationState() {
    const sources = [];
    if (canViewAllData('orders')) {
        sources.push({
            cursor: null,
            exhausted: false,
            query: () => db.collection('orders').orderBy('orderDate', 'desc')
        });
    } else {
        if (currentUserCode) {
            sources.push({
                cursor: null,
                exhausted: false,
                query: () => db.collection('orders').where('salesCode', '==', currentUserCode)
            });
        }
        if (currentUser?.uid) {
            sources.push({
                cursor: null,
                exhausted: false,
                query: () => db.collection('orders').where('ownerUid', '==', currentUser.uid)
            });
        }
        if (currentUserName) {
            sources.push({
                cursor: null,
                exhausted: false,
                query: () => db.collection('orders').where('salesName', '>=', currentUserName).where('salesName', '<=', currentUserName + '\uf8ff')
            });
        }
    }
    return { sources, sourceIndex: 0 };
}

function updateOrderLoadMoreButton() {
    const button = document.getElementById('orderLoadMoreBtn');
    if (!button) return;
    const hasMore = !!orderPaginationState && orderPaginationState.sourceIndex < orderPaginationState.sources.length;
    button.style.display = hasMore ? '' : 'none';
    button.disabled = orderPageLoading;
    button.innerText = orderPageLoading ? '載入中…' : '載入更多（每次 50 筆）';
}

async function loadOrderPage(reset) {
    if (orderPageLoading) {
        if (reset) orderReloadRequested = true;
        return;
    }
    if (getDataScope('orders') === 'none') {
        ordersCache = [];
        orderPaginationState = null;
        renderOrdersList();
        updateOrderLoadMoreButton();
        return;
    }
    if (reset || !orderPaginationState) {
        orderPaginationState = createOrderPaginationState();
        ordersCache = [];
    }
    orderPageLoading = true;
    const requestedRole = currentUserRole;
    updateOrderLoadMoreButton();
    const records = new Map(ordersCache.map(order => [order.id, order]));
    let remainingReads = DEFAULT_LIST_LIMIT;
    try {
        while (remainingReads > 0 && orderPaginationState.sourceIndex < orderPaginationState.sources.length) {
            const source = orderPaginationState.sources[orderPaginationState.sourceIndex];
            const requested = remainingReads;
            let query = source.query().limit(requested);
            if (source.cursor) query = query.startAfter(source.cursor);
            const snapshot = await query.get();
            if (requestedRole !== currentUserRole) {
                orderReloadRequested = true;
                return;
            }
            if (!snapshot.empty) {
                source.cursor = snapshot.docs[snapshot.docs.length - 1];
                snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));
                ordersCache = [...records.values()];
            }
            remainingReads -= snapshot.size;
            if (snapshot.size < requested) {
                source.exhausted = true;
                orderPaginationState.sourceIndex++;
            }
        }
        ordersCache.sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'orderDate', 'id'));
        renderOrdersList();
    } catch (err) {
        console.error("讀取訂單失敗：", err);
        ordersCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'orderDate', 'id'));
        renderOrdersList();
        alert('讀取訂單資料失敗，請確認 Firestore 權限設定。');
    } finally {
        orderPageLoading = false;
        updateOrderLoadMoreButton();
        if (orderReloadRequested) {
            orderReloadRequested = false;
            loadOrderPage(true);
        }
    }
}

// 訂單資料範圍由管理員在身份權限中設定：只看自己或查看所有人。
// 首次與重新整理只載入 50 筆；歷史資料由「載入更多」明確取得，避免資料增加後
// 每次進入訂單頁都在背景掃完整個 orders 集合。
window.loadOrdersFromCloud = function() {
    return loadOrderPage(true);
};

window.loadMoreOrders = function() {
    return loadOrderPage(false);
};

/*
 * Phase 1B 全歷史搜尋
 * Firestore 本身不適合直接做任意「品名包含文字」搜尋。為避免每次搜尋掃完整個歷史集合，
 * 先提供可索引的「精確貨號」全歷史搜尋；一般文字仍搜尋目前已載入的 50 筆。
 * Phase 2 Product Master 建立 productId/search tokens 後，再把品名全歷史搜尋接到正式索引。
 */
let orderHistorySearchActive = false;
let orderHistorySearchLoading = false;
let orderHistorySearchCursor = null;
let orderHistorySearchKeyword = '';
let orderHistorySearchResults = [];

function normalizeHistoryItemCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function updateOrderHistorySearchUi(message = '') {
    const status = document.getElementById('orderHistorySearchStatus');
    const more = document.getElementById('orderHistorySearchMoreBtn');
    if (status) status.innerText = message;
    if (more) {
        more.style.display = orderHistorySearchActive && orderHistorySearchCursor ? '' : 'none';
        more.disabled = orderHistorySearchLoading;
    }
}

async function runOrderHistoryItemCodeSearch(reset = true) {
    const input = document.getElementById('orderSearch');
    const rawKeyword = input?.value || '';
    const keyword = normalizeHistoryItemCode(rawKeyword);
    if (!keyword) {
        orderHistorySearchActive = false;
        orderHistorySearchResults = [];
        orderHistorySearchCursor = null;
        updateOrderHistorySearchUi('');
        renderOrdersList();
        return;
    }
    if (orderHistorySearchLoading) return;
    orderHistorySearchLoading = true;
    if (reset || keyword !== orderHistorySearchKeyword) {
        orderHistorySearchKeyword = keyword;
        orderHistorySearchResults = [];
        orderHistorySearchCursor = null;
    }
    updateOrderHistorySearchUi('正在搜尋全部歷史訂單…');
    try {
        let query = db.collection('orders').where('itemCodeKey', '==', keyword).orderBy('orderDate', 'desc').limit(DEFAULT_LIST_LIMIT);
        if (orderHistorySearchCursor) query = query.startAfter(orderHistorySearchCursor);
        const snapshot = await query.get();
        const records = new Map(orderHistorySearchResults.map(order => [order.id, order]));
        snapshot.forEach(doc => {
            const data = { id: doc.id, ...doc.data() };
            if (canViewAllData('orders') || belongsToCurrentUser(data.salesName, data.ownerUid, data.salesCode)) records.set(doc.id, data);
        });
        orderHistorySearchResults = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'orderDate', 'id'));
        orderHistorySearchCursor = snapshot.size === DEFAULT_LIST_LIMIT ? snapshot.docs[snapshot.docs.length - 1] : null;
        orderHistorySearchActive = true;
        updateOrderHistorySearchUi(`全歷史貨號搜尋：已找到 ${orderHistorySearchResults.length} 筆${orderHistorySearchCursor ? '，可繼續載入' : ''}`);
        renderOrdersList();
    } catch (err) {
        console.error('全歷史貨號搜尋失敗：', err);
        orderHistorySearchActive = false;
        orderHistorySearchCursor = null;
        updateOrderHistorySearchUi('目前資料尚未建立全歷史搜尋索引；仍可搜尋已載入資料。');
        renderOrdersList();
    } finally {
        orderHistorySearchLoading = false;
        updateOrderHistorySearchUi(document.getElementById('orderHistorySearchStatus')?.innerText || '');
    }
}

window.searchAllOrderHistory = function() {
    return runOrderHistoryItemCodeSearch(true);
};

window.loadMoreOrderHistorySearch = function() {
    return runOrderHistoryItemCodeSearch(false);
};

window.clearOrderHistorySearch = function() {
    orderHistorySearchActive = false;
    orderHistorySearchKeyword = '';
    orderHistorySearchResults = [];
    orderHistorySearchCursor = null;
    const input = document.getElementById('orderSearch');
    if (input) input.value = '';
    updateOrderHistorySearchUi('');
    renderOrdersList();
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

    populatePurchaserOrderFilters();
    const salesFilter = document.getElementById('orderSalesFilter')?.value || '';
    const brandFilter = document.getElementById('orderBrandFilter')?.value || '';
    const keyword = (searchInput.value || '').toLowerCase();
    tbody.innerHTML = '';
    let shown = 0;

    const visibleOrderSource = orderHistorySearchActive ? orderHistorySearchResults : ordersCache;
    const baseOrders = visibleOrderSource.filter(o => {
        const searchable = `${o.customerName || ''} ${o.brand || ''} ${o.itemCode || ''} ${o.itemName || ''} ${o.quoteNo || ''} ${o.salesName || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return false;
        if (salesFilter && stripPhoneSuffix(o.salesName) !== salesFilter) return false;
        if (brandFilter && (o.brand || '') !== brandFilter) return false;
        return true;
    });
    renderOrderWorkCards(baseOrders);

    baseOrders.forEach(o => {
        const category = orderWorkCategory(o);
        if (activeOrderWorkFilter !== 'all' && category !== activeOrderWorkFilter) return;
        if (!orderMatchesWorkPeriod(o, activeOrderWorkFilter === 'all' ? 'all' : category)) return;
        shown++;

        const tr = document.createElement('tr');
        const lifecycle = orderLifecycleInfo(o);
        if (lifecycle.status !== 'normal' || (lifecycle.returned > 0 && lifecycle.effectiveDelivered <= 0)) {
            tr.classList.add('order-row-closed');
        }
        bindListRowSelection(tr);
        tr.innerHTML = `
            ${canGeneratePo ? `<td class="no-print" data-th="選取">${o.purchaseOrderNo ? '<span style="color:#777;font-size:10px;">已建立</span>' : `<input type="checkbox" class="order-select-checkbox" data-order-id="${o.id}">`}</td>` : ''}
            <td data-th="訂單日期">${escapeHtml(o.orderDate || '')}</td>
            <td data-th="客戶名稱">${o.customerName ? `<button type="button" class="btn-small btn-secondary" onclick="showCustomerOrderHistory('${escapeAttr(o.customerName)}')">${escapeHtml(o.customerName)}</button>` : ''}</td>
            <td data-th="負責業務">${escapeHtml(stripPhoneSuffix(o.salesName))}</td>
            <td data-th="產品資訊" class="order-product-cell"><strong>${escapeHtml(o.itemName || '－')}</strong><small>${escapeHtml(o.brand || '未分類')}${o.itemCode ? `・${escapeHtml(o.itemCode)}` : ''}</small></td>
            <td data-th="售價" class="order-money-cell"><strong>NT$ ${escapeHtml(Number(parseFloat(String(o.totalPrice ?? '').replace(/,/g, '')) || 0).toLocaleString())}</strong><small>NT$ ${escapeHtml(Number(parseFloat(String(o.unitPrice ?? '').replace(/,/g, '')) || 0).toLocaleString())} × ${escapeHtml(String(o.qty || 0))}</small></td>
            ${canGeneratePo ? `
            <td class="no-print order-cost-profit-cell" data-th="成本／毛利"><label>單位成本</label><input type="number" step="0.01" class="order-cost-input" data-order-id="${o.id}" value="${o.costPrice != null ? o.costPrice : ''}" oninput="updateOrderProfitDisplay('${o.id}', this.value)" onchange="updateOrderField('${o.id}','costPrice', this.value === '' ? null : parseFloat(this.value))"><small>毛利：<span id="orderProfit_${o.id}">${formatProfitPercent(o.unitPrice, o.costPrice)}</span></small></td>` : ''}
            <td data-th="交易資訊" class="order-transaction-cell">
                <select onchange="updateOrderField('${o.id}','transactionType',this.value)">
                    <option value="" ${!o.transactionType ? 'selected' : ''}>未選擇</option>
                    <option value="直" ${o.transactionType === '直' ? 'selected' : ''}>直</option>
                    <option value="借" ${o.transactionType === '借' ? 'selected' : ''}>借</option>
                    <option value="扣" ${o.transactionType === '扣' ? 'selected' : ''}>扣</option>
                </select>
                ${o.transactionType === '直' ? `<input type="text" aria-label="發票抬頭" placeholder="發票抬頭" value="${escapeAttr(o.invoiceTitle || '')}" onchange="updateOrderField('${o.id}','invoiceTitle',this.value)">` : ''}
                ${o.isBilled ? `<label class="order-invoice-date-label">開票／收款日<input type="date" aria-label="開發票及收款日期" value="${escapeAttr(orderInvoiceDate(o))}" onchange="updateOrderInvoiceDate('${o.id}',this.value)"></label>` : ''}
            </td>
            <td data-th="備註"><input type="text" value="${escapeAttr(o.remarks || '')}" placeholder="備註" onchange="updateOrderField('${o.id}','remarks',this.value)"></td>
            <td class="no-print" data-th="操作">
                <div class="order-compact-actions">
                    <button type="button" class="btn-small ${o.isOrdered ? 'status-ok' : 'btn-secondary'}" onclick="toggleOrderStatus('${o.id}', 'isOrdered', ${!o.isOrdered})" ${normalizedOrderStatus(o) !== 'normal' || pendingOrderStatusKeys.has(`${o.id}:isOrdered`) ? 'disabled' : ''}>${pendingOrderStatusKeys.has(`${o.id}:isOrdered`) ? '儲存中…' : o.isOrdered ? '已訂貨' : '訂貨'}</button>
                    <button type="button" class="btn-small ${o.isArrived ? 'status-ok' : 'btn-secondary'}" onclick="toggleOrderStatus('${o.id}', 'isArrived', ${!o.isArrived})" ${normalizedOrderStatus(o) !== 'normal' || pendingOrderStatusKeys.has(`${o.id}:isArrived`) ? 'disabled' : ''}>${pendingOrderStatusKeys.has(`${o.id}:isArrived`) ? '儲存中…' : o.isArrived ? '已到貨' : '到貨'}</button>
                    <button type="button" class="btn-small ${pendingDeliveryOrderIds.has(o.id) ? 'btn-secondary' : deliveryProgressInfo(o).state === 'complete' ? 'status-ok' : deliveryProgressInfo(o).state === 'partial' ? 'status-soon' : 'btn-secondary'}" onclick="quickCompleteDelivery('${o.id}')" ${normalizedOrderStatus(o) !== 'normal' || pendingDeliveryOrderIds.has(o.id) ? 'disabled' : ''}>${pendingDeliveryOrderIds.has(o.id) ? '處理中…' : deliveryProgressInfo(o).state === 'complete' ? '已送貨' : deliveryProgressInfo(o).state === 'partial' ? `送貨 ${deliveryProgressInfo(o).delivered}/${deliveryProgressInfo(o).total}` : '送貨'}</button>
                    <button type="button" class="btn-small ${o.isBilled ? 'status-ok' : 'btn-secondary'}" onclick="toggleOrderStatus('${o.id}', 'isBilled', ${!o.isBilled})" ${normalizedOrderStatus(o) !== 'normal' || pendingOrderStatusKeys.has(`${o.id}:isBilled`) ? 'disabled' : ''}>${pendingOrderStatusKeys.has(`${o.id}:isBilled`) ? '儲存中…' : o.isBilled ? '已報帳' : '報帳'}</button>
                    <details class="order-more-menu">
                        <summary title="更多操作">⋯</summary>
                        <div class="order-more-menu-popover">
                            ${pendingLifecycleOrderIds.has(o.id)
                                ? '<button type="button" disabled>處理中…</button>'
                                : normalizedOrderStatus(o) === 'normal'
                                    ? `<button type="button" onclick="openPartialDeliveryForOrder('${o.id}')">分批交貨</button>
                            <button type="button" class="danger-menu-item" onclick="quickSetOrderLifecycle('${o.id}', 'cancelled')">取消訂單</button>
                            <button type="button" onclick="openReturnManagement('${o.id}')">退貨</button>`
                                    : `<button type="button" onclick="quickSetOrderLifecycle('${o.id}', 'normal')">恢復訂單</button>`}
                            <button type="button" onclick="copyOrderAsNew('${o.id}')">複製成新訂單</button>
                            <button type="button" onclick="openOrderStatusHistory('${o.id}')">紀錄</button>
                        </div>
                    </details>
                </div>
            </td>
            <td class="no-print" data-th="訂購單">${o.purchaseOrderNo ? `<button type="button" class="btn-small btn-secondary" onclick="openPurchaseOrderFromOrder('${escapeAttr(o.purchaseOrderNo)}')">${escapeHtml(o.purchaseOrderNo)}</button>` : '－'}</td>
        `;
        tbody.appendChild(tr);
    });
    document.getElementById('ordersEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

window.toggleAllOrderSelect = function(checkbox) {
    document.querySelectorAll('.order-select-checkbox').forEach(cb => { cb.checked = checkbox.checked; });
};

// 訂單管理系統的子分頁：「業務訂單」跟「採購訂單」（已經產生過的訂購單紀錄，只有採購／管理員看得到）
window.switchOrderView = function(view, el, options = {}) {
    const pageKey = view === 'po' ? 'orders.po' : 'orders.list';
    const previousView = document.getElementById('poListPanel')?.style.display === 'block' ? 'po' : 'list';
    if (!options.skipHistory && previousView !== view) pushAppNavigationState({ tabId: 'order-system', orderView: view });
    if (!canAccessPage(pageKey)) { alert('您沒有權限查看這個分頁。'); return; }
    document.querySelectorAll('#order-system .sub-nav .sub-tab').forEach(t => t.classList.remove('active'));
    if (el) el.classList.add('active');

    document.getElementById('orderListPanel').style.display = view === 'list' ? 'block' : 'none';
    document.getElementById('poListPanel').style.display = view === 'po' ? 'block' : 'none';

    if (view === 'po' && !options.skipReload && poListCache.length === 0) loadMyPurchaseOrders();
    updateReadonlyNotice();
};

let poListCache = [];
let poListCursor = null;
let poListHasMore = false;
let poListPageLoading = false;

// 「採購訂單」列出所有已經產生過的訂購單紀錄（不分是誰產生的，只要是採購／管理員都看得到全部）
function updatePoLoadMoreButton() {
    const button = document.getElementById('poLoadMoreBtn');
    if (!button) return;
    button.style.display = poListHasMore ? '' : 'none';
    button.disabled = poListPageLoading;
    button.innerText = poListPageLoading ? '載入中…' : '載入更多（每次 50 筆）';
}

async function loadPurchaseOrderPage(reset) {
    if (poListPageLoading) return;
    if (reset) {
        poListCursor = null;
        poListHasMore = true;
        poListCache = [];
    }
    if (!poListHasMore) return;
    poListPageLoading = true;
    updatePoLoadMoreButton();
    try {
        let query = db.collection('purchaseOrders').orderBy('poNo', 'desc').limit(DEFAULT_LIST_LIMIT);
        if (poListCursor) query = query.startAfter(poListCursor);
        const snapshot = await query.get();
        if (!snapshot.empty) poListCursor = snapshot.docs[snapshot.docs.length - 1];
        const records = new Map(poListCache.map(po => [po.id, po]));
        snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));
        poListCache = [...records.values()].sort((a, b) => (b.poNo || '').localeCompare(a.poNo || ''));
        poListHasMore = snapshot.size === DEFAULT_LIST_LIMIT;
        renderPoList();
    } catch (err) {
        console.error(err);
        alert('讀取訂購單紀錄失敗，請確認 Firestore 權限設定。');
    } finally {
        poListPageLoading = false;
        updatePoLoadMoreButton();
    }
}

window.loadMyPurchaseOrders = function() {
    return loadPurchaseOrderPage(true);
};

window.loadMorePurchaseOrders = function() {
    return loadPurchaseOrderPage(false);
};

window.renderPoList = function() {
    const tbody = document.getElementById('poListBody');
    const searchInput = document.getElementById('poListSearch');
    if (!tbody || !searchInput) return;
    const keyword = (searchInput.value || '').toLowerCase();
    const periodFilter = document.getElementById('poPeriodFilter')?.value || 'this-year';
    tbody.innerHTML = '';
    let shown = 0;

    poListCache.forEach(po => {
        const searchable = `${po.poNo || ''} ${po.vendorName || ''} ${po.buyerName || ''}`.toLowerCase();
        if (keyword && !searchable.includes(keyword)) return;
        // 未到貨 PO 屬於未完成狀態，跨期間保留；已完成 PO 依訂購日期套用統計期間。
        if (poReceiptProgress(po).complete && !dateInUnifiedPeriod(po.poDate || po.createdAt, periodFilter)) return;
        shown++;

        const items = purchaseItemsFromSavedPo(po);
        const subtotal = items.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
        const grandTotal = Math.round(subtotal) + Math.round(subtotal * 0.05);
        const companyInfo = companyData[po.company];
        const companyLabel = companyInfo ? `${companyInfo.title}（${companyInfo.prefix}）` : (po.company || '');

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-th="單號">${escapeHtml(po.poNo || '')}</td>
            <td data-th="公司">${escapeHtml(companyLabel)}</td>
            <td data-th="廠商">${escapeHtml(po.vendorName || '')}</td>
            <td data-th="採購人員">${escapeHtml(po.buyerName || '')}</td>
            <td data-th="訂購日期">${escapeHtml(po.poDate || '')}</td>
            <td data-th="品項數">${items.length}</td>
            <td data-th="總計金額">${grandTotal.toLocaleString()}</td>
            <td data-th="到貨進度">${(() => { const progress = poReceiptProgress(po); return progress.complete ? '已全部到貨' : progress.received > 0 ? '部分到貨 ' + progress.received + '/' + progress.ordered : '待到貨 0/' + progress.ordered; })()}</td>
            <td data-th="操作" class="no-print"><button type="button" class="btn-small" onclick="reprintPurchaseOrder('${escapeAttr(po.id)}')">🖨️ 重新列印</button> <button type="button" class="btn-small btn-secondary" onclick="receivePurchaseOrder('${escapeAttr(po.id)}')">📥 到貨入庫</button></td>
        `;
        tbody.appendChild(tr);
    });

    document.getElementById('poListEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

// 把「採購訂單」裡一筆舊的訂購單紀錄，重新載回訂購單視窗，維持原本的單號，方便再列印一次
window.reprintPurchaseOrder = function(poId) {
    poDirectStockMode = false;
    const po = poListCache.find(p => p.id === poId);
    if (!po) return;

    populatePoVendorSuggestions();
    poItems = purchaseItemsFromSavedPo(po);
    poAllItems = poItems;
    poEditingId = po.id;
    switchPoCompany(po.company || 'yushin', null, true);

    document.getElementById('poVendorName').value = po.vendorName || '';
    document.getElementById('poBuyerName').innerText = po.buyerName || '';
    document.getElementById('poDate').value = po.poDate || '';
    document.getElementById('poNo').innerText = po.poNo || '';

    renderPoItemsTable();
    updatePoModeUI();
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
let poEditingId = null;
let poSaveInProgress = false;
let poDirectStockMode = false;

function receivedQuantityForPoItem(po, itemIndex) {
    return (Array.isArray(po?.receiptRecords) ? po.receiptRecords : [])
        .filter(r => Number(r.itemIndex) === Number(itemIndex))
        .reduce((sum, r) => sum + (Number(r.qty) || 0), 0);
}
function poReceiptProgress(po) {
    const items = purchaseItemsFromSavedPo(po);
    const ordered = items.reduce((s,i)=>s+Number(i.qty||0),0);
    const received = items.reduce((s,i,index)=>s+Math.min(Number(i.qty||0), receivedQuantityForPoItem(po,index)),0);
    return { ordered, received, remaining: Math.max(0, ordered-received), complete: ordered>0 && received>=ordered };
}
function poIncomingKey(item) {
    return String(item.productId || (item.itemCode ? `code:${normalizeHistoryItemCode(item.itemCode)}` : '')).trim();
}
async function registerPurchaseIncoming(poId, poRecord, previousPo = null) {
    const previousItems = previousPo ? purchaseItemsFromSavedPo(previousPo) : [];
    const nextItems = purchaseItemsFromSavedPo(poRecord);

    await db.runTransaction(async tx => {
        const refs = new Map();
        [...previousItems, ...nextItems].forEach(item => {
            const key = poIncomingKey(item);
            if (key) refs.set(key, db.collection('inventory').doc(encodeURIComponent(key)));
        });

        // Firestore transaction 要求所有 reads 在 writes 之前完成。
        const inventorySnaps = new Map();
        const pendingSnaps = new Map();
        for (const [key, ref] of refs) {
            const invSnap = await tx.get(ref);
            inventorySnaps.set(key, invSnap);
            if (!invSnap.exists) {
                const pendingRef = db.collection('pendingInventoryItems').doc(encodeURIComponent(key));
                pendingSnaps.set(key, await tx.get(pendingRef));
            }
        }

        for (const [key, ref] of refs) {
            const oldQty = previousItems.filter(i => poIncomingKey(i) === key).reduce((s, i) => s + Number(i.qty || 0), 0);
            const newQty = nextItems.filter(i => poIncomingKey(i) === key).reduce((s, i) => s + Number(i.qty || 0), 0);
            const delta = newQty - oldQty;
            if (!delta) continue;

            const sample = nextItems.find(i => poIncomingKey(i) === key) || previousItems.find(i => poIncomingKey(i) === key) || {};
            const invSnap = inventorySnaps.get(key);

            if (invSnap?.exists) {
                const stock = inventoryNumbers(invSnap.data());
                tx.update(ref, {
                    incoming: Math.max(0, stock.incoming + delta),
                    updatedAt: new Date().toISOString()
                });
            } else {
                const pendingRef = db.collection('pendingInventoryItems').doc(encodeURIComponent(key));
                const pending = pendingSnaps.get(key);
                const oldPendingQty = Number(pending?.exists ? pending.data().incomingQty : 0) || 0;
                const sourceOrderIds = nextItems.filter(i => poIncomingKey(i) === key && i.orderId).map(i => i.orderId);
                const payload = {
                    productKey: key,
                    productId: sample.productId || '',
                    itemCode: sample.itemCode || '',
                    itemName: sample.itemName || '',
                    brand: resolveBrandName(sample.brand || ''),
                    supplier: poRecord.vendorName || '',
                    incomingQty: Math.max(0, oldPendingQty + delta),
                    status: Math.max(0, oldPendingQty + delta) > 0 ? 'pending-arrival' : 'cancelled',
                    sourcePurchaseOrders: firebase.firestore.FieldValue.arrayUnion(poId),
                    updatedAt: new Date().toISOString(),
                    createdAt: pending?.exists ? (pending.data().createdAt || new Date().toISOString()) : new Date().toISOString()
                };
                if (sourceOrderIds.length) payload.sourceOrderIds = firebase.firestore.FieldValue.arrayUnion(...sourceOrderIds);
                tx.set(pendingRef, payload, { merge: true });
            }

            tx.set(db.collection('inventoryMovements').doc(), {
                type: 'purchase_incoming',
                qty: delta,
                productKey: key,
                sourceType: DOCUMENT_TYPES.PURCHASE_ORDER,
                sourceId: poId,
                createdAt: new Date().toISOString(),
                createdBy: currentUserName || currentUser?.email || ''
            });
        }
    });
}

let poReceiptTargetId = '';

window.receivePurchaseOrder = function(poId) {
    if (!canEditPage('orders.po')) return;
    const po = poListCache.find(p => p.id === poId);
    if (!po) return;
    const items = purchaseItemsFromSavedPo(po);
    const rows = items.map((item, index) => ({
        item,
        index,
        received: receivedQuantityForPoItem(po, index),
        remaining: Math.max(0, Number(item.qty || 0) - receivedQuantityForPoItem(po, index))
    })).filter(row => row.remaining > 0);
    if (!rows.length) { alert('這張訂購單已全部到貨。'); return; }

    poReceiptTargetId = poId;
    const body = document.getElementById('poReceiptBatchBody');
    const title = document.getElementById('poReceiptBatchTitle');
    if (title) title.textContent = `到貨入庫｜${po.poNo || po.id}`;
    body.innerHTML = rows.map(row => `
        <tr data-index="${row.index}">
            <td><input type="checkbox" class="po-receive-select" checked></td>
            <td>${escapeHtml(row.item.itemCode||'')}</td>
            <td>${escapeHtml(row.item.itemName||'')}</td>
            <td>${row.item.qty}</td>
            <td>${row.received}</td>
            <td>${row.remaining}</td>
            <td><input type="number" class="po-receive-qty" min="0" max="${row.remaining}" step="any" value="${row.remaining}" style="width:85px;"></td>
            <td><input type="text" class="po-receive-lot" placeholder="批號"></td>
            <td><input type="date" class="po-receive-expiry"></td>
        </tr>
    `).join('');
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

window.closePoReceiptBatch = function() {
    poReceiptTargetId = '';
    document.getElementById('poReceiptBatchOverlay')?.classList.remove('active');
};

async function receiveSinglePoLine(poId, itemIndex, qty, lotNo = '', expiryDate = '') {
    const now = new Date().toISOString();
    const actor = currentUserName || currentUser?.email || '';
    const receiptId = `rcv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${itemIndex}`;

    await db.runTransaction(async tx => {
        const poRef = db.collection('purchaseOrders').doc(poId);
        const poSnap = await tx.get(poRef);
        if (!poSnap.exists) throw new Error('找不到訂購單');
        const live = poSnap.data();
        const liveItems = purchaseItemsFromSavedPo(live);
        const item = liveItems[itemIndex];
        if (!item) throw new Error('找不到品項');

        const already = receivedQuantityForPoItem(live, itemIndex);
        const remaining = Math.max(0, Number(item.qty || 0) - already);
        if (!qty || qty <= 0 || qty > remaining) throw new Error(`${item.itemCode || item.itemName} 到貨數量不正確`);

        const key = poIncomingKey(item);
        if (!key) throw new Error(`${item.itemName || '品項'} 缺少貨號／Product ID`);

        const invRef = db.collection('inventory').doc(encodeURIComponent(key));
        const pendingRef = db.collection('pendingInventoryItems').doc(encodeURIComponent(key));
        const invSnap = await tx.get(invRef);
        const pendingSnap = await tx.get(pendingRef);
        const pendingIncoming = Number(pendingSnap.exists ? pendingSnap.data().incomingQty : 0) || 0;
        const stock = inventoryNumbers(invSnap.exists ? invSnap.data() : { incoming: pendingIncoming });

        let sourceOrder = null;
        let orderSnap = null;
        if (item.orderId) {
            orderSnap = await tx.get(db.collection('orders').doc(item.orderId));
            if (orderSnap.exists) sourceOrder = { id: orderSnap.id, ...orderSnap.data() };
        }

        let reserveFromReceipt = 0;
        if (sourceOrder) {
            const shortage = Math.max(0, Number(sourceOrder.inventoryShortageQty || 0));
            reserveFromReceipt = Math.min(qty, shortage);
        }

        const record = {
            id: receiptId, itemIndex, productKey:key, productId:item.productId||'',
            itemCode:item.itemCode||'', itemName:item.itemName||'', brand:resolveBrandName(item.brand||''),
            qty, lotNo, expiryDate, date:localDateString(), createdAt:now, createdBy:actor
        };
        const records = [...(live.receiptRecords || []), record];

        const lots = [...(invSnap.exists ? (invSnap.data().lots || []) : [])];
        if (lotNo || expiryDate) {
            const lotIndex = lots.findIndex(l => (l.lotNo||'') === lotNo && (l.expiryDate||'') === expiryDate);
            if (lotIndex >= 0) lots[lotIndex] = { ...lots[lotIndex], qty:Number(lots[lotIndex].qty||0)+qty };
            else lots.push({ lotNo, expiryDate, qty });
        }

        tx.set(invRef, {
            productKey:key, productId:item.productId||'', itemCode:item.itemCode||'', itemName:item.itemName||'',
            brand:resolveBrandName(item.brand||''), unitCost:Number(item.unitPrice||0), currency:live.currency||DEFAULT_CURRENCY,
            onHand:stock.onHand+qty, reserved:stock.reserved+reserveFromReceipt,
            incoming:Math.max(0,stock.incoming-qty), lots, updatedAt:now
        }, { merge:true });

        if (sourceOrder && reserveFromReceipt > 0) {
            const shortage = Math.max(0, Number(sourceOrder.inventoryShortageQty || 0));
            tx.update(db.collection('orders').doc(item.orderId), {
                inventoryReservedQty:Number(sourceOrder.inventoryReservedQty||0)+reserveFromReceipt,
                inventoryShortageQty:Math.max(0,shortage-reserveFromReceipt),
                inventoryProductKey:key
            });
            tx.set(reservationDocRef(item.orderId), inventoryReservationPayload(
                item.orderId, sourceOrder,
                Math.max(0,Number(sourceOrder.inventoryReservedQty||0)-deliveredQuantity(sourceOrder))+reserveFromReceipt,
                'active'
            ), { merge:true });
        }

        tx.set(db.collection('inventoryMovements').doc(), {
            type:'receipt', qty, productKey:key, itemCode:item.itemCode||'', itemName:item.itemName||'',
            brand:resolveBrandName(item.brand||''), lotNo, expiryDate, unitCost:Number(item.unitPrice||0),
            purchaseNetAmount:Number(item.unitPrice||0)*qty, sourceType:DOCUMENT_TYPES.PURCHASE_ORDER,
            sourceId:poId, receiptId, createdAt:now, createdBy:actor
        });

        const pendingRemaining=Math.max(0,pendingIncoming-qty);
        tx.set(pendingRef, {
            productKey:key, productId:item.productId||'', itemCode:item.itemCode||'', itemName:item.itemName||'',
            brand:resolveBrandName(item.brand||''), incomingQty:pendingRemaining,
            status:pendingRemaining>0?'pending-arrival':'completed',
            completedAt:pendingRemaining>0?null:now, completedBy:pendingRemaining>0?'':actor, updatedAt:now
        }, { merge:true });

        const receiptComplete = records.reduce((s,r)=>s+Number(r.qty||0),0) >= liveItems.reduce((s,i)=>s+Number(i.qty||0),0);
        tx.update(poRef, {
            receiptRecords:records, updatedAt:now,
            status:receiptComplete?BUSINESS_STATUS.COMPLETED:BUSINESS_STATUS.ACTIVE,
            receiptStatus:receiptComplete?'received':'partial'
        });
    });
}

window.savePoReceiptBatch = async function() {
    const poId = poReceiptTargetId;
    const button = document.getElementById('savePoReceiptBatchBtn');
    const rows = [...document.querySelectorAll('#poReceiptBatchBody tr')];
    const entries = rows.filter(row => row.querySelector('.po-receive-select')?.checked).map(row => ({
        itemIndex:Number(row.dataset.index),
        qty:Number(row.querySelector('.po-receive-qty')?.value||0),
        lotNo:(row.querySelector('.po-receive-lot')?.value||'').trim(),
        expiryDate:row.querySelector('.po-receive-expiry')?.value||''
    })).filter(entry => entry.qty > 0);
    if (!poId || !entries.length) { alert('請至少勾選一個到貨品項並輸入數量。'); return; }

    if (button) { button.disabled=true; button.textContent='入庫中…'; }
    try {
        for (const entry of entries) await receiveSinglePoLine(poId, entry.itemIndex, entry.qty, entry.lotNo, entry.expiryDate);
        await loadMyPurchaseOrders();
        if (canAccessPage('inventory')) await loadInventory(true);
        closePoReceiptBatch();
        alert(`已完成 ${entries.length} 個品項的批量到貨入庫。`);
    } catch (err) {
        alert('批量到貨入庫失敗：'+err.message);
    } finally {
        if (button) { button.disabled=false; button.textContent='確認入庫'; }
    }
};

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
        qty: parseFloat(item.qty ?? item.quantity ?? item.count) || 1,
        unit: item.unit || '',
        unitPrice: parseFloat(item.unitPrice ?? item.costPrice ?? item.cost ?? item.purchasePrice) || 0
    })).filter(item => item.itemName || item.itemCode);
}

// 將不同時期的訂單品項格式統一成訂購單使用的格式。舊資料是一張訂單一個
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
        if (!Number.isFinite(cost) || cost <= 0) {
            const normalizedCode = normalizeItemCode(itemCode);
            const normalizedBrand = String(brand || '').trim().toLocaleLowerCase();
            const priceMatch = (normalizedBrand && priceItemLookup.get(`brand:${normalizedBrand}:${normalizedCode}`))
                || priceItemLookup.get(`code:${normalizedCode}`);
            if (priceMatch) cost = parseFloat(priceMatch.cost ?? priceMatch.costPrice ?? priceMatch.purchasePrice);
        }
        const parsedQty = parseFloat(qtyValue);
        return {
            orderId: order.id,
            orderItemIndex: index,
            itemName,
            itemCode,
            productId: item.productId || order.productId || '',
            brand,
            qty: Number.isFinite(parsedQty) && parsedQty > 0 ? parsedQty : 1,
            unit: item.unit || order.unit || '',
            unitPrice: Number.isFinite(cost) && cost > 0 ? cost : 0
        };
    }).filter(item => item.itemName || item.itemCode);
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

window.openDirectStockPurchase = async function() {
    if (!canEditPage('orders.po')) return;
    await ensurePriceListLoaded().catch(() => {});
    poDirectStockMode = true;
    poEditingId = null;
    poAllItems = [];
    poItems = [];
    populatePoVendorSuggestions();
    document.getElementById('poVendorName').value = '';
    document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
    document.getElementById('poDate').value = localDateString();
    switchPoCompany(currentCompany || 'yushin', null, true);
    generateNextPoNumber();
    addDirectPoItem();
    updatePoModeUI();
    document.getElementById('poModalOverlay').classList.add('active');
};

function emptyDirectPoItem() {
    return { orderId:'', itemName:'', itemCode:'', productId:'', brand:'', qty:1, unit:'', unitPrice:0, supplier:'' };
}

window.addDirectPoItem = function() {
    poDirectStockMode = true;
    poItems.push(emptyDirectPoItem());
    poAllItems = poItems;
    renderPoItemsTable();
    updatePoModeUI();
};

window.onDirectPoCodeChange = async function(idx, value) {
    if (!poItems[idx]) return;
    await ensurePriceListLoaded().catch(() => {});
    const match = findPriceItemByCodeValue(value);
    poItems[idx].itemCode = String(value || '').trim();
    if (match) {
        poItems[idx] = {
            ...poItems[idx],
            itemCode: match.model || value,
            itemName: match.nameCn || match.nameEn || '',
            productId: match.productId || stableProductId(match),
            brand: resolveBrandName(match.brand || ''),
            unit: match.unit || '',
            unitPrice: Number(match.cost || 0),
            supplier: match.supplier || ''
        };
        if (!document.getElementById('poVendorName').value && match.supplier) document.getElementById('poVendorName').value = match.supplier;
    }
    poAllItems = poItems;
    renderPoItemsTable();
};

window.updateDirectPoText = function(idx, field, value) {
    if (!poItems[idx]) return;
    poItems[idx][field] = field === 'brand' ? resolveBrandName(value) : String(value || '').trim();
    poAllItems = poItems;
};

function updatePoModeUI() {
    const addBtn = document.getElementById('poAddStockItemBtn');
    const hint = document.getElementById('poModeHint');
    const brandList = document.getElementById('poBrandList');
    if (brandList) brandList.innerHTML = getUnifiedBrandNames(false).map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
    if (addBtn) addBtn.style.display = poDirectStockMode ? '' : 'none';
    if (hint) hint.textContent = poDirectStockMode
        ? '原廠備貨採購：可一次加入多個品項；完成後會正式產生訂購單並列入在途庫存。'
        : '訂單採購：品項來自業務訂單，可調整採購數量與進貨單價。';
}


window.openPurchaseOrderModal = function() {
    poDirectStockMode = false;
    const checked = Array.from(document.querySelectorAll('.order-select-checkbox:checked'));
    if (checked.length === 0) {
        alert('請先在業務訂單左邊勾選要放進訂購單的品項。');
        return;
    }

    const selectedOrders = checked.map(cb => ordersCache.find(x => x.id === cb.dataset.orderId)).filter(Boolean);
    const alreadyAssigned = selectedOrders.filter(order => order.purchaseOrderNo);
    if (alreadyAssigned.length) {
        alert(`有 ${alreadyAssigned.length} 筆訂單已經建立訂購單，請重新整理後再選擇。`);
        renderOrdersList();
        return;
    }
    poEditingId = null;
    populatePoVendorSuggestions();
    poAllItems = selectedOrders.flatMap(purchaseItemsFromOrder);
    if (!poAllItems.length) {
        alert('選取的訂單沒有可辨識的品項，請確認品名、貨號或 items 資料。');
        return;
    }
    poItems = poAllItems;

    document.getElementById('poVendorName').value = '';
    document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
    const today = new Date();
    document.getElementById('poDate').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    // 優先沿用來源訂單公司；舊訂單沒有 company 時，選擇能保留最多品項的公司，
    // 避免目前估價單公司不相符而把全部採購品項靜默過濾掉。
    const initialCompany = bestPurchaseOrderCompany(selectedOrders, poAllItems, currentCompany || 'yushin');
    switchPoCompany(initialCompany);
    if (!poItems.length) {
        alert('品項已讀取，但目前三間公司的代理廠牌設定都不允許這些品項。請先到管理後台調整代理廠牌，或確認訂單廠牌是否正確。');
        return;
    }
    updatePoModeUI();
    document.getElementById('poModalOverlay').classList.add('active');
};

function populatePoVendorSuggestions() {
    const list = document.getElementById('poVendorSuggestions');
    if (!list) return;
    const vendorsByKey = new Map();
    poListCache.forEach(po => {
        const name = String(po.vendorName || '').trim();
        if (!name) return;
        const key = name.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
        if (!vendorsByKey.has(key)) vendorsByKey.set(key, name);
    });
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
            .orderBy('poNo', 'desc')
            .limit(1)
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
        const missingPrice = !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) <= 0;
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
                <td style="border:1px solid #999;padding:4px;">${escapeHtml(item.itemName)}</td>
                <td style="border:1px solid #999;padding:4px;">${escapeHtml(item.itemCode)}</td>
                <td style="border:1px solid #999;padding:4px;">${escapeHtml(item.brand)}</td>
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

window.printPurchaseOrder = async function() {
    if (poSaveInProgress) return;
    if (poItems.length === 0) {
        alert('目前沒有任何品項，請先選取或不要刪光所有品項。');
        return;
    }
    const invalidIdentityItems = poItems.filter(item => !String(item.itemCode||'').trim() || !String(item.itemName||'').trim() || !String(item.brand||'').trim());
    if (invalidIdentityItems.length) {
        alert('請完成每個採購品項的貨號、品名與廠牌。');
        return;
    }
    const missingPriceItems = poItems.filter(item => !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) <= 0);
    if (missingPriceItems.length) {
        alert(`以下品項尚未填入有效的進貨單價：${missingPriceItems.map(item => item.itemName || item.itemCode || '未命名品項').join('、')}`);
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
    const orderIds = [...new Set(poItems.map(item => item.orderId).filter(Boolean))];
    const poNetTotal = poItems.reduce((sum, item) => sum + (Number(item.qty || 0) * Number(item.unitPrice || 0)), 0);
    const poRecord = {
        poNo,
        company: poCurrentCompany,
        vendorName,
        buyerName: document.getElementById('poBuyerName').innerText || currentUserName || '',
        poDate: document.getElementById('poDate').value,
        status: BUSINESS_STATUS.ACTIVE,
        purchaseType: poItems.every(item => !item.orderId) ? 'stock' : 'order',
        items: poItems.map(item => ({ ...item, brand: resolveBrandName(item.brand || '') })),
        ...netAmountMetadata(poNetTotal),
        createdAt: new Date().toISOString(),
        ...linkedDocumentFields(orderIds.length === 1 ? DOCUMENT_TYPES.ORDER : '', orderIds.length === 1 ? orderIds[0] : '', orderIds.map(orderId => documentLink(DOCUMENT_TYPES.ORDER, orderId, 'source')))
    };
    const button = document.getElementById('printPurchaseOrderBtn');
    poSaveInProgress = true;
    if (button) {
        button.disabled = true;
        button.innerText = '檢查並儲存中…';
    }
    try {
        const poDocumentId = poEditingId || poNo;
        let previousPoForIncoming = null;
        await db.runTransaction(async transaction => {
            const poRef = db.collection('purchaseOrders').doc(poDocumentId);
            const orderRefs = orderIds.map(orderId => db.collection('orders').doc(orderId));
            const poSnapshot = await transaction.get(poRef);
            const orderSnapshots = await Promise.all(orderRefs.map(ref => transaction.get(ref)));
            previousPoForIncoming = poSnapshot.exists ? { id: poDocumentId, ...poSnapshot.data() } : null;
            if (poSnapshot.exists && !poEditingId) throw new Error(`訂購單號 ${poNo} 已存在，請關閉視窗後重新產生單號。`);
            const conflicts = orderSnapshots
                .filter(snapshot => snapshot.exists && snapshot.data().purchaseOrderNo && snapshot.data().purchaseOrderNo !== poNo)
                .map(snapshot => snapshot.data().itemName || snapshot.id);
            if (conflicts.length) throw new Error(`以下訂單已被建立訂購單：${conflicts.join('、')}`);
            transaction.set(poRef, poRecord);
            orderSnapshots.forEach((snapshot, index) => {
                if (snapshot.exists) {
                    const orderData = snapshot.data();
                    transaction.update(orderRefs[index], {
                        purchaseOrderNo: poNo,
                        linkedDocuments: normalizeDocumentLinks([...(orderData.linkedDocuments || []), documentLink(DOCUMENT_TYPES.PURCHASE_ORDER, poDocumentId, 'created')])
                    });
                }
            });
        });

        await registerPurchaseIncoming(poDocumentId, poRecord, previousPoForIncoming);

        ordersCache.forEach(order => {
            if (poItems.some(item => item.orderId === order.id)) order.purchaseOrderNo = poNo;
        });
        const savedPo = { id: poEditingId || poNo, ...poRecord };
        const cachedIndex = poListCache.findIndex(po => po.id === savedPo.id);
        if (cachedIndex >= 0) poListCache[cachedIndex] = savedPo;
        else poListCache.unshift(savedPo);
        poEditingId = savedPo.id;
        renderOrdersList();
        renderPoList();

        // 雲端確認沒有重複下單後才開啟列印。
        const originalTitle = document.title;
        document.title = `${poNo}＋${vendorName}`
            .replace(/[\\/:*?"<>|]/g, '_')
            .replace(/[\u0000-\u001F]/g, '')
            .trim();
        document.body.classList.add('printing-po');
        window._poOriginalTitle = originalTitle;
        requestAnimationFrame(() => requestAnimationFrame(() => window.print()));
    } catch (err) {
        console.error('儲存訂購單紀錄失敗：', err);
        alert('無法產生訂購單：' + err.message);
    } finally {
        poSaveInProgress = false;
        if (button) {
            button.disabled = false;
            button.innerText = '🖨️ 產生訂購單／輸出 PDF';
        }
    }
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
    document.body.classList.remove('printing-three-quotes');
    const comparisonPages = document.getElementById('comparisonQuotePrintPages');
    if (comparisonPages) comparisonPages.innerHTML = '';
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
    if (!o || !canEditPage('orders.list')) return;
    const pendingKey = `${orderId}:${field}`;
    if (pendingOrderStatusKeys.has(pendingKey)) return;
    if (normalizedOrderStatus(o) !== 'normal') { alert('已取消的訂單不能更改進度。'); return; }
    const delivery = deliveryProgressInfo(o);
    if (field === 'isOrdered' && !newValue && (o.isArrived || delivery.delivered > 0)) { alert('已有到貨或送貨紀錄，不能直接取消訂貨。'); return; }
    if (field === 'isArrived' && !newValue && delivery.delivered > 0) { alert('已有送貨紀錄，不能直接取消到貨。'); return; }
    let invoiceDate = o.invoiceDate || '';
    if (field === 'isBilled' && newValue) {
        // 某些手機內建瀏覽器不顯示 window.prompt，會讓按鈕看起來完全沒反應。
        // 點擊時直接以今天完成報帳；若實際開票日不同，可立刻在列內日期欄修改。
        invoiceDate = orderInvoiceDate(o) || localDateString();
    }
    if (field === 'isBilled' && !newValue) invoiceDate = '';
    const previousWorkFilter = activeOrderWorkFilter;
    const previous = {
        isOrdered: o.isOrdered, isArrived: o.isArrived, isBilled: o.isBilled,
        invoiceDate: o.invoiceDate || '', orderedBy: o.orderedBy, statusHistory: [...(o.statusHistory || [])]
    };
    const statusLabel = { isOrdered: '已訂貨', isArrived: '已到貨', isDelivered: '已送貨', isBilled: '已報帳' }[field] || field;
    const actor = currentUserName || currentUser?.email || '未知使用者';
    const timestamp = new Date().toISOString();
    const logEntry = { field, value: newValue, label: `${newValue ? statusLabel : `取消${statusLabel}`}`, by: actor, at: timestamp };
    const optimisticEntries = [];
    if (field === 'isArrived' && newValue && !o.isOrdered) {
        o.isOrdered = true;
        o.orderedBy = actor;
        optimisticEntries.push({ field: 'isOrdered', value: true, label: '已訂貨', by: actor, at: timestamp });
    }
    o[field] = newValue;
    if (field === 'isBilled') o.invoiceDate = invoiceDate;
    if (field === 'isBilled' && !newValue && activeOrderWorkFilter === 'complete') activeOrderWorkFilter = 'billing';
    if (field === 'isBilled' && newValue && activeOrderWorkFilter === 'billing') activeOrderWorkFilter = 'complete';
    if (field === 'isOrdered') o.orderedBy = newValue ? actor : '';
    optimisticEntries.push(logEntry);
    o.statusHistory = [...previous.statusHistory, ...optimisticEntries];
    pendingOrderStatusKeys.add(pendingKey);
    renderOrdersList();

    let committed;
    db.runTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        if (normalizedOrderStatus(order) !== 'normal') throw new Error('這筆訂單已取消。');
        const serverDelivery = deliveryProgressInfo(order);
        if (field === 'isOrdered' && !newValue && (order.isArrived || serverDelivery.delivered > 0)) throw new Error('已有到貨或送貨進度，不能取消訂貨。');
        if (field === 'isArrived' && !newValue && serverDelivery.delivered > 0) throw new Error('已有送貨進度，不能取消到貨。');
        const entries = [];
        const updates = { [field]: newValue, updatedAt: timestamp };
        if (field === 'isArrived' && newValue && !order.isOrdered) {
            updates.isOrdered = true;
            updates.orderedBy = order.orderedBy || actor;
            entries.push({ field: 'isOrdered', value: true, label: '已訂貨', by: actor, at: timestamp });
        }
        if (field === 'isBilled') {
            updates.invoiceDate = invoiceDate;
            updates.status = newValue ? BUSINESS_STATUS.COMPLETED : BUSINESS_STATUS.ACTIVE;
        }
        if (field === 'isOrdered') updates.orderedBy = newValue ? actor : '';
        entries.push(logEntry);
        updates.statusHistory = firebase.firestore.FieldValue.arrayUnion(...entries);
        transaction.update(ref, updates);
        committed = {
            isOrdered: updates.isOrdered !== undefined ? updates.isOrdered : order.isOrdered,
            isArrived: updates.isArrived !== undefined ? updates.isArrived : order.isArrived,
            isBilled: updates.isBilled !== undefined ? updates.isBilled : order.isBilled,
            invoiceDate: updates.invoiceDate !== undefined ? updates.invoiceDate : order.invoiceDate,
            orderedBy: updates.orderedBy !== undefined ? updates.orderedBy : order.orderedBy,
            statusHistory: [...(order.statusHistory || []), ...entries]
        };
    }).then(() => {
        Object.assign(o, committed);
        pendingOrderStatusKeys.delete(pendingKey);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    }).catch(err => {
        Object.assign(o, previous);
        pendingOrderStatusKeys.delete(pendingKey);
        activeOrderWorkFilter = previousWorkFilter;
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) {
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        alert('更新狀態失敗，已還原：' + err.message);
    });
};

window.updateOrderInvoiceDate = function(orderId, value) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order || !order.isBilled || !canEditPage('orders.list')) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) { alert('請選擇正確的開發票日期。'); renderOrdersList(); return; }
    const previous = order.invoiceDate || '';
    if (previous === value) return;
    const history = {
        field: 'invoiceDate', label: '修改開票／收款日期', before: previous || orderInvoiceDate(order), after: value,
        by: currentUserName || currentUser?.email || '未知使用者', at: new Date().toISOString()
    };
    order.invoiceDate = value;
    order.fieldEditHistory = [...(order.fieldEditHistory || []), history];
    renderOrdersList();
    db.collection('orders').doc(orderId).update({ invoiceDate: value, updatedAt: history.at, fieldEditHistory: firebase.firestore.FieldValue.arrayUnion(history) }).catch(err => {
        order.invoiceDate = previous;
        order.fieldEditHistory = (order.fieldEditHistory || []).filter(item => item !== history);
        renderOrdersList();
        alert('更新開票日期失敗，已還原：' + err.message);
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
        ['isArrived', '到貨'],
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
    const customerKey = String(customerName || '').trim().toLocaleLowerCase('zh-TW');
    const orders = ordersCache.filter(order => String(order.customerName || '').trim().toLocaleLowerCase('zh-TW') === customerKey)
        .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
    const quoteMap = new Map();
    [...myQuotesCache, ...allQuotesCache].forEach(quote => {
        const names = [quote.ordererName, quote.clientName].map(value => String(value || '').trim().toLocaleLowerCase('zh-TW'));
        if (names.includes(customerKey)) quoteMap.set(quote.id || quote.quoteNo, quote);
    });
    const quotes = [...quoteMap.values()].sort((a, b) => String(b.quoteDate || b.quoteNo || '').localeCompare(String(a.quoteDate || a.quoteNo || '')));
    const quoteItems = quotes.flatMap(quote => (quote.items || []).map(item => ({ quote, item })))
        .sort((a, b) => String(b.quote.quoteDate || b.quote.quoteNo || '').localeCompare(String(a.quote.quoteDate || a.quote.quoteNo || '')));
    const recentDates = [...orders.map(order => order.orderDate), ...quotes.map(quote => quote.quoteDate)].filter(Boolean).sort().reverse();
    const latestOrder = orders[0];
    const latestQuoteItem = quoteItems[0];
    const latestPrice = latestOrder
        ? `NT$ ${Number(parseFloat(String(latestOrder.unitPrice ?? '').replace(/,/g, '')) || 0).toLocaleString()}`
        : latestQuoteItem ? `NT$ ${Number(parseFloat(String(latestQuoteItem.item.price ?? '').replace(/,/g, '')) || 0).toLocaleString()}` : '－';
    const latestProduct = latestOrder?.itemName || latestQuoteItem?.item?.nameCn || latestQuoteItem?.item?.nameEn || '－';
    document.getElementById('customerOrderHistoryTitle').innerText = `客戶近期交易摘要：${customerName}`;
    document.getElementById('customerTransactionSummary').innerHTML = `
        <div class="customer-summary-card"><span>最近交易日</span><strong>${escapeHtml(recentDates[0] || '－')}</strong></div>
        <div class="customer-summary-card"><span>最近購買／估價品項</span><strong>${escapeHtml(latestProduct)}</strong></div>
        <div class="customer-summary-card"><span>上次單價</span><strong>${escapeHtml(latestPrice)}</strong></div>
        <div class="customer-summary-card"><span>最近估價</span><strong>${escapeHtml(quotes[0] ? `${quotes[0].quoteNo || '－'}／${quotes[0].quoteDate || '－'}` : '－')}</strong></div>`;
    const tbody = document.getElementById('customerOrderHistoryBody');
    tbody.innerHTML = orders.length ? orders.slice(0, 20).map(order => `
        <tr><td>${escapeHtml(order.orderDate || '')}</td><td>${escapeHtml(order.brand || '')}</td><td>${escapeHtml(order.itemCode || '')}</td><td>${escapeHtml(order.itemName || '')}</td><td>${escapeHtml(String(order.qty || ''))}</td><td>${escapeHtml(String(order.totalPrice || ''))}</td><td>${order.isDelivered ? '已送貨' : order.isArrived ? '已到貨' : order.isOrdered ? '已訂貨' : '未訂貨'}</td></tr>
    `).join('') : '<tr><td colspan="7" style="color:#888;">目前沒有採購紀錄。</td></tr>';
    const quoteTbody = document.getElementById('customerQuoteHistoryBody');
    quoteTbody.innerHTML = quoteItems.length ? quoteItems.slice(0, 20).map(({ quote, item }) => `
        <tr><td>${escapeHtml(quote.quoteDate || '')}</td><td>${escapeHtml(quote.quoteNo || '')}</td><td>${escapeHtml(item.nameCn || item.nameEn || item.model || '')}</td><td>${escapeHtml(String(item.qty || ''))}</td><td>${escapeHtml(String(item.price || ''))}</td><td>${quote.dealClosed ? '已成交' : '估價中'}</td></tr>
    `).join('') : '<tr><td colspan="6" style="color:#888;">目前已載入資料中沒有相符估價紀錄。</td></tr>';
    document.getElementById('customerOrderHistoryOverlay').classList.add('active');
};

window.closeCustomerOrderHistory = function() {
    document.getElementById('customerOrderHistoryOverlay').classList.remove('active');
};

function deliveryRecordId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function deliveryActor() {
    return currentUserName || currentUser?.email || '未知使用者';
}

function localDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function normalizeBusinessDate(value) {
    if (!value) return '';
    const raw = String(value).trim().replace(/\//g, '-');
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return dateOnlyFromTimestamp(value);
}

function unifiedPeriodRange(key = 'this-year') {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (key === 'all') return { start: '', end: '' };
    if (key === 'this-month') return { start: fmt(new Date(y, m, 1)), end: fmt(new Date(y, m + 1, 0)) };
    if (key === 'last-month') return { start: fmt(new Date(y, m - 1, 1)), end: fmt(new Date(y, m, 0)) };
    if (key === 'this-quarter') {
        const qStart = Math.floor(m / 3) * 3;
        return { start: fmt(new Date(y, qStart, 1)), end: fmt(new Date(y, qStart + 3, 0)) };
    }
    if (key === 'last-year') return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    return { start: `${y}-01-01`, end: `${y}-12-31` };
}

function dateInUnifiedPeriod(value, key = 'this-year') {
    const date = normalizeBusinessDate(value);
    const { start, end } = unifiedPeriodRange(key);
    if (!start && !end) return true;
    return !!date && (!start || date >= start) && (!end || date <= end);
}

window.openDeliveryModal = function(orderId) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order) return;
    currentDeliveryOrderId = orderId;
    currentLifecycleOrderId = orderId;
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryModalTitle').innerText = `訂單進度：${order.customerName || order.itemName || '訂單'}`;
    document.getElementById('orderLifecycleStatus').value = normalizedOrderStatus(order);
    document.getElementById('orderLifecycleDate').value = order.orderStatusDate || localDateString();
    document.getElementById('orderLifecycleReason').value = order.orderStatusReason || '';
    resetDeliveryForm();
    resetReturnForm();
    renderDeliveryModal();
    renderOrderLifecycleModal();
    document.getElementById('deliveryModalOverlay').classList.add('active');
};

window.closeDeliveryModal = function() {
    currentDeliveryOrderId = null;
    currentLifecycleOrderId = null;
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryModalOverlay').classList.remove('active');
};

window.prepareOrderLifecycle = function(orderId, status) {
    openDeliveryModal(orderId);
    document.getElementById('orderLifecycleStatus').value = status;
    document.getElementById('orderLifecycleDate').value = localDateString();
    document.getElementById('orderLifecycleReason').value = '';
    onOrderLifecycleStatusChange();
    document.getElementById('orderStatusEditPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('orderLifecycleReason').focus();
};

async function adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor) {
    const invRef = inventoryRefFor(order);
    const currentlyReserved = Math.max(0, Number(order.inventoryReservedQty || 0) - deliveredQuantity(order));

    if (nextStatus === 'cancelled') {
        if (invRef) {
            const snap = await transaction.get(invRef);
            if (snap.exists) {
                const stock = inventoryNumbers(snap.data());
                const release = Math.min(currentlyReserved, stock.reserved);
                if (release > 0) {
                    transaction.update(invRef, { reserved: Math.max(0, stock.reserved - release), updatedAt: new Date().toISOString() });
                    transaction.set(db.collection('inventoryMovements').doc(), inventoryMovementRecord('release', -release, orderId, inventoryProductKey(order), actor, { reason: 'order_cancelled' }));
                }
            }
        }
        transaction.update(db.collection('orders').doc(orderId), {
            inventoryReservedQty: deliveredQuantity(order),
            inventoryShortageQty: 0
        });
        transaction.set(reservationDocRef(orderId), inventoryReservationPayload(orderId, order, 0, 'released'), { merge: true });
        return;
    }

    if (nextStatus === 'normal') {
        const needed = Math.max(0, orderQuantity(order) - deliveredQuantity(order));
        if (!invRef) {
            transaction.update(db.collection('orders').doc(orderId), {
                inventoryReservedQty: deliveredQuantity(order),
                inventoryShortageQty: needed
            });
            transaction.set(reservationDocRef(orderId), inventoryReservationPayload(orderId, order, 0, needed > 0 ? 'shortage' : 'released'), { merge: true });
            return;
        }

        const snap = await transaction.get(invRef);
        if (!snap.exists) {
            transaction.update(db.collection('orders').doc(orderId), {
                inventoryReservedQty: deliveredQuantity(order),
                inventoryShortageQty: needed
            });
            transaction.set(reservationDocRef(orderId), inventoryReservationPayload(orderId, order, 0, needed > 0 ? 'shortage' : 'released'), { merge: true });
            return;
        }

        const stock = inventoryNumbers(snap.data());
        const reserve = Math.min(needed, Math.max(0, stock.available));
        transaction.update(invRef, { reserved: stock.reserved + reserve, updatedAt: new Date().toISOString() });
        if (reserve) transaction.set(db.collection('inventoryMovements').doc(), inventoryMovementRecord('reserve', reserve, orderId, inventoryProductKey(order), actor, { reason: 'order_restored' }));
        transaction.update(db.collection('orders').doc(orderId), {
            inventoryReservedQty: deliveredQuantity(order) + reserve,
            inventoryShortageQty: Math.max(0, needed - reserve)
        });
        transaction.set(reservationDocRef(orderId), inventoryReservationPayload(orderId, order, reserve, reserve > 0 ? 'active' : (needed > 0 ? 'shortage' : 'released')), { merge: true });
    }
}

window.quickSetOrderLifecycle = async function(orderId, nextStatus) {
    if (!canEditPage('orders.list')) { alert('您目前只有查看權限。'); return; }
    if (!['normal', 'cancelled'].includes(nextStatus)) return;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder) return;
    if (pendingLifecycleOrderIds.has(orderId) || normalizedOrderStatus(cachedOrder) === nextStatus) return;
    const optimisticBefore = {
        orderStatus: cachedOrder.orderStatus,
        orderStatusDate: cachedOrder.orderStatusDate,
        orderStatusReason: cachedOrder.orderStatusReason,
        orderLifecycleHistory: [...(cachedOrder.orderLifecycleHistory || [])]
    };
    const optimisticDate = localDateString();
    const optimisticHistory = {
        action: nextStatus === 'normal' ? 'restore' : 'status_change',
        before: { status: normalizedOrderStatus(cachedOrder), date: cachedOrder.orderStatusDate || '', reason: cachedOrder.orderStatusReason || '' },
        after: { status: nextStatus, date: optimisticDate, reason: '' },
        by: deliveryActor(),
        at: new Date().toISOString()
    };
    cachedOrder.orderStatus = nextStatus;
    cachedOrder.orderStatusDate = optimisticDate;
    cachedOrder.orderStatusReason = '';
    cachedOrder.orderLifecycleHistory = [...optimisticBefore.orderLifecycleHistory, optimisticHistory];
    pendingLifecycleOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
            if (previous.status === nextStatus) { savedOrder = order; return; }
            const date = localDateString();
            const actor = deliveryActor();
            const history = {
                action: nextStatus === 'normal' ? 'restore' : 'status_change',
                before: previous,
                after: { status: nextStatus, date, reason: '' },
                by: actor,
                at: new Date().toISOString()
            };
            await adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor);
            const updates = {
                status: nextStatus === 'cancelled' ? BUSINESS_STATUS.CANCELLED : BUSINESS_STATUS.ACTIVE,
                orderStatus: nextStatus,
                orderStatusDate: date,
                orderStatusReason: '',
                updatedAt: history.at,
                orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(history)
            };
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, orderLifecycleHistory: [...(order.orderLifecycleHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        pendingLifecycleOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    } catch (err) {
        Object.assign(cachedOrder, optimisticBefore);
        pendingLifecycleOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert(`${nextStatus === 'normal' ? '恢復' : '取消'}訂單失敗：` + err.message);
    }
};

window.toggleOrderProgressStatus = function(field, newValue) {
    const orderId = currentDeliveryOrderId;
    if (!orderId || !canEditPage('orders.list')) return;
    toggleOrderStatus(orderId, field, newValue);
    renderDeliveryModal();
};

window.resetDeliveryForm = function() {
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryEditId').value = '';
    document.getElementById('deliveryDate').value = localDateString();
    document.getElementById('deliveryQty').value = '';
    document.getElementById('deliveryNotes').value = '';
    document.getElementById('deliveryFormTitle').innerText = '新增送貨紀錄';
    document.getElementById('deliveryCancelEditBtn').style.display = 'none';
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    const progress = deliveryProgressInfo(order || {});
    document.getElementById('deliveryFormHint').innerText = `目前最多還可登錄 ${progress.remaining} 個。`;
};

window.openPartialDeliveryForm = function() {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order || !canEditPage('orders.list')) return;
    if (normalizedOrderStatus(order) !== 'normal') { alert('已取消的訂單不能新增送貨紀錄。'); return; }
    const progress = deliveryProgressInfo(order);
    if (progress.remaining <= 0) { alert('這筆訂單已全數送貨。'); return; }
    deliveryPartialFormOpen = true;
    document.getElementById('deliveryFormPanel').style.display = '';
    document.getElementById('deliveryQty').value = '';
    document.getElementById('deliveryDate').focus();
};

window.openPartialDeliveryForOrder = function(orderId) {
    openDeliveryModal(orderId);
    openPartialDeliveryForm();
};

window.openReturnManagement = function(orderId) {
    openDeliveryModal(orderId);
    const form = document.getElementById('returnFormPanel');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('returnDate').focus();
};

window.openOrderStatusHistory = function(orderId) {
    openDeliveryModal(orderId);
    document.getElementById('orderStatusHistorySection').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function renderOrderStatusHistory(order) {
    const tbody = document.getElementById('orderStatusHistoryBody');
    if (!tbody) return;
    const orderedBy = document.getElementById('orderStatusOrderedBy');
    if (orderedBy) orderedBy.innerText = `訂購人：${order.orderedBy || '－'}`;
    const entries = [];
    (order.statusHistory || []).forEach(item => entries.push({ at: item.at, action: item.label || '進度變更', by: item.by, detail: '' }));
    (order.deliveryHistory || []).forEach(item => {
        const action = { create: '新增送貨', edit: '修改送貨', delete: '刪除送貨', cancel_all: '取消全部送貨', clear_legacy_estimate: '取消歷史推估' }[item.action] || '送貨異動';
        const record = item.after || item.before || {};
        const detail = record.qty != null ? `${record.date || ''}／${record.qty} 個${record.notes ? `／${record.notes}` : ''}` : '';
        entries.push({ at: item.at, action, by: item.by, detail });
    });
    (order.returnHistory || []).forEach(item => {
        const action = { create: '新增退貨', edit: '修改退貨', delete: '刪除退貨' }[item.action] || '退貨異動';
        const record = item.after || item.before || {};
        entries.push({ at: item.at, action, by: item.by, detail: `${record.date || ''}${record.qty != null ? `／${record.qty} 個` : ''}${record.reason ? `／${record.reason}` : ''}` });
    });
    (order.orderLifecycleHistory || []).forEach(item => {
        const statusLabels = { normal: '恢復正常', cancelled: '取消訂單', voided: '取消訂單' };
        const after = item.after || {};
        entries.push({ at: item.at, action: statusLabels[after.status] || '訂單狀態變更', by: item.by, detail: `${after.date || ''}${after.reason ? `／${after.reason}` : ''}` });
    });
    (order.fieldEditHistory || []).forEach(item => entries.push({ at: item.at, action: item.label || '修改資料', by: item.by, detail: `${item.before ?? '－'} → ${item.after ?? '－'}` }));
    const statusFields = [
        ['isOrdered', '訂貨'], ['isArrived', '到貨'], ['isBilled', '報帳']
    ];
    statusFields.forEach(([field, label]) => {
        const hasRecord = (order.statusHistory || []).some(item => item.field === field);
        if (order[field] && !hasRecord) entries.push({ at: order.orderDate || '', action: `${label}（歷史推估）`, by: '舊資料未記錄', detail: '依目前訂單狀態推估，日期暫用訂單日期' });
    });
    if (order.isDelivered && !savedDeliveryRecords(order).length && !(order.deliveryHistory || []).length) {
        entries.push({ at: order.orderDate || '', action: '送貨（歷史推估）', by: '舊資料未記錄', detail: '依目前訂單狀態推估，日期暫用訂單日期' });
    }
    entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    tbody.innerHTML = entries.length ? entries.map(item => `<tr><td>${escapeHtml(formatOrderStatusTime(item.at))}</td><td>${escapeHtml(item.action || '')}</td><td>${escapeHtml(item.by || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`).join('') : '<tr><td colspan="4" style="color:#888;">尚無操作紀錄。</td></tr>';
}

function applyInventoryDeliveryInTransaction(transaction, orderRef, order, deliveryQty, actor, sourceId) {
    const invRef = inventoryRefFor(order);
    if (!invRef || deliveryQty <= 0) return Promise.resolve(null);
    return transaction.get(invRef).then(invSnap => {
        const stock = inventoryNumbers(invSnap.exists ? invSnap.data() : {});
        const reservedForOrder = Number(order.inventoryReservedQty || 0);
        const alreadyDelivered = deliveredQuantity(order);
        const reservedRemaining = Math.max(0, reservedForOrder - alreadyDelivered);
        const fromReserved = Math.min(deliveryQty, reservedRemaining);
        if (stock.onHand < deliveryQty) throw new Error(`庫存不足：現有 ${stock.onHand}，本次需出貨 ${deliveryQty}。`);
        transaction.set(invRef, { onHand: stock.onHand - deliveryQty, reserved: Math.max(0, stock.reserved - fromReserved), incoming: stock.incoming, updatedAt: new Date().toISOString() }, { merge: true });
        const movement = db.collection('inventoryMovements').doc();
        transaction.set(movement, inventoryMovementRecord('ship', -deliveryQty, sourceId, inventoryProductKey(order), actor, { reservedReleasedQty: fromReserved }));
        return { fromReserved };
    });
}

window.quickCompleteDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canEditPage('orders.list')) return;
    const cachedProgress = deliveryProgressInfo(cachedOrder);
    if (normalizedOrderStatus(cachedOrder) !== 'normal') { alert('已取消的訂單不能送貨。'); return; }
    if (cachedProgress.state === 'complete') return quickCancelAllDelivery(orderId);
    if (cachedProgress.remaining <= 0) return;
    const today = localDateString();
    const optimisticBefore = {
        deliveryRecords: savedDeliveryRecords(cachedOrder).slice(), deliveredQty: cachedOrder.deliveredQty,
        isDelivered: cachedOrder.isDelivered, isOrdered: cachedOrder.isOrdered, isArrived: cachedOrder.isArrived,
        orderedBy: cachedOrder.orderedBy, statusHistory: [...(cachedOrder.statusHistory || [])]
    };
    const optimisticActor = deliveryActor();
    const optimisticAt = new Date().toISOString();
    cachedOrder.deliveryRecords = [...optimisticBefore.deliveryRecords, { id: `pending-${Date.now()}`, date: today, qty: cachedProgress.remaining, notes: '一鍵完成剩餘送貨', createdBy: optimisticActor, createdAt: optimisticAt }];
    cachedOrder.deliveredQty = cachedProgress.total;
    cachedOrder.isDelivered = true;
    cachedOrder.isOrdered = true;
    cachedOrder.isArrived = true;
    cachedOrder.orderedBy = cachedOrder.orderedBy || optimisticActor;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            if (normalizedOrderStatus(order) !== 'normal') throw new Error('這筆訂單已取消。');
            if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('這筆舊資料已視為全數送貨。');
            const total = orderQuantity(order);
            const records = savedDeliveryRecords(order).slice();
            const alreadyDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const remaining = Math.max(0, total - alreadyDelivered);
            if (!total || remaining <= 0) throw new Error('這筆訂單已無尚未送貨數量。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const record = { id: deliveryRecordId(), date: today, qty: remaining, notes: '一鍵完成剩餘送貨', createdBy: actor, createdAt: now };
            records.push(record);
            const history = { action: 'create', source: 'quick_complete', recordId: record.id, before: null, after: record, by: actor, at: now };
            const statusEntries = [];
            if (!order.isOrdered) statusEntries.push({ field: 'isOrdered', value: true, label: '已訂貨', by: actor, at: now });
            if (!order.isArrived) statusEntries.push({ field: 'isArrived', value: true, label: '已到貨', by: actor, at: now });
            await applyInventoryDeliveryInTransaction(transaction, ref, order, remaining, actor, orderId);
            const updates = {
                deliveryRecords: records, deliveredQty: total, isDelivered: true,
                isOrdered: true, isArrived: true,
                orderedBy: order.orderedBy || actor,
                deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history)
            };
            if (statusEntries.length) updates.statusHistory = firebase.firestore.FieldValue.arrayUnion(...statusEntries);
            transaction.update(ref, updates);
            savedOrder = {
                ...order, ...updates,
                deliveryHistory: [...(order.deliveryHistory || []), history],
                statusHistory: [...(order.statusHistory || []), ...statusEntries]
            };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        pendingDeliveryOrderIds.delete(orderId);
        if (currentDeliveryOrderId === orderId) {
            resetDeliveryForm();
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        renderOrdersList();
    } catch (err) {
        cachedOrder.deliveryRecords = optimisticBefore.deliveryRecords;
        cachedOrder.deliveredQty = optimisticBefore.deliveredQty;
        cachedOrder.isDelivered = optimisticBefore.isDelivered;
        cachedOrder.isOrdered = optimisticBefore.isOrdered;
        cachedOrder.isArrived = optimisticBefore.isArrived;
        cachedOrder.orderedBy = optimisticBefore.orderedBy;
        cachedOrder.statusHistory = optimisticBefore.statusHistory;
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert('一鍵送貨失敗：' + err.message);
    }
};

window.quickCancelAllDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canEditPage('orders.list')) return;
    if (returnedQuantity(cachedOrder) > 0) { alert('這筆訂單已有退貨紀錄，請先從 ⋯ 中更正或刪除退貨紀錄。'); return; }
    const optimisticBefore = { deliveryRecords: savedDeliveryRecords(cachedOrder).slice(), deliveredQty: cachedOrder.deliveredQty, isDelivered: cachedOrder.isDelivered };
    cachedOrder.deliveryRecords = [];
    cachedOrder.deliveredQty = 0;
    cachedOrder.isDelivered = false;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            if (returnedQuantity(order) > 0) throw new Error('這筆訂單已有退貨紀錄，請先更正退貨紀錄。');
            const progress = deliveryProgressInfo(order);
            if (progress.state !== 'complete') throw new Error('這筆訂單目前不是全數已送貨狀態。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const before = savedDeliveryRecords(order).length
                ? { records: savedDeliveryRecords(order), deliveredQty: progress.delivered }
                : { legacyEstimated: true, estimatedDate: order.orderDate || '', deliveredQty: progress.delivered };
            const history = { action: 'cancel_all', source: 'quick_toggle', before, after: { records: [], deliveredQty: 0 }, by: actor, at: now };
            const updates = { deliveryRecords: [], deliveredQty: 0, isDelivered: false, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        pendingDeliveryOrderIds.delete(orderId);
        if (currentDeliveryOrderId === orderId) {
            resetDeliveryForm();
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        renderOrdersList();
    } catch (err) {
        cachedOrder.deliveryRecords = optimisticBefore.deliveryRecords;
        cachedOrder.deliveredQty = optimisticBefore.deliveredQty;
        cachedOrder.isDelivered = optimisticBefore.isDelivered;
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert('取消已送貨失敗：' + err.message);
    }
};

function renderDeliveryModal() {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order) return;
    const editable = canEditPage('orders.list');
    const isEditing = !!document.getElementById('deliveryEditId').value;
    document.getElementById('deliveryFormPanel').style.display = editable && (normalizedOrderStatus(order) === 'normal' || isEditing) && (deliveryPartialFormOpen || isEditing) ? '' : 'none';
    const progress = deliveryProgressInfo(order);
    const lifecycle = orderLifecycleInfo(order);
    const locked = lifecycle.status !== 'normal';
    const syncing = pendingDeliveryOrderIds.has(order.id);
    const editableSteps = editable && !locked && !syncing;
    document.getElementById('orderWorkflowSteps').innerHTML = `
        <button type="button" class="workflow-step ${order.isOrdered ? 'done' : ''}" ${editableSteps ? `onclick="toggleOrderProgressStatus('isOrdered', ${!order.isOrdered})"` : 'disabled'}><span>1</span>訂貨 ${order.isOrdered ? '✓' : ''}</button>
        <button type="button" class="workflow-step ${order.isArrived ? 'done' : ''}" ${editableSteps ? `onclick="toggleOrderProgressStatus('isArrived', ${!order.isArrived})"` : 'disabled'}><span>2</span>到貨 ${order.isArrived ? '✓' : ''}</button>
        <button type="button" class="workflow-step ${progress.state === 'complete' ? 'done' : progress.state === 'partial' ? 'partial' : ''}" ${editableSteps && progress.remaining > 0 ? 'onclick="quickCompleteDelivery()"' : 'disabled'}><span>3</span>${progress.state === 'partial' ? `送貨 ${progress.delivered}/${progress.total}` : '送貨'} ${progress.state === 'complete' ? '✓' : ''}</button>
        <button type="button" class="workflow-step ${order.isBilled ? 'done' : ''}" ${editableSteps ? `onclick="toggleOrderProgressStatus('isBilled', ${!order.isBilled})"` : 'disabled'}><span>4</span>報帳 ${order.isBilled ? '✓' : ''}</button>`;
    document.getElementById('deliveryOrderSummary').innerHTML = `
        <strong>${escapeHtml(order.itemName || '未命名品項')}</strong>（${escapeHtml(order.itemCode || '無貨號')}）<br>
        訂購數量：${progress.total}　累計已送：${progress.delivered}　尚未送貨：${progress.remaining}
        ${progress.isLegacyEstimated ? '<br><span class="delivery-estimated">這是舊版「已送貨」資料，日期暫以訂單日期推估。</span>' : ''}`;
    renderOrderStatusHistory(order);

    const tbody = document.getElementById('deliveryRecordsBody');
    const partialButton = document.getElementById('openPartialDeliveryBtn');
    if (partialButton) partialButton.style.display = editable && !locked && progress.remaining > 0 ? '' : 'none';
    const records = savedDeliveryRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (records.length) {
        tbody.innerHTML = records.map(record => `<tr>
            <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td>
            <td>${escapeHtml(record.notes || '')}</td>
            <td>${escapeHtml(record.createdBy || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(record.createdAt))}</span></td>
            <td>${editable ? `<button type="button" class="btn-small" onclick="editDeliveryRecord('${escapeAttr(record.id)}')">編輯</button> <button type="button" class="btn-danger" onclick="deleteDeliveryRecord('${escapeAttr(record.id)}')">刪除</button>` : '僅可查看'}</td>
        </tr>`).join('');
    } else if (progress.isLegacyEstimated) {
        tbody.innerHTML = `<tr><td>${escapeHtml(order.orderDate || '')}<br><span class="delivery-estimated">歷史推估</span></td><td>${progress.total}</td><td>舊版已送貨資料</td><td>－</td><td>${editable ? '<button type="button" class="btn-danger" onclick="clearLegacyDelivery()">取消此推估</button>' : '僅可查看'}</td></tr>`;
    } else {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#888;">尚無送貨紀錄。</td></tr>';
    }
    document.getElementById('deliveryFormHint').innerText = progress.isLegacyEstimated
        ? '請先取消舊資料推估，再登錄正確的分批送貨紀錄。'
        : `目前最多還可登錄 ${progress.remaining} 個。`;
}

window.editDeliveryRecord = function(recordId) {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    const record = savedDeliveryRecords(order).find(item => item.id === recordId);
    if (!record) return;
    document.getElementById('deliveryEditId').value = record.id;
    document.getElementById('deliveryDate').value = record.date || localDateString();
    document.getElementById('deliveryQty').value = record.qty;
    document.getElementById('deliveryNotes').value = record.notes || '';
    document.getElementById('deliveryFormTitle').innerText = '編輯送貨紀錄';
    document.getElementById('deliveryCancelEditBtn').style.display = '';
    document.getElementById('deliveryFormPanel').style.display = '';
    const otherQty = savedDeliveryRecords(order).filter(item => item.id !== recordId).reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
    document.getElementById('deliveryFormHint').innerText = `此筆最多可改為 ${Math.max(0, orderQuantity(order) - otherQty)} 個。`;
};

window.saveDeliveryRecord = async function() {
    if (!canEditPage('orders.list')) { alert('您目前只有查看權限。'); return; }
    const orderId = currentDeliveryOrderId;
    const date = document.getElementById('deliveryDate').value;
    const qty = parseFloat(document.getElementById('deliveryQty').value);
    const notes = document.getElementById('deliveryNotes').value.trim();
    const editId = document.getElementById('deliveryEditId').value;
    if (!orderId || !date || !Number.isFinite(qty) || qty <= 0) {
        alert('請填寫送貨日期與大於 0 的送貨數量。');
        return;
    }
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('請先取消舊資料的歷史推估送貨紀錄。');
            const records = savedDeliveryRecords(order).slice();
            const existingIndex = records.findIndex(item => item.id === editId);
            if (editId && existingIndex < 0) throw new Error('這筆送貨紀錄已被其他人修改或刪除，請重新開啟後再試。');
            if (normalizedOrderStatus(order) !== 'normal' && existingIndex < 0) throw new Error('已取消的訂單不能新增送貨紀錄。');
            const now = new Date().toISOString();
            const actor = deliveryActor();
            const previous = existingIndex >= 0 ? records[existingIndex] : null;
            const record = previous
                ? { ...previous, date, qty, notes, updatedBy: actor, updatedAt: now }
                : { id: deliveryRecordId(), date, qty, notes, createdBy: actor, createdAt: now };
            if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
            const totalDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const total = orderQuantity(order);
            if (!total) throw new Error('訂購數量必須大於 0，才能登錄送貨。');
            if (totalDelivered > total + 1e-9) throw new Error(`累計送貨數量 ${totalDelivered} 超過訂購數量 ${total}。`);
            const alreadyReturned = returnedQuantity(order);
            if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`累計送貨數量不能低於已登錄的退貨數量 ${alreadyReturned}。`);
            const history = { action: previous ? 'edit' : 'create', recordId: record.id, before: previous, after: record, by: actor, at: now };
            const updates = { deliveryRecords: records, deliveredQty: totalDelivered, isDelivered: totalDelivered >= total, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            if (action === 'create') await applyInventoryDeliveryInTransaction(transaction, ref, order, qty, actor, orderId);
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('送貨紀錄儲存失敗：' + err.message);
    }
};

window.deleteDeliveryRecord = async function(recordId) {
    if (!canEditPage('orders.list')) { alert('您目前只有查看權限。'); return; }
    if (!confirm('確定要刪除這筆送貨紀錄嗎？異動軌跡仍會保留。')) return;
    const orderId = currentDeliveryOrderId;
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const records = savedDeliveryRecords(order);
            const removed = records.find(item => item.id === recordId);
            if (!removed) throw new Error('找不到這筆送貨紀錄。');
            const next = records.filter(item => item.id !== recordId);
            const totalDelivered = next.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const alreadyReturned = returnedQuantity(order);
            if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`刪除後的送貨數量會低於已登錄的退貨數量 ${alreadyReturned}，請先更正退貨紀錄。`);
            const history = { action: 'delete', recordId, before: removed, after: null, by: deliveryActor(), at: new Date().toISOString() };
            const updates = { deliveryRecords: next, deliveredQty: totalDelivered, isDelivered: totalDelivered >= orderQuantity(order) && orderQuantity(order) > 0, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('刪除失敗：' + err.message);
    }
};

window.clearLegacyDelivery = async function() {
    if (!canEditPage('orders.list')) { alert('您目前只有查看權限。'); return; }
    if (!confirm('確定取消這筆舊資料的「已送貨」推估嗎？取消後請重新登錄正確送貨日期與數量。')) return;
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order) return;
    if (returnedQuantity(order) > 0) { alert('這筆訂單已有退貨紀錄，請先更正或刪除退貨紀錄。'); return; }
    const history = { action: 'clear_legacy_estimate', before: { isDelivered: true, estimatedDate: order.orderDate || '' }, after: null, by: deliveryActor(), at: new Date().toISOString() };
    try {
        await db.collection('orders').doc(order.id).update({ isDelivered: false, deliveredQty: 0, deliveryRecords: [], deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now });
        order.isDelivered = false;
        order.deliveredQty = 0;
        order.deliveryRecords = [];
        order.deliveryHistory = [...(order.deliveryHistory || []), history];
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('取消歷史推估失敗：' + err.message);
    }
};

function lifecycleRecordId() {
    return deliveryRecordId();
}

window.openOrderLifecycleModal = function(orderId) {
    openDeliveryModal(orderId);
};

window.closeOrderLifecycleModal = function() {
    closeDeliveryModal();
};

window.onOrderLifecycleStatusChange = function() {
    const status = document.getElementById('orderLifecycleStatus').value;
    document.getElementById('orderLifecycleReason').placeholder = status === 'normal' ? '恢復說明（選填）' : '取消原因（選填）';
};

window.resetReturnForm = function() {
    document.getElementById('returnEditId').value = '';
    document.getElementById('returnDate').value = localDateString();
    document.getElementById('returnQty').value = '';
    document.getElementById('returnReason').value = '';
    document.getElementById('returnFormTitle').innerText = '新增退貨紀錄';
    document.getElementById('returnCancelEditBtn').style.display = 'none';
};

function renderOrderLifecycleModal() {
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    if (!order) return;
    const editable = canEditPage('orders.list');
    const info = orderLifecycleInfo(order);
    document.getElementById('orderStatusEditPanel').style.display = editable ? '' : 'none';
    const isEditingReturn = !!document.getElementById('returnEditId').value;
    document.getElementById('returnFormPanel').style.display = editable && (info.status === 'normal' || isEditingReturn) ? '' : 'none';
    document.getElementById('orderLifecycleSummary').innerHTML = `
        <strong>${escapeHtml(order.itemName || '未命名品項')}</strong>（${escapeHtml(order.itemCode || '無貨號')}）<br>
        目前狀態：<span class="order-validity-badge order-validity-${info.css}">${info.label}</span>　
        累計已送：${info.delivered}　累計退貨：${info.returned}　有效送貨數量：${info.effectiveDelivered}`;
    const records = savedReturnRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const tbody = document.getElementById('returnRecordsBody');
    tbody.innerHTML = records.length ? records.map(record => `<tr>
        <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td><td>${escapeHtml(record.reason || '')}</td>
        <td>${escapeHtml(record.createdBy || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(record.createdAt))}</span></td>
        <td>${editable ? `<button type="button" class="btn-small" onclick="editReturnRecord('${escapeAttr(record.id)}')">編輯</button> <button type="button" class="btn-danger" onclick="deleteReturnRecord('${escapeAttr(record.id)}')">刪除</button>` : '僅可查看'}</td>
    </tr>`).join('') : '<tr><td colspan="5" style="color:#888;">尚無退貨紀錄。</td></tr>';
    document.getElementById('returnFormHint').innerText = `目前最多還可登錄 ${Math.max(0, info.delivered - info.returned)} 個退貨。`;
    onOrderLifecycleStatusChange();
}

window.saveOrderLifecycleStatus = async function() {
    if (!canEditPage('orders.list')) { alert('您目前只有查看權限。'); return; }
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    if (!order) return;
    const nextStatus = document.getElementById('orderLifecycleStatus').value;
    const date = document.getElementById('orderLifecycleDate').value;
    const reason = document.getElementById('orderLifecycleReason').value.trim();
    if (!date) { alert('請填寫狀態日期。'); return; }
    const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
    if (previous.status === nextStatus && previous.date === date && previous.reason === reason) return;
    if (pendingLifecycleOrderIds.has(order.id)) return;
    const actor = deliveryActor();
    const at = new Date().toISOString();
    const history = { action: nextStatus === 'normal' && previous.status !== 'normal' ? 'restore' : 'status_change', before: previous, after: { status: nextStatus, date, reason }, by: actor, at };
    const updates = { orderStatus: nextStatus, orderStatusDate: date, orderStatusReason: reason, orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(history) };
    const saveButton = document.getElementById('orderLifecycleSaveBtn');
    pendingLifecycleOrderIds.add(order.id);
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    try {
        await db.collection('orders').doc(order.id).update(updates);
        order.orderStatus = nextStatus;
        order.orderStatusDate = date;
        order.orderStatusReason = reason;
        order.orderLifecycleHistory = [...(order.orderLifecycleHistory || []), history];
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('訂單狀態儲存失敗：' + err.message);
    } finally {
        pendingLifecycleOrderIds.delete(order.id);
        if (saveButton) { saveButton.disabled = false; saveButton.innerText = '💾 儲存狀態'; }
    }
};

window.editReturnRecord = function(recordId) {
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    const record = savedReturnRecords(order).find(item => item.id === recordId);
    if (!record) return;
    document.getElementById('returnEditId').value = record.id;
    document.getElementById('returnDate').value = record.date || localDateString();
    document.getElementById('returnQty').value = record.qty;
    document.getElementById('returnReason').value = record.reason || '';
    document.getElementById('returnFormTitle').innerText = '編輯退貨紀錄';
    document.getElementById('returnCancelEditBtn').style.display = '';
    document.getElementById('returnFormPanel').style.display = '';
    const otherQty = savedReturnRecords(order).filter(item => item.id !== recordId).reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
    document.getElementById('returnFormHint').innerText = `此筆最多可改為 ${Math.max(0, deliveredQuantity(order) - otherQty)} 個。`;
};

window.saveReturnRecord = async function() {
    if (!canEditPage('orders.list')) { alert('您目前只有查看權限。'); return; }
    const orderId = currentLifecycleOrderId;
    const date = document.getElementById('returnDate').value;
    const qty = parseFloat(document.getElementById('returnQty').value);
    const reason = document.getElementById('returnReason').value.trim();
    const editId = document.getElementById('returnEditId').value;
    if (!orderId || !date || !Number.isFinite(qty) || qty <= 0) { alert('請填寫退貨日期與大於 0 的退貨數量。'); return; }
    if (pendingReturnOrderIds.has(orderId)) return;
    const saveButton = document.getElementById('returnSaveBtn');
    pendingReturnOrderIds.add(orderId);
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const records = savedReturnRecords(order).slice();
            const existingIndex = records.findIndex(item => item.id === editId);
            if (editId && existingIndex < 0) throw new Error('這筆退貨紀錄已被其他人修改或刪除，請重新開啟後再試。');
            if (normalizedOrderStatus(order) !== 'normal' && existingIndex < 0) throw new Error('已取消的訂單不能新增退貨紀錄。');
            const now = new Date().toISOString();
            const actor = deliveryActor();
            const previous = existingIndex >= 0 ? records[existingIndex] : null;
            const record = previous ? { ...previous, date, qty, reason, updatedBy: actor, updatedAt: now } : { id: lifecycleRecordId(), date, qty, reason, createdBy: actor, createdAt: now };
            if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
            const totalReturned = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const delivered = deliveredQuantity(order);
            if (totalReturned > delivered + 1e-9) throw new Error(`累計退貨數量 ${totalReturned} 超過已送貨數量 ${delivered}。`);
            const history = { action: previous ? 'edit' : 'create', recordId: record.id, before: previous, after: record, by: actor, at: now };
            const updates = { returnRecords: records, returnedQty: totalReturned, returnHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, returnHistory: [...(order.returnHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetReturnForm();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('退貨紀錄儲存失敗：' + err.message);
    } finally {
        pendingReturnOrderIds.delete(orderId);
        if (saveButton) { saveButton.disabled = false; saveButton.innerText = '💾 儲存退貨紀錄'; }
    }
};

window.deleteReturnRecord = async function(recordId) {
    if (!canEditPage('orders.list')) { alert('您目前只有查看權限。'); return; }
    if (!confirm('確定要刪除這筆退貨紀錄嗎？異動軌跡仍會保留。')) return;
    const orderId = currentLifecycleOrderId;
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const records = savedReturnRecords(order);
            const removed = records.find(item => item.id === recordId);
            if (!removed) throw new Error('找不到這筆退貨紀錄。');
            const next = records.filter(item => item.id !== recordId);
            const totalReturned = next.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const history = { action: 'delete', recordId, before: removed, after: null, by: deliveryActor(), at: new Date().toISOString() };
            const updates = { returnRecords: next, returnedQty: totalReturned, returnHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, returnHistory: [...(order.returnHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetReturnForm();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) { alert('刪除失敗：' + err.message); }
};

window.updateOrderField = function(orderId, field, value) {
    const o = ordersCache.find(x => x.id === orderId);
    if (!o || !canEditPage('orders.list')) return;
    const previousValue = o ? o[field] : undefined;
    if (String(previousValue ?? '') === String(value ?? '')) return;
    const labels = { costPrice: '修改單位成本', transactionType: '修改交易方式', invoiceTitle: '修改發票抬頭', remarks: '修改備註' };
    const history = {
        field, label: labels[field] || `修改${field}`,
        before: previousValue ?? '', after: value ?? '',
        by: currentUserName || currentUser?.email || '未知使用者', at: new Date().toISOString()
    };

    o[field] = value;
    o.fieldEditHistory = [...(o.fieldEditHistory || []), history];
    if (field === 'transactionType') renderOrdersList();

    db.collection('orders').doc(orderId).update({ [field]: value, fieldEditHistory: firebase.firestore.FieldValue.arrayUnion(history) }).catch(err => {
        o[field] = previousValue;
        o.fieldEditHistory = (o.fieldEditHistory || []).filter(item => item !== history);
        if (field === 'transactionType') renderOrdersList();
        alert('更新失敗，已還原：' + err.message);
    });
};

window.deleteOrder = function(orderId) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order || !canEditPage('orders.list')) return;
    if (!isDeletableOrderDraft(order)) {
        alert('這筆訂單已有來源或流程紀錄，不能直接刪除，請改用取消。');
        prepareOrderLifecycle(orderId, 'cancelled');
        return;
    }
    if (!confirm('確定要刪除這筆尚未進入流程的草稿訂單嗎？')) return;
    db.runTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        if (!isDeletableOrderDraft(snapshot.data())) throw new Error('這筆訂單已有新的流程紀錄，不能刪除，請改用取消。');
        transaction.delete(ref);
    }).then(() => {
        ordersCache = ordersCache.filter(item => item.id !== orderId);
        renderOrdersList();
    }).catch(err => alert('刪除失敗：' + err.message));
};

window.openOrderModal = function(source = null) {
    ensurePriceListLoaded().catch(() => {});
    populateOrderBrandDropdown();
    populateOrderCustomerSuggestions();
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = source?.sourceType === DOCUMENT_TYPES.FORECAST ? 'Forecast 轉訂單' : '新增訂單';
    const today = new Date();
    document.getElementById('orderDateInput').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    ['orderCustomer', 'orderBrand', 'orderBrandOther', 'orderItemCode', 'orderItemName', 'orderUnit', 'orderInvoiceTitle'].forEach(id => {
        document.getElementById(id).value = '';
    });
    onOrderBrandSelectChange();
    document.getElementById('orderQty').value = 1;
    document.getElementById('orderUnitPrice').value = 0;
    document.getElementById('orderTotalPrice').value = 0;
    document.getElementById('orderCostPrice').value = '';
    setOrderCostFieldForProduct(null);
    document.getElementById('orderTransactionType').value = '';
    document.getElementById('orderInvoiceTitle').disabled = true;

    window._orderModalSourceLink = source?.sourceType && source?.sourceId
        ? { sourceType: source.sourceType, sourceId: source.sourceId }
        : null;
    window._orderModalProductId = source?.productId || '';

    if (source) {
        document.getElementById('orderCustomer').value = source.customerName || '';
        document.getElementById('orderItemCode').value = source.itemCode || '';
        document.getElementById('orderItemName').value = source.itemName || '';
        document.getElementById('orderQty').value = source.qty || 1;
        document.getElementById('orderUnit').value = source.unit || '';
        document.getElementById('orderUnitPrice').value = source.unitPrice || 0;
        if (currentUserRole === 'admin' || currentUserRole === 'purchaser') {
            document.getElementById('orderCostPrice').value = source.costPrice ?? '';
        }
        if (source.brand) {
            selectBrandInDropdown(document.getElementById('orderBrand'), source.brand);
            onOrderBrandSelectChange();
        }
        const total = source.totalPrice !== undefined && source.totalPrice !== null && source.totalPrice !== ''
            ? source.totalPrice
            : (Number(source.qty || 1) * Number(source.unitPrice || 0));
        document.getElementById('orderTotalPrice').value = total || 0;
        const sourceMatch = source.itemCode ? findPriceItemForOrder({ itemCode: source.itemCode, brand: source.brand || '' }) : null;
        if (sourceMatch) applyOrderProductCost(sourceMatch);
    }

    document.getElementById('orderModalOverlay').classList.add('active');
};

function populateOrderCustomerSuggestions() {
    const list = document.getElementById('orderCustomerSuggestions');
    if (!list) return;
    const customersByKey = new Map();
    const names = [
        ...getRecentCustomerNames(),
        ...ordersCache.map(order => order.customerName),
        ...equipmentList.map(equipment => equipment.customerName),
        ...myQuotesCache.map(quote => quote.clientName),
        ...myQuotesCache.map(quote => quote.ordererName),
        ...allQuotesCache.map(quote => quote.clientName),
        ...allQuotesCache.map(quote => quote.ordererName),
        ...[...document.querySelectorAll('#clientList option')].map(option => option.value)
    ];
    names.forEach(value => {
        const name = String(value || '').trim();
        if (!name) return;
        const key = name.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
        if (!customersByKey.has(key)) customersByKey.set(key, name);
    });
    list.innerHTML = '';
    [...customersByKey.values()].forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            list.appendChild(option);
        });
}

const RECENT_CUSTOMERS_STORAGE_KEY = 'recent_customer_names_v1';

function customerNameKey(value) {
    return String(value || '').trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
}

function getRecentCustomerNames() {
    try {
        const saved = JSON.parse(localStorage.getItem(RECENT_CUSTOMERS_STORAGE_KEY) || '[]');
        return Array.isArray(saved) ? saved.map(value => String(value || '').trim()).filter(Boolean).slice(0, 20) : [];
    } catch (_) {
        return [];
    }
}

function rememberRecentCustomerName(value) {
    const name = String(value || '').trim();
    if (!name) return;
    const key = customerNameKey(name);
    const recent = getRecentCustomerNames().filter(item => customerNameKey(item) !== key);
    localStorage.setItem(RECENT_CUSTOMERS_STORAGE_KEY, JSON.stringify([name, ...recent].slice(0, 20)));
    populateOrderCustomerSuggestions();
}

window.copyOrderAsNew = function(orderId) {
    const source = ordersCache.find(order => order.id === orderId);
    if (!source) {
        alert('找不到要複製的訂單，請重新整理後再試。');
        return;
    }
    openOrderModal();
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = '複製成新訂單';
    document.getElementById('orderCustomer').value = source.customerName || '';
    document.getElementById('orderItemCode').value = source.itemCode || '';
    document.getElementById('orderItemName').value = source.itemName || '';
    if (source.brand) selectBrandInDropdown(document.getElementById('orderBrand'), source.brand);
    onOrderBrandSelectChange();
    document.getElementById('orderQty').value = source.qty || 1;
    document.getElementById('orderUnit').value = source.unit || '';
    document.getElementById('orderUnitPrice').value = source.unitPrice || 0;
    if (source.totalPrice !== undefined && source.totalPrice !== null && String(source.totalPrice).trim() !== '') {
        document.getElementById('orderTotalPrice').value = String(source.totalPrice).replace(/,/g, '');
    } else {
        calcOrderTotal();
    }
    const transactionType = source.transactionType || '';
    document.getElementById('orderTransactionType').value = transactionType;
    const invoiceInput = document.getElementById('orderInvoiceTitle');
    invoiceInput.value = source.invoiceTitle || '';
    invoiceInput.disabled = transactionType !== '直';
};

window.closeOrderModal = function() {
    document.getElementById('orderModalOverlay').classList.remove('active');
};

window.calcOrderTotal = function() {
    const qty = parseFloat(document.getElementById('orderQty').value) || 0;
    const price = parseFloat(document.getElementById('orderUnitPrice').value) || 0;
    document.getElementById('orderTotalPrice').value = (qty * price).toFixed(0);
};

let newOrderSaveInProgress = false;

window.saveNewOrder = function() {
    if (newOrderSaveInProgress) return;
    const itemCode = document.getElementById('orderItemCode').value.trim();
    const data = {
        orderDate: document.getElementById('orderDateInput').value,
        createdAt: new Date().toISOString(),
        company: currentCompany || 'yushin',
        customerName: document.getElementById('orderCustomer').value.trim(),
        customerId: customerIdForName(document.getElementById('orderCustomer').value.trim()),
        brand: getBrandFieldValue('orderBrand', 'orderBrandOther'),
        itemCode: itemCode,
        itemCodeKey: normalizeHistoryItemCode(itemCode),
        itemName: document.getElementById('orderItemName').value.trim(),
        productLine: '',
        productType: '',
        qty: document.getElementById('orderQty').value,
        unit: document.getElementById('orderUnit').value.trim(),
        unitPrice: document.getElementById('orderUnitPrice').value,
        totalPrice: document.getElementById('orderTotalPrice').value,
        status: BUSINESS_STATUS.ACTIVE,
        ...grossAmountMetadata(document.getElementById('orderTotalPrice').value),
        transactionType: document.getElementById('orderTransactionType').value,
        invoiceTitle: document.getElementById('orderInvoiceTitle').value.trim(),
        quoteNo: '',
        ...linkedDocumentFields(window._orderModalSourceLink?.sourceType || '', window._orderModalSourceLink?.sourceId || '', window._orderModalSourceLink ? [documentLink(window._orderModalSourceLink.sourceType, window._orderModalSourceLink.sourceId, 'source')] : []),
        productId: window._orderModalProductId || '',
        salesName: currentUserName || '',
        salesCode: currentUserCode || '',
        ownerUid: currentUser?.uid || '',
        isOrdered: false,
        isArrived: false,
        isDelivered: false,
        isBilled: false,
        invoiceDate: ''
    };
    const costInputVal = document.getElementById('orderCostPrice').value;
    const selectedProduct = findPriceItemForOrder(data);
    const canSalesUseCost = currentUserRole === 'sales'
        && selectedProduct
        && authorizationTypeForProduct(selectedProduct) === 'NON_AUTHORIZED';
    if ((currentUserRole === 'admin' || currentUserRole === 'purchaser' || canSalesUseCost) && costInputVal !== '') {
        data.costPrice = parseFloat(costInputVal);
        if (canSalesUseCost) data.costSource = 'sales_manual_or_visible_non_authorized';
    }

    if (!data.orderDate || !data.itemName) {
        alert('請至少填寫訂單日期與品名');
        return;
    }
    if (document.getElementById('orderBrand').value === '其他' && !data.brand) {
        alert('已選擇「其他」廠牌，請輸入廠牌名稱');
        return;
    }

    data.customerId = syncCustomerMaster(data.customerName, { salesCode: data.salesCode });
    const priceMatch = findPriceItemForOrder(data);
    data.productLine = (priceMatch && priceMatch.productLine) || '';
    data.productType = (priceMatch && priceMatch.productType) || '';
    data.authorizationType = priceMatch ? authorizationTypeForProduct(priceMatch) : '';
    if (priceMatch) {
        data.productId = priceMatch.productId || stableProductId(priceMatch);
        data.unit = data.unit || priceMatch.unit || '';
        data.supplier = priceMatch.supplier || '';
        data.spec = priceMatch.spec || '';
    }

    const saveButton = document.getElementById('saveNewOrderBtn');
    newOrderSaveInProgress = true;
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    db.collection('orders').add(data).then(async docRef => {
        const reservation = await reserveInventoryForNewOrder(docRef.id, data);
        data.inventoryReservedQty = reservation.reservedQty;
        data.inventoryShortageQty = reservation.shortageQty;
        data.inventoryProductKey = inventoryProductKey(data);
        rememberRecentCustomerName(data.customerName);
        if (data.sourceType === DOCUMENT_TYPES.FORECAST && data.sourceId) {
            db.collection('forecasts').doc(data.sourceId).set({
                linkedDocuments: firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.ORDER, docRef.id, 'created')),
                updatedAt: new Date().toISOString()
            }, { merge: true }).catch(err => console.error('Forecast 回寫訂單關聯失敗', err));
        }
        window._orderModalSourceLink = null; window._orderModalProductId = '';
        closeOrderModal();
        // 新增成功後只把這一筆放進本機快取，不為單筆新增重新查詢整個訂單頁。
        ordersCache = [{ id: docRef.id, ...data }, ...ordersCache.filter(order => order.id !== docRef.id)]
            .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
        renderOrdersList();
    }).catch(err => {
        alert('新增失敗：' + err.message);
    }).finally(() => {
        newOrderSaveInProgress = false;
        if (saveButton) { saveButton.disabled = false; saveButton.innerText = '💾 儲存'; }
    });
};

// 匯出指定日期區間的訂單（供採購下單使用），不受畫面上目前的搜尋關鍵字影響
window.exportOrdersByDate = async function() {
    const start = document.getElementById('exportStartDate').value;
    const end = document.getElementById('exportEndDate').value;
    if (!start || !end) {
        alert('請選擇起訖日期');
        return;
    }
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }

    // Firestore 不支援同時對兩個不同欄位做範圍查詢，日期區間已經用掉唯一的範圍條件，
    // 所以業務姓名這邊改成撈出區間內全部訂單後，在前端依身分過濾（同時比對新舊兩種業務欄位格式）
    db.collection('orders')
        .where('orderDate', '>=', start)
        .where('orderDate', '<=', end)
        .get().then(async snapshot => {
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
                    '開票／收款日期': orderInvoiceDate(o),
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
    const generation = ++equipmentLoadGeneration;
    const requestedRole = currentUserRole;
    let query = db.collection('equipment');
    if (canViewAllEquipment()) {
        query = query.orderBy('customerName');
    } else {
        query = currentUserCode ? query.where('salesCode', '==', currentUserCode) : query.where('salesName', '==', currentUserName);
    }
    query.get().then(snapshot => {
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole) return;
        equipmentList = [];
        snapshot.forEach(doc => {
            equipmentList.push({ id: doc.id, ...doc.data() });
        });
        if (!canViewAllEquipment()) {
            equipmentList.sort((a, b) => (a.customerName || '').localeCompare(b.customerName || '', 'zh-Hant'));
        }
        renderEquipmentList();
    }).catch(err => {
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole) return;
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

    const match = priceItemLookup.get(`code:${normalizeItemCode(model)}`);
    if (match && match.brand) {
        selectBrandInDropdown(brandSelect, match.brand);
        onEqBrandSelectChange();
    }
};

window.openEquipmentModal = function(eqId) {
    populateEquipmentSalesDropdown();
    populateEquipmentBrandDropdown();
    populateOrderCustomerSuggestions();

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
        customerId: customerIdForName(document.getElementById('eqCustomer').value.trim()),
        brand: getBrandFieldValue('eqBrand', 'eqBrandOther'),
        model: document.getElementById('eqModel').value.trim(),
        serialNo: document.getElementById('eqSerial').value.trim(),
        salesName: document.getElementById('eqSales').value.trim(),
        salesCode: salesCodeForName(document.getElementById('eqSales').value.trim()),
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
    const ref = editId ? db.collection('equipment').doc(editId) : db.collection('equipment').doc();
    const payload = editId ? data : { ...data, assetId: getNextAssetId(data.salesName), logs: [] };

    ref.set(payload, { merge: true }).then(() => {
        const savedId = editId || ref.id;
        rememberRecentCustomerName(data.customerName);
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
window.exportEquipmentExcel = async function() {
    if (!equipmentList.length) {
        alert('目前沒有儀器資料可以下載。');
        return;
    }

    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
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
    if (tab === 'prices') loadPriceCatalogSummary();
    // 代理廠牌設定只需要價目表，不應順便全量讀取 orders。
    if (tab === 'agencies') ensurePriceListLoaded().then(() => { renderKeyStatisticBrands(); renderCompanyAgencyBrandSettings(); });
    // 統計資料在同一次登入期間保留快取；使用者按「重新整理」時才再次讀取。
    if (tab === 'statistics') ensurePriceListLoaded().then(() => salesStatisticsOrders.length ? renderSalesStatistics() : loadSalesStatistics());
    if (tab === 'quotes') loadAllQuotesFromCloud();
    if (tab === 'transfer') ensureSalesListLoaded().then(populateTransferDropdowns);
    if (tab === 'storage') resetCleanupPreview();
    if (tab === 'permissions') renderRolePermissions();
};

function renderRolePermissions() {
    const tbody = document.getElementById('rolePermissionsBody');
    if (!tbody) return;
    const roles = ['sales', 'purchaser', 'warehouse', 'engineer', 'admin'];
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
        const roles = ['sales', 'purchaser', 'warehouse', 'engineer', 'admin'];
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
    ['sales', 'purchaser', 'warehouse', 'engineer'].forEach(role => { if (!next[role]) next[role] = {}; });
    document.querySelectorAll('#rolePermissionsBody .permission-select:not([disabled])').forEach(select => {
        next[select.dataset.role][select.dataset.page] = select.value;
    });
    const nextScopes = JSON.parse(JSON.stringify(roleDataScopes));
    ['sales', 'purchaser', 'warehouse', 'engineer'].forEach(role => { if (!nextScopes[role]) nextScopes[role] = {}; });
    document.querySelectorAll('#roleDataScopesBody .data-scope-select:not([disabled])').forEach(select => {
        nextScopes[select.dataset.role][select.dataset.type] = select.value;
    });
    // 主系統若禁止查看，其子分頁也一併禁止，避免留下無法進入的孤立設定。
    ['sales', 'purchaser', 'warehouse', 'engineer'].forEach(role => {
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
    const brands = [...keyStatisticBrands, '維修'];
    container.innerHTML = brands.map(brand => `<div class="stat-brand-card">
            <div class="stat-brand-card-head"><span>${escapeHtml(brand)}${brand === '維修' ? '（固定）' : ''}</span>${brand === '維修' ? '' : `<button type="button" class="btn-small btn-secondary" onclick="removeStatisticBrand('${escapeAttr(brand)}')">歸回其他</button>`}</div>
        </div>`).join('');
    renderOtherStatisticBrands();
}

function normalizeStatisticBrandKey(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\-_]+/g, '');
}

function statisticBrandAliasLookup() {
    const lookup = new Map();
    const masterEntries = getUnifiedBrandEntries(true);
    [...keyStatisticBrands, '維修'].forEach(brand => {
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
    [...getAllPriceListBrandsRaw(), ...salesStatisticsOrders.map(order => order.brand)].forEach(value => {
        const brand = String(value || '').trim();
        if (!brand || brand === '維修') return;
        const key = normalizeStatisticBrandKey(brand);
        if (!entries.has(key)) entries.set(key, { name: brand, count: 0 });
    });
    salesStatisticsOrders.forEach(order => {
        const key = normalizeStatisticBrandKey(order.brand);
        if (entries.has(key)) entries.get(key).count++;
    });
    return [...entries.values()];
}

function renderOtherStatisticBrands() {
    const container = document.getElementById('otherStatisticBrands');
    if (!container) return;
    const lookup = statisticBrandAliasLookup();
    const others = rawBrandsWithOrderCounts().filter(item => !lookup.has(normalizeStatisticBrandKey(item.name)))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'zh-Hant'));
    container.innerHTML = others.length ? others.map(item => `<div class="stat-brand-other-row"><span>${escapeHtml(item.name)} <small style="color:#777;">${item.count} 筆訂單</small></span><button type="button" class="btn-small" onclick="promoteStatisticBrand('${escapeAttr(item.name)}')">獨立統計</button></div>`).join('') : '<div style="color:#888;font-size:13px;padding:8px 0;">目前沒有其他廠牌。</div>';
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
    const brand = input.value.trim();
    if (!brand) { alert('請輸入廠牌名稱。'); return; }
    if (normalizeStatisticBrandKey(brand) === normalizeStatisticBrandKey('維修') || statisticBrandAliasLookup().has(normalizeStatisticBrandKey(brand))) { alert('這個廠牌已存在，或會自動合併至既有廠牌。'); return; }
    keyStatisticBrands.push(brand);
    input.value = '';
    renderKeyStatisticBrands();
};

window.saveKeyStatisticBrands = async function() {
    if (currentUserRole !== 'admin') return;
    const selected = normalizeThermoBrandList(keyStatisticBrands).filter(brand => normalizeStatisticBrandKey(brand) !== normalizeStatisticBrandKey('維修'));
    const aliases = {};
    [...selected, '維修'].forEach(brand => { aliases[brand] = dedupeBrandsCaseInsensitive(keyStatisticBrandAliases[brand] || []); });
    try {
        await db.collection('settings').doc('salesStatistics').set({ keyBrands: selected, brandAliases: aliases }, { merge: true });
        keyStatisticBrands = selected;
        keyStatisticBrandAliases = aliases;
        await syncLegacyBrandSettingsToMaster();
        if (salesStatisticsOrders.length) renderSalesStatistics();
        renderKeyStatisticBrands();
        renderCompanyAgencyBrandSettings();
        alert('已儲存廠牌設定，並同步 Brand Master。');
    } catch (err) {
        alert('儲存設定失敗：' + err.message);
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
        ).join('') : '<span style="color:#888;font-size:13px;">請先上傳含廠牌資料的價目表。</span>';
        const otherChoice = `<label style="display:inline-block;margin:5px 12px 5px 0;font-size:13px;padding-left:10px;border-left:2px solid #ccc;"><input type="checkbox" class="company-agency-brand" data-company="${company}" value="${escapeAttr(OTHER_BRAND_OPTION_KEY)}" ${selected.includes(OTHER_BRAND_OPTION_KEY) ? 'checked' : ''}> 其他廠牌（開放自行輸入）</label>`;
        return `<div style="padding:12px 0;border-bottom:1px solid #ddd;"><strong>${escapeHtml(info.title)}（${escapeHtml(info.prefix)}）</strong><div style="margin-top:6px;">${brandChoices}${otherChoice}</div></div>`;
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
        populateQuoteBrandDropdowns();
        if (typeof populateForecastBrandDropdown === 'function') populateForecastBrandDropdown(document.getElementById('forecastBrand')?.value || '');
        alert('已儲存各分公司的代理廠牌設定，並同步 Brand Master。');
    } catch (err) {
        alert('儲存設定失敗：' + err.message);
    }
};

function salesStatisticsQueryWindow() {
    const end = document.getElementById('salesStatsEnd')?.value || localDateString();
    const currentQuarterStartMonth = Math.floor(new Date().getMonth() / 3) * 3;
    const defaultStart = `${new Date().getFullYear()}-${String(currentQuarterStartMonth + 1).padStart(2, '0')}-01`;
    const start = document.getElementById('salesStatsStart')?.value || defaultStart;
    return { start, end };
}

// 管理員銷售統計以「訂單」為準，避免把尚未成交的估價單也算進營收。
window.loadSalesStatistics = function() {
    if (currentUserRole !== 'admin') return Promise.resolve();
    if (salesStatisticsLoadPromise) return salesStatisticsLoadPromise;
    const requestedRole = currentUserRole;
    const totalEl = document.getElementById('salesStatsSalesInc');
    if (totalEl) totalEl.innerText = '讀取中…';

    // 不掃描全部歷史訂單：只抓「本統計期間成立」、「本期間有異動」與「目前仍進行中」三群，
    // 合併去重後再計算。這樣資料量隨年度增加時不會每次把全部舊訂單下載到瀏覽器。
    const { start, end } = salesStatisticsQueryWindow();
    const startIso = start + 'T00:00:00';
    const endIso = end + 'T23:59:59';
    const periodOrders = db.collection('orders')
        .where('orderDate', '>=', start)
        .where('orderDate', '<=', end)
        .orderBy('orderDate', 'desc')
        .limit(1500)
        .get();
    const activityOrders = db.collection('orders')
        .where('updatedAt', '>=', startIso)
        .where('updatedAt', '<=', endIso)
        .orderBy('updatedAt', 'desc')
        .limit(1500)
        .get();
    const openOrders = db.collection('orders')
        .where('status', '==', BUSINESS_STATUS.ACTIVE)
        .limit(1000)
        .get();

    salesStatisticsLoadPromise = Promise.all([periodOrders, activityOrders, openOrders]).then(([periodSnapshot, activitySnapshot, openSnapshot]) => {
        if (requestedRole !== currentUserRole) return;
        const records = new Map();
        [periodSnapshot, activitySnapshot, openSnapshot].forEach(snapshot => {
            snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));
        });
        salesStatisticsOrders = [...records.values()];
        const startInput = document.getElementById('salesStatsStart');
        const endInput = document.getElementById('salesStatsEnd');
        if (startInput && endInput && !startInput.value && !endInput.value) {
            const currentQuarter = `q${Math.floor(new Date().getMonth() / 3) + 1}`;
            document.getElementById('salesStatsPeriod').value = currentQuarter;
            setSalesStatisticsPeriod(currentQuarter);
        } else {
            loadInventoryAnalysisSupport(start,end).then(()=>renderSalesStatistics());
        }
    }).catch(err => {
        if (requestedRole !== currentUserRole) return;
        console.error('讀取銷售統計失敗：', err);
        if (totalEl) totalEl.innerText = '讀取失敗';
        alert('讀取銷售統計失敗，請確認 Firestore 權限設定。');
    }).finally(() => {
        salesStatisticsLoadPromise = null;
    });
    return salesStatisticsLoadPromise;
};

async function loadInventoryAnalysisSupport(start, end) {
    const [movements, stocks] = await Promise.all([
        db.collection('inventoryMovements').where('createdAt','>=',start+'T00:00:00').where('createdAt','<=',end+'T23:59:59').where('type','==','receipt').orderBy('createdAt','desc').limit(1000).get(),
        db.collection('inventory').orderBy('updatedAt','desc').limit(1000).get()
    ]);
    inventoryAnalysisReceipts = movements.docs.map(d=>({id:d.id,...d.data()}));
    inventoryAnalysisStocks = stocks.docs.map(d=>({id:d.id,...d.data()}));
}
function inventoryAnalysisTotals(start,end) {
    let purchase = 0;
    inventoryAnalysisReceipts.forEach(receipt => {
        const product = priceList.find(p => (p.productId || stableProductId(p)) === receipt.productKey);
        const unitCost = Number(receipt.unitCost ?? product?.cost ?? 0);
        purchase += Number(receipt.purchaseNetAmount ?? (Number(receipt.qty || 0) * unitCost));
    });
    const sales = salesStatisticsOrders.reduce((sum, order) => {
        const contribution = calculateOrderStatsContribution(order, start, end);
        return sum + contribution.actualSales;
    }, 0);
    let stockValue = 0, incoming = 0;
    inventoryAnalysisStocks.forEach(stock => {
        const product = priceList.find(p => (p.productId || stableProductId(p)) === stock.productKey);
        const unitCost = Number(stock.unitCost ?? product?.cost ?? 0);
        const numbers = inventoryNumbers(stock);
        stockValue += numbers.onHand * unitCost;
        incoming += numbers.incoming * unitCost;
    });
    return { purchase, sales, difference: sales - purchase, stockValue, incoming };
}
function renderInventoryAnalysisSummary(start,end){
    const t=inventoryAnalysisTotals(start,end),fmt=v=>Math.round(v).toLocaleString();
    const ids={invAnalysisPurchases:t.purchase,invAnalysisSales:t.sales,invAnalysisDifference:t.difference,invAnalysisStockValue:t.stockValue,invAnalysisIncoming:t.incoming};
    Object.entries(ids).forEach(([id,v])=>{const el=document.getElementById(id);if(el)el.innerText=fmt(v);});
}

function salesAmount(order) {
    const total = parseFloat(String(order.totalPrice == null ? '' : order.totalPrice).replace(/,/g, ''));
    if (Number.isFinite(total)) return total;
    return (parseFloat(order.qty) || 0) * (parseFloat(order.unitPrice) || 0);
}

// 訂單的 costPrice 是「每單位含稅進貨成本」，故需乘上數量才是該筆訂單的總成本。
function costAmount(order) {
    return (parseFloat(order.costPrice) || 0) * (parseFloat(order.qty) || 0);
}

function normalizeItemCode(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function normalizeItemCodeLoose(value) {
    return normalizeItemCode(value).replace(/[\-_.\/]+/g, '');
}

function findPriceItemByCodeValue(value) {
    const normalized = normalizeItemCode(value);
    if (!normalized) return null;

    const direct = priceItemLookup.get(`code:${normalized}`);
    if (direct) return direct;

    const exact = priceList.find(item => normalizeItemCode(item.model) === normalized);
    if (exact) return exact;

    // 有些舊價目表貨號帶有空格、-、/ 或 .；只有在寬鬆比對結果唯一時才自動帶入，避免誤抓錯品項。
    const loose = normalizeItemCodeLoose(value);
    if (!loose) return null;
    const candidates = priceList.filter(item => normalizeItemCodeLoose(item.model) === loose);
    return candidates.length === 1 ? candidates[0] : null;
}

function applyQuoteProductMatch(row, match) {
    if (!row || !match) return false;

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
    if (match.spec && !row.querySelector('.item-spec').value) row.querySelector('.item-spec').value = match.spec;

    const priceInput = row.querySelector('.inc-price');
    if (priceInput && match.price !== undefined && match.price !== null && String(match.price).trim() !== '') {
        priceInput.value = match.price;
        onIncPriceChange(priceInput);
    } else {
        calculateTotals();
    }
    return true;
}

let quoteModelInputTimer = null;
window.onItemModelInput = function(input) {
    clearTimeout(quoteModelInputTimer);
    quoteModelInputTimer = setTimeout(async () => {
        const value = input.value.trim();
        if (!value) return;
        await ensurePriceListLoaded().catch(() => {});
        const match = findPriceItemByCodeValue(value);
        if (match && input.value.trim() === value) applyQuoteProductMatch(input.closest('tr'), match);
    }, 180);
};

function stableProductId(item) {
    const brand = String(item?.brand || '').trim().toLocaleLowerCase();
    const code = normalizeItemCode(item?.model);
    if (code) return `prd:${encodeURIComponent(brand)}:${encodeURIComponent(code)}`;
    const name = String(item?.nameCn || item?.nameEn || '').normalize('NFKC').trim().toLocaleLowerCase();
    return `prd:${encodeURIComponent(brand)}:name:${encodeURIComponent(name)}`;
}

function normalizeProductMasterItem(item) {
    return {
        ...item,
        productId: item.productId || stableProductId(item),
        sku: item.sku || item.model || '',
        unit: item.unit || '',
        supplier: item.supplier || '',
        spec: item.spec || '',
        inventoryTracked: !!item.inventoryTracked,
        lotTracked: !!item.lotTracked,
        expiryTracked: !!item.expiryTracked,
        active: item.active !== false
    };
}

function normalizeProductMasterList(items) {
    return (items || []).map(normalizeProductMasterItem);
}

function brandMasterEntryForName(value) {
    const key = normalizeBrandLookupKey(resolveBrandName(value));
    return getUnifiedBrandEntries(true).find(entry => normalizeBrandLookupKey(entry.name) === key) || null;
}

function isBrandAuthorizedForCurrentCompany(value) {
    const brand = resolveBrandName(value);
    if (!brand) return false;
    const company = currentCompany || 'yushin';
    const entry = brandMasterEntryForName(brand);
    if (entry && Array.isArray(entry.companies) && entry.companies.includes(company)) return true;
    return (companyAgencyBrands[company] || []).some(name => normalizeBrandLookupKey(name) === normalizeBrandLookupKey(brand));
}

function authorizationTypeForProduct(item) {
    const saved = String(item?.authorizationType || '').trim().toUpperCase();
    if (saved === 'AUTHORIZED' || saved === 'NON_AUTHORIZED') return saved;
    return isBrandAuthorizedForCurrentCompany(item?.brand || item?.brandName || '') ? 'AUTHORIZED' : 'NON_AUTHORIZED';
}

function productMasterDocToPriceItem(doc) {
    const data = doc.data ? doc.data() : doc;
    return normalizeProductMasterItem({
        productId: data.productId || doc.id || '',
        brandId: data.brandId || '',
        brand: data.brandName || data.brand || '',
        model: data.manufacturerPartNo || data.sku || '',
        sku: data.manufacturerPartNo || data.sku || '',
        nameCn: data.productName || data.nameCn || '',
        nameEn: data.nameEn || '',
        productLine: data.productLine || '',
        productType: data.category || data.productType || '',
        authorizationType: data.authorizationType || '',
        spec: data.specification || data.spec || '',
        unit: data.unit || '',
        price: data.listPrice ?? data.price ?? 0,
        supplier: data.supplier || '',
        status: data.status || 'ACTIVE',
        active: data.status !== 'INACTIVE'
    });
}

async function loadProductMasterOverlay() {
    if (productMasterLoadPromise) return productMasterLoadPromise;
    productMasterLoadPromise = db.collection('products').limit(500).get().then(snapshot => {
        productMasterCache = snapshot.docs
            .map(productMasterDocToPriceItem)
            .filter(item => item.status !== 'INACTIVE' && item.active !== false);
        const merged = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
        productMasterCache.forEach(item => merged.set(item.productId || stableProductId(item), item));
        priceList = [...merged.values()];
        return productMasterCache;
    }).catch(err => {
        console.warn('Product Master 載入失敗，暫時沿用舊價目表：', err);
        productMasterLoadPromise = null;
        return [];
    });
    return productMasterLoadPromise;
}

async function loadVisibleProductCost(item) {
    const productId = item?.productId || stableProductId(item || {});
    if (!productId) return null;
    const authType = authorizationTypeForProduct(item);
    if (currentUserRole === 'sales' && authType === 'AUTHORIZED') return null;
    try {
        const doc = await db.collection('productCosts').doc(productId).get();
        if (!doc.exists) return null;
        const data = doc.data() || {};
        if (currentUserRole === 'sales' && data.salesVisible !== true) return null;
        const value = data.standardCost;
        return value === undefined || value === null || String(value).trim() === '' ? null : Number(value);
    } catch (_) {
        return null;
    }
}

function setOrderCostFieldForProduct(item) {
    const wrap = document.getElementById('orderCostFieldWrap');
    const input = document.getElementById('orderCostPrice');
    if (!wrap || !input) return;
    const privileged = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    const salesCanSee = currentUserRole === 'sales' && item && authorizationTypeForProduct(item) === 'NON_AUTHORIZED';
    wrap.style.display = (privileged || salesCanSee) ? '' : 'none';
    if (!privileged && !salesCanSee) input.value = '';
}

async function applyOrderProductCost(item) {
    setOrderCostFieldForProduct(item);
    const input = document.getElementById('orderCostPrice');
    if (!input) return;
    const allowed = currentUserRole === 'admin' || currentUserRole === 'purchaser'
        || (currentUserRole === 'sales' && authorizationTypeForProduct(item) === 'NON_AUTHORIZED');
    if (!allowed) {
        input.value = '';
        return;
    }
    const secureCost = await loadVisibleProductCost(item);
    if (secureCost !== null && Number.isFinite(secureCost)) {
        input.value = secureCost;
        return;
    }
    // 過渡期：正式 productCosts 尚未補齊前，採購/管理員可沿用舊價目表成本；
    // 業務只允許沿用非代理產品的舊成本。
    const privileged = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    const legacyAllowed = privileged || authorizationTypeForProduct(item) === 'NON_AUTHORIZED';
    if (legacyAllowed && item.cost !== undefined && item.cost !== null && String(item.cost).trim() !== '') {
        input.value = item.cost;
    } else {
        input.value = '';
    }
}

function clearQuickProductButton(input) {
    const next = input?.parentElement?.querySelector?.('.quick-product-create-btn');
    if (next) next.remove();
}

function showQuickProductButton(input, mode) {
    if (!input || !input.parentElement) return;
    clearQuickProductButton(input);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-secondary quick-product-create-btn';
    button.style.marginTop = '4px';
    button.style.width = '100%';
    button.textContent = '＋ 快速新增產品';
    button.onclick = () => openQuickProductCreate(mode, input);
    input.parentElement.appendChild(button);
}

function ensureQuickProductModal() {
    let overlay = document.getElementById('quickProductOverlay');
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'quickProductOverlay';
    overlay.className = 'eq-modal-overlay no-print';
    overlay.innerHTML = `
      <div class="eq-modal-box" style="max-width:620px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <h3 style="margin:0;">快速新增產品</h3>
          <button type="button" class="btn-secondary" onclick="closeQuickProductCreate()">✕ 關閉</button>
        </div>
        <div style="font-size:12px;color:#666;margin:8px 0 14px;">只填銷售當下需要的資料，其餘欄位可由採購或管理員後補。</div>
        <div class="form-grid">
          <div><label>廠牌</label><input id="quickProductBrand" type="text" list="quickProductBrandList" autocomplete="off"><datalist id="quickProductBrandList"></datalist></div>
          <div><label>貨號</label><input id="quickProductCode" type="text" autocomplete="off"></div>
          <div style="grid-column:1/-1;"><label>品名</label><input id="quickProductName" type="text" autocomplete="off"></div>
          <div><label>產品來源</label><select id="quickProductAuthorization" onchange="updateQuickProductCostVisibility()"><option value="AUTHORIZED">公司代理產品</option><option value="NON_AUTHORIZED">非代理產品</option></select></div>
          <div><label>建議售價</label><input id="quickProductPrice" type="number" min="0"></div>
          <div id="quickProductCostWrap"><label>成本</label><input id="quickProductCost" type="number" min="0" placeholder="沒有價目表時可自行輸入"></div>
        </div>
        <div style="margin-top:14px;text-align:right;">
          <button type="button" id="saveQuickProductBtn" onclick="saveQuickProduct()">儲存並帶入</button>
          <button type="button" class="btn-secondary" onclick="closeQuickProductCreate()">取消</button>
        </div>
      </div>`;
    overlay.onclick = event => { if (event.target === overlay) closeQuickProductCreate(); };
    document.body.appendChild(overlay);
    return overlay;
}

window.updateQuickProductCostVisibility = function() {
    const type = document.getElementById('quickProductAuthorization')?.value || 'NON_AUTHORIZED';
    const wrap = document.getElementById('quickProductCostWrap');
    if (wrap) wrap.style.display = type === 'NON_AUTHORIZED' ? '' : 'none';
    if (type === 'AUTHORIZED') {
        const input = document.getElementById('quickProductCost');
        if (input) input.value = '';
    }
};

window.openQuickProductCreate = function(mode, input) {
    const overlay = ensureQuickProductModal();
    quickProductTarget = { mode, input, row: mode === 'quote' ? input.closest('tr') : null };
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
    document.getElementById('quickProductPrice').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.inc-price')?.value || '')
        : (document.getElementById('orderUnitPrice')?.value || '');
    document.getElementById('quickProductCost').value = mode === 'order'
        ? (document.getElementById('orderCostPrice')?.value || '')
        : '';
    document.getElementById('quickProductAuthorization').value =
        isBrandAuthorizedForCurrentCompany(currentBrand) ? 'AUTHORIZED' : 'NON_AUTHORIZED';
    updateQuickProductCostVisibility();
    overlay.classList.add('active');
};

window.closeQuickProductCreate = function() {
    const overlay = document.getElementById('quickProductOverlay');
    if (overlay) overlay.classList.remove('active');
    quickProductTarget = null;
};

window.saveQuickProduct = async function() {
    const brand = resolveBrandName(document.getElementById('quickProductBrand')?.value || '');
    const code = String(document.getElementById('quickProductCode')?.value || '').trim();
    const productName = String(document.getElementById('quickProductName')?.value || '').trim();
    const authorizationType = document.getElementById('quickProductAuthorization')?.value || 'NON_AUTHORIZED';
    const priceRaw = document.getElementById('quickProductPrice')?.value ?? '';
    const costRaw = document.getElementById('quickProductCost')?.value ?? '';
    if (!brand || !code || !productName || String(priceRaw).trim() === '') {
        alert('請填寫廠牌、貨號、品名與建議售價。');
        return;
    }

    const normalizedPartNo = normalizeItemCodeLoose(code);
    const brandEntry = brandMasterEntryForName(brand);
    const duplicateSnap = await db.collection('products').where('normalizedPartNo', '==', normalizedPartNo).limit(20).get();
    const duplicate = duplicateSnap.docs.find(doc => {
        const data = doc.data() || {};
        return normalizeBrandLookupKey(data.brandName || data.brand || '') === normalizeBrandLookupKey(brand);
    });
    if (duplicate) {
        const existing = productMasterDocToPriceItem(duplicate);
        alert('這個廠牌與貨號已存在，系統會直接使用現有產品。');
        priceList = priceList.filter(item => (item.productId || stableProductId(item)) !== existing.productId).concat(existing);
        refreshPriceDatalists();
        if (quickProductTarget?.mode === 'quote') applyQuoteProductMatch(quickProductTarget.row, existing);
        if (quickProductTarget?.mode === 'order') {
            quickProductTarget.input.value = existing.model || code;
            await onOrderItemCodeChange(quickProductTarget.input);
        }
        clearQuickProductButton(quickProductTarget?.input);
        closeQuickProductCreate();
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
        authorizationType,
        listPrice: Number(priceRaw) || 0,
        status: 'TEMPORARY',
        createdAt: now,
        createdBy: currentUser?.uid || '',
        updatedAt: now,
        updatedBy: currentUser?.uid || ''
    };
    const button = document.getElementById('saveQuickProductBtn');
    if (button) { button.disabled = true; button.innerText = '儲存中…'; }
    try {
        await db.collection('products').doc(productId).set(productDoc, { merge: true });
        if (authorizationType === 'NON_AUTHORIZED' && String(costRaw).trim() !== '') {
            await db.collection('productCosts').doc(productId).set({
                productId,
                standardCost: Number(costRaw) || 0,
                salesVisible: true,
                source: 'quick_create',
                updatedAt: now,
                updatedBy: currentUser?.uid || ''
            }, { merge: true });
        }
        const item = productMasterDocToPriceItem({ id: productId, data: () => productDoc });
        if (authorizationType === 'NON_AUTHORIZED' && String(costRaw).trim() !== '') item.cost = Number(costRaw) || 0;
        priceList = priceList.filter(row => (row.productId || stableProductId(row)) !== productId).concat(item);
        productMasterCache = productMasterCache.filter(row => (row.productId || stableProductId(row)) !== productId).concat(item);
        refreshPriceDatalists();
        if (quickProductTarget?.mode === 'quote') applyQuoteProductMatch(quickProductTarget.row, item);
        if (quickProductTarget?.mode === 'order') {
            quickProductTarget.input.value = code;
            await onOrderItemCodeChange(quickProductTarget.input);
        }
        clearQuickProductButton(quickProductTarget?.input);
        closeQuickProductCreate();
    } catch (err) {
        alert('快速新增產品失敗：' + err.message);
    } finally {
        if (button) { button.disabled = false; button.innerText = '儲存並帶入'; }
    }
};

function rebuildPriceItemLookup() {
    priceItemLookup = new Map();
    priceList.forEach(item => {
        const code = normalizeItemCode(item.model);
        if (!code) return;
        const brand = String(item.brand || '').trim().toLocaleLowerCase();
        if (!priceItemLookup.has(`code:${code}`)) priceItemLookup.set(`code:${code}`, item);
        if (brand && !priceItemLookup.has(`brand:${brand}:${code}`)) priceItemLookup.set(`brand:${brand}:${code}`, item);
    });
}

function findPriceItemForOrder(order) {
    const code = normalizeItemCode(order.itemCode);
    if (!code) return null;
    const orderBrand = String(order.brand || '').trim().toLocaleLowerCase();
    return (orderBrand && priceItemLookup.get(`brand:${orderBrand}:${code}`)) || priceItemLookup.get(`code:${code}`) || null;
}

function productLineForOrder(order) {
    if ((order.brand || '').trim() === '維修') return '維修';
    const savedLine = (order.productLine || '').trim();
    if (savedLine && savedLine !== '未分類') return savedLine;
    // 舊訂單未存產品線，或曾被存成「未分類」時，依廠牌＋貨號回查最新價目表。
    const match = findPriceItemForOrder(order);
    return (match && match.productLine) ? match.productLine.trim() : '未分類';
}

function productTypeForOrder(order) {
    const savedType = (order.productType || '').trim();
    if (savedType && savedType !== '未分類') return savedType;
    // 舊訂單沒有類型時，同樣可依貨號回查目前價目表；仍找不到才歸到未分類。
    const match = findPriceItemForOrder(order);
    return (match && match.productType) ? match.productType.trim() : '未分類';
}

function statisticBrandForOrder(order) {
    const brand = (order.brand || '').trim();
    if (brand === '維修') return '維修';
    return statisticBrandAliasLookup().get(normalizeStatisticBrandKey(brand)) || '其他廠牌';
}

function newSalesStatsMetric() {
    return { actualSales: 0, pendingSales: 0, totalSales: 0, actualCost: 0, pendingCost: 0, totalCost: 0, profit: 0, missingCostIds: new Set(), orderIds: new Set(), estimatedSales: 0, estimatedIds: new Set() };
}

function orderUnitSalesAmount(order) {
    const qty = orderQuantity(order);
    return qty ? salesAmount(order) / qty : (parseFloat(order.unitPrice) || 0);
}

function orderHasCost(order) {
    return order.costPrice !== undefined && order.costPrice !== null && String(order.costPrice).trim() !== '' && Number.isFinite(parseFloat(order.costPrice));
}

function dateInStatsRange(date, start, end) {
    return !!date && (!start || date >= start) && (!end || date <= end);
}

function calculateOrderStatsContribution(order, start, end) {
    const empty = { actualQty: 0, pendingQty: 0, actualSales: 0, pendingSales: 0, actualCost: 0, pendingCost: 0, estimatedSales: 0, estimated: false };
    if (normalizedOrderStatus(order) !== 'normal') return empty;
    const totalQty = orderQuantity(order);
    if (!totalQty) return empty;
    const unitSales = orderUnitSalesAmount(order);
    const unitCost = parseFloat(order.costPrice) || 0;
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
    savedReturnRecords(order).forEach(record => {
        if (dateInStatsRange(record.date, start, end)) actualQty -= parseFloat(record.qty) || 0;
    });
    const orderExistsByCutoff = !order.orderDate || order.orderDate <= cutoff;
    const pendingQty = orderExistsByCutoff ? Math.max(0, totalQty - Math.min(totalQty, deliveredByCutoff)) : 0;
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
    if (!orderHasCost(order) && (contribution.actualQty || contribution.pendingQty)) metric.missingCostIds.add(order.id);
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

function populateSalesStatisticsFilters() {
    const selects = [
        { id: 'salesStatsSalesFilter', label: '全部業務', values: salesStatisticsOrders.map(o => stripPhoneSuffix(o.salesName) || '未指定業務') },
        { id: 'salesStatsBrandFilter', label: '全部廠牌', values: [...keyStatisticBrands, '其他廠牌', '維修'] },
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

window.setSalesStatisticsPeriod = function(period) {
    const now = new Date();
    const year = now.getFullYear();
    let start = '', end = '';
    if (/^q[1-4]$/.test(period)) {
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
    renderSalesStatistics();
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

    salesStatisticsOrders.forEach(order => {
        const sales = stripPhoneSuffix(order.salesName) || '未指定業務';
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

window.renderSalesStatistics = function() {
    const _analysisStart=document.getElementById('salesStatsStart')?.value||localDateString().slice(0,4)+'-01-01';
    const _analysisEnd=document.getElementById('salesStatsEnd')?.value||localDateString();
    if(inventoryAnalysisStocks.length||inventoryAnalysisReceipts.length) renderInventoryAnalysisSummary(_analysisStart,_analysisEnd);

    populateSalesStatisticsFilters();
    const { total, byBrand, bySales, byType, byLine } = buildSalesStatisticsReport();

    const countEl = document.getElementById('salesStatsOrderCount');
    const setMetric = (id, value) => { const el = document.getElementById(id); if (el) el.innerText = formatStatsMoney(value); };
    setMetric('salesStatsActualSales', total.actualSales);
    setMetric('salesStatsPendingSales', total.pendingSales);
    setMetric('salesStatsTotalSales', total.totalSales);
    setMetric('salesStatsSalesInc', total.totalSales);
    setMetric('salesStatsCostInc', total.totalCost);
    if (total.missingCostIds.size) document.getElementById('salesStatsProfit').innerText = '待補成本';
    else setMetric('salesStatsProfit', total.profit);
    document.getElementById('salesStatsActualDetail').innerText = `期間送貨減退貨；成本 ${formatStatsMoney(total.actualCost)}`;
    document.getElementById('salesStatsPendingDetail').innerText = `截至迄日未交餘額；成本 ${formatStatsMoney(total.pendingCost)}`;
    document.getElementById('salesStatsTotalDetail').innerText = total.missingCostIds.size ? `有 ${total.missingCostIds.size} 筆未填成本，毛利暫不顯示` : `毛利 ${formatStatsMoney(total.profit)}`;
    const rateEl = document.getElementById('salesStatsProfitRate');
    if (rateEl) rateEl.innerText = total.missingCostIds.size ? '待補成本' : total.totalSales ? (total.profit / total.totalSales * 100).toFixed(1) + '%' : '－';
    const missingCostButton = document.getElementById('salesStatsMissingCost');
    if (missingCostButton) {
        missingCostButton.innerText = `${total.missingCostIds.size} 筆`;
        missingCostButton.disabled = total.missingCostIds.size === 0;
        missingCostButton.title = total.missingCostIds.size ? '查看並補填缺少成本的訂單' : '目前沒有缺少成本的訂單';
    }
    document.getElementById('salesStatsEstimated').innerText = `${formatStatsMoney(total.estimatedSales)}／${total.estimatedIds.size} 筆`;
    if (countEl) countEl.innerText = `共 ${total.orderIds.size} 筆有效訂單；金額為含稅金額`;
    renderSalesStatsRows('salesStatsByBrand', byBrand, total.totalSales);
    renderSalesStatsRows('salesStatsBySales', bySales, total.totalSales);
    renderSalesStatsRows('salesStatsByType', byType, total.totalSales);
    renderSalesStatsRows('salesStatsByLine', byLine, total.totalSales);
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
            { '項目': '業務篩選', '內容': report.salesFilter || '全部業務' },
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
                    '訂購單號': order.purchaseOrderNo || '',
                    '客戶名稱': order.customerName || '',
                    '業務': sales,
                    '統計廠牌': brand,
                    '原始廠牌': order.brand || '',
                    '產品類型': type,
                    '產品線': line,
                    '貨號': order.itemCode || '',
                    '品名': order.itemName || '',
                    '交易方式': transaction,
                    '訂購數量': orderQuantity(order),
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
        alert('匯出季報失敗：' + err.message);
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
            <td><input type="number" min="0" step="0.01" class="missing-cost-input" aria-label="${escapeAttr(order.itemName || '訂單')}單位成本" onchange="saveMissingCostFromStats('${escapeAttr(order.id)}', this)"><small class="missing-cost-save-state"></small></td>
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

window.saveMissingCostFromStats = async function(orderId, input) {
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
        await db.collection('orders').doc(orderId).update({ costPrice: cost });
        const statsOrder = salesStatisticsOrders.find(order => order.id === orderId);
        if (statsOrder) statsOrder.costPrice = cost;
        const cachedOrder = ordersCache.find(order => order.id === orderId);
        if (cachedOrder) cachedOrder.costPrice = cost;
        renderSalesStatistics();
        renderMissingCostOrders();
    } catch (err) {
        input.disabled = false;
        if (state) state.innerText = '儲存失敗';
        alert('成本儲存失敗：' + err.message);
    }
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
        if (event.target.closest('button, input, select, textarea, label, a, details, summary')) return;
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
            <td data-label="代號">${escapeHtml(u.code || '—')}</td>
            <td data-label="姓名">${escapeHtml(u.name || '（尚未設定姓名）')}</td>
            <td data-label="電話">${escapeHtml(u.phone || '—')}</td>
            <td data-label="Email">${u.email ? escapeHtml(u.email) : '<span style="color:#c0392b;font-size:11px;">尚未取得（需等對方登入一次才會同步）</span>'}</td>
            <td data-label="身份">${escapeHtml(roleLabel[u.role] || u.role || '業務')}</td>
            <td data-label="密碼" class="admin-user-password-actions">
                ${u.mustChangePassword
                    ? `<span class="status-badge status-soon" style="margin-right:6px;">下次登入須改密碼</span><button type="button" class="btn-small btn-secondary" onclick="toggleMustChangePassword('${u.uid}', false)">取消要求</button>`
                    : `<button type="button" class="btn-small" onclick="toggleMustChangePassword('${u.uid}', true)">🔒 強制下次登入改密碼</button>`}
                <br>
                ${u.email
                    ? `<button type="button" class="btn-small btn-secondary" style="margin-top:4px;" onclick="sendPasswordResetToUser('${escapeAttr(u.email)}')">📧 寄送密碼重設信</button>`
                    : ''}
            </td>
            <td data-label="帳號 UID" class="admin-user-uid" style="font-family:monospace;font-size:11px;color:${hasProfile ? '#999' : '#c0392b'};">${escapeHtml(u.uid)}</td>
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
    const snapshot = await db.collection('salesCodes').limit(500).get();
    salesCodeMasterCache = snapshot.docs
        .map(doc => ({ id: doc.id, ...doc.data() }))
        .filter(item => item.active !== false)
        .sort((x, y) => String(x.code || x.id).localeCompare(String(y.code || y.id), 'zh-Hant'));
    return salesCodeMasterCache;
}

window.reloadSalesFromUsers = function() {
    return Promise.all([initSalesList(), loadAllUsersForAdmin()]).then(async () => {
        if (trueUserRole === 'admin') await syncSalesCodeMasterFromUsers().catch(err => console.warn('同步業務代號主檔失敗：', err));
        await loadSalesCodeMaster().catch(err => { console.warn('讀取業務代號主檔失敗：', err); salesCodeMasterCache = []; });
        renderAdminSalesTable();
        populateTransferDropdowns();
    });
};

/* ---------- 業務代號交接：資料歸屬維持 salesCode，只更換代號目前負責人 ---------- */
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

async function countLegacyRecordsForSalesCode(person) {
    if (!person?.name) return { quotes:0, orders:0, forecasts:0, equipment:0, total:0 };
    const configs = [
        ['quotes','quotes'], ['orders','orders'], ['forecasts','forecasts'], ['equipment','equipment']
    ];
    const counts = {};
    await Promise.all(configs.map(async ([key, collection]) => {
        const snap = await db.collection(collection).where('salesName', '==', person.name).get();
        counts[key] = snap.docs.filter(doc => !doc.data().salesCode).length;
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
        resultEl.innerText = '這位同仁目前已經是此業務代號的負責人。';
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
            `業務代號：${salesCode}\n目前負責人：${currentHolder?.name || '未指定'}\n接手同仁：${target.name}\n\n` +
            `舊資料需要補上 salesCode：${counts.total} 筆\n` +
            `・估價單 ${counts.quotes || 0}\n・訂單 ${counts.orders || 0}\n・Forecast ${counts.forecasts || 0}\n・儀器 ${counts.equipment || 0}\n\n` +
            '交接後歷史 salesName/createdBy 不會被改寫；資料歸屬只改由此業務代號的現任負責人接手。';
        executeBtn.style.display = '';
    } catch (err) {
        resultEl.innerText = '檢查失敗：' + err.message;
    }
};

async function backfillSalesCodeForLegacyRecords(person, salesCode) {
    if (!person?.name || !salesCode) return 0;
    const collections = ['quotes','orders','forecasts','equipment'];
    let total = 0;
    for (const collection of collections) {
        const snap = await db.collection(collection).where('salesName', '==', person.name).get();
        const refs = snap.docs.filter(doc => !doc.data().salesCode).map(doc => doc.ref);
        if (refs.length) {
            await runFirestoreBatchUpdates(refs, { salesCode, ownershipMigratedAt: new Date().toISOString() });
            total += refs.length;
        }
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
        const codeSnap = await codeRef.get();
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
    const collections = ['quotes', 'orders', 'purchaseOrders', 'equipment', 'users', 'settings', 'brands', 'products', 'productCosts'];
    button.disabled = true;
    button.innerText = '正在整理備份…';
    status.innerText = '讀取雲端資料中，請不要關閉頁面。';
    try {
        const snapshots = await Promise.all(collections.map(name => db.collection(name).get()));
        const data = {};
        let documentCount = 0;
        snapshots.forEach((snapshot, index) => {
            data[collections[index]] = snapshot.docs.map(doc => ({ id: doc.id, data: backupSerializableValue(doc.data()) }));
            documentCount += snapshot.size;
        });
        const createdAt = new Date();
        const backup = {
            format: 'yu-shing-firestore-backup',
            version: 1,
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

/* ---------- Phase 1B：舊訂單搜尋索引補建 ---------- */
let orderSearchIndexMigrationRunning = false;

window.backfillOrderSearchIndex = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        alert('只有管理員可以執行搜尋索引補建。');
        return;
    }
    if (orderSearchIndexMigrationRunning) return;
    if (!confirm('這會逐批檢查舊訂單，僅為缺少 itemCodeKey 的文件補上標準化貨號，不會修改訂單內容或狀態。確定執行嗎？')) return;

    const button = document.getElementById('orderSearchIndexMigrationBtn');
    const status = document.getElementById('orderSearchIndexMigrationStatus');
    orderSearchIndexMigrationRunning = true;
    if (button) button.disabled = true;
    let cursor = null;
    let scanned = 0;
    let updated = 0;
    try {
        while (true) {
            let query = db.collection('orders').orderBy(firebase.firestore.FieldPath.documentId()).limit(200);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await query.get();
            if (snapshot.empty) break;

            let batch = db.batch();
            let batchWrites = 0;
            snapshot.docs.forEach(doc => {
                const data = doc.data() || {};
                const sourceCode = data.itemCode || data.productCode || data.model || '';
                const normalized = normalizeHistoryItemCode(sourceCode);
                scanned += 1;
                if (normalized && data.itemCodeKey !== normalized) {
                    batch.update(doc.ref, { itemCodeKey: normalized });
                    batchWrites += 1;
                    updated += 1;
                }
            });
            if (batchWrites) await batch.commit();
            cursor = snapshot.docs[snapshot.docs.length - 1];
            if (status) status.innerText = `已檢查 ${scanned} 筆，補建 ${updated} 筆搜尋索引…`;
            if (snapshot.size < 200) break;
        }
        if (status) status.innerText = `完成：共檢查 ${scanned} 筆舊訂單，補建／修正 ${updated} 筆貨號搜尋索引。`;
    } catch (err) {
        console.error('舊訂單搜尋索引補建失敗：', err);
        if (status) status.innerText = `補建中斷：已檢查 ${scanned} 筆、更新 ${updated} 筆。可稍後重新執行，已完成的資料不會重複修改。`;
        alert('搜尋索引補建未完成，請確認 Firestore 權限與網路連線後再試。');
    } finally {
        orderSearchIndexMigrationRunning = false;
        if (button) button.disabled = false;
    }
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

/* ---------- Product Master v2：舊價目表安全遷移 ---------- */
let productMasterMigrationRunning = false;

function legacyPriceItemWithoutCost(item) {
    const clean = { ...item };
    delete clean.cost;
    delete clean.standardCost;
    delete clean.purchaseCost;
    return clean;
}

function productMasterRecordFromLegacyItem(item) {
    const normalized = normalizeProductMasterItem(item);
    const brand = resolveBrandName(normalized.brand || '');
    const brandEntry = brandMasterEntryForName(brand);
    return {
        productId: normalized.productId || stableProductId(normalized),
        brandId: brandEntry?.id || '',
        brandName: brand,
        manufacturerPartNo: normalized.model || normalized.sku || '',
        normalizedPartNo: normalizeItemCodeLoose(normalized.model || normalized.sku || ''),
        productName: normalized.nameCn || normalized.nameEn || '',
        nameEn: normalized.nameEn || '',
        category: normalized.productType || '',
        productLine: normalized.productLine || '',
        specification: normalized.spec || '',
        unit: normalized.unit || '',
        listPrice: Number(normalized.price || 0),
        authorizationType: authorizationTypeForProduct(normalized),
        status: normalized.active === false ? 'INACTIVE' : 'ACTIVE',
        legacySource: 'settings/prices',
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser?.uid || ''
    };
}

function legacyCostRecord(item, productRecord) {
    const raw = item?.cost;
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    const cost = Number(raw);
    if (!Number.isFinite(cost)) return null;
    return {
        productId: productRecord.productId,
        standardCost: cost,
        salesVisible: productRecord.authorizationType === 'NON_AUTHORIZED',
        source: 'legacy_price_migration',
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser?.uid || ''
    };
}

async function readLegacyPriceStorage() {
    const metaRef = db.collection('settings').doc('prices');
    const metaDoc = await metaRef.get();
    const meta = metaDoc.exists ? metaDoc.data() : {};
    const documents = [];
    const items = [];

    if (meta.storage === 'brands' && Array.isArray(meta.brands)) {
        for (const brand of meta.brands) {
            const count = brand.chunkCount || 1;
            for (let i = 0; i < count; i++) {
                const id = i === 0 ? brand.id : `${brand.id}-part${i}`;
                const doc = await db.collection('settings').doc(id).get();
                if (!doc.exists) continue;
                const data = doc.data() || {};
                documents.push({ ref: doc.ref, id, data });
                (Array.isArray(data.items) ? data.items : []).forEach(item => items.push(item));
            }
        }
        // 舊 list 可能仍保留尚未分片的廠牌，需一併遷移。
        (Array.isArray(meta.list) ? meta.list : []).forEach(item => items.push(item));
    } else {
        (Array.isArray(meta.list) ? meta.list : []).forEach(item => items.push(item));
    }

    return { metaRef, meta, documents, items };
}

function dedupeLegacyProducts(items) {
    const map = new Map();
    (items || []).forEach(item => {
        const normalized = normalizeProductMasterItem(item);
        const key = normalized.productId || stableProductId(normalized);
        if (!key) return;
        map.set(key, normalized);
    });
    return [...map.values()];
}

window.previewProductMasterMigration = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        alert('只有管理員可以執行 Product Master 遷移。');
        return;
    }
    const status = document.getElementById('productMasterMigrationStatus');
    if (status) status.innerText = '正在檢查舊價目表…';
    try {
        await Promise.all([ensurePriceListLoaded(), loadBrandMaster()]);
        const legacy = await readLegacyPriceStorage();
        const unique = dedupeLegacyProducts(legacy.items);
        let costCount = 0;
        let authorized = 0;
        let nonAuthorized = 0;
        unique.forEach(item => {
            const product = productMasterRecordFromLegacyItem(item);
            if (product.authorizationType === 'AUTHORIZED') authorized++;
            else nonAuthorized++;
            if (legacyCostRecord(item, product)) costCount++;
        });
        window._productMasterMigrationPreview = {
            products: unique.length,
            costs: costCount,
            authorized,
            nonAuthorized,
            documents: legacy.documents.length
        };
        if (status) status.innerText =
            `預覽完成：${unique.length} 個產品（代理 ${authorized}／非代理 ${nonAuthorized}），` +
            `${costCount} 筆成本；將處理 ${legacy.documents.length} 個舊價目表分片。\n` +
            '執行後：產品寫入 products、成本寫入 productCosts，舊價目表會保留產品/售價但移除成本欄位。可重複執行。';
        const button = document.getElementById('productMasterMigrationBtn');
        if (button) button.disabled = unique.length === 0;
    } catch (err) {
        console.error('Product Master 遷移預覽失敗：', err);
        if (status) status.innerText = '預覽失敗：' + err.message;
    }
};

async function commitMigrationBatch(operations) {
    let batch = db.batch();
    let count = 0;
    for (const operation of operations) {
        operation(batch);
        count++;
        if (count >= 400) {
            await batch.commit();
            batch = db.batch();
            count = 0;
        }
    }
    if (count) await batch.commit();
}

window.runProductMasterMigration = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        alert('只有管理員可以執行 Product Master 遷移。');
        return;
    }
    if (productMasterMigrationRunning) return;
    if (!window._productMasterMigrationPreview) {
        alert('請先按「預覽遷移」確認筆數。');
        return;
    }
    if (!confirm('確定執行 Product Master 安全遷移？\n\n產品與成本會寫入新的主檔；舊價目表不刪除，但會移除成本欄位，避免業務從舊 settings 文件讀到代理產品成本。')) return;

    productMasterMigrationRunning = true;
    const button = document.getElementById('productMasterMigrationBtn');
    const previewButton = document.getElementById('productMasterMigrationPreviewBtn');
    const status = document.getElementById('productMasterMigrationStatus');
    if (button) button.disabled = true;
    if (previewButton) previewButton.disabled = true;

    try {
        await Promise.all([ensurePriceListLoaded(), loadBrandMaster()]);
        const legacy = await readLegacyPriceStorage();
        const unique = dedupeLegacyProducts(legacy.items);
        const operations = [];
        let productWrites = 0;
        let costWrites = 0;

        unique.forEach(item => {
            const product = productMasterRecordFromLegacyItem(item);
            operations.push(batch => batch.set(db.collection('products').doc(product.productId), product, { merge: true }));
            productWrites++;
            const cost = legacyCostRecord(item, product);
            if (cost) {
                operations.push(batch => batch.set(db.collection('productCosts').doc(product.productId), cost, { merge: true }));
                costWrites++;
            }
        });

        await commitMigrationBatch(operations);
        if (status) status.innerText = `主檔寫入完成：產品 ${productWrites}、成本 ${costWrites}。正在清理舊價目表成本欄位…`;

        // 分片文件只移除成本欄位，保留原本產品與售價，確保既有估價/訂單自動帶入不被中斷。
        for (const entry of legacy.documents) {
            const cleanItems = (Array.isArray(entry.data.items) ? entry.data.items : []).map(legacyPriceItemWithoutCost);
            await entry.ref.set({ items: cleanItems, costSanitizedAt: new Date().toISOString() }, { merge: true });
        }

        // 舊版 settings/prices.list 也可能仍含成本，一併去除。
        if (Array.isArray(legacy.meta.list)) {
            await legacy.metaRef.set({
                list: legacy.meta.list.map(legacyPriceItemWithoutCost),
                costSanitizedAt: new Date().toISOString(),
                productMasterMigratedAt: new Date().toISOString(),
                productMasterMigrationVersion: 2
            }, { merge: true });
        } else {
            await legacy.metaRef.set({
                costSanitizedAt: new Date().toISOString(),
                productMasterMigratedAt: new Date().toISOString(),
                productMasterMigrationVersion: 2
            }, { merge: true });
        }

        productMasterLoadPromise = null;
        priceListLoadPromise = null;
        await ensurePriceListLoaded();
        window._productMasterMigrationPreview = null;
        if (status) status.innerText =
            `完成：${productWrites} 個產品已進入 products、${costWrites} 筆成本已進入 productCosts；舊價目表成本欄位已移除。\n` +
            '歷史估價與訂單快照未修改。';
    } catch (err) {
        console.error('Product Master 遷移失敗：', err);
        if (status) status.innerText = '遷移中斷：' + err.message + '。此流程可安全重新執行，已寫入資料會以相同 productId 更新，不會重複建立。';
        alert('Product Master 遷移未完成，請確認網路與 Firestore 權限後重新執行。');
    } finally {
        productMasterMigrationRunning = false;
        if (button) button.disabled = false;
        if (previewButton) previewButton.disabled = false;
    }
};

/* ---------- 價格表管理 ---------- */
function formatPriceCatalogTime(value) {
    if (!value) return '舊資料未記錄';
    const raw = typeof value.toDate === 'function' ? value.toDate() : new Date(value);
    if (Number.isNaN(raw.getTime())) return '舊資料未記錄';
    return raw.toLocaleString('zh-TW', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false });
}

function renderPriceCatalogSummary() {
    const tbody = document.getElementById('adminPriceCatalogBody');
    if (!tbody) return;
    tbody.innerHTML = priceCatalogMeta.length ? priceCatalogMeta.map(item => `
        <tr>
            <td>${escapeHtml(item.name)}</td>
            <td>${escapeHtml(formatPriceCatalogTime(item.updatedAt))}</td>
            <td class="no-print"><button type="button" class="btn-danger" data-brand="${escapeAttr(item.name)}" onclick="deletePriceBrand(this.dataset.brand)">刪除這份價格表</button></td>
        </tr>
    `).join('') : '<tr><td colspan="3" style="color:#888;">目前雲端沒有價格表。</td></tr>';
}

// 價格表管理頁只讀取輕量索引；不再為了顯示清單下載所有價格明細。
window.loadPriceCatalogSummary = function() {
    const tbody = document.getElementById('adminPriceCatalogBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" style="color:#888;">載入中…</td></tr>';
    return db.collection('settings').doc('prices').get().then(async doc => {
        const meta = doc.exists ? doc.data() : {};
        if (meta.storage === 'brands' && Array.isArray(meta.brands)) {
            const catalogEntries = await Promise.all(meta.brands.map(async brand => {
                if (brand.updatedAt) return { name: brand.name, updatedAt: brand.updatedAt };
                const firstChunk = await db.collection('settings').doc(brand.id).get().catch(() => null);
                return { name: brand.name, updatedAt: firstChunk?.exists ? firstChunk.data().updatedAt : null };
            }));
            const unique = new Map();
            catalogEntries.forEach(entry => {
                const key = String(entry.name || '').trim().toLocaleLowerCase();
                const current = unique.get(key);
                const entryTime = entry.updatedAt?.toDate ? entry.updatedAt.toDate().getTime() : new Date(entry.updatedAt || 0).getTime();
                const currentTime = current?.updatedAt?.toDate ? current.updatedAt.toDate().getTime() : new Date(current?.updatedAt || 0).getTime();
                if (!current || entryTime > currentTime) unique.set(key, entry);
            });
            priceCatalogMeta = [...unique.values()];
        } else {
            const names = new Map();
            (meta.list || []).forEach(item => {
                const name = (item.brand || '未分類').trim() || '未分類';
                if (!names.has(name.toLocaleLowerCase())) names.set(name.toLocaleLowerCase(), name);
            });
            priceCatalogMeta = [...names.values()].map(name => ({ name, updatedAt: meta.updatedAt }));
        }
        priceCatalogMeta.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
        renderPriceCatalogSummary();
    }).catch(err => {
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="color:#c00;">載入失敗：${escapeHtml(err.message)}</td></tr>`;
    });
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

        priceList = priceList.filter(p => (p.brand || '').trim().toLocaleLowerCase() !== brandName.toLocaleLowerCase());
        refreshPriceDatalists();
        loadPriceCatalogSummary();
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

async function syncImportedBrandToFormalProductMaster(imported, storedBrand) {
    const canWriteFormalMaster = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    if (!canWriteFormalMaster) return;
    const now = new Date().toISOString();
    const operations = [];

    (imported || []).forEach(raw => {
        const item = normalizeProductMasterItem({ ...raw, brand: storedBrand });
        const product = productMasterRecordFromLegacyItem(item);
        product.status = item.active === false ? 'INACTIVE' : 'ACTIVE';
        product.legacySource = 'excel_import';
        product.updatedAt = now;
        operations.push(batch => batch.set(db.collection('products').doc(product.productId), product, { merge: true }));

        const cost = legacyCostRecord(item, product);
        if (cost) {
            cost.source = 'excel_import';
            cost.updatedAt = now;
            operations.push(batch => batch.set(db.collection('productCosts').doc(product.productId), cost, { merge: true }));
        }
    });
    await commitMigrationBatch(operations);
}

async function savePriceBrandList(imported, brand) {
    const maxBytes = 700 * 1024; // 留緩衝空間給欄位名稱等額外開銷，避免貼近 1MB 上限
    const priceDoc = db.collection('settings').doc('prices');
    const doc = await priceDoc.get();
    const meta = doc.exists ? doc.data() : {};
    const currentBrands = Array.isArray(meta.brands) ? meta.brands : [];
    const matchingEntry = currentBrands.find(item => String(item.name || '').trim().toLocaleLowerCase() === brand.toLocaleLowerCase());
    // 廠牌名稱不分大小寫；如雲端已有 Thermo，上傳 thermo 會直接更新原本那份。
    const storedBrand = matchingEntry?.name || brand;
    const normalizedItems = normalizeProductMasterList(imported.map(item => ({ ...item, brand: storedBrand })));
    // 舊 settings 僅保留業務需要的產品/售價資料；成本改存 productCosts。
    const publicItems = normalizedItems.map(legacyPriceItemWithoutCost);
    const chunks = chunkPriceItems(publicItems, maxBytes);
    const brandId = matchingEntry?.id || priceBrandDocumentId(storedBrand);
    const chunkDocId = (index) => index === 0 ? brandId : `${brandId}-part${index}`;
    const updatedAt = new Date().toISOString();

    for (let i = 0; i < chunks.length; i++) {
        setPriceUploadProgress(85 + Math.round(((i + 1) / chunks.length) * 10), `正在儲存「${brand}」價目表（第 ${i + 1}/${chunks.length} 個分片）…`);
        await db.collection('settings').doc(chunkDocId(i)).set({
            brand: storedBrand, items: chunks[i], updatedAt,
            chunkIndex: i, chunkCount: chunks.length
        });
    }

    const brands = currentBrands.filter(item => item.id !== brandId && String(item.name || '').trim().toLocaleLowerCase() !== storedBrand.toLocaleLowerCase());
    const previousEntry = matchingEntry || currentBrands.find(item => item.id === brandId);
    const previousChunkCount = (previousEntry && previousEntry.chunkCount) || 1;

    // 若這次上傳的分片數比上次少，刪除多出來的舊分片文件，避免留下用不到的雲端資料。
    for (let i = chunks.length; i < previousChunkCount; i++) {
        await db.collection('settings').doc(chunkDocId(i)).delete().catch(() => {});
    }

    brands.push({ id: brandId, name: storedBrand, chunkCount: chunks.length, itemCount: normalizedItems.length, updatedAt });
    brands.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
    await priceDoc.set({
        // 舊版 list 暫時保留，尚未個別上傳的廠牌仍可正常讀取；同廠牌的新資料會優先取代舊資料。
        storage: 'brands', brands, updatedAt
    }, { merge: true });
    await syncImportedBrandToFormalProductMaster(normalizedItems, storedBrand);
    return storedBrand;
}

let pendingPriceImportPreview = null;

function summarizeProductMasterImport(groups) {
    const existingById = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
    let added = 0, updated = 0, inactive = 0;
    const brands = groups.map(group => {
        let brandAdded = 0, brandUpdated = 0;
        group.imported.forEach(raw => {
            const item = normalizeProductMasterItem(raw);
            if (existingById.has(item.productId)) { updated++; brandUpdated++; } else { added++; brandAdded++; }
            if (!item.active) inactive++;
        });
        return { brand: group.brand, count: group.imported.length, added: brandAdded, updated: brandUpdated };
    });
    return { added, updated, inactive, total: added + updated, brands };
}

function confirmProductMasterImport(groups) {
    const summary = summarizeProductMasterImport(groups);
    const lines = summary.brands.map(item => `${item.brand}：${item.count} 筆（新增 ${item.added}／更新 ${item.updated}）`);
    return confirm(`Product Master 匯入預覽\n\n${lines.join('\n')}\n\n合計 ${summary.total} 筆：新增 ${summary.added}、更新 ${summary.updated}、停用標記 ${summary.inactive}。\n\n同廠牌會以本次 Excel 內容更新；歷史估價單與訂單保存的是當時快照，不會被改寫。確定寫入雲端嗎？`);
}

window.handlePriceExcelUpload = async function(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        input.value = '';
        return;
    }

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
                    const productType = String(getField(row, ['類型', '產品類型', '品項類型', '機器/耗材', '仪器/耗材', 'Type'])).trim();
                    const productLine = String(getField(row, ['產品線', '产品线', '產品類別', '产品类别', 'Product Line', 'ProductLine'])).trim();
                    const spec = String(getField(row, ['規格', '规格', 'Spec', 'Specification'])).trim();
                    const supplier = String(getField(row, ['供應商', '供应商', 'Supplier', 'Vendor'])).trim();
                    const unit = String(getField(row, ['單位', '单位', 'Unit'])).trim();
                    const activeRaw = String(getField(row, ['啟用', '启用', 'Active', 'Status'])).trim().toLocaleLowerCase();
                    const yes = value => ['1', 'true', 'yes', 'y', '是', '啟用', '启用'].includes(String(value || '').trim().toLocaleLowerCase());
                    const inventoryTracked = yes(getField(row, ['庫存管理', '库存管理', 'Inventory Tracked', 'Inventory']));
                    const lotTracked = yes(getField(row, ['批號管理', '批号管理', 'Lot Tracked', 'Lot']));
                    const expiryTracked = yes(getField(row, ['效期管理', 'Expiry Tracked', 'Expiry']));

                    const price = parseFloat(getField(row, ['含稅單價', '單價', '價格'])) || 0;
                    const costRaw = getField(row, ['含稅成本', '成本', '進貨成本']);
                    const cost = costRaw === '' ? null : parseFloat(costRaw) || 0;

                    if (nameCn || nameEn || model) {
                        imported.push({ nameCn, nameEn, model, brand, productType, productLine, spec, supplier, unit, inventoryTracked, lotTracked, expiryTracked, active: activeRaw ? !['0','false','no','n','否','停用'].includes(activeRaw) : true, price, cost });
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

            if (!confirmProductMasterImport(brandGroups)) {
                setPriceUploadProgress(0, '已取消，尚未寫入雲端。', false);
                input.value = '';
                return;
            }

            const savedBrands = [];
            for (let i = 0; i < brandGroups.length; i++) {
                const { brand, imported } = brandGroups[i];
                const basePercent = 55 + Math.round((i / brandGroups.length) * 40);
                setPriceUploadProgress(basePercent, `正在儲存「${brand}」（${i + 1}/${brandGroups.length} 個廠牌）的 ${imported.length} 筆資料…`);
                const storedBrand = await savePriceBrandList(imported, brand);
                // 直接更新本機清單，其他廠牌不受這次上傳影響。
                const normalizedImported = normalizeProductMasterList(imported.map(item => ({ ...item, brand: storedBrand })));
                const visibleImported = (currentUserRole === 'admin' || currentUserRole === 'purchaser')
                    ? normalizedImported
                    : normalizedImported.map(legacyPriceItemWithoutCost);
                priceList = priceList.filter(item => (item.brand || '').trim().toLocaleLowerCase() !== storedBrand.toLocaleLowerCase()).concat(visibleImported);
                savedBrands.push(`${storedBrand}（${imported.length} 筆）`);
            }

            refreshPriceDatalists();
            loadPriceCatalogSummary();
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
let adminQuotesCursor = null;
let adminQuotesHasMore = false;
let adminQuotesPageLoading = false;

function updateAdminQuotesLoadMoreButton() {
    const button = document.getElementById('adminQuotesLoadMoreBtn');
    if (!button) return;
    button.style.display = adminQuotesHasMore ? '' : 'none';
    button.disabled = adminQuotesPageLoading;
    button.innerText = adminQuotesPageLoading ? '載入中…' : '載入更多（每次 50 筆）';
}

async function loadAdminQuotesPage(reset) {
    if (adminQuotesPageLoading) return;
    if (reset) {
        adminQuotesCursor = null;
        adminQuotesHasMore = true;
        allQuotesCache = [];
    }
    if (!adminQuotesHasMore) return;
    adminQuotesPageLoading = true;
    updateAdminQuotesLoadMoreButton();
    try {
        let query = db.collection('quotes').orderBy('quoteDate', 'desc').limit(DEFAULT_LIST_LIMIT);
        if (adminQuotesCursor) query = query.startAfter(adminQuotesCursor);
        const snapshot = await query.get();
        if (!snapshot.empty) adminQuotesCursor = snapshot.docs[snapshot.docs.length - 1];
        const records = new Map(allQuotesCache.map(quote => [quote.id, quote]));
        snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));
        allQuotesCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'quoteDate', 'quoteNo'));
        adminQuotesHasMore = snapshot.size === DEFAULT_LIST_LIMIT;
        renderAdminQuotesList();
    } catch (err) {
        console.error(err);
        alert('讀取估價單記錄失敗，請確認 Firestore 權限設定。');
    } finally {
        adminQuotesPageLoading = false;
        updateAdminQuotesLoadMoreButton();
    }
}

window.loadAllQuotesFromCloud = function() {
    return loadAdminQuotesPage(true);
};

window.loadMoreAdminQuotes = function() {
    return loadAdminQuotesPage(false);
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
                <button type="button" class="btn-small btn-secondary" onclick="copyQuoteAsNew('${escapeAttr(q.quoteNo)}')">複製</button>
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
