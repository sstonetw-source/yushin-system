'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planMainTransferHold:plan}=require('../modules/reservation-core');
const stock=(patch={})=>({onHand:10,reserved:2,transferReserved:1,...patch});
test('main replenishment adds and releases the same hold without changing physical or customer stock',()=>{
 const before=stock(),held=plan({qty:2,aggregateStock:before,warehouseStock:before});
 assert.deepEqual(held,{aggregate:{reserved:4,transferReserved:3},warehouse:{reserved:4,transferReserved:3}});
 const released=plan({qty:2,release:true,aggregateStock:{...before,...held.aggregate},warehouseStock:{...before,...held.warehouse}});
 assert.deepEqual(released,{aggregate:{reserved:2,transferReserved:1},warehouse:{reserved:2,transferReserved:1}});
 assert.equal(before.onHand,10);assert.equal(before.reserved,2);
});
test('company and warehouse availability both cap new holds, excluding in-transit free stock and incoming',()=>{
 const aggregateStock=stock({transferFreeInTransit:7,incoming:100}),warehouseStock=stock();
 assert.throws(()=>plan({qty:2,aggregateStock,warehouseStock}),/可用庫存不足/);
 assert.throws(()=>plan({qty:2,aggregateStock:stock(),warehouseStock:stock({onHand:3})}),/不足/);
 assert.equal(plan({qty:1,aggregateStock,warehouseStock}).aggregate.reserved,3);
});
test('a short warehouse or aggregate transfer hold refuses the entire release instead of clamping it',()=>{
 for(const target of ['aggregateStock','warehouseStock']){
  const input={qty:2,release:true,aggregateStock:stock({transferReserved:2}),warehouseStock:stock({transferReserved:2})};
  input[target]=stock({transferReserved:1});assert.throws(()=>plan(input),/不一致/);
 }
});
test('malformed values and inconsistent hold subsets cannot become successful arithmetic updates',()=>{
 for(const value of [null,'',true,NaN,Infinity,-1]){
  assert.throws(()=>plan({qty:1,aggregateStock:stock({reserved:value}),warehouseStock:stock()}));
  assert.throws(()=>plan({qty:value,aggregateStock:stock(),warehouseStock:stock()}));
 }
 for(const patch of [{reserved:11},{transferReserved:3}])assert.throws(()=>plan({qty:1,aggregateStock:stock(patch),warehouseStock:stock()}),/不一致/);
});
test('fractional stock and numeric legacy values retain their exact transfer hold',()=>{
 const input={qty:0.5,aggregateStock:stock({reserved:'2',transferReserved:'1'}),warehouseStock:stock()};
 assert.equal(plan(input).aggregate.reserved,2.5);
 assert.equal(plan(input).warehouse.transferReserved,1.5);
});
