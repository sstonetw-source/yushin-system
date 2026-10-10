const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const app = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function setup(products = {}, costs = {}) {
    const writes = [], queries = [];
    const normal = value => String(value || '').toLowerCase().replace(/[\s\-_.\/]+/g, '');
    const c = vm.createContext({
        normalizeItemCodeLoose:normal, normalizeBrandLookupKey:normal,
        resolveBrandName:value => /beckman/i.test(value) ? 'Beckman Coulter' : value,
        normalizeProductMasterList:rows=>rows.map(row=>({...row})),
        productMasterRecordFromItem:row=>({productId:row.productId, brandName:row.brand, manufacturerPartNo:row.model, normalizedPartNo:normal(row.model), productName:row.nameEn, active:true, status:'ACTIVE'}),
        PRODUCT_MASTER_IMPORT_FIELDS:['productId','productName','active','status'],
        productImportValueEqual:(_,a,b)=>a===b, currentUserRole:'admin', currentUser:{uid:'admin'}, activeProductImportBatch:null,
        firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}}, firestoreReadWithTimeout:p=>p,
        db:{collection:name=>({doc:id=>({name,id}),where:(field,op,ids)=>{
            queries.push({name,field,ids}); assert.ok(ids.length<=30);
            const records=name==='products'?products:costs;
            return {get:async()=>({docs:Object.entries(records).filter(([id,data])=>ids.includes(field==='__name__'?id:data.normalizedPartNo)).map(([id,data])=>({id,data:()=>data}))})};
        }})},
        commitMigrationBatch:async ops=>{ops.forEach(op=>op({set:(ref,data)=>{writes.push({ref,data});const records=ref.name==='products'?products:costs;records[ref.id]={...records[ref.id],...data};}}));}
    });
    vm.runInContext(app.slice(app.indexOf('async function loadExistingProductImportState'),app.indexOf('async function saveProductMasterBrand')),c);
    return {c,writes,queries};
}
const row=()=>({productId:'new-id',brand:'Beckman Coulter',model:'A63881',nameEn:'AMPure XP',standardCostProvided:true,standardCost:35259,listPriceProvided:true});
test('reupload updates missing cost on the existing document ID and remains idempotent',async()=>{
    const x=setup({'original-id':{productId:'original-id',brandName:'Beckman Coulter',manufacturerPartNo:'A63881',normalizedPartNo:'a63881',productName:'AMPure XP',active:true,status:'ACTIVE'}});
    const result=await x.c.syncImportedBrandToFormalProductMaster([row()],'Beckman Coulter');
    assert.equal(result.items[0].productId,'original-id');
    assert.deepEqual(x.writes.map(w=>[w.ref.name,w.ref.id]),[['productCosts','original-id']]);
    assert.equal(x.writes[0].data.standardCost,35259);
    x.writes.length=0;
    const again=await x.c.syncImportedBrandToFormalProductMaster([row()],'Beckman Coulter');
    assert.equal(again.unchangedRows,1);assert.equal(x.writes.length,0);
});
test('brand aliases and code punctuation reuse an existing ID; other brands do not match',async()=>{
    const x=setup({same:{brandName:'Beckman',manufacturerPartNo:'A-63881',normalizedPartNo:'a63881'},other:{brandName:'Other',manufacturerPartNo:'A63881',normalizedPartNo:'a63881'}});
    const rows=[row()];await x.c.resolveProductImportIdentities(rows);assert.equal(rows[0].productId,'same');
});
test('existing duplicates and duplicate file rows stop before writing any product or cost',async()=>{
    const product={brandName:'Beckman Coulter',manufacturerPartNo:'A63881',normalizedPartNo:'a63881'};
    const x=setup({a:product,b:product});
    await assert.rejects(x.c.syncImportedBrandToFormalProductMaster([row()],'Beckman Coulter'),/已有 2 筆/);assert.equal(x.writes.length,0);
    const y=setup();await assert.rejects(y.c.resolveProductImportIdentities([row(),{...row(),model:'a-63881'}]),/檔案中重複/);assert.equal(y.queries.length,0);
});
test('new products still create product and protected cost under one ID',async()=>{
    const x=setup();await x.c.syncImportedBrandToFormalProductMaster([row()],'Beckman Coulter');
    assert.deepEqual(x.writes.map(w=>[w.ref.name,w.ref.id]),[['products','new-id'],['productCosts','new-id']]);
});
test('brand summary preserves latest price-list metadata regardless of duplicate brand order',()=>{
    const plain={id:'master',name:'Beckman Coulter',active:true,aliases:[]};
    const imported={id:'import',name:'Beckman Coulter',active:true,aliases:[],priceListManaged:true,priceListFile:'Beckman.xlsx',priceListUpdatedAt:'2026-10-10T08:06:00Z',priceListProductCount:386};
    for(const masters of [[plain,imported],[imported,plain]]){
        const c=vm.createContext({unifiedBrandEntriesCache:null,brandMasterCache:masters,keyStatisticBrands:[],keyStatisticBrandAliases:{},companyAgencyBrands:{},defaultCanonicalBrandName:x=>x,normalizeBrandLookupKey:x=>String(x).toLowerCase(),defaultBrandAliasesForCanonical:()=>[],dedupeBrandsCaseInsensitive:x=>[...new Set(x)],includesBrandCaseInsensitive:()=>false});
        vm.runInContext(app.slice(app.indexOf('function getUnifiedBrandEntries('),app.indexOf('function getUnifiedBrandNames(')),c);
        const result=c.getUnifiedBrandEntries(false);assert.equal(result.length,1);assert.equal(result[0].priceListFile,'Beckman.xlsx');assert.equal(result[0].priceListProductCount,386);
    }
});
test('price-list event writes the existing brand document and history together',async()=>{
    const writes=[];let committed=false;
    const c=vm.createContext({resolveBrandName:x=>x,brandMasterEntryForName:()=>({id:'existing-brand-id'}),brandMasterDocumentId:()=> 'new-brand-id',currentUser:{uid:'admin',email:'admin@example.com'},priceListHistoryRows:[],updateBrandPriceListCache:()=>{},
        db:{collection:name=>({doc:id=>({name,id:id||'history-id'})}),batch:()=>({set:(ref,data)=>writes.push({ref,data}),commit:async()=>{committed=true;}})}});
    vm.runInContext(app.slice(app.indexOf('function priceListEventRecord('),app.indexOf('async function markPriceListImportComplete(')),c);
    await c.commitPriceListBrandEvent('Beckman Coulter','IMPORT',{priceListFile:'Beckman.xlsx'},{productCount:386});
    assert.equal(committed,true);assert.deepEqual(writes.map(w=>[w.ref.name,w.ref.id]),[['brands','existing-brand-id'],['priceHistory','history-id']]);assert.equal(c.priceListHistoryRows.length,1);
});
