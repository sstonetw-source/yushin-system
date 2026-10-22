'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const receiving=require('../modules/receiving-core');
const demand=require('../modules/procurement-demand-core');

const supplies=()=>[
 {id:'S1',sourceItemId:'I1',productKey:'P',warehouseId:'A',qty:3,receivedQty:0,incomingRegisteredQty:3,status:'ORDERED'},
 {id:'S2',sourceItemId:'I2',productKey:'P',warehouseId:'B',qty:2,receivedQty:0,incomingRegisteredQty:2,status:'ORDERED'},
 {id:'S3',sourceItemId:'I3',productKey:'Q',warehouseId:'A',qty:4,receivedQty:0,incomingRegisteredQty:4,status:'ORDERED'}
];

test('partial receipt of one item does not consume same-product supply from another warehouse',()=>{
 const rows=supplies(),before=structuredClone(rows);
 const first=receiving.applyReceipt(rows[0],2);
 assert.equal(first.appliedQty,2);
 assert.equal(first.record.receivedQty,2);
 assert.equal(first.record.remainingQty,1);
 assert.equal(first.record.incomingRegisteredQty,1);
 assert.equal(first.record.status,'PARTIAL_RECEIPT');
 assert.deepEqual(rows,before);
 assert.deepEqual(rows.slice(1),before.slice(1));
 const second=receiving.applyReceipt(first.record,1);
 assert.equal(second.record.receivedQty,3);
 assert.equal(second.record.remainingQty,0);
 assert.equal(second.record.incomingRegisteredQty,0);
 assert.equal(second.record.status,'RECEIVED');
});

test('multi-item procurement demands retain independent receipt and incoming balances',()=>{
 const rows=supplies();
 const demands=rows.map(row=>demand.fromSalesOrder({
  sourceId:'O',sourceItemId:row.sourceItemId,fulfillmentType:'WAREHOUSE',
  shortageQty:row.qty,inTransitQty:row.qty
 }));
 assert.deepEqual(demands.map(row=>row.remainingToOrderQty),[0,0,0]);
 const received=receiving.applyReceipt(rows[1],1);
 const linked=demand.reconcileLinkedSupplies(
  demands[1],[{demandId:demands[1].demandId,qty:2,receivedQty:received.record.receivedQty,status:received.record.status},
   {demandId:demands[0].demandId,qty:3,receivedQty:3,status:'RECEIVED'}]
 );
 assert.equal(linked.orderedQty,2);
 assert.equal(linked.receivedQty,1);
 assert.equal(linked.remainingToReceiveQty,1);
 assert.equal(linked.remainingToOrderQty,0);
 assert.equal(demands[0].remainingToReceiveQty,3);
 assert.equal(demands[2].remainingToReceiveQty,4);
});

test('closed partially received supply cannot resume and does not alter sibling receipts',()=>{
 const rows=supplies();
 const closed=receiving.applyReceipt({...rows[0],receivedQty:1,status:'CLOSED'},2);
 assert.equal(closed.appliedQty,0);
 assert.equal(closed.record.receivedQty,1);
 assert.equal(closed.record.status,'CLOSED');
 assert.equal(rows[1].receivedQty,0);
 assert.equal(rows[2].receivedQty,0);
});
