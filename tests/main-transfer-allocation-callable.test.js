'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {mainTransferAllocationProject:gate}=require('../functions/main-transfer-allocation-gate');
const {normalizeAllocationSource,createMainTransferAllocationCallable}=require('../functions/main-transfer-allocation-callable');
const env={GCLOUD_PROJECT:'demo-yushin',ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function fixture(patch={}){let reads=0;const calls=[];const handler=createMainTransferAllocationCallable({onCall:(_,fn)=>fn,HttpsError,env,getDatabase:()=>{reads++;return {projectId:'demo-yushin'};},drain:async(...args)=>{calls.push(args);return {status:'active',recoveryPending:true,allocatedQty:2};},...patch});return {handler,calls,reads:()=>reads};}
test('allocation endpoint rejects production Preview missing shared flag and remote emulator hosts',()=>{
 assert.equal(gate(env),'demo-yushin');
 for(const patch of [{GCLOUD_PROJECT:'yu-shing-company'},{GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION:'true'},{ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR:'false'},{FUNCTIONS_EMULATOR:'false'},{FIRESTORE_EMULATOR_HOST:'remote:8080'},{FIREBASE_AUTH_EMULATOR_HOST:''}])assert.equal(gate({...env,...patch}),'');
});
test('only original transfer ID produces a fixed five-step durable movement source',()=>{
 assert.deepEqual(normalizeAllocationSource({transferId:'T'}),{movementId:'T-in',maxSteps:5});
 for(const data of [null,[],{}, {transferId:'../T'},{transferId:' T'},{transferId:'T',quantity:3},{transferId:'T',operationId:'new'},{transferId:'T',maxSteps:10}])assert.throws(()=>normalizeAllocationSource(data),e=>e.code==='invalid-argument');
});
test('disabled unauthenticated and malformed calls perform no database access',async()=>{
 const disabled=fixture({env:{}});await assert.rejects(disabled.handler({auth:{uid:'U'},data:{transferId:'T'}}),e=>e.code==='failed-precondition');assert.equal(disabled.reads(),0);
 const f=fixture();await assert.rejects(f.handler({data:{transferId:'T'}}),e=>e.code==='unauthenticated');
 await assert.rejects(f.handler({auth:{uid:'U'},data:{transferId:'T',quantity:2}}),e=>e.code==='invalid-argument');assert.equal(f.reads(),0);
});
test('repeated recovery delegates identical source and authenticated UID without claiming completion',async()=>{
 const f=fixture(),request={auth:{uid:'U'},data:{transferId:'T'}};
 const result=await f.handler(request);await f.handler(request);
 assert.equal(result.status,'active');assert.equal(result.recoveryPending,true);assert.equal(result.transferId,'T');
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.calls[0][1],'U');assert.deepEqual(f.calls[0][2],{movementId:'T-in',maxSteps:5});
});
test('database mismatch and live role rejection cannot execute a different source',async()=>{
 const mismatch=fixture({getDatabase:()=>({projectId:'production'})});await assert.rejects(mismatch.handler({auth:{uid:'U'},data:{transferId:'T'}}),e=>e.code==='failed-precondition');assert.equal(mismatch.calls.length,0);
 const denied=fixture({drain:async()=>{throw Object.assign(Error('role revoked'),{code:'permission-denied'});}});
 await assert.rejects(denied.handler({auth:{uid:'U'},data:{transferId:'T'}}),e=>e.code==='permission-denied');
});
test('completed response waits for authority projection and refuses a mismatched completion',async()=>{
 let finalized=0;const result={status:'completed',runId:'original-run',maxQty:3,allocatedQty:3};
 const f=fixture({drain:async()=>result,projectCompletion:async()=>{finalized++;return {runId:'original-run',maxQty:3,allocatedQty:3};}});
 assert.equal((await f.handler({auth:{uid:'U'},data:{transferId:'T'}})).status,'completed');assert.equal(finalized,1);
 const bad=fixture({drain:async()=>result,projectCompletion:async()=>({runId:'other',maxQty:3,allocatedQty:3})});
 await assert.rejects(bad.handler({auth:{uid:'U'},data:{transferId:'T'}}),e=>e.code==='failed-precondition');
});
