'use strict';
// Internal Emulator-only customer shipment. No Callable or browser entry.
const {createHash}=require('node:crypto');
const reservationCore=require('./shared/reservation-core');
const inventoryCore=require('./shared/inventory-core');
const fulfillmentCore=require('./shared/fulfillment-core');
const logisticsCore=require('./shared/warehouse-logistics');
const {readLocationReturnProofs}=require('./location-return-trace-service');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function id(value,label){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fault(label+'不正確','invalid-argument');
 return value;
}
function quantity(value,label){
 if(!Number.isSafeInteger(value)||value<0)fault(label+'必須是非負整數');
 return value;
}
function normalizeShipmentIntent(data){
 const keys=['orderId','itemId','warehouseId','quantity','date','notes','operationId','syncAttemptId','expectedPlan'];
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))
  fault('出貨請求含未授權的欄位','invalid-argument');
 const intent={};
 for(const key of ['orderId','itemId','warehouseId','operationId','syncAttemptId'])intent[key]=id(data[key],key);
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId)||intent.syncAttemptId.length>96)
  fault('操作或同步識別碼格式不正確','invalid-argument');
 intent.quantity=quantity(data.quantity,'出貨量');
 if(!intent.quantity)fault('出貨量必須大於零','invalid-argument');
 if(typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date)
  ||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))
  ||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)
  fault('出貨日期不正確','invalid-argument');
 intent.date=data.date;intent.notes=data.notes??'';
 if(typeof intent.notes!=='string'||intent.notes.length>1000)fault('備註不正確','invalid-argument');
 const plan=data.expectedPlan;
 if(!plan||typeof plan!=='object'||Array.isArray(plan)
  ||Object.keys(plan).some(k=>!['mode','contact','phone','address','warehouseId','packages','notes'].includes(k)))
  fault('缺少原寄送資訊或含未授權欄位','invalid-argument');
 intent.expectedPlan=logisticsCore.validatePlan(plan,true);
 if(intent.expectedPlan.mode!=='CUSTOMER_SHIP')fault('此試點僅限直接寄客戶');
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitLocationShipment(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fault('多倉分批出貨目前僅允許 demo-yushin Emulator');
 id(uid,'登入者');
 const intent=normalizeShipmentIntent(data);
 const {orderId,itemId,warehouseId,operationId,syncAttemptId}=intent;
 const ref=(name,key)=>db.collection(name).doc(key);
 const movementRef=ref('inventoryMovements','location-ship-'+operationId);
 return db.runTransaction(async tx=>{
  const profile=await tx.get(ref('users',uid));
  if(!profile.exists||profile.data().active===false||profile.data().disabled===true
   ||!['admin','purchaser','warehouse'].includes(profile.data().role))
   fault('此帳號無倉庫出貨權限','permission-denied');
  const actorRole=profile.data().role;
  const applied=await tx.get(movementRef);
  if(applied.exists){
   const record=applied.data();
   if(record.action!=='location_customer_shipment'||record.actorUid!==uid||record.actorRole!==actorRole
    ||record.intentHash!==intent.hash||record.sourceId!==orderId||record.itemId!==itemId)
    fault('出貨操作識別碼已用於其他交易','already-exists');
   return {...record.result,status:'already-applied',movementId:movementRef.id};
  }
  const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
  if(!orderSnap.exists)fault('訂單不存在','not-found');
  const order=orderSnap.data();
  if(order.inventoryReservationStatus!=='completed'||order.inventoryReservationAttemptId!==syncAttemptId)
   fault('庫存同步未完成或來源同步識別碼已變更');
  if(!['active','normal'].includes(order.status)||![undefined,'','normal','active'].includes(order.orderStatus))
   fault('已取消或結案訂單不可出貨');
  if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||!order.items.length
   ||order.items.length>5||order.items.filter(row=>row?.itemId===itemId).length!==1)
   fault('此試點僅限完整且品項唯一的 1–5 品項訂單');
  const multi=order.items.length>1,item=order.items.find(row=>row.itemId===itemId);
  const itemIndex=order.items.indexOf(item);
  if(item.itemId!==itemId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
   ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
   ||item.transferPendingId||item.custodyTransferId||quantity(order.logisticsTransfersPending??0,'調撥途中')>0)
   fault('品項不是可出貨的實體倉商品');
  const sourcePlan=logisticsCore.validatePlan(item.deliveryPlan||order.shippingInstructions||{},true);
  if(sourcePlan.mode!=='CUSTOMER_SHIP'||JSON.stringify(sourcePlan)!==JSON.stringify(intent.expectedPlan))
   fault('寄送資訊已變更，請重新確認');
  const productId=id(item.productId,'產品'),productKey=id(item.inventoryProductKey||productId,'庫存產品');
  const product=await tx.get(ref('products',productId));
  if(!product.exists||product.data().active===false
   ||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
   fault('服務或停用商品不可出貨');
  const ordered=quantity(item.qty??item.orderedQty,'訂購量');
  if(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty)fault('訂購量投影不一致');
  if(!Array.isArray(order.deliveryRecords)||!Array.isArray(order.returnRecords))fault('出貨或退貨紀錄格式不正確');
  const records=order.warehouseShipmentRecords??[];
  const whole=multi?fulfillmentCore.projectOrderShipmentReturns({orderId,items:order.items,
   shipments:records,deliveries:order.deliveryRecords,returns:order.returnRecords}):null;
  const deliveryProjection=whole?whole.items.find(row=>row.itemId===itemId):
   fulfillmentCore.projectShipmentReturns({orderId,itemId,productKey,orderedQty:ordered,
    shipments:records,deliveries:order.deliveryRecords,returns:order.returnRecords});
  await readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly:true});
  const gross=deliveryProjection.shippedQty;
  if(records.some(row=>row.id===operationId)||(order.warehouseShipmentHistory||[]).some(row=>row.recordId===operationId))
   fault('此出貨識別碼已有歷史紀錄，不可重新扣帳');
  if(quantity(item.warehouseShippedQty??gross,'品項累計出貨量')!==gross
   ||quantity(item.deliveredQty??0,'品項送達量')!==deliveryProjection.confirmedQty
   ||quantity(order.deliveredQty??0,'訂單送達量')!==(whole??deliveryProjection).confirmedQty
   ||quantity(item.returnedQty??0,'品項退貨')!==deliveryProjection.returnedQty
   ||quantity(order.returnedQty??0,'訂單退貨')!==(whole??deliveryProjection).returnedQty
   ||(order.isDelivered??false)!==(whole??deliveryProjection).isDelivered)
   fault('出貨或客戶送達投影不一致');
  const prepared=quantity(item.dispatchPreparedQty??0,'打單量');
  const held=quantity(item.reservedQty,'品項預留');
  const state=fulfillmentCore.warehouseShipmentState({warehouseShippedQty:gross,
   dispatchPreparedQty:prepared,reservedQty:held});
  if(gross>ordered||prepared>ordered||intent.quantity>ordered-state.shippedQty
   ||intent.quantity>state.shippable)fault('已打單可出貨數量不足或已超額交付');

  // Multi-line shipment uses the same transaction, receipt reader, physical
  // issue planner and item ledger as single-line shipment. Every sibling is
  // checked before ANY stock or order write, including historical debits.
  const ledgerByItem=new Map();
  if(multi){
   if(records.length>40)fault('整單出貨憑證超過本試點查核上限');
   const products=new Map([[productId,product]]),claims=new Map(),warehouseClaims=new Map();
   let originalWarehouses=null;
   for(const row of order.items){
    const part=whole.items.find(candidate=>candidate.itemId===row.itemId);
    const siblingProductId=id(row.productId,'來源產品');
    const siblingKey=id(row.inventoryProductKey||siblingProductId,'來源庫存產品');
    if((row.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
     ||String(row.productType||row.type||'').toUpperCase()==='SERVICE'
     ||row.transferPendingId||row.custodyTransferId
     ||quantity(row.warehouseShippedQty??0,'品項已出貨')!==part.shippedQty
     ||quantity(row.deliveredQty??0,'品項已送達')!==part.confirmedQty
     ||quantity(row.returnedQty??0,'品項已退貨')!==part.returnedQty
     ||quantity(row.dispatchPreparedQty??0,'品項已打單')<part.shippedQty
     ||quantity(row.dispatchPreparedQty??0,'品項已打單')>part.orderedQty)
     fault('整單品項的來源、打單或履約投影不一致');
    if(!products.has(siblingProductId))products.set(siblingProductId,
     await tx.get(ref('products',siblingProductId)));
    const master=products.get(siblingProductId);
    if(!master.exists||master.data().active===false
     ||String(master.data().productType||master.data().type||'').toUpperCase()==='SERVICE')
     fault('整單含已停用或服務商品');
    const ledgerSnap=await tx.get(ref('inventoryReservations',orderId+'__'+row.itemId));
    if(!ledgerSnap.exists)fault('整單缺少原 v2 預留來源');
    const source=ledgerSnap.data();ledgerByItem.set(row.itemId,ledgerSnap);
    const held=quantity(row.reservedQty,'品項預留'),shortage=quantity(row.shortageQty??0,'品項缺口');
    if(source.locationSchemaVersion!==2||source.warehouseId!==undefined||source.orderId!==orderId
     ||source.itemId!==row.itemId||source.productKey!==siblingKey
     ||source.ownerUid!==order.ownerUid||source.salesCode!==order.salesCode
     ||quantity(source.quantity,'預留總量')!==held
     ||quantity(source.shortageQty,'預留缺口')!==shortage
     ||held+shortage!==part.outstandingQty
     ||source.status!==(held?'active':shortage?'shortage':'fulfilled')
     ||!Array.isArray(source.lifecycleWarehouseIds)||source.lifecycleWarehouseIds.length!==2
     ||new Set(source.lifecycleWarehouseIds).size!==2
     ||!Array.isArray(source.locations)||source.locations.length>20)
     fault('整單品項的 v2 預留來源或剩餘需求不一致');
    const candidates=source.lifecycleWarehouseIds.map(wh=>id(wh,'原候選倉')).sort().join('/');
    if(source.lifecycleWarehouseIds.some(wh=>wh.startsWith('custody-'))
     ||(originalWarehouses!==null&&originalWarehouses!==candidates)
     ||!source.lifecycleWarehouseIds.includes(row.warehouseId||order.warehouseId))
     fault('整單的原雙倉來源不一致');
    originalWarehouses=candidates;
    let subtotal=0;const seen=new Set();
    for(const location of source.locations){
     const wh=id(location?.warehouseId,'來源預留倉'),amount=quantity(location.reservedQty,'分倉預留');
     if(!amount||seen.has(wh)||!source.lifecycleWarehouseIds.includes(wh))
      fault('來源分倉預留異常');
     seen.add(wh);subtotal=quantity(subtotal+amount,'分倉預留合計');
     const key=JSON.stringify([siblingKey,wh]);
     warehouseClaims.set(key,quantity((warehouseClaims.get(key)||0)+amount,'分倉預留合計'));
    }
    if(subtotal!==held)fault('來源預留合計不一致');
    claims.set(siblingKey,quantity((claims.get(siblingKey)||0)+held,'公司預留合計'));
   }
   // A sibling cannot double-claim physical stock owned by another line.
   for(const [key,amount] of claims){
    const snapshot=await tx.get(ref('inventory',encodeURIComponent(key)));
    if(!snapshot.exists||snapshot.data().productKey!==key
     ||quantity(snapshot.data().reserved,'公司預留')<amount)
     fault('整單商品預留超過公司現有總帳');
   }
   for(const [key,amount] of warehouseClaims){
    const [productKey,wh]=JSON.parse(key);
    const snapshot=await tx.get(ref('warehouseStocks',encodeURIComponent(wh)+'__'+encodeURIComponent(productKey)));
    if(!snapshot.exists||snapshot.data().productKey!==productKey||snapshot.data().warehouseId!==wh
     ||quantity(snapshot.data().reserved,'分倉預留')<amount)
     fault('整單商品預留超過原分倉總帳');
   }
   for(const prior of records){
    const proofSnap=await tx.get(ref('inventoryMovements','location-ship-'+prior.id));
    const proof=proofSnap.exists?proofSnap.data():null;
    fulfillmentCore.validateShipmentMovement(prior,proof,
     {orderId,itemId:prior.itemId,productKey:prior.productKey});
    const signed=normalizeShipmentIntent({orderId,itemId:prior.itemId,warehouseId:prior.warehouseId,
     quantity:prior.qty,date:prior.date,notes:prior.notes,operationId:prior.id,
     syncAttemptId,expectedPlan:prior.deliveryPlan});
    if(proof.intentHash!==signed.hash)fault('整單過往出貨扣帳意圖不一致');
   }
  }
  const inventoryRef=ref('inventory',encodeURIComponent(productKey));
  const stockRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
  const reservationRef=ref('inventoryReservations',orderId+'__'+itemId);
  const company=await tx.get(inventoryRef),stock=await tx.get(stockRef);
  const warehouse=await tx.get(ref('warehouses',warehouseId)),
   reservation=multi?ledgerByItem.get(itemId):await tx.get(reservationRef);
  if(!company.exists||!stock.exists||!warehouse.exists||!reservation.exists)fault('公司／分倉／預留資料不完整');
  const master=warehouse.data(),ledger=reservation.data();
  if(master.active===false||master.systemCustody||master.warehouseType==='CUSTODY'||warehouseId.startsWith('custody-'))
   fault('指定倉不是啟用中的實體倉');
  if(ledger.locationSchemaVersion!==2||ledger.warehouseId!==undefined||ledger.status!=='active'||ledger.orderId!==orderId||ledger.itemId!==itemId
   ||ledger.productKey!==productKey||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode)
   fault('此試點須使用來源一致的 v2 預留');
  if(company.data().productKey!==productKey||stock.data().productKey!==productKey||stock.data().warehouseId!==warehouseId)
   fault('公司或分倉產品不一致');
  if(quantity(ledger.quantity,'預留總量')+quantity(ledger.shortageQty,'缺口')!==deliveryProjection.outstandingQty)
   fault('預留與尚待交付數量不一致');
  const stockPlan=reservationCore.planReservationIssue({productKey,warehouseId,qty:intent.quantity,
   reservation:ledger,aggregateStock:company.data(),warehouseStock:stock.data(),itemReservedQty:held,requireReservation:true});
  // Admin SDK supports query reads inside the transaction. Bound candidates,
  // including zero lots, so malformed balances cannot vanish through filtering.
  const lotQuery=db.collection('inventoryLots').where('productKey','==',productKey)
   .where('warehouseId','==',warehouseId).limit(201);
  const lotSnaps=await tx.get(lotQuery);
  if(lotSnaps.size>200)fault('批次超過安全處理上限');
  const lots=lotSnaps.docs.map(s=>({...s.data(),id:s.id}));
  for(const lot of lots){
   if(lot.productKey!==productKey||lot.warehouseId!==warehouseId)fault('批次來源不一致');
   quantity(lot.remainingQty,'批次餘量');
   if(lot.receivedQty!==undefined&&quantity(lot.receivedQty,'批次入庫量')<lot.remainingQty)fault('批次餘量超過原入庫量');
  }
  inventoryCore.reconcileStockLots(lots,stock.data().onHand,'unbatched-not-written');
  const allocation=inventoryCore.allocateLots(lots.map(lot=>({...lot,unitCost:0})),intent.quantity);
  const now=new Date().toISOString();
  const result={orderId,itemId,warehouseId,qty:intent.quantity,reservedQty:stockPlan.reservation.quantity,
   grossShippedQty:gross+intent.quantity,lotAllocations:allocation.allocations};
  const record={id:operationId,orderId,itemId,productKey,itemIndex,warehouseId,date:intent.date,
   qty:intent.quantity,notes:intent.notes,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT',deliveryPlan:sourcePlan,
   createdBy:uid,createdByUid:uid,createdAt:now,movementId:movementRef.id,lotAllocations:allocation.allocations,cogs:0};
  const nextRecords=[...records,record];
  if(multi)fulfillmentCore.projectOrderShipmentReturns({orderId,items:order.items,
   shipments:nextRecords,deliveries:order.deliveryRecords,returns:order.returnRecords});
  else fulfillmentCore.projectShipmentReturns({orderId,itemId,productKey,orderedQty:ordered,
   shipments:nextRecords,deliveries:order.deliveryRecords,returns:order.returnRecords});
  const nextLedger={...stockPlan.reservation,updatedAt:now};delete nextLedger.warehouseId;
  tx.update(inventoryRef,{...stockPlan.aggregateStock,updatedAt:now});
  tx.update(stockRef,{...stockPlan.warehouseStock,updatedAt:now});
  tx.set(reservationRef,nextLedger);
  for(const row of allocation.allocations){
   const lot=lots.find(lot=>lot.id===row.lotId);
   tx.update(ref('inventoryLots',row.lotId),{remainingQty:lot.remainingQty-row.qty,updatedAt:now});
  }
  tx.update(orderRef,{items:order.items.map(row=>row.itemId===itemId?{...row,
   reservedQty:result.reservedQty,shortageQty:nextLedger.shortageQty,
   warehouseShippedQty:result.grossShippedQty}:row),warehouseShipmentRecords:nextRecords,
   warehouseShipmentRecordId:operationId,updatedAt:now});
  tx.create(movementRef,{action:'location_customer_shipment',type:'ship',qty:-intent.quantity,
   sourceType:'order',sourceId:orderId,itemId,productKey,warehouseId,ownerUid:order.ownerUid,salesCode:order.salesCode,
   actorUid:uid,actorRole,createdBy:uid,createdAt:now,fulfillmentType:'WAREHOUSE',reservedDelta:stockPlan.reservedDelta,
   lotAllocations:allocation.allocations,costPending:true,intentHash:intent.hash,result});
  return {...result,status:'applied',movementId:movementRef.id};
 });
}
module.exports={normalizeShipmentIntent,commitLocationShipment};
