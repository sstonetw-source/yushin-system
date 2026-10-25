'use strict';

// The only server-side write contract for entrusted customer samples, equipment
// and service completion events. Not exported as a Callable before Auth/Rules/UI
// acceptance. Service work NEVER creates inventory, lots, purchasing or deliveries.
const core=require('./shared/service-work-core.js');
const workflow=require('./shared/workflow-core.js');

function serviceItemWorkflow(orderId,order,item,kind,cases){
  const closed=['cancelled','canceled','void','voided','deleted','closed','已取消','作廢','已結案'];
  const lifecycleStatus=[order.status,order.orderStatus].some(s=>closed.includes(String(s||'').trim().toLowerCase()))
    ?'cancelled':'normal';
  try{return workflow.projectItem({...item,orderId,serviceKind:kind,
    lifecycleStatus,isBilled:order.isBilled===true},cases);}
  catch(error){fail(error.message);}
}

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
function activeServiceMasterKind(product){
  if(!product||product.active===false
    ||String(product.productType||product.type||'').trim().toUpperCase()!=='SERVICE')return null;
  const kind=String(product.serviceKind||'').trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(core.STEPS,kind)?kind:null;
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
async function readItemCases(db,tx,orderId,itemId,item,kind,knownSnap){
  const ref=db.collection('serviceCases').doc(itemCaseIndexId(orderId,itemId));
  const snap=knownSnap||await tx.get(ref);
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
    const masterKind=activeServiceMasterKind(product);
    // The trusted product master, not an editable commercial item snapshot,
    // chooses the required custody and completion evidence workflow.
    if(!masterKind)
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
    let itemProgress,itemWorkflow;
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
    itemWorkflow=serviceItemWorkflow(intent.orderId,order,item,kind,cases);
    itemProgress=itemWorkflow.serviceProgress;
    const projection=next.projection;
    result={status:next.status,orderId:intent.orderId,itemId:intent.itemId,
      caseId:intent.caseId,kind,workStatus:projection.status,completed:projection.completed,
      nextEvent:projection.nextEvent,custody:projection.custody,
      serviceQty:record.serviceQty,itemProgress,itemWorkCategory:itemWorkflow.workCategory};
    if(next.status==='already-applied')return;
    // Project the pending event through the same full evidence reader before
    // either the case or the order index is written.
    const progress=await require('./service-order-fulfillment').readOrderFulfillment(
      db,tx,intent.orderId,order,{serviceOverride:{itemId:intent.itemId,workflow:itemWorkflow}});
    const unique=progress.workCategories;
    if(!Array.isArray(order.workCategories)||JSON.stringify(unique)!==JSON.stringify(order.workCategories))
      tx.update(orderRef,{workCategories:unique,workCategoryUpdatedAt:recordedAt});
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
  if(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1
    &&typeof input.orderNo==='string'&&input.orderNo.trim()===input.orderNo&&input.orderNo.length>0&&input.orderNo.length<=160){
    return db.runTransaction(async tx=>{
      const user=await tx.get(db.collection('users').doc(actorUid)),profile=user.exists?user.data():null;
      if(!profile||profile.active===false||profile.disabled===true||!['admin','sales','engineer','warehouse'].includes(profile.role))
        fail('目前使用者沒有查看服務案件的權限。','permission-denied');
      const rows=await tx.get(db.collection('orders').where('orderNo','==',input.orderNo).limit(2));
      if(rows.size!==1)fail('訂單編號不存在或重複，請核對。','not-found');
      const doc=rows.docs[0],order=doc.data();
      if(profile.role==='sales'&&order.ownerUid!==actorUid)fail('只有訂單負責業務有權限查看服務案件。','permission-denied');
      const items=(Array.isArray(order.items)?order.items:[]).filter(i=>String(i.productType||'').trim().toUpperCase()==='SERVICE')
        .map(i=>({itemId:i.itemId,itemName:i.itemName||i.itemCode||'服務品項'}));
      if(!items.length)fail('此訂單沒有服務品項。');
      return {orderId:doc.id,orderNo:order.orderNo,customerName:order.customerName||'',items};
    });
  }
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).some(key=>!['orderId','itemId','caseId'].includes(key)))
    fail('服務案件查詢格式不正確。','invalid-argument');
  const {orderId,itemId,caseId}=input;
  caseDocId(orderId,itemId,caseId===undefined?'validate':caseId);
  const orderRef=db.collection('orders').doc(orderId);
  const userRef=db.collection('users').doc(actorUid);
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
    if(caseId===undefined){
      const item=matched[0];
      if(typeof item.productId!=='string'||!item.productId||item.productId.includes('/'))
        fail('服務品項缺少可核對的正式產品主檔。');
      const [indexSnap,productSnap]=await Promise.all([
        tx.get(db.collection('serviceCases').doc(itemCaseIndexId(orderId,itemId))),
        tx.get(db.collection('products').doc(item.productId))
      ]);
      const product=productSnap.exists?productSnap.data():null;
      const masterKind=activeServiceMasterKind(product);
      const kind=indexSnap.exists?indexSnap.data().kind:masterKind;
      if(!indexSnap.exists){
        if(!product||product.active===false||String(product.productType||product.type||'').trim().toUpperCase()!=='SERVICE')
          fail('服務品項產品主檔無效或型別衝突。');
      }
      if(!Object.prototype.hasOwnProperty.call(core.STEPS,kind))fail('正式服務主檔尚未指定四種有效服務類型。');
      assertCaseProduct({productId:item.productId,kind},item);
      const index=await readItemCases(db,tx,orderId,itemId,item,kind,indexSnap);
      const itemWorkflow=serviceItemWorkflow(orderId,order,item,kind,index.cases);
      const itemProgress=itemWorkflow.serviceProgress;
      const forbidden=['cancelled','canceled','void','voided','deleted','closed','已取消','作廢','已結案'];
      // History remains tied to the original index even if the catalogue changes.
      // Only a currently writable master may advertise a new/next operation.
      const open=masterKind===kind&&order.inventoryReservationStatus==='completed'
        &&![order.status,order.orderStatus].some(s=>forbidden.includes(String(s||'').trim().toLowerCase()));
      const cases=index.cases.map(record=>{
        const projection=core.projectServiceCase(record);
        return {...projection,serviceQty:record.serviceQty,
          canAdvance:open&&!!projection.nextEvent&&allowedActor(profile.role,actorUid,order,projection.nextEvent)};
      });
      const items=order.items.filter(i=>String(i.productType||'').trim().toUpperCase()==='SERVICE')
        .map(i=>({itemId:i.itemId,itemName:i.itemName||i.itemCode||'服務品項'}));
      return {orderId,itemId,orderNo:order.orderNo||orderId,customerName:order.customerName||'',items,kind,itemProgress,cases,
        itemWorkCategory:itemWorkflow.workCategory,
        canStart:open&&itemProgress.unassignedQty>0&&index.cases.length<core.MAX_ITEM_CASES
          &&allowedActor(profile.role,actorUid,order,core.STEPS[kind][0])};
    }
    const caseRef=db.collection('serviceCases').doc(caseDocId(orderId,itemId,caseId));
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
    let itemProgress=null,itemWorkCategory=null;
    if(record.serviceQty!==undefined){
      const index=await readItemCases(db,tx,orderId,itemId,matched[0],record.kind);
      if(!index.record.caseIds.includes(caseId))fail('服務案件與數量索引不一致。');
      const itemWorkflow=serviceItemWorkflow(orderId,order,matched[0],record.kind,index.cases);
      itemProgress=itemWorkflow.serviceProgress;itemWorkCategory=itemWorkflow.workCategory;
    }
    return {...projection,exists:true,workStatus:projection.status,
      serviceQty:record.serviceQty??null,itemProgress,itemWorkCategory};
  });
}

