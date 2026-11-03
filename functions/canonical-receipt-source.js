'use strict';
// Admission only for the current initial-order writer's single-warehouse ledger.
// All receipt quantities and writes remain in the existing Receiving Service.
const demandCore=require('./shared/procurement-demand-core');
const {hasCommercialOwnerIdentity}=require('./commercial-owner-identity');
function reject(){throw Object.assign(new Error('單倉收貨來源、預留或採購帳目不一致；尚未入帳，請先核對原單。'),{code:'failed-precondition'});}
const id=value=>typeof value==='string'&&!!value&&value.trim()===value&&!value.includes('/')&&value.length<=160;
function number(value,optional=false){
 if(value===undefined&&optional)return 0;
 if(!Number.isSafeInteger(value)||value<0||value>1000000000)reject();
 return value;
}
async function validateCanonicalReceiptSource({get,db,uid,actor,order,supply,reservation,qty,replay=false}){
 if(!id(supply.orderId)||!id(supply.itemId)||!id(supply.productKey)||!id(supply.warehouseId)
   ||supply.fulfillmentType!=='WAREHOUSE'||supply.sourceType!=='SALES_ORDER'
   ||supply.sourceId!==supply.orderId||supply.sourceItemId!==supply.itemId
   ||supply.ownerUid!==order.ownerUid||supply.salesCode!==order.salesCode
   ||!await hasCommercialOwnerIdentity({get},db,uid,actor,order)
   ||!Array.isArray(order.items)||order.items.length<1||order.items.length>5)reject();
 const selected=order.items.filter(row=>row?.itemId===supply.itemId);
 if(selected.length!==1||selected[0].productId!==supply.productId
   ||(selected[0].inventoryProductKey||selected[0].productId)!==supply.productKey
   ||!reservation||['locationSchemaVersion','locations','allocations','warehouseAllocations','lifecycleWarehouseIds'].some(field=>Object.hasOwn(reservation,field))
   ||reservation.orderId!==supply.orderId||reservation.itemId!==supply.itemId
   ||reservation.productKey!==supply.productKey||reservation.warehouseId!==supply.warehouseId
   ||reservation.ownerUid!==order.ownerUid||reservation.salesCode!==order.salesCode)reject();
 // Replays acknowledge the existing receipt, not a new lifecycle transition.
 // The shared writer still checks exact original actor, quantity and batch.
 if(replay)return;
 if(order.status!=='active'||![undefined,'','normal'].includes(order.orderStatus)
   ||order.inventoryReservationStatus!=='completed'||!id(order.inventoryReservationAttemptId)
   ||order.returnPending===true||number(order.logisticsTransfersPending,true)!==0)reject();
 for(const key of ['deliveryRecords','deliveryHistory','returnRecords','returnHistory','warehouseShipmentRecords']){
  if(!Array.isArray(order[key]??[])||(order[key]??[]).length)reject();
 }
 const seen=new Set(),holds=new Map(),products=new Map();
 for(const row of order.items){
  if(!id(row?.itemId)||seen.has(row.itemId)||!id(row.productId)
    ||(row.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||row.transferPendingId||row.custodyTransferId)reject();
  seen.add(row.itemId);
  for(const field of ['dispatchPreparedQty','warehouseShippedQty','deliveredQty','returnedQty'])
   if(number(row[field],true)!==0)reject();
  const requested=number(row.qty===undefined?row.orderedQty:row.qty);
  const reserved=number(row.reservedQty,true),shortage=number(row.shortageQty,true);
  const ordered=number(row.supplyOrderedQty,true),received=number(row.receivedQty,true);
  if(!requested||requested>1000000||(row.orderedQty!==undefined&&row.orderedQty!==requested)
    ||received>ordered||ordered-received>shortage)reject();
  // The initial-order writer creates no stock reservation or demand for service.
  // Validate that contract explicitly; a service line must never count as stock.
  if(String(row.productType||row.type||'').toUpperCase()==='SERVICE'){
   if(reserved!==0||shortage!==0||ordered!==0||received!==0
     ||row.inventoryProductKey!==''||row.warehouseId!==''
     ||row.reservationStatus!=='not_required')reject();
   const serviceProduct=await get(db.collection('products').doc(row.productId));
   if(!serviceProduct.exists||serviceProduct.data().active===false
     ||String(serviceProduct.data().productType||serviceProduct.data().type||'').toUpperCase()!=='SERVICE')reject();
   const unexpected=await get(db.collection('inventoryReservations').doc(supply.orderId+'__'+row.itemId));
   if(unexpected.exists)reject();
   const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:supply.orderId,sourceItemId:row.itemId});
   const demand=await get(db.collection('procurementDemands').doc(encodeURIComponent(demandId)));
   if(demand.exists)reject();
   continue;
  }
  if(reserved+shortage!==requested)reject();
  const key=row.inventoryProductKey||row.productId,warehouseId=row.warehouseId||order.warehouseId;
  if(!id(key)||key!==row.productId||!id(warehouseId))reject();
  if(!products.has(row.productId)){
   const snap=await get(db.collection('products').doc(row.productId));
   const product=snap.exists?snap.data():null;
   if(!product||product.active===false||String(product.productType||product.type||'').toUpperCase()==='SERVICE')reject();
   products.set(row.productId,product);
  }
  const snap=await get(db.collection('inventoryReservations').doc(supply.orderId+'__'+row.itemId));
  const ledger=snap.exists?snap.data():null;
  if(!ledger||['locationSchemaVersion','locations','allocations','warehouseAllocations','lifecycleWarehouseIds'].some(field=>Object.hasOwn(ledger,field))
    ||ledger.orderId!==supply.orderId||ledger.itemId!==row.itemId||ledger.productKey!==key
    ||ledger.warehouseId!==warehouseId||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
    ||number(ledger.quantity)!==reserved||number(ledger.shortageQty)!==shortage
    ||ledger.status!==(reserved>0?'active':'shortage'))reject();
  const master=await get(db.collection('warehouses').doc(warehouseId));
  if(!master.exists||master.data().active===false||master.data().systemCustody
    ||master.data().warehouseType==='CUSTODY'||warehouseId.startsWith('custody-'))reject();
  if(!holds.has(key))holds.set(key,{productId:row.productId,total:0,warehouses:new Map()});
  const held=holds.get(key);
  if(held.productId!==row.productId)reject();
  held.total+=reserved;held.warehouses.set(warehouseId,(held.warehouses.get(warehouseId)||0)+reserved);
  if(row.itemId===supply.itemId){
   const remaining=number(supply.qty)-number(supply.receivedQty,true);
   if(supply.warehouseId!==warehouseId||!qty||qty>remaining||remaining>shortage
     ||number(supply.incomingRegisteredQty)!==remaining)reject();
  }
 }
 for(const [key,held]of holds){
  const company=await get(db.collection('inventory').doc(encodeURIComponent(key)));
  const stock=company.exists?company.data():null;
  const valid=(value,own)=>value&&value.productKey===key
   &&(value.productId===undefined||value.productId===held.productId)
   &&number(value.incoming,true)>=0&&number(value.reserved,true)>=own
   &&number(value.reserved,true)+number(value.transferFreeInTransit,true)<=number(value.onHand,true);
  if(!valid(stock,held.total))reject();
  for(const [warehouseId,own]of held.warehouses){
   const wh=await get(db.collection('warehouseStocks').doc(encodeURIComponent(warehouseId)+'__'+encodeURIComponent(key)));
   if(!wh.exists||wh.data().warehouseId!==warehouseId||!valid(wh.data(),own))reject();
  }
 }
 const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:supply.orderId,sourceItemId:supply.itemId});
 const demand=await get(db.collection('procurementDemands').doc(encodeURIComponent(demandId)));
 const proof=demand.exists?demand.data():null,expected=demandCore.fromSalesOrder(selected[0]);
 if(!proof||supply.demandId!==demandId||proof.demandId!==demandId
   ||proof.sourceType!=='SALES_ORDER'||proof.sourceId!==supply.orderId||proof.sourceItemId!==supply.itemId
   ||proof.productId!==supply.productId||proof.productKey!==supply.productKey
   ||proof.warehouseId!==supply.warehouseId||proof.fulfillmentType!=='WAREHOUSE'
   ||proof.ownerUid!==order.ownerUid||proof.salesCode!==order.salesCode
   ||['requestedQty','orderedQty','receivedQty','remainingToOrderQty','remainingToReceiveQty','status']
    .some(field=>proof[field]!==expected[field]))reject();
}
module.exports={validateCanonicalReceiptSource};
