const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const app = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const stock = require('../modules/stock-permissions');
function importContext(records = {}) {
    const queries = [], writes = [];
    const context = vm.createContext({
        Map, Set, Date, currentUserRole:'admin', currentUser:{uid:'admin'},
        activeProductImportBatch:{id:'batch', file:'test.xlsx', date:'now'},
        PRODUCT_MASTER_IMPORT_FIELDS:['productId','productName','status','active'],
        normalizeProductMasterList: rows=>rows,
        productMasterRecordFromItem: row=>({...row}),
        productImportValueEqual: (_, a,b)=>a===b,
        firestoreReadWithTimeout: promise=>promise,
        firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},
        db:{collection: name=>({
            where(field, op, ids) {
                assert.equal(field,'__name__'); assert.equal(op,'in'); assert.ok(ids.length<=30);
                queries.push({name,ids});
                return {get:async()=>({docs:ids.filter(id=>records[name]?.[id]).map(id=>({id,data:()=>records[name][id]}))})};
            }, doc:id=>({name,id})
        })},
        commitMigrationBatch:async ops=>{for(const op of ops)op({set:(ref,data)=>writes.push({ref,data})});}
    });
    vm.runInContext(app.slice(app.indexOf('async function loadExistingProductImportState'),app.indexOf('async function saveProductMasterBrand')),context);
    return {context,queries,writes};
}
test('large imports read only requested IDs, deduplicate, and skip absent cost fields',async()=>{
    const {context,queries}=importContext();
    const ids=Array.from({length:1201},(_,i)=>`p${i}`);
    const result=await context.loadExistingProductImportState([...ids,'p0',''],[]);
    assert.equal(queries.length,41);
    assert.deepEqual(queries.flatMap(q=>Array.from(q.ids)),ids);
    assert.ok(queries.every(q=>q.name==='products'));
    assert.equal(result.existingProducts.size,0);
});
test('unchanged import does not write per-product batch stamps; changed product retains trace',async()=>{
    const row={productId:'p1',productName:'old',active:true,status:'ACTIVE'};
    const {context,writes}=importContext({products:{p1:row}});
    let result=await context.syncImportedBrandToFormalProductMaster([row],'brand');
    assert.equal(result.unchangedRows,1);assert.equal(writes.length,0);
    result=await context.syncImportedBrandToFormalProductMaster([{...row,productName:'new'}],'brand');
    assert.equal(result.productWrites,1);assert.equal(writes[0].data.lastImportBatch,'batch');
    assert.equal(writes[0].data.productName,'new');
});
test('a failed comparison prevents product writes',async()=>{
    const {context,writes}=importContext();
    context.firestoreReadWithTimeout=async()=>{throw new Error('quota');};
    await assert.rejects(context.syncImportedBrandToFormalProductMaster([{productId:'p1'}],'brand'),/quota/);
    assert.equal(writes.length,0);
});
test('receiving page does not write mirrors, while supply mutations atomically retain sanitized mirror',async()=>{
    const loader=app.slice(app.indexOf('async function loadActiveReceivingSupplyCache'),app.indexOf('async function loadActiveReceivingSupplyCache')+5000);
    assert.doesNotMatch(loader,/syncReceivingSupplyViews|receivingSupplyOrders/);
    const writes=[];
    const ref=(name,id)=>({path:`${name}/${id}`,id});
    const db={collection:name=>({doc:id=>ref(name,id)}),runTransaction:async callback=>callback({
        get:async()=>({exists:true,data:()=>({qty:3,status:'ORDERED',unitCost:99})}),
        set:(r,d)=>writes.push({path:r.path,data:d}),update:(r,d)=>writes.push({path:r.path,data:d})
    })};
    await stock.run(db,async tx=>tx.update(ref('supplyOrders','s1'),{receivedQty:1,status:'PARTIAL_RECEIPT'}),'admin',false,'admin');
    assert.deepEqual(writes.map(w=>w.path),['supplyOrders/s1','receivingSupplyOrders/s1']);
    assert.equal(writes[1].data.qty,3);assert.equal(writes[1].data.receivedQty,1);
    assert.equal(writes[1].data.unitCost,undefined);
});
