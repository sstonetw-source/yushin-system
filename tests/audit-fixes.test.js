const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function fn(name){const start=source.indexOf(`function ${name}(`);assert.ok(start>=0);return source.slice(start,source.indexOf('\n}',start)+2);}
test('duplicate brand/code cannot auto-match, but an explicit saved product ID remains stable',()=>{
 const a={productId:'a',brand:'B',model:'A-1'},b={...a,productId:'b'},other={productId:'c',brand:'C',model:'A-1'};
 const c=vm.createContext({priceList:[a,b,other],priceItemLookup:new Map(),normalizeItemCode:x=>String(x).toLowerCase(),normalizeBrandLookupKey:x=>x,resolveBrandName:x=>x});
 vm.runInContext(fn('rebuildPriceItemLookup')+fn('findPriceItemForOrder'),c);c.rebuildPriceItemLookup();
 assert.equal(c.findPriceItemForOrder({brand:'B',itemCode:'A-1'}),null);
 assert.equal(c.findPriceItemForOrder({itemCode:'A-1'}),null);
 assert.equal(c.findPriceItemForOrder({brand:'C',itemCode:'A-1'}),other);
 assert.equal(c.findPriceItemForOrder({productId:'b',brand:'B',itemCode:'A-1'}),b);
 b.active=false;c.rebuildPriceItemLookup();assert.equal(c.findPriceItemForOrder({brand:'B',itemCode:'A-1'}),a);
});
test('pending purchase value uses the same demand quantities as purchasing, including partially ordered lines',()=>{
 const workflow=require('../modules/workflow-core'),demand=require('../modules/procurement-demand-core');
 const c=vm.createContext({YushinWorkflow:workflow,YushinProcurementDemand:demand,orderQuantity:o=>o.items.reduce((n,i)=>n+i.qty,0),salesAmount:o=>o.items.reduce((n,i)=>n+i.qty*i.unitPrice,0),itemDispatchState:()=>({grossDelivered:0,delivered:0,returned:0})});
 vm.runInContext(fn('procurementDemandForOrderItem')+fn('orderItemWorkAmount'),c);
 for(const fulfillmentType of ['WAREHOUSE','DIRECT_SHIP']){
 const item={itemId:'i',qty:10,unitPrice:100,fulfillmentType,reservedQty:0,shortageQty:10,supplyOrderedQty:4,receivedQty:0},order={id:'o',items:[item]};
 assert.equal(c.orderItemWorkAmount(order,item,'ordering'),600);
 item.supplyOrderedQty=10;assert.equal(c.orderItemWorkAmount(order,item,'ordering'),0);
 }
});
