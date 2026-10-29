'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitMainTransferPhysical,physicalProject,normalizePhysicalIntent,createMainTransferPhysicalCallables}=require('../functions/main-transfer-physical-service');
const env={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_MAIN_TRANSFER_DISPATCH:'true',ENABLE_PREVIEW_MAIN_TRANSFER_RECEIPT:'true'};
const dispatch={id:'transfer_12345678',requestId:'request_12345678'},receive={id:dispatch.id,operationId:'receive_12345678'};
function fixture(){
 const docs=new Map(),put=(p,v)=>docs.set(p,structuredClone(v));let fail=false,retry=false;
 put('users/U',{role:'warehouse',active:true});put('warehouses/A',{active:true});put('warehouses/MAIN',{active:true,isDefault:true});
 put('inventory/P',{productKey:'P',onHand:10,reserved:5,transferReserved:3});
 put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:6,reserved:4,transferReserved:3});
 put('stockTransferRequests/'+dispatch.requestId,{id:dispatch.requestId,inventoryId:'P',productKey:'P',fromWarehouseId:'A',toWarehouseId:'MAIN',fromStockId:'A__P',qty:3,status:'PENDING'});
 put('inventoryLots/L',{productKey:'P',warehouseId:'A',remainingQty:4,lotNo:'LOT',expiryDate:'2027-01-01'});
 put('inventoryLotCosts/L',{unitCost:99});
 function snap(path,v){return {id:path.split('/')[1],exists:v!==undefined,data:()=>structuredClone(v)};}
 function page(q){const rows=[...docs].filter(([p,v])=>p.startsWith(q.n+'/')&&q.terms.every(([k,x])=>v[k]===x)).sort(([a],[b])=>a.localeCompare(b)).filter(([p])=>!q.after||p.split('/')[1]>q.after).slice(0,q.cap).map(([p,v])=>snap(p,v));return {docs:rows,size:rows.length,empty:!rows.length};}
 function collection(n){return {doc:id=>({path:n+'/'+id,id,get:async()=>snap(n+'/'+id,docs.get(n+'/'+id))}),where(field,_op,value){return {query:true,n,terms:[[field,value]],cap:1000,where(f,_o,v){this.terms.push([f,v]);return this;},limit(v){this.cap=v;return this;},orderBy(){return this;},startAfter(v){this.after=typeof v==='string'?v:v.id;return this;},get:async function(){return page(this);}};}};}

 const db={projectId:'preview-20135',collection,runTransaction:async fn=>{
  let writes=[];
  const snap=(path,v)=>({id:path.split('/')[1],exists:v!==undefined,data:()=>structuredClone(v)});
  const tx={get:async r=>{assert.equal(writes.length,0,'all reads precede writes');if(r.query)return page(r);return snap(r.path,docs.get(r.path));},
   create:(r,d)=>{assert.equal(docs.has(r.path),false);writes.push([r.path,d,false]);},update:(r,d)=>{assert.ok(docs.has(r.path));writes.push([r.path,d,true]);},set:(r,d,o)=>writes.push([r.path,d,!!o?.merge])};
  let out=await fn(tx);if(retry){writes=[];out=await fn(tx);}if(fail)throw Error('late failure');for(const [p,d,merge] of writes)put(p,{...(merge?docs.get(p):{}),...d});return out;
 }};
 return {docs,put,db,setFail:v=>fail=v,setRetry:v=>retry=v,snapshot:()=>JSON.stringify([...docs]),run:(data=dispatch,action='DISPATCH',uid='U')=>commitMainTransferPhysical(db,uid,data,action,env)};
}
test('main request dispatch and receipt are independent atomic events, retrying original IDs never repeats stock or lots',async()=>{
 const f=fixture();f.setRetry(true);assert.equal((await f.run()).status,'applied');
 let snapshot=f.snapshot();assert.equal((await f.run()).status,'already-applied');assert.equal(f.snapshot(),snapshot);
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('inventory/P').reserved,2);assert.equal(f.docs.get('inventory/P').transferInTransit,3);
 assert.equal(f.docs.get('warehouseStocks/A__P').onHand,3);assert.equal(f.docs.get('warehouseStocks/A__P').reserved,1);
 assert.equal(f.docs.get('stockTransferRequests/'+dispatch.requestId).status,'SHIPPED');
 assert.equal(f.docs.get('inventoryLots/L').remainingQty,1);
 assert.equal((await f.run(receive,'RECEIVE')).status,'applied');snapshot=f.snapshot();
 assert.equal((await f.run(receive,'RECEIVE')).status,'already-applied');assert.equal(f.snapshot(),snapshot);
 assert.equal((await f.run()).status,'already-applied');assert.equal(f.snapshot(),snapshot);
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('inventory/P').transferInTransit,0);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,3);assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,0);
 const t=f.docs.get('stockTransfers/'+dispatch.id);assert.equal(t.allocationCompleted,false);assert.equal(t.autoAllocationQty,3);
 assert.ok(t.allocations.every(a=>!('unitCost' in a)&&!('cost' in a)));
 assert.equal(f.docs.get('inventoryLotCosts/'+t.allocations[0].targetLotId).costSourceLotId,'L');
});
test('unbatched sources preserve physical quantities and trace without inventing cost',async()=>{
 const f=fixture();f.docs.delete('inventoryLots/L');await f.run();await f.run(receive,'RECEIVE');
 const t=f.docs.get('stockTransfers/'+dispatch.id),a=t.allocations[0];assert.equal(a.unbatched,true);
 assert.equal(f.docs.get('inventoryLots/'+a.lotId).remainingQty,3);assert.equal(f.docs.get('inventoryLots/'+a.targetLotId).remainingQty,3);
 assert.equal(f.docs.get('inventoryLotCosts/'+a.targetLotId).costSourceLotId,a.lotId);
});
test('live role checks, altered intents, held balance corruption and final transaction errors leave no partial dispatch',async()=>{
 for(const mutate of [f=>f.put('users/U',{role:'sales'}),f=>f.put('users/U',{role:'warehouse',disabled:true}),
  f=>f.put('inventory/P',{productKey:'P',onHand:10,reserved:5,transferReserved:2}),
  f=>f.put('inventoryLots/L',{productKey:'P',warehouseId:'A',remainingQty:'4'}),
  f=>f.put('inventoryLots/L',{productKey:'P',warehouseId:'A',remainingQty:8}),
  f=>f.put('warehouses/MAIN',{active:true,isDefault:false}),f=>f.setFail(true)]){
  const f=fixture();mutate(f);const before=f.snapshot();await assert.rejects(f.run());assert.equal(f.snapshot(),before);
 }
 const f=fixture();await f.run();let before=f.snapshot();await assert.rejects(f.run({...dispatch,requestId:'another_request'}));assert.equal(f.snapshot(),before);
 f.put('users/U',{role:'purchaser'});before=f.snapshot();await assert.rejects(f.run());assert.equal(f.snapshot(),before);
});
test('receipt requires the backend-only dispatch proof, original movement, untouched target lots and matching transit',async()=>{
 for(const mutate of [f=>f.docs.delete('reservationOperationReceipts/main-transfer-dispatch-'+dispatch.id),
  f=>f.docs.delete('inventoryMovements/'+dispatch.id+'-out'),
  f=>f.put('inventoryLots/'+dispatch.id+'-0',{productKey:'P'}),
  f=>f.put('inventoryLotCosts/'+dispatch.id+'-0',{costSourceLotId:'OTHER'}),
  f=>f.put('inventory/P',{productKey:'P',onHand:10,reserved:2,transferInTransit:2,transferFreeInTransit:2}),
  f=>{const t=f.docs.get('stockTransfers/'+dispatch.id);t.allocations[0].lotNo='FORGED';},f=>f.setFail(true)]){
  const f=fixture();await f.run();mutate(f);const before=f.snapshot();await assert.rejects(f.run(receive,'RECEIVE'));assert.equal(f.snapshot(),before);
 }
 const f=fixture();await f.run();await f.run(receive,'RECEIVE');const before=f.snapshot();
 await assert.rejects(f.run({...receive,operationId:'new_receive_12345678'},'RECEIVE'));assert.equal(f.snapshot(),before);
});
test('bounded batch query refuses over 100 sources without partial writes',async()=>{
 const f=fixture();for(let n=0;n<101;n++)f.put('inventoryLots/B'+n,{productKey:'P',warehouseId:'A',remainingQty:0});
 const before=f.snapshot();await assert.rejects(f.run(),/100筆/);assert.equal(f.snapshot(),before);
});
test('separate gates remain closed for production, missing flags and mixed emulator environments',async()=>{
 assert.equal(physicalProject('DISPATCH',env),'preview-20135');
 assert.equal(physicalProject('RECEIVE',{...env,ENABLE_PREVIEW_MAIN_TRANSFER_RECEIPT:'false'}),'');
 assert.equal(physicalProject('DISPATCH',{GCP_PROJECT:'preview-20135'}),'');
 assert.equal(physicalProject('DISPATCH',{...env,GCLOUD_PROJECT:'yu-shing-company'}),'');
 assert.equal(physicalProject('DISPATCH',{...env,FUNCTIONS_EMULATOR:'true'}),'');
 assert.equal(physicalProject('RECEIVE',{GCP_PROJECT:'preview-20135',ENABLE_PREVIEW_MAIN_TRANSFER_RECEIPT:'true'}),'preview-20135');
 const local={GCLOUD_PROJECT:'demo-yushin',ENABLE_MAIN_TRANSFER_DISPATCH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'};
 assert.equal(physicalProject('DISPATCH',local),'demo-yushin');assert.equal(physicalProject('RECEIVE',local),'');
 for(const patch of [{qty:3},{actorUid:'X'},{id:'bad/id'},{id:'x'.repeat(97)}])assert.throws(()=>normalizePhysicalIntent('DISPATCH',{...dispatch,...patch}));
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0;const callables=createMainTransferPhysicalCallables({onCall:(_,fn)=>fn,HttpsError,env,getDatabase:()=>{reads++;return {};}});
 for(const h of Object.values(callables))await assert.rejects(h({data:dispatch}),e=>e.code==='unauthenticated');assert.equal(reads,0);
});

async function allocationFixture(){
 const f=fixture();await f.run();await f.run(receive,'RECEIVE');f.db.projectId='demo-yushin';
 const sibling={itemId:'SIBLING',productId:'OTHER',qty:7,reservedQty:2,shortageQty:5,note:'preserve'};
 f.put('products/P',{productType:'Goods'});
 f.put('orders/TARGET',{status:'active',ownerUid:'U',salesCode:'S',orderDate:'2026-10-01',
  inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_12345678',items:[sibling,
   {itemId:'I',productId:'P',qty:5,warehouseId:'MAIN',reservedQty:0,shortageQty:5}]});
 f.put('inventoryReservations/TARGET__I',{orderId:'TARGET',itemId:'I',productKey:'P',ownerUid:'U',salesCode:'S',
  locationSchemaVersion:2,locations:[],quantity:0,shortageQty:5,status:'shortage',orderDate:'2026-10-01'});
 return {...f,sibling};
}
async function allocationEnvironment(fn){
 const patch={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',
  FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099',ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR:'true'};
 const prior=Object.fromEntries(Object.keys(patch).map(key=>[key,process.env[key]]));
 Object.assign(process.env,patch);
 try{return await fn();}finally{for(const [key,value] of Object.entries(prior)){
  if(value===undefined)delete process.env[key];else process.env[key]=value;
 }}
}
const {drainReleasedV2FreeStock}=require('../functions/single-item-location-service');
test('committed main transfer feeds the existing coordinator and preserves multi-item siblings on lost-reply replay',()=>allocationEnvironment(async()=>{
 const f=await allocationFixture(),source={movementId:dispatch.id+'-in',maxSteps:5};
 // Mutable UI completion cannot grant or consume allocation credit.
 Object.assign(f.docs.get('stockTransfers/'+dispatch.id),{allocationCompleted:true,autoAllocatedQty:999});
 const result=await drainReleasedV2FreeStock(f.db,'U',source);
 assert.equal(result.status,'completed');assert.equal(result.allocatedQty,3);
 assert.deepEqual(f.docs.get('orders/TARGET').items[0],f.sibling);
 assert.equal(f.docs.get('orders/TARGET').items[1].reservedQty,3);
 assert.equal(f.docs.get('orders/TARGET').items[1].shortageQty,2);
 const demands=[...f.docs].filter(([path])=>path.startsWith('procurementDemands/'));
 assert.equal(demands.length,1);assert.equal(demands[0][1].sourceItemIndex,1);
 assert.equal(demands[0][1].requestedQty,2);
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('inventory/P').reserved,5);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,3);
 assert.equal(f.docs.get('inventoryLots/'+dispatch.id+'-0').remainingQty,3,'allocation reserves; it does not ship lots');
 const before=f.snapshot();const replay=await drainReleasedV2FreeStock(f.db,'U',source);
 assert.equal(replay.runId,result.runId);assert.equal(replay.allocatedQty,3);assert.equal(f.snapshot(),before);
 assert.equal([...f.docs.keys()].filter(path=>path.startsWith('reservationOperationReceipts/single-v2-free-batch-')).length,1);
}));
test('main transfer allocation rejects forged proof, movement, lot, role, gate and excessive quantity before starting a job',()=>allocationEnvironment(async()=>{
 for(const mutate of [
  f=>f.docs.delete('reservationOperationReceipts/main-transfer-dispatch-'+dispatch.id),
  f=>f.docs.delete('reservationOperationReceipts/main-transfer-receipt-'+receive.operationId),
  f=>{f.docs.get('inventoryMovements/'+dispatch.id+'-in').qty=4;},
  f=>{f.docs.get('inventoryMovements/'+dispatch.id+'-in').actorUid='OTHER';},
  f=>{f.docs.get('inventoryLots/'+dispatch.id+'-0').costLotId='FORGED';},
  f=>{f.docs.get('stockTransfers/'+dispatch.id).qty=1001;},
  f=>f.put('users/U',{role:'sales'}),
  ()=>{process.env.ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR='false';}
 ]){
  process.env.ENABLE_MAIN_TRANSFER_ALLOCATION_EMULATOR='true';
  const f=await allocationFixture();mutate(f);const before=f.snapshot();
  await assert.rejects(drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in',maxSteps:5}));
  assert.equal(f.snapshot(),before);
 }
}));
test('late allocation commit failure preserves original pending command and resumes it once',()=>allocationEnvironment(async()=>{
 const f=await allocationFixture(),source={movementId:dispatch.id+'-in',maxSteps:5};
 const original=f.db.runTransaction;let injected=false;
 f.db.runTransaction=fn=>original(tx=>fn({...tx,create:(ref,data)=>{
  if(ref.path.startsWith('inventoryMovements/single-v2-free-')&&!injected){injected=true;throw Error('allocation commit interrupted');}
  return tx.create(ref,data);
 }}));
 await assert.rejects(drainReleasedV2FreeStock(f.db,'U',source),/interrupted/);
 assert.equal(f.docs.get('orders/TARGET').items[1].reservedQty,0);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,0);
 const job=[...f.docs.values()].find(value=>value.action==='single_v2_free_stock_batch');
 assert.ok(job.pending);const operationId=job.pending.operationId;
 const result=await drainReleasedV2FreeStock(f.db,'U',source);assert.equal(result.allocatedQty,3);
 assert.equal(f.docs.get('inventoryMovements/single-v2-free-'+operationId).qty,3);
 assert.deepEqual(f.docs.get('orders/TARGET').items[0],f.sibling);
}));
test('allocation updates one target in fifteen lines and refuses oversized or duplicate identities without stock writes',()=>allocationEnvironment(async()=>{
 for(const count of [15,16]){
  const f=await allocationFixture(),order=f.docs.get('orders/TARGET');
  const siblings=Array.from({length:count-1},(_,index)=>({...f.sibling,itemId:'SIBLING-'+index}));
  order.items=[...siblings,order.items[1]];
  const run=()=>drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in',maxSteps:5});
  if(count===15){await run();assert.deepEqual(f.docs.get('orders/TARGET').items.slice(0,-1),siblings);
   assert.equal(f.docs.get('orders/TARGET').items.at(-1).reservedQty,3);
  }else{await assert.rejects(run(),/有效訂單/);assert.deepEqual(f.docs.get('orders/TARGET').items,order.items);
   assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,0);}
 }
 const f=await allocationFixture(),order=f.docs.get('orders/TARGET');order.items[0].itemId='I';
 await assert.rejects(drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in'}),/重複/);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,0);
}));
const {projectMainTransferAllocationCompletion:completeAllocation}=require('../functions/main-transfer-allocation-completion');
test('completion projection requires real completed job, repairs forged display and replays without stock writes',()=>allocationEnvironment(async()=>{
 const f=await allocationFixture();const before=f.snapshot();await assert.rejects(completeAllocation(f.db,'U',dispatch.id));assert.equal(f.snapshot(),before);
 const result=await drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in'});
 const inventory=structuredClone(f.docs.get('inventory/P'));
 Object.assign(f.docs.get('stockTransfers/'+dispatch.id),{allocationCompleted:false,autoAllocatedQty:999});
 const projection=await completeAllocation(f.db,'U',dispatch.id);assert.equal(projection.runId,result.runId);
 const t=f.docs.get('stockTransfers/'+dispatch.id);assert.equal(t.allocationCompleted,true);assert.equal(t.autoAllocatedQty,3);
 assert.deepEqual(f.docs.get('inventory/P'),inventory);const after=f.snapshot();await completeAllocation(f.db,'U',dispatch.id);assert.equal(f.snapshot(),after);
}));
test('completion projection rejects active or corrupt jobs and revoked role, while late failure can retry safely',()=>allocationEnvironment(async()=>{
 const f=await allocationFixture();await drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in'});
 const job=[...f.docs.values()].find(value=>value.action==='single_v2_free_stock_batch'),original=structuredClone(job);
 for(const patch of [{status:'active'},{allocatedQty:999},{intentHash:'forged'}]){
  Object.assign(job,original,patch);const before=f.snapshot();await assert.rejects(completeAllocation(f.db,'U',dispatch.id));assert.equal(f.snapshot(),before);
 }
 Object.assign(job,original);f.put('users/U',{role:'sales'});await assert.rejects(completeAllocation(f.db,'U',dispatch.id),e=>e.code==='permission-denied');f.put('users/U',{role:'warehouse'});
 f.setFail(true);const before=f.snapshot();await assert.rejects(completeAllocation(f.db,'U',dispatch.id),/late failure/);assert.equal(f.snapshot(),before);
 f.setFail(false);await completeAllocation(f.db,'U',dispatch.id);assert.equal(f.docs.get('stockTransfers/'+dispatch.id).allocationCompleted,true);
}));
const {listMainTransferAllocations}=require('../functions/main-transfer-allocation-list');
test('authority list ignores forged completion flags and omits only completed backend jobs without writes',()=>allocationEnvironment(async()=>{
 const f=await allocationFixture();Object.assign(f.docs.get('stockTransfers/'+dispatch.id),{allocationCompleted:true,autoAllocatedQty:3});
 const before=f.snapshot();const page=await listMainTransferAllocations(f.db,'U',{});assert.equal(f.snapshot(),before);
 assert.equal(page.rows.length,1);assert.equal(page.rows[0].transferId,dispatch.id);assert.equal(page.rows[0].status,'pending');
 await drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in'});
 Object.assign(f.docs.get('stockTransfers/'+dispatch.id),{allocationCompleted:false,autoAllocatedQty:0});
 const after=f.snapshot();assert.equal((await listMainTransferAllocations(f.db,'U',{})).rows.length,0);assert.equal(f.snapshot(),after);
}));
test('authority list preserves blocked witnesses, advances bounded pages and rejects role or cursor changes',()=>allocationEnvironment(async()=>{
 const f=await allocationFixture();
 for(let n=0;n<7;n++)f.put('reservationOperationReceipts/aaa-'+n,{kind:'MAIN_TRANSFER_RECEIPT',transferId:'missing-'+n});
 const before=f.snapshot(),first=await listMainTransferAllocations(f.db,'U',{});
 assert.equal(first.rows.length,5);assert.equal(first.hasMore,true);assert.ok(first.rows.every(row=>row.status==='blocked'));
 const second=await listMainTransferAllocations(f.db,'U',{afterId:first.afterId});assert.equal(second.rows.length,3);assert.equal(second.hasMore,false);assert.equal(f.snapshot(),before);
 await assert.rejects(listMainTransferAllocations(f.db,'U',{afterId:'bad/id'}));
 f.put('users/U',{role:'sales'});await assert.rejects(listMainTransferAllocations(f.db,'U',{}),e=>e.code==='permission-denied');
}));
test('explicit Preview source allocates through existing core and completion/list with no Emulator connections',()=>allocationEnvironment(async()=>{
 const f=await allocationFixture();f.db.projectId='preview-20135';
 const keys=['GCLOUD_PROJECT','FUNCTIONS_EMULATOR','FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST','ENABLE_PREVIEW_FREE_STOCK_ALLOCATION','ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION'];
 const prior=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
 try{
  process.env.GCLOUD_PROJECT='preview-20135';for(const key of ['FUNCTIONS_EMULATOR','FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])delete process.env[key];
  process.env.ENABLE_PREVIEW_FREE_STOCK_ALLOCATION='true';process.env.ENABLE_PREVIEW_MAIN_TRANSFER_ALLOCATION='true';
  assert.equal((await listMainTransferAllocations(f.db,'U',{})).rows.length,1);
  const result=await drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in'});assert.equal(result.allocatedQty,3);
  await completeAllocation(f.db,'U',dispatch.id);assert.equal((await listMainTransferAllocations(f.db,'U',{})).rows.length,0);
  assert.deepEqual(f.docs.get('orders/TARGET').items[0],f.sibling);
  const before=f.snapshot();process.env.ENABLE_PREVIEW_FREE_STOCK_ALLOCATION='false';await assert.rejects(drainReleasedV2FreeStock(f.db,'U',{movementId:dispatch.id+'-in'}));assert.equal(f.snapshot(),before);
 }finally{for(const [key,value] of Object.entries(prior)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}));
const {commitOrderTransferPhysical}=require('../functions/order-transfer-physical-service');
const orderEnv={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099',ENABLE_ORDER_TRANSFER_DISPATCH_EMULATOR:'true',ENABLE_ORDER_TRANSFER_RECEIVE_EMULATOR:'true'};
function orderTransferFixture(){
 const f=fixture();f.db.projectId='demo-yushin';f.put('products/P',{productType:'Goods'});
 f.put('orders/ORDER',{status:'active',inventoryReservationStatus:'completed',ownerUid:'S',salesCode:'01',items:[{itemId:'I',productId:'P',qty:3,reservedQty:3,shortageQty:0,warehouseId:'A',dispatchPreparedQty:3,deliveryPlan:{mode:'TRANSFER',warehouseId:'MAIN',contact:'Wh',phone:'123',address:'Taipei'}}]});
 f.put('inventoryReservations/ORDER__I',{status:'active',orderId:'ORDER',itemId:'I',productKey:'P',quantity:3,shortageQty:0,warehouseId:'A'});
 const send={id:'order_transfer_123',orderId:'ORDER',itemId:'I',fromWarehouseId:'A',toWarehouseId:'MAIN',qty:3};
 const receive={id:send.id,operationId:'order_receive_123'};
 return {...f,send,receive,dispatch:()=>commitOrderTransferPhysical(f.db,'U',send,'DISPATCH',orderEnv),receipt:()=>commitOrderTransferPhysical(f.db,'U',receive,'RECEIVE',orderEnv)};
}
test('order transfer dispatch and receipt are atomic distinct events with immutable replay and no customer delivery',async()=>{
 const f=orderTransferFixture();f.setRetry(true);await f.dispatch();let before=f.snapshot();assert.equal((await f.dispatch()).status,'already-applied');assert.equal(f.snapshot(),before);
 assert.equal(f.docs.get('warehouseStocks/A__P').onHand,3);assert.equal(f.docs.get('warehouseStocks/A__P').reserved,1);assert.equal(f.docs.get('inventory/P').reserved,5);
 assert.equal(f.docs.get('orders/ORDER').items[0].warehouseId,'A');assert.equal(f.docs.get('orders/ORDER').items[0].transferPendingId,f.send.id);
 await f.receipt();before=f.snapshot();assert.equal((await f.receipt()).status,'already-applied');assert.equal(f.snapshot(),before);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').reserved,3);assert.equal(f.docs.get('inventory/P').transferInTransit,0);
 assert.equal(f.docs.get('inventoryReservations/ORDER__I').warehouseId,'MAIN');assert.equal(f.docs.get('orders/ORDER').items[0].warehouseId,'MAIN');
 assert.equal(f.docs.get('orders/ORDER').deliveryRecords,undefined);assert.equal(f.docs.get('orders/ORDER').logisticsHistory.length,2);
});
test('order transfer rejects v2, wrong roles, incomplete preparation, conflicting IDs and final commit failures without partial writes',async()=>{
 for(const mutate of [f=>f.put('users/U',{role:'sales'}),f=>{f.docs.get('orders/ORDER').items[0].dispatchPreparedQty=2;},f=>{f.docs.get('inventoryReservations/ORDER__I').locationSchemaVersion=2;},f=>f.setFail(true)]){
  const f=orderTransferFixture();mutate(f);const before=f.snapshot();await assert.rejects(f.dispatch());assert.equal(f.snapshot(),before);
 }
 const f=orderTransferFixture();await f.dispatch();let before=f.snapshot();await assert.rejects(commitOrderTransferPhysical(f.db,'U',{...f.send,qty:2},'DISPATCH',orderEnv));assert.equal(f.snapshot(),before);
 f.docs.delete('inventoryLots/L');before=f.snapshot();await assert.rejects(f.receipt());assert.equal(f.snapshot(),before);
});

test('order transfer receipt refuses reassigned source ownership without moving any stock',async()=>{
 const f=orderTransferFixture();await f.dispatch();f.docs.get('orders/ORDER').ownerUid='OTHER';const before=f.snapshot();await assert.rejects(f.receipt(),/負責人/);assert.equal(f.snapshot(),before);
});
