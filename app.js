// 三個公司的估價專用章圖片，直接以 Base64 內嵌（避免產生 PDF 時外部圖片造成畫布跨來源污染，無法匯出）
const STAMP_YUSHIN = "assets/stamps/yushin.png";
const STAMP_MORNINGSTAR = "assets/stamps/morningstar.png";
const STAMP_MULTI_LIFE = "assets/stamps/multi-life.png";


// app.js - 估價單系統 / 儀器管理系統 核心邏輯

const FIREBASE_CONFIGS = Object.freeze({
    production: {
        apiKey: "AIzaSyAmGAU2spWI54ujLyIFTWiX-mXyuau7Vps",
        authDomain: "yu-shing-company.firebaseapp.com",
        projectId: "yu-shing-company",
        storageBucket: "yu-shing-company.firebasestorage.app",
        messagingSenderId: "22622213823",
        appId: "1:22622213823:web:c3f0a9c367a88e271ed80a",
        measurementId: "G-861X26VW6M"
    },
    preview: {
        apiKey: "AIzaSyDSbSZiwiHmdgi6146vqpfE84JgWU1KhK8",
        authDomain: "preview-20135.firebaseapp.com",
        projectId: "preview-20135",
        storageBucket: "preview-20135.firebasestorage.app",
        messagingSenderId: "546566883230",
        appId: "1:546566883230:web:396c28f1f01ada0a1c788f"
    }
});

function resolveAppEnvironment() {
    const host = String(window.location.hostname || '').toLowerCase();
    return host === 'preview-20135.web.app' || host === 'preview-20135.firebaseapp.com'
        ? 'preview'
        : 'production';
}
const APP_ENVIRONMENT = resolveAppEnvironment();
const firebaseConfig = FIREBASE_CONFIGS[APP_ENVIRONMENT];

if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.firestore();
// 這套系統在部分實際使用網路環境持續出現 Firestore WebChannel transport error。
// Firebase 官方提供 forceLongPolling 用於避開 Proxy／防毒／網路設備對長連線的相容性問題。
// 必須在任何 Firestore 讀寫前設定；不要同時啟用 autoDetectLongPolling。
try {
    db.settings({
        experimentalForceLongPolling: true,
        useFetchStreams: false
    });
} catch (err) {
    console.warn('Firestore long polling 設定未套用：', err);
}
if (APP_ENVIRONMENT === 'preview') {
    document.documentElement.dataset.appEnvironment = 'preview';
    window.addEventListener('DOMContentLoaded', () => {
        const banner = document.getElementById('previewEnvironmentBanner');
        if (banner) banner.hidden = false;
    });
}

// 啟動時由 SDK 還原既有 session；手動登入前才指定 LOCAL，避免 iOS 初始化競爭。
// iPhone 主畫面網站有自己的儲存空間；請求持續保存可降低系統回收登入資料的機率。
let homeScreenStoragePersistencePromise = null;
function requestHomeScreenStoragePersistence() {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;
    if (!standalone || !navigator.storage?.persist || homeScreenStoragePersistencePromise) return;
    homeScreenStoragePersistencePromise = Promise.resolve()
        .then(() => navigator.storage.persisted?.() || false)
        .then(persisted => persisted || navigator.storage.persist())
        .catch(err => console.warn('主畫面網站儲存保留未啟用：', err));
}

let currentCompany = 'yushin';
let restoringQuoteDraft = false;  // 還原本機草稿的過程中，暫停「重新產生單號」之類的副作用，避免蓋掉草稿裡存的資料
let activeQuoteOptionalFields = new Set();
let restoringOrderDraft = false;
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
    { key: 'products', label: '產品管理', system: true },
    { key: 'orders', label: '📦 訂單管理系統', system: true },
    { key: 'orders.list', label: '　業務訂單' },
    { key: 'orders.po', label: '　採購訂單' },
    { key: 'inventory', label: '📦 庫存管理', system: true },
    { key: 'equipment', label: '🔬 儀器管理系統', system: true },
    { key: 'admin', label: '⚙️ 管理員雲端後台', system: true }
];
// 固定角色權限：前端顯示/查詢與 Firestore Rules 使用同一角色邊界。
// 不再從 settings/rolePermissions 動態載入，避免設定漂移，也減少登入時一次 Firestore 讀取。
const rolePermissions = Object.freeze({
    sales: Object.freeze({ forecast:'edit', quote:'edit', 'quote.create':'edit', 'quote.my':'edit', products:'view', orders:'edit', 'orders.list':'edit', 'orders.po':'none', inventory:'none', equipment:'edit', admin:'none' }),
    purchaser: Object.freeze({ forecast:'none', quote:'edit', 'quote.create':'edit', 'quote.my':'view', products:'view', orders:'edit', 'orders.list':'edit', 'orders.po':'edit', inventory:'edit', equipment:'none', admin:'none' }),
    warehouse: Object.freeze({ forecast:'none', quote:'none', 'quote.create':'none', 'quote.my':'none', products:'view', orders:'view', 'orders.list':'view', 'orders.po':'view', inventory:'edit', equipment:'none', admin:'none' }),
    engineer: Object.freeze({ forecast:'none', quote:'edit', 'quote.create':'edit', 'quote.my':'edit', products:'view', orders:'edit', 'orders.list':'edit', 'orders.po':'none', inventory:'none', equipment:'edit', admin:'none' })
});
const roleDataScopes = Object.freeze({
    sales: Object.freeze({ quotes:'own', forecasts:'own', orders:'own', equipment:'own' }),
    purchaser: Object.freeze({ quotes:'all', forecasts:'none', orders:'all', equipment:'none' }),
    warehouse: Object.freeze({ quotes:'none', forecasts:'none', orders:'all', equipment:'none' }),
    engineer: Object.freeze({ quotes:'own', forecasts:'none', orders:'own', equipment:'all' })
});
let currentUserName = '';    // 目前登入者自己的業務姓名（來自 users 集合）
let currentUserPhone = '';   // 目前登入者自己的電話
let currentUserCode = '';    // 目前登入者自己的業務代號
let appInitialized = false;  // 避免每次登入狀態變化都重複初始化頁面資料
let pendingTab = null;
let salesListLoadPromise = null;
let quickProductTarget = null;
let quoteFormInitialized = false;
const APP_CACHE_VERSION = 1;
const APP_ASSET_VERSION = (() => {
    try {
        const script = [...document.scripts].find(node => /\/app\.js(?:\?|$)/.test(node.src || ''));
        return script ? (new URL(script.src, window.location.href).searchParams.get('v') || '') : '';
    } catch (_) { return ''; }
})();
window.YUSHIN_APP_VERSION = APP_ASSET_VERSION;
function renderSystemVersionLabel() {
    const label = document.getElementById('systemVersionLabel');
    if (!label) return;
    label.textContent = APP_ASSET_VERSION ? `系統版本 ${APP_ASSET_VERSION}` : '系統版本未標示';
}
renderSystemVersionLabel();
const APP_DATA_CACHE_PREFIX = 'yushin-data-cache:';
const APP_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function appDataCacheKey(kind, uid = currentUser?.uid || 'anonymous', role = currentUserRole || 'unknown') {
    return `${APP_DATA_CACHE_PREFIX}v${APP_CACHE_VERSION}:${uid}:${role}:${kind}`;
}
function readAppDataCache(kind, options = {}) {
    try {
        const raw = localStorage.getItem(appDataCacheKey(kind));
        if (!raw) return null;
        const cached = JSON.parse(raw);
        if (!cached || !Array.isArray(cached.records)) return null;
        const age = Date.now() - Number(cached.savedAt || 0);
        if (!options.allowStale && age > APP_CACHE_MAX_AGE_MS) return null;
        return cached;
    } catch (_) { return null; }
}
function writeAppDataCache(kind, records = []) {
    try {
        localStorage.setItem(appDataCacheKey(kind), JSON.stringify({
            savedAt: Date.now(),
            records: Array.isArray(records) ? records.slice(0, DEFAULT_LIST_LIMIT) : []
        }));
    } catch (_) {}
}
function clearAppDataCacheForCurrentUser() {
    const uid = currentUser?.uid;
    if (!uid) return;
    try {
        Object.keys(localStorage).forEach(key => {
            if (key.startsWith(APP_DATA_CACHE_PREFIX) && key.includes(`:${uid}:`)) localStorage.removeItem(key);
        });
    } catch (_) {}
}

const USER_PROFILE_CACHE_PREFIX = 'yushin-user-profile:';
function userProfileCacheKey(uid) { return uid ? USER_PROFILE_CACHE_PREFIX + uid : ''; }
function readCachedUserProfile(uid) {
    try {
        const data=JSON.parse(localStorage.getItem(userProfileCacheKey(uid))||'null');
        return data && ['admin','sales','purchaser','warehouse','engineer'].includes(data.role) ? data : null;
    } catch (_) { return null; }
}
function writeCachedUserProfile(uid, data={}) {
    if(!uid)return;
    try {
        localStorage.setItem(userProfileCacheKey(uid),JSON.stringify({
            role:data.role||'sales',name:data.name||'',phone:data.phone||'',code:data.code||'',mustChangePassword:!!data.mustChangePassword
        }));
    } catch (_) {}
}
function applyUserProfile(data={}) {
    currentUserRole=data.role||'sales';
    trueUserRole=currentUserRole;
    currentUserName=data.name||'';
    currentUserPhone=data.phone||'';
    currentUserCode=data.code||'';
    mustChangePassword=!!data.mustChangePassword;
}
const DEFAULT_LIST_LIMIT = 50;
const DEFAULT_SEARCH_DEBOUNCE_MS = 350;
const FIRESTORE_READ_TIMEOUT_MS = 15000;

// 全系統清單搜尋統一規則：一般列表每頁 50 筆；輸入搜尋延遲 350ms。
// 各模組只保留「如何查資料」的差異，不再自行定義 debounce 時間。
function scheduleListSearch(timer, callback, delay = DEFAULT_SEARCH_DEBOUNCE_MS) {
    clearTimeout(timer);
    return setTimeout(callback, delay);
}
const DEFAULT_CURRENCY = 'TWD';
const DEFAULT_TAX_RATE = 0.05;
const BUSINESS_STATUS = Object.freeze({
    ACTIVE: 'active',
    COMPLETED: 'completed',
    CANCELLED: 'cancelled',
    VOIDED: 'voided'
});

function firestoreReadWithTimeout(readPromise, label = '資料') {
    let timeoutId;
    const timeoutPromise = new Promise((resolve, reject) => {
        timeoutId = setTimeout(() => {
            const error = new Error(`${label}讀取逾時，請重新整理後再試。`);
            error.code = 'firestore-read-timeout';
            reject(error);
        }, FIRESTORE_READ_TIMEOUT_MS);
    });
    return Promise.race([readPromise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

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
let equipmentPageLoading = false;
let equipmentCursor = null;
let equipmentHasMore = false;
let equipmentSearchActive = false;
let equipmentSearchLoading = false;
let equipmentSearchKeyword = '';
let equipmentSearchResults = [];
let equipmentSearchTimer = null;
let equipmentSearchGeneration = 0;

// 管理員後台狀態
let allUsersCache = [];
let salesCodeMasterCache = [];
let salesStatisticsOrders = [];
let salesStatisticsLoadPromise = null;
let inventoryAnalysisReceipts = [];
let inventoryAnalysisStocks = [];
let inventoryAnalysisLots = [];
let inventoryAnalysisLotCosts = new Map();
let inventoryAnalysisSupplyOrders = [];
let inventoryAnalysisDirectShipSupplyOrders = [];
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
let purchaseCostCache = new Map();

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
        printBtn.addEventListener('click', exportCurrentQuotePdf);
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

    // 訂單／估價單／訂購單的「更多」選單共用同一組事件代理：
    // 全站同一時間只開一個；點擊外部、完成選擇或按 Esc 都會收起。
    const moreMenuSelector = '.order-more-menu, .quote-more-menu, .po-more-menu';
    const openMoreMenuSelector = '.order-more-menu[open], .quote-more-menu[open], .po-more-menu[open]';
    document.addEventListener('toggle', event => {
        const openedMenu = event.target.closest?.(moreMenuSelector);
        if (!openedMenu?.open) return;
        document.querySelectorAll(openMoreMenuSelector).forEach(menu => {
            if (menu !== openedMenu) menu.open = false;
        });
    }, true);
    document.addEventListener('click', event => {
        const menu = event.target.closest?.(moreMenuSelector);
        if (!menu) {
            document.querySelectorAll(openMoreMenuSelector).forEach(openMenu => { openMenu.open = false; });
            return;
        }
        if (event.target.closest('.order-more-menu-popover button, .quote-more-menu-popover button, .po-more-menu-popover button')) {
            menu.open = false;
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll(openMoreMenuSelector).forEach(menu => { menu.open = false; });
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

    // 新增訂單也採本機自動暫存。依 Firebase UID 分開儲存，避免共用電腦時
    // 不同使用者看到彼此尚未送出的草稿。
    const orderModal = document.getElementById('orderModalOverlay');
    if (orderModal) {
        let orderDraftSaveTimer = null;
        const scheduleOrderDraftSave = event => {
            if (restoringOrderDraft || !orderModal.classList.contains('active')) return;
            if (event?.target?.closest('.order-draft-tools')) return;
            clearTimeout(orderDraftSaveTimer);
            orderDraftSaveTimer = setTimeout(saveOrderDraft, 400);
        };
        orderModal.addEventListener('input', scheduleOrderDraftSave);
        orderModal.addEventListener('change', event => {
            scheduleOrderDraftSave(event);
            
        });
    }

    // 監控登入狀態：未登入顯示登入畫面，登入後依角色初始化系統
    firebase.auth().onAuthStateChanged(function(user) {
        if (user) {
            currentUser = user;
            // Returning sessions can render immediately from a small local profile cache.
            // Firestore is still authoritative; permissions are refreshed before any new session data is trusted.
            const cachedProfile=readCachedUserProfile(user.uid);
            if(cachedProfile){applyUserProfile(cachedProfile);showApp();}
            firestoreReadWithTimeout(
                db.collection('users').doc(user.uid).get(),
                '登入狀態驗證'
            ).then(doc => {
                if (firebase.auth().currentUser?.uid !== user.uid) return;
                if (!doc.exists) throw new Error('找不到此 UID 對應的 users 文件');
                const d = doc.data() || {};
                // Firebase Auth 的 LOCAL session 會長期保留；帳號是否仍可使用由 users 文件控制。
                // 管理員停用帳號後，即使裝置還保有 Auth session，也要在背景驗證時立即退出。
                if (d.disabled === true || d.active === false) {
                    try { localStorage.removeItem(userProfileCacheKey(user.uid)); } catch (_) {}
                    clearAppDataCacheForCurrentUser();
                    return firebase.auth().signOut().then(() => {
                        const errorEl = document.getElementById('loginError');
                        if (errorEl) errorEl.innerText = '此帳號已由管理員停用。';
                    });
                }
                applyUserProfile(d);
                writeCachedUserProfile(user.uid,d);
                requestHomeScreenStoragePersistence();
                showApp();
                if (mustChangePassword) openChangePasswordModal(true);

                // 把自己的登入 Email 同步存回自己的 users 文件，這樣管理員雲端後台才查得到每個帳號的 Email
                // （用來寄送密碼重設信）；只寫自己的資料，不影響、也不需要動到別人的帳號
                if (user.email && d.email !== user.email) {
                    db.collection('users').doc(user.uid).set({ email: user.email }, { merge: true })
                        .catch(err => console.error('同步 Email 失敗：', err));
                }
            }).catch(err => {
                console.error('讀取登入帳號資料失敗：', err);
                // Auth 仍有效且已有本機 profile 時，Firestore 暫時離線不能把使用者踢回登入頁。
                // 保留既有畫面；所有真正的資料寫入仍會由 Firestore / Rules 驗證。
                if (cachedProfile && firebase.auth().currentUser?.uid === user.uid) {
                    applyUserProfile(cachedProfile);
                    showApp();
                    const authLabel=document.getElementById('authUserLabel');
                    if(authLabel)authLabel.title='Firestore 暫時無法連線；目前使用已快取的帳號資料，連線恢復後會重新驗證。';
                    return;
                }
                showAuthWaiting('已保留登入狀態，但暫時無法讀取帳號資料。請檢查網路後重新連線。');
            });
        } else {
            currentUser = null;
            currentUserRole = null;
            trueUserRole = null;
            currentUserName = '';
            currentUserPhone = '';
            currentUserCode = '';
            lastShowAppInitKey = '';
            showLoginScreen();
        }
    });
});

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

// V2 capabilities: role names are mapped once here instead of scattering role === 'sales'
// checks throughout commercial workflows. Firestore Rules mirror these boundaries.
function hasBusinessCapability(role = currentUserRole) {
    return role === 'admin' || role === 'sales' || role === 'engineer';
}
function canCreateForecastCapability(role = currentUserRole) {
    return role === 'admin' || role === 'sales';
}
function canSelfOrderCapability(role = currentUserRole) {
    return hasBusinessCapability(role);
}
function canManageOrderLifecycleCapability(role = currentUserRole) {
    return hasBusinessCapability(role);
}
function canCreatePurchaseOrderCapability(role = currentUserRole) {
    return role === 'admin' || role === 'purchaser';
}
function canReceiveInventoryCapability(role = currentUserRole) {
    return role === 'admin' || role === 'purchaser' || role === 'warehouse';
}
function canManageEquipmentCapability(role = currentUserRole) {
    return role === 'admin' || role === 'engineer';
}

function commercialCreatorFields() {
    return {
        createdByUid: currentUser?.uid || '',
        createdByName: currentUserName || '',
        createdByRole: currentUserRole || ''
    };
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
    if (hasBusinessCapability()) {
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
    if (section.id === 'order-system') return 'orders.list';
    if (section.id === 'purchasing-system') return 'orders.po';
    if (section.id === 'forecast-system') return 'forecast';
    if (section.id === 'product-system') return 'products';
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
    if (pageKey === 'orders.po' && currentUserRole === 'warehouse' && canReceiveInventoryCapability()) {
        notice.innerText = '📦 倉管模式：可以確認到貨與入庫；建立採購單、補庫採購與打單仍由採購或管理員處理。';
    } else {
        notice.innerText = '🔒 此分頁目前為「僅可查看」，您可以瀏覽與搜尋，但不能新增、修改或刪除資料。';
    }
    section.prepend(notice);
}

function firstAccessibleMainPage() {
    return ['quote', 'forecast', 'products', 'orders', 'orders.po', 'inventory', 'equipment'].find(canAccessPage) || (currentUserRole === 'admin' ? 'admin' : '');
}

function showLoginScreen() {
    const authStarting = document.getElementById('authStarting');
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    if (authStarting) authStarting.style.display = 'none';
    if (loginScreen) loginScreen.style.display = 'flex';
    if (appContainer) appContainer.style.display = 'none';

    const pwField = document.getElementById('loginPassword');
    if (pwField) pwField.value = '';
}

function showAuthWaiting(message) {
    const authStarting = document.getElementById('authStarting');
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    if (authStarting) authStarting.style.display = 'flex';
    if (loginScreen) loginScreen.style.display = 'none';
    if (appContainer) appContainer.style.display = 'none';
    const label = document.getElementById('authStartingMessage');
    if (label) label.textContent = message;
    const retry = document.getElementById('authStartingRetry');
    if (retry) retry.hidden = false;
}

function showApp() {
    const authStarting = document.getElementById('authStarting');
    const loginScreen = document.getElementById('loginScreen');
    const appContainer = document.getElementById('appContainer');
    if (authStarting) authStarting.style.display = 'none';
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
    const activeMainKey = activeSection ? { 'forecast-system':'forecast', 'quote-system':'quote', 'product-system':'products', 'order-system':'orders.list', 'purchasing-system':'orders.po', 'inventory-system':'inventory', 'equipment-system':'equipment', 'admin-system':'admin' }[activeSection.id] : '';
    if (activeMainKey && !canAccessPage(activeMainKey)) {
        const fallback = firstAccessibleMainPage();
        const fallbackId = { forecast:'forecast-system', quote:'quote-system', products:'product-system', orders:'order-system', 'orders.po':'purchasing-system', inventory:'inventory-system', equipment:'equipment-system', admin:'admin-system' }[fallback];
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

    // 採購／管理員可查看業務訂單的成本／毛利；供應商訂購流程集中在獨立採購工作台。
    const orderCostFieldWrap = document.getElementById('orderCostFieldWrap');
    if (orderCostFieldWrap) {
        orderCostFieldWrap.style.display = (currentUserRole === 'purchaser' || currentUserRole === 'admin') ? '' : 'none';
    }
    if (!appInitialized) {
        appInitialized = true;
        initDate();
    }
    if (activeMainKey && canAccessPage(activeMainKey)) {
        const initKey=`${currentUser?.uid||''}:${currentUserRole||''}:${activeMainKey}`;
        if (lastShowAppInitKey !== initKey) {
            lastShowAppInitKey = initKey;
            initializePageData(activeMainKey);
        }
    }
}

let lastShowAppInitKey = '';
const loadedMainPages = new Set();

function hydratePageFromLocalCache(mainKey) {
    // Gmail-style stale-while-revalidate: cached content paints immediately; Firestore refresh follows in background.
    if (mainKey === 'orders.list' && !ordersCache.length) {
        const cached = readAppDataCache('orders');
        if (cached?.records?.length) {
            ordersCache = cached.records;
            renderOrdersList();
        }
    }
    if (mainKey === 'forecast' && !forecastCache.length) {
        const cached = readAppDataCache('forecasts');
        if (cached?.records?.length) {
            forecastCache = cached.records;
            renderForecastList();
        }
    }
    if (mainKey === 'quote' && !myQuotesCache.length) {
        const cached = readAppDataCache('quotes');
        if (cached?.records?.length) {
            myQuotesCache = cached.records;
            if (document.getElementById('myQuotesPanel')?.style.display === 'block') renderMyQuotesList();
        }
    }
    if (mainKey === 'equipment' && !equipmentList.length) {
        const cached = readAppDataCache('equipment');
        if (cached?.records?.length) {
            equipmentList = cached.records;
            renderEquipmentList();
        }
    }
    if (mainKey === 'inventory' && !inventoryCache.length) {
        const cached = readAppDataCache('inventory');
        if (cached?.records?.length) {
            inventoryCache = cached.records;
            renderInventoryList();
        }
    }
    if (mainKey === 'orders.po') {
        // 採購工作卡與訂單頁共用 ordersCache；先用同一份本機快取立即顯示，
        // 再由 Firestore 背景更新，避免進採購頁時先看到「…」或另一套數字。
        if (!ordersCache.length) {
            const orderCache = readAppDataCache('orders');
            if (orderCache?.records?.length) ordersCache = orderCache.records;
        }
        // 第一次初始化下一步會立即 switchPurchasingView() 並重畫；
        // 回到已載入頁面時 DOM 仍保留，不在 hydrate 階段重複掃 ordersCache。
    }
}

function initializePageData(mainKey, options = {}) {
    const force = options.force === true;
    hydratePageFromLocalCache(mainKey);
    if (!force && loadedMainPages.has(mainKey)) return;
    loadedMainPages.add(mainKey);
    if (['quote', 'forecast', 'orders.list', 'inventory', 'equipment', 'admin'].includes(mainKey)) {
        ensureBrandSettingsLoaded().then(() => {
            if (mainKey === 'forecast' && canAccessPage('forecast')) renderForecastList();
            if (mainKey === 'orders.list' && canAccessPage('orders.list')) renderOrdersList();
            if (mainKey === 'inventory' && canAccessPage('inventory')) renderInventoryList();
            if (mainKey === 'equipment' && canAccessPage('equipment')) renderEquipmentList();
        }).catch(err => console.warn('廠牌設定載入失敗：', err));
    }
    if (mainKey === 'forecast') {
        // 一般業務只看自己，不需要讀完整 users 名單；只有可看全公司 Forecast 的角色才補齊業務篩選。
        loadForecasts(true);
        if (canViewAllData('forecast')) {
            ensureSalesListLoaded().then(populateForecastSalesFilter).catch(err => console.warn('業務名單載入失敗：', err));
        } else {
            populateForecastSalesFilter();
        }
    }
    if (mainKey === 'quote') ensureQuoteFormInitialized();
    if (mainKey === 'products') {
        clearProductManagementSearch({ preserveInput: true });
        updatePendingProductMasterButton();
    }
    if (mainKey === 'orders.list') {
        // 訂單列表本身不需要完整 Product Master。先載 50 筆訂單，避免 iPhone 每次進頁
        // 都等待 Product Master 與大量 datalist DOM 建立完成才顯示資料。
        if (canViewAllData('orders')) {
            ensureSalesListLoaded().then(() => {
                if (canAccessPage('orders.list')) renderOrdersList();
            }).catch(err => console.warn('業務名單載入失敗：', err));
        }
        loadOrdersFromCloud();
        // 廠牌資料由上方共用 ensureBrandSettingsLoaded() 處理；
        // 不再另外掛一個 loadBrandMaster().then(renderOrdersList)，避免同一批品牌完成時重畫兩次。
    }
    if (mainKey === 'orders.po') {
        // 採購頁只啟動一個共用 orders 背景更新；各工作分頁都沿用同一份 ordersCache。
        // 先立即畫快取，業務名單＋品牌設定在背景完成後只補畫一次，避免手機重複掃同一批訂單。
        switchPurchasingView(canCreatePurchaseOrderCapability() ? 'ordering' : 'receiving');
        Promise.allSettled([ensureSalesListLoaded(), ensureBrandSettingsLoaded()]).then(results => {
            const failed = results.filter(result => result.status === 'rejected');
            failed.forEach(result => console.warn('採購頁背景設定載入失敗：', result.reason));
            // 人員／品牌完成只會改變篩選選項；目前沒有選擇篩選時，不需要把整批訂單再 normalize / 重算一次。
            if (canAccessPage('orders.po')) populatePurchasingFilters();
        });
    }
    if (mainKey === 'inventory') {
        loadInventory(true);
        // Brand Master 已由上方 ensureBrandSettingsLoaded() 共用載入；
        // 完成後會統一 renderInventoryList，不再額外重畫一次。
    }
    if (mainKey === 'equipment') {
        // 儀器列表先載入；只有能看全公司儀器的身份才需要完整 users 名單。
        // 一般業務／工程師直接使用登入者姓名與業務代號，避免每次進頁都掃 users。
        loadEquipmentFromCloud();
        if (canViewAllEquipment()) {
            ensureSalesListLoaded()
                .then(() => { populateEquipmentSalesDropdown(); renderEquipmentList(); })
                .catch(err => console.warn('業務名單載入失敗：', err));
        } else {
            populateEquipmentSalesDropdown();
        }
        // Brand Master 已由上方 ensureBrandSettingsLoaded() 共用載入與重畫。
    }
    if (mainKey === 'admin') reloadSalesFromUsers();
}

function ensureSalesListLoaded() {
    if (!salesListLoadPromise) {
        salesListLoadPromise = initSalesList().catch(err => {
            // 失敗不能永久快取 rejected Promise；下次真正需要人員名單時允許重試。
            salesListLoadPromise = null;
            throw err;
        });
    }
    return salesListLoadPromise;
}

function ensureQuoteFormInitialized() {
    if (quoteFormInitialized) return;
    quoteFormInitialized = true;
    // 表單與草稿本身不依賴完整業務名單；先顯示可操作畫面，人員選單在背景補齊。
    const draft = loadQuoteDraft();
    if (draft) restoreQuoteDraft(draft);
    else {
        const savedValidDays = localStorage.getItem('quote_valid_days');
        if (savedValidDays) document.getElementById('validDays').value = savedValidDays;
        if (!document.getElementById('quoteItems').rows.length) addQuoteRow();
        switchCompany('yushin');
    }
    if (currentUserRole === 'admin' || currentUserRole === 'purchaser' || currentUserRole === 'engineer') {
        ensureSalesListLoaded().then(() => {
            populateSalesDropdown();
            if (draft) restoreQuoteDraft(draft);
        }).catch(err => console.warn('業務名單載入失敗：', err));
    } else {
        // 業務只能選自己；登入 profile 已含姓名、代號與電話，
        // 不為了單一選項再掃完整 users collection。
        populateSalesDropdown();
        if (draft) restoreQuoteDraft(draft);
    }
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

window.handleLogin = async function() {
    const email = (document.getElementById('loginEmail').value || '').trim();
    const password = document.getElementById('loginPassword').value || '';
    const errorEl = document.getElementById('loginError');
    const button = document.querySelector('#loginScreen button');
    if (errorEl) errorEl.innerText = '';

    if (!email || !password) {
        if (errorEl) errorEl.innerText = '請輸入帳號與密碼';
        return;
    }

    const originalText = button?.textContent || '登入';
    if (button) { button.disabled = true; button.textContent = '登入中…'; }
    if (errorEl) errorEl.innerText = '正在驗證帳號…';
    try {
        const credential = await Promise.race([
            firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL)
                .then(() => firebase.auth().signInWithEmailAndPassword(email, password)),
            new Promise((_, reject) => setTimeout(() => {
                const err = new Error('Firebase Auth 登入逾時');
                err.code = 'auth/login-timeout';
                reject(err);
            }, 15000))
        ]);
        currentUser = credential.user;
        if (errorEl) errorEl.innerText = '帳號驗證完成，正在載入使用者資料…';
        const cachedProfile = readCachedUserProfile(currentUser.uid);
        if (cachedProfile) {
            applyUserProfile(cachedProfile);
            showApp();
        }
        // onAuthStateChanged 仍是 session 恢復的主要入口；手動登入時直接觸發相同 profile 讀取，
        // 避免部分 iOS Safari 已完成 Auth 卻延遲送出 auth-state callback。
        const doc = await firestoreReadWithTimeout(
            db.collection('users').doc(currentUser.uid).get(),
            '登入帳號資料'
        );
        if (!doc.exists) throw new Error('找不到此 UID 對應的 users 文件');
        const d = doc.data() || {};
        if (d.disabled === true || d.active === false) {
            await firebase.auth().signOut();
            throw new Error('此帳號已由管理員停用。');
        }
        applyUserProfile(d);
        writeCachedUserProfile(currentUser.uid, d);
        requestHomeScreenStoragePersistence();
        showApp();
        if (mustChangePassword) openChangePasswordModal(true);
    } catch (err) {
        console.error('登入失敗：', err);
        if (errorEl) {
            if (err?.code === 'auth/login-timeout') errorEl.innerText = '登入服務連線逾時，請確認網路後再試。';
            else if (err?.code === 'firestore-read-timeout') errorEl.innerText = '帳號已驗證，但使用者資料讀取逾時，請再試一次。';
            else if (err?.code === 'auth/wrong-password' || err?.code === 'auth/user-not-found' || err?.code === 'auth/invalid-credential') errorEl.innerText = '登入失敗，請確認帳號密碼是否正確。';
            else errorEl.innerText = err?.message || '登入失敗，請稍後再試。';
        }
    } finally {
        if (button) { button.disabled = false; button.textContent = originalText; }
    }
};

window.handleLogout = function() {
    clearAppDataCacheForCurrentUser();
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
        requestAnimationFrame(() => window.scrollTo(0, Number(state.scrollY) || 0));
    } finally {
        restoringBrowserNavigation = false;
    }
});

let appBackgroundedAt = 0;
let appResumeTimer = null;

function revalidateCurrentUserAccess() {
    const user = firebase.auth().currentUser;
    if (!user) return Promise.resolve();
    return firestoreReadWithTimeout(
        db.collection('users').doc(user.uid).get(),
        '帳號狀態驗證'
    ).then(doc => {
        if (firebase.auth().currentUser?.uid !== user.uid) return;
        const d = doc.exists ? (doc.data() || {}) : null;
        if (!d || d.disabled === true || d.active === false) {
            try { localStorage.removeItem(userProfileCacheKey(user.uid)); } catch (_) {}
            clearAppDataCacheForCurrentUser();
            return firebase.auth().signOut().then(() => {
                const errorEl = document.getElementById('loginError');
                if (errorEl) errorEl.innerText = '此帳號已由管理員停用。';
            });
        }
        applyUserProfile(d);
        writeCachedUserProfile(user.uid, d);
    }).catch(err => {
        // 網路暫時失敗不登出：維持 Gmail 式長期登入，等下次恢復前景再驗證。
        console.warn('背景驗證帳號狀態失敗：', err);
    });
}

function recoverVisibleAppAfterResume() {
    if (document.visibilityState === 'hidden' || !appBackgroundedAt) return;
    const backgroundDuration = Date.now() - appBackgroundedAt;
    appBackgroundedAt = 0;
    clearTimeout(appResumeTimer);
    appResumeTimer = setTimeout(() => {
        const appContainer = document.getElementById('appContainer');
        if (currentUser && backgroundDuration >= 5000) revalidateCurrentUserAccess();
        if (currentUser && appContainer) {
            // 觸發一次很短的合成層重繪，修復部分 iOS Safari 從背景回來只顯示白色快照的情況。
            appContainer.classList.remove('resume-repaint');
            void appContainer.offsetHeight;
            appContainer.classList.add('resume-repaint');
            setTimeout(() => appContainer.classList.remove('resume-repaint'), 180);
        }

        const activeSection = document.querySelector('.content-section.active');
        const orderListVisible = activeSection?.id === 'order-system'
            && document.getElementById('orderListPanel')?.style.display !== 'none';
        if (currentUser && orderListVisible && (orderPageLoading || backgroundDuration >= 5000)) {
            loadOrderPage(true, { force: true, silent: true });
        }
    }, 80);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
        appBackgroundedAt = Date.now();
    } else {
        recoverVisibleAppAfterResume();
    }
});

window.addEventListener('pageshow', event => {
    if (event.persisted && !appBackgroundedAt) appBackgroundedAt = Date.now() - 5000;
    recoverVisibleAppAfterResume();
});

// 「檢視身份」切換：只是把畫面上用來判斷權限/欄位的 currentUserRole 換成別的角色，
// 讓管理員可以確認/測試各角色實際看到的畫面長怎樣。真正的身份還是 trueUserRole，
// 這裡不會改動 Firebase 帳號本身，Firestore 的存取權限仍然是照登入帳號真正的角色在判斷。
window.switchViewRole = function(role) {
    if (trueUserRole !== 'admin') return;
    currentUserRole = role;
    // 先清掉前一個視角的分頁狀態，避免非同步查詢完成前短暫顯示不屬於新視角的資料。
    loadedMainPages.clear();
    lastShowAppInitKey = '';
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
        pendingPurchaseCache = [];
    pendingPurchaseCursor = null;
    pendingPurchaseHasMore = true;
    pendingPurchaseError = '';
    poListCache = [];
    poListCursor = null;
    poListHasMore = false;
    poHistorySearchResults = [];
    poHistorySearchActive = false;
    poHistorySearchLoading = false;
    supplyReceivingCache = [];
    supplyReceivingCursor = null;
    supplyReceivingHasMore = true;
    receivingSourceOrderStatusCache = new Map();
    receivingSourceOrderCache = new Map();
    purchasingReceivingReady = false;
    purchasingOrdersReady = false;
    purchasingDispatchCache = [];
    purchasingDispatchCursor = null;
    purchasingDispatchHasMore = true;
    purchasingDispatchError = '';
    purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT;
    purchasingViewLoaded.clear();
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
    const mainKey = { 'forecast-system':'forecast', 'quote-system':'quote', 'product-system':'products', 'order-system':'orders.list', 'purchasing-system':'orders.po', 'inventory-system':'inventory', 'equipment-system':'equipment', 'admin-system':'admin' }[tabId];
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
        if (!options.skipReload) initializePageData('inventory');
    } else if (tabId === 'forecast-system') {
        if (!options.skipReload) initializePageData('forecast');
    } else if (tabId === 'equipment-system') {
        if (!options.skipReload) initializePageData('equipment');
    } else if (tabId === 'product-system') {
        if (!options.skipReload) initializePageData('products');
    } else if (tabId === 'order-system') {
        if (!options.skipReload) initializePageData('orders.list');
    } else if (tabId === 'purchasing-system') {
        if (!options.skipReload) initializePageData('orders.po');
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
   產品管理：唯讀 Product Master 搜尋
   - 直接查 Firestore products，不依賴目前已載入的 500 筆快取
   - 不讀 productCosts，避免一般業務畫面暴露成本
   ========================================================= */
let productManagementResults = [];
let productManagementSearchInProgress = false;
let productManagementSearchTimer = null;
let productManagementSearchGeneration = 0;
const PRODUCT_MANAGEMENT_RENDER_STEP = 100;
let productManagementVisibleLimit = PRODUCT_MANAGEMENT_RENDER_STEP;

let pendingProductMasterLoading = false;
let pendingProductMasterRows = [];
let productBatchMaintenanceInProgress = false;

function setProductBatchMaintenanceBusy(busy) {
    productBatchMaintenanceInProgress = !!busy;
    document.querySelectorAll('#productBatchMaintenance button').forEach(button => {
        button.disabled = productBatchMaintenanceInProgress;
    });
}

function canManagePendingProductMaster() {
    return currentUserRole === 'admin' || currentUserRole === 'purchaser';
}

function updatePendingProductMasterButton() {
    const allowed = canManagePendingProductMaster();
    const pendingButton = document.getElementById('pendingProductMasterBtn');
    const createButton = document.getElementById('createProductMasterBtn');
    const batchMaintenance = document.getElementById('productBatchMaintenance');
    if (pendingButton) pendingButton.style.display = allowed ? '' : 'none';
    if (createButton) createButton.style.display = allowed ? '' : 'none';
    if (batchMaintenance) batchMaintenance.style.display = allowed ? '' : 'none';
}

function pendingProductKey(item = {}) {
    const brand = normalizeBrandLookupKey(item.brand || '');
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
    head.innerHTML = mode === 'pending'
        ? '<tr><th>貨號</th><th>品名</th><th>廠牌</th><th>來源</th><th>最近使用</th><th>次數</th><th class="no-print">操作</th></tr>'
        : '<tr><th>貨號</th><th>品名</th><th>廠牌</th><th>產品線</th><th>類型</th><th>規格</th><th>建議售價</th><th>狀態</th><th class="no-print">快速操作</th></tr>';
    const moreRow = document.getElementById('productManagementMoreRow');
    if (moreRow && mode === 'pending') moreRow.style.display = 'none';
}

function renderPendingProductMasterRows() {
    setProductManagementTableMode('pending');
    const body = document.getElementById('productManagementBody');
    if (!body) return;
    if (!pendingProductMasterRows.length) {
        body.innerHTML = '<tr><td colspan="7" class="empty-hint">目前沒有待補 Product Master 的近期品項。</td></tr>';
        return;
    }
    body.innerHTML = pendingProductMasterRows.map((row,index) => `<tr>
        <td data-th="貨號">${escapeHtml(row.itemCode || '－')}</td>
        <td data-th="品名">${escapeHtml(row.itemName || '－')}</td>
        <td data-th="廠牌">${escapeHtml(row.brand || '－')}</td>
        <td data-th="來源">${escapeHtml(row.sources.join('、'))}</td>
        <td data-th="最近使用">${escapeHtml(row.latestDate || '－')}</td>
        <td data-th="次數">${row.count}</td>
        <td data-th="操作" class="no-print">${canManagePendingProductMaster() ? `<button type="button" class="btn-small" onclick="openPendingProductMasterEditor(${index})">補主檔</button>` : ''}</td>
    </tr>`).join('');
}

window.loadPendingProductMaster = async function() {
    if (!canManagePendingProductMaster() || pendingProductMasterLoading) return;
    const button = document.getElementById('pendingProductMasterBtn');
    const status = document.getElementById('productManagementSearchStatus');
    pendingProductMasterLoading = true;
    if (button) { button.disabled = true; button.textContent = '讀取中…'; }
    if (status) status.textContent = '正在讀取近期待補品項…';
    try {
        // 只有主動按下才查；兩個集合各最多 50 張，不掃描全部歷史資料。
        const [quoteSnap, orderSnap] = await Promise.all([
            firestoreReadWithTimeout(
                db.collection('quotes').where('productMasterMatched', '==', false).limit(50).get(),
                '待補 Product Master－估價單'
            ),
            firestoreReadWithTimeout(
                db.collection('orders').where('productMasterMatched', '==', false).limit(50).get(),
                '待補 Product Master－訂單'
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
                '核對待補 Product Master'
            );
            snap.docs.forEach(doc => {
                const data = doc.data() || {};
                if (data.status === 'INACTIVE' || data.active === false) return;
                existingKeys.add(`${normalizeBrandLookupKey(data.brandName || data.brand || '')}::${data.normalizedPartNo || normalizeItemCodeLoose(data.manufacturerPartNo || data.sku || '')}`);
            });
        }
        rows = rows.filter(row => {
            const code = normalizeItemCodeLoose(row.itemCode);
            if (!code) return true;
            return !existingKeys.has(`${normalizeBrandLookupKey(row.brand || '')}::${code}`);
        });

        const grouped = new Map();
        rows.forEach(row => {
            const key = row.key || `${row.sourceType}::${row.reference}::${row.itemCode}::${row.itemName}`;
            const current = grouped.get(key) || {
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
            ? `待補 Product Master：${pendingProductMasterRows.length} 個近期品項。`
            : '目前沒有近期待補品項。';
    } catch (err) {
        console.error('讀取待補 Product Master 失敗：', err);
        if (status) status.textContent = '待補清單讀取失敗，請稍後再試。';
    } finally {
        pendingProductMasterLoading = false;
        if (button) { button.disabled = false; button.textContent = '待補 Product Master'; }
    }
};

function productManagementRow(product) {
    const productId = product.productId || product.id || '';
    const price = Number(product.listPrice ?? product.price ?? 0);
    const status = product.status || (product.active === false ? 'INACTIVE' : 'ACTIVE');
    return `<tr>
      <td data-th="貨號">${escapeHtml(product.manufacturerPartNo || product.sku || '')}</td>
      <td data-th="品名">${escapeHtml(product.productName || product.nameCn || product.nameEn || '')}</td>
      <td data-th="廠牌">${escapeHtml(product.brandName || product.brand || '')}</td>
      <td data-th="產品線">${escapeHtml(product.productLine || '未分類')}</td>
      <td data-th="類型">${escapeHtml(product.productType || product.category || '未分類')}</td>
      <td data-th="規格">${escapeHtml(product.specification || product.spec || '')}</td>
      <td data-th="建議售價">${price ? price.toLocaleString() : '－'}</td>
      <td data-th="狀態">${escapeHtml(status === 'TEMPORARY' ? '待補主檔' : status === 'INACTIVE' ? '停用' : '啟用')}</td>
      <td data-th="快速操作" class="no-print product-management-actions">
        ${canAccessPage('quote.create') ? `<button type="button" class="btn-small" onclick="addProductManagementToQuote('${escapeAttr(productId)}')">加入估價單</button>` : ''}
        ${canAccessPage('orders.list') ? `<button type="button" class="btn-small btn-secondary" onclick="addProductManagementToOrder('${escapeAttr(productId)}')">建立訂單</button>` : ''}
        ${canManagePendingProductMaster() ? `<button type="button" class="btn-small btn-secondary" onclick="openProductMasterEditor('${escapeAttr(productId)}')">編輯主檔</button>` : ''}
      </td>
    </tr>`;
}

function updateProductManagementMoreButton() {
    const row = document.getElementById('productManagementMoreRow');
    const button = document.getElementById('productManagementMoreBtn');
    if (!row || !button) return;
    const visible = Math.min(productManagementVisibleLimit, productManagementResults.length);
    const hasMore = productManagementResults.length > visible;
    row.style.display = hasMore ? '' : 'none';
    button.disabled = productManagementSearchInProgress;
    button.textContent = hasMore
        ? `載入更多結果（目前 ${visible} / ${productManagementResults.length}）`
        : '載入更多結果';
}

function renderProductManagementResults() {
    setProductManagementTableMode('products');
    const body = document.getElementById('productManagementBody');
    if (!body) return;
    const visibleResults = productManagementResults.slice(0, productManagementVisibleLimit);
    body.innerHTML = visibleResults.length
        ? visibleResults.map(productManagementRow).join('')
        : '<tr><td colspan="9" class="empty-hint">查無符合產品。</td></tr>';
    updateProductManagementMoreButton();
}

window.loadMoreProductManagementResults = function() {
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
    pendingProductMasterRows = [];
    setProductManagementTableMode('products');
    const input = document.getElementById('productManagementSearch');
    const status = document.getElementById('productManagementSearchStatus');
    const body = document.getElementById('productManagementBody');
    const button = document.getElementById('productManagementSearchBtn');
    if (input && !options.preserveInput) input.value = '';
    if (status) status.textContent = '';
    if (body) body.innerHTML = '<tr><td colspan="9" class="empty-hint">輸入貨號或品名開始搜尋。</td></tr>';
    if (button) { button.disabled = false; button.textContent = '搜尋產品'; }
};

window.queueProductManagementSearch = function() {
    clearTimeout(productManagementSearchTimer);
    const input = document.getElementById('productManagementSearch');
    const raw = String(input?.value || '').trim();
    if (raw.length < 2) {
        clearProductManagementSearch({ preserveInput: true });
        const status = document.getElementById('productManagementSearchStatus');
        if (status && raw.length) status.textContent = '再輸入 1 個字即可搜尋。';
        return;
    }
    productManagementSearchTimer = scheduleListSearch(productManagementSearchTimer, () => searchProductManagement());
};

window.searchProductManagement = async function() {
    if (!canAccessPage('products')) return;
    const generation = ++productManagementSearchGeneration;
    clearTimeout(productManagementSearchTimer);
    pendingProductMasterRows = [];
    const input = document.getElementById('productManagementSearch');
    const button = document.getElementById('productManagementSearchBtn');
    const status = document.getElementById('productManagementSearchStatus');
    const raw = String(input?.value || '').trim();
    if (raw.length < 2) {
        productManagementSearchInProgress = false;
        if (status) status.textContent = '請至少輸入 2 個字或完整貨號。';
        return;
    }

    productManagementSearchInProgress = true;
    productManagementVisibleLimit = PRODUCT_MANAGEMENT_RENDER_STEP;
    if (button) { button.disabled = true; button.textContent = '搜尋中…'; }
    if (status) status.textContent = '正在搜尋完整 Product Master…';

    const map = new Map();
    let checked = 0;
    let lastIntermediateRenderAt = 0;
    const canSeeInactive = canManagePendingProductMaster();
    const addDocs = docs => {
        (docs || []).forEach(doc => {
            const data = { id:doc.id, ...doc.data() };
            if (canSeeInactive || (data.status !== 'INACTIVE' && data.active !== false)) map.set(doc.id, data);
        });
        // 三條 prefix query 會平行分頁；大量資料時不要每 50 筆就重排＋重建整張表。
        // 搜尋途中最多約每 100ms 更新一次，完成時再做最後完整 render。
        const now = Date.now();
        if (now - lastIntermediateRenderAt >= 100) {
            lastIntermediateRenderAt = now;
            productManagementResults = [...map.values()]
                .sort((a,b) => String(a.manufacturerPartNo || '').localeCompare(String(b.manufacturerPartNo || ''), 'zh-Hant'));
            renderProductManagementResults();
            if (status) status.textContent = `搜尋中：已檢查 ${checked} 筆候選資料，找到 ${productManagementResults.length} 筆…`;
        }
    };

    const scanPrefix = async (field, value, label) => {
        if (!value) return;
        let cursor = null;
        while (true) {
            let query = db.collection('products')
                .orderBy(field)
                .startAt(value)
                .endAt(value + '\uf8ff')
                .limit(DEFAULT_LIST_LIMIT);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), label);
            if (generation !== productManagementSearchGeneration) return;
            checked += snapshot.size;
            addDocs(snapshot.docs);
            if (snapshot.size < DEFAULT_LIST_LIMIT) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
            await Promise.resolve();
        }
    };

    try {
        const normalized = normalizeItemCodeLoose(raw);
        await Promise.all([
            scanPrefix('normalizedPartNo', normalized, '產品貨號搜尋'),
            scanPrefix('productName', raw, '產品中文品名搜尋'),
            scanPrefix('nameEn', raw, '產品英文品名搜尋')
        ]);
        if (generation !== productManagementSearchGeneration) return;
        productManagementResults = [...map.values()]
            .sort((a,b) => String(a.manufacturerPartNo || '').localeCompare(String(b.manufacturerPartNo || ''), 'zh-Hant'));
        renderProductManagementResults();
        if (status) {
            const visible = Math.min(productManagementVisibleLimit, productManagementResults.length);
            status.textContent = visible < productManagementResults.length
                ? `完成，共 ${productManagementResults.length} 筆；目前顯示 ${visible} 筆。`
                : `完成，共 ${productManagementResults.length} 筆。`;
        }
    } catch (err) {
        if (generation !== productManagementSearchGeneration) return;
        console.error('產品管理搜尋失敗：', err);
        productManagementResults = [];
        renderProductManagementResults();
        if (status) status.textContent = '搜尋失敗，請稍後再試。';
    } finally {
        if (generation === productManagementSearchGeneration) {
            productManagementSearchInProgress = false;
            if (button) { button.disabled = false; button.textContent = '搜尋產品'; }
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
    overlay.innerHTML = `
      <div class="eq-modal-box" style="max-width:760px;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;">
          <h3 id="productMasterEditorTitle" style="margin:0;">Product Master</h3>
          <button type="button" class="btn-secondary" onclick="closeProductMasterEditor()">✕ 關閉</button>
        </div>
        <input type="hidden" id="pmEditProductId">
        <input type="hidden" id="pmEditCreatedAt">
        <input type="hidden" id="pmEditSource">
        <div class="form-grid" style="margin-top:14px;">
          <div><label>廠牌 *</label><input id="pmEditBrand" type="text" list="quickProductBrandList" autocomplete="off"></div>
          <div><label>原廠貨號 *</label><input id="pmEditCode" type="text" autocomplete="off"></div>
          <div><label>中文品名 *</label><input id="pmEditNameCn" type="text" autocomplete="off"></div>
          <div><label>英文品名</label><input id="pmEditNameEn" type="text" autocomplete="off"></div>
          <div style="grid-column:1/-1;"><label>規格／包裝</label><input id="pmEditSpec" type="text" autocomplete="off"></div>
          <div><label>產品線 *</label><input id="pmEditProductLine" type="text" placeholder="例如：Flow Cytometry"></div>
          <div><label>產品類型</label><input id="pmEditProductType" type="text" list="pmProductTypeList" placeholder="例如：Reagent"></div>
          <datalist id="pmProductTypeList">
            <option value="Instrument"></option><option value="Reagent"></option><option value="Consumable"></option>
            <option value="Accessory"></option><option value="Service"></option>
          </datalist>
          <div><label>建議售價（含稅）</label><input id="pmEditListPrice" type="number" min="0" step="0.01"></div>
          <div><label>代理屬性</label>
            <select id="pmEditAuthorization">
              <option value="AUTHORIZED">代理產品</option>
              <option value="NON_AUTHORIZED">非代理產品</option>
            </select>
          </div>
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

function populateProductMasterEditor(product = {}, options = {}) {
    const overlay = ensureProductMasterEditor();
    const source = product.source || options.source || 'MANUAL';
    document.getElementById('pmEditProductId').value = product.productId || product.id || '';
    document.getElementById('pmEditCreatedAt').value = product.createdAt || '';
    document.getElementById('pmEditSource').value = source;
    const existingIdentity = !!(product.productId || product.id);
    const brandInput = document.getElementById('pmEditBrand');
    const codeInput = document.getElementById('pmEditCode');
    brandInput.value = product.brandName || product.brand || options.brand || '';
    codeInput.value = product.manufacturerPartNo || product.sku || options.itemCode || '';
    brandInput.disabled = existingIdentity;
    codeInput.disabled = existingIdentity;
    document.getElementById('pmEditNameCn').value = product.productName || product.nameCn || options.itemName || '';
    document.getElementById('pmEditNameEn').value = product.nameEn || '';
    document.getElementById('pmEditSpec').value = product.specification || product.spec || '';
    document.getElementById('pmEditProductLine').value = product.productLine || '';
    document.getElementById('pmEditProductType').value = product.productType || product.category || '';
    document.getElementById('pmEditListPrice').value = product.listPrice ?? product.price ?? '';
    const inferredAuthorization = product.authorizationType
        || (isBrandAuthorizedForCurrentCompany(product.brandName || product.brand || options.brand || '') ? 'AUTHORIZED' : 'NON_AUTHORIZED');
    document.getElementById('pmEditAuthorization').value = inferredAuthorization;
    document.getElementById('pmEditStatus').value = product.status === 'INACTIVE' || product.active === false ? 'INACTIVE' : 'ACTIVE';
    document.getElementById('pmEditInventoryTracked').checked = product.inventoryTracked === true;
    document.getElementById('pmEditLotTracked').checked = product.lotTracked === true;
    document.getElementById('pmEditExpiryTracked').checked = product.expiryTracked === true;
    document.getElementById('productMasterEditorTitle').textContent = product.productId || product.id ? '編輯 Product Master' : '建立 Product Master';
    document.getElementById('pmEditMeta').textContent =
        `來源：${source || 'MANUAL'}${product.updatedAt ? '　最後更新：' + product.updatedAt : ''}`
        + (existingIdentity ? '　｜　廠牌與原廠貨號為產品身分；如貨號變更請建立新產品。' : '');
    overlay.classList.add('active');
}

window.openNewProductMasterEditor = function() {
    if (!canManagePendingProductMaster()) return;
    populateProductMasterEditor({}, { source:'MANUAL' });
};

window.openProductMasterEditor = async function(productId) {
    if (!canManagePendingProductMaster()) return;
    let product = productManagementResults.find(item => (item.productId || item.id) === productId);
    if (!product && productId) {
        const snap = await firestoreReadWithTimeout(db.collection('products').doc(productId).get(), '讀取 Product Master');
        if (snap.exists) product = { id:snap.id, ...snap.data() };
    }
    if (!product) { alert('找不到這筆 Product Master。'); return; }
    populateProductMasterEditor(product);
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

window.saveProductMasterEditor = async function() {
    if (!canManagePendingProductMaster()) return;
    const button = document.getElementById('saveProductMasterEditorBtn');
    const brand = resolveBrandName(document.getElementById('pmEditBrand').value || '');
    const code = String(document.getElementById('pmEditCode').value || '').trim();
    const productName = String(document.getElementById('pmEditNameCn').value || '').trim();
    const productLine = String(document.getElementById('pmEditProductLine').value || '').trim();
    if (!brand || !code || !productName || !productLine) {
        alert('請至少完成廠牌、原廠貨號、中文品名與產品線。');
        return;
    }

    const state = beginActionButton(button, '檢查中…');
    if (!state) return;
    try {
    const originalId = String(document.getElementById('pmEditProductId').value || '').trim();
    const normalizedPartNo = normalizeItemCodeLoose(code);
    const duplicateSnap = await firestoreReadWithTimeout(
        db.collection('products').where('normalizedPartNo', '==', normalizedPartNo).limit(20).get(),
        'Product Master 重複貨號檢查'
    );
    const duplicate = duplicateSnap.docs.find(doc => {
        if (doc.id === originalId) return false;
        const data = doc.data() || {};
        return normalizeBrandLookupKey(data.brandName || data.brand || '') === normalizeBrandLookupKey(brand);
    });
    if (duplicate) {
        alert('這個廠牌與貨號已經存在於 Product Master，請直接編輯既有產品。');
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
        productType: normalizeProductTypeValue(document.getElementById('pmEditProductType').value || ''),
        category: normalizeProductTypeValue(document.getElementById('pmEditProductType').value || ''),
        listPrice: Number(document.getElementById('pmEditListPrice').value || 0),
        authorizationType: document.getElementById('pmEditAuthorization').value || 'NON_AUTHORIZED',
        inventoryTracked: document.getElementById('pmEditInventoryTracked').checked,
        lotTracked: document.getElementById('pmEditLotTracked').checked,
        expiryTracked: document.getElementById('pmEditExpiryTracked').checked,
        status,
        active: status === 'ACTIVE',
        source: String(document.getElementById('pmEditSource').value || 'MANUAL').toUpperCase(),
        createdAt: document.getElementById('pmEditCreatedAt').value || now,
        ...(originalId ? {} : { createdBy: currentUser?.uid || '' }),
        updatedAt: now,
        updatedBy: currentUser?.uid || ''
    };

        if (button) button.textContent = '儲存中…';
        await db.collection('products').doc(productId).set(record, { merge:true });
        const cached = productMasterDocToPriceItem({ id:productId, data:() => record });
        cacheProductLookupItem(cached);
        const resultIndex = productManagementResults.findIndex(item => (item.productId || item.id) === productId);
        if (resultIndex >= 0) productManagementResults[resultIndex] = { id:productId, ...record };
        else productManagementResults.unshift({ id:productId, ...record });
        renderProductManagementResults();
        closeProductMasterEditor();
        const statusEl = document.getElementById('productManagementSearchStatus');
        if (statusEl) statusEl.textContent = status === 'INACTIVE'
            ? `已停用 Product Master：${brand} / ${code}；估價與訂單不再自動帶入。`
            : `已儲存 Product Master：${brand} / ${code}`;
    } catch (err) {
        console.error('儲存 Product Master 失敗：', err);
        alert('儲存 Product Master 失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, state);
    }
};

function productManagementSource(product) {
    return {
        productId: product.productId || product.id || '',
        model: product.manufacturerPartNo || product.sku || '',
        itemCode: product.manufacturerPartNo || product.sku || '',
        nameCn: product.productName || product.nameCn || '',
        nameEn: product.nameEn || '',
        itemName: product.productName || product.nameCn || product.nameEn || '',
        brand: product.brandName || product.brand || '',
        spec: product.specification || product.spec || '',
        price: Number(product.listPrice ?? product.price ?? 0),
        unitPrice: Number(product.listPrice ?? product.price ?? 0),
        qty: 1,
        productLine: product.productLine || '',
        productType: product.productType || product.category || '',
        authorizationType: product.authorizationType || '',
        productMasterMatched: true
    };
}

window.addProductManagementToQuote = function(productId) {
    const product = productManagementResults.find(item => (item.productId || item.id) === productId);
    if (!product || !canAccessPage('quote.create')) return;
    actuallySwitchMainTab('quote-system', document.querySelector('[data-main-nav="quote"]'));
    switchQuoteView('create', document.getElementById('qsub-create'), { skipHistory: true });
    ensureQuoteFormInitialized();
    addQuoteRow(productManagementSource(product));
    window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.addProductManagementToOrder = function(productId) {
    const product = productManagementResults.find(item => (item.productId || item.id) === productId);
    if (!product || !canAccessPage('orders.list')) return;
    openOrderWorkspace(document.querySelector('[data-main-nav="orders"]'));
    openOrderModal(productManagementSource(product));
};

window.openOrderWorkspace = function(el) {
    if (!canAccessPage('orders.list')) { alert('您沒有權限查看訂單。'); return; }
    switchMainTab('order-system', el);
};

window.openPurchasingWorkspace = function(el) {
    if (!canAccessPage('orders.po')) { alert('您沒有權限查看採購。'); return; }
    switchMainTab('purchasing-system', el);
};

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
// 全系統寫入按鍵共用狀態：立即顯示處理中、防止重複點擊，完成或失敗後一致恢復。
function beginActionButton(button, busyText = '處理中…') {
    if (!button || button.dataset.actionBusy === '1') return null;
    const state = { text: button.textContent, disabled: button.disabled };
    button.dataset.actionBusy = '1';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyText) button.textContent = busyText;
    return state;
}
function endActionButton(button, state, finalText = '') {
    if (!button || !state) return;
    button.dataset.actionBusy = '';
    button.removeAttribute('aria-busy');
    button.disabled = state.disabled;
    button.textContent = finalText || state.text;
}
function actionButtonFromEventOrSelector(selector = '') {
    const eventButton = window.event?.currentTarget?.closest?.('button');
    return eventButton || (selector ? document.querySelector(selector) : null);
}

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
    if (!select) return;

    const current = select.value;
    const brands = new Map();

    getPriceListBrands(false).forEach(brand => {
        const key = String(brand || '').trim().toLocaleLowerCase();
        if (key && !brands.has(key)) brands.set(key, brand);
    });

    const forecastRows = forecastHistorySearchActive ? forecastHistorySearchResults : forecastCache;
    forecastRows.forEach(item => {
        const brand = normalizeForecastBrand(item.brand || '');
        const key = brand.toLocaleLowerCase();
        if (key && !brands.has(key)) brands.set(key, brand);
    });

    const sortedBrands = [...brands.values()].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const signature = JSON.stringify(sortedBrands);
    if (signature !== forecastBrandFilterSignature) {
        select.innerHTML = '<option value="">全部廠牌</option>' + sortedBrands.map(brand =>
            `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`
        ).join('');
        forecastBrandFilterSignature = signature;
    }

    if (sortedBrands.includes(current)) select.value = current;
    else if (select.value && !sortedBrands.includes(select.value)) select.value = '';
}

function populateForecastSalesFilter() {
    const select = document.getElementById('forecastSalesFilter');
    if (!select) return;

    const canSeeAll = canViewAllData('forecast');
    if (!canSeeAll) {
        const label = currentUserName || '我的 Forecast';
        const signature = JSON.stringify(['own', currentUserName || '', label]);
        if (signature !== forecastSalesFilterSignature) {
            select.innerHTML = `<option value="${escapeAttr(currentUserName || '')}">${escapeHtml(label)}</option>`;
            forecastSalesFilterSignature = signature;
        }
        select.value = currentUserName || '';
        select.disabled = true;
        return;
    }

    const current = select.value;
    const names = new Set();

    salesList
        .filter(person => String(person.role || 'sales').toLowerCase() === 'sales')
        .forEach(person => {
            const name = stripPhoneSuffix(person.name || '');
            if (name) names.add(name);
        });

    select.disabled = false;
    const sortedNames = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const signature = JSON.stringify(['all', sortedNames]);
    if (signature !== forecastSalesFilterSignature) {
        select.innerHTML = '<option value="">全部業務</option>' + sortedNames.map(name =>
            `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`
        ).join('');
        forecastSalesFilterSignature = signature;
    }

    if (sortedNames.includes(current)) select.value = current;
    else if (select.value && !sortedNames.includes(select.value)) select.value = '';
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
    const refreshButton = document.getElementById('forecastRefreshBtn');

    if (button) {
        button.disabled = true;
        button.innerText = '載入中…';
    }
    if (refreshButton && reset) {
        refreshButton.disabled = true;
        refreshButton.innerText = '載入中…';
    }

    try {
        if (canViewAllData('forecast')) await ensureSalesListLoaded();
        else populateForecastSalesFilter();

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

        const snapshot = await firestoreReadWithTimeout(query.get(), 'Forecast 清單');

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
        writeAppDataCache('forecasts', forecastCache);
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
        if (refreshButton) {
            refreshButton.disabled = false;
            refreshButton.innerText = '↻ 更新';
        }
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
    const salesFilter = document.getElementById('forecastSalesFilter')?.value || '';
    const stageFilter = document.getElementById('forecastStageFilter')?.value || '';
    const periodFilter = document.getElementById('forecastPeriodFilter')?.value || 'this-year';

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
            ${trueUserRole === 'admin' && currentUserRole === 'admin' ? `<button type="button" class="btn-small danger-menu-item" onclick="permanentlyDeleteForecast('${escapeAttr(item.id)}')">永久刪除</button>` : ''}
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

        fragment.appendChild(row);
    });
    body.appendChild(fragment);

    const hint = document.getElementById('forecastEmptyHint');
    if (hint) hint.style.display = shown ? 'none' : 'block';
};

window.openForecastModal = function(id = '') {
    if (!canCreateForecastCapability() || !canEditPage('forecast')) return;

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
    if (forecastSaveInProgress || !canCreateForecastCapability() || !canEditPage('forecast')) return;

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
        alert('Forecast 儲存失敗：' + err.message);
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

window.permanentlyDeleteOrder = async function(orderId) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return;
    const order=ordersCache.find(row=>row.id===orderId);
    if(!order)return alert('找不到這筆訂單，請重新整理。');
    const hasFlow=savedDeliveryRecords(order).length>0||savedReturnRecords(order).length>0||
        normalizedOrderItems(order).some(item=>Number(item.supplyOrderedQty||0)>0||Number(item.receivedQty||0)>0);
    if(hasFlow)return alert('這筆訂單已有採購／到貨／送貨／退貨紀錄。為避免庫存帳失真，請使用「系統初始化」清除整批測試資料，或先處理相關流程。');
    if(!confirm(`永久刪除訂單「${order.orderNo||orderId}」？系統會先釋放未使用的庫存占用。此操作無法復原。`))return;
    try{
        if(normalizedOrderStatus(order)!=='cancelled'){
            await db.runTransaction(async tx=>{
                const ref=db.collection('orders').doc(orderId),snap=await tx.get(ref);
                if(!snap.exists)throw new Error('找不到這筆訂單。');
                await adjustInventoryReservationForLifecycle(tx,orderId,{id:orderId,...snap.data()},'cancelled',deliveryActor());
            });
        }
        const refs=normalizedOrderItems(order).map((item,index)=>db.collection('inventoryReservations').doc(`${orderId}__${String(item.itemId||`item-${index+1}`)}`));
        const batch=db.batch();refs.forEach(ref=>batch.delete(ref));batch.delete(db.collection('orders').doc(orderId));await batch.commit();
        ordersCache=ordersCache.filter(row=>row.id!==orderId);orderHistorySearchResults=orderHistorySearchResults.filter(row=>row.id!==orderId);renderOrdersList();
    }catch(err){alert('永久刪除失敗：'+(err.message||err));}
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
                'Forecast Product Master'
            );
            if (snap.exists) {
                const product = productMasterDocToPriceItem(snap);
                if (product.status !== 'INACTIVE' && product.active !== false) return cacheProductLookupItem(product);
            }
        } catch (err) {
            console.warn('Forecast Product Master 查詢失敗：', err);
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
        qty,
        unitPrice,
        totalPrice,
        costPrice: safeEmbeddedOrderCost(match, match?.cost),
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
    const normalizedItems = items.map((item, index) => {
        const source = forecastItemToOrderSource(forecast, item);
        return { ...normalizeNewOrderItem(source), itemId:'item-1', sourceItemIndex:index };
    }).filter(item => item.itemName || item.itemCode);
    if (!normalizedItems.length) throw new Error('Forecast 沒有可轉成訂單的品項。');

    const batch=db.batch();
    const created=[];
    normalizedItems.forEach((item,index)=>{
        const orderRef=db.collection('orders').doc();
        const totalPrice=Number(item.totalPrice||0);
        const orderData={
            orderDate,createdAt:now,...commercialCreatorFields(),company:currentCompany||'yushin',
            customerName:forecast.customerName||'',
            customerId:forecast.customerId||customerIdForName(forecast.customerName||''),
            ...item,qty:item.qty,unitPrice:item.unitPrice,totalPrice,
            items:[item],itemCount:1,orderSchemaVersion:2,
            status:BUSINESS_STATUS.ACTIVE,...grossAmountMetadata(totalPrice),
            transactionType:'',invoiceTitle:'',quoteNo:'',
            ...linkedDocumentFields(DOCUMENT_TYPES.FORECAST,forecast.id,[documentLink(DOCUMENT_TYPES.FORECAST,forecast.id,'source')]),
            sourceItemIndex:index,
            salesName:forecast.salesName||currentUserName||'',
            salesCode:forecast.salesCode||currentUserCode||'',
            ownerUid:forecast.ownerUid||currentUser?.uid||'',
            isDelivered:false,isBilled:false,invoiceDate:'',
            inventoryReservationStatus:'pending',
            inventoryReservationError:'',
            inventoryReservationUpdatedAt:now
        };
        orderData.searchTokens=buildFullHistorySearchTokens('order',orderData);
        batch.set(orderRef,orderData);
        batch.set(db.collection('forecasts').doc(forecast.id),{
            linkedDocuments:firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.ORDER,orderRef.id,'created')),
            updatedAt:now
        },{merge:true});
        created.push({id:orderRef.id,data:orderData});
    });
    await batch.commit();
    const reservationResults = await Promise.all(created.map(async order => {
        try {
            await reserveInventoryForNewOrder(order.id, order.data);
            const completedAt = new Date().toISOString();
            const updates = {
                inventoryReservationStatus:'completed',
                inventoryReservationError:'',
                inventoryReservationUpdatedAt:completedAt
            };
            await db.collection('orders').doc(order.id).set(updates,{merge:true});
            Object.assign(order.data, updates);
            return { id:order.id, status:'completed' };
        } catch (err) {
            const failedAt = new Date().toISOString();
            const updates = {
                inventoryReservationStatus:'failed',
                inventoryReservationError:String(err?.message||err),
                inventoryReservationUpdatedAt:failedAt
            };
            await db.collection('orders').doc(order.id).set(updates,{merge:true})
                .catch(markErr=>console.error('Forecast 訂單庫存占用失敗狀態寫入失敗：',markErr));
            Object.assign(order.data, updates);
            return { id:order.id, status:'failed', error:updates.inventoryReservationError };
        }
    }));
    ordersCache=[...created.map(order=>({id:order.id,...order.data})),...ordersCache.filter(order=>!created.some(createdOrder=>createdOrder.id===order.id))]
        .sort((x,y)=>String(y.orderDate||'').localeCompare(String(x.orderDate||'')));
    return {
        created,
        reservationFailures:reservationResults.filter(result=>result.status==='failed')
    };
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

        if (!confirm(`此 Forecast 含 ${items.length} 個品項，將拆成 ${items.length} 筆獨立訂單。確定繼續？`)) return;
        const result = await createForecastOrdersDirectly(forecast, items);
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        if (result.reservationFailures.length) {
            alert(`已建立 ${items.length} 筆訂單；其中 ${result.reservationFailures.length} 筆庫存占用未完成，訂單已標記為「庫存同步失敗」，請由管理員或採購在訂單頁重新同步，請勿重複建立訂單。`);
        } else {
            alert(`已將 Forecast 的 ${items.length} 個品項建立為 ${items.length} 筆獨立訂單，庫存占用已同步。`);
        }
        if (canAccessPage('orders.po') && canCreatePurchaseOrderCapability()) {
            loadPendingPurchaseOrders(true).catch(refreshErr => console.error('Forecast 轉訂單後採購背景刷新失敗', refreshErr));
        }
    } catch (err) {
        console.error('Forecast 轉訂單失敗', err);
        alert('Forecast 轉訂單失敗：' + err.message);
    }
};


/* =========================================================
   估價單系統
   ========================================================= */
// 業務名單來源改為 users 集合（與登入帳號綁定，name/code/phone/role 皆存在同一份文件）
function applySalesRows(rows) {
    const list = (rows || [])
        .filter(d => d.name && d.code && d.active !== false && d.disabled !== true)
        .map(d => ({ uid:d.id || d.uid || '', code:d.code, name:d.name, phone:d.phone || '', role:d.role || 'sales', active:true }));
    list.sort((a, b) => (a.code || '').localeCompare(b.code || ''));
    salesList = list;
    populateSalesDropdown();
    populateEquipmentSalesDropdown();
    return salesList;
}

function initSalesList() {
    // Admin 已讀過 users 時直接共用同一份記憶體資料，避免再次掃描 users collection。
    if (allUsersCache.length) {
        applySalesRows(allUsersCache.map(u => ({ id:u.uid, ...u })));
        return Promise.resolve(salesList);
    }
    return readCollectionInBatches('users').then(rows => applySalesRows(rows)).catch(err => {
        console.error('讀取 users 人員名單失敗：', err);
        // 短暫斷線時保留既有名單；不要把畫面上的業務選項清空。
        populateSalesDropdown();
        populateEquipmentSalesDropdown();
        throw err;
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
    setQuoteEditingContext('');
    setQuoteOutputStatus('');
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
    const quoteNoInput = document.getElementById('quoteNo');
    if (editingQuoteNo && !restoringQuoteDraft) {
        if (quoteNoInput) quoteNoInput.value = editingQuoteNo;
        return editingQuoteNo;
    }

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
        const snapshot = await firestoreReadWithTimeout(
            db.collection('quotes')
                .where('quoteNo', '>=', prefix)
                .where('quoteNo', '<=', prefix + '\uf8ff')
                .orderBy('quoteNo', 'desc')
                .limit(1)
                .get(),
            '估價單號'
        );

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
        if (quoteNoInput) quoteNoInput.value = `${prefix}${String(count).padStart(2, '0')}`;
        const outputStatus = document.getElementById('quoteOutputStatus');
        if (outputStatus?.classList.contains('is-error') && outputStatus.innerText.includes('無法取得安全的估價單號')) {
            setQuoteOutputStatus('');
        }
    } catch (e) {
        console.error('取得估價單號失敗：', e);
        if (quoteNoInput) quoteNoInput.value = '';
        setQuoteOutputStatus('無法取得安全的估價單號，請確認網路後再試一次。', true);
    }
    if (!restoringQuoteDraft) saveQuoteDraft();
    return quoteNoInput?.value || '';
};

window.onSalesChange = function() {
    if (!editingQuoteNo) generateQuoteNo();
    updateSalesPhoneDisplay();
};

// 估價單可歸屬業務或工程師：業務只開自己名下；工程師可開自己或協助業務；
 // 採購／管理員可代業務或工程師建立。
function populateSalesDropdown() {
    const select = document.getElementById('salesName');
    if (!select) return;

    const visibleList = salesList.filter(s => {
        const role = (s.role || 'sales').toLowerCase();
        if (currentUserRole === 'sales') return s.uid === currentUser?.uid;
        if (currentUserRole === 'engineer') return s.uid === currentUser?.uid || role === 'sales';
        return role === 'sales' || role === 'engineer';
    });

    if ((currentUserRole === 'sales' || currentUserRole === 'engineer') && currentUser?.uid && currentUserName
        && !visibleList.some(s => s.uid === currentUser.uid)) {
        visibleList.push({ uid: currentUser.uid, name: currentUserName, code: currentUserCode, role: currentUserRole });
    }

    const currentValue = select.value;
    select.innerHTML = '<option value="">請選擇負責業務</option>';
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
    // 保留有效的草稿選擇；本人登入時預設帶入自己，採購／管理員保持未選擇。
    select.value = visibleList.some(s => s.name === valueToApply) ? valueToApply
        : ((currentUserRole === 'sales' || currentUserRole === 'engineer') ? currentUserName : '');

    // 還原草稿與編輯既有估價單時都沿用原單號；只有真正的新單才重新取號。
    if (!restoringQuoteDraft && !editingQuoteNo) generateQuoteNo();
    updateSalesPhoneDisplay();
}

// 依目前輸入的業務姓名，更新旁邊顯示的電話號碼
function updateSalesPhoneDisplay() {
    const input = document.getElementById('salesName');
    const phoneSpan = document.getElementById('salesPhone');
    if (!input || !phoneSpan) return;

    const selectedName = input.value.trim();
    const match = salesList.find(s => s.name === selectedName);
    phoneSpan.innerText = match ? (match.phone || '')
        : (selectedName === currentUserName ? (currentUserPhone || '') : '');
}

function populateEquipmentSalesDropdown() {
    const select = document.getElementById('eqSales');
    if (!select) return;
    select.innerHTML = '<option value="">未指定業務</option>';
    const visibleList = canViewAllEquipment()
        ? salesList
        : (currentUserName ? [{ name:currentUserName, code:currentUserCode, phone:currentUserPhone }] : []);
    visibleList.forEach(s => {
        if (s.name) {
            const option = document.createElement('option');
            option.value = s.name;
            option.text = s.name;
            select.appendChild(option);
        }
    });
}

function loadCompanyAgencyBrandSettings() {
    return firestoreReadWithTimeout(
        db.collection('settings').doc('companyAgencyBrands').get(),
        '公司代理廠牌設定'
    ).then(doc => {
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
        // 代理廠牌設定只影響可選廠牌；不重建整份產品 datalist。
        // Product Master 真正新增／匯入時才呼叫 refreshPriceDatalists()。
    }).catch(() => {
        companyAgencyBrandsConfigured = false;
    });
}

function loadSalesStatisticsSettings() {
    return firestoreReadWithTimeout(
        db.collection('settings').doc('salesStatistics').get(),
        '重點廠牌設定'
    ).then(doc => {
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

let brandSettingsLoadPromise = null;
function ensureBrandSettingsLoaded() {
    if (!brandSettingsLoadPromise) {
        brandSettingsLoadPromise = Promise.all([
            loadSalesStatisticsSettings(), loadCompanyAgencyBrandSettings(), loadBrandMaster()
        ]).then(() => {
            populateQuoteBrandDropdowns();
            populateOrderBrandDropdown();
            populateEquipmentBrandDropdown();
            if (typeof populateForecastBrandDropdown === 'function')
                populateForecastBrandDropdown(document.getElementById('forecastBrand')?.value || '');
            renderCompanyAgencyBrandSettings();
        }).catch(err => {
            brandSettingsLoadPromise = null;
            throw err;
        });
    }
    return brandSettingsLoadPromise;
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
    // 唯一可選來源為管理員設定的主要代理廠牌；Product Master、歷史訂單、
    // 供應商對應及分公司勾選都不會自行擴大一般廠牌下拉選單。
    const entries = new Map();
    keyStatisticBrands.forEach(configuredName => {
        const name = String(configuredName || '').trim();
        const key = normalizeBrandLookupKey(name);
        if (!key || key === normalizeBrandLookupKey('維修') || entries.has(key)) return;
        const master = brandMasterCache.find(item => item.active !== false && (
            normalizeBrandLookupKey(item.name) === key ||
            (item.aliases || []).some(alias => normalizeBrandLookupKey(alias) === key)
        ));
        const canonicalName = master?.name || name;
        entries.set(normalizeBrandLookupKey(canonicalName), {
            id: master?.id || '', name: canonicalName,
            aliases: dedupeBrandsCaseInsensitive([name, ...(master?.aliases || []), ...(keyStatisticBrandAliases[name] || [])])
                .filter(alias => normalizeBrandLookupKey(alias) !== normalizeBrandLookupKey(canonicalName)),
            isKeyBrand: true,
            companies: ['yushin', 'morningstar', 'MULTI-LIFE'].filter(company =>
                includesBrandCaseInsensitive(companyAgencyBrands[company], canonicalName) ||
                includesBrandCaseInsensitive(companyAgencyBrands[company], name)
            ),
            active: true
        });
    });
    if (includeMaintenance) entries.set(normalizeBrandLookupKey('維修'), {
        id: '', name: '維修', aliases: [], isKeyBrand: false, companies: [], active: true
    });
    return [...entries.values()]
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

let warehouseMasterLoadPromise = null;

async function loadWarehouseMaster(force = false) {
    if (warehouseMasterLoadPromise && !force) return warehouseMasterLoadPromise;
    warehouseMasterLoadPromise = firestoreReadWithTimeout(
        db.collection('warehouses').limit(50).get(),
        '倉庫主檔'
    ).then(snapshot => {
        warehouseMasterCache = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(item => item.active !== false)
            .sort((a,b)=>Number(b.isDefault)-Number(a.isDefault)||String(a.warehouseName||'').localeCompare(String(b.warehouseName||''),'zh-Hant'));
        renderWarehouseMasterAdmin();
        populateOrderWarehouseOptions();
        return warehouseMasterCache;
    }).catch(err => {
        warehouseMasterLoadPromise = null;
        console.warn('讀取倉庫主檔失敗：', err);
        return warehouseMasterCache;
    });
    return warehouseMasterLoadPromise;
}

async function loadSupplierWarehouseMasters(force = false) {
    if (supplierWarehouseLoadPromise && !force) return supplierWarehouseLoadPromise;
    supplierWarehouseLoadPromise = Promise.all([
        readCollectionInBatches('suppliers'),
        readCollectionInBatches('brandSupplierMappings'),
        loadWarehouseMaster(force)
    ]).then(([suppliers, mappings]) => {
        supplierMasterCache = suppliers.filter(item => item.active !== false);
        supplierMappingCache = mappings.filter(item => item.active !== false);
        supplierMasterCache.sort((a,b)=>String(a.supplierName||'').localeCompare(String(b.supplierName||''),'zh-Hant'));
        renderSupplierMappingAdmin();
        renderWarehouseMasterAdmin();
        populateOrderWarehouseOptions();
        return { suppliers:supplierMasterCache, mappings:supplierMappingCache, warehouses:warehouseMasterCache };
    }).catch(err => {
        supplierWarehouseLoadPromise = null;
        console.warn('讀取供應商／倉庫主檔失敗：', err);
        // 已有快取時繼續使用，避免短暫斷線讓下拉選單突然變空。
        return { suppliers:supplierMasterCache, mappings:supplierMappingCache, warehouses:warehouseMasterCache };
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
    const button=actionButtonFromEventOrSelector('[onclick="saveSupplierMapping()"]');
    const buttonState=beginActionButton(button,'儲存中…');
    if(button && !buttonState)return;
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
    } finally {
        endActionButton(button,buttonState);
    }
};

window.disableSupplierMapping = async function(id) {
    if (trueUserRole !== 'admin' || !id) return;
    await db.collection('brandSupplierMappings').doc(id).set({ active:false, updatedAt:new Date().toISOString() }, { merge:true });
    supplierWarehouseLoadPromise = null;
    await loadSupplierWarehouseMasters(true);
};

window.saveWarehouseMaster = async function() {
    const status = document.getElementById('warehouseMasterStatus');
    const button = document.querySelector('[onclick="saveWarehouseMaster()"]');
    if (trueUserRole !== 'admin') {
        if (status) status.innerText = '只有管理員可以新增或修改倉庫。';
        return;
    }
    const name = String(document.getElementById('warehouseMasterName')?.value || '').trim();
    const makeDefault = !!document.getElementById('warehouseMasterDefault')?.checked;
    if (!name) { if (status) status.innerText = '請輸入倉庫名稱。'; return; }
    if (button?.disabled) return;
    if (button) button.disabled = true;
    if (status) status.innerText = '儲存中…';
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
        console.error('儲存倉庫失敗：', err);
        if (status) status.innerText = '儲存失敗：' + (err.code === 'permission-denied' ? 'Firestore 權限不足，請確認目前帳號為管理員並已部署最新 Rules。' : err.message);
    } finally {
        if (button) button.disabled = false;
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
    const cacheKey = warehouseId + '||' + productKey;
    if (warehouseStockCache.has(cacheKey)) return warehouseStockCache.get(cacheKey);
    const ref = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId, productKey));
    const snap = await firestoreReadWithTimeout(ref.get(), '倉庫庫存').catch(() => null);
    const data = snap && snap.exists ? { id:snap.id, ...snap.data() } : null;
    warehouseStockCache.set(cacheKey, data);
    return data;
}

let orderWarehouseStockRefreshGeneration = 0;
window.refreshOrderWarehouseStock = async function() {
    const generation = ++orderWarehouseStockRefreshGeneration;
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
    hint.innerText = '正在查詢各倉庫可用庫存…';
    await loadWarehouseMaster();
    if (generation !== orderWarehouseStockRefreshGeneration) return;
    const warehouses = warehouseMasterCache.filter(warehouse => warehouse.active !== false);
    const stocks = await Promise.all(warehouses.map(warehouse => warehouseStockSnapshot(key, warehouse.id)));
    if (generation !== orderWarehouseStockRefreshGeneration) return;
    const rows = warehouses.map((warehouse, index) => {
        const stock = stocks[index];
        const onHand = Number(stock?.onHand || 0), reserved = Number(stock?.reserved || 0);
        return `${warehouse.warehouseName || warehouse.id}：${Math.max(0,onHand-reserved)} 可用（現有 ${onHand}）`;
    });
    hint.innerText = rows.length ? rows.join(' ｜ ') : '尚未建立倉庫；可先到管理員後台 → 廠牌管理建立。';
};

window.onOrderFulfillmentChange = function() {
    const type = document.getElementById('orderFulfillmentType')?.value || 'WAREHOUSE';
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
    brandMasterLoadPromise = readCollectionInBatches('brands').then(rows => {
        brandMasterCache = rows
            .map(row => normalizeBrandMasterRecord(row.id, row))
            .filter(item => item.name && item.active !== false);
        return brandMasterCache;
    }).catch(err => {
        // 暫時失敗時保留既有資料，但不要永久記住失敗結果；下次需要時可重新連線。
        console.warn('讀取 Brand Master 失敗，暫時沿用既有廠牌設定：', err);
        brandMasterLoadPromise = null;
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

const BRAND_AUDIT_BLOCKING_SOURCES = new Set([
    'products', 'statistics', 'companyAgencies', 'supplierMappings'
]);

function brandAuditNamesFromRecord(source, record = {}) {
    const data = record?.data || record || {};
    if (source === 'statistics' || source === 'companyAgencies') return [String(data.name || data || '')];
    if (source === 'supplierMappings') return [data.brandName || data.brand || ''];
    if (source === 'orders') return [
        data.brand || '',
        ...normalizedOrderItems(data).map(item => item.brand || '')
    ];
    if (source === 'quotes') return [
        data.brand || '',
        ...(Array.isArray(data.items) ? data.items.map(item => item.brand || '') : [])
    ];
    return [data.brand || data.brandName || ''];
}

function buildBrandMasterCompatibilityAudit(masterEntries, sources) {
    const master = (masterEntries || []).filter(entry => entry && entry.active !== false && entry.name);
    const coverage = new Map();
    master.forEach(entry => {
        [entry.name, ...(entry.aliases || [])].forEach(name => {
            const key = normalizeBrandLookupKey(name);
            if (key) coverage.set(key, entry.name);
        });
    });

    const found = new Map();
    Object.entries(sources || {}).forEach(([source, rows]) => {
        (rows || []).forEach(row => {
            brandAuditNamesFromRecord(source, row).forEach(raw => {
                const name = String(raw || '').trim();
                const key = normalizeBrandLookupKey(name);
                if (!key || ['其他', '其他廠牌', '維修'].some(skip => normalizeBrandLookupKey(skip) === key)) return;
                if (!found.has(key)) found.set(key, { name, sources: new Set(), blocking: false });
                const item = found.get(key);
                item.sources.add(source);
                if (BRAND_AUDIT_BLOCKING_SOURCES.has(source)) item.blocking = true;
            });
        });
    });

    const rows = [...found.entries()].map(([key, item]) => ({
        name: item.name,
        sources: [...item.sources].sort(),
        blocking: item.blocking,
        covered: coverage.has(key),
        canonicalName: coverage.get(key) || ''
    })).sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.name.localeCompare(b.name, 'zh-Hant'));

    return {
        masterCount: master.length,
        rows,
        missingBlocking: rows.filter(row => row.blocking && !row.covered),
        missingHistorical: rows.filter(row => !row.blocking && !row.covered),
        canRemoveCompatibilityLayer: rows.every(row => !row.blocking || row.covered)
    };
}

window.previewBrandMasterCompatibilityAudit = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        alert('只有管理員可以執行 Brand Master 相容層稽核。');
        return;
    }
    const button = document.getElementById('brandMasterAuditBtn');
    const status = document.getElementById('brandMasterAuditStatus');
    if (button?.disabled) return;
    if (button) button.disabled = true;
    if (status) status.innerText = '正在讀取正式主檔與品牌設定…';
    try {
        await Promise.all([loadBrandMaster(), loadSupplierWarehouseMasters()]);
        const sources = {
            products: (await readCollectionForMigration('products')).map(row => row.data),
            statistics: [
                ...keyStatisticBrands.map(name => ({ name })),
                ...Object.entries(keyStatisticBrandAliases).flatMap(([name, aliases]) => [
                    { name }, ...(aliases || []).map(alias => ({ name: alias }))
                ])
            ],
            companyAgencies: Object.values(companyAgencyBrands).flat().map(name => ({ name })),
            supplierMappings: supplierMappingCache
        };

        const historicalCollections = ['orders', 'quotes', 'forecasts', 'equipment'];
        for (let index = 0; index < historicalCollections.length; index++) {
            const name = historicalCollections[index];
            if (status) status.innerText = `正在分頁檢查歷史品牌快照（${index + 1}/${historicalCollections.length}）：${name}…`;
            sources[name] = await readCollectionForMigration(name);
        }

        const report = buildBrandMasterCompatibilityAudit(brandMasterCache, sources);
        window._brandMasterCompatibilityAudit = report;
        const blockingNames = report.missingBlocking.map(row => `${row.name}（${row.sources.join('、')}）`);
        const historicalNames = report.missingHistorical.map(row => `${row.name}（${row.sources.join('、')}）`);
        const lines = [
            `Brand Master：${report.masterCount} 個啟用品牌；所有來源共辨識 ${report.rows.length} 個品牌。`,
            report.canRemoveCompatibilityLayer
                ? '正式來源檢查通過：相容層已具備移除條件。'
                : `尚不可移除相容層：${blockingNames.length} 個正式來源品牌尚未進入 Brand Master。`,
            blockingNames.length ? `需先補齊：${blockingNames.join('；')}` : '正式來源缺漏：0。',
            historicalNames.length
                ? `歷史快照另有 ${historicalNames.length} 個未對應名稱（不阻擋移除，但應確認是否為別名）：${historicalNames.join('；')}`
                : '歷史快照未對應名稱：0。',
            '本功能僅讀取與比對，不會修改或刪除資料。'
        ];
        if (status) status.innerText = lines.join('\n');
    } catch (err) {
        console.error('Brand Master 相容層稽核失敗：', err);
        if (status) status.innerText = '稽核失敗：' + (err.message || err);
    } finally {
        if (button) button.disabled = false;
    }
};


function normalizeThermoBrandList(brands) {
    return dedupeBrandsCaseInsensitive((brands || []).map(value =>
        String(value || '').trim().toLocaleLowerCase() === 'thermo' ? 'Thermo' : value
    ));
}

function includesBrandCaseInsensitive(brands, brand) {
    const key = String(brand || '').trim().toLocaleLowerCase();
    return (brands || []).some(value => String(value || '').trim().toLocaleLowerCase() === key);
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
    return true;
}

function getCompanySelectableBrands(company) {
    return getPriceListBrands(true);
}

// 估價單的廠牌只使用價目表中已有的廠牌；載入舊估價單時若廠牌已不在價目表，
// 仍暫時顯示該舊值，避免一開啟舊單就把歷史資料洗掉。
function quoteBrandOptions(selectedBrand) {
    const selected = (selectedBrand || '').trim();
    const brands = getCompanySelectableBrands(currentCompany);
    const selectedOption = selected && !brands.includes(selected) ? '其他' : selected;
    return ['<option value="">請選擇廠牌</option>']
        .concat(brands.map(brand => `<option value="${escapeAttr(brand)}"${brand === selectedOption ? ' selected' : ''}>${escapeHtml(brand)}</option>`))
        .concat(`<option value="其他"${selectedOption === '其他' ? ' selected' : ''}>其他（自行輸入）</option>`)
        .join('');
}

function populateBrandSelect(select, placeholderText, includeMaintenance = false) {
    if (!select) return;
    const otherInput = select.id === 'orderBrand' ? document.getElementById('orderBrandOther')
        : select.id === 'eqBrand' ? document.getElementById('eqBrandOther') : null;
    const currentValue = select.value === '其他' ? (otherInput?.value || '其他') : select.value;
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
    const canonical = resolveBrandName(currentValue);
    const isMain = [...select.options].some(o => o.value === canonical);
    select.value = isMain ? canonical : (currentValue ? '其他' : '');
    if (otherInput) {
        otherInput.value = !isMain && currentValue !== '其他' ? currentValue : '';
        otherInput.style.display = select.value === '其他' ? '' : 'none';
    }
}

// 價目表可能包含非主要廠牌；只在「其他」文字框帶入實際名稱，不擴大下拉選單。
function selectBrandInDropdown(select, brandName) {
    if (!select || !brandName) return;
    const canonical = resolveBrandName(brandName);
    const isMain = [...select.options].some(o => o.value === canonical);
    select.value = isMain ? canonical : '其他';
    const otherInput = select.id === 'orderBrand' ? document.getElementById('orderBrandOther')
        : select.id === 'eqBrand' ? document.getElementById('eqBrandOther')
        : select.closest('tr')?.querySelector('.item-brand-other');
    if (otherInput) {
        otherInput.value = isMain ? '' : brandName;
        otherInput.style.display = isMain ? 'none' : '';
    }
}

function populateOrderBrandDropdown() {
    populateBrandSelect(document.getElementById('orderBrand'), '請選擇廠牌', true);
    onOrderBrandSelectChange();
}

function populateQuoteBrandDropdowns() {
    document.querySelectorAll('#quoteItems .item-brand').forEach(select => {
        const row = select.closest('tr');
        const currentValue = select.value === '其他'
            ? row?.querySelector('.item-brand-other')?.value || '其他'
            : select.value;
        select.innerHTML = quoteBrandOptions(currentValue);
        const canonical = resolveBrandName(currentValue);
        const isMain = [...select.options].some(option => option.value === canonical);
        select.value = isMain ? canonical : (currentValue ? '其他' : '');
        const otherInput = row?.querySelector('.item-brand-other');
        if (otherInput) {
            otherInput.value = !isMain && currentValue !== '其他' ? currentValue : '';
            otherInput.style.display = select.value === '其他' ? '' : 'none';
        }
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
    const match = await findProductByCode(value);
    if (!match) {
        input.dataset.autofillStatus = 'not-found';
        input.dataset.productLine = '';
        input.dataset.productType = '';
        input.dataset.productMasterMatched = '0';
        const hiddenProductLine = document.getElementById('orderProductLine');
        if (hiddenProductLine) hiddenProductLine.value = '';
        window._orderModalProductId = '';
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
    const itemNameEnInput=document.getElementById('orderItemNameEn');if(itemNameEnInput)itemNameEnInput.value=match.nameEn||'';
    const specInput=document.getElementById('orderSpec');if(specInput)specInput.value=match.spec||match.specification||'';
    const priceInput = document.getElementById('orderUnitPrice');
    if (priceInput && match.price !== undefined && match.price !== null && String(match.price).trim() !== '') {
        priceInput.value = match.price;
        calcOrderTotal();
    }

    input.dataset.productLine = match.productLine || '';
    input.dataset.productMasterMatched = '1';
    const hiddenProductLine = document.getElementById('orderProductLine');
    if (hiddenProductLine) hiddenProductLine.value = match.productLine || '';
    input.dataset.productType = match.productType || '';

    // 成本與庫存彼此獨立；平行查詢，避免成本讀取阻塞庫存提示。
    await Promise.all([
        applyOrderProductCost(match),
        refreshOrderWarehouseStock()
    ]);
};

let orderItemCodeTimer = null;
window.onOrderItemCodeInput = function(input) {
    clearTimeout(orderItemCodeTimer);
    orderItemCodeTimer = setTimeout(() => onOrderItemCodeChange(input), 180);
};

// 客戶名稱自動完成：僅抓「最近 10 筆」估價單取樣，避免隨估價單累積而讀取量無上限增長
window.saveToStorage = function() {
    const validDays = document.getElementById('validDays').value;
    localStorage.setItem('quote_valid_days', validDays);
};


function quoteExtraDataFromRow(row) {
    const customFields = [...row.querySelectorAll('.quote-custom-field-row')].map(fieldRow => ({
        label: String(fieldRow.querySelector('.quote-custom-label')?.value || '').trim(),
        value: String(fieldRow.querySelector('.quote-custom-value')?.value || '').trim()
    })).filter(field => field.label || field.value);
    return {
        origin: String(row.querySelector('.item-origin')?.value || '').trim(),
        leadTime: String(row.querySelector('.item-lead-time')?.value || '').trim(),
        hospitalItemCode: String(row.querySelector('.item-hospital-code')?.value || '').trim(),
        remarks: String(row.querySelector('.item-remarks')?.value || '').trim(),
        customFields
    };
}

function quoteOptionalFieldKeysFromItems(items = []) {
    const keys = new Set();
    items.forEach(item => {
        if (String(item.origin || '').trim()) keys.add('origin');
        if (String(item.leadTime || '').trim()) keys.add('leadTime');
        if (String(item.hospitalItemCode || '').trim()) keys.add('hospitalItemCode');
        if (String(item.remarks || '').trim()) keys.add('remarks');
    });
    return [...keys];
}

function rememberQuoteCustomerPreferences(customerName, items = []) {
    const name = String(customerName || '').trim();
    const customerId = customerIdForName(name);
    if (!customerId || !currentUser || !hasBusinessCapability()) return;
    const quoteOptionalFields = quoteOptionalFieldKeysFromItems(items);
    if (!quoteOptionalFields.length) return;
    db.collection('customers').doc(customerId).set({
        customerId,
        name,
        active: true,
        // 只增加這個客戶曾經用過的欄位，不因某一張估價單少填就把既有偏好洗掉。
        quoteOptionalFields: firebase.firestore.FieldValue.arrayUnion(...quoteOptionalFields),
        updatedAt: new Date().toISOString()
    }, { merge: true }).catch(err => console.warn('客戶估價欄位偏好儲存失敗：', err));
}

function quotePreferenceCustomerName() {
    return String(
        document.getElementById('ordererName')?.value
        || document.getElementById('clientName')?.value
        || ''
    ).trim();
}

window.applyCurrentQuoteCustomerPreferences = function() {
    return applyCustomerQuotePreferences(quotePreferenceCustomerName());
};

window.applyCustomerQuotePreferences = async function(customerName) {
    const name = String(customerName || '').trim();
    activeQuoteOptionalFields = new Set();
    const customerId = customerIdForName(name);
    if (!customerId || !currentUser) return;
    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('customers').doc(customerId).get(),
            '客戶估價偏好'
        );
        const fields = snapshot.exists && Array.isArray(snapshot.data()?.quoteOptionalFields)
            ? snapshot.data().quoteOptionalFields
            : [];
        // 估價單目前只保留仍可編輯的「更多資訊」欄位；舊偏好不再讓已移除欄位自動展開。
        const supportedFields = new Set(['origin','leadTime','hospitalItemCode','remarks']);
        activeQuoteOptionalFields = new Set(fields.filter(field => supportedFields.has(field)));
        if (!activeQuoteOptionalFields.size) return;
        document.querySelectorAll('#quoteItems tr').forEach(row => {
            const details = row.querySelector('.quote-extra-fields');
            if (details) details.open = true;
        });
    } catch (err) {
        console.warn('客戶估價欄位偏好讀取失敗：', err);
    }
};

window.addQuoteCustomField = function(button, data = {}) {
    const row = button?.closest?.('tr');
    const container = row?.querySelector('.quote-custom-fields');
    if (!container) return;
    const wrapper = document.createElement('div');
    wrapper.className = 'quote-custom-field-row';
    wrapper.innerHTML = `
        <input type="text" class="quote-custom-label" placeholder="欄位名稱，例如：許可證字號" value="${escapeAttr(data.label || '')}">
        <input type="text" class="quote-custom-value" placeholder="內容" value="${escapeAttr(data.value || '')}">
        <button type="button" class="btn-small btn-secondary" onclick="removeQuoteCustomField(this)">移除</button>
    `;
    container.appendChild(wrapper);
};

window.removeQuoteCustomField = function(button) {
    button?.closest?.('.quote-custom-field-row')?.remove();
    saveQuoteDraft();
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
                        <input type="hidden" class="item-product-line" value="${escapeAttr(itemData.productLine || '')}">
                        <input type="hidden" class="item-product-type" value="${itemData.productType || ''}">
                        <input type="hidden" class="item-product-id" value="${itemData.productId || ''}">
                    </div>
                </div>

                <div class="field-row">
                    <label>規格：</label>
                    <textarea class="item-spec" placeholder=" ">${itemData.spec || ''}</textarea>
                </div>
                <details class="quote-extra-fields no-print">
                    <summary>＋ 更多資訊</summary>
                    <div class="quote-extra-grid">
                        <label>產地<input type="text" class="item-origin" value="${escapeAttr(itemData.origin || '')}" placeholder="例如：USA"></label>
                        <label>交貨期<input type="text" class="item-lead-time" value="${escapeAttr(itemData.leadTime || '')}" placeholder="例如：下單後 4–6 週"></label>
                        <label>院內料號<input type="text" class="item-hospital-code" value="${escapeAttr(itemData.hospitalItemCode || '')}"></label>
                        <label>備註<input type="text" class="item-remarks" value="${escapeAttr(itemData.remarks || '')}" placeholder="例如：客戶指定條件、包裝或其他說明"></label>
                    </div>
                    <div class="quote-custom-fields"></div>
                    <button type="button" class="btn-small btn-secondary quote-add-custom-field" onclick="addQuoteCustomField(this)">＋ 自訂欄位</button>
                </details>
            </div>
        </td>
        <td data-th="數量"><input type="number" class="qty" value="${itemData.qty || 1}" min="1" oninput="calculateTotals()"></td>
        <td data-th="含稅單價"><input type="number" class="inc-price" value="${itemData.price || 0}" oninput="onIncPriceChange(this)"></td>
        <td data-th="未稅單價"><input type="number" class="ex-price" value="${itemData.exPrice || ((itemData.price || 0) / 1.05).toFixed(2)}" oninput="onExPriceChange(this)"></td>
        <td data-th="含稅小計"><input type="number" class="subtotal-inc" value="${itemData.subtotal || 0}" readonly style="background-color: #f9f9f9;"></td>
        <td class="no-print"><button type="button" class="btn-danger" onclick="removeQuoteRow(this)">刪除</button></td>
    `;

    tbody.appendChild(tr);
    const extraDetails = tr.querySelector('.quote-extra-fields');
    const hasExtraData = ['origin','leadTime','hospitalItemCode','remarks'].some(key => String(itemData[key] || '').trim())
        || (Array.isArray(itemData.customFields) && itemData.customFields.length);
    if (extraDetails && (hasExtraData || activeQuoteOptionalFields.size)) extraDetails.open = true;
    const customButton = tr.querySelector('.quote-add-custom-field');
    (Array.isArray(itemData.customFields) ? itemData.customFields : []).forEach(field => addQuoteCustomField(customButton, field));
    if (itemData.brand && tr.querySelector('.item-brand').value === '其他')
        tr.querySelector('.item-brand-other').value = itemData.brand;
    onQuoteBrandSelectChange(tr.querySelector('.item-brand'));
    calculateTotals();
};

window.onItemCnChange = function(input) {
    const value = input.value.trim();
    const match = priceList.find(p => String(p.nameCn || '').trim() === value);
    if (!match) return;
    applyQuoteProductMatch(input.closest('tr'), match);
};

window.onItemModelChange = async function(input) {
    const value = input.value.trim();
    if (!value) return;

    const match = await findProductByCode(value);
    if (!match) {
        const row = input.closest('tr');
        if (row) {
            row.querySelector('.item-product-id').value = '';
            row.querySelector('.item-product-line').value = '';
            row.querySelector('.item-product-type').value = '';
        }
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
window.refreshAllItemPricesFromPriceList = async function() {
    const rows = [...document.querySelectorAll('#quoteItems tr')];
    if (rows.length === 0) {
        alert('目前沒有任何品項可以更新。');
        return;
    }
    if (!confirm(`確定要把目前這 ${rows.length} 個品項依貨號重新比對 Product Master、更新單價嗎？\n沒有貨號或找不到唯一產品的列不會被更動。`)) return;

    let updated = 0;
    let notFound = 0;
    for (const row of rows) {
        const model = (row.querySelector('.item-model')?.value || '').trim();
        let match = model ? await findProductByCode(model) : null;
        if (!match) {
            const cn = (row.querySelector('.item-cn')?.value || '').trim();
            const nameMatches = cn ? priceList.filter(p => String(p.nameCn || '').trim() === cn) : [];
            match = nameMatches.length === 1 ? nameMatches[0] : null;
        }
        if (!match) { notFound++; continue; }
        applyQuoteProductMatch(row, match);
        updated++;
    }
    calculateTotals();
    let msg = `已更新 ${updated} 個品項。`;
    if (notFound > 0) msg += `\n有 ${notFound} 個品項找不到唯一對應產品，維持原資料。`;
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
let editingQuoteNo = '';

function updateQuoteEditingBanner() {
    const banner = document.getElementById('quoteEditingBanner');
    const number = document.getElementById('quoteEditingNumber');
    if (!banner || !number) return;
    if (editingQuoteNo) {
        number.innerText = editingQuoteNo;
        banner.style.display = 'flex';
    } else {
        number.innerText = '';
        banner.style.display = 'none';
    }
}

function setQuoteEditingContext(quoteNo = '') {
    editingQuoteNo = String(quoteNo || '').trim();
    updateQuoteEditingBanner();
}

function setQuoteOutputStatus(message = '', isError = false) {
    const el = document.getElementById('quoteOutputStatus');
    if (!el) return;
    el.innerText = message;
    el.classList.toggle('is-error', !!isError);
    el.style.display = message ? 'block' : 'none';
}

window.saveLoadedQuoteAsNew = async function() {
    const originalQuoteNo = editingQuoteNo || document.getElementById('quoteNo')?.value || '';
    setQuoteEditingContext('');
    initDate();
    setQuoteOutputStatus('正在建立新的估價單號…');
    await generateQuoteNo();
    saveQuoteDraft();
    setQuoteOutputStatus(`已另存為新估價單：${document.getElementById('quoteNo')?.value || ''}`);
    if (originalQuoteNo) {
        window.setTimeout(() => {
            const current = document.getElementById('quoteOutputStatus')?.innerText || '';
            if (current.startsWith('已另存為新估價單')) setQuoteOutputStatus('');
        }, 2500);
    }
};

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
            ...quoteExtraDataFromRow(row),
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
            editingQuoteNo,
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
    setQuoteEditingContext(draft.editingQuoteNo || '');
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
        quoteDate: document.getElementById('quoteDate').value, createdAt: new Date().toISOString(), ...commercialCreatorFields(),
        ...linkedDocumentFields(window._pendingForecastQuoteLink ? DOCUMENT_TYPES.FORECAST : '', window._pendingForecastQuoteLink?.forecastId || '', window._pendingForecastQuoteLink ? [documentLink(DOCUMENT_TYPES.FORECAST, window._pendingForecastQuoteLink.forecastId, 'source')] : []), validDays: document.getElementById('validDays').value,
        discountRate: document.getElementById('discountRateInput').value, grandTotal: document.getElementById('grandTotal').innerText,
        items: []
    };
    document.querySelectorAll('#quoteItems tr').forEach(row => {
        const productId = row.querySelector('.item-product-id')?.value || '';
        record.items.push({
            nameEn: row.querySelector('.item-en').value, nameCn: row.querySelector('.item-cn').value,
            model: row.querySelector('.item-model').value, brand: quoteRowBrandValue(row),
            productLine: row.querySelector('.item-product-line').value, productType: row.querySelector('.item-product-type').value,
            productId, productMasterMatched: !!productId, spec: row.querySelector('.item-spec').value,
            ...quoteExtraDataFromRow(row), qty: row.querySelector('.qty').value,
            price: row.querySelector('.inc-price').value, exPrice: row.querySelector('.ex-price').value,
            subtotal: row.querySelector('.subtotal-inc').value
        });
    });
    record.productMasterMatched = record.items.length > 0 && record.items.every(item => item.productMasterMatched === true);
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
    // 使用者在選公司／比例時先把比較估價需要的 Logo 與印章載入，
    // 不把圖片下載時間留到按下「列印」之後才開始。
    preloadComparisonQuoteImages();
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
            extra: quoteExtraDataFromRow(row),
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

function renderComparisonExtraFields(extra = {}, variant = 'b') {
    const labels = variant === 'a'
        ? { origin:'ORIGIN', leadTime:'LEAD TIME', hospitalItemCode:'HOSPITAL ITEM', remarks:'REMARKS' }
        : { origin:'產地', leadTime:'交貨期', hospitalItemCode:'院內料號', remarks:'備註' };
    const rows = [
        [labels.origin, extra.origin],
        [labels.leadTime, extra.leadTime],
        [labels.hospitalItemCode, extra.hospitalItemCode],
        [labels.remarks, extra.remarks],
        ...(Array.isArray(extra.customFields) ? extra.customFields.map(field => [field.label, field.value]) : [])
    ].filter(([label, value]) => String(label || '').trim() && String(value || '').trim());
    if (!rows.length) return '';
    return `<div class="comparison-product-extra">${rows.map(([label, value]) =>
        `<span><b>${escapeHtml(label)}：</b>${escapeHtml(value)}</span>`
    ).join('')}</div>`;
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
    const densityClass = items.length >= 7 ? ' comparison-quote-dense' : items.length >= 4 ? ' comparison-quote-compact' : '';
    return `<section class="comparison-quote-page comparison-style-${variant}${densityClass}">
        <header class="comparison-quote-header"><div class="comparison-company-block">${headerIdentity}${company.addr ? `<p>${escapeHtml(company.addr)}</p>` : ''}${company.contact ? `<p>${company.contact}</p>` : ''}</div>${variant === 'a' ? '<div class="comparison-document-title">QUOTATION</div>' : ''}</header>
        <div class="comparison-quote-meta">${document.getElementById('clientName').value.trim() ? `<div><span>${variant === 'a' ? 'CUSTOMER' : '抬頭'}</span><strong>${escapeHtml(document.getElementById('clientName').value)}</strong></div>` : ''}<div><span>${variant === 'a' ? 'DATE' : '報價日期'}</span><strong>${escapeHtml(document.getElementById('quoteDate').value || '')}</strong></div></div>
        <div class="comparison-product-list">${items.map(item => `<article class="comparison-product-item"><div class="comparison-product-main"><strong class="comparison-product-name">${escapeHtml(item.name || '－')}</strong><span class="comparison-product-model">${variant === 'a' ? 'MODEL' : '型號'}：${escapeHtml(item.model || '－')}</span>${renderComparisonExtraFields(item.extra, variant)}</div><span class="comparison-unit-price">${variant === 'a' ? 'UNIT' : '單價'} NT$ ${formatComparisonMoney(item.unitPrice)}</span><span class="comparison-product-qty">${variant === 'a' ? 'QTY' : '數量'} ${escapeHtml(String(item.qty || 0))}</span><strong class="comparison-product-subtotal">${variant === 'a' ? 'SUBTOTAL' : '小計'} NT$ ${formatComparisonMoney(item.amount)}</strong></article>`).join('')}</div>
        <div class="comparison-quote-total-row"><span>${variant === 'a' ? 'TOTAL (TAX INCLUDED)' : '含稅總金額'}</span><strong>NT$ ${total.toLocaleString()}</strong></div>
        <div class="comparison-quote-chinese-total">合計新台幣 ${numberToChineseWords(total)}元整</div>
        <div class="comparison-quote-stamp">${stamp}</div>
    </section>`;
}

const quoteImagePreloadCache = new Map();

function preloadQuoteImage(src) {
    const url = String(src || '').trim();
    if (!url) return Promise.resolve(true);
    if (quoteImagePreloadCache.has(url)) return quoteImagePreloadCache.get(url);
    const promise = new Promise(resolve => {
        const img = new Image();
        let settled = false;
        const done = ok => {
            if (settled) return;
            settled = true;
            img.onload = null;
            img.onerror = null;
            resolve(ok);
        };
        img.onload = () => done(true);
        img.onerror = () => done(false);
        img.src = url;
        if (img.complete && img.naturalWidth > 0) done(true);
        window.setTimeout(() => done(img.complete && img.naturalWidth > 0), 1500);
    });
    quoteImagePreloadCache.set(url, promise);
    return promise;
}

function preloadComparisonQuoteImages() {
    const sources = new Set();
    COMPARISON_COMPANY_ORDER.forEach(key => {
        const company = comparisonCompanyData[key];
        if (company?.logo) sources.add(company.logo);
        if (company?.stamp) sources.add(company.stamp);
    });
    sources.forEach(src => preloadQuoteImage(src));
}

window.openSavedThreeQuoteRecord = async function(quoteNo) {
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '載入三估單…');
    if (button && !buttonState) return;

    try {
        let source = myQuotesCache.find(q => q.quoteNo === quoteNo)
            || quoteHistorySearchResults.find(q => q.quoteNo === quoteNo);

        if (!source) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('quotes').doc(quoteNo).get(),
                '載入三估單紀錄'
            );
            if (!snapshot.exists) throw new Error('找不到這張估價單。');
            source = { id: snapshot.id, ...snapshot.data() };
        }

        const saved = source.threeQuoteRecord;
        if (!saved || !saved.baseQuote) throw new Error('這張估價單沒有已儲存的三估單紀錄。');

        await ensureSalesListLoaded();

        const baseQuote = saved.baseQuote;
        restoringQuoteDraft = true;
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create', document.getElementById('qsub-create'));
        applyCompanyTheme(baseQuote.company || source.company || 'yushin');
        populateSalesDropdown();

        document.getElementById('clientName').value = baseQuote.clientName || '';
        document.getElementById('ordererName').value = baseQuote.ordererName || '';
        document.getElementById('salesName').value = baseQuote.salesName || '';
        document.getElementById('quoteDate').value = baseQuote.quoteDate || '';
        document.getElementById('quoteNo').value = baseQuote.quoteNo || quoteNo;
        setQuoteEditingContext(baseQuote.quoteNo || quoteNo);
        setQuoteOutputStatus('');
        document.getElementById('validDays').value = baseQuote.validDays ?? 90;
        document.getElementById('discountRateInput').value = baseQuote.discountRate || 0;
        updateSalesPhoneDisplay();

        const itemsBody = document.getElementById('quoteItems');
        itemsBody.innerHTML = '';
        if (Array.isArray(baseQuote.items) && baseQuote.items.length) {
            baseQuote.items.forEach(item => addQuoteRow(item));
        } else {
            addQuoteRow();
        }
        calculateTotals();

        restoringQuoteDraft = false;
        saveQuoteDraft();

        preloadComparisonQuoteImages();
        const company2 = saved.company2 || '';
        const company3 = saved.company3 || '';
        setComparisonCompanyOptions(document.getElementById('comparisonCompany2'), company2, company3);
        setComparisonCompanyOptions(document.getElementById('comparisonCompany3'), company3, company2);
        document.getElementById('comparisonPercent2').value = saved.percent2 ?? 10;
        document.getElementById('comparisonPercent3').value = saved.percent3 ?? 15;
        updateThreeQuoteDialog();

        const summary = document.getElementById('threeQuoteBaseSummary');
        if (summary && saved.generatedAt) {
            const generatedAt = new Date(saved.generatedAt);
            const timeLabel = Number.isNaN(generatedAt.getTime())
                ? ''
                : generatedAt.toLocaleString('zh-TW', { hour12: false });
            summary.insertAdjacentHTML('beforeend', timeLabel ? `<br><span class="three-quote-record-time">紀錄時間：${escapeHtml(timeLabel)}</span>` : '');
        }

        document.getElementById('threeQuoteOverlay').classList.add('active');
    } catch (err) {
        console.error('載入三估單紀錄失敗：', err);
        alert('載入三估單紀錄失敗：' + (err?.message || err));
    } finally {
        restoringQuoteDraft = false;
        endActionButton(button, buttonState);
    }
};

window.printThreeQuotes = async function() {
    const validationMessage = currentQuoteOutputValidation();
    if (validationMessage) { alert(validationMessage); return; }

    const company2 = document.getElementById('comparisonCompany2').value;
    const company3 = document.getElementById('comparisonCompany3').value;
    if (!company2 || !company3 || company2 === company3 || company2 === currentCompany || company3 === currentCompany) {
        alert('三張估價單必須選擇不同公司。');
        return;
    }

    const percent2 = Math.max(0, parseFloat(document.getElementById('comparisonPercent2').value) || 0);
    const percent3 = Math.max(0, parseFloat(document.getElementById('comparisonPercent3').value) || 0);
    const button = document.getElementById('threeQuotePrintBtn');
    const originalLabel = button?.innerText || '匯出三頁 PDF';
    if (button) {
        button.disabled = true;
        button.innerText = '正在產生三頁 PDF…';
    }

    let firstStage = null;
    let comparisonStage = null;
    let quoteData = null;
    try {
        if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
            throw new Error('PDF 元件尚未載入');
        }

        quoteData = quoteDataForPdfExport();
        quoteData.lastOutputAt = new Date().toISOString();
        quoteData.lastOutputType = 'THREE_QUOTE_PDF';
        rememberQuoteCustomerPreferences(quoteData.ordererName || quoteData.clientName, quoteData.items);

        const baseQuoteSnapshot = JSON.parse(JSON.stringify(quoteData));
        quoteData.threeQuoteRecord = {
            version: 1,
            generatedAt: new Date().toISOString(),
            company2,
            company3,
            percent2,
            percent3,
            baseTotal: comparisonBaseTotal(),
            total2: roundedComparisonTotal(percent2),
            total3: roundedComparisonTotal(percent3),
            baseQuote: baseQuoteSnapshot
        };
        await persistQuoteOutputRecord(quoteData, '三家估價 PDF');

        const cachedIndex = myQuotesCache.findIndex(q => q.quoteNo === quoteData.quoteNo);
        if (cachedIndex >= 0) myQuotesCache[cachedIndex] = { ...myQuotesCache[cachedIndex], ...quoteData };
        const historyIndex = quoteHistorySearchResults.findIndex(q => q.quoteNo === quoteData.quoteNo);
        if (historyIndex >= 0) quoteHistorySearchResults[historyIndex] = { ...quoteHistorySearchResults[historyIndex], ...quoteData };
        writeAppDataCache('quotes', myQuotesCache);

        const first = createQuotePdfStage(quoteData);
        firstStage = first.stage;
        await waitForPdfImages(first.documentNode);

        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const scale = isMobile ? 1.15 : 1.65;
        const firstPages = paginateQuotePdfDocument(first.stage, first.documentNode);
        await waitForPdfImages(first.stage);

        const pdf = new window.jspdf.jsPDF({ orientation:'portrait', unit:'mm', format:'a4', compress:true });
        await addDocumentPagesToPdf(pdf, firstPages, { scale });
        firstStage.remove();
        firstStage = null;

        comparisonStage = document.createElement('div');
        comparisonStage.className = 'quote-pdf-stage comparison-pdf-stage';
        comparisonStage.innerHTML =
            renderComparisonQuotePage(company2, percent2, 'a') +
            renderComparisonQuotePage(company3, percent3, 'b');
        document.body.appendChild(comparisonStage);
        await waitForPdfImages(comparisonStage);

        const comparisonPages = [...comparisonStage.querySelectorAll('.comparison-quote-page')];
        await addDocumentPagesToPdf(pdf, comparisonPages, {
            scale,
            addPageBeforeFirst: true,
            onProgress: (pageNo, pageCount) => {
                if (button) button.innerText = `正在產生三家估價單… ${pageNo}/${pageCount}`;
            }
        });

        const threeQuoteName = quotePdfFileName(quoteData).replace(/\.pdf$/i, '-三家估價.pdf');
        pdf.save(threeQuoteName);
        setQuoteOutputStatus('✓ 三家估價單已產生並同步');
        closeThreeQuoteDialog();
    } catch (err) {
        console.error('匯出三家估價 PDF 失敗：', err);
        alert('產生三家估價 PDF 失敗：' + (err?.message || err) + '。請確認網路後再試一次。');
    } finally {
        firstStage?.remove();
        comparisonStage?.remove();
        if (button) {
            button.disabled = false;
            button.innerText = originalLabel;
        }
    }
};
function quotePdfFileName(quoteData = {}) {
    const raw = [quoteData.quoteNo, quoteData.ordererName || quoteData.clientName].filter(Boolean).join('-') || '估價單';
    return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.pdf';
}

function persistQuoteOutputRecord(quoteData, outputLabel = '輸出') {
    quoteData.searchTokens = buildFullHistorySearchTokens('quote', quoteData);
    const quoteRef = db.collection('quotes').doc(quoteData.quoteNo);
    const updatingExisting = !!editingQuoteNo && editingQuoteNo === quoteData.quoteNo;

    return db.runTransaction(async transaction => {
        const snapshot = await transaction.get(quoteRef);
        if (snapshot.exists && !updatingExisting) {
            const conflict = new Error(`估價單號 ${quoteData.quoteNo} 已存在。為避免覆蓋既有估價單，請使用「另存為新估價單」取得新單號後再輸出。`);
            conflict.code = 'quote-number-conflict';
            throw conflict;
        }

        if (snapshot.exists && updatingExisting) {
            const existing = snapshot.data() || {};
            // 編輯既有估價單時，表單只代表可編輯內容；成交、三估單、文件連結等背景欄位
            // 必須由 merge 保留。建立者與建立時間也屬稽核欄位，不可因重新輸出而改寫。
            quoteData.createdAt = existing.createdAt || quoteData.createdAt;
            quoteData.createdByUid = existing.createdByUid || quoteData.createdByUid || '';
            quoteData.createdByName = existing.createdByName || quoteData.createdByName || '';
            quoteData.createdByRole = existing.createdByRole || quoteData.createdByRole || '';
        }
        transaction.set(quoteRef, quoteData, { merge: true });
    }).then(() => {
        if (!editingQuoteNo) {
            setQuoteEditingContext(quoteData.quoteNo);
            saveQuoteDraft();
        }
        if (quoteData.sourceType === DOCUMENT_TYPES.FORECAST && quoteData.sourceId) {
            return db.collection('forecasts').doc(quoteData.sourceId).set({
                linkedDocuments: firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.QUOTE, quoteData.quoteNo, 'created')),
                updatedAt: new Date().toISOString()
            }, { merge: true });
        }
    }).catch(err => {
        console.error('儲存估價單到雲端失敗：', err);
        if (err?.code !== 'quote-number-conflict') {
            alert('提醒：估價單存到雲端失敗（' + err.message + '）。' + outputLabel + '內容不受影響，請稍後確認網路後再重新同步。');
        }
        throw err;
    });
}

function quoteDataForPdfExport() {
    const quoteData = collectCurrentQuoteRecord();
    const selectedSales = salesList.find(s => stripPhoneSuffix(s.name) === stripPhoneSuffix(quoteData.salesName));
    quoteData.customerId = syncCustomerMaster(quoteData.ordererName || quoteData.clientName, {
        salesCode: selectedSales?.code || quoteData.salesCode || salesCodeForName(quoteData.salesName)
    });
    quoteData.status = BUSINESS_STATUS.ACTIVE;
    Object.assign(quoteData, grossAmountMetadata(quoteData.grandTotal));
    return quoteData;
}

function waitForPdfImages(root) {
    const images = [...root.querySelectorAll('img')].filter(img => getComputedStyle(img).display !== 'none');
    return Promise.all(images.map(img => {
        img.loading = 'eager';
        if (img.complete && img.naturalWidth > 0) return Promise.resolve(true);
        return new Promise(resolve => {
            let settled = false;
            const done = ok => {
                if (settled) return;
                settled = true;
                img.onload = null;
                img.onerror = null;
                resolve(ok);
            };
            img.onload = () => done(true);
            img.onerror = () => done(false);
            window.setTimeout(() => done(img.complete && img.naturalWidth > 0), 700);
        });
    }));
}

function quotePdfExtraRows(item = {}) {
    return [
        ['產地', item.origin],
        ['交貨期', item.leadTime],
        ['院內料號', item.hospitalItemCode],
        ['備註', item.remarks],
        ...(Array.isArray(item.customFields) ? item.customFields.map(field => [field.label, field.value]) : [])
    ].filter(([label, value]) => String(label || '').trim() && String(value || '').trim());
}

function renderQuotePdfDocument(quoteData = {}) {
    const companyKey = quoteData.company || currentCompany;
    const info = comparisonCompanyData[companyKey] || companyData[companyKey] || companyData.yushin;
    const logo = comparisonCompanyData[companyKey]?.logo || '';
    const stamp = info?.stamp || '';
    const total = parseFloat(String(quoteData.grandTotal || '0').replace(/,/g, '')) || 0;
    const subtotal = Math.round(total / 1.05);
    const tax = Math.round(total - total / 1.05);
    const discountRate = parseFloat(quoteData.discountRate) || 0;
    const validDays = String(quoteData.validDays ?? '').trim();
    const selectedSales = salesList.find(s => stripPhoneSuffix(s.name) === stripPhoneSuffix(quoteData.salesName));
    const salesPhone = selectedSales?.phone || '';
    const items = Array.isArray(quoteData.items) ? quoteData.items : [];

    const root = document.createElement('div');
    root.className = `quote-pdf-document theme-${escapeAttr(companyKey)}`;
    root.innerHTML = `
        <div class="header-container">
            ${logo ? `<img class="company-logo quote-pdf-logo" src="${escapeAttr(logo)}" alt="${escapeAttr(info?.title || '')} Logo">` : ''}
            <div class="header-info">
                <h1>${escapeHtml(info?.title || '')}</h1>
                <h2>${escapeHtml(info?.sub || '')}</h2>
                ${info?.addr ? `<p>${escapeHtml(info.addr)}</p>` : ''}
                ${info?.contact ? `<p>${info.contact}</p>` : ''}
                <h2 class="quote-pdf-title">估 價 單</h2>
            </div>
        </div>
        <div class="meta-section">
            ${quoteData.clientName ? `<div class="meta-row"><label>抬頭：</label><span class="quote-pdf-value">${escapeHtml(quoteData.clientName)}</span></div>` : ''}
            <div class="meta-row-three">
                <div><label>負責業務：</label><span class="quote-pdf-value">${escapeHtml(quoteData.salesName || '')}${salesPhone ? '　' + escapeHtml(salesPhone) : ''}</span></div>
                <div><label>估價日期：</label><span class="quote-pdf-value">${escapeHtml(quoteData.quoteDate || '')}</span></div>
                <div><label>單號：</label><span class="quote-pdf-value quote-pdf-no">${escapeHtml(quoteData.quoteNo || '')}</span></div>
            </div>
        </div>
        <div class="quote-pdf-grid">
            <div class="quote-pdf-grid-row quote-pdf-grid-head">
                <div>項次</div><div>品名 / 規格 / 型號說明</div><div>數量</div><div>含稅單價</div><div>未稅單價</div><div>含稅小計</div>
            </div>
            <div class="quote-pdf-items">
                ${items.map((item, index) => {
                    const extras = quotePdfExtraRows(item);
                    return `<div class="quote-pdf-grid-row quote-pdf-item-row">
                        <div class="quote-pdf-cell quote-pdf-index">${index + 1}</div>
                        <div class="quote-pdf-cell">
                            <div class="quote-pdf-item-detail">
                                ${item.nameEn ? `<div><b>英文品名：</b>${escapeHtml(item.nameEn)}</div>` : ''}
                                ${item.nameCn ? `<div><b>中文品名：</b>${escapeHtml(item.nameCn)}</div>` : ''}
                                ${item.model ? `<div><b>貨號：</b>${escapeHtml(item.model)}</div>` : ''}
                                ${item.brand ? `<div><b>廠牌：</b>${escapeHtml(item.brand)}</div>` : ''}
                                ${item.spec ? `<div><b>規格：</b><span class="quote-pdf-prewrap">${escapeHtml(item.spec)}</span></div>` : ''}
                                ${extras.map(([label, value]) => `<div class="quote-pdf-extra"><b>${escapeHtml(label)}：</b>${escapeHtml(value)}</div>`).join('')}
                            </div>
                        </div>
                        <div class="quote-pdf-cell">${escapeHtml(String(item.qty ?? ''))}</div>
                        <div class="quote-pdf-cell">${Number(item.price || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</div>
                        <div class="quote-pdf-cell">${Number(item.exPrice || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</div>
                        <div class="quote-pdf-cell">${Number(item.subtotal || 0).toLocaleString('zh-TW', { maximumFractionDigits: 2 })}</div>
                    </div>`;
                }).join('')}
            </div>
        </div>
        <div class="quote-summary-block">
            ${validDays ? `<div class="footer-note">* 本估價單有效期限 ${escapeHtml(validDays)} 天。</div>` : ''}
            <div class="quote-pdf-bottom">
                <div class="stamp-section">${stamp ? `<img src="${escapeAttr(stamp)}" alt="${escapeAttr(info?.title || '')} 估價單章">` : ''}</div>
                <div class="total-section">
                    <p>銷售額合計：NT$ <span>${subtotal.toLocaleString()}</span></p>
                    <p>營業稅 (5%)：NT$ <span>${tax.toLocaleString()}</span></p>
                    ${discountRate ? `<p>優惠折扣：${discountRate}%</p>` : ''}
                    <p class="quote-pdf-grand-total">總計金額：NT$ <span>${Math.round(total).toLocaleString()}</span></p>
                    <p>合計新台幣 ${numberToChineseWords(Math.round(total))}元整</p>
                </div>
            </div>
        </div>
    `;
    return root;
}

function createQuotePdfStage(quoteData) {
    const stage = document.createElement('div');
    stage.className = 'quote-pdf-stage';
    const documentNode = renderQuotePdfDocument(quoteData);
    stage.appendChild(documentNode);
    document.body.appendChild(stage);
    return { stage, documentNode };
}

function quotePdfPageHeightPx(stage) {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;width:1px;height:277mm;';
    stage.appendChild(probe);
    const height = probe.getBoundingClientRect().height;
    probe.remove();
    return height;
}

function createQuotePdfPage(stage, source, includeHeader = false) {
    const page = document.createElement('div');
    page.className = source.className + ' quote-pdf-page';
    if (includeHeader) {
        const header = source.querySelector('.header-container');
        const meta = source.querySelector('.meta-section');
        if (header) page.appendChild(header.cloneNode(true));
        if (meta) page.appendChild(meta.cloneNode(true));
    }

    const grid = document.createElement('div');
    grid.className = 'quote-pdf-grid';
    const head = source.querySelector('.quote-pdf-grid-head');
    if (head) grid.appendChild(head.cloneNode(true));
    const items = document.createElement('div');
    items.className = 'quote-pdf-items';
    grid.appendChild(items);
    page.appendChild(grid);
    stage.appendChild(page);
    return { page, items };
}

function paginateQuotePdfDocument(stage, source) {
    const rows = [...source.querySelectorAll('.quote-pdf-item-row')];
    const summary = source.querySelector('.quote-summary-block');
    const maxHeight = quotePdfPageHeightPx(stage);

    source.style.display = 'none';
    const pages = [];
    let current = createQuotePdfPage(stage, source, true);
    pages.push(current);

    for (const row of rows) {
        const clone = row.cloneNode(true);
        current.items.appendChild(clone);
        if (current.page.scrollHeight > maxHeight && current.items.children.length > 1) {
            clone.remove();
            current = createQuotePdfPage(stage, source, false);
            pages.push(current);
            current.items.appendChild(clone);
        }
        // 單一品項若本身超過一頁，不拆開；後續輸出會等比例縮小該頁。
    }

    if (summary) {
        const summaryClone = summary.cloneNode(true);
        current.page.appendChild(summaryClone);

        if (current.page.scrollHeight > maxHeight) {
            summaryClone.remove();
            const donor = current;
            const finalPage = createQuotePdfPage(stage, source, false);
            pages.push(finalPage);
            finalPage.page.appendChild(summaryClone);

            // 最後一頁優先放「合計整塊」，再嘗試把前一頁最後面的品項搬過來。
            // 每次搬一筆就量一次高度；放不下就立即放回原頁，避免越搬越擠。
            while (donor.items.lastElementChild) {
                const candidate = donor.items.lastElementChild;
                finalPage.items.prepend(candidate);
                if (finalPage.page.scrollHeight > maxHeight) {
                    donor.items.appendChild(candidate);
                    break;
                }
            }
        }
    }

    source.remove();
    return pages.map(entry => entry.page);
}

async function addDocumentPagesToPdf(pdf, pages, options = {}) {
    const {
        scale = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ? 1.15 : 1.65,
        onProgress = null,
        addPageBeforeFirst = false
    } = options;
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const jpegQuality = isMobile ? 0.88 : 0.92;

    for (let index = 0; index < pages.length; index += 1) {
        if (typeof onProgress === 'function') onProgress(index + 1, pages.length);

        const page = pages[index];
        const canvas = await window.html2canvas(page, {
            backgroundColor:'#ffffff',
            scale,
            logging:false,
            useCORS:true,
            allowTaint:false,
            width:Math.ceil(page.scrollWidth),
            height:Math.ceil(page.scrollHeight),
            windowWidth:794
        });

        if (index > 0 || addPageBeforeFirst) pdf.addPage('a4', 'p');

        const maxWidthMm = 190;
        const maxHeightMm = 277;
        const naturalHeightMm = canvas.height * maxWidthMm / canvas.width;
        const renderHeightMm = Math.min(maxHeightMm, naturalHeightMm);
        const renderWidthMm = naturalHeightMm <= maxHeightMm
            ? maxWidthMm
            : canvas.width * renderHeightMm / canvas.height;
        const x = (210 - renderWidthMm) / 2;

        // 共用 PDF 核心：估價單、三家估價單、訂購單皆逐頁加入後立即釋放 Canvas。
        // 這可避免 iPhone Safari 在多頁文件上累積大型 Canvas / Base64 造成記憶體壓力。
        let imageData = canvas.toDataURL('image/jpeg', jpegQuality);
        pdf.addImage(imageData, 'JPEG', x, 10, renderWidthMm, renderHeightMm, undefined, 'FAST');
        imageData = null;
        canvas.width = 1;
        canvas.height = 1;

        if (index < pages.length - 1) {
            await new Promise(resolve => window.setTimeout(resolve, 0));
        }
    }
}

window.exportCurrentQuotePdf = async function() {
    const validationMessage = currentQuoteOutputValidation();
    if (validationMessage) {
        alert(validationMessage);
        return;
    }

    const button = document.getElementById('printBtn');
    const originalLabel = button?.innerText || '📄 匯出 PDF（自動同步雲端）';
    if (button) {
        button.disabled = true;
        button.innerText = '正在產生 PDF…';
    }

    let stage = null;
    try {
        if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
            throw new Error('PDF 元件尚未載入');
        }

        const quoteData = quoteDataForPdfExport();
        quoteData.lastOutputAt = new Date().toISOString();
        quoteData.lastOutputType = 'PDF';
        rememberQuoteCustomerPreferences(quoteData.ordererName || quoteData.clientName, quoteData.items);
        const isNewQuote = !editingQuoteNo || editingQuoteNo !== quoteData.quoteNo;
        let syncPromise;
        if (isNewQuote) {
            // 新估價單先原子確認並建立雲端文件，避免撞號時先產出一份會與舊單重號的 PDF。
            if (button) button.innerText = '正在確認估價單號…';
            await persistQuoteOutputRecord(quoteData, 'PDF');
            syncPromise = Promise.resolve(true);
            setQuoteOutputStatus('估價單已同步；正在產生 PDF…');
        } else {
            // 已存在的估價單仍維持原本快速體驗：雲端更新與 PDF 產生平行進行。
            syncPromise = persistQuoteOutputRecord(quoteData, 'PDF')
                .then(() => {
                    setQuoteOutputStatus('✓ PDF 已產生，估價單已同步');
                    return true;
                })
                .catch(() => {
                    setQuoteOutputStatus('PDF 已產生，但雲端同步失敗，請稍後再試', true);
                    return false;
                });
        }

        const exportDom = createQuotePdfStage(quoteData);
        stage = exportDom.stage;
        await waitForPdfImages(exportDom.documentNode);

        // 手機降低 Canvas 倍率以減少記憶體與等待時間；桌機維持較高解析度。
        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const scale = isMobile ? 1.15 : 1.65;
        // 大多數日常估價單只有一頁：先量實際排版高度，能放進 A4 就直接輸出，
        // 不再建立分頁 DOM、逐筆量高度，也不再重複等待同一批圖片。
        // 保留約 12px 安全邊界，避免 iPhone Safari 的字型/像素換算誤差造成底部裁切。
        const singlePageLimit = quotePdfPageHeightPx(stage) - 12;
        const isSinglePage = exportDom.documentNode.scrollHeight <= singlePageLimit;
        const pages = isSinglePage
            ? [exportDom.documentNode]
            : paginateQuotePdfDocument(stage, exportDom.documentNode);
        if (!isSinglePage) await waitForPdfImages(stage);

        // 單頁本身只有一張已壓縮 JPEG，關閉 jsPDF 額外 stream 壓縮可減少手機 CPU 等待；
        // 多頁仍保留原本壓縮設定，避免檔案過大。
        const pdf = new window.jspdf.jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: !isSinglePage });
        await addDocumentPagesToPdf(pdf, pages, {
            scale,
            onProgress: (pageNo, pageCount) => {
                if (button) button.innerText = `正在產生 PDF… ${pageNo}/${pageCount}`;
            }
        });
        if (button) button.innerText = '正在下載 PDF…';
        pdf.save(quotePdfFileName(quoteData));
        if (isNewQuote) setQuoteOutputStatus('✓ PDF 已產生，估價單已同步');
        else setQuoteOutputStatus('PDF 已產生；估價單同步中…');
        syncPromise.then(() => {});
    } catch (err) {
        console.error('匯出估價單 PDF 失敗：', err);
        alert('產生估價單 PDF 失敗：' + (err?.message || err) + '。請確認網路後再試一次。');
    } finally {
        stage?.remove();
        if (button) {
            button.disabled = false;
            button.innerText = originalLabel;
        }
    }
};

window.loadQuoteFromCloud = function() {
    const qNo = document.getElementById('searchQuoteNo').value.trim();
    if (!qNo) {
        alert('請輸入要查詢的估價單號');
        return;
    }
    fetchAndFillQuote(qNo);
};

async function fetchAndFillQuote(qNo) {
    try {
        const doc = await firestoreReadWithTimeout(
            db.collection('quotes').doc(qNo).get(),
            '載入估價單'
        );
        if (!doc.exists) {
            alert('找不到該估價單');
            return;
        }
        const data = doc.data() || {};
        if (!canViewAllData('quotes') && !belongsToCurrentUser(data.salesName, data.ownerUid)) {
            alert('您只能查看自己的估價單。');
            return;
        }

        if (currentUserRole === 'admin' || currentUserRole === 'purchaser') {
            await ensureSalesListLoaded();
        }
        restoringQuoteDraft = true;
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create');
        applyCompanyTheme(data.company || 'yushin');
        populateSalesDropdown();

        document.getElementById('quoteNo').value = data.quoteNo || qNo;
        document.getElementById('clientName').value = data.clientName || '';
        document.getElementById('ordererName').value = data.ordererName || '';
        document.getElementById('salesName').value = data.salesName || '';
        updateSalesPhoneDisplay();
        document.getElementById('quoteDate').value = data.quoteDate || '';
        document.getElementById('validDays').value = data.validDays ?? 90;
        document.getElementById('discountRateInput').value = data.discountRate || 0;
        document.getElementById('quoteItems').innerHTML = '';
        (Array.isArray(data.items) ? data.items : []).forEach(item => addQuoteRow(item));
        if (!document.getElementById('quoteItems').rows.length) addQuoteRow();
        setQuoteEditingContext(data.quoteNo || qNo);
        setQuoteOutputStatus('');
        calculateTotals();
        saveQuoteDraft();
    } catch (err) {
        console.error('無法從雲端讀取估價單：', err);
        alert('無法從雲端讀取：' + (err?.message || err));
    } finally {
        restoringQuoteDraft = false;
    }
}

window.openQuoteFromAdmin = async function(quoteNo) {
    if (!canAccessPage('quote.create')) {
        alert('您沒有權限開啟估價單。');
        return;
    }

    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '載入中…');
    if (button && !buttonState) return;

    try {
        // 優先使用目前列表已載入的資料，只有快取沒有時才讀 Firestore。
        // 這樣手機按「載入」時通常不需要再等一次網路。
        let source = myQuotesCache.find(q => q.quoteNo === quoteNo)
            || quoteHistorySearchResults.find(q => q.quoteNo === quoteNo);

        if (!source) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('quotes').doc(quoteNo).get(),
                '載入估價單'
            );
            if (!snapshot.exists) throw new Error('找不到這張估價單。');
            source = { id: snapshot.id, ...snapshot.data() };
        }

        if (!canViewAllData('quotes') && !belongsToCurrentUser(source.salesName, source.ownerUid)) {
            throw new Error('您只能載入自己名下的估價單。');
        }

        await ensureSalesListLoaded();

        // 載入既有估價單時禁止 populateSalesDropdown / 公司切換重新產生新單號。
        restoringQuoteDraft = true;
        actuallySwitchMainTab('quote-system');
        switchQuoteView('create', document.getElementById('qsub-create'));
        applyCompanyTheme(source.company || 'yushin');
        populateSalesDropdown();

        document.getElementById('clientName').value = source.clientName || '';
        document.getElementById('ordererName').value = source.ordererName || '';
        document.getElementById('salesName').value = source.salesName || '';
        document.getElementById('quoteDate').value = source.quoteDate || '';
        document.getElementById('quoteNo').value = source.quoteNo || quoteNo;
        setQuoteEditingContext(source.quoteNo || quoteNo);
        setQuoteOutputStatus('');
        document.getElementById('validDays').value = source.validDays ?? 90;
        document.getElementById('discountRateInput').value = source.discountRate || 0;
        updateSalesPhoneDisplay();

        const itemsBody = document.getElementById('quoteItems');
        itemsBody.innerHTML = '';
        if (Array.isArray(source.items) && source.items.length) {
            source.items.forEach(item => addQuoteRow(item));
        } else {
            addQuoteRow();
        }
        calculateTotals();

        restoringQuoteDraft = false;
        saveQuoteDraft();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
        console.error('載入估價單失敗：', err);
        alert('載入估價單失敗：' + (err?.message || err));
    } finally {
        restoringQuoteDraft = false;
        endActionButton(button, buttonState);
    }
};

window.copyQuoteAsNew = async function(quoteNo) {
    if (!canEditPage('quote.create')) {
        alert('您目前沒有建立估價單的權限。');
        return;
    }
    let source = myQuotesCache.find(quote => quote.quoteNo === quoteNo);
    try {
        if (!source) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('quotes').doc(quoteNo).get(),
                '複製估價單'
            );
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
        setQuoteEditingContext('');
        setQuoteOutputStatus('');
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
let quoteHistorySearchActive = false;
let quoteHistorySearchLoading = false;
let quoteHistorySearchKeyword = '';
let quoteHistorySearchResults = [];
let quoteHistorySearchTimer = null;
let quoteHistorySearchGeneration = 0;

function updateQuoteHistorySearchUi(message = '') {
    const status = document.getElementById('quoteHistorySearchStatus');
    if (status) status.innerText = message;
}

async function runQuoteHistorySearch() {
    const generation = ++quoteHistorySearchGeneration;
    const input = document.getElementById('myQuoteSearch');
    const rawKeyword = input?.value || '';
    const normalized = normalizeFullHistorySearchValue(rawKeyword);
    if (!normalized) {
        quoteHistorySearchActive = false;
        quoteHistorySearchLoading = false;
        quoteHistorySearchKeyword = '';
        quoteHistorySearchResults = [];
        updateQuoteHistorySearchUi('');
        renderMyQuotesList();
        return;
    }
    const queryToken = fullHistoryQueryToken('quote', rawKeyword);
    if (!queryToken) {
        quoteHistorySearchActive = false;
        quoteHistorySearchLoading = false;
        quoteHistorySearchResults = [];
        updateQuoteHistorySearchUi('目前帳號缺少可用的資料歸屬資訊，無法進行全歷史搜尋。');
        renderMyQuotesList();
        return;
    }

    quoteHistorySearchLoading = true;
    quoteHistorySearchActive = true;
    quoteHistorySearchKeyword = rawKeyword;
    quoteHistorySearchResults = [];
    const records = new Map();
    let cursor = null;
    let checked = 0;
    let lastIntermediateRenderAt = 0;
    updateQuoteHistorySearchUi('正在搜尋全部歷史估價單…');
    renderMyQuotesList();

    try {
        while (true) {
            let query = scopedHistorySearchQuery('quotes', queryToken).limit(DEFAULT_LIST_LIMIT);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '估價單索引搜尋');
            if (generation !== quoteHistorySearchGeneration) return;

            checked += snapshot.size;
            snapshot.forEach(doc => {
                const data = { id: doc.id, ...doc.data() };
                if (fullHistoryRecordMatches('quote', data, rawKeyword)) records.set(doc.id, data);
            });
            const now = Date.now();
            if (now - lastIntermediateRenderAt >= 100 || snapshot.size < DEFAULT_LIST_LIMIT) {
                lastIntermediateRenderAt = now;
                quoteHistorySearchResults = [...records.values()]
                    .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'quoteDate','quoteNo'));
                renderMyQuotesList();
            }
            updateQuoteHistorySearchUi(`全歷史搜尋中：已檢查 ${checked} 筆候選資料，找到 ${records.size} 筆…`);

            if (snapshot.size < DEFAULT_LIST_LIMIT) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
            await Promise.resolve();
        }
        if (generation !== quoteHistorySearchGeneration) return;
        quoteHistorySearchResults = [...records.values()]
            .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'quoteDate','quoteNo'));
        updateQuoteHistorySearchUi(`全歷史搜尋完成：找到 ${records.size} 筆`);
    } catch (err) {
        if (generation !== quoteHistorySearchGeneration) return;
        console.error('估價單全歷史搜尋失敗：', err);
        quoteHistorySearchActive = false;
        quoteHistorySearchResults = [];
        updateQuoteHistorySearchUi('全歷史搜尋索引尚未補齊，請管理員到資料庫管理執行搜尋索引補建。');
        renderMyQuotesList();
    } finally {
        if (generation === quoteHistorySearchGeneration) {
            quoteHistorySearchLoading = false;
            renderMyQuotesList();
        }
    }
}

window.scheduleQuoteHistorySearch = function() {
    clearTimeout(quoteHistorySearchTimer);
    const keyword = document.getElementById('myQuoteSearch')?.value || '';
    if (!normalizeFullHistorySearchValue(keyword)) return runQuoteHistorySearch();
    quoteHistorySearchTimer = scheduleListSearch(quoteHistorySearchTimer, () => runQuoteHistorySearch());
};

window.clearQuoteHistorySearch = function() {
    clearTimeout(quoteHistorySearchTimer);
    quoteHistorySearchGeneration++;
    quoteHistorySearchLoading = false;
    quoteHistorySearchActive = false;
    quoteHistorySearchKeyword = '';
    quoteHistorySearchResults = [];
    const input = document.getElementById('myQuoteSearch');
    if (input) input.value = '';
    updateQuoteHistorySearchUi('');
    renderMyQuotesList();
};

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
    if (view === 'my' && canViewAllData('quotes')) {
        ensureSalesListLoaded().then(() => {
            if (document.getElementById('myQuotesPanel')?.style.display === 'block') renderMyQuotesList();
        }).catch(err => console.warn('業務名單載入失敗：', err));
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
    const refreshButton = document.getElementById('quoteHistoryRefreshBtn');
    const hasMore = !!myQuotesPaginationState && myQuotesPaginationState.sourceIndex < myQuotesPaginationState.sources.length;
    if (button) {
        button.style.display = hasMore ? '' : 'none';
        button.disabled = myQuotesPageLoading;
        button.innerText = myQuotesPageLoading ? '載入中…' : '載入更多（每次 50 筆）';
    }
    if (refreshButton) {
        refreshButton.disabled = myQuotesPageLoading;
        refreshButton.textContent = myQuotesPageLoading ? '更新中…' : '↻ 更新';
    }
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
    }
    myQuotesPageLoading = true;
    const requestedRole = currentUserRole;
    updateMyQuotesLoadMoreButton();
    // 重新整理時保留目前畫面，背景抓到新資料後再一次替換，避免每次先清空造成長時間白畫面。
    const records = new Map(reset ? [] : myQuotesCache.map(quote => [quote.id, quote]));
    let remainingReads = DEFAULT_LIST_LIMIT;
    try {
        while (remainingReads > 0 && myQuotesPaginationState.sourceIndex < myQuotesPaginationState.sources.length) {
            const source = myQuotesPaginationState.sources[myQuotesPaginationState.sourceIndex];
            const requested = remainingReads;
            let query = source.query().limit(requested);
            if (source.cursor) query = query.startAfter(source.cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '估價單');
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
        writeAppDataCache('quotes', myQuotesCache);
        renderMyQuotesList();
        if (!currentUserName && myQuotesCache.length === 0) {
            hint.style.display = 'block';
            hint.innerText = '目前找不到以此帳號建立的新式紀錄。若要顯示舊估價單，請管理員在 users 帳號資料補上姓名，以便比對舊資料的負責業務。';
        }
    } catch (err) {
        console.error(err);
        myQuotesCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'quoteDate', 'quoteNo'));
        renderMyQuotesList();
        alert(err?.code === 'firestore-read-timeout'
            ? '估價單資料讀取逾時，請再按一次更新。'
            : '讀取估價單失敗，請確認網路或 Firestore 權限設定。');
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

function quoteBrandsForRecord(quote = {}) {
    return dedupeBrandsCaseInsensitive((quote.items || [])
        .map(item => resolveBrandName(item.brand || ''))
        .filter(Boolean));
}

let myQuoteBrandFilterSignature = '';
let myQuoteSalesFilterSignature = '';

function populateMyQuoteBrandFilter(source = []) {
    const select = document.getElementById('myQuoteBrandFilter');
    if (!select) return;
    const selected = select.value;
    const brands = new Map();
    source.forEach(quote => {
        quoteBrandsForRecord(quote).forEach(brand => {
            const key = String(brand).trim().toLocaleLowerCase();
            if (key && !brands.has(key)) brands.set(key, brand);
        });
    });
    const brandNames = [...brands.values()].sort((a,b)=>a.localeCompare(b,'zh-Hant'));
    const signature = JSON.stringify(brandNames);
    if (signature !== myQuoteBrandFilterSignature) {
        select.innerHTML = '<option value="">全部廠牌</option>' + brandNames
            .map(brand => `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('');
        myQuoteBrandFilterSignature = signature;
    }
    if (brandNames.includes(selected)) select.value = selected;
    else if (selected) select.value = '';
}

function populateMyQuoteSalesFilter() {
    const select = document.getElementById('myQuoteSalesFilter');
    if (!select) return;
    const canSeeAll = canViewAllData('quotes');
    select.style.display = canSeeAll ? '' : 'none';
    if (!canSeeAll) { select.value = ''; return; }
    const selected = select.value;
    const names = [...new Set([
        ...salesList.filter(person => String(person.role || 'sales').toLowerCase() === 'sales').map(person => stripPhoneSuffix(person.name || '')),
        ...myQuotesCache.map(quote => stripPhoneSuffix(quote.salesName || '')),
        ...quoteHistorySearchResults.map(quote => stripPhoneSuffix(quote.salesName || ''))
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const signature = JSON.stringify(names);
    if (signature !== myQuoteSalesFilterSignature) {
        select.innerHTML = '<option value="">全部業務</option>' + names.map(name =>
            `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
        myQuoteSalesFilterSignature = signature;
    }
    if (names.includes(selected)) select.value = selected;
    else if (selected) select.value = '';
}

window.renderMyQuotesList = function() {
    const tbody = document.getElementById('myQuotesBody');
    const searchInput = document.getElementById('myQuoteSearch');
    const keyword = (searchInput.value || '').toLowerCase();
    const periodFilter = document.getElementById('myQuotePeriodFilter')?.value || 'this-year';
    const statusFilter = document.getElementById('myQuoteStatusFilter')?.value || '';
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    const isAdminViewingAll = canViewAllData('quotes');
    const visibleQuoteSource = quoteHistorySearchActive ? quoteHistorySearchResults : myQuotesCache;
    populateMyQuoteSalesFilter();
    populateMyQuoteBrandFilter(visibleQuoteSource);
    const salesFilter = document.getElementById('myQuoteSalesFilter')?.value || '';
    const brandFilter = document.getElementById('myQuoteBrandFilter')?.value || '';
    const salesHeader = document.getElementById('myQuotesSalesHeader');
    if (salesHeader) salesHeader.style.display = isAdminViewingAll ? '' : 'none';

    visibleQuoteSource.forEach(q => {
        if (!quoteHistorySearchActive && keyword) {
            const itemSearchText = (q.items || []).map(item =>
                `${item.brand || ''} ${item.model || ''} ${item.nameCn || ''} ${item.nameEn || ''} ${item.spec || ''}`
            ).join(' ');
            const searchable = `${q.quoteNo || ''} ${q.clientName || ''} ${q.ordererName || ''} ${q.salesName || ''} ${itemSearchText}`.toLowerCase();
            if (!searchable.includes(keyword)) return;
        }
        if (salesFilter && stripPhoneSuffix(q.salesName || '') !== salesFilter) return;
        if (brandFilter && !quoteBrandsForRecord(q).includes(brandFilter)) return;
        if (statusFilter === 'open' && q.dealClosed) return;
        if (statusFilter === 'deal' && !q.dealClosed) return;
        if (!dateInUnifiedPeriod(q.quoteDate || q.createdAt, periodFilter)) return;
        shown++;

        const tr = document.createElement('tr');
        bindListRowSelection(tr);

        // --- 修改這裡：根據狀態顯示不同按鈕 ---
        const statusBadges = [];
        if (q.dealClosed) {
            statusBadges.push('<span class="quote-status-badge is-deal">已成交</span>');
            if (q.threeQuoteRecord) statusBadges.push('<span class="quote-status-badge is-three">三估單</span>');
        } else {
            statusBadges.push('<span class="quote-status-badge is-quoted">已報價</span>');
            if (q.threeQuoteRecord) statusBadges.push('<span class="quote-status-badge is-three">三估單</span>');
        }
        const statusCell = `<div class="quote-status-badges">${statusBadges.join('')}</div>`;

        const dealButton = q.dealClosed
            ? ''
            : `<button type="button" class="btn-small quote-primary-deal" onclick="markQuoteAsDeal('${escapeAttr(q.quoteNo)}')">✓ 成交</button>`;
        // ------------------------------------

        tr.innerHTML = `
            <td>${escapeHtml(q.quoteNo || '')}</td>
            <td>${escapeHtml(q.clientName || '')}</td>
            <td>${escapeHtml(q.ordererName || '')}</td>
            ${isAdminViewingAll ? `<td>${escapeHtml(stripPhoneSuffix(q.salesName))}</td>` : ''}
            <td>${escapeHtml(q.quoteDate || '')}</td>
            <td>${escapeHtml(q.grandTotal || '')}</td>
            <td>${statusCell}</td>
            <td class="no-print quote-list-actions">
                <div class="quote-list-action-row">
                    <button type="button" class="btn-small" onclick="openQuoteFromAdmin('${escapeAttr(q.quoteNo)}')">載入</button>
                    ${q.threeQuoteRecord ? `<button type="button" class="btn-small btn-secondary" onclick="openSavedThreeQuoteRecord('${escapeAttr(q.quoteNo)}')">三估單</button>` : ''}
                    ${dealButton}
                    <details class="quote-more-menu">
                        <summary class="btn-small btn-secondary">更多</summary>
                        <div class="quote-more-menu-popover">
                            <button type="button" onclick="copyQuoteAsNew('${escapeAttr(q.quoteNo)}')">複製成新估價單</button>
                            ${canEditPage('forecast') ? `<button type="button" onclick="createForecastFromQuote('${escapeAttr(q.quoteNo)}')">建立 Forecast</button>` : ''}
                            ${q.dealClosed ? `<button type="button" onclick="unmarkQuoteAsDeal('${escapeAttr(q.quoteNo)}')">取消成交</button>` : ''}
                            ${trueUserRole === 'admin' && currentUserRole === 'admin' ? `<button type="button" class="danger-menu-item" onclick="permanentlyDeleteQuote('${escapeAttr(q.quoteNo)}')">永久刪除</button>` : ''}
                        </div>
                    </details>
                </div>
            </td>
        `;
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);

    document.getElementById('myQuotesEmptyHint').style.display = shown === 0 ? 'block' : 'none';
};

// 成交：標記估價單為已成交，並把裡面每一個品項匯入訂單管理系統（一次性動作，避免重複匯入）
window.createForecastFromQuote = async function(quoteNo) {
    if (!canCreateForecastCapability() || !canEditPage('forecast')) {
        alert('您沒有 Forecast 編輯權限。');
        return;
    }

    try {
        const cached = myQuotesCache.find(q => q.quoteNo === quoteNo);
        const quoteSnapshot = cached ? null : await firestoreReadWithTimeout(
            db.collection('quotes').doc(quoteNo).get(),
            '建立 Forecast 的估價單'
        );
        const q = cached || quoteSnapshot?.data();

        if (!q) {
            throw new Error('找不到估價單');
        }

        const existing = await firestoreReadWithTimeout(
            db.collection('forecasts')
                .where('sourceType', '==', DOCUMENT_TYPES.QUOTE)
                .where('sourceId', '==', quoteNo)
                .limit(1)
                .get(),
            'Forecast 重複來源檢查'
        );

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
            ...commercialCreatorFields(),
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

window.markQuoteAsDeal = async function(quoteNo) {
    const button=actionButtonFromEventOrSelector();
    const buttonState=beginActionButton(button,'開啟訂單…');
    if(button && !buttonState)return;
    try {
        const cached=myQuotesCache.find(q=>q.quoteNo===quoteNo) || quoteHistorySearchResults.find(q=>q.quoteNo===quoteNo);
        const quoteSnapshot=cached ? null : await firestoreReadWithTimeout(
            db.collection('quotes').doc(quoteNo).get(),
            '成交轉訂單估價單'
        );
        const q=cached || quoteSnapshot?.data();
        if(!q)throw new Error('找不到這張估價單');
        if(q.dealClosed){alert('這張估價單已經標記過成交了。');return;}
        const sourceItems=(q.items||[]).filter(item=>item.nameCn||item.nameEn||item.model);
        if(!sourceItems.length)throw new Error('估價單沒有可建立訂單的品項。');

        // 成交不是直接寫死訂貨方式。先進入正式的訂單輸入流程，
        // 讓使用者逐品項確認「採購下單／業務自行訂購」及「倉庫／原廠直送」後才儲存。
        const toOrderItem=(sourceItem,index)=>{
            const brand=resolveBrandName(sourceItem.brand||'');
            const priceMatch=sourceItem.model?findPriceItemForOrder({itemCode:sourceItem.model,brand}):null;
            return normalizeNewOrderItem({
                itemId:`quote-${index+1}`,
                productId:sourceItem.productId||priceMatch?.productId||(priceMatch?stableProductId(priceMatch):''),
                itemCode:sourceItem.model||'', itemName:sourceItem.nameCn||sourceItem.nameEn||'',
                itemNameEn:sourceItem.nameEn||'', brand,
                productLine:sourceItem.productLine||priceMatch?.productLine||'',
                productType:sourceItem.productType||priceMatch?.productType||'',
                spec:sourceItem.spec||priceMatch?.spec||'', supplier:priceMatch?.supplier||'',
                qty:Number(sourceItem.qty||1), unitPrice:parseMoney(sourceItem.price||0),
                procurementType:'PURCHASING_PO', fulfillmentType:'WAREHOUSE'
            });
        };
        const items=sourceItems.map(toOrderItem);
        const first=items[0];
        openOrderWorkspace(document.querySelector('[data-main-nav="orders"]'));
        openOrderModal({
            ...first,
            customerName:q.ordererName||q.clientName||'',
            sourceType:DOCUMENT_TYPES.QUOTE,
            sourceId:quoteNo,
            ownerUid:q.ownerUid||'',
            salesName:stripPhoneSuffix(q.salesName||''),
            salesCode:q.salesCode||salesCodeForName(q.salesName)
        });
        newOrderDraftItems=items.slice(1);
        renderNewOrderDraftItems();
        window._orderModalQuoteContext={
            quoteNo,
            ownerUid:q.ownerUid||'',
            salesName:stripPhoneSuffix(q.salesName||''),
            salesCode:q.salesCode||salesCodeForName(q.salesName),
            company:q.company||'',
            invoiceTitle:q.clientName||''
        };
        const title=document.getElementById('orderModalTitle');
        if(title)title.innerText=`估價單 ${quoteNo} 成交 → 建立訂單`;
        const invoice=document.getElementById('orderInvoiceTitle');
        if(invoice)invoice.value=q.clientName||'';
        window.scrollTo({top:0,behavior:'smooth'});
    } catch(err) {
        alert('開啟訂單失敗：'+err.message);
    } finally {
        endActionButton(button,buttonState);
    }
};

window.unmarkQuoteAsDeal = async function(quoteNo) {
    const button=actionButtonFromEventOrSelector();
    const buttonState=beginActionButton(button,'處理中…');
    if(button && !buttonState)return;
    if (!confirm(
        `確定要取消估價單 ${quoteNo} 的成交狀態嗎？相關訂單將標記為取消並釋放已預留庫存，不會永久刪除。`
    )) { endActionButton(button,buttonState); return; }

    try {
        const linkedOrders = await readQueryInBatches(
            db.collection('orders').where('quoteNo', '==', quoteNo).orderBy('quoteNo')
        );

        const actor = deliveryActor();
        const cancelledAt = new Date().toISOString();
        const cancelledDate = localDateString();

        // 每筆來源訂單沿用正式的訂單生命週期與庫存釋放邏輯
        for (const linkedOrder of linkedOrders) {
            await db.runTransaction(async transaction => {
                const orderRef = db.collection('orders').doc(linkedOrder.id);
                const orderSnap = await transaction.get(orderRef);

                if (!orderSnap.exists) return;

                const order = orderSnap.data();

                // 已取消的訂單不重複釋放庫存
                if (normalizedOrderStatus(order) === 'cancelled') return;

                await adjustInventoryReservationForLifecycle(
                    transaction,
                    linkedOrder.id,
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

                const cancelledOrder = {...order,status:'cancelled',orderStatus:'cancelled',orderStatusDate:cancelledDate,orderStatusReason:'來源估價單取消成交'};
                transaction.update(orderRef, {
                    status: 'cancelled',
                    orderStatus: 'cancelled',
                    orderStatusDate: cancelledDate,
                    orderStatusReason: '來源估價單取消成交',
                    cancelledAt,
                    cancelledBy: actor,
                    cancelReason: '來源估價單取消成交',
                    ...orderWorkIndexFields(cancelledOrder),
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

        const reopenPatch={dealClosed:false,dealClosedAt:null,status:BUSINESS_STATUS.ACTIVE};
        const cachedQuote=myQuotesCache.find(item=>item.quoteNo===quoteNo);
        if(cachedQuote)Object.assign(cachedQuote,reopenPatch);
        const searchedQuote=quoteHistorySearchResults.find(item=>item.quoteNo===quoteNo);
        if(searchedQuote)Object.assign(searchedQuote,reopenPatch);
        renderMyQuotesList();

        alert('成交狀態已取消；相關訂單已保留並標記為取消，預留庫存已同步釋放。');

    } catch (err) {
        alert('取消失敗：' + err.message);
    } finally {
        endActionButton(button,buttonState);
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
let orderLoadGeneration = 0;
let orderLoadErrorMessage = '';

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

function orderCompletionDate(order) {
    if (!order?.isBilled || deliveryProgressInfo(order).state !== 'complete') return '';
    const invoiceDate = orderInvoiceDate(order);
    const records = savedDeliveryRecords(order);
    const deliveryDate = records.length
        ? records.reduce((latest, record) => {
            const date = record.date || dateOnlyFromTimestamp(record.createdAt);
            return date && date > latest ? date : latest;
        }, '')
        : (order?.isDelivered ? order.orderDate || '' : '');
    const returnDate = savedReturnRecords(order).reduce((latest, record) => {
        const date = record.date || dateOnlyFromTimestamp(record.createdAt);
        return date && date > latest ? date : latest;
    }, '');
    // 核銷、送貨與退貨可跨日補登；訂單重新達成完整履約時，以三條流程最後一個發生日作為完成日。
    return [invoiceDate, deliveryDate, returnDate].filter(Boolean).sort().pop() || '';
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
    if (category === 'complete') return dateInOrderPeriod(orderCompletionDate(order));
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

let inventoryCache=[], inventoryCursor=null, inventoryHasMore=true, inventoryLoading=false, inventoryLedgerCache=[], pendingSupplyCache=[];
let warehouseStockCache = new Map();
function invalidateWarehouseStockCache(productKey = '', warehouseId = '') {
    if (productKey && warehouseId) {
        warehouseStockCache.delete(warehouseId + '||' + productKey);
        return;
    }
    if (productKey) {
        [...warehouseStockCache.keys()].filter(key=>key.endsWith('||' + productKey)).forEach(key=>warehouseStockCache.delete(key));
        return;
    }
    warehouseStockCache.clear();
}
function expiryDays(date){if(!date)return null;return Math.ceil((new Date(date+'T23:59:59')-new Date())/86400000);}
function lotStatus(lot){const d=expiryDays(lot.expiryDate);if(d===null)return '';if(d<0)return '已過期';if(d<=30)return '30天內';if(d<=60)return '60天內';if(d<=90)return '90天內';return '';}
function fefoLots(stock){return [...(stock.lots||[])].filter(l=>Number(l.qty||0)>0).sort((a,b)=>String(a.expiryDate||'9999-12-31').localeCompare(String(b.expiryDate||'9999-12-31')));}
async function loadWarehouseStocksForInventoryPage() {
    await loadWarehouseMaster();
    const productKeys = [...new Set(inventoryCache
        .map(item => String(item.productKey || item.productId || '').trim())
        .filter(Boolean))];
    if (!productKeys.length || !warehouseMasterCache.length) return;

    // Firestore 'in' 查詢分批處理目前頁面的 productKey，避免每個品項 × 每個倉庫各讀一次文件。
    const chunkSize = 30;
    const jobs = [];
    warehouseMasterCache.filter(warehouse => warehouse.active !== false).forEach(warehouse => {
        for (let i = 0; i < productKeys.length; i += chunkSize) {
            const keys = productKeys.slice(i, i + chunkSize);
            jobs.push(
                firestoreReadWithTimeout(
                    db.collection('warehouseStocks')
                        .where('warehouseId', '==', warehouse.id)
                        .where('productKey', 'in', keys)
                        .get(),
                    '倉庫庫存批次'
                ).then(snapshot => {
                        snapshot.docs.forEach(doc => {
                            const data = { id: doc.id, ...doc.data() };
                            const productKey = String(data.productKey || data.productId || '').trim();
                            if (productKey) warehouseStockCache.set(warehouse.id + '||' + productKey, data);
                        });
                    })
            );
        }
    });
    await Promise.all(jobs);

    // 沒有 warehouseStock 文件的品項也記成 null，避免 render 階段誤以為尚未讀取。
    warehouseMasterCache.filter(warehouse => warehouse.active !== false).forEach(warehouse => {
        productKeys.forEach(productKey => {
            const cacheKey = warehouse.id + '||' + productKey;
            if (!warehouseStockCache.has(cacheKey)) warehouseStockCache.set(cacheKey, null);
        });
    });
}

window.loadInventory=async function(reset=true){
 if(inventoryLoading||!canAccessPage('inventory'))return;if(reset){inventoryCursor=null;inventoryHasMore=true;warehouseStockCache=new Map();if(!inventoryCache.length){const cached=readAppDataCache('inventory');if(cached?.records?.length){inventoryCache=cached.records;renderInventoryList();}}} inventoryLoading=true;
 const refreshButton=document.getElementById('inventoryRefreshBtn');
 if(refreshButton&&reset){refreshButton.disabled=true;refreshButton.textContent='載入中…';}
 try{let q=db.collection('inventory').orderBy('updatedAt','desc').limit(DEFAULT_LIST_LIMIT);if(inventoryCursor)q=q.startAfter(inventoryCursor);const snap=await firestoreReadWithTimeout(q.get(),'庫存清單');if(!snap.empty)inventoryCursor=snap.docs[snap.docs.length-1];
 const freshRows=snap.docs.map(d=>({id:d.id,...d.data()}));
 if(reset){
   // stale-while-revalidate：舊快取只負責先畫畫面；雲端第一頁成功後必須整頁取代，
   // 否則已刪除／已不符合條件的舊庫存會永遠殘留在本機 cache。
   inventoryCache=freshRows;
 }else{
   freshRows.forEach(x=>{const i=inventoryCache.findIndex(v=>v.id===x.id);if(i>=0)inventoryCache[i]=x;else inventoryCache.push(x);});
 }
 inventoryHasMore=snap.size===DEFAULT_LIST_LIMIT;
 if(reset){
 const [m,supplies]=await Promise.all([
 firestoreReadWithTimeout(db.collection('inventoryMovements').orderBy('createdAt','desc').limit(DEFAULT_LIST_LIMIT).get(),'庫存異動'),
 firestoreReadWithTimeout(db.collection('supplyOrders').where('status','in',['ORDERED','PARTIAL_RECEIPT']).limit(100).get(),'在途供應').catch(()=>({docs:[]}))
 ]);inventoryLedgerCache=m.docs.map(d=>({id:d.id,...d.data()}));pendingSupplyCache=supplies.docs.map(d=>({id:d.id,...d.data()})).filter(row=>(row.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP').sort((a,b)=>String(b.orderDate||b.createdAt||'').localeCompare(String(a.orderDate||a.createdAt||'')));
 }
 await loadWarehouseStocksForInventoryPage();
 writeAppDataCache('inventory', inventoryCache);
 renderInventoryList();renderInventoryLedger();renderPendingInventoryItems();
 }catch(e){alert('讀取庫存失敗：'+e.message);}finally{inventoryLoading=false;const b=document.getElementById('inventoryLoadMoreBtn');if(b)b.style.display=inventoryHasMore?'':'none';if(refreshButton){refreshButton.disabled=false;refreshButton.textContent='↻ 更新';}}
};
let businessProductSearchTimer = null;
window.queueBusinessProductSearch=function(){
 clearTimeout(businessProductSearchTimer);
 const input=document.getElementById('businessProductSearch'),raw=String(input?.value||'').trim();
 if(raw.length<2){const status=document.getElementById('businessProductSearchStatus');if(status)status.textContent=raw.length?'再輸入 1 個字即可搜尋。':'';return;}
 businessProductSearchTimer=scheduleListSearch(businessProductSearchTimer,()=>searchBusinessProducts());
};
window.searchBusinessProducts=async function(){
 clearTimeout(businessProductSearchTimer);
 const input=document.getElementById('businessProductSearch'),status=document.getElementById('businessProductSearchStatus'),wrap=document.getElementById('businessProductSearchResults'),body=document.getElementById('businessProductSearchBody');
 const raw=String(input?.value||'').trim();if(raw.length<2){alert('請至少輸入 2 個字或完整貨號。');return;}
 if(status)status.textContent='查詢中…';if(input)input.disabled=true;
 try{
   const normalized=normalizeItemCodeLoose(raw);const end=raw+'\uf8ff';
   const [codeSnap,nameSnap]=await Promise.all([
     firestoreReadWithTimeout(
       db.collection('products').where('normalizedPartNo','==',normalized).limit(25).get(),
       '產品貨號搜尋'
     ),
     firestoreReadWithTimeout(
       db.collection('products').orderBy('productName').startAt(raw).endAt(end).limit(25).get(),
       '產品名稱搜尋'
     ).catch(()=>({docs:[]}))
   ]);
   const map=new Map();[...(codeSnap.docs||[]),...(nameSnap.docs||[])].forEach(doc=>map.set(doc.id,{id:doc.id,...doc.data()}));
   const products=[...map.values()].slice(0,25);
   const productKeys=[...new Set(products.map(product=>String(product.productId||product.id||'').trim()).filter(Boolean))];
   const stockByProduct=new Map();
   if(productKeys.length){
     const stockSnap=await firestoreReadWithTimeout(
       db.collection('warehouseStocks').where('productKey','in',productKeys).get(),
       '產品庫存搜尋'
     );
     stockSnap.docs.forEach(doc=>{
       const row=doc.data(),key=String(row.productKey||row.productId||'').trim();
       if(!key)return;
       const current=stockByProduct.get(key)||{onHand:0,reserved:0,incoming:0};
       const n=inventoryNumbers(row);
       stockByProduct.set(key,{onHand:current.onHand+n.onHand,reserved:current.reserved+n.reserved,incoming:current.incoming+n.incoming});
     });
   }
   body.innerHTML=products.map(product=>{const key=String(product.productId||product.id||'').trim();const rawStock=stockByProduct.get(key)||{};const n=inventoryNumbers(rawStock);return `<tr><td>${escapeHtml(product.manufacturerPartNo||'')}</td><td>${escapeHtml(product.productName||'')}</td><td>${escapeHtml(product.brandName||'')}</td><td>${Number(product.listPrice||0).toLocaleString()}</td><td>${n.onHand}</td><td>${n.reserved}</td><td>${n.available}</td></tr>`;}).join('')||'<tr><td colspan="7">查無結果</td></tr>';
   if(wrap)wrap.style.display='';if(status)status.textContent=`完成，共 ${products.length} 筆`;
 }catch(err){if(status)status.textContent='查詢失敗';alert('產品查詢失敗：'+err.message);}
 finally{if(input)input.disabled=false;}
};
let inventorySearchTimer=null;
let inventorySearchActive=false;
let inventorySearchLoading=false;
let inventorySearchResults=[];

function buildInventorySearchTokens(record={}){
 const values=[record.itemCode,record.itemName,record.brand,record.productKey,record.productId,
   ...(Array.isArray(record.lots)?record.lots.flatMap(lot=>[lot.lotNo,lot.expiryDate]):[])];
 const tokens=new Set();
 for(const raw of values){
   const normalized=normalizeFullHistorySearchValue(raw);
   if(!normalized)continue;
   tokens.add(normalized);
   const maxGram=Math.min(6,normalized.length);
   for(let size=1;size<=maxGram;size++){
     for(let i=0;i+size<=normalized.length;i++){
       tokens.add(normalized.slice(i,i+size));
       if(tokens.size>=300)return [...tokens];
     }
   }
 }
 return [...tokens];
}

function inventoryRecordMatches(record,keyword){
 const needle=normalizeFullHistorySearchValue(keyword);
 if(!needle)return true;
 const values=[record.itemCode,record.itemName,record.brand,record.productKey,record.productId,
   ...(Array.isArray(record.lots)?record.lots.flatMap(lot=>[lot.lotNo,lot.expiryDate]):[])];
 return values.some(value=>normalizeFullHistorySearchValue(value).includes(needle));
}
window.scheduleInventorySearch=function(){
 clearTimeout(inventorySearchTimer);
 const keyword=document.getElementById('inventorySearch')?.value||'';
 if(!normalizeFullHistorySearchValue(keyword)){
   inventorySearchActive=false;inventorySearchResults=[];
   const status=document.getElementById('inventorySearchStatus');if(status)status.textContent='';
   renderInventoryList();return;
 }
 inventorySearchTimer=scheduleListSearch(inventorySearchTimer,()=>runInventorySearch());
};
async function runInventorySearch(){
 const keyword=document.getElementById('inventorySearch')?.value||'';
 const normalized=normalizeFullHistorySearchValue(keyword);
 const status=document.getElementById('inventorySearchStatus');
 if(!normalized){inventorySearchActive=false;inventorySearchResults=[];if(status)status.textContent='';renderInventoryList();return;}
 if(inventorySearchLoading)return;
 inventorySearchLoading=true;inventorySearchActive=true;inventorySearchResults=[];
 const results=new Map();
 if(status)status.textContent='正在搜尋全部庫存…';
 renderInventoryList();
 try{
   const token=fullHistoryServerToken(keyword);
   let checked=0,cursor=null;
   if(token){
     while(true){
       let query=db.collection('inventory')
         .where('searchTokens','array-contains',token)
         .limit(DEFAULT_LIST_LIMIT);
       if(cursor)query=query.startAfter(cursor);
       const snapshot=await firestoreReadWithTimeout(query.get(),'庫存索引搜尋');
       checked+=snapshot.size;
       snapshot.docs.forEach(doc=>{
         const row={id:doc.id,...doc.data()};
         if(inventoryRecordMatches(row,keyword))results.set(row.id,row);
       });
       inventorySearchResults=[...results.values()].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
       renderInventoryList();
       if(status)status.textContent=`全庫搜尋中：已檢查 ${checked} 筆候選資料，找到 ${results.size} 筆…`;
       if(snapshot.size<DEFAULT_LIST_LIMIT)break;
       cursor=snapshot.docs[snapshot.docs.length-1];
       await Promise.resolve();
     }
   }
   if(status)status.textContent=`全庫搜尋完成：找到 ${results.size} 筆`;
 }catch(err){
   console.error('庫存全庫搜尋失敗：',err);
   if(status)status.textContent='搜尋失敗，請重試';
 }finally{inventorySearchLoading=false;renderInventoryList();}
}

let inventoryBrandFilterSignature = '';

function populateInventoryBrandFilter() {
 const select=document.getElementById('inventoryBrandFilter');
 if(!select)return [];
 const selected=select.value;
 const brands=getPriceListBrands(true);
 const signature=JSON.stringify(brands);
 if(signature!==inventoryBrandFilterSignature){
   select.innerHTML='<option value="">全部廠牌</option>'+brands.map(brand=>
     `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('')
     +`<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
   inventoryBrandFilterSignature=signature;
 }
 if(brands.includes(selected)||selected===OTHER_BRAND_OPTION_KEY)select.value=selected;
 else if(selected)select.value='';
 return brands;
}

function warehouseStockRowsForProduct(productKey) {
 return warehouseMasterCache.filter(warehouse=>warehouse.active!==false).map(warehouse=>{
   const stock=warehouseStockCache.get(warehouse.id+'||'+productKey);
   return {warehouse,n:inventoryNumbers(stock||{})};
 });
}
function warehouseStockTotals(productKey) {
 const rows=warehouseStockRowsForProduct(productKey);
 const onHand=rows.reduce((sum,row)=>sum+row.n.onHand,0);
 const reserved=rows.reduce((sum,row)=>sum+row.n.reserved,0);
 const incoming=rows.reduce((sum,row)=>sum+row.n.incoming,0);
 return {rows,onHand,reserved,available:onHand-reserved,incoming};
}

window.renderInventoryList=function(){
 const body=document.getElementById('inventoryListBody');if(!body)return;
 const k=(document.getElementById('inventorySearch')?.value||'').toLowerCase();
 const stateFilter=document.getElementById('inventoryStateFilter')?.value||'all';
 const brands=populateInventoryBrandFilter();
 const brandFilter=document.getElementById('inventoryBrandFilter')?.value||'';
 const rowsHtml=[];
 const inventoryRows=inventorySearchActive?inventorySearchResults:inventoryCache;
 inventoryRows.forEach(x=>{
   if(brandFilter&&orderBrandFilterValue(x.brand,brands)!==brandFilter)return;
   const lots=fefoLots(x);
   const productKey=x.productKey||x.productId||'';
   const warehouseState=warehouseStockTotals(productKey);
   const warehouseRows=warehouseState.rows;
   const warehouseSearch=warehouseRows.map(row=>row.warehouse.warehouseName||'').join(' ');
   const text=`${x.itemCode||''} ${x.itemName||''} ${x.brand||''} ${warehouseSearch} ${lots.map(l=>l.lotNo).join(' ')}`.toLowerCase();
   if(!inventorySearchActive&&k&&!text.includes(k))return;
   const n=warehouseState;
   const safetyStock=Number(x.safetyStock||0);
   if(stateFilter==='low' && !(safetyStock>0 && n.available<=safetyStock))return;
   if(stateFilter==='out' && n.available>0)return;
   if(stateFilter==='reserved' && n.reserved<=0)return;
   const warehouseHtml=warehouseRows.filter(row=>row.n.onHand||row.n.reserved||row.n.incoming).map(row=>
      `<div><strong>${escapeHtml(row.warehouse.warehouseName||row.warehouse.id)}</strong>：現有 ${row.n.onHand}／占用 ${row.n.reserved}／可用 ${row.n.available}／在途 ${row.n.incoming}</div>`
   ).join('') || '<span style="color:#888;">目前沒有分倉庫存</span>';
   const lotHtml=lots.slice(0,3).map(l=>`${escapeHtml(l.lotNo||'無批號')} ${escapeHtml(l.expiryDate||'')} ${lotStatus(l)?'['+lotStatus(l)+']':''}`).join('<br>');
   const reserved=n.reserved>0?`<button type="button" class="link-button inventory-reserved-link" onclick="openInventoryReservationDetails('${escapeAttr(x.productKey||x.id||'')}')">${n.reserved}</button>`:'0';
   rowsHtml.push(`<tr>
      <td data-th="貨號">${escapeHtml(x.itemCode||'')}</td>
      <td data-th="品名">${escapeHtml(x.itemName||'')}</td>
      <td data-th="廠牌">${escapeHtml(x.brand||'')}</td>
      <td data-th="倉庫位置">${warehouseHtml}</td>
      <td data-th="現有庫存">${n.onHand}</td>
      <td data-th="已占用">${reserved}</td>
      <td data-th="可用庫存">${n.available}</td>
      <td data-th="安全庫存"><button type="button" class="link-button ${n.available<=Number(x.safetyStock||0)&&Number(x.safetyStock||0)>0?'status-overdue':''}" onclick="setInventorySafetyStock('${escapeAttr(x.id)}')">${Number(x.safetyStock||0)}</button></td>
      <td data-th="在途">${n.incoming}</td>
      <td data-th="批號／效期">${lotHtml}</td>
      <td data-th="操作" class="no-print">
        ${canEditPage('inventory') ? `
          <div class="inventory-row-actions">
            ${safetyStock>0 && n.available<=safetyStock && n.available+n.incoming<safetyStock && canEditPage('orders.po') ? `<button type="button" class="btn-small" onclick="openInventoryReplenishment('${escapeAttr(x.id)}')">建立補庫採購</button>` : ''}
            <button type="button" class="btn-small" onclick="openInventoryItemAdjustment('decrease','${escapeAttr(x.id)}')">減庫存</button>
            <button type="button" class="btn-small btn-secondary" onclick="openInventoryItemAdjustment('return','${escapeAttr(x.id)}')">退貨</button>
            <button type="button" class="btn-small btn-danger" onclick="openInventoryItemAdjustment('scrap','${escapeAttr(x.id)}')">報廢</button>
            <button type="button" class="btn-small btn-secondary" onclick="openInventoryItemAdjustment('warehouse_allocation','${escapeAttr(x.id)}')">分倉</button>
          </div>` : '僅可查看'}
      </td>
   </tr>`);
 });
 body.innerHTML=rowsHtml.join('');
};
window.openInventoryReplenishment = async function(inventoryId) {
    if (!canEditPage('orders.po')) { alert('您沒有採購權限。'); return; }
    const item = inventoryCache.find(x => x.id === inventoryId);
    if (!item) { alert('找不到庫存品項。'); return; }
    await loadSupplierWarehouseMasters();
    const stock = warehouseStockTotals(item.productKey||item.productId||'');
    const safetyStock = Math.max(0, Number(item.safetyStock || 0));
    const projectedAvailable = stock.available + stock.incoming;
    if (safetyStock > 0 && projectedAvailable >= safetyStock) {
        alert(`目前可用 ${stock.available}、在途 ${stock.incoming}；既有在途到貨後已可達安全庫存 ${safetyStock}，不需重複建立補庫採購。`);
        return;
    }
    const suggestedQty = Math.max(1, safetyStock - projectedAvailable);
    const match = await findProductByCode(item.itemCode || '');
    let unitPrice = 0;
    if (match) {
        const secureCost = await loadVisibleProductCost(match);
        unitPrice = secureCost !== null && Number.isFinite(secureCost)
            ? secureCost
            : (authorizationTypeForProduct(match) === 'NON_AUTHORIZED' ? Number(match.cost || 0) : 0);
    }
    poDirectStockMode = true;
    poEditingId = null;
    poAllItems = [];
    poItems = [{
        orderId:'', itemName:item.itemName || match?.nameCn || match?.nameEn || '',
        itemCode:item.itemCode || match?.model || '', productId:item.productId || item.productKey || match?.productId || '',
        brand:resolveBrandName(item.brand || match?.brand || ''), qty:suggestedQty,
        unitPrice, supplier:match?.supplier || '', productLine:match?.productLine || '',
        fulfillmentType:'WAREHOUSE', warehouseId:defaultWarehouse()?.id || ''
    }];
    poAllItems = poItems;
    populatePoVendorSuggestions();
    document.getElementById('poVendorName').value = '';
    await autoFillPoSupplier(poItems);
    document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
    document.getElementById('poDate').value = localDateString();
    switchPoCompany(currentCompany || 'yushin', null, true);
    generatePoNo();
    updatePoModeUI();
    const hint = document.getElementById('poModeHint');
    if (hint) hint.textContent = `安全庫存補貨：目前可用 ${stock.available}，在途 ${stock.incoming}，到貨後預估可用 ${projectedAvailable}，安全庫存 ${safetyStock}，建議採購 ${suggestedQty}。`;
    document.getElementById('poModalOverlay').classList.add('active');
};

window.setInventorySafetyStock=async function(inventoryId){
 if(!canEditPage('inventory'))return;const item=inventoryCache.find(x=>x.id===inventoryId);if(!item)return;
 const raw=prompt(`設定 ${item.itemCode||item.itemName||'品項'} 的安全庫存`,String(Number(item.safetyStock||0)));if(raw===null)return;
 const safetyStock=Number(raw);if(!Number.isFinite(safetyStock)||safetyStock<0){alert('安全庫存必須是 0 以上數字。');return;}
 try{await db.collection('inventory').doc(inventoryId).update({safetyStock,updatedAt:new Date().toISOString()});item.safetyStock=safetyStock;renderInventoryList();}catch(err){alert('安全庫存更新失敗：'+err.message);}
};
window.renderPendingInventoryItems=function(){const body=document.getElementById('pendingInventoryBody');const hint=document.getElementById('pendingInventoryEmptyHint');if(!body)return;const supplies=pendingSupplyCache.map(x=>{const remaining=Math.max(0,Number(x.qty||0)-Number(x.receivedQty||0));const label=x.purchaseDocumentNo||x.internalNo||'供應紀錄';const action=canReceiveInventoryCapability()?`<button type="button" class="btn-small btn-secondary" onclick="receiveSupplyOrder('${escapeAttr(x.id)}')">${escapeHtml(label)}・入庫</button>`:'僅可查看';return `<tr><td data-th="貨號">${escapeHtml(x.itemCode||'')}</td><td data-th="品名">${escapeHtml(x.itemName||'')}</td><td data-th="廠牌">${escapeHtml(x.brand||'')}</td><td data-th="在途數量">${remaining}</td><td data-th="供應商">${escapeHtml(x.supplier||'')}</td><td data-th="狀態">${action}</td></tr>`;});body.innerHTML=supplies.join('');if(hint)hint.style.display=supplies.length?'none':'block';};
window.renderInventoryLedger=function(){const b=document.getElementById('inventoryLedgerBody');if(!b)return;b.innerHTML=inventoryLedgerCache.map(x=>`<tr><td>${escapeHtml(x.createdAt||'')}</td><td>${escapeHtml(x.productKey||'')}</td><td>${escapeHtml(x.type||'')}</td><td>${Number(x.qty||0)}</td><td>${escapeHtml((x.sourceType||'')+' '+(x.sourceId||''))}</td><td>${escapeHtml(x.createdBy||'')}</td></tr>`).join('');};
let inventoryAdjustmentRows = [];

window.openInventoryAdjustment = async function(type = 'initial', item = null) {
    if (!canEditPage('inventory')) return;
    await loadSupplierWarehouseMasters();
    const selectedType = type || 'initial';
    const source = item || null;
    inventoryAdjustmentRows = [{
        itemCode: source?.itemCode || '',
        itemName: source?.itemName || '',
        brand: source?.brand || '',
        productId: source?.productId || source?.productKey || '',
        warehouseId: defaultWarehouse()?.id || '',
        qty: 0,
        unitCost: 0,
        lotNo: '',
        expiryDate: ''
    }];
    const typeSelect = document.getElementById('inventoryAdjustmentType');
    if (typeSelect) {
        typeSelect.value = selectedType;
        typeSelect.disabled = true;
    }
    const title = document.getElementById('inventoryAdjustmentTitle');
    if (title) {
        title.innerText = ({
            initial: '新增庫存',
            decrease: '減庫存',
            return: '退貨入庫',
            scrap: '報廢',
            warehouse_allocation: '分配至倉庫'
        })[selectedType] || '庫存異動';
    }
    const addRowBtn = document.getElementById('inventoryAddRowBtn');
    if (addRowBtn) addRowBtn.style.display = selectedType === 'initial' ? '' : 'none';
    renderInventoryAdjustmentRows();
    document.getElementById('inventoryAdjustmentOverlay')?.classList.add('active');
};

window.openInventoryItemAdjustment = function(type, inventoryId) {
    const item = inventoryCache.find(entry => entry.id === inventoryId);
    if (!item) {
        alert('找不到這個庫存品項，請重新整理後再試。');
        return;
    }
    openInventoryAdjustment(type, item);
};

window.closeInventoryAdjustment = function() {
    const typeSelect = document.getElementById('inventoryAdjustmentType');
    if (typeSelect) typeSelect.disabled = false;
    document.getElementById('inventoryAdjustmentOverlay')?.classList.remove('active');
};


window.downloadInventoryImportTemplate=async function(){
    try{await ensureXlsxLoaded();}catch(err){alert(err.message);return;}
    const rows=[{'貨號':'5000006','倉庫':'台北倉','數量':10,'實際單位成本':0,'批號':'','效期':'','備註':'範例列，可刪除'}];
    const ws=XLSX.utils.json_to_sheet(rows),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'庫存匯入');XLSX.writeFile(wb,'又鑫_庫存批量匯入範本.xlsx');
};
window.previewInventoryExcelImport=async function(input){
    const file=input?.files?.[0];if(!file)return;
    try{
        if(typeof XLSX==='undefined')throw new Error('Excel 元件尚未載入');
        await loadSupplierWarehouseMasters();
        const data=await file.arrayBuffer(),wb=XLSX.read(data,{type:'array'}),ws=wb.Sheets[wb.SheetNames[0]],rows=XLSX.utils.sheet_to_json(ws,{defval:''});
        if(!rows.length)throw new Error('Excel 沒有資料');
        const parsed=[],errors=[];
        for(let idx=0;idx<rows.length;idx++){
            const row=rows[idx],code=String(row['貨號']||'').trim(),warehouseName=String(row['倉庫']||'').trim(),qty=Number(row['數量']||0);
            if(!code||!warehouseName||!Number.isFinite(qty)||qty===0){errors.push('第 '+(idx+2)+' 列：貨號、倉庫、數量必填');continue;}
            const product=await findProductByCode(code);if(!product){errors.push('第 '+(idx+2)+' 列：Product Master 找不到 '+code);continue;}
            const warehouse=warehouseMasterCache.find(w=>w.active!==false&&String(w.warehouseName||'').trim()===warehouseName);
            if(!warehouse){errors.push('第 '+(idx+2)+' 列：找不到倉庫 '+warehouseName);continue;}
            parsed.push({itemCode:product.model||code,itemName:product.nameCn||product.nameEn||'',brand:resolveBrandName(product.brand||''),productId:product.productId||stableProductId(product),warehouseId:warehouse.id,qty:qty,unitCost:Number(row['實際單位成本']||0),lotNo:String(row['批號']||'').trim(),expiryDate:String(row['效期']||'').trim()});
        }
        if(!parsed.length)throw new Error(errors.join('\n')||'沒有可匯入資料');
        inventoryAdjustmentRows=parsed;document.getElementById('inventoryAdjustmentType').value='initial';renderInventoryAdjustmentRows();document.getElementById('inventoryAdjustmentOverlay').classList.add('active');
        let msg='已讀取 '+parsed.length+' 筆，請確認內容後按「確認儲存」。';if(errors.length)msg+='\n另有 '+errors.length+' 筆錯誤：\n'+errors.slice(0,10).join('\n');alert(msg);
    }catch(err){alert('Excel 匯入檢查失敗：'+err.message);}
    finally{input.value='';}
};

window.addInventoryAdjustmentRow = function() {
    inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', warehouseId:defaultWarehouse()?.id||'', qty:0, unitCost:0, lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.removeInventoryAdjustmentRow = function(idx) {
    inventoryAdjustmentRows.splice(idx,1);
    if (!inventoryAdjustmentRows.length) inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', warehouseId:defaultWarehouse()?.id||'', qty:0, lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.onInventoryAdjustmentCode = async function(idx, value) {
    const match = await findProductByCode(value);
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
    inventoryAdjustmentRows[idx][field] = ['qty','unitCost'].includes(field) ? Number(value||0) : String(value||'').trim();
};

function renderInventoryAdjustmentRows() {
    const body=document.getElementById('inventoryAdjustmentRows');
    if(!body)return;
    const warehouseOptions=warehouseMasterCache.filter(w=>w.active!==false).map(w=>`<option value="${escapeAttr(w.id)}">${escapeHtml(w.warehouseName||w.id)}</option>`).join('');
    body.innerHTML=inventoryAdjustmentRows.map((row,idx)=>`
      <tr>
        <td><input type="text" list="priceModelList" value="${escapeAttr(row.itemCode||'')}" onchange="onInventoryAdjustmentCode(${idx},this.value)"></td>
        <td><input type="text" value="${escapeAttr(row.itemName||'')}" onchange="updateInventoryAdjustmentRow(${idx},'itemName',this.value)"></td>
        <td><input type="text" list="poBrandList" value="${escapeAttr(row.brand||'')}" onchange="updateInventoryAdjustmentRow(${idx},'brand',this.value)"></td>
        <td><select onchange="updateInventoryAdjustmentRow(${idx},'warehouseId',this.value)"><option value="">請選倉庫</option>${warehouseOptions}</select></td>
        <td><input type="number" step="any" value="${row.qty||''}" onchange="updateInventoryAdjustmentRow(${idx},'qty',this.value)"></td>
        <td><input type="number" min="0" step="any" value="${row.unitCost||''}" onchange="updateInventoryAdjustmentRow(${idx},'unitCost',this.value)" placeholder="必填"></td>
        <td><input type="text" value="${escapeAttr(row.lotNo||'')}" onchange="updateInventoryAdjustmentRow(${idx},'lotNo',this.value)" placeholder="批號"></td>
        <td><input type="date" value="${escapeAttr(row.expiryDate||'')}" onchange="updateInventoryAdjustmentRow(${idx},'expiryDate',this.value)"></td>
        <td><button type="button" class="btn-small btn-danger" onclick="removeInventoryAdjustmentRow(${idx})">刪除</button></td>
      </tr>`).join('');
    [...body.querySelectorAll('tr')].forEach((tr,idx)=>{
      const select=tr.querySelector('select');
      if(select&&inventoryAdjustmentRows[idx]?.warehouseId) select.value=inventoryAdjustmentRows[idx].warehouseId;
    });
}
window.saveInventoryAdjustmentBatch = async function() {
    const type=document.getElementById('inventoryAdjustmentType').value;
    const rows=inventoryAdjustmentRows.filter(row=>row.itemCode&&Number(row.qty));
    if(!rows.length){alert('請至少輸入一筆貨號與數量。');return;}
    if(warehouseMasterCache.length && rows.some(row=>!row.warehouseId)){alert('請為每筆庫存異動選擇倉庫。');return;}
    if(type==='initial'&&rows.some(row=>!Number.isFinite(Number(row.unitCost))||Number(row.unitCost)<0)){alert('期初庫存請填寫每筆實際單位成本。');return;}
    const actor=currentUserName||currentUser?.email||'';
    const button=document.getElementById('saveInventoryAdjustmentBatchBtn');
    if(button){button.disabled=true;button.textContent='儲存中…';}
    const results=[];
    for(const row of rows){
      try{
        const match=findPriceItemByCodeValue(row.itemCode);
        if(!match) throw new Error(`Product Master 找不到貨號 ${row.itemCode}`);
        let delta=Number(row.qty||0);
        if(type==='scrap' || type==='decrease') delta=-Math.abs(delta);
        const key=match.productId||stableProductId(match);
        const ref=db.collection('inventory').doc(encodeURIComponent(key));
        const whRef=row.warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(row.warehouseId,key)):null;
        await db.runTransaction(async tx=>{
          const invSnap=await tx.get(ref);
          const whSnap=whRef?await tx.get(whRef):null;
          const otherWhRefs=warehouseMasterCache
             .filter(w=>w.active!==false&&w.id!==row.warehouseId)
             .map(w=>db.collection('warehouseStocks').doc(warehouseStockDocId(w.id,key)));
          const otherWhSnaps=[];
          for(const otherRef of otherWhRefs) otherWhSnaps.push(await tx.get(otherRef));
          const old=invSnap.exists?invSnap.data():{}, n=inventoryNumbers(old);
          const wh=inventoryNumbers(whSnap?.exists?whSnap.data():{});
          const assignedOther=otherWhSnaps.reduce((sum,snap)=>sum+inventoryNumbers(snap.exists?snap.data():{}).onHand,0);

          if(type==='warehouse_allocation'){
             if(delta<0) throw new Error('既有庫存分配請輸入正數。');
             const unallocated=Math.max(0,n.onHand-assignedOther-wh.onHand);
             if(delta>unallocated) throw new Error(`${row.itemCode} 未分倉庫存只有 ${unallocated}，不可分配 ${delta}。`);
          }else{
             // warehouseStocks 是實際庫存唯一真相；inventory 只維持總覽快取，
             // 不得因 aggregate cache 漂移而阻擋合法的分倉庫存異動。
             if(wh.onHand+delta<0) throw new Error(`${row.itemCode} 異動後分倉庫存不可小於 0`);
          }

          let lots=[...(old.lots||[])];
          if(type!=='warehouse_allocation'&&(row.lotNo||row.expiryDate)){
            const li=lots.findIndex(l=>(l.lotNo||'')===row.lotNo&&(l.expiryDate||'')===row.expiryDate);
            if(li>=0) lots[li]={...lots[li],qty:Number(lots[li].qty||0)+delta};
            else lots.push({lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',qty:delta});
          }
          const now=new Date().toISOString();
          if(type!=='warehouse_allocation'){
            {
              const nextInventory={...old,productKey:key,productId:key,itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:resolveBrandName(row.brand||match.brand||''),onHand:n.onHand+delta,reserved:n.reserved,incoming:n.incoming,lots,updatedAt:now};
              nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
              tx.set(ref,nextInventory,{merge:true});
            }
          }
          if(whRef){
            tx.set(whRef,{warehouseId:row.warehouseId,productKey:key,productId:key,itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:resolveBrandName(row.brand||match.brand||''),onHand:wh.onHand+delta,reserved:wh.reserved,incoming:wh.incoming,updatedAt:now},{merge:true});
          }
          let authoritativeLotId='';
          if(type==='initial'&&delta>0){
            const lotRef=db.collection('inventoryLots').doc();
            authoritativeLotId=lotRef.id;
            tx.set(lotRef,{productKey:key,productId:key,warehouseId:row.warehouseId||'',lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',receivedQty:delta,remainingQty:delta,sourceType:'INITIAL_STOCK',sourceId:'',receivedAt:now,createdBy:actor});
            tx.set(db.collection('inventoryLotCosts').doc(lotRef.id),{lotId:lotRef.id,productKey:key,productId:key,warehouseId:row.warehouseId||'',unitCost:Number(row.unitCost||0),sourceType:'INITIAL_STOCK',sourceId:'',createdAt:now,createdBy:actor});
          }
          tx.set(db.collection('inventoryMovements').doc(),{type,qty:delta,productKey:key,warehouseId:row.warehouseId||'',itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:resolveBrandName(row.brand||match.brand||''),lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',lotId:authoritativeLotId,sourceType:'manual',sourceId:'',createdAt:now,createdBy:actor});
        });
        if(row.warehouseId) invalidateWarehouseStockCache(key,row.warehouseId);
        results.push({row,ok:true});
      }catch(e){
        results.push({row,ok:false,error:e?.message||String(e)});
      }
    }
    const succeeded=results.filter(result=>result.ok);
    const failed=results.filter(result=>!result.ok);
    if(succeeded.length){
      loadInventory(true).catch(refreshErr => console.error('庫存異動後背景刷新失敗', refreshErr));
    }
    if(!failed.length){
      closeInventoryAdjustment();
      alert(`已完成 ${succeeded.length} 筆庫存異動。`);
    }else{
      // 已成功的列直接從表單移除，避免使用者看到「部分失敗」後整批重按造成重複入庫／重複扣庫存。
      inventoryAdjustmentRows=failed.map(result=>result.row);
      renderInventoryAdjustmentRows();
      const details=failed.slice(0,8).map(result=>`${result.row.itemCode||'未命名品項'}：${result.error}`).join('\n');
      alert(`庫存異動部分完成：成功 ${succeeded.length} 筆，失敗 ${failed.length} 筆。\n成功的品項已從表單移除，請只修正並重試畫面中保留的失敗品項。${details?'\n\n'+details:''}`);
    }
    if(button){button.disabled=false;button.textContent='確認儲存';}
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

window.openInventoryReservationDetails = async function(productKey) {
    const overlay = document.getElementById('inventoryReservationOverlay');
    const body = document.getElementById('inventoryReservationBody');
    const title = document.getElementById('inventoryReservationTitle');
    if (!overlay || !body) return;
    body.innerHTML = '<tr><td colspan="7">讀取中…</td></tr>';
    if (title) title.innerText = '已占用訂單';
    overlay.classList.add('active');
    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('inventoryReservations').where('productKey', '==', productKey).where('status','==','active').limit(100).get(),
            '庫存占用明細'
        );
        const rows = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(item => Number(item.quantity || 0) > 0)
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
async function reserveSingleOrderItem(orderId, order, item, itemIndex) {
    const requested=Math.max(0,Number(item.qty||0));
    const productKey=inventoryProductKey(item);
    const itemId=String(item.itemId||`item-${itemIndex+1}`);
    if(!requested)return {...item,itemId,orderedQty:requested,reservedQty:0,shortageQty:0,dispatchPreparedQty:Number(item.dispatchPreparedQty||0),deliveredQty:Number(item.deliveredQty||0),returnedQty:Number(item.returnedQty||0),inventoryProductKey:productKey};
    // 沒有 Product Master 對應時不能做庫存占用，但仍要保留完整缺貨/採購需求；
    // 否則估價單轉訂單後會出現「有訂單、採購頁卻沒有需求」的斷鏈。
    if(!productKey)return {...item,itemId,orderedQty:requested,reservedQty:0,shortageQty:requested,dispatchPreparedQty:Number(item.dispatchPreparedQty||0),deliveredQty:Number(item.deliveredQty||0),returnedQty:Number(item.returnedQty||0),inventoryProductKey:'',reservationError:'missing_product_master'};
    if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'){
        return {...item,itemId,orderedQty:requested,reservedQty:0,shortageQty:0,dispatchPreparedQty:Number(item.dispatchPreparedQty||0),deliveredQty:Number(item.deliveredQty||0),returnedQty:Number(item.returnedQty||0),inventoryProductKey:productKey,directShipQty:requested,warehouseId:'',reservationStatus:'not_required'};
    }
    const warehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';
    const aggregateRef=inventoryRefFor(item);
    const warehouseRef=warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)):null;
    const reservationRef=db.collection('inventoryReservations').doc(`${orderId}__${itemId}`);
    const actor=currentUserName||currentUser?.email||'';
    let result={...item,itemId,reservedQty:0,shortageQty:requested,inventoryProductKey:productKey,warehouseId};
    await db.runTransaction(async tx=>{
        const aggregateSnap=aggregateRef?await tx.get(aggregateRef):null;
        const warehouseSnap=warehouseRef?await tx.get(warehouseRef):null;
        const reservationSnap=await tx.get(reservationRef);
        const aggregate=inventoryNumbers(aggregateSnap?.exists?aggregateSnap.data():{});
        const warehouse=inventoryNumbers(warehouseSnap?.exists?warehouseSnap.data():{});
        const existing=reservationSnap.exists?reservationSnap.data():{};
        const existingQty=Math.max(0,Number(existing.quantity||0));
        const existingSameStock=existing.productKey===productKey&&(existing.warehouseId||'')===warehouseId;
        const preservedQty=existingSameStock?Math.min(existingQty,requested):0;
        const additionalNeeded=Math.max(0,requested-preservedQty);
        const additionalReservable=Math.max(0,Math.min(additionalNeeded,warehouse.available));
        const reservable=preservedQty+additionalReservable;
        const shortage=Math.max(0,requested-reservable);
        const now=new Date().toISOString();
        if(existingQty>preservedQty){
            const release=existingQty-preservedQty;
            if(aggregateRef&&aggregateSnap?.exists)tx.update(aggregateRef,{reserved:Math.max(0,aggregate.reserved-release)+additionalReservable,updatedAt:now});
            if(warehouseRef&&warehouseSnap?.exists)tx.update(warehouseRef,{reserved:Math.max(0,warehouse.reserved-release)+additionalReservable,updatedAt:now});
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord('release',-release,orderId,productKey,actor,{reason:'reservation_reconcile',warehouseId,itemId,fulfillmentType:'WAREHOUSE'}));
        }else if(additionalReservable){
            if(aggregateRef&&aggregateSnap?.exists)tx.update(aggregateRef,{reserved:aggregate.reserved+additionalReservable,updatedAt:now});
            if(warehouseRef&&warehouseSnap?.exists)tx.update(warehouseRef,{reserved:warehouse.reserved+additionalReservable,updatedAt:now});
        }
        if(additionalReservable){
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord('reserve',additionalReservable,orderId,productKey,actor,{warehouseId,itemId,fulfillmentType:'WAREHOUSE'}));
        }
        tx.set(reservationRef,{
            orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
            itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
            salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
            orderDate:order.orderDate||'',quantity:reservable,shortageQty:shortage,
            status:reservable>0?'active':'shortage',warehouseId,updatedAt:now
        },{merge:true});
        result={...item,itemId,orderedQty:requested,reservedQty:reservable,shortageQty:shortage,dispatchPreparedQty:Number(item.dispatchPreparedQty||0),deliveredQty:Number(item.deliveredQty||0),returnedQty:Number(item.returnedQty||0),inventoryProductKey:productKey,warehouseId};
    });
    if(warehouseId) invalidateWarehouseStockCache(productKey,warehouseId);
    return result;
}
function orderReservationSummary(order) {
    const items=normalizedOrderItems(order);
    return {
        reservedQty:items.reduce((sum,item)=>sum+Math.max(0,Number(item.reservedQty||0)),0),
        shortageQty:items.reduce((sum,item)=>sum+Math.max(0,Number(item.shortageQty||0)),0)
    };
}

async function reserveInventoryForNewOrder(orderId, order) {
    if(!warehouseMasterCache.length)await loadWarehouseMaster();
    const items=normalizedOrderItems(order);
    if(!items.length)throw new Error('訂單缺少正式 items 品項資料，請重新建立訂單。');
    if(items.length===1){
        const item=await reserveSingleOrderItem(orderId,order,items[0],0);
        const updates={
            items:[item],itemCount:1,orderSchemaVersion:2,
            inventoryProductKey:item.inventoryProductKey||'',
            fulfillmentType:item.fulfillmentType||'WAREHOUSE',warehouseId:item.warehouseId||''
        };
        Object.assign(order,updates);
        Object.assign(updates,orderWorkIndexFields(order));
        await db.collection('orders').doc(orderId).set(updates,{merge:true});
        return {reservedQty:Number(item.reservedQty||0),shortageQty:Number(item.shortageQty||0),items:[item]};
    }
    const reservedItems=[];
    for(let i=0;i<items.length;i++) reservedItems.push(await reserveSingleOrderItem(orderId,order,items[i],i));
    const reservedQty=reservedItems.reduce((s,item)=>s+Number(item.reservedQty||0),0);
    const shortageQty=reservedItems.reduce((s,item)=>s+Number(item.shortageQty||0),0);
    const updates={items:reservedItems,itemCount:reservedItems.length,orderSchemaVersion:2};
    Object.assign(order,updates);
    Object.assign(updates,orderWorkIndexFields(order));
    await db.collection('orders').doc(orderId).set(updates,{merge:true});
    return {reservedQty,shortageQty,items:reservedItems};
}

function normalizedOrderItems(order) {
    const source = Array.isArray(order?.items) ? order.items : [];
    const deliveryRecords = Array.isArray(order?.deliveryRecords) ? order.deliveryRecords : null;
    const returnRecords = Array.isArray(order?.returnRecords) ? order.returnRecords : null;
    const singleItem = source.length === 1;
    const singleItemId = singleItem ? String(source[0]?.itemId || 'item-1') : '';
    const deliveryQtyByItemId = new Map();
    const returnQtyByItemId = new Map();

    // 一張訂單先各掃一次送貨／退貨紀錄，再由 itemId O(1) 取值。
    // 避免多品項＋多次分批送貨時，每個品項都重新 filter 整份紀錄。
    if (deliveryRecords) {
        deliveryRecords.forEach(row => {
            const itemId = String(row?.itemId || singleItemId || '');
            if (!itemId) return;
            deliveryQtyByItemId.set(itemId,
                (deliveryQtyByItemId.get(itemId) || 0) + Math.max(0, Number(row?.qty || 0)));
        });
    }
    if (returnRecords) {
        returnRecords.forEach(row => {
            const itemId = String(row?.itemId || singleItemId || '');
            if (!itemId) return;
            returnQtyByItemId.set(itemId,
                (returnQtyByItemId.get(itemId) || 0) + Math.max(0, Number(row?.qty || 0)));
        });
    }

    return source.map((item, index) => {
        const itemId = String(item.itemId || `item-${index + 1}`);
        // 送貨／退貨紀錄是實際履約的權威來源。若只使用 items 內舊的累計欄位，
        // 「已全數送貨 → 退貨 → 補送」時會把已送過的數量重新誤判成缺貨。
        const grossDeliveredQty = deliveryRecords
            ? (deliveryQtyByItemId.get(itemId) || 0)
            : Math.max(0,Number(item.deliveredQty||0));
        const returnedQty = returnRecords
            ? (returnQtyByItemId.get(itemId) || 0)
            : Math.max(0,Number(item.returnedQty||0));
        const base = {
            ...item,
            itemId,
            itemCodeKey: item.itemCodeKey || normalizeHistoryItemCode(item.itemCode || ''),
            brand: resolveBrandName(item.brand || ''),
            qty: Number(item.qty || item.orderedQty || 0),
            unitPrice: parseMoney(item.unitPrice || 0),
            totalPrice: parseMoney(item.totalPrice || 0),
            fulfillmentType: item.fulfillmentType || 'WAREHOUSE',
            warehouseId: item.fulfillmentType === 'DIRECT_SHIP' ? '' : (item.warehouseId || ''),
            deliveredQty: grossDeliveredQty,
            returnedQty
        };
        const normalized = window.YushinFulfillment ? window.YushinFulfillment.normalizeItem(base, index) : base;
        // 僅在記憶體標記這個物件的送貨／退貨量已由 deliveryRecords / returnRecords 索引完成。
        // non-enumerable 不會被 spread / JSON / Firestore 寫回，避免快照欄位變成持久資料。
        try {
            Object.defineProperty(normalized, '__fulfillmentSnapshot', {
                value:true, enumerable:false, configurable:true
            });
        } catch (_) {}
        return normalized;
    });
}

function ensureOrderItemCompatibility(order) {
    const items = normalizedOrderItems(order);
    order.items = items;
    order.orderSchemaVersion = 2;
    order.itemCount = items.length;
    return order;
}

function orderQuantity(order, normalizedItems = null) {
    return (normalizedItems || normalizedOrderItems(order))
        .reduce((sum,item)=>sum+Math.max(0,Number(item.qty||0)),0);
}

function savedDeliveryRecords(order) {
    return Array.isArray(order?.deliveryRecords) ? order.deliveryRecords : [];
}

function deliveredQuantity(order, normalizedItems = null) {
    const records = savedDeliveryRecords(order);
    if (records.length) return records.reduce((sum, record) => sum + (parseFloat(record.qty) || 0), 0);
    // 舊資料只有「已送貨」布林值：視為全數送貨，但不在未確認前改寫雲端資料。
    return order?.isDelivered ? orderQuantity(order, normalizedItems) : 0;
}

function deliveryProgressInfo(order, normalizedItems = null) {
    const total = orderQuantity(order, normalizedItems);
    const grossDelivered = deliveredQuantity(order, normalizedItems);
    const returned = Math.min(returnedQuantity(order), grossDelivered);
    const effectiveDelivered = Math.max(0, grossDelivered - returned);
    const delivered = Math.min(effectiveDelivered, total || effectiveDelivered);
    const remaining = Math.max(0, total - delivered);
    const isLegacyEstimated = !!order?.isDelivered && savedDeliveryRecords(order).length === 0;
    const state = total > 0 && delivered >= total ? 'complete' : delivered > 0 ? 'partial' : 'none';
    const label = state === 'complete' ? `已送 ${delivered}/${total}` : state === 'partial' ? `部分 ${delivered}/${total}` : `未送 0/${total || 0}`;
    return { total, delivered, grossDelivered, returned, remaining, state, label, isLegacyEstimated };
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

function orderLifecycleInfo(order, normalizedItems = null) {
    const delivered = deliveredQuantity(order, normalizedItems);
    const returned = Math.min(returnedQuantity(order), delivered);
    const effectiveDelivered = Math.max(0, delivered - returned);
    const status = normalizedOrderStatus(order);
    if (status === 'cancelled') return { status, label: '已取消', css: 'invalid', delivered, returned, effectiveDelivered };
    if (returned > 0 && effectiveDelivered <= 0) return { status, label: '全數退貨・待補送', css: 'returned', delivered, returned, effectiveDelivered };
    if (returned > 0) return { status, label: '部分退貨・待補送', css: 'returned', delivered, returned, effectiveDelivered };
    return { status, label: '正常', css: 'normal', delivered, returned, effectiveDelivered };
}

function purchaseProgressInfo(order) {
    const items=normalizedOrderItems(order);
    if (!items.length) return {state:'not_required',label:'無需採購'};
    let pending=0,inTransit=0,everOrdered=0;
    let allDirect=true;
    items.forEach(item=>{
        const direct=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        if(!direct) allDirect=false;
        const returnedQty=direct?itemDispatchState(order,item).returned:Number(item.returnedQty||0);
        const quantities=window.YushinWorkflow?.procurementQuantities({
            orderedQty:item.orderedQty??item.qty,
            fulfillmentType:item.fulfillmentType||order.fulfillmentType||'WAREHOUSE',
            shortageQty:item.shortageQty,
            supplyOrderedQty:item.supplyOrderedQty,
            receivedQty:item.receivedQty,
            returnedQty
        });
        const ordered=Math.max(0,Number(item.supplyOrderedQty||0));
        const received=Math.max(0,Number(item.receivedQty||0));
        pending+=quantities?quantities.remainingToOrderQty:remainingProcurementQty(order,item);
        inTransit+=quantities?quantities.inTransitQty:Math.max(0,ordered-received);
        everOrdered+=ordered;
    });
    if(pending>0&&inTransit>0)return {state:'partial',label:`待採購 ${pending}／在途 ${inTransit}`};
    if(pending>0)return {state:'pending',label:`待採購 ${pending}`};
    if(inTransit>0)return {state:'ordered',label:`已訂貨・待到貨 ${inTransit}`};
    if(everOrdered>0)return {state:'ordered',label:'採購完成'};
    if(allDirect)return {state:'direct',label:'原廠直送'};
    return {state:'not_required',label:'無需採購'};
}

function fulfillmentProgressInfo(order, normalizedItems = null, dispatchStateByItem = null) {
    const items=(normalizedItems || normalizedOrderItems(order)).filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP');
    const total=items.reduce((s,item)=>s+Number(item.orderedQty||item.qty||0),0);
    const states=items.map(item=>dispatchStateByItem?.get(item) || itemDispatchState(order,item));
    const ready=states.reduce((s,state)=>s+state.reserved,0);
    const prepared=states.reduce((s,state)=>s+state.prepared,0);
    const delivered=states.reduce((s,state)=>s+state.delivered,0);
    const shippable=states.reduce((s,state)=>s+state.shippable,0);
    const pendingDispatch=states.reduce((s,state)=>s+state.pending,0);
    if(!items.length)return {state:'direct',label:'原廠直送',total:0,ready:0,prepared:0,delivered:0,shippable:0,pendingDispatch:0};
    if(shippable>0)return {state:'shippable',label:`可出貨 ${shippable}/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
    if(pendingDispatch>0)return {state:ready>=Math.max(0,total-delivered)?'pending_dispatch':'partial_dispatch',label:`待打單 ${pendingDispatch}/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
    return {state:'pending',label:`待備貨 0/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
}

const pendingDispatchOrderIds = new Set();

function itemDispatchState(order, item) {
    // normalizedOrderItems() 已將 deliveryRecords / returnRecords 依 itemId 索引完成時，
    // 直接使用該記憶體快照；只有原始 item 才回退掃描事件紀錄。
    const hasSnapshot = item?.__fulfillmentSnapshot === true;
    const singleItem = Array.isArray(order?.items) && order.items.length === 1;
    const grossDelivered=hasSnapshot
        ? Math.max(0,Number(item.deliveredQty||0))
        : savedDeliveryRecords(order).filter(r=>((!r.itemId&&singleItem)||r.itemId===item.itemId))
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
    const returned=hasSnapshot
        ? Math.max(0,Number(item.returnedQty||0))
        : savedReturnRecords(order).filter(r=>((!r.itemId&&singleItem)||r.itemId===item.itemId))
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
    // 品項工作狀態使用有效送貨量。已送貨後若發生退貨，必須退出「已完成／待核銷」，
    // 回到仍需補送的物流狀態；grossDelivered 保留給庫存與歷史追蹤。
    const delivered=Math.max(0,grossDelivered-returned);
    const reserved=Math.max(0,Number(item.reservedQty||0));
    const prepared=Math.max(0,Number(item.dispatchPreparedQty||0));
    // reservedQty 是「目前尚未出貨、仍被此訂單占用的數量」；dispatchPreparedQty / grossDelivered
    // 則是累計量。兩者不能直接相減，否則第一批送完、第二批到貨後會漏掉新的待打單數量。
    const preparedOutstanding=Math.max(0,prepared-grossDelivered);
    const shippable=Math.max(0,Math.min(reserved,preparedOutstanding));
    const pending=Math.max(0,reserved-shippable);
    return { delivered, grossDelivered, returned, reserved, prepared, preparedOutstanding, shippable, pending };
}

function orderContextActionState(order, normalizedItems = null, dispatchStateByItem = null) {
    const items = normalizedItems || normalizedOrderItems(order);
    const states = items.map(item => dispatchStateByItem?.get(item) || itemDispatchState(order, item));
    const grossDelivered = states.reduce((sum, state) => sum + Math.max(0, Number(state.grossDelivered || 0)), 0);
    const returned = states.reduce((sum, state) => sum + Math.max(0, Number(state.returned || 0)), 0);
    const netDelivered = Math.max(0, grossDelivered - returned);
    // 「分批交貨」只在真的有部分到貨品項時出現。
    // 全數到貨走一般送貨流程；尚未到貨則不提供分批交貨，避免操作選單過早出現。
    const hasPartialArrival = items.some((item, index) => {
        const ordered = Math.max(0, Number(item.orderedQty || item.qty || 0));
        const received = Math.max(0, Number(item.receivedQty || 0));
        const state = states[index];
        // 分批交貨不只要「部分到貨」，還必須真的有尚未交付、目前可出貨的數量。
        // 避免部分到貨紀錄存在，但該批已全數送出時仍顯示無效操作。
        return ordered > 0 && received > 0 && received < ordered && Number(state?.shippable || 0) > 0;
    });
    return {
        showPartialDelivery: normalizedOrderStatus(order) === 'normal' && hasPartialArrival,
        showReturn: netDelivered > 0
    };
}

function dispatchActionHtml(order, normalizedItems = null, dispatchStateByItem = null) {
    if (!(currentUserRole === 'purchaser' || currentUserRole === 'admin')) return '';
    if (normalizedOrderStatus(order) !== 'normal') return '';
    return (normalizedItems || normalizedOrderItems(order))
        .filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP')
        .map(item=>({item,state:dispatchStateByItem?.get(item) || itemDispatchState(order,item)}))
        .filter(x=>x.state.pending>0)
        .map(({item,state})=>`<button type="button" onclick="markOrderItemDispatchPrepared('${escapeAttr(order.id)}','${escapeAttr(item.itemId)}')" ${pendingDispatchOrderIds.has(order.id+'__'+item.itemId)?'disabled':''}>待打單：${escapeHtml(item.itemCode||item.itemName||item.itemId)} × ${state.pending}</button>`)
        .join('');
}

window.markOrderItemDispatchPrepared = async function(orderId,itemId) {
    if (!(currentUserRole === 'purchaser' || currentUserRole === 'admin')) return;
    const key=orderId+'__'+itemId;
    if(pendingDispatchOrderIds.has(key))return;
    pendingDispatchOrderIds.add(key);
    if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
    else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingDispatchOrders();
    try{
        let saved;
        await db.runTransaction(async tx=>{
            const ref=db.collection('orders').doc(orderId);
            const snap=await tx.get(ref);
            if(!snap.exists)throw new Error('找不到訂單。');
            const order=snap.data();
            if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能打單。');
            const items=normalizedOrderItems(order);
            const index=items.findIndex(item=>item.itemId===itemId);
            if(index<0)throw new Error('找不到訂單品項。');
            const item=items[index],state=itemDispatchState(order,item);
            if(state.pending<=0)throw new Error('此品項目前沒有待打單數量。');
            const now=new Date().toISOString(),actor=deliveryActor();
            items[index]={...item,dispatchPreparedQty:state.prepared+state.pending};
            const dispatchRef=db.collection('dispatchRecords').doc();
            tx.set(dispatchRef,{
                orderId,itemId,qty:state.pending,ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',
                customerName:order.customerName||'',itemCode:item.itemCode||'',itemName:item.itemName||'',
                preparedByUid:currentUser?.uid||'',preparedBy:actor,createdAt:now
            });
            const nextOrder={...order,items,updatedAt:now};
            tx.update(ref,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
            saved=nextOrder;
        });
        const idx=ordersCache.findIndex(o=>o.id===orderId);
        const savedOrder={id:orderId,...saved};
        if(idx>=0)ordersCache[idx]=savedOrder;
        syncOrderIntoPurchasingCaches(savedOrder, { render:false });
        writeAppDataCache('orders', ordersCache);
    }catch(err){alert('標記已打單失敗：'+err.message);}
    finally{
        pendingDispatchOrderIds.delete(key);
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        if(currentDeliveryOrderId===orderId)renderDeliveryModal();
    }
};


function canBusinessSelfOrder(order = null) {
    if (currentUserRole === 'admin') return true;
    if (!canSelfOrderCapability(currentUserRole)) return false;
    if (!order) return true;
    return (order.ownerUid && order.ownerUid === currentUser?.uid)
        || (order.salesCode && currentUserCode && order.salesCode === currentUserCode);
}

function selfOrderActionHtml(order, normalizedItems = null, dispatchStateByItem = null) {
    if (!canBusinessSelfOrder(order) || normalizedOrderStatus(order) !== 'normal') return '';
    return (normalizedItems || normalizedOrderItems(order))
        .filter(item => (item.procurementType || order.procurementType || 'PURCHASING_PO') === 'SALES_SELF_ORDER')
        .map(item => {
            const remaining=remainingProcurementQty(order,item,dispatchStateByItem?.get(item) || null);
            return {item,remaining};
        })
        .filter(row=>row.remaining>0)
        .map(({item,remaining})=>`<button type="button" onclick="openSelfOrderModal('${escapeAttr(order.id)}','${escapeAttr(item.itemId)}')">自行訂貨：${escapeHtml(item.itemCode||item.itemName||item.itemId)} × ${remaining}</button>`)
        .join('');
}

window.openSelfOrderModal = function(orderId,itemId) {
    const order=ordersCache.find(row=>row.id===orderId);
    const item=normalizedOrderItems(order||{}).find(row=>row.itemId===itemId);
    if(!order||!item||!canBusinessSelfOrder(order))return;
    const remaining=remainingProcurementQty(order,item);
    if(remaining<=0){alert('此品項目前沒有尚未訂貨的缺貨數量。');return;}
    document.getElementById('selfOrderOrderId').value=orderId;
    document.getElementById('selfOrderItemId').value=itemId;
    document.getElementById('selfOrderSupplier').value=item.supplier||'';
    document.getElementById('selfOrderQty').value=remaining;
    document.getElementById('selfOrderQty').max=remaining;
    document.getElementById('selfOrderUnitCost').value=item.costPrice??'';
    document.getElementById('selfOrderDate').value=localDateString();
    document.getElementById('selfOrderNotes').value='';
    const directShip=(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
    document.getElementById('selfOrderStatus').innerText=directShip ? `尚未訂貨 ${remaining}；原廠直送不入庫，到貨後直接更新訂單交貨進度。` : `尚缺 ${remaining}；自行訂貨後會進入待入庫。`;
    document.getElementById('selfOrderItemSummary').innerHTML=`<strong>${escapeHtml(item.itemCode||'')}</strong> ${escapeHtml(item.itemName||'')}<br><span style="color:#666;">客戶：${escapeHtml(order.customerName||'')}</span>`;
    document.getElementById('selfOrderOverlay').classList.add('active');
};

window.closeSelfOrderModal = function() {
    document.getElementById('selfOrderOverlay')?.classList.remove('active');
};

window.saveSelfOrder = async function() {
    if(!canBusinessSelfOrder())return;
    const orderId=document.getElementById('selfOrderOrderId').value;
    const itemId=document.getElementById('selfOrderItemId').value;
    const supplier=document.getElementById('selfOrderSupplier').value.trim();
    const qty=Number(document.getElementById('selfOrderQty').value||0);
    const unitCost=Number(document.getElementById('selfOrderUnitCost').value||0);
    const orderDate=document.getElementById('selfOrderDate').value||localDateString();
    const notes=document.getElementById('selfOrderNotes').value.trim();
    if(!supplier||qty<=0||unitCost<=0){alert('請填寫供應商、訂貨數量與大於 0 的實際單位成本。');return;}
    const button=document.getElementById('saveSelfOrderBtn');
    if(button.disabled)return;
    button.disabled=true;button.innerText='建立中…';
    try{
        let savedOrder,internalNo='';
        await db.runTransaction(async tx=>{
            const orderRef=db.collection('orders').doc(orderId);
            const snap=await tx.get(orderRef);
            if(!snap.exists)throw new Error('找不到訂單。');
            const order=snap.data();
            if(!canBusinessSelfOrder(order))throw new Error('只有此訂單負責人可自行訂貨。');
            if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能自行訂貨。');
            const items=normalizedOrderItems(order);
            const index=items.findIndex(row=>row.itemId===itemId);
            if(index<0)throw new Error('找不到訂單品項。');
            const item=items[index];
            if ((item.procurementType || order.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER') throw new Error('此品項設定為交由採購訂貨，不能自行訂貨。');
            const already=Math.max(0,Number(item.supplyOrderedQty||0));
            const remaining=remainingProcurementQty(order,item);
            if(qty>remaining+1e-9)throw new Error(`目前尚未訂貨數量只有 ${remaining}。`);
            const supplyRef=db.collection('supplyOrders').doc();
            internalNo=`SO-${orderDate.replace(/-/g,'')}-${supplyRef.id.slice(0,6).toUpperCase()}`;
            const now=new Date().toISOString();
            const record={
                type:'SALES_SELF_ORDER',internalNo,status:'ORDERED',orderId,itemId,
                ownerUid:order.ownerUid||currentUser?.uid||'',salesCode:order.salesCode||currentUserCode||'',
                customerName:order.customerName||'',productId:item.productId||'',productKey:inventoryProductKey(item),
                itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
                qty,receivedQty:0,supplier,unitCost,orderDate,notes,
                fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP' ? '' : (item.warehouseId||defaultWarehouse()?.id||''),
                createdAt:now,createdByUid:currentUser?.uid||'',createdBy:deliveryActor(),createdByRole:currentUserRole
            };
            const validation=window.YushinSupply?.validate(record);
            if(validation&&!validation.valid)throw new Error('自行訂貨資料不完整：'+validation.errors.join(', '));
            tx.set(supplyRef,record);
            items[index]={...item,supplyOrderedQty:already+qty,selfOrderNos:[...new Set([...(item.selfOrderNos||[]),internalNo])],orderedAt:item.orderedAt && item.orderedAt < orderDate ? item.orderedAt : orderDate};
            savedOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
            tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(savedOrder),updatedAt:now});
        });
        const index=ordersCache.findIndex(row=>row.id===orderId);
        const committedOrder={id:orderId,...savedOrder};
        if(index>=0)ordersCache[index]=committedOrder;else ordersCache.unshift(committedOrder);
        syncOrderIntoPurchasingCaches(committedOrder, { render:false });
        writeAppDataCache('orders', ordersCache);
        closeSelfOrderModal();
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        alert(`自行訂貨已建立：${internalNo}`);
    }catch(err){alert('自行訂貨失敗：'+err.message);}
    finally{button.disabled=false;button.innerText='確認自行訂貨';}
};

function isDeletableOrderDraft(order) {
    if (!order || order.quoteNo || order.purchaseOrderNo) return false;
    const items = normalizedOrderItems(order);
    const hasProcurementEvidence = items.some(item =>
        Math.max(0, Number(item.supplyOrderedQty || 0)) > 0
        || (Array.isArray(item.purchaseDocumentNos) && item.purchaseDocumentNos.some(Boolean))
    ) || (Array.isArray(order.linkedDocuments) && order.linkedDocuments.some(link =>
        link?.type === DOCUMENT_TYPES.PURCHASE_ORDER && link?.id
    ));
    if (hasProcurementEvidence) return false;
    if (order.isDelivered || order.isBilled) return false;
    if (savedDeliveryRecords(order).length || savedReturnRecords(order).length) return false;
    if ((order.statusHistory || []).length || (order.deliveryHistory || []).length || (order.returnHistory || []).length || (order.orderLifecycleHistory || []).length) return false;
    return normalizedOrderStatus(order) === 'normal';
}

function orderWorkCategory(order) {
    // 整張訂單狀態只由各品項的唯一狀態推導，避免另一套 aggregate 判斷
    // 與列表／圖卡／Firestore workCategories 出現不同答案。
    const categories=orderWorkCategories(order);
    if(categories.includes('closed'))return 'closed';
    const priority=['ordering','arrival','delivery','billing','complete'];
    return priority.find(category=>categories.includes(category))||'ordering';
}

function orderItemWorkCategory(order, item, lifecycleOverride = null, dispatchOverride = null) {
    const lifecycle=lifecycleOverride || orderLifecycleInfo(order);
    const dispatch=dispatchOverride || itemDispatchState(order,item);
    const input={
        lifecycleStatus:lifecycle.status,
        returnedQty:dispatch.returned,
        effectiveDeliveredQty:dispatch.delivered,
        orderedQty:item.orderedQty??item.qty,
        deliveredQty:dispatch.delivered,
        isBilled:!!order.isBilled,
        fulfillmentType:item.fulfillmentType||order.fulfillmentType||'WAREHOUSE',
        shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty,
        receivedQty:item.receivedQty
    };
    // 單一權威來源：畫面、圖卡、採購與 workCategories 全部交給 workflow-core 判斷。
    return YushinWorkflow.itemWorkCategory(input);
}

// 倉庫品項的採購／到貨／送貨仍共用原本的資料狀態；訂單頁依已打單量
// 把可出貨前的工作分成待打單與待出貨，不另建會與庫存紀錄脫節的旗標。
function orderItemDisplayCategory(order, item, lifecycleOverride = null, dispatchOverride = null) {
    const dispatch = dispatchOverride || itemDispatchState(order, item);
    const category = orderItemWorkCategory(order, item, lifecycleOverride, dispatch);
    if (category !== 'delivery') return category;
    if ((item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return 'shipping';
    return dispatch.pending > 0 ? 'dispatch' : 'shipping';
}

function orderItemDisplayCategories(order, item, lifecycleOverride = null, dispatchOverride = null) {
    const dispatch = dispatchOverride || itemDispatchState(order, item);
    const category=orderItemDisplayCategory(order,item,lifecycleOverride,dispatch);
    const warehouse=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP';
    return warehouse && (category==='ordering'||category==='arrival') && dispatch.pending>0
        ? [category,'dispatch'] : [category];
}

function orderWorkCategories(order) {
    const lifecycle=orderLifecycleInfo(order);
    if(lifecycle.status!=='normal')return ['closed'];
    const items=normalizedOrderItems(order);
    const categories=[...new Set(items.flatMap(item=>{
        const category=orderItemWorkCategory(order,item);
        const warehouse=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP';
        return warehouse && ['ordering','arrival','delivery'].includes(category) && itemDispatchState(order,item).pending>0
            ? [category,'dispatch'] : [category];
    }))];
    if(!categories.length)return ['ordering'];
    return categories;
}

function orderWorkIndexFields(order) {
    const categories=orderWorkCategories(order);
    return {
        workCategories:categories,
        workCategoryUpdatedAt:new Date().toISOString()
    };
}

function orderItemWorkAmount(order, item, category, totalQtyOverride = null, dispatchOverride = null) {
    const qty=Number(item.orderedQty||item.qty||0);
    const totalQty=totalQtyOverride === null ? orderQuantity(order) : totalQtyOverride;
    const unitSales=Number(item.unitPrice||item.salesPrice||0)||(totalQty?salesAmount(order)/totalQty:(parseFloat(order.unitPrice)||0));
    const state=dispatchOverride || itemDispatchState(order,item);
    if(category==='delivery'||category==='dispatch'||category==='shipping')return Math.max(0,qty-state.delivered)*unitSales;
    if(category==='billing'||category==='complete')return Math.min(qty,state.delivered)*unitSales;
    return qty*unitSales;
}

function buildOrderItemWorkMetrics(orders, categories, include = null, normalizedItemsByOrder = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const metrics = Object.fromEntries(categories.map(category => [category, { count:0, amount:0 }]));
    (orders || []).forEach(order => {
        const items = normalizedItemsByOrder?.get(order.id) || normalizedOrderItems(order);
        const totalQty = items.reduce((sum, item) => sum + Math.max(0, Number(item.qty || 0)), 0);
        const lifecycle = lifecyclesByOrder?.get(order.id) || orderLifecycleInfo(order, items);
        const orderDispatchStates = dispatchStatesByOrder?.get(order.id) || null;
        items.forEach(item => {
            // 工作圖卡同一品項只掃一次送貨／退貨紀錄；分類與金額共用同一份 dispatch state。
            const dispatch = orderDispatchStates?.get(item) || itemDispatchState(order, item);
            orderItemDisplayCategories(order,item,lifecycle,dispatch).forEach(category => {
                if (!metrics[category]) return;
                if (include && !include(order,item,category)) return;
                metrics[category].count++;
                metrics[category].amount += orderItemWorkAmount(order,item,category,totalQty,dispatch);
            });
        });
    });
    return metrics;
}

window.setOrderWorkFilter = function(filter) {
    activeOrderWorkFilter = activeOrderWorkFilter === filter && filter !== 'all' ? 'all' : filter;
    renderOrdersList();
};

function renderOrderWorkCards(orders, normalizedItemsByOrder = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const container = document.getElementById('orderWorkCards');
    if (!container) return;
    const definitions = [
        ['ordering', '待採購'],
        ['arrival', '待到貨'],
        ['dispatch', '待打單'],
        ['shipping', '待出貨'],
        ['billing', '待核銷'],
        ['complete', '已完成']
    ];
    const metrics = buildOrderItemWorkMetrics(
        orders,
        definitions.map(([key]) => key),
        (order, item, category) => orderMatchesWorkPeriod(order, category),
        normalizedItemsByOrder,
        dispatchStatesByOrder,
        lifecyclesByOrder
    );
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
    } else if (currentUser?.uid) {
        // 新版訂單一律寫入 ownerUid。近期列表以 Firebase UID 為唯一權威歸屬，
        // 避免每次進頁為了相容舊 salesCode / salesName 而串行執行 2～3 個重複 Query。
        sources.push({
            cursor: null,
            exhausted: false,
            query: () => db.collection('orders').where('ownerUid', '==', currentUser.uid).orderBy('orderDate', 'desc')
        });
    }
    return { sources, sourceIndex: 0 };
}

function updateOrderLoadMoreButton() {
    const button = document.getElementById('orderLoadMoreBtn');
    const refreshButton = document.getElementById('orderRefreshBtn');
    const hasMore = !!orderPaginationState && orderPaginationState.sourceIndex < orderPaginationState.sources.length;
    if (button) {
        button.style.display = (hasMore || !!orderLoadErrorMessage) ? '' : 'none';
        button.disabled = orderPageLoading;
        button.innerText = orderPageLoading ? '載入中…' : orderLoadErrorMessage || '載入更多（每次 50 筆）';
    }
    if (refreshButton) {
        refreshButton.disabled = orderPageLoading;
        refreshButton.textContent = orderPageLoading ? '更新中…' : '↻ 更新';
    }
}

async function loadOrderPage(reset, options = {}) {
    if (orderPageLoading) {
        if (!options.force) {
            if (reset) orderReloadRequested = true;
            return;
        }
        // iOS 切到背景時，Firestore 的舊 Promise 可能永遠不完成。讓舊代次失效，
        // 新查詢可以立即開始；舊 Promise 之後即使回來也不能覆蓋新畫面。
        orderLoadGeneration++;
        orderPageLoading = false;
        orderReloadRequested = false;
    }
    if (getDataScope('orders') === 'none') {
        ordersCache = [];
        orderPaginationState = null;
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        updateOrderLoadMoreButton();
        return;
    }
    if (reset || !orderPaginationState) {
        orderPaginationState = createOrderPaginationState();
    }
    const generation = ++orderLoadGeneration;
    orderPageLoading = true;
    orderLoadErrorMessage = '';
    const requestedRole = currentUserRole;
    updateOrderLoadMoreButton();
    // 重新整理期間保留舊畫面，避免慢網路時先清空成整頁白色。
    const records = new Map((reset ? [] : ordersCache).map(order => [order.id, order]));
    let remainingReads = DEFAULT_LIST_LIMIT;
    try {
        while (remainingReads > 0 && orderPaginationState.sourceIndex < orderPaginationState.sources.length) {
            const source = orderPaginationState.sources[orderPaginationState.sourceIndex];
            const requested = remainingReads;
            let query = source.query().limit(requested);
            if (source.cursor) query = query.startAfter(source.cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '訂單');
            if (generation !== orderLoadGeneration) return;
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
        if (generation !== orderLoadGeneration) return;
        ordersCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'orderDate', 'id'));
        writeAppDataCache('orders', ordersCache);
        // 訂單頁與採購頁共用同一份 ordersCache；只要這次雲端訂單讀取已成功，
        // 採購頁第一次切入待採購／待打單時就直接沿用，不再重查同一批 orders。
        purchasingOrdersReady = true;
        if (!options.skipRender) {
            if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
            else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        }
    } catch (err) {
        if (generation !== orderLoadGeneration) return;
        console.error("讀取訂單失敗：", err);
        if (records.size) {
            ordersCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'orderDate', 'id'));
        }
        if (!options.skipRender) {
            if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
            else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        }
        if (err?.code === 'firestore-read-timeout') {
            orderLoadErrorMessage = '連線逾時，點此重試';
        } else {
            orderLoadErrorMessage = '讀取失敗，點此重試';
            if (!options.silent) alert('讀取訂單資料失敗，請確認網路或 Firestore 權限設定。');
        }
    } finally {
        if (generation !== orderLoadGeneration) return;
        orderPageLoading = false;
        updateOrderLoadMoreButton();
        if (orderReloadRequested) {
            orderReloadRequested = false;
            loadOrderPage(true);
        }
    }
}

// 訂單資料範圍由固定角色權限決定：業務/工程師只看自己，採購/倉管查看全部。
// 首次與重新整理只載入 50 筆；歷史資料由「載入更多」明確取得，避免資料增加後
// 每次進入訂單頁都在背景掃完整個 orders 集合。
window.loadOrdersFromCloud = function() {
    return loadOrderPage(true);
};

window.loadMoreOrders = function() {
    return loadOrderPage(false);
};

function normalizeFullHistorySearchValue(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\-_.\/\\,，。:：;；()（）\[\]{}]+/g, '');
}

function normalizeHistoryItemCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function fullHistorySearchValues(type, record = {}) {
    if (type === 'equipment') {
        return [
            record.assetId, record.customerName, record.brand, record.model,
            record.serialNo, record.salesName, record.location, record.notes
        ];
    }
    if (type === 'forecast') {
        return [
            record.customerName, record.brand, record.productName, record.latestProgress,
            record.salesName, forecastStageLabel(record.stage), forecastStatusLabel(record.status)
        ];
    }
    if (type === 'quote') {
        return [
            record.quoteNo, record.clientName, record.ordererName, record.salesName,
            ...(Array.isArray(record.items) ? record.items.flatMap(item => [
                item.brand, item.model, item.nameCn, item.nameEn, item.spec,
                item.origin, item.leadTime, item.hospitalItemCode, item.remarks,
                ...(Array.isArray(item.customFields) ? item.customFields.flatMap(field => [field.label, field.value]) : [])
            ]) : [])
        ];
    }
    return [
        record.id, record.orderNo, record.quoteNo, record.customerName, record.brand,
        record.itemCode, record.itemName, record.salesName, record.purchaseOrderNo,
        record.invoiceTitle, record.productLine, record.spec,
        ...(Array.isArray(record.items) ? record.items.flatMap(item => [
            item.itemId, item.brand, item.itemCode, item.itemName, item.productLine,
            item.productType, item.spec, ...(Array.isArray(item.purchaseOrderNos) ? item.purchaseOrderNos : [])
        ]) : [])
    ];
}

function fullHistoryBaseTokens(type, record = {}) {
    const tokens = new Set();
    const MAX_BASE_TOKENS = 180;
    for (const raw of fullHistorySearchValues(type, record)) {
        const normalized = normalizeFullHistorySearchValue(raw);
        if (!normalized) continue;
        tokens.add(normalized);
        const maxGram = Math.min(6, normalized.length);
        for (let size = 1; size <= maxGram; size += 1) {
            for (let i = 0; i + size <= normalized.length; i += 1) {
                tokens.add(normalized.slice(i, i + size));
                if (tokens.size >= MAX_BASE_TOKENS) return [...tokens];
            }
        }
    }
    return [...tokens];
}

function buildFullHistorySearchTokens(type, record = {}) {
    const base = fullHistoryBaseTokens(type, record);
    const tokens = new Set(base);
    const salesCode = String(record.salesCode || '').trim();
    const ownerUid = String(record.ownerUid || '').trim();
    const salesName = normalizeFullHistorySearchValue(record.salesName || '');
    base.forEach(token => {
        if (salesCode) tokens.add(`sc:${salesCode}:${token}`);
        if (ownerUid) tokens.add(`uid:${ownerUid}:${token}`);
        if (salesName) tokens.add(`sn:${salesName}:${token}`);
    });
    return [...tokens].slice(0, 700);
}

function fullHistoryServerToken(keyword) {
    const normalized = normalizeFullHistorySearchValue(keyword);
    return normalized.length > 6 ? normalized.slice(0, 6) : normalized;
}

function fullHistoryQueryToken(type, keyword) {
    const token = fullHistoryServerToken(keyword);
    if (!token) return '';
    const canViewAll = type === 'quote' ? canViewAllData('quotes')
        : type === 'forecast' ? canViewAllData('forecast')
        : type === 'equipment' ? canViewAllEquipment()
        : canViewAllData('orders');
    if (canViewAll) return token;
    if (currentUserCode) return `sc:${currentUserCode}:${token}`;
    if (currentUser?.uid) return `uid:${currentUser.uid}:${token}`;
    if (currentUserName) return `sn:${normalizeFullHistorySearchValue(currentUserName)}:${token}`;
    return '';
}

function scopedHistorySearchQuery(collectionName, queryToken) {
    let query = db.collection(collectionName).where('searchTokens', 'array-contains', queryToken);
    const scopeKey = collectionName === 'quotes' ? 'quotes' : collectionName === 'forecasts' ? 'forecast' : 'orders';
    if (!canViewAllData(scopeKey)) {
        if (currentUserCode) query = query.where('salesCode', '==', currentUserCode);
        else if (currentUser?.uid) query = query.where('ownerUid', '==', currentUser.uid);
    }
    return query;
}

function fullHistoryRecordMatches(type, record, keyword) {
    const needle = normalizeFullHistorySearchValue(keyword);
    if (!needle) return true;
    return fullHistorySearchValues(type, record)
        .some(value => normalizeFullHistorySearchValue(value).includes(needle));
}

/*
 * 統一全歷史搜尋：估價單／訂單使用 searchTokens 後端索引；
 * 一般列表仍每次只載入 50 筆，搜尋則自動逐頁讀完符合索引的候選資料。
 */
let orderHistorySearchActive = false;
let orderHistorySearchLoading = false;
let orderHistorySearchKeyword = '';
let orderHistorySearchResults = [];
let orderHistorySearchTimer = null;
let orderHistorySearchGeneration = 0;

function updateOrderHistorySearchUi(message = '') {
    const status = document.getElementById('orderHistorySearchStatus');
    if (status) status.innerText = message;
}

async function runOrderHistorySearch() {
    const generation = ++orderHistorySearchGeneration;
    const input = document.getElementById('orderSearch');
    const rawKeyword = input?.value || '';
    const normalized = normalizeFullHistorySearchValue(rawKeyword);
    if (!normalized) {
        orderHistorySearchActive = false;
        orderHistorySearchLoading = false;
        orderHistorySearchKeyword = '';
        orderHistorySearchResults = [];
        updateOrderHistorySearchUi('');
        renderOrdersList();
        return;
    }
    const queryToken = fullHistoryQueryToken('order', rawKeyword);
    if (!queryToken) {
        orderHistorySearchActive = false;
        orderHistorySearchLoading = false;
        orderHistorySearchResults = [];
        updateOrderHistorySearchUi('目前帳號缺少可用的資料歸屬資訊，無法進行全歷史搜尋。');
        renderOrdersList();
        return;
    }

    orderHistorySearchLoading = true;
    orderHistorySearchActive = true;
    orderHistorySearchKeyword = rawKeyword;
    orderHistorySearchResults = [];
    const records = new Map();
    let cursor = null;
    let checked = 0;
    let lastIntermediateRenderAt = 0;
    updateOrderHistorySearchUi('正在搜尋全部歷史訂單…');
    renderOrdersList();

    try {
        while (true) {
            let query = scopedHistorySearchQuery('orders', queryToken).limit(DEFAULT_LIST_LIMIT);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '訂單索引搜尋');
            if (generation !== orderHistorySearchGeneration) return;

            checked += snapshot.size;
            snapshot.forEach(doc => {
                const data = { id: doc.id, ...doc.data() };
                if (fullHistoryRecordMatches('order', data, rawKeyword)) records.set(doc.id, data);
            });
            const now = Date.now();
            if (now - lastIntermediateRenderAt >= 100 || snapshot.size < DEFAULT_LIST_LIMIT) {
                lastIntermediateRenderAt = now;
                orderHistorySearchResults = [...records.values()]
                    .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'orderDate','id'));
                renderOrdersList();
            }
            updateOrderHistorySearchUi(`全歷史搜尋中：已檢查 ${checked} 筆候選資料，找到 ${records.size} 筆…`);

            if (snapshot.size < DEFAULT_LIST_LIMIT) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
            await Promise.resolve();
        }
        if (generation !== orderHistorySearchGeneration) return;
        orderHistorySearchResults = [...records.values()]
            .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'orderDate','id'));
        updateOrderHistorySearchUi(`全歷史搜尋完成：找到 ${records.size} 筆`);
    } catch (err) {
        if (generation !== orderHistorySearchGeneration) return;
        console.error('訂單全歷史搜尋失敗：', err);
        orderHistorySearchActive = false;
        orderHistorySearchResults = [];
        updateOrderHistorySearchUi('全歷史搜尋索引尚未補齊，請管理員到資料庫管理執行搜尋索引補建。');
        renderOrdersList();
    } finally {
        if (generation === orderHistorySearchGeneration) {
            orderHistorySearchLoading = false;
            renderOrdersList();
        }
    }
}

window.scheduleOrderHistorySearch = function() {
    clearTimeout(orderHistorySearchTimer);
    const keyword = document.getElementById('orderSearch')?.value || '';
    if (!normalizeFullHistorySearchValue(keyword)) return runOrderHistorySearch();
    orderHistorySearchTimer = scheduleListSearch(orderHistorySearchTimer, () => runOrderHistorySearch());
};

window.searchAllOrderHistory = function() { return runOrderHistorySearch(); };
window.clearOrderHistorySearch = function() {
    clearTimeout(orderHistorySearchTimer);
    orderHistorySearchGeneration++;
    orderHistorySearchLoading = false;
    orderHistorySearchActive = false;
    orderHistorySearchKeyword = '';
    orderHistorySearchResults = [];
    const input = document.getElementById('orderSearch');
    if (input) input.value = '';
    updateOrderHistorySearchUi('');
    renderOrdersList();
};

// 依「成本」跟「單價（售價）」計算利潤%// 依「成本」跟「單價（售價）」計算利潤% = (售價－成本) / 成本 × 100，也就是以成本為基準的加成率
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
function orderBrandFilterValue(value, selectableBrands) {
    const key = normalizeBrandLookupKey(resolveBrandName(value));
    if (!key) return '';
    return selectableBrands.find(brand => normalizeBrandLookupKey(brand) === key) || OTHER_BRAND_OPTION_KEY;
}

let orderFilterOptionsSignature = '';

function workflowSalesFilterNames() {
    return [...new Set(salesList.map(person => stripPhoneSuffix(person.name)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

function populatePurchaserOrderFilters() {
    const wrap = document.getElementById('purchaserOrderFilters');
    const salesSelect = document.getElementById('orderSalesFilter');
    const brandSelect = document.getElementById('orderBrandFilter');
    if (!wrap || !salesSelect || !brandSelect) return;

    const enabled = canViewAllData('orders');
    wrap.style.display = enabled ? '' : 'none';
    if (!enabled) {
        salesSelect.value = '';
    }

    const salesValue = salesSelect.value;
    const brandValue = brandSelect.value;
    const sales = workflowSalesFilterNames();
    const brands = getPriceListBrands(true);
    const signature = JSON.stringify([enabled, sales, brands]);

    // 訂單頁與採購頁都用正式人員名單，不再依目前載入的 50 筆訂單臨時產生選項。
    // 選項沒變時也不要每次 render 都重建 select DOM。
    if (signature !== orderFilterOptionsSignature) {
        if (enabled) {
            salesSelect.innerHTML = '<option value="">全部業務</option>' + sales.map(name =>
                `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
        }
        brandSelect.innerHTML = '<option value="">全部廠牌</option>' + brands.map(brand =>
            `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('')
            + `<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
        orderFilterOptionsSignature = signature;
    }
    if (enabled && sales.includes(salesValue)) salesSelect.value = salesValue;
    else if (enabled && salesSelect.value && !sales.includes(salesSelect.value)) salesSelect.value = '';
    if (brands.includes(brandValue) || brandValue === OTHER_BRAND_OPTION_KEY) brandSelect.value = brandValue;
    else if (brandSelect.value && !brands.includes(brandSelect.value)) brandSelect.value = '';
    return brands;
}


window.renderOrdersList = function() {
    const tbody = document.getElementById('ordersBody');
    const searchInput = document.getElementById('orderSearch');
    if (!tbody || !searchInput) return;

    const canManageOrderOps = currentUserRole === 'purchaser' || currentUserRole === 'admin';
    const canEditOrders = canEditPage('orders.list');
    const canManageOrderLifecycle = canManageOrderLifecycleCapability();
    const canConfirmOrderDelivery = canManageOrderLifecycle;
    const costHeader = document.getElementById('orderCostHeader');
    if (costHeader) costHeader.style.display = canManageOrderOps ? '' : 'none';

    const selectableBrands = populatePurchaserOrderFilters() || [];
    const salesFilter = document.getElementById('orderSalesFilter')?.value || '';
    const brandFilter = document.getElementById('orderBrandFilter')?.value || '';
    const keyword = (searchInput.value || '').toLowerCase();
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    const visibleOrderSource = orderHistorySearchActive ? orderHistorySearchResults : ordersCache;
    // 同一次列表 render 每筆訂單只 normalize 一次，避免搜尋、廠牌篩選、狀態卡片與產品欄重複處理 items。
    const normalizedItemsByOrder = new Map(visibleOrderSource.map(o => [o.id, normalizedOrderItems(o)]));
    const baseOrders = visibleOrderSource.filter(o => {
        const orderItems = normalizedItemsByOrder.get(o.id) || [];
        if (!orderHistorySearchActive && keyword) {
            const itemSearchable = orderItems.flatMap(item => [
                item.brand, item.itemCode, item.itemName, item.productLine, item.productType, item.spec
            ]).join(' ');
            const searchable = `${o.customerName || ''} ${o.brand || ''} ${o.itemCode || ''} ${o.itemName || ''} ${o.quoteNo || ''} ${o.salesName || ''} ${itemSearchable}`.toLowerCase();
            if (!searchable.includes(keyword)) return false;
        }
        if (salesFilter && stripPhoneSuffix(o.salesName) !== salesFilter) return false;
        if (brandFilter && !orderItems.some(item => orderBrandFilterValue(item.brand, selectableBrands) === brandFilter)
            && orderBrandFilterValue(o.brand, selectableBrands) !== brandFilter) return false;
        return true;
    });
    // 工作圖卡與下方訂單列共用同一份 dispatch snapshot；
    // 每個品項在一次 render 內只掃一次送貨／退貨紀錄。
    const dispatchStatesByOrder = new Map(baseOrders.map(order => {
        const items = normalizedItemsByOrder.get(order.id) || [];
        return [order.id, new Map(items.map(item => [item, itemDispatchState(order, item)]))];
    }));
    const lifecyclesByOrder = new Map(baseOrders.map(order => [
        order.id,
        orderLifecycleInfo(order, normalizedItemsByOrder.get(order.id) || [])
    ]));
    renderOrderWorkCards(baseOrders, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder);

    baseOrders.forEach(o => {
        const allOrderItems = normalizedItemsByOrder.get(o.id) || [];
        const lifecycle = lifecyclesByOrder.get(o.id) || orderLifecycleInfo(o, allOrderItems);
        const dispatchStateByItem = dispatchStatesByOrder.get(o.id) || new Map();
        const displayCategoriesByItem = new Map(
            allOrderItems.map(item => [item, orderItemDisplayCategories(o, item, lifecycle, dispatchStateByItem.get(item))])
        );
        const categories=[...new Set(allOrderItems.flatMap(item=>displayCategoriesByItem.get(item) || []))];
        if(activeOrderWorkFilter!=='all'&&!categories.includes(activeOrderWorkFilter))return;
        if(!orderMatchesWorkPeriod(o,activeOrderWorkFilter==='all'?'all':activeOrderWorkFilter))return;
        // 工作圖卡是以「品項」計數；套用狀態篩選後，產品欄也只顯示該狀態品項，
        // 避免同一張多品項訂單把其他狀態的品項一起帶進來造成誤判。
        const orderItems=activeOrderWorkFilter==='all'
            ? allOrderItems
            : allOrderItems.filter(item=>(displayCategoriesByItem.get(item) || []).includes(activeOrderWorkFilter));
        shown++;

        const tr = document.createElement('tr');
        // 這些摘要共用上方已算好的 dispatch state，不再各自掃描送貨／退貨紀錄。
        const deliveryProgress = canConfirmOrderDelivery ? deliveryProgressInfo(o, allOrderItems) : null;
        const fulfillmentProgress = canConfirmOrderDelivery ? fulfillmentProgressInfo(o, allOrderItems, dispatchStateByItem) : null;
        const contextActions = orderContextActionState(o, allOrderItems, dispatchStateByItem);
        const deliveryPending = pendingDeliveryOrderIds.has(o.id);
        const billingPending = pendingOrderStatusKeys.has(o.id + ':isBilled');
        const lifecyclePending = pendingLifecycleOrderIds.has(o.id);
        if (lifecycle.status !== 'normal') {
            tr.classList.add('order-row-closed');
        }
        bindListRowSelection(tr);
        tr.innerHTML = `
            <td data-th="訂單日期">${escapeHtml(o.orderDate || '')}</td>
            <td data-th="客戶名稱">${o.customerName ? `<button type="button" class="btn-small btn-secondary" onclick="showCustomerOrderHistory('${escapeAttr(o.customerName)}')">${escapeHtml(o.customerName)}</button>` : ''}</td>
            <td data-th="負責業務">${escapeHtml(stripPhoneSuffix(o.salesName))}</td>
            <td data-th="產品資訊" class="order-product-cell">${orderItems.map((item,index)=>{const displayCategories=displayCategoriesByItem.get(item)||[];const primaryStatus=displayCategories[0]||'ordering';const itemStatus=activeOrderWorkFilter==='dispatch'&&displayCategories.includes('dispatch')?'dispatch':primaryStatus;const itemStatusMap={ordering:'待採購',arrival:'待到貨',dispatch:'待打單',shipping:'待出貨',billing:'待核銷',complete:'已完成',closed:lifecycle.label};const waiting=primaryStatus==='arrival'?waitingDaysFromDate(item.orderedAt):'';const state=dispatchStateByItem.get(item)||itemDispatchState(o,item);const parallelDispatch=primaryStatus!=='dispatch'&&state.pending>0;return `<div style="${index?'margin-top:5px;padding-top:5px;border-top:1px solid #eee;':''}"><strong>${escapeHtml(item.itemName || '－')}</strong><small>${escapeHtml(item.brand || '未分類')}${item.itemCode ? `・${escapeHtml(item.itemCode)}` : ''}・${Number(item.orderedQty||item.qty||0)}</small><small class="order-item-work-status">訂單狀態：<span class="order-progress-badge">${escapeHtml(itemStatusMap[itemStatus]||'待採購')}</span>${waiting?`・已等 ${escapeHtml(waiting)}`:''}${parallelDispatch&&itemStatus!=='dispatch'?`・另有 ${escapeHtml(state.pending)} 待打單`:''}${state.shippable>0?`・已有 ${escapeHtml(state.shippable)} 可出貨`:''}</small></div>`}).join('')}</td>
            <td data-th="售價" class="order-money-cell"><strong>NT$ ${escapeHtml(Number(parseFloat(String(o.totalPrice ?? '').replace(/,/g, '')) || 0).toLocaleString())}</strong><small>NT$ ${escapeHtml(Number(parseFloat(String(o.unitPrice ?? '').replace(/,/g, '')) || 0).toLocaleString())} × ${escapeHtml(String(o.qty || 0))}</small></td>
            ${canManageOrderOps ? `
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
                    
                    ${canConfirmOrderDelivery ? `<button type="button" class="btn-small ${deliveryPending ? 'btn-secondary' : deliveryProgress.state === 'complete' ? 'status-ok' : deliveryProgress.state === 'partial' ? 'status-soon' : 'btn-secondary'}" onclick="quickCompleteDelivery('${o.id}')" ${lifecycle.status !== 'normal' || deliveryPending || deliveryProgress.state === 'complete' || fulfillmentProgress.shippable<=0 ? 'disabled' : ''}>${deliveryPending ? '處理中…' : deliveryProgress.state === 'complete' ? '已送貨' : fulfillmentProgress.shippable>0 ? '已送貨' : '待打單'}</button>` : ''}
                    ${canBusinessSelfOrder(o) ? `<button type="button" class="btn-small ${o.isBilled ? 'status-ok' : 'btn-secondary'}" onclick="toggleOrderStatus('${o.id}', 'isBilled', ${!o.isBilled})" ${lifecycle.status !== 'normal' || billingPending ? 'disabled' : ''}>${billingPending ? '儲存中…' : o.isBilled ? '已核銷' : '核銷'}</button>` : ''}
                    <details class="order-more-menu">
                        <summary title="更多操作">⋯</summary>
                        <div class="order-more-menu-popover">
                            ${lifecyclePending
                                ? (canManageOrderLifecycle ? '<button type="button" disabled>處理中…</button>' : '')
                                : canManageOrderLifecycle
                                    ? (lifecycle.status === 'normal'
                                        ? `${contextActions.showPartialDelivery ? `<button type="button" onclick="openPartialDeliveryForOrder('${o.id}')">分批交貨</button>` : ''}
                            <button type="button" class="danger-menu-item" onclick="quickSetOrderLifecycle('${o.id}', 'cancelled')">取消訂單</button>
                            ${contextActions.showReturn ? `<button type="button" onclick="openReturnManagement('${o.id}')">退貨</button>` : ''}`
                                        : `<button type="button" onclick="quickSetOrderLifecycle('${o.id}', 'normal')">恢復訂單</button>`)
                                    : ''}
                            ${dispatchActionHtml(o, allOrderItems, dispatchStateByItem)}
                            ${selfOrderActionHtml(o, allOrderItems, dispatchStateByItem)}
                            ${canManageOrderOps && o.inventoryReservationStatus==='failed' ? `<button type="button" onclick="retryOrderInventoryReservation('${o.id}')">重新同步庫存占用</button>` : ''}
                            <button type="button" onclick="copyOrderAsNew('${o.id}')">複製成新訂單</button>
                            <button type="button" onclick="openOrderStatusHistory('${o.id}')">紀錄</button>
                            ${trueUserRole === 'admin' && currentUserRole === 'admin' ? `<button type="button" class="danger-menu-item" onclick="permanentlyDeleteOrder('${escapeAttr(o.id)}')">永久刪除</button>` : ''}
                        </div>
                    </details>
                </div>
            </td>
        `;
        if (!canEditOrders) {
            tr.querySelectorAll('.order-transaction-cell select, .order-transaction-cell input, td[data-th="備註"] input').forEach(control => {
                control.disabled = true;
                control.setAttribute('aria-readonly', 'true');
            });
            tr.querySelectorAll('.order-more-menu-popover button').forEach(button => {
                const action = button.getAttribute('onclick') || '';
                if (!action.includes('openOrderStatusHistory(')) button.remove();
            });
        }
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
    document.getElementById('ordersEmptyHint').style.display = shown === 0 ? 'block' : 'none';
    // 採購頁打開時才重算其工作卡；切頁時會用同一份 ordersCache 立即產生。
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
};

window.retryOrderInventoryReservation = async function(orderId) {
    if (!(currentUserRole === 'admin' || currentUserRole === 'purchaser')) { alert('只有管理員或採購可以重新同步庫存占用。'); return; }
    const order=ordersCache.find(row=>row.id===orderId);
    if(!order){alert('找不到這筆訂單，請重新整理後再試。');return;}
    if(order.inventoryReservationStatus!=='failed'){alert('只有庫存占用失敗的訂單可以重新同步。');return;}
    if(normalizedOrderStatus(order)!=='normal'){alert('已取消／作廢的訂單不可重新同步庫存占用。');return;}
    try{
        const now=new Date().toISOString();
        await db.collection('orders').doc(orderId).set({inventoryReservationStatus:'pending',inventoryReservationError:'',inventoryReservationUpdatedAt:now},{merge:true});
        order.inventoryReservationStatus='pending';order.inventoryReservationError='';order.inventoryReservationUpdatedAt=now;renderOrdersList();
        const reservation=await reserveInventoryForNewOrder(orderId,order);
        const completedAt=new Date().toISOString();
        const updates={inventoryReservationStatus:'completed',inventoryReservationError:'',inventoryReservationUpdatedAt:completedAt};
        await db.collection('orders').doc(orderId).set(updates,{merge:true});
        Object.assign(order,updates);
        renderOrdersList();
        alert('庫存占用已重新同步完成。');
    }catch(err){
        const failedAt=new Date().toISOString();
        const updates={inventoryReservationStatus:'failed',inventoryReservationError:String(err?.message||err),inventoryReservationUpdatedAt:failedAt};
        await db.collection('orders').doc(orderId).set(updates,{merge:true}).catch(markErr=>console.error('重新同步失敗狀態寫入失敗：',markErr));
        Object.assign(order,updates);renderOrdersList();
        alert('重新同步庫存占用失敗：'+(err?.message||err));
    }
};

// 採購主頁資料
let poListCache = [];
let poListCursor = null;
let poListHasMore = false;
let poListPageLoading = false;
let poHistorySearchResults = [];
let poHistorySearchActive = false;
let poHistorySearchLoading = false;
let poHistorySearchTimer = null;
let poHistorySearchGeneration = 0;
let supplyReceivingCache = [];
let supplyReceivingCursor = null;
let supplyReceivingHasMore = true;
let receivingSourceOrderStatusCache = new Map();
let receivingSourceOrderCache = new Map();
let purchasingOrderRefreshPromise = null;
let purchasingOrdersReady = false;
let purchasingReceivingLoadPromise = null;
let purchasingReceivingReady = false;
let purchasingView = 'ordering';
let pendingPurchaseCursor = null;
let pendingPurchaseHasMore = true;
let pendingPurchaseLoading = false;
let pendingPurchaseCache = [];
let pendingPurchaseError = '';
let purchasingDispatchCache = [];
let purchasingDispatchCursor = null;
let purchasingDispatchHasMore = true;
let purchasingDispatchLoading = false;
let purchasingDispatchError = '';
let purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT;

const purchasingViewLoaded = new Set();

function refreshPurchasingOrderCache(reset = true, options = {}) {
    if (options.reuseOrders && purchasingOrdersReady) return Promise.resolve(ordersCache);
    if (purchasingOrderRefreshPromise) return purchasingOrderRefreshPromise;
    // 採購頁自己的 caller 會在資料更新後統一 render；
    // 背景共用 orders 查詢只更新 cache，不先重畫一次工作卡。
    purchasingOrderRefreshPromise = Promise.resolve(loadOrderPage(reset, { silent: true, skipRender: true }))
        .then(() => {
            purchasingOrdersReady = true;
            return ordersCache;
        })
        .finally(() => { purchasingOrderRefreshPromise = null; });
    return purchasingOrderRefreshPromise;
}

function loadPurchasingReceivingQueue(reset = true, options = {}) {
    if (purchasingReceivingLoadPromise) return purchasingReceivingLoadPromise;
    purchasingReceivingReady = false;
    if (options.reuseOrders) {
        const status = document.getElementById('poHistorySearchStatus');
        if (status) status.textContent = '待到貨資料載入中…';
    } else {
        renderPoList();
    }
    purchasingReceivingLoadPromise = Promise.allSettled([
        loadPurchaseOrderPage(reset, { deferRender:true }),
        refreshPurchasingOrderCache(reset, options)
    ]).then(results => {
        purchasingReceivingReady = true;
        const failed = results.filter(result => result.status === 'rejected');
        // 兩條查詢平行完成後，以待到貨來源訂單再合併一次，
        // 避免較晚完成的近期訂單刷新覆蓋較舊但仍在途的來源訂單。
        mergeReceivingSourceOrdersIntoOrderCache();
        renderPurchasingView();
        if (failed.length) throw failed[0].reason;
    }).finally(() => {
        purchasingReceivingLoadPromise = null;
    });
    return purchasingReceivingLoadPromise;
}

let purchasingFilterOptionsSignature = '';

function populatePurchasingFilters() {
    const salesSelect = document.getElementById('purchaseSalesFilter');
    const brandSelect = document.getElementById('purchaseBrandFilter');
    if (!salesSelect || !brandSelect) return;
    const salesValue = salesSelect.value;
    const brandValue = brandSelect.value;
    const sales = workflowSalesFilterNames();
    const brands = getPriceListBrands(true);
    const signature = JSON.stringify([sales, brands]);

    // renderPurchasingView 會在切頁、篩選、背景更新時反覆呼叫；選項沒變就不要重建整個 select DOM。
    if (signature !== purchasingFilterOptionsSignature) {
        salesSelect.innerHTML = '<option value="">全部業務</option>' + sales.map(name =>
            `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
        brandSelect.innerHTML = '<option value="">全部廠牌</option>' + brands.map(brand =>
            `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('')
            + `<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
        purchasingFilterOptionsSignature = signature;
    }
    if (sales.includes(salesValue)) salesSelect.value = salesValue;
    else if (salesSelect.value && !sales.includes(salesSelect.value)) salesSelect.value = '';
    if (brands.includes(brandValue) || brandValue === OTHER_BRAND_OPTION_KEY) brandSelect.value = brandValue;
    else if (brandSelect.value && !brands.includes(brandSelect.value)) brandSelect.value = '';
}

function purchasePeriodRange() {
    const preset = document.getElementById('poPeriodFilter')?.value || 'this-year';
    if (preset === 'custom') return {
        start: document.getElementById('purchasePeriodStart')?.value || '',
        end: document.getElementById('purchasePeriodEnd')?.value || ''
    };
    return unifiedPeriodRange(preset);
}

function purchaseFilterContext() {
    const { start, end } = purchasePeriodRange();
    return {
        start,
        end,
        selectedSales: document.getElementById('purchaseSalesFilter')?.value || '',
        selectedBrand: document.getElementById('purchaseBrandFilter')?.value || '',
        selectableBrands: getPriceListBrands(true)
    };
}

function purchaseLineMatchesFilters(date, salesName, brand, context = null) {
    const filters = context || purchaseFilterContext();
    const businessDate = normalizeBusinessDate(date);
    if ((filters.start || filters.end) && (!businessDate || (filters.start && businessDate < filters.start) || (filters.end && businessDate > filters.end))) return false;
    if (filters.selectedSales && stripPhoneSuffix(salesName) !== filters.selectedSales) return false;
    return !filters.selectedBrand || orderBrandFilterValue(brand, filters.selectableBrands) === filters.selectedBrand;
}

function remainingProcurementQty(order, item, dispatchOverride = null) {
    const returnedQty = (item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP'
        ? (dispatchOverride || itemDispatchState(order,item)).returned
        : Number(item.returnedQty || 0);
    const quantities = window.YushinWorkflow?.procurementQuantities({
        orderedQty:item.orderedQty ?? item.qty,
        fulfillmentType:item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE',
        shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty,
        receivedQty:item.receivedQty,
        returnedQty
    });
    if (quantities) return quantities.remainingToOrderQty;
    const qty = Math.max(0, Number(item.orderedQty ?? item.qty ?? 0));
    const ordered = Math.max(0, Number(item.supplyOrderedQty || 0));
    if ((item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') {
        return Math.max(0, qty + Math.max(0, Number(returnedQty || 0)) - ordered);
    }
    const shortage = Math.max(0, Number(item.shortageQty || 0));
    const received = Math.max(0, Number(item.receivedQty || 0));
    return Math.max(0, shortage - Math.max(0, ordered - received));
}

function purchasingLifecycleSnapshot(normalizedItemsByOrder, sourceOrders = ordersCache) {
    const itemMap = normalizedItemsByOrder || new Map(
        sourceOrders.map(order => [order.id, normalizedOrderItems(order)])
    );
    return new Map(
        sourceOrders.map(order => [order.id, orderLifecycleInfo(order, itemMap.get(order.id) || [])])
    );
}

function purchasingDispatchStateSnapshot(normalizedItemsByOrder, sourceOrders = ordersCache) {
    const itemMap = normalizedItemsByOrder || new Map(
        sourceOrders.map(order => [order.id, normalizedOrderItems(order)])
    );
    return new Map(
        sourceOrders.map(order => {
            const items = itemMap.get(order.id) || [];
            return [order.id, new Map(items.map(item => [item, itemDispatchState(order, item)]))];
        })
    );
}

function pendingProcurementDisplayLines(order, normalizedItems = null, dispatchStateByItem = null, lifecycleOverride = null) {
    if (normalizedOrderStatus(order) !== 'normal') return [];
    // 工作卡與明細只讀訂單本身；不要在 render 階段解析成本／Product Master。
    // 同一輪採購頁 render 可直接沿用已 normalize 的品項快照。
    // 真正按「已訂購／產生訂購單」時，pendingPurchaseLines() 才補齊正式採購資料。
    const items = normalizedItems || normalizedOrderItems(order);
    const lifecycle = lifecycleOverride || orderLifecycleInfo(order, items);
    return items.map((item, index) => {
        const dispatch = dispatchStateByItem?.get(item) || itemDispatchState(order, item);
        if (orderItemWorkCategory(order, item, lifecycle, dispatch) !== 'ordering') return null;
        const qty = remainingProcurementQty(order, item, dispatch);
        if (!(qty > 0)) return null;
        return {
            orderId: order.id,
            orderItemIndex: index,
            itemId: item.itemId || `item-${index + 1}`,
            itemName: item.itemName || '',
            itemCode: item.itemCode || '',
            productId: item.productId || '',
            brand: item.brand || '',
            productLine: item.productLine || '',
            supplier: item.supplier || '',
            warehouseId: item.warehouseId || '',
            qty,
            salesName: order.salesName || '',
            fulfillmentType: item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE',
            procurementType: item.procurementType || order.procurementType || 'PURCHASING_PO'
        };
    }).filter(Boolean);
}

function renderPurchasingWorkCards(normalizedItemsByOrder = null, completedRows = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const definitions = [
        ['ordering', 'purchaseCountOrdering', 'purchaseAmountOrdering'],
        ['arrival', 'purchaseCountReceiving', 'purchaseAmountReceiving'],
        ['dispatch', 'purchaseCountDispatch', 'purchaseAmountDispatch']
    ];
    const filters = filterContext || purchaseFilterContext();
    // 同一次採購頁 render 只 normalize 每張訂單一次，工作卡與「已完成」統計共用。
    const itemMap = normalizedItemsByOrder || new Map(
        ordersCache.map(order => [order.id, normalizedOrderItems(order)])
    );
    const stateMap = dispatchStatesByOrder || purchasingDispatchStateSnapshot(itemMap);
    const lifecycleMap = lifecyclesByOrder || purchasingLifecycleSnapshot(itemMap);
    // 訂單頁與採購頁共用完全相同的品項狀態與金額統計核心；
    // 採購頁只額外套自己的日期／業務／廠牌篩選，避免兩頁各算各的再次出現數字不一致。
    const metrics = buildOrderItemWorkMetrics(
        ordersCache,
        definitions.map(([category]) => category),
        (order, item) => purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters),
        itemMap,
        stateMap,
        lifecycleMap
    );

    definitions.forEach(([category, countId, amountId]) => {
        const count = document.getElementById(countId);
        const amount = document.getElementById(amountId);
        if (count) count.textContent = `${metrics[category].count} 筆`;
        if (amount) amount.textContent = formatStatsMoney(metrics[category].amount);
    });
    // 圖卡統計已載入資料中的全部已完成品項；50 筆限制只套在下方明細顯示，
    // 避免使用者按「載入更多」時圖卡數字跟著人為跳動。
    const completed = completedRows || purchasingCompletedRows(filters, itemMap, stateMap, lifecycleMap);
    const completedCount = document.getElementById('purchaseCountCompleted');
    const completedAmount = document.getElementById('purchaseAmountCompleted');
    if (completedCount) completedCount.textContent = `${completed.length} 筆`;
    if (completedAmount) completedAmount.textContent = formatStatsMoney(completed.reduce((sum, row) =>
        sum + Number(row.item.unitPrice || row.item.salesPrice || 0) * Number(row.item.qty || row.item.orderedQty || 0), 0));
}

function purchasingCompletedRows(filters = purchaseFilterContext(), normalizedItemsByOrder = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const rows = [];
    ordersCache.forEach(order => {
        const items = normalizedItemsByOrder?.get(order.id) || normalizedOrderItems(order);
        const lifecycle = lifecyclesByOrder?.get(order.id) || orderLifecycleInfo(order, items);
        if (lifecycle.status !== 'normal') return;
        const orderDispatchStates = dispatchStatesByOrder?.get(order.id) || null;
        items.forEach(item => {
            const state = orderDispatchStates?.get(item) || itemDispatchState(order, item);
            const category = orderItemWorkCategory(order, item, lifecycle, state);
            // 採購端只有在「待採購／待到貨」都結束後才算完成。
            // 倉庫品項還要確認出貨單已打完；原廠直送沒有打單步驟，到貨確認後採購工作即完成。
            if (['ordering', 'arrival', 'closed'].includes(category)) return;
            const directShip = (item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
            if (!directShip && (Number(item.dispatchPreparedQty || 0) <= 0 || Number(state.pending || 0) > 0)) return;
            if (!purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters)) return;
            rows.push({ order, item, state });
        });
    });
    return rows;
}

function renderPurchasingCompletedOrders(completedRows = null) {
    const body = document.getElementById('purchaseCompletedBody');
    const status = document.getElementById('purchaseCompletedStatus');
    if (!body) return;
    const allRows = completedRows || purchasingCompletedRows();
    const rows = allRows.slice(0, purchasingCompletedVisibleLimit);
    body.innerHTML = rows.map(({order, item, state}) => `<tr><td data-th="訂單日期">${escapeHtml(order.orderDate || '')}</td><td data-th="客戶">${escapeHtml(order.customerName || order.customer || '')}</td><td data-th="負責業務">${escapeHtml(order.salesName || '')}</td><td data-th="已完成採購品項">${escapeHtml(item.itemCode || item.itemName || item.itemId)} × ${Number(state.prepared || item.dispatchPreparedQty || item.qty || 0)}</td><td data-th="操作" class="no-print"><button type="button" class="btn-small btn-secondary" onclick="openDeliveryModal('${escapeAttr(order.id)}')">查看訂單進度</button></td></tr>`).join('');
    if (status) status.textContent = rows.length
        ? `已顯示 ${rows.length} 筆採購已完成品項${purchasingDispatchHasMore || allRows.length > rows.length ? '；可載入更多' : ''}`
        : '目前沒有採購已完成品項';
    const more = document.getElementById('purchaseCompletedMoreBtn');
    if (more) {
        more.style.display = (allRows.length > rows.length || purchasingDispatchHasMore) ? '' : 'none';
        more.disabled = purchasingDispatchLoading;
        more.textContent = purchasingDispatchLoading ? '載入中…' : '載入更多（每次 50 筆）';
    }
}

window.loadMorePurchasingCompleted = async function() {
    if (purchasingDispatchLoading) return;
    purchasingCompletedVisibleLimit += DEFAULT_LIST_LIMIT;
    const filters = purchaseFilterContext();
    const normalizedItemsByOrder = new Map(
        ordersCache.map(order => [order.id, normalizedOrderItems(order)])
    );
    const dispatchStatesByOrder = purchasingDispatchStateSnapshot(normalizedItemsByOrder);
    const lifecyclesByOrder = purchasingLifecycleSnapshot(normalizedItemsByOrder);
    const loadedRows = purchasingCompletedRows(
        filters,
        normalizedItemsByOrder,
        dispatchStatesByOrder,
        lifecyclesByOrder
    );
    if (loadedRows.length < purchasingCompletedVisibleLimit && purchasingDispatchHasMore) {
        // loadPurchasingDispatchOrders() 完成時已統一更新工作卡與已完成明細；
        // 不再回到外層重畫第二次。
        await loadPurchasingDispatchOrders(false);
        return;
    }
    renderPurchasingWorkCards(
        normalizedItemsByOrder,
        loadedRows,
        filters,
        dispatchStatesByOrder,
        lifecyclesByOrder
    );
    renderPurchasingCompletedOrders(loadedRows);
};

window.renderPurchasingView = function() {
    populatePurchasingFilters();
    if (purchasingView === 'history') {
        // 全部訂購單不顯示工作卡；直接畫正式訂購單歷史，
        // 不需要為了被隱藏的卡片掃描整批 ordersCache。
        renderPoList();
        return;
    }
    const filters = purchaseFilterContext();
    const normalizedItemsByOrder = new Map(
        ordersCache.map(order => [order.id, normalizedOrderItems(order)])
    );
    const dispatchStatesByOrder = purchasingDispatchStateSnapshot(normalizedItemsByOrder);
    const lifecyclesByOrder = purchasingLifecycleSnapshot(normalizedItemsByOrder);
    const completedRows = purchasingView === 'completed'
        ? purchasingCompletedRows(filters, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder)
        : null;
    renderPurchasingWorkCards(normalizedItemsByOrder, completedRows, filters, dispatchStatesByOrder, lifecyclesByOrder);
    if (purchasingView === 'ordering') renderPendingPurchaseOrders(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
    else if (purchasingView === 'dispatch') renderPurchasingDispatchOrders(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
    else if (purchasingView === 'completed') renderPurchasingCompletedOrders(completedRows);
    else renderPoList(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
};

window.changePurchasePeriod = function(value) {
    const custom = document.getElementById('purchaseCustomPeriod');
    if (custom) custom.style.display = value === 'custom' ? 'flex' : 'none';
    if (value === 'custom') {
        const start = document.getElementById('purchasePeriodStart');
        const end = document.getElementById('purchasePeriodEnd');
        if (start && !start.value) start.value = `${new Date().getFullYear()}-01-01`;
        if (end && !end.value) end.value = dateOnlyFromTimestamp(new Date().toISOString());
    }
    renderPurchasingView();
};

window.switchPurchasingView = function(view, tab) {
    if (!canAccessPage('orders.po')) return;
    if (!['ordering', 'receiving', 'dispatch', 'completed', 'history'].includes(view)) return;
    if (view === 'ordering' && !canCreatePurchaseOrderCapability()) return;
    const previousPurchasingView = purchasingView;
    purchasingView = view;
    if (view === 'completed' && previousPurchasingView !== 'completed') purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT;
    populatePurchasingFilters();
    const filters = view === 'history' ? null : purchaseFilterContext();
    const normalizedItemsByOrder = view === 'history'
        ? null
        : new Map(ordersCache.map(order => [order.id, normalizedOrderItems(order)]));
    const dispatchStatesByOrder = view === 'history'
        ? null
        : purchasingDispatchStateSnapshot(normalizedItemsByOrder);
    const lifecyclesByOrder = view === 'history'
        ? null
        : purchasingLifecycleSnapshot(normalizedItemsByOrder);
    const completedRows = view === 'completed'
        ? purchasingCompletedRows(filters, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder)
        : null;
    if (view !== 'history') renderPurchasingWorkCards(normalizedItemsByOrder, completedRows, filters, dispatchStatesByOrder, lifecyclesByOrder);
    const orderingTab = document.getElementById('purchase-card-ordering');
    if (orderingTab) orderingTab.style.display = canCreatePurchaseOrderCapability() ? '' : 'none';
    document.querySelectorAll('#purchaseWorkCards .order-work-card').forEach(el => el.classList.toggle('active', el === (tab || document.getElementById(`purchase-card-${view}`))));
    document.getElementById('purchase-tab-work')?.classList.toggle('active', view !== 'history');
    document.getElementById('purchase-tab-history')?.classList.toggle('active', view === 'history');
    const cards = document.getElementById('purchaseWorkCards');
    if (cards) cards.style.display = view === 'history' ? 'none' : '';
    const pendingPanel=document.getElementById('purchasePendingPanel');
    const poPanel=document.getElementById('poListPanel');
    const dispatchPanel=document.getElementById('purchaseDispatchPanel');
    const completedPanel=document.getElementById('purchaseCompletedPanel');
    if(pendingPanel)pendingPanel.style.display=view==='ordering'?'':'none';
    if(poPanel)poPanel.style.display=(view==='receiving'||view==='history')?'':'none';
    if(dispatchPanel)dispatchPanel.style.display=view==='dispatch'?'':'none';
    if(completedPanel)completedPanel.style.display=view==='completed'?'':'none';
    if (view === 'ordering') {
        renderPendingPurchaseOrders(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
        if (!purchasingViewLoaded.has('ordering')) {
            purchasingViewLoaded.add('ordering');
            loadPendingPurchaseOrders(true, { reuseOrders:true }).catch(err => {
                purchasingViewLoaded.delete('ordering');
                console.error('待採購首次載入失敗：', err);
            });
        }
    } else if (view === 'receiving') {
        renderPoList(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
        if (!purchasingViewLoaded.has('receiving')) {
            purchasingViewLoaded.add('receiving');
            loadPurchasingReceivingQueue(true, { reuseOrders:true }).catch(err => {
                purchasingViewLoaded.delete('receiving');
                console.error('待到貨首次載入失敗：', err);
            });
        }
    } else if (view === 'history') {
        // 全部訂購單採 Gmail 式 stale-while-revalidate：
        // 先顯示上次快取，首次進入本次工作階段時才背景更新；切回此頁不重查第一頁。
        if (!poListCache.length) {
            const cached = readAppDataCache('purchase-history');
            if (cached?.records?.length) poListCache = cached.records;
        }
        renderPoList();
        if (!purchasingViewLoaded.has('history')) {
            purchasingViewLoaded.add('history');
            loadPurchaseOrderPage(true).catch(err => {
                purchasingViewLoaded.delete('history');
                console.error('訂購單紀錄首次載入失敗：', err);
            });
        }
    } else if (view === 'dispatch') {
        renderPurchasingDispatchOrders(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
        if (!purchasingViewLoaded.has('dispatch')) {
            purchasingViewLoaded.add('dispatch');
            Promise.resolve(loadPurchasingDispatchOrders(true, { reuseOrders:true })).catch(err => {
                purchasingViewLoaded.delete('dispatch');
                console.error('待打單首次載入失敗：', err);
            });
        }
    } else renderPurchasingCompletedOrders(completedRows);
};

async function loadPurchasingDispatchOrders(reset=true, options={}) {
    if (!canAccessPage('orders.po') || purchasingDispatchLoading) return;
    // 切到待打單時若共用訂單 cache 已完成雲端讀取，畫面在 switchPurchasingView()
    // 已經算好並畫出，避免同一批資料立刻再跑一次 dispatch/lifecycle snapshot。
    if (options.reuseOrders && purchasingOrdersReady) {
        purchasingDispatchError = '';
        purchasingDispatchHasMore = !!orderPaginationState && orderPaginationState.sourceIndex < orderPaginationState.sources.length;
        return ordersCache;
    }
    purchasingDispatchError = '';
    purchasingDispatchLoading = true;
    let normalizedItemsByOrder = null;
    let dispatchStatesByOrder = null;
    let lifecyclesByOrder = null;
    let filters = null;
    let completedRows = null;
    const refreshButton = document.getElementById(purchasingView === 'completed'
        ? 'purchaseCompletedRefreshBtn'
        : 'purchaseDispatchRefreshBtn');
    if (refreshButton && reset) { refreshButton.disabled = true; refreshButton.textContent = '更新中…'; }
    if (options.reuseOrders) {
        const status = document.getElementById(purchasingView === 'completed'
            ? 'purchaseCompletedStatus'
            : 'purchaseDispatchStatus');
        if (status) status.textContent = '載入中…';
    } else if (purchasingView === 'completed') {
        renderPurchasingCompletedOrders();
    } else {
        renderPurchasingDispatchOrders();
    }
    try {
        await refreshPurchasingOrderCache(reset, options);
        normalizedItemsByOrder = new Map(
            ordersCache.map(order => [order.id, normalizedOrderItems(order)])
        );
        dispatchStatesByOrder = purchasingDispatchStateSnapshot(normalizedItemsByOrder);
        lifecyclesByOrder = purchasingLifecycleSnapshot(normalizedItemsByOrder);
        filters = purchaseFilterContext();
        purchasingDispatchCache = ordersCache.filter(order => {
            const items = normalizedItemsByOrder.get(order.id) || [];
            const lifecycle = lifecyclesByOrder.get(order.id) || orderLifecycleInfo(order, items);
            const states = dispatchStatesByOrder.get(order.id);
            return items.some(item =>
                orderItemDisplayCategories(order, item, lifecycle, states?.get(item)).includes('dispatch')
            );
        });
        purchasingDispatchHasMore = !!orderPaginationState && orderPaginationState.sourceIndex < orderPaginationState.sources.length;
        completedRows = purchasingView === 'completed'
            ? purchasingCompletedRows(filters, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder)
            : null;
        renderPurchasingWorkCards(normalizedItemsByOrder, completedRows, filters, dispatchStatesByOrder, lifecyclesByOrder);
    } catch (err) {
        purchasingDispatchError = `待打單清單讀取失敗，請重試：${String(err?.message || err).slice(0, 160)}`;
    } finally {
        purchasingDispatchLoading = false;
        if (refreshButton) { refreshButton.disabled = false; refreshButton.textContent = '↻ 更新'; }
        if (purchasingView === 'completed') renderPurchasingCompletedOrders(completedRows);
        else renderPurchasingDispatchOrders(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
    }
}

window.loadPurchasingDispatchOrders=loadPurchasingDispatchOrders;

function renderPurchasingDispatchOrders(normalizedItemsByOrder = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const body=document.getElementById('purchaseDispatchBody');
    const status=document.getElementById('purchaseDispatchStatus');
    const more=document.getElementById('purchaseDispatchMoreBtn');
    if(!body)return;
    body.innerHTML='';
    const fragment=document.createDocumentFragment();
    let shown=0;
    const sourceOrders = ordersCache.length ? ordersCache : purchasingDispatchCache;
    const filters=filterContext || purchaseFilterContext();
    sourceOrders.forEach(order=>{
        const items = normalizedItemsByOrder?.get(order.id) || normalizedOrderItems(order);
        const lifecycle = lifecyclesByOrder?.get(order.id) || orderLifecycleInfo(order, items);
        const states = dispatchStatesByOrder?.get(order.id) || null;
        const pending=items.map(item=>{
            const state = states?.get(item) || itemDispatchState(order,item);
            return orderItemDisplayCategories(order, item, lifecycle, state).includes('dispatch')
                ? {item,state}
                : null;
        }).filter(Boolean);
        pending.forEach(({item,state})=>{
            if (!purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters)) return;
            const canPrepareDispatch = currentUserRole === 'purchaser' || currentUserRole === 'admin';
            const action = canPrepareDispatch
                ? `<button type="button" class="btn-small" onclick="markOrderItemDispatchPrepared('${escapeAttr(order.id)}','${escapeAttr(item.itemId)}')">已打單 × ${state.pending}</button>`
                : '<span class="order-progress-badge">唯讀</span>';
            const tr=document.createElement('tr');
            tr.innerHTML=`<td data-th="訂單日期">${escapeHtml(order.orderDate||'')}</td><td data-th="客戶">${escapeHtml(order.customerName||order.customer||'')}</td><td data-th="負責業務">${escapeHtml(order.salesName||'')}</td><td data-th="待打單品項">${escapeHtml(item.itemCode||item.itemName||item.itemId)} × ${state.pending}</td><td data-th="操作">${action}</td>`;
            fragment.appendChild(tr);
            shown++;
        });
    });
    body.appendChild(fragment);
    if(status)status.textContent=purchasingDispatchLoading?'載入中…':purchasingDispatchError||(shown?`已顯示 ${shown} 筆待打單品項`:'目前沒有待打單品項');
    if(more){more.style.display=purchasingDispatchHasMore?'':'none';more.disabled=purchasingDispatchLoading;}
}

function pendingPurchaseLines(order) {
    // 這個函式只代表「採購人員可以建立正式 PO 的品項」；
    // 顯示使用 pendingProcurementDisplayLines()，成本與供應商只在真正操作時解析。
    const displayByIndex = new Map(
        pendingProcurementDisplayLines(order)
            .filter(line => line.procurementType === 'PURCHASING_PO')
            .map(line => [Number(line.orderItemIndex), line])
    );
    if (!displayByIndex.size) return [];
    return purchaseItemsFromOrder(order)
        .filter(line => displayByIndex.has(Number(line.orderItemIndex)))
        .map(line => ({ ...line, qty: displayByIndex.get(Number(line.orderItemIndex)).qty }));
}

function syncOrderIntoPurchasingCaches(order, options = {}) {
    if (!order?.id) return;
    const sync = (cache, include) => {
        const index = cache.findIndex(row => row.id === order.id);
        if (include) {
            if (index >= 0) cache[index] = order;
            else cache.unshift(order);
        } else if (index >= 0) {
            cache.splice(index, 1);
        }
    };
    sync(pendingPurchaseCache, pendingProcurementDisplayLines(order).length > 0);
    sync(purchasingDispatchCache, normalizedOrderItems(order).some(item =>
        orderItemDisplayCategories(order,item).includes('dispatch')
    ));
    receivingSourceOrderStatusCache.set(order.id, normalizedOrderStatus(order));
    receivingSourceOrderCache.set(order.id, order);

    if (options.render === false || !document.getElementById('purchasing-system')?.classList.contains('active')) return;
    // 單筆訂單狀態更新後只走一次統一 renderer；
    // 工作卡與目前明細共用同一批 normalize / dispatch / lifecycle snapshot。
    renderPurchasingView();
}

function syncCommittedPurchaseOrderSources(orders) {
    for (const order of orders) {
        const index = ordersCache.findIndex(row => row.id === order.id);
        if (index >= 0) ordersCache[index] = order;
        else ordersCache.unshift(order);
        syncOrderIntoPurchasingCaches(order, { render:false });
    }
    writeAppDataCache('orders', ordersCache);
    if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
}

function renderPendingPurchaseOrders(normalizedItemsByOrder = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const body = document.getElementById('purchasePendingBody');
    if (!body) return;
    body.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;
    const sourceOrders = ordersCache.length ? ordersCache : pendingPurchaseCache;
    const filters = filterContext || purchaseFilterContext();
    for (const order of sourceOrders) {
        const items = pendingProcurementDisplayLines(
            order,
            normalizedItemsByOrder?.get(order.id),
            dispatchStatesByOrder?.get(order.id),
            lifecyclesByOrder?.get(order.id)
        );
        for (const item of items) {
            if (!purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters)) continue;
            const selfOrder = item.procurementType === 'SALES_SELF_ORDER';
            const actionHtml = selfOrder
                ? (canBusinessSelfOrder(order)
                    ? `<button type="button" class="btn-small btn-secondary" onclick="openSelfOrderModal('${escapeAttr(order.id)}','${escapeAttr(item.itemId)}')">登記自行訂貨</button>`
                    : '<span class="order-progress-badge">自行訂貨・由訂單負責人處理</span>')
                : `<button type="button" class="btn-small" onclick="markPurchaseItemOrdered('${escapeAttr(order.id)}','${escapeAttr(item.itemId)}',this)">已訂購</button> <button type="button" class="btn-small btn-secondary" onclick="openOrderPurchaseDraft('${escapeAttr(order.id)}','${escapeAttr(item.itemId)}')">產生訂購單</button>`;
            const row = document.createElement('tr');
            row.innerHTML = `<td data-th="訂單日期">${escapeHtml(order.orderDate || '')}</td><td data-th="客戶">${escapeHtml(order.customer || order.customerName || '')}</td><td data-th="負責業務">${escapeHtml(order.salesName || '')}</td><td data-th="待採購品項">${escapeHtml(item.itemCode || item.itemName)} × ${Number(item.qty)}<div style="font-size:11px;color:#667584;margin-top:3px;">${selfOrder ? '自行訂貨' : '交由採購訂貨'}</div></td><td data-th="操作">${actionHtml}</td>`;
            fragment.appendChild(row);
            shown++;
        }
    }
    body.appendChild(fragment);
    const status = document.getElementById('purchasePendingStatus');
    if (status) status.textContent = pendingPurchaseLoading ? '載入中…' : pendingPurchaseError || (shown ? `已顯示 ${shown} 筆待採購品項${pendingPurchaseHasMore ? '；較舊待辦請按載入更多' : ''}` : pendingPurchaseHasMore ? '這一頁沒有待採購品項；請按載入更多檢查較舊待辦' : '目前沒有待採購品項');
    const more = document.getElementById('purchasePendingMoreBtn');
    if (more) { more.style.display = pendingPurchaseHasMore ? '' : 'none'; more.disabled = pendingPurchaseLoading; }
}

window.loadPendingPurchaseOrders = async function(reset = true, options = {}) {
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po') || pendingPurchaseLoading) return;
    // switchPurchasingView() 已用同一份 ordersCache 畫過一次；
    // 若訂單資料已是最新，就不要再做第二輪 normalize / snapshot / render。
    if (options.reuseOrders && purchasingOrdersReady) {
        pendingPurchaseError = '';
        pendingPurchaseHasMore = !!orderPaginationState && orderPaginationState.sourceIndex < orderPaginationState.sources.length;
        return ordersCache;
    }
    pendingPurchaseError = '';
    pendingPurchaseLoading = true;
    let normalizedItemsByOrder = null;
    let dispatchStatesByOrder = null;
    let lifecyclesByOrder = null;
    let filters = null;
    const refreshButton = document.getElementById('purchasePendingRefreshBtn');
    if (refreshButton && reset) { refreshButton.disabled = true; refreshButton.textContent = '更新中…'; }
    if (options.reuseOrders) {
        const status = document.getElementById('purchasePendingStatus');
        if (status) status.textContent = '載入中…';
    } else {
        renderPendingPurchaseOrders();
    }
    try {
        // 直接沿用訂單頁同一個分頁載入器與 ordersCache；同一時間不重複發 orders Query。
        await refreshPurchasingOrderCache(reset, options);
        normalizedItemsByOrder = new Map(
            ordersCache.map(order => [order.id, normalizedOrderItems(order)])
        );
        dispatchStatesByOrder = purchasingDispatchStateSnapshot(normalizedItemsByOrder);
        lifecyclesByOrder = purchasingLifecycleSnapshot(normalizedItemsByOrder);
        filters = purchaseFilterContext();
        pendingPurchaseCache = ordersCache.filter(order =>
            pendingProcurementDisplayLines(
                order,
                normalizedItemsByOrder.get(order.id),
                dispatchStatesByOrder.get(order.id),
                lifecyclesByOrder.get(order.id)
            ).length > 0
        );
        pendingPurchaseHasMore = !!orderPaginationState && orderPaginationState.sourceIndex < orderPaginationState.sources.length;
        renderPurchasingWorkCards(normalizedItemsByOrder, null, filters, dispatchStatesByOrder, lifecyclesByOrder);
    } catch (err) {
        pendingPurchaseError = `待採購清單讀取失敗，請重試：${String(err?.message || err).slice(0, 160)}`;
    } finally {
        pendingPurchaseLoading = false;
        if (refreshButton) { refreshButton.disabled = false; refreshButton.textContent = '↻ 更新'; }
        renderPendingPurchaseOrders(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder);
    }
};

const pendingPurchaseOrderKeys = new Set();

function quickPurchaseSupplyId(orderId, itemId) {
    return `manual-${encodeURIComponent(String(orderId || ''))}-${encodeURIComponent(String(itemId || ''))}`;
}

window.markPurchaseItemOrdered = async function(orderId, itemId, button) {
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    const actionKey = `${orderId}::${itemId}`;
    if (pendingPurchaseOrderKeys.has(actionKey)) return;
    pendingPurchaseOrderKeys.add(actionKey);
    const originalLabel = button?.textContent || '已訂購';
    if (button) { button.disabled = true; button.textContent = '處理中…'; }
    try {
        let savedOrder, savedSupply, incomingProductKey='', incomingWarehouseId='';
        const supplyRef = db.collection('supplyOrders').doc(quickPurchaseSupplyId(orderId, itemId));
        await db.runTransaction(async tx => {
            const orderRef = db.collection('orders').doc(orderId);
            const [orderSnapshot, supplySnapshot] = await Promise.all([tx.get(orderRef), tx.get(supplyRef)]);
            if (!orderSnapshot.exists) throw new Error('來源訂單已不存在。');
            const order = { id:orderId, ...orderSnapshot.data() };
            if (normalizedOrderStatus(order) !== 'normal') throw new Error('來源訂單已取消或作廢。');
            const items = normalizedOrderItems(order);
            const itemIndex = items.findIndex(item => item.itemId === itemId);
            if (itemIndex < 0) throw new Error('找不到來源訂單品項。');
            const item = items[itemIndex];
            const qty = remainingProcurementQty(order, item);
            const existingSupply = supplySnapshot.exists ? { id:supplyRef.id, ...supplySnapshot.data() } : null;
            if (!(qty > 0) && !existingSupply) throw new Error('此品項已無待採購數量，請重新整理。');

            const currentProductKey = poIncomingKey(item);
            const currentFulfillmentType = item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE';
            const currentWarehouseId = currentFulfillmentType === 'DIRECT_SHIP'
                ? '' : (item.warehouseId || defaultWarehouse()?.id || '');
            const productKey = existingSupply?.productKey || currentProductKey;
            const fulfillmentType = existingSupply?.fulfillmentType || currentFulfillmentType;
            const directShip = fulfillmentType === 'DIRECT_SHIP';
            const warehouseId = directShip ? '' : (existingSupply?.warehouseId || currentWarehouseId);

            if (existingSupply) {
                if (existingSupply.productKey && currentProductKey && existingSupply.productKey !== currentProductKey) {
                    throw new Error('此品項已建立供應紀錄，產品識別不可在追加採購前變更。');
                }
                if ((existingSupply.fulfillmentType || 'WAREHOUSE') !== currentFulfillmentType) {
                    throw new Error('此品項已建立供應紀錄，訂貨方式不可在追加採購前變更。');
                }
                if (!directShip && existingSupply.warehouseId && currentWarehouseId && existingSupply.warehouseId !== currentWarehouseId) {
                    throw new Error('此品項已建立供應紀錄，入庫倉庫不可在追加採購前變更。');
                }
            }
            if (!directShip && (!productKey || !warehouseId)) throw new Error('訂單快照缺少貨號或入庫倉庫，請先修正來源訂單。');

            const orderDate = localDateString();
            const internalNo = existingSupply?.internalNo || `MO-${orderDate.replace(/-/g, '')}-${supplyRef.id.slice(-8).toUpperCase()}`;
            const alreadyOrdered = Math.max(0, Number(item.supplyOrderedQty || 0));
            const now = new Date().toISOString();
            const previousSupplyQty = Math.max(0, Number(existingSupply?.qty || 0));
            const receivedQty = Math.max(0, Number(existingSupply?.receivedQty || 0));
            const nextSupplyQty = previousSupplyQty + Math.max(0, Number(qty || 0));
            const nextOrdered = alreadyOrdered + Math.max(0, Number(qty || 0));
            const nextSupplyStatus = receivedQty >= nextSupplyQty && nextSupplyQty > 0
                ? 'RECEIVED' : receivedQty > 0 ? 'PARTIAL_RECEIPT' : 'ORDERED';
            const registeredIncomingQty = Math.max(0, Number(existingSupply?.incomingRegisteredQty || 0));
            const targetIncomingQty = directShip ? 0 : Math.max(0, nextSupplyQty - receivedQty);
            const incomingDelta = targetIncomingQty - registeredIncomingQty;

            let invRef=null, whRef=null, invSnap=null, whSnap=null;
            if (!directShip && incomingDelta !== 0) {
                invRef = db.collection('inventory').doc(encodeURIComponent(productKey));
                whRef = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId, productKey));
                [invSnap, whSnap] = await Promise.all([tx.get(invRef), tx.get(whRef)]);
            }

            // 單純重試時不增加訂購量或事件，但仍會修復曾中斷的 incoming 同步。
            const orderEvents = Array.isArray(existingSupply?.orderEvents) ? existingSupply.orderEvents.slice() : [];
            if (qty > 0) {
                orderEvents.push({ qty, orderDate, createdAt:now, createdByUid:currentUser?.uid||'', createdBy:currentUserName||currentUser?.email||'' });
            }

            savedSupply = {
                ...(existingSupply || {}),
                id:supplyRef.id,
                type:existingSupply?.type||'PURCHASING_MANUAL',
                internalNo,
                status:nextSupplyStatus,
                orderId:existingSupply?.orderId||orderId,
                itemId:existingSupply?.itemId||itemId,
                orderItemIndex:existingSupply?.orderItemIndex??itemIndex,
                ownerUid:existingSupply?.ownerUid||order.ownerUid||'',
                salesCode:existingSupply?.salesCode||order.salesCode||'',
                salesName:existingSupply?.salesName||order.salesName||'',
                customerName:existingSupply?.customerName||order.customerName||'',
                company:existingSupply?.company||order.company||'yushin',
                productId:existingSupply?.productId||item.productId||'',
                productKey,
                itemCode:existingSupply?.itemCode||item.itemCode||'',
                itemName:existingSupply?.itemName||item.itemName||'',
                brand:existingSupply?.brand||item.brand||'',
                productLine:existingSupply?.productLine||item.productLine||'',
                qty:nextSupplyQty,
                receivedQty,
                incomingRegisteredQty:targetIncomingQty,
                incomingRegisteredAt:incomingDelta !== 0 ? now : (existingSupply?.incomingRegisteredAt||''),
                supplier:item.supplier||order.supplier||existingSupply?.supplier||'',
                unitCost:Number(item.costPrice??item.unitCost??item.purchasePrice??order.costPrice??existingSupply?.unitCost??0),
                orderDate:existingSupply?.orderDate||orderDate,
                lastOrderedAt:qty > 0 ? orderDate : (existingSupply?.lastOrderedAt||existingSupply?.orderDate||orderDate),
                orderEvents,
                fulfillmentType,
                warehouseId,
                createdAt:existingSupply?.createdAt||now,
                updatedAt:now,
                createdByUid:existingSupply?.createdByUid||currentUser?.uid||'',
                createdBy:existingSupply?.createdBy||currentUserName||currentUser?.email||'',
                createdByRole:existingSupply?.createdByRole||currentUserRole
            };

            if (invRef && whRef) {
                const inv = inventoryNumbers(invSnap?.exists ? invSnap.data() : {});
                const wh = inventoryNumbers(whSnap?.exists ? whSnap.data() : {});
                if (invSnap?.exists) {
                    tx.set(invRef, {incoming:Math.max(0,inv.incoming+incomingDelta),updatedAt:now}, {merge:true});
                } else {
                    const nextInventory = {
                        productKey,
                        productId:existingSupply?.productId||item.productId||'',
                        itemCode:existingSupply?.itemCode||item.itemCode||'',
                        itemName:existingSupply?.itemName||item.itemName||'',
                        brand:resolveBrandName(existingSupply?.brand||item.brand||''),
                        onHand:0, reserved:0,
                        incoming:Math.max(0,incomingDelta), lots:[], updatedAt:now
                    };
                    nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
                    tx.set(invRef,nextInventory,{merge:true});
                }
                tx.set(whRef,{
                    warehouseId,productKey,
                    productId:existingSupply?.productId||item.productId||'',
                    itemCode:existingSupply?.itemCode||item.itemCode||'',
                    itemName:existingSupply?.itemName||item.itemName||'',
                    brand:resolveBrandName(existingSupply?.brand||item.brand||''),
                    onHand:wh.onHand,reserved:wh.reserved,
                    incoming:Math.max(0,wh.incoming+incomingDelta),updatedAt:now
                },{merge:true});
                tx.set(db.collection('inventoryMovements').doc(),{
                    type:'purchase_incoming',qty:incomingDelta,productKey,warehouseId,
                    fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:supplyRef.id,
                    purchaseDocumentId:internalNo,createdAt:now,
                    createdBy:currentUserName||currentUser?.email||'',
                    ownerUid:existingSupply?.ownerUid||order.ownerUid||'',
                    salesCode:existingSupply?.salesCode||order.salesCode||''
                });
                incomingProductKey=productKey;
                incomingWarehouseId=warehouseId;
            }

            tx.set(supplyRef, (({id, ...record}) => record)(savedSupply));
            if (qty > 0) {
                items[itemIndex] = {
                    ...item, supplyOrderedQty:nextOrdered,
                    manualOrderNos:[...new Set([...(item.manualOrderNos||[]),internalNo])],
                    orderedAt:item.orderedAt && item.orderedAt < orderDate ? item.orderedAt : orderDate
                };
                savedOrder = { ...order, items, itemCount:items.length, orderSchemaVersion:2, updatedAt:now };
                tx.update(orderRef, {items, itemCount:items.length, orderSchemaVersion:2,
                    ...orderWorkIndexFields(savedOrder), updatedAt:now});
            } else {
                savedOrder = order;
            }
        });
        if (incomingProductKey && incomingWarehouseId) invalidateWarehouseStockCache(incomingProductKey,incomingWarehouseId);
        const index = ordersCache.findIndex(order => order.id === orderId);
        if (index >= 0 && savedOrder) ordersCache[index] = savedOrder;
        if (savedOrder) syncOrderIntoPurchasingCaches(savedOrder, { render:false });
        if (savedSupply) {
            const supplyIndex=supplyReceivingCache.findIndex(row=>row.id===savedSupply.id);
            if(supplyIndex>=0)supplyReceivingCache[supplyIndex]=savedSupply;
            else supplyReceivingCache.unshift(savedSupply);
        }
        writeAppDataCache('orders', ordersCache);
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) {
            switchPurchasingView('receiving', document.getElementById('purchase-card-receiving'));
        }
        alert('已更新為「待到貨」。');
    } catch (err) {
        alert('切換為已訂購失敗：' + err.message);
    } finally {
        pendingPurchaseOrderKeys.delete(actionKey);
        if (button?.isConnected) { button.disabled = false; button.textContent = originalLabel; }
    }
};
window.openOrderPurchaseDraft = async function(orderId, itemId = '') {
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    const button = [...document.querySelectorAll('#purchasePendingBody button')].find(el => {
        const action = el.getAttribute('onclick') || '';
        return action.includes('openOrderPurchaseDraft(') && action.includes(`'${orderId}'`);
    });
    if (button) { button.disabled = true; button.textContent = '開啟中…'; }
    try {
        // 待採購清單本身就是由 ordersCache 畫出來的，點擊時先直接使用同一筆資料。
        // 正式儲存 PO 的 transaction 仍會重新讀取來源訂單並 assertPurchaseLinesAvailable，
        // 因此不需要為了「開視窗」先做一個重複 Firestore read。
        let order = ordersCache.find(row => row.id === orderId) || null;
        if (!order) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('orders').doc(orderId).get(),
                '訂購單來源訂單'
            );
            if (!snapshot.exists) throw new Error('找不到來源訂單');
            order = { id:snapshot.id, ...snapshot.data() };
        }
        if (normalizedOrderStatus(order) !== 'normal') throw new Error('訂單已取消或作廢');

        let pendingItems = pendingPurchaseLines(order);
        let items = itemId ? pendingItems.filter(item => item.itemId === itemId) : pendingItems.slice(0, 1);
        if (!items.length) throw new Error('此品項已無待採購數量');

        poDirectStockMode = false;
        poEditingId = null;
        poIncomingSyncPending = false;
        poItems = items;
        poAllItems = items;
        populatePoVendorSuggestions();
        document.getElementById('poVendorName').value = '';
        document.getElementById('poBuyerName').innerText = currentUserName || currentUser?.email || '';
        document.getElementById('poDate').value = localDateString();
        switchPoCompany(bestPurchaseOrderCompany([order], items, order.company), null, true);
        generatePoNo();
        renderPoItemsTable();
        updatePoModeUI();
        updatePoSaveStatus('正在載入供應商與進貨成本…');
        document.getElementById('poModalOverlay').classList.add('active');

        // 視窗先出現，供應商／成本再補齊；只預載這次訂購單真正選到的品項。
        await Promise.all([loadSupplierWarehouseMasters(), preloadPurchaseCostsForItems(items)]);
        if (!document.getElementById('poModalOverlay')?.classList.contains('active')) return;
        pendingItems = pendingPurchaseLines(order);
        items = itemId ? pendingItems.filter(item => item.itemId === itemId) : pendingItems.slice(0, 1);
        if (!items.length) {
            closePurchaseOrderModal();
            throw new Error('此品項已無待採購數量');
        }
        poItems = items;
        poAllItems = items;
        document.getElementById('poVendorName').value = '';
        await autoFillPoSupplier(items);
        switchPoCompany(bestPurchaseOrderCompany([order], items, order.company), null, true);
        renderPoItemsTable();
        updatePoModeUI();
        updatePoSaveStatus('這張訂購單尚未建立。確認品項、廠商與單價後，即可列印 / 存為 PDF 並自動同步雲端。');
    } catch (err) { alert('無法開啟訂購單：' + err.message); }
    finally { if (button) { button.disabled = false; button.textContent = '產生訂購單'; } }
};

// 「採購訂單」列出所有已經產生過的訂購單紀錄（不分是誰產生的，只要是採購／管理員都看得到全部）
function updatePoLoadMoreButton() {
    const button = document.getElementById('poLoadMoreBtn');
    const refreshButton = document.getElementById('purchasePoRefreshBtn');
    const hasMore = purchasingView === 'receiving' ? supplyReceivingHasMore : poListHasMore;
    if (button) {
        button.style.display = hasMore ? '' : 'none';
        button.disabled = poListPageLoading;
        button.innerText = poListPageLoading ? '載入中…' : purchasingView === 'receiving' ? '載入更多待到貨資料' : '載入更多（每次 50 筆）';
    }
    if (refreshButton) {
        refreshButton.disabled = poListPageLoading;
        refreshButton.textContent = poListPageLoading ? '更新中…' : '↻ 更新';
    }
}

function mergeReceivingSourceOrdersIntoOrderCache() {
    if (!receivingSourceOrderCache.size) return;
    const mergedOrders = new Map(ordersCache.map(order => [order.id, order]));
    receivingSourceOrderCache.forEach((order, id) => mergedOrders.set(id, order));
    ordersCache = [...mergedOrders.values()]
        .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'orderDate','id'));
    writeAppDataCache('orders', ordersCache);
}

async function loadPurchaseOrderPage(reset, options = {}) {
    if (!canAccessPage('orders.po')) return;
    const deferRender = options.deferRender === true;
    if (poListPageLoading) return;
    if (reset) {
        if (purchasingView === 'receiving') {
            supplyReceivingCursor = null;
            supplyReceivingHasMore = true;
            supplyReceivingCache = [];
            receivingSourceOrderCache = new Map();
        } else {
            poListCursor = null;
            poListHasMore = true;
            if (!poListCache.length) {
                const cached = readAppDataCache('purchase-history');
                if (cached?.records?.length) poListCache = cached.records;
            }
        }
    }
    if (!poListHasMore && (purchasingView !== 'receiving' || !supplyReceivingHasMore)) return;
    poListPageLoading = true;
    const requestedRole = currentUserRole;
    const requestedView = purchasingView;
    updatePoLoadMoreButton();
    try {
        let query = poListHasMore && purchasingView !== 'receiving'
            ? db.collection('purchaseOrders').orderBy('poNo','desc').limit(DEFAULT_LIST_LIMIT)
            : null;
        if (query && poListCursor) query = query.startAfter(poListCursor);
        let supplyQuery = purchasingView === 'receiving' && supplyReceivingHasMore
            // Keep this on the single-field status index; page through mixed PO and
            // self-order documents rather than stopping at the first 50 matches.
            ? db.collection('supplyOrders').where('status','in',['ORDERED','PARTIAL_RECEIPT']).limit(DEFAULT_LIST_LIMIT)
            : null;
        if (supplyQuery && supplyReceivingCursor) supplyQuery = supplyQuery.startAfter(supplyReceivingCursor);
        const [snapshot,supplySnapshot] = await Promise.all([
            query ? firestoreReadWithTimeout(query.get(), '訂購單清單') : Promise.resolve({docs:[],size:0,empty:true}),
            supplyQuery ? firestoreReadWithTimeout(supplyQuery.get(), '待到貨供應') : Promise.resolve({docs:[],size:0,empty:true})
        ]);
        if (requestedRole !== currentUserRole || requestedView !== purchasingView || !canAccessPage('orders.po')) return;
        const freshSupply=supplySnapshot.docs.map(doc=>({id:doc.id,...doc.data()}));
        const supplyRecords=new Map((reset?[]:supplyReceivingCache).map(row=>[row.id,row]));
        freshSupply.forEach(row=>supplyRecords.set(row.id,row));
        // 倉庫型 PO 即使來源訂單取消仍待到貨；原廠直送與自行訂購維持原有篩選。
        const sourceOrderIds=purchasingView==='receiving'?[...new Set([
            ...freshSupply.map(row=>row.orderId).filter(Boolean)
        ])]:[];
        // Load More keeps earlier PO rows, so their source-order statuses must stay
        // available until the receiving list is reset.
        const nextSourceStatuses=reset?new Map():new Map(receivingSourceOrderStatusCache);
        const nextSourceOrders=reset?new Map():new Map(receivingSourceOrderCache);
        const cachedOrders=new Map(ordersCache.map(order=>[order.id,order]));
        sourceOrderIds.forEach(id=>{
            const cached=cachedOrders.get(id);
            if(!cached)return;
            nextSourceOrders.set(id,cached);
            nextSourceStatuses.set(id,normalizedOrderStatus(cached));
        });
        const missingSourceIds=sourceOrderIds.filter(id=>!nextSourceOrders.has(id));
        for(let i=0;i<missingSourceIds.length;i+=10){
            const batch=missingSourceIds.slice(i,i+10);
            const sourceSnap=await firestoreReadWithTimeout(
                db.collection('orders').where(firebase.firestore.FieldPath.documentId(),'in',batch).get(),
                '待到貨來源訂單'
            );
            sourceSnap.docs.forEach(doc=>{
                const sourceOrder={id:doc.id,...doc.data()};
                nextSourceOrders.set(doc.id,sourceOrder);
                nextSourceStatuses.set(doc.id,normalizedOrderStatus(sourceOrder));
            });
        }
        if (requestedRole !== currentUserRole || requestedView !== purchasingView || !canAccessPage('orders.po')) return;
        receivingSourceOrderStatusCache=nextSourceStatuses;
        receivingSourceOrderCache=nextSourceOrders;
        // loadPurchasingReceivingQueue() 以 deferRender 平行載入 orders + supply；
        // 該 caller 會在兩條查詢都完成後再 merge 一次，避免先 merge 後又被較晚完成的 orders refresh 覆蓋。
        // 單獨「載入更多待到貨」沒有 deferRender，仍在這裡立即 merge。
        if (!deferRender && purchasingView === 'receiving' && nextSourceOrders.size) {
            mergeReceivingSourceOrdersIntoOrderCache();
        }
        supplyReceivingCache=[...supplyRecords.values()]
            .sort((a,b)=>String(b.orderDate||'').localeCompare(String(a.orderDate||'')));
        if (!supplySnapshot.empty) supplyReceivingCursor = supplySnapshot.docs[supplySnapshot.docs.length - 1];
        if (purchasingView === 'receiving') supplyReceivingHasMore = supplySnapshot.size === DEFAULT_LIST_LIMIT;
        if (query) {
            if (!snapshot.empty) poListCursor = snapshot.docs[snapshot.docs.length - 1];
            const freshRecords = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            const records = new Map((reset ? [] : poListCache).map(po => [po.id, po]));
            freshRecords.forEach(po => records.set(po.id, po));
            // reset 時雲端結果完整取代 stale cache；Load More 才追加。
            poListCache = [...records.values()].sort((a, b) => (b.poNo || '').localeCompare(a.poNo || ''));
            poListHasMore = snapshot.size === DEFAULT_LIST_LIMIT;
            writeAppDataCache('purchase-history', poListCache);
        }
        if (!deferRender) {
            if (purchasingView === 'receiving') renderPurchasingView();
            else renderPoList();
        }
    } catch (err) {
        console.error('讀取訂購單／待到貨資料失敗：', err);
        const message = err?.message || String(err || '未知錯誤');
        alert('讀取訂購單／待到貨資料失敗：' + message);
    } finally {
        poListPageLoading = false;
        updatePoLoadMoreButton();
    }
}

window.loadMyPurchaseOrders = function() {
    return purchasingView === 'receiving'
        ? loadPurchasingReceivingQueue(true)
        : loadPurchaseOrderPage(true);
};

window.loadMorePurchaseOrders = function() {
    return loadPurchaseOrderPage(false);
};

function waitingDaysFromDate(date) {
    const raw = String(date || '').trim();
    const match = raw.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
    if (!match) return '';
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const start = new Date(year, month - 1, day);
    if (start.getFullYear() !== year || start.getMonth() !== month - 1 || start.getDate() !== day) return '';
    const today = new Date();
    const startDay = Date.UTC(year, month - 1, day);
    const todayDay = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    return Math.max(0, Math.round((todayDay - startDay) / 86400000)) + ' 天';
}

function poWaitingDays(po) {
    return waitingDaysFromDate(po.poDate);
}

function purchaseOrderSearchTokens(po={}) {
    const values=[
        po.poNo,po.vendorName,po.buyerName,po.company,po.poDate,
        ...(Array.isArray(po.items)?po.items.flatMap(item=>[item.itemCode,item.itemName,item.brand,item.orderNo,item.orderId]):[])
    ];
    const tokens=new Set();
    for(const raw of values){
        const normalized=normalizeFullHistorySearchValue(raw);
        if(!normalized)continue;
        tokens.add(normalized);
        const maxGram=Math.min(6,normalized.length);
        for(let size=1;size<=maxGram;size++){
            for(let i=0;i+size<=normalized.length;i++){
                tokens.add(normalized.slice(i,i+size));
                if(tokens.size>=300)return [...tokens];
            }
        }
    }
    return [...tokens];
}

function purchaseOrderHistoryMatches(po, keyword) {
    const needle=normalizeFullHistorySearchValue(keyword);
    if(!needle)return true;
    const values=[
        po.poNo,po.vendorName,po.buyerName,po.company,po.poDate,
        ...purchaseItemsFromSavedPo(po).flatMap(item=>[item.itemCode,item.itemName,item.brand,item.orderNo,item.orderId])
    ];
    return values.some(value=>normalizeFullHistorySearchValue(value).includes(needle));
}

window.schedulePurchaseOrderHistorySearch = function() {
    clearTimeout(poHistorySearchTimer);
    poHistorySearchTimer=scheduleListSearch(poHistorySearchTimer,()=>runPurchaseOrderHistorySearch());
};

async function runPurchaseOrderHistorySearch() {
    const generation = ++poHistorySearchGeneration;
    if(purchasingView!=='history')return renderPoList();
    const keyword=document.getElementById('poListSearch')?.value||'';
    const status=document.getElementById('poHistorySearchStatus');
    const normalized=normalizeFullHistorySearchValue(keyword);
    if(!normalized){
        poHistorySearchActive=false;poHistorySearchResults=[];poHistorySearchLoading=false;
        if(status)status.textContent='';
        renderPoList();return;
    }
    poHistorySearchLoading=true;poHistorySearchActive=true;poHistorySearchResults=[];
    const results=new Map();
    if(status)status.textContent='正在搜尋全部採購單…';
    renderPoList();
    try{
        // searchTokens 先把候選資料縮小，再逐頁讀完所有候選，避免只搜尋目前畫面的 50 筆。
        // 這不是掃描整個 collection；只有符合索引 token 的文件會被讀取。
        const token=fullHistoryServerToken(keyword);
        let checked=0;
        let cursor=null;
        if(token){
            while(true){
                let query=db.collection('purchaseOrders')
                    .where('searchTokens','array-contains',token)
                    .limit(DEFAULT_LIST_LIMIT);
                if(cursor)query=query.startAfter(cursor);
                const snapshot=await firestoreReadWithTimeout(query.get(),'訂購單索引搜尋');
                if(generation!==poHistorySearchGeneration)return;
                checked+=snapshot.size;
                snapshot.docs.forEach(doc=>{
                    const po={id:doc.id,...doc.data()};
                    if(purchaseOrderHistoryMatches(po,keyword))results.set(po.id,po);
                });
                poHistorySearchResults=[...results.values()].sort((a,b)=>(b.poNo||'').localeCompare(a.poNo||''));
                renderPoList();
                if(status)status.textContent=`全歷史搜尋中：已檢查 ${checked} 筆候選資料，找到 ${results.size} 筆…`;
                if(snapshot.size<DEFAULT_LIST_LIMIT)break;
                cursor=snapshot.docs[snapshot.docs.length-1];
            }
        }
        if(generation!==poHistorySearchGeneration)return;
        if(status)status.textContent=`全歷史搜尋完成：找到 ${results.size} 筆`;
    }catch(err){
        if(generation!==poHistorySearchGeneration)return;
        console.error('訂購單全歷史搜尋失敗：',err);
        if(status)status.textContent='搜尋失敗，請重試';
    }finally{
        if(generation===poHistorySearchGeneration){
            poHistorySearchLoading=false;
            renderPoList();
        }
    }
}

function receivingSourceOrderForItem(item, orderById = null) {
    if (!item?.orderId) return null;
    return orderById?.get(item.orderId)
        || receivingSourceOrderCache.get(item.orderId)
        || ordersCache.find(order=>order.id===item.orderId)
        || null;
}

function receivingEvidenceEntry(supply) {
    const ordered = Math.max(0, Number(supply?.qty || 0));
    const received = Math.max(0, Number(supply?.receivedQty || 0));
    const remaining = Math.max(0, ordered - received);
    if (!supply?.id || remaining <= 0) return null;
    return {
        type:'supply', id:supply.id,
        label:supply.purchaseDocumentNo || supply.internalNo || supply.id,
        progress:{ordered,received,remaining,directShip:(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'}
    };
}

function buildReceivingEvidenceIndex() {
    const index = new Map();
    const add = (key, entry) => {
        if (!key || !entry) return;
        if (!index.has(key)) index.set(key, []);
        index.get(key).push(entry);
    };
    supplyReceivingCache.forEach(supply => {
        if (!supply?.orderId) return;
        const entry = receivingEvidenceEntry(supply);
        if (!entry) return;
        if (supply.itemId) add(`${supply.orderId}::id:${supply.itemId}`, entry);
        const sourceIndex = Number(supply.orderItemIndex);
        if (Number.isFinite(sourceIndex)) add(`${supply.orderId}::idx:${sourceIndex}`, entry);
    });
    return index;
}

function receivingEvidenceForWorkItem(order, item, itemIndex, evidenceIndex = null) {
    if (evidenceIndex) {
        const matches = [
            ...(item?.itemId ? (evidenceIndex.get(`${order.id}::id:${item.itemId}`) || []) : []),
            ...(evidenceIndex.get(`${order.id}::idx:${Number(itemIndex)}`) || [])
        ];
        return [...new Map(matches.map(entry => [entry.id, entry])).values()];
    }
    const evidence = [];
    supplyReceivingCache.forEach(supply => {
        if (!supply?.orderId || supply.orderId !== order.id) return;
        const sameItem = (supply.itemId && item.itemId && supply.itemId === item.itemId)
            || Number(supply.orderItemIndex) === Number(itemIndex);
        if (!sameItem) return;
        const entry = receivingEvidenceEntry(supply);
        if (entry) evidence.push(entry);
    });
    return evidence;
}

function manualSupplyCancelActionHtml(supply) {
    if (!supply || supply.type !== 'PURCHASING_MANUAL') return '';
    if (!canCreatePurchaseOrderCapability()) return '';
    if (String(supply.status || '').toUpperCase() === 'CANCELLED') return '';
    const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
    if (remaining <= 0) return '';
    const key = `supply:${supply.id}`;
    const pending = purchaseCancellationInProgress.has(key);
    return `<button type="button" class="btn-small danger-menu-item" onclick="cancelManualSupplyOutstanding('${escapeAttr(supply.id)}')" ${pending ? 'disabled' : ''}>${pending ? '取消中…' : '取消未到貨'}</button>`;
}

function receivingWorkProgress(order, item) {
    const directShip = (item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
    const orderedQty = Math.max(0, Number(item.orderedQty ?? item.qty ?? 0));
    const shortage = Math.max(0, Number(item.shortageQty || 0));
    const supplyOrdered = Math.max(0, Number(item.supplyOrderedQty || 0));
    const received = Math.max(0, Number(item.receivedQty || 0));
    const target = directShip ? orderedQty : Math.max(shortage, supplyOrdered);
    return { target, received:Math.min(target, received), remaining:Math.max(0, target - received), directShip };
}

function renderPurchasingReceivingWorkList(normalizedItemsByOrder = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const tbody = document.getElementById('poListBody');
    const head = document.getElementById('poListHeadRow');
    const emptyHint = document.getElementById('poListEmptyHint');
    const status = document.getElementById('poHistorySearchStatus');
    if (!tbody) return;
    if (head) head.innerHTML = '<th>訂單日期</th><th>客戶</th><th>負責業務</th><th>待到貨品項</th><th>到貨進度</th><th class="no-print">操作</th>';
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();

    const filters = filterContext || purchaseFilterContext();
    let workCount = 0;
    let missingEvidence = 0;
    let evidenceCount = 0;
    let standaloneSupplyCount = 0;
    const representedSupplyIds = new Set();
    const evidenceIndex = buildReceivingEvidenceIndex();
    const supplyById = new Map(supplyReceivingCache.map(supply => [supply.id, supply]));
    const orderById = new Map(ordersCache.map(order => [order.id, order]));

    ordersCache.forEach(order => {
        const items = normalizedItemsByOrder?.get(order.id) || normalizedOrderItems(order);
        const lifecycle = lifecyclesByOrder?.get(order.id) || orderLifecycleInfo(order, items);
        if (lifecycle.status !== 'normal') return;
        const orderDispatchStates = dispatchStatesByOrder?.get(order.id) || null;
        items.forEach((item, itemIndex) => {
            const dispatch = orderDispatchStates?.get(item) || itemDispatchState(order, item);
            if (!orderItemDisplayCategories(order, item, lifecycle, dispatch).includes('arrival')) return;
            if (!purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters)) return;
            workCount++;
            const progress = receivingWorkProgress(order, item);
            const evidence = receivingEvidenceForWorkItem(order, item, itemIndex, evidenceIndex);
            evidence.forEach(entry => representedSupplyIds.add(entry.id));
            evidenceCount += evidence.length;
            if (!evidence.length) missingEvidence++;

            const actionHtml = !canReceiveInventoryCapability()
                ? '<span class="order-progress-badge">唯讀</span>'
                : evidence.length
                    ? evidence.map((entry, index) => {
                        const suffix = evidence.length > 1 ? ` ${index + 1}/${evidence.length}` : '';
                        const supply = supplyById.get(entry.id);
                        const receiveButton = `<button type="button" class="btn-small btn-secondary" onclick="openSupplyReceipt('${escapeAttr(entry.id)}')">📥 到貨入庫${suffix}</button>`;
                        return [receiveButton, manualSupplyCancelActionHtml(supply)].filter(Boolean).join(' ');
                    }).join(' ')
                    : '<span class="order-progress-badge order-progress-warning">找不到採購紀錄</span>';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td data-th="訂單日期">${escapeHtml(order.orderDate || '')}</td>
                <td data-th="客戶">${escapeHtml(order.customer || order.customerName || '')}</td>
                <td data-th="負責業務">${escapeHtml(order.salesName || '')}</td>
                <td data-th="待到貨品項">${escapeHtml(item.itemCode || item.itemName || item.itemId || '未命名品項')} × ${progress.target}</td>
                <td data-th="到貨進度">${progress.received > 0 ? `部分到貨 ${progress.received}/${progress.target}` : `待到貨 0/${progress.target}`}</td>
                <td data-th="操作" class="no-print">${actionHtml}</td>`;
            fragment.appendChild(tr);
        });
    });

    // 沒有對應到「正常訂單待到貨工作」的供應紀錄仍可能是真實在途：
    // 例如庫存補貨，或客戶訂單取消後供應商仍照常出貨。這些不可從採購頁消失。
    supplyReceivingCache.forEach(supply => {
        if (representedSupplyIds.has(supply.id)) return;
        const ordered = Math.max(0, Number(supply.qty || 0));
        const received = Math.max(0, Number(supply.receivedQty || 0));
        const remaining = Math.max(0, ordered - received);
        if (remaining <= 0) return;

        const sourceOrder = receivingSourceOrderForItem(supply, orderById);
        const sourceStatus = sourceOrder ? normalizedOrderStatus(sourceOrder) : '';
        const directShip = (supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
        const date = sourceOrder?.orderDate || supply.orderDate || '';
        const salesName = sourceOrder?.salesName || supply.salesName || supply.createdBy || '';
        const brand = supply.brand || '';
        if (!purchaseLineMatchesFilters(date, salesName, brand, filters)) return;

        // 已取消訂單的原廠直送沒有倉庫可承接，因此只能顯示警示、不可確認到貨。
        const blockedDirectShip = directShip && sourceOrder && sourceStatus !== 'normal';
        const cancelAction = manualSupplyCancelActionHtml(supply);
        const actionHtml = !canReceiveInventoryCapability()
            ? '<span class="order-progress-badge">唯讀</span>'
            : blockedDirectShip
                ? ['<span class="order-progress-badge order-progress-warning">來源訂單已取消，直送不可確認</span>', cancelAction].filter(Boolean).join(' ')
                : [
                    `<button type="button" class="btn-small btn-secondary" onclick="openSupplyReceipt('${escapeAttr(supply.id)}')">${directShip ? '確認直送到貨' : '📥 到貨入庫'}</button>`,
                    cancelAction
                ].filter(Boolean).join(' ');

        const customerLabel = sourceOrder?.customerName || sourceOrder?.customer || supply.customerName
            || (supply.orderId ? '來源訂單' : '庫存補貨');
        const sourceLabel = sourceOrder && sourceStatus !== 'normal'
            ? '來源訂單已取消，貨到後轉為可用庫存'
            : !supply.orderId
                ? '庫存補貨'
                : sourceOrder
                    ? '待到貨'
                    : '供應紀錄';
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-th="訂單日期">${escapeHtml(date)}</td>
            <td data-th="客戶">${escapeHtml(customerLabel)}</td>
            <td data-th="負責業務">${escapeHtml(salesName)}</td>
            <td data-th="待到貨品項">${escapeHtml(supply.itemCode || supply.itemName || supply.id)} × ${ordered}</td>
            <td data-th="到貨進度">${escapeHtml(sourceLabel)}｜${received > 0 ? `部分到貨 ${received}/${ordered}` : `待到貨 0/${ordered}`}</td>
            <td data-th="操作" class="no-print">${actionHtml}</td>`;
        fragment.appendChild(tr);
        standaloneSupplyCount++;
    });

    tbody.appendChild(fragment);

    const totalRows = workCount + standaloneSupplyCount;
    if (emptyHint) {
        emptyHint.style.display = totalRows === 0 ? 'block' : 'none';
        emptyHint.textContent = !purchasingReceivingReady ? '正在載入待到貨工作…' : '目前沒有待到貨品項。';
    }
    if (status) {
        if (!purchasingReceivingReady) status.textContent = `待到貨工作 ${workCount} 個；採購資料載入中…`;
        else {
            const parts = [`待到貨 ${workCount} 個訂單品項`];
            if (standaloneSupplyCount) parts.push(`另有 ${standaloneSupplyCount} 筆庫存補貨／非正常訂單供應`);
            if (evidenceCount > workCount) parts.push(`其中 ${evidenceCount - workCount} 筆為分批／多張採購來源，已合併在同一品項顯示`);
            if (missingEvidence) parts.push(`${missingEvidence} 個品項尚未找到可操作的採購紀錄`);
            status.textContent = parts.join('。');
        }
    }
}

window.renderPoList = function(normalizedItemsByOrder = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    if (purchasingView === 'receiving') {
        renderPurchasingReceivingWorkList(normalizedItemsByOrder, filterContext, dispatchStatesByOrder, lifecyclesByOrder);
        updatePoLoadMoreButton();
        return;
    }
    const head = document.getElementById('poListHeadRow');
    if (head) head.innerHTML = '<th>單號</th><th>公司</th><th>抬頭（廠商）</th><th>採購人員</th><th>訂購日期</th><th>建立天數</th><th>品項</th><th>總計金額</th><th>文件狀態</th><th class="no-print">操作</th>';
    const tbody = document.getElementById('poListBody');
    const searchInput = document.getElementById('poListSearch');
    if (!tbody || !searchInput) return;
    const keyword = (searchInput.value || '').toLowerCase();
    const filters = filterContext || purchaseFilterContext();
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    const poRows = poHistorySearchActive ? poHistorySearchResults : poListCache;
    poRows.forEach(po => {
        // 全歷史搜尋已在資料層比對單號、廠商、採購人員與品項；歷史搜尋模式不可再用較窄欄位二次過濾。
        if (!poHistorySearchActive) {
            const searchable = `${po.poNo || ''} ${po.vendorName || ''} ${po.buyerName || ''}`.toLowerCase();
            if (keyword && !searchable.includes(keyword)) return;
        }

        const items = purchaseItemsFromSavedPo(po);
        const companyInfo = companyData[po.company];
        const companyLabel = companyInfo ? `${companyInfo.title}（${companyInfo.prefix}）` : (po.company || '');

        const poCancelled=String(po.status||'').toUpperCase()==='CANCELLED';
        items.forEach((item,itemIndex)=>{
            const ordered=Math.max(0,Number(item.qty||0));
            if (!purchaseLineMatchesFilters(po.poDate, item.salesName, item.brand, filters)) return;
            shown++;
            const itemTotal=Math.round(ordered*Number(item.unitPrice||0)*1.05);
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td data-th="單號">${escapeHtml(po.poNo || '')}</td>
                <td data-th="公司">${escapeHtml(companyLabel)}</td>
                <td data-th="廠商">${escapeHtml(po.vendorName || '')}</td>
                <td data-th="採購人員">${escapeHtml(po.buyerName || '')}</td>
                <td data-th="訂購日期">${escapeHtml(po.poDate || '')}</td>
                <td data-th="建立天數">${escapeHtml(poWaitingDays(po)||'—')}</td>
                <td data-th="品項數">${escapeHtml(item.itemCode||item.itemName||'單一品項')} × ${ordered}</td>
                <td data-th="總計金額">${itemTotal.toLocaleString()}</td>
                <td data-th="文件狀態">${poCancelled?'未到貨已取消':'已建立'}</td>
                <td data-th="操作" class="no-print">${itemIndex===0?`
                    <div class="po-list-action-row">
                        <button type="button" class="btn-small" onclick="reprintPurchaseOrder('${escapeAttr(po.id)}')">載入</button>
                        <button type="button" class="btn-small btn-secondary" onclick="exportPurchaseOrderFromHistory('${escapeAttr(po.id)}')">PDF</button>
                        <details class="po-more-menu">
                            <summary class="btn-small btn-secondary">更多</summary>
                            <div class="po-more-menu-popover">
                                ${(po.purchaseType==='stock'||items.every(line=>!line.orderId))?`<button type="button" onclick="copySavedPurchaseOrderAsNew('${escapeAttr(po.id)}')">複製成新訂購單</button>`:''}
                                <button type="button" onclick="reprintPurchaseOrder('${escapeAttr(po.id)}')">查看正式內容</button>
                                ${canCreatePurchaseOrderCapability()&&!poCancelled?`<button type="button" class="danger-menu-item" onclick="cancelPurchaseOrderOutstanding('${escapeAttr(po.id)}')">取消未到貨</button>`:''}
                            </div>
                        </details>
                    </div>`:'—'}</td>
            `;
            fragment.appendChild(tr);
        });
    });


    tbody.appendChild(fragment);

    const emptyHint = document.getElementById('poListEmptyHint');
    if (emptyHint) {
        emptyHint.style.display = shown === 0 ? 'block' : 'none';
        emptyHint.textContent = '目前還沒有產生過任何訂購單。';
    }
};

// 把「採購訂單」裡一筆舊的訂購單紀錄，重新載回訂購單視窗，維持原本的單號，方便再列印一次
async function purchaseIncomingSyncPending(po) {
    if (String(po?.status || '').toUpperCase() === 'CANCELLED') return false;
    const supplyIds = Array.isArray(po?.supplyOrderIds) ? po.supplyOrderIds.filter(Boolean) : [];
    if (!supplyIds.length) return false;
    const supplies = await readDocumentsByIds('supplyOrders', supplyIds);
    if (supplies.length !== new Set(supplyIds).size) return true;
    return supplies.some(supply => {
        if (String(supply.status || '').toUpperCase() === 'CANCELLED') return false;
        if ((supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return false;
        const targetQty = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
        const registeredQty = Math.max(0, Number(supply.incomingRegisteredQty || 0));
        return registeredQty < targetQty;
    });
}

window.reprintPurchaseOrder = async function(poId) {
    poDirectStockMode = false;
    poNoGeneration++;
    poNoLoading = false;
    poNoReady = true;
    const po = poListCache.find(p => p.id === poId);
    if (!po) return;

    populatePoVendorSuggestions();
    poItems = purchaseItemsFromSavedPo(po);
    poAllItems = poItems;
    poEditingId = po.id;
    poIncomingSyncPending = false;
    switchPoCompany(po.company || 'yushin', null, true);

    document.getElementById('poVendorName').value = po.vendorName || '';
    document.getElementById('poBuyerName').innerText = po.buyerName || '';
    document.getElementById('poDate').value = po.poDate || '';
    document.getElementById('poNo').innerText = po.poNo || '';

    renderPoItemsTable();
    updatePoModeUI();
    document.getElementById('poModalOverlay').classList.add('active');

    if (String(po.status || '').toUpperCase() === 'CANCELLED') {
        poIncomingSyncPending = false;
        updatePoSaveStatus(`訂購單 ${po.poNo || po.id} 的未到貨數量已取消；此文件僅供查閱或重新輸出 PDF，不會重新增加在途庫存。`);
        updatePoSaveButton();
        return;
    }

    poSaveInProgress = true;
    updatePoSaveStatus(`正在確認訂購單 ${po.poNo || po.id} 的在途同步狀態…`);
    updatePoSaveButton();
    try {
        poIncomingSyncPending = await purchaseIncomingSyncPending(po);
        updatePoSaveStatus(poIncomingSyncPending
            ? `訂購單 ${po.poNo || po.id} 已同步雲端，但供應紀錄仍需同步在途庫存。`
            : `訂購單 ${po.poNo || po.id} 已同步雲端。按下方按鈕即可再次列印或輸出 PDF。`);
    } catch (err) {
        poIncomingSyncPending = true;
        updatePoSaveStatus(`無法確認供應紀錄的在途同步狀態：${err.message}`, true);
    } finally {
        poSaveInProgress = false;
        updatePoSaveButton();
    }
};

window.copySavedPurchaseOrderAsNew = async function(poId) {
    const po = poListCache.find(item => item.id === poId);
    if (!po) return alert('找不到這張訂購單，請重新整理。');

    const sourceItems = purchaseItemsFromSavedPo(po);
    if (po.purchaseType !== 'stock' && sourceItems.some(item => item.orderId)) {
        alert('這張訂購單連結客戶訂單，為避免重複採購，請回到「待採購」從來源訂單建立新的訂購單。');
        return;
    }

    poDirectStockOpenGeneration++;
    poDirectStockMode = true;
    poEditingId = null;
    poIncomingSyncPending = false;
    poAllItems = sourceItems.map(item => ({
        ...item,
        orderId: '',
        itemId: '',
        orderItemIndex: 0,
        supplyOrderId: '',
        purchaseDocumentNo: '',
        purchaseDocumentNos: []
    }));
    poItems = poAllItems.map(item => ({ ...item }));

    populatePoVendorSuggestions();
    switchPoCompany(po.company || 'yushin', null, true);
    document.getElementById('poVendorName').value = po.vendorName || '';
    document.getElementById('poBuyerName').innerText = currentUserName || currentUser?.email || '';
    document.getElementById('poDate').value = localDateString();
    await generatePoNo();
    renderPoItemsTable();
    updatePoModeUI();
    updatePoSaveStatus('已複製成新的庫存採購訂購單；確認數量、單價與廠商後再匯出 PDF。');
    document.getElementById('poModalOverlay').classList.add('active');
};

window.exportPurchaseOrderFromHistory = async function(poId) {
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '準備 PDF…');
    if (button && !buttonState) return;
    try {
        await reprintPurchaseOrder(poId);
        await printPurchaseOrder();
    } catch (err) {
        console.error('重新匯出訂購單 PDF 失敗：', err);
        alert('重新匯出訂購單 PDF 失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
};

// 從原始訂單上的訂購單號直接開啟該張訂購單，避免還要切分頁搜尋。
window.openPurchaseOrderFromOrder = async function(poNo) {
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '開啟中…');
    if (button && !buttonState) return;
    const open = async po => {
        if (!po) { alert('找不到這張訂購單紀錄。'); return; }
        if (!poListCache.some(item => item.id === po.id)) poListCache.push(po);
        await reprintPurchaseOrder(po.id);
    };
    try {
        const cached = poListCache.find(po => po.poNo === poNo || po.id === poNo);
        if (cached) {
            await open(cached);
            return;
        }
        const doc = await firestoreReadWithTimeout(
            db.collection('purchaseOrders').doc(poNo).get(),
            '訂購單紀錄'
        );
        await open(doc.exists ? { id: doc.id, ...doc.data() } : null);
    } catch (err) {
        alert('讀取訂購單失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
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
let poIncomingSyncPending = false;
let poNoGeneration = 0;
let poDirectStockOpenGeneration = 0;
let poNoReady = false;
let poNoLoading = false;
const purchaseCancellationInProgress = new Set();

function updatePoSaveStatus(message = '', isError = false) {
    const status = document.getElementById('poSaveStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#b42318' : '#12502b';
}

function updatePoSaveButton() {
    const button = document.getElementById('printPurchaseOrderBtn');
    if (!button) return;
    const waitingForNumber = !poEditingId && !poNoReady;
    button.disabled = poSaveInProgress || waitingForNumber;
    button.textContent = waitingForNumber
        ? (poNoLoading ? '產生單號中…' : '單號未就緒')
        : '📄 匯出 PDF（自動同步雲端）';
}

function poIncomingKey(item) {
    return String(item.productId || (item.itemCode ? `code:${normalizeHistoryItemCode(item.itemCode)}` : '')).trim();
}
async function registerPurchaseIncoming(poId, poRecord) {
    if (String(poRecord?.status || '').toUpperCase() === 'CANCELLED') return;
    const supplyIds = Array.isArray(poRecord?.supplyOrderIds) ? poRecord.supplyOrderIds : [];
    for (const supplyId of supplyIds) {
        await db.runTransaction(async tx => {
            const supplyRef = db.collection('supplyOrders').doc(supplyId);
            const supplySnap = await tx.get(supplyRef);
            if (!supplySnap.exists) throw new Error(`找不到供應紀錄 ${supplyId}`);
            const supply = supplySnap.data();
            if (String(supply.status || '').toUpperCase() === 'CANCELLED') return;
            if ((supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return;

            const key = String(supply.productKey || supply.productId || '').trim();
            const warehouseId = String(supply.warehouseId || defaultWarehouse()?.id || '').trim();
            if (!key || !warehouseId) throw new Error(`供應紀錄 ${supplyId} 缺少產品或倉庫資料`);

            const targetQty = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
            const registeredQty = Math.max(0, Number(supply.incomingRegisteredQty || 0));
            const delta = targetQty - registeredQty;
            if (!delta) return;

            const invRef = db.collection('inventory').doc(encodeURIComponent(key));
            const whRef = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key));
            const invSnap = await tx.get(invRef);
            const whSnap = await tx.get(whRef);
            const inv = inventoryNumbers(invSnap.exists ? invSnap.data() : {});
            const wh = inventoryNumbers(whSnap.exists ? whSnap.data() : {});
            const now = new Date().toISOString();

            if (invSnap.exists) {
                tx.set(invRef,{incoming:Math.max(0,inv.incoming+delta),updatedAt:now},{merge:true});
            } else {
                const nextInventory={
                    productKey:key,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',
                    brand:resolveBrandName(supply.brand||''),onHand:0,reserved:0,incoming:Math.max(0,delta),lots:[],updatedAt:now
                };
                nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
                tx.set(invRef,nextInventory,{merge:true});
            }
            tx.set(whRef,{
                warehouseId,productKey:key,productId:supply.productId||'',itemCode:supply.itemCode||'',
                itemName:supply.itemName||'',brand:resolveBrandName(supply.brand||''),
                onHand:wh.onHand,reserved:wh.reserved,incoming:Math.max(0,wh.incoming+delta),updatedAt:now
            },{merge:true});
            tx.update(supplyRef,{incomingRegisteredQty:targetQty,incomingRegisteredAt:now,updatedAt:now});
            tx.set(db.collection('inventoryMovements').doc(),{
                type:'purchase_incoming',qty:delta,productKey:key,warehouseId,
                fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:supplyId,
                purchaseDocumentId:poId,createdAt:now,createdBy:currentUserName||currentUser?.email||''
            });
        });
        const supply = poRecord.items?.[Number(String(supplyId).split('-').pop())];
        const key = poIncomingKey(supply || {});
        const warehouseId = supply?.warehouseId || defaultWarehouse()?.id || '';
        if (key && warehouseId) invalidateWarehouseStockCache(key,warehouseId);
    }
}

async function cancelOutstandingSupplyRecord(poId, supplyId, reason) {
    let result={cancelledQty:0,orderId:'',productKey:'',warehouseId:''};
    await db.runTransaction(async tx => {
        const supplyRef=db.collection('supplyOrders').doc(supplyId);
        const supplySnap=await tx.get(supplyRef);
        if(!supplySnap.exists)throw new Error(`找不到供應紀錄 ${supplyId}`);
        const supply=supplySnap.data()||{};
        const ordered=Math.max(0,Number(supply.qty||0));
        const received=Math.min(ordered,Math.max(0,Number(supply.receivedQty||0)));
        const remaining=Math.max(0,ordered-received);
        const existingCancelled=String(supply.status||'').toUpperCase()==='CANCELLED';
        const productKey=String(supply.productKey||supply.productId||'').trim();
        const warehouseId=String(supply.warehouseId||'').trim();
        result={
            cancelledQty:existingCancelled?Math.max(0,Number(supply.cancelledQty||remaining)):0,
            orderId:String(supply.orderId||''),
            productKey,
            warehouseId
        };
        if(existingCancelled||remaining<=0)return;

        const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        const registeredIncoming=Math.max(0,Number(supply.incomingRegisteredQty||0));
        const orderRef=supply.orderId?db.collection('orders').doc(supply.orderId):null;
        const invRef=!directShip&&registeredIncoming>0&&productKey
            ? db.collection('inventory').doc(encodeURIComponent(productKey)):null;
        const whRef=!directShip&&registeredIncoming>0&&productKey&&warehouseId
            ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)):null;

        const orderSnap=orderRef?await tx.get(orderRef):null;
        const invSnap=invRef?await tx.get(invRef):null;
        const whSnap=whRef?await tx.get(whRef):null;
        if(!directShip&&registeredIncoming>0&&(!productKey||!warehouseId||!invSnap?.exists||!whSnap?.exists)){
            throw new Error(`供應紀錄 ${supplyId} 的在途庫存資料不完整，無法安全取消。`);
        }

        const now=new Date().toISOString();
        if(orderSnap?.exists){
            const order=orderSnap.data();
            const items=normalizedOrderItems(order);
            const itemIndex=items.findIndex(item=>String(item.itemId||'')===String(supply.itemId||''));
            if(itemIndex<0)throw new Error(`來源訂單找不到供應紀錄 ${supplyId} 對應品項。`);
            const item=items[itemIndex];
            const currentSupplyOrdered=Math.max(0,Number(item.supplyOrderedQty||0));
            const receivedForItem=Math.max(0,Number(item.receivedQty||0));
            items[itemIndex]={
                ...item,
                supplyOrderedQty:Math.max(receivedForItem,currentSupplyOrdered-remaining)
            };
            const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
            tx.update(orderRef,{
                items,itemCount:items.length,orderSchemaVersion:2,
                ...orderWorkIndexFields(nextOrder),updatedAt:now
            });
        }

        if(invRef&&whRef){
            const inv=inventoryNumbers(invSnap.data());
            const wh=inventoryNumbers(whSnap.data());
            tx.update(invRef,{incoming:Math.max(0,inv.incoming-registeredIncoming),updatedAt:now});
            tx.update(whRef,{incoming:Math.max(0,wh.incoming-registeredIncoming),updatedAt:now});
            tx.set(db.collection('inventoryMovements').doc(),{
                type:'purchase_incoming_cancel',
                qty:-registeredIncoming,
                productKey,warehouseId,
                fulfillmentType:'WAREHOUSE',
                sourceType:'SUPPLY_ORDER',
                sourceId:supplyId,
                purchaseDocumentId:poId,
                reason,
                ownerUid:supply.ownerUid||'',
                salesCode:supply.salesCode||'',
                createdAt:now,
                createdBy:currentUserName||currentUser?.email||''
            });
        }

        tx.update(supplyRef,{
            status:'CANCELLED',
            cancelledQty:remaining,
            cancelReason:reason,
            cancelledAt:now,
            cancelledByUid:currentUser?.uid||'',
            cancelledBy:currentUserName||currentUser?.email||'',
            incomingRegisteredQty:0,
            updatedAt:now
        });
        result={cancelledQty:remaining,orderId:String(supply.orderId||''),productKey,warehouseId};
    });
    if(result.productKey&&result.warehouseId)invalidateWarehouseStockCache(result.productKey,result.warehouseId);
    return result;
}

window.cancelManualSupplyOutstanding = async function(supplyId) {
    if (!canCreatePurchaseOrderCapability()) {
        alert('只有管理員或採購可以取消快速採購的未到貨數量。');
        return;
    }
    const actionKey = `supply:${supplyId}`;
    if (purchaseCancellationInProgress.has(actionKey)) return;

    let supply;
    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('supplyOrders').doc(supplyId).get(),
            '讀取快速採購狀態'
        );
        if (!snapshot.exists) throw new Error('找不到這筆供應紀錄。');
        supply = { id:snapshot.id, ...snapshot.data() };
    } catch (err) {
        alert('無法讀取快速採購紀錄：' + (err?.message || err));
        return;
    }

    if (supply.type !== 'PURCHASING_MANUAL') {
        alert('這筆供應紀錄不是快速採購，請從對應的正式訂購單處理。');
        return;
    }
    if (String(supply.status || '').toUpperCase() === 'CANCELLED') {
        showActionFeedback('這筆快速採購的未到貨數量已取消。', 'success');
        return;
    }
    const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
    if (remaining <= 0) {
        alert('這筆快速採購已全部到貨，沒有可取消的未到貨數量。');
        return;
    }

    const reasonRaw = prompt(
        `取消快速採購 ${supply.internalNo || supply.id} 尚未到貨的 ${remaining} 個。\n已實際到貨的數量不會回沖，原訂單會重新出現尚需採購的數量。\n\n請輸入取消原因：`
    );
    if (reasonRaw === null) return;
    const reason = String(reasonRaw || '').trim();
    if (!reason) {
        alert('請填寫取消原因，方便後續追蹤。');
        return;
    }

    purchaseCancellationInProgress.add(actionKey);
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
    try {
        const result = await cancelOutstandingSupplyRecord(
            supply.internalNo || supply.id,
            supply.id,
            reason
        );
        supplyReceivingCache = supplyReceivingCache.filter(row => row.id !== supply.id);
        if (result.orderId) await refreshAffectedOrderCaches([result.orderId]);
        else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        showActionFeedback(
            `已取消快速採購 ${supply.internalNo || supply.id} 未到貨數量 ${result.cancelledQty || remaining}；在途庫存已同步。`,
            'success'
        );
    } catch (err) {
        console.error('取消快速採購未到貨失敗：', err);
        alert('取消快速採購失敗：' + (err?.message || err) + '。可以重新執行；已成功的異動不會重複扣除。');
    } finally {
        purchaseCancellationInProgress.delete(actionKey);
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
    }
};

window.cancelPurchaseOrderOutstanding = async function(poId) {
    if(!canCreatePurchaseOrderCapability()){alert('只有管理員或採購可以取消訂購單未到貨數量。');return;}
    if(purchaseCancellationInProgress.has(poId))return;
    const cached=poListCache.find(po=>po.id===poId)||poHistorySearchResults.find(po=>po.id===poId);
    let po=cached;
    try{
        const fresh=await firestoreReadWithTimeout(db.collection('purchaseOrders').doc(poId).get(),'讀取訂購單取消狀態');
        if(!fresh.exists)throw new Error('找不到這張訂購單。');
        po={id:fresh.id,...fresh.data()};
    }catch(err){
        alert('無法讀取訂購單：'+(err?.message||err));
        return;
    }
    if(String(po.status||'').toUpperCase()==='CANCELLED'){
        showActionFeedback('這張訂購單的未到貨數量已取消。','success');
        return;
    }
    const reasonRaw=prompt(`取消訂購單 ${po.poNo||po.id} 尚未到貨的數量。\n已實際到貨的數量不會回沖；原訂單會重新出現尚需採購的數量。\n\n請輸入取消原因：`);
    if(reasonRaw===null)return;
    const reason=String(reasonRaw||'').trim();
    if(!reason){alert('請填寫取消原因，方便後續追蹤。');return;}
    const supplyIds=Array.isArray(po.supplyOrderIds)?po.supplyOrderIds.filter(Boolean):[];
    if(!supplyIds.length){alert('這張訂購單沒有可追蹤的供應紀錄，無法安全取消。');return;}

    purchaseCancellationInProgress.add(poId);
    try{
        let cancelledQty=0;
        const affectedOrderIds=new Set();
        for(const supplyId of supplyIds){
            const result=await cancelOutstandingSupplyRecord(poId,supplyId,reason);
            cancelledQty+=Math.max(0,Number(result.cancelledQty||0));
            if(result.orderId)affectedOrderIds.add(result.orderId);
        }
        if(cancelledQty<=0){
            alert('這張訂購單目前沒有尚未到貨的數量可取消。');
            return;
        }
        const now=new Date().toISOString();
        const patch={
            status:'CANCELLED',
            cancelledQty,
            cancelReason:reason,
            cancelledAt:now,
            cancelledByUid:currentUser?.uid||'',
            cancelledBy:currentUserName||currentUser?.email||'',
            updatedAt:now
        };
        await db.collection('purchaseOrders').doc(poId).set(patch,{merge:true});
        const applyPatch=row=>row?.id===poId?Object.assign(row,patch):row;
        poListCache.forEach(applyPatch);
        poHistorySearchResults.forEach(applyPatch);
        supplyReceivingCache=supplyReceivingCache.filter(row=>!supplyIds.includes(row.id));
        if(affectedOrderIds.size)await refreshAffectedOrderCaches([...affectedOrderIds]);
        writeAppDataCache('purchase-history',poListCache);
        if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView();
        else renderPoList();
        showActionFeedback(`已取消 ${po.poNo||poId} 尚未到貨數量 ${cancelledQty}；在途庫存與來源訂單待採購量已同步。`,'success');
    }catch(err){
        console.error('取消訂購單未到貨失敗：',err);
        alert('取消未完全完成：'+(err?.message||err)+'。可以再次執行同一動作；已完成的供應紀錄不會重複扣除。');
    }finally{
        purchaseCancellationInProgress.delete(poId);
    }
};

let poReceiptTargetId = '';
let poReceiptSaveInProgress = false;
let poReceiptOperationId = '';

function receiptOperationStorageKey(supplyId) {
    return `yushin-receipt-operation:${String(supplyId || '')}`;
}
function ensureReceiptOperationId(supplyId) {
    const key=receiptOperationStorageKey(supplyId);
    let operationId='';
    try { operationId=sessionStorage.getItem(key)||''; } catch (_) {}
    if(!operationId){
        operationId=`receipt-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
        try { sessionStorage.setItem(key,operationId); } catch (_) {}
    }
    poReceiptOperationId=operationId;
    return operationId;
}
function clearReceiptOperationId(supplyId) {
    try { sessionStorage.removeItem(receiptOperationStorageKey(supplyId)); } catch (_) {}
    poReceiptOperationId='';
}
window.closePoReceiptBatch = function() {
    document.getElementById('poReceiptBatchOverlay')?.classList.remove('active');
    const body=document.getElementById('poReceiptBatchBody');
    if(body)body.innerHTML='';
    poReceiptTargetId='';
};


window.receiveSupplyOrder = function(supplyId) {
    if (!canReceiveInventoryCapability()) { alert('您沒有到貨入庫權限。'); return; }
    const supply=pendingSupplyCache.find(row=>row.id===supplyId);
    if(!supply)return;
    const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
    if(remaining<=0){alert('這筆訂貨已全部入庫。');return;}
    poReceiptTargetId='supply:'+supplyId;
    ensureReceiptOperationId(supplyId);
    const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
    const title=document.getElementById('poReceiptBatchTitle');
    if(title)title.textContent=directShip ? `原廠直送到貨｜${supply.internalNo||supplyId}` : `到貨入庫｜${supply.internalNo||supplyId}`;
    const body=document.getElementById('poReceiptBatchBody');
    body.innerHTML=`<tr data-index="0">
      <td><input type="checkbox" class="po-receive-select" checked></td>
      <td>${escapeHtml(supply.itemCode||'')}</td>
      <td>${escapeHtml(supply.itemName||'')}</td>
      <td>${Number(supply.qty||0)}</td><td>${Number(supply.receivedQty||0)}</td><td>${remaining}</td>
      <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
      <td><input type="text" class="po-receive-lot" placeholder="批號"></td>
      <td><input type="date" class="po-receive-expiry"></td>
    </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

async function allocateFreeReceiptStockToShortages(productKey,warehouseId,maxQty,actor,excludeOrderId='',receiptId='') {
    let remaining=Math.max(0,Number(maxQty||0)),allocatedQty=0;
    const affectedOrderIds = new Set();
    const skippedCandidateIds = new Set();
    if(!remaining||!productKey||!warehouseId)return {allocatedQty:0,unallocatedQty:remaining,affectedOrderIds:[]};
    // Allocate one live shortage at a time. Re-reading candidates after every successful
    // transaction preserves oldest-first ordering even when multiple receipts run concurrently.
    // 已失效／取消的最舊候選只跳過，不可阻塞後面的正常缺貨訂單。
    while(remaining>0){
        const loadCandidates=async status=>{
            const rows=[]; let cursor=null,hasMore=true;
            while(hasMore&&rows.length<500){
                let q=db.collection('inventoryReservations').where('productKey','==',productKey).where('status','==',status).limit(50);
                if(cursor)q=q.startAfter(cursor);
                const page=await firestoreReadWithTimeout(q.get(),'庫存占用候選');
                page.docs.forEach(doc=>rows.push({id:doc.id,...doc.data()}));
                cursor=page.empty?null:page.docs[page.docs.length-1];
                hasMore=page.size===50;
            }
            return rows;
        };
        const [shortageRows,activeRows]=await Promise.all([loadCandidates('shortage'),loadCandidates('active')]);
        const candidate=[...shortageRows,...activeRows]
            .filter(row=>row.orderId!==excludeOrderId&&row.warehouseId===warehouseId&&Number(row.shortageQty||0)>0)
            .filter(row=>!skippedCandidateIds.has(row.id))
            .filter((row,index,all)=>all.findIndex(x=>x.id===row.id)===index)
            .sort((a,b)=>String(a.orderDate||'9999-12-31').localeCompare(String(b.orderDate||'9999-12-31'))||String(a.id).localeCompare(String(b.id)))[0];
        if(!candidate)break;
        let took=0,skipCandidate=false,stopAllocation=false;
        await db.runTransaction(async tx=>{
            const orderRef=db.collection('orders').doc(candidate.orderId);
            const reservationRef=db.collection('inventoryReservations').doc(candidate.id);
            const invRef=db.collection('inventory').doc(encodeURIComponent(productKey));
            const whRef=db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey));
            const receiptRef=receiptId?db.collection('receipts').doc(receiptId):null;
            const [orderSnap,resSnap,invSnap,whSnap,receiptSnap]=await Promise.all([
                tx.get(orderRef),tx.get(reservationRef),tx.get(invRef),tx.get(whRef),
                receiptRef?tx.get(receiptRef):Promise.resolve(null)
            ]);
            if(!orderSnap.exists||!resSnap.exists||!whSnap.exists){skipCandidate=true;return;}
            if(receiptRef&&!receiptSnap?.exists){stopAllocation=true;return;}
            const reservation=resSnap.data();
            const liveShortage=Math.max(0,Number(reservation.shortageQty||0));
            const order={id:orderSnap.id,...orderSnap.data()};
            if(normalizedOrderStatus(order)!=='normal'||liveShortage<=0){skipCandidate=true;return;}
            const inv=inventoryNumbers(invSnap.exists?invSnap.data():{}),wh=inventoryNumbers(whSnap.data());
            const receipt=receiptSnap?.exists?(receiptSnap.data()||{}):null;
            const receiptTarget=receiptRef?Math.max(0,Number(receipt?.autoAllocationQty||0)):remaining;
            const receiptAllocated=receiptRef?Math.max(0,Number(receipt?.autoAllocatedQty||0)):0;
            const receiptRemaining=receiptRef?Math.max(0,receiptTarget-receiptAllocated):remaining;
            const take=Math.min(remaining,receiptRemaining,liveShortage,Math.max(0,wh.available));
            if(take<=0){stopAllocation=true;return;}
            const items=normalizedOrderItems(order);
            const index=items.findIndex(item=>item.itemId===reservation.itemId);
            if(index<0){skipCandidate=true;return;}
            const item=items[index],oldReserved=Number(item.reservedQty||0);
            const oldShortage=Math.max(0,Number(item.shortageQty??liveShortage));
            items[index]={...item,reservedQty:oldReserved+take,shortageQty:Math.max(0,oldShortage-take)};
            const totalReserved=items.reduce((s,row)=>s+Number(row.reservedQty||0),0);
            const totalShortage=items.reduce((s,row)=>s+Number(row.shortageQty||0),0);
            const now=new Date().toISOString();
            const nextOrder={...order,items,updatedAt:now};
            tx.update(orderRef,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
            tx.update(reservationRef,{quantity:Number(reservation.quantity||0)+take,shortageQty:Math.max(0,liveShortage-take),status:'active',updatedAt:now});
            if(invSnap.exists)tx.update(invRef,{reserved:inv.reserved+take,updatedAt:now});
            tx.update(whRef,{reserved:wh.reserved+take,updatedAt:now});
            if(receiptRef){
                const nextAllocated=receiptAllocated+take;
                tx.update(receiptRef,{
                    autoAllocatedQty:nextAllocated,
                    allocationCompleted:nextAllocated>=receiptTarget,
                    allocationUpdatedAt:now
                });
            }
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord('reserve_from_receipt',take,candidate.orderId,productKey,actor,{
                warehouseId,itemId:reservation.itemId||'',fulfillmentType:'WAREHOUSE',receiptId:receiptId||''
            }));
            took=take;
        });
        if(took>0){invalidateWarehouseStockCache(productKey,warehouseId);allocatedQty+=took;remaining-=took;affectedOrderIds.add(candidate.orderId);continue;}
        if(skipCandidate){
            // 避免同一輪一直選到已取消／失效的舊 reservation；改看下一個候選。
            skippedCandidateIds.add(candidate.id);
            continue;
        }
        if(stopAllocation)break;
        break;
    }
    return {allocatedQty,unallocatedQty:remaining,affectedOrderIds:[...affectedOrderIds]};
}

async function refreshAffectedOrderCaches(orderIds = []) {
    const ids=[...new Set(orderIds.filter(Boolean))];
    if(!ids.length)return;
    const refreshedOrders=await readDocumentsByIds('orders',ids);
    refreshedOrders.forEach(order=>{
        const index=ordersCache.findIndex(row=>row.id===order.id);
        if(index>=0)ordersCache[index]=order;else ordersCache.unshift(order);
        syncOrderIntoPurchasingCaches(order, { render:false });
    });
    ordersCache.sort((a,b)=>(b.orderDate||'').localeCompare(a.orderDate||''));
    writeAppDataCache('orders',ordersCache);
    if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
}

async function receiveSupplyOrderRecord(supplyId,qty,lotNo='',expiryDate='',operationId='') {
    const now=new Date().toISOString(),actor=deliveryActor();
    const operationKey=String(operationId||'').trim();
    if(!operationKey)throw new Error('缺少到貨操作識別碼，請重新開啟待到貨視窗後再試。');
    let receivedProductKey='',receivedWarehouseId='',sourceOrderId='',sourceOrderStatus='',reservedForSource=0,alreadyProcessed=false,processedReceipt=null;
    const affectedOrderIds = new Set();
    await db.runTransaction(async tx=>{
        const supplyRef=db.collection('supplyOrders').doc(supplyId);
        const receiptRef=db.collection('receipts').doc(operationKey);
        const supplySnap=await tx.get(supplyRef);
        const receiptSnap=await tx.get(receiptRef);
        if(!supplySnap.exists)throw new Error('找不到供應紀錄。');
        const supply=supplySnap.data();
        if (supply.orderId) affectedOrderIds.add(supply.orderId);
        // 已成功提交過的同一 receiptId 必須先走冪等重試；即使之後取消了剩餘未到貨，
        // 也不能把已完成的到貨重試誤判成新的「取消後收貨」。
        if(receiptSnap.exists){
            const receipt=receiptSnap.data()||{};
            if(String(receipt.supplyOrderId||'')!==String(supplyId))throw new Error('到貨操作識別碼衝突，請重新開啟待到貨視窗。');
            alreadyProcessed=true;
            processedReceipt=receipt;
            if((receipt.fulfillmentType||supply.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
                receivedProductKey=String(receipt.productKey||supply.productKey||supply.productId||'').trim();
                receivedWarehouseId=String(receipt.warehouseId||supply.warehouseId||'').trim();
                sourceOrderId=receipt.orderId||supply.orderId||'';
            }
            return;
        }
        if (String(supply.status || '').toUpperCase() === 'CANCELLED') {
            throw new Error('此供應紀錄已取消，不能再確認到貨。');
        }
        const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
        if(qty<=0||qty>remaining)throw new Error(`本次到貨數量不可超過 ${remaining}。`);
        const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        if(directShip){
            if(!supply.orderId||!supply.itemId)throw new Error('原廠直送紀錄缺少來源訂單／品項。');
            const orderRef=db.collection('orders').doc(supply.orderId);
            const orderSnap=await tx.get(orderRef);
            if(!orderSnap.exists)throw new Error('找不到來源訂單。');
            const order=orderSnap.data();
            if(normalizedOrderStatus(order)!=='normal')throw new Error('來源訂單已取消，不能繼續確認到貨；請先處理／恢復來源訂單。');
            const items=normalizedOrderItems(order);
            const itemIndex=items.findIndex(item=>item.itemId===supply.itemId);
            if(itemIndex<0)throw new Error('找不到來源訂單品項。');
            const item=items[itemIndex];
            const delivered=Math.min(Number((item.orderedQty ?? item.qty) || 0),Number(item.deliveredQty||0)+qty);
            items[itemIndex]={...item,receivedQty:Number(item.receivedQty||0)+qty,deliveredQty:delivered,directShipDeliveredQty:Number(item.directShipDeliveredQty||0)+qty};
            const deliveryRecord={
                id:`direct-${operationKey}`,itemId:supply.itemId,date:localDateString(),qty,
                notes:'原廠直送到貨確認',createdBy:actor,createdAt:now,sourceType:'DIRECT_SHIP_RECEIPT',sourceId:supplyId
            };
            const deliveryRecords=[...savedDeliveryRecords(order),deliveryRecord];
            const grossDelivered=deliveryRecords.reduce((sum,row)=>sum+Number(row.qty||0),0);
            const returned=returnedQuantity(order);
            const total=orderQuantity({...order,items});
            const nextOrder={
                ...order,items,itemCount:items.length,orderSchemaVersion:2,
                deliveryRecords,deliveredQty:grossDelivered,
                isDelivered:Math.max(0,grossDelivered-returned)>=total&&total>0,
                updatedAt:now
            };
            tx.update(orderRef,{
                items,itemCount:items.length,orderSchemaVersion:2,
                deliveryRecords,deliveredQty:grossDelivered,isDelivered:nextOrder.isDelivered,
                ...orderWorkIndexFields(nextOrder),updatedAt:now
            });
            const receivedQty=Number(supply.receivedQty||0)+qty;
            tx.update(supplyRef,{receivedQty,status:receivedQty>=Number(supply.qty||0)?'RECEIVED':'PARTIAL_RECEIPT',updatedAt:now});
            tx.set(receiptRef,{receiptId:operationKey,operationId:operationKey,supplyOrderId:supplyId,orderId:supply.orderId,itemId:supply.itemId,qty,cumulativeReceivedQty:receivedQty,fulfillmentType:'DIRECT_SHIP',sourceType:'SUPPLY_ORDER',createdAt:now,createdBy:actor});
            return;
        }
        const productKey=supply.productKey||supply.productId||(supply.itemCode?`code:${normalizeHistoryItemCode(supply.itemCode)}`:'');
        if(!productKey)throw new Error('此品項缺少 Product ID／貨號。');
        const warehouseId=supply.warehouseId||defaultWarehouse()?.id||'';
        if(!warehouseId)throw new Error('此供應紀錄尚未指定入庫倉庫，無法安全入庫。');
        receivedProductKey=productKey;receivedWarehouseId=warehouseId;sourceOrderId=supply.orderId||'';
        const invRef=db.collection('inventory').doc(encodeURIComponent(productKey));
        const whRef=warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)):null;
        const invSnap=await tx.get(invRef);
        const whSnap=whRef?await tx.get(whRef):null;
        const inv=inventoryNumbers(invSnap.exists?invSnap.data():{});
        const wh=inventoryNumbers(whSnap?.exists?whSnap.data():{});
        let order=null,items=[],itemIndex=-1,reserveQty=0;
        if(supply.orderId){
            const orderRef=db.collection('orders').doc(supply.orderId);
            const reservationRef=db.collection('inventoryReservations').doc(`${supply.orderId}__${supply.itemId}`);
            const orderSnap=await tx.get(orderRef);
            const reservationSnap=await tx.get(reservationRef);
            if(orderSnap.exists){
                order=orderSnap.data();
                sourceOrderStatus=normalizedOrderStatus(order);
                // 倉庫型採購即使來源訂單已取消，供應商仍可能照常出貨。
                // 此時貨照常入庫，但不可再占回已取消訂單；整批視為自由庫存。
                items=normalizedOrderItems(order);itemIndex=items.findIndex(item=>item.itemId===supply.itemId);
                if(itemIndex>=0){
                    const item=items[itemIndex];
                    if(sourceOrderStatus==='normal'){
                        if(!reservationSnap.exists)throw new Error('來源訂單缺少庫存占用紀錄，無法安全入庫。');
                        const reservation=reservationSnap.data();
                        const currentReserved=Math.max(0,Number(reservation.quantity||0));
                        const next=window.YushinFulfillment.applyReceipt({...item,reservedQty:currentReserved},qty);
                        reserveQty=Math.max(0,Number(next.reservedQty||0)-currentReserved);
                        reservedForSource=reserveQty;
                        items[itemIndex]={...next,reservedQty:next.reservedQty};
                        const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                        tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                        tx.set(reservationRef,{
                            orderId:supply.orderId,itemId:supply.itemId,orderNo:order.orderNo||order.quoteNo||supply.orderId,
                            productKey,itemCode:supply.itemCode||'',itemName:supply.itemName||'',customerName:order.customerName||'',
                            ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',salesName:order.salesName||'',orderDate:order.orderDate||'',
                            quantity:Number(next.reservedQty||0),shortageQty:Number(next.shortageQty||0),
                            status:Number(next.reservedQty||0)>0?'active':'shortage',warehouseId,updatedAt:now
                        },{merge:true});
                    }else{
                        // 取消中的來源訂單不重新占庫存，但仍同步實際到貨摘要。
                        // 這樣日後恢復訂單時，不會把已經到倉的數量再次誤判成在途採購。
                        const orderedQty=Math.max(0,Number(item.orderedQty??item.qty??0));
                        const currentReceived=Math.max(0,Number(item.receivedQty||0));
                        const receivedForOrder=Math.min(qty,Math.max(0,orderedQty-currentReceived));
                        if(receivedForOrder>0){
                            items[itemIndex]={...item,receivedQty:currentReceived+receivedForOrder};
                            const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                            tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                        }
                    }
                }
            }
        }
        const registeredIncoming=Math.max(0,Number(supply.incomingRegisteredQty||0));
        const incomingRelease=Math.min(qty,registeredIncoming);
        const embeddedLots=[...(invSnap.exists?(invSnap.data().lots||[]):[])];
        const embeddedIndex=embeddedLots.findIndex(l=>(l.lotNo||'')===lotNo&&(l.expiryDate||'')===expiryDate);
        if(embeddedIndex>=0)embeddedLots[embeddedIndex]={...embeddedLots[embeddedIndex],qty:Number(embeddedLots[embeddedIndex].qty||0)+qty};
        else embeddedLots.push({lotNo,expiryDate,qty,receivedAt:now,sourceSupplyId:supplyId});
        {
          const nextInventory={...(invSnap.exists?invSnap.data():{}),productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:inv.onHand+qty,reserved:inv.reserved+reserveQty,incoming:Math.max(0,inv.incoming-incomingRelease),lots:embeddedLots,updatedAt:now};
          nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
          tx.set(invRef,nextInventory,{merge:true});
        }
        if(whRef)tx.set(whRef,{warehouseId,productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:wh.onHand+qty,reserved:wh.reserved+reserveQty,incoming:Math.max(0,wh.incoming-incomingRelease),updatedAt:now},{merge:true});
        const lotRef=db.collection('inventoryLots').doc();
        tx.set(lotRef,{productKey,productId:supply.productId||'',warehouseId,lotNo,expiryDate,receivedQty:qty,remainingQty:qty,supplier:supply.supplier||'',sourceType:'SUPPLY_ORDER',sourceId:supplyId,receivedAt:now});
        tx.set(db.collection('inventoryLotCosts').doc(lotRef.id),{lotId:lotRef.id,productKey,productId:supply.productId||'',warehouseId,unitCost:Number(supply.unitCost||0),sourceType:'SUPPLY_ORDER',sourceId:supplyId,createdAt:now,createdBy:actor});
        const autoAllocationQty=Math.max(0,Number(qty||0)-reserveQty);
        tx.set(receiptRef,{
            receiptId:operationKey,operationId:operationKey,supplyOrderId:supplyId,
            orderId:supply.orderId||'',itemId:supply.itemId||'',sourceOrderStatus,
            productKey,warehouseId,qty,autoAllocationQty,autoAllocatedQty:0,allocationCompleted:autoAllocationQty===0,fulfillmentType:'WAREHOUSE',
            lotId:lotRef.id,lotNo,expiryDate,createdAt:now,createdBy:actor
        });
        tx.set(db.collection('inventoryMovements').doc(),{type:'receipt',qty,productKey,warehouseId,lotNo,expiryDate,sourceType:'SUPPLY_ORDER',sourceId:supplyId,receiptId:operationKey,createdAt:now,createdBy:actor,ownerUid:supply.ownerUid||'',salesCode:supply.salesCode||''});
        const receivedQty=Number(supply.receivedQty||0)+qty;
        tx.update(supplyRef,{
            receivedQty,
            incomingRegisteredQty:Math.max(0,registeredIncoming-incomingRelease),
            status:receivedQty>=Number(supply.qty||0)?'RECEIVED':'PARTIAL_RECEIPT',
            updatedAt:now
        });
    });
    if (receivedProductKey && receivedWarehouseId) invalidateWarehouseStockCache(receivedProductKey, receivedWarehouseId);

    // Replenishment / excess receipt stock automatically serves oldest outstanding shortages.
    // The physical receipt is already committed before this phase. If this follow-up is interrupted,
    // the same immutable receiptId is reused to count prior allocations and only the remainder is retried.
    let freeQty=Math.max(0,Number(qty||0)-reservedForSource);
    if(alreadyProcessed){
        const allocationTarget=Math.max(0,Number(processedReceipt?.autoAllocationQty||0));
        if(allocationTarget>0){
            const priorMovements=await readQueryInBatches(
                db.collection('inventoryMovements').where('receiptId','==',operationKey)
            );
            const alreadyAllocated=priorMovements
                .filter(row=>row.type==='reserve_from_receipt')
                .reduce((sum,row)=>sum+Math.max(0,Number(row.qty||0)),0);
            let reconciledAllocated=alreadyAllocated;
            await db.runTransaction(async tx=>{
                const receiptRef=db.collection('receipts').doc(operationKey);
                const receiptSnap=await tx.get(receiptRef);
                if(!receiptSnap.exists)return;
                const receipt=receiptSnap.data()||{};
                const currentAllocated=Math.max(0,Number(receipt.autoAllocatedQty||0));
                reconciledAllocated=Math.max(currentAllocated,alreadyAllocated);
                if(reconciledAllocated!==currentAllocated){
                    tx.update(receiptRef,{
                        autoAllocatedQty:reconciledAllocated,
                        allocationCompleted:reconciledAllocated>=allocationTarget,
                        allocationUpdatedAt:new Date().toISOString()
                    });
                }
            });
            freeQty=Math.max(0,allocationTarget-reconciledAllocated);
        }else{
            freeQty=0;
        }
    }
    if(freeQty>0){
        try{
            const allocation=await allocateFreeReceiptStockToShortages(
                receivedProductKey,receivedWarehouseId,freeQty,actor,sourceOrderId,operationKey
            );
            allocation.affectedOrderIds.forEach(id=>affectedOrderIds.add(id));
        }catch(allocationErr){
            const error=new Error(
                '到貨已完成，但其他缺貨訂單的自動庫存分配尚未完成：'
                +(allocationErr?.message||allocationErr)
                +'。請再按一次「確認到貨」重試；系統不會重複入庫。'
            );
            error.code='receipt-allocation-pending';
            error.receiptCommitted=true;
            error.affectedOrderIds=[...affectedOrderIds];
            throw error;
        }
    }
    return [...affectedOrderIds];
}

window.openSupplyReceipt = function(supplyId) {
    if (!canReceiveInventoryCapability()) return;
    const supply = supplyReceivingCache.find(row => row.id === supplyId);
    if (!supply) { alert('找不到這筆待到貨紀錄，請重新整理。'); return; }

    const ordered = Math.max(0, Number(supply.qty || 0));
    const received = Math.max(0, Number(supply.receivedQty || 0));
    const remaining = Math.max(0, ordered - received);
    if (remaining <= 0) { alert('此品項已全部到貨。'); return; }

    const directShip = (supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
    poReceiptTargetId = `supply:${supply.id}`;
    ensureReceiptOperationId(supply.id);
    const body = document.getElementById('poReceiptBatchBody');
    const title = document.getElementById('poReceiptBatchTitle');
    if (title) title.textContent = directShip
        ? `原廠直送到貨｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`
        : `到貨入庫｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`;
    body.innerHTML = `
        <tr data-index="0">
            <td><input type="checkbox" class="po-receive-select" checked></td>
            <td>${escapeHtml(supply.itemCode || '')}</td>
            <td>${escapeHtml(supply.itemName || '')}</td>
            <td>${ordered}</td><td>${received}</td><td>${remaining}</td>
            <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
            <td><input type="text" class="po-receive-lot" placeholder="批號" ${directShip ? 'disabled' : ''}></td>
            <td><input type="date" class="po-receive-expiry" ${directShip ? 'disabled' : ''}></td>
        </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

window.savePoReceiptBatch = async function() {
    if (!canReceiveInventoryCapability() || poReceiptSaveInProgress) return;
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

    poReceiptSaveInProgress = true;
    if (button) { button.disabled=true; button.textContent='處理中…'; }
    let completed = 0;
    const affectedOrderIds = new Set();
    try {
        if(!poId.startsWith('supply:')) throw new Error('到貨必須從供應紀錄進入，請重新整理待到貨頁面。');
        const supplyId=poId.slice(7);
        const operationBase=poReceiptOperationId||ensureReceiptOperationId(supplyId);
        for(const entry of entries){
            const operationId=`${operationBase}-${entry.itemIndex}`;
            const ids=await receiveSupplyOrderRecord(supplyId,entry.qty,entry.lotNo,entry.expiryDate,operationId);
            ids.forEach(id=>affectedOrderIds.add(id));
            completed++;
        }
        // 只有確認 transaction 已完成後才清除冪等鍵；若網路錯誤，保留同一 key 供重試。
        clearReceiptOperationId(supplyId);
        // 核心入庫 transaction 已完成後就結束使用者等待；跨模組列表改成背景同步。
        // 這些 reload 只是 UI refresh，不應延長「確認入庫」按鈕的完成時間。
        closePoReceiptBatch();
        alert(`已完成 ${completed} 個品項的到貨確認。`);
        Promise.allSettled([
            loadMyPurchaseOrders(),
            getDataScope('orders') !== 'none' ? refreshAffectedOrderCaches([...affectedOrderIds]) : Promise.resolve(),
            (canAccessPage('inventory') && document.getElementById('inventory-system')?.classList.contains('active'))
                ? loadInventory(true) : Promise.resolve()
        ]).then(results => {
            const failed=results.filter(result=>result.status==='rejected');
            if(failed.length) console.warn('入庫完成後背景同步部分失敗：', failed.map(result=>result.reason));
        });
    } catch (err) {
        if(err?.code==='receipt-allocation-pending' && err?.receiptCommitted){
            (err.affectedOrderIds||[]).forEach(id=>affectedOrderIds.add(id));
            // 核心到貨 transaction 已完成；保留同一個 operationId，讓使用者原地重試後續分配。
            alert(err.message);
        }
        // 部分成功時，已完成的 transaction 是正式資料；錯誤訊息不應再被次要列表 refresh 阻塞。
        else if (completed > 0) {
            closePoReceiptBatch();
            alert(`已成功確認 ${completed} 個品項到貨；後續品項中斷：${err.message}\n已成功的資料不會重複處理，請重新開啟訂購單處理剩餘數量。`);
        } else {
            alert('批量到貨入庫失敗：'+err.message);
        }
        Promise.allSettled([
            loadMyPurchaseOrders(),
            getDataScope('orders') !== 'none' ? refreshAffectedOrderCaches([...affectedOrderIds]) : Promise.resolve(),
            (canAccessPage('inventory') && document.getElementById('inventory-system')?.classList.contains('active'))
                ? loadInventory(true) : Promise.resolve()
        ]).then(results => {
            const failed=results.filter(result=>result.status==='rejected');
            if(failed.length) console.warn('入庫中斷後背景同步部分失敗：', failed.map(result=>result.reason));
        });
    } finally {
        poReceiptSaveInProgress = false;
        if (button) { button.disabled=false; button.textContent='確認到貨'; }
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
            const savedProductId = item.productId || order.productId || '';
            const normalizedCode = normalizeItemCode(itemCode);
            const normalizedBrand = String(brand || '').trim().toLocaleLowerCase();
            const priceMatch = (savedProductId && priceList.find(product => product.productId === savedProductId))
                || (normalizedBrand && priceItemLookup.get(`brand:${normalizedBrand}:${normalizedCode}`))
                || priceItemLookup.get(`code:${normalizedCode}`);
            const productId = savedProductId || priceMatch?.productId || (priceMatch ? stableProductId(priceMatch) : '');
            const secureCost = productId ? purchaseCostCache.get(productId) : null;
            if (secureCost !== undefined && secureCost !== null) cost = Number(secureCost);
            else if (priceMatch && authorizationTypeForProduct(priceMatch) !== 'AUTHORIZED') {
                cost = parseFloat(priceMatch.cost ?? priceMatch.costPrice ?? priceMatch.purchasePrice);
            }
        }
        const parsedQty=parseFloat(qtyValue);
        const fullQty=Number.isFinite(parsedQty)&&parsedQty>0?parsedQty:1;
        const procurementType=item.procurementType||order.procurementType||'PURCHASING_PO';
        if(procurementType==='SALES_SELF_ORDER') return null;
        // 待採購數量必須與採購頁、訂單工作狀態共用同一公式。
        // shortageQty 會在到貨時下降，不能再直接減累計 supplyOrderedQty，
        // 否則「部分採購已全部到貨、但仍有剩餘缺口」會被誤算成 0。
        const remainingPurchase=remainingProcurementQty(order,item);
        return {
            orderId: order.id,
            orderItemIndex: index,
            itemId:item.itemId||`item-${index+1}`,
            itemName,
            itemCode,
            productId: item.productId || order.productId || '',
            brand,
            qty: remainingPurchase,
            productLine: item.productLine || order.productLine || '',
            ownerUid: order.ownerUid || '',
            salesCode: order.salesCode || '',
            salesName: order.salesName || '',
            fulfillmentType: item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE',
            warehouseId: item.warehouseId || order.warehouseId || '',
            unitPrice: Number.isFinite(cost) && cost > 0 ? cost : 0,
            procurementType
        };
    }).filter(item => item && (item.itemName || item.itemCode) && Number(item.qty||0)>0);
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
    const openingGeneration = ++poDirectStockOpenGeneration;
    poDirectStockMode = true;
    poEditingId = null;
    poIncomingSyncPending = false;
    poAllItems = [];
    poItems = [];
    document.getElementById('poVendorName').value = '';
    document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
    document.getElementById('poDate').value = localDateString();
    switchPoCompany(currentCompany || 'yushin', null, true);
    generatePoNo();
    addDirectPoItem();
    updatePoModeUI();
    updatePoSaveStatus('這張訂購單尚未建立。確認品項、廠商與單價後，按「列印 / 存為 PDF」；系統會自動同步雲端。');
    document.getElementById('poModalOverlay').classList.add('active');

    // 備貨單的空白表單不依賴雲端主檔，先立即顯示；供應商與預設倉庫在背景補齊。
    // 不重畫使用者已經開始輸入的表格，避免慢網路回來時洗掉尚未觸發 change 的文字。
    await loadSupplierWarehouseMasters();
    if (openingGeneration !== poDirectStockOpenGeneration || !poDirectStockMode || poEditingId) return;
    const warehouseId = defaultWarehouse()?.id || '';
    poItems.forEach(item => {
        if (!item.warehouseId) item.warehouseId = warehouseId;
    });
    populatePoVendorSuggestions();
    updatePoModeUI();
};

function emptyDirectPoItem() {
    return {
        orderId:'', itemName:'', itemCode:'', productId:'', brand:'', qty:1, unitPrice:0, supplier:'',
        productLine:'', fulfillmentType:'WAREHOUSE', warehouseId:defaultWarehouse()?.id || ''
    };
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
    const match = await findProductByCode(value);
    poItems[idx].itemCode = String(value || '').trim();
    if (match) {
        const secureCost = await loadVisibleProductCost(match);
        poItems[idx] = {
            ...poItems[idx],
            itemCode: match.model || value,
            itemName: match.nameCn || match.nameEn || '',
            productId: match.productId || stableProductId(match),
            brand: resolveBrandName(match.brand || ''),
            unitPrice: secureCost !== null && Number.isFinite(secureCost)
                ? secureCost
                : (authorizationTypeForProduct(match) === 'NON_AUTHORIZED' ? Number(match.cost || 0) : 0),
            supplier: match.supplier || '',
            productLine: match.productLine || '',
            fulfillmentType: poItems[idx].fulfillmentType || 'WAREHOUSE',
            warehouseId: poItems[idx].warehouseId || defaultWarehouse()?.id || ''
        };
        const mappedSupplier = supplierForProduct(match.brand, match.productLine);
        if (!document.getElementById('poVendorName').value && mappedSupplier) {
            document.getElementById('poVendorName').value = mappedSupplier.purchaseHeaderName || mappedSupplier.supplierName || '';
        } else if (!document.getElementById('poVendorName').value && match.supplier) {
            document.getElementById('poVendorName').value = match.supplier;
        }
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
    const overlay = document.getElementById('poModalOverlay');
    const title = document.getElementById('poModalTitle');
    const existingBanner = document.getElementById('poExistingBanner');
    const existingNumber = document.getElementById('poExistingNumber');
    const copyBtn = document.getElementById('poCopyAsNewBtn');
    if (brandList) brandList.innerHTML = getUnifiedBrandNames(false).map(name => `<option value="${escapeAttr(name)}"></option>`).join('');

    const viewingExisting = !!poEditingId;
    overlay?.classList.toggle('po-viewing-existing', viewingExisting);
    if (title) title.textContent = viewingExisting ? '查看訂購單' : '建立訂購單';
    if (existingBanner) existingBanner.style.display = viewingExisting ? 'flex' : 'none';
    if (existingNumber) existingNumber.textContent = viewingExisting ? (document.getElementById('poNo')?.innerText || poEditingId) : '';

    const savedPo = viewingExisting ? poListCache.find(po => po.id === poEditingId) : null;
    const canCopySafely = !!savedPo && (savedPo.purchaseType === 'stock' || purchaseItemsFromSavedPo(savedPo).every(item => !item.orderId));
    if (copyBtn) copyBtn.style.display = canCopySafely ? '' : 'none';

    if (addBtn) addBtn.style.display = !viewingExisting && poDirectStockMode ? '' : 'none';
    if (hint) hint.textContent = viewingExisting
        ? '這是已建立的正式訂購單。內容鎖定不直接修改；可重新匯出 PDF。'
        : poDirectStockMode
            ? '建立庫存採購訂購單：可一次加入多個品項；建立後會列入在途庫存。'
            : '訂單採購：品項來自業務訂單，可調整採購數量與進貨單價。';
    updatePoSaveButton();
}


async function autoFillPoSupplier(items) {
    await loadSupplierWarehouseMasters();
    const resolved = (items || []).map(item => supplierForProduct(item.brand, item.productLine)).filter(Boolean);
    if (!resolved.length) return '';
    const ids = [...new Set(resolved.map(item => item.id || item.supplierId))];
    if (ids.length !== 1) return '';
    const supplier = resolved[0];
    const header = supplier.purchaseHeaderName || supplier.supplierName || '';
    const input = document.getElementById('poVendorName');
    if (input && header) input.value = header;
    return header;
}

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
    poDirectStockOpenGeneration++;
    poNoGeneration++;
    poNoLoading = false;
    poNoReady = false;
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
    if (!info) return '';
    const generation = ++poNoGeneration;
    const dateStr = getFormattedDateCode();
    const purchaserCode = currentUserCode || '01';
    const prefix = `PO-${info.prefix}-${dateStr}-${purchaserCode}-`;
    const numberEl = document.getElementById('poNo');

    poNoReady = false;
    poNoLoading = true;
    if (numberEl) numberEl.innerText = '產生中…';
    updatePoSaveButton();

    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('purchaseOrders')
                .where('poNo', '>=', prefix)
                .where('poNo', '<=', prefix + '\uf8ff')
                .orderBy('poNo', 'desc')
                .limit(1)
                .get(),
            '訂購單號'
        );

        // 使用者可能在查詢尚未回來時切換公司、關閉視窗或開啟另一張單。
        // 舊查詢結果不得再覆蓋目前畫面。
        if (generation !== poNoGeneration) return '';

        let maxSeq = 0;
        snapshot.forEach(doc => {
            const seqStr = (doc.data().poNo || '').split('-').pop();
            const seq = parseInt(seqStr, 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        });
        const nextNo = `${prefix}${String(maxSeq + 1).padStart(2, '0')}`;
        if (numberEl) numberEl.innerText = nextNo;
        poNoReady = true;
        return nextNo;
    } catch (e) {
        if (generation !== poNoGeneration) return '';
        // 查不到目前最大流水號時不能直接假設 01；那可能撞到已存在的正式 PO。
        if (numberEl) numberEl.innerText = '—';
        poNoReady = false;
        updatePoSaveStatus('訂購單號讀取失敗，請切換公司或重新開啟後再試。', true);
        return '';
    } finally {
        if (generation === poNoGeneration) {
            poNoLoading = false;
            updatePoSaveButton();
        }
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
                <td style="border:1px solid #999;padding:4px;"><input type="text" value="${escapeAttr(item.itemName||'')}" placeholder="品名" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'itemName',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="priceModelList" value="${escapeAttr(item.itemCode||'')}" placeholder="貨號" style="width:100%;box-sizing:border-box;" onchange="onDirectPoCodeChange(${idx},this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="poBrandList" value="${escapeAttr(item.brand||'')}" placeholder="廠牌" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'brand',this.value)"></td>
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

function formalSupplyOrderId(purchaseOrderId, itemIndex) {
    return `po-${encodeURIComponent(String(purchaseOrderId||''))}-${Number(itemIndex||0)}`;
}

function assertPurchaseLinesAvailable(order, lines) {
    if (normalizedOrderStatus(order) !== 'normal') throw new Error('來源訂單已取消或作廢。');
    const sourceItems = normalizedOrderItems(order);
    const requestedByIndex = new Map();
    for (const line of lines) {
        const index = Number(line.orderItemIndex);
        const source = sourceItems[index];
        const sourceItemCode = String(source?.itemCode || '').trim();
        const lineItemCode = String(line?.itemCode || '').trim();
        const stableItemMismatch = !!(line?.itemId && source?.itemId && line.itemId !== source.itemId);
        if (!Number.isInteger(index) || !source || stableItemMismatch
            || (sourceItemCode && lineItemCode && sourceItemCode !== lineItemCode)) {
            throw new Error('來源訂單品項已變更，請重新建立訂購單。');
        }
        requestedByIndex.set(index, (requestedByIndex.get(index) || 0) + Number(line.qty || 0));
    }
    for (const [index, qty] of requestedByIndex) {
        const source = sourceItems[index];
        const remaining = remainingProcurementQty(order, source);
        if (!(qty > 0) || qty > remaining + 1e-9) throw new Error('待採購數量已變更，請重新開啟來源訂單。');
    }
}

function poPdfFileName(poNo, vendorName) {
    const raw = [poNo, vendorName].filter(Boolean).join('-') || '訂購單';
    return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.pdf';
}

function normalizePoPdfFields(root) {
    root.querySelectorAll('.no-print').forEach(node => node.remove());
    root.querySelectorAll('input').forEach(input => {
        const span = document.createElement('span');
        span.className = 'po-pdf-field-value';
        span.textContent = input.value || '';
        input.replaceWith(span);
    });
    root.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
}

function createPoPdfStage() {
    const source = document.getElementById('printablePO');
    if (!source) throw new Error('找不到訂購單內容');

    const stage = document.createElement('div');
    stage.className = 'quote-pdf-stage po-pdf-stage';
    const documentNode = source.cloneNode(true);
    documentNode.className = 'po-pdf-document';
    normalizePoPdfFields(documentNode);
    stage.appendChild(documentNode);
    document.body.appendChild(stage);
    return { stage, documentNode };
}

function createPoPdfPage(stage, source, includeHeader = false) {
    const page = document.createElement('div');
    page.className = 'po-pdf-page';

    const sourceTable = source.querySelector('table');
    if (includeHeader) {
        for (const child of [...source.children]) {
            if (child === sourceTable) break;
            page.appendChild(child.cloneNode(true));
        }
    }

    const table = sourceTable.cloneNode(false);
    table.removeAttribute('id');
    const thead = sourceTable.querySelector('thead');
    if (thead) table.appendChild(thead.cloneNode(true));
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    page.appendChild(table);
    stage.appendChild(page);
    return { page, tbody };
}

function paginatePoPdfDocument(stage, source) {
    const sourceTable = source.querySelector('table');
    if (!sourceTable) return [source];
    const rows = [...sourceTable.querySelectorAll('tbody tr')];
    const summary = source.querySelector('.po-total-section');
    const maxHeight = quotePdfPageHeightPx(stage);

    source.style.display = 'none';
    const pages = [];
    let current = createPoPdfPage(stage, source, true);
    pages.push(current);

    for (const row of rows) {
        const clone = row.cloneNode(true);
        current.tbody.appendChild(clone);
        if (current.page.scrollHeight > maxHeight && current.tbody.children.length > 1) {
            clone.remove();
            current = createPoPdfPage(stage, source, false);
            pages.push(current);
            current.tbody.appendChild(clone);
        }
    }

    if (summary) {
        const summaryClone = summary.cloneNode(true);
        current.page.appendChild(summaryClone);
        if (current.page.scrollHeight > maxHeight) {
            summaryClone.remove();
            const donor = current;
            const finalPage = createPoPdfPage(stage, source, false);
            pages.push(finalPage);
            finalPage.page.appendChild(summaryClone);

            // 與估價單相同：最後一頁優先保留合計區，再把前頁最後的品項往後搬，
            // 只要超出 A4 可用高度就立即放回，避免產生大片空白或切到合計內容。
            while (donor.tbody.lastElementChild) {
                const candidate = donor.tbody.lastElementChild;
                finalPage.tbody.prepend(candidate);
                if (finalPage.page.scrollHeight > maxHeight) {
                    donor.tbody.appendChild(candidate);
                    break;
                }
            }
        }
    }

    source.remove();
    return pages.map(entry => entry.page);
}

async function printSavedPoDocument(poNo, vendorName) {
    let stage = null;
    const button = document.getElementById('printPurchaseOrderBtn');
    try {
        if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
            throw new Error('PDF 元件尚未載入');
        }

        if (button) {
            button.disabled = true;
            button.innerText = '準備 PDF…';
        }
        updatePoSaveStatus('正在準備訂購單 PDF…');

        const exportDom = createPoPdfStage();
        stage = exportDom.stage;
        await waitForPdfImages(exportDom.documentNode);

        const pages = paginatePoPdfDocument(stage, exportDom.documentNode);
        await waitForPdfImages(stage);

        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const scale = isMobile ? 1.15 : 1.65;
        const pdf = new window.jspdf.jsPDF({ orientation:'portrait', unit:'mm', format:'a4', compress:true });

        await addDocumentPagesToPdf(pdf, pages, {
            scale,
            onProgress: (pageNo, pageCount) => {
                if (button) button.innerText = `正在產生 PDF… ${pageNo}/${pageCount}`;
                updatePoSaveStatus(`正在產生訂購單 PDF… ${pageNo}/${pageCount}`);
            }
        });

        if (button) button.innerText = '正在下載 PDF…';
        pdf.save(poPdfFileName(poNo, vendorName));
        updatePoSaveStatus('✓ 訂購單 PDF 已產生');
    } finally {
        stage?.remove();
    }
}

window.printPurchaseOrder = async function() {
    if (poSaveInProgress) return;
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    if (!poEditingId && !poNoReady) {
        updatePoSaveStatus(poNoLoading ? '訂購單號仍在產生中，完成後即可列印 / 存為 PDF。' : '訂購單號尚未就緒，請切換公司或重新開啟後再試。', !poNoLoading);
        return;
    }
    if (poEditingId) {
        const savedPo = poListCache.find(po => po.id === poEditingId);
        if (!savedPo) { alert('找不到已儲存的訂購單，請重新整理。'); return; }
        if (!poIncomingSyncPending) {
            const button = document.getElementById('printPurchaseOrderBtn');
            poSaveInProgress = true;
            try {
                await printSavedPoDocument(savedPo.poNo, savedPo.vendorName);
                db.collection('purchaseOrders').doc(savedPo.id).set({
                    lastOutputAt: new Date().toISOString(),
                    lastOutputType: 'PDF'
                }, { merge:true }).catch(err => console.warn('更新訂購單輸出時間失敗：', err));
            } catch (err) {
                console.error('產生訂購單 PDF 失敗：', err);
                updatePoSaveStatus('產生訂購單 PDF 失敗：' + (err?.message || err), true);
            } finally {
                poSaveInProgress = false;
                if (button) button.disabled = false;
                updatePoSaveButton();
            }
            return;
        }
        const button = document.getElementById('printPurchaseOrderBtn');
        poSaveInProgress = true;
        if (button) { button.disabled = true; button.innerText = '同步雲端後開啟列印…'; }
        try {
            await registerPurchaseIncoming(savedPo.id, savedPo);
            poIncomingSyncPending = false;
            updatePoSaveStatus(`訂購單 ${savedPo.poNo} 已同步雲端，正在產生 PDF…`);
            await printSavedPoDocument(savedPo.poNo, savedPo.vendorName);
        } catch (err) {
            updatePoSaveStatus(`訂購單已同步雲端，但在途庫存同步仍未完成：${err.message}`, true);
        } finally {
            poSaveInProgress = false;
            if (button) button.disabled = false;
            updatePoSaveButton();
        }
        return;
    }
    if (poItems.length === 0) {
        alert('目前沒有任何品項，請先選取或不要刪光所有品項。');
        return;
    }
    if (poItems.some(item => !Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0)) {
        alert('每個採購品項的數量都必須大於 0。');
        return;
    }
    if (poDirectStockMode && poItems.some(item => (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP')) {
        alert('新增庫存採購單是公司庫存採購，不能設定為原廠直送。');
        return;
    }
    if (poDirectStockMode && poItems.some(item => !String(item.warehouseId || defaultWarehouse()?.id || '').trim())) {
        alert('新增庫存採購單必須指定入庫倉庫，請先建立或選擇倉庫。');
        return;
    }
    if (poItems.some(item => (item.fulfillmentType || 'WAREHOUSE') !== 'DIRECT_SHIP' && !String(item.warehouseId || defaultWarehouse()?.id || '').trim())) {
        alert('入庫品項必須有倉庫，請先在倉庫管理建立預設倉庫。');
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
    if (!poNo || poNo === '產生中…' || poNo === '—') {
        updatePoSaveStatus('訂購單號尚未就緒，請切換公司或重新開啟後再試。', true);
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
        purchaseType: poItems.every(item => !item.orderId) ? 'stock' : 'order',
        items: poItems.map(item => ({ ...item, brand: resolveBrandName(item.brand || '') })),
        ...netAmountMetadata(poNetTotal),
        createdAt: new Date().toISOString(),
        lastOutputAt: new Date().toISOString(),
        lastOutputType: 'PDF',
        ...linkedDocumentFields(orderIds.length === 1 ? DOCUMENT_TYPES.ORDER : '', orderIds.length === 1 ? orderIds[0] : '', orderIds.map(orderId => documentLink(DOCUMENT_TYPES.ORDER, orderId, 'source')))
    };
    poRecord.searchTokens=purchaseOrderSearchTokens(poRecord);
    const button = document.getElementById('printPurchaseOrderBtn');
    poSaveInProgress = true;
    if (button) {
        button.disabled = true;
        button.innerText = '同步雲端中…';
    }
    updatePoSaveStatus('正在同步訂購單到雲端…');
    let poCommitted = false;
    try {
        const poDocumentId = poNo;
        let committedSourceOrders = [];
        const commitPromise = db.runTransaction(async transaction => {
            committedSourceOrders = [];
            const poRef = db.collection('purchaseOrders').doc(poDocumentId);
            const orderRefs = orderIds.map(orderId => db.collection('orders').doc(orderId));
            const poSnapshot = await transaction.get(poRef);
            const orderSnapshots = await Promise.all(orderRefs.map(ref => transaction.get(ref)));
            if (poSnapshot.exists) throw new Error(`訂購單號 ${poNo} 已存在，請關閉視窗後重新產生單號。`);
            orderSnapshots.forEach((snapshot, index) => {
                if (!snapshot.exists) throw new Error('來源訂單已不存在。');
                assertPurchaseLinesAvailable(snapshot.data(), poRecord.items.filter(item => item.orderId === orderIds[index]));
            });
            const supplyOrderIds = [];
            poRecord.items.forEach((item,itemIndex)=>{
                const supplyId=formalSupplyOrderId(poDocumentId,itemIndex);
                const supplyRef=db.collection('supplyOrders').doc(supplyId);
                supplyOrderIds.push(supplyId);
                transaction.set(supplyRef,{
                    // 客戶訂單採購與公司備貨是兩種不同供應來源；purchaseOrders 只保存文件快照。
                    type:item.orderId?'PURCHASING_PO':'STOCK_REPLENISHMENT',
                    internalNo:poNo,
                    purchaseDocumentId:poDocumentId,
                    purchaseDocumentNo:poNo,
                    status:'ORDERED',
                    orderId:item.orderId||'',
                    itemId:item.itemId||'',
                    orderItemIndex:Number(item.orderItemIndex||0),
                    ownerUid:item.ownerUid||'',
                    salesCode:item.salesCode||'',
                    productId:item.productId||'',
                    productKey:poIncomingKey(item),
                    itemCode:item.itemCode||'',
                    itemName:item.itemName||'',
                    brand:resolveBrandName(item.brand||''),
                    qty:Number(item.qty||0),
                    receivedQty:0,
                    incomingRegisteredQty:0,
                    supplier:vendorName,
                    unitCost:Number(item.unitPrice||0),
                    orderDate:poRecord.poDate,
                    fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                    warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||defaultWarehouse()?.id||''),
                    createdAt:poRecord.createdAt,
                    updatedAt:poRecord.createdAt,
                    createdByUid:currentUser?.uid||'',
                    createdBy:currentUserName||currentUser?.email||'',
                    createdByRole:currentUserRole
                });
            });
            poRecord.supplyOrderIds=supplyOrderIds;
            transaction.set(poRef, poRecord);
            orderSnapshots.forEach((snapshot, index) => {
                if (snapshot.exists) {
                    const orderData = snapshot.data();
                    const orderedLines=poRecord.items.filter(item=>item.orderId===snapshot.id);
                    const nextItems=normalizedOrderItems(orderData).map((item,itemIndex)=>{
                        const matches=orderedLines.filter(line=>Number(line.orderItemIndex)===itemIndex);
                        const orderedQty=matches.reduce((sum,line)=>sum+Number(line.qty||0),0);
                        const currentSupplyOrdered=Math.max(0,Number(item.supplyOrderedQty||0));
                        const cumulative=currentSupplyOrdered+orderedQty;
                        const identityLine=matches.find(line=>line.itemId&&item.itemId&&line.itemId===item.itemId)||matches[0];
                        return orderedQty>0?{
                            ...item,
                            // 採購單可補齊來源訂單原本缺少的產品識別資料；已有值不覆蓋，
                            // 避免「來源貨號空白 → 採購頁可填 → 儲存又被擋住」的死路流程。
                            productId:item.productId||identityLine?.productId||'',
                            itemCode:item.itemCode||identityLine?.itemCode||'',
                            itemName:item.itemName||identityLine?.itemName||'',
                            brand:item.brand||resolveBrandName(identityLine?.brand||''),
                            productLine:item.productLine||identityLine?.productLine||'',
                            supplyOrderedQty:cumulative,
                            purchaseDocumentNos:[...new Set([...(item.purchaseDocumentNos||[]),poNo])],
                            orderedAt:item.orderedAt && item.orderedAt < poRecord.poDate ? item.orderedAt : poRecord.poDate
                        }:item;
                    });
                    const nextOrderData={...orderData,items:nextItems,itemCount:nextItems.length,orderSchemaVersion:2};
                    const orderUpdates = {
                        items:nextItems,itemCount:nextItems.length,orderSchemaVersion:2,
                        ...orderWorkIndexFields(nextOrderData),
                        linkedDocuments: normalizeDocumentLinks([...(orderData.linkedDocuments || []), documentLink(DOCUMENT_TYPES.PURCHASE_ORDER, poDocumentId, 'document')])
                    };
                    transaction.update(orderRefs[index], orderUpdates);
                    committedSourceOrders.push({id:snapshot.id,...orderData,...orderUpdates});
                }
            });
        });

        // 訂購單會同時改寫來源訂單與供應紀錄，不能像估價單一樣「先印再存」：
        // 若 iPhone 在列印畫面直接關閉頁面，背景 transaction 可能尚未完成，會造成紙本已下單但系統沒有紀錄。
        // 只等待這個最小且必要的核心 transaction；在途庫存仍於列印後背景同步。
        updatePoSaveStatus('正在確認並儲存訂購單…');
        await commitPromise;
        poCommitted = true;
        if (button) button.innerText = '同步在途庫存中…';

        // The PO + source-order linkage above is the authoritative commit.
        // Cache it before the separate incoming-stock registration so a transient
        // failure can retry the same PO idempotently instead of attempting to
        // create another PO with the same number.
        syncCommittedPurchaseOrderSources(committedSourceOrders);
        const savedPo = { id: poDocumentId, ...poRecord };
        const cachedIndex = poListCache.findIndex(po => po.id === savedPo.id);
        if (cachedIndex >= 0) poListCache[cachedIndex] = savedPo;
        else poListCache.unshift(savedPo);
        poEditingId = savedPo.id;
        poIncomingSyncPending = true;
        updatePoSaveStatus(`訂購單 ${poNo} 已同步雲端；正在產生 PDF，在途庫存稍後背景同步…`);

        // 核心 transaction 完成後才輸出 PDF，確保使用者拿到的正式文件一定有對應的系統紀錄。
        // PDF 使用與估價單相同的逐頁 Canvas → jsPDF 流程，不再依賴瀏覽器列印視窗。
        await printSavedPoDocument(poNo, vendorName);

        // PO 與來源訂單已在上方同一個 transaction 成功提交；列印不等待第二段在途庫存同步。
        // 在途同步以 PO id 冪等處理，失敗時仍可由同一張 PO 重試，不會重複建立訂購單。
        registerPurchaseIncoming(poDocumentId, poRecord)
            .then(() => {
                poIncomingSyncPending = false;
                if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
                updatePoSaveStatus(`訂購單 ${poNo} 已建立；在途庫存同步完成。`);
                updatePoSaveButton();
            })
            .catch(err => {
                console.error('訂購單在途庫存背景同步失敗：', err);
                poIncomingSyncPending = true;
                updatePoSaveStatus(`訂購單已同步雲端，但在途庫存同步未完成：${err.message}。請由這張訂購單重試同步，不要另建一張。`, true);
                updatePoSaveButton();
            });
    } catch (err) {
        console.error('儲存訂購單紀錄失敗：', err);
        updatePoSaveStatus(poCommitted
            ? `訂購單已同步雲端，但在途庫存同步未完成：${err.message}`
            : `訂購單未建立：${err.message}`, true);
        alert(poCommitted
            ? '訂購單已同步雲端，但在途庫存同步未完成。請在這張訂購單按「重試同步在途庫存」，不要另建一張：' + err.message
            : '無法產生訂購單：' + err.message);
    } finally {
        poSaveInProgress = false;
        if (button) {
            button.disabled = false;
        }
        updatePoSaveButton();
    }
};

// 「製作下一張估價單」：手動觸發，不會因為誤按列印視窗的取消鈕就被清空。
// 按下後會先確認，避免不小心點到把還沒印的內容洗掉；確認後清空表單、單號跳下一號，
// 並且立刻把這個「全新、還是空的」狀態存成本機草稿，這樣萬一使用者按完馬上關網頁，
// 重開時看到的會是這張全新的空白單，而不是被清掉的上一張。
window.startNextQuote = function() {
    if (!confirm('確定要開始製作下一張估價單嗎？目前畫面上的內容將會被清空（如果還沒匯出 PDF，請先確認已經處理好）。')) return;
    setQuoteEditingContext('');
    setQuoteOutputStatus('');
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
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (field !== 'isBilled') {
        alert('訂貨、到貨與送貨狀態已由 V2 採購／入庫／打單流程自動管理。');
        return;
    }
    const o = ordersCache.find(x => x.id === orderId);
    if (!o || !canEditPage('orders.list')) return;
    const pendingKey = `${orderId}:isBilled`;
    if (pendingOrderStatusKeys.has(pendingKey)) return;
    if (normalizedOrderStatus(o) !== 'normal') { alert('已取消的訂單不能更改進度。'); return; }

    const invoiceDate = newValue ? (orderInvoiceDate(o) || localDateString()) : '';
    const previousWorkFilter = activeOrderWorkFilter;
    const previous = {
        isBilled: o.isBilled,
        invoiceDate: o.invoiceDate || '',
        status: o.status,
        statusHistory: [...(o.statusHistory || [])]
    };
    const actor = currentUserName || currentUser?.email || '未知使用者';
    const timestamp = new Date().toISOString();
    const logEntry = { field:'isBilled', value:newValue, label:newValue ? '已報帳' : '取消已報帳', by:actor, at:timestamp };

    o.isBilled = newValue;
    o.invoiceDate = invoiceDate;
    if (!newValue && activeOrderWorkFilter === 'complete') activeOrderWorkFilter = 'billing';
    if (newValue && activeOrderWorkFilter === 'billing' && deliveryProgressInfo(o).state === 'complete') activeOrderWorkFilter = 'complete';
    o.statusHistory = [...previous.statusHistory, logEntry];
    pendingOrderStatusKeys.add(pendingKey);
    writeAppDataCache('orders', ordersCache);
    renderOrdersList();

    let committed;
    db.runTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        if (normalizedOrderStatus(order) !== 'normal') throw new Error('這筆訂單已取消。');
        const updates = {
            isBilled:newValue,
            invoiceDate,
            status:BUSINESS_STATUS.ACTIVE,
            updatedAt: timestamp,
            statusHistory:firebase.firestore.FieldValue.arrayUnion(logEntry)
        };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        committed = {
            isBilled:newValue,
            invoiceDate,
            status:BUSINESS_STATUS.ACTIVE,
            statusHistory:[...(order.statusHistory || []),logEntry]
        };
    }).then(() => {
        Object.assign(o, committed);
        pendingOrderStatusKeys.delete(pendingKey);
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    }).catch(err => {
        Object.assign(o, previous);
        pendingOrderStatusKeys.delete(pendingKey);
        activeOrderWorkFilter = previousWorkFilter;
        writeAppDataCache('orders', ordersCache);
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
    writeAppDataCache('orders', ordersCache);
    renderOrdersList();
    db.collection('orders').doc(orderId).update({ invoiceDate: value, updatedAt: history.at, fieldEditHistory: firebase.firestore.FieldValue.arrayUnion(history) }).catch(err => {
        order.invoiceDate = previous;
        order.fieldEditHistory = (order.fieldEditHistory || []).filter(item => item !== history);
        writeAppDataCache('orders', ordersCache);
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

window.showCustomerOrderHistory = async function(customerName) {
    const customerKey = normalizeFullHistorySearchValue(customerName);
    if (!customerKey) return;
    const overlay = document.getElementById('customerOrderHistoryOverlay');
    const title = document.getElementById('customerOrderHistoryTitle');
    const summary = document.getElementById('customerTransactionSummary');
    const tbody = document.getElementById('customerOrderHistoryBody');
    const quoteTbody = document.getElementById('customerQuoteHistoryBody');
    if (title) title.innerText = `客戶近期交易摘要：${customerName}`;
    if (summary) summary.innerHTML = '<div class="customer-summary-card"><span>資料狀態</span><strong>讀取完整歷史中…</strong></div>';
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:#888;">讀取訂單歷史中…</td></tr>';
    if (quoteTbody) quoteTbody.innerHTML = '<tr><td colspan="6" style="color:#888;">讀取估價歷史中…</td></tr>';
    if (overlay) overlay.classList.add('active');

    try {
        const orderToken = fullHistoryQueryToken('order', customerName);
        const quoteToken = fullHistoryQueryToken('quote', customerName);
        const [orderSnap, quoteSnap] = await Promise.all([
            orderToken
                ? firestoreReadWithTimeout(scopedHistorySearchQuery('orders', orderToken).limit(DEFAULT_LIST_LIMIT).get(), '客戶訂單歷史')
                : Promise.resolve({ docs: [] }),
            quoteToken
                ? firestoreReadWithTimeout(scopedHistorySearchQuery('quotes', quoteToken).limit(DEFAULT_LIST_LIMIT).get(), '客戶估價歷史')
                : Promise.resolve({ docs: [] })
        ]);
        const exactCustomerKey = normalizeCustomerKey(customerName);
        const orders = (orderSnap.docs || [])
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(order => normalizeCustomerKey(order.customerName || order.customer || '') === exactCustomerKey)
            .sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')));
        const quotes = (quoteSnap.docs || [])
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(quote => [quote.ordererName, quote.clientName].some(value => normalizeCustomerKey(value) === exactCustomerKey))
            .sort((a, b) => String(b.quoteDate || b.quoteNo || '').localeCompare(String(a.quoteDate || a.quoteNo || '')));
        const quoteItems = quotes.flatMap(quote => (quote.items || []).map(item => ({ quote, item })))
            .sort((a, b) => String(b.quote.quoteDate || b.quote.quoteNo || '').localeCompare(String(a.quote.quoteDate || a.quote.quoteNo || '')));
        const recentDates = [...orders.map(order => order.orderDate), ...quotes.map(quote => quote.quoteDate)].filter(Boolean).sort().reverse();
        const latestOrder = orders[0];
        const latestQuoteItem = quoteItems[0];
        const latestPrice = latestOrder
            ? `NT$ ${Number(parseFloat(String(latestOrder.unitPrice ?? '').replace(/,/g, '')) || 0).toLocaleString()}`
            : latestQuoteItem ? `NT$ ${Number(parseFloat(String(latestQuoteItem.item.price ?? '').replace(/,/g, '')) || 0).toLocaleString()}` : '－';
        const latestProduct = latestOrder?.itemName || latestQuoteItem?.item?.nameCn || latestQuoteItem?.item?.nameEn || '－';
        if (summary) summary.innerHTML = `
            <div class="customer-summary-card"><span>最近交易日</span><strong>${escapeHtml(recentDates[0] || '－')}</strong></div>
            <div class="customer-summary-card"><span>最近購買／估價品項</span><strong>${escapeHtml(latestProduct)}</strong></div>
            <div class="customer-summary-card"><span>上次單價</span><strong>${escapeHtml(latestPrice)}</strong></div>
            <div class="customer-summary-card"><span>最近估價</span><strong>${escapeHtml(quotes[0] ? `${quotes[0].quoteNo || '－'}／${quotes[0].quoteDate || '－'}` : '－')}</strong></div>`;
        if (tbody) tbody.innerHTML = orders.length ? orders.slice(0, 20).map(order => `
            <tr><td>${escapeHtml(order.orderDate || '')}</td><td>${escapeHtml(order.brand || '')}</td><td>${escapeHtml(order.itemCode || '')}</td><td>${escapeHtml(order.itemName || '')}</td><td>${escapeHtml(String(order.qty || ''))}</td><td>${escapeHtml(String(order.totalPrice || ''))}</td><td>${deliveryProgressInfo(order).delivered>0 ? (deliveryProgressInfo(order).state==='complete'?'已送貨':'部分送貨') : fulfillmentProgressInfo(order).shippable>0 ? '可出貨' : fulfillmentProgressInfo(order).pendingDispatch>0 ? '待打單' : purchaseProgressInfo(order).label}</td></tr>
        `).join('') : '<tr><td colspan="7" style="color:#888;">目前沒有訂單紀錄。</td></tr>';
        if (quoteTbody) quoteTbody.innerHTML = quoteItems.length ? quoteItems.slice(0, 20).map(({ quote, item }) => `
            <tr><td>${escapeHtml(quote.quoteDate || '')}</td><td>${escapeHtml(quote.quoteNo || '')}</td><td>${escapeHtml(item.nameCn || item.nameEn || item.model || '')}</td><td>${escapeHtml(String(item.qty || ''))}</td><td>${escapeHtml(String(item.price || ''))}</td><td>${quote.dealClosed ? '已成交' : '估價中'}</td></tr>
        `).join('') : '<tr><td colspan="6" style="color:#888;">目前沒有估價紀錄。</td></tr>';
    } catch (err) {
        console.error('讀取客戶完整交易歷史失敗：', err);
        if (summary) summary.innerHTML = '<div class="customer-summary-card"><span>資料狀態</span><strong>讀取失敗</strong></div>';
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:#888;">無法讀取完整訂單歷史。</td></tr>';
        if (quoteTbody) quoteTbody.innerHTML = '<tr><td colspan="6" style="color:#888;">無法讀取完整估價歷史。</td></tr>';
    }
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
    const items = normalizedOrderItems(order);
    const deliveries = savedDeliveryRecords(order);
    const now = new Date().toISOString();

    // Firestore transactions require every read before the first write.
    const contexts = [];
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const itemId = String(item.itemId || `item-${index + 1}`);
        const productKey = inventoryProductKey(item);
        const directShip = (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
        const grossDelivered = deliveries
            .filter(row => row.itemId === itemId || (!row.itemId && items.length === 1))
            .reduce((sum, row) => sum + Number(row.qty || 0), 0);
        const returned = savedReturnRecords(order)
            .filter(row => row.itemId === itemId || (!row.itemId && items.length === 1))
            .reduce((sum, row) => sum + Number(row.qty || 0), 0);
        const delivered = Math.max(0, grossDelivered - returned);
        const ordered = Math.max(0, Number(item.qty || item.orderedQty || 0));
        const warehouseId = directShip ? '' : (item.warehouseId || order.warehouseId || defaultWarehouse()?.id || '');
        const invRef = !directShip && productKey ? inventoryRefFor(item) : null;
        const whRef = !directShip && warehouseId && productKey ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId, productKey)) : null;
        const reservationRef = db.collection('inventoryReservations').doc(`${orderId}__${itemId}`);
        const invSnap = invRef ? await transaction.get(invRef) : null;
        const whSnap = whRef ? await transaction.get(whRef) : null;
        const reservationSnap = await transaction.get(reservationRef);
        contexts.push({item,itemId,productKey,directShip,delivered,ordered,warehouseId,invRef,whRef,invSnap,whSnap,reservationRef,reservationSnap});
    }

    const nextItems = [];
    let totalReserved = 0;
    let totalShortage = 0;
    const stockStates = new Map();
    contexts.forEach(ctx => {
        if (ctx.invRef && ctx.invSnap?.exists && !stockStates.has(ctx.invRef.path)) stockStates.set(ctx.invRef.path,{ref:ctx.invRef,...inventoryNumbers(ctx.invSnap.data())});
        if (ctx.whRef && ctx.whSnap?.exists && !stockStates.has(ctx.whRef.path)) stockStates.set(ctx.whRef.path,{ref:ctx.whRef,...inventoryNumbers(ctx.whSnap.data())});
    });

    for (const ctx of contexts) {
        const {item,itemId,productKey,directShip,delivered,ordered,warehouseId,invRef,whRef,invSnap,whSnap,reservationRef,reservationSnap} = ctx;

        if (directShip || !productKey) {
            const shortage = directShip ? 0 : Math.max(0, ordered - delivered);
            transaction.set(reservationRef, {
                orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
                itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
                salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
                orderDate:order.orderDate||'',quantity:0,shortageQty:nextStatus==='cancelled'?0:shortage,
                status:nextStatus==='cancelled'?'released':(directShip?'direct_ship':'shortage'),warehouseId:'',updatedAt:now
            }, { merge:true });
            const nextReserved = nextStatus==='cancelled' ? 0 : 0;
            nextItems.push({...item,itemId,reservedQty:nextReserved,shortageQty:nextStatus==='cancelled'?0:shortage});
            totalReserved += nextReserved;
            totalShortage += nextStatus==='cancelled'?0:shortage;
            continue;
        }

        const invState = invRef ? stockStates.get(invRef.path) : null;
        const whState = whRef ? stockStates.get(whRef.path) : null;
        if (nextStatus === 'cancelled') {
            const reservationData = reservationSnap?.exists ? reservationSnap.data() : null;
            const reservedRemaining = Math.max(0, Number(reservationData?.quantity ?? item.reservedQty ?? 0));
            const release = Math.min(reservedRemaining, whState?.reserved || 0);
            if (release > 0) {
                invState.reserved = Math.max(0, invState.reserved - release);
                whState.reserved = Math.max(0, whState.reserved - release);
                transaction.set(db.collection('inventoryMovements').doc(), inventoryMovementRecord('release',-release,orderId,productKey,actor,{reason:'order_cancelled',warehouseId,itemId}));
            }
            transaction.set(reservationRef,{
                orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
                itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
                salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
                orderDate:order.orderDate||'',quantity:0,shortageQty:0,status:'released',warehouseId,updatedAt:now
            },{merge:true});
            nextItems.push({...item,itemId,reservedQty:0,shortageQty:0});
            continue;
        }

        const outstanding = Math.max(0, ordered - delivered);
        // 已下 PO／自行訂購的數量屬於既有在途供應，恢復訂單時不能再拿同一數量占用現貨，
        // 否則會同時出現「待到貨」與庫存 reservation，造成供應量重複計算。
        const orderedSupply = Math.max(0, Number(item.supplyOrderedQty||0));
        const receivedSupply = Math.max(0, Number(item.receivedQty||0));
        const incomingSupply = Math.min(outstanding, Math.max(0, orderedSupply - receivedSupply));
        const needed = Math.max(0, outstanding - incomingSupply);
        const reserve = whState ? Math.min(needed,Math.max(0,whState.onHand-whState.reserved)) : 0;
        const shortage = Math.max(0, needed - reserve);
        if (reserve > 0) {
            invState.reserved += reserve;
            whState.reserved += reserve;
            transaction.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord('reserve',reserve,orderId,productKey,actor,{reason:'order_restored',warehouseId,itemId}));
        }
        transaction.set(reservationRef,{
            orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
            itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
            salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
            orderDate:order.orderDate||'',quantity:reserve,shortageQty:shortage,
            status:reserve>0?'active':(shortage>0?'shortage':'fulfilled'),warehouseId,updatedAt:now
        },{merge:true});
        nextItems.push({...item,itemId,reservedQty:reserve,shortageQty:shortage});
        totalReserved += reserve;
        totalShortage += shortage;
    }

    stockStates.forEach(state => {
        transaction.update(state.ref,{reserved:Math.max(0,state.reserved),updatedAt:now});
    });
    transaction.update(db.collection('orders').doc(orderId),{
        items:nextItems,updatedAt:now
    });
}

window.quickSetOrderLifecycle = async function(orderId, nextStatus) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限負責業務、工程師或管理員。'); return; }
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
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, orderLifecycleHistory: [...(order.orderLifecycleHistory || []), history] };
        });
        normalizedOrderItems(savedOrder).forEach(item=>{
            const productKey=inventoryProductKey(item);
            const warehouseId=(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||savedOrder.warehouseId||'');
            if(productKey&&warehouseId) invalidateWarehouseStockCache(productKey,warehouseId);
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        const syncedOrder = { id: orderId, ...savedOrder };
        if (index >= 0) ordersCache[index] = syncedOrder;
        syncOrderIntoPurchasingCaches(syncedOrder);
        writeAppDataCache('orders', ordersCache);
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
    if (!orderId || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
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
    const itemSelect=document.getElementById('deliveryItemId');
    if(itemSelect)itemSelect.disabled=false;
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    const progress = deliveryProgressInfo(order || {});
    document.getElementById('deliveryFormHint').innerText = `目前最多還可登錄 ${progress.remaining} 個。`;
};

window.openPartialDeliveryForm = function() {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (normalizedOrderStatus(order) !== 'normal') { alert('已取消的訂單不能新增送貨紀錄。'); return; }
    const progress = deliveryProgressInfo(order);
    if (progress.remaining <= 0) { alert('這筆訂單已全數送貨。'); return; }
    deliveryPartialFormOpen = true;
    document.getElementById('deliveryFormPanel').style.display = '';
    document.getElementById('deliveryQty').value = '';
    document.getElementById('deliveryDate').focus();
};

window.openPartialDeliveryForOrder = function(orderId) {
    if (!canManageOrderLifecycleCapability()) return;
    openDeliveryModal(orderId);
    openPartialDeliveryForm();
};

window.openReturnManagement = function(orderId) {
    if (!canManageOrderLifecycleCapability()) return;
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
    if (orderedBy) {
        const purchase = purchaseProgressInfo(order);
        const fulfillment = fulfillmentProgressInfo(order);
        orderedBy.innerText = `採購：${purchase.label}｜履約：${fulfillment.label}`;
    }
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
    // 採購／到貨狀態由 supplyOrders、receipts、reservation 與 dispatch qty 推導。
    if (order.isBilled && !(order.statusHistory || []).some(item => item.field === 'isBilled')) {
        entries.push({ at: orderInvoiceDate(order) || order.orderDate || '', action: '報帳（歷史推估）', by: '舊資料未記錄', detail: '依目前報帳狀態推估' });
    }
    if (order.isDelivered && !savedDeliveryRecords(order).length && !(order.deliveryHistory || []).length) {
        entries.push({ at: order.orderDate || '', action: '送貨（歷史推估）', by: '舊資料未記錄', detail: '依目前訂單狀態推估，日期暫用訂單日期' });
    }
    entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    tbody.innerHTML = entries.length ? entries.map(item => `<tr><td>${escapeHtml(formatOrderStatusTime(item.at))}</td><td>${escapeHtml(item.action || '')}</td><td>${escapeHtml(item.by || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`).join('') : '<tr><td colspan="4" style="color:#888;">尚無操作紀錄。</td></tr>';
}

async function applyInventoryDeliveryDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, reversalRecords) {
    if (!deltaQty || (order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return { reservedDelta:0,newReservedQty:Math.max(0,Number(order.reservedQty||0)),lotAllocations:[],cogs:0 };
    const productKey = inventoryProductKey(order);
    const warehouseId = order.warehouseId || defaultWarehouse()?.id || '';
    const invRef = inventoryRefFor(order);
    const whRef = warehouseId ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)) : null;
    if (!invRef || !whRef) throw new Error('此訂單尚未指定有效倉庫，無法進行庫存出貨。');

    const deliveryItemId=String(order.itemId||'').trim();
    if(!deliveryItemId) throw new Error('出貨品項缺少 itemId，無法安全對應庫存占用紀錄。');
    const deliveryReservationRef=db.collection('inventoryReservations').doc(`${sourceId}__${deliveryItemId}`);
    const invSnap = await transaction.get(invRef);
    const whSnap = await transaction.get(whRef);
    const reservationSnap = await transaction.get(deliveryReservationRef);
    if (!whSnap.exists) throw new Error('指定倉庫沒有這個產品的分倉庫存，請先入庫或以庫存調整建立分倉數量。');

    const inv = inventoryNumbers(invSnap.exists ? invSnap.data() : {}), wh = inventoryNumbers(whSnap.data());
    const currentReservation=Math.max(0,Number(reservationSnap.exists?reservationSnap.data().quantity:0));
    const newReservedRemaining=Math.max(0,currentReservation-deltaQty);
    const reservedDelta=newReservedRemaining-currentReservation;
    const now = new Date().toISOString();
    let lotAllocations=[],cogs=0;

    if (deltaQty > 0) {
        if (wh.onHand < deltaQty) throw new Error(`庫存不足：${warehouseMasterCache.find(w=>w.id===warehouseId)?.warehouseName || warehouseId} 現有 ${wh.onHand}，本次需出貨 ${deltaQty}。`);
        const lotQuery=await transaction.get(db.collection('inventoryLots').where('productKey','==',productKey).where('warehouseId','==',warehouseId));
        const lotDocs=lotQuery.docs.map(doc=>({id:doc.id,...doc.data()})).filter(l=>Number(l.remainingQty||0)>0);
        if(!lotDocs.length)throw new Error('此庫存尚未建立批次成本資料，請先完成入庫／期初庫存批次建檔後再送貨。');
        const allocation=window.YushinSupply.allocateLots(lotDocs.map(lot=>({...lot,unitCost:0})),deltaQty);
        lotAllocations=allocation.allocations;cogs=allocation.totalCost;
        lotAllocations.forEach(row=>{
            const lot=lotDocs.find(x=>x.id===row.lotId);
            transaction.update(db.collection('inventoryLots').doc(row.lotId),{remainingQty:Number(lot.remainingQty||0)-row.qty,updatedAt:now});
        });
    } else {
        const restoreQty=Math.abs(deltaQty);
        const sourceRecords=Array.isArray(reversalRecords)&&reversalRecords.length?reversalRecords:savedDeliveryRecords(order);
        const reversal=window.YushinSupply.reverseLotAllocations(sourceRecords,restoreQty);
        lotAllocations=reversal.allocations.map(row=>({...row,qty:-row.qty,cost:-row.cost}));
        for(const row of reversal.allocations){
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            const lotSnap=await transaction.get(lotRef);
            if(!lotSnap.exists)throw new Error(`找不到原出貨批次 ${row.lotNo||row.lotId}，無法安全還原庫存。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)+row.qty,updatedAt:now});
        }
        cogs=-reversal.totalCost;
    }

    if (invSnap.exists) transaction.set(invRef,{onHand:Math.max(0,inv.onHand-deltaQty),reserved:Math.max(0,inv.reserved+reservedDelta),incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:wh.onHand-deltaQty,reserved:Math.max(0,wh.reserved+reservedDelta),incoming:wh.incoming,updatedAt:now},{merge:true});
    transaction.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(deltaQty>0?'ship':'ship_reversal',-deltaQty,sourceId,productKey,actor,{
        warehouseId,fulfillmentType:'WAREHOUSE',reservedDelta,lotAllocations,costPending:true,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    }));

    transaction.set(deliveryReservationRef,{...inventoryReservationPayload(sourceId,order,newReservedRemaining,newReservedRemaining>0?'active':'fulfilled'),itemId:deliveryItemId,warehouseId},{merge:true});
    return { reservedDelta,newReservedQty:newReservedRemaining,lotAllocations,cogs };
}
function applyInventoryDeliveryInTransaction(transaction, orderRef, order, deliveryQty, actor, sourceId) {
    return applyInventoryDeliveryDeltaInTransaction(transaction, order, deliveryQty, actor, sourceId);
}

async function applyInventoryReturnDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, previousReturnRecord) {
    if (!deltaQty || (order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return {lotAllocations:[],cogs:0};
    const productKey = inventoryProductKey(order);
    const warehouseId = order.warehouseId || defaultWarehouse()?.id || '';
    const invRef = inventoryRefFor(order);
    const whRef = warehouseId ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)) : null;
    if (!invRef || !whRef) throw new Error('此訂單沒有可追蹤的出貨倉庫。');
    const deliveryItemId=String(order.itemId||'').trim();
    if(!deliveryItemId) throw new Error('退貨品項缺少 itemId，無法安全對應庫存占用紀錄。');
    const reservationRef=db.collection('inventoryReservations').doc(`${sourceId}__${deliveryItemId}`);
    const invSnap = await transaction.get(invRef);
    const whSnap = await transaction.get(whRef);
    const reservationSnap = await transaction.get(reservationRef);
    if (!whSnap.exists) throw new Error('找不到原出貨倉庫庫存。');
    const inv=inventoryNumbers(invSnap.exists?invSnap.data():{}), wh=inventoryNumbers(whSnap.data());
    if (deltaQty < 0 && wh.onHand < Math.abs(deltaQty)) {
        throw new Error('刪除／縮減退貨後會造成庫存小於 0。');
    }
    const now=new Date().toISOString();
    let lotAllocations=[],cogs=0;
    if(deltaQty>0){
        const available=window.YushinSupply.availableReturnAllocations(savedDeliveryRecords(order),savedReturnRecords(order));
        const plan=window.YushinSupply.reverseLotAllocations([{qty:available.reduce((sum,row)=>sum+Number(row.qty||0),0),lotAllocations:available}],deltaQty);
        lotAllocations=plan.allocations;cogs=plan.totalCost;
        for(const row of lotAllocations){
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            const lotSnap=await transaction.get(lotRef);
            if(!lotSnap.exists)throw new Error(`找不到原出貨批次 ${row.lotNo||row.lotId}，無法辦理退貨。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)+row.qty,updatedAt:now});
        }
    }else{
        const plan=window.YushinSupply.reverseLotAllocations(previousReturnRecord?[previousReturnRecord]:[],Math.abs(deltaQty));
        lotAllocations=plan.allocations.map(row=>({...row,qty:-row.qty,cost:-row.cost}));cogs=-plan.totalCost;
        for(const row of plan.allocations){
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            const lotSnap=await transaction.get(lotRef);
            if(!lotSnap.exists||Number(lotSnap.data().remainingQty||0)<row.qty)throw new Error(`批次 ${row.lotNo||row.lotId} 庫存不足，無法刪除／縮減退貨。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)-row.qty,updatedAt:now});
        }
    }
    // 正常訂單退貨後要把商品重新保留給原訂單，供補送使用。
    // 已取消／作廢訂單只把退貨放回自由庫存，不能重新占住庫存；若遇到殘留占用也一併釋放。
    const currentReservation=Math.max(0,Number(reservationSnap.exists?reservationSnap.data().quantity:0));
    const returnKeepsReservation=normalizedOrderStatus(order)==='normal';
    const nextReservation=returnKeepsReservation?Math.max(0,currentReservation+deltaQty):0;
    const reservationDelta=nextReservation-currentReservation;
    const nextReserved=Math.max(0,inv.reserved+reservationDelta);
    const nextWarehouseReserved=Math.max(0,wh.reserved+reservationDelta);
    if (invSnap.exists) transaction.set(invRef,{onHand:Math.max(0,inv.onHand+deltaQty),reserved:nextReserved,incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:wh.onHand+deltaQty,reserved:nextWarehouseReserved,incoming:wh.incoming,updatedAt:now},{merge:true});
    const reservationStatus=returnKeepsReservation?(nextReservation>0?'active':'fulfilled'):'released';
    transaction.set(reservationRef,{...inventoryReservationPayload(sourceId,order,nextReservation,reservationStatus),itemId:deliveryItemId,warehouseId},{merge:true});
    transaction.set(db.collection('inventoryMovements').doc(),{
        type:deltaQty>0?'return_in':'return_reversal',qty:deltaQty,productKey,warehouseId,
        fulfillmentType:'WAREHOUSE',sourceType:DOCUMENT_TYPES.ORDER,sourceId,
        createdAt:now,createdBy:actor,lotAllocations,costPending:true,reservationDelta,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    });
    return {lotAllocations,cogs,reservationDelta,newReservedQty:nextReservation};
}

window.quickCompleteDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    const cachedProgress = deliveryProgressInfo(cachedOrder);
    if (normalizedOrderStatus(cachedOrder) !== 'normal') { alert('已取消的訂單不能送貨。'); return; }
    if (cachedProgress.state === 'complete') return quickCancelAllDelivery(orderId);
    if (cachedProgress.remaining <= 0) return;
    const fulfillment=fulfillmentProgressInfo(cachedOrder);
    const allItems=normalizedOrderItems(cachedOrder);
    const warehouseItems=allItems.filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP');
    if (allItems.length > 1) {
        alert('多品項訂單請逐品項登錄送貨，確保送貨與退貨都能追蹤到正確品項。');
        openDeliveryModal(orderId);
        openPartialDeliveryForm();
        return;
    }
    if (warehouseItems.length && fulfillment.shippable < cachedProgress.remaining) {
        alert(fulfillment.shippable > 0
            ? `目前只有 ${fulfillment.shippable} 個已完成打單可出貨，請使用分批送貨。`
            : '目前尚未完成打單，不能送貨。');
        if (fulfillment.shippable > 0) { openDeliveryModal(orderId); openPartialDeliveryForm(); }
        return;
    }
    const today = localDateString();
    const optimisticBefore = {
        deliveryRecords: savedDeliveryRecords(cachedOrder).slice(), deliveredQty: cachedOrder.deliveredQty,
        isDelivered: cachedOrder.isDelivered, statusHistory: [...(cachedOrder.statusHistory || [])]
    };
    const optimisticActor = deliveryActor();
    const optimisticAt = new Date().toISOString();
    cachedOrder.deliveryRecords = [...optimisticBefore.deliveryRecords, { id: `pending-${Date.now()}`, date: today, qty: cachedProgress.remaining, notes: '一鍵完成剩餘送貨', createdBy: optimisticActor, createdAt: optimisticAt }];
    cachedOrder.deliveredQty = cachedProgress.total;
    cachedOrder.isDelivered = true;
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
            const transactionItems=normalizedOrderItems(order);
            // UI 已阻擋多品項一鍵送貨；transaction 仍要以最新資料再次驗證，
            // 避免 stale cache 或另一端剛修改品項後寫入無法歸屬品項的送貨紀錄。
            if (transactionItems.length !== 1) throw new Error('多品項訂單不能一鍵完成送貨，請逐品項登錄。');
            if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('這筆舊資料已視為全數送貨。');
            const total = orderQuantity(order);
            const records = savedDeliveryRecords(order).slice();
            const alreadyDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const alreadyReturned = returnedQuantity(order);
            const effectiveDelivered = Math.max(0, alreadyDelivered - alreadyReturned);
            const remaining = Math.max(0, total - effectiveDelivered);
            if (!total || remaining <= 0) throw new Error('這筆訂單已無尚未送貨數量。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const record = { id: deliveryRecordId(), itemId:transactionItems[0].itemId, date: today, qty: remaining, notes: '一鍵完成剩餘送貨', createdBy: actor, createdAt: now };
            records.push(record);
            const history = { action: 'create', source: 'quick_complete', recordId: record.id, before: null, after: record, by: actor, at: now };
            const statusEntries = [];
            const inventoryResult=await applyInventoryDeliveryInTransaction(transaction, ref, order, remaining, actor, orderId);
            record.lotAllocations=inventoryResult?.lotAllocations||[];
            record.cogs=Number(inventoryResult?.cogs||0);
            records[records.length-1]=record;
            const nextItems=transactionItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            const grossAfterDelivery = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const effectiveAfterDelivery = Math.max(0, grossAfterDelivery - returnedQuantity(order));
            const updates = {
                items:nextItems, deliveryRecords: records, deliveredQty: grossAfterDelivery, isDelivered: effectiveAfterDelivery >= total,
                deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history)
            };
            if (statusEntries.length) updates.statusHistory = firebase.firestore.FieldValue.arrayUnion(...statusEntries);
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
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
    if (!cachedOrder || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (returnedQuantity(cachedOrder) > 0) { alert('這筆訂單已有退貨紀錄，請先從 ⋯ 中更正或刪除退貨紀錄。'); return; }
    if (normalizedOrderItems(cachedOrder).length > 1) {
        alert('舊版多品項訂單不能使用一鍵取消全部送貨，請逐品項更正送貨紀錄，避免庫存還原到錯誤品項。');
        openDeliveryModal(orderId);
        return;
    }
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
            // 前端雖已擋多品項，但 transaction 必須再次依最新 Firestore 資料驗證，
            // 避免 stale cache／重複操作把整張訂單的庫存還原到錯誤品項。
            if (normalizedOrderItems(order).length > 1) throw new Error('多品項訂單不能一鍵取消全部送貨，請逐品項更正送貨紀錄。');
            if (returnedQuantity(order) > 0) throw new Error('這筆訂單已有退貨紀錄，請先更正退貨紀錄。');
            const progress = deliveryProgressInfo(order);
            if (progress.state !== 'complete') throw new Error('這筆訂單目前不是全數已送貨狀態。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const before = savedDeliveryRecords(order).length
                ? { records: savedDeliveryRecords(order), deliveredQty: progress.delivered }
                : { legacyEstimated: true, estimatedDate: order.orderDate || '', deliveredQty: progress.delivered };
            const history = { action: 'cancel_all', source: 'quick_toggle', before, after: { records: [], deliveredQty: 0 }, by: actor, at: now };
            const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, order, -progress.delivered, actor, orderId, savedDeliveryRecords(order));
            const currentItems=normalizedOrderItems(order);
            const nextItems=currentItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            const updates = { items:nextItems, deliveryRecords: [], deliveredQty: 0, isDelivered: false, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
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
    const editable = canManageOrderLifecycleCapability() && canEditPage('orders.list');
    const isEditing = !!document.getElementById('deliveryEditId').value;
    document.getElementById('deliveryFormPanel').style.display = editable && (normalizedOrderStatus(order) === 'normal' || isEditing) && (deliveryPartialFormOpen || isEditing) ? '' : 'none';
    const progress = deliveryProgressInfo(order);
    const lifecycle = orderLifecycleInfo(order);
    const locked = lifecycle.status !== 'normal';
    const syncing = pendingDeliveryOrderIds.has(order.id);
    const editableSteps = editable && !locked && !syncing;
    const purchase=purchaseProgressInfo(order);
    const fulfillment=fulfillmentProgressInfo(order);
    document.getElementById('orderWorkflowSteps').innerHTML = `
        <button type="button" class="workflow-step ${['ordered','not_required','direct'].includes(purchase.state)?'done':purchase.state==='partial'?'partial':''}" disabled><span>1</span>${escapeHtml(purchase.label)}</button>
        <button type="button" class="workflow-step ${['ready','direct'].includes(fulfillment.state)?'done':fulfillment.state==='partial'?'partial':''}" disabled><span>2</span>${escapeHtml(fulfillment.label)}</button>
        <button type="button" class="workflow-step ${progress.state==='complete'?'done':progress.state==='partial'?'partial':''}" ${editableSteps&&progress.remaining>0?'onclick="openPartialDeliveryForm()"':'disabled'}><span>3</span>${escapeHtml(progress.label)}</button>
        <button type="button" class="workflow-step ${order.isBilled?'done':''}" ${editableSteps?`onclick="toggleOrderProgressStatus('isBilled', ${!order.isBilled})"`:'disabled'}><span>4</span>${order.isBilled?'已報帳':'未報帳'}</button>`;
    const deliveryItems=normalizedOrderItems(order);
    const deliveryItemNameById=new Map(deliveryItems.map(item=>[item.itemId,item.itemName||item.itemId||'']));
    const itemSummary=deliveryItems.map(item=>{
        const grossDelivered=savedDeliveryRecords(order)
            .filter(r=>(r.itemId||((deliveryItems.length===1&&deliveryItems[0]?.itemId)||''))===item.itemId)
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
        const returned=savedReturnRecords(order)
            .filter(r=>(r.itemId||((deliveryItems.length===1&&deliveryItems[0]?.itemId)||''))===item.itemId)
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
        const delivered=Math.max(0,grossDelivered-returned);
        const returnLabel=returned>0?`（已退 ${returned}）`:'';
        return `<div><strong>${escapeHtml(item.itemName||'未命名品項')}</strong>（${escapeHtml(item.itemCode||'無貨號')}） ${delivered}/${Number(item.qty||0)}${returnLabel}</div>`;
    }).join('');
    document.getElementById('deliveryOrderSummary').innerHTML = itemSummary + `
        <div style="margin-top:6px;">整張訂單：${progress.delivered}/${progress.total}</div>
        ${progress.isLegacyEstimated ? '<br><span class="delivery-estimated">這是舊版「已送貨」資料，日期暫以訂單日期推估。</span>' : ''}`;
    const deliveryForm=document.getElementById('deliveryFormPanel');
    if(deliveryForm&&deliveryItems.length>1){
        let select=document.getElementById('deliveryItemId');
        if(!select){
            select=document.createElement('select');select.id='deliveryItemId';select.style.marginBottom='8px';
            deliveryForm.insertBefore(select,deliveryForm.firstChild);
        }
        const current=select.value;
        select.innerHTML=deliveryItems.map(item=>`<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemCode||'')} ${escapeHtml(item.itemName||'')}</option>`).join('');
        if(deliveryItems.some(item=>item.itemId===current))select.value=current;
        select.style.display='';
    }else{
        const select=document.getElementById('deliveryItemId');if(select)select.style.display='none';
    }
    renderOrderStatusHistory(order);

    const tbody = document.getElementById('deliveryRecordsBody');
    const partialButton = document.getElementById('openPartialDeliveryBtn');
    if (partialButton) partialButton.style.display = editable && !locked && progress.remaining > 0 ? '' : 'none';
    const records = savedDeliveryRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (records.length) {
        tbody.innerHTML = records.map(record => `<tr>
            <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td>
            <td>${record.itemId ? escapeHtml(deliveryItemNameById.get(record.itemId)||record.itemId)+'<br>' : ''}${escapeHtml(record.notes || '')}</td>
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
    const orderItems=normalizedOrderItems(order);
    const targetItem=orderItems.find(item=>item.itemId===record.itemId) || (orderItems.length===1?orderItems[0]:null);
    if(!targetItem){alert('找不到這筆送貨紀錄對應的品項，無法安全編輯。');return;}
    document.getElementById('deliveryEditId').value = record.id;
    const itemSelect=document.getElementById('deliveryItemId');
    if(itemSelect){
        itemSelect.value=targetItem.itemId;
        itemSelect.disabled=true;
        itemSelect.style.display=orderItems.length>1?'':'none';
    }
    document.getElementById('deliveryDate').value = record.date || localDateString();
    document.getElementById('deliveryQty').value = record.qty;
    document.getElementById('deliveryNotes').value = record.notes || '';
    document.getElementById('deliveryFormTitle').innerText = '編輯送貨紀錄';
    document.getElementById('deliveryCancelEditBtn').style.display = '';
    document.getElementById('deliveryFormPanel').style.display = '';
    const otherDelivered=savedDeliveryRecords(order)
        .filter(row=>row.id!==recordId&&((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const returned=savedReturnRecords(order)
        .filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const otherNetDelivered=Math.max(0,otherDelivered-returned);
    const maxQty=Math.max(0,Number(targetItem.qty||targetItem.orderedQty||0)-otherNetDelivered);
    document.getElementById('deliveryFormHint').innerText = `此筆最多可改為 ${maxQty} 個。`;
};

window.saveDeliveryRecord = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限負責業務、工程師或管理員。'); return; }
    const orderId = currentDeliveryOrderId;
    const date = document.getElementById('deliveryDate').value;
    const qty = parseFloat(document.getElementById('deliveryQty').value);
    const notes = document.getElementById('deliveryNotes').value.trim();
    const editId = document.getElementById('deliveryEditId').value;
    if (!orderId || !date || !Number.isFinite(qty) || qty <= 0) {
        alert('請填寫送貨日期與大於 0 的送貨數量。');
        return;
    }
    if (pendingDeliveryOrderIds.has(orderId)) return;
    const saveButton = document.querySelector('[onclick="saveDeliveryRecord()"]');
    pendingDeliveryOrderIds.add(orderId);
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = '儲存中…'; }
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
            const orderItems=normalizedOrderItems(order);
            const requestedItemId=previous?.itemId||document.getElementById('deliveryItemId')?.value||orderItems[0]?.itemId||'item-1';
            const targetItem=orderItems.find(item=>item.itemId===requestedItemId)||orderItems[0];
            if(!targetItem)throw new Error('找不到送貨品項。');
            const itemOtherDelivered=records.filter(r=>r.id!==editId&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
            const itemReturned=savedReturnRecords(order).filter(r=>((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
            // 退貨後補送必須以「有效送貨量」驗證，而不是歷史累計送貨量。
            // 例如訂購10、曾送10、退2，可再補送2；歷史送貨會成為12，但有效送貨仍是10。
            const itemGrossAfter=itemOtherDelivered+qty;
            if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 累計送貨數量不能低於已登錄的退貨數量 ${itemReturned}。`);
            const itemOtherNetDelivered=Math.max(0,itemOtherDelivered-itemReturned);
            if(itemOtherNetDelivered+qty>Number(targetItem.qty||0)+1e-9)throw new Error(`${targetItem.itemName||'品項'} 有效送貨數量將超過訂購數量。`);
            if((targetItem.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
                const preparedQty=Number(targetItem.dispatchPreparedQty||0);
                if(itemOtherNetDelivered+qty>preparedQty+1e-9)throw new Error(`${targetItem.itemName||'品項'} 目前已打單可出貨數量只有 ${Math.max(0,preparedQty-itemOtherNetDelivered)}。`);
            }
            const record = previous
                ? { ...previous, itemId:targetItem.itemId, date, qty, notes, updatedBy: actor, updatedAt: now }
                : { id: deliveryRecordId(), itemId:targetItem.itemId, date, qty, notes, createdBy: actor, createdAt: now };
            if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
            const totalDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const total = orderQuantity(order);
            if (!total) throw new Error('訂購數量必須大於 0，才能登錄送貨。');
            const effectiveTotalDelivered=Math.max(0,totalDelivered-returnedQuantity(order));
            if (effectiveTotalDelivered > total + 1e-9) throw new Error(`有效送貨數量 ${effectiveTotalDelivered} 超過訂購數量 ${total}。`);
            const alreadyReturned = returnedQuantity(order);
            if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`累計送貨數量不能低於已登錄的退貨數量 ${alreadyReturned}。`);
            const action = previous ? 'edit' : 'create';
            const history = { action, recordId: record.id, before: previous, after: record, by: actor, at: now };
            const updates = { deliveryRecords: records, deliveredQty: totalDelivered, isDelivered: effectiveTotalDelivered >= total, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            const deliveryDelta = qty - Number(previous?.qty || 0);
            if(deliveryDelta){
                const itemRecords=records.filter(r=>r.itemId===targetItem.itemId);
                const itemOrder={...order,...targetItem,qty:Number(targetItem.qty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
                const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction,itemOrder,deliveryDelta,actor,orderId,deliveryDelta<0&&previous?[previous]:null);
                const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
                updates.items=syncedItems;
                if(deliveryDelta>0){
                    record.lotAllocations=inventoryResult.lotAllocations||[];
                    record.cogs=Number(inventoryResult.cogs||0);
                    const recordIndex=records.findIndex(r=>r.id===record.id);
                    if(recordIndex>=0)records[recordIndex]=record;
                    updates.deliveryRecords=records;
                } else if(previous){
                    const reversed=(inventoryResult.lotAllocations||[]).map(row=>({...row,qty:Math.abs(Number(row.qty||0))}));
                    record.lotAllocations=window.YushinSupply.allocationsAfterReversal(previous.lotAllocations||[],reversed);
                    record.cogs=record.lotAllocations.reduce((sum,row)=>sum+Number(row.cost??(Number(row.qty||0)*Number(row.unitCost||0))),0);
                    const recordIndex=records.findIndex(r=>r.id===record.id);
                    if(recordIndex>=0)records[recordIndex]=record;
                    updates.deliveryRecords=records;
                }
            }
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
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
    } finally {
        pendingDeliveryOrderIds.delete(orderId);
        if (saveButton) { saveButton.disabled = false; saveButton.textContent = '💾 儲存送貨紀錄'; }
    }
};

window.deleteDeliveryRecord = async function(recordId) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限負責業務、工程師或管理員。'); return; }
    if (!confirm('確定要刪除這筆送貨紀錄嗎？異動軌跡仍會保留。')) return;
    const orderId = currentDeliveryOrderId;
    if (!orderId || pendingDeliveryOrderIds.has(orderId)) return;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
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
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const history = { action: 'delete', recordId, before: removed, after: null, by: actor, at: now };
            const orderItems=normalizedOrderItems(order);
            const targetItem=orderItems.find(item=>item.itemId===removed.itemId) || (orderItems.length===1?orderItems[0]:null);
            if(!targetItem)throw new Error('找不到原送貨品項，無法安全還原庫存。');
            const itemRecords=records.filter(r=>((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId));
            const itemGrossAfter=itemRecords.filter(r=>r.id!==recordId).reduce((sum,row)=>sum+Number(row.qty||0),0);
            const itemReturned=savedReturnRecords(order)
                .filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
                .reduce((sum,row)=>sum+Number(row.qty||0),0);
            if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 刪除後的送貨數量會低於已登錄的退貨數量 ${itemReturned}，請先更正退貨紀錄。`);
            const itemOrder={...order,...targetItem,itemId:targetItem.itemId,qty:Number(targetItem.qty||targetItem.orderedQty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
            const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, itemOrder, -Number(removed.qty || 0), actor, orderId, [removed]);
            const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            const effectiveDelivered=Math.max(0,totalDelivered-returnedQuantity(order));
            const updates = { items:syncedItems, deliveryRecords: next, deliveredQty: totalDelivered, isDelivered: effectiveDelivered >= orderQuantity(order) && orderQuantity(order) > 0, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
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
    } finally {
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
    }
};

window.clearLegacyDelivery = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限負責業務、工程師或管理員。'); return; }
    if (!confirm('確定取消這筆舊資料的「已送貨」推估嗎？取消後請重新登錄正確送貨日期與數量。')) return;
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order) return;
    if (returnedQuantity(order) > 0) { alert('這筆訂單已有退貨紀錄，請先更正或刪除退貨紀錄。'); return; }
    const now = new Date().toISOString();
    const history = { action: 'clear_legacy_estimate', before: { isDelivered: true, estimatedDate: order.orderDate || '' }, after: null, by: deliveryActor(), at: now };
    try {
        const updates={isDelivered:false,deliveredQty:0,deliveryRecords:[],deliveryHistory:firebase.firestore.FieldValue.arrayUnion(history),updatedAt:now};
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        await db.collection('orders').doc(order.id).update(updates);
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

function returnItemDeliveredQty(order,itemId) {
    const items=normalizedOrderItems(order);
    return savedDeliveryRecords(order)
        .filter(record=>(record.itemId||((items.length===1&&items[0]?.itemId)||''))===itemId)
        .reduce((sum,record)=>sum+Number(record.qty||0),0);
}

function returnItemReturnedQty(order,itemId,excludeRecordId='') {
    const items=normalizedOrderItems(order);
    return savedReturnRecords(order)
        .filter(record=>record.id!==excludeRecordId&&(record.itemId||((items.length===1&&items[0]?.itemId)||''))===itemId)
        .reduce((sum,record)=>sum+Number(record.qty||0),0);
}

function populateReturnItemOptions(order,selectedItemId='') {
    const select=document.getElementById('returnItemId');
    if(!select||!order)return;
    const items=normalizedOrderItems(order);
    const options=items.filter(item=>returnItemDeliveredQty(order,item.itemId)>0);
    select.innerHTML=options.map(item=>`<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemCode||item.itemName||item.itemId)}｜${escapeHtml(item.itemName||'')}</option>`).join('');
    const preferred=selectedItemId||options[0]?.itemId||'';
    if(preferred&&options.some(item=>item.itemId===preferred))select.value=preferred;
    select.disabled=!!document.getElementById('returnEditId')?.value;
}

window.updateReturnFormHint = function() {
    const order=ordersCache.find(item=>item.id===currentLifecycleOrderId);
    const hint=document.getElementById('returnFormHint');
    if(!order||!hint)return;
    const items=normalizedOrderItems(order);
    const selectedItemId=document.getElementById('returnItemId')?.value||(items.length===1?items[0]?.itemId:'');
    const editId=document.getElementById('returnEditId')?.value||'';
    if(!selectedItemId){hint.innerText='請先選擇要退貨的品項。';return;}
    const item=items.find(row=>row.itemId===selectedItemId);
    const delivered=returnItemDeliveredQty(order,selectedItemId);
    const otherReturned=returnItemReturnedQty(order,selectedItemId,editId);
    hint.innerText=`${item?.itemName||item?.itemCode||'此品項'}目前最多還可登錄 ${Math.max(0,delivered-otherReturned)} 個退貨。`;
};

window.resetReturnForm = function() {
    document.getElementById('returnEditId').value = '';
    document.getElementById('returnDate').value = localDateString();
    document.getElementById('returnQty').value = '';
    document.getElementById('returnReason').value = '';
    document.getElementById('returnFormTitle').innerText = '新增退貨紀錄';
    document.getElementById('returnCancelEditBtn').style.display = 'none';
    const order=ordersCache.find(item=>item.id===currentLifecycleOrderId);
    populateReturnItemOptions(order);
    updateReturnFormHint();
};

function renderOrderLifecycleModal() {
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    if (!order) return;
    const editable = canManageOrderLifecycleCapability() && canEditPage('orders.list');
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
    const editingRecord=records.find(record=>record.id===document.getElementById('returnEditId')?.value);
    populateReturnItemOptions(order,editingRecord?.itemId||'');
    updateReturnFormHint();
    onOrderLifecycleStatusChange();
}

window.saveOrderLifecycleStatus = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限負責業務、工程師或管理員。'); return; }
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
    const saveButton = document.getElementById('orderLifecycleSaveBtn');
    pendingLifecycleOrderIds.add(order.id);
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    try {
        let savedOrder;
        await db.runTransaction(async transaction => {
            const ref = db.collection('orders').doc(order.id);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const liveOrder = snapshot.data();
            const livePrevious = { status: normalizedOrderStatus(liveOrder), date: liveOrder.orderStatusDate || '', reason: liveOrder.orderStatusReason || '' };
            if (livePrevious.status !== nextStatus) {
                await adjustInventoryReservationForLifecycle(transaction, order.id, liveOrder, nextStatus, actor);
            }
            const liveHistory = { action: nextStatus === 'normal' && livePrevious.status !== 'normal' ? 'restore' : 'status_change', before: livePrevious, after: { status: nextStatus, date, reason }, by: actor, at };
            const updates = {
                status: nextStatus === 'cancelled' ? BUSINESS_STATUS.CANCELLED : BUSINESS_STATUS.ACTIVE,
                orderStatus: nextStatus, orderStatusDate: date, orderStatusReason: reason,
                orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(liveHistory), updatedAt: at
            };
            Object.assign(updates,orderWorkIndexFields({...liveOrder,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...liveOrder, ...updates, orderLifecycleHistory: [...(liveOrder.orderLifecycleHistory || []), liveHistory] };
        });
        const index = ordersCache.findIndex(item => item.id === order.id);
        if (index >= 0) ordersCache[index] = { id: order.id, ...savedOrder };
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
    populateReturnItemOptions(order,record.itemId||'');
    const returnItemSelect=document.getElementById('returnItemId');if(returnItemSelect)returnItemSelect.disabled=true;
    document.getElementById('returnDate').value = record.date || localDateString();
    document.getElementById('returnQty').value = record.qty;
    document.getElementById('returnReason').value = record.reason || '';
    document.getElementById('returnFormTitle').innerText = '編輯退貨紀錄';
    document.getElementById('returnCancelEditBtn').style.display = '';
    document.getElementById('returnFormPanel').style.display = '';
    updateReturnFormHint();
};

window.saveReturnRecord = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限負責業務、工程師或管理員。'); return; }
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
            // 已取消訂單仍可能有取消前已實際送出的商品；允許針對既有送貨辦理退貨，數量仍受逐品項已送貨量限制。
            const now = new Date().toISOString();
            const actor = deliveryActor();
            const previous = existingIndex >= 0 ? records[existingIndex] : null;
            const orderItems=normalizedOrderItems(order);
            const deliveredByItem=new Map();
            savedDeliveryRecords(order).forEach(row=>{
                const id=row.itemId || (orderItems.length===1?orderItems[0]?.itemId:'');
                if(id)deliveredByItem.set(id,Number(deliveredByItem.get(id)||0)+Number(row.qty||0));
            });
            const requestedItemId=previous?.itemId || document.getElementById('returnItemId')?.value || (orderItems.length===1?orderItems[0]?.itemId:'');
            const targetItem=orderItems.find(item=>item.itemId===requestedItemId) || (orderItems.length===1?orderItems[0]:null);
            if(!targetItem)throw new Error('多品項訂單的退貨必須指定原送貨品項。');
            const otherReturned=records.filter(r=>r.id!==editId&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((sum,row)=>sum+Number(row.qty||0),0);
            if(otherReturned+qty>Number(deliveredByItem.get(targetItem.itemId)||0)+1e-9)throw new Error(`${targetItem.itemName||'品項'} 退貨數量超過該品項已送貨數量。`);
            const record = previous ? { ...previous, itemId:targetItem.itemId, date, qty, reason, updatedBy: actor, updatedAt: now } : { id: lifecycleRecordId(), itemId:targetItem.itemId, date, qty, reason, createdBy: actor, createdAt: now };
            if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
            const totalReturned = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const delivered = deliveredQuantity(order);
            if (totalReturned > delivered + 1e-9) throw new Error(`累計退貨數量 ${totalReturned} 超過已送貨數量 ${delivered}。`);
            const history = { action: previous ? 'edit' : 'create', recordId: record.id, before: previous, after: record, by: actor, at: now };
            const returnDelta = qty - Number(previous?.qty || 0);
            let syncedReservedQty=null;
            if (returnDelta){
                const itemDeliveries=savedDeliveryRecords(order).filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId));
                const itemReturns=savedReturnRecords(order).filter(row=>row.id!==editId&&((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId));
                const itemOrder={...order,...targetItem,itemId:targetItem.itemId,qty:Number(targetItem.qty||targetItem.orderedQty||0),deliveryRecords:itemDeliveries,returnRecords:itemReturns};
                const inventoryResult=await applyInventoryReturnDeltaInTransaction(transaction, itemOrder, returnDelta, actor, orderId, previous);
                syncedReservedQty=Number(inventoryResult?.newReservedQty??targetItem.reservedQty??0);
                if(returnDelta>0){
                    record.lotAllocations=[...(previous?.lotAllocations||[]),...(inventoryResult.lotAllocations||[])];
                }else if(previous){
                    const reversed=(inventoryResult.lotAllocations||[]).map(row=>({...row,qty:Math.abs(Number(row.qty||0))}));
                    record.lotAllocations=window.YushinSupply.allocationsAfterReversal(previous.lotAllocations||[],reversed);
                }
                record.cogs=record.lotAllocations.reduce((sum,row)=>sum+Number(row.cost??(Number(row.qty||0)*Number(row.unitCost||0))),0);
                if(existingIndex>=0)records[existingIndex]=record;else records[records.length-1]=record;
            }
            const syncedItems=syncedReservedQty===null?orderItems:orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:syncedReservedQty}:item);
            const effectiveDelivered=Math.max(0,delivered-totalReturned);
            const updates = { items:syncedItems, returnRecords: records, returnedQty: totalReturned, isDelivered:effectiveDelivered>=orderQuantity(order)&&orderQuantity(order)>0, returnHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
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
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限負責業務、工程師或管理員。'); return; }
    if (!confirm('確定要刪除這筆退貨紀錄嗎？異動軌跡仍會保留。')) return;
    const orderId = currentLifecycleOrderId;
    if (!orderId || pendingReturnOrderIds.has(orderId)) return;
    pendingReturnOrderIds.add(orderId);
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
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const history = { action: 'delete', recordId, before: removed, after: null, by: actor, at: now };
            const orderItems=normalizedOrderItems(order);
            const targetItem=orderItems.find(item=>item.itemId===removed.itemId) || (orderItems.length===1?orderItems[0]:null);
            if(!targetItem)throw new Error('找不到原退貨品項，無法安全還原庫存。');
            const itemDeliveries=savedDeliveryRecords(order).filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId));
            const itemReturns=records.filter(row=>row.id!==recordId&&((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId));
            const itemOrder={...order,...targetItem,itemId:targetItem.itemId,qty:Number(targetItem.qty||targetItem.orderedQty||0),deliveryRecords:itemDeliveries,returnRecords:itemReturns};
            const inventoryResult=await applyInventoryReturnDeltaInTransaction(transaction, itemOrder, -Number(removed.qty || 0), actor, orderId, removed);
            const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            const effectiveDelivered=Math.max(0,deliveredQuantity(order)-totalReturned);
            const updates = { items:syncedItems, returnRecords: next, returnedQty: totalReturned, isDelivered:effectiveDelivered>=orderQuantity(order)&&orderQuantity(order)>0, returnHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, returnHistory: [...(order.returnHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetReturnForm();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) { alert('刪除失敗：' + err.message); }
    finally { pendingReturnOrderIds.delete(orderId); }
};

window.updateOrderField = function(orderId, field, value) {
    const o = ordersCache.find(x => x.id === orderId);
    if (!o || !canEditPage('orders.list')) return;
    if (field === 'costPrice') {
        const product = findPriceItemForOrder(o);
        if (product && authorizationTypeForProduct(product) === 'AUTHORIZED') {
            alert('代理產品成本請在採購單維護；不會寫入業務可讀的訂單文件。');
            renderOrdersList();
            return;
        }
    }
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

let newOrderDraftItems = [];
const ORDER_DRAFT_STORAGE_PREFIX = 'order_draft_v2';
let requestedOrderOwnerUid = '';

function populateOrderOwnerSelect() {
    const wrap = document.getElementById('orderOwnerWrap');
    const select = document.getElementById('orderOwnerUid');
    if (!wrap || !select) return;
    wrap.style.display = currentUserRole === 'purchaser' ? '' : 'none';
    if (currentUserRole !== 'purchaser') return;
    const salespeople = salesList.filter(person => person.role === 'sales' && person.active !== false && person.uid && person.code);
    select.replaceChildren(new Option('請選擇負責業務', ''));
    salespeople.forEach(person => select.add(new Option(`${person.name}（${person.code}）`, person.uid)));
    select.value = salespeople.some(person => person.uid === requestedOrderOwnerUid) ? requestedOrderOwnerUid : '';
}

function orderDraftStorageKey() {
    return `${ORDER_DRAFT_STORAGE_PREFIX}:${currentUser?.uid || 'anonymous'}`;
}

function pendingOrderCreateKey() {
    return `${orderDraftStorageKey()}:pending_order_id`;
}

async function createOrResumeNewOrder(data) {
    const key=pendingOrderCreateKey();
    let orderId=localStorage.getItem(key);
    if(!orderId){
        orderId=db.collection('orders').doc().id;
        // 記下編號後才寫入雲端；斷線後重試仍會指向同一張訂單。
        localStorage.setItem(key,orderId);
    }
    const ref=db.collection('orders').doc(orderId);
    let savedData;
    await db.runTransaction(async tx=>{
        const snap=await tx.get(ref);
        if(snap.exists){
            savedData=snap.data();
            if(savedData.createdByUid!==currentUser?.uid || savedData.status!==BUSINESS_STATUS.ACTIVE)
                throw new Error('待確認的訂單已由其他流程變更，請先檢查訂單清單。');
        }else{
            tx.set(ref,data);
            savedData=data;
        }
    });
    return {id:orderId,data:savedData};
}

function orderDraftFieldValue(id) {
    return document.getElementById(id)?.value ?? '';
}

function collectOrderDraft() {
    return {
        savedAt:new Date().toISOString(),
        ownerUid:orderDraftFieldValue('orderOwnerUid'),
        date:orderDraftFieldValue('orderDateInput'),customerName:orderDraftFieldValue('orderCustomer'),
        itemCode:orderDraftFieldValue('orderItemCode'),itemName:orderDraftFieldValue('orderItemName'),itemNameEn:orderDraftFieldValue('orderItemNameEn'),productLine:orderDraftFieldValue('orderProductLine'),spec:orderDraftFieldValue('orderSpec'),
        brand:getBrandFieldValue('orderBrand','orderBrandOther'),qty:orderDraftFieldValue('orderQty'),
        unitPrice:orderDraftFieldValue('orderUnitPrice'),costPrice:orderDraftFieldValue('orderCostPrice'),
        procurementType:orderDraftFieldValue('orderProcurementType')||'PURCHASING_PO',
        fulfillmentType:orderDraftFieldValue('orderFulfillmentType')||'WAREHOUSE',warehouseId:orderDraftFieldValue('orderWarehouse'),
        transactionType:orderDraftFieldValue('orderTransactionType'),invoiceTitle:orderDraftFieldValue('orderInvoiceTitle'),
        productId:window._orderModalProductId||'',items:newOrderDraftItems,
        sourceLink:window._orderModalSourceLink||null,
        quoteContext:window._orderModalQuoteContext||null
    };
}

function readOrderDraft() {
    try {
        const value=JSON.parse(localStorage.getItem(orderDraftStorageKey())||'null');
        return value&&typeof value==='object'?value:null;
    } catch (_) { return null; }
}

function updateOrderDraftStatus() {
    const draft=readOrderDraft();
    const status=document.getElementById('orderDraftStatus');
    const restore=document.getElementById('restoreOrderDraftBtn');
    const clear=document.getElementById('clearOrderDraftBtn');
    if(status)status.innerText=localStorage.getItem(pendingOrderCreateKey())
        ? '上一張訂單尚待確認；請恢復草稿並按儲存重試同一張訂單。'
        : (draft?.savedAt?`草稿已暫存：${new Date(draft.savedAt).toLocaleString('zh-TW')}`:'尚無暫存草稿');
    if(restore)restore.disabled=!draft;
    if(clear)clear.disabled=!draft;
}

function saveOrderDraft() {
    if(restoringOrderDraft||!document.getElementById('orderModalOverlay')?.classList.contains('active'))return;
    try { localStorage.setItem(orderDraftStorageKey(),JSON.stringify(collectOrderDraft())); updateOrderDraftStatus(); }
    catch (err) { console.warn('暫存訂單草稿失敗：',err); }
}

window.clearSavedOrderDraft=function(options={}){
    if(!options.clearPending && localStorage.getItem(pendingOrderCreateKey())){
        alert('這張訂單的儲存狀態尚待確認；請先重試，避免遺失訂單草稿。');
        return;
    }
    localStorage.removeItem(orderDraftStorageKey());
    if(options.clearPending) localStorage.removeItem(pendingOrderCreateKey());
    updateOrderDraftStatus();
    if(!options.silent)alert('訂單草稿已清除。');
};

function setOrderModalItem(item={}) {
    const normalized=normalizeNewOrderItem(item);
    document.getElementById('orderItemCode').value=normalized.itemCode||'';
    document.getElementById('orderItemName').value=normalized.itemName||'';
    const nameEn=document.getElementById('orderItemNameEn');if(nameEn)nameEn.value=normalized.itemNameEn||'';
    const spec=document.getElementById('orderSpec');if(spec)spec.value=normalized.spec||'';
    const productLineField=document.getElementById('orderProductLine');if(productLineField)productLineField.value=normalized.productLine||'';
    const codeInput=document.getElementById('orderItemCode');
    codeInput.dataset.productLine=normalized.productLine||'';
    codeInput.dataset.productType=normalized.productType||'';
    codeInput.dataset.productMasterMatched=normalized.productMasterMatched===true?'1':'0';
    if(normalized.brand)selectBrandInDropdown(document.getElementById('orderBrand'),normalized.brand);
    else document.getElementById('orderBrand').value='';
    onOrderBrandSelectChange();
    document.getElementById('orderQty').value=normalized.qty||1;
    document.getElementById('orderUnitPrice').value=normalized.unitPrice||0;
    document.getElementById('orderTotalPrice').value=normalized.totalPrice||0;
    document.getElementById('orderCostPrice').value=normalized.costPrice??'';
    const procurement=document.getElementById('orderProcurementType');if(procurement)procurement.value=normalized.procurementType||'PURCHASING_PO';
    onOrderProcurementTypeChange();
    document.getElementById('orderFulfillmentType').value=normalized.fulfillmentType||'WAREHOUSE';
    populateOrderWarehouseOptions(normalized.warehouseId||'');
    onOrderFulfillmentChange();
    window._orderModalProductId=normalized.productId||'';
    const product=findPriceItemForOrder(normalized);if(product)applyOrderProductCost(product);
    refreshOrderWarehouseStock();
}

window.restoreSavedOrderDraft=function(){
    const draft=readOrderDraft();if(!draft){updateOrderDraftStatus();return;}
    restoringOrderDraft=true;
    try {
        requestedOrderOwnerUid = draft.ownerUid || '';
        window._orderModalSourceLink = draft.sourceLink || null;
        window._orderModalQuoteContext = draft.quoteContext || null;
        populateOrderOwnerSelect();
        document.getElementById('orderDateInput').value=draft.date||'';
        document.getElementById('orderCustomer').value=draft.customerName||'';
        setOrderModalItem(draft);
        document.getElementById('orderTransactionType').value=draft.transactionType||'';
        const invoice=document.getElementById('orderInvoiceTitle');invoice.value=draft.invoiceTitle||'';invoice.disabled=draft.transactionType!=='直';
        newOrderDraftItems=Array.isArray(draft.items)?draft.items.map(normalizeNewOrderItem):[];
        renderNewOrderDraftItems();
        const title=document.getElementById('orderModalTitle');if(title)title.innerText='新增訂單（已恢復草稿）';
    } finally { restoringOrderDraft=false;updateOrderDraftStatus(); }
};

function normalizeNewOrderItem(item = {}) {
    const match=findPriceItemForOrder(item);
    const qty=Math.max(0,Number(item.qty||0));
    const unitPrice=Number(item.unitPrice||0);
    return {
        ...item,itemId:item.itemId||`item-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        itemCode:String(item.itemCode||'').trim(),itemCodeKey:normalizeHistoryItemCode(item.itemCode||''),itemName:String(item.itemName||'').trim(),
        brand:resolveBrandName(item.brand||''),qty,orderedQty:qty,unitPrice,totalPrice:qty*unitPrice,
        productId:match?.productId||item.productId||stableProductId(match||item),productLine:match?.productLine||item.productLine||'',productType:match?.productType||item.productType||'',
        productMasterMatched:!!match || item.productMasterMatched === true,
        authorizationType:match?authorizationTypeForProduct(match):(item.authorizationType||''),supplier:match?.supplier||item.supplier||'',spec:match?.spec||item.spec||'',
        procurementType:item.procurementType||'PURCHASING_PO', fulfillmentType:item.fulfillmentType||'WAREHOUSE',
        warehouseId:(item.fulfillmentType||'WAREHOUSE')==='WAREHOUSE' ? String(item.warehouseId||'') : ''
    };
}

function currentOrderModalItem() {
    const codeInput=document.getElementById('orderItemCode');
    const item={itemCode:codeInput.value,itemName:document.getElementById('orderItemName').value,itemNameEn:document.getElementById('orderItemNameEn')?.value||'',productLine:codeInput.dataset.productLine||document.getElementById('orderProductLine')?.value||'',productType:codeInput.dataset.productType||'',productMasterMatched:codeInput.dataset.productMasterMatched==='1',spec:document.getElementById('orderSpec')?.value||'',brand:getBrandFieldValue('orderBrand','orderBrandOther'),qty:document.getElementById('orderQty').value,unitPrice:document.getElementById('orderUnitPrice').value,procurementType:document.getElementById('orderProcurementType')?.value||'PURCHASING_PO',fulfillmentType:document.getElementById('orderFulfillmentType')?.value||'WAREHOUSE',warehouseId:document.getElementById('orderWarehouse')?.value||'',productId:window._orderModalProductId||''};
    const cost=document.getElementById('orderCostPrice').value;if(item.procurementType==='SALES_SELF_ORDER'&&cost!=='')item.costPrice=Number(cost);
    return normalizeNewOrderItem(item);
}

function renderNewOrderDraftItems(){
    const body=document.getElementById('newOrderItemsBody'),wrap=document.getElementById('newOrderItemsWrap');if(!body||!wrap)return;
    wrap.style.display=newOrderDraftItems.length?'':'none';
    body.innerHTML=newOrderDraftItems.map((item,index)=>`<tr><td>${escapeHtml(item.itemCode||'')}</td><td>${escapeHtml(item.itemName||'')}</td><td>${escapeHtml(item.brand||'')}</td><td>${item.qty}</td><td>${Number(item.unitPrice||0).toLocaleString()}</td><td>${item.procurementType==='SALES_SELF_ORDER'?'業務自行訂購':'採購下單'}／${item.fulfillmentType==='DIRECT_SHIP'?'原廠直送':'倉庫'}</td><td><button type="button" class="btn-small btn-secondary" onclick="editNewOrderDraftItem(${index})">編輯</button> <button type="button" class="btn-danger btn-small" onclick="removeNewOrderDraftItem(${index})">移除</button></td></tr>`).join('');
}
window.editNewOrderDraftItem=function(index){
    const item=newOrderDraftItems[index];
    if(!item)return;
    const current=currentOrderModalItem();
    if(current.itemName)newOrderDraftItems[index]=current;else newOrderDraftItems.splice(index,1);
    setOrderModalItem(item);
    renderNewOrderDraftItems();
    saveOrderDraft();
};
window.removeNewOrderDraftItem=function(index){newOrderDraftItems.splice(index,1);renderNewOrderDraftItems();saveOrderDraft();};
window.addCurrentOrderItemToDraft=function(){
    const item=currentOrderModalItem();if(!item.itemName||item.qty<=0){alert('請先完成目前品項的品名與數量。');return;}
    const duplicateIndex=newOrderDraftItems.findIndex(existing=>(existing.productId&&item.productId&&existing.productId===item.productId)||(!existing.productId&&!item.productId&&normalizeHistoryItemCode(existing.itemCode)===normalizeHistoryItemCode(item.itemCode)));
    if(duplicateIndex>=0){newOrderDraftItems[duplicateIndex]={...newOrderDraftItems[duplicateIndex],qty:Number(newOrderDraftItems[duplicateIndex].qty||0)+Number(item.qty||0)};newOrderDraftItems[duplicateIndex].totalPrice=Number(newOrderDraftItems[duplicateIndex].qty||0)*Number(newOrderDraftItems[duplicateIndex].unitPrice||0);}
    else newOrderDraftItems.push(item);renderNewOrderDraftItems();
    ['orderItemCode','orderItemName','orderItemNameEn','orderProductLine','orderSpec'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const nextCodeInput=document.getElementById('orderItemCode');delete nextCodeInput.dataset.productLine;delete nextCodeInput.dataset.productType;delete nextCodeInput.dataset.productMasterMatched;
    document.getElementById('orderQty').value=1;document.getElementById('orderUnitPrice').value=0;document.getElementById('orderTotalPrice').value=0;window._orderModalProductId='';saveOrderDraft();
};

window.openOrderModal = function(source = null) {
    requestedOrderOwnerUid = source?.ownerUid || '';
    populateOrderOwnerSelect();
    if (currentUserRole === 'purchaser') {
        ensureSalesListLoaded().then(populateOrderOwnerSelect).catch(err => console.error('讀取負責業務名單失敗：', err));
    }
    loadWarehouseMaster().then(() => {
        populateOrderWarehouseOptions(source?.warehouseId || '');
        if (source?.fulfillmentType === 'WAREHOUSE' && source?.warehouseId) {
            const warehouse=document.getElementById('orderWarehouse');
            if (warehouse) warehouse.value=source.warehouseId;
        }
    });
    populateOrderBrandDropdown();
    populateOrderCustomerSuggestions();
    newOrderDraftItems=[];renderNewOrderDraftItems();
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = source?.sourceType === DOCUMENT_TYPES.FORECAST ? 'Forecast 轉訂單' : '新增訂單';
    const today = new Date();
    document.getElementById('orderDateInput').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    ['orderCustomer', 'orderBrand', 'orderBrandOther', 'orderItemCode', 'orderItemName', 'orderItemNameEn', 'orderProductLine', 'orderSpec', 'orderInvoiceTitle'].forEach(id => {
        document.getElementById(id).value = '';
    });
    onOrderBrandSelectChange();
    document.getElementById('orderQty').value = 1;
    document.getElementById('orderUnitPrice').value = 0;
    document.getElementById('orderTotalPrice').value = 0;
    document.getElementById('orderCostPrice').value = '';
    const procurement=document.getElementById('orderProcurementType');if(procurement)procurement.value=source?.procurementType||'PURCHASING_PO';
    onOrderProcurementTypeChange();
    document.getElementById('orderFulfillmentType').value = source?.fulfillmentType || 'WAREHOUSE';
    populateOrderWarehouseOptions(source?.warehouseId || '');
    onOrderFulfillmentChange();
    document.getElementById('orderTransactionType').value = '';
    document.getElementById('orderInvoiceTitle').disabled = true;
    updateOrderDraftStatus();

    window._orderModalSourceLink = source?.sourceType && source?.sourceId
        ? { sourceType: source.sourceType, sourceId: source.sourceId }
        : null;
    window._orderModalProductId = source?.productId || '';

    if (source) {
        document.getElementById('orderCustomer').value = source.customerName || '';
        document.getElementById('orderItemCode').value = source.itemCode || '';
        document.getElementById('orderItemName').value = source.itemName || '';
        const nameEn=document.getElementById('orderItemNameEn');if(nameEn)nameEn.value=source.itemNameEn||source.nameEn||'';
        const spec=document.getElementById('orderSpec');if(spec)spec.value=source.spec||source.specification||'';
        document.getElementById('orderProductLine').value=source.productLine||'';
        document.getElementById('orderQty').value = source.qty || 1;
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
        if (sourceMatch) {
            applyOrderProductCost(sourceMatch);
            refreshOrderWarehouseStock();
        }
    }

    document.getElementById('orderModalOverlay').classList.add('active');
    if(localStorage.getItem(pendingOrderCreateKey()) && readOrderDraft()) restoreSavedOrderDraft();
};

let customerMasterSuggestionTimer = null;
let customerMasterSuggestionResults = [];

window.queueCustomerMasterSuggestions = function(value) {
    clearTimeout(customerMasterSuggestionTimer);
    const raw = String(value || '').trim();
    if (raw.length < 2) {
        customerMasterSuggestionResults = [];
        populateOrderCustomerSuggestions();
        return;
    }
    customerMasterSuggestionTimer = scheduleListSearch(customerMasterSuggestionTimer, () => searchCustomerMasterSuggestions(raw));
};

async function searchCustomerMasterSuggestions(raw) {
    const keyword = String(raw || '').trim();
    if (keyword.length < 2) return;
    try {
        // Customer Master 的 document id 由標準化客戶名稱產生，因此可用 documentId 前綴查詢，
        // 不需要為了自動完成載入整個 customers collection。
        const prefix = customerIdForName(keyword);
        const snapshot = await firestoreReadWithTimeout(
            db.collection('customers')
                .orderBy(firebase.firestore.FieldPath.documentId())
                .startAt(prefix)
                .endAt(prefix + '\uf8ff')
                .limit(20)
                .get(),
            'Customer Master 客戶建議'
        );
        // 使用者可能在等待期間繼續輸入；舊查詢結果不可覆蓋新的關鍵字。
        const currentValues = [
            document.getElementById('orderCustomer')?.value,
            document.getElementById('eqCustomer')?.value
        ].map(value => String(value || '').trim());
        if (!currentValues.includes(keyword)) return;
        customerMasterSuggestionResults = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(item => item.active !== false && item.name)
            .map(item => item.name)
            .slice(0, 20);
        populateOrderCustomerSuggestions();
    } catch (err) {
        console.warn('Customer Master 客戶建議查詢失敗：', err);
    }
}

function populateOrderCustomerSuggestions() {
    const list = document.getElementById('orderCustomerSuggestions');
    if (!list) return;
    const customersByKey = new Map();
    const names = [
        ...getRecentCustomerNames(),
        ...customerMasterSuggestionResults,
        ...ordersCache.map(order => order.customerName),
        ...equipmentList.map(equipment => equipment.customerName),
        ...myQuotesCache.map(quote => quote.clientName),
        ...myQuotesCache.map(quote => quote.ordererName),
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
    if (currentUserRole === 'purchaser') {
        requestedOrderOwnerUid = source.ownerUid || '';
        populateOrderOwnerSelect();
    }
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = '複製成新訂單';
    document.getElementById('orderCustomer').value = source.customerName || '';
    const copiedItems=normalizedOrderItems(source).map(normalizeNewOrderItem);
    const first=copiedItems[0]||normalizeNewOrderItem(source);
    newOrderDraftItems=copiedItems.slice(1);renderNewOrderDraftItems();
    document.getElementById('orderItemCode').value = first.itemCode || '';
    document.getElementById('orderItemName').value = first.itemName || '';
    document.getElementById('orderProductLine').value = first.productLine || '';
    if (first.brand) selectBrandInDropdown(document.getElementById('orderBrand'), first.brand);
    onOrderBrandSelectChange();
    document.getElementById('orderQty').value = first.qty || 1;
    document.getElementById('orderUnitPrice').value = first.unitPrice || 0;
    document.getElementById('orderFulfillmentType').value = first.fulfillmentType || 'WAREHOUSE';
    populateOrderWarehouseOptions(first.warehouseId || '');
    onOrderFulfillmentChange();
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
    saveOrderDraft();
};

window.closeOrderModal = function(options = {}) {
    document.getElementById('orderModalOverlay').classList.remove('active');
    if (!options.preserveSource) {
        window._orderModalSourceLink = null;
        window._orderModalQuoteContext = null;
        window._orderModalProductId = '';
    }
};

window.calcOrderTotal = function() {
    const qty = parseFloat(document.getElementById('orderQty').value) || 0;
    const price = parseFloat(document.getElementById('orderUnitPrice').value) || 0;
    document.getElementById('orderTotalPrice').value = (qty * price).toFixed(0);
};

let newOrderSaveInProgress = false;

let actionFeedbackTimer = null;
function showActionFeedback(message, type = 'success') {
    let status = document.getElementById('actionFeedback');
    if (!status) {
        status = document.createElement('div');
        status.id = 'actionFeedback';
        status.setAttribute('role', 'status');
        document.body.appendChild(status);
    }
    status.className = `action-feedback ${type === 'warning' ? 'warning' : 'success'}`;
    status.textContent = message;
    status.hidden = false;
    clearTimeout(actionFeedbackTimer);
    actionFeedbackTimer = setTimeout(() => { status.hidden = true; }, 6000);
}

window.saveNewOrder = function() {
    if (newOrderSaveInProgress) return;
    const currentItem=currentOrderModalItem();
    const items=[...newOrderDraftItems,...(currentItem.itemName?[currentItem]:[])];
    if(!items.length){alert('請至少輸入一個訂單品項。');return;}
    if(items.some(item=>!item.itemName||Number(item.qty||0)<=0)){alert('每個品項都必須有品名及大於 0 的數量。');return;}
    if(items.some(item=>item.fulfillmentType==='WAREHOUSE'&&warehouseMasterCache.length&&!item.warehouseId)){alert('請為每個倉庫出貨品項選擇倉庫。');return;}
    const assistedOwner = currentUserRole === 'purchaser'
        ? salesList.find(person => person.uid === document.getElementById('orderOwnerUid')?.value
            && person.role === 'sales' && person.active !== false && person.code)
        : null;
    if (currentUserRole === 'purchaser' && !assistedOwner) { alert('請先選擇有效的負責業務。'); return; }
    const firstItem=items[0];
    const itemCode = firstItem.itemCode;
    let data = {
        orderDate: document.getElementById('orderDateInput').value,
        createdAt: new Date().toISOString(),
        ...commercialCreatorFields(),
        company: window._orderModalQuoteContext?.company || currentCompany || 'yushin',
        customerName: document.getElementById('orderCustomer').value.trim(),
        customerId: customerIdForName(document.getElementById('orderCustomer').value.trim()),
        brand: firstItem.brand,
        itemCode: itemCode,
        itemCodeKey: normalizeHistoryItemCode(itemCode),
        itemName: firstItem.itemName,
        productLine: firstItem.productLine || '',
        productType: '',
        fulfillmentType:firstItem.fulfillmentType,warehouseId:firstItem.warehouseId||'',qty:firstItem.qty,unitPrice:firstItem.unitPrice,
        totalPrice:items.reduce((sum,item)=>sum+Number(item.totalPrice||0),0),items,itemCount:items.length,orderSchemaVersion:2,
        productMasterMatched:items.length > 0 && items.every(item => item.productMasterMatched === true),
        status: BUSINESS_STATUS.ACTIVE,
        ...grossAmountMetadata(items.reduce((sum,item)=>sum+Number(item.totalPrice||0),0)),
        transactionType: document.getElementById('orderTransactionType').value,
        invoiceTitle: document.getElementById('orderInvoiceTitle').value.trim(),
        quoteNo: window._orderModalQuoteContext?.quoteNo || '',
        ...linkedDocumentFields(window._orderModalSourceLink?.sourceType || '', window._orderModalSourceLink?.sourceId || '', window._orderModalSourceLink ? [documentLink(window._orderModalSourceLink.sourceType, window._orderModalSourceLink.sourceId, 'source')] : []),
        productId: window._orderModalProductId || '',
        salesName: assistedOwner?.name || window._orderModalQuoteContext?.salesName || currentUserName || '',
        salesCode: assistedOwner?.code || window._orderModalQuoteContext?.salesCode || currentUserCode || '',
        ownerUid: assistedOwner?.uid || window._orderModalQuoteContext?.ownerUid || currentUser?.uid || '',
        isDelivered: false,
        isBilled: false,
        invoiceDate: ''
    };
    const costInputVal = document.getElementById('orderCostPrice').value;
    const selectedProduct = findPriceItemForOrder(data);
    const nonAuthorizedCostAllowed = selectedProduct
        && authorizationTypeForProduct(selectedProduct) === 'NON_AUTHORIZED';
    if (nonAuthorizedCostAllowed && costInputVal !== '') {
        data.costPrice = parseFloat(costInputVal);
        data.costSource = hasBusinessCapability()
            ? 'business_manual_or_visible_non_authorized'
            : 'non_authorized_transaction_cost';
    }

    if (!data.orderDate || !data.itemName) {
        alert('請至少填寫訂單日期與品名');
        return;
    }
    if (data.fulfillmentType === 'WAREHOUSE' && warehouseMasterCache.length && !data.warehouseId) {
        alert('請選擇出貨倉庫；若由原廠直接送客戶，請改選「原廠直送客戶」。');
        return;
    }
    if (document.getElementById('orderBrand').value === '其他' && !data.brand) {
        alert('已選擇「其他」廠牌，請輸入廠牌名稱');
        return;
    }

    data.customerId = syncCustomerMaster(data.customerName, { salesCode: data.salesCode });
    const priceMatch = findPriceItemForOrder(data);
    data.productLine = firstItem.productLine || (priceMatch && priceMatch.productLine) || '';
    data.productType = (priceMatch && priceMatch.productType) || '';
    data.authorizationType = priceMatch ? authorizationTypeForProduct(priceMatch) : '';
    if (priceMatch) {
        data.productId = priceMatch.productId || stableProductId(priceMatch);
        data.supplier = priceMatch.supplier || '';
        data.spec = priceMatch.spec || '';
    }
    ensureOrderItemCompatibility(data);
    data.searchTokens = buildFullHistorySearchTokens('order', data);
    data.inventoryReservationStatus = 'pending';
    data.inventoryReservationUpdatedAt = new Date().toISOString();

    const saveButton = document.getElementById('saveNewOrderBtn');
    saveOrderDraft();
    newOrderSaveInProgress = true;
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    let createdOrderId = '';
    createOrResumeNewOrder(data).then(async docRef => {
        createdOrderId = docRef.id;
        data=docRef.data;
        let reservation;
        try {
            if(data.inventoryReservationStatus==='completed'){
                reservation=orderReservationSummary(data);
            }else{
                if (saveButton) saveButton.innerText = '同步庫存中…';
                reservation = await reserveInventoryForNewOrder(docRef.id, data);
                const completedAt = new Date().toISOString();
                await db.collection('orders').doc(docRef.id).set({
                    inventoryReservationStatus:'completed',
                    inventoryReservationError:'',
                    inventoryReservationUpdatedAt:completedAt
                },{merge:true});
                data.inventoryReservationStatus='completed';
                data.inventoryReservationError='';
                data.inventoryReservationUpdatedAt=completedAt;
            }
        } catch (reservationErr) {
            const failedAt = new Date().toISOString();
            await db.collection('orders').doc(docRef.id).set({
                inventoryReservationStatus:'failed',
                inventoryReservationError:String(reservationErr?.message||reservationErr),
                inventoryReservationUpdatedAt:failedAt
            },{merge:true}).catch(markErr=>console.error('標記訂單庫存占用失敗：',markErr));
            throw new Error(`訂單已建立，但庫存占用未完成：${reservationErr?.message||reservationErr}。可按儲存重試同一張訂單。`);
        }
        data.inventoryProductKey = inventoryProductKey(data);
        rememberRecentCustomerName(data.customerName);
        const quoteContext=window._orderModalQuoteContext;
        let quoteSyncError = null;
        if (data.sourceType === DOCUMENT_TYPES.QUOTE && data.sourceId) try {
            const closedAt=localDateString();
            await db.collection('quotes').doc(data.sourceId).set({
                dealClosed:true,
                dealClosedAt:closedAt,
                status:BUSINESS_STATUS.COMPLETED,
                linkedDocuments:firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.ORDER,docRef.id,'created'))
            },{merge:true});
            const patch={dealClosed:true,dealClosedAt:closedAt,status:BUSINESS_STATUS.COMPLETED};
            const cachedQuote=myQuotesCache.find(q=>q.quoteNo===data.sourceId);if(cachedQuote)Object.assign(cachedQuote,patch);
            const searchedQuote=quoteHistorySearchResults.find(q=>q.quoteNo===data.sourceId);if(searchedQuote)Object.assign(searchedQuote,patch);
            writeAppDataCache('quotes',myQuotesCache);
        } catch (err) {
            quoteSyncError = err;
            console.error('訂單已建立，但估價單狀態更新失敗：', err);
        }
        if (data.sourceType === DOCUMENT_TYPES.FORECAST && data.sourceId) {
            db.collection('forecasts').doc(data.sourceId).set({
                linkedDocuments: firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.ORDER, docRef.id, 'created')),
                updatedAt: new Date().toISOString()
            }, { merge: true }).catch(err => console.error('Forecast 回寫訂單關聯失敗', err));
        }
        window._orderModalSourceLink = null; window._orderModalProductId = ''; window._orderModalQuoteContext = null;
        closeOrderModal({ preserveSource:true });
        // 新增成功後只把這一筆放進本機快取，不為單筆新增重新查詢整個訂單頁。
        const savedOrder = { id: docRef.id, ...data };
        ordersCache = [savedOrder, ...ordersCache.filter(order => order.id !== docRef.id)]
            .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        syncOrderIntoPurchasingCaches(savedOrder);
        clearSavedOrderDraft({ silent:true,clearPending:true });
        if (saveButton) saveButton.innerText = '已完成';
        if (quoteSyncError) {
            alert('訂單已建立，庫存占用已同步，但來源估價單未標記成交。請勿重複建立訂單，請管理員檢查這筆關聯：' + quoteSyncError.message);
        } else {
            showActionFeedback('訂單已建立，庫存占用已同步。', 'success');
        }
    }).catch(err => {
        if (createdOrderId) {
            alert(`訂單編號 ${createdOrderId} 後續處理未完成。按儲存會重試同一張訂單，請勿另開新單：${err.message}`);
        } else {
            alert('儲存狀態尚未確認；請按儲存重試同一張訂單，勿另開新單：' + err.message);
        }
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
    const exportQuery = db.collection('orders')
        .where('orderDate', '>=', start)
        .where('orderDate', '<=', end)
        .orderBy('orderDate');
    readQueryInBatches(exportQuery).then(async records => {
            const rows = [];
            records.forEach(o => {
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
// 儀器管理系統的查看權限：業務只看自己；管理員／工程師可依 Firestore Rules 查看全部。
function canViewAllEquipment() {
    return canManageEquipmentCapability();
}

window.loadEquipmentFromCloud = function(reset = true) {
    const generation = ++equipmentLoadGeneration;
    const requestedRole = currentUserRole;
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
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole) return;
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
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole) return;
        console.error(err);
        alert(err?.code === 'firestore-read-timeout'
            ? '儀器資料讀取逾時，請再按一次更新。'
            : '讀取儀器資料失敗，請確認 Firestore 權限設定。');
    }).finally(() => {
        if (generation !== equipmentLoadGeneration || requestedRole !== currentUserRole) return;
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
        ...salesList.filter(person => String(person.role || 'sales').toLowerCase() === 'sales').map(person => stripPhoneSuffix(person.name || '')),
        ...equipmentList.map(item => stripPhoneSuffix(item.salesName || '')),
        ...equipmentSearchResults.map(item => stripPhoneSuffix(item.salesName || ''))
    ].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const selectedBrand = brandSelect.value;
    const brands = dedupeBrandsCaseInsensitive([
        ...getPriceListBrands(true), ...equipmentList.map(item => resolveBrandName(item.brand || '')),
        ...equipmentSearchResults.map(item => resolveBrandName(item.brand || ''))
    ]).sort((a, b) => a.localeCompare(b, 'zh-Hant'));
    const signature = JSON.stringify([canSeeAll, names, brands]);
    if (signature !== equipmentFilterOptionsSignature) {
        if (canSeeAll) {
            salesSelect.innerHTML = '<option value="">全部業務</option>' + names.map(name =>
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
                <button type="button" class="btn-danger" onclick="event.stopPropagation(); deleteEquipment('${eq.id}')">刪除</button>
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
function getNextAssetId(salesName) {
    const match = salesList.find(s => s.name === salesName);
    const code = (salesName === currentUserName && currentUserCode)
        ? currentUserCode
        : ((match && match.code) ? match.code : 'NA');
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
    data.searchTokens = buildFullHistorySearchTokens('equipment', data);
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
    const eq = equipmentList.find(item => item.id === eqId);
    if (!eq) return;
    if (!confirm('確定要停用這台儀器嗎？既有維修／保養紀錄會保留，可由管理員後續恢復。')) return;
    const now = new Date().toISOString();
    const previousList = [...equipmentList];
    equipmentList = equipmentList.filter(item => item.id !== eqId);
    writeAppDataCache('equipment', equipmentList);
    renderEquipmentList();
    closeEquipmentModal();
    db.collection('equipment').doc(eqId).set({
        active:false,
        disabledAt:now,
        disabledByUid:currentUser?.uid || '',
        disabledBy:currentUserName || currentUser?.email || '',
        updatedAt:now
    }, { merge:true }).catch(err => {
        equipmentList = previousList;
        writeAppDataCache('equipment', equipmentList);
        renderEquipmentList();
        alert('停用失敗：' + err.message);
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

    const previousLogs = [...(eq.logs || [])];
    const previousLastServiceDate = eq.lastServiceDate || '';
    Object.assign(eq, updates);
    writeAppDataCache('equipment', equipmentList);
    renderEquipmentList();
    openEquipmentModal(currentEquipmentId);
    db.collection('equipment').doc(currentEquipmentId).update(updates).catch(err => {
        eq.logs = previousLogs;
        eq.lastServiceDate = previousLastServiceDate;
        writeAppDataCache('equipment', equipmentList);
        renderEquipmentList();
        openEquipmentModal(currentEquipmentId);
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

    const previousLogs = [...(eq.logs || [])];
    const previousLastServiceDate = eq.lastServiceDate || '';
    eq.logs = updatedLogs;
    eq.lastServiceDate = dateStr;
    writeAppDataCache('equipment', equipmentList);
    renderEquipmentList();
    db.collection('equipment').doc(eqId).update({ logs: updatedLogs, lastServiceDate: dateStr }).catch(err => {
        eq.logs = previousLogs;
        eq.lastServiceDate = previousLastServiceDate;
        writeAppDataCache('equipment', equipmentList);
        renderEquipmentList();
        alert('新增保養紀錄失敗：' + err.message);
    });
};

window.deleteEquipmentLog = function(eqId, logIndex) {
    if (!confirm('確定要刪除這筆紀錄嗎？')) return;
    const eq = equipmentList.find(e => e.id === eqId);
    if (!eq) return;
    const updatedLogs = (eq.logs || []).filter((_, idx) => idx !== logIndex);
    const previousLogs = [...(eq.logs || [])];
    eq.logs = updatedLogs;
    writeAppDataCache('equipment', equipmentList);
    renderEquipmentList();
    openEquipmentModal(eqId);
    db.collection('equipment').doc(eqId).update({ logs: updatedLogs }).catch(err => {
        eq.logs = previousLogs;
        writeAppDataCache('equipment', equipmentList);
        renderEquipmentList();
        openEquipmentModal(eqId);
        alert('刪除失敗：' + err.message);
    });
};

function loadEquipmentFromCloudThenReopen(eqId) {
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
        openEquipmentModal(eqId);
        return null;
    }).catch(err => {
        alert('重新載入儀器失敗：'+err.message);
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
   管理員雲端後台：人員、Product Master、廠牌、進銷存、倉庫與資料庫管理
   ========================================================= */
window.switchAdminTab = function(tab, el) {
    document.querySelectorAll('#admin-system .sub-tab').forEach(t => t.classList.remove('active'));
    el.classList.add('active');
    document.querySelectorAll('.admin-panel').forEach(p => p.style.display = 'none');
    document.getElementById(`admin-${tab}`).style.display = 'block';

    if (tab === 'sales') reloadSalesFromUsers();
    if (tab === 'prices') loadPriceCatalogSummary();
    // 代理廠牌設定只需要價目表，不應順便全量讀取 orders。
    if (tab === 'agencies') Promise.all([ensureBrandSettingsLoaded(), loadSupplierWarehouseMasters()]).then(() => {
        renderKeyStatisticBrands();
        renderCompanyAgencyBrandSettings();
        renderSupplierMappingAdmin();
        renderWarehouseMasterAdmin();
    });
    // 統計資料在同一次登入期間保留快取；使用者按「重新整理」時才再次讀取。
    if (tab === 'statistics') ensureBrandSettingsLoaded().then(() => salesStatisticsOrders.length ? renderSalesStatistics() : loadSalesStatistics());
    if (tab === 'warehouses') loadSupplierWarehouseMasters(true).then(renderWarehouseMasterAdmin);
    if (tab === 'transfer') ensureSalesListLoaded().then(populateTransferDropdowns);
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
    const lines = salesStatisticsOrders.flatMap(salesStatisticOrderLines);
    lines.map(order => order.brand).forEach(value => {
        const brand = String(value || '').trim();
        if (!brand || brand === '維修') return;
        const key = normalizeStatisticBrandKey(brand);
        if (!entries.has(key)) entries.set(key, { name: brand, count: 0 });
    });
    lines.forEach(order => {
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
        populateQuoteBrandDropdowns();
        populateOrderBrandDropdown();
        populateEquipmentBrandDropdown();
        if (typeof populateForecastBrandDropdown === 'function')
            populateForecastBrandDropdown(document.getElementById('forecastBrand')?.value || '');
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
        ).join('') : '<span style="color:#888;font-size:13px;">請先建立 Brand Master 廠牌。</span>';
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
    const periodOrders = readQueryInBatches(
        db.collection('orders')
            .where('orderDate', '>=', start)
            .where('orderDate', '<=', end)
            .orderBy('orderDate', 'desc')
    );
    const activityOrders = readQueryInBatches(
        db.collection('orders')
            .where('updatedAt', '>=', startIso)
            .where('updatedAt', '<=', endIso)
            .orderBy('updatedAt', 'desc')
    );
    const openOrders = readQueryInBatches(
        db.collection('orders')
            .where('status', '==', BUSINESS_STATUS.ACTIVE)
            .orderBy(firebase.firestore.FieldPath.documentId())
    );

    salesStatisticsLoadPromise = Promise.all([periodOrders, activityOrders, openOrders]).then(([periodRows, activityRows, openRows]) => {
        if (requestedRole !== currentUserRole) return;
        const records = new Map();
        [periodRows, activityRows, openRows].forEach(rows => {
            rows.forEach(row => records.set(row.id, row));
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

async function readDocumentsByIds(collectionName, ids, chunkSize = 30) {
    const uniqueIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))];
    if (!uniqueIds.length) return [];
    const rows = [];
    for (let i = 0; i < uniqueIds.length; i += chunkSize) {
        const chunk = uniqueIds.slice(i, i + chunkSize);
        const snapshot = await firestoreReadWithTimeout(
            db.collection(collectionName)
                .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
                .get(),
            collectionName + ' 指定文件'
        );
        snapshot.forEach(doc => rows.push({ id:doc.id, ...doc.data() }));
    }
    return rows;
}

async function loadInventoryAnalysisSupport(start, end) {
    const receiptQuery = db.collection('inventoryMovements')
        .where('createdAt','>=',start+'T00:00:00')
        .where('createdAt','<=',end+'T23:59:59')
        .where('type','==','receipt')
        .orderBy('createdAt','desc');
    const supplyOrderQuery = db.collection('supplyOrders')
        .where('orderDate','>=',start)
        .where('orderDate','<=',end)
        .orderBy('orderDate','desc');
    // 目前庫存價值只需要仍有餘量的 lot；已耗盡歷史 lot 不應隨資料量成長而反覆下載。
    const activeLotsQuery = db.collection('inventoryLots')
        .where('remainingQty','>',0)
        .orderBy('remainingQty');
    const [movements, lots, supplyOrders] = await Promise.all([
        readQueryInBatches(receiptQuery),
        readQueryInBatches(activeLotsQuery),
        readQueryInBatches(supplyOrderQuery)
    ]);

    // COGS、期間入庫與目前庫存各自可能引用不同 lot。只抓實際被這次分析引用的受保護成本文件。
    const requiredLotIds = new Set();
    movements.forEach(row => { if (row.lotId) requiredLotIds.add(row.lotId); });
    lots.forEach(row => requiredLotIds.add(row.id));
    salesStatisticsOrders.forEach(order => {
        [...savedDeliveryRecords(order), ...savedReturnRecords(order)].forEach(record => {
            if (!dateInStatsRange(record.date, start, end)) return;
            (record.lotAllocations || []).forEach(allocation => {
                if (allocation?.lotId) requiredLotIds.add(allocation.lotId);
            });
        });
    });
    const lotCosts = await readDocumentsByIds('inventoryLotCosts', [...requiredLotIds]);

    inventoryAnalysisReceipts = movements;
    inventoryAnalysisStocks = [];
    inventoryAnalysisLots = lots;
    inventoryAnalysisLotCosts = new Map(lotCosts.map(row=>[row.id,row]));
    inventoryAnalysisSupplyOrders = supplyOrders;
    inventoryAnalysisDirectShipSupplyOrders = inventoryAnalysisSupplyOrders
        .filter(row=>(row.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP');
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
        .filter(supply => String(supply.status || '').toUpperCase() !== 'CANCELLED')
        .reduce((sum, supply) => {
            const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
            return sum + remaining * Number(supply.unitCost || 0);
        }, 0);
    const cogs = protectedHistoricalCogs(start, end);
    return { purchase, sales, difference: sales - purchase, stockValue, incoming, cogs, grossProfit:sales-cogs };
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
    if (direct && direct.status !== 'INACTIVE' && direct.active !== false) return direct;

    const exact = priceList.find(item => normalizeItemCode(item.model) === normalized && item.status !== 'INACTIVE' && item.active !== false);
    if (exact) return exact;

    // 有些價目表貨號帶有空格、-、/ 或 .；只有在寬鬆比對結果唯一時才自動帶入，避免誤抓錯品項。
    const loose = normalizeItemCodeLoose(value);
    if (!loose) return null;
    const candidates = priceList.filter(item =>
        normalizeItemCodeLoose(item.model) === loose
        && item.status !== 'INACTIVE'
        && item.active !== false
    );
    return candidates.length === 1 ? candidates[0] : null;
}

function cacheProductLookupItem(item) {
    if (!item) return null;
    const productId = item.productId || stableProductId(item);
    const next = normalizeProductMasterItem({ ...item, productId });
    priceList = priceList.filter(row => (row.productId || stableProductId(row)) !== productId);
    if (next.status !== 'INACTIVE' && next.active !== false) priceList.push(next);
    rebuildPriceItemLookup();
    return next;
}

async function findProductByCode(value) {
    const cached = findPriceItemByCodeValue(value);
    if (cached) return cached;
    const normalized = normalizeItemCodeLoose(value);
    if (!normalized) return null;
    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('products').where('normalizedPartNo', '==', normalized).limit(20).get(),
            'Product Master 貨號查詢'
        );
        const active = snapshot.docs
            .map(productMasterDocToPriceItem)
            .filter(item => item.status !== 'INACTIVE' && item.active !== false);
        if (active.length !== 1) return null;
        return cacheProductLookupItem(active[0]);
    } catch (err) {
        console.warn('Product Master 貨號查詢失敗：', err);
        return null;
    }
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
    const row = input.closest('tr');
    if (row) {
        // 貨號一旦被手動改動，先清除上一個 Product Master 身分；
        // 180ms 後若新貨號能比對成功，再由 applyQuoteProductMatch 寫回正確分類。
        row.querySelector('.item-product-id').value = '';
        row.querySelector('.item-product-line').value = '';
        row.querySelector('.item-product-type').value = '';
        input.dataset.autofillStatus = '';
    }
    quoteModelInputTimer = setTimeout(async () => {
        const value = input.value.trim();
        if (!value) {
            clearQuickProductButton(input);
            return;
        }
        const match = await findProductByCode(value);
        if (input.value.trim() !== value) return;
        if (match) {
            clearQuickProductButton(input);
            input.dataset.autofillStatus = 'matched';
            applyQuoteProductMatch(input.closest('tr'), match);
        } else {
            input.dataset.autofillStatus = 'not-found';
            showQuickProductButton(input, 'quote');
        }
    }, 180);
};

function stableProductId(item) {
    const brand = String(item?.brand || '').trim().toLocaleLowerCase();
    const code = normalizeItemCode(item?.model);
    if (code) return `prd:${encodeURIComponent(brand)}:${encodeURIComponent(code)}`;
    const name = String(item?.nameCn || item?.nameEn || '').normalize('NFKC').trim().toLocaleLowerCase();
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
        productLine: String(item.productLine || '').trim(),
        productType: normalizeProductTypeValue(item.productType || item.category || ''),
        authorizationType: String(item.authorizationType || '').trim().toUpperCase(),
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

function safeEmbeddedOrderCost(item, rawCost) {
    if (!item || authorizationTypeForProduct(item) === 'AUTHORIZED') return '';
    const cost = Number(rawCost);
    return Number.isFinite(cost) && cost >= 0 ? cost : '';
}

async function findProductForPurchaseItem(item) {
    const productId = String(item?.productId || '').trim();
    if (productId) {
        const cached = priceList.find(product => String(product.productId || '') === productId);
        if (cached) return cached;
        try {
            const snap = await firestoreReadWithTimeout(
                db.collection('products').doc(productId).get(),
                '採購 Product Master'
            );
            if (snap.exists) {
                const product = productMasterDocToPriceItem(snap);
                if (product.status !== 'INACTIVE' && product.active !== false) return cacheProductLookupItem(product);
            }
        } catch (err) {
            console.warn('採購 Product Master productId 查詢失敗：', err);
        }
    }
    const code = item?.itemCode || item?.productCode || item?.code || item?.model || '';
    return code ? await findProductByCode(code) : null;
}

async function preloadPurchaseCostsForItems(purchaseItems = []) {
    // 只解析這次訂購單真正會用到的品項；不要因來源訂單還有其他品項就全部查 Product Master / 成本。
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
        productType: data.productType || data.category || '',
        authorizationType: data.authorizationType || '',
        spec: data.specification || data.spec || '',
        price: data.listPrice ?? data.price ?? 0,
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

async function loadVisibleProductCost(item) {
    const productId = item?.productId || stableProductId(item || {});
    if (!productId) return null;
    const authType = authorizationTypeForProduct(item);
    if (hasBusinessCapability() && authType === 'AUTHORIZED') return null;
    const cacheKey = `${currentUserRole || ''}||${productId}`;
    if (visibleProductCostCache.has(cacheKey)) return visibleProductCostCache.get(cacheKey);
    try {
        const doc = await firestoreReadWithTimeout(
            db.collection('productCosts').doc(productId).get(),
            '產品成本'
        );
        if (!doc.exists) {
            visibleProductCostCache.set(cacheKey, null);
            return null;
        }
        const data = doc.data() || {};
        if (hasBusinessCapability() && data.salesVisible !== true) {
            visibleProductCostCache.set(cacheKey, null);
            return null;
        }
        const value = data.standardCost;
        const cost = value === undefined || value === null || String(value).trim() === '' ? null : Number(value);
        visibleProductCostCache.set(cacheKey, cost);
        return cost;
    } catch (_) {
        return null;
    }
}

function setOrderCostFieldForProduct(item) {
    const wrap = document.getElementById('orderCostFieldWrap');
    const input = document.getElementById('orderCostPrice');
    if (!wrap || !input) return;
    const selfOrder = document.getElementById('orderProcurementType')?.value === 'SALES_SELF_ORDER';
    wrap.style.display = selfOrder ? '' : 'none';
    if (!selfOrder) input.value = '';
}
window.onOrderProcurementTypeChange=function(){
    setOrderCostFieldForProduct(null);
    const hint=document.getElementById('orderWarehouseStockHint');
    if(hint&&document.getElementById('orderProcurementType')?.value!=='SALES_SELF_ORDER')hint.textContent='交由採購訂貨：業務只需確認售價，採購成本由採購流程處理。';
    saveOrderDraft();
};

async function applyOrderProductCost(item) {
    setOrderCostFieldForProduct(item);
    const input = document.getElementById('orderCostPrice');
    if (!input || document.getElementById('orderProcurementType')?.value !== 'SALES_SELF_ORDER') return;
    const allowed = currentUserRole === 'admin' || currentUserRole === 'purchaser'
        || (hasBusinessCapability() && authorizationTypeForProduct(item) === 'NON_AUTHORIZED');
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
          <button type="button" class="btn-secondary" onclick="closeQuickProductCreate()">✕ 暫存並關閉</button>
        </div>
        <div style="font-size:12px;color:#666;margin:8px 0 14px;">只填銷售當下需要的資料，其餘欄位可由採購或管理員後補。</div>
        <div class="form-grid">
          <div><label>廠牌</label><input id="quickProductBrand" type="text" list="quickProductBrandList" autocomplete="off"><datalist id="quickProductBrandList"></datalist></div>
          <div><label>貨號</label><input id="quickProductCode" type="text" autocomplete="off"></div>
          <div style="grid-column:1/-1;"><label>中文品名</label><input id="quickProductName" type="text" autocomplete="off"></div>
          <div style="grid-column:1/-1;"><label>英文品名</label><input id="quickProductNameEn" type="text" autocomplete="off"></div>
          <div><label>規格</label><input id="quickProductSpec" type="text" autocomplete="off"></div>
          <div><label>建議售價</label><input id="quickProductPrice" type="number" min="0"></div>
          <input id="quickProductLine" type="hidden">
          <input id="quickProductAuthorization" type="hidden">
          <input id="quickProductCost" type="hidden">
        </div>
        <div style="margin-top:14px;text-align:right;">
          <button type="button" id="saveQuickProductBtn" onclick="saveQuickProduct()">儲存並帶入</button>
          <button type="button" class="btn-secondary" onclick="closeQuickProductCreate()">暫存並關閉</button>
        </div>
      </div>`;
    // A backdrop tap on a phone must not discard a partially entered product.
    overlay.addEventListener('input', saveQuickProductDraft);
    overlay.addEventListener('change', saveQuickProductDraft);
    document.body.appendChild(overlay);
    return overlay;
}

const QUICK_PRODUCT_FIELDS = ['Brand', 'Code', 'Name', 'NameEn', 'Spec', 'Line', 'Authorization', 'Price', 'Cost'];
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

window.updateQuickProductCostVisibility = function() {
    const type = document.getElementById('quickProductAuthorization')?.value || 'NON_AUTHORIZED';
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
    document.getElementById('quickProductNameEn').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-en')?.value || '')
        : '';
    document.getElementById('quickProductSpec').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-spec')?.value || '')
        : (document.getElementById('orderSpec')?.value || '');
    document.getElementById('quickProductLine').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-product-line')?.value || '')
        : (document.getElementById('orderProductLine')?.value || '');
    document.getElementById('quickProductPrice').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.inc-price')?.value || '')
        : (document.getElementById('orderUnitPrice')?.value || '');
    document.getElementById('quickProductCost').value = mode === 'order'
        ? (document.getElementById('orderCostPrice')?.value || '')
        : '';
    document.getElementById('quickProductAuthorization').value =
        isBrandAuthorizedForCurrentCompany(currentBrand) ? 'AUTHORIZED' : 'NON_AUTHORIZED';
    const draft = readQuickProductDraft();
    // Resume only the same product; another item's form must not inherit stale values.
    if (draft && normalizeItemCodeLoose(draft.Code) === normalizeItemCodeLoose(input.value.trim())
        && normalizeBrandLookupKey(draft.Brand) === normalizeBrandLookupKey(currentBrand)) {
        QUICK_PRODUCT_FIELDS.forEach(field => {
            const node = document.getElementById(`quickProduct${field}`);
            if (node) node.value = draft[field] || '';
        });
    }
    updateQuickProductCostVisibility();
    overlay.classList.add('active');
};

window.closeQuickProductCreate = function() {
    const overlay = document.getElementById('quickProductOverlay');
    if (overlay?.classList.contains('active')) saveQuickProductDraft();
    if (overlay) overlay.classList.remove('active');
    quickProductTarget = null;
};

window.saveQuickProduct = async function() {
    const brand = resolveBrandName(document.getElementById('quickProductBrand')?.value || '');
    const code = String(document.getElementById('quickProductCode')?.value || '').trim();
    const productName = String(document.getElementById('quickProductName')?.value || '').trim();
    const productNameEn = String(document.getElementById('quickProductNameEn')?.value || '').trim();
    const specification = String(document.getElementById('quickProductSpec')?.value || '').trim();
    const productLine = String(document.getElementById('quickProductLine')?.value || '').trim();
    const authorizationType = document.getElementById('quickProductAuthorization')?.value || 'NON_AUTHORIZED';
    const priceRaw = document.getElementById('quickProductPrice')?.value ?? '';
    const costRaw = document.getElementById('quickProductCost')?.value ?? '';
    if (!brand || !code || !productName || String(priceRaw).trim() === '') {
        alert('請填寫廠牌、貨號、品名與建議售價。');
        return;
    }

    const button = document.getElementById('saveQuickProductBtn');
    const state = beginActionButton(button, '檢查中…');
    if (!state) return;
    try {
    const normalizedPartNo = normalizeItemCodeLoose(code);
    const brandEntry = brandMasterEntryForName(brand);
    const duplicateSnap = await firestoreReadWithTimeout(
        db.collection('products').where('normalizedPartNo', '==', normalizedPartNo).limit(20).get(),
        'Product Master 重複貨號檢查'
    );
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
        authorizationType,
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
        await db.collection('products').doc(productId).set(productDoc, { merge: true });
        const item = productMasterDocToPriceItem({ id: productId, data: () => productDoc });
        priceList = priceList.filter(row => (row.productId || stableProductId(row)) !== productId).concat(item);
        refreshPriceDatalists();
        if (quickProductTarget?.mode === 'quote') applyQuoteProductMatch(quickProductTarget.row, item);
        if (quickProductTarget?.mode === 'order') {
            quickProductTarget.input.value = code;
            await onOrderItemCodeChange(quickProductTarget.input);
        }
        clearQuickProductButton(quickProductTarget?.input);
        closeQuickProductCreate();
        clearQuickProductDraft();
    } catch (err) {
        alert('快速新增產品失敗：' + err.message);
    } finally {
        endActionButton(button, state);
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
    const brand = (order.brand || '').trim();
    if (brand === '維修') return '維修';
    return statisticBrandAliasLookup().get(normalizeStatisticBrandKey(brand)) || '其他廠牌';
}

function salesStatisticOrderLines(order) {
    const items = normalizedOrderItems(order);
    if (items.length <= 1) return [order];
    return items.map(item => ({
        ...order,
        items: [item], orderSchemaVersion: 2,
        itemId: item.itemId, itemCode: item.itemCode || '', itemName: item.itemName || '',
        brand: item.brand || '', productLine: item.productLine || '', productType: item.productType || '',
        qty: Number(item.qty || 0), unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.totalPrice || 0), costPrice: item.costPrice,
        deliveryRecords: savedDeliveryRecords(order).filter(row => row.itemId === item.itemId),
        returnRecords: savedReturnRecords(order).filter(row => row.itemId === item.itemId),
        isDelivered: false
    }));
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
    const cancelled = normalizedOrderStatus(order) !== 'normal';
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
    let returnedByCutoff = 0;
    savedReturnRecords(order).forEach(record => {
        const qty = parseFloat(record.qty) || 0;
        if (dateInStatsRange(record.date, start, end)) actualQty -= qty;
        if (record.date && record.date <= cutoff) returnedByCutoff += qty;
    });
    const orderExistsByCutoff = !order.orderDate || order.orderDate <= cutoff;
    const effectiveDelivered = Math.max(0, deliveredByCutoff - returnedByCutoff);
    // 取消／作廢只終止尚未履約的餘額；取消前已實際送貨、退貨仍屬正式歷史。
    const pendingQty = !cancelled && orderExistsByCutoff ? Math.max(0, totalQty - Math.min(totalQty, effectiveDelivered)) : 0;
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
    const orderLines = salesStatisticsOrders.flatMap(salesStatisticOrderLines);
    const selects = [
        { id: 'salesStatsSalesFilter', label: '全部業務', values: salesStatisticsOrders.map(o => stripPhoneSuffix(o.salesName) || '未指定業務') },
        { id: 'salesStatsBrandFilter', label: '全部廠牌', values: [...keyStatisticBrands, '其他廠牌', '維修'] },
        { id: 'salesStatsTypeFilter', label: '全部類型', values: orderLines.map(productTypeForOrder) },
        { id: 'salesStatsLineFilter', label: '全部產品線', values: orderLines.map(productLineForOrder) }
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

    salesStatisticsOrders.flatMap(salesStatisticOrderLines).forEach(order => {
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
            <td data-label="身份"><select id="adminUserRole-${escapeAttr(u.uid)}" onchange="saveAdminUserRole('${escapeAttr(u.uid)}', this)">${['admin','sales','purchaser','warehouse','engineer'].map(role=>`<option value="${role}" ${u.role===role?'selected':''}>${escapeHtml(roleLabel[role])}</option>`).join('')}</select></td>
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
        alert('更新失敗：'+err.message);
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
    const rows = await readCollectionInBatches('salesCodes');
    salesCodeMasterCache = rows
        .filter(item => item.active !== false)
        .sort((x, y) => String(x.code || x.id).localeCompare(String(y.code || y.id), 'zh-Hant'));
    return salesCodeMasterCache;
}

window.reloadSalesFromUsers = function() {
    return readCollectionInBatches('users').then(async rows => {
        salesList = rows
            .filter(d => d.name && d.code)
            .map(d => ({ uid:d.id, code:d.code, name:d.name, phone:d.phone || '', role:d.role || 'sales', active:d.active !== false }))
            .sort((a,b)=>String(a.code||'').localeCompare(String(b.code||'')));

        allUsersCache = rows.map(d => ({
            uid:d.id, code:d.code || '', name:d.name || '', phone:d.phone || '',
            role:d.role || 'sales', email:d.email || '', disabled:!!d.disabled,
            active:d.active !== false, mustChangePassword:!!d.mustChangePassword
        })).sort((a,b)=>{
            if (a.name && !b.name) return -1;
            if (!a.name && b.name) return 1;
            return String(a.code||'').localeCompare(String(b.code||'')) || a.uid.localeCompare(b.uid);
        });

        // Admin users 查詢同時就是一般頁面的 salesList 資料來源，兩邊共用，不再重查 users。
        applySalesRows(rows);
        salesListLoadPromise = Promise.resolve(salesList);
        if (trueUserRole === 'admin') await syncSalesCodeMasterFromUsers().catch(err => console.warn('同步業務代號主檔失敗：', err));
        await loadSalesCodeMaster().catch(err => { console.warn('讀取業務代號主檔失敗：', err); salesCodeMasterCache = []; });
        renderAdminSalesTable();
        populateTransferDropdowns();
    }).catch(err => {
        console.error('重新載入人員資料失敗：', err);
        allUsersCache = [];
        renderAdminSalesTable();
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
        { key: 'supplyOrders', label: '供應／訂貨紀錄' }, { key: 'receipts', label: '收貨紀錄' },
        { key: 'dispatchRecords', label: '出貨打單紀錄' }, { key: 'inventory', label: '庫存彙總' },
        { key: 'inventoryLots', label: '庫存批次' }, { key: 'inventoryLotCosts', label: '受保護批次成本' },
        { key: 'inventoryReservations', label: '庫存占用' }, { key: 'inventoryMovements', label: '庫存異動' },
        { key: 'warehouseStocks', label: '分倉庫存' }, { key: 'products', label: 'Product Master' },
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
        'quotes', 'forecasts', 'orders', 'purchaseOrders', 'equipment', 'users', 'settings',
        'brands', 'productLines', 'products', 'productCosts', 'priceHistory', 'customers', 'salesCodes',
        'suppliers', 'brandSupplierMappings', 'warehouses', 'warehouseStocks',
        'inventory', 'inventoryLots', 'inventoryLotCosts', 'inventoryReservations',
        'inventoryMovements', 'receipts', 'supplyOrders', 'dispatchRecords', 'deliveries', 'auditLogs'
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
    'quotes','forecasts','orders','purchaseOrders','equipment','brands','productLines',
    'products','productCosts','priceHistory','customers','salesCodes','suppliers',
    'brandSupplierMappings','warehouses','warehouseStocks','inventory','inventoryLots',
    'inventoryLotCosts','inventoryReservations','inventoryMovements',
    'receipts','supplyOrders','dispatchRecords','deliveries','auditLogs','forecastProgress'
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
            const inserted = await db.runTransaction(async transaction => {
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
        listPrice: Number(normalized.price || 0),
        inventoryTracked: !!normalized.inventoryTracked,
        lotTracked: !!normalized.lotTracked,
        expiryTracked: !!normalized.expiryTracked,
        authorizationType: authorizationTypeForProduct(normalized),
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
    'orders','purchaseOrders','supplyOrders','inventoryReservations','inventoryLots','inventoryLotCosts',
    'receipts','dispatchRecords','deliveries','inventoryMovements','auditLogs'
];
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
    try {
        const [products, users, warehouses, orders, purchaseOrders, supplyOrders, inventory, warehouseStocks, reservations] = await Promise.all([
            readCollectionInBatches('products'),
            readCollectionInBatches('users'),
            readCollectionInBatches('warehouses'),
            readCollectionInBatches('orders'),
            readCollectionInBatches('purchaseOrders'),
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
            const code = normalizeItemCodeLoose(product.manufacturerPartNo || product.itemCode || product.sku || '');
            if (code) productCodes.add(code);
            const duplicateKey = normalizeBrandLookupKey(product.brandName || product.brand || '') + '|' + code;
            if (code) {
                const list = duplicateProducts.get(duplicateKey) || [];
                list.push(product);
                duplicateProducts.set(duplicateKey, list);
            }
        });
        duplicateProducts.forEach((list, key) => {
            if (list.length > 1) issues.push({ type:'Product Master 重複', detail:`${key}：${list.length} 筆` });
        });

        const validRoles = new Set(['admin','sales','purchaser','warehouse','engineer']);
        users.forEach(user => {
            if (!validRoles.has(String(user.role || ''))) issues.push({ type:'人員角色異常', detail:`${user.name || user.email || user.id}：${user.role || '未設定'}` });
        });

        const orderIds = new Set(orders.map(order => String(order.id || '').trim()).filter(Boolean));
        const warehouseIds = new Set(warehouses.filter(w => w.active !== false).map(w => String(w.warehouseId || w.id || '').trim()).filter(Boolean));
        const knownProduct = record => {
            const key = systemAuditProductKey(record);
            const code = normalizeItemCodeLoose(record.itemCode || record.manufacturerPartNo || '');
            return !key && !code ? true : (productIds.has(key) || productCodes.has(code));
        };

        orders.forEach(order => {
            if (!knownProduct(order)) issues.push({ type:'訂單找不到 Product', detail:`${order.orderNo || order.id}｜${order.itemCode || order.productKey || ''}` });
            if ((order.fulfillmentType || '') === 'WAREHOUSE' && order.warehouseId && !warehouseIds.has(String(order.warehouseId))) {
                issues.push({ type:'訂單倉庫不存在', detail:`${order.orderNo || order.id}｜${order.warehouseId}` });
            }
        });

        const supplyIds = new Set(supplyOrders.map(row => String(row.id || '').trim()).filter(Boolean));

        purchaseOrders.forEach(po => {
            const itemOrderIds=[...new Set(purchaseItemsFromSavedPo(po).map(item=>String(item.orderId||'').trim()).filter(Boolean))];
            itemOrderIds.forEach(sourceOrderId => {
                if (!orderIds.has(sourceOrderId)) issues.push({ type:'訂購單文件來源訂單不存在', detail:`${po.poNo || po.id}｜${sourceOrderId}` });
            });
            (Array.isArray(po.supplyOrderIds)?po.supplyOrderIds:[]).forEach(supplyId => {
                const id=String(supplyId||'').trim();
                if(id&&!supplyIds.has(id))issues.push({ type:'訂購單文件找不到供應紀錄', detail:`${po.poNo || po.id}｜${id}` });
            });
        });

        supplyOrders.forEach(supply => {
            const sourceOrderId=String(supply.orderId||'').trim();
            if(sourceOrderId&&!orderIds.has(sourceOrderId))issues.push({ type:'供應紀錄來源訂單不存在', detail:`${supply.internalNo || supply.id}｜${sourceOrderId}` });
            if(!knownProduct(supply))issues.push({ type:'供應紀錄找不到 Product', detail:`${supply.internalNo || supply.id}｜${supply.itemCode || supply.productKey || ''}` });
            const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
            const warehouseId=String(supply.warehouseId||'').trim();
            if(!directShip&&(!warehouseId||!warehouseIds.has(warehouseId)))issues.push({ type:'供應紀錄倉庫異常', detail:`${supply.internalNo || supply.id}｜${warehouseId || '未指定'}` });
            const qty=Math.max(0,Number(supply.qty||0));
            const received=Math.max(0,Number(supply.receivedQty||0));
            if(!(qty>0)||received>qty)issues.push({ type:'供應紀錄數量異常', detail:`${supply.internalNo || supply.id}｜訂購 ${qty}／已到 ${received}` });
        });

        inventory.forEach(item => {
            // inventory 只保留產品索引／總覽快取；實際數量以 warehouseStocks 為準。
            // 健康檢查不可再把 aggregate cache 的 onHand / reserved 當成正式庫存錯誤。
            if (!knownProduct(item)) issues.push({ type:'庫存索引找不到 Product', detail:`${item.itemCode || item.id}` });
        });

        warehouseStocks.forEach(stock => {
            if (stock.warehouseId && !warehouseIds.has(String(stock.warehouseId))) issues.push({ type:'分倉指向不存在倉庫', detail:`${stock.id}｜${stock.warehouseId}` });
            if (!knownProduct(stock)) issues.push({ type:'分倉找不到 Product', detail:`${stock.id}` });
            const n = inventoryNumbers(stock);
            if (n.onHand < 0 || n.reserved < 0 || n.reserved > n.onHand) issues.push({ type:'分倉數量異常', detail:`${stock.id}｜現有 ${n.onHand}／占用 ${n.reserved}` });
        });

        reservations.filter(r => r.status === 'active').forEach(reservation => {
            const orderId = String(reservation.orderId || reservation.sourceId || reservation.id || '').trim();
            if (orderId && !orderIds.has(orderId)) issues.push({ type:'庫存占用來源訂單不存在', detail:`${reservation.orderNo || reservation.id}｜${orderId}` });
            if (!knownProduct(reservation)) issues.push({ type:'庫存占用找不到 Product', detail:`${reservation.orderNo || reservation.id}｜${reservation.productKey || reservation.itemCode || ''}` });
        });

        const counts = `Product ${products.length}、人員 ${users.length}、訂單 ${orders.length}、訂購單文件 ${purchaseOrders.length}、供應紀錄 ${supplyOrders.length}、庫存索引 ${inventory.length}、分倉 ${warehouseStocks.length}、占用 ${reservations.length}`;
        status.textContent = issues.length ? `檢查完成：${counts}。發現 ${issues.length} 項需確認。` : `檢查完成：${counts}。未發現上述關聯異常。`;
        results.innerHTML = issues.length
            ? '<div class="table-wrap"><table><thead><tr><th>類型</th><th>內容</th></tr></thead><tbody>' + issues.slice(0,500).map(issue => `<tr><td>${escapeHtml(issue.type)}</td><td>${escapeHtml(issue.detail)}</td></tr>`).join('') + '</tbody></table></div>' + (issues.length > 500 ? `<div style="font-size:12px;color:#666;margin-top:6px;">畫面只顯示前 500 項，共 ${issues.length} 項。</div>` : '')
            : '<div style="padding:10px;background:#f4f8f4;border-radius:6px;">目前未發現需要處理的資料關聯異常。</div>';
    } catch (err) {
        console.error('系統資料檢查失敗：', err);
        status.textContent = '檢查失敗：' + err.message;
    } finally {
        button.disabled = false;
        button.textContent = '檢查系統資料';
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
            <td class="no-print"><span style="font-size:12px;color:#666;">重新上傳同廠牌即可更新</span></td>
        </tr>
    `).join('') : '<tr><td colspan="3" style="color:#888;">目前雲端沒有價格表。</td></tr>';
}

// 價格表管理頁只讀取輕量索引；不再為了顯示清單下載所有價格明細。
window.loadPriceCatalogSummary = async function() {
    const tbody = document.getElementById('adminPriceCatalogBody');
    if (tbody) tbody.innerHTML = '<tr><td colspan="3" style="color:#888;">載入中…</td></tr>';
    try {
        await loadBrandMaster();
        priceCatalogMeta = brandMasterCache
            .filter(item => item.active !== false)
            .map(item => ({ name: item.name, updatedAt: item.updatedAt || null }))
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hant'));
        renderPriceCatalogSummary();
    } catch (err) {
        if (tbody) tbody.innerHTML = `<tr><td colspan="3" style="color:#c00;">載入失敗：${escapeHtml(err.message)}</td></tr>`;
    }
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

async function syncImportedBrandToFormalProductMaster(imported, storedBrand) {
    const canWriteFormalMaster = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    if (!canWriteFormalMaster) return;
    const now = new Date().toISOString();
    const operations = [];

    (imported || []).forEach(raw => {
        const item = normalizeProductMasterItem({ ...raw, brand: storedBrand });
        const product = productMasterRecordFromItem(item, 'PRICE_LIST');
        product.status = item.active === false ? 'INACTIVE' : 'ACTIVE';
        product.active = product.status === 'ACTIVE';
        product.updatedAt = now;
        operations.push(batch => batch.set(db.collection('products').doc(product.productId), product, { merge: true }));
    });
    await commitMigrationBatch(operations);
}

async function saveProductMasterBrand(imported, brand) {
    const normalizedItems = normalizeProductMasterList((imported || []).map(item => ({ ...item, brand })));
    await syncImportedBrandToFormalProductMaster(normalizedItems, brand);
    normalizedItems.forEach(item => cacheProductLookupItem(item));
    return brand;
}


let pendingPriceImportPreview = null;

async function summarizeProductMasterImport(groups) {
    const rows = groups.flatMap(group => group.imported.map(raw => normalizeProductMasterItem({ ...raw, brand: group.brand })));
    const existingIds = new Set();
    const uniqueProductIds = [...new Set(rows.map(item => String(item.productId || '').trim()).filter(Boolean))];
    for (let i = 0; i < uniqueProductIds.length; i += 10) {
        const ids = uniqueProductIds.slice(i, i + 10);
        const snapshot = await firestoreReadWithTimeout(
            db.collection('products')
                .where(firebase.firestore.FieldPath.documentId(), 'in', ids)
                .get(),
            'Product Master 匯入比對'
        );
        snapshot.docs.forEach(doc => existingIds.add(doc.id));
    }
    let added = 0, updated = 0, inactive = 0;
    const brands = groups.map(group => {
        let brandAdded = 0, brandUpdated = 0;
        group.imported.forEach(raw => {
            const item = normalizeProductMasterItem({ ...raw, brand: group.brand });
            if (existingIds.has(item.productId)) { updated++; brandUpdated++; } else { added++; brandAdded++; }
            if (!item.active) inactive++;
        });
        return { brand: group.brand, productLine: group.productLine || '', count: group.imported.length, added: brandAdded, updated: brandUpdated };
    });
    return { added, updated, inactive, total: added + updated, brands };
}

async function confirmProductMasterImport(groups) {
    const summary = await summarizeProductMasterImport(groups);
    const lines = summary.brands.map(item => `${item.brand} / ${item.productLine || '未分類'}：${item.count} 筆（新增 ${item.added}／更新 ${item.updated}）`);
    return confirm(`Product Master 匯入預覽\n\n${lines.join('\n')}\n\n合計 ${summary.total} 筆：新增 ${summary.added}、更新 ${summary.updated}、停用標記 ${summary.inactive}。\n\n資料只會寫入 Product Master（products）；成本資料 productCosts 不會由這份 Excel 修改。歷史估價單與訂單快照也不會被改寫。確定寫入雲端嗎？`);
}


window.downloadProductMasterTemplate = async function() {
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }
    const headers = ['廠牌','產品線','貨號','中文品名','英文品名','規格','產品類型','建議售價（含稅）','啟用','庫存管理','批號管理','效期管理'];
    const example = ['Beckman Coulter','Centrifuge','EXAMPLE-001','範例中文品名','Example Product','96 tests','Consumable','1000','是','是','否','否'];
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    ws['!cols'] = [22,20,18,28,32,24,14,16,10,12,12,12].map(wch => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '產品資料');
    XLSX.writeFile(wb, 'Product Master.xlsx');
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
            XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval:'' }).forEach(row => {
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
            throw new Error(`有 ${missing.length} 個貨號找不到「${brand}」唯一 Product Master：${missing.slice(0,10).join('、')}${missing.length > 10 ? '…' : ''}。未寫入任何資料。`);
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
        setPriceUploadProgress(100, `完成：已更新 ${changed.length} 筆建議售價；其他 Product Master 未變更。`);
        input.value = '';
    } catch (err) {
        console.error('建議售價增量更新失敗：', err);
        setPriceUploadProgress(0, '更新失敗：' + (err?.message || err));
        alert('建議售價更新失敗：' + (err?.message || err));
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
            XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { defval:'' }).forEach(row => {
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
            throw new Error(`有 ${missing.length} 個貨號找不到「${brand}」唯一 Product Master：${missing.slice(0,10).join('、')}${missing.length > 10 ? '…' : ''}。未寫入任何成本資料。`);
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
        if (!confirm(`產品成本增量更新\n\n廠牌：${brand}\n檔案共 ${deduped.length} 筆\n實際需要更新 ${changed.length} 筆\n\n只會修改 productCosts 的 standardCost，不會修改 Product Master、建議售價或歷史訂單。確定更新嗎？`)) {
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
                salesVisible: (product.authorizationType || 'NON_AUTHORIZED') === 'NON_AUTHORIZED',
                source: 'COST_UPDATE',
                updatedAt: now,
                updatedBy: currentUser?.uid || ''
            }, { merge:true });
        });
        setPriceUploadProgress(60, `更新 ${changed.length} 筆標準成本…`);
        await commitMigrationBatch(operations);
        visibleProductCostCache.clear();
        setPriceUploadProgress(100, `完成：已更新 ${changed.length} 筆標準成本；Product Master 與建議售價未變更。`);
        input.value = '';
    } catch (err) {
        console.error('產品成本增量更新失敗：', err);
        setPriceUploadProgress(0, '成本更新失敗：' + (err?.message || err));
        alert('產品成本更新失敗：' + (err?.message || err));
        input.value = '';
    } finally {
        setProductBatchMaintenanceBusy(false);
    }
};

window.handlePriceExcelUpload = async function(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    if (!(currentUserRole === 'admin' || currentUserRole === 'purchaser')) {
        alert('只有管理員或採購可以匯入 Product Master。');
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

    setPriceUploadProgress(0, '準備讀取價格表…');
    const reader = new FileReader();
    reader.onprogress = function(event) {
        if (!event.lengthComputable) return;
        // 檔案讀取階段使用 0～50%，保留後半段顯示資料整理與同一廠牌多產品線的雲端儲存進度。
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

            // 標準格式以欄位為主：廠牌、產品線都存在每一列。
            // 為了讓既有整理好的檔案仍可使用，若欄位空白才退回用「檔名＝廠牌、分頁＝產品線」。
            const fallbackBrand = toHalfWidth(String(file.name || '').replace(/\.(xlsx|xls)$/i, '').replace(/^Product Master$/i, ''));
            const brandGroupsMap = new Map();
            workbook.SheetNames.forEach(sheetName => {
                const fallbackProductLine = toHalfWidth(sheetName === '產品資料' ? '' : sheetName);
                const sheet = workbook.Sheets[sheetName];
                const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

                rows.forEach(row => {
                    const nameCn = String(getField(row, ['中文品名', '品名', '中文名稱'])).trim();
                    const nameEn = String(getField(row, ['英文品名', '英文名稱'])).trim();
                    const model = String(getField(row, ['貨號', '型號'])).trim();
                    if (!model) return;

                    const brand = toHalfWidth(getField(row, ['廠牌', '品牌', 'Brand']) || fallbackBrand);
                    const productLine = toHalfWidth(getField(row, ['產品線', 'Product Line', 'ProductLine']) || fallbackProductLine);
                    if (!brand) throw new Error(`貨號「${model}」缺少廠牌。請填寫「廠牌」欄位。`);
                    if (!productLine) throw new Error(`貨號「${model}」缺少產品線。請填寫「產品線」欄位。`);

                    const productType = normalizeProductTypeValue(getField(row, ['類型', '產品類型', '品項類型', '機器/耗材', '仪器/耗材', 'Type']));
                    const spec = String(getField(row, ['規格', '规格', 'Spec', 'Specification'])).trim();
                    const activeRaw = String(getField(row, ['啟用', '启用', 'Active', 'Status'])).trim().toLocaleLowerCase();
                    const yes = value => ['1', 'true', 'yes', 'y', '是', '啟用', '启用'].includes(String(value || '').trim().toLocaleLowerCase());
                    const inventoryTracked = yes(getField(row, ['庫存管理', '库存管理', 'Inventory Tracked', 'Inventory']));
                    const lotTracked = yes(getField(row, ['批號管理', '批号管理', 'Lot Tracked', 'Lot']));
                    const expiryTracked = yes(getField(row, ['效期管理', 'Expiry Tracked', 'Expiry']));

                    const priceRaw = getField(row, ['建議售價（含稅）', '建議售價', '含稅單價', '單價', '價格']);
                    const price = priceRaw === '' ? 0 : Number(String(priceRaw).replace(/,/g, '').trim());
                    if (!Number.isFinite(price) || price < 0) throw new Error(`貨號「${model}」的建議售價格式不正確。`);

                    const importedItem = {
                        nameCn, nameEn, model, brand, productType, productLine, spec,
                        inventoryTracked, lotTracked, expiryTracked,
                        active: activeRaw ? !['0','false','no','n','否','停用'].includes(activeRaw) : true,
                        price, source:'PRODUCT_MASTER'
                    };
                    const groupKey = `${normalizeBrandLookupKey(brand)}::${productLine.toLocaleLowerCase()}`;
                    if (!brandGroupsMap.has(groupKey)) brandGroupsMap.set(groupKey, { brand, productLine, imported:[] });
                    brandGroupsMap.get(groupKey).imported.push(importedItem);
                });
            });
            const brandGroups = [...brandGroupsMap.values()];

            if (!brandGroups.length) {
                setPriceUploadProgress(0, '找不到可上傳的價格資料。');
                alert('無法從 Excel 辨識出有效資料。請確認每筆產品都有廠牌、產品線與貨號。');
                input.value = '';
                return;
            }

            if (!await confirmProductMasterImport(brandGroups)) {
                setPriceUploadProgress(0, '已取消，尚未寫入雲端。', false);
                input.value = '';
                return;
            }

            const savedBrands = [];
            const imported = brandGroups.flatMap(group => group.imported);
            const itemsByBrand = new Map();
            imported.forEach(item => {
                const key = normalizeBrandLookupKey(item.brand);
                if (!itemsByBrand.has(key)) itemsByBrand.set(key, { brand:item.brand, items:[] });
                itemsByBrand.get(key).items.push(item);
            });

            let savedCount = 0;
            for (const { brand, items } of itemsByBrand.values()) {
                setPriceUploadProgress(70 + (savedCount / Math.max(1, itemsByBrand.size)) * 20, `正在儲存「${brand}」的 ${items.length} 筆 Product Master…`);
                const storedBrand = await saveProductMasterBrand(items, brand);
                const normalizedImported = normalizeProductMasterList(items.map(item => ({ ...item, brand: storedBrand })));
                const visibleImported = (currentUserRole === 'admin' || currentUserRole === 'purchaser')
                    ? normalizedImported
                    : normalizedImported.map(productItemWithoutCost);

                // 以 productId 增量合併本機快取。只上傳幾筆時，不可把同廠牌其他產品從目前畫面暫時移除。
                const merged = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
                visibleImported.forEach(item => merged.set(item.productId || stableProductId(item), item));
                priceList = [...merged.values()];

                const lineCount = new Set(items.map(item => item.productLine || '')).size;
                savedBrands.push(`${storedBrand}（${items.length} 筆／${lineCount} 個產品線）`);
                savedCount += 1;
            }

            refreshPriceDatalists();
            loadPriceCatalogSummary();
            renderCompanyAgencyBrandSettings();
            setPriceUploadProgress(100, `完成：已匯入 ${imported.length} 筆 Product Master，未出現在檔案中的產品不受影響。`);
            alert(`Product Master 匯入完成：\n${savedBrands.join('\n')}\n\n本次只新增／更新檔案中的品項，其他產品不會被刪除或停用。`);
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
