'use strict';
// Customer-shipment accounting must remain disabled until this independent
// backend and browser handoff have completed Preview acceptance.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

function allowShipmentEmulator(env=process.env){
 const local=value=>typeof value==='string'&&/^(127\.0\.0\.1|localhost):[0-9]+$/.test(value);
 return env.ENABLE_V2_SHIPMENT_AUTH_EMULATOR==='true'&&env.ENABLE_V2_RETURN_AUTH_EMULATOR==='true'
  &&env.FUNCTIONS_EMULATOR==='true'
  &&projectIdFromEnvironment(env)==='demo-yushin'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
function allowPreviewShipment(env=process.env){
 return env.ENABLE_PREVIEW_SHIPMENT==='true'&&projectIdFromEnvironment(env)==='preview-20135'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
}
function shipmentBackendProject(env=process.env){
 if(allowShipmentEmulator(env))return 'demo-yushin';
 if(allowPreviewShipment(env))return 'preview-20135';
 return '';
}
module.exports={allowShipmentEmulator,allowPreviewShipment,shipmentBackendProject};
