'use strict';
const {allocationIntent,assertReceiptReady,inspectAllocationCheckpoint}=require('./main-transfer-allocation-proof');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function gate(env=process.env){
 const project=env.GCLOUD_PROJECT||env.GCP_PROJECT;
 if(project==='preview-20135'&&env.ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION==='true'&&!env.FUNCTIONS_EMULATOR)return project;
 if(project==='demo-yushin'&&env.ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR==='true'
  &&env.FUNCTIONS_EMULATOR==='true'&&env.FIRESTORE_EMULATOR_HOST&&env.FIREBASE_AUTH_EMULATOR_HOST)return project;
 return '';
}
async function inspectMainTransferAllocation(db,uid,data,env=process.env){
 const project=gate(env);
 if(!project||db.projectId!==project)fail('主倉分配後端尚未啟用');
 const intent=allocationIntent(data);
 return db.runTransaction(async tx=>{
  const ref=(name,id)=>db.collection(name).doc(id);
  const user=await tx.get(ref('users',uid));
  const role=user.exists?user.data().role:null;
  if(!user.exists||user.data().active===false||user.data().disabled===true
   ||!['admin','purchaser','warehouse'].includes(role))fail('沒有分配權限','permission-denied');
  const transferSnap=await tx.get(ref('stockTransfers',intent.transferId));
  if(!transferSnap.exists)fail('調撥不存在','not-found');
  const transfer=transferSnap.data();
  const dispatch=await tx.get(ref('reservationOperationReceipts','main-transfer-dispatch-'+intent.transferId));
  const receiptId=transfer.receiptOperationId;
  if(typeof receiptId!=='string'||!receiptId||receiptId.includes('/'))fail('收貨操作識別碼不正確');
  const receipt=await tx.get(ref('reservationOperationReceipts','main-transfer-receipt-'+receiptId));
  const proof=assertReceiptReady({transfer,dispatchProof:dispatch.exists?dispatch.data():null,
   receiptProof:receipt.exists?receipt.data():null,intent});
  const checkpoint=await tx.get(ref('reservationOperationReceipts','main-transfer-allocation-'+intent.operationId));
  const state=inspectAllocationCheckpoint({checkpoint:checkpoint.exists?checkpoint.data():null,
   intent,actorUid:uid,actorRole:role});
  // Inspection only: no stock, order, demand or checkpoint writes until the full
  // atomic allocation writer is implemented and verified.
  return {status:state,transferId:intent.transferId,operationId:intent.operationId,
   productKey:proof.productKey,warehouseId:proof.toWarehouseId,receiptQty:proof.quantity};
 });
}
module.exports={gate,inspectMainTransferAllocation};
