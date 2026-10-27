'use strict';
// Per-attempt guard around the existing receiving writer. This does not calculate
// quantities or commit anything; the native Firestore transaction owns atomicity.
const MAX_READ_DOCUMENTS=400,MAX_READ_REQUESTS=100,MAX_WRITES=100;
function exhausted(){
 const error=new Error('收貨來源資料超過單次安全處理上限；本次尚未寫入，請聯絡管理員檢查來源紀錄。');
 error.code='failed-precondition';return error;
}
function createReceiptTransaction(native){
 const reads=new Map(),pending=[];
 let documents=0,requests=0,closed=false,poisoned=false,inFlight=0;
 const reject=()=>{poisoned=true;throw exhausted();};
 const open=()=>{if(closed)throw Error('收貨交易已完成寫入階段');if(poisoned)throw exhausted();};
 const get=reference=>{
  open();
  if(reference.path&&reads.has(reference.path))return reads.get(reference.path);
  if(++requests>MAX_READ_REQUESTS)reject();
  inFlight++;
  const result=Promise.resolve().then(()=>native.get(reference)).then(snapshot=>{
   documents+=Array.isArray(snapshot.docs)?snapshot.docs.length:1;
   if(documents>MAX_READ_DOCUMENTS)reject();
   return snapshot;
  }).catch(error=>{poisoned=true;throw error;}).finally(()=>{inFlight--;});
  if(reference.path)reads.set(reference.path,result);
  return result;
 };
 const stage=(method,args)=>{
  open();if(pending.length>=MAX_WRITES)reject();
  pending.push([method,args]);
 };
 return {get,update:(...args)=>stage('update',args),set:(...args)=>stage('set',args),
  flush(){open();if(inFlight)reject();closed=true;for(const [method,args] of pending)native[method](...args);}};
}
module.exports={createReceiptTransaction,MAX_READ_DOCUMENTS,MAX_READ_REQUESTS,MAX_WRITES};
