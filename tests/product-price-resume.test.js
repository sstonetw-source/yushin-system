const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/features/products/product-master-import.js'), 'utf8');
const start = source.indexOf('const PRODUCT_PRICE_BATCH_ROW_LIMIT');
const end = source.indexOf('\nwindow.handleProductCostExcelUpload', start);
assert.ok(start >= 0 && end > start);
const focusedSource = source.slice(start, end);

function createHarness(products = []) {
    const records = products.map(product => ({ ...product }));
    const reads = [];
    const writes = [];
    const messages = [];
    const saved = [];
    const transactionReads = [];
    let beforeTransaction = () => {};
    let afterTransaction = () => {};
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
        productImportOperation:checks => { const operation = batch => checks.forEach(c => batch.set(c.ref,c.patch,{merge:true})); operation.importChecks=checks; return operation; },
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
    context.db.runTransaction = async action => {
        beforeTransaction();
        const pending = [];
        await action({
            get:async ref => { transactionReads.push(ref.id); const row=records.find(row=>row.id===ref.id); return {exists:!!row,data:()=>({...row})}; },
            set:(ref,patch) => pending.push({ref,patch})
        });
        pending.forEach(({ref,patch})=>{Object.assign(records.find(row=>row.id===ref.id),patch);writes.push({id:ref.id,price:patch.listPrice});});
        afterTransaction();
    };
    vm.createContext(context);
    const writerStart = source.indexOf('async function commitMigrationBatch(');
    vm.runInContext(source.slice(writerStart,source.indexOf('async function readCollectionInBatches',writerStart)),context);
    vm.runInContext(`${focusedSource}\nglobalThis.priceTest = { parseProductPriceUpdateRows, runProductPriceJobBatch, readProductPriceJob, saveProductPriceJob, productImportJobScope };`, context);
    context.saveProductPriceJob = async job => { saved.push({ ...job }); };
    return {
        context, records, reads, writes, messages, saved,
        transactionReads,
        set beforeTransaction(fn) { beforeTransaction=fn; },
        set afterTransaction(fn) { afterTransaction=fn; },
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
    assert.equal(h.transactionReads.length, h.writes.length);
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
    assert.equal(h.transactionReads.length, h.writes.length);
});

