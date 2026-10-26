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
});
