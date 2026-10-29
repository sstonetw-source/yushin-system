'use strict';
const {validateTransfer}=require('./main-transfer-physical-service');
const {assertReceiptReady}=require('./main-transfer-allocation-proof');
function fail(message){throw Object.assign(Error(message),{code:'failed-precondition'});}
// Read adapter only. The existing durable movement coordinator owns all stock,
// reservation, order and demand writes; this must never establish a second job.
async function readMainTransferFreeStockSource(tx,db,movementId,event){
 if(process.env.ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR!=='true'
  ||process.env.FUNCTIONS_EMULATOR!=='true'||!process.env.FIRESTORE_EMULATOR_HOST
  ||!process.env.FIREBASE_AUTH_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fail('主倉調撥缺貨分配尚未在此環境啟用');
 const transferId=event.transferId;
 if(typeof transferId!=='string'||!transferId||transferId.includes('/')||transferId.length>96
  ||movementId!==transferId+'-in'||event.type!=='warehouse_transfer_in'
  ||event.sourceType!=='WAREHOUSE_TRANSFER'||event.sourceId!==transferId)
  fail('主倉調撥入庫異動來源不一致');
 const ref=(name,id)=>db.collection(name).doc(id);
 const snap=await tx.get(ref('stockTransfers',transferId));
 if(!snap.exists)fail('找不到主倉調撥來源');
 const transfer=snap.data();validateTransfer(transfer,{id:transferId});
 if(typeof transfer.receiptOperationId!=='string'||!transfer.receiptOperationId
  ||transfer.receiptOperationId.includes('/'))fail('原收貨識別碼不正確');
 const dispatch=await tx.get(ref('reservationOperationReceipts','main-transfer-dispatch-'+transferId));
 const receipt=await tx.get(ref('reservationOperationReceipts','main-transfer-receipt-'+transfer.receiptOperationId));
 const proof=assertReceiptReady({transfer,dispatchProof:dispatch.exists?dispatch.data():null,
  receiptProof:receipt.exists?receipt.data():null,intent:{transferId}});
 const received=receipt.data();
 if(!Number.isSafeInteger(proof.quantity)||proof.quantity>1000
  ||event.qty!==proof.quantity||event.productKey!==proof.productKey
  ||event.warehouseId!==proof.toWarehouseId||event.toWarehouseId!==proof.toWarehouseId
  ||event.fromWarehouseId!==transfer.fromWarehouseId||event.orderId||event.itemId
  ||received.actorUid!==transfer.receivedByUid||received.actorRole!==transfer.receivedByRole
  ||!received.actorUid||!['admin','purchaser','warehouse'].includes(received.actorRole)
  ||event.actorUid!==received.actorUid)fail('主倉調撥實貨收貨憑證不一致或超出分配預算');
 for(const allocation of transfer.allocations){
  const lotSnap=await tx.get(ref('inventoryLots',allocation.targetLotId));
  const lot=lotSnap.exists?lotSnap.data():null;
  if(!lot||lot.sourceType!=='WAREHOUSE_TRANSFER'||lot.sourceId!==transferId||lot.transferId!==transferId
   ||lot.productKey!==proof.productKey||lot.warehouseId!==proof.toWarehouseId
   ||lot.qty!==allocation.qty||lot.costLotId!==allocation.costLotId
   ||lot.lotNo!==(allocation.lotNo||'')||lot.expiryDate!==(allocation.expiryDate||'')
   ||typeof lot.remainingQty!=='number'||!Number.isFinite(lot.remainingQty)
   ||lot.remainingQty<0||lot.remainingQty>lot.qty)fail('主倉調撥目的倉批次憑證不一致');
 }
 return proof.quantity;
}
module.exports={readMainTransferFreeStockSource};
