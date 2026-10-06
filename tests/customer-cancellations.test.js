const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const code=fs.readFileSync('modules/customer-cancellations.js','utf8'),app=fs.readFileSync('app.js','utf8');
const inventory=require('../modules/inventory-core');
const start=code.indexOf('async function commitCustomerReturnReceipt('),end=code.indexOf('\nwindow.releaseCustomerReturnHold',start);
function fixture(){
 const order={items:[{itemId:'I1',qty:5,fulfillmentType:'WAREHOUSE',warehouseId:'W1'}],ownerUid:'S1',salesCode:'S01',deliveredQty:5,returnRequests:[{id:'Q1',itemId:'I1',qty:3,receivedQty:0,status:'PENDING',reason:'test'}],returnRecords:[],deliveryRecords:[{itemId:'I1',qty:5,lotAllocations:[{lotId:'L1',qty:5}]}]};
 const docs=new Map([['orders/O1',order]]);let stock=0;const c=vm.createContext({
  db:{collection:name=>({doc:id=>({path:name+'/'+id})})},
  runRoleTransaction:async fn=>{const pending=[];const tx={get:async ref=>({exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))}),set:(ref,data)=>pending.push([ref,data]),update:(ref,data)=>pending.push([ref,{...docs.get(ref.path),...data}])};await fn(tx);pending.forEach(([ref,data])=>docs.set(ref.path,data));},
  canReceiveInventoryCapability:()=>true,normalizedOrderItems:o=>o.items,
  returnItemReturnedQty:(o,id)=>o.returnRecords.filter(r=>r.itemId===id).reduce((s,r)=>s+r.qty,0),returnItemDeliveredQty:()=>5,
  savedDeliveryRecords:o=>o.deliveryRecords,savedReturnRecords:o=>o.returnRecords,YushinInventory:inventory,
  postCustomerReturnStock:async(_tx,_o,_i,qty)=>{stock+=qty;return {lotAllocations:[{lotId:'L1',qty}],newReservedQty:0};},
  currentUser:{uid:'receiver'},deliveryActor:()=> 'Receiver',localDateString:()=> '2026-10-06',orderWorkIndexFields:()=>({workCategories:['complete']})
 });vm.runInContext(code.slice(start,end),c);return {c,docs,stock:()=>stock};
}
test('request quantity includes pending requests, excluding withdrawn and already received quantities',()=>{
 const start=code.indexOf('function customerReturnPendingQty('),end=code.indexOf('\nfunction customerCancellationActions',start),c=vm.createContext({});vm.runInContext(code.slice(start,end),c);
 assert.equal(c.customerReturnPendingQty({returnRequests:[{id:'A',itemId:'I1',qty:4,receivedQty:1,status:'PENDING'},{id:'B',itemId:'I1',qty:5,status:'CANCELLED'}]},'I1'),3);
});
test('saleable return changes stock only at receiving, retries do not duplicate it',async()=>{
 const f=fixture();assert.equal(f.stock(),0);
 const args={orderId:'O1',requestId:'Q1',receiptId:'R1',qty:2,quality:'SALEABLE',warehouseId:'W1'};
 await f.c.commitCustomerReturnReceipt(args);await f.c.commitCustomerReturnReceipt(args);
 assert.equal(f.stock(),2);const o=f.docs.get('orders/O1');assert.equal(o.returnedQty,2);assert.equal(o.returnRequests[0].receivedQty,2);assert.equal(o.returnPending,true);assert.equal(o.returnRecords.length,1);assert.equal(o.returnRecords[0].settlement,'CLOSE');
 await f.c.commitCustomerReturnReceipt({...args,receiptId:'R2',qty:1});assert.equal(f.stock(),3);assert.equal(f.docs.get('orders/O1').returnPending,false);
});
test('inspection and damaged returns settle delivery but do not become available stock',async()=>{
 for(const quality of ['INSPECTION','DAMAGED']){const f=fixture();await f.c.commitCustomerReturnReceipt({orderId:'O1',requestId:'Q1',receiptId:'R1',qty:3,quality,warehouseId:'W1'});assert.equal(f.stock(),0);assert.equal(f.docs.get('customerReturnReceipts/R1').disposition,'HOLD');assert.equal(f.docs.get('orders/O1').returnedQty,3);}
});
test('over receipt, withdrawn request, invalid quantity and unauthorized role reject without writes',async()=>{
 for(const qty of [4,0,-1,NaN]){const f=fixture();await assert.rejects(f.c.commitCustomerReturnReceipt({orderId:'O1',requestId:'Q1',receiptId:'R1',qty,quality:'SALEABLE',warehouseId:'W1'}));assert.equal(f.stock(),0);assert.equal(f.docs.has('customerReturnReceipts/R1'),false);}
 const f=fixture();f.docs.get('orders/O1').returnRequests[0].status='CANCELLED';await assert.rejects(f.c.commitCustomerReturnReceipt({orderId:'O1',requestId:'Q1',receiptId:'R1',qty:1,quality:'SALEABLE',warehouseId:'W1'}));
 f.c.canReceiveInventoryCapability=()=>false;await assert.rejects(f.c.commitCustomerReturnReceipt({}),/無收貨權限/);
});
test('closed return keeps fulfillment complete rather than scheduling replacement',()=>{
 const start=app.indexOf('function deliveryProgressInfo('),end=app.indexOf('\nfunction savedReturnRecords',start);
 const c=vm.createContext({orderQuantity:()=>5,deliveredQuantity:()=>5,returnedQuantity:()=>2,savedReturnRecords:()=>[{qty:2,settlement:'CLOSE'}],savedDeliveryRecords:()=>[{}]});vm.runInContext(app.slice(start,end),c);assert.equal(c.deliveryProgressInfo({}).remaining,0);assert.equal(c.deliveryProgressInfo({}).state,'complete');
});
test('closed return reduces actual sales without recreating pending sales',()=>{
 const start=app.indexOf('function calculateOrderStatsContribution('),end=app.indexOf('\nfunction addSalesStatsContribution',start);
 const c=vm.createContext({normalizedOrderStatus:()=> 'normal',orderQuantity:()=>5,orderUnitSalesAmount:()=>100,orderUnitCostForStats:()=>50,localDateString:()=> '2026-10-06',savedDeliveryRecords:o=>o.deliveryRecords,savedReturnRecords:o=>o.returnRecords,dateInStatsRange:()=>true});
 vm.runInContext(app.slice(start,end),c);const result=c.calculateOrderStatsContribution({orderDate:'2026-10-01',deliveryRecords:[{date:'2026-10-02',qty:5}],returnRecords:[{date:'2026-10-06',qty:2,settlement:'CLOSE'}]},'2026-10-01','2026-10-06');assert.equal(result.actualSales,300);assert.equal(result.pendingSales,0);
});
