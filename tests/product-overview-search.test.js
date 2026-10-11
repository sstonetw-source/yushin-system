const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const code=src.slice(src.indexOf('let productOverviewCursor=null'),src.indexOf('function priceListDateLabel'));
function fixture(failure=false){
 let reads=0,brands=0,renders=0;const status={textContent:''};
 const query={orderBy(){return this},limit(n){assert.equal(n,100);return this},get:async()=>{reads++;if(failure)throw Error('offline');return {docs:[{id:'h1',data:()=>({recordType:'PRICE_LIST'})},{id:'h2',data:()=>({recordType:'PRODUCT'})}]}}};
 const c=vm.createContext({window:{},console:{error(){}},currentUserRole:'admin',productOverviewLoading:false,priceListManagementRows:[],priceListHistoryRows:[],
  document:{getElementById:()=>status},db:{collection:name=>{assert.equal(name,'priceHistory');return query}},firestoreReadWithTimeout:async p=>p,
  loadBrandMaster:async()=>{brands++},getUnifiedBrandEntries:()=>[{name:'B',active:true},{name:'Disabled',active:false}],renderProductManagementOverview:()=>{renders++},renderPriceListHistory:()=>{}});
 vm.runInContext(code,c);return {c,status,counts:()=>({reads,brands,renders})};
}
test('price list overview reads bounded history and active brands without scanning products',async()=>{
 const {c,counts}=fixture();await c.window.loadProductManagementOverview();assert.deepEqual(counts(),{reads:1,brands:1,renders:1});
 assert.equal(c.priceListManagementRows.length,1);assert.equal(c.priceListHistoryRows.length,1);assert.equal(c.productOverviewLoading,false);
});
test('history failure is visible rather than a successful empty history',async()=>{
 const {c,status,counts}=fixture(true);await c.window.loadProductManagementOverview();assert.match(status.textContent,/offline/);assert.equal(counts().renders,0);assert.equal(c.productOverviewLoading,false);
});
test('non-admin cannot fetch price list administration',async()=>{
 const {c,counts}=fixture();c.currentUserRole='sales';await c.window.loadProductManagementOverview();assert.equal(counts().reads,0);
});
