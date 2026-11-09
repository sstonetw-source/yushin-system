'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const file=fs.readFileSync('src/infrastructure/firebase.js','utf8'),source=file.slice(0,file.indexOf('// 啟動時由 SDK'));
function setup(host,flag,existingProject){
 const calls=[];let app=existingProject?{options:{projectId:existingProject}}:null;
 const functions={useEmulator:(...args)=>calls.push(['functions',...args])},database={settings:()=>calls.push(['settings']),useEmulator:(...args)=>calls.push(['firestore',...args])};
 const c=vm.createContext({console,window:{location:{hostname:host},YUSHIN_LOCAL_EMULATOR:flag,addEventListener:()=>{}},
  document:{documentElement:{dataset:{}}},firebase:{apps:app?[app]:[],app:()=>({...app,functions:()=>functions}),
   initializeApp:options=>{calls.push(['initialize',options.projectId]);app={options};},firestore:()=>database,
   functions:()=>functions,auth:()=>({useEmulator:(...args)=>calls.push(['auth',...args])})}});
 return {c,calls,run:()=>vm.runInContext(source+'\nAPP_ENVIRONMENT',c)};
}
test('local emulator boot requires exact opt-in and localhost, with fixed demo project and ports before use',()=>{
 for(const host of ['localhost','127.0.0.1']){
  const f=setup(host,true);assert.equal(f.run(),'emulator');
  assert.deepEqual(f.calls.map(row=>row[0]),['initialize','settings','auth','firestore','functions']);
  assert.equal(f.calls[0][1],'demo-yushin');assert.equal(f.calls[2][1],'http://127.0.0.1:9099');
  assert.deepEqual(f.calls[3],['firestore','127.0.0.1',8080]);assert.deepEqual(f.calls[4],['functions','127.0.0.1',5001]);
 }
});
test('production routing ignores local opt-in on remote hosts, and normal localhost is unchanged',()=>{
 for(const [host,flag,expected] of [['localhost',false,'production'],['127.0.0.1','true','production'],
  ['sstonetw-source.github.io',true,'production'],['localhost.example',true,'production']]){
  const f=setup(host,flag);assert.equal(f.run(),expected);assert.equal(f.calls.some(row=>['auth','firestore','functions'].includes(row[0])),false);
 }
});
test('retired Firebase Hosting origins fail before initializing Auth, Firestore, or Functions',()=>{
 for(const host of ['preview-20135.web.app','preview-20135.firebaseapp.com',
  'yu-shing-company.web.app','yu-shing-company.firebaseapp.com']){
  const f=setup(host,true);assert.throws(f.run,/Firebase Hosting 舊站台已停用/);assert.deepEqual(f.calls,[]);
 }
});
test('local emulator boot refuses an existing non-emulator app before any database SDK use',()=>{
 for(const project of ['yu-shing-company','unrelated-project']){
  const f=setup('localhost',true,project);assert.throws(f.run,/不可沿用/);assert.deepEqual(f.calls,[]);
 }
});
