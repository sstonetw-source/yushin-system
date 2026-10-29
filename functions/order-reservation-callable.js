'use strict';
const {allowOrderReservationBackend}=require('./order-reservation-gate');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {commitOrderReservation}=require('./order-reservation-service');

function createOrderReservationCallable({onCall,HttpsError,getDatabase,env=process.env}){
  return onCall({region:'asia-east1'},async request=>{
    if(!allowOrderReservationBackend(env))
      throw new HttpsError('failed-precondition','整單後端預留尚未在 Preview 啟用');
    if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
    const db=getDatabase();
    if(db.projectId!==projectIdFromEnvironment(env))
      throw new HttpsError('failed-precondition','整單預留資料庫與授權專案不一致');
    try{return await commitOrderReservation(db,request.auth.uid,request.data);}
    catch(error){
      const allowed=['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'];
      if(allowed.includes(error.code))throw new HttpsError(error.code,error.message);
      console.error('Order reservation transaction failed',error);
      throw new HttpsError('internal','整單預留交易結果無法確認，請保留原同步識別碼');
    }
  });
}
module.exports={createOrderReservationCallable};
