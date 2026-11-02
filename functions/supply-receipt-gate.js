'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

// Preserve the existing isolated full-site Auth/Functions/Firestore test entry.
function allowReceiptEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'
  && env.FUNCTIONS_EMULATOR==='true'
  && projectIdFromEnvironment(env)==='demo-yushin'
  && local(env.FIRESTORE_EMULATOR_HOST)
  && local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
// Preview is independently authorized; the production project can never
// activate this receiving candidate by changing a flag.
function allowPreviewReceiving(env=process.env){
 return env.ENABLE_PREVIEW_RECEIVING==='true'
  && projectIdFromEnvironment(env)==='preview-20135'
  && !env.FUNCTIONS_EMULATOR
  && !env.FIRESTORE_EMULATOR_HOST
  && !env.FIREBASE_AUTH_EMULATOR_HOST;
}
// A separate, default-off deployment decision; neither the Preview flag nor a
// client rollout flag can open the production Callable on its own.
function allowProductionReceiving(env=process.env){
 return env.ENABLE_PRODUCTION_RECEIVING_BACKEND==='true'
  && projectIdFromEnvironment(env)==='yu-shing-company'
  && !env.FUNCTIONS_EMULATOR
  && !env.FIRESTORE_EMULATOR_HOST
  && !env.FIREBASE_AUTH_EMULATOR_HOST;
}
function receiptBackendProject(env=process.env){
 if(allowReceiptEmulator(env))return 'demo-yushin';
 if(allowPreviewReceiving(env))return 'preview-20135';
 if(allowProductionReceiving(env))return 'yu-shing-company';
 return '';
}
module.exports={allowReceiptEmulator,allowPreviewReceiving,allowProductionReceiving,receiptBackendProject};
