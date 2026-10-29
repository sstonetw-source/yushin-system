'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {custodyReturnProject,commitCustodyReturn}=require('../functions/custody-return-service');
const {normalizeLocationReturnIntent}=require('../functions/location-return-service');
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 ENABLE_V3_CUSTODY_RETURN_EMULATOR:'true'};
test('V3 Custody customer return remains independently closed in production, Preview, and disabled demos',async()=>{
 assert.equal(custodyReturnProject(env),'demo-yushin');
 for(const patch of [{GCLOUD_PROJECT:'production'},{GCLOUD_PROJECT:'preview-20135'},
  {FUNCTIONS_EMULATOR:'false'},{ENABLE_V3_CUSTODY_RETURN_EMULATOR:'false'},
  {FIRESTORE_EMULATOR_HOST:'remote-db:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'remote-auth:9099'}]){
  assert.equal(custodyReturnProject({...env,...patch}),'');
  await assert.rejects(commitCustodyReturn({projectId:'demo-yushin'},'U',{}, {...env,...patch}),
   /尚未在此專案啟用/);
 }
 await assert.rejects(commitCustodyReturn({projectId:'production'},'U',{},env),/尚未在此專案啟用/);
});
test('V3 return shares canonical immutable V2 return ID and lot selection normalizer',()=>{
 const intent=normalizeLocationReturnIntent({orderId:'ORDER',itemId:'I',shipmentId:'shipment_1234567',
  syncAttemptId:'sync_1234567890',selections:[{lotId:'B',qty:2},{lotId:'A',qty:1}],
  operationId:'custody_return_id_12345',warehouseId:'custody-U',date:'2026-10-30',
  reason:'客戶退回',condition:'RESTOCKABLE',settlement:'CLOSE'});
 assert.deepEqual(intent.selections.map(row=>row.lotId),['A','B']);
 assert.match(intent.hash,/^[a-f0-9]{64}$/);
});
