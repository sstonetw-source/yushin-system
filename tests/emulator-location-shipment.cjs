'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore');
const {commitSingleItemTwoWarehouse}=require('../functions/single-item-location-service');
const {commitLocationShipment}=require('../functions/location-shipment-service');
const {commitLocationDispatchPreparation}=require('../functions/location-dispatch-service');
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
 // Initial reservation is real; final sync checkpoint remains an isolated
 // fixture write until full order-initialization integration is available.
 if(['sales','engineer'].includes(role))await db.collection('users').doc(uid).update({role:'warehouse'});
 await commitSingleItemTwoWarehouse(db,uid,{orderId,itemId:'I',warehouseIds:[A,B],attemptId:'reserve_'+name,
  syncAttemptId:'sync_ship_12345'});
 await db.collection('orders').doc(orderId).update({inventoryReservationStatus:'completed'});
 if(prepared>0)await commitLocationDispatchPreparation(db,uid,{orderId,itemId:'I',quantity:prepared,
  operationId:'prepare_'+name,syncAttemptId:'sync_ship_12345'});
 if(['sales','engineer'].includes(role))await db.collection('users').doc(uid).update({role});
 const request=(wh=A,quantity=2,operationId='shipment_'+name)=>({orderId,itemId:'I',warehouseId:wh,quantity,
  operationId,syncAttemptId:'sync_ship_12345',date:'2026-10-17',expectedPlan:plan});
 return {uid,orderId,key,request,
  read:async(n,k)=>(await db.collection(n).doc(k).get()).data(),
  call:(data=request(),actor=uid)=>commitLocationShipment(db,actor,data),
  prepare:(quantity,operationId='prepare_more_'+name,actor=uid)=>commitLocationDispatchPreparation(db,actor,{
    orderId,itemId:'I',quantity,operationId,syncAttemptId:'sync_ship_12345'})};
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

test('removed or reversed acknowledgement cannot be resurrected by retrying its original operation ID',async()=>{
 const x=await acknowledgementFixture('reversed-retry');await x.confirm();
 const order=await x.read('orders',x.orderId);
 const restoredItems=order.items.map(row=>({...row,deliveredQty:0}));
 // Simulate a future acknowledged reversal checkpoint, without claiming a
 // reversal Service/UI is already implemented or accepted in this batch.
 await db.collection('orders').doc(x.orderId).update({deliveryRecords:[],deliveredQty:0,isDelivered:false,
  items:restoredItems,deliveryHistory:[...order.deliveryHistory,
   {action:'delete',recordId:x.deliveryRequest().operationId,by:'admin',at:'2026-10-18T12:00:00Z'}]});
 const before=await snapshot(x);
 await assert.rejects(x.confirm(),/歷史紀錄/);assert.deepEqual(await snapshot(x),before);
 assert.equal((await x.confirm(x.deliveryRequest(1,'delivery_reversed_new'))).status,'applied');
});

