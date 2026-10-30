'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {assertReceiptReady}=require('../functions/main-transfer-allocation-proof');
const {normalizePhysicalIntent}=require('../functions/main-transfer-physical-service');
const intent={transferId:'transfer_12345678'};
function fixture(){
 const transfer={id:intent.transferId,kind:'TRANSFER',status:'RECEIVED',orderId:'',itemId:'',reservedQty:0,
  qty:3,productKey:'P',toWarehouseId:'MAIN',allocations:[{lotId:'L',qty:3}],
  dispatchIntentHash:'dispatch-hash',receiptIntentHash:normalizePhysicalIntent('RECEIVE',{id:intent.transferId,operationId:'receive_12345678'}).hash,receiptOperationId:'receive_12345678',
  allocationCompleted:true,autoAllocatedQty:3};
 const dispatchProof={kind:'MAIN_TRANSFER_DISPATCH',intentHash:'dispatch-hash',transfer:{...transfer,status:'IN_TRANSIT',
  allocationCompleted:undefined,autoAllocatedQty:undefined}};
 delete dispatchProof.transfer.allocationCompleted;delete dispatchProof.transfer.autoAllocatedQty;
 const receiptProof={kind:'MAIN_TRANSFER_RECEIPT',transferId:intent.transferId,intentHash:transfer.receiptIntentHash};
 return {transfer,dispatchProof,receiptProof,intent};
}
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
test('receipt proof cannot authorize a mismatched receipt operation id',()=>{
 const f=fixture();f.transfer.receiptOperationId='receive_99999999';
 assert.throws(()=>assertReceiptReady(f));
});
