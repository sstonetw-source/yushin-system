'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {allowOrderLifecycleEmulator,allowPreviewOrderLifecycle,orderLifecycleBackendProject}=require('../functions/order-lifecycle-preview-gate');
const {createOrderLifecycleCallable}=require('../functions/order-lifecycle-preview-callable');
const {commitOrderLocationLifecycle}=require('../functions/single-item-location-lifecycle-service');

const emulator=()=>({ENABLE_V2_LIFECYCLE_AUTH_EMULATOR:'true',ENABLE_V2_RETURN_AUTH_EMULATOR:'true',
 FUNCTIONS_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',
 FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
const preview=()=>({ENABLE_PREVIEW_ORDER_LIFECYCLE:'true',GCLOUD_PROJECT:'preview-20135'});
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}

test('whole-order lifecycle has an independent default-closed Preview/Emulator gate',()=>{
 assert.equal(allowOrderLifecycleEmulator(emulator()),true);
 assert.equal(orderLifecycleBackendProject(emulator()),'demo-yushin');
 assert.equal(allowPreviewOrderLifecycle(preview()),true);
 assert.equal(orderLifecycleBackendProject(preview()),'preview-20135');
 for(const change of [{ENABLE_PREVIEW_ORDER_LIFECYCLE:'false'},{GCLOUD_PROJECT:'yu-shing-company'},
  {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(orderLifecycleBackendProject({...preview(),...change}),'');
 for(const change of [{ENABLE_V2_LIFECYCLE_AUTH_EMULATOR:'false'},{ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},
  {GCLOUD_PROJECT:'preview-20135'},{FIRESTORE_EMULATOR_HOST:'remote.example:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:''},{FUNCTIONS_EMULATOR:'false'}])
  assert.equal(orderLifecycleBackendProject({...emulator(),...change}),'');
 assert.equal(orderLifecycleBackendProject({...preview(),GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_ORDER_LIFECYCLE:'true'}),'');
 assert.equal(orderLifecycleBackendProject({}),'');
});

test('direct internal Service rejects non-Preview and wrong-project calls before any transaction',async()=>{
 const malformed={actorUid:'forged'};
 await assert.rejects(commitOrderLocationLifecycle({projectId:'demo-yushin'},'real',malformed,
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),e=>e.code==='invalid-argument');
 for(const [projectId,env] of [['demo-yushin',{}],['demo-yushin',{FIRESTORE_EMULATOR_HOST:'remote:8080'}],
  ['preview-20135',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}],
  ['yu-shing-company',{...preview(),ENABLE_PRODUCTION_ORDER_LIFECYCLE:'true'}]])
  await assert.rejects(commitOrderLocationLifecycle({projectId},'real',malformed,env),e=>e.code==='failed-precondition');
});

test('callable rejects closed gate, absent Auth, wrong project and forged actor before writes',async()=>{
 let dbReads=0,writes=0;
 const handler=(env,project='preview-20135')=>createOrderLifecycleCallable({onCall:(_opts,fn)=>fn,HttpsError,env,
  getDatabase:()=>{dbReads++;return {projectId:project,runTransaction:()=>{writes++;}};}});
 await assert.rejects(handler({})({auth:{uid:'real'},data:{}}),e=>e.code==='failed-precondition');
 await assert.rejects(handler(preview())({data:{actorUid:'forged'}}),e=>e.code==='unauthenticated');
 assert.equal(dbReads,0);
 await assert.rejects(handler(preview(),'yu-shing-company')({auth:{uid:'real'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(dbReads,1);
 await assert.rejects(handler(preview())({auth:{uid:'real'},data:{actorUid:'forged'}}),e=>e.code==='invalid-argument');
 assert.equal(dbReads,2);assert.equal(writes,0);
});

test('unknown order lifecycle Service errors are sanitized',async()=>{
 const data={orderId:'O',itemIds:['I'],warehouseIds:['A','B'],nextStatus:'cancelled',
  operationId:'lifecycle_123456789',syncAttemptId:'sync-1',date:'2026-10-28',reason:''};
 const handler=createOrderLifecycleCallable({onCall:(_opts,fn)=>fn,HttpsError,env:preview(),
  getDatabase:()=>({projectId:'preview-20135',collection:name=>({doc:id=>({path:name+'/'+id})}),
   runTransaction:()=>{throw Error('private order data');}})});
 await assert.rejects(handler({auth:{uid:'real'},data}),e=>e.code==='internal'
  &&e.message==='取消／恢復交易結果無法確認，請保留原操作識別碼');
});

test('production index only exports independently gated lifecycle backend, not old test adapter',()=>{
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.setV2OrderLifecycle\s*=\s*createOrderLifecycleCallable/);
 assert.doesNotMatch(index,/v2-return-callable-adapter/);
 const fixture=fs.readFileSync('tests/fixtures/v2-return-auth-functions.cjs','utf8');
 assert.match(fixture,/setV2OrderLifecycle:service\.setV2OrderLifecycle/);
 const runner=fs.readFileSync('tools/run-v2-return-auth-emulator.cjs','utf8');
 assert.match(runner,/ENABLE_V2_LIFECYCLE_AUTH_EMULATOR:'true'/);
});
