'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

function allowDispatchEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(value);
 return env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&projectIdFromEnvironment(env)==='demo-yushin'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
// Deliberately no production gate: shipment preparation is still a Preview candidate.
function allowPreviewDispatch(env=process.env){
 return env.ENABLE_PREVIEW_DISPATCH==='true'&&projectIdFromEnvironment(env)==='preview-20135'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
}
function dispatchBackendProject(env=process.env){
 if(allowDispatchEmulator(env))return 'demo-yushin';
 if(allowPreviewDispatch(env))return 'preview-20135';
 return '';
}
module.exports={allowDispatchEmulator,allowPreviewDispatch,dispatchBackendProject};
