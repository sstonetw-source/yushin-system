'use strict';
// Isolated Auth/Firestore adapter around the ONE existing src receiving writer.
const createReceivingService=require('./shared/receiving-runtime');
const stockPermissions=require('./shared/stock-permissions');
const coreNames={YushinInventory:'inventory-core',YushinReservation:'reservation-core',YushinFulfillment:'fulfillment-core',YushinWorkflow:'workflow-core',YushinProcurementDemand:'procurement-demand-core',YushinReceiving:'receiving-core',YushinSupply:'supply-core'};
const cores=Object.fromEntries(Object.entries(coreNames).map(([key,name])=>[key,require('./shared/'+name)]));

const {createHash}=require('node:crypto');
const demandCore=require('./shared/procurement-demand-core');
// Quick Purchase uses the same Receiving writer as formal PO, but has a
// different immutable purchase witness. Verify the existing single-writer
// operation and incoming debit before permitting any receipt-side mutation.
async function verifyQuickPurchaseReceipt(get,db,supply,order,supplyId){
 const reject=()=>fail('failed-precondition','手動採購缺少一致的權威操作／在途憑證');
 const directShip=supply.fulfillmentType==='DIRECT_SHIP';
 const item=Array.isArray(order.items)?order.items.filter(row=>row?.itemId===supply.itemId):[];
 const events=supply.orderEvents;
 const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:supply.orderId,sourceItemId:supply.itemId});
 if(supply.type!=='PURCHASING_MANUAL'||supply.method!=='PURCHASING_MANUAL'
  ||supply.sourceType!=='SALES_ORDER'||supply.sourceId!==supply.orderId
  ||supply.sourceItemId!==supply.itemId||supply.demandId!==demandId
  ||!Array.isArray(events)||!events.length||events.length>50||item.length!==1
  ||!Array.isArray(item[0].orderEvents)||!Array.isArray(item[0].manualOrderNos)
  ||!item[0].manualOrderNos.includes(supply.internalNo)
  ||!Number.isSafeInteger(supply.qty)||supply.qty<=0
  ||!Number.isSafeInteger(item[0].supplyOrderedQty)||item[0].supplyOrderedQty<supply.qty)
  reject();
 const seen=new Set();let total=0;
 for(const event of events){
  if(!event||typeof event.operationId!=='string'
   ||!/^[A-Za-z0-9_-]{8,80}$/.test(event.operationId)||seen.has(event.operationId)
   ||!Number.isSafeInteger(event.qty)||event.qty<=0
   ||event.supplier!==supply.supplier||event.unitCost!==supply.unitCost
   ||typeof event.createdByUid!=='string'||!event.createdByUid)reject();
  seen.add(event.operationId);total+=event.qty;
  const key='quick-'+event.operationId;
  const operation=await get(db.collection('purchaseOperations').doc(key));
  const intent={operationId:event.operationId,orderId:supply.orderId,itemId:supply.itemId,
   qty:event.qty,supplier:event.supplier,unitCost:event.unitCost};
  const hash=createHash('sha256').update(JSON.stringify(intent)).digest('hex');
  const op=operation.exists?operation.data():null;
  if(!op||op.type!=='PURCHASING_MANUAL'||op.operationId!==event.operationId
   ||op.uid!==event.createdByUid||op.hash!==hash||op.supplyId!==supplyId
   ||op.demandId!==demandId||op.orderId!==supply.orderId||op.itemId!==supply.itemId
   ||op.qty!==event.qty||op.movementId!==(directShip?'':key))reject();
  const sourceEvents=item[0].orderEvents.filter(row=>row?.id===key);
  if(sourceEvents.length!==1||sourceEvents[0].type!=='PURCHASING_MANUAL'
   ||sourceEvents[0].qty!==event.qty||sourceEvents[0].documentNo!==supply.internalNo)reject();
  if(!directShip){
   const movement=await get(db.collection('inventoryMovements').doc(key));
   const m=movement.exists?movement.data():null;
   if(!m||m.type!=='purchase_incoming'||m.qty!==event.qty
    ||m.sourceType!=='SUPPLY_ORDER'||m.sourceId!==supplyId
    ||m.productKey!==supply.productKey||m.productId!==supply.productId
    ||m.warehouseId!==supply.warehouseId||m.actorUid!==event.createdByUid
    ||m.purchaseDocumentId!==supply.internalNo)reject();
  }
 }
 if(total!==supply.qty||!Number.isSafeInteger(total)
  ||(directShip?Number(supply.incomingRegisteredQty||0)!==0:
   Number(supply.incomingRegisteredQty)!==supply.qty-Number(supply.receivedQty||0)))reject();
}
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
 const allowed=data=>data&&data.active!==false&&data.disabled!==true&&['admin','purchaser','warehouse','sales','engineer'].includes(data.role);
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
  const directShip=supply.fulfillmentType==='DIRECT_SHIP';
  if(!['PURCHASING_PO','PURCHASING_MANUAL'].includes(supply.type)||!['WAREHOUSE','DIRECT_SHIP'].includes(supply.fulfillmentType)
    ||!supply.orderId||!supply.itemId)fail('failed-precondition','試點只支援客戶訂單的實體採購／原廠直送');
  if(directShip&&(intent.lotNo||intent.expiryDate||Number(supply.incomingRegisteredQty||0)!==0))
   fail('failed-precondition','原廠直送不得登記倉庫在途、批號或效期');
  const orderSnap=await get(db.collection('orders').doc(supply.orderId));
  if(!orderSnap.exists)fail('failed-precondition','找不到來源訂單');
  const order=orderSnap.data();
  if(supply.type==='PURCHASING_MANUAL')
   await verifyQuickPurchaseReceipt(get,db,supply,order,intent.supplyId);
  if(directShip){
   if(role!=='admin'&&(!['sales','engineer'].includes(role)||order.ownerUid!==uid
      ||supply.ownerUid!==uid))fail('permission-denied','僅原負責業務可確認直送到貨');
  }else{
   if(!['admin','purchaser','warehouse'].includes(role))fail('permission-denied','目前沒有實體入庫權限');
   const ledger=await get(db.collection('inventoryReservations').doc(supply.orderId+'__'+supply.itemId));
   if(!ledger.exists||ledger.data().locationSchemaVersion!==2)fail('failed-precondition','來源未完成 v2 預留');
  }
  // Normal 1–5-item source. The existing Receiving Service validates every
  // immutable shipment/return proof and current outstanding demand, including
  // sibling reservation and receipts after partial fulfillment. Cancellation stays gated.
  // The existing Service remains authoritative for quantities and all writes.
  const previous=await get(db.collection('receipts').doc(intent.operationId));
  if(previous.exists&&!directShip&&previous.data().reservationLocationSchemaVersion!==2)
   fail('failed-precondition','原收貨憑證不是 v2 格式');
  if(!previous.exists&&(!Array.isArray(order.items)||order.items.length<1||order.items.length>5||order.status!=='active'||order.orderStatus!=='normal'))
   fail('failed-precondition','收貨登入試點僅支援正常 1–5 品項來源；取消尚未開放');
  const pending=[],orderPatches=[];
  const adapter={get,update(reference,data){
   pending.push(()=>native.update(reference,data));
   if(reference.path===supplyRef.path)pending.push(()=>native.set(db.collection('receivingSupplyOrders').doc(intent.supplyId),stockPermissions.sanitizeSupply({...supply,...data})));
   if(reference.path==='orders/'+supply.orderId)orderPatches.push(data);
  },set:(...args)=>pending.push(()=>native.set(...args))};
  const result=await callback(adapter);
  if(orderPatches.length&&order.items?.some(item=>String(item.productType||'').trim().toUpperCase()==='SERVICE')){
   const next=Object.assign({},order,...orderPatches);
   const index=await require('./service-order-fulfillment').mixedWorkIndex(db,{get},supply.orderId,next,{proofOrder:order});
   pending.push(()=>native.update(db.collection('orders').doc(supply.orderId),index));
  }
  pending.forEach(write=>write());
  return result;
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
