'use strict';
// Bounded evidence adapter. It delegates quantity calculation to the existing
// fulfillment/workflow cores and never writes a separate fulfillment ledger.
const core=require('./shared/fulfillment-core');
const workflow=require('./shared/workflow-core');
const service=item=>String(item?.productType||item?.type||'').trim().toUpperCase()==='SERVICE';
function fail(message){const e=Error(message);e.code='failed-precondition';throw e;}
async function readOrderFulfillmentEvidence(db,tx,orderId,order,options={}){
 const progress=await require('./service-case-service').readServiceOrderProgress(db,tx,orderId,order,options);
 const goods=order.items.filter(item=>!service(item));
 if(!goods.length)return {...progress,goodsCompleted:true,workCategories:[...new Set(progress.items.map(i=>i.workCategory))]};
 if(order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId
   ||!order.ownerUid||!order.salesCode||(order.logisticsTransfersPending??0)!==0)
  fail('混合單尚未完成初始化或物流來源不完整。');
 const whole=core.projectOrderShipmentReturns({orderId,items:order.items,
  shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords??[],returns:order.returnRecords??[]});
 if((order.deliveredQty??0)!==whole.confirmedQty||(order.returnedQty??0)!==whole.returnedQty
   ||(order.isDelivered??false)!==whole.isDelivered)fail('混合單商品交付合計不一致。');
 const {readWholeOrderShipmentProofs,normalizeDeliveryIntent}=require('./shipment-delivery-service');
 const proofOrder=options.proofOrder||order;
 await readWholeOrderShipmentProofs(tx,db,proofOrder,{orderId,syncAttemptId:order.inventoryReservationAttemptId});
 for(const record of proofOrder.deliveryRecords??[]){
  const intent=normalizeDeliveryIntent({orderId,itemId:record.itemId,shipmentId:record.shipmentId,
   quantity:record.qty,date:record.date,notes:record.notes,operationId:record.id,
   syncAttemptId:order.inventoryReservationAttemptId});
  if(record.sourceType!=='WAREHOUSE_SHIPMENT_CONFIRMATION'||record.intentHash!==intent.hash)
   fail('混合單商品送達缺少原操作憑證。');
 }
 // Return provenance is verified by the original bounded proof reader.
 const first=goods[0];
 await require('./location-return-trace-service').readLocationReturnProofs(tx,db,proofOrder,
  {orderId,itemId:first.itemId,syncAttemptId:order.inventoryReservationAttemptId},
  first.inventoryProductKey||first.productId,{closedOnly:true});
 const categories=new Map(progress.items.map(item=>[item.itemId,item.workCategory]));
 for(const item of goods){
  const part=whole.items.find(row=>row.itemId===item.itemId);
  const master=await tx.get(db.collection('products').doc(item.productId));
  if(!master.exists||service(master.data())||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||item.transferPendingId||item.custodyTransferId
    ||(item.warehouseShippedQty??0)!==part.shippedQty||(item.deliveredQty??0)!==part.confirmedQty
    ||(item.returnedQty??0)!==part.returnedQty
    ||!Number.isSafeInteger(item.dispatchPreparedQty??0)||(item.dispatchPreparedQty??0)<part.shippedQty
    ||(item.dispatchPreparedQty??0)>part.orderedQty)fail('混合單商品來源或交付憑證不一致。');
  categories.set(item.itemId,workflow.projectItem({...item,isBilled:order.isBilled===true,
   grossDeliveredQty:part.confirmedQty,effectiveDeliveredQty:part.effectiveDeliveredQty,
   lifecycleStatus:[order.status,order.orderStatus].includes('cancelled')?'cancelled':'normal',
   warehouseShipmentContext:{orderId,itemId:item.itemId,productKey:part.productKey,
    shipments:(order.warehouseShipmentRecords??[]).filter(row=>row.itemId===item.itemId),
    deliveries:(order.deliveryRecords??[]).filter(row=>row.itemId===item.itemId),
    returns:(order.returnRecords??[]).filter(row=>row.itemId===item.itemId)}}).workCategory);
 }
 return {...progress,goodsCompleted:whole.items.every(item=>item.isDelivered),
  workCategories:[...new Set(order.items.map(item=>categories.get(item.itemId)))]};
}
async function readOrderFulfillment(...args){
 try{return await readOrderFulfillmentEvidence(...args);}
 catch(error){if(!error.code)error.code='failed-precondition';throw error;}
}
async function mixedWorkIndex(db,tx,orderId,order,options={}){
 if(!order.items?.some(service))return {};
 const progress=await readOrderFulfillment(db,tx,orderId,order,options);
 return {workCategories:progress.workCategories,workCategoryUpdatedAt:new Date().toISOString()};
}
module.exports={readOrderFulfillment,mixedWorkIndex};
