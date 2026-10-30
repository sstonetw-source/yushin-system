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
let purchaseHistorySupplyCache = new Map();
let supplyReceivingCache = [];
let supplyReceivingCursor = null;
let supplyReceivingHasMore = true;
let receivingSourceOrderStatusCache = new Map();
let receivingSourceOrderCache = new Map();
let purchasingOrderRefreshPromise = null;
let purchasingOrdersReady = false;
let purchasingReceivingLoadPromise = null;
let activeReceivingSupplyLoadPromise = null;
let activeReceivingSupplyReady=false, activeReceivingSupplyError='';
let purchasingReceivingReady = false;
let purchasingView = 'ordering';
let pendingPurchaseCursor = null;
let pendingPurchaseHasMore = true;
let pendingPurchaseLoading = false;
let pendingPurchaseCache = [];
let procurementDemandCache = [];
let procurementDemandCursor = null;
let procurementDemandHasMore = true;
let procurementDemandLoaded = false;
let procurementDemandSourceOrderCache = new Map();
const selectedPendingPurchaseDemandIds = new Set();

function invalidateProcurementDemandQueue(options = {}) {
    purchaseDemandSummaryReady=false;
    if(document.getElementById('purchasing-system')?.classList.contains('active'))loadPurchaseDemandSummary(true);
    markMainPageDirty('orders.po');
    if (options.preserveQueue) return;
    procurementDemandCache=[];
    procurementDemandCursor=null;
    procurementDemandHasMore=true;
    procurementDemandLoaded=false;
    procurementDemandSourceOrderCache=new Map();
    selectedPendingPurchaseDemandIds.clear();
    purchasingViewLoaded?.delete?.('ordering');
}

function syncCommittedQuickPurchaseDemand(demand, order) {
    // Keep loaded pages and their cursor: confirming one item must not reset the queue.
    if (demand?.id) {
        const index = procurementDemandCache.findIndex(row => row.id === demand.id);
        if (Number(demand.remainingToOrderQty || 0) > 0) {
            if (index >= 0) procurementDemandCache[index] = demand;
            else procurementDemandCache.unshift(demand);
        } else if (index >= 0) procurementDemandCache.splice(index, 1);
        selectedPendingPurchaseDemandIds.delete(demand.id);
    }
    if (order?.id) procurementDemandSourceOrderCache.set(order.id, order);
    invalidateProcurementDemandQueue({ preserveQueue:true });
}
let pendingPurchaseError = '';
let purchasingDispatchCache = [];
let purchasingDispatchCursor = null;
let purchasingDispatchHasMore = true;
let purchasingDispatchLoading = false;
let purchasingDispatchError = '';
let purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT;
let purchasingAnalyticsRows = [];
let purchasingAnalyticsLoading = false;
let purchasingAnalyticsLoadedRangeKey = '';

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

