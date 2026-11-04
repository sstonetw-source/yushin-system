'use strict';
const {createReceiptTransaction}=require('./receipt-transaction');
// Isolated Auth/Firestore adapter around the ONE existing src receiving writer.
const createReceivingService=require('./shared/receiving-runtime');
const stockPermissions=require('./shared/stock-permissions');
const coreNames={YushinInventory:'inventory-core',YushinReservation:'reservation-core',YushinFulfillment:'fulfillment-core',YushinWorkflow:'workflow-core',YushinProcurementDemand:'procurement-demand-core',YushinReceiving:'receiving-core',YushinSupply:'supply-core'};
const cores=Object.fromEntries(Object.entries(coreNames).map(([key,name])=>[key,require('./shared/'+name)]));

const {createHash}=require('node:crypto');
const demandCore=require('./shared/procurement-demand-core');
const {receiptBackendProject}=require('./supply-receipt-gate');
const {validateCanonicalReceiptSource}=require('./canonical-receipt-source');
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
// Direct-stock PO is an independently authorised procurement source, not a
// fabricated sales order. Verify the original confirmed PO, its immutable
// incoming receipt, supply and demand before the shared receipt writer runs.
async function verifyDirectStockReceipt(get,db,supply,supplyId){
 const reject=()=>fail('failed-precondition','直接採購缺少一致的正式採購、在途或需求憑證');
 const poNo=supply.purchaseDocumentId;
 if(typeof poNo!=='string'||!poNo||poNo.includes('/')||!Number.isSafeInteger(supply.qty)||supply.qty<=0
  ||!Number.isSafeInteger(supply.receivedQty)||supply.receivedQty<0||supply.receivedQty>supply.qty
  ||!Number.isSafeInteger(supply.incomingRegisteredQty)||supply.incomingRegisteredQty!==supply.qty-supply.receivedQty)
  reject();
 const poSnap=await get(db.collection('purchaseOrders').doc(poNo)),po=poSnap.exists?poSnap.data():null;
 const links=po?.supplyOrderIds,index=Array.isArray(links)?links.indexOf(supplyId):-1;
 const line=Array.isArray(po?.items)?po.items[index]:null;
 const sourceId='MANUAL_PO:'+poNo+':'+index;
 const demandId=demandCore.demandIdForSource({sourceType:'STOCK_REPLENISHMENT',sourceId});
 if(!po||po.poNo!==poNo||po.purchaseType!=='stock'||po.status!=='ORDERED'||po.documentOnly!==false
  ||!po.serverCommitHash||!Array.isArray(links)||links.length<1||links.length>5
  ||index<0||links.filter(id=>id===supplyId).length!==1
  ||supplyId!=='po-'+encodeURIComponent(poNo)+'-'+index||!line
  ||line.sourceType!=='STOCK_REPLENISHMENT'||line.orderId||line.itemId
  ||line.productId!==supply.productId||line.warehouseId!==supply.warehouseId
  ||(line.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
  ||line.qty!==supply.qty||line.unitPrice!==supply.unitCost
  ||supply.type!=='PURCHASING_PO'||supply.sourceType!=='STOCK_REPLENISHMENT'
  ||supply.method!=='PURCHASING_PO'||supply.sourceId!==sourceId||supply.sourceItemId!==''
  ||supply.demandId!==demandId||supply.productKey!==supply.productId
  ||supply.orderId||supply.itemId||supply.fulfillmentType!=='WAREHOUSE')reject();
 const [demandSnap,incomingSnap,movementSnap,productSnap,warehouseSnap]=await Promise.all([
  get(db.collection('procurementDemands').doc(encodeURIComponent(demandId))),
  get(db.collection('reservationOperationReceipts').doc('po-incoming-'+encodeURIComponent(poNo))),
  get(db.collection('inventoryMovements').doc('po-incoming-'+encodeURIComponent(poNo)+'-'+encodeURIComponent(supplyId))),
  get(db.collection('products').doc(supply.productId)),get(db.collection('warehouses').doc(supply.warehouseId))
 ]);
 const demand=demandSnap.exists?demandSnap.data():null,
  incoming=incomingSnap.exists?incomingSnap.data():null,
  movement=movementSnap.exists?movementSnap.data():null;
 if(!demand||demand.demandId!==demandId||demand.sourceType!=='STOCK_REPLENISHMENT'
  ||demand.sourceId!==sourceId||demand.sourceItemId!==''||demand.productId!==supply.productId
  ||demand.productKey!==supply.productKey||demand.warehouseId!==supply.warehouseId
  ||demand.orderedQty!==supply.qty||demand.receivedQty!==supply.receivedQty
  ||!incoming||incoming.action!=='FORMAL_PO_INCOMING'||incoming.poNo!==poNo
  ||!Array.isArray(incoming.result?.supplyOrderIds)||!incoming.result.supplyOrderIds.includes(supplyId)
  ||!movement||movement.type!=='purchase_incoming'||movement.qty!==supply.qty
  ||movement.sourceType!=='SUPPLY_ORDER'||movement.sourceId!==supplyId
  ||movement.productKey!==supply.productKey||movement.warehouseId!==supply.warehouseId
  ||movement.purchaseDocumentId!==poNo||!productSnap.exists||productSnap.data().active===false
  ||String(productSnap.data().productType||productSnap.data().type||'').toUpperCase()==='SERVICE'
  ||!warehouseSnap.exists||warehouseSnap.data().active===false||warehouseSnap.data().systemCustody===true)
  reject();
}
cores.YUSHIN_V2_DISPATCH_EMULATOR=true;
cores.crypto=require('node:crypto').webcrypto;
function fail(code,message){const error=new Error(message);error.code=code;throw error;}
// The canonical order writer uses status=active and need not persist the
// redundant legacy orderStatus. Missing/blank is normal; explicit terminal,
// unknown or malformed legacy states must still fail closed.
function normalReceiptOrder(order){
 return order?.status==='active'&&[undefined,'','normal'].includes(order.orderStatus);
}
function receiptIntentHash(intent){
 return createHash('sha256').update(JSON.stringify([intent.supplyId,intent.operationId,intent.qty,intent.lotNo,intent.expiryDate])).digest('hex');
}
function receiptIntent(input){
 if(!input||typeof input!=='object'||Array.isArray(input)
  ||Object.keys(input).sort().join(',')!=='expiryDate,lotNo,operationId,qty,supplyId')fail('invalid-argument','收貨欄位不正確');
 for(const key of ['supplyId','operationId'])if(typeof input[key]!=='string'||!input[key]||input[key]!==input[key].trim()||input[key].includes('/')||input[key].length>160)fail('invalid-argument','收貨識別不正確');
 if(!Number.isSafeInteger(input.qty)||input.qty<=0||input.qty>1000000)fail('invalid-argument','收貨數量必須是正整數');
 if(typeof input.lotNo!=='string'||input.lotNo!==input.lotNo.trim()||input.lotNo.length>120||/[\x00-\x1f]/.test(input.lotNo))fail('invalid-argument','批號不正確');
 if(typeof input.expiryDate!=='string'||(input.expiryDate!==''&&(!/^\d{4}-\d{2}-\d{2}$/.test(input.expiryDate)||!Number.isFinite(Date.parse(input.expiryDate+'T00:00:00Z'))||new Date(input.expiryDate+'T00:00:00Z').toISOString().slice(0,10)!==input.expiryDate)))fail('invalid-argument','效期不正確');
 return {...input};
}
async function receiveV2Supply(db,uid,input,env=process.env){
 const intent=receiptIntent(input);
 const project=receiptBackendProject(env);
 if(!project||db.projectId!==project)
  fail('failed-precondition','收貨後端尚未在此授權專案啟用');
 if(typeof uid!=='string'||!uid||uid.includes('/'))fail('permission-denied','登入身分不正確');
 const userRef=db.collection('users').doc(uid),profile=await userRef.get();
 const allowed=data=>data&&data.active!==false&&data.disabled!==true&&['admin','purchaser','warehouse','sales','engineer'].includes(data.role);
 if(!profile.exists||!allowed(profile.data()))fail('permission-denied','目前沒有收貨權限');
 const role=profile.data().role,actor=String(profile.data().name||uid);
 const runRoleTransaction=callback=>db.runTransaction(async native=>{
  const staged=createReceiptTransaction(native),get=staged.get;
  const live=await get(userRef);
  if(!live.exists||!allowed(live.data())||live.data().role!==role)fail('permission-denied','收貨角色已變更或停用');
  const supplyRef=db.collection('supplyOrders').doc(intent.supplyId),supplySnap=await get(supplyRef);
  if(!supplySnap.exists)fail('not-found','找不到供應紀錄');
  const supply=supplySnap.data();
  const directShip=supply.fulfillmentType==='DIRECT_SHIP';
  const directStock=supply.type==='PURCHASING_PO'&&supply.sourceType==='STOCK_REPLENISHMENT'
   &&!supply.orderId&&!supply.itemId&&supply.fulfillmentType==='WAREHOUSE';
  if(!['PURCHASING_PO','PURCHASING_MANUAL'].includes(supply.type)||!['WAREHOUSE','DIRECT_SHIP'].includes(supply.fulfillmentType)
    ||(!directStock&&(!supply.orderId||!supply.itemId)))
   fail('failed-precondition','只支援來源完整的客戶訂單或直接備庫採購');
  if(directShip&&(intent.lotNo||intent.expiryDate||Number(supply.incomingRegisteredQty||0)!==0))
   fail('failed-precondition','原廠直送不得登記倉庫在途、批號或效期');
  const orderSnap=directStock?null:await get(db.collection('orders').doc(supply.orderId));
  if(!directStock&&!orderSnap.exists)fail('failed-precondition','找不到來源訂單');
  const order=orderSnap?.exists?orderSnap.data():null;
  const previous=await get(db.collection('receipts').doc(intent.operationId));
  let reservationSchema=0;
  if(directStock){
   if(!['admin','purchaser','warehouse'].includes(role))fail('permission-denied','目前沒有直接採購入庫權限');
   await verifyDirectStockReceipt(get,db,supply,intent.supplyId);
  }
  if(supply.type==='PURCHASING_MANUAL')
   await verifyQuickPurchaseReceipt(get,db,supply,order,intent.supplyId);
  if(directShip){
   if(role!=='admin'&&(!['sales','engineer'].includes(role)||order.ownerUid!==uid
      ||supply.ownerUid!==uid))fail('permission-denied','僅原負責業務可確認直送到貨');
  }else if(!directStock){
   if(!['admin','purchaser','warehouse'].includes(role))fail('permission-denied','目前沒有實體入庫權限');
   const ledger=await get(db.collection('inventoryReservations').doc(supply.orderId+'__'+supply.itemId));
   if(!ledger.exists)fail('failed-precondition','來源缺少權威預留');
   reservationSchema=ledger.data().locationSchemaVersion===2?2:1;
   if(reservationSchema===1){
    const receiptOperationRef=db.collection('reservationOperationReceipts')
     .doc('canonical-receipt-'+createHash('sha256').update(intent.operationId).digest('hex'));
    const operationSnap=await get(receiptOperationRef),operation=operationSnap.exists?operationSnap.data():null;
    const hash=receiptIntentHash(intent);
    if(previous.exists){
     const proof=previous.data();
     if(!operation||operation.action!=='CANONICAL_SUPPLY_RECEIPT'||operation.intentHash!==hash
       ||operation.actorUid!==uid||operation.actorRole!==role||operation.receiptId!==intent.operationId
       ||operation.supplyId!==intent.supplyId||operation.productKey!==proof.productKey
       ||operation.warehouseId!==proof.warehouseId||operation.lotId!==proof.lotId)
      fail('failed-precondition','單倉收貨缺少一致的後端操作憑證，請保留原操作查核');
    }else if(operation)fail('failed-precondition','單倉收貨操作憑證與收貨結果不一致');
    await validateCanonicalReceiptSource({get,db,uid,actor:live.data(),order,supply,reservation:ledger.data(),
     qty:intent.qty,replay:previous.exists});
    if(!previous.exists&&supply.type==='PURCHASING_PO')
     await runtime.validateReceiptPurchaseDocument({get},{...supply,id:intent.supplyId},{orderId:supply.orderId,itemId:supply.itemId,
      productId:supply.productId,warehouseId:supply.warehouseId,fulfillmentType:'WAREHOUSE'});
   }
  }
  // V2 warehouse sources: 1–15. Canonical per-item single-warehouse sources
  // have the stricter 1–5 initial-stage guard above; direct shipping stays 1–5.
  // The existing Receiving Service validates every
  // immutable shipment/return proof and current outstanding demand, including
  // sibling reservation and receipts after partial fulfillment. Cancellation stays gated.
  // The existing Service remains authoritative for quantities and all writes.
  if(previous.exists&&!directShip&&!directStock&&previous.data().reservationLocationSchemaVersion!==reservationSchema)
   fail('failed-precondition','原收貨憑證與預留格式不一致');
  if(!previous.exists&&!directStock&&(!Array.isArray(order.items)||order.items.length<1||order.items.length>(directShip?5:15)||!normalReceiptOrder(order)))
   fail('failed-precondition',`收貨登入試點僅支援正常 1–${directShip?5:15} 品項來源；取消尚未開放`);
  if(!previous.exists&&directShip&&supply.type==='PURCHASING_PO'){
   const selected=order.items.filter(row=>row?.itemId===supply.itemId);
   if(selected.length!==1||supply.warehouseId||selected[0].warehouseId)
    fail('failed-precondition','直送來源品項或倉庫資料不一致');
   await runtime.validateReceiptPurchaseDocument({get},{...supply,id:intent.supplyId},{orderId:supply.orderId,itemId:supply.itemId,
    productId:selected[0].productId,warehouseId:'',fulfillmentType:'DIRECT_SHIP'});
  }
  const orderPatches=[];
  const adapter={get,update(reference,data){
   staged.update(reference,data);
   if(reference.path===supplyRef.path)staged.set(db.collection('receivingSupplyOrders').doc(intent.supplyId),stockPermissions.sanitizeSupply({...supply,...data}));
   if(reference.path==='orders/'+supply.orderId)orderPatches.push(data);
  },set(reference,data,...options){
   if(reference.path==='receipts/'+intent.operationId&&!directShip&&reservationSchema===1){
    data={...data,reservationLocationSchemaVersion:1};
    // The existing callable-only checkpoint collection cannot be forged by a
    // stale client writer. It commits atomically with the original receipt.
    staged.set(db.collection('reservationOperationReceipts').doc('canonical-receipt-'+createHash('sha256').update(intent.operationId).digest('hex')),
     {action:'CANONICAL_SUPPLY_RECEIPT',receiptId:intent.operationId,supplyId:intent.supplyId,
      actorUid:uid,actorRole:role,intentHash:receiptIntentHash(intent),
      productKey:data.productKey,warehouseId:data.warehouseId,lotId:data.lotId});
   }
   staged.set(reference,data,...options);
  }};
  const result=await callback(adapter);
  if(orderPatches.length&&order?.items?.some(item=>String(item.productType||'').trim().toUpperCase()==='SERVICE')){
   const next=Object.assign({},order,...orderPatches);
   const index=await require('./service-order-fulfillment').mixedWorkIndex(db,{get},supply.orderId,next,{proofOrder:order});
   staged.update(db.collection('orders').doc(supply.orderId),index);
  }
  staged.flush();
  return result;
 });
 const runtime=createReceivingService({db,currentUser:{uid},currentUserRole:role,currentUserCode:String(profile.data().code||''),permissionRulesReady:false,cores,receivingSourceItemLimit:15,
  authorizeV2ReceiptActor:()=>receiptBackendProject(env)===db.projectId,
  runRoleTransaction,canConfirmSupplyReceipt:()=>true,deliveryActor:()=>actor,
  localDateString:()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),
  firestoreReadWithTimeout:promise=>promise,
  readQueryInBatches:async query=>{const page=await query.limit(201).get();if(page.size>200)fail('failed-precondition','收貨憑證超過試點安全上限');return page.docs.map(doc=>({id:doc.id,...doc.data()}));},
  brandIdentityForRecord:record=>({brand:record.brand||'',brandId:record.brandId||''})});
 const affectedOrderIds=await runtime.receiveSupplyOrderRecord(intent.supplyId,intent.qty,intent.lotNo,intent.expiryDate,intent.operationId,{actorUid:uid,actorRole:role});
 return {status:'confirmed',supplyId:intent.supplyId,operationId:intent.operationId,affectedOrderIds};
}
module.exports={receiveV2Supply,receiptIntent,normalReceiptOrder};
