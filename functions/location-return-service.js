'use strict';
// Internal Emulator-only receipt of restockable goods into their source warehouse.
const inventory=require('./shared/inventory-core'),reservation=require('./shared/reservation-core');
const fulfillment=require('./shared/fulfillment-core');
const {normalizeLocationReturnIntent,readLocationReturnProofs}=require('./location-return-trace-service');
const {readShipmentActorOrder,shipmentDeliveryContext,readShipmentProof}=require('./shipment-delivery-service');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function qty(value){if(!Number.isSafeInteger(value)||value<0)fault('退貨帳目數量不正確');return value;}
async function commitLocationReturn(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')fault('實物退貨目前僅允許 demo-yushin Emulator');
 const intent=normalizeLocationReturnIntent(data),{orderId,itemId,warehouseId,operationId}=intent;
 const ref=(n,k)=>db.collection(n).doc(k),movementRef=ref('inventoryMovements','location-return-'+operationId);
 return db.runTransaction(async tx=>{
  // Preserve the existing customer-return lifecycle authority: admin/own sales/engineer.
  const {actorRole,orderRef,order}=await readShipmentActorOrder(tx,db,uid,orderId);
  const applied=await tx.get(movementRef);
  if(applied.exists){
   const prior=applied.data();
   if(prior.action!=='location_customer_return'||prior.actorUid!==uid||prior.actorRole!==actorRole
    ||prior.intentHash!==intent.hash||prior.sourceId!==orderId||prior.itemId!==itemId)
    fault('退貨操作識別碼已用於其他交易','already-exists');
   return {...prior.result,status:'already-applied',movementId:movementRef.id};
  }
  const {item,productKey,projection,returnProjection}=shipmentDeliveryContext(order,intent,{allowReturns:true});
  if(order.returnHistory!==undefined&&!Array.isArray(order.returnHistory))fault('退貨歷史格式不正確');
  if(order.returnRecords.some(r=>r.id===operationId)||(order.returnHistory||[]).some(r=>r.recordId===operationId))
   fault('此退貨操作已有歷史紀錄，不能重複入庫');
  const shipment=await readShipmentProof(tx,db,order,intent,productKey);
  if(warehouseId!==shipment.warehouseId)fault('此試點只能收回原出貨倉，不可跨倉退回');
  await readLocationReturnProofs(tx,db,order,intent,productKey);
  const confirmedQty=projection.shipments.find(r=>r.shipmentId===intent.shipmentId)?.confirmedQty??0;
  const plan=inventory.planExplicitShipmentReturn({shipment,confirmedQty,selections:intent.selections,
   priorReturns:order.returnRecords.filter(r=>r.shipmentId===shipment.id)});
  const invRef=ref('inventory',encodeURIComponent(productKey));
  const stockRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
  const ledgerRef=ref('inventoryReservations',orderId+'__'+itemId);
  const inv=await tx.get(invRef),stock=await tx.get(stockRef),ledgerSnap=await tx.get(ledgerRef);
  const master=await tx.get(ref('warehouses',warehouseId));
  if(!inv.exists||!stock.exists||!ledgerSnap.exists||!master.exists)fault('退貨公司／分倉／預留／倉庫資料不完整');
  for(const raw of [inv.data(),stock.data()])for(const field of ['onHand','reserved','transferFreeInTransit'])
   qty(raw[field]??(field==='transferFreeInTransit'?0:undefined));
  if(!reservation.physicalWarehouse({...master.data(),id:warehouseId}))fault('收貨倉不是啟用中的實體倉');
  const ledger=ledgerSnap.data();
  if(ledger.locationSchemaVersion!==2||ledger.warehouseId!==undefined
   ||ledger.orderId!==orderId||ledger.itemId!==itemId||ledger.productKey!==productKey
   ||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
   ||ledger.status!==(qty(ledger.quantity)?'active':qty(ledger.shortageQty)?'shortage':'fulfilled')
   ||qty(ledger.quantity)+qty(ledger.shortageQty)!==returnProjection.outstandingQty
   ||qty(item.shortageQty)!==ledger.shortageQty
   ||inv.data().productKey!==productKey||stock.data().productKey!==productKey||stock.data().warehouseId!==warehouseId)
   fault('退貨預留來源、投影或公司／分倉帳目不一致');
  const stockPlan=reservation.planReservationReturn({operation:'CUSTOMER_RETURN',deltaQty:plan.returnQty,
   settlement:intent.settlement,orderStatus:'normal',productKey,warehouseId,reservation:ledger,
   aggregateStock:inv.data(),warehouseStock:stock.data(),itemReservedQty:item.reservedQty});
  const candidates=await tx.get(db.collection('inventoryLots').where('productKey','==',productKey)
   .where('warehouseId','==',warehouseId).limit(201));
  if(candidates.size>200)fault('退貨批次超過安全處理上限');
  const lots=candidates.docs.map(s=>({...s.data(),id:s.id}));
  for(const lot of lots){qty(lot.remainingQty);if(qty(lot.receivedQty)<lot.remainingQty)fault('批次餘量超過原入庫量');}
  // This check must reject a deficit as well as an excess; no synthetic lot repair.
  if(lots.reduce((total,lot)=>qty(total+lot.remainingQty),0)!==stock.data().onHand)fault('分倉實貨與權威批次合計不一致');
  for(const row of plan.allocations){
   const lot=lots.find(l=>l.id===row.lotId);
   if(!lot||String(lot.lotNo||'')!==row.lotNo||String(lot.expiryDate||'')!==row.expiryDate)
    fault('原出貨批次不存在或批號／效期不一致');
  }
  const restoration=inventory.planLotRestoration({productKey,warehouseId,allocations:plan.allocations,lots});
  if(restoration.some(r=>r.remainingQty>lots.find(l=>l.id===r.lotId).receivedQty))fault('退貨還原量超過原入庫量');
  const now=new Date().toISOString();
  const record={id:operationId,orderId,itemId,shipmentId:shipment.id,productKey,warehouseId,
   qty:plan.returnQty,sourceType:'WAREHOUSE_CUSTOMER_RETURN',date:intent.date,reason:intent.reason,
   settlement:intent.settlement,condition:intent.condition,lotAllocations:plan.allocations,
   movementId:movementRef.id,createdByUid:uid,createdByRole:actorRole,createdAt:now,intentHash:intent.hash};
  const records=[...order.returnRecords,record];
  const next=fulfillment.projectShipmentReturns({orderId,itemId,productKey,orderedQty:item.qty??item.orderedQty,
   shipments:order.warehouseShipmentRecords,deliveries:order.deliveryRecords,returns:records});
  if(stockPlan.reservation.quantity+stockPlan.reservation.shortageQty!==next.outstandingQty)
   fault('退貨後預留與補送需求不一致');
  const result={orderId,itemId,shipmentId:shipment.id,warehouseId,qty:plan.returnQty,settlement:intent.settlement,
   returnedQty:next.returnedQty,closedQty:next.closedQty,replacementQty:next.replacementQty,
   effectiveDeliveredQty:next.effectiveDeliveredQty,isDelivered:next.isDelivered,reservedQty:stockPlan.reservation.quantity};
  tx.update(invRef,{...stockPlan.aggregateStock,updatedAt:now});
  tx.update(stockRef,{...stockPlan.warehouseStock,updatedAt:now});
  tx.set(ledgerRef,{...stockPlan.reservation,updatedAt:now});
  for(const row of restoration)tx.update(ref('inventoryLots',row.lotId),{remainingQty:row.remainingQty,updatedAt:now});
  tx.update(orderRef,{items:[{...item,reservedQty:result.reservedQty,returnedQty:next.returnedQty}],
   returnedQty:next.returnedQty,isDelivered:next.isDelivered,returnRecords:records,
   returnHistory:[...(order.returnHistory||[]),{action:'add',recordId:operationId,before:null,after:record,by:uid,at:now}],updatedAt:now});
  tx.create(movementRef,{action:'location_customer_return',type:'return',qty:plan.returnQty,
   sourceType:'order',sourceId:orderId,itemId,productKey,warehouseId,actorUid:uid,actorRole,
   ownerUid:order.ownerUid,salesCode:order.salesCode,createdAt:now,reservedDelta:stockPlan.reservedDelta,
   lotAllocations:plan.allocations,costPending:true,intentHash:intent.hash,returnRecord:record,result,
   // CLOSE creates free stock; REPLACE reserves a customer replacement.
   ...(intent.settlement==='CLOSE'?{v2FreeStockSource:'CLOSED_CUSTOMER_RETURN',
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

module.exports={normalizeLocationReturnIntent,commitLocationReturn,commitLocationReturnAndRecover};
