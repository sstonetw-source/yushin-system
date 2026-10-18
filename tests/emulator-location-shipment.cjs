'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore');
const {commitSingleItemTwoWarehouse,advanceReleasedV2FreeStock,drainReleasedV2FreeStock}=require('../functions/single-item-location-service');
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
async function acknowledgementFixture(name,{role='sales',shipQty=2,prepared=10}={}){
 const x=await seed('confirm-'+name,{role,prepared});
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
test('customer acknowledgement reads actor, order, shipment movement and bounded return proof query; writes only order',async()=>{
 const x=await acknowledgementFixture('bounded');let reads=0,writes=0;
 const guarded={projectId:db.projectId,collection:name=>{
  assert.ok(['users','orders','inventoryMovements'].includes(name),'unexpected stock/cost read '+name);
  return db.collection(name);
 },runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>{reads++;return tx.get(r);},
  update:(r,v)=>{assert.ok(r.path.startsWith('orders/'));writes++;return tx.update(r,v);}
 }))};
 const before=await physicalSnapshot(x);assert.equal((await x.confirm(x.deliveryRequest(),x.uid,guarded)).status,'applied');
 assert.equal(reads,4);assert.equal(writes,1);assert.deepEqual(await physicalSnapshot(x),before);
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
async function correctionFixture(name,{role='sales',shipQty=2,confirmedQty=1,prepared=10}={}){
 const x=await acknowledgementFixture('correction-'+name,{role,shipQty,prepared});
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
 assert.equal(reads,6);assert.deepEqual(result.allocations.map(a=>a.lotNo),['a-late','a-early']);
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

const {commitLocationReturn,commitLocationReturnAndRecover}=require('../functions/location-return-service');
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

const {commitSingleItemLocationLifecycle,commitSingleItemLocationLifecycleAndRecover}=require('../functions/single-item-location-lifecycle-service');
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

test('restockable CLOSE return emits free-stock source for authorized resumable redistribution, REPLACE never does',async()=>{
 const x=await returnFixture('free-source-close');
 const returned=await x.receive(x.returnRequest({settlement:'CLOSE'}));
 const proof=await x.read('inventoryMovements',returned.movementId);
 assert.equal(proof.v2FreeStockSource,'CLOSED_CUSTOMER_RETURN');
 assert.equal(proof.freeAllocationQty,1);assert.equal(proof.qty,1);
 const before=await snapshot(x);
 const result=await advanceReleasedV2FreeStock(db,x.adminUid,{movementId:returned.movementId});
 assert.equal(result.status,'completed');assert.equal(result.allocatedQty,0);
 assert.equal(result.sourceMovementId,returned.movementId);
 assert.deepEqual(await snapshot(x),before);
 assert.equal((await advanceReleasedV2FreeStock(db,x.adminUid,{movementId:returned.movementId})).status,'completed');
 await assert.rejects(advanceReleasedV2FreeStock(db,x.uid,{movementId:returned.movementId}),/角色/);
 const replacement=await returnFixture('free-source-replace');
 const replace=await replacement.receive();
 const move=await replacement.read('inventoryMovements',replace.movementId);
 assert.equal(move.v2FreeStockSource,undefined);
 await assert.rejects(advanceReleasedV2FreeStock(db,replacement.adminUid,{movementId:replace.movementId}),
  /不會釋放/);
});

test('CLOSE physical return can resume free-stock allocation post-commit without changing return quantities',async()=>{
 const x=await returnFixture('postcommit-close',{role:'admin'});
 const requested=x.returnRequest({settlement:'CLOSE'});
 const first=await commitLocationReturnAndRecover(db,x.uid,requested);
 assert.equal(first.status,'applied');
 assert.equal(first.postCommitAllocation.status,'completed');
 assert.equal(first.postCommitAllocation.sources.length,1);
 assert.equal(first.postCommitAllocation.sources[0].allocatedQty,0);
 const before=await snapshot(x);
 const replay=await commitLocationReturnAndRecover(db,x.uid,requested);
 assert.equal(replay.status,'already-applied');
 assert.equal(replay.postCommitAllocation.status,'completed');
 assert.deepEqual(await snapshot(x),before);
 const movement=await x.read('inventoryMovements',first.movementId);
 assert.equal(movement.v2FreeStockSource,'CLOSED_CUSTOMER_RETURN');
});
test('REPLACE return leaves all stock reserved; sales CLOSE return commits but requires warehouse recovery',async()=>{
 const replaced=await returnFixture('postcommit-replace',{role:'admin'});
 const rep=await commitLocationReturnAndRecover(db,replaced.uid,replaced.returnRequest());
 assert.equal(rep.status,'applied');
 assert.equal(rep.postCommitAllocation.status,'not-applicable');
 assert.deepEqual(rep.postCommitAllocation.sources,[]);
 const move=await replaced.read('inventoryMovements',rep.movementId);
 assert.equal(move.v2FreeStockSource,undefined);
 const sales=await returnFixture('postcommit-sales-close',{role:'sales'});
 const done=await commitLocationReturnAndRecover(db,sales.uid,sales.returnRequest({settlement:'CLOSE'}));
 assert.equal(done.status,'applied');
 assert.equal(done.postCommitAllocation.status,'recovery-pending');
 assert.equal(done.postCommitAllocation.sources[0].errorCode,'permission-denied');
 assert.equal((await sales.read('orders',sales.orderId)).returnRecords.length,1);
 const resumer=await drainReleasedV2FreeStock(db,sales.adminUid,{movementId:done.movementId,maxSteps:5});
 assert.equal(resumer.status,'completed');assert.equal(resumer.allocatedQty,0);
 const before=await snapshot(sales);
 assert.equal((await commitLocationReturnAndRecover(db,sales.uid,sales.returnRequest({settlement:'CLOSE'}))).status,'already-applied');
 assert.deepEqual(await snapshot(sales),before);
});

async function closedRemainingFixture(name,options={}){
 const x=await returnFixture('closed-next-'+name,{prepared:4,confirmedQty:4,...options});
 const returned=await x.receive(x.returnRequest({settlement:'CLOSE'}));
 assert.equal(returned.settlement,'CLOSE');assert.equal(returned.replacementQty,0);
 return {...x,closedReturn:returned};
}
test('CLOSE return permits remaining dispatch shipment and delivery through the same services without replacing the closed unit',async()=>{
 for(const role of ['admin','purchaser','warehouse']){
  const x=await closedRemainingFixture('complete-'+role,{role:role==='warehouse'?'engineer':'sales'});
  const actor='closed-fulfillment-'+role;
  await db.collection('users').doc(actor).set({role,active:true});
  const returnRecord=(await x.read('orders',x.orderId)).returnRecords[0];
  const beforePaper=await physicalSnapshot(x),prepareId='closed_prepare_'+role;
  const prepared=await x.prepare(6,prepareId,actor);
  assert.equal(prepared.preparedQty,10);assert.equal(prepared.shippableQty,6);
  assert.deepEqual(await physicalSnapshot(x),beforePaper);
  const shipmentId='closed_remaining_ship_'+role;
  const request={...x.request(B,6,shipmentId),date:'2026-10-20'};
  const shipped=await x.call(request,actor);
  assert.equal(shipped.grossShippedQty,10);assert.equal(shipped.reservedQty,0);
  const beforeDelivery=await physicalSnapshot(x);
  const delivery={...x.deliveryRequest(6,'closed_remaining_delivered_'+role,shipmentId),date:'2026-10-21'};
  const done=await x.confirm(delivery);
  assert.equal(done.confirmedQty,10);assert.equal(done.isDelivered,true);
  assert.deepEqual(await physicalSnapshot(x),beforeDelivery);
  const order=await x.read('orders',x.orderId),ledger=await x.read('inventoryReservations',x.orderId+'__I');
  assert.equal(order.returnedQty,1);assert.equal(order.items[0].returnedQty,1);
  assert.equal(order.items[0].dispatchPreparedQty,10);assert.equal(order.items[0].warehouseShippedQty,10);
  assert.deepEqual(order.returnRecords,[returnRecord]);assert.equal(ledger.status,'fulfilled');
  assert.equal((await x.read('inventory',x.key)).onHand,7);assert.equal((await x.read('inventory',x.key)).reserved,2);
  assert.equal((await x.read('inventoryLots',x.key+'-a-early')).remainingQty,1);
  assert.equal((await x.read('warehouseStocks',B+'__'+x.key)).reserved,0);
  const baseline=await snapshot(x);
  assert.equal((await x.prepare(6,prepareId,actor)).status,'already-applied');
  assert.equal((await x.call(request,actor)).status,'already-applied');
  assert.equal((await x.confirm(delivery)).status,'already-applied');
  assert.deepEqual(await snapshot(x),baseline);
  await assert.rejects(x.prepare(1,'closed_excess_prepare_'+role,actor),/待打單/);
  await assert.rejects(x.call({...x.request(B,1,'closed_excess_ship_'+role),date:'2026-10-22'},actor),/超額交付/);
  assert.deepEqual(await snapshot(x),baseline);
 }
});
test('CLOSE return after partial acknowledgement allows later delivery of the same shipment and then the second warehouse',async()=>{
 const x=await closedRemainingFixture('partial-confirm',{confirmedQty:2});
 const before=await physicalSnapshot(x);
 const later=await x.confirm({...x.deliveryRequest(2,'closed_first_ship_later_ack'),date:'2026-10-20'});
 assert.equal(later.confirmedQty,4);assert.equal(later.isDelivered,false);
 assert.deepEqual(await physicalSnapshot(x),before);
 await x.prepare(6,'closed_later_prepare_1234',x.shippingUid);
 const shipmentId='closed_later_ship_B_12345';
 await x.call({...x.request(B,6,shipmentId),date:'2026-10-21'},x.shippingUid);
 assert.equal((await x.confirm({...x.deliveryRequest(6,'closed_later_ack_B_1234',shipmentId),date:'2026-10-22'})).isDelivered,true);
 // Another later CLOSE uses the same original receipt writer and proof reader.
 const second=await x.receive(x.returnRequest({settlement:'CLOSE',operationId:'closed_later_return_B_123',
  shipmentId,warehouseId:B,date:'2026-10-23',selections:[{lotId:x.key+'-b',qty:1}]}));
 assert.equal(second.returnedQty,2);assert.equal(second.replacementQty,0);assert.equal(second.isDelivered,true);
 assert.equal((await x.read('inventory',x.key)).onHand,8);
 assert.equal((await x.read('inventory',x.key)).reserved,2);
});
test('remaining fulfillment rejects missing altered and concealed physical return proofs at every entry',async()=>{
 for(const action of ['prepare','ship','deliver'])for(const kind of ['missing','proof','cache','hidden']){
  const x=await closedRemainingFixture('proof-'+action+'-'+kind,{prepared:action==='ship'?10:4,confirmedQty:2});
  const order=await x.read('orders',x.orderId);
  if(kind==='missing')await db.collection('inventoryMovements').doc(x.closedReturn.movementId).delete();
  if(kind==='proof')await db.collection('inventoryMovements').doc(x.closedReturn.movementId).update({qty:999});
  if(kind==='cache'){
   order.returnRecords[0].reason='altered without receipt';
   await db.collection('orders').doc(x.orderId).update({returnRecords:order.returnRecords});
  }
  if(kind==='hidden'){
   order.items[0].returnedQty=0;
   await db.collection('orders').doc(x.orderId).update({items:order.items,returnRecords:[],returnedQty:0});
  }
  const before=await snapshot(x);
  const execute=()=>action==='prepare'?x.prepare(1,'closed_proof_prepare_1234',x.shippingUid)
   :action==='ship'?x.call({...x.request(B,1,'closed_proof_ship_123456'),date:'2026-10-20'},x.shippingUid)
   :x.confirm({...x.deliveryRequest(1,'closed_proof_delivery_123'),date:'2026-10-20'});
  await assert.rejects(execute(),/憑證/);assert.deepEqual(await snapshot(x),before);
 }
});
test('REPLACE remains blocked for dispatch shipment and acknowledgement while CLOSE alone is enabled',async()=>{
 const x=await returnFixture('replace-still-gated',{prepared:4,confirmedQty:2});
 await x.receive();const before=await snapshot(x);
 await assert.rejects(x.prepare(1,'replace_gated_prepare_123',x.shippingUid),/退貨或補送/);
 await assert.rejects(x.call({...x.request(A,1,'replace_gated_ship_123456'),date:'2026-10-20'},x.shippingUid),/退貨或補送/);
 await assert.rejects(x.confirm({...x.deliveryRequest(1,'replace_gated_delivery_123'),date:'2026-10-20'}),/退貨或補送/);
 await assert.rejects(x.reverse(),/退貨或補送/);
 assert.deepEqual(await snapshot(x),before);
});
test('concurrent remaining preparation shipment and acknowledgements cannot exceed the original order after CLOSE',async()=>{
 const x=await closedRemainingFixture('racing-remainder');
 let results=await Promise.allSettled([x.prepare(6,'closed_race_prepare_A_123',x.shippingUid),
  x.prepare(6,'closed_race_prepare_B_123',x.shippingUid)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const requests=['closed_race_ship_A_123456','closed_race_ship_B_123456']
  .map(op=>({...x.request(B,6,op),date:'2026-10-20'}));
 results=await Promise.allSettled(requests.map(r=>x.call(r,x.shippingUid)));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const winner=results.findIndex(r=>r.status==='fulfilled'),shipmentId=requests[winner].operationId;
 results=await Promise.allSettled(['closed_race_ack_A_123456','closed_race_ack_B_123456']
  .map(op=>x.confirm({...x.deliveryRequest(6,op,shipmentId),date:'2026-10-21'})));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const order=await x.read('orders',x.orderId);
 assert.equal(order.items[0].dispatchPreparedQty,10);assert.equal(order.items[0].warehouseShippedQty,10);
 assert.equal(order.deliveredQty,10);assert.equal(order.returnedQty,1);assert.equal(order.isDelivered,true);
 assert.equal(order.warehouseShipmentRecords.length,2);assert.equal(order.deliveryRecords.length,2);
 assert.equal((await x.read('inventory',x.key)).onHand,7);assert.equal((await x.read('inventory',x.key)).reserved,2);
});
test('late failures during remaining dispatch and shipment roll back all writes and original IDs safely retry after CLOSE',async()=>{
 const x=await closedRemainingFixture('remainder-rollback');
 const prepareId='closed_rollback_prepare_123';
 const paperFailure={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),create:(...a)=>tx.create(...a),update:()=>{throw Error('late paperwork failure');}
 }))};
 let before=await snapshot(x);
 await assert.rejects(commitLocationDispatchPreparation(paperFailure,x.shippingUid,{orderId:x.orderId,itemId:'I',quantity:6,
  operationId:prepareId,syncAttemptId:'sync_ship_12345'}),/late paperwork/);
 assert.deepEqual(await snapshot(x),before);
 assert.equal((await db.collection('dispatchRecords').doc('v2-'+prepareId).get()).exists,false);
 await x.prepare(6,prepareId,x.shippingUid);
 const request={...x.request(B,6,'closed_rollback_ship_123456'),date:'2026-10-20'};
 const shipFailure={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...a)=>tx.update(...a),set:(...a)=>tx.set(...a),
  create:()=>{throw Error('late shipment failure');}
 }))};
 before=await snapshot(x);
 await assert.rejects(commitLocationShipment(shipFailure,x.shippingUid,request),/late shipment/);
 assert.deepEqual(await snapshot(x),before);
 assert.equal((await x.call(request,x.shippingUid)).grossShippedQty,10);
});
test('CLOSE remaining flow preserves five-role authority and rejects inactive or unrelated business users',async()=>{
 const x=await closedRemainingFixture('roles-remainder',{confirmedQty:2,prepared:10});
 for(const role of ['sales','engineer']){
  const actor='closed-forbidden-'+role;await db.collection('users').doc(actor).set({role,active:true});
  const before=await snapshot(x);
  await assert.rejects(x.prepare(1,'closed_role_prepare_123456',actor),/權限/);
  await assert.rejects(x.call({...x.request(B,1,'closed_role_ship_1234567'),date:'2026-10-20'},actor),/權限/);
  await assert.rejects(x.confirm({...x.deliveryRequest(1,'closed_role_delivery_12345'),date:'2026-10-20'},actor),/自己訂單/);
  assert.deepEqual(await snapshot(x),before);
 }
 for(const role of ['purchaser','warehouse']){
  const actor='closed-forbidden-ack-'+role;await db.collection('users').doc(actor).set({role,active:true});
  const before=await snapshot(x);
  await assert.rejects(x.confirm({...x.deliveryRequest(1,'closed_role_ack_reject_123'),date:'2026-10-20'},actor),/權限/);
  assert.deepEqual(await snapshot(x),before);
 }
 await db.collection('users').doc(x.uid).update({disabled:true});
 await assert.rejects(x.confirm({...x.deliveryRequest(1,'closed_disabled_ack_12345'),date:'2026-10-20'}),/權限/);
});
test('later acknowledgement cannot be used to backdate an additional physical return before those goods arrived',async()=>{
 const x=await closedRemainingFixture('return-timeline',{confirmedQty:2});
 await x.confirm({...x.deliveryRequest(2,'closed_timeline_later_ack'),date:'2026-10-21'});
 const before=await snapshot(x);
 await assert.rejects(x.receive(x.returnRequest({settlement:'CLOSE',operationId:'closed_timeline_early_return',
  date:'2026-10-19',selections:[{lotId:x.key+'-a-late',qty:2}]})),/當時已送達量/);
 assert.deepEqual(await snapshot(x),before);
});

