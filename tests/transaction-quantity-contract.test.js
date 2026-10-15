const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const fulfillment=require('../modules/fulfillment-core');
const workflow=require('../modules/workflow-core');

test('cumulative shipment projection agrees across dispatch, fulfillment and procurement',()=>{
  for(let ordered=1;ordered<=12;ordered++){
    for(let delivered=0;delivered<=ordered+3;delivered++){
      for(let returned=0;returned<=delivered;returned++){
        const item={orderedQty:ordered,deliveredQty:delivered,returnedQty:returned,reservedQty:0};
        const delivery=fulfillment.deliveryQuantities(item);
        const normalized=fulfillment.normalizeItem(item);
        const dispatch=fulfillment.dispatchState(item);
        const projected=workflow.projectItem({...item,grossDeliveredQty:delivered});
        const outstanding=Math.max(0,ordered-Math.max(0,delivered-returned));
        assert.equal(delivery.effectiveDeliveredQty,dispatch.delivered);
        assert.equal(normalized.shortageQty,outstanding);
        assert.equal(projected.outstandingQty,outstanding);
        assert.equal(projected.remainingToOrderQty,outstanding);
      }
    }
  }
});

test('partial delivery, return and replacement keep cumulative history and close demand once',()=>{
  let item=fulfillment.prepareDispatch({orderedQty:10,reservedQty:10},10);
  item=fulfillment.deliver(item,6);
  assert.equal(workflow.projectItem({...item,grossDeliveredQty:item.deliveredQty}).outstandingQty,4);
  item=fulfillment.deliver(item,4);
  item=fulfillment.returnDelivery(item,2);
  assert.equal(workflow.projectItem({...item,grossDeliveredQty:item.deliveredQty}).remainingToOrderQty,2);
  item=fulfillment.normalizeItem({...item,reservedQty:2,supplyOrderedQty:2,receivedQty:2});
  item=fulfillment.prepareDispatch(item,2);
  item=fulfillment.deliver(item,2);
  const result=workflow.projectItem({...item,grossDeliveredQty:item.deliveredQty});
  assert.equal(item.deliveredQty,12);
  assert.equal(item.returnedQty,2);
  assert.equal(result.effectiveDeliveredQty,10);
  assert.equal(result.outstandingQty,0);
  assert.equal(result.remainingToOrderQty,0);
  assert.equal(result.workCategory,'billing');
});

test('legacy effective input is adapted once and explicit effective zero stays authoritative',()=>{
  const legacy=workflow.projectItem({orderedQty:10,deliveredQty:8,returnedQty:2});
  const canonical=workflow.projectItem({orderedQty:10,grossDeliveredQty:10,returnedQty:2});
  assert.equal(legacy.grossDeliveredQty,canonical.grossDeliveredQty);
  assert.equal(legacy.effectiveDeliveredQty,canonical.effectiveDeliveredQty);
  assert.equal(legacy.remainingToOrderQty,canonical.remainingToOrderQty);
  const explicit=workflow.projectItem({orderedQty:10,deliveredQty:10,returnedQty:2,effectiveDeliveredQty:0});
  assert.equal(explicit.effectiveDeliveredQty,0);
  assert.equal(explicit.outstandingQty,10);
});

test('browser dependency order loads both cores and projects replacement without a second subtraction',()=>{
  const html=fs.readFileSync('index.html','utf8');
  assert.ok(html.indexOf('modules/fulfillment-core.js')<html.indexOf('modules/workflow-core.js'));
  const context=vm.createContext({});
  vm.runInContext(fs.readFileSync('modules/fulfillment-core.js','utf8'),context);
  vm.runInContext(fs.readFileSync('modules/workflow-core.js','utf8'),context);
  const result=context.YushinWorkflow.projectItem({orderedQty:10,grossDeliveredQty:12,returnedQty:2});
  assert.equal(result.workCategory,'billing');
  assert.equal(result.remainingToOrderQty,0);
});
