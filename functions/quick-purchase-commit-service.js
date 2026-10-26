'use strict';
// Emulator-only migration candidate for the existing manual Quick Purchase.
// No client Rules bypass is used in production. All authority is rechecked
// inside one server Firestore transaction, reusing the formal PO demand guard.
const {createHash}=require('node:crypto');
const demandCore=require('./shared/procurement-demand-core');
const receiving=require('./shared/receiving-core');
const {sanitizeSupply}=require('./shared/stock-permissions');
const {validateV2FormalPurchaseTx}=require('./formal-purchase-preview-service');
function fail(code,message){const e=new Error(message);e.code=code;throw e;}
function integer(value,label,max=1000000){
 if(!Number.isSafeInteger(value)||value<=0||value>max)fail('invalid-argument',label+'須為有效正整數');
 return value;
}
function ident(value,label,max=160){
 if(typeof value!=='string'||!value||value.trim()!==value||value.length>max
   ||value.includes('/')||/[\x00-\x1f]/.test(value))
  fail('invalid-argument',label+'不正確');
 return value;
}
function purchaseIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data)
   ||Object.keys(data).sort().join(',')!=='itemId,operationId,orderId,qty,supplier,unitCost')
  fail('invalid-argument','手動採購輸入欄位不正確');
 const operationId=ident(data.operationId,'操作識別',80);
 if(!/^[A-Za-z0-9_-]{8,80}$/.test(operationId))fail('invalid-argument','操作識別格式不正確');
 const supplier=ident(data.supplier,'供應商',200);
 if(typeof data.unitCost!=='number'||!Number.isFinite(data.unitCost)||data.unitCost<0
   ||data.unitCost>100000000||Math.abs(Math.round(data.unitCost*100)-data.unitCost*100)>1e-6)
  fail('invalid-argument','單位成本必須為最多兩位小數的非負數');
 return {operationId,orderId:ident(data.orderId,'來源訂單'),itemId:ident(data.itemId,'來源品項'),
  qty:integer(data.qty,'採購數量'),supplier,unitCost:data.unitCost};
}
function todayTaipei(date=new Date()){
 const parts=new Intl.DateTimeFormat('en-US',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date);
 const part=type=>parts.find(p=>p.type===type).value;
 return part('year')+'-'+part('month')+'-'+part('day');
}
function number(value,label){
 if(!Number.isSafeInteger(value)||value<0)fail('failed-precondition',label+'數量不一致');
 return value;
}
function fingerprint(intent){return createHash('sha256').update(JSON.stringify(intent)).digest('hex');}
async function commitV2QuickPurchase(db,uid,data){
 const intent=purchaseIntent(data),hash=fingerprint(intent),now=new Date().toISOString(),date=todayTaipei();
 const ref=(collection,id)=>db.collection(collection).doc(id);
 const supplyId='manual-'+encodeURIComponent(intent.orderId)+'-'+encodeURIComponent(intent.itemId);
 const supplyRef=ref('supplyOrders',supplyId),opRef=ref('purchaseOperations','quick-'+intent.operationId);
 const movementRef=ref('inventoryMovements','quick-'+intent.operationId);
 const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:intent.orderId,sourceItemId:intent.itemId});
 return db.runTransaction(async tx=>{
  // Never trust the UI role or an earlier preflight; verify the actor on
  // retries as well as on new writes.
  const user=await tx.get(ref('users',uid));
  if(!user.exists||user.data().active===false||user.data().disabled===true
    ||!['admin','purchaser'].includes(user.data().role))
   fail('permission-denied','登入使用者沒有採購權限');
  const op=await tx.get(opRef);
  if(op.exists){
   const saved=op.data();
   if(saved.hash!==hash||saved.uid!==uid||saved.supplyId!==supplyId)
    fail('already-exists','操作識別已用於其他採購');
   const original=await tx.get(supplyRef);
   if(!original.exists||!Array.isArray(original.data().orderEvents)
     ||!original.data().orderEvents.some(e=>e.operationId===intent.operationId
       &&e.createdByUid===uid&&e.qty===intent.qty
       &&e.supplier===intent.supplier&&e.unitCost===intent.unitCost))
    fail('failed-precondition','重送採購的權威供應憑證不一致');
   // A saved operation is not proof that the source and incoming ledger agree.
   // Recheck immutable evidence before acknowledging a lost Callable reply.
   const supply=original.data(),directShip=supply.fulfillmentType==='DIRECT_SHIP';
   if(saved.type!=='PURCHASING_MANUAL'||saved.operationId!==intent.operationId
     ||saved.orderId!==intent.orderId||saved.itemId!==intent.itemId
     ||saved.qty!==intent.qty||saved.demandId!==demandId
     ||saved.movementId!==(directShip?'':movementRef.id))
    fail('failed-precondition','重送採購的操作憑證不一致');
   const source=await tx.get(ref('orders',intent.orderId));
   const sourceData=source.exists?source.data():null;
   const item=sourceData&&Array.isArray(sourceData.items)
     ?sourceData.items.find(row=>row.itemId===intent.itemId):null;
   // The source and supply identities are immutable purchase evidence.
   // A matching operation ID alone must not acknowledge a corrupted link.
   if(!item||supply.type!=='PURCHASING_MANUAL'||supply.sourceType!=='SALES_ORDER'
     ||supply.sourceId!==intent.orderId||supply.sourceItemId!==intent.itemId
     ||supply.orderId!==intent.orderId||supply.itemId!==intent.itemId
     ||supply.demandId!==demandId||supply.productId!==item.productId
     ||supply.productKey!==String(item.inventoryProductKey||item.productId)
     ||supply.ownerUid!==sourceData.ownerUid||supply.salesCode!==sourceData.salesCode
     ||!Array.isArray(item.orderEvents)
     ||!item.orderEvents.some(e=>e.id==='quick-'+intent.operationId
       &&e.type==='PURCHASING_MANUAL'&&e.qty===intent.qty))
    fail('failed-precondition','重送採購的來源訂單憑證不一致');
   // An operation checkpoint cannot acknowledge a purchase whose authoritative
   // Demand has been deleted or relinked after the original atomic commit.
   // Check immutable identity only: later valid receipts/cancellations may
   // legitimately change demand quantities and status.
   const demandProof=await tx.get(ref('procurementDemands',encodeURIComponent(demandId)));
   const demandData=demandProof.exists?demandProof.data():null;
   if(!demandData||demandData.demandId!==demandId
     ||demandData.sourceType!=='SALES_ORDER'
     ||demandData.sourceId!==intent.orderId||demandData.sourceItemId!==intent.itemId
     ||demandData.productId!==supply.productId||demandData.productKey!==supply.productKey
     ||demandData.ownerUid!==sourceData.ownerUid||demandData.salesCode!==sourceData.salesCode)
    fail('failed-precondition','重送採購的權威需求憑證不一致');
   if(!directShip){
    const movement=await tx.get(movementRef),ledger=movement.exists?movement.data():null;
    if(!ledger||ledger.type!=='purchase_incoming'||ledger.qty!==intent.qty
      ||ledger.sourceType!=='SUPPLY_ORDER'||ledger.sourceId!==supplyId
      ||ledger.productKey!==supply.productKey||ledger.productId!==supply.productId
      ||ledger.warehouseId!==supply.warehouseId||ledger.actorUid!==uid
      ||ledger.purchaseDocumentId!==supply.internalNo)
     fail('failed-precondition','重送採購的在途扣帳憑證不一致');
   }
   return {status:'already-applied',operationId:intent.operationId,supplyId,
    demandId,committedQty:intent.qty};
  }
  // Use the existing formal PO admission as the ONE source of role, source,
  // warehouse and demand validations. The synthetic PO key is never written.
  const details=await validateV2FormalPurchaseTx(tx,db,uid,{
   poNo:'QP-'+intent.operationId,orderId:intent.orderId,itemId:intent.itemId,qty:intent.qty
  });
  const {source,sourceItem,sourceItemIndex,demandBefore,demandAfter,plan}=details;
  // Preserve the existing Quick Purchase boundary: sales-self-order lines
  // cannot become purchaser commitments through the privileged callable.
  if((sourceItem.procurementType||source.procurementType||'PURCHASING_PO')==='SALES_SELF_ORDER')
   fail('failed-precondition','此品項為業務自行訂貨，不能執行手動採購');
  if(source.items.some(i=>String(i.productType||i.type||'').toUpperCase()==='SERVICE'))
   fail('failed-precondition','混合服務訂單不在手動採購試點範圍');
  const prior=await tx.get(supplyRef),old=prior.exists?prior.data():null;
  const productKey=String(sourceItem.inventoryProductKey||sourceItem.productId);
  const fulfillmentType=sourceItem.fulfillmentType||'WAREHOUSE';
  const directShip=fulfillmentType==='DIRECT_SHIP';
  const warehouseId=plan.warehouseId;
  if(old&&(old.type!=='PURCHASING_MANUAL'||old.sourceType!=='SALES_ORDER'
    ||old.orderId!==intent.orderId||old.itemId!==intent.itemId
    ||old.sourceId!==intent.orderId||old.sourceItemId!==intent.itemId
    ||old.demandId!==demandId||old.orderItemIndex!==sourceItemIndex||old.productKey!==productKey
    ||old.productId!==sourceItem.productId||old.ownerUid!==source.ownerUid
    ||old.salesCode!==source.salesCode||old.fulfillmentType!==fulfillmentType
    ||old.warehouseId!==warehouseId||old.supplier!==intent.supplier
    ||old.unitCost!==intent.unitCost||['CANCELLED','CLOSED'].includes(old.status)))
   fail('failed-precondition','既有供應紀錄不允許追加採購');
  const previousQty=old?number(old.qty,'原採購'):0;
  const received=old?number(old.receivedQty,'原已收貨'):0;
  const registered=old?number(old.incomingRegisteredQty,'原在途'):0;
  if(received>previousQty||previousQty+intent.qty>1000000)
   fail('failed-precondition','供應數量異常');
  const previousPending=previousQty-received;
  if(registered!==(directShip?0:previousPending))
   fail('failed-precondition','原在途數量未同步，禁止追加採購');
  const nextQty=previousQty+intent.qty;
  const priorMovement=await tx.get(movementRef);
  if(priorMovement.exists)fail('already-exists','庫存異動識別已存在');
  let inventoryRef=null,warehouseRef=null,inventory=null,warehouse=null;
  if(!directShip){
   inventoryRef=ref('inventory',encodeURIComponent(productKey));
   warehouseRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
   inventory=await tx.get(inventoryRef);
   warehouse=await tx.get(warehouseRef);
   // Fail closed on absent or mismatched stock. Stock creation is a separate
   // acceptance case; do not manufacture a second stock identity here.
   if(!inventory.exists||!warehouse.exists
     ||inventory.data().productId!==sourceItem.productId
     ||inventory.data().productKey!==productKey
     ||warehouse.data().productId!==sourceItem.productId
     ||warehouse.data().productKey!==productKey
     ||warehouse.data().warehouseId!==warehouseId)
    fail('failed-precondition','入庫倉庫或產品庫存尚未完成初始化');
   for(const snap of [inventory,warehouse]){
    for(const key of ['onHand','reserved','incoming'])number(snap.data()[key],key);
    if(snap.data().incoming+intent.qty>1000000000)
     fail('failed-precondition','在途數量超過上限');
   }
  }
  const actorName=String(user.data().name||'');
  const internalNo=old?.internalNo||'MO-'+date.replace(/-/g,'')+'-'+supplyId.slice(-8).toUpperCase();
  const supplyEvent={operationId:intent.operationId,qty:intent.qty,supplier:intent.supplier,
   unitCost:intent.unitCost,orderDate:date,createdAt:now,createdByUid:uid,createdBy:actorName};
  const supply={
   ...(old||{}),type:'PURCHASING_MANUAL',method:'PURCHASING_MANUAL',
   sourceType:'SALES_ORDER',sourceId:intent.orderId,sourceItemId:intent.itemId,
   demandId,internalNo,orderId:intent.orderId,itemId:intent.itemId,
   orderItemIndex:sourceItemIndex,ownerUid:source.ownerUid,salesCode:source.salesCode,
   salesName:source.salesName||'',customerName:source.customerName||'',company:source.company||'',
   productId:sourceItem.productId,productKey,itemCode:sourceItem.itemCode||'',
   itemName:sourceItem.itemName||'',brand:sourceItem.brand||'',brandId:sourceItem.brandId||'',
   productLine:sourceItem.productLine||'',qty:nextQty,receivedQty:received,
   incomingRegisteredQty:directShip?0:previousPending+intent.qty,
   incomingRegisteredAt:directShip?(old?.incomingRegisteredAt||''):now,
   supplier:intent.supplier,unitCost:intent.unitCost,
   orderDate:old?.orderDate||date,lastOrderedAt:date,
   orderEvents:[...(old?.orderEvents||[]),supplyEvent],
   fulfillmentType,warehouseId,
   createdAt:old?.createdAt||now,updatedAt:now,
   createdByUid:old?.createdByUid||uid,createdBy:old?.createdBy||actorName,
   createdByRole:old?.createdByRole||user.data().role
  };
  supply.status=receiving.normalizeSupply(supply).status;
  const items=source.items.map(item=>({...item})),item=items[sourceItemIndex];
  const nextOrdered=number(item.supplyOrderedQty??0,'來源已採購')+intent.qty;
  const sourceEvent={id:'quick-'+intent.operationId,type:'PURCHASING_MANUAL',
   at:now,date,qty:intent.qty,documentNo:internalNo,by:actorName};
  items[sourceItemIndex]={...item,supplyOrderedQty:nextOrdered,
   manualOrderNos:[...new Set([...(item.manualOrderNos||[]),internalNo])],
   orderedAt:item.orderedAt&&item.orderedAt<date?item.orderedAt:date,
   orderEvents:[...(item.orderEvents||[]),sourceEvent]};
  const categories=new Set(source.workCategories||[]);
  categories.add('arrival');
  if(items.some(row=>demandCore.fromSalesOrder({...row,
    requiredSupplyQty:row.fulfillmentType==='DIRECT_SHIP'?row.qty:undefined}).remainingToOrderQty>0))
   categories.add('ordering');
  else categories.delete('ordering');
  const demandDoc=demandCore.demandDocument({...demandBefore,...demandAfter},{updatedAt:now});
  const opDoc={type:'PURCHASING_MANUAL',operationId:intent.operationId,uid,hash,
   supplyId,demandId,orderId:intent.orderId,itemId:intent.itemId,qty:intent.qty,
   movementId:directShip?'':movementRef.id,createdAt:now};
  // All reads above. One Admin SDK transaction commits all business facts;
  // a rejected request cannot leave a supplier promise without its source.
  if(old)tx.set(supplyRef,supply);else tx.create(supplyRef,supply);
  tx.set(ref('procurementDemands',encodeURIComponent(demandId)),demandDoc);
  tx.update(ref('orders',intent.orderId),{
   items,itemCount:items.length,orderSchemaVersion:2,workCategories:[...categories],
   workCategoryUpdatedAt:now,updatedAt:now
  });
  if(directShip){
   const mirror=ref('receivingSupplyOrders',supplyId);
   tx.set(mirror,sanitizeSupply(supply));
  }else{
   tx.update(inventoryRef,{incoming:inventory.data().incoming+intent.qty,updatedAt:now});
   tx.update(warehouseRef,{incoming:warehouse.data().incoming+intent.qty,updatedAt:now});
   tx.create(movementRef,{
    type:'purchase_incoming',qty:intent.qty,productKey,productId:sourceItem.productId,
    warehouseId,brand:supply.brand,brandId:supply.brandId,
    fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:supplyId,
    purchaseDocumentId:internalNo,createdAt:now,createdBy:actorName,actorUid:uid,
    ownerUid:source.ownerUid,salesCode:source.salesCode
   });
  }
  tx.create(opRef,opDoc);
  return {status:'committed',operationId:intent.operationId,supplyId,
   demandId,committedQty:intent.qty};
 });
}
module.exports={commitV2QuickPurchase,purchaseIntent,todayTaipei};
