'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const core=require('../modules/service-work-core');
const source=fs.readFileSync('src/services/service-cases.js','utf8');
function fixture(){
 const storage=new Map(),calls=[];let lose=false,badProof=false,failSave=false,afterCall=()=>{};
 const intent={orderId:'O',itemId:'I',caseId:'C',serviceQty:1,event:{id:'E',type:'SAMPLE_RECEIVED',occurredAt:'2026-10-23T01:00:00Z'}};
 const open=()=>{
  const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'sales',YUSHIN_SERVICE_CASE_EMULATOR:true,
   location:{hostname:'localhost'},YushinServiceWork:core,
   sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(failSave)throw Error('storage unavailable');storage.set(k,v);},removeItem:k=>storage.delete(k)},
   firebase:{auth:()=>({app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'U'},emulatorConfig:{host:'localhost',port:9099}}),
    app:()=>({functions:()=>({app:{options:{projectId:'demo-yushin'}},useEmulator(){},httpsCallable:name=>async payload=>{
      calls.push({name,payload:JSON.parse(JSON.stringify(payload))});afterCall(c);
      if(name==='commitServiceCaseEvent'){
       if(lose)throw Error('reply lost');
       return {data:{status:'already-applied',orderId:'O',itemId:'I',caseId:'C',serviceQty:1}};
      }
      return {data:{exists:true,orderId:'O',itemId:'I',caseId:badProof?'OTHER':'C',serviceQty:1,events:[{...intent.event,actorUid:'U'}]}};
    }})})}});
  c.globalThis=c;vm.runInContext(source,c);return c;
 };
 return {open,storage,calls,intent,setLose:v=>lose=v,setBadProof:v=>badProof=v,setSaveFailure:v=>failSave=v,setAfterCall:f=>afterCall=f};
}
test('lost service reply survives reload and confirms the same immutable operation with actual event proof',async()=>{
 const f=fixture();f.setLose(true);
 await assert.rejects(f.open().commitServiceCaseIntent(f.intent),/reply lost/);assert.equal(f.storage.size,1);
 f.setLose(false);await f.open().commitServiceCaseIntent();
 assert.deepEqual(f.calls[0].payload,f.calls[1].payload);assert.equal(f.calls[0].payload.event.actorUid,undefined);
 assert.equal(f.storage.size,0);
});
test('service pending intent blocks changed quantities, different cases and corrupt storage',async()=>{
 const f=fixture(),c=f.open();f.setLose(true);await assert.rejects(c.commitServiceCaseIntent(f.intent));
 for(const patch of [{caseId:'OTHER'},{serviceQty:2},{event:{...f.intent.event,id:'NEW'}}])
  await assert.rejects(c.commitServiceCaseIntent({...f.intent,...patch}),/前次/);
 assert.equal(f.calls.length,1);
 f.storage.set('service-case-pending:U','broken');await assert.rejects(c.commitServiceCaseIntent(),/暫存/);
 assert.equal(f.storage.size,1);
});
test('environment, current actor, storage and read-back failures fail closed',async()=>{
 for(const mode of ['host','flag','role','actor','storage','proof','late-role']){
  const f=fixture(),c=f.open();
  if(mode==='host')c.location.hostname='production.test';if(mode==='flag')c.YUSHIN_SERVICE_CASE_EMULATOR=false;
  if(mode==='role')c.currentUserRole='purchaser';if(mode==='actor')c.currentUser.uid='OTHER';
  if(mode==='storage')f.setSaveFailure(true);if(mode==='proof')f.setBadProof(true);
  if(mode==='late-role')f.setAfterCall(ctx=>ctx.currentUserRole='engineer');
  await assert.rejects(c.commitServiceCaseIntent(f.intent),undefined,mode);
  if(['proof','late-role'].includes(mode))assert.equal(f.storage.size,1,mode);else assert.equal(f.calls.length,0,mode);
 }
});
