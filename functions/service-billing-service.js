'use strict';
// Isolated pure-Service billing trial. Mixed orders require verified Goods
// delivery evidence and are deliberately outside this writer's contract.
const {createHash}=require('node:crypto');
const {readServiceOrderProgress,caseDocId}=require('./service-case-service');
const workflow=require('./shared/workflow-core');
const {allowServiceCaseEmulator}=require('./service-case-gate');
function fail(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
function billingIntent(data){
  const dateChange=data?.action==='CHANGE_DATE';
  if(!data||typeof data!=='object'||Array.isArray(data)
    ||Object.keys(data).some(k=>!(dateChange
      ? ['orderId','operationId','isBilled','billingDate','expectedIsBilled','action','expectedBillingDate']
      : ['orderId','operationId','isBilled','billingDate','expectedIsBilled']).includes(k)))
    fail('服務核銷請求格式不正確。','invalid-argument');
  caseDocId(data.orderId,'validate','validate');
  if(typeof data.operationId!=='string'||!/^[a-zA-Z0-9_-]{12,96}$/.test(data.operationId)
    ||typeof data.isBilled!=='boolean'||typeof data.expectedIsBilled!=='boolean')
    fail('核銷操作識別碼或狀態不正確。','invalid-argument');
  const date=data.billingDate;
  if(typeof date!=='string'||(data.isBilled
    ? !/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
      ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date
    : date!==''))fail('請選擇正確的核銷日期。','invalid-argument');
  const intent={orderId:data.orderId,operationId:data.operationId,isBilled:data.isBilled,
    billingDate:date,expectedIsBilled:data.expectedIsBilled};
  if(dateChange){
    if(data.isBilled!==true||data.expectedIsBilled!==true
      ||typeof data.expectedBillingDate!=='string'
      ||!/^\d{4}-\d{2}-\d{2}$/.test(data.expectedBillingDate)
      ||!Number.isFinite(Date.parse(data.expectedBillingDate+'T00:00:00Z'))
      ||new Date(data.expectedBillingDate+'T00:00:00Z').toISOString().slice(0,10)!==data.expectedBillingDate)
      fail('核銷日期修改須提供已核銷狀態及原日期。','invalid-argument');
    Object.assign(intent,{action:'CHANGE_DATE',expectedBillingDate:data.expectedBillingDate});
  }
  // Preserve the exact legacy status-operation hash for already-issued receipts.
  return {...intent,hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')};
}
async function commitServiceOrderBilling(db,uid,data){
  if(!allowServiceCaseEmulator()||db.projectId!=='demo-yushin')
    fail('服務核銷僅允許 demo-yushin Auth／Firestore Emulator。');
  if(typeof uid!=='string'||!uid)fail('請先登入。','unauthenticated');
  const intent=billingIntent(data),at=new Date().toISOString();
  const orderRef=db.collection('orders').doc(intent.orderId);
  // Four segments cannot collide with three-segment cases or item-index keys.
  const receiptRef=db.collection('serviceCases').doc(
    ['billing-operation',intent.orderId,intent.operationId,'v1'].map(encodeURIComponent).join('|'));
  return db.runTransaction(async tx=>{
    const [userSnap,orderSnap]=await Promise.all([
      tx.get(db.collection('users').doc(uid)),tx.get(orderRef)
    ]);
    const user=userSnap.exists?userSnap.data():null;
    if(!user||user.active===false||user.disabled===true||!['admin','sales','engineer'].includes(user.role))
      fail('目前使用者沒有服務核銷權限。','permission-denied');
    if(!orderSnap.exists)fail('來源訂單不存在。','not-found');
    const order=orderSnap.data();
    if(user.role!=='admin'&&order.ownerUid!==uid)
      fail('只能核銷自己負責的服務訂單。','permission-denied');
    const receipt=await tx.get(receiptRef);
    if(receipt.exists){
      const saved=receipt.data();
      if(saved.recordType!=='SERVICE_BILLING_OPERATION'||saved.orderId!==intent.orderId
        ||saved.actorUid!==uid||saved.actorRole!==user.role||saved.intentHash!==intent.hash)
        fail('核銷操作識別碼已用於不同意圖。','already-exists');
      // Return the original receipt, never reapply it after a later reversal.
      return {...saved.result,status:'already-applied'};
    }
    if(order.inventoryReservationStatus!=='completed'
      ||[order.status,order.orderStatus].some(s=>['cancelled','canceled','void','voided','deleted','closed','已取消','作廢','已結案'].includes(String(s||'').trim().toLowerCase())))
      fail('訂單已停止履約或尚未完成初始化。');
    if(!Array.isArray(order.items)||!order.items.length
      ||order.items.some(i=>String(i?.productType||'').trim().toUpperCase()!=='SERVICE'))
      fail('此核銷入口僅支援純服務訂單；混合單須另驗商品交付憑證。');
    if(order.isBilled!==undefined&&typeof order.isBilled!=='boolean')fail('原核銷狀態資料不正確。');
    if((order.isBilled===true)!==intent.expectedIsBilled)fail('核銷狀態已變更，請重新讀取後操作。');
    const dateChange=intent.action==='CHANGE_DATE';
    if(dateChange&&order.billingDate!==intent.expectedBillingDate)
      fail('核銷日期已變更，請重新載入後操作。');
    if(intent.isBilled&&(!workflow.canBill(order)))fail('預先交付的商務文件尚未補齊，不能核銷。');
    const progress=await readServiceOrderProgress(db,tx,intent.orderId,{...order,isBilled:intent.isBilled});
    if(intent.isBilled&&!progress.serviceCompleted)fail('服務尚未全數完成，不能核銷。');
    if(order.statusHistory!==undefined&&!Array.isArray(order.statusHistory))fail('核銷歷程資料不正確。');
    const changed=dateChange?order.billingDate!==intent.billingDate:(order.isBilled===true)!==intent.isBilled;
    if(!dateChange&&!changed&&intent.isBilled&&order.billingDate!==intent.billingDate)
      fail('已核銷訂單的日期須使用日期修改作業。');
    const result={orderId:intent.orderId,operationId:intent.operationId,
      isBilled:intent.isBilled,billingDate:changed?(intent.isBilled?intent.billingDate:''):(order.billingDate||''),changed};
    if(dateChange)result.action='CHANGE_DATE';
    if(changed){
      if(dateChange&&order.fieldEditHistory!==undefined&&!Array.isArray(order.fieldEditHistory))
        fail('核銷日期修改歷程資料不正確。');
      const entry={field:'isBilled',value:intent.isBilled,
        label:intent.isBilled?'已核銷':'取消已核銷',by:uid,actorRole:user.role,
        operationId:intent.operationId,at};
      const history=dateChange?{fieldEditHistory:[...(order.fieldEditHistory||[]),{
        field:'billingDate',label:'修改核銷日期',before:order.billingDate,after:result.billingDate,
        by:uid,actorRole:user.role,operationId:intent.operationId,at
      }]}:{statusHistory:[...(order.statusHistory||[]),entry]};
      tx.update(orderRef,{isBilled:result.isBilled,billingDate:result.billingDate,updatedAt:at,...history,
        workCategories:[...new Set(progress.items.map(i=>i.workCategory))],
        workCategoryUpdatedAt:at});
    }
    tx.set(receiptRef,{recordType:'SERVICE_BILLING_OPERATION',orderId:intent.orderId,
      actorUid:uid,actorRole:user.role,intentHash:intent.hash,result,createdAt:at});
    return {...result,status:'committed'};
  });
}
module.exports={commitServiceOrderBilling};
