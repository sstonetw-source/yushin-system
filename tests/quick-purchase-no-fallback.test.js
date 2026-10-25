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
test('pilot requested in emulator without valid Auth/Functions connection fails closed',async()=>{
 const x=contextFor({environment:'emulator'});
 x.context.location={hostname:'localhost'};
 await assert.rejects(x.context.commitQuickPurchase('O','I',details,'buyer','purchaser'),
  /僅限隔離的 demo Emulator/);
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
