'use strict';
// Internal-only, pre-fulfillment v2 lifecycle. Do not export Callable or
// connect legacy pages until procurement-demand and partial-shipment paths are unified.
const {createHash}=require('node:crypto');
const core=require('./shared/reservation-core');
const demandCore=require('./shared/procurement-demand-core');
const workflowCore=require('./shared/workflow-core');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function ident(value,name){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fault(name+'不正確','invalid-argument');
 return value;
}
function number(value,name){
 if(!Number.isSafeInteger(value)||value<0)fault(name+'數量不正確');
 return value;
}
function normalizeLifecycleIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data)
  ||Object.keys(data).some(k=>!['orderId','itemId','warehouseIds','nextStatus','operationId','syncAttemptId','date','reason'].includes(k)))
  fault('取消或恢復請求含未授權的欄位','invalid-argument');
 const orderId=ident(data.orderId,'訂單 ID'),itemId=ident(data.itemId,'品項 ID');
 const operationId=ident(data.operationId,'操作 ID'),syncAttemptId=ident(data.syncAttemptId,'同步 ID');
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(operationId)||syncAttemptId.length>96)
  fault('操作或同步識別碼不正確','invalid-argument');
 if(!['cancelled','normal'].includes(data.nextStatus))fault('目標狀態不正確','invalid-argument');
 if(!Array.isArray(data.warehouseIds)||data.warehouseIds.length!==2)
  fault('必須提供原兩個候選實體倉','invalid-argument');
 const warehouseIds=data.warehouseIds.map(x=>ident(x,'倉庫 ID')).sort();
 if(warehouseIds[0]===warehouseIds[1])fault('候選倉重複','invalid-argument');
 if(typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date)
  ||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))
  ||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)
  fault('日期不正確','invalid-argument');
 const reason=data.reason??'';
 if(typeof reason!=='string'||reason.length>1000)fault('原因格式不正確','invalid-argument');
 const intent={orderId,itemId,warehouseIds,nextStatus:data.nextStatus,operationId,
  syncAttemptId,date:data.date,reason:reason.trim()};
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitSingleItemLocationLifecycle(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fault('v2 雙倉訂單取消與恢復僅允許 demo-yushin Emulator');
 ident(uid,'登入者');
 const intent=normalizeLifecycleIntent(data);
 const {orderId,itemId,warehouseIds,nextStatus,operationId,syncAttemptId}=intent;
 const ref=(collection,key)=>db.collection(collection).doc(key);
 const receiptRef=ref('reservationOperationReceipts','single-v2-lifecycle-'+operationId);
 return db.runTransaction(async tx=>{
  const actorSnap=await tx.get(ref('users',uid));
  if(!actorSnap.exists||actorSnap.data().active===false||actorSnap.data().disabled===true
   ||!['admin','sales','engineer'].includes(actorSnap.data().role))
   fault('此帳號不能取消或恢復訂單','permission-denied');
  const role=actorSnap.data().role;
  const applied=await tx.get(receiptRef);
  if(applied.exists){
   const record=applied.data();
   if(record.action!=='single_v2_lifecycle'||record.actorUid!==uid||record.actorRole!==role
    ||record.orderId!==orderId||record.itemId!==itemId||record.intentHash!==intent.hash)
    fault('操作識別碼已用於其他交易','already-exists');
   return {...record.result,status:'already-applied',receiptId:receiptRef.id};
  }
  const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
  if(!orderSnap.exists)fault('訂單不存在','not-found');
  const order=orderSnap.data();
  if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||order.items.length!==1
   ||order.items[0]?.itemId!==itemId)fault('此試點僅允許來源完整的單品項訂單');
  if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
   fault('不能操作其他業務的訂單','permission-denied');
  if(order.inventoryReservationStatus!=='completed'||order.inventoryReservationAttemptId!==syncAttemptId)
   fault('庫存同步尚未完成或同步識別碼已變更');
  // Both persisted status fields must agree; never accept one cancelled
  // projection with the other still claiming an active lifecycle.
  const current=(order.status==='cancelled'&&order.orderStatus==='cancelled')?'cancelled'
   :(['normal','active',undefined,''].includes(order.orderStatus)
    &&['normal','active'].includes(order.status)?'normal':null);
  if(!current)fault('訂單狀態不一致或已結案');
  if(current===nextStatus)fault('訂單已是指定狀態，不建立第二次異動');
  const item=order.items[0];
  if((item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
    ||item.transferPendingId||item.custodyTransferId
    ||number(order.logisticsTransfersPending??0,'調撥途中')>0)
   fault('品項不是可取消或恢復的實體倉商品');
  const ordered=number(item.qty??item.orderedQty,'訂購量');
  if(!ordered||(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty)
   ||number(item.deliveredQty??0,'已交付量')!==0
   ||number(item.returnedQty??0,'退貨量')!==0
   ||number(item.warehouseShippedQty??0,'已寄出量')!==0
   ||number(item.dispatchPreparedQty??0,'已打單量')!==0
   ||number(item.receivedQty??0,'已收貨量')!==0
   ||number(item.supplyOrderedQty??0,'供應量')!==0
   ||order.isDelivered===true
   ||(order.warehouseShipmentRecords??[]).length>0||(order.deliveryRecords??[]).length>0
   ||(order.returnRecords??[]).length>0||(order.warehouseShipmentHistory??[]).length>0
   ||(order.deliveryHistory??[]).length>0||(order.returnHistory??[]).length>0)
   fault('已打單、採購、收貨、寄出、送達或退貨的訂單不在初始取消試點範圍');
  if(!Array.isArray(order.warehouseShipmentRecords??[])||!Array.isArray(order.deliveryRecords??[])
    ||!Array.isArray(order.returnRecords??[])||!Array.isArray(order.orderLifecycleHistory??[])
    ||!Array.isArray(order.warehouseShipmentHistory??[])||!Array.isArray(order.deliveryHistory??[])
    ||!Array.isArray(order.returnHistory??[]))
   fault('訂單履約或狀態歷史格式不正確');
  const productId=ident(item.productId,'產品主檔'),productKey=ident(item.inventoryProductKey||productId,'庫存產品');
  const hint=ident(item.warehouseId||order.warehouseId,'來源指定倉');
  if(!warehouseIds.includes(hint))fault('候選倉庫必須包含訂單原指定倉');
  const product=await tx.get(ref('products',productId));
  if(!product.exists||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
   fault('實體產品主檔不存在或為服務品項');
  // The existing browser Procurement Demand adapter URL-encodes the whole
  // demand ID. A raw SALES_ORDER:... document is NOT the authoritative row.
  const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
  const demandRef=ref('procurementDemands',encodeURIComponent(demandId));
  const demandSnap=await tx.get(demandRef),previousDemand=demandSnap.exists?demandSnap.data():null;
  if(previousDemand){
   if(previousDemand.demandId!==demandId||previousDemand.sourceType!=='SALES_ORDER'
    ||previousDemand.sourceId!==orderId||previousDemand.sourceItemId!==itemId
    ||previousDemand.productId!==productId||previousDemand.productKey!==productKey
    ||previousDemand.fulfillmentType!=='WAREHOUSE'
    ||previousDemand.warehouseId!==hint||previousDemand.ownerUid!==order.ownerUid
    ||previousDemand.salesCode!==order.salesCode
    ||![undefined,-1,0].includes(previousDemand.sourceItemIndex))
    fault('採購需求與訂單來源或權限不一致，請先稽核');
   // Only sync a never-ordered Material Request in this bounded trial.
   // Committed POs/receipts, inconsistent projections and cancelled demands
   // on active orders require the broader supplier lifecycle transaction.
   const requested=number(previousDemand.requestedQty,'採購需求');
   const orderedDemand=number(previousDemand.orderedQty,'已採購');
   const receivedDemand=number(previousDemand.receivedQty,'已收貨');
   const pendingDemand=number(previousDemand.remainingToOrderQty,'待採購');
   const pendingReceipt=number(previousDemand.remainingToReceiveQty,'待收貨');
   if(orderedDemand||receivedDemand||pendingReceipt
    ||previousDemand.status!==(current==='normal'?'PENDING':'CANCELLED')
    ||(current==='normal'&&previousDemand.cancelled===true)
    ||(current==='normal'&&pendingDemand!==requested)
    ||(current==='cancelled'&&pendingDemand!==0))
    fault('採購需求具有供應承諾、錯誤狀態或異常投影，不能從初始 v2 流程變更');
  }
  const reservationRef=ref('inventoryReservations',orderId+'__'+itemId),ledgerSnap=await tx.get(reservationRef);
  if(!ledgerSnap.exists)fault('缺少 v2 權威預留');
  const original=ledgerSnap.data();
  if(original.locationSchemaVersion!==2||original.warehouseId!==undefined
    ||original.orderId!==orderId||original.itemId!==itemId||original.productKey!==productKey
    ||original.ownerUid!==order.ownerUid||original.salesCode!==order.salesCode)
   fault('既有預留來源或位置版本不一致');
  const oldQty=number(original.quantity,'預留量'),oldShortage=number(original.shortageQty,'缺口');
  if(oldQty!==number(item.reservedQty,'品項預留量')||oldShortage!==number(item.shortageQty??0,'品項缺口')
    ||(current==='normal'&&oldQty+oldShortage!==ordered)
    ||(current==='cancelled'&&(oldQty!==0||oldShortage!==0||original.status!=='released')))
   fault('訂單與 v2 預留投影不一致');
  const existing=core.reservationLocations(original);
  if(existing.some(row=>!warehouseIds.includes(row.warehouseId)))
   fault('候選倉沒有包含所有已預留來源');
  if(original.lifecycleWarehouseIds!==undefined&&
    (!Array.isArray(original.lifecycleWarehouseIds)
      ||JSON.stringify([...original.lifecycleWarehouseIds].sort())!==JSON.stringify(warehouseIds)))
   fault('候選倉與已保存的取消來源不一致');
  const invRef=ref('inventory',encodeURIComponent(productKey)),invSnap=await tx.get(invRef);
  if(!invSnap.exists||invSnap.data().productKey!==productKey)fault('公司庫存不存在或產品不一致');
  const warehouses=[],stocks={};const refs=new Map();
  for(const warehouseId of warehouseIds){
   const whSnap=await tx.get(ref('warehouses',warehouseId));
   const stockRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
   const stockSnap=await tx.get(stockRef);
   if(!whSnap.exists||!stockSnap.exists||stockSnap.data().productKey!==productKey
    ||stockSnap.data().warehouseId!==warehouseId)
    fault('候選倉或分倉庫存資料缺失');
   const master={...whSnap.data(),id:warehouseId};
   if(master.systemCustody||master.warehouseType==='CUSTODY'||warehouseId.startsWith('custody-'))
    fault('保管位置不能進入初始多倉取消流程');
   warehouses.push(master);stocks[warehouseId]=stockSnap.data();refs.set(warehouseId,stockRef);
  }
  const plan=core.planLocationReservation({productKey,warehouses,stocks,
   aggregateStock:invSnap.data(),reservation:original,requestedQty:ordered,inTransitQty:0,
   currentWarehouseId:hint,nextStatus,itemReservedQty:oldQty});
  if(plan.companyReservedDelta!==plan.warehouseDeltas.reduce((sum,row)=>sum+row.reservedDelta,0))
   fault('公司及分倉預留差額不守恆');
  const nextCompany=number(invSnap.data().reserved+plan.companyReservedDelta,'公司預留');
  if(nextCompany+number(invSnap.data().transferFreeInTransit??0,'公司途中')>number(invSnap.data().onHand,'公司實貨'))
   fault('公司庫存餘額不足');
  const changes=plan.warehouseDeltas.map(row=>{
   const stock=stocks[row.warehouseId];
   if(!stock)fault('預留差額包含未知倉');
   const reserved=number(stock.reserved+row.reservedDelta,'分倉預留');
   if(reserved+number(stock.transferFreeInTransit??0,'分倉途中')>number(stock.onHand,'分倉實貨'))
    fault('分倉庫存餘額不足');
   return {...row,reserved};
  });
  const nextLedger={...original,...plan.reservation,orderId,itemId,productKey,
   ownerUid:order.ownerUid,salesCode:order.salesCode,lifecycleWarehouseIds:warehouseIds};
  delete nextLedger.warehouseId;
  const now=new Date().toISOString(),nextItem={...item,reservedQty:nextLedger.quantity,
   shortageQty:nextLedger.shortageQty};
  // Use the same Workflow -> Procurement Demand Core chain as the old
  // order-lifecycle service, never derive requestedQty from page state.
  const demandProjection=workflowCore.procurementQuantities({
   orderedQty:ordered,fulfillmentType:'WAREHOUSE',reservedQty:nextItem.reservedQty,
   shortageQty:nextItem.shortageQty,supplyOrderedQty:0,receivedQty:0,
   deliveredQty:0,effectiveDeliveredQty:0,returnedQty:0
  });
  const baseDemand=nextStatus==='cancelled'
   ?(previousDemand?demandCore.cancelDemand(previousDemand):null)
   :demandCore.fromSalesOrder({sourceId:orderId,sourceItemId:itemId,sourceItemIndex:0,
     fulfillmentType:'WAREHOUSE',shortageQty:demandProjection.requiredSupplyQty,
     requiredSupplyQty:demandProjection.requiredSupplyQty,
     inTransitQty:demandProjection.inTransitQty,supplyOrderedQty:0,receivedQty:0});
  const nextDemand=baseDemand?demandCore.demandDocument({
   ...(previousDemand||{}),...baseDemand,
   cancelled:nextStatus==='cancelled',
   sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,
   sourceItemIndex:0,productId,productKey,itemCode:item.itemCode||'',
   itemName:item.itemName||'',brand:item.brand||'',fulfillmentType:'WAREHOUSE',
   warehouseId:hint,ownerUid:order.ownerUid,salesCode:order.salesCode,
   salesName:order.salesName||'',
   scheduleDate:previousDemand?.scheduleDate||item.requiredByDate||item.scheduleDate||order.requiredByDate||order.expectedDate||''
  },{createdAt:previousDemand?.createdAt||order.createdAt||now,updatedAt:now}):null;
  const nextStatusData={status:nextStatus==='cancelled'?'cancelled':'active',
   orderStatus:nextStatus,orderStatusDate:intent.date,orderStatusReason:intent.reason};
  const history={action:nextStatus==='normal'?'restore':'status_change',
   before:{status:current},after:{status:nextStatus,date:intent.date,reason:intent.reason},
   by:uid,actorRole:role,operationId,at:now};
  const result={orderId,itemId,nextStatus,reservedQty:nextLedger.quantity,
   shortageQty:nextLedger.shortageQty,locations:nextLedger.locations,
   companyReservedDelta:plan.companyReservedDelta,warehouseDeltas:plan.warehouseDeltas};
  if(plan.companyReservedDelta!==0)tx.update(invRef,{reserved:nextCompany,updatedAt:now});
  for(const change of changes){
   if(change.reservedDelta===0)continue;
   tx.update(refs.get(change.warehouseId),{reserved:change.reserved,updatedAt:now});
   tx.create(ref('inventoryMovements','single-v2-life-'+operationId+'-'+encodeURIComponent(change.warehouseId)),{
    sourceType:'order',sourceId:orderId,itemId,productKey,warehouseId:change.warehouseId,
    type:change.reservedDelta>0?'reserve':'release',qty:change.reservedDelta,
    actorUid:uid,actorRole:role,reason:nextStatus==='cancelled'?'order_cancelled':'order_restored',
    reservationOperationId:receiptRef.id,createdAt:now});
  }
  tx.set(reservationRef,{...nextLedger,updatedAt:now});
  // A cancellation without an existing Material Request must not invent one.
  // A restoration with shortage creates its demand in the same transaction.
  if(nextDemand&&(previousDemand||nextDemand.requestedQty>0)){
   if(previousDemand)tx.update(demandRef,{
    requestedQty:nextDemand.requestedQty,remainingToOrderQty:nextDemand.remainingToOrderQty,
    remainingToReceiveQty:nextDemand.remainingToReceiveQty,
    perOrdered:nextDemand.perOrdered,perReceived:nextDemand.perReceived,
    status:nextDemand.status,sourceItemIndex:0,updatedAt:now
   });
   else tx.create(demandRef,nextDemand);
  }
  tx.update(orderRef,{...nextStatusData,items:[nextItem],
   orderLifecycleHistory:[...(order.orderLifecycleHistory||[]),history],updatedAt:now});
  tx.create(receiptRef,{action:'single_v2_lifecycle',actorUid:uid,actorRole:role,
   orderId,itemId,productKey,intentHash:intent.hash,createdAt:now,result});
  return {...result,status:'applied',receiptId:receiptRef.id};
 });
}
module.exports={normalizeLifecycleIntent,commitSingleItemLocationLifecycle};
