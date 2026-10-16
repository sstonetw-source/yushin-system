const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/inventory-core');
const adapter=fs.readFileSync('src/infrastructure/inventory-lot-read.js','utf8'),view=fs.readFileSync('src/features/inventory/inventory-lot-view.js','utf8'),workspace=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function fixture(records=[]){
 const docs=new Map(records),queries=[],pending=[],state={fail:false,hold:null},nodes={inventorySearch:{value:''},inventorySearchStatus:{},inventoryLotSearchMoreBtn:{}};
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'admin',YushinInventory:core,firestoreReadWithTimeout:p=>p,
  document:{getElementById:id=>nodes[id]||null},escapeHtml:s=>String(s).replaceAll('<','&lt;'),inlineJsValue:s=>JSON.stringify(s).replaceAll('"','&quot;'),lotStatus:()=>'',
  renderInventoryList(){},inventorySearchGeneration:0,inventorySearchResults:[],inventorySearchLoading:false,inventorySearchActive:false,DEFAULT_LIST_LIMIT:50,
  normalizeFullHistorySearchValue:s=>String(s||'').trim().toLowerCase(),fullHistoryServerToken:s=>String(s||'').toLowerCase().slice(0,6),
  loadWarehouseStocksForInventoryPage:async()=>{},console:{error(){}},
  db:{collection:col=>{
   const filters=[];let max=Infinity,cursor=null;
   const builder={where:(field,op,value)=>{filters.push({field,op,value});return builder;},limit:value=>{max=value;return builder;},startAfter:doc=>{cursor=doc;return builder;},get:async()=>{
    const call={col,filters:plain(filters),max,cursor:cursor?.id};queries.push(call);
    if(state.fail)throw Error('offline');
    const rows=[...docs].filter(([path,data])=>path.startsWith(col+'/')&&(!cursor||path.split('/')[1]>cursor.id)&&filters.every(({field,op,value})=>op==='in'?value.includes(data[field]):op==='array-contains'?(data[field]||[]).includes(value):data[field]===value)).sort(([a],[b])=>a.localeCompare(b)).slice(0,max);
    const result={size:rows.length,empty:!rows.length,docs:rows.map(([path,data])=>({id:path.split('/')[1],data:()=>plain(data)}))};
    if(state.hold?.(call))await new Promise(resolve=>pending.push(resolve));return result;
   }};return builder;
  }}});
 c.window=c;
 vm.runInContext(workspace.slice(workspace.indexOf('async function runReadJobs('),workspace.indexOf('async function loadWarehouseStocksForInventoryPage(')),c);
 vm.runInContext(adapter,c);vm.runInContext(view,c);
 vm.runInContext(workspace.slice(workspace.indexOf('function inventoryRecordMatches('),workspace.indexOf('window.scheduleInventorySearch=')),c);
 vm.runInContext(workspace.slice(workspace.indexOf('async function runInventorySearch('),workspace.indexOf('let inventoryBrandFilterSignature')),c);
 return {c,docs,queries,state,pending,nodes};
}
function lot(id,key='P',qty=1,extra={}){return ['inventoryLots/'+id,{productKey:key,warehouseId:'W',remainingQty:qty,lotNo:'REAL',expiryDate:'2027-01-01',...extra}];}
test('operational lot projection drops all cost and source payload, sorts FEFO and filters zero balances',()=>{
 const rows=core.operationalLotRows([{id:'B',productKey:'P',warehouseId:'W',remainingQty:2,expiryDate:'2028-01-01',unitCost:123,cost:456,hidden:'secret'},
  {id:'A',productKey:'P',warehouseId:'W',remainingQty:1,expiryDate:'2027-01-01'}, {id:'Z',productKey:'P',warehouseId:'W',remainingQty:0}]);
 assert.deepEqual(rows.map(r=>r.id),['A','B']);assert.equal(JSON.stringify(rows).includes('secret'),false);assert.equal(rows[1].unitCost,undefined);
 for(const value of [-1,NaN,null,'',false])assert.throws(()=>core.operationalLotRows([{id:'X',productKey:'P',warehouseId:'W',remainingQty:value}]));
});
test('lot reader uses bounded product queries, correct lookahead cursor and no missing/duplicate page boundary',async()=>{
 const f=fixture(Array.from({length:102},(_,i)=>lot('L'+String(i).padStart(3,'0'))));
 const first=await f.c.readInventoryLotsForProducts(['P']);assert.equal(first.rows.length,100);assert.equal(first.cursor.id,'L099');assert.equal(first.hasMore,true);
 const second=await f.c.readInventoryLotsForProducts(['P'],{cursor:first.cursor});assert.equal(second.rows.length,2);assert.equal(second.hasMore,false);
 assert.equal(new Set([...first.rows,...second.rows].map(r=>r.id)).size,102);assert.equal(f.queries[0].max,101);
 assert.deepEqual(f.queries[0].filters,[{field:'productKey',op:'in',value:['P']}]);
});
test('zero-balance pages preserve cursor and partial status instead of claiming empty inventory',async()=>{
 const f=fixture(Array.from({length:102},(_,i)=>lot('L'+String(i).padStart(3,'0'),'P',i===101?2:0)));
 await f.c.loadInventoryLotsForPage([{productKey:'P',lots:[{lotNo:'STALE',qty:99}]}]);
 let state=f.c.inventoryLotViewState({productKey:'P'});assert.equal(state.complete,false);assert.equal(state.lots.length,0);assert.match(f.c.inventoryLotCellHtml({productKey:'P'}),/尚未讀完/);
 await f.c.loadMoreInventoryLots('P');state=f.c.inventoryLotViewState({productKey:'P'});assert.equal(state.complete,true);assert.equal(state.lots[0].qty,2);
});
test('normal inventory page groups 50 products into two queries and reuses loaded groups',async()=>{
 const f=fixture(),items=Array.from({length:50},(_,i)=>({productKey:'P'+i}));
 await f.c.loadInventoryLotsForPage(items);assert.equal(f.queries.length,2);assert.equal(f.queries.every(q=>q.max===101&&q.filters[0].value.length<=30),true);
 await f.c.loadInventoryLotsForPage(items);assert.equal(f.queries.length,2);
 await f.c.loadInventoryLotsForPage([{productKey:'NEW'}]);assert.equal(f.queries.length,3);
});
test('concurrent requests share one page and read failure remains retryable without stale embedded fallback',async()=>{
 const f=fixture([lot('A')]);f.state.hold=()=>true;
 const one=f.c.loadInventoryLotsForPage([{productKey:'P'}]),two=f.c.loadInventoryLotsForPage([{productKey:'P'}]);
 await new Promise(r=>setImmediate(r));assert.equal(f.queries.length,1);f.pending.shift()();await Promise.all([one,two]);
 f.c.resetInventoryLotView();f.state.hold=null;f.state.fail=true;await f.c.loadInventoryLotsForPage([{productKey:'P'}]);
 assert.match(f.c.inventoryLotCellHtml({productKey:'P',lots:[{lotNo:'FAKE',qty:99}]}),/讀取失敗/);assert.equal(f.c.inventoryLotCellHtml({productKey:'P'}).includes('FAKE'),false);
 f.state.fail=false;await f.c.loadMoreInventoryLots('P');assert.equal(f.c.inventoryLotViewState({productKey:'P'}).complete,true);
});
test('reset account and invalidation discard late pages without resurrecting old data',async()=>{
 for(const action of [f=>f.c.resetInventoryLotView(),f=>{f.c.currentUser={uid:'OTHER'};f.c.resetInventoryLotView();},f=>f.c.invalidateInventoryLotView('P')]){
  const f=fixture([lot('A')]);f.state.hold=()=>true;const pending=f.c.loadInventoryLotsForPage([{productKey:'P'}]);await new Promise(r=>setImmediate(r));
  action(f);f.pending.shift()();await pending;assert.equal(f.c.inventoryLotViewState({productKey:'P'}).lots.length,0);
 }
});
test('expiry and batch display use actual rows and escape untrusted batch labels',async()=>{
 const f=fixture([lot('A','P',2,{lotNo:'<script>'})]);await f.c.loadInventoryLotsForPage([{productKey:'P'}]);
 const html=f.c.inventoryLotCellHtml({productKey:'P',lots:[{lotNo:'STALE',qty:9}]});assert.match(html,/&lt;script>/);assert.equal(html.includes('STALE'),false);
});
test('exact batch search finds current lots despite missing embedded mirror and ignores stale mirror-only hits',async()=>{
 const f=fixture([lot('A'),['inventory/INV',{productKey:'P',itemName:'Product',searchTokens:[],lots:[]}],['inventory/OLD',{productKey:'OLD',itemName:'Other',searchTokens:['real'],lots:[{lotNo:'REAL',qty:100}]}]]);
 f.nodes.inventorySearch.value='REAL';await f.c.runInventorySearch();assert.deepEqual(plain(f.c.inventorySearchResults).map(r=>r.id),['INV']);
 assert.equal(f.queries.some(q=>q.col==='inventoryLots'&&q.filters.some(f=>f.field==='lotNo'&&f.value==='REAL')),true);
});
test('batch search is explicitly paginated and remaining batches can reveal new inventory products',async()=>{
 const records=Array.from({length:51},(_,i)=>lot('L'+String(i).padStart(3,'0'),i===50?'LAST':'P'));
 records.push(['inventory/P',{productKey:'P',itemName:'Product'}],['inventory/LAST',{productKey:'LAST',itemName:'Last'}]);
 const f=fixture(records);f.nodes.inventorySearch.value='REAL';await f.c.runInventorySearch();assert.equal(f.nodes.inventoryLotSearchMoreBtn.hidden,false);
 assert.equal(f.c.inventorySearchResults.some(r=>r.id==='LAST'),false);await f.c.loadMoreInventoryLotSearch();
 assert.equal(f.c.inventorySearchResults.some(r=>r.id==='LAST'),true);assert.equal(f.nodes.inventoryLotSearchMoreBtn.hidden,true);
});
test('date search queries current expiry and ordinary batch searches avoid the extra expiry query',async()=>{
 const f=fixture([lot('A'),['inventory/P',{productKey:'P',itemName:'Product'}]]);f.nodes.inventorySearch.value='2027-01-01';await f.c.runInventorySearch();
 assert.equal(f.c.inventorySearchResults.length,1);assert.equal(f.queries.some(q=>q.filters.some(f=>f.field==='expiryDate')),true);
});
test('late search cannot overwrite a new keyword or another actor result',async()=>{
 const f=fixture([lot('A'),['inventory/P',{productKey:'P',itemName:'Product'}]]);f.state.hold=q=>q.col==='inventory'&&q.filters.some(f=>f.field==='searchTokens');
 f.nodes.inventorySearch.value='OLD';const old=f.c.runInventorySearch();await new Promise(r=>setImmediate(r));
 f.state.hold=null;f.nodes.inventorySearch.value='REAL';await f.c.runInventorySearch();f.pending.shift()();await old;
 assert.equal(f.c.inventorySearchResults[0].productKey,'P');assert.match(f.nodes.inventorySearchStatus.textContent,/找到 1 筆/);
});
test('search permission/network failure is explicit and never presented as a successful empty result',async()=>{
 const f=fixture();f.state.fail=true;f.nodes.inventorySearch.value='REAL';await f.c.runInventorySearch();assert.match(f.nodes.inventorySearchStatus.textContent,/失敗/);
 assert.equal(f.nodes.inventorySearchStatus.textContent.includes('完成'),false);
});
test('read adapters reject invalid page sizes and query scopes before reading',async()=>{
 const f=fixture();for(const options of [{pageSize:0},{pageSize:101},{pageSize:2.5}])await assert.rejects(f.c.readInventoryLotsForProducts(['P'],options));
 await assert.rejects(f.c.readInventoryLotsForProducts([]));await assert.rejects(f.c.readInventoryLotsForProducts(Array.from({length:31},(_,i)=>'P'+i)));
 await assert.rejects(f.c.readInventoryLotMatches('x','unitCost'));assert.equal(f.queries.length,0);
});
test('warehouse stock reads also discard responses after an actor changes during lot search',async()=>{
 const f=fixture([['warehouseStocks/W__P',{productKey:'P',warehouseId:'W',onHand:10}]]);
 f.c.warehouseStockCache=new Map();f.c.warehouseMasterCache=[{id:'W'}];f.c.loadWarehouseMaster=async()=>{};f.c.inventoryCache=[];
 vm.runInContext(workspace.slice(workspace.indexOf('async function loadWarehouseStocksForInventoryPage('),workspace.indexOf('window.loadInventory=')),f.c);
 f.state.hold=()=>true;const pending=f.c.loadWarehouseStocksForInventoryPage([{productKey:'P'}]);await new Promise(r=>setImmediate(r));
 f.c.currentUser={uid:'OTHER'};f.pending.shift()();await pending;assert.equal(f.c.warehouseStockCache.size,0);
});
test('lot display and read adapters never write stock or use embedded mirror as fallback',()=>{
 assert.doesNotMatch(adapter,/runRoleTransaction|\.set\(|\.update\(|inventoryLotCosts|productCosts/);
 assert.doesNotMatch(view,/item\.lots|stock\.lots|localStorage|writeAppDataCache|runRoleTransaction/);
 assert.match(workspace,/function fefoLots\(stock\)\{return YushinInventory\.sortLotsForIssue\(inventoryLotViewState\(stock\)\.lots\)/);
 assert.match(fs.readFileSync('src/app/navigation.js','utf8'),/resetInventoryLotView\?\.\(\)/);
});
