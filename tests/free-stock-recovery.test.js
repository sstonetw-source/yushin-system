const test=require('node:test'),assert=require('node:assert/strict'),permissions=require('../modules/stock-permissions');
const {recoverLocation}=require('../modules/free-stock-recovery'),inventory=require('../modules/inventory-core');
function fixture(stock={onHand:5,reserved:3,productKey:'P',warehouseId:'W',allocationRevision:1,allocationPending:true}){
 const docs=new Map([['warehouseStocks/W__P',stock],['inventory/P',{productKey:'P',onHand:5,reserved:3}],['warehouses/W',{active:true}]]),writes=[];
 const ref=path=>({path,id:path.split('/').at(-1)});
 const db={collection:name=>({doc:id=>ref(name+'/'+id)}),runTransaction:async fn=>{
  const pending=[];const tx={get:async r=>{assert.equal(pending.length,0,'native transaction reads must precede writes');return {exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))};},update:(r,d)=>pending.push([r,d]),set:(r,d)=>pending.push([r,d])};
  const result=await fn(tx);for(const [r,d] of pending){docs.set(r.path,{...docs.get(r.path),...d});writes.push([r.path,d]);}return result;
 }};
 const options={db,runTransaction:fn=>db.runTransaction(fn),normalize:inventory.normalizeStock,stockDocId:(w,k)=>w+'__'+k,assertContext(){},stockId:'W__P',actor:'Receiver',allocate:async()=>({allocatedQty:0,affectedOrderIds:[],completionReason:'no-demand'})};
 return {db,docs,writes,options,stock:()=>docs.get('warehouseStocks/W__P')};
}
test('free stock release adds durable metadata atomically and reads each location only once',async()=>{
 for(const change of [{reserved:1},{onHand:7}]){
  const f=fixture();await permissions.run(f.db,async tx=>{const r=f.db.collection('warehouseStocks').doc('W__P');await tx.get(r);tx.update(r,change);},'receiver',false,'admin');
  assert.equal(f.stock().allocationRevision,2);assert.equal(f.stock().allocationPending,true);
 }
});
test('reservation increase and equal physical/reserved return do not create recovery work',async()=>{
 for(const change of [{reserved:4},{onHand:7,reserved:5},{onHand:4,reserved:2}]){
  const f=fixture();await permissions.run(f.db,tx=>tx.update(f.db.collection('warehouseStocks').doc('W__P'),change),'receiver',false,'admin');
  assert.equal(f.stock().allocationRevision,1);
 }
});
test('multiple writes to one location use the final balance and increment revision once',async()=>{
 const f=fixture();await permissions.run(f.db,tx=>{const r=f.db.collection('warehouseStocks').doc('W__P');tx.update(r,{reserved:1});tx.update(r,{onHand:6});},'receiver',false,'admin');
 assert.equal(f.stock().allocationRevision,2);assert.equal(f.stock().onHand,6);assert.equal(f.stock().reserved,1);
});
test('failed native commit cannot leave a release flag or stock mutation',async()=>{
 const f=fixture(),before=JSON.stringify([...f.docs]);f.db.runTransaction=async fn=>{await fn({get:async r=>({exists:f.docs.has(r.path),data:()=>f.docs.get(r.path)}),update(){},set(){}});throw Error('offline');};
 await assert.rejects(permissions.run(f.db,tx=>tx.update(f.db.collection('warehouseStocks').doc('W__P'),{reserved:1}),'receiver',false,'admin'),/offline/);
 assert.equal(JSON.stringify([...f.docs]),before);
});
test('ordinary receipts keep their existing checkpoint and do not create a duplicate location job',async()=>{
 const f=fixture();await permissions.run(f.db,tx=>{tx.update(f.db.collection('warehouseStocks').doc('W__P'),{onHand:7});tx.set(f.db.collection('receipts').doc('R'),{productKey:'P',warehouseId:'W',autoAllocationQty:2});},'receiver',false,'admin');
 assert.equal(f.stock().allocationRevision,1);
});
test('custody stock is never offered to other customers',async()=>{
 const f=fixture();f.docs.set('warehouseStocks/W__P',{...f.stock(),warehouseId:'custody-S'});
 await permissions.run(f.db,tx=>tx.update(f.db.collection('warehouseStocks').doc('W__P'),{onHand:7}),'receiver',false,'admin');assert.equal(f.stock().allocationRevision,1);
});
test('successful no-demand scan completes a location without changing stock facts and retry is harmless',async()=>{
 const f=fixture();await recoverLocation(f.options);await recoverLocation(f.options);
 assert.equal(f.stock().allocationPending,false);assert.equal(f.stock().onHand,5);assert.equal(f.stock().reserved,3);assert.equal(f.stock().allocationRevision,1);assert.equal(f.writes.length,1);
});
test('network or allocation failure retains a durable pending job',async()=>{
 const f=fixture();f.options.allocate=async()=>{throw Error('quota');};await assert.rejects(recoverLocation(f.options),/quota/);assert.equal(f.stock().allocationPending,true);
 f.options.allocate=async()=>({completionReason:'deferred'});await assert.rejects(recoverLocation(f.options),/尚未完成/);assert.equal(f.stock().allocationPending,true);
});
test('a newer free-stock release cannot be cleared by an older successful worker',async()=>{
 const f=fixture();f.options.allocate=async()=>{f.docs.set('warehouseStocks/W__P',{...f.stock(),onHand:7,allocationRevision:2});return {allocatedQty:1,affectedOrderIds:['O'],completionReason:'exhausted'};};
 const result=await recoverLocation(f.options);assert.equal(result.completed,false);assert.equal(f.stock().allocationPending,true);assert.equal(f.stock().allocationRevision,2);
});
test('account or role change after allocation prevents clearing its progress',async()=>{
 const f=fixture();let changed=false;f.options.assertContext=()=>{if(changed)throw Error('account changed');};f.options.allocate=async()=>{changed=true;return {completionReason:'exhausted'};};
 await assert.rejects(recoverLocation(f.options),/account changed/);assert.equal(f.stock().allocationPending,true);
});
test('missing aggregate, disabled warehouse and inconsistent stock fail without clearing the job',async()=>{
 for(const mutate of [f=>f.docs.delete('inventory/P'),f=>f.docs.set('warehouses/W',{active:false}),f=>f.docs.set('inventory/P',{productKey:'P',onHand:4,reserved:3}),f=>f.docs.set('inventory/P',{productKey:'P',onHand:'bad',reserved:0}),f=>f.docs.set('warehouseStocks/W__P',{...f.stock(),onHand:1,reserved:2})]){
  const f=fixture();mutate(f);await assert.rejects(recoverLocation(f.options));assert.equal(f.stock().allocationPending,true);assert.equal(f.writes.length,0);
 }
});
test('common transaction session guard rejects an account switch after asynchronous source reads',async()=>{
 const f=fixture();let changed=false;await assert.rejects(permissions.run(f.db,async tx=>{await tx.get(f.db.collection('warehouseStocks').doc('W__P'));changed=true;tx.update(f.db.collection('warehouseStocks').doc('W__P'),{onHand:7});},'receiver',false,'admin',()=>{if(changed)throw Error('session changed');}),/session changed/);
 assert.equal(f.stock().onHand,5);assert.equal(f.writes.length,0);
});
