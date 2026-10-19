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
