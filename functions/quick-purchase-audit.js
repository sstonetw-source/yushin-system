'use strict';

// Targeted post-purchase evidence only. Never calls a writer or replays a purchase.
const {createHash}=require('node:crypto');
const {purchaseIntent}=require('./quick-purchase-commit-service');
const {demandIdForSource,fromSalesOrder}=require('./shared/procurement-demand-core');
const QUERY_LIMIT=100;
const id=value=>typeof value==='string'&&value.length>0&&value.length<=160
 &&value.trim()===value&&!/[\x00-\x1f/]/.test(value);
function auditTarget(target){
 if(!target||!id(target.orderId)||!id(target.itemId)
   ||(target.operationId!==undefined&&!/^[A-Za-z0-9_-]{8,80}$/.test(target.operationId)))
  throw Error('Explicit valid orderId/itemId and optional original operationId required');
 return {orderId:target.orderId,itemId:target.itemId,operationId:target.operationId};
}
async function auditQuickPurchase(db,input){
 const target=auditTarget(input);
 const supplyId='manual-'+encodeURIComponent(target.orderId)+'-'+encodeURIComponent(target.itemId);
 const demandId=demandIdForSource({sourceType:'SALES_ORDER',sourceId:target.orderId,sourceItemId:target.itemId});
 const ref=(name,key)=>db.collection(name).doc(key);
 return db.runTransaction(async tx=>{
  const checks=[];
  const check=(name,ok)=>checks.push({name,ok:ok===true});
  const report=(status,reason)=>({mode:'READ_ONLY',scope:'single unreceived warehouse quick purchase',
   target:{...target,supplyId,demandId},status,...(reason?{reason}:{}),checks});
  const read=async reference=>{const doc=await tx.get(reference);return doc.exists?doc.data():null;};
  const order=await read(ref('orders',target.orderId));
  const supply=await read(ref('supplyOrders',supplyId));
  const demand=await read(ref('procurementDemands',encodeURIComponent(demandId)));
  const item=order?.items?.filter(row=>row.itemId===target.itemId);
  check('source-and-evidence-exist',!!order&&!!supply&&!!demand&&item?.length===1);
  if(checks.some(c=>!c.ok))return report('MISMATCH');
  if(supply.fulfillmentType!=='WAREHOUSE'||supply.receivedQty!==0
    ||supply.status!=='ORDERED'||supply.orderEvents?.length!==1
    ||item[0].receivedQty!==0||!['active'].includes(order.status)
    ||['cancelled','void','returning'].includes(order.orderStatus)
    ||!['ORDERED','PARTIALLY_ORDERED'].includes(demand.status))
   return report('INCONCLUSIVE','Outside single, active, unreceived warehouse purchase scope; review lifecycle separately');
  const event=supply.orderEvents[0];
  // Derivation is safe only for one original event. Never invent or submit an ID.
  if(target.operationId===undefined)target.operationId=event.operationId;
  auditTarget(target);
  const operation=await read(ref('purchaseOperations','quick-'+target.operationId));
  const movement=await read(ref('inventoryMovements','quick-'+target.operationId));
  check('operation-and-movement-exist',!!operation&&!!movement);
  if(checks.some(c=>!c.ok))return report('MISMATCH');
  const actor=await read(ref('users',operation.uid));
  const productKey=String(item[0].inventoryProductKey||item[0].productId);
  if(!id(productKey)||!id(supply.warehouseId))return report('MISMATCH','Invalid stock identity');
  const company=await read(ref('inventory',encodeURIComponent(productKey)));
  const warehouses=await tx.get(db.collection('warehouseStocks').where('productKey','==',productKey).limit(QUERY_LIMIT+1));
  const warehousesByProduct=await tx.get(db.collection('warehouseStocks').where('productId','==',item[0].productId).limit(QUERY_LIMIT+1));
  const movements=await tx.get(db.collection('inventoryMovements').where('sourceId','==',supplyId).limit(QUERY_LIMIT+1));
  // Include mismatched legacy keys as well, so a bad productKey cannot hide a
  // warehouse balance from the company reconciliation. Deduplicate overlapping queries.
  const stockDocs=[...new Map([...warehouses.docs,...warehousesByProduct.docs].map(doc=>[doc.id,doc])).values()];
  if(stockDocs.length>QUERY_LIMIT||movements.docs.length>QUERY_LIMIT)
   return report('INCONCLUSIVE','Query bound exceeded; incomplete results cannot establish consistency');
  const stocks=stockDocs.map(doc=>({id:doc.id,data:doc.data()}));
  const warehouse=stocks.find(row=>row.id===encodeURIComponent(supply.warehouseId)+'__'+encodeURIComponent(productKey))?.data;
  const qty=operation.qty;
  check('source-ready-and-owned',id(order.ownerUid)&&id(order.salesCode)
   &&id(item[0].productId)&&order.inventoryReservationStatus==='completed');
  check('quantity-is-positive-integer',Number.isSafeInteger(qty)&&qty>0);
  check('original-operation-identity',operation.type==='PURCHASING_MANUAL'
   &&operation.operationId===target.operationId&&operation.orderId===target.orderId
   &&operation.itemId===target.itemId&&operation.supplyId===supplyId
   &&operation.demandId===demandId&&operation.movementId==='quick-'+target.operationId);
  check('actor-currently-authorized',!!actor&&actor.active!==false&&actor.disabled!==true
   &&['admin','purchaser'].includes(actor.role));
  let hashMatches=false;
  try{
   const intent=purchaseIntent({operationId:target.operationId,orderId:target.orderId,itemId:target.itemId,
    qty,supplier:event.supplier,unitCost:event.unitCost});
   hashMatches=createHash('sha256').update(JSON.stringify(intent)).digest('hex')===operation.hash;
  }catch{/* Malformed evidence is a failed check; never echo cost/supplier values. */}
  check('original-intent-hash',hashMatches);
  check('supply-source-identity',supply.type==='PURCHASING_MANUAL'&&supply.sourceType==='SALES_ORDER'
   &&supply.sourceId===target.orderId&&supply.sourceItemId===target.itemId
   &&supply.orderId===target.orderId&&supply.itemId===target.itemId&&supply.demandId===demandId
   &&supply.productId===item[0].productId&&supply.productKey===productKey
   &&supply.ownerUid===order.ownerUid&&supply.salesCode===order.salesCode);
  check('demand-source-identity',demand.demandId===demandId&&demand.sourceType==='SALES_ORDER'
   &&demand.sourceId===target.orderId&&demand.sourceItemId===target.itemId
   &&demand.productId===supply.productId&&demand.productKey===productKey
   &&demand.ownerUid===order.ownerUid&&demand.salesCode===order.salesCode);
  check('single-purchase-quantities',event.operationId===target.operationId&&event.qty===qty
   &&event.createdByUid===operation.uid&&supply.qty===qty&&supply.incomingRegisteredQty===qty
   &&supply.supplier===event.supplier&&supply.unitCost===event.unitCost
   &&item[0].supplyOrderedQty===qty&&demand.orderedQty===qty&&demand.receivedQty===0
   &&demand.remainingToReceiveQty===qty);
  const expectedDemand=fromSalesOrder(item[0]);
  check('demand-projection',Number.isSafeInteger(item[0].qty)&&item[0].qty>0
   &&['requestedQty','orderedQty','receivedQty','remainingToOrderQty','remainingToReceiveQty','status']
    .every(key=>demand[key]===expectedDemand[key]));
  const events=item[0].orderEvents?.filter(e=>e.id==='quick-'+target.operationId)||[];
  check('unique-source-event',events.length===1&&events[0].type==='PURCHASING_MANUAL'
   &&events[0].qty===qty&&events[0].documentNo===supply.internalNo);
  check('movement-identity',movement.type==='purchase_incoming'&&movement.sourceType==='SUPPLY_ORDER'
   &&movement.sourceId===supplyId&&movement.qty===qty&&movement.productKey===productKey
   &&movement.productId===supply.productId&&movement.warehouseId===supply.warehouseId
   &&movement.actorUid===operation.uid&&movement.purchaseDocumentId===supply.internalNo);
  const incoming=movements.docs.filter(doc=>doc.data().type==='purchase_incoming');
  check('unique-incoming-movement',incoming.length===1&&incoming[0].id==='quick-'+target.operationId);
  check('stock-identity',!!company&&!!warehouse&&company.productKey===productKey
   &&company.productId===supply.productId&&warehouse.warehouseId===supply.warehouseId
   &&stocks.every(row=>row.data.productKey===productKey&&row.data.productId===supply.productId
    &&id(row.data.warehouseId)
    &&row.id===encodeURIComponent(row.data.warehouseId)+'__'+encodeURIComponent(productKey)));
  const validStock=stock=>!!stock&&['onHand','reserved','incoming'].every(key=>Number.isSafeInteger(stock[key])&&stock[key]>=0);
  const valid=validStock(company)&&stocks.length>0&&stocks.every(row=>validStock(row.data));
  check('stock-balances-valid',valid);
  check('company-equals-all-warehouses',valid&&['onHand','reserved','incoming']
   .every(key=>company[key]===stocks.reduce((total,row)=>total+row.data[key],0)));
  // Other purchases may contribute to these totals; do not demand equality to this one purchase.
  check('pending-purchase-covered-by-incoming',valid&&!!warehouse&&company.incoming>=qty&&warehouse.incoming>=qty);
  return report(checks.every(c=>c.ok)?'CONSISTENT':'MISMATCH');
 },{readOnly:true});
}
module.exports={auditQuickPurchase,auditTarget};