async function closedLifecycleFixture(name,options={}){
 return withReturnLifecycle(await closedRemainingFixture('life-'+name,options),name);
}
function withReturnLifecycle(x,name){
 const lifecycleRequest=(nextStatus,operationId='closed_lifecycle_'+name+'_'+nextStatus)=>({
  orderId:x.orderId,itemId:'I',warehouseIds:[A,B],nextStatus,operationId,
  syncAttemptId:'sync_ship_12345',date:'2026-10-22',reason:'取消或恢復剩餘商品'});
 return {...x,lifecycleRequest,lifecycle:(nextStatus,operationId,actor=x.uid,connection=db)=>
  commitSingleItemLocationLifecycle(connection,actor,lifecycleRequest(nextStatus,operationId))};
}
async function closedLifecycleSnapshot(x){
 const documents={};
 for(const name of ['reservationOperationReceipts','procurementDemands','supplyOrders','dispatchRecords']){
  const field=name==='procurementDemands'?'sourceId':'orderId';
  const rows=await db.collection(name).where(field,'==',x.orderId).get();
  documents[name]=rows.docs.map(d=>({id:d.id,...d.data()}));
 }
 return {state:await snapshot(x),documents};
}
async function competingClosedOrder(x,suffix,qty=10){
 const orderId=x.orderId+'-other-'+suffix;
 await db.collection('orders').doc(orderId).set({ownerUid:x.uid,salesCode:'S',status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'closed_competitor_sync',
  items:[{itemId:'C',productId:x.key,qty,warehouseId:A,reservedQty:0,deliveredQty:0,returnedQty:0}]});
 await commitSingleItemTwoWarehouse(db,x.uid,{orderId,itemId:'C',warehouseIds:[A,B],
  attemptId:'closed_competitor_'+suffix,syncAttemptId:'closed_competitor_sync'});
 await db.collection('orders').doc(orderId).update({inventoryReservationStatus:'completed'});
 return orderId;
}
test('CLOSE cancellation releases only six remaining units; restoration completes the original ten without reopening the closed unit',async()=>{
 const x=await closedLifecycleFixture('roundtrip'),before=await snapshot(x),original=before.docs[0];
 const cancel=await x.lifecycle('cancelled');
 assert.equal(cancel.reservedQty,0);assert.equal(cancel.companyReservedDelta,-6);
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I')).status,'released');
 assert.equal((await x.read('inventory',x.key)).onHand,13);assert.equal((await x.read('inventory',x.key)).reserved,2);
 const cancelled=await closedLifecycleSnapshot(x);
 assert.equal((await x.lifecycle('cancelled')).status,'already-applied');
 assert.deepEqual(await closedLifecycleSnapshot(x),cancelled);
 const restored=await x.lifecycle('normal');
 assert.equal(restored.reservedQty,6);assert.equal(restored.shortageQty,0);
 assert.deepEqual(restored.locations,[{warehouseId:A,reservedQty:1},{warehouseId:B,reservedQty:5}]);
 const order=await x.read('orders',x.orderId);
 for(const field of ['returnRecords','returnHistory','warehouseShipmentRecords','deliveryRecords','deliveryHistory'])
  assert.deepEqual(order[field],original[field],field);
 for(let i=5;i<before.docs.length;i++)assert.deepEqual((await snapshot(x)).docs[i],before.docs[i]);
 assert.equal(order.items[0].qty,10);assert.equal(order.items[0].returnedQty,1);
 assert.equal(order.items[0].warehouseShippedQty,4);assert.equal(order.deliveredQty,4);
 await x.prepare(6,'closed_lifecycle_finish_prepare',x.shippingUid);
 for(const [wh,quantity,tag] of [[A,1,'A'],[B,5,'B']]){
  const shipmentId='closed_lifecycle_finish_ship_'+tag;
  await x.call({...x.request(wh,quantity,shipmentId),date:'2026-10-23'},x.shippingUid);
  await x.confirm({...x.deliveryRequest(quantity,'closed_lifecycle_finish_ack_'+tag,shipmentId),date:'2026-10-24'});
 }
 const finished=await x.read('orders',x.orderId);
 assert.equal(finished.items[0].warehouseShippedQty,10);assert.equal(finished.deliveredQty,10);
 assert.equal(finished.returnedQty,1);assert.equal(finished.isDelivered,true);
 assert.equal((await x.read('inventory',x.key)).onHand,7);assert.equal((await x.read('inventory',x.key)).reserved,2);
 await assert.rejects(x.lifecycle('cancelled','closed_lifecycle_finished_reject'),/全部送達/);
});
test('restoring CLOSE remainder after genuine competing reservations creates demand for six, not the returned unit',async()=>{
 const x=await closedLifecycleFixture('shortage');await x.lifecycle('cancelled');
 const competitor=await competingClosedOrder(x,'shortage');
 assert.equal((await x.read('inventoryReservations',competitor+'__C')).quantity,10);
 const done=await x.lifecycle('normal');assert.equal(done.reservedQty,0);assert.equal(done.shortageQty,6);
 const demandId=encodeURIComponent('SALES_ORDER:'+x.orderId+':I');
 const demand=await x.read('procurementDemands',demandId);
 assert.equal(demand.requestedQty,6);assert.equal(demand.remainingToOrderQty,6);
 assert.equal(demand.orderedQty,0);assert.equal(demand.status,'PENDING');
 assert.equal((await x.read('inventory',x.key)).onHand,13);assert.equal((await x.read('inventory',x.key)).reserved,12);
 const stable=await closedLifecycleSnapshot(x);
 assert.equal((await x.lifecycle('normal')).status,'already-applied');
 assert.deepEqual(await closedLifecycleSnapshot(x),stable);
 await x.lifecycle('cancelled','closed_shortage_cancel_again_123');
 assert.equal((await x.read('procurementDemands',demandId)).status,'CANCELLED');
 assert.equal((await x.read('procurementDemands',demandId)).requestedQty,6);
});
test('CLOSE cancellation and restoration reject missing altered or concealed return receipts without partial writes',async()=>{
 for(const target of ['cancelled','normal'])for(const kind of ['missing','proof','cache','hidden','history']){
  const x=await closedLifecycleFixture('proof-'+target+'-'+kind);
  if(target==='normal')await x.lifecycle('cancelled');
  const order=await x.read('orders',x.orderId);
  if(kind==='missing')await db.collection('inventoryMovements').doc(x.closedReturn.movementId).delete();
  if(kind==='proof')await db.collection('inventoryMovements').doc(x.closedReturn.movementId).update({qty:999});
  if(kind==='cache'){
   order.returnRecords[0].reason='changed without receipt';
   await db.collection('orders').doc(x.orderId).update({returnRecords:order.returnRecords});
  }
  if(kind==='history'){
   order.returnHistory[0].action='delete';
   await db.collection('orders').doc(x.orderId).update({returnHistory:order.returnHistory});
  }
  if(kind==='hidden'){
   order.items[0].returnedQty=0;
   await db.collection('orders').doc(x.orderId).update({items:order.items,returnRecords:[],returnedQty:0});
  }
  const before=await closedLifecycleSnapshot(x);
  await assert.rejects(x.lifecycle(target,'closed_bad_proof_'+target+'_'+kind),/憑證|退貨歷史/);
  assert.deepEqual(await closedLifecycleSnapshot(x),before);
 }
});
test('CLOSE lifecycle still rejects replacement mixed returns in-flight goods and unshipped paperwork',async()=>{
 const replacement=await returnFixture('closed-life-replace',{prepared:4,confirmedQty:4});
 await replacement.receive();
 const request=x=>({orderId:x.orderId,itemId:'I',warehouseIds:[A,B],nextStatus:'cancelled',
  operationId:'closed_unsupported_lifecycle_123',syncAttemptId:'sync_ship_12345',date:'2026-10-22'});
 let before=await snapshot(replacement);
 await assert.rejects(commitSingleItemLocationLifecycle(db,replacement.uid,request(replacement)),/退貨或補送/);
 assert.deepEqual(await snapshot(replacement),before);
 const mixed=await closedLifecycleFixture('mixed');
 await mixed.receive(mixed.returnRequest({settlement:'REPLACE',operationId:'closed_mixed_replace_12345'}));
 before=await snapshot(mixed);await assert.rejects(mixed.lifecycle('cancelled'),/退貨或補送/);
 assert.deepEqual(await snapshot(mixed),before);
 for(const [name,options,pattern] of [['inflight',{confirmedQty:2},/途中貨物/],
   ['prepared',{prepared:5},/已打單未出貨/]]){
  const x=await closedLifecycleFixture(name,options),baseline=await closedLifecycleSnapshot(x);
  await assert.rejects(x.lifecycle('cancelled'),pattern);
  assert.deepEqual(await closedLifecycleSnapshot(x),baseline);
 }
});
test('CLOSE lifecycle keeps five-role ownership checks for both cancellation and restoration',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await closedLifecycleFixture('roles-'+role);
  await db.collection('users').doc(x.uid).update({role});
  if(['admin','sales','engineer'].includes(role)){
   assert.equal((await x.lifecycle('cancelled')).reservedQty,0);
   assert.equal((await x.lifecycle('normal')).reservedQty,6);
  }else{
   let baseline=await closedLifecycleSnapshot(x);
   await assert.rejects(x.lifecycle('cancelled'),/不能取消或恢復/);
   assert.deepEqual(await closedLifecycleSnapshot(x),baseline);
   await x.lifecycle('cancelled',undefined,x.adminUid);
   baseline=await closedLifecycleSnapshot(x);
   await assert.rejects(x.lifecycle('normal'),/不能取消或恢復/);
   assert.deepEqual(await closedLifecycleSnapshot(x),baseline);
  }
 }
 const x=await closedLifecycleFixture('foreign');
 for(const role of ['sales','engineer']){
  const actor='closed-life-foreign-'+role;await db.collection('users').doc(actor).set({role,active:true});
  await assert.rejects(x.lifecycle('cancelled','closed_foreign_'+role,actor),/其他業務/);
 }
 await x.lifecycle('cancelled');const cancelled=await closedLifecycleSnapshot(x);
 await db.collection('users').doc(x.uid).update({disabled:true});
 await assert.rejects(x.lifecycle('normal'),/不能取消或恢復/);
 assert.deepEqual(await closedLifecycleSnapshot(x),cancelled);
});
test('concurrent CLOSE lifecycle retries never double release or reserve the original remainder',async()=>{
 const x=await closedLifecycleFixture('races');
 const first=await Promise.all([x.lifecycle('cancelled'),x.lifecycle('cancelled')]);
 assert.deepEqual(first.map(r=>r.status).sort(),['already-applied','applied']);
 const restores=await Promise.allSettled([x.lifecycle('normal','closed_race_restore_A_123'),
  x.lifecycle('normal','closed_race_restore_B_123')]);
 assert.equal(restores.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I')).quantity,6);
 assert.equal((await x.read('inventory',x.key)).reserved,8);
 const cancellations=await Promise.allSettled([x.lifecycle('cancelled','closed_race_cancel_A_1234'),
  x.lifecycle('cancelled','closed_race_cancel_B_1234')]);
 assert.equal(cancellations.filter(r=>r.status==='fulfilled').length,1);
 assert.equal((await x.read('inventory',x.key)).reserved,2);
 assert.equal((await x.read('inventory',x.key)).onHand,13);
 assert.equal((await x.read('orders',x.orderId)).returnedQty,1);
});
test('CLOSE lifecycle late receipt failure rolls back cancellation and new restoration demand with safe original-ID retries',async()=>{
 const x=await closedLifecycleFixture('rollback');
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...a)=>tx.update(...a),set:(...a)=>tx.set(...a),create:(ref,...a)=>{
   if(ref.path.startsWith('reservationOperationReceipts/single-v2-lifecycle-'))throw Error('late lifecycle receipt failure');
   return tx.create(ref,...a);
  }
 }))};
 let baseline=await closedLifecycleSnapshot(x);
 await assert.rejects(x.lifecycle('cancelled',undefined,x.uid,guarded),/late lifecycle receipt/);
 assert.deepEqual(await closedLifecycleSnapshot(x),baseline);
 assert.equal((await x.lifecycle('cancelled')).reservedQty,0);
 await competingClosedOrder(x,'rollback');
 baseline=await closedLifecycleSnapshot(x);
 await assert.rejects(x.lifecycle('normal',undefined,x.uid,guarded),/late lifecycle receipt/);
 assert.deepEqual(await closedLifecycleSnapshot(x),baseline);
 const done=await x.lifecycle('normal');assert.equal(done.reservedQty,0);assert.equal(done.shortageQty,6);
 assert.equal((await x.lifecycle('normal')).status,'already-applied');
});
test('CLOSE cancellation post-commit recovery reallocates released remainder before restoration replans only unmet demand',async()=>{
 const x=await closedLifecycleFixture('released-recovery',{role:'admin'});
 const competitor=await competingClosedOrder(x,'recovery');
 assert.equal((await x.read('inventoryReservations',competitor+'__C')).quantity,4);
 const intent=x.lifecycleRequest('cancelled');
 const cancelled=await commitSingleItemLocationLifecycleAndRecover(db,x.uid,intent);
 assert.equal(cancelled.companyReservedDelta,-6);assert.equal(cancelled.postCommitAllocation.status,'completed');
 assert.equal(cancelled.postCommitAllocation.sources.length,1);
 assert.equal((await x.read('inventoryReservations',competitor+'__C')).quantity,10);
 const before=await closedLifecycleSnapshot(x);
 assert.equal((await commitSingleItemLocationLifecycleAndRecover(db,x.uid,intent)).status,'already-applied');
 assert.deepEqual(await closedLifecycleSnapshot(x),before);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,0);assert.equal(restored.shortageQty,6);
 assert.equal((await x.read('orders',x.orderId)).returnedQty,1);
 assert.equal((await x.read('inventory',x.key)).onHand,13);
});

