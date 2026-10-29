function mainTransferPhysicalKey(action,id){return 'main-transfer-physical:'+encodeURIComponent(currentUser?.uid||'')+':'+action+':'+encodeURIComponent(id);}
function pendingMainTransferPhysical(action,id){
 const raw=sessionStorage.getItem(mainTransferPhysicalKey(action,id));if(raw===null)return null;
 try{const p=JSON.parse(raw);
  if(!['DISPATCH','RECEIVE'].includes(action)||p.uid!==currentUser?.uid||p.role!==currentUserRole||p.action!==action||p.payload?.id!==id
   ||!['preview-20135','demo-yushin'].includes(p.project)||Object.keys(p.payload).sort().join(',')!==(action==='DISPATCH'?'id,requestId':'id,operationId')
   ||typeof id!=='string'||!id||id.length>96||id!==id.trim()||id.includes('/')
   ||(action==='DISPATCH'?(typeof p.payload.requestId!=='string'||!p.payload.requestId||p.payload.requestId.includes('/')):!/^[A-Za-z0-9_-]{12,96}$/.test(p.payload.operationId)))throw Error('invalid');
  return p;
 }catch(_){throw Error('前次調撥實貨結果未確認，請保留原暫存並使用原帳號與角色。');}
}
function pendingMainTransferPhysicalOperations(){
 const prefix='main-transfer-physical:'+encodeURIComponent(currentUser?.uid||'')+':',rows=[];
 for(let n=0;n<sessionStorage.length;n++){
  const key=sessionStorage.key(n);if(!key?.startsWith(prefix))continue;
  try{const at=key.indexOf(':',prefix.length),action=key.slice(prefix.length,at),id=decodeURIComponent(key.slice(at+1));
   try{const p=pendingMainTransferPhysical(action,id);if(p)rows.push({id,action,requestId:p.payload.requestId||''});}
   catch(e){rows.push({id,action,error:e.message});}
  }catch(_){rows.push({id:'',action:'',error:'調撥實貨暫存無法讀取，請保留原暫存核對。'});}
 }
 return rows;
}
function pendingMainTransferDispatch(requestId){
 const rows=pendingMainTransferPhysicalOperations();
 if(rows.some(r=>r.error))throw Error('尚有無法核對的調撥暫存，請先確認原操作。');
 const matches=rows.filter(r=>r.action==='DISPATCH'&&r.requestId===requestId);
 if(matches.length>1)throw Error('同一主倉需求有多筆未確認調撥，請保留原操作核對。');
 return matches[0]||null;
}
function mainTransferPhysicalRequired(action,id,requestId=''){
 const flag=action==='DISPATCH'?'YUSHIN_MAIN_TRANSFER_DISPATCH_EMULATOR':'YUSHIN_MAIN_TRANSFER_RECEIPT_EMULATOR';
 return (typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview')||globalThis[flag]===true
  ||sessionStorage.getItem(mainTransferPhysicalKey(action,id))!==null
  ||(action==='DISPATCH'&&!!pendingMainTransferDispatch(requestId));
}
const mainTransferPhysicalInFlight=new Map();
async function commitMainTransferPhysicalBackend(action,id,input){
 const key=JSON.stringify([currentUser?.uid,currentUserRole,action,id]),signature=JSON.stringify(input??null);
 const existing=mainTransferPhysicalInFlight.get(key);
 if(existing){if(existing.signature!==signature)throw Error('實貨調撥處理中，不能變更原操作內容。');return existing.promise;}
 const promise=submitMainTransferPhysicalBackend(action,id,input).finally(()=>mainTransferPhysicalInFlight.delete(key));
 mainTransferPhysicalInFlight.set(key,{signature,promise});return promise;
}
async function submitMainTransferPhysicalBackend(action,id,input){
 const actorUid=currentUser?.uid,actorRole=currentUserRole;
 if(typeof ensureReservationFunctionsCompat==='function')await ensureReservationFunctionsCompat();
 if(currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw Error('載入後端期間登入身分已變更，尚未提交。');
 if(!['DISPATCH','RECEIVE'].includes(action))throw Error('調撥動作不正確。');
 const suffix=action==='DISPATCH'?'DISPATCH':'RECEIPT';
 const {uid,role,project,functions,emulator,check}=mainTransferBackendContext({emulatorFlag:'YUSHIN_MAIN_TRANSFER_'+suffix+'_EMULATOR',previewFlag:'YUSHIN_PREVIEW_MAIN_TRANSFER_'+suffix,
  roles:['admin','purchaser','warehouse'],authorized:()=>canReceiveInventoryCapability()&&canAccessPage('inventory')});
 if(action==='DISPATCH'&&input){const original=pendingMainTransferDispatch(input.requestId);if(original&&original.id!==id)throw Error('此需求已有未確認寄出，必須沿用原操作識別碼。');}
 if(action==='RECEIVE'&&pendingMainTransferPhysical('DISPATCH',id))throw Error('原寄出結果尚未確認，請先確認原寄出操作。');
 const key=mainTransferPhysicalKey(action,id);let saved=pendingMainTransferPhysical(action,id);
 if(saved){if(saved.project!==project)throw Error('前次實貨調撥屬於其他專案，請回原環境核對。');
  if(input&&JSON.stringify(saved.payload)!==JSON.stringify(input))throw Error('調撥已有未確認原操作，不能變更來源或重建識別碼。');
 }else{
  if(typeof id!=='string'||!id||id!==id.trim()||id.includes('/')||id.length>96)throw Error('調撥識別碼不正確。');
  let payload=input;
  if(action==='RECEIVE'&&!payload){
   // Confirm an already-received event with its original identity, never a new operation.
   const prior=await db.collection('stockTransfers').doc(id).get({source:'server'});check();const t=prior.exists?prior.data():null;
   if(!t?.dispatchIntentHash||t.kind!=='TRANSFER'||t.orderId||!t.requestId)throw Error('此入口只接受主倉備貨後端調撥。');
   if(t.status==='RECEIVED'&&(!t.receiptOperationId||t.receivedByUid!==uid||t.receivedByRole!==role))throw Error('已入庫結果須由原操作帳號與角色核對。');
   payload={id,operationId:t.status==='RECEIVED'?t.receiptOperationId:lifecycleRecordId()};
  }
  if(!payload||payload.id!==id||Object.keys(payload).sort().join(',')!==(action==='DISPATCH'?'id,requestId':'id,operationId')
   ||(action==='DISPATCH'?(typeof payload.requestId!=='string'||!payload.requestId||payload.requestId!==payload.requestId.trim()||payload.requestId.includes('/')||payload.requestId.length>160)
    :!/^[A-Za-z0-9_-]{12,96}$/.test(payload.operationId)))throw Error('調撥原操作資料不正確。');
  // Receipt preflight awaited a server read. Another click may have frozen its ID meanwhile.
  const concurrent=pendingMainTransferPhysical(action,id);
  if(concurrent){
   if(concurrent.project!==project||(input&&JSON.stringify(concurrent.payload)!==JSON.stringify(input)))throw Error('實貨調撥已有另一筆未確認原操作。');
   saved=concurrent;
  }else{
   saved={uid,role,project,action,payload};const raw=JSON.stringify(saved);sessionStorage.setItem(key,raw);
   if(sessionStorage.getItem(key)!==raw)throw Error('無法保存實貨調撥原操作，尚未送出。');
  }
 }
 check();if(emulator)functions.useEmulator('127.0.0.1',5001);
 const response=await functions.httpsCallable(action==='DISPATCH'?'dispatchV2MainTransfer':'receiveV2MainTransfer')(saved.payload);check();
 const r=response?.data,p=saved.payload;
 if(!['applied','already-applied'].includes(r?.status)||r.action!==action||r.id!==id||r.operationId!==(action==='DISPATCH'?id:p.operationId)
  ||r.actorUid!==uid||r.actorRole!==role)throw Error('調撥實貨回覆無法核對，請保留原操作。');
 const snap=await db.collection('stockTransfers').doc(id).get({source:'server'});check();const t=snap.exists?snap.data():null;
 if(!t||t.id!==id||t.kind!=='TRANSFER'||t.orderId||!t.requestId||!t.dispatchIntentHash||!['IN_TRANSIT','RECEIVED'].includes(t.status))throw Error('原實貨調撥憑證無法核對。');
 if(action==='DISPATCH'?(t.requestId!==p.requestId||t.createdByUid!==uid||t.createdByRole!==role)
  :(t.status!=='RECEIVED'||t.receiptOperationId!==p.operationId||t.receivedByUid!==uid||t.receivedByRole!==role||!t.receiptIntentHash))throw Error('實貨調撥憑證與原操作不一致。');
 const raw=sessionStorage.getItem(key);if(raw!==null&&raw!==JSON.stringify(saved))throw Error('實貨調撥暫存已變更，請保留核對。');
 sessionStorage.removeItem(key);return {...t,id,affectedOrderIds:[],physicalReceiptOnly:action==='RECEIVE'};
}
