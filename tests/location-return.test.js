'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const inventory=require('../modules/inventory-core'),reservation=require('../modules/reservation-core'),core=require('../modules/fulfillment-core');
const {normalizeLocationReturnIntent,planLocationReturnRequest,commitLocationReturn}=require('../functions/location-return-service');
const request=(patch={})=>({orderId:'O',itemId:'I',shipmentId:'shipment_12345',syncAttemptId:'sync_12345',
 selections:[{lotId:'L',qty:1}],operationId:'return_123456',warehouseId:'A',date:'2026-10-19',reason:'客戶退回',
 condition:'RESTOCKABLE',settlement:'REPLACE',...patch});
test('physical return intent binds quality, source warehouse, settlement and explicit batches without trusting actor or prices',()=>{
 const first=normalizeLocationReturnIntent(request());
 for(const patch of [{settlement:'CLOSE'},{warehouseId:'B'},{date:'2026-10-20'},{reason:'另一原因'},
  {selections:[{lotId:'L',qty:2}]}])assert.notEqual(normalizeLocationReturnIntent(request(patch)).hash,first.hash);
 const rows=[{lotId:'Z',qty:1},{lotId:'A',qty:1}];
 assert.equal(normalizeLocationReturnIntent(request({selections:rows})).hash,
  normalizeLocationReturnIntent(request({selections:[...rows].reverse()})).hash);
 for(const patch of [{condition:'DAMAGED'},{condition:undefined},{settlement:'OTHER'},{reason:''},{date:'2026-02-30'},
  {actorRole:'admin'},{onHand:100},{warehouseId:'A/B'},{operationId:'bad'}])assert.throws(()=>normalizeLocationReturnIntent(request(patch)));
});
test('explicit return allowances subtract previous receipts per batch and per source delivery',()=>{
 const shipment={qty:4,lotAllocations:[{lotId:'L',qty:2},{lotId:'M',qty:2}]};
 const priorReturns=[{qty:1,lotAllocations:[{lotId:'L',qty:1}]}];
 assert.equal(inventory.planExplicitShipmentReturn({shipment,confirmedQty:2,priorReturns,selections:[{lotId:'M',qty:1}]}).returnQty,1);
 for(const selections of [[{lotId:'L',qty:2}],[{lotId:'M',qty:2}]])
  assert.throws(()=>inventory.planExplicitShipmentReturn({shipment,confirmedQty:2,priorReturns,selections}));
 assert.throws(()=>inventory.planExplicitShipmentReturn({shipment,confirmedQty:4,
  priorReturns:[{qty:2,lotAllocations:[{lotId:'L',qty:1}]}],selections:[{lotId:'M',qty:1}]}));
});
const source=()=>({orderId:'O',itemId:'I',productKey:'P',orderedQty:4,
 shipments:[{id:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-17',qty:4,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}],
 deliveries:[{id:'D',orderId:'O',itemId:'I',productKey:'P',shipmentId:'S',warehouseId:'A',date:'2026-10-18',qty:4,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}]});
const returned=(patch={})=>({id:'R',orderId:'O',itemId:'I',productKey:'P',shipmentId:'S',warehouseId:'A',date:'2026-10-19',qty:2,
 sourceType:'WAREHOUSE_CUSTOMER_RETURN',condition:'RESTOCKABLE',settlement:'REPLACE',...patch});
test('return projection preserves historical delivery while distinguishing replacement demand from closed quantity',()=>{
 const replacement=core.projectShipmentReturns({...source(),returns:[returned()]});
 assert.equal(replacement.confirmedQty,4);assert.equal(replacement.shippedQty,4);assert.equal(replacement.returnedQty,2);
 assert.equal(replacement.effectiveDeliveredQty,2);assert.equal(replacement.outstandingQty,2);assert.equal(replacement.isDelivered,false);
 const closed=core.projectShipmentReturns({...source(),returns:[returned({settlement:'CLOSE'})]});
 assert.equal(closed.effectiveDeliveredQty,4);assert.equal(closed.outstandingQty,0);assert.equal(closed.isDelivered,true);
 for(const patch of [{qty:5},{warehouseId:'B'},{shipmentId:'unknown'},{date:'2026-10-17'},{condition:'DAMAGED'},{settlement:'OTHER'}])
  assert.throws(()=>core.projectShipmentReturns({...source(),returns:[returned(patch)]}));
 assert.throws(()=>core.projectShipmentReturns({...source(),returns:[returned(),returned()]}));
});
test('v2 return adds source location to a ledger with only other warehouse holds and preserves shortage',()=>{
 const input={operation:'CUSTOMER_RETURN',deltaQty:2,settlement:'REPLACE',productKey:'P',warehouseId:'A',itemReservedQty:3,
  reservation:{locationSchemaVersion:2,productKey:'P',quantity:3,shortageQty:1,locations:[{warehouseId:'B',reservedQty:3}]},
  aggregateStock:{onHand:10,reserved:5,transferFreeInTransit:1},warehouseStock:{onHand:2,reserved:1,transferFreeInTransit:0}};
 const result=reservation.planReservationReturn(input);assert.equal(result.reservation.quantity,5);assert.equal(result.reservation.shortageQty,1);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:2},{warehouseId:'B',reservedQty:3}]);
 const closed=reservation.planReservationReturn({...input,settlement:'CLOSE'});assert.deepEqual(closed.reservation.locations,input.reservation.locations);
 for(const patch of [{deltaQty:1.5},{itemReservedQty:2},{aggregateStock:{onHand:5,reserved:6}},
  {warehouseStock:{onHand:1,reserved:1,transferFreeInTransit:1}}])assert.throws(()=>reservation.planReservationReturn({...input,...patch}));
});
test('physical return is unavailable outside demo Emulator and has no Callable export',async()=>{
 await assert.rejects(commitLocationReturn({projectId:'production'},'actor',request()),/僅允許/);
 const host=process.env.FIRESTORE_EMULATOR_HOST;
 try{delete process.env.FIRESTORE_EMULATOR_HOST;await assert.rejects(commitLocationReturn({projectId:'demo-yushin'},'actor',request()),/僅允許/);}
 finally{if(host!==undefined)process.env.FIRESTORE_EMULATOR_HOST=host;}
 assert.doesNotMatch(fs.readFileSync('functions/index.js','utf8'),/commitLocationReturn/);
});
test('unspecified new return settlement defaults to CLOSE while explicit historical replacement remains bound',()=>{
 const closed=normalizeLocationReturnIntent(request({settlement:undefined}));assert.equal(closed.settlement,'CLOSE');
 assert.equal(closed.hash,normalizeLocationReturnIntent(request({settlement:'CLOSE'})).hash);
 assert.notEqual(closed.hash,normalizeLocationReturnIntent(request({settlement:'REPLACE'})).hash);
});