// Read all Service lines from one authoritative order snapshot. Explicit action,
// never a table-wide poll. Goods remain outside this completion calculation.
// Bound Firestore reads: up to 30 lines and at most 100 registered cases/order.
async function getServiceOrderProgress(db,actorUid,input){
  if(!db||typeof db.runTransaction!=='function')throw Error('缺少有效資料庫交易。');
  if(!actorUid)fail('未登入使用者。','unauthenticated');
  if(!input||typeof input!=='object'||Array.isArray(input)
    ||Object.keys(input).length!==1||typeof input.orderId!=='string')
    fail('整單服務查核格式不正確。','invalid-argument');
  caseDocId(input.orderId,'validate','validate');
  const orderId=input.orderId;
  return db.runTransaction(async tx=>{
    const [userSnap,orderSnap]=await Promise.all([
      tx.get(db.collection('users').doc(actorUid)),
      tx.get(db.collection('orders').doc(orderId))
    ]);
    const profile=userSnap.exists?userSnap.data():null;
    if(!profile||profile.active===false||profile.disabled===true
      ||!['admin','sales','engineer','warehouse'].includes(profile.role))
      fail('目前使用者沒有查看服務案件的權限。','permission-denied');
    if(!orderSnap.exists)fail('來源訂單不存在。','not-found');
    const order=orderSnap.data();
    if(profile.role==='sales'&&order.ownerUid!==actorUid)
      fail('只有訂單負責業務有權限查看服務案件。','permission-denied');
    return require('./service-order-fulfillment').readOrderFulfillment(db,tx,orderId,order);
  });
}