const {reverseShipmentDelivery}=require('../functions/shipment-delivery-service');
const {planLocationReturnTrace}=require('../functions/location-return-trace-service');
async function correctionFixture(name,{role='sales',shipQty=2,confirmedQty=1}={}){
 const x=await acknowledgementFixture('correction-'+name,{role,shipQty});
 const adminUid='correction-admin-'+name;await db.collection('users').doc(adminUid).set({role:'admin',active:true});
 const deliveryRequest=x.deliveryRequest(confirmedQty);
 if(confirmedQty)await x.confirm(deliveryRequest,adminUid);
 const reverseRequest=(patch={})=>({orderId:x.orderId,itemId:'I',deliveryRecordId:deliveryRequest.operationId,
  operationId:'reverse_'+name,syncAttemptId:'sync_ship_12345',date:'2026-10-19',reason:'誤登送達',...patch});
 const traceRequest=(selections=[{lotId:x.key+'-a-early',qty:1}])=>({orderId:x.orderId,itemId:'I',
  shipmentId:x.shipmentRequest.operationId,syncAttemptId:'sync_ship_12345',selections});
 return {...x,adminUid,originalDelivery:deliveryRequest,reverseRequest,traceRequest,
  reverse:(data=reverseRequest(),actor=x.uid,connection=db)=>reverseShipmentDelivery(connection,actor,data),
  trace:(data=traceRequest(),actor=x.uid,connection=db)=>planLocationReturnTrace(connection,actor,data)};
}
test('actual acknowledgement reversal changes only delivery facts and old acknowledgement ID cannot resurrect them',async()=>{
 const x=await correctionFixture('actual-reversal'),physical=await physicalSnapshot(x);
 const result=await x.reverse();assert.equal(result.reversedQty,1);assert.equal(result.confirmedQty,0);
 assert.equal(result.pendingDeliveryQty,2);assert.equal(result.isDelivered,false);
 assert.deepEqual(await physicalSnapshot(x),physical);
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.deliveryRecords,[]);
 assert.equal(order.items[0].deliveredQty,0);assert.equal(order.items[0].warehouseShippedQty,2);
 assert.equal(order.items[0].reservedQty,8);
 const event=order.deliveryHistory.at(-1);assert.equal(event.action,'delete');assert.equal(event.before.qty,1);
 assert.equal(event.actorUid,x.uid);assert.equal(event.reason,'誤登送達');
 await assert.rejects(x.confirm(x.originalDelivery,x.adminUid),/歷史紀錄/);
 const before=await snapshot(x);assert.equal((await x.reverse()).status,'already-applied');assert.deepEqual(await snapshot(x),before);
});
test('reversal after all goods arrive reopens acknowledgement only; it neither restocks nor creates a new shippable hold',async()=>{
 const x=await correctionFixture('full-reversal',{shipQty:4,confirmedQty:4});
 await x.ship(B,6,'shipment_full_reverse_B');
 await x.confirm(x.deliveryRequest(6,'delivery_full_reverse_B','shipment_full_reverse_B'),x.adminUid);
 assert.equal((await x.read('orders',x.orderId)).isDelivered,true);
 const physical=await physicalSnapshot(x);const result=await x.reverse();
 assert.equal(result.confirmedQty,6);assert.equal(result.pendingDeliveryQty,4);assert.equal(result.isDelivered,false);
 assert.deepEqual(await physicalSnapshot(x),physical);await assert.rejects(x.ship(A,1,'shipment_after_full_reverse'));
 assert.deepEqual(await physicalSnapshot(x),physical);
});
test('same reversal returns original result after a new legitimate acknowledgement without overwriting current totals',async()=>{
 const x=await correctionFixture('replay-correction');await x.reverse();
 await x.confirm(x.deliveryRequest(1,'delivery_after_correction'),x.adminUid);
 const before=await snapshot(x),result=await x.reverse();assert.equal(result.status,'already-applied');
 assert.equal(result.confirmedQty,0);assert.equal((await x.read('orders',x.orderId)).deliveredQty,1);
 assert.deepEqual(await snapshot(x),before);
 for(const patch of [{reason:'另一原因'},{date:'2026-10-20'},{deliveryRecordId:'different'},{syncAttemptId:'changed'}])
  await assert.rejects(x.reverse(x.reverseRequest(patch)),/其他交易/);
 await assert.rejects(x.reverse(x.reverseRequest(),x.adminUid),/其他交易/);
 await assert.rejects(x.confirm({...x.deliveryRequest(1,x.reverseRequest().operationId)},x.adminUid),/歷史紀錄/);
});
test('simultaneous same or different reversal IDs never remove an acknowledgement twice',async()=>{
 for(const same of [true,false]){
  const x=await correctionFixture('concurrent-reverse-'+same),physical=await physicalSnapshot(x);
  const results=await Promise.allSettled([x.reverse(),x.reverse(x.reverseRequest(same?{}:{operationId:'reverse_other_'+same}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,same?2:1);
  const order=await x.read('orders',x.orderId);assert.equal(order.deliveryRecords.length,0);assert.equal(order.deliveredQty,0);
  assert.equal(order.deliveryHistory.filter(h=>h.source==='shipment_confirmation_reversal').length,1);
  assert.deepEqual(await physicalSnapshot(x),physical);
 }
});
test('reversal uses business roles while read-only trace lets operational roles inspect original lots',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await correctionFixture('correction-role-'+role,{role});
  const before=await snapshot(x);assert.equal((await x.trace()).status,'read-only');assert.deepEqual(await snapshot(x),before);
  if(['purchaser','warehouse'].includes(role)){await assert.rejects(x.reverse(),/權限/);assert.deepEqual(await snapshot(x),before);}
  else assert.equal((await x.reverse()).status,'applied');
 }
 const x=await correctionFixture('correction-stranger');
 await db.collection('users').doc('correction-stranger-user').set({role:'sales',active:true});
 await assert.rejects(x.reverse(x.reverseRequest(),'correction-stranger-user'),/自己訂單/);
 await assert.rejects(x.trace(x.traceRequest(),'correction-stranger-user'),/自己訂單/);
});
test('explicit return trace of a mixed-lot partial delivery is read-only, bounded and does not leak costs',async()=>{
 const x=await correctionFixture('mixed-trace',{shipQty:4,confirmedQty:2}),before=await snapshot(x);
 const request=x.traceRequest([{lotId:x.key+'-a-late',qty:1},{lotId:x.key+'-a-early',qty:1}]);
 let reads=0;
 const guarded={projectId:db.projectId,collection:n=>{
  assert.ok(['users','orders','inventoryMovements','inventoryLots'].includes(n));return db.collection(n);
 },runTransaction:fn=>db.runTransaction(tx=>fn({get:r=>{reads++;return tx.get(r);}}))};
 const result=await x.trace(request,x.uid,guarded);assert.equal(result.canCommit,false);assert.equal(result.returnQty,2);
 assert.equal(reads,5);assert.deepEqual(result.allocations.map(a=>a.lotNo),['a-late','a-early']);
 assert.equal(JSON.stringify(result).includes('98765'),false);assert.deepEqual(await snapshot(x),before);
 assert.deepEqual(await x.trace(request),result);assert.deepEqual(await snapshot(x),before);
 assert.equal((await x.read('inventoryLots',x.key+'-a-early')).remainingQty,0);
});
test('return trace rejects unconfirmed quantities, wrong original batch and altered physical lot data',async()=>{
 const empty=await correctionFixture('unconfirmed-trace',{confirmedQty:0});const emptyBefore=await snapshot(empty);
 await assert.rejects(empty.trace(),/超過/);assert.deepEqual(await snapshot(empty),emptyBefore);
 const x=await correctionFixture('trace-limits',{shipQty:4,confirmedQty:1}),before=await snapshot(x);
 await assert.rejects(x.trace(x.traceRequest([{lotId:x.key+'-a-early',qty:2}])),/超過/);
 await assert.rejects(x.trace(x.traceRequest([{lotId:x.key+'-b',qty:1}])),/原出貨/);
 assert.deepEqual(await snapshot(x),before);
 const cases=[
  ['missing',y=>db.collection('inventoryLots').doc(y.key+'-a-early').delete()],
  ['warehouse',y=>db.collection('inventoryLots').doc(y.key+'-a-early').update({warehouseId:B})],
  ['product',y=>db.collection('inventoryLots').doc(y.key+'-a-early').update({productKey:'OTHER'})],
  ['batch',y=>db.collection('inventoryLots').doc(y.key+'-a-early').update({lotNo:'another-lot'})],
  ['negative',y=>db.collection('inventoryLots').doc(y.key+'-a-early').update({remainingQty:-1})],
  ['over-restoration',y=>db.collection('inventoryLots').doc(y.key+'-a-early').update({remainingQty:2})],
 ];
 for(const [name,mutate] of cases){const y=await correctionFixture('trace-'+name);await mutate(y);
  const state=await snapshot(y);await assert.rejects(y.trace(),undefined,name);assert.deepEqual(await snapshot(y),state,name);}
});
test('reversal and trace reject stale, cancelled, returned or falsified evidence with no partial writes',async()=>{
 const cases=[
  ['cancel',x=>db.collection('orders').doc(x.orderId).update({status:'cancelled'})],
  ['sync',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationAttemptId:'new-sync'})],
  ['returns',x=>db.collection('orders').doc(x.orderId).update({returnRecords:[{qty:1}]})],
  ['projection',x=>db.collection('orders').doc(x.orderId).update({deliveredQty:2})],
  ['proof',x=>db.collection('inventoryMovements').doc('location-ship-'+x.shipmentRequest.operationId).update({qty:-99})],
  ['disabled',x=>db.collection('users').doc(x.uid).update({disabled:true})],
 ];
 for(const [name,mutate] of cases){const x=await correctionFixture('correction-reject-'+name);await mutate(x);
  const before=await snapshot(x);await assert.rejects(x.reverse());await assert.rejects(x.trace());assert.deepEqual(await snapshot(x),before,name);}
 const x=await correctionFixture('reverse-date'),before=await snapshot(x);
 await assert.rejects(x.reverse(x.reverseRequest({date:'2026-10-17'})),/日期/);assert.deepEqual(await snapshot(x),before);
});
test('failed reversal update rolls back only the attempted correction and permits original-ID retry',async()=>{
 const x=await correctionFixture('reverse-failure'),collision=db.collection('inventoryMovements').doc('reversal-forced-collision');
 await collision.set({marker:true});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...args)=>{tx.update(...args);tx.create(collision,{marker:false});}
 }))};
 const before=await snapshot(x);await assert.rejects(x.reverse(x.reverseRequest(),x.uid,wrapper));
 assert.deepEqual(await snapshot(x),before);assert.equal((await x.reverse()).status,'applied');
});

