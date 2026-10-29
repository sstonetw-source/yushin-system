// Transfer dispatch and receipt are separate physical events, not customer deliveries.
async function commitWarehouseTransfer({id,inventoryId='',fromWarehouseId='',toWarehouseId='',qty,orderId='',itemId='',handoff=false,expectedWarehouseId='',expectedPlan=null,requestId=''}){
  if(requestId&&typeof pendingMainTransferOperation==='function'&&pendingMainTransferOperation(requestId))
    throw Error('原主倉需求結果尚未確認，請先確認原操作再寄出。');
  if(requestId&&typeof mainTransferPhysicalRequired==='function'&&mainTransferPhysicalRequired('DISPATCH',id,requestId))
    return commitMainTransferPhysicalBackend('DISPATCH',id,{id,requestId});
  if(!canReceiveInventoryCapability()||!canAccessPage('inventory'))throw Error('無調撥權限。');
  if(!id||!Number.isFinite(qty)||qty<=0)throw Error('調撥資料不正確。');
  const actorUid=currentUser.uid,actorRole=currentUserRole,now=new Date().toISOString(),who=deliveryActor();let saved;
  await runRoleTransaction(async tx=>{
    const transferRef=db.collection('stockTransfers').doc(id),prior=await tx.get(transferRef);
    if(prior.exists){
      saved=prior.data();
      if(saved.dispatchIntentHash)throw Error('此調撥由後端處理，禁止改用舊交易，請回原環境核對。');
      // A committed operation may be retried after its response is lost, but
      // the same ID must never confirm a different dispatch or request.
      const sameSource=orderId
        ? (!expectedWarehouseId||saved.fromWarehouseId===expectedWarehouseId)
        : saved.inventoryId===inventoryId&&saved.fromWarehouseId===fromWarehouseId;
      const sameDestination=orderId&&handoff
        ? saved.toWarehouseId==='custody-'+saved.ownerUid
        : saved.toWarehouseId===toWarehouseId;
      const samePlan=!expectedPlan||JSON.stringify(saved.deliveryPlan||{})===JSON.stringify(expectedPlan);
      if(saved.orderId!==orderId||saved.itemId!==itemId||Number(saved.qty)!==qty
        ||(saved.kind||'TRANSFER')!==(handoff?'HANDOFF':'TRANSFER')
        ||(saved.requestId||'')!==requestId||!sameSource||!sameDestination||!samePlan)
        throw Error('調撥操作識別碼衝突，原操作已提交或內容不同，請核對調撥紀錄。');
      return;
    }
    let transferRequest=null,requestRef=null;
    if(requestId){requestRef=db.collection('stockTransferRequests').doc(requestId);const rs=await tx.get(requestRef);if(!rs.exists)throw Error('調回需求不存在。');transferRequest=rs.data();if(transferRequest.status!=='PENDING'||transferRequest.inventoryId!==inventoryId||transferRequest.fromWarehouseId!==fromWarehouseId||transferRequest.toWarehouseId!==toWarehouseId||Number(transferRequest.qty)!==qty||handoff||orderId)throw Error('調回需求已變更。');}
    let order=null,item=null,index=-1,orderRef=null,reservationRef=null,reservation=null;
    if(orderId){
      orderRef=db.collection('orders').doc(orderId);const orderSnap=await tx.get(orderRef);if(!orderSnap.exists)throw Error('訂單不存在。');order=orderSnap.data();
      if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order))throw Error('訂單不可出貨。');
      index=order.items.findIndex(i=>i.itemId===itemId);item=normalizedOrderItems(order)[index];
      if(!item||(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'||item.transferPendingId)throw Error('品項不可調撥。');
      const delivery=globalThis.YushinFulfillment.deliveryQuantities(item);
      const remaining=Math.max(0,Number(item.qty||item.orderedQty||0)-delivery.effectiveDeliveredQty);
      if(qty!==remaining||qty!==Number(item.reservedQty)||qty>itemDispatchState(order,item).shippable)throw Error('轉倉或交付負責業務須等此品項剩餘數量全部到貨、預留並完成打單，再一次交付，避免後續到貨混到不同倉庫。');
      fromWarehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';inventoryId=inventoryRefFor(item)?.id||'';
      if(handoff){const p=YushinWarehouseLogistics.validatePlan(item.deliveryPlan||order.shippingInstructions||{},false);if(!['PICKUP','SALES_SHIP'].includes(p.mode))throw Error('請先設定交付負責業務的方式。');if(p.mode==='SALES_SHIP')YushinWarehouseLogistics.validatePlan(p,true);if(!order.ownerUid)throw Error('訂單缺少負責業務。');toWarehouseId='custody-'+order.ownerUid;}
      else{const p=YushinWarehouseLogistics.plan(item.deliveryPlan||order.shippingInstructions||{}),target=p.warehouseId||(p.mode==='PICKUP'?defaultWarehouse()?.id:'');if(!target||target!==toWarehouseId)throw Error('請先儲存正確的轉倉設定。');if(p.mode==='TRANSFER')YushinWarehouseLogistics.validatePlan(p,true);}
      if(expectedWarehouseId&&fromWarehouseId!==expectedWarehouseId)throw Error('出貨倉庫已變更，請重新核對。');
      if(expectedPlan&&JSON.stringify(YushinWarehouseLogistics.plan(item.deliveryPlan||order.shippingInstructions||{}))!==JSON.stringify(expectedPlan))throw Error('寄送資訊已變更，請重新核對。');
      reservationRef=db.collection('inventoryReservations').doc(orderId+'__'+itemId);const rs=await tx.get(reservationRef);if(!rs.exists)throw Error('找不到訂單預留。');reservation=rs.data();
      if(Number(reservation.quantity)!==qty||reservation.warehouseId!==fromWarehouseId)throw Error('訂單預留已變更。');
    }else if(handoff)throw Error('業務交付必須有來源訂單。');
    if(!inventoryId||!fromWarehouseId||!toWarehouseId||fromWarehouseId===toWarehouseId)throw Error('請選擇不同的來源與目的倉庫。');
    const invRef=db.collection('inventory').doc(inventoryId),invSnap=await tx.get(invRef);if(!invSnap.exists)throw Error('找不到庫存。');const inv=invSnap.data(),key=String(inv.productKey||inv.productId||'');if(!key)throw Error('庫存缺少產品識別。');
    const sourceWhRef=db.collection('warehouses').doc(fromWarehouseId),destWhRef=db.collection('warehouses').doc(toWarehouseId);
    const sourceWh=await tx.get(sourceWhRef),destWh=await tx.get(destWhRef);if(!sourceWh.exists||sourceWh.data().active===false)throw Error('來源倉庫已停用。');
    if(handoff&&destWh.exists&&(destWh.data().active===false||!destWh.data().systemCustody||destWh.data().ownerUid!==order.ownerUid))throw Error('負責業務保管位置已停用或不正確。');
    if(!handoff&&(!destWh.exists||destWh.data().active===false||destWh.data().systemCustody))throw Error('目的倉庫不存在或已停用。');
    const fromRef=db.collection('warehouseStocks').doc(warehouseStockDocId(fromWarehouseId,key)),toRef=db.collection('warehouseStocks').doc(warehouseStockDocId(toWarehouseId,key));
    const fromSnap=await tx.get(fromRef),toSnap=handoff?await tx.get(toRef):null;if(!fromSnap.exists)throw Error('來源倉庫無此庫存。');
    const from=fromSnap.data(),reservedQty=orderId?qty:0,heldQty=transferRequest?qty:0;
    const physicalPlan=handoff?null:YushinWarehouseLogistics.planTransferDispatch({aggregateStock:inv,warehouseStock:from,qty,reservedQty,heldQty});
    if(handoff)YushinWarehouseLogistics.transferable(from,qty,reservedQty);
    const lotQuery=await firestoreReadWithTimeout(db.collection('inventoryLots').where('productKey','==',key).where('warehouseId','==',fromWarehouseId).limit(201).get(),'調撥批次');
    if(lotQuery.size>200)throw Error('批次超過安全處理上限。');
    const lotSnaps=await Promise.all(lotQuery.docs.map(d=>tx.get(d.ref))),trackedLots=lotSnaps.filter(d=>d.exists).map(d=>({...d.data(),id:d.id}));
    if(trackedLots.some(lot=>lot.productKey!==key||lot.warehouseId!==fromWarehouseId))
      throw Error('調撥批次的產品或來源倉庫已變更，請重新核對。');
    const unbatchedRef=db.collection('inventoryLots').doc(id+'-unbatched-source');
    const unbatchedSnap=orderId?null:await tx.get(unbatchedRef);
    if(unbatchedSnap?.exists)throw Error('未分批庫存識別碼衝突。');
    const reconciled=orderId?{lots:trackedLots,unbatched:null}:YushinInventory.reconcileStockLots(trackedLots,Number(from.onHand),unbatchedRef.id);
    const lots=reconciled.lots;
    const allocation=YushinInventory.allocateLots(lots,qty);
    if(actorUid!==currentUser.uid||actorRole!==currentUserRole)throw Error('登入身分已變更。');
    const allocations=allocation.allocations.map((a,n)=>({...a,targetLotId:id+'-'+n,...(lots.find(l=>l.id===a.lotId)?.unbatched?{unbatched:true}:{}),costLotId:lots.find(l=>l.id===a.lotId)?.costLotId||a.lotId}));
    saved={id,...(requestId?{requestId}:{}),inventoryId,productKey:key,productId:inv.productId||key,itemCode:inv.itemCode||item?.itemCode||'',itemName:inv.itemName||item?.itemName||'',brand:inv.brand||'',brandId:inv.brandId||'',fromWarehouseId,toWarehouseId,fromStockId:fromRef.id,toStockId:toRef.id,qty,reservedQty,status:handoff?'RECEIVED':'IN_TRANSIT',kind:handoff?'HANDOFF':'TRANSFER',orderId,itemId,itemIndex:index,orderNo:order?.orderNo||order?.quoteNo||'',salesName:order?.salesName||'',ownerUid:order?.ownerUid||'',salesCode:order?.salesCode||'',allocations,createdAt:now,createdBy:who,createdByUid:actorUid,...(handoff?{receivedAt:now,receivedByUid:actorUid}:{}),deliveryPlan:order?YushinWarehouseLogistics.plan(item.deliveryPlan||order.shippingInstructions||{}):{}};
    tx.set(transferRef,saved);
    tx.update(fromRef,{...(physicalPlan?physicalPlan.source:{onHand:Number(from.onHand)-qty,reserved:Number(from.reserved||0)-reservedQty}),updatedAt:now});
    if(reconciled.unbatched){
      const lot=reconciled.unbatched,issued=allocations.find(a=>a.lotId===lot.id)?.qty||0;
      tx.set(unbatchedRef,{productKey:key,productId:inv.productId||key,warehouseId:fromWarehouseId,lotNo:'',expiryDate:'',receivedQty:lot.receivedQty,remainingQty:lot.remainingQty-issued,unbatched:true,sourceType:'MANUAL_STOCK_BALANCE',sourceId:id,receivedAt:now,createdBy:who});
    }
    for(const a of allocations){if(a.lotId===reconciled.unbatched?.id)continue;const lot=lots.find(l=>l.id===a.lotId);tx.update(db.collection('inventoryLots').doc(a.lotId),{remainingQty:Number(lot.remainingQty??lot.qty)-a.qty,updatedAt:now});}
    if(handoff){
      if(!destWh.exists)tx.set(destWhRef,{warehouseName:'負責業務保管｜'+(order.salesName||order.ownerUid),active:true,isDefault:false,warehouseType:'CUSTODY',systemCustody:true,ownerUid:order.ownerUid,sourceTransferId:id});
      const target=toSnap?.exists?toSnap.data():{};
      tx.set(toRef,{productKey:key,productId:inv.productId||key,itemCode:inv.itemCode||'',itemName:inv.itemName||'',brand:inv.brand||'',brandId:inv.brandId||'',warehouseId:toWarehouseId,onHand:Number(target.onHand||0)+qty,reserved:Number(target.reserved||0)+reservedQty,incoming:Number(target.incoming||0),updatedAt:now},{merge:true});
      writeTransferLots(tx,saved,inv,now);
      tx.update(reservationRef,{warehouseId:toWarehouseId,updatedAt:now});
    }else tx.update(invRef,{...physicalPlan.aggregate,updatedAt:now});
    if(requestRef)tx.update(requestRef,{status:'SHIPPED',transferId:id,shippedAt:now,shippedByUid:actorUid});
    tx.set(db.collection('inventoryMovements').doc(id+'-out'),{type:'warehouse_transfer_out',qty:-qty,productKey:key,warehouseId:fromWarehouseId,fromWarehouseId,toWarehouseId,sourceType:'WAREHOUSE_TRANSFER',sourceId:id,transferId:id,orderId,itemId,createdAt:now,createdBy:who,actorUid});
    if(handoff)tx.set(db.collection('inventoryMovements').doc(id+'-in'),{type:'warehouse_transfer_in',qty,productKey:key,warehouseId:toWarehouseId,fromWarehouseId,toWarehouseId,sourceType:'WAREHOUSE_TRANSFER',sourceId:id,transferId:id,orderId,itemId,createdAt:now,createdBy:who,actorUid});
    if(order){
      const items=order.items.map((i,n)=>n===index?{...i,...(handoff?{warehouseId:toWarehouseId,custodyTransferId:id}:{transferPendingId:id})}:i);
      const next={...order,items};tx.update(orderRef,{items,warehouseLogisticsId:id,warehouseLogisticsEventId:id+'-out',logisticsTransfersPending:Number(order.logisticsTransfersPending||0)+(handoff?0:1),logisticsHistory:firebase.firestore.FieldValue.arrayUnion({id,action:handoff?'倉庫交付業務':'倉庫調撥寄出',itemId,by:who,at:now,detail:fromWarehouseId+' → '+toWarehouseId+' × '+qty}),...orderWorkIndexFields(next),updatedAt:now});
    }
  });return saved;
}
function writeTransferLots(tx,transfer,inventory,now){
  for(const row of YushinWarehouseLogistics.transferDestinationLots(transfer,inventory,now)){
    tx.set(db.collection('inventoryLots').doc(row.lotId),row.lot);
    tx.set(db.collection('inventoryLotCosts').doc(row.lotId),row.cost);
  }
}
async function commitWarehouseTransferReceipt(id,{onStockCommitted=null}={}){
  if(typeof mainTransferPhysicalRequired==='function'&&mainTransferPhysicalRequired('RECEIVE',id))
    return commitMainTransferPhysicalBackend('RECEIVE',id);
  if(!canReceiveInventoryCapability()||!canAccessPage('inventory'))throw Error('無調撥收貨權限。');let saved;
  const actorUid=currentUser.uid,actorRole=currentUserRole,actor=deliveryActor(),now=new Date().toISOString();
  const assertActor=()=>{if(actorUid!==currentUser?.uid||actorRole!==currentUserRole)throw Error('登入身分已變更，請重新開啟調撥收貨。');};
  await runRoleTransaction(async tx=>{
    const ref=db.collection('stockTransfers').doc(id),snap=await tx.get(ref);if(!snap.exists)throw Error('調撥不存在。');const t={...snap.data(),id};
    if(t.dispatchIntentHash)throw Error('此調撥實貨由後端處理，禁止使用舊收貨或缺貨分配交易。');
    saved=t;if(t.status==='RECEIVED')return;if(t.status!=='IN_TRANSIT')throw Error('調撥狀態不可收貨。');
    const invRef=db.collection('inventory').doc(t.inventoryId),whRef=db.collection('warehouseStocks').doc(t.toStockId),invSnap=await tx.get(invRef),whSnap=await tx.get(whRef),destWh=await tx.get(db.collection('warehouses').doc(t.toWarehouseId));
    if(!invSnap.exists||!destWh.exists||destWh.data().active===false)throw Error('目的倉庫或庫存不存在。');const inv=invSnap.data(),wh=whSnap.exists?whSnap.data():{};
    const physicalPlan=YushinWarehouseLogistics.planTransferReceipt({aggregateStock:inv,warehouseStock:wh,qty:t.qty,reservedQty:t.reservedQty});
    let order=null,orderRef=null,resRef=null;
    if(t.orderId){orderRef=db.collection('orders').doc(t.orderId);const os=await tx.get(orderRef);if(!os.exists)throw Error('來源訂單不存在。');order=os.data();const item=order.items[t.itemIndex];if(!item||item.itemId!==t.itemId||item.transferPendingId!==id||normalizedOrderStatus(order)!=='normal')throw Error('來源訂單或調撥關聯已變更。');resRef=db.collection('inventoryReservations').doc(t.orderId+'__'+t.itemId);const rs=await tx.get(resRef);if(!rs.exists||Number(rs.data().quantity)!==t.reservedQty)throw Error('來源訂單預留不一致。');}
    assertActor();
    const allocation={autoAllocationQty:t.orderId?0:Math.max(0,t.qty-t.reservedQty),autoAllocatedQty:0,allocationCompleted:!!t.orderId||t.qty===t.reservedQty};
    tx.update(ref,{status:'RECEIVED',receivedAt:now,receivedByUid:actorUid,...allocation});saved={...t,status:'RECEIVED',...allocation};
    tx.update(invRef,{...physicalPlan.aggregate,updatedAt:now});
    tx.set(whRef,{productKey:t.productKey,productId:t.productId,warehouseId:t.toWarehouseId,itemCode:t.itemCode,itemName:t.itemName,brand:t.brand||'',brandId:t.brandId||'',...physicalPlan.target,updatedAt:now},{merge:true});writeTransferLots(tx,t,inv,now);
    tx.set(db.collection('inventoryMovements').doc(id+'-in'),{type:'warehouse_transfer_in',qty:t.qty,productKey:t.productKey,warehouseId:t.toWarehouseId,fromWarehouseId:t.fromWarehouseId,toWarehouseId:t.toWarehouseId,sourceType:'WAREHOUSE_TRANSFER',sourceId:id,transferId:id,orderId:t.orderId,itemId:t.itemId,createdAt:now,createdBy:actor,actorUid});
    if(order){const items=order.items.map((i,n)=>n===t.itemIndex?{...i,warehouseId:t.toWarehouseId,transferPendingId:''}:i);tx.update(resRef,{warehouseId:t.toWarehouseId,updatedAt:now});tx.update(orderRef,{items,warehouseLogisticsId:id,warehouseLogisticsEventId:id+'-received',logisticsTransfersPending:Math.max(0,Number(order.logisticsTransfersPending||0)-1),logisticsHistory:firebase.firestore.FieldValue.arrayUnion({id:id+'-received',action:'倉庫調撥收貨',itemId:t.itemId,by:actor,at:now,detail:t.toWarehouseId+' × '+t.qty}),...orderWorkIndexFields({...order,items}),updatedAt:now});}
  });
  if(!saved.orderId&&saved.status==='RECEIVED'&&saved.allocationCompleted===false){
    try{
      assertActor();
      const result=await allocateFreeReceiptStockToShortages(saved.productKey,saved.toWarehouseId,Math.max(0,Number(saved.autoAllocationQty||0)-Number(saved.autoAllocatedQty||0)),actor,'',id,'stockTransfers',assertActor,onStockCommitted);
      assertActor();
      await runRoleTransaction(async tx=>{assertActor();const ref=db.collection('stockTransfers').doc(id);const snapshot=await tx.get(ref);if(!snapshot.exists||snapshot.data().status!=='RECEIVED')throw Error('調撥分配進度已變更。');tx.update(ref,{allocationCompleted:true,allocationUpdatedAt:new Date().toISOString()});});
      saved.affectedOrderIds=result.affectedOrderIds;
    }catch(err){throw Object.assign(Error('調撥已入庫，但缺貨訂單分配未完成；請在調撥收貨按「重試庫存分配」，不會重複入庫：'+err.message),{transferCommitted:true});}
  }
  return saved;
}
if(typeof globalThis!=='undefined'){globalThis.commitWarehouseTransfer=commitWarehouseTransfer;globalThis.commitWarehouseTransferReceipt=commitWarehouseTransferReceipt;}

