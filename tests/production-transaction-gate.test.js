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
const {orderTransferProject}=require('../functions/order-transfer-physical-service');
test('order transfer stays backend-disabled while the production browser writer is retired',()=>{
 const vm=require('node:vm'),fs=require('node:fs');
 const scope={location:{origin:'https://sstonetw-source.github.io',hostname:'sstonetw-source.github.io',pathname:'/yushin-system/'},
  YUSHIN_PRODUCTION_ORDER_TRANSFER_HANDOFF_BACKEND:true,YUSHIN_PRODUCTION_ORDER_TRANSFER_HANDOFF_LEGACY_BLOCKED:true};
 vm.runInNewContext(fs.readFileSync('transaction-rollout-config.js','utf8'),scope);
 for(const action of ['DISPATCH','HANDOFF','RECEIVE']){
  assert.equal(scope['YUSHIN_PRODUCTION_ORDER_TRANSFER_'+action+'_BACKEND'],false);
  assert.equal(scope['YUSHIN_PRODUCTION_ORDER_TRANSFER_'+action+'_LEGACY_BLOCKED'],true);
  assert.equal(orderTransferProject(action,{GCLOUD_PROJECT:'yu-shing-company'}),'');
 }
});
test('separately approved order-transfer browser gates require both flags and the exact GitHub Pages origin',()=>{
 const vm=require('node:vm'),fs=require('node:fs');
 const source=fs.readFileSync('src/infrastructure/production-transaction.js','utf8');
 for(const action of ['DISPATCH','HANDOFF','RECEIVE']){
  const kind='ORDER_TRANSFER_'+action,scope={APP_ENVIRONMENT:'production',
   location:{origin:'https://sstonetw-source.github.io',pathname:'/yushin-system/'},
   ['YUSHIN_PRODUCTION_'+kind+'_BACKEND']:true,
   ['YUSHIN_PRODUCTION_'+kind+'_LEGACY_BLOCKED']:true};
  vm.runInNewContext(source,scope);
  assert.equal(scope.productionTransactionBackendRequired(kind),true);
  assert.equal(scope.productionTransactionBackendEnabled(kind),true);
  scope['YUSHIN_PRODUCTION_'+kind+'_BACKEND']=false;
  assert.equal(scope.productionTransactionBackendEnabled(kind),false);
  scope['YUSHIN_PRODUCTION_'+kind+'_BACKEND']=true;
  scope.location.origin='https://unapproved.example';
  assert.equal(scope.productionTransactionBackendEnabled(kind),false);
 }
});
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
test('cancelled supplier purchase rejects old production writes while its backend is default-off',()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const scope={location:{origin:'https://sstonetw-source.github.io',pathname:'/yushin-system/'},
  YUSHIN_PRODUCTION_CANCELLED_PURCHASE_BACKEND:true,YUSHIN_PRODUCTION_CANCELLED_PURCHASE_LEGACY_BLOCKED:true};
 vm.runInNewContext(fs.readFileSync('transaction-rollout-config.js','utf8'),scope);
 assert.equal(scope.YUSHIN_PRODUCTION_CANCELLED_PURCHASE_BACKEND,false);
 assert.equal(scope.YUSHIN_PRODUCTION_CANCELLED_PURCHASE_LEGACY_BLOCKED,true);
 assert.equal(allowProductionTransaction('CANCELLED_PURCHASE',{GCLOUD_PROJECT:'yu-shing-company'}),false);
});
test('main transfer lanes require a backend while remaining default-off in production',()=>{
 const fs=require('node:fs'),vm=require('node:vm');
 const source=fs.readFileSync('src/infrastructure/production-transaction.js','utf8');
 const kinds=['MAIN_TRANSFER_REQUEST','MAIN_TRANSFER_DISPATCH','MAIN_TRANSFER_RECEIPT','MAIN_TRANSFER_ALLOCATION'];
 const scope={APP_ENVIRONMENT:'production',location:{origin:'https://sstonetw-source.github.io',pathname:'/yushin-system/'}};
 for(const kind of kinds){scope['YUSHIN_PRODUCTION_'+kind+'_BACKEND']=true;scope['YUSHIN_PRODUCTION_'+kind+'_LEGACY_BLOCKED']=true;}
 vm.runInNewContext(fs.readFileSync('transaction-rollout-config.js','utf8'),scope);
 vm.runInNewContext(source,scope);
 for(const kind of kinds){
  assert.equal(scope.productionTransactionBackendRequired(kind),true);
  assert.equal(scope.productionTransactionBackendEnabled(kind),false);
  assert.equal(allowProductionTransaction(kind,{GCLOUD_PROJECT:'yu-shing-company'}),false);
 }
 for(const kind of kinds){
  scope['YUSHIN_PRODUCTION_'+kind+'_BACKEND']=true;
  scope['YUSHIN_PRODUCTION_'+kind+'_LEGACY_BLOCKED']=true;
  assert.equal(scope.productionTransactionBackendEnabled(kind),true);
  const env={GCLOUD_PROJECT:'yu-shing-company',['ENABLE_PRODUCTION_'+kind+'_BACKEND']:'true'};
  assert.equal(allowProductionTransaction(kind,env),true);
  for(const patch of [{FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},
   {GOOGLE_CLOUD_PROJECT:'different'},{GCP_PROJECT:'different'},{GCLOUD_PROJECT:'preview-20135'}])
   assert.equal(allowProductionTransaction(kind,{...env,...patch}),false);
  for(const other of kinds.filter(other=>other!==kind))assert.equal(allowProductionTransaction(other,env),false);
  scope['YUSHIN_PRODUCTION_'+kind+'_BACKEND']=false;
  assert.equal(scope.productionTransactionBackendRequired(kind),true);
  assert.equal(scope.productionTransactionBackendEnabled(kind),false);
 }
});
