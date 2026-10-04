const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
function section(start, end) { const a=source.indexOf(start), b=source.indexOf(end,a+start.length); assert.ok(a>=0&&b>a, start); return source.slice(a,b); }
function deferred() { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
function context(values={}) { const c=vm.createContext({window:{},console:{error(){},warn(){}},...values}); c.window=c; return c; }
function snapshot(id, data={}) { const doc={id,data:()=>data}; return {docs:[doc],size:1,empty:false,forEach:fn=>fn(doc)}; }
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('inline actions preserve apostrophes, quotes, ampersands and markup as one literal argument',()=>{
 const c=context();vm.runInContext(section('function inlineJsValue(', '\n// 早期估價單'),c);
 for(const value of ["O'Brien",'A"B&C<測試>', '\\n\"; throw Error(\"bad\"); //']) {
   const encoded=c.inlineJsValue(value); assert.ok(!encoded.includes('"'));assert.ok(!encoded.includes('<'));
   const decoded=encoded.replace(/&quot;/g,'"').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
   let actual;c.capture=x=>actual=x;vm.runInContext(`capture(${decoded})`,c);assert.equal(actual,value);
 }
});

test('parallel document jobs are bounded to four and retain input order',async()=>{
 const c=context();vm.runInContext(section('async function runReadJobs(', '\nasync function loadWarehouseStocks'),c);
 let running=0,max=0;const jobs=Array.from({length:17},(_,i)=>async()=>{running++;max=Math.max(max,running);await tick();running--;return i;});
 assert.deepEqual(Array.from(await c.runReadJobs(jobs)),Array.from({length:17},(_,i)=>i));assert.equal(max,4);
 assert.deepEqual(Array.from(await c.runReadJobs([])),[]);
});

test('cost reads share an in-flight request and a failed read remains retryable',async()=>{
 const first=deferred();let count=0;
 const c=context({currentUserRole:'admin',stableProductId:()=>'',firestoreReadWithTimeout:p=>p,db:{collection:()=>({doc:()=>({get:()=>{count++;return count===1?first.promise:Promise.resolve({exists:true,data:()=>({standardCost:37})});}})})}});
 vm.runInContext(section('const visibleProductCostCache =', '\nfunction setOrderCostFieldForProduct'),c);
 const a=c.loadVisibleProductCost({productId:'P'}),b=c.loadVisibleProductCost({productId:'P'});assert.equal(count,1);first.reject(Error('offline'));
 assert.deepEqual(await Promise.all([a,b]),[null,null]);assert.equal(await c.loadVisibleProductCost({productId:'P'}),37);assert.equal(count,2);
 assert.equal(await c.loadVisibleProductCost({productId:'P'}),37);assert.equal(count,2);
 c.invalidateVisibleProductCosts();await c.loadVisibleProductCost({productId:'P'});assert.equal(count,3);
 c.currentUserRole='sales';assert.equal(await c.loadVisibleProductCost({productId:'P'}),null);assert.equal(count,3);
});

test('changing product brands prevents the earlier response from replacing results or the cursor',async()=>{
 const responses=[deferred(),deferred()];let i=0;
 const c=context({currentUser:{uid:'U'},currentUserRole:'admin',productBrandBrowseCurrent:'A',productBrandBrowseCursor:null,productBrandBrowseHasMore:false,productManagementResults:[],productManagementVisibleLimit:50,PRODUCT_MANAGEMENT_RENDER_STEP:50,PRODUCT_BRAND_BROWSE_PAGE_SIZE:200,
 document:{getElementById:()=>null},brandMasterEntryForName:()=>null,dedupeBrandsCaseInsensitive:v=>v,canManagePendingProductMaster:()=>false,renderProductManagementResults:()=>{},firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},firestoreReadWithTimeout:p=>p});
 const query={where(){return this;},orderBy(){return this;},limit(){return this;},startAfter(){return this;},get(){return responses[i++].promise;}};c.db={collection:()=>query};
 vm.runInContext(section('let productBrandBrowseGeneration =', '\nwindow.browseProductMasterBrand'),c);
 const a=c.fetchProductBrandBrowsePage(true);c.productBrandBrowseCurrent='B';const b=c.fetchProductBrandBrowsePage(true);
 responses[1].resolve(snapshot('B1',{manufacturerPartNo:'B'}));await b;responses[0].resolve(snapshot('A1',{manufacturerPartNo:'A'}));await a;
 assert.deepEqual(Array.from(c.productManagementResults,x=>x.id),['B1']);assert.equal(c.productBrandBrowseCursor.id,'B1');
});

