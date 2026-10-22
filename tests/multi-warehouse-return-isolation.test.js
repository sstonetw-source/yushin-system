'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {planReservationReturn}=require('../modules/reservation-core');

const input=()=>({
 operation:'CUSTOMER_RETURN',deltaQty:2,settlement:'REPLACE',productKey:'P',warehouseId:'A',itemReservedQty:3,
 reservation:{locationSchemaVersion:2,productKey:'P',quantity:3,shortageQty:1,
  locations:[{warehouseId:'B',reservedQty:3}]},
 aggregateStock:{onHand:12,reserved:5,transferFreeInTransit:1},
 warehouseStock:{onHand:4,reserved:0,transferFreeInTransit:0}
});

test('replacement return adds stock and hold only at source warehouse without changing other warehouse hold',()=>{
 const before=input(),original=structuredClone(before);
 const result=planReservationReturn(before);
 assert.deepEqual(result.reservation.locations,[
  {warehouseId:'A',reservedQty:2},{warehouseId:'B',reservedQty:3}
 ]);
 assert.equal(result.reservation.quantity,5);
 assert.equal(result.reservation.shortageQty,1);
 assert.equal(result.reservedDelta,2);
 assert.deepEqual(result.aggregateStock,{onHand:14,reserved:7});
 assert.deepEqual(result.warehouseStock,{onHand:6,reserved:2});
 assert.deepEqual(before,original);
});

test('closed return increases physical stock without recreating holds in either warehouse',()=>{
 const before=input();before.settlement='CLOSE';
 const result=planReservationReturn(before);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'B',reservedQty:3}]);
 assert.equal(result.reservation.quantity,3);
 assert.equal(result.reservation.shortageQty,1);
 assert.equal(result.reservedDelta,0);
 assert.deepEqual(result.aggregateStock,{onHand:14,reserved:5});
 assert.deepEqual(result.warehouseStock,{onHand:6,reserved:0});
});

test('return rejects inconsistent per-item ledger and exhausted physical stock before any writes',()=>{
 const invalid=[
  {itemReservedQty:2},
  {aggregateStock:{onHand:12,reserved:2,transferFreeInTransit:1}},
  {warehouseStock:{onHand:4,reserved:5,transferFreeInTransit:0}},
  {reservation:{...input().reservation,warehouseId:'A'}}
 ];
 for(const patch of invalid)assert.throws(()=>planReservationReturn({...input(),...patch}));
});
