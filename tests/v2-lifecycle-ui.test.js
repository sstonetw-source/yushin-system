'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/order-lifecycle.js','utf8');
function fixture(){
 const order={status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync',
  items:[{itemId:'I2'},{itemId:'I'}],orderLifecycleHistory:[]};
 const ledgers=new Map(order.items.map(row=>[row.itemId,{locationSchemaVersion:2,orderId:'O',itemId:row.itemId,lifecycleWarehouseIds:['B','A']}]));
 const storage=new Map(),calls=[],reads=[];let failRead=false,failSave=false,afterRead=()=>{},transport;
 const applied=payload=>{
  if(!order.orderLifecycleHistory.some(h=>h.operationId===payload.operationId)){
   order.orderStatus=payload.nextStatus;order.status=payload.nextStatus==='normal'?'active':'cancelled';
   order.orderLifecycleHistory.push({by:'U',actorRole:'sales',operationId:payload.operationId,
    after:{status:payload.nextStatus,date:payload.date,reason:payload.reason}});
  }
  return {data:{status:'applied',orderId:'O',nextStatus:payload.nextStatus,items:payload.itemIds.map(itemId=>({itemId})),
   receiptId:'single-v2-lifecycle-'+payload.operationId,postCommitAllocation:{status:payload.nextStatus==='cancelled'?'recovery-pending':'not-applicable',sources:[]}}};
 };
 transport=applied;
 const open=()=>{
  const c=vm.createContext({YUSHIN_V2_LIFECYCLE_EMULATOR:true,location:{hostname:'localhost'},
   crypto:require('node:crypto').webcrypto,currentUser:{uid:'U'},currentUserRole:'sales',
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,localDateString:()=> '2026-10-20',normalizedOrderStatus:o=>o.orderStatus,
   sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{if(failSave)throw Error('storage failed');storage.set(k,v);},removeItem:k=>storage.delete(k)},
   db:{collection:n=>({doc:id=>({get:async options=>{
    assert.equal(options?.source,'server');reads.push([n,id]);if(failRead)throw Error('server read failed');afterRead(c);
    const row=n==='orders'?order:ledgers.get(id.slice(3));return {exists:!!row,data:()=>structuredClone(row)};
   }})})},
   firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>({app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'U'},emulatorConfig:{host:'localhost',port:9099}}),
    functions:()=>({app:{options:{projectId:'demo-yushin'}},useEmulator:(h,p)=>{assert.equal(h,'127.0.0.1');assert.equal(p,5001);},
     httpsCallable:name=>async payload=>{assert.equal(name,'setV2OrderLifecycle');calls.push(structuredClone(payload));return transport(payload,c);}})},
   runRoleTransaction:()=>{throw Error('legacy writer forbidden');}});
  vm.runInContext(source,c);return c;
 };
 return {open,order,ledgers,storage,calls,reads,applied,setTransport:f=>transport=f,setReadFailure:v=>failRead=v,setSaveFailure:v=>failSave=v,setAfterRead:f=>afterRead=f};
}
test('lifecycle freezes complete original candidates and retries the identical intent after lost reply and reload',async()=>{
 const f=fixture();f.setTransport(p=>{f.applied(p);throw Error('lost reply');});
 await assert.rejects(f.open().setOrderLifecycleStatus('O','cancelled'),/lost reply/);
 assert.deepEqual(f.calls[0].itemIds,['I','I2']);assert.deepEqual(f.calls[0].warehouseIds,['A','B']);
 assert.equal(f.calls[0].actorUid,undefined);assert.equal(f.calls[0].actorRole,undefined);
 f.ledgers.clear();f.setTransport(p=>({...f.applied(p),data:{...f.applied(p).data,status:'already-applied'}}));
 const c=f.open();c.localDateString=()=> '2026-10-21';const saved=await c.setOrderLifecycleStatus('O','cancelled');
 assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.order.orderLifecycleHistory.length,1);assert.equal(f.storage.size,0);
 assert.equal(saved.v2LifecycleOutcome.postCommitAllocation.status,'recovery-pending');
 assert.equal(Object.keys(saved).includes('v2LifecycleOutcome'),false);
});
test('lifecycle rejects changed pending intent corrupt storage and role changes without a second call',async()=>{
 const f=fixture();f.setTransport(()=>{throw Error('unknown');});const c=f.open();
 await assert.rejects(c.setOrderLifecycleStatus('O','cancelled'));
 await assert.rejects(c.setOrderLifecycleStatus('O','normal'),/未確認/);
 await assert.rejects(c.setOrderLifecycleStatus('O','cancelled',{date:'2026-10-20',reason:'changed'}),/未確認/);
 c.currentUserRole='engineer';assert.throws(()=>c.pendingV2OrderLifecycle('O'),/原帳號與角色/);
 f.storage.set('v2-lifecycle:U:O','broken');assert.throws(()=>f.open().pendingV2OrderLifecycle('O'),/原帳號與角色/);
 assert.equal(f.calls.length,1);
});
test('lifecycle retains original intent on unknown response missing history failed readback or account switch',async()=>{
 for(const failure of ['response','history','readback','account']){
  const f=fixture();f.setTransport((p,c)=>{
   const reply=f.applied(p);
   if(failure==='response')reply.data.receiptId='wrong';
   if(failure==='history')f.order.orderLifecycleHistory=[];
   if(failure==='readback')f.setReadFailure(true);
   if(failure==='account')c.currentUser={uid:'other'};
   return reply;
  });
  await assert.rejects(f.open().setOrderLifecycleStatus('O','cancelled'));assert.equal(f.storage.size,1);
 }
});
test('lifecycle refuses unsafe environment missing original candidates persistence failure and stale actor before sending',async()=>{
 for(const mode of ['host','role','storage','missing-candidates','different-candidates','legacy-ledger','read-actor','date','same-state']){
  const f=fixture(),c=f.open();let next='cancelled',details=null;
  if(mode==='host')c.location.hostname='production.example';
  if(mode==='role')c.currentUserRole='warehouse';
  if(mode==='storage')f.setSaveFailure(true);
  if(mode==='missing-candidates')delete f.ledgers.get('I').lifecycleWarehouseIds;
  if(mode==='different-candidates')f.ledgers.get('I').lifecycleWarehouseIds=['A','C'];
  if(mode==='legacy-ledger')f.ledgers.get('I').locationSchemaVersion=1;
  if(mode==='read-actor')f.setAfterRead(ctx=>ctx.currentUserRole='warehouse');
  if(mode==='date')details={date:'2026-02-30'};
  if(mode==='same-state')next='normal';
  await assert.rejects(c.setOrderLifecycleStatus('O',next,details));assert.equal(f.calls.length,0);
 }
});
test('old lifecycle receipt displays current authoritative status after another restoration, not its historical target',async()=>{
 const f=fixture();f.setTransport(p=>{f.applied(p);throw Error('lost');});await assert.rejects(f.open().setOrderLifecycleStatus('O','cancelled'));
 f.order.orderStatus='normal';f.order.status='active';
 f.setTransport(p=>({data:{...f.applied(p).data,status:'already-applied'}}));
 assert.equal((await f.open().setOrderLifecycleStatus('O','cancelled')).orderStatus,'normal');assert.equal(f.storage.size,0);
});

test('regional callable uses the compat app API, not a region string in the global app argument',async()=>{
 const f=fixture(),c=f.open(),functions=c.firebase.functions();let region;
 c.firebase.app=()=>({functions:value=>{region=value;return functions;}});
 c.firebase.functions=()=>{throw Error('namespace argument is an app, not a region');};
 assert.equal((await c.setOrderLifecycleStatus('O','cancelled')).orderStatus,'cancelled');
 assert.equal(region,'asia-east1');assert.equal(f.calls.length,1);
});
