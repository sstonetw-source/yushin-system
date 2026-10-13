const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const inventory = require('../modules/inventory-core');
const source = fs.readFileSync('app.js', 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('product details preserve transfer deductions with aggregate fallback and sum normalized warehouse availability', () => {
    const content = {};
    const c = vm.createContext({document:{getElementById:id=>id==='product360Content'?content:{}},
        warehouseMasterCache:[], inventoryNumbers:inventory.normalizeStock,
        inventoryProjectedStock:n=>n.available+n.incoming, inventoryStockPolicy:()=>'',
        inventoryStockPolicyLabel:()=>'', escapeHtml:x=>x});
    vm.runInContext(section('function renderProduct360(', 'window.openProduct360 ='), c);
    c.renderProduct360({id:'P'}, {onHand:10,reserved:2,incoming:4,transferFreeInTransit:3}, []);
    assert.match(content.innerHTML, /可用<\/span><strong>5<\/strong>/);
    assert.match(content.innerHTML, /預計庫存<\/span><strong>9<\/strong>/);
    c.renderProduct360({id:'P'}, {onHand:999}, [
        {onHand:7,reserved:2,incoming:1}, {onHand:3,reserved:0,incoming:2}
    ]);
    assert.match(content.innerHTML, /可用<\/span><strong>8<\/strong>/);
    assert.match(content.innerHTML, /預計庫存<\/span><strong>11<\/strong>/);
    c.renderProduct360({id:'P'}, {}, []);
    assert.match(content.innerHTML, /可用<\/span><strong>0<\/strong>/);
});

test('exact-code lookup finds a brand after the first page, caches complete results, and rejects ambiguous products', async () => {
    const docs=Array.from({length:76},(_,i)=>({id:String(i),data:()=>({brand:i===75?'Target':'Other',active:i!==74,model:'A-1'})}));
    const reads=[];
    let fail=false;
    const c=vm.createContext({priceList:[], productCodeMatchCache:new Map(),console:{warn(){}},
        normalizeItemCodeLoose:()=> 'a1', productMasterDocToPriceItem:doc=>({...doc.data(),productId:doc.id}),
        stableProductId:x=>x.productId, rebuildPriceItemLookup(){},firestoreReadWithTimeout:p=>p,
        normalizeBrandLookupKey:x=>x.toLowerCase(),resolveBrandName:x=>x,
        db:{collection:name=>{assert.equal(name,'products');let cursor=-1,size;const q={
            where(field,op,value){assert.deepEqual([field,op,value],['normalizedPartNo','==','a1']);return q;},
            limit(n){assert.equal(n,50);size=n;return q;},startAfter(doc){cursor=Number(doc.id);return q;},
            async get(){if(fail)throw Error('offline');const rows=docs.slice(cursor+1,cursor+1+size);reads.push(rows.length);return {docs:rows,size:rows.length};}
        };return q;}}});
    vm.runInContext(section('async function findProductsByCode(', 'function applyQuoteProductMatch('),c);
    const matches=await c.findProductsByCode('A-1',{throwOnError:true});
    assert.deepEqual(reads,[50,26]);
    assert.equal(matches.length,75);
    assert.equal(c.selectProductCodeMatch(matches,'Target').productId,'75');
    assert.equal(c.selectProductCodeMatch(matches,'Other'),null);
    await c.findProductsByCode('A-1');assert.deepEqual(reads,[50,26]);
    c.productCodeMatchCache.clear();fail=true;
    await assert.rejects(c.findProductsByCode('A-1',{throwOnError:true}),/offline/);
    assert.equal(c.productCodeMatchCache.size,0);
});

function searchFixture() {
    const nodes=Object.fromEntries(['businessProductSearchStatus','businessProductSearchResults','businessProductSearchBody','businessProductSearchMoreBtn'].map(id=>[id,{style:{},hidden:true,innerHTML:'',textContent:''}]));
    const codeDocs=Array.from({length:30},(_,i)=>({id:'P'+i,data:()=>({productName:'A'+i,manufacturerPartNo:'A1',active:i!==2})}));
    const nameDocs=Array.from({length:30},(_,i)=>({id:'P'+(i+20),data:()=>({productName:'A'+(i+20),manufacturerPartNo:'A1'})}));
    const calls=[];let failName=false,failStock=false,gate=null;
    const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]},console:{error(){}},
        currentUser:{uid:'U'},currentUserRole:'sales',canAccessPage:()=>true,
        normalizeItemCodeLoose:x=>x.toLowerCase(),firestoreReadWithTimeout:p=>p,
        inventoryNumbers:inventory.normalizeStock,inventoryProjectedStock:n=>n.available+n.incoming,
        escapeHtml:x=>x,isBrandPriceListActive:()=>true,
        db:{collection:name=>{let stream,keys,cursor,size;const q={
            where(field,op,value){if(name==='warehouseStocks'){assert.equal(op,'in');assert.ok(value.length<=25);keys=value;}else stream='code';return q;},
            orderBy(field){assert.equal(field,'productName');stream='name';return q;},startAt(){return q;},endAt(){return q;},
            limit(n){assert.equal(n,25);size=n;return q;},startAfter(doc){cursor=doc;return q;},
            async get(){calls.push({name,stream,cursor:cursor?.id,keys});if(gate)await gate;
                if(name==='warehouseStocks'){if(failStock)throw Object.assign(Error('offline'),{code:'unavailable'});return {docs:keys.map(key=>({data:()=>({productKey:key,onHand:10,reserved:2,incoming:1})}))};}
                if(stream==='name'&&failName)throw Object.assign(Error('missing index'),{code:'failed-precondition'});
                const docs=stream==='code'?codeDocs:nameDocs;const start=cursor?docs.findIndex(d=>d.id===cursor.id)+1:0;
                const page=docs.slice(start,start+size);return {docs:page,size:page.length};}
        };return q;}}});
    vm.runInContext(section('function productOperationErrorMessage(', 'function beginActionButton('),c);
    vm.runInContext(section('let businessProductSearchGeneration =', 'let inventorySearchTimer'),c);
    return {c,nodes,calls,failName:value=>failName=value,failStock:value=>failStock=value,gate:value=>gate=value};
}

