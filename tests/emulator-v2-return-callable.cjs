'use strict';
// Real Auth SDK -> Callable SDK -> original v2 return Services -> Firestore.
// Source documents are Admin fixtures; inventory synchronization now runs the real src workflow.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const {getFirestore:clientFirestore,connectFirestoreEmulator,doc,collection,getDoc,runTransaction,setDoc}=require('firebase/firestore');
const procurementDemandCore=require('../modules/procurement-demand-core');
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
 return {uid,auth,app,functions,dispatch:input=>httpsCallable(functions,'prepareV2OrderDispatch',{timeout:30000})(input).then(r=>r.data),
  ship:input=>httpsCallable(functions,'shipV2WarehouseItem',{timeout:30000})(input).then(r=>r.data),preview:input=>httpsCallable(functions,'previewV2CustomerReturn',{timeout:30000})(input).then(r=>r.data),
  receive:input=>httpsCallable(functions,'receiveV2CustomerReturn',{timeout:30000})(input).then(r=>r.data)};
}
async function fixture(tag,{role='sales',cancelled=true,multi=false}={}){
 const actor=await identity(tag,role),operator=await identity(tag+'-operator','admin');
 const orderId='return-order-'+tag,key='return-product-'+tag;let syncAttemptId='return_auth_sync_'+tag;
 const plan={mode:'CUSTOMER_SHIP',contact:'測試客戶',phone:'02-12345678',address:'台北市測試地址'};
 const batch=db.batch(),set=(n,k,d)=>batch.set(db.collection(n).doc(k),d);
 set('products',key,{productType:'Goods'});if(!multi)set('orders',orderId,{ownerUid:actor.uid,salesCode:'R',status:'active',orderStatus:'normal',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:syncAttemptId,deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
  items:[{itemId:'I',productId:key,qty:10,warehouseId:'AUTH-A',reservedQty:0,returnedQty:0,deliveredQty:0,dispatchPreparedQty:0,deliveryPlan:plan,fulfillmentType:'WAREHOUSE'}]});
 set('inventory',key,{productKey:key,onHand:16,reserved:2,transferFreeInTransit:1});
 if(multi){
  const source={ownerUid:actor.uid,salesCode:'R',status:'active',orderStatus:'normal',inventoryReservationStatus:'pending',
   inventoryReservationAttemptId:syncAttemptId,deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
   items:[{itemId:'I',productId:key,qty:10,warehouseId:'AUTH-A',deliveryPlan:plan},
    {itemId:'I2',productId:key,qty:2,warehouseId:'AUTH-B',deliveryPlan:plan},{itemId:'I3',productId:key+'-Q',qty:3,warehouseId:'AUTH-B',deliveryPlan:plan}]};
  set('orders',orderId,source);set('products',key+'-Q',{productType:'Goods'});set('inventory',key+'-Q',{productKey:key+'-Q',onHand:6,reserved:0,transferFreeInTransit:0});
  for(const wh of ['AUTH-A','AUTH-B']){set('warehouseStocks',wh+'__'+key+'-Q',{warehouseId:wh,productKey:key+'-Q',onHand:3,reserved:0,transferFreeInTransit:0});
   set('inventoryLots',key+'-Q-'+wh,{productKey:key+'-Q',warehouseId:wh,receivedQty:3,remainingQty:3,lotNo:wh,expiryDate:'2028-01-01'});}
 }
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

test('real signed-in client creates an order through the existing Order Creation Service and Rules before genuine v2 synchronization',async()=>{
 const actor=await identity('client-create','sales'),unauthorized=await identity('client-create-warehouse','warehouse');
 await db.collection('users').doc(actor.uid).update({salesCode:'R'});
 const orderId='return-client-created',key='return-client-product';
 const setup=db.batch(),put=(collection,id,value)=>setup.set(db.collection(collection).doc(id),value);
 put('products',key,{productType:'Goods'});
 put('inventory',key,{productKey:key,onHand:7,reserved:0,transferFreeInTransit:0});
 for(const [id,quantity] of [['CLIENT-A',3],['CLIENT-B',4]]){
  put('warehouses',id,{active:true});
  put('warehouseStocks',id+'__'+key,{warehouseId:id,productKey:key,onHand:quantity,reserved:0,transferFreeInTransit:0});
 }
 await setup.commit();
 const liveDb=clientFirestore(actor.app);connectFirestoreEmulator(liveDb,'127.0.0.1',8080);
 const transport={
  currentUser:{uid:actor.uid},currentUserRole:'sales',BUSINESS_STATUS:{ACTIVE:'active'},
  db:{collection:name=>({doc:id=>doc(liveDb,name,id)})},
  runRoleTransaction:callback=>runTransaction(liveDb,async transaction=>callback({
   get:async ref=>{const snapshot=await transaction.get(ref);return {exists:snapshot.exists(),data:()=>snapshot.data()};},
   set:(ref,value,options)=>options
    ?transaction.set(ref,JSON.parse(JSON.stringify(value)),options)
    :transaction.set(ref,JSON.parse(JSON.stringify(value))),
   update:(ref,value)=>transaction.update(ref,JSON.parse(JSON.stringify(value)))
  }))
 };
 const context=vm.createContext(transport);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/services/order-creation.js'),'utf8'),context);
 const order={status:'active',orderStatus:'normal',createdByUid:actor.uid,createdByRole:'sales',
  ownerUid:actor.uid,salesCode:'R',customerName:'真實登入建單測試',productId:key,productMasterMatched:true,
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'auth_client_initial',
  deliveryRecords:[],returnRecords:[],deliveredQty:0,isDelivered:false,
  items:[{itemId:'I',productId:key,qty:10,warehouseId:'CLIENT-A',reservedQty:0,
   deliveredQty:0,returnedQty:0,fulfillmentType:'WAREHOUSE'}]};
 const create=(id,data)=>context.commitOrderCreation(id,data,{actorUid:actor.uid,actorRole:'sales'});
 await assert.rejects(create(orderId+'-cost',{...order,items:[{...order.items[0],unitCost:100}]}),error=>error.code==='permission-denied');
 assert.equal((await db.collection('orders').doc(orderId+'-cost').get()).exists,false);
 const warehouseDb=clientFirestore(unauthorized.app);connectFirestoreEmulator(warehouseDb,'127.0.0.1',8080);
 await assert.rejects(setDoc(doc(warehouseDb,'orders',orderId+'-warehouse'),{...order,createdByUid:unauthorized.uid}),
  error=>error.code==='permission-denied');
 assert.equal((await db.collection('orders').doc(orderId+'-warehouse').get()).exists,false);
 const created=await create(orderId,order);assert.equal(created.id,orderId);
 const before=(await db.collection('orders').doc(orderId).get()).data();
 assert.equal(before.createdByUid,actor.uid);
 assert.equal(before.inventoryReservationStatus,'pending');
 assert.equal((await db.collection('inventory').doc(key).get()).data().reserved,0);
 const initialized=await synchronizeV2OrderFixture(db,actor.uid,{orderId,warehouseIds:['CLIENT-A','CLIENT-B']});
 assert.equal(initialized.order.inventoryReservationStatus,'completed');
 const after=(await db.collection('orders').doc(orderId).get()).data();
 assert.equal(after.items[0].reservedQty,7);assert.equal(after.items[0].shortageQty,3);
 assert.equal((await db.collection('inventory').doc(key).get()).data().reserved,7);
 const demandId=procurementDemandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:'I'});
 const demand=(await db.collection('procurementDemands').doc(encodeURIComponent(demandId)).get()).data();
 assert.equal(demand.requestedQty,3);
 const replay=await create(orderId,{...order,customerName:'不應覆蓋原訂單'});
 assert.equal(replay.data.customerName,order.customerName);
 assert.equal((await db.collection('orders').doc(orderId).get()).data().customerName,order.customerName);
 assert.equal((await db.collection('inventory').doc(key).get()).data().reserved,7);
});

