'use strict';
// Internal-only v2 dispatch preparation. Preparation creates paperwork, not a
// shipment or a customer delivery. No Callable/UI until all v2 adapters pass.
const {createHash}=require('node:crypto');
const fulfillment=require('./shared/fulfillment-core');
const {readLocationReturnProofs}=require('./location-return-trace-service');
function fault(message,code='failed-precondition'){const error=new Error(message);error.code=code;throw error;}
function id(value,label){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fault(label+'不正確','invalid-argument');
 return value;
}
function qty(value,label){
 if(!Number.isSafeInteger(value)||value<0)fault(label+'不是有效的非負整數');
 return value;
}
function normalizeLocationDispatchIntent(data){
 const keys=['orderId','itemId','quantity','operationId','syncAttemptId'];
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))
  fault('打單請求含未授權欄位','invalid-argument');
 const intent={orderId:id(data.orderId,'訂單'),itemId:id(data.itemId,'品項'),
  operationId:id(data.operationId,'操作識別碼'),syncAttemptId:id(data.syncAttemptId,'同步識別碼'),
  quantity:qty(data.quantity,'打單量')};
 if(!intent.quantity||!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId)
  ||intent.syncAttemptId.length>96)
  fault('打單數量或操作識別碼不正確','invalid-argument');
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitLocationDispatchPreparation(db,uid,data){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
  fault('多倉 v2 打單僅允許 demo-yushin Emulator');
 id(uid,'登入者');
 const intent=normalizeLocationDispatchIntent(data);
 const {orderId,itemId,quantity,operationId,syncAttemptId}=intent;
 const ref=(collection,key)=>db.collection(collection).doc(key);
 const recordRef=ref('dispatchRecords','v2-'+operationId);
 return db.runTransaction(async tx=>{
  const actor=await tx.get(ref('users',uid));
  if(!actor.exists||actor.data().active===false||actor.data().disabled===true
   ||!['admin','purchaser','warehouse'].includes(actor.data().role))
   fault('此帳號沒有打單權限','permission-denied');
  const actorRole=actor.data().role;
  const prior=await tx.get(recordRef);
  if(prior.exists){
   const record=prior.data();
   if(record.action!=='location_dispatch_prepared'||record.actorUid!==uid||record.actorRole!==actorRole
    ||record.intentHash!==intent.hash||record.orderId!==orderId||record.itemId!==itemId)
    fault('打單操作識別碼已用於其他交易','already-exists');
   return {...record.result,status:'already-applied',recordId:recordRef.id};
  }
  const orderRef=ref('orders',orderId),snap=await tx.get(orderRef);
  if(!snap.exists)fault('訂單不存在','not-found');
  const order=snap.data();
  if(order.inventoryReservationStatus!=='completed'||order.inventoryReservationAttemptId!==syncAttemptId)
   fault('庫存尚未同步完成或同步識別碼已變更');
  if(!['active','normal'].includes(order.status)||![undefined,'','normal','active'].includes(order.orderStatus))
   fault('取消或結案訂單不能打單');
  if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)||!order.items.length||order.items.length>5
   ||order.items.filter(row=>row?.itemId===itemId).length!==1)
   fault('此試點僅支援來源完整且品項唯一的 1–5 品項訂單');
  const item=order.items.find(row=>row.itemId===itemId),multi=order.items.length>1;
  if(item.itemId!==itemId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
   ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'
   ||item.transferPendingId||item.custodyTransferId||qty(order.logisticsTransfersPending??0,'調撥途中')>0)
   fault('此品項不是可打單的實體倉商品');
  const ordered=qty(item.qty??item.orderedQty,'訂購量');
  if(!ordered||(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty))
   fault('訂購數量異常');
  if(!Array.isArray(order.deliveryRecords)||!Array.isArray(order.returnRecords))
   fault('出貨或退貨紀錄格式不正確');
  const productKey=id(item.inventoryProductKey||item.productId,'庫存產品');
  const whole=multi?fulfillment.projectOrderShipmentReturns({orderId,items:order.items,
   shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords,returns:order.returnRecords}):null;
  const progress=whole?whole.items.find(row=>row.itemId===itemId):fulfillment.projectShipmentReturns({orderId,itemId,productKey,orderedQty:ordered,
   shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords,returns:order.returnRecords});
  await readLocationReturnProofs(tx,db,order,intent,productKey,{closedOnly:true});
  const shipped=qty(item.warehouseShippedQty??0,'出貨投影');
  const delivered=qty(item.deliveredQty??0,'送達投影');
  const prepared=qty(item.dispatchPreparedQty??0,'已打單量');
  const held=qty(item.reservedQty,'品項預留');
  const shortage=qty(item.shortageQty??0,'缺口');
  if(shipped!==progress.shippedQty||delivered!==progress.confirmedQty
   ||qty(order.deliveredQty??0,'訂單送達')!==(whole??progress).confirmedQty
   ||qty(item.returnedQty??0,'品項退貨')!==progress.returnedQty
   ||qty(order.returnedQty??0,'訂單退貨')!==(whole??progress).returnedQty
   ||(order.isDelivered??false)!==(whole??progress).isDelivered||prepared>ordered)
   fault('出貨、送達或打單投影不一致');
  if(multi){
   const products=new Map();
   for(const row of order.items){
    const part=whole.items.find(p=>p.itemId===row.itemId);
    if((row.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'||String(row.productType||row.type||'').toUpperCase()==='SERVICE'
     ||row.transferPendingId||row.custodyTransferId||qty(row.warehouseShippedQty??0,'品項出貨')!==part.shippedQty
     ||qty(row.deliveredQty??0,'品項送達')!==part.confirmedQty||qty(row.returnedQty??0,'品項退貨')!==part.returnedQty
     ||qty(row.dispatchPreparedQty??0,'品項打單')<part.shippedQty
     ||qty(row.dispatchPreparedQty??0,'品項打單')>part.orderedQty)
     fault('整單含未支援的品項或履約投影不一致');
    const productId=id(row.productId,'產品');
    if(!products.has(productId))products.set(productId,await tx.get(ref('products',productId)));
    const product=products.get(productId);
    if(!product.exists||product.data().active===false||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
     fault('整單含服務或停用產品，不能打單');
   }
   for(const record of order.warehouseShipmentRecords??[]){
    if(record.movementId!=='location-ship-'+record.id)fault('整單出貨缺少原扣帳憑證');
    const proof=await tx.get(ref('inventoryMovements',record.movementId));
    fulfillment.validateShipmentMovement(record,proof.exists?proof.data():null,
     {orderId,itemId:record.itemId,productKey:record.productKey});
   }
  }
  for(const part of whole?.items??[{...progress,itemId,productKey}]){
   const {itemId,productKey}=part,row=order.items.find(source=>source.itemId===itemId);
   const held=qty(row.reservedQty,'品項預留'),shortage=qty(row.shortageQty??0,'品項缺口'),progress=part;
   const ledgerSnap=await tx.get(ref('inventoryReservations',orderId+'__'+itemId));
   if(!ledgerSnap.exists)fault('缺少 v2 預留來源');
   const ledger=ledgerSnap.data();
   if(ledger.locationSchemaVersion!==2||ledger.warehouseId!==undefined
    ||ledger.orderId!==orderId||ledger.itemId!==itemId||ledger.productKey!==productKey
    ||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
    ||!Array.isArray(ledger.locations)||ledger.locations.length>20
    ||qty(ledger.quantity,'預留總量')!==held||qty(ledger.shortageQty,'預留缺口')!==shortage
    ||held+shortage!==progress.outstandingQty)
    fault('訂單與 v2 預留來源或數量不一致');
   let locationTotal=0;const seen=new Set();
   for(const loc of ledger.locations){
    const wh=id(loc?.warehouseId,'預留倉');
    if(seen.has(wh)||wh.startsWith('custody-')||qty(loc.reservedQty,'分倉預留')===0)
     fault('v2 倉位預留格式不正確');
    seen.add(wh);locationTotal=qty(locationTotal+loc.reservedQty,'預留總和');
   }
   if(locationTotal!==held||ledger.status!==(held?'active':shortage?'shortage':'fulfilled'))
    fault('v2 預留與倉位合計不一致');
   if(multi&&(!Array.isArray(ledger.lifecycleWarehouseIds)||ledger.lifecycleWarehouseIds.length!==2
    ||new Set(ledger.lifecycleWarehouseIds).size!==2||ledger.lifecycleWarehouseIds.some(wh=>id(wh,'原候選倉').startsWith('custody-'))
    ||ledger.locations.some(loc=>!ledger.lifecycleWarehouseIds.includes(loc.warehouseId))
    ||!ledger.lifecycleWarehouseIds.includes(row.warehouseId||order.warehouseId)))
    fault('整單品項預留不在原雙倉來源');
  }
  const state=fulfillment.warehouseShipmentState({warehouseShippedQty:shipped,
   reservedQty:held,dispatchPreparedQty:prepared});
  if(quantity>state.pending||prepared+quantity>ordered)
   fault('待打單數量不足，請重新確認');
  const updatedPrepared=prepared+quantity,now=new Date().toISOString();
  const nextState=fulfillment.warehouseShipmentState({warehouseShippedQty:shipped,
   reservedQty:held,dispatchPreparedQty:updatedPrepared});
  const result={orderId,itemId,qty:quantity,preparedQty:updatedPrepared,
   pendingDispatchQty:nextState.pending,shippableQty:nextState.shippable};
  const record={action:'location_dispatch_prepared',orderId,itemId,productKey,
   qty:quantity,actorUid:uid,actorRole,ownerUid:order.ownerUid,salesCode:order.salesCode,
   syncAttemptId,intentHash:intent.hash,createdAt:now,result};
  // This operation does NOT write inventory, lots, reservation, shipment or delivery.
  tx.create(recordRef,record);
  tx.update(orderRef,{items:order.items.map(row=>row.itemId===itemId?{...row,dispatchPreparedQty:updatedPrepared}:row),updatedAt:now});
  return {...result,status:'applied',recordId:recordRef.id};
 });
}
module.exports={normalizeLocationDispatchIntent,commitLocationDispatchPreparation};
