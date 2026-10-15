'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const fulfillment = require('../modules/fulfillment-core.js');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const start = app.indexOf('function orderQuantity(');
const end = app.indexOf('function purchaseProgressInfo(', start);
if(start<0 || end<0)throw Error('order projection source missing');
const sandbox=vm.createContext({
  YushinFulfillment:fulfillment,
  BUSINESS_STATUS:{CANCELLED:'cancelled',VOIDED:'voided'}
});
vm.runInContext(app.slice(start,end),sandbox,{filename:'order-delivery-projection.js'});
const item=[{qty:10}];
function delivery(qty,returns=[]){return {items:item,deliveryRecords:[{itemId:'item-1',qty}],returnRecords:returns};}
test('補送退貨使用履約核心且不重複扣退貨',()=>{
  const order=delivery(12,[{itemId:'item-1',qty:2,settlement:'REPLACE'}]);
  const p=sandbox.deliveryProgressInfo(order,item);
  const life=sandbox.orderLifecycleInfo(order,item);
  assert.equal(p.grossDelivered,12);
  assert.equal(p.returned,2);
  assert.equal(p.delivered,10);
  assert.equal(p.remaining,0);
  assert.equal(life.effectiveDelivered,10);
});
test('不補送的結案退貨不降低有效交付與新採購需求',()=>{
  const order=delivery(10,[{itemId:'item-1',qty:3,settlement:'CLOSE'}]);
  assert.equal(sandbox.deliveryProgressInfo(order,item).delivered,10);
  assert.equal(sandbox.orderLifecycleInfo(order,item).effectiveDelivered,10);
  assert.equal(sandbox.orderLifecycleInfo(order,item).label,'退貨已收貨・不補送');
});
test('補送加結案混合退貨只留下必須補送的缺口',()=>{
  const order=delivery(9,[
    {itemId:'item-1',qty:2,settlement:'REPLACE'},
    {itemId:'item-1',qty:3,settlement:'CLOSE'}
  ]);
  const p=sandbox.deliveryProgressInfo(order,item);
  assert.equal(p.delivered,7);
  assert.equal(p.remaining,3);
  assert.equal(sandbox.orderLifecycleInfo(order,item).effectiveDelivered,7);
});
test('送貨歷史只有一張已完成舊訂單時仍以舊已送貨標記推導',()=>{
  const order={items:item,isDelivered:true,returnRecords:[]};
  assert.equal(sandbox.deliveryProgressInfo(order,item).delivered,10);
  assert.equal(sandbox.deliveryProgressInfo(order,item).isLegacyEstimated,true);
});
