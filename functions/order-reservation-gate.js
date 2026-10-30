'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

// New-order-only replacement. Production needs TWO explicit server flags,
// and its client rollout flag is separately default-closed in the shipped asset.
function allowOrderReservationBackend(env=process.env){
  if(env.ENABLE_ORDER_RESERVATION_BACKEND!=='true')return false;
  const project=projectIdFromEnvironment(env);
  if(project==='yu-shing-company')return env.ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND==='true'
    &&env.FUNCTIONS_EMULATOR!=='true'&&!env.FIRESTORE_EMULATOR_HOST
    &&!env.FIREBASE_AUTH_EMULATOR_HOST;
  if(project==='preview-20135')return !env.FUNCTIONS_EMULATOR
    &&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
  const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
  return project==='demo-yushin'&&env.FUNCTIONS_EMULATOR==='true'
    &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
module.exports={allowOrderReservationBackend};
