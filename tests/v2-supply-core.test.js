const test=require('node:test');
const assert=require('node:assert/strict');
const s=require('../modules/supply-core.js');

test('purchaser controls supplier-order methods, not demand reasons',()=>{
  assert.equal(s.canCreate('purchaser',s.METHODS.PURCHASING_PO),true);
  assert.equal(s.canCreate('purchaser',s.METHODS.PURCHASING_MANUAL),true);
  assert.equal(s.canCreate('purchaser',s.SOURCES.STOCK_REPLENISHMENT),false);
});

test('formal PO can represent either sales demand or stock replenishment',()=>{
  const sales=s.normalize({
    method:s.METHODS.PURCHASING_PO,qty:2,orderId:'o1',itemId:'i1'
  });
  assert.equal(sales.method,s.METHODS.PURCHASING_PO);
  assert.equal(sales.type,s.METHODS.PURCHASING_PO);
  assert.equal(sales.sourceType,s.SOURCES.SALES_ORDER);
  assert.equal(sales.sourceId,'o1');
  assert.equal(sales.sourceItemId,'i1');

  const stock=s.normalize({
    method:s.METHODS.PURCHASING_PO,sourceType:s.SOURCES.STOCK_REPLENISHMENT,qty:5
  });
  assert.equal(stock.method,s.METHODS.PURCHASING_PO);
  assert.equal(stock.sourceType,s.SOURCES.STOCK_REPLENISHMENT);
  assert.equal(s.demandLabel(stock),'備庫採購');
});

test('manual purchasing method survives normalization',()=>{
  const x=s.normalize({method:s.METHODS.PURCHASING_MANUAL,qty:2,receivedQty:0});
  assert.equal(x.type,s.METHODS.PURCHASING_MANUAL);
  assert.equal(x.method,s.METHODS.PURCHASING_MANUAL);
  assert.equal(x.status,'ORDERED');
});

test('sales and engineer can self-order but cannot create formal PO',()=>{
  for(const role of ['sales','engineer']){
    assert.equal(s.canCreate(role,s.METHODS.SALES_SELF_ORDER),true);
    assert.equal(s.canCreate(role,s.METHODS.PURCHASING_PO),false);
  }
});

test('self-order requires supplier cost qty and sales-order source links',()=>{
  const valid=s.validate({
    method:s.METHODS.SALES_SELF_ORDER,sourceType:s.SOURCES.SALES_ORDER,
    qty:2,supplier:'X',unitCost:100,sourceId:'o1',sourceItemId:'i1'
  });
  assert.equal(valid.valid,true);
  const invalid=s.validate({
    method:s.METHODS.SALES_SELF_ORDER,sourceType:s.SOURCES.SALES_ORDER,
    qty:2,supplier:'X',unitCost:100
  });
  assert.equal(invalid.valid,false);
  assert.deepEqual(invalid.errors.sort(),['sourceId','sourceItemId']);
});

test('stock replenishment does not require customer order and never creates dispatch',()=>{
  const record={
    method:s.METHODS.PURCHASING_PO,
    sourceType:s.SOURCES.STOCK_REPLENISHMENT,
    qty:10,supplier:'X'
  };
  assert.equal(s.validate(record).valid,true);
  assert.equal(s.createsCustomerDispatch(record),false);
});

test('sales-order supply creates customer dispatch only with stable source links',()=>{
  assert.equal(s.createsCustomerDispatch({
    method:s.METHODS.PURCHASING_PO,
    sourceType:s.SOURCES.SALES_ORDER,
    qty:1,supplier:'X',sourceId:'o1',sourceItemId:'i1'
  }),true);
});

test('partial receipt delegates to receiving core and preserves source identity',()=>{
  const x=s.applyReceipt({
    method:s.METHODS.PURCHASING_PO,sourceType:s.SOURCES.SALES_ORDER,
    qty:12,receivedQty:0,supplier:'X',sourceId:'o1',sourceItemId:'i1'
  },5);
  assert.equal(x.appliedQty,5);
  assert.equal(x.record.receivedQty,5);
  assert.equal(x.record.remainingQty,7);
  assert.equal(x.record.status,'PARTIAL_RECEIPT');
  assert.equal(x.record.sourceType,s.SOURCES.SALES_ORDER);
  assert.equal(x.record.sourceId,'o1');
});

test('receipt cannot exceed ordered remainder',()=>{
  const x=s.applyReceipt({
    method:s.METHODS.PURCHASING_PO,sourceType:s.SOURCES.STOCK_REPLENISHMENT,
    qty:12,receivedQty:10,supplier:'X'
  },9);
  assert.equal(x.appliedQty,2);
  assert.equal(x.record.status,'RECEIVED');
});

test('supply core no longer owns inventory lot allocation',()=>{
  assert.equal(s.allocateLots,undefined);
  assert.equal(s.reverseLotAllocations,undefined);
  assert.equal(s.availableReturnAllocations,undefined);
});