const code=expected=>error=>error.code==='functions/'+expected;
async function dispatchUI(x,actor=x.actor,role='purchaser',{storage=new Map(),lose=false}={}){
 if(!actor.clientDb){actor.clientDb=clientFirestore(actor.app);connectFirestoreEmulator(actor.clientDb,'127.0.0.1',8080);}
 const live=actor.clientDb,alerts=[],calls=[],current=(await getDoc(doc(live,'orders',x.orderId))).data();
 const c=vm.createContext({currentUser:{uid:actor.uid},currentUserRole:role,YUSHIN_V2_DISPATCH_EMULATOR:true,location:{hostname:'localhost'},
  YushinFulfillment:require('../modules/fulfillment-core'),ordersCache:[{...current,id:x.orderId}],purchasingDispatchCache:[],currentDeliveryOrderId:null,
  brandIdentityForRecord:i=>({brand:i.brand||'',brandId:i.brandId||''}),normalizeHistoryItemCode:s=>s,parseMoney:Number,
  orderInventorySyncIncomplete:o=>o.inventoryReservationStatus!=='completed',
  sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  document:{getElementById:()=>null},renderOrdersList(){},renderPurchasingDispatchOrders(){},renderPurchasingView(){},renderDeliveryModal(){},
  syncOrderIntoPurchasingCaches(){},writeAppDataCache(){},alert:m=>alerts.push(m),runRoleTransaction:()=>{throw Error('v2 cannot use the legacy transaction');},
  db:{collection:n=>({doc:id=>{const ref=id?doc(live,n,id):doc(collection(live,n));return {id:ref.id,get:async()=>{const s=await getDoc(ref);return {exists:s.exists(),data:()=>s.data()};}};}})},
  firebase:{auth:()=>actor.auth,functions:()=>({app:actor.app,useEmulator:(host,port)=>connectFunctionsEmulator(actor.functions,host,port),
   httpsCallable:name=>async data=>{calls.push({name,data});const reply=await httpsCallable(actor.functions,name)(data);if(lose){lose=false;throw Error('UI Callable reply lost');}return reply;}})}});
 c.window=c;const workspace=fs.readFileSync('src/features/orders/order-workspace.js','utf8');
 const section=(a,b)=>workspace.slice(workspace.indexOf(a),workspace.indexOf(b,workspace.indexOf(a)));
 vm.runInContext(section('function normalizedOrderItems(','function ensureOrderItemCompatibility('),c);
 vm.runInContext(section('const pendingDispatchOrderIds =','function orderLifecycleActionButtons('),c);
 vm.runInContext(fs.readFileSync('src/services/dispatch-preparation.js','utf8'),c);
 vm.runInContext(section('function dispatchPreparationStorageKey(','\n\nasync function refreshAffectedOrderCaches'),c);
 return {c,storage,alerts,calls,run:()=>c.markOrderItemDispatchPrepared(x.orderId,'I')};
}
test('real Auth original dispatch UI calls the v2 Service for multi-item orders and reuses a frozen operation after lost reply and reload',async()=>{
 for(const role of ['admin','purchaser']){
  const x=await fixture('dispatch-ui-'+role,{role,cancelled:false,multi:true}),before=await snapshot(x),order=await x.data('orders',x.orderId);
  const ui=await dispatchUI(x,x.actor,role,{lose:true});await ui.run();assert.equal(ui.alerts.length,1);const frozen=ui.c.pendingDispatchPreparation(x.orderId,'I');
  assert.equal(frozen.quantity,6);assert.equal(frozen.expectedPreparedQty,4);assert.equal(frozen.syncAttemptId,x.intent.syncAttemptId);assert.equal((await x.data('orders',x.orderId)).items[0].dispatchPreparedQty,10);
  const proof=await x.data('dispatchRecords','v2-'+frozen.operationId);assert.equal(proof.actorUid,x.actor.uid);assert.equal(proof.actorRole,role);
  const reload=await dispatchUI(x,x.actor,role,{storage:ui.storage});await reload.run();assert.equal(reload.alerts.length,0);assert.equal(ui.storage.size,0);
  assert.equal(reload.calls[0].data.operationId,frozen.operationId);assert.equal(reload.calls[0].data.quantity,6);assert.equal(reload.calls[0].data.actorUid,undefined);
  const after=await snapshot(x);for(const n of [1,2,3,4,5,6])assert.deepEqual(after.documents[n],before.documents[n]);assert.deepEqual(after.movements,before.movements);
  const updated=await x.data('orders',x.orderId);assert.deepEqual(updated.items.slice(1),order.items.slice(1));assert.deepEqual(updated.deliveryRecords,order.deliveryRecords);
 }
});
test('real dispatch Callable rechecks five current roles and the existing UI keeps warehouse and business buttons unavailable',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const x=await fixture('dispatch-role-'+role,{role,cancelled:false}),ui=await dispatchUI(x,x.actor,role);await ui.run();
  if(['warehouse','sales','engineer'].includes(role))assert.equal(ui.calls.length,0);
  const request={orderId:x.orderId,itemId:'I',quantity:1,expectedPreparedQty:['admin','purchaser'].includes(role)?10:4,operationId:'dispatch_auth_role_'+role,syncAttemptId:x.intent.syncAttemptId};
  if(role==='warehouse')assert.equal((await x.actor.dispatch(request)).status,'applied');
  else if(['sales','engineer'].includes(role))await assert.rejects(x.actor.dispatch(request),code('permission-denied'));
  else{await db.collection('users').doc(x.actor.uid).update({role:'sales'});await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});await x.actor.auth.currentUser.getIdToken(true);
   await assert.rejects(x.actor.dispatch(request),code('permission-denied'));}
 }
});
test('real dispatch Callable freezes the prepared baseline and safely serializes identical and competing operation IDs',async()=>{
 const x=await fixture('dispatch-race',{role:'purchaser',cancelled:false,multi:true}),before=await snapshot(x);
 const input={orderId:x.orderId,itemId:'I',quantity:1,expectedPreparedQty:4,operationId:'dispatch_auth_race_same',syncAttemptId:x.intent.syncAttemptId};
 const same=await Promise.all([x.actor.dispatch(input),x.actor.dispatch(input)]);assert.deepEqual(same.map(r=>r.status).sort(),['already-applied','applied']);
 await assert.rejects(x.actor.dispatch({...input,expectedPreparedQty:5}),code('already-exists'));
 const stale={...input,operationId:'dispatch_auth_race_stale'};await assert.rejects(x.actor.dispatch(stale),e=>code('failed-precondition')(e)&&e.details?.reason==='dispatch-stale');
 const race=await Promise.allSettled(['a','b'].map(tag=>x.actor.dispatch({...input,operationId:'dispatch_auth_race_'+tag,expectedPreparedQty:5})));assert.equal(race.filter(r=>r.status==='fulfilled').length,1);
 const after=await snapshot(x);assert.equal(after.documents[0].items[0].dispatchPreparedQty,6);for(const n of [1,2,3,4,5,6])assert.deepEqual(after.documents[n],before.documents[n]);assert.deepEqual(after.movements,before.movements);
});
test('real dispatch refuses missing Auth spoofed identities disabled profiles and stale inventory synchronization',async()=>{
 const x=await fixture('dispatch-guard',{role:'purchaser',cancelled:false}),anonymous=await identity('dispatch-unsigned','purchaser',{login:false,profile:false});
 const input={orderId:x.orderId,itemId:'I',quantity:1,expectedPreparedQty:4,operationId:'dispatch_auth_guard_request',syncAttemptId:x.intent.syncAttemptId},before=await snapshot(x);
 await assert.rejects(anonymous.dispatch(input),code('unauthenticated'));
 for(const patch of [{actorUid:x.operator.uid},{actorRole:'admin'}])await assert.rejects(x.actor.dispatch({...input,...patch}),code('invalid-argument'));
 await assert.rejects(x.actor.dispatch({...input,syncAttemptId:'superseded'}),code('failed-precondition'));
 await db.collection('users').doc(x.actor.uid).update({disabled:true});await assert.rejects(x.actor.dispatch(input),code('permission-denied'));assert.deepEqual(await snapshot(x),before);
});
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


