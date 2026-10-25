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
