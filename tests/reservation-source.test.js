const test=require('node:test'),assert=require('node:assert/strict');
const permissions=require('../modules/stock-permissions');
function fixture(items){
 const writes=[],events=[];
 const ref=(path)=>({path,id:path.split('/').at(-1)});
 const docs=new Map([['orders/O',{ownerUid:'sales',salesCode:'S01',items}]]);
 const db={collection:col=>({doc:id=>ref(col+'/'+id)}),runTransaction:async callback=>callback({
  get:async r=>{events.push('read');assert.equal(writes.length,0);return {exists:docs.has(r.path),data:()=>docs.get(r.path)};},
  set:(r,d)=>{events.push('write');writes.push({path:r.path,data:d});},update:(r,d)=>{events.push('write');writes.push({path:r.path,data:d});}
 })};return {db,writes,events,docs};
}
test('purchasing warehouse and admin transactions derive reservation ownership and item position from the source order',async()=>{
 for(const role of ['admin','purchaser','warehouse']){
  const f=fixture([{itemId:'A'},{itemId:'B'}]);
  await permissions.run(f.db,tx=>tx.set(f.db.collection('inventoryReservations').doc('O__B'),
   {orderId:'O',itemId:'B',orderItemIndex:0,ownerUid:'false-owner',salesCode:'FALSE',quantity:0}),role,false,role);
  assert.equal(f.writes[0].data.orderItemIndex,1);assert.equal(f.writes[0].data.ownerUid,'sales');
  assert.equal(f.writes[0].data.salesCode,'S01');assert.deepEqual(f.events,['read','read','write']);
 }
});
test('operational reservation source validation uses the same transaction order snapshot and rejects missing items before any writes',async()=>{
 const f=fixture([{itemId:'A'}]);
 await assert.rejects(permissions.run(f.db,tx=>{
  tx.update(f.db.collection('orders').doc('O'),{items:[{itemId:'B'}]});
  tx.set(f.db.collection('inventoryReservations').doc('O__A'),{orderId:'O',itemId:'A',quantity:0});
 },'buyer',false,'purchaser'),/來源訂單品項/);
 assert.equal(f.writes.length,0);
 const g=fixture([{itemId:'A'}]);
 await permissions.run(g.db,tx=>{
  tx.update(g.db.collection('orders').doc('O'),{items:[{itemId:'B'}]});
  tx.set(g.db.collection('inventoryReservations').doc('O__B'),{orderId:'O',itemId:'B',quantity:0});
 },'buyer',false,'purchaser');
 assert.equal(g.writes[1].data.orderItemIndex,0);
});

test('operational wrapper reuses stock reads and attaches a single five-item movement proof before writing',async()=>{
 const items=Array.from({length:5},(_,i)=>({itemId:'I'+i,productId:'P',warehouseId:'W1'})),f=fixture(items);
 f.docs.set('inventory/P',{productKey:'P',onHand:10,reserved:0});
 f.docs.set('warehouseStocks/W1__P',{productKey:'P',warehouseId:'W1',onHand:10,reserved:0});
 await permissions.run(f.db,async tx=>{
  const inv=f.db.collection('inventory').doc('P'),wh=f.db.collection('warehouseStocks').doc('W1__P');
  await tx.get(inv);await tx.get(wh);tx.update(inv,{reserved:5});tx.update(wh,{reserved:5});
  tx.set(f.db.collection('inventoryMovements').doc('M'),{productKey:'P',warehouseId:'W1',sourceId:'O',qty:5,type:'reserve'});
  for(const item of items)tx.set(f.db.collection('inventoryReservations').doc('O__'+item.itemId),{orderId:'O',itemId:item.itemId,productKey:'P',warehouseId:'W1',quantity:1});
 },'buyer',false,'purchaser');
 const proof=f.writes.find(x=>x.path==='inventoryMovements/M').data.reservationStockEvidence;
 assert.equal(proof.reservationIds.length,5);assert.equal(proof.inventoryId,'P');assert.equal(proof.warehouseStockId,'W1__P');
 for(const row of f.writes.filter(x=>x.path.startsWith('inventoryReservations/')))assert.deepEqual(row.data.stockEvidence,proof);
 assert.ok(f.events.indexOf('write')>f.events.lastIndexOf('read'));
});

