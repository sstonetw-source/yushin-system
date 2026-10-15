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
