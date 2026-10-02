const test=require('node:test');
const assert=require('node:assert/strict');
const receiving=require('../modules/receiving-core.js');

test('partial receipt owns receipt status and remaining quantity',()=>{
  const result=receiving.applyReceipt({qty:10,receivedQty:2,incomingRegisteredQty:8,status:'ORDERED'},3);
  assert.equal(result.appliedQty,3);
  assert.equal(result.incomingReleaseQty,3);
  assert.equal(result.record.receivedQty,5);
  assert.equal(result.record.remainingQty,5);
  assert.equal(result.record.incomingRegisteredQty,5);
  assert.equal(result.record.status,'PARTIAL_RECEIPT');
});

test('receipt is capped at the supply remainder',()=>{
  const result=receiving.applyReceipt({qty:10,receivedQty:8},99);
  assert.equal(result.appliedQty,2);
  assert.equal(result.record.receivedQty,10);
  assert.equal(result.record.remainingQty,0);
  assert.equal(result.record.status,'RECEIVED');
});

test('cancelled supply cannot receive more goods',()=>{
  const result=receiving.applyReceipt({qty:10,receivedQty:4,status:'CANCELLED'},2);
  assert.equal(result.appliedQty,0);
  assert.equal(result.record.receivedQty,4);
  assert.equal(result.record.status,'CANCELLED');
});

test('warehouse receipt increases cumulative received quantity and reserves reopened demand',()=>{
  const result=receiving.applyReceiptToOrderItem({
    orderedQty:10,
    receivedQty:10,
    deliveredQty:10,
    returnedQty:2,
    reservedQty:0
  },2);
  assert.equal(result.item.receivedQty,12);
  assert.equal(result.reservedDelta,2);
  assert.equal(result.item.reservedQty,2);
  assert.equal(result.item.shortageQty,0);
});
