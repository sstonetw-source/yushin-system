'use strict';
// Real Auth SDK -> Callable SDK -> original v2 return Services -> Firestore.
// Source documents are Admin fixtures; inventory synchronization now runs the real src workflow.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const {getFirestore:clientFirestore,connectFirestoreEmulator,doc,collection,getDoc,getDocFromServer,runTransaction,setDoc}=require('firebase/firestore');
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
  ship:input=>httpsCallable(functions,'shipV2WarehouseItem',{timeout:30000})(input).then(r=>r.data),
  reverse:input=>httpsCallable(functions,'reverseV2ShipmentDelivery',{timeout:30000})(input).then(r=>r.data),
  setLifecycle:input=>httpsCallable(functions,'setV2OrderLifecycle',{timeout:30000})(input).then(r=>r.data),
  listRecovery:input=>httpsCallable(functions,'listV2FreeStockRecovery',{timeout:30000})(input).then(r=>r.data),
  resumeRecovery:input=>httpsCallable(functions,'resumeV2FreeStockRecovery',{timeout:30000})(input).then(r=>r.data),
  confirm:input=>httpsCallable(functions,'confirmV2ShipmentDelivery',{timeout:30000})(input).then(r=>r.data),preview:input=>httpsCallable(functions,'previewV2CustomerReturn',{timeout:30000})(input).then(r=>r.data),
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
  firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>actor.auth,functions:()=>({app:actor.app,useEmulator:(host,port)=>connectFunctionsEmulator(actor.functions,host,port),
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
   firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>x.actor.auth,functions:()=>({app:x.actor.app,useEmulator:()=>{},
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


test('real Auth original delivery Service confirms an existing shipment and resumes the same operation after lost reply',async()=>{
 const x=await fixture('delivery-ui-auth',{role:'sales',cancelled:false,multi:true});
 const shipment=await followupShipment(x,'delivery_ui_auth',2);
 const out=await commitLocationShipment(db,x.operator.uid,shipment);
 assert.equal(out.status,'applied');
 const before=await snapshot(x),original=before.documents[0],storage=new Map();
 const live=clientFirestore(x.actor.app);connectFirestoreEmulator(live,'127.0.0.1',8080);
 let lost=true,calls=0;
 const open=()=>{
  const context=vm.createContext({YUSHIN_V2_DELIVERY_EMULATOR:true,location:{hostname:'127.0.0.1'},
   currentUser:{uid:x.actor.uid},currentUserRole:'sales',
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
   YushinFulfillment:require('../modules/fulfillment-core'),
   sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   db:{collection:n=>({doc:id=>({get:async()=>{const s=await getDoc(doc(live,n,id));return {exists:s.exists(),data:()=>s.data()};}})})},
   firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>({app:x.actor.app,currentUser:{uid:x.actor.uid},emulatorConfig:{host:'127.0.0.1',port:9099}}),
    functions:()=>({app:x.actor.app,useEmulator:()=>{},
     httpsCallable:name=>async payload=>{calls++;assert.equal(name,'confirmV2ShipmentDelivery');
      assert.equal(payload.actorUid,undefined);assert.equal(payload.actorRole,undefined);
      const response=await httpsCallable(x.actor.functions,name)(payload);
      if(lost){lost=false;throw Error('delivery response lost');}
      return response;}})},
   runRoleTransaction:()=>{throw Error('legacy delivery stock writer must not run');}});
  vm.runInContext(fs.readFileSync('src/services/delivery-records.js','utf8'),context);
  return context;
 };
 const request={date:'2026-10-19',qty:1,notes:'簽收一份',itemId:'I',
  shipmentId:shipment.operationId,recordId:'delivery_auth_ui_123456'};
 const first=open();
 await assert.rejects(first.saveOrderDeliveryRecord(x.orderId,request),/delivery response lost/);
 const after=await snapshot(x);
 assert.equal(after.documents[0].deliveredQty,original.deliveredQty+1);
 assert.equal(after.documents[0].items[0].deliveredQty,original.items[0].deliveredQty+1);
 assert.deepEqual(after.documents.slice(1),before.documents.slice(1));
 assert.deepEqual(after.movements,before.movements);
 const frozen=first.pendingV2DeliveryConfirmation(x.orderId);
 assert.equal(frozen.shipmentId,shipment.operationId);assert.equal(frozen.syncAttemptId,shipment.syncAttemptId);
 await assert.rejects(first.saveOrderDeliveryRecord(x.orderId,{...request,qty:2}),/未確認/);
 await assert.rejects(first.saveOrderDeliveryRecord(x.orderId,{...request,shipmentId:'another_shipment'}),/未確認/);
 const resumed=open();
 await resumed.saveOrderDeliveryRecord(x.orderId,{...request,recordId:'ignored_new_ui_record'});
 assert.equal(calls,2);assert.equal(storage.size,0);
 assert.deepEqual(await snapshot(x),after);
});
test('authenticated delivery Callable refuses anonymous users and a forged role without stock or acknowledgement changes',async()=>{
 const x=await fixture('delivery-auth-guard',{role:'sales',cancelled:false,multi:true});
 const shipment=await followupShipment(x,'delivery_auth_guard',1);
 await commitLocationShipment(db,x.operator.uid,shipment);
 const input={orderId:x.orderId,itemId:'I',shipmentId:shipment.operationId,
  quantity:1,date:'2026-10-19',notes:'signed',operationId:'delivery_auth_guard_123456',
  syncAttemptId:shipment.syncAttemptId};
 const before=await snapshot(x);
 const anonymous=await identity('delivery-unsigned','sales',{login:false,profile:false});
 await assert.rejects(anonymous.confirm(input),code('unauthenticated'));
 await assert.rejects(x.actor.confirm({...input,actorRole:'admin'}),code('invalid-argument'));
 await assert.rejects(x.actor.confirm({...input,syncAttemptId:'stale'}),code('failed-precondition'));
 await db.collection('users').doc(x.actor.uid).update({role:'warehouse'});
 await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});
 await x.actor.auth.currentUser.getIdToken(true);
 await assert.rejects(x.actor.confirm(input),code('permission-denied'));
 assert.deepEqual(await snapshot(x),before);
});

function reversalInput(x,tag){
 return {orderId:x.orderId,itemId:'I',deliveryRecordId:'return_auth_delivery_'+tag,
  operationId:'reverse_auth_operation_'+tag,syncAttemptId:x.trace.syncAttemptId,
  date:'2026-10-19',reason:'客戶尚未收到，更正誤登簽收'};
}
function assertOnlyDeliveryReversed(before,after,recordId,operationId){
 const old=before.documents[0],order=after.documents[0];
 assert.deepEqual(after.documents.slice(1),before.documents.slice(1));
 assert.deepEqual(after.movements,before.movements);
 assert.deepEqual(order.warehouseShipmentRecords,old.warehouseShipmentRecords);
 assert.deepEqual(order.returnRecords,old.returnRecords);
 assert.deepEqual(order.items.map(({deliveredQty,...rest})=>rest),old.items.map(({deliveredQty,...rest})=>rest));
 assert.equal(order.deliveredQty,old.deliveredQty-4);
 assert.equal(order.items[0].deliveredQty,old.items[0].deliveredQty-4);
 assert.deepEqual(order.items.slice(1),old.items.slice(1));
 assert.deepEqual(order.deliveryRecords,old.deliveryRecords.filter(row=>row.id!==recordId));
 const event=order.deliveryHistory.at(-1);
 assert.equal(event.source,'shipment_confirmation_reversal');assert.equal(event.operationId,operationId);
 assert.equal(event.recordId,recordId);assert.equal(event.before.qty,4);
}

test('real Auth delivery reversal corrects acknowledgement only and preserves fixed intent after lost response',async()=>{
 const tag='reverse-lost-multi',x=await fixture(tag,{role:'sales',cancelled:false,multi:true});
 const input=reversalInput(x,tag),before=await snapshot(x);
 // The response is deliberately discarded after the real Callable commits.
 await assert.rejects((async()=>{await x.actor.reverse(input);throw Error('lost reversal reply');})(),/lost reversal reply/);
 const after=await snapshot(x);assertOnlyDeliveryReversed(before,after,input.deliveryRecordId,input.operationId);
 const result=await x.actor.reverse(input);
 assert.equal(result.status,'already-applied');assert.equal(result.operationId,input.operationId);
 assert.equal(result.reversedQty,4);assert.equal(result.pendingDeliveryQty,4);
 assert.deepEqual(await snapshot(x),after);
 for(const patch of [{reason:'different intent'},{date:'2026-10-20'},{itemId:'I2'}])
  await assert.rejects(x.actor.reverse({...input,...patch}),code('already-exists'));
 assert.deepEqual(await snapshot(x),after);
 // The physical shipment can be acknowledged again using a fresh confirmation,
 // while the old reversal ID remains a read-only receipt.
 const confirmation={orderId:x.orderId,itemId:'I',shipmentId:x.trace.shipmentId,
  quantity:2,date:'2026-10-20',notes:'收到第一批',operationId:'reconfirm_after_reverse_123456',
  syncAttemptId:x.trace.syncAttemptId};
 assert.equal((await x.actor.confirm(confirmation)).status,'applied');
 const reack=await snapshot(x);
 assert.equal(reack.documents[0].deliveredQty,2);
 assert.equal((await x.actor.reverse(input)).status,'already-applied');
 assert.deepEqual(await snapshot(x),reack);
 assert.deepEqual(reack.documents.slice(1),before.documents.slice(1));
 assert.deepEqual(reack.movements,before.movements);
});

test('real Auth delivery reversal checks all five current roles ownership disabled profiles and forged claims',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const tag='reverse-role-'+role,x=await fixture(tag,{role,cancelled:false,multi:true});
  const input=reversalInput(x,tag),before=await snapshot(x);
  if(['admin','sales','engineer'].includes(role)){
   const result=await x.actor.reverse(input);assert.equal(result.status,'applied');
   assertOnlyDeliveryReversed(before,await snapshot(x),input.deliveryRecordId,input.operationId);
   assert.equal((await x.actor.reverse(input)).status,'already-applied');
  }else{
   await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});await x.actor.auth.currentUser.getIdToken(true);
   await assert.rejects(x.actor.reverse(input),code('permission-denied'));
   assert.deepEqual(await snapshot(x),before);
  }
 }
 const tag='reverse-identity',x=await fixture(tag,{role:'sales',cancelled:false});
 const input=reversalInput(x,tag),before=await snapshot(x);
 const outsider=await identity('reverse-outsider','sales');
 const anonymous=await identity('reverse-anonymous','sales',{login:false,profile:false});
 await assert.rejects(outsider.reverse(input),code('permission-denied'));
 await assert.rejects(anonymous.reverse(input),code('unauthenticated'));
 for(const patch of [{actorUid:x.operator.uid},{actorRole:'admin'}])
  await assert.rejects(x.actor.reverse({...input,...patch}),code('invalid-argument'));
 for(const profile of [{role:'warehouse'},{role:'sales',active:false},{active:true,disabled:true}]){
  await db.collection('users').doc(x.actor.uid).update(profile);
  await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});await x.actor.auth.currentUser.getIdToken(true);
  await assert.rejects(x.actor.reverse(input),code('permission-denied'));
 }
 assert.deepEqual(await snapshot(x),before);
});

