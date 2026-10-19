// Only the isolated demo Auth/Functions/Firestore Emulator can submit v2 shipments.
function pendingV2WarehouseShipment(orderId,itemId){
 if(globalThis.YUSHIN_V2_SHIPMENT_EMULATOR!==true)return null;
 const key='v2-shipment:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(orderId)+':'+encodeURIComponent(itemId);
 const stored=sessionStorage.getItem(key);
 if(!stored)return null;
 try{
  const pending=JSON.parse(stored);
  if(pending.orderId!==orderId||pending.itemId!==itemId||pending.actorUid!==currentUser?.uid||pending.actorRole!==currentUserRole)throw Error('actor');
  return pending;
 }catch(_){throw Error('上次出貨尚未確認，請使用原帳號核對出貨識別資料。');}
}
async function commitV2WarehouseShipmentEmulator(input){
 const local=s=>s==='localhost'||s==='127.0.0.1';
 if(!local(globalThis.location?.hostname)||typeof firebase==='undefined'||!firebase.auth||!firebase.functions)
  throw Error('v2 出貨僅限本機 Emulator。');
 const auth=firebase.auth(),fn=firebase.functions('asia-east1'),uid=currentUser?.uid,role=currentUserRole;
 if(auth.app?.options?.projectId!=='demo-yushin'||fn.app?.options?.projectId!=='demo-yushin'
  ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
  throw Error('v2 出貨必須使用本機 demo-yushin 的 Auth 與 Functions。');
 const same=()=>{
  if(!uid||currentUser?.uid!==uid||currentUserRole!==role||auth.currentUser?.uid!==uid
    ||!canReceiveInventoryCapability()||!canAccessPage('inventory'))throw Error('登入帳號或權限已變更。');
 };
 same();
 const {orderId,itemId,qty,date,notes,operationId,expectedWarehouseId,expectedPlan}=input;
 if(!/^[-_a-zA-Z0-9]{12,96}$/.test(operationId||'')||!Number.isSafeInteger(qty)||qty<=0||!expectedWarehouseId
  ||typeof notes!=='string'||notes.length>1000||typeof date!=='string'
  ||!/^\\d{4}-\\d{2}-\\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
  ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)
  throw Error('v2 出貨識別碼、倉庫或數量不正確。');
 const plan=globalThis.YushinWarehouseLogistics.validatePlan(expectedPlan,true);
 if(plan.mode!=='CUSTOMER_SHIP')throw Error('v2 出貨目前僅支援直接寄客戶。');
 const key='v2-shipment:'+encodeURIComponent(uid)+':'+encodeURIComponent(orderId)+':'+encodeURIComponent(itemId);
 let pending=pendingV2WarehouseShipment(orderId,itemId);
 if(pending&&pending.operationId!==operationId)throw Error('前次出貨結果尚未確認，必須先重試原識別碼。');
 if(!pending){
  const doc=await db.collection('orders').doc(orderId).get();same();
  const order=doc.exists?doc.data():null;
  if(!order||order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId
    ||!order.items?.some(x=>x.itemId===itemId))throw Error('來源訂單尚未完成 v2 同步。');
  pending={orderId,itemId,warehouseId:expectedWarehouseId,quantity:qty,date,notes,operationId,
   syncAttemptId:order.inventoryReservationAttemptId,expectedPlan:plan,actorUid:uid,actorRole:role};
  sessionStorage.setItem(key,JSON.stringify(pending));
 }else if(pending.quantity!==qty||pending.warehouseId!==expectedWarehouseId||pending.date!==date
   ||pending.notes!==notes||JSON.stringify(pending.expectedPlan)!==JSON.stringify(plan))
  throw Error('原出貨數量、倉庫及收件資訊已凍結，不得改變重送。');
 same();fn.useEmulator('127.0.0.1',5001);
 const {actorUid,actorRole,...request}=pending;
 const response=await fn.httpsCallable('shipV2WarehouseItem')(request);same();
 const data=response?.data;
 if(!['applied','already-applied'].includes(data?.status)||data.orderId!==orderId||data.itemId!==itemId
  ||data.warehouseId!==pending.warehouseId||data.qty!==pending.quantity||data.movementId!=='location-ship-'+operationId)
  throw Error('出貨回覆無法確認，保留原識別碼核對結果。');
 const refreshed=await db.collection('orders').doc(orderId).get();same();
 if(!refreshed.exists)throw Error('出貨已回覆，但訂單回讀失敗。');
 sessionStorage.removeItem(key);
 return refreshed.data();
}
// Warehouse shipment transaction service; single and batch UI share this entry.
async function commitInventoryShipment({orderId,itemId,qty,date,notes='',operationId,expectedWarehouseId='',expectedPlan=null}){
  if(globalThis.YUSHIN_V2_SHIPMENT_EMULATOR===true)return commitV2WarehouseShipmentEmulator({orderId,itemId,qty,date,notes,operationId,expectedWarehouseId,expectedPlan});
  if(!canReceiveInventoryCapability()||!canAccessPage('inventory'))throw new Error('無倉庫出貨權限。');
  if(typeof operationId!=='string'||!operationId.trim()||!Number.isFinite(qty)||qty<=0)throw new Error('出貨數量或操作識別碼不正確。');
  if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new Error('請填寫有效的出貨日期。');
  const actor=deliveryActor(),actorUid=currentUser.uid,now=new Date().toISOString();
  let saved;
  await runRoleTransaction(async tx=>{
    const ref=db.collection('orders').doc(orderId),snapshot=await tx.get(ref);
    if(!snapshot.exists)throw new Error('找不到訂單。');
    const order=snapshot.data(),records=savedDeliveryRecords(order);
    const prior=records.find(r=>r.id===operationId);
    if(prior){
      if(prior.sourceType!=='INVENTORY_SHIPMENT'||prior.itemId!==itemId||Number(prior.qty)!==qty||prior.date!==date||String(prior.notes||'')!==notes
        ||(expectedWarehouseId&&prior.warehouseId!==expectedWarehouseId)
        ||(expectedPlan&&JSON.stringify(globalThis.YushinWarehouseLogistics.plan(prior.deliveryPlan||{}))!==JSON.stringify(expectedPlan)))
        throw new Error('出貨操作識別碼衝突。');
      saved=order;return;
    }
    if(deliveryRecordWasReversed(order,operationId)||order.inventoryShipmentRecordId===operationId)
      throw new Error('這筆出貨已更正撤銷，請重新核對後建立新的出貨作業。');
    if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order))throw new Error('訂單已取消或庫存尚未同步。');
    if(!Array.isArray(order.items))throw new Error('舊版訂單須先完成品項整理，才能由倉庫出貨。');
    const item=normalizedOrderItems(order).find(i=>i.itemId===itemId);
    if(item?.transferPendingId)throw new Error('此品項尚在調撥途中。');
    const plan=item?.deliveryPlan||order.shippingInstructions;
    if(plan&&plan.mode!=='CUSTOMER_SHIP')throw new Error('交付方式已變更，請重新確認。');
    if(plan)globalThis.YushinWarehouseLogistics.validatePlan(plan,true);
    if(!item||(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')throw new Error('此品項不屬於倉庫出貨。');
    const state=assertOrderDeliveryIncrease(order,item,qty);
    const warehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';
    if(!warehouseMasterCache.some(w=>w.id===warehouseId&&w.active!==false))throw new Error('出貨倉庫不存在或已停用。');
    if(expectedWarehouseId&&warehouseId!==expectedWarehouseId)throw new Error('出貨倉庫已變更，請重新核對。');
    if(expectedPlan&&JSON.stringify(globalThis.YushinWarehouseLogistics.plan(plan||{}))!==JSON.stringify(expectedPlan))throw new Error('寄送資訊已變更，請重新核對。');
    const result=await applyInventoryDeliveryDeltaInTransaction(tx,{...order,...item,itemId,warehouseId,isDelivered:false,requireStockReservation:true},qty,actor,orderId);
    const record={id:operationId,orderId,itemId,productKey:inventoryProductKey(item),itemIndex:order.items.findIndex(i=>i.itemId===itemId),warehouseId,date,qty,notes,...(plan?{deliveryPlan:globalThis.YushinWarehouseLogistics.plan(plan)}:{}),sourceType:'INVENTORY_SHIPMENT',createdBy:actor,createdByUid:actorUid,createdAt:now,movementId:result.movementId,lotAllocations:result.lotAllocations||[],cogs:0};
    const nextRecords=[...records,record],totalDelivered=nextRecords.reduce((sum,r)=>sum+Number(r.qty||0),0);
    const effectiveDelivered=orderDeliveryProjection({...order,deliveryRecords:nextRecords,isDelivered:false}).effectiveDelivered;
    const nextItems=order.items.map(i=>i.itemId===itemId?{...i,reservedQty:result.newReservedQty,warehouseShippedQty:state.grossDelivered+qty}:i);
    const history={action:'create',source:'inventory',recordId:operationId,before:null,after:record,by:actor,at:now};
    const updates={inventoryShipmentRecordId:operationId,items:nextItems,deliveryRecords:nextRecords,deliveredQty:totalDelivered,isDelivered:effectiveDelivered>=orderQuantity(order),deliveryHistory:firebase.firestore.FieldValue.arrayUnion(history),updatedAt:now};
    Object.assign(updates,orderWorkIndexFields({...order,...updates}));tx.update(ref,updates);saved={...order,...updates,deliveryHistory:[...(order.deliveryHistory||[]),history]};
  });
  return saved;
}
