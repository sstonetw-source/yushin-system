const test=require('node:test');
const assert=require('node:assert/strict');
const w=require('../modules/workflow-core.js');
const fulfillment=require('../modules/fulfillment-core.js');
const reservation=require('../modules/reservation-core.js');
const receiving=require('../modules/receiving-core.js');
const supply=require('../modules/supply-core.js');

test('customer advance delivery requires a complete request and admin approval before delivery',()=>{
  const requested={commercialReleaseMode:'ADVANCE_TO_CUSTOMER',advanceDelivery:{status:'REQUESTED',reason:'Customer document pending',promisedDocumentDate:'2026-10-01',requestedByUid:'sales1'}};
  assert.equal(w.validateAdvanceRequest(requested).valid,true);
  assert.equal(w.canDeliver(requested),false);
  const approved={...requested,advanceDelivery:{...requested.advanceDelivery,status:'APPROVED',approvedByUid:'admin',approvedAt:'2026-09-23T00:00:00Z'}};
  assert.equal(w.canDeliver(approved),true);
  assert.equal(w.canBill(approved),false);
});

test('advance delivery can bill only after the customer document is completed',()=>{
  const closed={commercialReleaseMode:'ADVANCE_TO_CUSTOMER',advanceDelivery:{status:'CLOSED',reason:'Urgent',promisedDocumentDate:'2026-10-01',requestedByUid:'sales1',approvedByUid:'admin',approvedAt:'2026-09-23T00:00:00Z',customerOrderReference:'PO-123',completedAt:'2026-09-25T00:00:00Z'}};
  assert.equal(w.canDeliver(closed),true);
  assert.equal(w.canBill(closed),true);
  assert.equal(w.canBill({...closed,advanceDelivery:{...closed.advanceDelivery,customerOrderReference:''}}),false);
  assert.equal(w.canBill({...closed,advanceDelivery:{...closed.advanceDelivery,status:'APPROVED'}}),false);
});


test('item workflow keeps unresolved shortage in ordering even when some stock is available',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:10,deliveredQty:0,shortageQty:7,supplyOrderedQty:0}),'ordering');
});

test('item workflow moves an issued purchase or self order to arrival',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:0,supplyOrderedQty:7}),'arrival');
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:0,supplyOrderedQty:7}),'arrival');
});

test('item workflow treats stock-covered items as delivery and direct ship as ordering then arrival',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:3,shortageQty:0}),'delivery');
  assert.equal(w.itemWorkCategory({orderedQty:3,fulfillmentType:'DIRECT_SHIP',supplyOrderedQty:0}),'ordering');
  assert.equal(w.itemWorkCategory({orderedQty:3,fulfillmentType:'DIRECT_SHIP',supplyOrderedQty:3}),'arrival');
});

test('item workflow moves delivered items through billing and complete',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:2,deliveredQty:2,isBilled:false}),'billing');
  assert.equal(w.itemWorkCategory({orderedQty:2,deliveredQty:2,isBilled:true}),'complete');
});

test('item workflow closes cancelled work but routes full returns back to delivery',()=>{
  assert.equal(w.itemWorkCategory({lifecycleStatus:'cancelled',orderedQty:2}),'closed');
  assert.equal(w.itemWorkCategory({lifecycleStatus:'normal',orderedQty:2,returnedQty:2,effectiveDeliveredQty:0}),'delivery');
});


test('item workflow moves fully received purchased items to delivery',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:0,supplyOrderedQty:7,receivedQty:3}),'arrival');
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:0,supplyOrderedQty:7,receivedQty:7}),'delivery');
  assert.equal(w.itemWorkCategory({orderedQty:3,fulfillmentType:'DIRECT_SHIP',supplyOrderedQty:3,receivedQty:3}),'delivery');
});


test('mixed order items independently cover ordering arrival delivery billing and complete',()=>{
  const categories=[
    {orderedQty:5,shortageQty:5,supplyOrderedQty:0},
    {orderedQty:4,shortageQty:0,supplyOrderedQty:4,receivedQty:0},
    {orderedQty:3,shortageQty:0},
    {orderedQty:2,deliveredQty:2,isBilled:false},
    {orderedQty:1,deliveredQty:1,isBilled:true}
  ].map(item=>w.itemWorkCategory(item));
  assert.deepEqual(categories,['ordering','arrival','delivery','billing','complete']);
});

