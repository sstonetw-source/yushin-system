const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const inventory=require('../modules/inventory-core.js');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function deliveryContext(lotQuantities=[1,1]){
 const writes=[],reads=[];
 const data={inventory:{onHand:10,reserved:2,incoming:0},warehouse:{onHand:10,reserved:2,incoming:0},reservation:{productKey:'P',warehouseId:'W',quantity:2},'inventoryLots/A':{productKey:'P',warehouseId:'W',remainingQty:lotQuantities[0]},'inventoryLots/B':{productKey:'P',warehouseId:'W',remainingQty:lotQuantities[1]}};
 const ref=path=>({path,id:path.split('/').at(-1)});
 const tx={get:async reference=>{assert.ok(reference.path,'transaction must receive a document, never a query');assert.equal(writes.length,0,'all reads precede all writes');reads.push(reference.path);return {id:reference.id,exists:!!data[reference.path],data:()=>data[reference.path]};},update:(reference,value)=>writes.push({path:reference.path,value}),set:(reference,value)=>writes.push({path:reference.path,value})};
 const query={get:async()=>({docs:[{ref:ref('inventoryLots/A')},{ref:ref('inventoryLots/B')}]})};
 query.where=()=>query;
 const db={collection:name=>({doc:id=>ref(name==='inventoryReservations'?'reservation':`${name}/${id||'generated'}`),where:()=>query})};
 const c=vm.createContext({db,window:{},console,Date,Promise,inventoryProductKey:()=> 'P',defaultWarehouse:()=>({id:'W'}),inventoryRefFor:()=>ref('inventory'),warehouseStockDocId:()=> 'stock',inventoryNumbers:x=>x,warehouseMasterCache:[],savedDeliveryRecords:o=>o.deliveryRecords||[],inventoryMovementRecord:()=>({}),inventoryReservationPayload:(_id,_order,quantity)=>({quantity}),YushinInventory:inventory,YushinReservation:require('../modules/reservation-core'),normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal'});
 data['warehouseStocks/stock']=data.warehouse;
 vm.runInContext(section('async function applyInventoryDeliveryDeltaInTransaction','\nfunction applyInventoryDeliveryInTransaction'),c);
 return {c,tx,writes,reads,data};
}
test('Web delivery reads each lot document transactionally and deducts across two batches',async()=>{
 const {c,tx,writes,reads}=deliveryContext();
 const result=await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},2,'actor','O');
 assert.deepEqual(Array.from(result.lotAllocations,row=>row.qty),[1,1]);
 assert.ok(reads.includes('inventoryLots/A')&&reads.includes('inventoryLots/B'));
 assert.equal(writes.find(row=>row.path==='warehouseStocks/stock').value.onHand,8);
 assert.equal(writes.find(row=>row.path==='inventoryLots/A').value.remainingQty,0);
});
test('concurrent lot depletion prevents every delivery write',async()=>{
 const {c,tx,writes}=deliveryContext([0,1]);
 await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},2,'actor','O'));
 assert.equal(writes.length,0);
});
test('business delivery transaction rejects premature parcel delivery while preserving warehouse dispatch and main pickup',async()=>{
 for(const [mode,warehouseId] of [['SALES_SHIP','W'],['CUSTOMER_SHIP','W'],['','W'],['PICKUP','BRANCH']]){
  const {c,tx,writes}=deliveryContext();c.YushinWarehouseLogistics=require('../modules/warehouse-logistics');c.canReceiveInventoryCapability=()=>false;
  await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId,shippingInstructions:{mode}},2,'sales','O'),/不能登錄|先完成調回/);assert.equal(writes.length,0);
 }
 for(const [mode,operational] of [['PICKUP',false],['CUSTOMER_SHIP',true]]){
  const {c,tx,writes}=deliveryContext();c.YushinWarehouseLogistics=require('../modules/warehouse-logistics');c.canReceiveInventoryCapability=()=>operational;
  await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W',shippingInstructions:{mode}},2,'actor','O');assert(writes.length>0);
 }
 const {c,tx,writes}=deliveryContext();c.YushinWarehouseLogistics=require('../modules/warehouse-logistics');c.canReceiveInventoryCapability=()=>false;
 await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W',fulfillmentType:'DIRECT_SHIP'},2,'sales','O');assert.equal(writes.length,0);
});
test('reversing multiple delivery lots reads all documents before any write',async()=>{
 const {c,tx,writes}=deliveryContext([0,0]);
 const records=[{qty:2,lotAllocations:[{lotId:'A',qty:1,cost:0},{lotId:'B',qty:1,cost:0}]}];
 await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},-2,'actor','O',records);
 assert.equal(writes.find(row=>row.path==='inventoryLots/A').value.remainingQty,1);
 assert.equal(writes.find(row=>row.path==='inventoryLots/B').value.remainingQty,1);
});
test('reversing several allocations of one lot restores the summed quantity with one lot write',async()=>{
 const {c,tx,writes,reads}=deliveryContext([2,0]);
 const records=[{qty:3,lotAllocations:[{lotId:'A',qty:3,cost:0}]},{qty:2,lotAllocations:[{lotId:'A',qty:2,cost:0}]}];
 await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},-5,'actor','O',records);
 const lotWrites=writes.filter(row=>row.path==='inventoryLots/A');
 assert.equal(lotWrites.length,1);assert.equal(lotWrites[0].value.remainingQty,7);
 assert.equal(reads.filter(value=>value==='inventoryLots/A').length,1);
 assert.equal(writes.find(row=>row.path==='warehouseStocks/stock').value.onHand,15);
 assert.equal(writes.find(row=>row.path==='reservation').value.quantity,7);
});
test('order cancellation explains remaining quantity and PO impact; complete orders are blocked',()=>{
 let message='',alerted='';
 const c=vm.createContext({deliveryProgressInfo:o=>o.progress,normalizedOrderItems:o=>o.items,confirm:value=>{message=value;return true;},alert:value=>alerted=value});
 vm.runInContext(section('function confirmOrderCancellation','\nwindow.quickSetOrderLifecycle'),c);
 assert.equal(c.confirmOrderCancellation({progress:{remaining:2,delivered:1},items:[{reservedQty:1,supplyOrderedQty:3,receivedQty:1,purchaseDocumentNos:['PO-1']}]}),true);
 assert.match(message,/取消剩餘未送貨數量：2/);assert.match(message,/採購單不會自動取消/);assert.match(message,/PO-1/);
 message='';assert.equal(c.confirmOrderCancellation({progress:{remaining:0},items:[]}),false);assert.equal(message,'');assert.match(alerted,/退貨流程/);
});
test('dispatch export rejects stale warehouse or quantity before exporting without writing business records',async()=>{
 let downloads=0,feedback='';
 const draft={orderId:'O',groups:[{warehouseId:'W',items:[{itemId:'I',qty:2}]}]};
 const c=vm.createContext({window:{},JSON,dispatchListDraft:draft,currentUserRole:'admin',canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,document:{getElementById:()=>({value:'filled'}),querySelectorAll:()=>[]},beginActionButton:()=>({}),endActionButton:()=>{},firestoreReadWithTimeout:async()=>({exists:true,data:()=>({items:[{itemId:'I',warehouseId:'OTHER'}]})}),db:{collection:()=>({doc:()=>({get:()=>null})})},normalizedOrderStatus:()=> 'normal',orderInventorySyncIncomplete:()=>false,normalizedOrderItems:o=>o.items,itemDispatchState:()=>({pending:2,shippable:0}),defaultWarehouse:()=>({id:'W'}),showActionFeedback:value=>feedback=value,XLSX:{writeFile:()=>downloads++}});c.window=c;
 vm.runInContext(section('window.exportWarehouseDispatchList=', '\nwindow.openRelatedOrderPurchase'),c);
 await c.exportWarehouseDispatchList('excel',{});assert.equal(downloads,0);assert.match(feedback,/倉庫已變更/);
});

