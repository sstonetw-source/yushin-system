'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {allowProductionTransaction}=require('./production-transaction-gate');
const localHost=value=>/^(?:127\.0\.0\.1|localhost):[0-9]+$/.test(String(value||''));
function allowServiceCaseEmulator(env=process.env){
  return env.ENABLE_SERVICE_CASE_EMULATOR==='true'
    && projectIdFromEnvironment(env)==='demo-yushin'
    && localHost(env.FIRESTORE_EMULATOR_HOST)
    && localHost(env.FIREBASE_AUTH_EMULATOR_HOST);
}
function serviceCaseBackendProject(env=process.env){
  if(allowServiceCaseEmulator(env))return 'demo-yushin';
  if(allowProductionTransaction('SERVICE_CASE',env))return 'yu-shing-company';
  return '';
}
module.exports={allowServiceCaseEmulator,serviceCaseBackendProject};
