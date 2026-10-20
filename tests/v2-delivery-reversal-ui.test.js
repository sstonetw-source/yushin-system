'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/delivery-records.js','utf8');
const request={date:'2026-10-20',reason:'誤登送達',operationId:'reverse_ui_operation_123456'};
function fixture(){
 const order={inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync',returnRecords:[],
  items:[{itemId:'I'}],deliveryRecords:[{id:'D',orderId:'O',itemId:'I',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}]};
 const storage=new Map(),calls=[];let failRead=false,failSave=false,transport=async payload=>({data:{status:'applied',...payload}}),afterRead=()=>{};
 const open=()=>{
  const context=vm.createContext({YUSHIN_V2_DELIVERY_EMULATOR:true,location:{hostname:'localhost'},
   currentUser:{uid:'U'},currentUserRole:'sales',canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
   sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>{if(failSave)throw Error('storage failed');storage.set(k,v);},removeItem:k=>storage.delete(k)},
   db:{collection:()=>({doc:()=>({get:async options=>{assert.equal(options?.source,'server');if(failRead)throw Error('read failed');afterRead(context);return {exists:true,data:()=>structuredClone(order)};}})})},
   firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>({app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'U'},emulatorConfig:{host:'localhost',port:9099}}),
    functions:()=>({app:{options:{projectId:'demo-yushin'}},useEmulator:()=>{},httpsCallable:name=>async payload=>{assert.equal(name,'reverseV2ShipmentDelivery');calls.push(structuredClone(payload));return transport(payload,context);}})},
   runRoleTransaction:()=>{throw Error('legacy stock writer forbidden');}});
  vm.runInContext(source,context);return context;
 };
 return {open,order,storage,calls,setTransport:f=>transport=f,setReadFailure:v=>failRead=v,setSaveFailure:v=>failSave=v,setAfterRead:f=>afterRead=f};
}
test('v2 reversal keeps the same persisted intent across lost reply reload and changed record list',async()=>{
 const f=fixture();f.setTransport(async()=>{f.order.deliveryRecords=[];throw Error('lost reply');});
 const first=f.open();await assert.rejects(first.reverseV2ShipmentDeliveryEmulator('O','D',request),/lost reply/);
 const frozen=first.pendingV2DeliveryReversal('O');assert.equal(frozen.operationId,request.operationId);
 assert.equal(f.calls[0].actorUid,undefined);assert.equal(f.calls[0].actorRole,undefined);
 await assert.rejects(first.reverseV2ShipmentDeliveryEmulator('O','other',request),/未確認/);
 await assert.rejects(first.reverseV2ShipmentDeliveryEmulator('O','D',{...request,reason:'changed'}),/未確認/);
 f.setTransport(async payload=>({data:{status:'already-applied',...payload}}));
 await f.open().reverseV2ShipmentDeliveryEmulator('O','D',{...request,operationId:'ignored_new_operation'});
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);assert.equal(f.storage.size,0);
});
test('v2 reversal preserves pending intent on mismatched response failed readback or account change',async()=>{
 for(const failure of ['response','readback','account']){
  const f=fixture();f.setTransport(async(payload,c)=>{
   if(failure==='readback')f.setReadFailure(true);
   if(failure==='account')c.currentUser={uid:'another'};
   return {data:{status:'applied',...payload,operationId:failure==='response'?'wrong':payload.operationId}};
  });
  await assert.rejects(f.open().reverseV2ShipmentDeliveryEmulator('O','D',request));
  assert.equal(f.storage.size,1);assert.equal(f.calls.length,1);
 }
});
test('v2 reversal refuses wrong environment unavailable persistence role changes and physical return before sending',async()=>{
 for(const mode of ['flag','host','role','storage','return','stale-record','account-during-read']){
  const f=fixture(),c=f.open();
  if(mode==='flag')c.YUSHIN_V2_DELIVERY_EMULATOR=false;
  if(mode==='host')c.location.hostname='production.example';
  if(mode==='role')c.currentUserRole='purchaser';
  if(mode==='storage')f.setSaveFailure(true);
  if(mode==='return')f.order.returnRecords=[{id:'R'}];
  if(mode==='stale-record')f.order.deliveryRecords=[];
  if(mode==='account-during-read')f.setAfterRead(ctx=>{ctx.currentUser={uid:'other'};});
  await assert.rejects(c.reverseV2ShipmentDeliveryEmulator('O','D',request));
  assert.equal(f.calls.length,0);
 }
});
test('confirmation and reversal retain separate receipts and refuse conflicting pending actions',async()=>{
 const f=fixture(),c=f.open();
 f.storage.set('v2-delivery:U:O',JSON.stringify({orderId:'O',actorUid:'U',actorRole:'sales',operationId:'confirm_original'}));
 await assert.rejects(c.reverseV2ShipmentDeliveryEmulator('O','D',request),/未確認的送達登錄/);
 f.storage.clear();f.setTransport(async()=>{throw Error('unknown');});
 await assert.rejects(c.reverseV2ShipmentDeliveryEmulator('O','D',request));
 await assert.rejects(c.confirmV2ShipmentDeliveryEmulator('O',{date:request.date,qty:1}),/未確認的送達撤銷/);
 c.currentUserRole='engineer';assert.throws(()=>c.pendingV2DeliveryReversal('O'),/原帳號與角色/);
 assert.equal(f.calls.length,1);
});
