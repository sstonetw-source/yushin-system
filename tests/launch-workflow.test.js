const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const inventory=require('../modules/inventory-core.js');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a+start.length);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function deliveryContext(lotQuantities=[1,1]){
 const writes=[],reads=[];
 const data={inventory:{onHand:10,reserved:2,incoming:0},warehouse:{onHand:10,reserved:2,incoming:0},reservation:{quantity:2},'inventoryLots/A':{productKey:'P',warehouseId:'W',remainingQty:lotQuantities[0]},'inventoryLots/B':{productKey:'P',warehouseId:'W',remainingQty:lotQuantities[1]}};
 const ref=path=>({path,id:path.split('/').at(-1)});
 const tx={get:async reference=>{assert.ok(reference.path,'transaction must receive a document, never a query');assert.equal(writes.length,0,'all reads precede all writes');reads.push(reference.path);return {id:reference.id,exists:!!data[reference.path],data:()=>data[reference.path]};},update:(reference,value)=>writes.push({path:reference.path,value}),set:(reference,value)=>writes.push({path:reference.path,value})};
 const query={get:async()=>({docs:[{ref:ref('inventoryLots/A')},{ref:ref('inventoryLots/B')}]})};
 query.where=()=>query;
 const db={collection:name=>({doc:id=>ref(name==='inventoryReservations'?'reservation':`${name}/${id||'generated'}`),where:()=>query})};
 const c=vm.createContext({db,window:{},console,Date,Promise,inventoryProductKey:()=> 'P',defaultWarehouse:()=>({id:'W'}),inventoryRefFor:()=>ref('inventory'),warehouseStockDocId:()=> 'stock',inventoryNumbers:x=>x,warehouseMasterCache:[],savedDeliveryRecords:o=>o.deliveryRecords||[],inventoryMovementRecord:()=>({}),inventoryReservationPayload:()=>({}),YushinInventory:inventory});
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
test('reversing multiple delivery lots reads all documents before any write',async()=>{
 const {c,tx,writes}=deliveryContext([0,0]);
 const records=[{qty:2,lotAllocations:[{lotId:'A',qty:1,cost:0},{lotId:'B',qty:1,cost:0}]}];
 await c.applyInventoryDeliveryDeltaInTransaction(tx,{itemId:'I',warehouseId:'W'},-2,'actor','O',records);
 assert.equal(writes.find(row=>row.path==='inventoryLots/A').value.remainingQty,1);
 assert.equal(writes.find(row=>row.path==='inventoryLots/B').value.remainingQty,1);
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
