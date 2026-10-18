'use strict';
// Read-only batch/provenance preflight; this is NOT a stock return commit.
const inventory=require('./shared/inventory-core');
const {createHash}=require('node:crypto');
const {isDeepStrictEqual}=require('node:util');
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
function normalizeLocationReturnIntent(data){
 const keys=['orderId','itemId','shipmentId','syncAttemptId','selections','operationId','warehouseId','date','reason','condition','settlement'];
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))
  fault('退貨入庫請求含未授權欄位','invalid-argument');
 const intent=normalizeReturnTraceIntent(Object.fromEntries(['orderId','itemId','shipmentId','syncAttemptId','selections'].map(k=>[k,data[k]])));
 const settlement=data.settlement===undefined?'CLOSE':data.settlement;
 if(typeof data.operationId!=='string'||!/^[a-zA-Z0-9_-]{12,96}$/.test(data.operationId)
  ||typeof data.warehouseId!=='string'||!data.warehouseId||data.warehouseId!==data.warehouseId.trim()
  ||data.warehouseId.includes('/')||data.warehouseId.length>160)
  fault('退貨入庫操作或收貨倉識別碼不正確','invalid-argument');
 if(typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date)
  ||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))
  ||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)
  fault('退貨入庫日期不正確','invalid-argument');
 if(typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>1000
  ||data.condition!=='RESTOCKABLE'||!['CLOSE','REPLACE'].includes(settlement))
  fault('退貨原因、品質或補送／結案決策不正確','invalid-argument');
 // Lot order has no business meaning. Stable ordering makes retries deterministic.
 intent.selections.sort((a,b)=>a.lotId.localeCompare(b.lotId));
 Object.assign(intent,{operationId:data.operationId,warehouseId:data.warehouseId,date:data.date,
  reason:data.reason.trim(),condition:data.condition,settlement});
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
// Shared bounded receipt/provenance reader for return and subsequent
// fulfillment transactions. This never writes stock or derives quantities.
async function readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly=false}={}){
 const {orderId,itemId}=intent;
 if(!Array.isArray(order.returnRecords))fault('退貨紀錄格式不正確');
 if(closedOnly&&order.returnRecords.some(r=>r?.settlement!=='CLOSE'))
  fault('退貨或補送流程尚未開放：此入口僅支援 CLOSE 結案退貨');
 // Every prior receipt is tied to its immutable movement before consuming its
 // quantity/lot allowance. Never trust an editable order cache as a receipt.
 const receipts=await tx.get(db.collection('inventoryMovements').where('sourceId','==',orderId)
  .where('action','==','location_customer_return').limit(201));
 if(receipts.size>200||receipts.size!==order.returnRecords.length)fault('退貨紀錄與實際入庫憑證數量不一致');
 const byMovement=new Map(receipts.docs.map(s=>[s.id,s.data()]));
 for(const row of order.returnRecords){
  if(!Array.isArray(row.lotAllocations))fault('先前退貨缺少批次明細');
  const priorIntent=normalizeLocationReturnIntent({orderId,itemId,shipmentId:row.shipmentId,
   syncAttemptId:intent.syncAttemptId,selections:row.lotAllocations.map(a=>({lotId:a.lotId,qty:a.qty})),
   operationId:row.id,warehouseId:row.warehouseId,date:row.date,reason:row.reason,
   condition:row.condition,settlement:row.settlement});
  const proof=byMovement.get('location-return-'+row.id);
  if(row.movementId!=='location-return-'+row.id||row.intentHash!==priorIntent.hash||!proof
   ||proof.action!=='location_customer_return'||proof.type!=='return'
   ||proof.qty!==row.qty||proof.sourceId!==orderId||proof.itemId!==itemId
   ||proof.productKey!==productKey||proof.warehouseId!==row.warehouseId
   ||proof.intentHash!==priorIntent.hash||!isDeepStrictEqual(proof.returnRecord,row))
   fault('先前退貨缺少一致的實際入庫憑證');
 }
 return true;
}
async function planLocationReturnTrace(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fault('退貨批次追溯目前僅允許 demo-yushin Emulator');
 const intent=normalizeReturnTraceIntent(data);
 const {readShipmentActorOrder,shipmentDeliveryContext,readShipmentProof}=require('./shipment-delivery-service');
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
module.exports={normalizeReturnTraceIntent,normalizeLocationReturnIntent,readLocationReturnProofs,planLocationReturnTrace};
