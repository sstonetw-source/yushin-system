'use strict';
const {shipmentBackendProject}=require('./warehouse-shipment-gate');
const {commitLocationShipment}=require('./location-shipment-service');

function createWarehouseShipmentCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const project=shipmentBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','實際出貨後端尚未在此專案獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project)throw new HttpsError('failed-precondition','實際出貨資料庫與授權專案不一致');
  try{return await commitLocationShipment(db,request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Warehouse shipment transaction failed',error);
   throw new HttpsError('internal','實際出貨交易失敗');
  }
 });
}
module.exports={createWarehouseShipmentCallable};
