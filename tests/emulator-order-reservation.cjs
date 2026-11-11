'use strict';
// Full-order initial reservation under the real Firestore Emulator/Admin SDK.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {commitOrderReservation}=require('../functions/order-reservation-service');
const {verifyQuickPurchaseReceipt}=require('../functions/supply-receipt-service');
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
 put('inventory/'+productKey,{productKey,onHand:10,reserved:0});
 put('warehouseStocks/A__'+productKey,{productKey,warehouseId:'A',onHand:4,reserved:0});
 put('warehouseStocks/B__'+productKey,{productKey,warehouseId:'B',onHand:6,reserved:0});
 put('orders/'+orderId,{ownerUid:'sales1',salesCode:'S01',status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:syncAttemptId,items:[
   {itemId:'I1',productId:productKey,warehouseId:'A',qty:3,reservedQty:0},
   {itemId:'I2',productId:productKey,warehouseId:'A',qty:1,reservedQty:0},
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
 assert.deepEqual([first.reservedQty,first.shortageQty],[10,2]);
 const a=await f.get('warehouseStocks/A__'+f.productKey),b=await f.get('warehouseStocks/B__'+f.productKey);
 const company=await f.get('inventory/'+f.productKey);
 assert.deepEqual([company.reserved,a.reserved,b.reserved],[10,4,6]);
 const order=await f.get('orders/'+f.orderId);
 assert.deepEqual(order.items.map(x=>[x.reservedQty,x.shortageQty]),[[3,0],[1,0],[6,2]]);
 assert.equal(await f.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.orderId+':I2')),undefined);
 const demand=await f.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.orderId+':I3'));
 assert.equal(demand.requestedQty,2);
 assert.equal((await f.call()).status,'already-applied');
 assert.equal((await f.get('inventory/'+f.productKey)).reserved,10);
});
test('real Emulator: two concurrent initial self-order attempts commit one supplier promise and canonical receiving proof',async()=>{
 const f=await seed('initial-self-concurrent');
 await db.doc('users/'+f.uid).update({role:'sales'});
 await db.doc('orders/'+f.orderId).update({ownerUid:f.uid,selfOrderAtCreation:true,
  orderDate:'2026-11-11',items:[
   {itemId:'I1',productId:f.productKey,warehouseId:'A',qty:3,reservedQty:0,
    procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:true,supplier:'Vendor',costPrice:0}
  ]});
 await db.doc('inventory/'+f.productKey).update({onHand:0,incoming:0});
 await db.doc('warehouseStocks/A__'+f.productKey).update({onHand:0,incoming:0});
 await db.doc('warehouseStocks/B__'+f.productKey).update({onHand:0,incoming:0});
 const execute=()=>commitOrderReservation(db,f.uid,f.intent,{allowInitialSelfOrder:true});
 const [first,replay]=await Promise.all([execute(),execute()]);
 assert.deepEqual([first.status,replay.status].sort(),['already-applied','applied']);
 const order=await f.get('orders/'+f.orderId),supplyId='self-'+encodeURIComponent(f.orderId)+'-I1';
 const supply=await f.get('supplyOrders/'+supplyId);
 assert.equal(supply.qty,3);
 assert.equal(order.items[0].supplyOrderedQty,3);
 assert.equal((await f.get('inventory/'+f.productKey)).incoming,3);
 assert.equal((await f.get('warehouseStocks/A__'+f.productKey)).incoming,3);
 assert.equal((await f.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.orderId+':I1'))).orderedQty,3);
 await verifyQuickPurchaseReceipt(ref=>ref.get(),db,supply,order,supplyId);
});
test('alternate stocked warehouse is selected inside the real Admin transaction',async()=>{
 const f=await seed('alternate');
 await db.doc('orders/'+f.orderId).update({items:[
  {itemId:'I1',productId:f.productKey,warehouseId:'A',qty:5,reservedQty:0}
 ]});
 await db.doc('inventory/'+f.productKey).update({onHand:6});
 await db.doc('warehouseStocks/A__'+f.productKey).update({onHand:0});
 const result=await f.call();
 assert.deepEqual([result.reservedQty,result.shortageQty],[5,0]);
 const order=await f.get('orders/'+f.orderId);
 assert.deepEqual([order.items[0].warehouseId,order.items[0].reservedQty],['B',5]);
 assert.equal(order.inventoryReservationStatus,'completed');
 assert.equal((await f.get('warehouseStocks/B__'+f.productKey)).reserved,5);
 assert.equal((await f.get('inventory/'+f.productKey)).reserved,5);
});
test('real Admin transaction rejects multi-location need with no partial inventory update',async()=>{
 const f=await seed('requires-multi');
 await db.doc('orders/'+f.orderId).update({items:[
  {itemId:'I1',productId:f.productKey,warehouseId:'A',qty:7,reservedQty:0}
 ]});
 await assert.rejects(f.call(),/需要多倉分配/);
 assert.equal((await f.get('inventory/'+f.productKey)).reserved,0);
 assert.equal((await f.get('warehouseStocks/A__'+f.productKey)).reserved,0);
 assert.equal((await f.get('warehouseStocks/B__'+f.productKey)).reserved,0);
 assert.equal((await db.doc('reservationOperationReceipts/order-sync-'+f.orderId+'__'+f.intent.syncAttemptId).get()).exists,false);
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

test('production-shaped administrator order with empty sales code atomically reserves and replays once',async()=>{
 const f=await seed('admin-no-code');
 await db.doc('users/'+f.uid).update({role:'admin'});
 await db.doc('orders/'+f.orderId).update({ownerUid:f.uid,salesCode:'',createdByRole:'admin',createdByUid:f.uid});
 const result=await f.call();assert.equal(result.status,'applied');
 const order=await f.get('orders/'+f.orderId);assert.equal(order.inventoryReservationStatus,'completed');
 assert.equal(order.ownerUid,f.uid);assert.equal(order.salesCode,'');
 assert.deepEqual(order.items.map(x=>[x.reservedQty,x.shortageQty]),[[3,0],[1,0],[6,2]]);
 const demand=await f.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.orderId+':I3'));
 assert.equal(demand.ownerUid,f.uid);assert.equal(demand.salesCode,'');
 const stock=await f.get('inventory/'+f.productKey);assert.equal(stock.reserved,10);
 assert.equal((await f.call()).status,'already-applied');assert.deepEqual(await f.get('inventory/'+f.productKey),stock);
});

