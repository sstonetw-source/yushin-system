const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const src = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');
const indexes = require('../firestore.indexes.json').indexes;
test('recent and pending owner queries have collection indexes', () => {
 for (const fields of [['ownerUid', 'orderDate'], ['ownerUid', 'status', 'orderDate']]) {
  assert.ok(indexes.some(index => index.collectionGroup === 'orders' && index.queryScope === 'COLLECTION'
   && JSON.stringify(index.fields.map(field => field.fieldPath)) === JSON.stringify(fields)
   && index.fields.at(-1).order === 'DESCENDING'));
 }
});
test('role switch invalidates pending order reads and clears failed loading state', () => {
 const start = src.indexOf('    ordersCache = [];', src.indexOf('window.switchViewRole ='));
 const end = src.indexOf('    forecastCache = [];', start);
 const context = vm.createContext({ordersCache:[{id:'old'}], orderPaginationState:{}, orderLoadGeneration:3,
  orderPageLoading:true, orderReloadRequested:true, orderLoadErrorMessage:'old error', orderWorkQueueError:'old error',
  orderWorkQueueCache:[{id:'old'}], orderWorkQueueReady:true, orderWorkQueueGeneration:2,
  orderWorkQueuePromise:Promise.resolve(), invalidateVisibleProductCosts(){}});
 vm.runInContext(src.slice(start,end),context);
 assert.equal(context.orderLoadGeneration,4);
 assert.equal(context.orderWorkQueueGeneration,3);
 assert.equal(context.orderPageLoading,false);
 assert.equal(context.orderReloadRequested,false);
 assert.equal(context.orderLoadErrorMessage,'');
 assert.equal(context.orderWorkQueueError,'');
 assert.equal(context.orderWorkQueuePromise,null);
 assert.equal(context.orderPaginationState,null);
});
