'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
function customerReturnRequestBackendProject(env=process.env){
 const project=projectIdFromEnvironment(env);
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 if(project==='demo-yushin'&&env.ENABLE_V2_RETURN_REQUEST_AUTH_EMULATOR==='true'
  &&env.FUNCTIONS_EMULATOR==='true'&&local(env.FIRESTORE_EMULATOR_HOST)
  &&local(env.FIREBASE_AUTH_EMULATOR_HOST))return project;
 if(project==='preview-20135'&&env.ENABLE_PREVIEW_CUSTOMER_RETURN_REQUEST==='true'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST)return project;
 return '';
}
module.exports={customerReturnRequestBackendProject};
