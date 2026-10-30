'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitMainTransferRequest,normalizeMainTransferRequest,mainTransferRequestProject,createMainTransferRequestCallables}=require('../functions/main-transfer-request-service');
const env={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_MAIN_TRANSFER_REQUEST:'true'};
const create={id:'request_123456789',inventoryId:'P',fromWarehouseId:'A',toWarehouseId:'MAIN',qty:3};
const cancel={id:create.id,operationId:'cancel_123456789'};
function fixture(){
 const docs=new Map(),put=(p,v)=>docs.set(p,structuredClone(v));let fail=false;
 put('users/U',{active:true,role:'purchaser'});put('inventory/P',{productKey:'P',onHand:10,reserved:2,transferReserved:0});
 put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:6,reserved:1,transferReserved:0});
 put('warehouses/A',{active:true});put('warehouses/MAIN',{active:true,isDefault:true});
 const db={projectId:'preview-20135',collection:n=>({doc:id=>({path:n+'/'+id,id})}),runTransaction:async fn=>{
  const writes=[];const tx={get:async r=>{assert.equal(writes.length,0);const v=docs.get(r.path);return {exists:v!==undefined,data:()=>structuredClone(v)};},
   create:(r,d)=>{assert.equal(docs.has(r.path),false);writes.push([r.path,d,false]);},update:(r,d)=>writes.push([r.path,d,true])};
  const out=await fn(tx);if(fail)throw Error('late failure');for(const [p,d,merge] of writes)put(p,{...(merge?docs.get(p):{}),...d});return out;
 }};
 return {docs,put,db,setFail:v=>fail=v,snapshot:()=>JSON.stringify([...docs]),run:(data=create,action='CREATE',uid='U')=>commitMainTransferRequest(db,uid,data,action,env)};
}
test('request holds company and source warehouse once; cancel releases the same hold without changing physical stock',async()=>{
 const f=fixture();assert.equal((await f.run()).status,'applied');const once=f.snapshot();
 assert.equal((await f.run()).status,'already-applied');assert.equal(f.snapshot(),once);
 assert.equal(f.docs.get('inventory/P').reserved,5);assert.equal(f.docs.get('warehouseStocks/A__P').reserved,4);
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('warehouseStocks/A__P').onHand,6);
 assert.equal((await f.run(cancel,'CANCEL')).status,'applied');const released=f.snapshot();
 assert.equal(f.docs.get('inventory/P').reserved,2);assert.equal(f.docs.get('warehouseStocks/A__P').reserved,1);
 assert.equal((await f.run(cancel,'CANCEL')).status,'already-applied');assert.equal(f.snapshot(),released);
});
test('changed intent or live role cannot replay an original operation',async()=>{
 const f=fixture();await f.run();let before=f.snapshot();
 await assert.rejects(f.run({...create,qty:2}),e=>e.code==='already-exists');assert.equal(f.snapshot(),before);
 f.put('users/U',{role:'warehouse',active:true});before=f.snapshot();await assert.rejects(f.run(),e=>e.code==='permission-denied');assert.equal(f.snapshot(),before);
});
test('wrong main warehouse, insufficient source, numeric corruption and late errors leave no partial hold',async()=>{
 for(const mutate of [f=>f.put('warehouses/MAIN',{isDefault:false}),f=>f.put('inventory/P',{productKey:'P',onHand:2,reserved:2}),
  f=>f.put('warehouseStocks/A__P',{productKey:'P',warehouseId:'B',onHand:6,reserved:0}),
  f=>f.put('inventory/P',{productKey:'P',onHand:10,reserved:'2'}),f=>f.setFail(true)]){
  const f=fixture();mutate(f);const before=f.snapshot();await assert.rejects(f.run());assert.equal(f.snapshot(),before);
 }
});
test('shipped request cannot release holds; disabled source can release an otherwise valid pending request',async()=>{
 const f=fixture();await f.run();f.put('stockTransferRequests/'+create.id,{...f.docs.get('stockTransferRequests/'+create.id),status:'SHIPPED'});
 const before=f.snapshot();await assert.rejects(f.run(cancel,'CANCEL'),/已寄出/);assert.equal(f.snapshot(),before);
 const g=fixture();await g.run();g.put('warehouses/A',{active:false});await g.run(cancel,'CANCEL');assert.equal(g.docs.get('inventory/P').reserved,2);
});
test('independent gate and strict input reject production, mixed SDKs and injected actor or status',async()=>{
 assert.equal(mainTransferRequestProject(env),'preview-20135');
 for(const patch of [{GCLOUD_PROJECT:'yu-shing-company'},{FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'}])assert.equal(mainTransferRequestProject({...env,...patch}),'');
 for(const patch of [{role:'admin'},{status:'PENDING'},{qty:'3'},{qty:-1},{toWarehouseId:'A'}])assert.throws(()=>normalizeMainTransferRequest('CREATE',{...create,...patch}));
 assert.equal(normalizeMainTransferRequest('CREATE',{...create,qty:0.5}).qty,0.5);
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0;const handlers=createMainTransferRequestCallables({onCall:(_,fn)=>fn,HttpsError,env,getDatabase:()=>{reads++;return {projectId:'yu-shing-company'};}});
 for(const h of Object.values(handlers))await assert.rejects(h({data:create}),e=>e.code==='unauthenticated');assert.equal(reads,0);
 await assert.rejects(handlers.createV2MainTransferRequest({auth:{uid:'U'},data:create}),e=>e.code==='failed-precondition');
});
