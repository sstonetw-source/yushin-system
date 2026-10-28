'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/quick-purchase.js','utf8');
test('Preview backend errors never fall back to legacy browser transaction',async()=>{
 let writes=0;
 const ctx={APP_ENVIRONMENT:'preview',currentUser:{uid:'buyer'},currentUserRole:'purchaser',
  YUSHIN_PREVIEW_QUICK_PURCHASE:false,canCreatePurchaseOrderCapability:()=>true,
  canAccessPage:()=>true,runRoleTransaction:()=>{writes++;throw Error('legacy write')},globalThis:null};
 ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
 const data={supplier:'Vendor',unitCost:10,expectedQty:2};
 await assert.rejects(ctx.commitQuickPurchase('O','I',data,'buyer','purchaser'),/禁止改用舊交易/);
 ctx.YUSHIN_PREVIEW_QUICK_PURCHASE=true;
 vm.runInContext("commitQuickPurchaseBackendPilot=async()=>{throw Error('backend unavailable')}",ctx);
 await assert.rejects(ctx.commitQuickPurchase('O','I',data,'buyer','purchaser'),/backend unavailable/);
 assert.equal(writes,0);
 assert.equal(ctx.quickPurchaseBackendPilotEnabled(),true);
 ctx.APP_ENVIRONMENT='production';
 assert.equal(ctx.quickPurchaseBackendPilotEnabled(),false);
 ctx.YUSHIN_PRODUCTION_QUICK_PURCHASE=true;
 assert.equal(ctx.quickPurchaseBackendPilotEnabled(),true);
 await assert.rejects(ctx.commitQuickPurchase('O','I',data,'buyer','purchaser'),/backend unavailable/);
 assert.equal(writes,0);
});

// Each transport must bind Auth, Firestore and Functions to the same project.
function boundContext(environment,{pending=false,changeDatabaseDuringLoad=false}={}){
 const project={emulator:'demo-yushin',preview:'preview-20135',production:'yu-shing-company'}[environment];
 const key='quick-purchase-pending:buyer:O:I',operationId='qp-12345678';
 const data={supplier:'Vendor',unitCost:10,expectedQty:2};
 const checkpoint=JSON.stringify({version:1,operationId,
  fingerprint:JSON.stringify(['buyer','O','I',2,'Vendor',10])});
 const storage=new Map(pending?[[key,checkpoint]]:[]),calls=[];
 let legacyCalls=0;
 const app={options:{projectId:project}},auth={app, currentUser:{uid:'buyer'},
  emulatorConfig:environment==='emulator'?{host:'127.0.0.1',port:9099}:null};
 const functions={app,useEmulator:()=>{},httpsCallable:()=>async payload=>{
  calls.push(payload);throw Error('RPC_REACHED');
 }};
 const ctx={APP_ENVIRONMENT:environment,currentUser:{uid:'buyer'},currentUserRole:'purchaser',
  location:{hostname:{emulator:'localhost',preview:'preview-20135.web.app',production:'yu-shing-company.web.app'}[environment]},
  firebase:{app:()=>({...app,functions:()=>functions}),auth:()=>auth},
  db:{app,collection:()=>({doc:()=>({id:'12345678'})})},
  sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
  ensureFormalPurchaseFunctionsCompat:async()=>{
   if(changeDatabaseDuringLoad)ctx.db={...ctx.db,app:{options:{projectId:'wrong-project'}}};
  },
  runRoleTransaction:()=>{legacyCalls++;throw Error('LEGACY_REACHED');}
 };
 ctx[{emulator:'YUSHIN_QUICK_PURCHASE_EMULATOR',preview:'YUSHIN_PREVIEW_QUICK_PURCHASE',production:'YUSHIN_PRODUCTION_QUICK_PURCHASE'}[environment]]=true;
 ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
 return {ctx,auth,functions,calls,storage,key,checkpoint,data,legacyCalls:()=>legacyCalls};
}
for(const environment of ['emulator','preview','production']){
 test(environment+' project binding rejects missing/mismatched transports before RPC and retains pending intent',async()=>{
  for(const pending of [false,true])for(const transport of ['default','auth','firestore','functions']){
   for(const project of [undefined,'wrong-project']){
    const x=boundContext(environment,{pending}),app={options:{projectId:project}};
    if(transport==='default')x.ctx.firebase.app=()=>app;
    if(transport==='auth')x.auth.app=app;
    if(transport==='firestore')x.ctx.db.app=project===undefined?undefined:app;
    if(transport==='functions')x.functions.app=app;
    await assert.rejects(x.ctx.commitQuickPurchase('O','I',x.data,'buyer','purchaser'),
     /後端.*(?:未提交採購|連線專案不正確)/);
    assert.equal(x.calls.length,0);assert.equal(x.legacyCalls(),0);
    if(pending)assert.equal(x.storage.get(x.key),x.checkpoint,'pending operation must survive failed binding');
    else if(transport!=='functions')assert.equal(x.storage.size,0,'invalid initial binding must not create an operation');
   }
  }
 });
 test(environment+' rechecks Firestore after asynchronous SDK loading and reuses original ID after recovery',async()=>{
  const x=boundContext(environment,{pending:true,changeDatabaseDuringLoad:true});
  await assert.rejects(x.ctx.commitQuickPurchase('O','I',x.data,'buyer','purchaser'),/連線專案不正確/);
  assert.equal(x.calls.length,0);assert.equal(x.legacyCalls(),0);
  assert.equal(x.storage.get(x.key),x.checkpoint);
  x.ctx.db.app=x.auth.app;x.ctx.ensureFormalPurchaseFunctionsCompat=async()=>{};
  await assert.rejects(x.ctx.commitQuickPurchase('O','I',x.data,'buyer','purchaser'),/RPC_REACHED/);
  assert.equal(x.calls.length,1);assert.equal(x.calls[0].operationId,'qp-12345678');
  assert.equal(x.storage.get(x.key),x.checkpoint);assert.equal(x.legacyCalls(),0);
 });
}