// 倉管供應檢視由 stock-permissions 在供應異動交易中同步；讀取頁面不寫資料。
async function loadActiveReceivingSupplyCache(reset = true) {
    if (!canAccessPage('orders.po') && !(canAccessPage('inventory') && canReceiveInventoryCapability())) return [];
    if (activeReceivingSupplyLoadPromise) return activeReceivingSupplyLoadPromise;
    const requestedRole = currentUserRole, requestedUid = currentUser?.uid;
    activeReceivingSupplyReady=false; activeReceivingSupplyError='';
    const request = (async () => {
        const records = new Map((reset ? [] : supplyReceivingCache).map(row => [row.id, row]));
        let cursor = null;
        while (true) {
            let query = supplyOrdersCollection()
                .where('status','in',['ORDERED','PARTIAL_RECEIPT'])
                .orderBy(firebase.firestore.FieldPath.documentId())
                .limit(200);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '待到貨供應');
            snapshot.docs.forEach(doc => records.set(doc.id, { id:doc.id, ...doc.data() }));
            if (snapshot.size < 200) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
        }
        if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid || (!canAccessPage('orders.po') && !(canAccessPage('inventory') && canReceiveInventoryCapability()))) return [];

        const rows = [...records.values()]
            .sort((a,b)=>String(b.orderDate||b.createdAt||'').localeCompare(String(a.orderDate||a.createdAt||'')));
        supplyReceivingCache = rows;
        // 這裡已完整讀取「仍在途」的 active queue；待到貨工作不再受 50 筆歷史分頁影響。
        supplyReceivingCursor = null;
        supplyReceivingHasMore = false;

        const sourceOrderIds = [...new Set(rows.map(row=>String(row.orderId||'').trim()).filter(Boolean))];
        const cachedOrders = new Map(ordersCache.map(order=>[order.id,order]));
        const nextSourceOrders = new Map();
        const nextSourceStatuses = new Map();
        sourceOrderIds.forEach(id => {
            const cached = cachedOrders.get(id);
            if (!cached) return;
            nextSourceOrders.set(id,cached);
            nextSourceStatuses.set(id,normalizedOrderStatus(cached));
        });
        const missingSourceIds = sourceOrderIds.filter(id=>!nextSourceOrders.has(id));
        const sourceOrders = await readDocumentsByIds('orders', missingSourceIds);
        sourceOrders.forEach(order=>{nextSourceOrders.set(order.id,order);nextSourceStatuses.set(order.id,normalizedOrderStatus(order));});
        if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid || (!canAccessPage('orders.po') && !(canAccessPage('inventory') && canReceiveInventoryCapability()))) return [];
        receivingSourceOrderCache = nextSourceOrders;
        receivingSourceOrderStatusCache = nextSourceStatuses;
        activeReceivingSupplyReady=true;
        return rows;
    })().catch(err=>{
        if(requestedRole===currentUserRole&&requestedUid===currentUser?.uid){activeReceivingSupplyError='待到貨供應讀取失敗';mainPageLoadFailed('orders.po');if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView();}
        throw err;
    }).finally(() => {
        if(activeReceivingSupplyLoadPromise===request)activeReceivingSupplyLoadPromise = null;
    });
    activeReceivingSupplyLoadPromise=request;
    return request;
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
        loadActiveReceivingSupplyCache(reset),
        getDataScope('orders') !== 'none' ? refreshPurchasingOrderCache(reset, options) : Promise.resolve()
    ]).then(results => {
        purchasingReceivingReady = true;
        const failed = results.filter(result => result.status === 'rejected');
        // 「全部採購單」歷史查詢與「待到貨」供應查詢分離，避免兩頁同時載入時共用 lock
        // 造成 supplyOrders 沒有真正查到、卻被誤標成已載入的 0 筆狀態。
        mergeReceivingSourceOrdersIntoOrderCache();
        renderPurchasingView();
        if (document.getElementById('inventory-system')?.classList.contains('active') && inventoryReceivingVisible) renderPurchasingReceivingWorkList(null, null, null, null, true);
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
    const brands = workflowPurchasingBrandNames();
    const signature = JSON.stringify([sales, brands]);

    // renderPurchasingView 會在切頁、篩選、背景更新時反覆呼叫；選項沒變就不要重建整個 select DOM。
    if (signature !== purchasingFilterOptionsSignature) {
        salesSelect.innerHTML = '<option value="">全部負責業務</option>' + sales.map(name =>
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
    if (['ordering', 'receiving', 'dispatch'].includes(purchasingView)) return { start:'', end:'' };
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
        selectableBrands: workflowPurchasingBrandNames()
    };
}

function purchaseLineMatchesFilters(date, salesName, brand, context = null) {
    const filters = context || purchaseFilterContext();
    const businessDate = normalizeBusinessDate(date);
    if ((filters.start || filters.end) && (!businessDate || (filters.start && businessDate < filters.start) || (filters.end && businessDate > filters.end))) return false;
    if (filters.selectedSales && stripPhoneSuffix(salesName) !== filters.selectedSales) return false;
    return !filters.selectedBrand || orderBrandFilterValue(brand, filters.selectableBrands) === filters.selectedBrand;
}

function procurementDemandForOrderItem(order, item, dispatchOverride = null) {
    const dispatch = dispatchOverride || itemDispatchState(order,item);
    const fulfillmentType = item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE';
    const directShip = fulfillmentType === 'DIRECT_SHIP';
    const hasWarehouseShipments = Array.isArray(order.warehouseShipmentRecords) && order.warehouseShipmentRecords.length > 0;
    let source=item,warehouseShipmentContext;
    if(hasWarehouseShipments){
        // Validate every line before partitioning: a sibling's corrupt event
        // must not disappear when this page renders only the selected item.
        const projected=globalThis.YushinFulfillment.projectOrderShipmentReturns({orderId:order.id,items:order.items,
            shipments:order.warehouseShipmentRecords,deliveries:order.deliveryRecords??[],returns:order.returnRecords??[]});
        source=order.items.find(row=>row.itemId===item.itemId);
        if(!source||!projected.items.some(row=>row.itemId===item.itemId))throw Error('找不到原始採購需求品項。');
        // Presentation normalization measures pending acknowledgement. Physical
        // demand must retain the raw reservation/shortage after warehouse debit.
        warehouseShipmentContext={orderId:order.id,itemId:source.itemId,productKey:source.inventoryProductKey||source.productId,
            shipments:order.warehouseShipmentRecords.filter(row=>row.itemId===source.itemId),
            deliveries:(order.deliveryRecords??[]).filter(row=>row.itemId===source.itemId),
            returns:(order.returnRecords??[]).filter(row=>row.itemId===source.itemId)};
    }
    const quantities = globalThis.YushinWorkflow?.procurementQuantities({
        orderedQty:source.orderedQty ?? source.qty,
        fulfillmentType,
        productType:source.productType||item.productType||order.productType||'',
        ...(hasWarehouseShipments?{warehouseShipmentContext,warehouseShippedQty:source.warehouseShippedQty}:{}),
        reservedQty:source.reservedQty,
        shortageQty:source.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty,
        receivedQty:item.receivedQty,
        deliveredQty:dispatch.grossDelivered,
        effectiveDeliveredQty:dispatch.delivered,
        // Normalized items exclude CLOSE returns for legacy replacement demand.
        // The v2 dispatch adapter reads the original cumulative return snapshot,
        // which Workflow checks against the authoritative shipment/return events.
        returnedQty:directShip || hasWarehouseShipments ? dispatch.returned : Number(item.returnedQty ?? dispatch.returned ?? 0)
    });
    if (!quantities) throw new Error('Workflow core 未載入，無法計算採購需求。');
    const demand = globalThis.YushinProcurementDemand?.fromSalesOrder({
        sourceId:order.id || '',
        sourceItemId:item.itemId || '',
        sourceItemIndex:(order.items||[]).findIndex((row,index)=>String(row.itemId||`item-${index+1}`)===String(item.itemId||'')),
        fulfillmentType,
        shortageQty:quantities.requiredSupplyQty,
        inTransitQty:quantities.inTransitQty,
        requiredSupplyQty:quantities.requiredSupplyQty,
        supplyOrderedQty:quantities.supplyOrderedQty,
        receivedQty:quantities.receivedQty,
        // Material Request / demand date: when the business needs the item.
        // Keep this separate from supplier ETA stored on supplyOrders.
        scheduleDate:item.requiredByDate||item.scheduleDate||order.requiredByDate||order.expectedDate||''
    });
    if (!demand) throw new Error('Procurement Demand core 未載入，無法計算採購需求。');
    return demand;
}

function procurementDemandRef(demandId) {
    const id=String(demandId||'').trim();
    return id ? db.collection('procurementDemands').doc(encodeURIComponent(id)) : null;
}

function procurementDemandDocument(demand={},context={},meta={}) {
    if (!globalThis.YushinProcurementDemand?.demandDocument) {
        throw new Error('Procurement Demand core 未載入，無法建立正式採購需求。');
    }
    return globalThis.YushinProcurementDemand.demandDocument({
        ...demand,
        ...context
    },meta);
}

function remainingProcurementQty(order, item, dispatchOverride = null) {
    return procurementDemandForOrderItem(order,item,dispatchOverride).remainingToOrderQty;
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
    if (normalizedOrderStatus(order) !== 'normal' || ['pending','failed'].includes(order?.inventoryReservationStatus)) return [];
    // 工作卡與明細只讀訂單本身；不要在 render 階段解析成本／Product Master。
    // 同一輪採購頁 render 可直接沿用已 normalize 的品項快照。
    // 真正按「已採購／產生採購單」時，pendingPurchaseLines() 才補齊正式採購資料。
    const items = normalizedItems || normalizedOrderItems(order);
    const lifecycle = lifecycleOverride || orderLifecycleInfo(order, items);
    return items.map((item, index) => {
        const dispatch = dispatchStateByItem?.get(item) || itemDispatchState(order, item);
        if (orderItemWorkCategory(order, item, lifecycle, dispatch) !== 'ordering') return null;
        const demand = procurementDemandForOrderItem(order, item, dispatch);
        const qty = demand.remainingToOrderQty;
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
            demandId:demand.demandId || '',
            sourceType:demand.sourceType || 'SALES_ORDER',
            sourceId:demand.sourceId || order.id || '',
            sourceItemId:demand.sourceItemId || item.itemId || '',
            demandStatus:demand.status,
            demandStatusLabel:globalThis.YushinProcurementDemand?.statusLabel(demand.status) || '待採購',
            salesName: order.salesName || '',
            fulfillmentType: item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE',
            procurementType: item.procurementType || order.procurementType || 'PURCHASING_PO'
        };
    }).filter(Boolean);
}

function receivingSupplyMetrics(filters = purchaseFilterContext()) {
    const metrics = { count:0, amount:0, missingCost:0, quantity:0 };
    const seen = new Set();
    supplyReceivingCache.forEach(supply => {
        if (seen.has(supply.id)) return;
        seen.add(supply.id);
        const progress = globalThis.YushinSupply?.receiptProgress(supply);
        if (!progress || !['ORDERED', 'PARTIAL_RECEIPT'].includes(progress.status) || !(progress.remainingQty > 0)) return;
        const order = receivingSourceOrderForItem(supply);
        // Standalone company stock is shared; linked supplies retain their sales filter.
        // A cancelled customer order does not cancel the real supplier commitment.
        const effectiveFilters = supply.orderId ? filters : {...filters, selectedSales:''};
        if (!purchaseLineMatchesFilters(order?.orderDate || supply.orderDate || supply.createdAt,
            order?.salesName || supply.salesName || '', supply.brand, effectiveFilters)) return;
        metrics.count += 1;
        metrics.quantity += progress.remainingQty;
        const cost = tradeAnalysisCost(supply.unitCost);
        if (cost === null) metrics.missingCost += 1;
        else metrics.amount += progress.remainingQty * cost;
    });
    return metrics;
}

let purchaseDemandSummaryRows = [], purchaseDemandSummaryReady = false, purchaseDemandSummaryError = '';
let purchaseDemandSummaryPromise = null, purchaseDemandSummaryGeneration = 0;
async function loadPurchaseDemandSummary(force = false) {
    if (!canCreatePurchaseOrderCapability()) return;
    if (purchaseDemandSummaryPromise && !force) return purchaseDemandSummaryPromise;
    const generation = ++purchaseDemandSummaryGeneration, uid=currentUser?.uid, role=currentUserRole;
    purchaseDemandSummaryReady=false; purchaseDemandSummaryError='';
    const request=(async()=>{
        try {
            const rows=await readQueryInBatches(db.collection('procurementDemands').where('remainingToOrderQty','>',0).orderBy('remainingToOrderQty','desc'),200);
            const ids=rows.filter(row=>row.sourceType==='SALES_ORDER').map(row=>row.sourceId);
            const orders=await readDocumentsByIds('orders',ids);
            if(generation!==purchaseDemandSummaryGeneration || uid!==currentUser?.uid || role!==currentUserRole)return;
            orders.forEach(row=>procurementDemandSourceOrderCache.set(row.id,row));
            purchaseDemandSummaryRows=rows; purchaseDemandSummaryReady=true;
        } catch(err) {
            if(generation!==purchaseDemandSummaryGeneration || uid!==currentUser?.uid || role!==currentUserRole)return;
            purchaseDemandSummaryError='讀取失敗，請重試'; mainPageLoadFailed('orders.po');
        } finally { if(generation===purchaseDemandSummaryGeneration && document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView(); }
    })();
    purchaseDemandSummaryPromise=request;
    try{return await request;}finally{if(purchaseDemandSummaryPromise===request)purchaseDemandSummaryPromise=null;}
}
function renderPurchasingWorkCards(normalizedItemsByOrder = null, completedRows = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const definitions = [
        ['ordering', 'purchaseCountOrdering', 'purchaseAmountOrdering'],
        ['arrival', 'purchaseCountReceiving', 'purchaseAmountReceiving'],
        ['dispatch', 'purchaseCountDispatch', 'purchaseAmountDispatch']
    ];
    const historyFilters = filterContext || purchaseFilterContext();
    const filters = {...historyFilters,start:'',end:''};
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
    const receiving = receivingSupplyMetrics(filters);
    const demandOrderingRows=purchaseDemandSummaryReady ? purchaseDemandSummaryRows.filter(demand=>{
        if(!(Number(demand.remainingToOrderQty||0)>0))return false;
        const order=demand.sourceType==='SALES_ORDER'
            ? procurementDemandSourceOrderCache.get(String(demand.sourceId||'')) || null
            : null;
        if(order&&normalizedOrderStatus(order)!=='normal')return false;
        const date=order?.orderDate||String(demand.createdAt||'').slice(0,10);
        return purchaseLineMatchesFilters(date,demand.salesName||order?.salesName||'',demand.brand||'',filters);
    }) : null;
    const demandOrderingAmount=demandOrderingRows ? demandOrderingRows.reduce((sum,demand)=>{
        const order=demand.sourceType==='SALES_ORDER'
            ? procurementDemandSourceOrderCache.get(String(demand.sourceId||'')) || null
            : null;
        const item=order ? normalizedOrderItems(order).find(row=>String(row.itemId||'')===String(demand.sourceItemId||'')) : null;
        return sum + Number(item?.unitPrice||item?.salesPrice||0)*Number(demand.remainingToOrderQty||0);
    },0) : 0;

    definitions.forEach(([category, countId, amountId]) => {
        const count = document.getElementById(countId);
        const amount = document.getElementById(amountId);
        const useDemand=category==='ordering'&&demandOrderingRows;
        const baseCount=category === 'arrival' ? receiving.count : useDemand?demandOrderingRows.length:metrics[category].count;
        const baseAmount=category === 'arrival' ? receiving.amount : useDemand?demandOrderingAmount:metrics[category].amount;
        if (count) count.textContent = category === 'ordering' && !purchaseDemandSummaryReady ? (purchaseDemandSummaryError || '讀取中…') : category==='arrival' && !activeReceivingSupplyReady ? (activeReceivingSupplyError || '讀取中…') : !orderWorkQueueReady && category === 'dispatch' ? (orderWorkQueueError || '讀取中…') : `${baseCount} ${category === 'arrival' ? '筆供應' : '品項'}`;
        if (amount) amount.textContent = category === 'arrival' && !activeReceivingSupplyReady ? (activeReceivingSupplyError || '讀取中…') : category === 'arrival' && !canCreatePurchaseOrderCapability()
            ? '成本不顯示'
            : (category === 'arrival' ? '採購金額 ' : '銷售金額 ') + formatStatsMoney(baseAmount) + (category === 'arrival' && receiving.missingCost ? `（${receiving.missingCost} 筆待補成本）` : '');
    });
    const stockingSummary = document.getElementById('purchaseStockingSummary');
    if (stockingSummary) {
        const receiving = document.getElementById('purchaseCountReceiving')?.textContent || '0 筆';
        const dispatch = document.getElementById('purchaseCountDispatch')?.textContent || '0 筆';
        stockingSummary.textContent = `待到貨 ${receiving}｜待打單 ${dispatch}`;
    }

    // 圖卡統計已載入資料中的全部已完成品項；50 筆限制只套在下方明細顯示，
    // 避免使用者按「載入更多」時圖卡數字跟著人為跳動。
    const completed = completedRows || purchasingCompletedRows(historyFilters, itemMap, stateMap, lifecycleMap);
    const completedCount = document.getElementById('purchaseCountCompleted');
    const completedAmount = document.getElementById('purchaseAmountCompleted');
    if (completedCount) completedCount.textContent = `${completed.length} 品項`;
    if (completedAmount) completedAmount.textContent = '銷售金額 ' + formatStatsMoney(completed.reduce((sum, row) =>
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
    const rows = allRows.filter(({order,item})=>workflowLineMatchesSearch(order,item,document.getElementById('purchaseWorkSearch')?.value)).slice(0, purchasingCompletedVisibleLimit);
    body.innerHTML = rows.map(({order, item, state}) => `<tr><td data-th="訂單日期">${workflowRecordSummary(order, order.orderDate)}</td><td data-th="客戶">${escapeHtml(order.customerName || order.customer || '')}</td><td data-th="已完成採購品項">${purchaseProductSummary(item, state.prepared || item.dispatchPreparedQty || item.qty, null)}</td><td data-th="數量">${workflowQuantitySummary(state.prepared || item.dispatchPreparedQty || item.qty,(item.fulfillmentType || order.fulfillmentType) === 'DIRECT_SHIP' ? '已到貨' : '已打單')}</td><td data-th="負責業務">${escapeHtml(order.salesName || '')}</td><td data-th="操作" class="no-print"><button type="button" class="btn-small btn-secondary" onclick="openOrderStatusHistory(${inlineJsValue(order.id)})">查看紀錄</button></td></tr>`).join('');
    [...body.children].forEach((row,index)=>organizePurchasingOrderRow(row,rows[index].order,rows[index].item));
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

function adminPurchaseAnalyticsFilterContext() {
    return {
        start: document.getElementById('salesStatsStart')?.value || '',
        end: document.getElementById('salesStatsEnd')?.value || '',
        selectedSales: stripPhoneSuffix(document.getElementById('salesStatsSalesFilter')?.value || ''),
        selectedBrand: document.getElementById('salesStatsBrandFilter')?.value || '',
        selectableBrands: workflowPurchasingBrandNames()
    };
}

function purchasingAnalyticsRangeKey(filters = adminPurchaseAnalyticsFilterContext()) {
    return JSON.stringify([filters.start || '', filters.end || '']);
}

function purchasingAnalyticsRowMatches(supply, filters = adminPurchaseAnalyticsFilterContext()) {
    const businessDate = normalizeBusinessDate(supply.orderDate || supply.createdAt);
    if ((filters.start || filters.end)
        && (!businessDate || (filters.start && businessDate < filters.start) || (filters.end && businessDate > filters.end))) return false;
    if (filters.selectedSales) {
        const code=String(supply.salesCode||'').trim();
        const codeOwner=code
            ? salesList.find(person=>String(person.code||'').trim()===code)
            : null;
        const resolvedName=stripPhoneSuffix(codeOwner?.name||supply.salesName||'');
        if (resolvedName !== filters.selectedSales) return false;
    }
    if (filters.selectedBrand
        && orderBrandFilterValue(supply.brand || '', filters.selectableBrands) !== filters.selectedBrand) return false;
    return true;
}

function statisticBrandForSupply(supply = {}) {
    const grouped = orderBrandFilterValue(
        supply.brand || supply.brandName || '',
        workflowPurchasingBrandNames()
    );
    return grouped || OTHER_BRAND_OPTION_KEY;
}

function purchasingAnalyticsMetrics(rows = purchasingAnalyticsRows, filters = adminPurchaseAnalyticsFilterContext()) {
    if (!globalThis.YushinPurchasingAnalytics?.summarize) {
        throw new Error('Purchasing analytics core 未載入，無法計算採購分析。');
    }
    const filtered=(rows||[])
        .filter(row=>purchasingAnalyticsRowMatches(row,filters))
        .map(row=>({ ...row, brand:statisticBrandForSupply(row) }));
    return globalThis.YushinPurchasingAnalytics.summarize(filtered);
}
window.loadPurchasingAnalytics = async function(force = false) {
    if (trueUserRole !== 'admin' || purchasingAnalyticsLoading) return purchasingAnalyticsRows;
    const filters = adminPurchaseAnalyticsFilterContext();
    const rangeKey = purchasingAnalyticsRangeKey(filters);
    if (!force && purchasingAnalyticsLoadedRangeKey === rangeKey) {
        renderUnifiedBrandAnalytics();
        return purchasingAnalyticsRows;
    }
    purchasingAnalyticsLoading = true;
    try {
        let query = supplyOrdersCollection();
        if (filters.start) query = query.where('orderDate', '>=', filters.start);
        if (filters.end) query = query.where('orderDate', '<=', filters.end);
        query = query.orderBy('orderDate', 'desc');

        purchasingAnalyticsRows = await readQueryInBatches(query);
        purchasingAnalyticsLoadedRangeKey = rangeKey;
        return purchasingAnalyticsRows;
    } catch (err) {
        console.error('進銷存採購資料讀取失敗：', err);
        throw err;
    } finally {
        purchasingAnalyticsLoading = false;
        renderUnifiedBrandAnalytics();
    }
};

window.renderPurchasingView = function() {
    renderFormalPurchaseRecovery();
    renderQuickPurchaseRecovery();
    populatePurchasingFilters();
    if (purchasingView === 'suppliers') {
        renderSupplierMasterAdmin();
        renderSupplierMappingAdmin();
        return;
    }
    if (purchasingView === 'replenishment') {
        renderInventoryReplenishmentCenter();
        return;
    }
    if (purchasingView === 'history') {
        // 全部採購單不顯示工作卡；直接畫正式採購單歷史，
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
    if (!['ordering', 'receiving', 'dispatch', 'completed', 'replenishment', 'history', 'suppliers'].includes(view)) return;
    if (currentUserRole === 'warehouse' && !['receiving','dispatch','completed'].includes(view)) return;
    if (view === 'ordering' && !canCreatePurchaseOrderCapability()) return;
    if (view === 'suppliers' && !canCreatePurchaseOrderCapability()) return;
    const previousPurchasingView = purchasingView;
    purchasingView = view;
    if (view === 'completed' && previousPurchasingView !== 'completed') purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT;
    populatePurchasingFilters();
    const workflowView = !['history', 'suppliers'].includes(view);
    const workSearch = document.getElementById('purchaseWorkSearch');
    if (workSearch) workSearch.hidden = !['ordering','receiving','dispatch','completed'].includes(view);
    const filters = workflowView ? purchaseFilterContext() : null;
    const normalizedItemsByOrder = workflowView
        ? new Map(ordersCache.map(order => [order.id, normalizedOrderItems(order)]))
        : null;
    const dispatchStatesByOrder = workflowView
        ? purchasingDispatchStateSnapshot(normalizedItemsByOrder)
        : null;
    const lifecyclesByOrder = workflowView
        ? purchasingLifecycleSnapshot(normalizedItemsByOrder)
        : null;
    const completedRows = view === 'completed'
        ? purchasingCompletedRows(filters, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder)
        : null;
    if (workflowView) renderPurchasingWorkCards(normalizedItemsByOrder, completedRows, filters, dispatchStatesByOrder, lifecyclesByOrder);
    const orderingTab = document.getElementById('purchase-card-ordering');
    const replenishmentTab = document.getElementById('purchase-card-replenishment');
    if (orderingTab) orderingTab.style.display = canCreatePurchaseOrderCapability() ? '' : 'none';
    if (replenishmentTab) replenishmentTab.style.display = canCreatePurchaseOrderCapability() ? '' : 'none';
    const activeTaskId = view === 'ordering'
        ? 'purchase-card-ordering'
        : (view === 'replenishment'
            ? 'purchase-card-replenishment'
            : (['receiving', 'dispatch', 'completed'].includes(view) ? 'purchase-card-stocking' : ''));
    document.querySelectorAll('#purchaseWorkCards .order-work-card').forEach(el =>
        el.classList.toggle('active', !!activeTaskId && el.id === activeTaskId)
    );
    document.querySelectorAll('#purchaseFulfillmentTabs .purchase-stage-button').forEach(el =>
        el.classList.toggle('active', el.id === `purchase-card-${view}`)
    );
    document.getElementById('purchase-tab-work')?.classList.toggle('active', ['ordering','receiving','dispatch','completed'].includes(view));
    document.getElementById('purchase-tab-history')?.classList.toggle('active', view === 'history');
    document.getElementById('purchase-tab-suppliers')?.classList.toggle('active', view === 'suppliers');
    const cards = document.getElementById('purchaseWorkCards');
    if (cards) cards.style.display = 'none';
    const directButton = document.getElementById('purchaseDirectOrderBtn');
    if (directButton) directButton.style.display = canCreatePurchaseOrderCapability() ? '' : 'none';
    const directPanel=document.getElementById('purchaseDirectPanel');
    if(directPanel)directPanel.style.display=view==='ordering'&&canCreatePurchaseOrderCapability()?'':'none';
    ['purchase-tab-history','purchase-tab-suppliers'].forEach(id => { const el=document.getElementById(id); if(el)el.style.display=canCreatePurchaseOrderCapability()?'':'none'; });
    const businessTab = document.getElementById('purchase-tab-work');
    if (businessTab) {
        businessTab.style.display = canCreatePurchaseOrderCapability() || currentUserRole === 'warehouse' ? '' : 'none';
        businessTab.textContent = currentUserRole === 'warehouse' ? '外倉出貨' : '採購需求';
        businessTab.setAttribute('onclick', currentUserRole === 'warehouse' ? "switchPurchasingView('dispatch')" : "switchPurchasingView('ordering')");
    }
    const businessStages = document.getElementById('purchaseBusinessStages');
    if (businessStages) businessStages.style.display = ['ordering','receiving','dispatch','completed'].includes(view) ? '' : 'none';
    const documentStages = document.getElementById('purchaseDocumentStages');
    if (documentStages) documentStages.style.display = 'none';
    document.querySelectorAll('[data-purchase-stage]').forEach(el => el.classList.toggle('active', el.dataset.purchaseStage === view));
    const periodSelect = document.getElementById('poPeriodFilter');
    if (periodSelect) {
        const showPeriod = ['history','completed'].includes(view);
        periodSelect.style.display = showPeriod ? '' : 'none';
        const label = document.querySelector('label[for="poPeriodFilter"]');
        if (label) label.style.display = showPeriod ? '' : 'none';
        const custom = document.getElementById('purchaseCustomPeriod');
        if (custom) custom.style.display = showPeriod && periodSelect.value === 'custom' ? '' : 'none';
        const note = document.querySelector('#purchaseFilterToolbar .order-period-note');
        if (note) note.textContent = showPeriod ? '依選擇日期查詢歷史紀錄。' : '顯示跨年度未完成工作，避免漏掉舊需求。';
    }
    const filterToolbar = document.getElementById('purchaseFilterToolbar');
    if (filterToolbar) filterToolbar.style.display = (view === 'suppliers' || view === 'replenishment') ? 'none' : '';
    const fulfillmentTabs = document.getElementById('purchaseFulfillmentTabs');
    if (fulfillmentTabs) fulfillmentTabs.style.display = 'none';
    const pendingPanel=document.getElementById('purchasePendingPanel');
    const replenishmentPanel=document.getElementById('purchaseReplenishmentPanel');
    const poPanel=document.getElementById('poListPanel');
    const dispatchPanel=document.getElementById('purchaseDispatchPanel');
    const completedPanel=document.getElementById('purchaseCompletedPanel');
    const supplierPanel=document.getElementById('purchaseSupplierPanel');
    if(pendingPanel)pendingPanel.style.display=view==='ordering'?'':'none';
    if(replenishmentPanel)replenishmentPanel.style.display=(view==='ordering'||view==='replenishment')&&canCreatePurchaseOrderCapability()?'':'none';
    if(poPanel)poPanel.style.display=(view==='receiving'||view==='history')?'':'none';
    if(dispatchPanel)dispatchPanel.style.display=view==='dispatch'?'':'none';
    if(completedPanel)completedPanel.style.display=view==='completed'?'':'none';
    if(supplierPanel)supplierPanel.style.display=view==='suppliers'?'':'none';
    if (view === 'suppliers') {
        renderSupplierSettingsAdmin();
        renderProductSupplierMappingAdmin();
        if (!purchasingViewLoaded.has('suppliers')) {
            purchasingViewLoaded.add('suppliers');
            loadSupplierWarehouseMasters(false).catch(err => {
                purchasingViewLoaded.delete('suppliers');
                console.error('供應商主檔首次載入失敗：', err);
            });
        }
    } else if (view === 'replenishment') {
        renderInventoryReplenishmentCenter();
        loadInventoryReplenishmentCenter(false).catch(err => console.error('安全庫存補貨自動更新失敗：', err));
    } else if (view === 'ordering') {
        if (canCreatePurchaseOrderCapability()) {
            renderInventoryReplenishmentCenter();
            loadInventoryReplenishmentCenter(false).catch(err => console.error('安全庫存補貨讀取失敗：', err));
        }
        renderPendingPurchaseOrders();
        if (!purchasingViewLoaded.has('ordering')) {
            purchasingViewLoaded.add('ordering');
            loadPendingPurchaseOrders(true).catch(err => {
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
        // 全部採購單採 Gmail 式 stale-while-revalidate：
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
                console.error('採購單紀錄首次載入失敗：', err);
            });
        }
    } else if (view === 'dispatch') {
        loadWarehouseMaster();
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

let dispatchListDraft=null;
window.openWarehouseDispatchList=async function(orderId,selectedWarehouseId=''){
    if(!canReceiveInventoryCapability()||!canAccessPage('inventory'))return;
    try{
        const [snapshot]=await Promise.all([
            firestoreReadWithTimeout(db.collection('orders').doc(orderId).get(),'出貨清單訂單'),loadWarehouseMaster()
        ]);
        if(!snapshot.exists)throw new Error('找不到訂單。');
        const order={...snapshot.data(),id:orderId};
        if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order))throw new Error('訂單已取消或庫存尚未同步完成。');
        const groups=new Map();
        normalizedOrderItems(order).forEach(item=>{
            if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')return;
            const state=itemDispatchState(order,item);
            // Include prepared but unshipped items too, so lists may be downloaded again.
            const qty=state.shippable;
            if(qty<=0)return;
            const warehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';
            if(selectedWarehouseId&&warehouseId!==selectedWarehouseId)return;
            if(!warehouseId)throw new Error('品項尚未指定出貨倉庫。');
            const warehouse=warehouseMasterCache.find(row=>row.id===warehouseId);
            if(!groups.has(warehouseId))groups.set(warehouseId,{warehouseId,name:warehouse?.warehouseName||warehouseId,items:[]});
            groups.get(warehouseId).items.push({itemId:item.itemId,code:item.itemCode||'',name:item.itemName||'',qty,lotNo:''});
        });
        if(!groups.size)throw new Error('目前沒有可建立清單的庫存出貨品項。');
        dispatchListDraft={orderId,orderNo:order.orderNo||order.quoteNo||orderId,customer:order.customerName||'',groups:[...groups.values()],
            address:order.shippingAddress||order.deliveryAddress||'',contact:order.customerContact||'',phone:order.customerPhone||''};
        let overlay=document.getElementById('warehouseDispatchOverlay');
        if(!overlay){
            overlay=document.createElement('div');overlay.id='warehouseDispatchOverlay';overlay.className='eq-modal-overlay no-print';
            overlay.addEventListener('click',event=>{if(event.target===overlay)closeWarehouseDispatchList();});document.body.appendChild(overlay);
        }
        overlay.innerHTML=`<div class="eq-modal-box" style="max-width:880px"><h3>分倉出貨清單</h3>
            <p>${escapeHtml(dispatchListDraft.orderNo)}｜${escapeHtml(dispatchListDraft.customer)}</p>
            <p>下載後可提供給各倉庫。本清單不扣庫存、不登記送貨；批號請於實際出貨時核對。</p>
            <div class="dispatch-list-fields"><label>送貨地址<input id="dispatchListAddress" value="${escapeAttr(dispatchListDraft.address)}"></label>
            <label>聯絡人<input id="dispatchListContact" value="${escapeAttr(dispatchListDraft.contact)}"></label>
            <label>電話<input id="dispatchListPhone" value="${escapeAttr(dispatchListDraft.phone)}"></label><label>希望出貨日期<input type="date" id="dispatchListDate" value="${localDateString()}"></label><label>出貨備註<textarea id="dispatchListNotes" placeholder="例如冷藏、乾冰、指定時段"></textarea></label></div>
            ${dispatchListDraft.groups.map((group,gi)=>`<section><h4>${escapeHtml(group.name)}</h4><div class="table-wrap"><table><thead><tr><th>貨號</th><th>品名</th><th>數量</th><th>指定批號（選填）</th></tr></thead><tbody>${group.items.map((item,ii)=>`<tr><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.name)}</td><td><input type="number" min="0" step="any" aria-label="此次出貨數量" value="${item.qty}" data-dispatch-qty-group="${gi}" data-dispatch-qty-item="${ii}"></td><td><input aria-label="指定批號" data-dispatch-group="${gi}" data-dispatch-item="${ii}" placeholder="出貨時確認"></td></tr>`).join('')}</tbody></table></div></section>`).join('')}
            <div class="toolbar"><button class="btn-secondary" onclick="exportWarehouseDispatchList('pdf',this)">下載分倉 PDF</button><button class="btn-secondary" onclick="exportWarehouseDispatchList('excel',this)">下載 Excel</button><button class="btn-secondary" onclick="closeWarehouseDispatchList()">關閉</button></div></div>`;
        overlay.classList.add('active');
    }catch(err){showActionFeedback('出貨清單無法建立：'+err.message,'warning');}
};
window.closeWarehouseDispatchList=function(){document.getElementById('warehouseDispatchOverlay')?.classList.remove('active');dispatchListDraft=null;};
window.exportWarehouseDispatchList=async function(format,button){
    if(!dispatchListDraft||!canReceiveInventoryCapability()||!canAccessPage('inventory'))return;
    const draft=JSON.parse(JSON.stringify(dispatchListDraft));
    draft.address=document.getElementById('dispatchListAddress').value.trim();
    draft.contact=document.getElementById('dispatchListContact').value.trim();draft.phone=document.getElementById('dispatchListPhone').value.trim();
    draft.date=document.getElementById('dispatchListDate').value;draft.notes=document.getElementById('dispatchListNotes').value.trim();
    document.querySelectorAll('#warehouseDispatchOverlay [data-dispatch-qty-group]').forEach(input=>{draft.groups[Number(input.dataset.dispatchQtyGroup)].items[Number(input.dataset.dispatchQtyItem)].qty=Number(input.value);});
    document.querySelectorAll('#warehouseDispatchOverlay [data-dispatch-group]').forEach(input=>{draft.groups[Number(input.dataset.dispatchGroup)].items[Number(input.dataset.dispatchItem)].lotNo=input.value.trim();});
    if((!draft.address||!draft.contact||!draft.phone)&&!confirm('送貨地址、聯絡人或電話尚未填齊，仍要下載清單嗎？'))return;
    const state=beginActionButton(button,'製作中…');if(!state)return;
    let stage;
    try{
        const fresh=await firestoreReadWithTimeout(db.collection('orders').doc(draft.orderId).get(),'核對出貨清單');
        if(!fresh.exists||normalizedOrderStatus(fresh.data())!=='normal'||orderInventorySyncIncomplete(fresh.data()))throw new Error('訂單狀態已變更，請重新建立清單。');
        const order=fresh.data(),items=normalizedOrderItems(order);
        for(const group of draft.groups)for(const item of group.items){
            const current=items.find(row=>row.itemId===item.itemId),stock=current&&itemDispatchState(order,current);
            if(!current||!Number.isFinite(item.qty)||item.qty<=0||(current.warehouseId||order.warehouseId||defaultWarehouse()?.id)!==group.warehouseId||stock.shippable<item.qty)throw new Error('出貨數量或倉庫已變更，請重新建立清單。');
        }
        const safe=value=>String(value).replace(/[\\/:*?"<>|]/g,'_');
        const name=`出貨清單-${safe(draft.orderNo)}-${localDateString()}`;
        if(format==='excel'){
            await ensureXlsxLoaded();
            const wb=XLSX.utils.book_new();
            const rows=draft.groups.flatMap(group=>group.items.map(item=>({'倉庫':group.name,'訂單號':draft.orderNo,'客戶':draft.customer,'送貨地址':draft.address,'聯絡人':draft.contact,'電話':draft.phone,'貨號':item.code,'品名':item.name,'數量':item.qty,'指定批號（出貨時核對）':item.lotNo,'希望出貨日期':draft.date,'出貨備註':draft.notes})));
            XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(rows),'分倉出貨清單');XLSX.writeFile(wb,name+'.xlsx');
        }else if(format==='pdf'){
            if(!window.jspdf?.jsPDF||typeof window.html2canvas!=='function')throw new Error('PDF 元件尚未載入。');
            stage=document.createElement('div');stage.style.cssText='position:fixed;left:-10000px;top:0;width:794px;background:white;';document.body.appendChild(stage);
            const pages=[];
            for(const group of draft.groups){
                for(let offset=0;offset<group.items.length;offset+=10){
                    const page=document.createElement('div');page.style.cssText='width:794px;padding:32px;box-sizing:border-box;background:white;color:#111;font-size:16px;';
                    page.innerHTML=`<h2>出貨清單｜${escapeHtml(group.name)}</h2><p>訂單：${escapeHtml(draft.orderNo)}　希望出貨日期：${escapeHtml(draft.date)}</p><p>出貨備註：${escapeHtml(draft.notes)}</p><p>客戶：${escapeHtml(draft.customer)}</p><p>地址：${escapeHtml(draft.address||'未填')}</p><p>聯絡人：${escapeHtml(draft.contact||'未填')}　電話：${escapeHtml(draft.phone||'未填')}</p><table style="width:100%;table-layout:fixed;border-collapse:collapse"><thead><tr><th>貨號</th><th>品名</th><th>數量</th><th>指定批號</th></tr></thead><tbody>${group.items.slice(offset,offset+10).map(item=>`<tr>${[item.code,item.name,item.qty,item.lotNo||'出貨時確認'].map(value=>`<td style="border:1px solid #999;padding:8px;overflow-wrap:anywhere">${escapeHtml(value)}</td>`).join('')}</tr>`).join('')}</tbody></table><p>請倉庫核對實際出貨批號與數量。本清單不代表已送貨。</p><small>本倉庫第 ${Math.floor(offset/10)+1}／${Math.ceil(group.items.length/10)} 頁</small>`;
                    stage.appendChild(page);pages.push(page);
                }
            }
            const pdf=new window.jspdf.jsPDF({orientation:'portrait',unit:'mm',format:'a4',compress:true});
            await addDocumentPagesToPdf(pdf,pages,{isolateRoot:stage});pdf.save(name+'.pdf');
        }else throw new Error('不支援的下載格式。');
        if(dispatchListDraft?.orderId===draft.orderId)closeWarehouseDispatchList();
    }catch(err){showActionFeedback('出貨清單下載失敗：'+err.message,'warning');}
    finally{stage?.remove();endActionButton(button,state);}
};

window.openRelatedOrderPurchase=async function(number){
    if(!canAccessPage('orders.po'))return;
    switchMainTab('purchasing-system',document.querySelector('[data-main-nav="orders.po"]'));
    await switchPurchasingView('history');
    document.getElementById('purchaseSalesFilter').value='';document.getElementById('purchaseBrandFilter').value='';
    document.getElementById('poPeriodFilter').value='all';
    document.getElementById('poListSearch').value=number;
    await runPurchaseOrderHistorySearch();
};

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
            return (orderItemDisplayCategories(order, item, lifecycle, state).includes('dispatch')
                || pendingDispatchPreparation(order.id,item.itemId))
                ? {item,state}
                : null;
        }).filter(Boolean);
        pending.forEach(({item,state})=>{
            if (!purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters)) return;
            if (!workflowLineMatchesSearch(order,item,document.getElementById('purchaseWorkSearch')?.value)) return;
            const warehouseId = item.warehouseId || order.warehouseId || defaultWarehouse()?.id || '';
            const canPrepareDispatch = currentUserRole === 'purchaser' || currentUserRole === 'admin';
            const preparing = pendingDispatchOrderIds.has(order.id+'__'+item.itemId);
            const action = canPrepareDispatch
                ? `<button type="button" class="btn-small" onclick="markOrderItemDispatchPrepared(${inlineJsValue(order.id)},${inlineJsValue(item.itemId)})" ${preparing?'disabled':''}>${preparing?'處理中…':(pendingDispatchPreparation(order.id,item.itemId)?'確認打單結果':`確認打單 ${state.pending} 件`)}</button>`
                : '<span class="order-progress-badge">唯讀</span>';
            const tr=document.createElement('tr');
            tr.innerHTML=`<td data-th="訂單日期">${workflowRecordSummary(order, order.orderDate)}</td><td data-th="客戶">${escapeHtml(order.customerName||order.customer||'')}</td><td data-th="待打單品項">${purchaseProductSummary(item, state.pending, null)}</td><td data-th="數量">${workflowQuantitySummary(state.pending,'待打單')}</td><td data-th="負責業務">${escapeHtml(order.salesName||'')}</td><td data-th="操作"><div class="workflow-inline-actions">${action}</div></td>`;
            organizePurchasingOrderRow(tr,order,item);
            fragment.appendChild(tr);
            shown++;
        });
    });
    body.appendChild(fragment);
    if(status)status.textContent=purchasingDispatchLoading?'載入中…':purchasingDispatchError||(shown?`已顯示 ${shown} 筆待打單品項`:'目前沒有待打單品項');
    if(more){more.style.display=purchasingDispatchHasMore?'':'none';more.disabled=purchasingDispatchLoading;}
}

function pendingPurchaseLines(order) {
    if(orderInventorySyncIncomplete(order))return [];
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
        .map(line => {
            const demand = displayByIndex.get(Number(line.orderItemIndex));
            return {
                ...line,
                qty:demand.qty,
                demandId:demand.demandId || '',
                sourceType:demand.sourceType || 'SALES_ORDER',
                sourceId:demand.sourceId || order.id || '',
                sourceItemId:demand.sourceItemId || line.itemId || ''
            };
        });
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

function updatePendingPurchaseBatchButton() {
    const button=document.getElementById('purchasePendingBatchPoBtn');
    if(!button)return;
    const count=selectedPendingPurchaseDemandIds.size;
    button.disabled=count<2;
    button.textContent=count ? `合併產生採購單（${count}）` : '合併產生採購單';
}

function clearPendingPurchaseSelection() {
    selectedPendingPurchaseDemandIds.clear();
    document.querySelectorAll('.pending-purchase-batch-select').forEach(input=>{ input.checked=false; });
    updatePendingPurchaseBatchButton();
}

window.togglePendingPurchaseSelection = function(demandId, checked) {
    const id=String(demandId||'');
    if(!id)return;
    if(checked)selectedPendingPurchaseDemandIds.add(id);
    else selectedPendingPurchaseDemandIds.delete(id);
    updatePendingPurchaseBatchButton();
};

function renderPendingPurchaseOrders() {
    const body = document.getElementById('purchasePendingBody');
    if (!body) return;
    body.innerHTML = '';
    const fragment = document.createDocumentFragment();
    const filters = purchaseFilterContext();
    let shown = 0;
    const visibleSelectableIds=new Set();

    const rows=[...procurementDemandCache]
        .filter(demand=>demand.sourceType==='SALES_ORDER')
        .filter(demand=>Number(demand.remainingToOrderQty||0)>0)
        .sort((a,b)=>String(a.scheduleDate||a.createdAt||'').localeCompare(String(b.scheduleDate||b.createdAt||'')));

    for(const demand of rows){
        const sourceType=String(demand.sourceType||'');
        const order=sourceType==='SALES_ORDER'
            ? procurementDemandSourceOrderCache.get(String(demand.sourceId||'')) || null
            : null;
        if(order&&normalizedOrderStatus(order)!=='normal')continue;
        const sourceItems=order ? normalizedOrderItems(order) : [];
        const item=sourceItems.find(row=>String(row.itemId||'')===String(demand.sourceItemId||'')) || {};
        const date=order?.orderDate || String(demand.createdAt||'').slice(0,10);
        const salesName=demand.salesName || order?.salesName || '';
        const brand=demand.brand || item.brand || '';
        if(!purchaseLineMatchesFilters(date,salesName,brand,filters))continue;

        if (!workflowLineMatchesSearch(order,{...demand,itemName:demand.itemName||item.itemName,brand},document.getElementById('purchaseWorkSearch')?.value)) continue;
        const qty=Math.max(0,Number(demand.remainingToOrderQty||0));
        const statusLabel=globalThis.YushinProcurementDemand?.statusLabel(demand.status)||'待採購';
        let customer=order?.customerName||order?.customer||'';
        let actionHtml='';
        const selfOrder=!!order&&(item.procurementType||order.procurementType||'PURCHASING_PO')==='SALES_SELF_ORDER';
        const batchSelectable=sourceType==='SALES_ORDER'&&!!order&&!selfOrder;
        if(batchSelectable)visibleSelectableIds.add(String(demand.id||''));
        const selectionHtml=batchSelectable
            ? `<input type="checkbox" class="pending-purchase-batch-select" aria-label="選取合併採購" ${selectedPendingPurchaseDemandIds.has(String(demand.id||''))?'checked':''} onchange="togglePendingPurchaseSelection(${inlineJsValue(demand.id||'')},this.checked)">`
            : '';

        if(sourceType==='STOCK_REPLENISHMENT'){
            customer='備庫';
            actionHtml=`<button type="button" class="btn-small btn-secondary" onclick="openInventoryReplenishment(${inlineJsValue(demand.sourceId||demand.productKey||demand.productId||'')})">建立採購單</button>`;
        }else if(order){
            // Creation-time self-orders are recorded automatically. Pending rows are
            // synchronization exceptions, not a second routine ordering action.
            const autoSelfOrder = selfOrder && order.selfOrderAtCreation === true && item.selfOrderConfirmed === true;
            const syncState = String(order.inventoryReservationStatus||'');
            actionHtml=autoSelfOrder && syncState !== 'completed'
                ? `<span class="order-progress-badge">${syncState==='failed'?'自行訂貨同步失敗，請至訂單頁重試同步':'自行訂貨自動同步中…'}</span>`
                : selfOrder
                    ? (canBusinessSelfOrder(order)
                        ? `<button type="button" class="btn-small btn-secondary" onclick="openSelfOrderModal(${inlineJsValue(order.id)},${inlineJsValue(demand.sourceItemId||item.itemId||'')})">${autoSelfOrder?'補登異常訂貨':'登記自行訂貨'}</button>`
                        : '<span class="order-progress-badge">自行訂貨・由訂單負責業務處理</span>')
                    : `<button type="button" class="btn-small" onclick="markPurchaseItemOrdered(${inlineJsValue(order.id)},${inlineJsValue(demand.sourceItemId||item.itemId||'')},this)">確認已下訂</button> <button type="button" class="btn-small btn-secondary" onclick="openOrderPurchaseDraft(${inlineJsValue(order.id)},${inlineJsValue(demand.sourceItemId||item.itemId||'')})">建立採購單</button>`;
        }else{
            actionHtml='<span class="order-progress-badge">來源訂單待同步</span>';
        }

        const row=document.createElement('tr');
        row.classList.add('procurement-demand-row');
        row.innerHTML=`<td data-th="合併" class="no-print" style="text-align:center;">${selectionHtml}</td><td data-th="需求日期">${workflowRecordSummary(order, date)}</td><td data-th="客戶／用途">${escapeHtml(customer)}<div class="record-reference">${order?.orderNo ? `來源客戶訂單・${escapeHtml(order.orderNo)}` : order?.quoteNo ? `來源估價單・${escapeHtml(order.quoteNo)}` : '客戶訂單採購需求'}</div></td><td data-th="待採購品項">${purchaseProductSummary({...demand, itemName:demand.itemName || item.itemName, itemCode:demand.itemCode || item.itemCode, brand}, qty, null)}<div style="font-size:11px;color:#667584;margin-top:3px;">${sourceType==='STOCK_REPLENISHMENT'?'備庫採購':'客戶訂單'}・${escapeHtml(statusLabel)}</div></td><td data-th="數量">${workflowQuantitySummary(qty,'待採購')}</td><td data-th="負責業務">${escapeHtml(salesName)}</td><td data-th="操作"><div class="workflow-inline-actions">${actionHtml}</div></td>`;
        organizePurchasingOrderRow(row,order,item);
        fragment.appendChild(row);
        shown++;
    }

    for(const id of [...selectedPendingPurchaseDemandIds]){
        if(!visibleSelectableIds.has(id))selectedPendingPurchaseDemandIds.delete(id);
    }
    body.appendChild(fragment);
    updatePendingPurchaseBatchButton();
    const status=document.getElementById('purchasePendingStatus');
    if(status)status.textContent=pendingPurchaseLoading
        ? '載入中…'
        : pendingPurchaseError || (shown
            ? `已顯示 ${shown} 筆業務待採購品項${procurementDemandHasMore?'；尚有更多需求可載入':''}`
            : procurementDemandHasMore ? '目前這一批沒有符合篩選的需求，可載入更多' : '目前沒有待採購需求');
    const more=document.getElementById('purchasePendingMoreBtn');
    if(more){more.style.display=procurementDemandHasMore?'':'none';more.disabled=pendingPurchaseLoading;}
}

window.loadPendingPurchaseOrders = async function(reset = true) {
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po') || pendingPurchaseLoading) return;
    pendingPurchaseError='';
    pendingPurchaseLoading=true;
    const refreshButton=document.getElementById('purchasePendingRefreshBtn');
    if(refreshButton&&reset){refreshButton.disabled=true;refreshButton.textContent='更新中…';}
    if(reset){
        procurementDemandCache=[];
        procurementDemandCursor=null;
        procurementDemandHasMore=true;
        procurementDemandLoaded=false;
        procurementDemandSourceOrderCache=new Map();
        selectedPendingPurchaseDemandIds.clear();
        updatePendingPurchaseBatchButton();
    }
    renderPendingPurchaseOrders();
    try{
        let query=db.collection('procurementDemands')
            .where('remainingToOrderQty','>',0)
            .orderBy('remainingToOrderQty','desc')
            .limit(DEFAULT_LIST_LIMIT);
        if(procurementDemandCursor)query=query.startAfter(procurementDemandCursor);
        const snapshot=await firestoreReadWithTimeout(query.get(),'正式採購需求');
        const fresh=snapshot.docs.map(doc=>({id:doc.id,...doc.data()}));
        procurementDemandCursor=snapshot.empty?null:snapshot.docs[snapshot.docs.length-1];
        procurementDemandHasMore=snapshot.size===DEFAULT_LIST_LIMIT;

        const byId=new Map((reset?[]:procurementDemandCache).map(row=>[row.id,row]));
        fresh.forEach(row=>byId.set(row.id,row));
        procurementDemandCache=[...byId.values()];

        const sourceOrderIds=[...new Set(procurementDemandCache
            .filter(row=>row.sourceType==='SALES_ORDER')
            .map(row=>String(row.sourceId||'')).filter(Boolean))];
        const missing=sourceOrderIds.filter(id=>!procurementDemandSourceOrderCache.has(id));
        if(missing.length){
            const sourceOrders=await readDocumentsByIds('orders',missing);
            sourceOrders.forEach(order=>procurementDemandSourceOrderCache.set(order.id,order));
        }
        pendingPurchaseHasMore=procurementDemandHasMore;
        procurementDemandLoaded=true;
    }catch(err){
        pendingPurchaseError=`待採購需求讀取失敗，請重試：${String(err?.message||err).slice(0,160)}`;
    }finally{
        pendingPurchaseLoading=false;
        if(refreshButton){refreshButton.disabled=false;refreshButton.textContent='↻ 更新';}
        renderPendingPurchaseOrders();
        renderPurchasingWorkCards();
    }
};

const pendingPurchaseOrderKeys = new Set();

 // A lost Callable HTTP response may leave no ordering-row button: after the
 // server commits, remainingToOrderQty is zero. Recover by original operation
 // ID from the purchasing workspace rather than opening a new purchase.
function pendingQuickPurchaseAttempts() {
    if(!currentUser?.uid || typeof sessionStorage==='undefined') return [];
    const prefix='quick-purchase-pending:'+encodeURIComponent(currentUser.uid)+':',result=[];
    for(let i=0;i<sessionStorage.length;i++) {
        const key=sessionStorage.key(i);
        if(typeof key!=='string'||!key.startsWith(prefix))continue;
        try {
            const record=JSON.parse(sessionStorage.getItem(key));
            const values=JSON.parse(record.fingerprint);
            if(record.version!==1||!Array.isArray(values)||values.length!==6
                ||values[0]!==currentUser.uid
                ||typeof values[1]!=='string'||!values[1]
                ||typeof values[2]!=='string'||!values[2]
                ||!Number.isSafeInteger(values[3])||values[3]<=0
                ||typeof values[4]!=='string'||!values[4]
                ||typeof values[5]!=='number'||!Number.isFinite(values[5])||values[5]<0
                ||key!==prefix+encodeURIComponent(values[1])+':'+encodeURIComponent(values[2])
                ||typeof record.operationId!=='string'
                ||!/^qp-[A-Za-z0-9_-]{8,76}$/.test(record.operationId))
                throw new Error('invalid Quick Purchase checkpoint');
            result.push({key,orderId:values[1],itemId:values[2],
                details:{expectedQty:values[3],supplier:values[4],unitCost:values[5]}});
        } catch (_) {
            result.push({key,invalid:true});
        }
    }
    return result;
}
function renderQuickPurchaseRecovery() {
    const root=document.getElementById('purchasing-system');
    if(!root)return;
    const existing=document.getElementById('quickPurchaseRecoveryPanel');
    if(!currentUser?.uid
        ||!canCreatePurchaseOrderCapability()||!canAccessPage('orders.po')) {
        if(existing)existing.hidden=true;
        return;
    }
    const attempts=pendingQuickPurchaseAttempts();
    const backendEnabled=quickPurchaseBackendPilotEnabled();
    if(!attempts.length){if(existing)existing.hidden=true;return;}
    const panel=existing||document.createElement('div');
    if(!existing){
        panel.id='quickPurchaseRecoveryPanel';
        panel.className='no-print';
        panel.setAttribute('role','status');
        root.insertBefore(panel,root.firstChild);
    }
    panel.replaceChildren();
    panel.hidden=false;
    for(const attempt of attempts){
        const row=document.createElement('div'),message=document.createElement('span');
        message.textContent=attempt.invalid
            ? '前次手動採購憑證異常，請以原帳號請管理員核對，勿另建採購。'
            : '手動採購 '+attempt.orderId+'／'+attempt.itemId+' 結果尚待確認。'
                +(backendEnabled?'':'採購核對暫停，請保留原憑證並請管理員確認，勿另建採購。');
        row.appendChild(message);
        if(!attempt.invalid && backendEnabled) {
            const button=document.createElement('button');
            button.type='button';
            button.className='btn-small';
            button.textContent='確認前次採購結果';
            button.onclick=()=>markPurchaseItemOrdered(attempt.orderId,attempt.itemId,button,attempt.details);
            row.appendChild(button);
        }
        panel.appendChild(row);
    }
}


function quickPurchaseSupplyId(orderId, itemId) {
    return `manual-${encodeURIComponent(String(orderId || ''))}-${encodeURIComponent(String(itemId || ''))}`;
}

let quickPurchaseConfirmation = null;
let quickPurchaseConfirmationGeneration = 0;

window.closeQuickPurchaseConfirmation = function() {
    quickPurchaseConfirmationGeneration++;
    document.getElementById('quickPurchaseConfirmationOverlay')?.classList.remove('active');
    if (quickPurchaseConfirmation) { quickPurchaseConfirmation(null); quickPurchaseConfirmation = null; }
};

window.confirmQuickPurchase = function() {
    const supplier = String(document.getElementById('quickPurchaseSupplier').value || '').trim();
    const unitCostText = String(document.getElementById('quickPurchaseCost').value).trim();
    const unitCost = Number(unitCostText);
    const expectedQty = Number(document.getElementById('quickPurchaseQty').value);
    if (!supplier || unitCostText === '' || !Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(expectedQty) || expectedQty <= 0) {
        alert('請填寫供應商與實際單位成本（可填 0）。'); return;
    }
    const resolve = quickPurchaseConfirmation;
    quickPurchaseConfirmation = null;
    document.getElementById('quickPurchaseConfirmationOverlay').classList.remove('active');
    if (resolve) resolve({ supplier, unitCost, expectedQty });
};

async function requestQuickPurchaseDetails(orderId, itemId) {
    closeQuickPurchaseConfirmation();
    const generation = quickPurchaseConfirmationGeneration;
    const orderSnap = await firestoreReadWithTimeout(db.collection('orders').doc(orderId).get(), '讀取待採購品項');
    if (!orderSnap.exists) throw new Error('來源訂單已不存在。');
    const order = { id:orderId, ...orderSnap.data() };
    if (normalizedOrderStatus(order) !== 'normal') throw new Error('來源訂單已取消或作廢。');
    const item = normalizedOrderItems(order).find(row => row.itemId === itemId);
    if (!item || (item.procurementType || order.procurementType || 'PURCHASING_PO') === 'SALES_SELF_ORDER') throw new Error('此品項不能使用直接採購。');
    const qty = procurementDemandForOrderItem(order, item).remainingToOrderQty;
    if (!(qty > 0)) throw new Error('此品項已無待採購數量，請重新整理。');
    const productId = String(item.productId || order.productId || '').trim();
    const [supplySnap, costSnap] = await Promise.all([
        firestoreReadWithTimeout(supplyOrdersCollection().doc(quickPurchaseSupplyId(orderId,itemId)).get(), '讀取既有採購紀錄'),
        productId ? firestoreReadWithTimeout(db.collection('productCosts').doc(productId).get(), '讀取標準成本') : Promise.resolve(null)
    ]);
    if (generation !== quickPurchaseConfirmationGeneration) return null;
    const existing = supplySnap.exists ? supplySnap.data() : null;
    const cost = existing?.unitCost ?? (costSnap?.exists ? costSnap.data().standardCost : null);
    let overlay = document.getElementById('quickPurchaseConfirmationOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'quickPurchaseConfirmationOverlay'; overlay.className = 'eq-modal-overlay no-print';
        overlay.innerHTML = `<div class="eq-modal-box" style="max-width:560px;">
            <h3>確認已採購</h3><p id="quickPurchaseSummary"></p>
            <div class="form-grid">
                <div><label for="quickPurchaseSupplier">供應商 *</label><input id="quickPurchaseSupplier" type="text" autocomplete="off"></div>
                <div><label for="quickPurchaseQty">本次採購數量</label><input id="quickPurchaseQty" type="number" readonly></div>
                <div><label for="quickPurchaseCost">實際含稅單位成本 *</label><input id="quickPurchaseCost" type="number" min="0" step="any" inputmode="decimal"></div>
            </div><p id="quickPurchaseHint" style="color:#666;font-size:13px;"></p>
            <div style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;">
                <button type="button" onclick="confirmQuickPurchase()">確認已採購</button>
                <button type="button" class="btn-secondary" onclick="closeQuickPurchaseConfirmation()">取消</button>
            </div></div>`;
        overlay.addEventListener('click', event => { if (event.target === overlay) closeQuickPurchaseConfirmation(); });
        document.body.appendChild(overlay);
    }
    document.getElementById('quickPurchaseSummary').textContent = `${item.itemCode || ''} ${item.itemName || ''}`;
    document.getElementById('quickPurchaseSupplier').value = existing?.supplier || item.supplier || order.supplier || '';
    document.getElementById('quickPurchaseQty').value = qty;
    document.getElementById('quickPurchaseCost').value = cost !== null && cost !== undefined && cost !== '' && Number.isFinite(Number(cost)) && Number(cost) >= 0 ? cost : '';
    document.getElementById('quickPurchaseHint').textContent = existing
        ? '追加採購沿用原紀錄的供應商與單價；不同供應商、單價或部分採購，請製作採購文件後按「確認已採購」。'
        : '成本由產品標準成本帶入，請確認本次實際進貨價。確認後列入待到貨，不產生 PDF。';
    overlay.classList.add('active');
    return new Promise(resolve => { quickPurchaseConfirmation = resolve; });
}

window.markPurchaseItemOrdered = async function(orderId, itemId, button, recoveryDetails=null) {
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    const actionKey = `${orderId}::${itemId}`;
    if (pendingPurchaseOrderKeys.has(actionKey)) return;
    pendingPurchaseOrderKeys.add(actionKey);
    const originalLabel = button?.textContent || '已採購';
    if (button) { button.disabled = true; button.textContent = '處理中…'; }
    try {
        const actorUid=currentUser?.uid, actorRole=currentUserRole;
        if(recoveryDetails && !quickPurchaseBackendPilotEnabled())
            throw new Error('前次採購核對尚未啟用，請保留原憑證並請管理員確認，勿另建採購。');
        const purchaseDetails = recoveryDetails || await requestQuickPurchaseDetails(orderId, itemId);
        if (!purchaseDetails) return;
        if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
        if (!purchaseDetails.supplier || !Number.isFinite(purchaseDetails.unitCost) || purchaseDetails.unitCost < 0) throw new Error('請確認供應商與有效的實際單位成本。');
        const { savedOrder, savedSupply, savedDemand, incomingProductKey, incomingWarehouseId } = await commitQuickPurchase(orderId, itemId, purchaseDetails, actorUid, actorRole);
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
        syncCommittedQuickPurchaseDemand(savedDemand, savedOrder);
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) {
            renderPurchasingView();
        }
        if(typeof renderQuickPurchaseRecovery==='function')renderQuickPurchaseRecovery();
        showActionFeedback('已採購，品項已列入待到貨，可繼續處理下一筆。', 'success');
    } catch (err) {
        if(typeof renderQuickPurchaseRecovery==='function')renderQuickPurchaseRecovery();
        alert('切換為已採購失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingPurchaseOrderKeys.delete(actionKey);
        if (button?.isConnected) { button.disabled = false; button.textContent = originalLabel; }
    }
};
window.openOrderPurchaseDraft = async function(orderId, itemId = '') {
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    const openingGeneration = ++poDirectStockOpenGeneration;
    const openingUid = currentUser?.uid;
    const openingRole = currentUserRole;
    const isCurrent = () => openingGeneration === poDirectStockOpenGeneration
        && currentUser?.uid === openingUid && currentUserRole === openingRole;
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
                '採購單來源訂單'
            );
            if (!isCurrent()) return;
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
    clearPoExpectedDate();
        switchPoCompany(bestPurchaseOrderCompany([order], items, order.company), null, true);
        generatePoNo();
        renderPoItemsTable();
        updatePoModeUI();
        setPoDraftLoading(true);
        updatePoSaveStatus('正在載入供應商與進貨成本…');
        document.getElementById('poModalOverlay').classList.add('active');

        // 視窗先出現，供應商／成本再補齊；只預載這次採購單真正選到的品項。
        await Promise.all([loadSupplierWarehouseMasters(), preloadPurchaseCostsForItems(items)]);
        if (!isCurrent() || !document.getElementById('poModalOverlay')?.classList.contains('active')) return;
        pendingItems = pendingPurchaseLines(order);
        items = itemId ? pendingItems.filter(item => item.itemId === itemId) : pendingItems.slice(0, 1);
        if (!items.length) {
            throw new Error('此品項已無待採購數量');
        }
        await preloadPurchaseCostsForItems(items);
        if (!isCurrent()) return;
        poItems = items;
        poAllItems = items;
        document.getElementById('poVendorName').value = '';
        await autoFillPoSupplier(items, isCurrent);
        if (!isCurrent()) return;
        switchPoCompany(bestPurchaseOrderCompany([order], items, order.company), null, true);
        renderPoItemsTable();
        updatePoModeUI();
        updatePoSaveStatus('這張採購單尚未建立。確認品項、供應商與單價後，即可列印 / 存為 PDF 並自動同步雲端。');
    } catch (err) {
        if (isCurrent()) { closePurchaseOrderModal(); alert('無法開啟採購單：' + err.message); }
    } finally {
        if (isCurrent()) setPoDraftLoading(false);
        if (button?.isConnected) { button.disabled = false; button.textContent = '產生採購單'; }
    }
};