const {commitLocationReturn}=require('../functions/location-return-service');
async function returnFixture(name,options={}){
 const x=await correctionFixture('receipt-'+name,{shipQty:4,confirmedQty:2,...options});
 const request=(patch={})=>({...x.traceRequest([{lotId:x.key+'-a-early',qty:1}]),
  operationId:'return_receipt_'+name,warehouseId:A,date:'2026-10-19',reason:'客戶退回可再入庫品',
  condition:'RESTOCKABLE',settlement:'REPLACE',...patch});
 return {...x,returnRequest:request,
  receive:(data=request(),actor=x.uid,connection=db)=>commitLocationReturn(connection,actor,data)};
}
test('physical replacement return restores company, source warehouse, exact lot and source hold atomically',async()=>{
 const x=await returnFixture('replace'),before=await snapshot(x),b=await x.read('warehouseStocks',B+'__'+x.key);
 const result=await x.receive();assert.equal(result.qty,1);assert.equal(result.reservedQty,7);assert.equal(result.replacementQty,1);
 const order=await x.read('orders',x.orderId),ledger=await x.read('inventoryReservations',x.orderId+'__I');
 assert.equal(order.deliveredQty,2);assert.equal(order.items[0].warehouseShippedQty,4);assert.equal(order.returnedQty,1);
 assert.equal(order.items[0].returnedQty,1);assert.equal(order.items[0].reservedQty,7);assert.equal(order.isDelivered,false);
 assert.deepEqual(order.deliveryRecords,before.docs[0].deliveryRecords);
 assert.deepEqual(order.warehouseShipmentRecords,before.docs[0].warehouseShipmentRecords);
 assert.deepEqual(ledger.locations,[{warehouseId:A,reservedQty:1},{warehouseId:B,reservedQty:6}]);
 assert.equal((await x.read('inventory',x.key)).onHand,13);assert.equal((await x.read('inventory',x.key)).reserved,9);
 assert.equal((await x.read('warehouseStocks',A+'__'+x.key)).onHand,3);
 assert.equal((await x.read('warehouseStocks',A+'__'+x.key)).reserved,3);
 assert.equal((await x.read('inventoryLots',x.key+'-a-early')).remainingQty,1);
 assert.deepEqual(await x.read('warehouseStocks',B+'__'+x.key),b);
 const move=await x.read('inventoryMovements',result.movementId);assert.equal(move.qty,1);assert.equal(move.reservedDelta,1);
 assert.deepEqual(move.returnRecord,order.returnRecords[0]);assert.equal(move.costPending,true);
 assert.equal(JSON.stringify(result).includes('98765'),false);
 // Adapters for replacement dispatch are not yet migrated: fail closed rather
 // than allowing a legacy transaction to debit this v2 return twice.
 await assert.rejects(x.ship(A,1,'shipment_after_receipt_replace'),/退貨或補送/);
 await assert.rejects(x.reverse(),/退貨或補送/);
 await assert.rejects(x.confirm(x.deliveryRequest(1,'delivery_after_receipt')),/退貨或補送/);
});
test('closed physical return creates free stock and preserves completed commercial delivery',async()=>{
 const x=await returnFixture('close',{confirmedQty:4});
 await x.ship(B,6,'shipment_receipt_close_B');
 await x.confirm(x.deliveryRequest(6,'delivery_receipt_close_B','shipment_receipt_close_B'),x.adminUid);
 const b=await x.read('warehouseStocks',B+'__'+x.key),result=await x.receive(x.returnRequest({settlement:'CLOSE'}));
 assert.equal(result.isDelivered,true);assert.equal(result.effectiveDeliveredQty,10);assert.equal(result.closedQty,1);
 assert.equal(result.replacementQty,0);assert.equal(result.reservedQty,0);
 const ledger=await x.read('inventoryReservations',x.orderId+'__I');assert.equal(ledger.status,'fulfilled');assert.deepEqual(ledger.locations,[]);
 assert.equal((await x.read('inventory',x.key)).reserved,2);assert.equal((await x.read('inventory',x.key)).onHand,7);
 assert.equal((await x.read('orders',x.orderId)).deliveredQty,10);
 assert.deepEqual(await x.read('warehouseStocks',B+'__'+x.key),b);
});
test('successive explicit returns consume remaining source batch and delivered allowance across settlements',async()=>{
 const x=await returnFixture('partial');
 await x.receive();const first=await snapshot(x);
 await assert.rejects(x.receive(x.returnRequest({operationId:'return_receipt_partial_over',selections:[{lotId:x.key+'-a-early',qty:2}]})));
 assert.deepEqual(await snapshot(x),first);
 const second=await x.receive(x.returnRequest({operationId:'return_receipt_partial_late',settlement:'CLOSE',selections:[{lotId:x.key+'-a-late',qty:1}]}));
 assert.equal(second.returnedQty,2);assert.equal(second.replacementQty,1);assert.equal(second.closedQty,1);assert.equal(second.effectiveDeliveredQty,1);
 assert.equal((await x.read('inventory',x.key)).onHand,14);assert.equal((await x.read('inventory',x.key)).reserved,9);
 const state=await snapshot(x);await assert.rejects(x.receive(x.returnRequest({operationId:'return_receipt_partial_excess'})),/超過/);
 assert.deepEqual(await snapshot(x),state);
});
test('receipt replays original result without restoring stock again and binds actor and intent',async()=>{
 const x=await returnFixture('replay');await x.receive();const before=await snapshot(x);
 assert.equal((await x.receive()).status,'already-applied');assert.deepEqual(await snapshot(x),before);
 for(const patch of [{settlement:'CLOSE'},{warehouseId:B},{reason:'不同原因'},{date:'2026-10-20'},
  {selections:[{lotId:x.key+'-a-late',qty:1}]},{syncAttemptId:'changed'}])
  await assert.rejects(x.receive(x.returnRequest(patch)),/其他交易/);
 await assert.rejects(x.receive(x.returnRequest(),x.adminUid),/其他交易/);
 await db.collection('orders').doc(x.orderId).update({status:'cancelled'});
 assert.equal((await x.receive()).status,'already-applied');
 await db.collection('users').doc(x.uid).update({disabled:true});await assert.rejects(x.receive(),/權限/);
});
test('same and competing physical return attempts cannot restore more than confirmed goods',async()=>{
 for(const same of [true,false]){
  const x=await returnFixture('race-'+same,{confirmedQty:1});
  const results=await Promise.allSettled([x.receive(),x.receive(x.returnRequest(same?{}:{operationId:'return_receipt_compete'}))]);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,same?2:1);
  assert.equal((await x.read('orders',x.orderId)).returnRecords.length,1);
  assert.equal((await x.read('inventoryLots',x.key+'-a-early')).remainingQty,1);
  assert.equal((await x.read('inventory',x.key)).onHand,13);
 }
});
test('return lifecycle authority follows admin and own business roles with no caller role override',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await returnFixture('role-'+role,{role}),before=await snapshot(x);
  if(['purchaser','warehouse'].includes(role)){await assert.rejects(x.receive(),/權限/);assert.deepEqual(await snapshot(x),before);}
  else assert.equal((await x.receive()).status,'applied');
 }
 const x=await returnFixture('owner');await db.collection('users').doc('return-stranger').set({role:'sales',active:true});
 const before=await snapshot(x);await assert.rejects(x.receive(x.returnRequest(),'return-stranger'),/自己訂單/);
 await assert.rejects(x.receive(x.returnRequest({actorRole:'admin'})),/未授權/);assert.deepEqual(await snapshot(x),before);
});
test('physical return rejects stale sources, corrupt ledgers, batch balances and wrong receipt decisions with no writes',async()=>{
 const cases=[
  ['cancel',x=>db.collection('orders').doc(x.orderId).update({status:'cancelled'})],
  ['pending',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationStatus:'pending'})],
  ['sync',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationAttemptId:'changed'})],
  ['service',async x=>{const o=await x.read('orders',x.orderId);o.items[0].productType='SERVICE';await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['proof',x=>db.collection('inventoryMovements').doc('location-ship-'+x.shipmentRequest.operationId).delete()],
  ['company',x=>db.collection('inventory').doc(x.key).update({reserved:1})],
  ['ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({quantity:5})],
  ['owner',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({ownerUid:'another'})],
  ['warehouse-holds',x=>db.collection('warehouseStocks').doc(A+'__'+x.key).update({reserved:4})],
  ['batch-gap',x=>db.collection('inventoryLots').doc(x.key+'-a-late').update({remainingQty:1})],
  ['batch-missing',x=>db.collection('inventoryLots').doc(x.key+'-a-early').delete()],
  ['batch-label',x=>db.collection('inventoryLots').doc(x.key+'-a-early').update({lotNo:'changed'})],
  ['batch-negative',x=>db.collection('inventoryLots').doc(x.key+'-a-late').update({remainingQty:-1})],
  ['batch-bound',async x=>{const batch=db.batch();for(let i=0;i<199;i++)batch.set(db.collection('inventoryLots').doc(x.key+'-empty-'+i),
   {productKey:x.key,warehouseId:A,remainingQty:0,receivedQty:0});await batch.commit();}],
 ];
 for(const [name,mutate] of cases){const x=await returnFixture('reject-'+name);await mutate(x);const before=await snapshot(x);
  await assert.rejects(x.receive(),undefined,name);assert.deepEqual(await snapshot(x),before,name);}
 const x=await returnFixture('decisions'),before=await snapshot(x);
 for(const patch of [{warehouseId:B},{date:'2026-10-17'},{condition:'DAMAGED'},
  {selections:[{lotId:x.key+'-b',qty:1}]},{selections:[{lotId:x.key+'-a-early',qty:3}]}])await assert.rejects(x.receive(x.returnRequest(patch)));
 assert.deepEqual(await snapshot(x),before);
});
test('existing return receipt proof and cached counts cannot be forged to regain a source allowance',async()=>{
 for(const kind of ['proof','cache','record']){
  const x=await returnFixture('proof-'+kind);const first=await x.receive();
  if(kind==='proof')await db.collection('inventoryMovements').doc(first.movementId).delete();
  else if(kind==='cache')await db.collection('orders').doc(x.orderId).update({returnedQty:0});
  else{const o=await x.read('orders',x.orderId);o.returnRecords[0].reason='改寫';await db.collection('orders').doc(x.orderId).update({returnRecords:o.returnRecords});}
  const before=await snapshot(x);
  await assert.rejects(x.receive(x.returnRequest({operationId:'return_receipt_proof_next',selections:[{lotId:x.key+'-a-late',qty:1}]})));
  assert.deepEqual(await snapshot(x),before);
 }
});
test('late receipt movement failure rolls back stock, lot, reservation, order and receipt; same ID retries safely',async()=>{
 const x=await returnFixture('rollback'),collision=db.collection('inventoryMovements').doc('return-forced-collision');await collision.set({marker:true});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...args)=>tx.update(...args),set:(...args)=>tx.set(...args),
  create:(...args)=>{tx.create(...args);tx.create(collision,{marker:false});}
 }))};
 const before=await snapshot(x);await assert.rejects(x.receive(x.returnRequest(),x.uid,wrapper));assert.deepEqual(await snapshot(x),before);
 assert.equal((await x.receive()).status,'applied');
});
test('full replacement return reopens a fulfilled v2 ledger in its original warehouse',async()=>{
 const x=await returnFixture('fulfilled-replace',{confirmedQty:4});
 await x.ship(B,6,'shipment_receipt_full_replace_B');
 await x.confirm(x.deliveryRequest(6,'delivery_receipt_full_replace_B','shipment_receipt_full_replace_B'),x.adminUid);
 const result=await x.receive(x.returnRequest());assert.equal(result.isDelivered,false);assert.equal(result.effectiveDeliveredQty,9);
 const ledger=await x.read('inventoryReservations',x.orderId+'__I');assert.equal(ledger.status,'active');assert.equal(ledger.quantity,1);
 assert.deepEqual(ledger.locations,[{warehouseId:A,reservedQty:1}]);
 assert.equal((await x.read('warehouseStocks',B+'__'+x.key)).reserved,0);
});
test('unconfirmed goods cannot be returned and physical receipt reads bounded candidates without a cost collection',async()=>{
 const empty=await returnFixture('unconfirmed',{confirmedQty:0}),before=await snapshot(empty);
 await assert.rejects(empty.receive(),/超過/);assert.deepEqual(await snapshot(empty),before);
 const x=await returnFixture('bounded');let reads=0,writes=0;
 const allowed=['users','orders','inventoryMovements','inventory','warehouseStocks','inventoryReservations','warehouses','inventoryLots'];
 const guarded={projectId:db.projectId,collection:n=>{assert.ok(allowed.includes(n));return db.collection(n);},
  runTransaction:fn=>db.runTransaction(tx=>fn({
   get:r=>{reads++;return tx.get(r);},update:(...args)=>{writes++;return tx.update(...args);},
   set:(...args)=>{writes++;return tx.set(...args);},create:(...args)=>{writes++;return tx.create(...args);}
  }))};
 assert.equal((await x.receive(x.returnRequest(),x.uid,guarded)).status,'applied');assert.equal(reads,10);assert.equal(writes,6);
});
test('removing a closed return from order caches cannot conceal its immutable physical receipt',async()=>{
 const x=await returnFixture('deleted-close');await x.receive(x.returnRequest({settlement:'CLOSE'}));
 const o=await x.read('orders',x.orderId);o.items[0].returnedQty=0;
 await db.collection('orders').doc(x.orderId).update({returnRecords:[],returnedQty:0,items:o.items});
 const before=await snapshot(x);
 await assert.rejects(x.receive(x.returnRequest({operationId:'return_receipt_hidden_next'})),/憑證數量/);
 assert.deepEqual(await snapshot(x),before);
});
test('new wrong-item return defaults to closed free stock and never recreates an original-order hold',async()=>{
 const x=await returnFixture('default-close'),result=await x.receive(x.returnRequest({settlement:undefined}));
 assert.equal(result.settlement,'CLOSE');assert.equal(result.reservedQty,6);assert.equal(result.replacementQty,0);
 const ledger=await x.read('inventoryReservations',x.orderId+'__I');assert.deepEqual(ledger.locations,[{warehouseId:B,reservedQty:6}]);
 assert.equal((await x.read('inventory',x.key)).onHand,13);assert.equal((await x.read('inventory',x.key)).reserved,8);
});

