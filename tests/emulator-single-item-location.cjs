'use strict';
// Real Firestore Emulator: server-side read-only multiwarehouse v2 planner.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const demandCore=require('../modules/procurement-demand-core');
const {planSingleItemTwoWarehouse,commitSingleItemTwoWarehouse,commitSingleItemFreeStockAllocation,advanceAutomaticFreeStockAllocation,advanceReleasedV2FreeStock,drainReleasedV2FreeStock}=require('../functions/single-item-location-service');
const {commitSingleItemLocationLifecycle,commitSingleItemLocationLifecycleAndRecover}=require('../functions/single-item-location-lifecycle-service');
let app,db;
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Never use live Firestore');
 app=admin.initializeApp({projectId:'demo-yushin'},'single-location-planner');
 db=getFirestore(app);
});
test.after(async()=>{if(app)await app.delete();});
async function seed(id,{role='sales',owner='actor',a=4,b=8,company=12,inTransit=0}={}){
 const orderId='v2-order-'+id,productKey='v2-product-'+id,uid='v2-user-'+id;
 const batch=db.batch();
 const set=(collection,key,value)=>batch.set(db.collection(collection).doc(key),value);
 set('users',uid,{active:true,role});
 set('products',productKey,{productType:'Goods'});
 set('orders',orderId,{ownerUid:owner==='actor'?uid:owner,salesCode:'V2',status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'v2_123456789',
  items:[{itemId:'I1',productId:productKey,qty:10,warehouseId:'V2-A',
    deliveredQty:0,returnedQty:0,supplyOrderedQty:inTransit,receivedQty:0,reservedQty:0}]});
 set('inventory',productKey,{productKey,onHand:company,reserved:0,transferFreeInTransit:0});
 for(const [warehouseId,onHand] of [['V2-A',a],['V2-B',b]]){
   set('warehouses',warehouseId,{active:true});
   set('warehouseStocks',warehouseId+'__'+productKey,{productKey,warehouseId,
     onHand,reserved:0,transferFreeInTransit:0});
 }
 await batch.commit();
 const request={orderId,itemId:'I1',warehouseIds:['V2-A','V2-B']};
 return {orderId,productKey,uid,request,
   plan:()=>planSingleItemTwoWarehouse(db,uid,request),
   read:async(name,id)=>(await db.collection(name).doc(id).get()).data()};
}
test('read-only two-warehouse plan splits 10 into 4 and 6 with no stock writes',async()=>{
 const x=await seed('split');
 const before=await x.read('inventory',x.productKey);
 const result=await x.plan();
 assert.deepEqual(result.locations,[{warehouseId:'V2-A',reservedQty:4},{warehouseId:'V2-B',reservedQty:6}]);
 assert.equal(result.reservedQty,10);assert.equal(result.companyReservedDelta,10);
 assert.equal(result.shortageQty,0);
 assert.deepEqual(await x.read('inventory',x.productKey),before);
 assert.equal((await x.read('warehouseStocks','V2-A__'+x.productKey)).reserved,0);
 assert.equal((await db.collection('inventoryReservations').doc(x.orderId+'__I1').get()).exists,false);
});
test('company stock caps allocations; incoming stock never enters onHand',async()=>{
 const limited=await seed('company-ceiling',{company:7});
 const result=await limited.plan();
 assert.equal(result.reservedQty,7);
 assert.equal(result.companyReservedDelta,7);
 assert.equal(result.shortageQty,3);
 const incoming=await seed('in-transit',{inTransit:3});
 const proposal=await incoming.plan();
 assert.equal(proposal.reservedQty,7);
 assert.equal(proposal.shortageQty,3);
 assert.equal(proposal.remainingToOrderQty,0);
 assert.equal((await incoming.read('inventory',incoming.productKey)).reserved,0);
});
test('business owner, disabled role, and invalid warehouses are refused without writes',async()=>{
 const stranger=await seed('stranger',{owner:'someone-else'});
 await assert.rejects(stranger.plan(),/不得檢視/, 'Sales may not inspect another order');
 const off=await seed('disabled',{role:'purchaser'});
 await db.collection('users').doc(off.uid).update({active:false});
 await assert.rejects(off.plan(),/停用/);
 const custody=await seed('custody',{role:'admin'});
 await db.collection('warehouses').doc('V2-B').update({systemCustody:true});
 await assert.rejects(custody.plan(),/實體倉/);
 const invalid=await seed('bad-stock',{role:'admin',a:1});
 await db.collection('warehouseStocks').doc('V2-A__'+invalid.productKey).update({reserved:2});
 await assert.rejects(invalid.plan(),/庫存與途中帳不一致/);
});
test('cancelled and mismatched existing reservation refuse v2 preview',async()=>{
 const cancelled=await seed('cancel',{role:'purchaser'});
 await db.collection('orders').doc(cancelled.orderId).update({status:'cancelled'});
 await assert.rejects(cancelled.plan(),/已取消|結案/);
 const wrong=await seed('wrong',{role:'purchaser'});
 await db.collection('inventoryReservations').doc(wrong.orderId+'__I1').set({
  orderId:wrong.orderId,itemId:'I1',productKey:'different',quantity:0
 });
 await assert.rejects(wrong.plan(),/產品不符/);
});

function commit(x,changes={},uid=x.uid){
 return commitSingleItemTwoWarehouse(db,uid,{...x.request,attemptId:'commit_'+x.orderId,
   syncAttemptId:'v2_123456789',...changes});
}
async function snapshot(x){
 const documents=[['orders',x.orderId],['inventory',x.productKey],
  ['warehouseStocks','V2-A__'+x.productKey],['warehouseStocks','V2-B__'+x.productKey],
  ['inventoryReservations',x.orderId+'__I1']];
 const result=[];
 for(const [name,id] of documents)result.push(await x.read(name,id));
 const movements=await db.collection('inventoryMovements').where('sourceId','==',x.orderId).get();
 const receipts=await db.collection('reservationOperationReceipts').where('orderId','==',x.orderId).get();
 return {documents:result,movements:movements.docs.map(d=>d.data()),receipts:receipts.docs.map(d=>d.data())};
}
test('atomic v2 split updates authority, projections and audit once for all five roles',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const x=await seed('commit-'+role,{role});
  const result=await commit(x);
  assert.equal(result.status,'applied');assert.equal(result.reservedQty,10);
  assert.equal((await x.read('inventory',x.productKey)).reserved,10);
  assert.equal((await x.read('inventory',x.productKey)).onHand,12);
  for(const [wh,reserved] of [['V2-A',4],['V2-B',6]])
   assert.equal((await x.read('warehouseStocks',wh+'__'+x.productKey)).reserved,reserved);
  const ledger=await x.read('inventoryReservations',x.orderId+'__I1');
  assert.equal(ledger.locationSchemaVersion,2);assert.equal(ledger.quantity,10);
  assert.deepEqual(ledger.locations,result.locations);assert.equal(ledger.warehouseId,undefined);
  assert.equal((await x.read('orders',x.orderId)).items[0].reservedQty,10);
  const first=await snapshot(x);
  assert.equal(first.movements.length,2);assert.equal(first.receipts.length,1);
  assert.equal(first.receipts[0].actorUid,x.uid);assert.equal(first.receipts[0].actorRole,role);
  assert.equal((await commit(x,{warehouseIds:['V2-B','V2-A']})).status,'already-applied');
  assert.deepEqual(await snapshot(x),first);
  // Different attempt also replans from the authoritative ledger; no double hold.
  const second=await commit(x,{attemptId:'second_'+x.orderId});
  assert.equal(second.companyReservedDelta,0);
  assert.equal((await x.read('inventory',x.productKey)).reserved,10);
  assert.equal((await snapshot(x)).movements.length,2);
 }
});
test('concurrent same and different attempts never overreserve',async()=>{
 for(const same of [true,false]){
  const x=await seed('concurrent-'+same);
  const results=await Promise.all([commit(x),commit(x,same?{}:{attemptId:'other_'+x.orderId})]);
  assert.equal(results.filter(r=>r.status==='applied').length,same?1:2);
  assert.equal((await x.read('inventory',x.productKey)).reserved,10);
  assert.equal((await snapshot(x)).movements.length,2);
 }
});
test('v2 commit caps company stock and records zero-stock shortage without fictional inventory',async()=>{
 for(const company of [0,7]){
  const x=await seed('commit-cap-'+company,{company});
  const result=await commit(x);
  assert.equal(result.reservedQty,company);assert.equal(result.shortageQty,10-company);
  assert.equal((await x.read('inventory',x.productKey)).onHand,company);
  assert.equal((await x.read('inventoryReservations',x.orderId+'__I1')).quantity,company);
  assert.equal((await x.read('orders',x.orderId)).items[0].shortageQty,10-company);
 }
});
test('replay preserves completed result but rejects changed intent, changed actor or disabled user',async()=>{
 const x=await seed('commit-replay');await commit(x);
 const baseline=await snapshot(x);
 await assert.rejects(commit(x,{syncAttemptId:'different-sync'}),/其他交易/);
 await db.collection('users').doc('other-commit-actor').set({role:'admin',active:true});
 await assert.rejects(commit(x,{},'other-commit-actor'),/其他交易/);
 await db.collection('orders').doc(x.orderId).update({status:'cancelled',inventoryReservationAttemptId:'new-sync'});
 assert.equal((await commit(x)).status,'already-applied');
 assert.deepEqual((await snapshot(x)).movements,baseline.movements);
 await db.collection('users').doc(x.uid).update({active:false});
 await assert.rejects(commit(x),/停用/);
});
test('stale sync, privilege bypass, service, logistics and bad balances fail with zero partial writes',async()=>{
 const cases=[
  ['stale',async x=>db.collection('orders').doc(x.orderId).update({inventoryReservationAttemptId:'new-sync'})],
  ['complete-sync',async x=>db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'completed'})],
  ['cancel',async x=>db.collection('orders').doc(x.orderId).update({status:'結案'})],
  ['owner',async x=>db.collection('orders').doc(x.orderId).update({ownerUid:'stranger'})],
  ['service',async x=>db.collection('products').doc(x.productKey).set({type:'SERVICE'})],
  ['warehouse',async x=>db.collection('warehouses').doc('V2-B').update({active:false})],
  ['balance',async x=>db.collection('warehouseStocks').doc('V2-A__'+x.productKey).update({reserved:5})],
  ['prepared',async x=>{const o=await x.read('orders',x.orderId);o.items[0].dispatchPreparedQty=1;
    return db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['received',async x=>{const o=await x.read('orders',x.orderId);o.items[0].receivedQty=1;
    return db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['projection',async x=>{const o=await x.read('orders',x.orderId);o.items[0].reservedQty=2;
    return db.collection('orders').doc(x.orderId).update({items:o.items});}],
 ];
 for(const [name,mutate] of cases){
  const x=await seed('reject-'+name);await mutate(x);const baseline=await snapshot(x);
  await assert.rejects(commit(x),undefined,name);assert.deepEqual(await snapshot(x),baseline,name);
 }
});
test('v1 migration preserves existing holds and rejects inconsistent ownership or missing positions',async()=>{
 const x=await seed('migrate');
 const reservation=db.collection('inventoryReservations').doc(x.orderId+'__I1');
 await reservation.set({orderId:x.orderId,itemId:'I1',productKey:x.productKey,warehouseId:'V2-A',quantity:2,
  ownerUid:'stranger',salesCode:'V2'});
 const order=await x.read('orders',x.orderId);order.items[0].reservedQty=2;
 await db.collection('orders').doc(x.orderId).update({items:order.items});
 await db.collection('inventory').doc(x.productKey).update({reserved:2});
 await db.collection('warehouseStocks').doc('V2-A__'+x.productKey).update({reserved:2});
 const baseline=await snapshot(x);await assert.rejects(commit(x),/所有權/);
 assert.deepEqual(await snapshot(x),baseline);
 await reservation.update({ownerUid:x.uid});
 const result=await commit(x);assert.equal(result.companyReservedDelta,8);
 assert.equal((await x.read('warehouseStocks','V2-A__'+x.productKey)).reserved,4);
 assert.equal((await x.read('warehouseStocks','V2-B__'+x.productKey)).reserved,6);
 const after=await snapshot(x);
 await assert.rejects(commit(x,{warehouseIds:['V2-A','V2-C'],attemptId:'missing_position_attempt'}));
 assert.deepEqual(await snapshot(x),after);
});

test('competing orders share company and warehouse ceilings under transaction retries',async()=>{
 const x=await seed('competing');
 const otherId=x.orderId+'-other',order=await x.read('orders',x.orderId);
 await db.collection('orders').doc(otherId).set(order);
 const y={...x,orderId:otherId,request:{...x.request,orderId:otherId}};
 const results=await Promise.all([commit(x),commit(y)]);
 assert.equal(results.reduce((sum,r)=>sum+r.reservedQty,0),12);
 assert.equal((await x.read('inventory',x.productKey)).reserved,12);
 assert.equal((await x.read('warehouseStocks','V2-A__'+x.productKey)).reserved,4);
 assert.equal((await x.read('warehouseStocks','V2-B__'+x.productKey)).reserved,8);
});
test('late movement create collision rolls back stock, ledger, order and receipt writes',async()=>{
 const x=await seed('rollback');
 const movementId='single-v2-commit_'+x.orderId+'-V2-B';
 await db.collection('inventoryMovements').doc(movementId).set({sourceId:x.orderId,marker:'collision'});
 const baseline=await snapshot(x);
 await assert.rejects(commit(x));
 assert.deepEqual(await snapshot(x),baseline);
 await db.collection('inventoryMovements').doc(movementId).delete();
 assert.equal((await commit(x)).status,'applied');
 assert.equal((await x.read('inventory',x.productKey)).reserved,10);
});

async function readyLifecycle(name,opts={}){
 const x=await seed('lifecycle-'+name,opts);
 await commit(x);
 await db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'completed'});
 const intent=(nextStatus,operationId='lifecycle_'+name+'_'+nextStatus+'_123456789')=>({
  orderId:x.orderId,itemId:'I1',warehouseIds:['V2-A','V2-B'],nextStatus,
  operationId,syncAttemptId:'v2_123456789',date:'2026-10-17',reason:'客戶取消測試'});
 return {...x,intent,lifecycle:(nextStatus,id,actor=x.uid)=>
   commitSingleItemLocationLifecycle(db,actor,intent(nextStatus,id))};
}
test('v2 initial cancellation atomically releases A and B, then re-reserves with same ledger and no stock creation',async()=>{
 const x=await readyLifecycle('round-trip');
 assert.deepEqual((await x.read('inventoryReservations',x.orderId+'__I1')).locations,
  [{warehouseId:'V2-A',reservedQty:4},{warehouseId:'V2-B',reservedQty:6}]);
 const before=await x.read('inventory',x.productKey);
 const cancelled=await x.lifecycle('cancelled');
 assert.equal(cancelled.status,'applied');assert.equal(cancelled.companyReservedDelta,-10);
 assert.deepEqual(cancelled.locations,[]);
 assert.equal((await x.read('inventory',x.productKey)).reserved,0);
 assert.equal((await x.read('warehouseStocks','V2-A__'+x.productKey)).reserved,0);
 assert.equal((await x.read('warehouseStocks','V2-B__'+x.productKey)).reserved,0);
 const released=await x.read('inventoryReservations',x.orderId+'__I1');
 assert.equal(released.status,'released');assert.equal(released.quantity,0);assert.equal(released.shortageQty,0);
 assert.deepEqual(released.lifecycleWarehouseIds,['V2-A','V2-B']);
 assert.equal((await x.read('orders',x.orderId)).status,'cancelled');
 assert.equal((await x.lifecycle('cancelled')).status,'already-applied');
 const restored=await x.lifecycle('normal');
 assert.equal(restored.companyReservedDelta,10);assert.equal(restored.reservedQty,10);
 assert.deepEqual(restored.locations,[{warehouseId:'V2-A',reservedQty:4},{warehouseId:'V2-B',reservedQty:6}]);
 assert.equal((await x.read('inventory',x.productKey)).reserved,10);
 assert.equal((await x.read('inventory',x.productKey)).onHand,before.onHand);
 assert.equal((await x.read('orders',x.orderId)).status,'active');
 assert.equal((await x.lifecycle('normal')).status,'already-applied');
 const receipt=await x.read('reservationOperationReceipts','single-v2-lifecycle-'+x.intent('normal').operationId);
 assert.equal(receipt.actorUid,x.uid);assert.equal(receipt.result.reservedQty,10);
});
test('v2 restore only re-reserves the remaining free physical stock after a competing order',async()=>{
 const x=await readyLifecycle('competition');
 await x.lifecycle('cancelled');
 const otherId=x.orderId+'-other',oldOrder=await x.read('orders',x.orderId);
 await db.collection('orders').doc(otherId).set({...oldOrder,status:'active',orderStatus:'normal',
  inventoryReservationStatus:'pending',items:[{...oldOrder.items[0],reservedQty:0,shortageQty:0}]});
 const competing=await commitSingleItemTwoWarehouse(db,x.uid,{
  orderId:otherId,itemId:'I1',warehouseIds:['V2-A','V2-B'],
  attemptId:'another_reservation_competition_1234',syncAttemptId:'v2_123456789'});
 assert.equal(competing.reservedQty,10);
 const restored=await x.lifecycle('normal');
 assert.equal(restored.companyReservedDelta,2);
 assert.equal(restored.reservedQty,2);assert.equal(restored.shortageQty,8);
 assert.equal((await x.read('inventory',x.productKey)).reserved,12);
 assert.equal((await x.read('warehouseStocks','V2-A__'+x.productKey)).reserved,4);
 assert.equal((await x.read('warehouseStocks','V2-B__'+x.productKey)).reserved,8);
});
test('v2 lifecycle rejects unauthorized actor, stale sync, logistics, altered candidate and source projection',async()=>{
 const outsider=await readyLifecycle('outsider');
 await db.collection('users').doc('v2-nonowner').set({role:'sales',active:true});
 const baseline=await snapshot(outsider);
 await assert.rejects(outsider.lifecycle('cancelled',undefined,'v2-nonowner'),/其他業務/);
 assert.deepEqual(await snapshot(outsider),baseline);
 const noRole=await readyLifecycle('role',{role:'warehouse'});
 await assert.rejects(noRole.lifecycle('cancelled'),/權限|不能取消/);
 const changed=await readyLifecycle('stale');
 await db.collection('orders').doc(changed.orderId).update({inventoryReservationAttemptId:'different'});
 await assert.rejects(changed.lifecycle('cancelled'),/同步識別碼/);
 const prepared=await readyLifecycle('prepared');
 const order=await prepared.read('orders',prepared.orderId);
 order.items[0].dispatchPreparedQty=1;
 await db.collection('orders').doc(prepared.orderId).update({items:order.items});
 const before=await snapshot(prepared);
 await assert.rejects(prepared.lifecycle('cancelled'),/已打單|試點範圍/);
 assert.deepEqual(await snapshot(prepared),before);
 const wrong=await readyLifecycle('candidate');
 await wrong.lifecycle('cancelled');
 await assert.rejects(commitSingleItemLocationLifecycle(db,wrong.uid,{
  ...wrong.intent('normal','wrong_lifecycle_candidates_123'),warehouseIds:['V2-A','V2-C']}),/候選倉/);
 const mismatch=await readyLifecycle('projection');
 await db.collection('inventoryReservations').doc(mismatch.orderId+'__I1').update({quantity:9});
 await assert.rejects(mismatch.lifecycle('cancelled'),/投影|位置|數量/);
});
test('v2 lifecycle concurrent cancellations and receipt conflicts are atomic',async()=>{
 const x=await readyLifecycle('races');
 const [a,b]=await Promise.allSettled([
  x.lifecycle('cancelled','cancel_race_one_123456'),
  x.lifecycle('cancelled','cancel_race_two_123456')]);
 assert.equal([a,b].filter(v=>v.status==='fulfilled').length,1);
 assert.equal((await x.read('inventory',x.productKey)).reserved,0);
 const replay=await x.lifecycle('cancelled',a.status==='fulfilled'?'cancel_race_one_123456':'cancel_race_two_123456');
 assert.equal(replay.status,'already-applied');
 await assert.rejects(x.lifecycle('normal',a.status==='fulfilled'?'cancel_race_one_123456':'cancel_race_two_123456'),/操作識別碼/);
 const y=await readyLifecycle('movement-collision');
 const collidingId='cancel_collision_1234567';
 await db.collection('inventoryMovements').doc('single-v2-life-'+collidingId+'-V2-B').set({marker:'collision'});
 const before=await snapshot(y);
 await assert.rejects(y.lifecycle('cancelled',collidingId));
 assert.deepEqual(await snapshot(y),before);
 assert.equal((await db.collection('reservationOperationReceipts').doc('single-v2-lifecycle-'+collidingId).get()).exists,false);
 await db.collection('inventoryMovements').doc('single-v2-life-'+collidingId+'-V2-B').delete();
 assert.equal((await y.lifecycle('cancelled',collidingId)).status,'applied');
});

test('v2 restore rejects inactive source additions and reassigns only actual free warehouse stock',async()=>{
 const x=await readyLifecycle('inactive-restore');
 await x.lifecycle('cancelled');
 await db.collection('warehouses').doc('V2-A').update({active:false});
 const result=await x.lifecycle('normal');
 assert.deepEqual(result.locations,[{warehouseId:'V2-B',reservedQty:8}]);
 assert.equal(result.reservedQty,8);assert.equal(result.shortageQty,2);
 assert.equal((await x.read('warehouseStocks','V2-A__'+x.productKey)).reserved,0);
 assert.equal((await x.read('warehouseStocks','V2-B__'+x.productKey)).reserved,8);
 await x.lifecycle('cancelled','lifecycle_recancel_inactive_123456');
 assert.equal((await x.read('inventory',x.productKey)).reserved,0);
});
async function seedLifecycleDemand(x,patch={}){
 const order=await x.read('orders',x.orderId),item=order.items[0];
 const id=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:x.orderId,sourceItemId:'I1'});
 const ref=db.collection('procurementDemands').doc(encodeURIComponent(id));
 const record=demandCore.demandDocument({
  sourceType:'SALES_ORDER',sourceId:x.orderId,sourceItemId:'I1',sourceItemIndex:0,
  productId:x.productKey,productKey:x.productKey,warehouseId:'V2-A',
  ownerUid:x.uid,salesCode:'V2',fulfillmentType:'WAREHOUSE',requestedQty:item.shortageQty,
  orderedQty:0,receivedQty:0,status:order.status==='cancelled'?'CANCELLED':'PENDING'
 },{createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-01T00:00:00Z'});
 await ref.set({...record,...patch});
 return {ref,id,read:async()=> (await ref.get()).data()};
}
test('v2 existing canonical procurement demand closes and reopens atomically with A/B reservation',async()=>{
 const x=await readyLifecycle('demand-cycle',{company:7});
 const demand=await seedLifecycleDemand(x);
 const before=await demand.read();assert.equal(before.requestedQty,3);
 const cancelled=await x.lifecycle('cancelled');
 assert.equal(cancelled.reservedQty,0);
 const stopped=await demand.read();
 assert.equal(stopped.status,'CANCELLED');assert.equal(stopped.cancelled,true);assert.equal(stopped.remainingToOrderQty,0);
 assert.equal(stopped.requestedQty,3);assert.equal(stopped.orderedQty,0);
 assert.equal((await x.lifecycle('cancelled')).status,'already-applied');
 assert.deepEqual(await demand.read(),stopped);
 const restored=await x.lifecycle('normal');
 assert.equal(restored.reservedQty,7);assert.equal(restored.shortageQty,3);
 const reopened=await demand.read();
 assert.equal(reopened.status,'PENDING');assert.equal(reopened.cancelled,false);assert.equal(reopened.requestedQty,3);
 assert.equal(reopened.remainingToOrderQty,3);assert.equal(reopened.ownerUid,x.uid);
 assert.equal(reopened.sourceItemIndex,0);
 assert.equal((await x.read('inventory',x.productKey)).reserved,7);
 assert.equal((await x.lifecycle('normal')).status,'already-applied');
 assert.deepEqual(await demand.read(),reopened);
});
test('v2 restore creates canonical demand from new physical shortage, and cancellation without demand invents none',async()=>{
 const x=await readyLifecycle('create-demand',{company:7});
 const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:x.orderId,sourceItemId:'I1'});
 const encoded=encodeURIComponent(demandId);
 await x.lifecycle('cancelled');
 assert.equal((await db.collection('procurementDemands').doc(encoded).get()).exists,false);
 await x.lifecycle('normal');
 const demand=await x.read('procurementDemands',encoded);
 assert.equal(demand.requestedQty,3);assert.equal(demand.remainingToOrderQty,3);
 assert.equal(demand.status,'PENDING');
 const release=await x.lifecycle('cancelled','demand_created_cancel_again_12345');
 assert.equal(release.companyReservedDelta,-7);
 assert.equal((await x.read('procurementDemands',encoded)).status,'CANCELLED');
});
test('v2 procurement demand supplier commitments, identity and lifecycle projection reject without releasing stock',async()=>{
 const cases=[
  ['ordered',{orderedQty:1,requestedQty:3,remainingToOrderQty:2,status:'PARTIALLY_ORDERED'}],
  ['received',{orderedQty:1,receivedQty:1,requestedQty:3,status:'PARTIALLY_RECEIVED'}],
  ['owner',{ownerUid:'stranger'}],
  ['product',{productKey:'other'}],
  ['source',{sourceItemId:'different'}],
  ['warehouse',{warehouseId:'V2-B'}],
  ['stale',{remainingToOrderQty:999}],
  ['cancelled',{status:'CANCELLED'}],
 ];
 for(const [name,patch] of cases){
  const x=await readyLifecycle('demand-reject-'+name,{company:7});
  const demand=await seedLifecycleDemand(x,patch);
  const before=await snapshot(x),demandBefore=await demand.read();
  await assert.rejects(x.lifecycle('cancelled'),undefined,name);
  assert.deepEqual(await snapshot(x),before,name);
  assert.deepEqual(await demand.read(),demandBefore,name);
 }
 const status=await readyLifecycle('bad-status');
 await db.collection('orders').doc(status.orderId).update({orderStatus:'cancelled'});
 await assert.rejects(status.lifecycle('cancelled'),/狀態不一致/);
 const ledger=await readyLifecycle('bad-release');
 await ledger.lifecycle('cancelled');
 const snapshotBefore=await snapshot(ledger);
 await db.collection('inventoryReservations').doc(ledger.orderId+'__I1').update({shortageQty:1});
 await assert.rejects(ledger.lifecycle('normal'),/投影不一致/);
 assert.equal((await ledger.read('inventory',ledger.productKey)).reserved,0);
 assert.notDeepEqual(await snapshot(ledger),snapshotBefore);
});

