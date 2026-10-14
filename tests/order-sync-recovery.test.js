const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(){
 let order={id:'O',ownerUid:'U',status:'active',inventoryReservationStatus:'pending',items:[{itemId:'I',qty:5,reservedQty:0}]},version=0,sequence=0;
 const writes=[],controls={reserve:async()=>{},beforeCommit:null,unknownStatus:null};
 const clone=x=>structuredClone(x),put=next=>{order=clone(next);version++;};
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'sales',console:{error(){}},
  db:{collection:()=>({doc:id=>({id:id||'attempt-'+(++sequence)})})},
  normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
  orderWorkIndexFields:o=>({workCategories:[o.inventoryReservationStatus]}),orderReservationSummary:o=>({reservedQty:o.items.reduce((n,i)=>n+(i.reservedQty||0),0)}),
  reserveInventoryForNewOrder:async(id,live)=>controls.reserve(id,live),
  runRoleTransaction:async fn=>{
   for(let retry=0;retry<5;retry++){
    let v,w;const result=await fn({get:async()=>{v=version;return {exists:true,data:()=>clone(order)};},update:(ref,data)=>{w=clone(data);}});
    if(controls.beforeCommit){const hook=controls.beforeCommit;controls.beforeCommit=null;hook();}
    if(v!==version)continue;
    if(w){put({...order,...w});writes.push(w);if(controls.unknownStatus===w.inventoryReservationStatus){controls.unknownStatus=null;throw Error('reply lost after commit');}}
    return result;
   }
   throw Error('conflict');
  }});
 vm.runInContext(source.slice(source.indexOf('function canRetryOrderInventorySync('),source.indexOf('function orderInventorySyncStatusHtml(')),c);
 return {c,controls,writes,put,order:()=>clone(order),sync:live=>c.synchronizeOrderInventory('O',live||clone(order),'U')};
}
test('all three initialization entrances call one synchronization orchestration without independent result writes',()=>{
 for(const [start,end] of [['async function createForecastOrdersDirectly','window.createOrderFromForecast'],['window.retryOrderInventoryReservation','// 採購主頁資料'],['window.saveNewOrder =','// 匯出指定日期區間的訂單']]){
  const body=source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  assert.match(body,/await synchronizeOrderInventory\(/);
  assert.doesNotMatch(body,/\.set\(\{\s*inventoryReservationStatus:'(completed|failed)'/);
 }
});
test('attempt identity persists on order and completion refreshes work queue from latest data',async()=>{
 const f=fixture();f.controls.reserve=async()=>f.put({...f.order(),remarks:'new notes',items:[{itemId:'I',qty:5,reservedQty:3}]});
 const local=f.order();const result=await f.sync(local);
 assert.equal(local.inventoryReservationAttemptId,'attempt-1');assert.equal(local.inventoryReservationStatus,'completed');
 assert.equal(local.remarks,'new notes');assert.equal(result.reservedQty,3);assert.deepEqual(f.order().workCategories,['completed']);
});
test('older failure cannot overwrite another successfully completed attempt',async()=>{
 const f=fixture(),old=deferred();f.controls.reserve=()=>old.promise;const local=f.order(),first=f.sync(local);await tick();
 f.controls.reserve=async()=>{};await f.sync(f.order());old.reject(Error('old offline'));await first;
 assert.equal(f.order().inventoryReservationStatus,'completed');assert.equal(local.inventoryReservationStatus,'completed');
 assert.equal(f.writes.some(w=>w.inventoryReservationStatus==='failed'),false);
});
test('older success and its catch cannot overwrite a newer failure or its error',async()=>{
 const f=fixture(),old=deferred();f.controls.reserve=()=>old.promise;const first=f.sync();await tick();
 f.controls.reserve=async()=>{throw Error('new error');};await assert.rejects(f.sync(f.order()),/new error/);
 const current=f.order();old.resolve();await assert.rejects(first,/較新的庫存同步/);
 assert.equal(f.order().inventoryReservationAttemptId,current.inventoryReservationAttemptId);assert.equal(f.order().inventoryReservationError,'new error');
 assert.equal(f.order().inventoryReservationStatus,'failed');
});
test('completion committed but response lost is recovered without marking failure or repeating reserve',async()=>{
 const f=fixture();let calls=0;f.controls.reserve=async()=>{calls++;};f.controls.unknownStatus='completed';
 await f.sync();assert.equal(f.order().inventoryReservationStatus,'completed');assert.equal(f.writes.some(w=>w.inventoryReservationStatus==='failed'),false);
 await f.sync();assert.equal(calls,1);
});
test('uncertain pending write is recoverable from its persisted attempt after a reload',async()=>{
 const f=fixture();f.controls.unknownStatus='pending';await assert.rejects(f.sync(),/reply lost/);
 const persisted=f.order();assert.equal(persisted.inventoryReservationAttemptId,'attempt-1');
 await f.sync(persisted);assert.equal(f.order().inventoryReservationStatus,'completed');assert.equal(f.order().inventoryReservationAttemptId,'attempt-2');
});
test('cancellation or void during synchronization never gains completion or failure flags',async()=>{
 for(const field of ['status','orderStatus']){
  const f=fixture();f.controls.reserve=async()=>f.put({...f.order(),[field]:'cancelled'});
  await assert.rejects(f.sync(),/取消／作廢/);assert.equal(f.order().inventoryReservationStatus,'pending');
  assert.equal(f.writes.length,1);
 }
});
test('transaction conflict rechecks cancellation before writing outcome',async()=>{
 const f=fixture();f.controls.beforeCommit=()=>f.put({...f.order(),status:'cancelled'});
 await assert.rejects(f.sync(),/取消／作廢/);assert.equal(f.writes.length,0);
});
test('stale attempt cannot start over a newer pending attempt',async()=>{
 const f=fixture(),local=f.order();f.put({...local,inventoryReservationAttemptId:'NEW'});
 await assert.rejects(f.sync(local),/較新的庫存同步/);assert.equal(f.writes.length,0);assert.equal(local.inventoryReservationAttemptId,'NEW');
});
test('switching account and forbidden roles reject synchronization before writing',async()=>{
 for(const role of ['sales','engineer','warehouse']){
  const f=fixture();f.c.currentUserRole=role;if(role!=='warehouse')f.c.currentUser.uid='OTHER';
  await assert.rejects(f.sync(),/身份已變更|無權/);assert.equal(f.writes.length,0);
 }
 const f=fixture();f.put({...f.order(),ownerUid:'OTHER'});await assert.rejects(f.sync(),/無權/);
});
test('failure persists bounded error and a subsequent retry rotates its attempt',async()=>{
 const f=fixture();f.controls.reserve=async()=>{throw Error('x'.repeat(2000));};await assert.rejects(f.sync());
 assert.equal(f.order().inventoryReservationError.length,1000);const old=f.order().inventoryReservationAttemptId;
 f.controls.reserve=async()=>{};await f.sync(f.order());assert.notEqual(f.order().inventoryReservationAttemptId,old);assert.equal(f.order().inventoryReservationError,'');
});