async function cancelledReturnFixture(name,options={}){
 const x=withReturnLifecycle(await returnFixture('cancel-return-'+name,{prepared:4,confirmedQty:4,...options}),'cancel-return-'+name);
 await x.lifecycle('cancelled',undefined,x.adminUid);
 return {...x,closeRequest:patch=>x.returnRequest({settlement:'CLOSE',date:'2026-10-23',...patch})};
}
test('cancelled CLOSE receipt restores original lots as free stock and restoration ships only original remainder',async()=>{
 const x=await cancelledReturnFixture('roundtrip'),before=await closedLifecycleSnapshot(x),ledger=before.state.docs[4];
 const result=await x.receive(x.closeRequest());assert.equal(result.reservedQty,0);assert.equal(result.replacementQty,0);
 const after=await closedLifecycleSnapshot(x),order=after.state.docs[0];
 assert.equal(order.status,'cancelled');assert.equal(order.orderStatus,'cancelled');assert.equal(order.returnedQty,1);assert.equal(order.deliveredQty,4);
 assert.deepEqual(after.state.docs[4],{...ledger,updatedAt:after.state.docs[4].updatedAt});
 assert.equal(after.state.docs[1].onHand,before.state.docs[1].onHand+1);assert.equal(after.state.docs[1].reserved,2);
 assert.deepEqual(after.state.docs[3],before.state.docs[3]);assert.deepEqual(order.deliveryRecords,before.state.docs[0].deliveryRecords);
 assert.deepEqual(order.warehouseShipmentRecords,before.state.docs[0].warehouseShipmentRecords);
 assert.deepEqual(after.documents.procurementDemands,before.documents.procurementDemands);
 await x.receive(x.closeRequest());assert.deepEqual(await closedLifecycleSnapshot(x),after);
 await assert.rejects(x.receive(x.closeRequest({reason:'另一意圖'})),/其他交易/);
 const restored=await x.lifecycle('normal');assert.equal(restored.reservedQty,6);assert.equal(restored.shortageQty,0);
 const hold=await x.read('inventoryReservations',x.orderId+'__I');await x.prepare(6,'cancel_close_remaining_prepare',x.adminUid);
 for(const row of hold.locations){const tag='cancel_close_remaining_'+row.warehouseId;
  await x.ship(row.warehouseId,row.reservedQty,tag);
  await x.confirm(x.deliveryRequest(row.reservedQty,'delivery_'+tag,tag),x.adminUid);}
 const completed=await x.read('orders',x.orderId);assert.equal(completed.deliveredQty,10);assert.equal(completed.returnedQty,1);assert.equal(completed.isDelivered,true);
 assert.equal((await x.read('inventory',x.key)).onHand,7);assert.equal((await x.read('inventory',x.key)).reserved,2);
 const final=await snapshot(x);await x.receive(x.closeRequest());assert.deepEqual(await snapshot(x),final);
});
test('cancelled CLOSE can follow a previous CLOSE and repeated returns share original delivered and lot allowance',async()=>{
 const x=await closedLifecycleFixture('cancel-return-prior');await x.lifecycle('cancelled');
 await x.receive(x.returnRequest({settlement:'CLOSE',operationId:'cancel_return_prior_second',date:'2026-10-23'}));
 const order=await x.read('orders',x.orderId);assert.equal(order.returnedQty,2);assert.equal(order.returnRecords.length,2);
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I')).status,'released');
 const before=await snapshot(x);
 await assert.rejects(x.receive(x.returnRequest({settlement:'CLOSE',operationId:'cancel_return_prior_excess',date:'2026-10-23'})),/批次|超過/);
 assert.deepEqual(await snapshot(x),before);assert.equal((await x.lifecycle('normal')).reservedQty,6);
});
test('cancelled CLOSE preserves five-role ownership and current active actor checks including replay',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await cancelledReturnFixture('roles-'+role,{role}),before=await snapshot(x);
  if(['admin','sales','engineer'].includes(role)){
   assert.equal((await x.receive(x.closeRequest())).reservedQty,0);
   await db.collection('users').doc(x.uid).update({disabled:true});const committed=await snapshot(x);
   await assert.rejects(x.receive(x.closeRequest()),/權限/);assert.deepEqual(await snapshot(x),committed);
  }else{await assert.rejects(x.receive(x.closeRequest()),/權限/);assert.deepEqual(await snapshot(x),before);}
 }
 const x=await cancelledReturnFixture('foreign');
 for(const role of ['sales','engineer']){const uid='cancel-return-foreign-'+role;await db.collection('users').doc(uid).set({role,active:true});
  const before=await snapshot(x);await assert.rejects(x.receive(x.closeRequest(),uid),/自己訂單/);assert.deepEqual(await snapshot(x),before);}
});
test('cancelled CLOSE refuses residual holds wrong lifecycle and forged shipment or earlier return evidence atomically',async()=>{
 const cases=[
  ['status',x=>db.collection('orders').doc(x.orderId).update({orderStatus:'normal'})],
  ['ledger-status',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({status:'fulfilled'})],
  ['shortage',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({shortageQty:1})],
  ['hold',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({quantity:1,locations:[{warehouseId:B,reservedQty:1}]})],
  ['item',async x=>{const o=await x.read('orders',x.orderId);o.items[0].reservedQty=1;await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['paperwork',async x=>{const o=await x.read('orders',x.orderId);o.items[0].dispatchPreparedQty=5;await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['sync',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationAttemptId:'different'})],
  ['shipment',x=>db.collection('inventoryMovements').doc('location-ship-'+x.shipmentRequest.operationId).delete()],
  ['lot',x=>db.collection('inventoryLots').doc(x.key+'-a-early').delete()],
 ];
 for(const [name,mutate] of cases){const x=await cancelledReturnFixture('bad-'+name);await mutate(x);const before=await snapshot(x);
  await assert.rejects(x.receive(x.closeRequest()));assert.deepEqual(await snapshot(x),before,name);}
 for(const kind of ['missing','hash','hidden','history']){
  const x=await closedLifecycleFixture('cancel-return-'+kind);await x.lifecycle('cancelled');const o=await x.read('orders',x.orderId),r=o.returnRecords[0];
  if(kind==='missing')await db.collection('inventoryMovements').doc(r.movementId).delete();
  if(kind==='hash')await db.collection('inventoryMovements').doc(r.movementId).update({intentHash:'altered'});
  if(kind==='hidden'){o.items[0].returnedQty=0;await db.collection('orders').doc(x.orderId).update({items:o.items,returnRecords:[],returnHistory:[],returnedQty:0});}
  if(kind==='history')await db.collection('orders').doc(x.orderId).update({returnHistory:[{action:'remove',recordId:r.id}]});
  const before=await snapshot(x);await assert.rejects(x.receive(x.returnRequest({settlement:'CLOSE',operationId:'cancel_return_bad_'+kind,date:'2026-10-23'})));
  assert.deepEqual(await snapshot(x),before,kind);
 }
 const x=await cancelledReturnFixture('replace'),before=await snapshot(x);await assert.rejects(x.receive(x.returnRequest()),/取消|結案/);assert.deepEqual(await snapshot(x),before);
});
test('cancelled return keeps acknowledgement reversal and replacement closed while trace stays read-only and rejects in-flight caches',async()=>{
 const x=await cancelledReturnFixture('boundaries'),before=await snapshot(x);
 await assert.rejects(x.confirm(x.deliveryRequest(1,'cancel_return_new_ack')),/取消|結案/);
 await assert.rejects(x.reverse(),/取消|結案/);assert.equal((await x.trace()).canCommit,false);assert.deepEqual(await snapshot(x),before);
 const pending=await returnFixture('cancel-return-inflight',{prepared:4,confirmedQty:2});
 // A corrupt external status cache must not pretend the real cancellation service completed.
 const o=await pending.read('orders',pending.orderId);o.items[0].reservedQty=0;o.items[0].shortageQty=0;
 await db.collection('orders').doc(pending.orderId).update({status:'cancelled',orderStatus:'cancelled',items:o.items});
 await db.collection('inventoryReservations').doc(pending.orderId+'__I').update({quantity:0,shortageQty:0,locations:[],status:'released'});
 const state=await snapshot(pending);await assert.rejects(pending.receive(pending.returnRequest({settlement:'CLOSE'})),/途中/);assert.deepEqual(await snapshot(pending),state);
});
test('CLOSE return racing cancellation restoration or competing receipts serializes without duplicate stock or reservation',async()=>{
 const x=withReturnLifecycle(await returnFixture('cancel-return-race',{prepared:4,confirmedQty:4}),'cancel-return-race');
 const request=x.returnRequest({settlement:'CLOSE'});
 await Promise.all([x.lifecycle('cancelled'),x.receive(request)]);
 let stock=await x.read('inventory',x.key);assert.equal(stock.onHand,13);assert.equal(stock.reserved,2);
 const next=x.returnRequest({settlement:'CLOSE',operationId:'cancel_return_restore_race',date:'2026-10-23'});
 await Promise.all([x.lifecycle('normal'),x.receive(next)]);stock=await x.read('inventory',x.key);assert.equal(stock.onHand,14);assert.equal(stock.reserved,8);
 const y=await cancelledReturnFixture('double-race'),make=operationId=>y.closeRequest({operationId,selections:[{lotId:y.key+'-a-early',qty:2}]});
 const results=await Promise.allSettled([y.receive(make('cancel_return_race_one')),y.receive(make('cancel_return_race_two'))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal((await y.read('inventory',y.key)).onHand,14);
 assert.equal((await y.read('inventoryReservations',y.orderId+'__I')).quantity,0);
});
test('cancelled CLOSE late collision rolls back all physical and history writes and retains bounded same-ID retry',async()=>{
 const x=await cancelledReturnFixture('rollback'),collision=db.collection('inventoryMovements').doc('cancel-return-collision');await collision.set({marker:true});
 const wrapper={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(tx=>fn({
  get:r=>tx.get(r),update:(...a)=>tx.update(...a),set:(...a)=>tx.set(...a),create:(...a)=>{tx.create(...a);tx.create(collision,{marker:false});}}))};
 const before=await closedLifecycleSnapshot(x);await assert.rejects(x.receive(x.closeRequest(),x.uid,wrapper));assert.deepEqual(await closedLifecycleSnapshot(x),before);
 let reads=0,writes=0;
 const guarded={projectId:db.projectId,collection:n=>{assert.ok(['users','orders','inventoryMovements','inventory','warehouseStocks','inventoryReservations','warehouses','inventoryLots'].includes(n));return db.collection(n);},
  runTransaction:fn=>db.runTransaction(tx=>fn({get:r=>{reads++;return tx.get(r);},update:(...a)=>{writes++;return tx.update(...a);},set:(...a)=>{writes++;return tx.set(...a);},create:(...a)=>{writes++;return tx.create(...a);}}))};
 assert.equal((await x.receive(x.closeRequest(),x.uid,guarded)).status,'applied');assert.equal(reads,10);assert.equal(writes,6);
 const after=await snapshot(x);await x.receive(x.closeRequest());assert.deepEqual(await snapshot(x),after);
});
test('cancelled CLOSE movement redistributes at most its returned unit to another order and never reactivates its source',async()=>{
 const x=await cancelledReturnFixture('recovery',{role:'admin'});await competingClosedOrder(x,'consume-free',9);
 const target=await competingClosedOrder(x,'waiting');assert.equal((await x.read('inventoryReservations',target+'__C')).shortageQty,10);
 const returned=await commitLocationReturnAndRecover(db,x.uid,x.closeRequest());assert.equal(returned.postCommitAllocation.status,'completed');
 assert.equal(returned.postCommitAllocation.sources[0].allocatedQty,1);
 assert.equal((await x.read('inventoryReservations',target+'__C')).quantity,1);
 assert.equal((await x.read('inventoryReservations',x.orderId+'__I')).status,'released');assert.equal((await x.read('orders',x.orderId)).status,'cancelled');
 const after=await snapshot(x);await commitLocationReturnAndRecover(db,x.uid,x.closeRequest());assert.deepEqual(await snapshot(x),after);
});

test('cancelled CLOSE trace reads original lots and actual return proofs without writes or costs and shares receipt scope',async()=>{
 const x=await cancelledReturnFixture('trace-readonly'),before=await closedLifecycleSnapshot(x);let reads=0;
 const guarded={projectId:db.projectId,collection:n=>{assert.ok(['users','orders','inventoryMovements','inventoryReservations','inventoryLots'].includes(n));return db.collection(n);},
  runTransaction:fn=>db.runTransaction(tx=>fn({get:r=>{reads++;return tx.get(r);}}))};
 const request=x.traceRequest([{lotId:x.key+'-a-early',qty:1},{lotId:x.key+'-a-late',qty:1}]);
 const result=await x.trace(request,x.uid,guarded);assert.equal(reads,7);assert.equal(result.status,'read-only');assert.equal(result.canCommit,false);
 assert.equal(result.confirmedQty,4);assert.equal(result.previousReturnedQty,0);assert.equal(result.remainingReturnQty,4);
 assert.deepEqual(result.remainingLotAllocations.map(a=>[a.lotId,a.remainingQty]),[[x.key+'-a-early',2],[x.key+'-a-late',2]]);
 assert.equal(JSON.stringify(result).includes('98765'),false);assert.deepEqual(await closedLifecycleSnapshot(x),before);
 await x.receive(x.closeRequest());const after=await snapshot(x),remaining=await x.trace();
 assert.equal(remaining.previousReturnedQty,1);assert.equal(remaining.remainingReturnQty,3);
 assert.equal(remaining.remainingLotAllocations[0].remainingQty,1);assert.deepEqual(await snapshot(x),after);
});
test('normal CLOSE trace subtracts only prior returns from its selected shipment and never repeats an exhausted batch',async()=>{
 const x=await closedRemainingFixture('trace-active');
 const first=await x.trace();assert.equal(first.previousReturnedQty,1);assert.equal(first.remainingReturnQty,3);
 await x.prepare(2,'trace_other_shipment_prepare',x.adminUid);await x.ship(B,2,'trace_other_shipment_B');
 await x.confirm(x.deliveryRequest(2,'trace_other_delivery_B','trace_other_shipment_B'),x.adminUid);
 await x.receive(x.returnRequest({shipmentId:'trace_other_shipment_B',warehouseId:B,settlement:'CLOSE',
  operationId:'trace_other_return_B',selections:[{lotId:x.key+'-b',qty:1}]}));
 const before=await snapshot(x),same=await x.trace();assert.equal(same.previousReturnedQty,1);assert.equal(same.remainingReturnQty,3);
 await assert.rejects(x.trace(x.traceRequest([{lotId:x.key+'-a-early',qty:2}])),/超過/);assert.deepEqual(await snapshot(x),before);
});
test('cancelled trace retains all five read-only roles while rejecting unrelated owners inactive actors and spoofed inputs',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await cancelledReturnFixture('trace-role-'+role,{role});await x.receive(x.closeRequest(),x.adminUid);
  const before=await snapshot(x),result=await x.trace();assert.equal(result.canCommit,false);assert.equal(result.previousReturnedQty,1);
  assert.deepEqual(await snapshot(x),before);await db.collection('users').doc(x.uid).update({active:false});
  await assert.rejects(x.trace(),/權限/);assert.deepEqual(await snapshot(x),before);
 }
 const x=await cancelledReturnFixture('trace-foreign');
 for(const role of ['sales','engineer']){const actor='trace-cancel-stranger-'+role;await db.collection('users').doc(actor).set({role,active:true});await assert.rejects(x.trace(x.traceRequest(),actor),/自己訂單/);}
 await assert.rejects(x.trace({...x.traceRequest(),actorRole:'admin'}),/未授權/);
});
test('CLOSE trace refuses missing altered hidden return evidence and cancelled ledgers without any writes',async()=>{
 const cases=[
  ['missing',async(x,r)=>db.collection('inventoryMovements').doc(r.movementId).delete()],
  ['hash',async(x,r)=>db.collection('inventoryMovements').doc(r.movementId).update({intentHash:'forged'})],
  ['hidden',async x=>{const o=await x.read('orders',x.orderId);o.items[0].returnedQty=0;await db.collection('orders').doc(x.orderId).update({items:o.items,returnRecords:[],returnHistory:[],returnedQty:0});}],
  ['ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').delete()],
  ['hold',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({quantity:1,locations:[{warehouseId:B,reservedQty:1}]})],
  ['shortage',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({shortageQty:1})],
  ['owner',x=>db.collection('inventoryReservations').doc(x.orderId+'__I').update({ownerUid:'other'})],
  ['history',x=>db.collection('orders').doc(x.orderId).update({returnHistory:[{action:'remove',recordId:'unknown'}]})],
 ];
 for(const [name,mutate] of cases){const x=await cancelledReturnFixture('trace-bad-'+name);const returned=await x.receive(x.closeRequest());await mutate(x,returned);
  const before=await closedLifecycleSnapshot(x);await assert.rejects(x.trace());assert.deepEqual(await closedLifecycleSnapshot(x),before,name);}
});
test('cancelled trace rejects in-flight extra paperwork and replacement history and bounds actual proof queries',async()=>{
 for(const kind of ['pending','paperwork','replace']){
  const x=await returnFixture('trace-scope-'+kind,{prepared:kind==='paperwork'?5:4,confirmedQty:kind==='pending'?2:4});
  if(kind==='replace')await x.receive();const o=await x.read('orders',x.orderId);o.items[0].reservedQty=0;o.items[0].shortageQty=0;
  await db.collection('orders').doc(x.orderId).update({status:'cancelled',orderStatus:'cancelled',items:o.items});
  await db.collection('inventoryReservations').doc(x.orderId+'__I').update({quantity:0,shortageQty:0,locations:[],status:'released'});
  const before=await snapshot(x);await assert.rejects(x.trace());assert.deepEqual(await snapshot(x),before);
 }
 const x=await cancelledReturnFixture('trace-overflow'),batch=db.batch();
 for(let i=0;i<201;i++)batch.set(db.collection('inventoryMovements').doc('trace-proof-overflow-'+i),{sourceId:x.orderId,action:'location_customer_return',productKey:x.key});
 await batch.commit();const before=await snapshot(x);await assert.rejects(x.trace(),/憑證數量/);assert.deepEqual(await snapshot(x),before);
});
test('a successful read-only trace is not a receipt promise and the original writer revalidates remaining allowance',async()=>{
 const x=await cancelledReturnFixture('trace-stale'),selections=[{lotId:x.key+'-a-early',qty:2}];
 const preview=await x.trace(x.traceRequest(selections));assert.equal(preview.returnQty,2);assert.equal(preview.canCommit,false);
 await x.receive(x.closeRequest({selections}));const after=await snapshot(x);
 await assert.rejects(x.receive(x.closeRequest({operationId:'cancel_trace_stale_new_return',selections})),/超過/);
 await assert.rejects(x.trace(x.traceRequest(selections)),/超過/);assert.deepEqual(await snapshot(x),after);
 const refreshed=await x.trace(x.traceRequest([{lotId:x.key+'-a-late',qty:1}]));assert.equal(refreshed.remainingReturnQty,2);
 assert.equal(refreshed.previousReturnedQty,2);assert.deepEqual(await snapshot(x),after);
});

const {synchronizeV2OrderFixture}=require('./fixtures/v2-order-initialization.cjs');
async function multiDispatchFixture(name,{role='purchaser',five=false}={}){
 const uid='multi-print-'+name,orderId='multi-print-order-'+name,key='multi-print-p-'+name,q=key+'-Q';
 const items=five?Array.from({length:5},(_,i)=>({itemId:'I'+(i+1),productId:key,qty:3,warehouseId:i%2?B:A})):[
  {itemId:'I1',productId:key,qty:4,warehouseId:A,unitPrice:456,custom:{note:'keep source'}},
  {itemId:'I2',productId:key,qty:5,warehouseId:B},{itemId:'I3',productId:q,qty:3,warehouseId:B}];
 const batch=db.batch(),set=(n,k,d)=>batch.set(db.collection(n).doc(k),d);
 set('users',uid,{role:'purchaser',active:true});
 set('orders',orderId,{ownerUid:uid,salesCode:'MULTI',status:'active',inventoryReservationStatus:'pending',items,deliveryRecords:[],returnRecords:[],warehouseShipmentRecords:[]});
 for(const wh of [A,B])set('warehouses',wh,{active:true});
 for(const [productKey,total,each] of [[key,6,3],[q,2,1]]){
  set('products',productKey,{productType:'Goods',active:true});set('inventory',productKey,{productKey,onHand:total,reserved:0,incoming:100,transferFreeInTransit:0});
  for(const wh of [A,B])set('warehouseStocks',wh+'__'+productKey,{productKey,warehouseId:wh,onHand:each,reserved:0,incoming:100,transferFreeInTransit:0});
 }
 await batch.commit();const initialized=await synchronizeV2OrderFixture(db,uid,{orderId,warehouseIds:[A,B]});
 await db.collection('users').doc(uid).update({role});
 const request=(itemId,quantity,operationId)=>({orderId,itemId,quantity,operationId,syncAttemptId:initialized.order.inventoryReservationAttemptId});
 return {uid,orderId,key,q,request,read:async(n,k)=>(await db.collection(n).doc(k).get()).data(),
  prepare:(itemId,quantity,operationId,actor=uid,connection=db)=>commitLocationDispatchPreparation(connection,actor,request(itemId,quantity,operationId))};
}
async function multiDispatchSnapshot(x){
 const docs={},order=await x.read('orders',x.orderId);docs.order=order;
 for(const item of order.items)docs['ledger/'+item.itemId]=await x.read('inventoryReservations',x.orderId+'__'+item.itemId);
 for(const key of [x.key,x.q])if(key){docs['inventory/'+key]=await x.read('inventory',key);
  for(const wh of [A,B])docs['stock/'+wh+'/'+key]=await x.read('warehouseStocks',wh+'__'+key);}
 for(const [collection,field] of [['dispatchRecords','orderId'],['inventoryMovements','sourceId']]){
  const query=await db.collection(collection).where(field,'==',x.orderId).get();
  docs[collection]=query.docs.map(s=>[s.id,s.data()]).sort((a,b)=>a[0].localeCompare(b[0]));
 }
 return docs;
}
test('multi-item real initialization dispatch preserves sibling lines and writes only paperwork and selected preparation',async()=>{
 const x=await multiDispatchFixture('normal'),before=await multiDispatchSnapshot(x),writes=[];
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(async tx=>fn({get:r=>tx.get(r),
  create:(r,d)=>{assert.equal(r.parent.id,'dispatchRecords');writes.push(r.path);return tx.create(r,d);},
  update:(r,d)=>{assert.equal(r.path,'orders/'+x.orderId);writes.push(r.path);return tx.update(r,d);}}))};
 const result=await x.prepare('I2',2,'multi_print_normal',x.uid,guarded);assert.equal(result.preparedQty,2);assert.equal(result.shippableQty,2);assert.equal(writes.length,2);
 const after=await multiDispatchSnapshot(x);assert.deepEqual(after.order.items[0],before.order.items[0]);assert.deepEqual(after.order.items[2],before.order.items[2]);
 for(const key of Object.keys(before).filter(k=>k!=='order'&&k!=='dispatchRecords'))assert.deepEqual(after[key],before[key],key);
 assert.deepEqual(after.order.deliveryRecords,[]);assert.deepEqual(after.order.warehouseShipmentRecords,[]);
 assert.equal(after.dispatchRecords.length,1);assert.equal(after.dispatchRecords[0][1].actorUid,x.uid);
});
test('multi-item five-line same-product dispatch cannot use supplier incoming or another lines reservation',async()=>{
 const x=await multiDispatchFixture('five',{five:true});await x.prepare('I1',3,'multi_print_five_1');await x.prepare('I2',3,'multi_print_five_2');
 const before=await multiDispatchSnapshot(x);await assert.rejects(x.prepare('I3',1,'multi_print_five_short'),/待打單數量不足/);
 assert.deepEqual(await multiDispatchSnapshot(x),before);assert.deepEqual(before.order.items.map(i=>i.dispatchPreparedQty||0),[3,3,0,0,0]);
});
test('multi-item dispatch checks five current roles active profile and role binding on replay',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const x=await multiDispatchFixture('role-'+role,{role}),before=await multiDispatchSnapshot(x);
  if(['sales','engineer'].includes(role)){await assert.rejects(x.prepare('I1',1,'multi_print_role_'+role),/權限/);assert.deepEqual(await multiDispatchSnapshot(x),before);}
  else{
   await x.prepare('I1',1,'multi_print_role_'+role);const saved=await multiDispatchSnapshot(x);
   await db.collection('users').doc(x.uid).update({active:false});await assert.rejects(x.prepare('I1',1,'multi_print_role_'+role),/權限/);
   await db.collection('users').doc(x.uid).update({active:true,role:role==='admin'?'warehouse':'admin'});
   await assert.rejects(x.prepare('I1',1,'multi_print_role_'+role),/其他交易/);assert.deepEqual(await multiDispatchSnapshot(x),saved);
  }
 }
});
test('multi-item duplicate replay and competing attempts cannot overprint the current item',async()=>{
 const x=await multiDispatchFixture('races');const same=await Promise.all([x.prepare('I1',1,'multi_print_race_same'),x.prepare('I1',1,'multi_print_race_same')]);
 assert.deepEqual(same.map(r=>r.status).sort(),['already-applied','applied']);
 const races=await Promise.allSettled([x.prepare('I2',2,'multi_print_race_a'),x.prepare('I2',2,'multi_print_race_b')]);
 assert.equal(races.filter(r=>r.status==='fulfilled').length,1);assert.equal((await x.read('orders',x.orderId)).items[1].dispatchPreparedQty,2);
 const before=await multiDispatchSnapshot(x);await assert.rejects(x.prepare('I1',2,'multi_print_race_same'),/其他交易/);assert.deepEqual(await multiDispatchSnapshot(x),before);
});
test('multi-item concurrent preparation of different lines preserves both events and source metadata',async()=>{
 const x=await multiDispatchFixture('different');await Promise.all([x.prepare('I1',3,'multi_print_diff_1'),x.prepare('I2',2,'multi_print_diff_2'),x.prepare('I3',2,'multi_print_diff_3')]);
 const order=await x.read('orders',x.orderId);assert.deepEqual(order.items.map(i=>i.dispatchPreparedQty),[3,2,2]);
 assert.equal(order.items[0].unitPrice,456);assert.deepEqual(order.items[0].custom,{note:'keep source'});
});
test('multi-item corrupt sibling ledger unknown events mixed goods and stale initialization reject without paperwork',async()=>{
 const cases=[['service',x=>db.collection('products').doc(x.q).update({productType:'SERVICE'})],
  ['ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({quantity:1})],
  ['owner',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({ownerUid:'other'})],
  ['candidates',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({lifecycleWarehouseIds:[A,'other-warehouse']})],
  ['stale',x=>db.collection('orders').doc(x.orderId).update({inventoryReservationAttemptId:'new-attempt'})],
  ['unknown',x=>db.collection('orders').doc(x.orderId).update({warehouseShipmentRecords:[{id:'unknown',itemId:'missing'}]})],
  ...['direct','duplicate','projection'].map(mode=>[mode,async x=>{const order=await x.read('orders',x.orderId);
   if(mode==='direct')order.items[2].fulfillmentType='DIRECT_SHIP';if(mode==='duplicate')order.items[2].itemId='I1';
   if(mode==='projection')order.items[2].deliveredQty=1;await db.collection('orders').doc(x.orderId).update({items:order.items});}])];
 for(const [name,mutate] of cases){const x=await multiDispatchFixture('reject-'+name);await mutate(x);const before=await multiDispatchSnapshot(x);
  await assert.rejects(x.prepare('I1',1,'multi_print_reject_'+name));assert.deepEqual(await multiDispatchSnapshot(x),before,name);}
});
test('multi-item late paperwork collision rolls back selected preparation and preserves a fixed operation retry',async()=>{
 const x=await multiDispatchFixture('rollback'),before=await multiDispatchSnapshot(x),collision=db.collection('dispatchRecords').doc('multi-print-collision');
 await collision.set({sentinel:true});const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(async tx=>fn({get:r=>tx.get(r),
  create:(r,d)=>{tx.create(collision,{sentinel:false});return tx.create(r,d);},update:(...args)=>tx.update(...args)}))};
 await assert.rejects(x.prepare('I1',1,'multi_print_rollback',x.uid,guarded),e=>e.code===6);assert.deepEqual(await multiDispatchSnapshot(x),before);
 await x.prepare('I1',1,'multi_print_rollback');assert.equal((await x.prepare('I1',1,'multi_print_rollback')).status,'already-applied');
});
test('multi-item lost dispatch reply retains one immutable event and rejects replay by a different actor',async()=>{
 const x=await multiDispatchFixture('lost');let lost=true;
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:async fn=>{const result=await db.runTransaction(async tx=>fn(tx));if(lost){lost=false;throw Error('dispatch reply lost');}return result;}};
 await assert.rejects(x.prepare('I2',1,'multi_print_lost',x.uid,guarded),/reply lost/);const once=await multiDispatchSnapshot(x);
 assert.equal((await x.prepare('I2',1,'multi_print_lost')).status,'already-applied');assert.deepEqual(await multiDispatchSnapshot(x),once);
 await db.collection('users').doc('multi-print-stranger').set({role:'admin',active:true});await assert.rejects(x.prepare('I2',1,'multi_print_lost','multi-print-stranger'),/其他交易/);
});