// Execute the existing purchase Services against real Firestore transactions;
// only presentation/session adapters are supplied by this isolated harness.
const vm=require('node:vm'),fs=require('node:fs');
const workflow=require('../modules/workflow-core'),receiving=require('../modules/receiving-core');
function purchasingHarness(){
 const demandFor=(order,item)=>demandCore.fromSalesOrder({
  ...workflow.procurementQuantities({...item,orderedQty:item.qty,grossDeliveredQty:item.deliveredQty??0}),
  shortageQty:item.shortageQty,sourceType:'SALES_ORDER',sourceId:order.id,sourceItemId:item.itemId});
 const context=vm.createContext({currentUser:{uid:'emulator-purchaser'},currentUserRole:'purchaser',
  currentUserName:'Purchaser',canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
  db,supplyOrdersCollection:()=>db.collection('supplyOrders'),
  normalizedOrderItems:o=>o.items.map(i=>({...i})),normalizedOrderStatus:o=>o.orderStatus||'normal',
  orderInventorySyncIncomplete:o=>o.inventoryReservationStatus!=='completed',
  remainingProcurementQty:(o,i)=>demandFor({...o,id:o.id||''},i).remainingToOrderQty,
  procurementDemandForOrderItem:demandFor,YushinProcurementDemand:demandCore,YushinReceiving:receiving,
  procurementDemandRef:id=>db.collection('procurementDemands').doc(encodeURIComponent(id)),
  procurementDemandDocument:(d,meta={},dates={})=>demandCore.demandDocument({...d,...meta},dates),
  poIncomingKey:i=>i.productId||'',inventoryProductKey:i=>i.productId||'',resolveBrandName:x=>x,
  brandIdForName:()=>'',defaultWarehouse:()=>({id:'V2-A'}),orderWorkIndexFields:()=>({}),
  normalizeDocumentLinks:x=>x,documentLink:(type,id,rel)=>({type,id,rel}),DOCUMENT_TYPES:{PURCHASE_ORDER:'PURCHASE_ORDER'},
  inventoryNumbers:s=>require('../modules/inventory-core').normalizeStock(s),
  warehouseStockDocId:(w,p)=>encodeURIComponent(w)+'__'+encodeURIComponent(p),
  buildInventorySearchTokens:()=>[],isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED'].includes(String(s||'').toUpperCase()),
  runRoleTransaction:fn=>db.runTransaction(async tx=>fn(tx))
 });
 const editor=fs.readFileSync('src/features/purchasing/purchase-order-editor.js','utf8');
 vm.runInContext(editor.slice(editor.indexOf('function formalSupplyOrderId('),editor.indexOf('function poPdfFileName('))
  +fs.readFileSync('src/services/formal-purchase-order.js','utf8')
  +fs.readFileSync('src/services/supply-order.js','utf8'),context);
 return context;
}
async function purchasedLifecycle(name,{quantity=3,register=true}={}){
 const x=await readyLifecycle('supplier-'+name,{company:7}),c=purchasingHarness();
 const po={poNo:'PO-LIFE-'+name,vendorName:'Emulator Vendor',supplierName:'Emulator Vendor',
  buyerName:'Purchaser',poDate:'2026-10-17',createdAt:'2026-10-17T00:00:00Z',
  items:[{orderId:x.orderId,itemId:'I1',orderItemIndex:0,productId:x.productKey,
   qty:quantity,unitPrice:100,warehouseId:'V2-A',fulfillmentType:'WAREHOUSE',
   ownerUid:x.uid,salesCode:'V2',sourceType:'SALES_ORDER'}]};
 const purchase=await c.commitFormalPurchaseOrder(po);
 if(register)await c.registerPurchaseIncoming(po.poNo,purchase.poRecord);
 const demandId='SALES_ORDER:'+x.orderId+':I1',demandRef=db.collection('procurementDemands').doc(encodeURIComponent(demandId));
 return {...x,c,po:purchase.poRecord,supplyId:purchase.committedSupplyOrders[0].id,demandRef};
}
async function supplierSnapshot(x){
 const demand=(await x.demandRef.get()).data(),po=await x.read('purchaseOrders',x.po.poNo);
 const rows=await db.collection('supplyOrders').where('orderId','==',x.orderId).get();
 return {base:await snapshot(x),demand,po,supplies:rows.docs.map(d=>({id:d.id,...d.data()}))};
}
test('real formal PO commitment survives customer cancellation, and restore covers supplier transit only once',async()=>{
 const x=await purchasedLifecycle('retained'),before=await supplierSnapshot(x);
 assert.equal(before.demand.orderedQty,3);assert.equal(before.base.documents[1].incoming,3);
 const stopped=await x.lifecycle('cancelled');assert.equal(stopped.reservedQty,0);
 let after=await supplierSnapshot(x);
 assert.deepEqual(after.po,before.po);assert.deepEqual(after.supplies,before.supplies);
 assert.equal(after.demand.status,'CANCELLED');assert.equal(after.demand.orderedQty,3);
 assert.equal(after.demand.remainingToOrderQty,0);assert.equal(after.demand.remainingToReceiveQty,3);
 assert.equal(after.base.documents[0].items[0].supplyOrderedQty,3);
 assert.equal(after.base.documents[1].incoming,3);assert.equal(after.base.documents[1].onHand,7);
 assert.equal((await x.lifecycle('cancelled')).status,'already-applied');
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,7);assert.equal(restored.shortageQty,3);
 after=await supplierSnapshot(x);assert.equal(after.demand.status,'ORDERED');
 assert.equal(after.demand.remainingToOrderQty,0);assert.equal(after.demand.remainingToReceiveQty,3);
 assert.deepEqual(after.po,before.po);assert.deepEqual(after.supplies,before.supplies);
});
test('supplier-confirmed cancellation uses existing purchasing Service and customer restore never resurrects stopped supply',async()=>{
 const x=await purchasedLifecycle('supplier-cancel');await x.lifecycle('cancelled');
 const result=await x.c.cancelOutstandingSupplyRecord(x.po.poNo,x.supplyId,'供應商同意取消');
 assert.equal(result.cancelledQty,3);
 const supply=await x.read('supplyOrders',x.supplyId);assert.equal(supply.status,'CANCELLED');
 assert.equal((await x.read('orders',x.orderId)).items[0].supplyOrderedQty,0);
 assert.equal((await x.read('inventory',x.productKey)).incoming,0);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,7);assert.equal(restored.shortageQty,3);
 const demand=(await x.demandRef.get()).data();assert.equal(demand.status,'PENDING');
 assert.equal(demand.orderedQty,0);assert.equal(demand.remainingToOrderQty,3);assert.equal(demand.remainingToReceiveQty,0);
 assert.deepEqual(await x.read('supplyOrders',x.supplyId),supply);
});
test('partial supplier commitment, interrupted incoming registration and excess free stock do not cause duplicate reservations',async()=>{
 const x=await purchasedLifecycle('partial',{quantity:2,register:false});
 assert.equal((await x.read('inventory',x.productKey)).incoming,undefined);
 await x.lifecycle('cancelled');
 // Add real free stock in this isolated fixture so restoring must honor the PO ceiling.
 await db.collection('inventory').doc(x.productKey).update({onHand:12});
 const result=await x.lifecycle('normal');assert.equal(result.reservedQty,8);assert.equal(result.shortageQty,2);
 const demand=(await x.demandRef.get()).data();assert.equal(demand.orderedQty,2);
 assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,2);
 assert.equal((await x.read('inventory',x.productKey)).incoming,undefined);
});
test('supplier source, PO links, registered incoming and demand counter corruption reject atomically',async()=>{
 const cases=[
  ['missing-supply',x=>db.collection('supplyOrders').doc(x.supplyId).delete()],
  ['wrong-order',x=>db.collection('supplyOrders').doc(x.supplyId).update({orderId:'other-order'})],
  ['wrong-demand',x=>db.collection('supplyOrders').doc(x.supplyId).update({demandId:'other-demand'})],
  ['wrong-owner',x=>db.collection('supplyOrders').doc(x.supplyId).update({ownerUid:'other-owner'})],
  ['received',x=>db.collection('supplyOrders').doc(x.supplyId).update({receivedQty:1,status:'PARTIAL_RECEIPT'})],
  ['missing-po',x=>db.collection('purchaseOrders').doc(x.po.poNo).delete()],
  ['wrong-link',x=>db.collection('purchaseOrders').doc(x.po.poNo).update({supplyOrderIds:[]})],
  ['stopped-po',x=>db.collection('purchaseOrders').doc(x.po.poNo).update({status:'CANCELLED'})],
  ['incoming',x=>db.collection('inventory').doc(x.productKey).update({incoming:2})],
  ['wh-incoming',x=>db.collection('warehouseStocks').doc('V2-A__'+x.productKey).update({incoming:2})],
  ['demand',x=>x.demandRef.update({orderedQty:2,remainingToReceiveQty:2})],
 ];
 for(const [name,mutate] of cases){
  const x=await purchasedLifecycle('corrupt-'+name);await mutate(x);
  const before=await supplierSnapshot(x);await assert.rejects(x.lifecycle('cancelled'),undefined,name);
  assert.deepEqual(await supplierSnapshot(x),before,name);
 }
});
test('supplier cancellation racing customer restoration preserves both obligations, and lifecycle late failure rolls back all projections',async()=>{
 const x=await purchasedLifecycle('race');await x.lifecycle('cancelled');
 await Promise.all([x.lifecycle('normal'),x.c.cancelOutstandingSupplyRecord(x.po.poNo,x.supplyId,'供應商同意取消')]);
 const demand=(await x.demandRef.get()).data(),order=await x.read('orders',x.orderId);
 assert.equal(order.status,'active');assert.equal(order.items[0].reservedQty,7);
 assert.equal(order.items[0].supplyOrderedQty,0);assert.equal(order.items[0].shortageQty,3);
 assert.equal(demand.status,'PENDING');assert.equal(demand.orderedQty,0);assert.equal(demand.remainingToReceiveQty,0);
 assert.equal((await x.read('inventory',x.productKey)).incoming,0);
 const y=await purchasedLifecycle('late-failure'),collision=db.collection('inventoryMovements').doc('supplier-life-collision');
 await collision.set({marker:true});
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...a)=>tx.update(...a),set:(...a)=>tx.set(...a),
  create:(...a)=>{tx.create(collision,{marker:false});return tx.create(...a);}
 }))};
 const before=await supplierSnapshot(y);
 await assert.rejects(commitSingleItemLocationLifecycle(guarded,y.uid,y.intent('cancelled')));
 assert.deepEqual(await supplierSnapshot(y),before);
 assert.equal((await y.lifecycle('cancelled')).status,'applied');
});
test('supplier source scans accept fifty records and reject fifty-one without partial writes',async()=>{
 const x=await purchasedLifecycle('bounded'),supply=await x.read('supplyOrders',x.supplyId),batch=db.batch();
 const stopped={...supply,type:'PURCHASING_MANUAL',method:'PURCHASING_MANUAL',status:'CANCELLED',
  qty:1,cancelledQty:1,incomingRegisteredQty:0};
 for(let i=0;i<49;i++)batch.set(db.collection('supplyOrders').doc(x.orderId+'-stopped-'+i),stopped);
 await batch.commit();assert.equal((await x.lifecycle('cancelled')).status,'applied');
 await db.collection('supplyOrders').doc(x.orderId+'-excess').set(stopped);
 const before=await supplierSnapshot(x);
 await assert.rejects(x.lifecycle('normal'),/50 筆安全上限/);assert.deepEqual(await supplierSnapshot(x),before);
});
test('split supplier POs retain the uncancelled commitment when only one PO line is stopped',async()=>{
 const x=await purchasedLifecycle('split-pos',{quantity:1});
 const secondPo={...x.po,poNo:x.po.poNo+'-second',supplyOrderIds:undefined,
  items:[{...x.po.items[0],qty:2}]};
 delete secondPo.supplyOrderIds;
 const second=await x.c.commitFormalPurchaseOrder(secondPo);
 await x.c.registerPurchaseIncoming(secondPo.poNo,second.poRecord);
 await x.lifecycle('cancelled');
 await x.c.cancelOutstandingSupplyRecord(x.po.poNo,x.supplyId,'只取消第一張供應');
 await db.collection('inventory').doc(x.productKey).update({onHand:12});
 const liveSecond=await x.read('supplyOrders',second.committedSupplyOrders[0].id);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,8);assert.equal(restored.shortageQty,2);
 assert.equal((await x.read('orders',x.orderId)).items[0].supplyOrderedQty,2);
 const demand=(await x.demandRef.get()).data();assert.equal(demand.orderedQty,2);
 assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,2);
 assert.equal((await x.read('inventory',x.productKey)).incoming,2);
 assert.deepEqual(await x.read('supplyOrders',second.committedSupplyOrders[0].id),liveSecond);
});

function receivingHarness(c,uid='emulator-purchaser',role='purchaser'){
 c.currentUser={uid};c.currentUserRole=role;c.permissionRulesReady=true;
 c.process=process;c.window=c;c.crypto=require('node:crypto').webcrypto;c.TextEncoder=TextEncoder;c.YushinSupply=require('../modules/supply-core');
 c.YushinFulfillment=require('../modules/fulfillment-core');c.YushinReservation=require('../modules/reservation-core');
 c.canConfirmSupplyReceipt=()=>['admin','purchaser','warehouse'].includes(c.currentUserRole);
 c.deliveryActor=()=>c.currentUser.uid;c.localDateString=()=> '2026-10-17';
 c.firestoreReadWithTimeout=p=>p;c.readQueryInBatches=async q=>(await q.get()).docs.map(d=>({id:d.id,...d.data()}));
 c.inventoryMovementRecord=(type,qty,sourceId,productKey,createdBy,extra)=>({type,qty,sourceId,productKey,createdBy,...extra});
 vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),c);
 return c;
}
async function receiptLifecycle(name,opts={}){
 const x=await purchasedLifecycle('receipt-'+name,opts),c=receivingHarness(x.c);
 await db.collection('users').doc('emulator-purchaser').set({role:'purchaser',active:true});
 const receive=(qty=1,operationId='v2_receipt_'+name)=>c.receiveSupplyOrderRecord(x.supplyId,qty,'LOT-'+name,'2027-10-17',operationId);
 return {...x,c,receive};
}
async function receiptSnapshot(x){
 const state=await supplierSnapshot(x),documents={};
 for(const collection of ['inventoryLots','inventoryLotCosts','receipts','inventoryMovements']){
  const rows=await db.collection(collection).where('productKey','==',x.productKey).get();
  documents[collection]=rows.docs.map(d=>({id:d.id,...d.data()}));
 }
 return {state,documents};
}
async function keepReceiptAsStock(x){
 // Use the established purchasing decision handler, with UI adapters only.
 Object.assign(x.c,{supplyReceivingCache:[{id:x.supplyId,...await x.read('supplyOrders',x.supplyId)}],
  loadWarehouseMaster:async()=>{},confirm:()=>true,loadActiveReceivingSupplyCache:async()=>{},renderPurchasingView:()=>{},
  showActionFeedback:()=>{},markMainPageDirty:()=>{},renderOrderLifecycleModal:()=>{},alert:message=>{throw Error(message);},
  actionFailureMessage:(_label,error)=>error.message});
 if(typeof x.c.keepCancelledPurchaseAsStock!=='function')vm.runInContext(fs.readFileSync('modules/customer-cancellations.js','utf8'),x.c);
 await x.c.keepCancelledPurchaseAsStock(x.supplyId);
}
test('existing receiving Service atomically posts successive partial receipts to the actual v2 warehouse and preserves the other location',async()=>{
 const x=await receiptLifecycle('partial'),beforeB=await x.read('warehouseStocks','V2-B__'+x.productKey);
 await x.receive();
 let order=await x.read('orders',x.orderId),ledger=await x.read('inventoryReservations',x.orderId+'__I1');
 assert.equal(order.items[0].reservedQty,8);assert.equal(order.items[0].shortageQty,2);assert.equal(order.items[0].receivedQty,1);
 assert.equal(ledger.locationSchemaVersion,2);assert.equal(ledger.warehouseId,undefined);
 assert.deepEqual(ledger.locations,[{warehouseId:'V2-A',reservedQty:5},{warehouseId:'V2-B',reservedQty:3}]);
 assert.deepEqual(await x.read('warehouseStocks','V2-B__'+x.productKey),beforeB);
 let company=await x.read('inventory',x.productKey);assert.equal(company.onHand,8);assert.equal(company.reserved,8);assert.equal(company.incoming,2);
 const first=await receiptSnapshot(x);await x.receive();assert.deepEqual(await receiptSnapshot(x),first);
 await x.receive(2,'v2_receipt_partial_final');
 order=await x.read('orders',x.orderId);ledger=await x.read('inventoryReservations',x.orderId+'__I1');
 assert.equal(order.items[0].reservedQty,10);assert.equal(order.items[0].shortageQty,0);assert.equal(order.items[0].receivedQty,3);
 assert.equal(ledger.quantity,10);assert.equal(ledger.locations[0].reservedQty,7);assert.equal(ledger.locations[1].reservedQty,3);
 company=await x.read('inventory',x.productKey);assert.equal(company.onHand,10);assert.equal(company.reserved,10);assert.equal(company.incoming,0);
 assert.equal((await x.read('supplyOrders',x.supplyId)).status,'RECEIVED');
 const demand=(await x.demandRef.get()).data();assert.equal(demand.status,'RECEIVED');assert.equal(demand.receivedQty,3);
 assert.equal(demand.remainingToReceiveQty,0);
});
test('cancelled v2 source requires purchasing KEEP_STOCK and receives free stock without reactivating either reservation',async()=>{
 const x=await receiptLifecycle('cancelled');await x.lifecycle('cancelled');
 const blocked=await receiptSnapshot(x);await assert.rejects(x.receive(),/採購確認/);assert.deepEqual(await receiptSnapshot(x),blocked);
 await keepReceiptAsStock(x);
 const ledger=await x.read('inventoryReservations',x.orderId+'__I1'),b=await x.read('warehouseStocks','V2-B__'+x.productKey);
 await x.receive(2);
 assert.deepEqual(await x.read('inventoryReservations',x.orderId+'__I1'),ledger);
 assert.deepEqual(await x.read('warehouseStocks','V2-B__'+x.productKey),b);
 const order=await x.read('orders',x.orderId),stock=await x.read('inventory',x.productKey);
 assert.equal(order.status,'cancelled');assert.equal(order.items[0].reservedQty,0);assert.equal(order.items[0].shortageQty,0);
 assert.equal(order.items[0].receivedQty,2);assert.equal(stock.onHand,9);assert.equal(stock.reserved,0);assert.equal(stock.incoming,1);
 const demand=(await x.demandRef.get()).data();assert.equal(demand.status,'CANCELLED');assert.equal(demand.receivedQty,2);
 assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,1);
 const before=await receiptSnapshot(x);await x.receive(2);assert.deepEqual(await receiptSnapshot(x),before);
});
test('v2 receiving re-reads real roles, other warehouse balances, PO and demand identities before posting any stock',async()=>{
 const cases=[
  ['disabled',x=>db.collection('users').doc('emulator-purchaser').update({active:false})],
  ['spoofed-role',x=>db.collection('users').doc('emulator-purchaser').update({role:'sales'})],
  ['other-stock',x=>db.collection('warehouseStocks').doc('V2-B__'+x.productKey).update({reserved:2})],
  ['inactive',x=>db.collection('warehouses').doc('V2-A').update({active:false})],
  ['po',x=>db.collection('purchaseOrders').doc(x.po.poNo).update({supplyOrderIds:[]})],
  ['missing-ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I1').delete()],
  ['mixed-ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I1').update({warehouseId:'V2-A'})],
  ['supply-method',x=>db.collection('supplyOrders').doc(x.supplyId).update({method:'SALES_SELF_ORDER'})],
  ['demand',x=>x.demandRef.update({ownerUid:'other'})],
  ['projection',async x=>{const o=await x.read('orders',x.orderId);o.items[0].shortageQty=4;
   await db.collection('orders').doc(x.orderId).update({items:o.items});}],
 ];
 for(const [name,mutate] of cases){
  const x=await receiptLifecycle('reject-'+name);await mutate(x);const before=await receiptSnapshot(x);
  await assert.rejects(x.receive(),undefined,name);assert.deepEqual(await receiptSnapshot(x),before,name);
 }
});
test('v2 receiving concurrent same operation posts one receipt, and changed request or disabled replay cannot reuse it',async()=>{
 const x=await receiptLifecycle('concurrent');await Promise.all([x.receive(),x.receive()]);
 const state=await receiptSnapshot(x);assert.equal(state.documents.receipts.length,1);
 assert.equal(state.documents.inventoryLots.length,1);assert.equal(state.documents.inventoryLotCosts.length,1);
 assert.equal(state.state.base.documents[1].onHand,8);
 await assert.rejects(x.receive(2),/識別碼衝突/);assert.deepEqual(await receiptSnapshot(x),state);
 await db.collection('users').doc('emulator-purchaser').update({disabled:true});
 await assert.rejects(x.receive(),/真實登入/);assert.deepEqual(await receiptSnapshot(x),state);
});
test('v2 receipt over-consumption races and late failures never leave partial stock, lots, costs or source progress',async()=>{
 const race=await receiptLifecycle('distinct-race');
 const results=await Promise.allSettled([race.receive(2,'receipt_race_A'),race.receive(2,'receipt_race_B')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const state=await receiptSnapshot(race);assert.equal(state.documents.receipts.length,1);
 assert.equal(state.state.base.documents[1].onHand,9);assert.equal(state.state.demand.receivedQty,2);
 const x=await receiptLifecycle('late-failure'),collision=db.collection('inventoryMovements').doc('receipt-collision');
 await collision.set({marker:true});
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn({get:r=>tx.get(r),update:(...a)=>tx.update(...a),
  set:(ref,...args)=>{if(ref.parent.id==='receipts')tx.create(collision,{marker:false});return tx.set(ref,...args);}}));
 const before=await receiptSnapshot(x);await assert.rejects(x.receive());assert.deepEqual(await receiptSnapshot(x),before);
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn(tx));
 await x.receive();assert.equal((await x.read('inventory',x.productKey)).onHand,8);
 const guarded=await receiptLifecycle('environment');delete guarded.c.process;
 const original=await receiptSnapshot(guarded);await assert.rejects(guarded.receive(),/僅允許 demo-yushin/);
 assert.deepEqual(await receiptSnapshot(guarded),original);
});
test('v2 receiving uses three real operational roles and warehouse cost linkage, and denies both business roles',async()=>{
 for(const role of ['admin','warehouse','sales','engineer']){
  const x=await receiptLifecycle('actual-role-'+role),uid='receipt-actor-'+role;
  await db.collection('users').doc(uid).set({role,active:true});
  x.c.currentUser={uid};x.c.currentUserRole=role;
  const before=await receiptSnapshot(x);
  if(['sales','engineer'].includes(role)){
   await assert.rejects(x.receive(),/權限/);assert.deepEqual(await receiptSnapshot(x),before);
  }else{
   await x.receive();const after=await receiptSnapshot(x);
   assert.equal(after.state.base.documents[1].onHand,8);
   assert.equal(after.documents.receipts[0].createdByRole,role);
   const cost=after.documents.inventoryLotCosts[0];
   if(role==='warehouse'){assert.equal(cost.unitCost,undefined);assert.equal(cost.costSourceSupplyId,x.supplyId);}
   else assert.equal(cost.unitCost,100);
  }
 }
 const x=await receiptLifecycle('cancelled-missing-ledger');await x.lifecycle('cancelled');await keepReceiptAsStock(x);
 await db.collection('inventoryReservations').doc(x.orderId+'__I1').delete();
 const before=await receiptSnapshot(x);await assert.rejects(x.receive(),/缺少庫存預留/);assert.deepEqual(await receiptSnapshot(x),before);
});