window.openSelectedPurchaseDraft = async function() {
    if(!canCreatePurchaseOrderCapability()||!canAccessPage('orders.po'))return;
    const button=document.getElementById('purchasePendingBatchPoBtn');
    const selectedIds=[...selectedPendingPurchaseDemandIds];
    if(selectedIds.length<2){
        alert('請至少勾選 2 筆待採購需求。');
        return;
    }
    if(button){button.disabled=true;button.textContent='整理中…';}
    try{
        const selectedDemands=procurementDemandCache.filter(demand=>
            selectedPendingPurchaseDemandIds.has(String(demand.id||''))
            && Number(demand.remainingToOrderQty||0)>0
        );
        if(selectedDemands.length!==selectedIds.length)throw new Error('部分待採購需求已更新，請按「更新」後重新勾選。');

        const rows=selectedDemands.map(demand=>{
            if(String(demand.sourceType||'')!=='SALES_ORDER')throw new Error('目前批次合併只支援客戶訂單採購。');
            const order=procurementDemandSourceOrderCache.get(String(demand.sourceId||''));
            if(!order||normalizedOrderStatus(order)!=='normal')throw new Error('部分來源訂單已取消、作廢或尚未載入。');
            const item=pendingPurchaseLines(order).find(line=>String(line.itemId||'')===String(demand.sourceItemId||''));
            if(!item)throw new Error('部分勾選品項已無待採購數量，請更新後重試。');
            return {demand,order,item};
        });
        const initialItems=rows.map(row=>row.item);
        await Promise.all([
            loadSupplierWarehouseMasters(),
            preloadPurchaseCostsForItems(initialItems)
        ]);

        const refreshedRows=rows.map(row=>{
            const item=pendingPurchaseLines(row.order).find(line=>String(line.itemId||'')===String(row.demand.sourceItemId||''));
            if(!item)throw new Error('部分勾選品項已無待採購數量，請更新後重試。');
            return {...row,item};
        });
        const items=refreshedRows.map(row=>row.item);
        await preloadPurchaseCostsForItems(items);
        const selectedOrders=[...new Map(refreshedRows.map(row=>[row.order.id,row.order])).values()];

        if(items.some(item=>String(item.fulfillmentType||'WAREHOUSE').toUpperCase()==='DIRECT_SHIP')){
            throw new Error('原廠直送需依客戶地址分開處理，目前不合併成同一張採購單。');
        }
        const warehouseIds=new Set(items.map(item=>String(item.warehouseId||defaultWarehouse()?.id||'').trim()));
        if(warehouseIds.has(''))throw new Error('部分品項尚未指定入庫倉庫，請先完成倉庫設定。');
        if(warehouseIds.size!==1)throw new Error('不同入庫倉庫的需求不能合併成同一張採購單。');

        const companies=[...new Set(selectedOrders.map(order=>String(order.company||'').trim()).filter(Boolean))];
        if(companies.length>1)throw new Error('不同公司的來源訂單不能合併成同一張採購單。');

        const resolvedSuppliers=items.map(item=>supplierForProduct(
            item.brand,item.productLine,item.productId,item.itemCode
        ));
        if(resolvedSuppliers.some(supplier=>!supplier)){
            const missing=items.filter((item,index)=>!resolvedSuppliers[index]).map(item=>item.itemCode||item.itemName||'未命名品項');
            throw new Error('以下品項尚未設定供應來源：'+missing.join('、'));
        }
        const supplierIds=new Set(resolvedSuppliers.map(supplier=>String(supplier.id||supplier.supplierId||'').trim()).filter(Boolean));
        if(supplierIds.size!==1)throw new Error('勾選品項屬於不同供應商，請分開建立採購單。');
        const supplier=resolvedSuppliers[0];
        const supplierHeader=supplier.purchaseHeaderName||supplier.supplierName||'';
        if(!supplierHeader)throw new Error('供應商主檔缺少採購單抬頭。');

        poDirectStockMode=false;
        poEditingId=null;
        poIncomingSyncPending=false;
        poItems=items;
        poAllItems=items;
        populatePoVendorSuggestions();
        document.getElementById('poVendorName').value=supplierHeader;
        document.getElementById('poBuyerName').innerText=currentUserName||currentUser?.email||'';
        document.getElementById('poDate').value=localDateString();
        clearPoExpectedDate();
        await autoFillPoSupplier(items);
        const targetCompany=companies[0]||bestPurchaseOrderCompany(selectedOrders,items,currentCompany);
        switchPoCompany(targetCompany,null,true);
        generatePoNo();
        renderPoItemsTable();
        updatePoModeUI();
        updatePoSaveStatus(`已合併 ${items.length} 筆待採購需求；請確認數量、成本與預計到貨日後匯出 PDF。`);
        document.getElementById('poModalOverlay').classList.add('active');
        clearPendingPurchaseSelection();
    }catch(err){
        alert('無法合併建立採購單：'+(err?.message||err));
    }finally{
        updatePendingPurchaseBatchButton();
    }
};

