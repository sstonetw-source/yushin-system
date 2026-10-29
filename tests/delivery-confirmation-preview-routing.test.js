'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/delivery-records.js','utf8');
const input={date:'2026-10-28',qty:2,notes:'已簽收',itemId:'I',shipmentId:'SHIP',recordId:'delivery_preview_20261028_abcdef'};
function fixture(){
 const pending=new Map(),calls=[];
 const order={inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_attempt',
  items:[{itemId:'I',qty:5}],warehouseShipmentRecords:[{id:'SHIP',itemId:'I'}],
  deliveryRecords:[],returnRecords:[]};
 let outcome=async payload=>({data:{status:'applied',recordId:payload.operationId,
  orderId:payload.orderId,itemId:payload.itemId,shipmentId:payload.shipmentId}});
 let legacyWrites=0,emulatorCalls=0,readCount=0;
 const auth={app:{options:{projectId:'preview-20135'}},currentUser:{uid:'U'}};
 const functions={app:{options:{projectId:'preview-20135'}},useEmulator:()=>{emulatorCalls++;},
  httpsCallable:name=>async payload=>{assert.equal(name,'confirmV2ShipmentDelivery');calls.push({...payload});return outcome(payload);}};
 const app={options:{projectId:'preview-20135'},functions:()=>functions};
 const db={app,collection:()=>({doc:()=>({get:async options=>{
  assert.equal(options?.source,'server');readCount++;return {exists:true,data:()=>order};}})})};
 const open=()=>{
  const c=vm.createContext({APP_ENVIRONMENT:'preview',YUSHIN_PREVIEW_DELIVERY_CONFIRMATION:true,
   location:{hostname:'preview-20135.web.app'},currentUser:{uid:'U'},currentUserRole:'sales',
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
   sessionStorage:{getItem:key=>pending.get(key)||null,setItem:(key,value)=>pending.set(key,value),
    removeItem:key=>pending.delete(key)},db,
   firebase:{app:()=>app,auth:()=>auth,functions:()=>functions},
   YushinFulfillment:{projectOrderShipmentReturns:()=>({items:[{itemId:'I',shipments:[{shipmentId:'SHIP',pendingQty:3}]}]})},
   runRoleTransaction:()=>{legacyWrites++;throw Error('legacy stock writer must never run');}});
  vm.runInContext(source,c);return c;
 };
 return {open,auth,db,app,functions,order,pending,calls,setOutcome:fn=>{outcome=fn;},
  legacyWrites:()=>legacyWrites,emulatorCalls:()=>emulatorCalls,readCount:()=>readCount};
}

test('Preview confirmation calls the authenticated backend, rereads server data and never uses legacy stock writes',async()=>{
 const f=fixture(),c=f.open();
 const result=await c.saveOrderDeliveryRecord('O',input);
 assert.equal(result,f.order);assert.equal(f.calls.length,1);
 assert.equal(f.calls[0].actorUid,undefined);assert.equal(f.calls[0].actorRole,undefined);
 assert.equal(f.calls[0].operationId,input.recordId);
 assert.equal(f.emulatorCalls(),0);assert.equal(f.legacyWrites(),0);
 assert.equal(f.readCount(),2);assert.equal(f.pending.size,0);
});

test('lost Preview reply preserves the exact operation across reload and rejects changed quantities',async()=>{
 const f=fixture();f.setOutcome(async()=>{throw Error('reply lost');});
 await assert.rejects(f.open().saveOrderDeliveryRecord('O',input),/reply lost/);
 const frozen=f.open().pendingV2DeliveryConfirmation('O');
 assert.equal(frozen.operationId,input.recordId);assert.equal(f.pending.size,1);
 await assert.rejects(f.open().saveOrderDeliveryRecord('O',{...input,qty:3}),/未確認/);
 f.setOutcome(async payload=>({data:{status:'already-applied',recordId:payload.operationId,
  orderId:payload.orderId,itemId:payload.itemId,shipmentId:payload.shipmentId}}));
 await f.open().saveOrderDeliveryRecord('O',{...input,recordId:'different_new_id'});
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[1],f.calls[0]);
 assert.equal(f.pending.size,0);assert.equal(f.legacyWrites(),0);
});

