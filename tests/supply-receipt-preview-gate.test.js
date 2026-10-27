'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {allowReceiptEmulator,allowPreviewReceiving,receiptBackendProject}=require('../functions/supply-receipt-gate');
const {createSupplyReceiptCallable}=require('../functions/supply-receipt-callable');

const demo={GCLOUD_PROJECT:'demo-yushin',ENABLE_V2_RETURN_AUTH_EMULATOR:'true',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
const preview={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_RECEIVING:'true'};
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
