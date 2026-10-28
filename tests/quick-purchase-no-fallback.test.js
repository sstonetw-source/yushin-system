'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../src/services/quick-purchase.js'),'utf8');

function contextFor({environment='production',pilot=true}={}){
 let legacyCalls=0;
 const context={
  APP_ENVIRONMENT:environment,
  currentUser:{uid:'buyer'},currentUserRole:'purchaser',
  currentUserName:'Buyer',localDateString:()=> '2026-10-28',
  supplyOrdersCollection:()=>({doc:()=>({})}),quickPurchaseSupplyId:()=> 'manual-O-I',
  canCreatePurchaseOrderCapability:()=>true,
  canAccessPage:()=>true,
  runRoleTransaction:async()=>{legacyCalls++;throw Error('LEGACY_TRANSACTION_USED');},
  globalThis:null
 };
 context.globalThis=context;
 context.YUSHIN_QUICK_PURCHASE_EMULATOR=pilot;
 vm.createContext(context);
 vm.runInContext(source,context,{filename:'quick-purchase.js'});
 return {context,legacyCalls:()=>legacyCalls};
}
const details={supplier:'Vendor',unitCost:19.99,expectedQty:4};
test('pilot requested outside isolated emulator fails closed; never falls back to legacy transaction',async()=>{
 const x=contextFor({environment:'production'});
 await assert.rejects(x.context.commitQuickPurchase('O','I',details,'buyer','purchaser'),
  /禁止改用舊交易/);
 assert.equal(x.legacyCalls(),0);
});
test('explicit production backend flag prevents any legacy retry when Callable cannot be reached',async()=>{
 const x=contextFor({environment:'production',pilot:false});
 x.context.YUSHIN_PRODUCTION_QUICK_PURCHASE=true;
 x.context.location={hostname:'sstonetw-source.github.io',pathname:'/yushin-system/'};
 await assert.rejects(x.context.commitQuickPurchase('O','I',details,'buyer','purchaser'),
  /後端尚未在此授權專案及網站啟用/);
 assert.equal(x.legacyCalls(),0);
});
test('pilot requested in emulator without valid Auth/Functions connection fails closed',async()=>{
 const x=contextFor({environment:'emulator'});
 x.context.location={hostname:'localhost'};
 await assert.rejects(x.context.commitQuickPurchase('O','I',details,'buyer','purchaser'),
  /手動採購後端.*未提交採購/);
 assert.equal(x.legacyCalls(),0);
});

test('reload retains operation id after lost response, and only authoritative readback clears it',async()=>{
 const storage=new Map(),operations=[],reads=[],opId='qp-12345678';
 const sessionStorage={
  getItem:k=>storage.get(k)||null,
  setItem:(k,v)=>storage.set(k,v),
  removeItem:k=>storage.delete(k)
 };
 const demandId='demand-1',supplyId='supply-1';
 let mode='lost';
 const collection=name=>({doc:id=>({
  id:id||'12345678',
  get:async()=>{
   reads.push(name);
   if(mode==='unconfirmed')throw Error('read unavailable');
   const record=name==='orders'?{items:[{itemId:'I',orderEvents:[{id:'quick-'+opId}]}]}:
    name==='supplyOrders'?{demandId,fulfillmentType:'DIRECT_SHIP',orderEvents:[{
     operationId:opId,createdByUid:'buyer',qty:4,supplier:'Vendor',unitCost:19.99
    }]}:{demandId};
   return {exists:true,data:()=>record};
  }
 })});
 const firebase={
  app:()=>({options:{projectId:'demo-yushin'},functions:()=>({
   app:{options:{projectId:'demo-yushin'}},
   useEmulator:()=>{},
   httpsCallable:()=>async data=>{
    operations.push(data);
    if(mode==='lost')throw Error('network disconnected after commit');
    return {data:{status:'already-applied',operationId:opId,supplyId,demandId,committedQty:4}};
   }
  })}),
  auth:()=>({app:{options:{projectId:'demo-yushin'}},emulatorConfig:{host:'127.0.0.1',port:9099},
   currentUser:{uid:'buyer'}})
 };
 const createPage=()=>{
  let legacy=0;
  const c={
   APP_ENVIRONMENT:'emulator',YUSHIN_QUICK_PURCHASE_EMULATOR:true,
   location:{hostname:'localhost'},firebase,sessionStorage,
   db:{collection},currentUser:{uid:'buyer'},currentUserRole:'purchaser',
   canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
   ensureFormalPurchaseFunctionsCompat:async()=>{},
   quickPurchaseSupplyId:()=>supplyId,
   YushinProcurementDemand:{demandIdForSource:()=>demandId},
   runRoleTransaction:async()=>{legacy++;throw Error('legacy fallback')}
  };
  c.globalThis=c;vm.createContext(c);vm.runInContext(source,c);
  return {c,legacy:()=>legacy};
 };
 const key='quick-purchase-pending:buyer:O:I';
 let page=createPage();
 await assert.rejects(page.c.commitQuickPurchase('O','I',details,'buyer','purchaser'),/network disconnected/);
 assert.equal(JSON.parse(storage.get(key)).operationId,opId);
 assert.equal(page.legacy(),0);
 mode='unconfirmed';page=createPage();
 await assert.rejects(page.c.commitQuickPurchase('O','I',details,'buyer','purchaser'),/read unavailable/);
 assert.equal(JSON.parse(storage.get(key)).operationId,opId);
 assert.equal(page.legacy(),0);
 await assert.rejects(page.c.commitQuickPurchase('O','I',{...details,expectedQty:3},'buyer','purchaser'),
  /前次手動採購尚待核對/);
 assert.equal(operations.length,2);
 mode='confirmed';page=createPage();
 const result=await page.c.commitQuickPurchase('O','I',details,'buyer','purchaser');
 assert.equal(result.savedSupply.demandId,demandId);
 assert.equal(storage.has(key),false);
 assert.deepEqual(operations.map(x=>x.operationId),[opId,opId,opId]);
 assert.equal(page.legacy(),0);
 assert.ok(reads.includes('orders')&&reads.includes('supplyOrders')&&reads.includes('procurementDemands'));
});

