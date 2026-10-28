// Customer acknowledgement never writes physical stock. Preview is opt-in,
// but all Preview delivery mutations remain fail-closed if the gate is off.
function deliveryConfirmationProtectedMode(){
 return globalThis.YUSHIN_V2_DELIVERY_EMULATOR===true
  ||globalThis.YUSHIN_PREVIEW_DELIVERY_CONFIRMATION===true
  ||(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview');
}
function assertNoUnresolvedV2DeliveryBeforeLegacyWrite(orderId){
 if(typeof sessionStorage==='undefined'||!currentUser?.uid)return;
 const key='v2-delivery:'+encodeURIComponent(currentUser.uid)+':'+encodeURIComponent(orderId);
 if(sessionStorage.getItem(key)!==null)
  throw Error('前次 v2 送達仍待確認，禁止改用舊交易；請恢復原受控環境並以相同識別碼核對。');
}
function pendingV2DeliveryConfirmation(orderId){
 if(!deliveryConfirmationProtectedMode())return null;
 const key='v2-delivery:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(orderId);
 const raw=sessionStorage.getItem(key);
 if(!raw)return null;
 try{
  const intent=JSON.parse(raw);
  if(!intent||intent.orderId!==orderId||intent.actorUid!==currentUser?.uid
    ||intent.actorRole!==currentUserRole||!intent.operationId)
    throw Error('invalid pending delivery actor');
  return intent;
 }catch(_){throw Error('前次客戶送達結果尚未確認，請使用原帳號核對，不能重新登錄。');}
}
function v2DeliveryEmulatorTransport(){
 const local=host=>host==='localhost'||host==='127.0.0.1';
 if(globalThis.YUSHIN_V2_DELIVERY_EMULATOR!==true||!local(globalThis.location?.hostname)||typeof firebase==='undefined'||!firebase.auth||!firebase.functions)
  throw Error('v2 送達目前僅限本機 Emulator。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1'),uid=currentUser?.uid,role=currentUserRole;
 if(auth.app?.options?.projectId!=='demo-yushin'||functions.app?.options?.projectId!=='demo-yushin'
   ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
  throw Error('v2 送達只允許本機 demo-yushin Auth／Functions Emulator。');
 const check=()=>{
  if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
   ||!['admin','sales','engineer'].includes(role)
   ||!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))
   throw Error('登入身分或送達作業權限已變更。');
 };
 check();return {uid,role,functions,check};
}
function v2DeliveryConfirmationTransport(){
 if(globalThis.YUSHIN_V2_DELIVERY_EMULATOR===true)
  return {...v2DeliveryEmulatorTransport(),emulator:true};
 const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
  &&globalThis.YUSHIN_PREVIEW_DELIVERY_CONFIRMATION===true;
 const host=String(globalThis.location?.hostname||'').toLowerCase();
 if(!preview||!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(host)
  ||typeof firebase==='undefined'||!firebase.auth||!firebase.functions)
  throw Error('送達確認後端尚未在此 Preview 獲准啟用，禁止改用舊交易。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
 if(firebase.app().options?.projectId!=='preview-20135'
  ||auth.app?.options?.projectId!=='preview-20135'
  ||functions.app?.options?.projectId!=='preview-20135'
  ||typeof db==='undefined'||db.app?.options?.projectId!=='preview-20135'
  ||!!auth.emulatorConfig)
  throw Error('送達確認 Auth、Functions 與資料庫專案不一致，未提交送達。');
 const uid=currentUser?.uid,role=currentUserRole;
 const check=()=>{
  if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
   ||!['admin','sales','engineer'].includes(role)
   ||!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))
   throw Error('登入身分或送達作業權限已變更。');
 };
 check();return {uid,role,functions,check,emulator:false};
}
async function confirmV2ShipmentDeliveryEmulator(orderId,{date,qty,notes='',itemId='',shipmentId='',recordId}){
 const {uid,role,functions,check,emulator}=v2DeliveryConfirmationTransport();
 if(pendingV2DeliveryReversal(orderId))throw Error('尚有未確認的送達撤銷，請先核對原操作。');
 if(!Number.isSafeInteger(qty)||qty<=0||typeof date!=='string'
  ||!/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.test(date)
  ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
  ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date
  ||typeof notes!=='string'||notes.length>1000)
  throw Error('v2 送達數量、日期或備註不正確。');
 const key='v2-delivery:'+encodeURIComponent(uid)+':'+encodeURIComponent(orderId);
 let frozen=pendingV2DeliveryConfirmation(orderId);
 if(frozen){
  if(frozen.quantity!==qty||frozen.date!==date||frozen.notes!==notes
   ||(itemId&&frozen.itemId!==itemId)||(shipmentId&&frozen.shipmentId!==shipmentId))
   throw Error('尚有未確認的送達結果，請以原品項、來源出貨、數量與日期重試。');
 }else{
  if(!/^[a-zA-Z0-9_-]{12,96}$/.test(recordId||''))throw Error('送達操作識別碼不正確。');
  const snapshot=await db.collection('orders').doc(orderId).get({source:'server'});check();
  if(!snapshot.exists)throw Error('找不到原始訂單。');
  const order=snapshot.data(),rows=order.items||[];
  const resolvedItemId=itemId||(rows.length===1?rows[0].itemId:'');
  if(order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId
    ||rows.length<1||rows.length>5||!resolvedItemId)
    throw Error('訂單尚未具備完整的 v2 送達來源。');
  const source=(order.warehouseShipmentRecords||[]).find(s=>s.id===shipmentId&&s.itemId===resolvedItemId);
  if(!source)throw Error('請先選擇這個品項的實際出貨紀錄。');
  const projected=globalThis.YushinFulfillment.projectOrderShipmentReturns({orderId,items:rows,
   shipments:order.warehouseShipmentRecords||[],deliveries:order.deliveryRecords||[],returns:order.returnRecords||[]});
  const part=projected.items.find(row=>row.itemId===resolvedItemId);
  const remaining=part?.shipments.find(row=>row.shipmentId===shipmentId)?.pendingQty;
  if(!Number.isSafeInteger(remaining)||qty>remaining)throw Error('本筆出貨尚待確認送達數量不足，請重新讀取。');
  frozen={orderId,itemId:resolvedItemId,shipmentId,quantity:qty,date,notes,
   operationId:recordId,syncAttemptId:order.inventoryReservationAttemptId,actorUid:uid,actorRole:role};
  sessionStorage.setItem(key,JSON.stringify(frozen));
 }
 check();if(emulator)functions.useEmulator('127.0.0.1',5001);
 const {actorUid,actorRole,...payload}=frozen;
 const response=await functions.httpsCallable('confirmV2ShipmentDelivery')(payload);check();
 const data=response?.data;
 if(!['applied','already-applied'].includes(data?.status)||data.recordId!==frozen.operationId
    ||data.orderId!==orderId||data.itemId!==frozen.itemId||data.shipmentId!==frozen.shipmentId)
  throw Error('送達回覆無法核對，必須保留原識別碼重試。');
 const refreshed=await db.collection('orders').doc(orderId).get({source:'server'});check();
 if(!refreshed.exists)throw Error('送達回覆成功但訂單回讀失敗，請核對原操作。');
 sessionStorage.removeItem(key);
 return refreshed.data();
}

