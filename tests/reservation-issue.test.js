'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../modules/reservation-core');
const issue=core.planReservationIssue;
function source(patch={}){
 return {productKey:'P',warehouseId:'A',qty:2,requireReservation:true,
  aggregateStock:{productKey:'P',onHand:15,reserved:12,transferFreeInTransit:1},
  warehouseStock:{productKey:'P',warehouseId:'A',onHand:5,reserved:4},
  reservation:{productKey:'P',locationSchemaVersion:2,quantity:10,shortageQty:0,
   locations:[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:6}]},...patch};
}
function apply(input,result){
 return {...structuredClone(input),reservation:result.reservation,
  aggregateStock:{...input.aggregateStock,...result.aggregateStock},
  warehouseStock:{...input.warehouseStock,...result.warehouseStock}};
}
test('partial issue consumes only the selected warehouse and preserves unrelated reservations',()=>{
 const input=source(),before=structuredClone(input),result=issue(input);
 assert.deepEqual(input,before);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:2},{warehouseId:'B',reservedQty:6}]);
 assert.equal(result.reservation.quantity,8);assert.equal(result.reservedDelta,-2);
 assert.deepEqual(result.aggregateStock,{onHand:13,reserved:10});
 assert.deepEqual(result.warehouseStock,{onHand:3,reserved:2});
 assert.equal(result.unreservedQty,0);
 assert.deepEqual(core.reservationStockDeltas(input.reservation,result.reservation),{
  companyReservedDelta:-2,warehouseDeltas:[{warehouseId:'A',reservedDelta:-2}]});
});
test('different warehouses can fulfill the same item in separate partial issues without moving other holds',()=>{
 let input=source({qty:4}),result=issue(input);input=apply(input,result);
 assert.deepEqual(input.reservation.locations,[{warehouseId:'B',reservedQty:6}]);
 assert.throws(()=>issue({...input,qty:1}),/指定倉庫.*不足/);
 input={...input,warehouseId:'B',qty:3,warehouseStock:{productKey:'P',warehouseId:'B',onHand:10,reserved:8}};
 result=issue(input);input=apply(input,result);result=issue(input);
 assert.deepEqual(result.reservation.locations,[]);assert.equal(result.reservation.quantity,0);
 assert.equal(result.reservation.status,'fulfilled');assert.equal(result.aggregateStock.reserved,2);
 assert.equal(result.aggregateStock.onHand,5);assert.equal(result.warehouseStock.reserved,2);
 assert.equal(result.warehouseStock.onHand,4);
});
test('a selected warehouse cannot borrow another locations hold even if company stock is sufficient',()=>{
 for(const warehouseId of ['A','C'])for(const requireReservation of [true,false])
  assert.throws(()=>issue(source({warehouseId,qty:5,requireReservation,
   warehouseStock:{warehouseId,onHand:20,reserved:4}})),/指定倉庫.*不足/);
});
test('shipping the last physical hold leaves a real outstanding shortage instead of marking it fulfilled',()=>{
 const input=source({qty:4,reservation:{productKey:'P',locationSchemaVersion:2,quantity:4,shortageQty:3,
  locations:[{warehouseId:'A',reservedQty:4}]}});
 const result=issue(input);assert.equal(result.reservation.status,'shortage');
 assert.equal(result.reservation.shortageQty,3);assert.equal(result.reservation.quantity,0);
});
test('company and selected warehouse must each cover raw held and physical quantities',()=>{
 for(const patch of [
  {aggregateStock:undefined},{warehouseStock:undefined},
  {aggregateStock:{onHand:20,reserved:9}},
  {aggregateStock:{onHand:9,reserved:12}},
  {warehouseStock:{onHand:3,reserved:4}},
  {warehouseStock:{onHand:10,reserved:3}},
  {itemReservedQty:9}
 ])assert.throws(()=>issue(source(patch)),/不足|不一致|核對|庫存/);
});
test('malformed and mixed reservation formats are rejected before any issue plan is returned',()=>{
 const original=source();
 for(const reservation of [
  {...original.reservation,locationSchemaVersion:3},
  {...original.reservation,quantity:9},
  {...original.reservation,allocations:[]},
  {...original.reservation,warehouseAllocations:[]},
  {quantity:0,locations:[]},{quantity:0,locationSchemaVersion:0},
  {...original.reservation,locations:[{warehouseId:'A',reservedQty:5},{warehouseId:'A',reservedQty:5}]}
 ])assert.throws(()=>issue(source({reservation})));
});
test('new location issues require positive integral quantities and valid product and warehouse identity',()=>{
 for(const qty of [null,0,-1,1.5,NaN,Infinity,'',true,'bad'])assert.throws(()=>issue(source({qty})));
 for(const patch of [{productKey:''},{warehouseId:''},{warehouseId:' A'},
  {reservation:{...source().reservation,productKey:'OTHER'}},
  {aggregateStock:{productKey:'OTHER',onHand:20,reserved:12}},
  {warehouseStock:{productKey:'P',warehouseId:'B',onHand:20,reserved:12}},
  {requireReservation:'false'}])assert.throws(()=>issue(source(patch)));
});
test('invalid raw stock values cannot be normalized into a successful issue',()=>{
 for(const value of [null,NaN,Infinity,-1,'bad','',true])for(const field of ['onHand','reserved','transferFreeInTransit']){
  for(const key of ['aggregateStock','warehouseStock']){
   const input=source();input[key][field]=value;assert.throws(()=>issue(input));
  }
 }
});
test('legacy fractional and custody holds use the same issue contract without a schema migration',()=>{
 const input=source({warehouseId:'custody-U',qty:'0.5',itemReservedQty:1.5,
  reservation:{productKey:'P',warehouseId:'custody-U',quantity:'1.5'},
  aggregateStock:{onHand:5,reserved:2},warehouseStock:{warehouseId:'custody-U',onHand:3,reserved:1.5}});
 const result=issue(input);assert.equal(result.reservation.quantity,1);assert.equal(result.reservation.locationSchemaVersion,undefined);
 assert.equal(result.warehouseStock.onHand,2.5);assert.equal(result.reservedDelta,-0.5);
 assert.throws(()=>issue({...input,warehouseId:'A',warehouseStock:{onHand:3,reserved:1.5}}),/預留位置不一致/);
});
test('legacy unreserved issues consume only genuinely free stock after own holds',()=>{
 const input=source({requireReservation:false,qty:3,
  reservation:{productKey:'P',warehouseId:'A',quantity:2},
  aggregateStock:{onHand:10,reserved:6},warehouseStock:{warehouseId:'A',onHand:5,reserved:4}});
 const result=issue(input);assert.equal(result.reservedDelta,-2);assert.equal(result.unreservedQty,1);
 assert.equal(result.aggregateStock.reserved,4);assert.equal(result.warehouseStock.reserved,2);
 for(const key of ['aggregateStock','warehouseStock']){
  const blocked=structuredClone(input);blocked[key].transferFreeInTransit=blocked[key].onHand-blocked[key].reserved;
  assert.throws(()=>issue(blocked),/調撥途中/);
 }
 assert.throws(()=>issue({...input,requireReservation:true}),/預留數量不足/);
});
test('a stock-free legacy line cannot consume any other orders holds or infer a company stock document',()=>{
 const input=source({requireReservation:false,qty:1,reservation:{},
  aggregateStock:{onHand:5,reserved:5},warehouseStock:{onHand:5,reserved:5}});
 assert.throws(()=>issue(input),/可出貨實貨不足/);
 assert.throws(()=>issue({...input,aggregateStock:undefined}),/缺少公司/);
 const result=issue({...input,aggregateStock:{onHand:6,reserved:5},warehouseStock:{onHand:6,reserved:5}});
 assert.equal(result.reservation.quantity,0);assert.equal(result.reservedDelta,0);
 assert.equal(result.aggregateStock.reserved,5);assert.equal(result.warehouseStock.reserved,5);
});
test('location issue preserves company and per-warehouse conservation across quantity combinations',()=>{
 for(let a=1;a<=6;a++)for(let b=1;b<=6;b++)for(let qty=1;qty<=a;qty++){
  const input=source({qty,aggregateStock:{onHand:a+b+3,reserved:a+b+1},
   warehouseStock:{warehouseId:'A',onHand:a+1,reserved:a},
   reservation:{productKey:'P',locationSchemaVersion:2,quantity:a+b,locations:[{warehouseId:'A',reservedQty:a},{warehouseId:'B',reservedQty:b}]}});
  const result=issue(input),delta=core.reservationStockDeltas(input.reservation,result.reservation);
  assert.equal(delta.companyReservedDelta,-qty);
  assert.equal(delta.warehouseDeltas.reduce((sum,row)=>sum+row.reservedDelta,0),-qty);
  assert.equal(result.reservation.locations.find(row=>row.warehouseId==='B').reservedQty,b);
  assert.equal(result.aggregateStock.onHand-input.aggregateStock.onHand,-qty);
  assert.equal(result.warehouseStock.onHand-input.warehouseStock.onHand,-qty);
  assert.equal(result.aggregateStock.reserved-result.reservation.quantity,1);
 }
});
test('a corrupt overlap of physical holds and free transfer transit cannot be shipped even from own holds',()=>{
 for(const key of ['aggregateStock','warehouseStock']){
  const input=source();input[key].transferFreeInTransit=input[key].onHand-input[key].reserved+1;
  assert.throws(()=>issue(input),/途中量超過實貨/);
 }
});
