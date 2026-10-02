const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../modules/fulfillment-core.js');

test('reserve 20 with 8 available => reserved 8 shortage 12', () => {
  const x=f.reserveFromAvailable({orderedQty:20},8);
  assert.equal(x.reservedQty,8); assert.equal(x.shortageQty,12);
});
test('full availability reserves all',()=>{const x=f.reserveFromAvailable({orderedQty:20},20);assert.equal(x.reservedQty,20);assert.equal(x.shortageQty,0);});
test('zero availability leaves full shortage',()=>{const x=f.reserveFromAvailable({orderedQty:20},0);assert.equal(x.reservedQty,0);assert.equal(x.shortageQty,20);});
test('fulfillment core does not own receiving',()=>{assert.equal(f.applyReceipt,undefined);});
test('dispatch paperwork gates shippable quantity',()=>{let x=f.reserveFromAvailable({orderedQty:20},8);assert.equal(f.pendingDispatchQty(x),8);assert.equal(f.shippableQty(x),0);x=f.prepareDispatch(x,8);assert.equal(f.shippableQty(x),8);});

test('dispatch state is the single source for pending and shippable quantities',()=>{
  const state=f.dispatchState({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1});
  assert.deepEqual(state,{delivered:4,grossDelivered:5,returned:1,reserved:4,prepared:7,preparedOutstanding:2,shippable:2,pending:2});
  assert.equal(f.pendingDispatchQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
  assert.equal(f.shippableQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
});
test('dispatch cannot exceed reserved ready quantity',()=>{const x=f.prepareDispatch({orderedQty:20,reservedQty:8},99);assert.equal(x.dispatchPreparedQty,8);});
test('physical delivery consumes only prepared/reserved qty',()=>{let x=f.prepareDispatch({orderedQty:20,reservedQty:8},8);x=f.deliver(x,5);assert.equal(x.deliveredQty,5);assert.equal(x.reservedQty,3);assert.equal(f.shippableQty(x),3);});
test('fulfillment core does not own inventory lot allocation',()=>{assert.equal(f.allocateLots,undefined);});

test('completed prepared delivery exposes next reserved quantity for dispatch',()=>{const x={orderedQty:20,reservedQty:3,dispatchPreparedQty:5,deliveredQty:5};assert.equal(f.shippableQty(x),0);assert.equal(f.pendingDispatchQty(x),3);});


test('direct-ship replacement supply counters can exceed original ordered quantity after return',()=>{
  const x=f.normalizeItem({
    orderedQty:10,
    fulfillmentType:'DIRECT_SHIP',
    supplyOrderedQty:12,
    receivedQty:12,
    deliveredQty:10
  });
  assert.equal(x.supplyOrderedQty,12);
  assert.equal(x.receivedQty,12);
});

test('warehouse cumulative supply counters are preserved instead of silently truncated',()=>{
  const x=f.normalizeItem({orderedQty:5,supplyOrderedQty:7,receivedQty:6});
  assert.equal(x.supplyOrderedQty,7);
  assert.equal(x.receivedQty,6);
  assert.equal(x.reservedQty,0);
  assert.equal(x.shortageQty,5);
});


test('return replacement dispatch remains cumulative beyond original order quantity',()=>{
  let x=f.normalizeItem({
    orderedQty:10,
    reservedQty:2,
    dispatchPreparedQty:12,
    deliveredQty:10,
    returnedQty:2
  });
  assert.equal(x.dispatchPreparedQty,12);
  assert.equal(x.deliveredQty,10);
  assert.equal(x.returnedQty,2);
  assert.equal(x.reservedQty,2);
  assert.equal(x.shortageQty,0);
  assert.equal(f.shippableQty(x),2);

  x=f.deliver(x,2);
  assert.equal(x.deliveredQty,12);
  assert.equal(x.returnedQty,2);
  assert.equal(x.reservedQty,0);
  assert.equal(x.shortageQty,0);
  assert.equal(x.deliveredQty-x.returnedQty,10);
  assert.equal(x.shortageQty,0);
});

test('dispatchState is the single source for pending and shippable quantities',()=>{
  const state=f.dispatchState({
    orderedQty:10,
    reservedQty:4,
    dispatchPreparedQty:7,
    deliveredQty:5,
    returnedQty:1
  });
  assert.deepEqual(state,{
    delivered:4,
    grossDelivered:5,
    returned:1,
    reserved:4,
    prepared:7,
    preparedOutstanding:2,
    shippable:2,
    pending:2
  });
  assert.equal(f.pendingDispatchQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
  assert.equal(f.shippableQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
});


test('dispatchState keeps a later live reservation even when a lightweight snapshot omits ordered quantity',()=>{
  const state=f.dispatchState({
    reservedQty:5,
    dispatchPreparedQty:5,
    deliveredQty:5
  });
  assert.equal(state.pending,5);
  assert.equal(state.shippable,0);

  const ready=f.dispatchState({
    reservedQty:5,
    dispatchPreparedQty:10,
    deliveredQty:5
  });
  assert.equal(ready.pending,0);
  assert.equal(ready.shippable,5);
});