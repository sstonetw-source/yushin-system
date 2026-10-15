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
const MAX_ORDER_ITEMS = 30;
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
        const section = event.target.closest?.('.content-section');
        if (!section || !section.classList.contains('active')) return;
        const pageKey = getActivePermissionPage();
        if (!pageKey || canEditPage(pageKey)) return;
        // Products expose separately authorized commercial actions and master-data tools.
        // Their handlers check the action capability; page-level view must not block them.
        if (pageKey === 'products') return;
        if(pageKey==='quote.my'&&canEditPage('quote.create')&&/^copyQuoteAsNew\b/.test(event.target.closest?.('button')?.getAttribute('onclick')||''))return;
        const actionText = event.target.closest?.('button')?.getAttribute('onclick') || '';
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

    // 訂單／估價單／採購單的「更多」選單共用同一組事件代理：
    // 全站同一時間只開一個；點擊外部、完成選擇或按 Esc 都會收起。
    const moreMenuSelector = '.order-more-menu, .quote-more-menu, .po-more-menu';
    const openMoreMenuSelector = '.order-more-menu[open], .quote-more-menu[open], .po-more-menu[open]';
    const orderMenuMobile = window.matchMedia('(max-width: 640px)');
    let orderMenuScrollLock = null;
    function syncOrderMenuViewport() {
        const openOrderMenu = document.querySelector('#ordersBody .order-more-menu[open]');
        const lock = orderMenuMobile.matches && !!openOrderMenu;
        if (lock && !orderMenuScrollLock) {
            const body = document.body;
            orderMenuScrollLock = { y: window.scrollY, position: body.style.position, top: body.style.top, left: body.style.left, right: body.style.right };
            body.style.position = 'fixed';
            body.style.top = `-${orderMenuScrollLock.y}px`;
            body.style.left = '0';
            body.style.right = '0';
            body.classList.add('order-menu-open');
        } else if (!lock && orderMenuScrollLock) {
            const saved = orderMenuScrollLock;
            orderMenuScrollLock = null;
            const body = document.body;
            body.classList.remove('order-menu-open');
            ['position', 'top', 'left', 'right'].forEach(key => { body.style[key] = saved[key]; });
            window.scrollTo(0, saved.y);
        }
        if (lock) {
            const viewport = window.visualViewport;
            const height = viewport?.height || window.innerHeight;
            const bottom = Math.max(0, window.innerHeight - height - (viewport?.offsetTop || 0));
            openOrderMenu.style.setProperty('--order-menu-bottom', `${bottom + 16}px`);
            openOrderMenu.style.setProperty('--order-menu-height', `${height}px`);
        }
    }
    window.visualViewport?.addEventListener('resize', syncOrderMenuViewport);
    window.visualViewport?.addEventListener('scroll', syncOrderMenuViewport);
    window.addEventListener('resize', syncOrderMenuViewport);
    document.addEventListener('toggle', event => {
        const openedMenu = event.target.closest?.(moreMenuSelector);
        if (!openedMenu?.open) { syncOrderMenuViewport(); return; }
        document.querySelectorAll(openMoreMenuSelector).forEach(menu => {
            if (menu !== openedMenu) menu.open = false;
        });
        syncOrderMenuViewport();
    }, true);
    document.addEventListener('click', event => {
        const menu = event.target.closest?.(moreMenuSelector);
        if (!menu) {
            document.querySelectorAll(openMoreMenuSelector).forEach(openMenu => { openMenu.open = false; });
            syncOrderMenuViewport();
            return;
        }
        if (event.target.closest('.order-more-menu-popover button, .quote-more-menu-popover button, .po-more-menu-popover button')) {
            menu.open = false;
            syncOrderMenuViewport();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        document.querySelectorAll(openMoreMenuSelector).forEach(menu => { menu.open = false; });
        syncOrderMenuViewport();
    });

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

// V2 capabilities: role names are mapped once here instead of scattering role === 'sales'
// checks throughout commercial workflows. Firestore Rules mirror these boundaries.
let permissionRulesReady = false;
let permissionRulesCheckedUid = '';
let permissionRulesCheckPromise = null;
function ensurePermissionRulesReady() {
    const uid=currentUser?.uid||'';
    const generation=sessionDataGeneration;
    const isCurrent=()=>generation===sessionDataGeneration&&uid===currentUser?.uid;
    if(!uid)return Promise.resolve(false);
    if(permissionRulesCheckedUid===uid)return Promise.resolve(permissionRulesReady);
    if(permissionRulesCheckPromise)return permissionRulesCheckPromise;
    permissionRulesCheckPromise=firestoreReadWithTimeout(db.collection('stockOperations').doc('permissions-probe').get(),'權限規則版本')
        .then(()=>{if(!isCurrent())return false;permissionRulesReady=true;return true;})
        .catch(err=>{if(!isCurrent())return false;permissionRulesReady=false;console.warn('權限規則版本尚未確認；交易仍使用共用安全流程，不回退舊寫入方式。',err.code||err.message);return false;})
        .finally(()=>{if(!isCurrent())return;permissionRulesCheckedUid=uid;permissionRulesCheckPromise=null;applyPermissionVisibility();});
    return permissionRulesCheckPromise;
}
function supplyOrdersCollection() {
    return db.collection(currentUserRole === 'warehouse' && permissionRulesReady ? 'receivingSupplyOrders' : 'supplyOrders');
}
async function runRoleTransaction(callback) {
    const actorUid=currentUser?.uid||'',actorRole=currentUserRole;
    const assertSession=()=>{if(!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw new Error('登入帳號或角色已變更，請重新開啟作業。');};
    await ensurePermissionRulesReady();
    assertSession();
    if(!globalThis.YushinStockPermissions?.run)throw new Error('安全交易模組未載入，請重新整理後再試。');
    const result = await globalThis.YushinStockPermissions.run(db, callback, actorUid,
        actorRole === 'sales' || actorRole === 'engineer', actorRole, assertSession);
    // A successful transaction can change orders, receipts, stock or purchasing.
    // The next analysis visit must read fresh sources instead of reusing the old report.
    tradeAnalysisReady = false;
    tradeAnalysisLoadedKey = '';
    if(typeof tradeAnalysisSnapshots!=='undefined')tradeAnalysisSnapshots.clear();
    if(typeof tradeAnalysisRevision!=='undefined')tradeAnalysisRevision++;
    markMainPageDirty('admin');
    return result;
}

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
function canConfirmSupplyReceipt(supply) {
    if((supply?.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP')return canReceiveInventoryCapability();
    return currentUserRole==='admin'||(['sales','engineer'].includes(currentUserRole)&&!!currentUser?.uid&&supply?.ownerUid===currentUser.uid);
}
function canManageEquipmentCapability(role = currentUserRole) {
    return role === 'admin' || role === 'engineer';
}

// 採購代辦沿用負責業務的單據歸屬；工程師也是商業單據負責業務。
function isSelectableCommercialOwner(person) {
    return !!person && ['sales', 'engineer'].includes(person.role)
        && person.active !== false && person.disabled !== true
        && !!person.uid && !!person.code;
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

function canUseQuote(record = {}) {
    return canViewAllData('quotes')
        || belongsToCurrentUser(record.salesName, record.ownerUid, record.salesCode)
        || (currentUserRole === 'engineer' && record.createdByUid === currentUser?.uid
            && record.createdByRole === 'engineer');
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
    const purchaseAnalysisTab = document.getElementById('purchase-tab-analysis');
    if (purchaseAnalysisTab) purchaseAnalysisTab.style.display = canCreatePurchaseOrderCapability() ? '' : 'none';
    populatePurchaserOrderFilters();
    document.querySelectorAll('#inventory-system .inventory-header-actions').forEach(el => el.style.display = canEditPage('inventory') ? '' : 'none');
    const receivingTab = document.getElementById('inventoryReceivingTabBtn');
    if (receivingTab) receivingTab.style.display = canReceiveInventoryCapability() ? '' : 'none';
    if (!canReceiveInventoryCapability()) {
        inventoryReceivingVisible = false;
        const stockPanel = document.getElementById('inventoryStockPanel');
        const receivingPanel = document.getElementById('inventoryReceivingPanel');
        const shippingPanel = document.getElementById('inventoryShippingPanel');
        if(shippingPanel)shippingPanel.style.display='none';
        if (stockPanel) stockPanel.style.display = '';
        if (receivingPanel) receivingPanel.style.display = 'none';
    }
    globalThis.updateInventoryWorkspaceBadges?.();
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
        notice.innerText = '倉管模式：可收貨、出貨、調撥點收及盤點；採購、成本維護與打單由採購／管理員處理。';
    } else if (pageKey === 'products' && currentUserRole === 'purchaser') {
        notice.innerText = '產品主檔權限：採購可新增、編輯與停用產品主檔；永久刪除僅限管理員。';
    } else if (pageKey === 'products' && hasBusinessCapability()) {
        notice.innerText = '產品主檔僅可查看；您可以把產品加入估價單或建立訂單，但不能修改、停用或刪除產品主檔。';
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
    restoreReceiptTasks();
    renderReceiptTasks();
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
const mainPageRefreshAt = new Map();
const mainPageLoads = new Map();
const MAIN_PAGE_REFRESH_MS = 60000;
function mainPageLoadFailed(key) { loadedMainPages.delete(key); dirtyMainPages.add(key); }
function mainPageLoadSucceeded(key) { loadedMainPages.add(key); dirtyMainPages.delete(key); mainPageRefreshAt.set(key, Date.now()); }
function refreshVisibleMainPage() {
    if (!currentUser || document.visibilityState === 'hidden' || navigator.onLine === false) return;
    if (document.querySelector('.eq-modal-overlay.active, .modal-overlay.active')) return;
    const key = getActivePermissionPage().split('.')[0];
    const mainKey = key === 'orders' ? (document.querySelector('.content-section.active')?.id === 'purchasing-system' ? 'orders.po' : 'orders.list') : key;
    if (mainKey === 'admin') {
        if (document.getElementById('admin-statistics')?.style.display === 'block') loadSalesStatistics();
        return;
    }
    if (mainKey === 'products' && productManagementSourceMode === 'search') return;
    if (mainKey === 'quote') {
        if (document.getElementById('myQuotesPanel')?.style.display === 'block') loadMyQuotesPage(true);
        return;
    }
    if (['forecast','products','orders.list','orders.po','inventory','equipment'].includes(mainKey)) initializePageData(mainKey);
}
window.setInterval(refreshVisibleMainPage, MAIN_PAGE_REFRESH_MS);
const dirtyMainPages = new Set();

function markMainPageDirty(...mainKeys) {
    mainKeys.flat().filter(Boolean).forEach(mainKey => { dirtyMainPages.add(mainKey); });
    if (mainKeys.flat().some(key => key === 'orders.list' || key === 'orders.po')) orderWorkQueueLoadedAt = 0;
}

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
    if(permissionRulesCheckedUid!==currentUser?.uid){
        if(currentUserRole==='warehouse')return ensurePermissionRulesReady().then(()=>initializePageData(mainKey,options));
        ensurePermissionRulesReady();
    }
    const wasLoaded = loadedMainPages.has(mainKey);
    const requestedUid=currentUser?.uid, requestedRole=currentUserRole;
    if(mainPageLoads.has(mainKey)) return mainPageLoads.get(mainKey);
    const jobs=[];
    const force = options.force === true || dirtyMainPages.has(mainKey) || Date.now() - (mainPageRefreshAt.get(mainKey) || 0) >= MAIN_PAGE_REFRESH_MS;
    hydratePageFromLocalCache(mainKey);
    if (!force && loadedMainPages.has(mainKey)) return;
    dirtyMainPages.delete(mainKey);

    if (['quote', 'forecast', 'orders.list', 'inventory', 'equipment', 'admin'].includes(mainKey)) {
        ensureBrandSettingsLoaded().then(() => {
            if (mainKey === 'forecast' && canAccessPage('forecast')) renderForecastList();
            if (mainKey === 'orders.list' && canAccessPage('orders.list')) renderOrdersList();
            if (mainKey === 'inventory' && canAccessPage('inventory')) renderInventoryList();
            if (mainKey === 'equipment' && canAccessPage('equipment')) renderEquipmentList();
        }).catch(err => console.warn('廠牌設定載入失敗：', err));
    }
    if (mainKey === 'forecast') {
        // 一般業務只看自己，不需要讀完整 users 名單；只有可看全公司 Forecast 的角色才補齊負責業務篩選。
        jobs.push(loadForecasts(true));
        if (canViewAllData('forecast')) {
            ensureSalesListLoaded().then(populateForecastSalesFilter).catch(err => console.warn('業務名單載入失敗：', err));
        } else {
            populateForecastSalesFilter();
        }
    }
    if (mainKey === 'quote') jobs.push(ensureQuoteFormInitialized());
    if (mainKey === 'products' && productManagementSourceMode === 'search') { renderProductManagementResults(); }
    else if (mainKey === 'products' && wasLoaded && force && productBrandBrowseCurrent) { reloadCurrentProductBrand(); return; }
    else if (mainKey === 'products') {
        clearProductManagementSearch({ preserveInput: true });
        updatePendingProductMasterButton();
        jobs.push(ensureProductBrandBrowserLoaded());
    }
    if (mainKey === 'orders.list') {
        // 訂單列表本身不需要完整 Product Master。先載 50 筆訂單，避免 iPhone 每次進頁
        // 都等待 Product Master 與大量 datalist DOM 建立完成才顯示資料。
        if (canViewAllData('orders')) {
            ensureSalesListLoaded().then(() => {
                if (canAccessPage('orders.list')) renderOrdersList();
            }).catch(err => console.warn('業務名單載入失敗：', err));
        }
        jobs.push(loadOrdersFromCloud());
        jobs.push(loadOrderWorkQueue(force));
        // 廠牌資料由上方共用 ensureBrandSettingsLoaded() 處理；
        // 不再另外掛一個 loadBrandMaster().then(renderOrdersList)，避免同一批品牌完成時重畫兩次。
    }
    if (mainKey === 'orders.po') {
        // 採購頁只啟動一個共用 orders 背景更新；各工作分頁都沿用同一份 ordersCache。
        // 先立即畫快取，業務名單＋品牌設定在背景完成後只補畫一次，避免手機重複掃同一批訂單。
        if (force) purchasingViewLoaded.clear();
        jobs.push(loadOrderWorkQueue(force));
        jobs.push(loadPurchaseDemandSummary(force));
        switchPurchasingView(wasLoaded ? purchasingView : (canCreatePurchaseOrderCapability() ? 'ordering' : 'receiving'));
        // 待到貨圖卡需要 supplyOrders 才能包含公司備庫採購；不能等使用者點進「待到貨」才載入，
        // 否則重新登入後可能短暫顯示 0，甚至與庫存「在途」數字不一致。
        loadActiveReceivingSupplyCache(true).then(() => {
            mergeReceivingSourceOrdersIntoOrderCache();
            if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        }).catch(err => console.warn('待到貨背景資料載入失敗：', err));
        loadInventoryReplenishmentCenter(false)
            .catch(err => console.warn('安全庫存背景資料載入失敗：', err));
        Promise.allSettled([ensureSalesListLoaded(), ensureBrandSettingsLoaded()]).then(results => {
            const failed = results.filter(result => result.status === 'rejected');
            failed.forEach(result => console.warn('採購頁背景設定載入失敗：', result.reason));
            // 人員／品牌完成只會改變篩選選項；目前沒有選擇篩選時，不需要把整批訂單再 normalize / 重算一次。
            if (canAccessPage('orders.po')) populatePurchasingFilters();
        });
    }
    if (mainKey === 'inventory') {
        jobs.push(loadInventory(true));
        if (canReceiveInventoryCapability()) jobs.push(window.loadInventoryWorkspace?.(force));
        // Brand Master 已由上方 ensureBrandSettingsLoaded() 共用載入；
        // 完成後會統一 renderInventoryList，不再額外重畫一次。
    }
    if (mainKey === 'equipment') {
        // 儀器列表先載入；只有能看全公司儀器的身份才需要完整 users 名單。
        // 一般業務／工程師直接使用登入者姓名與業務代號，避免每次進頁都掃 users。
        jobs.push(loadEquipmentFromCloud());
        if (canViewAllEquipment()) {
            ensureSalesListLoaded()
                .then(() => { populateEquipmentSalesDropdown(); renderEquipmentList(); })
                .catch(err => console.warn('業務名單載入失敗：', err));
        } else {
            populateEquipmentSalesDropdown();
        }
        // Brand Master 已由上方 ensureBrandSettingsLoaded() 共用載入與重畫。
    }
    if (mainKey === 'admin') jobs.push(reloadSalesFromUsers());
    const request = Promise.allSettled(jobs).then(results=>{
        if(requestedUid!==currentUser?.uid || requestedRole!==currentUserRole)return;
        if(results.some(result=>result.status==='rejected'))mainPageLoadFailed(mainKey);
        else if(!dirtyMainPages.has(mainKey))mainPageLoadSucceeded(mainKey);
    }).finally(()=>{if(mainPageLoads.get(mainKey)===request)mainPageLoads.delete(mainKey);});
    mainPageLoads.set(mainKey,request);
    return request;
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

