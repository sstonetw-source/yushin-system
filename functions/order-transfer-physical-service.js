'use strict';
const {createHash}=require('node:crypto');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const reservation=require('./shared/reservation-core'),logistics=require('./shared/warehouse-logistics');
const fulfillment=require('./shared/fulfillment-core'),inventory=require('./shared/inventory-core');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function id(v){if(typeof v!=='string'||!v||v!==v.trim()||v.includes('/')||v.length>96)fail('訂單調撥識別碼不正確','invalid-argument');return v;}
function orderTransferProject(action,env=process.env){
 const local=v=>typeof v==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(v);
 return ['DISPATCH','RECEIVE'].includes(action)&&projectIdFromEnvironment(env)==='demo-yushin'
  &&env['ENABLE_ORDER_TRANSFER_'+action+'_EMULATOR']==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}
function orderTransferIntent(action,data){
 const keys=action==='DISPATCH'?['id','orderId','itemId','fromWarehouseId','toWarehouseId','qty']:action==='RECEIVE'?['id','operationId']:[];
 if(!keys.length||!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).length!==keys.length||Object.keys(data).some(k=>!keys.includes(k)))fail('訂單調撥欄位不正確','invalid-argument');
 const intent={action};for(const key of keys){if(key==='qty'){if(typeof data.qty!=='number'||!Number.isFinite(data.qty)||data.qty<=0||data.qty>1000000)fail('調撥數量不正確','invalid-argument');intent.qty=data.qty;}else intent[key]=id(data[key]);}
 if(action==='RECEIVE'&&!/^[A-Za-z0-9_-]{12,96}$/.test(intent.operationId))fail('原收貨操作識別碼不正確','invalid-argument');
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitOrderTransferPhysical(db,uid,data,action,env=process.env){
 const project=orderTransferProject(action,env);if(!project||db.projectId!==project)fail('訂單調撥後端未在此環境啟用');
 const intent=orderTransferIntent(action,data);id(uid);
 return db.runTransaction(async tx=>{
  const ref=(n,k)=>db.collection(n).doc(k),actorSnap=await tx.get(ref('users',uid)),actor=actorSnap.exists?actorSnap.data():null;
  if(!actor||actor.active===false||actor.disabled===true||!['admin','purchaser','warehouse'].includes(actor.role))fail('目前角色不能處理訂單調撥','permission-denied');
  const transferRef=ref('stockTransfers',intent.id),transfer=await tx.get(transferRef),t=transfer.exists?transfer.data():null;
  const proofRef=ref('reservationOperationReceipts','order-transfer-dispatch-'+intent.id),proofSnap=await tx.get(proofRef),proof=proofSnap.exists?proofSnap.data():null;
  const receiveRef=action==='RECEIVE'?ref('reservationOperationReceipts','order-transfer-receipt-'+intent.operationId):null;
  const received=receiveRef?await tx.get(receiveRef):null;
  const result=status=>({status,action,id:intent.id,operationId:action==='DISPATCH'?intent.id:intent.operationId,actorUid:uid,actorRole:actor.role});
  if(t){
   if(!proof||proof.kind!=='ORDER_TRANSFER_DISPATCH'||!proof.transfer||proof.intentHash!==t.orderTransferIntentHash)fail('缺少可信任訂單調撥寄出憑證');
   for(const [key,value] of Object.entries(proof.transfer))if(key!=='status'&&JSON.stringify(t[key])!==JSON.stringify(value))fail('調撥已偏離原寄出憑證');
   if(action==='DISPATCH'){
    if(proof.intentHash!==intent.hash||proof.actorUid!==uid||proof.actorRole!==actor.role)fail('寄出操作識別碼衝突','already-exists');
    return result('already-applied');
   }
   if(t.status==='RECEIVED'){
    const saved=received?.exists?received.data():null;
    if(!saved||saved.kind!=='ORDER_TRANSFER_RECEIPT'||t.receivedByUid!==uid||t.receivedByRole!==actor.role||saved.intentHash!==intent.hash||saved.transferId!==intent.id||saved.actorUid!==uid||saved.actorRole!==actor.role
      ||t.receiptOperationId!==intent.operationId)fail('收貨操作識別碼衝突','already-exists');
    return result('already-applied');
   }
   if(t.status!=='IN_TRANSIT')fail('原調撥狀態不正確');
  }else if(action==='RECEIVE')fail('找不到原調撥','not-found');
  if(!t&&proof)fail('原寄出憑證已存在');if(received?.exists)fail('原收貨憑證已存在');
  const orderId=action==='DISPATCH'?intent.orderId:id(t.orderId),itemId=action==='DISPATCH'?intent.itemId:id(t.itemId);
  const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef),order=orderSnap.exists?orderSnap.data():null;
  if(!order||!['active','normal'].includes(order.status)||!['',undefined,'normal','active'].includes(order.orderStatus)
   ||order.inventoryReservationStatus!=='completed'||!order.ownerUid||!order.salesCode
   ||!Array.isArray(order.items)||!order.items.length||order.items.length>15
   ||new Set(order.items.map(row=>row?.itemId)).size!==order.items.length)fail('訂單來源不是可調撥狀態');
  if(['deliveryRecords','returnRecords','returnHistory','warehouseShipmentRecords'].some(k=>!Array.isArray(order[k]??[])||(order[k]??[]).length)
   ||(order.deliveredQty??0)!==0||(order.returnedQty??0)!==0||order.isDelivered===true)fail('本入口尚不接受已有履約紀錄的訂單');
  if(action==='RECEIVE'&&(t.ownerUid!==order.ownerUid||t.salesCode!==order.salesCode))fail('原調撥與目前訂單負責人不一致');
  const index=order.items.findIndex(row=>row.itemId===itemId),item=order.items[index];
  if(!item||item.custodyTransferId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
   ||String(item.productType||item.type||'').toUpperCase()==='SERVICE'||(item.warehouseShippedQty??0)!==0
   ||(item.deliveredQty??0)!==0||(item.returnedQty??0)!==0)fail('品項不是可調撥實貨');
  const key=id(item.inventoryProductKey||item.productId),from=action==='DISPATCH'?intent.fromWarehouseId:t.fromWarehouseId,to=action==='DISPATCH'?intent.toWarehouseId:t.toWarehouseId,qty=action==='DISPATCH'?intent.qty:t.qty;
  if(from===to||from.startsWith('custody-')||to.startsWith('custody-')||item.warehouseId!==from)fail('調撥來源位置不一致');
  const product=await tx.get(ref('products',id(item.productId)));
  if(!product.exists||product.data().active===false||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')fail('產品主檔不是有效實貨');
  const ledgerRef=ref('inventoryReservations',orderId+'__'+itemId),ledgerSnap=await tx.get(ledgerRef);
  if(!ledgerSnap.exists)fail('缺少原訂單預留');const ledger=ledgerSnap.data();
  if(ledger.status!=='active')fail('原訂單預留不是有效狀態');
  if(action==='RECEIVE'&&item.transferPendingId!==intent.id)fail('原調撥與訂單關聯不一致');
  const source=reservation.orderTransferReservationSource({reservation:ledger,item:action==='RECEIVE'?{...item,transferPendingId:''}:item,orderId,itemId,productKey:key,warehouseId:from,qty});
  if(source.schemaVersion!==1||ledger.ownerUid&&ledger.ownerUid!==order.ownerUid||ledger.salesCode&&ledger.salesCode!==order.salesCode)fail('本入口只接受相符的單倉預留');
  if(Number(item.qty??item.orderedQty)!==qty||Number(item.reservedQty)!==qty||qty>fulfillment.dispatchState(item).shippable)fail('品項須全數到貨預留並完成打單');
  const plan=logistics.plan(item.deliveryPlan||order.shippingInstructions||{});
  const whFrom=await tx.get(ref('warehouses',from)),whTo=await tx.get(ref('warehouses',to));
  for(const snap of [whFrom,whTo])if(!snap.exists||snap.data().active===false||snap.data().systemCustody||snap.data().warehouseType==='CUSTODY')fail('來源或目的倉不是啟用實體倉');
  if(action==='DISPATCH'){
   if(!['TRANSFER','PICKUP'].includes(plan.mode)||(plan.warehouseId||(plan.mode==='PICKUP'&&whTo.data().isDefault?to:''))!==to)fail('轉倉設定與目的倉不一致');
   if(plan.mode==='TRANSFER')logistics.validatePlan(plan,true);
  }
  const inventoryRef=ref('inventory',encodeURIComponent(key)),company=await tx.get(inventoryRef),stockId=w=>encodeURIComponent(w)+'__'+encodeURIComponent(key);
  const stockRef=ref('warehouseStocks',stockId(action==='DISPATCH'?from:to)),stock=await tx.get(stockRef);
  if(!company.exists||company.data().productKey!==key||(action==='DISPATCH'&&!stock.exists)
   ||stock.exists&&(stock.data().productKey!==key||stock.data().warehouseId!==(action==='DISPATCH'?from:to)))fail('公司或分倉庫存來源不一致');
  const outRef=ref('inventoryMovements',intent.id+'-out'),inRef=ref('inventoryMovements',intent.id+'-in');
  const outgoing=await tx.get(outRef),incoming=await tx.get(inRef);
  if(incoming.exists||action==='DISPATCH'&&outgoing.exists)fail('調撥異動識別碼已存在');
  if(!Array.isArray(order.logisticsHistory??[])||(order.logisticsHistory??[]).length>=1000)fail('物流歷史格式或長度不正確');
  const now=new Date().toISOString(),actorName=actor.displayName||actor.name||uid;
  const move=(type,value,warehouseId)=>({type,qty:value,warehouseId,productKey:key,fromWarehouseId:from,toWarehouseId:to,sourceType:'WAREHOUSE_TRANSFER',sourceId:intent.id,transferId:intent.id,orderId,itemId,actorUid:uid,createdAt:now,createdBy:actorName});
  let saved,nextItem;
  if(action==='DISPATCH'){
   if((order.logisticsTransfersPending??0)!==0)fail('訂單仍有其他調撥未完成');
   const physical=logistics.planTransferDispatch({aggregateStock:company.data(),warehouseStock:stock.data(),qty,reservedQty:qty});
   const lotsSnap=await tx.get(db.collection('inventoryLots').where('productKey','==',key).where('warehouseId','==',from).limit(101));
   if(lotsSnap.size>100)fail('訂單調撥批次超過100筆上限');
   const lots=lotsSnap.docs.map(doc=>({...doc.data(),id:doc.id}));
   if(lots.some(l=>typeof l.remainingQty!=='number'||!Number.isFinite(l.remainingQty)||l.remainingQty<0))fail('批次數量不正確');
   const allocated=inventory.allocateLots(lots,qty);
   const allocations=allocated.allocations.map((a,n)=>({...a,targetLotId:intent.id+'-'+n,costLotId:lots.find(l=>l.id===a.lotId).costLotId||a.lotId}));
   saved={id:intent.id,kind:'TRANSFER',status:'IN_TRANSIT',orderId,itemId,itemIndex:index,inventoryId:inventoryRef.id,productKey:key,productId:item.productId,
    fromWarehouseId:from,toWarehouseId:to,fromStockId:stockId(from),toStockId:stockId(to),qty,reservedQty:qty,allocations,
    ownerUid:order.ownerUid,salesCode:order.salesCode,itemCode:item.itemCode||'',itemName:item.itemName||'',deliveryPlan:plan,
    orderTransferIntentHash:intent.hash,createdByUid:uid,createdByRole:actor.role,createdAt:now};
   logistics.transferDestinationLots(saved,saved,now);
   tx.create(transferRef,saved);tx.create(proofRef,{kind:'ORDER_TRANSFER_DISPATCH',transfer:saved,intentHash:intent.hash,actorUid:uid,actorRole:actor.role});
   tx.update(inventoryRef,{...physical.aggregate,updatedAt:now});tx.update(stockRef,{...physical.source,updatedAt:now});
   for(const a of allocations){const lot=lots.find(l=>l.id===a.lotId);tx.update(ref('inventoryLots',a.lotId),{remainingQty:lot.remainingQty-a.qty,updatedAt:now});}
   tx.create(outRef,move('warehouse_transfer_out',-qty,from));nextItem={...item,transferPendingId:intent.id};
  }else{
   if(!outgoing.exists||outgoing.data().sourceId!==intent.id||outgoing.data().orderId!==orderId||outgoing.data().itemId!==itemId
    ||outgoing.data().type!=='warehouse_transfer_out'||outgoing.data().qty!==-qty||outgoing.data().productKey!==key||outgoing.data().warehouseId!==from)fail('缺少相符的原寄出異動');
   if((order.logisticsTransfersPending??0)!==1)fail('原調撥途中數量不一致');
   const rows=logistics.transferDestinationLots(t,t,now),physical=logistics.planTransferReceipt({aggregateStock:company.data(),warehouseStock:stock.exists?stock.data():{},qty,reservedQty:qty});
   for(const a of t.allocations){const origin=await tx.get(ref('inventoryLots',a.lotId));if(!origin.exists||origin.data().productKey!==key||origin.data().warehouseId!==from||(origin.data().costLotId||a.lotId)!==a.costLotId)fail('原調撥批次追溯不一致');}
   for(const row of rows){const lot=await tx.get(ref('inventoryLots',row.lotId)),cost=await tx.get(ref('inventoryLotCosts',row.lotId));if(lot.exists||cost.exists)fail('目的倉批次已存在');}
   tx.update(inventoryRef,{...physical.aggregate,updatedAt:now});tx.set(stockRef,{productKey:key,productId:item.productId,warehouseId:to,...physical.target,updatedAt:now},{merge:true});
   for(const row of rows){tx.create(ref('inventoryLots',row.lotId),row.lot);tx.create(ref('inventoryLotCosts',row.lotId),row.cost);}
   tx.create(inRef,move('warehouse_transfer_in',qty,to));tx.create(receiveRef,{kind:'ORDER_TRANSFER_RECEIPT',transferId:intent.id,intentHash:intent.hash,actorUid:uid,actorRole:actor.role});
   tx.update(transferRef,{status:'RECEIVED',receiptOperationId:intent.operationId,receivedByUid:uid,receivedByRole:actor.role,receivedAt:now});
   tx.update(ledgerRef,{warehouseId:to,updatedAt:now});nextItem={...item,warehouseId:to,transferPendingId:''};
  }
  tx.update(orderRef,{items:order.items.map((row,n)=>n===index?nextItem:row),logisticsTransfersPending:action==='DISPATCH'?1:0,
   logisticsHistory:[...(order.logisticsHistory??[]),{id:intent.id+(action==='DISPATCH'?'-out':'-received'),action:action==='DISPATCH'?'倉庫調撥寄出':'倉庫調撥收貨',itemId,by:actorName,at:now,detail:from+' → '+to+' × '+qty}],
   warehouseLogisticsId:intent.id,warehouseLogisticsEventId:intent.id+(action==='DISPATCH'?'-out':'-received'),updatedAt:now});
  return result('applied');
 });
}
module.exports={orderTransferProject,orderTransferIntent,commitOrderTransferPhysical};
function createOrderTransferPhysicalCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const wrap=action=>onCall({region:'asia-east1'},async request=>{
  if(!orderTransferProject(action,env))throw new HttpsError('failed-precondition','訂單調撥入口尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitOrderTransferPhysical(getDatabase(),request.auth.uid,request.data,action,env);}
  catch(error){if(['invalid-argument','failed-precondition','permission-denied','already-exists','not-found'].includes(error.code))throw new HttpsError(error.code,error.message);
   console.error('Order transfer physical transaction failed',error);throw new HttpsError('internal','訂單調撥結果未確認，請沿用原操作編號');}
 });
 return {dispatchOrderTransfer:wrap('DISPATCH'),receiveOrderTransfer:wrap('RECEIVE')};
}
module.exports.createOrderTransferPhysicalCallables=createOrderTransferPhysicalCallables;
