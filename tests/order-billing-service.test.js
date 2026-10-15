'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const billingCode=fs.readFileSync(path.join(__dirname,'../src/services/order-billing.js'),'utf8');

function fixture(overrides={}){
  let remote={status:'active',isBilled:false,billingDate:'',statusHistory:[],fieldEditHistory:[],...overrides};
  let writes=0;
  const sandbox={
    BUSINESS_STATUS:{ACTIVE:'active'},
    normalizedOrderStatus:order=>order.status==='cancelled'?'cancelled':'normal',
    orderWorkIndexFields:()=>({}),
    firebase:{firestore:{FieldValue:{arrayUnion:x=>({arrayUnion:x})}}},
    db:{collection:name=>({doc:id=>({name,id})})},
    runRoleTransaction:async fn=>{
      const staged=[];
      const result=await fn({
        get:async ref=>({exists:true,data:()=>({...remote})}),
        update:(ref,patch)=>staged.push(patch)
      });
      for(const patch of staged){
        for(const [key,value] of Object.entries(patch)){
          if(value&&typeof value==='object'&&Object.hasOwn(value,'arrayUnion'))
            remote[key]=[...(remote[key]||[]),value.arrayUnion];
          else remote[key]=value;
        }
        writes++;
      }
      return result;
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(billingCode,sandbox,{filename:'order-billing.js'});
  return {sandbox,state:()=>remote,count:()=>writes};
}
test('billing transaction writes once and repeated confirmation is idempotent',async()=>{
  const f=fixture();
  const history={field:'isBilled',value:true,at:'2026-10-15T12:00:00.000Z'};
  const result=await f.sandbox.setOrderBillingStatus('O1',true,'2026-10-15',history,history.at);
  assert.equal(result.isBilled,true);
  assert.equal(f.state().billingDate,'2026-10-15');
  assert.equal(f.state().statusHistory.length,1);
  assert.equal(f.count(),1);
  const same=await f.sandbox.setOrderBillingStatus('O1',true,'2026-10-15',history,history.at);
  assert.equal(same.isBilled,true);
  assert.equal(f.count(),1);
});
test('billing date changes after authoritative read and records history once',async()=>{
  const f=fixture({isBilled:true,billingDate:'2026-10-14'});
  const h={field:'billingDate',before:'2026-10-14',after:'2026-10-15',at:'2026-10-15T13:00:00.000Z'};
  const res=await f.sandbox.changeOrderBillingDate('O1','2026-10-15',h);
  assert.equal(f.state().billingDate,'2026-10-15');
  assert.equal(res.fieldEditHistory.length,1);
  await f.sandbox.changeOrderBillingDate('O1','2026-10-15',h);
  assert.equal(f.count(),1);
  assert.equal(f.state().fieldEditHistory.length,1);
});
test('cancelled or not-yet-billed order rejects date edits without writes',async()=>{
  for(const state of [{status:'cancelled',isBilled:true},{isBilled:false}]){
    const f=fixture(state);
    await assert.rejects(f.sandbox.changeOrderBillingDate('O1','2026-10-15',{at:'2026-10-15'}),/已取消或尚未核銷/);
    assert.equal(f.count(),0);
  }
});
test('invalid dates never write or trigger transactions',async()=>{
  const f=fixture({isBilled:true});let called=0;
  f.sandbox.runRoleTransaction=async()=>{called++;};
  for(const value of ['2026-02-30','2026-13-01','2026-00-12','','2026/10/15']){
    await assert.rejects(f.sandbox.changeOrderBillingDate('O1',value,{at:'a'}),/正確的核銷日期/);
  }
  assert.equal(called,0);
});
