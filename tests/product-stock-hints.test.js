const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function setup() {
    let reads = 0, fail = false;
    const hint = { textContent:'', hidden:true };
    const context = vm.createContext({window:{_orderModalProductId:'chosen-brand-product'},
        document:{getElementById:id => id === 'orderWarehouseStockHint' ? hint : {value:'WAREHOUSE'}},
        warehouseStockCache:new Map(), warehouseMasterLoadPromise:Promise.resolve(),
        warehouseMasterCache:[{id:'main',warehouseName:'主倉',active:true},{id:'off',active:false}],
        loadWarehouseMaster:async()=>{}, warehouseStockDocId:(w,p)=>w+'_'+p, firestoreReadWithTimeout:p=>p,
        db:{collection:()=>({doc:id=>({get:async()=>{reads++; if(fail)throw Error('offline'); return {exists:true,id,data:()=>({onHand:10,reserved:3})};}})})}});
    vm.runInContext(source.slice(source.indexOf('const warehouseStockReadPromises'),source.indexOf('window.onOrderFulfillmentChange')),context);
    return {context,hint,reads:()=>reads,setFail:value=>fail=value};
}
test('order and multiple quote rows share precise stock reads without reserving stock',async()=>{
    const x=setup();const a={},b={};
    await Promise.all([x.context.window.refreshOrderWarehouseStock(),x.context.refreshProductStockHint(a,'chosen-brand-product'),x.context.refreshProductStockHint(b,'chosen-brand-product')]);
    assert.equal(x.reads(),1);assert.equal(x.hint.textContent,'主倉：7 可用（現有 10）');
    assert.equal(a.textContent,x.hint.textContent);assert.equal(b.textContent,x.hint.textContent);
    await x.context.refreshProductStockHint(a,'chosen-brand-product');assert.equal(x.reads(),1);
});
test('clearing the code invalidates a pending result',async()=>{
    const x=setup();let resolve;
    x.context.loadWarehouseMaster=()=>new Promise(r=>resolve=r);
    const p=x.context.refreshProductStockHint(x.hint,'old');
    x.context.clearProductStockHint(x.hint);resolve();await p;
    assert.equal(x.hint.hidden,true);assert.equal(x.hint.textContent,'');assert.equal(x.reads(),0);
});
test('failed reads show an error and are retryable rather than becoming zero stock',async()=>{
    const x=setup();x.setFail(true);await x.context.refreshProductStockHint(x.hint,'p');
    assert.match(x.hint.textContent,/查詢失敗/);x.setFail(false);
    await x.context.refreshProductStockHint(x.hint,'p');assert.match(x.hint.textContent,/7 可用/);assert.equal(x.reads(),2);
});
test('direct ship stays informational and does not read warehouse stocks',async()=>{
    const x=setup();x.context.document.getElementById=id=>id==='orderWarehouseStockHint'?x.hint:{value:'DIRECT_SHIP'};
    await x.context.window.refreshOrderWarehouseStock();assert.match(x.hint.textContent,/原廠直送/);assert.equal(x.reads(),0);
});
test('late old stock result cannot replace the newly selected product',async()=>{
    const x=setup();let release;
    x.context.db={collection:()=>({doc:id=>({get:()=>id.endsWith('_old')?new Promise(r=>release=()=>r({exists:true,id,data:()=>({onHand:99,reserved:0})})):Promise.resolve({exists:true,id,data:()=>({onHand:2,reserved:1})})})})};
    const old=x.context.refreshProductStockHint(x.hint,'old');await new Promise(r=>setImmediate(r));
    await x.context.refreshProductStockHint(x.hint,'new');release();await old;
    assert.equal(x.hint.textContent,'主倉：1 可用（現有 2）');
});
test('warehouse master failure is shown instead of interpreting stale empty masters as stock',async()=>{
    const x=setup();x.context.warehouseMasterLoadPromise=null;
    await x.context.refreshProductStockHint(x.hint,'p');assert.match(x.hint.textContent,/查詢失敗/);assert.equal(x.reads(),0);
});
