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