test('partial receipt cancellation retains physical goods and remaining supplier obligation, then restores only uncovered demand',async()=>{
 const x=await receiptLifecycle('post-receipt-partial');await x.receive();
 const before=await receiptSnapshot(x),supply=await x.read('supplyOrders',x.supplyId);
 const stopped=await x.lifecycle('cancelled');assert.equal(stopped.companyReservedDelta,-8);
 let state=await receiptSnapshot(x);
 assert.equal(state.state.base.documents[1].onHand,8);assert.equal(state.state.base.documents[1].reserved,0);
 assert.equal(state.state.base.documents[1].incoming,2);
 for(const collection of ['inventoryLots','inventoryLotCosts','receipts'])assert.deepEqual(state.documents[collection],before.documents[collection]);
 assert.deepEqual(await x.read('supplyOrders',x.supplyId),supply);
 assert.equal(state.state.demand.status,'CANCELLED');assert.equal(state.state.demand.receivedQty,1);
 assert.equal(state.state.demand.remainingToReceiveQty,2);assert.equal(state.state.demand.remainingToOrderQty,0);
 const first=await receiptSnapshot(x);await x.lifecycle('cancelled');assert.deepEqual(await receiptSnapshot(x),first);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,8);assert.equal(restored.shortageQty,2);
 state=await receiptSnapshot(x);assert.equal(state.state.demand.requestedQty,3);
 assert.equal(state.state.demand.orderedQty,3);assert.equal(state.state.demand.receivedQty,1);
 assert.equal(state.state.demand.remainingToOrderQty,0);assert.equal(state.state.demand.remainingToReceiveQty,2);
 await x.receive(2,'receipt_after_restore_partial');
 assert.equal((await x.read('orders',x.orderId)).items[0].reservedQty,10);
 assert.equal((await x.read('inventory',x.productKey)).onHand,10);
});
test('full receipt cancellation and restoration never recreate procurement or incoming, including a closed PO with fully received supply',async()=>{
 const x=await receiptLifecycle('post-receipt-full');await x.receive(3);
 await db.collection('purchaseOrders').doc(x.po.poNo).update({status:'CLOSED'});
 const before=await receiptSnapshot(x);await x.lifecycle('cancelled');
 const cancelled=await receiptSnapshot(x);assert.equal(cancelled.state.base.documents[1].onHand,10);
 assert.equal(cancelled.state.base.documents[1].reserved,0);assert.equal(cancelled.state.base.documents[1].incoming,0);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,10);assert.equal(restored.shortageQty,0);
 const after=await receiptSnapshot(x);assert.equal(after.state.demand.status,'RECEIVED');
 assert.equal(after.state.demand.requestedQty,3);assert.equal(after.state.demand.orderedQty,3);assert.equal(after.state.demand.receivedQty,3);
 assert.equal(after.state.demand.remainingToOrderQty,0);assert.equal(after.state.demand.remainingToReceiveQty,0);
 for(const collection of ['inventoryLots','inventoryLotCosts','receipts'])assert.deepEqual(after.documents[collection],before.documents[collection]);
 assert.deepEqual(after.state.supplies,before.state.supplies);assert.deepEqual(after.state.po,before.state.po);
});
test('receipt during customer cancellation can later restore against actual physical stock without duplicating remaining incoming',async()=>{
 const x=await receiptLifecycle('post-cancel-receipt');await x.lifecycle('cancelled');await keepReceiptAsStock(x);
 await x.receive();
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,8);assert.equal(restored.shortageQty,2);
 const demand=(await x.demandRef.get()).data();assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,2);
 assert.equal((await x.read('inventory',x.productKey)).incoming,2);
});
test('partially received supplier cancellation preserves receipt history and restoration creates only the new actual shortage',async()=>{
 const x=await receiptLifecycle('post-receipt-supplier-stop');await x.receive();await x.lifecycle('cancelled');
 const before=await receiptSnapshot(x);
 const result=await x.c.cancelOutstandingSupplyRecord(x.po.poNo,x.supplyId,'供應商取消未到貨餘量');
 assert.equal(result.cancelledQty,2);assert.equal(result.terminalStatus,'CLOSED');
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,8);assert.equal(restored.shortageQty,2);
 const state=await receiptSnapshot(x);
 assert.equal(state.state.demand.orderedQty,1);assert.equal(state.state.demand.receivedQty,1);
 assert.equal(state.state.demand.requestedQty,3);assert.equal(state.state.demand.remainingToOrderQty,2);
 assert.equal(state.state.demand.remainingToReceiveQty,0);assert.equal(state.state.base.documents[1].incoming,0);
 for(const collection of ['inventoryLots','inventoryLotCosts','receipts'])assert.deepEqual(state.documents[collection],before.documents[collection]);
});
test('post-receipt lifecycle rejects missing, forged or duplicated receipt evidence without releasing or creating reservations',async()=>{
 const cases=[
  ['missing-receipt',async x=>{const r=await db.collection('receipts').where('orderId','==',x.orderId).get();await r.docs[0].ref.delete();}],
  ['receipt-owner',async x=>{const r=await db.collection('receipts').where('orderId','==',x.orderId).get();await r.docs[0].ref.update({ownerUid:'other'});}],
  ['receipt-source',async x=>{const r=await db.collection('receipts').where('orderId','==',x.orderId).get();await r.docs[0].ref.update({orderId:'other-order'});}],
  ['receipt-counter',async x=>{const r=await db.collection('receipts').where('orderId','==',x.orderId).get();await r.docs[0].ref.update({cumulativeReceivedQty:2});}],
  ['missing-movement',async x=>{const r=await db.collection('inventoryMovements').where('sourceId','==',x.supplyId).where('type','==','receipt').get();await r.docs[0].ref.delete();}],
  ['wrong-movement',async x=>{const r=await db.collection('inventoryMovements').where('sourceId','==',x.supplyId).where('type','==','receipt').get();await r.docs[0].ref.update({qty:2});}],
  ['wrong-lot',async x=>{const r=await db.collection('inventoryLots').where('sourceId','==',x.supplyId).get();await r.docs[0].ref.update({warehouseId:'V2-B'});}],
  ['duplicate-receipt',async x=>{const r=await db.collection('receipts').where('orderId','==',x.orderId).get(),id='duplicate_'+r.docs[0].id;
   await db.collection('receipts').doc(id).set({...r.docs[0].data(),receiptId:id,operationId:id,cumulativeReceivedQty:2});
   const movement=await db.collection('inventoryMovements').where('receiptId','==',r.docs[0].id).where('type','==','receipt').get();
   await db.collection('inventoryMovements').doc(id).set({...movement.docs[0].data(),receiptId:id});}],
 ];
 for(const [name,mutate] of cases){const x=await receiptLifecycle('proof-'+name);await x.receive();await mutate(x);
  const before=await receiptSnapshot(x);await assert.rejects(x.lifecycle('cancelled'),undefined,name);
  assert.deepEqual(await receiptSnapshot(x),before,name);}
});
test('post-receipt cancellation is atomic under a competing receipt and late write collision',async()=>{
 const x=await receiptLifecycle('post-receipt-race');await x.receive();
 // Either receipt finishes before cancellation, or it safely refuses because
 // purchasing has not approved KEEP_STOCK. A receipt may never partially post.
 const results=await Promise.allSettled([x.receive(1,'post_receipt_competing'),x.lifecycle('cancelled')]);
 assert.equal(results[1].status,'fulfilled');
 const order=await x.read('orders',x.orderId),stock=await x.read('inventory',x.productKey);
 assert.equal(order.status,'cancelled');assert.equal(stock.reserved,0);
 const received=order.items[0].receivedQty;assert.ok(received===1||received===2);
 assert.equal(stock.onHand,7+received);assert.equal(stock.incoming,3-received);
 assert.equal((await x.demandRef.get()).data().remainingToReceiveQty,3-received);
 const y=await receiptLifecycle('post-receipt-failure');await y.receive();
 const collision=db.collection('inventoryMovements').doc('post-receipt-lifecycle-collision');await collision.set({marker:true});
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(async tx=>fn({
  get:r=>tx.get(r),update:(...a)=>tx.update(...a),set:(...a)=>tx.set(...a),
  create:(...a)=>{tx.create(collision,{marker:false});return tx.create(...a);}}))};
 const before=await receiptSnapshot(y);await assert.rejects(commitSingleItemLocationLifecycle(guarded,y.uid,y.intent('cancelled')));
 assert.deepEqual(await receiptSnapshot(y),before);assert.equal((await y.lifecycle('cancelled')).status,'applied');
});
test('received lot may be consumed by a confirmed partial shipment before cancelling the unfulfilled remainder',async()=>{
 const x=await receiptLifecycle('post-receipt-shipped');
 // Complete baseline physical lot fixtures; newly purchased goods then follow
 // the real receipt, preparation, shipment and acknowledgement Services.
 await db.collection('warehouseStocks').doc('V2-B__'+x.productKey).update({onHand:3});
 for(const [wh,qty] of [['V2-A',4],['V2-B',3]])await db.collection('inventoryLots').doc(x.productKey+'-baseline-'+wh).set({
  productKey:x.productKey,productId:x.productKey,warehouseId:wh,receivedQty:qty,remainingQty:qty,
  lotNo:'BASE',expiryDate:'2028-10-17',receivedAt:'2026-10-01T00:00:00Z'});
 await x.receive();
 const order=await x.read('orders',x.orderId),plan={mode:'CUSTOMER_SHIP',contact:'客戶',phone:'02-12345678',address:'台北市測試地址'};
 order.items[0].deliveryPlan=plan;await db.collection('orders').doc(x.orderId).update({items:order.items,
  deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false});
 const uid='post-receipt-shipping-operator';await db.collection('users').doc(uid).set({role:'warehouse',active:true});
 await require('../functions/location-dispatch-service').commitLocationDispatchPreparation(db,uid,{
  orderId:x.orderId,itemId:'I1',quantity:1,operationId:'prepare_post_receipt_shipment',syncAttemptId:'v2_123456789'});
 await require('../functions/location-shipment-service').commitLocationShipment(db,uid,{
  orderId:x.orderId,itemId:'I1',warehouseId:'V2-A',quantity:1,operationId:'ship_post_receipt_shipment',
  syncAttemptId:'v2_123456789',date:'2026-10-17',expectedPlan:plan});
 await require('../functions/shipment-delivery-service').commitShipmentDelivery(db,x.uid,{
  orderId:x.orderId,itemId:'I1',shipmentId:'ship_post_receipt_shipment',quantity:1,
  operationId:'deliver_post_receipt_shipment',syncAttemptId:'v2_123456789',date:'2026-10-17'});
 const before=await receiptSnapshot(x);assert.equal(before.documents.inventoryLots.find(l=>l.sourceId===x.supplyId).remainingQty,0);
 await x.lifecycle('cancelled');const restored=await x.lifecycle('normal');
 assert.equal(restored.reservedQty,7);assert.equal(restored.shortageQty,2);
 const after=await receiptSnapshot(x);assert.equal(after.state.base.documents[0].deliveredQty,1);
 assert.equal(after.state.base.documents[1].onHand,7);assert.equal(after.state.base.documents[1].incoming,2);
 assert.equal(after.state.demand.remainingToOrderQty,0);assert.equal(after.state.demand.remainingToReceiveQty,2);
 for(const collection of ['inventoryLots','inventoryLotCosts','receipts'])assert.deepEqual(after.documents[collection],before.documents[collection]);
});

