'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {orderTransferReservationSource:source}=require('../modules/reservation-core');
function fixture(){return {orderId:'O',itemId:'I',productKey:'P',warehouseId:'W',qty:3,item:{itemId:'I',reservedQty:3},reservation:{orderId:'O',itemId:'I',productKey:'P',quantity:3,shortageQty:0,warehouseId:'W'}};}
test('legacy whole-item transfer validates source and retains fractional quantities',()=>{const x=fixture(),before=structuredClone(x);assert.deepEqual(source(x),{schemaVersion:1,warehouseId:'W',qty:3});assert.deepEqual(x,before);x.qty=1.5;x.item.reservedQty=1.5;x.reservation.quantity=1.5;assert.equal(source(x).qty,1.5);});
test('v2 source resolves exactly one physical location without flattening its ledger',()=>{const x=fixture();delete x.reservation.warehouseId;Object.assign(x.reservation,{locationSchemaVersion:2,locations:[{warehouseId:'W',reservedQty:3}]});const before=structuredClone(x);assert.equal(source(x).schemaVersion,2);assert.deepEqual(x,before);x.reservation.locations=[{warehouseId:'W',reservedQty:1},{warehouseId:'OTHER',reservedQty:2}];assert.throws(()=>source(x),/多倉/);});
test('mixed schemas, corrupted quantities, mismatched identity and repeated handoff fail closed',()=>{for(const modify of [x=>x.reservation.orderId='OTHER',x=>x.reservation.productKey='OTHER',x=>x.reservation.shortageQty=1,x=>x.item.reservedQty=2,x=>x.item.custodyTransferId='prior',x=>x.item.transferPendingId='prior',x=>x.reservation.locations=[],x=>x.reservation.quantity='bad',x=>x.reservation.locationSchemaVersion=99]){const x=fixture();modify(x);assert.throws(()=>source(x));}});
test('legacy writer explicitly rejects v2 before performing its location update',()=>{const code=require('node:fs').readFileSync('src/services/warehouse-transfer.js','utf8');assert.ok(code.indexOf('if(source.schemaVersion===2)throw')<code.indexOf('tx.set(transferRef,saved)'));assert.match(code,/YushinReservation\.orderTransferReservationSource/);});

test('distributed v2 source planner returns all immutable warehouse legs in deterministic order',()=>{
 const x=fixture();delete x.reservation.warehouseId;
 Object.assign(x.reservation,{locationSchemaVersion:2,locations:[{warehouseId:'Z',reservedQty:1},{warehouseId:'A',reservedQty:2}]});
 const before=structuredClone(x);
 const {orderTransferReservationSources:resolve}=require('../modules/reservation-core');
 assert.deepEqual(resolve(x),{schemaVersion:2,qty:3,sources:[{warehouseId:'A',qty:2},{warehouseId:'Z',qty:1}]});
 assert.deepEqual(x,before);
 assert.throws(()=>source({...x,warehouseId:'A'}),/分散/);
});
test('multi-source transfer source rejects corrupted identities, custody, duplicate locations and partial holds',()=>{
 const {orderTransferReservationSources:resolve}=require('../modules/reservation-core');
 const valid=()=>{const x=fixture();delete x.reservation.warehouseId;
  Object.assign(x.reservation,{locationSchemaVersion:2,locations:[{warehouseId:'A',reservedQty:1},{warehouseId:'Z',reservedQty:2}]});return x;};
 for(const change of [
  x=>x.reservation.orderId='ANOTHER',x=>x.reservation.productKey='ANOTHER',
  x=>x.reservation.locations[1].warehouseId='A',x=>x.reservation.locations[0].warehouseId='custody-U',
  x=>x.reservation.locations[1].warehouseId='A/B',
  x=>x.reservation.locations[1].reservedQty=3,x=>x.reservation.shortageQty=1,
  x=>x.item.reservedQty=2,x=>x.item.transferPendingId='prior',x=>x.item.custodyTransferId='prior',
  x=>x.reservation.warehouseId='A',x=>x.reservation.locationSchemaVersion=99
 ]){const x=valid();change(x);assert.throws(()=>resolve(x));}
 const legacy=fixture();assert.deepEqual(resolve(legacy),{schemaVersion:1,qty:3,sources:[{warehouseId:'W',qty:3}]});
});
