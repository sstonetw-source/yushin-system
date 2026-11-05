const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/features/products/product-master-import.js'), 'utf8');
const start = source.indexOf('const PRODUCT_PRICE_DAILY_ROW_LIMIT');
const end = source.indexOf('\nwindow.handleProductCostExcelUpload', start);
assert.ok(start >= 0 && end > start);
const focusedSource = source.slice(start, end);

function createHarness(products = []) {
    const records = products.map(product => ({ ...product }));
    const reads = [];
    const writes = [];
    const messages = [];
    const saved = [];
    let consumed = 0;
    let approved = true;
    const context = {
        window:{},
        db:{
            app:{ options:{ projectId:'demo-yushin' } },
            collection(name) {
                assert.equal(name, 'products');
                return {
                    doc(id) { return { id }; },
                    where(field, operator, values) {
                        assert.equal(field, 'normalizedPartNo');
                        assert.equal(operator, 'in');
                        return {
                            get(options) {
                                assert.equal(options.source, 'server');
                                reads.push([...values]);
                                return Promise.resolve({ docs:records.filter(item => values.includes(item.normalizedPartNo)).map(item => ({
                                    id:item.id, data:() => ({ ...item })
                                })) });
                            }
                        };
                    }
                };
            }
        },
        currentUserRole:'admin', currentUser:{ uid:'staff-1' },
        priceList:[], productManagementResults:[],
        normalizeItemCodeLoose:value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, ''),
        normalizeBrandLookupKey:value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
        productImportSheetRows:sheet => sheet,
        firestoreReadWithTimeout:promise => promise,
        commitMigrationBatch:async operations => {
            for (const operation of operations) operation({
                set(ref, patch, options) {
                    assert.equal(options.merge, true);
                    assert.deepEqual(Object.keys(patch).sort(), ['listPrice', 'updatedAt', 'updatedBy']);
                    const product = records.find(row => row.id === ref.id);
                    assert.ok(product);
                    product.listPrice = patch.listPrice;
                    writes.push({ id:ref.id, price:patch.listPrice });
                }
            });
        },
        setPriceUploadProgress:(percent, status) => messages.push({ percent, status }),
        rebuildPriceItemLookup:() => {},
        renderProductManagementResults:() => {},
        confirm:() => approved,
        console,
        navigator:{ locks:{ request:async (name, options, action) => action() } }
    };
    vm.createContext(context);
    vm.runInContext(`${focusedSource}\nglobalThis.priceTest = { parseProductPriceUpdateRows, runProductPriceJobBatch, productPriceQuotaDay, readProductPriceJob, saveProductPriceJob, readProductPriceDailyQuota, reserveProductPriceDailyQuota };`, context);
    context.readProductPriceDailyQuota = async () => consumed;
    context.reserveProductPriceDailyQuota = async (day, count) => { consumed += count; };
    context.saveProductPriceJob = async job => { saved.push({ ...job }); };
    return {
        context, records, reads, writes, messages, saved,
        get consumed() { return consumed; },
        set consumed(value) { consumed = value; },
        set approved(value) { approved = value; },
        job(rows, overrides = {}) {
            return { scope:'demo-yushin:staff-1', brand:'Bio-Rad', filename:'Bio-Rad-價格更新.xlsx',
                rows, cursor:0, updated:0, unchanged:0, ...overrides };
        }
    };
}

function createFakeIndexedDb() {
    const stores = new Map();
    return {
        open(name) {
            const request = {};
            setImmediate(() => {
                const isNew = !stores.has(name);
                if (isNew) stores.set(name, new Map());
                const db = {
                    close() {},
                    createObjectStore() {},
                    transaction() {
                        let aborted = false;
                        const transaction = {
                            abort() { aborted = true; setImmediate(() => transaction.onabort?.()); },
                            objectStore() {
                                return {
                                    get(key) {
                                        const response = {};
                                        setImmediate(() => {
                                            response.result = structuredClone(stores.get(name).get(key));
                                            response.onsuccess?.();
                                            setImmediate(() => { if (!aborted) transaction.oncomplete?.(); });
                                        });
                                        return response;
                                    },
                                    put(value) {
                                        stores.get(name).set(value.scope, structuredClone(value));
                                        setImmediate(() => { if (!aborted) transaction.oncomplete?.(); });
                                    }
                                };
                            }
                        };
                        return transaction;
                    }
                };
                request.result = db;
                if (isNew) request.onupgradeneeded?.();
                request.onsuccess?.();
            });
            return request;
        }
    };
}

test('local Excel parsing validates price, detects conflicting duplicate codes, and does not query Firestore', () => {
    const h = createHarness();
    const parse = h.context.priceTest.parseProductPriceUpdateRows;
    const workbook = { SheetNames:['價格更新'], Sheets:{ '價格更新':[
        { 貨號:'AB-01', '建議售價（含稅）':'1,200' },
        { 貨號:'AB01', '建議售價（含稅）':1200 },
        { 貨號:'C', '建議售價（含稅）':0 }
    ] } };
    assert.equal(parse(workbook).length, 2);
    assert.equal(parse(workbook)[0].price, 1200);
    assert.equal(parse(workbook)[1].price, 0);
    assert.equal(h.reads.length, 0);
    workbook.Sheets['價格更新'][1]['建議售價（含稅）'] = 1250;
    assert.throws(() => parse(workbook), /兩種不同售價/);
    workbook.Sheets['價格更新'] = [{ 貨號:'', '建議售價（含稅）':100 }];
    assert.throws(() => parse(workbook), /無效資料/);
});

