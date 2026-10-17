'use strict';
// Delivery acknowledgement consumes an existing shipment, never stock or lots.
// Internal-only until all v2 read/write adapters and Preview are accepted.
const {createHash}=require('node:crypto');
const core=require('./shared/fulfillment-core');
const {normalizeShipmentIntent}=require('./location-shipment-service');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function id(value){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fault('識別碼不正確','invalid-argument');
 return value;
}
function normalizeDeliveryIntent(data){
 const keys=['orderId','itemId','shipmentId','quantity','date','notes','operationId','syncAttemptId'];
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))
  fault('送達請求含未授權欄位','invalid-argument');
 const intent={};
 for(const key of ['orderId','itemId','shipmentId','operationId','syncAttemptId'])intent[key]=id(data[key]);
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId)||intent.syncAttemptId.length>96)
  fault('操作或同步識別碼不正確','invalid-argument');
 if(!Number.isSafeInteger(data.quantity)||data.quantity<=0)fault('送達量須為正整數','invalid-argument');
 if(typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date)
  ||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))
  ||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)
  fault('送達日期不正確','invalid-argument');
 intent.quantity=data.quantity;intent.date=data.date;intent.notes=data.notes??'';
 if(typeof intent.notes!=='string'||intent.notes.length>1000)fault('送達備註不正確','invalid-argument');
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitShipmentDelivery(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fault('送達確認目前僅允許 demo-yushin Emulator');
 id(uid);const intent=normalizeDeliveryIntent(data);
 const {orderId,itemId,shipmentId,operationId,syncAttemptId}=intent;
 const ref=(n,key)=>db.collection(n).doc(key);
 return db.runTransaction(async tx=>{
  const user=await tx.get(ref('users',uid));
  if(!user.exists||user.data().active===false||user.data().disabled===true
   ||!['admin','sales','engineer'].includes(user.data().role))fault('無客戶送達確認權限','permission-denied');
  const actorRole=user.data().role;
  const orderRef=ref('orders',orderId),snap=await tx.get(orderRef);
  if(!snap.exists)fault('訂單不存在','not-found');
  const order=snap.data();
  if(actorRole!=='admin'&&order.ownerUid!==uid)fault('只能確認自己訂單的送達','permission-denied');
  if(!Array.isArray(order.deliveryRecords))fault('訂單缺少送達紀錄');
  const previous=order.deliveryRecords.filter(row=>row.id===operationId);
  if(previous.length){
   const record=previous[0];
   if(previous.length!==1||record.sourceType!=='WAREHOUSE_SHIPMENT_CONFIRMATION'||record.createdByUid!==uid
    ||record.createdByRole!==actorRole||record.intentHash!==intent.hash||record.orderId!==orderId
    ||record.itemId!==itemId||record.shipmentId!==shipmentId)
    fault('送達操作識別碼已用於其他交易','already-exists');
   return {...record.result,status:'already-applied',recordId:operationId};
  }
  if((order.deliveryHistory||[]).some(row=>row.recordId===operationId))
   fault('此送達操作已有歷史紀錄，不能以原識別碼重新確認');
  if(order.inventoryReservationStatus!=='completed'||order.inventoryReservationAttemptId!==syncAttemptId)
   fault('庫存同步未完成或來源同步識別碼已變更');
  if(!['active','normal'].includes(order.status)||![undefined,'','normal','active'].includes(order.orderStatus))
   fault('已取消或結案訂單不可新增送達');
  if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||order.items.length!==1)
   fault('此試點僅限所有權明確的單品項訂單');
  const item=order.items[0],productKey=id(item.inventoryProductKey||item.productId);
  if(item.itemId!==itemId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
   ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
   ||item.transferPendingId||item.custodyTransferId||(order.logisticsTransfersPending??0)!==0)
   fault('品項不是可確認的實體倉出貨');
  if(!Array.isArray(order.returnRecords)||order.returnRecords.length||(item.returnedQty??0)!==0)
   fault('退貨或補送流程尚未開放');
  const projection=core.projectShipmentDelivery({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
   shipments:order.warehouseShipmentRecords,deliveries:order.deliveryRecords});
  if(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty)
   fault('訂購數量投影不一致');
  if(item.warehouseShippedQty!==projection.shippedQty||order.deliveredQty!==projection.confirmedQty
   ||(item.deliveredQty??0)!==projection.confirmedQty||order.isDelivered!==projection.isDelivered)
   fault('出貨或客戶送達投影不一致');
  const shipment=(order.warehouseShipmentRecords||[]).find(row=>row.id===shipmentId);
  if(!shipment)fault('來源倉庫出貨不存在');
  const originalIntent=normalizeShipmentIntent({orderId,itemId,warehouseId:shipment.warehouseId,
   quantity:shipment.qty,date:shipment.date,notes:shipment.notes,operationId:shipment.id,
   syncAttemptId,expectedPlan:shipment.deliveryPlan});
  const expectedMovementId='location-ship-'+shipment.id;
  if(shipment.movementId!==expectedMovementId)fault('來源倉庫出貨憑證不一致');
  const movement=await tx.get(ref('inventoryMovements',expectedMovementId));
  if(!movement.exists)fault('來源出貨缺少實際扣帳憑證');
  const proof=movement.data();
  if(proof.action!=='location_customer_shipment'||proof.type!=='ship'||proof.sourceId!==orderId
   ||proof.itemId!==itemId||proof.productKey!==productKey||proof.warehouseId!==shipment.warehouseId
   ||proof.qty!==-shipment.qty||proof.intentHash!==originalIntent.hash
   ||JSON.stringify(proof.lotAllocations)!==JSON.stringify(shipment.lotAllocations))
   fault('來源倉庫出貨與實際扣帳憑證不一致');
  const now=new Date().toISOString();
  const record={id:operationId,orderId,itemId,productKey,shipmentId,warehouseId:shipment.warehouseId,
   qty:intent.quantity,date:intent.date,notes:intent.notes,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION',
   shipmentMovementId:expectedMovementId,deliveryPlan:shipment.deliveryPlan,
   createdByUid:uid,createdByRole:actorRole,createdBy:uid,createdAt:now,intentHash:intent.hash};
  const records=[...order.deliveryRecords,record];
  const next=core.projectShipmentDelivery({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
   shipments:order.warehouseShipmentRecords,deliveries:records});
  const result={orderId,itemId,shipmentId,confirmedQty:next.confirmedQty,
   pendingDeliveryQty:next.pendingDeliveryQty,isDelivered:next.isDelivered};
  record.result=result;
  const history={action:'create',source:'shipment_confirmation',recordId:operationId,before:null,after:record,by:uid,at:now};
  // One order document carries both authoritative acknowledgement and caches.
  // No inventory/warehouse/reservation/lot reads or stock-operation writes.
  tx.update(orderRef,{deliveryRecords:records,items:[{...item,deliveredQty:next.confirmedQty}],
   deliveredQty:next.confirmedQty,isDelivered:next.isDelivered,
   deliveryHistory:[...(order.deliveryHistory||[]),history],updatedAt:now});
  return {...result,status:'applied',recordId:operationId};
 });
}
module.exports={normalizeDeliveryIntent,commitShipmentDelivery};
