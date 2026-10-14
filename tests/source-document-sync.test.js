const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync('app.js','utf8');
function fixture(kind='quote'){
 const docs=new Map([['orders/O',{ownerUid:'U',status:'active',inventoryReservationStatus:'completed',sourceType:kind,sourceId:'S',sourceDocumentSyncStatus:'pending',items:[{itemId:'I',reservedQty:3}]}],
  [kind==='quote'?'quotes/S':'forecasts/S',{ownerUid:'U',status:'active',linkedDocuments:[]}]]);
 const controls={denySource:false,lostReply:false,sourceHook:null};const writes=[];let version=0;
 const clone=x=>x===undefined?undefined:structuredClone(x),put=(path,value)=>{docs.set(path,clone(value));version++;};
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'sales',DOCUMENT_TYPES:{QUOTE:'quote',FORECAST:'forecast',ORDER:'order'},BUSINESS_STATUS:{COMPLETED:'completed'},
  db:{collection:name=>({doc:id=>({path:name+'/'+id})})},firebase:{firestore:{FieldValue:{arrayUnion:(...items)=>({_union:items})}}},
  documentLink:(type,id,relation)=>({type,id,relation}),localDateString:()=> '2026-10-14',
  normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
  orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus),
  myQuotesCache:[{quoteNo:'S'}],quoteHistorySearchResults:[{quoteNo:'S'}],writeAppDataCache(){},console:{error(){}},
  runRoleTransaction:async fn=>{
   for(let retry=0;retry<5;retry++){
    let v=version;const pending=[];
    const result=await fn({get:async r=>{assert.equal(pending.length,0,'reads before writes');if(r.path!== 'orders/O'&&controls.sourceHook){const hook=controls.sourceHook;controls.sourceHook=null;hook();}return {exists:docs.has(r.path),data:()=>clone(docs.get(r.path))};},
     update:(r,p)=>pending.push([r.path,clone(p)])});
    if(v!==version)continue;
    if(controls.denySource&&pending.some(([path])=>path!=='orders/O'))throw Error('permission-denied');
    for(const [path,p] of pending){const next={...docs.get(path),...p};for(const [key,val] of Object.entries(p))if(val?._union){const old=docs.get(path)?.[key]||[];next[key]=[...old,...val._union.filter(x=>!old.some(y=>JSON.stringify(x)===JSON.stringify(y)))];}put(path,next);writes.push([path,p]);}
    if(controls.lostReply&&pending.some(([path])=>path!=='orders/O')){controls.lostReply=false;throw Error('reply lost');}
    return result;
   }
   throw Error('conflict');
  }});
 vm.runInContext(src.slice(src.indexOf('function canRetryOrderInventorySync('),src.indexOf('async function writeOrderInventorySyncState(')),c);
 vm.runInContext(src.slice(src.indexOf('function orderSourceSyncIncomplete('),src.indexOf('const pendingOrderReservationIds = new Set();')),c);
 return {c,docs,controls,writes,put,run:async data=>{const local=data||clone(docs.get('orders/O'));const error=await c.syncNewOrderSourceDocuments('O',local,'U');return {local,error};}};
}
test('source and durable completion checkpoint commit atomically for quote and Forecast without stock writes',async()=>{
 for(const kind of ['quote','forecast']){
  const f=fixture(kind),result=await f.run();assert.equal(result.error,null);assert.equal(result.local.sourceDocumentSyncStatus,'completed');
  const source=f.docs.get(kind==='quote'?'quotes/S':'forecasts/S');assert.equal(source.linkedDocuments.length,1);
  if(kind==='quote'){assert.equal(source.dealClosed,true);assert.equal(f.c.myQuotesCache[0].dealClosed,true);}
  assert.equal(f.writes.some(([path])=>path.startsWith('inventory')),false);
 }
});
test('failed source transaction keeps source unchanged and persists a retryable order error',async()=>{
 const f=fixture();f.controls.denySource=true;const before=JSON.stringify(f.docs.get('quotes/S'));const r=await f.run();
 assert.match(r.error.message,/permission/);assert.equal(JSON.stringify(f.docs.get('quotes/S')),before);
 assert.equal(r.local.sourceDocumentSyncStatus,'failed');assert.equal(r.local.inventoryReservationStatus,'completed');assert.equal(f.c.orderSourceSyncIncomplete(r.local),true);
 f.controls.denySource=false;assert.equal((await f.run(r.local)).error,null);assert.equal(f.docs.get('quotes/S').linkedDocuments.length,1);
});
test('lost completion reply and repeated source sync do not downgrade state, duplicate backlinks or change close date',async()=>{
 const f=fixture();f.put('quotes/S',{...f.docs.get('quotes/S'),dealClosedAt:'2026-09-01'});f.controls.lostReply=true;
 assert.equal((await f.run()).error,null);const before=f.writes.length;assert.equal((await f.run()).error,null);
 assert.equal(f.writes.length,before);assert.equal(f.docs.get('orders/O').sourceDocumentSyncStatus,'completed');
 assert.equal(f.docs.get('quotes/S').linkedDocuments.length,1);assert.equal(f.docs.get('quotes/S').dealClosedAt,'2026-09-01');
});
test('missing source is reported without recreating a ghost quote',async()=>{
 const f=fixture();f.docs.delete('quotes/S');const r=await f.run();assert.match(r.error.message,/已不存在/);
 assert.equal(f.docs.has('quotes/S'),false);assert.equal(r.local.sourceDocumentSyncStatus,'failed');
});
test('cancelled source or order is never revived by source sync',async()=>{
 for(const target of ['orders/O','quotes/S']){
  const f=fixture();f.put(target,{...f.docs.get(target),orderStatus:'voided'});const before=JSON.stringify(f.docs.get('quotes/S'));
  const r=await f.run();assert.match(r.error.message,/取消／作廢/);assert.equal(JSON.stringify(f.docs.get('quotes/S')),before);
  assert.notEqual(f.docs.get('orders/O').sourceDocumentSyncStatus,'completed');
 }
});
test('current order source identity wins over stale caller data; newest remarks and item facts are retained',async()=>{
 const f=fixture();const stale={...f.docs.get('orders/O'),sourceId:'OLD'};f.put('orders/O',{...f.docs.get('orders/O'),remarks:'new notes'});
 const r=await f.run(stale);assert.equal(r.local.sourceId,'S');assert.equal(r.local.remarks,'new notes');assert.equal(r.local.items[0].reservedQty,3);assert.equal(f.docs.has('quotes/OLD'),false);
});
test('pending inventory blocks source synchronization without mutating either document',async()=>{
 const f=fixture();f.put('orders/O',{...f.docs.get('orders/O'),inventoryReservationStatus:'pending'});
 const before=JSON.stringify([...f.docs]);const r=await f.run();assert.match(r.error.message,/庫存尚未/);assert.equal(JSON.stringify([...f.docs]),before);
});
test('account switch while loading source prevents source write and completion',async()=>{
 const f=fixture();f.controls.sourceHook=()=>{f.c.currentUser.uid='OTHER';};const r=await f.run();
 assert.match(r.error.message,/身份已變更/);assert.equal(f.writes.length,0);
});
test('source retry role matrix retains Forecast access boundary',()=>{
 for(const kind of ['quote','forecast']){
  const f=fixture(kind),order=f.docs.get('orders/O');
  for(const role of ['sales','engineer','purchaser','warehouse','admin']){
   f.c.currentUserRole=role;
   assert.equal(f.c.canRetrySourceDocumentSync(order),kind==='forecast'?['sales','admin'].includes(role):role!=='warehouse');
  }
 }
});
test('source-only retry is visible and reuses original retry control after inventory completed',()=>{
 const f=fixture();f.c.pendingOrderReservationIds=new Set();f.c.inlineJsValue=x=>JSON.stringify(x);
 vm.runInContext(src.slice(src.indexOf('function orderInventorySyncStatusHtml('),src.indexOf("window.addEventListener('beforeunload'")),f.c);
 assert.match(f.c.orderInventorySyncStatusHtml({id:'O',...f.docs.get('orders/O')}),/來源文件同步未完成.*重試同步/);
 assert.equal(f.c.orderInventorySyncStatusHtml({id:'O',...f.docs.get('orders/O'),status:'cancelled'}),'');
});
