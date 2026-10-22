'use strict';

// The only server-side write contract for entrusted customer samples, equipment
// and service completion events. Not exported as a Callable before Auth/Rules/UI
// acceptance. Service work NEVER creates inventory, lots, purchasing or deliveries.
const core=require('./shared/service-work-core.js');

const EVENT_ROLES=Object.freeze({
  SAMPLE_RECEIVED:['sales','warehouse'],
  DEVICE_RECEIVED:['sales','warehouse'],
  EXPERIMENT_COMPLETED:['engineer'],
  REPORT_SENT:['engineer'],
  VENDOR_SENT:['warehouse'],
  VENDOR_RETURNED:['warehouse'],
  CUSTOMER_RETURNED:['sales','warehouse'],
  CUSTOMER_DELIVERED:['sales','warehouse'],
  REPAIR_COMPLETED:['engineer']
});

function fail(message,code='failed-precondition'){
  const err=new Error(message);err.code=code;throw err;
}
function caseDocId(orderId,itemId,caseId){
  for(const field of [orderId,itemId,caseId]){
    if(typeof field!=='string'||!field||field!==field.trim()
      ||field.includes('/')||field.length>160)
      fail('服務案件來源識別碼不正確。','invalid-argument');
  }
  return [orderId,itemId,caseId].map(encodeURIComponent).join('|');
}
function assertRequest(input,uid){
  if(typeof uid!=='string'||!uid)fail('未登入使用者。','unauthenticated');
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).some(key=>!['orderId','itemId','caseId','event'].includes(key)))
    fail('服務作業請求格式不正確。','invalid-argument');
  const {orderId,itemId,caseId,event}=input;
  caseDocId(orderId,itemId,caseId);
  if(!event||typeof event!=='object'||Array.isArray(event))
    fail('服務事件內容不正確。','invalid-argument');
  if(event.actorUid!==undefined&&event.actorUid!==uid)
    fail('服務事件操作人員與登入身分不符。','permission-denied');
  try {
    return {orderId,itemId,caseId,event:core.normalizedEvent({...event,actorUid:uid})};
  }catch(err){fail(err.message,'invalid-argument');}
}
function allowedActor(role,uid,order,eventType){
  if(role==='admin')return true;
  if(!EVENT_ROLES[eventType]?.includes(role))return false;
  if(role==='sales')return order.ownerUid===uid;
  return role==='warehouse'||role==='engineer';
}
async function commitServiceCaseEvent(db,actorUid,input){
  if(!db||typeof db.runTransaction!=='function')throw Error('缺少有效資料庫交易。');
  const intent=assertRequest(input,actorUid);
  const ref=db.collection('serviceCases').doc(caseDocId(intent.orderId,intent.itemId,intent.caseId));
  const orderRef=db.collection('orders').doc(intent.orderId);
  const userRef=db.collection('users').doc(actorUid);
  // A user-provided occurredAt describes work time, not the authoritative write time.
  const recordedAt=new Date().toISOString();
  let result;
  await db.runTransaction(async tx=>{
    result=undefined;
    const [userSnap,orderSnap]=await Promise.all([tx.get(userRef),tx.get(orderRef)]);
    const profile=userSnap.exists?userSnap.data():null;
    if(!profile||profile.active===false||profile.disabled===true
      ||!['admin','sales','engineer','warehouse'].includes(profile.role))
      fail('目前使用者沒有服務作業權限。','permission-denied');
    if(!orderSnap.exists)fail('來源訂單不存在。','not-found');
    const order=orderSnap.data();
    if(order.status==='cancelled'||order.status==='voided'
      ||order.orderStatus==='cancelled'||order.orderStatus==='voided'
      ||order.inventoryReservationStatus!=='completed')
      fail('來源訂單已取消，或尚未完成訂單初始化。');
    if(!allowedActor(profile.role,actorUid,order,intent.event.type))
      fail('目前角色或負責人沒有執行此服務動作的權限。','permission-denied');
    const items=Array.isArray(order.items)?order.items:[];
    const item=items.find(x=>x?.itemId===intent.itemId);
    if(!item||String(item.productType||'').trim().toUpperCase()!=='SERVICE')
      fail('服務案件必須關聯正式的 Service 訂單品項。');
    if(!item.productId||item.productId.includes('/'))
      fail('服務品項缺少可核對的正式產品主檔。');
    const [productSnap,caseSnap]=await Promise.all([
      tx.get(db.collection('products').doc(item.productId)),
      tx.get(ref)
    ]);
    const product=productSnap.exists?productSnap.data():null;
    if(!product||product.active===false
      ||String(product.productType||product.type||'').trim().toUpperCase()!=='SERVICE')
      fail('服務品項產品主檔無效或型別衝突。');
    const itemKind=String(item.serviceKind||'').trim().toUpperCase();
    const masterKind=String(product.serviceKind||'').trim().toUpperCase();
    // The trusted product master, not an editable commercial item snapshot,
    // chooses the required custody and completion evidence workflow.
    if(!Object.prototype.hasOwnProperty.call(core.STEPS,masterKind))
      fail('正式服務主檔尚未指定四種有效服務類型。');
    if(itemKind&&itemKind!==masterKind)
      fail('訂單與產品主檔的服務類型不一致。');
    const kind=masterKind;
    const saved=caseSnap.exists?caseSnap.data():null;
    if(saved&&(saved.orderId!==intent.orderId||saved.itemId!==intent.itemId
      ||saved.caseId!==intent.caseId||saved.kind!==kind))
      fail('既有服務案件來源不一致，不能覆寫。');
    const record=saved||{
      orderId:intent.orderId,itemId:intent.itemId,caseId:intent.caseId,kind,
      createdByUid:actorUid,createdAt:recordedAt,events:[]
    };
    let next;
    try {next=core.applyServiceEvent(record,intent.event);}
    catch(err){fail(err.message);}
    const projection=next.projection;
    result={status:next.status,orderId:intent.orderId,itemId:intent.itemId,
      caseId:intent.caseId,kind,workStatus:projection.status,completed:projection.completed,
      nextEvent:projection.nextEvent,custody:projection.custody};
    if(next.status==='already-applied')return;
    tx.set(ref,{
      ...record,events:next.record.events,status:projection.status,
      custody:projection.custody,completedAt:projection.completedAt,
      updatedAt:recordedAt
    });
  });
  return result;
}
module.exports={commitServiceCaseEvent,caseDocId};
