'use strict';
// Application/withdrawal only: this service never writes inventory or receipts.
const {createHash}=require('node:crypto');
const {customerReturnRequestBackendProject}=require('./customer-return-request-gate');
const {validateLocationReturnRequests}=require('./location-return-service');
const {readShipmentActorOrder,shipmentDeliveryContext,readWholeOrderShipmentProofs}=require('./shipment-delivery-service');
const {readLocationReturnProofs,readMultiReturnSource,assertCancelledCloseReturnContext}=require('./location-return-trace-service');
function fault(message,code='failed-precondition'){const error=new Error(message);error.code=code;throw error;}
function id(value){
 if(typeof value!=='string'||!value||value!==value.trim()||value.length>160||value.includes('/'))
  fault('退貨申請識別碼不正確','invalid-argument');
 return value;
}
function normalizeReturnRequestOperation(action,data){
 const keys=action==='REQUEST'?['orderId','itemId','operationId','syncAttemptId','qty','date','reason']:
  action==='WITHDRAW'?['orderId','requestId','operationId','syncAttemptId']:null;
 if(!keys||!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(key=>!keys.includes(key)))
  fault('退貨申請包含未授權欄位','invalid-argument');
 const intent={action,orderId:id(data.orderId),operationId:id(data.operationId),syncAttemptId:id(data.syncAttemptId)};
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId)||intent.syncAttemptId.length>96)
  fault('退貨操作或同步識別碼不正確','invalid-argument');
 if(action==='REQUEST'){
  if(!Number.isSafeInteger(data.qty)||data.qty<=0||data.qty>1000000
   ||typeof data.reason!=='string'||data.reason.length>1000
   ||typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date)
   ||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))
   ||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)
   fault('退貨申請日期、數量或原因不正確','invalid-argument');
  Object.assign(intent,{itemId:id(data.itemId),qty:data.qty,date:data.date,reason:data.reason.trim()});
 }else intent.requestId=id(data.requestId);
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitReturnRequestOperation(db,uid,data,action,env=process.env){
 const project=customerReturnRequestBackendProject(env);
 if(!project||db.projectId!==project)fault('退貨申請資料庫與授權專案不一致');
 const intent=normalizeReturnRequestOperation(action,data);
 return db.runTransaction(async tx=>{
  const {actorRole,orderRef,order}=await readShipmentActorOrder(tx,db,uid,intent.orderId);
  const requests=validateLocationReturnRequests(order);
  if((order.returnPending??false)!==requests.some(row=>row.status==='PENDING'))fault('退貨待收旗標不一致');
  const requestId=action==='REQUEST'?intent.operationId:intent.requestId;
  const prior=requests.find(row=>row.id===requestId);
  const result=status=>({status,action,orderId:intent.orderId,requestId,operationId:intent.operationId,
   syncAttemptId:intent.syncAttemptId,actorUid:uid,actorRole});
  if(action==='REQUEST'&&prior){
   if(prior.requestIntentHash!==intent.hash||prior.createdByUid!==uid||prior.createdByRole!==actorRole)
    fault('退貨申請識別碼已對應其他內容或角色','already-exists');
   return result('already-applied');
  }
  if(action==='WITHDRAW'&&!prior)fault('找不到原退貨申請','not-found');
  const reused=requests.find(row=>row.cancelOperationId===intent.operationId);
  if(reused){
   if(action!=='WITHDRAW'||reused.id!==requestId||reused.cancelIntentHash!==intent.hash
    ||reused.cancelledBy!==uid||reused.cancelledByRole!==actorRole)
    fault('退貨操作識別碼已對應其他內容或角色','already-exists');
   return result('already-applied');
  }
  if(action==='WITHDRAW'&&requests.some(row=>row.id===intent.operationId))
   fault('退貨操作識別碼已用於申請','already-exists');
  if(action==='WITHDRAW'&&prior.status!=='PENDING')return {...result('not-pending'),requestStatus:prior.status};
  const itemId=action==='REQUEST'?intent.itemId:prior.itemId;
  const context=shipmentDeliveryContext(order,{...intent,itemId},
   {allowReturns:true,allowCancelledCloseReturn:true,allowMultiReturn:true});
  assertCancelledCloseReturnContext(order,context);
  await readWholeOrderShipmentProofs(tx,db,order,{...intent,itemId});
  await readLocationReturnProofs(tx,db,order,{...intent,itemId},context.productKey,{closedOnly:context.cancelled||!!context.whole});
  await readMultiReturnSource(tx,db,order,{...intent,itemId,
   warehouseId:context.item.warehouseId||order.warehouseId},context);
  const now=new Date().toISOString();let next,index;
  if(action==='REQUEST'){
   if(requests.length>=30)fault('每張訂單最多 30 次退貨申請');
   const pending=requests.filter(row=>row.itemId===itemId&&row.status==='PENDING')
    .reduce((sum,row)=>sum+row.qty-row.receivedQty,0);
   const allowed=context.returnProjection.confirmedQty-context.returnProjection.returnedQty-pending;
   if(intent.qty>allowed)fault('退貨申請超過原送達扣除已退貨與待收的餘量');
   next=[...requests,{id:requestId,itemId,qty:intent.qty,receivedQty:0,date:intent.date,reason:intent.reason,
    status:'PENDING',settlement:'CLOSE',createdAt:now,createdBy:uid,
    createdByUid:uid,createdByRole:actorRole,requestIntentHash:intent.hash,requestSyncAttemptId:intent.syncAttemptId}];
   index=next.length-1;
  }else{
   index=requests.findIndex(row=>row.id===requestId);
   next=requests.map((row,i)=>i===index?{...row,status:'CANCELLED',cancelledAt:now,cancelledBy:uid,
    cancelledByRole:actorRole,cancelOperationId:intent.operationId,cancelIntentHash:intent.hash,
    cancelledSyncAttemptId:intent.syncAttemptId}:row);
  }
  tx.update(orderRef,{returnRequests:next,returnPending:next.some(row=>row.status==='PENDING'),
   returnRequestMutationIndex:index,updatedAt:now});
  return result('applied');
 });
}
module.exports={normalizeReturnRequestOperation,commitReturnRequestOperation};
