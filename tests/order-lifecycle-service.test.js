'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../src/services/order-lifecycle.js'),'utf8');
function fixture({status='normal',remaining=3,throwOnAdjust=false}={}){
  let remote={status:status==='normal'?'active':'cancelled',orderStatus:status,
    items:[{itemId:'I1',qty:3}],orderLifecycleHistory:[]};
  let committed=0,reservationCalls=0;
  const c=vm.createContext({
    normalizedOrderStatus:o=>o.orderStatus||'normal',
    deliveryProgressInfo:()=>({remaining}),
    localDateString:()=> '2026-10-15',deliveryActor:()=> 'Tester',
    BUSINESS_STATUS:{ACTIVE:'active',CANCELLED:'cancelled'},
    firebase:{firestore:{FieldValue:{arrayUnion:x=>({union:x})}}},
    db:{collection:()=>({doc:()=>({})})},
    normalizedOrderItems:o=>o.items,orderWorkIndexFields:()=>({}),
    adjustInventoryReservationForLifecycle:async()=>{
      reservationCalls++;
      if(throwOnAdjust)throw new Error('inventory inconsistent');
      return {items:remote.items};
    },
    runRoleTransaction:async fn=>{
      let patch;const result=await fn({
        get:async()=>({exists:true,data:()=>structuredClone(remote)}),
        update:(_ref,update)=>{patch=update;}
      });
      if(patch){
        remote={...remote,...patch,orderLifecycleHistory:[...remote.orderLifecycleHistory,patch.orderLifecycleHistory.union]};
        committed++;
      }
      return result;
    }
  });
  vm.runInContext(code,c);
  return {c,state:()=>remote,writes:()=>committed,reservations:()=>reservationCalls};
}
test('cancel and repeat cancel only write once, with matching single stock reservation update',async()=>{
  const f=fixture();
  const first=await f.c.setOrderLifecycleStatus('O1','cancelled');
  assert.equal(first.orderStatus,'cancelled');
  assert.equal(f.state().orderStatus,'cancelled');
  assert.equal(f.writes(),1);
  assert.equal(f.reservations(),1);
  const second=await f.c.setOrderLifecycleStatus('O1','cancelled');
  assert.equal(second.orderStatus,'cancelled');
  assert.equal(f.writes(),1);
  assert.equal(f.reservations(),1);
});
test('restoration changes order status only after reservation transition',async()=>{
  const f=fixture({status:'cancelled'});
  await f.c.setOrderLifecycleStatus('O1','normal');
  assert.equal(f.state().status,'active');
  assert.equal(f.state().orderLifecycleHistory.length,1);
  assert.equal(f.reservations(),1);
});
test('fully fulfilled cancellation or inconsistent reservations do not write an order',async()=>{
  const fulfilled=fixture({remaining:0});
  await assert.rejects(fulfilled.c.setOrderLifecycleStatus('O1','cancelled'),/無剩餘未送貨/);
  assert.equal(fulfilled.writes(),0);
  const broken=fixture({throwOnAdjust:true});
  await assert.rejects(broken.c.setOrderLifecycleStatus('O1','cancelled'),/inventory inconsistent/);
  assert.equal(broken.writes(),0);
});
