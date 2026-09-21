const test=require('node:test');const assert=require('node:assert/strict');
const f=require('../modules/fulfillment-core.js');

test('reserve partial stock',()=>assert.deepEqual(f.reserve(20,8),{reservedQty:8,shortageQty:12}));
test('reserve enough stock',()=>assert.deepEqual(f.reserve(20,20),{reservedQty:20,shortageQty:0}));
test('reserve zero stock',()=>assert.deepEqual(f.reserve(20,0),{reservedQty:0,shortageQty:20}));
test('partial receipt immediately reserves outstanding customer quantity',()=>{
 const x=f.applyReceipt({qty:20,reservedQty:8,receivedQty:0},5);
 assert.equal(x.receivedQty,5);assert.equal(x.reservedQty,13);assert.equal(x.shortageQty,7);
});
test('second receipt completes shortage',()=>{
 let x=f.applyReceipt({qty:20,reservedQty:8},5);x=f.applyReceipt(x,7);
 assert.equal(x.reservedQty,20);assert.equal(x.shortageQty,0);assert.equal(x.receivedQty,12);
});
test('dispatch paperwork gates shippable quantity',()=>{
 let x=f.normalizeItem({qty:20,reservedQty:8});
 assert.equal(f.pendingDispatchQty(x),8);assert.equal(f.shippableQty(x),0);
 x=f.prepareDispatch(x,5);assert.equal(f.shippableQty(x),5);
});
test('cannot prepare more than ready quantity',()=>{
 assert.throws(()=>f.prepareDispatch({qty:20,reservedQty:8},9),/8/);
});
test('delivery cannot exceed prepared quantity',()=>{
 assert.throws(()=>f.deliver({qty:20,reservedQty:8,dispatchPreparedQty:5},6),/5/);
});
test('delivery reduces reserved quantity',()=>{
 const x=f.deliver({qty:20,reservedQty:8,dispatchPreparedQty:5},5);
 assert.equal(x.deliveredQty,5);assert.equal(x.reservedQty,3);
});
test('multi item aggregation is independent',()=>{
 const a=f.aggregate([{qty:10,reservedQty:10},{qty:20,reservedQty:8,supplyOrderedQty:12}]);
 assert.deepEqual(a,{orderedQty:30,reservedQty:18,shortageQty:12,supplyOrderedQty:12,receivedQty:0,dispatchPreparedQty:0,deliveredQty:0,returnedQty:0});
});
test('business supply status derives from quantities',()=>{
 assert.equal(f.supplyStatus({qty:5,reservedQty:5}).label,'有庫存');
 assert.equal(f.supplyStatus({qty:5,reservedQty:0,supplyOrderedQty:5}).label,'已訂貨');
 assert.equal(f.supplyStatus({qty:5,reservedQty:0}).label,'未訂貨');
});

test('delivered prepared quantity no longer blocks next reserved quantity from dispatch',()=>{
 const x={qty:20,reservedQty:3,dispatchPreparedQty:5,deliveredQty:5};
 assert.equal(f.pendingDispatchQty(x),3);
 assert.equal(f.shippableQty(x),0);
});