async function receiptShipmentLifecycle(name){
 const x=await receiptLifecycle('ship-receive-'+name);
 // Use the real presentation normalizer too; its legacy shortage projection
 // must never overwrite the v2 ledger inside the receipt transaction.
 x.c.brandIdentityForRecord=i=>({brand:i.brand||'',brandId:i.brandId||''});
 x.c.normalizeHistoryItemCode=v=>v;x.c.parseMoney=v=>Number(v||0);
 const workspace=fs.readFileSync('src/features/orders/order-workspace.js','utf8');
 vm.runInContext(workspace.slice(0,workspace.indexOf('function ensureOrderItemCompatibility(')),x.c);
 await db.collection('warehouseStocks').doc('V2-B__'+x.productKey).update({onHand:3});
 for(const [wh,qty] of [['V2-A',4],['V2-B',3]])await db.collection('inventoryLots').doc(x.productKey+'-baseline-'+wh).set({
  productKey:x.productKey,productId:x.productKey,warehouseId:wh,receivedQty:qty,remainingQty:qty,
  lotNo:'BASE',expiryDate:'2028-10-17',receivedAt:'2026-10-01T00:00:00Z'});
 const order=await x.read('orders',x.orderId),plan={mode:'CUSTOMER_SHIP',contact:'客戶',phone:'02-12345678',address:'台北市測試地址'};
 order.items[0].deliveryPlan=plan;await db.collection('orders').doc(x.orderId).update({items:order.items,
  deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false});
 const uid='receipt-shipment-operator';await db.collection('users').doc(uid).set({role:'warehouse',active:true});
 const prepare=(quantity,tag)=>require('../functions/location-dispatch-service').commitLocationDispatchPreparation(db,uid,{
  orderId:x.orderId,itemId:'I1',quantity,operationId:'prepare_'+name+'_'+tag,syncAttemptId:'v2_123456789'});
 const ship=(quantity,tag,warehouseId='V2-A')=>require('../functions/location-shipment-service').commitLocationShipment(db,uid,{
  orderId:x.orderId,itemId:'I1',warehouseId,quantity,operationId:'shipment_'+name+'_'+tag,
  syncAttemptId:'v2_123456789',date:'2026-10-17',expectedPlan:plan});
 const confirm=(quantity,tag,deliveryTag=tag)=>require('../functions/shipment-delivery-service').commitShipmentDelivery(db,x.uid,{
  orderId:x.orderId,itemId:'I1',shipmentId:'shipment_'+name+'_'+tag,quantity,operationId:'delivery_'+name+'_'+deliveryTag,
  syncAttemptId:'v2_123456789',date:'2026-10-17'});
 return {...x,prepare,ship,confirm};
}
test('additional receipts after pending, partly confirmed or confirmed shipment reserve only unshipped demand',async()=>{
 for(const confirmed of [0,1,2]){
  const x=await receiptShipmentLifecycle('ack'+confirmed);await x.receive(1,'receipt_before_ack'+confirmed);
  await x.prepare(2,'first');await x.ship(2,'first');if(confirmed)await x.confirm(confirmed,'first');
  const before=await receiptSnapshot(x),result=await x.receive(1,'receipt_after_ack'+confirmed);
  const after=await receiptSnapshot(x),order=await x.read('orders',x.orderId),item=order.items[0];
  assert.equal(item.reservedQty,7);assert.equal(item.shortageQty,1);assert.equal(item.warehouseShippedQty,2);
  assert.equal(item.deliveredQty,confirmed);assert.equal(order.deliveredQty,confirmed);assert.equal(order.isDelivered,false);
  assert.equal(after.state.base.documents[1].onHand,7);assert.equal(after.state.base.documents[1].reserved,7);
  assert.equal(after.state.base.documents[1].incoming,1);assert.equal(after.state.demand.remainingToOrderQty,0);
  assert.equal(after.state.demand.remainingToReceiveQty,1);
  assert.deepEqual(order.warehouseShipmentRecords,before.state.base.documents[0].warehouseShipmentRecords);
  assert.deepEqual(order.deliveryRecords,before.state.base.documents[0].deliveryRecords);
  const committed=await receiptSnapshot(x);await x.receive(1,'receipt_after_ack'+confirmed);
  assert.deepEqual(await receiptSnapshot(x),committed);assert.ok(result);
 }
});
test('real receipt preparation shipment and final acknowledgement cycle consumes exactly ten units',async()=>{
 const x=await receiptShipmentLifecycle('complete');
 await x.prepare(4,'a');await x.ship(4,'a');await x.receive(1,'cycle_receipt_one');
 await x.prepare(1,'b');await x.ship(1,'b');await x.confirm(4,'a');
 await x.receive(2,'cycle_receipt_two');await x.prepare(5,'last');
 await x.ship(2,'c');await x.ship(3,'d','V2-B');
 let order=await x.read('orders',x.orderId);assert.equal(order.items[0].warehouseShippedQty,10);
 assert.equal(order.items[0].reservedQty,0);assert.equal(order.items[0].shortageQty,0);assert.equal(order.isDelivered,false);
 await x.confirm(1,'b');await x.confirm(2,'c');await x.confirm(3,'d');
 order=await x.read('orders',x.orderId);assert.equal(order.isDelivered,true);assert.equal(order.deliveredQty,10);
 const after=await receiptSnapshot(x);assert.equal(after.state.base.documents[1].onHand,0);
 assert.equal(after.state.base.documents[1].reserved,0);assert.equal(after.state.base.documents[1].incoming,0);
 assert.equal(after.state.demand.remainingToOrderQty,0);assert.equal(after.state.demand.remainingToReceiveQty,0);
 assert.ok(after.documents.inventoryLots.every(lot=>lot.remainingQty===0));
});
test('receipt after shipment rejects missing or altered debit and stale caches without any partial writes',async()=>{
 const cases=[
  ['missing',async(x,s)=>db.collection('inventoryMovements').doc(s.movementId).delete()],
  ['quantity',async(x,s)=>db.collection('inventoryMovements').doc(s.movementId).update({qty:-2})],
  ['warehouse',async(x,s)=>db.collection('inventoryMovements').doc(s.movementId).update({warehouseId:'V2-B'})],
  ['allocation',async(x,s)=>db.collection('inventoryMovements').doc(s.movementId).update({lotAllocations:[]})],
  ['cache',async x=>{const o=await x.read('orders',x.orderId);o.items[0].warehouseShippedQty=0;await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['delivery',async x=>db.collection('orders').doc(x.orderId).update({deliveredQty:1})],
 ];
 for(const [name,mutate] of cases){const x=await receiptShipmentLifecycle('bad'+name);await x.prepare(1,'a');await x.ship(1,'a');
  const order=await x.read('orders',x.orderId);await mutate(x,order.warehouseShipmentRecords[0]);
  const before=await receiptSnapshot(x);await assert.rejects(x.receive(1,'bad_receipt_'+name));
  assert.deepEqual(await receiptSnapshot(x),before,name);}
});
test('competing receipt and physical shipment serialize without re-reserving the shipped unit',async()=>{
 const x=await receiptShipmentLifecycle('race');await x.prepare(2,'a');await x.ship(1,'a');
 await Promise.all([x.receive(1,'race_after_shipment_receipt'),x.ship(1,'b')]);
 const order=await x.read('orders',x.orderId),item=order.items[0],stock=await x.read('inventory',x.productKey);
 assert.equal(item.warehouseShippedQty,2);assert.equal(item.deliveredQty,0);assert.equal(item.reservedQty,6);
 assert.equal(item.shortageQty,2);assert.equal(stock.onHand,6);assert.equal(stock.reserved,6);assert.equal(stock.incoming,2);
});

test('v2 idempotent receipts re-check current order owner after reassignment',async()=>{
  for(const role of ['sales','engineer']){
    const initial=await seed('owner-replay-initial-'+role,{role});
    await commit(initial);
    await db.collection('orders').doc(initial.orderId).update({ownerUid:'reassigned-owner'});
    const before=await snapshot(initial);
    await assert.rejects(commit(initial),/非負責業務/,role);
    assert.deepEqual(await snapshot(initial),before,role);
    const lifecycle=await readyLifecycle('owner-replay-life-'+role,{role});
    await lifecycle.lifecycle('cancelled');
    await db.collection('orders').doc(lifecycle.orderId).update({ownerUid:'reassigned-owner'});
    const cancelled=await snapshot(lifecycle);
    await assert.rejects(lifecycle.lifecycle('cancelled'),/不能操作其他業務/,role);
    assert.deepEqual(await snapshot(lifecycle),cancelled,role);
  }
  // An admin retains repository-wide authority, but cannot replay as another actor.
  const adminCase=await readyLifecycle('owner-replay-admin',{role:'admin'});
  await adminCase.lifecycle('cancelled');
  await db.collection('orders').doc(adminCase.orderId).update({ownerUid:'reassigned-owner'});
  const before=await snapshot(adminCase);
  assert.equal((await adminCase.lifecycle('cancelled')).status,'already-applied');
  assert.deepEqual(await snapshot(adminCase),before);
});

async function competingFreeStockOrder(source,suffix){
 const orderId=source.orderId+'-free-'+suffix,old=await source.read('orders',source.orderId);
 await db.collection('orders').doc(orderId).set({...old,status:'active',
  orderStatus:'normal',inventoryReservationStatus:'pending',
  items:[{...old.items[0],reservedQty:0,shortageQty:0}]});
 await commitSingleItemTwoWarehouse(db,source.uid,{
  orderId,itemId:'I1',warehouseIds:['V2-A','V2-B'],
  attemptId:'free_reserve_'+suffix+'_123456789',
  syncAttemptId:'v2_123456789'});
 await db.collection('orders').doc(orderId).update({inventoryReservationStatus:'completed'});
 return {...source,orderId,request:{...source.request,orderId}};
}
function redistributeFree(x,warehouseId,qty=10,operationId='free_location_'+x.orderId+'_'+warehouseId){
 return commitSingleItemFreeStockAllocation(db,x.uid,{
  orderId:x.orderId,itemId:'I1',warehouseId,quantity:qty,
  operationId,syncAttemptId:'v2_123456789'});
}
test('released A/B stock reallocates to a separate waiting v2 order without inventing onHand',async()=>{
 const source=await readyLifecycle('free-distribution',{role:'admin'});
 const target=await competingFreeStockOrder(source,'target');
 const before=await target.read('inventory',target.productKey);
 assert.equal((await target.read('orders',target.orderId)).items[0].shortageQty,8);
 const demand=await seedLifecycleDemand(target);
 assert.equal((await demand.read()).requestedQty,8);
 await source.lifecycle('cancelled');
 const sourceOrderAfter=await source.read('orders',source.orderId);
 const sourceLedgerAfter=await source.read('inventoryReservations',source.orderId+'__I1');
 const first=await redistributeFree(target,'V2-B');
 assert.equal(first.allocatedQty,6);
 assert.equal(first.reservedQty,8);assert.equal(first.shortageQty,2);
 assert.equal((await demand.read()).requestedQty,2);
 const afterFirst=await snapshot(target);
 assert.equal((await redistributeFree(target,'V2-B')).status,'already-applied');
 assert.deepEqual(await snapshot(target),afterFirst);
 const second=await redistributeFree(target,'V2-A');
 assert.equal(second.allocatedQty,2);assert.equal(second.shortageQty,0);
 const inv=await target.read('inventory',target.productKey);
 assert.equal(inv.onHand,before.onHand);assert.equal(inv.reserved,10);
 assert.equal((await target.read('warehouseStocks','V2-B__'+target.productKey)).reserved,8);
 assert.equal((await target.read('warehouseStocks','V2-A__'+target.productKey)).reserved,2);
 const ledger=await target.read('inventoryReservations',target.orderId+'__I1');
 assert.deepEqual(ledger.locations,[{warehouseId:'V2-A',reservedQty:2},{warehouseId:'V2-B',reservedQty:8}]);
 assert.equal((await demand.read()).requestedQty,0);
 assert.equal((await demand.read()).remainingToOrderQty,0);
 assert.deepEqual(await source.read('orders',source.orderId),sourceOrderAfter);
 assert.deepEqual(await source.read('inventoryReservations',source.orderId+'__I1'),sourceLedgerAfter);
});
test('free redistribution is gated by role, live demand, warehouse, supply and sync',async()=>{
 const source=await readyLifecycle('free-rejections',{role:'admin'});
 const target=await competingFreeStockOrder(source,'reject');
 await seedLifecycleDemand(target);
 await source.lifecycle('cancelled');
 await db.collection('users').doc('v2-free-sales').set({role:'sales',active:true});
 const before=await snapshot(target);
 await assert.rejects(commitSingleItemFreeStockAllocation(db,'v2-free-sales',{
  orderId:target.orderId,itemId:'I1',warehouseId:'V2-A',quantity:10,
  operationId:'sales_denied_123456789',syncAttemptId:'v2_123456789'}),/角色|權限/);
 assert.deepEqual(await snapshot(target),before);
 const key='SALES_ORDER:'+target.orderId+':I1';
 const demandRef=db.collection('procurementDemands').doc(encodeURIComponent(key));
 await demandRef.update({orderedQty:1,status:'PARTIALLY_ORDERED'});
 await assert.rejects(redistributeFree(target,'V2-A'),/採購需求/);
 await demandRef.update({orderedQty:0,status:'PENDING'});
 await db.collection('supplyOrders').doc('free-source-obligation-'+target.orderId).set({
  orderId:target.orderId,demandId:key});
 await assert.rejects(redistributeFree(target,'V2-A'),/供應商承諾/);
 await db.collection('supplyOrders').doc('free-source-obligation-'+target.orderId).delete();
 await db.collection('warehouses').doc('V2-A').update({active:false});
 await assert.rejects(redistributeFree(target,'V2-A'),/實體倉/);
 await db.collection('warehouses').doc('V2-A').update({active:true});
 await db.collection('warehouses').doc('V2-C').set({active:true});
 await db.collection('warehouseStocks').doc('V2-C__'+target.productKey).set({
  productKey:target.productKey,warehouseId:'V2-C',onHand:1,reserved:0,transferFreeInTransit:0});
 await assert.rejects(redistributeFree(target,'V2-C'),/候選位置/);
 await db.collection('orders').doc(target.orderId).update({inventoryReservationAttemptId:'stale'});
 await assert.rejects(redistributeFree(target,'V2-A'),/來源訂單/);
 const noWrite=await snapshot(target);
 assert.equal(noWrite.movements.length,before.movements.length);
});
test('free redistribution concurrent requests and movement collisions cannot double-reserve',async()=>{
 const source=await readyLifecycle('free-competition',{role:'admin'});
 const target=await competingFreeStockOrder(source,'races');
 await source.lifecycle('cancelled');
 const collision='free_collision_lock_12345';
 await db.collection('inventoryMovements').doc('single-v2-free-'+collision).set({marker:true});
 const before=await snapshot(target);
 await assert.rejects(redistributeFree(target,'V2-B',6,collision),/操作 ID/);
 assert.deepEqual(await snapshot(target),before);
 const [a,b]=await Promise.all([
  redistributeFree(target,'V2-B',6,'concurrent_free_B_first_123'),
  redistributeFree(target,'V2-B',6,'concurrent_free_B_second_123')
 ]);
 assert.equal(a.allocatedQty+b.allocatedQty,6);
 assert.equal((await target.read('inventoryReservations',target.orderId+'__I1')).quantity,8);
 assert.equal((await target.read('warehouseStocks','V2-B__'+target.productKey)).reserved,8);
 assert.equal((await target.read('inventory',target.productKey)).onHand,12);
});

async function autoFreeTarget(source,suffix,qty,orderDate=''){
 const orderId=source.orderId+'-auto-'+suffix,existing=await source.read('orders',source.orderId);
 await db.collection('orders').doc(orderId).set({...existing,status:'active',orderStatus:'normal',
  inventoryReservationStatus:'pending',
  ...(orderDate?{orderDate}:{}),
  items:[{...existing.items[0],qty,orderedQty:qty,reservedQty:0,shortageQty:0}]});
 await commitSingleItemTwoWarehouse(db,source.uid,{orderId,itemId:'I1',
  warehouseIds:['V2-A','V2-B'],attemptId:'auto_initial_'+source.orderId+'_'+suffix+'_123456789',
  syncAttemptId:'v2_123456789'});
 await db.collection('orders').doc(orderId).update({inventoryReservationStatus:'completed'});
 return {...source,orderId,request:{...source.request,orderId}};
}
function autoFreeRequest(source,runId,maxQty=6){
 return {productKey:source.productKey,warehouseId:'V2-B',maxQty,runId};
}
test('FIFO automated checkpoint allocates two v2 orders in bounded resumable steps',async()=>{
 const source=await readyLifecycle('auto-fifo',{role:'admin'});
 const older=await autoFreeTarget(source,'z-older',4,'2026-10-01');
 const newer=await autoFreeTarget(source,'a-newer',5,'2026-10-02');
 const olderLedger=db.collection('inventoryReservations').doc(older.orderId+'__I1');
 const newerLedger=db.collection('inventoryReservations').doc(newer.orderId+'__I1');
 assert.equal((await olderLedger.get()).data().orderDate,'2026-10-01');
 assert.equal((await newerLedger.get()).data().orderDate,'2026-10-02');
 assert.equal((await older.read('orders',older.orderId)).items[0].shortageQty,2);
 assert.equal((await newer.read('orders',newer.orderId)).items[0].shortageQty,5);
 // Zero-hold target still has exactly the two proven warehouse candidates.
 assert.deepEqual((await newer.read('inventoryReservations',newer.orderId+'__I1')).lifecycleWarehouseIds,['V2-A','V2-B']);
 const firstDemand=await seedLifecycleDemand(older);
 const secondDemand=await seedLifecycleDemand(newer);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_fifo_success_123456');
 const first=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(first.status,'active');
 assert.equal(first.lastOrderId,older.orderId);
 assert.equal(first.lastAllocatedQty,2);
 assert.equal(first.allocatedQty,2);
 assert.equal(first.processedSteps,1);
 assert.equal((await firstDemand.read()).requestedQty,0);
 const second=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(second.status,'completed');
 assert.equal(second.lastOrderId,newer.orderId);
 assert.equal(second.lastAllocatedQty,4);
 assert.equal(second.allocatedQty,6);
 assert.equal(second.processedSteps,2);
 assert.equal((await secondDemand.read()).requestedQty,1);
 assert.equal((await source.read('inventory',source.productKey)).onHand,12);
 assert.equal((await source.read('inventory',source.productKey)).reserved,8);
 assert.equal((await source.read('warehouseStocks','V2-B__'+source.productKey)).reserved,8);
 const checkpoint=await source.read('reservationOperationReceipts','single-v2-free-batch-'+input.runId);
 assert.equal(checkpoint.status,'completed');assert.equal(checkpoint.allocatedQty,6);
 assert.equal(checkpoint.pending,null);
 const baseline=await snapshot(newer);
 assert.equal((await advanceAutomaticFreeStockAllocation(db,source.uid,input)).status,'completed');
 assert.deepEqual(await snapshot(newer),baseline);
 await assert.rejects(advanceAutomaticFreeStockAllocation(db,source.uid,{...input,maxQty:7}),/不同交易/);
});
test('FIFO progress survives committed movement with failed checkpoint update',async()=>{
 const source=await readyLifecycle('auto-recovery',{role:'admin'});
 const target=await autoFreeTarget(source,'recovery',10);
 await seedLifecycleDemand(target);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_recovery_durable_1234');
 let injected=false;
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),
  runTransaction:fn=>db.runTransaction(tx=>fn({
   get:x=>tx.get(x),create:(...args)=>tx.create(...args),set:(...args)=>tx.set(...args),
   update:(ref,patch)=>{
    if(!injected&&ref.path==='reservationOperationReceipts/single-v2-free-batch-'+input.runId
      &&patch.processedSteps===1){
     injected=true;throw Error('simulated checkpoint interruption');
    }
    return tx.update(ref,patch);
   }
  }))};
 await assert.rejects(advanceAutomaticFreeStockAllocation(wrapper,source.uid,input),/checkpoint interruption/);
 assert.equal(injected,true);
 let checkpoint=await source.read('reservationOperationReceipts','single-v2-free-batch-'+input.runId);
 assert.equal(checkpoint.allocatedQty,0);assert.equal(checkpoint.pending?.orderId,target.orderId);
 const afterMovement=await snapshot(target);
 assert.equal(afterMovement.documents[1].reserved,8);
 const resumed=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(resumed.allocatedQty,6);
 checkpoint=await source.read('reservationOperationReceipts','single-v2-free-batch-'+input.runId);
 assert.equal(checkpoint.pending,null);assert.equal(checkpoint.processedSteps,1);
 assert.deepEqual(await snapshot(target),afterMovement);
 const final=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(final.status,'completed');
 assert.equal(final.allocatedQty,6);
 assert.equal(final.processedSteps,1); // the exact batch quantity already completed in the first step
});
test('automatic FIFO fails closed on excessive candidates, missing role and mismatched batch intent',async()=>{
 const source=await readyLifecycle('auto-safety',{role:'admin'});
 const target=await autoFreeTarget(source,'limited',4);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_safety_limits_123456');
 await db.collection('users').doc('unprivileged-auto').set({active:true,role:'sales'});
 await assert.rejects(advanceAutomaticFreeStockAllocation(db,'unprivileged-auto',input),/權限/);
 // More than 500 indexed candidate rows must fail closed instead of selecting
 // a possibly non-FIFO target. Two batches keep writes below Firestore limits.
 for(let offset=0;offset<501;offset+=250){
  const batch=db.batch();
  for(let i=offset;i<Math.min(501,offset+250);i++){
   const id='fifo-overflow-'+String(i).padStart(3,'0');
   batch.set(db.collection('inventoryReservations').doc(id+'__I1'),{
    orderId:id,itemId:'I1',productKey:source.productKey,locationSchemaVersion:2,
    locations:[],quantity:0,shortageQty:1,status:'shortage',orderDate:'2026-01-01'});
  }
  await batch.commit();
 }
 const before=await snapshot(target);
 await assert.rejects(advanceAutomaticFreeStockAllocation(db,source.uid,input),/500 筆/);
 assert.deepEqual(await snapshot(target),before);
 const checkpoint=await source.read('reservationOperationReceipts','single-v2-free-batch-'+input.runId);
 assert.equal(checkpoint.allocatedQty,0);assert.equal(checkpoint.pending,null);
});
test('concurrent batch continuation uses one durable pending operation and respects budget',async()=>{
 const source=await readyLifecycle('auto-concurrent',{role:'admin'});
 const target=await autoFreeTarget(source,'race',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_compete_123456789');
 await Promise.all([advanceAutomaticFreeStockAllocation(db,source.uid,input),
  advanceAutomaticFreeStockAllocation(db,source.uid,input)]);
 let checkpoint=await source.read('reservationOperationReceipts','single-v2-free-batch-'+input.runId);
 for(let i=0;i<3&&checkpoint.status!=='completed';i++){
  await advanceAutomaticFreeStockAllocation(db,source.uid,input);
  checkpoint=await source.read('reservationOperationReceipts','single-v2-free-batch-'+input.runId);
 }
 assert.equal(checkpoint.status,'completed');
 assert.equal(checkpoint.allocatedQty,6);
 assert.equal((await target.read('inventoryReservations',target.orderId+'__I1')).quantity,8);
 assert.equal((await target.read('inventory',target.productKey)).onHand,12);
 const movements=await db.collection('inventoryMovements')
  .where('sourceId','==',target.orderId).get();
 assert.equal(movements.docs.filter(x=>x.data().action==='single_v2_free_stock_allocation').length,1);
});

test('FIFO pagination scans past 50 reservations and chooses the truly oldest dated order',async()=>{
 const source=await readyLifecycle('auto-paged',{role:'admin'});
 const newer=await autoFreeTarget(source,'a-newer',4,'2026-10-12');
 const older=await autoFreeTarget(source,'z-older',4,'2026-09-25');
 const newerShortageBefore=(await newer.read('orders',newer.orderId)).items[0].shortageQty;
 await source.lifecycle('cancelled');
 // These rows sort between the two actual reservation IDs by document name,
 // ensuring the oldest candidate falls strictly after the first query page.
 const batch=db.batch();
 for(let i=0;i<65;i++){
  const id=source.orderId+'-auto-m-padding-'+String(i).padStart(3,'0');
  batch.set(db.collection('inventoryReservations').doc(id+'__I1'),{
   orderId:id,itemId:'I1',productKey:source.productKey,
   warehouseId:'V2-A',quantity:0,shortageQty:1,status:'shortage'
  });
 }
 await batch.commit();
 const input=autoFreeRequest(source,'batch_paged_fifo_12345678',2);
 const result=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(result.status,'completed');
 assert.equal(result.lastOrderId,older.orderId);
 assert.equal(result.lastAllocatedQty,2);
 assert.equal((await older.read('orders',older.orderId)).items[0].shortageQty,2);
 assert.equal((await newer.read('orders',newer.orderId)).items[0].shortageQty,newerShortageBefore);
 const replay=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(replay.allocatedQty,2);
});

test('v2 cancelled order emits one durable source per freed warehouse and resumes existing FIFO allocation',async()=>{
 const source=await readyLifecycle('released-source',{role:'admin'});
 const target=await autoFreeTarget(source,'released-target',10,'2026-10-01');
 await seedLifecycleDemand(target);
 const before=await source.read('inventory',source.productKey);
 const stop=await source.lifecycle('cancelled','source_life_cancelled_123456789');
 assert.equal(stop.status,'applied');
 const wh='V2-B',sourceMoveId='single-v2-life-source_life_cancelled_123456789-'+wh;
 const proof=await source.read('inventoryMovements',sourceMoveId);
 assert.equal(proof.v2FreeStockSource,'CANCELLED_ORDER_RELEASE');
 assert.equal(proof.freeAllocationQty,6);assert.equal(proof.qty,-6);
 const targetOrderBefore=await target.read('orders',target.orderId);
 assert.equal(targetOrderBefore.items[0].shortageQty,8);
 const step=await advanceReleasedV2FreeStock(db,source.uid,{movementId:sourceMoveId});
 assert.equal(step.lastOrderId,target.orderId);assert.equal(step.lastAllocatedQty,6);
 assert.equal(step.sourceMovementId,sourceMoveId);assert.equal(step.status,'completed');
 const order=await target.read('orders',target.orderId);
 assert.equal(order.items[0].shortageQty,2);
 assert.equal((await target.read('warehouseStocks',wh+'__'+source.productKey)).reserved,8);
 assert.equal((await target.read('inventory',source.productKey)).onHand,before.onHand);
 const stable=await snapshot(target);
 const replay=await advanceReleasedV2FreeStock(db,source.uid,{movementId:sourceMoveId});
 assert.equal(replay.status,'completed');assert.equal(replay.allocatedQty,6);
 assert.deepEqual(await snapshot(target),stable);
 const aMove=await source.read('inventoryMovements','single-v2-life-source_life_cancelled_123456789-V2-A');
 assert.equal(aMove.freeAllocationQty,4);
 const second=await advanceReleasedV2FreeStock(db,source.uid,{
  movementId:'single-v2-life-source_life_cancelled_123456789-V2-A'});
 assert.equal(second.lastAllocatedQty,2);
 assert.equal((await target.read('orders',target.orderId)).items[0].shortageQty,0);
 assert.equal((await target.read('inventory',source.productKey)).onHand,before.onHand);
});
test('release-event proof, roles, and restore movements refuse illicit redistribution',async()=>{
 const x=await readyLifecycle('released-security',{role:'admin'});
 await x.lifecycle('cancelled','release_security_cancel_123456789');
 const movementId='single-v2-life-release_security_cancel_123456789-V2-B';
 await db.collection('users').doc('v2-no-release').set({active:true,role:'sales'});
 await assert.rejects(advanceReleasedV2FreeStock(db,'v2-no-release',{movementId}),/角色/);
 await assert.rejects(advanceReleasedV2FreeStock(db,x.uid,{movementId:'missing_source_123'}),/來源|找不到/);
 await assert.rejects(advanceReleasedV2FreeStock(db,x.uid,{
  movementId:'single-v2-life-unknown-release-V2-A'}),/找不到/);
 const baseline=await snapshot(x);
 const proofRef=db.collection('reservationOperationReceipts').doc('single-v2-lifecycle-release_security_cancel_123456789');
 const old=await proofRef.get(),proof=old.data();
 await proofRef.update({result:{...proof.result,warehouseDeltas:[]}});
 await assert.rejects(advanceReleasedV2FreeStock(db,x.uid,{movementId}),/憑證/);
 // The deliberately tampered proof is part of snapshot(); restore the fixture
 // first, then verify that the rejected attempt altered no stock or order.
 await proofRef.update({result:proof.result});
 assert.deepEqual(await snapshot(x),baseline);
 await x.lifecycle('normal','release_security_restore_123456789');
 await assert.rejects(advanceReleasedV2FreeStock(db,x.uid,{
  movementId:'single-v2-life-release_security_restore_123456789-V2-B'}),/釋放|憑證/);
});


test('cancelled KEEP_STOCK receipt publishes exactly the physical free v2 remainder and is safely replayed',async()=>{
 const x=await receiptLifecycle('release-source-receipt');
 await x.lifecycle('cancelled');
 await keepReceiptAsStock(x);
 const receiptId='v2_receipt_release-source-receipt';
 await x.receive(2);
 const original=await x.read('receipts',receiptId);
 assert.equal(original.reservationLocationSchemaVersion,2);
 assert.equal(original.sourceOrderStatus,'cancelled');
 assert.equal(original.autoAllocationQty,2);
 const movementRows=await db.collection('inventoryMovements').where('receiptId','==',receiptId).get();
 const sources=movementRows.docs.filter(d=>d.data().type==='receipt');
 assert.equal(sources.length,1);
 const movementId=sources[0].id,proof=sources[0].data();
 assert.equal(proof.v2FreeStockSource,undefined,'existing receiving writer is unchanged');
 assert.equal(proof.freeAllocationQty,undefined,'derive the amount from the real receipt');
 const baseline=await receiptSnapshot(x);
 const first=await advanceReleasedV2FreeStock(db,'emulator-purchaser',{movementId});
 assert.equal(first.sourceMovementId,movementId);
 assert.equal(first.status,'completed');assert.equal(first.allocatedQty,0);
 assert.deepEqual(await receiptSnapshot(x),baseline);
 const repeated=await advanceReleasedV2FreeStock(db,'emulator-purchaser',{movementId});
 assert.equal(repeated.status,'completed');assert.equal(repeated.allocatedQty,0);
 await db.collection('receipts').doc(receiptId).update({autoAllocationQty:1});
 await assert.rejects(advanceReleasedV2FreeStock(db,'emulator-purchaser',{movementId}),/receipt 憑證/);
 await db.collection('receipts').doc(receiptId).update({autoAllocationQty:2});
 await db.collection('users').doc('v2-receipt-sales').set({active:true,role:'sales'});
 await assert.rejects(advanceReleasedV2FreeStock(db,'v2-receipt-sales',{movementId}),/角色/);
 assert.deepEqual(await receiptSnapshot(x),baseline);
});
test('v2 cancelled purchase receipt stock redistributes to a separate waiting order, not the cancelled source',async()=>{
 const x=await receiptLifecycle('release-reassign-receipt');
 await x.lifecycle('cancelled');
 await keepReceiptAsStock(x);
 const competitorId=x.orderId+'-waiting',sourceOrder=await x.read('orders',x.orderId);
 const targetItem={...sourceOrder.items[0],qty:12,orderedQty:12,
  supplyOrderedQty:0,receivedQty:0,shortageQty:0,reservedQty:0,receiptEvents:[]};
 await db.collection('orders').doc(competitorId).set({...sourceOrder,status:'active',
  orderStatus:'normal',inventoryReservationStatus:'pending',
  orderLifecycleHistory:[],items:[targetItem]});
 await commitSingleItemTwoWarehouse(db,x.uid,{orderId:competitorId,itemId:'I1',
  warehouseIds:['V2-A','V2-B'],attemptId:'reserve_receipt_competitor_123456',
  syncAttemptId:'v2_123456789'});
 await db.collection('orders').doc(competitorId).update({inventoryReservationStatus:'completed'});
 const competitor={...x,orderId:competitorId};
 const demandRef=await seedLifecycleDemand(competitor);
 const start=await x.read('orders',competitorId);
 assert.equal(start.items[0].reservedQty,7);assert.equal(start.items[0].shortageQty,5);
 const receiptId='v2_receipt_release-reassign-receipt';
 await x.receive(2);
 const movementRows=await db.collection('inventoryMovements').where('receiptId','==',receiptId).get();
 const receiptProof=movementRows.docs.find(d=>d.data().type==='receipt');
 assert.ok(receiptProof);
 const first=await advanceReleasedV2FreeStock(db,'emulator-purchaser',{movementId:receiptProof.id});
 assert.equal(first.lastOrderId,competitorId);assert.equal(first.lastAllocatedQty,2);
 assert.equal(first.status,'completed');assert.equal(first.allocatedQty,2);
 const target=await x.read('orders',competitorId);
 assert.equal(target.items[0].reservedQty,9);assert.equal(target.items[0].shortageQty,3);
 const demand=await demandRef.read();
 assert.equal(demand.requestedQty,3);
 const origin=await x.read('orders',x.orderId);
 assert.equal(origin.status,'cancelled');assert.equal(origin.items[0].reservedQty,0);
 assert.equal((await x.read('inventory',x.productKey)).onHand,9);
 assert.equal((await x.read('inventory',x.productKey)).reserved,9);
 const targetLedgerBefore=await x.read('inventoryReservations',competitorId+'__I1');
 const replay=await advanceReleasedV2FreeStock(db,'emulator-purchaser',{movementId:receiptProof.id});
 assert.equal(replay.status,'completed');assert.equal(replay.allocatedQty,2);
 assert.deepEqual(await x.read('inventoryReservations',competitorId+'__I1'),targetLedgerBefore);
});
test('v2 source receiving that reserves its whole receipt must never publish a free-stock source',async()=>{
 const x=await receiptLifecycle('release-no-free');
 await x.receive(1);
 const movementRows=await db.collection('inventoryMovements')
  .where('receiptId','==','v2_receipt_release-no-free').get();
 const receiptProof=movementRows.docs.find(d=>d.data().type==='receipt');
 assert.ok(receiptProof);
 assert.equal(receiptProof.data().v2FreeStockSource,undefined);
 await assert.rejects(advanceReleasedV2FreeStock(db,'emulator-purchaser',{
  movementId:receiptProof.id}),/receipt 憑證/);
});

test('v2 cancellation post-commit orchestrator redistributes both warehouses without duplicating source transactions',async()=>{
 const source=await readyLifecycle('postcommit-both',{role:'admin'});
 const target=await autoFreeTarget(source,'waiting-post',10,'2026-09-01');
 await seedLifecycleDemand(target);
 const original=await source.read('inventory',source.productKey);
 const cancelIntent=source.intent('cancelled','postcommit_cancel_admin_12345678');
 const committed=await commitSingleItemLocationLifecycleAndRecover(db,source.uid,cancelIntent);
 assert.equal(committed.status,'applied');
 assert.equal(committed.postCommitAllocation.status,'completed');
 assert.equal(committed.postCommitAllocation.sources.length,2);
 assert.equal(committed.postCommitAllocation.sources.every(x=>x.recoveryPending===false),true);
 assert.equal((await target.read('orders',target.orderId)).items[0].shortageQty,0);
 assert.equal((await source.read('orders',source.orderId)).status,'cancelled');
 assert.equal((await source.read('inventory',source.productKey)).onHand,original.onHand);
 assert.equal((await source.read('inventory',source.productKey)).reserved,10);
 const before=await snapshot(target);
 const retry=await commitSingleItemLocationLifecycleAndRecover(db,source.uid,cancelIntent);
 assert.equal(retry.status,'already-applied');
 assert.equal(retry.postCommitAllocation.status,'completed');
 assert.deepEqual(await snapshot(target),before);
});
test('bounded release worker resumes identical source event across calls without duplicating movements',async()=>{
 const source=await readyLifecycle('postcommit-bounded',{role:'admin'});
 const older=await autoFreeTarget(source,'old',4,'2026-09-01');
 const newer=await autoFreeTarget(source,'new',5,'2026-09-02');
 await seedLifecycleDemand(older);await seedLifecycleDemand(newer);
 await source.lifecycle('cancelled','postcommit_bounded_cancel_1234');
 const movementId='single-v2-life-postcommit_bounded_cancel_1234-V2-B';
 const step=await drainReleasedV2FreeStock(db,source.uid,{movementId,maxSteps:1});
 assert.equal(step.status,'active');assert.equal(step.recoveryPending,true);
 assert.equal(step.stepsAttempted,1);assert.equal(step.allocatedQty,2);
 const done=await drainReleasedV2FreeStock(db,source.uid,{movementId,maxSteps:3});
 assert.equal(done.status,'completed');assert.equal(done.recoveryPending,false);
 assert.equal(done.allocatedQty,6);assert.equal(done.stepsAttempted,1);
 const both=await Promise.all([drainReleasedV2FreeStock(db,source.uid,{movementId,maxSteps:1}),
  drainReleasedV2FreeStock(db,source.uid,{movementId,maxSteps:1})]);
 assert.equal(both.every(x=>x.status==='completed'&&x.allocatedQty===6),true);
 const rows=await db.collection('inventoryMovements').where('sourceId','==',newer.orderId).get();
 assert.equal(rows.docs.filter(x=>x.data().action==='single_v2_free_stock_allocation').length,1);
 await assert.rejects(drainReleasedV2FreeStock(db,source.uid,{movementId,maxSteps:11}),/最多十個步驟/);
});
test('post-commit cancellation by a sales actor cannot claim warehouse authority; committed source remains recoverable',async()=>{
 const source=await readyLifecycle('postcommit-sales',{role:'sales'});
 const target=await autoFreeTarget(source,'waiting-sales',10,'2026-09-01');
 await seedLifecycleDemand(target);
 const cancelIntent=source.intent('cancelled','postcommit_cancel_sales_12345678');
 const completed=await commitSingleItemLocationLifecycleAndRecover(db,source.uid,cancelIntent);
 assert.equal(completed.status,'applied');
 assert.equal(completed.postCommitAllocation.status,'recovery-pending');
 assert.equal(completed.postCommitAllocation.sources.every(x=>x.recoveryPending),true);
 assert.equal(completed.postCommitAllocation.sources.every(x=>x.errorCode==='permission-denied'),true);
 assert.equal((await source.read('orders',source.orderId)).status,'cancelled');
 const before=(await target.read('orders',target.orderId)).items[0].shortageQty;
 assert.equal(before,8);
 const dispatcher='postcommit-resumer-'+source.orderId;
 await db.collection('users').doc(dispatcher).set({role:'warehouse',active:true});
 const resumed=await drainReleasedV2FreeStock(db,dispatcher,{
  movementId:'single-v2-life-'+cancelIntent.operationId+'-V2-B',maxSteps:5});
 assert.equal(resumed.status,'completed');assert.equal(resumed.allocatedQty,6);
 assert.equal((await target.read('orders',target.orderId)).items[0].shortageQty,2);
 const originalReplay=await commitSingleItemLocationLifecycleAndRecover(db,source.uid,cancelIntent);
 assert.equal(originalReplay.status,'already-applied');
 assert.equal(originalReplay.postCommitAllocation.status,'recovery-pending');
});


test('completed FIFO checkpoints reject corrupt totals and pending work instead of reporting success',async()=>{
 const source=await readyLifecycle('auto-completed-integrity',{role:'admin'});
 await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_completed_integrity_123');
 assert.equal((await advanceAutomaticFreeStockAllocation(db,source.uid,input)).status,'completed');
 const ref=db.collection('reservationOperationReceipts').doc('single-v2-free-batch-'+input.runId);
 const original=(await ref.get()).data(),before=await snapshot(source);
 for(const patch of [{allocatedQty:7},{allocatedQty:-1},{processedSteps:1001},
   {pending:{}},{completionReason:'invented'},{allocatedQty:5},
   {actorUid:''},{actorRole:'sales'},{handoffCount:-1},{createdActorUid:null}]){
  await ref.set({...original,...patch});
  await assert.rejects(advanceAutomaticFreeStockAllocation(db,source.uid,input),/checkpoint/);
  assert.deepEqual(await snapshot(source),before);
  assert.deepEqual((await ref.get()).data(),{...original,...patch});
 }
 await ref.set(original);
 assert.equal((await advanceAutomaticFreeStockAllocation(db,source.uid,input)).allocatedQty,6);
});

test('pending FIFO checkpoints cannot change the retry identity or exceed the remaining source budget',async()=>{
 const source=await readyLifecycle('auto-pending-integrity',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_pending_integrity_12345');
 const ref=db.collection('reservationOperationReceipts').doc('single-v2-free-batch-'+input.runId);
 // Interrupt immediately after the pending command is durable, before stock.
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),
  runTransaction:fn=>db.runTransaction(tx=>fn({
   get:x=>tx.get(x),create:(...args)=>{
    if(args[0].path.startsWith('inventoryMovements/single-v2-free-'))
     throw Error('pause before allocation commit');
    return tx.create(...args);
   },set:(...args)=>tx.set(...args),update:(...args)=>tx.update(...args)
  }))};
 await assert.rejects(advanceAutomaticFreeStockAllocation(wrapper,source.uid,input),/pause before/);
 const original=(await ref.get()).data(),before=await snapshot(target);
 assert.equal(original.pending.orderId,target.orderId);
 for(const patch of [{quantity:7},{quantity:0},{quantity:1.5},{orderId:'another-order'},
   {operationId:'another_operation_123456'},{syncAttemptId:''},{unexpected:true}]){
  await ref.set({...original,pending:{...original.pending,...patch}});
  await assert.rejects(advanceAutomaticFreeStockAllocation(db,source.uid,input),/checkpoint/);
  assert.deepEqual(await snapshot(target),before);
 }
 await ref.set({...original,processedSteps:1});
 await assert.rejects(advanceAutomaticFreeStockAllocation(db,source.uid,input),/checkpoint/);
 assert.deepEqual(await snapshot(target),before);
 await ref.set(original);
 const resumed=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(resumed.status,'completed');assert.equal(resumed.allocatedQty,6);
 assert.equal((await target.read('inventory',target.productKey)).reserved,8);
});

