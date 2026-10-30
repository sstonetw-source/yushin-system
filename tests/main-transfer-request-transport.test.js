'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 const storage=new Map(),calls=[];let request,lose=false,after=()=>{},bad=false;
 const input={id:'request_123456789',inventoryId:'P',fromWarehouseId:'A',qty:2};
 const open=()=>{
  const options={projectId:'preview-20135'},auth={app:{options},currentUser:{uid:'U'}};
  const functions={app:{options},useEmulator:()=>{throw Error('Preview emulator');},httpsCallable:name=>async p=>{
   calls.push({name,p:structuredClone(p)});const action=name==='createV2MainTransferRequest'?'CREATE':'CANCEL';
   if(action==='CREATE')request??={...p,status:'PENDING',createdByUid:'U',createdByRole:'purchaser',requestIntentHash:'hash'};
   else Object.assign(request,{status:'CANCELLED',cancelOperationId:p.operationId,cancelledByUid:'U',cancelledByRole:'purchaser',cancelIntentHash:'hash'});
   if(lose){lose=false;throw Error('reply lost');}after(c);
   return {data:{status:'already-applied',action,id:p.id,operationId:bad?'wrong':action==='CREATE'?p.id:p.operationId,actorUid:'U',actorRole:'purchaser'}};
  }};
  const c=vm.createContext({APP_ENVIRONMENT:'preview',YUSHIN_PREVIEW_MAIN_TRANSFER_REQUEST:true,currentUser:{uid:'U'},currentUserRole:'purchaser',location:{hostname:'preview-20135.web.app'},
   firebase:{auth:()=>auth,functions:()=>{},app:()=>({options,functions:()=>functions})},db:{app:{options:{projectId:'preview-20135'}},collection:()=>({doc:()=>({get:async()=>({exists:!!request,data:()=>structuredClone(request)})})})},
   canManageInventoryStockPolicy:()=>true,canEditPage:()=>true,defaultWarehouse:()=>({id:'MAIN'}),lifecycleRecordId:()=> 'cancel_123456789',
   sessionStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  vm.runInContext(fs.readFileSync('src/services/main-transfer-request-transport.js','utf8'),c);vm.runInContext(fs.readFileSync('src/services/main-transfer-request.js','utf8'),c);return c;
 };
 return {input,storage,calls,open,setLose:v=>lose=v,setAfter:f=>after=f,setBad:v=>bad=v};
}
test('creation lost reply survives reload and retries the same source and quantity without client writer',async()=>{
 const f=fixture();f.setLose(true);await assert.rejects(f.open().createMainTransferRequest(f.input),/reply lost/);
 assert.equal(f.storage.size,1);await f.open().commitMainTransferRequestBackend(f.input.id);
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.storage.size,0);
});
test('cancel response loss preserves fixed operation after request disappears from pending query',async()=>{
 const f=fixture(),c=f.open();await c.createMainTransferRequest(f.input);f.setLose(true);
 await assert.rejects(c.cancelMainTransferRequestRecord(f.input.id),/reply lost/);
 const resumed=f.open();assert.equal(resumed.pendingMainTransferOperations().length,1);
 await resumed.commitMainTransferRequestBackend(f.input.id);assert.deepEqual(f.calls[1],f.calls[2]);assert.equal(f.storage.size,0);
});
test('unknown create blocks cancellation and changed quantity; disabled flag cannot fall back',async()=>{
 const f=fixture(),c=f.open();f.setLose(true);await assert.rejects(c.createMainTransferRequest(f.input));
 await assert.rejects(c.cancelMainTransferRequestRecord(f.input.id),/未確認/);
 await assert.rejects(c.createMainTransferRequest({...f.input,qty:3}),/未確認/);
 c.YUSHIN_PREVIEW_MAIN_TRANSFER_REQUEST=false;
 assert.equal(c.pendingMainTransferOperations().length,1);await assert.rejects(c.createMainTransferRequest(f.input),/旗標/);
 assert.equal(f.calls.length,1);assert.equal(f.storage.size,1);
 const fresh=fixture(),d=fresh.open();d.YUSHIN_PREVIEW_MAIN_TRANSFER_REQUEST=false;
 await assert.rejects(d.createMainTransferRequest(fresh.input),/旗標/);assert.equal(fresh.calls.length,0);
});
test('identity/project/flag changes and mismatched replies retain the original checkpoint',async()=>{
 for(const mode of ['role','db','flag','reply']){
  const f=fixture(),c=f.open();if(mode==='reply')f.setBad(true);else f.setAfter(ctx=>{
   if(mode==='role')ctx.currentUserRole='admin';if(mode==='db')ctx.db.app.options.projectId='yu-shing-company';if(mode==='flag')ctx.YUSHIN_PREVIEW_MAIN_TRANSFER_REQUEST=false;});
  await assert.rejects(c.createMainTransferRequest(f.input));assert.equal(f.storage.size,1);assert.equal(f.calls.length,1);
 }
});
test('unknown request cannot be dispatched by the original warehouse writer',async()=>{
 const c=vm.createContext({pendingMainTransferOperation:()=>({})});
 vm.runInContext(fs.readFileSync('src/services/warehouse-transfer.js','utf8'),c);
 await assert.rejects(c.commitWarehouseTransfer({id:'T',requestId:'Q',qty:2}),/先確認原操作/);
});
test('Functions SDK loader cannot submit a stale form under a changed account',async()=>{
 const f=fixture(),c=f.open();c.ensureReservationFunctionsCompat=async()=>{c.currentUser={uid:'other'};};
 await assert.rejects(c.createMainTransferRequest(f.input),/載入後端期間/);
 assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);
});