test('Forecast queues the latest filter and discards the stale response before changing its cursor',async()=>{
 const requests=[],controls={forecastStatusFilter:{value:'active'}};let renders=0;
 const c=context({forecastLoading:false,forecastCursor:null,forecastHasMore:true,forecastCache:[],currentUserRole:'sales',currentUserCode:'S1',currentUser:{uid:'U'},DEFAULT_LIST_LIMIT:50,
 canAccessPage:()=>true,canViewAllData:()=>false,populateForecastSalesFilter(){},populateForecastBrandFilter(){},writeAppDataCache(){},renderForecastList(){renders++;},mainPageLoadFailed(){},alert(){},document:{getElementById:id=>controls[id]},firestoreReadWithTimeout:p=>p});
 c.db={collection:()=>{const filters=[];return {orderBy(){return this;},where(...args){filters.push(args);return this;},limit(){return this;},startAfter(){return this;},get(){const d=deferred();requests.push({filters,...d});return d.promise;}};}};
 vm.runInContext(section('let forecastReloadRequested =', '\nlet forecastHistorySearchActive'),c);
 const a=c.loadForecasts(true);controls.forecastStatusFilter.value='won';await c.loadForecasts(true);requests[0].resolve(snapshot('old',{status:'active'}));await a;
 assert.equal(requests.length,2);assert.equal(renders,0);assert.equal(c.forecastCursor,null);assert.ok(requests[1].filters.some(x=>x[0]==='status'&&x[2]==='won'));
 requests[1].resolve(snapshot('new',{status:'won'}));await tick();assert.equal(renders,1);assert.equal(c.forecastCache[0].id,'new');
});

test('failed safety-stock read stays an error after the final render and can retry',async()=>{
 const controls={purchaseReplenishmentBody:{},purchaseReplenishmentStatus:{},purchaseCountReplenishment:{},purchaseReplenishmentDetails:{},purchaseReplenishmentPanel:{classList:{toggle(){}}}};let fail=true;
 const c=context({currentUser:{uid:'U'},currentUserRole:'admin',inventoryReplenishmentCache:[],inventoryReplenishmentLoading:false,document:{getElementById:id=>controls[id]},canAccessPage:()=>true,inventoryAggregateStock:()=>({}),inventoryReplenishmentPlan:()=>({needsReplenishment:false}),INVENTORY_STOCK_POLICIES:{SAFETY_STOCK:'SAFETY_STOCK'},firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},loadWarehouseStocksForInventoryPage:async()=>{},mainPageLoadFailed(){},readQueryInBatches:async()=>{if(fail)throw Error('denied');return [];},db:{collection:()=>({where(){return this;},orderBy(){return this;}})}});
 vm.runInContext(section("let inventoryReplenishmentError =", '\nwindow.removeInventoryReplenishmentReminder'),c);
 vm.runInContext(section('async function loadInventoryReplenishmentCenter(', '\nwindow.loadInventoryReplenishmentCenter='),c);
 await c.loadInventoryReplenishmentCenter();assert.match(controls.purchaseReplenishmentStatus.textContent,/讀取失敗/);assert.doesNotMatch(controls.purchaseReplenishmentStatus.textContent,/沒有需要/);assert.equal(controls.purchaseCountReplenishment.textContent,'讀取失敗');
 fail=false;await c.loadInventoryReplenishmentCenter();assert.match(controls.purchaseReplenishmentStatus.textContent,/沒有需要補貨/);
});

