const test = require('node:test');
const assert = require('node:assert/strict');
const f = require('../modules/fulfillment-core.js');

test('fulfillment core does not own receiving or reservation',()=>{
  assert.equal(f.applyReceipt,undefined);
  assert.equal(f.reserveFromAvailable,undefined);
});
test('dispatch paperwork gates shippable quantity',()=>{
  let x=f.normalizeItem({orderedQty:20,reservedQty:8});
  assert.equal(f.pendingDispatchQty(x),8);
  assert.equal(f.shippableQty(x),0);
  x=f.prepareDispatch(x,8);
  assert.equal(f.shippableQty(x),8);
});

test('dispatch state is the single source for pending and shippable quantities',()=>{
  const state=f.dispatchState({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1});
  assert.deepEqual(state,{delivered:4,grossDelivered:5,returned:1,reserved:4,prepared:7,preparedOutstanding:2,shippable:2,pending:2});
  assert.equal(f.pendingDispatchQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
  assert.equal(f.shippableQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
});
test('dispatch cannot exceed reserved ready quantity',()=>{const x=f.prepareDispatch({orderedQty:20,reservedQty:8},99);assert.equal(x.dispatchPreparedQty,8);});
test('physical delivery consumes only prepared/reserved qty',()=>{let x=f.prepareDispatch({orderedQty:20,reservedQty:8},8);x=f.deliver(x,5);assert.equal(x.deliveredQty,5);assert.equal(x.reservedQty,3);assert.equal(f.shippableQty(x),3);});
test('fulfillment core does not own inventory lot allocation',()=>{assert.equal(f.allocateLots,undefined);});

test('completed prepared delivery exposes next reserved quantity for dispatch',()=>{const x={orderedQty:20,reservedQty:3,dispatchPreparedQty:5,deliveredQty:5};assert.equal(f.shippableQty(x),0);assert.equal(f.pendingDispatchQty(x),3);});


test('direct-ship replacement supply counters can exceed original ordered quantity after return',()=>{
  const x=f.normalizeItem({
    orderedQty:10,
    fulfillmentType:'DIRECT_SHIP',
    supplyOrderedQty:12,
    receivedQty:12,
    deliveredQty:10
  });
  assert.equal(x.supplyOrderedQty,12);
  assert.equal(x.receivedQty,12);
});

test('warehouse cumulative supply counters are preserved instead of silently truncated',()=>{
  const x=f.normalizeItem({orderedQty:5,supplyOrderedQty:7,receivedQty:6});
  assert.equal(x.supplyOrderedQty,7);
  assert.equal(x.receivedQty,6);
  assert.equal(x.reservedQty,0);
  assert.equal(x.shortageQty,5);
});


test('return replacement dispatch remains cumulative beyond original order quantity',()=>{
  let x=f.normalizeItem({
    orderedQty:10,
    reservedQty:2,
    dispatchPreparedQty:12,
    deliveredQty:10,
    returnedQty:2
  });
  assert.equal(x.dispatchPreparedQty,12);
  assert.equal(x.deliveredQty,10);
  assert.equal(x.returnedQty,2);
  assert.equal(x.reservedQty,2);
  assert.equal(x.shortageQty,0);
  assert.equal(f.shippableQty(x),2);

  x=f.deliver(x,2);
  assert.equal(x.deliveredQty,12);
  assert.equal(x.returnedQty,2);
  assert.equal(x.reservedQty,0);
  assert.equal(x.shortageQty,0);
  assert.equal(x.deliveredQty-x.returnedQty,10);
  assert.equal(x.shortageQty,0);
});

test('dispatchState is the single source for pending and shippable quantities',()=>{
  const state=f.dispatchState({
    orderedQty:10,
    reservedQty:4,
    dispatchPreparedQty:7,
    deliveredQty:5,
    returnedQty:1
  });
  assert.deepEqual(state,{
    delivered:4,
    grossDelivered:5,
    returned:1,
    reserved:4,
    prepared:7,
    preparedOutstanding:2,
    shippable:2,
    pending:2
  });
  assert.equal(f.pendingDispatchQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
  assert.equal(f.shippableQty({orderedQty:10,reservedQty:4,dispatchPreparedQty:7,deliveredQty:5,returnedQty:1}),2);
});


test('dispatchState keeps a later live reservation even when a lightweight snapshot omits ordered quantity',()=>{
  const state=f.dispatchState({
    reservedQty:5,
    dispatchPreparedQty:5,
    deliveredQty:5
  });
  assert.equal(state.pending,5);
  assert.equal(state.shippable,0);

  const ready=f.dispatchState({
    reservedQty:5,
    dispatchPreparedQty:10,
    deliveredQty:5
  });
  assert.equal(ready.pending,0);
  assert.equal(ready.shippable,5);
});
test('CLOSE returns do not reopen replacement demand',()=>{
  const x=f.projectOrderDelivery({grossDeliveredQty:12,returnedQty:5,returnRecords:[
    {qty:2,settlement:'CLOSE'},{qty:3,settlement:'REPLACE'}
  ]});
  assert.deepEqual(x,{grossDelivered:12,returned:5,closedReturns:2,effectiveDelivered:9});
  assert.equal(f.projectOrderDelivery({grossDeliveredQty:5,returnedQty:8,
    returnRecords:[{qty:8,settlement:'CLOSE'}]}).effectiveDelivered,5);
});

function orderEvents(){
 const orderId='O',items=[{itemId:'I1',productId:'P',qty:5},{itemId:'I2',productId:'P',qty:2}];
 const shipment=(id,itemId,qty)=>({id,itemId,qty,orderId,productKey:'P',warehouseId:id==='S1'?'A':'B',date:'2026-10-16',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'});
 const shipments=[shipment('S1','I1',3),shipment('S2','I2',2)];
 const deliveries=shipments.map((s,n)=>({...s,id:'D'+n,shipmentId:s.id,qty:n?1:2,date:'2026-10-17',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}));
 const returns=[{...shipments[0],id:'R1',shipmentId:'S1',qty:1,date:'2026-10-18',sourceType:'WAREHOUSE_CUSTOMER_RETURN',condition:'RESTOCKABLE',settlement:'CLOSE'}];
 return {orderId,items,shipments,deliveries,returns};
}
test('whole-order projection partitions same-product lines through the original per-item quantity authority',()=>{
 const input=orderEvents(),before=structuredClone(input),result=f.projectOrderShipmentReturns(input);
 assert.equal(result.orderedQty,7);assert.equal(result.shippedQty,5);assert.equal(result.confirmedQty,3);assert.equal(result.pendingDeliveryQty,2);
 assert.equal(result.returnedQty,1);assert.equal(result.closedQty,1);assert.equal(result.replacementQty,0);assert.equal(result.outstandingQty,2);
 assert.equal(result.effectiveDeliveredQty,3);assert.equal(result.isDelivered,false);
 for(const item of result.items){
  const expected=f.projectShipmentReturns({orderId:input.orderId,...item,
   shipments:input.shipments.filter(r=>r.itemId===item.itemId),deliveries:input.deliveries.filter(r=>r.itemId===item.itemId),returns:input.returns.filter(r=>r.itemId===item.itemId)});
  for(const [key,value] of Object.entries(expected))assert.deepEqual(item[key],value);
 }
 assert.deepEqual(input,before);
});
test('an order is delivered only after every line is acknowledged, regardless of fully shipped totals',()=>{
 const input=orderEvents();input.items[0].qty=3;input.deliveries[0].qty=3;
 assert.equal(f.projectOrderShipmentReturns(input).isDelivered,false);
 input.deliveries[1].qty=2;const done=f.projectOrderShipmentReturns(input);assert.equal(done.isDelivered,true);assert.equal(done.confirmedQty,5);
 input.returns[0].settlement='REPLACE';const replace=f.projectOrderShipmentReturns(input);assert.equal(replace.isDelivered,false);
 assert.equal(replace.replacementQty,1);assert.equal(replace.outstandingQty,1);assert.equal(replace.effectiveDeliveredQty,4);
});
test('whole-order projection rejects unknown or duplicated events before filtering can hide them',()=>{
 for(const mutate of [x=>{x.shipments[0].itemId='unknown';},x=>{x.deliveries[0].productKey='other';},
  x=>{x.returns[0].orderId='other';},x=>{x.shipments[1].id=x.shipments[0].id;},
  x=>{x.deliveries[1].id=x.deliveries[0].id;},x=>{x.returns.push({...x.returns[0],itemId:'I2'});}]){
  const input=orderEvents();mutate(input);assert.throws(()=>f.projectOrderShipmentReturns(input));
 }
});
test('whole-order deliveries and returns cannot borrow another line shipment even for the same product',()=>{
 for(const kind of ['deliveries','returns']){
  const input=orderEvents();input[kind][0].shipmentId='S2';assert.throws(()=>f.projectOrderShipmentReturns(input));
 }
 const input=orderEvents();input.deliveries[0].qty=4;assert.throws(()=>f.projectOrderShipmentReturns(input),/超過/);
});
test('whole-order projection preserves all original chronological return validation',()=>{
 const input=orderEvents();input.returns[0].date='2026-10-16';assert.throws(()=>f.projectOrderShipmentReturns(input),/超過/);
 input.returns[0].date='2026-02-30';assert.throws(()=>f.projectOrderShipmentReturns(input));
});
test('whole-order projection enforces stable source IDs positive integer quantities and bounded event sets',()=>{
 for(const mutate of [x=>{x.items=[];},x=>{x.items.push(x.items[0]);},x=>{x.items[0].qty=0;},
  x=>{x.items[0].qty=1.5;},x=>{x.items[0].orderedQty=99;},x=>{x.items[0].itemId='bad/id';},
  x=>{x.items[0].productId='';},x=>{x.shipments=null;},x=>{x.returns=Array(201).fill(x.returns[0]);}]){
  const input=orderEvents();mutate(input);assert.throws(()=>f.projectOrderShipmentReturns(input));
 }
 const items=Array.from({length:15},(_,i)=>({itemId:'I'+i,productId:'P',qty:1}));
 assert.equal(f.projectOrderShipmentReturns({orderId:'O',items}).orderedQty,15);
 assert.throws(()=>f.projectOrderShipmentReturns({orderId:'O',items:[...items,{itemId:'I16',productId:'P',qty:1}]}));
});
test('15-line whole-order projection validates same-product lots, independent events and service siblings',()=>{
 const orderId='O',items=Array.from({length:15},(_,i)=>i%5===0
  ?{itemId:'I'+i,productType:'SERVICE',qty:2,reservedQty:0}
  :{itemId:'I'+i,productId:'P',qty:1});
 const goods=items.filter(i=>i.productType!=='SERVICE');
 const shipments=goods.map(item=>({id:'S'+item.itemId,itemId:item.itemId,orderId,productKey:'P',qty:1,
  warehouseId:'A',date:'2026-10-16',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}));
 const deliveries=shipments.map(s=>({...s,id:'D'+s.itemId,shipmentId:s.id,date:'2026-10-17',
  sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}));
 const returns=[{...shipments[0],id:'R'+shipments[0].itemId,shipmentId:shipments[0].id,
  date:'2026-10-18',sourceType:'WAREHOUSE_CUSTOMER_RETURN',condition:'RESTOCKABLE',settlement:'REPLACE'}];
 const source={orderId,items,shipments,deliveries,returns},before=structuredClone(source);
 const projected=f.projectOrderShipmentReturns(source);
 assert.equal(projected.items.length,12);assert.equal(projected.orderedQty,12);
 assert.equal(projected.shippedQty,12);assert.equal(projected.confirmedQty,12);
 assert.equal(projected.returnedQty,1);assert.equal(projected.outstandingQty,1);
 assert.equal(projected.isDelivered,false);assert.deepEqual(source,before);
 const invalid=structuredClone(source);invalid.deliveries[11].itemId=goods[0].itemId;
 assert.throws(()=>f.projectOrderShipmentReturns(invalid),/來源|重複|未對應/);
});
test('whole-order aggregate cannot overflow otherwise valid per-item integer quantities',()=>{
 assert.throws(()=>f.projectOrderShipmentReturns({orderId:'O',items:[{itemId:'I1',productId:'P',qty:Number.MAX_SAFE_INTEGER},{itemId:'I2',productId:'Q',qty:1}]}),/安全數量/);
});