test('same day batches stop at 2000 and immediately continue, repeated file writes nothing', async () => {
    const products=Array.from({length:2001},(_,i)=>({id:`p${i}`,normalizedPartNo:`A${i}`,manufacturerPartNo:`A${i}`,brandName:'Bio-Rad',listPrice:100}));
    const h=createHarness(products);
    const rows=products.map(p=>({code:p.manufacturerPartNo,price:150}));
    const job=h.job(rows);
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(job.cursor,2000); assert.equal(h.writes.length,2000); assert.equal(h.transactionReads.length,2000);
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(job.cursor,2001); assert.equal(h.writes.length,2001);
    await h.context.priceTest.runProductPriceJobBatch(h.job(rows));
    assert.equal(h.writes.length,2001); assert.equal(h.transactionReads.length,2001);
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

test('IndexedDB preserves separate price and master checkpoints, replacement and scope', async () => {
    const h=createHarness();h.context.indexedDB=createFakeIndexedDb();const helpers=h.context.priceTest;
    await helpers.saveProductPriceJob(h.job([{code:'A1',price:150}]));
    assert.equal((await helpers.readProductPriceJob()).rows[0].code,'A1');
    const checkpoint={scope:helpers.productImportJobScope('master'),fingerprint:'sha256',total:1200,cursor:500};
    await helpers.saveProductPriceJob(checkpoint);
    assert.equal((await helpers.readProductPriceJob('master')).cursor,500);
    assert.equal((await helpers.readProductPriceJob('master')).rows,undefined);
    await helpers.saveProductPriceJob(h.job([{code:'C3',price:300}]));
    assert.equal((await helpers.readProductPriceJob()).rows[0].code,'C3');
    await assert.rejects(helpers.saveProductPriceJob({...checkpoint,scope:'other'}),/帳號或專案已切換/);
});

test('lost commit response leaves cursor unchanged and same-day retry does not write twice', async () => {
    const h=createHarness([{id:'p1',normalizedPartNo:'A1',manufacturerPartNo:'A1',brandName:'Bio-Rad',listPrice:100}]);
    const job=h.job([{code:'A1',price:150}]);
    h.afterTransaction=()=>{throw Error('回覆遺失');};
    await assert.rejects(h.context.priceTest.runProductPriceJobBatch(job),/回覆遺失/);
    assert.equal(job.cursor,0);assert.equal(h.writes.length,1);
    h.afterTransaction=()=>{};
    await h.context.priceTest.runProductPriceJobBatch(job);
    assert.equal(job.cursor,1);assert.equal(h.writes.length,1);
});

test('concurrent price edit and server permission denial stop without progress or overwrite',async()=>{
    for(const mode of ['conflict','permission']) {
        const h=createHarness([{id:'p1',normalizedPartNo:'A1',manufacturerPartNo:'A1',brandName:'Bio-Rad',listPrice:100}]);
        h.beforeTransaction=()=>{if(mode==='permission')throw Object.assign(Error('permission-denied'),{code:'permission-denied'});h.records[0].listPrice=130;};
        const job=h.job([{code:'A1',price:150}]);
        await assert.rejects(h.context.priceTest.runProductPriceJobBatch(job),mode==='conflict'?/其他操作修改/:/permission-denied/);
        assert.equal(h.writes.length,0);assert.equal(job.cursor,0);assert.equal(h.saved.length,0);
    }
});

test('full master handler validates entire file before cloud preview and only previews the bounded chunk', () => {
    const handler = source.slice(source.indexOf('window.handlePriceExcelUpload ='), source.indexOf('// ===== 2026-10-02：手機功能選單', source.indexOf('window.handlePriceExcelUpload =')));
    assert.ok(handler.includes('if (importErrors.length)'));
    assert.ok(handler.indexOf('if (importErrors.length)') < handler.indexOf("confirmProductMasterImport(chunkGroups)"));
    assert.ok(handler.includes('confirmProductMasterImport(chunkGroups)'));
    assert.ok(!handler.includes('confirmProductMasterImport(brandGroups, importErrors)'));
    assert.ok(handler.includes('crypto.subtle.digest'));
    assert.ok(handler.includes('existingJob.fingerprint === fingerprint'));
    assert.ok(handler.includes('await saveProductPriceJob(job)'));
    assert.ok(!handler.includes('rows:allImportedItems'));
});

test('master upload handles 1001 rows in same-day 1000/1 batches, interruption, replacement and duplicate validation',async()=>{
 const h=createHarness();const c=h.context;let checkpoint=null,loaded,fail=false,allowReplace=true;
 let rows=Array.from({length:1001},(_,i)=>({'貨號':`A${i}`,'廠牌':'Bio-Rad','英文品名':`Product ${i}`,'建議售價':100}));
 const records=new Map(),batches=[],errors=[];
 Object.assign(c,{
  pendingPriceListUploadBrand:'',brandProductDeleteRunning:false,productMasterMigrationRunning:false,
  setProductBatchMaintenanceBusy:()=>{},ensureXlsxLoaded:async()=>{},
  FileReader:class {readAsArrayBuffer(){loaded=this.onload({target:{result:new Uint8Array([1])}});}},
  XLSX:{read:()=>({SheetNames:['master'],Sheets:{master:rows}})},
  isProductImportPlaceholderCode:()=>false,resolveBrandName:x=>x,normalizeImportedProductCode:(_,x)=>x,
  normalizeProductTypeValue:()=> 'Goods',stableProductId:x=>x.model,
  crypto:{subtle:{digest:async()=>new Uint8Array([rows.length%256])}},
  withProductPriceImportLock:fn=>fn(),productImportJobScope:()=> 'demo-yushin:staff-1:master',
  readProductPriceJob:async()=>checkpoint&&structuredClone(checkpoint),
  saveProductPriceJob:async job=>{checkpoint=structuredClone(job);},
  confirm:()=>allowReplace,
  confirmProductMasterImport:async(groups,errors=[])=>{if(errors.length){errors.forEach(x=>batches.push(x));return false;}batches.push(groups.flatMap(g=>g.imported).length);return true;},
  pendingPriceImportPreview:{importState:{}},
  saveProductMasterBrand:async(items,brand)=>{
   let writes=0;for(const item of items){if(!records.has(item.model)){records.set(item.model,item);writes++;}if(fail){fail=false;throw Error('network interrupted');}}
   return {brand,items,productWrites:writes,costWrites:0,unchangedRows:items.length-writes};
  },
  productItemWithoutCost:x=>x,markPriceListImportComplete:async()=>{},
  renderPriceBrandOptions:()=>{},renderCompanyAgencyBrandSettings:()=>{},loadProductManagementOverview:()=>{},
  invalidateVisibleProductCosts:()=>{},purchaseCostCache:new Map(),
  alert:x=>errors.push(x),activeProductImportBatch:null
 });
 const start=source.indexOf('window.handlePriceExcelUpload =');
 vm.runInContext(source.slice(start,source.indexOf('// ===== 2026-10-02：手機功能選單',start)),c);
 async function upload(){await c.window.handlePriceExcelUpload({files:[{name:'Bio-Rad.xlsx'}],value:'file'});await loaded;}
 fail=true;await upload();assert.equal(checkpoint.cursor,0);assert.equal(records.size,1);assert.match(errors.pop(),/network interrupted/);
 await upload();assert.equal(checkpoint.cursor,1000);assert.equal(records.size,1000);
 await upload();assert.equal(checkpoint.cursor,1001);assert.equal(records.size,1001);
 assert.deepEqual(batches,[1000,1000,1]);
 await upload();assert.equal(checkpoint.cursor,1000);assert.equal(records.size,1001); // complete file starts fresh and compares existing data
 rows=[{'貨號':'NEW','廠牌':'Bio-Rad'}];allowReplace=false;
 await upload();assert.equal(checkpoint.total,1001);assert.equal(records.has('NEW'),false);
 allowReplace=true;await upload();assert.equal(checkpoint.total,1);assert.equal(records.has('NEW'),true);
 rows=[{'貨號':'DUP','廠牌':'Bio-Rad'},{'貨號':'DUP','廠牌':'Bio-Rad'}];
 await upload();assert.match(batches.at(-1),/重複出現/);assert.equal(records.has('DUP'),false);
});
