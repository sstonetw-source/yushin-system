'use strict';
// The deployed endpoint is inert unless the actual Firebase project is the
// dedicated Preview project AND the backend rollout switch is explicitly set.
// A local demo Emulator may exercise the same entry, never a live project.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {commitV2FormalPurchase}=require('./formal-purchase-commit-service');

function allowPreviewFormalPurchase(env=process.env){
 if(env.ENABLE_PREVIEW_FORMAL_PURCHASE!=='true')return false;
 const project=projectIdFromEnvironment(env);
 if(project==='preview-20135')return !env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return project==='demo-yushin'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}

function createPreviewFormalPurchaseCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!allowPreviewFormalPurchase(env))
   throw new HttpsError('failed-precondition','正式採購後端僅開放獨立 Preview 驗收');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const database=getDatabase(),project=projectIdFromEnvironment(env);
  if(database.projectId!==project)
   throw new HttpsError('failed-precondition','採購資料庫與授權的 Preview 專案不一致');
  try{return await commitV2FormalPurchase(database,request.auth.uid,request.data);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Preview formal purchase transaction failed',error);
   throw new HttpsError('internal','採購交易查核或提交失敗');
  }
 });
}

module.exports={allowPreviewFormalPurchase,createPreviewFormalPurchaseCallable};
