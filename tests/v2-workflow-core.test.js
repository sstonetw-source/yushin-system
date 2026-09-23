const test=require('node:test');
const assert=require('node:assert/strict');
const w=require('../modules/workflow-core.js');

test('one item can mix stock standard purchase and peer transfer quantities',()=>{
  const result=w.validateSupplyAllocations({orderedQty:10,fulfillmentType:'WAREHOUSE',customerName:'Hospital',supplyAllocations:[
    {type:'STOCK',qty:3},
    {type:'STANDARD_PURCHASE',qty:4},
    {type:'PEER_TRANSFER',qty:3,supplier:'Peer Co',unitCost:100,endCustomer:'Hospital'}
  ]});
  assert.equal(result.valid,true);
  assert.equal(result.allocatedQty,10);
});

test('peer transfer requires supplier actual cost and end customer',()=>{
  const result=w.validateSupplyAllocations({orderedQty:2,supplyAllocations:[{type:'PEER_TRANSFER',qty:2}]});
  assert.equal(result.valid,false);
  assert.deepEqual(result.errors,['supplier:0','unitCost:0','endCustomer:0']);
});

test('direct ship cannot consume company stock and allocations cannot exceed the order',()=>{
  assert.deepEqual(w.validateSupplyAllocations({orderedQty:1,fulfillmentType:'DIRECT_SHIP',supplyAllocations:[{type:'STOCK',qty:1}]}).errors,['directShipStock']);
  assert.deepEqual(w.validateSupplyAllocations({orderedQty:1,supplyAllocations:[{type:'STANDARD_PURCHASE',qty:2}]}).errors,['allocatedQty']);
});

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
