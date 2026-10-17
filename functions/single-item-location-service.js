'use strict';
// Internal v2 single-item planner and Emulator-only atomic writer. Do NOT expose
// a Callable until all fulfillment writers support the same location ledger.
const {createHash}=require('node:crypto');
const core=require('./shared/reservation-core');
function reject(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function ident(v,name){if(typeof v!=='string'||!v||v!==v.trim()||v.includes('/')||v.length>160)reject(name+'不正確','invalid-argument');return v;}
function integer(v,name){if(!Number.isSafeInteger(v)||v<0)reject(name+'異常');return v;}
function normalizeSingleItemIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(x=>!['orderId','itemId','warehouseIds'].includes(x)))
   reject('請求內容不正確','invalid-argument');
 const orderId=ident(data.orderId,'訂單'),itemId=ident(data.itemId,'品項');
 if(!Array.isArray(data.warehouseIds)||data.warehouseIds.length!==2)
   reject('必須提供兩個候選倉','invalid-argument');
 const warehouseIds=data.warehouseIds.map(w=>ident(w,'倉庫')).sort();
 if(warehouseIds[0]===warehouseIds[1])reject('候選倉庫重複','invalid-argument');
 return {orderId,itemId,warehouseIds};
}
function checkStock(s,label){
 const onHand=integer(s.onHand,'實貨'),reserved=integer(s.reserved,'預留');
 const transferFreeInTransit=integer(s.transferFreeInTransit??0,'途中');
 if(reserved+transferFreeInTransit>onHand)reject(label+'庫存與途中帳不一致');
 return {onHand,reserved,transferFreeInTransit};
}
function normalizeCommitIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data)
   ||Object.keys(data).some(k=>!['orderId','itemId','warehouseIds','attemptId','syncAttemptId'].includes(k)))
   reject('請求內容不正確','invalid-argument');
 const intent=normalizeSingleItemIntent({orderId:data.orderId,itemId:data.itemId,warehouseIds:data.warehouseIds});
 const attemptId=ident(data.attemptId,'操作識別碼'),syncAttemptId=ident(data.syncAttemptId,'同步識別碼');
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(attemptId)||syncAttemptId.length>96)
   reject('操作或同步識別碼格式不正確','invalid-argument');
 const hash=createHash('sha256').update(JSON.stringify({...intent,syncAttemptId})).digest('hex');
 return {...intent,attemptId,syncAttemptId,hash};
}
async function commitSingleItemTwoWarehouse(db,uid,data){
 // Even a direct accidental import cannot write v2 into Preview/production yet.
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
   reject('雙倉 v2 提交目前僅允許 demo-yushin Emulator');
 const operation=normalizeCommitIntent(data);
 const {orderId,itemId,warehouseIds}=operation;
 return runSingleItemTwoWarehouse(db,uid,{orderId,itemId,warehouseIds},operation);
}
async function planSingleItemTwoWarehouse(db,uid,input){
 return runSingleItemTwoWarehouse(db,uid,input);
}
async function runSingleItemTwoWarehouse(db,uid,input,operation=null){
 ident(uid,'登入者');
 const {orderId,itemId,warehouseIds}=normalizeSingleItemIntent(input);
 const ref=(name,id)=>db.collection(name).doc(id);
 const receiptRef=operation?ref('reservationOperationReceipts','single-v2-'+operation.attemptId):null;
 return db.runTransaction(async tx=>{
  const profile=await tx.get(ref('users',uid));
  if(!profile.exists||profile.data().active===false||profile.data().disabled===true)
    reject('使用者已停用或不存在','permission-denied');
  const role=profile.data().role;
  if(!['admin','purchaser','warehouse','sales','engineer'].includes(role))
    reject('角色不可檢視預留','permission-denied');
  // Re-read the current owner even when returning an already-applied receipt.
  // A former sales/engineer owner must not inspect a result after reassignment.
  const orderRef=ref('orders',orderId),snap=await tx.get(orderRef);
  if(!snap.exists)reject('訂單不存在','not-found');
  const order=snap.data();
  if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
    reject('非負責業務不得檢視庫存配置','permission-denied');
  if(operation){
   const applied=await tx.get(receiptRef);
   if(applied.exists){
    const receipt=applied.data();
    if(receipt.actorUid!==uid||receipt.actorRole!==role||receipt.intentHash!==operation.hash
      ||receipt.orderId!==orderId||receipt.itemId!==itemId||receipt.action!=='single_item_location_reservation')
      reject('操作識別碼已用於其他交易','already-exists');
    return {...receipt.result,status:'already-applied',receiptId:receiptRef.id};
   }
  }
  if(operation&&(!order.ownerUid||!order.salesCode||order.inventoryReservationStatus!=='pending'
    ||order.inventoryReservationAttemptId!==operation.syncAttemptId))
    reject('來源訂單同步狀態或所有權已變更，請重新讀取');
  if(['cancelled','canceled','void','voided','deleted','closed','completed','已取消','作廢','已完成','結案'].some(x=>
      [order.status,order.orderStatus].some(v=>String(v||'').toLowerCase()===x)))
    reject('已取消或結案訂單不可建立預留');
  if(!Array.isArray(order.items))reject('訂單缺少品項');
  const matches=order.items.map((v,index)=>({v,index,id:String(v.itemId||'item-'+(index+1))})).filter(x=>x.id===itemId);
  if(matches.length!==1)reject('來源品項不是唯一');
  const item=matches[0].v;
  if((item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
    ||item.transferPendingId||item.custodyTransferId||integer(item.dispatchPreparedQty??0,'備貨量')>0)
    reject('非實體倉或已開始物流的品項不可預留');
  if(operation&&(integer(item.supplyOrderedQty??0,'供應量')||integer(item.receivedQty??0,'已收貨')))
    reject('已開始供應或收貨的品項不可用初始雙倉提交');
  const requested=integer(item.qty??item.orderedQty,'訂購量');
  const productId=ident(item.productId,'產品主檔');
  const productKey=ident(item.inventoryProductKey||productId,'庫存產品');
  const hint=ident(item.warehouseId||order.warehouseId,'來源倉');
  if(!warehouseIds.includes(hint))reject('候選倉庫須包含來源指定倉');
  const productSnap=await tx.get(ref('products',productId));
  if(!productSnap.exists||String(productSnap.data().productType||productSnap.data().type||'').toUpperCase()==='SERVICE')
    reject('服務商品不可實體預留');
  const companySnap=await tx.get(ref('inventory',encodeURIComponent(productKey)));
  if(!companySnap.exists||companySnap.data().productKey!==productKey)reject('公司庫存資料不完整');
  const company={...checkStock(companySnap.data(),'公司'),productKey};
  const warehouses=[],stocks={};
  for(const warehouseId of warehouseIds){
    const wh=await tx.get(ref('warehouses',warehouseId));
    const raw=await tx.get(ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey)));
    if(!wh.exists||!raw.exists)reject('來源分倉資料不存在');
    const master={...wh.data(),id:warehouseId};
    if(master.active===false||master.systemCustody||master.warehouseType==='CUSTODY'
      ||warehouseId.startsWith('custody-')||raw.data().productKey!==productKey||raw.data().warehouseId!==warehouseId)
      reject('候選位置不是啟用中實體倉');
    warehouses.push(master);
    stocks[warehouseId]={...checkStock(raw.data(),warehouseId),productKey,warehouseId};
  }
  const reservationRef=ref('inventoryReservations',orderId+'__'+itemId);
  const reservation=await tx.get(reservationRef);
  const previous=reservation.exists?reservation.data():{};
  if(previous.productKey&&previous.productKey!==productKey)reject('既有預留產品不符');
  if(previous.orderId&&previous.orderId!==orderId)reject('既有預留訂單不符');
  if(previous.itemId&&previous.itemId!==itemId)reject('既有預留品項不符');
  for(const [field,expected] of Object.entries({ownerUid:order.ownerUid,salesCode:order.salesCode}))
   if(previous[field]!==undefined&&previous[field]!==expected)reject('既有預留所有權不符');
  const returned=integer(item.returnedQty??0,'退貨量'),delivered=integer(item.deliveredQty??0,'已交付量');
  if(returned>delivered)reject('累計交付與退貨數量不符');
  // Initial-only safe preview: no goods have moved; supply commitments are
  // excluded from actual available stock by the shared Reservation Core.
  if(delivered||returned||item.transferPendingId||item.custodyTransferId)reject('非初始預留不得使用本試點');
  const outstanding=requested;
  const inTransit=Math.max(0,integer(item.supplyOrderedQty??0,'供應量')-integer(item.receivedQty??0,'已收貨'));
  const plan=core.planLocationReservation({productKey,requestedQty:outstanding,
    itemReservedQty:item.reservedQty??0,inTransitQty:inTransit,
    reservation:previous,aggregateStock:company,warehouses,stocks,currentWarehouseId:hint});
  if(plan.companyReservedDelta!==plan.warehouseDeltas.reduce((s,r)=>s+r.reservedDelta,0))
    reject('預留差額不守恆');
  const result={orderId,itemId,productKey,requestedQty:outstanding,
    locations:plan.reservation.locations,reservedQty:plan.reservation.quantity,
    shortageQty:plan.reservation.shortageQty,remainingToOrderQty:plan.remainingToOrderQty,
    companyReservedDelta:plan.companyReservedDelta,
    warehouseDeltas:plan.warehouseDeltas};
  if(!operation)return result;
  const now=new Date().toISOString();
  const nextCompany=company.reserved+plan.companyReservedDelta;
  integer(nextCompany,'公司預留');
  if(nextCompany+company.transferFreeInTransit>company.onHand)reject('公司庫存不足');
  // Validate every target before queuing any writes; callback retries re-read
  // the order, role, receipts, and all stock balances above.
  const changes=plan.warehouseDeltas.map(row=>{
   const stock=stocks[row.warehouseId];
   if(!stock)reject('預留差額含非候選倉');
   const reserved=integer(stock.reserved+row.reservedDelta,'分倉預留');
   if(reserved+stock.transferFreeInTransit>stock.onHand)reject('分倉庫存不足');
   return {...row,reserved};
  });
  const next={...previous,...plan.reservation,orderId,itemId,productKey,
   ownerUid:order.ownerUid,salesCode:order.salesCode,orderItemIndex:matches[0].index,updatedAt:now};
  // The legacy warehouseId is a hint on the order, never a v2 quantity authority.
  delete next.warehouseId;
  const nextItems=order.items.map((row,index)=>index===matches[0].index
   ?{...row,reservedQty:next.quantity,shortageQty:next.shortageQty,inventoryProductKey:productKey}:row);
  if(plan.companyReservedDelta)tx.update(ref('inventory',encodeURIComponent(productKey)),{reserved:nextCompany,updatedAt:now});
  for(const row of changes){
   tx.update(ref('warehouseStocks',encodeURIComponent(row.warehouseId)+'__'+encodeURIComponent(productKey)),
     {reserved:row.reserved,updatedAt:now});
   tx.create(ref('inventoryMovements','single-v2-'+operation.attemptId+'-'+encodeURIComponent(row.warehouseId)),
    {sourceType:'order',sourceId:orderId,itemId,productKey,warehouseId:row.warehouseId,
     type:row.reservedDelta>0?'reserve':'release',qty:row.reservedDelta,
     actorUid:uid,actorRole:role,reservationOperationId:receiptRef.id,createdAt:now});
  }
  tx.set(reservationRef,next);
  tx.update(orderRef,{items:nextItems,updatedAt:now});
  tx.create(receiptRef,{action:'single_item_location_reservation',orderId,itemId,productKey,
   actorUid:uid,actorRole:role,intentHash:operation.hash,syncAttemptId:operation.syncAttemptId,
   result,createdAt:now,status:'applied'});
  return {...result,status:'applied',receiptId:receiptRef.id};
 });
}