test('mixed fulfillment keeps each item in its own workflow state',()=>{
  const categories=[
    {orderedQty:2,fulfillmentType:'DIRECT_SHIP',supplyOrderedQty:2,receivedQty:0},
    {orderedQty:2,fulfillmentType:'DIRECT_SHIP',supplyOrderedQty:2,receivedQty:2},
    {orderedQty:3,shortageQty:0,supplyOrderedQty:2,receivedQty:1},
    {orderedQty:3,shortageQty:0,supplyOrderedQty:2,receivedQty:2}
  ].map(item=>w.itemWorkCategory(item));
  assert.deepEqual(categories,['arrival','delivery','arrival','delivery']);
});


test('restored warehouse item moves to arrival when existing supply fully covers the shortage',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:2,supplyOrderedQty:6,receivedQty:0}),'arrival');
});

test('restored warehouse item stays in ordering when issued supply does not cover the shortage',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:8,supplyOrderedQty:6,receivedQty:0}),'ordering');
});

test('restored warehouse item with no uncovered shortage stays in arrival while supply is still incoming',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:0,supplyOrderedQty:6,receivedQty:2}),'arrival');
});

test('restored warehouse item with received supply and no uncovered shortage is ready for delivery',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:10,shortageQty:0,supplyOrderedQty:6,receivedQty:6}),'delivery');
});

test('direct ship ignores warehouse shortage semantics and follows order then receipt progress',()=>{
  assert.equal(w.itemWorkCategory({orderedQty:4,fulfillmentType:'DIRECT_SHIP',shortageQty:4,supplyOrderedQty:4,receivedQty:2}),'arrival');
  assert.equal(w.itemWorkCategory({orderedQty:4,fulfillmentType:'DIRECT_SHIP',shortageQty:4,supplyOrderedQty:4,receivedQty:4}),'delivery');
});


test('cross-module shortage purchase and partial receipts stay numerically aligned',()=>{
  const initialReservation=reservation.planReservation({requestedQty:10,existingQty:0,sameStock:true,availableQty:4});
  let item=fulfillment.normalizeItem({
    orderedQty:10,
    reservedQty:initialReservation.reservedQty,
    shortageQty:initialReservation.shortageQty
  });
  assert.deepEqual(
    {reservedQty:item.reservedQty,shortageQty:item.shortageQty},
    {reservedQty:4,shortageQty:6}
  );
  assert.equal(w.itemWorkCategory({...item,supplyOrderedQty:0}),'ordering');

  let supplyRecord=supply.normalize({
    type:supply.TYPES.PURCHASING_PO,
    qty:6,
    receivedQty:0,
    supplier:'Supplier',
    orderId:'O1',
    itemId:'I1'
  });
  item={...item,supplyOrderedQty:supplyRecord.qty};
  assert.equal(w.itemWorkCategory(item),'arrival');

  let receipt=supply.applyReceipt(supplyRecord,2);
  supplyRecord=receipt.record;
  item=receiving.applyReceiptToOrderItem(item,receipt.appliedQty).item;
  assert.deepEqual(
    {supplyReceived:supplyRecord.receivedQty,itemReceived:item.receivedQty,reservedQty:item.reservedQty,shortageQty:item.shortageQty},
    {supplyReceived:2,itemReceived:2,reservedQty:6,shortageQty:4}
  );
  assert.equal(w.itemWorkCategory(item),'arrival');

  receipt=supply.applyReceipt(supplyRecord,4);
  supplyRecord=receipt.record;
  item=receiving.applyReceiptToOrderItem(item,receipt.appliedQty).item;
  assert.deepEqual(
    {supplyReceived:supplyRecord.receivedQty,itemReceived:item.receivedQty,reservedQty:item.reservedQty,shortageQty:item.shortageQty},
    {supplyReceived:6,itemReceived:6,reservedQty:10,shortageQty:0}
  );
  assert.equal(supplyRecord.status,'RECEIVED');
  assert.equal(w.itemWorkCategory(item),'delivery');
  assert.equal(fulfillment.pendingDispatchQty(item),10);
});


