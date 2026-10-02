const test=require('node:test');
const assert=require('node:assert/strict');
const inventory=require('../modules/inventory-core.js');

test('stock projection derives available quantity from on-hand and reserved',()=>{
  assert.deepEqual(inventory.normalizeStock({onHand:12,reserved:5,incoming:7}),{
    onHand:12,reserved:5,available:7,incoming:7
  });
});

test('stock projection never exposes negative available quantity',()=>{
  assert.equal(inventory.normalizeStock({onHand:2,reserved:5}).available,0);
});

test('allocateLots uses FEFO and preserves actual lot cost',()=>{
  const result=inventory.allocateLots([
    {id:'late',expiryDate:'2027-12-01',receivedAt:'2026-01-01',remainingQty:10,unitCost:120},
    {id:'early',expiryDate:'2027-01-01',receivedAt:'2026-02-01',remainingQty:3,unitCost:100}
  ],5);
  assert.deepEqual(result.allocations.map(x=>[x.lotId,x.qty]),[['early',3],['late',2]]);
  assert.equal(result.totalCost,540);
});

test('allocateLots falls back to FIFO when expiry is absent',()=>{
  const result=inventory.allocateLots([
    {id:'b',receivedAt:'2026-02-01',remainingQty:5,unitCost:20},
    {id:'a',receivedAt:'2026-01-01',remainingQty:5,unitCost:10}
  ],6);
  assert.deepEqual(result.allocations.map(x=>[x.lotId,x.qty]),[['a',5],['b',1]]);
  assert.equal(result.totalCost,70);
});

test('allocateLots refuses quantity beyond available lots',()=>{
  assert.throws(()=>inventory.allocateLots([{id:'a',remainingQty:2}],3),/不足/);
});

test('reverseLotAllocations restores the latest exact lots and cost',()=>{
  const result=inventory.reverseLotAllocations([{id:'delivery-1',qty:8,lotAllocations:[
    {lotId:'A',qty:5,unitCost:100},{lotId:'B',qty:3,unitCost:120}
  ]}],4);
  assert.deepEqual(result.allocations.map(x=>[x.lotId,x.qty]),[['B',3],['A',1]]);
  assert.equal(result.totalCost,460);
});

test('reverseLotAllocations refuses an untraceable reversal',()=>{
  assert.throws(()=>inventory.reverseLotAllocations([{qty:5,lotAllocations:[]}],5),/原始出貨批次/);
});

test('allocationsAfterReversal keeps delivery lots aligned',()=>{
  const remaining=inventory.allocationsAfterReversal(
    [{lotId:'A',qty:5,unitCost:100,cost:500},{lotId:'B',qty:3,unitCost:120,cost:360}],
    [{lotId:'B',qty:3},{lotId:'A',qty:1}]
  );
  assert.deepEqual(remaining.map(x=>[x.lotId,x.qty,x.cost]),[['A',4,400]]);
});

test('availableReturnAllocations excludes lots already returned',()=>{
  const deliveries=[{lotAllocations:[
    {lotId:'A',qty:5,unitCost:100,cost:500},
    {lotId:'B',qty:3,unitCost:120,cost:360}
  ]}];
  const returns=[{lotAllocations:[{lotId:'B',qty:2,unitCost:120,cost:240}]}];
  assert.deepEqual(
    inventory.availableReturnAllocations(deliveries,returns).map(x=>[x.lotId,x.qty]),
    [['A',5],['B',1]]
  );
});
