'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planAllocationBatch}=require('../functions/main-transfer-allocation-planner');
const row=(id,date,shortageQty)=>({id,orderId:id,itemId:'I',orderDate:date,shortageQty});
test('oldest shortages are bounded by free stock and receipt remainder',()=>{
 const result=planAllocationBatch([row('new','2026-10-20',4),row('old','2026-10-01',3)],5,4);
 assert.deepEqual(result.allocations.map(a=>[a.orderId,a.qty]),[['old',3],['new',1]]);
 assert.equal(result.allocatedQty,4);assert.equal(result.unallocatedQty,0);
});
test('batch limit preserves remainder for continuation',()=>{
 const result=planAllocationBatch([row('b','2026-10-02',2),row('a','2026-10-01',2)],4,4,1);
 assert.equal(result.allocatedQty,2);assert.equal(result.unallocatedQty,2);assert.equal(result.needsContinuation,true);
});
test('rejects negative quantities, duplicate candidates and oversized batches',()=>{
 assert.throws(()=>planAllocationBatch([row('x','2026-10-01',2)],-1,3));
 assert.throws(()=>planAllocationBatch([row('x','2026-10-01',2),row('x','2026-10-02',1)],3,3));
 assert.throws(()=>planAllocationBatch([row('x','2026-10-01',2)],3,3,16));
});

test('rejects malformed candidates even when earlier candidates exhaust the batch',()=>{
 const first=row('a','2026-10-01',1),bad=row('b','2026-10-02',-5);
 assert.throws(()=>planAllocationBatch([first,bad],1,1,1));
 assert.throws(()=>planAllocationBatch([first,{...first,orderDate:'2026-10-03'}],1,1,1));
});
