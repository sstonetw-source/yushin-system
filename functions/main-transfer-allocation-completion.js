'use strict';
const {mainTransferAllocationProject}=require('./main-transfer-allocation-gate');
const {readMainTransferFreeStockSource}=require('./main-transfer-free-stock-source');
const {releasedV2FreeStockRunId,normalizeAutomaticFreeStockIntent,validateAutomaticFreeStockCheckpoint}=require('./single-item-location-service');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
// Display projection only. Stock, demand and durable job remain exclusively
// owned by the existing coordinator. Mutable display fields are never evidence.
async function projectMainTransferAllocationCompletion(db,uid,transferId){
 if(!mainTransferAllocationProject()||db.projectId!==mainTransferAllocationProject())fail('分配狀態未在此環境啟用');
 if(typeof transferId!=='string'||!transferId||transferId.includes('/')||transferId.length>96||transferId!==transferId.trim())fail('原調撥識別碼不正確');
 return db.runTransaction(async tx=>{
  const ref=(name,id)=>db.collection(name).doc(id);
  const actor=await tx.get(ref('users',uid)),profile=actor.exists?actor.data():null;
  if(!profile||profile.active===false||profile.disabled===true||!['admin','purchaser','warehouse'].includes(profile.role))fail('目前角色不能確認分配狀態','permission-denied');
  const state=await readMainTransferAllocationState(tx,db,transferId);
  const {runId,maxQty:quantity,allocatedQty}=state;
  const job={status:state.status,allocatedQty,completionReason:state.completionReason};
  if(job.status!=='completed')fail('原分配尚未完成，不得隱藏待處理來源');
  const transferRef=ref('stockTransfers',transferId),snap=await tx.get(transferRef),t=snap.data();
  if(!snap.exists)fail('原調撥不存在');
  const patch={allocationCompleted:true,autoAllocatedQty:job.allocatedQty,allocationRunId:runId,
   allocationCompletionReason:job.completionReason};
  if(Object.entries(patch).some(([key,value])=>t[key]!==value))tx.update(transferRef,{...patch,allocationUpdatedAt:new Date().toISOString()});
  return {runId,maxQty:quantity,allocatedQty:job.allocatedQty};
 });
}
async function readMainTransferAllocationState(tx,db,transferId){
 const ref=(name,id)=>db.collection(name).doc(id);
 const movementId=transferId+'-in',runId=releasedV2FreeStockRunId(movementId);
  const incoming=await tx.get(ref('inventoryMovements',movementId));
  if(!incoming.exists)fail('找不到原入庫異動');
  const event=incoming.data(),quantity=await readMainTransferFreeStockSource(tx,db,movementId,event);
  const intent=normalizeAutomaticFreeStockIntent({productKey:event.productKey,warehouseId:event.warehouseId,maxQty:quantity,runId});
  const checkpoint=await tx.get(ref('reservationOperationReceipts','single-v2-free-batch-'+runId));
  const job=checkpoint.exists?checkpoint.data():null;
  if(!job)return {status:'pending',runId,maxQty:quantity,allocatedQty:0};
  if(job.action!=='single_v2_free_stock_batch'||job.intentHash!==intent.hash
   ||job.productKey!==intent.productKey||job.warehouseId!==intent.warehouseId||job.maxQty!==quantity)fail('找不到相符的權威分配紀錄');
  validateAutomaticFreeStockCheckpoint(job,intent);
  return {status:job.status,runId,maxQty:quantity,allocatedQty:job.allocatedQty,completionReason:job.completionReason||''};
}
module.exports={projectMainTransferAllocationCompletion,readMainTransferAllocationState};
