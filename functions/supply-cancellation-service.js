'use strict';
// Supplier cancellation releases unreceived commitments, not customer orders.
// A whole PO is deliberately ONE Firestore transaction (max five supplies),
// so a partial failure leaves no line cancelled and requires no recovery writer.
const {createHash}=require('node:crypto');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {allowProductionTransaction}=require('./production-transaction-gate');
const demandCore=require('./shared/procurement-demand-core');
const {sanitizeSupply}=require('./shared/stock-permissions');
const {initialOrderWorkIndex}=require('./order-reservation-service');

function fail(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function id(value,label){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
  fail(label+'識別碼不正確','invalid-argument');
 return value;
}
function qty(value,label){if(!Number.isSafeInteger(value)||value<0||value>1e9)fail(label+'數量不正確');return value;}
function suppliedQty(value,label){return qty(value===undefined?0:value,label);}
function reason(value){
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>500||/[\x00-\x1f]/.test(value))
  fail('請提供有效的供應商取消原因','invalid-argument');
 return value;
}
function supplyCancellationProject(env=process.env){
 const p=projectIdFromEnvironment(env);
 const ids=[env.GCLOUD_PROJECT,env.GCP_PROJECT,env.GOOGLE_CLOUD_PROJECT].filter(Boolean);
 if(ids.some(x=>x!==p))return '';
 const local=v=>typeof v==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(v);
 if(p==='yu-shing-company'&&allowProductionTransaction('SUPPLY_CANCELLATION',env))return p;
 if(p==='demo-yushin'&&env.ENABLE_SUPPLY_CANCELLATION_EMULATOR==='true'
  &&env.FUNCTIONS_EMULATOR==='true'&&local(env.FIRESTORE_EMULATOR_HOST)
  &&local(env.FIREBASE_AUTH_EMULATOR_HOST))return p;
 return '';
}
function cancellationIntent(data,whole){
 const expected=whole?'operationId,poId,reason':'operationId,poId,reason,supplyId';
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).sort().join(',')!==expected)
  fail('供應商取消請求欄位不正確','invalid-argument');
 const intent={poId:id(data.poId,'採購單'),operationId:id(data.operationId,'操作'),reason:reason(data.reason)};
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId))fail('操作識別碼格式不正確','invalid-argument');
 if(!whole)intent.supplyId=id(data.supplyId,'供應');
 return intent;
}
const terminal=s=>s==='CANCELLED'||s==='CLOSED';
function stockRef(db,collection,warehouseId,key){
 return db.collection(collection).doc(collection==='inventory'?encodeURIComponent(key):
  encodeURIComponent(warehouseId)+'__'+encodeURIComponent(key));
}
function result(status,intent,role,uid,supplyIds,cancelledQty,receivedQty,affectedOrderIds){
 return {status,operationId:intent.operationId,poId:intent.poId,
  actorUid:uid,actorRole:role,supplyIds,cancelledQty,receivedQty,affectedOrderIds};
}

