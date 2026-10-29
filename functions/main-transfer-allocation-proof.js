'use strict';
const {normalizePhysicalIntent}=require('./main-transfer-physical-service');
function fail(message){throw Object.assign(new Error(message),{code:'failed-precondition'});}
function assertReceiptReady({transfer,dispatchProof,receiptProof,intent}){
 if(!transfer||transfer.id!==intent.transferId||transfer.kind!=='TRANSFER'||transfer.status!=='RECEIVED'
  ||transfer.orderId||transfer.itemId||transfer.reservedQty!==0)fail('來源不是已完成的主倉實貨調撥');
 if(!dispatchProof||dispatchProof.kind!=='MAIN_TRANSFER_DISPATCH'
  ||dispatchProof.intentHash!==transfer.dispatchIntentHash||!dispatchProof.transfer)fail('缺少可信任寄出憑證');
 for(const [key,value] of Object.entries(dispatchProof.transfer)){
  if(key!=='status'&&JSON.stringify(transfer[key])!==JSON.stringify(value))fail('調撥來源已偏離寄出憑證');
 }
 if(typeof transfer.receiptOperationId!=='string'||!transfer.receiptOperationId
  ||transfer.receiptIntentHash!==normalizePhysicalIntent('RECEIVE',{
   id:intent.transferId,operationId:transfer.receiptOperationId}).hash)
  fail('收貨操作意圖與來源不一致');
 if(!receiptProof||receiptProof.kind!=='MAIN_TRANSFER_RECEIPT'
  ||receiptProof.transferId!==intent.transferId||receiptProof.intentHash!==transfer.receiptIntentHash)fail('缺少可信任收貨憑證');
 if(typeof transfer.qty!=='number'||!Number.isFinite(transfer.qty)||transfer.qty<=0
  ||!Array.isArray(transfer.allocations)||!transfer.allocations.length)fail('調撥數量或批次不正確');
 // Client-writable display metadata must never establish allocation authority.
 return {transferId:intent.transferId,receiptOperationId:transfer.receiptOperationId,quantity:transfer.qty,
  productKey:transfer.productKey,toWarehouseId:transfer.toWarehouseId};
}
module.exports={assertReceiptReady};
