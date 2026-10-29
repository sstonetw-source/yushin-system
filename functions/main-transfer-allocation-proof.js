'use strict';
const {createHash}=require('node:crypto');
const {normalizePhysicalIntent}=require('./main-transfer-physical-service');
function fail(message){throw Object.assign(new Error(message),{code:'failed-precondition'});}
function validId(value){
 if(typeof value!=='string'||!value||value!==value.trim()||value.length>96||value.includes('/'))fail('調撥分配識別碼不正確');
 return value;
}
function allocationIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==2
  ||!Object.hasOwn(data,'transferId')||!Object.hasOwn(data,'operationId'))fail('分配意圖欄位不正確');
 const transferId=validId(data.transferId),operationId=validId(data.operationId);
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(operationId))fail('分配操作識別碼不正確');
 const intent={action:'ALLOCATE_MAIN_TRANSFER',transferId,operationId};
 return {...intent,intentHash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
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
function inspectAllocationCheckpoint({checkpoint,intent,actorUid,actorRole}){
 if(!checkpoint)return 'new';
 if(checkpoint.kind!=='MAIN_TRANSFER_ALLOCATION'||checkpoint.intentHash!==intent.intentHash
  ||checkpoint.transferId!==intent.transferId||checkpoint.operationId!==intent.operationId
  ||checkpoint.actorUid!==actorUid||checkpoint.actorRole!==actorRole)fail('分配操作憑證與原意圖衝突');
 if(checkpoint.status==='COMPLETED')return 'already-applied';
 if(checkpoint.status==='PENDING')return 'resume-original';
 fail('分配憑證狀態不明，不得改用新操作編號');
}

const {compareReservationPriority}=require('./shared/reservation-core');
function selectBoundedShortages({rows,productKey,warehouseId,excludeOrderId='',maxCandidates=50}){
 if(!Array.isArray(rows)||!Number.isSafeInteger(maxCandidates)||maxCandidates<1||maxCandidates>100
  ||rows.length>maxCandidates)fail('缺貨候選超出本入口有界讀取預算');
 const seen=new Set(),candidates=[];
 for(const row of rows){
  if(!row||typeof row!=='object'||!row.id||typeof row.id!=='string'||seen.has(row.id))
   fail('缺貨候選來源重複或不正確');
  seen.add(row.id);
  if(row.productKey!==productKey||row.warehouseId!==warehouseId||row.orderId===excludeOrderId)continue;
  if(!['shortage','active'].includes(row.status))continue;
  if(typeof row.shortageQty!=='number'||!Number.isSafeInteger(row.shortageQty)||row.shortageQty<0)
   fail('缺貨候選數量不正確');
  if(row.shortageQty===0)continue;
  if(typeof row.orderId!=='string'||!row.orderId||typeof row.itemId!=='string'||!row.itemId)
   fail('缺貨候選缺少來源訂單品項');
  candidates.push(row);
 }
 return candidates.sort(compareReservationPriority);
}
module.exports={allocationIntent,assertReceiptReady,inspectAllocationCheckpoint,selectBoundedShortages};