// 「採購訂單」列出所有已經產生過的採購單紀錄（不分是誰產生的，只要是採購／管理員都看得到全部）
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
    const requestedRole = currentUserRole, requestedUid = currentUser?.uid;
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
            ? supplyOrdersCollection().where('status','in',['ORDERED','PARTIAL_RECEIPT']).limit(DEFAULT_LIST_LIMIT)
            : null;
        if (supplyQuery && supplyReceivingCursor) supplyQuery = supplyQuery.startAfter(supplyReceivingCursor);
        const [snapshot,supplySnapshot] = await Promise.all([
            query ? firestoreReadWithTimeout(query.get(), '採購單清單') : Promise.resolve({docs:[],size:0,empty:true}),
            supplyQuery ? firestoreReadWithTimeout(supplyQuery.get(), '待到貨供應') : Promise.resolve({docs:[],size:0,empty:true})
        ]);
        if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid || requestedView !== purchasingView || !canAccessPage('orders.po')) return;
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
        if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid || requestedView !== purchasingView || !canAccessPage('orders.po')) return;
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
            await loadPurchaseHistorySupplyProjection(freshRecords, reset);
            if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid || requestedView !== purchasingView || !canAccessPage('orders.po')) return;
            writeAppDataCache('purchase-history', poListCache);
        }
        if (!deferRender) {
            if (purchasingView === 'receiving') renderPurchasingView();
            else renderPoList();
        }
    } catch (err) {
        console.error('讀取採購單／待到貨資料失敗：', err);
        const message = err?.message || String(err || '未知錯誤');
        alert('讀取採購單／待到貨資料失敗：' + message);
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

async function loadPurchaseHistorySupplyProjection(poRows = [], reset = false) {
    if (reset) purchaseHistorySupplyCache = new Map();
    const ids = [...new Set((poRows || []).flatMap(po =>
        Array.isArray(po?.supplyOrderIds) ? po.supplyOrderIds : []
    ).map(id => String(id || '').trim()).filter(Boolean))];
    const missing = ids.filter(id => !purchaseHistorySupplyCache.has(id));
    if (!missing.length) return;
    const rows = await readDocumentsByIds('supplyOrders', missing);
    rows.forEach(row => purchaseHistorySupplyCache.set(row.id, row));
}

function isPurchaseTerminalStatus(status) {
    return ['CANCELLED','CLOSED'].includes(String(status || '').toUpperCase());
}

function purchaseOrderDocumentStatusLabel(po = {}) {
    const status=String(po.status || '').toUpperCase();
    if(status==='DRAFT' && po.documentOnly===true)return '文件已儲存／尚未採購';
    if(status==='CANCELLED')return '已取消';
    if(status==='CLOSED')return '已結案';
    return '已下單';
}

function purchaseHistoryItemReceiptProgress(po, itemIndex = 0) {
    if(po?.status==='DRAFT' && po.documentOnly===true)return {status:'DRAFT',label:'尚未採購',orderedQty:0,receivedQty:0,remainingQty:0,percent:0};
    const supplyId = Array.isArray(po?.supplyOrderIds) ? String(po.supplyOrderIds[itemIndex] || '') : '';
    const supply = supplyId ? purchaseHistorySupplyCache.get(supplyId) : null;
    if (supply && globalThis.YushinSupply?.receiptProgress) {
        return globalThis.YushinSupply.receiptProgress(supply);
    }
    if (isPurchaseTerminalStatus(po?.status)) {
        const closed=String(po?.status||'').toUpperCase()==='CLOSED';
        return { status:closed?'CLOSED':'CANCELLED', label:closed?'已結案':'未到貨已取消', orderedQty:0, receivedQty:0, remainingQty:0, percent:0 };
    }
    return { status:'UNKNOWN', label:'已建立', orderedQty:0, receivedQty:0, remainingQty:0, percent:0 };
}


function purchaseTimelineDateLabel(value='') {
    const raw=String(value||'').trim();
    if(!raw)return '—';
    if(/^\d{4}-\d{2}-\d{2}$/.test(raw))return raw;
    const date=new Date(raw);
    return Number.isNaN(date.getTime())?raw:date.toLocaleString('zh-TW',{hour12:false});
}

function purchaseTimelineSourceLabel(sourceType='') {
    return sourceType==='STOCK_REPLENISHMENT'?'備庫採購':sourceType==='SALES_ORDER'?'客戶訂單採購':'採購';
}

window.closePurchaseOrderTimeline = function() {
    document.getElementById('purchaseTimelineOverlay')?.classList.remove('active');
};

window.openPurchaseOrderTimeline = async function(poId) {
    if(!canAccessPage('orders.po')||!poId)return;
    const overlay=document.getElementById('purchaseTimelineOverlay');
    const title=document.getElementById('purchaseTimelineTitle');
    const summary=document.getElementById('purchaseTimelineSummary');
    const supplyBody=document.getElementById('purchaseTimelineSupplyBody');
    const eventsBody=document.getElementById('purchaseTimelineEvents');
    const status=document.getElementById('purchaseTimelineStatus');
    if(!overlay||!summary||!supplyBody||!eventsBody)return;
    overlay.classList.add('active');
    if(title)title.textContent='採購單追蹤';
    if(status)status.textContent='載入採購歷程中…';
    summary.innerHTML='';
    supplyBody.innerHTML='<tr><td colspan="6" style="color:#888;">載入中…</td></tr>';
    eventsBody.innerHTML='';

    try{
        let po=poListCache.find(row=>row.id===poId)||poHistorySearchResults.find(row=>row.id===poId)||null;
        if(!po){
            const snap=await firestoreReadWithTimeout(db.collection('purchaseOrders').doc(poId).get(),'採購單追蹤');
            if(!snap.exists)throw new Error('找不到這張採購單。');
            po={id:snap.id,...snap.data()};
        }

        const supplyIds=[...new Set((Array.isArray(po.supplyOrderIds)?po.supplyOrderIds:[]).map(String).filter(Boolean))];
        const supplyPromise=supplyIds.length?readDocumentsByIds('supplyOrders',supplyIds):Promise.resolve([]);
        const receiptPromise=firestoreReadWithTimeout(
            db.collection('receipts').where('purchaseDocumentId','==',po.id).get(),
            '採購單到貨歷程'
        );
        const communicationPromise=Promise.resolve(null);

        const [supplies,receiptSnapshot,communicationSnapshot]=await Promise.all([
            supplyPromise,receiptPromise,communicationPromise
        ]);
        const receipts=receiptSnapshot.docs.map(doc=>({id:doc.id,...doc.data()}));
        const communications=communicationSnapshot
            ? communicationSnapshot.docs.map(doc=>({id:doc.id,...doc.data()}))
            : [];

        if(title)title.textContent=`採購單追蹤｜${po.poNo||po.id}`;
        const contact=purchaseOrderSupplierContact(po);
        summary.innerHTML=`
            <strong>${escapeHtml(po.vendorName||contact.supplierName||'')}</strong>
            <span style="margin-left:12px;color:#667584;">採購日期：${escapeHtml(po.poDate||'—')}</span>
            <span style="margin-left:12px;color:#667584;">預計到貨：${escapeHtml(po.expectedDate||po.scheduleDate||'—')}</span>
            ${contact.email?`<span style="margin-left:12px;color:#667584;">Email：${escapeHtml(contact.email)}</span>`:''}
        `;

        supplyBody.innerHTML=supplies.length?supplies.map(supply=>{
            const progress=globalThis.YushinSupply?.receiptProgress(supply)||{
                orderedQty:Number(supply.qty||0),
                receivedQty:Number(supply.receivedQty||0),
                remainingQty:Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0)),
                label:String(supply.status||'')
            };
            return `<tr>
                <td>${escapeHtml(supply.itemCode||supply.itemName||'')}</td>
                <td>${escapeHtml(purchaseTimelineSourceLabel(supply.sourceType))}</td>
                <td>${Number(progress.orderedQty||0)}</td>
                <td>${Number(progress.receivedQty||0)}</td>
                <td>${Number(progress.remainingQty||0)}</td>
                <td>${escapeHtml(progress.label||'')}</td>
            </tr>`;
        }).join(''):'<tr><td colspan="6" style="color:#888;">沒有供應品項紀錄。</td></tr>';

        const events=[];
        const createdAt=po.createdAt||po.poDate||'';
        events.push({
            time:createdAt,
            type:'ORDER',
            title:'建立採購單',
            detail:`${po.poNo||po.id}｜${po.vendorName||''}｜${(purchaseItemsFromSavedPo(po)||[]).length} 個品項`
        });
        receipts.forEach(receipt=>{
            events.push({
                time:receipt.createdAt||receipt.receiptDate||'',
                type:'RECEIPT',
                title:`到貨 +${Number(receipt.qty||0)}`,
                detail:[receipt.itemCode||receipt.itemName||'',receipt.lotNo?('批號 '+receipt.lotNo):'',receipt.receiptDate||''].filter(Boolean).join('｜')
            });
        });
        communications.forEach(event=>{
            const channel=event.channel==='WEB_SHARE'?'開啟分享':'準備郵件';
            events.push({
                time:event.preparedAt||event.createdAt||'',
                type:'COMMUNICATION',
                title:channel,
                detail:[event.recipientEmail||'',event.createdBy||'','系統僅記錄已準備，不代表已寄達'].filter(Boolean).join('｜')
            });
        });
        if(String(po.status||'').toUpperCase()==='CANCELLED'){
            events.push({
                time:po.cancelledAt||po.updatedAt||'',
                type:'CANCELLED',
                title:'取消未到貨',
                detail:po.cancelReason||po.cancellationReason||'採購單已取消'
            });
        }
        events.sort((a,b)=>(Date.parse(b.time)||0)-(Date.parse(a.time)||0));
        eventsBody.innerHTML=events.map(event=>`
            <div class="purchase-timeline-event">
                <div style="display:flex;justify-content:space-between;gap:12px;">
                    <strong>${escapeHtml(event.title)}</strong>
                    <span class="record-reference">${escapeHtml(purchaseTimelineDateLabel(event.time))}</span>
                </div>
                <div class="record-reference">${escapeHtml(event.detail||'')}</div>
            </div>
        `).join('');
        if(status)status.textContent=`${supplies.length} 個供應品項｜${receipts.length} 筆到貨${canCreatePurchaseOrderCapability()?`｜${communications.length} 筆聯絡紀錄`:''}`;
    }catch(err){
        console.error('採購單追蹤載入失敗：',err);
        if(status)status.textContent='載入失敗：'+(err?.message||err);
        supplyBody.innerHTML='<tr><td colspan="6" style="color:#b42318;">載入失敗，請重試。</td></tr>';
    }
};

