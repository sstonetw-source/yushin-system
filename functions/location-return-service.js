'use strict';
// Internal Emulator-only receipt of restockable goods into their source warehouse.
const inventory=require('./shared/inventory-core'),reservation=require('./shared/reservation-core');
const fulfillment=require('./shared/fulfillment-core');
const {isDeepStrictEqual}=require('node:util');
const {assertCustomerReturnDatabase}=require('./customer-return-gate');
const {normalizeLocationReturnIntent,readLocationReturnProofs,assertCancelledCloseReturnContext,readMultiReturnSource}=require('./location-return-trace-service');
const {readShipmentActorOrder,shipmentDeliveryContext,readShipmentProof}=require('./shipment-delivery-service');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function qty(value){if(!Number.isSafeInteger(value)||value<0)fault('退貨帳目數量不正確');return value;}
// One request-history validator for application, withdrawal and physical receipt.
function validateLocationReturnRequests(order){
 const requests=order.returnRequests??[];
 if(!Array.isArray(requests)||requests.length>30)fault('退貨申請格式或筆數不正確');
 if(!Array.isArray(order.returnRecords??[]))fault('退貨紀錄格式不正確');
 const ids=new Set();
 for(const r of requests){
  if(!r||typeof r.id!=='string'||!r.id||ids.has(r.id)||typeof r.itemId!=='string'||!r.itemId
   ||!Number.isSafeInteger(r.qty)||r.qty<=0||!Number.isSafeInteger(r.receivedQty)||r.receivedQty<0||r.receivedQty>r.qty
   ||!['PENDING','RECEIVED','CANCELLED'].includes(r.status)||r.settlement!=='CLOSE'
   ||(r.status==='PENDING'&&r.receivedQty===r.qty)||(r.status==='RECEIVED'&&r.receivedQty!==r.qty))
   fault('退貨申請狀態或已收數量不一致');
  ids.add(r.id);
  const received=(order.returnRecords??[]).filter(row=>row.requestId===r.id);
  if(received.some(row=>row.itemId!==r.itemId||row.settlement!=='CLOSE'||!Number.isSafeInteger(row.qty)||row.qty<=0)
   ||received.reduce((sum,row)=>sum+row.qty,0)!==r.receivedQty)
   fault('退貨申請已收量與原入庫紀錄不一致');
 }
 return requests;
}
// Pure request projection; stock/lot planning remains in the original writer below.
function planLocationReturnRequest(order,intent,returnQty){
 const requests=order.returnRequests??[];
 if(!Array.isArray(requests)||requests.length>30)fault('退貨申請格式或筆數不正確');
 if(!intent.requestId){
  if(requests.some(r=>r?.itemId===intent.itemId&&r.status==='PENDING'))
   fault('此品項有待收退貨，請依原申請實收');
  return null;
 }
 validateLocationReturnRequests(order);
 if(order.returnPending!==requests.some(r=>r.status==='PENDING'))fault('退貨待收旗標不一致');
 const index=requests.findIndex(r=>r.id===intent.requestId),request=requests[index];
 if(!request||request.status!=='PENDING'||request.itemId!==intent.itemId)
  fault('找不到此品項的有效待收退貨申請');
 if(!Number.isSafeInteger(returnQty)||returnQty<=0||returnQty>request.qty-request.receivedQty)
  fault('退貨實收量超過申請餘量');
 const next={...request,receivedQty:request.receivedQty+returnQty};
 if(next.receivedQty===next.qty)next.status='RECEIVED';
 const updated=requests.map((r,i)=>i===index?next:r);
 return {requests:updated,index,returnPending:updated.some(r=>r.status==='PENDING')};
}
function assertLinkedReceipt(order,intent,record,receipt,uid,actorRole){
 const request=(order.returnRequests??[]).find(r=>r.id===intent.requestId);
 if(!record||record.requestId!==intent.requestId||record.id!==intent.operationId
  ||!request||request.itemId!==intent.itemId||!Number.isSafeInteger(request.receivedQty)||request.receivedQty<record.qty
  ||!receipt||receipt.orderId!==intent.orderId||receipt.requestId!==intent.requestId
  ||receipt.itemId!==intent.itemId||receipt.qty!==record.qty||receipt.warehouseId!==intent.warehouseId
  ||receipt.quality!=='SALEABLE'||receipt.disposition!=='STOCK'||receipt.receivedBy!==uid||receipt.receivedByRole!==actorRole
  ||receipt.intentHash!==intent.hash||receipt.movementId!==record.movementId
  ||!isDeepStrictEqual(receipt.record,record)
  ||!(order.returnRecords??[]).some(row=>isDeepStrictEqual(row,record)))
  fault('退貨申請實收缺少一致的原入庫憑證');
}
// V3 Custody has a different authoritative reservation schema from V2.
// A CLOSE receipt must validate all sibling holds without rerunning the V2
// physical-warehouse reader or manufacturing any replacement demand.
async function readMultiCustodyReturnLedgers(tx,db,order,intent,context,selectedLedger){
 if(!context.whole)return;
 const custody='custody-'+order.ownerUid;
 for(const source of order.items){
  const part=context.whole.items.find(row=>row.itemId===source.itemId);
  const snap=source.itemId===intent.itemId?null:await tx.get(
   db.collection('inventoryReservations').doc(intent.orderId+'__'+source.itemId));
  const ledger=snap?(snap.exists?snap.data():null):selectedLedger;
  const held=ledger&&reservation.reservationLocations(ledger);
  if(!part||!ledger||ledger.locationSchemaVersion!==3||ledger.warehouseId!==undefined
    ||ledger.orderId!==intent.orderId||ledger.itemId!==source.itemId
    ||ledger.productKey!==part.productKey||ledger.ownerUid!==order.ownerUid
    ||ledger.salesCode!==order.salesCode||ledger.custodyTransferId!==source.custodyTransferId
    ||ledger.custodyOriginalQty!==part.orderedQty||ledger.quantity!==source.reservedQty
    ||ledger.shortageQty!==0||ledger.quantity!==part.outstandingQty
    ||ledger.status!==(ledger.quantity?'active':'fulfilled')
    ||held.length!==(ledger.quantity?1:0)
    ||(ledger.quantity>0&&(held[0].warehouseId!==custody||held[0].qty!==ledger.quantity)))
   fault('整單 V3 退貨缺少一致的業務保管預留來源');
 }
}
async function commitLocationReturn(db,uid,data,env=process.env,options={}){
 const custodyV3=options.allowCustody===true;
 if(custodyV3){
  const {custodyReturnProject}=require('./custody-return-service');
  if(!custodyReturnProject(env)||db.projectId!=='demo-yushin')
   fault('V3 保管退貨收回尚未在此專案啟用');
 }else assertCustomerReturnDatabase(db,env);
 const intent=normalizeLocationReturnIntent(data),{orderId,itemId,warehouseId,operationId}=intent;
 if(custodyV3&&(intent.requestId!==undefined||intent.settlement!=='CLOSE'))
  fault('V3 保管退貨試點只接受無申請待收、已確認送達的 CLOSE 結案退貨');
 if(db.projectId==='preview-20135'&&(!intent.requestId||intent.settlement!=='CLOSE'))
  fault('Preview 退貨實收必須連結原申請並結案，不自動補送');
 const ref=(n,k)=>db.collection(n).doc(k),movementRef=ref('inventoryMovements','location-return-'+operationId);
 return db.runTransaction(async tx=>{
  // Logistics may receive a real pending request; unlinked lifecycle authority stays unchanged.
  const {actorRole,orderRef,order}=await readShipmentActorOrder(tx,db,uid,orderId,
   intent.requestId?['admin','purchaser','warehouse']:['admin','sales','engineer']);
  const applied=await tx.get(movementRef);
  const receiptRef=intent.requestId?ref('customerReturnReceipts',operationId):null;
  const receipt=receiptRef?await tx.get(receiptRef):null;
  if(applied.exists){
   const prior=applied.data();
   if(prior.action!=='location_customer_return'||prior.actorUid!==uid||prior.actorRole!==actorRole
    ||prior.intentHash!==intent.hash||prior.sourceId!==orderId||prior.itemId!==itemId)
    fault('退貨操作識別碼已用於其他交易','already-exists');
   if(intent.requestId)assertLinkedReceipt(order,intent,prior.returnRecord,receipt?.exists?receipt.data():null,uid,actorRole);
   return {...prior.result,status:'already-applied',movementId:movementRef.id};
  }
  if(receipt?.exists)fault('退貨收貨識別碼已用於其他交易','already-exists');
  const context=shipmentDeliveryContext(order,intent,{
   allowReturns:true,allowCancelledCloseReturn:intent.settlement==='CLOSE',
   allowMultiReturn:true,allowCustody:custodyV3});
  const {item,productKey,projection,returnProjection,cancelled,whole}=context;
  if(custodyV3){
   if(cancelled||!item.custodyTransferId||order.returnRecords.length
     ||(order.returnRequests??[]).length||order.returnPending===true)
    fault('V3 保管退貨目前只接受正常、未申請且尚未退貨的業務保管訂單');
   await require('./custody-delivery-service').readCustodyDeliveryProofs(tx,db,order,context,intent);
  }
  if(whole&&intent.settlement!=='CLOSE')fault('多品項退貨目前僅支援 CLOSE 結案，訂錯貨請另開新單');
  if(order.returnHistory!==undefined&&!Array.isArray(order.returnHistory))fault('退貨歷史格式不正確');
  assertCancelledCloseReturnContext(order,context);
  if(order.returnRecords.some(r=>r.id===operationId)||(order.returnHistory||[]).some(r=>r.recordId===operationId))
   fault('此退貨操作已有歷史紀錄，不能重複入庫');
  const shipment=await readShipmentProof(tx,db,order,intent,productKey);
  if(warehouseId!==shipment.warehouseId)fault('此試點只能收回原出貨倉，不可跨倉退回');
  await readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly:cancelled||!!whole});
  const confirmedQty=projection.shipments.find(r=>r.shipmentId===intent.shipmentId)?.confirmedQty??0;
  if(custodyV3){
   const selectedQty=intent.selections.reduce((total,row)=>total+row.qty,0);
   if(!Number.isSafeInteger(selectedQty)||selectedQty<=0||selectedQty>confirmedQty)
    fault('V3 保管退貨數量超過原出貨已確認送達量');
  }
  const plan=inventory.planExplicitShipmentReturn({shipment,confirmedQty,selections:intent.selections,
   priorReturns:order.returnRecords.filter(r=>r.shipmentId===shipment.id)});
  const requestPlan=planLocationReturnRequest(order,intent,plan.returnQty);
  const invRef=ref('inventory',encodeURIComponent(productKey));
  const stockRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
  const ledgerRef=ref('inventoryReservations',orderId+'__'+itemId);
  const inv=await tx.get(invRef),stock=await tx.get(stockRef),ledgerSnap=await tx.get(ledgerRef);
  const master=await tx.get(ref('warehouses',warehouseId));
  if(!inv.exists||!stock.exists||!ledgerSnap.exists||!master.exists)fault('退貨公司／分倉／預留／倉庫資料不完整');
  for(const raw of [inv.data(),stock.data()])for(const field of ['onHand','reserved','transferFreeInTransit'])
   qty(raw[field]??(field==='transferFreeInTransit'?0:undefined));
  if(custodyV3){
   if(warehouseId!=='custody-'+order.ownerUid||master.data().active===false
     ||master.data().systemCustody!==true||master.data().warehouseType!=='CUSTODY'
     ||master.data().ownerUid!==order.ownerUid)
    fault('V3 退貨只能由原負責業務保管倉收回');
  }else if(!reservation.physicalWarehouse({...master.data(),id:warehouseId}))
   fault('收貨倉不是啟用中的實體倉');
  const ledger=ledgerSnap.data();
  if(ledger.locationSchemaVersion!==(custodyV3?3:2)||ledger.warehouseId!==undefined
   ||ledger.orderId!==orderId||ledger.itemId!==itemId||ledger.productKey!==productKey
   ||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
   ||(custodyV3&&(ledger.custodyTransferId!==item.custodyTransferId
      ||ledger.custodyOriginalQty!==(item.qty??item.orderedQty)))
   ||ledger.status!==(cancelled?'released':qty(ledger.quantity)?'active':qty(ledger.shortageQty)?'shortage':'fulfilled')
   ||qty(ledger.quantity)+qty(ledger.shortageQty)!==(cancelled?0:returnProjection.outstandingQty)
   ||qty(item.shortageQty)!==ledger.shortageQty
   ||inv.data().productKey!==productKey||stock.data().productKey!==productKey||stock.data().warehouseId!==warehouseId)
   fault('退貨預留來源、投影或公司／分倉帳目不一致');
  if(custodyV3)await readMultiCustodyReturnLedgers(tx,db,order,intent,context,ledger);
  else await readMultiReturnSource(tx,db,order,intent,context,
   {ledger,inventory:inv.data(),warehouseStock:stock.data()});
  const stockPlan=reservation.planReservationReturn({operation:'CUSTOMER_RETURN',deltaQty:plan.returnQty,
   settlement:intent.settlement,orderStatus:cancelled?'cancelled':'normal',productKey,warehouseId,reservation:ledger,
   aggregateStock:inv.data(),warehouseStock:stock.data(),itemReservedQty:item.reservedQty});
  const candidates=await tx.get(db.collection('inventoryLots').where('productKey','==',productKey)
   .where('warehouseId','==',warehouseId).limit(201));
  if(candidates.size>200)fault('退貨批次超過安全處理上限');
  const lots=candidates.docs.map(s=>({...s.data(),id:s.id}));
  const originalLotQty=lot=>custodyV3?qty(lot.qty):qty(lot.receivedQty);
  for(const lot of lots){qty(lot.remainingQty);if(originalLotQty(lot)<lot.remainingQty)fault('批次餘量超過原入庫量');}
  // This check must reject a deficit as well as an excess; no synthetic lot repair.
  if(lots.reduce((total,lot)=>qty(total+lot.remainingQty),0)!==stock.data().onHand)fault('分倉實貨與權威批次合計不一致');
  for(const row of plan.allocations){
   const lot=lots.find(l=>l.id===row.lotId);
   if(!lot||String(lot.lotNo||'')!==row.lotNo||String(lot.expiryDate||'')!==row.expiryDate)
    fault('原出貨批次不存在或批號／效期不一致');
   if(custodyV3){
    const originalAllocation=shipment.lotAllocations.find(source=>source.lotId===row.lotId);
    const cost=await tx.get(ref('inventoryLotCosts',row.lotId));
    if(!originalAllocation||!cost.exists||!originalAllocation.costLotId
      ||lot.transferId!==item.custodyTransferId||lot.sourceId!==item.custodyTransferId
      ||lot.sourceType!=='WAREHOUSE_TRANSFER'||lot.costLotId!==originalAllocation.costLotId
      ||cost.data().productKey!==productKey||cost.data().warehouseId!==warehouseId
      ||cost.data().sourceId!==item.custodyTransferId
      ||cost.data().costSourceLotId!==originalAllocation.costLotId)
     fault('V3 退貨的原出貨批次成本來源不一致');
   }
  }
  const restoration=inventory.planLotRestoration({productKey,warehouseId,allocations:plan.allocations,lots});
  if(restoration.some(r=>r.remainingQty>originalLotQty(lots.find(l=>l.id===r.lotId))))fault('退貨還原量超過原入庫量');
  const now=new Date().toISOString();
  const record={id:operationId,orderId,itemId,shipmentId:shipment.id,productKey,warehouseId,
   qty:plan.returnQty,sourceType:'WAREHOUSE_CUSTOMER_RETURN',date:intent.date,reason:intent.reason,
   settlement:intent.settlement,condition:intent.condition,lotAllocations:plan.allocations,
   movementId:movementRef.id,createdByUid:uid,createdByRole:actorRole,createdAt:now,intentHash:intent.hash,
   ...(requestPlan?{requestId:intent.requestId,quality:'SALEABLE'}:{})};
  const records=[...order.returnRecords,record];
  const nextWhole=whole?fulfillment.projectOrderShipmentReturns({orderId,items:order.items,
   shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords,returns:records}):null;
  const next=nextWhole?nextWhole.items.find(row=>row.itemId===itemId):
   fulfillment.projectShipmentReturns({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
    shipments:order.warehouseShipmentRecords,deliveries:order.deliveryRecords,returns:records});
  if(stockPlan.reservation.quantity+stockPlan.reservation.shortageQty!==(cancelled?0:next.outstandingQty))
   fault('退貨後預留與補送需求不一致');
  const result={orderId,itemId,shipmentId:shipment.id,warehouseId,qty:plan.returnQty,settlement:intent.settlement,
   returnedQty:next.returnedQty,closedQty:next.closedQty,replacementQty:next.replacementQty,
   effectiveDeliveredQty:next.effectiveDeliveredQty,isDelivered:(nextWhole??next).isDelivered,reservedQty:stockPlan.reservation.quantity};
  if(nextWhole)result.itemIsDelivered=next.isDelivered;
  if(requestPlan)Object.assign(result,{requestId:intent.requestId,receiptId:operationId,
   requestReceivedQty:requestPlan.requests[requestPlan.index].receivedQty,
   requestStatus:requestPlan.requests[requestPlan.index].status});
  const workIndex=await require('./service-order-fulfillment').mixedWorkIndex(db,tx,orderId,
   {...order,items:order.items.map(row=>row.itemId===itemId?{...row,reservedQty:result.reservedQty,returnedQty:next.returnedQty}:row),
    returnedQty:(nextWhole??next).returnedQty,isDelivered:(nextWhole??next).isDelivered,returnRecords:records},{proofOrder:order});
  tx.update(invRef,{...stockPlan.aggregateStock,updatedAt:now});
  tx.update(stockRef,{...stockPlan.warehouseStock,updatedAt:now});
  tx.set(ledgerRef,{...stockPlan.reservation,updatedAt:now});
  for(const row of restoration)tx.update(ref('inventoryLots',row.lotId),{remainingQty:row.remainingQty,updatedAt:now});
  tx.update(orderRef,{...workIndex,items:order.items.map(row=>row.itemId===itemId?
   {...row,reservedQty:result.reservedQty,returnedQty:next.returnedQty}:row),
   returnedQty:(nextWhole??next).returnedQty,isDelivered:(nextWhole??next).isDelivered,returnRecords:records,
   returnHistory:[...(order.returnHistory||[]),{action:'add',recordId:operationId,before:null,after:record,by:uid,at:now}],
   ...(requestPlan?{returnRequests:requestPlan.requests,returnPending:requestPlan.returnPending,returnReceiptId:operationId}:{}),updatedAt:now});
  if(requestPlan)tx.create(receiptRef,{orderId,requestId:intent.requestId,requestIndex:requestPlan.index,
   qty:plan.returnQty,quality:'SALEABLE',warehouseId,itemId,itemName:item.itemName||'',
   ownerUid:order.ownerUid,salesCode:order.salesCode,disposition:'STOCK',record,
   sourceType:'WAREHOUSE_CUSTOMER_RETURN',movementId:movementRef.id,intentHash:intent.hash,
   createdAt:now,receivedBy:uid,receivedByRole:actorRole});
  tx.create(movementRef,{action:'location_customer_return',type:'return',qty:plan.returnQty,
   sourceType:'order',sourceId:orderId,itemId,productKey,warehouseId,actorUid:uid,actorRole,
   ownerUid:order.ownerUid,salesCode:order.salesCode,createdAt:now,reservedDelta:stockPlan.reservedDelta,
   lotAllocations:plan.allocations,costPending:true,intentHash:intent.hash,returnRecord:record,result,
   // CLOSE creates free stock; REPLACE reserves a customer replacement.
   ...(!custodyV3&&intent.settlement==='CLOSE'?{v2FreeStockSource:'CLOSED_CUSTOMER_RETURN',
     freeAllocationQty:plan.returnQty}:{} )});
  return {...result,status:'applied',movementId:movementRef.id};
 });
}

// Optional Emulator-only post-commit orchestrator. CLOSE receipt is complete
// before another order is considered; REPLACE is not free stock.
async function commitLocationReturnAndRecover(db,uid,input){
 const intent=normalizeLocationReturnIntent(input);
 const committed=await commitLocationReturn(db,uid,input);
 if(intent.settlement!=='CLOSE')
  return {...committed,postCommitAllocation:{status:'not-applicable',sources:[]}};
 const {continueCommittedV2FreeStock}=require('./single-item-location-service');
 const postCommitAllocation=await continueCommittedV2FreeStock(db,uid,[committed.movementId]);
 return {...committed,postCommitAllocation};
}

module.exports={validateLocationReturnRequests,normalizeLocationReturnIntent,planLocationReturnRequest,commitLocationReturn,commitLocationReturnAndRecover};
