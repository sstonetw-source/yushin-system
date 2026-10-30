'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const service=fs.readFileSync('src/services/customer-return-request-transport.js','utf8');
function fixture(){
 const storage=new Map(),calls=[];const order={inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_123456789',returnRequests:[]};
 let lose=false,tamper=false,after=()=>{};
 const functions={app:{options:{projectId:'preview-20135'}},useEmulator:()=>{throw Error('Preview must not use emulator');},
  httpsCallable:name=>async payload=>{
   calls.push({name,payload:structuredClone(payload)});let r=order.returnRequests.find(row=>row.id===(payload.requestId||payload.operationId));
   const action=name==='requestV2CustomerReturn'?'REQUEST':'WITHDRAW';let status='applied';
   if(action==='REQUEST'){
    if(!r){r={id:payload.operationId,itemId:payload.itemId,qty:payload.qty,date:payload.date,reason:payload.reason,settlement:'CLOSE',
     status:'PENDING',receivedQty:0,createdByUid:'U',createdByRole:'sales',requestSyncAttemptId:payload.syncAttemptId,requestIntentHash:'hash'};order.returnRequests.push(r);}
    else status='already-applied';
   }else Object.assign(r,{status:'CANCELLED',cancelOperationId:payload.operationId,cancelledBy:'U',cancelledByRole:'sales',
    cancelledSyncAttemptId:payload.syncAttemptId,cancelIntentHash:'hash'});
   if(lose){lose=false;throw Error('successful reply lost');}after(c);
   return {data:{status,action,orderId:payload.orderId,requestId:r.id,operationId:tamper?'wrong':payload.operationId,
    syncAttemptId:payload.syncAttemptId,actorUid:'U',actorRole:'sales'}};
  }};
 const open=()=>{
  const auth={app:{options:{projectId:'preview-20135'}},currentUser:{uid:'U'},emulatorConfig:null};
  const c=vm.createContext({APP_ENVIRONMENT:'preview',YUSHIN_PREVIEW_CUSTOMER_RETURN_REQUEST:true,
   currentUser:{uid:'U'},currentUserRole:'sales',location:{hostname:'preview-20135.web.app'},
   firebase:{auth:()=>auth,functions:()=>{},app:()=>({options:{projectId:'preview-20135'},functions:()=>functions})},
   db:{app:{options:{projectId:'preview-20135'}},collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>structuredClone(order)})})})},
   sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,lifecycleRecordId:()=> 'withdraw_123456789'});
  // The callable's after-hook always uses the latest recreated VM.
  current=c;vm.runInContext(service,c);vm.runInContext(fs.readFileSync('src/services/customer-return.js','utf8'),c);return c;
 };
 let current;const c=new Proxy({}, {get:(_,key)=>current[key],set:(_,key,value)=>{current[key]=value;return true;}});
 const input={orderId:'O',itemId:'I',operationId:'request_123456789',qty:2,date:'2026-10-29',reason:'訂錯貨'};
 return {input,order,storage,calls,open,setLose:v=>lose=v,setTamper:v=>tamper=v,setAfter:fn=>after=fn};
}
test('request lost reply survives reload and resumes only original operation without client transaction',async()=>{
 const f=fixture();f.setLose(true);await assert.rejects(f.open().commitCustomerReturnRequest(f.input),/reply lost/);
 assert.equal(f.storage.size,1);await f.open().commitCustomerReturnRequestBackend('O');
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.storage.size,0);assert.equal(f.order.returnRequests.length,1);
});
test('unconfirmed request blocks changed inputs, withdrawal, disabled flags and legacy takeover',async()=>{
 const f=fixture();f.setLose(true);const c=f.open();await assert.rejects(c.commitCustomerReturnRequest(f.input));
 await assert.rejects(c.commitCustomerReturnRequest({...f.input,qty:3}),/未確認/);
 await assert.rejects(c.commitCustomerReturnWithdrawal({orderId:'O',requestId:f.input.operationId}),/未確認/);
 c.YUSHIN_PREVIEW_CUSTOMER_RETURN_REQUEST=false;
 assert.equal(c.customerReturnRequestBackendRequired('O'),true);
 await assert.rejects(c.commitCustomerReturnRequest(f.input),/旗標/);assert.equal(f.calls.length,1);assert.equal(f.storage.size,1);
});
test('withdrawal uses frozen operation and leaves received quantity intact across retry',async()=>{
 const f=fixture(),c=f.open();await c.commitCustomerReturnRequest(f.input);f.order.returnRequests[0].receivedQty=1;
 f.setLose(true);await assert.rejects(c.commitCustomerReturnWithdrawal({orderId:'O',requestId:f.input.operationId}),/reply lost/);
 const saved=await f.open().commitCustomerReturnRequestBackend('O');assert.equal(saved.returnRequests[0].receivedQty,1);
 assert.deepEqual(f.calls[1],f.calls[2]);assert.equal(f.storage.size,0);
});
test('project or actor changes and unverifiable replies retain pending operation',async()=>{
 for(const mode of ['db','role','flag','reply']){
  const f=fixture(),c=f.open();if(mode==='reply')f.setTamper(true);
  else f.setAfter(ctx=>{if(mode==='db')ctx.db.app.options.projectId='yu-shing-company';
   if(mode==='role')ctx.currentUserRole='admin';if(mode==='flag')ctx.YUSHIN_PREVIEW_CUSTOMER_RETURN_REQUEST=false;});
  await assert.rejects(c.commitCustomerReturnRequest(f.input));assert.equal(f.storage.size,1);assert.equal(f.calls.length,1);
 }
});
test('request requires matching Preview and independent flag before source reads or transmission',async()=>{
 for(const mode of ['host','project','flag','production','role']){
  const f=fixture(),c=f.open();if(mode==='host')c.location.hostname='other.example';
  if(mode==='project')c.db.app.options.projectId='yu-shing-company';
  if(mode==='flag')c.YUSHIN_PREVIEW_CUSTOMER_RETURN_REQUEST=false;
  if(mode==='production')c.APP_ENVIRONMENT='production';
  if(mode==='role')c.currentUserRole='warehouse';
  await assert.rejects(c.commitCustomerReturnRequestBackend('O','REQUEST',f.input));assert.equal(f.calls.length,0);
 }
});
test('Preview flag off with no pending operation rejects the original entry instead of using legacy transaction',async()=>{
 const f=fixture(),c=f.open();c.YUSHIN_PREVIEW_CUSTOMER_RETURN_REQUEST=false;
 assert.equal(c.customerReturnRequestBackendRequired('O'),true);
 await assert.rejects(c.commitCustomerReturnRequest(f.input),/旗標/);
 await assert.rejects(c.commitCustomerReturnWithdrawal({orderId:'O',requestId:'Q'}),/旗標/);
 assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);
});
