const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const app=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const workflow=require('../modules/workflow-core.js');
const fulfillment=require('../modules/fulfillment-core.js');

function setup(){
    const start=app.indexOf('function orderItemWorkCategory(');
    const end=app.indexOf('\nfunction orderWorkIndexFields(',start);
    const costStart=app.indexOf('function orderItemWorkAmount(');
    const costEnd=app.indexOf('\nfunction buildOrderItemWorkMetrics(',costStart);
    assert.ok(start>0 && end>start && costStart>end && costEnd>costStart);
    const context=vm.createContext({
        YushinWorkflow:workflow,
        normalizedOrderItems:order=>order.items,
        orderLifecycleInfo:order=>({status:order.status||'normal'}),
        itemDispatchState:(_order,item)=>fulfillment.dispatchState(item),
        orderQuantity:order=>order.items.reduce((total,item)=>total+item.qty,0),
        salesAmount:order=>order.items.reduce((total,item)=>total+item.unitPrice*item.qty,0)
    });
    vm.runInContext(app.slice(start,end)+'\n'+app.slice(costStart,costEnd),context);
    return context;
}
function sampleOrder(){
    return {status:'normal',items:[
        {itemId:'A',itemName:'Dry bath',qty:1,unitPrice:24800,fulfillmentType:'WAREHOUSE',
         reservedQty:1,shortageQty:0,supplyOrderedQty:1,receivedQty:1,dispatchPreparedQty:1},
        {itemId:'B',itemName:'Centrifuge',qty:2,unitPrice:15000,fulfillmentType:'WAREHOUSE',
         reservedQty:0,shortageQty:2,supplyOrderedQty:2,receivedQty:0,dispatchPreparedQty:0},
        {itemId:'C',itemName:'Reagent',qty:5,unitPrice:100,fulfillmentType:'WAREHOUSE',
         reservedQty:3,shortageQty:2,supplyOrderedQty:5,receivedQty:3,dispatchPreparedQty:1}
    ]};
}
test('purchaser can print ready parts while another supplier order remains in transit',()=>{
    const x=setup(),order=sampleOrder(),[a,b,c]=order.items;
    assert.deepEqual(Array.from(x.orderItemDisplayCategories(order,a)),['shipping']);
    assert.deepEqual(Array.from(x.orderItemDisplayCategories(order,b)),['arrival']);
    assert.deepEqual(Array.from(x.orderItemDisplayCategories(order,c)),['arrival','dispatch','shipping']);
    assert.equal(x.orderItemWorkAmount(order,c,'shipping'),100);
    assert.equal(x.orderItemWorkAmount(order,c,'dispatch'),200);
    assert.equal(x.orderItemWorkAmount(order,a,'shipping'),24800);
    assert.equal(x.orderItemWorkAmount(order,b,'shipping'),0);
});
test('unprinted items cannot enter sales ready list and delivered/cancelled items are excluded',()=>{
    const x=setup(),order=sampleOrder(),line=order.items[2];
    line.dispatchPreparedQty=0;
    assert.deepEqual(Array.from(x.orderItemDisplayCategories(order,line)),['arrival','dispatch']);
    line.dispatchPreparedQty=3;
    assert.deepEqual(Array.from(x.orderItemDisplayCategories(order,line)),['arrival','shipping']);
    order.status='cancelled';
    assert.deepEqual(Array.from(x.orderItemDisplayCategories(order,line)),['closed']);
});
test('printing stays purchaser/admin only, and reuses the existing transactional dispatch record',()=>{
    const slice=app.slice(app.indexOf('window.markOrderItemDispatchPrepared = async function'),app.indexOf('\nfunction canBusinessSelfOrder',app.indexOf('window.markOrderItemDispatchPrepared = async function')));
    assert.match(slice,/currentUserRole === 'purchaser' \|\| currentUserRole === 'admin'/);
    assert.match(slice,/await runRoleTransaction\(async tx=>/);
    assert.match(slice,/tx\.set\(dispatchRef,/);
    assert.match(slice,/tx\.update\(ref,\{items,\.\.\.orderWorkIndexFields\(nextOrder\),updatedAt:now\}\)/);
    assert.match(app,/\['shipping', '已打單'\]/);
});
