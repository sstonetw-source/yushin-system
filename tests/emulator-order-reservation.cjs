'use strict';
// Full-order initial reservation under the real Firestore Emulator/Admin SDK.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {commitOrderReservation}=require('../functions/order-reservation-service');
let app,db;
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Refuse production Firestore');
 app=admin.initializeApp({projectId:'demo-yushin'},'order-reservation-integration');
 db=getFirestore(app);
});
test.after(async()=>{if(app)await app.delete();});
async function seed(tag){
 const uid='initial-'+tag,orderId='initial-order-'+tag,productKey='initial-product-'+tag;
 const syncAttemptId='sync_'+tag+'_123456789';
 const batch=db.batch(),put=(path,data)=>batch.set(db.doc(path),data);
 put('users/'+uid,{active:true,role:'purchaser'});
 put('products/'+productKey,{productType:'Goods',active:true});
 put('warehouses/A',{active:true});put('warehouses/B',{active:true});
 put('inventory/'+productKey,{productKey,onHand:20,reserved:0});
 put('warehouseStocks/A__'+productKey,{productKey,warehouseId:'A',onHand:4,reserved:0});
 put('warehouseStocks/B__'+productKey,{productKey,warehouseId:'B',onHand:6,reserved:0});
 put('orders/'+orderId,{ownerUid:'sales1',salesCode:'S01',status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:syncAttemptId,items:[
   {itemId:'I1',productId:productKey,warehouseId:'A',qty:3,reservedQty:0},
   {itemId:'I2',productId:productKey,warehouseId:'A',qty:3,reservedQty:0},
   {itemId:'I3',productId:productKey,warehouseId:'B',qty:8,reservedQty:0}
  ]});
 await batch.commit();
 const intent={orderId,syncAttemptId};
 const get=async path=>(await db.doc(path).get()).data();
 return {uid,orderId,productKey,intent,get,call:()=>commitOrderReservation(db,uid,intent)};
}
test('full-order Admin transaction keeps company and all warehouse stock balanced',async()=>{
 const f=await seed('atomic');
 const first=await f.call();assert.equal(first.status,'applied');
 assert.deepEqual([first.reservedQty,first.shortageQty],[10,4]);
 const a=await f.get('warehouseStocks/A__'+f.productKey),b=await f.get('warehouseStocks/B__'+f.productKey);
 const company=await f.get('inventory/'+f.productKey);
 assert.deepEqual([company.reserved,a.reserved,b.reserved],[10,4,6]);
 const order=await f.get('orders/'+f.orderId);
 assert.deepEqual(order.items.map(x=>[x.reservedQty,x.shortageQty]),[[3,0],[1,2],[6,2]]);
 const demands=await Promise.all(['I2','I3'].map(itemId=>f.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.orderId+':'+itemId))));
 assert.deepEqual(demands.map(x=>x.requestedQty),[2,2]);
 assert.equal((await f.call()).status,'already-applied');
 assert.equal((await f.get('inventory/'+f.productKey)).reserved,10);
});
test('changed checkpoint and supplier commitments reject all writes',async()=>{
 const old=await seed('old');
 await db.doc('orders/'+old.orderId).update({inventoryReservationAttemptId:'sync_changed_123456'});
 await assert.rejects(old.call(),/較新的/);
 assert.equal((await old.get('inventory/'+old.productKey)).reserved,0);
 const f=await seed('committed');
 const demandId='SALES_ORDER:'+f.orderId+':I3';
 await db.doc('procurementDemands/'+encodeURIComponent(demandId)).set({
  demandId,sourceType:'SALES_ORDER',sourceId:f.orderId,sourceItemId:'I3',
  orderedQty:1,receivedQty:0
 });
 await assert.rejects(f.call(),/採購需求/);
 assert.equal((await f.get('inventory/'+f.productKey)).reserved,0);
 assert.equal((await db.doc('reservationOperationReceipts/order-sync-'+f.orderId+'__'+f.intent.syncAttemptId).get()).exists,false);
});
