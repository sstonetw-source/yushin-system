'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {allowV2ReturnAuthEmulator,createV2ReturnCallables}=require('../functions/v2-return-callable-adapter');
const env=()=>({ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
test('return Callable gate accepts only explicitly enabled local demo Auth Functions and Firestore',()=>{
 assert.equal(allowV2ReturnAuthEmulator(env()),true);
 for(const patch of [{ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},{FUNCTIONS_EMULATOR:'false'},
  {GCLOUD_PROJECT:'preview-20135'},{GCLOUD_PROJECT:'production'},
  {FIRESTORE_EMULATOR_HOST:''},{FIRESTORE_EMULATOR_HOST:'remote.example:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:''},{FIREBASE_AUTH_EMULATOR_HOST:'remote.example:9099'}])
  assert.equal(allowV2ReturnAuthEmulator({...env(),...patch}),false);
});
test('disabled gate missing authentication and wrong database never call a return Service',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0;const build=configuration=>createV2ReturnCallables({onCall:(_options,handler)=>handler,HttpsError,
  getDatabase:()=>{reads++;return {projectId:'production'};},env:configuration});
 for(const handler of Object.values(build({...env(),ENABLE_V2_RETURN_AUTH_EMULATOR:'false'})))
  await assert.rejects(handler({auth:{uid:'actor'},data:{}}),e=>e.code==='failed-precondition');
 for(const handler of Object.values(build(env()))){
  await assert.rejects(handler({data:{uid:'spoofed'}}),e=>e.code==='unauthenticated');
  assert.equal(reads,0);
 }
 await assert.rejects(build(env()).receiveV2CustomerReturn({auth:{uid:'actor'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(reads,1);
});
test('production Functions entry exports independently gated delivery operations, not isolated test adapters',()=>{
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.prepareV2OrderDispatch\s*=\s*createDispatchPreparationCallable/);
 assert.match(index,/exports\.shipV2WarehouseItem\s*=\s*createWarehouseShipmentCallable/);
 assert.match(index,/exports\.confirmV2ShipmentDelivery\s*=\s*createDeliveryConfirmationCallable/);
 assert.match(index,/exports\.reverseV2ShipmentDelivery\s*=\s*createDeliveryReversalCallable/);
 assert.doesNotMatch(index,/v2-return-callable|previewV2CustomerReturn|receiveV2CustomerReturn|setV2OrderLifecycle|listV2FreeStockRecovery|resumeV2FreeStockRecovery|v2-return-auth-functions/);
});
test('dispatch baseline is optional for old receipts and is bound to the canonical intent when supplied',()=>{
 const {normalizeLocationDispatchIntent}=require('../functions/location-dispatch-service');
 const input={orderId:'O',itemId:'I',operationId:'dispatch_test_123456',syncAttemptId:'sync',quantity:1};
 const old=normalizeLocationDispatchIntent(input);assert.equal(old.expectedPreparedQty,undefined);
 assert.equal(old.hash,require('node:crypto').createHash('sha256').update(JSON.stringify(input)).digest('hex'));
 assert.notEqual(normalizeLocationDispatchIntent({...input,expectedPreparedQty:0}).hash,old.hash);
 for(const expectedPreparedQty of [-1,0.5,'0',null])assert.throws(()=>normalizeLocationDispatchIntent({...input,expectedPreparedQty}));
});


test('shipment Callable is isolated and shares the existing Auth and Emulator gate',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let calls=0;
 const handlers=createV2ReturnCallables({onCall:(_settings,handler)=>handler,HttpsError,
  getDatabase:()=>{calls++;return {projectId:'demo-yushin'};},env:env()});
 assert.equal(typeof handlers.shipV2WarehouseItem,'function');
 await assert.rejects(handlers.shipV2WarehouseItem({data:{actorUid:'forged'}}),
  error=>error.code==='unauthenticated');
 assert.equal(calls,0);
 const bad=createV2ReturnCallables({onCall:(_settings,handler)=>handler,HttpsError,
  getDatabase:()=>{calls++;return {projectId:'production'};},env:env()});
 await assert.rejects(bad.shipV2WarehouseItem({auth:{uid:'signed-in'},data:{}}),
  error=>error.code==='failed-precondition');
 assert.equal(calls,1);
 const off=createV2ReturnCallables({onCall:(_settings,handler)=>handler,HttpsError,
  getDatabase:()=>{calls++;return {projectId:'demo-yushin'};},
  env:{...env(),ENABLE_V2_RETURN_AUTH_EMULATOR:'false'}});
 await assert.rejects(off.shipV2WarehouseItem({auth:{uid:'signed-in'},data:{}}),
  error=>error.code==='failed-precondition');
 assert.equal(calls,1);
});


test('delivery acknowledgement Callable uses the isolated auth gate and existing backend writer',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let calls=0;
 const create=(override={})=>createV2ReturnCallables({onCall:(_settings,fn)=>fn,HttpsError,
  getDatabase:()=>{calls++;return {projectId:'demo-yushin'};},env:{...env(),...override}});
 const handler=create().confirmV2ShipmentDelivery;
 assert.equal(typeof handler,'function');
 await assert.rejects(handler({data:{actorUid:'spoof'}}),error=>error.code==='unauthenticated');
 assert.equal(calls,0);
 await assert.rejects(create({FUNCTIONS_EMULATOR:'false'}).confirmV2ShipmentDelivery({auth:{uid:'A'},data:{}}),
  error=>error.code==='failed-precondition');
 assert.equal(calls,0);
 await assert.rejects(handler({auth:{uid:'A'},data:{actorUid:'spoof'}}),error=>error.code==='failed-precondition');
 assert.equal(calls,1);
});

test('delivery reversal Callable preserves the isolated environment and authenticated UID boundary',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0;
 const create=(configuration=env(),projectId='demo-yushin')=>createV2ReturnCallables({
  onCall:(_settings,handler)=>handler,HttpsError,getDatabase:()=>{reads++;return {projectId};},env:configuration});
 assert.equal(typeof create().reverseV2ShipmentDelivery,'function');
 await assert.rejects(create().reverseV2ShipmentDelivery({data:{actorUid:'forged'}}),e=>e.code==='unauthenticated');
 await assert.rejects(create({...env(),GCLOUD_PROJECT:'preview-20135'}).reverseV2ShipmentDelivery({auth:{uid:'A'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(reads,0);
 await assert.rejects(create(env(),'production').reverseV2ShipmentDelivery({auth:{uid:'A'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(reads,1);
});

test('whole-order lifecycle Callable uses the same isolated project and authenticated identity gate',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0;
 const create=(configuration=env(),projectId='demo-yushin')=>createV2ReturnCallables({
  onCall:(_settings,handler)=>handler,HttpsError,getDatabase:()=>{reads++;return {projectId};},env:configuration});
 assert.equal(typeof create().setV2OrderLifecycle,'function');
 await assert.rejects(create().setV2OrderLifecycle({data:{actorUid:'forged'}}),e=>e.code==='unauthenticated');
 for(const patch of [{GCLOUD_PROJECT:'preview-20135'},{FUNCTIONS_EMULATOR:'false'},
  {ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},{FIREBASE_AUTH_EMULATOR_HOST:'remote.example:9099'}])
  await assert.rejects(create({...env(),...patch}).setV2OrderLifecycle({auth:{uid:'A'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(reads,0);
 await assert.rejects(create(env(),'production').setV2OrderLifecycle({auth:{uid:'A'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(reads,1);
});

test('obsolete isolated receipt wrapper is retired and the harness uses the canonical exported handler',()=>{
 const handlers=createV2ReturnCallables({onCall:(_settings,fn)=>fn,HttpsError:Error,getDatabase:()=>{throw Error('not called');},env:env()});
 assert.equal(handlers.receiveV2Supply,undefined);
 assert.match(fs.readFileSync('tests/fixtures/v2-return-auth-functions.cjs','utf8'),/receiveV2Supply:service\.receiveV2Supply/);
 assert.match(fs.readFileSync('tests/fixtures/v2-return-auth-functions.cjs','utf8'),/prepareV2OrderDispatch:service\.prepareV2OrderDispatch/);
});