test('v2 dispatch preparation is a separate idempotent event and allows a later printed shipment',async()=>{
 const x=await seed('prepare-more',{prepared:4});
 const first=await x.call(x.request(A,4,'shipment_prepare_A'));
 assert.equal(first.grossShippedQty,4);
 await assert.rejects(x.call(x.request(B,1,'shipment_prepare_unprinted')),/打單可出貨/);
 const physicalBefore=await Promise.all([
  x.read('inventory',x.key),x.read('warehouseStocks',A+'__'+x.key),x.read('warehouseStocks',B+'__'+x.key),
  x.read('inventoryReservations',x.orderId+'__I'),
  x.read('inventoryLots',x.key+'-b')]);
 const printed=await x.prepare(6,'prepare_second_batch_123456');
 assert.equal(printed.status,'applied');
 assert.equal(printed.preparedQty,10);assert.equal(printed.pendingDispatchQty,0);
 assert.equal(printed.shippableQty,6);
 const physicalAfter=await Promise.all([
  x.read('inventory',x.key),x.read('warehouseStocks',A+'__'+x.key),x.read('warehouseStocks',B+'__'+x.key),
  x.read('inventoryReservations',x.orderId+'__I'),x.read('inventoryLots',x.key+'-b')]);
 assert.deepEqual(physicalAfter,physicalBefore,'printing must never change physical or held stock');
 assert.equal((await x.prepare(6,'prepare_second_batch_123456')).status,'already-applied');
 await assert.rejects(x.prepare(5,'prepare_second_batch_123456'),/操作識別碼/);
 assert.equal((await x.read('orders',x.orderId)).items[0].dispatchPreparedQty,10);
 const shipment=await x.call(x.request(B,6,'shipment_prepare_B'));
 assert.equal(shipment.grossShippedQty,10);
 assert.equal((await x.read('orders',x.orderId)).deliveredQty,0,'shipping is not customer acknowledgement');
});

