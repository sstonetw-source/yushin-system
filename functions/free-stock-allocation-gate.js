'use strict';
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {allowProductionTransaction}=require('./production-transaction-gate');
function previewFreeStockAllocationProject(env=process.env){
 return projectIdFromEnvironment(env)==='preview-20135'&&env.ENABLE_PREVIEW_FREE_STOCK_ALLOCATION==='true'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST?'preview-20135':'';
}
function allowFreeStockAllocationDatabase(db,env=process.env,purpose=''){
 // Preserve the existing direct Admin Emulator harness; Preview requires its
 // own reviewed flag and refuses all mixed Emulator connections.
 return db.projectId==='demo-yushin'&&!!env.FIRESTORE_EMULATOR_HOST
  ||!!previewFreeStockAllocationProject(env)&&db.projectId===previewFreeStockAllocationProject(env)
  // A production main-transfer flag must NEVER open the generic cancellation,
  // receipt or return allocation entrypoints. Only the trusted main-transfer
  // callable can pass this server-side purpose through its verified source.
  ||purpose==='MAIN_TRANSFER'&&db.projectId==='yu-shing-company'
   &&allowProductionTransaction('MAIN_TRANSFER_ALLOCATION',env);
}
module.exports={previewFreeStockAllocationProject,allowFreeStockAllocationDatabase};
