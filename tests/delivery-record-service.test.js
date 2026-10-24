'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const fulfillment=require('../modules/fulfillment-core.js');
const inventory=require('../modules/inventory-core.js');
const source=fs.readFileSync(path.join(__dirname,'../src/services/delivery-records.js'),'utf8');
function fixture({patch={},failStock=false,retry=false,loseResponse=false}={}){
  let remote={orderStatus:'normal',items:[{itemId:'I',qty:10,reservedQty:10,dispatchPreparedQty:10,fulfillmentType:'WAREHOUSE'}],
    deliveryRecords:[],returnRecords:[],deliveryHistory:[],...patch};
  let writes=0,sequence=0,stockCommits=[],attemptIds=[],lost=false;
  const projection=o=>fulfillment.projectOrderDelivery({grossDeliveredQty:(o.deliveryRecords||[]).reduce((s,r)=>s+r.qty,0),
    returnedQty:(o.returnRecords||[]).reduce((s,r)=>s+r.qty,0),returnRecords:o.returnRecords||[]});
  const delta=async(tx,order,qty,_actor,_orderId,reversals)=>{
    if(failStock)throw new Error('stock failed');
    tx.deltas.push(qty);
    const allocations=qty>0?[{lotId:'L',qty,unitCost:10,cost:qty*10}]
      :inventory.reverseLotAllocations(reversals,Math.abs(qty)).allocations.map(r=>({...r,qty:-r.qty,cost:-r.cost}));
    return {newReservedQty:order.reservedQty-qty,lotAllocations:allocations,cogs:qty*10};
  };
  const c=vm.createContext({
    YushinFulfillment:fulfillment,YushinInventory:inventory,
    deliveryActor:()=> 'Sales',deliveryRecordId:()=> 'attempt-'+(++sequence),
    orderInventorySyncIncomplete:o=>o.inventoryReservationStatus==='pending',
    normalizedOrderStatus:o=>o.orderStatus,normalizedOrderItems:o=>structuredClone(o.items),
    orderQuantity:o=>o.items.reduce((s,r)=>s+r.qty,0),
    savedDeliveryRecords:o=>o.deliveryRecords||[],savedReturnRecords:o=>o.returnRecords||[],
    returnedQuantity:o=>(o.returnRecords||[]).reduce((s,r)=>s+r.qty,0),orderDeliveryProjection:projection,
    deliveryProgressInfo:o=>{const p=projection(o),total=o.items.reduce((s,r)=>s+r.qty,0);return {
      ...p,delivered:p.effectiveDelivered,state:p.effectiveDelivered>=total?'complete':'partial'};},
    firebase:{firestore:{FieldValue:{arrayUnion:entry=>({union:structuredClone(entry)})}}},
    db:{collection:()=>({doc:()=>({})})},orderWorkIndexFields:o=>({workCategory:o.isDelivered?'complete':'shipping'}),
    applyInventoryDeliveryDeltaInTransaction:delta,
    applyInventoryDeliveryInTransaction:(tx,_ref,...args)=>delta(tx,...args),
    runRoleTransaction:async callback=>{
      let patch,deltas=[];
      const tx={deltas,get:async()=>({exists:true,data:()=>structuredClone(remote)}),update:(_,p)=>{patch=p;attemptIds.push(p.deliveryRecords?.at(-1)?.id);}};
      await callback(tx);
      if(retry){patch=null;deltas.length=0;await callback(tx);}
      if(patch){remote={...remote,...patch,deliveryHistory:[...remote.deliveryHistory,patch.deliveryHistory.union]};writes++;stockCommits.push(...deltas);}
      if(loseResponse&&!lost){lost=true;throw new Error('response lost');}
    }
  });
  vm.runInContext(source,c);
  return {c,state:()=>remote,writes:()=>writes,stock:()=>stockCommits,ids:()=>attemptIds};
}
const request=(patch={})=>({date:'2026-10-16',qty:3,notes:'',editId:'',itemId:'I',recordId:'D',...patch});
test('partial delivery commits once and repeated intent does not deduct stock twice',async()=>{
  const f=fixture();
  await f.c.saveOrderDeliveryRecord('O',request());
  await f.c.saveOrderDeliveryRecord('O',request());
  assert.equal(f.writes(),1);assert.deepEqual(f.stock(),[3]);
  assert.equal(f.state().items[0].reservedQty,7);
  assert.equal(f.state().deliveryRecords.length,1);
  assert.equal(f.state().isDelivered,false);
  assert.equal(f.state().deliveryHistory[0].after.lotAllocations[0].qty,3);
  await assert.rejects(f.c.saveOrderDeliveryRecord('O',request({qty:4})),/已有不同內容/);
  assert.equal(f.writes(),1);
});
test('lost success response can be retried with the same identity without a second write',async()=>{
  const f=fixture({loseResponse:true});
  await assert.rejects(f.c.saveOrderDeliveryRecord('O',request()),/response lost/);
  await f.c.saveOrderDeliveryRecord('O',request());
  assert.equal(f.writes(),1);assert.deepEqual(f.stock(),[3]);
});
test('transaction retry preserves record identity and commits only the final attempt',async()=>{
  const f=fixture({retry:true});
  await f.c.completeOrderDelivery('O','2026-10-16');
  assert.equal(f.writes(),1);assert.deepEqual(f.stock(),[10]);
  assert.deepEqual(f.ids(),['attempt-1','attempt-1']);
  await f.c.completeOrderDelivery('O','2026-10-16');
  assert.equal(f.writes(),1);
});
test('increasing and shrinking a record retain original lots, cost, and current reservations',async()=>{
  const f=fixture();
  await f.c.saveOrderDeliveryRecord('O',request());
  await f.c.saveOrderDeliveryRecord('O',request({editId:'D',qty:5}));
  assert.deepEqual(Array.from(f.state().deliveryRecords[0].lotAllocations,r=>r.qty),[3,2]);
  assert.equal(f.state().deliveryRecords[0].cogs,50);
  await f.c.saveOrderDeliveryRecord('O',request({editId:'D',qty:4}));
  assert.equal(f.state().deliveryRecords[0].lotAllocations.reduce((s,r)=>s+r.qty,0),4);
  assert.equal(f.state().deliveryRecords[0].cogs,40);
  assert.equal(f.state().items[0].reservedQty,6);
  const before=f.writes();
  await f.c.saveOrderDeliveryRecord('O',request({editId:'D',qty:4}));
  assert.equal(f.writes(),before);
});
test('delivery corrections use a delete tombstone so retries cannot restore stock twice',async()=>{
  const f=fixture();
  await f.c.saveOrderDeliveryRecord('O',request());
  await f.c.correctOrderDeliveryRecord('O','D','誤登');
  await f.c.correctOrderDeliveryRecord('O','D','誤登');
  assert.deepEqual(f.stock(),[3,-3]);assert.equal(f.writes(),2);
  assert.equal(f.state().items[0].reservedQty,10);
  assert.equal(f.state().deliveryRecords.length,0);
  await assert.rejects(f.c.saveOrderDeliveryRecord('O',request()),/已更正撤銷/);
  assert.equal(f.writes(),2);
  await assert.rejects(f.c.correctOrderDeliveryRecord('O','missing','誤登'),/找不到/);
});
test('stock failure leaves records, reserved amounts, and histories unchanged',async()=>{
  const f=fixture({failStock:true});
  await assert.rejects(f.c.saveOrderDeliveryRecord('O',request()),/stock failed/);
  assert.equal(f.writes(),0);assert.equal(f.state().deliveryRecords.length,0);
  assert.equal(f.state().items[0].reservedQty,10);assert.equal(f.state().deliveryHistory.length,0);
});
test('repeated cancel-all restores one shipment only once and return history blocks reversal',async()=>{
  const f=fixture();await f.c.completeOrderDelivery('O','2026-10-16');
  await f.c.cancelOrderDeliveries('O');await f.c.cancelOrderDeliveries('O');
  assert.deepEqual(f.stock(),[10,-10]);assert.equal(f.writes(),2);
  const returned=fixture({patch:{returnRecords:[{itemId:'I',qty:1,settlement:'CLOSE'}]}});
  await assert.rejects(returned.c.cancelOrderDeliveries('O'),/退貨紀錄/);
  assert.equal(returned.writes(),0);
});
test('a prior create intent cannot recreate a delivery removed by cancel-all',async()=>{
 const f=fixture();await f.c.saveOrderDeliveryRecord('O',request({qty:10}));
 await f.c.cancelOrderDeliveries('O');
 await assert.rejects(f.c.saveOrderDeliveryRecord('O',request({qty:10})),/已更正撤銷/);
 assert.deepEqual(f.stock(),[10,-10]);assert.equal(f.writes(),2);
});
test('CLOSE returns never reopen quick shipping',async()=>{
  const f=fixture({patch:{deliveryRecords:[{id:'old',itemId:'I',qty:10}],returnRecords:[{itemId:'I',qty:2,settlement:'CLOSE'}]}});
  await f.c.completeOrderDelivery('O','2026-10-16');
  assert.equal(f.writes(),0);assert.deepEqual(f.stock(),[]);
});

