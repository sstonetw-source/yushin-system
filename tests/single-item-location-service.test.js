'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {normalizeSingleItemIntent}=require('../functions/single-item-location-service');
const core=require('../modules/reservation-core');
test('single item two-warehouse preview accepts two distinct IDs and rejects caller balances',()=>{
 const data={orderId:'O',itemId:'I1',warehouseIds:['B','A']};
 assert.deepEqual(normalizeSingleItemIntent(data).warehouseIds,['A','B']);
 for(const bad of [
   {...data,warehouseIds:['A','A']},
   {...data,warehouseIds:['A']},
   {...data,warehouseIds:['A','B','C']},
   {...data,actorRole:'admin'},
   {...data,quantity:999},
   {...data,warehouseIds:['A','a/b']},
 ]){
   assert.throws(()=>normalizeSingleItemIntent(bad));
 }
});
test('service is read-only and keeps the authoritative shared v2 plan',()=>{
 const source=fs.readFileSync('functions/single-item-location-service.js','utf8');
 const entry=fs.readFileSync('functions/index.js','utf8');
 assert.match(source,/core\.planLocationReservation\(/);
 assert.doesNotMatch(source,/tx\.(set|update|create|delete)\(/);
 assert.doesNotMatch(entry,/planSingleItemTwoWarehouse/);
 const plan=core.planLocationReservation({
   productKey:'P',requestedQty:10,currentWarehouseId:'A',
   reservation:{},aggregateStock:{productKey:'P',onHand:12,reserved:0},
   warehouses:[{id:'A'},{id:'B'}],
   stocks:{A:{productKey:'P',warehouseId:'A',onHand:4,reserved:0},
     B:{productKey:'P',warehouseId:'B',onHand:8,reserved:0}}
 });
 assert.deepEqual(plan.reservation.locations,[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:6}]);
 assert.equal(plan.companyReservedDelta,10);
 assert.equal(plan.reservation.shortageQty,0);
});
