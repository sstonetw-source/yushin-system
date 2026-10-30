'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/grouped-reservation.js','utf8');
const Reservation=require('../modules/reservation-core.js'),Inventory=require('../modules/inventory-core.js');
function fixture({environment='preview',enabled=true,sameWarehouseEnabled=false}={}){
 const calls=[],invalidated=[],reads=[];
 let actor='sales1';
 const docs={
  'inventory/P':{productKey:'P',onHand:20,reserved:0},
  'warehouseStocks/A__P':{productKey:'P',warehouseId:'A',onHand:3,reserved:0},
  'warehouseStocks/B__P':{productKey:'P',warehouseId:'B',onHand:4,reserved:0}
 };
 const order={status:'active',inventoryReservationStatus:'pending',
  inventoryReservationAttemptId:'sync_AAAAAAAA123456',items:[
   {itemId:'I1',productId:'P',warehouseId:'A',qty:5,reservedQty:0},
   {itemId:'I2',productId:'P',warehouseId:'B',qty:5,reservedQty:0}
  ]};
 const globals={YUSHIN_PREVIEW_GROUPED_RESERVATION:enabled,
  YUSHIN_PREVIEW_SAME_WAREHOUSE_RESERVATION:sameWarehouseEnabled,
  YushinReservation:Reservation,YushinInventory:Inventory};
 const context=vm.createContext({
  APP_ENVIRONMENT:environment,currentUser:{get uid(){return actor;}},console,
  globalThis:globals,document:{},
  firebase:{app(){return {functions:region=>this.functions(region)};},functions:region=>({httpsCallable:name=>async payload=>{
   calls.push({region,name,payload});return {data:{status:'applied'}};
  }})},
  normalizedOrderStatus:o=>o.status==='active'?'normal':'cancelled',
  inventoryProductKey:i=>i.productId,
  warehouseStockDocId:(wh,key)=>wh+'__'+key,
  firestoreReadWithTimeout:p=>p,
  invalidateWarehouseStockCache:(key,wh)=>invalidated.push([key,wh]),
  invalidateProcurementDemandQueue:()=>invalidated.push('demand'),
  db:{collection:col=>({doc:id=>({get:async()=>{
   const path=col+'/'+id;reads.push(path);
   return {exists:Object.hasOwn(docs,path),data:()=>structuredClone(docs[path])};
  }})})}
 });
 vm.runInContext(source,context);
 return {context,order,calls,reads,docs,invalidated,setActor:v=>{actor=v;},
  run:()=>context.commitInitialGroupedReservationPreview('O',order,'sales1')};
}
test('opt-in preview only: production and default-off do not read stock or call the backend',async()=>{
 for(const options of [{environment:'production',enabled:true},{environment:'preview',enabled:false}]){
  const f=fixture(options);assert.equal(await f.run(),false);
  assert.equal(f.calls.length,0);assert.equal(f.reads.length,0);
 }
});
test('eligible two-warehouse initial order sends only IDs and shared Core planned quantities',async()=>{
 const f=fixture();
 assert.equal(await f.run(),true);
 assert.equal(f.calls.length,1);assert.equal(f.reads.length,3);
 assert.equal(f.calls[0].region,'asia-east1');
 assert.equal(f.calls[0].name,'commitGroupedWarehouseReservation');
 const payload=f.calls[0].payload;
 assert.equal(payload.orderId,'O');assert.equal(payload.syncAttemptId,f.order.inventoryReservationAttemptId);
 assert.equal(payload.attemptId,'sync_AAAAAAAA123456_group_0');
 assert.deepEqual(Array.from(payload.items,x=>[x.itemId,x.quantity]),[['I1',3],['I2',4]]);
 assert.deepEqual(f.invalidated,[['P','A'],['P','B'],'demand']);
 assert.deepEqual(Object.keys(payload).sort(),['attemptId','items','orderId','syncAttemptId']);
});
test('same-warehouse multi-line Preview is independently default-off and uses one warehouse stock read',async()=>{
 const disabled=fixture();disabled.order.items[1].warehouseId='A';
 assert.equal(await disabled.run(),false);assert.equal(disabled.calls.length,0);
 const f=fixture({sameWarehouseEnabled:true});f.order.items[1].warehouseId='A';
 assert.equal(await f.run(),true);
 assert.equal(f.reads.length,2);
 assert.deepEqual(Array.from(f.calls[0].payload.items,x=>[x.itemId,x.quantity]),[['I1',3],['I2',0]]);
 assert.equal(f.calls[0].payload.attemptId,'sync_AAAAAAAA123456_same_0');
 assert.deepEqual(f.invalidated,[['P','A'],'demand']);
});
test('adding same-warehouse groups never renumbers an existing two-warehouse receipt ID',async()=>{
 const f=fixture({sameWarehouseEnabled:true});
 f.docs['inventory/Q']={productKey:'Q',onHand:10,reserved:0};
 f.docs['warehouseStocks/A__Q']={productKey:'Q',warehouseId:'A',onHand:10,reserved:0};
 f.order.items.unshift({itemId:'Q1',productId:'Q',warehouseId:'A',qty:2,reservedQty:0},
  {itemId:'Q2',productId:'Q',warehouseId:'A',qty:2,reservedQty:0});
 assert.equal(await f.run(),true);
 assert.equal(f.calls.length,2);
 assert.deepEqual(f.calls.map(x=>x.payload.attemptId),[
  'sync_AAAAAAAA123456_same_0','sync_AAAAAAAA123456_group_0']);
});
test('unsupported, pending progress or changed login fail closed without remote writes',async()=>{
 for(const change of [
  o=>o.inventoryReservationStatus='completed',
  o=>o.items[0].deliveredQty=1,
  o=>o.items[0].reservedQty=1,
  o=>o.items[0].warehouseShippedQty=1,
  o=>o.items[1].fulfillmentType='DIRECT_SHIP',
  o=>o.items[0].warehouseId='B',
  o=>o.items[0].qty=1.5
 ]){
  const f=fixture();change(f.order);
  assert.equal(await f.run(),false);assert.equal(f.calls.length,0);
 }
 const f=fixture();f.setActor('sales2');
 await assert.rejects(f.run(),/登入身分已變更/);
 assert.equal(f.calls.length,0);
});
test('corrupt reserved ledger rejects before callable; zero stock falls back to original item service',async()=>{
 const f=fixture();f.docs['warehouseStocks/A__P'].reserved=9;
 await assert.rejects(f.run(),/途中帳目超過實貨/);
 assert.equal(f.calls.length,0);
 const zero=fixture();zero.docs['warehouseStocks/A__P'].onHand=0;
 zero.docs['warehouseStocks/B__P'].onHand=0;
 assert.equal(await zero.run(),false);assert.equal(zero.calls.length,0);
});
test('source joins order initial sync before per-item reconciliation but never replaces it',()=>{
 const orderSource=fs.readFileSync('src/services/order-reservation.js','utf8');
 assert.match(orderSource,/await commitInitialGroupedReservationPreview\(orderId,liveOrder,actorUid\)/);
 assert.match(orderSource,/for\(let i=0;i<items\.length;i\+\+\)await reserveSingleOrderItem/);
 const build=fs.readFileSync('tools/build-app.cjs','utf8');
 assert.ok(build.indexOf('src/services/grouped-reservation.js')<build.indexOf('src/services/order-reservation.js'));
});
