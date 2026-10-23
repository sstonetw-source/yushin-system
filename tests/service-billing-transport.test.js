'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/service-cases.js','utf8')+'\n'+fs.readFileSync('src/services/order-billing.js','utf8');
function fixture(){
 const storage=new Map(),calls=[];let lose=false,failRead=false,failSave=false,bad=false,after=()=>{};
 let remote={isBilled:false,billingDate:'',statusHistory:[]},receipt=null;
 const input={orderId:'O',operationId:'service-billing-transport-001',isBilled:true,expectedIsBilled:false,billingDate:'2026-10-23'};
 const open=()=>{
  const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'sales',sessionDataGeneration:1,YUSHIN_SERVICE_CASE_EMULATOR:true,location:{hostname:'localhost'},
   sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(failSave)throw Error('save failed');storage.set(k,v);},removeItem:k=>storage.delete(k)},
   db:{collection:()=>({doc:()=>({get:async options=>{assert.equal(options.source,'server');if(failRead)throw Error('read failed');return {exists:true,data:()=>structuredClone(remote)};}})})},
   firebase:{auth:()=>({currentUser:{uid:'U'},app:{options:{projectId:'demo-yushin'}},emulatorConfig:{host:'localhost',port:9099}}),
    app:()=>({functions:()=>({app:{options:{projectId:'demo-yushin'}},useEmulator(){},httpsCallable:name=>async payload=>{
     calls.push({name,input:structuredClone(payload)});
     if(!receipt){remote={isBilled:payload.isBilled,billingDate:payload.billingDate};receipt={...structuredClone(payload),status:'committed'};}
     after(c);if(lose)throw Error('reply lost');
     return {data:{...receipt,status:calls.length===1?'committed':'already-applied',orderId:bad?'WRONG':'O'}};
    }})})}});
  c.globalThis=c;vm.runInContext(source,c);return c;
 };
 return {open,storage,calls,input,remote:()=>remote,reverse:()=>{remote={isBilled:false,billingDate:''};},
  lose:v=>lose=v,readFail:v=>failRead=v,saveFail:v=>failSave=v,bad:v=>bad=v,after:f=>after=f};
}
test('billing lost reply keeps original intent across reload and reads current state after later undo',async()=>{
 const f=fixture();f.lose(true);await assert.rejects(f.open().commitServiceBillingIntent(f.input),/reply lost/);
 assert.equal(f.remote().isBilled,true);assert.equal(f.storage.size,1);f.reverse();f.lose(false);
 const c=f.open();assert.equal(f.calls.length,1,'reload does not submit');
 const result=await c.commitServiceBillingIntent();
 assert.equal(result.receipt.isBilled,true);assert.equal(result.order.isBilled,false);
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.storage.size,0);
});
test('billing unknown results block replacement intents, bad receipts and read failures retain checkpoint',async()=>{
 const f=fixture(),c=f.open();f.readFail(true);
 await assert.rejects(c.commitServiceBillingIntent(f.input),/read failed/);
 for(const patch of [{orderId:'OTHER'},{operationId:'service-billing-other-001'},{billingDate:'2026-10-24'}])
  await assert.rejects(c.commitServiceBillingIntent({...f.input,...patch}),/前次/);
 assert.equal(f.calls.length,1);f.readFail(false);f.bad(true);
 await assert.rejects(c.commitServiceBillingIntent(),/回覆無法核對/);assert.equal(f.storage.size,1);
 f.bad(false);await c.commitServiceBillingIntent();assert.equal(f.storage.size,0);
});
test('billing storage, actor, role, environment and same-user session changes fail closed',async()=>{
 for(const mode of ['save','role','host','session','late-role']){
  const f=fixture(),c=f.open();
  if(mode==='save')f.saveFail(true);if(mode==='role')c.currentUserRole='warehouse';if(mode==='host')c.location.hostname='production.test';
  if(mode==='session')f.after(c=>c.sessionDataGeneration++);if(mode==='late-role')f.after(c=>c.currentUserRole='engineer');
  await assert.rejects(c.commitServiceBillingIntent(f.input),undefined,mode);
  assert.equal(f.calls.length,['session','late-role'].includes(mode)?1:0,mode);
  if(f.calls.length)assert.equal(f.storage.size,1);
 }
});
test('billing definitive callable denial releases intent, unknown errors retain it',async()=>{
 for(const code of ['functions/failed-precondition','functions/permission-denied','functions/unavailable','functions/internal']){
  const f=fixture(),c=f.open();c.serviceCaseTransport=()=>({uid:'U',role:'sales',check(){},call:async()=>{throw Object.assign(Error('denied'),{code});}});
  await assert.rejects(c.commitServiceBillingIntent(f.input),/denied/);
  assert.equal(f.storage.size,['functions/internal','functions/unavailable'].includes(code)?1:0);
 }
});
test('service billing UI keeps authoritative state and prevents old session replies from mutating new cache',async()=>{
 const ui=fs.readFileSync('src/features/orders/order-status.js','utf8').split('window.toggleOrderStatus =')[0];
 for(const changedSession of [false,true]){
  let finish,calls=0;const alerts=[],cacheWrites=[];
  const order={id:'O',items:[{productType:'Service'}],isBilled:false};
  const c=vm.createContext({window:{},currentUser:{uid:'U'},currentUserRole:'sales',sessionDataGeneration:1,ordersCache:[order],pendingOrderStatusKeys:new Set(),
   crypto:{randomUUID:()=> 'a-valid-stable-id'},orderBillingDate:()=>'',localDateString:()=> '2026-10-23',
   pendingServiceBillingIntent:()=>null,renderOrdersList(){},writeAppDataCache:(...x)=>cacheWrites.push(x),currentDeliveryOrderId:null,
   alert:x=>alerts.push(x),commitServiceBillingIntent:()=>{calls++;return new Promise(r=>finish=r);}});
  vm.runInContext(ui,c);const pending=c.toggleServiceOrderBilling(order,true);
  await c.toggleServiceOrderBilling(order,true);assert.equal(calls,1);assert.equal(order.isBilled,false,'no optimistic financial state');
  if(changedSession){c.sessionDataGeneration++;c.ordersCache=[{id:'O',isBilled:false}];}
  finish({order:{id:'O',isBilled:true,billingDate:'2026-10-23'}});await pending;
  assert.equal(c.ordersCache[0].isBilled,!changedSession);assert.equal(cacheWrites.length,changedSession?0:1);assert.equal(alerts.length,0);
 }
});

test('date edit shares the status checkpoint across reload, blocks replacement, and uses the current order after undo',async()=>{
 const f=fixture(),date={...f.input,action:'CHANGE_DATE',expectedIsBilled:true,expectedBillingDate:'2026-10-22'};
 const c=f.open();f.lose(true);await assert.rejects(c.commitServiceBillingIntent(date),/reply lost/);
 await assert.rejects(c.commitServiceBillingIntent(f.input),/前次/);
 f.reverse();f.lose(false);const next=f.open();
 const result=await next.commitServiceBillingIntent();
 assert.equal(f.calls[0].input.action,'CHANGE_DATE');assert.deepEqual(f.calls[0],f.calls[1]);
 assert.equal(result.order.isBilled,false);assert.equal(f.storage.size,0);
 for(const patch of [{action:'UNKNOWN'},{expectedBillingDate:'2026-02-30'},{expectedIsBilled:false}])
  assert.throws(()=>next.normalizeServiceBillingIntent({...date,...patch}));
});
