'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {previewFreeStockAllocationProject}=require('./free-stock-allocation-gate');
// Both the source entry and shared coordinator require independent gates.
function mainTransferAllocationProject(env=process.env){
 if(env.ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION==='true'&&previewFreeStockAllocationProject(env))return 'preview-20135';
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return projectIdFromEnvironment(env)==='demo-yushin'
  &&env.ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}
module.exports={mainTransferAllocationProject};