test('real Auth reversal rejects stale sources physical return and sibling proof corruption without writes',async()=>{
 const tag='reverse-proof',x=await fixture(tag,{role:'sales',cancelled:false,multi:true});
 const input=reversalInput(x,tag),before=await snapshot(x);
 for(const patch of [{syncAttemptId:'stale'},{deliveryRecordId:'missing'},
  {date:'2026-10-17'},{date:'2026-02-30'},{reason:' '},{itemId:'I2'},
  {operationId:input.deliveryRecordId}]){
  await assert.rejects(x.actor.reverse({...input,...patch}),e=>['functions/failed-precondition','functions/invalid-argument','functions/already-exists'].includes(e.code));
  assert.deepEqual(await snapshot(x),before);
 }
 // A real physical return prevents erasing the acknowledgement backing it.
 await x.actor.receive(x.intent);
 const returned=await snapshot(x);
 await assert.rejects(x.actor.reverse(input),code('failed-precondition'));
 assert.deepEqual(await snapshot(x),returned);
 const second='reverse-sibling-proof',y=await fixture(second,{role:'sales',cancelled:false,multi:true});
 const order=await y.data('orders',y.orderId),plan=order.items[1].deliveryPlan;
 await commitLocationDispatchPreparation(db,y.operator.uid,{orderId:y.orderId,itemId:'I2',quantity:1,
  syncAttemptId:y.trace.syncAttemptId,operationId:'reverse_sibling_dispatch_123456'});
 const shipmentId='reverse_sibling_shipment_123456';
 await commitLocationShipment(db,y.operator.uid,{orderId:y.orderId,itemId:'I2',warehouseId:'AUTH-B',quantity:1,
  syncAttemptId:y.trace.syncAttemptId,operationId:shipmentId,date:'2026-10-19',expectedPlan:plan});
 const ref=db.collection('inventoryMovements').doc('location-ship-'+shipmentId);
 await ref.update({intentHash:'tampered'});
 const corrupt=await snapshot(y);
 await assert.rejects(y.actor.reverse(reversalInput(y,second)),code('failed-precondition'));
 assert.deepEqual(await snapshot(y),corrupt);
});

test('real Auth reversal serializes identical and competing IDs and keeps already-applied replay under current authorization',async()=>{
 for(const same of [true,false]){
  const tag='reverse-race-'+same,x=await fixture(tag,{role:'sales',cancelled:false,multi:true});
  const input=reversalInput(x,tag),before=await snapshot(x);
  const other=same?input:{...input,operationId:input.operationId+'_other'};
  const results=await Promise.allSettled([x.actor.reverse(input),x.actor.reverse(other)]);
  const passed=results.filter(r=>r.status==='fulfilled').map(r=>r.value);
  if(same)assert.deepEqual(passed.map(r=>r.status).sort(),['already-applied','applied']);
  else{
   assert.equal(passed.length,1);assert.equal(passed[0].status,'applied');
   assert.equal(results.filter(r=>r.status==='rejected').length,1);
  }
  const after=await snapshot(x);
  assertOnlyDeliveryReversed(before,after,input.deliveryRecordId,passed.find(r=>r.status==='applied').operationId);
  assert.equal(after.documents[0].deliveryHistory.filter(r=>r.source==='shipment_confirmation_reversal').length,1);
  await db.collection('users').doc(x.actor.uid).update({disabled:true});
  await assert.rejects(x.actor.reverse({...input,operationId:passed[0].operationId}),code('permission-denied'));
  assert.deepEqual(await snapshot(x),after);
 }
});

