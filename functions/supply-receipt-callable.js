'use strict';
const {receiptBackendProject}=require('./supply-receipt-gate');
const {receiveV2Supply}=require('./supply-receipt-service');

function createSupplyReceiptCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const project=receiptBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','收貨後端尚未在此專案獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)
   throw new HttpsError('failed-precondition','收貨資料庫與授權的專案不一致');
  try{return await receiveV2Supply(db,request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Receiving transaction failed',error);
   throw new HttpsError('internal','收貨交易失敗');
  }
 });
}
module.exports={createSupplyReceiptCallable};