test('v2 dispatch rejects duplicate, concurrent overprinting, forged access and stale projection',async()=>{
 const x=await seed('prepare-concurrent',{prepared:0});
 const single={orderId:x.orderId,itemId:'I',quantity:3,
  operationId:'prepare_concurrent_123456',syncAttemptId:'sync_ship_12345'};
 const attempts=await Promise.all([commitLocationDispatchPreparation(db,x.uid,single),
   commitLocationDispatchPreparation(db,x.uid,single)]);
 assert.deepEqual(attempts.map(v=>v.status).sort(),['already-applied','applied']);
 assert.equal((await x.read('orders',x.orderId)).items[0].dispatchPreparedQty,3);
 const races=await Promise.allSettled([
  x.prepare(6,'prepare_compete_one_12345'),x.prepare(6,'prepare_compete_two_12345')]);
 assert.equal(races.filter(v=>v.status==='fulfilled').length,1);
 assert.equal((await x.read('orders',x.orderId)).items[0].dispatchPreparedQty,9);
 await assert.rejects(x.prepare(2,'prepare_too_many_123456'),/待打單數量不足/);
 const wrong=await seed('prepare-other',{role:'sales',prepared:0});
 await assert.rejects(wrong.prepare(1,'prepare_sales_forbidden_1234'),/權限/);
 const disabled=await seed('prepare-disabled',{prepared:0});
 await db.collection('users').doc(disabled.uid).update({disabled:true});
 await assert.rejects(disabled.prepare(1,'prepare_disabled_123456'),/權限/);
 const stale=await seed('prepare-stale',{prepared:0});
 await db.collection('orders').doc(stale.orderId).update({inventoryReservationAttemptId:'new_attempt'});
 await assert.rejects(stale.prepare(1,'prepare_stale_123456'),/同步識別碼/);
 const tampered=await seed('prepare-corrupt',{prepared:0});
 const order=await tampered.read('orders',tampered.orderId);
 order.items[0].reservedQty=9;
 await db.collection('orders').doc(tampered.orderId).update({items:order.items});
 await assert.rejects(tampered.prepare(1,'prepare_corrupt_123456'),/預留來源|數量不一致/);
 const after=await tampered.read('orders',tampered.orderId);
 assert.equal(after.items[0].dispatchPreparedQty,0);
});

