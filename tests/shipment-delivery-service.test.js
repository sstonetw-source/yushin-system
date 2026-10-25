'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const core=require('../modules/fulfillment-core');
const {normalizeDeliveryIntent,commitShipmentDelivery}=require('../functions/shipment-delivery-service');
const shipment=(id,qty,warehouseId='A')=>({id,qty,warehouseId,orderId:'O',itemId:'I',productKey:'P',
 sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT',date:'2026-10-17'});
const delivery=(id,qty,shipmentId='S1',warehouseId='A')=>({id,qty,shipmentId,warehouseId,orderId:'O',itemId:'I',productKey:'P',
 sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION',date:'2026-10-18'});
const source=(patch={})=>({orderId:'O',itemId:'I',productKey:'P',orderedQty:10,
 shipments:[shipment('S1',4),shipment('S2',6,'B')],deliveries:[],...patch});
test('shipment/delivery projection preserves physical shipped and customer-confirmed totals separately',()=>{
 const input=source({deliveries:[delivery('D1',2),delivery('D2',3,'S2','B')]}),before=structuredClone(input);
 const result=core.projectShipmentDelivery(input);
 assert.deepEqual(input,before);assert.equal(result.shippedQty,10);assert.equal(result.confirmedQty,5);
 assert.equal(result.pendingDeliveryQty,5);assert.equal(result.isDelivered,false);
 assert.deepEqual(result.shipments,[{shipmentId:'S1',shippedQty:4,confirmedQty:2,pendingQty:2},
  {shipmentId:'S2',shippedQty:6,confirmedQty:3,pendingQty:3}]);
 const complete=core.projectShipmentDelivery(source({deliveries:[delivery('D1',4),delivery('D2',6,'S2','B')]}));
 assert.equal(complete.isDelivered,true);assert.equal(complete.pendingDeliveryQty,0);
});
test('empty shipments cannot produce delivery; quantities, identity and legacy events fail closed',()=>{
 for(const patch of [
  {shipments:[],deliveries:[delivery('D',1)]},
  {shipments:[shipment('S1',4),shipment('S1',4)]},
  {shipments:[shipment('S1',11)]},
  {shipments:[shipment('S1',1.5)]},
  {shipments:[{...shipment('S1',4),productKey:'other'}]},
  {deliveries:[delivery('D',5)]},
  {deliveries:[delivery('D',1),delivery('D',1)]},
  {deliveries:[delivery('D',1,'missing')]},
  {deliveries:[delivery('D',1,'S1','B')]},
  {deliveries:[{...delivery('D',1),sourceType:'INVENTORY_SHIPMENT'}]},
  {deliveries:[{...delivery('D',1),date:'2026-10-16'}]},
  {deliveries:[{...delivery('D',1),date:'2026-02-30'}]},
  {deliveries:[{...delivery('D',1),qty:'1'}]},
  {shipments:Array.from({length:201},(_,i)=>shipment('S'+i,1)),orderedQty:201},
 ])assert.throws(()=>core.projectShipmentDelivery(source(patch)));
});
test('multiple partial acknowledgements cannot exceed their own shipment despite another shipment slack',()=>{
 assert.throws(()=>core.projectShipmentDelivery(source({deliveries:[delivery('D1',3),delivery('D2',2)]})),/超過/);
 assert.equal(core.projectShipmentDelivery(source({shipments:[],deliveries:[]})).isDelivered,false);
 for(let shipped=1;shipped<=10;shipped++)for(let confirmed=0;confirmed<=shipped;confirmed++){
  const result=core.projectShipmentDelivery(source({shipments:[shipment('S1',shipped)],
   deliveries:confirmed?[delivery('D1',confirmed)]:[]}));
  assert.equal(result.shippedQty-result.confirmedQty,result.pendingDeliveryQty);
 }
});
function request(patch={}){return {orderId:'O',itemId:'I',shipmentId:'shipment_12345',operationId:'delivery_12345',
 syncAttemptId:'sync_12345',quantity:2,date:'2026-10-18',...patch};}
test('acknowledgement retry intent binds source shipment, date, quantity, notes and sync checkpoint',()=>{
 const original=normalizeDeliveryIntent(request());
 for(const patch of [{shipmentId:'other'},{quantity:3},{date:'2026-10-19'},{notes:'new'},
  {syncAttemptId:'other'},{operationId:'delivery_67890'}])
  assert.notEqual(normalizeDeliveryIntent(request(patch)).hash,original.hash);
 for(const patch of [{actorRole:'admin'},{quantity:'2'},{quantity:0},{date:'2026-02-30'},
  {shipmentId:'../bad'},{operationId:'bad'},{notes:[]}])assert.throws(()=>normalizeDeliveryIntent(request(patch)));
});
test('acknowledgement writer stays Emulator-only and has no public Callable export',async()=>{
 await assert.rejects(commitShipmentDelivery({projectId:'production'},'actor',request()),/僅允許/);
 const host=process.env.FIRESTORE_EMULATOR_HOST;
 try{delete process.env.FIRESTORE_EMULATOR_HOST;
  await assert.rejects(commitShipmentDelivery({projectId:'demo-yushin'},'actor',request()),/僅允許/);
 }finally{if(host!==undefined)process.env.FIRESTORE_EMULATOR_HOST=host;}
 assert.doesNotMatch(fs.readFileSync('functions/index.js','utf8'),/commitShipmentDelivery/);
});
