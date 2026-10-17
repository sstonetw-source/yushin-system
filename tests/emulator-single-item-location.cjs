'use strict';
// Real Firestore Emulator: server-side read-only multiwarehouse v2 planner.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {planSingleItemTwoWarehouse}=require('../functions/single-item-location-service');
let app,db;
test.before(()=>{
 assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Never use live Firestore');
 app=admin.initializeApp({projectId:'demo-yushin'},'single-location-planner');
 db=getFirestore(app);
});
test.after(async()=>{if(app)await app.delete();});
async function seed(id,{role='sales',owner='actor',a=4,b=8,company=12,inTransit=0}={}){
 const orderId='v2-order-'+id,productKey='v2-product-'+id,uid='v2-user-'+id;
 const batch=db.batch();
 const set=(collection,key,value)=>batch.set(db.collection(collection).doc(key),value);
 set('users',uid,{active:true,role});
 set('products',productKey,{productType:'Goods'});
 set('orders',orderId,{ownerUid:owner==='actor'?uid:owner,salesCode:'V2',status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'v2_123456789',
  items:[{itemId:'I1',productId:productKey,qty:10,warehouseId:'A',
    deliveredQty:0,returnedQty:0,supplyOrderedQty:inTransit,receivedQty:0,reservedQty:0}]});
 set('inventory',productKey,{productKey,onHand:company,reserved:0,transferFreeInTransit:0});
 for(const [warehouseId,onHand] of [['A',a],['B',b]]){
   set('warehouses',warehouseId,{active:true});
   set('warehouseStocks',warehouseId+'__'+productKey,{productKey,warehouseId,
     onHand,reserved:0,transferFreeInTransit:0});
 }
 await batch.commit();
 const request={orderId,itemId:'I1',warehouseIds:['A','B']};
 return {orderId,productKey,uid,request,
   plan:()=>planSingleItemTwoWarehouse(db,uid,request),
   read:async(name,id)=>(await db.collection(name).doc(id).get()).data()};
}
test('read-only two-warehouse plan splits 10 into 4 and 6 with no stock writes',async()=>{
 const x=await seed('split');
 const before=await x.read('inventory',x.productKey);
 const result=await x.plan();
 assert.deepEqual(result.locations,[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:6}]);
 assert.equal(result.reservedQty,10);assert.equal(result.companyReservedDelta,10);
 assert.equal(result.shortageQty,0);
 assert.deepEqual(await x.read('inventory',x.productKey),before);
 assert.equal((await x.read('warehouseStocks','A__'+x.productKey)).reserved,0);
 assert.equal((await db.collection('inventoryReservations').doc(x.orderId+'__I1').get()).exists,false);
});
test('company stock caps allocations; incoming stock never enters onHand',async()=>{
 const limited=await seed('company-ceiling',{company:7});
 const result=await limited.plan();
 assert.equal(result.reservedQty,7);
 assert.equal(result.companyReservedDelta,7);
 assert.equal(result.shortageQty,3);
 const incoming=await seed('in-transit',{inTransit:3});
 const proposal=await incoming.plan();
 assert.equal(proposal.reservedQty,7);
 assert.equal(proposal.shortageQty,3);
 assert.equal(proposal.remainingToOrderQty,0);
 assert.equal((await incoming.read('inventory',incoming.productKey)).reserved,0);
});
test('business owner, disabled role, and invalid warehouses are refused without writes',async()=>{
 const stranger=await seed('stranger',{owner:'someone-else'});
 await assert.rejects(stranger.plan(),/不得檢視/, 'Sales may not inspect another order');
 const off=await seed('disabled',{role:'purchaser'});
 await db.collection('users').doc(off.uid).update({active:false});
 await assert.rejects(off.plan(),/停用/);
 const custody=await seed('custody',{role:'admin'});
 await db.collection('warehouses').doc('B').update({systemCustody:true});
 await assert.rejects(custody.plan(),/實體倉/);
 const invalid=await seed('bad-stock',{role:'admin',a:1});
 await db.collection('warehouseStocks').doc('A__'+invalid.productKey).update({reserved:2});
 await assert.rejects(invalid.plan(),/庫存與途中帳不一致/);
});
test('cancelled and mismatched existing reservation refuse v2 preview',async()=>{
 const cancelled=await seed('cancel',{role:'purchaser'});
 await db.collection('orders').doc(cancelled.orderId).update({status:'cancelled'});
 await assert.rejects(cancelled.plan(),/已取消|結案/);
 const wrong=await seed('wrong',{role:'purchaser'});
 await db.collection('inventoryReservations').doc(wrong.orderId+'__I1').set({
  orderId:wrong.orderId,itemId:'I1',productKey:'different',quantity:0
 });
 await assert.rejects(wrong.plan(),/產品不符/);
});
