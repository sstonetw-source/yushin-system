const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const productSource=fs.readFileSync('src/features/products/product-management.js','utf8'),orderSource=fs.readFileSync('src/features/orders/order-creation.js','utf8');
test('new order day uses local calendar fields, including midnight and month transitions',()=>{
 const c=vm.createContext({});vm.runInContext(orderSource.slice(orderSource.indexOf('function currentOrderCreationDate('),orderSource.indexOf('function populateOrderOwnerSelect(')),c);
 for(const [date,expected] of [[new Date(2026,9,26,0,1),'2026-10-26'],[new Date(2026,9,27,0,1),'2026-10-27'],[new Date(2027,0,1,0,1),'2027-01-01']])assert.equal(c.currentOrderCreationDate(date),expected);
 assert.doesNotMatch(orderSource,/orderDate:\s*document.getElementById\('orderDateInput'\).value/);
 assert.doesNotMatch(orderSource,/orderDateInput'\).value=draft.date/);
});
function fixture(){
 const nodes={productSearchBrandButtons:{innerHTML:''},productManagementSearchBrand:{value:''}},calls=[];
 const products=Array.from({length:51},(_,i)=>({id:'P'+i,data:()=>({brandName:i===0?'test':'Vendor'+i,source:'QUICK_CREATE',active:i!==1,status:i===1?'INACTIVE':'TEMPORARY'})}));
 const c=vm.createContext({window:{},currentUser:{uid:'U'},currentUserRole:'sales',sessionDataGeneration:1,productManagementResults:[],canAccessPage:()=>true,
  document:{getElementById:id=>nodes[id]},getUnifiedBrandEntries:()=>[{name:'Primary',active:true}],getPrimaryBrandNames:()=>['Primary'],normalizeBrandLookupKey:x=>String(x).toLowerCase(),resolveBrandName:x=>String(x).trim(),escapeHtml:x=>x,inlineJsValue:JSON.stringify,updateProductSearchControls(){},firestoreReadWithTimeout:p=>p,
  db:{collection:name=>{assert.equal(name,'products');let cursor;return {where(field,op,value){assert.deepEqual([field,op,value],['source','==','QUICK_CREATE']);return this;},limit(n){assert.equal(n,50);return this;},startAfter(doc){cursor=doc;return this;},async get(){const offset=cursor?products.findIndex(p=>p.id===cursor.id)+1:0;const docs=products.slice(offset,offset+50);calls.push(docs.length);return {docs,size:docs.length};}};}}
 });
 vm.runInContext(productSource.slice(productSource.indexOf('const quickProductBrowserBrands'),productSource.indexOf('async function ensureProductBrandBrowserLoaded')),c);c.renderProductBrandBrowser=c.window.renderProductBrandBrowser;
 return {c,nodes,calls};
}
test('Other discovers quick-created test brand with bounded, cached pages and excludes inactive products',async()=>{
 const {c,nodes,calls}=fixture();c.renderProductBrandBrowser();assert.deepEqual(calls,[]);assert.match(nodes.productSearchBrandButtons.innerHTML,/其他/);
 await c.loadQuickProductBrowserBrands();c.window.toggleProductSearchOtherBrands();assert.deepEqual(calls,[50]);assert.match(nodes.productSearchBrandButtons.innerHTML,/test/);assert.doesNotMatch(nodes.productSearchBrandButtons.innerHTML,/Vendor1</);assert.match(nodes.productSearchBrandButtons.innerHTML,/載入更多/);
 await c.loadQuickProductBrowserBrands();assert.deepEqual(calls,[50]);await c.loadQuickProductBrowserBrands(true);assert.deepEqual(calls,[50,1]);assert.doesNotMatch(nodes.productSearchBrandButtons.innerHTML,/載入更多/);
 c.currentUser={uid:'V'};c.renderProductBrandBrowser();assert.doesNotMatch(nodes.productSearchBrandButtons.innerHTML,/>test</);
 c.canAccessPage=()=>false;await c.loadQuickProductBrowserBrands();assert.deepEqual(calls,[50,1]);
});
