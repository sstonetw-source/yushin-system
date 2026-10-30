// Commercial request transport only. Physical receipt owns stock separately.
function customerReturnRequestBackendEnabled(){
 return globalThis.YUSHIN_V2_RETURN_REQUEST_EMULATOR===true
  ||(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
   &&globalThis.YUSHIN_PREVIEW_CUSTOMER_RETURN_REQUEST===true);
}
function customerReturnRequestPendingKey(orderId){
 return 'v2-return-request:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(orderId);
}
function customerReturnRequestBackendRequired(orderId){
 return (typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview')
  ||customerReturnRequestBackendEnabled()||sessionStorage.getItem(customerReturnRequestPendingKey(orderId))!==null;
}
function pendingCustomerReturnRequestOperation(orderId){
 const raw=sessionStorage.getItem(customerReturnRequestPendingKey(orderId));if(raw===null)return null;
 try{
  const saved=JSON.parse(raw),p=saved.payload;
  if(saved.actorUid!==currentUser?.uid||saved.actorRole!==currentUserRole
   ||!['REQUEST','WITHDRAW'].includes(saved.action)||!p||p.orderId!==orderId
   ||typeof p.operationId!=='string'||!/^[a-zA-Z0-9_-]{12,96}$/.test(p.operationId)
   ||typeof p.syncAttemptId!=='string'||!p.syncAttemptId
   ||!['demo-yushin','preview-20135'].includes(saved.backendProject))throw Error('invalid checkpoint');
  return saved;
 }catch(_){throw Error('前次退貨申請／撤回結果未確認，請保留暫存並使用原帳號與角色核對。');}
}
function customerReturnRequestTransport(){
 const emulator=globalThis.YUSHIN_V2_RETURN_REQUEST_EMULATOR===true;
 const project=emulator?'demo-yushin':'preview-20135';
 const local=host=>host==='localhost'||host==='127.0.0.1';
 if(typeof firebase==='undefined'||!firebase.auth||!firebase.functions)throw Error('退貨申請後端尚未準備完成，禁止改用舊交易。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1'),uid=currentUser?.uid,role=currentUserRole;
 const check=()=>{
  const host=globalThis.location?.hostname;
  if(!customerReturnRequestBackendEnabled()||emulator!==(globalThis.YUSHIN_V2_RETURN_REQUEST_EMULATOR===true)
   ||(emulator?!local(host):!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(host))
   ||firebase.app().options?.projectId!==project||auth.app?.options?.projectId!==project
   ||functions.app?.options?.projectId!==project||db.app?.options?.projectId!==project
   ||(emulator?(!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099):!!auth.emulatorConfig))
   throw Error('退貨申請環境或旗標已變更，請保留原操作；禁止改用舊交易。');
  if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
   ||!['admin','sales','engineer'].includes(role)||!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))
   throw Error('登入身分或退貨申請權限已變更，請使用原帳號與角色。');
 };
 check();return {uid,role,functions,project,emulator,check};
}
function returnRequestInput(action,input){
 const p=action==='REQUEST'?{orderId:input.orderId,itemId:input.itemId,operationId:input.operationId,
  qty:input.qty,date:input.date,reason:String(input.reason??'').trim()}:
  {orderId:input.orderId,requestId:input.requestId};
 if(action==='REQUEST'&&(!Number.isSafeInteger(p.qty)||p.qty<=0||p.qty>1000000
  ||typeof p.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(p.date)
  ||!Number.isFinite(Date.parse(p.date+'T00:00:00Z'))
  ||new Date(p.date+'T00:00:00Z').toISOString().slice(0,10)!==p.date||p.reason.length>1000))
  throw Error('退貨申請日期、數量或原因不正確。');
 return p;
}
async function commitCustomerReturnRequestBackend(orderId,action,input){
 const {uid,role,functions,project,emulator,check}=customerReturnRequestTransport();
 const key=customerReturnRequestPendingKey(orderId);
 let saved=pendingCustomerReturnRequestOperation(orderId);
 const proposed=input===undefined?null:returnRequestInput(action,input);
 if(saved){
  if(saved.backendProject!==project)throw Error('前次退貨申請屬於其他專案，請回原環境核對。');
  if(proposed){
   const original={...saved.payload};delete original.syncAttemptId;
   if(saved.action==='WITHDRAW')delete original.operationId;
   if(saved.action!==action||JSON.stringify(original)!==JSON.stringify(proposed))
    throw Error('尚有未確認的退貨申請／撤回，請先以原資料確認。');
  }
 }else{
  if(!proposed||proposed.orderId!==orderId)throw Error('沒有原退貨操作可恢復。');
  const snap=await db.collection('orders').doc(orderId).get({source:'server'});check();
  if(!snap.exists)throw Error('找不到原訂單。');
  const order=snap.data(),syncAttemptId=order.inventoryReservationAttemptId;
  if(order.inventoryReservationStatus!=='completed'||typeof syncAttemptId!=='string'||!syncAttemptId)
   throw Error('原訂單庫存同步尚未完成。');
  const payload={...proposed,operationId:action==='REQUEST'?proposed.operationId:lifecycleRecordId(),syncAttemptId};
  saved={actorUid:uid,actorRole:role,backendProject:project,action,payload};
  // A competing tab/call may have completed its source read while we awaited.
  const other=pendingCustomerReturnRequestOperation(orderId);
  if(other&&JSON.stringify(other)!==JSON.stringify(saved))throw Error('已有其他未確認的退貨操作，請先確認原操作。');
  const raw=JSON.stringify(saved);sessionStorage.setItem(key,raw);
  if(sessionStorage.getItem(key)!==raw)throw Error('無法保存原退貨操作，尚未送出。');
 }
 check();if(emulator)functions.useEmulator('127.0.0.1',5001);
 const name=saved.action==='REQUEST'?'requestV2CustomerReturn':'withdrawV2CustomerReturnRequest';
 const response=await functions.httpsCallable(name)(saved.payload);check();
 const result=response?.data,p=saved.payload;
 const requestId=saved.action==='REQUEST'?p.operationId:p.requestId;
 if(!['applied','already-applied','not-pending'].includes(result?.status)
  ||(result.status==='not-pending'&&saved.action!=='WITHDRAW')
  ||result.action!==saved.action||result.orderId!==orderId||result.requestId!==requestId
  ||result.operationId!==p.operationId||result.syncAttemptId!==p.syncAttemptId
  ||result.actorUid!==uid||result.actorRole!==role)throw Error('後端退貨回覆無法核對，請保留原操作。');
 const source=await db.collection('orders').doc(orderId).get({source:'server'});check();
 const order=source.exists?source.data():null,record=order?.returnRequests?.find(row=>row.id===requestId);
 if(!record)throw Error('退貨申請憑證尚未核對，請以原操作再次確認。');
 if(saved.action==='REQUEST'){
  if(record.itemId!==p.itemId||record.qty!==p.qty||record.date!==p.date||record.reason!==p.reason
   ||record.settlement!=='CLOSE'||record.createdByUid!==uid||record.createdByRole!==role
   ||record.requestSyncAttemptId!==p.syncAttemptId||!record.requestIntentHash)
   throw Error('退貨申請憑證與原操作不一致。');
 }else if(result.status==='not-pending'){
  if(!['RECEIVED','CANCELLED'].includes(record.status))throw Error('退貨申請狀態尚未確認。');
 }else if(record.status!=='CANCELLED'||record.cancelOperationId!==p.operationId
  ||record.cancelledBy!==uid||record.cancelledByRole!==role||record.cancelledSyncAttemptId!==p.syncAttemptId
  ||!record.cancelIntentHash)throw Error('退貨撤回憑證與原操作不一致。');
 const remaining=sessionStorage.getItem(key);
 if(remaining!==null&&remaining!==JSON.stringify(saved))throw Error('退貨暫存已變更，請保留原操作核對。');
 sessionStorage.removeItem(key);return {...order,id:orderId};
}
