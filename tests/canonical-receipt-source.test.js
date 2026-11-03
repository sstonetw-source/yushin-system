'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validateCanonicalReceiptSource}=require('../functions/canonical-receipt-source');
const core=require('../functions/shared/procurement-demand-core');
function fixture(count=1){
 const records=new Map([['warehouses/W',{active:true}]]),reads=[];
 const order={status:'active',inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync-canonical-123',ownerUid:'owner',salesCode:'S',items:[]};
 for(let i=0;i<count;i++){
  const itemId='I'+i,productId='P'+i;
  const row={itemId,productId,inventoryProductKey:productId,warehouseId:'W',qty:3,orderedQty:3,reservedQty:0,shortageQty:3,supplyOrderedQty:3,receivedQty:0};
  order.items.push(row);
  records.set('products/'+productId,{active:true,productType:'Goods'});
  records.set('inventoryReservations/O__'+itemId,{orderId:'O',itemId,productKey:productId,warehouseId:'W',ownerUid:'owner',salesCode:'S',quantity:0,shortageQty:3,status:'shortage'});
  records.set('inventory/'+productId,{productKey:productId,productId,onHand:0,reserved:0,incoming:3});
  records.set('warehouseStocks/W__'+productId,{productKey:productId,productId,warehouseId:'W',onHand:0,reserved:0,incoming:3});
 }
 const demandId=core.demandIdForSource({sourceType:'SALES_ORDER',sourceId:'O',sourceItemId:'I0'});
 records.set('procurementDemands/'+encodeURIComponent(demandId),core.demandDocument(core.fromSalesOrder({...order.items[0],sourceId:'O',sourceItemId:'I0',productKey:'P0',ownerUid:'owner',salesCode:'S'})));
 const supply={orderId:'O',itemId:'I0',productId:'P0',productKey:'P0',warehouseId:'W',sourceType:'SALES_ORDER',sourceId:'O',sourceItemId:'I0',fulfillmentType:'WAREHOUSE',ownerUid:'owner',salesCode:'S',demandId,qty:3,receivedQty:0,incomingRegisteredQty:3};
 const db={collection:name=>({doc:id=>({path:name+'/'+id})})};
 const get=async ref=>{reads.push(ref.path);return {exists:records.has(ref.path),data:()=>records.get(ref.path)};};
 const input={db,get,uid:'buyer',actor:{role:'purchaser',active:true},order,supply,qty:1,reservation:records.get('inventoryReservations/O__I0')};
 return {records,reads,input,check:()=>validateCanonicalReceiptSource(input)};
}
test('current canonical single-warehouse source supports one to five lines without mutating its ledger',async()=>{
 for(const n of [1,5]){const f=fixture(n),before=structuredClone(f.records);await f.check();assert.deepEqual(f.records,before);assert.ok(f.reads.length<40);}
 await assert.rejects(fixture(6).check(),{code:'failed-precondition'});
});
test('canonical receipt admission rejects source, ledger, master, incoming and demand corruption',async()=>{
 const mutations=[
  f=>f.input.order.status='cancelled',
  f=>f.input.order.orderStatus='voided',
  f=>f.input.order.inventoryReservationStatus='pending',
  f=>f.input.order.items[0].dispatchPreparedQty=1,
  f=>f.input.order.deliveryHistory=[{action:'add'}],
  f=>f.input.order.items[0].transferPendingId='T',
  f=>f.input.reservation.locationSchemaVersion=2,
  f=>f.input.reservation.locations=[],
  f=>f.input.reservation.ownerUid='other',
  f=>f.input.reservation.quantity=1,
  f=>f.records.get('warehouses/W').systemCustody=true,
  f=>f.records.get('products/P0').productType='Service',
  f=>f.records.delete('inventory/P0'),
  f=>f.records.get('warehouseStocks/W__P0').reserved=1,
  f=>f.records.get('inventory/P0').incoming=1.5,
  f=>f.input.supply.incomingRegisteredQty=2,
  f=>f.input.supply.qty=4,
  f=>f.records.get('procurementDemands/SALES_ORDER%3AO%3AI0').receivedQty=1
 ];
 for(const mutate of mutations){const f=fixture();mutate(f);const before=structuredClone(f.records);await assert.rejects(f.check(),{code:'failed-precondition'});assert.deepEqual(f.records,before);}
});
test('canonical receipt validates combined sibling holds instead of acknowledging double-held stock',async()=>{
 const f=fixture(2),row=f.input.order.items[1];
 Object.assign(row,{productId:'P0',inventoryProductKey:'P0',reservedQty:1,shortageQty:2,supplyOrderedQty:2});
 Object.assign(f.records.get('inventoryReservations/O__I1'),{productKey:'P0',quantity:1,shortageQty:2,status:'active'});
 Object.assign(f.input.order.items[0],{reservedQty:1,shortageQty:2,supplyOrderedQty:2});
 Object.assign(f.input.reservation,{quantity:1,shortageQty:2,status:'active'});
 Object.assign(f.input.supply,{qty:2,incomingRegisteredQty:2});
 Object.assign(f.records.get('inventory/P0'),{onHand:2,reserved:1,incoming:2});
 Object.assign(f.records.get('warehouseStocks/W__P0'),{onHand:2,reserved:1,incoming:2});
 await assert.rejects(f.check(),{code:'failed-precondition'});
});
test('receipt replay preserves terminal lifecycle semantics but still rejects a relinked or unknown ledger',async()=>{
 const f=fixture();f.input.replay=true;f.input.order.status='cancelled';await f.check();
 f.input.reservation.locations=[];
 await assert.rejects(f.check(),{code:'failed-precondition'});
});
