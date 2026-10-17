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
  const orderRef=ref('orders',orderId),snap=await tx.get(orderRef);
  if(!snap.exists)reject('訂單不存在','not-found');
  const order=snap.data();
  if(operation&&(!order.ownerUid||!order.salesCode||order.inventoryReservationStatus!=='pending'
    ||order.inventoryReservationAttemptId!==operation.syncAttemptId))
    reject('來源訂單同步狀態或所有權已變更，請重新讀取');
  if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
    reject('非負責業務不得檢視庫存配置','permission-denied');
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
module.exports={normalizeSingleItemIntent,normalizeCommitIntent,planSingleItemTwoWarehouse,commitSingleItemTwoWarehouse};
