'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('modules/customer-cancellations.js','utf8');
const code=source.slice(source.indexOf('window.loadCustomerReturnQueue='),source.indexOf('\nwindow.receiveCustomerReturn='));
function fixture(){
 const target={textContent:'',innerHTML:''},events=[];let finish,fail,notifyStarted;
 const started=new Promise(resolve=>{notifyStarted=resolve;});
 const pending=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
 const query={where:()=>query,limit:()=>query,get:()=>{notifyStarted();return pending;},orderBy:()=>query};
 const c=vm.createContext({window:{},document:{getElementById:()=>target},canReceiveInventoryCapability:()=>['warehouse','purchaser','admin'].includes(c.currentUserRole),
  currentUserRole:'warehouse',currentUser:{uid:'W'},sessionDataGeneration:1,db:{collection:()=>query},firebase:{firestore:{FieldPath:{documentId:()=> '__name__'}}},
  readQueryInBatches:async()=>[],customerReturnOrders:[],customerReturnVisibleLimit:50,customerReturnQueueGeneration:0,warehouseMasterCache:[],inventoryReturnQueueUpdated:e=>events.push(e)});
 vm.runInContext(code,c);return {c,target,events,finish,fail,started};
}
for(const change of ['different user','same user new session','business role'])test('return queue discards late rejected hold reads after '+change,async()=>{
 const f=fixture(),request=f.c.window.loadCustomerReturnQueue();await f.started;
 if(change==='different user')f.c.currentUser={uid:'P'};
 else if(change==='same user new session')f.c.sessionDataGeneration++;
 else f.c.currentUserRole='sales';
 f.target.textContent='new session';f.fail(Error('permission-denied'));await request;
 assert.equal(f.target.textContent,'new session');assert.deepEqual(f.events,[]);
});
test('return queue keeps current-session errors visible and rejects for the workspace retry state',async()=>{
 const f=fixture(),request=f.c.window.loadCustomerReturnQueue();await f.started;f.fail(Error('permission-denied'));
 await assert.rejects(request,/permission-denied/);assert.match(f.target.textContent,/載入失敗/);assert.deepEqual(f.events,['permission-denied']);
});
test('inventory navigation delegates queue reads to the existing workspace, without a duplicate unhandled request',()=>{
 const navigation=fs.readFileSync('src/app/navigation.js','utf8');
 assert.doesNotMatch(navigation,/\bloadCustomerReturnQueue\s*\(/);
 assert.match(navigation,/initializePageData\('inventory'\)/);
 assert.match(fs.readFileSync('modules/inventory-workspace.js','utf8'),/Promise\.allSettled\([\s\S]*?loadCustomerReturnQueue\(\)/);
});

 test('return queue ignores an older same-session load after newer receipt refresh has started',async()=>{
 const f=fixture();const first=f.c.window.loadCustomerReturnQueue();await f.started;
 const fresh={where(){return this;},limit(){return this;},orderBy(){return this;},get:async()=>({docs:[],size:0})};
 f.c.db.collection=()=>fresh;await f.c.window.loadCustomerReturnQueue();
 const rendered=f.target.innerHTML;f.fail(Error('old hold read rejected'));await first;
 assert.equal(f.target.innerHTML,rendered);assert.deepEqual(f.events,[undefined]);
 });
