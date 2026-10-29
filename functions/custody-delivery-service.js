'use strict';
// Customer acknowledgement of a verified V3 Custody physical shipment.
// Reuses the existing delivery confirmation writer: only commercial progress
// changes. It cannot debit, restore or transfer stock, lots or cost amounts.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {commitShipmentDelivery}=require('./shipment-delivery-service');
const reservationCore=require('./shared/reservation-core');
const fulfillmentCore=require('./shared/fulfillment-core');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function id(value,label){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fail(label+'不正確');
 return value;
}
function custodyDeliveryProject(env=process.env){
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return projectIdFromEnvironment(env)==='demo-yushin'
  &&env.FUNCTIONS_EMULATOR==='true'&&env.ENABLE_V3_CUSTODY_DELIVERY_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}
async function readCustodyDeliveryProofs(tx,db,order,context,intent){
 const {item,productKey,returnProjection:projection}=context;
 const {orderId,itemId}=intent,owner=id(order.ownerUid,'負責人');
 const transferId=id(item.custodyTransferId,'交接來源');
 const custody='custody-'+owner;
 const ref=(name,key)=>db.collection(name).doc(key);
 if(item.warehouseId!==custody||item.itemId!==itemId
   ||item.transferPendingId||item.productId===undefined
   ||order.logisticsTransfersPending!==undefined&&order.logisticsTransfersPending!==0
   ||!Array.isArray(order.warehouseShipmentRecords)||!order.warehouseShipmentRecords.length
   ||order.warehouseShipmentRecords.length>40
   ||!Array.isArray(order.deliveryRecords)||!Array.isArray(order.returnRecords)
   ||order.returnRecords.length||!Number.isSafeInteger(item.reservedQty)
   ||item.reservedQty!==projection.outstandingQty)
  fail('V3 送達來源與原保管出貨紀錄不一致');
 const ledgerSnap=await tx.get(ref('inventoryReservations',orderId+'__'+itemId));
 const ledger=ledgerSnap.exists?ledgerSnap.data():null;
 if(!ledger||ledger.locationSchemaVersion!==3||ledger.orderId!==orderId||ledger.itemId!==itemId
   ||ledger.ownerUid!==owner||ledger.salesCode!==order.salesCode||ledger.productKey!==productKey
   ||ledger.custodyTransferId!==transferId||ledger.custodyOriginalQty!==(item.qty??item.orderedQty)
   ||ledger.quantity!==item.reservedQty||ledger.shortageQty!==0
   ||ledger.status!==(item.reservedQty?'active':'fulfilled'))
  fail('原 V3 預留與送達來源不一致');
 const locations=reservationCore.reservationLocations(ledger);
 if(locations.length!==(ledger.quantity>0?1:0)
   ||ledger.quantity>0&&(locations[0].warehouseId!==custody||locations[0].qty!==ledger.quantity))
  fail('送達時原業務保管位置不一致');
 const source=await tx.get(ref('stockTransfers',transferId));
 const transfer=source.exists?source.data():null;
 const original=await tx.get(ref('reservationOperationReceipts','order-transfer-dispatch-'+transferId));
 const proof=original.exists?original.data():null;
 const inbound=await tx.get(ref('inventoryMovements',transferId+'-in'));
 const originalLegs=Array.isArray(transfer?.sourceLocations)?transfer.sourceLocations.map(row=>({
  warehouseId:row.warehouseId,reservedQty:row.qty})).sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId)):[];
 const ledgerLegs=[...(ledger.sourceLocationSnapshot||[])].sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId));
 if(!transfer||transfer.kind!=='HANDOFF'||transfer.status!=='RECEIVED'
   ||transfer.orderId!==orderId||transfer.itemId!==itemId||transfer.qty!==ledger.custodyOriginalQty
   ||transfer.ownerUid!==owner||transfer.salesCode!==order.salesCode
   ||transfer.toWarehouseId!==custody||transfer.productKey!==productKey
   ||transfer.reservationLocationSchemaVersion!==2||transfer.custodyLocationSchemaVersion!==3
   ||JSON.stringify(transfer.lifecycleWarehouseIds)!==JSON.stringify(ledger.lifecycleWarehouseIds)
   ||JSON.stringify(originalLegs)!==JSON.stringify(ledgerLegs)
   ||!proof||proof.kind!=='ORDER_TRANSFER_DISPATCH'
   ||proof.intentHash!==transfer.orderTransferIntentHash||proof.transfer?.id!==transferId
   ||Object.entries(proof.transfer).some(([field,value])=>field!=='status'
     &&JSON.stringify(transfer[field])!==JSON.stringify(value))
   ||!inbound.exists||inbound.data().type!=='warehouse_transfer_in'
   ||inbound.data().sourceId!==transferId||inbound.data().sourceType!=='WAREHOUSE_TRANSFER'
   ||inbound.data().orderId!==orderId||inbound.data().itemId!==itemId
   ||inbound.data().productKey!==productKey||inbound.data().warehouseId!==custody
   ||inbound.data().qty!==ledger.custodyOriginalQty)
  fail('原 V3 實際交接來源無法證明');
 for(const shipment of order.warehouseShipmentRecords){
  if(shipment.custodyTransferId!==transferId||shipment.warehouseId!==custody
    ||shipment.deliveryPlan?.mode!=='CUSTOMER_SHIP')
   fail('保管出貨與原保管倉來源不一致');
  const movement=await tx.get(ref('inventoryMovements','location-ship-'+id(shipment.id,'出貨 ID')));
  const sourceMovement=movement.exists?movement.data():null;
  fulfillmentCore.validateShipmentMovement(shipment,sourceMovement,{orderId,itemId,productKey});
  if(sourceMovement.custodyShipmentV3!==true||sourceMovement.custodyTransferId!==transferId)
   fail('原 V3 實際扣庫憑證不一致');
 }
}
async function commitCustodyDelivery(db,uid,data,env=process.env){
 if(!custodyDeliveryProject(env)||db.projectId!=='demo-yushin')
  fail('V3 保管送達確認尚未在此專案啟用');
 return commitShipmentDelivery(db,uid,data,env,{allowCustody:true});
}
function createCustodyDeliveryCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!custodyDeliveryProject(env))throw new HttpsError('failed-precondition','V3 保管送達確認尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitCustodyDelivery(getDatabase(),request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('V3 custody delivery confirmation failed',error);
   throw new HttpsError('internal','V3 送達結果未確認，請以原操作編號查核');
  }
 });
}
module.exports={custodyDeliveryProject,readCustodyDeliveryProofs,commitCustodyDelivery,createCustodyDeliveryCallable};
