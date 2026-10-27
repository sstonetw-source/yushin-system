'use strict';
// Admin-only source fixture. Initialization and PO commitment >5 lines remain
// outside this receiving acceptance boundary; production is always refused.
const demandCore=require('../../modules/procurement-demand-core');
async function seedFifteenReceivingSource(db,ownerUid,tag,count,{service=false,distinct=false}={}){
 if(!process.env.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')throw Error('Receiving fixture requires demo-yushin Emulator');
 const orderId='r15-'+tag,keys=Array.from({length:distinct?count:2},(_,i)=>orderId+'-P'+i),warehouses=[orderId+'-A',orderId+'-B'];
 const items=[],supplies=[],demands=[],paths=[];
 const batch=db.batch(),put=(name,id,data)=>{paths.push(name+'/'+id);batch.set(db.collection(name).doc(id),data);};
 for(const warehouseId of warehouses)put('warehouses',warehouseId,{active:true});
 for(const key of keys)put('products',key,{productType:'Goods',active:true});
 for(let index=0;index<count;index++){
  const itemId='I'+index,productId=keys[index%keys.length],warehouseId=warehouses[index%2],qty=3;
  if(service&&index===count-1){
   const productId=orderId+'-service';put('products',productId,{productType:'SERVICE',active:true,serviceKind:'ONSITE_REPAIR'});
   items.push({itemId,productId,productType:'SERVICE',qty:1,orderedQty:1,reservedQty:0,shortageQty:0,
    receivedQty:0,supplyOrderedQty:0,deliveredQty:0,returnedQty:0,dispatchPreparedQty:0,warehouseShippedQty:0});continue;
  }
  const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
  const supplyId=orderId+'-supply-'+index;
  const source={sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,orderId,itemId,productId,productKey:productId,
   ownerUid:ownerUid,salesCode:'R15',fulfillmentType:'WAREHOUSE',warehouseId};
  items.push({itemId,productId,productType:'Goods',qty,orderedQty:qty,warehouseId,fulfillmentType:'WAREHOUSE',
   supplyOrderedQty:qty,receivedQty:0,reservedQty:0,shortageQty:qty,warehouseShippedQty:0,dispatchPreparedQty:0,deliveredQty:0,returnedQty:0,
   deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'測試',phone:'02-12345678',address:'測試地址'}});
  put('inventoryReservations',orderId+'__'+itemId,{orderId,itemId,productKey:productId,ownerUid:ownerUid,salesCode:'R15',
   quantity:0,shortageQty:qty,status:'shortage',locationSchemaVersion:2,locations:[],lifecycleWarehouseIds:warehouses});
  put('procurementDemands',encodeURIComponent(demandId),demandCore.normalizeDemand({...source,demandId,requestedQty:qty,orderedQty:qty,receivedQty:0}));
  put('supplyOrders',supplyId,{...source,id:supplyId,demandId,type:'PURCHASING_PO',method:'PURCHASING_PO',
   purchaseDocumentId:orderId+'-PO',qty,receivedQty:0,incomingRegisteredQty:qty,status:'ORDERED',unitCost:17});
  supplies.push(supplyId);demands.push(encodeURIComponent(demandId));
 }
 for(const key of keys){
  const same=items.filter(row=>row.productId===key);
  put('inventory',key,{productKey:key,onHand:0,reserved:0,incoming:same.length*3,transferFreeInTransit:0});
  for(const warehouseId of warehouses)put('warehouseStocks',warehouseId+'__'+key,{productKey:key,warehouseId,
   onHand:0,reserved:0,incoming:same.filter(row=>row.warehouseId===warehouseId).length*3,transferFreeInTransit:0});
 }
 put('purchaseOrders',orderId+'-PO',{status:'ORDERED',supplyOrderIds:supplies,items:items.filter(row=>row.productType!=='SERVICE').map(row=>({
  orderId,itemId:row.itemId,productId:row.productId,warehouseId:row.warehouseId,qty:row.qty}))});
 for(let i=0;i<items.length;i++)items[i]=require('../../modules/fulfillment-core').normalizeItem({...items[i],itemCodeKey:'',brand:'',brandId:'',unitPrice:0,totalPrice:0,fulfillmentType:items[i].fulfillmentType||'WAREHOUSE',warehouseId:items[i].warehouseId||''},i);
 put('orders',orderId,{ownerUid:ownerUid,salesCode:'R15',status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:orderId+'-sync',deliveredQty:0,returnedQty:0,isDelivered:false,
  warehouseShipmentRecords:[],deliveryRecords:[],returnRecords:[],returnHistory:[],items});
 await batch.commit();
 const input=(index,qty=1,suffix='first')=>({supplyId:orderId+'-supply-'+index,operationId:orderId+'-receipt-'+index+'-'+suffix,qty,lotNo:'L'+index,expiryDate:'2028-01-01'});
 const snapshot=async()=>{
  const fixed=await Promise.all(paths.map(async path=>{const snap=await db.doc(path).get();return [path,snap.data()];}));
  const extra={};for(const name of ['receipts','inventoryMovements','inventoryLots','inventoryLotCosts','receivingSupplyOrders','serviceCases']){
   // Dedicated fixture namespace, including protected lot costs whose product key
   // is not guaranteed. Include every matching ID as well as matching source.
   const docs=await db.collection(name).get();extra[name]=docs.docs.filter(doc=>doc.id.startsWith(orderId)||doc.data().orderId===orderId||keys.includes(doc.data().productKey))
    .map(doc=>[doc.id,doc.data()]).sort((a,b)=>a[0].localeCompare(b[0]));
  }
  return {fixed,...extra};
 };
 return {orderId,keys,warehouses,items,supplies,demands,input,snapshot};
}
module.exports={seedFifteenReceivingSource};
