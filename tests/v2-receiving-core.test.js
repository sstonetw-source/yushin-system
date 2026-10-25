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
  assert.equal(receipt.qty,3);
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
test('receipt reservation uses canonical workflow outstanding and shortage projection',()=>{
  const workflow=require('../modules/workflow-core.js');
  const item={orderedQty:10,deliveredQty:12,returnedQty:4,reservedQty:1,receivedQty:10};
  const p=workflow.projectItem({...item,grossDeliveredQty:12});
  const next=receiving.applyReceiptToOrderItem(item,3);
  assert.equal(p.outstandingQty,2);
  assert.equal(next.reservedDelta,1);
  assert.equal(next.item.reservedQty,2);
  assert.equal(next.item.shortageQty,0);
  assert.equal(next.item.receivedQty,13);
  assert.equal(receiving.applyReceiptToOrderItem({...item,reservedQty:2},2).reservedDelta,0);
});

test('partial receipt reserves only unshipped demand while goods await customer acknowledgement',()=>{
 const context={orderId:'O',itemId:'I',productKey:'P',shipments:[{id:'S',orderId:'O',itemId:'I',productKey:'P',
  warehouseId:'A',date:'2026-10-17',qty:4,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}],deliveries:[]};
 const item={qty:10,receivedQty:1,reservedQty:4,shortageQty:2,deliveredQty:0,warehouseShippedQty:4};
 const before=structuredClone(item),receipt=receiving.applyReceiptToOrderItem(item,3,context);
 assert.deepEqual(item,before);assert.equal(receipt.reservedDelta,2);assert.equal(receipt.item.reservedQty,6);
 assert.equal(receipt.item.shortageQty,0);assert.equal(receipt.item.receivedQty,4);
 assert.equal(receipt.item.deliveredQty,0);assert.equal(receipt.item.warehouseShippedQty,4);
 assert.equal(Object.hasOwn(receipt.item,'warehouseShipmentContext'),false);
});

test('CLOSE return receipt preserves closed delivery and reserves only remaining physical demand',()=>{
 const context={orderId:'O',itemId:'I',productKey:'P',shipments:[{id:'S',orderId:'O',itemId:'I',productKey:'P',
  warehouseId:'A',date:'2026-10-17',qty:4,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}],
  deliveries:[{id:'D',shipmentId:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-17',qty:2,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}],
  returns:[{id:'R',shipmentId:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-17',qty:1,
   sourceType:'WAREHOUSE_CUSTOMER_RETURN',condition:'RESTOCKABLE',settlement:'CLOSE'}]};
 const item={qty:10,receivedQty:1,reservedQty:4,deliveredQty:2,returnedQty:1,warehouseShippedQty:4};
 const receipt=receiving.applyReceiptToOrderItem(item,3,context);
 assert.equal(receipt.reservedDelta,2);assert.equal(receipt.item.reservedQty,6);assert.equal(receipt.item.shortageQty,0);
 assert.equal(receipt.item.deliveredQty,2);assert.equal(receipt.item.returnedQty,1);
 const workflow=require('../modules/workflow-core');
 const projection=workflow.projectItem({...item,grossDeliveredQty:2,effectiveDeliveredQty:2,warehouseShipmentContext:context});
 assert.equal(projection.outstandingQty,8);assert.equal(projection.stockOutstandingQty,6);
 assert.equal(projection.pendingDeliveryQty,2);
 context.returns[0].settlement='REPLACE';
 assert.throws(()=>receiving.applyReceiptToOrderItem(item,1,context));
});
