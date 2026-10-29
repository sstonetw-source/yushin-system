'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const inventory=require('../modules/inventory-core');
const {normalizeDeliveryReversalIntent,reverseShipmentDelivery}=require('../functions/shipment-delivery-service');
const {normalizeReturnTraceIntent,planLocationReturnTrace}=require('../functions/location-return-trace-service');
const reverse=(patch={})=>({orderId:'O',itemId:'I',deliveryRecordId:'delivery_12345',operationId:'reverse_12345',
 syncAttemptId:'sync_12345',date:'2026-10-19',reason:'誤登送達',...patch});
const trace=(patch={})=>({orderId:'O',itemId:'I',shipmentId:'shipment_12345',syncAttemptId:'sync_12345',selections:[{lotId:'L1',qty:1}],...patch});
test('reversal binds original delivery record, date, reason and source to its own immutable operation ID',()=>{
 const first=normalizeDeliveryReversalIntent(reverse());
 for(const patch of [{deliveryRecordId:'other'},{operationId:'reverse_67890'},{date:'2026-10-20'},
  {reason:'不同原因'},{syncAttemptId:'new-sync'}])assert.notEqual(normalizeDeliveryReversalIntent(reverse(patch)).hash,first.hash);
 assert.equal(normalizeDeliveryReversalIntent(reverse({reason:' 誤登送達 '})).hash,first.hash);
 for(const patch of [{reason:''},{reason:[]},{quantity:1},{actorRole:'admin'},{date:'2026-02-30'},
  {operationId:'bad'},{deliveryRecordId:'A/B'}])assert.throws(()=>normalizeDeliveryReversalIntent(reverse(patch)));
});
test('return trace requires explicit distinct lots and rejects inferred balances, prices or actor claims',()=>{
 assert.deepEqual(normalizeReturnTraceIntent(trace()).selections,[{lotId:'L1',qty:1}]);
 for(const patch of [{selections:[]},{selections:[{lotId:'L1',qty:1},{lotId:'L1',qty:1}]},
  {selections:[{lotId:'L1',qty:'1'}]},{selections:[{lotId:'L1',qty:1,unitCost:5}]},
  {selections:[{lotId:'A/B',qty:1}]},{warehouseId:'B'},{actorRole:'admin'},{onHand:99}])
  assert.throws(()=>normalizeReturnTraceIntent(trace(patch)));
});
const source=()=>({qty:4,lotAllocations:[{lotId:'L1',qty:2,lotNo:'early',expiryDate:'2027-01-01',unitCost:98765},
 {lotId:'L2',qty:2,lotNo:'late',expiryDate:'2028-01-01',unitCost:98765}]});
test('explicit selection tracks the stated original batches without guessing which mixed-parcel lot arrived',()=>{
 const shipment=source(),before=structuredClone(shipment);
 const plan=inventory.planExplicitShipmentReturn({shipment,confirmedQty:2,selections:[{lotId:'L2',qty:1},{lotId:'L1',qty:1}]});
 assert.deepEqual(shipment,before);assert.equal(plan.returnQty,2);
 assert.deepEqual(plan.allocations.map(a=>[a.lotId,a.lotNo,a.qty,a.cost]),[['L2','late',1,0],['L1','early',1,0]]);
 assert.equal(JSON.stringify(plan).includes('98765'),false);
 assert.throws(()=>inventory.planExplicitShipmentReturn({shipment,confirmedQty:1,selections:[]}),/明細/);
});
test('return plan cannot exceed a source lot or the selected shipments confirmed delivery quantity',()=>{
 for(const patch of [{confirmedQty:0},{confirmedQty:5},{confirmedQty:'2'},
  {selections:[{lotId:'unknown',qty:1}]},{selections:[{lotId:'L1',qty:3}]},
  {selections:[{lotId:'L1',qty:1},{lotId:'L1',qty:1}]},{selections:[{lotId:'L1',qty:1.5}]},
  {shipment:{...source(),qty:5}},
  {shipment:{qty:4,lotAllocations:[{lotId:'L1',qty:2},{lotId:'L1',qty:2}]}}
 ])assert.throws(()=>inventory.planExplicitShipmentReturn({shipment:source(),confirmedQty:2,selections:[{lotId:'L1',qty:1}],...patch}));
});
test('reversal and return trace reject unauthorized environments; return trace stays internal',async()=>{
 await assert.rejects(reverseShipmentDelivery({projectId:'production'},'actor',reverse()),/未獲專案授權/);
 await assert.rejects(planLocationReturnTrace({projectId:'production'},'actor',trace()),/僅允許/);
 const host=process.env.FIRESTORE_EMULATOR_HOST;
 try{delete process.env.FIRESTORE_EMULATOR_HOST;
  await assert.rejects(reverseShipmentDelivery({projectId:'demo-yushin'},'actor',reverse()),/未獲專案授權/);
  await assert.rejects(planLocationReturnTrace({projectId:'demo-yushin'},'actor',trace()),/僅允許/);
 }finally{if(host!==undefined)process.env.FIRESTORE_EMULATOR_HOST=host;}
 const index=fs.readFileSync('functions/index.js','utf8');
 assert.match(index,/exports\.reverseV2ShipmentDelivery\s*=\s*createDeliveryReversalCallable/);
 assert.doesNotMatch(index,/exports\.planLocationReturnTrace/);
});

