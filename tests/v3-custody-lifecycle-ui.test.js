'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/order-lifecycle.js','utf8');
function fixture(){
 const order={status:'active',orderStatus:'normal',ownerUid:'U',inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:'sync_attempt_1234',orderLifecycleHistory:[],
  items:[{itemId:'I2',warehouseId:'custody-U',custodyTransferId:'transfer_2'},
   {itemId:'I1',warehouseId:'custody-U',custodyTransferId:'transfer_1'}]};
 const ledgers=new Map(order.items.map(i=>[i.itemId,{orderId:'O',itemId:i.itemId,ownerUid:'U',
  locationSchemaVersion:3,custodyTransferId:i.custodyTransferId,sourceLocationSnapshot:[{warehouseId:'A',reservedQty:1}]}]));
 const pending=new Map(),calls=[],reads=[];let transport,failRead=false;
 const applied=payload=>{
  if(!order.orderLifecycleHistory.some(h=>h.operationId===payload.operationId)){
   order.orderStatus=payload.nextStatus;order.status=payload.nextStatus==='normal'?'active':'cancelled';
   order.orderLifecycleHistory.push({operationId:payload.operationId,by:'U',actorRole:'sales',
    after:{status:payload.nextStatus,date:payload.date,reason:payload.reason}});
  }
  return {data:{orderId:'O',nextStatus:payload.nextStatus,status:'applied',
   receiptId:'v3-custody-lifecycle-'+payload.operationId,items:payload.itemIds.map(itemId=>({itemId}))}};
 };
 transport=applied;
 const open=()=>{
  const context=vm.createContext({YUSHIN_V3_CUSTODY_LIFECYCLE_EMULATOR:true,location:{hostname:'localhost'},
   crypto:require('node:crypto').webcrypto,currentUser:{uid:'U'},currentUserRole:'sales',
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
   normalizedOrderStatus:o=>o.orderStatus,localDateString:()=> '2026-10-29',
   sessionStorage:{getItem:key=>pending.get(key)??null,setItem:(k,v)=>pending.set(k,v),removeItem:k=>pending.delete(k)},
   db:{app:{options:{projectId:'demo-yushin'}},collection:n=>({doc:id=>({get:async options=>{
    assert.equal(options.source,'server');reads.push([n,id]);if(failRead)throw Error('read failed');
    const row=n==='orders'?order:ledgers.get(id.slice(3));return {exists:!!row,data:()=>structuredClone(row)};
   }})})},
   firebase:{auth:()=>({app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'U'},
    emulatorConfig:{host:'localhost',port:9099}}),functions:()=>({}),
    app:()=>({options:{projectId:'demo-yushin'},functions:region=>{
     assert.equal(region,'asia-east1');return {app:{options:{projectId:'demo-yushin'}},
      useEmulator:(host,port)=>{assert.equal(host,'127.0.0.1');assert.equal(port,5001);},
      httpsCallable:name=>async payload=>{
       assert.equal(name,'setV3CustodyOrderLifecycle');calls.push(structuredClone(payload));return transport(payload,context);
      }};
    }})},
   runRoleTransaction:()=>{throw Error('legacy transaction must never execute');}});
  vm.runInContext(source,context);return context;
 };
 return {open,order,ledgers,pending,calls,reads,applied,setTransport:f=>transport=f,setFailRead:v=>failRead=v};
}
test('V3 custody frontend freezes complete intent and retries same operation after lost response and reload',async()=>{
 const f=fixture();f.setTransport(payload=>{f.applied(payload);throw Error('reply lost');});
 await assert.rejects(f.open().setOrderLifecycleStatus('O','cancelled'),/reply lost/);
 assert.deepEqual(f.calls[0].itemIds,['I1','I2']);assert.equal(f.calls[0].syncAttemptId,'sync_attempt_1234');
 assert.equal(f.calls[0].actorRole,undefined);assert.equal(f.pending.size,1);
 f.ledgers.clear();f.setFailRead(false);
 f.setTransport(payload=>({data:{...f.applied(payload).data,status:'already-applied'}}));
 const saved=await f.open().setOrderLifecycleStatus('O','cancelled');
 assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(saved.orderStatus,'cancelled');
 assert.equal(f.pending.size,0);assert.equal(f.order.orderLifecycleHistory.length,1);
});
test('V3 pending intent refuses changed status/reason, corrupt storage and actor changes',async()=>{
 const f=fixture();f.setTransport(()=>{throw Error('unknown response');});const c=f.open();
 await assert.rejects(c.setOrderLifecycleStatus('O','cancelled'));
 await assert.rejects(c.setOrderLifecycleStatus('O','normal'),/相同/);
 await assert.rejects(c.setOrderLifecycleStatus('O','cancelled',{date:'2026-10-29',reason:'changed'}),/相同/);
 c.currentUserRole='engineer';assert.throws(()=>c.pendingV3CustodyLifecycle('O'),/原帳號/);
 f.pending.set('v3-custody-lifecycle:U:O','broken');
 assert.throws(()=>f.open().pendingV3CustodyLifecycle('O'),/原帳號/);
 assert.equal(f.calls.length,1);
});
test('V3 rejects unsafe project/host/Auth and invalid source without legacy fallback',async()=>{
 for(const mode of ['host','project','auth','wrong-source','missing-transfer','status','role']){
  const f=fixture(),c=f.open();
  if(mode==='host')c.location.hostname='yu-shing-company.web.app';
  if(mode==='project')c.db.app.options.projectId='yu-shing-company';
  if(mode==='auth')c.firebase.auth=()=>({app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'U'}});
  if(mode==='wrong-source')f.ledgers.get('I1').locationSchemaVersion=2;
  if(mode==='missing-transfer')delete f.order.items[0].custodyTransferId;
  if(mode==='status')f.order.orderStatus='cancelled';
  if(mode==='role')c.currentUserRole='warehouse';
  await assert.rejects(c.setOrderLifecycleStatus('O','cancelled'));
  assert.equal(f.calls.length,0,mode);assert.equal(f.pending.size,0,mode);
 }
});
test('V3 does not clear uncertain receipt, missing order history or readback failure',async()=>{
 for(const mode of ['receipt','history','read']){
  const f=fixture();f.setTransport(payload=>{
   const reply=f.applied(payload);
   if(mode==='receipt')reply.data.receiptId='bad';
   if(mode==='history')f.order.orderLifecycleHistory=[];
   if(mode==='read')f.setFailRead(true);
   return reply;
  });
  await assert.rejects(f.open().setOrderLifecycleStatus('O','cancelled'));
  assert.equal(f.pending.size,1,mode);
 }
});
test('V3 original intent blocks legacy client writer even after protected flag is disabled',async()=>{
 const f=fixture(),c=f.open();
 f.pending.set('v3-custody-lifecycle:U:O','unconfirmed');
 c.YUSHIN_V3_CUSTODY_LIFECYCLE_EMULATOR=false;
 assert.throws(()=>c.assertNoPendingV2LifecycleBeforeLegacyWrite('O'),/禁止改用舊交易/);
});
