'use strict';
// No export from index.js: exercised only by the isolated demo Emulator harness.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {planLocationReturnTrace}=require('./location-return-trace-service');
const {commitLocationReturn}=require('./location-return-service');
const {commitLocationDispatchPreparation}=require('./location-dispatch-service');
const {commitLocationShipment}=require('./location-shipment-service');
const {commitShipmentDelivery,reverseShipmentDelivery}=require('./shipment-delivery-service');
const {commitOrderLocationLifecycleAndRecover}=require('./single-item-location-lifecycle-service');
const {listReleasedV2FreeStock,resumeReleasedV2FreeStock}=require('./single-item-location-service');
const {previewV2FormalPurchase}=require('./formal-purchase-preview-service');
const {commitV2FormalPurchase}=require('./formal-purchase-commit-service');
const {receiveV2Supply}=require('./supply-receipt-service');
function allowV2ReturnAuthEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(value);
 return env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&projectIdFromEnvironment(env)==='demo-yushin'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
function createV2ReturnCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=service=>onCall({region:'asia-east1'},async request=>{
  if(!allowV2ReturnAuthEmulator(env))throw new HttpsError('failed-precondition','v2 登入整合僅限 demo-yushin Emulator');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  const db=getDatabase();
  if(db.projectId!=='demo-yushin')throw new HttpsError('failed-precondition','v2 登入整合的資料庫來源不正確');
  try{return await service(db,request.auth.uid,request.data);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message,error.reason==='dispatch-stale'?{reason:'dispatch-stale'}:undefined);
   console.error('V2 Emulator transaction failed',error);
   throw new HttpsError('internal','交易查核或提交失敗');
  }
 });
 return {receiveV2Supply:wrap(receiveV2Supply),previewV2CustomerReturn:wrap(planLocationReturnTrace),receiveV2CustomerReturn:wrap(commitLocationReturn),
  prepareV2OrderDispatch:wrap(commitLocationDispatchPreparation),
  shipV2WarehouseItem:wrap(commitLocationShipment),
  confirmV2ShipmentDelivery:wrap(commitShipmentDelivery),
  reverseV2ShipmentDelivery:wrap(reverseShipmentDelivery),
  setV2OrderLifecycle:wrap(commitOrderLocationLifecycleAndRecover),
  listV2FreeStockRecovery:wrap(listReleasedV2FreeStock),
  resumeV2FreeStockRecovery:wrap(resumeReleasedV2FreeStock),
  previewV2FormalPurchase:wrap(previewV2FormalPurchase),
  commitV2FormalPurchase:wrap(commitV2FormalPurchase)};
}
module.exports={allowV2ReturnAuthEmulator,createV2ReturnCallables};
