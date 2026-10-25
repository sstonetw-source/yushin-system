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
    if (quoteListTab) quoteListTab.innerText = canViewAllData('quotes') ? '全部估價單' : '我的估價單';
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
    if(pageKey==='orders.list'&&currentUserRole==='warehouse'&&globalThis.serviceCaseEntryEnabled?.()){
        notice.innerText='倉管模式：訂單資料僅供查看；服務案件可依作業權限收件、委外寄送及返件。';
    } else if (pageKey === 'orders.po' && currentUserRole === 'warehouse' && canReceiveInventoryCapability()) {
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

