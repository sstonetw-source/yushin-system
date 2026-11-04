'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {commitSalesCodeTransfer}=require('../functions/sales-code-transfer-service');

const intent=(operationId='transfer-safe-000001',targetUid='new')=>({
 operationId,salesCode:'S01',expectedFromUid:'old',targetUid
});
function fakeDb(seed={}){
 const data=new Map(Object.entries(seed));
 const writes=[];
 function ref(collection,id){return {path:collection+'/'+id,id};}
 function snapshot(reference){return {id:reference.id,exists:data.has(reference.path),
  data:()=>structuredClone(data.get(reference.path))};}
 const db={collection:name=>({
  doc:id=>ref(name,id),
  where:(field,op,value)=>({
   limit:limit=>({query:true,name,field,op,value,limit})
  })
 })};
 db.runTransaction=async fn=>{
  const pending=[];
  const tx={
   get:async x=>{
    if(x.query){
     const docs=[...data.entries()]
      .filter(([p,v])=>p.startsWith(x.name+'/')&&!p.slice(x.name.length+1).includes('/')&&v[x.field]===x.value)
      .slice(0,x.limit).map(([p])=>snapshot({path:p,id:p.split('/').at(-1)}));
     return {docs};
    }
    return snapshot(x);
   },
   set:(r,value,opts)=>pending.push({type:'set',path:r.path,value,merge:!!opts?.merge}),
   update:(r,value)=>pending.push({type:'update',path:r.path,value}),
   create:(r,value)=>pending.push({type:'create',path:r.path,value})
  };
  const result=await fn(tx);
  for(const p of pending){
   if(p.type==='create'&&data.has(p.path))throw Error('Already exists');
   if(p.type==='update'&&!data.has(p.path))throw Error('Missing');
   const previous=p.merge?data.get(p.path)||{}:{};
   data.set(p.path,{...previous,...p.value});
   writes.push(p);
  }
  return result;
 };
 return {db,data,writes};
}
function fixture(overrides={}){
 return fakeDb({
  'users/admin':{role:'admin',name:'主管',active:true},
  'users/old':{role:'sales',name:'原業務',code:'S01',active:true},
  'users/new':{role:'sales',name:'接手業務',code:'',active:true},
  'salesCodes/S01':{code:'S01',currentUserUid:'old',currentUserName:'原業務',handoffHistory:[]},
  ...overrides
 });
}
test('admin backend atomically transfers stable salesCode and writes immutable operation receipt',async()=>{
 const f=fixture();
 const result=await commitSalesCodeTransfer(f.db,'admin',intent());
 assert.equal(result.status,'completed');
 assert.equal(f.data.get('salesCodes/S01').currentUserUid,'new');
 assert.equal(f.data.get('users/old').code,'');
 assert.equal(f.data.get('users/new').salesCode,'S01');
 assert.equal(f.data.get('salesCodes/S01').handoffHistory.length,1);
 assert.equal(f.data.get('salesCodeTransferOperations/transfer-safe-000001').status,'COMPLETED');
 assert.equal(f.writes.length,4);
 // No historical quote/order/forecast or equipment document is rewritten.
 assert.ok(f.writes.every(w=>/^(users|salesCodes|salesCodeTransferOperations)\//.test(w.path)));
 const retry=await commitSalesCodeTransfer(f.db,'admin',intent());
 assert.equal(retry.status,'already-applied');
 assert.equal(f.writes.length,4,'retry must not write again');
});
test('stale holder, unauthorized actor, and occupied target fail without partial writes',async()=>{
 const cases=[
  [fixture({'users/admin':{role:'sales',active:true}}),'permission-denied'],
  [fixture({'salesCodes/S01':{currentUserUid:'another'}}),'failed-precondition'],
  [fixture({'users/new':{role:'sales',name:'接手業務',code:'S02'}}),'failed-precondition']
 ];
 for(const [f,code] of cases){
  await assert.rejects(commitSalesCodeTransfer(f.db,'admin',intent()),e=>e.code===code);
  assert.equal(f.writes.length,0);
 }
});
test('duplicate active holders and operation ID reuse with changed target fail closed',async()=>{
 const dup=fixture({'users/duplicate':{role:'sales',name:'重複',code:'S01'}});
 await assert.rejects(commitSalesCodeTransfer(dup.db,'admin',intent()),/重複/);
 assert.equal(dup.writes.length,0);
 const f=fixture();
 await commitSalesCodeTransfer(f.db,'admin',intent());
 await assert.rejects(commitSalesCodeTransfer(f.db,'admin',intent('transfer-safe-000001','other')),e=>e.code==='already-exists');
 assert.equal(f.writes.length,4);
});
test('one-time transfer can initialize a missing master from a uniquely held staff code',async()=>{
 const f=fixture({'salesCodes/S01':undefined});
 f.data.delete('salesCodes/S01');
 await commitSalesCodeTransfer(f.db,'admin',intent());
 assert.equal(f.data.get('salesCodes/S01').currentUserUid,'new');
});
test('UI uses backend callable and does not bulk rewrite historical sales records on admin load',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../src/features/administration/user-and-system-settings.js'),'utf8');
 assert.match(source,/httpsCallable\('transferSalesCodeOwner'\)/);
 assert.doesNotMatch(source,/syncSalesCodeMasterFromUsers|backfillSalesCodeForLegacyRecords|runFirestoreBatchUpdates/);
 const start=source.indexOf('let pendingSalesTransfer = null;');
 const end=source.indexOf('/* ---------- 資料庫用量估算 ---------- */',start);
 assert.ok(start>=0&&end>start);
 assert.doesNotMatch(source.slice(start,end),/db\.batch\(\)/);
});
