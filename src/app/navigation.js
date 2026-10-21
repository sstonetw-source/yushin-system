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
        if (currentUser && backgroundDuration >= 5000 && !orderListVisible) refreshVisibleMainPage();
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
let sessionDataGeneration = 0;
function resetSessionData() {
    sessionDataGeneration++;
    window.resetCustomerReturnReceiptView?.();
    window.closePurchaseOrderModal?.();
    permissionRulesReady=false; permissionRulesCheckedUid=''; permissionRulesCheckPromise=null;
    // 先清掉前一個視角的分頁狀態，避免非同步查詢完成前短暫顯示不屬於新視角的資料。
    loadedMainPages.clear();
    mainPageRefreshAt.clear(); mainPageLoads.clear();
    lastShowAppInitKey = '';
    myQuotesCache = [];
    myQuotesPaginationState = null;
    ordersCache = [];
    orderPaginationState = null;
    // 讓前一視角的讀取失效，避免舊 Promise 回報錯誤或卡住新視角。
    orderLoadGeneration++;
    orderPageLoading = false;
    orderReloadRequested = false;
    orderLoadErrorMessage = '';
    orderWorkQueueError = '';
    invalidateVisibleProductCosts();
    orderWorkQueueCache = []; orderWorkQueueReady = false; orderWorkQueueGeneration++; orderWorkQueuePromise = null;
    forecastCache = [];
    forecastCursor = null;
    forecastHasMore = true;
    inventoryCache = [];
    inventoryCursor = null;
    inventoryHasMore = true;
    window.resetInventoryLotView?.();
    inventorySearchGeneration++;inventoryLotSearchState=null;inventorySearchLoading=false;inventorySearchActive=false;inventorySearchResults=[];
        pendingPurchaseCache = [];
    procurementDemandCache = [];
    procurementDemandCursor = null;
    procurementDemandHasMore = true;
    procurementDemandLoaded = false;
    purchaseDemandSummaryRows=[]; purchaseDemandSummaryReady=false; purchaseDemandSummaryGeneration++; purchaseDemandSummaryPromise=null;
    procurementDemandSourceOrderCache = new Map();
    pendingPurchaseCursor = null;
    pendingPurchaseHasMore = true;
    pendingPurchaseError = '';
    poListCache = [];
    poListCursor = null;
    poListHasMore = false;
    poHistorySearchResults = [];
    poHistorySearchActive = false;
    poHistorySearchLoading = false;
    purchaseHistorySupplyCache = new Map();
    window.resetWarehouseLogistics?.();
    supplyReceivingCache = [];
    supplyReceivingCursor = null;
    supplyReceivingHasMore = true;
    receivingSourceOrderStatusCache = new Map();
    receivingSourceOrderCache = new Map();
    purchasingReceivingReady = false;
    activeReceivingSupplyLoadPromise = null;
    activeReceivingSupplyReady=false; activeReceivingSupplyError='';
    purchasingOrdersReady = false;
    purchasingDispatchCache = [];
    purchasingDispatchCursor = null;
    purchasingDispatchHasMore = true;
    purchasingDispatchError = '';
    purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT;
    purchasingViewLoaded.clear();
    equipmentList = [];
    equipmentLoadGeneration++; equipmentSearchGeneration++;
    forecastLoadGeneration++; forecastHistorySearchGeneration++;
    quoteHistorySearchGeneration++; orderHistorySearchGeneration++; poHistorySearchGeneration++;
    productManagementSearchGeneration++; productBrandBrowseGeneration++; businessProductSearchGeneration++;
    orderModalOpenGeneration++; orderDraftProductCheckGeneration++;
    forecastHistorySearchResults=[]; quoteHistorySearchResults=[]; orderHistorySearchResults=[];
    salesList=[]; salesListLoadPromise=null; allUsersCache=[]; salesCodeMasterCache=[];
    salesStatisticsOrders=[]; tradeAnalysisReady=false;
    salesStatisticsLoadPromise=null; inventoryAnalysisReceipts=[]; inventoryAnalysisStocks=[]; inventoryAnalysisLots=[];
    inventoryAnalysisLotCosts.clear(); inventoryAnalysisSupplyOrders=[]; inventoryAnalysisDirectShipSupplyOrders=[];
    tradeAnalysisSnapshots.clear(); tradeAnalysisRevision++;
    purchaseCostCache.clear(); warehouseStockCache.clear(); visibleProductCostCache.clear();
    productCodeMatchCache.clear(); productManagementSearchCache.clear();
    inventoryLedgerCache=[]; pendingSupplyCache=[]; inventoryReplenishmentCache=[];
    newOrderDraftItems=[]; requestedOrderOwnerUid=''; editingQuoteNo=null; quoteFormInitialized=false;
    forecastLoading=false; forecastReloadRequested=false; inventoryLoading=false; myQuotesPageLoading=false; myQuotesReloadRequested=false;
    window._orderModalQuoteContext=null; window._orderModalSourceLink=null;
    clearTimeout(draftSaveTimer);
    window.resetDeliverySettings?.(); window.resetMainTransferRequests?.(); window.resetFreeStockRecovery?.(); window.resetProduct360?.();
    document.querySelectorAll('.content-section tbody').forEach(body=>body.replaceChildren());
    document.querySelectorAll('.eq-modal-overlay.active, .modal-overlay.active').forEach(overlay=>overlay.classList.remove('active'));
    for (const id of ['clientName','ordererName','quoteRemarks','salesName','orderCustomer','orderInvoiceTitle','orderRemarks']) {
        const field=document.getElementById(id); if(field)field.value='';
    }
    const taskStatus=document.getElementById('receiptTaskStatus'); if(taskStatus)taskStatus.replaceChildren();
    receiptTaskJobs.clear();
}
window.switchViewRole = function(role) {
    if (trueUserRole !== 'admin') return;
    currentUserRole = role;
    resetSessionData();
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

