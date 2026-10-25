const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const feature=fs.readFileSync('src/features/products/frequent-products.js','utf8');
function fixture(){
 const records=Array.from({length:45},(_,i)=>({id:String(i).padStart(2,'0'),data:()=>({brandName:i<40?'B':'C',isFrequentlySold:i!==0,active:i!==1,manufacturerPartNo:'P'+i,productName:'Name',listPrice:100,standardCost:999})}));
 const nodes={productManagementSearch:{value:''},productManagementSearchStatus:{}},queries=[],writes=[],copied=[],messages=[],alerts=[];
 const control={fail:false,clipboardFail:false,wait:null,writeWait:null};
 const c=vm.createContext({window:{},currentUser:{uid:'U'},currentUserRole:'sales',Date,Map,Set,console,
  document:{getElementById:id=>nodes[id]},productManagementSearchGeneration:0,productManagementSearchInProgress:false,
  productManagementResults:[],productManagementSourceMode:'none',productManagementActiveSearch:null,productManagementSearchCache:new Map(),productManagementSelection:new Map(),
  PRODUCT_MANAGEMENT_RENDER_STEP:100,productManagementVisibleLimit:100,
  canAccessPage:()=>c.currentUserRole!=='blocked',canManagePendingProductMaster:()=>['admin','purchaser'].includes(c.currentUserRole),
  dedupeBrandsCaseInsensitive:n=>[...new Set(n)],brandMasterEntryForName:()=>({aliases:[]}),normalizeBrandLookupKey:x=>x.toLowerCase(),resolveBrandName:x=>x,isBrandPriceListActive:()=>true,
  firestoreReadWithTimeout:p=>p,renderProductManagementResults(){},updateProductSearchControls(){},updateProductManagementMoreButton(){},
  productOperationErrorMessage:(a)=>a+'失敗。',showActionFeedback:s=>messages.push(s),alert:s=>alerts.push(s),
  beginActionButton:b=>b?.disabled?null:{},endActionButton(){},
  firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},
  navigator:{clipboard:{writeText:async text=>{if(control.clipboardFail)throw Error('denied');copied.push(text);}}},
  db:{collection:name=>{assert.equal(name,'products');const filters=[];let size,cursor;
   const q={where:(...args)=>{filters.push(args);return q;},orderBy:field=>{assert.equal(field,'__name__');return q;},limit:n=>{size=n;return q;},startAfter:d=>{cursor=d;return q;},
    get:async()=>{queries.push({filters,size,cursor});if(control.wait)await control.wait;if(control.fail)throw Error('offline');
     let rows=records.filter(d=>filters.every(([key,op,value])=>op==='in'?value.includes(d.data()[key]):d.data()[key]===value));
     if(cursor)rows=rows.filter(d=>d.id>cursor.id);const docs=rows.slice(0,size);return {docs,size:docs.length};},
    doc:id=>({update:async data=>{writes.push({id,data});if(control.writeWait)await control.writeWait;if(control.fail)throw Error('offline');}})};return q;}}
 });
 vm.runInContext(feature,c);c.loadFrequentProducts=c.window.loadFrequentProducts;
 return {c,nodes,queries,writes,copied,messages,alerts,control};
}
test('brand favourites use bounded filtered pages and reuse both matches and empty results',async()=>{
 const x=fixture();await x.c.window.loadFrequentProducts('B');
 assert.equal(x.queries.length,1);assert.equal(x.queries[0].size,20);assert.deepEqual(x.queries[0].filters,[['isFrequentlySold','==',true],['brandName','==','B']]);
 assert.equal(x.c.productManagementResults.length,19);await x.c.window.loadFrequentProducts('B');assert.equal(x.queries.length,1);
 await x.c.window.loadFrequentProducts('B',true);assert.equal(x.queries.length,2);assert.equal(x.c.productManagementResults.length,38);
 await x.c.window.loadFrequentProducts('EMPTY');await x.c.window.loadFrequentProducts('EMPTY');assert.equal(x.queries.length,3);assert.match(x.nodes.productManagementSearchStatus.textContent,/尚未設定/);
});
test('brand aliases are queried together without loading an entire catalogue',async()=>{
 const x=fixture();x.c.brandMasterEntryForName=()=>({aliases:['Old B']});await x.c.window.loadFrequentProducts('B');
 assert.equal(x.queries[0].filters[1][1],'in');assert.deepEqual(Array.from(x.queries[0].filters[1][2]),['B','Old B']);
});
test('unauthorized users and empty brands make no reads; cache is isolated by actor and role',async()=>{
 const x=fixture();await x.c.window.loadFrequentProducts('');x.c.currentUserRole='blocked';await x.c.window.loadFrequentProducts('B');assert.equal(x.queries.length,0);
 x.c.currentUserRole='sales';await x.c.window.loadFrequentProducts('B');x.c.currentUserRole='engineer';await x.c.window.loadFrequentProducts('B');x.c.currentUser={uid:'OTHER'};await x.c.window.loadFrequentProducts('B');assert.equal(x.queries.length,3);
});
test('late result after role or page generation change cannot publish or cache rows',async()=>{
 for(const change of [x=>x.c.currentUserRole='purchaser',x=>x.c.productManagementSearchGeneration++]){
  const x=fixture();let finish;x.control.wait=new Promise(r=>finish=r);const pending=x.c.window.loadFrequentProducts('B');change(x);finish();await pending;assert.equal(x.c.productManagementResults.length,0);
 }
});
test('query failure is visible and a retry performs a fresh read',async()=>{
 const x=fixture();x.control.fail=true;await x.c.window.loadFrequentProducts('B');assert.match(x.nodes.productManagementSearchStatus.textContent,/失敗/);assert.equal(x.c.productManagementSearchInProgress,false);
 x.control.fail=false;await x.c.window.loadFrequentProducts('B');assert.equal(x.queries.length,2);assert.ok(x.c.productManagementResults.length);
});
test('only admin and purchaser can set company favourites; failures never change the displayed product',async()=>{
 for(const role of ['sales','engineer','warehouse','admin','purchaser']){
  const x=fixture();x.c.currentUserRole=role;x.c.productManagementResults=[{id:'P',manufacturerPartNo:'P1'}];await x.c.window.setProductFrequentlySold('P',true);
  assert.equal(x.writes.length,['admin','purchaser'].includes(role)?1:0);if(x.writes.length)assert.equal(x.writes[0].data.isFrequentlySold,true);
 }
 const x=fixture();x.c.currentUserRole='admin';x.c.productManagementResults=[{id:'P'}];x.control.fail=true;await x.c.window.setProductFrequentlySold('P',true);
 assert.equal(x.c.productManagementResults[0].isFrequentlySold,undefined);assert.equal(x.messages.length,0);assert.match(x.alerts[0],/失敗/);
});
test('duplicate clicks produce one update and removing favourites never deletes products or selections',async()=>{
 const x=fixture();x.c.currentUserRole='purchaser';x.c.productManagementSourceMode='frequent';x.c.productManagementResults=[{id:'P',isFrequentlySold:true}];x.c.productManagementSelection.set('P',{});
 let finish;x.control.writeWait=new Promise(r=>finish=r);const pending=x.c.window.setProductFrequentlySold('P',false);await x.c.window.setProductFrequentlySold('P',false);finish();await pending;
 assert.equal(x.writes.length,1);assert.equal(x.writes[0].data.isFrequentlySold,false);assert.equal(x.c.productManagementResults.length,0);assert.equal(x.c.productManagementSelection.has('P'),true);
});
test('copy uses displayed sale price and only requested public product fields without extra reads',async()=>{
 const x=fixture();x.c.productManagementResults=[{id:'P',brandName:'B',manufacturerPartNo:'P-1',productName:'Product',listPrice:1200,standardCost:999,supplier:'Secret'}];
 await x.c.window.copyProductInformation('P');assert.equal(x.copied[0],'廠牌：B\n貨號：P-1\n品名：Product\n建議售價：1,200');assert.equal(x.queries.length,0);assert.equal(x.writes.length,0);
 x.c.isBrandPriceListActive=()=>false;await x.c.window.copyProductInformation('P');assert.match(x.copied[1],/未提供/);assert.doesNotMatch(x.copied[1],/1,200|999|Secret/);
 x.control.clipboardFail=true;await x.c.window.copyProductInformation('P');assert.match(x.alerts[0],/剪貼簿/);assert.equal(x.messages.length,2);
});

