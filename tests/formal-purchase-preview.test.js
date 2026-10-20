'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../modules/procurement-demand-core');
const {previewV2FormalPurchase,strictRequest}=require('../functions/formal-purchase-preview-service');

function fixture(){
 const orderId='ORDER-1',itemId='S',productId='P',warehouseId='W';
 const item={itemId,productId,warehouseId,fulfillmentType:'WAREHOUSE',
  qty:12,reservedQty:5,shortageQty:7,supplyOrderedQty:0,receivedQty:0};
 const order={ownerUid:'seller',salesCode:'B',status:'active',
  orderStatus:'normal',inventoryReservationStatus:'completed',items:[item]};
 const demandId=core.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
 const demand=core.demandDocument(core.fromSalesOrder({
  demandId,sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,
  sourceItemIndex:0,ownerUid:'seller',salesCode:'B',
  productKey:productId,productId,warehouseId,
  shortageQty:7,supplyOrderedQty:0,receivedQty:0
 }),{createdAt:'2026-10-20T00:00:00Z'});
 const records=new Map([
  ['users/buyer',{role:'purchaser',active:true}],
  ['users/admin',{role:'admin',active:true}],
  ['users/seller',{role:'sales',active:true}],
  ['users/off',{role:'purchaser',active:false}],
  ['orders/'+orderId,order],
  ['products/'+productId,{productType:'Goods',active:true}],
  ['warehouses/'+warehouseId,{active:true}],
  ['procurementDemands/'+encodeURIComponent(demandId),demand]
 ]);
 let writes=0;
 const db={
  collection(name){return {doc(id){return {path:name+'/'+id};}};},
  async runTransaction(fn){
   const tx={
    async get(ref){return {
     exists:records.has(ref.path),
     data:()=>records.get(ref.path)
    };},
    set(){writes++;throw Error('Read-only PO guard performed a write');},
    update(){writes++;throw Error('Read-only PO guard performed a write');},
    delete(){writes++;throw Error('Read-only PO guard performed a write');}
   };
   return fn(tx);
  }
 };
 const input={poNo:'PO-20261020-1',orderId,itemId,qty:4};
 return {db,input,records,order,demand,demandId,writes:()=>writes};
}

test('server PO admission shares demand projection, returns no cost and never writes',async()=>{
 const {db,input,demandId,writes}=fixture();
 const result=await previewV2FormalPurchase(db,'buyer',input);
 assert.deepEqual(result,{
  poNo:input.poNo,orderId:input.orderId,itemId:input.itemId,
  productId:'P',warehouseId:'W',demandId,
  requestedQty:7,orderedQty:0,remainingToOrderQty:7,
  proposedQty:4,remainingAfterQty:3,status:'preview-only'
 });
 assert.equal(writes(),0);
 const admin=await previewV2FormalPurchase(db,'admin',{...input,qty:7});
 assert.equal(admin.remainingAfterQty,0);
 assert.equal(writes(),0);
});
test('server PO admission never trusts client role, arbitrary writes or user status',async()=>{
 const {db,input,records,writes}=fixture();
 for(const uid of ['seller','off','missing']){
  await assert.rejects(previewV2FormalPurchase(db,uid,input),{code:'permission-denied'});
 }
 for(const bad of [{...input,actorRole:'admin'}, {...input,qty:0},
  {...input,qty:1.5},{...input,qty:8},{...input,qty:'4'}, {...input,poNo:'../bad'}]){
  await assert.rejects(previewV2FormalPurchase(db,'buyer',bad),{code:bad.qty===8?'failed-precondition':'invalid-argument'});
 }
 records.set('users/buyer',{role:'purchaser',disabled:true});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'permission-denied'});
 assert.equal(writes(),0);
});
test('server PO admission refuses stale source, bad warehouses, replaced demand and reused PO ID',async()=>{
 const {db,input,records,order,demand,demandId,writes}=fixture();
 const need='procurementDemands/'+encodeURIComponent(demandId);
 records.set('orders/'+input.orderId,{...order,orderStatus:'cancelled'});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'failed-precondition'});
 records.set('orders/'+input.orderId,order);
 records.set('warehouses/W',{active:false});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'failed-precondition'});
 records.set('warehouses/W',{active:true});
 records.set(need,{...demand,orderedQty:1,remainingToOrderQty:6,status:'PARTIALLY_ORDERED'});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'failed-precondition'});
 records.set(need,demand);
 records.set('purchaseOrders/'+input.poNo,{poNo:input.poNo});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'already-exists'});
 assert.equal(writes(),0);
});
test('strict PO request allows only a bounded four-field identity',()=>{
 const input={poNo:'PO-1',orderId:'O-1',itemId:'S',qty:4};
 assert.deepEqual(strictRequest(input),input);
 for(const row of [{...input,qty:NaN},{...input,qty:-1},{...input,qty:1000001},
  {...input,orderId:'O/1'},{...input,extra:{}},[input],null]){
  assert.throws(()=>strictRequest(row),error=>error.code==='invalid-argument');
 }
});
