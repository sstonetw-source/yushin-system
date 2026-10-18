'use strict';
// No export from index.js: exercised only by the isolated demo Emulator harness.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {planLocationReturnTrace}=require('./location-return-trace-service');
const {commitLocationReturn}=require('./location-return-service');
function allowV2ReturnAuthEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(value);
 return env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&projectIdFromEnvironment(env)==='demo-yushin'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
function createV2ReturnCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=service=>onCall({region:'asia-east1'},async request=>{
  if(!allowV2ReturnAuthEmulator(env))throw new HttpsError('failed-precondition','退貨登入整合僅限 demo-yushin Emulator');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!=='demo-yushin')throw new HttpsError('failed-precondition','退貨登入整合的資料庫來源不正確');
  try{return await service(db,request.auth.uid,request.data);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('V2 return Emulator transaction failed',error);
   throw new HttpsError('internal','退貨查核或入庫失敗');
  }
 });
 return {previewV2CustomerReturn:wrap(planLocationReturnTrace),receiveV2CustomerReturn:wrap(commitLocationReturn)};
}
module.exports={allowV2ReturnAuthEmulator,createV2ReturnCallables};