test('warehouse product search pages both streams, deduplicates, batches stock reads and completes without losing results',async()=>{
    const {c,nodes,calls}=searchFixture();
    assert.equal(await c.window.searchBusinessProducts('A'),0);
    assert.equal(calls.length,0);
    assert.equal(await c.window.searchBusinessProducts('A1'),44);
    assert.equal(nodes.businessProductSearchMoreBtn.hidden,false);
    assert.equal(await c.window.loadMoreBusinessProducts(),49);
    assert.equal(nodes.businessProductSearchMoreBtn.hidden,true);
    assert.match(nodes.businessProductSearchBody.innerHTML,/A49/);
    assert.equal((nodes.businessProductSearchBody.innerHTML.match(/<tr>/g)||[]).length,49);
    assert.match(nodes.businessProductSearchBody.innerHTML,/data-th="可用">8/);
    const count=calls.length;await c.window.loadMoreBusinessProducts();assert.equal(calls.length,count);
});

test('warehouse search exposes name failures and stock failures; retry preserves cursors and committed results',async()=>{
    const f=searchFixture();f.failName(true);
    assert.equal(await f.c.window.searchBusinessProducts('A1'),0);
    assert.match(f.nodes.businessProductSearchStatus.textContent,/失敗.*重試/);
    assert.doesNotMatch(f.nodes.businessProductSearchStatus.textContent,/missing index/);
    assert.equal(f.nodes.businessProductSearchMoreBtn.textContent,'重試產品搜尋');
    f.failName(false);await f.c.window.loadMoreBusinessProducts();
    const before=f.nodes.businessProductSearchBody.innerHTML;
    f.failStock(true);await f.c.window.loadMoreBusinessProducts();
    assert.equal(f.nodes.businessProductSearchBody.innerHTML,before);
    f.failStock(false);assert.equal(await f.c.window.loadMoreBusinessProducts(),49);
});

test('duplicate warehouse search submits once and obsolete results cannot overwrite a cleared search',async()=>{
    const f=searchFixture();let release;f.gate(new Promise(resolve=>release=resolve));
    const pending=f.c.window.searchBusinessProducts('A1');
    await f.c.window.searchBusinessProducts('A1');assert.equal(f.calls.length,2);
    f.c.resetBusinessProductSearchResults();release();await pending;
    assert.equal(f.nodes.businessProductSearchBody.innerHTML,'');
    assert.equal(f.nodes.businessProductSearchResults.style.display,'none');
});

test('product errors explain access, session and connection problems without exposing technical details',()=>{
    const c=vm.createContext({});vm.runInContext(section('function productOperationErrorMessage(', 'function beginActionButton('),c);
    for(const [code,expected] of [['permission-denied',/管理員/],['unauthenticated',/重新登入/],['unavailable',/稍後重試/]]){
        const message=c.productOperationErrorMessage('產品搜尋', {code,message:'secret technical detail'});
        assert.match(message,expected);assert.doesNotMatch(message,/secret/);
    }
    assert.match(c.productOperationErrorMessage('成本更新',Error('貨號「A1」成本無效。')),/A1.*重試/);
});

test('batch failure reports only acknowledged writes and keeps remaining results uncertain',async()=>{
    let commits=0;
    const c=vm.createContext({db:{batch:()=>({commit:async()=>{commits++;if(commits===2)throw Object.assign(Error('offline'),{code:'unavailable'});}})}});
    const start=source.indexOf('async function commitMigrationBatch(');
    const end=source.indexOf('\n}',start)+2;
    vm.runInContext(source.slice(start,end),c);
    await assert.rejects(c.commitMigrationBatch(Array.from({length:5},()=>()=>{}),2),err=>{
        assert.equal(err.committedOperations,2);assert.equal(err.totalOperations,5);return true;
    });
    commits=2;
    assert.equal(await c.commitMigrationBatch(Array.from({length:5},()=>()=>{}),2),5);
});
