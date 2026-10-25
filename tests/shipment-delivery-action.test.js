'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const core=require('../modules/fulfillment-core');
const source=fs.readFileSync('src/features/orders/order-workspace.js','utf8');
const action=source.slice(source.indexOf('function orderContextActionState('),source.indexOf('\nfunction dispatchActionHtml('));
function fixture(){
 const identity={orderId:'O',itemId:'I',productKey:'P'};
 const a={...identity,id:'ship-A',warehouseId:'A',qty:4,date:'2026-10-20',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'};
 const b={...identity,id:'ship-B',warehouseId:'B',qty:5,date:'2026-10-21',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'};
 const delivered={...identity,id:'delivery-A',shipmentId:a.id,warehouseId:'A',qty:4,date:'2026-10-20',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'};
 const returned={...identity,id:'return-A',shipmentId:a.id,warehouseId:'A',qty:4,date:'2026-10-21',sourceType:'WAREHOUSE_CUSTOMER_RETURN',settlement:'CLOSE',condition:'RESTOCKABLE'};
 const order={id:'O',status:'normal',items:[{itemId:'I',productId:'P',qty:12,receivedQty:7}],
  warehouseShipmentRecords:[a,b],deliveryRecords:[delivered],returnRecords:[returned]};
 const c=vm.createContext({YUSHIN_V2_DELIVERY_EMULATOR:true,YushinFulfillment:core,
  normalizedOrderItems:o=>o.items,normalizedOrderStatus:o=>o.status,orderInventorySyncIncomplete:()=>false,
  itemDispatchState:()=>({shippable:0,grossDelivered:4,returned:4}),pendingV2DeliveryConfirmation:()=>null});
 vm.runInContext(action,c);return {c,order,identity};
}
test('original delivery action remains available after all prepared goods ship from another warehouse and CLOSE return',()=>{
 const f=fixture();assert.equal(f.c.orderContextActionState(f.order).showPartialDelivery,true);
 f.order.status='cancelled';assert.equal(f.c.orderContextActionState(f.order).showPartialDelivery,false);
});
test('fully acknowledged shipment has no new delivery action but retains the frozen result confirmation entry',()=>{
 const f=fixture();f.order.deliveryRecords.push({...f.identity,id:'delivery-B',shipmentId:'ship-B',warehouseId:'B',qty:5,
  date:'2026-10-22',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'});
 assert.equal(f.c.orderContextActionState(f.order).showPartialDelivery,false);
 f.c.pendingV2DeliveryConfirmation=()=>({operationId:'pending'});
 assert.equal(f.c.orderContextActionState(f.order).showPartialDelivery,true);
});
test('invalid shipment source, unsupported replacement and incomplete sync do not expose new confirmation',()=>{
 for(const mutate of [f=>f.order.warehouseShipmentRecords[1].warehouseId='',
  f=>f.order.returnRecords[0].settlement='REPLACE',f=>f.c.orderInventorySyncIncomplete=()=>true]){
  const f=fixture();mutate(f);assert.equal(f.c.orderContextActionState(f.order).showPartialDelivery,false);
 }
});
test('legacy gate keeps the original partly received and shippable action rule',()=>{
 const f=fixture();f.c.YUSHIN_V2_DELIVERY_EMULATOR=false;
 assert.equal(f.c.orderContextActionState(f.order).showPartialDelivery,false);
 f.c.itemDispatchState=()=>({shippable:1,grossDelivered:4,returned:0});
 assert.equal(f.c.orderContextActionState(f.order).showPartialDelivery,true);
});

function completedFormFixture(){
 const source=fs.readFileSync('src/features/orders/lifecycle-workspace.js','utf8');
 const code=source.slice(source.indexOf('window.openPartialDeliveryForm ='),source.indexOf('\nwindow.openPartialDeliveryForOrder ='));
 const fields={deliveryFormPanel:{style:{display:'none'}},deliveryQty:{value:''},deliveryDate:{focus(){}}},alerts=[];
 const c=vm.createContext({window:null,YUSHIN_V2_DELIVERY_EMULATOR:true,currentDeliveryOrderId:'O',
  ordersCache:[{id:'O',status:'normal'}],canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
  normalizedOrderStatus:o=>o.status,deliveryProgressInfo:()=>({remaining:0}),
  pendingV2DeliveryConfirmation:()=>({orderId:'O',quantity:3,shipmentId:'last',operationId:'frozen'}),
  document:{getElementById:id=>fields[id]},alert:s=>alerts.push(s),selectOrderProgressTab(){},
  renderDeliveryModal(){fields.deliveryQty.value='3';}});
 c.window=c;vm.runInContext(code,c);return {c,fields,alerts};
}
test('completed order can open its frozen successful-delivery confirmation after reload',()=>{
 const f=completedFormFixture();f.c.openPartialDeliveryForm();
 assert.equal(f.fields.deliveryFormPanel.style.display,'');assert.equal(f.fields.deliveryQty.value,'3');
 assert.deepEqual(f.alerts,[]);
});
test('completed order cannot open a new delivery or bypass cancelled legacy and mismatched-actor gates',()=>{
 for(const mutate of [f=>f.c.pendingV2DeliveryConfirmation=()=>null,
  f=>f.c.YUSHIN_V2_DELIVERY_EMULATOR=false,f=>f.c.ordersCache[0].status='cancelled',
  f=>f.c.pendingV2DeliveryConfirmation=()=>{throw Error('原帳號與角色不符');}]){
  const f=completedFormFixture();mutate(f);f.c.openPartialDeliveryForm();
  assert.equal(f.fields.deliveryFormPanel.style.display,'none');assert.equal(f.alerts.length,1);
 }
});
