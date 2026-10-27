'use strict';
// Quick Purchase has independent rollout gates for Emulator, Preview and production.
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
// Preview has an independent opt-in, never reused to enable production.
function allowPreviewQuickPurchase(env=process.env){
 return env.ENABLE_PREVIEW_QUICK_PURCHASE==='true'
  && projectIdFromEnvironment(env)==='preview-20135'
  && !env.FUNCTIONS_EMULATOR && !env.FIRESTORE_EMULATOR_HOST
  && !env.FIREBASE_AUTH_EMULATOR_HOST;
}
// Production requires its own explicit server opt-in, and must never use
// Emulator credentials or a Preview flag to write to the live database.
function allowProductionQuickPurchase(env=process.env){
 return env.ENABLE_PRODUCTION_QUICK_PURCHASE==='true'
  && projectIdFromEnvironment(env)==='yu-shing-company'
  && !env.FUNCTIONS_EMULATOR
  && !env.FIRESTORE_EMULATOR_HOST
  && !env.FIREBASE_AUTH_EMULATOR_HOST;
}
function createQuickPurchaseCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const emulatorAllowed=allowQuickPurchaseEmulator(env);
  const previewAllowed=allowPreviewQuickPurchase(env);
  const productionAllowed=allowProductionQuickPurchase(env);
  if(!emulatorAllowed&&!previewAllowed&&!productionAllowed)
   throw new HttpsError('failed-precondition','手動採購後端未獲准在此專案啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  const project=emulatorAllowed?'demo-yushin':previewAllowed?'preview-20135':'yu-shing-company';
  if(db.projectId!==project)
   throw new HttpsError('failed-precondition','採購資料庫與授權的專案不一致');
  try{return await commitV2QuickPurchase(db,request.auth.uid,request.data);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Quick Purchase backend transaction failed',error);
   throw new HttpsError('internal','手動採購交易失敗');
  }
 });
}
module.exports={allowQuickPurchaseEmulator,allowPreviewQuickPurchase,allowProductionQuickPurchase,createQuickPurchaseCallable};
