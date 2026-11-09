// Only the trusted Admin SDK Callable may write manual inventory and counts.
// Full intent lives only in the tab session; durable recovery records omit
// protected initial-stock acquisition cost. Neither record is a cache.
function manualStockPendingKey(operationId){
 return 'manual-stock:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(operationId);
}
function manualStockCheckpoint({uid,role,project,kind,payload}){
 const safePayload={...payload};delete safePayload.unitCost;
 return JSON.stringify({uid,role,project,kind,payload:safePayload,
  costProtected:Object.prototype.hasOwnProperty.call(payload,'unitCost')});
}
function manualStockPendingOperations(){
 if(typeof localStorage==='undefined')return [];
 const uid=currentUser?.uid;
 if(!uid)return [];
 const prefix='manual-stock:'+encodeURIComponent(uid)+':',pending=[];
 for(let i=0;i<localStorage.length;i++){
  const key=localStorage.key(i);
  if(!key?.startsWith(prefix))continue;
  let saved;
  try{saved=JSON.parse(localStorage.getItem(key));}catch(_){throw Error('有無法讀取的庫存待確認紀錄，請聯絡管理員，勿重複提交。');}
  if(!saved||saved.uid!==uid||!['MANUAL_INVENTORY','INVENTORY_COUNT'].includes(saved.kind)
   ||saved.role!==currentUserRole||!saved.payload?.operationId
   ||manualStockPendingKey(saved.payload.operationId)!==key)
   throw Error('庫存待確認紀錄與目前帳號不一致，請聯絡管理員，勿重複提交。');
  const inTab=typeof sessionStorage!=='undefined'?sessionStorage.getItem(key):null;
  if(inTab!==null){
   let full;
   try{full=JSON.parse(inTab);}catch(_){throw Error('此分頁的庫存原始內容無法讀取，請停止新交易並核對原操作 ID。');}
   if(manualStockCheckpoint(full)!==localStorage.getItem(key))
    throw Error('庫存原操作內容與待確認紀錄不一致，請停止新交易。');
   pending.push(full);
  }else pending.push({...saved,needsReceiptOnly:saved.costProtected===true});
 }
 return pending;
}
async function resolveManualStockPendingOperations(){
 const pending=manualStockPendingOperations();
 for(const saved of pending){
  if(saved.needsReceiptOnly){
   // A closed tab has lost the cost-bearing payload. Verify the server receipt
   // without ever fabricating its protected cost or resubmitting a new intent.
   const {uid,role,project,check}=manualStockBackendContext(saved.kind);
   if(uid!==saved.uid||role!==saved.role||project!==saved.project)throw Error('帳號與待確認庫存操作不一致。');
   const id=saved.payload.operationId,key=manualStockPendingKey(id);
   const snap=await db.collection('inventoryMovements').doc(id).get({source:'server'});check();
   const receipt=snap.exists?snap.data():null;
   if(!receipt||receipt.sourceId!==id||receipt.productKey!==saved.payload.productKey
    ||receipt.warehouseId!==saved.payload.warehouseId||receipt.actorUid!==uid||receipt.actorRole!==role
    ||!receipt.intentHash||receipt.type!=='initial'||receipt.qty!==saved.payload.qty
    ||receipt.adjustmentIntent?.lotNo!==saved.payload.lotNo
    ||receipt.adjustmentIntent?.expiryDate!==saved.payload.expiryDate
    ||receipt.operation!=='manual-adjustment')
    throw Error('原期初庫存憑證尚未確認，操作 ID：'+id+'。請聯絡管理員核對，勿重新建檔。');
   localStorage.removeItem(key);
   invalidateWarehouseStockCache(saved.payload.productKey,saved.payload.warehouseId);
  }else{
   // Reuse the exact original intent and operation ID; no new stock writer.
   await commitManualStockBackend(saved.kind,saved.payload,
    {actorUid:saved.uid,actorRole:saved.role,onStockCommitted:invalidateWarehouseStockCache});
  }
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
 const key=manualStockPendingKey(id),intent=JSON.stringify({uid,role,project,kind,payload}),
  checkpoint=manualStockCheckpoint({uid,role,project,kind,payload}),raw=localStorage.getItem(key),
  inTab=typeof sessionStorage!=='undefined'?sessionStorage.getItem(key):null;
 if(raw!==null&&raw!==checkpoint||inTab!==null&&inTab!==intent)
  throw Error('同一操作 ID 尚有不同內容待核對，請勿產生新的異動。');
 if(raw===null){localStorage.setItem(key,checkpoint);if(localStorage.getItem(key)!==checkpoint)throw Error('庫存操作暫存失敗，尚未提交。');}
 if(typeof sessionStorage==='undefined')throw Error('無法保存期初庫存原始內容，請停止操作。');
 if(inTab===null){sessionStorage.setItem(key,intent);if(sessionStorage.getItem(key)!==intent)throw Error('庫存原始內容暫存失敗，尚未提交。');}
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
 if(localStorage.getItem(key)!==checkpoint||sessionStorage.getItem(key)!==intent)throw Error('庫存操作暫存已變更，請勿重送。');
 localStorage.removeItem(key);
 sessionStorage.removeItem(key);
 try{onStockCommitted?.(payload.productKey,payload.warehouseId);}catch(error){
  error.operationId=id;error.manualStockCommitted=true;throw error;
 }
 return {operationId:id,productKey:payload.productKey,warehouseId:payload.warehouseId,delta:data.delta,
  replayed:data.status==='already-applied'};
}
