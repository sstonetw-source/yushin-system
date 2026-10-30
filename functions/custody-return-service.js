'use strict';
// Custody customer-return trial delegates quantity, ledger and lot restoration
// to the single existing trusted location-return writer. It refuses unrelated
// receipt requests and closes returns without auto-allocating owner's stock.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {commitLocationReturn}=require('./location-return-service');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function custodyReturnProject(env=process.env){
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return projectIdFromEnvironment(env)==='demo-yushin'
  &&env.FUNCTIONS_EMULATOR==='true'&&env.ENABLE_V3_CUSTODY_RETURN_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}
async function commitCustodyReturn(db,uid,data,env=process.env){
 if(!custodyReturnProject(env)||db.projectId!=='demo-yushin')
  fail('V3 保管退貨尚未在此專案啟用');
 return commitLocationReturn(db,uid,data,env,{allowCustody:true});
}
function createCustodyReturnCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!custodyReturnProject(env))throw new HttpsError('failed-precondition','V3 保管退貨尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitCustodyReturn(getDatabase(),request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('V3 Custody return transaction failed',error);
   throw new HttpsError('internal','V3 保管退貨結果未確認，請以原操作編號查核');
  }
 });
}
module.exports={custodyReturnProject,commitCustodyReturn,createCustodyReturnCallable};
