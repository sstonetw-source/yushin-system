'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const flags=Object.freeze({
 DISPATCH:'ENABLE_PRODUCTION_DISPATCH_BACKEND',
 SHIPMENT:'ENABLE_PRODUCTION_SHIPMENT_BACKEND',
 ORDER_LIFECYCLE:'ENABLE_PRODUCTION_ORDER_LIFECYCLE_BACKEND',
 DELIVERY_CONFIRMATION:'ENABLE_PRODUCTION_DELIVERY_CONFIRMATION_BACKEND',
 DELIVERY_REVERSAL:'ENABLE_PRODUCTION_DELIVERY_REVERSAL_BACKEND',
 CUSTOMER_RETURN:'ENABLE_PRODUCTION_CUSTOMER_RETURN_BACKEND',
 CUSTOMER_RETURN_REQUEST:'ENABLE_PRODUCTION_CUSTOMER_RETURN_REQUEST_BACKEND'
});
function allowProductionTransaction(kind,env=process.env){
 const flag=flags[kind];
 const ids=[env.GCLOUD_PROJECT,env.GCP_PROJECT,env.GOOGLE_CLOUD_PROJECT].filter(value=>value!==undefined&&value!=='');
 if(env.FIREBASE_CONFIG){
  try{const config=JSON.parse(env.FIREBASE_CONFIG);if(!config.projectId)return false;ids.push(config.projectId);}
  catch{return false;}
 }
 if(ids.some(id=>id!=='yu-shing-company'))return false;
 return !!flag&&env[flag]==='true'
  &&projectIdFromEnvironment(env)==='yu-shing-company'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
}
module.exports={allowProductionTransaction};
