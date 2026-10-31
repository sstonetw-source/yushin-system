let currentCompany = 'yushin';
let restoringQuoteDraft = false;  // 還原本機草稿的過程中，暫停「重新產生單號」之類的副作用，避免蓋掉草稿裡存的資料
let activeQuoteOptionalFields = new Set();
let restoringOrderDraft = false;
let salesList = [
    { name: "預設業務", code: "01", phone: "0912345678" }
];
let priceList = [];
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
    { key: 'products', label: '產品', system: true },
    { key: 'orders', label: '📦 訂單管理系統', system: true },
    { key: 'orders.list', label: '　業務訂單' },
    { key: 'orders.po', label: '　採購訂單' },
    { key: 'inventory', label: '📦 倉庫', system: true },
    { key: 'equipment', label: '🔬 儀器管理系統', system: true },
    { key: 'admin', label: '⚙️ 管理員雲端後台', system: true }
];
// 固定角色權限：前端顯示/查詢與 Firestore Rules 使用同一角色邊界。
// 不再從 settings/rolePermissions 動態載入，避免設定漂移，也減少登入時一次 Firestore 讀取。
const rolePermissions = Object.freeze({
    sales: Object.freeze({ forecast:'edit', quote:'edit', 'quote.create':'edit', 'quote.my':'edit', products:'view', orders:'edit', 'orders.list':'edit', 'orders.po':'none', inventory:'view', equipment:'edit', admin:'none' }),
    purchaser: Object.freeze({ forecast:'none', quote:'edit', 'quote.create':'edit', 'quote.my':'edit', products:'view', orders:'edit', 'orders.list':'edit', 'orders.po':'edit', inventory:'edit', equipment:'none', admin:'none' }),
    warehouse: Object.freeze({ forecast:'none', quote:'none', 'quote.create':'none', 'quote.my':'none', products:'view', orders:'view', 'orders.list':'view', 'orders.po':'view', inventory:'edit', equipment:'none', admin:'none' }),
    engineer: Object.freeze({ forecast:'none', quote:'edit', 'quote.create':'edit', 'quote.my':'edit', products:'view', orders:'edit', 'orders.list':'edit', 'orders.po':'none', inventory:'view', equipment:'edit', admin:'none' })
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
let draftSaveTimer = null;
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
            role:data.role||'sales',name:data.name||'',phone:data.phone||'',code:data.salesCode||data.code||'',mustChangePassword:!!data.mustChangePassword
        }));
    } catch (_) {}
}
function applyUserProfile(data={}) {
    currentUserRole=data.role||'sales';
    trueUserRole=currentUserRole;
    currentUserName=data.name||'';
    currentUserPhone=data.phone||'';
    currentUserCode=data.salesCode||data.code||'';
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
const MAX_ORDER_ITEMS = 15;
function assertOrderItemCount(items) {
    if (items.length > MAX_ORDER_ITEMS) throw new Error(`每張訂單最多 ${MAX_ORDER_ITEMS} 個品項；請分成多張訂單後再儲存，避免後續採購／倉庫作業無法處理。`);
}

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
let maintenanceBrandMigrationPending = false;
const DEFAULT_CANONICAL_BRAND_ALIASES = {
    'Beckman Coulter': ['Beckman', 'Beckman Coulter Life Sciences'],
    'Bio-Rad': ['Biorad', 'Bio Rad', 'BIO-RAD'],
    'Thermo': ['Thermo Fisher', 'Thermo Fisher Scientific'],
    'Roche': ['Roche Diagnostics'],
    'Tanbead': ['Tan Bead']
};
const DEFAULT_KEY_STATISTIC_BRANDS = ['Roche', 'Tanbead', 'Qiagen', 'Bio-Rad', 'Beckman Coulter', 'Thermo', '維修'];
const DEFAULT_STATISTIC_BRAND_ALIASES = JSON.parse(JSON.stringify(DEFAULT_CANONICAL_BRAND_ALIASES));
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
        const section = event.target.closest?.('.content-section') || event.target.closest?.('.workspace-menu-dialog')?.workspaceSourceSection;
        if (!section || !section.classList.contains('active')) return;
        const pageKey = getActivePermissionPage();
        if (!pageKey || canEditPage(pageKey)) return;
        // Products expose separately authorized commercial actions and master-data tools.
        // Their handlers check the action capability; page-level view must not block them.
        if (pageKey === 'products') return;
        if(pageKey==='quote.my'&&canEditPage('quote.create')&&/^copyQuoteAsNew\b/.test(event.target.closest?.('button')?.getAttribute('onclick')||''))return;
        const actionText = event.target.closest?.('button')?.getAttribute('onclick') || '';
        // Service work has its own server-authorized actions; opening its view
        // does not grant permission to edit the commercial order page.
        if(pageKey==='orders.list'&&actionText.trim()==='openServiceCases()'
            &&globalThis.serviceCaseEntryEnabled?.())return;
        if (/^(toggleInventoryRowDetails|loadInventory|closeInventory|downloadInventoryImportTemplate|switchInventoryWorkView)\b/.test(actionText.trim())) return;
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

    window.initializeWorkspaceMenus?.();

    // 估價單表單的草稿自動儲存：只要在「建立估價單」區塊裡打字/選擇/切換任何東西，
    // 都會（debounce 一下）把目前整份內容存到本機瀏覽器，這樣關掉分頁重開也不會不見。
    // 用事件代理監聽整個面板一次，不用每個欄位個別加 oninput，qty/單價這類數字輸入
    // 已經在 calculateTotals() 裡存過了，這裡再存一次是安全的（等於覆蓋同樣的內容）。
    const quoteCreatePanel = document.getElementById('quoteCreatePanel');
    if (quoteCreatePanel) {
        const scheduleDraftSave = () => {
            clearTimeout(draftSaveTimer);
            const uid = currentUser?.uid, generation = sessionDataGeneration;
            draftSaveTimer = setTimeout(() => {
                if (uid && uid === currentUser?.uid && generation === sessionDataGeneration && !restoringQuoteDraft) saveQuoteDraft();
            }, 400);
        };
        quoteCreatePanel.addEventListener('input', scheduleDraftSave);
        quoteCreatePanel.addEventListener('change', scheduleDraftSave);
    }


    // 監控登入狀態：未登入顯示登入畫面，登入後依角色初始化系統
    firebase.auth().onAuthStateChanged(function(user) {
        if (user) {
            if (currentUser?.uid !== user.uid) resetSessionData();
            currentUser = user;
            window.DocumentDownloads?.setUser(user.uid);
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
                if (firebase.auth().currentUser?.uid !== user.uid) return;
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
            resetSessionData();
            currentUser = null;
            window.DocumentDownloads?.setUser('');
            currentUserRole = null;
            trueUserRole = null;
            currentUserName = '';
            currentUserPhone = '';
            currentUserCode = '';
            lastShowAppInitKey = '';
            loadedMainPages.clear(); mainPageRefreshAt.clear(); mainPageLoads.clear();
            invalidateVisibleProductCosts();
            orderWorkQueueGeneration++; orderWorkQueueCache=[]; orderWorkQueueReady=false; orderWorkQueuePromise=null;
            purchaseDemandSummaryGeneration++; purchaseDemandSummaryRows=[]; purchaseDemandSummaryReady=false; purchaseDemandSummaryPromise=null;
            showLoginScreen();
        }
    });
});

function getPagePermission(pageKey, role = currentUserRole) {
    if(pageKey==='inventory'&&['sales','engineer'].includes(role)&&!permissionRulesReady)return 'none';
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

