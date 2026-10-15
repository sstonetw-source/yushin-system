const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/reservation-core'),permissions=require('../modules/stock-permissions');
const plan=core.planReservationLifecycle,fulfillment=require('../modules/fulfillment-core');
const workflow=require('../modules/workflow-core');
const demandCore=require('../modules/procurement-demand-core');
const app=fs.readFileSync('app.js','utf8');
const lifecycle=app.slice(app.indexOf('async function adjustInventoryReservationForLifecycle('),app.indexOf('function confirmOrderCancellation('));
const stock=(reserved=0,onHand=10)=>({productKey:'P',onHand,reserved,incoming:0});
test('cancellation releases the entire held quantity or refuses inconsistent totals',()=>{
 const base={nextStatus:'cancelled',existingQty:3,itemReservedQty:3,aggregateStock:stock(5),warehouseStock:stock(4)};
 assert.deepEqual(plan(base),{reservedQty:0,shortageQty:0,reservedDelta:-3});
 for(const patch of [{aggregateStock:stock(2)},{warehouseStock:stock(2)},{itemReservedQty:2},{aggregateStock:undefined},{warehouseStock:undefined}])
  assert.throws(()=>plan({...base,...patch}),/不足|不一致/);
});
test('restoration is capped by both company availability and actual warehouse availability',()=>{
 const base={nextStatus:'normal',requestedQty:5,aggregateStock:stock(8),warehouseStock:stock()};
 assert.deepEqual(plan(base),{reservedQty:2,shortageQty:3,reservedDelta:2});
 assert.equal(plan({...base,aggregateStock:stock(),warehouseStock:stock(9)}).reservedQty,1);
 assert.equal(plan({...base,aggregateStock:undefined}).reservedQty,0);
});
test('free stock in transit and outstanding supplier commitments do not become restored physical holds',()=>{
 const base={nextStatus:'normal',requestedQty:5,aggregateStock:stock(),warehouseStock:stock()};
 assert.equal(plan({...base,aggregateStock:{...stock(),transferFreeInTransit:8}}).reservedQty,2);
 assert.deepEqual(plan({...base,inTransitQty:3}),{reservedQty:2,shortageQty:3,reservedDelta:2});
});
test('already held stock is preserved and repeated restoration calculations have zero delta',()=>{
 const base={nextStatus:'normal',requestedQty:5,existingQty:3,itemReservedQty:3,aggregateStock:stock(3),warehouseStock:stock(3)};
 assert.deepEqual(plan({...base,inTransitQty:4}),{reservedQty:3,shortageQty:2,reservedDelta:0});
 const result=plan(base);
 assert.deepEqual(plan({...base,existingQty:5,itemReservedQty:5,aggregateStock:stock(5),warehouseStock:stock(5)}),{reservedQty:5,shortageQty:0,reservedDelta:0});
 assert.equal(result.reservedDelta,2);
});
test('legacy fractions remain valid while corrupt quantities cannot be clamped into successful cancellation',()=>{
 assert.equal(plan({nextStatus:'cancelled',existingQty:'0.5',itemReservedQty:0.5,aggregateStock:stock(1),warehouseStock:stock(1)}).reservedDelta,-0.5);
 for(const value of [null,NaN,Infinity,-1,'bad','',true]){
  assert.throws(()=>plan({nextStatus:'cancelled',existingQty:value}));
  assert.throws(()=>plan({nextStatus:'normal',aggregateStock:{onHand:value,reserved:0},warehouseStock:stock()}));
 }
 assert.throws(()=>plan({nextStatus:'normal',aggregateStock:stock(11),warehouseStock:stock()}),/異常/);
 assert.throws(()=>plan({nextStatus:'invalid'}),/狀態/);
});

