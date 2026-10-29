function orderTransferKey(action,id){return 'order-transfer:'+encodeURIComponent(currentUser?.uid||'')+':'+action+':'+encodeURIComponent(id);}
function pendingOrderTransferOperations(){
 const prefix='order-transfer:'+encodeURIComponent(currentUser?.uid||'')+':',rows=[];
 for(let n=0;n<sessionStorage.length;n++){
  const key=sessionStorage.key(n);if(!key?.startsWith(prefix))continue;
  try{const p=JSON.parse(sessionStorage.getItem(key));
   if(!['DISPATCH','HANDOFF','RECEIVE'].includes(p.action)||p.uid!==currentUser?.uid||p.role!==currentUserRole||p.project!=='demo-yushin'
    ||typeof p.payload?.id!=='string'||!p.payload.id||p.payload.id.includes('/')||key!==orderTransferKey(p.action,p.payload.id))throw Error('invalid');
   if(Object.keys(p.payload).sort().join(',')!==(p.action!=='RECEIVE'?'expectedPlan,fromWarehouseId,id,itemId,orderId,qty,toWarehouseId':'id,operationId')||(p.action==='RECEIVE'&&!/^[A-Za-z0-9_-]{12,96}$/.test(p.payload.operationId)))throw Error('invalid');
   rows.push({...p,id:p.payload.id});
  }catch(_){rows.push({error:'訂單調撥原操作無法核對，請保留暫存並使用原帳號與角色。'});}
 }
 return rows;
}
function orderTransferBackendRequired(action,id,orderId='',itemId=''){
 return (typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview')||globalThis.YUSHIN_ORDER_TRANSFER_DISPATCH_EMULATOR===true
  ||globalThis.YUSHIN_ORDER_TRANSFER_HANDOFF_EMULATOR===true||globalThis.YUSHIN_ORDER_TRANSFER_RECEIVE_EMULATOR===true||pendingOrderTransferOperations().some(p=>p.error||p.id===id||(orderId&&p.payload.orderId===orderId&&p.payload.itemId===itemId));
}
const orderTransferInFlight=new Map();
function commitOrderTransferBackend(action,id,input){
 const key=JSON.stringify([currentUser?.uid,currentUserRole,action,id]),existing=orderTransferInFlight.get(key),signature=JSON.stringify(input??null);
 if(existing){if(existing.signature!==signature)return Promise.reject(Error('調撥處理中，不能變更原操作。'));return existing.promise;}
 const promise=submitOrderTransferBackend(action,id,input).finally(()=>{orderTransferInFlight.delete(key);try{globalThis.renderMainTransferRequests?.();globalThis.renderWarehouseTransfers?.();}catch(_){}});orderTransferInFlight.set(key,{signature,promise});return promise;
}
async function submitOrderTransferBackend(action,id,input){
 const uid=currentUser?.uid,role=currentUserRole;
 if(typeof ensureReservationFunctionsCompat==='function')await ensureReservationFunctionsCompat();
 if(uid!==currentUser?.uid||role!==currentUserRole)throw Error('載入後端期間登入身分已變更。');
 if(!['DISPATCH','HANDOFF','RECEIVE'].includes(action)||typeof id!=='string'||!id||id!==id.trim()||id.includes('/')||id.length>96)throw Error('訂單調撥原識別碼不正確。');
 const flag='YUSHIN_ORDER_TRANSFER_'+action+'_EMULATOR';
 if(globalThis[flag]!==true)throw Error('訂單調撥後端尚未在此環境啟用，禁止回退舊交易。');
 const {project,functions,check}=mainTransferBackendContext({emulatorFlag:flag,previewFlag:'YUSHIN_UNSUPPORTED_ORDER_TRANSFER_PREVIEW',roles:['admin','purchaser','warehouse'],authorized:()=>canReceiveInventoryCapability()&&canAccessPage('inventory')});
 const key=orderTransferKey(action,id),pending=pendingOrderTransferOperations();if(pending.some(p=>p.error))throw Error('尚有無法核對的訂單調撥暫存。');
 let saved=pending.find(p=>p.action===action&&p.id===id);
 if(saved){if(input&&JSON.stringify(saved.payload)!==JSON.stringify(input))throw Error('原調撥內容已保存，不可修改。');}
 else{
  let payload=input;
  if(action!=='RECEIVE'){
   if(!payload||payload.id!==id||Object.keys(payload).sort().join(',')!=='expectedPlan,fromWarehouseId,id,itemId,orderId,qty,toWarehouseId')throw Error('訂單調撥來源欄位不正確。');
   if(pending.some(p=>p.action!=='RECEIVE'&&p.payload.orderId===payload.orderId&&p.payload.itemId===payload.itemId))throw Error('此品項已有未確認寄出，必須使用原操作編號。');
   if([payload.orderId,payload.itemId,payload.fromWarehouseId,payload.toWarehouseId].some(v=>typeof v!=='string'||!v||v.includes('/'))||!Number.isFinite(payload.qty)||payload.qty<=0)throw Error('原訂單、倉庫或數量不正確。');
  }else{
   if(pending.some(p=>p.action!=='RECEIVE'&&p.id===id))throw Error('請先確認原寄出結果。');
   const snap=await db.collection('stockTransfers').doc(id).get({source:'server'});check();const t=snap.exists?snap.data():null;
   if(!t?.orderTransferIntentHash||!t.orderId||t.kind!=='TRANSFER'||!['IN_TRANSIT','RECEIVED'].includes(t.status))throw Error('找不到原後端訂單調撥。');
   if(t.status==='RECEIVED'&&(t.receivedByUid!==uid||t.receivedByRole!==role||!t.receiptOperationId))throw Error('請使用原收貨帳號及角色核對。');
   payload={id,operationId:t.status==='RECEIVED'?t.receiptOperationId:lifecycleRecordId()};
  }
  saved={uid,role,project,action,payload};const raw=JSON.stringify(saved),prior=sessionStorage.getItem(key);
  if(prior!==null){const concurrent=JSON.parse(prior);if(concurrent.uid!==uid||concurrent.role!==role||concurrent.project!==project)throw Error('原操作暫存已變更。');saved=concurrent;}
  else{sessionStorage.setItem(key,raw);if(sessionStorage.getItem(key)!==raw)throw Error('無法保存原調撥意圖，尚未送出。');}
 }
 check();functions.useEmulator('127.0.0.1',5001);
 const response=await functions.httpsCallable(action==='HANDOFF'?'handoffOrderTransfer':action==='DISPATCH'?'dispatchOrderTransfer':'receiveOrderTransfer')(saved.payload);check();const r=response?.data;
 if(!['applied','already-applied'].includes(r?.status)||r.action!==action||r.id!==id||r.actorUid!==uid||r.actorRole!==role
  ||r.operationId!==(action!=='RECEIVE'?id:saved.payload.operationId))throw Error('訂單調撥回覆無法核對，請保留原操作。');
 const snap=await db.collection('stockTransfers').doc(id).get({source:'server'});check();const t=snap.exists?snap.data():null;
 if(!t||t.id!==id||!t.orderTransferIntentHash||t.kind!==(action==='HANDOFF'?'HANDOFF':'TRANSFER')||!(action==='HANDOFF'?t.status==='RECEIVED':['IN_TRANSIT','RECEIVED'].includes(t.status)))throw Error('找不到可核對的原調撥憑證。');
 if(action!=='RECEIVE'?(['orderId','itemId','fromWarehouseId','toWarehouseId','qty'].some(field=>t[field]!==saved.payload[field])||t.createdByUid!==uid||t.createdByRole!==role||JSON.stringify(t.deliveryPlan)!==JSON.stringify(saved.payload.expectedPlan))
  :(t.status!=='RECEIVED'||t.receiptOperationId!==saved.payload.operationId||t.receivedByUid!==uid||t.receivedByRole!==role))throw Error('原調撥憑證與操作不一致。');
 if(action==='HANDOFF'&&(t.toWarehouseId!=='custody-'+t.ownerUid||t.receivedByUid!==uid||t.receivedByRole!==role))throw Error('原業務交接憑證無法核對。');
 const stored=JSON.parse(sessionStorage.getItem(key)||'null');if(JSON.stringify(stored)!==JSON.stringify({uid:saved.uid,role:saved.role,project:saved.project,action:saved.action,payload:saved.payload}))throw Error('原操作暫存已變更，請保留核對。');
 sessionStorage.removeItem(key);return {...t,affectedOrderIds:[t.orderId]};
}
