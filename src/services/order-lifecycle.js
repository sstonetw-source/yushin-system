// Central authority for cancellation/restoration of an order and its stock holds.
function lifecycleProtectedMode(){
 return globalThis.YUSHIN_V2_LIFECYCLE_EMULATOR===true
  ||globalThis.YUSHIN_PREVIEW_ORDER_LIFECYCLE===true
  ||(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview');
}
function assertNoPendingV2LifecycleBeforeLegacyWrite(orderId){
 if(typeof sessionStorage==='undefined'||!currentUser?.uid)return;
 const key='v2-lifecycle:'+encodeURIComponent(currentUser.uid)+':'+encodeURIComponent(orderId);
 if(sessionStorage.getItem(key)!==null)
  throw Error('前次 v2 取消／恢復尚未確認，禁止改用舊交易；請恢復原受控環境以原識別碼核對。');
}
async function setOrderLifecycleStatus(orderId,nextStatus,details=null) {
    if(lifecycleProtectedMode())return setV2OrderLifecycleEmulator(orderId,nextStatus,details);
    assertNoPendingV2LifecycleBeforeLegacyWrite(orderId);
    if(!['normal','cancelled'].includes(nextStatus))throw new Error('不支援的訂單狀態。');
    // Quick actions change status only; the form may also amend date/reason.
    const date=details===null?localDateString():details.date;
    const reason=details===null?'':String(details.reason||'').trim();
    if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)
        ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
        ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)
        throw new Error('請填寫正確的狀態日期。');
    const actor=deliveryActor(),at=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
        const statusChanged=previous.status!==nextStatus;
        if (!statusChanged&&(details===null||(previous.date===date&&previous.reason===reason))) {
            savedOrder=order;
            return;
        }
        if(statusChanged&&nextStatus==='cancelled'&&deliveryProgressInfo(order).remaining<=0)throw new Error('訂單已無剩餘未送貨數量，請重新確認。');
         const history = {
            action: statusChanged&&nextStatus === 'normal' ? 'restore' : 'status_change',
            before: previous,
            after: { status: nextStatus, date, reason },
            by: actor,
            at
        };
        const reservationLifecycle=statusChanged
            ?await adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor):null;
        const updates = {
            items:reservationLifecycle?.items||order.items||[],
            itemCount:(reservationLifecycle?.items||normalizedOrderItems(order)).length,
            orderSchemaVersion:2,
            status: nextStatus === 'cancelled' ? BUSINESS_STATUS.CANCELLED : BUSINESS_STATUS.ACTIVE,
            orderStatus: nextStatus,
            orderStatusDate: date,
            orderStatusReason: reason,
            updatedAt: history.at,
            orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(history)
        };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, orderLifecycleHistory: [...(order.orderLifecycleHistory || []), history] };
    });
    return savedOrder;
}

