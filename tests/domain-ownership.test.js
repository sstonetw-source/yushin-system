'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const walk=dir=>fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(entry=>{
  const full=path.posix.join(dir,entry.name);
  return entry.isDirectory()?walk(full):entry.name.endsWith('.js')?[full]:[];
});
test('one stock transaction wrapper is owned by Infrastructure',()=>{
  const sources=walk('src');
  const declarations=sources.filter(file=>/\basync\s+function\s+runRoleTransaction\s*\(/.test(read(file)));
  assert.deepEqual(declarations,['src/infrastructure/stock-transaction.js']);
  const wrapper=read(declarations[0]);
  assert.match(wrapper,/YushinStockPermissions\.run\s*\(/);
  assert.match(wrapper,/assertSession\s*\(/);
});
test('order and receiving quantity projections delegate to domain core',()=>{
  assert.match(read('src/features/orders/order-workspace.js'),/YushinFulfillment\.projectOrderDelivery\s*\(/);
  assert.match(read('modules/fulfillment-core.js'),/function\s+projectOrderDelivery\s*\(/);
  assert.match(read('modules/receiving-core.js'),/workflow\.projectItem\s*\(/);
});

test('dispatch recording lives in the services layer, not order UI',()=>{
  const ui=read('src/features/orders/order-workspace.js');
  const start=ui.indexOf('window.markOrderItemDispatchPrepared =');
  const end=ui.indexOf('function canBusinessSelfOrder',start);
  assert.ok(start>=0&&end>start);
  const handler=ui.slice(start,end);
  assert.match(handler,/await\s+prepareOrderDispatch\s*\(/);
  assert.doesNotMatch(handler,/await\s+runRoleTransaction\s*\(/);
  assert.match(read('src/services/dispatch-preparation.js'),/async\s+function\s+prepareOrderDispatch\s*\(/);
});

test('billing UI delegates Firestore operations to the protected service',()=>{
  const ui=read('src/features/orders/order-status.js');
  assert.match(ui,/setOrderBillingStatus\s*\(/);
  assert.match(ui,/changeOrderBillingDate\s*\(/);
  assert.doesNotMatch(ui,/db\.collection\s*\(/);
  assert.doesNotMatch(ui,/runRoleTransaction\s*\(/);
  const svc=read('src/services/order-billing.js');
  assert.match(svc,/runRoleTransaction\s*\(/);
  assert.match(svc,/transaction\.get\s*\(/);
  assert.match(svc,/transaction\.update\s*\(/);
});

test('order lifecycle UI cannot directly write cancellation and restoration documents',()=>{
  const ui=read('src/features/orders/lifecycle-workspace.js');
  const start=ui.indexOf('window.quickSetOrderLifecycle =');
  const end=ui.indexOf('window.toggleOrderProgressStatus',start);
  assert.ok(start>=0&&end>start);
  const action=ui.slice(start,end);
  assert.match(action,/await\s+setOrderLifecycleStatus\s*\(/);
  assert.doesNotMatch(action,/runRoleTransaction\s*\(/);
  const service=read('src/services/order-lifecycle.js');
  assert.match(service,/runRoleTransaction\s*\(/);
  assert.match(service,/adjustInventoryReservationForLifecycle\s*\(/);
  assert.match(service,/transaction\.update\s*\(/);
});

test('lifecycle form and legacy delivery correction delegate all writes to services',()=>{
  const source=read('src/features/orders/delivery-actions.js');
  for(const [name,next,service] of [
    ['saveOrderLifecycleStatus','// Customer return mutations','setOrderLifecycleStatus'],
    ['clearLegacyDelivery','function lifecycleRecordId','clearOrderLegacyDeliveryEstimate']
  ]){
    const start=source.indexOf('window.'+name+' =');
    const end=source.indexOf(next,start);
    assert.ok(start>=0&&end>start);
    const action=source.slice(start,end);
    assert.match(action,new RegExp('await '+service+'\\('));
    assert.doesNotMatch(action,/runRoleTransaction\s*\(|db\.collection\s*\(/);
  }
});

test('all four order delivery actions delegate protected writes and the service does not read DOM',()=>{
  const ui=read('src/features/orders/delivery-actions.js');
  for(const [name,next,service] of [
    ['quickCompleteDelivery','window.quickCancelAllDelivery','completeOrderDelivery'],
    ['quickCancelAllDelivery','function renderDeliveryModal','cancelOrderDeliveries'],
    ['saveDeliveryRecord','window.deleteDeliveryRecord','saveOrderDeliveryRecord'],
    ['deleteDeliveryRecord','window.clearLegacyDelivery','correctOrderDeliveryRecord']
  ]){
    const start=ui.indexOf('window.'+name+' ='),end=ui.indexOf(next,start);
    assert.ok(start>=0&&end>start);
    const action=ui.slice(start,end);
    assert.match(action,new RegExp('await '+service+'\\('));
    assert.doesNotMatch(action,/runRoleTransaction\s*\(|db\.collection\s*\(/);
    assert.match(action,/pendingDeliveryOrderIds\.has\(orderId\)/);
  }
  const service=read('src/services/delivery-records.js');
  assert.doesNotMatch(service,/document\.|ordersCache|alert\(/);
  assert.match(service,/runRoleTransaction/);
});
test('single and batch warehouse shipments share one service and order-delivery core validation',()=>{
  const ui=read('modules/inventory-workspace.js'),batch=read('modules/warehouse-logistics.js');
  assert.doesNotMatch(ui,/async function commitInventoryShipment|runRoleTransaction\s*\(/);
  assert.match(ui,/await commitInventoryShipment\(/);
  assert.match(ui,/operationId,expectedWarehouseId,expectedPlan/);
  assert.match(batch,/await root\.commitInventoryShipment\(/);
  const declarations=walk('src').filter(file=>/async function commitInventoryShipment\(/.test(read(file)));
  assert.deepEqual(declarations,['src/services/warehouse-shipment.js']);
  const service=read(declarations[0]);
  assert.match(service,/assertOrderDeliveryIncrease\(/);
  assert.match(service,/orderDeliveryProjection\(/);
  assert.match(service,/deliveryRecordWasReversed\(/);
  assert.doesNotMatch(service,/document\.|ordersCache|itemDispatchState\(/);
});
