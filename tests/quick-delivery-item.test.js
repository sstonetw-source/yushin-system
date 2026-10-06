const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const code=src.slice(src.indexOf('window.quickCompleteDelivery = async function'),src.indexOf('function renderDeliveryModal()'));
function setup({delivered=false,multi=false,pending=false}={}){
 const item={itemId:'LINE-7',productId:'PRODUCT-7',warehouseId:'WAREHOUSE-7',fulfillmentType:'WAREHOUSE',qty:1,reservedQty:1};
 const order={id:'ORDER-1',productId:'wrong-header-product',warehouseId:'wrong-header-warehouse',items:[item],deliveryRecords:delivered?[{id:'D1',itemId:'LINE-7',qty:1}]:[],isDelivered:delivered,inventoryReservationStatus:pending?'pending':'completed'};
 const live=JSON.parse(JSON.stringify(order));if(multi)live.items.push({...item,itemId:'LINE-8'});
 const calls=[],alerts=[],updates=[];
 const records=o=>o.deliveryRecords||[];
 const progress=o=>{const total=o.items.reduce((s,i)=>s+i.qty,0),n=records(o).reduce((s,r)=>s+r.qty,0);return {total,delivered:n,remaining:total-n,state:n>=total?'complete':'pending'};};
 const inventory=async(...args)=>{const data=args[2]||args[1];assert.equal(data.itemId,'LINE-7');calls.push(args);return {newReservedQty:args[3]<0?1:0,lotAllocations:[],cogs:10};};
 const x=vm.createContext({window:{},ordersCache:[order],currentDeliveryOrderId:null,pendingDeliveryOrderIds:new Set(),canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
 orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus),normalizedOrderStatus:()=> 'normal',normalizedOrderItems:o=>o.items.map(i=>({...i})),orderQuantity:o=>o.items.reduce((s,i)=>s+i.qty,0),returnedQuantity:()=>0,
 savedDeliveryRecords:records,deliveryProgressInfo:progress,fulfillmentProgressInfo:()=>({shippable:1}),localDateString:()=> '2026-10-04',deliveryActor:()=> 'User',deliveryRecordId:()=> 'D2',renderOrdersList(){},openDeliveryModal(){},openPartialDeliveryForm(){},
 db:{collection:()=>({doc:id=>({id})}),runTransaction:async callback=>callback({get:async()=>({exists:true,data:()=>live}),update:(ref,patch)=>updates.push(patch)})},
 firebase:{firestore:{FieldValue:{arrayUnion:(...a)=>a}}},orderWorkIndexFields:()=>({}),applyInventoryDeliveryInTransaction:inventory,
 applyInventoryDeliveryDeltaInTransaction:async(tx,data,qty,actor,id,reversed)=>{assert.equal(data.itemId,'LINE-7');calls.push([tx,null,data,qty,actor,id,reversed]);return {newReservedQty:1};},alert:s=>alerts.push(s),showActionFeedback:s=>alerts.push(s)
 });vm.runInContext("globalThis.runRoleTransaction ||= callback => db.runTransaction(callback); globalThis.supplyOrdersCollection ||= () => db.collection('supplyOrders'); globalThis.syncReceivingSupplyViews ||= () => {};", x);
vm.runInContext(code,x);return {x,calls,alerts,updates};
}
test('one-click shipping passes the exact item identity product and warehouse to inventory accounting',async()=>{
 const a=setup();await a.x.window.quickCompleteDelivery('ORDER-1');assert.equal(a.alerts.length,0);assert.equal(a.calls[0][2].productId,'PRODUCT-7');assert.equal(a.calls[0][2].warehouseId,'WAREHOUSE-7');assert.equal(a.calls[0][5],'ORDER-1');assert.equal(a.updates[0].deliveryRecords[0].itemId,'LINE-7');assert.equal(a.updates[0].items[0].reservedQty,0);
});
test('canceling one-click shipping restores the same item reservation',async()=>{
 const a=setup({delivered:true});await a.x.window.quickCancelAllDelivery('ORDER-1');assert.equal(a.alerts.length,0);assert.equal(a.calls[0][2].productId,'PRODUCT-7');assert.equal(a.calls[0][3],-1);assert.equal(a.updates[0].items[0].reservedQty,1);
});
test('live transaction rejects a multi-item order even if the cached row has only one item',async()=>{
 const a=setup({multi:true});await a.x.window.quickCompleteDelivery('ORDER-1');assert.equal(a.calls.length,0);assert.match(a.alerts[0],/多品項/);assert.equal(a.x.ordersCache[0].isDelivered,false);
});
test('pending inventory synchronization never starts one-click delivery',async()=>{
 const a=setup({pending:true});await a.x.window.quickCompleteDelivery('ORDER-1');assert.equal(a.calls.length,0);assert.match(a.alerts[0],/尚未同步完成/);
});
