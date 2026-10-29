'use strict';
// A real authenticated Callable, not a direct Admin method pretending to be
// a client.  The suite also verifies the same operation ID after a lost reply.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {getAuth:adminAuth}=require('firebase-admin/auth');
const {initializeApp,deleteApp}=require('firebase/app');
const {getAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {getFunctions,connectFunctionsEmulator,httpsCallable}=require('firebase/functions');
const clients=[];let server,db,accounts;
test.before(()=>{
 assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):[0-9]+$/);
 assert.match(process.env.FIREBASE_AUTH_EMULATOR_HOST||'',/^(127\.0\.0\.1|localhost):[0-9]+$/);
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,'demo-yushin');
 server=admin.initializeApp({projectId:'demo-yushin'},'v3-custody-shipment-auth');
 db=getFirestore(server);accounts=adminAuth(server);
});
test.after(async()=>{await Promise.all(clients.map(deleteApp));if(server)await server.delete();});
async function fixture(tag){
 const prefix='v3-ship-'+tag,uid=prefix+'-OWNER',other=prefix+'-OTHER';
 const orderId=prefix+'-ORDER',productKey=prefix+'-P',transferId=prefix+'-HANDOFF';
 const custody='custody-'+uid,lotId=transferId+'-0';
 const apps=[];
 for(const user of [uid,other]){
  await accounts.createUser({uid:user,email:user+'@example.test',password:'EmulatorOnly!123456'});
  const app=initializeApp({apiKey:'demo-api-key',projectId:'demo-yushin',appId:user},user);
  clients.push(app);apps.push(app);
  const auth=getAuth(app);connectAuthEmulator(auth,'http://127.0.0.1:9099',{disableWarnings:true});
  await signInWithEmailAndPassword(auth,user+'@example.test','EmulatorOnly!123456');
 }
 const originalPlan={mode:'PICKUP',contact:'',phone:'',address:'',warehouseId:'',packages:1,notes:''};
 const batch=db.batch(),put=(name,key,data)=>batch.set(db.collection(name).doc(key),data);
 for(const user of [uid,other])put('users',user,{active:true,role:'sales'});
 put('products',productKey,{active:true,productType:'Goods'});
 put('warehouses',custody,{active:true,systemCustody:true,warehouseType:'CUSTODY',ownerUid:uid});
 put('inventory',encodeURIComponent(productKey),{productKey,onHand:7,reserved:4});
 put('warehouseStocks',encodeURIComponent(custody)+'__'+encodeURIComponent(productKey),
  {warehouseId:custody,productKey,onHand:5,reserved:3});
 put('orders',orderId,{status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:'sync_1234567890',ownerUid:uid,salesCode:'S01',logisticsTransfersPending:0,
  warehouseShipmentRecords:[],deliveryRecords:[],returnRecords:[],deliveredQty:0,returnedQty:0,isDelivered:false,
  items:[{itemId:'I',qty:3,productId:productKey,warehouseId:custody,custodyTransferId:transferId,
   reservedQty:3,shortageQty:0,dispatchPreparedQty:3,warehouseShippedQty:0,deliveryPlan:originalPlan}]});
 put('inventoryReservations',orderId+'__I',{orderId,itemId:'I',productKey,ownerUid:uid,salesCode:'S01',
  locationSchemaVersion:3,quantity:3,shortageQty:0,status:'active',custodyTransferId:transferId,
  locations:[{warehouseId:custody,reservedQty:3}],custodyOriginalQty:3,
  lifecycleWarehouseIds:['A','B'],sourceLocationSnapshot:[{warehouseId:'A',reservedQty:1},{warehouseId:'B',reservedQty:2}]});
 const transfer={id:transferId,kind:'HANDOFF',status:'RECEIVED',orderId,itemId:'I',productKey,
  ownerUid:uid,salesCode:'S01',qty:3,toWarehouseId:custody,deliveryPlan:originalPlan,
  orderTransferIntentHash:'hash-original',reservationLocationSchemaVersion:2,custodyLocationSchemaVersion:3,
  lifecycleWarehouseIds:['A','B'],sourceLocations:[{warehouseId:'A',qty:1},{warehouseId:'B',qty:2}],
  allocations:[{lotId:'ORIGINAL',targetLotId:lotId,qty:3,costLotId:'SOURCE-LOT'}]};
 put('stockTransfers',transferId,transfer);
 put('reservationOperationReceipts','order-transfer-dispatch-'+transferId,{
  kind:'ORDER_TRANSFER_DISPATCH',intentHash:'hash-original',transfer});
 put('inventoryMovements',transferId+'-in',{type:'warehouse_transfer_in',sourceType:'WAREHOUSE_TRANSFER',
  sourceId:transferId,orderId,itemId:'I',productKey,warehouseId:custody,qty:3});
 put('inventoryLots',lotId,{productKey,warehouseId:custody,sourceType:'WAREHOUSE_TRANSFER',
  sourceId:transferId,transferId,qty:3,remainingQty:3,costLotId:'SOURCE-LOT'});
 put('inventoryLotCosts',lotId,{productKey,warehouseId:custody,sourceId:transferId,
  costSourceLotId:'SOURCE-LOT',unitCost:432});
 // A second unrelated transfer in the same owner's Custody MUST NOT be
 // silently consumed by this order's reservation.
 put('inventoryLots',prefix+'-OTHER-LOT',{productKey,warehouseId:custody,sourceType:'WAREHOUSE_TRANSFER',
  sourceId:'OTHER-TRANSFER',transferId:'OTHER-TRANSFER',qty:2,remainingQty:2,costLotId:'OTHER-SOURCE'});
 await batch.commit();
 const makeCalls=app=>{
  const fn=getFunctions(app,'asia-east1');connectFunctionsEmulator(fn,'127.0.0.1',5001);
  return{
   ship:value=>httpsCallable(fn,'shipV3CustodyItem',{timeout:60000})(value).then(response=>response.data),
   confirm:value=>httpsCallable(fn,'confirmV3CustodyDelivery',{timeout:60000})(value).then(response=>response.data)
  };
 };
 const ownerCalls=makeCalls(apps[0]),otherCalls=makeCalls(apps[1]);
 const input=(operationId,quantity)=>({orderId,itemId:'I',warehouseId:custody,quantity,
  operationId,syncAttemptId:'sync_1234567890',date:'2026-10-29',notes:'原業務送出',
  expectedPlan:{mode:'CUSTOMER_SHIP',contact:'收件人',phone:'0222334455',
   address:'測試收件地址',warehouseId:'',packages:1,notes:''}});
 const confirmation=(shipmentId,operationId,quantity)=>({orderId,itemId:'I',shipmentId,operationId,
  quantity,syncAttemptId:'sync_1234567890',date:'2026-10-30',notes:'客戶已收貨'});
 const read=async(name,key)=>(await db.collection(name).doc(key).get()).data();
 const facts=async()=>({order:await read('orders',orderId),inventory:await read('inventory',encodeURIComponent(productKey)),
  stock:await read('warehouseStocks',encodeURIComponent(custody)+'__'+encodeURIComponent(productKey)),
  ledger:await read('inventoryReservations',orderId+'__I'),lot:await read('inventoryLots',lotId),
  extra:await read('inventoryLots',prefix+'-OTHER-LOT'),cost:await read('inventoryLotCosts',lotId)});
 return{uid,other,orderId,productKey,custody,transferId,lotId,
  call:ownerCalls.ship,otherCall:otherCalls.ship,confirm:ownerCalls.confirm,otherConfirm:otherCalls.confirm,
  input,confirmation,read,facts};
}
test('authenticated owner V3 Custody shipment consumes original source and reruns original ID only once',async()=>{
 const f=await fixture('flow');
 const before=await f.facts(),first=f.input('ship_custody_auth_1234',1);
 const [a,b]=await Promise.all([f.call(first),f.call(first)]);
 assert.deepEqual([a.status,b.status].sort(),['already-applied','applied']);
 const after=await f.facts();
 assert.equal(after.inventory.onHand,before.inventory.onHand-1);
 assert.equal(after.inventory.reserved,before.inventory.reserved-1);
 assert.equal(after.stock.onHand,before.stock.onHand-1);
 assert.equal(after.stock.reserved,before.stock.reserved-1);
 assert.equal(after.ledger.quantity,2);
 assert.equal(after.lot.remainingQty,2);
 assert.deepEqual(after.extra,before.extra);
 assert.deepEqual(after.cost,before.cost);
 assert.equal(after.order.items[0].warehouseShippedQty,1);
 assert.deepEqual(after.order.deliveryRecords,[]);
 assert.equal(after.order.isDelivered,false);
 const movement=await f.read('inventoryMovements','location-ship-'+first.operationId);
 assert.equal(movement.costPending,true);
 assert.equal(movement.custodyTransferId,f.transferId);
 assert.deepEqual(movement.lotAllocations.map(x=>x.costLotId),['SOURCE-LOT']);
 assert.equal((await f.call(first)).status,'already-applied');
 assert.deepEqual(await f.facts(),after);
 const last=await f.call(f.input('ship_custody_auth_5678',2));
 assert.equal(last.status,'applied');
 assert.equal((await f.facts()).ledger.status,'fulfilled');
 assert.equal((await f.facts()).lot.remainingQty,0);
 assert.equal((await f.facts()).extra.remainingQty,2);
 assert.equal((await f.facts()).order.deliveredQty,0);
 const beforeConfirmation=await f.facts();
 const confirmed1=f.confirmation(first.operationId,'custody_delivered_12345',1);
 const delivered=await f.confirm(confirmed1);
 assert.equal(delivered.status,'applied');assert.equal(delivered.confirmedQty,1);
 const afterFirstConfirmation=await f.facts();
 for(const key of ['inventory','stock','ledger','lot','extra','cost'])
  assert.deepEqual(afterFirstConfirmation[key],beforeConfirmation[key],key+' is not a delivery-side stock writer');
 assert.equal(afterFirstConfirmation.order.deliveredQty,1);
 assert.equal(afterFirstConfirmation.order.items[0].deliveredQty,1);
 assert.equal(afterFirstConfirmation.order.isDelivered,false);
 assert.equal((await f.confirm(confirmed1)).status,'already-applied');
 assert.deepEqual(await f.facts(),afterFirstConfirmation);
 const confirmed2=f.confirmation('ship_custody_auth_5678','custody_delivered_56789',2);
 assert.equal((await f.confirm(confirmed2)).status,'applied');
 assert.equal((await f.facts()).order.deliveredQty,3);
 assert.equal((await f.facts()).order.isDelivered,true);
 assert.equal((await f.facts()).inventory.onHand,beforeConfirmation.inventory.onHand);
});
test('real Auth rejects other sales and a mutated cost provenance without inventory writes',async()=>{
 const f=await fixture('blocked'),first=f.input('ship_custody_guard_123',1);
 const before=await f.facts();
 await assert.rejects(f.otherCall(first),error=>error.code==='functions/permission-denied');
 assert.deepEqual(await f.facts(),before);
 await db.collection('inventoryLotCosts').doc(f.lotId).update({costSourceLotId:'FORGED'});
 const tampered=await f.facts();
 await assert.rejects(f.call(first),error=>error.code==='functions/failed-precondition');
 assert.deepEqual(await f.facts(),tampered);
});
test('real Custody delivery Callable refuses other owner, unshipped quantities and forged physical proof',async()=>{
 const f=await fixture('delivery-guard'),shipment=f.input('custody_ship_guard_12345',1);
 await f.call(shipment);
 const receipt=f.confirmation(shipment.operationId,'custody_ack_guard_12345',1);
 const before=await f.facts();
 await assert.rejects(f.otherConfirm(receipt),e=>e.code==='functions/permission-denied');
 assert.deepEqual(await f.facts(),before);
 await assert.rejects(f.confirm({...receipt,quantity:2}),e=>e.code==='functions/failed-precondition');
 assert.deepEqual(await f.facts(),before);
 await db.collection('inventoryMovements').doc('location-ship-'+shipment.operationId)
  .update({custodyTransferId:'FORGED'});
 const altered=await f.facts();
 await assert.rejects(f.confirm(receipt),e=>e.code==='functions/failed-precondition');
 assert.deepEqual(await f.facts(),altered);
});