test('price-only batch reads only requested products and writes only changed listPrice', async () => {
    const h = createHarness([
        { id:'p1', normalizedPartNo:'A1', manufacturerPartNo:'A-1', brandName:'Bio-Rad', listPrice:100 },
        { id:'p2', normalizedPartNo:'B2', manufacturerPartNo:'B2', brandName:'Bio-Rad', listPrice:200 }
    ]);
    const job = h.job([{ code:'A-1', price:150 }, { code:'B2', price:200 }]);
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(h.reads.length, 1);
    assert.equal(h.consumed, 2);
    assert.deepEqual(h.writes, [{ id:'p1', price:150 }]);
    assert.equal(job.cursor, 2);
    assert.equal(job.updated, 1);
    assert.equal(job.unchanged, 1);
    assert.equal(h.saved.length, 1);
    assert.match(h.messages.at(-1).status, /全部完成/);
});

test('missing or ambiguous product blocks the entire batch without writes or cursor movement', async () => {
    const h = createHarness([
        { id:'p1', normalizedPartNo:'A1', manufacturerPartNo:'A1', brandName:'Bio-Rad', listPrice:100 },
        { id:'p2', normalizedPartNo:'A1', manufacturerPartNo:'A1', brandName:'Bio-Rad', listPrice:100 }
    ]);
    const job = h.job([{ code:'A1', price:150 }, { code:'MISSING', price:300 }]);
    await assert.rejects(h.context.priceTest.runProductPriceJobBatch(job), /1 個不存在、1 個重複/);
    assert.equal(job.cursor, 0);
    assert.equal(h.writes.length, 0);
    assert.equal(h.saved.length, 0);
    assert.equal(h.consumed, 2);
});

test('daily cap pauses without more server reads and previous progress resumes without duplicate writes', async () => {
    const h = createHarness([
        { id:'p1', normalizedPartNo:'A1', manufacturerPartNo:'A1', brandName:'Bio-Rad', listPrice:100 },
        { id:'p2', normalizedPartNo:'B2', manufacturerPartNo:'B2', brandName:'Bio-Rad', listPrice:200 }
    ]);
    const job = h.job([{ code:'A1', price:150 }, { code:'B2', price:250 }]);
    h.consumed = 999;
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(job.cursor, 1);
    assert.deepEqual(h.writes, [{ id:'p1', price:150 }]);
    assert.equal(h.consumed, 1000);
    const readsAfterFirst = h.reads.length;
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(h.reads.length, readsAfterFirst);
    h.consumed = 0; // 模擬隔天免費額度重置
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(job.cursor, 2);
    assert.deepEqual(h.writes, [{ id:'p1', price:150 }, { id:'p2', price:250 }]);
});

test('cancelled update and role changes do not write price changes', async () => {
    const h = createHarness([{ id:'p1', normalizedPartNo:'A1', manufacturerPartNo:'A1', brandName:'Bio-Rad', listPrice:100 }]);
    const job = h.job([{ code:'A1', price:150 }]);
    h.approved = false;
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(job.cursor, 0);
    assert.equal(h.writes.length, 0);
    h.context.currentUserRole = 'sales';
    await assert.rejects(h.context.priceTest.runProductPriceJobBatch(job), /登入身分或專案已改變/);
    assert.equal(h.reads.length, 1);
});

test('IndexedDB saves unfinished Excel rows and a daily quota shared by replacement files', async () => {
    const h = createHarness();
    h.context.indexedDB = createFakeIndexedDb();
    const helpers = h.context.priceTest;
    const job = h.job([{ code:'A1', price:150 }, { code:'B2', price:200 }]);
    await helpers.saveProductPriceJob(job);
    const resumed = await helpers.readProductPriceJob();
    assert.equal(resumed.rows.length, 2);
    assert.equal(resumed.cursor, 0);
    const day = helpers.productPriceQuotaDay();
    await helpers.reserveProductPriceDailyQuota(day, 800);
    await helpers.reserveProductPriceDailyQuota(day, 200);
    assert.equal(await helpers.readProductPriceDailyQuota(day), 1000);
    await assert.rejects(helpers.reserveProductPriceDailyQuota(day, 1), /額度已用完/);
    // 新檔取代進度不會重置同一帳號的每日匯入預算。
    await helpers.saveProductPriceJob(h.job([{ code:'C3', price:300 }]));
    assert.equal((await helpers.readProductPriceJob()).rows[0].code, 'C3');
    assert.equal(await helpers.readProductPriceDailyQuota(day), 1000);
});

test('uncertain partial write keeps cursor, next-day retry compares server and does not write twice', async () => {
    const h = createHarness([
        { id:'p1', normalizedPartNo:'A1', manufacturerPartNo:'A1', brandName:'Bio-Rad', listPrice:100 },
        { id:'p2', normalizedPartNo:'B2', manufacturerPartNo:'B2', brandName:'Bio-Rad', listPrice:100 }
    ]);
    const job = h.job([{ code:'A1', price:150 }, { code:'B2', price:250 }]);
    let first = true;
    h.context.commitMigrationBatch = async operations => {
        for (const operation of operations) {
            operation({ set(ref, data) {
                h.records.find(row => row.id === ref.id).listPrice = data.listPrice;
                h.writes.push({ id:ref.id, price:data.listPrice });
            } });
            if (first) { first = false; throw new Error('模擬成功寫入後回覆遺失'); }
        }
    };
    await assert.rejects(h.context.priceTest.runProductPriceJobBatch(job), /回覆遺失/);
    assert.equal(job.cursor, 0);
    assert.deepEqual(h.writes, [{ id:'p1', price:150 }]);
    h.consumed = 0; // 下一個計費日允許重新比對原本的兩筆
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(job.cursor, 2);
    assert.deepEqual(h.writes, [{ id:'p1', price:150 }, { id:'p2', price:250 }]);
});