test('FIFO validates a checkpoint again inside finalization after a committed stock movement',async()=>{
 const source=await readyLifecycle('auto-finalization-integrity',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_finalize_integrity_1234');
 const path='reservationOperationReceipts/single-v2-free-batch-'+input.runId;
 let stockCommitted=false,injected=false;
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),
  runTransaction:async fn=>{
   const result=await db.runTransaction(tx=>fn({
    get:async ref=>{
     const snap=await tx.get(ref);
     if(stockCommitted&&ref.path===path){
      injected=true;
      return {exists:true,data:()=>({...snap.data(),allocatedQty:-1})};
     }
     return snap;
    },create:(...args)=>tx.create(...args),set:(...args)=>tx.set(...args),
    update:(...args)=>tx.update(...args)
   }));
   if(result?.status==='applied'&&result?.movementId)stockCommitted=true;
   return result;
  }};
 await assert.rejects(advanceAutomaticFreeStockAllocation(wrapper,source.uid,input),/checkpoint/);
 assert.equal(injected,true);
 const afterStock=await snapshot(target);
 assert.equal(afterStock.documents[1].reserved,8);
 const resumed=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(resumed.status,'completed');assert.equal(resumed.allocatedQty,6);
 assert.deepEqual(await snapshot(target),afterStock);
});

async function pauseAutomaticAllocation(source,input,afterStock=false){
 let calls=0;
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),
  runTransaction:fn=>{
   if(!afterStock&&++calls===3)throw Error('paused before stock transaction');
   return db.runTransaction(tx=>fn({get:r=>tx.get(r),create:(...a)=>tx.create(...a),
    set:(...a)=>tx.set(...a),update:(ref,patch)=>{
     if(afterStock&&ref.path==='reservationOperationReceipts/single-v2-free-batch-'+input.runId
       &&patch.processedSteps===1)throw Error('paused after stock transaction');
     return tx.update(ref,patch);
    }}));
  }};
 await assert.rejects(advanceAutomaticFreeStockAllocation(wrapper,source.uid,input),/paused/);
 return db.collection('reservationOperationReceipts').doc('single-v2-free-batch-'+input.runId);
}
async function allocationActor(id,role='warehouse',extra={}){
 const uid='handoff-'+id;
 await db.collection('users').doc(uid).set({active:true,role,...extra});
 return uid;
}
async function handoffAudits(runId){
 const rows=await db.collection('reservationOperationReceipts').where('runId','==',runId).get();
 return rows.docs.map(d=>d.data()).filter(r=>r.action==='single_v2_free_stock_handoff');
}
test('currently authorized logistics roles automatically resume another actor without resetting the source budget',async()=>{
 for(const role of ['admin','purchaser','warehouse']){
  const source=await readyLifecycle('handoff-roles-'+role,{role:'admin'});
  const older=await autoFreeTarget(source,'older',4,'2026-09-01');
  const newer=await autoFreeTarget(source,'newer',5,'2026-09-02');
  await source.lifecycle('cancelled');
  const input=autoFreeRequest(source,'batch_handoff_roles_'+role+'_123');
  const first=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
  assert.equal(first.allocatedQty,2);assert.equal(first.status,'active');
  await db.collection('users').doc(source.uid).update({disabled:true});
  const next=await allocationActor('roles-'+role,role);
  const done=await advanceAutomaticFreeStockAllocation(db,next,input);
  assert.equal(done.allocatedQty,6);assert.equal(done.processedSteps,2);assert.equal(done.status,'completed');
  const job=await source.read('reservationOperationReceipts','single-v2-free-batch-'+input.runId);
  assert.equal(job.createdActorUid,source.uid);assert.equal(job.actorUid,next);assert.equal(job.actorRole,role);
  assert.equal(job.handoffCount,1);assert.equal(job.maxQty,6);
  const audits=await handoffAudits(input.runId);
  assert.equal(audits.length,1);assert.equal(audits[0].fromActorUid,source.uid);
  assert.equal(audits[0].actorUid,next);assert.equal(audits[0].reconciledQty,0);
  for(const [target,actor] of [[older,source.uid],[newer,next]]){
   const moves=await db.collection('inventoryMovements').where('sourceId','==',target.orderId).get();
   const assigned=moves.docs.map(d=>d.data()).filter(r=>r.action==='single_v2_free_stock_allocation');
   assert.equal(assigned.length,1);assert.equal(assigned[0].actorUid,actor);
  }
  assert.equal((await source.read('inventory',source.productKey)).onHand,12);
  assert.equal((await source.read('inventory',source.productKey)).reserved,8);
 }
});
test('handoff of an uncommitted pending command retains its operation ID and executes once as the new actor',async()=>{
 const source=await readyLifecycle('handoff-uncommitted',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_handoff_uncommitted_123');
 const ref=await pauseAutomaticAllocation(source,input),original=(await ref.get()).data();
 assert.equal(original.allocatedQty,0);assert.ok(original.pending);
 const next=await allocationActor('uncommitted');
 const done=await advanceAutomaticFreeStockAllocation(db,next,input);
 assert.equal(done.allocatedQty,6);assert.equal(done.status,'completed');
 const move=await source.read('inventoryMovements','single-v2-free-'+original.pending.operationId);
 assert.equal(move.actorUid,next);assert.equal(move.qty,6);
 assert.equal((await ref.get()).data().processedSteps,1);
 const baseline=await snapshot(target),job=(await ref.get()).data();
 const observer=await allocationActor('completed-observer','purchaser');
 assert.equal((await advanceAutomaticFreeStockAllocation(db,observer,input)).allocatedQty,6);
 assert.deepEqual((await ref.get()).data(),job);
 assert.deepEqual(await snapshot(target),baseline);
 assert.equal((await handoffAudits(input.runId)).length,1);
});
test('handoff reconciles the prior actor committed movement before continuing and preserves original audit identity',async()=>{
 const source=await readyLifecycle('handoff-committed',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_handoff_committed_12345');
 const ref=await pauseAutomaticAllocation(source,input,true),original=(await ref.get()).data();
 const before=await snapshot(target);
 const next=await allocationActor('committed');
 const done=await advanceAutomaticFreeStockAllocation(db,next,input);
 assert.equal(done.status,'completed');assert.equal(done.allocatedQty,6);assert.equal(done.processedSteps,1);
 assert.deepEqual(await snapshot(target),before);
 const move=await source.read('inventoryMovements','single-v2-free-'+original.pending.operationId);
 assert.equal(move.actorUid,source.uid);
 const audits=await handoffAudits(input.runId);
 assert.equal(audits.length,1);assert.equal(audits[0].reconciledQty,6);
 assert.equal(audits[0].reconciledOperationId,original.pending.operationId);
 assert.equal((await ref.get()).data().actorUid,next);
});
test('a stale worker paused before stock commit cannot execute after another actor takes over',async()=>{
 const source=await readyLifecycle('handoff-stale-worker',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_handoff_stale_worker_123');
 let release,paused,calls=0;
 const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{paused=r;});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),
  runTransaction:async fn=>{
   if(++calls===3){paused();await gate;}
   return db.runTransaction(fn);
  }};
 const old=advanceAutomaticFreeStockAllocation(wrapper,source.uid,input)
  .then(value=>({value}),error=>({error}));
 await ready;
 const next=await allocationActor('stale-worker');
 let done;
 try{done=await advanceAutomaticFreeStockAllocation(db,next,input);}finally{release();}
 const stale=await old;
 assert.match(stale.error?.message||'',/其他操作人員接手/);
 assert.equal(done.allocatedQty,6);assert.equal(done.status,'completed');
 assert.equal((await target.read('inventory',target.productKey)).reserved,8);
 const rows=await db.collection('inventoryMovements').where('sourceId','==',target.orderId).get();
 const actual=rows.docs.map(d=>d.data()).filter(x=>x.action==='single_v2_free_stock_allocation');
 assert.equal(actual.length,1);assert.equal(actual[0].actorUid,next);
});
test('handoff refuses unauthorized actors and corrupt original movement without modifying ownership or progress',async()=>{
 const source=await readyLifecycle('handoff-denials',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_handoff_denials_1234567');
 const ref=await pauseAutomaticAllocation(source,input,true),job=(await ref.get()).data();
 const before=await snapshot(target);
 for(const [role,extra] of [['sales',{}],['engineer',{}],['warehouse',{disabled:true}],['admin',{active:false}]]){
  const actor=await allocationActor('deny-'+role+Object.keys(extra).join(''),role,extra);
  await assert.rejects(advanceAutomaticFreeStockAllocation(db,actor,input),/權限/);
  assert.deepEqual((await ref.get()).data(),job);assert.deepEqual(await snapshot(target),before);
 }
 const next=await allocationActor('corrupt-proof');
 const movementRef=db.collection('inventoryMovements').doc('single-v2-free-'+job.pending.operationId);
 const proof=(await movementRef.get()).data();
 for(const patch of [{actorUid:next},{actorRole:'warehouse'},{qty:5},{intentHash:'wrong'},
   {productKey:'another-product'},{reservedDelta:0},{result:{...proof.result,allocatedQty:5}}]){
  await movementRef.set({...proof,...patch});
  await assert.rejects(advanceAutomaticFreeStockAllocation(db,next,input),/憑證不一致/);
  assert.deepEqual((await ref.get()).data(),job);
  assert.equal((await handoffAudits(input.runId)).length,0);
 }
 await movementRef.set(proof);
 assert.equal((await advanceAutomaticFreeStockAllocation(db,next,input)).allocatedQty,6);
 assert.deepEqual(await snapshot(target),before);
});
test('two different operators racing to resume one pending batch cannot double allocate',async()=>{
 const source=await readyLifecycle('handoff-racing-operators',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_handoff_racing_12345678');
 const ref=await pauseAutomaticAllocation(source,input);
 const a=await allocationActor('race-A'),b=await allocationActor('race-B','purchaser');
 const results=await Promise.allSettled([advanceAutomaticFreeStockAllocation(db,a,input),
  advanceAutomaticFreeStockAllocation(db,b,input)]);
 assert.ok(results.some(r=>r.status==='fulfilled'&&r.value.status==='completed'));
 for(const r of results)if(r.status==='rejected')assert.match(r.reason.message,/其他操作人員接手/);
 const job=(await ref.get()).data();
 assert.equal(job.status,'completed');assert.equal(job.allocatedQty,6);assert.equal(job.processedSteps,1);
 assert.ok(job.handoffCount>=1&&job.handoffCount<=2);
 assert.equal((await target.read('inventory',target.productKey)).reserved,8);
 const rows=await db.collection('inventoryMovements').where('sourceId','==',target.orderId).get();
 assert.equal(rows.docs.filter(d=>d.data().action==='single_v2_free_stock_allocation').length,1);
});
test('source movement bounded recovery automatically hands unfinished FIFO work to another warehouse operator',async()=>{
 const source=await readyLifecycle('handoff-real-source',{role:'admin'});
 await autoFreeTarget(source,'older',4,'2026-09-01');
 await autoFreeTarget(source,'newer',5,'2026-09-02');
 await source.lifecycle('cancelled','handoff_source_cancelled_1234');
 const movementId='single-v2-life-handoff_source_cancelled_1234-V2-B';
 const first=await drainReleasedV2FreeStock(db,source.uid,{movementId,maxSteps:1});
 assert.equal(first.status,'active');assert.equal(first.allocatedQty,2);
 const next=await allocationActor('real-source');
 const done=await drainReleasedV2FreeStock(db,next,{movementId,maxSteps:2});
 assert.equal(done.status,'completed');assert.equal(done.allocatedQty,6);assert.equal(done.recoveryPending,false);
 const audits=await handoffAudits(done.runId);
 assert.equal(audits.length,1);assert.equal(audits[0].actorUid,next);
});

test('handoff audit write failure rolls back ownership and reconciliation together',async()=>{
 const source=await readyLifecycle('handoff-audit-rollback',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_handoff_audit_rollback_123');
 const ref=await pauseAutomaticAllocation(source,input,true),job=(await ref.get()).data();
 const before=await snapshot(target);
 const next=await allocationActor('audit-rollback');
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),
  runTransaction:fn=>db.runTransaction(tx=>fn({get:r=>tx.get(r),set:(...a)=>tx.set(...a),
   update:(...a)=>tx.update(...a),create:(ref,...a)=>{
    if(ref.id.startsWith('single-v2-free-handoff-'))throw Error('handoff audit unavailable');
    return tx.create(ref,...a);
   }}))};
 await assert.rejects(advanceAutomaticFreeStockAllocation(wrapper,next,input),/audit unavailable/);
 assert.deepEqual((await ref.get()).data(),job);assert.deepEqual(await snapshot(target),before);
 assert.equal((await handoffAudits(input.runId)).length,0);
 assert.equal((await advanceAutomaticFreeStockAllocation(db,next,input)).allocatedQty,6);
 assert.deepEqual(await snapshot(target),before);
});
test('a new operator disabled after taking ownership cannot commit; another authorized operator resumes the same command',async()=>{
 const source=await readyLifecycle('handoff-disabled-during-work',{role:'admin'});
 const target=await autoFreeTarget(source,'target',10);
 await source.lifecycle('cancelled');
 const input=autoFreeRequest(source,'batch_handoff_disabled_during_123');
 const ref=await pauseAutomaticAllocation(source,input),original=(await ref.get()).data();
 const next=await allocationActor('disabled-during-work');
 let release,paused,calls=0;
 const gate=new Promise(r=>{release=r;}),ready=new Promise(r=>{paused=r;});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),
  runTransaction:async fn=>{if(++calls===2){paused();await gate;}return db.runTransaction(fn);}};
 const pending=advanceAutomaticFreeStockAllocation(wrapper,next,input)
  .then(value=>({value}),error=>({error}));
 await ready;
 try{await db.collection('users').doc(next).update({disabled:true});}finally{release();}
 assert.match((await pending).error?.message||'',/不可重新分配/);
 assert.equal((await ref.get()).data().pending.operationId,original.pending.operationId);
 assert.equal((await target.read('inventory',target.productKey)).reserved,2);
 const last=await allocationActor('after-disabled','purchaser');
 const done=await advanceAutomaticFreeStockAllocation(db,last,input);
 assert.equal(done.allocatedQty,6);assert.equal(done.status,'completed');
 const proof=await target.read('inventoryMovements','single-v2-free-'+original.pending.operationId);
 assert.equal(proof.actorUid,last);
 assert.equal((await ref.get()).data().handoffCount,2);
});

test('real purchased receipt shipment and CLOSE return preserve supply history through cancellation and restoration',async()=>{
 const x=await receiptShipmentLifecycle('close-life-integration');
 await x.receive(1,'close_life_real_receipt_123');
 await x.prepare(1,'first');await x.ship(1,'first');await x.confirm(1,'first');
 const order=await x.read('orders',x.orderId),shipment=order.warehouseShipmentRecords[0];
 const selected=shipment.lotAllocations[0];
 const received=await require('../functions/location-return-service').commitLocationReturn(db,x.uid,{
  orderId:x.orderId,itemId:'I1',shipmentId:shipment.id,syncAttemptId:'v2_123456789',
  operationId:'close_life_real_return_1234',warehouseId:'V2-A',date:'2026-10-18',
  reason:'客戶結案退貨',condition:'RESTOCKABLE',settlement:'CLOSE',selections:[{lotId:selected.lotId,qty:1}]});
 assert.equal(received.returnedQty,1);assert.equal(received.replacementQty,0);
 const before=await receiptSnapshot(x);
 const cancel={...x.intent('cancelled','close_life_real_cancel_1234'),date:'2026-10-19'};
 assert.equal((await commitSingleItemLocationLifecycle(db,x.uid,cancel)).companyReservedDelta,-7);
 const restore={...x.intent('normal','close_life_real_restore_123'),date:'2026-10-20'};
 const restored=await commitSingleItemLocationLifecycle(db,x.uid,restore);
 assert.equal(restored.reservedQty,7);assert.equal(restored.shortageQty,2);
 const after=await receiptSnapshot(x);
 assert.deepEqual(after.state.po,before.state.po);assert.deepEqual(after.state.supplies,before.state.supplies);
 for(const name of ['inventoryLots','inventoryLotCosts','receipts'])
  assert.deepEqual(after.documents[name],before.documents[name],name);
 const current=after.state.base.documents[0];
 assert.equal(current.items[0].supplyOrderedQty,3);assert.equal(current.items[0].receivedQty,1);
 assert.equal(current.deliveredQty,1);assert.equal(current.returnedQty,1);
 assert.deepEqual(current.returnRecords,before.state.base.documents[0].returnRecords);
 assert.equal(after.state.base.documents[1].onHand,8);assert.equal(after.state.base.documents[1].incoming,2);
 assert.equal(after.state.demand.orderedQty,3);assert.equal(after.state.demand.receivedQty,1);
 assert.equal(after.state.demand.remainingToOrderQty,0);assert.equal(after.state.demand.remainingToReceiveQty,2);
});

async function closedReceiptLifecycle(name,{settlement='CLOSE',shipped=1,confirmed=shipped}={}){
 const x=await receiptShipmentLifecycle('closed-receipt-'+name);
 await x.receive(1,'closed_initial_receipt_'+name);await x.prepare(shipped,'first');await x.ship(shipped,'first');await x.confirm(confirmed,'first');
 const order=await x.read('orders',x.orderId),shipment=order.warehouseShipmentRecords[0];
 const result=await require('../functions/location-return-service').commitLocationReturn(db,x.uid,{
  orderId:x.orderId,itemId:'I1',shipmentId:shipment.id,syncAttemptId:'v2_123456789',
  operationId:'closed_customer_return_'+name,warehouseId:'V2-A',date:'2026-10-17',
  reason:'訂錯貨結案',condition:'RESTOCKABLE',settlement,selections:[{lotId:shipment.lotAllocations[0].lotId,qty:1}]});
 return {...x,returnMovementId:result.movementId};
}
test('CLOSE return permits remaining partial PO receipts with fixed-ID replay and completes original remaining shipments',async()=>{
 const x=await closedReceiptLifecycle('complete'),before=await receiptSnapshot(x);
 await x.receive(1,'closed_next_receipt_complete');
 const once=await receiptSnapshot(x);await x.receive(1,'closed_next_receipt_complete');assert.deepEqual(await receiptSnapshot(x),once);
 await assert.rejects(x.receive(2,'closed_next_receipt_complete'),/識別碼衝突/);
 await x.receive(1,'closed_final_receipt_complete');
 let order=await x.read('orders',x.orderId),stock=await x.read('inventory',x.productKey);
 assert.equal(order.items[0].reservedQty,9);assert.equal(order.items[0].shortageQty,0);assert.equal(order.items[0].receivedQty,3);
 assert.equal(stock.onHand,10);assert.equal(stock.reserved,9);assert.equal(stock.incoming,0);
 assert.deepEqual(order.returnRecords,before.state.base.documents[0].returnRecords);
 assert.deepEqual(order.returnHistory,before.state.base.documents[0].returnHistory);
 await x.prepare(9,'last');await x.ship(6,'a');await x.ship(3,'b','V2-B');await x.confirm(6,'a');await x.confirm(3,'b');
 order=await x.read('orders',x.orderId);stock=await x.read('inventory',x.productKey);
 assert.equal(order.isDelivered,true);assert.equal(order.deliveredQty,10);assert.equal(order.returnedQty,1);
 assert.equal(order.items[0].warehouseShippedQty,10);assert.equal(stock.onHand,1);assert.equal(stock.reserved,0);
 const demand=(await x.demandRef.get()).data();assert.equal(demand.receivedQty,3);assert.equal(demand.requestedQty,3);
 assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,0);
});
test('CLOSE receipt while other shipped goods await acknowledgement never reserves those units again',async()=>{
 const x=await closedReceiptLifecycle('pending',{shipped:2,confirmed:1});await x.receive(2,'closed_pending_receipt_final');
 const order=await x.read('orders',x.orderId),stock=await x.read('inventory',x.productKey);
 assert.equal(order.items[0].reservedQty,8);assert.equal(order.items[0].shortageQty,0);assert.equal(order.items[0].warehouseShippedQty,2);
 assert.equal(order.deliveredQty,1);assert.equal(order.returnedQty,1);assert.equal(stock.reserved,8);assert.equal(stock.incoming,0);
});
test('CLOSE then cancelled KEEP_STOCK receipt remains free stock and restores only remaining demand',async()=>{
 const x=await closedReceiptLifecycle('cancelled');await x.lifecycle('cancelled');
 const blocked=await receiptSnapshot(x);await assert.rejects(x.receive(),/採購確認/);assert.deepEqual(await receiptSnapshot(x),blocked);
 await keepReceiptAsStock(x);const before=await receiptSnapshot(x);await x.receive(2,'closed_cancelled_receipt_final');
 let order=await x.read('orders',x.orderId),stock=await x.read('inventory',x.productKey);
 assert.equal(order.status,'cancelled');assert.equal(order.items[0].reservedQty,0);assert.equal(order.items[0].receivedQty,3);
 assert.equal(stock.onHand,10);assert.equal(stock.reserved,0);assert.equal(stock.incoming,0);
 assert.deepEqual(order.returnRecords,before.state.base.documents[0].returnRecords);
 const restore=await x.lifecycle('normal');assert.equal(restore.reservedQty,9);assert.equal(restore.shortageQty,0);
 assert.equal((await x.demandRef.get()).data().remainingToOrderQty,0);
});
test('receipt after CLOSE cancellation and restoration uses current location ledger without reopening closed demand',async()=>{
 const x=await closedReceiptLifecycle('restored');await x.lifecycle('cancelled');await x.lifecycle('normal');
 await x.receive(2,'closed_restored_receipt_final');
 const order=await x.read('orders',x.orderId),stock=await x.read('inventory',x.productKey);
 assert.equal(order.items[0].reservedQty,9);assert.equal(order.items[0].shortageQty,0);
 assert.equal(stock.reserved,9);assert.equal(stock.incoming,0);assert.equal(order.returnedQty,1);
 assert.equal((await x.demandRef.get()).data().requestedQty,3);
});
test('post-return receipts reject altered, missing or hidden return evidence and projections with no partial writes',async()=>{
 const cases=[
  ['missing',x=>db.collection('inventoryMovements').doc(x.returnMovementId).delete()],
  ['quantity',x=>db.collection('inventoryMovements').doc(x.returnMovementId).update({qty:2})],
  ['warehouse',x=>db.collection('inventoryMovements').doc(x.returnMovementId).update({warehouseId:'V2-B'})],
  ['hash',x=>db.collection('inventoryMovements').doc(x.returnMovementId).update({intentHash:'forged'})],
  ['record',x=>db.collection('inventoryMovements').doc(x.returnMovementId).update({'returnRecord.reason':'altered'})],
  ['hidden',async x=>{const o=await x.read('orders',x.orderId);o.items[0].returnedQty=0;
   await db.collection('orders').doc(x.orderId).update({items:o.items,returnRecords:[],returnHistory:[],returnedQty:0});}],
  ['cache',x=>db.collection('orders').doc(x.orderId).update({returnedQty:0})],
  ['item',async x=>{const o=await x.read('orders',x.orderId);o.items[0].returnedQty=0;await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['history',x=>db.collection('orders').doc(x.orderId).update({returnHistory:[{action:'remove',recordId:'unknown'}]})],
 ];
 for(const [name,mutate] of cases){const x=await closedReceiptLifecycle('reject-'+name);await mutate(x);
  const before=await receiptSnapshot(x);await assert.rejects(x.receive(1,'closed_rejected_receipt_'+name));assert.deepEqual(await receiptSnapshot(x),before,name);}
 const replace=await closedReceiptLifecycle('replace',{settlement:'REPLACE'}),before=await receiptSnapshot(replace);
 await assert.rejects(replace.receive(1,'closed_replace_receipt_rejected'),/CLOSE/);assert.deepEqual(await receiptSnapshot(replace),before);
});
test('CLOSE receipt races with physical return or cancellation serialize without duplicate reservation',async()=>{
 const x=await receiptShipmentLifecycle('closed-race');await x.receive(1,'closed_race_initial_receipt');await x.prepare(1,'first');await x.ship(1,'first');await x.confirm(1,'first');
 const order=await x.read('orders',x.orderId),shipment=order.warehouseShipmentRecords[0];
 await Promise.all([x.receive(1,'closed_race_next_receipt'),require('../functions/location-return-service').commitLocationReturn(db,x.uid,{
  orderId:x.orderId,itemId:'I1',shipmentId:shipment.id,syncAttemptId:'v2_123456789',operationId:'closed_race_customer_return',
  warehouseId:'V2-A',date:'2026-10-17',reason:'結案',condition:'RESTOCKABLE',settlement:'CLOSE',selections:[{lotId:shipment.lotAllocations[0].lotId,qty:1}]})]);
 let stock=await x.read('inventory',x.productKey);assert.equal(stock.onHand,9);assert.equal(stock.reserved,8);assert.equal(stock.incoming,1);
 const results=await Promise.allSettled([x.receive(1,'closed_race_final_receipt'),x.lifecycle('cancelled')]);
 assert.equal(results[1].status,'fulfilled');stock=await x.read('inventory',x.productKey);
 const current=await x.read('orders',x.orderId);assert.equal(current.status,'cancelled');assert.equal(stock.reserved,0);
 assert.equal(stock.onHand,current.items[0].receivedQty+7);assert.equal(stock.incoming,3-current.items[0].receivedQty);
});
test('late post-CLOSE receipt failure rolls back stock lots cost source and demand; retry posts once',async()=>{
 const x=await closedReceiptLifecycle('rollback'),collision=db.collection('inventoryMovements').doc('closed-receipt-collision');await collision.set({marker:true});
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn({get:r=>tx.get(r),update:(...a)=>tx.update(...a),
  set:(ref,...args)=>{if(ref.parent.id==='receipts')tx.create(collision,{marker:false});return tx.set(ref,...args);}}));
 const before=await receiptSnapshot(x);await assert.rejects(x.receive(2,'closed_rollback_final_receipt'));assert.deepEqual(await receiptSnapshot(x),before);
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn(tx));await x.receive(2,'closed_rollback_final_receipt');
 const after=await receiptSnapshot(x);await x.receive(2,'closed_rollback_final_receipt');assert.deepEqual(await receiptSnapshot(x),after);
 assert.equal(after.state.base.documents[1].onHand,10);assert.equal(after.state.base.documents[1].reserved,9);
});

