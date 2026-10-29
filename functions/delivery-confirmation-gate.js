'use strict';
// A customer acknowledgement is distinct from physical shipment and stock.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

function allowDeliveryConfirmationEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(value);
 return env.ENABLE_V2_DELIVERY_AUTH_EMULATOR==='true'
  &&env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&projectIdFromEnvironment(env)==='demo-yushin'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
function allowPreviewDeliveryConfirmation(env=process.env){
 return env.ENABLE_PREVIEW_DELIVERY_CONFIRMATION==='true'
  &&projectIdFromEnvironment(env)==='preview-20135'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
}
function deliveryConfirmationBackendProject(env=process.env){
 if(allowDeliveryConfirmationEmulator(env))return 'demo-yushin';
 if(allowPreviewDeliveryConfirmation(env))return 'preview-20135';
 return '';
}
module.exports={allowDeliveryConfirmationEmulator,allowPreviewDeliveryConfirmation,deliveryConfirmationBackendProject};
