const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const inventory=require('../modules/inventory-core');
const app=fs.readFileSync('app.js','utf8');
const source=app.slice(app.indexOf('window.saveInventoryQuantity=async function()'),app.indexOf("let inventoryTransferEditingId"));
function fixture({onHand=10,reserved=0,target=15,lots=[],fail=false}={}){
 const item={id:'P',productKey:'P',productId:'P',itemCode:'74104',itemName:'RNA kit',brand:'Qiagen'};
 const docs=new Map([['inventory/P',{...item,onHand,reserved,incoming:0}],['warehouseStocks/MAIN__P',{onHand,reserved,incoming:0}],...lots.map(lot=>['inventoryLots/'+lot.id,{productKey:'P',warehouseId:'MAIN',...lot}])]);
 const ref=(col,id)=>({id,path:col+'/'+id});const button={disabled:false,textContent:'確認修改'};let readAfterWrite=false;
 const state={fail,lost:false,replay:false,afterRead:null,afterCommit:null,querySize:null},writesCommitted=[],reads=[],notifications=[];
 const messages=[];const nodes={inventoryQuantityTarget:{value:String(target)},inventoryQuantityNote:{value:'count'},saveInventoryQuantityBtn:button};
 const c=vm.createContext({window:{},inventoryQuantityEditingId:'P',inventoryQuantityEditingWarehouseId:'MAIN',
  inventoryQuantitySaveInProgress:false,inventoryQuantityPendingOperation:null,inventoryQuantityEditorGeneration:1,
  document:{getElementById:id=>nodes[id]},canEditPage:()=>true,inventoryItemById:()=>item,
  inventoryNumbers:inventory.normalizeStock,warehouseMasterCache:[{id:'MAIN'},{id:'EXT'}],
  warehouseStockDocId:(w,p)=>w+'__'+p,currentUserName:'Buyer',currentUser:{uid:'BUYER',email:'buyer'},currentUserRole:'purchaser',
  lifecycleRecordId:()=> 'COUNT',resolveBrandName:b=>b,brandIdForName:()=> 'QIAGEN',buildInventorySearchTokens:()=>[],
  YushinInventory:inventory,firestoreReadWithTimeout:async p=>p,alert:s=>messages.push(s),
  invalidateWarehouseStockCache:(...args)=>notifications.push(args),closeInventoryQuantityEditor:()=>{},loadInventory:async()=>{},showActionFeedback:()=>{},
  db:{collection:col=>({doc:id=>ref(col,id||'movement'),where(field,_op,value){const filters=[[field,value]];
    const query={where(f,_o,v){filters.push([f,v]);return query;},limit(){return query;},get:async()=>{const result=[...docs].filter(([path,data])=>path.startsWith(col+'/')&&filters.every(([f,v])=>data[f]===v)).map(([path])=>({ref:ref(col,path.split('/')[1])}));return {size:state.querySize??result.length,docs:result};}};return query;}})},
  runRoleTransaction:async fn=>{let writes=[];const tx={get:async r=>{reads.push(r.path);if(writes.length)readAfterWrite=true;const snapshot={id:r.id,exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))};state.afterRead?.(r);return snapshot;},set:(r,d,o)=>writes.push([r,d,!!o?.merge]),update:(r,d)=>writes.push([r,d,true])};if(state.replay){await fn(tx);writes=[];}await fn(tx);if(state.fail)throw Error('network');for(const [r,d,merge] of writes){docs.set(r.path,{...(merge?docs.get(r.path):{}),...JSON.parse(JSON.stringify(d))});writesCommitted.push(r.path);}state.afterCommit?.();if(state.lost){state.lost=false;throw Error('lost reply');}}
 });c.window=c;vm.runInContext(fs.readFileSync('src/services/inventory-count.js','utf8'),c);vm.runInContext(source,c);
 const request={item,warehouseId:'MAIN',target,note:'count',operationId:'COUNT'};
 return {c,docs,messages,button,state,reads,writesCommitted,notifications,nodes,request,run:(data=request,options={})=>c.commitInventoryQuantity(data,options),readAfterWrite:()=>readAfterWrite};
}
test('quantity editor atomically aligns manual count, warehouse, total and unknown-cost lot',async()=>{
 const f=fixture();await f.c.saveInventoryQuantity();
 assert.deepEqual(f.messages,[]);assert.equal(f.docs.get('inventory/P').onHand,15);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,15);
 assert.equal(f.docs.get('inventoryLots/COUNT-balance').remainingQty,10);
 assert.equal(f.docs.get('inventoryLots/COUNT-added').remainingQty,5);
 assert.equal(f.docs.get('inventoryLots/COUNT-added').unitCost,undefined);
 assert.equal(f.docs.get('inventoryMovements/COUNT').sourceId,'COUNT');
 assert.equal(f.readAfterWrite(),false);assert.equal(f.button.disabled,false);
 await f.c.saveInventoryQuantity();assert.equal(f.docs.get('inventoryLots/COUNT-added').remainingQty,5);
});
test('quantity editor reduces actual batches and keeps receipt identity',async()=>{
 const f=fixture({target:5,lots:[{id:'known',remainingQty:10,lotNo:'B'}]});await f.c.saveInventoryQuantity();
 assert.deepEqual(f.messages,[]);assert.equal(f.docs.get('inventoryLots/known').remainingQty,5);
 assert.equal(f.docs.get('inventoryLots/known').lotNo,'B');
 assert.equal(f.docs.get('inventoryMovements/COUNT').lotAllocations[0].qty,5);
 assert.equal(f.readAfterWrite(),false);
});
test('quantity editor reservation violation and failed commit leave all records unchanged',async()=>{
 for(const options of [{target:3,reserved:4},{target:15,fail:true}]){
  const f=fixture(options),before=structuredClone([...f.docs]);await f.c.saveInventoryQuantity();
  assert.equal(f.messages.length,1);assert.deepEqual([...f.docs],before);assert.equal(f.button.disabled,false);
 }
});
test('count service has no form storage or cache dependency and Feature delegates the transaction',()=>{
 const service=fs.readFileSync('src/services/inventory-count.js','utf8');
 assert.doesNotMatch(service,/\b(?:window|document|localStorage|sessionStorage|warehouseMasterCache|warehouseStockCache|invalidateWarehouseStockCache)\b/);
 assert.match(source,/await commitInventoryQuantity\(/);assert.doesNotMatch(source,/runRoleTransaction|tx\.(?:set|update)|db\.collection/);
});
test('count operation replay after lost reply preserves subsequent receipts and reads only its immutable movement',async()=>{
 const f=fixture();f.state.lost=true;await assert.rejects(f.run(),/lost reply/);
 f.docs.get('inventory/P').onHand=20;f.docs.get('warehouseStocks/MAIN__P').onHand=20;
 const before=JSON.stringify([...f.docs]),writeCount=f.writesCommitted.length;f.reads.length=0;
 const result=await f.run();assert.equal(result.replayed,true);assert.equal(result.delta,5);
 assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.writesCommitted.length,writeCount);
 assert.deepEqual(f.reads,['inventoryMovements/COUNT']);
});
test('count callback replay commits one movement, fixed timestamp and one postcommit notification',async()=>{
 const f=fixture();f.state.replay=true;const notifications=[];
 await f.run(f.request,{onStockCommitted:(...args)=>notifications.push(args)});
 assert.equal(f.writesCommitted.filter(p=>p.startsWith('inventoryMovements/')).length,1);
 assert.deepEqual(notifications,[['P','MAIN']]);assert.equal(f.readAfterWrite(),false);
 assert.equal(f.docs.get('inventory/P').updatedAt,f.docs.get('inventoryMovements/COUNT').createdAt);
});
test('count service captures caller payload before asynchronous reads',async()=>{
 const f=fixture();f.state.afterRead=()=>{f.request.item.productId='OTHER';f.request.target=100;};
 await f.run();assert.equal(f.docs.get('inventory/P').onHand,15);assert.equal(f.docs.get('inventoryMovements/COUNT').countTarget,15);
});
test('existing operation rejects different target warehouse note product actor or role without writes',async()=>{
 for(const change of [f=>f.request.target=16,f=>f.request.warehouseId='EXT',f=>f.request.note='changed',
  f=>f.request.item.productKey='OTHER',f=>f.c.currentUser={uid:'OTHER'},f=>f.c.currentUserRole='admin']){
  const f=fixture();await f.run();const before=JSON.stringify([...f.docs]);change(f);
  await assert.rejects(f.run(),/不同內容或身分/);assert.equal(JSON.stringify([...f.docs]),before);
 }
});
test('count rejects invalid persisted quantities, identity, reservations and lot overflow atomically',async()=>{
 for(const change of [
  f=>f.docs.get('inventory/P').onHand=-1,f=>f.docs.get('inventory/P').reserved='invalid',
  f=>f.docs.get('warehouseStocks/MAIN__P').incoming='',f=>f.docs.get('warehouseStocks/MAIN__P').reserved=11,
  f=>f.docs.get('inventory/P').productKey='OTHER',f=>f.docs.get('warehouseStocks/MAIN__P').warehouseId='EXT',
  f=>f.docs.set('inventoryLots/bad',{productKey:'P',warehouseId:'MAIN',remainingQty:-1}),
  f=>f.docs.set('inventoryLots/excess',{productKey:'P',warehouseId:'MAIN',remainingQty:11}),
  f=>f.docs.set('inventoryLots/COUNT-added',{productKey:'OTHER',warehouseId:'MAIN',remainingQty:1}),
  f=>f.state.querySize=201,f=>f.docs.get('inventory/P').reserved=9
 ]){
  const f=fixture({target:5});change(f);const before=JSON.stringify([...f.docs]);await assert.rejects(f.run());
  assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.writesCommitted.length,0);
 }
});
test('count rejects invalid target and operation identifiers before a transaction',async()=>{
 for(const patch of [{target:NaN},{target:Infinity},{target:-1},{target:''},{target:null},{target:true},{operationId:''},{operationId:'a/b'},{warehouseId:''}]){
  const f=fixture();await assert.rejects(f.run({...f.request,...patch}));assert.equal(f.reads.length,0);
 }
});
test('count retains explicit single-warehouse migration fallback without requiring UI cache in service',async()=>{
 const f=fixture();f.docs.delete('warehouseStocks/MAIN__P');await f.run({...f.request,singleWarehouseFallback:true});
 assert.equal(f.docs.get('inventory/P').onHand,15);assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,15);
 const noFallback=fixture();noFallback.docs.delete('warehouseStocks/MAIN__P');await noFallback.run();
 assert.equal(noFallback.docs.get('inventory/P').onHand,25);assert.equal(noFallback.docs.get('warehouseStocks/MAIN__P').onHand,15);
});
test('unchanged count records a zero audit receipt so uncertain replay cannot overwrite later arrivals',async()=>{
 const f=fixture({target:10}),before=JSON.stringify(f.docs.get('inventory/P'));f.state.lost=true;await assert.rejects(f.run(),/lost reply/);
 assert.equal(JSON.stringify(f.docs.get('inventory/P')),before);assert.deepEqual(f.writesCommitted,['inventoryMovements/COUNT']);
 f.docs.get('inventory/P').onHand=12;f.docs.get('warehouseStocks/MAIN__P').onHand=12;
 const result=await f.run();assert.equal(result.delta,0);assert.equal(result.replayed,true);assert.equal(f.docs.get('inventory/P').onHand,12);
});
test('count refuses sales engineer missing actor and midread actor switches',async()=>{
 for(const change of [f=>f.c.currentUserRole='sales',f=>f.c.currentUserRole='engineer',f=>f.c.currentUser=null,
  f=>f.state.afterRead=()=>{f.c.currentUser={uid:'OTHER'};},f=>f.state.afterRead=()=>{f.c.currentUserRole='admin';}]){
  const f=fixture();change(f);const before=JSON.stringify([...f.docs]);await assert.rejects(f.run());assert.equal(JSON.stringify([...f.docs]),before);
 }
});
test('count postcommit session or notification error preserves committed marker and safely resumes',async()=>{
 for(const mode of ['session','notification']){
  const f=fixture();if(mode==='session')f.state.afterCommit=()=>{f.c.currentUserRole='admin';};
  await assert.rejects(f.run(f.request,{onStockCommitted:()=>{throw Error('cache unavailable');}}),e=>e.inventoryCountCommitted===true&&e.operationId==='COUNT');
  const before=JSON.stringify([...f.docs]);f.state.afterCommit=null;f.c.currentUserRole='purchaser';
  assert.equal((await f.run()).replayed,true);assert.equal(JSON.stringify([...f.docs]),before);
 }
});
test('Feature retains original operation after uncertain response and refuses edited retry payload',async()=>{
 const f=fixture();f.state.lost=true;await f.c.saveInventoryQuantity();assert.equal(f.messages.length,1);
 f.nodes.inventoryQuantityTarget.value='16';await f.c.saveInventoryQuantity();assert.match(f.messages.at(-1),/原內容重試/);
 assert.equal(f.docs.get('inventory/P').onHand,15);
 f.nodes.inventoryQuantityTarget.value='15';f.docs.get('inventory/P').onHand=20;f.docs.get('warehouseStocks/MAIN__P').onHand=20;
 await f.c.saveInventoryQuantity();assert.equal(f.docs.get('inventory/P').onHand,20);assert.equal(f.c.inventoryQuantitySaveInProgress,false);
});
test('Feature duplicate save shares a single in-flight operation and session switch prevents cache effects',async()=>{
 const f=fixture();let release;const gate=new Promise(r=>release=r),original=f.c.commitInventoryQuantity;let calls=0;
 f.c.commitInventoryQuantity=async(...args)=>{calls++;await gate;return original(...args);};
 const first=f.c.saveInventoryQuantity();await f.c.saveInventoryQuantity();assert.equal(calls,1);release();await first;
 const switched=fixture();switched.state.afterCommit=()=>{switched.c.currentUserRole='admin';};await switched.c.saveInventoryQuantity();
 assert.equal(switched.notifications.length,0);assert.equal(switched.messages.length,0);assert.ok(switched.c.inventoryQuantityPendingOperation);
});
test('Feature empty count is not implicitly treated as zero and postcommit refresh failure is explicit',async()=>{
 const empty=fixture();empty.nodes.inventoryQuantityTarget.value='';await empty.c.saveInventoryQuantity();assert.equal(empty.reads.length,0);
 const failed=fixture();failed.c.loadInventory=async()=>{throw Error('refresh offline');};await failed.c.saveInventoryQuantity();
 assert.match(failed.messages[0],/盤點已完成.*清單更新失敗/);assert.equal(failed.docs.get('inventory/P').onHand,15);
});
