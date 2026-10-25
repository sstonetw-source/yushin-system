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

test('form cancellation/restoration and quick actions share stock changes and preserve form details',async()=>{
  const f=fixture();
  const details={date:'2026-10-14',reason:'  客戶取消  '};
  await f.c.setOrderLifecycleStatus('O1','cancelled',details);
  assert.equal(f.state().orderStatusDate,'2026-10-14');
  assert.equal(f.state().orderStatusReason,'客戶取消');
  await f.c.setOrderLifecycleStatus('O1','cancelled',details);
  await f.c.setOrderLifecycleStatus('O1','cancelled');
  assert.equal(f.writes(),1);
  assert.equal(f.reservations(),1);
  await f.c.setOrderLifecycleStatus('O1','normal',{date:'2026-10-15',reason:'客戶恢復'});
  assert.equal(f.reservations(),2);
  assert.equal(f.state().orderLifecycleHistory[1].action,'restore');
  assert.equal(f.state().orderLifecycleHistory[1].before.reason,'客戶取消');
});
test('editing lifecycle metadata does not replay stock transitions and uses live before values',async()=>{
  const f=fixture({status:'cancelled',remaining:0,throwOnAdjust:true});
  await f.c.setOrderLifecycleStatus('O1','cancelled',{date:'2026-10-14',reason:'補說明'});
  await f.c.setOrderLifecycleStatus('O1','cancelled',{date:'2026-10-15',reason:'更正說明'});
  assert.equal(f.reservations(),0);
  assert.equal(f.writes(),2);
  assert.equal(f.state().orderLifecycleHistory[1].before.reason,'補說明');
  assert.equal(f.state().orderLifecycleHistory[1].action,'status_change');
});
test('invalid form state/date and failed reservation updates never commit form changes',async()=>{
  const f=fixture();
  for(const date of ['', '2026-02-30', '2026-13-01', '2026-1-1']){
    await assert.rejects(f.c.setOrderLifecycleStatus('O1','cancelled',{date}),/正確的狀態日期/);
  }
  await assert.rejects(f.c.setOrderLifecycleStatus('O1','other',{date:'2026-10-15'}),/不支援/);
  assert.equal(f.writes(),0);
  const broken=fixture({throwOnAdjust:true});
  await assert.rejects(broken.c.setOrderLifecycleStatus('O1','cancelled',{
    date:'2026-10-15',reason:'不應儲存'
  }),/inventory inconsistent/);
  assert.equal(broken.writes(),0);
  assert.equal(broken.state().orderLifecycleHistory.length,0);
});

test('multi-item cancellation and restoration preserve distinct item identities and do not replay stock transitions',async()=>{
  const f=fixture();
  f.state().items=[
    {itemId:'I1',productKey:'P',warehouseId:'A',qty:3,deliveredQty:1},
    {itemId:'I2',productKey:'P',warehouseId:'B',qty:2,deliveredQty:0},
    {itemId:'I3',productKey:'Q',warehouseId:'A',qty:4,deliveredQty:2}
  ];
  const before=structuredClone(f.state().items);
  await f.c.setOrderLifecycleStatus('O1','cancelled');
  assert.deepEqual(f.state().items,before);
  assert.equal(f.state().itemCount,3);
  assert.equal(f.reservations(),1);
  await f.c.setOrderLifecycleStatus('O1','cancelled');
  assert.equal(f.reservations(),1);
  await f.c.setOrderLifecycleStatus('O1','normal');
  assert.deepEqual(f.state().items,before);
  assert.equal(f.state().itemCount,3);
  assert.equal(f.reservations(),2);
  await f.c.setOrderLifecycleStatus('O1','normal');
  assert.equal(f.reservations(),2);
  assert.equal(f.writes(),2);
  assert.deepEqual(Array.from(f.state().orderLifecycleHistory,row=>row.action),['status_change','restore']);
});
test('multi-item reservation failure rolls back status and metadata without partial order writes',async()=>{
  const f=fixture({throwOnAdjust:true});
  f.state().items=[
    {itemId:'I1',productKey:'P',warehouseId:'A',qty:3},
    {itemId:'I2',productKey:'P',warehouseId:'B',qty:2},
    {itemId:'I3',productKey:'Q',warehouseId:'A',qty:4}
  ];
  const before=structuredClone(f.state());
  await assert.rejects(f.c.setOrderLifecycleStatus('O1','cancelled',{
    date:'2026-10-22',reason:'multi-item rollback'
  }),/inventory inconsistent/);
  assert.deepEqual(f.state(),before);
  assert.equal(f.writes(),0);
  assert.equal(f.reservations(),1);
});
