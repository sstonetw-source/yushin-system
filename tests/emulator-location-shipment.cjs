'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore');
const {commitSingleItemTwoWarehouse}=require('../functions/single-item-location-service');
const {commitLocationShipment}=require('../functions/location-shipment-service');
let app,db;
const plan={mode:'CUSTOMER_SHIP',contact:'客戶',phone:'02-12345678',address:'台北市測試地址'};
const A='SHIP-A',B='SHIP-B';
test.before(()=>{assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Never use live Firestore');
 app=admin.initializeApp({projectId:'demo-yushin'},'location-shipment');db=getFirestore(app);});
test.after(async()=>{if(app)await app.delete();});
async function seed(name,{role='warehouse',prepared=10}={}){
 const uid='ship-user-'+name,orderId='ship-order-'+name,key='ship-product-'+name;
 const order={ownerUid:uid,salesCode:'S',status:'active',orderStatus:'normal',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_ship_12345',
  deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
  items:[{itemId:'I',productId:key,qty:10,warehouseId:A,reservedQty:0,dispatchPreparedQty:0,
   deliveryPlan:plan,fulfillmentType:'WAREHOUSE',returnedQty:0}]};
 const batch=db.batch(),set=(n,k,d)=>batch.set(db.collection(n).doc(k),d);
 set('users',uid,{role,active:true});set('products',key,{productType:'Goods',active:true});
 set('orders',orderId,order);set('inventory',key,{productKey:key,onHand:16,reserved:2,transferFreeInTransit:1});
 for(const [wh,onHand,reserved,free] of [[A,6,2,0],[B,10,0,1]]){
  set('warehouses',wh,{active:true});set('warehouseStocks',wh+'__'+key,
   {productKey:key,warehouseId:wh,onHand,reserved,transferFreeInTransit:free});
 }
 for(const [suffix,warehouseId,qty,expiryDate] of [['a-early',A,2,'2027-01-01'],['a-late',A,4,'2028-01-01'],['b',B,10,'2028-02-01']])
  set('inventoryLots',key+'-'+suffix,{productKey:key,warehouseId,remainingQty:qty,receivedQty:qty,
   lotNo:suffix,expiryDate,unitCost:98765,receivedAt:'2026-10-01T00:00:00Z'});
 await batch.commit();
 // Actual #136 reservation transaction, followed by an explicit test fixture
 // checkpoint for completed sync/dispatch. This is not UI dispatch acceptance.
 if(['sales','engineer'].includes(role))await db.collection('users').doc(uid).update({role:'warehouse'});
 await commitSingleItemTwoWarehouse(db,uid,{orderId,itemId:'I',warehouseIds:[A,B],attemptId:'reserve_'+name,
  syncAttemptId:'sync_ship_12345'});
 const fresh=(await db.collection('orders').doc(orderId).get()).data();
 fresh.items[0].dispatchPreparedQty=prepared;
 await db.collection('orders').doc(orderId).update({items:fresh.items,inventoryReservationStatus:'completed'});
 if(['sales','engineer'].includes(role))await db.collection('users').doc(uid).update({role});
 const request=(wh=A,quantity=2,operationId='shipment_'+name)=>({orderId,itemId:'I',warehouseId:wh,quantity,
  operationId,syncAttemptId:'sync_ship_12345',date:'2026-10-17',expectedPlan:plan});
 return {uid,orderId,key,request,
  read:async(n,k)=>(await db.collection(n).doc(k).get()).data(),
  call:(data=request(),actor=uid)=>commitLocationShipment(db,actor,data)};
}
async function snapshot(x){
 const refs=[['orders',x.orderId],['inventory',x.key],['warehouseStocks',A+'__'+x.key],
  ['warehouseStocks',B+'__'+x.key],['inventoryReservations',x.orderId+'__I'],
  ...['a-early','a-late','b'].map(s=>['inventoryLots',x.key+'-'+s])];
 const docs=[];for(const [n,k] of refs)docs.push(await x.read(n,k));
 const moves=await db.collection('inventoryMovements').where('sourceId','==',x.orderId).get();
 return {docs,movements:moves.docs.map(s=>s.data())};
}
test('single item ships from A, B, then A with real FEFO lots and other reservations preserved',async()=>{
 const x=await seed('partial');
 const bBefore=await x.read('warehouseStocks',B+'__'+x.key);
 const first=await x.call();assert.equal(first.reservedQty,8);
 assert.equal(first.lotAllocations.length,1);assert.equal(first.lotAllocations[0].lotId,x.key+'-a-early');
 assert.equal(first.lotAllocations[0].cost,0);assert.equal(first.lotAllocations[0].unitCost,0);
 assert.deepEqual(await x.read('warehouseStocks',B+'__'+x.key),bBefore);
 assert.equal((await x.read('inventoryLots',x.key+'-a-early')).remainingQty,0);
 assert.equal((await x.read('orders',x.orderId)).isDelivered,false);
 await x.call(x.request(B,6,'shipment_partial_B'));
 assert.deepEqual((await x.read('inventoryReservations',x.orderId+'__I')).locations,[{warehouseId:A,reservedQty:2}]);
 const last=await x.call(x.request(A,2,'shipment_partial_last'));
 assert.equal(last.reservedQty,0);assert.equal(last.grossShippedQty,10);
 const company=await x.read('inventory',x.key),a=await x.read('warehouseStocks',A+'__'+x.key),b=await x.read('warehouseStocks',B+'__'+x.key);
 assert.equal(company.onHand,6);assert.equal(company.reserved,2);assert.equal(company.transferFreeInTransit,1);
 assert.equal(a.onHand,2);assert.equal(a.reserved,2);assert.equal(b.onHand,4);assert.equal(b.reserved,0);
 const order=await x.read('orders',x.orderId);assert.equal(order.warehouseShipmentRecords.length,3);assert.equal(order.deliveredQty,0);
 assert.deepEqual(order.deliveryRecords,[]);assert.deepEqual(order.deliveryHistory,[]);
 assert.equal(order.items[0].warehouseShippedQty,10);assert.equal(order.items[0].dispatchPreparedQty,10);
 assert.equal(order.isDelivered,false);assert.equal((await x.read('inventoryReservations',x.orderId+'__I')).warehouseId,undefined);
});
test('same operation replays once and a changed identity or intent cannot reuse its movement',async()=>{
 const x=await seed('replay');await x.call();const baseline=await snapshot(x);
 assert.equal((await x.call()).status,'already-applied');assert.deepEqual(await snapshot(x),baseline);
 for(const change of [{quantity:3},{warehouseId:B},{notes:'changed'},{syncAttemptId:'new-sync'},
  {expectedPlan:{...plan,address:'new address'}}])await assert.rejects(x.call({...x.request(),...change}),/其他交易/);
 await db.collection('users').doc('ship-other').set({role:'admin',active:true});
 await assert.rejects(x.call(x.request(),'ship-other'),/其他交易/);
 await db.collection('orders').doc(x.orderId).update({status:'cancelled'});
 assert.equal((await x.call()).status,'already-applied');
 await db.collection('users').doc(x.uid).update({disabled:true});await assert.rejects(x.call(),/權限/);
});
test('three operational roles may ship; sales and engineer cannot impersonate a warehouse',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const x=await seed('role-'+role,{role});
  if(['sales','engineer'].includes(role)){
   const before=await snapshot(x);await assert.rejects(x.call(),/權限/);assert.deepEqual(await snapshot(x),before);
  }else assert.equal((await x.call()).status,'applied');
 }
});
test('concurrent identical attempts create one issue, movement, warehouse event and lot deduction',async()=>{
 const x=await seed('same-concurrent');
 const results=await Promise.all([x.call(),x.call()]);
 assert.deepEqual(results.map(r=>r.status).sort(),['already-applied','applied']);
 assert.equal((await x.read('inventory',x.key)).onHand,14);
 assert.equal((await x.read('orders',x.orderId)).warehouseShipmentRecords.length,1);
});
test('concurrent different attempts cannot consume more than selected warehouse own hold',async()=>{
 const x=await seed('different-concurrent');
 const results=await Promise.allSettled([x.call(x.request(A,3,'shipment_distinct_A')),x.call(x.request(A,3,'shipment_distinct_B'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await x.read('warehouseStocks',A+'__'+x.key)).onHand,3);
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I')).quantity,7);
 assert.equal((await x.read('orders',x.orderId)).warehouseShipmentRecords.length,1);
});
test('concurrent different warehouses preserve ledger and company totals under callback retries',async()=>{
 const x=await seed('two-concurrent');
 await Promise.all([x.call(x.request(A,4,'shipment_two_A')),x.call(x.request(B,6,'shipment_two_B'))]);
 assert.equal((await x.read('inventory',x.key)).reserved,2);
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I')).quantity,0);
 assert.equal((await x.read('orders',x.orderId)).warehouseShipmentRecords.length,2);
});
test('dispatch shortage and another warehouses hold cannot be borrowed even with available stock',async()=>{
 const prepared=await seed('prepared',{prepared:1});const before=await snapshot(prepared);
 await assert.rejects(prepared.call(),/打單可出貨/);assert.deepEqual(await snapshot(prepared),before);
 const x=await seed('wrong-hold');const state=await snapshot(x);
 await assert.rejects(x.call(x.request(A,5)),/指定倉庫.*不足/);assert.deepEqual(await snapshot(x),state);
});
test('stale sync, cancellation, service, transfer and changed shipping information all fail atomically',async()=>{
 const cases=[
  ['sync',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationAttemptId:'different-sync'})],
  ['pending',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'pending'})],
  ['cancelled',x=>db.collection('orders').doc(x.orderId).update({orderStatus:'cancelled'})],
  ['service',x=>db.collection('products').doc(x.key).update({productType:'SERVICE'})],
  ['custody',x=>db.collection('warehouses').doc(A).update({systemCustody:true})],
  ['disabled',x=>db.collection('warehouses').doc(A).update({active:false})],
  ['transfer',x=>db.collection('orders').doc(x.orderId).update({logisticsTransfersPending:1})],
  ['plan',async x=>{const order=await x.read('orders',x.orderId);order.items[0].deliveryPlan.address='new address';
    return db.collection('orders').doc(x.orderId).update({items:order.items});}],
  ['delivered-flag',x=>db.collection('orders').doc(x.orderId).update({isDelivered:true})],
  ['warehouse-projection',async x=>{const order=await x.read('orders',x.orderId);order.items[0].warehouseShippedQty=1;
    return db.collection('orders').doc(x.orderId).update({items:order.items});}],
  ['return',x=>db.collection('orders').doc(x.orderId).update({returnRecords:[{qty:1}]})],
  ['identity',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({ownerUid:'stranger'})],
  ['projection',async x=>{const order=await x.read('orders',x.orderId);order.items[0].reservedQty=9;
    return db.collection('orders').doc(x.orderId).update({items:order.items});}],
 ];
 for(const [name,mutate] of cases){const x=await seed('reject-'+name);await mutate(x);
  const before=await snapshot(x);await assert.rejects(x.call(),undefined,name);assert.deepEqual(await snapshot(x),before,name);}
});
test('missing or corrupt lots and stock overcommit reject without partial issue',async()=>{
 const cases=[
  ['lots-missing',async x=>{for(const s of ['a-early','a-late'])await db.collection('inventoryLots').doc(x.key+'-'+s).delete();}],
  ['lots-negative',x=>db.collection('inventoryLots').doc(x.key+'-a-early').update({remainingQty:-1})],
  ['lots-over',x=>db.collection('inventoryLots').doc(x.key+'-a-early').update({remainingQty:10,receivedQty:10})],
  ['company-over',x=>db.collection('inventory').doc(x.key).update({transferFreeInTransit:5})],
  ['stock-short',x=>db.collection('warehouseStocks').doc(A+'__'+x.key).update({reserved:3})],
 ];
 for(const [name,mutate] of cases){const x=await seed(name);await mutate(x);const before=await snapshot(x);
  await assert.rejects(x.call(),undefined,name);assert.deepEqual(await snapshot(x),before,name);}
});
test('bounded lot query rejects more than 200 candidates, including zero lots',async()=>{
 const x=await seed('lot-limit'),batch=db.batch();
 for(let i=0;i<199;i++)batch.set(db.collection('inventoryLots').doc(x.key+'-zero-'+i),
  {productKey:x.key,warehouseId:A,remainingQty:0,receivedQty:0});
 await batch.commit();const before=await snapshot(x);
 await assert.rejects(x.call(),/上限/);assert.deepEqual(await snapshot(x),before);
});
test('late transaction create failure rolls back stock, lots, ledger, order and movement',async()=>{
 const x=await seed('late-failure');
 const collision=db.collection('inventoryMovements').doc('ship-forced-collision');await collision.set({marker:true});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...a)=>tx.update(...a),set:(...a)=>tx.set(...a),
  create:(...a)=>{tx.create(collision,{marker:false});return tx.create(...a);}
 }))};
 const before=await snapshot(x);
 await assert.rejects(commitLocationShipment(wrapper,x.uid,x.request()));assert.deepEqual(await snapshot(x),before);
 assert.equal((await x.call()).status,'applied');
});
