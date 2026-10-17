'use strict';
// Real Firestore Emulator: server-side read-only multiwarehouse v2 planner.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const demandCore=require('../modules/procurement-demand-core');
const {planSingleItemTwoWarehouse,commitSingleItemTwoWarehouse,commitSingleItemFreeStockAllocation,advanceAutomaticFreeStockAllocation}=require('../functions/single-item-location-service');
const {commitSingleItemLocationLifecycle}=require('../functions/single-item-location-lifecycle-service');
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
 c.process=process;c.window=c;c.YushinSupply=require('../modules/supply-core');
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
 vm.runInContext(fs.readFileSync('modules/customer-cancellations.js','utf8'),x.c);
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
 assert.equal((await newer.read('orders',newer.orderId)).items[0].shortageQty,4);
 const replay=await advanceAutomaticFreeStockAllocation(db,source.uid,input);
 assert.equal(replay.allocatedQty,2);
});
