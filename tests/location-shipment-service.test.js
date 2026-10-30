'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {normalizeShipmentIntent,commitLocationShipment}=require('../functions/location-shipment-service');
const plan={mode:'CUSTOMER_SHIP',contact:'客戶',phone:'02-12345678',address:'台北市測試地址'};
function request(patch={}){return {orderId:'O',itemId:'I',warehouseId:'A',quantity:2,date:'2026-10-17',
 operationId:'operation_12345',syncAttemptId:'sync_12345',expectedPlan:plan,...patch};}
test('location shipment intent binds selected warehouse, quantity, date, notes, source and saved recipient',()=>{
 const first=normalizeShipmentIntent(request());
 for(const patch of [{warehouseId:'B'},{quantity:3},{date:'2026-10-18'},{notes:'另外一批'},
  {syncAttemptId:'new-sync'},{expectedPlan:{...plan,address:'不同地址'}}])
  assert.notEqual(normalizeShipmentIntent(request(patch)).hash,first.hash);
 assert.equal(normalizeShipmentIntent(request({expectedPlan:{...plan,contact:' 客戶 '}})).hash,first.hash);
});
test('location shipment rejects forged actor, bad quantity, dates, recipient and operation IDs',()=>{
 for(const patch of [{actorRole:'admin'},{quantity:0},{quantity:1.5},{quantity:'2'},
  {quantity:NaN},{date:'2026-02-30'},{operationId:'bad'},{notes:[]},{warehouseId:'A/B'},
  {expectedPlan:{...plan,actorRole:'admin'}},{expectedPlan:{...plan,address:''}},
  {expectedPlan:{mode:'PICKUP'}},{expectedPlan:null}])assert.throws(()=>normalizeShipmentIntent(request(patch)));
});
test('location shipment refuses unauthorized projects and direct production invocation',async()=>{
 await assert.rejects(commitLocationShipment({projectId:'production'},'actor',request()),/未獲專案授權/);
 const host=process.env.FIRESTORE_EMULATOR_HOST;
 try{delete process.env.FIRESTORE_EMULATOR_HOST;
  await assert.rejects(commitLocationShipment({projectId:'demo-yushin'},'actor',request()),/未獲專案授權/);
 }finally{if(host!==undefined)process.env.FIRESTORE_EMULATOR_HOST=host;}
 assert.doesNotMatch(fs.readFileSync('functions/index.js','utf8'),/commitLocationShipment/);
});

test('physical shipment consumes preparation budget without changing customer delivery progress',()=>{
 const core=require('../modules/fulfillment-core');
 const source={warehouseShippedQty:4,deliveredQty:0,reservedQty:6,dispatchPreparedQty:10};
 assert.deepEqual(core.warehouseShipmentState(source),{
  shippedQty:4,reserved:6,prepared:10,preparedOutstanding:6,shippable:6,pending:0});
 assert.equal(core.warehouseShipmentState({...source,warehouseShippedQty:10,reservedQty:0}).shippable,0);
 assert.equal(source.deliveredQty,0);
 assert.equal(core.warehouseShipmentState({...source,dispatchPreparedQty:5}).shippable,1);
});