test('code-free administrator demand continues into the existing formal purchasing transaction',async()=>{
 const f=await seed('admin-purchase');
 await db.doc('users/'+f.uid).update({role:'admin'});
 await db.doc('orders/'+f.orderId).update({ownerUid:f.uid,salesCode:''});
 await f.call();
 const buyer='buyer-admin-source';await db.doc('users/'+buyer).set({role:'purchaser',active:true});
 const {commitV2FormalPurchase}=require('../functions/formal-purchase-commit-service');
 const intent={poNo:'PO-admin-source',poDate:'2026-10-31',orderId:f.orderId,itemId:'I3',qty:1,supplier:'Test supplier',unitCost:1};
 const result=await commitV2FormalPurchase(db,buyer,intent);
 assert.equal(result.status,'committed');
 const order=await f.get('orders/'+f.orderId),demand=await f.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.orderId+':I3'));
 assert.equal(order.ownerUid,f.uid);assert.equal(order.salesCode,'');assert.equal(order.items[2].supplyOrderedQty,1);
 assert.equal(demand.ownerUid,f.uid);assert.equal(demand.salesCode,'');assert.equal(demand.orderedQty,1);
});

test('new zero-stock source creates explicit balances and can cancel and restore without ledger conversion',async()=>{
 const f=await seed('zero-lifecycle');
 await db.doc('orders/'+f.orderId).update({items:[
  {itemId:'I1',productId:f.productKey,warehouseId:'A',qty:3,reservedQty:0}
 ]});
 await db.doc('inventory/'+f.productKey).delete();
 await db.doc('warehouseStocks/A__'+f.productKey).delete();
 await db.doc('warehouseStocks/B__'+f.productKey).delete();
 await f.call();
 assert.equal((await f.get('inventory/'+f.productKey)).onHand,0);
 assert.equal((await f.get('warehouseStocks/A__'+f.productKey)).reserved,0);
 const ledger=await f.get('inventoryReservations/'+f.orderId+'__I1');
 assert.equal(ledger.locationSchemaVersion,2);assert.deepEqual(ledger.locations,[]);
 assert.deepEqual(ledger.lifecycleWarehouseIds,['A']);
 await db.doc('users/'+f.uid).update({role:'admin'});
 const lifecycle=require('../functions/single-item-location-lifecycle-service').commitOrderLocationLifecycle;
 const intent={orderId:f.orderId,itemIds:['I1'],warehouseIds:['A'],syncAttemptId:f.intent.syncAttemptId,
  operationId:'zero_source_cancel_12345',nextStatus:'cancelled',date:'2026-11-03'};
 await lifecycle(db,f.uid,intent);
 assert.equal((await f.get('orders/'+f.orderId)).status,'cancelled');
 await lifecycle(db,f.uid,{...intent,operationId:'zero_source_restore_12345',nextStatus:'normal'});
 assert.equal((await f.get('orders/'+f.orderId)).items[0].shortageQty,3);
 assert.equal((await f.get('inventory/'+f.productKey)).onHand,0);
});