async function commitSupplyCancellation(db,uid,data,{whole=false,env=process.env}={}){
 const project=supplyCancellationProject(env),intent=cancellationIntent(data,whole);
 if(!project||db.projectId!==project||(db.databaseId&&db.databaseId!=='(default)'))
  fail('供應商取消後端尚未在此專案授權啟用');
 uid=id(uid,'使用者');
 const hash=createHash('sha256').update(JSON.stringify({whole,...intent})).digest('hex');
 return db.runTransaction(async tx=>{
  const ref=(collection,key)=>db.collection(collection).doc(key);
  const cache=new Map();
  const get=async(reference)=>{
   if(!cache.has(reference.path))cache.set(reference.path,await tx.get(reference));
   return cache.get(reference.path);
  };
  const userSnap=await get(ref('users',uid)),user=userSnap.exists?userSnap.data():null;
  if(!user||user.active===false||user.disabled===true||!['admin','purchaser'].includes(user.role))
   fail('沒有取消供應商未到貨的權限','permission-denied');
  const role=user.role,actorName=String(user.name||uid);
  const opRef=ref('purchaseOperations','supply-cancel-'+intent.operationId),prior=await get(opRef);
  const poRef=ref('purchaseOrders',intent.poId),poSnap=await get(poRef),po=poSnap.exists?poSnap.data():null;
  if(whole&&(!po||po.poNo!==intent.poId||po.documentOnly!==false
   ||!Array.isArray(po.items)||!Array.isArray(po.supplyOrderIds)||!po.supplyOrderIds.length
   ||po.supplyOrderIds.length!==po.items.length||po.supplyOrderIds.length>5
   ||new Set(po.supplyOrderIds).size!==po.supplyOrderIds.length))
   fail('採購單沒有完整且唯一的供應連結');
  const supplyIds=whole?[...po.supplyOrderIds]:[intent.supplyId];
  if(supplyIds.some(x=>typeof x!=='string'||!x||x.includes('/')))fail('採購供應連結格式不正確');
  if(prior.exists){
   const receipt=prior.data();
   if(receipt.hash!==hash||receipt.actorUid!==uid||receipt.actorRole!==role
    ||JSON.stringify(receipt.supplyIds)!==JSON.stringify(supplyIds)
    ||!Array.isArray(receipt.changedIds)||!Array.isArray(receipt.movementIds)
    ||!Number.isSafeInteger(receipt.cancelledQty)||!Number.isSafeInteger(receipt.receivedQty))
    fail('原操作 ID 已用於不同採購取消','already-exists');
   for(const supplyId of supplyIds){
    const snap=await get(ref('supplyOrders',supplyId));
    if(!snap.exists)fail('已取消的供應來源不存在');
    const original=snap.data(),changed=receipt.changedIds?.includes(supplyId);
    if(changed
     &&(!terminal(original.status)||original.incomingRegisteredQty!==0
       ||original.cancellationOperationId!==intent.operationId))
     fail('原供應取消憑證與現況不一致');
    if(changed&&original.fulfillmentType==='WAREHOUSE'){
     const position=supplyIds.indexOf(supplyId);
     const movementId='supply-cancel-'+intent.operationId+'-'+position;
     if(receipt.movementIds.includes(movementId)){
      const movement=await get(ref('inventoryMovements',movementId));
      const witness=movement.exists?movement.data():null;
      if(!witness||witness.sourceId!==supplyId||witness.operationId!==intent.operationId
       ||witness.actorUid!==uid||witness.purchaseDocumentId!==intent.poId
       ||witness.reason!==intent.reason||witness.qty>=0)
       fail('原供應取消缺少一致的在途異動憑證');
     }
    }
   }
   if(whole&&receipt.cancelledQty>0&&(!terminal(po?.status)||po.cancellationOperationId!==intent.operationId))
    fail('整張採購單取消憑證與狀態不一致');
   return result('already-applied',intent,role,uid,supplyIds,receipt.cancelledQty,receipt.receivedQty,receipt.affectedOrderIds);
  }
  if(whole&&!['ORDERED','PARTIAL_RECEIPT'].includes(po.status))
   fail('採購單已由其他操作結案或狀態不正確');
  const now=new Date().toISOString(),supplyPatches=[],movementRows=[],changedIds=[],affectedOrderIds=new Set();
  const orderPatches=new Map(),sourceOrders=new Map(),demandPatches=new Map(),stockDeltas=new Map();
  let cancelledQty=0,receivedQty=0;
  for(let index=0;index<supplyIds.length;index++){
   const supplyId=supplyIds[index],supplyRef=ref('supplyOrders',supplyId);
   const supplySnap=await get(supplyRef);
   if(!supplySnap.exists)fail('找不到採購來源 '+supplyId,'not-found');
   const supply=supplySnap.data();
   if(!['PURCHASING_PO','PURCHASING_MANUAL'].includes(supply.type)
    ||(supply.purchaseDocumentId||supply.internalNo||supplyId)!==intent.poId
    ||(whole&&supply.type!=='PURCHASING_PO')
    ||(supply.type==='PURCHASING_PO'&&(!po||!Array.isArray(po.supplyOrderIds)
      ||!po.supplyOrderIds.includes(supplyId))))
    fail('供應來源與採購單連結不一致');
   if(supply.type==='PURCHASING_PO'){
    const parentIndex=po.supplyOrderIds.indexOf(supplyId),line=po.items?.[parentIndex];
    if(po.poNo!==intent.poId||po.documentOnly!==false||!line
     ||line.productId!==supply.productId
     ||(line.orderId||'')!==(supply.orderId||'')
     ||(line.itemId||'')!==(supply.itemId||'')
     ||line.qty!==supply.qty||line.unitPrice!==supply.unitCost)
     fail('採購單品項與供應來源不一致');
   }
   if(terminal(supply.status))fail('供應來源已有其他終止操作','already-exists');
   if(!['ORDERED','PARTIAL_RECEIPT','RECEIVED'].includes(supply.status))
    fail('供應來源狀態不支援取消');
   const ordered=qty(supply.qty,'原採購'),received=suppliedQty(supply.receivedQty,'原收貨');
   if(ordered===0)fail('來源採購數量不得為零');
   const registered=suppliedQty(supply.incomingRegisteredQty,'原在途');
   if(received>ordered||registered>ordered-received)fail('原到貨或在途量超過採購');
   const remaining=ordered-received,directShip=supply.fulfillmentType==='DIRECT_SHIP';
   if((supply.status==='RECEIVED'&&remaining>0)
    ||(supply.status==='ORDERED'&&received>0)
    ||(supply.status==='PARTIAL_RECEIPT'&&(received===0||remaining===0)))
    fail('供應狀態與實際收貨數量不一致');
   if(!directShip&&supply.fulfillmentType!=='WAREHOUSE')fail('來源履約方式不正確');
   if(directShip&&registered)fail('直送來源不應有倉庫在途量');
   const key=id(supply.productKey||supply.productId,'產品');
   const warehouseId=directShip?'':id(supply.warehouseId,'倉庫');
   receivedQty+=received;
   if(!Number.isSafeInteger(receivedQty))fail('累計到貨數量超出上限');
   if(!remaining)continue; // A fully received row needs no reversal.
   const nextStatus=received>0?'CLOSED':'CANCELLED';
   const patch={status:nextStatus,incomingRegisteredQty:0,cancellationOperationId:intent.operationId,
    ...(nextStatus==='CLOSED'
      ?{closedQty:remaining,closeReason:intent.reason,closedAt:now,closedByUid:uid,closedBy:actorName}
      :{cancelledQty:remaining,cancelReason:intent.reason,cancelledAt:now,cancelledByUid:uid,cancelledBy:actorName}),
    updatedAt:now};
   supplyPatches.push({ref:supplyRef,mirror:ref('receivingSupplyOrders',supplyId),before:supply,patch});
   changedIds.push(supplyId);cancelledQty+=remaining;
   if(!Number.isSafeInteger(cancelledQty))fail('累計取消數量超出上限');
   if(supply.orderId){
    const orderId=id(supply.orderId,'來源訂單'),orderRef=ref('orders',orderId);
    const source=await get(orderRef);
    if(!source.exists)fail('取消供應缺少來源訂單');
    if(!sourceOrders.has(orderId))sourceOrders.set(orderId,source.data());
    const sourceOrder=orderPatches.get(orderId)||source.data();
    const items=Array.isArray(sourceOrder.items)?sourceOrder.items.map(x=>({...x})):null;
    if(!items)fail('來源訂單缺少品項');
    const matches=items.filter(x=>x.itemId===supply.itemId);
    if(matches.length!==1||matches[0].productId!==supply.productId
     ||String(matches[0].inventoryProductKey||matches[0].productId)!==key
     ||String(sourceOrder.ownerUid||'')!==String(supply.ownerUid||'')
     ||String(sourceOrder.salesCode||'')!==String(supply.salesCode||''))
     fail('來源訂單品項或產品不一致');
    const i=items.findIndex(x=>x.itemId===supply.itemId),item=items[i];
    const before=suppliedQty(item.supplyOrderedQty,'訂單採購承諾');
    const itemReceived=suppliedQty(item.receivedQty,'訂單到貨');
    if(itemReceived<received||before<remaining||before-remaining<itemReceived)
     fail('來源訂單供應或到貨承諾不一致');
    items[i]={...item,supplyOrderedQty:before-remaining};
    orderPatches.set(orderId,{...sourceOrder,items});
    affectedOrderIds.add(orderId);
   }
   if(!supply.demandId)fail('供應來源缺少權威採購需求');
   if(supply.demandId){
    const demandId=id(supply.demandId,'採購需求'),demandRef=ref('procurementDemands',encodeURIComponent(demandId));
    const demandSnap=await get(demandRef);
    if(!demandSnap.exists)fail('取消供應缺少採購需求');
    const before=demandPatches.get(demandId)||demandSnap.data();
    if(before.demandId!==demandId||before.productKey!==key
     ||before.productId!==supply.productId
     ||before.warehouseId!==supply.warehouseId
     ||(supply.orderId&&(before.sourceType!=='SALES_ORDER'
      ||before.sourceId!==supply.orderId||before.sourceItemId!==supply.itemId
      ||String(before.ownerUid||'')!==String(supply.ownerUid||'')
      ||String(before.salesCode||'')!==String(supply.salesCode||'')))
     ||(!supply.orderId&&before.sourceType!=='STOCK_REPLENISHMENT'))
     fail('採購需求來源或產品不一致');
    const next=demandCore.applySupplyCancellation(before,supply);
    if(next.releasedQty!==remaining||before.orderedQty<remaining+before.receivedQty)
     fail('採購需求承諾不足');
    demandPatches.set(demandId,next.demand);
   }
   if(!directShip&&registered){
    const invRef=stockRef(db,'inventory','',key),whRef=stockRef(db,'warehouseStocks',warehouseId,key);
    for(const stockRef of [invRef,whRef]){
     const stockSnap=await get(stockRef);
     if(!stockSnap.exists)fail('取消供應缺少公司或分倉在途庫存');
     const stock=stockSnap.data(),isWarehouse=stockRef.path.startsWith('warehouseStocks/');
     if(stock.productKey!==key
      ||(stock.productId!==undefined&&stock.productId!==supply.productId)
      ||(isWarehouse&&stock.warehouseId!==warehouseId)
      ||['onHand','reserved'].some(field=>!Number.isSafeInteger(stock[field])||stock[field]<0))
      fail('公司或分倉庫存識別不一致');
     const entry=stockDeltas.get(stockRef.path)||{ref:stockRef,before:stock,delta:0};
     entry.delta+=registered;stockDeltas.set(stockRef.path,entry);
    }
    const moveRef=ref('inventoryMovements','supply-cancel-'+intent.operationId+'-'+index);
    if((await get(moveRef)).exists)fail('同一取消操作已有庫存異動憑證');
    movementRows.push({ref:moveRef,data:{type:nextStatus==='CLOSED'?'purchase_incoming_close':'purchase_incoming_cancel',
     qty:-registered,productKey:key,productId:supply.productId||'',warehouseId,fulfillmentType:'WAREHOUSE',
     sourceType:'SUPPLY_ORDER',sourceId:supplyId,purchaseDocumentId:intent.poId,
     reason:intent.reason,operationId:intent.operationId,actorUid:uid,actorRole:role,
     ownerUid:supply.ownerUid||'',salesCode:supply.salesCode||'',createdAt:now,createdBy:actorName}});
   }
  }
  for(const entry of stockDeltas.values()){
   const available=qty(entry.before.incoming,'原在途');
   if(available<entry.delta)fail('公司或分倉在途量不足以完整取消');
  }
  const poPatch=whole&&cancelledQty>0?{status:receivedQty>0?'CLOSED':'CANCELLED',
   stoppedQty:cancelledQty,cancellationOperationId:intent.operationId,
   ...(receivedQty>0
    ?{closedQty:cancelledQty,closeReason:intent.reason,closedAt:now,closedByUid:uid,closedBy:actorName}
    :{cancelledQty,cancelReason:intent.reason,cancelledAt:now,cancelledByUid:uid,cancelledBy:actorName}),
   updatedAt:now}:null;
  if(whole&&poPatch&&terminal(po.status))fail('採購單已由其他操作結案','already-exists');
  const orderIndexes=new Map();
  for(const [orderId,order] of orderPatches){
   const simple=initialOrderWorkIndex(order,order.items,now);
   const mixed=await require('./service-order-fulfillment').mixedWorkIndex(db,{get},orderId,order,
    {proofOrder:sourceOrders.get(orderId)});
   orderIndexes.set(orderId,{...simple,...mixed});
  }
  // All reads above. Every changed ledger and immutable receipt commit together.
  for(const line of supplyPatches){
   tx.update(line.ref,line.patch);
   tx.set(line.mirror,sanitizeSupply({...line.before,...line.patch}));
  }
  for(const [orderId,order] of orderPatches)
   tx.update(ref('orders',orderId),{items:order.items,itemCount:order.items.length,orderSchemaVersion:2,
    ...orderIndexes.get(orderId),updatedAt:now});
  for(const [demandId,demand] of demandPatches)
   tx.set(ref('procurementDemands',encodeURIComponent(demandId)),demandCore.demandDocument(demand,{updatedAt:now}),{merge:true});
  for(const entry of stockDeltas.values())
   tx.update(entry.ref,{incoming:entry.before.incoming-entry.delta,updatedAt:now});
  for(const movement of movementRows)tx.create(movement.ref,movement.data);
  if(poPatch)tx.update(poRef,poPatch);
  const output=result('applied',intent,role,uid,supplyIds,cancelledQty,receivedQty,[...affectedOrderIds]);
  tx.create(opRef,{type:'SUPPLY_CANCELLATION',whole,hash,actorUid:uid,actorRole:role,poId:intent.poId,
   supplyIds,changedIds,movementIds:movementRows.map(row=>row.ref.id),cancelledQty,receivedQty,affectedOrderIds:[...affectedOrderIds],
   reason:intent.reason,createdAt:now});
  return output;
 });
}
function createSupplyCancellationCallables({onCall,HttpsError,getDatabase,env=process.env}){
 const make=whole=>onCall({region:'asia-east1'},async request=>{
  if(!supplyCancellationProject(env))throw new HttpsError('failed-precondition','供應商取消後端尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitSupplyCancellation(getDatabase(),request.auth.uid,request.data,{whole,env});}
  catch(e){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(e.code))
    throw new HttpsError(e.code,e.message);
   console.error('Supply cancellation failed',e?.code||'unknown');
   throw new HttpsError('internal','供應商取消結果無法確認，請保留原操作 ID 核對');
  }
 });
 return {cancelV2OutstandingSupply:make(false),stopV2PurchaseOrderOutstanding:make(true)};
}
module.exports={supplyCancellationProject,cancellationIntent,commitSupplyCancellation,createSupplyCancellationCallables};
