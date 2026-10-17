'use strict';
// Read-only batch/provenance preflight; this is NOT a stock return commit.
const inventory=require('./shared/inventory-core');
const {readShipmentActorOrder,shipmentDeliveryContext,readShipmentProof}=require('./shipment-delivery-service');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function id(value){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fault('退貨追溯識別碼不正確','invalid-argument');
 return value;
}
function normalizeReturnTraceIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data)
  ||Object.keys(data).some(k=>!['orderId','itemId','shipmentId','syncAttemptId','selections'].includes(k)))
  fault('退貨追溯請求含未授權欄位','invalid-argument');
 const intent={};for(const key of ['orderId','itemId','shipmentId','syncAttemptId'])intent[key]=id(data[key]);
 if(intent.syncAttemptId.length>96||!Array.isArray(data.selections)||!data.selections.length||data.selections.length>200)
  fault('退貨批次選擇不正確','invalid-argument');
 intent.selections=data.selections.map(row=>{
  if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['lotId','qty'].includes(k))
   ||!Number.isSafeInteger(row.qty)||row.qty<=0)fault('退貨批次數量不正確','invalid-argument');
  return {lotId:id(row.lotId),qty:row.qty};
 });
 if(new Set(intent.selections.map(row=>row.lotId)).size!==intent.selections.length)
  fault('退貨批次重複','invalid-argument');
 return intent;
}
async function planLocationReturnTrace(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fault('退貨批次追溯目前僅允許 demo-yushin Emulator');
 const intent=normalizeReturnTraceIntent(data);
 return db.runTransaction(async tx=>{
  const {order}=await readShipmentActorOrder(tx,db,uid,intent.orderId,['admin','sales','engineer','purchaser','warehouse']);
  const {productKey,projection}=shipmentDeliveryContext(order,intent);
  const shipment=await readShipmentProof(tx,db,order,intent,productKey);
  const confirmedQty=projection.shipments.find(row=>row.shipmentId===intent.shipmentId)?.confirmedQty??0;
  const plan=inventory.planExplicitShipmentReturn({shipment,confirmedQty,selections:intent.selections});
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
   allocations:plan.allocations,lotRestorationPreview:restoration};
 });
}
module.exports={normalizeReturnTraceIntent,planLocationReturnTrace};