test('removing a favourite cancels an older page response and keeps cached pagination free of that product',async()=>{
 const x=fixture();x.c.currentUserRole='admin';await x.c.window.loadFrequentProducts('B');
 let finish;x.control.wait=new Promise(r=>finish=r);const older=x.c.window.loadFrequentProducts('B',true);
 await x.c.window.setProductFrequentlySold('02',false);finish();await older;
 assert.equal(x.c.productManagementResults.some(row=>row.id==='02'),false);assert.equal(x.c.productManagementSearchInProgress,false);
 await x.c.window.loadFrequentProducts('B');assert.equal(x.queries.length,2);assert.equal(x.c.productManagementResults.some(row=>row.id==='02'),false);
});

test('edited or disabled products cannot remain visible in the wrong brand favourites',()=>{
 const x=fixture(),valid={brandName:'B',isFrequentlySold:true};
 assert.equal(x.c.isVisibleFrequentProduct(valid,'B'),true);
 for(const patch of [{brandName:'C'},{active:false},{status:'INACTIVE'},{isFrequentlySold:false}])assert.equal(x.c.isVisibleFrequentProduct({...valid,...patch},'B'),false);
});

test('switching brands discards the older common-list response',async()=>{
 const x=fixture();let finish;x.control.wait=new Promise(r=>finish=r);
 const older=x.c.window.loadFrequentProducts('B');
 x.c.productManagementSearchGeneration++;x.c.productManagementSearchInProgress=false;
 const newer=x.c.window.loadFrequentProducts('C');finish();await Promise.all([older,newer]);
 assert.equal(x.c.productManagementResults.length,5);assert.ok(x.c.productManagementResults.every(row=>row.brandName==='C'));
});
