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
 const db={collection(name){const filters=[];let max=Infinity,cursor='';return {doc:id=>ref(name+'/'+(id||'event-'+(++sequence))),where(key,op,value){filters.push([key,value]);return this;},limit(qty){max=qty;return this;},startAfter(doc){cursor=doc.id;return this;},async get(){const rows=[...docs].filter(([path,data])=>path.startsWith(name+'/')&&path.split('/').at(-1)>cursor&&filters.every(([key,value])=>data[key]===value)).sort(([a],[b])=>a.localeCompare(b)).slice(0,max);return {docs:rows.map(([path])=>snapshot(path)),size:rows.length,empty:!rows.length};}}}};
 const c=vm.createContext({db,YushinInventory:inventory,YushinWorkflow:workflow,YushinProcurementDemand:demandCore,YushinReservation:require('../modules/reservation-core'),firestoreReadWithTimeout:p=>p,
  normalizedOrderItems:o=>o.items.map(fulfillment.normalizeItem),normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',
  itemDispatchState:(o,i)=>fulfillment.dispatchState(i),inventoryNumbers:inventory.normalizeStock,inventoryProductKey:i=>i.productId,orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus),
  warehouseStockDocId:(w,p)=>w+'__'+p,orderWorkIndexFields:()=>({}),inventoryMovementRecord:(type,qty,sourceId,productKey,actor,extra)=>({type,qty,sourceId,productKey,actorUid:'receiver',...extra}),invalidateWarehouseStockCache(){},
  runRoleTransaction:async fn=>{const writes=[];const result=await fn({get:async r=>{assert.equal(writes.length,0,'all reads precede writes');return snapshot(r.path);},update:(r,data)=>writes.push([r,data]),set:(r,data)=>writes.push([r,data])});if(fail)throw Error('permission-denied');for(const [r,data] of writes)docs.set(r.path,{...docs.get(r.path),...structuredClone(data)});return result;}});
 vm.runInContext(section('function procurementDemandForOrderItem(', 'function purchasingLifecycleSnapshot('),c);
 vm.runInContext(section('async function allocateFreeReceiptStockToShortages(', 'async function receiveSupplyOrderRecord('),c);
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
function addWaitingAllocation(f,id,orderId,date,{status='shortage',quantity=0,cancelled=false,documentIdField}={}){
 const item={itemId:'I',productId:'P',warehouseId:'W',qty:3,reservedQty:quantity,shortageQty:3-quantity,supplyOrderedQty:0,receivedQty:0};
 f.docs.set('orders/'+orderId,{ownerUid:'sales',salesCode:'S1',status:cancelled?'cancelled':'active',orderDate:date,items:[item]});
 f.docs.set('inventoryReservations/'+id,{orderId,itemId:'I',orderDate:date,productKey:'P',warehouseId:'W',quantity,shortageQty:3-quantity,status,...(documentIdField?{id:documentIdField}:{})});
}
function addIrrelevantAllocationPages(f,count=550){
 for(let i=0;i<count;i++)f.docs.set('inventoryReservations/FILL-'+String(i).padStart(4,'0'),{orderId:'OTHER-'+i,itemId:'I',productKey:'P',warehouseId:'OTHER',shortageQty:1,status:'shortage'});
}
test('receipt FIFO scans past 500 rows and uses the actual reservation ID despite embedded stale IDs',async()=>{
 const f=allocationFixture();addIrrelevantAllocationPages(f);addWaitingAllocation(f,'Z-OLDEST','OLD','2026-01-01',{documentIdField:'STALE-ID'});
 const result=await f.c.allocateFreeReceiptStockToShortages('P','W',1,'Tester');
 assert.equal(f.docs.get('inventoryReservations/Z-OLDEST').quantity,1);assert.equal(f.docs.get('orders/OLD').items[0].reservedQty,1);
 assert.equal(f.docs.get('orders/O').items[0].reservedQty,0);assert.equal(result.affectedOrderIds[0],'OLD');assert.equal(f.docs.has('inventoryReservations/STALE-ID'),false);
});
test('receipt allocation compares active and shortage candidates using the same shared priority',async()=>{
 const f=allocationFixture();addWaitingAllocation(f,'Z-ACTIVE','ACTIVE','2026-01-01',{status:'active',quantity:1});
 addWaitingAllocation(f,'A-SHORTAGE','SHORT','2026-02-01');f.docs.get('inventory/P').reserved=1;f.docs.get('warehouseStocks/W__P').reserved=1;
 await f.c.allocateFreeReceiptStockToShortages('P','W',1,'Tester');
 assert.equal(f.docs.get('orders/ACTIVE').items[0].reservedQty,2);assert.equal(f.docs.get('orders/SHORT').items[0].reservedQty,0);
});
test('receipt FIFO date ties use order and item priority instead of discovery or reservation ID order',async()=>{
 const f=allocationFixture();addWaitingAllocation(f,'Z-DOC','A-ORDER','2026-01-01');addWaitingAllocation(f,'A-DOC','Z-ORDER','2026-01-01');
 await f.c.allocateFreeReceiptStockToShortages('P','W',1,'Tester');
 assert.equal(f.docs.get('orders/A-ORDER').items[0].reservedQty,1);assert.equal(f.docs.get('orders/Z-ORDER').items[0].reservedQty,0);
});
test('a stale cancelled oldest candidate past the page boundary cannot block the next valid order',async()=>{
 const f=allocationFixture();addIrrelevantAllocationPages(f);addWaitingAllocation(f,'Z-CANCELLED','CANCEL','2025-01-01',{cancelled:true});addWaitingAllocation(f,'Z-VALID','VALID','2026-01-01');
 await f.c.allocateFreeReceiptStockToShortages('P','W',1,'Tester');
 assert.equal(f.docs.get('orders/CANCEL').items[0].reservedQty,0);assert.equal(f.docs.get('orders/VALID').items[0].reservedQty,1);
});
test('later candidate page failure leaves the persistent allocation checkpoint and stock unchanged for retry',async()=>{
 const f=allocationFixture();addIrrelevantAllocationPages(f);addWaitingAllocation(f,'Z-OLDEST','OLD','2026-01-01');
 f.docs.set('receipts/PAGED',{autoAllocationQty:1,autoAllocatedQty:0,allocationCompleted:false});const before=JSON.stringify([...f.docs]);
 f.c.firestoreReadWithTimeout=async promise=>{const result=await promise;if(result.docs[0]?.id==='FILL-0050')throw Error('offline page');return result;};
 await assert.rejects(f.c.allocateFreeReceiptStockToShortages('P','W',1,'Tester','','PAGED'),/offline page/);
 assert.equal(JSON.stringify([...f.docs]),before);f.c.firestoreReadWithTimeout=p=>p;
 await f.c.allocateFreeReceiptStockToShortages('P','W',1,'Tester','','PAGED');
 assert.equal(f.docs.get('orders/OLD').items[0].reservedQty,1);assert.equal(f.docs.get('receipts/PAGED').autoAllocatedQty,1);assert.equal(f.docs.get('receipts/PAGED').allocationCompleted,true);
});
test('a repeated candidate page fails visibly instead of looping or publishing incomplete allocation',async()=>{
 const f=allocationFixture();addIrrelevantAllocationPages(f,60);let first=null;const before=JSON.stringify([...f.docs]);
 f.c.firestoreReadWithTimeout=async promise=>{const result=await promise;if(result.size>0){first=first||result;return first;}return result;};
 await assert.rejects(f.c.allocateFreeReceiptStockToShortages('P','W',1,'Tester'),/分頁未前進/);assert.equal(JSON.stringify([...f.docs]),before);
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
 let rendered=0,lookup;const c=vm.createContext({invalidateProductFrequentCache(){},productManagementResults:[],productManagementSearchCache:new Map([['old',[]]]),productManagementSearchGeneration:2,productBrandBrowseGeneration:3,productManagementSearchInProgress:true,productManagementActiveSearch:'old',
  productMasterDocToPriceItem:d=>({...d.data(),productId:d.id}),cacheProductLookupItem:item=>lookup=item,renderProductManagementResults:()=>rendered++,updateProductSearchControls(){},updateProductManagementMoreButton(){}});
 vm.runInContext(section('function syncSavedProductMaster(', 'window.saveProductMasterEditor ='),c);
 c.syncSavedProductMaster('P',{productName:'New'});c.syncSavedProductMaster('P',{productName:'Updated'});
 assert.equal(c.productManagementResults.length,1);assert.equal(c.productManagementResults[0].productName,'Updated');
 assert.equal(c.productManagementSearchCache.size,0);assert.equal(c.productManagementSearchGeneration,4);assert.equal(c.productBrandBrowseGeneration,5);
 assert.equal(lookup.productId,'P');assert.equal(rendered,2);
 assert.equal(c.productManagementSearchInProgress,false);assert.equal(c.productManagementActiveSearch,null);
});

