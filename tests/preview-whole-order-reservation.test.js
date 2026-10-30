'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/grouped-reservation.js','utf8');
function fixture({environment='preview',enabled=false,response='applied',receiptId='order-sync-O__sync_1234567890',afterCall}={}){
 const calls=[],invalidated=[];let actor='sales1';
 const functions=()=>({httpsCallable:name=>async payload=>{
  calls.push({name,payload});afterCall?.();return {data:{status:response,receiptId}};
 }});
 const globals={YUSHIN_PREVIEW_ORDER_RESERVATION_BACKEND:enabled};
 const context=vm.createContext({APP_ENVIRONMENT:environment,
  currentUser:{get uid(){return actor;}},globalThis:globals,
  firebase:{functions,app:()=>({functions})},
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
  orderReservationBackendPreviewEnabled:()=>true,
  commitNewOrderReservationPreview:async()=>{backendCalls++;},
  registerInitialSelfOrders:async()=>{selfOrders++;},
  reserveSingleOrderItem:async()=>{oldWrites++;},console
 });
 vm.runInContext(source,context);
 await assert.rejects(context.reserveInventoryForNewOrder('O',initial,'sales1'),/較新的同步識別碼/);
 assert.equal(backendCalls,1);assert.equal(selfOrders,0);assert.equal(oldWrites,0);
});
test('new-order Preview backend runs before the legacy per-item stock writer',()=>{
 const source=fs.readFileSync('src/services/order-reservation.js','utf8');
 const preview=source.indexOf('await commitNewOrderReservationPreview(orderId,liveOrder,actorUid)');
 const legacy=source.indexOf('await reserveSingleOrderItem(orderId,liveOrder,items[i],i,actorUid)');
 assert.ok(preview>0&&legacy>preview);
 const close=source.indexOf('return {...orderReservationSummary(order),items:order.items};',preview);
 assert.ok(close>preview&&close<legacy,'Preview path must return before legacy writer');
});
