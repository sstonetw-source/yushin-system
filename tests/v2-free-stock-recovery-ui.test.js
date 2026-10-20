'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('modules/free-stock-recovery.js','utf8');
function fixture(){
 const calls=[];let handler=async(name,payload)=>name==='listV2FreeStockRecovery'
  ?{rows:[{movementId:'M',warehouseId:'W',productKey:'P',quantity:2,allocatedQty:0,status:'pending'}],hasMore:false,afterId:'M'}
  :{sourceMovementId:payload.movementId,status:'completed',productKey:'P',warehouseId:'W',maxQty:2,allocatedQty:2,recoveryPending:false,affectedOrderIds:['O']};
 const c=vm.createContext({YUSHIN_V2_RECOVERY_EMULATOR:true,location:{hostname:'localhost'},currentUser:{uid:'U'},currentUserRole:'warehouse',
  canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,
  firebase:{app(){return {functions:region=>this.functions(region)};},auth:()=>({app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'U'},emulatorConfig:{host:'localhost',port:9099}}),
   functions:()=>({app:{options:{projectId:'demo-yushin'}},useEmulator:(host,port)=>{assert.equal(host,'127.0.0.1');assert.equal(port,5001);},
    httpsCallable:name=>async payload=>{calls.push({name,payload:structuredClone(payload)});return {data:await handler(name,payload,c)};}})}});
 vm.runInContext(source,c);return {c,calls,api:c.YushinFreeStockRecovery,setHandler:f=>handler=f};
}
test('recovery list is read-only and retry sends the same durable source ID without actor or a replacement operation',async()=>{
 const f=fixture();await f.api.listV2Recovery('cursor');
 assert.deepEqual(f.calls,[{name:'listV2FreeStockRecovery',payload:{afterId:'cursor'}}]);
 f.setHandler(()=>{throw Error('reply lost');});await assert.rejects(f.api.resumeV2Recovery('M'),/reply lost/);
 f.setHandler((name,p)=>({sourceMovementId:p.movementId,status:'completed',productKey:'P',warehouseId:'W',maxQty:2,allocatedQty:2,recoveryPending:false,affectedOrderIds:['O']}));
 assert.equal((await f.api.resumeV2Recovery('M')).completed,true);assert.deepEqual(f.calls[1],f.calls[2]);
 assert.deepEqual(f.calls[1].payload,{movementId:'M'});
});

test('recovery selects a region through the real compat app interface',async()=>{
 const f=fixture(),functions=f.c.firebase.functions();let region;
 f.c.firebase.app=()=>({functions:value=>{region=value;return functions;}});
 f.c.firebase.functions=()=>{throw Error('namespace argument accepts an app only');};
 assert.equal((await f.api.listV2Recovery()).rows.length,1);assert.equal(region,'asia-east1');
});
test('recovery transport checks flag project local Auth role capability and account before and after response',async()=>{
 for(const mode of ['flag','host','sales','capability','account','role-after']){
  const f=fixture();if(mode==='flag')f.c.YUSHIN_V2_RECOVERY_EMULATOR=false;
  if(mode==='host')f.c.location.hostname='production.example';
  if(mode==='sales')f.c.currentUserRole='sales';
  if(mode==='capability')f.c.canReceiveInventoryCapability=()=>false;
  if(['account','role-after'].includes(mode))f.setHandler((name,p,c)=>{if(mode==='account')c.currentUser={uid:'other'};else c.currentUserRole='sales';return {};});
  await assert.rejects(f.api.listV2Recovery());assert.equal(f.calls.length,['account','role-after'].includes(mode)?1:0);
 }
});
test('recovery refuses mismatched source impossible counters and malformed pagination responses',async()=>{
 for(const patch of [{sourceMovementId:'other'},{allocatedQty:3},{recoveryPending:true},{affectedOrderIds:undefined}]){
  const f=fixture();f.setHandler((name,p)=>({sourceMovementId:p.movementId,status:'completed',productKey:'P',warehouseId:'W',maxQty:2,allocatedQty:2,recoveryPending:false,affectedOrderIds:[],...patch}));
  await assert.rejects(f.api.resumeV2Recovery('M'),/尚未確認/);
 }
 const f=fixture();f.setHandler(()=>({rows:[],hasMore:true,afterId:'same'}));await assert.rejects(f.api.listV2Recovery('same'),/無法核對/);
});

test('bounded source read adapter advances beyond a full page of completed checkpoints without writes',async()=>{
 const {listReleasedV2FreeStock,normalizeAutomaticFreeStockIntent}=require('../functions/single-item-location-service'),{createHash}=require('node:crypto');
 const old=process.env.FIRESTORE_EMULATOR_HOST;process.env.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
 const docs=new Map([['users/U',{role:'warehouse',active:true}]]),sources=[];
 for(let i=0;i<23;i++){
  const id='single-v2-life-page-'+String(i).padStart(2,'0');sources.push({id,data:()=>({productKey:'P',warehouseId:'W',freeAllocationQty:2,type:'release',reason:'order_cancelled',qty:-2})});
  if(i<20){
   const runId='source_v2_'+createHash('sha256').update(id).digest('hex').slice(0,40),intent=normalizeAutomaticFreeStockIntent({runId,productKey:'P',warehouseId:'W',maxQty:2});
   docs.set('reservationOperationReceipts/single-v2-free-batch-'+runId,{action:'single_v2_free_stock_batch',actorUid:'U',actorRole:'warehouse',
    productKey:'P',warehouseId:'W',maxQty:2,intentHash:intent.hash,status:'completed',allocatedQty:2,processedSteps:1,pending:null,completionReason:'quantity-reached'});
  }
 }
 const before=JSON.stringify([...docs]);let queryReads=0;
 const db={projectId:'demo-yushin',collection:name=>({doc:id=>({path:name+'/'+id}),where(){return this;},orderBy(){return this;},limit(){return {...this,after:'',startAfter(id){this.after=id;return this;}};}}),
  runTransaction:fn=>fn({get:async ref=>{
   if(ref.path)return {exists:docs.has(ref.path),data:()=>docs.get(ref.path)};
   queryReads++;return {docs:sources.filter(row=>row.id>ref.after).slice(0,21)};
  }})};
 try{
  const first=await listReleasedV2FreeStock(db,'U',{});assert.deepEqual(first.rows,[]);assert.equal(first.hasMore,true);assert.equal(first.afterId,sources[19].id);
  const second=await listReleasedV2FreeStock(db,'U',{afterId:first.afterId});assert.equal(second.rows.length,3);assert.equal(second.hasMore,false);
  assert.equal(queryReads,2);assert.equal(JSON.stringify([...docs]),before);
 }finally{if(old===undefined)delete process.env.FIRESTORE_EMULATOR_HOST;else process.env.FIRESTORE_EMULATOR_HOST=old;}
});
