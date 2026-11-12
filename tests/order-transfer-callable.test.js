'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {orderTransferProject,orderTransferIntent,commitOrderTransferPhysical,createOrderTransferPhysicalCallables}=require('../functions/order-transfer-physical-service');
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099',ENABLE_ORDER_TRANSFER_DISPATCH_EMULATOR:'true'};
test('order transfer physical gates stay independent; production requires exact action/project and no Emulator',()=>{
 assert.equal(orderTransferProject('DISPATCH',env),'demo-yushin');assert.equal(orderTransferProject('RECEIVE',env),'');
 for(const patch of [{GCLOUD_PROJECT:'preview-20135'},{GCLOUD_PROJECT:'yu-shing-company'},{FIREBASE_AUTH_EMULATOR_HOST:'remote:9099'},{FUNCTIONS_EMULATOR:''}])assert.equal(orderTransferProject('DISPATCH',{...env,...patch}),'');
 for(const action of ['DISPATCH','HANDOFF','RECEIVE']){
  const flag='ENABLE_PRODUCTION_ORDER_TRANSFER_'+action+'_BACKEND',prod={GCLOUD_PROJECT:'yu-shing-company',[flag]:'true'};
  assert.equal(orderTransferProject(action,prod),'yu-shing-company');
  for(const other of ['DISPATCH','HANDOFF','RECEIVE'].filter(candidate=>candidate!==action))
   assert.equal(orderTransferProject(other,prod),'');
  for(const patch of [{[flag]:'false'},{[flag]:true},{GCLOUD_PROJECT:'preview-20135'},
   {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},
   {FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'},{GCP_PROJECT:'other'},
   {FIREBASE_CONFIG:JSON.stringify({projectId:'other'})}])
   assert.equal(orderTransferProject(action,{...prod,...patch}),'');
 }
 assert.equal(orderTransferProject('UNKNOWN',{GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_ORDER_TRANSFER_HANDOFF_BACKEND:'true'}),'');
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

test('production denies new custody handoff before creating stock transfer while keeping regular transfer flags intact',async()=>{
 const prod={GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_ORDER_TRANSFER_HANDOFF_BACKEND:'true'};
 const reads=[];let writes=0;
 const db={projectId:'yu-shing-company',collection:name=>({doc:id=>({path:name+'/'+id})}),
  runTransaction:async run=>run({
   async get(ref){
    reads.push(ref.path);
    if(ref.path==='users/WAREHOUSE')return {exists:true,data:()=>({role:'warehouse',active:true})};
    if(ref.path==='settings/orderTransferCutover')return {exists:true,data:()=>({backendOnly:true})};
    return {exists:false};
   },
   create(){writes++;},update(){writes++;},set(){writes++;}
  })};
 const input={id:'custody_safe_guard_0001',orderId:'ORDER',itemId:'ITEM',
  fromWarehouseId:'BRANCH',toWarehouseId:'custody-OWNER',qty:1};
 await assert.rejects(commitOrderTransferPhysical(db,'WAREHOUSE',input,'HANDOFF',prod),
  /業務保管後續出貨、送達與退貨尚未正式開通/);
 assert.equal(writes,0,'denied handoff must never write a movement or reservation');
 assert.ok(reads.includes('settings/orderTransferCutover'),'production cutover remains mandatory');
 assert.ok(!reads.includes('orders/ORDER'),'reject before any order or inventory mutation');
 assert.equal(orderTransferProject('DISPATCH',{...prod,ENABLE_PRODUCTION_ORDER_TRANSFER_DISPATCH_BACKEND:'true'}),
  'yu-shing-company','ordinary order warehouse transfers remain independently enabled');
});