function recoveryOptions(f){
 f.docs.set('warehouses/W',{active:true});const stock=f.docs.get('warehouseStocks/W__P');
 Object.assign(stock,{productKey:'P',warehouseId:'W',allocationPending:true,allocationRevision:1});f.docs.get('inventory/P').productKey='P';
 return {db:f.c.db,runTransaction:f.c.runRoleTransaction,allocate:f.c.allocateFreeReceiptStockToShortages,normalize:inventory.normalizeStock,stockDocId:(w,p)=>w+'__'+p,assertContext(){},stockId:'W__P',actor:'Tester'};
}
test('released stock recovery uses actual allocation transactions and clears only uncovered procurement',async()=>{
 const f=allocationFixture({incoming:2}),options=recoveryOptions(f),recover=require('../modules/free-stock-recovery').recoverLocation;
 const result=await recover(options);await recover(options);
 assert.equal(result.allocatedQty,3);assert.equal(f.docs.get('inventory/P').reserved,3);assert.equal(f.docs.get('inventoryReservations/R').quantity,3);
 assert.equal(f.docs.get('orders/O').items[0].reservedQty,3);assert.equal(f.demand().orderedQty,2);assert.equal(f.demand().remainingToOrderQty,0);
 assert.equal(f.docs.get('warehouseStocks/W__P').allocationPending,false);
 const movement=[...f.docs.values()].find(row=>row.type==='reserve_from_free_stock');assert.equal(movement.ownerUid,'sales');assert.equal(movement.salesCode,'S1');assert.equal(movement.actorUid,'receiver');
});
test('actual recovery rejects inconsistent order reservation before changing any fact',async()=>{
 const f=allocationFixture(),options=recoveryOptions(f),recover=require('../modules/free-stock-recovery').recoverLocation;
 f.docs.get('orders/O').items[0].reservedQty=1;const before=JSON.stringify([...f.docs]);
 await assert.rejects(recover(options),/預留數量不一致/);assert.equal(JSON.stringify([...f.docs]),before);
});

