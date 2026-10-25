'use strict';
// A production deployment cannot activate this pilot with a flag alone.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {commitV2QuickPurchase}=require('./quick-purchase-commit-service');
function allowQuickPurchaseEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return projectIdFromEnvironment(env)==='demo-yushin'
  && env.FUNCTIONS_EMULATOR==='true'
  && env.ENABLE_QUICK_PURCHASE_EMULATOR==='true'
  && local(env.FIRESTORE_EMULATOR_HOST)
  && local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
// Only a separately authorized preview project can use the backend; production stays disabled.
function allowPreviewQuickPurchase(env=process.env){
 return env.ENABLE_PREVIEW_QUICK_PURCHASE==='true'
  && projectIdFromEnvironment(env)==='preview-20135'
  && !env.FUNCTIONS_EMULATOR && !env.FIRESTORE_EMULATOR_HOST
  && !env.FIREBASE_AUTH_EMULATOR_HOST;
}
function createQuickPurchaseCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const emulatorAllowed=allowQuickPurchaseEmulator(env);
  const previewAllowed=allowPreviewQuickPurchase(env);
  if(!emulatorAllowed&&!previewAllowed)
   throw new HttpsError('failed-precondition','手動採購後端未獲准在此專案啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  const project=emulatorAllowed?'demo-yushin':'preview-20135';
  if(db.projectId!==project)
   throw new HttpsError('failed-precondition','採購資料庫與授權的測試專案不一致');
  try{return await commitV2QuickPurchase(db,request.auth.uid,request.data);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Quick Purchase backend transaction failed',error);
   throw new HttpsError('internal','手動採購交易失敗');
  }
 });
}
module.exports={allowQuickPurchaseEmulator,allowPreviewQuickPurchase,createQuickPurchaseCallable};
