'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {orderTransferProject,orderTransferIntent,createOrderTransferPhysicalCallables}=require('../functions/order-transfer-physical-service');
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099',ENABLE_ORDER_TRANSFER_DISPATCH_EMULATOR:'true'};
test('order transfer physical gates are independent and never authorize Preview or production',()=>{
 assert.equal(orderTransferProject('DISPATCH',env),'demo-yushin');assert.equal(orderTransferProject('RECEIVE',env),'');
 for(const patch of [{GCLOUD_PROJECT:'preview-20135'},{GCLOUD_PROJECT:'yu-shing-company'},{FIREBASE_AUTH_EMULATOR_HOST:'remote:9099'},{FUNCTIONS_EMULATOR:''}])assert.equal(orderTransferProject('DISPATCH',{...env,...patch}),'');
});
test('fixed order transfer intents reject extra fields handoff and mutable actor claims',()=>{
 const source={id:'T',orderId:'O',itemId:'I',fromWarehouseId:'A',toWarehouseId:'B',qty:3};
 assert.equal(orderTransferIntent('DISPATCH',source).hash,orderTransferIntent('DISPATCH',{...source}).hash);
 for(const patch of [{handoff:true},{actorRole:'admin'},{qty:0},{id:'bad/id'}])assert.throws(()=>orderTransferIntent('DISPATCH',{...source,...patch}));
});
test('unauthenticated and disabled callable fail before database access',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0;const handlers=createOrderTransferPhysicalCallables({onCall:(_,fn)=>fn,HttpsError,env,getDatabase:()=>{reads++;return {};}});
 await assert.rejects(handlers.dispatchOrderTransfer({data:{}}),e=>e.code==='unauthenticated');
 await assert.rejects(handlers.receiveOrderTransfer({auth:{uid:'U'},data:{}}),e=>e.code==='failed-precondition');assert.equal(reads,0);
});