test('recovery resumes after a partially committed allocation without adding stock or reserving twice',async()=>{
 const f=allocationFixture(),options=recoveryOptions(f),recover=require('../modules/free-stock-recovery').recoverLocation,allocate=options.allocate;
 options.allocate=async(...args)=>{args[2]=1;await allocate(...args);throw Error('response lost');};
 await assert.rejects(recover(options),/response lost/);assert.equal(f.docs.get('inventory/P').reserved,1);assert.equal(f.docs.get('warehouseStocks/W__P').allocationPending,true);
 options.allocate=allocate;await recover(options);await recover(options);
 assert.equal(f.docs.get('inventory/P').onHand,5);assert.equal(f.docs.get('inventory/P').reserved,5);assert.equal(f.docs.get('inventoryReservations/R').quantity,5);assert.equal(f.demand().remainingToOrderQty,0);
});

test('transaction retry that loses its allocation candidate cannot publish the aborted attempt quantity',async()=>{
 const f=allocationFixture(),run=f.c.runRoleTransaction;let retried=false;
 f.c.runRoleTransaction=async fn=>{
  if(!retried){retried=true;await fn({get:async r=>({exists:f.docs.has(r.path),id:r.id,data:()=>structuredClone(f.docs.get(r.path))}),set(){},update(){}});f.docs.get('orders/O').status='cancelled';}
  return run(fn);
 };
 const result=await f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester');
 assert.equal(result.allocatedQty,0);assert.equal(f.docs.get('inventory/P').reserved,0);assert.equal(f.docs.get('inventoryReservations/R').quantity,0);
});