// This transport extends the existing real Auth/Callable fixture; the shipment
// writer, source ledgers, batch allocation, and whole-order projection are unchanged.
async function followupShipment(x,tag,quantity=2){
 const syncAttemptId=x.intent.syncAttemptId;
 await commitLocationDispatchPreparation(db,x.operator.uid,{orderId:x.orderId,itemId:'I',quantity,
  operationId:'auth_ship_prepare_'+tag,syncAttemptId});
 const order=await x.data('orders',x.orderId);
 return {orderId:x.orderId,itemId:'I',warehouseId:'AUTH-B',quantity,
  date:'2026-10-19',operationId:'auth_ship_commit_'+tag,syncAttemptId,
  expectedPlan:order.items[0].deliveryPlan};
}
test('real Auth shipment Callable commits a second-warehouse physical shipment once without delivering it',async()=>{
 const x=await fixture('ship-physical-multi',{role:'purchaser',cancelled:false,multi:true});
 const request=await followupShipment(x,'physical_multi');
 const before=await snapshot(x),order=before.documents[0];
 const result=await x.actor.ship(request);
 assert.equal(result.status,'applied');assert.equal(result.qty,2);
 assert.equal(result.movementId,'location-ship-'+request.operationId);
 const after=await snapshot(x),updated=after.documents[0];
 assert.equal(updated.items[0].warehouseShippedQty,order.items[0].warehouseShippedQty+2);
 assert.equal(updated.items[0].dispatchPreparedQty,order.items[0].dispatchPreparedQty);
 assert.equal(updated.deliveredQty,order.deliveredQty);
 assert.deepEqual(updated.deliveryRecords,order.deliveryRecords);
 assert.deepEqual(updated.items.slice(1),order.items.slice(1));
 assert.equal(after.documents[1].onHand,before.documents[1].onHand-2);
 assert.equal(after.documents[4].onHand,before.documents[4].onHand-2);
 assert.equal(after.documents[6].remainingQty,before.documents[6].remainingQty-2);
 const movement=after.movements.find(m=>m.id===result.movementId);
 assert.equal(movement.actorUid,x.actor.uid);assert.equal(movement.qty,-2);
 assert.equal((await x.actor.ship(request)).status,'already-applied');
 assert.deepEqual(await snapshot(x),after);
 await assert.rejects(x.actor.ship({...request,quantity:1}),code('already-exists'));
 assert.deepEqual(await snapshot(x),after);
});
test('signed-in shipment Callable enforces current warehouse roles independently of payload or token claims',async()=>{
 for(const role of ['admin','purchaser','warehouse','sales','engineer']){
  const tag='role_'+role,x=await fixture('ship-'+tag,{role,cancelled:false});
  const request=await followupShipment(x,tag,1),before=await snapshot(x);
  if(['admin','purchaser','warehouse'].includes(role)){
   const result=await x.actor.ship(request);assert.equal(result.status,'applied');
   assert.equal(result.qty,1);assert.equal((await x.actor.ship(request)).status,'already-applied');
  }else{
   await assert.rejects(x.actor.ship(request),code('permission-denied'));
   assert.deepEqual(await snapshot(x),before);
  }
 }
 const x=await fixture('ship-role-downgrade',{role:'purchaser',cancelled:false});
 const request=await followupShipment(x,'role_downgrade',1),before=await snapshot(x);
 await db.collection('users').doc(x.actor.uid).update({role:'sales'});
 await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});
 await x.actor.auth.currentUser.getIdToken(true);
 await assert.rejects(x.actor.ship(request),code('permission-denied'));
 assert.deepEqual(await snapshot(x),before);
});
test('signed-in shipment rejects forged identity stale synchronization and invalid request before stock writes',async()=>{
 const x=await fixture('ship-transport-guards',{role:'purchaser',cancelled:false});
 const request=await followupShipment(x,'transport_guards',1),before=await snapshot(x);
 const anonymous=await identity('ship-unsigned','purchaser',{login:false,profile:false});
 await assert.rejects(anonymous.ship(request),code('unauthenticated'));
 for(const patch of [{actorUid:x.operator.uid},{actorRole:'admin'},{warehouseId:'AUTH-C'}])
  await assert.rejects(x.actor.ship({...request,...patch}),
   error=>['functions/invalid-argument','functions/failed-precondition'].includes(error.code));
 await assert.rejects(x.actor.ship({...request,syncAttemptId:'superseded'}),code('failed-precondition'));
 await db.collection('users').doc(x.actor.uid).update({active:false});
 await assert.rejects(x.actor.ship(request),code('permission-denied'));
 assert.deepEqual(await snapshot(x),before);
});