// These provenance fixtures extend a real single-item shipment/return with a
// seeded independent v2 sibling. They test the new reader, NOT a multi-item
// shipment/return writer, which remains closed in its original Service.
async function addDispatchSibling(x){
 const order=await x.read('orders',x.orderId),q=x.key+'-sibling';
 const item={itemId:'J',productId:q,qty:3,warehouseId:A,reservedQty:2,shortageQty:1,dispatchPreparedQty:0,deliveredQty:0,returnedQty:0};
 const batch=db.batch();batch.update(db.collection('orders').doc(x.orderId),{items:[...order.items,item]});
 batch.set(db.collection('products').doc(q),{productType:'Goods',active:true});batch.set(db.collection('inventory').doc(q),{productKey:q,onHand:2,reserved:2});
 for(const wh of [A,B])batch.set(db.collection('warehouseStocks').doc(wh+'__'+q),{productKey:q,warehouseId:wh,onHand:wh===A?2:0,reserved:wh===A?2:0});
 batch.set(db.collection('inventoryReservations').doc(x.orderId+'__J'),{locationSchemaVersion:2,orderId:x.orderId,itemId:'J',productKey:q,
  ownerUid:order.ownerUid,salesCode:order.salesCode,quantity:2,shortageQty:1,status:'active',locations:[{warehouseId:A,reservedQty:2}],lifecycleWarehouseIds:[A,B]});
 await batch.commit();return {...x,q,prepareLine:(qty,id,actor=x.uid)=>commitLocationDispatchPreparation(db,actor,{orderId:x.orderId,itemId:'J',quantity:qty,operationId:id,syncAttemptId:'sync_ship_12345'})};
}
test('multi-item dispatch uses whole-order delivery totals while verifying another items real shipment debit',async()=>{
 const source=await acknowledgementFixture('multi-history',{role:'admin',prepared:2});await source.confirm(source.deliveryRequest(2));
 const x=await addDispatchSibling(source),before=await multiDispatchSnapshot(x);await x.prepareLine(1,'multi_print_history_1');
 const order=await x.read('orders',x.orderId);assert.equal(order.deliveredQty,2);assert.equal(order.items[1].deliveredQty,0);assert.equal(order.items[1].dispatchPreparedQty,1);
 assert.deepEqual(order.items[0],before.order.items[0]);
 await db.collection('inventoryMovements').doc('location-ship-'+source.shipmentRequest.operationId).update({qty:-99});const corrupt=await multiDispatchSnapshot(x);
 await assert.rejects(x.prepareLine(1,'multi_print_history_2'),/扣帳憑證/);assert.deepEqual(await multiDispatchSnapshot(x),corrupt);
});
test('multi-item dispatch verifies all original CLOSE return proofs rather than dropping sibling returns',async()=>{
 const source=await closedRemainingFixture('multi-proof'),x=await addDispatchSibling(source);
 await x.prepareLine(1,'multi_print_close_1',x.adminUid);const original=await x.read('orders',x.orderId);
 assert.equal(original.items[1].returnedQty,0);assert.ok(original.returnedQty>0);
 const proofId=original.returnRecords[0].movementId;await db.collection('inventoryMovements').doc(proofId).update({qty:99});
 const before=await multiDispatchSnapshot(x);await assert.rejects(x.prepareLine(1,'multi_print_close_2',x.adminUid),/入庫憑證/);assert.deepEqual(await multiDispatchSnapshot(x),before);
});
test('multi-item dispatch rejects an empty return cache when another item has a real physical return proof',async()=>{
 const source=await closedRemainingFixture('multi-hidden-proof'),x=await addDispatchSibling(source),order=await x.read('orders',x.orderId);
 order.items[0].returnedQty=0;
 await db.collection('orders').doc(x.orderId).update({items:order.items,returnRecords:[],returnHistory:[],returnedQty:0});
 const before=await multiDispatchSnapshot(x);await assert.rejects(x.prepareLine(1,'multi_print_hidden_return',x.adminUid),/憑證數量/);
 assert.deepEqual(await multiDispatchSnapshot(x),before);
});