test('affected-order cache refresh rejects account or role change without populating the new session cache',async()=>{
 for(const change of [c=>{c.currentUser={uid:'NEW'};},c=>{c.currentUserRole='sales';}]){
  const c=vm.createContext({currentUser:{uid:'OLD'},currentUserRole:'warehouse',ordersCache:[],readDocumentsByIds:async()=>{change(c);return [{id:'PRIVATE'}];},syncOrderIntoPurchasingCaches(){throw Error('must not update cache');},writeAppDataCache(){throw Error('must not persist cache');}});
  vm.runInContext(section('async function refreshAffectedOrderCaches(', 'function canBusinessSelfOrder'),c);
  await assert.rejects(c.refreshAffectedOrderCaches(['PRIVATE']),/帳號或角色已變更/);assert.equal(c.ordersCache.length,0);
 }
});

test('free receipt allocation validates raw company and warehouse accounts without concealing another hold',async()=>{
 for(const mutate of [
  f=>f.docs.get('inventory/P').onHand=NaN,
  f=>Object.assign(f.docs.get('inventory/P'),{reserved:6}),
  f=>Object.assign(f.docs.get('warehouseStocks/W__P'),{reserved:6}),
  f=>f.docs.get('warehouseStocks/W__P').transferFreeInTransit=-1,
  f=>f.docs.get('orders/O').items[0].reservedQty=null
 ]){
  const f=allocationFixture();mutate(f);const before=structuredClone([...f.docs]);
  await assert.rejects(f.c.allocateFreeReceiptStockToShortages('P','W',5,'Tester'),/數量不正確|異常|不一致/);
  assert.deepEqual([...f.docs],before);
 }
});
test('same product receipt allocation leaves another warehouse stock and reservations unchanged',async()=>{
 const f=allocationFixture();
 f.docs.set('warehouseStocks/OTHER__P',{productKey:'P',warehouseId:'OTHER',onHand:8,reserved:4});
 f.docs.set('inventory/P',{productKey:'P',onHand:13,reserved:4});
 f.docs.set('inventoryReservations/OTHER',{orderId:'OTHER',itemId:'J',productKey:'P',warehouseId:'OTHER',quantity:4,shortageQty:0,status:'active'});
 const before=structuredClone([f.docs.get('warehouseStocks/OTHER__P'),f.docs.get('inventoryReservations/OTHER')]);
 await f.c.allocateFreeReceiptStockToShortages('P','W',3,'Tester');
 assert.equal(f.docs.get('warehouseStocks/W__P').reserved,3);assert.equal(f.docs.get('inventory/P').reserved,7);
 assert.deepEqual([f.docs.get('warehouseStocks/OTHER__P'),f.docs.get('inventoryReservations/OTHER')],before);
});

test('actual purchasing projection excludes warehouse shipments awaiting acknowledgement',()=>{
 const c=vm.createContext({YushinWorkflow:workflow,YushinProcurementDemand:demandCore,YushinFulfillment:fulfillment,
  itemDispatchState:()=>({grossDelivered:0,delivered:0,returned:0})});
 vm.runInContext(section('function procurementDemandForOrderItem(', 'function purchasingLifecycleSnapshot('),c);
 const item={itemId:'I',productId:'P',qty:10,reservedQty:4,shortageQty:6,supplyOrderedQty:3,receivedQty:1,warehouseShippedQty:4};
 const order={id:'O',items:[item],warehouseShipmentRecords:[{id:'S',orderId:'O',itemId:'I',productKey:'P',
  warehouseId:'A',date:'2026-10-17',qty:4,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}],deliveryRecords:[]};
 const demand=c.procurementDemandForOrderItem(order,item);
 assert.equal(demand.requestedQty,3);assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,2);
 order.warehouseShipmentRecords[0].sourceType='UNRECOGNIZED';
 assert.throws(()=>c.procurementDemandForOrderItem(order,item));
});

