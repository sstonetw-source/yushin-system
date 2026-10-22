'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const demand=require('../modules/procurement-demand-core');

const ids=['SALES_ORDER:O:I1','SALES_ORDER:O:I2','SALES_ORDER:O:I3'];
const initial=()=>[
 demand.normalizeDemand({demandId:ids[0],requestedQty:3,orderedQty:3,receivedQty:3}),
 demand.normalizeDemand({demandId:ids[1],requestedQty:2,orderedQty:2,receivedQty:0}),
 demand.normalizeDemand({demandId:ids[2],requestedQty:4,orderedQty:4,receivedQty:2})
];

test('reopened replacement demand affects only returned item, and does not duplicate sibling commitments',()=>{
 const before=initial();
 const reopened=demand.reconcileRequestedQty(before[0],5);
 assert.equal(reopened.demandId,ids[0]);
 assert.equal(reopened.requestedQty,5);
 assert.equal(reopened.orderedQty,3);
 assert.equal(reopened.remainingToOrderQty,2);
 assert.equal(before[1].remainingToOrderQty,0);
 assert.equal(before[2].remainingToOrderQty,0);
 assert.equal(before[0].requestedQty,3);
});

test('existing in-transit supplier quantity prevents duplicate purchasing after replacement',()=>{
 const before=initial();
 const updated=demand.reconcileLinkedSupplies(
  demand.reconcileRequestedQty(before[0],5),
  [{demandId:ids[0],qty:3,receivedQty:3,status:'RECEIVED'},
   {demandId:ids[0],qty:2,receivedQty:0,status:'ORDERED'},
   {demandId:ids[1],qty:99,receivedQty:0,status:'ORDERED'}]
 );
 assert.equal(updated.requestedQty,5);
 assert.equal(updated.orderedQty,5);
 assert.equal(updated.remainingToOrderQty,0);
 assert.equal(updated.remainingToReceiveQty,2);
});

test('closing returned item does not change demand for another item with the same product',()=>{
 const before=initial();
 const closed=demand.reconcileRequestedQty(before[0],3);
 assert.equal(closed.remainingToOrderQty,0);
 assert.equal(before[1].demandId,ids[1]);
 assert.equal(before[1].remainingToReceiveQty,2);
 assert.equal(before[2].remainingToReceiveQty,2);
});
