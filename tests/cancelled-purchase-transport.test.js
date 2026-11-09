'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(mode='preview'){
 const storage=new Map(),calls=[];let supply,lose=false,after=()=>{},tamper=false;
 const input={supplyId:'S',warehouseId:'A',expectedDirect:true};
 const open=()=>{
  const project=mode==='production'?'yu-shing-company':'preview-20135';
  const options={projectId:project},auth={app:{options},currentUser:{uid:'U'}};
  const functions={app:{options},useEmulator:()=>{throw Error('wrong emulator');},httpsCallable:name=>async p=>{
   assert.equal(name,'keepV2CancelledPurchaseStock');calls.push(structuredClone(p));const status=supply?'already-applied':'applied';
   supply??={customerCancellationDisposition:'KEEP_STOCK',keepStockOperationId:p.operationId,customerCancellationResolvedBy:'U',keepStockActorRole:'purchaser',keepStockIntentHash:'hash',originalFulfillmentType:'DIRECT_SHIP',fulfillmentType:'WAREHOUSE',warehouseId:p.warehouseId};
   if(lose){lose=false;throw Error('reply lost');}after(c);return {data:{status,supplyId:'S',operationId:tamper?'wrong':p.operationId,actorUid:'U',actorRole:'purchaser'}};
  }};
  const c=vm.createContext({APP_ENVIRONMENT:mode,YUSHIN_PREVIEW_CANCELLED_PURCHASE:mode==='preview',
   YUSHIN_PRODUCTION_CANCELLED_PURCHASE_BACKEND:mode==='production',YUSHIN_PRODUCTION_CANCELLED_PURCHASE_LEGACY_BLOCKED:mode==='production',
   currentUser:{uid:'U'},currentUserRole:'purchaser',location:mode==='production'
    ?{origin:'https://sstonetw-source.github.io',pathname:'/yushin-system/',hostname:'sstonetw-source.github.io'}
    :{hostname:'preview-20135.web.app'},
   firebase:{auth:()=>auth,functions:()=>{},app:()=>({options,functions:()=>functions})},db:{app:{options:{projectId:project}},collection:()=>({doc:()=>({get:async()=>({exists:!!supply,data:()=>structuredClone(supply)})})})},
   canCreatePurchaseOrderCapability:()=>true,lifecycleRecordId:()=> 'keep_stock_123456789',sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  vm.runInContext(fs.readFileSync('src/infrastructure/production-transaction.js','utf8'),c);
  vm.runInContext(fs.readFileSync('src/services/cancelled-purchase-transport.js','utf8'),c);
  vm.runInContext(fs.readFileSync('src/services/customer-return.js','utf8'),c);return c;
 };
 return {input,storage,calls,open,setLose:v=>lose=v,setAfter:fn=>after=fn,setTamper:v=>tamper=v};
}
test('lost response resumes original intent after reload with no legacy writes',async()=>{
 const f=fixture();f.setLose(true);await assert.rejects(f.open().commitCancelledPurchaseKeepStock(f.input),/reply lost/);
 assert.equal(f.storage.size,1);await f.open().commitCancelledPurchaseBackend('S');assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.storage.size,0);
});
test('pending freezes warehouse and method; disabled flag cannot fall back to old transaction',async()=>{
 const f=fixture(),c=f.open();f.setLose(true);await assert.rejects(c.commitCancelledPurchaseKeepStock(f.input));
 await assert.rejects(c.commitCancelledPurchaseKeepStock({...f.input,warehouseId:'B'}),/未確認/);
 c.YUSHIN_PREVIEW_CANCELLED_PURCHASE=false;
 await assert.rejects(c.commitCancelledPurchaseKeepStock(f.input),/旗標/);assert.equal(f.calls.length,1);assert.equal(f.storage.size,1);
 const fresh=fixture(),d=fresh.open();d.YUSHIN_PREVIEW_CANCELLED_PURCHASE=false;
 await assert.rejects(d.commitCancelledPurchaseKeepStock(fresh.input),/旗標/);assert.equal(fresh.calls.length,0);
});
test('in-flight identity/project/flag changes and bad reply retain checkpoint',async()=>{
 for(const mode of ['role','db','flag','reply']){
  const f=fixture(),c=f.open();if(mode==='reply')f.setTamper(true);
  else f.setAfter(ctx=>{if(mode==='role')ctx.currentUserRole='admin';if(mode==='db')ctx.db.app.options.projectId='yu-shing-company';if(mode==='flag')ctx.YUSHIN_PREVIEW_CANCELLED_PURCHASE=false;});
  await assert.rejects(c.commitCancelledPurchaseKeepStock(f.input));assert.equal(f.storage.size,1);assert.equal(f.calls.length,1);
 }
});
test('cross-project saved operation and corrupt cache cannot be replaced',async()=>{
 const f=fixture(),c=f.open();f.storage.set('keep-purchase:U:S',JSON.stringify({uid:'U',role:'purchaser',project:'demo-yushin',intent:{...f.input,operationId:'keep_stock_123456789'}}));
 await assert.rejects(c.commitCancelledPurchaseBackend('S'),/其他專案/);assert.equal(f.calls.length,0);
 f.storage.set('keep-purchase:U:S','broken');await assert.rejects(c.commitCancelledPurchaseBackend('S'),/暫存/);assert.equal(f.storage.size,1);
});
test('production keep-stock uses its independent backend and preserves original retry intent',async()=>{
 const f=fixture('production');f.setLose(true);
 await assert.rejects(f.open().commitCancelledPurchaseKeepStock(f.input),/reply lost/);
 assert.equal(f.storage.size,1);
 const c=f.open();await c.commitCancelledPurchaseBackend('S');
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.storage.size,0);
});
test('production backend off, retired legacy lock, foreign origin or project fail closed',async()=>{
 for(const mode of ['flag','legacy-lock','site','project']){
  const f=fixture('production'),c=f.open();
  if(mode==='flag')c.YUSHIN_PRODUCTION_CANCELLED_PURCHASE_BACKEND=false;
  else if(mode==='legacy-lock')c.YUSHIN_PRODUCTION_CANCELLED_PURCHASE_LEGACY_BLOCKED=false;
  else if(mode==='site')c.location.origin='https://yu-shing-company.web.app';
  else c.db.app.options.projectId='preview-20135';
  await assert.rejects(c.commitCancelledPurchaseKeepStock(f.input));
  assert.equal(f.calls.length,0);assert.equal(f.storage.size,0);
 }
});