test('original delivery reversal click resumes frozen intent through real Auth after lost reply without restoring physical stock',async()=>{
 const tag='reverse-original-ui',x=await fixture(tag,{role:'sales',cancelled:false,multi:true});
 const input=reversalInput(x,tag),before=await snapshot(x),storage=new Map();
 const live=clientFirestore(x.actor.app);connectFirestoreEmulator(live,'127.0.0.1',8080);
 let calls=0,lost=true,prompts=0;
 const open=async()=>{
  const alerts=[],payloads=[];
  const c=vm.createContext({YUSHIN_V2_DELIVERY_EMULATOR:true,location:{hostname:'127.0.0.1'},
   currentUser:{uid:x.actor.uid},currentUserRole:'sales',currentDeliveryOrderId:x.orderId,
   ordersCache:[{id:x.orderId,...(await snapshot(x)).documents[0]}],pendingDeliveryOrderIds:new Set(),
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
   localDateString:()=>input.date,deliveryRecordId:()=>input.operationId,
   prompt:()=>{prompts++;return input.reason;},alert:message=>alerts.push(message),
   resetDeliveryForm:()=>{},renderDeliveryModal:()=>{},renderOrderLifecycleModal:()=>{},renderOrdersList:()=>{},
   sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   db:{collection:n=>({doc:id=>({get:async()=>{const s=await getDoc(doc(live,n,id));return {exists:s.exists(),data:()=>s.data()};}})})},
   firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>x.actor.auth,functions:()=>({app:x.actor.app,useEmulator:()=>{},
    httpsCallable:name=>async payload=>{calls++;assert.equal(name,'reverseV2ShipmentDelivery');payloads.push(structuredClone(payload));
     assert.equal(payload.actorUid,undefined);assert.equal(payload.actorRole,undefined);
     const response=await httpsCallable(x.actor.functions,name)(payload);
     if(lost){lost=false;throw Error('original UI reversal reply lost');}return response;}})},
   runRoleTransaction:()=>{throw Error('legacy physical stock reversal forbidden');}});
  c.window=c;
  vm.runInContext(fs.readFileSync('src/services/delivery-records.js','utf8'),c);
  const ui=fs.readFileSync('src/features/orders/delivery-actions.js','utf8');
  vm.runInContext(ui.slice(ui.indexOf('async function reverseV2DeliveryRecord('),ui.indexOf('window.clearLegacyDelivery =')),c);
  return {c,alerts,payloads};
 };
 const first=await open();
 await first.c.deleteDeliveryRecord(input.deliveryRecordId);
 assert.equal(first.alerts.length,1);assert.match(first.alerts[0],/original UI reversal reply lost/);
 assert.equal(first.c.pendingV2DeliveryReversal(x.orderId).operationId,input.operationId);
 assert.equal(first.c.ordersCache[0].deliveredQty,before.documents[0].deliveredQty);
 const after=await snapshot(x);assertOnlyDeliveryReversed(before,after,input.deliveryRecordId,input.operationId);
 const resumed=await open();assert.equal(resumed.c.ordersCache[0].deliveryRecords.length,0);
 await resumed.c.deleteDeliveryRecord(input.deliveryRecordId);
 assert.deepEqual(resumed.alerts,[]);assert.equal(prompts,1);assert.equal(calls,2);assert.equal(storage.size,0);
 assert.deepEqual(resumed.payloads[0],first.payloads[0]);
 assert.equal(resumed.c.pendingDeliveryOrderIds.size,0);
 assert.equal(resumed.c.ordersCache[0].deliveredQty,0);
 assert.deepEqual(await snapshot(x),after);
});

async function lifecycleInput(x,operationId,nextStatus='cancelled'){
 const order=await x.data('orders',x.orderId);
 return {orderId:x.orderId,itemIds:order.items.map(row=>row.itemId),warehouseIds:['AUTH-A','AUTH-B'],
  syncAttemptId:order.inventoryReservationAttemptId,operationId,nextStatus,date:'2026-10-20',reason:'客戶取消剩餘需求'};
}

