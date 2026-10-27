'use strict';
// Admin source fixtures deliberately isolate receiving from the still separately
// gated >5-item initialization and PO-commit writers. This is not PO/UI acceptance.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const {seedFifteenReceivingSource}=require('./fixtures/fifteen-receiving-source.cjs');
const {receiveV2Supply}=require('../functions/supply-receipt-service');
const limits=require('../functions/receipt-transaction');
const clients=[];let server,db,accounts;
test.before(()=>{
 for(const key of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])assert.match(process.env[key]||'',/^(127\.0\.0\.1|localhost):\d+$/);
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,'demo-yushin');
 server=admin.initializeApp({projectId:'demo-yushin'},'receiving-fifteen');db=getFirestore(server);accounts=adminAuth(server);
});
test.after(async()=>{await Promise.all(clients.map(deleteApp));await server?.delete();});
async function actor(tag,role){
 const uid='receipt15-'+tag,email=uid+'@example.test';
 await accounts.createUser({uid,email,password:'EmulatorOnly!123456'});
 await db.collection('users').doc(uid).set({role,active:true});
 const app=initializeApp({apiKey:'fake-api-key',projectId:'demo-yushin',appId:'receipt15'},uid);clients.push(app);
 const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 await signInWithEmailAndPassword(auth,email,'EmulatorOnly!123456');
 const functions=getFunctions(app,'asia-east1');connectFunctionsEmulator(functions,'127.0.0.1',5001);
 return {uid,receive:input=>httpsCallable(functions,'receiveV2Supply',{timeout:60000})(input).then(r=>r.data)};
}
async function fixture(tag,count,{role='warehouse',...options}={}){
 const receiver=await actor(tag,role);
 return {...await seedFifteenReceivingSource(db,receiver.uid,tag,count,options),receiver,receive:receiver.receive};
}
test('real Auth six and fifteen source lines receive first and last siblings exactly once across two warehouses',{timeout:180000},async()=>{
 for(const count of [6,15]){
  const x=await fixture('rows'+count,count,{role:count===6?'purchaser':'warehouse'}),original=(await db.doc('orders/'+x.orderId).get()).data();
  const last=count-1,first=x.input(0),lastInput=x.input(last,2);
  await Promise.all([assert.rejects(x.receive(first).then(()=>{throw Error('successful reply discarded');}),/successful reply discarded/),x.receive(first),x.receive(lastInput)]);
  const after=await x.snapshot();await x.receive(first);await x.receive(lastInput);assert.deepEqual(await x.snapshot(),after);
  const order=(await db.doc('orders/'+x.orderId).get()).data();
  assert.equal(order.items[0].receivedQty,1);assert.equal(order.items[last].receivedQty,2);
  for(let index=1;index<last;index++)assert.deepEqual(order.items[index],original.items[index]);
  assert.equal(after.receipts.length,2);assert.equal(after.inventoryLots.length,2);assert.equal(after.inventoryLotCosts.length,2);
  for(const key of x.keys){
   const received=(key===original.items[0].productId?1:0)+(key===original.items[last].productId?2:0);
   const total=original.items.filter(row=>row.productId===key).length*3;
   const stock=(await db.doc('inventory/'+key).get()).data();
   assert.equal(stock.onHand,received);assert.equal(stock.reserved,received);assert.equal(stock.incoming,total-received);
   for(const warehouse of x.warehouses){
    const same=original.items.filter(row=>row.productId===key&&row.warehouseId===warehouse);
    const landed=(original.items[0].productId===key&&original.items[0].warehouseId===warehouse?1:0)+(original.items[last].productId===key&&original.items[last].warehouseId===warehouse?2:0);
    const local=(await db.doc('warehouseStocks/'+warehouse+'__'+key).get()).data();
    assert.equal(local.onHand,landed);assert.equal(local.reserved,landed);assert.equal(local.incoming,same.length*3-landed);
   }
  }
  assert.equal(after.receivingSupplyOrders.length,2);for(const [,view] of after.receivingSupplyOrders)assert.equal(view.unitCost,undefined);
  for(const [index,received] of [[0,1],[last,2]]){
   const item=order.items[index],ledger=(await db.doc('inventoryReservations/'+x.orderId+'__'+item.itemId).get()).data();
   assert.equal(ledger.quantity,received);assert.equal(ledger.shortageQty,3-received);
   assert.deepEqual(ledger.locations,[{warehouseId:item.warehouseId,reservedQty:received}]);
   assert.equal((await db.doc('procurementDemands/'+x.demands[index]).get()).data().receivedQty,received);
  }
  const candidates=await Promise.allSettled([x.receive(x.input(last,1,'final-a')),x.receive(x.input(last,1,'final-b'))]);
  assert.equal(candidates.filter(row=>row.status==='fulfilled').length,1);
  assert.equal((await db.doc('supplyOrders/'+x.supplies[last]).get()).data().receivedQty,3);
  assert.equal((await x.snapshot()).receipts.length,3);
 }
});
test('real Auth fifteen source rejects invalid sibling, excess, sixteen lines and role changes without partial writes',{timeout:180000},async()=>{
 const x=await fixture('reject',15),ref=db.doc('orders/'+x.orderId),original=(await ref.get()).data();
 for(const change of [
  {items:original.items.map((row,i)=>i===14?{...row,shortageQty:99}:row)},
  {items:[...original.items,{...original.items[14],itemId:'I15'}]},
  {items:original.items.map((row,i)=>i===14?{...row,fulfillmentType:'DIRECT_SHIP'}:row)},
  {items:original.items.map((row,i)=>i===14?{...row,itemId:'I0'}:row)}
 ]){await ref.update(change);const before=await x.snapshot();await assert.rejects(x.receive(x.input(0)));assert.deepEqual(await x.snapshot(),before);await ref.set(original);}
 const before=await x.snapshot();await assert.rejects(x.receive(x.input(14,4)));assert.deepEqual(await x.snapshot(),before);
 for(const role of ['sales','engineer']){
  const denied=await actor('denied-'+role,role);await assert.rejects(denied.receive(x.input(14)),e=>e.code==='functions/permission-denied');assert.deepEqual(await x.snapshot(),before);
 }
 await db.doc('users/'+x.receiver.uid).update({disabled:true});
 await assert.rejects(x.receive(x.input(14)),e=>e.code==='functions/permission-denied');assert.deepEqual(await x.snapshot(),before);
});
test('fifteen mixed source retains service state and fits measured per-attempt document/request/write budgets',{timeout:180000},async()=>{
 const x=await fixture('mixed',15,{service:true,role:'admin',distinct:true}),attempts=[];
 const instrumented={projectId:db.projectId,collection:name=>db.collection(name),runTransaction:callback=>db.runTransaction(async native=>{
  const stats={documents:0,requests:0,writes:0};attempts.push(stats);
  return callback({get:async ref=>{stats.requests++;const snap=await native.get(ref);stats.documents+=snap.docs?snap.docs.length:1;return snap;},
   update:(...args)=>{stats.writes++;return native.update(...args);},set:(...args)=>{stats.writes++;return native.set(...args);}});
 })};
 const input=x.input(13,2),beforeService=structuredClone(x.items[14]);
 await receiveV2Supply(instrumented,x.receiver.uid,input);
 for(const stats of attempts){assert.ok(stats.documents<=limits.MAX_READ_DOCUMENTS);assert.ok(stats.requests<=limits.MAX_READ_REQUESTS);assert.ok(stats.writes<=limits.MAX_WRITES);}
 assert.ok(attempts.length);console.log('mixed15 receipt transaction attempts',JSON.stringify(attempts));
 const order=(await db.doc('orders/'+x.orderId).get()).data();assert.deepEqual(order.items[14],beforeService);
 assert.equal(order.items[13].receivedQty,2);assert.ok(Array.isArray(order.workCategories));
 const after=await x.snapshot();await x.receive(input);assert.deepEqual(await x.snapshot(),after);
 assert.equal(after.serviceCases.length,0);assert.equal(after.receipts.length,1);
});
