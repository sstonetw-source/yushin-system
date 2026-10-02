const test=require('node:test');
const assert=require('node:assert/strict');
const d=require('../modules/procurement-demand-core.js');

test('sales shortage uses in-transit supply to reduce remaining purchase demand',()=>{
  const demand=d.fromSalesOrder({
    sourceId:'o1',sourceItemId:'i1',fulfillmentType:'WAREHOUSE',
    shortageQty:7,inTransitQty:4
  });
  assert.equal(demand.requestedQty,7);
  assert.equal(demand.orderedQty,4);
  assert.equal(demand.remainingToOrderQty,3);
  assert.equal(demand.status,d.STATUSES.PARTIALLY_ORDERED);
});

test('covered sales shortage becomes ordered and waits for receipt',()=>{
  const demand=d.fromSalesOrder({
    fulfillmentType:'WAREHOUSE',shortageQty:7,inTransitQty:7
  });
  assert.equal(demand.remainingToOrderQty,0);
  assert.equal(demand.status,d.STATUSES.ORDERED);
});

test('direct ship uses cumulative supplier order and receipt quantities',()=>{
  const demand=d.fromSalesOrder({
    fulfillmentType:'DIRECT_SHIP',requiredSupplyQty:12,supplyOrderedQty:12,receivedQty:5
  });
  assert.equal(demand.requestedQty,12);
  assert.equal(demand.remainingToOrderQty,0);
  assert.equal(demand.remainingToReceiveQty,7);
  assert.equal(demand.status,d.STATUSES.PARTIALLY_RECEIVED);
});

test('stock replenishment treats incoming as already ordered against safety-stock gap',()=>{
  const demand=d.fromStockReplenishment({safetyStock:20,available:5,incoming:7});
  assert.equal(demand.requestedQty,15);
  assert.equal(demand.orderedQty,7);
  assert.equal(demand.remainingToOrderQty,8);
  assert.equal(demand.status,d.STATUSES.PARTIALLY_ORDERED);
});

test('stock replenishment does not duplicate an incoming order that already covers safety stock',()=>{
  const demand=d.fromStockReplenishment({safetyStock:20,available:5,incoming:15});
  assert.equal(demand.remainingToOrderQty,0);
  assert.equal(demand.status,d.STATUSES.ORDERED);
});

test('ERP-style demand statuses include partial order partial receipt and received',()=>{
  assert.equal(d.normalizeDemand({requestedQty:10,orderedQty:0}).status,d.STATUSES.PENDING);
  assert.equal(d.normalizeDemand({requestedQty:10,orderedQty:4}).status,d.STATUSES.PARTIALLY_ORDERED);
  assert.equal(d.normalizeDemand({requestedQty:10,orderedQty:10}).status,d.STATUSES.ORDERED);
  assert.equal(d.normalizeDemand({requestedQty:10,orderedQty:10,receivedQty:4}).status,d.STATUSES.PARTIALLY_RECEIVED);
  assert.equal(d.normalizeDemand({requestedQty:10,orderedQty:10,receivedQty:10}).status,d.STATUSES.RECEIVED);
});

test('tracks ERP ordered and received percentages and schedule date',()=>{
  const demand=d.normalizeDemand({requestedQty:10,orderedQty:6,receivedQty:3,expectedDate:'2026-10-15'});
  assert.equal(demand.perOrdered,60);
  assert.equal(demand.perReceived,30);
  assert.equal(demand.scheduleDate,'2026-10-15');
});

test('demand id follows ERP-style source references',()=>{
  const sales=d.fromSalesOrder({
    sourceId:'SO-100',sourceItemId:'item-2',fulfillmentType:'WAREHOUSE',
    shortageQty:3,inTransitQty:0
  });
  assert.equal(sales.demandId,'SALES_ORDER:SO-100:item-2');

  const stock=d.fromStockReplenishment({
    sourceId:'product-ABC',safetyStock:10,available:2,incoming:0
  });
  assert.equal(stock.demandId,'STOCK_REPLENISHMENT:product-ABC');
});

test('persistent demand document tracks ERP material request facts',()=>{
  const doc=d.demandDocument({
    demandId:'SALES_ORDER:o1:i1',sourceType:'SALES_ORDER',sourceId:'o1',sourceItemId:'i1',
    itemCode:'ABC',requestedQty:10,orderedQty:4,receivedQty:2,scheduleDate:'2026-10-15',
    ownerUid:'sales1',salesCode:'S01'
  },{createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'});
  assert.equal(doc.remainingToOrderQty,6);
  assert.equal(doc.remainingToReceiveQty,2);
  assert.equal(doc.status,d.STATUSES.PARTIALLY_RECEIVED);
  assert.equal(doc.perOrdered,40);
  assert.equal(doc.perReceived,20);
});

test('purchase order increments only remaining demand',()=>{
  const result=d.applyOrder({requestedQty:10,orderedQty:7,receivedQty:0},9);
  assert.equal(result.appliedQty,3);
  assert.equal(result.demand.orderedQty,10);
  assert.equal(result.demand.remainingToOrderQty,0);
  assert.equal(result.demand.status,d.STATUSES.ORDERED);
});

test('purchase receipt increments only ordered remainder',()=>{
  const result=d.applyReceipt({requestedQty:10,orderedQty:8,receivedQty:3},9);
  assert.equal(result.appliedQty,5);
  assert.equal(result.demand.receivedQty,8);
  assert.equal(result.demand.remainingToReceiveQty,0);
  assert.equal(result.demand.status,d.STATUSES.PARTIALLY_RECEIVED);
});

test('demand can reopen when requested quantity increases',()=>{
  const reopened=d.reconcileRequestedQty({requestedQty:10,orderedQty:10,receivedQty:10},12);
  assert.equal(reopened.remainingToOrderQty,2);
  assert.equal(reopened.status,d.STATUSES.PARTIALLY_RECEIVED);
});
