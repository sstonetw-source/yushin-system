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
function itemCaseIndexId(orderId,itemId){
  caseDocId(orderId,itemId,'validate');
  // Four encoded segments cannot collide with a three-segment case key.
  return ['item-index',orderId,itemId,'v1'].map(encodeURIComponent).join('|');
}
async function readItemCases(db,tx,orderId,itemId,item,kind){
  const ref=db.collection('serviceCases').doc(itemCaseIndexId(orderId,itemId));
  const snap=await tx.get(ref);
  if(!snap.exists){
    // Never silently adopt pre-quantity pilot cases or release their allocation.
    const old=await tx.get(db.collection('serviceCases')
      .where('orderId','==',orderId).where('itemId','==',itemId).limit(1));
    if(!old.empty)fail('既有服務案件尚未綁定數量索引，不能自動補綁。');
    return {ref,record:{recordType:'ITEM_CASE_INDEX',orderId,itemId,
      productId:item.productId,kind,caseIds:[]},cases:[]};
  }
  const record=snap.data();
  if(record.recordType!=='ITEM_CASE_INDEX'||record.orderId!==orderId||record.itemId!==itemId
    ||record.productId!==item.productId||record.kind!==kind
    ||!Array.isArray(record.caseIds)||record.caseIds.length>core.MAX_ITEM_CASES
    ||new Set(record.caseIds).size!==record.caseIds.length)
    fail('服務案件數量索引來源或內容不一致。');
  const cases=await Promise.all(record.caseIds.map(async id=>{
    const saved=await tx.get(db.collection('serviceCases').doc(caseDocId(orderId,itemId,id)));
    if(!saved.exists)fail('服務案件數量索引的案件不存在。');
    const row=saved.data();
    if(row.orderId!==orderId||row.itemId!==itemId||row.caseId!==id||row.kind!==kind)
      fail('服務案件數量索引的案件來源不一致。');
    assertCaseProduct(row,item);
    return row;
  }));
  return {ref,record,cases};
}
function assertRequest(input,uid){
  if(typeof uid!=='string'||!uid)fail('未登入使用者。','unauthenticated');
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).some(key=>!['orderId','itemId','caseId','serviceQty','event'].includes(key)))
    fail('服務作業請求格式不正確。','invalid-argument');
  const {orderId,itemId,caseId,event}=input;
  caseDocId(orderId,itemId,caseId);
  if(!event||typeof event!=='object'||Array.isArray(event))
    fail('服務事件內容不正確。','invalid-argument');
  if(event.actorUid!==undefined&&event.actorUid!==uid)
    fail('服務事件操作人員與登入身分不符。','permission-denied');
  try {
    return {orderId,itemId,caseId,serviceQty:core.serviceQuantity(input.serviceQty),
      event:core.normalizedEvent({...event,actorUid:uid})};
  }catch(err){fail(err.message,'invalid-argument');}
}
function allowedActor(role,uid,order,eventType){
  if(role==='admin')return true;
  if(!EVENT_ROLES[eventType]?.includes(role))return false;
  if(role==='sales')return order.ownerUid===uid;
  return role==='warehouse'||role==='engineer';
}
function assertCaseProduct(record,item){
  if(typeof item.productId!=='string'||!item.productId||item.productId.includes('/')
    ||record.productId!==item.productId)
    fail('服務案件與原產品識別不一致或尚未綁定，不能接續或套用歷程。');
  const itemKind=String(item.serviceKind||'').trim().toUpperCase();
  if(itemKind&&itemKind!==record.kind)
    fail('服務案件與訂單品項的服務類型不一致。');
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
    const forbiddenStatus=new Set(['cancelled','canceled','void','voided','deleted','closed','已取消','作廢','已結案']);
    if([order.status,order.orderStatus].some(s=>forbiddenStatus.has(String(s||'').trim().toLowerCase()))
      ||order.inventoryReservationStatus!=='completed')
      fail('來源訂單已取消或結案，或尚未完成訂單初始化。');
    if(!allowedActor(profile.role,actorUid,order,intent.event.type))
      fail('目前角色或負責人沒有執行此服務動作的權限。','permission-denied');
    const items=Array.isArray(order.items)?order.items:[];
    const matched=items.filter(x=>x?.itemId===intent.itemId);
    if(matched.length!==1)
      fail('服務案件來源訂單品項不存在或識別碼重複。');
    const item=matched[0];
    if(String(item.productType||'').trim().toUpperCase()!=='SERVICE')
      fail('服務案件必須關聯正式的 Service 訂單品項。');
    if(typeof item.productId!=='string'||!item.productId||item.productId.includes('/'))
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
    if(saved)assertCaseProduct(saved,item);
    if(saved&&saved.serviceQty!==intent.serviceQty)
      fail('服務案件對應數量已固定或尚未綁定，不能改量重送。');
    const index=await readItemCases(db,tx,intent.orderId,intent.itemId,item,kind);
    if(!!saved!==index.record.caseIds.includes(intent.caseId))
      fail('服務案件與數量索引不一致。');
    let itemProgress;
    try {core.projectServiceItem(item,index.cases);}
    catch(err){fail(err.message);}
    const record=saved||{
      orderId:intent.orderId,itemId:intent.itemId,caseId:intent.caseId,kind,
      productId:item.productId,serviceQty:intent.serviceQty,
      createdByUid:actorUid,createdAt:recordedAt,events:[]
    };
    let next;
    try {next=core.applyServiceEvent(record,intent.event);}
    catch(err){fail(err.message);}
    const cases=[...index.cases.filter(row=>row.caseId!==intent.caseId),next.record];
    try {itemProgress=core.projectServiceItem(item,cases);}
    catch(err){fail(err.message);}
    const projection=next.projection;
    result={status:next.status,orderId:intent.orderId,itemId:intent.itemId,
      caseId:intent.caseId,kind,workStatus:projection.status,completed:projection.completed,
      nextEvent:projection.nextEvent,custody:projection.custody,
      serviceQty:record.serviceQty,itemProgress};
    if(next.status==='already-applied')return;
    if(!saved)tx.set(index.ref,{...index.record,
      caseIds:[...index.record.caseIds,intent.caseId]});
    tx.set(ref,{
      ...record,events:next.record.events,status:projection.status,
      custody:projection.custody,completedAt:projection.completedAt,
      updatedAt:recordedAt
    });
  });
  return result;
}

