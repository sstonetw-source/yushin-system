'use strict';
const {mainTransferAllocationProject}=require('./main-transfer-allocation-gate');
const {drainReleasedV2FreeStock}=require('./single-item-location-service');
function normalizeAllocationSource(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).join(',')!=='transferId'
  ||typeof data.transferId!=='string'||!data.transferId||data.transferId!==data.transferId.trim()
  ||data.transferId.includes('/')||data.transferId.length>96)
  throw Object.assign(Error('請使用原調撥識別碼，不可指定數量或重建分配操作'),{code:'invalid-argument'});
 return {movementId:data.transferId+'-in',maxSteps:5};
}
function createMainTransferAllocationCallable({onCall,HttpsError,getDatabase,env=process.env,drain=drainReleasedV2FreeStock}){
 return onCall({region:'asia-east1'},async request=>{
  const project=mainTransferAllocationProject(env);
  if(!project)throw new HttpsError('failed-precondition','主倉分配續傳尚未在此環境啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{
   const source=normalizeAllocationSource(request.data),db=getDatabase();
   if(db.projectId!==project)throw new HttpsError('failed-precondition','分配資料庫與授權專案不一致');
   // The coordinator validates current role, source proofs and original job on
   // every step. Never write stockTransfers display completion as authority.
   const result=await drain(db,request.auth.uid,source);
   return {...result,transferId:request.data.transferId};
  }catch(error){
   if(['invalid-argument','failed-precondition','permission-denied','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Main transfer allocation continuation failed',error);
   throw new HttpsError('internal','分配結果無法確認，請使用原調撥編號續傳；不可重複收貨');
  }
 });
}
module.exports={normalizeAllocationSource,createMainTransferAllocationCallable};
