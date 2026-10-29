'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');

// A new-order-only pilot, independently default-off. Never enable this
// backend replacement in the production Firebase project via an env typo.
function allowOrderReservationBackend(env=process.env){
  if(env.ENABLE_ORDER_RESERVATION_BACKEND!=='true')return false;
  const project=projectIdFromEnvironment(env);
  return project==='preview-20135'||(project==='demo-yushin'
    &&!!env.FIRESTORE_EMULATOR_HOST&&!!env.FIREBASE_AUTH_EMULATOR_HOST);
}
module.exports={allowOrderReservationBackend};
