// Only the trusted Admin SDK Callable may write manual inventory and counts.
// Keep the exact intent locally until the backend receipt has been verified.
function manualStockPendingKey(operationId){
 return 'manual-stock:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(operationId);
}
function manualStockPendingOperations(){
 if(typeof sessionStorage==='undefined')return [];
 const uid=currentUser?.uid;
 if(!uid)return [];
 const prefix='manual-stock:'+encodeURIComponent(uid)+':',pending=[];
 for(let i=0;i<sessionStorage.length;i++){
  const key=sessionStorage.key(i);
  if(!key?.startsWith(prefix))continue;
  let saved;
  try{saved=JSON.parse(sessionStorage.getItem(key));}catch(_){throw Error('有無法讀取的庫存待確認紀錄，請聯絡管理員，勿重複提交。');}
  if(!saved||saved.uid!==uid||!['MANUAL_INVENTORY','INVENTORY_COUNT'].includes(saved.kind)
   ||saved.role!==currentUserRole||!saved.payload?.operationId
   ||manualStockPendingKey(saved.payload.operationId)!==key)
   throw Error('庫存待確認紀錄與目前帳號不一致，請聯絡管理員，勿重複提交。');
  pending.push(saved);
 }
 return pending;
}
async function resolveManualStockPendingOperations(){
 const pending=manualStockPendingOperations();
 for(const saved of pending){
  // Reuse the exact durable intent and operation ID. Backend idempotency ensures
  // a completed request is verified, never applied for a second time.
  await commitManualStockBackend(saved.kind,saved.payload,
   {actorUid:saved.uid,actorRole:saved.role,onStockCommitted:invalidateWarehouseStockCache});
 }
 return pending.length;
}
function manualStockBackendContext(kind){
 const emulator=globalThis.YUSHIN_MANUAL_STOCK_EMULATOR===true;
 const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
  &&globalThis.YUSHIN_PREVIEW_MANUAL_STOCK===true;
 const production=typeof productionTransactionBackendEnabled==='function'
  &&productionTransactionBackendEnabled(kind);
 const required=typeof productionTransactionBackendRequired==='function'
  &&productionTransactionBackendRequired(kind);
 if(!emulator&&!preview&&!production)throw Error('人工庫存／盤點後端尚未啟用，禁止瀏覽器直接修改庫存。');
 if(required&&!production&&!emulator&&!preview)throw Error('庫存新舊版切換尚未完成，請保留原操作。');
 if(typeof firebase==='undefined'||!firebase.auth||!firebase.functions||typeof db==='undefined')
  throw Error('可信任庫存後端未載入。');
 const uid=currentUser?.uid,role=currentUserRole,auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
 const project=emulator?'demo-yushin':production?'yu-shing-company':'preview-20135';
 const local=host=>host==='localhost'||host==='127.0.0.1';
 const check=()=>{
  const path=String(globalThis.location?.pathname||'');
  if(!uid||currentUser?.uid!==uid||currentUserRole!==role||auth.currentUser?.uid!==uid
   ||!['admin','purchaser','warehouse'].includes(role)||!canEditPage('inventory')
   ||firebase.app().options?.projectId!==project||auth.app?.options?.projectId!==project
   ||functions.app?.options?.projectId!==project||db.app?.options?.projectId!==project
   ||(emulator?(!local(globalThis.location?.hostname)||!local(auth.emulatorConfig?.host)
     ||auth.emulatorConfig?.port!==9099):!!auth.emulatorConfig)
   ||(production&&!(globalThis.location?.origin==='https://sstonetw-source.github.io'
      &&(path==='/yushin-system'||path.startsWith('/yushin-system/'))))
   ||(preview&&!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(globalThis.location?.hostname))
   ||(!emulator&&!preview&&!(typeof productionTransactionBackendEnabled==='function'
       &&productionTransactionBackendEnabled(kind))))
   throw Error('庫存操作環境、帳號或權限已變更，請以原操作 ID 核對。');
 };
 check();return {uid,role,project,functions,emulator,check};
}
async function commitManualStockBackend(kind,payload,{actorUid,actorRole,onStockCommitted=null}={}){
 if(!['MANUAL_INVENTORY','INVENTORY_COUNT'].includes(kind)||!payload||typeof payload!=='object')throw Error('庫存操作內容不正確。');
 const id=payload.operationId;
 if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{12,96}$/.test(id))throw Error('庫存操作 ID 不正確。');
 if(typeof ensureReservationFunctionsCompat==='function')await ensureReservationFunctionsCompat();
 const {uid,role,project,functions,emulator,check}=manualStockBackendContext(kind);
 if(uid!==actorUid||role!==actorRole)throw Error('庫存操作身分已變更。');
 const key=manualStockPendingKey(id),raw=sessionStorage.getItem(key),intent=JSON.stringify({uid,role,project,kind,payload});
 if(raw!==null&&raw!==intent)throw Error('同一操作 ID 尚有不同內容待核對，請勿產生新的異動。');
 if(raw===null){sessionStorage.setItem(key,intent);if(sessionStorage.getItem(key)!==intent)throw Error('庫存操作暫存失敗，尚未提交。');}
 check();if(emulator)functions.useEmulator('127.0.0.1',5001);
 const callable=kind==='MANUAL_INVENTORY'?'commitV2ManualInventory':'commitV2InventoryCount';
 const response=await functions.httpsCallable(callable)(payload);check();const data=response?.data;
 if(!['applied','already-applied'].includes(data?.status)||data.operationId!==id||data.productKey!==payload.productKey
  ||data.warehouseId!==payload.warehouseId||data.actorUid!==uid||data.actorRole!==role
  ||typeof data.delta!=='number'||!Number.isFinite(data.delta))
  throw Error('後端庫存結果無法確認，請保留原操作 ID。');
 const snap=await db.collection('inventoryMovements').doc(id).get({source:'server'});check();
 const receipt=snap.exists?snap.data():null;
 if(!receipt||receipt.sourceId!==id||receipt.productKey!==payload.productKey
  ||receipt.warehouseId!==payload.warehouseId||receipt.actorUid!==uid||receipt.actorRole!==role
  ||receipt.qty!==data.delta||!receipt.intentHash
  ||receipt.operation!==(kind==='MANUAL_INVENTORY'?'manual-adjustment':'quantity-editor'))
  throw Error('庫存憑證尚未核對完成，請使用原操作 ID 重試。');
 if(sessionStorage.getItem(key)!==intent)throw Error('庫存操作暫存已變更，請勿重送。');
 sessionStorage.removeItem(key);
 try{onStockCommitted?.(payload.productKey,payload.warehouseId);}catch(error){
  error.operationId=id;error.manualStockCommitted=true;throw error;
 }
 return {operationId:id,productKey:payload.productKey,warehouseId:payload.warehouseId,delta:data.delta,
  replayed:data.status==='already-applied'};
}
