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
  assert.equal(f.writes[0].data.salesCode,'S01');assert.deepEqual(f.events,role==='admin'?['read','write']:['read','read','write']);
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