async function recoveryDemand(x,tag){
 const source=await x.data('orders',x.orderId),productId=source.items[0].productId,orderId='recovery-demand-'+tag;
 await db.collection('orders').doc(orderId).set({ownerUid:x.actor.uid,salesCode:'R',status:'active',orderStatus:'normal',orderDate:'2026-01-01',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'recovery_sync_'+tag,deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
  items:[{itemId:'R',productId,qty:8,warehouseId:'AUTH-A',reservedQty:0,deliveredQty:0,returnedQty:0,dispatchPreparedQty:0,warehouseShippedQty:0,
   fulfillmentType:'WAREHOUSE',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'測試',phone:'02-12345678',address:'測試地址'}}]});
 await synchronizeV2OrderFixture(db,x.actor.uid,{orderId,warehouseIds:['AUTH-A','AUTH-B']});
 return {orderId,productId};
}
async function allRecoveryRows(actor){
 const rows=[];let afterId='';
 for(let page=0;page<20;page++){
  const result=await actor.listRecovery({afterId});assert.ok(result.rows.length<=20);rows.push(...result.rows);
  if(!result.hasMore)return rows;
  assert.notEqual(result.afterId,afterId);afterId=result.afterId;
 }
 assert.fail('fixture source pagination did not terminate');
}
test('real Auth logistics roles list committed cancellations without writes and allocate through the original source worker',async()=>{
 for(const role of ['admin','purchaser','warehouse']){
  const tag='recovery-auth-'+role,x=await fixture(tag,{cancelled:false}),target=await recoveryDemand(x,tag);
  const before=await lifecycleSnapshot(x),cancel=await x.actor.setLifecycle(await lifecycleInput(x,'recovery_auth_cancel_'+role));
  const ids=cancel.postCommitAllocation.sources.map(s=>s.movementId);assert.ok(ids.length>0);
  const operator=await identity(tag+'-logistics',role),canceled=await lifecycleSnapshot(x);
  const rows=(await allRecoveryRows(operator)).filter(row=>ids.includes(row.movementId));
  assert.equal(rows.length,ids.length);assert.deepEqual(await lifecycleSnapshot(x),canceled);
  for(const row of rows){
   const result=await operator.resumeRecovery({movementId:row.movementId});assert.equal(result.status,'completed');
   assert.ok(result.stepsAttempted<=5);assert.equal(result.sourceMovementId,row.movementId);
   assert.ok(Array.isArray(result.affectedOrderIds));
   const repeat=await operator.resumeRecovery({movementId:row.movementId});assert.equal(repeat.allocatedQty,result.allocatedQty);
  }
  const current=await x.data('orders',target.orderId);assert.equal(current.items[0].reservedQty,8);assert.equal(current.items[0].shortageQty,0);
  assert.equal((await allRecoveryRows(operator)).some(row=>ids.includes(row.movementId)),false);
  assertPhysicalLifecycleUnchanged(before,await lifecycleSnapshot(x));
 }
});
test('real Auth recovery rejects business roles disabled users spoofed payload and corrupt release proof without stock changes',async()=>{
 const x=await fixture('recovery-auth-denied',{cancelled:false});await recoveryDemand(x,'recovery-denied');
 const canceled=await x.actor.setLifecycle(await lifecycleInput(x,'recovery_auth_denied_cancel'));
 const movementId=canceled.postCommitAllocation.sources[0].movementId,before=await lifecycleSnapshot(x);
 for(const role of ['sales','engineer']){
  const actor=role==='sales'?x.actor:await identity('recovery-denied-'+role,role);
  await accounts.setCustomUserClaims(actor.uid,{role:'admin',admin:true});
  await assert.rejects(actor.listRecovery({}),code('permission-denied'));
  await assert.rejects(actor.resumeRecovery({movementId}),code('permission-denied'));
 }
 const operator=await identity('recovery-denied-warehouse','warehouse');
 for(const input of [{movementId,actorUid:x.actor.uid},{movementId,maxSteps:100},{movementId,quantity:10}])
  await assert.rejects(operator.resumeRecovery(input),code('invalid-argument'));
 await db.collection('users').doc(operator.uid).update({disabled:true});
 await assert.rejects(operator.listRecovery({}),code('permission-denied'));
 await assert.rejects(operator.resumeRecovery({movementId}),code('permission-denied'));
 assert.deepEqual(await lifecycleSnapshot(x),before);
 await db.collection('users').doc(operator.uid).update({disabled:false});
 await db.collection('inventoryMovements').doc(movementId).update({qty:-999});const corrupt=await lifecycleSnapshot(x);
 const row=(await allRecoveryRows(operator)).find(row=>row.movementId===movementId);assert.equal(row.status,'blocked');
 await assert.rejects(operator.resumeRecovery({movementId}),code('failed-precondition'));
 assert.deepEqual(await lifecycleSnapshot(x),corrupt);
});
test('real Auth original recovery row preserves the committed source after a lost reply and reconciles through another logistics actor',async()=>{
 const x=await fixture('recovery-original-ui',{cancelled:false}),target=await recoveryDemand(x,'recovery-original-ui');
 const canceled=await x.actor.setLifecycle(await lifecycleInput(x,'recovery_original_ui_cancel'));
 const movementId=canceled.postCommitAllocation.sources[0].movementId;
 const operator=await identity('recovery-ui-warehouse','warehouse'),next=await identity('recovery-ui-purchaser','purchaser');
 let lose=true;const calls=[],alerts=[],elements=new Map();
 const c=vm.createContext({YUSHIN_V2_RECOVERY_EMULATOR:true,location:{hostname:'localhost'},currentUser:{uid:operator.uid},currentUserRole:'warehouse',
  canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,warehouseMasterCache:[],
  document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{hidden:false,innerHTML:'',textContent:''});return elements.get(id);}},
  escapeHtml:String,inlineJsValue:JSON.stringify,showActionFeedback:m=>alerts.push(m),beginActionButton:()=>({}),endActionButton(){},
  invalidateWarehouseStockCache(){},invalidateProcurementDemandQueue(){},markMainPageDirty(){},refreshAffectedOrderCaches:async()=>{},
  firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>operator.auth,functions:()=>({app:operator.app,useEmulator(){},httpsCallable:name=>async payload=>{
   calls.push({name,payload:structuredClone(payload)});const reply=await httpsCallable(operator.functions,name)(payload);
   if(name==='resumeV2FreeStockRecovery'&&lose){lose=false;throw Error('recovery UI reply lost');}return reply;
  }})}});c.window=c;
 vm.runInContext(fs.readFileSync('modules/free-stock-recovery.js','utf8'),c);
 // Sources may be on a later bounded page; loading performs no allocation.
 for(let page=0;page<20;page++){
  await c.loadFreeStockRecovery(page>0);
  if(elements.get('freeStockRecoveryBody').innerHTML.includes(movementId))break;
 }
 const before=await lifecycleSnapshot(x);await c.retryFreeStockRecovery(movementId);
 assert.match(alerts.at(-1),/recovery UI reply lost/);
 assert.match(elements.get('freeStockRecoveryBody').innerHTML,/接續配貨／核對結果/);
 const after=await lifecycleSnapshot(x);assertPhysicalLifecycleUnchanged(before,after);
 const checked=await next.resumeRecovery({movementId});assert.equal(checked.status,'completed');
 await c.retryFreeStockRecovery(movementId);
 const writes=calls.filter(row=>row.name==='resumeV2FreeStockRecovery');assert.deepEqual(writes[0],writes[1]);
 assert.deepEqual(await lifecycleSnapshot(x),after);
 assert.ok((await x.data('orders',target.orderId)).items[0].reservedQty>4);
});

