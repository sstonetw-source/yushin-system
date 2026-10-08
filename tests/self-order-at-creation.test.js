const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function setup(items){
 let invalidations=0;
 const docs=new Map([['orders/o',{selfOrderAtCreation:true,ownerUid:'u',salesCode:'S',orderDate:'2026-10-08',items}]]);
 const ref=(collection,id)=>({id,key:`${collection}/${id}`});
 const context=vm.createContext({window:{YushinSupply:require('../modules/supply-core')},
  YushinProcurementDemand:require('../modules/procurement-demand-core'),
  db:{collection:c=>({doc:id=>ref(c,id)})},supplyOrdersCollection:()=>({doc:id=>ref('supplyOrders',id)}),
  currentUser:{uid:'u'},currentUserCode:'S',currentUserName:'Sales',currentUserRole:'sales',
  canBusinessSelfOrder:()=>true,canCreatePurchaseOrderCapability:()=>false,normalizedOrderStatus:()=> 'normal',
  normalizedOrderItems:o=>o.items.map(x=>({...x})),inventoryProductKey:x=>x.productId,
  defaultWarehouse:()=>({id:'w'}),deliveryActor:()=> 'Sales',orderWorkIndexFields:()=>({}),
  procurementDemandRef:id=>ref('procurementDemands',id),procurementDemandDocument:d=>d,
  procurementDemandForOrderItem:(o,i)=>({demandId:`o-${i.itemId}`,requestedQty:i.shortageQty,orderedQty:i.supplyOrderedQty||0,remainingToOrderQty:Math.max(0,i.shortageQty-(i.supplyOrderedQty||0))}),
  remainingProcurementQty:(o,i)=>Math.max(0,i.shortageQty-(i.supplyOrderedQty||0)),
  invalidateProcurementDemandQueue:()=>{ invalidations++; },
  runRoleTransaction:async fn=>fn({get:async r=>({exists:docs.has(r.key),data:()=>docs.get(r.key)}),set:(r,d)=>docs.set(r.key,d),update:(r,d)=>docs.set(r.key,{...docs.get(r.key),...d})})
 });
 vm.runInContext(source.slice(source.indexOf('async function registerInitialSelfOrderSupply'),source.indexOf('function selfOrderActionHtml')),context);
 return {docs,context,order:docs.get('orders/o'),invalidations:()=>invalidations};
}
test('creation registers only self-order shortages using the entered supplier and zero price',async()=>{
 const x=setup([{itemId:'a',procurementType:'SALES_SELF_ORDER',shortageQty:2,costPrice:0,supplier:'Gift vendor',productId:'p',fulfillmentType:'WAREHOUSE'},
 {itemId:'b',procurementType:'PURCHASING_PO',shortageQty:3},
 {itemId:'c',procurementType:'SALES_SELF_ORDER',shortageQty:0}]);
 await x.context.registerInitialSelfOrders('o',x.order);
 const supplies=[...x.docs].filter(([key])=>key.startsWith('supplyOrders/'));
 assert.equal(supplies.length,1);const supply=supplies[0][1];
 assert.equal(supply.qty,2);assert.equal(supply.unitCost,0);assert.equal(supply.supplier,'Gift vendor');assert.equal(supply.status,'ORDERED');
 assert.equal(x.order.items[0].supplyOrderedQty,2);
 assert.equal(x.invalidations(),1);
 await x.context.registerInitialSelfOrders('o',x.order);
 assert.equal([...x.docs.keys()].filter(key=>key.startsWith('supplyOrders/')).length,1);
 assert.equal(x.invalidations(),1);
});
test('retry of the same commitment does not duplicate it, including direct shipment',async()=>{
 const x=setup([{itemId:'a',procurementType:'SALES_SELF_ORDER',shortageQty:1,costPrice:20,supplier:'Vendor',productId:'p',fulfillmentType:'DIRECT_SHIP'}]);
 const details={supplier:'Vendor',qty:1,unitCost:20,orderDate:'2026-10-08'};
 await x.context.registerInitialSelfOrderSupply('o','a',details);
 await x.context.registerInitialSelfOrderSupply('o','a',details);
 assert.equal(x.docs.get('supplyOrders/self-o-a').warehouseId,'');
 assert.equal(x.docs.get('orders/o').items[0].supplyOrderedQty,1);
});

test('stock-covered self-order does not generate supplier demand or invalidate list',async()=>{
 const x=setup([{itemId:'a',procurementType:'SALES_SELF_ORDER',shortageQty:0,costPrice:2,supplier:'Vendor',productId:'p'}]);
 await x.context.registerInitialSelfOrders('o',x.order);
 assert.equal(x.invalidations(),0);
 assert.equal([...x.docs.keys()].filter(key=>key.startsWith('supplyOrders/')).length,0);
});
test('creation-time pending self-order shows sync exception, not a second routine action',()=>{
 assert.match(source,/autoSelfOrder = selfOrder && order\.selfOrderAtCreation === true/);
 assert.match(source,/自行訂貨同步失敗，請至訂單頁重試同步/);
 assert.match(source,/自行訂貨自動同步中/);
 assert.match(source,/補登異常訂貨/);
 assert.match(source,/自行訂貨已記錄為已採購，等待到貨/);
});