test('return allowance exposes confirmed and previously returned quantities without leaking costs or inferring a delivered lot',()=>{
 const result=inventory.planExplicitShipmentReturn({shipment:source(),confirmedQty:2,
  priorReturns:[{qty:1,lotAllocations:[{lotId:'L1',qty:1}]}],selections:[{lotId:'L2',qty:1}]});
 assert.equal(result.confirmedQty,2);assert.equal(result.previousReturnedQty,1);assert.equal(result.remainingReturnQty,1);
 assert.deepEqual(result.remainingLotAllocations.map(a=>[a.lotId,a.remainingQty]),[['L1',1],['L2',2]]);
 assert.equal(JSON.stringify(result).includes('98765'),false);
 assert.throws(()=>inventory.planExplicitShipmentReturn({shipment:source(),confirmedQty:2,
  priorReturns:[{qty:1,lotAllocations:[{lotId:'L1',qty:1}]}],selections:[{lotId:'L2',qty:2}]}),/超過/);
});

test('multi-line cancelled return context requires both explicit return flags and refuses mixed or ambiguous sources',()=>{
 const {shipmentDeliveryContext}=require('../functions/shipment-delivery-service');
 const order={ownerUid:'U',salesCode:'S',status:'active',inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync',
  items:[{itemId:'I1',productId:'P',qty:2},{itemId:'I2',productId:'Q',qty:3}],
  warehouseShipmentRecords:[],deliveryRecords:[],returnRecords:[]};
 const intent={orderId:'O',itemId:'I2',syncAttemptId:'sync'};
 assert.throws(()=>shipmentDeliveryContext(order,intent,{allowReturns:true}),/單品項/);
 const context=shipmentDeliveryContext(order,intent,{allowReturns:true,allowMultiReturn:true});
 assert.equal(context.item.itemId,'I2');assert.equal(context.productKey,'Q');assert.equal(context.whole.orderedQty,5);
 assert.equal(context.projection.outstandingQty,3);assert.equal(context.cancelled,false);
 const cancelled={...order,status:'cancelled',orderStatus:'cancelled'};
 assert.throws(()=>shipmentDeliveryContext(cancelled,intent,{allowReturns:true,allowMultiReturn:true}),/取消/);
 assert.throws(()=>shipmentDeliveryContext(cancelled,intent,{allowMultiReturn:true,allowCancelledCloseReturn:true}),/取消/);
 assert.equal(shipmentDeliveryContext(cancelled,intent,{allowReturns:true,allowMultiReturn:true,allowCancelledCloseReturn:true}).cancelled,true);
 for(const patch of [{status:'cancelled',orderStatus:'normal'},{items:[order.items[0],order.items[0]]},
  {items:[order.items[0],{...order.items[1],fulfillmentType:'DIRECT_SHIP'}]},{deliveredQty:1}])
  assert.throws(()=>shipmentDeliveryContext({...order,...patch},intent,{allowReturns:true,allowMultiReturn:true,allowCancelledCloseReturn:true}));
});
