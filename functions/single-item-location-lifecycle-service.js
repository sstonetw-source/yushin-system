'use strict';
// Internal-only, bounded v2 lifecycle. Do not export Callable or
// connect legacy pages until supplier commitments and broader fulfillment paths are unified.
const {createHash}=require('node:crypto');
const core=require('./shared/reservation-core');
const demandCore=require('./shared/procurement-demand-core');
const workflowCore=require('./shared/workflow-core');
const receivingCore=require('./shared/receiving-core');
const fulfillmentCore=require('./shared/fulfillment-core');
const {readShipmentProof}=require('./shipment-delivery-service');
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
  // Re-check current order ownership before an idempotent replay, without
  // requiring its current status or sync checkpoint to match the original.
  const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
  if(!orderSnap.exists)fault('訂單不存在','not-found');
  const order=orderSnap.data();
  if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
   fault('不能操作其他業務的訂單','permission-denied');
  const applied=await tx.get(receiptRef);
  if(applied.exists){
   const record=applied.data();
   if(record.action!=='single_v2_lifecycle'||record.actorUid!==uid||record.actorRole!==role
    ||record.orderId!==orderId||record.itemId!==itemId||record.intentHash!==intent.hash)
    fault('操作識別碼已用於其他交易','already-exists');
   return {...record.result,status:'already-applied',receiptId:receiptRef.id};
  }
  if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||order.items.length!==1
   ||order.items[0]?.itemId!==itemId)fault('此試點僅允許來源完整的單品項訂單');
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
   ||number(item.returnedQty??0,'退貨量')!==0
   ||order.isDelivered===true
   ||(order.returnRecords??[]).length>0||(order.returnHistory??[]).length>0)
   fault('全部送達或退貨的訂單不在此取消試點範圍');
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
  // Share the shipment authority, including actual debit proofs. Cancellation
  // only closes the unfulfilled remainder; acknowledged goods stay historical.
  const fulfillment=fulfillmentCore.projectShipmentDelivery({orderId,itemId,productKey,orderedQty:ordered,
   shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords??[]});
  if(number(item.warehouseShippedQty??0,'已寄出量')!==fulfillment.shippedQty
   ||number(item.deliveredQty??0,'已交付量')!==fulfillment.confirmedQty
   ||number(order.deliveredQty??0,'訂單已交付量')!==fulfillment.confirmedQty
   ||(order.isDelivered??false)!==fulfillment.isDelivered)
   fault('出貨或送達投影不一致');
  if(fulfillment.pendingDeliveryQty>0)fault('尚有途中貨物，須先完成送達確認');
  if(number(item.dispatchPreparedQty??0,'已打單量')!==fulfillment.shippedQty)
   fault('尚有已打單未出貨數量，不在取消試點範圍');
  const outstanding=ordered-fulfillment.confirmedQty;
  if(!outstanding)fault('訂單已無剩餘未交付數量');
  for(const shipment of order.warehouseShipmentRecords??[]){
   if(!warehouseIds.includes(shipment.warehouseId))fault('歷史出貨來源不在候選倉');
   await readShipmentProof(tx,db,order,{orderId,itemId,shipmentId:shipment.id,syncAttemptId},productKey);
  }
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
   const requested=number(previousDemand.requestedQty,'採購需求');
   const orderedDemand=number(previousDemand.orderedQty,'已採購');
   const receivedDemand=number(previousDemand.receivedQty,'已收貨');
   const pendingDemand=number(previousDemand.remainingToOrderQty,'待採購');
   const pendingReceipt=number(previousDemand.remainingToReceiveQty,'待收貨');
   const normalized=demandCore.normalizeDemand({...previousDemand,cancelled:current==='cancelled',
    status:current==='cancelled'?'CANCELLED':''});
   if(receivedDemand>orderedDemand||requested<orderedDemand||previousDemand.status!==normalized.status
    ||pendingDemand!==normalized.remainingToOrderQty||pendingReceipt!==normalized.remainingToReceiveQty
    ||(current==='normal'&&previousDemand.cancelled===true))
    fault('採購需求具有錯誤狀態或異常投影，請先稽核');
  }
  // Lock both source identities: neither a wrong demand link nor a wrong order
  // link may hide a supplier commitment. Each single-field query is bounded.
  const supplyRows=new Map();
  for(const [field,value] of [['orderId',orderId],['demandId',demandId]]){
   const page=await tx.get(db.collection('supplyOrders').where(field,'==',value).limit(51));
   if(page.size>50)fault('供應紀錄超過此試點 50 筆安全上限');
   for(const doc of page.docs)supplyRows.set(doc.id,{...doc.data(),id:doc.id});
  }
  if(supplyRows.size>50)fault('供應紀錄超過此試點 50 筆安全上限');
  const supplies=[...supplyRows.values()],purchaseSnapshots=new Map(),registeredByWarehouse=new Map();
  for(const supply of supplies){
   if(supply.orderId!==orderId||supply.itemId!==itemId||supply.sourceType!=='SALES_ORDER'
    ||supply.sourceId!==orderId||supply.sourceItemId!==itemId||supply.demandId!==demandId
    ||supply.productId!==productId||supply.productKey!==productKey
    ||supply.ownerUid!==order.ownerUid||supply.salesCode!==order.salesCode
    ||supply.fulfillmentType!=='WAREHOUSE'||!warehouseIds.includes(supply.warehouseId)
    ||!['PURCHASING_PO','PURCHASING_MANUAL','SALES_SELF_ORDER'].includes(supply.type)
    ||(supply.method!==undefined&&supply.method!==supply.type))
    fault('供應紀錄與採購需求、產品、倉庫或所有權不一致');
   const qty=number(supply.qty,'供應訂購'),received=number(supply.receivedQty??0,'供應收貨');
   const registered=number(supply.incomingRegisteredQty??0,'已登記採購在途');
   const normalizedSupply=receivingCore.normalizeSupply(supply);
   if(!qty||received>qty||supply.status!==normalizedSupply.status)
    fault('供應收貨數量或狀態異常');
   const terminal=['CANCELLED','CLOSED'].includes(supply.status);
   if((terminal&&(registered!==0||number(supply.closedQty??supply.cancelledQty,'已停止供應')!==qty-received))
    ||(!terminal&&registered>normalizedSupply.remainingQty))fault('供應停止數量或已登記在途投影不一致');
   registeredByWarehouse.set(supply.warehouseId,
    number((registeredByWarehouse.get(supply.warehouseId)||0)+registered,'分倉採購在途合計'));
   if(supply.type==='PURCHASING_PO'){
    const poId=ident(supply.purchaseDocumentId,'供應商採購單');
    let po=purchaseSnapshots.get(poId);
    if(!po){const snapshot=await tx.get(ref('purchaseOrders',poId));
     if(!snapshot.exists)fault('缺少來源供應商採購單');
     po=snapshot.data();purchaseSnapshots.set(poId,po);}
    const links=po.supplyOrderIds,index=Array.isArray(links)?links.indexOf(supply.id):-1;
    const line=Array.isArray(po.items)?po.items[index]:null;
    if(index<0||links.filter(id=>id===supply.id).length!==1||!line
     ||line.orderId!==orderId||line.itemId!==itemId||line.productId!==productId
     ||line.qty!==qty||line.warehouseId!==supply.warehouseId
     ||(line.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
     ||(normalizedSupply.remainingQty>0&&['CANCELLED','CLOSED'].includes(String(po.status||'').toUpperCase())))
     fault('供應紀錄與來源採購單明細或停止進度不一致');
   }
  }
  // Receipt facts, rather than caches on the order or supplier, prove physical
  // arrival. Lock both source identities; only the existing v2 receipt writer
  // creates this bounded contract. These are read-only evidence checks.
  const receipts=new Map();
  for(const [field,value] of [['orderId',orderId],['demandId',demandId]]){
   const page=await tx.get(db.collection('receipts').where(field,'==',value).limit(51));
   if(page.size>50)fault('收貨憑證超過此試點 50 筆安全上限');
   for(const doc of page.docs)receipts.set(doc.id,{...doc.data(),id:doc.id});
  }
  if(receipts.size>50)fault('收貨憑證超過此試點 50 筆安全上限');
  const receiptsBySupply=new Map(),seenReceiptLots=new Set();
  for(const receipt of receipts.values()){
   const supply=supplyRows.get(receipt.supplyOrderId),receiptQty=number(receipt.qty,'收貨憑證');
   if(!supply||!receiptQty||receipt.receiptId!==receipt.id||receipt.operationId!==receipt.id
    ||receipt.reservationLocationSchemaVersion!==2||receipt.documentSourceType!=='SUPPLY_ORDER'
    ||receipt.orderId!==orderId||receipt.itemId!==itemId||receipt.demandId!==demandId
    ||receipt.demandSourceType!=='SALES_ORDER'||receipt.sourceId!==orderId||receipt.sourceItemId!==itemId
    ||receipt.productKey!==productKey||receipt.productId!==productId||receipt.fulfillmentType!=='WAREHOUSE'
    ||receipt.warehouseId!==supply.warehouseId||receipt.ownerUid!==order.ownerUid||receipt.salesCode!==order.salesCode
    ||receipt.method!==supply.type||receipt.purchaseDocumentId!==(supply.purchaseDocumentId||''))
    fault('收貨憑證與供應、訂單或倉庫來源不一致');
   const cumulative=number(receipt.cumulativeReceivedQty,'累計收貨憑證');
   const receiptOrdered=number(receipt.orderedQty,'收貨時供應量');
   if(cumulative<receiptQty||cumulative>receiptOrdered||receiptOrdered>supply.qty)
    fault('收貨憑證累計數量異常');
   const movements=await tx.get(db.collection('inventoryMovements')
    .where('receiptId','==',receipt.id).where('type','==','receipt').limit(2));
   const movement=movements.size===1?movements.docs[0].data():null;
   if(!movement||movement.receiptId!==receipt.id||movement.qty!==receiptQty
    ||movement.sourceType!=='SUPPLY_ORDER'||movement.sourceId!==receipt.supplyOrderId
    ||movement.productKey!==productKey||movement.warehouseId!==receipt.warehouseId
    ||movement.lotNo!==receipt.lotNo||movement.expiryDate!==receipt.expiryDate
    ||movement.ownerUid!==order.ownerUid||movement.salesCode!==order.salesCode)
    fault('收貨憑證缺少唯一有效的實際入庫 movement');
   const lotId=ident(receipt.lotId,'收貨批次');
   if(seenReceiptLots.has(lotId))fault('不同收貨憑證不能重用同一入庫批次');
   seenReceiptLots.add(lotId);
   const lot=await tx.get(ref('inventoryLots',lotId));
   if(!lot.exists||lot.data().productKey!==productKey||lot.data().productId!==productId
    ||lot.data().warehouseId!==receipt.warehouseId||lot.data().sourceType!=='SUPPLY_ORDER'
    ||lot.data().sourceId!==receipt.supplyOrderId||lot.data().lotNo!==receipt.lotNo
    ||lot.data().expiryDate!==receipt.expiryDate||lot.data().receivedQty!==receiptQty
    ||number(lot.data().remainingQty,'批次剩餘量')>receiptQty)
    fault('收貨憑證與原入庫批次不一致');
   const rows=receiptsBySupply.get(receipt.supplyOrderId)||[];
   rows.push(receipt);receiptsBySupply.set(receipt.supplyOrderId,rows);
  }
  for(const supply of supplies){
   const rows=(receiptsBySupply.get(supply.id)||[]).sort((a,b)=>a.cumulativeReceivedQty-b.cumulativeReceivedQty);
   let received=0;
   for(const row of rows){received=number(received+row.qty,'供應實收合計');
    if(row.cumulativeReceivedQty!==received)fault('供應收貨憑證累計重複或不連續');}
   if(received!==(supply.receivedQty??0))fault('供應收貨摘要與實際入庫憑證不一致');
  }
  const supplied=demandCore.reconcileLinkedSupplies({demandId},supplies);
  const orderedSupply=number(item.supplyOrderedQty??0,'訂單供應量');
  const receivedSupply=number(item.receivedQty??0,'訂單收貨量');
  if(receivedSupply>orderedSupply||supplied.orderedQty!==orderedSupply||supplied.receivedQty!==receivedSupply
   ||(previousDemand&&(previousDemand.orderedQty!==orderedSupply||previousDemand.receivedQty!==receivedSupply))
   ||((orderedSupply>0||receivedSupply>0)&&!previousDemand))
   fault('訂單、採購需求與實際供應承諾／收貨不一致');
  const incomingSupply=workflowCore.procurementQuantities({supplyOrderedQty:orderedSupply,receivedQty:receivedSupply}).inTransitQty;
  const reservationRef=ref('inventoryReservations',orderId+'__'+itemId),ledgerSnap=await tx.get(reservationRef);
  if(!ledgerSnap.exists)fault('缺少 v2 權威預留');
  const original=ledgerSnap.data();
  if(original.locationSchemaVersion!==2||original.warehouseId!==undefined
    ||original.orderId!==orderId||original.itemId!==itemId||original.productKey!==productKey
    ||original.ownerUid!==order.ownerUid||original.salesCode!==order.salesCode)
   fault('既有預留來源或位置版本不一致');
  const oldQty=number(original.quantity,'預留量'),oldShortage=number(original.shortageQty,'缺口');
  if(oldQty!==number(item.reservedQty,'品項預留量')||oldShortage!==number(item.shortageQty??0,'品項缺口')
    ||(current==='normal'&&oldQty+oldShortage!==outstanding)
    ||(current==='cancelled'&&(oldQty!==0||oldShortage!==0||original.status!=='released')))
   fault('訂單與 v2 預留投影不一致');
  if(current==='normal'&&oldQty+Math.min(outstanding,incomingSupply)>outstanding)
   fault('現貨預留與供應在途重複涵蓋需求');
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
  // Supplier commitments and registered incoming remain untouched by a customer
  // cancellation. Only purchasing may cancel them after supplier confirmation.
  const registeredTotal=number([...registeredByWarehouse.values()].reduce((a,b)=>a+b,0),'公司採購在途合計');
  if(number(invSnap.data().incoming??0,'公司採購在途')<registeredTotal)
   fault('公司採購在途不足以涵蓋供應紀錄');
  for(const [warehouseId,registered] of registeredByWarehouse){
   if(number(stocks[warehouseId].incoming??0,'分倉採購在途')<registered)
    fault('分倉採購在途不足以涵蓋供應紀錄');
  }
  const plan=core.planLocationReservation({productKey,warehouses,stocks,
   aggregateStock:invSnap.data(),reservation:original,requestedQty:outstanding,inTransitQty:incomingSupply,
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
   shortageQty:nextItem.shortageQty,supplyOrderedQty:orderedSupply,receivedQty:receivedSupply,
   deliveredQty:fulfillment.confirmedQty,effectiveDeliveredQty:fulfillment.confirmedQty,returnedQty:0
  });
  const baseDemand=nextStatus==='cancelled'
   ?(previousDemand?demandCore.cancelDemand(previousDemand):null)
   :demandCore.fromSalesOrder({sourceId:orderId,sourceItemId:itemId,sourceItemIndex:0,
     fulfillmentType:'WAREHOUSE',shortageQty:demandProjection.requiredSupplyQty,
     requiredSupplyQty:demandProjection.requiredSupplyQty,
     inTransitQty:demandProjection.inTransitQty,supplyOrderedQty:orderedSupply,receivedQty:receivedSupply});
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
    cancelled:nextStatus==='cancelled',status:nextDemand.status,sourceItemIndex:0,updatedAt:now
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