function pendingV2DeliveryReversal(orderId){
 if(globalThis.YUSHIN_V2_DELIVERY_EMULATOR!==true)return null;
 const raw=sessionStorage.getItem('v2-delivery-reversal:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(orderId));
 if(!raw)return null;
 try{
  const intent=JSON.parse(raw);
  if(!intent||intent.orderId!==orderId||intent.actorUid!==currentUser?.uid
   ||intent.actorRole!==currentUserRole||!intent.operationId||!intent.deliveryRecordId)
   throw Error('invalid pending reversal actor');
  return intent;
 }catch(_){throw Error('前次送達撤銷尚未確認，請使用原帳號與角色核對。');}
}
async function reverseV2ShipmentDeliveryEmulator(orderId,deliveryRecordId,{date,reason,operationId}){
 const {uid,role,functions,check}=v2DeliveryEmulatorTransport();
 if(pendingV2DeliveryConfirmation(orderId))throw Error('尚有未確認的送達登錄，請先核對原操作。');
 if(typeof reason!=='string'||!reason.trim()||reason.length>1000||typeof date!=='string'
  ||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
  ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)
  throw Error('請填寫正確的撤銷日期與原因。');
 reason=reason.trim();
 const key='v2-delivery-reversal:'+encodeURIComponent(uid)+':'+encodeURIComponent(orderId);
 let frozen=pendingV2DeliveryReversal(orderId);
 if(frozen){
  if(frozen.deliveryRecordId!==deliveryRecordId||frozen.date!==date||frozen.reason!==reason)
   throw Error('尚有未確認的送達撤銷，請使用原紀錄、日期與原因重試。');
 }else{
  if(!/^[a-zA-Z0-9_-]{12,96}$/.test(operationId||''))throw Error('撤銷操作識別碼不正確。');
  const snapshot=await db.collection('orders').doc(orderId).get({source:'server'});check();
  if(!snapshot.exists)throw Error('找不到原始訂單。');
  const order=snapshot.data(),record=(order.deliveryRecords||[]).find(row=>row.id===deliveryRecordId);
  if(order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId
   ||!record||record.sourceType!=='WAREHOUSE_SHIPMENT_CONFIRMATION'||record.orderId!==orderId
   ||!order.items?.some(row=>row.itemId===record.itemId))throw Error('找不到可撤銷的原始送達確認。');
  if((order.returnRecords||[]).length)throw Error('已有實物退貨的送達撤銷尚未開放。');
  frozen={orderId,itemId:record.itemId,deliveryRecordId,operationId,
   syncAttemptId:order.inventoryReservationAttemptId,date,reason,actorUid:uid,actorRole:role};
  sessionStorage.setItem(key,JSON.stringify(frozen));
 }
 check();functions.useEmulator('127.0.0.1',5001);
 const {actorUid,actorRole,...payload}=frozen;
 const response=await functions.httpsCallable('reverseV2ShipmentDelivery')(payload);check();
 const result=response?.data;
 if(!['applied','already-applied'].includes(result?.status)||result.operationId!==frozen.operationId
  ||result.orderId!==orderId||result.itemId!==frozen.itemId||result.deliveryRecordId!==deliveryRecordId)
  throw Error('撤銷回覆無法核對，請保留原識別碼重試。');
 const refreshed=await db.collection('orders').doc(orderId).get({source:'server'});check();
 if(!refreshed.exists)throw Error('撤銷已回覆成功但訂單回讀失敗，請核對原操作。');
 sessionStorage.removeItem(key);
 return refreshed.data();
}

// Order delivery mutations. UI owns input/feedback; this service owns protected writes.
function assertOrderDeliveryIncrease(order,item,qty) {
    if(String(item?.productType||item?.type||'').trim().toUpperCase()==='SERVICE')
        throw new Error('服務型品項不能使用商品送貨紀錄；須另有服務完成及客戶交付憑證。');
    if(qty<=0)return;
    if(orderInventorySyncIncomplete(order))throw new Error('訂單庫存尚未同步完成');
    if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')return;
    const single=normalizedOrderItems(order).length===1;
    const gross=savedDeliveryRecords(order).filter(row=>row.itemId===item.itemId||(!row.itemId&&single))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const state=globalThis.YushinFulfillment.dispatchState({deliveredQty:gross,
        reservedQty:item.reservedQty,dispatchPreparedQty:item.dispatchPreparedQty});
    if(qty>state.shippable+1e-9)throw new Error(`${item.itemName||'品項'} 目前已打單可出貨數量只有 ${state.shippable}。`);
    return state;
}

function deliveryRecordWasReversed(order,recordId) {
    return (order.deliveryHistory||[]).some(row=>
        (row.action==='delete'&&row.recordId===recordId)
        ||(row.action==='cancel_all'&&(row.before?.records||[]).some(record=>record.id===recordId)));
}

async function completeOrderDelivery(orderId,today) {
    if(deliveryConfirmationProtectedMode())throw Error('v2 送達必須逐筆對應原出貨；不可使用一般送貨或更正扣帳。');
    assertNoUnresolvedV2DeliveryBeforeLegacyWrite(orderId);
    const actor=deliveryActor(),now=new Date().toISOString(),recordId=deliveryRecordId();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        if (normalizedOrderStatus(order) !== 'normal') throw new Error('這筆訂單已取消。');
        if(orderInventorySyncIncomplete(order))throw new Error('訂單庫存尚未同步完成');
        const transactionItems=normalizedOrderItems(order);
        // UI 已阻擋多品項一鍵送貨；transaction 仍要以最新資料再次驗證，
        // 避免 stale cache 或另一端剛修改品項後寫入無法歸屬品項的送貨紀錄。
        if (transactionItems.length !== 1) throw new Error('多品項訂單不能一鍵完成送貨，請逐品項登錄。');
        if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('這筆舊資料已視為全數送貨。');
        const total = orderQuantity(order);
        const records = savedDeliveryRecords(order).slice();
        const {effectiveDelivered}=orderDeliveryProjection(order);
        const remaining = Math.max(0, total - effectiveDelivered);
        if (!total) throw new Error('訂單數量必須大於 0，才能登錄送貨。');
        if (remaining <= 0) {savedOrder=order;return;}
        assertOrderDeliveryIncrease(order,transactionItems[0],remaining);
        const record = { id: recordId, itemId:transactionItems[0].itemId, date: today, qty: remaining, notes: '一鍵完成剩餘送貨', createdBy: actor, createdAt: now };
        records.push(record);
        const history = { action: 'create', source: 'quick_complete', recordId: record.id, before: null, after: record, by: actor, at: now };
        const statusEntries = [];
        const deliveryItem=transactionItems[0];
        const itemOrder={...order,...deliveryItem,deliveryRecords:records.filter(row=>row.itemId===deliveryItem.itemId),isDelivered:false};
        const inventoryResult=await applyInventoryDeliveryInTransaction(transaction, ref, itemOrder, remaining, actor, orderId);
        record.lotAllocations=inventoryResult?.lotAllocations||[];
        record.cogs=Number(inventoryResult?.cogs||0);
        records[records.length-1]=record;
        const nextItems=transactionItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
        const grossAfterDelivery = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
        const effectiveAfterDelivery = orderDeliveryProjection({...order,deliveryRecords:records,isDelivered:false}).effectiveDelivered;
        const updates = {
            items:nextItems, deliveryRecords: records, deliveredQty: grossAfterDelivery, isDelivered: effectiveAfterDelivery >= total,
            deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history)
        };
        if (statusEntries.length) updates.statusHistory = firebase.firestore.FieldValue.arrayUnion(...statusEntries);
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = {
            ...order, ...updates,
            deliveryHistory: [...(order.deliveryHistory || []), history],
            statusHistory: [...(order.statusHistory || []), ...statusEntries]
        };
    });
    return savedOrder;
}

