const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function setup(){
 const nodes={productManagementSearchBrand:{value:'Brand'},productManagementSearch:{value:'P74'},productManagementSearchBtn:{},productManagementSearchStatus:{}};
 const records=Array.from({length:125},(_,i)=>({id:String(i),data:()=>({brandName:i<75?'Brand':'Other',productName:'test',manufacturerPartNo:`P${i}`})}));
 const calls=[];
 const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]},currentUser:{uid:'u'},currentUserRole:'sales',
  productManagementSearchInProgress:false,productManagementSearchGeneration:0,productBrandBrowseGeneration:0,productManagementSearchTimer:null,
  PRODUCT_MANAGEMENT_RENDER_STEP:50,productManagementVisibleLimit:50,productManagementResults:[],
  canAccessPage:()=>true,canManagePendingProductMaster:()=>false,clearTimeout:()=>{},renderProductBrandBrowser:()=>{},renderProductManagementResults:()=>{},updateProductManagementMoreButton:()=>{},updateProductSearchControls:()=>{},
  normalizeItemCodeLoose:s=>String(s).toLowerCase(),resolveBrandName:s=>s,dedupeBrandsCaseInsensitive:x=>x,brandMasterEntryForName:()=>({aliases:[]}),
  firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},firestoreReadWithTimeout:p=>p,
  db:{collection:()=>{let brand,code,limit,cursor;const q={where:(field,op,value)=>{assert.equal(op,'==');if(field==='brandName')brand=value;else {assert.equal(field,'manufacturerPartNo');code=value;}return q;},orderBy:()=>q,limit:n=>{limit=n;return q;},startAfter:d=>{cursor=d;return q;},get:async()=>{assert.equal(limit,50);const filtered=records.filter(d=>d.data().brandName===brand && d.data().manufacturerPartNo===code);const start=cursor?filtered.findIndex(d=>d.id===cursor.id)+1:0;const docs=filtered.slice(start,start+limit);calls.push(docs.length);return {docs,size:docs.length};}};return q;}}
 });
 vm.runInContext(source.slice(source.indexOf('const productManagementSearchCache ='),source.indexOf('function ensureProductMasterEditor')),c);
 return {c,nodes,calls};
}
test('exact code finds a later product without reading preceding catalogue pages; repeated searches reuse matches',async()=>{
 const x=setup();x.c.window.queueProductManagementSearch();assert.equal(x.calls.length,0);
 x.nodes.productManagementSearchBrand.value='';await x.c.window.searchProductManagement();assert.equal(x.calls.length,0);
 x.nodes.productManagementSearchBrand.value='Brand';x.nodes.productManagementSearch.value='';await x.c.window.searchProductManagement();assert.equal(x.calls.length,0);
 x.nodes.productManagementSearch.value='P74';await x.c.window.searchProductManagement();assert.deepEqual(x.calls,[1]);assert.equal(x.c.productManagementResults[0].manufacturerPartNo,'P74');
 await x.c.window.searchProductManagement();await x.c.window.searchProductManagement(true);assert.deepEqual(x.calls,[1]);
});
test('empty matches are cached; name, partial code, leading zero and punctuation are not treated as exact code',async()=>{
 const x=setup();
 for(const value of ['test','P','0P74','P-74']) {
  x.nodes.productManagementSearch.value=value;await x.c.window.searchProductManagement();await x.c.window.searchProductManagement();assert.equal(x.c.productManagementResults.length,0);
 }
 assert.deepEqual(x.calls,[0,0,0,0]);
 x.nodes.productManagementSearch.value='P100';await x.c.window.searchProductManagement();assert.equal(x.c.productManagementResults.length,0);
 x.nodes.productManagementSearchBrand.value='Other';await x.c.window.searchProductManagement();assert.equal(x.c.productManagementResults[0].manufacturerPartNo,'P100');
});
test('primary brands are visible; other brands expand locally and selection enables search',()=>{
 const nodes={productManagementSearchBrand:{value:''},productSearchBrandButtons:{innerHTML:''},productManagementSearch:{},productManagementSearchBtn:{}};
 const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]},productManagementSearchInProgress:false,
  clearProductManagementSearch:()=>{},getUnifiedBrandEntries:()=>[{name:'Beckman',active:true},{name:'OtherVendor',active:true}],
  getPrimaryBrandNames:()=>['Beckman'],normalizeBrandLookupKey:s=>s.toLowerCase(),inlineJsValue:JSON.stringify,escapeHtml:s=>s});
 vm.runInContext(source.slice(source.indexOf('function updateProductSearchControls'),source.indexOf('async function ensureProductBrandBrowserLoaded')),c);
 c.renderProductBrandBrowser=c.window.renderProductBrandBrowser;c.onProductSearchBrandChange=c.window.onProductSearchBrandChange;
 c.window.renderProductBrandBrowser();assert.match(nodes.productSearchBrandButtons.innerHTML,/Beckman/);assert.doesNotMatch(nodes.productSearchBrandButtons.innerHTML,/OtherVendor/);
 assert.equal(nodes.productManagementSearch.disabled,true);
 c.window.toggleProductSearchOtherBrands();assert.match(nodes.productSearchBrandButtons.innerHTML,/OtherVendor/);
 c.window.selectProductSearchBrand('OtherVendor');assert.equal(nodes.productManagementSearchBrand.value,'OtherVendor');assert.equal(nodes.productManagementSearch.disabled,false);assert.equal(nodes.productManagementSearchBtn.disabled,false);
 c.window.toggleProductSearchOtherBrands();assert.match(nodes.productSearchBrandButtons.innerHTML,/其他.*OtherVendor/);
});
