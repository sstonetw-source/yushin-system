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

test('purchase receipt snapshot preserves ERP traceability without exposing protected cost',()=>{
  const receipt=receiving.buildReceiptSnapshot({
    id:'S1',
    method:'PURCHASING_PO',
    type:'PURCHASING_PO',
    sourceType:'SALES_ORDER',
    sourceId:'O1',
    sourceItemId:'I1',
    orderId:'O1',
    itemId:'I1',
    purchaseDocumentId:'PO-DOC-1',
    purchaseDocumentNo:'PO-2026-001',
    internalNo:'PO-2026-001',
    orderDate:'2026-10-01',
    createdAt:'2026-10-01T09:00:00.000Z',
    supplierId:'SUP1',
    supplier:'供應商 A',
    productId:'P1',
    productKey:'P1',
    itemCode:'A-100',
    itemName:'產品 A',
    brand:'Brand A',
    ownerUid:'U1',
    salesCode:'S01',
    qty:10,
    receivedQty:4,
    unitCost:999,
    fulfillmentType:'WAREHOUSE',
    warehouseId:'W1'
  },{
    receiptId:'R1',
    operationId:'R1',
    supplyOrderId:'S1',
    qty:3,
    cumulativeReceivedQty:7,
    receiptDate:'2026-10-02',
    createdAt:'2026-10-02T12:00:00.000Z',
    createdBy:'採購',
    extra:{lotNo:'LOT-1'}
  });
  assert.equal(receipt.method,'PURCHASING_PO');
  assert.equal(receipt.demandSourceType,'SALES_ORDER');
  assert.equal(receipt.sourceId,'O1');
  assert.equal(receipt.sourceItemId,'I1');
  assert.equal(receipt.purchaseDocumentNo,'PO-2026-001');
  assert.equal(receipt.supplyOrderDate,'2026-10-01');
  assert.equal(receipt.supplyCreatedAt,'2026-10-01T09:00:00.000Z');
  assert.equal(receipt.supplierId,'SUP1');
  assert.equal(receipt.productId,'P1');
  assert.equal(receipt.orderedQty,10);
  assert.equal(receipt.qty,3);
  assert.equal(receipt.cumulativeReceivedQty,7);
  assert.equal(receipt.lotNo,'LOT-1');
  assert.equal(Object.prototype.hasOwnProperty.call(receipt,'unitCost'),false);
});