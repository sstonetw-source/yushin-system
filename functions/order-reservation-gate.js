'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

// A new-order-only pilot, independently default-off. Never enable this
// backend replacement in the production Firebase project via an env typo.
function allowOrderReservationBackend(env=process.env){
  if(env.ENABLE_ORDER_RESERVATION_BACKEND!=='true')return false;
  const project=projectIdFromEnvironment(env);
  if(project==='preview-20135')return !env.FUNCTIONS_EMULATOR
    &&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST;
  const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
  return project==='demo-yushin'&&env.FUNCTIONS_EMULATOR==='true'
    &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST);
}
module.exports={allowOrderReservationBackend};
