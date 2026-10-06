const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/inventory-workspace');
const fulfillment=require('../modules/fulfillment-core');
const code=fs.readFileSync('modules/inventory-workspace.js','utf8');
test('receiving counts physical pending supply lines once, excluding direct, terminal and fully received supply',()=>{
 const list=[{id:'1',status:'ORDERED',qty:2},{id:'1',status:'ORDERED',qty:2},{id:'2',status:'PARTIAL_RECEIPT',qty:3,receivedQty:1},{id:'3',status:'ORDERED',qty:2,fulfillmentType:'DIRECT_SHIP'},{id:'4',status:'CANCELLED',qty:2},{id:'5',status:'ORDERED',qty:2,receivedQty:2}];
 assert.deepEqual(core.purchaseRows(list).map(r=>r.id),['1','2']);
 assert.equal(core.returnRows([{returnRequests:[{status:'PENDING',qty:3,receivedQty:1},{status:'RECEIVED',qty:1},{status:'CANCELLED',qty:1},{status:'PENDING',qty:2,receivedQty:2}]}]).length,1);
});
test('shipping uses prepared stock per item, includes partial prepared quantities and splits a mixed order between warehouses',()=>{
 const order={id:'O',items:[{itemId:'A',warehouseId:'MAIN',reservedQty:3,dispatchPreparedQty:1},{itemId:'B',warehouseId:'BRANCH',reservedQty:2,dispatchPreparedQty:4,deliveredQty:2},{itemId:'C',warehouseId:'MAIN',reservedQty:3,dispatchPreparedQty:0},{itemId:'D',fulfillmentType:'DIRECT_SHIP',reservedQty:5,dispatchPreparedQty:5}]};
 const helpers={status:o=>o.status||'normal',incomplete:o=>o.pending,items:o=>o.items,dispatch:(_o,i)=>fulfillment.dispatchState(i)};
 const rows=core.shippingRows([order,order,{...order,id:'Cancelled',status:'cancelled'},{...order,id:'Pending',pending:true}], [{id:'MAIN'},{id:'BRANCH'}],'MAIN',helpers);
 assert.equal(rows.length,2);assert.equal(rows[0].qty,1);assert.equal(rows[0].branch,false);assert.equal(rows[1].qty,2);assert.equal(rows[1].branch,true);
});
function fixture(){
 const order={status:'active',ownerUid:'sales1',deliveredQty:0,items:[{itemId:'A',warehouseId:'MAIN',qty:3,reservedQty:3,dispatchPreparedQty:3}],deliveryRecords:[],returnRecords:[]};
 const docs=new Map([['orders/O',order]]);let posts=0;
 const c=vm.createContext({db:{collection:name=>({doc:id=>({path:name+'/'+id})})},canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,
  runRoleTransaction:async fn=>{const writes=[];await fn({get:async ref=>({exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))}),update:(ref,data)=>writes.push([ref,data])});writes.forEach(([ref,data])=>docs.set(ref.path,{...docs.get(ref.path),...data}));},
  normalizedOrderItems:o=>o.items,normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',orderInventorySyncIncomplete:o=>o.pending,
  savedDeliveryRecords:o=>o.deliveryRecords,savedReturnRecords:o=>o.returnRecords,returnedQuantity:()=>0,orderQuantity:()=>3,
  itemDispatchState:(_o,item)=>fulfillment.dispatchState(item),defaultWarehouse:()=>({id:'MAIN'}),warehouseMasterCache:[{id:'MAIN'}],
  deliveryActor:()=> 'Warehouse',currentUser:{uid:'wh1'},inventoryProductKey:()=> 'P',
  applyInventoryDeliveryDeltaInTransaction:async(_tx,item,qty)=>{posts+=qty;return {newReservedQty:item.reservedQty-qty,movementId:'M',lotAllocations:[]};},
  firebase:{firestore:{FieldValue:{arrayUnion:x=>[x]}}},orderWorkIndexFields:()=>({workCategories:['delivery']})});
 vm.runInContext(code.slice(code.indexOf('async function commitInventoryShipment')),c);return {c,docs,posts:()=>posts};
}
test('shipment is atomic and idempotent across retries, with a unique recorded item and warehouse',async()=>{
 const f=fixture(),args={orderId:'O',itemId:'A',qty:1,date:'2026-10-06',operationId:'D'};
 await f.c.commitInventoryShipment(args);await f.c.commitInventoryShipment(args);
 assert.equal(f.posts(),1);const order=f.docs.get('orders/O');assert.equal(order.deliveryRecords.length,1);assert.equal(order.items[0].reservedQty,2);assert.equal(order.deliveryRecords[0].warehouseId,'MAIN');assert.equal(order.deliveryRecords[0].itemId,'A');assert.equal(order.inventoryShipmentRecordId,'D');
});
test('invalid quantity, dates, missing identity, cancelled order, unsynced stock and unauthorized roles never post inventory',async()=>{
 for(const patch of [{qty:0},{qty:-1},{qty:4},{qty:NaN},{date:'2026-02-30'},{date:'bad'},{operationId:''},{itemId:'missing'}]){
  const f=fixture();await assert.rejects(f.c.commitInventoryShipment({orderId:'O',itemId:'A',qty:1,date:'2026-10-06',operationId:'D',...patch}));assert.equal(f.posts(),0);
 }
 for(const mutation of [{status:'cancelled'},{pending:true}]){const f=fixture();Object.assign(f.docs.get('orders/O'),mutation);await assert.rejects(f.c.commitInventoryShipment({orderId:'O',itemId:'A',qty:1,date:'2026-10-06',operationId:'D'}));assert.equal(f.posts(),0);}
 const f=fixture();f.c.canReceiveInventoryCapability=()=>false;await assert.rejects(f.c.commitInventoryShipment({}),/權限/);assert.equal(f.posts(),0);
});
test('export entry stays read-only and renders the selected warehouse with editable shipping instructions',()=>{
 const app=fs.readFileSync('app.js','utf8'),start=app.indexOf('window.openWarehouseDispatchList='),end=app.indexOf('window.openRelatedOrderPurchase',start),section=app.slice(start,end);
 assert.match(section,/selectedWarehouseId&&warehouseId!==selectedWarehouseId/);assert.match(section,/const qty=state.shippable/);assert.match(section,/dispatchListDate/);assert.match(section,/dispatchListNotes/);assert.match(section,/stock.shippable<item.qty/);assert.doesNotMatch(section,/runRoleTransaction|db[\s\S]*?\.doc\([^)]*\)\.(set|update|add)\(/);
});