test('correcting an extra record retains completed status when CLOSE returns do not require replacement',async()=>{
  const f=fixture({patch:{deliveryRecords:[
    {id:'keep',itemId:'I',qty:10,lotAllocations:[{lotId:'L',qty:10,unitCost:10,cost:100}]},
    {id:'extra',itemId:'I',qty:2,lotAllocations:[{lotId:'L',qty:2,unitCost:10,cost:20}]}],
    returnRecords:[{itemId:'I',qty:2,settlement:'CLOSE'}]}});
  await f.c.correctOrderDeliveryRecord('O','extra','誤登');
  assert.equal(f.state().isDelivered,true);assert.equal(f.state().deliveredQty,10);
  assert.deepEqual(f.stock(),[-2]);
});

test('per-item CLOSE returns cannot be hidden by delivery quantities of another item',async()=>{
  const f=fixture({patch:{items:[{itemId:'I',qty:10,dispatchPreparedQty:10,reservedQty:5},{itemId:'J',qty:10,dispatchPreparedQty:10}],
    deliveryRecords:[{id:'D',itemId:'I',qty:5},{id:'other',itemId:'J',qty:10}],returnRecords:[{itemId:'I',qty:3,settlement:'CLOSE'}]}});
  await assert.rejects(f.c.saveOrderDeliveryRecord('O',request({editId:'D',qty:2})),/低於已登錄的退貨/);
  assert.equal(f.writes(),0);
});