const unsupportedLocations=[{locationSchemaVersion:2},{locationSchemaVersion:0},{locations:[]},
 {locations:[{warehouseId:'W1',reservedQty:1},{warehouseId:'W2',reservedQty:1}]},
 {locations:null},{allocations:[]},{warehouseAllocations:[]}];
test('all roles stop on unsupported reservation snapshots before any buffered stock or order write',async()=>{
 for(const role of ['sales','engineer','purchaser','warehouse','admin'])for(const patch of unsupportedLocations){
  const f=fixture([{itemId:'A'}]),record={orderId:'O',itemId:'A',itemCode:'PART',quantity:2,warehouseId:'W1',...patch};
  f.docs.set('inventoryReservations/O__A',record);const before=structuredClone([...f.docs]);
  await assert.rejects(permissions.run(f.db,async tx=>{
   tx.update(f.db.collection('inventory').doc('P'),{reserved:0});
   const snap=await tx.get(f.db.collection('inventoryReservations').doc('O__A'));
   tx.update(f.db.collection('orders').doc('O'),{items:[{itemId:'A',reservedQty:snap.data().quantity}]});
  },role,false,role),error=>error.code==='unsupported-reservation-location'&&/O／PART/.test(error.message));
  assert.equal(f.writes.length,0);assert.deepEqual([...f.docs],before);
 }
});
test('set, update and dotted paths cannot introduce unactivated locations even without reading the reservation',async()=>{
 for(const role of ['sales','engineer','purchaser','warehouse','admin'])for(const method of ['set','update']){
  for(const patch of [...unsupportedLocations,{'locations.0.reservedQty':1},{'warehouseAllocations.W1':1}]){
   const f=fixture([{itemId:'A'}]);
   await assert.rejects(permissions.run(f.db,tx=>{
    tx.update(f.db.collection('orders').doc('O'),{remarks:'queued'});
    tx[method](f.db.collection('inventoryReservations').doc('O__A'),{orderId:'O',itemId:'A',quantity:0,...patch});
   },role,false,role),error=>error.code==='unsupported-reservation-location');
   assert.equal(f.writes.length,0);
  }
 }
});
test('blind replacement cannot conceal and erase an existing unsupported ledger',async()=>{
 for(const role of ['sales','engineer','purchaser','warehouse','admin']){
  const f=fixture([{itemId:'A'}]);f.docs.set('inventoryReservations/O__A',{orderId:'O',itemId:'A',quantity:2,locations:[]});
  await assert.rejects(permissions.run(f.db,tx=>tx.set(f.db.collection('inventoryReservations').doc('O__A'),
   {orderId:'O',itemId:'A',quantity:0,warehouseId:'W1'}),role,false,role),/尚未啟用的位置資料/);
  assert.equal(f.writes.length,0);assert.equal(f.docs.get('inventoryReservations/O__A').quantity,2);
 }
});
test('ordinary legacy fractional quantities and custody identity remain readable without an extra duplicate read',async()=>{
 const f=fixture([{itemId:'A'}]);const ref=f.db.collection('inventoryReservations').doc('O__A');
 const record={orderId:'O',itemId:'A',quantity:0.5,warehouseId:'custody-sales'};f.docs.set(ref.path,record);
 await permissions.run(f.db,async tx=>{assert.deepEqual((await tx.get(ref)).data(),record);tx.update(ref,{quantity:0.5});},'admin',false,'admin');
 assert.deepEqual(f.events,['read','read','write']);assert.equal(f.writes[0].data.quantity,0.5);
});
test('location-shaped fields on other collections are outside the reservation compatibility guard',async()=>{
 const f=fixture([{itemId:'A'}]);f.docs.set('orders/O',{items:[{itemId:'A'}],locations:[],allocations:[]});
 await permissions.run(f.db,async tx=>{await tx.get(f.db.collection('orders').doc('O'));tx.update(f.db.collection('orders').doc('O'),{locations:['unchanged-purpose']});},'admin',false,'admin');
 assert.equal(f.writes.length,1);
});

