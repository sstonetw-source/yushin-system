'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {allocationIntent,assertReceiptReady,inspectAllocationCheckpoint}=require('../functions/main-transfer-allocation-proof');
const intent=allocationIntent({transferId:'transfer_12345678',operationId:'allocate_12345678'});
function fixture(){
 const transfer={id:intent.transferId,kind:'TRANSFER',status:'RECEIVED',orderId:'',itemId:'',reservedQty:0,
  qty:3,productKey:'P',toWarehouseId:'MAIN',allocations:[{lotId:'L',qty:3}],
  dispatchIntentHash:'dispatch-hash',receiptIntentHash:'receipt-hash',receiptOperationId:'receive_12345678',
  allocationCompleted:true,autoAllocatedQty:3};
 const dispatchProof={kind:'MAIN_TRANSFER_DISPATCH',intentHash:'dispatch-hash',transfer:{...transfer,status:'IN_TRANSIT',
  allocationCompleted:undefined,autoAllocatedQty:undefined}};
 delete dispatchProof.transfer.allocationCompleted;delete dispatchProof.transfer.autoAllocatedQty;
 const receiptProof={kind:'MAIN_TRANSFER_RECEIPT',transferId:intent.transferId,intentHash:'receipt-hash'};
 return {transfer,dispatchProof,receiptProof,intent};
}
test('allocation intent has stable digest and rejects unbounded or extra fields',()=>{
 assert.deepEqual(allocationIntent({transferId:intent.transferId,operationId:intent.operationId}),intent);
 for(const data of [{transferId:'bad/id',operationId:intent.operationId},
  {transferId:intent.transferId,operationId:'short'},
  {transferId:intent.transferId,operationId:intent.operationId,qty:3},null]){
  assert.throws(()=>allocationIntent(data));
 }
});
test('backend proof requires receipt and dispatch witnesses independently of display completion',()=>{
 const f=fixture();
 assert.equal(assertReceiptReady(f).quantity,3);
 for(const modify of [
  x=>{x.dispatchProof=null;},x=>{x.receiptProof=null;},
  x=>{x.transfer.status='IN_TRANSIT';},x=>{x.transfer.qty=4;},
  x=>{x.receiptProof.intentHash='forged';},x=>{x.dispatchProof.transfer.qty=4;}
 ]){const v=fixture();modify(v);assert.throws(()=>assertReceiptReady(v));}
 const v=fixture();v.transfer.allocationCompleted=false;v.transfer.autoAllocatedQty=0;
 assert.equal(assertReceiptReady(v).quantity,3);
});
test('checkpoint retries original operation and rejects collisions or ambiguous state',()=>{
 const args={intent,actorUid:'U',actorRole:'warehouse'};
 assert.equal(inspectAllocationCheckpoint({...args,checkpoint:null}),'new');
 const checkpoint={kind:'MAIN_TRANSFER_ALLOCATION',intentHash:intent.intentHash,transferId:intent.transferId,
  operationId:intent.operationId,actorUid:'U',actorRole:'warehouse',status:'PENDING'};
 assert.equal(inspectAllocationCheckpoint({...args,checkpoint}),'resume-original');
 assert.equal(inspectAllocationCheckpoint({...args,checkpoint:{...checkpoint,status:'COMPLETED'}}),'already-applied');
 for(const change of [{actorUid:'OTHER'},{intentHash:'forged'},{status:'UNKNOWN'}]){
  assert.throws(()=>inspectAllocationCheckpoint({...args,checkpoint:{...checkpoint,...change}}));
 }
});
