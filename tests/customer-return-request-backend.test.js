'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeShipmentIntent}=require('../functions/location-shipment-service');
const {commitReturnRequestOperation,normalizeReturnRequestOperation}=require('../functions/customer-return-request-service');
const {customerReturnRequestBackendProject}=require('../functions/customer-return-request-gate');
const {createCustomerReturnRequestCallables}=require('../functions/customer-return-request-callable');
const env={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_CUSTOMER_RETURN_REQUEST:'true'};
const create={orderId:'O',itemId:'I',operationId:'request_123456789',syncAttemptId:'sync_123456789',qty:2,date:'2026-10-29',reason:'訂錯貨'};
function fixture(){
 const docs=new Map(),clone=structuredClone,put=(p,v)=>docs.set(p,clone(v)),writes=[];
 const plan={mode:'CUSTOMER_SHIP',contact:'C',phone:'02',address:'A'};
 const shipment={id:'shipment_12345678',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',qty:4,date:'2026-10-28',
  notes:'',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT',movementId:'location-ship-shipment_12345678',deliveryPlan:plan,lotAllocations:[{lotId:'L',qty:4}]};
 const original=normalizeShipmentIntent({orderId:'O',itemId:'I',warehouseId:'A',quantity:4,date:shipment.date,notes:'',
  operationId:shipment.id,syncAttemptId:create.syncAttemptId,expectedPlan:plan});
 put('inventoryMovements/'+shipment.movementId,{action:'location_customer_shipment',type:'ship',sourceId:'O',itemId:'I',
  productKey:'P',warehouseId:'A',qty:-4,lotAllocations:shipment.lotAllocations,intentHash:original.hash});
 put('users/U',{role:'sales',active:true});put('users/X',{role:'sales',active:true});put('users/W',{role:'warehouse',active:true});
 put('orders/O',{ownerUid:'U',salesCode:'S',status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:create.syncAttemptId,items:[{itemId:'I',productId:'P',warehouseId:'A',qty:4,reservedQty:0,
   shortageQty:0,warehouseShippedQty:4,deliveredQty:4,returnedQty:0,dispatchPreparedQty:4}],
  warehouseShipmentRecords:[shipment],deliveryRecords:[{id:'D',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',shipmentId:shipment.id,
   qty:4,date:'2026-10-28',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}],returnRecords:[],returnRequests:[],returnPending:false,
  deliveredQty:4,returnedQty:0,isDelivered:true});
 const query=(name,filters=[])=>({name,filters,where:(k,op,v)=>query(name,[...filters,[k,v]]),limit:()=>query(name,filters),doc:id=>({path:name+'/'+id})});
 let fail=false;
 const db={projectId:'preview-20135',collection:name=>query(name),runTransaction:async fn=>{
  const changes=[];const tx={get:async ref=>{
   if(changes.length)throw Error('read after write');
   if(ref.path){const data=docs.get(ref.path);return {exists:data!==undefined,data:()=>clone(data)};}
   return {docs:[...docs].filter(([p,d])=>p.startsWith(ref.name+'/')&&ref.filters.every(([k,v])=>d[k]===v))
    .map(([p,d])=>({id:p.slice(p.indexOf('/')+1),data:()=>clone(d)}))};
  },update:(ref,patch)=>changes.push([ref.path,clone(patch)])};
  const result=await fn(tx);if(fail)throw Error('injected failure');
  for(const [path,patch] of changes){put(path,{...docs.get(path),...patch});writes.push(path);}return result;
 }};
 return {docs,put,writes,db,setFail:v=>fail=v,snapshot:()=>JSON.stringify([...docs]),
  run:(data=create,action='REQUEST',uid='U')=>commitReturnRequestOperation(db,uid,data,action,env)};
}
test('backend application writes only order, derives allowance from shipment proof and replays original request',async()=>{
 const f=fixture();assert.equal((await f.run()).status,'applied');const once=f.snapshot();
 assert.equal((await f.run()).status,'already-applied');assert.equal(f.snapshot(),once);
 assert.deepEqual(f.writes,['orders/O']);assert.equal(f.docs.get('orders/O').returnRequests[0].receivedQty,0);
 await assert.rejects(f.run({...create,qty:3}),e=>e.code==='already-exists');assert.equal(f.snapshot(),once);
});
test('withdrawal retains received history, is idempotent and releases only pending application amount',async()=>{
 const f=fixture();await f.run();const input={orderId:'O',requestId:create.operationId,operationId:'withdraw_12345678',syncAttemptId:create.syncAttemptId};
 assert.equal((await f.run(input,'WITHDRAW')).status,'applied');const once=f.snapshot();
 assert.equal((await f.run(input,'WITHDRAW')).status,'already-applied');assert.equal(f.snapshot(),once);
 assert.equal(f.docs.get('orders/O').returnRequests[0].status,'CANCELLED');assert.equal(f.docs.get('orders/O').returnPending,false);
 await f.run({...create,operationId:'request_223456789',qty:4});
 assert.equal(f.docs.get('orders/O').returnRequests.length,2);
});
test('over-request, live role revocation, other owners, stale sync and forged shipment evidence reject without partial writes',async()=>{
 for(const mutate of [f=>f.put('users/U',{role:'warehouse',active:true}),f=>f.put('users/U',{role:'sales',active:false}),
  f=>f.put('orders/O',{...f.docs.get('orders/O'),ownerUid:'X'}),
  f=>f.put('orders/O',{...f.docs.get('orders/O'),inventoryReservationAttemptId:'changed'}),
  f=>f.docs.delete('inventoryMovements/location-ship-shipment_12345678')]){
  const f=fixture();mutate(f);const before=f.snapshot();await assert.rejects(f.run());assert.equal(f.snapshot(),before);
 }
 const f=fixture();await f.run({...create,qty:3});const before=f.snapshot();
 await assert.rejects(f.run({...create,qty:2,operationId:'request_223456789'}),/超過/);assert.equal(f.snapshot(),before);
 f.setFail(true);await assert.rejects(f.run({...create,qty:1,operationId:'request_223456789'}),/injected/);assert.equal(f.snapshot(),before);
});
test('normalizer rejects actor fields and invalid quantities, and binds action/source to canonical hash',()=>{
 for(const patch of [{actorUid:'W'},{role:'admin'},{qty:0},{qty:1.5},{date:'2026-02-30'},{operationId:'short'}])
  assert.throws(()=>normalizeReturnRequestOperation('REQUEST',{...create,...patch}));
 assert.notEqual(normalizeReturnRequestOperation('REQUEST',create).hash,
  normalizeReturnRequestOperation('REQUEST',{...create,reason:'另一原因'}).hash);
});
test('commercial gate is independent of receipt and both Callables reject Auth/project errors before transactions',async()=>{
 assert.equal(customerReturnRequestBackendProject({GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_CUSTOMER_RETURN:'true'}),'');
 assert.equal(customerReturnRequestBackendProject(env),'preview-20135');
 for(const patch of [{GCLOUD_PROJECT:'yu-shing-company'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},{FUNCTIONS_EMULATOR:'true'}])
  assert.equal(customerReturnRequestBackendProject({...env,...patch}),'');
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0;
 const build=(configuration,projectId)=>createCustomerReturnRequestCallables({onCall:(_opts,fn)=>fn,HttpsError,env:configuration,
  getDatabase:()=>{reads++;return {projectId};}});
 for(const handler of Object.values(build({},'preview-20135')))
  await assert.rejects(handler({auth:{uid:'U'},data:create}),e=>e.code==='failed-precondition');
 for(const handler of Object.values(build(env,'preview-20135')))
  await assert.rejects(handler({data:create}),e=>e.code==='unauthenticated');
 assert.equal(reads,0);
 for(const handler of Object.values(build(env,'yu-shing-company')))
  await assert.rejects(handler({auth:{uid:'U'},data:create}),e=>e.code==='failed-precondition');
 assert.equal(reads,2);
});
