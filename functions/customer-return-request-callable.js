'use strict';
const {customerReturnRequestBackendProject}=require('./customer-return-request-gate');
const {commitReturnRequestOperation}=require('./customer-return-request-service');
function createCustomerReturnRequestCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=action=>onCall({region:'asia-east1'},async request=>{
  const project=customerReturnRequestBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','退貨申請後端尚未獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)throw new HttpsError('failed-precondition','退貨申請資料庫與授權專案不一致');
  try{return await commitReturnRequestOperation(db,request.auth.uid,request.data,action,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Return request operation failed',error);
   throw new HttpsError('internal','退貨申請結果無法確認，請保留原操作識別碼');
  }
 });
 return {requestV2CustomerReturn:wrap('REQUEST'),withdrawV2CustomerReturnRequest:wrap('WITHDRAW')};
}
module.exports={createCustomerReturnRequestCallables};
