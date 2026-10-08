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

test('business shipping action requires item-level form for multi-item and partial-print orders',()=>{
    const start=app.indexOf('function orderDeliveryRequiresItemForm(');
    const end=app.indexOf('\nfunction orderContextActionState(', start);
    assert.ok(start>=0 && end>start);
    const sandbox=vm.createContext({});
    vm.runInContext(app.slice(start,end),sandbox);
    const needsForm=sandbox.orderDeliveryRequiresItemForm;
    assert.equal(needsForm([{itemId:'A'},{itemId:'B'}],{remaining:1},{shippable:1}),true);
    assert.equal(needsForm([{itemId:'A'}],{remaining:5},{shippable:3}),true);
    assert.equal(needsForm([{itemId:'A'}],{remaining:5},{shippable:5}),false);
    assert.match(app,/const useBatchDelivery = orderDeliveryRequiresItemForm\(allOrderItems, deliveryProgress, fulfillmentProgress\)/);
    assert.match(app,/useBatchDelivery \? 'openPartialDeliveryForOrder' : 'quickCompleteDelivery'/);
    assert.match(app,/useBatchDelivery \? '分批送貨' : '確認送貨'/);
});

function deliveryTestHarness(selectedItem, recordToEdit=null, single=false) {
    const order={id:'SO',status:'normal',totalPrice:50000,items:[
        {itemId:'I1',itemName:'Unprinted',qty:1,dispatchPreparedQty:0,reservedQty:1,fulfillmentType:'WAREHOUSE'},
        ...(single?[]:[{itemId:'I2',itemName:'Printed',qty:3,dispatchPreparedQty:2,reservedQty:2,fulfillmentType:'WAREHOUSE'}])
    ],deliveryRecords:recordToEdit?[recordToEdit]:[],returnRecords:[]};
    const fields={deliveryDate:{value:'2026-10-08'},deliveryQty:{value:'1'},deliveryNotes:{value:''},
        deliveryEditId:{value:recordToEdit?.id||''},deliveryItemId:{value:selectedItem}};
    const alerts=[],updates=[],deltas=[],button={disabled:false,textContent:''};
    const context=vm.createContext({window:{},currentDeliveryOrderId:'SO',pendingDeliveryOrderIds:new Set(),ordersCache:[order],
        canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
        document:{getElementById:id=>fields[id]||null,querySelector:()=>button},
        db:{collection:()=>({doc:id=>({id})})},
        runRoleTransaction:async callback=>callback({get:async()=>({exists:true,data:()=>order}),update:(_ref,data)=>updates.push(data)}),
        savedDeliveryRecords:o=>o.deliveryRecords||[],savedReturnRecords:o=>o.returnRecords||[],
        normalizedOrderStatus:o=>o.status,normalizedOrderItems:o=>o.items,
        orderQuantity:o=>o.items.reduce((s,item)=>s+item.qty,0),returnedQuantity:()=>0,
        deliveryActor:()=> 'Sales',deliveryRecordId:()=> 'NEW',
        firebase:{firestore:{FieldValue:{arrayUnion:item=>[item]}}},
        orderWorkIndexFields:()=>({}),
        applyInventoryDeliveryDeltaInTransaction:async(_tx,item,qty)=>{deltas.push({item,qty});return {newReservedQty:0,lotAllocations:[],cogs:0};},
        resetDeliveryForm(){},renderDeliveryModal(){},renderOrderLifecycleModal(){},renderOrdersList(){},
        alert:text=>alerts.push(text)
    });
    const start=app.indexOf('window.saveDeliveryRecord = async function()');
    const end=app.indexOf('\nwindow.deleteDeliveryRecord = async function(',start);
    assert.ok(start>=0&&end>start);
    vm.runInContext(app.slice(start,end),context);
    return {order,context,alerts,updates,deltas,button};
}
test('delivery never switches an invalid item ID to the first line',async()=>{
    for(const id of ['', 'MISSING', 'item-1']) {
        const t=deliveryTestHarness(id);
        await t.context.window.saveDeliveryRecord();
        assert.equal(t.deltas.length,0);
        assert.equal(t.updates.length,0);
        assert.match(t.alerts[0],/找不到指定送貨品項/);
    }
});
test('delivery changes the correct printed line and cannot ship the unprinted line',async()=>{
    const valid=deliveryTestHarness('I2');
    await valid.context.window.saveDeliveryRecord();
    assert.equal(valid.alerts.length,0);
    assert.equal(valid.deltas[0].item.itemId,'I2');
    assert.equal(valid.updates[0].deliveryRecords[0].itemId,'I2');
    assert.equal(valid.updates[0].items[0].reservedQty,1);
    assert.equal(valid.order.totalPrice,50000);
    const invalid=deliveryTestHarness('I1');
    await invalid.context.window.saveDeliveryRecord();
    assert.equal(invalid.updates.length,0);
    assert.match(invalid.alerts[0],/已打單可出貨數量只有 0/);
});
test('legacy single-line selection ignores a stale hidden selector; stale edited item fails',async()=>{
    const single=deliveryTestHarness('stale-dropdown',null,true);
    single.order.items[0].dispatchPreparedQty=1;
    await single.context.window.saveDeliveryRecord();
    assert.equal(single.alerts.length,0);
    assert.equal(single.updates[0].deliveryRecords[0].itemId,'I1');
    const outdated=deliveryTestHarness('I2',{id:'OLD',itemId:'REMOVED',qty:1});
    await outdated.context.window.saveDeliveryRecord();
    assert.equal(outdated.deltas.length,0);
    assert.equal(outdated.updates.length,0);
    assert.match(outdated.alerts[0],/找不到指定送貨品項/);
});
