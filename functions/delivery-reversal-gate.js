'use strict';
// Customer acknowledgement reversal is independently enabled from confirmation.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

function allowDeliveryReversalEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(value);
 return env.ENABLE_V2_DELIVERY_AUTH_EMULATOR==='true'
  &&env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&projectIdFromEnvironment(env)==='demo-yushin'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
function allowPreviewDeliveryReversal(env=process.env){
 return env.ENABLE_PREVIEW_DELIVERY_REVERSAL==='true'
  &&projectIdFromEnvironment(env)==='preview-20135'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
}
function deliveryReversalBackendProject(env=process.env){
 if(allowDeliveryReversalEmulator(env))return 'demo-yushin';
 if(allowPreviewDeliveryReversal(env))return 'preview-20135';
 return '';
}
module.exports={allowDeliveryReversalEmulator,allowPreviewDeliveryReversal,deliveryReversalBackendProject};