// The source is the real 1–5 line reservation/dispatch fixture above. Only
// physical lots and the originally agreed customer-shipping plan are added.
async function multiShipmentFixture(name,{five=false}={}){
 const x=await multiDispatchFixture('ship-'+name,{five});
 const order=await x.read('orders',x.orderId);
 await db.collection('orders').doc(x.orderId).update({
  items:order.items.map(item=>({...item,deliveryPlan:plan})),shippingInstructions:plan
 });
 const batch=db.batch();
 for(const [productKey,perWarehouse] of [[x.key,3],...(five?[]:[[x.q,1]])]){
  for(const wh of [A,B]){
   const lotId=productKey+'-lot-'+wh;
   batch.set(db.collection('inventoryLots').doc(lotId),{
    productKey,warehouseId:wh,remainingQty:perWarehouse,receivedQty:perWarehouse,
    lotNo:lotId,expiryDate:'2027-12-31',receivedAt:'2026-10-01T00:00:00Z',unitCost:0
   });
  }
 }
 await batch.commit();
 return {...x,ship:(itemId,wh,quantity,operationId,actor=x.uid,connection=db)=>
  commitLocationShipment(connection,actor,{...x.request(itemId,quantity,operationId),warehouseId:wh,
   date:'2026-10-18',expectedPlan:plan})};
}
async function multiShipmentSnapshot(x){
 const result=await multiDispatchSnapshot(x),lots={};
 for(const key of [x.key,x.q].filter(Boolean))for(const wh of [A,B])
  lots[key+'/'+wh]=await x.read('inventoryLots',key+'-lot-'+wh);
 return {...result,lots};
}
test('multi-line shipments debit actual A/B lots while preserving untouched sibling items and all delivery counters',async()=>{
 const x=await multiShipmentFixture('happy');
 await x.prepare('I1',2,'multi_ship_prepare_one');await x.prepare('I2',2,'multi_ship_prepare_two');
 const original=await x.read('orders',x.orderId);
 const first=await x.ship('I1',A,2,'multi_ship_issue_one');
 const second=await x.ship('I2',B,2,'multi_ship_issue_two');
 assert.equal(first.grossShippedQty,2);assert.equal(second.grossShippedQty,2);
 const order=await x.read('orders',x.orderId);
 assert.equal(order.warehouseShipmentRecords.length,2);
 assert.deepEqual(order.warehouseShipmentRecords.map(rec=>rec.itemIndex),[0,1]);
 assert.equal(order.deliveredQty,original.deliveredQty);assert.equal(order.isDelivered,original.isDelivered);
 assert.deepEqual(order.items[2],original.items[2]);
 assert.equal(order.items[0].unitPrice,456);
 assert.deepEqual(order.items[0].custom,{note:'keep source'});
 assert.deepEqual(order.items.map(row=>row.warehouseShippedQty||0),[2,2,0]);
 assert.equal((await x.read('inventory',x.key)).onHand,2);
 assert.equal((await x.read('inventoryLots',x.key+'-lot-'+A)).remainingQty,1);
 assert.equal((await x.read('inventoryLots',x.key+'-lot-'+B)).remainingQty,1);
 assert.equal((await x.ship('I1',A,2,'multi_ship_issue_one')).status,'already-applied');
 assert.equal((await x.read('orders',x.orderId)).warehouseShipmentRecords.length,2);
});
test('five-line same-product shipment cannot borrow a sibling paper amount or another warehouse hold',async()=>{
 const x=await multiShipmentFixture('five',{five:true});
 await x.prepare('I1',3,'multi_ship_five_prepare_one');
 const before=await multiShipmentSnapshot(x);
 await assert.rejects(x.ship('I2',B,1,'multi_ship_five_wrong'),/打單可出貨/);
 assert.deepEqual(await multiShipmentSnapshot(x),before);
 await x.ship('I1',A,3,'multi_ship_five_allowed');
 const order=await x.read('orders',x.orderId);
 assert.equal(order.items[0].warehouseShippedQty,3);
 assert.deepEqual(order.items.slice(1),before.order.items.slice(1));
});
test('multi-line physical shipments enforce current operator role and original operation identity',async()=>{
 const x=await multiShipmentFixture('actor');await x.prepare('I1',1,'multi_ship_actor_prep');
 for(const role of ['sales','engineer']){
  await db.collection('users').doc(x.uid).update({role});
  const before=await multiShipmentSnapshot(x);
  await assert.rejects(x.ship('I1',A,1,'multi_ship_actor_'+role),/權限/);
  assert.deepEqual(await multiShipmentSnapshot(x),before);
 }
 await db.collection('users').doc(x.uid).update({role:'admin'});
 await x.ship('I1',A,1,'multi_ship_actor_ok');
 const saved=await multiShipmentSnapshot(x);
 await db.collection('users').doc(x.uid).update({role:'warehouse'});
 await assert.rejects(x.ship('I1',A,1,'multi_ship_actor_ok'),/其他交易/);
 assert.deepEqual(await multiShipmentSnapshot(x),saved);
 await db.collection('users').doc(x.uid).update({active:false});
 await assert.rejects(x.ship('I1',A,1,'multi_ship_actor_ok'),/權限/);
});
test('multi-line shipment replay, over-shipment and concurrent sibling issues preserve physical stock once',async()=>{
 const x=await multiShipmentFixture('races');await x.prepare('I1',2,'multi_ship_race_p1');
 await x.prepare('I2',2,'multi_ship_race_p2');
 const same=await Promise.all([x.ship('I1',A,1,'multi_ship_race_same'),x.ship('I1',A,1,'multi_ship_race_same')]);
 assert.deepEqual(same.map(v=>v.status).sort(),['already-applied','applied']);
 const both=await Promise.all([x.ship('I1',A,1,'multi_ship_race_diff'),x.ship('I2',B,2,'multi_ship_race_sibling')]);
 assert.equal(both.length,2);
 const baseline=await multiShipmentSnapshot(x);
 await assert.rejects(x.ship('I2',B,1,'multi_ship_race_extra'),/打單可出貨|已超額/);
 assert.deepEqual(await multiShipmentSnapshot(x),baseline);
 assert.equal((await x.read('inventory',x.key)).onHand,2);
});
test('multi-line shipment rejects a corrupt sibling ledger or historical physical debit without any new stock writes',async()=>{
 for(const [name,breakSource] of [
  ['ledger',x=>db.collection('inventoryReservations').doc(x.orderId+'__I3').update({ownerUid:'forged'})],
  ['product',x=>db.collection('products').doc(x.q).update({productType:'SERVICE'})],
  ['direct',async x=>{const o=await x.read('orders',x.orderId);o.items[2].fulfillmentType='DIRECT_SHIP';await db.collection('orders').doc(x.orderId).update({items:o.items});}],
  ['movement',async x=>{
   await x.ship('I1',A,1,'multi_ship_corrupt_first');
   await db.collection('inventoryMovements').doc('location-ship-multi_ship_corrupt_first').update({qty:0});
  }]
 ]){
  const x=await multiShipmentFixture('reject-'+name);
  await x.prepare('I1',2,'multi_ship_reject_prepare_'+name);
  await breakSource(x);
  const before=await multiShipmentSnapshot(x);
  await assert.rejects(x.ship('I1',A,1,'multi_ship_reject_attempt_'+name));
  assert.deepEqual(await multiShipmentSnapshot(x),before,name);
 }
});
test('multi-line shipment late movement collision rolls back stock and lot; fixed ID retries safely',async()=>{
 const x=await multiShipmentFixture('rollback');await x.prepare('I1',1,'multi_ship_rollback_prepare');
 const before=await multiShipmentSnapshot(x),collision=db.collection('inventoryMovements').doc('multi-ship-collision');
 await collision.set({sentinel:true});
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(async tx=>fn({
  get:r=>tx.get(r),set:(...args)=>tx.set(...args),update:(...args)=>tx.update(...args),
  create:(ref,record)=>{tx.create(collision,{sentinel:false});return tx.create(ref,record);}
 }))};
 await assert.rejects(x.ship('I1',A,1,'multi_ship_rollback_op',x.uid,guarded),e=>e.code===6);
 assert.deepEqual(await multiShipmentSnapshot(x),before);
 assert.equal((await x.ship('I1',A,1,'multi_ship_rollback_op')).status,'applied');
 assert.equal((await x.ship('I1',A,1,'multi_ship_rollback_op')).status,'already-applied');
});