// Transport only: the existing backend lifecycle Service owns every stock change.
function pendingV2OrderLifecycle(orderId){
 if(!lifecycleProtectedMode())return null;
 const raw=sessionStorage.getItem('v2-lifecycle:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(orderId));
 if(!raw)return null;
 try{
  const intent=JSON.parse(raw);
  if(!intent||intent.orderId!==orderId||intent.actorUid!==currentUser?.uid||intent.actorRole!==currentUserRole
   ||!['normal','cancelled'].includes(intent.nextStatus)||!/^\w[\w-]{11,95}$/.test(intent.operationId||'')
   ||!Array.isArray(intent.itemIds)||!intent.itemIds.length||intent.itemIds.length>5
   ||!Array.isArray(intent.warehouseIds)||![0,2].includes(intent.warehouseIds.length))throw Error('invalid pending lifecycle');
  return intent;
 }catch(_){throw Error('前次取消／恢復結果尚未確認，請使用原帳號與角色核對。');}
}
async function setV2OrderLifecycleEmulator(orderId,nextStatus,details=null){
 const local=host=>host==='localhost'||host==='127.0.0.1';
 const emulator=globalThis.YUSHIN_V2_LIFECYCLE_EMULATOR===true;
 const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
  &&globalThis.YUSHIN_PREVIEW_ORDER_LIFECYCLE===true;
 const host=String(globalThis.location?.hostname||'').toLowerCase();
 if((!emulator&&!preview)||(emulator&&!local(host))
  ||(preview&&!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(host))
  ||typeof firebase==='undefined'||!firebase.auth||!firebase.functions)
  throw Error('取消／恢復後端尚未在此 Preview／Emulator 獲准啟用，禁止改用舊交易。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1'),uid=currentUser?.uid,role=currentUserRole;
 if(emulator){
  if(auth.app?.options?.projectId!=='demo-yushin'||functions.app?.options?.projectId!=='demo-yushin'
   ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
   throw Error('v2 取消／恢復只允許本機 demo-yushin Auth／Functions Emulator。');
 }else if(firebase.app().options?.projectId!=='preview-20135'
  ||auth.app?.options?.projectId!=='preview-20135'
  ||functions.app?.options?.projectId!=='preview-20135'
  ||typeof db==='undefined'||db.app?.options?.projectId!=='preview-20135'
  ||!!auth.emulatorConfig)
  throw Error('取消／恢復 Auth、Functions 與資料庫專案不一致，未提交交易。');
 const check=()=>{
  if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
   ||!['admin','sales','engineer'].includes(role)||!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))
   throw Error('登入身分或取消／恢復權限已變更。');
 };
 check();
 const key='v2-lifecycle:'+encodeURIComponent(uid)+':'+encodeURIComponent(orderId);
 let frozen=pendingV2OrderLifecycle(orderId);
 if(frozen){
  if(frozen.nextStatus!==nextStatus||(details!==null&&(frozen.date!==details.date||frozen.reason!==String(details.reason||'').trim())))
   throw Error('尚有未確認的取消／恢復，請先以原狀態、日期與原因核對結果。');
 }else{
  const date=details===null?localDateString():details.date,reason=String(details?.reason||'').trim();
  if(!['normal','cancelled'].includes(nextStatus)||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)
   ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||reason.length>1000)
   throw Error('請填寫正確的目標狀態、日期與原因。');
  const snapshot=await db.collection('orders').doc(orderId).get({source:'server'});check();
  if(!snapshot.exists)throw Error('找不到原始訂單。');
  const order=snapshot.data(),items=order.items;
  if(order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId||!Array.isArray(items)
   ||!items.length||items.length>5||items.some(row=>typeof row?.itemId!=='string'||!row.itemId||row.itemId.includes('/'))
   ||new Set(items.map(row=>row.itemId)).size!==items.length)throw Error('訂單尚未具備完整的 v2 取消／恢復來源。');
  if(normalizedOrderStatus(order)===nextStatus)throw Error('訂單已是此狀態；v2 試點不提供單獨更正日期／原因。');
  let warehouseIds;
  for(const item of items){
   if(String(item.productType||item.type||'').trim().toUpperCase()==='SERVICE')continue;
   const snap=await db.collection('inventoryReservations').doc(orderId+'__'+item.itemId).get({source:'server'});check();
   const ledger=snap.exists?snap.data():null,candidates=ledger?.lifecycleWarehouseIds;
   if(!ledger||ledger.locationSchemaVersion!==2||ledger.orderId!==orderId||ledger.itemId!==item.itemId
    ||!Array.isArray(candidates)||candidates.length!==2||new Set(candidates).size!==2
    ||candidates.some(id=>typeof id!=='string'||!id||id.includes('/')))
    throw Error('缺少原始 v2 雙倉來源，不能以指定倉或目前位置猜測。');
   const sorted=[...candidates].sort();
   if(warehouseIds&&JSON.stringify(warehouseIds)!==JSON.stringify(sorted))throw Error('整單品項的原候選倉不一致。');
   warehouseIds=sorted;
  }
  frozen={orderId,itemIds:items.map(row=>row.itemId).sort(),warehouseIds:warehouseIds||[],nextStatus,date,reason,
   operationId:'lifecycle_'+globalThis.crypto.randomUUID().replaceAll('-','_'),
   syncAttemptId:order.inventoryReservationAttemptId,actorUid:uid,actorRole:role};
  sessionStorage.setItem(key,JSON.stringify(frozen));
 }
 check();if(emulator)functions.useEmulator('127.0.0.1',5001);
 const {actorUid,actorRole,...payload}=frozen;
 const response=await functions.httpsCallable('setV2OrderLifecycle')(payload);check();
 const result=response?.data;
 if(!['applied','already-applied'].includes(result?.status)||result.orderId!==orderId||result.nextStatus!==frozen.nextStatus
  ||result.receiptId!=='single-v2-lifecycle-'+frozen.operationId||!Array.isArray(result.items)
  ||JSON.stringify(result.items.map(row=>row.itemId).sort())!==JSON.stringify(frozen.itemIds)
  ||!['completed','recovery-pending','not-applicable'].includes(result.postCommitAllocation?.status))
  throw Error('取消／恢復回覆無法核對，請保留原識別碼確認結果。');
 const refreshed=await db.collection('orders').doc(orderId).get({source:'server'});check();
 if(!refreshed.exists)throw Error('取消／恢復已回覆成功但訂單回讀失敗，請核對原操作。');
 const savedOrder=refreshed.data();
 // An old receipt may be replayed after a later restore; display the current
 // authoritative order, never replace it with the old target status.
 if(!(savedOrder.orderLifecycleHistory||[]).some(row=>row.operationId===frozen.operationId
  &&row.by===uid&&row.actorRole===role&&row.after?.status===frozen.nextStatus
  &&row.after?.date===frozen.date&&row.after?.reason===frozen.reason))
  throw Error('訂單尚未讀回原取消／恢復憑證，請保留識別碼確認結果。');
 Object.defineProperty(savedOrder,'v2LifecycleOutcome',{value:{warehouseIds:frozen.warehouseIds,postCommitAllocation:result.postCommitAllocation}});
 sessionStorage.removeItem(key);
 return savedOrder;
}

