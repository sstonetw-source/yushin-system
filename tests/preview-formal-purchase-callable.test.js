'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {allowPreviewFormalPurchase,allowProductionFormalPurchase,createPreviewFormalPurchaseCallable}=require('../functions/formal-purchase-preview-callable');

const preview={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_FORMAL_PURCHASE:'true'};
const production={GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_FORMAL_PURCHASE:'true'};
const demo={GCLOUD_PROJECT:'demo-yushin',ENABLE_PREVIEW_FORMAL_PURCHASE:'true',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
const create=(env,db)=>createPreviewFormalPurchaseCallable({onCall:(_options,handler)=>handler,HttpsError,
 getDatabase:()=>db,env});

test('Preview flag cannot enable production; demo requires actual local Emulators',()=>{
 assert.equal(allowPreviewFormalPurchase({...preview,ENABLE_PREVIEW_FORMAL_PURCHASE:'false'}),false);
 assert.equal(allowPreviewFormalPurchase(preview),true);
 for(const project of ['yu-shing-company','another-project',''])
  assert.equal(allowPreviewFormalPurchase({...preview,GCLOUD_PROJECT:project}),false);
 assert.equal(allowPreviewFormalPurchase({...preview,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}),false);
 assert.equal(allowPreviewFormalPurchase({...preview,FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}),false);
 assert.equal(allowPreviewFormalPurchase(demo),true);
 for(const change of [{FUNCTIONS_EMULATOR:'false'},{FIRESTORE_EMULATOR_HOST:'remote.example:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'remote.example:9099'},{FIREBASE_AUTH_EMULATOR_HOST:''}])
  assert.equal(allowPreviewFormalPurchase({...demo,...change}),false);
});

test('production requires its own opt-in project and live SDK without any Emulator',()=>{
 assert.equal(allowProductionFormalPurchase(production),true);
 assert.equal(allowProductionFormalPurchase({...production,ENABLE_PRODUCTION_FORMAL_PURCHASE:'false'}),false);
 assert.equal(allowProductionFormalPurchase({...preview,GCLOUD_PROJECT:'yu-shing-company'}),false);
 for(const project of ['demo-yushin','preview-20135','other',''])
  assert.equal(allowProductionFormalPurchase({...production,GCLOUD_PROJECT:project}),false);
 for(const changes of [{FUNCTIONS_EMULATOR:'true'}, {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(allowProductionFormalPurchase({...production,...changes}),false);
});

test('production callable remains fail-closed unless explicitly enabled',async()=>{
 let calls=0;
 const db={projectId:'yu-shing-company',runTransaction:()=>{calls++;}};
 const disabled=create({...production,ENABLE_PRODUCTION_FORMAL_PURCHASE:'false'},db);
 await assert.rejects(disabled({auth:{uid:'buyer'},data:{}}),e=>e.code==='failed-precondition');
 const mismatched=create(production,{...db,projectId:'preview-20135'});
 await assert.rejects(mismatched({auth:{uid:'buyer'},data:{}}),e=>e.code==='failed-precondition');
 const active=create(production,db);
 await assert.rejects(active({data:{uid:'forged'}}),e=>e.code==='unauthenticated');
 await assert.rejects(active({auth:{uid:'buyer'},data:{uid:'forged'}}),e=>e.code==='invalid-argument');
 assert.equal(calls,0);
});

test('disabled endpoint, unsigned caller and mismatched Firestore never execute a transaction',async()=>{
 let databaseReads=0,transactions=0;
 const db={projectId:'preview-20135',runTransaction:async()=>{transactions++;}};
 const database=()=>{databaseReads++;return db;};
 const wrap=env=>createPreviewFormalPurchaseCallable({onCall:(_settings,handler)=>handler,
  HttpsError,getDatabase:database,env});
 await assert.rejects(wrap({...preview,GCLOUD_PROJECT:'yu-shing-company'})({auth:{uid:'buyer'},data:{}}),
  error=>error.code==='failed-precondition');
 await assert.rejects(wrap(preview)({data:{uid:'forged'}}),error=>error.code==='unauthenticated');
 assert.equal(databaseReads,0);
 await assert.rejects(create(preview,{projectId:'yu-shing-company',runTransaction:()=>{transactions++;}})
  ({auth:{uid:'buyer'},data:{}}),error=>error.code==='failed-precondition');
 assert.equal(transactions,0);
});

test('enabled endpoint forwards only Auth UID to existing strict atomic purchase Service',async()=>{
 const fail=Object.assign(new Error('backend transaction reached'),{code:'failed-precondition'});
 const db={projectId:'preview-20135',runTransaction:async()=>{throw fail;}};
 const handler=create(preview,db);
 await assert.rejects(handler({auth:{uid:'buyer'},data:{uid:'forged'}}),
  error=>error.code==='invalid-argument');
 const input={poNo:'PO1',poDate:'2026-10-23',supplier:'供應商',items:[
  {orderId:'O1',itemId:'I1',qty:4,unitCost:20}]};
 await assert.rejects(handler({auth:{uid:'buyer'},data:input}),
  error=>error.code==='failed-precondition'&&error.message==='backend transaction reached');
});

test('Functions entry routes formal PO through the environment-guarded endpoint',()=>{
 const entry=fs.readFileSync('functions/index.js','utf8');
 assert.match(entry,/createPreviewFormalPurchaseCallable/);
 assert.match(entry,/exports\.commitV2FormalPurchase=createPreviewFormalPurchaseCallable/);
 assert.doesNotMatch(entry,/createV2ReturnCallables/);
});
