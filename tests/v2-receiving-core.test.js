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

test('MOQ receipt allocates customer demand first and leaves excess as stock',()=>{
  const first=receiving.applyReceipt({
    qty:5,demandAllocatedQty:3,excessStockQty:2,receivedQty:0,incomingRegisteredQty:5,status:'ORDERED'
  },2);
  assert.equal(first.appliedQty,2);
  assert.equal(first.demandReceiptQty,2);
  assert.equal(first.excessReceiptQty,0);
  assert.equal(first.record.receivedQty,2);

  const second=receiving.applyReceipt(first.record,3);
  assert.equal(second.appliedQty,3);
  assert.equal(second.demandReceiptQty,1);
  assert.equal(second.excessReceiptQty,2);
  assert.equal(second.record.receivedQty,5);
  assert.equal(second.record.status,'RECEIVED');
});

test('closed partially received supply cannot receive more goods',()=>{
  const result=receiving.applyReceipt({qty:10,receivedQty:4,status:'CLOSED'},2);
  assert.equal(result.appliedQty,0);
  assert.equal(result.record.receivedQty,4);
  assert.equal(result.record.remainingQty,0);
  assert.equal(result.record.status,'CLOSED');
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

test('allocated supplier receipt may become free stock without losing procurement receipt history',()=>{
  const result=receiving.applyReceiptToOrderItem({
    orderedQty:3,
    receivedQty:0,
    deliveredQty:0,
    returnedQty:0,
    reservedQty:1
  },3);
  assert.equal(result.appliedQty,3);
  assert.equal(result.reservedDelta,2);
  assert.equal(result.unreservedReceiptQty,1);
  assert.equal(result.item.receivedQty,3);
  assert.equal(result.item.reservedQty,3);
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
    expectedDate:'2026-10-08',
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
  assert.equal(receipt.expectedDate,'2026-10-08');
  assert.equal(receipt.scheduleDate,'2026-10-08');
  assert.equal(receipt.supplyCreatedAt,'2026-10-01T09:00:00.000Z');
  assert.equal(receipt.supplierId,'SUP1');
  assert.equal(receipt.productId,'P1');
  assert.equal(receipt.orderedQty,10);
  assert.equal(receipt.demandAllocatedQty,10);
  assert.equal(receipt.excessStockQty,0);
  assert.equal(receipt.qty,3);
  assert.equal(receipt.demandReceiptQty,0);
  assert.equal(receipt.excessReceiptQty,0);
  assert.equal(receipt.cumulativeReceivedQty,7);
  assert.equal(receipt.lotNo,'LOT-1');
  assert.equal(Object.prototype.hasOwnProperty.call(receipt,'unitCost'),false);
});

test('receipt snapshot preserves procurement demand reference',()=>{
  const snapshot=receiving.buildReceiptSnapshot({
    id:'supply-1',
    demandId:'SALES_ORDER:SO-1:item-1',
    sourceType:'SALES_ORDER',
    sourceId:'SO-1',
    sourceItemId:'item-1',
    qty:5
  },{
    receiptId:'receipt-1',
    qty:2,
    cumulativeReceivedQty:2
  });
  assert.equal(snapshot.demandId,'SALES_ORDER:SO-1:item-1');
  assert.equal(snapshot.supplyOrderId,'supply-1');
  assert.equal(snapshot.sourceId,'SO-1');
  assert.equal(snapshot.sourceItemId,'item-1');
});