function purchaseOrderSearchTokens(po={}) {
    return globalThis.YushinSupplier.purchaseOrderSearchTokens(po);
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
                const snapshot=await firestoreReadWithTimeout(query.get(),'採購單索引搜尋');
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
        await loadPurchaseHistorySupplyProjection([...results.values()], false);
        if(generation!==poHistorySearchGeneration)return;
        if(status)status.textContent=`全歷史搜尋完成：找到 ${results.size} 筆`;
    }catch(err){
        if(generation!==poHistorySearchGeneration)return;
        console.error('採購單全歷史搜尋失敗：',err);
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

function receivingDueInfo(supplies = [], today = localDateString()) {
    const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '').slice(0,10))
        ? String(value || '').slice(0,10)
        : '';
    const expectedDates = (supplies || [])
        .map(supply => validDate(supply?.expectedDate || supply?.scheduleDate || ''))
        .filter(Boolean)
        .sort();
    const expectedDate = expectedDates[0] || '';
    const todayDate = validDate(today) || localDateString();
    if (!expectedDate) return { expectedDate:'', status:'unscheduled', daysLate:0, sortRank:3 };
    if (expectedDate < todayDate) {
        const expectedTime = Date.parse(expectedDate + 'T00:00:00Z');
        const todayTime = Date.parse(todayDate + 'T00:00:00Z');
        const daysLate = Number.isFinite(expectedTime) && Number.isFinite(todayTime)
            ? Math.max(1, Math.floor((todayTime - expectedTime) / 86400000))
            : 1;
        return { expectedDate, status:'late', daysLate, sortRank:0 };
    }
    if (expectedDate === todayDate) return { expectedDate, status:'today', daysLate:0, sortRank:1 };
    return { expectedDate, status:'upcoming', daysLate:0, sortRank:2 };
}

