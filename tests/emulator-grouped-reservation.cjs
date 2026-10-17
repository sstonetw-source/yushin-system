'use strict';
// Real Firebase Admin SDK + Firestore Emulator transactions. No production
// app, credentials, network services, or browser SDK writes are involved.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {commitGroupedWarehouseReservation}=require('../functions/grouped-reservation-service');

let db,app;
test.before(()=>{
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Must run inside Firestore Emulator');
  app=admin.initializeApp({projectId:'demo-yushin'},'grouped-reservation-emulator-tests');
  db=getFirestore(app);
});
test.after(async()=>{if(app)await app.delete();});
async function seed(id,{role='purchaser',owner='sales1'}={}){
  const itemId1='I1',itemId2='I2',productKey='prod-'+id;
  const orderId='order-'+id,uid='actor-'+id;
  const batch=db.batch();
  const set=(path,data)=>batch.set(db.doc(path),data);
  set('users/'+uid,{active:true,role,salesCode:'S01'});
  set('orders/'+orderId,{ownerUid:owner==='actor'?uid:owner,salesCode:'S01',status:'active',
    inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_'+id+'_123456789',items:[
    {itemId:itemId1,productId:productKey,warehouseId:'A',qty:5,reservedQty:0},
    {itemId:itemId2,productId:productKey,warehouseId:'B',qty:5,reservedQty:0}
  ]});
  set('products/'+productKey,{productId:productKey,productType:'Goods'});
  set('inventory/'+productKey,{productKey,onHand:20,reserved:0,transferFreeInTransit:0});
  for(const wh of ['A','B']){
    set('warehouses/'+wh,{active:true});
    set('warehouseStocks/'+wh+'__'+productKey,{productKey,warehouseId:wh,onHand:10,reserved:0,transferFreeInTransit:0});
  }
  await batch.commit();
  const intent=(a,b,attempt='attempt_'+id+'_123456789')=>({orderId,attemptId:attempt,
    syncAttemptId:'sync_'+id+'_123456789',items:[
    {itemId:itemId1,quantity:a},{itemId:itemId2,quantity:b}
  ]});
  const doc=async path=>(await db.doc(path).get()).data();
  return {uid,orderId,productKey,intent,doc,
    call:(data,otherUid=uid)=>commitGroupedWarehouseReservation(db,otherUid,data)};
}
test('Admin SDK transaction commits company/warehouse/reservation/receipts together and replays safely',async()=>{
  const f=await seed('atomic');
  const result=await f.call(f.intent(2,3));assert.equal(result.status,'applied');
  assert.equal((await f.doc('inventory/'+f.productKey)).reserved,5);
  assert.equal((await f.doc('warehouseStocks/A__'+f.productKey)).reserved,2);
  assert.equal((await f.doc('warehouseStocks/B__'+f.productKey)).reserved,3);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I1')).quantity,2);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I2')).quantity,3);
  assert.equal((await f.call(f.intent(2,3))).status,'already-applied');
  assert.equal((await f.doc('inventory/'+f.productKey)).reserved,5);
  await assert.rejects(f.call(f.intent(3,2)),/操作識別碼/);
});
test('Emulator commit rejects stolen owner and disabled actor with no stock change',async()=>{
  const sales=await seed('owner',{role:'sales',owner:'someone-else'});
  await assert.rejects(sales.call(sales.intent(1,1)),/自己的訂單/);
  assert.equal((await sales.doc('inventory/'+sales.productKey)).reserved,0);
  const off=await seed('disabled');
  await db.doc('users/'+off.uid).update({active:false});
  await assert.rejects(off.call(off.intent(2,3)),/停用/);
  assert.equal((await off.doc('inventory/'+off.productKey)).reserved,0);
});
test('Emulator transaction keeps both warehouse totals consistent under simultaneous distinct operations',async()=>{
  const f=await seed('concurrent');
  await Promise.all([
    f.call(f.intent(2,3,'attempt_concurrent_A_12345')),
    f.call(f.intent(3,2,'attempt_concurrent_B_12345'))
  ]);
  const a=(await f.doc('warehouseStocks/A__'+f.productKey)).reserved;
  const b=(await f.doc('warehouseStocks/B__'+f.productKey)).reserved;
  const total=(await f.doc('inventory/'+f.productKey)).reserved;
  const order=await f.doc('orders/'+f.orderId);
  assert.equal(a+b,total);assert.equal(total,5);
  assert.equal(order.items[0].reservedQty,a);assert.equal(order.items[1].reservedQty,b);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I1')).quantity,a);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I2')).quantity,b);
});
test('Emulator rejects insufficient physical stock atomically',async()=>{
  const f=await seed('shortage');
  await db.doc('warehouseStocks/A__'+f.productKey).update({onHand:1});
  await assert.rejects(f.call(f.intent(2,3)),/庫存不足/);
  assert.equal((await f.doc('inventory/'+f.productKey)).reserved,0);
  assert.equal((await f.doc('warehouseStocks/B__'+f.productKey)).reserved,0);
  assert.equal((await db.doc('reservationOperationReceipts/grouped-attempt_shortage_123456789').get()).exists,false);
});

test('Admin transaction refuses a stale initial-sync attempt without changing stock',async()=>{
 const f=await seed('stale');
 await db.doc('orders/'+f.orderId).update({inventoryReservationAttemptId:'newer_attempt'});
 await assert.rejects(f.call(f.intent(2,3)),/同步狀態已變更/);
 assert.equal((await f.doc('inventory/'+f.productKey)).reserved,0);
 assert.equal((await db.doc('reservationOperationReceipts/grouped-attempt_stale_123456789').get()).exists,false);
});
