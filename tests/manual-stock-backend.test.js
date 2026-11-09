'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitManualStock,normalizeManualStock,manualStockProject,createManualStockCallables}=require('../functions/manual-stock-service');
const emulator={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 ENABLE_MANUAL_INVENTORY_EMULATOR:'true',ENABLE_INVENTORY_COUNT_EMULATOR:'true'};
const manual={operationId:'MANUAL_123456789',type:'initial',productKey:'P',warehouseId:'W',qty:3,
 lotNo:'B',expiryDate:'2027-12-31',unitCost:0};
const count={operationId:'COUNT_123456789',productKey:'P',warehouseId:'W',target:13,note:'年度盤點'};

function fixture({role='purchaser'}={}){
 const docs=new Map(),clone=x=>structuredClone(x),put=(path,data)=>docs.set(path,clone(data));
 put('users/U',{uid:'U',role,active:true,name:'User'});
 put('products/P',{productId:'P',productName:'正確產品名',manufacturerPartNo:'CODE',brandName:'Qiagen',active:true});
 put('warehouses/W',{active:true});
 put('inventory/P',{productId:'P',productKey:'P',onHand:10,reserved:2,incoming:0});
 put('warehouseStocks/W__P',{productKey:'P',productId:'P',warehouseId:'W',onHand:10,reserved:2,incoming:0});
 put('inventoryLots/L',{productKey:'P',productId:'P',warehouseId:'W',lotNo:'B',expiryDate:'2027-12-31',receivedQty:10,remainingQty:10,
  sourceType:'SUPPLY_ORDER',sourceId:'S',receivedAt:'2026-11-01'});
 let afterCommit=false,abort=false,transactionCount=0,queryCount=0,writeCount=0;
 const ref=(collection,id)=>({path:collection+'/'+id,id});
 const db={projectId:'demo-yushin',databaseId:'(default)',collection:collection=>({
  doc:id=>ref(collection,id),
  where:(field,op,value)=>({collection,field,op,value,limit(max){this.max=max;return this;}})
 }),runTransaction:async fn=>{
  transactionCount++;const writes=[];
  const tx={get:async r=>{
   assert.equal(writes.length,0,'all reads must precede writes');
   if(r.collection){
    queryCount++;assert.equal(r.op,'==');assert.equal(r.max,201);
    const rows=[...docs].filter(([p,d])=>p.startsWith(r.collection+'/')&&d[r.field]===r.value)
     .slice(0,r.max).map(([p,d])=>({id:p.slice(r.collection.length+1),data:()=>clone(d)}));
    return {size:rows.length,docs:rows};
   }
   const data=docs.get(r.path);return {id:r.id,exists:data!==undefined,data:()=>clone(data)};
  },set:(r,data,opts)=>writes.push([r.path,clone(data),!!opts?.merge,'set']),
   update:(r,data)=>writes.push([r.path,clone(data),true,'update']),
   create:(r,data)=>writes.push([r.path,clone(data),false,'create'])};
  const result=await fn(tx);
  if(abort)throw Error('transaction aborted');
  for(const [path,data,merge,operation] of writes){
   if(operation==='create'&&docs.has(path))throw Error('create exists');
   if(operation==='update'&&!docs.has(path))throw Error('update missing');
   put(path,{...(merge?docs.get(path):{}),...data});writeCount++;
  }
  if(afterCommit){afterCommit=false;throw Error('response lost');}
  return result;
 }};
 return {docs,put,db,setAbort:v=>abort=v,setLost:v=>afterCommit=v,
  transactionCount:()=>transactionCount,queryCount:()=>queryCount,writeCount:()=>writeCount,
  snapshot:()=>JSON.stringify([...docs]),
  run:(data=manual,kind='MANUAL_INVENTORY',uid='U')=>commitManualStock(db,uid,data,kind,emulator)};
}

