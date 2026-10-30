'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allowOrderReservationBackend}=require('../functions/order-reservation-gate');
const {createOrderReservationCallable}=require('../functions/order-reservation-callable');
const preview=()=>({ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'preview-20135'});
const emulator=()=>({ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'demo-yushin',
 FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}

test('whole-order reservation rejects mixed live/emulated environments and nonlocal emulator hosts',()=>{
 assert.equal(allowOrderReservationBackend(preview()),true);
 assert.equal(allowOrderReservationBackend(emulator()),true);
 for(const change of [{FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'},{GCLOUD_PROJECT:'yu-shing-company'}])
  assert.equal(allowOrderReservationBackend({...preview(),...change}),false);
 for(const change of [{FUNCTIONS_EMULATOR:undefined},{FUNCTIONS_EMULATOR:'false'},
  {FIRESTORE_EMULATOR_HOST:'remote:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'remote:9099'},
  {FIREBASE_AUTH_EMULATOR_HOST:''},{GCLOUD_PROJECT:'yu-shing-company'}])
  assert.equal(allowOrderReservationBackend({...emulator(),...change}),false);
});

test('whole-order Callable checks gate, real Auth and actual database project before transaction reads',async()=>{
 let databases=0,transactions=0;
 const handler=(env,projectId)=>createOrderReservationCallable({onCall:(_opts,fn)=>fn,HttpsError,env,
  getDatabase:()=>{databases++;return {projectId,runTransaction:()=>{transactions++;}};}});
 await assert.rejects(handler({},'preview-20135')({auth:{uid:'actor'},data:{}}),e=>e.code==='failed-precondition');
 await assert.rejects(handler(preview(),'preview-20135')({data:{uid:'spoofed'}}),e=>e.code==='unauthenticated');
 assert.equal(databases,0);
 for(const env of [preview(),emulator()]){
  for(const wrong of [undefined,'yu-shing-company',env.GCLOUD_PROJECT==='demo-yushin'?'preview-20135':'demo-yushin'])
   await assert.rejects(handler(env,wrong)({auth:{uid:'actor'},data:{}}),
    e=>e.code==='failed-precondition'&&/資料庫/.test(e.message));
 }
 assert.equal(databases,6);assert.equal(transactions,0);
 await assert.rejects(handler(preview(),'preview-20135')({auth:{uid:'actor'},data:{role:'admin'}}),
  e=>e.code==='invalid-argument');
 assert.equal(transactions,0);
});

test('whole-order Callable preserves error codes and hides internal data on uncertain failures',async()=>{
 const request={auth:{uid:'actor'},data:{orderId:'O',syncAttemptId:'sync_1234567890'}};
 const handler=error=>createOrderReservationCallable({onCall:(_opts,fn)=>fn,HttpsError,env:preview(),
  getDatabase:()=>({projectId:'preview-20135',collection:name=>({doc:id=>({path:name+'/'+id})}),
   runTransaction:()=>{throw error;}})});
 const denied=Object.assign(new Error('拒絕此交易'),{code:'permission-denied'});
 await assert.rejects(handler(denied)(request),e=>e.code==='permission-denied'&&e.message===denied.message);
 await assert.rejects(handler(new Error('private database details'))(request),e=>e.code==='internal'
  &&!e.message.includes('private')&&e.message.includes('原同步識別碼'));
});