test('Preview confirmation fails closed for disabled flag, wrong host, wrong projects and changed Auth',async()=>{
 for(const mutate of [c=>{c.YUSHIN_PREVIEW_DELIVERY_CONFIRMATION=false;},
  c=>{c.location.hostname='yu-shing-company.web.app';},
  c=>{c.firebase.app().options.projectId='yu-shing-company';},
  c=>{c.db.app.options.projectId='yu-shing-company';},
  c=>{c.firebase.auth().emulatorConfig={host:'localhost',port:9099};},
  c=>{c.firebase.auth().currentUser={uid:'OTHER'};},
  c=>{c.currentUserRole='purchaser';}]){
  const f=fixture(),c=f.open();mutate(c);
  await assert.rejects(c.saveOrderDeliveryRecord('O',input));
  assert.equal(f.calls.length,0);assert.equal(f.legacyWrites(),0);
 }
});

test('Preview blocks every old delivery mutation, even if Preview flag is disabled',async()=>{
 for(const flag of [true,false]){
  const f=fixture(),c=f.open();c.YUSHIN_PREVIEW_DELIVERY_CONFIRMATION=flag;
  for(const action of [()=>c.completeOrderDelivery('O','2026-10-28'),()=>c.cancelOrderDeliveries('O'),
   ()=>c.correctOrderDeliveryRecord('O','D','bad')])
   await assert.rejects(action(),/v2 送達必須逐筆/);
  await assert.rejects(c.saveOrderDeliveryRecord('O',{...input,editId:'D'}));
  assert.equal(f.legacyWrites(),0);
 }
});

test('frozen Preview receipt also forbids legacy fallback after flags or environment are changed',async()=>{
 const f=fixture();f.setOutcome(async()=>{throw Error('reply lost');});
 await assert.rejects(f.open().saveOrderDeliveryRecord('O',input),/reply lost/);
 const c=f.open();c.APP_ENVIRONMENT='production';c.YUSHIN_PREVIEW_DELIVERY_CONFIRMATION=false;
 for(const action of [()=>c.saveOrderDeliveryRecord('O',input),
  ()=>c.completeOrderDelivery('O','2026-10-28'),()=>c.cancelOrderDeliveries('O'),
  ()=>c.correctOrderDeliveryRecord('O','D','bad')])
  await assert.rejects(action(),/禁止改用舊交易/);
 assert.equal(f.calls.length,1);assert.equal(f.legacyWrites(),0);
 assert.equal(f.pending.size,1);
});

test('Preview UI opens partial confirmation and keeps reversal read-only, not legacy cancellation',async()=>{
 const code=fs.readFileSync('src/features/orders/delivery-actions.js','utf8');
 const calls=[],messages=[];
 const c=vm.createContext({window:null,APP_ENVIRONMENT:'preview',YUSHIN_V2_DELIVERY_EMULATOR:false,
  deliveryConfirmationProtectedMode:()=>true,
  currentDeliveryOrderId:'O',pendingDeliveryOrderIds:new Set(),ordersCache:[{id:'O'}],
  canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
  openDeliveryModal:id=>calls.push('open:'+id),openPartialDeliveryForm:()=>calls.push('partial'),
  alert:message=>messages.push(message),completeOrderDelivery:()=>{throw Error('legacy quick delivery');},
  correctOrderDeliveryRecord:()=>{throw Error('legacy reversal');}});
 c.window=c;vm.runInContext(code,c);
 await c.quickCompleteDelivery('O');await c.deleteDeliveryRecord('D');
 assert.deepEqual(calls,['open:O','partial']);
 assert.equal(messages.length,1);assert.match(messages[0],/尚未開放/);
});