function receivingDueHtml(info = {}) {
    const date = escapeHtml(info.expectedDate || '');
    if (info.status === 'late') return `<div class="receiving-due-note"><span class="status-badge status-overdue">逾期 ${Number(info.daysLate || 0)} 天</span><span class="record-reference">預計 ${date}</span></div>`;
    if (info.status === 'today') return `<div class="receiving-due-note is-warning">今天預計到貨 ${date}</div>`;
    if (info.status === 'upcoming') return `<div class="receiving-due-note">預計到貨 ${date}</div>`;
    return '<div class="receiving-due-note">預計到貨日未設定</div>';
}

function receivingWaitHtml(supplies = []) {
    const dates = supplies.map(supply => String(supply.poDate || supply.orderedAt || supply.orderDate || supply.createdAt || '').slice(0,10)).filter(Boolean).sort();
    const waiting = dates.length ? waitingDaysFromDate(dates[0]) : '';
    return waiting ? `<div style="margin-top:4px;font-size:12px;color:#667584;">已等待 ${escapeHtml(waiting)}</div>` : '';
}

function receivingPlanRiskInfo(order = {}, item = {}, supplies = []) {
    if (!globalThis.YushinProcurementDemand?.deliveryPlanRisk) {
        return { status:'unavailable', sortRank:4 };
    }
    const demand = procurementDemandForOrderItem(order, item);
    const risk = globalThis.YushinProcurementDemand.deliveryPlanRisk(demand, supplies);
    const sortRank = risk.status === 'at_risk'
        ? 0
        : risk.status === 'uncovered'
            ? 1
            : risk.status === 'unscheduled'
                ? 2
                : 3;
    return { ...risk, sortRank };
}

