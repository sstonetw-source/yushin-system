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
 assert.match(source,/if\(!operation\)return result/);
 assert.doesNotMatch(entry,/commitSingleItemTwoWarehouse/);
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

test('single-item commit rejects injected fields and binds canonical intent to source attempt',()=>{
 const {normalizeCommitIntent}=require('../functions/single-item-location-service');
 const data={orderId:'O',itemId:'I1',warehouseIds:['A','B'],attemptId:'attempt_123456789',syncAttemptId:'sync_123456789'};
 const first=normalizeCommitIntent(data);
 assert.equal(first.hash,normalizeCommitIntent({...data,warehouseIds:['B','A']}).hash);
 assert.notEqual(first.hash,normalizeCommitIntent({...data,syncAttemptId:'new_sync'}).hash);
 for(const bad of [{...data,actorRole:'admin'},{...data,quantity:99},{...data,attemptId:'bad'},
   {...data,syncAttemptId:''},{...data,warehouseIds:['A','A']}])assert.throws(()=>normalizeCommitIntent(bad));
});
test('internal v2 writer refuses non-emulator and non-demo projects before database access',async()=>{
 const {commitSingleItemTwoWarehouse}=require('../functions/single-item-location-service');
 await assert.rejects(commitSingleItemTwoWarehouse({projectId:'production'},'actor',{}),/僅允許/);
 const host=process.env.FIRESTORE_EMULATOR_HOST;
 try{
  delete process.env.FIRESTORE_EMULATOR_HOST;
  await assert.rejects(commitSingleItemTwoWarehouse({projectId:'demo-yushin'},'actor',{}),/僅允許/);
 }finally{if(host!==undefined)process.env.FIRESTORE_EMULATOR_HOST=host;}
});