test('purchased stock can CLOSE return after cancellation then KEEP_STOCK receipt and restore without reviving closed demand',async()=>{
 const x=await receiptShipmentLifecycle('cancel-return-po');await x.receive(1,'cancel_return_po_initial_receipt');
 await x.prepare(1,'first');await x.ship(1,'first');await x.confirm(1,'first');await x.lifecycle('cancelled');
 const before=await receiptSnapshot(x),o=await x.read('orders',x.orderId),shipment=o.warehouseShipmentRecords[0];
 const intent={orderId:x.orderId,itemId:'I1',shipmentId:shipment.id,syncAttemptId:'v2_123456789',
  operationId:'cancel_return_po_customer_return',warehouseId:'V2-A',date:'2026-10-18',reason:'取消後結案退貨',
  condition:'RESTOCKABLE',settlement:'CLOSE',selections:[{lotId:shipment.lotAllocations[0].lotId,qty:1}]};
 const returned=await require('../functions/location-return-service').commitLocationReturn(db,x.uid,intent);assert.equal(returned.reservedQty,0);
 const afterReturn=await receiptSnapshot(x);assert.deepEqual(afterReturn.state.po,before.state.po);assert.deepEqual(afterReturn.state.supplies,before.state.supplies);
 assert.deepEqual(afterReturn.state.demand,before.state.demand);assert.deepEqual(afterReturn.documents.receipts,before.documents.receipts);
 assert.deepEqual(afterReturn.documents.inventoryLotCosts,before.documents.inventoryLotCosts);
 const blocked=await receiptSnapshot(x);await assert.rejects(x.receive(2,'cancel_return_po_remaining_receipt'),/採購確認/);assert.deepEqual(await receiptSnapshot(x),blocked);
 await keepReceiptAsStock(x);await x.receive(2,'cancel_return_po_remaining_receipt');
 const stocked=await receiptSnapshot(x);assert.equal(stocked.state.base.documents[0].status,'cancelled');assert.equal(stocked.state.base.documents[1].reserved,0);
 assert.equal(stocked.state.base.documents[1].onHand,10);assert.equal(stocked.state.base.documents[1].incoming,0);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,9);assert.equal(restored.shortageQty,0);
 const final=await receiptSnapshot(x);assert.equal(final.state.demand.requestedQty,3);assert.equal(final.state.demand.receivedQty,3);
 assert.equal(final.state.demand.remainingToOrderQty,0);assert.equal(final.state.demand.remainingToReceiveQty,0);
 assert.equal(final.state.base.documents[0].returnedQty,1);assert.deepEqual(final.state.base.documents[0].returnRecords,afterReturn.state.base.documents[0].returnRecords);
 await require('../functions/location-return-service').commitLocationReturn(db,x.uid,intent);assert.deepEqual(await receiptSnapshot(x),final);
});

const {synchronizeV2OrderFixture}=require('./fixtures/v2-order-initialization.cjs');
const initialize=x=>synchronizeV2OrderFixture(db,x.uid,{orderId:x.orderId,warehouseIds:['V2-A','V2-B']});
async function initializedSource(name,options={}){return seed('real-init-'+name,{company:7,a:4,b:3,...options});}
async function initializationReceipts(x){return (await db.collection('reservationOperationReceipts').where('orderId','==',x.orderId).get()).docs.map(s=>s.data());}
const initDemandId=x=>encodeURIComponent('SALES_ORDER:'+x.orderId+':I1');
test('real source synchronization rotates attempt reserves both warehouses persists actual demand then completes its checkpoint',async()=>{
 const x=await initializedSource('demand'),result=await initialize(x),order=await x.read('orders',x.orderId);
 assert.equal(order.inventoryReservationStatus,'completed');assert.notEqual(order.inventoryReservationAttemptId,'v2_123456789');
 assert.equal(order.inventoryReservationError,'');assert.equal(result.summary.reservedQty,7);assert.equal(result.summary.shortageQty,3);
 assert.equal(order.items[0].reservedQty,7);assert.equal(order.items[0].shortageQty,3);assert.ok(order.workCategories.includes('ordering'));
 const ledger=await x.read('inventoryReservations',x.orderId+'__I1');assert.equal(ledger.locationSchemaVersion,2);
 assert.deepEqual(ledger.locations,[{warehouseId:'V2-A',reservedQty:4},{warehouseId:'V2-B',reservedQty:3}]);
 const demand=await x.read('procurementDemands',initDemandId(x));assert.equal(demand.requestedQty,3);assert.equal(demand.remainingToOrderQty,3);
 const receipts=await initializationReceipts(x);assert.equal(receipts.length,1);assert.equal(receipts[0].syncAttemptId,order.inventoryReservationAttemptId);
 assert.equal((await x.read('inventory',x.productKey)).reserved,7);
});
test('reservation committed before a source initialization interruption remains blocked until real retry publishes demand',async()=>{
 const x=await initializedSource('interrupted'),hooks={afterReservation:()=>{throw Error('connection lost before demand');}};
 await assert.rejects(synchronizeV2OrderFixture(db,x.uid,{orderId:x.orderId,warehouseIds:['V2-A','V2-B'],hooks}),/connection lost/);
 const failed=await x.read('orders',x.orderId);assert.equal(failed.inventoryReservationStatus,'failed');assert.equal(failed.items[0].reservedQty,7);
 assert.equal(await x.read('procurementDemands',initDemandId(x)),undefined);
 await assert.rejects(commitSingleItemLocationLifecycle(db,x.uid,{orderId:x.orderId,itemId:'I1',warehouseIds:['V2-A','V2-B'],
  nextStatus:'cancelled',operationId:'init_blocked_lifecycle_123',syncAttemptId:failed.inventoryReservationAttemptId,date:'2026-10-18',reason:'未完成不可續做'}),/同步/);
 const stock=await x.read('inventory',x.productKey);await initialize(x);const done=await x.read('orders',x.orderId);
 assert.equal(done.inventoryReservationStatus,'completed');assert.notEqual(done.inventoryReservationAttemptId,failed.inventoryReservationAttemptId);
 assert.deepEqual(await x.read('inventory',x.productKey),stock);assert.equal((await x.read('procurementDemands',initDemandId(x))).requestedQty,3);
 const movements=(await snapshot(x)).movements.filter(m=>m.type==='reserve');assert.equal(movements.reduce((n,m)=>n+m.qty,0),7);
});
test('completed real initialization replays without invoking reservation or changing its attempt demand or balances',async()=>{
 const x=await initializedSource('replay');await initialize(x);const before=await snapshot(x),demand=await x.read('procurementDemands',initDemandId(x)),receipts=await initializationReceipts(x);
 await synchronizeV2OrderFixture(db,x.uid,{orderId:x.orderId,warehouseIds:['V2-A','V2-B'],hooks:{beforeReservation:()=>{throw Error('completed source must not reserve again');}}});
 assert.deepEqual(await snapshot(x),before);assert.deepEqual(await x.read('procurementDemands',initDemandId(x)),demand);assert.deepEqual(await initializationReceipts(x),receipts);
});
test('older source initialization callback cannot overwrite a newer real completed attempt or reserve twice',async()=>{
 const x=await initializedSource('superseded');let release,entered;const pause=new Promise(r=>{release=r;}),started=new Promise(r=>{entered=r;});
 const older=synchronizeV2OrderFixture(db,x.uid,{orderId:x.orderId,warehouseIds:['V2-A','V2-B'],hooks:{beforeReservation:async()=>{entered();await pause;}}});
 await started;await initialize(x);const before=await snapshot(x),demand=await x.read('procurementDemands',initDemandId(x));release();
 assert.equal((await older).order.inventoryReservationStatus,'completed');assert.deepEqual(await snapshot(x),before);assert.deepEqual(await x.read('procurementDemands',initDemandId(x)),demand);
 assert.equal((await initializationReceipts(x)).length,1);
});
test('source initialization checks actual roles ownership and active profile before writing any state',async()=>{
 for(const role of ['admin','purchaser','sales','engineer','warehouse']){
  const x=await initializedSource('role-'+role,{role}),before=await snapshot(x);
  if(role==='warehouse'){await assert.rejects(initialize(x),/無權/);assert.deepEqual(await snapshot(x),before);}
  else assert.equal((await initialize(x)).order.inventoryReservationStatus,'completed');
 }
 for(const [name,options,update] of [['foreign',{owner:'other'},null],['disabled',{}, {active:false}],['missing',{},null]]){
  const x=await initializedSource(name,options);if(update)await db.collection('users').doc(x.uid).update(update);if(name==='missing')await db.collection('users').doc(x.uid).delete();
  const before=await snapshot(x);await assert.rejects(initialize(x));assert.deepEqual(await snapshot(x),before,name);
 }
});
test('lost completion response recovers from the actual committed initialization without rewriting it as failed',async()=>{
 const x=await initializedSource('lost-reply');let reservations=0;
 const result=await synchronizeV2OrderFixture(db,x.uid,{orderId:x.orderId,warehouseIds:['V2-A','V2-B'],hooks:{completionResponseLost:true,beforeReservation:()=>{reservations++;}}});
 assert.equal(result.order.inventoryReservationStatus,'completed');assert.equal(reservations,1);assert.equal((await initializationReceipts(x)).length,1);
 assert.equal((await x.read('orders',x.orderId)).inventoryReservationError,'');assert.equal((await x.read('inventory',x.productKey)).reserved,7);
});
test('account change after real reservation cannot finish initialization and original actor can recover without duplicate holds',async()=>{
 const x=await initializedSource('account-change');
 await assert.rejects(synchronizeV2OrderFixture(db,x.uid,{orderId:x.orderId,warehouseIds:['V2-A','V2-B'],hooks:{afterReservation:({context})=>{context.currentUser={uid:'another-account'};}}}),/登入身份/);
 assert.equal((await x.read('orders',x.orderId)).inventoryReservationStatus,'pending');assert.equal((await x.read('inventory',x.productKey)).reserved,7);
 const stock=await x.read('inventory',x.productKey);await initialize(x);assert.equal((await x.read('orders',x.orderId)).inventoryReservationStatus,'completed');assert.deepEqual(await x.read('inventory',x.productKey),stock);
});

// Multi-line acceptance uses the SAME real PO/incoming/receiving Services as
// the single-line cases above, after the real whole-order initialization.
async function multiReceiptLifecycle(name,{five=false,purchase:withPurchase=true}={}){
 const x=await seed('multi-receipt-'+name,{role:'purchaser',a:1,b:2,company:3}),q=x.productKey+'-Q';
 const items=five?Array.from({length:5},(_,n)=>({itemId:'I'+(n+1),productId:x.productKey,qty:3,warehouseId:n%2?'V2-B':'V2-A'})):[
  {itemId:'I1',productId:x.productKey,qty:5,warehouseId:'V2-A',commercialNote:'retain first line'},
  {itemId:'I2',productId:x.productKey,qty:4,warehouseId:'V2-B',unitPrice:789},
  {itemId:'I3',productId:q,qty:3,warehouseId:'V2-B',custom:{note:'untouched sibling'}}];
 await db.collection('orders').doc(x.orderId).update({items,deliveryRecords:[],returnRecords:[],warehouseShipmentRecords:[],returnHistory:[]});
 const batch=db.batch();batch.set(db.collection('products').doc(q),{productType:'Goods'});
 batch.set(db.collection('inventory').doc(q),{productKey:q,onHand:1,reserved:0,incoming:0,transferFreeInTransit:0});
 for(const [warehouseId,onHand] of [['V2-A',1],['V2-B',0]])batch.set(db.collection('warehouseStocks').doc(warehouseId+'__'+q),{productKey:q,warehouseId,onHand,reserved:0,incoming:0,transferFreeInTransit:0});
 await batch.commit();await initialize(x);
 if(!withPurchase)return {...x,q,po:{poNo:'absent'},supplies:[]};
 const c=purchasingHarness(),order=await x.read('orders',x.orderId);
 await db.collection('users').doc('emulator-purchaser').set({role:'purchaser',active:true});
 const po={poNo:'PO-MULTI-RECEIPT-'+name,vendorName:'Multi vendor',supplierName:'Multi vendor',buyerName:'Purchaser',
  poDate:'2026-10-18',createdAt:'2026-10-18T00:00:00Z',items:order.items.flatMap((item,index)=>item.shortageQty>0?[{
   orderId:x.orderId,itemId:item.itemId,orderItemIndex:index,productId:item.productId,qty:item.shortageQty,unitPrice:100,
   warehouseId:item.warehouseId,fulfillmentType:'WAREHOUSE',ownerUid:x.uid,salesCode:'V2',sourceType:'SALES_ORDER'}]:[])};
 const purchase=await c.commitFormalPurchaseOrder(po);await c.registerPurchaseIncoming(po.poNo,purchase.poRecord);receivingHarness(c);
 const supplies=purchase.committedSupplyOrders;
 return {...x,q,c,po:purchase.poRecord,supplies,
  receive:(itemId,qty,operationId)=>c.receiveSupplyOrderRecord(supplies.find(s=>s.itemId===itemId).id,qty,'LOT-'+itemId,'2027-10-18',operationId)};
}
async function multiReceiptSnapshot(x){
 const docs={};
 const put=async(name,key)=>{docs[name+'/'+key]=await x.read(name,key);};
 const order=await x.read('orders',x.orderId);await put('orders',x.orderId);await put('purchaseOrders',x.po.poNo);
 for(const item of order.items){await put('inventoryReservations',x.orderId+'__'+item.itemId);
  await put('procurementDemands',encodeURIComponent('SALES_ORDER:'+x.orderId+':'+item.itemId));}
 for(const s of x.supplies)await put('supplyOrders',s.id);
 for(const key of [x.productKey,x.q]){
  await put('inventory',key);for(const wh of ['V2-A','V2-B'])await put('warehouseStocks',wh+'__'+key);
  for(const name of ['inventoryLots','inventoryLotCosts','receipts','inventoryMovements']){
   const query=await db.collection(name).where('productKey','==',key).get();
   for(const doc of query.docs)docs[name+'/'+doc.id]=doc.data();
  }
 }
 return docs;
}
test('multi-line real PO and dated partial receipts preserve siblings and reserve only the receiving warehouse',async()=>{
 const x=await multiReceiptLifecycle('dated'),before=await x.read('orders',x.orderId);
 assert.deepEqual(before.items.map(i=>i.supplyOrderedQty),[2,4,2]);
 assert.equal((await x.read('inventory',x.productKey)).onHand,3);assert.equal((await x.read('inventory',x.productKey)).incoming,6);
 for(const [itemId,qty,date,id] of [['I2',2,'2026-10-18','multi_receipt_dated_1'],['I1',1,'2026-10-19','multi_receipt_dated_2'],['I3',2,'2026-10-20','multi_receipt_dated_3']]){
  const prior=await x.read('orders',x.orderId);x.c.localDateString=()=>date;
  await x.receive(itemId,qty,id);const order=await x.read('orders',x.orderId);
  for(const item of prior.items.filter(i=>i.itemId!==itemId))assert.deepEqual(order.items.find(i=>i.itemId===item.itemId),item);
  assert.equal(order.items.find(i=>i.itemId===itemId).receiptEvents.at(-1).date,date);
  assert.equal(order.deliveredQty,prior.deliveredQty);assert.deepEqual(order.warehouseShipmentRecords,[]);
  const receipt=await x.read('receipts',id);assert.equal(receipt.reservationLocationSchemaVersion,2);assert.equal(receipt.receiptDate,date);
  const once=await multiReceiptSnapshot(x);x.c.localDateString=()=> '2026-10-21';await x.receive(itemId,qty,id);assert.deepEqual(await multiReceiptSnapshot(x),once);
 }
 await x.receive('I2',2,'multi_receipt_dated_4');await x.receive('I1',1,'multi_receipt_dated_5');
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.items.map(i=>[i.reservedQty,i.shortageQty,i.receivedQty]),[[5,0,2],[4,0,4],[3,0,2]]);
 for(const [key,total] of [[x.productKey,9],[x.q,3]]){
  const stock=await x.read('inventory',key);assert.equal(stock.onHand,total);assert.equal(stock.reserved,total);assert.equal(stock.incoming,0);
  assert.equal((await x.read('warehouseStocks','V2-A__'+key)).reserved+(await x.read('warehouseStocks','V2-B__'+key)).reserved,total);
 }
 const ledger=await x.read('inventoryReservations',x.orderId+'__I2');assert.deepEqual(ledger.locations,[{warehouseId:'V2-B',reservedQty:4}]);
 assert.equal(order.items[0].commercialNote,'retain first line');assert.equal(order.items[1].unitPrice,789);
 assert.deepEqual(order.items[2].custom,{note:'untouched sibling'});
});
test('five same-product lines receive through one existing PO without resetting sibling holds or incoming',async()=>{
 const x=await multiReceiptLifecycle('five',{five:true});
 for(const itemId of ['I5','I3','I2','I4'])await x.receive(itemId,3,'multi_five_'+itemId);
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.items.map(i=>i.reservedQty),[3,3,3,3,3]);
 assert.deepEqual(order.items.map(i=>i.receivedQty||0),[0,3,3,3,3]);
 const stock=await x.read('inventory',x.productKey);assert.equal(stock.onHand,15);assert.equal(stock.reserved,15);assert.equal(stock.incoming,0);
});
test('multi-line receipts check all five roles and current profile rather than a caller capability',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const x=await multiReceiptLifecycle('role-'+role);receivingHarness(x.c,'emulator-purchaser',role);
  await db.collection('users').doc('emulator-purchaser').update({role});const before=await multiReceiptSnapshot(x);
  if(['sales','engineer'].includes(role)){await assert.rejects(x.receive('I2',1,'multi_role_'+role));assert.deepEqual(await multiReceiptSnapshot(x),before);}
  else await x.receive('I2',1,'multi_role_'+role);
 }
 const x=await multiReceiptLifecycle('disabled');await db.collection('users').doc('emulator-purchaser').update({active:false});
 const before=await multiReceiptSnapshot(x);await assert.rejects(x.receive('I2',1,'multi_disabled_receipt'));assert.deepEqual(await multiReceiptSnapshot(x),before);
});
test('same receipt replay and competing over-consumption cannot duplicate multi-line receipts lots or reservations',async()=>{
 const x=await multiReceiptLifecycle('race-same');
 await Promise.all([x.receive('I2',1,'multi_same_receipt'),x.receive('I2',1,'multi_same_receipt')]);
 assert.equal((await x.read('inventory',x.productKey)).onHand,4);assert.equal((await x.read('orders',x.orderId)).items[1].receivedQty,1);
 const before=await multiReceiptSnapshot(x);await assert.rejects(x.receive('I2',2,'multi_same_receipt'),/識別碼衝突/);assert.deepEqual(await multiReceiptSnapshot(x),before);
 const y=await multiReceiptLifecycle('race-over');const results=await Promise.allSettled([y.receive('I2',3,'multi_race_a'),y.receive('I2',3,'multi_race_b')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await y.read('inventory',y.productKey)).onHand,6);
 assert.equal((await y.read('orders',y.orderId)).items[1].receivedQty,3);
});
test('concurrent different lines sharing one product serialize without losing either receipt or another product',async()=>{
 const x=await multiReceiptLifecycle('race-lines'),other=await x.read('inventory',x.q);
 await Promise.all([x.receive('I1',2,'multi_lines_a'),x.receive('I2',4,'multi_lines_b')]);
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.items.map(i=>i.receivedQty||0),[2,4,0]);
 const stock=await x.read('inventory',x.productKey);assert.equal(stock.onHand,9);assert.equal(stock.reserved,9);assert.equal(stock.incoming,0);
 assert.deepEqual(await x.read('inventory',x.q),other);assert.deepEqual(order.items[2].custom,{note:'untouched sibling'});
});
test('multi-line joint company and warehouse claims cannot hide under individually sufficient balances',async()=>{
 for(const scope of ['company','warehouse']){
  const x=await multiReceiptLifecycle('joint-'+scope);await x.receive('I2',2,'multi_joint_initial_'+scope);
  await db.collection(scope==='company'?'inventory':'warehouseStocks').doc(scope==='company'?x.productKey:'V2-B__'+x.productKey).update({reserved:scope==='company'?4:3});
  const before=await multiReceiptSnapshot(x);await assert.rejects(x.receive('I2',1,'multi_joint_reject_'+scope),/庫存帳異常|分倉預留/);
  assert.deepEqual(await multiReceiptSnapshot(x),before);
 }
});
test('invalid sibling source service direct shipment legacy ledger or prior logistics refuses the entire receipt',async()=>{
 const cases=[
  ['service',x=>db.collection('products').doc(x.q).update({productType:'SERVICE'})],
  ['legacy',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({locationSchemaVersion:1})],
  ['missing',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').delete()],
  ['owner',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({ownerUid:'other'})],
  ['pending',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'pending'})],
  ['history',x=>db.collection('orders').doc(x.orderId).update({warehouseShipmentRecords:[{id:'not-migrated'}]})],
  ...['direct','overprepared','duplicate','shortage'].map(mode=>[mode,async x=>{
   const order=await x.read('orders',x.orderId);
   if(mode==='direct')order.items[2].fulfillmentType='DIRECT_SHIP';
   if(mode==='overprepared')order.items[2].dispatchPreparedQty=4;
   if(mode==='duplicate')order.items[2].itemId='I1';
   if(mode==='shortage')order.items[2].shortageQty=99;
   await db.collection('orders').doc(x.orderId).update({items:order.items});
  }])
 ];
 for(const [name,mutate] of cases){const x=await multiReceiptLifecycle('reject-'+name);await mutate(x);const before=await multiReceiptSnapshot(x);
  await assert.rejects(x.receive('I2',1,'multi_invalid_'+name));assert.deepEqual(await multiReceiptSnapshot(x),before,name);}
});
test('late receipt write failure rolls back multi-line stock lots costs ledger demand and supply atomically',async()=>{
 const x=await multiReceiptLifecycle('rollback'),before=await multiReceiptSnapshot(x),collision=db.collection('inventoryMovements').doc('multi-receipt-collision');
 await collision.set({sentinel:true});
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn({get:r=>tx.get(r),update:(...a)=>tx.update(...a),
  set:(ref,...args)=>{if(ref.path.startsWith('receipts/'))tx.create(collision,{sentinel:false});return tx.set(ref,...args);}}));
 await assert.rejects(x.receive('I2',1,'multi_rollback_receipt'),error=>error.code===6);assert.deepEqual(await multiReceiptSnapshot(x),before);
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn(tx));await x.receive('I2',1,'multi_rollback_receipt');
 assert.equal((await x.read('orders',x.orderId)).items[1].receivedQty,1);
});
test('lost multi-line receipt response keeps the fixed operation and recovers without another physical receipt',async()=>{
 const x=await multiReceiptLifecycle('lost-response');let lost=true;
 x.c.runRoleTransaction=async fn=>{const result=await db.runTransaction(async tx=>fn(tx));if(lost){lost=false;throw Error('receipt reply lost');}return result;};
 await assert.rejects(x.receive('I2',2,'multi_lost_reply_receipt'),/reply lost/);const committed=await multiReceiptSnapshot(x);
 await x.receive('I2',2,'multi_lost_reply_receipt');assert.deepEqual(await multiReceiptSnapshot(x),committed);
});
test('concurrent multi-line receipts for different products preserve the complete source order',async()=>{
 const x=await multiReceiptLifecycle('race-products');await Promise.all([x.receive('I2',2,'multi_products_p'),x.receive('I3',2,'multi_products_q')]);
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.items.map(i=>i.receivedQty||0),[0,2,2]);
 assert.equal((await x.read('inventory',x.productKey)).onHand,5);assert.equal((await x.read('inventory',x.q)).onHand,3);
 assert.equal((await x.read('procurementDemands',encodeURIComponent('SALES_ORDER:'+x.orderId+':I2'))).remainingToReceiveQty,2);
 assert.equal((await x.read('procurementDemands',encodeURIComponent('SALES_ORDER:'+x.orderId+':I3'))).remainingToReceiveQty,0);
});
test('multi-line receipt never opens browser production gates or accepts actor substitution on replay',async()=>{
 const x=await multiReceiptLifecycle('gates'),before=await multiReceiptSnapshot(x);
 delete x.c.process;await assert.rejects(x.receive('I2',1,'multi_gated_receipt'),/僅允許 demo-yushin/);assert.deepEqual(await multiReceiptSnapshot(x),before);
 x.c.process={env:{FIRESTORE_EMULATOR_HOST:''}};await assert.rejects(x.receive('I2',1,'multi_gated_receipt'),/僅允許 demo-yushin/);
 x.c.process=process;await x.receive('I2',1,'multi_gated_receipt');const once=await multiReceiptSnapshot(x);
 await db.collection('users').doc('other-multi-receiver').set({role:'admin',active:true});receivingHarness(x.c,'other-multi-receiver','admin');
 await assert.rejects(x.receive('I2',1,'multi_gated_receipt'),/識別碼衝突/);assert.deepEqual(await multiReceiptSnapshot(x),once);
});

