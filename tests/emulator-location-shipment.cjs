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

// The next stage confirms customer receipt of an already-debited shipment.
const {commitShipmentDelivery}=require('../functions/shipment-delivery-service');
async function acknowledgementFixture(name,{role='sales',shipQty=2}={}){
 const x=await seed('confirm-'+name,{role});
 const shippingUid='shipping-operator-'+name;
 await db.collection('users').doc(shippingUid).set({role:'warehouse',active:true});
 const shipmentRequest=x.request(A,shipQty,'shipment_confirm_'+name);
 if(shipQty)await x.call(shipmentRequest,shippingUid);
 const request=(quantity=1,operationId='delivery_confirm_'+name,shipmentId=shipmentRequest.operationId)=>({
  orderId:x.orderId,itemId:'I',shipmentId,quantity,operationId,syncAttemptId:'sync_ship_12345',date:'2026-10-18'});
 return {...x,shippingUid,shipmentRequest,deliveryRequest:request,
  confirm:(data=request(),actor=x.uid,connection=db)=>commitShipmentDelivery(connection,actor,data),
  ship:(wh,qty,operationId)=>x.call(x.request(wh,qty,operationId),shippingUid)};
}
async function physicalSnapshot(x){const state=await snapshot(x);return {docs:state.docs.slice(1),movements:state.movements};}
async function confirmWithoutStockChange(x,request){
 const before=await physicalSnapshot(x),result=await x.confirm(request);
 assert.deepEqual(await physicalSnapshot(x),before);return result;
}
test('real reserve -> A shipment -> partial delivery -> B shipment -> final A shipment debits physical stock only on shipment',async()=>{
 const x=await acknowledgementFixture('interleave');
 let r=await confirmWithoutStockChange(x,x.deliveryRequest());assert.equal(r.confirmedQty,1);assert.equal(r.isDelivered,false);
 await x.ship(B,6,'shipment_interleave_B');
 r=await confirmWithoutStockChange(x,x.deliveryRequest(6,'delivery_interleave_B','shipment_interleave_B'));
 assert.equal(r.confirmedQty,7);assert.equal(r.pendingDeliveryQty,1);assert.equal(r.isDelivered,false);
 r=await confirmWithoutStockChange(x,x.deliveryRequest(1,'delivery_interleave_A_rest'));
 assert.equal(r.confirmedQty,8);assert.equal(r.pendingDeliveryQty,0);assert.equal(r.isDelivered,false);
 await x.ship(A,2,'shipment_interleave_A_last');
 r=await confirmWithoutStockChange(x,x.deliveryRequest(2,'delivery_interleave_last','shipment_interleave_A_last'));
 assert.equal(r.confirmedQty,10);assert.equal(r.pendingDeliveryQty,0);assert.equal(r.isDelivered,true);
 const order=await x.read('orders',x.orderId);
 assert.equal(order.warehouseShipmentRecords.length,3);assert.equal(order.deliveryRecords.length,4);
 assert.equal(order.deliveredQty,10);assert.equal(order.items[0].deliveredQty,10);
 assert.equal(order.items[0].warehouseShippedQty,10);assert.equal(order.items[0].reservedQty,0);
 assert.equal((await x.read('inventory',x.key)).onHand,6);assert.equal((await x.read('inventory',x.key)).reserved,2);
});
test('customer acknowledgement reads only actor, order and immutable shipment movement; writes only order',async()=>{
 const x=await acknowledgementFixture('bounded');let reads=0,writes=0;
 const guarded={projectId:db.projectId,collection:name=>{
  assert.ok(['users','orders','inventoryMovements'].includes(name),'unexpected stock/cost read '+name);
  return db.collection(name);
 },runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>{reads++;return tx.get(r);},
  update:(r,v)=>{assert.ok(r.path.startsWith('orders/'));writes++;return tx.update(r,v);}
 }))};
 const before=await physicalSnapshot(x);assert.equal((await x.confirm(x.deliveryRequest(),x.uid,guarded)).status,'applied');
 assert.equal(reads,3);assert.equal(writes,1);assert.deepEqual(await physicalSnapshot(x),before);
});
test('acknowledgement replay preserves original result and rejects modified intent or a different actor',async()=>{
 const x=await acknowledgementFixture('replay');await x.confirm();const first=await snapshot(x);
 assert.equal((await x.confirm()).status,'already-applied');assert.deepEqual(await snapshot(x),first);
 for(const patch of [{quantity:2},{shipmentId:'other'},{date:'2026-10-19'},{notes:'changed'},{syncAttemptId:'new-sync'}])
  await assert.rejects(x.confirm({...x.deliveryRequest(),...patch}),/其他交易/);
 await db.collection('users').doc('other-confirm-admin').set({role:'admin',active:true});
 await assert.rejects(x.confirm(x.deliveryRequest(),'other-confirm-admin'),/其他交易/);
 await db.collection('orders').doc(x.orderId).update({status:'cancelled'});
 assert.equal((await x.confirm()).status,'already-applied');
 await db.collection('users').doc(x.uid).update({active:false});await assert.rejects(x.confirm(),/權限/);
});
test('five-role acknowledgement contract permits admin or owner sales/engineer, not purchasing/warehouse or strangers',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await acknowledgementFixture('role-'+role,{role});
  if(['purchaser','warehouse'].includes(role)){
   const before=await snapshot(x);await assert.rejects(x.confirm(),/權限/);assert.deepEqual(await snapshot(x),before);
  }else assert.equal((await x.confirm()).status,'applied');
 }
 const x=await acknowledgementFixture('stranger');
 for(const role of ['sales','engineer']){
  const uid='stranger-confirm-'+role;await db.collection('users').doc(uid).set({role,active:true});
  await assert.rejects(x.confirm(x.deliveryRequest(),uid),/自己訂單/);
 }
});
test('simultaneous identical acknowledgements create exactly one record and no new movement',async()=>{
 const x=await acknowledgementFixture('same-concurrent'),before=await physicalSnapshot(x);
 const results=await Promise.all([x.confirm(),x.confirm()]);
 assert.deepEqual(results.map(r=>r.status).sort(),['already-applied','applied']);
 const order=await x.read('orders',x.orderId);assert.equal(order.deliveryRecords.length,1);assert.equal(order.deliveredQty,1);
 assert.deepEqual(await physicalSnapshot(x),before);
});
test('simultaneous different acknowledgements cannot exceed one source shipment',async()=>{
 const x=await acknowledgementFixture('different-concurrent'),before=await physicalSnapshot(x);
 const results=await Promise.allSettled([x.confirm(x.deliveryRequest(2,'delivery_compete_A')),
  x.confirm(x.deliveryRequest(2,'delivery_compete_B'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await x.read('orders',x.orderId)).deliveredQty,2);assert.deepEqual(await physicalSnapshot(x),before);
});
test('unshipped, over-confirmed, backdated and mismatched proof operations fail atomically',async()=>{
 const empty=await acknowledgementFixture('empty',{shipQty:0}),baseline=await snapshot(empty);
 await assert.rejects(empty.confirm());assert.deepEqual(await snapshot(empty),baseline);
 const x=await acknowledgementFixture('limits'),before=await snapshot(x);
 await assert.rejects(x.confirm(x.deliveryRequest(3)),/超過/);
 await assert.rejects(x.confirm({...x.deliveryRequest(),date:'2026-10-16'}),/日期/);
 await assert.rejects(x.confirm({...x.deliveryRequest(),shipmentId:'unshipped'}),/不存在/);
 assert.deepEqual(await snapshot(x),before);
 const cases=[
  ['cancel',y=>db.collection('orders').doc(y.orderId).update({orderStatus:'cancelled'})],
  ['sync',y=>db.collection('orders').doc(y.orderId).update({inventoryReservationAttemptId:'other-sync'})],
  ['pending',y=>db.collection('orders').doc(y.orderId).update({inventoryReservationStatus:'pending'})],
  ['return',y=>db.collection('orders').doc(y.orderId).update({returnRecords:[{qty:1}]})],
  ['projection',y=>db.collection('orders').doc(y.orderId).update({deliveredQty:1})],
  ['missing-proof',y=>db.collection('inventoryMovements').doc('location-ship-'+y.shipmentRequest.operationId).delete()],
  ['wrong-proof',y=>db.collection('inventoryMovements').doc('location-ship-'+y.shipmentRequest.operationId).update({qty:-99})],
  ['recipient',async y=>{const order=await y.read('orders',y.orderId);order.warehouseShipmentRecords[0].deliveryPlan.address='forged';
   return db.collection('orders').doc(y.orderId).update({warehouseShipmentRecords:order.warehouseShipmentRecords});}],
  ['legacy',y=>db.collection('orders').doc(y.orderId).update({deliveryRecords:[{id:'legacy',qty:1,sourceType:'INVENTORY_SHIPMENT'}]})],
 ];
 for(const [name,mutate] of cases){const y=await acknowledgementFixture('reject-'+name);await mutate(y);
  const snapshotBefore=await snapshot(y);await assert.rejects(y.confirm(),undefined,name);
  assert.deepEqual(await snapshot(y),snapshotBefore,name);}
});
test('late acknowledgement write failure rolls back the event and retains same-ID retry without touching stock',async()=>{
 const x=await acknowledgementFixture('late-failure'),collision=db.collection('inventoryMovements').doc('confirm-forced-collision');
 await collision.set({marker:true});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...args)=>{tx.update(...args);tx.create(collision,{marker:false});}
 }))};
 const before=await snapshot(x);await assert.rejects(x.confirm(x.deliveryRequest(),x.uid,wrapper));
 assert.deepEqual(await snapshot(x),before);assert.equal((await x.confirm()).status,'applied');
});
