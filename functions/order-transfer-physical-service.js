'use strict';
const {createHash}=require('node:crypto');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const reservation=require('./shared/reservation-core'),logistics=require('./shared/warehouse-logistics');
const fulfillment=require('./shared/fulfillment-core'),inventory=require('./shared/inventory-core');
function fail(message,code='failed-precondition'){throw Object.assign(Error(message),{code});}
function id(v){if(typeof v!=='string'||!v||v!==v.trim()||v.includes('/')||v.length>96)fail('訂單調撥識別碼不正確','invalid-argument');return v;}
function orderTransferProject(action,env=process.env){
 const local=v=>typeof v==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(v);
 return ['DISPATCH','RECEIVE','HANDOFF'].includes(action)&&projectIdFromEnvironment(env)==='demo-yushin'
  &&env['ENABLE_ORDER_TRANSFER_'+action+'_EMULATOR']==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST)?'demo-yushin':'';
}
function orderTransferIntent(action,data){
 const keys=['DISPATCH','HANDOFF'].includes(action)?['id','orderId','itemId','fromWarehouseId','toWarehouseId','qty']:action==='RECEIVE'?['id','operationId']:[];
 if(!keys.length||!data||typeof data!=='object'||Array.isArray(data)||keys.some(k=>!Object.hasOwn(data,k))||Object.keys(data).some(k=>!keys.includes(k)&&!(['DISPATCH','HANDOFF'].includes(action)&&k==='expectedPlan')))fail('訂單調撥欄位不正確','invalid-argument');
 const intent={action};for(const key of keys){if(key==='qty'){if(typeof data.qty!=='number'||!Number.isFinite(data.qty)||data.qty<=0||data.qty>1000000)fail('調撥數量不正確','invalid-argument');intent.qty=data.qty;}else intent[key]=id(data[key]);}
 if(['DISPATCH','HANDOFF'].includes(action)&&data.expectedPlan!==undefined){
  if(!data.expectedPlan||typeof data.expectedPlan!=='object'||Array.isArray(data.expectedPlan))fail('原轉倉設定不正確','invalid-argument');
  const normalized=logistics.plan(data.expectedPlan);
  if(Object.keys(data.expectedPlan).sort().join(',')!==Object.keys(normalized).sort().join(',')||Object.entries(normalized).some(([key,value])=>data.expectedPlan[key]!==value))fail('原轉倉設定不是有效快照','invalid-argument');
  intent.expectedPlan=normalized;
 }
 if(action==='RECEIVE'&&!/^[A-Za-z0-9_-]{12,96}$/.test(intent.operationId))fail('原收貨操作識別碼不正確','invalid-argument');
 return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitOrderTransferPhysical(db,uid,data,action,env=process.env){
 const project=orderTransferProject(action,env);if(!project||db.projectId!==project)fail('訂單調撥後端未在此環境啟用');
 const intent=orderTransferIntent(action,data);id(uid);
 const handoff=action==='HANDOFF',dispatching=action!=='RECEIVE';
 return db.runTransaction(async tx=>{
  const ref=(n,k)=>db.collection(n).doc(k),actorSnap=await tx.get(ref('users',uid)),actor=actorSnap.exists?actorSnap.data():null;
  if(!actor||actor.active===false||actor.disabled===true||!['admin','purchaser','warehouse'].includes(actor.role))fail('目前角色不能處理訂單調撥','permission-denied');
  const transferRef=ref('stockTransfers',intent.id),transfer=await tx.get(transferRef),t=transfer.exists?transfer.data():null;
  const proofRef=ref('reservationOperationReceipts','order-transfer-dispatch-'+intent.id),proofSnap=await tx.get(proofRef),proof=proofSnap.exists?proofSnap.data():null;
  const receiveRef=action==='RECEIVE'?ref('reservationOperationReceipts','order-transfer-receipt-'+intent.operationId):null;
  const received=receiveRef?await tx.get(receiveRef):null;
  const result=status=>({status,action,id:intent.id,operationId:dispatching?intent.id:intent.operationId,actorUid:uid,actorRole:actor.role});
  if(t){
   if(action==='RECEIVE'&&t.kind==='HANDOFF')fail('業務交接不是待收貨調撥');
   if(!proof||proof.kind!=='ORDER_TRANSFER_DISPATCH'||!proof.transfer||proof.intentHash!==t.orderTransferIntentHash)fail('缺少可信任訂單調撥寄出憑證');
   for(const [key,value] of Object.entries(proof.transfer))if(key!=='status'&&JSON.stringify(t[key])!==JSON.stringify(value))fail('調撥已偏離原寄出憑證');
   if(dispatching){
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
  const orderId=dispatching?intent.orderId:id(t.orderId),itemId=dispatching?intent.itemId:id(t.itemId);
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
  const key=id(item.inventoryProductKey||item.productId),from=dispatching?intent.fromWarehouseId:t.fromWarehouseId,to=dispatching?intent.toWarehouseId:t.toWarehouseId,qty=dispatching?intent.qty:t.qty;
  if(from===to||from.startsWith('custody-')||(!handoff&&to.startsWith('custody-')))fail('調撥來源位置不一致');
  const product=await tx.get(ref('products',id(item.productId)));
  if(!product.exists||product.data().active===false||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')fail('產品主檔不是有效實貨');
  const ledgerRef=ref('inventoryReservations',orderId+'__'+itemId),ledgerSnap=await tx.get(ledgerRef);
  if(!ledgerSnap.exists)fail('缺少原訂單預留');const ledger=ledgerSnap.data();
  if(ledger.status!=='active')fail('原訂單預留不是有效狀態');
  if(action==='RECEIVE'&&item.transferPendingId!==intent.id)fail('原調撥與訂單關聯不一致');
  const sourceItem=action==='RECEIVE'?{...item,transferPendingId:''}:item;
  const custodyV3=ledger.locationSchemaVersion===2&&handoff
   ?reservation.planCustodyHandoffLedger({reservation:ledger,item:sourceItem,orderId,itemId,
     productKey:key,qty,ownerUid:order.ownerUid,transferId:intent.id}):null;
  const target=custodyV3?.plan||(ledger.locationSchemaVersion===2&&!handoff
   ?reservation.planOrderTransferTarget({reservation:ledger,item:sourceItem,orderId,itemId,productKey:key,qty,toWarehouseId:to,action:'DISPATCH'})
   :null);
  const source=target?{schemaVersion:target.schemaVersion,warehouseId:target.moveLegs[0]?.warehouseId,qty}
   :reservation.orderTransferReservationSource({reservation:ledger,item:sourceItem,orderId,itemId,productKey:key,warehouseId:from,qty});
  const movingQty=target?target.movingQty:qty;
  if(!target&&item.warehouseId!==from)fail('單倉調撥來源位置不一致');
  if(target&&((!handoff&&target.moveLegs.length!==1)||target.moveLegs[0].warehouseId!==from
    ||(action==='RECEIVE'&&(t.movingQty!==movingQty||t.keptQty!==target.keptQty))))
    fail('多倉調撥實際來源或原寄出數量不一致');
  if(ledger.ownerUid&&ledger.ownerUid!==order.ownerUid||ledger.salesCode&&ledger.salesCode!==order.salesCode)fail('原預留與訂單負責人不一致');
  if(handoff&&source.schemaVersion!==1&&!custodyV3)fail('業務交接預留版本尚未支援');
  if(source.schemaVersion===2){
   if(env.ENABLE_ORDER_TRANSFER_V2_EMULATOR!=='true')fail('v2訂單調撥尚未獨立啟用');
   if(ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
    ||!Array.isArray(ledger.lifecycleWarehouseIds)||ledger.lifecycleWarehouseIds.length!==2
    ||new Set(ledger.lifecycleWarehouseIds).size!==2
    ||!ledger.lifecycleWarehouseIds.includes(from)||(!handoff&&!ledger.lifecycleWarehouseIds.includes(to)))
    fail('調撥來源不在原v2候選倉，或目的實體倉是第三倉');
   if(action==='RECEIVE'&&(t.reservationLocationSchemaVersion!==2
    ||JSON.stringify(t.lifecycleWarehouseIds)!==JSON.stringify(ledger.lifecycleWarehouseIds)))fail('原多倉預留版本或候選位置已變更');
  }else if(action==='RECEIVE'&&t.reservationLocationSchemaVersion===2)fail('原多倉預留不可退回單倉格式');
  if(Number(item.qty??item.orderedQty)!==qty||Number(item.reservedQty)!==qty||qty>fulfillment.dispatchState(item).shippable)fail('品項須全數到貨預留並完成打單');
  const plan=logistics.plan(item.deliveryPlan||order.shippingInstructions||{});
  const whFrom=await tx.get(ref('warehouses',from)),whTo=await tx.get(ref('warehouses',to));
  if(!whFrom.exists||whFrom.data().active===false||whFrom.data().systemCustody||whFrom.data().warehouseType==='CUSTODY')fail('來源不是啟用實體倉');
  if(handoff){
   if(to!=='custody-'+order.ownerUid)fail('只能交付目前負責業務');
   if(whTo.exists&&(whTo.data().active===false||whTo.data().systemCustody!==true||whTo.data().ownerUid!==order.ownerUid))fail('業務保管位置不一致');
  }else if(!whTo.exists||whTo.data().active===false||whTo.data().systemCustody||whTo.data().warehouseType==='CUSTODY')fail('目的不是啟用實體倉');
  if(dispatching){
   if(intent.expectedPlan&&JSON.stringify(intent.expectedPlan)!==JSON.stringify(plan))fail('原轉倉設定已變更');
   if(handoff){
    if(!['PICKUP','SALES_SHIP'].includes(plan.mode)||plan.mode==='PICKUP'&&whFrom.data().isDefault!==true)fail('交接方式或主倉位置不一致');
    if(plan.mode==='SALES_SHIP')logistics.validatePlan(plan,true);
   }else if(!['TRANSFER','PICKUP'].includes(plan.mode)||(plan.warehouseId||(plan.mode==='PICKUP'&&whTo.data().isDefault?to:''))!==to)fail('轉倉設定與目的倉不一致');
   if(!handoff&&plan.mode==='TRANSFER')logistics.validatePlan(plan,true);
  }
  const inventoryRef=ref('inventory',encodeURIComponent(key)),company=await tx.get(inventoryRef),stockId=w=>encodeURIComponent(w)+'__'+encodeURIComponent(key);
  const stockRef=ref('warehouseStocks',stockId(dispatching?from:to)),stock=await tx.get(stockRef);
  if(!company.exists||company.data().productKey!==key||(dispatching&&!stock.exists)
   ||stock.exists&&(stock.data().productKey!==key||stock.data().warehouseId!==(dispatching?from:to)))fail('公司或分倉庫存來源不一致');
  const keptStock=target?.keptQty>0?(dispatching?await tx.get(ref('warehouseStocks',stockId(to))):stock):null;
  if(target&&(company.data().reserved<qty||company.data().onHand<qty
    ||(target.keptQty>0&&(!keptStock?.exists||keptStock.data().productKey!==key
      ||keptStock.data().warehouseId!==to||!Number.isFinite(keptStock.data().onHand)
      ||!Number.isFinite(keptStock.data().reserved)||keptStock.data().onHand<target.keptQty
      ||keptStock.data().reserved<target.keptQty))))fail('原多倉預留與目的倉保留數量不一致');
  const custodyRef=handoff?ref('warehouseStocks',stockId(to)):null,custody=handoff?await tx.get(custodyRef):null;
  if(custody?.exists&&(custody.data().productKey!==key||custody.data().warehouseId!==to))fail('業務保管庫存來源不一致');
  const moveLegs=target?.moveLegs||[{warehouseId:from,qty:movingQty}];
  const sourceStocks=new Map([[from,stock]]);
  if(custodyV3)for(const leg of moveLegs.slice(1)){
   const master=await tx.get(ref('warehouses',leg.warehouseId));
   if(!master.exists||master.data().active===false||master.data().systemCustody
     ||master.data().warehouseType==='CUSTODY')fail('原多倉預留含停用或非實體倉');
   const extra=await tx.get(ref('warehouseStocks',stockId(leg.warehouseId)));
   if(!extra.exists||extra.data().productKey!==key||extra.data().warehouseId!==leg.warehouseId)
     fail('原多倉來源庫存不存在或產品不一致');
   sourceStocks.set(leg.warehouseId,extra);
  }
  const outRef=ref('inventoryMovements',intent.id+'-out'),inRef=ref('inventoryMovements',intent.id+'-in');
  const outgoing=await tx.get(outRef),incoming=await tx.get(inRef);
  if(incoming.exists||dispatching&&outgoing.exists)fail('調撥異動識別碼已存在');
  const extraOutRefs=custodyV3?moveLegs.slice(1).map((_,index)=>ref('inventoryMovements',intent.id+'-out-'+(index+1))):[];
  for(const row of extraOutRefs)if((await tx.get(row)).exists)fail('多倉交接異動識別碼已存在');
  if(!Array.isArray(order.logisticsHistory??[])||(order.logisticsHistory??[]).length>=1000)fail('物流歷史格式或長度不正確');
  const now=new Date().toISOString(),actorName=actor.displayName||actor.name||uid;
  const move=(type,value,warehouseId,origin=from)=>({type,qty:value,warehouseId,productKey:key,fromWarehouseId:origin,toWarehouseId:to,sourceType:'WAREHOUSE_TRANSFER',sourceId:intent.id,transferId:intent.id,orderId,itemId,actorUid:uid,createdAt:now,createdBy:actorName});
  let saved,nextItem;
  if(dispatching){
   if((order.logisticsTransfersPending??0)!==0)fail('訂單仍有其他調撥未完成');
   const sourceProjections=new Map(),allLots=new Map();let allocations=[],physical;
   if(custodyV3){
    let aggregate={...company.data()},destination=custody.exists?{...custody.data()}:{};
    for(const leg of moveLegs){
     const sourceStock=sourceStocks.get(leg.warehouseId);
     const projected=logistics.planTransferHandoff({aggregateStock:aggregate,
       warehouseStock:sourceStock.data(),targetStock:destination,qty:leg.qty});
     aggregate={...aggregate,...projected.aggregate};destination={...destination,...projected.target};
     sourceProjections.set(leg.warehouseId,projected.source);
     const batch=await tx.get(db.collection('inventoryLots').where('productKey','==',key)
       .where('warehouseId','==',leg.warehouseId).limit(101));
     if(batch.size>100)fail('單一來源倉調撥批次超過100筆上限');
     const lots=batch.docs.map(doc=>({...doc.data(),id:doc.id}));
     if(lots.some(l=>typeof l.remainingQty!=='number'||!Number.isFinite(l.remainingQty)||l.remainingQty<0
       ||l.productKey!==key||l.warehouseId!==leg.warehouseId))fail('來源倉批次不一致');
     const allocated=inventory.allocateLots(lots,leg.qty);
     for(const lot of lots)allLots.set(lot.id,lot);
     for(const row of allocated.allocations){
      const original=allLots.get(row.lotId);
      allocations.push({...row,sourceWarehouseId:leg.warehouseId,targetLotId:intent.id+'-'+allocations.length,
       costLotId:original.costLotId||row.lotId});
     }
    }
    physical={aggregate,target:destination};
   }else{
    physical=handoff?logistics.planTransferHandoff({aggregateStock:company.data(),warehouseStock:stock.data(),targetStock:custody.exists?custody.data():{},qty})
     :logistics.planTransferDispatch({aggregateStock:company.data(),warehouseStock:stock.data(),qty:movingQty,reservedQty:movingQty});
    const batch=await tx.get(db.collection('inventoryLots').where('productKey','==',key).where('warehouseId','==',from).limit(101));
    if(batch.size>100)fail('訂單調撥批次超過100筆上限');
    const lots=batch.docs.map(doc=>({...doc.data(),id:doc.id}));
    if(lots.some(l=>typeof l.remainingQty!=='number'||!Number.isFinite(l.remainingQty)||l.remainingQty<0))fail('批次數量不正確');
    const allocated=inventory.allocateLots(lots,movingQty);
    for(const lot of lots)allLots.set(lot.id,lot);
    allocations=allocated.allocations.map((a,n)=>({...a,targetLotId:intent.id+'-'+n,
     costLotId:allLots.get(a.lotId).costLotId||a.lotId}));
   }
   saved={id:intent.id,kind:handoff?'HANDOFF':'TRANSFER',status:handoff?'RECEIVED':'IN_TRANSIT',orderId,itemId,itemIndex:index,inventoryId:inventoryRef.id,productKey:key,productId:item.productId,
    fromWarehouseId:from,toWarehouseId:to,fromStockId:stockId(from),toStockId:stockId(to),qty,reservedQty:movingQty,allocations,
    ownerUid:order.ownerUid,salesCode:order.salesCode,itemCode:item.itemCode||'',itemName:item.itemName||'',deliveryPlan:plan,
    ...(source.schemaVersion===2?{reservationLocationSchemaVersion:2,lifecycleWarehouseIds:[...ledger.lifecycleWarehouseIds],
      movingQty,keptQty:target.keptQty,sourceLocations:target.sourceLocations.map(row=>({...row})),
      ...(custodyV3?{custodyLocationSchemaVersion:3}:{} )}:{}),
    orderTransferIntentHash:intent.hash,createdByUid:uid,createdByRole:actor.role,createdAt:now,...(handoff?{receivedByUid:uid,receivedByRole:actor.role,receivedAt:now}:{})};
   const destinationRows=logistics.transferDestinationLots({...saved,qty:movingQty},saved,now);
   if(handoff)for(const row of destinationRows){const lot=await tx.get(ref('inventoryLots',row.lotId)),cost=await tx.get(ref('inventoryLotCosts',row.lotId));if(lot.exists||cost.exists)fail('交接目的批次已存在');}

   tx.create(transferRef,saved);tx.create(proofRef,{kind:'ORDER_TRANSFER_DISPATCH',transfer:saved,intentHash:intent.hash,actorUid:uid,actorRole:actor.role});
   tx.update(inventoryRef,{...physical.aggregate,updatedAt:now});
   if(custodyV3)for(const leg of moveLegs)tx.update(ref('warehouseStocks',stockId(leg.warehouseId)),
     {...sourceProjections.get(leg.warehouseId),updatedAt:now});
   else tx.update(stockRef,{...physical.source,updatedAt:now});
   for(const a of allocations){const lot=allLots.get(a.lotId);tx.update(ref('inventoryLots',a.lotId),{remainingQty:lot.remainingQty-a.qty,updatedAt:now});}
   if(custodyV3)for(const [index,leg] of moveLegs.entries())tx.create(index?extraOutRefs[index-1]:outRef,
     move('warehouse_transfer_out',-leg.qty,leg.warehouseId,leg.warehouseId));
   else tx.create(outRef,move('warehouse_transfer_out',-movingQty,from));
   nextItem=handoff?{...item,warehouseId:to,custodyTransferId:intent.id}:{...item,transferPendingId:intent.id};
   if(handoff){
    if(!whTo.exists)tx.create(ref('warehouses',to),{active:true,isDefault:false,warehouseType:'CUSTODY',systemCustody:true,ownerUid:order.ownerUid,warehouseName:'負責業務保管',sourceTransferId:intent.id});
    tx.set(custodyRef,{productKey:key,productId:item.productId,warehouseId:to,...physical.target,updatedAt:now},{merge:true});
    for(const row of destinationRows){tx.create(ref('inventoryLots',row.lotId),row.lot);tx.create(ref('inventoryLotCosts',row.lotId),row.cost);}
    tx.create(inRef,move('warehouse_transfer_in',qty,to));
    if(custodyV3)tx.update(ledgerRef,{locationSchemaVersion:3,locations:custodyV3.reservation.locations,
      sourceLocationSnapshot:custodyV3.reservation.sourceLocationSnapshot,
      custodyOriginalQty:qty,custodyTransferId:intent.id,updatedAt:now});
    else tx.update(ledgerRef,{warehouseId:to,updatedAt:now});
   }
  }else{
   if(!outgoing.exists||outgoing.data().sourceId!==intent.id||outgoing.data().orderId!==orderId||outgoing.data().itemId!==itemId
    ||outgoing.data().type!=='warehouse_transfer_out'||outgoing.data().qty!==-movingQty||outgoing.data().productKey!==key||outgoing.data().warehouseId!==from)fail('缺少相符的原寄出異動');
   if((order.logisticsTransfersPending??0)!==1)fail('原調撥途中數量不一致');
   const rows=logistics.transferDestinationLots({...t,qty:movingQty},t,now),physical=logistics.planTransferReceipt({aggregateStock:company.data(),warehouseStock:stock.exists?stock.data():{},qty:movingQty,reservedQty:movingQty});
   for(const a of t.allocations){const origin=await tx.get(ref('inventoryLots',a.lotId));if(!origin.exists||origin.data().productKey!==key||origin.data().warehouseId!==from||(origin.data().costLotId||a.lotId)!==a.costLotId)fail('原調撥批次追溯不一致');}
   for(const row of rows){const lot=await tx.get(ref('inventoryLots',row.lotId)),cost=await tx.get(ref('inventoryLotCosts',row.lotId));if(lot.exists||cost.exists)fail('目的倉批次已存在');}
   tx.update(inventoryRef,{...physical.aggregate,updatedAt:now});tx.set(stockRef,{productKey:key,productId:item.productId,warehouseId:to,...physical.target,updatedAt:now},{merge:true});
   for(const row of rows){tx.create(ref('inventoryLots',row.lotId),row.lot);tx.create(ref('inventoryLotCosts',row.lotId),row.cost);}
   tx.create(inRef,move('warehouse_transfer_in',movingQty,to));tx.create(receiveRef,{kind:'ORDER_TRANSFER_RECEIPT',transferId:intent.id,intentHash:intent.hash,actorUid:uid,actorRole:actor.role});
   tx.update(transferRef,{status:'RECEIVED',receiptOperationId:intent.operationId,receivedByUid:uid,receivedByRole:actor.role,receivedAt:now});
   tx.update(ledgerRef,source.schemaVersion===2?{locations:[{warehouseId:to,reservedQty:qty}],updatedAt:now}:{warehouseId:to,updatedAt:now});nextItem={...item,warehouseId:to,transferPendingId:''};
  }
  tx.update(orderRef,{items:order.items.map((row,n)=>n===index?nextItem:row),logisticsTransfersPending:dispatching&&!handoff?1:0,
   logisticsHistory:[...(order.logisticsHistory??[]),{id:intent.id+(dispatching?'-out':'-received'),action:handoff?'倉庫交付業務':dispatching?'倉庫調撥寄出':'倉庫調撥收貨',itemId,by:actorName,at:now,detail:from+' → '+to+' × '+qty}],
   warehouseLogisticsId:intent.id,warehouseLogisticsEventId:intent.id+(dispatching?'-out':'-received'),updatedAt:now});
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
 return {dispatchOrderTransfer:wrap('DISPATCH'),receiveOrderTransfer:wrap('RECEIVE'),handoffOrderTransfer:wrap('HANDOFF')};
}
module.exports.createOrderTransferPhysicalCallables=createOrderTransferPhysicalCallables;
