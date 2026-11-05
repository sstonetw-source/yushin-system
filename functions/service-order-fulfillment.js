'use strict';
// Bounded evidence adapter. It delegates quantity calculation to the existing
// fulfillment/workflow cores and never writes a separate fulfillment ledger.
const core=require('./shared/fulfillment-core');
const workflow=require('./shared/workflow-core');
const service=workflow.isServiceItem;
function fail(message){const e=Error(message);e.code='failed-precondition';throw e;}
async function directGoodsCompleted(db,tx,orderId,order,goods){
 const items=new Map(goods.map(item=>[item.itemId,item])),totals=new Map(),seen=new Set();
 if((order.warehouseShipmentRecords||[]).length||(order.returnRecords||[]).length
   ||!Array.isArray(order.deliveryRecords)||order.deliveryRecords.length>40)
  fail('原廠直送商品的交付紀錄不完整。');
 for(const record of order.deliveryRecords){
  const item=items.get(record.itemId);
  if(!item||record.sourceType!=='DIRECT_SHIP_RECEIPT'||typeof record.receiptId!=='string'
    ||!record.receiptId||record.receiptId.includes('/')||seen.has(record.receiptId)
    ||record.id!=='direct-'+record.receiptId||!Number.isSafeInteger(record.qty)||record.qty<=0)
   fail('原廠直送商品缺少有效到貨憑證。');
  const receipt=(await tx.get(db.collection('receipts').doc(record.receiptId))).data();
  if(!receipt||receipt.fulfillmentType!=='DIRECT_SHIP'||receipt.orderId!==orderId
    ||receipt.itemId!==item.itemId||receipt.supplyOrderId!==record.sourceId
    ||receipt.productId!==item.productId||receipt.qty!==record.qty||receipt.receiptDate!==record.date)
   fail('原廠直送商品的到貨憑證與來源不一致。');
  seen.add(record.receiptId);
  totals.set(item.itemId,(totals.get(item.itemId)||0)+receipt.qty);
 }
 return goods.every(item=>(totals.get(item.itemId)||0)===(item.orderedQty??item.qty));
}
async function readOrderFulfillmentEvidence(db,tx,orderId,order,options={}){
 const progress=order.serviceFulfillment
  ? {items:order.items.filter(service).map(item=>({
     itemId:item.itemId,workCategory:workflow.serviceItemWorkCategory(order,item)
    }))}
  : await require('./service-case-service').readServiceOrderProgress(db,tx,orderId,order,options);
 if(order.serviceFulfillment){
  progress.serviceCompleted=order.items.filter(service).every(item=>{
   const actions=order.serviceFulfillment[item.itemId];
   return ['EXECUTE','PREPARE','DELIVER'].every(action=>
    actions?.[action]?.quantity===(item.orderedQty??item.qty));
  });
 }
 const goods=order.items.filter(item=>!service(item));
 if(!goods.length)return {...progress,goodsCompleted:true,workCategories:[...new Set(progress.items.map(i=>i.workCategory))]};
 if(order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId
   ||!order.ownerUid||!order.salesCode||(order.logisticsTransfersPending??0)!==0)
  fail('混合單尚未完成初始化或物流來源不完整。');
 if(order.serviceFulfillment&&goods.every(item=>item.fulfillmentType==='DIRECT_SHIP'))
  return {...progress,goodsCompleted:await directGoodsCompleted(db,tx,orderId,order,goods),
   workCategories:require('./order-reservation-service').initialOrderWorkIndex(order,order.items,new Date().toISOString()).workCategories};
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
  workCategories:order.serviceFulfillment
   ? require('./order-reservation-service').initialOrderWorkIndex(order,order.items,new Date().toISOString()).workCategories
   : [...new Set(order.items.map(item=>categories.get(item.itemId)))]};
}
async function readOrderFulfillment(...args){
 try{return await readOrderFulfillmentEvidence(...args);}
 catch(error){if(!error.code)error.code='failed-precondition';throw error;}
}
async function mixedWorkIndex(db,tx,orderId,order,options={}){
 if(!order.items?.some(service))return {};
 if(order.serviceFulfillment)
  return require('./order-reservation-service').initialOrderWorkIndex(order,order.items,new Date().toISOString());
 const progress=await readOrderFulfillment(db,tx,orderId,order,options);
 return {workCategories:progress.workCategories,workCategoryUpdatedAt:new Date().toISOString()};
}
module.exports={readOrderFulfillment,mixedWorkIndex};