test('inventory workspace shipment rejects inconsistent stock reservations before writes',async()=>{
 for(const key of ['inventory','warehouse','reservation']){
  const {c,tx,writes,data}=deliveryContext();
  if(key==='reservation')data.reservation.quantity=1;else data[key].reserved=1;
  await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W',requireStockReservation:true},2,'actor','O'));
  assert.equal(writes.length,0);
 }
});

test('shared delivery service validates raw stock and reservation identity before reading any lot or queuing writes',async()=>{
 for(const mutate of [
  data=>data.inventory.onHand=1,
  data=>delete data.inventory,
  data=>data.inventory.reserved=1,
  data=>data.warehouse.reserved=1,
  data=>data.reservation.productKey='OTHER',
  data=>data.reservation.warehouseId='OTHER',
  ...[null,NaN,Infinity,-1,'bad','',true].flatMap(value=>[
   data=>data.reservation.quantity=value,
   data=>data.inventory.reserved=value,
   data=>data.warehouse.onHand=value
  ])
 ]){
  const {c,tx,writes,reads,data}=deliveryContext();
  mutate(data);const before=structuredClone(data);
  await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},2,'actor','O'),/不足|庫存|不一致|核對/);
  assert.equal(writes.length,0);assert.equal(reads.some(path=>path.startsWith('inventoryLots/')),false);
  assert.deepEqual(data,before);
 }
});
test('legacy delivery cannot use another orders reserved stock or free stock travelling between warehouses',async()=>{
 for(const stockKey of ['inventory','warehouse']){
  const {c,tx,writes,data}=deliveryContext();
  data.reservation.quantity=1;data[stockKey].reserved=10;
  await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},2,'actor','O'),/可出貨實貨不足/);
  assert.equal(writes.length,0);
  data[stockKey].reserved=2;data[stockKey].transferFreeInTransit=8;
  await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},2,'actor','O'),/調撥途中/);
  assert.equal(writes.length,0);
 }
});
test('legacy partially unreserved delivery deducts its own hold and genuine free stock without releasing others',async()=>{
 const {c,tx,writes,data}=deliveryContext();data.reservation.quantity=1;
 const result=await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W',reservedQty:1},2,'actor','O');
 assert.equal(result.reservedDelta,-1);assert.equal(result.newReservedQty,0);
 assert.equal(writes.find(row=>row.path==='inventory').value.reserved,1);
 assert.equal(writes.find(row=>row.path==='warehouseStocks/stock').value.reserved,1);
 assert.equal(writes.find(row=>row.path==='inventory').value.onHand,8);
});

