'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {allowShipmentEmulator,allowPreviewShipment,shipmentBackendProject}=require('../functions/warehouse-shipment-gate');
const {createWarehouseShipmentCallable}=require('../functions/warehouse-shipment-callable');
const {commitLocationShipment}=require('../functions/location-shipment-service');
const emulator=()=>({ENABLE_V2_SHIPMENT_AUTH_EMULATOR:'true',ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
const preview=()=>({ENABLE_PREVIEW_SHIPMENT:'true',GCLOUD_PROJECT:'preview-20135'});
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}

test('shipment gates are independent, default closed and never production',()=>{
 assert.equal(allowShipmentEmulator(emulator()),true);
 assert.equal(shipmentBackendProject(emulator()),'demo-yushin');
 assert.equal(allowPreviewShipment(preview()),true);
 assert.equal(shipmentBackendProject(preview()),'preview-20135');
 for(const change of [{ENABLE_PREVIEW_SHIPMENT:'false'},{GCLOUD_PROJECT:'yu-shing-company'},
  {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(shipmentBackendProject({...preview(),...change}),'');
 for(const change of [{ENABLE_V2_SHIPMENT_AUTH_EMULATOR:'false'},{ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},{GCLOUD_PROJECT:'preview-20135'},
  {FIRESTORE_EMULATOR_HOST:'remote.example:8080'},{FIREBASE_AUTH_EMULATOR_HOST:''},
  {FUNCTIONS_EMULATOR:'false'}])assert.equal(shipmentBackendProject({...emulator(),...change}),'');
 assert.equal(shipmentBackendProject({...preview(),GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_SHIPMENT:'true'}),'');
 assert.equal(shipmentBackendProject({}),'');
});

test('demo direct-Service fixtures remain isolated, while Preview and production cannot bypass the Callable',async()=>{
 const db=projectId=>({projectId});
 const malformed={actorUid:'forged'};
 await assert.rejects(commitLocationShipment(db('demo-yushin'),'real',malformed,
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),error=>error.code==='invalid-argument');
 for(const [projectId,env] of [['demo-yushin',{}],['demo-yushin',{FIRESTORE_EMULATOR_HOST:'remote.example:8080'}],
  ['preview-20135',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}],
  ['yu-shing-company',{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',ENABLE_PREVIEW_SHIPMENT:'true'}]])
  await assert.rejects(commitLocationShipment(db(projectId),'real',malformed,env),
   error=>error.code==='failed-precondition');
});

test('gate, project, Auth and forged UID are checked before any transaction',async()=>{
 let reads=0,writes=0;
 const handler=(env,project='preview-20135')=>createWarehouseShipmentCallable({onCall:(_settings,fn)=>fn,
  HttpsError,getDatabase:()=>{reads++;return {projectId:project,runTransaction:()=>{writes++;}};},env});
 await assert.rejects(handler({})({auth:{uid:'real'},data:{}}),e=>e.code==='failed-precondition');
 await assert.rejects(handler(preview())({data:{actorUid:'forged'}}),e=>e.code==='unauthenticated');
 assert.equal(reads,0);
 await assert.rejects(handler(preview(),'yu-shing-company')({auth:{uid:'real'},data:{}}),e=>e.code==='failed-precondition');
 assert.equal(reads,1);
 await assert.rejects(handler(preview())({auth:{uid:'real'},data:{actorUid:'forged'}}),e=>e.code==='invalid-argument');
 assert.equal(reads,2);assert.equal(writes,0);
});

test('unknown Service errors are sanitized by shipment Callable',async()=>{
 const data={orderId:'O',itemId:'I',warehouseId:'W1',quantity:2,date:'2026-10-28',notes:'',
  operationId:'shipment_ui_123456',syncAttemptId:'attempt-1',
  expectedPlan:{mode:'CUSTOMER_SHIP',contact:'Customer',phone:'02-12345678',address:'Taipei'}};
 const handler=createWarehouseShipmentCallable({onCall:(_settings,fn)=>fn,HttpsError,env:preview(),
  getDatabase:()=>({projectId:'preview-20135',collection:name=>({doc:id=>({path:name+'/'+id})}),
   runTransaction:()=>{throw Error('private data');}})});
 await assert.rejects(handler({auth:{uid:'real'},data}),e=>e.code==='internal'&&e.message==='實際出貨交易失敗');
});

test('shipment Callable export exists while legacy test-only endpoints remain unexported',()=>{
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.shipV2WarehouseItem\s*=\s*createWarehouseShipmentCallable/);
 assert.match(index,/exports\.confirmV2ShipmentDelivery\s*=\s*createDeliveryConfirmationCallable/);
 assert.doesNotMatch(index,/v2-return-callable-adapter|reverseV2ShipmentDelivery/);
 const integration=fs.readFileSync('tests/fixtures/v2-return-auth-functions.cjs','utf8');
 assert.match(integration,/shipV2WarehouseItem:service\.shipV2WarehouseItem/);
});
