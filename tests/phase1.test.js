const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rulesSource = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const firestoreIndexes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));

function loadPurchaseMapper() {
    const start = appSource.indexOf('function purchaseItemsFromOrder(order)');
    const end = appSource.indexOf('\n}\n\nfunction bestPurchaseOrderCompany', start) + 2;
    assert.ok(start >= 0 && end > start, 'purchaseItemsFromOrder must exist');
    const context = {
        priceItemLookup: new Map([
            ['code:a-1', { cost: 25 }],
            ['brand:acme:b-2', { cost: 40 }]
        ]),
        purchaseCostCache: new Map(),
        stableProductId: item => 'prd:' + String(item?.brand || '').toLowerCase() + ':' + String(item?.model || ''),
        authorizationTypeForProduct: () => 'NON_AUTHORIZED',
        normalizeItemCode: value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase()
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    return context.purchaseItemsFromOrder;
}

function loadSavedPurchaseMapper() {
    const start = appSource.indexOf('function purchaseItemsFromSavedPo(po)');
    const end = appSource.indexOf('\n}\n\n// 將不同時期', start) + 2;
    assert.ok(start >= 0 && end > start, 'purchaseItemsFromSavedPo must exist');
    const context = {};
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    return context.purchaseItemsFromSavedPo;
}

test('purchase mapper supports legacy single-item orders', () => {
    const items = loadPurchaseMapper()({ id: 'old', itemName: 'Legacy', itemCode: 'A-1', brand: 'Acme', qty: '3' });
    assert.equal(items.length, 1);
    assert.deepEqual({ name: items[0].itemName, qty: items[0].qty, cost: items[0].unitPrice }, { name: 'Legacy', qty: 3, cost: 25 });
});

test('purchase mapper expands modern multi-item orders and field aliases', () => {
    const items = loadPurchaseMapper()({
        id: 'new',
        items: [
            { productName: 'First', productCode: 'A-1', quantity: 2 },
            { name: 'Second', model: 'B-2', manufacturer: 'Acme', count: '4' }
        ]
    });
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => [item.itemName, item.qty, item.unitPrice]), [
        ['First', 2, 25],
        ['Second', 4, 40]
    ]);
});

test('purchase mapper supports products and embedded purchase prices', () => {
    const [item] = loadPurchaseMapper()({ id: 'alt', products: [{ nameCn: 'Third', code: 'C-3', qty: 5, purchasePrice: 12 }] });
    assert.deepEqual([item.itemName, item.itemCode, item.qty, item.unitPrice], ['Third', 'C-3', 5, 12]);
});

test('saved purchase orders remain readable with alternate item containers', () => {
    const items = loadSavedPurchaseMapper()({
        orderItems: [{ productName: 'Saved', productCode: 'P-1', quantity: '6', costPrice: '18' }]
    });
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].itemName, items[0].itemCode, items[0].qty, items[0].unitPrice], ['Saved', 'P-1', 6, 18]);
    const [legacyRoot] = loadSavedPurchaseMapper()({ itemName: 'Root', itemCode: 'R-1', qty: 2, unitPrice: 9 });
    assert.deepEqual([legacyRoot.itemName, legacyRoot.qty, legacyRoot.unitPrice], ['Root', 2, 9]);
});

