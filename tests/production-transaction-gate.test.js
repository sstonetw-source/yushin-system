'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowProductionTransaction}=require('../functions/production-transaction-gate');
const {dispatchBackendProject}=require('../functions/dispatch-preparation-gate');
const {shipmentBackendProject}=require('../functions/warehouse-shipment-gate');
for(const [kind,flag,project] of [
 ['DISPATCH','ENABLE_PRODUCTION_DISPATCH_BACKEND',dispatchBackendProject],
 ['SHIPMENT','ENABLE_PRODUCTION_SHIPMENT_BACKEND',shipmentBackendProject]
])test(kind+' production flag stays independent and fails closed on project or emulator mismatch',()=>{
 const env={GCLOUD_PROJECT:'yu-shing-company',[flag]:'true'};
 assert.equal(allowProductionTransaction(kind,env),true);assert.equal(project(env),'yu-shing-company');
 for(const patch of [{[flag]:'false'},{[flag]:true},{GCLOUD_PROJECT:'preview-20135'},
  {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'},{GOOGLE_CLOUD_PROJECT:'wrong-project'},{GCP_PROJECT:'wrong-project'},
  {FIREBASE_CONFIG:'{broken'},{FIREBASE_CONFIG:JSON.stringify({projectId:'wrong-project'})}]){
  assert.equal(allowProductionTransaction(kind,{...env,...patch}),false);
  assert.equal(project({...env,...patch}),'');
 }
 assert.equal(project({GCLOUD_PROJECT:'yu-shing-company'}),'');
 const other=kind==='DISPATCH'?'SHIPMENT':'DISPATCH';
 assert.equal(allowProductionTransaction(other,env),false);
});
test('unknown production feature cannot borrow an unrelated flag',()=>{
 assert.equal(allowProductionTransaction('RECEIVING',{GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_DISPATCH_BACKEND:'true'}),false);
});
