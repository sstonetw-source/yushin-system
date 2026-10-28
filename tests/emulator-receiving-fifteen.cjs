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
const clients=[],fixtures=[];let server,db,accounts;
test.before(()=>{
 for(const key of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])assert.match(process.env[key]||'',/^(127\.0\.0\.1|localhost):\d+$/);
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,'demo-yushin');
 server=admin.initializeApp({projectId:'demo-yushin'},'receiving-fifteen');db=getFirestore(server);accounts=adminAuth(server);
});
test.after(async()=>{try{for(const fixture of fixtures)await fixture.cleanup();}finally{await Promise.all(clients.map(deleteApp));await server?.delete();}});
async function actor(tag,role){
 const uid='receipt15-'+tag,email=uid+'@example.test';
 await accounts.createUser({uid,email,password:'EmulatorOnly!123456'});
 await db.collection('users').doc(uid).set({role,active:true});
 const app=initializeApp({apiKey:'fake-api-key',projectId:'demo-yushin',appId:'receipt15'},uid);clients.push(app);
 const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 await signInWithEmailAndPassword(auth,email,'EmulatorOnly!123456');
 const functions=getFunctions(app,'asia-east1');connectFunctionsEmulator(functions,'127.0.0.1',5001);
 return {uid,app,purchase:input=>httpsCallable(functions,'commitV2QuickPurchase',{timeout:60000})(input).then(r=>r.data),receive:input=>httpsCallable(functions,'receiveV2Supply',{timeout:60000})(input).then(r=>r.data)};
}
async function fixture(tag,count,{role='warehouse',...options}={}){
 const receiver=await actor(tag,role);
 const source=await seedFifteenReceivingSource(db,receiver.uid,tag,count,options);fixtures.push(source);
 return {...source,receiver,receive:receiver.receive};
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
 // Direct measurement models the function process explicitly; the Node test
 // runner itself is not the Functions Emulator child process.
 await receiveV2Supply(instrumented,x.receiver.uid,input,{...process.env,FUNCTIONS_EMULATOR:'true'});
 for(const stats of attempts){assert.ok(stats.documents<=limits.MAX_READ_DOCUMENTS);assert.ok(stats.requests<=limits.MAX_READ_REQUESTS);assert.ok(stats.writes<=limits.MAX_WRITES);}
 assert.ok(attempts.length);console.log('mixed15 receipt transaction attempts',JSON.stringify(attempts));
 const order=(await db.doc('orders/'+x.orderId).get()).data();assert.deepEqual(order.items[14],beforeService);
 assert.equal(order.items[13].receivedQty,2);assert.ok(Array.isArray(order.workCategories));
 const after=await x.snapshot();await x.receive(input);assert.deepEqual(await x.snapshot(),after);
 assert.equal(after.serviceCases.length,0);assert.equal(after.receipts.length,1);
});

test('Preview-gated handler completes the fifteen-line shared writer on an explicitly emulator-backed project facade',{timeout:180000},async()=>{
 // This facade tests the Preview authorization branch against real Emulator
 // transactions. It is deliberately NOT a deployed Preview/Auth acceptance test.
 const x=await fixture('preview-facade',15,{service:true,role:'purchaser'});
 const {createSupplyReceiptCallable}=require('../functions/supply-receipt-callable');
 let reads=0,writes=0;
 const binding={projectId:'preview-20135',collection:name=>{reads++;return db.collection(name);},runTransaction:fn=>db.runTransaction(async native=>fn({
  get:ref=>native.get(ref),set:(...args)=>{writes++;return native.set(...args);},update:(...args)=>{writes++;return native.update(...args);}}))};
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const env={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_RECEIVING:'true'};
 const handler=(environment=env,database=binding)=>createSupplyReceiptCallable({env:environment,onCall:(_opts,callback)=>callback,HttpsError,getDatabase:()=>database});
 const request={auth:{uid:x.receiver.uid},data:x.input(13,2)};
 const reply=await handler()(request);assert.equal(reply.status,'confirmed');assert.ok(writes>0);
 const after=await x.snapshot(),committedWrites=writes;
 await handler()(request);assert.equal(writes,committedWrites);assert.deepEqual(await x.snapshot(),after);
 for(const bad of [{...env,ENABLE_PREVIEW_RECEIVING:'false'},{...env,GCLOUD_PROJECT:'yu-shing-company'},
  {...env,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},{...env,FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}]){
  const previousReads=reads;await assert.rejects(handler(bad)(request),{code:'failed-precondition'});assert.equal(reads,previousReads);
 }
 const previousReads=reads;await assert.rejects(handler(env,{...binding,projectId:'yu-shing-company'})(request),{code:'failed-precondition'});assert.equal(reads,previousReads);
 await assert.rejects(handler()({data:request.data}),{code:'unauthenticated'});
 await db.doc('users/'+x.receiver.uid).update({disabled:true});
 await assert.rejects(handler()({...request,data:x.input(13,1,'later')}),{code:'permission-denied'});assert.deepEqual(await x.snapshot(),after);
});

