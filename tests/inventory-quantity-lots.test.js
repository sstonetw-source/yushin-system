'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const service=fs.readFileSync('src/services/inventory-count.js','utf8');
const feature=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
const editor=feature.slice(feature.indexOf('window.saveInventoryQuantity=async function()'),feature.indexOf('let inventoryTransferEditingId'));
function serviceFixture(){
 const calls=[],c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'purchaser',
  commitManualStockBackend:async(...args)=>{calls.push(args);return {delta:2,operationId:args[1].operationId};}});
 vm.runInContext(service,c);return {c,calls};
}
test('quantity wrapper sends minimal backend intent; no browser writer or caller-controlled stock calculation',async()=>{
 assert.doesNotMatch(service,/runRoleTransaction|db\.collection|\btx\.(?:get|set|update|create)\b/);
 const f=serviceFixture();await f.c.commitInventoryQuantity({
  item:{id:'P',productKey:'P',itemName:'untrusted',onHand:999},warehouseId:'W',target:12,note:'核對',operationId:'count-123456789',
  singleWarehouseFallback:true},{actorUid:'U',actorRole:'purchaser'});
 assert.equal(f.calls[0][0],'INVENTORY_COUNT');
 assert.deepEqual(Object.keys(f.calls[0][1]).sort(),['operationId','productKey','warehouseId','target','note'].sort());
 assert.equal(f.calls[0][1].productKey,'P');assert.equal(f.calls[0][1].target,12);
 assert.equal(f.calls[0][1].singleWarehouseFallback,undefined);
});
test('quantity editor delegates to service; never writes inventory ledger',()=>{
 assert.match(editor,/await commitInventoryQuantity\(/);
 assert.doesNotMatch(editor,/runRoleTransaction|db\.collection|tx\.(?:set|update|create)/);
});

function editorFixture({target='12',note='盤點原因'}={}){
 const item={id:'P',productKey:'P',productId:'P',itemName:'Product',onHand:10};
 const messages=[],feedback=[],calls=[],button={disabled:false,textContent:'確認修改'};
 const nodes={inventoryQuantityTarget:{value:target},inventoryQuantityNote:{value:note},saveInventoryQuantityBtn:button};
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'purchaser',
  inventoryQuantitySaveInProgress:false,inventoryQuantityEditingId:'P',inventoryQuantityEditingWarehouseId:'W',
  inventoryQuantityPendingOperation:null,inventoryQuantityEditorGeneration:1,
  document:{getElementById:id=>nodes[id]},canEditPage:()=>true,inventoryItemById:()=>item,
  warehouseMasterCache:[{id:'W'}],lifecycleRecordId:()=> 'count-123456789',
  commitInventoryQuantity:async(...args)=>{calls.push(args);return {delta:2,productKey:'P',warehouseId:'W',operationId:'count-123456789',replayed:false};},
  closeInventoryQuantityEditor(){c.inventoryQuantityEditorGeneration++;},
  loadInventory:async()=>{},invalidateWarehouseStockCache(){},alert:message=>messages.push(message),
  showActionFeedback:message=>feedback.push(message)});
 c.window=c;vm.runInContext(editor,c);
 return {c,item,nodes,messages,feedback,calls,button};
}
test('editor maintains one immutable operation ID through successful call',async()=>{
 const f=editorFixture();await f.c.saveInventoryQuantity();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0][0].operationId,'count-123456789');
 assert.equal(f.calls[0][0].target,12);assert.equal(f.button.disabled,true); // modal closed
 assert.match(f.feedback[0],/庫存已更新/);
});
test('uncertain response preserves original payload and rejects modified target or note',async()=>{
 const f=editorFixture();f.c.commitInventoryQuantity=async(...args)=>{f.calls.push(args);throw Error('回覆未知');};
 await f.c.saveInventoryQuantity();assert.equal(f.calls.length,1);
 assert.equal(f.c.inventoryQuantityPendingOperation.request.operationId,'count-123456789');
 f.nodes.inventoryQuantityTarget.value='13';await f.c.saveInventoryQuantity();
 assert.equal(f.calls.length,1);assert.match(f.messages.at(-1),/原內容重試/);
 f.nodes.inventoryQuantityTarget.value='12';f.nodes.inventoryQuantityNote.value='不同原因';await f.c.saveInventoryQuantity();
 assert.equal(f.calls.length,1);
 f.nodes.inventoryQuantityNote.value='盤點原因';
 f.c.commitInventoryQuantity=async(...args)=>{f.calls.push(args);return {delta:2,replayed:true};};
 await f.c.saveInventoryQuantity();assert.equal(f.calls.length,2);
 assert.equal(f.calls[0][0].operationId,f.calls[1][0].operationId);
});
test('duplicate click shares one in-flight count; session switch avoids stale refresh',async()=>{
 const f=editorFixture();let release;const pending=new Promise(resolve=>release=resolve);
 f.c.commitInventoryQuantity=async(...args)=>{f.calls.push(args);await pending;return {delta:2};};
 const first=f.c.saveInventoryQuantity();await f.c.saveInventoryQuantity();assert.equal(f.calls.length,1);
 f.c.currentUser={uid:'OTHER'};release();await first;
 assert.equal(f.feedback.length,0);assert.equal(f.c.inventoryQuantitySaveInProgress,false);
});
test('invalid target, empty note, missing warehouse or read-only role prevents backend call',async()=>{
 for(const mutate of [f=>f.nodes.inventoryQuantityTarget.value='',f=>f.nodes.inventoryQuantityTarget.value='-1',
  f=>f.nodes.inventoryQuantityTarget.value='not-number',f=>f.nodes.inventoryQuantityNote.value='',
  f=>f.c.inventoryQuantityEditingWarehouseId='']){
  const f=editorFixture();mutate(f);await f.c.saveInventoryQuantity();assert.equal(f.calls.length,0);
 }
 const readonly=editorFixture();readonly.c.canEditPage=()=>false;await readonly.c.saveInventoryQuantity();assert.equal(readonly.calls.length,0);
});
test('postcommit list refresh error is reported without silently resubmitting stock',async()=>{
 const f=editorFixture();f.c.loadInventory=async()=>{throw Error('清單暫時無法更新');};
 await f.c.saveInventoryQuantity();assert.equal(f.calls.length,1);assert.equal(f.messages.length,1);
 assert.match(f.messages[0],/已完成/);
});
test('receipt-verified callback failure reports confirmed count, never an unknown result',async()=>{
 const f=editorFixture();f.c.commitInventoryQuantity=async(...args)=>{
  f.calls.push(args);const error=Error('畫面快取失效');error.manualStockCommitted=true;throw error;
 };
 await f.c.saveInventoryQuantity();
 assert.equal(f.calls.length,1);assert.match(f.messages[0],/已提交/);
 assert.doesNotMatch(f.messages[0],/結果尚未確認/);
});
