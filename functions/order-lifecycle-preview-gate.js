'use strict';
// Cancellation/restoration needs a separate rollout from shipment and delivery.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

function allowOrderLifecycleEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(value);
 return env.ENABLE_V2_LIFECYCLE_AUTH_EMULATOR==='true'
  &&env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&projectIdFromEnvironment(env)==='demo-yushin'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
function allowPreviewOrderLifecycle(env=process.env){
 return env.ENABLE_PREVIEW_ORDER_LIFECYCLE==='true'
  &&projectIdFromEnvironment(env)==='preview-20135'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
}
function orderLifecycleBackendProject(env=process.env){
 if(allowOrderLifecycleEmulator(env))return 'demo-yushin';
 if(allowPreviewOrderLifecycle(env))return 'preview-20135';
 return '';
}
module.exports={allowOrderLifecycleEmulator,allowPreviewOrderLifecycle,orderLifecycleBackendProject};
