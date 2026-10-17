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
test('a scalar warehouse restoration cannot erase a pending multi-location reservation',()=>{
 const reservation={productKey:'P',locationSchemaVersion:2,quantity:3,locations:[{warehouseId:'W',reservedQty:1},{warehouseId:'OTHER',reservedQty:2}]};
 assert.throws(()=>plan({...base(),reservation}),/不能以單倉作業修改其他位置/);
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
