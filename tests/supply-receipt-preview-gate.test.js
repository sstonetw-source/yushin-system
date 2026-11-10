'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {allowReceiptEmulator,allowPreviewReceiving,allowProductionReceiving,receiptBackendProject}=require('../functions/supply-receipt-gate');
const {createSupplyReceiptCallable}=require('../functions/supply-receipt-callable');

const demo={GCLOUD_PROJECT:'demo-yushin',ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
const preview={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_RECEIVING:'true'};
const production={GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_RECEIVING_BACKEND:'true'};
test('receiving backend is denied by default and cannot be activated on production or mixed emulator projects',()=>{
 assert.equal(allowReceiptEmulator(demo),true);
 assert.equal(allowPreviewReceiving(preview),true);
 assert.equal(receiptBackendProject(demo),'demo-yushin');
 assert.equal(receiptBackendProject(preview),'preview-20135');
 assert.equal(receiptBackendProject({GCLOUD_PROJECT:'yu-shing-company',ENABLE_PREVIEW_RECEIVING:'true'}),'');
 assert.equal(receiptBackendProject({GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_RECEIVING:'true'}),'');
 for(const bad of [{ENABLE_PREVIEW_RECEIVING:'false'},{GCLOUD_PROJECT:'demo-yushin'},
  {FUNCTIONS_EMULATOR:'true'},{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(allowPreviewReceiving({...preview,...bad}),false);
 for(const bad of [{ENABLE_V2_RETURN_AUTH_EMULATOR:'false'},{GCLOUD_PROJECT:'preview-20135'},
  {FUNCTIONS_EMULATOR:'false'},{FIRESTORE_EMULATOR_HOST:'remote:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:''}])
  assert.equal(allowReceiptEmulator({...demo,...bad}),false);
});
test('production receiving requires its own exact project and explicit backend gate, without any emulator',()=>{
 assert.equal(allowProductionReceiving(production),true);
 assert.equal(receiptBackendProject(production),'yu-shing-company');
 assert.equal(receiptBackendProject({GCLOUD_PROJECT:'yu-shing-company'}),'');
 assert.equal(receiptBackendProject({...production,ENABLE_PRODUCTION_RECEIVING_BACKEND:'false'}),'');
 for(const bad of [
  {GCLOUD_PROJECT:'demo-yushin'},{GCLOUD_PROJECT:'preview-20135'},
  {FUNCTIONS_EMULATOR:'true'},
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}
 ])assert.equal(allowProductionReceiving({...production,...bad}),false);
});
test('production Callable is closed by default and checks authentication and database before any read or write',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 let reads=0,writes=0;
 const database=projectId=>({projectId,collection:name=>({doc:id=>({
  get:async()=>{reads++;return {exists:false};},
  set:()=>{writes++;}
 })})});
 const build=(env,db)=>createSupplyReceiptCallable({env,onCall:(_options,callback)=>callback,
  HttpsError,getDatabase:()=>db});
 const input={supplyId:'S',operationId:'op-12345678',qty:2,lotNo:'',expiryDate:''};
 await assert.rejects(build({GCLOUD_PROJECT:'yu-shing-company'},database('yu-shing-company'))
  ({auth:{uid:'buyer'},data:input}),{code:'failed-precondition'});
 await assert.rejects(build(production,database('preview-20135'))
  ({auth:{uid:'buyer'},data:input}),{code:'failed-precondition'});
 await assert.rejects(build(production,database('yu-shing-company'))({data:input}),{code:'unauthenticated'});
 await assert.rejects(build(production,database('yu-shing-company'))
  ({auth:{uid:'buyer'},data:input}),{code:'permission-denied'});
 assert.equal(reads,1);assert.equal(writes,0);
});
test('receiving Callable rejects missing auth, wrong database and unauthorized profile with zero writes',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const logs=[];
 const database=projectId=>({projectId,collection:name=>({doc:id=>({
  get:async()=>{logs.push(name+'/'+id);return {exists:false};}
 })})});
 const build=(env,db)=>createSupplyReceiptCallable({env,onCall:(_options,callback)=>callback,
  HttpsError,getDatabase:()=>db});
 const input={supplyId:'S',operationId:'op-12345678',qty:2,lotNo:'',expiryDate:''};
 await assert.rejects(build({...preview,ENABLE_PREVIEW_RECEIVING:'false'},database('preview-20135'))
  ({auth:{uid:'buyer'},data:input}),{code:'failed-precondition'});
 await assert.rejects(build(preview,database('demo-yushin'))
  ({auth:{uid:'buyer'},data:input}),{code:'failed-precondition'});
 await assert.rejects(build(preview,database('preview-20135'))({data:input}),{code:'unauthenticated'});
 await assert.rejects(build(preview,database('preview-20135'))
  ({auth:{uid:'buyer'},data:input}),{code:'permission-denied'});
 assert.deepEqual(logs,['users/buyer']);
});
test('shared Receiving authorizes only a gated backend project and still checks the live actor profile',async()=>{
 const source=fs.readFileSync('src/services/receiving.js','utf8');
 const start=source.indexOf('async function assertV2ReceiptActor(');
 const end=source.indexOf('\nasync function validateV2ReceiptSource(',start);
 assert.ok(start>=0&&end>start);
 assert.match(fs.readFileSync('functions/supply-receipt-service.js','utf8'),/authorizeV2ReceiptActor:\(\)=>receiptBackendProject\(env\)===db\.projectId/);
 const context={authorizeV2ReceiptActor:()=>true};
 const db={projectId:'preview-20135',collection:name=>({doc:id=>({path:name+'/'+id})})};
 const sandbox={context,db,process:{env:{}},Error};
 vm.createContext(sandbox);
 vm.runInContext(source.slice(start,end)+'; this.assertActor=assertV2ReceiptActor;',sandbox);
 const user={role:'purchaser',active:true};
 const tx={get:async()=>({exists:true,data:()=>user})};
 await sandbox.assertActor(tx,'buyer','purchaser');
 for(const invalid of [()=>context.authorizeV2ReceiptActor=()=>false,
  ()=>user.role='sales',()=>user.active=false]){
  context.authorizeV2ReceiptActor=()=>true;user.role='purchaser';user.active=true;
  invalid();await assert.rejects(sandbox.assertActor(tx,'buyer','purchaser'));
 }
 assert.equal(receiptBackendProject({...preview,GCLOUD_PROJECT:'yu-shing-company'}),'');
});
test('Preview receiving is fail-closed; no legacy Firestore transaction on absent gate or transport failure',async()=>{
 const context={APP_ENVIRONMENT:'preview',location:{hostname:'preview-20135.web.app'},
  YUSHIN_PREVIEW_RECEIVING:false,globalThis:null,runRoleTransaction:()=>{throw Error('LEGACY_WRITE');}};
 context.globalThis=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('src/services/receiving-transport.js','utf8'),context);
 vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),context);
 await assert.rejects(context.receiveSupplyOrderRecord('S',2,'','','op-12345678'),/禁止改用舊交易/);
 context.YUSHIN_PREVIEW_RECEIVING=true;
 await assert.rejects(context.receiveSupplyOrderRecord('S',2,'','','op-12345678'),/禁止改用舊交易/);
});
test('production receipt legacy lock stays fail-closed even when its backend flag is switched off',async()=>{
 let legacyWrites=0;
 const context={APP_ENVIRONMENT:'production',location:{origin:'https://sstonetw-source.github.io',hostname:'sstonetw-source.github.io',pathname:'/yushin-system/'},
  YUSHIN_PRODUCTION_RECEIVING_BACKEND:false,YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED:true,
  globalThis:null,runRoleTransaction:()=>{legacyWrites++;throw Error('LEGACY_WRITE');}};
 context.globalThis=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('src/services/receiving-transport.js','utf8'),context);
 vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),context);
 await assert.rejects(context.receiveSupplyOrderRecord('S',2,'','','op-12345678'),/禁止改用舊交易/);
 context.YUSHIN_PRODUCTION_RECEIVING_BACKEND=true;
 await assert.rejects(context.receiveSupplyOrderRecord('S',2,'','','op-12345678'),/禁止改用舊交易/);
 context.YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED=false;
 await assert.rejects(context.receiveSupplyOrderRecord('S',2,'','','op-12345678'),/禁止改用舊交易/);
 assert.equal(legacyWrites,0);
});
test('production receipt with both rollout flags absent still refuses browser writes',async()=>{
 let legacyWrites=0;
 const context={APP_ENVIRONMENT:'production',location:{origin:'https://sstonetw-source.github.io',hostname:'sstonetw-source.github.io',pathname:'/yushin-system/'},
  YUSHIN_PRODUCTION_RECEIVING_BACKEND:false,YUSHIN_PRODUCTION_RECEIVING_LEGACY_BLOCKED:false,
  globalThis:null,runRoleTransaction:()=>{legacyWrites++;throw Error('LEGACY_WRITE');}};
 context.globalThis=context;vm.createContext(context);
 vm.runInContext(fs.readFileSync('src/services/receiving-transport.js','utf8'),context);
 vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),context);
 await assert.rejects(context.receiveSupplyOrderRecord('S',2,'','','op-12345678'),/禁止改用舊交易/);
 assert.equal(legacyWrites,0);
});