test('work queue includes old pending orders and updates an order that has since completed',async()=>{
 const completed={id:'old',workCategories:['complete']},pending={id:'older',workCategories:['arrival']};let batch=[{id:'old',workCategories:['ordering']}];const calls=[];
 const query={where(...v){calls.push(v);return this;},orderBy(){return this;}};
 const c=context({currentUser:{uid:'U'},currentUserRole:'admin',BUSINESS_STATUS:{ACTIVE:'active'},ordersCache:[{id:'recent',workCategories:['complete']}],canAccessPage:()=>true,canViewAllData:()=>true,db:{collection:()=>query},readQueryInBatches:async()=>batch,readDocumentsByIds:async()=>[completed],orderWorkCategories:o=>o.workCategories,writeAppDataCache(){},mainPageLoadFailed(){},document:{getElementById:()=>null}});
 vm.runInContext(section('const OPEN_ORDER_WORK_CATEGORIES =', '\nwindow.setOrderWorkFilter'),c);
 await c.loadOrderWorkQueue();assert.deepEqual(Array.from(c.ordersCache,x=>x.id).sort(),['old','recent']);
 batch=[pending];await c.loadOrderWorkQueue(true);assert.equal(c.ordersCache.find(x=>x.id==='old').workCategories[0],'complete');assert.equal(c.ordersCache.find(x=>x.id==='older').workCategories[0],'arrival');
 assert.ok(calls.some(v=>v[0]==='workCategories'&&v[1]==='array-contains-any'));
});

test('account switch prevents late work-queue results from entering the new account cache',async()=>{
 const d=deferred();const query={where(){return this;},orderBy(){return this;}};
 const c=context({currentUser:{uid:'U1'},currentUserRole:'sales',BUSINESS_STATUS:{ACTIVE:'active'},ordersCache:[],canAccessPage:()=>true,canViewAllData:()=>false,db:{collection:()=>query},readQueryInBatches:()=>d.promise,orderWorkCategories:()=>['ordering'],writeAppDataCache(){},mainPageLoadFailed(){},document:{getElementById:()=>null}});
 vm.runInContext(section('const OPEN_ORDER_WORK_CATEGORIES =', '\nwindow.setOrderWorkFilter'),c);
 const p=c.loadOrderWorkQueue();c.currentUser={uid:'U2'};d.resolve([{id:'private'}]);await p;assert.equal(c.ordersCache.length,0);
});

test('document ID batch reads deduplicate IDs and preserve actual document IDs',async()=>{
 const batches=[];
 const c=context({firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},firestoreReadWithTimeout:p=>p,db:{collection:()=>({where(field,op,ids){batches.push(ids);return {get:async()=>({docs:ids.map(id=>({id,data:()=>({id:'wrong'})}))})};}})}});
 vm.runInContext(section('async function runReadJobs(', '\nasync function loadWarehouseStocks'),c);vm.runInContext(section('async function readDocumentsByIds(', '\nasync function loadInventoryAnalysisSupport'),c);
 const ids=Array.from({length:65},(_,i)=>'D'+i);const rows=await c.readDocumentsByIds('orders',[...ids,...ids]);assert.equal(batches.length,3);assert.ok(batches.every(v=>v.length<=30));assert.deepEqual(Array.from(rows,x=>x.id),ids);
});

test('page initialization coalesces requests, retries failures and refreshes expired pages',async()=>{
 const d=deferred();let calls=0;
 const c=context({currentUser:{uid:'U'},currentUserRole:'sales',loadedMainPages:new Set(),dirtyMainPages:new Set(),mainPageRefreshAt:new Map(),mainPageLoads:new Map(),MAIN_PAGE_REFRESH_MS:60000,
 hydratePageFromLocalCache(){},ensureBrandSettingsLoaded:async()=>{},canViewAllData:()=>false,canViewAllEquipment:()=>false,canAccessPage:()=>false,populateEquipmentSalesDropdown(){},loadEquipmentFromCloud:()=>{calls++;return calls===1?d.promise:Promise.resolve();}});
 vm.runInContext(section('function mainPageLoadFailed(', '\nfunction refreshVisibleMainPage'),c);vm.runInContext(section('function initializePageData(', '\nfunction ensureSalesListLoaded'),c);
 const a=c.initializePageData('equipment'),b=c.initializePageData('equipment');assert.equal(a,b);assert.equal(c.loadedMainPages.has('equipment'),false);d.reject(Error('offline'));await a;assert.equal(c.dirtyMainPages.has('equipment'),true);
 await c.initializePageData('equipment');assert.equal(calls,2);assert.equal(c.loadedMainPages.has('equipment'),true);await c.initializePageData('equipment');assert.equal(calls,2);
 c.mainPageRefreshAt.set('equipment',Date.now()-61000);await c.initializePageData('equipment');assert.equal(calls,3);
});

