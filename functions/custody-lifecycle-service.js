'use strict';
// V3 Custody lifecycle trial: a single authenticated, atomic order writer.
// Deliberately bounded to completely held, unshipped, supply-free orders in the
// demo Auth/Firestore Emulator. Shipment/return and supplier progress require
// separate authoritative proofs before this boundary can be expanded.
const {createHash}=require('node:crypto');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const reservation=require('./shared/reservation-core');
const demandCore=require('./shared/procurement-demand-core');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function ident(value,name){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>96)
  fail(name+'不正確','invalid-argument');
 return value;
}
function qty(value,name){
 if(!Number.isSafeInteger(value)||value<0)fail(name+'數量不正確');
 return value;
}
function custodyLifecycleProject(env=process.env){
 const local=x=>typeof x==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(x);
 return projectIdFromEnvironment(env)==='demo-yushin'
  &&env.ENABLE_V3_CUSTODY_LIFECYCLE_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}
function custodyLifecycleIntent(data){
 const keys=['orderId','itemIds','operationId','syncAttemptId','nextStatus','date','reason'];
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k))
  ||keys.some(k=>!Object.hasOwn(data,k))||!Array.isArray(data.itemIds)
  ||!data.itemIds.length||data.itemIds.length>5)fail('保管整單交易須指定 1–5 筆唯一品項','invalid-argument');
 const itemIds=data.itemIds.map(value=>ident(value,'品項 ID')).sort();
 if(new Set(itemIds).size!==itemIds.length)fail('保管整單品項重複','invalid-argument');
 const orderId=ident(data.orderId,'訂單 ID'),operationId=ident(data.operationId,'操作 ID');
 const syncAttemptId=ident(data.syncAttemptId,'同步 ID');
 if(!/^[A-Za-z0-9_-]{12,96}$/.test(operationId)||!/^[A-Za-z0-9_-]{12,96}$/.test(syncAttemptId))
  fail('原操作或同步識別碼不正確','invalid-argument');
 if(!['normal','cancelled'].includes(data.nextStatus))fail('保管取消恢復狀態不正確','invalid-argument');
 const date=data.date;
 if(typeof date!=='string'||!/\d{4}-\d{2}-\d{2}/.test(date)||date.length!==10
  ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
  ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)
  fail('取消恢復日期不正確','invalid-argument');
 if(typeof data.reason!=='string'||data.reason.length>1000)fail('取消恢復原因格式不正確','invalid-argument');
 const intent={orderId,itemIds,operationId,syncAttemptId,nextStatus:data.nextStatus,
  date,reason:data.reason.trim()};
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitCustodyOrderLifecycle(db,uid,data,env=process.env){
 const project=custodyLifecycleProject(env);
 if(!project||db.projectId!==project)fail('V3 保管取消恢復尚未在此專案啟用');
 ident(uid,'登入身分');
 const intent=custodyLifecycleIntent(data),{orderId,itemIds,operationId,nextStatus}=intent;
 const ref=(name,id)=>db.collection(name).doc(id);
 const receiptRef=ref('reservationOperationReceipts','v3-custody-lifecycle-'+operationId);
 return db.runTransaction(async tx=>{
  const user=await tx.get(ref('users',uid)),actor=user.exists?user.data():null;
  if(!actor||actor.active===false||actor.disabled===true
   ||!['admin','sales','engineer'].includes(actor.role))
   fail('此帳號無法取消或恢復保管訂單','permission-denied');
  const role=actor.role,orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
  if(!orderSnap.exists)fail('訂單不存在','not-found');
  const order=orderSnap.data();
  if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
   fail('不能更改其他業務的訂單','permission-denied');
  const existingReceipt=await tx.get(receiptRef);
  if(existingReceipt.exists){
   const saved=existingReceipt.data();
   if(saved.action!=='V3_CUSTODY_LIFECYCLE'||saved.orderId!==orderId
    ||saved.actorUid!==uid||saved.actorRole!==role||saved.intentHash!==intent.hash
    ||JSON.stringify(saved.itemIds)!==JSON.stringify(itemIds))
    fail('原操作識別碼已被其他交易使用','already-exists');
   return {...saved.result,status:'already-applied',receiptId:receiptRef.id};
  }
  const current=order.status==='cancelled'&&order.orderStatus==='cancelled'?'cancelled'
   :['normal','active'].includes(order.status)
    &&[undefined,'','normal','active'].includes(order.orderStatus)?'normal':null;
  if(!current||current===nextStatus)fail('訂單狀態不一致或已是目標狀態');
  if(order.inventoryReservationStatus!=='completed'
   ||order.inventoryReservationAttemptId!==intent.syncAttemptId
   ||!order.ownerUid||!order.salesCode||!Array.isArray(order.items)
   ||order.items.length!==itemIds.length
   ||order.items.some(row=>!row||!itemIds.includes(row.itemId))
   ||new Set(order.items.map(row=>row.itemId)).size!==itemIds.length)
   fail('整單品項或原同步來源不一致');
  const histories=['warehouseShipmentRecords','warehouseShipmentHistory','deliveryRecords','deliveryHistory',
   'returnRecords','returnHistory'];
  if(histories.some(key=>!Array.isArray(order[key]??[])||(order[key]??[]).length)
   ||qty(order.deliveredQty??0,'訂單送達')!==0||qty(order.returnedQty??0,'訂單退貨')!==0
   ||order.isDelivered===true||qty(order.logisticsTransfersPending??0,'調撥途中')!==0
   ||!Array.isArray(order.orderLifecycleHistory??[])||(order.orderLifecycleHistory??[]).length>=100)
   fail('此 V3 試點不接受已有出貨、退貨、送達或未結調撥的訂單');
  // The handoff trial is fully physically stocked. Procurement progress will
  // be handled by the existing purchase/demand authority in a later stage.
  const supplies=await tx.get(db.collection('supplyOrders').where('orderId','==',orderId).limit(1));
  if(!supplies.empty)fail('此 V3 試點尚未接入採購承諾，停止取消恢復');
  const receipts=await tx.get(db.collection('receipts').where('orderId','==',orderId).limit(1));
  if(!receipts.empty)fail('此 V3 試點尚未接入實際採購收貨，停止取消恢復');
  const companies=new Map(),warehouses=new Map(),plans=[];
  const now=new Date().toISOString(),custodyId='custody-'+order.ownerUid;
  const custodyMaster=await tx.get(ref('warehouses',custodyId));
  if(!custodyMaster.exists||custodyMaster.data().active===false
   ||custodyMaster.data().systemCustody!==true||custodyMaster.data().ownerUid!==order.ownerUid)
   fail('業務保管倉與目前訂單負責人不一致');
  for(const item of order.items){
   const itemId=ident(item.itemId,'品項 ID'),productId=ident(item.productId,'產品 ID');
   const productKey=ident(item.inventoryProductKey||productId,'庫存產品 ID');
   const requested=qty(item.qty??item.orderedQty,'訂購量');
   if(!requested||requested>1000000||item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty
    ||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
    ||item.warehouseId!==custodyId||!item.custodyTransferId||item.transferPendingId
    ||qty(item.dispatchPreparedQty??0,'打單量')!==0
    ||qty(item.warehouseShippedQty??0,'出貨量')!==0
    ||qty(item.deliveredQty??0,'送達量')!==0
    ||qty(item.returnedQty??0,'退貨量')!==0
    ||qty(item.supplyOrderedQty??0,'已採購')!==0
    ||qty(item.receivedQty??0,'已收貨')!==0
    ||qty(item.shortageQty??0,'缺貨量')!==0)
    fail('V3 品項已有供應或履約進度，尚未接入此試點');
   const product=await tx.get(ref('products',productId));
   if(!product.exists||product.data().active===false
    ||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
    fail('保管品項與實體產品主檔不一致');
   const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
   const demand=await tx.get(ref('procurementDemands',encodeURIComponent(demandId)));
   if(demand.exists)fail('保管訂單仍有採購需求憑證，須先完成後端供應整合');
   const linkedSupplies=await tx.get(db.collection('supplyOrders').where('demandId','==',demandId).limit(1));
   const linkedReceipts=await tx.get(db.collection('receipts').where('demandId','==',demandId).limit(1));
   if(!linkedSupplies.empty||!linkedReceipts.empty)
    fail('保管品項具有關聯的採購或收貨憑證，須先完成供應整合');
   const ledgerRef=ref('inventoryReservations',orderId+'__'+itemId),ledgerSnap=await tx.get(ledgerRef);
   if(!ledgerSnap.exists)fail('原 V3 預留不存在');
   const ledger=ledgerSnap.data(),held=qty(ledger.quantity,'預留量');
   if(ledger.orderId!==orderId||ledger.itemId!==itemId||ledger.productKey!==productKey
    ||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
    ||ledger.locationSchemaVersion!==3||ledger.custodyTransferId!==item.custodyTransferId
    ||ledger.custodyOriginalQty!==requested||held!==qty(item.reservedQty,'品項預留')
    ||qty(ledger.shortageQty??0,'預留缺口')!==0
    ||(current==='normal'&&(held!==requested||ledger.status!=='active'))
    ||(current==='cancelled'&&(held!==0||ledger.status!=='released')))
    fail('訂單與原 V3 預留來源或目前狀態不一致');
   const transferId=ident(item.custodyTransferId,'保管交接 ID'),transferSnap=await tx.get(ref('stockTransfers',transferId));
   const transfer=transferSnap.exists?transferSnap.data():null;
   const handoffProof=await tx.get(ref('reservationOperationReceipts','order-transfer-dispatch-'+transferId));
   const handoffIn=await tx.get(ref('inventoryMovements',transferId+'-in'));
   const originalLegs=Array.isArray(transfer?.sourceLocations)
    ?transfer.sourceLocations.map(row=>({warehouseId:row.warehouseId,reservedQty:row.qty}))
      .sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId)):[];
   const ledgerLegs=Array.isArray(ledger.sourceLocationSnapshot)
    ?[...ledger.sourceLocationSnapshot].sort((a,b)=>a.warehouseId.localeCompare(b.warehouseId)):[];
   const originalProof=handoffProof.exists?handoffProof.data():null;
   if(!transfer||transfer.kind!=='HANDOFF'||transfer.status!=='RECEIVED'
    ||transfer.orderId!==orderId||transfer.itemId!==itemId||transfer.qty!==requested
    ||transfer.ownerUid!==order.ownerUid||transfer.salesCode!==order.salesCode
    ||transfer.toWarehouseId!==custodyId||transfer.productKey!==productKey
    ||transfer.reservationLocationSchemaVersion!==2||transfer.custodyLocationSchemaVersion!==3
    ||JSON.stringify(transfer.lifecycleWarehouseIds)!==JSON.stringify(ledger.lifecycleWarehouseIds)
    ||JSON.stringify(originalLegs)!==JSON.stringify(ledgerLegs)
    ||!originalProof||originalProof.kind!=='ORDER_TRANSFER_DISPATCH'
    ||originalProof.intentHash!==transfer.orderTransferIntentHash
    ||originalProof.transfer?.id!==transferId
    ||Object.entries(originalProof.transfer).some(([field,value])=>field!=='status'
      &&JSON.stringify(transfer[field])!==JSON.stringify(value))
    ||!handoffIn.exists||handoffIn.data().type!=='warehouse_transfer_in'
    ||handoffIn.data().productKey!==productKey||handoffIn.data().warehouseId!==custodyId
    ||handoffIn.data().qty!==requested||handoffIn.data().orderId!==orderId
    ||handoffIn.data().itemId!==itemId||handoffIn.data().sourceType!=='WAREHOUSE_TRANSFER'
    ||handoffIn.data().sourceId!==transferId)
    fail('缺少完整的後端業務交接與入庫憑證');
   if(!companies.has(productKey)){
    const companyRef=ref('inventory',encodeURIComponent(productKey)),snapshot=await tx.get(companyRef);
    if(!snapshot.exists||snapshot.data().productKey!==productKey)fail('公司庫存來源不存在');
    companies.set(productKey,{ref:companyRef,initial:snapshot.data(),current:snapshot.data()});
   }
   const warehouseRef=ref('warehouseStocks',encodeURIComponent(custodyId)+'__'+encodeURIComponent(productKey));
   if(!warehouses.has(productKey)){
    const snapshot=await tx.get(warehouseRef);
    if(!snapshot.exists||snapshot.data().productKey!==productKey||snapshot.data().warehouseId!==custodyId)
     fail('保管倉庫存來源不存在');
    warehouses.set(productKey,{ref:warehouseRef,initial:snapshot.data(),current:snapshot.data()});
   }
   const companyState=companies.get(productKey),warehouseState=warehouses.get(productKey);
   const plan=reservation.planCustodyLifecycleReservation({reservation:ledger,productKey,
    ownerUid:order.ownerUid,custodyTransferId:transferId,nextStatus,targetQty:requested,
    itemReservedQty:held,aggregateStock:companyState.current,custodyStock:warehouseState.current});
   if(plan.warehouseDeltas.reduce((sum,row)=>sum+row.reservedDelta,0)!==plan.companyReservedDelta)
    fail('保管取消恢復的公司與倉庫差額不一致');
   const delta=plan.companyReservedDelta;
   companyState.current={...companyState.current,reserved:qty(companyState.current.reserved+delta,'公司預留')};
   warehouseState.current={...warehouseState.current,reserved:qty(warehouseState.current.reserved+delta,'保管倉預留')};
   plans.push({itemId,productKey,ledgerRef,plan,original:ledger,
    nextItem:{...item,reservedQty:plan.reservation.quantity,shortageQty:0}});
  }
  // All current stock states are based on serialized transaction snapshots.
  // No inventory/lot cost writer is invoked by a hold release/restoration.
  const result={orderId,nextStatus,items:plans.map(row=>({itemId:row.itemId,productKey:row.productKey,
   reservedQty:row.plan.reservation.quantity,companyReservedDelta:row.plan.companyReservedDelta,
   warehouseDeltas:row.plan.warehouseDeltas}))};
  const history={action:nextStatus==='normal'?'restore':'status_change',
   before:{status:current},after:{status:nextStatus,date:intent.date,reason:intent.reason},
   by:uid,actorRole:role,operationId,at:now};
  for(const state of [...companies.values(),...warehouses.values()]){
   if(state.initial.reserved!==state.current.reserved)
    tx.update(state.ref,{reserved:state.current.reserved,updatedAt:now});
  }
  for(const row of plans){
   tx.update(row.ledgerRef,{quantity:row.plan.reservation.quantity,
    locations:row.plan.reservation.locations,status:row.plan.reservation.status,
    shortageQty:0,updatedAt:now});
   if(row.plan.companyReservedDelta){
    const delta=row.plan.companyReservedDelta;
    tx.create(ref('inventoryMovements','v3-custody-life-'+operationId+'-'+encodeURIComponent(row.itemId)),{
     type:delta>0?'reserve':'release',qty:delta,
     sourceType:'order',sourceId:orderId,itemId:row.itemId,productKey:row.productKey,
     warehouseId:custodyId,ownerUid:order.ownerUid,salesCode:order.salesCode,
     actorUid:uid,actorRole:role,custodyTransferId:row.original.custodyTransferId,
     reservationOperationId:receiptRef.id,reason:nextStatus==='cancelled'?'order_cancelled':'order_restored',createdAt:now});
   }
  }
  tx.update(orderRef,{status:nextStatus==='cancelled'?'cancelled':'active',orderStatus:nextStatus,
   orderStatusDate:intent.date,orderStatusReason:intent.reason,
   items:order.items.map(row=>plans.find(plan=>plan.itemId===row.itemId).nextItem),
   orderLifecycleHistory:[...(order.orderLifecycleHistory||[]),history],updatedAt:now});
  tx.create(receiptRef,{action:'V3_CUSTODY_LIFECYCLE',actorUid:uid,actorRole:role,orderId,
   itemIds,intentHash:intent.hash,createdAt:now,result});
  return {...result,status:'applied',receiptId:receiptRef.id};
 });
}
function createCustodyLifecycleCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!custodyLifecycleProject(env))throw new HttpsError('failed-precondition','V3 保管取消恢復尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitCustodyOrderLifecycle(getDatabase(),request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('V3 custody lifecycle transaction failed',error);
   throw new HttpsError('internal','保管取消恢復結果未確認，請以原操作編號查核');
  }
 });
}
module.exports={custodyLifecycleProject,custodyLifecycleIntent,commitCustodyOrderLifecycle,createCustodyLifecycleCallable};
