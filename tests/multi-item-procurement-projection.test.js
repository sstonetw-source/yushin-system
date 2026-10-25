const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const fulfillment=require('../modules/fulfillment-core'),workflow=require('../modules/workflow-core'),demand=require('../modules/procurement-demand-core');
const read=file=>fs.readFileSync(require('node:path').join(__dirname,'..',file),'utf8');
const section=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
function harness(){
 const context={YushinFulfillment:fulfillment,YushinWorkflow:workflow,YushinProcurementDemand:demand,
  brandIdentityForRecord:()=>({brand:'Roche',brandId:'Roche'}),normalizeHistoryItemCode:s=>s,parseMoney:Number};
 context.window=context;
 vm.createContext(context);
 vm.runInContext(section(read('src/features/orders/order-workspace.js'),'function normalizedOrderItems(','function ensureOrderItemCompatibility(')
  +section(read('src/features/purchasing/purchasing-workspace.js'),'function procurementDemandForOrderItem(','function procurementDemandRef('),context);
 return context;
}
function fixture(){
 const items=[['I1','P',3,0],['I2','P',2,2],['I3','Q',2,2]].map(([itemId,productId,qty,reservedQty])=>({
  itemId,productId,qty,reservedQty,shortageQty:0,warehouseShippedQty:qty-reservedQty,
  supplyOrderedQty:qty,receivedQty:qty,dispatchPreparedQty:qty,deliveredQty:0,returnedQty:0,fulfillmentType:'WAREHOUSE'}));
 return {id:'O',items,deliveryRecords:[],returnRecords:[],warehouseShipmentRecords:[{
  id:'S1',orderId:'O',itemId:'I1',productKey:'P',warehouseId:'A',date:'2026-10-22',qty:3,sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'}]};
}
function project(context,order){
 return context.normalizedOrderItems(order).map(item=>context.procurementDemandForOrderItem(order,item,{
  grossDelivered:order.items.find(i=>i.itemId===item.itemId).deliveredQty,delivered:order.items.find(i=>i.itemId===item.itemId).deliveredQty,returned:0}));
}
test('procurement renders every sibling after physical shipment using original stock quantities',()=>{
 const c=harness(),order=fixture(),before=JSON.stringify(order);
 assert.equal(c.normalizedOrderItems(order)[0].shortageQty,3,'legacy display still awaits customer acknowledgement');
 const rows=project(c,order);
 assert.deepEqual(Array.from(rows,r=>r.remainingToOrderQty),[0,0,0]);
 assert.deepEqual(Array.from(rows,r=>r.sourceItemId),['I1','I2','I3']);
 assert.equal(JSON.stringify(order),before,'projection never mutates authoritative order');
});
test('same-product cross-warehouse siblings and final acknowledgement retain zero new procurement',()=>{
 const c=harness(),order=fixture();
 for(const [itemId,productKey,qty,warehouseId] of [['I2','P',2,'B'],['I3','Q',2,'A']]){
  const item=order.items.find(i=>i.itemId===itemId);item.reservedQty=0;item.warehouseShippedQty=qty;
  order.warehouseShipmentRecords.push({id:'S'+itemId,orderId:'O',itemId,productKey,qty,warehouseId,date:'2026-10-22',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT'});
  assert.deepEqual(Array.from(project(c,order),r=>r.remainingToOrderQty),[0,0,0]);
 }
 for(const shipment of order.warehouseShipmentRecords){
  order.deliveryRecords.push({...shipment,id:'D'+shipment.id,shipmentId:shipment.id,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'});
  order.items.find(i=>i.itemId===shipment.itemId).deliveredQty=shipment.qty;
  assert.deepEqual(Array.from(project(c,order),r=>r.remainingToOrderQty),[0,0,0]);
 }
});
test('rendering an unshipped sibling rejects unknown, duplicate and corrupt other-line events',()=>{
 for(const mutate of [o=>{o.warehouseShipmentRecords[0].itemId='unknown';},
  o=>o.warehouseShipmentRecords.push({...o.warehouseShipmentRecords[0]}),
  o=>{o.warehouseShipmentRecords[0].productKey='wrong';},
  o=>{o.warehouseShipmentRecords[0].qty=4;}]){
  const c=harness(),order=fixture();mutate(order);
  assert.throws(()=>c.procurementDemandForOrderItem(order,c.normalizedOrderItems(order)[1],{grossDelivered:0,delivered:0,returned:0}));
 }
});