test('actual purchasing projection keeps CLOSE returns closed after receipt and pending acknowledgement',()=>{
 const c=vm.createContext({YushinWorkflow:workflow,YushinProcurementDemand:demandCore,YushinFulfillment:fulfillment,
  itemDispatchState:()=>({grossDelivered:2,delivered:2,returned:1})});
 vm.runInContext(section('function procurementDemandForOrderItem(', 'function purchasingLifecycleSnapshot('),c);
 const item={itemId:'I',productId:'P',qty:10,reservedQty:4,shortageQty:2,supplyOrderedQty:3,receivedQty:1,warehouseShippedQty:4,returnedQty:1};
 const order={id:'O',items:[item],warehouseShipmentRecords:[{id:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-17',qty:4,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}],
  deliveryRecords:[{id:'D',shipmentId:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-17',qty:2,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}],
  returnRecords:[{id:'R',shipmentId:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-17',qty:1,sourceType:'WAREHOUSE_CUSTOMER_RETURN',condition:'RESTOCKABLE',settlement:'CLOSE'}]};
 const demand=c.procurementDemandForOrderItem(order,item);
 assert.equal(demand.requestedQty,3);assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,2);
 item.receivedQty=2;item.reservedQty=5;item.shortageQty=1;
 const next=c.procurementDemandForOrderItem(order,item);assert.equal(next.requestedQty,3);assert.equal(next.remainingToOrderQty,0);assert.equal(next.remainingToReceiveQty,1);
});


test('actual normalized CLOSE return and v2 dispatch feed total physical returns to purchasing without reopening demand',()=>{
 const c=vm.createContext({YushinWorkflow:workflow,YushinProcurementDemand:demandCore,YushinFulfillment:fulfillment,
  YUSHIN_V2_DISPATCH_EMULATOR:true,orderInventorySyncIncomplete:()=>false,
  brandIdentityForRecord:item=>({brand:item.brand||'',brandId:item.brandId||''}),normalizeHistoryItemCode:x=>x,parseMoney:Number});c.window=c;
 vm.runInContext(section('function normalizedOrderItems(', 'function ensureOrderItemCompatibility('),c);
 vm.runInContext(section('function itemDispatchState(', 'function orderLifecycleActionButtons('),c);
 vm.runInContext(section('function procurementDemandForOrderItem(', 'function purchasingLifecycleSnapshot('),c);
 const item={itemId:'I',productId:'P',qty:12,reservedQty:5,shortageQty:3,supplyOrderedQty:4,receivedQty:4,
  warehouseShippedQty:4,dispatchPreparedQty:9,deliveredQty:4,returnedQty:2};
 const order={id:'O',items:[item],warehouseShipmentRecords:[{id:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-21',qty:4,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}],
  deliveryRecords:[{id:'D',shipmentId:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-21',qty:4,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}],
  returnRecords:[{id:'R',shipmentId:'S',orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',date:'2026-10-21',qty:2,sourceType:'WAREHOUSE_CUSTOMER_RETURN',condition:'RESTOCKABLE',settlement:'CLOSE'}]};
 const normalized=c.normalizedOrderItems(order)[0];assert.equal(normalized.returnedQty,0);assert.equal(item.returnedQty,2);
 assert.equal(c.itemDispatchState(order,normalized).returned,2);
 const before=structuredClone(order),demand=c.procurementDemandForOrderItem(order,normalized);
 assert.equal(demand.remainingToOrderQty,3);assert.equal(demand.remainingToReceiveQty,0);assert.deepEqual(order,before);
 // The same projection guard must still reject stale stored totals and unsupported replacement returns.
 item.returnedQty=1;assert.throws(()=>c.procurementDemandForOrderItem(order,normalized));item.returnedQty=2;
 order.returnRecords[0].settlement='REPLACE';assert.throws(()=>c.procurementDemandForOrderItem(order,normalized));
});
