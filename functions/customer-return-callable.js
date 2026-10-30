'use strict';
const {customerReturnBackendProject}=require('./customer-return-gate');
const {commitLocationReturn}=require('./location-return-service');
const {planLocationReturnTrace}=require('./location-return-trace-service');
// Trace remains read-only; receipt delegates to the existing single writer.
function createCustomerReturnCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=service=>onCall({region:'asia-east1'},async request=>{
  const project=customerReturnBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','退貨後端尚未在此專案獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)throw new HttpsError('failed-precondition','退貨資料庫與授權專案不一致');
  try{return await service(db,request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Customer return transaction failed',error);
   throw new HttpsError('internal','退貨結果無法確認，請保留原操作識別碼');
  }
 });
 return {previewV2CustomerReturn:wrap(planLocationReturnTrace),receiveV2CustomerReturn:wrap(commitLocationReturn)};
}
module.exports={createCustomerReturnCallables};