test('replacement-return projection allows editing the cumulative record without falsely capping gross quantity',async()=>{
  const f=fixture({patch:{deliveryRecords:[{id:'D',itemId:'I',qty:10,lotAllocations:[{lotId:'L',qty:10,unitCost:10,cost:100}],cogs:100}],
    items:[{itemId:'I',qty:10,reservedQty:2,dispatchPreparedQty:12,fulfillmentType:'WAREHOUSE'}],
    returnRecords:[{itemId:'I',qty:2,settlement:'REPLACE'}]}});
  await f.c.saveOrderDeliveryRecord('O',request({editId:'D',qty:12}));
  assert.equal(f.state().deliveredQty,12);assert.equal(f.state().isDelivered,true);
  assert.deepEqual(f.stock(),[2]);
});

test('quick and partial delivery both reject stale or exhausted print quantities in the live transaction',async()=>{
  const patch={items:[{itemId:'I',qty:10,reservedQty:10,dispatchPreparedQty:0}]};
  for(const action of ['quick','partial']){
    const f=fixture({patch});
    await assert.rejects(action==='quick'?f.c.completeOrderDelivery('O','2026-10-16'):f.c.saveOrderDeliveryRecord('O',request()),/已打單可出貨數量只有 0/);
    assert.equal(f.writes(),0);assert.deepEqual(f.stock(),[]);
  }
});
test('cancelled orders cannot gain new delivery records and invalid quantities never write',async()=>{
  const f=fixture({patch:{orderStatus:'cancelled'}});
  await assert.rejects(f.c.saveOrderDeliveryRecord('O',request()),/已取消/);
  for(const qty of [NaN,Infinity,0,-1,'3'])await assert.rejects(f.c.saveOrderDeliveryRecord('O',request({qty})),/大於 0/);
  assert.equal(f.writes(),0);
});

test('Bioplex, pipette calibration, outsourced slicing and repair cannot bypass service evidence through product shipment',async()=>{
  for(const serviceKind of ['BIOPLEX_LAB','PIPETTE_CALIBRATION','TISSUE_SLICING','ONSITE_REPAIR']){
    const row={itemId:'I',qty:2,orderedQty:2,productType:'Service',serviceKind,fulfillmentType:'WAREHOUSE',
      reservedQty:0,dispatchPreparedQty:0};
    const f=fixture({patch:{items:[row],inventoryReservationStatus:'completed'}});
    await assert.rejects(f.c.saveOrderDeliveryRecord('O',request({qty:1})),/服務型品項/);
    await assert.rejects(f.c.completeOrderDelivery('O','2026-10-16'),/服務型品項/);
    assert.equal(f.writes(),0);assert.deepEqual(f.stock(),[]);
    assert.equal(f.state().deliveryRecords.length,0);
  }
});

test('historical Service delivery cannot be reversed through physical stock corrections',async()=>{
  const row={itemId:'I',qty:2,productType:'Service',reservedQty:0,dispatchPreparedQty:0,fulfillmentType:'WAREHOUSE'};
  const patch={items:[row],deliveryRecords:[{id:'old',itemId:'I',qty:2,lotAllocations:[]}],deliveredQty:2,isDelivered:true};
  const f=fixture({patch});
  await assert.rejects(f.c.cancelOrderDeliveries('O'),/服務型品項/);
  await assert.rejects(f.c.correctOrderDeliveryRecord('O','old','誤登'),/服務型品項/);
  assert.equal(f.writes(),0);assert.deepEqual(f.stock(),[]);
  assert.equal(f.state().deliveryRecords.length,1);
});

test('stock delta and physical return helpers reject service orders before any inventory read',async()=>{
  const stockSource=fs.readFileSync(path.join(__dirname,'../src/services/delivery-stock.js'),'utf8');
  const context=vm.createContext({});
  vm.runInContext(stockSource,context);
  const row={productType:'Service',fulfillmentType:'WAREHOUSE'};
  for(const qty of [0,1,-1])
    await assert.rejects(context.applyInventoryDeliveryDeltaInTransaction(null,row,qty,'Sales','O'),/服務型品項/);
  for(const qty of [0,1,-1])
    await assert.rejects(context.applyInventoryReturnDeltaInTransaction(null,row,qty,'Sales','O'),/服務型品項/);
});
