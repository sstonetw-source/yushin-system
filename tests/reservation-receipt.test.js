const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../modules/reservation-core');
const plan=core.planReservationReceipt;
const base=()=>({productKey:'P',warehouseId:'B',qty:3,requestedReserveQty:3,itemReservedQty:6,
 reservation:{productKey:'P',locationSchemaVersion:2,quantity:6,shortageQty:4,locations:[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:2}]},
 aggregateStock:{productKey:'P',onHand:12,reserved:8},warehouseStock:{productKey:'P',warehouseId:'B',onHand:4,reserved:3}});
function apply(input,result){return {...structuredClone(input),itemReservedQty:result.reservation.quantity,reservation:result.reservation,
 aggregateStock:{...input.aggregateStock,...result.aggregateStock},warehouseStock:{...input.warehouseStock,...result.warehouseStock}};}
test('physical receipt adds only to the actual receiving warehouse while preserving every other location hold',()=>{
 const input=base(),before=structuredClone(input),result=plan(input);
 assert.deepEqual(input,before);assert.equal(result.allocatedQty,3);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:5}]);
 assert.equal(result.reservation.quantity,9);assert.equal(result.reservation.shortageQty,1);
 assert.deepEqual(result.aggregateStock,{onHand:15,reserved:11});assert.deepEqual(result.warehouseStock,{onHand:7,reserved:6});
 assert.deepEqual(core.reservationStockDeltas(input.reservation,result.reservation),{companyReservedDelta:3,warehouseDeltas:[{warehouseId:'B',reservedDelta:3}]});
});
test('free stock allocation never adds physical stock and is capped by this warehouse available quantity',()=>{
 const result=plan({...base(),addsStock:false});assert.equal(result.allocatedQty,1);
 assert.deepEqual(result.aggregateStock,{onHand:12,reserved:9});assert.deepEqual(result.warehouseStock,{onHand:4,reserved:4});
 assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:3}]);
});
test('company ceiling and free transit constrain existing free-stock allocation independently of warehouse stock',()=>{
 for(const key of ['aggregateStock','warehouseStock']){
  const input={...base(),addsStock:false};input[key].transferFreeInTransit=input[key].onHand-input[key].reserved;
  const result=plan(input);assert.equal(result.allocatedQty,0);assert.equal(result.reservation.quantity,6);
  assert.equal(result.aggregateStock.onHand,12);assert.equal(result.warehouseStock.onHand,4);
 }
});
test('a new receiving location appends only its quantity without moving existing locations',()=>{
 const input={...base(),warehouseId:'C',warehouseStock:{productKey:'P',warehouseId:'C',onHand:0,reserved:0}};
 const result=plan(input);assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:2},{warehouseId:'C',reservedQty:3}]);
 assert.equal(result.reservation.quantity,9);
});
test('receipt surplus and supplier-covered demand do not become extra reservations',()=>{
 const result=plan({...base(),qty:10,requestedReserveQty:2});assert.equal(result.allocatedQty,2);
 assert.equal(result.aggregateStock.onHand,22);assert.equal(result.reservation.quantity,8);assert.equal(result.reservation.shortageQty,2);
 const zero=plan({...base(),requestedReserveQty:0});assert.equal(zero.allocatedQty,0);assert.equal(zero.aggregateStock.onHand,15);
});
test('successive partial receipts preserve per-location and company conservation',()=>{
 let input=base(),result=plan(input);input=apply(input,result);result=plan({...input,qty:1,requestedReserveQty:1});
 assert.equal(result.reservation.quantity,10);assert.equal(result.reservation.shortageQty,0);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:6}]);
 assert.equal(result.aggregateStock.onHand,16);assert.equal(result.aggregateStock.reserved,12);
 assert.equal(result.warehouseStock.onHand,8);assert.equal(result.warehouseStock.reserved,7);
});
test('raw account and item projections must cover all existing holds before receiving new stock',()=>{
 for(const patch of [{itemReservedQty:5},{aggregateStock:{onHand:12,reserved:5}},{warehouseStock:{onHand:4,reserved:1}},
  {aggregateStock:{onHand:7,reserved:8}},{warehouseStock:{onHand:2,reserved:3}}])assert.throws(()=>plan({...base(),...patch}),/不足|異常|不一致/);
});
test('wrong stock identities and malformed location formats cannot be overwritten by a receipt',()=>{
 for(const patch of [{productKey:''},{warehouseId:''},{addsStock:'false'},
  {aggregateStock:{productKey:'Q',onHand:12,reserved:8}},
  {warehouseStock:{productKey:'P',warehouseId:'A',onHand:4,reserved:3}},
  {reservation:{...base().reservation,allocations:[]}},
  {reservation:{...base().reservation,quantity:5}}])assert.throws(()=>plan({...base(),...patch}));
});
test('invalid raw quantities never normalize into a successful receipt or allocation',()=>{
 for(const value of [null,NaN,Infinity,-1,'bad','',true]){
  for(const field of ['qty','requestedReserveQty'])assert.throws(()=>plan({...base(),[field]:value}));
  for(const field of ['quantity','shortageQty'])assert.throws(()=>plan({...base(),reservation:{...base().reservation,[field]:value}}));
  for(const key of ['aggregateStock','warehouseStock'])for(const field of ['onHand','reserved','transferFreeInTransit']){
   const input=base();input[key][field]=value;assert.throws(()=>plan(input));
  }
 }
});
test('legacy single-location fractions retain intent quantity separately from floating stock differences',()=>{
 const result=plan({productKey:'P',warehouseId:'W',qty:0.2,requestedReserveQty:0.2,itemReservedQty:0.1,
 reservation:{productKey:'P',warehouseId:'W',quantity:0.1,shortageQty:0.2},aggregateStock:{onHand:0.1,reserved:0.1},warehouseStock:{warehouseId:'W',onHand:0.1,reserved:0.1}});
 assert.equal(result.allocatedQty,0.2);assert.equal(result.reservation.locationSchemaVersion,undefined);
 assert.ok(Math.abs(result.aggregateStock.reserved-0.3)<1e-9);
});
test('legacy holds cannot silently migrate to a different receiving warehouse',()=>{
 const input={...base(),itemReservedQty:2,reservation:{productKey:'P',warehouseId:'A',quantity:2,shortageQty:4}};
 assert.throws(()=>plan(input),/單倉預留位置不一致/);
});