// Source creation uses real Client Rules; only masters/opening balances are Admin fixtures.
// Initialization retains the existing explicitly enforced Service-adapter boundary.
test('fifteen Auth-created lines flow through initialization, manual purchasing/incoming and canonical receiving',{timeout:180000},async()=>{
 const {orderCreationClient}=require('./fixtures/order-creation-client.cjs');
 const {synchronizeV2OrderFixture}=require('./fixtures/v2-order-initialization.cjs');
 const tag='created15-chain',orderId=tag+'-order',keys=[tag+'-P',tag+'-Q'],warehouses=[tag+'-A',tag+'-B'];
 const sales=await actor(tag+'-sales','sales'),buyer=await actor(tag+'-buyer','purchaser'),warehouse=await actor(tag+'-warehouse','warehouse');
 await db.doc('users/'+sales.uid).update({code:'B',name:'sales'});
 const names=['orders','products','warehouses','inventory','warehouseStocks','inventoryReservations','procurementDemands',
  'supplyOrders','receivingSupplyOrders','purchaseOperations','reservationOperationReceipts','inventoryMovements','receipts','inventoryLots','inventoryLotCosts'];
 const owned=doc=>doc.id.includes(tag)||[doc.data().orderId,doc.data().sourceId,doc.data().productKey,doc.data().productId].some(v=>typeof v==='string'&&v.includes(tag));
 const snapshot=async()=>Object.fromEntries(await Promise.all(names.map(async name=>[name,(await db.collection(name).get()).docs.filter(owned)
  .map(d=>[d.id,d.data()]).sort((a,b)=>a[0].localeCompare(b[0]))])));
 const cleanup=async()=>{
  assert.equal(db.projectId,'demo-yushin');assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(localhost|127\.0\.0\.1):\d+$/);
  const rows=await snapshot(),paths=Object.entries(rows).flatMap(([name,docs])=>docs.map(([id])=>name+'/'+id));
  for(let i=0;i<paths.length;i+=400){const batch=db.batch();for(const path of paths.slice(i,i+400))batch.delete(db.doc(path));await batch.commit();}
 };
 fixtures.push({cleanup});
 const seed=db.batch();
 for(const id of warehouses)seed.set(db.doc('warehouses/'+id),{active:true,warehouseName:id});
 for(const key of keys){
  seed.set(db.doc('products/'+key),{active:true,productType:'Goods',productId:key,itemCode:key,model:key,brand:'Roche',nameCn:key});
  seed.set(db.doc('inventory/'+key),{productId:key,productKey:key,onHand:0,reserved:0,incoming:0,transferFreeInTransit:0});
  for(const id of warehouses)seed.set(db.doc('warehouseStocks/'+id+'__'+key),{warehouseId:id,productId:key,productKey:key,onHand:0,reserved:0,incoming:0,transferFreeInTransit:0});
 }
 await seed.commit();
 const items=Array.from({length:15},(_,i)=>({itemId:'I'+i,productId:keys[i%2],itemCode:keys[i%2],itemName:keys[i%2],brand:'Roche',
  qty:3,warehouseId:warehouses[Math.floor(i/2)%2],unitPrice:100,fulfillmentType:'WAREHOUSE',reservedQty:0,deliveredQty:0,returnedQty:0,
  dispatchPreparedQty:0,warehouseShippedQty:0,deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'測試',phone:'02-12345678',address:'測試地址'}}));
 const source={transactionType:'借',orderNo:orderId,customerName:'15品項串接驗收',ownerUid:sales.uid,salesCode:'B',status:'active',orderStatus:'normal',
  createdByUid:sales.uid,createdByRole:'sales',createdAt:new Date().toISOString(),productId:keys[0],productMasterMatched:true,
  itemCount:15,orderSchemaVersion:2,orderDate:'2026-10-28',inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_'+tag,
  deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,items};
 const creator=orderCreationClient(sales.app,sales.uid,'sales');
 await creator.create(orderId,source);
 assert.deepEqual((await db.doc('orders/'+orderId).get()).data(),source);
 await synchronizeV2OrderFixture(db,buyer.uid,{orderId,warehouseIds:warehouses});
 const initialized=(await db.doc('orders/'+orderId).get()).data();
 assert.equal(initialized.inventoryReservationStatus,'completed');
 assert.equal(initialized.items.length,15);
 assert.ok(initialized.items.every(i=>i.reservedQty===0&&i.shortageQty===3));
 const intents=items.map((row,i)=>({operationId:tag+'-purchase-'+i,orderId,itemId:row.itemId,qty:3,supplier:'Vendor',unitCost:17}));
 const replies=[];for(const intent of intents)replies.push(await buyer.purchase(intent));
 assert.ok(replies.every(r=>r.status==='committed'));
 const purchased=await snapshot();
 assert.equal(purchased.purchaseOperations.length,15);assert.equal(purchased.supplyOrders.length,15);
 assert.equal(purchased.inventoryMovements.length,15);
 for(const key of keys){const stock=(await db.doc('inventory/'+key).get()).data();assert.equal(stock.incoming,items.filter(i=>i.productId===key).length*3);assert.equal(stock.onHand,0);}
 // Replaying an actual committed request (a lost-reply recovery) changes no facts.
 assert.equal((await buyer.purchase(intents[0])).status,'already-applied');assert.deepEqual(await snapshot(),purchased);
 const receipts=[0,14].map(i=>({supplyId:replies[i].supplyId,operationId:tag+'-receipt-'+i,qty:2,lotNo:'L'+i,expiryDate:'2028-01-01'}));
 for(const input of receipts)assert.equal((await warehouse.receive(input)).status,'confirmed');
 const received=await snapshot(),order=(await db.doc('orders/'+orderId).get()).data();
 assert.equal(received.receipts.length,2);assert.equal(received.inventoryLots.length,2);assert.equal(received.inventoryLotCosts.length,2);
 assert.equal(received.inventoryMovements.length,17);
 for(let i=0;i<15;i++){
  assert.equal(order.items[i].receivedQty||0,[0,14].includes(i)?2:0);
  assert.equal(order.items[i].supplyOrderedQty,3);
  const demand=received.procurementDemands.map(([,d])=>d).find(d=>d.sourceItemId==='I'+i);
  assert.equal(demand.orderedQty,3);assert.equal(demand.receivedQty,[0,14].includes(i)?2:0);
 }
 for(const input of receipts)await warehouse.receive(input);
 await buyer.purchase(intents[0]);assert.deepEqual(await snapshot(),received);
 const stock=(await db.doc('inventory/'+keys[0]).get()).data();assert.equal(stock.onHand,4);assert.equal(stock.reserved,4);assert.equal(stock.incoming,20);
 await creator.create(orderId,{...source,customerName:'stale retry'});
 assert.deepEqual(await snapshot(),received,'same-ID creation cannot overwrite later transactions');
});