async function cancelOrderDeliveries(orderId) {
    if(deliveryConfirmationProtectedMode())throw Error('v2 送達必須逐筆對應原出貨；不可使用一般送貨或更正扣帳。');
    assertNoUnresolvedV2DeliveryBeforeLegacyWrite(orderId);
    const actor=deliveryActor(),now=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        // 前端雖已擋多品項，但 transaction 必須再次依最新 Firestore 資料驗證，
        // 避免 stale cache／重複操作把整張訂單的庫存還原到錯誤品項。
        if (normalizedOrderItems(order).length !== 1) throw new Error('只有單品項訂單可以一鍵取消全部送貨，請逐品項更正送貨紀錄。');
        if (returnedQuantity(order) > 0) throw new Error('這筆訂單已有退貨紀錄，請先更正退貨紀錄。');
        if (!savedDeliveryRecords(order).length&&!order.isDelivered) {savedOrder=order;return;}
        const progress = deliveryProgressInfo(order);
        if (progress.state !== 'complete') throw new Error('這筆訂單目前不是全數已送貨狀態。');
        const before = savedDeliveryRecords(order).length
            ? { records: savedDeliveryRecords(order), deliveredQty: progress.delivered }
            : { legacyEstimated: true, estimatedDate: order.orderDate || '', deliveredQty: progress.delivered };
        const history = { action: 'cancel_all', source: 'quick_toggle', before, after: { records: [], deliveredQty: 0 }, by: actor, at: now };
        const currentItems=normalizedOrderItems(order);
        const deliveryItem=currentItems[0];
        assertOrderDeliveryIncrease(order,deliveryItem,0);
        const itemOrder={...order,...deliveryItem,deliveryRecords:savedDeliveryRecords(order),isDelivered:false};
        const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, itemOrder, -progress.delivered, actor, orderId, savedDeliveryRecords(order));
        const nextItems=currentItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
        const updates = { items:nextItems, deliveryRecords: [], deliveredQty: 0, isDelivered: false, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
    });
    return savedOrder;
}