test('only explicitly enabled demo Emulator and independent production permission can access stock endpoints',()=>{
 assert.equal(manualStockProject('MANUAL_INVENTORY',emulator),'demo-yushin');
 assert.equal(manualStockProject('INVENTORY_COUNT',emulator),'demo-yushin');
 for(const patch of [{FIRESTORE_EMULATOR_HOST:'external:8080'},
  {GOOGLE_CLOUD_PROJECT:'yu-shing-company'},{ENABLE_MANUAL_INVENTORY_EMULATOR:'false'}])
  assert.equal(manualStockProject('MANUAL_INVENTORY',{...emulator,...patch}),'');
 const production={GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_MANUAL_INVENTORY_BACKEND:'true'};
 assert.equal(manualStockProject('MANUAL_INVENTORY',production),'yu-shing-company');
 assert.equal(manualStockProject('INVENTORY_COUNT',production),'');
 assert.equal(manualStockProject('MANUAL_INVENTORY',{...production,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),'');
});
test('backend rejects injected identities and invalid IDs, dates, quantities and cost before transaction',async()=>{
 for(const patch of [{actorUid:'ADMIN'},{operationId:'short'},{warehouseId:'a/b'},{type:'delete'},{qty:0},{qty:Infinity},
  {expiryDate:'2027-02-30'},{unitCost:-1},{unitCost:'0'},{lotNo:123},{qty:-1}]){
  const f=fixture();await assert.rejects(f.run({...manual,...patch}));assert.equal(f.transactionCount(),0);
 }
 for(const patch of [{status:'confirmed'},{target:-1},{target:NaN},{note:''},{operationId:'a/b'}]){
  const f=fixture();await assert.rejects(f.run({...count,...patch},'INVENTORY_COUNT'));assert.equal(f.transactionCount(),0);
 }
 assert.equal(normalizeManualStock(manual,'MANUAL_INVENTORY').delta,3);
 assert.equal(normalizeManualStock({...manual,type:'scrap',qty:3,unitCost:undefined},'MANUAL_INVENTORY').delta,-3);
});
test('initial stock adds company, warehouse, lot and protected explicit zero cost atomically',async()=>{
 const f=fixture(),result=await f.run();assert.equal(result.status,'applied');assert.equal(result.delta,3);
 assert.equal(f.docs.get('inventory/P').onHand,13);assert.equal(f.docs.get('warehouseStocks/W__P').onHand,13);
 assert.equal(f.docs.get('inventory/P').itemName,'正確產品名');assert.equal(f.docs.get('inventory/P').lots.reduce((s,x)=>s+x.qty,0),13);
 assert.equal(f.docs.get('inventoryLots/MANUAL_123456789-added').remainingQty,3);
 assert.equal(f.docs.get('inventoryLots/MANUAL_123456789-added').sourceType,'INITIAL_STOCK');
 assert.equal(f.docs.get('inventoryLotCosts/MANUAL_123456789-added').unitCost,0);
 assert.equal(f.docs.get('inventoryMovements/MANUAL_123456789').unitCost,undefined);
 assert.ok(f.queryCount()>=2);
});
test('warehouse role can create pending-cost stock but cannot submit or read protected cost',async()=>{
 const f=fixture({role:'warehouse'}),{unitCost,...request}=manual;
 await f.run(request);assert.equal(f.docs.get('inventoryLotCosts/MANUAL_123456789-added').costPending,true);
 assert.equal((await f.run(request)).status,'already-applied');
 const before=f.snapshot();await assert.rejects(f.run(manual),e=>e.code==='permission-denied');assert.equal(f.snapshot(),before);
});
test('scrap and negative adjustment consume source batch while preserving original receipt ID',async()=>{
 for(const [type,qty] of [['scrap',3],['adjustment',-3]]){
  const f=fixture(),{unitCost,...request}=manual;
  await f.run({...request,type,qty});assert.equal(f.docs.get('inventory/P').onHand,7);
  assert.equal(f.docs.get('warehouseStocks/W__P').onHand,7);
  assert.equal(f.docs.get('inventoryLots/L').remainingQty,7);
  assert.equal(f.docs.get('inventoryLots/L').sourceId,'S');
  assert.equal(f.docs.get('inventoryMovements/MANUAL_123456789').lotAllocations[0].lotId,'L');
  assert.equal(f.docs.has('inventoryLotCosts/MANUAL_123456789-added'),false);
 }
});
test('counts use authoritative warehouse value; zero delta still writes an immutable checkpoint',async()=>{
 for(const target of [13,10,5]){
  const f=fixture();await f.run({...count,target},'INVENTORY_COUNT');
  assert.equal(f.docs.get('inventory/P').onHand,target);
  assert.equal(f.docs.get('warehouseStocks/W__P').onHand,target);
  const audit=f.docs.get('inventoryMovements/COUNT_123456789');assert.equal(audit.qty,target-10);
  assert.equal(audit.countTarget,target);assert.equal(audit.note,'年度盤點');
  if(target===10)assert.equal(f.docs.has('inventoryLots/COUNT_123456789-added'),false);
 }
});
test('lost reply and same-ID concurrent replay never double count or overwrite a later receipt',async()=>{
 const f=fixture();f.setLost(true);await assert.rejects(f.run(),/response lost/);
 f.docs.get('inventory/P').onHand+=5;f.docs.get('warehouseStocks/W__P').onHand+=5;
 const before=f.snapshot(),writes=f.writeCount();const replay=await Promise.all([f.run(),f.run()]);
 assert.ok(replay.every(r=>r.status==='already-applied'));
 assert.equal(f.writeCount(),writes);assert.equal(f.snapshot(),before);
 const conflict={...manual,qty:4};await assert.rejects(f.run(conflict),e=>e.code==='already-exists');
 assert.equal(f.snapshot(),before);
});
test('invalid old stock, reserved, product, warehouse, lot and company-warehouse mismatch fail closed',async()=>{
 for(const mutate of [f=>f.put('inventory/P',{...f.docs.get('inventory/P'),onHand:-1}),
  f=>f.put('inventory/P',{...f.docs.get('inventory/P'),onHand:9}),
  f=>f.put('inventory/P',{...f.docs.get('inventory/P'),reserved:11}),
  f=>f.put('warehouseStocks/W__P',{...f.docs.get('warehouseStocks/W__P'),onHand:9}),
  f=>f.put('warehouseStocks/W__P',{...f.docs.get('warehouseStocks/W__P'),warehouseId:'OTHER'}),
  f=>f.put('products/P',{...f.docs.get('products/P'),active:false}),
  f=>f.put('warehouses/W',{...f.docs.get('warehouses/W'),systemCustody:true}),
  f=>f.put('inventoryLots/L',{...f.docs.get('inventoryLots/L'),remainingQty:11}),
  f=>f.put('inventoryLots/L',{...f.docs.get('inventoryLots/L'),remainingQty:-1})]){
  const f=fixture();mutate(f);const before=f.snapshot();await assert.rejects(f.run());
  assert.equal(f.snapshot(),before);assert.equal(f.writeCount(),0);
 }
});
test('insufficient free stock, unrelated actor and delayed transaction failure leave no partial mutations',async()=>{
 for(const mutate of [f=>f.put('users/U',{role:'sales'}),
  f=>f.put('users/U',{role:'purchaser',disabled:true}),
  f=>f.setAbort(true)]){
  const f=fixture();mutate(f);const before=f.snapshot();await assert.rejects(f.run());assert.equal(f.snapshot(),before);
 }
 const f=fixture(),{unitCost,...base}=manual;
 await assert.rejects(f.run({...base,type:'scrap',qty:9}));assert.equal(f.docs.get('inventory/P').onHand,10);
 await assert.rejects(f.run({...count,target:1},'INVENTORY_COUNT'));assert.equal(f.docs.get('inventory/P').onHand,10);
});
test('Callables reject unauthenticated or disabled gate and never reveal internal errors',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let called=0;const handlers=createManualStockCallables({onCall:(_,fn)=>fn,HttpsError,env:{GCLOUD_PROJECT:'yu-shing-company'},
  getDatabase:()=>{called++;return {projectId:'yu-shing-company'};}});
 for(const handler of Object.values(handlers)){
  await assert.rejects(handler({data:manual}),e=>e.code==='failed-precondition');
  await assert.rejects(handler({auth:{uid:'U'},data:manual}),e=>e.code==='failed-precondition');
 }
 assert.equal(called,0);
});
