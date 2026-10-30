const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../modules/reservation-core');
const plan=core.planReservationReturn;
const base=()=>({operation:'CUSTOMER_RETURN',deltaQty:2,orderStatus:'normal',settlement:'REPLACE',productKey:'P',warehouseId:'W',
 reservation:{productKey:'P',warehouseId:'W',quantity:3},itemReservedQty:3,
 aggregateStock:{productKey:'P',onHand:10,reserved:7},warehouseStock:{productKey:'P',warehouseId:'W',onHand:7,reserved:4}});
test('replacement return restores physical stock and only its own reservation',()=>{
 const input=base(),before=structuredClone(input),result=plan(input);
 assert.deepEqual(input,before);assert.equal(result.reservation.quantity,5);assert.equal(result.reservedDelta,2);
 assert.deepEqual(result.aggregateStock,{onHand:12,reserved:9});assert.deepEqual(result.warehouseStock,{onHand:9,reserved:6});
 assert.equal(result.aggregateStock.reserved-result.reservation.quantity,4);
});
test('closed return restores free physical stock while preserving remaining order holds',()=>{
 const result=plan({...base(),settlement:'CLOSE'});
 assert.equal(result.reservation.quantity,3);assert.equal(result.reservedDelta,0);
 assert.deepEqual(result.aggregateStock,{onHand:12,reserved:7});assert.deepEqual(result.warehouseStock,{onHand:9,reserved:4});
});
test('cancelled return and cancelled delivery reversal release residual own holds and never recreate a reservation',()=>{
 for(const operation of ['CUSTOMER_RETURN','SHIP_REVERSAL']){
  const result=plan({...base(),operation,orderStatus:'cancelled'});
  assert.equal(result.reservation.quantity,0);assert.equal(result.reservation.status,'released');assert.equal(result.reservedDelta,-3);
  assert.deepEqual(result.aggregateStock,{onHand:12,reserved:4});assert.deepEqual(result.warehouseStock,{onHand:9,reserved:1});
 }
});
test('normal delivery reversal restores held stock even when return settlement is CLOSE',()=>{
 const result=plan({...base(),operation:'SHIP_REVERSAL',settlement:'CLOSE'});
 assert.equal(result.reservation.quantity,5);assert.equal(result.reservedDelta,2);
});
test('replacement return correction removes its full physical and reserved quantity without clamping',()=>{
 const result=plan({...base(),deltaQty:-2});assert.equal(result.reservation.quantity,1);assert.equal(result.reservedDelta,-2);
 assert.deepEqual(result.aggregateStock,{onHand:8,reserved:5});assert.deepEqual(result.warehouseStock,{onHand:5,reserved:2});
 assert.throws(()=>plan({...base(),deltaQty:-4}),/數量不正確/);
});
test('closed return correction cannot consume another orders hold or stock travelling between warehouses',()=>{
 for(const key of ['aggregateStock','warehouseStock']){
  const input={...base(),settlement:'CLOSE',deltaQty:-2};input[key].onHand=input[key].reserved+1;
  assert.throws(()=>plan(input),/可用庫存不足/);
  input[key].onHand=input[key].reserved+3;input[key].transferFreeInTransit=2;
  assert.throws(()=>plan(input),/調撥途中量/);
 }
});
test('all stock accounts must be present consistent and sufficient before either restoration or release',()=>{
 for(const patch of [{aggregateStock:undefined},{warehouseStock:undefined},{itemReservedQty:2},
  {aggregateStock:{onHand:10,reserved:2}},{warehouseStock:{onHand:10,reserved:2}},
  {aggregateStock:{onHand:2,reserved:7}},{warehouseStock:{onHand:2,reserved:4}}])
  assert.throws(()=>plan({...base(),...patch}),/不足|異常|不一致|缺少/);
});
test('wrong product and warehouse cannot be silently reconciled during a return',()=>{
 for(const patch of [{productKey:''},{warehouseId:''},{reservation:{productKey:'Q',warehouseId:'W',quantity:3}},
  {reservation:{productKey:'P',warehouseId:'OTHER',quantity:3}},
  {aggregateStock:{productKey:'Q',onHand:10,reserved:7}},
  {warehouseStock:{productKey:'P',warehouseId:'OTHER',onHand:7,reserved:4}}])assert.throws(()=>plan({...base(),...patch}));
});
test('invalid raw quantities and operation flags cannot turn into a successful restoration',()=>{
 for(const value of [null,NaN,Infinity,-1,'bad','',true]){
  for(const key of ['aggregateStock','warehouseStock'])for(const field of ['onHand','reserved','transferFreeInTransit']){
   const input=base();input[key][field]=value;assert.throws(()=>plan(input));
  }
  const input=base();input.reservation.quantity=value;assert.throws(()=>plan(input));
 }
 for(const deltaQty of [null,NaN,Infinity,0,'',true,'bad'])assert.throws(()=>plan({...base(),deltaQty}));
 for(const patch of [{operation:'OTHER'},{orderStatus:'OTHER'},{settlement:'OTHER'},{operation:'SHIP_REVERSAL',deltaQty:-1}])assert.throws(()=>plan({...base(),...patch}));
});
test('fractional legacy values and empty zero-hold reservations preserve their original contract',()=>{
 const result=plan({...base(),deltaQty:'0.5'});assert.equal(result.reservation.quantity,3.5);assert.equal(result.aggregateStock.onHand,10.5);
 const empty=plan({...base(),itemReservedQty:0,reservation:{},deltaQty:1});
 assert.equal(empty.reservation.warehouseId,'W');assert.equal(empty.reservation.quantity,1);
});
test('v2 customer return restores its source hold without erasing a pending other-location reservation',()=>{
 const reservation={productKey:'P',locationSchemaVersion:2,quantity:3,shortageQty:0,locations:[{warehouseId:'W',reservedQty:1},{warehouseId:'OTHER',reservedQty:2}]};
 const before=structuredClone(reservation),result=plan({...base(),reservation});
 assert.deepEqual(reservation,before);assert.equal(result.reservation.quantity,5);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'OTHER',reservedQty:2},{warehouseId:'W',reservedQty:3}]);
 assert.equal(result.aggregateStock.reserved,9);assert.equal(result.warehouseStock.reserved,6);
 assert.throws(()=>plan({...base(),reservation,operation:'SHIP_REVERSAL'}),/不能以單倉作業修改其他位置/);
});
test('V3 custody customer return keeps original two-warehouse and transfer provenance',()=>{
 const original={productKey:'P',locationSchemaVersion:3,ownerUid:'OWNER',custodyTransferId:'HANDOFF',
  lifecycleWarehouseIds:['W','OTHER'],sourceLocationSnapshot:[{warehouseId:'W',reservedQty:1},{warehouseId:'OTHER',reservedQty:2}],
  custodyOriginalQty:3,quantity:2,shortageQty:0,status:'active',
  locations:[{warehouseId:'custody-OWNER',reservedQty:2}]};
 const source={...base(),warehouseId:'custody-OWNER',reservation:original,itemReservedQty:2,deltaQty:1,
  aggregateStock:{onHand:10,reserved:7},warehouseStock:{warehouseId:'custody-OWNER',onHand:7,reserved:4}};
 const replace=plan(source),closed=plan({...source,settlement:'CLOSE'});
 assert.equal(replace.reservation.locationSchemaVersion,3);assert.equal(replace.reservation.quantity,3);
 assert.deepEqual(replace.reservation.sourceLocationSnapshot,original.sourceLocationSnapshot);
 assert.equal(replace.reservation.custodyTransferId,'HANDOFF');
 assert.deepEqual(replace.reservation.locations,[{warehouseId:'custody-OWNER',reservedQty:3}]);
 assert.equal(core.reservationStockDeltas(original,replace.reservation).companyReservedDelta,1);
 assert.equal(closed.reservation.quantity,2);assert.deepEqual(closed.reservation.locations,original.locations);
 assert.throws(()=>plan({...source,deltaQty:2}),/原實體倉|不一致/);
});
test('restoration conserves own and unrelated holds across lifecycle settlement and direction combinations',()=>{
 for(const orderStatus of ['normal','cancelled'])for(const settlement of ['CLOSE','REPLACE'])
 for(const operation of ['CUSTOMER_RETURN','SHIP_REVERSAL'])for(const deltaQty of operation==='SHIP_REVERSAL'?[1,2]:[-2,-1,1,2]){
  const input={...base(),orderStatus,settlement,operation,deltaQty},result=plan(input);
  const diff=core.reservationStockDeltas(input.reservation,result.reservation);
  assert.equal(result.reservedDelta,diff.companyReservedDelta);
  assert.equal(result.aggregateStock.reserved-result.reservation.quantity,4);
  assert.equal(result.warehouseStock.reserved-result.reservation.quantity,1);
  assert.equal(result.aggregateStock.onHand-input.aggregateStock.onHand,deltaQty);
  assert.equal(result.warehouseStock.onHand-input.warehouseStock.onHand,deltaQty);
 }
});

test('cancelled v2 CLOSE receipt requires a fully released empty ledger and creates only free physical stock',()=>{
 const input={...base(),orderStatus:'cancelled',settlement:'CLOSE',itemReservedQty:0,
  reservation:{productKey:'P',locationSchemaVersion:2,quantity:0,shortageQty:0,status:'released',locations:[],lifecycleWarehouseIds:['W','OTHER']}};
 const before=structuredClone(input),result=plan(input);
 assert.deepEqual(input,before);assert.deepEqual(result.reservation,input.reservation);assert.equal(result.reservedDelta,0);
 assert.deepEqual(result.aggregateStock,{onHand:12,reserved:7});assert.deepEqual(result.warehouseStock,{onHand:9,reserved:4});
 for(const patch of [{settlement:'REPLACE'},{itemReservedQty:1},
  {reservation:{...input.reservation,status:'fulfilled'}},{reservation:{...input.reservation,shortageQty:1}},
  {reservation:{...input.reservation,quantity:1,locations:[{warehouseId:'OTHER',reservedQty:1}]}},
  {warehouseStock:{onHand:4,reserved:4,transferFreeInTransit:1}}])assert.throws(()=>plan({...input,...patch}));
});
