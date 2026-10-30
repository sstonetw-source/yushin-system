'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {allowDeliveryReversalEmulator,allowPreviewDeliveryReversal,deliveryReversalBackendProject}=require('../functions/delivery-reversal-gate');
const {createDeliveryReversalCallable}=require('../functions/delivery-reversal-callable');
const {reverseShipmentDelivery}=require('../functions/shipment-delivery-service');
const emulator=()=>({ENABLE_V2_DELIVERY_AUTH_EMULATOR:'true',ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
const preview=()=>({ENABLE_PREVIEW_DELIVERY_REVERSAL:'true',GCLOUD_PROJECT:'preview-20135'});
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}

test('reversal has its own disabled-by-default Emulator/Preview gate and no production route',()=>{
 assert.equal(allowDeliveryReversalEmulator(emulator()),true);
 assert.equal(allowPreviewDeliveryReversal(preview()),true);
 assert.equal(deliveryReversalBackendProject(emulator()),'demo-yushin');
 assert.equal(deliveryReversalBackendProject(preview()),'preview-20135');
 assert.equal(deliveryReversalBackendProject({...preview(),ENABLE_PREVIEW_DELIVERY_REVERSAL:'false',ENABLE_PREVIEW_DELIVERY_CONFIRMATION:'true'}),'');
 for(const patch of [{GCLOUD_PROJECT:'yu-shing-company'},{FUNCTIONS_EMULATOR:'true'},
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(deliveryReversalBackendProject({...preview(),...patch}),'');
 for(const patch of [{ENABLE_V2_DELIVERY_AUTH_EMULATOR:'false'},{ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},
  {FUNCTIONS_EMULATOR:'false'},{GCLOUD_PROJECT:'preview-20135'},
  {FIRESTORE_EMULATOR_HOST:'remote.example:8080'},{FIREBASE_AUTH_EMULATOR_HOST:''}])
  assert.equal(deliveryReversalBackendProject({...emulator(),...patch}),'');
 assert.equal(deliveryReversalBackendProject({ENABLE_PREVIEW_DELIVERY_REVERSAL:'true',GCLOUD_PROJECT:'yu-shing-company'}),'');
 assert.equal(deliveryReversalBackendProject({}),'');
});

test('direct reversal Service checks project and never permits production even with forged flags',async()=>{
 const malformed={actorUid:'forged'};
 await assert.rejects(reverseShipmentDelivery({projectId:'demo-yushin'},'actor',malformed,
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),error=>error.code==='invalid-argument');
 for(const [projectId,env] of [['demo-yushin',{}],['preview-20135',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}],
  ['yu-shing-company',{...preview(),GCLOUD_PROJECT:'yu-shing-company'}]])
  await assert.rejects(reverseShipmentDelivery({projectId},'actor',malformed,env),error=>error.code==='failed-precondition');
});

test('disabled reversal, missing Auth, wrong Firestore project never begin a transaction',async()=>{
 let reads=0,transactions=0;
 const handler=(env,projectId='preview-20135')=>createDeliveryReversalCallable({onCall:(_settings,fn)=>fn,
  HttpsError,getDatabase:()=>{reads++;return {projectId,runTransaction:()=>{transactions++;}};},env});
 await assert.rejects(handler({})({auth:{uid:'actor'},data:{}}),error=>error.code==='failed-precondition');
 await assert.rejects(handler(preview())({data:{actorUid:'forged'}}),error=>error.code==='unauthenticated');
 assert.equal(reads,0);
 await assert.rejects(handler(preview(),'yu-shing-company')({auth:{uid:'actor'},data:{}}),error=>error.code==='failed-precondition');
 assert.equal(reads,1);
 await assert.rejects(handler(preview())({auth:{uid:'actor'},data:{actorUid:'forged'}}),error=>error.code==='invalid-argument');
 assert.equal(reads,2);assert.equal(transactions,0);
});

test('reversal preserves known Service error codes and sanitizes unexpected failures',async()=>{
 const data={orderId:'O',itemId:'I',deliveryRecordId:'D',operationId:'reversal_preview_20261028_abcdef',
  syncAttemptId:'sync-1',date:'2026-10-28',reason:'更正誤登'};
 let known=true;
 const handler=createDeliveryReversalCallable({onCall:(_settings,fn)=>fn,HttpsError,env:preview(),
  getDatabase:()=>({projectId:'preview-20135',runTransaction:()=>{
   const error=new Error('return source changed');if(known)error.code='failed-precondition';throw error;
  }})});
 await assert.rejects(handler({auth:{uid:'actor'},data}),error=>error.code==='failed-precondition'&&error.message==='return source changed');
 known=false;
 await assert.rejects(handler({auth:{uid:'actor'},data}),error=>error.code==='internal'&&error.message==='送達撤銷交易失敗');
});

test('production index exports only independently gated reversal, no return test adapter',()=>{
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.reverseV2ShipmentDelivery\s*=\s*createDeliveryReversalCallable/);
 assert.doesNotMatch(index,/v2-return-callable-adapter|v2-return-auth-functions/);
});
