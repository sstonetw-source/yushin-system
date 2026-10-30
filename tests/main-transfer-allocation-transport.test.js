'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
function fixture(){const storage=new Map(),calls=[];let transport=async()=>({status:'completed',recoveryPending:false,maxQty:3,allocatedQty:3,affectedOrderIds:['O'],transferId:'T',sourceMovementId:'T-in'});
 function open(preview=false){const options={projectId:preview?'preview-20135':'demo-yushin'},auth={app:{options},currentUser:{uid:'U'},emulatorConfig:preview?undefined:{host:'localhost',port:9099}};
 const functions={app:{options},useEmulator(){if(preview)throw Error('Preview must not connect emulator');},httpsCallable:name=>async payload=>{calls.push({name,payload});return {data:await transport(c)};}};
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'warehouse',APP_ENVIRONMENT:preview?'preview':'',YUSHIN_PREVIEW_MAIN_TRANSFER_ALLOCATION:preview,YUSHIN_MAIN_TRANSFER_ALLOCATION_EMULATOR:!preview,location:{hostname:preview?'preview-20135.web.app':'localhost'},canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,firebase:{functions(){},auth:()=>auth,app:()=>({options,functions:()=>functions})},db:{app:{options}},sessionStorage:{get length(){return storage.size;},key:n=>[...storage.keys()][n],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
 for(const name of ['main-transfer-request-transport','main-transfer-allocation-transport'])vm.runInContext(fs.readFileSync('src/services/'+name+'.js','utf8'),c);return c;}
 return {open,storage,calls,setTransport:fn=>transport=fn};}
test('lost response refresh keeps identical source and clears only confirmed completion',async()=>{const f=fixture();f.setTransport(async()=>{throw Error('reply lost');});await assert.rejects(f.open().resumeMainTransferAllocationBackend('T'),/reply lost/);assert.equal(f.storage.size,1);const c=f.open();assert.equal(c.pendingMainTransferAllocations()[0].id,'T');f.setTransport(async()=>({transferId:'T',sourceMovementId:'T-in',status:'completed',recoveryPending:false,maxQty:3,allocatedQty:3,affectedOrderIds:[]}));await c.resumeMainTransferAllocationBackend('T');assert.deepEqual(structuredClone(f.calls[0]),structuredClone(f.calls[1]));assert.equal(f.storage.size,0);});
test('active reply retains recovery and concurrent clicks share one submission',async()=>{const f=fixture();f.setTransport(async()=>({transferId:'T',sourceMovementId:'T-in',status:'active',recoveryPending:true,maxQty:3,allocatedQty:1,affectedOrderIds:[]}));const c=f.open();await Promise.all([c.resumeMainTransferAllocationBackend('T'),c.resumeMainTransferAllocationBackend('T')]);assert.equal(f.calls.length,1);assert.equal(f.storage.size,1);});
test('disabled flag corrupted storage and account change cannot clear or replace original intent',async()=>{const f=fixture();f.setTransport(async()=>{throw Error('lost');});await assert.rejects(f.open().resumeMainTransferAllocationBackend('T'));const c=f.open();c.YUSHIN_MAIN_TRANSFER_ALLOCATION_EMULATOR=false;await assert.rejects(c.resumeMainTransferAllocationBackend('T'));assert.equal(f.calls.length,1);const key=[...f.storage.keys()][0];f.storage.set(key,'bad');assert.ok(f.open().pendingMainTransferAllocations()[0].error);await assert.rejects(f.open().resumeMainTransferAllocationBackend('T'));assert.equal(f.storage.get(key),'bad');const d=fixture(),x=d.open();x.ensureReservationFunctionsCompat=async()=>{x.currentUser={uid:'OTHER'};};await assert.rejects(x.resumeMainTransferAllocationBackend('T'));assert.equal(d.calls.length,0);});
test('mismatched or excessive reply and role switch preserve pending recovery',async()=>{for(const patch of [{sourceMovementId:'OTHER-in'},{allocatedQty:4},{recoveryPending:true}]){const f=fixture();f.setTransport(async()=>({transferId:'T',sourceMovementId:'T-in',status:'completed',recoveryPending:false,maxQty:3,allocatedQty:3,affectedOrderIds:[],...patch}));await assert.rejects(f.open().resumeMainTransferAllocationBackend('T'));assert.equal(f.storage.size,1);}const f=fixture();f.setTransport(async c=>{c.currentUserRole='sales';return {};});await assert.rejects(f.open().resumeMainTransferAllocationBackend('T'));assert.equal(f.storage.size,1);});

test('authority list advances through empty completed pages and preserves blocked witnesses',async()=>{
 const f=fixture(),c=f.open();
 f.setTransport(async()=>({rows:[],hasMore:true,afterId:'receipt-five'}));
 const empty=await c.readMainTransferAllocationPage();assert.equal(empty.hasMore,true);assert.equal(empty.rows.length,0);
 f.setTransport(async()=>({rows:[{transferId:'invalid/id',status:'blocked',receiptId:'bad-receipt',errorMessage:'需核對'}],hasMore:false,afterId:'receipt-six'}));
 const blocked=await c.readMainTransferAllocationPage(empty.afterId);assert.equal(blocked.rows[0].status,'blocked');
 assert.equal(f.calls[0].name,'listV2MainTransferAllocations');assert.equal(f.calls[1].payload.afterId,'receipt-five');assert.equal(f.storage.size,0);
});
test('authority list rejects stalled cursor, duplicate sources, excessive quantities and identity switches',async()=>{
 const row={transferId:'T',status:'pending',quantity:3,allocatedQty:0};
 for(const page of [{rows:[],hasMore:true,afterId:'same'},{rows:[row,row],hasMore:false,afterId:'last'},{rows:[{...row,allocatedQty:4}],hasMore:false,afterId:'last'}]){
  const f=fixture();f.setTransport(async()=>page);await assert.rejects(f.open().readMainTransferAllocationPage('same'));assert.equal(f.storage.size,0);
 }
 const f=fixture();f.setTransport(async c=>{c.currentUserRole='sales';return {rows:[],hasMore:false,afterId:''};});await assert.rejects(f.open().readMainTransferAllocationPage());
});
test('authority list fails closed when flag disabled and leaves recovery source untouched',async()=>{
 const f=fixture(),c=f.open();f.setTransport(async()=>{throw Error('lost');});await assert.rejects(c.resumeMainTransferAllocationBackend('T'));
 c.YUSHIN_MAIN_TRANSFER_ALLOCATION_EMULATOR=false;await assert.rejects(c.readMainTransferAllocationPage());assert.equal(f.calls.length,1);assert.equal(f.storage.size,1);
});
test('explicit Preview list and recovery use matching project without connecting Emulator',async()=>{
 const f=fixture();f.setTransport(async()=>{throw Error('lost Preview reply');});await assert.rejects(f.open(true).resumeMainTransferAllocationBackend('T'),/lost Preview/);
 const c=f.open(true);assert.equal(c.pendingMainTransferAllocations()[0].id,'T');
 f.setTransport(async()=>({transferId:'T',sourceMovementId:'T-in',status:'completed',recoveryPending:false,maxQty:3,allocatedQty:3,affectedOrderIds:[]}));await c.resumeMainTransferAllocationBackend('T');assert.equal(f.storage.size,0);
 f.setTransport(async()=>({rows:[],hasMore:false,afterId:''}));await c.readMainTransferAllocationPage();
 c.YUSHIN_PREVIEW_MAIN_TRANSFER_ALLOCATION=false;await assert.rejects(c.readMainTransferAllocationPage());
});