// Real whole-order initialization -> PO/incoming -> original receiving Service
// -> existing dispatch/shipment/acknowledgement writers, no synthetic events.
async function multiReceiptShipmentLifecycle(name,{five=false}={}){
 const x=await multiReceiptLifecycle('after-ship-'+name,{five});
 const plan={mode:'CUSTOMER_SHIP',contact:'客戶',phone:'02-12345678',address:'台北市測試地址'};
 const order=await x.read('orders',x.orderId),syncAttemptId=order.inventoryReservationAttemptId;
 await db.collection('orders').doc(x.orderId).update({items:order.items.map(i=>({...i,deliveryPlan:plan})),
  deliveryHistory:[],deliveredQty:0,isDelivered:false});
 const batch=db.batch();
 for(const [key,wh,qty] of [[x.productKey,'V2-A',1],[x.productKey,'V2-B',2],...(five?[]:[[x.q,'V2-A',1]])])
  batch.set(db.collection('inventoryLots').doc(key+'-baseline-'+wh),{productKey:key,productId:key,warehouseId:wh,
   receivedQty:qty,remainingQty:qty,lotNo:'BASE',expiryDate:'2028-10-17',receivedAt:'2026-10-01T00:00:00Z'});
 await batch.commit();await db.collection('users').doc(x.uid).update({role:'sales'});
 const request=(itemId,tag)=>({orderId:x.orderId,itemId,syncAttemptId,operationId:'mr_'+name+'_'+tag});
 const prepare=(itemId,qty,tag)=>require('../functions/location-dispatch-service').commitLocationDispatchPreparation(db,'emulator-purchaser',{
  ...request(itemId,'prepare_'+tag),quantity:qty});
 const ship=(itemId,wh,qty,tag)=>require('../functions/location-shipment-service').commitLocationShipment(db,'emulator-purchaser',{
  ...request(itemId,'ship_'+tag),warehouseId:wh,quantity:qty,date:'2026-10-19',expectedPlan:plan});
 const confirm=(itemId,qty,tag,ackTag=tag)=>require('../functions/shipment-delivery-service').commitShipmentDelivery(db,x.uid,{
  ...request(itemId,'ack_'+ackTag),shipmentId:request(itemId,'ship_'+tag).operationId,quantity:qty,date:'2026-10-19'});
 const reverse=(itemId,ackTag,tag)=>require('../functions/shipment-delivery-service').reverseShipmentDelivery(db,x.uid,{
  ...request(itemId,'reverse_'+tag),deliveryRecordId:request(itemId,'ack_'+ackTag).operationId,date:'2026-10-20',reason:'誤登送達'});
 x.c.localDateString=()=> '2026-10-20';
 return {...x,prepare,ship,confirm,reverse,request};
}
test('multi-line receipt after prepared pending partly acknowledged or acknowledged shipment reserves only unshipped demand',async()=>{
 for(const confirmed of [-1,0,1,3]){
  const x=await multiReceiptShipmentLifecycle('ack'+confirmed);await x.prepare('I1',3,'initial');
  if(confirmed>=0){await x.ship('I1','V2-A',1,'a');await x.ship('I1','V2-B',2,'b');}
  if(confirmed>0)await x.confirm('I1',1,'a');if(confirmed===3)await x.confirm('I1',2,'b');
  const before=await x.read('orders',x.orderId),beforeStock=await x.read('inventory',x.productKey);
  await x.receive('I1',1,'mr_after_ack_'+confirmed);await x.receive('I2',1,'mr_sibling_ack_'+confirmed);
  const after=await x.read('orders',x.orderId),item=after.items[0],shipped=confirmed>=0?3:0;
  assert.equal(item.reservedQty,4-shipped);assert.equal(item.shortageQty,1);
  assert.equal(item.warehouseShippedQty??0,shipped);assert.equal(item.deliveredQty??0,Math.max(0,confirmed));
  assert.equal(after.deliveredQty,before.deliveredQty);assert.deepEqual(after.warehouseShipmentRecords,before.warehouseShipmentRecords);
  assert.deepEqual(after.deliveryRecords,before.deliveryRecords);assert.deepEqual(after.items[2],before.items[2]);
  const stock=await x.read('inventory',x.productKey);assert.equal(stock.onHand,beforeStock.onHand+2);
  assert.equal(stock.reserved,beforeStock.reserved+2);assert.equal(stock.incoming,beforeStock.incoming-2);
  const once=await multiReceiptSnapshot(x);await x.receive('I1',1,'mr_after_ack_'+confirmed);
  assert.deepEqual(await multiReceiptSnapshot(x),once);
 }
});
test('full multi-item PO receipt dispatch shipment and acknowledgement cycle preserves fulfilled siblings and closes exactly twelve goods',async()=>{
 const x=await multiReceiptShipmentLifecycle('full');await x.prepare('I1',3,'first');
 await x.ship('I1','V2-A',1,'firstA');await x.ship('I1','V2-B',2,'firstB');await x.confirm('I1',1,'firstA');
 await x.receive('I1',1,'mr_full_i1_partial');await x.receive('I1',1,'mr_full_i1_last');
 await x.prepare('I1',2,'last');await x.ship('I1','V2-A',2,'lastA');await x.confirm('I1',2,'firstB');await x.confirm('I1',2,'lastA');
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I1')).status,'fulfilled');
 const fulfilled=(await x.read('orders',x.orderId)).items[0];
 await x.receive('I2',2,'mr_full_i2_partial');await x.prepare('I2',2,'second');await x.ship('I2','V2-B',2,'second');
 await x.receive('I3',2,'mr_full_i3');await x.receive('I2',2,'mr_full_i2_last');
 assert.deepEqual((await x.read('orders',x.orderId)).items[0],fulfilled);
 await x.prepare('I2',2,'secondlast');await x.ship('I2','V2-B',2,'secondlast');
 await x.prepare('I3',3,'third');await x.ship('I3','V2-A',1,'thirdA');await x.ship('I3','V2-B',2,'thirdB');
 for(const [itemId,qty,tag] of [['I2',2,'second'],['I2',2,'secondlast'],['I3',1,'thirdA'],['I3',2,'thirdB']])await x.confirm(itemId,qty,tag);
 const order=await x.read('orders',x.orderId);assert.equal(order.isDelivered,true);assert.equal(order.deliveredQty,12);
 assert.deepEqual(order.items.map(i=>[i.warehouseShippedQty,i.deliveredQty,i.reservedQty,i.shortageQty]),[[5,5,0,0],[4,4,0,0],[3,3,0,0]]);
 for(const key of [x.productKey,x.q]){
  const stock=await x.read('inventory',key);assert.equal(stock.onHand,0);assert.equal(stock.reserved,0);assert.equal(stock.incoming,0);
  const lots=await db.collection('inventoryLots').where('productKey','==',key).get();assert.ok(lots.docs.every(s=>s.data().remainingQty===0));
 }
 for(const item of order.items){const demand=await x.read('procurementDemands',encodeURIComponent('SALES_ORDER:'+x.orderId+':'+item.itemId));
  assert.equal(demand.remainingToReceiveQty,0);assert.equal(demand.remainingToOrderQty,0);}
});
test('five same-product lines may receive after the first is physically fulfilled without stealing its dispatched units',async()=>{
 const x=await multiReceiptShipmentLifecycle('five',{five:true});await x.prepare('I1',3,'first');
 await x.ship('I1','V2-A',1,'a');await x.ship('I1','V2-B',2,'b');await x.confirm('I1',1,'a');
 const original=(await x.read('orders',x.orderId)).items[0];
 await Promise.all([x.receive('I2',2,'mr_five_two'),x.receive('I3',2,'mr_five_three')]);
 await x.receive('I4',3,'mr_five_four');await x.receive('I5',3,'mr_five_five');
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.items[0],original);
 assert.deepEqual(order.items.map(i=>i.reservedQty),[0,2,2,3,3]);
 const stock=await x.read('inventory',x.productKey);assert.equal(stock.onHand,10);assert.equal(stock.reserved,10);assert.equal(stock.incoming,2);
});
test('multi-line receipt after an actual acknowledgement reversal retains correction history and physical outstanding authority',async()=>{
 const x=await multiReceiptShipmentLifecycle('reverse');await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');
 await x.confirm('I1',1,'first');await x.reverse('I1','first','fix');const before=await x.read('orders',x.orderId);
 await x.receive('I1',1,'mr_reversed_receive');const order=await x.read('orders',x.orderId);
 assert.equal(order.items[0].reservedQty,3);assert.equal(order.items[0].shortageQty,1);assert.equal(order.deliveredQty,0);
 assert.deepEqual(order.deliveryHistory,before.deliveryHistory);assert.deepEqual(order.warehouseShipmentRecords,before.warehouseShipmentRecords);
});
test('multi-item receiving and sibling shipment or acknowledgement serialize without losing either authoritative event',async()=>{
 const x=await multiReceiptShipmentLifecycle('concurrent');await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');
 await Promise.all([x.receive('I1',1,'mr_parallel_i1'),x.confirm('I1',1,'first')]);
 await x.receive('I2',1,'mr_parallel_i2_seed');await x.prepare('I2',1,'second');
 await Promise.all([x.receive('I1',1,'mr_parallel_i1_last'),x.ship('I2','V2-B',1,'second')]);
 const order=await x.read('orders',x.orderId);assert.equal(order.deliveredQty,1);
 assert.deepEqual(order.items.map(i=>[i.receivedQty??0,i.warehouseShippedQty??0,i.reservedQty,i.shortageQty]),[[2,1,4,0],[1,1,0,3],[0,0,1,2]]);
 const stock=await x.read('inventory',x.productKey);assert.equal(stock.onHand,4);assert.equal(stock.reserved,4);assert.equal(stock.incoming,3);
});
test('post-shipment multi-line receipt validates every original physical debit, including nonselected different-product siblings',async()=>{
 for(const mode of ['missing','quantity','allocation','hidden-return','unknown-event','sibling-total','returns','cancelled','pending','totals']){
  const x=await multiReceiptShipmentLifecycle('evidence-'+mode);
  await x.prepare('I3',1,'sibling');await x.ship('I3','V2-A',1,'sibling');await x.confirm('I3',1,'sibling');
  const move=db.collection('inventoryMovements').doc('location-ship-'+x.request('I3','ship_sibling').operationId);
  if(mode==='missing')await move.delete();if(mode==='quantity')await move.update({qty:0});
  if(mode==='allocation')await move.update({lotAllocations:[]});
  if(mode==='hidden-return')await db.collection('inventoryMovements').doc('mr-hidden-return').set({sourceId:x.orderId,action:'location_customer_return',qty:1,itemId:'I3'});
  if(mode==='unknown-event'||mode==='sibling-total'){
   const order=await x.read('orders',x.orderId);
   if(mode==='unknown-event')order.deliveryRecords[0].itemId='unknown';else order.items[2].deliveredQty=0;
   await db.collection('orders').doc(x.orderId).update({items:order.items,deliveryRecords:order.deliveryRecords});
  }
  if(mode==='returns')await db.collection('orders').doc(x.orderId).update({returnRecords:[{id:'unsupported-return'}]});
  if(mode==='cancelled')await db.collection('orders').doc(x.orderId).update({status:'cancelled',orderStatus:'cancelled'});
  if(mode==='pending')await db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'pending'});
  if(mode==='totals')await db.collection('orders').doc(x.orderId).update({deliveredQty:0});
  const before=await multiReceiptSnapshot(x);await assert.rejects(x.receive('I2',1,'mr_evidence_'+mode));
  assert.deepEqual(await multiReceiptSnapshot(x),before,mode);
 }
});
test('post-shipment receipt keeps five-role live checks and fixed-id response-loss recovery',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const x=await multiReceiptShipmentLifecycle('live-'+role);await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');
  receivingHarness(x.c,'emulator-purchaser',role);await db.collection('users').doc('emulator-purchaser').update({role});
  const before=await multiReceiptSnapshot(x);
  if(['sales','engineer'].includes(role)){
   await assert.rejects(x.receive('I2',1,'mr_roles_'+role));assert.deepEqual(await multiReceiptSnapshot(x),before);
  }else{await x.receive('I2',1,'mr_roles_'+role);await db.collection('users').doc('emulator-purchaser').update({active:false});
   const applied=await multiReceiptSnapshot(x);await assert.rejects(x.receive('I2',1,'mr_roles_new_'+role));assert.deepEqual(await multiReceiptSnapshot(x),applied);}
 }
 const x=await multiReceiptShipmentLifecycle('lost');await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');let lost=true;
 x.c.runRoleTransaction=async fn=>{const r=await db.runTransaction(async tx=>fn(tx));if(lost){lost=false;throw Error('post-shipment receipt reply lost');}return r;};
 await assert.rejects(x.receive('I2',1,'mr_lost_after_ship'),/reply lost/);const once=await multiReceiptSnapshot(x);
 await x.receive('I2',1,'mr_lost_after_ship');assert.deepEqual(await multiReceiptSnapshot(x),once);
});
test('post-shipment receipt still rolls back stock lot cost supply demand and order on true late ALREADY_EXISTS collision',async()=>{
 const x=await multiReceiptShipmentLifecycle('rollback');await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');
 const collision=db.collection('inventoryMovements').doc('mr-post-shipment-collision');await collision.set({sentinel:true});
 const before=await multiReceiptSnapshot(x);
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn({get:r=>tx.get(r),update:(...a)=>tx.update(...a),
  set:(ref,...args)=>{if(ref.path.startsWith('receipts/'))tx.create(collision,{sentinel:false});return tx.set(ref,...args);}}));
 await assert.rejects(x.receive('I2',1,'mr_rollback_receipt'),e=>e.code===6);assert.deepEqual(await multiReceiptSnapshot(x),before);
 assert.deepEqual((await collision.get()).data(),{sentinel:true});x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn(tx));
 await x.receive('I2',1,'mr_rollback_receipt');const applied=await multiReceiptSnapshot(x);
 await x.receive('I2',1,'mr_rollback_receipt');assert.deepEqual(await multiReceiptSnapshot(x),applied);
});
test('post-shipment identical receipt races and competing excess quantities cannot duplicate incoming or inventory',async()=>{
 const x=await multiReceiptShipmentLifecycle('receipt-races');await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');
 await Promise.all([x.receive('I2',1,'mr_receipt_race_same'),x.receive('I2',1,'mr_receipt_race_same')]);
 assert.equal((await x.read('orders',x.orderId)).items[1].receivedQty,1);
 const race=await Promise.allSettled([x.receive('I2',2,'mr_receipt_race_a'),x.receive('I2',2,'mr_receipt_race_b')]);
 assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 const order=await x.read('orders',x.orderId);assert.equal(order.items[1].receivedQty,3);
 assert.equal(order.items[0].warehouseShippedQty,1);assert.equal(order.deliveredQty,0);
 const stock=await x.read('inventory',x.productKey);assert.equal(stock.onHand,5);assert.equal(stock.reserved,5);assert.equal(stock.incoming,3);
});