// Incremental, Emulator-only redistribution of genuinely free stock to an
// existing v2 single-item shortage. The initial reservation writer remains the
// same authority, and the Reservation Core owns all stock/ledger arithmetic.
const demandCore=require('./shared/procurement-demand-core');
function normalizeFreeStockIntent(input){
 const fields=['orderId','itemId','warehouseId','quantity','operationId','syncAttemptId'];
 if(!input||typeof input!=='object'||Array.isArray(input)
   ||Object.keys(input).some(k=>!fields.includes(k)))
   reject('自由庫存分配請求含未授權欄位','invalid-argument');
 const intent={};
 for(const field of ['orderId','itemId','warehouseId','operationId','syncAttemptId'])
  intent[field]=ident(input[field],field);
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId)||intent.syncAttemptId.length>96)
  reject('自由庫存操作或同步識別碼不正確','invalid-argument');
 intent.quantity=integer(input.quantity,'最大分配量');
 if(!intent.quantity)reject('分配量必須大於零','invalid-argument');
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitSingleItemFreeStockAllocation(db,uid,input){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  reject('跨 v2 訂單自由庫存分配僅允許 demo-yushin Emulator');
 ident(uid,'登入者');
 const intent=normalizeFreeStockIntent(input),{orderId,itemId,warehouseId,operationId}=intent;
 const ref=(name,key)=>db.collection(name).doc(key);
 const movementRef=ref('inventoryMovements','single-v2-free-'+operationId);
 return db.runTransaction(async tx=>{
  const actor=await tx.get(ref('users',uid));
  if(!actor.exists||actor.data().active===false||actor.data().disabled===true
    ||!['admin','purchaser','warehouse'].includes(actor.data().role))
   reject('目前登入角色不可重新分配庫存','permission-denied');
  const actorRole=actor.data().role;
  // Even a replay must check that its source order still exists.
  const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
  if(!orderSnap.exists)reject('待分配訂單不存在','not-found');
  const applied=await tx.get(movementRef);
  if(applied.exists){
   const proof=applied.data();
   if(proof.action!=='single_v2_free_stock_allocation'||proof.actorUid!==uid
     ||proof.actorRole!==actorRole||proof.orderId!==orderId||proof.itemId!==itemId
     ||proof.intentHash!==intent.hash)
    reject('分配操作 ID 已用於其他交易','already-exists');
   return {...proof.result,status:'already-applied',movementId:movementRef.id};
  }
  const order=orderSnap.data();
  if(order.inventoryReservationStatus!=='completed'
    ||order.inventoryReservationAttemptId!==intent.syncAttemptId
    ||!['active','normal'].includes(order.status)
    ||!['normal','active',undefined,''].includes(order.orderStatus)
    ||!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||order.items.length!==1)
   reject('來源訂單不是可分配的有效單品項訂單');
  const item=order.items[0];
  const productId=ident(item.productId,'產品'),productKey=ident(item.inventoryProductKey||productId,'庫存產品');
  const hint=ident(item.warehouseId||order.warehouseId,'來源指定倉');
  if(item.itemId!==itemId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
    ||item.transferPendingId||item.custodyTransferId
    ||integer(order.logisticsTransfersPending??0,'調撥途中')>0
    ||integer(item.dispatchPreparedQty??0,'已打單')>0
    ||integer(item.warehouseShippedQty??0,'已出貨')>0
    ||integer(item.deliveredQty??0,'已送達')>0
    ||integer(item.returnedQty??0,'已退貨')>0
    ||integer(item.supplyOrderedQty??0,'已採購')>0
    ||integer(item.receivedQty??0,'已收貨')>0
    ||integer(order.deliveredQty??0,'訂單送達')>0
    ||order.isDelivered===true
    ||['warehouseShipmentRecords','deliveryRecords','returnRecords','returnHistory']
       .some(k=>!Array.isArray(order[k]??[])||(order[k]??[]).length>0))
   reject('此試點僅分配尚無採購與履約事件的實體倉缺貨訂單');
  const ordered=integer(item.qty??item.orderedQty,'訂購量');
  if(!ordered||(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty))
   reject('訂購量與品項投影不一致');
  const product=await tx.get(ref('products',productId));
  if(!product.exists||product.data().active===false
    ||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
   reject('產品主檔不是有效實體商品');
  const warehouse=await tx.get(ref('warehouses',warehouseId));
  if(!warehouse.exists||!core.physicalWarehouse({...warehouse.data(),id:warehouseId}))
   reject('分配來源不是啟用中的實體倉');
  const ledgerRef=ref('inventoryReservations',orderId+'__'+itemId),ledgerSnap=await tx.get(ledgerRef);
  if(!ledgerSnap.exists)reject('缺少 v2 預留紀錄');
  const ledger=ledgerSnap.data();
  if(ledger.locationSchemaVersion!==2||ledger.warehouseId!==undefined
    ||ledger.orderId!==orderId||ledger.itemId!==itemId||ledger.productKey!==productKey
    ||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode)
   reject('v2 預留帳來源或位置版本異常');
  const held=integer(ledger.quantity,'預留量'),shortage=integer(ledger.shortageQty,'缺口');
  if(held!==integer(item.reservedQty,'品項預留')
    ||shortage!==integer(item.shortageQty,'品項缺口')||held+shortage!==ordered
    ||ledger.status!==(held?'active':'shortage'))
   reject('訂單與 v2 預留投影不一致');
  const locations=core.reservationLocations(ledger);
  if(ledger.lifecycleWarehouseIds!==undefined
    &&(!Array.isArray(ledger.lifecycleWarehouseIds)||!ledger.lifecycleWarehouseIds.includes(warehouseId)))
   reject('自由庫存來源倉不在已核定候選位置');
  if(!shortage)return {orderId,itemId,warehouseId,allocatedQty:0,status:'no-shortage'};
  // Do not trust a potentially stale order summary to imply zero supplier
  // commitments. This limited pilot refuses any recorded supply, even closed.
  const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
  const supplyByOrder=await tx.get(db.collection('supplyOrders').where('orderId','==',orderId).limit(1));
  const supplyByDemand=await tx.get(db.collection('supplyOrders').where('demandId','==',demandId).limit(1));
  if(!supplyByOrder.empty||!supplyByDemand.empty)
   reject('此訂單已有供應商承諾，不能改用無採購試點重新分配');
  const demandRef=ref('procurementDemands',encodeURIComponent(demandId));
  const demandSnap=await tx.get(demandRef),existingDemand=demandSnap.exists?demandSnap.data():null;
  if(existingDemand){
   const projected=demandCore.normalizeDemand(existingDemand);
   if(existingDemand.demandId!==demandId||existingDemand.sourceType!=='SALES_ORDER'
     ||existingDemand.sourceId!==orderId||existingDemand.sourceItemId!==itemId
     ||existingDemand.productId!==productId||existingDemand.productKey!==productKey
     ||existingDemand.fulfillmentType!=='WAREHOUSE'
     ||existingDemand.warehouseId!==hint||existingDemand.ownerUid!==order.ownerUid
     ||existingDemand.salesCode!==order.salesCode||existingDemand.cancelled===true
     ||existingDemand.orderedQty!==0||existingDemand.receivedQty!==0
     ||existingDemand.requestedQty!==shortage
     ||existingDemand.status!==projected.status
     ||existingDemand.remainingToOrderQty!==projected.remainingToOrderQty
     ||existingDemand.remainingToReceiveQty!==projected.remainingToReceiveQty)
    reject('既有採購需求不符合無供應缺口，請先稽核');
  }
  const companyRef=ref('inventory',encodeURIComponent(productKey));
  const stockRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
  const companySnap=await tx.get(companyRef),stockSnap=await tx.get(stockRef);
  if(!companySnap.exists||!stockSnap.exists
    ||companySnap.data().productKey!==productKey
    ||stockSnap.data().productKey!==productKey||stockSnap.data().warehouseId!==warehouseId)
   reject('公司或指定分倉庫存缺失');
  // The Core keeps all other v2 locations intact and limits this proposal by
  // both company and local free stock, including free stock in transit.
  const plan=core.planReservationReceipt({productKey,warehouseId,
   qty:intent.quantity,requestedReserveQty:shortage,addsStock:false,
   reservation:ledger,aggregateStock:companySnap.data(),warehouseStock:stockSnap.data(),
   itemReservedQty:item.reservedQty});
  if(!Number.isSafeInteger(plan.allocatedQty)||plan.allocatedQty<0
    ||plan.allocatedQty>intent.quantity||plan.allocatedQty>shortage)
   reject('共用預留核心回傳無效分配量');
  const delta=core.reservationStockDeltas(ledger,plan.reservation);
  if(delta.companyReservedDelta!==plan.allocatedQty
    ||delta.warehouseDeltas.length!==(plan.allocatedQty?1:0)
    ||(plan.allocatedQty>0&&(delta.warehouseDeltas[0].warehouseId!==warehouseId
      ||delta.warehouseDeltas[0].reservedDelta!==plan.allocatedQty)))
   reject('公司與分倉預留差額不守恆');
  if(!plan.allocatedQty)
   return {orderId,itemId,warehouseId,allocatedQty:0,status:'no-free-stock'};
  const now=new Date().toISOString(),nextItem={...item,
    reservedQty:plan.reservation.quantity,shortageQty:plan.reservation.shortageQty};
  const nextDemand=demandCore.demandDocument({
   ...(existingDemand||{}),...demandCore.fromSalesOrder({
    sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,fulfillmentType:'WAREHOUSE',
    shortageQty:plan.reservation.shortageQty,supplyOrderedQty:0,receivedQty:0}),
   sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,sourceItemIndex:0,
   productId,productKey,fulfillmentType:'WAREHOUSE',warehouseId:hint,
   itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
   ownerUid:order.ownerUid,salesCode:order.salesCode,salesName:order.salesName||''
  },{createdAt:existingDemand?.createdAt||order.createdAt||now,updatedAt:now});
  const result={orderId,itemId,warehouseId,allocatedQty:plan.allocatedQty,
    reservedQty:plan.reservation.quantity,shortageQty:plan.reservation.shortageQty,
    locations:plan.reservation.locations};
  tx.update(companyRef,{reserved:plan.aggregateStock.reserved,updatedAt:now});
  tx.update(stockRef,{reserved:plan.warehouseStock.reserved,updatedAt:now});
  tx.set(ledgerRef,{...plan.reservation,updatedAt:now});
  tx.update(orderRef,{items:[nextItem],updatedAt:now});
  if(existingDemand)tx.update(demandRef,{
   requestedQty:nextDemand.requestedQty,remainingToOrderQty:nextDemand.remainingToOrderQty,
   remainingToReceiveQty:nextDemand.remainingToReceiveQty,
   perOrdered:nextDemand.perOrdered,perReceived:nextDemand.perReceived,
   status:nextDemand.status,sourceItemIndex:0,updatedAt:now});
  else if(nextDemand.requestedQty>0)tx.create(demandRef,nextDemand);
  tx.create(movementRef,{
   action:'single_v2_free_stock_allocation',type:'reserve_from_free_stock',
   orderId,sourceType:'order',sourceId:orderId,itemId,productKey,warehouseId,
   qty:plan.allocatedQty,actorUid:uid,actorRole,
   reservedDelta:plan.allocatedQty,intentHash:intent.hash,createdAt:now,result});
  return {...result,status:'applied',movementId:movementRef.id};
 });
}

module.exports={normalizeSingleItemIntent,normalizeCommitIntent,planSingleItemTwoWarehouse,commitSingleItemTwoWarehouse,normalizeFreeStockIntent,commitSingleItemFreeStockAllocation};
