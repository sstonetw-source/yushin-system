'use strict';
// Existing location writer, real Admin SDK transactions, isolated demo Emulator.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore');
const {commitOrderTwoWarehouse}=require('../functions/single-item-location-service');
let app,db;
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Never use live Firestore');
 app=admin.initializeApp({projectId:'demo-yushin'},'order-location-reservation');db=getFirestore(app);
});
test.after(async()=>{if(app)await app.delete();});
async function seed(tag,{role='purchaser',five=false,company=7,owner=null}={}){
 const orderId='multi-v2-'+tag,uid='multi-actor-'+tag,p='multi-p-'+tag,q='multi-q-'+tag;
 const items=five?Array.from({length:5},(_,n)=>({itemId:'I'+n,productId:p,qty:3,warehouseId:n%2?'MULTI-B':'MULTI-A',reservedQty:0})):[
  {itemId:'I1',productId:p,qty:5,warehouseId:'MULTI-A',reservedQty:0},
  {itemId:'I2',productId:p,qty:5,warehouseId:'MULTI-B',reservedQty:0},
  {itemId:'I3',productId:q,qty:4,warehouseId:'MULTI-B',reservedQty:0}];
 const batch=db.batch(),set=(name,key,data)=>batch.set(db.collection(name).doc(key),data);
 set('users',uid,{role,active:true});
 set('orders',orderId,{ownerUid:owner||uid,salesCode:'MULTI',status:'active',orderDate:'2026-10-18',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'multi_sync_123456',items,deliveryRecords:[],returnRecords:[]});
 for(const wh of ['MULTI-A','MULTI-B'])set('warehouses',wh,{active:true});
 for(const [key,a,b,total] of [[p,3,4,company],[q,2,1,3]]){
  set('products',key,{productType:'Goods'});set('inventory',key,{productKey:key,onHand:total,reserved:0,incoming:100,transferFreeInTransit:0});
  for(const [warehouseId,onHand] of [['MULTI-A',a],['MULTI-B',b]])
   set('warehouseStocks',warehouseId+'__'+key,{productKey:key,warehouseId,onHand,reserved:0,incoming:100,transferFreeInTransit:0});
 }
 await batch.commit();
 const intent={orderId,itemIds:items.map(i=>i.itemId).reverse(),warehouseIds:['MULTI-B','MULTI-A'],attemptId:'multi_attempt_'+tag,syncAttemptId:'multi_sync_123456'};
 return {orderId,uid,p,q,items,intent,run:(patch={},actor=uid,target=db)=>commitOrderTwoWarehouse(target,actor,{...intent,...patch}),
  read:async(name,key)=>(await db.collection(name).doc(key).get()).data()};
}
async function snapshot(f){
 const paths=[['orders',f.orderId],...f.items.map(i=>['inventoryReservations',f.orderId+'__'+i.itemId])];
 for(const key of [f.p,f.q])paths.push(['inventory',key],['warehouseStocks','MULTI-A__'+key],['warehouseStocks','MULTI-B__'+key]);
 const docs=await Promise.all(paths.map(async([n,k])=>[n+'/'+k,await f.read(n,k)]));
 const query=async n=>(await db.collection(n).where('orderId','==',f.orderId).get()).docs.map(d=>[d.id,d.data()]).sort((a,b)=>a[0].localeCompare(b[0]));
 const movements=(await db.collection('inventoryMovements').where('sourceId','==',f.orderId).get()).docs.map(d=>[d.id,d.data()]).sort((a,b)=>a[0].localeCompare(b[0]));
 return {docs,receipts:await query('reservationOperationReceipts'),movements};
}
test('whole-order three lines/two products share balances and commit one receipt without virtual stock',async()=>{
 const f=await seed('normal'),result=await f.run();
 assert.deepEqual(result.items.map(i=>[i.itemId,i.reservedQty,i.shortageQty]),[['I1',5,0],['I2',2,3],['I3',3,1]]);
 assert.deepEqual(result.items[0].locations,[{warehouseId:'MULTI-A',reservedQty:3},{warehouseId:'MULTI-B',reservedQty:2}]);
 const order=await f.read('orders',f.orderId);assert.deepEqual(order.items.map(i=>i.reservedQty),[5,2,3]);
 assert.equal(order.inventoryReservationStatus,'pending','reservation alone is not the demand/source completion checkpoint');
 for(const [key,total] of [[f.p,7],[f.q,3]]){
  const company=await f.read('inventory',key);assert.equal(company.reserved,total);assert.equal(company.onHand,total);assert.equal(company.incoming,100);
  const a=await f.read('warehouseStocks','MULTI-A__'+key),b=await f.read('warehouseStocks','MULTI-B__'+key);assert.equal(a.reserved+b.reserved,total);
 }
 const saved=await snapshot(f);assert.equal(saved.receipts.length,1);assert.equal(saved.movements.length,5);
 assert.equal(saved.receipts[0][1].action,'order_location_reservation');assert.equal(saved.receipts[0][1].actorUid,f.uid);
 for(const item of f.items){const ledger=await f.read('inventoryReservations',f.orderId+'__'+item.itemId);assert.equal(ledger.locationSchemaVersion,2);assert.equal(ledger.warehouseId,undefined);}
});
test('five same-product lines cannot each allocate the same physical stock or reorder priority from payload',async()=>{
 const f=await seed('five',{five:true}),result=await f.run();
 assert.deepEqual(result.items.map(i=>i.reservedQty),[3,3,1,0,0]);
 assert.equal(result.items.reduce((s,i)=>s+i.reservedQty,0),7);
 const before=await snapshot(f);assert.equal((await f.run({itemIds:[...f.intent.itemIds].reverse()})).status,'already-applied');assert.deepEqual(await snapshot(f),before);
 const again=await f.run({attemptId:'multi_second_attempt_five'});assert.ok(again.items.every(i=>i.companyReservedDelta===0));
 assert.equal((await snapshot(f)).movements.length,before.movements.length);
});
test('shared company ceiling and free-in-transit are never offered to later order lines',async()=>{
 const f=await seed('company',{company:5});let result=await f.run();assert.deepEqual(result.items.slice(0,2).map(i=>i.reservedQty),[5,0]);
 const g=await seed('transit');await db.collection('inventory').doc(g.p).update({transferFreeInTransit:2});
 await db.collection('warehouseStocks').doc('MULTI-B__'+g.p).update({transferFreeInTransit:2});
 result=await g.run();assert.deepEqual(result.items.slice(0,2).map(i=>i.reservedQty),[5,0]);
 assert.equal((await g.read('inventory',g.p)).transferFreeInTransit,2);
});
test('all five current reservation roles are checked against the actual source owner and current profile',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const f=await seed('role-'+role,{role});await f.run();
  await db.collection('users').doc(f.uid).update({active:false});await assert.rejects(f.run(),/停用/);
 }
 for(const role of ['sales','engineer']){
  const f=await seed('stranger-'+role,{role,owner:'other-owner'}),before=await snapshot(f);
  await assert.rejects(f.run(),/不得檢視/);assert.deepEqual(await snapshot(f),before);
 }
});
test('whole-order replay binds actor role intent and source ownership even after later progress',async()=>{
 const f=await seed('replay',{role:'sales'});await f.run();const before=await snapshot(f);
 await assert.rejects(f.run({syncAttemptId:'other_sync'}),/其他交易/);
 await db.collection('users').doc('multi-other-admin').set({role:'admin',active:true});
 await assert.rejects(f.run({},'multi-other-admin'),/其他交易/);
 await db.collection('orders').doc(f.orderId).update({inventoryReservationStatus:'completed',status:'cancelled'});
 assert.equal((await f.run()).status,'already-applied');assert.deepEqual((await snapshot(f)).movements,before.movements);
 await db.collection('orders').doc(f.orderId).update({ownerUid:'changed-owner'});await assert.rejects(f.run(),/不得檢視/);
});
test('same and different concurrent attempts on one order never double reserve shared product balances',async()=>{
 for(const same of [true,false]){
  const f=await seed('concurrent-'+same);const results=await Promise.all([f.run(),f.run(same?{}:{attemptId:'different_multi_attempt'})]);
  assert.equal(results.filter(r=>r.status==='applied').length,same?1:2);
  assert.equal((await f.read('inventory',f.p)).reserved,7);assert.equal((await f.read('inventory',f.q)).reserved,3);
  assert.equal((await snapshot(f)).movements.length,5);
 }
});
test('two competing multi-line orders serialize against the same stock documents',async()=>{
 const f=await seed('competition'),otherId=f.orderId+'-peer',order=await f.read('orders',f.orderId);
 await db.collection('orders').doc(otherId).set(order);
 await Promise.all([f.run(),f.run({orderId:otherId,attemptId:'peer_multi_attempt'})]);
 const orders=[await f.read('orders',f.orderId),await f.read('orders',otherId)];
 assert.equal(orders.flatMap(o=>o.items).filter(i=>i.productId===f.p).reduce((s,i)=>s+i.reservedQty,0),7);
 assert.equal(orders.flatMap(o=>o.items).filter(i=>i.productId===f.q).reduce((s,i)=>s+i.reservedQty,0),3);
 assert.equal((await f.read('inventory',f.p)).reserved,7);
});
test('last-line validation failures leave every earlier product ledger stock and receipt unchanged',async()=>{
 const cases=[
  ['service',f=>db.collection('products').doc(f.q).set({productType:'SERVICE'})],
  ['missing-stock',f=>db.collection('warehouseStocks').doc('MULTI-B__'+f.q).delete()],
  ['bad-stock',f=>db.collection('warehouseStocks').doc('MULTI-B__'+f.q).update({reserved:2})],
  ['legacy',f=>db.collection('inventoryReservations').doc(f.orderId+'__I3').set({quantity:0,shortageQty:4,warehouseId:'MULTI-B'})],
  ['supply',async f=>{const o=await f.read('orders',f.orderId);o.items[2].supplyOrderedQty=1;await db.collection('orders').doc(f.orderId).update({items:o.items});}],
  ['direct',async f=>{const o=await f.read('orders',f.orderId);o.items[2].fulfillmentType='DIRECT_SHIP';await db.collection('orders').doc(f.orderId).update({items:o.items});}]
 ];
 for(const [tag,mutate] of cases){const f=await seed('reject-'+tag);await mutate(f);const before=await snapshot(f);await assert.rejects(f.run());assert.deepEqual(await snapshot(f),before,tag);}
});
test('late movement create collision rolls back all products and retains a safe fixed-ID retry',async()=>{
 const f=await seed('late-failure'),collision=db.collection('inventoryMovements').doc('order-v2-'+f.intent.attemptId+'-2-MULTI-A');
 await collision.set({sourceId:f.orderId,sentinel:true});const before=await snapshot(f);await assert.rejects(f.run());assert.deepEqual(await snapshot(f),before);
 await collision.delete();await f.run();assert.equal((await f.read('inventory',f.p)).reserved,7);
 assert.equal((await f.run()).status,'already-applied');
});
test('partial item lists stale sync duplicate source IDs and existing logistics are refused atomically',async()=>{
 const f=await seed('scope'),before=await snapshot(f);
 await assert.rejects(f.run({itemIds:['I1','I2']}),/全部/);await assert.rejects(f.run({syncAttemptId:'stale'}),/同步/);assert.deepEqual(await snapshot(f),before);
 const order=await f.read('orders',f.orderId);await db.collection('orders').doc(f.orderId).update({items:[order.items[0],order.items[0],order.items[2]]});
 await assert.rejects(f.run(),/唯一/);
 await db.collection('orders').doc(f.orderId).update({items:order.items,warehouseShipmentRecords:[{id:'existing'}]});
 await assert.rejects(f.run(),/物流/);
});
test('same-product source reads are bounded and stock/order documents are written only once',async()=>{
 const f=await seed('read-budget',{five:true}),reads=[],writes=[];
 const counted={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:ref=>{reads.push(ref.path);return tx.get(ref);},
  update:(ref,data)=>{writes.push(ref.path);return tx.update(ref,data);},
  set:(ref,data)=>{writes.push(ref.path);return tx.set(ref,data);},
  create:(ref,data)=>{writes.push(ref.path);return tx.create(ref,data);}
 }))};
 await f.run({},f.uid,counted);assert.equal(reads.length,14);assert.equal(new Set(reads).size,reads.length);
 for(const path of ['orders/'+f.orderId,'inventory/'+f.p,'warehouseStocks/MULTI-A__'+f.p,'warehouseStocks/MULTI-B__'+f.p])
  assert.equal(writes.filter(p=>p===path).length,1,path);
});
test('joint existing ledger claims cannot conceal duplicate ownership of the original company or warehouse holds',async()=>{
 for(const target of ['company','warehouse']){
  const f=await seed('joint-'+target);await f.run();
  // Each line alone is <= 5 held units, but both P lines together claim 7.
  if(target==='company')await db.collection('inventory').doc(f.p).update({reserved:5});
  else await db.collection('warehouseStocks').doc('MULTI-B__'+f.p).update({reserved:2});
  const before=await snapshot(f);await assert.rejects(f.run({attemptId:'joint_new_attempt_'+target}),/整單既有/);
  assert.deepEqual(await snapshot(f),before);
 }
});
