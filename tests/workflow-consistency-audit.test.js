const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const inventory=require('../modules/inventory-core'),workflow=require('../modules/workflow-core');
const demandCore=require('../modules/procurement-demand-core'),fulfillment=require('../modules/fulfillment-core');

function allocationFixture({qty=5,incoming=0,fail=false,received=0}={}){
 const docs=new Map([
  ['orders/O',{ownerUid:'sales',salesCode:'S1',status:'active',createdAt:'2026-10-14',items:[{itemId:'I',productId:'P',warehouseId:'W',qty,reservedQty:0,shortageQty:qty,supplyOrderedQty:incoming+received,receivedQty:received}]}],
  ['inventoryReservations/R',{orderId:'O',itemId:'I',productKey:'P',warehouseId:'W',quantity:0,shortageQty:qty,status:'shortage'}],
  ['inventory/P',{onHand:5,reserved:0}],['warehouseStocks/W__P',{onHand:5,reserved:0}],
  ['procurementDemands/SALES_ORDER%3AO%3AI',demandCore.fromSalesOrder({sourceId:'O',sourceItemId:'I',shortageQty:qty,supplyOrderedQty:incoming+received,receivedQty:received})]
 ]);
 let sequence=0;const ref=path=>({path,id:path.split('/').at(-1)});
 const snapshot=path=>({exists:docs.has(path),id:path.split('/').at(-1),data:()=>structuredClone(docs.get(path))});
 const db={collection(name){const filters=[];return {doc:id=>ref(name+'/'+(id||'event-'+(++sequence))),where(key,op,value){filters.push([key,value]);return this;},limit(){return this;},startAfter(){return this;},async get(){const rows=[...docs].filter(([path,data])=>path.startsWith(name+'/')&&filters.every(([key,value])=>data[key]===value));return {docs:rows.map(([path])=>snapshot(path)),size:rows.length,empty:!rows.length};}}}};
 const c=vm.createContext({db,YushinInventory:inventory,YushinWorkflow:workflow,YushinProcurementDemand:demandCore,firestoreReadWithTimeout:p=>p,
  normalizedOrderItems:o=>o.items.map(fulfillment.normalizeItem),normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',
  itemDispatchState:(o,i)=>fulfillment.dispatchState(i),inventoryNumbers:inventory.normalizeStock,inventoryProductKey:i=>i.productId,orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus),
  warehouseStockDocId:(w,p)=>w+'__'+p,orderWorkIndexFields:()=>({}),inventoryMovementRecord:(type,qty)=>({type,qty}),invalidateWarehouseStockCache(){},
  runRoleTransaction:async fn=>{const writes=[];const result=await fn({get:async r=>{assert.equal(writes.length,0,'all reads precede writes');return snapshot(r.path);},update:(r,data)=>writes.push([r,data]),set:(r,data)=>writes.push([r,data])});if(fail)throw Error('permission-denied');for(const [r,data] of writes)docs.set(r.path,{...docs.get(r.path),...structuredClone(data)});return result;}});
 vm.runInContext(section('function procurementDemandForOrderItem(', 'function purchasingLifecycleSnapshot('),c);
 vm.runInContext(section('async function allocateFreeReceiptStockToShortages(', 'async function refreshAffectedOrderCaches('),c);
 return {c,docs,demand:()=>docs.get('procurementDemands/SALES_ORDER%3AO%3AI')};
}
test('receipt allocation atomically clears stale procurement demand and retry cannot reserve twice',async()=>{
 const f=allocationFixture();const result=await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester');
 assert.equal(result.allocatedQty,5);assert.equal(f.docs.get('orders/O').items[0].shortageQty,0);
 assert.equal(f.demand().remainingToOrderQty,0);assert.equal(f.demand().requestedQty,0);
 await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester');assert.equal(f.docs.get('inventory/P').reserved,5);
});
test('free receipt stock only covers uncovered demand, not quantities already ordered from supplier',async()=>{
 for(const incoming of [2,5]){
  const f=allocationFixture({incoming});await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester');
  assert.equal(f.docs.get('inventory/P').reserved,5-incoming);
  assert.equal(f.demand().remainingToOrderQty,0);assert.equal(f.demand().orderedQty,incoming);
 }
});
test('allocation preserves cumulative received history while reducing only open procurement',async()=>{
 const f=allocationFixture({qty:3,received:2});await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester');
 assert.equal(f.demand().receivedQty,2);assert.equal(f.demand().orderedQty,2);assert.equal(f.demand().requestedQty,2);
 assert.equal(f.demand().remainingToOrderQty,0);
});
test('failed allocation transaction leaves order, reservation, stock and demand unchanged',async()=>{
 const f=allocationFixture({fail:true});const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester'),/permission-denied/);
 assert.equal(JSON.stringify([...f.docs]),before);
});
test('transfer allocation uses its durable checkpoint and does not invent a supplier receipt',async()=>{
 const f=allocationFixture();f.docs.set('stockTransfers/T',{status:'RECEIVED',autoAllocationQty:5,autoAllocatedQty:0,allocationCompleted:false});
 await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester','','T','stockTransfers');
 assert.equal(f.docs.get('stockTransfers/T').autoAllocatedQty,5);assert.equal(f.docs.get('stockTransfers/T').allocationCompleted,true);
 assert.equal(f.demand().remainingToOrderQty,0);assert.equal([...f.docs.keys()].some(k=>k.startsWith('receipts/')),false);
 await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester','','T','stockTransfers');
 assert.equal(f.docs.get('inventory/P').reserved,5);
});
test('cancelled order cannot receive free-stock allocation',async()=>{
 const f=allocationFixture();f.docs.get('orders/O').status='cancelled';
 const result=await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester');
 assert.equal(result.allocatedQty,0);assert.equal(f.docs.get('inventory/P').reserved,0);
});
test('missing aggregate or in-progress order cannot receive an inconsistent warehouse-only allocation',async()=>{
 for(const type of ['missing','pending']){
  const f=allocationFixture();if(type==='missing')f.docs.delete('inventory/P');else f.docs.get('orders/O').inventoryReservationStatus='pending';
  const result=await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester');
  assert.equal(result.allocatedQty,0);assert.equal(f.docs.get('warehouseStocks/W__P').reserved,0);assert.equal(f.demand().remainingToOrderQty,5);
 }
});
test('engineer can retry own order, but creator metadata cannot grant another owner access',()=>{
 const c=vm.createContext({currentUserRole:'engineer',currentUser:{uid:'E'}});
 vm.runInContext(section('function canRetryOrderInventorySync(', 'function orderInventorySyncStatusHtml('),c);
 assert.equal(c.canRetryOrderInventorySync({ownerUid:'E'}),true);
 assert.equal(c.canRetryOrderInventorySync({ownerUid:'OTHER',createdByUid:'E'}),false);
 for(const role of ['sales','engineer','purchaser','admin','warehouse']){c.currentUserRole=role;assert.equal(c.canRetryOrderInventorySync({ownerUid:'E'}),role!=='warehouse');}
});
test('direct arrival belongs to exact commercial owner; ordinary warehouse receipt keeps its three operational roles',()=>{
 const c=vm.createContext({currentUser:{uid:'OWNER'},currentUserRole:'sales'});
 vm.runInContext(section('function canReceiveInventoryCapability(', 'function canManageEquipmentCapability('),c);
 for(const role of ['sales','engineer','purchaser','warehouse','admin']){
  c.currentUserRole=role;
  assert.equal(c.canConfirmSupplyReceipt({fulfillmentType:'DIRECT_SHIP',ownerUid:'OWNER'}),['sales','engineer','admin'].includes(role));
  assert.equal(c.canConfirmSupplyReceipt({fulfillmentType:'DIRECT_SHIP',ownerUid:'OTHER'}),role==='admin');
  assert.equal(c.canConfirmSupplyReceipt({fulfillmentType:'WAREHOUSE'}),['purchaser','warehouse','admin'].includes(role));
 }
});
test('shared duplicate check finds same-brand product after first fifty exact-code matches including inactive products',async()=>{
 let reads=0;const pages=Array.from({length:51},(_,i)=>({id:String(i),data:()=>({brandName:i===50?'Target':'Other',active:false})}));
 const c=vm.createContext({normalizeItemCodeLoose:x=>x,normalizeBrandLookupKey:x=>x,resolveBrandName:x=>x,firestoreReadWithTimeout:p=>p,
  db:{collection:()=>{let cursor=-1;return {where(){return this;},limit(n){assert.equal(n,50);return this;},startAfter(d){cursor=Number(d.id);return this;},async get(){reads++;const docs=pages.slice(cursor+1,cursor+51);return {docs,size:docs.length};}};}}});
 vm.runInContext(section('async function findDuplicateProductMaster(', 'function syncSavedProductMaster('),c);
 assert.equal((await c.findDuplicateProductMaster('Target','A')).id,'50');assert.equal(reads,2);
 assert.equal(await c.findDuplicateProductMaster('Target','A','50'),null);
});
test('saved product synchronizes product page and invalidates old search results without extra database reads',()=>{
 let rendered=0,lookup;const c=vm.createContext({productManagementResults:[],productManagementSearchCache:new Map([['old',[]]]),productManagementSearchGeneration:2,productBrandBrowseGeneration:3,productManagementSearchInProgress:true,productManagementActiveSearch:'old',
  productMasterDocToPriceItem:d=>({...d.data(),productId:d.id}),cacheProductLookupItem:item=>lookup=item,renderProductManagementResults:()=>rendered++,updateProductSearchControls(){},updateProductManagementMoreButton(){}});
 vm.runInContext(section('function syncSavedProductMaster(', 'window.saveProductMasterEditor ='),c);
 c.syncSavedProductMaster('P',{productName:'New'});c.syncSavedProductMaster('P',{productName:'Updated'});
 assert.equal(c.productManagementResults.length,1);assert.equal(c.productManagementResults[0].productName,'Updated');
 assert.equal(c.productManagementSearchCache.size,0);assert.equal(c.productManagementSearchGeneration,4);assert.equal(c.productBrandBrowseGeneration,5);
 assert.equal(lookup.productId,'P');assert.equal(rendered,2);
 assert.equal(c.productManagementSearchInProgress,false);assert.equal(c.productManagementActiveSearch,null);
});
