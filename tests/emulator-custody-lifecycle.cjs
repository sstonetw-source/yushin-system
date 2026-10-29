'use strict';
// Real Auth -> the exported Cloud Callable -> Admin Firestore transaction.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const clients=[];let server,db,accounts;
test.before(()=>{
 for(const key of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])
  assert.match(process.env[key]||'',/^(localhost|127\.0\.0\.1):[0-9]+$/);
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,'demo-yushin');
 server=admin.initializeApp({projectId:'demo-yushin'},'v3-custody-lifecycle-auth');
 db=getFirestore(server);accounts=adminAuth(server);
});
test.after(async()=>{await Promise.all(clients.map(deleteApp));if(server)await server.delete();});
async function fixture(tag){
 const prefix='v3-lifecycle-'+tag,uid=prefix+'-OWNER',orderId=prefix+'-ORDER',productKey=prefix+'-P';
 const transferId=prefix+'-HANDOFF',custody='custody-'+uid;
 const app=initializeApp({apiKey:'demo-api-key',projectId:'demo-yushin',appId:prefix},prefix);
 clients.push(app);
 const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
 await accounts.createUser({uid,email:uid+'@example.test',password:'EmulatorOnly!123456'});
 await signInWithEmailAndPassword(auth,uid+'@example.test','EmulatorOnly!123456');
 const functions=getFunctions(app,'asia-east1');connectFunctionsEmulator(functions,'127.0.0.1',5001);
 const batch=db.batch(),put=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 put('users',uid,{role:'sales',active:true});
 put('products',productKey,{active:true,productType:'Goods'});
 put('warehouses',custody,{active:true,systemCustody:true,warehouseType:'CUSTODY',ownerUid:uid});
 put('inventory',encodeURIComponent(productKey),{productKey,onHand:5,reserved:4});
 put('warehouseStocks',encodeURIComponent(custody)+'__'+encodeURIComponent(productKey),
  {productKey,warehouseId:custody,onHand:3,reserved:3});
 put('orders',orderId,{status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:'sync_1234567890',ownerUid:uid,salesCode:'S01',
  logisticsTransfersPending:0,orderLifecycleHistory:[],
  items:[{itemId:'I',qty:3,productId:productKey,reservedQty:3,shortageQty:0,
   warehouseId:custody,custodyTransferId:transferId}]});
 put('inventoryReservations',orderId+'__I',{orderId,itemId:'I',productKey,ownerUid:uid,salesCode:'S01',
  locationSchemaVersion:3,quantity:3,shortageQty:0,status:'active',
  locations:[{warehouseId:custody,reservedQty:3}],lifecycleWarehouseIds:['A','B'],
  sourceLocationSnapshot:[{warehouseId:'A',reservedQty:1},{warehouseId:'B',reservedQty:2}],
  custodyOriginalQty:3,custodyTransferId:transferId});
 const transfer={id:transferId,kind:'HANDOFF',status:'RECEIVED',orderId,itemId:'I',
  qty:3,ownerUid:uid,salesCode:'S01',toWarehouseId:custody,productKey,
  orderTransferIntentHash:'original-hash',reservationLocationSchemaVersion:2,
  custodyLocationSchemaVersion:3,lifecycleWarehouseIds:['A','B'],
  sourceLocations:[{warehouseId:'A',qty:1},{warehouseId:'B',qty:2}]};
 put('stockTransfers',transferId,transfer);
 put('reservationOperationReceipts','order-transfer-dispatch-'+transferId,
  {kind:'ORDER_TRANSFER_DISPATCH',intentHash:'original-hash',transfer});
 put('inventoryMovements',transferId+'-in',{
  type:'warehouse_transfer_in',sourceType:'WAREHOUSE_TRANSFER',sourceId:transferId,
  orderId,itemId:'I',productKey,warehouseId:custody,qty:3});
 put('inventoryLots',transferId+'-0',{productKey,warehouseId:custody,
  lotNo:'LOT',expiryDate:'2028-01-01',remainingQty:3,receivedQty:3,costLotId:'ORIGINAL-LOT'});
 put('inventoryLotCosts',transferId+'-0',{costSourceLotId:'ORIGINAL-LOT'});
 await batch.commit();
 const call=input=>httpsCallable(functions,'setV3CustodyOrderLifecycle',{timeout:60000})(input).then(r=>r.data);
 const read=async(name,id)=>(await db.collection(name).doc(id).get()).data();
 const intent=(nextStatus,operationId)=>({orderId,itemIds:['I'],nextStatus,operationId,
  syncAttemptId:'sync_1234567890',date:'2026-10-29',reason:'Emulator test'});
 const paths=[['orders',orderId],['inventory',encodeURIComponent(productKey)],
  ['warehouseStocks',encodeURIComponent(custody)+'__'+encodeURIComponent(productKey)],
  ['inventoryReservations',orderId+'__I'],['inventoryLots',transferId+'-0'],
  ['inventoryLotCosts',transferId+'-0'],['stockTransfers',transferId]];
 const snapshot=async()=>Promise.all(paths.map(async ([name,id])=>({path:name+'/'+id,data:await read(name,id)})));
 return{uid,orderId,productKey,transferId,custody,call,read,intent,snapshot};
}
test('V3 custody authenticated Callable atomically releases and restores, preserving original lot and transfer',async()=>{
 const f=await fixture('success');
 const initial=await f.snapshot();
 const cancel=f.intent('cancelled','v3_cancel_123456789');
 const results=await Promise.all([f.call(cancel),f.call(cancel)]);
 assert.deepEqual(results.map(x=>x.status).sort(),['already-applied','applied']);
 assert.equal((await f.read('inventory',encodeURIComponent(f.productKey))).reserved,1);
 assert.equal((await f.read('warehouseStocks',encodeURIComponent(f.custody)+'__'+encodeURIComponent(f.productKey))).reserved,0);
 assert.equal((await f.read('orders',f.orderId)).orderStatus,'cancelled');
 const released=await f.read('inventoryReservations',f.orderId+'__I');
 assert.equal(released.quantity,0);assert.deepEqual(released.locations,[]);
 assert.deepEqual(released.sourceLocationSnapshot,[{warehouseId:'A',reservedQty:1},{warehouseId:'B',reservedQty:2}]);
 assert.equal((await f.read('inventoryMovements','v3-custody-life-v3_cancel_123456789-I')).qty,-3);
 const restore=f.intent('normal','v3_restore_123456789');
 assert.equal((await f.call(restore)).status,'applied');
 assert.equal((await f.read('inventory',encodeURIComponent(f.productKey))).reserved,4);
 assert.equal((await f.read('warehouseStocks',encodeURIComponent(f.custody)+'__'+encodeURIComponent(f.productKey))).reserved,3);
 assert.equal((await f.read('orders',f.orderId)).orderStatus,'normal');
 assert.equal((await f.call(cancel)).status,'already-applied');
 assert.equal((await f.read('orders',f.orderId)).orderStatus,'normal');
 const after=await f.snapshot();
 for(const p of ['inventoryLots/','inventoryLotCosts/','stockTransfers/'])
  assert.deepEqual(after.find(x=>x.path.startsWith(p)),initial.find(x=>x.path.startsWith(p)));
});
test('V3 custody Callable rejects invalid role, forged provenance and stock shortages without writes',async()=>{
 const f=await fixture('guard');
 const cancel=f.intent('cancelled','v3_guard_123456789');
 await db.collection('users').doc(f.uid).update({role:'warehouse'});
 let before=await f.snapshot();await assert.rejects(f.call(cancel),e=>e.code==='functions/permission-denied');
 assert.deepEqual(await f.snapshot(),before);
 await db.collection('users').doc(f.uid).update({role:'sales'});
 await db.collection('stockTransfers').doc(f.transferId).update({toWarehouseId:'OTHER'});
 before=await f.snapshot();await assert.rejects(f.call(cancel));assert.deepEqual(await f.snapshot(),before);
 await db.collection('stockTransfers').doc(f.transferId).update({toWarehouseId:f.custody});
 await db.collection('inventory').doc(encodeURIComponent(f.productKey)).update({reserved:1});
 before=await f.snapshot();await assert.rejects(f.call(cancel));assert.deepEqual(await f.snapshot(),before);
});
