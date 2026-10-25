'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('../modules/fulfillment-core');
const goods={itemId:'G',productId:'PG',qty:2};
const service={itemId:'S',productId:'PS',productType:'Service',qty:0.5};
const project=(items=[service,goods],extra={})=>core.projectOrderShipmentReturns({orderId:'O',items,...extra});
test('mixed physical projection keeps fractional service work out of all physical totals',()=>{
 const p=project();assert.equal(p.orderedQty,2);assert.equal(p.outstandingQty,2);
 assert.deepEqual(p.items.map(i=>i.itemId),['G']);assert.equal(p.isDelivered,false);
});
test('service physical quantities, duplicate identity and fake Service shipment cannot disappear through filtering',()=>{
 for(const field of ['reservedQty','shortageQty','supplyOrderedQty','receivedQty','dispatchPreparedQty','warehouseShippedQty','deliveredQty','returnedQty'])
  assert.throws(()=>project([{...service,[field]:1},goods]),/服務品項/);
 assert.throws(()=>project([service,{...goods,itemId:'S'}]),/識別碼重複/);
 assert.throws(()=>project(undefined,{shipments:[{id:'fake',orderId:'O',itemId:'S',productKey:'PS'}]}),/事件來源/);
});