test('original quick and form lifecycle actions reconcile frozen operations through real Auth and server reads after reload',async()=>{
 const x=await fixture('lifecycle-original-ui',{role:'sales',cancelled:false,multi:true}),before=await lifecycleSnapshot(x);
 const live=clientFirestore(x.actor.app);connectFirestoreEmulator(live,'127.0.0.1',8080);
 const storage=new Map(),payloads=[],invalidated=[],feedback=[];let lose=true,prompts=0;
 const open=async()=>{
  const alerts=[],order=(await getDocFromServer(doc(live,'orders',x.orderId))).data();
  const fields={orderLifecycleStatus:{value:'normal'},orderLifecycleDate:{value:'2026-10-20'},orderLifecycleReason:{value:'客戶恢復'},orderLifecycleSaveBtn:{}};
  const c=vm.createContext({YUSHIN_V2_LIFECYCLE_EMULATOR:true,location:{hostname:'localhost'},crypto:require('node:crypto').webcrypto,
   currentUser:{uid:x.actor.uid},currentUserRole:'sales',ordersCache:[{id:x.orderId,...order}],pendingLifecycleOrderIds:new Set(),
   currentDeliveryOrderId:null,currentLifecycleOrderId:x.orderId,
   normalizedOrderStatus:o=>o.orderStatus,normalizedOrderItems:o=>o.items,inventoryProductKey:i=>i.inventoryProductKey||i.productId,
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,deliveryProgressInfo:()=>({remaining:1}),
   localDateString:()=> '2026-10-20',confirmOrderCancellation:()=>{prompts++;return true;},
   alert:m=>alerts.push(m),renderOrdersList(){},renderDeliveryModal(){},renderOrderLifecycleModal(){},
   invalidateWarehouseStockCache:(p,w)=>invalidated.push([p,w]),syncOrderIntoPurchasingCaches(){},writeAppDataCache(){},showActionFeedback:m=>feedback.push(m),
   document:{getElementById:id=>fields[id]},
   sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   db:{collection:n=>({doc:id=>({get:async options=>{assert.equal(options.source,'server');const s=await getDocFromServer(doc(live,n,id));return {exists:s.exists(),data:()=>s.data()};}})})},
   firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>x.actor.auth,functions:()=>({app:x.actor.app,useEmulator(){},httpsCallable:name=>async payload=>{
    assert.equal(name,'setV2OrderLifecycle');payloads.push(structuredClone(payload));
    const reply=await httpsCallable(x.actor.functions,name)(payload);
    if(lose){lose=false;throw Error('lifecycle UI reply lost');}return reply;
   }})},runRoleTransaction:()=>{throw Error('legacy writer forbidden');}});
  c.window=c;vm.runInContext(fs.readFileSync('src/services/order-lifecycle.js','utf8'),c);
  const quick=fs.readFileSync('src/features/orders/lifecycle-workspace.js','utf8');
  vm.runInContext(quick.slice(quick.indexOf('function applySavedOrderLifecycle('),quick.indexOf('window.toggleOrderProgressStatus')),c);
  const form=fs.readFileSync('src/features/orders/delivery-actions.js','utf8');
  vm.runInContext(form.slice(form.indexOf('window.saveOrderLifecycleStatus ='),form.indexOf('// Customer return mutations')),c);
  return {c,alerts,fields};
 };
 const first=await open();await first.c.quickSetOrderLifecycle(x.orderId,'cancelled');assert.match(first.alerts[0],/lifecycle UI reply lost/);
 assert.equal(first.c.ordersCache[0].orderStatus,'normal');assert.equal(storage.size,1);
 const canceled=await lifecycleSnapshot(x);assertPhysicalLifecycleUnchanged(before,canceled);
 const retry=await open();await retry.c.quickSetOrderLifecycle(x.orderId,'cancelled');
 assert.deepEqual(retry.alerts,[]);assert.deepEqual(payloads[1],payloads[0]);assert.equal(prompts,1);assert.equal(storage.size,0);
 assert.equal(retry.c.ordersCache[0].orderStatus,'cancelled');assert.match(feedback[0],/取消已完成/);
 assert.ok(invalidated.some(([,w])=>w==='AUTH-A'));assert.ok(invalidated.some(([,w])=>w==='AUTH-B'));
 lose=true;await retry.c.saveOrderLifecycleStatus();assert.match(retry.alerts[0],/lifecycle UI reply lost/);assert.equal(storage.size,1);
 const restored=await lifecycleSnapshot(x);assertPhysicalLifecycleUnchanged(before,restored);
 const formRetry=await open();await formRetry.c.saveOrderLifecycleStatus();
 assert.deepEqual(formRetry.alerts,[]);assert.deepEqual(payloads[3],payloads[2]);assert.equal(storage.size,0);
 assert.equal(formRetry.c.ordersCache[0].orderStatus,'normal');assert.equal(restored.documents.orders.orderLifecycleHistory.length,2);
 assert.deepEqual(await lifecycleSnapshot(x),restored);
});
async function lifecycleSnapshot(x){
 const order=await x.data('orders',x.orderId),documents={orders:order},lots={};
 for(const key of new Set(order.items.map(row=>row.inventoryProductKey||row.productId))){
  documents['inventory/'+key]=await x.data('inventory',key);
  for(const warehouseId of ['AUTH-A','AUTH-B'])
   documents['warehouseStocks/'+warehouseId+'__'+key]=await x.data('warehouseStocks',warehouseId+'__'+key);
  const result=await db.collection('inventoryLots').where('productKey','==',key).get();
  for(const row of result.docs)lots[row.id]=row.data();
 }
 for(const item of order.items)
  documents['inventoryReservations/'+item.itemId]=await x.data('inventoryReservations',x.orderId+'__'+item.itemId);
 const query=async(name,field)=>{
  const result=await db.collection(name).where(field,'==',x.orderId).get();
  return result.docs.map(row=>({id:row.id,...row.data()})).sort((a,b)=>a.id.localeCompare(b.id));
 };
 return {documents,lots,demands:await query('procurementDemands','sourceId'),
  movements:await query('inventoryMovements','sourceId'),operations:await query('reservationOperationReceipts','orderId')};
}
function assertPhysicalLifecycleUnchanged(before,after){
 assert.deepEqual(after.lots,before.lots);
 for(const [path,value] of Object.entries(before.documents))if(path.startsWith('inventory/')||path.startsWith('warehouseStocks/')){
  const next=after.documents[path];
  assert.equal(next.onHand,value.onHand);assert.equal(next.incoming,value.incoming);
  assert.equal(next.transferFreeInTransit,value.transferFreeInTransit);
 }
 for(const field of ['warehouseShipmentRecords','deliveryRecords','deliveryHistory','returnRecords','returnHistory'])
  assert.deepEqual(after.documents.orders[field],before.documents.orders[field]);
 for(const old of before.movements)assert.deepEqual(after.movements.find(row=>row.id===old.id),old);
}

test('real Auth whole-order cancellation and restoration preserve physical fulfillment and immutable retry for one or multiple items',async()=>{
 for(const multi of [false,true]){
  const tag='lifecycle-flow-'+multi,x=await fixture(tag,{role:'sales',cancelled:false,multi});
  if(multi)await x.actor.receive(x.intent); // Genuine CLOSE return remains closed after restoration.
  const input=await lifecycleInput(x,'lifecycle_auth_cancel_'+multi),before=await lifecycleSnapshot(x);
  let committed;
  await assert.rejects((async()=>{committed=await x.actor.setLifecycle(input);throw Error('lifecycle reply lost');})(),/lifecycle reply lost/);
  assert.equal(committed.status,'applied');assert.equal(committed.items.length,before.documents.orders.items.length);
  assert.equal(committed.postCommitAllocation.status,'recovery-pending');
  assert.ok(committed.postCommitAllocation.sources.length>0);
  assert.ok(committed.postCommitAllocation.sources.every(row=>row.recoveryPending&&row.errorCode==='permission-denied'));
  const cancelled=await lifecycleSnapshot(x);assert.equal(cancelled.documents.orders.orderStatus,'cancelled');
  assertPhysicalLifecycleUnchanged(before,cancelled);
  for(const item of committed.items){
   assert.equal(item.reservedQty,0);
   assert.equal(cancelled.documents['inventoryReservations/'+item.itemId].status,'released');
  }
  assert.equal((await x.actor.setLifecycle({...input,itemIds:[...input.itemIds].reverse()})).status,'already-applied');
  assert.deepEqual(await lifecycleSnapshot(x),cancelled);
  for(const patch of [{reason:'different reason'},{nextStatus:'normal'},{date:'2026-10-21'}])
   await assert.rejects(x.actor.setLifecycle({...input,...patch}),code('already-exists'));
  const restored=await x.actor.setLifecycle({...input,nextStatus:'normal',operationId:'lifecycle_auth_restore_'+multi});
  assert.equal(restored.status,'applied');assert.equal(restored.postCommitAllocation.status,'not-applicable');
  const after=await lifecycleSnapshot(x);assertPhysicalLifecycleUnchanged(before,after);
  assert.equal(after.documents.orders.orderStatus,'normal');
  assert.equal(restored.items.find(row=>row.itemId==='I').reservedQty,6);
  assert.equal(after.documents.orders.items[0].deliveredQty,4);
  if(multi){assert.equal(after.documents.orders.items[0].returnedQty,1);assert.equal(restored.items.find(row=>row.itemId==='I2').reservedQty,2);}
  // An old cancellation receipt cannot overwrite a later restoration.
  assert.equal((await x.actor.setLifecycle(input)).status,'already-applied');
  assert.deepEqual(await lifecycleSnapshot(x),after);
 }
});