test('delivery reversal validates every original batch warehouse and product before queuing any restoration',async()=>{
 for(const change of [{warehouseId:'OTHER'},{productKey:'OTHER'},{remainingQty:NaN},{remainingQty:-1}]){
  const {c,tx,writes,data}=deliveryContext([0,0]);Object.assign(data['inventoryLots/B'],change);
  const records=[{qty:2,lotAllocations:[{lotId:'A',qty:1},{lotId:'B',qty:1}]}];
  const before=structuredClone(data);
  await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},-2,'actor','O',records),/原出貨批次/);
  assert.equal(writes.length,0);assert.deepEqual(data,before);
 }
});

test('cancelled-order delivery reversal restores free stock and releases its residual reservation',async()=>{
 const {c,tx,writes}=deliveryContext([0,0]);
 await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W',status:'cancelled'},-2,'actor','O',
  [{qty:2,lotAllocations:[{lotId:'A',qty:1},{lotId:'B',qty:1}]}]);
 assert.equal(writes.find(row=>row.path==='inventory').value.onHand,12);
 assert.equal(writes.find(row=>row.path==='inventory').value.reserved,0);
 assert.equal(writes.find(row=>row.path==='reservation').value.quantity,0);
});
test('delivery reversal rejects insufficient company or warehouse reservation before restoring any batch',async()=>{
 for(const key of ['inventory','warehouse']){
  const {c,tx,writes,reads,data}=deliveryContext([0,0]);data[key].reserved=1;
  await assert.rejects(c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},-2,'actor','O',
   [{qty:2,lotAllocations:[{lotId:'A',qty:1},{lotId:'B',qty:1}]}]),/不足/);
  assert.equal(writes.length,0);assert.equal(reads.some(path=>path.startsWith('inventoryLots/')),false);
 }
});
