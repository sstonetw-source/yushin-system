'use strict';
// Server-only, read-only admission checkpoint for the future authoritative
// formal PO transaction. This is not a second purchase writer. It deliberately
// performs no mutation and must be re-run INSIDE the eventual commit transaction.
// Quantity formulas use the exact browser Procurement Demand Core.
const demandCore=require('./shared/procurement-demand-core.js');
function reject(code,message){const error=new Error(message);error.code=code;throw error;}
function identifier(value,label,max=160){
 if(typeof value!=='string'||!value||value.trim()!==value||value.length>max||value.includes('/'))
  reject('invalid-argument',label+'識別不正確');
 return value;
}
function integer(value,label){
 if(!Number.isSafeInteger(value)||value<=0||value>1000000)
  reject('invalid-argument',label+'必須是 1–1,000,000 的整數');
 return value;
}
function strictRequest(input){
 if(!input||typeof input!=='object'||Array.isArray(input)
   ||Object.keys(input).some(key=>!['poNo','orderId','itemId','qty'].includes(key))
   ||Object.keys(input).length!==4)
  reject('invalid-argument','採購預覽請求欄位不正確');
 return {
  poNo:identifier(input.poNo,'採購單號',128),
  orderId:identifier(input.orderId,'來源訂單',160),
  itemId:identifier(input.itemId,'來源品項',160),
  qty:integer(input.qty,'採購數量')
 };
}
function stockNumber(value,label){
 if(!Number.isSafeInteger(value)||value<0)reject('failed-precondition',label+'數量異常');
 return value;
}
async function previewV2FormalPurchase(db,uid,data){
 identifier(uid,'登入使用者',200);
 const intent=strictRequest(data),ref=(collection,id)=>db.collection(collection).doc(id);
 const demandId=demandCore.demandIdForSource({
  sourceType:'SALES_ORDER',sourceId:intent.orderId,sourceItemId:intent.itemId
 });
 return db.runTransaction(async tx=>{
  // Do not trust client role or UI hidden buttons. Read live user and business
  // facts under the same transaction snapshot that a future commit must use.
  const user=await tx.get(ref('users',uid));
  if(!user.exists||user.data().active===false||user.data().disabled===true
    ||!['admin','purchaser'].includes(user.data().role))
   reject('permission-denied','登入使用者沒有正式採購權限');
  const po=await tx.get(ref('purchaseOrders',intent.poNo));
  if(po.exists)reject('already-exists','此採購單號已建立，請開啟既有單據');
  const order=await tx.get(ref('orders',intent.orderId));
  if(!order.exists)reject('not-found','來源訂單不存在');
  const source=order.data();
  if(!source.ownerUid||!source.salesCode
    ||source.status==='cancelled'||source.orderStatus==='cancelled'
    ||source.status==='voided'||source.orderStatus==='voided'
    ||source.returnPending===true||source.inventoryReservationStatus!=='completed'
    ||!Array.isArray(source.items)||source.items.length<1||source.items.length>5)
   reject('failed-precondition','來源訂單不可建立正式採購單');
  const matching=source.items.map((row,index)=>({row,index}))
   .filter(({row})=>row?.itemId===intent.itemId);
  if(matching.length!==1)reject('failed-precondition','來源品項不存在或重複');
  const {row,index}=matching[0];
  if((row.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||String(row.productType||row.type||'').toUpperCase()==='SERVICE'
    ||row.transferPendingId||row.custodyTransferId)
   reject('failed-precondition','此品項不是可採購的實體商品');
  const orderQty=stockNumber(row.qty??row.orderedQty,'訂購');
  const reserved=stockNumber(row.reservedQty??0,'預留');
  const shortage=stockNumber(row.shortageQty??0,'缺貨');
  const received=stockNumber(row.receivedQty??0,'已收貨');
  const ordered=stockNumber(row.supplyOrderedQty??0,'已採購');
  if(orderQty===0||reserved>orderQty||shortage>orderQty||ordered<received)
   reject('failed-precondition','來源品項數量不一致');
  const masterId=identifier(row.productId,'來源產品',1500);
  const warehouseId=identifier(row.warehouseId||source.warehouseId,'來源倉庫',200);
  if(warehouseId.startsWith('custody-'))reject('failed-precondition','業務保管位置不可直接採購入庫');
  const product=await tx.get(ref('products',masterId));
  const warehouse=await tx.get(ref('warehouses',warehouseId));
  if(!product.exists||product.data().active===false
    ||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
   reject('failed-precondition','產品主檔無效');
  if(!warehouse.exists||warehouse.data().active===false
    ||warehouse.data().systemCustody===true)
   reject('failed-precondition','來源倉庫無效');
  const demand=await tx.get(ref('procurementDemands',encodeURIComponent(demandId)));
  if(!demand.exists)reject('failed-precondition','權威採購需求不存在');
  const doc=demand.data();
  if(doc.demandId!==demandId||doc.sourceType!=='SALES_ORDER'
    ||doc.sourceId!==intent.orderId||doc.sourceItemId!==intent.itemId
    ||doc.sourceItemIndex!==index||doc.ownerUid!==source.ownerUid
    ||doc.salesCode!==source.salesCode
    ||doc.productKey!==String(row.inventoryProductKey||row.productId)
    ||doc.productId!==masterId||doc.status==='CANCELLED'
    ||doc.orderedQty!==ordered||doc.receivedQty!==received)
   reject('failed-precondition','採購需求與來源訂單不一致');
  const expected=demandCore.fromSalesOrder({
   ...doc,sourceId:intent.orderId,sourceItemId:intent.itemId,
   shortageQty:shortage,supplyOrderedQty:ordered,receivedQty:received,
   fulfillmentType:row.fulfillmentType||'WAREHOUSE'
  });
  if(doc.requestedQty!==expected.requestedQty
    ||doc.remainingToOrderQty!==expected.remainingToOrderQty
    ||doc.remainingToReceiveQty!==expected.remainingToReceiveQty
    ||doc.status!==expected.status)
   reject('failed-precondition','採購需求已過期，請重新整理');
  const plan=demandCore.applyOrder(expected,intent.qty);
  if(plan.appliedQty!==intent.qty)
   reject('failed-precondition','採購超過目前缺貨需求');
  return {poNo:intent.poNo,orderId:intent.orderId,itemId:intent.itemId,
   productId:masterId,warehouseId,demandId,
   requestedQty:expected.requestedQty,orderedQty:expected.orderedQty,
   remainingToOrderQty:expected.remainingToOrderQty,
   proposedQty:intent.qty,remainingAfterQty:plan.demand.remainingToOrderQty,
   status:'preview-only'};
 });
}
module.exports={previewV2FormalPurchase,strictRequest};
