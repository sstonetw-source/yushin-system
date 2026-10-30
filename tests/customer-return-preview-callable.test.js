'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {customerReturnBackendProject,assertCustomerReturnDatabase}=require('../functions/customer-return-gate');
const {createCustomerReturnCallables}=require('../functions/customer-return-callable');
const {commitLocationReturn}=require('../functions/location-return-service');
const preview=()=>({ENABLE_PREVIEW_CUSTOMER_RETURN:'true',GCLOUD_PROJECT:'preview-20135'});
const emulator=()=>({ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
 FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
test('return Preview requires its independent flag, matching project and unmixed SDK environment',()=>{
 assert.equal(customerReturnBackendProject(preview()),'preview-20135');
 assert.equal(customerReturnBackendProject(emulator()),'demo-yushin');
 for(const patch of [{ENABLE_PREVIEW_CUSTOMER_RETURN:'false'},{GCLOUD_PROJECT:'yu-shing-company'},
  {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'}])
  assert.equal(customerReturnBackendProject({...preview(),...patch}),'');
 for(const patch of [{FUNCTIONS_EMULATOR:'false'},{FIREBASE_AUTH_EMULATOR_HOST:''},
  {FIRESTORE_EMULATOR_HOST:'remote:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'remote:9099'}])
  assert.equal(customerReturnBackendProject({...emulator(),...patch}),'');
 assert.throws(()=>assertCustomerReturnDatabase({projectId:'yu-shing-company'},preview()),/僅允許/);
 assert.throws(()=>assertCustomerReturnDatabase({projectId:'preview-20135'},{}),/僅允許/);
 assert.throws(()=>assertCustomerReturnDatabase({projectId:'demo-yushin'},{FIRESTORE_EMULATOR_HOST:'remote:8080'}),/僅允許/);
});
test('trace and receipt Callables reject closed gates, missing Auth and wrong actual databases before reads',async()=>{
 let databases=0,transactions=0;
 const build=(env,projectId)=>createCustomerReturnCallables({onCall:(_opts,fn)=>fn,HttpsError,env,
  getDatabase:()=>{databases++;return {projectId,runTransaction:()=>{transactions++;}};}});
 for(const handler of Object.values(build({},'preview-20135')))
  await assert.rejects(handler({auth:{uid:'U'},data:{}}),e=>e.code==='failed-precondition');
 for(const handler of Object.values(build(preview(),'preview-20135')))
  await assert.rejects(handler({data:{uid:'forged'}}),e=>e.code==='unauthenticated');
 assert.equal(databases,0);
 for(const wrong of ['yu-shing-company','demo-yushin',undefined])
  for(const handler of Object.values(build(preview(),wrong)))
   await assert.rejects(handler({auth:{uid:'U'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(databases,6);assert.equal(transactions,0);
});
test('Preview physical receipt only accepts linked CLOSE returns and never broadens replacement semantics',async()=>{
 const intent={orderId:'O',itemId:'I',shipmentId:'shipment_12345',syncAttemptId:'sync_12345',
  selections:[{lotId:'L',qty:1}],operationId:'return_123456',warehouseId:'A',date:'2026-10-29',reason:'客戶退回',
  condition:'RESTOCKABLE',settlement:'CLOSE',requestId:'Q'};
 const unlinked={...intent};delete unlinked.requestId;
 for(const data of [unlinked,{...unlinked,settlement:'REPLACE'}])
  await assert.rejects(commitLocationReturn({projectId:'preview-20135'},'U',data,preview()),
   e=>e.code==='failed-precondition'&&/原申請/.test(e.message));
});
test('canonical Functions exports and Auth harness share the existing return writer',()=>{
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.receiveV2CustomerReturn=customerReturnCallables\.receiveV2CustomerReturn/);
 assert.match(index,/exports\.previewV2CustomerReturn=customerReturnCallables\.previewV2CustomerReturn/);
 const harness=fs.readFileSync('tests/fixtures/v2-return-auth-functions.cjs','utf8');
 assert.match(harness,/receiveV2CustomerReturn:service\.receiveV2CustomerReturn/);
});
