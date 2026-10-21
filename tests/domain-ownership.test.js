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
test('receiving Service owns transactions, not DOM, browser task storage or UI caches',()=>{
  const service=read('src/services/receiving.js');
  assert.doesNotMatch(service,/\bwindow\b|\bdocument\b|\bsessionStorage\b|\blocalStorage\b|\balert\s*\(/);
  assert.doesNotMatch(service,/\b\w*Cache\b|invalidateWarehouseStockCache|refreshAffectedOrderCaches|renderReceiptTasks|showActionFeedback/);
  assert.match(service,/async function receiveSupplyOrderRecord\(/);
  assert.match(service,/async function allocateFreeReceiptStockToShortages\(/);
  assert.match(service,/options\.onStockCommitted\?\.\(/);
  assert.match(service,/runRoleTransaction/);
});
test('receiving Feature owns task snapshots and presentation, without Firestore writes',()=>{
  const feature=read('src/features/purchasing/receiving-workspace.js');
  assert.match(feature,/window\.savePoReceiptBatch/);
  assert.match(feature,/sessionStorage\.setItem/);
  assert.match(read('src/features/orders/order-workspace.js'),/async function refreshAffectedOrderCaches/);
  assert.match(feature,/await receiveSupplyOrderRecord\([\s\S]*onStockCommitted:invalidateWarehouseStockCache/);
  assert.doesNotMatch(feature,/runRoleTransaction|db\.runTransaction|db\.batch|tx\.(?:set|update|delete)\(/);
  assert.doesNotMatch(feature,/db\.collection\(/);
});
test('receipt APIs and task workspace each have one owner in the generated source manifest',()=>{
  const sources=walk('src');
  for(const name of ['receiveSupplyOrderRecord','allocateFreeReceiptStockToShortages']){
    assert.deepEqual(sources.filter(file=>new RegExp('async function '+name+'\\(').test(read(file))),['src/services/receiving.js']);
  }
  assert.deepEqual(sources.filter(file=>/async function refreshAffectedOrderCaches\(/.test(read(file))),['src/features/orders/order-workspace.js']);
  const manifest=JSON.parse(read('tools/build-app.cjs').match(/const parts = (\[[\s\S]*?\]);/)[1]);
  assert.equal(manifest[manifest.indexOf('src/services/receiving.js')+1],'src/features/purchasing/receiving-workspace.js');
});
test('free-stock and transfer Features explicitly wire postcommit cache notifications',()=>{
  assert.match(read('modules/free-stock-recovery.js'),/allocate:\(\.\.\.args\)=>allocateFreeReceiptStockToShortages\(\.\.\.args,invalidateWarehouseStockCache\)/);
  assert.match(read('modules/warehouse-logistics.js'),/commitWarehouseTransferReceipt\(id,\{onStockCommitted:invalidateWarehouseStockCache\}\)/);
  assert.match(read('src/services/warehouse-transfer.js'),/assertActor,onStockCommitted\)/);
});
test('supply Service owns incoming, cancellation and finalization without editor or UI state',()=>{
  const service=read('src/services/supply-order.js');
  assert.doesNotMatch(service,/\b(?:window|document)\s*(?:\.|\[)|\b(?:sessionStorage|localStorage)\b|\b(?:alert|prompt)\s*\(/);
  assert.doesNotMatch(service,/\b\w*Cache\b|invalidateWarehouseStockCache|invalidateProcurementDemandQueue|purchaseCancellationInProgress|updatePoSaveButton|\blet poItems\b/);
  for(const name of ['registerPurchaseIncoming','cancelOutstandingSupplyRecord','stopPurchaseOrderOutstanding']){
    assert.match(service,new RegExp('async function '+name+'\\('));
    assert.deepEqual(walk('src').filter(file=>new RegExp('async function '+name+'\\(').test(read(file))),['src/services/supply-order.js']);
  }
  assert.match(service,/const actor=\{actorUid,actorRole,onStockCommitted,onDemandChanged\}/);
});
test('purchase cancellation Feature delegates both write paths and editor owns its presentation state',()=>{
  const feature=read('src/features/purchasing/purchase-cancellation-workspace.js');
  assert.match(feature,/await cancelOutstandingSupplyRecord\(/);
  assert.match(feature,/await stopPurchaseOrderOutstanding\(/);
  assert.match(feature,/onStockCommitted:invalidateWarehouseStockCache,onDemandChanged:invalidateProcurementDemandQueue/);
  assert.doesNotMatch(feature,/runRoleTransaction|db\.runTransaction|db\.batch|tx\.(?:set|update|delete)\(/);
  assert.doesNotMatch(feature,/db\.collection\([^\n]*\)\.(?:set|update|add|delete)\(/);
  const editor=read('src/features/purchasing/purchase-order-editor.js');
  assert.match(editor,/let poItems = \[\]/);assert.match(editor,/function updatePoSaveButton\(/);
  assert.doesNotMatch(editor,/registerPurchaseIncoming\(/);
  assert.match(read('src/features/purchasing/formal-purchase-recovery.js'),/await registerPurchaseIncoming\(/);
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
test('warehouse transfer dispatch and receipt are owned by one service, not the logistics UI',()=>{
 const ui=read('modules/warehouse-logistics.js');
 assert.doesNotMatch(ui,/async function commitWarehouseTransfer|function writeTransferLots/);
 for(const name of ['commitWarehouseTransfer','commitWarehouseTransferReceipt','writeTransferLots']){
   const declarations=walk('src').filter(file=>new RegExp('function '+name+'\\(').test(read(file)));
   assert.deepEqual(declarations,['src/services/warehouse-transfer.js']);
 }
 const service=read('src/services/warehouse-transfer.js');
 assert.match(service,/runRoleTransaction/);assert.doesNotMatch(service,/document\.|alert\(|showActionFeedback/);
 assert.match(service,/YushinFulfillment\.deliveryQuantities\(item\)/);
 assert.match(ui,/handoff:true,expectedWarehouseId:row.warehouseId,expectedPlan:savedRowPlan\(row\)/);
});
test('main transfer request UI delegates writes and both stock hold transitions use the same core',()=>{
 const ui=read('modules/main-warehouse-transfers.js');
 assert.doesNotMatch(ui,/runRoleTransaction|root\.createMainTransferRequest\s*=/);
 assert.match(ui,/await cancelMainTransferRequestRecord\(id\)/);
 const service=read('src/services/main-transfer-request.js');
 assert.match(service,/async function createMainTransferRequest\(/);
 assert.match(service,/async function cancelMainTransferRequestRecord\(/);
 assert.equal((service.match(/YushinReservation\.planMainTransferHold\(/g)||[]).length,2);
 assert.doesNotMatch(service,/document\.|showActionFeedback|confirm\(/);
});
test('automatic and manual self-orders share one supplier commitment transaction, with no UI writes',()=>{
 const ui=read('src/features/orders/order-workspace.js');
 const start=ui.indexOf('window.saveSelfOrder ='),end=ui.indexOf('function isDeletableOrderDraft',start);
 const action=ui.slice(start,end);
 assert.match(action,/await commitSelfOrderSupply\(/);assert.doesNotMatch(action,/runRoleTransaction|tx\.set\(/);
 const service=read('src/services/self-order-supply.js');
 assert.equal((service.match(/runRoleTransaction\(/g)||[]).length,1);
 assert.match(service,/registerInitialSelfOrderSupply[\s\S]*commitSelfOrderSupply/);
 assert.doesNotMatch(service,/document\.|ordersCache|alert\(/);
});