test('return timeline permits later acknowledgement of the same shipment without borrowing future delivery',()=>{
 const base=source();
 base.deliveries=[{...base.deliveries[0],qty:2},
  {...base.deliveries[0],id:'D-later',date:'2026-10-21',qty:2}];
 const valid=core.projectShipmentReturns({...base,returns:[returned({qty:1,settlement:'CLOSE'})]});
 assert.equal(valid.confirmedQty,4);assert.equal(valid.returnedQty,1);assert.equal(valid.isDelivered,true);
 assert.throws(()=>core.projectShipmentReturns({...base,returns:[returned({qty:3})]}),/當時已送達量/);
});
test('chronological return allowance is independent of cache order and aggregates same-day returns',()=>{
 const base=source();
 base.deliveries=[{...base.deliveries[0],qty:2},
  {...base.deliveries[0],id:'D-later',date:'2026-10-21',qty:2}];
 const early=returned({qty:2,settlement:'CLOSE'});
 const later=returned({id:'R-later',qty:1,date:'2026-10-22',settlement:'CLOSE'});
 const first=core.projectShipmentReturns({...base,returns:[early,later]});
 assert.deepEqual(core.projectShipmentReturns({...base,returns:[later,early]}),first);
 assert.throws(()=>core.projectShipmentReturns({...base,returns:[early,returned({id:'R-same-day',qty:1})]}),/當時已送達量/);
 assert.throws(()=>core.projectShipmentReturns({...base,returns:[later,returned({qty:3})]}),/當時已送達量/);
});

test('shared return intent keeps the historical SHA-256 serialization in browser and server',async()=>{
 const {createHash,webcrypto}=require('node:crypto');
 const intent=core.normalizeLocationReturnIntent(request());
 // Golden hash computed from main before extracting the pure normalizer.
 const original={hash:'6fb12a52804365d440c1155419081f5dd9c913e6371568b8b7a9b621e125093d'};
 assert.equal(createHash('sha256').update(JSON.stringify(intent)).digest('hex'),original.hash);
 const digest=await webcrypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(intent)));
 assert.equal(Buffer.from(digest).toString('hex'),original.hash);
 assert.equal(normalizeLocationReturnIntent(request()).hash,original.hash);
});

