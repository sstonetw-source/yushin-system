const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/reservation-core'),permissions=require('../modules/stock-permissions');
const delta=core.reservationStockDeltas;
const ledger=(a,b)=>({productKey:'P',locationSchemaVersion:2,quantity:a+b,
 locations:[...(a?[{warehouseId:'A',reservedQty:a}]:[]),...(b?[{warehouseId:'B',reservedQty:b}]:[])]});

test('stock projection records exact additions, partial releases and complete cancellation at each location',()=>{
 assert.deepEqual(delta({},ledger(4,6)),{companyReservedDelta:10,warehouseDeltas:[{warehouseId:'A',reservedDelta:4},{warehouseId:'B',reservedDelta:6}]});
 assert.deepEqual(delta(ledger(4,6),ledger(2,5)),{companyReservedDelta:-3,warehouseDeltas:[{warehouseId:'A',reservedDelta:-2},{warehouseId:'B',reservedDelta:-1}]});
 assert.deepEqual(delta(ledger(4,6),ledger(0,0)),{companyReservedDelta:-10,warehouseDeltas:[{warehouseId:'A',reservedDelta:-4},{warehouseId:'B',reservedDelta:-6}]});
});
test('equal company totals still preserve both sides of a warehouse move',()=>{
 assert.deepEqual(delta(ledger(4,6),ledger(7,3)),{companyReservedDelta:0,warehouseDeltas:[{warehouseId:'A',reservedDelta:3},{warehouseId:'B',reservedDelta:-3}]});
 assert.deepEqual(delta({quantity:2,warehouseId:'A'},{quantity:2,warehouseId:'B'}),{
  companyReservedDelta:0,warehouseDeltas:[{warehouseId:'A',reservedDelta:-2},{warehouseId:'B',reservedDelta:2}]});
});
test('unchanged ledgers and legacy-to-v2 equivalent snapshots have no stock delta',()=>{
 assert.deepEqual(delta(ledger(4,6),ledger(4,6)),{companyReservedDelta:0,warehouseDeltas:[]});
 assert.deepEqual(delta({quantity:'4',warehouseId:'A'},ledger(4,0)),{companyReservedDelta:0,warehouseDeltas:[]});
 assert.deepEqual(delta({quantity:0,warehouseId:'A'},{quantity:0,warehouseId:'B'}),{companyReservedDelta:0,warehouseDeltas:[]});
});
test('legacy fractions and custody identity remain available to existing fulfillment',()=>{
 assert.deepEqual(delta({quantity:'1.5',warehouseId:'custody-U'},{quantity:0.5,warehouseId:'custody-U'}),{
  companyReservedDelta:-1,warehouseDeltas:[{warehouseId:'custody-U',reservedDelta:-1}]});
 assert.throws(()=>delta({},ledger(0.5,1)),/數量不正確/);
});
test('unknown, mixed and corrupt formats cannot fall back to a legacy total',()=>{
 for(const record of [{quantity:0,warehouseAllocations:[]},{quantity:0,allocations:[]},{quantity:0,locations:undefined},
  {quantity:0,locationSchemaVersion:undefined},{...ledger(1,0),warehouseAllocations:[]},
  {...ledger(1,0),quantity:2},{...ledger(1,0),locationSchemaVersion:3},
  {...ledger(1,0),locations:[{warehouseId:'A',reservedQty:1},{warehouseId:'A',reservedQty:1}]}]){
  assert.throws(()=>delta({},record));assert.throws(()=>delta(record,{}));
 }
});
test('invalid legacy quantities, missing nonzero location and cross-product pairs fail closed',()=>{
 for(const quantity of [null,true,'',NaN,Infinity,-1,Number.MAX_SAFE_INTEGER+1])
  assert.throws(()=>delta({}, {quantity,warehouseId:'A'}));
 assert.throws(()=>delta({}, {quantity:1}),/識別碼/);
 assert.throws(()=>delta({productKey:'P'}, {productKey:'Q'}),/跨產品/);
});
test('projection does not mutate input and is independent of location array order',()=>{
 const before=ledger(2,3),after=ledger(4,1),saved=structuredClone([before,after]);
 const expected=delta(before,after);assert.deepEqual([before,after],saved);
 after.locations.reverse();assert.deepEqual(delta(before,after),expected);
});
test('location and company deltas conserve quantities across 625 complete snapshot pairs',()=>{
 for(let a=0;a<5;a++)for(let b=0;b<5;b++)for(let c=0;c<5;c++)for(let d=0;d<5;d++){
  const result=delta(ledger(a,b),ledger(c,d));
  assert.equal(result.companyReservedDelta,c+d-a-b);
  assert.equal(result.warehouseDeltas.reduce((sum,row)=>sum+row.reservedDelta,0),result.companyReservedDelta);
 }
});

