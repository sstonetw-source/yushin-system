'use strict';
// V3 owner-Custody customer shipment trial.  The stock and reservation issue
// is the same shared operation as ordinary warehouse shipment; this adapter
// proves the original physical HANDOFF and limits the lots to that handoff.
// No customer acknowledgement, return, or cost amount is written here.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {normalizeShipmentIntent}=require('./location-shipment-service');
const reservationCore=require('./shared/reservation-core');
const inventoryCore=require('./shared/inventory-core');
const fulfillmentCore=require('./shared/fulfillment-core');
const logisticsCore=require('./shared/warehouse-logistics');

function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function id(value,label){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fail(label+'不正確','invalid-argument');
 return value;
}
function qty(value,label){
 if(!Number.isSafeInteger(value)||value<0)fail(label+'數量不正確');
 return value;
}
function custodyShipmentProject(env=process.env){
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return projectIdFromEnvironment(env)==='demo-yushin'
  &&env.FUNCTIONS_EMULATOR==='true'&&env.ENABLE_V3_CUSTODY_SHIPMENT_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}

async function commitCustodyShipment(db,uid,data,env=process.env){
 if(!custodyShipmentProject(env)||db.projectId!=='demo-yushin')
  fail('V3 保管實際出貨尚未在此專案啟用');
 id(uid,'登入者');
 const intent=normalizeShipmentIntent(data);
 const {orderId,itemId,warehouseId,operationId}=intent;
 const ref=(name,key)=>db.collection(name).doc(key);
 const movementRef=ref('inventoryMovements','location-ship-'+operationId);
 return db.runTransaction(async tx=>{
  const user=await tx.get(ref('users',uid));
  const actor=user.exists?user.data():null;
  if(!actor||actor.active===false||actor.disabled===true
    ||!['admin','sales','engineer'].includes(actor.role))
   fail('此帳號無業務保管出貨權限','permission-denied');
  const role=actor.role;
  const prior=await tx.get(movementRef);
  if(prior.exists){
   const proof=prior.data();
   if(proof.action!=='location_customer_shipment'||proof.custodyShipmentV3!==true
    ||proof.actorUid!==uid||proof.actorRole!==role||proof.sourceId!==orderId
    ||proof.itemId!==itemId||proof.intentHash!==intent.hash)
    fail('原出貨識別碼已用於其他交易','already-exists');
   return {...proof.result,status:'already-applied',movementId:movementRef.id};
  }
  const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
  if(!orderSnap.exists)fail('訂單不存在','not-found');
  const order=orderSnap.data();
  if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
   fail('僅能從自己保管倉出貨','permission-denied');
  if(!['normal','active'].includes(order.status)
    ||![undefined,'','normal','active'].includes(order.orderStatus)
    ||order.inventoryReservationStatus!=='completed'
    ||order.inventoryReservationAttemptId!==intent.syncAttemptId
    ||!order.ownerUid||!order.salesCode||!Array.isArray(order.items)
    ||!order.items.length||order.items.length>5
    ||order.items.filter(row=>row?.itemId===itemId).length!==1
    ||qty(order.logisticsTransfersPending??0,'調撥途中')!==0)
   fail('V3 保管實際出貨僅支援正常、來源同步一致的 1–5 品項訂單');
  const custodyId='custody-'+id(order.ownerUid,'業務負責人');
  if(warehouseId!==custodyId)fail('保管出貨不能從其他倉庫扣帳');
  const itemIndex=order.items.findIndex(row=>row.itemId===itemId);
  const item=order.items[itemIndex],productId=id(item.productId,'產品');
  const productKey=id(item.inventoryProductKey||productId,'庫存產品');
  const ordered=qty(item.qty??item.orderedQty,'訂購量');
  if(!ordered||(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty)
    ||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
    ||item.warehouseId!==custodyId||!item.custodyTransferId||item.transferPendingId
    ||qty(item.shortageQty??0,'品項缺口')!==0
    ||qty(item.supplyOrderedQty??0,'已採購')!==0||qty(item.receivedQty??0,'收貨')!==0)
   fail('品項不具備完整實體保管來源');
  const originalPlan=logisticsCore.validatePlan(item.deliveryPlan||order.shippingInstructions||{});
  if(!['PICKUP','SALES_SHIP'].includes(originalPlan.mode))
   fail('業務保管原交接方式不正確');
  if(originalPlan.mode==='SALES_SHIP')logisticsCore.validatePlan(originalPlan,true);
  const product=await tx.get(ref('products',productId));
  if(!product.exists||product.data().active===false
    ||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
   fail('產品主檔不是啟用的實體商品');
  if(!Array.isArray(order.warehouseShipmentRecords??[])
    ||!Array.isArray(order.deliveryRecords??[])||!Array.isArray(order.returnRecords??[])
    ||!Array.isArray(order.warehouseShipmentHistory??[])
    ||(order.warehouseShipmentHistory??[]).length
    ||(order.warehouseShipmentRecords??[]).length>40
    ||(order.deliveryRecords??[]).length||(order.returnRecords??[]).length
    ||qty(order.deliveredQty??0,'已送達')!==0||qty(order.returnedQty??0,'退貨')!==0
    ||order.isDelivered===true)
   fail('已有送達、退貨或更正紀錄，須等完整 V3 履約入口');
  const records=order.warehouseShipmentRecords??[];
  // Multi-line Custody is an explicitly narrower physical-shipment phase:
  // homogeneous owner-Custody goods, no commercial delivery/return yet.  The
  // whole-order projection prevents unknown sibling events from being hidden
  // by filtering to the selected line.
  if(order.items.length>1){
   for(const sibling of order.items){
    const siblingOrdered=qty(sibling.qty??sibling.orderedQty,'其他品項訂購量');
    if(!siblingOrdered||(sibling.qty!==undefined&&sibling.orderedQty!==undefined
      &&sibling.qty!==sibling.orderedQty)
      ||(sibling.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
      ||String(sibling.productType||sibling.type||'').toUpperCase()==='SERVICE'
      ||sibling.warehouseId!==custodyId||!sibling.custodyTransferId||sibling.transferPendingId
      ||qty(sibling.shortageQty??0,'其他品項缺口')!==0
      ||qty(sibling.supplyOrderedQty??0,'其他品項已採購')!==0
      ||qty(sibling.receivedQty??0,'其他品項收貨')!==0)
     fail('多品項出貨僅接受同一負責業務的完整實體保管品項');
   }
   const whole=fulfillmentCore.projectOrderShipmentReturns({orderId,items:order.items,
    shipments:records,deliveries:[],returns:[]});
   if(whole.confirmedQty!==0||whole.returnedQty!==0||whole.isDelivered)
    fail('多品項保管出貨不得混入已送達或退貨紀錄');
   for(const sibling of order.items){
    const part=whole.items.find(row=>row.itemId===sibling.itemId);
    const prepared=qty(sibling.dispatchPreparedQty??0,'其他品項打單量');
    if(!part||qty(sibling.warehouseShippedQty??0,'其他品項累計出貨')!==part.shippedQty
      ||qty(sibling.reservedQty,'其他品項預留')!==part.outstandingQty
      ||qty(sibling.deliveredQty??0,'其他品項送達')!==0
      ||qty(sibling.returnedQty??0,'其他品項退貨')!==0
      ||prepared<part.shippedQty||prepared>part.orderedQty)
     fail('多品項履約、打單或預留投影不一致');
   }
  }
  const itemRecords=records.filter(row=>row.itemId===itemId);
  const projection=fulfillmentCore.projectShipmentReturns({orderId,itemId,productKey,orderedQty:ordered,
   shipments:itemRecords,deliveries:[],returns:[]});
  const shipped=projection.shippedQty,held=qty(item.reservedQty,'品項預留');
  const prepared=qty(item.dispatchPreparedQty??0,'打單量');
  const state=fulfillmentCore.warehouseShipmentState({warehouseShippedQty:shipped,
   dispatchPreparedQty:prepared,reservedQty:held});
  if(qty(item.warehouseShippedQty??0,'累計出貨')!==shipped
    ||qty(item.deliveredQty??0,'已送達')!==0||qty(item.returnedQty??0,'退貨')!==0
    ||held!==projection.outstandingQty||prepared>ordered||shipped>ordered
    ||intent.quantity>state.shippable||intent.quantity>ordered-shipped
    ||records.some(row=>row.id===operationId))
   fail('出貨打單、預留或原履約投影不一致');
  const transferId=id(item.custodyTransferId,'原保管交接');
  const ledgerRef=ref('inventoryReservations',orderId+'__'+itemId);
  const ledgerSnap=await tx.get(ledgerRef),ledger=ledgerSnap.exists?ledgerSnap.data():null;
  if(!ledger||ledger.locationSchemaVersion!==3||ledger.warehouseId!==undefined
    ||ledger.status!=='active'||ledger.orderId!==orderId||ledger.itemId!==itemId
    ||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
    ||ledger.productKey!==productKey||ledger.custodyTransferId!==transferId
    ||ledger.custodyOriginalQty!==ordered||qty(ledger.quantity,'預留憑證')!==held
    ||qty(ledger.shortageQty??0,'預留缺口')!==0)
   fail('V3 預留與原保管交接來源不一致');
  // Validate the original physical source legs, even if a later shipment has
  // fulfilled part of the single custody position.
  const custodyLocations=reservationCore.reservationLocations(ledger);
  if(custodyLocations.length!==1||custodyLocations[0].warehouseId!==custodyId
    ||custodyLocations[0].qty!==held)fail('保管預留位置不一致');
  const transferSnap=await tx.get(ref('stockTransfers',transferId));
  const transfer=transferSnap.exists?transferSnap.data():null;
  const handoffProof=await tx.get(ref('reservationOperationReceipts','order-transfer-dispatch-'+transferId));
  const originalIn=await tx.get(ref('inventoryMovements',transferId+'-in'));
  const legRows=Array.isArray(transfer?.sourceLocations)?transfer.sourceLocations.map(row=>({
   warehouseId:row.warehouseId,reservedQty:row.qty})).sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId)):[];
  const ledgerRows=[...(ledger.sourceLocationSnapshot||[])].sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId));
  const originalProof=handoffProof.exists?handoffProof.data():null;
  if(!transfer||transfer.kind!=='HANDOFF'||transfer.status!=='RECEIVED'
    ||transfer.orderId!==orderId||transfer.itemId!==itemId||transfer.productKey!==productKey
    ||transfer.ownerUid!==order.ownerUid||transfer.salesCode!==order.salesCode
    ||transfer.toWarehouseId!==custodyId||transfer.qty!==ordered
    ||transfer.reservationLocationSchemaVersion!==2||transfer.custodyLocationSchemaVersion!==3
    ||JSON.stringify(transfer.lifecycleWarehouseIds)!==JSON.stringify(ledger.lifecycleWarehouseIds)
    ||JSON.stringify(legRows)!==JSON.stringify(ledgerRows)
    ||JSON.stringify(logisticsCore.plan(transfer.deliveryPlan||{}))!==JSON.stringify(originalPlan)
    ||!originalProof||originalProof.kind!=='ORDER_TRANSFER_DISPATCH'
    ||originalProof.intentHash!==transfer.orderTransferIntentHash
    ||originalProof.transfer?.id!==transferId
    ||Object.entries(originalProof.transfer).some(([field,value])=>field!=='status'
      &&JSON.stringify(transfer[field])!==JSON.stringify(value))
    ||!originalIn.exists||originalIn.data().type!=='warehouse_transfer_in'
    ||originalIn.data().sourceType!=='WAREHOUSE_TRANSFER'
    ||originalIn.data().sourceId!==transferId||originalIn.data().warehouseId!==custodyId
    ||originalIn.data().orderId!==orderId||originalIn.data().itemId!==itemId
    ||originalIn.data().productKey!==productKey||originalIn.data().qty!==ordered)
   fail('原 V3 業務保管交接與入庫憑證缺失或遭變更');
  if(!Array.isArray(transfer.allocations)||!transfer.allocations.length
    ||transfer.allocations.length>200)fail('原 V3 保管批次配置不正確');
  const master=await tx.get(ref('warehouses',custodyId));
  if(!master.exists||master.data().active===false||master.data().systemCustody!==true
    ||master.data().ownerUid!==order.ownerUid||master.data().warehouseType!=='CUSTODY')
   fail('保管倉主檔與訂單負責人不一致');
  const inventoryRef=ref('inventory',encodeURIComponent(productKey));
  const stockRef=ref('warehouseStocks',encodeURIComponent(custodyId)+'__'+encodeURIComponent(productKey));
  const company=await tx.get(inventoryRef),stock=await tx.get(stockRef);
  if(!company.exists||!stock.exists||company.data().productKey!==productKey
    ||stock.data().warehouseId!==custodyId||stock.data().productKey!==productKey)
   fail('公司與業務保管實貨來源不一致');
  const stockPlan=reservationCore.planReservationIssue({productKey,warehouseId:custodyId,
   qty:intent.quantity,reservation:ledger,aggregateStock:company.data(),
   warehouseStock:stock.data(),itemReservedQty:held,requireReservation:true});
  for(const previous of records){
   const sourceItem=order.items.find(row=>row.itemId===previous.itemId);
   const sourceKey=sourceItem&&id(sourceItem.inventoryProductKey||sourceItem.productId,'前次產品');
   if(!sourceItem||previous.custodyTransferId!==sourceItem.custodyTransferId
     ||previous.warehouseId!==custodyId)
    fail('前次 V3 實際出貨來源不屬於原保管交接');
   const saved=await tx.get(ref('inventoryMovements','location-ship-'+id(previous.id,'原出貨')));
   fulfillmentCore.validateShipmentMovement(previous,saved.exists?saved.data():null,
    {orderId,itemId:previous.itemId,productKey:sourceKey});
   const original=normalizeShipmentIntent({orderId,itemId:previous.itemId,warehouseId:custodyId,
    quantity:previous.qty,date:previous.date,notes:previous.notes,operationId:previous.id,
    syncAttemptId:intent.syncAttemptId,expectedPlan:previous.deliveryPlan});
   if(saved.data().intentHash!==original.hash||saved.data().custodyShipmentV3!==true
    ||saved.data().custodyTransferId!==sourceItem.custodyTransferId)
    fail('前次保管出貨憑證不一致');
  }
  const lotSnaps=await tx.get(db.collection('inventoryLots').where('productKey','==',productKey)
   .where('warehouseId','==',custodyId).limit(201));
  if(lotSnaps.size>200)fail('保管批次超出單次交易安全上限');
  const lots=lotSnaps.docs.map(s=>({...s.data(),id:s.id}));
  if(lots.some(lot=>lot.productKey!==productKey||lot.warehouseId!==custodyId
    ||qty(lot.remainingQty,'保管批次餘量')>qty(lot.qty??lot.receivedQty,'原保管批次量')))
   fail('保管批次數量或來源不一致');
  // An unbatched fallback would hide a missing provenance lot: fail closed.
  if(inventoryCore.reconcileStockLots(lots,stock.data().onHand,'custody-provenance-missing').unbatched)
   fail('保管實貨有缺少成本來源的未分批數量');
  const eligible=[];let sourceRemaining=0,sourceTotal=0;
  for(const [index,row] of transfer.allocations.entries()){
   const lotId=transferId+'-'+index;
   if(row.targetLotId!==lotId||typeof row.costLotId!=='string'||!row.costLotId
     ||!Number.isSafeInteger(row.qty)||row.qty<=0)fail('原交接成本批次識別碼不正確');
   const lot=lots.find(candidate=>candidate.id===lotId);
   if(!lot||lot.transferId!==transferId||lot.sourceId!==transferId
     ||lot.sourceType!=='WAREHOUSE_TRANSFER'||lot.costLotId!==row.costLotId
     ||qty(lot.qty,'交接批次入庫')!==row.qty)
    fail('保管批次與原交接配置不一致');
   const cost=await tx.get(ref('inventoryLotCosts',lotId));
   if(!cost.exists||cost.data().productKey!==productKey||cost.data().warehouseId!==custodyId
     ||cost.data().sourceId!==transferId||cost.data().costSourceLotId!==row.costLotId)
    fail('保管成本來源參照不一致');
   sourceTotal+=row.qty;sourceRemaining+=lot.remainingQty;
   eligible.push({...lot,unitCost:0});
  }
  if(sourceTotal!==ordered||sourceRemaining!==held)
   fail('保管批次剩餘實貨與原訂單預留不一致');
  const allocated=inventoryCore.allocateLots(eligible,intent.quantity);
  const lotAllocations=allocated.allocations.map(row=>({...row,
   costLotId:eligible.find(lot=>lot.id===row.lotId).costLotId}));
  const now=new Date().toISOString();
  const result={orderId,itemId,warehouseId:custodyId,qty:intent.quantity,
   reservedQty:stockPlan.reservation.quantity,grossShippedQty:shipped+intent.quantity,lotAllocations};
  const record={id:operationId,orderId,itemId,productKey,itemIndex,warehouseId:custodyId,
   date:intent.date,qty:intent.quantity,notes:intent.notes,
   sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT',deliveryPlan:intent.expectedPlan,
   custodyTransferId:transferId,createdBy:uid,createdByUid:uid,createdAt:now,
   movementId:movementRef.id,lotAllocations,cogs:0};
  const nextRecords=[...records,record];
  fulfillmentCore.projectOrderShipmentReturns({orderId,items:order.items,
   shipments:nextRecords,deliveries:[],returns:[]});
  const nextLedger={...stockPlan.reservation,updatedAt:now};
  delete nextLedger.warehouseId;
  const nextItem={...item,reservedQty:nextLedger.quantity,shortageQty:0,
   warehouseShippedQty:shipped+intent.quantity};
  const nextItems=order.items.map(row=>row.itemId===itemId?nextItem:row);
  const workIndex=await require('./service-order-fulfillment').mixedWorkIndex(db,tx,orderId,
   {...order,items:nextItems,warehouseShipmentRecords:nextRecords},{proofOrder:order});
  tx.update(inventoryRef,{...stockPlan.aggregateStock,updatedAt:now});
  tx.update(stockRef,{...stockPlan.warehouseStock,updatedAt:now});
  tx.update(ledgerRef,{quantity:nextLedger.quantity,locations:nextLedger.locations,
   status:nextLedger.status,updatedAt:now});
  for(const row of lotAllocations){
   const lot=eligible.find(candidate=>candidate.id===row.lotId);
   tx.update(ref('inventoryLots',row.lotId),{remainingQty:lot.remainingQty-row.qty,updatedAt:now});
  }
  tx.update(orderRef,{...workIndex,items:nextItems,warehouseShipmentRecords:nextRecords,
   warehouseShipmentRecordId:operationId,updatedAt:now});
  tx.create(movementRef,{action:'location_customer_shipment',type:'ship',qty:-intent.quantity,
   sourceType:'order',sourceId:orderId,itemId,productKey,warehouseId:custodyId,
   ownerUid:order.ownerUid,salesCode:order.salesCode,actorUid:uid,actorRole:role,
   createdBy:uid,createdAt:now,fulfillmentType:'WAREHOUSE',
   reservedDelta:stockPlan.reservedDelta,lotAllocations,costPending:true,
   custodyShipmentV3:true,custodyTransferId:transferId,intentHash:intent.hash,result});
  return {...result,status:'applied',movementId:movementRef.id};
 });
}

function createCustodyShipmentCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!custodyShipmentProject(env))throw new HttpsError('failed-precondition','V3 保管出貨尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitCustodyShipment(getDatabase(),request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('V3 Custody shipment transaction failed',error);
   throw new HttpsError('internal','保管實際出貨結果未確認，請以原操作編號查核');
  }
 });
}
module.exports={custodyShipmentProject,commitCustodyShipment,createCustodyShipmentCallable};
