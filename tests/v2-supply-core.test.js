const test=require('node:test');
const assert=require('node:assert/strict');
const s=require('../modules/supply-core.js');

test('purchaser creates formal PO manual order and replenishment',()=>{
  assert.equal(s.canCreate('purchaser',s.TYPES.PURCHASING_PO),true);
  assert.equal(s.canCreate('purchaser',s.TYPES.PURCHASING_MANUAL),true);
  assert.equal(s.canCreate('purchaser',s.TYPES.STOCK_REPLENISHMENT),true);
});

test('manual purchasing type survives normalization',()=>{
  const x=s.normalize({type:s.TYPES.PURCHASING_MANUAL,qty:2,receivedQty:0});
  assert.equal(x.type,s.TYPES.PURCHASING_MANUAL);
  assert.equal(x.status,'ORDERED');
});

test('sales and engineer can self-order but cannot create formal PO',()=>{
  for(const role of ['sales','engineer']){
    assert.equal(s.canCreate(role,s.TYPES.SALES_SELF_ORDER),true);
    assert.equal(s.canCreate(role,s.TYPES.PURCHASING_PO),false);
  }
});

test('self-order requires supplier cost qty and customer item link',()=>{
  const result=s.validate({
    type:s.TYPES.SALES_SELF_ORDER,qty:2,supplier:'X',unitCost:100,orderId:'o1',itemId:'i1'
  });
  assert.equal(result.valid,true);
});

test('stock replenishment does not require customer order and never creates dispatch',()=>{
  const record={type:s.TYPES.STOCK_REPLENISHMENT,qty:10,supplier:'X'};
  assert.equal(s.validate(record).valid,true);
  assert.equal(s.createsCustomerDispatch(record),false);
});

test('partial receipt delegates to receiving core',()=>{
  const x=s.applyReceipt({
    type:s.TYPES.PURCHASING_PO,qty:12,receivedQty:0,supplier:'X',orderId:'o1',itemId:'i1'
  },5);
  assert.equal(x.appliedQty,5);
  assert.equal(x.record.receivedQty,5);
  assert.equal(x.record.remainingQty,7);
  assert.equal(x.record.status,'PARTIAL_RECEIPT');
});

test('receipt cannot exceed ordered remainder',()=>{
  const x=s.applyReceipt({
    type:s.TYPES.PURCHASING_PO,qty:12,receivedQty:10,supplier:'X',orderId:'o1',itemId:'i1'
  },9);
  assert.equal(x.appliedQty,2);
  assert.equal(x.record.status,'RECEIVED');
});

test('supply core no longer owns inventory lot allocation',()=>{
  assert.equal(s.allocateLots,undefined);
  assert.equal(s.reverseLotAllocations,undefined);
  assert.equal(s.availableReturnAllocations,undefined);
});