/**
 * Read an existing service case without inventing a case for an unregistered ID.
 * Used by the demo-only Callable until real UI/Preview authorization is accepted.
 * A cancelled order remains readable for historical custody/audit purposes.
 */
async function getServiceCaseStatus(db,actorUid,input){
  if(!db||typeof db.runTransaction!=='function')throw Error('缺少有效資料庫交易。');
  if(typeof actorUid!=='string'||!actorUid)fail('未登入使用者。','unauthenticated');
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).some(key=>!['orderId','itemId','caseId'].includes(key)))
    fail('服務案件查詢格式不正確。','invalid-argument');
  const {orderId,itemId,caseId}=input;
  caseDocId(orderId,itemId,caseId);
  const orderRef=db.collection('orders').doc(orderId);
  const userRef=db.collection('users').doc(actorUid);
  const caseRef=db.collection('serviceCases').doc(caseDocId(orderId,itemId,caseId));
  return db.runTransaction(async tx=>{
    const [userSnap,orderSnap]=await Promise.all([tx.get(userRef),tx.get(orderRef)]);
    const profile=userSnap.exists?userSnap.data():null;
    if(!profile||profile.active===false||profile.disabled===true
      ||!['admin','sales','engineer','warehouse'].includes(profile.role))
      fail('目前使用者沒有查看服務案件的權限。','permission-denied');
    if(!orderSnap.exists)fail('來源訂單不存在。','not-found');
    const order=orderSnap.data();
    if(profile.role==='sales'&&order.ownerUid!==actorUid)
      fail('只有訂單負責業務有權限查看服務案件。','permission-denied');
    const matched=(Array.isArray(order.items)?order.items:[]).filter(item=>item?.itemId===itemId);
    if(matched.length!==1
      ||String(matched[0].productType||'').trim().toUpperCase()!=='SERVICE')
      fail('服務案件來源訂單品項不存在或型別不符。','failed-precondition');
    const snap=await tx.get(caseRef);
    if(!snap.exists)return {exists:false,orderId,itemId,caseId,workStatus:'NOT_STARTED',
      completed:false,nextEvent:null,custody:null,events:[]};
    const record=snap.data();
    if(record?.orderId!==orderId||record?.itemId!==itemId||record?.caseId!==caseId)
      fail('服務案件來源識別不一致，不能讀取。');
    assertCaseProduct(record,matched[0]);
    let projection;
    try {projection=core.projectServiceCase(record);}
    catch(err){fail(err.message);}
    // Old demo histories remain readable, but are never counted as bound work.
    let itemProgress=null;
    if(record.serviceQty!==undefined){
      const index=await readItemCases(db,tx,orderId,itemId,matched[0],record.kind);
      if(!index.record.caseIds.includes(caseId))fail('服務案件與數量索引不一致。');
      try {itemProgress=core.projectServiceItem(matched[0],index.cases);}
      catch(err){fail(err.message);}
    }
    return {...projection,exists:true,workStatus:projection.status,
      serviceQty:record.serviceQty??null,itemProgress};
  });
}

module.exports={commitServiceCaseEvent,getServiceCaseStatus,caseDocId,itemCaseIndexId};
