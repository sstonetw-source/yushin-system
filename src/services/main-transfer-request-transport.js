function mainTransferPendingKey(id){return 'main-transfer:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(id);}
function pendingMainTransferOperation(id){
 const raw=sessionStorage.getItem(mainTransferPendingKey(id));if(raw===null)return null;
 try{const p=JSON.parse(raw);
  if(p.uid!==currentUser?.uid||p.role!==currentUserRole||p.payload?.id!==id
   ||!['CREATE','CANCEL'].includes(p.action)||!['demo-yushin','preview-20135'].includes(p.project)
   ||(p.action==='CANCEL'&&!/^[a-zA-Z0-9_-]{12,96}$/.test(p.payload.operationId)))throw Error('invalid');
  return p;
 }catch(_){throw Error('前次主倉調撥需求結果未確認，請保留暫存並使用原帳號與角色。');}
}
function mainTransferBackendRequired(id){
 return (typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview')||globalThis.YUSHIN_MAIN_TRANSFER_REQUEST_EMULATOR===true
  ||sessionStorage.getItem(mainTransferPendingKey(id))!==null;
}
function mainTransferRequestTransport(){
 const emulator=globalThis.YUSHIN_MAIN_TRANSFER_REQUEST_EMULATOR===true,project=emulator?'demo-yushin':'preview-20135';
 if(typeof firebase==='undefined'||!firebase.auth||!firebase.functions)throw Error('調撥需求後端尚未準備完成，禁止回退舊交易。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1'),uid=currentUser?.uid,role=currentUserRole;
 const local=h=>h==='localhost'||h==='127.0.0.1';
 const check=()=>{
  const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'&&globalThis.YUSHIN_PREVIEW_MAIN_TRANSFER_REQUEST===true;
  if((!emulator&&!preview)||emulator!==(globalThis.YUSHIN_MAIN_TRANSFER_REQUEST_EMULATOR===true)
   ||(emulator?!local(globalThis.location?.hostname):!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(globalThis.location?.hostname))
   ||firebase.app().options?.projectId!==project||auth.app?.options?.projectId!==project
   ||functions.app?.options?.projectId!==project||db.app?.options?.projectId!==project
   ||(emulator?(!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099):!!auth.emulatorConfig))
   throw Error('主倉調撥環境或旗標已變更，禁止改用舊交易，請保留原操作。');
  if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
   ||!['admin','purchaser'].includes(role)||!canManageInventoryStockPolicy()||!canEditPage('inventory'))throw Error('登入身分或主倉備貨權限已變更。');
 };
 check();return {uid,role,project,functions,emulator,check};
}
async function commitMainTransferRequestBackend(id,action,input){
 const actorUid=currentUser?.uid,actorRole=currentUserRole;
 if(typeof ensureReservationFunctionsCompat==='function')await ensureReservationFunctionsCompat();
 if(currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw Error('載入後端期間登入身分已變更，尚未提交。');
 const {uid,role,project,functions,emulator,check}=mainTransferRequestTransport();
 const key=mainTransferPendingKey(id);let saved=pendingMainTransferOperation(id);
 if(saved){
  if(saved.project!==project)throw Error('前次調撥需求屬於其他專案，請回原環境核對。');
  if(input){const original={...saved.payload};if(saved.action==='CANCEL')delete original.operationId;
   if(action!==saved.action||JSON.stringify(original)!==JSON.stringify(input))throw Error('尚有未確認調撥需求，請先確認原操作與原數量。');}
 }else{
  if(!input||input.id!==id||!['CREATE','CANCEL'].includes(action))throw Error('沒有原調撥操作可恢復。');
  if(typeof id!=='string'||!id||id!==id.trim()||id.includes('/')||id.length>128)throw Error('調撥識別碼不正確。');
  if(action==='CREATE'&&(typeof input.qty!=='number'||!Number.isFinite(input.qty)||input.qty<=0||input.qty>1000000
   ||[input.inventoryId,input.fromWarehouseId,input.toWarehouseId].some(v=>typeof v!=='string'||!v||v.includes('/'))
   ||input.fromWarehouseId===input.toWarehouseId))throw Error('來源、主倉或調回數量不正確。');
  const payload=action==='CREATE'?{...input}:{id,operationId:lifecycleRecordId()};
  if(action==='CANCEL'&&!/^[a-zA-Z0-9_-]{12,96}$/.test(payload.operationId))throw Error('取消操作識別碼不正確。');
  saved={uid,role,project,action,payload};const raw=JSON.stringify(saved);sessionStorage.setItem(key,raw);
  if(sessionStorage.getItem(key)!==raw)throw Error('無法保存調撥原操作，尚未送出。');
 }
 check();if(emulator)functions.useEmulator('127.0.0.1',5001);
 const p=saved.payload,name=saved.action==='CREATE'?'createV2MainTransferRequest':'cancelV2MainTransferRequest';
 const response=await functions.httpsCallable(name)(p);check();const r=response?.data;
 if(!['applied','already-applied'].includes(r?.status)||r.action!==saved.action||r.id!==id
  ||r.operationId!==(saved.action==='CREATE'?id:p.operationId)||r.actorUid!==uid||r.actorRole!==role)throw Error('調撥需求回覆無法核對，請保留原操作。');
 const snap=await db.collection('stockTransferRequests').doc(id).get({source:'server'});check();const request=snap.exists?snap.data():null;
 if(!request)throw Error('找不到原調撥憑證，請以原操作核對。');
 if(saved.action==='CREATE'){
  if(request.inventoryId!==p.inventoryId||request.fromWarehouseId!==p.fromWarehouseId||request.toWarehouseId!==p.toWarehouseId
   ||request.qty!==p.qty||request.createdByUid!==uid||request.createdByRole!==role||!request.requestIntentHash)
   throw Error('調撥需求憑證與原操作不一致。');
 }else if(request.status!=='CANCELLED'||request.cancelOperationId!==p.operationId
  ||request.cancelledByUid!==uid||request.cancelledByRole!==role||!request.cancelIntentHash)throw Error('取消需求憑證與原操作不一致。');
 const remaining=sessionStorage.getItem(key);if(remaining!==null&&remaining!==JSON.stringify(saved))throw Error('調撥暫存已變更，請保留核對。');
 sessionStorage.removeItem(key);return {...request,id};
}
function pendingMainTransferOperations(){
 const prefix='main-transfer:'+encodeURIComponent(currentUser?.uid||'')+':',rows=[];
 for(let i=0;i<sessionStorage.length;i++){
  const key=sessionStorage.key(i);if(!key?.startsWith(prefix))continue;
  try{const id=decodeURIComponent(key.slice(prefix.length));try{const p=pendingMainTransferOperation(id);if(p)rows.push({id,action:p.action});}
   catch(error){rows.push({id,error:error.message});}}
  catch(_){rows.push({id:'',error:'調撥暫存識別碼無法讀取，請保留暫存核對。'});}
 }
 return rows;
}