const {commitShipmentDelivery:confirmMultiDelivery}=require('../functions/shipment-delivery-service');
async function multiDeliveryFixture(name,options={}){
 const x=await multiShipmentFixture('delivery-'+name,options);
 const adminUid='delivery-admin-'+name,anotherUid='delivery-foreign-'+name;
 await db.collection('users').doc(adminUid).set({role:'admin',active:true});
 await db.collection('users').doc(anotherUid).set({role:'sales',active:true});
 const ack=(itemId,shipmentId,quantity,operationId,actor=adminUid,connection=db,date='2026-10-19')=>
  confirmMultiDelivery(connection,actor,{...x.request(itemId,quantity,operationId),
   shipmentId,date});
 return {...x,adminUid,anotherUid,ack};
}
test('multi-item acknowledgement updates selected line and whole-order total without touching physical stock',async()=>{
 const x=await multiDeliveryFixture('partial');
 await x.prepare('I1',2,'multi_ack_prep_1');await x.prepare('I2',2,'multi_ack_prep_2');
 await x.ship('I1',A,2,'multi_ack_ship_1');await x.ship('I2',B,2,'multi_ack_ship_2');
 const before=await multiShipmentSnapshot(x);
 const result=await x.ack('I2','multi_ack_ship_2',1,'multi_ack_confirm_1');
 assert.equal(result.confirmedQty,1);assert.equal(result.pendingDeliveryQty,1);
 assert.equal(result.isDelivered,false);assert.equal(result.itemIsDelivered,false);
 const order=await x.read('orders',x.orderId);
 assert.equal(order.deliveredQty,1);assert.equal(order.isDelivered,false);
 assert.deepEqual(order.items.map(row=>row.deliveredQty||0),[0,1,0]);
 assert.deepEqual(order.items[0],before.order.items[0]);
 assert.deepEqual(order.items[2],before.order.items[2]);
 const after=await multiShipmentSnapshot(x);
 for(const field of Object.keys(before).filter(k=>k!=='order'))assert.deepEqual(after[field],before[field],field);
 assert.equal(order.deliveryRecords.length,1);assert.equal(order.deliveryHistory.length,1);
 const second=await x.ack('I1','multi_ack_ship_1',2,'multi_ack_confirm_2');
 assert.equal(second.confirmedQty,2);assert.equal((await x.read('orders',x.orderId)).deliveredQty,3);
});
test('multi-item confirmations can partially acknowledge one shipment without accepting another items shipmentId',async()=>{
 const x=await multiDeliveryFixture('partial-same');
 await x.prepare('I1',3,'multi_ack_partial_prepare');await x.ship('I1',A,3,'multi_ack_partial_ship');
 await x.ack('I1','multi_ack_partial_ship',1,'multi_ack_partial_one');
 const next=await x.ack('I1','multi_ack_partial_ship',2,'multi_ack_partial_two');
 assert.equal(next.pendingDeliveryQty,0);assert.equal(next.confirmedQty,3);
 assert.equal((await x.read('orders',x.orderId)).deliveredQty,3);
 const before=await multiShipmentSnapshot(x);
 await assert.rejects(x.ack('I2','multi_ack_partial_ship',1,'multi_ack_wrong_item'));
 await assert.rejects(x.ack('I1','multi_ack_partial_ship',1,'multi_ack_excess'));
 assert.deepEqual(await multiShipmentSnapshot(x),before);
});
test('multi-item delivery accepts current admin or own sales engineer and rejects warehouse purchaser or unrelated users',async()=>{
 const x=await multiDeliveryFixture('roles');await x.prepare('I1',2,'multi_ack_role_prep');await x.ship('I1',A,2,'multi_ack_role_ship');
 await db.collection('users').doc(x.uid).update({role:'sales'});
 const first=await x.ack('I1','multi_ack_role_ship',1,'multi_ack_role_sales',x.uid);
 assert.equal(first.confirmedQty,1);
 await db.collection('users').doc(x.uid).update({role:'engineer'});
 const second=await x.ack('I1','multi_ack_role_ship',1,'multi_ack_role_engineer',x.uid);
 assert.equal(second.confirmedQty,2);
 const before=await multiShipmentSnapshot(x);
 await db.collection('users').doc(x.uid).update({role:'warehouse'});
 await assert.rejects(x.ack('I1','multi_ack_role_ship',1,'multi_ack_role_warehouse',x.uid),/權限/);
 await db.collection('users').doc(x.uid).update({role:'purchaser'});
 await assert.rejects(x.ack('I1','multi_ack_role_ship',1,'multi_ack_role_purchaser',x.uid),/權限/);
 await assert.rejects(x.ack('I1','multi_ack_role_ship',1,'multi_ack_role_other',x.anotherUid),/只能確認自己/);
 await db.collection('users').doc(x.adminUid).update({active:false});
 await assert.rejects(x.ack('I1','multi_ack_role_ship',1,'multi_ack_role_admin',x.adminUid),/權限/);
 assert.deepEqual(await multiShipmentSnapshot(x),before);
});
test('multi-item same operation replays once and different actor or intent cannot claim its confirmation',async()=>{
 const x=await multiDeliveryFixture('replay');await x.prepare('I1',2,'multi_ack_replay_prep');await x.ship('I1',A,2,'multi_ack_replay_ship');
 const same=await Promise.all([x.ack('I1','multi_ack_replay_ship',1,'multi_ack_replay_id'),x.ack('I1','multi_ack_replay_ship',1,'multi_ack_replay_id')]);
 assert.deepEqual(same.map(v=>v.status).sort(),['already-applied','applied']);
 const before=await multiShipmentSnapshot(x);
 assert.equal((await x.ack('I1','multi_ack_replay_ship',1,'multi_ack_replay_id')).status,'already-applied');
 await assert.rejects(x.ack('I1','multi_ack_replay_ship',2,'multi_ack_replay_id'),/其他交易/);
 await assert.rejects(x.ack('I1','multi_ack_replay_ship',1,'multi_ack_replay_id',x.anotherUid),/權限|其他交易|只能確認自己/);
 assert.deepEqual(await multiShipmentSnapshot(x),before);
});
test('multi-item competing quantities cannot overconfirm and simultaneous different items retain both records',async()=>{
 const x=await multiDeliveryFixture('races');
 await x.prepare('I1',2,'multi_ack_race_p1');await x.prepare('I2',2,'multi_ack_race_p2');
 await x.ship('I1',A,2,'multi_ack_race_s1');await x.ship('I2',B,2,'multi_ack_race_s2');
 const race=await Promise.allSettled([
  x.ack('I1','multi_ack_race_s1',2,'multi_ack_race_a'),
  x.ack('I1','multi_ack_race_s1',2,'multi_ack_race_b')
 ]);
 assert.equal(race.filter(v=>v.status==='fulfilled').length,1);
 await x.ack('I2','multi_ack_race_s2',1,'multi_ack_race_c');
 const order=await x.read('orders',x.orderId);
 assert.deepEqual(order.items.map(row=>row.deliveredQty||0),[2,1,0]);
 assert.equal(order.deliveredQty,3);assert.equal(order.deliveryRecords.length,2);
});
test('multi-item acknowledgement refuses corrupted sibling physical debit and never hides other-line returns',async()=>{
 for(const mode of ['missing','wrong-debit','hidden-return']){
  const x=await multiDeliveryFixture('evidence-'+mode);
  await x.prepare('I1',1,'multi_ack_evidence_p1_'+mode);
  await x.prepare('I2',1,'multi_ack_evidence_p2_'+mode);
  await x.ship('I1',A,1,'multi_ack_evidence_s1_'+mode);
  await x.ship('I2',B,1,'multi_ack_evidence_s2_'+mode);
  if(mode==='missing')await db.collection('inventoryMovements').doc('location-ship-multi_ack_evidence_s2_'+mode).delete();
  if(mode==='wrong-debit')await db.collection('inventoryMovements').doc('location-ship-multi_ack_evidence_s2_'+mode).update({qty:0});
  if(mode==='hidden-return')await db.collection('inventoryMovements').doc('phantom-return-'+mode).set({
   action:'location_customer_return',sourceId:x.orderId,itemId:'I2',qty:1
  });
  const before=await multiShipmentSnapshot(x);
  await assert.rejects(x.ack('I1','multi_ack_evidence_s1_'+mode,1,'multi_ack_evidence_delivery_'+mode));
  assert.deepEqual(await multiShipmentSnapshot(x),before,mode);
 }
});
test('multi-item stale totals, unknown events and mixed direct-ship siblings reject without delivery writes',async()=>{
 const modes=[
  ['totals',order=>({deliveredQty:10})],
  ['sibling',order=>({items:order.items.map((row,i)=>i===2?{...row,deliveredQty:2}:row)})],
  ['mixed',order=>({items:order.items.map((row,i)=>i===2?{...row,fulfillmentType:'DIRECT_SHIP'}:row)})],
  ['unknown',order=>({deliveryRecords:[{id:'foreign',orderId:order.id,itemId:'missing'}]})]
 ];
 for(const [name,change] of modes){
  const x=await multiDeliveryFixture('invalid-'+name);
  await x.prepare('I1',1,'multi_ack_invalid_p_'+name);await x.ship('I1',A,1,'multi_ack_invalid_s_'+name);
  const order=await x.read('orders',x.orderId);
  await db.collection('orders').doc(x.orderId).update(change(order));
  const before=await multiShipmentSnapshot(x);
  await assert.rejects(x.ack('I1','multi_ack_invalid_s_'+name,1,'multi_ack_invalid_d_'+name));
  assert.deepEqual(await multiShipmentSnapshot(x),before,name);
 }
});
test('multi-item failed delivery document update rolls back confirmation and same operation retries safely',async()=>{
 const x=await multiDeliveryFixture('rollback');
 await x.prepare('I1',1,'multi_ack_rollback_p');await x.ship('I1',A,1,'multi_ack_rollback_s');
 const before=await multiShipmentSnapshot(x);
 const guarded={projectId:db.projectId,collection:n=>db.collection(n),runTransaction:fn=>db.runTransaction(async tx=>fn({
  get:r=>tx.get(r),update:(ref,data)=>{tx.update(ref,data);tx.create(db.collection('orders').doc(x.orderId),{collision:true});}
 }))};
 await assert.rejects(x.ack('I1','multi_ack_rollback_s',1,'multi_ack_rollback_d',x.adminUid,guarded));
 assert.deepEqual(await multiShipmentSnapshot(x),before);
 assert.equal((await x.ack('I1','multi_ack_rollback_s',1,'multi_ack_rollback_d')).status,'applied');
 assert.equal((await x.ack('I1','multi_ack_rollback_s',1,'multi_ack_rollback_d')).status,'already-applied');
});