// Shared transaction reader: callers supply an already-authorized live order.
async function readServiceOrderProgress(db,tx,orderId,order,{serviceOverride}={}){
    const all=order.items;
    if(!Array.isArray(all)||all.length<1||all.length>30)
      fail('訂單品項數量不符合整單查核限制。');
    const serviceItems=all.filter(i=>String(i?.productType||'').trim().toUpperCase()==='SERVICE');
    if(!serviceItems.length)fail('這筆訂單沒有服務品項。');
    const ids=new Set();
    for(const item of serviceItems){
      caseDocId(orderId,item?.itemId,'validate');
      if(ids.has(item.itemId))fail('服務品項識別碼重複。');
      ids.add(item.itemId);
      if(typeof item.productId!=='string'||!item.productId||item.productId.includes('/'))
        fail('服務品項缺少可核對的正式產品主檔。');
    }
    const refs=serviceItems.map(item=>({
      index:db.collection('serviceCases').doc(itemCaseIndexId(orderId,item.itemId)),
      product:db.collection('products').doc(item.productId)
    }));
    const snapshots=await Promise.all(refs.map(async refs=>{
      const [index,product]=await Promise.all([tx.get(refs.index),tx.get(refs.product)]);
      return {index,product};
    }));
    let registered=0;
    for(const {index} of snapshots){
      if(!index.exists)continue;
      const list=index.data()?.caseIds;
      if(!Array.isArray(list)||list.length>core.MAX_ITEM_CASES)
        fail('服務案件索引數量不正確。');
      registered+=list.length;
    }
    if(registered>100)fail('整單服務案件超過單次查核上限，請分品項查詢。');
    const summaries=[];
    for(let i=0;i<serviceItems.length;i++){
      const item=serviceItems[i],snap=snapshots[i];
      const master=snap.product.exists?snap.product.data():null;
      const kind=snap.index.exists?snap.index.data().kind:activeServiceMasterKind(master);
      if(!snap.index.exists&&!activeServiceMasterKind(master))
        fail('正式服務主檔無效或尚未指定服務類型。');
      if(!Object.prototype.hasOwnProperty.call(core.STEPS,kind))
        fail('服務案件索引的服務類型不正確。');
      assertCaseProduct({productId:item.productId,kind},item);
      const index=await readItemCases(db,tx,orderId,item.itemId,item,kind,snap.index);
      const projected=serviceOverride?.itemId===item.itemId?serviceOverride.workflow
        :serviceItemWorkflow(orderId,order,item,kind,index.cases);
      summaries.push({itemId:item.itemId,itemName:item.itemName||item.itemCode||'服務品項',
        serviceKind:kind,workCategory:projected.workCategory,
        orderedQty:projected.serviceProgress.orderedQty,
        allocatedQty:projected.serviceProgress.allocatedQty,
        completedQty:projected.serviceProgress.completedQty,
        outstandingQty:projected.outstandingQty,
        caseCount:index.cases.length});
    }
    const completedQty=summaries.reduce((sum,item)=>sum+item.completedQty,0);
    const orderedQty=summaries.reduce((sum,item)=>sum+item.orderedQty,0);
    return {orderId,orderNo:order.orderNo||orderId,
      serviceItemCount:summaries.length,mixedOrder:serviceItems.length!==all.length,
      billingRecorded:order.isBilled===true,
      serviceCompleted:summaries.every(item=>item.outstandingQty===0),
      orderedQty,completedQty,outstandingQty:Math.max(0,orderedQty-completedQty),
      items:summaries};
}

module.exports={commitServiceCaseEvent,getServiceCaseStatus,getServiceOrderProgress,readServiceOrderProgress,caseDocId,itemCaseIndexId};
