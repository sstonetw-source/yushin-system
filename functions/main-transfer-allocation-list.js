'use strict';
const {mainTransferAllocationProject}=require('./main-transfer-allocation-gate');
const {readMainTransferAllocationState}=require('./main-transfer-allocation-completion');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
async function listMainTransferAllocations(db,uid,input,env=process.env){
 const project=mainTransferAllocationProject(env);
 if(!project||db.projectId!==project)fail('分配清單未在此環境啟用');
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>key!=='afterId')
  ||(input.afterId!==undefined&&(typeof input.afterId!=='string'||input.afterId.includes('/')||input.afterId.length>160)))fail('分配清單游標不正確','invalid-argument');
 return db.runTransaction(async tx=>{
  const actor=await tx.get(db.collection('users').doc(uid)),user=actor.exists?actor.data():null;
  if(!user||user.active===false||user.disabled===true||!['admin','purchaser','warehouse'].includes(user.role))fail('目前角色不能讀取分配清單','permission-denied');
  // Scan backend-owned receipt witnesses, never mutable stockTransfers flags.
  // Five sources per page, each at most 101 lots: bounded proof read budget.
  let query=db.collection('reservationOperationReceipts').where('kind','==','MAIN_TRANSFER_RECEIPT').orderBy('__name__').limit(6);
  if(input.afterId)query=query.startAfter(input.afterId);
  const page=await tx.get(query),scanned=page.docs.slice(0,5),rows=[];
  for(const doc of scanned){
   const transferId=doc.data().transferId;
   try{
    if(typeof transferId!=='string'||!transferId||transferId.includes('/')||transferId.length>96)fail('原收貨來源識別碼不正確');
    const state=await readMainTransferAllocationState(tx,db,transferId);
    if(state.status!=='completed')rows.push({transferId,status:state.status,allocatedQty:state.allocatedQty,quantity:state.maxQty});
   }catch(error){rows.push({transferId:typeof transferId==='string'?transferId:'',status:'blocked',errorMessage:'原收貨或分配憑證需核對',receiptId:doc.id});}
  }
  return {rows,hasMore:page.docs.length>5,afterId:scanned.at(-1)?.id||input.afterId||''};
 });
}
function createMainTransferAllocationListCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!mainTransferAllocationProject(env))throw new HttpsError('failed-precondition','分配清單尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await listMainTransferAllocations(getDatabase(),request.auth.uid,request.data,env);}
  catch(error){if(['invalid-argument','failed-precondition','permission-denied'].includes(error.code))throw new HttpsError(error.code,error.message);
   console.error('Main transfer allocation list failed',error);throw new HttpsError('internal','分配清單無法確認，請重試原頁面');}
 });
}
module.exports={listMainTransferAllocations,createMainTransferAllocationListCallable};
