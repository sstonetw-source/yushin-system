'use strict';
// Real Firestore test; never targets Preview or a production database.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {commitMainTransferPhysical}=require('../functions/main-transfer-physical-service');
const {drainReleasedV2FreeStock}=require('../functions/single-item-location-service');
let app,db;
const prefix='main-allocation-integration',productKey=prefix+'-P',uid=prefix+'-U';
const from=prefix+'-A',to=prefix+'-MAIN',transferId=prefix+'-transfer',requestId=prefix+'-request';
const orderId=prefix+'-order',stockId=warehouse=>warehouse+'__'+productKey;
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',
 FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099',ENABLE_MAIN_TRANSFER_DISPATCH_EMULATOR:'true',ENABLE_MAIN_TRANSFER_RECEIPT_EMULATOR:'true'};
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Never use live Firestore');
 app=admin.initializeApp({projectId:'demo-yushin'},prefix);db=getFirestore(app);
});
test.after(async()=>{if(app)await app.delete();});
test('real dispatch and receipt allocate a multi-item shortage through one durable existing source job',async()=>{
 const batch=db.batch(),set=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 set('users',uid,{active:true,role:'warehouse'});
 set('products',productKey,{active:true,productType:'Goods'});
 set('warehouses',from,{active:true});set('warehouses',to,{active:true,isDefault:true});
 set('inventory',productKey,{productKey,onHand:6,reserved:3,transferReserved:3});
 set('warehouseStocks',stockId(from),{productKey,warehouseId:from,onHand:6,reserved:3,transferReserved:3});
 set('stockTransferRequests',requestId,{id:requestId,inventoryId:productKey,productKey,
  fromWarehouseId:from,toWarehouseId:to,fromStockId:stockId(from),qty:3,status:'PENDING'});
 set('inventoryLots',prefix+'-lot',{productKey,warehouseId:from,remainingQty:6,lotNo:'L',expiryDate:'2027-01-01'});
 const sibling={itemId:'SIBLING',productId:'OTHER',qty:9,reservedQty:0,shortageQty:9,note:'untouched'};
 set('orders',orderId,{ownerUid:uid,salesCode:'S',status:'active',orderDate:'2026-10-01',
  inventoryReservationStatus:'completed',inventoryReservationAttemptId:prefix+'-sync',
  items:[sibling,{itemId:'TARGET',productId:productKey,qty:5,warehouseId:to,reservedQty:0,shortageQty:5}]});
 set('inventoryReservations',orderId+'__TARGET',{orderId,itemId:'TARGET',productKey,ownerUid:uid,salesCode:'S',
  locationSchemaVersion:2,locations:[],quantity:0,shortageQty:5,status:'shortage',orderDate:'2026-10-01'});
 await batch.commit();
 await commitMainTransferPhysical(db,uid,{id:transferId,requestId},'DISPATCH',env);
 await commitMainTransferPhysical(db,uid,{id:transferId,operationId:prefix+'-receipt'},'RECEIVE',env);
 const keys=['GCLOUD_PROJECT','FUNCTIONS_EMULATOR','FIREBASE_AUTH_EMULATOR_HOST','ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR'];
 const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 Object.assign(process.env,{GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099',ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR:'true'});
 try{
  const source={movementId:transferId+'-in',maxSteps:5};
  const results=await Promise.all([drainReleasedV2FreeStock(db,uid,source),drainReleasedV2FreeStock(db,uid,source)]);
  assert.equal(results[0].runId,results[1].runId);
  const replay=await drainReleasedV2FreeStock(db,uid,source);
  const {projectMainTransferAllocationCompletion}=require('../functions/main-transfer-allocation-completion');
  await projectMainTransferAllocationCompletion(db,uid,transferId);
  assert.equal((await db.collection('stockTransfers').doc(transferId).get()).data().allocationCompleted,true);
  assert.equal(replay.status,'completed');assert.equal(replay.allocatedQty,3);
  const order=(await db.collection('orders').doc(orderId).get()).data();
  assert.deepEqual(order.items[0],sibling);assert.equal(order.items[1].reservedQty,3);assert.equal(order.items[1].shortageQty,2);
  const company=(await db.collection('inventory').doc(productKey).get()).data();
  const stock=(await db.collection('warehouseStocks').doc(stockId(to)).get()).data();
  assert.equal(company.onHand,6);assert.equal(company.reserved,3);assert.equal(stock.onHand,3);assert.equal(stock.reserved,3);
  const movements=await db.collection('inventoryMovements').where('productKey','==',productKey).get();
  assert.equal(movements.docs.filter(s=>s.data().type==='reserve_from_free_stock').length,1);
  const before=JSON.stringify(movements.docs.map(s=>s.data()));
  await drainReleasedV2FreeStock(db,uid,source);
  assert.equal(JSON.stringify((await db.collection('inventoryMovements').where('productKey','==',productKey).get()).docs.map(s=>s.data())),before);
 }finally{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
