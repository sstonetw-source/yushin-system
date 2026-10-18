'use strict';
// Read-only batch/provenance preflight; this is NOT a stock return commit.
const inventory=require('./shared/inventory-core'),reservation=require('./shared/reservation-core');
const {createHash}=require('node:crypto');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
const fulfillment=require('./shared/fulfillment-core');
const {normalizeReturnTraceIntent}=fulfillment;
function normalizeLocationReturnIntent(data){
 const intent=fulfillment.normalizeLocationReturnIntent(data);
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
// Shared bounded receipt/provenance reader for return and subsequent
// fulfillment transactions. This never writes stock or derives quantities.
async function readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly=false}={}){
 const receipts=await tx.get(db.collection('inventoryMovements').where('sourceId','==',intent.orderId)
  .where('action','==','location_customer_return').limit(201));
 if(Array.isArray(order.items)&&order.items.length>1){
  const projection=fulfillment.projectOrderShipmentReturns({orderId:intent.orderId,items:order.items,
   shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords,returns:order.returnRecords});
  const proofs=receipts.docs.map(s=>({id:s.id,data:s.data()}));
  if(proofs.length>200||proofs.length!==order.returnRecords.length
   ||proofs.some(row=>!projection.items.some(item=>item.itemId===row.data.itemId)))
   fault('整單退貨紀錄與實際入庫憑證數量或來源不一致');
  for(const item of projection.items)await fulfillment.validateLocationReturnProofs(
   {...order,returnRecords:order.returnRecords.filter(row=>row.itemId===item.itemId)},
   {...intent,itemId:item.itemId},item.productKey,proofs.filter(row=>row.data.itemId===item.itemId),
   {closedOnly,hashIntent:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')});
  return true;
 }
 return fulfillment.validateLocationReturnProofs(order,intent,productKey,
  receipts.docs.map(s=>({id:s.id,data:s.data()})),{closedOnly,
   hashIntent:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')});
}

// Shared scope guard for cancelled CLOSE preview and the actual receipt.
function assertCancelledCloseReturnContext(order,{item,projection,returnProjection,cancelled}){
 if(!cancelled)return;
 if(!Array.isArray(order.returnHistory??[]))fault('退貨歷史格式不正確');
 if(returnProjection.replacementQty!==0||projection.pendingDeliveryQty!==0
  ||!Number.isSafeInteger(item.dispatchPreparedQty??0)||(item.dispatchPreparedQty??0)!==projection.shippedQty
  ||(order.returnHistory??[]).some(event=>event?.action!=='add'
    ||!order.returnRecords.some(record=>record.id===event.recordId)))
  fault('取消訂單僅支援無途中貨、無額外打單及無更正歷史的 CLOSE 退貨');
}
async function planLocationReturnTrace(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fault('退貨批次追溯目前僅允許 demo-yushin Emulator');
 const intent=normalizeReturnTraceIntent(data);
 const {readShipmentActorOrder,shipmentDeliveryContext,readShipmentProof}=require('./shipment-delivery-service');
 return db.runTransaction(async tx=>{
  const {order}=await readShipmentActorOrder(tx,db,uid,intent.orderId,['admin','sales','engineer','purchaser','warehouse']);
  const context=shipmentDeliveryContext(order,intent,{allowReturns:true,allowCancelledCloseReturn:true});
  const {item,productKey,projection,cancelled}=context;
  assertCancelledCloseReturnContext(order,context);
  await readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly:true});
  if(cancelled){
   const ledgerSnap=await tx.get(db.collection('inventoryReservations').doc(intent.orderId+'__'+intent.itemId));
   const ledger=ledgerSnap.exists?ledgerSnap.data():null;
   if(!ledger||ledger.locationSchemaVersion!==2||ledger.warehouseId!==undefined
    ||ledger.orderId!==intent.orderId||ledger.itemId!==intent.itemId||ledger.productKey!==productKey
    ||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode||ledger.status!=='released'
    ||ledger.quantity!==0||ledger.shortageQty!==0||item.reservedQty!==0||item.shortageQty!==0
    ||reservation.reservationLocations(ledger).length!==0)
    fault('取消來源缺少完整釋放的 v2 預留憑證');
  }
  const shipment=await readShipmentProof(tx,db,order,intent,productKey);
  const confirmedQty=projection.shipments.find(row=>row.shipmentId===intent.shipmentId)?.confirmedQty??0;
  const plan=inventory.planExplicitShipmentReturn({shipment,confirmedQty,selections:intent.selections,
   priorReturns:order.returnRecords.filter(row=>row.shipmentId===shipment.id)});
  const lots=[];
  for(const row of plan.allocations){
   const snap=await tx.get(db.collection('inventoryLots').doc(row.lotId));
   if(!snap.exists)fault('原出貨批次不存在');
   const raw=snap.data();
   if(!Number.isSafeInteger(raw.remainingQty)||raw.remainingQty<0
    ||!Number.isSafeInteger(raw.receivedQty)||raw.receivedQty<raw.remainingQty)
    fault('原批次入庫量或餘量異常');
   if(String(raw.lotNo||'')!==row.lotNo||String(raw.expiryDate||'')!==row.expiryDate)
    fault('原出貨批號或效期與目前批次不一致');
   lots.push({...raw,id:snap.id});
  }
  const restoration=inventory.planLotRestoration({productKey,warehouseId:shipment.warehouseId,
   allocations:plan.allocations,lots});
  if(restoration.some(row=>row.remainingQty>lots.find(lot=>lot.id===row.lotId).receivedQty))
   fault('批次預計還原量超過原入庫量');
  return {status:'read-only',canCommit:false,orderId:intent.orderId,itemId:intent.itemId,shipmentId:intent.shipmentId,
   productKey,warehouseId:shipment.warehouseId,returnQty:plan.returnQty,
   confirmedQty:plan.confirmedQty,previousReturnedQty:plan.previousReturnedQty,
   remainingReturnQty:plan.remainingReturnQty,remainingLotAllocations:plan.remainingLotAllocations,
   allocations:plan.allocations,lotRestorationPreview:restoration};
 });
}
module.exports={normalizeReturnTraceIntent,normalizeLocationReturnIntent,readLocationReturnProofs,assertCancelledCloseReturnContext,planLocationReturnTrace};
