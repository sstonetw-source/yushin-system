const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const src = fs.readFileSync(path.join(__dirname, '../src/features/administration/brand-settings.js'), 'utf8');
const code = src.slice(src.indexOf('window.loadProductManagementOverview'), src.indexOf('function priceListDateLabel'));

function fixture() {
    let reads = 0, brands = 0, renders = 0, historyRenders = 0;
    const status = { textContent: '' };
    const body = { innerHTML: '' };
    const details = { open: false };
    const elements = { productOverviewStatus: status, priceListHistoryBody: body, priceListHistoryDetails: details };
    const query = {
        orderBy() { return this; },
        limit(n) { assert.equal(n, 100); return this; },
        get: async () => {
            reads++;
            if (context.offline) throw Error('offline');
            return { docs: [
                { id: 'h1', data: () => ({ recordType: 'PRICE_LIST' }) },
                { id: 'h2', data: () => ({ recordType: 'PRODUCT' }) }
            ] };
        }
    };
    const window = {};
    const context = vm.createContext({
        window, console, trueUserRole: 'admin', currentUserRole: 'admin', sessionDataGeneration: 0,
        productOverviewGenerationLoading: -1, priceListManagementRows: [], priceListHistoryRows: [],
        document: { getElementById: id => elements[id] },
        db: { collection: name => { assert.equal(name, 'priceHistory'); return query; } },
        firestoreReadWithTimeout: async promise => promise, escapeHtml: String,
        loadBrandMaster: async () => { brands++; },
        getUnifiedBrandEntries: () => [{ name: 'B', active: true }, { name: 'Disabled', active: false }],
        renderProductManagementOverview: () => { renders++; },
        refreshProductImportResumeControls: () => {}, // 本測試僅載入價目表模組，不載入本機匯入模組。
        renderPriceListHistory: () => { historyRenders++; }
    });
    vm.runInContext(code + '\nconst loadPriceListHistory = window.loadPriceListHistory;', context);
    return { context, window, details, body, counts: () => ({ reads, brands, renders, historyRenders }) };
}

test('price list only reads history on demand and shares overlapping reads', async () => {
    const { window, context, counts, details } = fixture();
    await window.loadProductManagementOverview();
    assert.deepEqual(counts(), { reads: 0, brands: 1, renders: 1, historyRenders: 0 });
    assert.equal(context.priceListManagementRows.length, 1);
    details.open = true;
    const history = window.loadPriceListHistory();
    assert.equal(window.loadPriceListHistory(), history);
    await history;
    assert.equal(context.priceListHistoryRows.length, 1);
    await window.loadPriceListHistory();
    assert.equal(counts().reads, 1);
    await window.loadProductManagementOverview(true);
    assert.equal(counts().reads, 2);
});

test('history failure leaves the overview available and allows retry', async () => {
    const { window, context, body, counts, details } = fixture();
    context.offline = true;
    details.open = true;
    await window.loadProductManagementOverview();
    assert.match(body.innerHTML, /offline/);
    assert.equal(counts().renders, 1);
    context.offline = false;
    await window.loadPriceListHistory();
    assert.equal(counts().historyRenders, 1);
});

test('role simulation blocks reads and session changes ignore pending history results', async () => {
    const { window, context, counts } = fixture();
    context.currentUserRole = 'sales';
    await window.loadProductManagementOverview();
    await window.loadPriceListHistory();
    assert.equal(counts().reads, 0);
    assert.equal(counts().brands, 0);
    context.currentUserRole = 'admin';
    const history = window.loadPriceListHistory();
    context.sessionDataGeneration++;
    await history;
    assert.equal(counts().historyRenders, 0);
    await window.loadPriceListHistory();
    assert.equal(counts().reads, 2);
});


test('local price and master resume controls show only when their jobs remain unfinished', async () => {
    const importSource = fs.readFileSync(path.join(__dirname, '../src/features/products/product-master-import.js'), 'utf8');
    const begin = importSource.indexOf('async function refreshProductImportResumeControls()');
    const end = importSource.indexOf('\nasync function saveProductPriceJob(', begin);
    assert.ok(begin >= 0 && end > begin);
    const priceButton = { hidden: false }, masterButton = { hidden: false };
    let reads = 0;
    const jobs = { price: null, master: null };
    const ctx = vm.createContext({
        document: { getElementById: id => ({
            productPriceResumeButton: priceButton, productMasterResumeButton: masterButton
        })[id] },
        trueUserRole: 'admin', currentUserRole: 'admin', currentUser: { uid: 'tester' },
        sessionDataGeneration: 0,
        readProductPriceJob: async kind => {
            reads++;
            return jobs[kind === 'master' ? 'master' : 'price'];
        },
        console: { warn() {} }
    });
    vm.runInContext(importSource.slice(begin, end), ctx);
    await ctx.refreshProductImportResumeControls();
    assert.equal(priceButton.hidden, true);
    assert.equal(masterButton.hidden, true);

    jobs.price = { rows: [1, 2], cursor: 1 };
    jobs.master = { total: 4, cursor: 2 };
    await ctx.refreshProductImportResumeControls();
    assert.equal(priceButton.hidden, false);
    assert.equal(masterButton.hidden, false);

    jobs.price.cursor = 2;
    jobs.master.cursor = 4;
    await ctx.refreshProductImportResumeControls();
    assert.equal(priceButton.hidden, true);
    assert.equal(masterButton.hidden, true);

    const beforeDenied = reads;
    ctx.currentUserRole = 'sales';
    await ctx.refreshProductImportResumeControls();
    assert.equal(reads, beforeDenied);
    assert.equal(priceButton.hidden, true);
    assert.equal(masterButton.hidden, true);
});
