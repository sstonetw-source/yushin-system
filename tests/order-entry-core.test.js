const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');
const core=require('../modules/order-entry-core');const logistics=require('../modules/warehouse-logistics');
const item={itemId:'I',itemName:'試劑',productId:'P',productMasterMatched:true,qty:2,unitPrice:100,procurementType:'PURCHASING_PO',fulfillmentType:'WAREHOUSE',warehouseId:'MAIN',deliveryPlan:{mode:'PICKUP'}};
test('sale price is explicit: blank is rejected and zero is accepted',()=>{
 for(const value of [null,undefined,'','  ','bad',NaN,Infinity,-1])assert.equal(core.validateItem({...item,unitPrice:value}).valid,false);
 for(const value of [0,'0',100])assert.equal(core.validateItem({...item,unitPrice:value}).valid,true);
 for(const value of [0,-1,Infinity,NaN,'bad'])assert.equal(core.validateItem({...item,qty:value}).valid,false);
});
test('pending self-order can be saved without cost or supplier but confirmation requires both',()=>{
 const pending={...item,procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:false};
 assert.equal(core.validateItem(pending).valid,true);
 assert.equal(core.validateItem({...pending,selfOrderConfirmed:true}).field,'orderSelfSupplier');
 assert.equal(core.validateItem({...pending,selfOrderConfirmed:true,supplier:'Vendor'}).field,'orderCostPrice');
 assert.equal(core.validateItem({...pending,selfOrderConfirmed:true,supplier:'Vendor',costPrice:0}).valid,true);
 assert.equal(core.validateItem({...pending,costPrice:-1}).valid,false);
});
test('same product with different recipient, price, procurement mode or cost stays on separate lines',()=>{
 assert.equal(core.sameDraftItem(item,{...item}),true);
 for(const patch of [{unitPrice:0},{procurementType:'SALES_SELF_ORDER'},{fulfillmentType:'DIRECT_SHIP'},{costPrice:10},{selfOrderConfirmed:true},{deliveryPlan:{mode:'CUSTOMER_SHIP',address:'other'}}])assert.equal(core.sameDraftItem(item,{...item,...patch}),false);
});
test('copying an order retains customer-facing product settings but creates a new uncommitted item',()=>{
 const copied=core.copyItem({...item,selfOrderConfirmed:true,supplyOrderedQty:2,reservedQty:2,deliveredQty:2,dispatchPreparedQty:2,orderEvents:[{id:'old'}],transferPendingId:'T',warehouseShippedQty:2},{});
 assert.equal(copied.selfOrderConfirmed,false);assert.equal(copied.productId,'P');assert.equal(copied.unitPrice,100);
 for(const key of ['itemId','supplyOrderedQty','reservedQty','deliveredQty','dispatchPreparedQty','orderEvents','transferPendingId','warehouseShippedQty'])assert.equal(copied[key],undefined);
});
const source=fs.readFileSync('app.js','utf8');
function validationFixture(current=item,drafts=[]) {
 const nodes={orderOwnerUid:{value:'sales'},orderCustomer:{value:'台大',focus(){}},orderItemCode:{focus(){},scrollIntoView(){}},orderRecipientDetails:{open:false}};
 const alerts=[];
 const c=vm.createContext({window:{orderShippingInstructions:()=>({mode:'PICKUP'})},document:{getElementById:id=>nodes[id]},newOrderSaveInProgress:false,
  currentOrderModalItem:()=>({...current}),newOrderDraftItems:drafts,YushinOrderEntry:core,YushinWarehouseLogistics:logistics,
  currentUserRole:'sales',salesList:[{uid:'sales',name:'Sales'}],isSelectableCommercialOwner:()=>true,warehouseMasterCache:[{id:'MAIN'}],orderItemProductStatus:()=> 'matched',assertOrderItemCount(){},
  alert:s=>alerts.push(s),editNewOrderDraftItem:i=>nodes.edited=i});
 const start=source.indexOf('window.saveNewOrder = function()');const end=source.indexOf('    items.forEach(item=>{delete item.productCheckStatus;});',start);
 vm.runInContext(source.slice(start,end)+'return {items,shippingInstructions};};',c);
 return {c,nodes,alerts};
}
test('order creation requires customer and confirmed sale price; errors do not produce a validated order',()=>{
 let f=validationFixture();f.nodes.orderCustomer.value=' ';assert.equal(f.c.window.saveNewOrder(),undefined);assert.match(f.alerts[0],/客戶/);
 f=validationFixture({...item,unitPrice:null});assert.equal(f.c.window.saveNewOrder(),undefined);assert.match(f.alerts[0],/售價/);
 f=validationFixture({...item,unitPrice:0});assert.equal(f.c.window.saveNewOrder().items[0].unitPrice,0);
});
test('direct shipment requires the actual customer recipient and never accepts salesperson pickup',()=>{
 for(const plan of [{mode:'PICKUP'},{mode:'CUSTOMER_SHIP',contact:'C',phone:'123'},{mode:'CUSTOMER_SHIP',address:'A',phone:'123'}]) {
  const f=validationFixture({...item,fulfillmentType:'DIRECT_SHIP',warehouseId:'',deliveryPlan:plan});assert.equal(f.c.window.saveNewOrder(),undefined);assert.equal(f.nodes.orderRecipientDetails.open,true);
 }
 const f=validationFixture({...item,fulfillmentType:'DIRECT_SHIP',warehouseId:'',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶',phone:'123',address:'台北'}});
 assert.equal(f.c.window.saveNewOrder().shippingInstructions.contact,'客戶');
});
test('mixed order retains delivery instructions for every line and blocks a missing recipient on any line',()=>{
 const customer={...item,itemId:'J',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶',phone:'123',address:'台北'}};
 let f=validationFixture(item,[customer]);const result=f.c.window.saveNewOrder();
 assert.equal(result.items[0].deliveryPlan.address,'台北');assert.equal(result.items[1].deliveryPlan.mode,'PICKUP');
 f=validationFixture(item,[{...customer,deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶'}}]);assert.equal(f.c.window.saveNewOrder(),undefined);
});
test('normalized order fields retain missing price as null before save validation',()=>{
 const c=vm.createContext({findPriceItemForOrder:()=>null,normalizeHistoryItemCode:x=>x,resolveBrandName:x=>x,brandIdForName:x=>x});
 const a=source.indexOf('function normalizeNewOrderItem('),b=source.indexOf('function currentOrderModalItem()',a);vm.runInContext(source.slice(a,b),c);
 assert.equal(c.normalizeNewOrderItem({...item,unitPrice:''}).unitPrice,null);assert.equal(c.normalizeNewOrderItem({...item,unitPrice:0}).unitPrice,0);
});

test('changing the customer cannot reuse a previous customer recipient snapshot',()=>{
 const f=validationFixture({...item,deliveryCustomerName:'另一客戶',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶',phone:'123',address:'台北'}});
 assert.equal(f.c.window.saveNewOrder(),undefined);assert.match(f.alerts[0],/客戶已更換/);
});
test('purchaser can assist with pending entry but cannot confirm a salesperson self-order',()=>{
 const f=validationFixture({...item,procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:true,supplier:'Vendor',costPrice:0});
 f.c.currentUserRole='purchaser';assert.equal(f.c.window.saveNewOrder(),undefined);assert.match(f.alerts[0],/負責業務確認/);
});

test('trade information may be empty at creation but printing requires type and invoice title when applicable',()=>{
 assert.equal(core.validateTrade({}).valid,false);
 assert.equal(core.validateTrade({transactionType:'直'}).valid,false);
 assert.equal(core.validateTrade({transactionType:'直',invoiceTitle:'台大'}).valid,true);
 for(const transactionType of ['借','扣'])assert.equal(core.validateTrade({transactionType}).valid,true);
});

test('printing validates current transaction information before writing a dispatch record',async()=>{
 for(const trade of [{},{transactionType:'直'},{transactionType:'直',invoiceTitle:'台大'},{transactionType:'借'}]){
  const order={...trade,items:[{itemId:'I',qty:1}]};const writes=[],alerts=[];
  const c=vm.createContext({window:{},currentUser:{uid:'buyer'},currentUserRole:'purchaser',pendingDispatchOrderIds:new Set(),YushinOrderEntry:core,document:{getElementById:()=>null},ordersCache:[],currentDeliveryOrderId:null,
   db:{collection:()=>({doc:()=>({})})},runRoleTransaction:async fn=>fn({get:async()=>({exists:true,data:()=>order}),set:(...x)=>writes.push(x),update:(...x)=>writes.push(x)}),
   normalizedOrderStatus:()=> 'normal',normalizedOrderItems:o=>o.items,itemDispatchState:()=>({pending:1,prepared:0}),deliveryActor:()=> 'Buyer',orderWorkIndexFields:()=>({}),syncOrderIntoPurchasingCaches(){},writeAppDataCache(){},alert:x=>alerts.push(x)});
  vm.runInContext(fs.readFileSync('src/services/dispatch-preparation.js','utf8'),c);
  const a=source.indexOf('window.markOrderItemDispatchPrepared = async function'),b=source.indexOf('function canBusinessSelfOrder(',a);vm.runInContext(source.slice(a,b),c);
  await c.window.markOrderItemDispatchPrepared('O','I');
  assert.equal(writes.length,core.validateTrade(trade).valid?2:0);assert.equal(c.pendingDispatchOrderIds.size,0);
 }
});
test('invoice choice is for printing and does not block business billing confirmation',async()=>{
 const order={id:'O',transactionType:'借',isBilled:false,statusHistory:[]};const writes=[],alerts=[];
 const c=vm.createContext({window:{},YushinOrderEntry:core,ordersCache:[order],pendingOrderStatusKeys:new Set(),activeOrderWorkFilter:'all',currentUserName:'Sales',currentUser:null,currentDeliveryOrderId:null,
  canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,normalizedOrderStatus:()=> 'normal',orderBillingDate:()=>'',localDateString:()=> '2026-10-13',BUSINESS_STATUS:{ACTIVE:'active'},writeAppDataCache(){},renderOrdersList(){},alert:x=>alerts.push(x),
  firebase:{firestore:{FieldValue:{arrayUnion:x=>[x]}}},orderWorkIndexFields:()=>({}),
  db:{collection:()=>({doc:()=>({})})},runRoleTransaction:async fn=>fn({get:async()=>({exists:true,data:()=>({...order,transactionType:''})}),update:(...x)=>writes.push(x)})});
 const a=source.indexOf('window.toggleOrderStatus ='),b=source.indexOf('window.updateOrderBillingDate',a);vm.runInContext(source.slice(a,b),c);
 c.window.toggleOrderStatus('O','isBilled',true);await new Promise(r=>setImmediate(r));
 assert.equal(writes.length,1);assert.equal(order.isBilled,true);assert.equal(alerts.length,0);assert.equal(c.pendingOrderStatusKeys.size,0);
});
