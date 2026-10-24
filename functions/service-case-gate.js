'use strict';
// No Preview or production enablement: real Auth + Callable transport is still
// under isolated demo-yushin Emulator acceptance. Never trust a copied flag.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const localHost=value=>/^(?:127\.0\.0\.1|localhost):[0-9]+$/.test(String(value||''));
function allowServiceCaseEmulator(env=process.env){
  return env.ENABLE_SERVICE_CASE_EMULATOR==='true'
    && projectIdFromEnvironment(env)==='demo-yushin'
    && localHost(env.FIRESTORE_EMULATOR_HOST)
    && localHost(env.FIREBASE_AUTH_EMULATOR_HOST);
}
module.exports={allowServiceCaseEmulator};
