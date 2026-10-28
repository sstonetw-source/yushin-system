'use strict';
const {dispatchBackendProject}=require('./dispatch-preparation-gate');
const {commitLocationDispatchPreparation}=require('./location-dispatch-service');

function createDispatchPreparationCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const project=dispatchBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','出貨準備後端尚未在此專案獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)throw new HttpsError('failed-precondition','出貨準備資料庫與授權專案不一致');
  try{return await commitLocationDispatchPreparation(db,request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message,error.reason==='dispatch-stale'?{reason:'dispatch-stale'}:undefined);
   console.error('Dispatch preparation transaction failed',error);
   throw new HttpsError('internal','出貨準備交易失敗');
  }
 });
}
module.exports={createDispatchPreparationCallable};
