const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../modules/fulfillment-core.js');

test('reserve 20 with 8 available => reserved 8 shortage 12', () => {
  const x=f.reserveFromAvailable({orderedQty:20},8);
  assert.equal(x.reservedQty,8); assert.equal(x.shortageQty,12);
});
test('full availability reserves all',()=>{const x=f.reserveFromAvailable({orderedQty:20},20);assert.equal(x.reservedQty,20);assert.equal(x.shortageQty,0);});
test('zero availability leaves full shortage',()=>{const x=f.reserveFromAvailable({orderedQty:20},0);assert.equal(x.reservedQty,0);assert.equal(x.shortageQty,20);});
test('partial receipt fills reservation immediately',()=>{const x=f.applyReceipt({orderedQty:20,reservedQty:8,receivedQty:0},5);assert.equal(x.receivedQty,5);assert.equal(x.reservedQty,13);assert.equal(x.shortageQty,7);});
test('dispatch paperwork gates shippable quantity',()=>{let x=f.reserveFromAvailable({orderedQty:20},8);assert.equal(f.pendingDispatchQty(x),8);assert.equal(f.shippableQty(x),0);x=f.prepareDispatch(x,8);assert.equal(f.shippableQty(x),8);});
test('dispatch cannot exceed reserved ready quantity',()=>{const x=f.prepareDispatch({orderedQty:20,reservedQty:8},99);assert.equal(x.dispatchPreparedQty,8);});
test('physical delivery consumes only prepared/reserved qty',()=>{let x=f.prepareDispatch({orderedQty:20,reservedQty:8},8);x=f.deliver(x,5);assert.equal(x.deliveredQty,5);assert.equal(x.reservedQty,3);assert.equal(f.shippableQty(x),3);});
test('source status derives from quantities',()=>{assert.equal(f.sourceStatus({orderedQty:20,reservedQty:20}),'有庫存');assert.equal(f.sourceStatus({orderedQty:20,reservedQty:8,supplyOrderedQty:12}),'已訂貨');assert.equal(f.sourceStatus({orderedQty:20,reservedQty:8}),'未訂貨');});
test('FEFO allocates earliest expiry first and computes actual COGS',()=>{const r=f.allocateLots([{id:'B',remainingQty:10,expiryDate:'2027-02-01',receivedAt:'2026-01-01',unitCost:120},{id:'A',remainingQty:10,expiryDate:'2027-01-01',receivedAt:'2026-02-01',unitCost:100}],15,true);assert.deepEqual(r.allocations.map(x=>[x.lotId,x.qty]),[['A',10],['B',5]]);assert.equal(r.cogs,1600);});
test('FIFO ignores expiry when product is not expiry-managed',()=>{const r=f.allocateLots([{id:'new',remainingQty:10,receivedAt:'2026-02-01',unitCost:120},{id:'old',remainingQty:10,receivedAt:'2026-01-01',unitCost:100}],12,false);assert.deepEqual(r.allocations.map(x=>[x.lotId,x.qty]),[['old',10],['new',2]]);});

test('completed prepared delivery exposes next reserved quantity for dispatch',()=>{const x={orderedQty:20,reservedQty:3,dispatchPreparedQty:5,deliveredQty:5};assert.equal(f.shippableQty(x),0);assert.equal(f.pendingDispatchQty(x),3);});
