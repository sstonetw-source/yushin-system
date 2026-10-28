'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {allowDeliveryConfirmationEmulator,allowPreviewDeliveryConfirmation,deliveryConfirmationBackendProject}=require('../functions/delivery-confirmation-gate');
const {createDeliveryConfirmationCallable}=require('../functions/delivery-confirmation-callable');
const {commitShipmentDelivery}=require('../functions/shipment-delivery-service');
const emulator=()=>({ENABLE_V2_DELIVERY_AUTH_EMULATOR:'true',ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
const preview=()=>({ENABLE_PREVIEW_DELIVERY_CONFIRMATION:'true',GCLOUD_PROJECT:'preview-20135'});
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}

test('delivery confirmation requires an independent closed-by-default Emulator or Preview gate',()=>{
 assert.equal(allowDeliveryConfirmationEmulator(emulator()),true);
 assert.equal(allowPreviewDeliveryConfirmation(preview()),true);
 assert.equal(deliveryConfirmationBackendProject(emulator()),'demo-yushin');
 assert.equal(deliveryConfirmationBackendProject(preview()),'preview-20135');
 for(const override of [{ENABLE_PREVIEW_DELIVERY_CONFIRMATION:'false'},{GCLOUD_PROJECT:'yu-shing-company'},
  {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(deliveryConfirmationBackendProject({...preview(),...override}),'');
 for(const override of [{ENABLE_V2_DELIVERY_AUTH_EMULATOR:'false'},{ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},
  {GCLOUD_PROJECT:'preview-20135'},{FUNCTIONS_EMULATOR:'false'},
  {FIRESTORE_EMULATOR_HOST:'remote.example:8080'},{FIREBASE_AUTH_EMULATOR_HOST:''}])
  assert.equal(deliveryConfirmationBackendProject({...emulator(),...override}),'');
 assert.equal(deliveryConfirmationBackendProject({...preview(),GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_DELIVERY:'true'}),'');
 assert.equal(deliveryConfirmationBackendProject({}),'');
});

test('direct Service test harness stays local; Preview requires an authorized project',async()=>{
 const malformed={actorUid:'forged'};
 await assert.rejects(commitShipmentDelivery({projectId:'demo-yushin'},'actor',malformed,
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),error=>error.code==='invalid-argument');
 for(const [projectId,env] of [['demo-yushin',{}],['demo-yushin',{FIRESTORE_EMULATOR_HOST:'remote.example:8080'}],
  ['preview-20135',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}],
  ['yu-shing-company',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',ENABLE_PREVIEW_DELIVERY_CONFIRMATION:'true'}]])
  await assert.rejects(commitShipmentDelivery({projectId},'actor',malformed,env),error=>error.code==='failed-precondition');
});

test('disabled confirmation, missing Auth and wrong project never begin transaction',async()=>{
 let reads=0,transactions=0;
 const handler=(env,projectId='preview-20135')=>createDeliveryConfirmationCallable({onCall:(_settings,fn)=>fn,
  HttpsError,getDatabase:()=>{reads++;return {projectId,runTransaction:()=>{transactions++;}};},env});
 await assert.rejects(handler({})({auth:{uid:'actor'},data:{}}),error=>error.code==='failed-precondition');
 await assert.rejects(handler(preview())({data:{actorUid:'forged'}}),error=>error.code==='unauthenticated');
 assert.equal(reads,0);
 await assert.rejects(handler(preview(),'yu-shing-company')({auth:{uid:'actor'},data:{}}),error=>error.code==='failed-precondition');
 assert.equal(reads,1);
 await assert.rejects(handler(preview())({auth:{uid:'actor'},data:{actorUid:'forged'}}),error=>error.code==='invalid-argument');
 assert.equal(reads,2);assert.equal(transactions,0);
});

test('confirmation service errors keep known reason codes and sanitize unknown errors',async()=>{
 const data={orderId:'O',itemId:'I',shipmentId:'S',quantity:1,date:'2026-10-28',operationId:'delivery_20261028_abcdefgh',syncAttemptId:'sync-1'};
 let known=true;
 const handler=createDeliveryConfirmationCallable({onCall:(_settings,fn)=>fn,HttpsError,env:preview(),
  getDatabase:()=>({projectId:'preview-20135',runTransaction:()=>{const error=new Error('source stale');
   if(known)error.code='failed-precondition';throw error;}})});
 await assert.rejects(handler({auth:{uid:'actor'},data}),error=>error.code==='failed-precondition'&&error.message==='source stale');
 known=false;
 await assert.rejects(handler({auth:{uid:'actor'},data}),error=>error.code==='internal'&&error.message==='送達確認交易失敗');
});

test('production entry keeps separate gated confirmation and reversal without legacy adapter',()=>{
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.confirmV2ShipmentDelivery\s*=\s*createDeliveryConfirmationCallable/);
 assert.match(index,/exports\.reverseV2ShipmentDelivery\s*=\s*createDeliveryReversalCallable/);
 assert.doesNotMatch(index,/v2-return-auth-functions|v2-return-callable-adapter/);
});