test('equipment export uses the active full-history search and all visible filters',async()=>{
 const rows=[];let written=0;
 const c=context({equipmentList:[],equipmentSearchActive:true,equipmentSearchResults:[{assetId:'matching',salesName:'Amy',brand:'B',state:'due'},{assetId:'wrong-brand',salesName:'Amy',brand:'C',state:'due'},{assetId:'wrong-owner',salesName:'Bob',brand:'B',state:'due'},{assetId:'wrong-status',salesName:'Amy',brand:'B',state:'ok'}],
 document:{getElementById:id=>({value:{eqSalesFilter:'Amy',eqBrandFilter:'B',eqStatusFilter:'due'}[id]})},ensureXlsxLoaded:async()=>{},getPrimaryBrandNames:()=>['B','C'],stripPhoneSuffix:x=>x,orderBrandFilterValue:x=>x,getEquipmentStatus:x=>({status:x.state,dueDate:''}),fmtDate:x=>x,getFormattedDateCode:()=> '20261004',statusLabel:{due:'到期'},alert:message=>assert.fail(message),XLSX:{utils:{json_to_sheet:data=>{rows.push(...data);return {};},book_new:()=>({}),book_append_sheet(){}},writeFile(){written++;}}});
 vm.runInContext(section('window.exportEquipmentExcel =', '\n/* ========================================================='),c);
 await c.exportEquipmentExcel();assert.equal(written,1);assert.deepEqual(rows.map(row=>row['儀器編號']),['matching']);
});

test('sales order exports are scoped in the query and validate date ranges',async()=>{
 const filters=[],rows=[],alerts=[];const controls={exportStartDate:{value:'2026-01-01'},exportEndDate:{value:'2026-10-04'}};
 const query={where(...v){filters.push(v);return this;},orderBy(){return this;}};
 const c=context({document:{getElementById:id=>controls[id]},ensureXlsxLoaded:async()=>{},currentUser:{uid:'U'},currentUserCode:'S1',canViewAllData:()=>false,db:{collection:()=>query},readQueryInBatches:async()=>[{orderDate:'2026-09-01',customerName:'included',ownerUid:'U'},{orderDate:'2025-09-01',customerName:'too-old',ownerUid:'U'}],belongsToCurrentUser:(name,uid)=>uid==='U',productLineForOrder:()=>'',orderInvoiceDate:()=>'',stripPhoneSuffix:x=>x,alert:m=>alerts.push(m),XLSX:{utils:{json_to_sheet:data=>{rows.push(...data);return {};},book_new:()=>({}),book_append_sheet(){}},writeFile(){}}});
 vm.runInContext(section('window.exportOrdersByDate =', '\n/* ========================================================='),c);
 await c.exportOrdersByDate();await tick();assert.ok(filters.some(v=>v[0]==='salesCode'&&v[2]==='S1'));assert.deepEqual(rows.map(row=>row['客戶名稱']),['included']);
 controls.exportStartDate.value='2027-01-01';await c.exportOrdersByDate();assert.match(alerts.at(-1),/起日不可晚於/);
});

