'use strict';
const {createHash}=require('node:crypto');

function fail(code,message){const error=new Error(message);error.code=code;throw error;}
function valueId(value,label,max=120){
 if(typeof value!=='string'||!value||value!==value.trim()||value.length>max||
    value.includes('/')||/[\x00-\x1f]/.test(value))
  fail('invalid-argument',label+'格式不正確');
 return value;
}
function normalizeSalesTransfer(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||
    Object.keys(data).sort().join(',')!=='expectedFromUid,operationId,salesCode,targetUid')
  fail('invalid-argument','業務交接欄位不正確');
 const operationId=valueId(data.operationId,'操作 ID',96);
 if(!/^[A-Za-z0-9_-]{12,96}$/.test(operationId))
  fail('invalid-argument','操作 ID 格式不正確');
 const salesCode=valueId(data.salesCode,'業務代號',80);
 const targetUid=valueId(data.targetUid,'接手人員 UID',128);
 const expectedFromUid=valueId(data.expectedFromUid,'原負責人 UID',128);
 if(targetUid===expectedFromUid)fail('failed-precondition','接手人與原負責人相同');
 const identity={salesCode,targetUid,expectedFromUid};
 return {...identity,operationId,hash:createHash('sha256').update(JSON.stringify(identity)).digest('hex')};
}
function activeUser(snap){
 return snap.exists&&snap.data().active!==false&&snap.data().disabled!==true;
}
async function commitSalesCodeTransfer(db,actorUid,data){
 const intent=normalizeSalesTransfer(data);
 const now=new Date().toISOString();
 const ref=(collection,id)=>db.collection(collection).doc(id);
 const actorRef=ref('users',valueId(actorUid,'操作者 UID',128));
 const operationRef=ref('salesCodeTransferOperations',intent.operationId);
 const codeRef=ref('salesCodes',intent.salesCode);
 const previousRef=ref('users',intent.expectedFromUid);
 const targetRef=ref('users',intent.targetUid);
 return db.runTransaction(async tx=>{
  // Roles and document ownership must be checked again inside every transaction retry.
  const actor=await tx.get(actorRef);
  if(!activeUser(actor)||actor.data().role!=='admin')
   fail('permission-denied','目前帳號沒有管理員交接權限');
  const operation=await tx.get(operationRef);
  if(operation.exists){
   const saved=operation.data();
   if(saved.hash!==intent.hash||saved.actorUid!==actorUid)
    fail('already-exists','操作 ID 已用於不同交接');
   return {status:'already-applied',salesCode:intent.salesCode,
    fromUid:intent.expectedFromUid,toUid:intent.targetUid,operationId:intent.operationId};
  }
  const [master,previous,target]=await Promise.all([
   tx.get(codeRef),tx.get(previousRef),tx.get(targetRef)
  ]);
  if(!previous.exists||!activeUser(target)||!target.data().name)
   fail('failed-precondition','原負責人或接手人資料已停用／不存在');
  const current=master.exists?master.data():{};
  if(master.exists&&current.active===false)
   fail('failed-precondition','業務代號已停用');
  if(master.exists&&current.currentUserUid&&current.currentUserUid!==intent.expectedFromUid)
   fail('failed-precondition','業務代號負責人已變更，請重新檢查交接');
  if(String(previous.data().code||'')!==intent.salesCode||
     (previous.data().salesCode&&String(previous.data().salesCode)!==intent.salesCode))
   fail('failed-precondition','原負責人的業務代號不一致，請先處理資料健康問題');
  if((target.data().code&&String(target.data().code)!==intent.salesCode)||
     (target.data().salesCode&&String(target.data().salesCode)!==intent.salesCode))
   fail('failed-precondition','接手人員已有其他業務代號');
  // Detect duplicate staff ownership before writing. One stable code must have one active holder.
  const assigned=await tx.get(db.collection('users').where('code','==',intent.salesCode).limit(3));
  if(assigned.docs.length!==1||assigned.docs[0].id!==intent.expectedFromUid)
   fail('failed-precondition','存在重複或不一致的業務代號，必須先修復');
  const entry={fromUid:intent.expectedFromUid,fromName:previous.data().name||'',
   toUid:intent.targetUid,toName:target.data().name,at:now,byUid:actorUid,
   byName:actor.data().name||'',operationId:intent.operationId};
  const priorHistory=Array.isArray(current.handoffHistory)?current.handoffHistory:[];
  tx.set(codeRef,{code:intent.salesCode,currentUserUid:intent.targetUid,
   currentUserName:target.data().name,active:true,
   handoffHistory:[...priorHistory.slice(-49),entry],updatedAt:now},{merge:true});
  tx.update(targetRef,{code:intent.salesCode,salesCode:intent.salesCode,
   codeAssignedAt:now});
  tx.update(previousRef,{code:'',salesCode:'',previousSalesCode:intent.salesCode,
   codeHandedOffAt:now});
  // Separate immutable, server-only audit and idempotency evidence.
  tx.create(operationRef,{operationId:intent.operationId,hash:intent.hash,
   actorUid,actorName:actor.data().name||'',salesCode:intent.salesCode,
   fromUid:intent.expectedFromUid,fromName:previous.data().name||'',
   toUid:intent.targetUid,toName:target.data().name,
   createdAt:now,status:'COMPLETED'});
  return {status:'completed',salesCode:intent.salesCode,
   fromUid:intent.expectedFromUid,toUid:intent.targetUid,operationId:intent.operationId};
 });
}
module.exports={commitSalesCodeTransfer,normalizeSalesTransfer};
