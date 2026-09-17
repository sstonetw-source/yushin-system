const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

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

test('sales statistics reuses one in-flight full query and ignores stale roles', () => {
    const start = appSource.indexOf('window.loadSalesStatistics =');
    const end = appSource.indexOf('\n};', start) + 3;
    const loader = appSource.slice(start, end);
    assert.match(loader, /if \(salesStatisticsLoadPromise\) return salesStatisticsLoadPromise/);
    assert.match(loader, /requestedRole !== currentUserRole/);
    assert.match(loader, /salesStatisticsLoadPromise = null/);
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
    let promptCount = 0;
    let updatePayload;
    const context = {
        window: {}, ordersCache: [order], pendingOrderStatusKeys: new Set(), activeOrderWorkFilter: 'all',
        canEditPage: () => true, normalizedOrderStatus: () => 'normal',
        deliveryProgressInfo: () => ({ delivered: 0 }), orderInvoiceDate: () => '', localDateString: () => '2026-09-17',
        prompt: () => { promptCount++; return '2026-09-17'; }, alert: message => { throw new Error(message); },
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
    assert.equal(promptCount, 1);
    assert.equal(context.pendingOrderStatusKeys.has('o1:isBilled'), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updatePayload.isBilled, true);
    assert.equal(updatePayload.invoiceDate, '2026-09-17');
    assert.equal(context.pendingOrderStatusKeys.has('o1:isBilled'), false);
});