test('order refresh stays paginated and status writes have an in-flight guard', () => {
    const loaderStart = appSource.indexOf('window.loadOrdersFromCloud =');
    const loaderEnd = appSource.indexOf('\n};', loaderStart) + 3;
    const loader = appSource.slice(loaderStart, loaderEnd);
    assert.match(loader, /loadOrderPage\(true\)/);
    assert.doesNotMatch(loader, /while\s*\(/);
    assert.match(appSource, /pendingOrderStatusKeys\.has\(pendingKey\)/);
    assert.match(appSource, /pendingOrderStatusKeys\.delete\(pendingKey\)/);
    const roleSwitchStart = appSource.indexOf('window.switchViewRole =');
    const roleSwitchEnd = appSource.indexOf('\n};', roleSwitchStart) + 3;
    const roleSwitch = appSource.slice(roleSwitchStart, roleSwitchEnd);
    assert.doesNotMatch(roleSwitch, /loadMyQuotesFromCloud\(\)|loadOrdersFromCloud\(\)|loadEquipmentFromCloud\(\)/);
});

test('order loading recovers from suspended mobile reads without blanking cached rows', () => {
    assert.match(appSource, /FIRESTORE_READ_TIMEOUT_MS/);
    assert.match(appSource, /firestoreReadWithTimeout\(query\.get\(\), '訂單'\)/);
    assert.match(appSource, /orderLoadGeneration/);
    assert.match(appSource, /loadOrderPage\(true, \{ force: true, silent: true \}\)/);
    assert.match(appSource, /document\.addEventListener\('visibilitychange'/);
    assert.match(appSource, /window\.addEventListener\('pageshow'/);
    assert.doesNotMatch(appSource, /orderPaginationState = createOrderPaginationState\(\);\s*ordersCache = \[\];/);
    assert.match(cssSource, /#appContainer\.resume-repaint/);
    assert.match(indexSource, /styles\.css\?v=20260923-6/);
    assert.match(indexSource, /app\.js\?v=20260923-7/);
});

test('product management uses server search without exposing protected cost data', () => {
    assert.match(indexSource, /id="product-system"/);
    assert.match(indexSource, /data-main-nav="products"/);
    const searchStart = appSource.indexOf('window.searchProductManagement =');
    const searchEnd = appSource.indexOf('\n};', searchStart) + 3;
    const productSearch = appSource.slice(searchStart, searchEnd);
    assert.match(productSearch, /db\.collection\('products'\)/);
    assert.match(productSearch, /limit\(50\)/);
    assert.doesNotMatch(productSearch, /productCosts|loadVisibleProductCost/);
    assert.match(appSource, /window\.addProductManagementToQuote/);
    assert.match(appSource, /window\.addProductManagementToOrder/);
});

test('inventory product lookup debounces server search', () => {
    assert.match(indexSource, /id="businessProductSearch"[^>]+oninput="queueBusinessProductSearch\(\)"/);
    assert.match(appSource, /businessProductSearchTimer=setTimeout\(\(\)=>searchBusinessProducts\(\),400\)/);
    assert.match(appSource, /db\.collection\('products'\).*limit\(25\)/s);
});

test('product management debounces full Product Master search', () => {
    assert.match(indexSource, /oninput="queueProductManagementSearch\(\)"/);
    assert.match(appSource, /productManagementSearchTimer = setTimeout\(\(\) => searchProductManagement\(\), 400\)/);
    assert.match(appSource, /db\.collection\('products'\).*limit\(50\)/s);
});

test('preview host selects isolated Firebase project and exposes a visible environment banner', () => {
    assert.match(appSource, /preview-20135\.firebaseapp\.com/);
    assert.match(appSource, /preview-20135\.web\.app/);
    assert.match(appSource, /projectId: "preview-20135"/);
    assert.match(appSource, /APP_ENVIRONMENT === 'preview'/);
    assert.match(indexSource, /PREVIEW／測試環境｜資料與正式系統分離/);
});

test('engineer quote selector uses own identity; purchaser selects responsible salesperson', () => {
    assert.match(appSource, /function populateSalesDropdown\(\)/);
    assert.match(appSource, /currentUserRole === 'engineer'\s*\? s\.uid === currentUser\?\.uid\s*: role === 'sales'/);
    assert.match(appSource, /currentUserRole === 'engineer' \? currentUserName : ''/);
});

test('purchaser order form assigns a salesperson while preserving creator identity', () => {
    assert.match(indexSource, /id="orderOwnerUid"/);
    const start = appSource.indexOf('window.saveNewOrder = function()');
    const end = appSource.indexOf('\n};', start) + 3;
    const saveOrder = appSource.slice(start, end);
    assert.match(saveOrder, /currentUserRole === 'purchaser' && !assistedOwner/);
    assert.match(saveOrder, /ownerUid: assistedOwner\?\.uid \|\| currentUser\?\.uid/);
    assert.match(saveOrder, /\.\.\.commercialCreatorFields\(\)/);
});

test('low-stock inventory can hand off to formal replenishment purchase flow', () => {
    assert.match(appSource, /openInventoryReplenishment/);
    assert.match(appSource, /safetyStock>0 && n\.available<=safetyStock && canEditPage\('orders\.po'\)/);
    assert.match(appSource, /poDirectStockMode = true/);
    assert.match(appSource, /suggestedQty = Math\.max\(1, safetyStock - stock\.available\)/);
    assert.match(appSource, /generateNextPoNumber\(\)/);
});

test('purchase workspace shows waiting days only for open warehouse receipts', () => {
    assert.match(indexSource, />等待天數</);
    assert.match(appSource, /function poWaitingDays\(po\)/);
    assert.match(appSource, /progress\.complete \|\| progress\.directShipOnly/);
    assert.match(appSource, /data-th="等待天數"/);
});

test('main navigation exposes focused order and purchasing workspaces', () => {
    assert.match(indexSource, /data-main-nav="orders"/);
    assert.match(indexSource, /data-main-nav="purchasing"/);
    assert.match(appSource, /window\.openOrderWorkspace/);
    assert.match(appSource, /window\.openPurchasingWorkspace/);
});

test('agency settings do not trigger a full orders statistics query', () => {
    const switchStart = appSource.indexOf('window.switchAdminTab =');
    const switchEnd = appSource.indexOf('\n};', switchStart) + 3;
    const adminSwitch = appSource.slice(switchStart, switchEnd);
    const agencyLine = adminSwitch.split('\n').find(line => line.includes("tab === 'agencies'"));
    assert.ok(agencyLine);
    assert.doesNotMatch(agencyLine, /loadSalesStatistics/);
    const statisticsLine = adminSwitch.split('\n').find(line => line.includes("tab === 'statistics'"));
    assert.match(statisticsLine, /salesStatisticsOrders\.length/);
});

test('saving one new order updates the local cache without reloading the list', () => {
    const saveStart = appSource.indexOf('window.saveNewOrder =');
    const saveEnd = appSource.indexOf('\n};', saveStart) + 3;
    const saveOrder = appSource.slice(saveStart, saveEnd);
    assert.match(saveOrder, /newOrderSaveInProgress/);
    assert.match(saveOrder, /ordersCache\s*=\s*\[/);
    assert.match(saveOrder, /renderOrdersList\(\)/);
    assert.doesNotMatch(saveOrder, /loadOrdersFromCloud\(\)/);
    assert.match(saveOrder, /findPriceItemForOrder\(data\)/);
});

test('role changes cannot leave an older in-flight page in the cache', () => {
    assert.match(appSource, /const requestedRole = currentUserRole;/);
    assert.match(appSource, /requestedRole !== currentUserRole/);
    assert.match(appSource, /orderReloadRequested = true/);
    assert.match(appSource, /myQuotesReloadRequested = true/);
    const roleSwitchStart = appSource.indexOf('window.switchViewRole =');
    const roleSwitchEnd = appSource.indexOf('\n};', roleSwitchStart) + 3;
    const roleSwitch = appSource.slice(roleSwitchStart, roleSwitchEnd);
    assert.match(roleSwitch, /ordersCache = \[\]/);
    assert.match(roleSwitch, /myQuotesCache = \[\]/);
    assert.match(roleSwitch, /equipmentList = \[\]/);
    assert.match(appSource, /generation !== equipmentLoadGeneration \|\| requestedRole !== currentUserRole/);
});

test('document number generation reads only the newest matching document', () => {
    const quoteStart = appSource.indexOf('window.generateQuoteNo =');
    const quoteEnd = appSource.indexOf('\n};', quoteStart) + 3;
    const quoteGenerator = appSource.slice(quoteStart, quoteEnd);
    assert.match(quoteGenerator, /orderBy\('quoteNo', 'desc'\)/);
    assert.match(quoteGenerator, /limit\(1\)/);
    const poStart = appSource.indexOf('window.generatePoNo =');
    const poEnd = appSource.indexOf('\n};', poStart) + 3;
    const poGenerator = appSource.slice(poStart, poEnd);
    assert.match(poGenerator, /orderBy\('poNo', 'desc'\)/);
    assert.match(poGenerator, /limit\(1\)/);
    assert.match(appSource, /findPriceItemByCodeValue\(value\)/);
});

test('sales statistics uses a bounded cached query and ignores stale roles', () => {
    const start = appSource.indexOf('window.loadSalesStatistics =');
    const end = appSource.indexOf('\n};', start) + 3;
    const loader = appSource.slice(start, end);
    assert.match(loader, /if \(salesStatisticsLoadPromise\) return salesStatisticsLoadPromise/);
    assert.match(loader, /requestedRole !== currentUserRole/);
    assert.match(loader, /salesStatisticsLoadPromise = null/);
    assert.match(loader, /where\('orderDate', '>=', start\)/);
    assert.match(loader, /where\('orderDate', '<=', end\)/);
    assert.match(loader, /where\('updatedAt', '>=', startIso\)/);
    assert.match(loader, /where\('status', '==', BUSINESS_STATUS\.ACTIVE\)/);
    assert.match(loader, /limit\(1500\)/);
    assert.match(loader, /limit\(1000\)/);
    assert.doesNotMatch(loader, /collection\('orders'\)\.get\(\)/);
});

test('purchase modal chooses a company that does not silently filter every item', () => {
    const start = appSource.indexOf('function bestPurchaseOrderCompany(');
    const end = appSource.indexOf('\n}\n\nwindow.openDirectStockPurchase', start) + 2;
    assert.ok(start >= 0 && end > start);
    const context = {
        isCompanyBrandAllowed: (company, brand) => ({
            yushin: ['Roche'], morningstar: ['Qiagen'], 'MULTI-LIFE': ['Beckman']
        })[company].includes(brand)
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    assert.equal(context.bestPurchaseOrderCompany([], [{ brand: 'Qiagen' }], 'yushin'), 'morningstar');
    assert.equal(context.bestPurchaseOrderCompany([{ company: 'MULTI-LIFE' }], [{ brand: 'Beckman' }], 'yushin'), 'MULTI-LIFE');
    const dealStart = appSource.indexOf('window.markQuoteAsDeal =');
    const dealEnd = appSource.indexOf('\n};', dealStart) + 3;
    assert.match(appSource.slice(dealStart, dealEnd), /company\s*:\s*q\.company\s*\|\|\s*''/);
});

test('billing status is optimistic and ignores a rapid duplicate tap', async () => {
    const start = appSource.indexOf('window.toggleOrderStatus =');
    const end = appSource.indexOf('\n};', start) + 3;
    const order = { id: 'o1', isOrdered: true, isArrived: true, isBilled: false, statusHistory: [] };
    let updatePayload;
    const context = {
        window: {}, BUSINESS_STATUS: { ACTIVE: 'active', COMPLETED: 'completed', CANCELLED: 'cancelled', VOIDED: 'voided' }, ordersCache: [order], pendingOrderStatusKeys: new Set(), activeOrderWorkFilter: 'all',
        canEditPage: () => true, normalizedOrderStatus: () => 'normal',
        deliveryProgressInfo: () => ({ delivered: 0 }), orderInvoiceDate: () => '', localDateString: () => '2026-09-17',
        prompt: () => { throw new Error('billing must not depend on window.prompt'); }, alert: message => { throw new Error(message); },
        currentUserName: 'Tester', currentUser: null, renderOrdersList: () => {},
        currentDeliveryOrderId: null, renderDeliveryModal: () => {}, renderOrderLifecycleModal: () => {},
        firebase: { firestore: { FieldValue: { arrayUnion: (...entries) => ({ entries }) } } },
        db: {
            collection: () => ({ doc: () => ({}) }),
            runTransaction: async callback => callback({
                get: async () => ({ exists: true, data: () => ({ ...order, isBilled: false, statusHistory: [] }) }),
                update: (_ref, payload) => { updatePayload = payload; }
            })
        },
        Date
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    context.window.toggleOrderStatus('o1', 'isBilled', true);
    context.window.toggleOrderStatus('o1', 'isBilled', true);
    assert.equal(order.isBilled, true);
    assert.equal(context.pendingOrderStatusKeys.has('o1:isBilled'), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updatePayload.isBilled, true);
    assert.equal(updatePayload.invoiceDate, '2026-09-17');
    assert.equal(context.pendingOrderStatusKeys.has('o1:isBilled'), false);
});

test('failed billing write restores the previous state and unlocks the button', async () => {
    const start = appSource.indexOf('window.toggleOrderStatus =');
    const end = appSource.indexOf('\n};', start) + 3;
    const order = { id: 'o2', isOrdered: true, isArrived: true, isBilled: false, invoiceDate: '', statusHistory: [] };
    let alertMessage = '';
    const context = {
        window: {}, BUSINESS_STATUS: { ACTIVE: 'active', COMPLETED: 'completed', CANCELLED: 'cancelled', VOIDED: 'voided' }, ordersCache: [order], pendingOrderStatusKeys: new Set(), activeOrderWorkFilter: 'billing',
        canEditPage: () => true, normalizedOrderStatus: () => 'normal',
        deliveryProgressInfo: () => ({ delivered: 0 }), orderInvoiceDate: () => '', localDateString: () => '2026-09-17',
        prompt: () => '2026-09-17', alert: message => { alertMessage = message; },
        currentUserName: 'Tester', currentUser: null, renderOrdersList: () => {},
        currentDeliveryOrderId: null, renderDeliveryModal: () => {}, renderOrderLifecycleModal: () => {},
        firebase: { firestore: { FieldValue: { arrayUnion: (...entries) => ({ entries }) } } },
        db: { collection: () => ({ doc: () => ({}) }), runTransaction: async () => { throw new Error('offline'); } },
        Date
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    context.window.toggleOrderStatus('o2', 'isBilled', true);
    assert.equal(order.isBilled, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(order.isBilled, false);
    assert.equal(order.invoiceDate, '');
    assert.equal(context.activeOrderWorkFilter, 'billing');
    assert.equal(context.pendingOrderStatusKeys.has('o2:isBilled'), false);
    assert.match(alertMessage, /已還原/);
});


test('quote and order lists use global business-date ordering across companies', () => {
    assert.match(appSource, /collection\('quotes'\)\.orderBy\('quoteDate', 'desc'\)/);
    assert.match(appSource, /compareBusinessRecordsNewestFirst\(a, b, 'quoteDate', 'quoteNo'\)/);
    assert.match(appSource, /collection\('orders'\)\.orderBy\('orderDate', 'desc'\)/);
    assert.match(appSource, /compareBusinessRecordsNewestFirst\(a, b, 'orderDate', 'id'\)/);
    const compareStart = appSource.indexOf('function compareBusinessRecordsNewestFirst');
    const compareEnd = appSource.indexOf('\n}', compareStart) + 2;
    const comparator = appSource.slice(compareStart, compareEnd);
    assert.doesNotMatch(comparator, /company/);
});


test('quote and order full-history search use backend tokens and remain paginated', () => {
    assert.match(appSource, /function buildFullHistorySearchTokens/);
    assert.match(appSource, /where\('searchTokens', 'array-contains', queryToken\)/);
    assert.match(appSource, /limit\(DEFAULT_LIST_LIMIT\)/);
    assert.match(appSource, /startAfter\(orderHistorySearchCursor\)/);
    assert.match(appSource, /startAfter\(quoteHistorySearchCursor\)/);
    assert.match(appSource, /itemCodeKey: normalizeHistoryItemCode/);
    assert.match(indexSource, /搜尋全部歷史：單號 \/ 抬頭 \/ 客戶 \/ 廠牌 \/ 品項/);
    assert.match(indexSource, /搜尋全部歷史：客戶 \/ 廠牌 \/ 貨號 \/ 品名 \/ 單號/);
    const orderStart = appSource.indexOf('async function runOrderHistorySearch');
    const orderEnd = appSource.indexOf('\n}\n\nwindow.scheduleOrderHistorySearch', orderStart) + 2;
    const orderSearch = appSource.slice(orderStart, orderEnd);
    assert.doesNotMatch(orderSearch, /collection\('orders'\)\.get\(\)/);
    assert.doesNotMatch(orderSearch, /while\s*\(/);
});

test('browser history restores internal pages without forcing Firestore reloads', () => {
    assert.match(appSource, /history\.pushState/);
    assert.match(appSource, /addEventListener\('popstate'/);
    assert.match(appSource, /skipReload: true/);
    assert.match(appSource, /window\.scrollTo/);
    const mainStart = appSource.indexOf('window.switchMainTab =');
    const mainEnd = appSource.indexOf('// 「檢視身份」切換', mainStart);
    assert.match(appSource.slice(mainStart, mainEnd), /pushAppNavigationState/);
    const quoteStart = appSource.indexOf('window.switchQuoteView =');
    const quoteEnd = appSource.indexOf('\n};', quoteStart) + 3;
    assert.match(appSource.slice(quoteStart, quoteEnd), /skipHistory/);
    const orderStart = appSource.indexOf('window.switchOrderView =');
    const orderEnd = appSource.indexOf('\n};', orderStart) + 3;
    assert.match(appSource.slice(orderStart, orderEnd), /skipHistory/);
});


test('quote print pagination measures rendered rows and keeps rows/footer intact', () => {
    assert.match(appSource, /function markQuotePrintPagination\(\)/);
    assert.match(appSource, /getBoundingClientRect\(\)\.height/);
    assert.match(appSource, /quote-print-page-break/);
    assert.match(appSource, /markQuotePrintPagination\(\)/);
    assert.match(cssSource, /#quoteItems tr\.quote-print-page-break/);
    assert.match(cssSource, /thead \{ display: table-header-group; \}/);
    assert.match(cssSource, /#printableQuote \.bottom-layout/);
});


test('quote and order search-index migration is admin-only batched and idempotent', () => {
    const start = appSource.indexOf('window.backfillOrderSearchIndex =');
    const end = appSource.indexOf('\n};', start) + 3;
    const migration = appSource.slice(start, end);
    assert.match(migration, /trueUserRole !== 'admin'/);
    assert.match(migration, /currentUserRole !== 'admin'/);
    assert.match(migration, /\['quotes','orders'\]/);
    assert.match(migration, /limit\(200\)/);
    assert.match(migration, /startAfter\(cursor\)/);
    assert.match(migration, /buildFullHistorySearchTokens/);
    assert.match(migration, /data\.itemCodeKey !== normalized/);
    assert.match(migration, /batch\.update/);
    assert.match(migration, /orderSearchIndexAwaitingConfirmation/);
    assert.match(migration, /請在 10 秒內再按一次確認開始/);
    assert.doesNotMatch(migration, /confirm\(/);
    assert.doesNotMatch(migration, /collection\('orders'\)\.get\(\)/);
});


test('new quotes and orders persist createdAt and normalized order item-code keys', () => {
    const saveOrderStart = appSource.indexOf('window.saveNewOrder =');
    const saveOrderEnd = appSource.indexOf('\n};', saveOrderStart) + 3;
    const saveOrder = appSource.slice(saveOrderStart, saveOrderEnd);
    assert.match(saveOrder, /createdAt: new Date\(\)\.toISOString\(\)/);
    assert.match(saveOrder, /itemCodeKey: normalizeHistoryItemCode\(itemCode\)/);
    assert.match(saveOrder, /buildFullHistorySearchTokens\('order', data\)/);

    const quoteStart = appSource.indexOf('window.handleSaveAndPrint =');
    const quoteEnd = appSource.indexOf('\n};', quoteStart) + 3;
    const quoteSave = appSource.slice(quoteStart, quoteEnd);
    assert.match(quoteSave, /createdAt: new Date\(\)\.toISOString\(\)/);
    assert.match(quoteSave, /buildFullHistorySearchTokens\('quote', quoteData\)/);

    const dealStart = appSource.indexOf('window.markQuoteAsDeal =');
    const dealEnd = appSource.indexOf('\n};', dealStart) + 3;
    const deal = appSource.slice(dealStart, dealEnd);
    assert.match(deal, /createdAt\s*:\s*new Date\(\)\.toISOString\(\)/);
    assert.match(deal, /itemCodeKey:\s*normalizeHistoryItemCode/);
});


test('phase 2 product master keeps the existing price catalog as a compatibility source and overlays formal products', () => {
    assert.match(appSource, /function stableProductId\(item\)/);
    assert.match(appSource, /function normalizeProductMasterItem\(item\)/);
    assert.match(appSource, /productId:/);
    assert.match(appSource, /inventoryTracked:/);
    assert.match(appSource, /lotTracked:/);
    assert.match(appSource, /expiryTracked:/);
    assert.match(appSource, /supplier:/);
    assert.match(appSource, /unit:/);
    assert.match(appSource, /spec:/);
    assert.match(appSource, /normalizeProductMasterList\(imported/);
    assert.match(appSource, /collection\('products'\)/);
    assert.match(appSource, /舊 settings\/prices 暫時保留做過渡來源/);
});


test('phase 2 documents link to productId while retaining historical snapshots', () => {
    assert.match(appSource, /class="item-product-id"/);
    assert.match(appSource, /productId: row\.querySelector\('\.item-product-id'\)/);
    assert.match(appSource, /data\.productId = priceMatch\.productId/);
    assert.match(appSource, /productId:item\.productId\|\|priceMatch\?\.productId/);
    assert.match(appSource, /data\.supplier = priceMatch\.supplier/);
    assert.match(appSource, /data\.spec = priceMatch\.spec/);
});

test('phase 2 product-master Excel import supports enrichment fields and preview', () => {
    assert.match(appSource, /Product Master 匯入預覽/);
    assert.match(appSource, /confirmProductMasterImport\(brandGroups\)/);
    for (const field of ['供應商', '單位', '庫存管理', '批號管理', '效期管理', '啟用']) {
        assert.ok(appSource.includes(field), `missing import field: ${field}`);
    }
});


test('phase 3 defines a flexible common document relationship layer', () => {
    assert.match(appSource, /const DOCUMENT_TYPES = Object\.freeze/);
    assert.match(appSource, /function documentLink\(type, id, relation/);
    assert.match(appSource, /function normalizeDocumentLinks\(links\)/);
    assert.match(appSource, /function linkedDocumentFields\(sourceType = '', sourceId = '', links = \[\]\)/);
    assert.match(appSource, /sourceType:/);
    assert.match(appSource, /sourceId:/);
    assert.match(appSource, /linkedDocuments:/);
});

test('phase 3 links quote to orders and orders to purchase orders in both directions', () => {
    const dealStart = appSource.indexOf('window.markQuoteAsDeal =');
    const dealEnd = appSource.indexOf('window.unmarkQuoteAsDeal', dealStart);
    const deal = appSource.slice(dealStart, dealEnd);
    assert.match(deal, /DOCUMENT_TYPES\.QUOTE/);
    assert.match(deal, /linkedDocuments/);
    assert.match(deal, /DOCUMENT_TYPES\.ORDER/);

    const poStart = appSource.indexOf('window.printPurchaseOrder =');
    const poEnd = appSource.indexOf("window.addEventListener('afterprint'", poStart);
    const po = appSource.slice(poStart, poEnd);
    assert.match(po, /linkedDocumentFields/);
    assert.match(po, /DOCUMENT_TYPES\.PURCHASE_ORDER/);
    assert.match(po, /linkedDocuments: normalizeDocumentLinks/);
});

test('phase 3 preserves legacy links and cancels generated orders instead of hard deleting them', () => {
    assert.match(appSource, /function legacyDocumentLinks\(record, type\)/);
    const start = appSource.indexOf('window.unmarkQuoteAsDeal =');
   const end = appSource.indexOf('/* =========================================================\n   訂單管理系統', start);
    const source = appSource.slice(start, end);
    assert.match(source, /status: 'cancelled'/);
    assert.match(source, /cancelReason: '來源估價單取消成交'/);
    assert.doesNotMatch(source, /batch\.delete/);
});


test('phase 4 forecast is lightweight, paginated and has no expected-close-date requirement', () => {
    assert.match(appSource, /db\.collection\('forecasts'\)/);
    assert.match(appSource, /orderBy\('updatedAt', 'desc'\)/);
    assert.match(appSource, /limit\(DEFAULT_LIST_LIMIT\)/);
    assert.match(appSource, /where\('ownerUid', '==', currentUser/);
    assert.match(appSource, /latestProgress:/);
    const forecastStart = appSource.indexOf('let forecastCache =');
    const forecastEnd = appSource.indexOf('估價單系統', forecastStart);
    assert.doesNotMatch(appSource.slice(forecastStart, forecastEnd), /expectedClose|closeDate|預計成交日期/);
});

test('phase 4 supports forecast manual edit, quote conversion, order conversion and quote-origin creation', () => {
    for (const fn of ['saveForecast', 'createQuoteFromForecast', 'createOrderFromForecast', 'createForecastFromQuote']) {
        assert.ok(appSource.includes(fn), 'missing '+fn);
    }
    assert.match(appSource, /DOCUMENT_TYPES\.FORECAST/);
    assert.match(appSource, /FieldValue\.arrayUnion\(documentLink\(DOCUMENT_TYPES\.QUOTE/);
    assert.match(appSource, /FieldValue\.arrayUnion\(documentLink\(DOCUMENT_TYPES\.ORDER/);
});

test('phase 4 forecast permission is integrated into the common permission system', () => {
    assert.match(appSource, /key: 'forecast'/);
    assert.match(appSource, /'forecast-system':'forecast'/);
    assert.match(appSource, /canViewAllData\('forecast'\)/);
    assert.match(appSource, /canEditPage\('forecast'\)/);
});


test('phase 5 inventory uses on-hand reserved available incoming and transaction-backed movements', () => {
    assert.match(appSource, /function inventoryNumbers\(data = \{\}\)/);
    assert.match(appSource, /available: onHand - reserved/);
    assert.match(appSource, /incoming/);
    assert.match(appSource, /collection\('inventoryMovements'\)/);
    assert.match(appSource, /inventoryMovementRecord\([\s\S]*?'reserve'/);
    assert.match(appSource, /'ship'/);
});

test('phase 5 order creation reserves only available stock and records shortage', () => {
    const start=appSource.indexOf('async function reserveSingleOrderItem');
    const end=appSource.indexOf('async function reserveInventoryForNewOrder',start);
    const s=appSource.slice(start,end);
    assert.match(s,/Math\.min\(requested,warehouse\.available,aggregate\.available\)/);
    assert.match(s,/inventoryReservedQty/);
    assert.match(s,/inventoryShortageQty/);
    assert.match(appSource,/await reserveInventoryForNewOrder\(docRef\.id, data\)/);
});

test('phase 5 shipment consumes both aggregate and selected warehouse stock transactionally', () => {
    const start=appSource.indexOf('async function applyInventoryDeliveryDeltaInTransaction');
    const end=appSource.indexOf('function applyInventoryDeliveryInTransaction',start);
    const s=appSource.slice(start,end);
    assert.match(s,/warehouseId/);
    assert.match(s,/warehouseStocks/);
    assert.match(s,/onHand:\s*inv\.onHand\s*-\s*deltaQty/);
    assert.match(s,/onHand:\s*wh\.onHand\s*-\s*deltaQty/);
    assert.match(s,/reserved:\s*Math\.max\(0,\s*inv\.reserved\s*\+\s*reservedDelta\)/);
    assert.match(s,/'ship'/);
});

test('phase 5 cancelling and restoring orders adjusts reservations without deleting inventory history', () => {
    const start=appSource.indexOf('async function adjustInventoryReservationForLifecycle');
    const end=appSource.indexOf('window.quickSetOrderLifecycle',start);
    const s=appSource.slice(start,end);
    assert.match(s,/nextStatus === 'cancelled'/);
    assert.match(s,/order_restored/);
    assert.match(s,/inventoryMovementRecord\([\s\S]*?'release'/);
    assert.doesNotMatch(s,/\.delete\(/);
});


test('phase 6 purchase orders create incoming or pending items without increasing on-hand', () => {
    const start=appSource.indexOf('async function registerPurchaseIncoming');
    const end=appSource.indexOf('window.receivePurchaseOrder',start);
    const s=appSource.slice(start,end);
    assert.match(s,/incoming:Math\.max\(0,inv\.incoming\+delta\)/);
    assert.match(s,/warehouseStocks/);
    assert.doesNotMatch(s,/onHand:inv\.onHand\+delta/);
    assert.match(s,/pendingInventoryItems/);
    assert.match(s,/purchase_incoming/);
});

test('phase 6 receipt transaction decreases incoming and increases on-hand with partial receipts', () => {
    const start=appSource.indexOf('window.receivePurchaseOrder');
    const end=appSource.indexOf('function purchaseItemsFromSavedPo',start);
    const s=appSource.slice(start,end);
    assert.match(s,/onHand:\s*stock\.onHand\s*\+\s*qty/);
    assert.match(s,/incoming:\s*Math\.max\(0,\s*stock\.incoming\s*-\s*qty\)/);
    assert.match(s,/receiptRecords/);
    assert.match(s,/receiptStatus/);
    assert.match(s,/type:\s*'receipt'/);
    assert.match(s,/pendingInventoryItems/);
    assert.match(s,/inventoryShortageQty/);
});

test('phase 6 supports direct stock purchase independent of customer orders and new Product Master items', () => {
    const start=appSource.indexOf('window.openDirectStockPurchase');
    const end=appSource.indexOf('window.openPurchaseOrderModal',start);
    const s=appSource.slice(start,end);
    assert.match(s,/orderId:\s*''/);
    assert.match(s,/ensurePriceListLoaded/);
    assert.match(s,/addDirectPoItem/);
    assert.match(s,/poDirectStockMode = true/);
    assert.match(s,/generateNextPoNumber/);
});


test('phase 7 inventory provides ledger lots expiry FEFO and controlled adjustments',()=>{
 assert.match(appSource,/function fefoLots\(stock\)/);assert.match(appSource,/function lotStatus\(lot\)/);
 assert.match(appSource,/30天內/);assert.match(appSource,/60天內/);assert.match(appSource,/90天內/);
 assert.match(appSource,/inventoryMovements/);assert.match(indexSource,/value="initial"/);assert.match(indexSource,/value="adjustment"/);assert.match(indexSource,/value="scrap"/);
 assert.match(appSource,/orderBy\('updatedAt','desc'\)\.limit\(DEFAULT_LIST_LIMIT\)/);
 assert.match(appSource,/orderBy\('createdAt','desc'\)\.limit\(DEFAULT_LIST_LIMIT\)/);
});


test('phase 8 adds warehouse to UI permission architecture',()=>{assert.match(appSource,/warehouse: '倉管'/);assert.match(appSource,/key: 'inventory'/);});


test('phase 9 analysis separates actual receipts sales stock value incoming and purchase-sales difference',()=>{
 assert.match(appSource,/function inventoryAnalysisTotals\(start,end\)/);
 assert.match(appSource,/where\('type','==','receipt'\)/);
 assert.match(appSource,/difference:\s*sales\s*-\s*purchase/);
 assert.match(appSource,/stockValue/);assert.match(appSource,/incoming/);
 assert.match(appSource,/limit\(1000\)/);
});
test('phase 8 permission editor includes warehouse role',()=>{assert.match(appSource,/\['sales', 'purchaser', 'warehouse', 'engineer', 'admin'\]/);});


test('phase 10 keeps inventory analysis queries bounded and server-filtered',()=>{
 assert.match(appSource,/where\('type','==','receipt'\)/);
 assert.match(appSource,/inventoryMovements[\s\S]{0,300}limit\(1000\)/);
 assert.doesNotMatch(appSource,/collection\('inventoryMovements'\)\.get\(\)/);
});
test('phase 10 role model consistently documents warehouse',()=>{
 assert.match(appSource,/admin' \/ 'sales' \/ 'purchaser' \/ 'warehouse' \/ 'engineer'/);
});


test('system unification uses a shared Brand Master compatibility layer', () => {
    assert.match(appSource, /function getUnifiedBrandEntries/);
    assert.match(appSource, /function resolveBrandName/);
    assert.match(appSource, /function loadBrandMaster/);
    assert.match(appSource, /syncLegacyBrandSettingsToMaster/);
    assert.match(appSource, /getUnifiedBrandNames/);
});

test('Brand Master compatibility removal is guarded by a read-only full-source audit', () => {
    assert.match(indexSource, /id="brandMasterAuditBtn"/);
    assert.match(indexSource, /onclick="previewBrandMasterCompatibilityAudit\(\)"/);
    assert.match(appSource, /function buildBrandMasterCompatibilityAudit/);
    assert.match(appSource, /canRemoveCompatibilityLayer/);
    assert.match(appSource, /const historicalCollections = \['orders', 'quotes', 'forecasts', 'equipment'\]/);
    const audit = appSource.slice(
        appSource.indexOf('window.previewBrandMasterCompatibilityAudit'),
        appSource.indexOf('function normalizeThermoBrandList')
    );
    assert.match(audit, /readCollectionForMigration\('products'\)/);
    assert.doesNotMatch(audit, /\.set\(|\.update\(|\.delete\(|db\.batch\(/);
});

test('Forecast brand entry accepts known brands and free-input new brands', () => {
    assert.match(appSource, /forecastBrandList/);
    assert.match(appSource, /populateForecastBrandDropdown/);
    assert.match(appSource, /input\.value = selected \|\| ''/);
});

test('new business records persist stable salesCode while keeping legacy owner fields', () => {
    assert.match(appSource, /salesCode:\s*currentUserCode/);
    assert.match(appSource, /function salesCodeForName/);
    assert.match(appSource, /function belongsToCurrentUser\(salesName, ownerUid, salesCode/);
    assert.match(appSource, /collection\('salesCodes'\)/);
});

test('sales handoff changes the sales-code holder instead of rewriting historical sales names', () => {
    const start = appSource.indexOf('window.executeSalesTransfer =');
    const end = appSource.indexOf('// 依 Firestore batch 500 筆上限', start);
    const s = appSource.slice(start, end);
    assert.match(s, /salesCodes/);
    assert.match(s, /handoffHistory/);
    assert.match(s, /backfillSalesCodeForLegacyRecords/);
    assert.doesNotMatch(s, /\{\s*salesName:\s*toName\s*\}/);
});

test('inventory reservation is traceable to occupying orders', () => {
    assert.match(appSource, /inventoryReservations/);
    assert.match(appSource, /openInventoryReservationDetails/);
    assert.match(appSource, /inventoryReservedQty/);
    assert.match(appSource, /inventoryShortageQty/);
});

test('unknown order items do not create inventory before purchase receipt', () => {
    const start = appSource.indexOf('async function reserveSingleOrderItem');
    const end = appSource.indexOf('async function reserveInventoryForNewOrder', start);
    const s = appSource.slice(start, end);
    assert.match(s, /warehouseSnap\?\.exists/);
    assert.match(s, /const shortage\s*=\s*Math\.max\(0,\s*requested\s*-\s*reservable\)/);
    assert.doesNotMatch(s, /tx\.set\(warehouseRef[\s\S]*?onHand/);
});

test('period semantics are shared across Forecast Quote Order and PO', () => {
    assert.match(appSource, /function unifiedPeriodRange/);
    assert.match(appSource, /function dateInUnifiedPeriod/);
    assert.match(appSource, /forecastPeriodFilter/);
    assert.match(appSource, /myQuotePeriodFilter/);
    assert.match(appSource, /poPeriodFilter/);
    assert.match(appSource, /this-month/);
    assert.match(appSource, /this-quarter/);
});

test('permission routing includes Product Forecast and Inventory workspaces', () => {
    const start = appSource.indexOf('function getActivePermissionPage');
    const end = appSource.indexOf('function applyPermissionVisibility', start);
    const s = appSource.slice(start, end);
    assert.match(s, /forecast-system/);
    assert.match(s, /product-system/);
    assert.match(s, /inventory-system/);
    assert.match(appSource, /function firstAccessibleMainPage\(\)[\s\S]*?\['quote', 'forecast', 'products', 'orders', 'inventory', 'equipment'\]/);
});


test('shared Customer Master and order unit are persisted in the unified workflow', () => {
    assert.match(appSource, /function customerIdForName/);
    assert.match(appSource, /function syncCustomerMaster/);
    assert.match(appSource, /customerId:/);
    assert.match(appSource, /document\.getElementById\('orderUnit'\)/);
    assert.match(indexSource, /id="orderUnit"/);
});

test('inventory UI exposes reservation and pending-item detail without duplicate HTML ids', () => {
    assert.match(indexSource, /id="inventoryReservationOverlay"/);
    assert.match(indexSource, /id="pendingInventoryBody"/);
    const ids = [...indexSource.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], []);
});

test('Firestore rules deny unspecified collections and enforce sales-code ownership', () => {
    assert.match(rulesSource, /function owns\(data\)/);
    assert.match(rulesSource, /match \/forecasts\/\{forecastId\}\/progress\/\{progressId\}/);
    assert.match(rulesSource, /businessInventoryOperationalUpdate/);
    assert.match(rulesSource, /match \/\{document=\*\*\}/);
    assert.match(rulesSource, /allow read, write: if false/);
    assert.doesNotMatch(rulesSource, /match \/\{document=\*\*\}[\s\S]*allow read: if signedIn/);
});

test('all major product-entry screens put item code before downstream product fields', () => {
    const orderCode = indexSource.indexOf('id="orderItemCode"');
    const orderName = indexSource.indexOf('id="orderItemName"');
    const orderBrand = indexSource.indexOf('id="orderBrand"');
    assert.ok(orderCode >= 0 && orderName > orderCode && orderBrand > orderName);

    const quoteRowStart = appSource.indexOf('window.addQuoteRow');
    const quoteRowEnd = appSource.indexOf('window.deleteQuoteRow', quoteRowStart);
    const quoteRow = appSource.slice(quoteRowStart, quoteRowEnd);
    assert.ok(quoteRow.indexOf('class="item-model"') >= 0);
    assert.ok(quoteRow.indexOf('class="item-model"') < quoteRow.indexOf('class="item-cn"'));
});


test('phase 14 canonical lifecycle statuses preserve cancellation semantics without hard delete', () => {
    assert.match(appSource, /const BUSINESS_STATUS = Object\.freeze/);
    assert.match(appSource, /ACTIVE: 'active'/);
    assert.match(appSource, /COMPLETED: 'completed'/);
    assert.match(appSource, /CANCELLED: 'cancelled'/);
    assert.match(appSource, /VOIDED: 'voided'/);
    const lifecycleStart = appSource.indexOf('window.quickSetOrderLifecycle =');
    const lifecycleEnd = appSource.indexOf('window.toggleOrderProgressStatus', lifecycleStart);
    const lifecycle = appSource.slice(lifecycleStart, lifecycleEnd);
    assert.match(lifecycle, /status: nextStatus === 'cancelled' \? BUSINESS_STATUS\.CANCELLED : BUSINESS_STATUS\.ACTIVE/);
    assert.doesNotMatch(lifecycle, /db\.collection\([^\n]+\)\.doc\([^\n]+\)\.delete\(/);
});

test('phase 15 quotes orders and purchase orders persist explicit currency tax and tax-basis metadata', () => {
    assert.match(appSource, /const DEFAULT_CURRENCY = 'TWD'/);
    assert.match(appSource, /const DEFAULT_TAX_RATE = 0\.05/);
    assert.match(appSource, /function grossAmountMetadata/);
    assert.match(appSource, /function netAmountMetadata/);
    assert.match(appSource, /priceIncludesTax: true/);
    assert.match(appSource, /priceIncludesTax: false/);
    assert.match(appSource, /subtotalExTax/);
    assert.match(appSource, /taxAmount/);
    assert.match(appSource, /totalIncTax/);
});

test('phase 16 inventory analysis uses protected lot costs without copying cost into operational inventory', () => {
    const start = appSource.indexOf('function inventoryAnalysisTotals');
    const end = appSource.indexOf('function renderInventoryAnalysisSummary', start);
    const source = appSource.slice(start, end);
    assert.match(appSource, /db\.collection\('inventoryLotCosts'\)\.limit\(1000\)/);
    assert.match(source, /inventoryAnalysisLotCosts\.get\(receipt\.lotId\)/);
    assert.match(source, /inventoryAnalysisLotCosts\.get\(lot\.id\)/);
    assert.doesNotMatch(source, /receipt\.unitCost|receipt\.purchaseNetAmount|stock\.unitCost/);
});

test('phase 17 Forecast PO and Inventory provide mobile data labels and card layout', () => {
    assert.match(appSource, /data-th="客戶"/);
    assert.match(appSource, /data-th="到貨進度"/);
    assert.match(appSource, /data-th="可用庫存"/);
    assert.match(cssSource, /Phase 17：Forecast／採購／庫存手機版一致化/);
    assert.match(cssSource, /#forecastTable td\[data-th\]::before/);
    assert.match(cssSource, /#poListPanel table td\[data-th\]::before/);
    assert.match(cssSource, /#inventory-system td\[data-th\]::before/);
});

test('phase 18 statistics avoid all-history downloads and important writes stamp updatedAt', () => {
    const start = appSource.indexOf('window.loadSalesStatistics =');
    const end = appSource.indexOf('\n};', start) + 3;
    const loader = appSource.slice(start, end);
    assert.match(loader, /Promise\.all\(\[periodOrders, activityOrders, openOrders\]\)/);
    assert.match(loader, /\.limit\(1500\)/);
    assert.match(loader, /\.limit\(1000\)/);
    assert.doesNotMatch(loader, /db\.collection\('orders'\)\.get\(\)/);
    assert.match(appSource, /updatedAt: timestamp/);
    assert.match(appSource, /updatedAt: history\.at/);
});

test('phase 19 Firestore rules enforce role boundaries for PO inventory reservations and equipment', () => {
    assert.match(rulesSource, /match \/purchaseOrders\/\{id\}/);
    assert.match(rulesSource, /allow read: if admin\(\) \|\| purchaser\(\) \|\| warehouse\(\)/);
    assert.match(rulesSource, /match \/inventoryReservations\/\{id\}/);
    assert.match(rulesSource, /businessOwner\(\) && owns\(resource\.data\)/);
    assert.match(rulesSource, /match \/equipment\/\{id\}/);
    assert.match(rulesSource, /admin\(\) \|\| engineer\(\) \|\| \(businessOwner\(\) && owns\(resource\.data\)\)/);
    assert.match(rulesSource, /allow read, write: if false/);
});

test('phase 20 core workflow contracts are all represented in regression coverage', () => {
    const required = [
        'forecasts', 'quotes', 'orders', 'purchaseOrders', 'inventoryReservations',
        'pendingInventoryItems', 'inventoryMovements', 'salesCodes', 'brands', 'customers'
    ];
    required.forEach(name => assert.match(appSource, new RegExp(name)));
    assert.match(appSource, /reserveInventoryForNewOrder/);
    assert.match(appSource, /registerPurchaseIncoming/);
    assert.match(appSource, /receivePurchaseOrder/);
    assert.match(appSource, /applyInventoryDeliveryInTransaction/);
    assert.match(appSource, /syncLegacyBrandSettingsToMaster/);
    assert.match(appSource, /executeSalesTransfer/);
});


test('forecast quote-origin keeps line-item snapshots for later order splitting', () => {
    const start = appSource.indexOf('window.createForecastFromQuote');
    const end = appSource.indexOf('window.markQuoteAsDeal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /items:\s*items\.map/);
    assert.match(s, /model:\s*item\.model/);
    assert.match(s, /qty:\s*Number\(item\.qty/);
    assert.match(s, /subtotal:\s*parseMoney\(item\.subtotal\)/);
});

test('forecast to order supports one-item prefill and multi-item split', () => {
    assert.match(appSource, /async function forecastOrderItems/);
    assert.match(appSource, /function forecastItemToOrderSource/);
    assert.match(appSource, /async function createForecastOrdersDirectly/);
    const start = appSource.indexOf('window.createOrderFromForecast');
    const end = appSource.indexOf('估價單系統', start);
    const s = appSource.slice(start, end);
    assert.match(s, /items\.length === 1/);
    assert.match(s, /openOrderModal\(forecastItemToOrderSource/);
    assert.match(s, /createForecastOrdersDirectly\(forecast, items\)/);
});

test('order modal accepts Forecast source data and uses the actual source-link fields', () => {
    const start = appSource.indexOf('window.openOrderModal = function');
    const end = appSource.indexOf('function populateOrderCustomerSuggestions', start);
    const s = appSource.slice(start, end);
    assert.match(s, /function\(source = null\)/);
    assert.match(s, /orderItemCode/);
    assert.match(s, /orderItemName/);
    assert.match(s, /orderQty/);
    assert.match(s, /orderUnitPrice/);
    assert.match(s, /_orderModalSourceLink/);
    assert.match(s, /_orderModalProductId/);
});

test('Forecast edit hides workflow fields and history is available from the main list', () => {
    assert.match(indexSource, /id="forecastWorkflowSection"/);
    assert.match(indexSource, /id="forecastHistoryOverlay"/);
    assert.match(indexSource, /id="forecastHistoryBody"/);
    assert.match(appSource, /openForecastHistoryModal/);
    assert.match(appSource, />紀錄<\/button>/);
    const start = appSource.indexOf('window.openForecastModal');
    const end = appSource.indexOf('window.closeForecastModal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /workflowSection\.style\.display = 'none'/);
    assert.match(s, /currentProgressSection\.style\.display = 'none'/);
});

test('Forecast basic edits preserve Stage and status for the progress workflow', () => {
    const start = appSource.indexOf('window.saveForecast');
    const end = appSource.indexOf('window.openForecastProgressModal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /existing\?\.stage/);
    assert.match(s, /existing\?\.status/);
    assert.match(s, /基本資料更新/);
});


test('quote item-code auto-fill waits for Product Master and reacts while typing', () => {
    assert.match(appSource, /function findPriceItemByCodeValue/);
    assert.match(appSource, /function applyQuoteProductMatch/);
    assert.match(appSource, /window\.onItemModelInput/);
    assert.match(appSource, /await ensurePriceListLoaded\(\)/);
    assert.match(appSource, /oninput="onItemModelInput\(this\)"/);
});

test('quote item-code auto-fill fills product identity brand and current price', () => {
    const start = appSource.indexOf('function applyQuoteProductMatch');
    const end = appSource.indexOf('let quoteModelInputTimer', start);
    const s = appSource.slice(start, end);
    assert.match(s, /item-en/);
    assert.match(s, /item-cn/);
    assert.match(s, /item-model/);
    assert.match(s, /selectBrandInDropdown/);
    assert.match(s, /item-product-id/);
    assert.match(s, /inc-price/);
    assert.match(s, /onIncPriceChange/);
});

test('quote product lookup tolerates harmless item-code punctuation only when unique', () => {
    const start = appSource.indexOf('function findPriceItemByCodeValue');
    const end = appSource.indexOf('function applyQuoteProductMatch', start);
    const s = appSource.slice(start, end);
    assert.match(s, /normalizeItemCodeLoose/);
    assert.match(s, /candidates\.length === 1/);
});


test('order item-code autofill waits for Product Master and fills sale/cost fields', () => {
    const start = appSource.indexOf('window.onOrderItemCodeChange');
    const end = appSource.indexOf('function loadClientHistory', start);
    const s = appSource.slice(start, end);
    assert.match(s, /await ensurePriceListLoaded/);
    assert.match(s, /findPriceItemByCodeValue/);
    assert.match(s, /orderItemName/);
    assert.match(s, /orderUnitPrice/);
    assert.match(s, /applyOrderProductCost/);
    assert.match(s, /_orderModalProductId/);
    assert.match(s, /onOrderItemCodeInput/);
});

test('direct stock purchase uses the formal PO modal and supports batch items', () => {
    const start = appSource.indexOf('window.openDirectStockPurchase');
    const end = appSource.indexOf('window.openPurchaseOrderModal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /poDirectStockMode = true/);
    assert.match(s, /addDirectPoItem/);
    assert.match(s, /generateNextPoNumber/);
    assert.match(s, /poModalOverlay/);
    assert.match(appSource, /purchaseType: poItems\.every\(item => !item\.orderId\) \? 'stock' : 'order'/);
});

test('PO receiving is a batch modal with partial quantity lot and expiry', () => {
    assert.match(indexSource, /id="poReceiptBatchOverlay"/);
    assert.match(indexSource, /id="poReceiptBatchBody"/);
    assert.match(appSource, /window\.savePoReceiptBatch/);
    assert.match(appSource, /receiveSinglePoLine/);
    assert.match(appSource, /lotNo/);
    assert.match(appSource, /expiryDate/);
});

test('manual inventory changes support batch rows instead of browser prompts', () => {
    assert.match(indexSource, /id="inventoryAdjustmentOverlay"/);
    assert.match(indexSource, /id="inventoryAdjustmentRows"/);
    assert.match(appSource, /window\.addInventoryAdjustmentRow/);
    assert.match(appSource, /window\.saveInventoryAdjustmentBatch/);
    const start = appSource.indexOf('window.openInventoryAdjustment');
    const end = appSource.indexOf('function inventoryProductKey', start);
    const s = appSource.slice(start, end);
    assert.doesNotMatch(s, /prompt\('貨號'/);
});


test('Product Master v2 overlays products on top of the legacy price list', () => {
    assert.match(appSource, /function loadProductMasterOverlay/);
    assert.match(appSource, /db\.collection\('products'\)\.limit\(500\)/);
    assert.match(appSource, /await loadProductMasterOverlay\(\)/);
    assert.match(appSource, /productMasterDocToPriceItem/);
    assert.match(appSource, /const merged = new Map\(priceList/);
});

test('Product Master v2 keeps authorization separate from the legacy productType category', () => {
    assert.match(appSource, /authorizationTypeForProduct/);
    assert.match(appSource, /authorizationType/);
    assert.match(appSource, /productType: data\.category \|\| data\.productType/);
});

test('quick product creation is temporary, duplicate-safe and can be used from quote or order', () => {
    assert.match(appSource, /window\.openQuickProductCreate/);
    assert.match(appSource, /window\.saveQuickProduct/);
    assert.match(appSource, /status: 'TEMPORARY'/);
    assert.match(appSource, /normalizedPartNo/);
    assert.match(appSource, /where\('normalizedPartNo', '==', normalizedPartNo\)/);
    assert.match(appSource, /showQuickProductButton\(input, 'quote'\)/);
    assert.match(appSource, /showQuickProductButton\(input, 'order'\)/);
});

test('sales cost visibility depends on authorizationType and secure productCosts', () => {
    assert.match(appSource, /function loadVisibleProductCost/);
    assert.match(appSource, /hasBusinessCapability\(\) && authType === 'AUTHORIZED'/);
    assert.match(appSource, /db\.collection\('productCosts'\)\.doc\(productId\)/);
    assert.match(appSource, /salesVisible !== true/);
    assert.match(appSource, /applyOrderProductCost/);
});

test('sales can enter transaction cost only for non-authorized products', () => {
    const start = appSource.indexOf('window.saveNewOrder');
    const end = appSource.indexOf('function loadOrdersFromCloud', start);
    const source = appSource.slice(start, end);
    assert.match(source, /authorizationTypeForProduct\(selectedProduct\) === 'NON_AUTHORIZED'/);
    assert.match(source, /NON_AUTHORIZED/);
});

test('Firestore rules separate product data from costs and protect authorized costs', () => {
    assert.match(rulesSource, /match \/productCosts\/\{id\}/);
    assert.match(rulesSource, /assignedProductLine\(resource\.data\)/);
    assert.match(rulesSource, /match \/productLines\/\{id\}/);
    assert.match(rulesSource, /assignedProductLine\(request\.resource\.data\)/);
    assert.match(rulesSource, /allow update: if admin\(\) \|\| purchaser\(\)/);
});


test('Product Master migration safely moves legacy price data and sanitizes old cost fields', () => {
    assert.match(appSource, /window\.previewProductMasterMigration/);
    assert.match(appSource, /window\.runProductMasterMigration/);
    assert.match(appSource, /function legacyPriceItemWithoutCost/);
    assert.match(appSource, /function productMasterRecordFromLegacyItem/);
    assert.match(appSource, /function legacyCostRecord/);
    assert.match(appSource, /productMasterMigrationVersion: 2/);
    assert.match(appSource, /productMasterMigratedAt/);
    assert.match(appSource, /delete clean\.cost/);
    assert.match(appSource, /db\.collection\('products'\)/);
    assert.match(appSource, /db\.collection\('productCosts'\)/);
});

test('new Excel imports no longer persist costs into legacy settings price documents', () => {
    const start = appSource.indexOf('async function savePriceBrandList');
    const end = appSource.indexOf('let pendingPriceImportPreview', start);
    const source = appSource.slice(start, end);
    assert.match(source, /const publicItems = normalizedItems\.map\(legacyPriceItemWithoutCost\)/);
    assert.match(source, /chunkPriceItems\(publicItems/);
    assert.match(source, /syncImportedBrandToFormalProductMaster/);
});

test('database backup includes formal Product Master and cost collections', () => {
    assert.match(appSource, /'products'/);
    assert.match(appSource, /'productCosts'/);
    assert.match(appSource, /'brands'/);
});

test('Product Master admin UI uses direct Excel upload without the legacy migration panel', () => {
    assert.doesNotMatch(indexSource, /Product Master v2 遷移/);
    assert.doesNotMatch(indexSource, /id="productMasterMigrationPreviewBtn"/);
    assert.match(indexSource, /上傳 Excel 更新 Product Master/);
});


test('Phase 2-6 completion integrates supplier mapping, warehouses and direct ship', () => {
    assert.match(appSource, /db\.collection\('suppliers'\)/);
    assert.match(appSource, /db\.collection\('brandSupplierMappings'\)/);
    assert.match(appSource, /db\.collection\('warehouses'\)/);
    assert.match(appSource, /db\.collection\('warehouseStocks'\)/);
    assert.match(appSource, /function supplierForProduct/);
    assert.match(appSource, /function defaultWarehouse/);
    assert.match(appSource, /DIRECT_SHIP/);
    assert.match(appSource, /WAREHOUSE/);
});

test('Phase 2-6 direct ship bypasses inventory reservation, incoming and receiving', () => {
    const reserveStart = appSource.indexOf('async function reserveSingleOrderItem');
    const reserveEnd = appSource.indexOf('async function reserveInventoryForNewOrder', reserveStart);
    const reserve = appSource.slice(reserveStart, reserveEnd);
    assert.match(reserve, /fulfillmentType\|\|'WAREHOUSE'\)===\'DIRECT_SHIP\'/);
    assert.match(reserve, /inventoryReservedQty\s*:\s*0/);
    assert.match(reserve, /warehouseId\s*:\s*''/);

    const incomingStart = appSource.indexOf('async function registerPurchaseIncoming');
    const incomingEnd = appSource.indexOf('window.receivePurchaseOrder', incomingStart);
    const incoming = appSource.slice(incomingStart, incomingEnd);
    assert.match(incoming, /filter\(item => \(item\.fulfillmentType \|\| 'WAREHOUSE'\) !== 'DIRECT_SHIP'\)/);
});

test('Phase 2-6 security rules cover supplier and warehouse master collections', () => {
    assert.match(rulesSource, /match \/suppliers\/\{id\}/);
    assert.match(rulesSource, /match \/brandSupplierMappings\/\{id\}/);
    assert.match(rulesSource, /match \/warehouses\/\{id\}/);
    assert.match(rulesSource, /match \/warehouseStocks\/\{id\}/);
});

test('Phase 2-6 keeps Customer Reference, Equipment Master and sales ownership compatibility', () => {
    assert.match(appSource, /function syncCustomerMaster/);
    assert.match(appSource, /customerId/);
    assert.match(appSource, /ownerUid/);
    assert.match(appSource, /salesCode/);
    assert.match(rulesSource, /match \/equipment\/\{id\}/);
    assert.match(rulesSource, /function owns\(data\)/);
});

test('V2 formal purchase orders normalize supply lines and receipts update them', () => {
    assert.match(appSource, /function formalSupplyOrderId/);
    assert.match(appSource, /type:'PURCHASING_PO',purchaseOrderId/);
    assert.match(appSource, /formalSupplyReceived|formalReceived/);
    assert.match(appSource, /db\.collection\('supplyOrders'\)\.doc\(formalSupplyOrderId/);
});

test('V2 initial stock separates operational lot from protected cost', () => {
    assert.match(indexSource, /實際單位成本/);
    assert.match(appSource, /sourceType:'INITIAL_STOCK'/);
    assert.match(appSource, /remainingQty:delta,sourceType:'INITIAL_STOCK'/);
    assert.match(appSource, /inventoryLotCosts/);
    assert.match(appSource, /unitCost:Number\(row\.unitCost/);
});

test('V2 returns restore and reverse exact delivery lots', () => {
    assert.match(appSource, /availableReturnAllocations/);
    assert.match(appSource, /previousReturnRecord/);
    assert.match(appSource, /lotAllocations,cogs/);
});

test('V2 manual orders and copies preserve multiple items', () => {
    assert.match(indexSource, /addCurrentOrderItemToDraft/);
    assert.match(appSource, /let newOrderDraftItems/);
    assert.match(appSource, /const items=\[\.\.\.newOrderDraftItems/);
    assert.match(appSource, /normalizedOrderItems\(source\)\.map\(normalizeNewOrderItem\)/);
    assert.match(appSource, /itemCount:items\.length,orderSchemaVersion:2/);
});

test('V2 product lookup is server bounded and shows sale and inventory quantities', () => {
    assert.match(indexSource, /searchBusinessProducts/);
    const start=appSource.indexOf('window.searchBusinessProducts');
    const end=appSource.indexOf('window.renderInventoryList',start);
    const source=appSource.slice(start,end);
    assert.match(source, /where\('normalizedPartNo','==',normalized\)\.limit\(25\)/);
    assert.match(source, /orderBy\('productName'\).*limit\(25\)/s);
    assert.doesNotMatch(source, /db\.collection\('products'\)\.get\(\)/);
});

test('V2 personnel UI stores role capabilities and product line responsibility', () => {
    assert.match(indexSource, /負責產品線/);
    assert.match(appSource, /saveAdminUserCapabilities/);
    assert.match(appSource, /productLineIds,capabilities/);
});

test('V2 dashboard and safety stock use bounded data', () => {
    assert.match(indexSource, /adminDashboardCards/);
    assert.match(appSource, /window\.loadAdminDashboard/);
    assert.match(appSource, /limit\(100\)/);
    assert.match(appSource, /setInventorySafetyStock/);
    assert.match(appSource, /safetyStock,updatedAt/);
});

test('V2 generic order status toggler only permits reversible billing state', () => {
  const source = fs.readFileSync('app.js', 'utf8');
  const start = source.indexOf('window.toggleOrderStatus = function(orderId, field, newValue)');
  assert.ok(start >= 0);
  const block = source.slice(start, start + 700);
  assert.match(block, /field !== 'isBilled'/);
  assert.match(block, /V2 採購／入庫／打單流程自動管理/);
});

test('quick delivery no longer synthesizes legacy ordered or arrived states', () => {
  const source = fs.readFileSync('app.js', 'utf8');
  const start = source.indexOf('window.quickCompleteDelivery = async function');
  const end = source.indexOf('window.quickCancelAllDelivery = async function', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /updates\s*=\s*\{[^}]*isOrdered:\s*true/s);
  assert.doesNotMatch(block, /updates\s*=\s*\{[^}]*isArrived:\s*true/s);
});

test('equipment removal uses soft disable and never Firestore delete', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  const start = app.indexOf('window.deleteEquipment = function');
  const end = app.indexOf('function equipmentLogRealIndex', start);
  const block = app.slice(start, end);
  assert.match(block, /active:false/);
  assert.match(block, /disabledAt/);
  assert.doesNotMatch(block, /\.delete\s*\(/);
});


test('V2 legacy inventory cost migration is paginated and moves cost out of operational collections', () => {
    assert.match(appSource, /function readCollectionForMigration/);
    assert.match(appSource, /FieldPath\.documentId\(\)/);
    assert.match(appSource, /inventoryLotCosts/);
    assert.match(appSource, /FieldValue\.delete\(\)/);
    assert.doesNotMatch(indexSource, /預覽庫存成本隔離/);
    assert.doesNotMatch(indexSource, /執行庫存成本隔離/);
});


test('V2 historical COGS is reproducible from exact lot allocations and protected costs', () => {
    assert.match(appSource, /function protectedAllocationCost/);
    assert.match(appSource, /inventoryAnalysisLotCosts\.get\(allocation\.lotId\)/);
    assert.match(appSource, /function protectedHistoricalCogs/);
    assert.match(appSource, /protectedAllocationCost\(delivered\) - protectedAllocationCost\(returned\)/);
    assert.match(appSource, /grossProfit:sales-cogs/);
});


test('V2 backup and storage audit include fulfillment and protected cost collections', () => {
    for (const name of ['inventoryLots','inventoryLotCosts','receipts','supplyOrders','dispatchRecords']) {
        assert.match(appSource, new RegExp("'" + name + "'"));
    }
    assert.match(appSource, /受保護批次成本/);
    assert.match(appSource, /供應／訂貨紀錄/);
});


test('V2 admin UI no longer exposes the legacy migration deployment panel', () => {
    assert.doesNotMatch(indexSource, /部署 PR #30 的 Firestore Rules \/ Indexes/);
    assert.doesNotMatch(indexSource, /庫存成本隔離，直到顯示 0/);
    assert.match(indexSource, /上傳 Excel 更新 Product Master/);
});


test('warehouse master save has immediate feedback and duplicate-submit guard', () => {
    const start = appSource.indexOf('window.saveWarehouseMaster');
    const end = appSource.indexOf('window.disableWarehouseMaster', start);
    const source = appSource.slice(start, end);
    assert.match(source, /button\.disabled = true/);
    assert.match(source, /儲存中/);
    assert.match(source, /permission-denied/);
    assert.match(source, /button\.disabled = false/);
});

test('Product Master first load failure clears cached promise so next action can retry', () => {
    const start = appSource.indexOf('function ensurePriceListLoaded');
    const end = appSource.indexOf('function ensureClientHistoryLoaded', start);
    const source = appSource.slice(start, end);
    assert.match(source, /priceListLoadPromise = null/);
    assert.match(source, /Product Master 載入失敗/);
});

test('formal purchase order automatically derives ordered progress on linked order items', () => {
    assert.match(appSource, /purchaseOrderedQty:cumulative/);
    assert.match(appSource, /purchaseStatus:totalOrdered<=0\?'pending':totalOrdered<totalNeeded\?'partial':'ordered'/);
    assert.match(appSource, /function purchaseProgressInfo/);
    assert.match(appSource, /已訂貨 \$\{ordered\}\/\$\{required\}/);
});


test('V2 order history presents derived purchase and fulfillment progress instead of legacy ordered/arrived truth', () => {
    const start = appSource.indexOf('function renderOrderStatusHistory');
    const end = appSource.indexOf('async function applyInventoryDeliveryDeltaInTransaction', start);
    const source = appSource.slice(start, end);
    assert.match(source, /purchaseProgressInfo\(order\)/);
    assert.match(source, /fulfillmentProgressInfo\(order\)/);
    assert.doesNotMatch(source, /\['isOrdered', '訂貨'\], \['isArrived', '到貨'\]/);
});

test('stock replenishment always uses a valid warehouse PO path', () => {
    const start = appSource.indexOf('window.printPurchaseOrder');
    const end = appSource.indexOf('window.closePurchaseOrderModal', start);
    const source = appSource.slice(start, end);
    assert.match(source, /原廠備貨是公司庫存採購，不能設定為原廠直送/);
    assert.match(source, /原廠備貨必須指定入庫倉庫/);
    assert.match(source, /purchaseType: poItems\.every\(item => !item\.orderId\) \? 'stock' : 'order'/);
    assert.match(source, /db\.collection\('supplyOrders'\)/);
});


test('batch receipt reports partial success and requires a warehouse', () => {
    assert.match(appSource, /尚未指定入庫倉庫/);
    assert.match(appSource, /let completed = 0/);
    assert.match(appSource, /已成功入庫 \$\{completed\} 個品項/);
    assert.match(appSource, /已成功的資料不會重複入庫/);
});

test('partial delivery save blocks duplicate taps', () => {
    const start = appSource.indexOf('window.saveDeliveryRecord');
    const end = appSource.indexOf('window.deleteDeliveryRecord', start);
    const source = appSource.slice(start, end);
    assert.match(source, /pendingDeliveryOrderIds\.has\(orderId\)/);
    assert.match(source, /pendingDeliveryOrderIds\.add\(orderId\)/);
    assert.match(source, /儲存中…/);
    assert.match(source, /pendingDeliveryOrderIds\.delete\(orderId\)/);
});

test('all multi-item orders require item-level delivery even when direct ship', () => {
    const start = appSource.indexOf('window.quickCompleteDelivery');
    const end = appSource.indexOf('window.quickCancelAllDelivery', start);
    const source = appSource.slice(start, end);
    assert.match(source, /const allItems=normalizedOrderItems\(cachedOrder\)/);
    assert.match(source, /if \(allItems\.length > 1\)/);
    assert.match(source, /確保送貨與退貨都能追蹤到正確品項/);
});

test('legacy cost migration sanitizes delivery and return allocations embedded in orders', () => {
    assert.match(appSource, /function recordContainsEmbeddedCost/);
    assert.match(appSource, /legacyOrders: orders\.filter/);
    assert.match(appSource, /deliveryRecords:\(row\.data\.deliveryRecords\|\|\[\]\)\.map\(sanitizeRecord\)/);
    assert.match(appSource, /returnRecords:\(row\.data\.returnRecords\|\|\[\]\)\.map\(sanitizeRecord\)/);
});


test('cancel and restore reservations are item-aware', () => {
  const start=appSource.indexOf('async function adjustInventoryReservationForLifecycle');
  const end=appSource.indexOf('window.quickSetOrderLifecycle',start);
  const source=appSource.slice(start,end);
  assert.match(source,/const items = normalizedOrderItems\(order\)/);
  assert.match(source,/order_cancelled/);
  assert.match(source,/order_restored/);
  assert.match(source,/stockStates = new Map/);
  assert.match(source,/transaction\.set\(reservationDocRef\(orderId\)/);
  assert.match(source,/items:nextItems,inventoryReservedQty:totalReserved,inventoryShortageQty:totalShortage/);
});

test('delivery and return deletes reject duplicate submissions and cancelled orders can return delivered goods', () => {
  const ds=appSource.slice(appSource.indexOf('window.deleteDeliveryRecord'),appSource.indexOf('window.clearLegacyDelivery'));
  assert.match(ds,/pendingDeliveryOrderIds\.has\(orderId\)/);
  assert.match(ds,/pendingDeliveryOrderIds\.delete\(orderId\)/);
  const rs=appSource.slice(appSource.indexOf('window.deleteReturnRecord'),appSource.indexOf('window.updateOrderField'));
  assert.match(rs,/pendingReturnOrderIds\.has\(orderId\)/);
  assert.match(rs,/pendingReturnOrderIds\.delete\(orderId\)/);
  assert.match(appSource,/已取消訂單仍可能有取消前已實際送出的商品/);
});


test('legacy cost migration also sanitizes aggregate and warehouse stock cost fields', () => {
  assert.match(appSource,/legacyWarehouseStocks/);
  assert.match(appSource,/warehouseStocks/);
  assert.match(appSource,/costSanitizedAt/);
});


test('database backup covers governed master, audit, delivery and Forecast progress data', () => {
  for (const name of ['productLines','priceHistory','deliveries','auditLogs']) assert.match(appSource,new RegExp("'"+name+"'"));
  assert.doesNotMatch(appSource,/collectionGroup\('progress'\)/);
  assert.match(appSource,/forecastDoc\.ref\.collection\('progress'\)/);
  assert.match(appSource,/data\.forecastProgress/);
  assert.match(appSource,/path:doc\.ref\.path/);
});

test('Forecast list queries have production composite indexes for every ownership path', () => {
  const forecastIndexes = firestoreIndexes.indexes
    .filter(index => index.collectionGroup === 'forecasts')
    .map(index => index.fields.map(field => `${field.fieldPath}:${field.order}`).join(','));

  assert.ok(forecastIndexes.includes('status:ASCENDING,updatedAt:DESCENDING'),
    'admin Forecast status query requires a status + updatedAt composite index');
  assert.ok(forecastIndexes.includes('salesCode:ASCENDING,status:ASCENDING,updatedAt:DESCENDING'),
    'salesCode-owned Forecast query requires its composite index');
  assert.ok(forecastIndexes.includes('ownerUid:ASCENDING,status:ASCENDING,updatedAt:DESCENDING'),
    'legacy ownerUid-owned Forecast query requires its composite index');
});

test('new order modal provides recent-order and customer frequent-item shortcuts', () => {
  assert.match(indexSource,/id="orderRecentTemplateSelect"/);
  assert.match(indexSource,/onclick="loadSelectedRecentOrder\(\)"/);
  assert.match(indexSource,/id="orderFrequentItemSelect"/);
  assert.match(indexSource,/onclick="loadSelectedFrequentItem\(\)"/);
  assert.match(appSource,/function recentOrderCandidates\(\)/);
  assert.match(appSource,/function refreshOrderFrequentItemOptions\(\)/);
  assert.match(appSource,/customerNameKey\(order\.customerName\)===customer/);
});

test('new order drafts are per-user, restorable and cleared only after successful save', () => {
  assert.match(appSource,/ORDER_DRAFT_STORAGE_PREFIX = 'order_draft_v2'/);
  assert.match(appSource,/currentUser\?\.uid \|\| 'anonymous'/);
  assert.match(appSource,/function collectOrderDraft\(\)/);
  assert.match(appSource,/window\.restoreSavedOrderDraft=function/);
  assert.match(appSource,/window\.clearSavedOrderDraft=function/);
  const saveStart=appSource.indexOf('window.saveNewOrder');
  const saveEnd=appSource.indexOf('// 匯出指定日期區間',saveStart);
  assert.match(appSource.slice(saveStart,saveEnd),/clearSavedOrderDraft\(\{ silent:true \}\)/);
});

test('admin storage exposes a read-only legacy-cost audit without an execution button', () => {
  assert.match(indexSource,/id="inventoryCostMigrationPreviewBtn"/);
  assert.match(indexSource,/onclick="previewInventoryCostMigration\(\)"/);
  assert.match(indexSource,/只讀取並統計舊庫存/);
  assert.doesNotMatch(indexSource,/onclick="runInventoryCostMigration\(\)"/);
  const preview=appSource.slice(appSource.indexOf('window.previewInventoryCostMigration'),appSource.indexOf('window.runInventoryCostMigration'));
  assert.match(preview,/\.map\(name => readCollectionForMigration\(name\)\)/);
  assert.doesNotMatch(preview,/\.map\(readCollectionForMigration\)/);
});

test('production HTML cache-busts local application assets after main deployments', () => {
  assert.match(indexSource,/styles\.css\?v=20260923-\d+/);
  assert.match(indexSource,/modules\/workflow-core\.js\?v=20260923-\d+/);
  assert.match(indexSource,/app\.js\?v=20260923-\d+/);
  assert.match(indexSource,/modules\/fulfillment-core\.js\?v=20260922-\d+/);
});

test('Forecast full-history search uses Firestore searchTokens', () => {
    assert.match(indexSource, /id="forecastSearch"[\s\S]*?oninput="scheduleForecastHistorySearch\(\)"/);
    assert.match(appSource, /buildFullHistorySearchTokens\('forecast', record\)/);
    assert.match(appSource, /collection\('forecasts'\)\.where\('searchTokens', 'array-contains', queryToken\)\.limit\(DEFAULT_LIST_LIMIT\)/);
    assert.match(appSource, /forecastHistorySearchTimer = setTimeout\(\(\) => runForecastHistorySearch\(true\), 350\)/);
});

