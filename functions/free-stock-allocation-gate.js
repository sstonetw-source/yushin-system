'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
function previewFreeStockAllocationProject(env=process.env){
 return projectIdFromEnvironment(env)==='preview-20135'&&env.ENABLE_PREVIEW_FREE_STOCK_ALLOCATION==='true'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST?'preview-20135':'';
}
function allowFreeStockAllocationDatabase(db,env=process.env){
 // Preserve the existing direct Admin Emulator harness; Preview requires its
 // own reviewed flag and refuses all mixed Emulator connections.
 return db.projectId==='demo-yushin'&&!!env.FIRESTORE_EMULATOR_HOST
  ||!!previewFreeStockAllocationProject(env)&&db.projectId===previewFreeStockAllocationProject(env);
}
module.exports={previewFreeStockAllocationProject,allowFreeStockAllocationDatabase};
