'use strict';
// Formal PO incoming is a distinct, idempotent transaction from PO confirmation.
// The operation ID is the immutable PO number; there is never a second writer
// selected when the isolated feature flag is enabled.
const {projectIdFromEnvironment}=require('./grouped-reservation-gate');
function fail(code,message){throw Object.assign(new Error(message),{code});}
function string(value,label){
 if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>120)
  fail('invalid-argument',label+'不正確');
 return value;
}
function quantity(value,label){
 if(!Number.isSafeInteger(value)||value<0||value>1000000000)
  fail('failed-precondition',label+'數量不正確');
 return value;
}
function formalIncomingGate(env=process.env){
 const local=value=>typeof value==='string'&&/^(localhost|127\.0\.0\.1):[0-9]+$/.test(value);
 return projectIdFromEnvironment(env)==='demo-yushin'
  &&env.ENABLE_V2_PO_INCOMING_EMULATOR==='true'&&env.FUNCTIONS_EMULATOR==='true'
  &&local(env.FIREBASE_AUTH_EMULATOR_HOST)&&local(env.FIRESTORE_EMULATOR_HOST)?'demo-yushin':'';
}
async function registerFormalPurchaseIncoming(db,uid,data,env=process.env){
 const project=formalIncomingGate(env);
 if(!project||db.projectId!==project)fail('failed-precondition','採購在途後端尚未啟用');
 string(uid,'登入帳號');
 if(!data||typeof data!=='object'||Array.isArray(data)
  ||Object.keys(data).sort().join(',')!=='poNo')fail('invalid-argument','在途操作僅接受原採購單號');
 const poNo=string(data.poNo,'採購單號');
 const ref=(name,id)=>db.collection(name).doc(id);
 const receiptId='po-incoming-'+encodeURIComponent(poNo),receiptRef=ref('reservationOperationReceipts',receiptId);
 return db.runTransaction(async tx=>{
  const userSnap=await tx.get(ref('users',uid)),actor=userSnap.exists?userSnap.data():null;
  if(!actor||actor.active===false||actor.disabled===true||!['admin','purchaser'].includes(actor.role))
   fail('permission-denied','目前帳號沒有正式採購在途登記權限');
  const poSnap=await tx.get(ref('purchaseOrders',poNo));
  if(!poSnap.exists)fail('not-found','原正式採購單不存在');
  const po=poSnap.data(),receiptSnap=await tx.get(receiptRef);
  if(receiptSnap.exists){
   const saved=receiptSnap.data();
   if(saved.action!=='FORMAL_PO_INCOMING'||saved.poNo!==poNo||saved.actorUid!==uid
    ||saved.actorRole!==actor.role)fail('already-exists','原在途交易憑證不符合目前帳號或來源');
   return {...saved.result,status:'already-applied',receiptId};
  }
  if(po.poNo!==poNo||po.status!=='ORDERED'||po.documentOnly===true
   ||!po.serverCommitHash||!Array.isArray(po.items)||po.items.length<1||po.items.length>5
   ||!Array.isArray(po.supplyOrderIds)||po.supplyOrderIds.length!==po.items.length
   ||new Set(po.supplyOrderIds).size!==po.items.length)
   fail('failed-precondition','正式採購確認憑證或品項不完整');
  const company=new Map(),warehouse=new Map(),supplies=[];
  const orderCache=new Map(),productCache=new Map(),now=new Date().toISOString();
  for(let i=0;i<po.items.length;i++){
   const source=po.items[i],supplyId='po-'+encodeURIComponent(poNo)+'-'+i;
   if(po.supplyOrderIds[i]!==supplyId)fail('failed-precondition','原供應 ID 與採購列不一致');
   const supplyRef=ref('supplyOrders',supplyId),snap=await tx.get(supplyRef);
   const mirrorRef=ref('receivingSupplyOrders',supplyId),mirrorSnap=await tx.get(mirrorRef);
   const supply=snap.exists?snap.data():null;
   const orderId=string(source.orderId,'訂單'),itemId=string(source.itemId,'訂單品項');
   const productId=string(source.productId,'商品'),productKey=string(source.productKey||productId,'庫存商品');
   const planned=quantity(source.qty,'採購列'),warehouseId=String(source.warehouseId||'');
   const direct=(source.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
   if(!supply||supply.type!=='PURCHASING_PO'||supply.status!=='ORDERED'
    ||supply.purchaseDocumentId!==poNo||supply.sourceType!=='SALES_ORDER'
    ||supply.sourceId!==orderId||supply.sourceItemId!==itemId
    ||supply.orderId!==orderId||supply.itemId!==itemId||supply.productId!==productId
    ||supply.productKey!==productKey||supply.qty!==planned||supply.receivedQty!==0
    ||supply.incomingRegisteredQty!==0||supply.warehouseId!==warehouseId
    ||(supply.fulfillmentType||'WAREHOUSE')!==(source.fulfillmentType||'WAREHOUSE'))
    fail('failed-precondition','正式採購與供應／到貨／已登記在途的來源不一致');
   const mirror=mirrorSnap.exists?mirrorSnap.data():null;
   if(!mirror||mirror.purchaseDocumentId!==poNo||mirror.orderId!==orderId
    ||mirror.itemId!==itemId||mirror.productKey!==productKey
    ||mirror.qty!==planned||mirror.receivedQty!==0||mirror.incomingRegisteredQty!==0
    ||Object.hasOwn(mirror,'unitCost')||Object.hasOwn(mirror,'cost')||Object.hasOwn(mirror,'costPrice'))
    fail('failed-precondition','倉管去成本供應檢視與正式供應來源不一致');
   if(!orderCache.has(orderId))orderCache.set(orderId,await tx.get(ref('orders',orderId)));
   const orderSnap=orderCache.get(orderId),order=orderSnap.exists?orderSnap.data():null;
   const item=order?.items?.find(row=>row.itemId===itemId);
   if(!item||item.productId!==productId||quantity(item.supplyOrderedQty??0,'來源供應量')<planned)
    fail('failed-precondition','原客戶訂單供應承諾或產品不一致');
   if(!productCache.has(productId))productCache.set(productId,await tx.get(ref('products',productId)));
   const product=productCache.get(productId);
   if(!product.exists||product.data().active===false
    ||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
    fail('failed-precondition','在途商品主檔不存在、停用或不是實體商品');
   supplies.push({ref:supplyRef,mirrorRef,id:supplyId,data:supply,direct,delta:planned});
   if(direct)continue;
   if(!warehouseId||warehouseId.startsWith('custody-'))fail('failed-precondition','不能將採購在途寫入保管倉');
   const master=await tx.get(ref('warehouses',warehouseId));
   if(!master.exists||master.data().active===false||master.data().systemCustody)
    fail('failed-precondition','採購入庫實體倉庫不存在或停用');
   if(!company.has(productKey)){
    const stockRef=ref('inventory',encodeURIComponent(productKey)),stockSnap=await tx.get(stockRef);
    const original=stockSnap.exists?stockSnap.data():null;
    if(original?.productKey&&original.productKey!==productKey)fail('failed-precondition','公司庫存商品識別異常');
    company.set(productKey,{ref:stockRef,original,increment:0,supply});
   }
   company.get(productKey).increment+=planned;
   const key=warehouseId+'\u0000'+productKey;
   if(!warehouse.has(key)){
    const stockRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
    const stockSnap=await tx.get(stockRef),original=stockSnap.exists?stockSnap.data():null;
    if(original&&(original.productKey&&original.productKey!==productKey
     ||original.warehouseId&&original.warehouseId!==warehouseId))
     fail('failed-precondition','分倉庫存來源識別異常');
    warehouse.set(key,{ref:stockRef,original,increment:0,supply,warehouseId});
   }
   warehouse.get(key).increment+=planned;
  }
  const details=[];
  for(const row of supplies){
   if(row.direct){details.push({supplyOrderId:row.id,registeredQty:0});continue;}
   tx.update(row.ref,{incomingRegisteredQty:row.delta,incomingRegisteredAt:now,updatedAt:now});
   tx.update(row.mirrorRef,{incomingRegisteredQty:row.delta,incomingRegisteredAt:now,updatedAt:now});
   const data=row.data;
   tx.create(ref('inventoryMovements','po-incoming-'+encodeURIComponent(poNo)+'-'+encodeURIComponent(row.id)),{
    type:'purchase_incoming',qty:row.delta,productKey:data.productKey,productId:data.productId,
    warehouseId:data.warehouseId,brand:data.brand||'',brandId:data.brandId||'',
    fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:row.id,
    purchaseDocumentId:poNo,createdAt:now,createdBy:actor.name||actor.email||uid,
    actorUid:uid,operationReceiptId:receiptId});
   details.push({supplyOrderId:row.id,registeredQty:row.delta});
  }
  for(const record of company.values()){
   const previous=record.original||{},supply=record.supply;
   const incoming=quantity(previous.incoming??0,'公司原在途')+record.increment;
   quantity(incoming,'公司新在途');
   tx.set(record.ref,{productKey:supply.productKey,productId:supply.productId,
    itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',brandId:supply.brandId||'',
    onHand:quantity(previous.onHand??0,'公司實存'),reserved:quantity(previous.reserved??0,'公司預留'),
    incoming,lots:previous.lots??[],updatedAt:now},{merge:true});
  }
  for(const record of warehouse.values()){
   const previous=record.original||{},supply=record.supply;
   const incoming=quantity(previous.incoming??0,'分倉原在途')+record.increment;
   quantity(incoming,'分倉新在途');
   tx.set(record.ref,{productKey:supply.productKey,productId:supply.productId,warehouseId:record.warehouseId,
    itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',brandId:supply.brandId||'',
    onHand:quantity(previous.onHand??0,'分倉實存'),reserved:quantity(previous.reserved??0,'分倉預留'),
    incoming,updatedAt:now},{merge:true});
  }
  const result={poNo,supplyOrderIds:[...po.supplyOrderIds],details};
  tx.create(receiptRef,{action:'FORMAL_PO_INCOMING',poNo,actorUid:uid,actorRole:actor.role,
   createdAt:now,result});
  return {...result,status:'applied',receiptId};
 });
}
function createFormalPurchaseIncomingCallable({onCall,HttpsError,getDatabase,env=process.env}){
 return onCall({region:'asia-east1'},async request=>{
  if(!formalIncomingGate(env))throw new HttpsError('failed-precondition','正式採購在途尚未切換');
  if(!request.auth?.uid)throw new HttpsError('unauthenticated','請先登入');
  try{return await registerFormalPurchaseIncoming(getDatabase(),request.auth.uid,request.data,env);}
  catch(error){
   if(['invalid-argument','permission-denied','failed-precondition','not-found','already-exists'].includes(error.code))
    throw new HttpsError(error.code,error.message);
   console.error('Formal purchase incoming result unknown',error);
   throw new HttpsError('internal','在途結果未確認，請沿用原採購單號重試核對');
  }
 });
}
module.exports={formalIncomingGate,registerFormalPurchaseIncoming,createFormalPurchaseIncomingCallable};
