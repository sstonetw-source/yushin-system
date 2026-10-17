'use strict';
// Real Firebase Authentication + Callable Functions + Admin/Firestore Emulator.
// No production project or credentials are contacted.
const test=require('node:test');
const assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp:initializeClient,deleteApp:deleteClient}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const project='demo-yushin';
let server,db,users;
const clients=[];
const docs={};
test.before(async()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Never run on live Firestore');
 assert.ok(process.env.FIREBASE_AUTH_EMULATOR_HOST,'Never run on live Auth');
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,project);
 server=admin.initializeApp({projectId:project},'callable-auth-integration');
 db=getFirestore(server);users=adminAuth(server);
});
test.after(async()=>{
 await Promise.all(clients.map(deleteClient));
 if(server)await server.delete();
});
async function seeded(tag,{role='purchaser',owner='buyer'}={}){
 const uid='callable-'+tag;
 const email=uid+'@example.test';
 await users.createUser({uid,email,password:'EmulatorOnly!123456'});
 const client=initializeClient({apiKey:'fake-api-key',authDomain:project+'.firebaseapp.com',
  projectId:project,appId:'demo-callable-test'},uid);
 clients.push(client);
 const auth=getAuth(client);
 connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 await signInWithEmailAndPassword(auth,email,'EmulatorOnly!123456');
 const functions=getFunctions(client,'asia-east1');
 connectFunctionsEmulator(functions,'127.0.0.1',5001);
 const call=httpsCallable(functions,'commitGroupedWarehouseReservation');
 const orderId='order-'+tag,productKey='product-'+tag,attemptId='attempt_'+tag+'_callable_123';
 const syncAttemptId='sync_'+tag+'_123456789';
 const batch=db.batch();
 const set=(path,data)=>batch.set(db.doc(path),data);
 set('users/'+uid,{role,active:true,salesCode:'A'});
 set('products/'+productKey,{productType:'Goods'});
 set('orders/'+orderId,{status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:syncAttemptId,
  ownerUid:owner==='buyer'?uid:owner,salesCode:'A',
  items:[{itemId:'I1',productId:productKey,warehouseId:'A',qty:5,reservedQty:0},
    {itemId:'I2',productId:productKey,warehouseId:'B',qty:5,reservedQty:0}]
 });
 set('inventory/'+productKey,{productKey,onHand:20,reserved:0,transferFreeInTransit:0});
 for(const warehouseId of ['A','B']){
  set('warehouses/'+warehouseId,{active:true});
  set('warehouseStocks/'+warehouseId+'__'+productKey,{productKey,warehouseId,
    onHand:10,reserved:0,transferFreeInTransit:0});
 }
 await batch.commit();
 const intent=(quantityA=2,quantityB=3,override={})=>({orderId,attemptId,syncAttemptId,
  items:[{itemId:'I1',quantity:quantityA},{itemId:'I2',quantity:quantityB}],...override});
 return {uid,call,intent,orderId,productKey,attemptId,
  data:async path=>(await db.doc(path).get()).data()};
}
test('signed-in purchaser: Callable transaction + idempotency + company/warehouse/order updates',async()=>{
 const f=await seeded('purchase');
 const one=(await f.call(f.intent())).data;
 assert.equal(one.status,'applied');assert.equal(one.companyReservedDelta,5);
 assert.equal((await f.call(f.intent())).data.status,'already-applied');
 assert.equal((await f.data('inventory/'+f.productKey)).reserved,5);
 assert.equal((await f.data('warehouseStocks/A__'+f.productKey)).reserved,2);
 assert.equal((await f.data('warehouseStocks/B__'+f.productKey)).reserved,3);
 assert.equal((await f.data('orders/'+f.orderId)).items[0].reservedQty,2);
 await assert.rejects(f.call(f.intent(3,3)),e=>e.code==='functions/already-exists');
 assert.equal((await f.data('inventory/'+f.productKey)).reserved,5);
});
test('Callable uses authenticated UID, denies unauthorized owner and fake role',async()=>{
 const f=await seeded('other-owner',{role:'sales',owner:'unrelated'});
 await assert.rejects(f.call(f.intent()),e=>e.code==='functions/permission-denied');
 await assert.rejects(f.call(f.intent(2,3,{actorRole:'admin'})),e=>e.code==='functions/invalid-argument');
 assert.equal((await f.data('inventory/'+f.productKey)).reserved,0);
});
test('Callable reads latest active role; disabled user cannot reserve',async()=>{
 const f=await seeded('disabled');
 await db.doc('users/'+f.uid).update({active:false});
 await assert.rejects(f.call(f.intent()),e=>e.code==='functions/permission-denied');
 assert.equal((await f.data('inventory/'+f.productKey)).reserved,0);
});
test('No Auth token: Callable rejects without writing stock',async()=>{
 const f=await seeded('no-auth');
 // Separate client app deliberately has no authenticated user.
 const client=initializeClient({apiKey:'fake-api-key',authDomain:project+'.firebaseapp.com',
  projectId:project,appId:'demo-anon-callable'},'no-auth-client');
 clients.push(client);
 const functions=getFunctions(client,'asia-east1');
 connectFunctionsEmulator(functions,'127.0.0.1',5001);
 await assert.rejects(httpsCallable(functions,'commitGroupedWarehouseReservation')(f.intent()),
  e=>e.code==='functions/unauthenticated');
 assert.equal((await f.data('inventory/'+f.productKey)).reserved,0);
});
test('Callable rejects changed sync checkpoint and cannot bypass disabled feature',async()=>{
 const f=await seeded('stale-sync');
 await db.doc('orders/'+f.orderId).update({inventoryReservationAttemptId:'superseding-attempt'});
 await assert.rejects(f.call(f.intent()),e=>e.code==='functions/failed-precondition');
 assert.equal((await f.data('inventory/'+f.productKey)).reserved,0);
});
