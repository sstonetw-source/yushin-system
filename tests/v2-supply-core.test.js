const test=require('node:test');const assert=require('node:assert/strict');const s=require('../modules/supply-core.js');
test('purchaser creates formal PO and replenishment',()=>{assert.equal(s.canCreate('purchaser',s.TYPES.PURCHASING_PO),true);assert.equal(s.canCreate('purchaser',s.TYPES.STOCK_REPLENISHMENT),true);});
test('sales and engineer can self-order but cannot create formal PO',()=>{for(const r of ['sales','engineer']){assert.equal(s.canCreate(r,s.TYPES.SALES_SELF_ORDER),true);assert.equal(s.canCreate(r,s.TYPES.PURCHASING_PO),false);}});
test('self-order requires supplier cost qty and customer item link',()=>{const v=s.validate({type:s.TYPES.SALES_SELF_ORDER,qty:2,supplier:'X',unitCost:100,orderId:'o1',itemId:'i1'});assert.equal(v.valid,true);});
test('stock replenishment does not require customer order and never creates dispatch',()=>{const r={type:s.TYPES.STOCK_REPLENISHMENT,qty:10,supplier:'X'};assert.equal(s.validate(r).valid,true);assert.equal(s.createsCustomerDispatch(r),false);});
test('partial receipt preserves remaining quantity',()=>{const x=s.applyReceipt({type:s.TYPES.PURCHASING_PO,qty:12,receivedQty:0,supplier:'X',orderId:'o1',itemId:'i1'},5);assert.equal(x.appliedQty,5);assert.equal(x.record.receivedQty,5);assert.equal(x.record.remainingQty,7);assert.equal(x.record.status,'PARTIAL_RECEIPT');});
test('receipt cannot exceed ordered remainder',()=>{const x=s.applyReceipt({type:s.TYPES.PURCHASING_PO,qty:12,receivedQty:10,supplier:'X',orderId:'o1',itemId:'i1'},9);assert.equal(x.appliedQty,2);assert.equal(x.record.status,'RECEIVED');});

test('allocateLots uses FEFO and preserves actual lot cost',()=>{
 const result=s.allocateLots([
  {id:'late',expiryDate:'2027-12-01',receivedAt:'2026-01-01',remainingQty:10,unitCost:120},
  {id:'early',expiryDate:'2027-01-01',receivedAt:'2026-02-01',remainingQty:3,unitCost:100}
 ],5);
 assert.deepEqual(result.allocations.map(x=>[x.lotId,x.qty]),[['early',3],['late',2]]);
 assert.equal(result.totalCost,540);
});
test('allocateLots falls back to FIFO when expiry is absent',()=>{
 const result=s.allocateLots([
  {id:'b',receivedAt:'2026-02-01',remainingQty:5,unitCost:20},
  {id:'a',receivedAt:'2026-01-01',remainingQty:5,unitCost:10}
 ],6);
 assert.deepEqual(result.allocations.map(x=>[x.lotId,x.qty]),[['a',5],['b',1]]);
 assert.equal(result.totalCost,70);
});
test('allocateLots refuses quantity beyond available lots',()=>assert.throws(()=>s.allocateLots([{id:'a',remainingQty:2}],3),/不足/));