test('dispatch record replay cannot be hijacked after a later shipment or permission change',async()=>{
 const x=await seed('prepare-replay',{prepared:0});
 const first=await x.prepare(4,'prepare_replay_12345678');
 await x.call(x.request(A,4,'shipment_replay_prepare_A'));
 assert.equal((await x.prepare(4,'prepare_replay_12345678')).status,'already-applied');
 await db.collection('users').doc('dispatch-hijacker').set({role:'admin',active:true});
 await assert.rejects(x.prepare(4,'prepare_replay_12345678','dispatch-hijacker'),/操作識別碼/);
 await db.collection('users').doc(x.uid).update({active:false});
 await assert.rejects(x.prepare(4,'prepare_replay_12345678'),/權限/);
 assert.equal((await x.read('orders',x.orderId)).items[0].dispatchPreparedQty,4);
 assert.equal(first.qty,4);
});

const {commitSingleItemLocationLifecycle}=require('../functions/single-item-location-lifecycle-service');
async function partialLifecycle(name,{confirmed=true,prepared=2}={}){
 const x=await seed('lifecycle-'+name,{role:'admin',prepared});
 const shipment=x.request(A,2,'shipment_lifecycle_'+name);
 await x.call(shipment);
 if(confirmed)await commitShipmentDelivery(db,x.uid,{orderId:x.orderId,itemId:'I',shipmentId:shipment.operationId,
  quantity:2,operationId:'delivery_lifecycle_'+name,syncAttemptId:'sync_ship_12345',date:'2026-10-18'});
 const request=(nextStatus,operationId='lifecycle_'+nextStatus+'_'+name)=>({orderId:x.orderId,itemId:'I',
  warehouseIds:[A,B],nextStatus,operationId,syncAttemptId:'sync_ship_12345',date:'2026-10-19',reason:'取消未交付部分'});
 return {...x,lifecycleRequest:request,lifecycle:(status,operationId,actor=x.uid,connection=db)=>
  commitSingleItemLocationLifecycle(connection,actor,request(status,operationId))};
}
test('partial acknowledged shipment cancels only remaining hold, restores only outstanding quantity and can finish normally',async()=>{
 const x=await partialLifecycle('complete-cycle'),before=await snapshot(x),original=before.docs[0];
 const cancelled=await x.lifecycle('cancelled');
 assert.equal(cancelled.reservedQty,0);assert.equal(cancelled.companyReservedDelta,-8);
 let order=await x.read('orders',x.orderId);
 for(const field of ['warehouseShipmentRecords','warehouseShipmentHistory','deliveryRecords','deliveryHistory'])
  assert.deepEqual(order[field],original[field],field);
 assert.equal(order.items[0].qty,10);assert.equal(order.items[0].warehouseShippedQty,2);
 assert.equal(order.items[0].deliveredQty,2);assert.equal(order.items[0].dispatchPreparedQty,2);
 assert.equal(order.deliveredQty,2);assert.equal(order.isDelivered,false);
 const after=await snapshot(x);
 for(let i=1;i<before.docs.length;i++){
  if(i>=5)assert.deepEqual(after.docs[i],before.docs[i]);
  else assert.equal(after.docs[i].onHand,before.docs[i].onHand);
 }
 assert.equal((await x.read('inventory',x.key)).reserved,2); // other order's hold
 const once=await snapshot(x);assert.equal((await x.lifecycle('cancelled')).status,'already-applied');
 assert.deepEqual(await snapshot(x),once);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,8);assert.equal(restored.shortageQty,0);
 assert.deepEqual(restored.locations,[{warehouseId:A,reservedQty:2},{warehouseId:B,reservedQty:6}]);
 await x.prepare(8,'prepare_after_lifecycle_complete');
 await x.call(x.request(A,2,'shipment_after_lifecycle_A'));
 await x.call(x.request(B,6,'shipment_after_lifecycle_B'));
 for(const [wh,quantity] of [[A,2],[B,6]])await commitShipmentDelivery(db,x.uid,{orderId:x.orderId,itemId:'I',
  shipmentId:'shipment_after_lifecycle_'+(wh===A?'A':'B'),quantity,
  operationId:'delivery_after_lifecycle_'+wh,syncAttemptId:'sync_ship_12345',date:'2026-10-20'});
 order=await x.read('orders',x.orderId);assert.equal(order.items[0].warehouseShippedQty,10);
 assert.equal(order.deliveredQty,10);assert.equal(order.isDelivered,true);
 await assert.rejects(x.lifecycle('cancelled','lifecycle_reject_completed_123'),/已打單|剩餘|送達/);
});
test('partial lifecycle rejects in-flight, unshipped preparation, corrupt projections and missing shipment proof atomically',async()=>{
 for(const [name,options,mutate] of [
  ['inflight',{confirmed:false},null],['prepared',{prepared:3},null],
  ['projection',{},async x=>{const o=await x.read('orders',x.orderId);o.items[0].deliveredQty=1;
   await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['missing-proof',{},x=>db.collection('inventoryMovements').doc('location-ship-shipment_lifecycle_missing-proof').delete()],
  ['wrong-proof',{},x=>db.collection('inventoryMovements').doc('location-ship-shipment_lifecycle_wrong-proof').update({qty:-3})],
 ]){
  const x=await partialLifecycle(name,options);if(mutate)await mutate(x);
  const before=await snapshot(x);await assert.rejects(x.lifecycle('cancelled'),undefined,name);
  assert.deepEqual(await snapshot(x),before,name);
 }
});
test('partial lifecycle roles, concurrent retry and late failure preserve acknowledged facts and atomic balances',async()=>{
 const x=await partialLifecycle('atomic'),collision=db.collection('inventoryMovements').doc('partial-life-collision');
 await collision.set({marker:true});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...a)=>tx.update(...a),set:(...a)=>tx.set(...a),
  create:(...a)=>{tx.create(collision,{marker:false});return tx.create(...a);}
 }))};
 const before=await snapshot(x);
 await assert.rejects(x.lifecycle('cancelled',undefined,x.uid,wrapper));assert.deepEqual(await snapshot(x),before);
 for(const role of ['warehouse','purchaser']){
  await db.collection('users').doc(x.uid).update({role});
  await assert.rejects(x.lifecycle('cancelled'),/不能取消/);assert.deepEqual(await snapshot(x),before);
 }
 await db.collection('users').doc(x.uid).update({role:'sales'});
 const results=await Promise.all([x.lifecycle('cancelled'),x.lifecycle('cancelled')]);
 assert.deepEqual(results.map(r=>r.status).sort(),['already-applied','applied']);
 await db.collection('users').doc(x.uid).update({role:'engineer'});
 assert.equal((await x.lifecycle('normal')).reservedQty,8);
});
test('restoring a partially delivered order recalculates shortage and its canonical procurement demand from remaining quantity',async()=>{
 const x=await partialLifecycle('shortage');await x.lifecycle('cancelled');
 // A real competing reservation takes both the eight released units and the
 // three units already free, while the original two-unit hold stays intact.
 const competitor=x.orderId+'-competitor';
 await db.collection('orders').doc(competitor).set({ownerUid:x.uid,salesCode:'S',status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_competitor_12345',
  items:[{itemId:'C',productId:x.key,qty:11,warehouseId:A,reservedQty:0,deliveredQty:0,returnedQty:0}]});
 await commitSingleItemTwoWarehouse(db,x.uid,{orderId:competitor,itemId:'C',warehouseIds:[A,B],
  attemptId:'reserve_lifecycle_competitor',syncAttemptId:'sync_competitor_12345'});
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,0);assert.equal(restored.shortageQty,8);
 const demandRef=db.collection('procurementDemands').doc(encodeURIComponent('SALES_ORDER:'+x.orderId+':I'));
 const demand=(await demandRef.get()).data();assert.equal(demand.requestedQty,8);assert.equal(demand.remainingToOrderQty,8);
 await x.lifecycle('cancelled','lifecycle_second_cancel_shortage');
 const stopped=(await demandRef.get()).data();assert.equal(stopped.status,'CANCELLED');assert.equal(stopped.requestedQty,8);
 assert.equal(stopped.remainingToOrderQty,0);assert.equal((await x.read('orders',x.orderId)).deliveredQty,2);
});
