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
test('whole-order intent is bounded, canonical and never accepts caller quantities or roles',()=>{
 const {normalizeOrderCommitIntent}=require('../functions/single-item-location-service');
 const data={orderId:'O',itemIds:['I2','I1'],warehouseIds:['B','A'],attemptId:'whole_order_123456',syncAttemptId:'sync_123456789'};
 const first=normalizeOrderCommitIntent(data);
 assert.deepEqual(first.itemIds,['I1','I2']);
 assert.equal(first.hash,normalizeOrderCommitIntent({...data,itemIds:['I1','I2'],warehouseIds:['A','B']}).hash);
 for(const bad of [{...data,itemIds:[]},{...data,itemIds:['I1','I1']},{...data,itemIds:['I1','I2','I3','I4','I5','I6']},
  {...data,itemIds:['I/1']},{...data,quantity:100},{...data,actorUid:'admin'},{...data,actorRole:'admin'}])
  assert.throws(()=>normalizeOrderCommitIntent(bad));
 assert.notEqual(first.hash,normalizeOrderCommitIntent({...data,itemIds:['I1']}).hash);
 assert.notEqual(first.hash,normalizeOrderCommitIntent({...data,syncAttemptId:'another_sync'}).hash);
});
test('whole-order writer shares the existing engine and stays unavailable in live environments',async()=>{
 const {commitOrderTwoWarehouse}=require('../functions/single-item-location-service');
 for(const projectId of ['preview-20135','yu-shing-company'])
  await assert.rejects(commitOrderTwoWarehouse({projectId},'actor',{}),/僅允許/);
 const host=process.env.FIRESTORE_EMULATOR_HOST;
 try{delete process.env.FIRESTORE_EMULATOR_HOST;await assert.rejects(commitOrderTwoWarehouse({projectId:'demo-yushin'},'actor',{}),/僅允許/);}
 finally{if(host!==undefined)process.env.FIRESTORE_EMULATOR_HOST=host;}
 const entry=fs.readFileSync('functions/index.js','utf8');
 assert.doesNotMatch(entry,/commitOrderTwoWarehouse/);
});
test('single-item read-only API cannot bypass validation through the internal whole-order shape',async()=>{
 const {planSingleItemTwoWarehouse}=require('../functions/single-item-location-service');
 await assert.rejects(planSingleItemTwoWarehouse({},'actor',{orderId:'O',itemIds:['I1'],warehouseIds:['A','B']}),/請求內容/);
});
test('whole-order lifecycle intent covers all ids canonically and refuses mixed single or caller authority fields',()=>{
 const {normalizeOrderLifecycleIntent,commitOrderLocationLifecycle}=require('../functions/single-item-location-lifecycle-service');
 const data={orderId:'O',itemIds:['I2','I1'],warehouseIds:['B','A'],nextStatus:'cancelled',
  operationId:'whole_life_123456',syncAttemptId:'sync_123456789',date:'2026-10-21',reason:' 取消 '};
 const first=normalizeOrderLifecycleIntent(data);assert.deepEqual(first.itemIds,['I1','I2']);
 assert.equal(first.hash,normalizeOrderLifecycleIntent({...data,itemIds:['I1','I2'],warehouseIds:['A','B'],reason:'取消'}).hash);
 for(const patch of [{itemIds:['I1']},{nextStatus:'normal'},{date:'2026-10-22'},{reason:'不同'}])
  assert.notEqual(first.hash,normalizeOrderLifecycleIntent({...data,...patch}).hash);
 for(const patch of [{itemIds:[]},{itemIds:['I1','I1']},{itemIds:['1','2','3','4','5','6']},{itemId:'I1'},{actorRole:'admin'},{quantity:99}])
  assert.throws(()=>normalizeOrderLifecycleIntent({...data,...patch}));
 return assert.rejects(commitOrderLocationLifecycle({projectId:'production'},'actor',data),/僅允許/);
});
