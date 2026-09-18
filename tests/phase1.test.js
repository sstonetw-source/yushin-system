const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');

function loadPurchaseMapper() {
    const start = appSource.indexOf('function purchaseItemsFromOrder(order)');
    const end = appSource.indexOf('\n}\n\nwindow.openPurchaseOrderModal', start) + 2;
    assert.ok(start >= 0 && end > start, 'purchaseItemsFromOrder must exist');
    const context = {
        priceItemLookup: new Map([
            ['code:a-1', { cost: 25 }],
            ['brand:acme:b-2', { cost: 40 }]
        ]),
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
    assert.match(appSource, /priceItemLookup\.get\(`code:\$\{normalizeItemCode\(value\)\}`\)/);
});

test('sales statistics uses a bounded cached query and ignores stale roles', () => {
    const start = appSource.indexOf('window.loadSalesStatistics =');
    const end = appSource.indexOf('\n};', start) + 3;
    const loader = appSource.slice(start, end);
    assert.match(loader, /if \(salesStatisticsLoadPromise\) return salesStatisticsLoadPromise/);
    assert.match(loader, /requestedRole !== currentUserRole/);
    assert.match(loader, /salesStatisticsLoadPromise = null/);
    assert.match(loader, /where\('orderDate', '<=', localDateString\(\)\)/);
    assert.doesNotMatch(loader, /collection\('orders'\)\.get\(\)/);
});

test('purchase modal chooses a company that does not silently filter every item', () => {
    const start = appSource.indexOf('function bestPurchaseOrderCompany(');
    const end = appSource.indexOf('\n}\n\nwindow.openPurchaseOrderModal', start) + 2;
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
    assert.match(appSource.slice(dealStart, dealEnd), /company: q\.company \|\| ''/);
});

test('billing status is optimistic and ignores a rapid duplicate tap', async () => {
    const start = appSource.indexOf('window.toggleOrderStatus =');
    const end = appSource.indexOf('\n};', start) + 3;
    const order = { id: 'o1', isOrdered: true, isArrived: true, isBilled: false, statusHistory: [] };
    let updatePayload;
    const context = {
        window: {}, ordersCache: [order], pendingOrderStatusKeys: new Set(), activeOrderWorkFilter: 'all',
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
        window: {}, ordersCache: [order], pendingOrderStatusKeys: new Set(), activeOrderWorkFilter: 'billing',
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


test('full-history order item-code search stays indexed and paginated', () => {
    assert.match(appSource, /where\('itemCodeKey', '==', keyword\)/);
    assert.match(appSource, /limit\(DEFAULT_LIST_LIMIT\)/);
    assert.match(appSource, /startAfter\(orderHistorySearchCursor\)/);
    assert.match(appSource, /itemCodeKey: normalizeHistoryItemCode/);
    const searchStart = appSource.indexOf('async function runOrderHistoryItemCodeSearch');
    const searchEnd = appSource.indexOf('\n}\n\nwindow.searchAllOrderHistory', searchStart) + 2;
    const searchSource = appSource.slice(searchStart, searchEnd);
    assert.doesNotMatch(searchSource, /collection\('orders'\)\.get\(\)/);
    assert.doesNotMatch(searchSource, /while\s*\(/);
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


test('legacy order search-index migration is admin-only, batched and idempotent', () => {
    const start = appSource.indexOf('window.backfillOrderSearchIndex =');
    const end = appSource.indexOf('\n};', start) + 3;
    const migration = appSource.slice(start, end);
    assert.match(migration, /trueUserRole !== 'admin'/);
    assert.match(migration, /currentUserRole !== 'admin'/);
    assert.match(migration, /limit\(200\)/);
    assert.match(migration, /startAfter\(cursor\)/);
    assert.match(migration, /data\.itemCodeKey !== normalized/);
    assert.match(migration, /batch\.update/);
    assert.doesNotMatch(migration, /collection\('orders'\)\.get\(\)/);
});


test('new quotes and orders persist createdAt and normalized order item-code keys', () => {
    const saveOrderStart = appSource.indexOf('window.saveNewOrder =');
    const saveOrderEnd = appSource.indexOf('\n};', saveOrderStart) + 3;
    const saveOrder = appSource.slice(saveOrderStart, saveOrderEnd);
    assert.match(saveOrder, /createdAt: new Date\(\)\.toISOString\(\)/);
    assert.match(saveOrder, /itemCodeKey: normalizeHistoryItemCode\(itemCode\)/);

    const quoteStart = appSource.indexOf('window.handleSaveAndPrint =');
    const quoteEnd = appSource.indexOf('\n};', quoteStart) + 3;
    assert.match(appSource.slice(quoteStart, quoteEnd), /createdAt: new Date\(\)\.toISOString\(\)/);

    const dealStart = appSource.indexOf('window.markQuoteAsDeal =');
    const dealEnd = appSource.indexOf('\n};', dealStart) + 3;
    const deal = appSource.slice(dealStart, dealEnd);
    assert.match(deal, /createdAt: new Date\(\)\.toISOString\(\)/);
    assert.match(deal, /itemCodeKey: normalizeHistoryItemCode/);
});


test('phase 2 product master extends the existing price catalog instead of creating a parallel product source', () => {
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
    assert.doesNotMatch(appSource, /collection\(['"]products['"]\)/);
});


test('phase 2 documents link to productId while retaining historical snapshots', () => {
    assert.match(appSource, /class="item-product-id"/);
    assert.match(appSource, /productId: row\.querySelector\('\.item-product-id'\)/);
    assert.match(appSource, /data\.productId = priceMatch\.productId/);
    assert.match(appSource, /orderData\.productId = orderData\.productId/);
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
