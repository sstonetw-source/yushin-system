'use strict';
const {deliveryReversalBackendProject}=require('./delivery-reversal-gate');
const {reverseShipmentDelivery}=require('./shipment-delivery-service');

function createDeliveryReversalCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const project=deliveryReversalBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','客戶送達撤銷後端尚未在此專案獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)throw new HttpsError('failed-precondition','送達撤銷資料庫與授權專案不一致');
  try{return await reverseShipmentDelivery(db,request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Delivery reversal transaction failed',error);
   throw new HttpsError('internal','送達撤銷交易失敗');
  }
 });
}
module.exports={createDeliveryReversalCallable};