test('new encoded-identity products with no stock complete native initialization cancellation and restoration',async()=>{
 const uid='encoded_zero_admin',orderId='encoded_zero_order',syncAttemptId='encoded_zero_sync';
 const productKeys=['prd:%E9%9B%9C%E9%A0%85:encoded-zero','prd:Beckman Coulter:encoded-zero'];
 const items=productKeys.map((productId,i)=>({itemId:'E'+i,productId,warehouseId:i?'B':'A',qty:1,
  productType:'Consumable',fulfillmentType:'WAREHOUSE',reservedQty:0}));
 const batch=db.batch(),set=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 set('users',uid,{active:true,role:'admin'});
 for(const warehouse of ['A','B'])set('warehouses',warehouse,{active:true});
 for(const key of productKeys)set('products',key,{active:true,productType:'Consumable'});
 set('orders',orderId,{ownerUid:uid,salesCode:'ENCODED_ZERO',status:'active',orderStatus:'normal',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:syncAttemptId,items,
  deliveryRecords:[],returnRecords:[],warehouseShipmentRecords:[]});
 await batch.commit();
 const initial=await commitOrderReservation(db,uid,{orderId,syncAttemptId});
 assert.deepEqual([initial.reservedQty,initial.shortageQty],[0,2]);
 const lifecycle=require('../functions/single-item-location-lifecycle-service').commitOrderLocationLifecycle;
 const cancel={orderId,itemIds:items.map(row=>row.itemId),warehouseIds:['A','B'],nextStatus:'cancelled',
  operationId:'encoded_zero_cancel',syncAttemptId,date:'2026-11-04'};
 await lifecycle(db,uid,cancel);
 assert.equal((await db.collection('orders').doc(orderId).get()).data().orderStatus,'cancelled');
 await lifecycle(db,uid,{...cancel,nextStatus:'normal',operationId:'encoded_zero_restore'});
 const saved=(await db.collection('orders').doc(orderId).get()).data();
 assert.equal(saved.orderStatus,'normal');assert.deepEqual(saved.items.map(item=>item.shortageQty),[1,1]);
 for(const key of productKeys){
  const company=(await db.collection('inventory').doc(encodeURIComponent(key)).get()).data();
  assert.equal(company.productKey,key);assert.deepEqual([company.onHand,company.reserved,company.incoming],[0,0,0]);
  for(const warehouse of ['A','B']){
   const stock=(await db.collection('warehouseStocks').doc(warehouse+'__'+encodeURIComponent(key)).get()).data();
   assert.equal(stock.productKey,key);assert.deepEqual([stock.onHand,stock.reserved,stock.incoming],[0,0,0]);
   assert.equal((await db.collection('warehouseStocks').doc(warehouse+'__'+encodeURIComponent(encodeURIComponent(key))).get()).exists,false);
  }
 }
});
