'use strict';
// Isolated Auth/Firestore adapter around the ONE existing src receiving writer.
const createReceivingService=require('./shared/receiving-runtime');
const stockPermissions=require('./shared/stock-permissions');
const coreNames={YushinInventory:'inventory-core',YushinReservation:'reservation-core',YushinFulfillment:'fulfillment-core',YushinWorkflow:'workflow-core',YushinProcurementDemand:'procurement-demand-core',YushinReceiving:'receiving-core',YushinSupply:'supply-core'};
const cores=Object.fromEntries(Object.entries(coreNames).map(([key,name])=>[key,require('./shared/'+name)]));
cores.YUSHIN_V2_DISPATCH_EMULATOR=true;
cores.crypto=require('node:crypto').webcrypto;
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
function receiptIntent(input){
 if(!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).sort().join(',')!=='expiryDate,lotNo,operationId,qty,supplyId')fail('invalid-argument','收貨欄位不正確');
 for(const key of ['supplyId','operationId'])if(typeof input[key]!=='string'||!input[key]||input[key]!==input[key].trim()||input[key].includes('/')||input[key].length>160)fail('invalid-argument','收貨識別不正確');
 if(!Number.isSafeInteger(input.qty)||input.qty<=0||input.qty>1000000)fail('invalid-argument','收貨數量必須是正整數');
 if(typeof input.lotNo!=='string'||input.lotNo!==input.lotNo.trim()||input.lotNo.length>120||/[\x00-\x1f]/.test(input.lotNo))fail('invalid-argument','批號不正確');
 if(typeof input.expiryDate!=='string'||(input.expiryDate!==''&&(!/^\d{4}-\d{2}-\d{2}$/.test(input.expiryDate)||!Number.isFinite(Date.parse(input.expiryDate+'T00:00:00Z'))||new Date(input.expiryDate+'T00:00:00Z').toISOString().slice(0,10)!==input.expiryDate)))fail('invalid-argument','效期不正確');
 return {...input};
}
async function receiveV2Supply(db,uid,input){
 const intent=receiptIntent(input);
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')fail('failed-precondition','收貨後端僅允許 demo-yushin Emulator');
 if(typeof uid!=='string'||!uid||uid.includes('/'))fail('permission-denied','登入身分不正確');
 const userRef=db.collection('users').doc(uid),profile=await userRef.get();
 const allowed=data=>data&&data.active!==false&&data.disabled!==true&&['admin','purchaser','warehouse'].includes(data.role);
 if(!profile.exists||!allowed(profile.data()))fail('permission-denied','目前沒有收貨權限');
 const role=profile.data().role,actor=String(profile.data().name||uid);
 const runRoleTransaction=callback=>db.runTransaction(async native=>{
  const reads=new Map(),get=reference=>{
   if(!reference.path)return native.get(reference);
   if(!reads.has(reference.path))reads.set(reference.path,native.get(reference));
   return reads.get(reference.path);
  };
  const live=await get(userRef);
  if(!live.exists||!allowed(live.data())||live.data().role!==role)fail('permission-denied','收貨角色已變更或停用');
  const supplyRef=db.collection('supplyOrders').doc(intent.supplyId),supplySnap=await get(supplyRef);
  if(!supplySnap.exists)fail('not-found','找不到供應紀錄');
  const supply=supplySnap.data();
  if(supply.type!=='PURCHASING_PO'||supply.fulfillmentType!=='WAREHOUSE'||!supply.orderId||!supply.itemId)fail('failed-precondition','試點只支援客戶訂單的實體採購收貨');
  const orderSnap=await get(db.collection('orders').doc(supply.orderId));
  const ledger=await get(db.collection('inventoryReservations').doc(supply.orderId+'__'+supply.itemId));
  if(!orderSnap.exists||!ledger.exists||ledger.data().locationSchemaVersion!==2)fail('failed-precondition','來源未完成 v2 預留');
  const order=orderSnap.data();
  // Normal single-line PO. The existing Receiving Service validates every
  // immutable shipment/return proof and current outstanding demand, including
  // receipts after partial fulfillment. Cancelled/multi-line transport stays gated.
  // The existing Service remains authoritative for quantities and all writes.
  const previous=await get(db.collection('receipts').doc(intent.operationId));
  if(previous.exists&&previous.data().reservationLocationSchemaVersion!==2)fail('failed-precondition','原收貨憑證不是 v2 格式');
  if(!previous.exists&&(!Array.isArray(order.items)||order.items.length!==1||order.status!=='active'||order.orderStatus!=='normal'))fail('failed-precondition','收貨登入試點僅支援正常單品項來源；取消與多品項尚未開放');
  const adapter={get,update(reference,data){
   native.update(reference,data);
   if(reference.path===supplyRef.path)native.set(db.collection('receivingSupplyOrders').doc(intent.supplyId),stockPermissions.sanitizeSupply({...supply,...data}));
  },set:(...args)=>native.set(...args)};
  return callback(adapter);
 });
 const runtime=createReceivingService({db,currentUser:{uid},currentUserRole:role,currentUserCode:String(profile.data().code||''),permissionRulesReady:false,cores,
  runRoleTransaction,canConfirmSupplyReceipt:()=>true,deliveryActor:()=>actor,
  localDateString:()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),
  firestoreReadWithTimeout:promise=>promise,
  readQueryInBatches:async query=>{const page=await query.limit(201).get();if(page.size>200)fail('failed-precondition','收貨憑證超過試點安全上限');return page.docs.map(doc=>({id:doc.id,...doc.data()}));},
  brandIdentityForRecord:record=>({brand:record.brand||'',brandId:record.brandId||''})});
 const affectedOrderIds=await runtime.receiveSupplyOrderRecord(intent.supplyId,intent.qty,intent.lotNo,intent.expiryDate,intent.operationId,{actorUid:uid,actorRole:role});
 return {status:'confirmed',supplyId:intent.supplyId,operationId:intent.operationId,affectedOrderIds};
}
module.exports={receiveV2Supply,receiptIntent};