test('product overview reads at most 200 products per request and continues with a cursor',async()=>{
 const reads=[],controls={productOverviewScope:{value:'',options:[]},productOverviewStatus:{}};let renders=0;
 const c=context({currentUserRole:'admin',currentUser:{uid:'U'},productOverviewLoading:false,productManagementOverviewRows:[],productOverviewLimit:200,document:{getElementById:id=>controls[id]},firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},firestoreReadWithTimeout:p=>p,getUnifiedBrandEntries:()=>[],escapeAttr:x=>x,escapeHtml:x=>x,renderProductManagementOverview:()=>renders++});
 c.db={collection:()=>{const read={};return {where(){return this;},orderBy(){return this;},limit(n){read.limit=n;return this;},startAfter(cursor){read.cursor=cursor.id;return this;},get(){reads.push(read);return Promise.resolve({docs:Array.from({length:reads.length===1?200:1},(_,i)=>({id:reads.length===1?'P'+i:'last',data:()=>({brandName:'A'})})),size:reads.length===1?200:1});}};}};
 vm.runInContext(section('let productOverviewCursor=', '\nwindow.renderProductManagementOverview'),c);
 await c.loadProductManagementOverview();assert.equal(c.productManagementOverviewRows.length,200);await c.loadProductManagementOverview(false);assert.equal(c.productManagementOverviewRows.length,201);assert.equal(reads[1].cursor,'P199');assert.ok(reads.every(r=>r.limit===200));assert.equal(renders,2);
});

test('inventory first paint does not await ledger and supply reads, and supply errors remain visible',async()=>{
 const ledger=deferred();let paints=0,failed=0;
 const c=context({inventoryLoadGeneration:0,inventoryReloadRequested:false,inventoryPendingSupplyError:'',inventoryPendingSupplyLoading:false,inventoryLoading:false,inventoryCursor:null,inventoryHasMore:true,inventoryCache:[],warehouseStockCache:new Map(),currentUser:{uid:'U'},currentUserRole:'admin',DEFAULT_LIST_LIMIT:50,canAccessPage:()=>true,readAppDataCache:()=>null,firestoreReadWithTimeout:p=>p,canReceiveInventoryCapability:()=>true,readQueryInBatches:async()=>{throw Error('offline');},loadWarehouseStocksForInventoryPage:async()=>{},writeAppDataCache(){},renderInventoryList:()=>paints++,renderInventoryLedger(){},renderPendingInventoryItems(){},mainPageLoadFailed:()=>failed++,alert:m=>assert.fail(m),document:{getElementById:()=>null}});
 c.db={collection:name=>({orderBy(){return this;},limit(){return this;},where(){return this;},get(){return name==='inventory'?Promise.resolve(snapshot('stock',{onHand:12})):ledger.promise;}})};
 vm.runInContext(section('window.loadInventory=', '\nlet businessProductSearchGeneration'),c);
 await c.loadInventory();assert.equal(paints,1);assert.equal(c.inventoryCache[0].onHand,12);assert.equal(c.inventoryPendingSupplyLoading,true);
 ledger.resolve({docs:[]});await tick();assert.equal(failed,1);assert.match(c.inventoryPendingSupplyError,/讀取失敗/);assert.equal(c.inventoryPendingSupplyLoading,false);
});

test('purchase summary is independent of the paged demand detail cache',async()=>{
 const query={where(){return this;},orderBy(){return this;}};
 const c=context({currentUser:{uid:'U'},currentUserRole:'admin',canCreatePurchaseOrderCapability:()=>true,procurementDemandCache:[{id:'first'}],procurementDemandSourceOrderCache:new Map(),db:{collection:()=>query},readQueryInBatches:async()=>Array.from({length:75},(_,i)=>({id:'D'+i,remainingToOrderQty:1})),readDocumentsByIds:async()=>[],mainPageLoadFailed(){},document:{getElementById:()=>null}});
 vm.runInContext(section('let purchaseDemandSummaryRows =', '\nfunction renderPurchasingWorkCards'),c);
 await c.loadPurchaseDemandSummary();assert.equal(vm.runInContext('purchaseDemandSummaryRows.length',c),75);assert.equal(c.procurementDemandCache.length,1);
 c.procurementDemandCache.push({id:'second'});assert.equal(vm.runInContext('purchaseDemandSummaryRows.length',c),75);
});
