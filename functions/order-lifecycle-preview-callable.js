'use strict';
const {orderLifecycleBackendProject}=require('./order-lifecycle-preview-gate');
const {commitOrderLocationLifecycleAndRecover}=require('./single-item-location-lifecycle-service');

function createOrderLifecycleCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const project=orderLifecycleBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','訂單取消／恢復後端尚未在此專案獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)throw new HttpsError('failed-precondition','取消／恢復資料庫與授權專案不一致');
  try{return await commitOrderLocationLifecycleAndRecover(db,request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Order lifecycle transaction failed',error);
   throw new HttpsError('internal','取消／恢復交易結果無法確認，請保留原操作識別碼');
  }
 });
}
module.exports={createOrderLifecycleCallable};
