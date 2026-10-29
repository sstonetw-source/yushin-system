'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const service=fs.readFileSync('src/services/delivery-records.js','utf8');
const request={date:'2026-10-28',reason:'誤登送達',operationId:'reversal_preview_20261028_abcdef'};
function fixture(){
 const pending=new Map(),calls=[];
 const order={inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_attempt',
  items:[{itemId:'I',qty:5}],deliveryRecords:[{id:'D',orderId:'O',itemId:'I',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}],returnRecords:[]};
 let outcome=async payload=>({data:{status:'applied',operationId:payload.operationId,
  orderId:payload.orderId,itemId:payload.itemId,deliveryRecordId:payload.deliveryRecordId}});
 let legacyWrites=0,emulatorCalls=0,readCount=0;
 const auth={app:{options:{projectId:'preview-20135'}},currentUser:{uid:'U'}};
 const functions={app:{options:{projectId:'preview-20135'}},useEmulator:()=>{emulatorCalls++;},
  httpsCallable:name=>async payload=>{assert.equal(name,'reverseV2ShipmentDelivery');calls.push({...payload});return outcome(payload);}};
 const app={options:{projectId:'preview-20135'},functions:()=>functions};
 const db={app,collection:()=>({doc:()=>({get:async options=>{
  assert.equal(options?.source,'server');readCount++;return {exists:true,data:()=>order};}})})};
 const open=()=>{
  const c=vm.createContext({APP_ENVIRONMENT:'preview',YUSHIN_PREVIEW_DELIVERY_REVERSAL:true,
   location:{hostname:'preview-20135.web.app'},currentUser:{uid:'U'},currentUserRole:'sales',
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
   sessionStorage:{getItem:key=>pending.get(key)||null,setItem:(key,value)=>pending.set(key,value),
    removeItem:key=>pending.delete(key)},db,firebase:{app:()=>app,auth:()=>auth,functions:()=>functions},
   runRoleTransaction:()=>{legacyWrites++;throw Error('legacy writer forbidden');}});
  vm.runInContext(service,c);return c;
 };
 return {open,auth,app,functions,order,pending,calls,setOutcome:fn=>{outcome=fn;},
  legacyWrites:()=>legacyWrites,emulatorCalls:()=>emulatorCalls,readCount:()=>readCount};
}

test('Preview reversal uses its own Callable and rereads server order without stock writes',async()=>{
 const f=fixture(),c=f.open();
 const result=await c.reverseV2ShipmentDeliveryEmulator('O','D',request);
 assert.equal(result,f.order);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].operationId,request.operationId);
 assert.equal(f.calls[0].actorUid,undefined);assert.equal(f.calls[0].actorRole,undefined);
 assert.equal(f.emulatorCalls(),0);assert.equal(f.legacyWrites(),0);
 assert.equal(f.readCount(),2);assert.equal(f.pending.size,0);
});

test('unknown reply freezes original reversal payload across page reload and rejects changes',async()=>{
 const f=fixture();f.setOutcome(async()=>{throw Error('reply lost');});
 await assert.rejects(f.open().reverseV2ShipmentDeliveryEmulator('O','D',request),/reply lost/);
 const frozen=f.open().pendingV2DeliveryReversal('O');
 assert.equal(frozen.operationId,request.operationId);assert.equal(f.pending.size,1);
 await assert.rejects(f.open().reverseV2ShipmentDeliveryEmulator('O','D',{...request,reason:'changed'}),/未確認/);
 f.order.deliveryRecords=[];
 f.setOutcome(async payload=>({data:{status:'already-applied',operationId:payload.operationId,
  orderId:payload.orderId,itemId:payload.itemId,deliveryRecordId:payload.deliveryRecordId}}));
 await f.open().reverseV2ShipmentDeliveryEmulator('O','D',{...request,operationId:'another_new_id'});
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);
 assert.equal(f.pending.size,0);assert.equal(f.legacyWrites(),0);
});

test('Preview reversal rejects disabled flag, wrong host/project, emulator auth and changed identity',async()=>{
 for(const mutate of [c=>{c.YUSHIN_PREVIEW_DELIVERY_REVERSAL=false;},
  c=>{c.location.hostname='yu-shing-company.web.app';},
  c=>{c.firebase.app().options.projectId='yu-shing-company';},
  c=>{c.db.app.options.projectId='yu-shing-company';},
  c=>{c.firebase.auth().emulatorConfig={host:'localhost',port:9099};},
  c=>{c.firebase.auth().currentUser={uid:'OTHER'};},
  c=>{c.currentUserRole='purchaser';}]){
  const f=fixture(),c=f.open();mutate(c);
  await assert.rejects(c.reverseV2ShipmentDeliveryEmulator('O','D',request));
  assert.equal(f.calls.length,0);assert.equal(f.legacyWrites(),0);
 }
});

test('pending Preview reversal forbids legacy delivery writes after flag or environment changes',async()=>{
 const f=fixture();f.setOutcome(async()=>{throw Error('reply lost');});
 await assert.rejects(f.open().reverseV2ShipmentDeliveryEmulator('O','D',request),/reply lost/);
 const c=f.open();c.APP_ENVIRONMENT='production';c.YUSHIN_PREVIEW_DELIVERY_REVERSAL=false;
 for(const action of [()=>c.saveOrderDeliveryRecord('O',{date:'2026-10-28',qty:1,recordId:'legacy_new_id'}),
  ()=>c.completeOrderDelivery('O','2026-10-28'),()=>c.cancelOrderDeliveries('O'),
  ()=>c.correctOrderDeliveryRecord('O','D','bad')])
  await assert.rejects(action(),/禁止改用舊交易/);
 assert.equal(f.calls.length,1);assert.equal(f.pending.size,1);assert.equal(f.legacyWrites(),0);
});

test('Preview UI sends approved reversal through the protected route and never through legacy correction',async()=>{
 const code=fs.readFileSync('src/features/orders/delivery-actions.js','utf8');
 const calls=[],messages=[];
 const c=vm.createContext({window:null,APP_ENVIRONMENT:'preview',YUSHIN_V2_DELIVERY_EMULATOR:false,
  YUSHIN_PREVIEW_DELIVERY_REVERSAL:true,currentDeliveryOrderId:'O',pendingDeliveryOrderIds:new Set(),
  ordersCache:[{id:'O'}],canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
  pendingV2DeliveryReversal:()=>null,prompt:()=> '誤登送達',localDateString:()=> '2026-10-28',
  deliveryRecordId:()=> 'reversal_preview_20261028_abcdef',
  reverseV2ShipmentDeliveryEmulator:async(orderId,id,payload)=>{calls.push({orderId,id,payload});return {};},
  correctOrderDeliveryRecord:()=>{throw Error('legacy correction forbidden');},
  resetDeliveryForm:()=>{},renderOrderLifecycleModal:()=>{},renderDeliveryModal:()=>{},renderOrdersList:()=>{},
  alert:message=>messages.push(message)});
 c.window=c;vm.runInContext(code,c);
 c.renderDeliveryModal=()=>{};c.resetDeliveryForm=()=>{};c.renderOrderLifecycleModal=()=>{};c.renderOrdersList=()=>{};
 await c.deleteDeliveryRecord('D');
 assert.equal(calls.length,1);assert.equal(calls[0].id,'D');assert.equal(messages.length,0);
 c.YUSHIN_PREVIEW_DELIVERY_REVERSAL=false;
 await c.deleteDeliveryRecord('D');
 assert.equal(calls.length,1);assert.match(messages[0],/尚未開放/);
});