test('procurement quantity stays open after a partial purchase is fully received',()=>{
  const beforeReceipt=w.procurementQuantities({
    orderedQty:10,shortageQty:7,supplyOrderedQty:4,receivedQty:0,fulfillmentType:'WAREHOUSE'
  });
  assert.equal(beforeReceipt.remainingToOrderQty,3);
  assert.equal(beforeReceipt.inTransitQty,4);

  const afterReceipt=w.procurementQuantities({
    orderedQty:10,shortageQty:3,supplyOrderedQty:4,receivedQty:4,fulfillmentType:'WAREHOUSE'
  });
  assert.equal(afterReceipt.remainingToOrderQty,3);
  assert.equal(afterReceipt.inTransitQty,0);
  assert.equal(w.itemWorkCategory({
    orderedQty:10,shortageQty:3,supplyOrderedQty:4,receivedQty:4,fulfillmentType:'WAREHOUSE'
  }),'ordering');
});

test('warehouse required supply does not double count in-transit quantity',()=>{
  const p=w.procurementQuantities({
    orderedQty:10,shortageQty:7,supplyOrderedQty:4,receivedQty:0,fulfillmentType:'WAREHOUSE'
  });
  assert.equal(p.requiredSupplyQty,7);
  assert.equal(p.inTransitQty,4);
  assert.equal(p.remainingToOrderQty,3);
});

test('procurement quantity moves to arrival only when in-transit supply covers the live shortage',()=>{
  const partial=w.procurementQuantities({
    orderedQty:10,shortageQty:7,supplyOrderedQty:4,receivedQty:0,fulfillmentType:'WAREHOUSE'
  });
  assert.equal(partial.remainingToOrderQty,3);
  assert.equal(w.itemWorkCategory({
    orderedQty:10,shortageQty:7,supplyOrderedQty:4,receivedQty:0,fulfillmentType:'WAREHOUSE'
  }),'ordering');

  const covered=w.procurementQuantities({
    orderedQty:10,shortageQty:7,supplyOrderedQty:7,receivedQty:0,fulfillmentType:'WAREHOUSE'
  });
  assert.equal(covered.remainingToOrderQty,0);
  assert.equal(covered.inTransitQty,7);
  assert.equal(w.itemWorkCategory({
    orderedQty:10,shortageQty:7,supplyOrderedQty:7,receivedQty:0,fulfillmentType:'WAREHOUSE'
  }),'arrival');
});


test('workflow projection uses reservation as the authoritative warehouse shortage',()=>{
  const p=w.projectItem({
    orderedQty:10,
    reservedQty:4,
    shortageQty:99,
    supplyOrderedQty:3,
    receivedQty:1,
    fulfillmentType:'WAREHOUSE'
  });
  assert.equal(p.shortageQty,6);
  assert.equal(p.inTransitQty,2);
  assert.equal(p.remainingToOrderQty,4);
  assert.equal(p.workCategory,'ordering');
});

test('workflow projection reopens demand after a return and clears it after replacement receipt',()=>{
  const returned=w.projectItem({
    orderedQty:10,
    deliveredQty:10,
    effectiveDeliveredQty:8,
    returnedQty:2,
    reservedQty:0,
    supplyOrderedQty:10,
    receivedQty:10,
    fulfillmentType:'WAREHOUSE'
  });
  assert.equal(returned.outstandingQty,2);
  assert.equal(returned.remainingToOrderQty,2);
  const replaced=w.projectItem({
    orderedQty:10,
    deliveredQty:10,
    effectiveDeliveredQty:8,
    returnedQty:2,
    reservedQty:2,
    supplyOrderedQty:12,
    receivedQty:12,
    fulfillmentType:'WAREHOUSE'
  });
  assert.equal(replaced.shortageQty,0);
  assert.equal(replaced.remainingToOrderQty,0);
  assert.equal(replaced.workCategory,'delivery');
});