test('real Auth lifecycle applies current five-role ownership and disabled-profile authorization independently of claims or payload',async()=>{
 for(const role of ['admin','sales','engineer','purchaser','warehouse']){
  const x=await fixture('lifecycle-role-'+role,{role,cancelled:false,multi:true});
  const input=await lifecycleInput(x,'lifecycle_auth_role_'+role),before=await lifecycleSnapshot(x);
  if(['admin','sales','engineer'].includes(role)){
   assert.equal((await x.actor.setLifecycle(input)).status,'applied');
   const applied=await lifecycleSnapshot(x);assertPhysicalLifecycleUnchanged(before,applied);
   await db.collection('users').doc(x.actor.uid).update({disabled:true});
   await assert.rejects(x.actor.setLifecycle(input),code('permission-denied'));
   assert.deepEqual(await lifecycleSnapshot(x),applied);
  }else{
   await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});await x.actor.auth.currentUser.getIdToken(true);
   await assert.rejects(x.actor.setLifecycle(input),code('permission-denied'));
   assert.deepEqual(await lifecycleSnapshot(x),before);
  }
 }
 const x=await fixture('lifecycle-identity',{role:'sales',cancelled:false,multi:true});
 const input=await lifecycleInput(x,'lifecycle_auth_identity'),before=await lifecycleSnapshot(x);
 const outsider=await identity('lifecycle-outsider','sales');
 const anonymous=await identity('lifecycle-anonymous','sales',{login:false,profile:false});
 const missing=await identity('lifecycle-unprofiled','sales',{profile:false});
 await assert.rejects(outsider.setLifecycle(input),code('permission-denied'));
 await assert.rejects(anonymous.setLifecycle(input),code('unauthenticated'));
 await assert.rejects(missing.setLifecycle(input),code('permission-denied'));
 for(const patch of [{actorUid:x.operator.uid},{actorRole:'admin'}])
  await assert.rejects(x.actor.setLifecycle({...input,...patch}),code('invalid-argument'));
 await db.collection('users').doc(x.actor.uid).update({role:'purchaser'});
 await accounts.setCustomUserClaims(x.actor.uid,{role:'admin'});await x.actor.auth.currentUser.getIdToken(true);
 await assert.rejects(x.actor.setLifecycle(input),code('permission-denied'));
 await db.collection('users').doc(x.actor.uid).update({role:'sales',active:false});
 await assert.rejects(x.actor.setLifecycle(input),code('permission-denied'));
 assert.deepEqual(await lifecycleSnapshot(x),before);
});

test('real Auth lifecycle refuses incomplete intent stale synchronization and corrupted sibling shipment without partial release',async()=>{
 const x=await fixture('lifecycle-proof',{role:'sales',cancelled:false,multi:true});
 const input=await lifecycleInput(x,'lifecycle_auth_proof'),before=await lifecycleSnapshot(x);
 for(const patch of [{itemIds:['I']},{itemIds:['I','I','I3']},{itemIds:[...input.itemIds,'missing']},
  {warehouseIds:['AUTH-A','AUTH-C']},{syncAttemptId:'superseded'},
  {date:'2026-02-30'},{nextStatus:'finished'}]){
  await assert.rejects(x.actor.setLifecycle({...input,...patch}),e=>['functions/failed-precondition','functions/invalid-argument'].includes(e.code));
  assert.deepEqual(await lifecycleSnapshot(x),before);
 }
 const sibling=(await x.data('orders',x.orderId)).items[1],shipmentId='lifecycle_auth_sibling_ship';
 await commitLocationDispatchPreparation(db,x.operator.uid,{orderId:x.orderId,itemId:'I2',quantity:1,
  operationId:'lifecycle_auth_sibling_prepare',syncAttemptId:input.syncAttemptId});
 await commitLocationShipment(db,x.operator.uid,{orderId:x.orderId,itemId:'I2',quantity:1,warehouseId:'AUTH-B',
  operationId:shipmentId,syncAttemptId:input.syncAttemptId,date:'2026-10-19',expectedPlan:sibling.deliveryPlan});
 await commitShipmentDelivery(db,x.operator.uid,{orderId:x.orderId,itemId:'I2',shipmentId,quantity:1,
  operationId:'lifecycle_auth_sibling_delivery',syncAttemptId:input.syncAttemptId,date:'2026-10-20'});
 await db.collection('inventoryMovements').doc('location-ship-'+shipmentId).update({intentHash:'tampered'});
 const corrupt=await lifecycleSnapshot(x);
 await assert.rejects(x.actor.setLifecycle(input),code('failed-precondition'));
 assert.deepEqual(await lifecycleSnapshot(x),corrupt);
});

test('real Auth lifecycle serializes repeated competing requests and rolls back a genuine late movement-create conflict',async()=>{
 for(const same of [true,false]){
  const x=await fixture('lifecycle-race-'+same,{role:'sales',cancelled:false,multi:true});
  const input=await lifecycleInput(x,'lifecycle_auth_race_'+same),before=await lifecycleSnapshot(x);
  const other=same?input:{...input,operationId:input.operationId+'_other'};
  const results=await Promise.allSettled([x.actor.setLifecycle(input),x.actor.setLifecycle(other)]);
  const passed=results.filter(row=>row.status==='fulfilled').map(row=>row.value);
  if(same)assert.deepEqual(passed.map(row=>row.status).sort(),['already-applied','applied']);
  else{assert.equal(passed.length,1);assert.equal(passed[0].status,'applied');assert.equal(results.filter(row=>row.status==='rejected').length,1);}
  const after=await lifecycleSnapshot(x);assertPhysicalLifecycleUnchanged(before,after);
  assert.equal(after.operations.filter(row=>row.action==='order_v2_lifecycle').length,1);
  assert.equal(after.documents.orders.orderLifecycleHistory.length,1);
 }
 const x=await fixture('lifecycle-rollback',{role:'sales',cancelled:false,multi:true});
 const input=await lifecycleInput(x,'lifecycle_auth_rollback');
 const ledger=await x.data('inventoryReservations',x.orderId+'__I');
 const location=ledger.locations.find(row=>row.reservedQty>0);
 const collision='single-v2-life-'+input.operationId+'-I-'+encodeURIComponent(location.warehouseId);
 await db.collection('inventoryMovements').doc(collision).set({sourceId:x.orderId,fixture:'late create conflict'});
 const before=await lifecycleSnapshot(x);
 await assert.rejects(x.actor.setLifecycle(input),e=>['functions/internal','functions/already-exists'].includes(e.code));
 assert.deepEqual(await lifecycleSnapshot(x),before);
 assert.equal((await x.actor.setLifecycle({...input,operationId:input.operationId+'_new'})).status,'applied');
});

