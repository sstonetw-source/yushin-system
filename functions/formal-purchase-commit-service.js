'use strict';
// Formal customer-order PO write pilot (1–5 lines), isolated in demo-yushin Emulator.
// One atomic transaction owns the PO, all Supplies/Demands and source Orders.
// Reuses exactly the preflight transaction validator and Procurement Demand
// Core, rechecking Auth and all current facts within the committing callback.
// NOT exported by production functions/index.js or used by the production UI.
const {createHash}=require('node:crypto');
const demandCore=require('./shared/procurement-demand-core.js');
const {strictRequest,validateV2FormalPurchaseTx}=require('./formal-purchase-preview-service.js');
function fail(code,message){const e=new Error(message);e.code=code;throw e;}
function text(value,label,max=200){
 if(typeof value!=='string'||!value.trim()||value!==value.trim()
   ||value.length>max||/[\x00-\x1f]/.test(value))
  fail('invalid-argument',label+'不正確');
 return value;
}
function validDate(value){
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)
   ||!Number.isFinite(Date.parse(value+'T00:00:00Z'))
   ||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)
  fail('invalid-argument','採購日期不正確');
 return value;
}
function purchaseLine(data){
 if(!data||typeof data!=='object'||Array.isArray(data)
   ||Object.keys(data).sort().join(',')!=='itemId,orderId,qty,unitCost')
  fail('invalid-argument','採購品項欄位不正確');
 const base=strictRequest({poNo:'line-validation',orderId:data.orderId,itemId:data.itemId,qty:data.qty});
 if(typeof data.unitCost!=='number'||!Number.isFinite(data.unitCost)
   ||data.unitCost<0||data.unitCost>100000000
   ||Math.abs(Math.round(data.unitCost*100)-data.unitCost*100)>1e-6)
  fail('invalid-argument','採購成本須為最多兩位小數的非負數');
 return {orderId:base.orderId,itemId:base.itemId,qty:base.qty,unitCost:data.unitCost};
}
function purchaseIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data))
  fail('invalid-argument','正式採購輸入欄位不正確');
 const keys=Object.keys(data).sort().join(',');
 let rawLines;
 if(keys==='itemId,orderId,poDate,poNo,qty,supplier,unitCost')
  rawLines=[{orderId:data.orderId,itemId:data.itemId,qty:data.qty,unitCost:data.unitCost}];
 else if(keys==='items,poDate,poNo,supplier'&&Array.isArray(data.items)
   &&data.items.length>=1&&data.items.length<=5)rawLines=data.items;
 else fail('invalid-argument','正式採購限 1–5 個實體來源品項');
 const lines=rawLines.map(purchaseLine),seen=new Set();
 for(const line of lines){
  const key=JSON.stringify([line.orderId,line.itemId]);
  if(seen.has(key))fail('invalid-argument','同一來源品項請合併為單一採購列');
  seen.add(key);
 }
 const base=strictRequest({poNo:data.poNo,orderId:lines[0].orderId,itemId:lines[0].itemId,qty:lines[0].qty});
 const supplier=text(data.supplier,'供應商',200),poDate=validDate(data.poDate);
 // Preserve the original single-line fingerprint, including its field order.
 // One-row array and original scalar requests represent the same intent.
 return lines.length===1?{...base,supplier,unitCost:lines[0].unitCost,poDate}
  :{poNo:base.poNo,supplier,poDate,items:lines};
}
function intentLines(intent){
 return intent.items||[{orderId:intent.orderId,itemId:intent.itemId,qty:intent.qty,unitCost:intent.unitCost}];
}
function signature(intent){
 return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
async function commitV2FormalPurchase(db,uid,data){
 const intent=purchaseIntent(data),fingerprint=signature(intent),lines=intentLines(intent);
 const now=new Date().toISOString(),ref=(collection,id)=>db.collection(collection).doc(id);
 return db.runTransaction(async tx=>{
  // Cache only inside this callback: all rows see one snapshot, and retries
  // always re-read Auth, orders, products, warehouses and demand documents.
  const reads=new Map(),reader={get(reference){
   const key=reference.path;
   if(!reads.has(key))reads.set(key,tx.get(reference));
   return reads.get(key);
  }};
  const details=[];
  for(const line of lines)details.push(await validateV2FormalPurchaseTx(reader,db,uid,
   {poNo:intent.poNo,...line},{allowExistingPo:true}));
  const poRef=ref('purchaseOrders',intent.poNo);
  const supplyIds=lines.map((_,index)=>'po-'+encodeURIComponent(intent.poNo)+'-'+index);
  const supplyRefs=supplyIds.map(id=>ref('supplyOrders',id));
  const supplySnapshots=[];
  for(const supplyRef of supplyRefs)supplySnapshots.push(await reader.get(supplyRef));
  if(details[0].existingPo){
   const saved=details[0].existingPo;
   if(saved.serverCommitHash!==fingerprint||saved.createdByUid!==uid
     ||saved.poNo!==intent.poNo||JSON.stringify(saved.supplyOrderIds)!==JSON.stringify(supplyIds)
     ||!Array.isArray(saved.items)||saved.items.length!==lines.length)
    fail('already-exists','此採購單號已有不同的權威交易紀錄');
   for(const [index,line] of lines.entries()){
    const snapshot=supplySnapshots[index],supply=snapshot.exists?snapshot.data():null;
    if(!supply||supply.purchaseDocumentId!==intent.poNo||supply.type!=='PURCHASING_PO'
      ||supply.createdByUid!==uid||supply.qty!==line.qty||supply.unitCost!==line.unitCost
      ||supply.sourceId!==line.orderId||supply.sourceItemId!==line.itemId
      ||supply.supplier!==intent.supplier
      ||supply.demandId!==demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:line.orderId,sourceItemId:line.itemId})
      ||saved.items[index]?.orderId!==line.orderId
      ||saved.items[index].itemId!==line.itemId||saved.items[index].qty!==line.qty
      ||saved.items[index].unitPrice!==line.unitCost)
     fail('failed-precondition','採購單與供應承諾不一致，請先稽核');
   }
   return purchaseResult('already-applied',intent,supplyIds,supplySnapshots.map(s=>s.data().demandId));
  }
  if(supplySnapshots.some(snapshot=>snapshot.exists))
   fail('already-exists','供應紀錄 ID 已被其他交易使用');
  const actorRole=details[0].actorRole,actorName=details[0].actorName;
  const poLines=[],supplies=[],demands=[],sourceUpdates=new Map();
  for(const [index,lineIntent] of lines.entries()){
   const {source,sourceItem,sourceItemIndex,demandBefore,demandAfter,plan}=details[index];
   const ownerUid=source.ownerUid,salesCode=source.salesCode;
   const productKey=String(sourceItem.inventoryProductKey||sourceItem.productId);
   const line={
    orderId:lineIntent.orderId,itemId:lineIntent.itemId,orderItemIndex:sourceItemIndex,
    sourceType:'SALES_ORDER',sourceId:lineIntent.orderId,sourceItemId:lineIntent.itemId,
    demandId:plan.demandId,ownerUid,salesCode,salesName:source.salesName||'',
    productId:sourceItem.productId,productKey,
    itemCode:String(sourceItem.itemCode||''),itemName:String(sourceItem.itemName||''),
    brand:String(sourceItem.brand||''),brandId:String(sourceItem.brandId||''),
    qty:lineIntent.qty,unitPrice:lineIntent.unitCost,warehouseId:plan.warehouseId,
    fulfillmentType:'WAREHOUSE'
   };
   poLines.push(line);
   supplies.push({
    type:'PURCHASING_PO',method:'PURCHASING_PO',
    sourceType:'SALES_ORDER',sourceId:lineIntent.orderId,sourceItemId:lineIntent.itemId,
    demandId:plan.demandId,internalNo:intent.poNo,purchaseDocumentId:intent.poNo,
    purchaseDocumentNo:intent.poNo,status:'ORDERED',
    orderId:lineIntent.orderId,itemId:lineIntent.itemId,orderItemIndex:sourceItemIndex,
    ownerUid,salesCode,salesName:source.salesName||'',productId:sourceItem.productId,
    productKey,itemCode:line.itemCode,itemName:line.itemName,brand:line.brand,brandId:line.brandId,
    qty:lineIntent.qty,receivedQty:0,incomingRegisteredQty:0,
    supplier:intent.supplier,supplierId:'',supplierEmail:'',unitCost:lineIntent.unitCost,
    orderDate:intent.poDate,expectedDate:'',scheduleDate:demandBefore.scheduleDate||'',
    fulfillmentType:'WAREHOUSE',warehouseId:plan.warehouseId,
    createdAt:now,updatedAt:now,createdByUid:uid,createdBy:actorName,createdByRole:actorRole
   });
   demands.push({ref:ref('procurementDemands',encodeURIComponent(plan.demandId)),
    data:demandCore.demandDocument({...demandBefore,...demandAfter},{updatedAt:now})});
   if(!sourceUpdates.has(lineIntent.orderId))sourceUpdates.set(lineIntent.orderId,{
    source,items:source.items.map(item=>({...item}))
   });
   const next=sourceUpdates.get(lineIntent.orderId);
   const item=next.items[sourceItemIndex];
   next.items[sourceItemIndex]={...item,
    supplyOrderedQty:Number(item.supplyOrderedQty||0)+lineIntent.qty,
    purchaseDocumentNos:[...new Set([...(item.purchaseDocumentNos||[]),intent.poNo])],
    orderedAt:item.orderedAt&&item.orderedAt<intent.poDate?item.orderedAt:intent.poDate,
    orderEvents:[...(item.orderEvents||[]).filter(event=>event.id!==intent.poNo),{
     id:intent.poNo,type:'PURCHASING_PO',at:now,date:intent.poDate,
     qty:lineIntent.qty,documentNo:intent.poNo,by:actorName
    }]};
  }
  const savedPo={
   poNo:intent.poNo,purchaseType:'order',vendorName:intent.supplier,
   supplierName:intent.supplier,supplierId:'',supplierEmail:'',
   poDate:intent.poDate,buyerName:actorName,items:poLines,supplyOrderIds:supplyIds,
   orderIds:[...sourceUpdates.keys()],createdAt:now,updatedAt:now,
   createdByUid:uid,createdByRole:actorRole,serverCommitHash:fingerprint,
   lastOutputAt:'',lastOutputType:''
  };
  // No writes are staged until EVERY line passes and all deterministic supply
  // IDs have been read. A bad final row rejects the whole PO, never a prefix.
  tx.create(poRef,savedPo);
  supplies.forEach((supply,index)=>tx.create(supplyRefs[index],supply));
  demands.forEach(demand=>tx.set(demand.ref,demand.data));
  for(const [orderId,{source,items}] of sourceUpdates){
   // Preserve other queues. One purchased line must not hide an unpurchased
   // sibling's shortage. Full UI work-index migration remains unaccepted.
   const categories=new Set(source.workCategories||[]);categories.add('arrival');
   if(items.some(item=>demandCore.fromSalesOrder(item).remainingToOrderQty>0))categories.add('ordering');
   else categories.delete('ordering');
   tx.update(ref('orders',orderId),{
    items,itemCount:items.length,orderSchemaVersion:2,
    workCategories:[...categories],workCategoryUpdatedAt:now,updatedAt:now
   });
  }
  return purchaseResult('committed',intent,supplyIds,demands.map(d=>d.data.demandId));
 });
}
function purchaseResult(status,intent,supplyOrderIds,demandIds){
 const result={status,poNo:intent.poNo,supplyOrderIds,
  committedQty:intentLines(intent).reduce((sum,line)=>sum+line.qty,0)};
 return demandIds.length===1?{...result,demandId:demandIds[0]}:{...result,demandIds};
}
module.exports={commitV2FormalPurchase,purchaseIntent};
