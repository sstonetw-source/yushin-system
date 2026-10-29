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
 function collection(n){return {doc:id=>({path:n+'/'+id,id}),where(field,_op,value){const terms=[[field,value]];return {query:true,n,terms,cap:0,where(f,_o,v){terms.push([f,v]);return this;},limit(v){this.cap=v;return this;}};}};}
 const db={projectId:'preview-20135',collection,runTransaction:async fn=>{
  let writes=[];
  const snap=(path,v)=>({id:path.split('/')[1],exists:v!==undefined,data:()=>structuredClone(v)});
  const tx={get:async r=>{assert.equal(writes.length,0,'all reads precede writes');if(r.query){const rows=[...docs].filter(([p,v])=>p.startsWith(r.n+'/')&&r.terms.every(([k,x])=>v[k]===x)).slice(0,r.cap).map(([p,v])=>snap(p,v));return {docs:rows,size:rows.length};}return snap(r.path,docs.get(r.path));},
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