function receivingPlanRiskHtml(info = {}) {
    if (info.status === 'at_risk') {
        return `<div style="margin-top:4px;"><span class="status-badge status-soon">交期風險・預計晚需求 ${Number(info.delayDays || 0)} 天</span><span class="record-reference">需求 ${escapeHtml(info.requiredDate || '')}</span></div>`;
    }
    if (info.status === 'uncovered') {
        return `<div class="receiving-due-note is-warning">採購計畫尚缺 ${Number(info.missingQty || 0)}｜需求 ${escapeHtml(info.requiredDate || '')}</div>`;
    }
    if (info.status === 'unscheduled') {
        return `<div class="receiving-due-note is-warning">交期未完整排定｜需求 ${escapeHtml(info.requiredDate || '')}</div>`;
    }
    return '';
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

function supplyCancelActionHtml(supply) {
    if (!supply || !['PURCHASING_MANUAL', 'PURCHASING_PO'].includes(supply.type)) return '';
    if (!canCreatePurchaseOrderCapability()) return '';
    if (isPurchaseTerminalStatus(supply.status)) return '';
    const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
    if (remaining <= 0) return '';
    const key = `supply:${supply.id}`;
    const pending = purchaseCancellationInProgress.has(key);
    return `<details class="workflow-more"><summary class="btn-small btn-secondary">更多</summary><button type="button" class="btn-small danger-menu-item" onclick="cancelSupplyOutstanding(${inlineJsValue(supply.id)})" ${pending ? 'disabled' : ''}>${pending ? '取消中…' : '取消未到貨'}</button></details>`;
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

function renderPurchasingReceivingWorkList(normalizedItemsByOrder = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null, inventory = false) {
    if (inventory && window.renderInventoryPurchaseReceiving) return window.renderInventoryPurchaseReceiving();
    const tbody = document.getElementById(inventory ? 'inventoryReceivingBody' : 'poListBody');
    const head = document.getElementById(inventory ? 'inventoryReceivingHead' : 'poListHeadRow');
    const emptyHint = document.getElementById(inventory ? 'inventoryReceivingEmpty' : 'poListEmptyHint');
    const status = document.getElementById(inventory ? 'inventoryReceivingStatus' : 'poHistorySearchStatus');
    if (!tbody) return;
    const workKeyword = inventory ? '' : document.getElementById('purchaseWorkSearch')?.value || '';
    const historySearch = !inventory && document.getElementById('poListSearch');
    if (historySearch) historySearch.hidden = true;
    if (head) head.innerHTML = inventory ? '<th>訂單日期</th><th>客戶</th><th>待到貨品項</th><th>數量</th><th>負責業務</th><th>到貨進度</th><th class="no-print">操作</th>' : '<th>訂單日期</th><th>客戶</th><th>產品資訊</th><th>負責業務</th><th>銷售金額</th><th>交易／開票資料</th><th>進度</th><th class="no-print">操作</th>';
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();

    const filters = inventory ? { ...purchaseFilterContext(), selectedSales:'', selectedBrand:'', start:'', end:'' } : (filterContext || purchaseFilterContext());
    let workCount = 0;
    let missingEvidence = 0;
    let evidenceCount = 0;
    let standaloneSupplyCount = 0;
    let overdueCount = 0;
    let planRiskCount = 0;
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
            if (!workflowLineMatchesSearch(order,item,workKeyword)) return;
            if (!purchaseLineMatchesFilters(order.orderDate, order.salesName, item.brand, filters)) return;
            workCount++;
            const progress = receivingWorkProgress(order, item);
            const evidence = receivingEvidenceForWorkItem(order, item, itemIndex, evidenceIndex);
            evidence.forEach(entry => representedSupplyIds.add(entry.id));
            evidenceCount += evidence.length;
            if (!evidence.length) missingEvidence++;
            const evidenceSupplies = evidence.map(entry => supplyById.get(entry.id)).filter(Boolean);
            const due = receivingDueInfo(evidenceSupplies);
            const planRisk = receivingPlanRiskInfo(order, item, evidenceSupplies);
            if (due.status === 'late') overdueCount++;
            if (planRisk.status === 'at_risk') planRiskCount++;

            const actionHtml = !canReceiveInventoryCapability()
                ? '<span class="order-progress-badge">唯讀</span>'
                : evidence.length
                    ? evidence.map((entry, index) => {
                        const suffix = evidence.length > 1 ? ` ${index + 1}/${evidence.length}` : '';
                        const supply = supplyById.get(entry.id);
                        const receiveButton = `<button type="button" class="btn-small btn-secondary" data-receipt-supply="${escapeAttr(entry.id)}" onclick="openSupplyReceipt(${inlineJsValue(entry.id)})">📥 到貨入庫${suffix}</button>`;
                        return [canConfirmSupplyReceipt(supply)?receiveButton:'<span class="order-progress-badge">待負責業務確認直送到貨</span>', supplyCancelActionHtml(supply)].filter(Boolean).join(' ');
                    }).join(' ')
                    : '<span class="order-progress-badge order-progress-warning">找不到採購紀錄</span>';

            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td data-th="訂單日期">${workflowRecordSummary(order, order.orderDate)}</td>
                <td data-th="客戶">${escapeHtml(order.customer || order.customerName || '')}</td>
                <td data-th="待到貨品項">${purchaseProductSummary(item, progress.target, null)}</td><td data-th="數量">${workflowQuantitySummary(progress.target,'應到貨')}</td>
                <td data-th="負責業務">${escapeHtml(order.salesName || '')}</td>
                <td data-th="到貨進度"><span class="workflow-quantity">已到貨 ${progress.received}／應到貨 ${progress.target}</span><small class="purchase-item-description">待到貨 ${Math.max(0, progress.target-progress.received)}</small>${receivingWaitHtml(evidenceSupplies)}${receivingDueHtml(due)}${receivingPlanRiskHtml(planRisk)}</td>
                <td data-th="操作" class="no-print"><div class="workflow-inline-actions">${actionHtml}</div></td>`;
            if (!inventory) organizePurchasingOrderRow(tr,order,item);
            tr.dataset.receivingDueRank = String(due.sortRank);
            tr.dataset.receivingPlanRiskRank = String(planRisk.sortRank ?? 4);
            tr.dataset.receivingExpectedDate = due.expectedDate || '';
            tr.dataset.receivingOrderDate = order.orderDate || '';
            fragment.appendChild(tr);
        });
    });

    // 沒有對應到「正常訂單待到貨工作」的供應紀錄仍可能是真實在途：
    // 例如庫存補貨，或客戶訂單取消後供應商仍照常出貨。這些不可從採購頁消失。
    supplyReceivingCache.forEach(supply => {
        if (representedSupplyIds.has(supply.id)) return;
        const supplyProgress = globalThis.YushinSupply?.receiptProgress(supply);
        if (!supplyProgress) return;
        const ordered = supplyProgress.orderedQty;
        const remaining = supplyProgress.remainingQty;
        if (remaining <= 0) return;

        const sourceOrder = receivingSourceOrderForItem(supply, orderById);
        const sourceStatus = sourceOrder ? normalizedOrderStatus(sourceOrder) : '';
        if (!workflowLineMatchesSearch(sourceOrder,supply,workKeyword)) return;
        const directShip = (supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
        const date = sourceOrder?.orderDate || supply.orderDate || '';
        const salesName = sourceOrder?.salesName || supply.salesName || supply.createdBy || '';
        const brand = supply.brand || '';
        if (supply.orderId) {
            if (!purchaseLineMatchesFilters(date, salesName, brand, filters)) return;
        } else {
            // 公司備庫沒有負責業務；負責業務篩選不應讓真實在途採購從待到貨消失。
            if (!purchaseLineMatchesFilters(date, '', brand, { ...filters, selectedSales:'' })) return;
        }

        // 已取消訂單的原廠直送沒有倉庫可承接，因此只能顯示警示、不可確認到貨。
        const blockedDirectShip = directShip && sourceOrder && sourceStatus !== 'normal';
        const cancelAction = supplyCancelActionHtml(supply);
        const actionHtml = !canConfirmSupplyReceipt(supply)
            ? [directShip?'<span class="order-progress-badge">待負責業務確認直送到貨</span>':'<span class="order-progress-badge">唯讀</span>',cancelAction].filter(Boolean).join(' ')
            : blockedDirectShip
                ? ['<span class="order-progress-badge order-progress-warning">來源訂單已取消，直送不可確認</span>', cancelAction].filter(Boolean).join(' ')
                : [
                    `<button type="button" class="btn-small btn-secondary" data-receipt-supply="${escapeAttr(supply.id)}" onclick="openSupplyReceipt(${inlineJsValue(supply.id)})">${directShip ? '確認直送到貨' : '📥 到貨入庫'}</button>`,
                    cancelAction
                ].filter(Boolean).join(' ');

        const customerLabel = sourceOrder?.customerName || sourceOrder?.customer || supply.customerName
            || (supply.orderId ? '來源訂單' : '庫存補貨');
        const sourceLabel = sourceOrder && sourceStatus !== 'normal'
            ? (supply.customerCancellationDisposition === 'KEEP_STOCK' ? '客戶已取消・供應商不同意取消・到貨轉庫存' : '客戶已取消・採購待確認供應商答覆')
            : !supply.orderId
                ? '庫存補貨'
                : sourceOrder
                    ? '待到貨'
                    : '供應紀錄';
        const due = receivingDueInfo([supply]);
        if (due.status === 'late') overdueCount++;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td data-th="訂單日期">${workflowRecordSummary(sourceOrder, date)}</td>
            <td data-th="客戶">${escapeHtml(customerLabel)}</td>
            <td data-th="待到貨品項">${purchaseProductSummary(supply, ordered, null)}</td><td data-th="數量">${workflowQuantitySummary(ordered,'應到貨')}</td>
            <td data-th="負責業務">${escapeHtml(salesName)}</td>
            <td data-th="到貨進度">${escapeHtml(sourceLabel)}｜已到貨 ${supplyProgress.receivedQty}／應到貨 ${ordered}<small class="purchase-item-description">待到貨 ${remaining}</small>${receivingWaitHtml([supply])}${receivingDueHtml(due)}</td>
            <td data-th="操作" class="no-print"><div class="workflow-inline-actions">${sourceOrder && sourceStatus !== 'normal' && canCreatePurchaseOrderCapability() ? customerCancellationActions(supply) : actionHtml}</div></td>`;
        if (!inventory) organizePurchasingOrderRow(tr,sourceOrder,sourceOrder ? normalizedOrderItems(sourceOrder).find(item=>item.itemId===supply.itemId)||{} : {});
        if (!inventory && !supply.orderId) {
            tr.querySelector('[data-th="銷售金額"]').textContent='公司備庫・無銷售金額';
            tr.querySelector('[data-th="交易／開票資料"]').textContent='公司備庫・無客戶開票資料';
        }
        tr.dataset.receivingDueRank = String(due.sortRank);
        tr.dataset.receivingPlanRiskRank = '4';
        tr.dataset.receivingExpectedDate = due.expectedDate || '';
        tr.dataset.receivingOrderDate = date || '';
        fragment.appendChild(tr);
        standaloneSupplyCount++;
    });

    const sortedRows = Array.from(fragment.childNodes).sort((a, b) => {
        const rankDiff = Number(a.dataset.receivingDueRank || 3) - Number(b.dataset.receivingDueRank || 3);
        if (rankDiff) return rankDiff;
        const planRiskDiff = Number(a.dataset.receivingPlanRiskRank || 4) - Number(b.dataset.receivingPlanRiskRank || 4);
        if (planRiskDiff) return planRiskDiff;
        const aExpected = a.dataset.receivingExpectedDate || '9999-12-31';
        const bExpected = b.dataset.receivingExpectedDate || '9999-12-31';
        const expectedDiff = aExpected.localeCompare(bExpected);
        if (expectedDiff) return expectedDiff;
        return String(b.dataset.receivingOrderDate || '').localeCompare(String(a.dataset.receivingOrderDate || ''));
    });
    sortedRows.forEach(row => fragment.appendChild(row));
    tbody.appendChild(fragment);
    renderReceiptTasks();

    if (!inventory) tbody.querySelectorAll('button[onclick^="openSupplyReceipt"]').forEach(button => {
        button.setAttribute('onclick', 'openInventoryReceiving()');
        button.textContent = '前往倉庫收貨';
    });
    const totalRows = workCount + standaloneSupplyCount;
    const supplyMetrics = receivingSupplyMetrics(filters);
    if (inventory) updateInventoryReceivingCount(supplyMetrics.count);
    if (emptyHint) {
        emptyHint.style.display = totalRows === 0 ? 'block' : 'none';
        emptyHint.textContent = !purchasingReceivingReady ? '正在載入待到貨工作…' : '目前沒有待到貨品項。';
    }
    if (status) {
        if (!purchasingReceivingReady) status.textContent = `待到貨工作 ${workCount} 個；採購資料載入中…`;
        else {
            const parts = [`待到貨 ${supplyMetrics.count} 筆採購供應（${supplyMetrics.quantity} 個）`, `${workCount} 個正常訂單品項`];
            if (overdueCount) parts.push(`逾期 ${overdueCount} 筆已置頂`);
            if (planRiskCount) parts.push(`另有 ${planRiskCount} 筆預計晚於需求日`);
            if (standaloneSupplyCount) parts.push(`另有 ${standaloneSupplyCount} 筆庫存補貨／非正常訂單供應`);
            if (evidenceCount > workCount) parts.push(`其中 ${evidenceCount - workCount} 筆為分批／多張採購來源，已合併在同一品項顯示`);
            if (missingEvidence) parts.push(`${missingEvidence} 個品項尚未找到可操作的採購紀錄`);
            status.textContent = workKeyword ? `符合搜尋 ${totalRows} 個待到貨品項` : parts.join('。');
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
    if (head) head.innerHTML = '<th>單號</th><th>公司</th><th>供應商</th><th>採購人員</th><th>採購日期</th><th>預計到貨</th><th>等待天數</th><th>產品資訊</th><th>品項金額</th><th>文件狀態</th><th>到貨進度</th><th class="no-print">操作</th>';
    const tbody = document.getElementById('poListBody');
    const searchInput = document.getElementById('poListSearch');
    if (!tbody || !searchInput) return;
    searchInput.hidden = false;
    const keyword = (searchInput.value || '').toLowerCase();
    const filters = filterContext || purchaseFilterContext();
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    const poRows = poHistorySearchActive ? poHistorySearchResults : poListCache;
    poRows.forEach(po => {
        // 全歷史搜尋已在資料層比對單號、廠商、採購人員與品項；歷史搜尋模式不可再用較窄欄位二次過濾。
        if (!poHistorySearchActive) {
            const searchable = `${po.poNo || ''} ${po.vendorName || ''} ${po.supplierName || ''} ${po.supplierEmail || ''} ${po.buyerName || ''}`.toLowerCase();
            if (keyword && !searchable.includes(keyword)) return;
        }

        const items = purchaseItemsFromSavedPo(po);
        const companyInfo = companyData[po.company];
        const companyLabel = companyInfo ? `${companyInfo.title}（${companyInfo.prefix}）` : (po.company || '');
        const supplierContact = purchaseOrderSupplierContact(po);

        items.forEach((item,itemIndex)=>{
            const ordered=Math.max(0,Number(item.qty||0));
            if (!purchaseLineMatchesFilters(po.poDate, item.salesName, item.brand, filters)) return;
            shown++;
            const itemTotal=Math.round(ordered*Number(item.unitPrice||0)*1.05);
            const receiptProgress=purchaseHistoryItemReceiptProgress(po,itemIndex);
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td data-th="單號">${escapeHtml(po.poNo || '')}</td>
                <td data-th="公司">${escapeHtml(companyLabel)}</td>
                <td data-th="供應商">${escapeHtml(po.vendorName || '')}</td>
                <td data-th="採購人員">${escapeHtml(po.buyerName || '')}</td>
                <td data-th="採購日期">${escapeHtml(po.poDate || '')}</td>
                <td data-th="預計到貨">${escapeHtml(po.expectedDate || po.scheduleDate || '—')}${(po.expectedDate||po.scheduleDate)&&receiptProgress.remainingQty>0&&(po.expectedDate||po.scheduleDate)<localDateString()?'・逾期':''}</td>
                <td data-th="等待天數">${['DRAFT','CANCELLED','CLOSED','UNKNOWN'].includes(receiptProgress.status) ? escapeHtml(receiptProgress.label) : receiptProgress.remainingQty > 0 ? escapeHtml(poWaitingDays(po)||'—') : '已到貨'}</td>
                <td data-th="產品資訊">${purchaseProductSummary(item, ordered, null)}</td>
                <td data-th="品項金額" class="workflow-money">${workflowAmountSummary(item,ordered,{unit:Number(item.unitPrice||0)*1.05,total:itemTotal,label:'含稅單價',totalLabel:'含稅品項小計'})}</td>
                <td data-th="文件狀態">${escapeHtml(purchaseOrderDocumentStatusLabel(po))}</td>
                <td data-th="到貨進度">${escapeHtml(receiptProgress.label)}</td>
                <td data-th="操作" class="no-print">${itemIndex===0?`
                    <div class="po-list-action-row">
                        <button type="button" class="btn-small btn-secondary" onclick="reprintPurchaseOrder(${inlineJsValue(po.id)})">開啟採購單</button>
                        ${po.status==='DRAFT' && po.documentOnly===true && canCreatePurchaseOrderCapability() && canEditPage('orders.po') ? `<button type="button" class="btn-small" onclick="confirmSavedPurchaseOrder(${inlineJsValue(po.id)})">確認已採購</button>` : ''}
                        ${canCreatePurchaseOrderCapability() && canEditPage('orders.po') ? `<button type="button" class="btn-small btn-secondary" onclick="copySavedPurchaseOrderAsNew(${inlineJsValue(po.id)})">複製新採購</button>` : ''}
                    </div>`:'—'}</td>
            `;
            fragment.appendChild(tr);
        });
    });


    tbody.appendChild(fragment);

    const emptyHint = document.getElementById('poListEmptyHint');
    if (emptyHint) {
        emptyHint.style.display = shown === 0 ? 'block' : 'none';
        emptyHint.textContent = poHistorySearchLoading ? '正在搜尋採購單…' : keyword || filters.start || filters.end || filters.selectedSales || filters.selectedBrand ? '查無符合條件的採購單。' : '目前還沒有產生過任何採購單。';
    }
};

// 把「採購訂單」裡一筆舊的採購單紀錄，重新載回採購單視窗，維持原本的單號，方便再列印一次
async function purchaseIncomingSyncPending(po) {
    if (po?.status==='DRAFT' || po?.documentOnly===true || isPurchaseTerminalStatus(po?.status)) return false;
    const supplyIds = Array.isArray(po?.supplyOrderIds) ? po.supplyOrderIds.filter(Boolean) : [];
    if (!supplyIds.length) return false;
    const supplies = await readDocumentsByIds('supplyOrders', supplyIds);
    if (supplies.length !== new Set(supplyIds).size) return true;
    return supplies.some(supply => {
        if (isPurchaseTerminalStatus(supply.status)) return false;
        if ((supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return false;
        const targetQty = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
        const registeredQty = Math.max(0, Number(supply.incomingRegisteredQty || 0));
        return registeredQty < targetQty;
    });
}

window.reprintPurchaseOrder = async function(poId) {
    poDirectStockOpenGeneration++;
    poDirectStockMode = false;
    poNoGeneration++;
    poNoLoading = false;
    poNoReady = true;
    const po = poListCache.find(p => p.id === poId) || poHistorySearchResults.find(p => p.id === poId);
    if (po && !poListCache.some(p => p.id === poId)) poListCache.push(po);
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
    const poExpectedDateInput=document.getElementById('poExpectedDate');
    if(poExpectedDateInput)poExpectedDateInput.value=po.expectedDate||po.scheduleDate||'';
    syncPoLeadDays();
    document.getElementById('poNo').innerText = po.poNo || '';

    renderPoItemsTable();
    updatePoModeUI();
    document.getElementById('poModalOverlay').classList.add('active');

    if(po.status==='DRAFT' && po.documentOnly===true){
        updatePoSaveStatus('文件已儲存，尚未採購。下載 PDF 不改採購進度；實際下單後請按「確認已採購」。');
        updatePoSaveButton();return;
    }
    if (isPurchaseTerminalStatus(po.status)) {
        poIncomingSyncPending = false;
        const terminalLabel=String(po.status||'').toUpperCase()==='CLOSED'?'已結案':'已取消';
        updatePoSaveStatus(`採購單 ${po.poNo || po.id} ${terminalLabel}；此文件僅供查閱或重新輸出 PDF，不會重新增加在途庫存。`);
        updatePoSaveButton();
        return;
    }

    poSaveInProgress = true;
    updatePoSaveStatus(`正在確認採購單 ${po.poNo || po.id} 的在途同步狀態…`);
    updatePoSaveButton();
    try {
        poIncomingSyncPending = await purchaseIncomingSyncPending(po);
        updatePoSaveStatus(poIncomingSyncPending
            ? `採購單 ${po.poNo || po.id} 已同步雲端，但供應紀錄仍需同步在途庫存。`
            : `採購單 ${po.poNo || po.id} 已同步雲端。按下方按鈕即可再次列印或輸出 PDF。`);
    } catch (err) {
        poIncomingSyncPending = true;
        updatePoSaveStatus(`無法確認供應紀錄的在途同步狀態：${err.message}`, true);
    } finally {
        poSaveInProgress = false;
        updatePoSaveButton();
    }
};

window.copySavedPurchaseOrderAsNew = async function(poId) {
    if (poSaveInProgress || !canCreatePurchaseOrderCapability() || !canEditPage('orders.po')) return;
    const po = poListCache.find(item => item.id === poId) || poHistorySearchResults.find(item => item.id === poId);
    if (!po) return alert('找不到這張採購單，請重新整理。');
    const sourceItems = purchaseItemsFromSavedPo(po);
    if (!sourceItems.length) return alert('這張採購單沒有可複製的品項。');

    poDirectStockOpenGeneration++;
    const copySourceId = `copy-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    poDirectStockMode = true;
    poEditingId = null;
    poIncomingSyncPending = false;
    // 只複製商品與價格；新採購不沿用客戶需求、供應或到貨狀態。
    poAllItems = sourceItems.map((item, index) => ({
        ...emptyDirectPoItem(),
        sourceId: `${copySourceId}-${index}`,
        itemName: item.itemName,
        itemCode: item.itemCode,
        productId: item.productId,
        brand: item.brand,
        brandId: item.brandId,
        productLine: item.productLine || '',
        productType: item.productType || '',
        spec: item.spec || '',
        unit: item.unit || '',
        qty: item.qty,
        unitPrice: item.unitPrice,
        supplier: item.supplier || '',
        warehouseId: item.warehouseId || defaultWarehouse()?.id || ''
    }));
    poItems = poAllItems.map(item => ({ ...item }));

    populatePoVendorSuggestions();
    switchPoCompany(po.company || 'yushin', null, true);
    document.getElementById('poVendorName').value = po.vendorName || '';
    document.getElementById('poBuyerName').innerText = currentUserName || currentUser?.email || '';
    document.getElementById('poDate').value = localDateString();
    clearPoExpectedDate();
    renderPoItemsTable();
    // 先顯示表單，再讀取新單號，避免慢網路下按鈕沒有回饋。
    const numberPromise = generatePoNo();
    updatePoModeUI();
    updatePoSaveStatus('尚未建立新採購。請確認供應商、品項、數量、單價及預計到貨日，再按「建立採購單並下載 PDF」；文件不增加在途，實際下單後另按「確認已採購」。');
    document.getElementById('poModalOverlay').classList.add('active');
    await numberPromise;
};

window.exportPurchaseOrderFromHistory = async function(poId) {
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '準備 PDF…');
    if (button && !buttonState) return;
    try {
        await reprintPurchaseOrder(poId);
        await printPurchaseOrder();
    } catch (err) {
        console.error('重新匯出採購單 PDF 失敗：', err);
        alert('重新匯出採購單 PDF 失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
};

// 從原始訂單上的採購單號直接開啟該張採購單，避免還要切分頁搜尋。
window.openPurchaseOrderFromOrder = async function(poNo) {
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '開啟中…');
    if (button && !buttonState) return;
    const open = async po => {
        if (!po) { alert('找不到這張採購單紀錄。'); return; }
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
            '採購單紀錄'
        );
        await open(doc.exists ? { id: doc.id, ...doc.data() } : null);
    } catch (err) {
        alert('讀取採購單失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
};

