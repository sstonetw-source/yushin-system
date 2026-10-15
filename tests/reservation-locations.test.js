const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const {planLocationReservation:plan,reservationLocations,planMultiWarehouseReservation:preview}=require('../modules/reservation-core');

function input(patch={}){
 return {productKey:'P',requestedQty:10,currentWarehouseId:'A',
  warehouses:[{id:'A',isDefault:true},{id:'B'}],
  stocks:{A:{productKey:'P',warehouseId:'A',onHand:4,reserved:0},B:{productKey:'P',warehouseId:'B',onHand:8,reserved:0}},
  aggregateStock:{productKey:'P',onHand:12,reserved:0},reservation:{},...patch};
}
function apply(source,result){
 const next=structuredClone(source);
 next.aggregateStock.reserved+=result.companyReservedDelta;
 for(const row of result.warehouseDeltas)next.stocks[row.warehouseId].reserved+=row.reservedDelta;
 next.reservation={productKey:'P',...result.reservation};return next;
}
test('location proposal holds exact per-warehouse quantities and preserves physical stock',()=>{
 const source=input(),before=structuredClone(source),result=plan(source);
 assert.deepEqual(result,{reservation:{locationSchemaVersion:2,locations:[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:6}],quantity:10,shortageQty:0,status:'active'},
  warehouseDeltas:[{warehouseId:'A',reservedDelta:4},{warehouseId:'B',reservedDelta:6}],companyReservedDelta:10,remainingToOrderQty:0});
 assert.deepEqual(source,before);
 const next=apply(source,result);assert.equal(next.aggregateStock.onHand,12);assert.equal(next.stocks.A.onHand,4);
});
test('committed location proposal retries with zero deltas',()=>{
 const source=input(),next=apply(source,plan(source)),retry=plan(next);
 assert.equal(retry.companyReservedDelta,0);assert.deepEqual(retry.warehouseDeltas,[]);
 const {productKey,...saved}=next.reservation;assert.deepEqual(retry.reservation,saved);
});
test('existing legacy hold becomes one location without reserving it twice',()=>{
 const source=input({requestedQty:4,reservation:{productKey:'P',warehouseId:'A',quantity:4}});
 source.stocks.A.reserved=4;source.aggregateStock.reserved=4;
 const result=plan(source);assert.equal(result.companyReservedDelta,0);assert.deepEqual(result.warehouseDeltas,[]);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:4}]);
});
test('legacy shortage without a warehouse is an empty location ledger',()=>{
 assert.deepEqual(reservationLocations({quantity:0,warehouseId:''}),[]);
 assert.deepEqual(reservationLocations({}),[]);
});
test('partial existing hold remains at its source while the other warehouse covers the rest',()=>{
 const source=input({reservation:{warehouseId:'B',quantity:2}});source.stocks.B.reserved=2;source.aggregateStock.reserved=2;
 const result=plan(source);
 assert.deepEqual(result.reservation.locations,[{warehouseId:'A',reservedQty:4},{warehouseId:'B',reservedQty:6}]);
 assert.deepEqual(result.warehouseDeltas,[{warehouseId:'A',reservedDelta:4},{warehouseId:'B',reservedDelta:4}]);
});
test('shrinking releases only this item and keeps other orders reserved',()=>{
 const next=apply(input(),plan(input()));next.requestedQty=3;
 next.stocks.B.reserved+=1;next.aggregateStock.reserved+=1;
 const result=plan(next),after=apply(next,result);
 assert.equal(result.companyReservedDelta,-7);assert.equal(after.stocks.A.reserved,3);assert.equal(after.stocks.B.reserved,1);
 assert.equal(after.aggregateStock.reserved,4);assert.equal(result.remainingToOrderQty,0);
});
test('cancellation target zero releases all locations without changing onHand',()=>{
 const next=apply(input(),plan(input()));next.requestedQty=0;
 const result=plan(next),after=apply(next,result);
 assert.deepEqual(result.reservation.locations,[]);assert.equal(result.companyReservedDelta,-10);
 assert.equal(after.aggregateStock.reserved,0);assert.equal(after.aggregateStock.onHand,12);
 assert.equal(after.stocks.A.reserved,0);assert.equal(after.stocks.B.reserved,0);
});
test('supplier commitments do not reserve the same shortage a second time',()=>{
 const result=plan(input({inTransitQty:7}));
 assert.equal(result.reservation.quantity,3);assert.equal(result.reservation.shortageQty,7);assert.equal(result.remainingToOrderQty,0);
 const shortage=plan(input({requestedQty:20,inTransitQty:3}));
 assert.equal(shortage.reservation.quantity,12);assert.equal(shortage.reservation.shortageQty,8);assert.equal(shortage.remainingToOrderQty,5);
});
test('historical supplier overcommit does not silently release valid physical holds',()=>{
 const next=apply(input(),plan(input()));next.inTransitQty=12;
 const result=plan(next);assert.equal(result.reservation.quantity,10);assert.equal(result.companyReservedDelta,0);
});
test('company free stock limits allocation even when warehouse totals disagree',()=>{
 const source=input();source.aggregateStock.onHand=7;source.aggregateStock.reserved=3;
 const result=plan(source);assert.equal(result.reservation.quantity,4);assert.equal(result.remainingToOrderQty,6);
});
test('stock travelling between warehouses is excluded from the company ceiling',()=>{
 const source=input();source.aggregateStock.transferFreeInTransit=9;
 assert.equal(plan(source).reservation.quantity,3);
 assert.equal(preview(source).allocatedQty,3);
});
test('two orders consuming the same snapshots must recalculate against committed stock',()=>{
 const first=input({requestedQty:9}),after=apply(first,plan(first));
 const second={...after,reservation:{},requestedQty:9};
 const result=plan(second);assert.equal(result.reservation.quantity,3);assert.equal(result.remainingToOrderQty,6);
 assert.equal(apply(second,result).aggregateStock.reserved,12);
});
test('current warehouse then default then stable id determines additions regardless of master order',()=>{
 const source=input({requestedQty:2,currentWarehouseId:'B'});
 assert.deepEqual(plan(source).reservation.locations,[{warehouseId:'B',reservedQty:2}]);
 source.warehouses.reverse();assert.deepEqual(plan(source).reservation.locations,[{warehouseId:'B',reservedQty:2}]);
});
test('disabled location can release its existing holds but gets no additional stock',()=>{
 const source=input({requestedQty:6,reservation:{warehouseId:'A',quantity:2}});
 source.warehouses[0].active=false;source.stocks.A.reserved=2;source.aggregateStock.reserved=2;
 assert.deepEqual(plan(source).reservation.locations,[{warehouseId:'A',reservedQty:2},{warehouseId:'B',reservedQty:4}]);
 source.requestedQty=0;assert.deepEqual(plan(source).warehouseDeltas,[{warehouseId:'A',reservedDelta:-2}]);
});
test('disabled, typed custody, system custody and custody-prefixed locations cannot supply new holds',()=>{
 for(const change of [{active:false},{warehouseType:'CUSTODY'},{systemCustody:true},{id:'custody-X'}]){
  const source=input();source.warehouses=source.warehouses.map(w=>({...w,...change}));
  if(change.id)source.warehouses=[source.warehouses[0]];
  assert.equal(plan(source).reservation.quantity,0);
 }
});
test('custody holds are rejected so the physical planner cannot erase delivery responsibility',()=>{
 for(const change of [{warehouseType:'CUSTODY'},{systemCustody:true}]){
  const source=input({reservation:{warehouseId:'A',quantity:2}});Object.assign(source.warehouses[0],change);
  source.stocks.A.reserved=2;source.aggregateStock.reserved=2;
  assert.throws(()=>plan(source),/業務保管/);
 }
});
test('missing or insufficient original stock fails before proposing releases',()=>{
 for(const mutate of [s=>delete s.stocks.A,s=>s.stocks.A.reserved=1,s=>s.stocks.A.onHand=1,s=>s.warehouses.shift(),s=>s.aggregateStock.reserved=1]){
  const source=input({requestedQty:0,reservation:{warehouseId:'A',quantity:2}});
  source.stocks.A.reserved=2;source.aggregateStock.reserved=2;mutate(source);
  assert.throws(()=>plan(source),/稽核|位置缺失/);
 }
});
test('cross-product and cross-warehouse stock identities fail closed',()=>{
 for(const mutate of [s=>s.reservation.productKey='Q',s=>s.aggregateStock.productKey='Q',s=>s.stocks.B.productKey='Q',s=>s.stocks.A.warehouseId='B']){
  const source=input();mutate(source);assert.throws(()=>plan(source),/不一致/);
 }
});
test('missing company stock cannot be interpreted as unlimited company availability',()=>{
 assert.throws(()=>plan(input({aggregateStock:undefined})),/缺少/);
 assert.throws(()=>plan(input({productKey:''})),/缺少/);
});
test('unknown versions and unversioned location arrays never fall back to legacy',()=>{
 for(const reservation of [{locationSchemaVersion:3,quantity:0,locations:[]},{quantity:0,locations:[]},{locationSchemaVersion:2,quantity:0}])
  assert.throws(()=>reservationLocations(reservation),/版本/);
});
test('duplicate, zero and mismatched locations cannot become authoritative totals',()=>{
 for(const locations of [[{warehouseId:'A',reservedQty:2},{warehouseId:'A',reservedQty:2}],[{warehouseId:'A',reservedQty:0}],[{warehouseId:'A',reservedQty:3}]])
  assert.throws(()=>reservationLocations({locationSchemaVersion:2,quantity:4,locations}),/重複|不一致|正整數|超過訂購量/);
});
test('nonfinite, negative and nonnumeric quantities are rejected rather than clamped',()=>{
 for(const value of [NaN,Infinity,-Infinity,-1,'bad','',null,true,[],Number.MAX_SAFE_INTEGER+1]){
  assert.throws(()=>plan(input({requestedQty:value})),/數量不正確/);
  assert.throws(()=>reservationLocations({quantity:value,warehouseId:'A'}),/數量不正確/);
 }
});
test('invalid stock quantities and repeated warehouse masters fail closed',()=>{
 const source=input();source.stocks.A.reserved=NaN;assert.throws(()=>plan(source),/數量/);
 assert.throws(()=>preview(input({warehouses:[{id:'A'},{id:'A'}]})),/主檔重複/);
 for(const id of ['',undefined,' A '])assert.throws(()=>preview(input({warehouses:[{id}]})),/識別碼/);
});
test('fractional quantities are rejected consistently with the shared location ledger',()=>{
 for(const value of [0.5,1.5]){
  assert.throws(()=>plan(input({requestedQty:value})),/數量不正確/);
  assert.throws(()=>reservationLocations({locationSchemaVersion:2,quantity:2,locations:[{warehouseId:'A',reservedQty:value}]}),/正整數/);
 }
});
test('quantity conservation holds across stock, supplier commitment, shrink and retry scenarios',()=>{
 for(let a=0;a<=4;a++)for(let b=0;b<=4;b++)for(let requested=0;requested<=10;requested++)for(let incoming=0;incoming<=3;incoming++){
  const source=input({requestedQty:requested,inTransitQty:incoming});
  source.stocks.A.onHand=a;source.stocks.B.onHand=b;source.aggregateStock.onHand=a+b;
  const result=plan(source),after=apply(source,result),held=result.reservation.quantity;
  assert.equal(held,Math.min(a+b,Math.max(0,requested-incoming)));
  assert.equal(held,result.reservation.locations.reduce((sum,row)=>sum+row.reservedQty,0));
  assert.equal(result.companyReservedDelta,result.warehouseDeltas.reduce((sum,row)=>sum+row.reservedDelta,0));
  for(const stock of Object.values(after.stocks))assert.ok(stock.reserved>=0&&stock.reserved<=stock.onHand);
  assert.equal(plan(after).companyReservedDelta,0);
  after.requestedQty=Math.floor(requested/2);const smaller=plan(after),shrunk=apply(after,smaller);
  assert.equal(shrunk.aggregateStock.reserved,smaller.reservation.quantity);
  assert.equal(smaller.companyReservedDelta,smaller.warehouseDeltas.reduce((sum,row)=>sum+row.reservedDelta,0));
 }
});
test('browser globals share inventory availability and fail clearly if its dependency is absent',()=>{
 const inventorySource=fs.readFileSync('modules/inventory-core.js','utf8');
 const reservationSource=fs.readFileSync('modules/reservation-core.js','utf8');
 const browser=vm.createContext({});vm.runInContext(inventorySource,browser);vm.runInContext(reservationSource,browser);
 const source=input();source.aggregateStock.transferFreeInTransit=9;
 assert.equal(browser.YushinReservation.planLocationReservation(source).reservation.quantity,3);
 const unloaded=vm.createContext({});vm.runInContext(reservationSource,unloaded);
 assert.throws(()=>unloaded.YushinReservation.planLocationReservation(input()),/Inventory core/);
});
