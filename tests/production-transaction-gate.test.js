'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowProductionTransaction}=require('../functions/production-transaction-gate');
const {dispatchBackendProject}=require('../functions/dispatch-preparation-gate');
const {shipmentBackendProject}=require('../functions/warehouse-shipment-gate');
const {deliveryConfirmationBackendProject}=require('../functions/delivery-confirmation-gate');
const {deliveryReversalBackendProject}=require('../functions/delivery-reversal-gate');
const {customerReturnBackendProject}=require('../functions/customer-return-gate');
const {customerReturnRequestBackendProject}=require('../functions/customer-return-request-gate');
const {orderLifecycleBackendProject}=require('../functions/order-lifecycle-preview-gate');
test('fresh warehouse and sales pages load Functions before any transaction UI executes',()=>{
 const html=require('node:fs').readFileSync('index.html','utf8');
 const sdk=html.indexOf('https://www.gstatic.com/firebasejs/10.8.0/firebase-functions-compat.js');
 assert.ok(sdk>=0);assert.ok(sdk<html.indexOf('<script src="app.js?'));
});
for(const [kind,flag,project] of [
 ['DISPATCH','ENABLE_PRODUCTION_DISPATCH_BACKEND',dispatchBackendProject],
 ['SHIPMENT','ENABLE_PRODUCTION_SHIPMENT_BACKEND',shipmentBackendProject],
 ['ORDER_LIFECYCLE','ENABLE_PRODUCTION_ORDER_LIFECYCLE_BACKEND',orderLifecycleBackendProject],
 ['DELIVERY_CONFIRMATION','ENABLE_PRODUCTION_DELIVERY_CONFIRMATION_BACKEND',deliveryConfirmationBackendProject],
 ['DELIVERY_REVERSAL','ENABLE_PRODUCTION_DELIVERY_REVERSAL_BACKEND',deliveryReversalBackendProject],
 ['CUSTOMER_RETURN','ENABLE_PRODUCTION_CUSTOMER_RETURN_BACKEND',customerReturnBackendProject],
 ['CUSTOMER_RETURN_REQUEST','ENABLE_PRODUCTION_CUSTOMER_RETURN_REQUEST_BACKEND',customerReturnRequestBackendProject]
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