// Same production-source PO Service; only the existing demo adapter exports it.
// These are backend Auth/atomicity cases, not original-UI PO acceptance.
async function mergedPurchaseFixture(tag){
 const actor=await identity('merged-po-'+tag,'purchaser');
 const keys=['merged-'+tag+'-P','merged-'+tag+'-Q'];
 const warehouses=['merged-'+tag+'-A','merged-'+tag+'-B'];
 const orderIds=['merged-'+tag+'-O1','merged-'+tag+'-O2'];
 const items=[],batch=db.batch(),put=(name,id,value)=>batch.set(db.collection(name).doc(id),value);
 for(const key of keys){
  put('products',key,{productType:'Goods',active:true});
  put('inventory',key,{productKey:key,onHand:0,reserved:0,incoming:0,transferFreeInTransit:0});
  for(const warehouseId of warehouses)put('warehouseStocks',warehouseId+'__'+key,{warehouseId,productKey:key,onHand:0,reserved:0,incoming:0,transferFreeInTransit:0});
 }
 for(const warehouseId of warehouses)put('warehouses',warehouseId,{active:true});
 for(const [orderIndex,orderId] of orderIds.entries()){
  const rows=Array.from({length:orderIndex===0?3:2},(_,index)=>({
   itemId:'I'+index,productId:keys[index%2],itemCode:'PO-'+index,itemName:'合併採購測試',brand:'Roche',
   qty:7,warehouseId:warehouses[index%2],fulfillmentType:'WAREHOUSE',
   deliveredQty:0,returnedQty:0,dispatchPreparedQty:0,warehouseShippedQty:0,
   deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'測試',phone:'02-12345678',address:'測試地址'}
  }));
  rows.forEach(row=>items.push({orderId,itemId:row.itemId,qty:7,unitCost:19.99}));
  put('orders',orderId,{ownerUid:actor.uid,salesCode:'P',status:'active',orderStatus:'normal',
   inventoryReservationStatus:'pending',inventoryReservationAttemptId:'merged_sync_'+orderId,
   deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,items:rows});
 }
 await batch.commit();
 for(const orderId of orderIds)await synchronizeV2OrderFixture(db,actor.uid,{orderId,warehouseIds:warehouses});
 const input={poNo:'MERGED-'+tag,poDate:'2026-10-20',supplier:'合併測試供應商',items};
 const commit=(data=input,who=actor)=>httpsCallable(who.functions,'commitV2FormalPurchase',{timeout:60000})(data).then(reply=>reply.data);
 const snap=async()=>{
  const documents=[];
  const read=async(name,id)=>{const s=await db.collection(name).doc(id).get();documents.push([name+'/'+id,s.exists?s.data():null]);};
  for(const orderId of orderIds)await read('orders',orderId);
  for(const row of items){const id=procurementDemandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:row.orderId,sourceItemId:row.itemId});await read('procurementDemands',encodeURIComponent(id));}
  for(const key of keys){await read('inventory',key);for(const warehouse of warehouses)await read('warehouseStocks',warehouse+'__'+key);}
  await read('purchaseOrders',input.poNo);
  for(let index=0;index<items.length;index++)await read('supplyOrders','po-'+encodeURIComponent(input.poNo)+'-'+index);
  return documents;
 };
 return {actor,keys,warehouses,orderIds,input,commit,snap};
}

