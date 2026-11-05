'use strict';

const {isServiceItem,canDeliver}=require('./shared/workflow-core');
const {initialOrderWorkIndex}=require('./order-reservation-service');

const actions=['EXECUTE','PREPARE','DELIVER'];
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
function validId(value){
  return typeof value==='string'&&value.length>0&&value.length<=160
    &&value.trim()===value&&!value.includes('/');
}

async function commitOrderServiceAction(db,uid,input){
  if(typeof uid!=='string'||!uid)fail('unauthenticated','請先登入。');
  const {orderId,itemId,action}=input||{};
  if(!validId(orderId)||!validId(itemId)||!actions.includes(action)
    ||Object.keys(input).some(key=>!['orderId','itemId','action'].includes(key)))
    fail('invalid-argument','服務操作識別碼不正確。');
  const orderRef=db.collection('orders').doc(orderId);
  const at=new Date().toISOString();
  return db.runTransaction(async tx=>{
    const [profile,snapshot]=await Promise.all([
      tx.get(db.collection('users').doc(uid)),tx.get(orderRef)
    ]);
    const user=profile.data();
    const roles=action==='DELIVER'?['admin','sales','engineer']:['admin','purchaser'];
    if(!user||user.active===false||user.disabled===true||!roles.includes(user.role))
      fail('permission-denied','目前沒有執行這個服務操作的權限。');
    if(!snapshot.exists)fail('not-found','來源訂單不存在。');
    const order=snapshot.data();
    if(action==='DELIVER'&&user.role!=='admin'&&order.ownerUid!==uid)
      fail('permission-denied','只能確認自己負責的訂單送達。');
    if(order.inventoryReservationStatus!=='completed'||!order.serviceFulfillment
      ||[order.status,order.orderStatus].some(status=>['cancelled','canceled','void','voided','deleted','closed','已取消','作廢','已結案'].includes(String(status||'').trim().toLowerCase())))
      fail('failed-precondition','訂單尚未完成同步或已停止履約。');
    const matches=order.items.filter(item=>item.itemId===itemId);
    const item=matches[0],quantity=item?.orderedQty??item?.qty;
    if(matches.length!==1||!isServiceItem(item)||!Number.isSafeInteger(quantity)||quantity<=0)
      fail('failed-precondition','來源品項不是有效的服務品項。');
    const prior=Object.hasOwn(order.serviceFulfillment,itemId)?order.serviceFulfillment[itemId]:{};
    const result={orderId,itemId,action};
    if(prior[action]?.quantity===quantity)return {...result,status:'already-applied'};
    if(order.isBilled||prior[action]||actions.slice(0,actions.indexOf(action)).some(step=>prior[step]?.quantity!==quantity)
      ||(action==='DELIVER'&&!canDeliver(order)))
      fail('failed-precondition','服務操作不符合目前訂單進度。');
    const serviceFulfillment={...order.serviceFulfillment,[itemId]:{
      ...prior,[action]:{by:uid,actorRole:user.role,at,quantity}
    }};
    tx.update(orderRef,{serviceFulfillment,updatedAt:at,
      ...initialOrderWorkIndex({...order,serviceFulfillment},order.items,at)});
    return {...result,status:'applied'};
  });
}
module.exports={commitOrderServiceAction};
