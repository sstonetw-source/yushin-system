const test=require('node:test');
const assert=require('node:assert/strict');
const {planMultiWarehouseReservation}=require('../modules/reservation-core.js');
const warehouses=[{id:'W1',active:true,isDefault:true},{id:'W2',active:true},{id:'W3',active:false},{id:'custody-A',active:true,systemCustody:true}];
test('splits a request across eligible physical warehouses without inventing stock',()=>{
 const plan=planMultiWarehouseReservation({warehouses,stocks:{W1:{onHand:4,reserved:0},W2:{onHand:8,reserved:2},W3:{onHand:99},'custody-A':{onHand:99}},requestedQty:10});
 assert.deepEqual(plan,{requestedQty:10,allocations:[{warehouseId:'W1',qty:4},{warehouseId:'W2',qty:6}],allocatedQty:10,shortageQty:0});
});
test('reports only the remaining shortage and never includes disabled or custody stock',()=>{
 const plan=planMultiWarehouseReservation({warehouses,stocks:{W1:{onHand:3,reserved:1},W2:{onHand:1,reserved:0},W3:{onHand:99},'custody-A':{onHand:99}},requestedQty:7});
 assert.equal(plan.allocatedQty,3);assert.equal(plan.shortageQty,4);
 assert.deepEqual(plan.allocations.map(a=>a.warehouseId),['W1','W2']);
});
test('zero quantity creates no allocations',()=>{
 assert.deepEqual(planMultiWarehouseReservation({warehouses,requestedQty:0}),{requestedQty:0,allocations:[],allocatedQty:0,shortageQty:0});
});
