'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
const code=source.slice(source.indexOf('window.saveInventoryTransfer=async function'),source.indexOf('window.downloadInventoryImportTemplate='));
function fixture({refreshFail=false,status='PENDING'}={}){
 const messages=[],alerts=[],button={dataset:{}};
 const fields={inventoryTransferFrom:{value:'EXT'},inventoryTransferTo:{value:'MAIN'},inventoryTransferQty:{value:'2'},saveInventoryTransferBtn:button};
 let creates=0;
 const c=vm.createContext({window:{},inventoryTransferEditingId:'P',inventoryItemById:()=>({productKey:'P'}),
  document:{getElementById:id=>fields[id]},lifecycleRecordId:()=> 'REQ',beginActionButton:()=>({}),endActionButton:()=>{},
  createMainTransferRequest:async()=>{creates++;return {status};},invalidateWarehouseStockCache:()=>{},closeInventoryTransfer:()=>{},
  loadInventory:async()=>{if(refreshFail)throw Error('offline');},loadMainTransferRequests:async()=>{},
  showActionFeedback:message=>messages.push(message),alert:message=>alerts.push(message)});
 vm.runInContext(code,c);return {c,messages,alerts,creates:()=>creates};
}
test('request creation reports saved data rather than mutation failure when a subsequent refresh fails',async()=>{
 const f=fixture({refreshFail:true});await f.c.window.saveInventoryTransfer();
 assert.equal(f.creates(),1);assert.equal(f.alerts.length,0);assert.match(f.messages[0],/已儲存.*清單更新失敗/);
});
test('replayed cancelled request is displayed as cancelled, not a new active hold',async()=>{
 const f=fixture({status:'CANCELLED'});await f.c.window.saveInventoryTransfer();
 assert.equal(f.alerts.length,0);assert.match(f.messages[0],/已取消.*未重複/);assert.doesNotMatch(f.messages[0],/已建立並保留/);
});
