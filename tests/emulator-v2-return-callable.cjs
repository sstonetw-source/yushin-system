'use strict';
// Real Auth SDK -> Callable SDK -> original v2 return Services -> Firestore.
// Source documents are Admin fixtures; inventory synchronization now runs the real src workflow.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const {synchronizeV2OrderFixture}=require('./fixtures/v2-order-initialization.cjs');
const {commitLocationDispatchPreparation}=require('../functions/location-dispatch-service');
const {commitLocationShipment}=require('../functions/location-shipment-service');
const {commitShipmentDelivery}=require('../functions/shipment-delivery-service');
const {commitSingleItemLocationLifecycle}=require('../functions/single-item-location-lifecycle-service');
const project='demo-yushin',clients=[];let server,db,accounts;
test.before(()=>{
 for(const name of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])assert.match(process.env[name]||'',/^(127\.0\.0\.1|localhost):[0-9]+$/);
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,project);
 server=admin.initializeApp({projectId:project},'v2-return-callable-auth');db=getFirestore(server);accounts=adminAuth(server);
});
test.after(async()=>{await Promise.all(clients.map(deleteApp));if(server)await server.delete();});
async function identity(tag,role='sales',{profile=true,login=true}={}){
 const uid='return-auth-'+tag,email=uid+'@example.test';
 const app=initializeApp({apiKey:'fake-api-key',authDomain:project+'.firebaseapp.com',projectId:project,appId:'return-auth-test'},uid);clients.push(app);
 const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 if(login){await accounts.createUser({uid,email,password:'EmulatorOnly!123456'});await signInWithEmailAndPassword(auth,email,'EmulatorOnly!123456');}
 if(profile)await db.collection('users').doc(uid).set({role,active:true});
 const functions=getFunctions(app,'asia-east1');connectFunctionsEmulator(functions,'127.0.0.1',5001);
 return {uid,auth,preview:input=>httpsCallable(functions,'previewV2CustomerReturn',{timeout:30000})(input).then(r=>r.data),
  receive:input=>httpsCallable(functions,'receiveV2CustomerReturn',{timeout:30000})(input).then(r=>r.data)};
}
async function fixture(tag,{role='sales',cancelled=true}={}){
 const actor=await identity(tag,role),operator=await identity(tag+'-operator','admin');
 const orderId='return-order-'+tag,key='return-product-'+tag;let syncAttemptId='return_auth_sync_'+tag;
 const plan={mode:'CUSTOMER_SHIP',contact:'測試客戶',phone:'02-12345678',address:'台北市測試地址'};
 const batch=db.batch(),set=(n,k,d)=>batch.set(db.collection(n).doc(k),d);
 set('products',key,{productType:'Goods'});set('orders',orderId,{ownerUid:actor.uid,salesCode:'R',status:'active',orderStatus:'normal',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:syncAttemptId,deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
  items:[{itemId:'I',productId:key,qty:10,warehouseId:'AUTH-A',reservedQty:0,returnedQty:0,deliveredQty:0,dispatchPreparedQty:0,deliveryPlan:plan,fulfillmentType:'WAREHOUSE'}]});
 set('inventory',key,{productKey:key,onHand:16,reserved:2,transferFreeInTransit:1});
 for(const [wh,onHand,reserved,transit] of [['AUTH-A',6,2,0],['AUTH-B',10,0,1]]){
  set('warehouses',wh,{active:true});set('warehouseStocks',wh+'__'+key,{warehouseId:wh,productKey:key,onHand,reserved,transferFreeInTransit:transit});
  set('inventoryLots',key+'-'+wh,{productKey:key,warehouseId:wh,receivedQty:onHand,remainingQty:onHand,lotNo:wh,expiryDate:'2028-01-01',unitCost:98765});
 }
 await batch.commit();
 const initialized=await synchronizeV2OrderFixture(db,operator.uid,{orderId,warehouseIds:['AUTH-A','AUTH-B']});
 syncAttemptId=initialized.order.inventoryReservationAttemptId;
 assert.equal(initialized.order.inventoryReservationStatus,'completed');
 await commitLocationDispatchPreparation(db,operator.uid,{orderId,itemId:'I',quantity:4,operationId:'return_auth_prepare_'+tag,syncAttemptId});
 const shipmentId='return_auth_shipment_'+tag;
 await commitLocationShipment(db,operator.uid,{orderId,itemId:'I',warehouseId:'AUTH-A',quantity:4,operationId:shipmentId,syncAttemptId,date:'2026-10-17',expectedPlan:plan});
 await commitShipmentDelivery(db,operator.uid,{orderId,itemId:'I',shipmentId,quantity:4,operationId:'return_auth_delivery_'+tag,syncAttemptId,date:'2026-10-18'});
 const lifecycle=nextStatus=>commitSingleItemLocationLifecycle(db,operator.uid,{orderId,itemId:'I',warehouseIds:['AUTH-A','AUTH-B'],nextStatus,
  operationId:'return_auth_lifecycle_'+tag+'_'+nextStatus,syncAttemptId,date:'2026-10-19',reason:'測試取消／恢復'});
 if(cancelled)await lifecycle('cancelled');
 const trace={orderId,itemId:'I',shipmentId,syncAttemptId,selections:[{lotId:key+'-AUTH-A',qty:1}]};
 const intent={...trace,operationId:'return_auth_receipt_'+tag,warehouseId:'AUTH-A',date:'2026-10-20',reason:'訂錯貨結案退回',condition:'RESTOCKABLE',settlement:'CLOSE'};
 return {actor,operator,orderId,key,trace,intent,lifecycle,
  data:async(n,k)=>(await db.collection(n).doc(k).get()).data()};
}
async function snapshot(x){
 const documents=[];
 for(const [n,k] of [['orders',x.orderId],['inventory',x.key],['inventoryReservations',x.orderId+'__I'],
  ['warehouseStocks','AUTH-A__'+x.key],['warehouseStocks','AUTH-B__'+x.key],['inventoryLots',x.key+'-AUTH-A'],['inventoryLots',x.key+'-AUTH-B']])documents.push(await x.data(n,k));
 const movements=await db.collection('inventoryMovements').where('sourceId','==',x.orderId).get();
 return {documents,movements:movements.docs.map(s=>({id:s.id,...s.data()}))};
}
const code=expected=>error=>error.code==='functions/'+expected;
test('real signed-in owner previews and CLOSE receives normal and cancelled orders with immutable retry and remaining restoration',async()=>{
 for(const cancelled of [false,true]){
  const x=await fixture('flow-'+cancelled,{cancelled}),before=await snapshot(x),preview=await x.actor.preview(x.trace);
  assert.equal(preview.canCommit,false);assert.equal(preview.remainingReturnQty,4);assert.equal(JSON.stringify(preview).includes('98765'),false);
  assert.deepEqual(await snapshot(x),before);
  const receipt=await x.actor.receive(x.intent);assert.equal(receipt.status,'applied');assert.equal(receipt.reservedQty,cancelled?0:6);
  const after=await snapshot(x);assert.equal(after.documents[1].onHand,13);assert.equal(after.documents[1].reserved,cancelled?2:8);
  assert.equal(after.documents[0].status,cancelled?'cancelled':'active');
  assert.equal(after.movements.find(m=>m.id===receipt.movementId).actorUid,x.actor.uid);
  assert.equal((await x.actor.receive(x.intent)).status,'already-applied');assert.deepEqual(await snapshot(x),after);
  const remaining=await x.actor.preview(x.trace);assert.equal(remaining.previousReturnedQty,1);assert.equal(remaining.remainingReturnQty,3);
  if(cancelled)assert.equal((await x.lifecycle('normal')).reservedQty,6);
 }
});
test('real sign-in preserves five read-only roles and only commercial roles may receive customer returns',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await fixture('roles-'+role,{role}),before=await snapshot(x);
  assert.equal((await x.actor.preview(x.trace)).canCommit,false);assert.deepEqual(await snapshot(x),before);
  if(['admin','sales','engineer'].includes(role))assert.equal((await x.actor.receive(x.intent)).reservedQty,0);
  else{await assert.rejects(x.actor.receive(x.intent),code('permission-denied'));assert.deepEqual(await snapshot(x),before);}
 }
});
test('authenticated UID cannot be replaced by payload role owner or receipt replay identity',async()=>{
 const x=await fixture('spoof'),stranger=await identity('stranger'),before=await snapshot(x);
 await assert.rejects(stranger.preview(x.trace),code('permission-denied'));await assert.rejects(stranger.receive(x.intent),code('permission-denied'));
 for(const patch of [{actorUid:x.operator.uid},{uid:x.operator.uid},{actorRole:'admin'},{auth:{uid:x.operator.uid}}])
  await assert.rejects(x.actor.receive({...x.intent,...patch}),code('invalid-argument'));
 assert.deepEqual(await snapshot(x),before);await x.actor.receive(x.intent);const after=await snapshot(x);
 await assert.rejects(x.operator.receive(x.intent),code('already-exists'));assert.deepEqual(await snapshot(x),after);
});
test('issued tokens and custom role claims cannot bypass current Firestore roles or inactive accounts including retry',async()=>{
 const x=await fixture('role-change');await x.actor.receive(x.intent);const after=await snapshot(x);
 await db.collection('users').doc(x.actor.uid).update({role:'warehouse'});
 await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});await x.actor.auth.currentUser.getIdToken(true);
 await assert.rejects(x.actor.receive(x.intent),code('permission-denied'));assert.equal((await x.actor.preview(x.trace)).canCommit,false);
 await db.collection('users').doc(x.actor.uid).update({active:false});
 await assert.rejects(x.actor.preview(x.trace),code('permission-denied'));await assert.rejects(x.actor.receive(x.intent),code('permission-denied'));
 assert.deepEqual(await snapshot(x),after);
});
test('missing tokens invalid tokens and authenticated identities without a profile cannot read or write a return',async()=>{
 const x=await fixture('unauth'),anonymous=await identity('anonymous','sales',{login:false,profile:false}),unprofiled=await identity('unprofiled','sales',{profile:false});
 const before=await snapshot(x);
 for(const method of ['preview','receive']){
  const input=method==='preview'?x.trace:x.intent;
  await assert.rejects(anonymous[method](input),code('unauthenticated'));await assert.rejects(unprofiled[method](input),code('permission-denied'));
 }
 const response=await fetch('http://127.0.0.1:5001/demo-yushin/asia-east1/receiveV2CustomerReturn',{
  method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer malformed-token'},body:JSON.stringify({data:x.intent})});
 assert.equal(response.status,401);assert.equal((await response.json()).error.status,'UNAUTHENTICATED');assert.deepEqual(await snapshot(x),before);
});
test('simultaneous authenticated retries post exactly one physical return and altered intent cannot reuse its ID',async()=>{
 const x=await fixture('race'),results=await Promise.all([x.actor.receive(x.intent),x.actor.receive(x.intent)]);
 assert.equal(results.filter(r=>r.status==='applied').length,1);assert.equal(results.filter(r=>r.status==='already-applied').length,1);
 const after=await snapshot(x);assert.equal(after.documents[1].onHand,13);assert.equal(after.movements.filter(m=>m.action==='location_customer_return').length,1);
 await assert.rejects(x.actor.receive({...x.intent,reason:'另一意圖'}),code('already-exists'));assert.deepEqual(await snapshot(x),after);
});
test('authenticated calls still reject a superseded inventory sync checkpoint before preview or stock changes',async()=>{
 const x=await fixture('stale');await db.collection('orders').doc(x.orderId).update({inventoryReservationAttemptId:'superseding_return_auth_sync'});const before=await snapshot(x);
 await assert.rejects(x.actor.preview(x.trace),code('failed-precondition'));await assert.rejects(x.actor.receive(x.intent),code('failed-precondition'));
 assert.deepEqual(await snapshot(x),before);
});
