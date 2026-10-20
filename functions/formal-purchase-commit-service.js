'use strict';
// Formal customer-order PO write pilot, isolated behind demo-yushin Emulator.
// The single atomic transaction owns PO, Supply, Demand and source Order.
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
function purchaseIntent(data){
 if(!data||typeof data!=='object'||Array.isArray(data)
   ||Object.keys(data).sort().join(',')!=='itemId,orderId,poDate,poNo,qty,supplier,unitCost')
  fail('invalid-argument','正式採購輸入欄位不正確');
 const base=strictRequest({poNo:data.poNo,orderId:data.orderId,itemId:data.itemId,qty:data.qty});
 if(typeof data.unitCost!=='number'||!Number.isFinite(data.unitCost)
   ||data.unitCost<0||data.unitCost>100000000||Math.round(data.unitCost*100)!==data.unitCost*100)
  fail('invalid-argument','採購成本須為最多兩位小數的非負數');
 return {...base,supplier:text(data.supplier,'供應商',200),
  unitCost:data.unitCost,poDate:validDate(data.poDate)};
}
function signature(intent){
 return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
async function commitV2FormalPurchase(db,uid,data){
 const intent=purchaseIntent(data),fingerprint=signature(intent);
 const now=new Date().toISOString(),ref=(collection,id)=>db.collection(collection).doc(id);
 return db.runTransaction(async tx=>{
  const detail=await validateV2FormalPurchaseTx(tx,db,uid,intent,{allowExistingPo:true});
  const poRef=ref('purchaseOrders',intent.poNo);
  const supplyId='po-'+encodeURIComponent(intent.poNo)+'-0';
  const supplyRef=ref('supplyOrders',supplyId);
  if(detail.existingPo){
   const saved=detail.existingPo;
   if(saved.serverCommitHash!==fingerprint||saved.createdByUid!==uid
     ||saved.poNo!==intent.poNo||saved.supplyOrderIds?.length!==1
     ||saved.supplyOrderIds[0]!==supplyId)
    fail('already-exists','此採購單號已有不同的權威交易紀錄');
   const originalSupply=await tx.get(supplyRef);
   const supply=originalSupply.exists?originalSupply.data():null;
   if(!supply||supply.purchaseDocumentId!==intent.poNo
      ||supply.createdByUid!==uid||supply.qty!==intent.qty
      ||supply.unitCost!==intent.unitCost)
    fail('failed-precondition','採購單與供應承諾不一致，請先稽核');
   return {status:'already-applied',poNo:intent.poNo,supplyOrderIds:[supplyId],
    demandId:supply.demandId,committedQty:supply.qty};
  }
  const {source,sourceItem,sourceItemIndex,demandBefore,demandAfter,plan,actorRole,actorName}=detail;
  const demandRef=ref('procurementDemands',encodeURIComponent(plan.demandId));
  const supplyBefore=await tx.get(supplyRef);
  if(supplyBefore.exists)fail('already-exists','供應紀錄 ID 已被其他交易使用');
  const ownerUid=source.ownerUid,salesCode=source.salesCode;
  const productKey=String(sourceItem.inventoryProductKey||sourceItem.productId);
  const line={
   orderId:intent.orderId,itemId:intent.itemId,orderItemIndex:sourceItemIndex,
   sourceType:'SALES_ORDER',sourceId:intent.orderId,sourceItemId:intent.itemId,
   demandId:plan.demandId,ownerUid,salesCode,salesName:source.salesName||'',
   productId:sourceItem.productId,productKey,
   itemCode:String(sourceItem.itemCode||''),itemName:String(sourceItem.itemName||''),
   brand:String(sourceItem.brand||''),brandId:String(sourceItem.brandId||''),
   qty:intent.qty,unitPrice:intent.unitCost,warehouseId:plan.warehouseId,
   fulfillmentType:'WAREHOUSE'
  };
  const savedPo={
   poNo:intent.poNo,purchaseType:'order',vendorName:intent.supplier,
   supplierName:intent.supplier,supplierId:'',supplierEmail:'',
   poDate:intent.poDate,buyerName:actorName,
   items:[line],supplyOrderIds:[supplyId],
   orderIds:[intent.orderId],createdAt:now,updatedAt:now,
   createdByUid:uid,createdByRole:actorRole,serverCommitHash:fingerprint,
   lastOutputAt:'',lastOutputType:''
  };
  const supply={
   type:'PURCHASING_PO',method:'PURCHASING_PO',
   sourceType:'SALES_ORDER',sourceId:intent.orderId,sourceItemId:intent.itemId,
   demandId:plan.demandId,internalNo:intent.poNo,purchaseDocumentId:intent.poNo,
   purchaseDocumentNo:intent.poNo,status:'ORDERED',
   orderId:intent.orderId,itemId:intent.itemId,orderItemIndex:sourceItemIndex,
   ownerUid,salesCode,salesName:source.salesName||'',productId:sourceItem.productId,
   productKey,itemCode:line.itemCode,itemName:line.itemName,brand:line.brand,brandId:line.brandId,
   qty:intent.qty,receivedQty:0,incomingRegisteredQty:0,
   supplier:intent.supplier,supplierId:'',supplierEmail:'',unitCost:intent.unitCost,
   orderDate:intent.poDate,expectedDate:'',scheduleDate:demandBefore.scheduleDate||'',
   fulfillmentType:'WAREHOUSE',warehouseId:plan.warehouseId,
   createdAt:now,updatedAt:now,createdByUid:uid,createdBy:actorName,createdByRole:actorRole
  };
  const projectedDemand=demandCore.demandDocument({...demandBefore,...demandAfter},{
   updatedAt:now
  });
  const nextItems=source.items.map((item,index)=>{
   if(index!==sourceItemIndex)return item;
   return {...item,supplyOrderedQty:Math.max(0,Number(item.supplyOrderedQty||0))+intent.qty,
    purchaseDocumentNos:[...new Set([...(item.purchaseDocumentNos||[]),intent.poNo])],
    orderedAt:item.orderedAt&&item.orderedAt<intent.poDate?item.orderedAt:intent.poDate,
    orderEvents:[...(item.orderEvents||[]).filter(e=>e.id!==intent.poNo),{
      id:intent.poNo,type:'PURCHASING_PO',at:now,date:intent.poDate,
      qty:intent.qty,documentNo:intent.poNo,by:actorName
    }]};
  });
  // Existing work categories are only a UI projection; retain other queues
  // and mark arrival as outstanding. Still not an accepted full UI migration.
  const categories=new Set(source.workCategories||[]);
  categories.add('arrival');
  if(demandAfter.remainingToOrderQty>0)categories.add('ordering');
  else categories.delete('ordering');
  tx.create(poRef,savedPo);
  tx.create(supplyRef,supply);
  tx.set(demandRef,projectedDemand);
  tx.update(ref('orders',intent.orderId),{
   items:nextItems,itemCount:nextItems.length,orderSchemaVersion:2,
   workCategories:[...categories],workCategoryUpdatedAt:now,updatedAt:now
  });
  return {status:'committed',poNo:intent.poNo,supplyOrderIds:[supplyId],
   demandId:plan.demandId,committedQty:intent.qty};
 });
}
module.exports={commitV2FormalPurchase,purchaseIntent};