const {commitOrderLocationLifecycle,commitOrderLocationLifecycleAndRecover}=require('../functions/single-item-location-lifecycle-service');
async function wholeLifecycleFixture(name,{five=false,purchase=true}={}){
 const x=purchase?await multiReceiptShipmentLifecycle('life-'+name,{five}):await multiReceiptLifecycle('life-'+name,{five,purchase:false});
 await db.collection('users').doc(x.uid).update({role:'sales'});
 const order=await x.read('orders',x.orderId),syncAttemptId=order.inventoryReservationAttemptId;
 const intent=(nextStatus='cancelled',tag=nextStatus,patch={})=>({orderId:x.orderId,itemIds:order.items.map(i=>i.itemId).reverse(),
  warehouseIds:['V2-B','V2-A'],nextStatus,operationId:'whole_life_'+name+'_'+tag,syncAttemptId,date:'2026-10-21',reason:'客戶取消未出貨部分',...patch});
 return {...x,intent,life:(status='cancelled',tag=status,actor=x.uid,connection=db)=>commitOrderLocationLifecycle(connection,actor,intent(status,tag))};
}
async function wholeLifecycleSnapshot(x){
 const state=await multiReceiptSnapshot(x);
 state.operationReceipts=(await db.collection('reservationOperationReceipts').where('orderId','==',x.orderId).get()).docs.map(s=>[s.id,s.data()]).sort((a,b)=>a[0].localeCompare(b[0]));
 return state;
}
async function multiClosedFollowupFixture(name){
 const x=await wholeLifecycleFixture('closed-'+name);
 for(const itemId of ['I1','I3']){
  await x.prepare(itemId,1,itemId);await x.ship(itemId,'V2-A',1,itemId);await x.confirm(itemId,1,itemId);
  const order=await x.read('orders',x.orderId),shipment=order.warehouseShipmentRecords.find(s=>s.itemId===itemId);
  await require('../functions/location-return-service').commitLocationReturn(db,x.uid,{
   ...x.request(itemId,'return_'+itemId),shipmentId:shipment.id,warehouseId:'V2-A',date:'2026-10-20',
   reason:'客戶結案退貨',condition:'RESTOCKABLE',settlement:'CLOSE',
   selections:[{lotId:shipment.lotAllocations[0].lotId,qty:1}]});
 }
 return x;
}
async function cancelledMultiReceiptFixture(name,{closed=false,five=false,approve=true}={}){
 const x=closed?await multiClosedFollowupFixture('keep-'+name):await wholeLifecycleFixture('keep-'+name,{five});
 await x.life();
 const keep=itemId=>keepReceiptAsStock({...x,supplyId:x.supplies.find(s=>s.itemId===itemId).id});
 if(approve)for(const supply of x.supplies)await keep(supply.itemId);
 return {...x,keep};
}
test('cancelled multi-item receipt requires each original purchasing KEEP_STOCK decision and preserves all released sibling ledgers',async()=>{
 const x=await cancelledMultiReceiptFixture('partial',{approve:false});
 let before=await wholeLifecycleSnapshot(x);await assert.rejects(x.receive('I1',1,'mk_unapproved'),/採購確認/);assert.deepEqual(await wholeLifecycleSnapshot(x),before);
 await x.keep('I1');before=await wholeLifecycleSnapshot(x);
 await assert.rejects(x.receive('I2',1,'mk_sibling_unapproved'),/採購確認/);assert.deepEqual(await wholeLifecycleSnapshot(x),before);
 const orderBefore=await x.read('orders',x.orderId);await x.receive('I1',1,'mk_first');
 const order=await x.read('orders',x.orderId);assert.equal(order.status,'cancelled');assert.deepEqual(order.items.slice(1),orderBefore.items.slice(1));
 assert.equal(order.items[0].receivedQty,1);assert.equal(order.items[0].reservedQty,0);assert.equal(order.items[0].shortageQty,0);
 assert.equal((await x.read('inventory',x.productKey)).onHand,4);assert.equal((await x.read('inventory',x.productKey)).reserved,0);
 for(const item of order.items)assert.deepEqual(await x.read('inventoryReservations',x.orderId+'__'+item.itemId),before['inventoryReservations/'+x.orderId+'__'+item.itemId]);
 const once=await wholeLifecycleSnapshot(x);await x.receive('I1',1,'mk_first');assert.deepEqual(await wholeLifecycleSnapshot(x),once);
 await assert.rejects(x.receive('I1',2,'mk_first'),/識別碼衝突/);assert.deepEqual(await wholeLifecycleSnapshot(x),once);
 await x.keep('I2');await x.keep('I3');await x.receive('I1',1,'mk_last');await x.receive('I2',4,'mk_second');await x.receive('I3',2,'mk_third');
 for(const item of (await x.read('orders',x.orderId)).items){const d=await x.read('procurementDemands',encodeURIComponent('SALES_ORDER:'+x.orderId+':'+item.itemId));
  assert.equal(d.status,'CANCELLED');assert.equal(d.receivedQty,item.receivedQty);assert.equal(d.remainingToReceiveQty,0);}
 await x.life('normal');assert.deepEqual((await x.read('orders',x.orderId)).items.map(i=>[i.reservedQty,i.shortageQty]),[[5,0],[4,0],[3,0]]);
});
test('two-product CLOSE then cancelled KEEP_STOCK receipts restore only unshipped demand and preserve original return and delivery proofs',async()=>{
 const x=await cancelledMultiReceiptFixture('closed',{closed:true}),original=await x.read('orders',x.orderId);
 await x.receive('I1',1,'mk_closed_partial');await x.receive('I1',1,'mk_closed_last');await x.receive('I2',4,'mk_closed_second');await x.receive('I3',2,'mk_closed_third');
 const cancelled=await x.read('orders',x.orderId);assert.ok(cancelled.items.every(i=>i.reservedQty===0&&i.shortageQty===0));
 await x.life('normal');const restored=await x.read('orders',x.orderId);
 assert.deepEqual(restored.items.map(i=>[i.reservedQty,i.shortageQty]),[[4,0],[4,0],[2,0]]);
 for(const field of ['warehouseShipmentRecords','deliveryRecords','deliveryHistory','returnRecords','returnHistory','deliveredQty','returnedQty','isDelivered'])assert.deepEqual(restored[field],original[field],field);
 for(const [key,held] of [[x.productKey,8],[x.q,2]]){const stock=await x.read('inventory',key);assert.equal(stock.reserved,held);assert.equal(stock.onHand,held+1);assert.equal(stock.incoming,0);}
});
test('five same-product cancelled receipts remain free until restore and share stock after another order reserves released goods',async()=>{
 const x=await cancelledMultiReceiptFixture('five',{five:true});
 for(const itemId of ['I5','I3','I2','I4'])await x.receive(itemId,3,'mk_five_'+itemId);
 assert.equal((await x.read('inventory',x.productKey)).onHand,15);assert.equal((await x.read('inventory',x.productKey)).reserved,0);
 const other=await competingWholeLifecycleOrder(x);assert.equal((await x.read('inventoryReservations',other+'__OTHER')).quantity,2);
 const result=await x.life('normal');assert.equal(result.items.reduce((s,i)=>s+i.reservedQty,0),13);assert.equal(result.items.reduce((s,i)=>s+i.shortageQty,0),2);
 assert.equal((await x.read('inventory',x.productKey)).reserved,15);
});
test('cancelled multi-item receiving rejects live sibling holds incomplete decisions invalid sources and forged CLOSE evidence with zero writes',async()=>{
 const cases=[
  ['ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({status:'fulfilled'})],
  ['hold',async x=>{const o=await x.read('orders',x.orderId);o.items[2].reservedQty=1;await db.collection('orders').doc(x.orderId).update({items:o.items});
   await db.collection('inventoryReservations').doc(x.orderId+'__I3').update({quantity:1,locations:[{warehouseId:'V2-A',reservedQty:1}]});}],
  ['decision',x=>db.collection('supplyOrders').doc(x.supplies[0].id).update({customerCancellationResolvedBy:''})],
  ['pending',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'pending'})],
  ['service',x=>db.collection('products').doc(x.q).update({productType:'SERVICE'})],
  ['demand',x=>db.collection('procurementDemands').doc(encodeURIComponent('SALES_ORDER:'+x.orderId+':I1')).update({cancelled:false,status:'ORDERED'})],
  ['po',x=>db.collection('purchaseOrders').doc(x.po.poNo).update({supplyOrderIds:[]})],
  ['paper',async x=>{const o=await x.read('orders',x.orderId);o.items[2].dispatchPreparedQty=1;await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['proof',async x=>{const o=await x.read('orders',x.orderId);await db.collection('inventoryMovements').doc(o.returnRecords.find(r=>r.itemId==='I3').movementId).update({intentHash:'forged'});}]
 ];
 for(const [name,mutate] of cases){const x=await cancelledMultiReceiptFixture('bad-'+name,{closed:true});await mutate(x);const before=await wholeLifecycleSnapshot(x);
  await assert.rejects(x.receive('I1',1,'mk_bad_'+name));assert.deepEqual(await wholeLifecycleSnapshot(x),before,name);}
});
test('cancelled multi-item receiving uses current operational role and binds retries to the original actor and role',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const x=await cancelledMultiReceiptFixture('role-'+role),uid='mk-actor-'+role;await db.collection('users').doc(uid).set({role,active:true});
  x.c.currentUser={uid};x.c.currentUserRole=role;const before=await wholeLifecycleSnapshot(x);
  if(['sales','engineer'].includes(role)){await assert.rejects(x.receive('I1',1,'mk_role_'+role));assert.deepEqual(await wholeLifecycleSnapshot(x),before);continue;}
  await x.receive('I1',1,'mk_role_'+role);const once=await wholeLifecycleSnapshot(x);
  await db.collection('users').doc(uid).update({disabled:true});await assert.rejects(x.receive('I1',1,'mk_role_'+role),/真實登入/);assert.deepEqual(await wholeLifecycleSnapshot(x),once);
  await db.collection('users').doc(uid).update({disabled:false});x.c.currentUser={uid:'emulator-purchaser'};x.c.currentUserRole='purchaser';
  await assert.rejects(x.receive('I1',1,'mk_role_'+role),/識別碼衝突/);assert.deepEqual(await wholeLifecycleSnapshot(x),once);
 }
});
test('cancelled multi-item receipt races serialize same IDs excess quantities and simultaneous restore without duplicating stock',async()=>{
 const x=await cancelledMultiReceiptFixture('race');await Promise.all([x.receive('I2',1,'mk_same'),x.receive('I2',1,'mk_same')]);
 assert.equal((await x.read('inventory',x.productKey)).onHand,4);
 const excess=await Promise.allSettled([x.receive('I2',2,'mk_over_a'),x.receive('I2',2,'mk_over_b')]);assert.equal(excess.filter(r=>r.status==='fulfilled').length,1);
 await Promise.all([x.receive('I1',2,'mk_restore_race'),x.life('normal')]);
 const order=await x.read('orders',x.orderId),stock=await x.read('inventory',x.productKey);assert.equal(order.status,'active');assert.equal(stock.onHand,8);
 assert.equal(order.items[0].receivedQty,2);assert.equal(order.items[1].receivedQty,3);
 // Restore may first reserve this stock to another line. Later source excess
 // remains free until the existing allocator can claim it; neither ordering
 // may manufacture a hold or overwrite the restored sibling reservation.
 assert.ok(stock.reserved>=6&&stock.reserved<=8);assert.equal(stock.incoming,1);
 assert.equal(order.items[0].reservedQty+order.items[1].reservedQty,stock.reserved);
 assert.equal(order.items[0].shortageQty+order.items[1].shortageQty,9-stock.reserved);
});
test('cancelled multi-item receipt late create collision rolls back all facts and lost response replays the original receipt after restore',async()=>{
 const x=await cancelledMultiReceiptFixture('rollback'),collision=db.collection('inventoryMovements').doc('mk-late-collision');await collision.set({sentinel:true});
 const before=await wholeLifecycleSnapshot(x);
 x.c.runRoleTransaction=fn=>db.runTransaction(async tx=>fn({get:r=>tx.get(r),update:(...a)=>tx.update(...a),
  set:(ref,...args)=>{if(ref.path.startsWith('receipts/'))tx.create(collision,{sentinel:false});return tx.set(ref,...args);}}));
 await assert.rejects(x.receive('I1',1,'mk_rollback'),e=>e.code===6);assert.deepEqual(await wholeLifecycleSnapshot(x),before);
 let lost=true;x.c.runRoleTransaction=async fn=>{const r=await db.runTransaction(async tx=>fn(tx));if(lost){lost=false;throw Error('KEEP_STOCK reply lost');}return r;};
 await assert.rejects(x.receive('I1',1,'mk_rollback'),/reply lost/);await x.life('normal');const restored=await wholeLifecycleSnapshot(x);
 await x.receive('I1',1,'mk_rollback');assert.deepEqual(await wholeLifecycleSnapshot(x),restored);
});
test('cancelled multi-item receipt exposes the original bounded free-stock recovery source and keeps the production gate closed',async()=>{
 const x=await cancelledMultiReceiptFixture('recovery');await x.receive('I1',1,'mk_recovery');
 const receipt=await x.read('receipts','mk_recovery');assert.equal(receipt.sourceOrderStatus,'cancelled');assert.equal(receipt.autoAllocationQty,1);assert.equal(receipt.reservationLocationSchemaVersion,2);
 const moves=await db.collection('inventoryMovements').where('receiptId','==','mk_recovery').get(),movement=moves.docs.find(s=>s.data().type==='receipt');
 const before=await wholeLifecycleSnapshot(x);await advanceReleasedV2FreeStock(db,'emulator-purchaser',{movementId:movement.id});assert.deepEqual(await wholeLifecycleSnapshot(x),before);
 delete x.c.process;await assert.rejects(x.receive('I1',1,'mk_production_gate'),/僅允許 demo-yushin/);assert.deepEqual(await wholeLifecycleSnapshot(x),before);
});
test('multi-item CLOSE receipts preserve sibling return facts and complete twelve historical deliveries without reopening closed quantities',async()=>{
 const x=await multiClosedFollowupFixture('complete'),before=await x.read('orders',x.orderId);
 await x.receive('I1',1,'mc_complete_partial');const once=await wholeLifecycleSnapshot(x);
 await x.receive('I1',1,'mc_complete_partial');assert.deepEqual(await wholeLifecycleSnapshot(x),once);
 await assert.rejects(x.receive('I1',2,'mc_complete_partial'),/識別碼衝突/);
 assert.deepEqual((await x.read('orders',x.orderId)).items.slice(1),before.items.slice(1));
 await x.receive('I1',1,'mc_complete_last');await x.receive('I2',4,'mc_complete_i2');await x.receive('I3',2,'mc_complete_i3');
 for(const [itemId,wh,qty,tag] of [['I1','V2-A',2,'a'],['I1','V2-B',2,'b'],['I2','V2-B',4,'c'],['I3','V2-B',2,'d']]){
  await x.prepare(itemId,qty,tag);await x.ship(itemId,wh,qty,tag);await x.confirm(itemId,qty,tag);
 }
 const order=await x.read('orders',x.orderId);assert.equal(order.deliveredQty,12);assert.equal(order.returnedQty,2);assert.equal(order.isDelivered,true);
 assert.deepEqual(order.returnRecords,before.returnRecords);assert.deepEqual(order.returnHistory,before.returnHistory);
 for(const key of [x.productKey,x.q]){const stock=await x.read('inventory',key);assert.equal(stock.onHand,1);assert.equal(stock.reserved,0);assert.equal(stock.incoming,0);}
});
test('whole-order cancel restore after two-product CLOSE preserves physical proofs and permits remaining receipts',async()=>{
 const x=await multiClosedFollowupFixture('restore'),before=await wholeLifecycleSnapshot(x),original=await x.read('orders',x.orderId);
 await x.life();const cancelled=await x.read('orders',x.orderId);
 assert.ok(cancelled.items.every(i=>i.reservedQty===0&&i.shortageQty===0));
 const applied=await wholeLifecycleSnapshot(x);assert.equal((await x.life()).status,'already-applied');assert.deepEqual(await wholeLifecycleSnapshot(x),applied);
 await x.life('normal');const restored=await x.read('orders',x.orderId);
 for(const field of ['warehouseShipmentRecords','deliveryRecords','returnRecords','returnHistory','deliveredQty','returnedQty','isDelivered'])assert.deepEqual(restored[field],original[field],field);
 const after=await wholeLifecycleSnapshot(x);
 for(const [key,value] of Object.entries(before))if(/^(supplyOrders|receipts|inventoryLots|inventoryLotCosts|purchaseOrders)\//.test(key))assert.deepEqual(after[key],value,key);
 for(const item of restored.items){const ledger=await x.read('inventoryReservations',x.orderId+'__'+item.itemId);
  assert.equal(ledger.quantity+ledger.shortageQty,(item.qty??item.orderedQty)-(item.warehouseShippedQty??0));}
 await x.receive('I1',2,'mc_restore_i1');await x.receive('I3',2,'mc_restore_i3');
 assert.deepEqual((await x.read('orders',x.orderId)).returnRecords,original.returnRecords);
});
test('receiving and lifecycle reject missing forged hidden sibling CLOSE proofs or edited histories before any write',async()=>{
 const cases=[
  ['missing',async(x,r)=>db.collection('inventoryMovements').doc(r.movementId).delete()],
  ['hash',async(x,r)=>db.collection('inventoryMovements').doc(r.movementId).update({intentHash:'forged'})],
  ['record',async(x,r)=>db.collection('inventoryMovements').doc(r.movementId).update({'returnRecord.reason':'forged'})],
  ['unknown',async(x,r)=>db.collection('inventoryMovements').doc(r.movementId).update({itemId:'UNKNOWN'})],
  ['hidden',async(x,r)=>{const o=await x.read('orders',x.orderId);await db.collection('orders').doc(x.orderId).update({returnRecords:o.returnRecords.filter(s=>s.id!==r.id)});}],
  ['history',async x=>{const o=await x.read('orders',x.orderId);await db.collection('orders').doc(x.orderId).update({returnHistory:[...o.returnHistory,{action:'edit',recordId:o.returnRecords[0].id}]});}]
 ];
 for(const [name,mutate] of cases){const x=await multiClosedFollowupFixture('bad-'+name),o=await x.read('orders',x.orderId);
  await mutate(x,o.returnRecords.find(r=>r.itemId==='I3'));const before=await wholeLifecycleSnapshot(x);
  await assert.rejects(x.receive('I1',1,'mc_bad_'+name));assert.deepEqual(await wholeLifecycleSnapshot(x),before,name+' receipt');
  await assert.rejects(x.life());assert.deepEqual(await wholeLifecycleSnapshot(x),before,name+' lifecycle');}
});
test('multi-item CLOSE followup remains closed to replacement returns and unapproved cancelled receipts',async()=>{
 const x=await wholeLifecycleFixture('replace-followup');await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');await x.confirm('I1',1,'first');
 const shipment=(await x.read('orders',x.orderId)).warehouseShipmentRecords[0];
 await assert.rejects(require('../functions/location-return-service').commitLocationReturn(db,x.uid,{
  ...x.request('I1','replace'),shipmentId:shipment.id,warehouseId:'V2-A',date:'2026-10-20',reason:'補送',condition:'RESTOCKABLE',settlement:'REPLACE',
  selections:[{lotId:shipment.lotAllocations[0].lotId,qty:1}]}));
 const y=await multiClosedFollowupFixture('cancelled');await y.life();const before=await wholeLifecycleSnapshot(y);
 await assert.rejects(y.receive('I1',1,'mc_cancelled_receipt'));assert.deepEqual(await wholeLifecycleSnapshot(y),before);
});
test('whole-order initial cancellation and restoration update every ledger and demand atomically without changing physical goods',async()=>{
 const x=await wholeLifecycleFixture('initial',{purchase:false}),initial=await x.read('orders',x.orderId);
 const stocks=await Promise.all([x.productKey,x.q].map(key=>x.read('inventory',key)));
 const cancelled=await x.life();assert.equal(cancelled.items.length,3);assert.equal(cancelled.items.reduce((s,i)=>s+i.companyReservedDelta,0),-4);
 for(const item of initial.items){const ledger=await x.read('inventoryReservations',x.orderId+'__'+item.itemId);
  assert.equal(ledger.status,'released');assert.equal(ledger.quantity,0);assert.equal(ledger.shortageQty,0);assert.deepEqual(ledger.locations,[]);
  const demand=await x.read('procurementDemands',encodeURIComponent('SALES_ORDER:'+x.orderId+':'+item.itemId));assert.equal(demand.cancelled,true);}
 const restored=await x.life('normal');assert.equal(restored.items.reduce((s,i)=>s+i.companyReservedDelta,0),4);
 const order=await x.read('orders',x.orderId);assert.equal(order.status,'active');
 assert.deepEqual(order.items.map(i=>[i.reservedQty,i.shortageQty]),initial.items.map(i=>[i.reservedQty,i.shortageQty]));
 for(const [n,key] of [x.productKey,x.q].entries()){const stock=await x.read('inventory',key);assert.equal(stock.onHand,stocks[n].onHand);assert.equal(stock.reserved,stocks[n].reserved);}
 const before=await wholeLifecycleSnapshot(x);assert.equal((await x.life()).status,'already-applied');assert.deepEqual(await wholeLifecycleSnapshot(x),before);
});
test('real multi-item PO partial receipts and acknowledged shipments survive whole-order cancel restore with incoming commitments untouched',async()=>{
 const x=await wholeLifecycleFixture('purchased');await x.receive('I1',1,'wl_receipt_i1');await x.receive('I2',2,'wl_receipt_i2');
 await x.prepare('I1',1,'one');await x.ship('I1','V2-A',1,'one');await x.confirm('I1',1,'one');
 await x.prepare('I2',1,'two');await x.ship('I2','V2-B',1,'two');await x.confirm('I2',1,'two');
 const before=await wholeLifecycleSnapshot(x),orderBefore=await x.read('orders',x.orderId);
 await x.life();const cancelled=await x.read('orders',x.orderId);assert.equal(cancelled.deliveredQty,2);
 assert.deepEqual(cancelled.warehouseShipmentRecords,orderBefore.warehouseShipmentRecords);assert.deepEqual(cancelled.deliveryRecords,orderBefore.deliveryRecords);
 const restored=await x.life('normal');assert.deepEqual(restored.items.map(i=>i.reservedQty),[3,1,1]);
 const after=await wholeLifecycleSnapshot(x);
 for(const [key,value] of Object.entries(before))if(/^(supplyOrders|receipts|inventoryLots|inventoryLotCosts|purchaseOrders)\//.test(key))assert.deepEqual(after[key],value,key);
 for(const key of [x.productKey,x.q])for(const collection of ['inventory','warehouseStocks']){
  const paths=collection==='inventory'?[key]:['V2-A__'+key,'V2-B__'+key];
  for(const path of paths){const a=before[collection+'/'+path],b=after[collection+'/'+path];assert.equal(b.onHand,a.onHand);assert.equal(b.incoming,a.incoming);assert.equal(b.reserved,a.reserved);}
 }
 assert.equal((await x.read('orders',x.orderId)).deliveredQty,2);
 await x.receive('I1',1,'wl_receipt_after_restore');assert.equal((await x.read('orders',x.orderId)).items[0].shortageQty,0);
});
test('a fully acknowledged sibling remains physically fulfilled across cancellation and restoration of remaining items',async()=>{
 const x=await wholeLifecycleFixture('fulfilled');await x.receive('I1',2,'wl_full_i1');await x.prepare('I1',5,'all');
 await x.ship('I1','V2-A',3,'a');await x.ship('I1','V2-B',2,'b');await x.confirm('I1',3,'a');await x.confirm('I1',2,'b');
 const original=(await x.read('orders',x.orderId)).items[0];await x.life();await x.life('normal');
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.items[0],original);assert.equal(order.deliveredQty,5);assert.equal(order.isDelivered,false);
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I1')).status,'fulfilled');
 await x.receive('I2',1,'wl_after_fulfilled_restore');assert.deepEqual((await x.read('orders',x.orderId)).items[0],original);
});
async function competingWholeLifecycleOrder(x,quantity=2){
 const orderId=x.orderId+'-competitor';await db.collection('orders').doc(orderId).set({ownerUid:x.uid,salesCode:'V2',status:'active',
  inventoryReservationStatus:'pending',items:[{itemId:'OTHER',productId:x.productKey,qty:quantity,warehouseId:'V2-A'}],deliveryRecords:[],returnRecords:[],warehouseShipmentRecords:[]});
 await synchronizeV2OrderFixture(db,x.uid,{orderId,warehouseIds:['V2-A','V2-B']});return orderId;
}
test('five same-product restorations share the remaining stock after a competing order takes released goods',async()=>{
 const x=await wholeLifecycleFixture('five',{five:true,purchase:false});await x.life();
 const other=await competingWholeLifecycleOrder(x);assert.equal((await x.read('inventoryReservations',other+'__OTHER')).quantity,2);
 const restored=await x.life('normal');assert.deepEqual(restored.items.map(i=>i.reservedQty),[1,0,0,0,0]);
 assert.deepEqual(restored.items.map(i=>i.shortageQty),[2,3,3,3,3]);assert.equal((await x.read('inventory',x.productKey)).reserved,3);
 const order=await x.read('orders',x.orderId);assert.equal(order.items[0].warehouseId,'V2-A');
});
test('whole-order lifecycle enforces current five-role authority ownership and replay actor role intent binding',async()=>{
 for(const role of ['admin','sales','engineer','warehouse','purchaser']){
  const x=await wholeLifecycleFixture('role-'+role,{purchase:false});await db.collection('users').doc(x.uid).update({role});
  const before=await wholeLifecycleSnapshot(x);
  if(['warehouse','purchaser'].includes(role)){await assert.rejects(x.life(),/不能取消/);assert.deepEqual(await wholeLifecycleSnapshot(x),before);}
  else{await x.life();const applied=await wholeLifecycleSnapshot(x);await db.collection('users').doc(x.uid).update({active:false});
   await assert.rejects(x.life(),/不能取消/);assert.deepEqual(await wholeLifecycleSnapshot(x),applied);}
 }
 const x=await wholeLifecycleFixture('identity',{purchase:false});await x.life();const applied=await wholeLifecycleSnapshot(x);
 for(const patch of [{reason:'不同原因'},{itemIds:['I1','I2']},{date:'2026-10-22'},{nextStatus:'normal'}])
  await assert.rejects(commitOrderLocationLifecycle(db,x.uid,x.intent('cancelled','cancelled',patch)),/其他交易/);
 await db.collection('users').doc('wl-other-admin').set({role:'admin',active:true});await assert.rejects(x.life('cancelled','cancelled','wl-other-admin'),/其他交易/);
 await db.collection('users').doc(x.uid).update({role:'engineer'});await assert.rejects(x.life(),/其他交易/);
 await db.collection('users').doc(x.uid).update({role:'sales'});await db.collection('orders').doc(x.orderId).update({ownerUid:'another-owner'});
 await assert.rejects(x.life(),/其他業務/);const after=await wholeLifecycleSnapshot(x);delete after['orders/'+x.orderId];delete applied['orders/'+x.orderId];assert.deepEqual(after,applied);
});
test('whole-order duplicate and competing cancellation ids commit exactly once and a lost reply never reverts a later restore',async()=>{
 const x=await wholeLifecycleFixture('race',{purchase:false});
 const same=await Promise.all([x.life(),x.life()]);assert.deepEqual(same.map(r=>r.status).sort(),['already-applied','applied']);
 await x.life('normal');const results=await Promise.allSettled([x.life('cancelled','againA'),x.life('cancelled','againB')]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const y=await wholeLifecycleFixture('lost',{purchase:false});let lost=true;
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:async fn=>{const result=await db.runTransaction(async tx=>fn(tx));if(lost){lost=false;throw Error('whole lifecycle reply lost');}return result;}};
 await assert.rejects(y.life('cancelled','cancelled',y.uid,guarded),/reply lost/);const once=await wholeLifecycleSnapshot(y);
 assert.equal((await y.life()).status,'already-applied');assert.deepEqual(await wholeLifecycleSnapshot(y),once);
 await y.life('normal');const restored=await wholeLifecycleSnapshot(y);await y.life();assert.deepEqual(await wholeLifecycleSnapshot(y),restored);
});
test('whole-order lifecycle refuses corrupted sibling ledgers supply receipt proofs pending freight and unsupported returns atomically',async()=>{
 const cases=[
  ['ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({quantity:0})],
  ['in-transit',x=>db.collection('inventory').doc(x.productKey).update({incoming:3})],
  ['service',x=>db.collection('products').doc(x.q).update({productType:'SERVICE'})],
  ['supply',x=>db.collection('supplyOrders').doc(x.supplies.find(s=>s.itemId==='I3').id).update({demandId:'wrong'})],
  ['missing-receipt',async x=>{await x.receive('I3',1,'wl_corrupt_receipt');await db.collection('receipts').doc('wl_corrupt_receipt').delete();}],
  ['pending',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'pending'})],
  ['returns',x=>db.collection('orders').doc(x.orderId).update({returnRecords:[{id:'unsupported'}]})],
  ['shipment',async x=>{await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');}],
  ['paper',x=>x.prepare('I1',1,'paper')],
  ['debit',async x=>{await x.prepare('I1',1,'first');await x.ship('I1','V2-A',1,'first');await x.confirm('I1',1,'first');
   await db.collection('inventoryMovements').doc('location-ship-'+x.request('I1','ship_first').operationId).update({qty:0});}],
  ['hidden-return',x=>db.collection('inventoryMovements').doc('wl-hidden-return').set({sourceId:x.orderId,action:'location_customer_return',qty:1,itemId:'I3'})]
 ];
 for(const [name,mutate] of cases){const x=await wholeLifecycleFixture('bad-'+name);await mutate(x);const before=await wholeLifecycleSnapshot(x);
  await assert.rejects(x.life());assert.deepEqual(await wholeLifecycleSnapshot(x),before,name);}
});
test('whole-order lifecycle reads each product balance once and a true late receipt collision rolls back every earlier line',async()=>{
 const x=await wholeLifecycleFixture('rollback',{purchase:false}),before=await wholeLifecycleSnapshot(x);
 const collision=db.collection('inventoryMovements').doc('whole-lifecycle-collision');await collision.set({sentinel:true});
 const reads=[],writes=[];
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(async tx=>fn({
  get:r=>{if(r.path)reads.push(r.path);return tx.get(r);},update:(r,d)=>{writes.push(r.path);return tx.update(r,d);},
  set:(...a)=>tx.set(...a),create:(r,d)=>{if(r.parent.id==='reservationOperationReceipts')tx.create(collision,{sentinel:false});return tx.create(r,d);}
 }))};
 await assert.rejects(x.life('cancelled','cancelled',x.uid,guarded),e=>e.code===6);assert.deepEqual(await wholeLifecycleSnapshot(x),before);
 assert.deepEqual((await collision.get()).data(),{sentinel:true});
 for(const path of ['inventory/'+x.productKey,'warehouseStocks/V2-A__'+x.productKey,'warehouseStocks/V2-B__'+x.productKey]){
  assert.equal(reads.filter(p=>p===path).length,1,path);assert.equal(writes.filter(p=>p===path).length,1,path);
 }
 await x.life();assert.equal((await x.life()).status,'already-applied');
});
test('whole-order cancellation releases reuse the original durable free-stock recovery with per-line proof and fixed replay',async()=>{
 const x=await wholeLifecycleFixture('recovery',{purchase:false});
 const other=await competingWholeLifecycleOrder(x);assert.equal((await x.read('inventoryReservations',other+'__OTHER')).quantity,0);
 const adminUid='wl-recovery-admin';await db.collection('users').doc(adminUid).set({role:'admin',active:true});
 const result=await commitOrderLocationLifecycleAndRecover(db,adminUid,x.intent());assert.equal(result.status,'applied');
 assert.equal((await x.read('inventoryReservations',other+'__OTHER')).quantity,2);
 const before=await wholeLifecycleSnapshot(x);await commitOrderLocationLifecycleAndRecover(db,adminUid,x.intent());assert.deepEqual(await wholeLifecycleSnapshot(x),before);
 const movement=(await db.collection('inventoryMovements').where('sourceId','==',x.orderId).where('type','==','release').get()).docs[0];
 await movement.ref.update({itemId:'UNKNOWN'});await assert.rejects(advanceReleasedV2FreeStock(db,adminUid,{movementId:movement.id}),/原始交易憑證/);
});
