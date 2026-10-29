'use strict';
// Delivery acknowledgement consumes an existing shipment, never stock or lots.
// Confirmation is exposed only through its own default-closed gated Callable.
const {createHash}=require('node:crypto');
const core=require('./shared/fulfillment-core');
const {normalizeShipmentIntent}=require('./location-shipment-service');
const {readLocationReturnProofs}=require('./location-return-trace-service');
const {deliveryConfirmationBackendProject}=require('./delivery-confirmation-gate');
const {deliveryReversalBackendProject}=require('./delivery-reversal-gate');
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
async function readShipmentActorOrder(tx,db,uid,orderId,roles=['admin','sales','engineer']) {
 id(uid);id(orderId);const ref=(n,key)=>db.collection(n).doc(key);
  const user=await tx.get(ref('users',uid));
  if(!user.exists||user.data().active===false||user.data().disabled===true
   ||!roles.includes(user.data().role))fault('無此出貨後作業權限','permission-denied');
  const actorRole=user.data().role;
  const orderRef=ref('orders',orderId),snap=await tx.get(orderRef);
  if(!snap.exists)fault('訂單不存在','not-found');
  const order=snap.data();
  if(['sales','engineer'].includes(actorRole)&&order.ownerUid!==uid)fault('只能確認自己訂單的送達','permission-denied');
  if(!Array.isArray(order.deliveryRecords))fault('訂單缺少送達紀錄');
  if(order.deliveryHistory!==undefined&&!Array.isArray(order.deliveryHistory))fault('送達歷史格式不正確');
  return {actorRole,orderRef,order};
}
function shipmentDeliveryContext(order,intent,{allowReturns=false,allowCancelledCloseReturn=false,allowMultiReturn=false,allowCustody=false}={}) {
 if(allowMultiReturn&&Array.isArray(order.items)&&order.items.length>1){
  const context=multiShipmentDeliveryContext(order,intent,{allowCancelledCloseReturn:allowReturns&&allowCancelledCloseReturn});
  return {...context,returnProjection:context.projection};
 }
 const {orderId,itemId,syncAttemptId}=intent;
  if(order.inventoryReservationStatus!=='completed'||order.inventoryReservationAttemptId!==syncAttemptId)
   fault('庫存同步未完成或來源同步識別碼已變更');
  const cancelled=order.status==='cancelled'&&order.orderStatus==='cancelled';
  if(!(allowReturns&&allowCancelledCloseReturn&&cancelled)
   &&(!['active','normal'].includes(order.status)||![undefined,'','normal','active'].includes(order.orderStatus)))
   fault('已取消或結案訂單不可新增送達');
  if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||order.items.length!==1)
   fault('此試點僅限所有權明確的單品項訂單');
  const item=order.items[0],productKey=id(item.inventoryProductKey||item.productId);
  if(item.itemId!==itemId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
   ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
   ||item.transferPendingId||(item.custodyTransferId&&!allowCustody)||(order.logisticsTransfersPending??0)!==0)
   fault('品項不是可確認的實體倉出貨');
  if(!Array.isArray(order.returnRecords)||(!allowReturns&&(order.returnRecords.length||(item.returnedQty??0)!==0)))
   fault('退貨或補送流程尚未開放');
  const projection=core.projectShipmentDelivery({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
   shipments:order.warehouseShipmentRecords,deliveries:order.deliveryRecords});
  if(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty)
   fault('訂購數量投影不一致');
  const returnProjection=allowReturns?core.projectShipmentReturns({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
   shipments:order.warehouseShipmentRecords,deliveries:order.deliveryRecords,returns:order.returnRecords}):projection;
  if(item.warehouseShippedQty!==projection.shippedQty||order.deliveredQty!==projection.confirmedQty
   ||(item.deliveredQty??0)!==projection.confirmedQty||order.isDelivered!==returnProjection.isDelivered
   ||(allowReturns&&((item.returnedQty??0)!==returnProjection.returnedQty
    ||(order.returnedQty??0)!==returnProjection.returnedQty)))
   fault('出貨或客戶送達投影不一致');
  return {item,productKey,projection,returnProjection,cancelled};
}
// Shared whole-order projection for acknowledgement/correction and explicitly
// opted-in CLOSE return readers. Cancellation never permits new delivery.
function multiShipmentDeliveryContext(order,intent,{allowCancelledCloseReturn=false}={}){
 const {orderId,itemId,syncAttemptId}=intent;
 if(order.inventoryReservationStatus!=='completed'||order.inventoryReservationAttemptId!==syncAttemptId)
  fault('庫存同步未完成或來源同步識別碼已變更');
 const cancelled=order.status==='cancelled'&&order.orderStatus==='cancelled';
 if(!(allowCancelledCloseReturn&&cancelled)
  &&(!['active','normal'].includes(order.status)||![undefined,'','normal','active'].includes(order.orderStatus)))
  fault('已取消或結案訂單不可新增送達');
 if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||order.items.length<2
  ||order.items.length>5||order.items.filter(row=>row?.itemId===itemId).length!==1
  ||(order.logisticsTransfersPending??0)!==0)
  fault('此試點僅支援來源完整的 2–5 品項實體倉訂單');
 if(!Array.isArray(order.deliveryRecords)||!Array.isArray(order.returnRecords))
  fault('出貨、送達或退貨紀錄格式不正確');
 const whole=core.projectOrderShipmentReturns({orderId,items:order.items,
  shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords,returns:order.returnRecords});
 if((order.deliveredQty??0)!==whole.confirmedQty||(order.returnedQty??0)!==whole.returnedQty
  ||(order.isDelivered??false)!==whole.isDelivered)
  fault('整張訂單的客戶送達與退貨合計不一致');
 for(const source of order.items){
  if(String(source.productType||source.type||'').trim().toUpperCase()==='SERVICE')continue;
  const part=whole.items.find(row=>row.itemId===source.itemId);
  if(!part||(source.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
   ||String(source.productType||source.type||'').toUpperCase()==='SERVICE'
   ||source.transferPendingId||source.custodyTransferId
   ||(source.warehouseShippedQty??0)!==part.shippedQty
   ||(source.deliveredQty??0)!==part.confirmedQty
   ||(source.returnedQty??0)!==part.returnedQty
   ||!Number.isSafeInteger(source.dispatchPreparedQty??0)
   ||(source.dispatchPreparedQty??0)<part.shippedQty
   ||(source.dispatchPreparedQty??0)>part.orderedQty)
   fault('整單品項的出貨、送達、打單或退貨來源不一致');
 }
 const item=order.items.find(row=>row.itemId===itemId);
 const projection=whole.items.find(row=>row.itemId===itemId);
 return {item,productKey:projection.productKey,projection,whole,cancelled};
}
async function readShipmentProof(tx,db,order,intent,productKey) {
 const {orderId,itemId,shipmentId,syncAttemptId}=intent;
 const ref=(n,key)=>db.collection(n).doc(key);
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
  core.validateShipmentMovement(shipment,proof,{orderId,itemId,productKey});
  if(proof.intentHash!==originalIntent.hash)fault('來源倉庫出貨與實際扣帳憑證不一致');
  return shipment;
}
async function readWholeOrderShipmentProofs(tx,db,order,intent){
 const shipments=order.warehouseShipmentRecords??[];
 if(shipments.length>40)fault('多品項歷史出貨憑證超過本試點安全上限');
 for(const row of shipments)await readShipmentProof(tx,db,order,
  {...intent,itemId:row.itemId,shipmentId:row.id},row.productKey);
}
async function commitShipmentDelivery(db,uid,data,env=process.env,options={}){
 const custodyV3=options.allowCustody===true;
 if(custodyV3){
  const {custodyDeliveryProject}=require('./custody-delivery-service');
  if(!custodyDeliveryProject(env)||db.projectId!=='demo-yushin')
   fault('V3 保管送達確認尚未在此專案啟用');
 }
 const project=deliveryConfirmationBackendProject(env);
 // Existing direct-Service test fixtures use isolated local demo Firestore.
 // Externally callable requests cannot reach this path without their own gate.
 const directDemo=db.projectId==='demo-yushin'
  &&typeof env.FIRESTORE_EMULATOR_HOST==='string'
  &&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(env.FIRESTORE_EMULATOR_HOST);
 if((!project||db.projectId!==project)&&!directDemo)
  fault('送達確認後端未獲專案授權');
 id(uid);const intent=normalizeDeliveryIntent(data);
 const {orderId,itemId,shipmentId,operationId}=intent;
 return db.runTransaction(async tx=>{
  const {actorRole,orderRef,order}=await readShipmentActorOrder(tx,db,uid,orderId);
  const previous=order.deliveryRecords.filter(row=>row.id===operationId);
  if(previous.length){
   const record=previous[0];
   if(previous.length!==1||record.sourceType!=='WAREHOUSE_SHIPMENT_CONFIRMATION'||record.createdByUid!==uid
    ||record.createdByRole!==actorRole||record.intentHash!==intent.hash||record.orderId!==orderId
    ||record.itemId!==itemId||record.shipmentId!==shipmentId)
    fault('送達操作識別碼已用於其他交易','already-exists');
   return {...record.result,status:'already-applied',recordId:operationId};
  }
  if((order.deliveryHistory||[]).some(row=>row.recordId===operationId||row.operationId===operationId))
   fault('此送達操作已有歷史紀錄，不能以原識別碼重新確認');
  const multi=Array.isArray(order.items)&&order.items.length>1;
  const context=multi?multiShipmentDeliveryContext(order,intent):
   shipmentDeliveryContext(order,intent,{allowReturns:true,allowCustody:custodyV3});
  const {item,productKey}=context;
  if(custodyV3){
   if(multi||!item.custodyTransferId||order.ownerUid===undefined||order.returnRecords.length
     ||context.returnProjection.returnedQty!==0)
    fault('V3 保管送達確認只接受未退貨的單品項業務交接');
   await require('./custody-delivery-service').readCustodyDeliveryProofs(tx,db,order,context,intent);
  }
  await readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly:true});
  // All physical debits are checked, not merely the selected shipment.
  // This prevents a sibling's missing/corrupt immutable debit from being
  // concealed by an otherwise valid order-level delivery projection.
  if(multi)await readWholeOrderShipmentProofs(tx,db,order,intent);
  const shipment=await readShipmentProof(tx,db,order,intent,productKey);
  const expectedMovementId=shipment.movementId;
  const now=new Date().toISOString();
  const record={id:operationId,orderId,itemId,productKey,shipmentId,warehouseId:shipment.warehouseId,
   qty:intent.quantity,date:intent.date,notes:intent.notes,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION',
   shipmentMovementId:expectedMovementId,deliveryPlan:shipment.deliveryPlan,
   createdByUid:uid,createdByRole:actorRole,createdBy:uid,createdAt:now,intentHash:intent.hash};
  const records=[...order.deliveryRecords,record];
  const nextWhole=multi?core.projectOrderShipmentReturns({orderId,items:order.items,
   shipments:order.warehouseShipmentRecords??[],deliveries:records,returns:order.returnRecords}):null;
  const next=nextWhole?nextWhole.items.find(row=>row.itemId===itemId):
   core.projectShipmentReturns({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
    shipments:order.warehouseShipmentRecords,deliveries:records,returns:order.returnRecords});
  const result={orderId,itemId,shipmentId,confirmedQty:next.confirmedQty,
   pendingDeliveryQty:next.pendingDeliveryQty,isDelivered:(nextWhole??next).isDelivered};
  if(nextWhole)result.itemIsDelivered=next.isDelivered;
  record.result=result;
  const history={action:'create',source:'shipment_confirmation',recordId:operationId,before:null,after:record,by:uid,at:now};
  // One order document carries both authoritative acknowledgement and caches.
  // No inventory/warehouse/reservation/lot reads or stock-operation writes.
  const workIndex=await require('./service-order-fulfillment').mixedWorkIndex(db,tx,orderId,
   {...order,deliveryRecords:records,items:order.items.map(row=>row.itemId===itemId?{...row,deliveredQty:next.confirmedQty}:row),
    deliveredQty:(nextWhole??next).confirmedQty,isDelivered:(nextWhole??next).isDelivered},{proofOrder:order});
  tx.update(orderRef,{...workIndex,deliveryRecords:records,items:order.items.map(row=>row.itemId===itemId?
   {...row,deliveredQty:next.confirmedQty}:row),
   deliveredQty:(nextWhole??next).confirmedQty,isDelivered:(nextWhole??next).isDelivered,
   deliveryHistory:[...(order.deliveryHistory||[]),history],updatedAt:now});
  return {...result,status:'applied',recordId:operationId};
 });
}
function normalizeDeliveryReversalIntent(data){
 const keys=['orderId','itemId','deliveryRecordId','operationId','syncAttemptId','date','reason'];
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))
  fault('送達撤銷請求含未授權欄位','invalid-argument');
 const intent={};
 for(const key of ['orderId','itemId','deliveryRecordId','operationId','syncAttemptId'])intent[key]=id(data[key]);
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId)||intent.syncAttemptId.length>96)
  fault('撤銷操作或同步識別碼不正確','invalid-argument');
 if(typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date)
  ||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))
  ||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)
  fault('撤銷日期不正確','invalid-argument');
 if(typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>1000)
  fault('請填寫撤銷原因','invalid-argument');
 intent.date=data.date;intent.reason=data.reason.trim();
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function reverseShipmentDelivery(db,uid,data,env=process.env){
 const project=deliveryReversalBackendProject(env);
 // Direct tests use a local demo Firestore fixture; external Callables must
 // pass their independent gate before this Service can be reached.
 const directDemo=db.projectId==='demo-yushin'
  &&typeof env.FIRESTORE_EMULATOR_HOST==='string'
  &&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(env.FIRESTORE_EMULATOR_HOST);
 if((!project||db.projectId!==project)&&!directDemo)
  fault('送達撤銷後端未獲專案授權');
 const intent=normalizeDeliveryReversalIntent(data);
 const {orderId,itemId,deliveryRecordId,operationId,syncAttemptId}=intent;
 return db.runTransaction(async tx=>{
  const {actorRole,orderRef,order}=await readShipmentActorOrder(tx,db,uid,orderId);
  const history=order.deliveryHistory||[];
  const applied=history.filter(row=>row.operationId===operationId);
  if(applied.length){
   const prior=applied[0];
   if(applied.length!==1||prior.source!=='shipment_confirmation_reversal'||prior.action!=='delete'
    ||prior.actorUid!==uid||prior.actorRole!==actorRole||prior.intentHash!==intent.hash
    ||prior.orderId!==orderId||prior.itemId!==itemId||prior.recordId!==deliveryRecordId)
    fault('撤銷操作識別碼已用於其他交易','already-exists');
   return {...prior.result,status:'already-applied',operationId};
  }
  if(order.deliveryRecords.some(row=>row.id===operationId)||history.some(row=>row.recordId===operationId))
   fault('撤銷識別碼與既有送達操作衝突','already-exists');
  const multi=Array.isArray(order.items)&&order.items.length>1;
  const {item,productKey}=multi?multiShipmentDeliveryContext(order,intent):shipmentDeliveryContext(order,intent);
  if(multi){
   // Reversing an acknowledgement with a physical return requires a separate
   // return-correction contract. Do not erase the evidence backing that return.
   if(order.returnRecords.length)fault('退貨後的送達撤銷尚未開放');
   await readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly:true});
   await readWholeOrderShipmentProofs(tx,db,order,intent);
  }
  const target=order.deliveryRecords.find(row=>row.id===deliveryRecordId);
  if(!target)fault('原送達紀錄已移除或不存在');
  if(target.itemId!==itemId||target.productKey!==productKey||target.orderId!==orderId)
   fault('原送達紀錄與選定品項不一致');
  if(intent.date<target.date)fault('撤銷日期不得早於送達日期');
  const original=normalizeDeliveryIntent({orderId,itemId,shipmentId:target.shipmentId,quantity:target.qty,
   date:target.date,notes:target.notes,operationId:target.id,syncAttemptId});
  if(target.sourceType!=='WAREHOUSE_SHIPMENT_CONFIRMATION'||target.intentHash!==original.hash)
   fault('原送達紀錄意圖不一致');
  await readShipmentProof(tx,db,order,{...intent,shipmentId:target.shipmentId},productKey);
  const records=order.deliveryRecords.filter(row=>row.id!==deliveryRecordId);
  const nextWhole=multi?core.projectOrderShipmentReturns({orderId,items:order.items,
   shipments:order.warehouseShipmentRecords??[],deliveries:records,returns:order.returnRecords}):null;
  const next=nextWhole?nextWhole.items.find(row=>row.itemId===itemId):
   core.projectShipmentDelivery({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
    shipments:order.warehouseShipmentRecords,deliveries:records});
  const result={orderId,itemId,deliveryRecordId,reversedQty:target.qty,
   confirmedQty:next.confirmedQty,pendingDeliveryQty:next.pendingDeliveryQty,isDelivered:(nextWhole??next).isDelivered};
  if(nextWhole)result.itemIsDelivered=next.isDelivered;
  const now=new Date().toISOString();
  const event={action:'delete',source:'shipment_confirmation_reversal',orderId,itemId,
   recordId:deliveryRecordId,operationId,before:target,after:null,date:intent.date,reason:intent.reason,
   actorUid:uid,actorRole,by:uid,at:now,intentHash:intent.hash,result};
  // Correct only customer acknowledgement; the goods remain physically shipped.
  const workIndex=await require('./service-order-fulfillment').mixedWorkIndex(db,tx,orderId,
   {...order,deliveryRecords:records,items:order.items.map(row=>row.itemId===itemId?{...row,deliveredQty:next.confirmedQty}:row),
    deliveredQty:(nextWhole??next).confirmedQty,isDelivered:(nextWhole??next).isDelivered},{proofOrder:order});
  tx.update(orderRef,{...workIndex,deliveryRecords:records,deliveryHistory:[...history,event],
   items:order.items.map(row=>row.itemId===itemId?{...row,deliveredQty:next.confirmedQty}:row),
   deliveredQty:(nextWhole??next).confirmedQty,isDelivered:(nextWhole??next).isDelivered,updatedAt:now});
  return {...result,status:'applied',operationId};
 });
}
module.exports={normalizeDeliveryIntent,commitShipmentDelivery,normalizeDeliveryReversalIntent,reverseShipmentDelivery,readShipmentActorOrder,shipmentDeliveryContext,readShipmentProof,readWholeOrderShipmentProofs};