for(const environment of ['emulator','preview','production'])test(environment+' disabled backend cannot send a pending operation through legacy transaction',async()=>{
 const key='quick-purchase-pending:buyer:O:I';
 for(const raw of [JSON.stringify({version:1,operationId:'qp-12345678',
  fingerprint:JSON.stringify(['buyer','O','I',4,'Vendor',19.99])}),'{corrupt','']){
  const x=contextFor({environment,pilot:false}),storage=new Map([[key,raw]]);
  x.context.sessionStorage={getItem:k=>storage.has(k)?storage.get(k):null};
  for(const data of [details,{...details,expectedQty:3}]){
   await assert.rejects(x.context.commitQuickPurchase('O','I',data,'buyer','purchaser'),/禁止改用舊交易/);
   assert.equal(x.legacyCalls(),0);assert.equal(storage.get(key),raw);
  }
 }
});
test('pending checkpoint is scoped to the original actor/order/item; unrelated legacy purchases remain available',async()=>{
 const x=contextFor({environment:'production',pilot:false});
 const storage=new Map([['quick-purchase-pending:other:O:I','pending'],
  ['quick-purchase-pending:buyer:OTHER:I','pending'],['quick-purchase-pending:buyer:O:OTHER','pending']]);
 x.context.sessionStorage={getItem:k=>storage.get(k)??null};
 await assert.rejects(x.context.commitQuickPurchase('O','I',details,'buyer','purchaser'),/LEGACY_TRANSACTION_USED/);
 assert.equal(x.legacyCalls(),1);assert.equal(storage.size,3);
});
test('unreadable pending storage blocks unsafe legacy retry',async()=>{
 const x=contextFor({environment:'production',pilot:false});
 x.context.sessionStorage={getItem(){throw Error('storage denied');}};
 await assert.rejects(x.context.commitQuickPurchase('O','I',details,'buyer','purchaser'),/憑證無法讀取/);
 assert.equal(x.legacyCalls(),0);
});
test('recovery panel keeps pending operation visible during rollout suspension and restores only the authorized retry',()=>{
 const x=contextFor({environment:'production',pilot:false}),key='quick-purchase-pending:buyer:O:I';
 const raw=JSON.stringify({version:1,operationId:'qp-12345678',
  fingerprint:JSON.stringify(['buyer','O','I',4,'Vendor',19.99])});
 const storage=new Map([[key,raw]]),nodes=new Map();
 const element=()=>({children:[],appendChild(child){this.children.push(child);},
  replaceChildren(){this.children=[];},setAttribute(){}});
 const root=element();root.insertBefore=child=>{nodes.set(child.id,child);};
 nodes.set('purchasing-system',root);
 x.context.document={getElementById:id=>nodes.get(id)||null,createElement:element};
 x.context.sessionStorage={get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null};
 const workspace=fs.readFileSync(require('node:path').join(__dirname,'../src/features/purchasing/purchasing-workspace.js'),'utf8');
 vm.runInContext(workspace.slice(workspace.indexOf('function pendingQuickPurchaseAttempts()'),
  workspace.indexOf('function quickPurchaseSupplyId(')),x.context);
 x.context.renderQuickPurchaseRecovery();
 const panel=nodes.get('quickPurchaseRecoveryPanel');
 assert.equal(panel.hidden,false);assert.equal(panel.children[0].children.length,1);
 assert.match(panel.children[0].children[0].textContent,/採購核對暫停/);
 assert.equal(storage.get(key),raw);
 x.context.YUSHIN_PRODUCTION_QUICK_PURCHASE=true;x.context.renderQuickPurchaseRecovery();
 assert.equal(panel.hidden,false);assert.equal(panel.children[0].children.length,2);
 assert.equal(panel.children[0].children[1].textContent,'確認前次採購結果');
 x.context.currentUser={uid:'other'};x.context.renderQuickPurchaseRecovery();
 assert.equal(panel.hidden,true);assert.equal(storage.get(key),raw);
});
