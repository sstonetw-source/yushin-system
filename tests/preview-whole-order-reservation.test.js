'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/grouped-reservation.js','utf8');
function fixture({environment='preview',enabled=false,productionEnabled=false,legacyBlocked=false,
 response='applied',receiptId='order-sync-O__sync_1234567890',afterCall,
 projectId=environment==='production'?'yu-shing-company':'preview-20135',
 disableAfterResponse=false}={}){
 const calls=[],invalidated=[];let actor='sales1';
 const functions=()=>({httpsCallable:name=>async payload=>{
  calls.push({name,payload});afterCall?.();
  if(disableAfterResponse)globals.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND=false;
  return {data:{status:response,receiptId}};
 }});
 const globals={YUSHIN_PREVIEW_ORDER_RESERVATION_BACKEND:enabled,
  YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND:productionEnabled,
  YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED:legacyBlocked};
 const context=vm.createContext({APP_ENVIRONMENT:environment,
  currentUser:{get uid(){return actor;}},globalThis:globals,
  firebase:{functions,app:()=>({functions,options:{projectId}})},
  invalidateProcurementDemandQueue:()=>invalidated.push('demand'),console});
 vm.runInContext(source,context);
 const order={inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_1234567890'};
 return {calls,invalidated,globals,order,context,setActor:x=>{actor=x;},
  run:()=>context.commitNewOrderReservationPreview('O',order,'sales1')};
}
test('whole-order Preview adapter is independently default-off and disabled in production',async()=>{
 for(const options of [{enabled:false},{environment:'production',enabled:true}]){
  const f=fixture(options);assert.equal(await f.run(),false);assert.equal(f.calls.length,0);
 }
});
test('production reservation requires its own flag and exact Firebase project, then uses only the backend',async()=>{
 for(const options of [{environment:'production',productionEnabled:false},
  {environment:'production',productionEnabled:true,legacyBlocked:false},
  {environment:'production',productionEnabled:true,legacyBlocked:true,projectId:'preview-20135'},
  {environment:'preview',productionEnabled:true,legacyBlocked:true}]){
  const f=fixture(options);assert.equal(await f.run(),false);assert.equal(f.calls.length,0);
 }
 const enabled=fixture({environment:'production',productionEnabled:true,legacyBlocked:true});
 assert.equal(await enabled.run(),true);
 assert.equal(enabled.calls.length,1);
 assert.deepEqual(Object.keys(enabled.calls[0].payload).sort(),['orderId','syncAttemptId']);
 assert.deepEqual(enabled.invalidated,['demand']);
 const ambiguous=fixture({environment:'production',productionEnabled:true,legacyBlocked:true,response:'unknown'});
 await assert.rejects(ambiguous.run(),/回覆不明確/);
 assert.equal(ambiguous.calls.length,1);
 const disabledMidFlight=fixture({environment:'production',productionEnabled:true,legacyBlocked:true,disableAfterResponse:true});
 await assert.rejects(disabledMidFlight.run(),/旗標已關閉/);
 assert.equal(disabledMidFlight.calls.length,1);
});
test('Preview sends only identity; backend is the exclusive stock and demand writer',async()=>{
 const f=fixture({enabled:true});assert.equal(await f.run(),true);
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'commitOrderReservationPreview');
 assert.deepEqual(Object.keys(f.calls[0].payload).sort(),['orderId','syncAttemptId']);
 assert.deepEqual(f.invalidated,['demand']);
});
test('backend rejection or ambiguous response fails closed without client-side fallback',async()=>{
 const f=fixture({enabled:true,response:'unknown'});
 await assert.rejects(f.run(),/回覆不明確/);assert.equal(f.calls.length,1);
 const stale=fixture({enabled:true});stale.order.inventoryReservationAttemptId='short';
 await assert.rejects(stale.run(),/識別碼/);assert.equal(stale.calls.length,0);
 const role=fixture({enabled:true});role.setActor('sales2');
 await assert.rejects(role.run(),/登入身分/);assert.equal(role.calls.length,0);
});
test('whole-order Preview accepts only the exact original operation receipt',async()=>{
 for(const receiptId of ['', 'order-sync-other__sync_1234567890', 'order-sync-O__sync_different']){
  const f=fixture({enabled:true,receiptId});
  await assert.rejects(f.run(),/原憑證不符/);
  assert.equal(f.calls.length,1);assert.deepEqual(f.invalidated,[]);
 }
});
test('turning the Preview gate off while the Callable is in flight fails closed',async()=>{
 let f;
 f=fixture({enabled:true,afterCall:()=>{f.globals.YUSHIN_PREVIEW_ORDER_RESERVATION_BACKEND=false;}});
 await assert.rejects(f.run(),/旗標已關閉/);
 assert.equal(f.calls.length,1);assert.deepEqual(f.invalidated,[]);
});
test('fresh order read cannot finish an obsolete reservation attempt or launch self-order',async()=>{
 const source=fs.readFileSync('src/services/order-reservation.js','utf8');
 const initial={inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_1234567890',
  items:[{itemId:'I',qty:1}]};
 let reads=0,backendCalls=0,selfOrders=0,oldWrites=0;
 const context=vm.createContext({
  currentUser:{uid:'sales1'},db:{collection:()=>({doc:()=>({get:async()=>({exists:true,
   data:()=>++reads===1?initial:{...initial,inventoryReservationAttemptId:'sync_newer_987654321'}})})})},
  firestoreReadWithTimeout:promise=>promise,normalizedOrderItems:o=>o.items,
  orderReservationBackendEnabled:()=>true,
  commitNewOrderReservationPreview:async()=>{backendCalls++;return true;},
  registerInitialSelfOrders:async()=>{selfOrders++;},
  reserveSingleOrderItem:async()=>{oldWrites++;},console
 });
 vm.runInContext(source,context);
 await assert.rejects(context.reserveInventoryForNewOrder('O',initial,'sales1'),/較新的同步識別碼/);
 assert.equal(backendCalls,1);assert.equal(selfOrders,0);assert.equal(oldWrites,0);
});
test('new-order Preview backend is the exclusive writer, with no legacy fallback',()=>{
 const source=fs.readFileSync('src/services/order-reservation.js','utf8');
 assert.match(source,/orderReservationBackendEnabled\(\)/);
 const preview=source.indexOf('await commitNewOrderReservationPreview(orderId,liveOrder,actorUid)');
 const stop=source.indexOf('舊版逐筆 SDK 寫入已停用');
 assert.ok(preview>stop&&stop>0,'a closed backend gate must refuse before any invocation');
 assert.equal(source.indexOf('reserveSingleOrderItem'),-1);
 assert.equal(source.indexOf('commitInitialGroupedReservationPreview'),-1);
 const close=source.indexOf('return {...orderReservationSummary(order),items:order.items};',preview);
 assert.ok(close>preview,'a confirmed backend response is the only successful path');
});
