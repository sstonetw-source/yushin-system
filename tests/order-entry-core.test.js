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
test('same product uses shared delivery while price, procurement mode or cost keeps lines separate',()=>{
 assert.equal(core.sameDraftItem(item,{...item}),true);
 for(const patch of [{unitPrice:0},{procurementType:'SALES_SELF_ORDER'},{costPrice:10},{selfOrderConfirmed:true}])assert.equal(core.sameDraftItem(item,{...item,...patch}),false);
 for(const patch of [{fulfillmentType:'DIRECT_SHIP'},{deliveryPlan:{mode:'CUSTOMER_SHIP',address:'other'}}])assert.equal(core.sameDraftItem(item,{...item,...patch}),true);
});
test('copying an order retains customer-facing product settings but creates a new uncommitted item',()=>{
 const copied=core.copyItem({...item,selfOrderConfirmed:true,supplyOrderedQty:2,reservedQty:2,deliveredQty:2,dispatchPreparedQty:2,orderEvents:[{id:'old'}],transferPendingId:'T',warehouseShippedQty:2},{});
 assert.equal(copied.selfOrderConfirmed,false);assert.equal(copied.productId,'P');assert.equal(copied.unitPrice,100);
 for(const key of ['itemId','supplyOrderedQty','reservedQty','deliveredQty','dispatchPreparedQty','orderEvents','transferPendingId','warehouseShippedQty'])assert.equal(copied[key],undefined);
});
const source=fs.readFileSync('app.js','utf8');
function validationFixture(current=item,drafts=[]) {
 const nodes={orderOwnerUid:{value:'sales'},orderCustomer:{value:'台大',focus(){}},orderItemCode:{focus(){},scrollIntoView(){}},orderRecipientDetails:{open:false},orderTradeDetails:{open:false},orderTransactionType:{value:'借',focus(){}},orderInvoiceTitle:{value:'',focus(){nodes.focused='orderInvoiceTitle';}},orderFulfillmentType:{value:current.fulfillmentType||'WAREHOUSE'},orderWarehouse:{value:'MAIN'}};
 const alerts=[];
 const c=vm.createContext({window:{orderShippingInstructions:()=>current.deliveryPlan||{mode:'PICKUP'}},document:{getElementById:id=>nodes[id]},newOrderSaveInProgress:false,
  currentOrderModalItem:()=>({...current}),MAX_ORDER_ITEMS:15,newOrderDraftItems:drafts,YushinWorkflow:require('../modules/workflow-core'),YushinOrderEntry:core,YushinWarehouseLogistics:logistics,
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
test('multiple goods lines share one delivery choice even if draft items had different shipping plans',()=>{
 const customer={...item,itemId:'J',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶',phone:'123',address:'台北'}};
 let f=validationFixture(item,[customer]);const result=f.c.window.saveNewOrder();
 assert.equal(result.items[0].deliveryPlan.mode,'PICKUP');assert.equal(result.items[1].deliveryPlan.mode,'PICKUP');
 assert.equal(result.items[0].warehouseId,'MAIN');assert.equal(result.items[1].warehouseId,'MAIN');
 f=validationFixture({...item,deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶'}},[customer]);assert.equal(f.c.window.saveNewOrder(),undefined);
 assert.match(f.alerts[0],/收件/);
});
test('Service-only orders do not demand a warehouse or fake physical delivery instructions',()=>{
 const service={...item,productType:'Service',productId:'BIOPLEX',
   warehouseId:'',deliveryPlan:{mode:'CUSTOMER_SHIP'}};
 const f=validationFixture(service);
 const result=f.c.window.saveNewOrder();
 assert.equal(f.alerts.length,0);
 assert.equal(result.items[0].warehouseId,'');
 assert.equal(Object.keys(result.items[0].deliveryPlan).length,0);
 assert.equal(Object.keys(result.shippingInstructions).length,0);
});

test('Goods plus Service validates shipping instructions only for goods',()=>{
 const service={...item,itemId:'SERVICE',productId:'BIOPLEX',
   productType:'Service',warehouseId:'',deliveryPlan:{mode:'CUSTOMER_SHIP'}};
 let f=validationFixture({...item,itemId:'GOODS',warehouseId:'MAIN',deliveryPlan:{mode:'PICKUP'}},[service]);
 const result=f.c.window.saveNewOrder();
 assert.equal(f.alerts.length,0);
 assert.equal(result.items[0].productType,'Service');
 assert.equal(result.items[0].warehouseId,'');
 assert.equal(result.items[1].warehouseId,'MAIN');
 assert.equal(result.shippingInstructions.mode,'PICKUP');
 f=validationFixture({...item,fulfillmentType:'DIRECT_SHIP',
  deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶',phone:'123',address:'台北'}},[service]);
 const direct=f.c.window.saveNewOrder();
 assert.equal(direct.items[0].fulfillmentType,'WAREHOUSE');
 assert.equal(direct.items[0].warehouseId,'');
 assert.equal(direct.items[1].fulfillmentType,'DIRECT_SHIP');
 assert.equal(f.alerts.length,0);
});

test('adding items does not require a delivery plan before the shared delivery section',()=>{
 const start=source.indexOf('window.addCurrentOrderItemToDraft=function()'),end=source.indexOf('window.openOrderModal',start);
 for(const productType of ['Service','Goods'])for(const fulfillmentType of ['WAREHOUSE','DIRECT_SHIP']){
  const row={...item,productType,fulfillmentType,deliveryPlan:{mode:'CUSTOMER_SHIP'},warehouseId:'STALE'};
  const nodes={},drafts=[],alerts=[];
  const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]||(nodes[id]={dataset:{},value:''})},
   currentOrderModalItem:()=>({...row}),MAX_ORDER_ITEMS:15,newOrderDraftItems:drafts,YushinWorkflow:require('../modules/workflow-core'),YushinOrderEntry:core,YushinWarehouseLogistics:logistics,
   orderItemProductStatus:()=> 'matched',alert:message=>alerts.push(message),renderNewOrderDraftItems(){},
   clearQuickProductButton(){},clearProductMatchChoices(){}});
  vm.runInContext(source.slice(start,end),c);c.window.addCurrentOrderItemToDraft();
  assert.equal(drafts.length,1);assert.deepEqual(alerts,[]);
  assert.equal(drafts[0].productType,productType);
 }
});

test('normalized order fields retain missing price as null before save validation',()=>{
 const c=vm.createContext({findPriceItemForOrder:()=>null,normalizeHistoryItemCode:x=>x,resolveBrandName:x=>x,brandIdForName:x=>x});
 const a=source.indexOf('function normalizeNewOrderItem('),b=source.indexOf('function currentOrderModalItem()',a);vm.runInContext(source.slice(a,b),c);
 assert.equal(c.normalizeNewOrderItem({...item,unitPrice:''}).unitPrice,null);assert.equal(c.normalizeNewOrderItem({...item,unitPrice:0}).unitPrice,0);
});

test('shared delivery replaces stale per-item customer snapshots when saving',()=>{
 const f=validationFixture({...item,deliveryCustomerName:'另一客戶',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶',phone:'123',address:'台北'}});
 const result=f.c.window.saveNewOrder();
 assert.equal(result.items[0].deliveryCustomerName,'台大');
 assert.equal(result.items[0].deliveryPlan.address,'台北');
});
test('editing a draft item does not replace the order-wide delivery selection',()=>{
 const nodes=new Map(),element=id=>{
  if(!nodes.has(id))nodes.set(id,{value:'',dataset:{}});
  return nodes.get(id);
 };
 element('orderFulfillmentType').value='DIRECT_SHIP';
 element('orderDeliveryChoice').value='DIRECT';
 const c=vm.createContext({window:{syncOrderEntrySelfStatus(){}},document:{getElementById:element},
  normalizeNewOrderItem:row=>row,normalizeItemCodeLoose:x=>x,normalizeBrandLookupKey:x=>x,resolveBrandName:x=>x,
  selectBrandInDropdown:(node,value)=>{node.value=value;},onOrderBrandSelectChange(){},onOrderProcurementTypeChange(){},onOrderItemCodeChange(){},refreshOrderWarehouseStock(){}});
 vm.runInContext(source.slice(source.indexOf('function setOrderModalItem('),source.indexOf('function restoreSavedOrderDraft(')),c);
 c.setOrderModalItem({...item,itemCode:'SKU',fulfillmentType:'WAREHOUSE',deliveryPlan:{mode:'PICKUP'}});
 assert.equal(element('orderFulfillmentType').value,'DIRECT_SHIP');
 assert.equal(element('orderDeliveryChoice').value,'DIRECT');
});
test('purchaser can assist with pending entry but cannot confirm a salesperson self-order',()=>{
 const f=validationFixture({...item,procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:true,supplier:'Vendor',costPrice:0});
 f.c.currentUserRole='purchaser';assert.equal(f.c.window.saveNewOrder(),undefined);assert.match(f.alerts[0],/負責業務確認/);
});

test('direct invoice title is required at order creation and printing',()=>{
 assert.equal(core.validateTrade({}).valid,false);
 for(const invoiceTitle of [undefined,'','   '])assert.equal(core.validateTrade({transactionType:'直',invoiceTitle}).field,'orderInvoiceTitle');
 assert.equal(core.validateTrade({transactionType:'直',invoiceTitle:'台大'}).valid,true);
 for(const transactionType of ['借','扣'])assert.equal(core.validateTrade({transactionType}).valid,true);
});

test('new order form refuses missing or invalid transaction type and opens the required section',()=>{
 for(const type of ['', '之後確認', '其他']){
  const f=validationFixture();f.nodes.orderTransactionType.value=type;
  assert.equal(f.c.window.saveNewOrder(),undefined);assert.equal(f.nodes.orderTradeDetails.open,true);
  assert.match(f.alerts[0],/交易方式/);
 }
 for(const transactionType of ['借','扣']){
  const f=validationFixture();f.nodes.orderTransactionType.value=transactionType;
  assert.ok(f.c.window.saveNewOrder());
  assert.equal(core.validateTrade({transactionType}).valid,true);
 }
 const direct=validationFixture();direct.nodes.orderTransactionType.value='直';
 assert.equal(direct.c.window.saveNewOrder(),undefined);
 assert.match(direct.alerts[0],/發票抬頭/);
 assert.equal(direct.nodes.focused,'orderInvoiceTitle');
 direct.nodes.orderInvoiceTitle.value='  台大醫院  ';
 assert.ok(direct.c.window.saveNewOrder());
 assert.equal(core.validateTrade({transactionType:'直',invoiceTitle:direct.nodes.orderInvoiceTitle.value}).valid,true);
});
test('printing validates current transaction information before writing a dispatch record',async()=>{
 for(const trade of [{},{transactionType:'直'},{transactionType:'直',invoiceTitle:'台大'},{transactionType:'借'}]){
  const order={id:'O',...trade,items:[{itemId:'I',qty:1}]};const writes=[],alerts=[];const storage=new Map();
  const c=vm.createContext({window:{},currentUser:{uid:'buyer'},currentUserRole:'purchaser',pendingDispatchOrderIds:new Set(),YushinOrderEntry:core,document:{getElementById:()=>null},ordersCache:[order],purchasingDispatchCache:[],currentDeliveryOrderId:null,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   db:{collection:n=>({doc:id=>({id:id||'AAAAAAAAAAAAAAAAAAAA',path:n+'/'+id})})},runRoleTransaction:async fn=>fn({get:async r=>({exists:r.path.startsWith('orders/'),data:()=>order}),set:(...x)=>writes.push(x),update:(...x)=>writes.push(x)}),
   normalizedOrderStatus:()=> 'normal',normalizedOrderItems:o=>o.items,itemDispatchState:()=>({pending:1,prepared:0}),deliveryActor:()=> 'Buyer',orderWorkIndexFields:()=>({}),syncOrderIntoPurchasingCaches(){},writeAppDataCache(){},alert:x=>alerts.push(x)});
  vm.runInContext(fs.readFileSync('src/services/dispatch-preparation.js','utf8'),c);
  const a=source.indexOf('function dispatchPreparationStorageKey('),b=source.indexOf('function canBusinessSelfOrder(',a);vm.runInContext(source.slice(a,b),c);
  await c.window.markOrderItemDispatchPrepared('O','I');
  assert.equal(writes.length,core.validateTrade(trade).valid?2:0);assert.equal(c.pendingDispatchOrderIds.size,0);
 }
});
test('invoice choice is for printing and does not block business billing confirmation',async()=>{
 const order={id:'O',transactionType:'借',isBilled:false,statusHistory:[]};const writes=[],alerts=[];
 const c=vm.createContext({window:{},YushinOrderEntry:core,ordersCache:[order],pendingOrderStatusKeys:new Set(),pendingOrderReservationIds:new Set(),activeOrderWorkFilter:'all',currentUserName:'Sales',currentUser:null,currentDeliveryOrderId:null,
  canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,normalizedOrderStatus:()=> 'normal',orderBillingDate:()=>'',localDateString:()=> '2026-10-13',BUSINESS_STATUS:{ACTIVE:'active'},writeAppDataCache(){},renderOrdersList(){},alert:x=>alerts.push(x),
  firebase:{firestore:{FieldValue:{arrayUnion:x=>[x]}}},orderWorkIndexFields:()=>({}),
  db:{collection:()=>({doc:()=>({})})},runRoleTransaction:async fn=>fn({get:async()=>({exists:true,data:()=>({...order,isBilled:false,transactionType:''})}),update:(...x)=>writes.push(x)})});
 vm.runInContext(fs.readFileSync('src/services/order-billing.js','utf8'),c);
 const a=source.indexOf('window.toggleOrderStatus ='),b=source.indexOf('window.updateOrderBillingDate',a);vm.runInContext(source.slice(a,b),c);
 c.window.toggleOrderStatus('O','isBilled',true);await new Promise(r=>setImmediate(r));
 assert.equal(writes.length,1);assert.equal(order.isBilled,true);assert.equal(alerts.length,0);assert.equal(c.pendingOrderStatusKeys.size,0);
});
