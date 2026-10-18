'use strict';
// Read-only batch/provenance preflight; this is NOT a stock return commit.
const inventory=require('./shared/inventory-core');
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
 return fulfillment.validateLocationReturnProofs(order,intent,productKey,
  receipts.docs.map(s=>({id:s.id,data:s.data()})),{closedOnly,
   hashIntent:value=>createHash('sha256').update(JSON.stringify(value)).digest('hex')});
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
