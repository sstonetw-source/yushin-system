'use strict';
// Independent rollout authority for salesperson-owned supplier commitments.
// This never grants sales accounts formal PO / purchasing permissions.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {commitV2SelfOrder}=require('./quick-purchase-commit-service');
function selfOrderBackendProject(env=process.env){
 const project=projectIdFromEnvironment(env);
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 if(project==='demo-yushin'&&env.FUNCTIONS_EMULATOR==='true'
   &&env.ENABLE_SELF_ORDER_EMULATOR==='true'&&local(env.FIRESTORE_EMULATOR_HOST)
   &&local(env.FIREBASE_AUTH_EMULATOR_HOST))return project;
 if(project==='preview-20135'&&env.ENABLE_PREVIEW_SELF_ORDER==='true'
   &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST)return project;
 if(project==='yu-shing-company'&&env.ENABLE_PRODUCTION_SELF_ORDER_BACKEND==='true'
   &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST)return project;
 return '';
}
function createSelfOrderCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  const project=selfOrderBackendProject(env);
  if(!project)throw new HttpsError('failed-precondition','業務自行訂貨後端尚未獲准啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!==project||db.databaseId&&db.databaseId!=='(default)')
   throw new HttpsError('failed-precondition','業務自行訂貨資料庫與授權專案不一致');
  try{return await commitV2SelfOrder(db,request.auth.uid,request.data);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Self-order commitment failed',error);
   throw new HttpsError('internal','業務自行訂貨未確認，請保留原操作識別碼重試');
  }
 });
}
module.exports={selfOrderBackendProject,createSelfOrderCallable};
