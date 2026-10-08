const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function setup(){
 const nodes={productManagementSearchBrand:{value:'Brand'},productManagementSearch:{value:'test'},productManagementSearchBtn:{},productManagementSearchStatus:{}};
 const records=Array.from({length:125},(_,i)=>({id:String(i),data:()=>({brandName:i<75?'Brand':'Other',productName:'test',manufacturerPartNo:`P${i}`})}));
 const calls=[];
 const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]},currentUser:{uid:'u'},currentUserRole:'sales',
  productManagementSearchInProgress:false,productManagementSearchGeneration:0,productManagementSearchTimer:null,
  PRODUCT_MANAGEMENT_RENDER_STEP:50,productManagementVisibleLimit:50,productManagementResults:[],
  canAccessPage:()=>true,canManagePendingProductMaster:()=>false,clearTimeout:()=>{},renderProductBrandBrowser:()=>{},renderProductManagementResults:()=>{},updateProductManagementMoreButton:()=>{},
  normalizeItemCodeLoose:s=>String(s).toLowerCase(),resolveBrandName:s=>s,dedupeBrandsCaseInsensitive:x=>x,brandMasterEntryForName:()=>({aliases:[]}),
  firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},firestoreReadWithTimeout:p=>p,
  db:{collection:()=>{let brand,limit,cursor;const q={where:(field,op,value)=>{assert.equal(field,'brandName');brand=value;return q;},orderBy:()=>q,limit:n=>{limit=n;return q;},startAfter:d=>{cursor=d;return q;},get:async()=>{assert.equal(limit,50);const filtered=records.filter(d=>d.data().brandName===brand);const start=cursor?filtered.findIndex(d=>d.id===cursor.id)+1:0;const docs=filtered.slice(start,start+limit);calls.push(docs.length);return {docs,size:docs.length};}};return q;}}
 });
 vm.runInContext(source.slice(source.indexOf('const productManagementSearchCache ='),source.indexOf('function ensureProductMasterEditor')),c);
 return {c,nodes,calls};
}
test('brand is required; input queue never reads; explicit search reads only 50 selected-brand documents',async()=>{
 const x=setup();x.c.window.queueProductManagementSearch();assert.equal(x.calls.length,0);
 x.nodes.productManagementSearchBrand.value='';await x.c.window.searchProductManagement();assert.equal(x.calls.length,0);
 x.nodes.productManagementSearchBrand.value='Brand';await x.c.window.searchProductManagement();assert.deepEqual(x.calls,[50]);assert.equal(x.c.productManagementResults.length,50);
 await x.c.window.searchProductManagement();assert.deepEqual(x.calls,[50]);
 await x.c.window.searchProductManagement(true);assert.deepEqual(x.calls,[50,25]);assert.equal(x.c.productManagementResults.length,75);
 await x.c.window.searchProductManagement(true);assert.deepEqual(x.calls,[50,25]);
});
test('empty results are cached without rereading the database',async()=>{
 const x=setup();x.nodes.productManagementSearchBrand.value='Missing';await x.c.window.searchProductManagement();await x.c.window.searchProductManagement();assert.deepEqual(x.calls,[0]);
});