test('request-linked receipt binds request ID to the original hash and rejects replacement or ambiguous links',()=>{
 const original=normalizeLocationReturnIntent(request({settlement:'CLOSE'}));
 const linked=normalizeLocationReturnIntent(request({settlement:'CLOSE',requestId:'REQUEST'}));
 assert.notEqual(linked.hash,original.hash);
 assert.notEqual(normalizeLocationReturnIntent(request({settlement:'CLOSE',requestId:'OTHER'})).hash,linked.hash);
 for(const requestId of [undefined,null,'',' REQUEST','R/Q',1])
  assert.throws(()=>normalizeLocationReturnIntent(request({settlement:'CLOSE',requestId})));
 assert.throws(()=>normalizeLocationReturnIntent(request({requestId:'REQUEST'})),/CLOSE/);
});
const pendingRequest=(patch={})=>({id:'REQUEST',itemId:'I',qty:2,receivedQty:0,status:'PENDING',settlement:'CLOSE',...patch});
const requestOrder=()=>({returnRequests:[pendingRequest()],returnPending:true,returnRecords:[]});
test('request receipt projection preserves request intent and history while partially then fully receiving',()=>{
 const order=requestOrder(),intent={itemId:'I',requestId:'REQUEST'};
 const first=planLocationReturnRequest(order,intent,1);
 assert.equal(first.requests[0].receivedQty,1);assert.equal(first.requests[0].status,'PENDING');assert.equal(first.returnPending,true);
 assert.equal(order.returnRequests[0].receivedQty,0);
 const final=planLocationReturnRequest({...order,returnRequests:first.requests,
  returnRecords:[{requestId:'REQUEST',itemId:'I',qty:1,settlement:'CLOSE'}]},intent,1);
 assert.deepEqual(final.requests[0],pendingRequest({receivedQty:2,status:'RECEIVED'}));assert.equal(final.returnPending,false);
 assert.throws(()=>planLocationReturnRequest(order,{itemId:'I'},1),/原申請/);
 assert.equal(planLocationReturnRequest({returnRequests:[pendingRequest({itemId:'OTHER'})]}, {itemId:'I'},1),null);
});
test('request receipt rejects stale flags counters states mismatched items and corrupted received history',()=>{
 const intent={itemId:'I',requestId:'REQUEST'},order=requestOrder();
 for(const patch of [{returnPending:false},{returnRequests:{}},{returnRequests:[pendingRequest(),pendingRequest()]},
  {returnRequests:[pendingRequest({status:'CANCELLED'})],returnPending:false},
  {returnRequests:[pendingRequest({itemId:'OTHER'})]},
  {returnRequests:[pendingRequest({status:'RECEIVED',receivedQty:2})],returnPending:false},
  {returnRequests:[pendingRequest({receivedQty:1})]},
  {returnRequests:[pendingRequest({qty:2.5})]},
  {returnRecords:[{requestId:'REQUEST',itemId:'I',qty:1,settlement:'CLOSE'}]}])
  assert.throws(()=>planLocationReturnRequest({...order,...patch},intent,1));
 for(const amount of [0,-1,1.5,3,NaN])assert.throws(()=>planLocationReturnRequest(order,intent,amount));
 const valid={...order,returnRequests:[pendingRequest(),pendingRequest({id:'ANOTHER',itemId:'OTHER'})]};
 assert.equal(planLocationReturnRequest(valid,intent,2).returnPending,true);
});
test('shared return proof reconstructs linked intent and detects request-link tampering',async()=>{
 const data=request({settlement:'CLOSE',requestId:'REQUEST'}),{hash,...intent}=normalizeLocationReturnIntent(data);
 const record={...returned({id:data.operationId,shipmentId:data.shipmentId,qty:1,settlement:'CLOSE'}),
  requestId:data.requestId,warehouseId:data.warehouseId,date:data.date,reason:data.reason,
  lotAllocations:[{lotId:'L',qty:1}],movementId:'location-return-'+data.operationId,intentHash:hash};
 const proof={id:record.movementId,data:{action:'location_customer_return',type:'return',qty:1,
  sourceId:'O',itemId:'I',productKey:'P',warehouseId:'A',intentHash:hash,returnRecord:record}};
 const hashIntent=value=>require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
 assert.equal(await core.validateLocationReturnProofs({returnRecords:[record]},intent,'P',[proof],{hashIntent}),true);
 const tampered={...record,requestId:'OTHER'};
 await assert.rejects(core.validateLocationReturnProofs({returnRecords:[tampered]},intent,'P',
  [{...proof,data:{...proof.data,returnRecord:tampered}}],{hashIntent}),/憑證/);
});

test('multi-item return receipt settles only the linked item and preserves other pending requests',()=>{
 const first=pendingRequest({id:'R-A',itemId:'I1',qty:2});
 const second=pendingRequest({id:'R-B',itemId:'I2',qty:3});
 const third=pendingRequest({id:'R-C',itemId:'I3',qty:1});
 const order={returnRequests:[first,second,third],returnPending:true,returnRecords:[]};
 const receipt=planLocationReturnRequest(order,{itemId:'I2',requestId:'R-B'},2);
 assert.equal(receipt.requests.length,3);
 assert.deepEqual(receipt.requests[0],first);
 assert.deepEqual(receipt.requests[2],third);
 assert.equal(receipt.requests[1].receivedQty,2);
 assert.equal(receipt.requests[1].status,'PENDING');
 assert.equal(receipt.returnPending,true);
 assert.deepEqual(order.returnRequests,[first,second,third]);
 const after={...order,returnRequests:receipt.requests,returnRecords:[{requestId:'R-B',itemId:'I2',qty:2,settlement:'CLOSE'}]};
 const complete=planLocationReturnRequest(after,{itemId:'I2',requestId:'R-B'},1);
 assert.equal(complete.requests[1].status,'RECEIVED');
 assert.equal(complete.requests[1].receivedQty,3);
 assert.deepEqual(complete.requests[0],first);
 assert.deepEqual(complete.requests[2],third);
 assert.equal(complete.returnPending,true);
 assert.throws(()=>planLocationReturnRequest(after,{itemId:'I1',requestId:'R-B'},1));
});
