const test=require('node:test'),assert=require('node:assert/strict');
const permissions=require('../modules/stock-permissions');
function fixture(items){
 const writes=[],events=[];
 const ref=(path)=>({path,id:path.split('/').at(-1)});
 const docs=new Map([['orders/O',{ownerUid:'sales',salesCode:'S01',items}]]);
 const db={collection:col=>({doc:id=>ref(col+'/'+id)}),runTransaction:async callback=>callback({
  get:async r=>{events.push('read');assert.equal(writes.length,0);return {exists:docs.has(r.path),data:()=>docs.get(r.path)};},
  set:(r,d)=>{events.push('write');writes.push({path:r.path,data:d});},update:(r,d)=>{events.push('write');writes.push({path:r.path,data:d});}
 })};return {db,writes,events};
}
test('purchasing warehouse and admin transactions derive reservation ownership and item position from the source order',async()=>{
 for(const role of ['admin','purchaser','warehouse']){
  const f=fixture([{itemId:'A'},{itemId:'B'}]);
  await permissions.run(f.db,tx=>tx.set(f.db.collection('inventoryReservations').doc('O__B'),
   {orderId:'O',itemId:'B',orderItemIndex:0,ownerUid:'false-owner',salesCode:'FALSE',quantity:1}),role,false,role);
  assert.equal(f.writes[0].data.orderItemIndex,1);assert.equal(f.writes[0].data.ownerUid,'sales');
  assert.equal(f.writes[0].data.salesCode,'S01');assert.deepEqual(f.events,['read','write']);
 }
});
test('operational reservation source validation uses the same transaction order snapshot and rejects missing items before any writes',async()=>{
 const f=fixture([{itemId:'A'}]);
 await assert.rejects(permissions.run(f.db,tx=>{
  tx.update(f.db.collection('orders').doc('O'),{items:[{itemId:'B'}]});
  tx.set(f.db.collection('inventoryReservations').doc('O__A'),{orderId:'O',itemId:'A',quantity:1});
 },'buyer',false,'purchaser'),/來源訂單品項/);
 assert.equal(f.writes.length,0);
 const g=fixture([{itemId:'A'}]);
 await permissions.run(g.db,tx=>{
  tx.update(g.db.collection('orders').doc('O'),{items:[{itemId:'B'}]});
  tx.set(g.db.collection('inventoryReservations').doc('O__B'),{orderId:'O',itemId:'B',quantity:1});
 },'buyer',false,'purchaser');
 assert.equal(g.writes[1].data.orderItemIndex,0);
});