test('real Auth merged PO atomically commits five lines across two orders and two warehouses, with one replay',{timeout:120000},async()=>{
 const x=await mergedPurchaseFixture('five');
 const before=await x.snap();
 const results=await Promise.all([x.commit(),x.commit()]);
 assert.deepEqual(results.map(r=>r.status).sort(),['already-applied','committed']);
 assert.ok(results.every(r=>r.committedQty===35&&r.supplyOrderIds.length===5&&r.demandIds.length===5));
 const after=await x.snap();
 assert.deepEqual(after.filter(([path])=>/^(inventory|warehouseStocks)\//.test(path)),
  before.filter(([path])=>/^(inventory|warehouseStocks)\//.test(path)),'supplier obligation is not incoming or physical stock');
 for(const orderId of x.orderIds){
  const source=(await db.collection('orders').doc(orderId).get()).data();
  assert.ok(source.items.every(row=>row.supplyOrderedQty===7&&row.reservedQty===0&&row.shortageQty===7));
  assert.ok(source.items.every(row=>row.orderEvents.filter(e=>e.id===x.input.poNo).length===1));
  assert.equal(source.workCategories.includes('ordering'),false);
 }
 for(const [index,row] of x.input.items.entries()){
  const supply=(await db.collection('supplyOrders').doc('po-'+encodeURIComponent(x.input.poNo)+'-'+index).get()).data();
  assert.equal(supply.qty,7);assert.equal(supply.sourceId,row.orderId);assert.equal(supply.sourceItemId,row.itemId);
  assert.equal(supply.warehouseId,x.warehouses[(index<3?index:index-3)%2]);
  assert.equal(supply.incomingRegisteredQty,0);assert.equal(supply.receivedQty,0);
 }
 await assert.rejects(x.commit({...x.input,items:x.input.items.map((row,index)=>index===4?{...row,qty:6}:row)}),code('already-exists'));
 await db.collection('users').doc(x.actor.uid).update({active:false});
 await assert.rejects(x.commit(),code('permission-denied'));
 assert.deepEqual(await x.snap(),after,'failed replays never change the committed PO');
});

test('real Auth merged PO refuses a bad final row and a sales actor without any partial commit',{timeout:120000},async()=>{
 const x=await mergedPurchaseFixture('reject'),before=await x.snap();
 const bad={...x.input,items:x.input.items.map((row,index)=>index===4?{...row,qty:8}:row)};
 await assert.rejects(x.commit(bad),code('failed-precondition'));
 const sales=await identity('merged-po-reject-sales','sales');
 await assert.rejects(x.commit(x.input,sales),code('permission-denied'));
 assert.deepEqual(await x.snap(),before);
 assert.equal((await x.commit()).status,'committed','same fixed PO remains usable after rejected admission');
});

test('real Auth competing merged POs re-read demand and only one whole PO commits',{timeout:120000},async()=>{
 const x=await mergedPurchaseFixture('race');
 const other={...x.input,poNo:x.input.poNo+'-OTHER'};
 const results=await Promise.allSettled([x.commit(),x.commit(other)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const rejected=results.find(r=>r.status==='rejected');assert.equal(rejected.reason.code,'functions/failed-precondition');
 const winner=results.find(r=>r.status==='fulfilled').value;
 const loserNo=winner.poNo===x.input.poNo?other.poNo:x.input.poNo;
 assert.equal((await db.collection('purchaseOrders').doc(loserNo).get()).exists,false);
 for(let index=0;index<x.input.items.length;index++)assert.equal((await db.collection('supplyOrders').doc('po-'+encodeURIComponent(loserNo)+'-'+index).get()).exists,false);
 for(const orderId of x.orderIds){const source=(await db.collection('orders').doc(orderId).get()).data();assert.ok(source.items.every(row=>row.supplyOrderedQty===7));}
});

async function partialReceiptFixture(tag){
 const buyer=await identity('receipt-'+tag,'purchaser'),key='receipt-'+tag+'-P',orderId='receipt-'+tag+'-O';
 const warehouses=['receipt-'+tag+'-A','receipt-'+tag+'-B'];
 const batch=db.batch(),put=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 put('products',key,{productType:'Goods',active:true});put('inventory',key,{productKey:key,onHand:5,reserved:0,incoming:0,transferFreeInTransit:0});
 for(const [index,id] of warehouses.entries()){
  const onHand=index===0?2:3;put('warehouses',id,{active:true});
  put('warehouseStocks',id+'__'+key,{warehouseId:id,productKey:key,onHand,reserved:0,incoming:0,transferFreeInTransit:0});
  put('inventoryLots',key+'-'+index,{productKey:key,warehouseId:id,receivedQty:onHand,remainingQty:onHand,lotNo:'INITIAL',expiryDate:'2028-01-01'});
 }
 put('orders',orderId,{ownerUid:buyer.uid,salesCode:'P',status:'active',orderStatus:'normal',inventoryReservationStatus:'pending',inventoryReservationAttemptId:'receipt_sync_'+tag,
  deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
  items:[{itemId:'I',productId:key,itemCode:'CODE',itemName:'部分收貨驗收',brand:'Roche',qty:12,warehouseId:warehouses[0],reservedQty:0,receivedQty:0,deliveredQty:0,returnedQty:0,dispatchPreparedQty:0,warehouseShippedQty:0,fulfillmentType:'WAREHOUSE'}]});
 await batch.commit();await synchronizeV2OrderFixture(db,buyer.uid,{orderId,warehouseIds:warehouses});
 const poNo='RECEIPT-PO-'+tag;
 const committed=(await httpsCallable(buyer.functions,'commitV2FormalPurchase')({poNo,poDate:'2026-10-20',supplier:'供應商',items:[{orderId,itemId:'I',qty:4,unitCost:20}]})).data;
 // Same existing incoming Service, not hand-crafted inventory/demand counters.
 const c=vm.createContext({db,currentUser:{uid:buyer.uid},currentUserRole:'purchaser',currentUserName:'採購',
  canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,YushinReceiving:require('../modules/receiving-core'),
  isPurchaseTerminalStatus:status=>['CANCELLED','CLOSED'].includes(String(status||'').toUpperCase()),
  supplyOrdersCollection:()=>db.collection('supplyOrders'),inventoryNumbers:require('../modules/inventory-core').normalizeStock,
  warehouseStockDocId:(wh,p)=>encodeURIComponent(wh)+'__'+encodeURIComponent(p),resolveBrandName:value=>value,brandIdForName:()=>'',buildInventorySearchTokens:()=>[],
  runRoleTransaction:callback=>require('../modules/stock-permissions').run(db,callback,buyer.uid,false,'purchaser')});
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/services/supply-order.js'),'utf8'),c);
 const po=(await db.collection('purchaseOrders').doc(poNo).get()).data();await c.registerPurchaseIncoming(poNo,po);
 const supplyId=committed.supplyOrderIds[0],input={supplyId,qty:2,lotNo:'PARTIAL',expiryDate:'2028-01-01',operationId:'receipt_partial_'+tag};
 const receive=(data=input,actor=buyer)=>httpsCallable(actor.functions,'receiveV2Supply',{timeout:30000})(data).then(reply=>reply.data);
 const snap=async()=>{
  const read=async(name,id)=>(await db.collection(name).doc(id).get()).data();
  const demandId=procurementDemandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:'I'});
  const extra={};for(const name of ['inventoryLots','inventoryLotCosts','inventoryMovements'])extra[name]=(await db.collection(name).where('productKey','==',key).get()).docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id));
  return {order:await read('orders',orderId),inventory:await read('inventory',key),stocks:await Promise.all(warehouses.map(id=>read('warehouseStocks',id+'__'+key))),
   reservation:await read('inventoryReservations',orderId+'__I'),supply:await read('supplyOrders',supplyId),view:await read('receivingSupplyOrders',supplyId),demand:await read('procurementDemands',encodeURIComponent(demandId)),
   receipts:(await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id)),...extra};
 };
 return {buyer,key,orderId,warehouses,supplyId,input,receive,snap};
}
test('real Auth partial PO receipt uses the original Receiving Service, preserves two warehouses and same-ID retries',{timeout:120000},async()=>{
 for(const role of ['admin','purchaser','warehouse']){
  const x=await partialReceiptFixture('roles-'+role),operator=role==='purchaser'?x.buyer:await identity('receipt-role-'+role,role),before=await x.snap();
  const results=await Promise.all([x.receive(x.input,operator),x.receive(x.input,operator)]);assert.ok(results.every(result=>result.status==='confirmed'));
  const after=await x.snap();assert.equal(after.inventory.onHand,before.inventory.onHand+2);assert.equal(after.inventory.reserved,before.inventory.reserved+2);assert.equal(after.inventory.incoming,2);
  assert.equal(after.stocks[0].onHand,before.stocks[0].onHand+2);assert.deepEqual(after.stocks[1],before.stocks[1]);
  assert.equal(after.order.items[0].receivedQty,2);assert.equal(after.order.items[0].reservedQty,7);assert.equal(after.order.items[0].shortageQty,5);
  assert.equal(after.supply.receivedQty,2);assert.equal(after.supply.incomingRegisteredQty,2);assert.equal(after.demand.remainingToOrderQty,3);assert.equal(after.demand.remainingToReceiveQty,2);
  assert.equal(after.receipts.length,1);assert.equal(after.inventoryLots.length,before.inventoryLots.length+1);
  assert.deepEqual(after.view,require('../modules/stock-permissions').sanitizeSupply(after.supply));assert.equal(after.view.unitCost,undefined);
  await assert.rejects(x.receive({...x.input,qty:1},operator));assert.deepEqual(await x.snap(),after);
  await db.collection('users').doc(operator.uid).update({disabled:true});await assert.rejects(x.receive(x.input,operator),code('permission-denied'));assert.deepEqual(await x.snap(),after);
 }
});
test('real Auth receipt rejects forged roles, invalid intent and competing excess with zero partial writes',{timeout:120000},async()=>{
 const x=await partialReceiptFixture('denials'),before=await x.snap();
 for(const role of ['sales','engineer']){
  const other=await identity('receipt-denied-'+role,role);await accounts.setCustomUserClaims(other.uid,{role:'admin'});await other.auth.currentUser.getIdToken(true);
  await assert.rejects(x.receive(x.input,other),code('permission-denied'));assert.deepEqual(await x.snap(),before);
 }
 const anonymous=await identity('receipt-anonymous','purchaser',{login:false,profile:false});await assert.rejects(x.receive(x.input,anonymous),code('unauthenticated'));
 for(const patch of [{actorUid:x.buyer.uid},{actorRole:'admin'},{qty:0},{qty:1.5},{expiryDate:'2026-02-30'},{operationId:'bad/id'}]){
  await assert.rejects(x.receive({...x.input,...patch}),code('invalid-argument'));assert.deepEqual(await x.snap(),before);
 }
 await assert.rejects(x.receive({...x.input,qty:5}));assert.deepEqual(await x.snap(),before);
 const outcomes=await Promise.allSettled([x.receive({...x.input,qty:3}),x.receive({...x.input,qty:3,operationId:x.input.operationId+'_other'})]);
 assert.equal(outcomes.filter(result=>result.status==='fulfilled').length,1);
 const after=await x.snap();assert.equal(after.receipts.length,1);assert.equal(after.inventory.onHand,before.inventory.onHand+3);assert.equal(after.inventory.incoming,1);assert.equal(after.supply.receivedQty,3);
});