async function saveOrderDeliveryRecord(orderId,{date,qty,notes='',editId='',itemId='',recordId,shipmentId=''}) {
    if(deliveryConfirmationProtectedMode()){
        if(editId)throw Error('v2 已確認的送達紀錄不可直接編輯，請改用送達撤銷流程。');
        return confirmV2ShipmentDeliveryEmulator(orderId,{date,qty,notes,itemId,shipmentId,recordId});
    }
    assertNoUnresolvedV2DeliveryBeforeLegacyWrite(orderId);
    if(!date||typeof qty!=='number'||!Number.isFinite(qty)||qty<=0)
        throw new Error('請填寫送貨日期與大於 0 的送貨數量。');
    if(!editId&&(typeof recordId!=='string'||!recordId.trim()))throw new Error('缺少送貨作業識別碼，請重新開啟表單。');
    const actor=deliveryActor(),now=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('請先取消舊資料的歷史推估送貨紀錄。');
        const records = savedDeliveryRecords(order).slice();
        if(!editId&&deliveryRecordWasReversed(order,recordId))
            throw new Error('這筆送貨作業已更正撤銷，不能重試為新的送貨。');
        // A lost response may be retried with the same form attempt ID.
        // Never reinterpret an existing ID as a second physical shipment.
        const submitted=!editId&&records.find(row=>row.id===recordId);
        if(submitted){
            if(submitted.date!==date||Number(submitted.qty)!==qty||String(submitted.notes||'')!==notes
                ||(itemId&&normalizedOrderItems(order).length>1&&submitted.itemId!==itemId))
                throw new Error('這個送貨識別碼已有不同內容，請重新查詢送貨紀錄。');
            savedOrder=order;return;
        }
        const existingIndex = records.findIndex(item => item.id === editId);
        if (editId && existingIndex < 0) throw new Error('這筆送貨紀錄已被其他人修改或刪除，請重新開啟後再試。');
        if (normalizedOrderStatus(order) !== 'normal' && existingIndex < 0) throw new Error('已取消的訂單不能新增送貨紀錄。');
        const previous = existingIndex >= 0 ? records[existingIndex] : null;
        const orderItems=normalizedOrderItems(order);
        // Select only the recorded item: never silently substitute the first item.
        const requestedItemId=previous?.itemId||(orderItems.length===1?orderItems[0]?.itemId:itemId)||'';
        const targetItem=orderItems.find(item=>item.itemId===requestedItemId);
        if(!targetItem)throw new Error('找不到指定送貨品項，請重新開啟訂單確認。');
        if(previous&&previous.itemId===targetItem.itemId&&previous.date===date
            &&Number(previous.qty)===qty&&String(previous.notes||'')===notes){savedOrder=order;return;}
        const itemOtherDelivered=records.filter(r=>r.id!==editId&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
        const itemReturns=savedReturnRecords(order).filter(r=>(!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId);
        const itemReturned=itemReturns.reduce((s,r)=>s+Number(r.qty||0),0);
        // 退貨後補送必須以「有效送貨量」驗證，而不是歷史累計送貨量。
        // 例如訂購10、曾送10、退2，可再補送2；歷史送貨會成為12，但有效送貨仍是10。
        const itemGrossAfter=itemOtherDelivered+qty;
        if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 累計送貨數量不能低於已登錄的退貨數量 ${itemReturned}。`);
        const itemEffectiveAfter=globalThis.YushinFulfillment.projectOrderDelivery({grossDeliveredQty:itemGrossAfter,returnedQty:itemReturned,returnRecords:itemReturns}).effectiveDelivered;
        if(itemEffectiveAfter>Number(targetItem.qty||0)+1e-9)throw new Error(`${targetItem.itemName||'品項'} 有效送貨數量將超過訂單數量。`);
        assertOrderDeliveryIncrease(order,targetItem,qty-Number(previous?.qty||0));
        const record = previous
            ? { ...previous, itemId:targetItem.itemId, date, qty, notes, updatedBy: actor, updatedAt: now }
            : { id: recordId, itemId:targetItem.itemId, date, qty, notes, createdBy: actor, createdAt: now };
        if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
        const totalDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
        const total = orderQuantity(order);
        if (!total) throw new Error('訂單數量必須大於 0，才能登錄送貨。');
        const effectiveTotalDelivered=orderDeliveryProjection({...order,deliveryRecords:records,isDelivered:false}).effectiveDelivered;
        if (effectiveTotalDelivered > total + 1e-9) throw new Error(`有效送貨數量 ${effectiveTotalDelivered} 超過訂單數量 ${total}。`);
        const alreadyReturned = returnedQuantity(order);
        if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`累計送貨數量不能低於已登錄的退貨數量 ${alreadyReturned}。`);
        const action = previous ? 'edit' : 'create';
        const history = { action, recordId: record.id, before: previous, after: record, by: actor, at: now };
        const updates = { deliveryRecords: records, deliveredQty: totalDelivered, isDelivered: effectiveTotalDelivered >= total, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
        const deliveryDelta = qty - Number(previous?.qty || 0);
        if(deliveryDelta){
            const itemRecords=records.filter(r=>r.itemId===targetItem.itemId);
            const itemOrder={...order,...targetItem,qty:Number(targetItem.qty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
            const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction,itemOrder,deliveryDelta,actor,orderId,deliveryDelta<0&&previous?[previous]:null);
            const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            updates.items=syncedItems;
            if(deliveryDelta>0){
                record.lotAllocations=[...(previous?.lotAllocations||[]),...(inventoryResult.lotAllocations||[])];
                record.cogs=Number(previous?.cogs||0)+Number(inventoryResult.cogs||0);
                const recordIndex=records.findIndex(r=>r.id===record.id);
                if(recordIndex>=0)records[recordIndex]=record;
                updates.deliveryRecords=records;
            } else if(previous){
                const reversed=(inventoryResult.lotAllocations||[]).map(row=>({...row,qty:Math.abs(Number(row.qty||0))}));
                record.lotAllocations=globalThis.YushinInventory.allocationsAfterReversal(previous.lotAllocations||[],reversed);
                record.cogs=record.lotAllocations.reduce((sum,row)=>sum+Number(row.cost??(Number(row.qty||0)*Number(row.unitCost||0))),0);
                const recordIndex=records.findIndex(r=>r.id===record.id);
                if(recordIndex>=0)records[recordIndex]=record;
                updates.deliveryRecords=records;
            }
        }
        // Build the sentinel only after stock accounting populated the final record.
        updates.deliveryHistory=firebase.firestore.FieldValue.arrayUnion(history);
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
    });
    return savedOrder;
}

async function correctOrderDeliveryRecord(orderId,recordId,correctionReason) {
    if(deliveryConfirmationProtectedMode())throw Error('v2 送達必須逐筆對應原出貨；不可使用一般送貨或更正扣帳。');
    assertNoUnresolvedV2DeliveryBeforeLegacyWrite(orderId);
    if(typeof correctionReason!=='string'||!correctionReason.trim())throw new Error('請填寫誤登更正原因。');
    const actor=deliveryActor(),now=new Date().toISOString();
    let savedOrder;
    await runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        const records = savedDeliveryRecords(order);
        const removed = records.find(item => item.id === recordId);
        if (!removed) {
            if((order.deliveryHistory||[]).some(row=>row.action==='delete'&&row.recordId===recordId)) {savedOrder=order;return;}
            throw new Error('找不到這筆送貨紀錄。');
        }
        const next = records.filter(item => item.id !== recordId);
        const totalDelivered = next.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
        const alreadyReturned = returnedQuantity(order);
        if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`刪除後的送貨數量會低於已登錄的退貨數量 ${alreadyReturned}，請先更正退貨紀錄。`);
        const history = { action: 'delete', recordId, before: removed, after: null, reason: correctionReason.trim(), by: actor, at: now };
        const orderItems=normalizedOrderItems(order);
        const targetItem=orderItems.find(item=>item.itemId===removed.itemId) || (orderItems.length===1?orderItems[0]:null);
        if(!targetItem)throw new Error('找不到原送貨品項，無法安全還原庫存。');
        assertOrderDeliveryIncrease(order,targetItem,0);
        const itemRecords=records.filter(r=>((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId));
        const itemGrossAfter=itemRecords.filter(r=>r.id!==recordId).reduce((sum,row)=>sum+Number(row.qty||0),0);
        const itemReturned=savedReturnRecords(order)
            .filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
            .reduce((sum,row)=>sum+Number(row.qty||0),0);
        if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 刪除後的送貨數量會低於已登錄的退貨數量 ${itemReturned}，請先更正退貨紀錄。`);
        const itemOrder={...order,...targetItem,itemId:targetItem.itemId,qty:Number(targetItem.qty||targetItem.orderedQty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
        const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, itemOrder, -Number(removed.qty || 0), actor, orderId, [removed]);
        const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
        const effectiveDelivered=orderDeliveryProjection({...order,deliveryRecords:next,isDelivered:false}).effectiveDelivered;
        const updates = { items:syncedItems, deliveryRecords: next, deliveredQty: totalDelivered, isDelivered: effectiveDelivered >= orderQuantity(order) && orderQuantity(order) > 0, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
    });
    return savedOrder;
}

