'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const fulfillment=require('../modules/fulfillment-core');
const source=fs.readFileSync('src/services/dispatch-preparation.js','utf8');
function fixture(role='purchaser'){
 const docs=new Map([['orders/O',{status:'normal',ownerUid:'sales',salesCode:'S',items:[
  {itemId:'I',productId:'P',warehouseId:'A',qty:5,reservedQty:3,dispatchPreparedQty:0},
  {itemId:'J',productId:'Q',warehouseId:'B',qty:8,reservedQty:2,dispatchPreparedQty:0}]}]]);
 let fail=false,lost=false,queue=Promise.resolve();
 const c=vm.createContext({currentUser:{uid:'buyer'},currentUserRole:role,
  db:{collection:n=>({doc:id=>({path:n+'/'+id})})},
  normalizedOrderStatus:o=>o.status,normalizedOrderItems:o=>structuredClone(o.items),
  itemDispatchState:(o,i)=>o.inventoryReservationStatus==='pending'?{pending:0,prepared:0}:fulfillment.dispatchState(i),
  deliveryActor:()=>c.currentUser.uid,orderWorkIndexFields:()=>({workCategories:['shipping']}),
  YushinOrderEntry:{validateTrade:()=>({valid:true})},
  runRoleTransaction:callback=>{
   const run=async()=>{
    const writes=[];await callback({get:async r=>({exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))}),
     set:(r,d)=>writes.push([r.path,d]),update:(r,d)=>writes.push([r.path,{...docs.get(r.path),...d}])});
    if(fail)throw Error('injected rollback');
    for(const [k,v] of writes)docs.set(k,structuredClone({...v}));
    if(lost){lost=false;throw Error('lost response');}
   };
   const next=queue.then(run);queue=next.catch(()=>{});return next;
  }});
 vm.runInContext(source,c);
 const intent=(patch={})=>({operationId:'dispatch-ui-AAAAAAAAAAAAAAA',orderId:'O',itemId:'I',actorUid:'buyer',actorRole:role,quantity:3,expectedPreparedQty:0,...patch});
 return {c,docs,intent,run:a=>c.prepareOrderDispatch('O','I',a||intent()),
  order:()=>docs.get('orders/O'),records:()=>[...docs.keys()].filter(k=>k.startsWith('dispatchRecords/')),
  fail:()=>fail=true,lose:()=>lost=true};
}
test('dispatch freezes one item quantity across a multi-item/two-warehouse order and only writes paperwork',async()=>{
 const f=fixture(),other=structuredClone(f.order().items[1]);await f.run();
 assert.equal(f.order().items[0].dispatchPreparedQty,3);assert.deepEqual(f.order().items[1],other);
 assert.equal(f.records().length,1);assert.equal(f.docs.size,2);assert.equal(f.order().items[0].reservedQty,3);
 await f.run();assert.equal(f.records().length,1);
});
test('lost response then additional stock retries the same receipt without preparing the new arrival',async()=>{
 const f=fixture();f.lose();await assert.rejects(f.run(),/lost response/);
 f.order().items[0].reservedQty=5;await f.run();assert.equal(f.order().items[0].dispatchPreparedQty,3);
 await f.run(f.intent({operationId:'dispatch-ui-BBBBBBBBBBBBBBB',quantity:2,expectedPreparedQty:3}));
 assert.equal(f.order().items[0].dispatchPreparedQty,5);assert.equal(f.records().length,2);
});
test('concurrent same operation reuses one receipt; competing operations must refresh their prepared baseline',async()=>{
 const f=fixture();await Promise.all([f.run(),f.run()]);assert.equal(f.records().length,1);
 const g=fixture(),results=await Promise.allSettled([g.run(),g.run(g.intent({operationId:'dispatch-ui-BBBBBBBBBBBBBBB'}))]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(g.records().length,1);
});
test('operation ID rejects changed quantity or a different actor',async()=>{
 const f=fixture();await f.run();await assert.rejects(f.run(f.intent({quantity:2})),/識別碼/);
 f.c.currentUser={uid:'another'};await assert.rejects(f.run(f.intent({actorUid:'another'})),/識別碼/);
});
for(const role of ['sales','engineer','warehouse'])test(role+' cannot call the dispatch service directly',async()=>{
 const f=fixture(role);await assert.rejects(f.run(),/角色/);assert.equal(f.records().length,0);
});
test('admin and purchaser are accepted without granting warehouse dispatch preparation',async()=>{
 for(const role of ['admin','purchaser']){const f=fixture(role);await f.run();assert.equal(f.records().length,1);}
});
test('transaction failure rolls back both paperwork and order, preserving a retryable operation',async()=>{
 const f=fixture(),before=structuredClone([...f.docs]);f.fail();await assert.rejects(f.run(),/rollback/);assert.deepEqual([...f.docs],before);
});
test('stale quantities, pending sync, cancelled, service/direct all reject without writes',async()=>{
 for(const patch of [o=>o.items[0].reservedQty=2,o=>o.inventoryReservationStatus='pending',o=>o.status='cancelled',
  o=>o.items[0].fulfillmentType='DIRECT_SHIP',o=>o.items[0].productType='SERVICE']){
  const f=fixture();patch(f.order());await assert.rejects(f.run());assert.equal(f.records().length,0);
 }
});
test('session change while reading stops transaction and retains no receipt',async()=>{
 const f=fixture(),original=f.c.db.collection;
 f.c.db.collection=n=>{const r=original(n);if(n==='inventoryReservations')f.c.currentUserRole='sales';return r;};
 await assert.rejects(f.run(),/角色/);assert.equal(f.records().length,0);
});
function emulatorFixture(){
 const f=fixture(),calls=[],auth={app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'buyer'},emulatorConfig:{host:'127.0.0.1',port:9099}};
 const functions={app:auth.app,useEmulator:(...args)=>calls.push({endpoint:args}),httpsCallable:name=>async data=>{
  calls.push({name,data});if(f.c.replyError)throw f.c.replyError;
  return {data:{status:'applied',orderId:'O',itemId:'I',qty:data.quantity,recordId:'v2-'+data.operationId}};}};
 f.c.YUSHIN_V2_DISPATCH_EMULATOR=true;f.c.location={hostname:'localhost'};f.c.firebase={auth:()=>auth,functions:()=>functions};
 f.c.runRoleTransaction=()=>{throw Error('legacy fallback forbidden');};
 f.c.db.collection=n=>({doc:id=>({get:async()=>{f.c.afterRead?.();return {exists:true,data:()=>({...f.order(),latest:true})};}})});
 return {...f,calls,auth,functions,run:()=>f.c.prepareOrderDispatch('O','I',f.intent({syncAttemptId:'original-sync'}))};
}
test('v2 dispatch transmits only frozen intent through local Functions and refreshes the actual source without a legacy write',async()=>{
 const f=emulatorFixture(),before=structuredClone([...f.docs]);const result=await f.run();assert.equal(result.latest,true);assert.deepEqual([...f.docs],before);
 assert.deepEqual(Array.from(f.calls[0].endpoint),['127.0.0.1',5001]);assert.equal(f.calls[1].name,'prepareV2OrderDispatch');
 assert.equal(f.calls[1].data.expectedPreparedQty,0);assert.equal(f.calls[1].data.syncAttemptId,'original-sync');assert.equal(f.calls[1].data.actorUid,undefined);
});
test('v2 dispatch refuses remote projects hosts or Auth and actual account mismatch before sending a request',async()=>{
 for(const change of [f=>f.c.location.hostname='example.com',f=>f.auth.app.options.projectId='production',f=>f.auth.emulatorConfig=null,
  f=>f.auth.emulatorConfig.port=9098,f=>f.auth.currentUser={uid:'other'}]){
  const f=emulatorFixture();change(f);await assert.rejects(f.run());assert.equal(f.calls.length,0);assert.equal(f.records().length,0);
 }
});
test('only the server confirmed stale baseline clears as dispatch-stale; network uncertainty remains retryable',async()=>{
 const f=emulatorFixture();f.c.replyError={code:'functions/failed-precondition',details:{reason:'dispatch-stale'},message:'stale'};
 await assert.rejects(f.run(),e=>e.code==='dispatch-stale');f.c.replyError={code:'functions/unavailable',message:'unknown'};
 await assert.rejects(f.run(),e=>e.code==='functions/unavailable');assert.equal(f.records().length,0);
});
test('v2 source refresh rejects a session change and an old v2 intent cannot fall back when its mode is disabled',async()=>{
 const f=emulatorFixture();f.c.afterRead=()=>f.c.currentUserRole='sales';await assert.rejects(f.run(),/角色/);
 const g=emulatorFixture();g.c.YUSHIN_V2_DISPATCH_EMULATOR=false;await assert.rejects(g.run(),/不可改用一般交易/);assert.equal(g.calls.length,0);
});
