'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {gate,inspectMainTransferAllocation}=require('../functions/main-transfer-allocation-inspection');
const env={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION:'true'};
test('inspection is disabled without a matching project and dedicated gate',async()=>{
 assert.equal(gate({GCLOUD_PROJECT:'yu-shing-company',ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION:'true'}),'');
 assert.equal(gate({GCLOUD_PROJECT:'preview-20135'}),'');
 await assert.rejects(inspectMainTransferAllocation({projectId:'yu-shing-company'},'U',{},env));
});
test('inspection requires live role and backend proof without performing any writes',async()=>{
 const db={projectId:'preview-20135',collection:name=>({doc:id=>({path:name+'/'+id})}),
  runTransaction:fn=>fn({get:async ref=>ref.path==='users/U'?{exists:true,data:()=>({role:'warehouse',active:true})}:{exists:false},
   create:()=>{throw Error('write forbidden');},update:()=>{throw Error('write forbidden');},set:()=>{throw Error('write forbidden');}})};
 await assert.rejects(inspectMainTransferAllocation(db,'U',{transferId:'transfer_12345678',operationId:'allocation_12345678'},env),
  e=>e.code==='not-found');
});
