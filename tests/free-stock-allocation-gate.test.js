'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {previewFreeStockAllocationProject,allowFreeStockAllocationDatabase}=require('../functions/free-stock-allocation-gate');
const {mainTransferAllocationProject}=require('../functions/main-transfer-allocation-gate');
const env={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_FREE_STOCK_ALLOCATION:'true',ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION:'true'};
test('Preview allocation requires both independent flags and exact database identity',()=>{
 assert.equal(mainTransferAllocationProject(env),'preview-20135');assert.equal(allowFreeStockAllocationDatabase({projectId:'preview-20135'},env),true);
 assert.equal(mainTransferAllocationProject({...env,ENABLE_PREVIEW_FREE_STOCK_ALLOCATION:'false'}),'');assert.equal(mainTransferAllocationProject({...env,ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION:'false'}),'');
 assert.equal(allowFreeStockAllocationDatabase({projectId:'yu-shing-company'},env),false);
 for(const patch of [{GCLOUD_PROJECT:'yu-shing-company'},{FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'}]){
  assert.equal(previewFreeStockAllocationProject({...env,...patch}),'');assert.equal(mainTransferAllocationProject({...env,...patch}),'');
 }
 assert.equal(mainTransferAllocationProject({FIREBASE_CONFIG:JSON.stringify({projectId:'preview-20135'}),ENABLE_PREVIEW_FREE_STOCK_ALLOCATION:'true',ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION:'true'}),'preview-20135');
});