test('whole-order delivery becomes complete only after every real line and shipment has been acknowledged',async()=>{
 const name='full-two-line',uid='full-ack-purchaser',actor='full-ack-admin',
  orderId='full-ack-order',key='full-ack-product';
 const batch=db.batch(),set=(coll,id,data)=>batch.set(db.collection(coll).doc(id),data);
 set('users',uid,{role:'purchaser',active:true});set('users',actor,{role:'admin',active:true});
 set('products',key,{productType:'Goods',active:true});
 set('orders',orderId,{ownerUid:uid,salesCode:'FULL',status:'active',
  inventoryReservationStatus:'pending',items:[
   {itemId:'I1',productId:key,qty:3,warehouseId:A,deliveryPlan:plan},
   {itemId:'I2',productId:key,qty:3,warehouseId:B,deliveryPlan:plan}
  ],deliveryRecords:[],returnRecords:[],warehouseShipmentRecords:[]});
 set('inventory',key,{productKey:key,onHand:6,reserved:0,incoming:0,transferFreeInTransit:0});
 for(const wh of [A,B]){
  set('warehouses',wh,{active:true});
  set('warehouseStocks',wh+'__'+key,{productKey:key,warehouseId:wh,onHand:3,reserved:0,incoming:0,transferFreeInTransit:0});
  set('inventoryLots',key+'-'+wh,{productKey:key,warehouseId:wh,remainingQty:3,receivedQty:3,
   lotNo:'BATCH-'+wh,expiryDate:'2027-12-31',receivedAt:'2026-10-18T00:00:00Z',unitCost:0});
 }
 await batch.commit();
 const initialized=await synchronizeV2OrderFixture(db,uid,{orderId,warehouseIds:[A,B]});
 const syncAttemptId=initialized.order.inventoryReservationAttemptId;
 for(const item of [{itemId:'I1',warehouseId:A},{itemId:'I2',warehouseId:B}]){
  await commitLocationDispatchPreparation(db,uid,{orderId,itemId:item.itemId,quantity:3,
   operationId:'full_ack_prepare_'+item.itemId,syncAttemptId});
  await commitLocationShipment(db,uid,{orderId,itemId:item.itemId,warehouseId:item.warehouseId,
   quantity:3,operationId:'full_ack_ship_'+item.itemId,syncAttemptId,date:'2026-10-19',expectedPlan:plan});
 }
 const intent=itemId=>({orderId,itemId,shipmentId:'full_ack_ship_'+itemId,
  quantity:3,operationId:'full_ack_delivery_'+itemId,syncAttemptId,date:'2026-10-19'});
 const first=await confirmMultiDelivery(db,actor,intent('I1'));
 assert.equal(first.itemIsDelivered,true);assert.equal(first.isDelivered,false);
 const half=(await db.collection('orders').doc(orderId).get()).data();
 assert.equal(half.deliveredQty,3);assert.equal(half.isDelivered,false);
 const second=await confirmMultiDelivery(db,actor,intent('I2'));
 assert.equal(second.itemIsDelivered,true);assert.equal(second.isDelivered,true);
 const completed=(await db.collection('orders').doc(orderId).get()).data();
 assert.equal(completed.deliveredQty,6);assert.equal(completed.isDelivered,true);
 assert.deepEqual(completed.items.map(row=>row.deliveredQty),[3,3]);
 const beforeLots=await Promise.all([A,B].map(wh=>db.collection('inventoryLots').doc(key+'-'+wh).get()));
 assert.deepEqual(beforeLots.map(s=>s.data().remainingQty),[0,0]);
 assert.equal((await confirmMultiDelivery(db,actor,intent('I2'))).status,'already-applied');
 const after=(await db.collection('orders').doc(orderId).get()).data();
 assert.deepEqual(after,completed);
 assert.deepEqual((await Promise.all([A,B].map(wh=>db.collection('inventoryLots').doc(key+'-'+wh).get()))).map(s=>s.data().remainingQty),[0,0]);
});
