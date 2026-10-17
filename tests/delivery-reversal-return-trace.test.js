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
test('reversal and return trace cannot run outside the demo Emulator or expose public Callables',async()=>{
 await assert.rejects(reverseShipmentDelivery({projectId:'production'},'actor',reverse()),/僅允許/);
 await assert.rejects(planLocationReturnTrace({projectId:'production'},'actor',trace()),/僅允許/);
 const host=process.env.FIRESTORE_EMULATOR_HOST;
 try{delete process.env.FIRESTORE_EMULATOR_HOST;
  await assert.rejects(reverseShipmentDelivery({projectId:'demo-yushin'},'actor',reverse()),/僅允許/);
  await assert.rejects(planLocationReturnTrace({projectId:'demo-yushin'},'actor',trace()),/僅允許/);
 }finally{if(host!==undefined)process.env.FIRESTORE_EMULATOR_HOST=host;}
 assert.doesNotMatch(fs.readFileSync('functions/index.js','utf8'),/reverseShipmentDelivery|planLocationReturnTrace/);
});