test('original warehouse shipment Service uses real Auth Callable with frozen retry after a lost response',async()=>{
 const x=await fixture('ship-ui-auth',{role:'purchaser',cancelled:false,multi:true});
 const request=await followupShipment(x,'ui_auth',2),before=await snapshot(x);
 const live=clientFirestore(x.actor.app);connectFirestoreEmulator(live,'127.0.0.1',8080);
 const storage=new Map();let calls=0,lose=true;
 const open=()=>{
  const context=vm.createContext({currentUser:{uid:x.actor.uid},currentUserRole:'purchaser',
   YUSHIN_V2_SHIPMENT_EMULATOR:true,location:{hostname:'127.0.0.1'},
   canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,
   YushinWarehouseLogistics:require('../modules/warehouse-logistics'),
   sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   db:{collection:name=>({doc:id=>({get:async()=>{const s=await getDoc(doc(live,name,id));return {exists:s.exists(),data:()=>s.data()};}})})},
   firebase:{auth:()=>x.actor.auth,functions:()=>({app:x.actor.app,useEmulator:()=>{},
    httpsCallable:name=>async data=>{calls++;assert.equal(name,'shipV2WarehouseItem');
     assert.equal(data.actorUid,undefined);assert.equal(data.actorRole,undefined);
     const result=await httpsCallable(x.actor.functions,name)(data);
     if(lose){lose=false;throw Error('lost UI response');}return result;}})},
   runRoleTransaction:()=>{throw Error('legacy shipment forbidden');}});
  vm.runInContext(fs.readFileSync('src/services/warehouse-shipment.js','utf8'),context);
  return context;
 };
 const payload={orderId:x.orderId,itemId:'I',qty:2,date:request.date,notes:'',
  operationId:request.operationId,expectedWarehouseId:'AUTH-B',expectedPlan:request.expectedPlan};
 const first=open();
 await assert.rejects(first.commitInventoryShipment(payload),/lost UI response/);
 const pending=first.pendingV2WarehouseShipment(x.orderId,'I');
 assert.equal(pending.operationId,request.operationId);assert.equal(pending.syncAttemptId,request.syncAttemptId);
 await assert.rejects(first.commitInventoryShipment({...payload,qty:1}),/凍結/);
 const after=await snapshot(x);
 assert.equal(after.documents[1].onHand,before.documents[1].onHand-2);
 assert.equal(after.documents[4].onHand,before.documents[4].onHand-2);
 assert.equal(after.documents[0].deliveredQty,before.documents[0].deliveredQty);
 assert.deepEqual(after.documents[0].deliveryRecords,before.documents[0].deliveryRecords);
 await open().commitInventoryShipment(payload);
 assert.equal(calls,2);assert.equal(storage.size,0);
 assert.deepEqual(await snapshot(x),after);
});
