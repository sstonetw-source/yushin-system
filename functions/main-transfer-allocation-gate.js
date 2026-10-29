'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
// The shared stock coordinator is not yet approved for Preview writes.
function mainTransferAllocationProject(env=process.env){
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return projectIdFromEnvironment(env)==='demo-yushin'
  &&env.ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}
module.exports={mainTransferAllocationProject};
