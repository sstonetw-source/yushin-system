'use strict';
const {deliveryConfirmationBackendProject}=require('./delivery-confirmation-gate');
const {commitShipmentDelivery}=require('./shipment-delivery-service');

function createDeliveryConfirmationCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const project=deliveryConfirmationBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','客戶送達後端尚未在此專案獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)throw new HttpsError('failed-precondition','送達確認資料庫與授權專案不一致');
  try{return await commitShipmentDelivery(db,request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Delivery confirmation transaction failed',error);
   throw new HttpsError('internal','送達確認交易失敗');
  }
 });
}
module.exports={createDeliveryConfirmationCallable};
