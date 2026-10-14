const test=require('node:test');const assert=require('node:assert/strict');const r=require('../modules/reservation-core.js');
test('allocates replenishment to oldest shortage first',()=>{const p=r.planShortageAllocation([{id:'b',orderId:'o2',itemId:'i1',orderDate:'2026-09-02',shortageQty:4},{id:'a',orderId:'o1',itemId:'i1',orderDate:'2026-09-01',shortageQty:5}],6);assert.deepEqual(p.allocations,[{orderId:'o1',itemId:'i1',reservationId:'a',qty:5},{orderId:'o2',itemId:'i1',reservationId:'b',qty:1}]);assert.equal(p.allocatedQty,6);});
test('does not over reserve',()=>{const p=r.planShortageAllocation([{id:'a',orderId:'o1',itemId:'i1',shortageQty:2}],10);assert.equal(p.allocatedQty,2);assert.equal(p.remainingQty,8);});
test('ignores fulfilled reservation',()=>{const p=r.planShortageAllocation([{id:'a',shortageQty:0},{id:'b',orderId:'o2',itemId:'i2',shortageQty:3}],2);assert.equal(p.allocations.length,1);assert.equal(p.allocations[0].reservationId,'b');});

test('receipt allocation compatibility API keeps reservation id',()=>{const p=r.allocateReceiptToShortages([{id:'r1',orderId:'o1',itemId:'i1',orderDate:'2026-09-01',shortageQty:3}],2);assert.deepEqual(p.allocations,[{orderId:'o1',itemId:'i1',reservationId:'r1',id:'r1',qty:2}]);assert.equal(p.unallocatedQty,0);});


test('same-stock reservation preserves existing quantity and reserves only free stock',()=>{
  const p=r.planReservation({requestedQty:10,existingQty:4,sameStock:true,availableQty:3});
  assert.deepEqual(
    {preserved:p.preservedQty,release:p.releaseQty,additional:p.additionalReserveQty,reserved:p.reservedQty,shortage:p.shortageQty},
    {preserved:4,release:0,additional:3,reserved:7,shortage:3}
  );
});

test('shrinking a reservation releases the excess from the same stock',()=>{
  const p=r.planReservation({requestedQty:5,existingQty:8,sameStock:true,availableQty:10});
  assert.deepEqual(
    {preserved:p.preservedQty,release:p.releaseQty,additional:p.additionalReserveQty,reserved:p.reservedQty,shortage:p.shortageQty},
    {preserved:5,release:3,additional:0,reserved:5,shortage:0}
  );
});

test('moving a reservation releases all old stock before reserving the new stock',()=>{
  const p=r.planReservation({requestedQty:6,existingQty:5,sameStock:false,availableQty:4});
  assert.deepEqual(
    {preserved:p.preservedQty,release:p.releaseQty,additional:p.additionalReserveQty,reserved:p.reservedQty,shortage:p.shortageQty},
    {preserved:0,release:5,additional:4,reserved:4,shortage:2}
  );
});

test('stock in another branch prevents false new-order procurement',()=>{
 const rows=[{warehouseId:'MAIN',availableQty:0},{warehouseId:'EXT',availableQty:5}];
 const selected=r.chooseWarehouseForReservation({requestedQty:3,preferredWarehouseId:'MAIN',warehouses:rows,companyAvailableQty:5});
 assert.equal(selected,'EXT');
 const plan=r.planReservation({requestedQty:3,availableQty:5,sameStock:false});
 assert.equal(plan.reservedQty,3);assert.equal(plan.shortageQty,0);
});
test('prefer default warehouse when sufficient; do not read or use custody as a source',()=>{
 const pick=r.chooseWarehouseForReservation({requestedQty:2,preferredWarehouseId:'MAIN',warehouses:[{warehouseId:'MAIN',availableQty:2}],companyAvailableQty:2});
 assert.equal(pick,'MAIN');
});
test('single branch partial stock only creates genuinely uncovered demand',()=>{
 const selected=r.chooseWarehouseForReservation({requestedQty:5,preferredWarehouseId:'MAIN',warehouses:[{warehouseId:'MAIN',availableQty:0},{warehouseId:'EXT',availableQty:3}],companyAvailableQty:3});
 assert.equal(selected,'EXT');
 const plan=r.planReservation({requestedQty:5,availableQty:3});
 assert.equal(plan.shortageQty,2);
});
test('multi-warehouse stock must be transferred rather than silently purchased again',()=>{
 assert.throws(()=>r.chooseWarehouseForReservation({requestedQty:5,preferredWarehouseId:'MAIN',warehouses:[{warehouseId:'MAIN',availableQty:2},{warehouseId:'EXT',availableQty:3}],companyAvailableQty:5}),/調撥/);
});
test('a held reservation keeps its original source warehouse on retry',()=>{
 const actual=r.chooseWarehouseForReservation({requestedQty:4,preferredWarehouseId:'MAIN',existingWarehouseId:'EXT',existingQty:4,warehouses:[{warehouseId:'EXT',availableQty:0}],companyAvailableQty:0});
 assert.equal(actual,'EXT');
});
test('global and branch totals mismatch must not silently become a purchase',()=>{
 assert.throws(()=>r.chooseWarehouseForReservation({requestedQty:2,preferredWarehouseId:'MAIN',warehouses:[{warehouseId:'MAIN',availableQty:0},{warehouseId:'EXT',availableQty:0}],companyAvailableQty:2}),/核對分倉庫存/);
});
