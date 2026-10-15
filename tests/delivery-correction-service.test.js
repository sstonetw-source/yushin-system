'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../src/services/delivery-correction.js'),'utf8');
function fixture(order={},retryOrder=null){
  let remote={isDelivered:true,orderDate:'2026-10-01',deliveryRecords:[],returnRecords:[],...order};
  let writes=0;
  const c=vm.createContext({
    deliveryActor:()=> 'Tester',
    savedDeliveryRecords:o=>o.deliveryRecords||[],
    returnedQuantity:o=>(o.returnRecords||[]).reduce((sum,r)=>sum+r.qty,0),
    deliveryProgressInfo:o=>({isLegacyEstimated:o.isDelivered&&!(o.deliveryRecords||[]).length}),
    orderWorkIndexFields:o=>({workCategory:o.isDelivered?'complete':'open'}),
    firebase:{firestore:{FieldValue:{arrayUnion:entry=>({union:entry})}}},
    db:{collection:()=>({doc:()=>({})})},
    runRoleTransaction:async fn=>{
      let patch;
      const tx={get:async()=>({exists:true,data:()=>structuredClone(remote)}),update:(_,p)=>{patch=p;}};
      await fn(tx);
      if(retryOrder){remote={...remote,...retryOrder};patch=null;await fn(tx);}
      if(patch){remote={...remote,...patch,deliveryHistory:[...(remote.deliveryHistory||[]),patch.deliveryHistory.union]};writes++;}
    }
  });
  vm.runInContext(source,c);
  return {c,state:()=>remote,writes:()=>writes};
}
test('legacy correction clears only the estimate, refreshes indexes, and repeated calls do not write',async()=>{
  const f=fixture({orderLifecycleHistory:[{action:'existing'}]});
  const saved=await f.c.clearOrderLegacyDeliveryEstimate('O1');
  assert.equal(saved.isDelivered,false);
  assert.equal(saved.deliveredQty,0);
  assert.equal(saved.workCategory,'open');
  assert.equal(saved.deliveryHistory[0].before.estimatedDate,'2026-10-01');
  assert.equal(f.state().orderLifecycleHistory.length,1);
  await f.c.clearOrderLegacyDeliveryEstimate('O1');
  assert.equal(f.writes(),1);
  assert.equal(f.state().deliveryHistory.length,1);
});
test('stale legacy modal cannot remove actual delivery or returns',async()=>{
  for(const order of [{deliveryRecords:[{id:'D1',qty:2}]},{returnRecords:[{id:'R1',qty:1}]}]){
    const f=fixture(order);
    await assert.rejects(f.c.clearOrderLegacyDeliveryEstimate('O1'),/實際送貨|退貨紀錄/);
    assert.equal(f.writes(),0);
    assert.deepEqual(f.state().deliveryRecords,order.deliveryRecords||[]);
  }
});
test('transaction retry observes a concurrent real delivery and discards earlier clear',async()=>{
  const f=fixture({}, {deliveryRecords:[{id:'new',qty:3}]});
  await assert.rejects(f.c.clearOrderLegacyDeliveryEstimate('O1'),/實際送貨/);
  assert.equal(f.writes(),0);
  assert.equal(f.state().deliveryRecords[0].id,'new');
  assert.equal(f.state().isDelivered,true);
});

test('legacy correction UI locks repeated calls and releases lock after service failure',async()=>{
  const actions=fs.readFileSync(path.join(__dirname,'../src/features/orders/delivery-actions.js'),'utf8');
  const action=actions.slice(actions.indexOf('window.clearLegacyDelivery ='),actions.indexOf('function lifecycleRecordId'));
  let calls=0,fail,renders=0;
  const c=vm.createContext({window:{},canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
    confirm:()=>true,alert:()=>{},ordersCache:[{id:'O1'}],currentDeliveryOrderId:'O1',returnedQuantity:()=>0,
    pendingDeliveryOrderIds:new Set(),renderOrdersList:()=>renders++,
    renderDeliveryModal:()=>{},renderOrderLifecycleModal:()=>{},resetDeliveryForm:()=>{},
    clearOrderLegacyDeliveryEstimate:async()=>{calls++;return new Promise((_,reject)=>{fail=reject;});}
  });
  vm.runInContext(action,c);
  const first=c.window.clearLegacyDelivery();
  await c.window.clearLegacyDelivery();
  assert.equal(calls,1);
  assert.equal(c.pendingDeliveryOrderIds.has('O1'),true);
  fail(new Error('transaction failed'));
  await first;
  assert.equal(c.pendingDeliveryOrderIds.has('O1'),false);
  assert.equal(renders,1);
});
