// One immutable intent per supply; no client inventory writes in this bridge.
function cancelledPurchasePendingKey(id){return 'keep-purchase:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(id);}
function pendingCancelledPurchase(id){
 const raw=sessionStorage.getItem(cancelledPurchasePendingKey(id));if(raw===null)return null;
 try{const p=JSON.parse(raw);
  if(p.uid!==currentUser?.uid||p.role!==currentUserRole||p.intent?.supplyId!==id
   ||!['demo-yushin','preview-20135'].includes(p.project)||typeof p.intent.expectedDirect!=='boolean'
   ||typeof p.intent.warehouseId!=='string'||!p.intent.warehouseId
   ||!/^[a-zA-Z0-9_-]{12,96}$/.test(p.intent.operationId))throw Error('invalid');
  return p;
 }catch(_){throw Error('前次採購轉備庫尚未確認，請保留暫存並使用原帳號與角色。');}
}
function cancelledPurchaseBackendRequired(id){
 return (typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview')
  ||globalThis.YUSHIN_CANCELLED_PURCHASE_EMULATOR===true
  ||sessionStorage.getItem(cancelledPurchasePendingKey(id))!==null;
}
function cancelledPurchaseTransport(){
 const emulator=globalThis.YUSHIN_CANCELLED_PURCHASE_EMULATOR===true,project=emulator?'demo-yushin':'preview-20135';
 if(typeof firebase==='undefined'||!firebase.auth||!firebase.functions)throw Error('採購後端尚未準備完成，禁止回退舊交易。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1'),uid=currentUser?.uid,role=currentUserRole;
 const local=h=>h==='localhost'||h==='127.0.0.1';
 const check=()=>{
  const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'&&globalThis.YUSHIN_PREVIEW_CANCELLED_PURCHASE===true;
  if((!emulator&&!preview)||emulator!==(globalThis.YUSHIN_CANCELLED_PURCHASE_EMULATOR===true)
   ||(emulator?!local(globalThis.location?.hostname):!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(globalThis.location?.hostname))
   ||firebase.app().options?.projectId!==project||auth.app?.options?.projectId!==project
   ||functions.app?.options?.projectId!==project||db.app?.options?.projectId!==project
   ||(emulator?(!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099):!!auth.emulatorConfig))
   throw Error('採購環境或旗標已變更，請保留原操作，禁止改用舊交易。');
  if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
   ||!['admin','purchaser'].includes(role)||!canCreatePurchaseOrderCapability())throw Error('登入身分或採購權限已變更。');
 };
 check();return {uid,role,project,functions,emulator,check};
}
async function commitCancelledPurchaseBackend(id,input){
 const {uid,role,project,functions,emulator,check}=cancelledPurchaseTransport();
 const key=cancelledPurchasePendingKey(id);let saved=pendingCancelledPurchase(id);
 if(saved){
  if(saved.project!==project)throw Error('前次採購處理屬於其他專案，請回原環境核對。');
  if(input&&(input.supplyId!==id||input.warehouseId!==saved.intent.warehouseId||input.expectedDirect!==saved.intent.expectedDirect))
   throw Error('尚有未確認採購處理，請使用原倉庫與原收貨方式確認。');
 }else{
  if(!input||input.supplyId!==id||typeof input.expectedDirect!=='boolean'
   ||typeof input.warehouseId!=='string'||!input.warehouseId||input.warehouseId.includes('/'))throw Error('原採購或收貨倉不正確。');
  const intent={supplyId:id,warehouseId:input.warehouseId,expectedDirect:input.expectedDirect,operationId:lifecycleRecordId()};
  if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId))throw Error('無法建立有效操作識別碼。');
  saved={uid,role,project,intent};const raw=JSON.stringify(saved);sessionStorage.setItem(key,raw);
  if(sessionStorage.getItem(key)!==raw)throw Error('無法保存原操作，尚未送出。');
 }
 check();if(emulator)functions.useEmulator('127.0.0.1',5001);
 const response=await functions.httpsCallable('keepV2CancelledPurchaseStock')(saved.intent);check();
 const r=response?.data;
 if(!['applied','already-applied'].includes(r?.status)||r.supplyId!==id||r.operationId!==saved.intent.operationId
  ||r.actorUid!==uid||r.actorRole!==role)throw Error('採購處理回覆無法核對，請保留原操作。');
 const snap=await db.collection('supplyOrders').doc(id).get({source:'server'});check();
 const supply=snap.exists?snap.data():null;
 if(!supply||supply.customerCancellationDisposition!=='KEEP_STOCK'||supply.keepStockOperationId!==saved.intent.operationId
  ||supply.customerCancellationResolvedBy!==uid||supply.keepStockActorRole!==role||!supply.keepStockIntentHash
  ||(saved.intent.expectedDirect&&(supply.originalFulfillmentType!=='DIRECT_SHIP'||supply.fulfillmentType!=='WAREHOUSE'||supply.warehouseId!==saved.intent.warehouseId)))
  throw Error('原採購憑證尚未核對，請以原操作再次確認。');
 const remaining=sessionStorage.getItem(key);
 if(remaining!==null&&remaining!==JSON.stringify(saved))throw Error('採購暫存已變更，請保留核對。');
 sessionStorage.removeItem(key);return {...supply,id};
}
