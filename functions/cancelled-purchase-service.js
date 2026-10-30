'use strict';
const {createHash}=require('node:crypto');
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
const {planCancelledPurchaseKeepStock}=require('./shared/supply-core');
const {sanitizeSupply}=require('./shared/stock-permissions');
function fault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function cancelledPurchaseProject(env=process.env){
 const p=projectIdFromEnvironment(env),local=v=>typeof v==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(v);
 if(p==='preview-20135'&&env.ENABLE_PREVIEW_CANCELLED_PURCHASE==='true'
  &&!env.FUNCTIONS_EMULATOR&&!env.FIRESTORE_EMULATOR_HOST&&!env.FIREBASE_AUTH_EMULATOR_HOST)return p;
 if(p==='demo-yushin'&&env.ENABLE_CANCELLED_PURCHASE_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIRESTORE_EMULATOR_HOST)&&local(env.FIREBASE_AUTH_EMULATOR_HOST))return p;
 return '';
}
function ident(v){if(typeof v!=='string'||!v||v!==v.trim()||v.includes('/')||v.length>160)fault('採購識別碼不正確','invalid-argument');return v;}
async function commitCancelledPurchaseKeepStock(db,uid,data,env=process.env){
 const project=cancelledPurchaseProject(env);
 if(!project||db.projectId!==project)fault('取消採購資料庫未獲授權');
 if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!['supplyId','warehouseId','expectedDirect','operationId'].includes(k))
  ||typeof data.expectedDirect!=='boolean')fault('採購轉備庫請求不正確','invalid-argument');
 const intent={supplyId:ident(data.supplyId),warehouseId:ident(data.warehouseId),expectedDirect:data.expectedDirect,operationId:ident(data.operationId)};
 if(!/^[a-zA-Z0-9_-]{12,96}$/.test(intent.operationId))fault('操作識別碼不正確','invalid-argument');
 const hash=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
 return db.runTransaction(async tx=>{
  const ref=(n,k)=>db.collection(n).doc(k),user=await tx.get(ref('users',ident(uid)));
  if(!user.exists||user.data().active===false||user.data().disabled===true||!['admin','purchaser'].includes(user.data().role))fault('沒有採購處理權限','permission-denied');
  const role=user.data().role,supplyRef=ref('supplyOrders',intent.supplyId),snap=await tx.get(supplyRef);
  if(!snap.exists)fault('找不到採購品項','not-found');const supply=snap.data();
  const source=await tx.get(ref('orders',ident(supply.orderId)));
  if(!source.exists)fault('找不到來源訂單');const order=source.data();
  const result=status=>({status,supplyId:intent.supplyId,operationId:intent.operationId,actorUid:uid,actorRole:role});
  if(supply.keepStockOperationId){
   if(supply.keepStockOperationId!==intent.operationId||supply.keepStockIntentHash!==hash
    ||supply.customerCancellationResolvedBy!==uid||supply.keepStockActorRole!==role)fault('此採購已有其他轉備庫操作','already-exists');
   return result('already-applied');
  }
  if(supply.customerCancellationDisposition)fault('原採購已有處理結果，請先核對');
  if(order.status!=='cancelled'||order.orderStatus!=='cancelled'||!order.ownerUid||!order.salesCode)fault('來源不是已取消的完整訂單');
  const item=(order.items||[]).find(r=>r.itemId===supply.itemId);
  const key=ident(supply.productKey||supply.productId);
  if(!['PURCHASING_PO','PURCHASING_MANUAL'].includes(supply.type)||!item
   ||(item.inventoryProductKey||item.productId)!==key||supply.ownerUid!==order.ownerUid
   ||supply.salesCode!==order.salesCode)fault('採購與來源品項不一致');
  let plan;try{plan=planCancelledPurchaseKeepStock(supply,intent);}catch(e){fault(e.message);}
  const now=new Date().toISOString(),patch={customerCancellationDisposition:'KEEP_STOCK',customerCancellationResolvedAt:now,
   customerCancellationResolvedBy:uid,keepStockOperationId:intent.operationId,keepStockIntentHash:hash,keepStockActorRole:role,updatedAt:now};
  if(plan.redirect){
   const master=await tx.get(ref('warehouses',intent.warehouseId));
   if(!master.exists||master.data().active===false||master.data().systemCustody||master.data().warehouseType==='CUSTODY')fault('收貨倉不是啟用的實體倉');
   const invRef=ref('inventory',encodeURIComponent(key)),whRef=ref('warehouseStocks',encodeURIComponent(intent.warehouseId)+'__'+encodeURIComponent(key));
   const inv=await tx.get(invRef),wh=await tx.get(whRef),movementRef=ref('inventoryMovements','redirect-'+intent.supplyId);
   const movement=await tx.get(movementRef);if(movement.exists)fault('已有轉倉憑證，請先核對');
   for(const [snap,warehouse] of [[inv,false],[wh,true]])if(snap.exists){
    const raw=snap.data();if(raw.productKey!==key||(warehouse&&raw.warehouseId!==intent.warehouseId)
     ||!Number.isSafeInteger(raw.incoming??0)||(raw.incoming??0)<0
     ||!Number.isSafeInteger((raw.incoming??0)+plan.remainingQty))fault('公司／分倉在途來源不一致');
   }
   Object.assign(patch,{originalFulfillmentType:'DIRECT_SHIP',fulfillmentType:'WAREHOUSE',warehouseId:intent.warehouseId,
    redirectInventoryId:invRef.id,redirectWarehouseStockId:whRef.id,incomingRegisteredQty:plan.remainingQty});
   const info={productKey:key,productId:supply.productId||key,itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',updatedAt:now};
   tx.set(invRef,{...info,incoming:(inv.exists?inv.data().incoming??0:0)+plan.remainingQty},{merge:true});
   tx.set(whRef,{...info,warehouseId:intent.warehouseId,incoming:(wh.exists?wh.data().incoming??0:0)+plan.remainingQty},{merge:true});
   tx.create(movementRef,{type:'cancelled_direct_ship_redirect',qty:plan.remainingQty,productKey:key,warehouseId:intent.warehouseId,
    sourceType:'SUPPLY_ORDER',sourceId:intent.supplyId,createdAt:now,createdBy:uid,actorUid:uid,actorRole:role,operationId:intent.operationId});
  }
  tx.update(supplyRef,patch);
  tx.set(ref('receivingSupplyOrders',intent.supplyId),sanitizeSupply({...supply,...patch}));
  return result('applied');
 });
}
function createCancelledPurchaseCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!cancelledPurchaseProject(env))throw new HttpsError('failed-precondition','取消採購後端尚未啟用');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await commitCancelledPurchaseKeepStock(getDatabase(),request.auth.uid,request.data,env);}
  catch(e){if(['invalid-argument','failed-precondition','permission-denied','not-found','already-exists'].includes(e.code))throw new HttpsError(e.code,e.message);
   console.error('Cancelled purchase failed',e);throw new HttpsError('internal','採購處理結果無法確認，請保留原操作識別碼');}
 });
}
module.exports={cancelledPurchaseProject,commitCancelledPurchaseKeepStock,createCancelledPurchaseCallable};
