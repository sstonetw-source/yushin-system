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
test('production Functions entry never exports the isolated return Callables or their fixture',()=>{
 assert.doesNotMatch(fs.readFileSync('functions/index.js','utf8'),/v2-return-callable|previewV2CustomerReturn|receiveV2CustomerReturn|v2-return-auth-functions/);
});
