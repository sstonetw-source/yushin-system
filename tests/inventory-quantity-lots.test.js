const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const inventory=require('../modules/inventory-core');
const app=fs.readFileSync('app.js','utf8');
const source=app.slice(app.indexOf('window.saveInventoryQuantity=async function()'),app.indexOf("let inventoryTransferEditingId"));
function fixture({onHand=10,reserved=0,target=15,lots=[],fail=false}={}){
 const item={id:'P',productKey:'P',productId:'P',itemCode:'74104',itemName:'RNA kit',brand:'Qiagen'};
 const docs=new Map([['inventory/P',{...item,onHand,reserved,incoming:0}],['warehouseStocks/MAIN__P',{onHand,reserved,incoming:0}],...lots.map(lot=>['inventoryLots/'+lot.id,{productKey:'P',warehouseId:'MAIN',...lot}])]);
 const ref=(col,id)=>({id,path:col+'/'+id});const button={disabled:false,textContent:'確認修改'};let readAfterWrite=false;
 const messages=[];const nodes={inventoryQuantityTarget:{value:String(target)},inventoryQuantityNote:{value:'count'},saveInventoryQuantityBtn:button};
 const c=vm.createContext({window:{},inventoryQuantityEditingId:'P',inventoryQuantityEditingWarehouseId:'MAIN',
  document:{getElementById:id=>nodes[id]},canEditPage:()=>true,inventoryItemById:()=>item,
  inventoryNumbers:inventory.normalizeStock,warehouseMasterCache:[{id:'MAIN'},{id:'EXT'}],
  warehouseStockDocId:(w,p)=>w+'__'+p,currentUserName:'Buyer',currentUser:{email:'buyer'},
  lifecycleRecordId:()=> 'COUNT',resolveBrandName:b=>b,brandIdForName:()=> 'QIAGEN',buildInventorySearchTokens:()=>[],
  YushinInventory:inventory,firestoreReadWithTimeout:async p=>p,alert:s=>messages.push(s),
  invalidateWarehouseStockCache:()=>{},closeInventoryQuantityEditor:()=>{},loadInventory:async()=>{},showActionFeedback:()=>{},
  db:{collection:col=>({doc:id=>ref(col,id||'movement'),where(field,_op,value){const filters=[[field,value]];
    const query={where(f,_o,v){filters.push([f,v]);return query;},limit(){return query;},get:async()=>{const result=[...docs].filter(([path,data])=>path.startsWith(col+'/')&&filters.every(([f,v])=>data[f]===v)).map(([path])=>({ref:ref(col,path.split('/')[1])}));return {size:result.length,docs:result};}};return query;}})},
  runRoleTransaction:async fn=>{const writes=[];await fn({get:async r=>{if(writes.length)readAfterWrite=true;return {id:r.id,exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))};},set:(r,d,o)=>writes.push([r,d,!!o?.merge]),update:(r,d)=>writes.push([r,d,true])});if(fail)throw Error('network');for(const [r,d,merge] of writes)docs.set(r.path,{...(merge?docs.get(r.path):{}),...d});}
 });c.window=c;vm.runInContext(source,c);return {c,docs,messages,button,readAfterWrite:()=>readAfterWrite};
}
test('quantity editor atomically aligns manual count, warehouse, total and unknown-cost lot',async()=>{
 const f=fixture();await f.c.saveInventoryQuantity();
 assert.deepEqual(f.messages,[]);assert.equal(f.docs.get('inventory/P').onHand,15);
 assert.equal(f.docs.get('warehouseStocks/MAIN__P').onHand,15);
 assert.equal(f.docs.get('inventoryLots/COUNT-balance').remainingQty,10);
 assert.equal(f.docs.get('inventoryLots/COUNT-added').remainingQty,5);
 assert.equal(f.docs.get('inventoryLots/COUNT-added').unitCost,undefined);
 assert.equal(f.docs.get('inventoryMovements/movement').sourceId,'COUNT');
 assert.equal(f.readAfterWrite(),false);assert.equal(f.button.disabled,false);
 await f.c.saveInventoryQuantity();assert.equal(f.docs.get('inventoryLots/COUNT-added').remainingQty,5);
});
test('quantity editor reduces actual batches and keeps receipt identity',async()=>{
 const f=fixture({target:5,lots:[{id:'known',remainingQty:10,lotNo:'B'}]});await f.c.saveInventoryQuantity();
 assert.deepEqual(f.messages,[]);assert.equal(f.docs.get('inventoryLots/known').remainingQty,5);
 assert.equal(f.docs.get('inventoryLots/known').lotNo,'B');
 assert.equal(f.docs.get('inventoryMovements/movement').lotAllocations[0].qty,5);
 assert.equal(f.readAfterWrite(),false);
});
test('quantity editor reservation violation and failed commit leave all records unchanged',async()=>{
 for(const options of [{target:3,reserved:4},{target:15,fail:true}]){
  const f=fixture(options),before=structuredClone([...f.docs]);await f.c.saveInventoryQuantity();
  assert.equal(f.messages.length,1);assert.deepEqual([...f.docs],before);assert.equal(f.button.disabled,false);
 }
});
