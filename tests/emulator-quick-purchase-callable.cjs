'use strict';
// Real signed-in Auth + Callable + Admin Firestore transaction in demo Emulator.
// This file is never pointed at production or a remote Firestore instance.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp:clientApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const demandCore=require('../functions/shared/procurement-demand-core');
const project='demo-yushin';
let server,db,users;
const clients=[];
test.before(async()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Quick Purchase tests must not use live Firestore');
 assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST,'Quick Purchase tests must not use live Auth');
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,project);
 server=admin.initializeApp({projectId:project},'quick-purchase-callable-test');
 db=getFirestore(server);users=adminAuth(server);
});
test.after(async()=>{
 await Promise.all(clients.map(deleteApp));
 if(server)await server.delete();
});
async function seeded(tag,{role='purchaser',directShip=false,active=true}={}){
 const uid='quick-buyer-'+tag,email=uid+'@example.test';
 await users.createUser({uid,email,password:'EmulatorOnly!123456'});
 const client=clientApp({apiKey:'fake-api-key',authDomain:project+'.firebaseapp.com',
  projectId:project,appId:'quick-callable-test'},uid);
 clients.push(client);
 const auth=getAuth(client);
 connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 await signInWithEmailAndPassword(auth,email,'EmulatorOnly!123456');
 const functions=getFunctions(client,'asia-east1');
 connectFunctionsEmulator(functions,'127.0.0.1',5001);
 const call=httpsCallable(functions,'commitV2QuickPurchase');
 const orderId='quick-order-'+tag,itemId='I1',productId='quick-product-'+tag,warehouseId=directShip?'':'quick-warehouse-'+tag;
 const item={itemId,productId,warehouseId,fulfillmentType:directShip?'DIRECT_SHIP':'WAREHOUSE',
  qty:directShip?7:12,reservedQty:directShip?0:5,shortageQty:directShip?0:7,
  supplyOrderedQty:0,receivedQty:0};
 const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
 const demand=demandCore.demandDocument(demandCore.fromSalesOrder({...item,
  requiredSupplyQty:directShip?7:undefined,sourceType:'SALES_ORDER',
  sourceId:orderId,sourceItemId:itemId,sourceItemIndex:0,
  ownerUid:'seller-'+tag,salesCode:'S01',productKey:productId}));
 const batch=db.batch(),set=(path,data)=>batch.set(db.doc(path),data);
 set('users/'+uid,{role,active,name:'Buyer'});
 set('orders/'+orderId,{ownerUid:'seller-'+tag,salesCode:'S01',
  status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
  workCategories:['ordering'],items:[item]});
 set('products/'+productId,{productType:'Goods',active:true});
 set('procurementDemands/'+encodeURIComponent(demandId),demand);
 if(!directShip){
  set('warehouses/'+warehouseId,{active:true});
  set('inventory/'+encodeURIComponent(productId),{productId,productKey:productId,
   onHand:5,reserved:2,incoming:0});
  set('warehouseStocks/'+encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productId),
   {productId,productKey:productId,warehouseId,onHand:5,reserved:2,incoming:0});
 }
 await batch.commit();
 const intent=(operationId='operation-'+tag+'-001',qty=4,extra={})=>({
  operationId,orderId,itemId,qty,supplier:'Vendor',unitCost:19.99,...extra
 });
 const data=async path=>(await db.doc(path).get()).data();
 return {uid,call,intent,data,orderId,itemId,productId,warehouseId,demandId};
}
test('real purchaser Callable atomically creates supplier, demand, source, both incoming ledgers and replay receipt',async()=>{
 const f=await seeded('purchaser');
 const intent=f.intent();
 const first=(await f.call(intent)).data;
 assert.equal(first.status,'committed');
 assert.equal(first.committedQty,4);
 const supply=await f.data('supplyOrders/'+first.supplyId);
 assert.equal(supply.qty,4);assert.equal(supply.unitCost,19.99);
 assert.equal((await f.data('orders/'+f.orderId)).items[0].supplyOrderedQty,4);
 assert.equal((await f.data('procurementDemands/'+encodeURIComponent(f.demandId))).orderedQty,4);
 assert.equal((await f.data('inventory/'+f.productId)).incoming,4);
 assert.equal((await f.data('inventory/'+f.productId)).onHand,5);
 assert.equal((await f.data('warehouseStocks/'+f.warehouseId+'__'+f.productId)).incoming,4);
 assert.equal((await f.data('warehouseStocks/'+f.warehouseId+'__'+f.productId)).reserved,2);
 assert.equal((await f.data('inventoryMovements/quick-'+intent.operationId)).qty,4);
 const repeat=(await f.call(intent)).data;
 assert.equal(repeat.status,'already-applied');
 assert.equal((await f.data('inventory/'+f.productId)).incoming,4);
 await assert.rejects(f.call({...intent,qty:3}),e=>e.code==='functions/already-exists');
 assert.equal((await f.data('inventory/'+f.productId)).incoming,4);
});
test('replayed purchase rejects corrupted supply-source identity without another ledger write',async()=>{
 const f=await seeded('source-proof'),intent=f.intent();
 const first=(await f.call(intent)).data;
 await db.doc('supplyOrders/'+first.supplyId).update({sourceId:'forged-order'});
 await assert.rejects(f.call(intent),e=>e.code==='functions/failed-precondition');
 assert.equal((await f.data('inventory/'+f.productId)).incoming,4);
 assert.equal((await f.data('warehouseStocks/'+f.warehouseId+'__'+f.productId)).incoming,4);
 assert.equal((await f.data('inventoryMovements/quick-'+intent.operationId)).qty,4);
 assert.equal((await f.data('purchaseOperations/quick-'+intent.operationId)).supplyId,first.supplyId);
});
test('real admin can purchase; sales and engineer cannot forge purchaser role',async()=>{
 const admin=await seeded('admin',{role:'admin'});
 assert.equal((await admin.call(admin.intent())).data.status,'committed');
 for(const role of ['sales','engineer']){
  const f=await seeded('blocked-'+role,{role});
  await assert.rejects(f.call(f.intent()),e=>e.code==='functions/permission-denied');
  await assert.rejects(f.call(f.intent(undefined,4,{actorRole:'purchaser'})),
   e=>e.code==='functions/invalid-argument');
  assert.equal(await f.data('supplyOrders/manual-'+encodeURIComponent(f.orderId)+'-I1'),undefined);
  assert.equal((await f.data('inventory/'+f.productId)).incoming,0);
 }
});
test('real transaction rejects overorder, disabled user and corrupt stock without partial writes',async()=>{
 const f=await seeded('bad-stock');
 await db.doc('warehouseStocks/'+f.warehouseId+'__'+f.productId).update({incoming:-1});
 await assert.rejects(f.call(f.intent()),e=>e.code==='functions/failed-precondition');
 assert.equal(await f.data('purchaseOperations/quick-'+f.intent().operationId),undefined);
 assert.equal(await f.data('supplyOrders/manual-'+encodeURIComponent(f.orderId)+'-I1'),undefined);
 assert.equal((await f.data('inventory/'+f.productId)).incoming,0);
 const over=await seeded('overorder');
 await assert.rejects(over.call(over.intent(undefined,8)),e=>e.code==='functions/failed-precondition');
 assert.equal((await over.data('inventory/'+over.productId)).incoming,0);
 const off=await seeded('disabled',{active:false});
 await assert.rejects(off.call(off.intent()),e=>e.code==='functions/permission-denied');
 assert.equal((await off.data('inventory/'+off.productId)).incoming,0);
});
test('real concurrent identical operations do not double-book and a later distinct operation appends',async()=>{
 const f=await seeded('concurrent');
 const intent=f.intent();
 const results=await Promise.all([f.call(intent),f.call(intent)]);
 assert.deepEqual(results.map(r=>r.data.status).sort(),['already-applied','committed']);
 assert.equal((await f.data('inventory/'+f.productId)).incoming,4);
 const next=(await f.call(f.intent('operation-concurrent-002',3))).data;
 assert.equal(next.status,'committed');
 assert.equal((await f.data('inventory/'+f.productId)).incoming,7);
 const order=await f.data('orders/'+f.orderId);
 assert.equal(order.items[0].supplyOrderedQty,7);
 assert.equal(order.items[0].orderEvents.length,2);
 assert.equal((await f.data('procurementDemands/'+encodeURIComponent(f.demandId))).orderedQty,7);
});
test('real concurrent distinct operations cannot overbook the same shortage',async()=>{
 const f=await seeded('distinct-race');
 const a=f.intent('operation-distinct-race-A',5);
 const b=f.intent('operation-distinct-race-B',5);
 // Two different idempotency keys must still contend on the same source and demand.
 const results=await Promise.allSettled([f.call(a),f.call(b)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const rejected=results.find(r=>r.status==='rejected');
 assert.equal(rejected.reason.code,'functions/failed-precondition');
 const order=await f.data('orders/'+f.orderId);
 const demand=await f.data('procurementDemands/'+encodeURIComponent(f.demandId));
 assert.equal(order.items[0].supplyOrderedQty,5);
 assert.equal(demand.orderedQty,5);
 assert.equal(demand.remainingToOrderQty,2);
 assert.equal((await f.data('inventory/'+f.productId)).incoming,5);
 assert.equal((await f.data('warehouseStocks/'+f.warehouseId+'__'+f.productId)).incoming,5);
 const supply=await f.data('supplyOrders/manual-'+encodeURIComponent(f.orderId)+'-'+encodeURIComponent(f.itemId));
 assert.equal(supply.qty,5);
 assert.equal(supply.orderEvents.length,1);
 const operations=await Promise.all([a,b].map(i=>f.data('purchaseOperations/quick-'+i.operationId)));
 const movements=await Promise.all([a,b].map(i=>f.data('inventoryMovements/quick-'+i.operationId)));
 assert.equal(operations.filter(Boolean).length,1);
 assert.equal(movements.filter(Boolean).length,1);
});
test('real direct-ship purchase creates a cost-free receiving mirror without warehouse stock',async()=>{
 const f=await seeded('direct',{directShip:true});
 const res=(await f.call(f.intent())).data;
 assert.equal(res.status,'committed');
 const supply=await f.data('supplyOrders/'+res.supplyId);
 const mirror=await f.data('receivingSupplyOrders/'+res.supplyId);
 assert.equal(supply.incomingRegisteredQty,0);
 assert.equal(mirror.qty,4);
 assert.equal(Object.hasOwn(mirror,'unitCost'),false);
 assert.equal(await f.data('inventory/'+f.productId),undefined);
});

test('real purchaser cannot order a sales-self-order item through privileged Callable',async()=>{
 const f=await seeded('self-order');
 const order=await f.data('orders/'+f.orderId);
 order.items[0].procurementType='SALES_SELF_ORDER';
 await db.doc('orders/'+f.orderId).update({items:order.items});
 await assert.rejects(f.call(f.intent()),e=>e.code==='functions/failed-precondition');
 assert.equal(await f.data('purchaseOperations/quick-'+f.intent().operationId),undefined);
 assert.equal((await f.data('inventory/'+f.productId)).incoming,0);
 assert.equal((await f.data('procurementDemands/'+encodeURIComponent(f.demandId))).orderedQty,0);
});