function fixture({role='admin',held=3,qty=5,status='active'}={}){
 let sequence=0;const reads=[],writes=[],docs=new Map();
 const item={itemId:'I',productId:'P',warehouseId:'A',qty,reservedQty:held};
 docs.set('orders/O',{ownerUid:'U',salesCode:'S',status,items:[item]});
 docs.set('inventory/P',stock(held));docs.set('warehouseStocks/A__P',{...stock(held),warehouseId:'A'});
 docs.set('warehouses/A',{active:true,warehouseType:'PHYSICAL'});docs.set('warehouses/B',{active:true,warehouseType:'PHYSICAL'});
 docs.set('inventoryReservations/O__I',{orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',quantity:held,shortageQty:qty-held});
 docs.set('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'),demandCore.demandDocument({sourceType:'SALES_ORDER',sourceId:'O',sourceItemId:'I',sourceItemIndex:0,productKey:'P',productId:'P',warehouseId:'A',ownerUid:'U',salesCode:'S',requestedQty:Math.max(0,qty-held),orderedQty:0,receivedQty:0,status:status==='cancelled'?'CANCELLED':'PENDING'}));
 const db={collection:col=>({doc:(id='event'+(++sequence))=>({path:col+'/'+id,id})}),runTransaction:async fn=>{
  const pending=[];const result=await fn({get:async ref=>{assert.equal(pending.length,0);reads.push(ref.path);return {exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))};},
   set:(ref,data,options)=>pending.push({ref,data,options}),update:(ref,data)=>pending.push({ref,data,options:{merge:true}}),delete:ref=>pending.push({ref,method:'delete'})});
  for(const w of pending){writes.push(w);if(w.method==='delete')docs.delete(w.ref.path);else docs.set(w.ref.path,{...(w.options?.merge?docs.get(w.ref.path):{}),...structuredClone(w.data)});}return result;
 }};
 const c=vm.createContext({db,YushinReservation:core,YushinProcurementDemand:demandCore,YushinWorkflow:workflow,YushinFulfillment:fulfillment,procurementDemandRef:id=>db.collection('procurementDemands').doc(encodeURIComponent(id)),normalizedOrderItems:o=>o.items.map(fulfillment.normalizeItem),normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',savedDeliveryRecords:o=>o.deliveryRecords||[],savedReturnRecords:o=>o.returnRecords||[],
  inventoryProductKey:i=>i.productId||'',inventoryRefFor:i=>i.productId?db.collection('inventory').doc(i.productId):null,
  warehouseStockDocId:(w,p)=>w+'__'+p,defaultWarehouse:()=>({id:'A'}),salesCodeForName:()=> 'S',
  inventoryMovementRecord:(type,qty,sourceId,productKey,actor,extra)=>({type,qty,sourceId,sourceType:'order',productKey,ownerUid:'U',salesCode:'S',actorUid:role,...extra})});
 vm.runInContext(app.slice(app.indexOf('function procurementDemandForOrderItem('),app.indexOf('function purchasingLifecycleSnapshot(')),c);
 vm.runInContext(app.slice(app.indexOf('function orderItemProcurementDemandDocument('),app.indexOf('async function persistOrderProcurementDemands(')),c);
 vm.runInContext(lifecycle,c);
 const run=async(nextStatus='cancelled')=>permissions.run(db,async tx=>{
  const ref=db.collection('orders').doc('O'),order=(await tx.get(ref)).data();
  const result=await c.adjustInventoryReservationForLifecycle(tx,'O',order,nextStatus,role);tx.update(ref,{status:nextStatus==='normal'?'active':'cancelled'});return result;
 },'U',['sales','engineer'].includes(role),role);
 return {docs,reads,writes,run,c,db};
}
test('actual cancellation preserves other orders held stock and never changes onHand',async()=>{
 for(const role of ['admin','sales','engineer']){
  const f=fixture({role});f.docs.get('inventory/P').reserved=7;f.docs.get('warehouseStocks/A__P').reserved=6;
  await f.run();assert.equal(f.docs.get('inventory/P').reserved,4);assert.equal(f.docs.get('warehouseStocks/A__P').reserved,3);
  assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('inventoryReservations/O__I').quantity,0);
  assert.equal(f.reads.length,5);
 }
});
test('cancelling an order atomically closes its existing demand without rewriting supplier history',async()=>{
 for(const role of ['admin','sales','engineer']){
  const f=fixture({role});
  const demand=f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'));
  Object.assign(demand,{requestedQty:5,orderedQty:3,remainingToOrderQty:2,remainingToReceiveQty:3,status:'PARTIALLY_ORDERED'});
  await f.run('cancelled');
  const saved=f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'));
  assert.equal(saved.status,'CANCELLED');assert.equal(saved.remainingToOrderQty,0);
  assert.equal(saved.orderedQty,3);assert.equal(saved.receivedQty,0);assert.equal(saved.requestedQty,5);
  assert.equal(f.docs.get('orders/O').status,'cancelled');
  assert.equal(f.docs.get('inventoryReservations/O__I').quantity,0);
 }
});
test('missing demand is not invented by order cancellation and malformed demand aborts stock release',async()=>{
 const a=fixture();a.docs.delete('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'));
 await a.run('cancelled');assert.equal([...a.docs.keys()].filter(k=>k.startsWith('procurementDemands/')).length,0);
 const b=fixture();b.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')).sourceItemId='OTHER';
 const before=structuredClone([...b.docs]);
 await assert.rejects(b.run('cancelled'),/不一致/);assert.deepEqual([...b.docs],before);assert.equal(b.writes.length,0);
});
test('restoration reopens cancelled demand and preserves supplier commitments in the stock transaction',async()=>{
 for(const role of ['admin','sales','engineer']){
  const f=fixture({role,held:0,status:'cancelled'});
  const d=f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'));
  Object.assign(d,{requestedQty:5,orderedQty:3,receivedQty:0,remainingToOrderQty:0,remainingToReceiveQty:3,status:'CANCELLED'});
  f.docs.get('orders/O').items[0].supplyOrderedQty=3;
  f.docs.get('inventory/P').reserved=8;
  await f.run('normal');
  const next=f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'));
  assert.equal(next.status,'ORDERED');
  assert.equal(next.requestedQty,3);assert.equal(next.remainingToOrderQty,0);
  assert.equal(next.orderedQty,3);assert.equal(next.receivedQty,0);
  assert.equal(f.docs.get('orders/O').status,'active');
  assert.equal(f.docs.get('inventoryReservations/O__I').quantity,2);
 }
});
test('restoration creates missing positive demand atomically and skips empty demand',async()=>{
 const f=fixture({held:0,status:'cancelled'}),key='procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I');
 f.docs.delete(key);f.docs.get('inventory/P').reserved=10;
 await f.run('normal');assert.equal(f.docs.get(key).status,'PENDING');assert.equal(f.docs.get(key).requestedQty,5);
 const g=fixture({held:0,status:'cancelled'});g.docs.delete(key);g.docs.get('orders/O').items[0].qty=0;
 await g.run('normal');assert.equal(g.docs.has(key),false);
});
test('restoration rejects inconsistent supplier progress without partial stock or order writes',async()=>{
 for(const change of [
  d=>d.orderedQty=3,
  d=>d.receivedQty=1,
  d=>d.ownerUid='WRONG',
  d=>d.productKey='WRONG',
  d=>d.warehouseId='B'
 ]){
  const f=fixture({held:0,status:'cancelled'}),key='procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I');
  change(f.docs.get(key));const before=structuredClone([...f.docs]);
  await assert.rejects(f.run('normal'),/不一致|稽核/);assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
test('actual cancellation cannot erase an underfunded ledger even for an admin',async()=>{
 for(const role of ['admin','sales','engineer'])for(const path of ['inventory/P','warehouseStocks/A__P']){
  const f=fixture({role});f.docs.get(path).reserved=1;const before=structuredClone([...f.docs]);
  await assert.rejects(f.run(),/不足|異常/);assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
test('missing reservation and inconsistent item projections stop without inventing a replacement',async()=>{
 for(const mutate of [f=>f.docs.delete('inventoryReservations/O__I'),f=>f.docs.get('orders/O').items[0].reservedQty=2,
  f=>f.docs.get('inventoryReservations/O__I').quantity=null,
  ...[null,-1,6].map(value=>f=>f.docs.get('orders/O').items[0].reservedQty=value)]){
  const f=fixture();mutate(f);const before=structuredClone([...f.docs]);
  await assert.rejects(f.run(),/不一致|不正確/);assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
test('source, product and location mismatches fail before any native write',async()=>{
 for(const [path,key,value] of [['inventoryReservations/O__I','orderId','OTHER'],['inventoryReservations/O__I','itemId','OTHER'],
  ['inventoryReservations/O__I','productKey','OTHER'],['inventoryReservations/O__I','warehouseId','B'],
  ['inventory/P','productKey','OTHER'],['warehouseStocks/A__P','warehouseId','B']]){
  const f=fixture();f.docs.get(path)[key]=value;await assert.rejects(f.run(),/不一致/);assert.equal(f.writes.length,0);
 }
});
test('in-transit transfers stop cancellation and restoration while custody cancellation stays supported',async()=>{
 for(const status of ['normal','cancelled']){
  const f=fixture();f.docs.get('orders/O').items[0].transferPendingId='T';await assert.rejects(f.run(status),/調撥途中/);assert.equal(f.writes.length,0);
 }
 const f=fixture(),item=f.docs.get('orders/O').items[0],res=f.docs.get('inventoryReservations/O__I');
 item.warehouseId=res.warehouseId='custody-U';f.docs.set('warehouseStocks/custody-U__P',{...f.docs.get('warehouseStocks/A__P'),warehouseId:'custody-U'});
 await f.run();assert.equal(f.docs.get('warehouseStocks/custody-U__P').reserved,0);
});
test('actual restoration respects company free stock and preserves the physical shortage including supply commitments',async()=>{
 for(const role of ['admin','sales','engineer']){
  const f=fixture({role,held:0,status:'cancelled'});f.docs.get('inventory/P').reserved=8;
  await f.run('normal');const item=f.docs.get('orders/O').items[0];
  assert.equal(item.reservedQty,2);assert.equal(item.shortageQty,3);assert.equal(f.docs.get('inventory/P').reserved,10);
  assert.equal(f.docs.get('warehouseStocks/A__P').reserved,2);
 }
 const f=fixture({held:0,status:'cancelled'});f.docs.get('orders/O').items[0].supplyOrderedQty=3;
 const linked=f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'));
 Object.assign(linked,{orderedQty:3,requestedQty:5,remainingToReceiveQty:3,status:'CANCELLED'});
 await f.run('normal');assert.equal(f.docs.get('inventoryReservations/O__I').quantity,2);assert.equal(f.docs.get('orders/O').items[0].shortageQty,3);
 assert.equal(f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')).orderedQty,3);
});
test('restoration refuses missing, inactive and custody warehouses without changing stock or order',async()=>{
 for(const role of ['admin','sales','engineer']){
  for(const change of [
   f=>f.docs.delete('warehouses/A'),
   f=>f.docs.get('warehouses/A').active=false,
   f=>f.docs.get('warehouses/A').systemCustody=true,
   f=>f.docs.get('warehouses/A').warehouseType='CUSTODY',
   f=>{const item=f.docs.get('orders/O').items[0],reservation=f.docs.get('inventoryReservations/O__I');item.warehouseId=reservation.warehouseId='custody-U';}
  ]){
   const f=fixture({role,held:0,status:'cancelled'});change(f);
   const before=structuredClone([...f.docs]);
   await assert.rejects(f.run('normal'),/原訂單倉庫|不能恢復預留/);
   assert.deepEqual([...f.docs],before);
   assert.equal(f.writes.length,0);
  }
 }
});
test('cancellation may release a hold in a disabled warehouse; restoration reuses a master read per location',async()=>{
 const f=fixture();f.docs.get('warehouses/A').active=false;
 await f.run('cancelled');assert.equal(f.docs.get('inventory/P').reserved,0);
 const g=fixture({held:0,status:'cancelled'});
 g.docs.get('orders/O').items.push({...g.docs.get('orders/O').items[0],itemId:'J'});
 g.docs.set('inventoryReservations/O__J',{orderId:'O',itemId:'J',productKey:'P',warehouseId:'A',quantity:0});
 await g.run('normal');
 assert.equal(g.reads.filter(ref=>ref==='warehouses/A').length,1);
 assert.equal(g.docs.get('inventory/P').reserved,10);
});
test('invalid later restoration warehouse cannot partially reserve the earlier item',async()=>{
 const f=fixture({held:0,status:'cancelled'});
 f.docs.get('orders/O').items.push({itemId:'J',productId:'P',warehouseId:'B',qty:5,reservedQty:0});
 f.docs.set('warehouseStocks/B__P',{...stock(),warehouseId:'B'});
 f.docs.set('inventoryReservations/O__J',{orderId:'O',itemId:'J',productKey:'P',warehouseId:'B',quantity:0});
 f.docs.get('warehouses/B').active=false;
 const before=structuredClone([...f.docs]);
 await assert.rejects(f.run('normal'),/不能恢復預留/);
 assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
});
test('two same-product lines share the company ceiling across different warehouses',async()=>{
 const f=fixture({held:0,status:'cancelled'});f.docs.get('inventory/P').onHand=6;
 f.docs.get('orders/O').items.push({itemId:'J',productId:'P',warehouseId:'B',qty:5,reservedQty:0});
 f.docs.set('warehouseStocks/B__P',{...stock(),warehouseId:'B'});
 f.docs.set('inventoryReservations/O__J',{orderId:'O',itemId:'J',productKey:'P',warehouseId:'B',quantity:0});
 await f.run('normal');assert.equal(f.docs.get('inventory/P').reserved,6);
 assert.deepEqual(f.docs.get('orders/O').items.map(i=>i.reservedQty),[5,1]);
});
test('zero-availability restoration and zero-hold cancellation never write unchanged stock',async()=>{
 for(const role of ['admin','sales','engineer'])for(const status of ['normal','cancelled']){
  const f=fixture({role,held:0,status:status==='normal'?'cancelled':'active'});
  if(status==='normal')f.docs.get('inventory/P').reserved=10;
  await f.run(status);
  assert.equal(f.docs.get('inventoryReservations/O__I').quantity,0);
  assert.equal(f.docs.get('orders/O').items[0].shortageQty,status==='normal'?5:0);
  assert.equal(f.writes.filter(w=>['inventory','warehouseStocks','inventoryMovements','stockOperations'].includes(w.ref.path.split('/')[0])).length,0);
 }
});
test('second-item failure rolls back the first-item proposed release',async()=>{
 const f=fixture();f.docs.get('inventory/P').reserved=5;f.docs.get('warehouseStocks/A__P').reserved=5;
 f.docs.get('orders/O').items.push({...f.docs.get('orders/O').items[0],itemId:'J'});
 f.docs.set('inventoryReservations/O__J',{orderId:'O',itemId:'J',productKey:'P',warehouseId:'A',quantity:3});
 const before=structuredClone([...f.docs]);await assert.rejects(f.run(),/不足/);assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
});
test('zero-hold direct shipment cancellation does not read physical stock or discard an accidental hold',async()=>{
 const f=fixture({held:0});f.docs.get('orders/O').items[0].fulfillmentType='DIRECT_SHIP';f.docs.get('inventoryReservations/O__I').warehouseId='';
 await f.run();assert.deepEqual(f.reads,['orders/O','inventoryReservations/O__I','procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')]);
 const g=fixture();g.docs.get('orders/O').items[0].fulfillmentType='DIRECT_SHIP';g.docs.get('inventoryReservations/O__I').warehouseId='';
 await assert.rejects(g.run(),/不足/);assert.equal(g.writes.length,0);
});

const deletionFunctions=app.slice(app.indexOf('function assertOrderEligibleForPermanentDelete('),app.indexOf('window.permanentlyDeleteOrder =',app.indexOf('function assertOrderEligibleForPermanentDelete(')));
function deletionFixture(options={}){
 const f=fixture(options);
 f.c.runRoleTransaction=fn=>permissions.run(f.db,fn,'U',false,options.role||'admin');
 vm.runInContext(deletionFunctions,f.c);
 return {...f,deleteOrder:()=>f.c.deleteUnfulfilledOrderAtomically('O','U')};
}
test('permanent deletion releases stock and removes order, reservation and unpurchased demand in a single transaction',async()=>{
 for(const held of [0,3]){
  const f=deletionFixture({held});
  await f.deleteOrder();
  assert.equal(f.docs.has('orders/O'),false);
  assert.equal(f.docs.has('inventoryReservations/O__I'),false);
  assert.equal(f.docs.has('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')),false);
  assert.equal(f.docs.get('inventory/P').reserved,0);
  assert.equal(f.docs.get('warehouseStocks/A__P').reserved,0);
  assert.equal(f.docs.get('inventory/P').onHand,10);
  assert.equal(f.writes.filter(w=>w.method==='delete').length,3);
 }
 const cancelled=deletionFixture({held:0,status:'cancelled'});
 await cancelled.deleteOrder();
 assert.equal(cancelled.docs.has('orders/O'),false);
 assert.equal(cancelled.writes.filter(w=>w.ref.path.startsWith('inventoryMovements/')).length,0);
});
test('permanent deletion stops on supplier commitments, provenance errors and held cancelled orders without mutations',async()=>{
 const edits=[
  f=>f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')).orderedQty=1,
  f=>f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')).receivedQty=1,
  f=>f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')).sourceItemId='OTHER',
  f=>f.docs.get('orders/O').items[0].supplyOrderedQty=1,
  f=>f.docs.get('orders/O').items[0].purchaseDocumentNos=['PO-1'],
  f=>f.docs.get('orders/O').sourceId='Q-1',
  f=>f.docs.get('orders/O').inventoryReservationStatus='pending',
  f=>f.docs.get('orders/O').deliveryRecords=[{itemId:'I',qty:1}]
 ];
 for(const edit of edits){
  const f=deletionFixture();edit(f);
  const before=structuredClone([...f.docs]);
  await assert.rejects(f.deleteOrder());
  assert.deepEqual([...f.docs],before);
  assert.equal(f.writes.length,0);
 }
 const cancelled=deletionFixture({held:3,status:'cancelled'});
 const before=structuredClone([...cancelled.docs]);
 await assert.rejects(cancelled.deleteOrder(),/仍占用庫存|不為零/);
 assert.deepEqual([...cancelled.docs],before);
 assert.equal(cancelled.writes.length,0);
});
test('permanent deletion aborts all changes when later linked item has invalid demand',async()=>{
 const f=deletionFixture(),first=f.docs.get('orders/O').items[0];
 f.docs.get('orders/O').items.push({...first,itemId:'J',reservedQty:0});
 f.docs.set('inventoryReservations/O__J',{orderId:'O',itemId:'J',productKey:'P',warehouseId:'A',quantity:0});
 f.docs.set('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:J'),{
  ...f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')),
  demandId:'SALES_ORDER:O:J',sourceItemId:'J',ownerUid:'WRONG'
 });
 const before=structuredClone([...f.docs]);
 await assert.rejects(f.deleteOrder(),/不一致/);
 assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
});


test('permanent deletion preserves all records when procurement quantities are malformed or negative',async()=>{
 for(const field of ['orderedQty','receivedQty']){
  for(const value of [-1,NaN,Infinity,-Infinity,'0',null,undefined]){
   const f=deletionFixture();
   f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I'))[field]=value;
   const before=structuredClone([...f.docs]);
   await assert.rejects(f.deleteOrder(),/數量異常/);
   assert.deepEqual([...f.docs],before,`${field}: ${String(value)}`);
   assert.equal(f.writes.length,0);
  }
 }
});

function deletionActionFixture(){
 let resolveRead,rejectRead,reads=0,deletes=0,confirms=0;
 const read=new Promise((resolve,reject)=>{resolveRead=resolve;rejectRead=reject;});
 const button={disabled:false};
 const c=vm.createContext({window:{},trueUserRole:'admin',currentUserRole:'admin',
  ordersCache:[{id:'O',orderNo:'SO-1'}],orderHistorySearchResults:[{id:'O'}],pendingLifecycleOrderIds:new Set(),
  assertOrderEligibleForPermanentDelete:()=>{},confirm:()=>{confirms++;return true;},alert:()=>{},
  actionButtonFromEventOrSelector:()=>button,beginActionButton:b=>{b.disabled=true;return {};},endActionButton:b=>{b.disabled=false;},
  renderOrdersList:()=>{},showActionFeedback:()=>{},deliveryActor:()=> 'U',
  firestoreReadWithTimeout:p=>p,db:{collection:()=>({where:()=>({limit:()=>({get:()=>{reads++;return read;}})})})},
  deleteUnfulfilledOrderAtomically:async()=>{deletes++;}});
 vm.runInContext(app.slice(app.indexOf('window.permanentlyDeleteOrder ='),app.indexOf('window.openForecastProgressModal')),c);
 return {c,button,resolveRead,rejectRead,counts:()=>({reads,deletes,confirms})};
}
test('permanent deletion shares the lifecycle lock and prevents duplicate requests until confirmed success',async()=>{
 const f=deletionActionFixture(),first=f.c.window.permanentlyDeleteOrder('O');
 assert.equal(f.c.pendingLifecycleOrderIds.has('O'),true);assert.equal(f.button.disabled,true);
 assert.equal(f.c.ordersCache.length,1);
 await f.c.window.permanentlyDeleteOrder('O');
 assert.deepEqual(f.counts(),{reads:1,deletes:0,confirms:1});
 f.resolveRead({empty:true});await first;
 assert.deepEqual(f.counts(),{reads:1,deletes:1,confirms:1});
 assert.equal(f.c.ordersCache.length,0);assert.equal(f.c.orderHistorySearchResults.length,0);
 assert.equal(f.c.pendingLifecycleOrderIds.has('O'),false);assert.equal(f.button.disabled,false);
});
test('failed permanent deletion preserves caches and releases the lock for retry',async()=>{
 for(const failure of ['read','supply','transaction']){
  const f=deletionActionFixture();
  if(failure==='transaction')f.c.deleteUnfulfilledOrderAtomically=async()=>{throw new Error('transaction failed');};
  const first=f.c.window.permanentlyDeleteOrder('O');
  if(failure==='read')f.rejectRead(new Error('offline'));
  else f.resolveRead({empty:failure!=='supply'});
  await first;
  assert.equal(f.c.ordersCache.length,1);assert.equal(f.c.orderHistorySearchResults.length,1);
  assert.equal(f.c.pendingLifecycleOrderIds.has('O'),false);assert.equal(f.button.disabled,false);
 }
});
test('permanent deletion cannot start during another lifecycle operation',async()=>{
 const f=deletionActionFixture();f.c.pendingLifecycleOrderIds.add('O');
 await f.c.window.permanentlyDeleteOrder('O');
 assert.deepEqual(f.counts(),{reads:0,deletes:0,confirms:0});
 assert.equal(f.c.pendingLifecycleOrderIds.has('O'),true);
});

test('permanent deletion validates raw quantities before display normalization can erase anomalies',async()=>{
 for(const field of ['qty','orderedQty','reservedQty','supplyOrderedQty','receivedQty','dispatchPreparedQty','deliveredQty','returnedQty']){
  for(const value of [-1,NaN,Infinity,-Infinity,'bad','',true,null]){
   const f=deletionFixture();f.docs.get('orders/O').items[0][field]=value;
   const before=structuredClone([...f.docs]);
   await assert.rejects(f.deleteOrder(),/原始品項數量異常/);
   assert.deepEqual([...f.docs],before,`${field}: ${String(value)}`);assert.equal(f.writes.length,0);
  }
 }
});
test('permanent deletion retains raw fulfillment facts, transfer links and clamped reservation projections',async()=>{
 const patches=[{dispatchPreparedQty:1},{returnedQty:1},{deliveredQty:1},
  {transferPendingId:'T'},{custodyTransferId:'T'},{reservedQty:6}];
 for(const patch of patches){
  const f=deletionFixture();Object.assign(f.docs.get('orders/O').items[0],patch);
  const before=structuredClone([...f.docs]);
  await assert.rejects(f.deleteOrder(),/原始品項已有|調撥關聯|原始預留數量/);
  assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
test('cancelled order deletion refuses malformed reservation quantities rather than coercing them to zero',async()=>{
 for(const value of [null,undefined,NaN,Infinity,'',false]){
  const f=deletionFixture({held:0,status:'cancelled'});
  f.docs.get('inventoryReservations/O__I').quantity=value;
  const before=structuredClone([...f.docs]);
  await assert.rejects(f.deleteOrder(),/仍占用庫存/);
  assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
test('legacy numeric strings and fractional reservations can still be permanently deleted',async()=>{
 const f=deletionFixture({held:0.5,qty:1.5});
 Object.assign(f.docs.get('orders/O').items[0],{qty:'1.5',reservedQty:'0.5',supplyOrderedQty:'0'});
 await f.deleteOrder();
 assert.equal(f.docs.has('orders/O'),false);assert.equal(f.docs.get('inventory/P').reserved,0);
});

test('duplicate item identities cannot release another orders stock or restore the same reservation twice',async()=>{
 for(const role of ['admin','sales','engineer']){
  for(const nextStatus of ['cancelled','normal']){
   const f=fixture({role,held:3,status:nextStatus==='normal'?'cancelled':'active'});
   f.docs.get('inventory/P').reserved=9;f.docs.get('warehouseStocks/A__P').reserved=9;
   f.docs.get('orders/O').items.push({...f.docs.get('orders/O').items[0]});
   // Legacy demand rows use -1 when the original item index is unknown.
   f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I')).sourceItemIndex=-1;
   const before=structuredClone([...f.docs]);
   await assert.rejects(f.run(nextStatus),/品項識別碼重複/);
   assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
  }
 }
});
test('generated legacy item identities cannot collide with an explicit item identity during lifecycle changes',async()=>{
 for(const nextStatus of ['cancelled','normal']){
  const f=fixture();
  const item=f.docs.get('orders/O').items[0];
  item.itemId='item-2';f.docs.get('orders/O').items.push({...item,itemId:''});
  const before=structuredClone([...f.docs]);
  await assert.rejects(f.run(nextStatus),/品項識別碼重複/);
  assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
