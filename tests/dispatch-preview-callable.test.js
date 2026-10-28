'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {allowDispatchEmulator,allowPreviewDispatch,dispatchBackendProject}=require('../functions/dispatch-preparation-gate');
const {createDispatchPreparationCallable}=require('../functions/dispatch-preparation-callable');
const {commitLocationDispatchPreparation}=require('../functions/location-dispatch-service');
const emulator=()=>({ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
const preview=()=>({ENABLE_PREVIEW_DISPATCH:'true',GCLOUD_PROJECT:'preview-20135'});
class HttpsError extends Error{constructor(code,message,details){super(message);this.code=code;this.details=details;}}

test('dispatch has independent, default-closed Emulator and Preview gates, never production',()=>{
 assert.equal(allowDispatchEmulator(emulator()),true);
 assert.equal(dispatchBackendProject(emulator()),'demo-yushin');
 assert.equal(allowPreviewDispatch(preview()),true);
 assert.equal(dispatchBackendProject(preview()),'preview-20135');
 for(const change of [{ENABLE_PREVIEW_DISPATCH:'false'},{GCLOUD_PROJECT:'yu-shing-company'},
  {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(dispatchBackendProject({...preview(),...change}),'');
 for(const change of [{ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},{GCLOUD_PROJECT:'preview-20135'},
  {FIRESTORE_EMULATOR_HOST:'remote.example:8080'},{FIREBASE_AUTH_EMULATOR_HOST:''},
  {FUNCTIONS_EMULATOR:'false'}])assert.equal(dispatchBackendProject({...emulator(),...change}),'');
 assert.equal(dispatchBackendProject({...preview(),GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_DISPATCH:'true'}),'');
 assert.equal(dispatchBackendProject({}),'');
});

test('direct demo Service harness remains isolated while Preview and production cannot bypass the Callable gate',async()=>{
 const db=projectId=>({projectId});
 const malformed={actorUid:'forged'};
 await assert.rejects(commitLocationDispatchPreparation(db('demo-yushin'),'real',malformed,
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),error=>error.code==='invalid-argument');
 for(const [projectId,env] of [['demo-yushin',{}],['demo-yushin',{FIRESTORE_EMULATOR_HOST:'remote.example:8080'}],
  ['preview-20135',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}],
  ['yu-shing-company',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',ENABLE_PREVIEW_DISPATCH:'true'}]])
  await assert.rejects(commitLocationDispatchPreparation(db(projectId),'real',malformed,env),
   error=>error.code==='failed-precondition');
});

test('disabled gate, wrong project, missing Auth and forged UID never enter transaction',async()=>{
 let reads=0,writes=0;
 const handler=(env,project='preview-20135')=>createDispatchPreparationCallable({onCall:(_settings,fn)=>fn,
  HttpsError,getDatabase:()=>{reads++;return {projectId:project,runTransaction:()=>{writes++;}};},env});
 await assert.rejects(handler({})({auth:{uid:'real'},data:{}}),e=>e.code==='failed-precondition');
 await assert.rejects(handler(preview())({data:{actorUid:'forged'}}),e=>e.code==='unauthenticated');
 assert.equal(reads,0);
 await assert.rejects(handler(preview(),'yu-shing-company')({auth:{uid:'real'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(reads,1);
 await assert.rejects(handler(preview())({auth:{uid:'real'},data:{actorUid:'forged'}}),e=>e.code==='invalid-argument');
 assert.equal(reads,2);assert.equal(writes,0);
});

test('stale dispatch baseline preserves typed reason and unknown errors are sanitized',async()=>{
 const data={orderId:'O',itemId:'I',quantity:1,operationId:'dispatch-ui-123456789ABCDE',syncAttemptId:'sync-1',expectedPreparedQty:0};
 let reason='dispatch-stale';
 const handler=createDispatchPreparationCallable({onCall:(_settings,fn)=>fn,HttpsError,env:preview(),
  getDatabase:()=>({projectId:'preview-20135',collection:name=>({doc:id=>({path:name+'/'+id})}),runTransaction:()=>{const error=new Error('stale');
   if(reason){error.code='failed-precondition';error.reason=reason;}throw error;}})});
 await assert.rejects(handler({auth:{uid:'real'},data}),e=>e.code==='failed-precondition'&&e.details?.reason==='dispatch-stale');
 reason='';
 await assert.rejects(handler({auth:{uid:'real'},data}),e=>e.code==='internal'&&e.message==='出貨準備交易失敗');
});

test('production index exposes only an independently gated dispatch Callable, not other return test endpoints',()=>{
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.prepareV2OrderDispatch\s*=\s*createDispatchPreparationCallable/);
 assert.doesNotMatch(index,/v2-return-callable-adapter|shipV2WarehouseItem|confirmV2ShipmentDelivery/);
});