function fixture(){
 let sequence=0;const reads=[],writes=[];
 const docs=new Map([['orders/O',{ownerUid:'U',salesCode:'S',items:[{itemId:'I',productId:'P',warehouseId:'A'}]}],
  ['inventory/P',{productKey:'P',onHand:10,reserved:0}],
  ['warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:10,reserved:0}]]);
 const db={collection:col=>({doc:(id='op'+(++sequence))=>({path:col+'/'+id,id})}),runTransaction:async fn=>{
  const pending=[];
  const result=await fn({get:async ref=>{assert.equal(pending.length,0);reads.push(ref.path);return {exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))};},
   set:(ref,data,options)=>pending.push({ref,data,options}),update:(ref,data)=>pending.push({ref,data,options:{merge:true}})});
  for(const w of pending){writes.push(w);docs.set(w.ref.path,{...(w.options?.merge?docs.get(w.ref.path):{}),...w.data});}return result;
 }};
 async function run({role='sales',reserved=2,company=reserved,warehouse=reserved,physical=0,engine=permissions}={}){
  return engine.run(db,async tx=>{
   const inv=db.collection('inventory').doc('P'),wh=db.collection('warehouseStocks').doc('A__P'),res=db.collection('inventoryReservations').doc('O__I');
   const i=(await tx.get(inv)).data(),w=(await tx.get(wh)).data();await tx.get(res);
   tx.update(inv,{onHand:i.onHand+physical,reserved:company});tx.update(wh,{onHand:w.onHand+physical,reserved:warehouse});
   tx.set(res,{orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',quantity:reserved},{merge:true});
   tx.set(db.collection('inventoryMovements').doc('M'),{productKey:'P',warehouseId:'A',sourceId:'O',qty:reserved});
  },'U',true,role);
 }
 return {db,docs,reads,writes,run};
}
test('business reservation, partial shipment, reversal and release reuse held snapshots',async()=>{
 for(const role of ['sales','engineer']){
  const f=fixture();
  for(const step of [{reserved:2},{reserved:1,physical:-1},{reserved:2,physical:1},{reserved:0}]){
   f.reads.length=0;await f.run({...step,role});
   assert.equal(f.docs.get('inventory/P').reserved,step.reserved);
   assert.equal(f.docs.get('warehouseStocks/A__P').reserved,step.reserved);
   assert.equal(new Set(f.reads).size,f.reads.length);
  }
  assert.equal(f.docs.get('inventory/P').onHand,10);
 }
});
test('wrong company or warehouse reserved delta stops all buffered writes for both business roles',async()=>{
 for(const role of ['sales','engineer'])for(const patch of [{company:3},{warehouse:3},{company:1},{warehouse:1},{company:0},{warehouse:0}]){
  const f=fixture(),before=structuredClone([...f.docs]);
  await assert.rejects(f.run({role,...patch}),/預留增減.*不一致/);
  assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
test('fractional stock differences tolerate existing floating point representation without rounding stock',async()=>{
 const f=fixture();for(const path of ['inventory/P','warehouseStocks/A__P'])f.docs.get(path).reserved=100.2;
 f.docs.set('inventoryReservations/O__I',{orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',quantity:0.2});
 await f.run({reserved:0.3,company:100.3,warehouse:100.3});
 assert.equal(f.docs.get('inventory/P').reserved,100.3);
});
test('witness reservation IDs come from document references instead of stale embedded IDs',async()=>{
 const f=fixture();f.docs.set('inventoryReservations/O__I',{id:'WRONG',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',quantity:0});
 await f.run();const operations=f.writes.filter(w=>w.ref.path.startsWith('stockOperations/'));
 assert.equal(operations.length,2);for(const op of operations)assert.deepEqual(op.data.reservationIds,['O__I']);
});
test('two same-product items in different warehouses sum into one company delta and separate warehouse witnesses',async()=>{
 const f=fixture();f.docs.get('orders/O').items.push({itemId:'J',productId:'P',warehouseId:'B'});
 f.docs.set('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:10,reserved:0});
 await permissions.run(f.db,async tx=>{
  for(const [col,id] of [['inventory','P'],['warehouseStocks','A__P'],['warehouseStocks','B__P']])await tx.get(f.db.collection(col).doc(id));
  tx.update(f.db.collection('inventory').doc('P'),{reserved:5});
  for(const [itemId,warehouseId,quantity] of [['I','A',2],['J','B',3]]){
   tx.update(f.db.collection('warehouseStocks').doc(warehouseId+'__P'),{reserved:quantity});
   tx.set(f.db.collection('inventoryReservations').doc('O__'+itemId),{orderId:'O',itemId,productKey:'P',warehouseId,quantity});
  }
  tx.set(f.db.collection('inventoryMovements').doc('M'),{productKey:'P',sourceId:'O',qty:5});
 },'U',true,'sales');
 const ops=f.writes.filter(w=>w.ref.path.startsWith('stockOperations/')).map(w=>w.data);
 assert.equal(ops.length,3);
 assert.deepEqual(ops.map(op=>[op.targetPath,op.reservedDelta,op.reservationIds]),[
  ['inventory/P',5,['O__I','O__J']],['warehouseStocks/A__P',2,['O__I']],['warehouseStocks/B__P',3,['O__J']]]);
});
test('browser script order resolves shared projection at transaction time and missing module stops writes',async()=>{
 const index=fs.readFileSync('index.html','utf8'),source=fs.readFileSync('modules/stock-permissions.js','utf8');
 const c=vm.createContext({}),f=fixture();vm.runInContext(source,c);
 await assert.rejects(c.YushinStockPermissions.run(f.db,tx=>tx.set(f.db.collection('inventoryReservations').doc('O__I'),
  {orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',quantity:1}),'U',false,'purchaser'),/預留計算模組/);
 assert.equal(f.writes.length,0);
 for(const match of index.matchAll(/<script src="(modules\/(?:inventory-core|reservation-core)\.js)\?[^\"]+"/g))vm.runInContext(fs.readFileSync(match[1],'utf8'),c);
 assert.equal(c.YushinReservation.reservationStockDeltas({},ledger(2,3)).companyReservedDelta,5);
 await f.run({engine:c.YushinStockPermissions});
 assert.equal(f.docs.get('inventory/P').reserved,2);
});

function operationalFixture(count=2,{inventoryId='P'}={}){
 const f=fixture();
 if(inventoryId!=='P'){f.docs.set('inventory/'+inventoryId,f.docs.get('inventory/P'));f.docs.delete('inventory/P');}f.docs.get('orders/O').items=Array.from({length:count},(_,i)=>({itemId:'I'+i,productId:'P',warehouseId:i%2?'B':'A'}));
 f.docs.set('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:10,reserved:0});
 let attempt=0;
 f.apply=async(quantities,{role='purchaser',missingMovement='',globalMovement=false,skipCompany=false}={})=>permissions.run(f.db,async tx=>{
  const items=f.docs.get('orders/O').items,old=[];
  for(const path of ['inventory/'+inventoryId,'warehouseStocks/A__P','warehouseStocks/B__P'])await tx.get(f.db.collection(path.split('/')[0]).doc(path.split('/')[1]));
  for(const item of items)old.push((await tx.get(f.db.collection('inventoryReservations').doc('O__'+item.itemId))).data()?.quantity||0);
  if(!skipCompany)tx.update(f.db.collection('inventory').doc(inventoryId),{reserved:quantities.reduce((a,b)=>a+b,0)});
  for(const warehouseId of ['A','B']){
   const total=items.reduce((sum,item,i)=>sum+(item.warehouseId===warehouseId?quantities[i]:0),0);
   tx.update(f.db.collection('warehouseStocks').doc(warehouseId+'__P'),{reserved:total});
  }
  items.forEach((item,i)=>tx.set(f.db.collection('inventoryReservations').doc('O__'+item.itemId),{
   orderId:'O',itemId:item.itemId,productKey:'P',warehouseId:item.warehouseId,quantity:quantities[i],shortageQty:5-quantities[i]},{merge:true}));
  const id=++attempt;
  for(const warehouseId of globalMovement?['']:['A','B']){
   if(missingMovement&&warehouseId===missingMovement)continue;
   tx.set(f.db.collection('inventoryMovements').doc('M'+id+'-'+warehouseId),{
    productKey:'P',...(warehouseId?{warehouseId}:{}),sourceId:'O',sourceType:'order',
    type:'reserve',qty:items.reduce((sum,item,i)=>sum+(!warehouseId||item.warehouseId===warehouseId?quantities[i]-old[i]:0),0)});
  }
 },'U',false,role);
 return f;
}
test('operational cross-warehouse groups prove company totals and use a representative from each actual warehouse',async()=>{
 for(const role of ['purchaser','warehouse']){
  const f=operationalFixture(5);await f.apply([1,2,1,2,1],{role});
  assert.equal(f.docs.get('inventory/P').reserved,7);
  assert.equal(f.docs.get('warehouseStocks/A__P').reserved,3);assert.equal(f.docs.get('warehouseStocks/B__P').reserved,4);
  for(let i=0;i<5;i++){
   const r=f.docs.get('inventoryReservations/O__I'+i),e=r.stockEvidence;
   assert.equal(e.crossWarehouse,true);assert.equal(e.reservationIds.length,5);
   assert.ok(e.warehouseReservationIds.includes('O__I'+i));
   for(const id of e.warehouseReservationIds)assert.equal(f.docs.get('inventoryReservations/'+id).warehouseId,r.warehouseId);
   assert.equal(f.docs.get('inventoryReservations/'+e.reservationIds[0]).warehouseId,r.warehouseId);
   assert.deepEqual(f.docs.get('inventoryMovements/'+e.movementId).reservationStockEvidence,e);
  }
  assert.equal(new Set(f.reads).size,f.reads.length);
 }
});
test('cross-warehouse reserve, partial release, zero-company exchange and full release preserve physical stock',async()=>{
 const f=operationalFixture();
 for(const quantities of [[2,3],[1,2],[2,1],[0,0]]){
  await f.apply(quantities);
  assert.equal(f.docs.get('inventory/P').reserved,quantities[0]+quantities[1]);
  assert.equal(f.docs.get('warehouseStocks/A__P').reserved,quantities[0]);assert.equal(f.docs.get('warehouseStocks/B__P').reserved,quantities[1]);
 }
 assert.equal(f.docs.get('inventory/P').onHand,10);assert.equal(f.docs.get('warehouseStocks/B__P').onHand,10);
});
test('missing warehouse-specific movement cannot be replaced by another warehouse or a company-wide record',async()=>{
 for(const options of [{missingMovement:'A'},{missingMovement:'B'},{globalMovement:true}]){
  const f=operationalFixture(),before=structuredClone([...f.docs]);
  await assert.rejects(f.apply([2,3],options),/缺少.*庫存紀錄/);
  assert.deepEqual([...f.docs],before);assert.equal(f.writes.length,0);
 }
});
test('cross-warehouse groups retain the five-reservation bound and reject mixing a move with grouped holds',async()=>{
 const tooMany=operationalFixture(6);await assert.rejects(tooMany.apply([1,1,1,1,1,1]),/最多.*5/);assert.equal(tooMany.writes.length,0);
 const moving=operationalFixture(3);
 moving.docs.set('inventoryReservations/O__I0',{orderId:'O',itemId:'I0',productKey:'P',warehouseId:'B',quantity:1});
 const before=structuredClone([...moving.docs]);await assert.rejects(moving.apply([1,1,1]),/原調撥流程/);
 assert.deepEqual([...moving.docs],before);assert.equal(moving.writes.length,0);
});
test('zero-company exchanges reuse the actual read reference when an unchanged company ledger has a noncanonical id',async()=>{
 const f=operationalFixture(2,{inventoryId:'company-ledger'});
 await f.apply([2,3]);const before=f.writes.length;
 await f.apply([3,2],{skipCompany:true});
 assert.equal(f.docs.get('inventory/company-ledger').reserved,5);
 for(const item of ['I0','I1'])assert.equal(f.docs.get('inventoryReservations/O__'+item).stockEvidence.inventoryId,'company-ledger');
 assert.equal(f.writes.slice(before).some(w=>w.ref.path.startsWith('inventory/')),false);
});
