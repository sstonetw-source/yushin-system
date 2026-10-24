'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../src/features/orders/order-workspace.js'),'utf8');
const start=source.indexOf('function orderWorkIndexFields(order) {');
const end=source.indexOf('\nfunction orderItemWorkAmount(',start);
assert.ok(start>=0&&end>start,'the original order writer index helper is present');

function fixture(){
  let recomputes=0;
  const context=vm.createContext({
    normalizedOrderItems:order=>order.items,
    orderLifecycleInfo:order=>({status:order.orderStatus||'normal'}),
    orderWorkCategories:()=>{recomputes++;return ['delivery'];}
  });
  vm.runInContext(source.slice(start,end),context);
  return {index:order=>context.orderWorkIndexFields(order),recomputes:()=>recomputes};
}

test('unrelated client writer preserves verified pure-Service progress and timestamp',()=>{
  const f=fixture();
  const order={orderStatus:'normal',workCategories:['billing','delivery'],
    workCategoryUpdatedAt:'2026-10-24T00:00:00Z',
    items:[{productType:'SERVICE',itemId:'I'},{productType:'SERVICE',itemId:'J'}]};
  assert.deepEqual({...f.index(order)},{});
  order.workCategories=['complete'];order.isBilled=true;
  assert.deepEqual({...f.index(order)},{});
  assert.equal(f.recomputes(),0,'client never re-projects service completion from delivery fields');
});

test('new or unfinished Service index and Goods writer keep existing projection',()=>{
  const f=fixture();
  const service={items:[{productType:'SERVICE'}],workCategories:['delivery']};
  assert.deepEqual(Array.from(f.index(service).workCategories),['delivery']);
  const product={items:[{productType:'GOODS'}],workCategories:['billing']};
  assert.deepEqual(Array.from(f.index(product).workCategories),['delivery']);
  const mixed={items:[{productType:'GOODS'},{productType:'SERVICE'}],workCategories:['billing']};
  assert.deepEqual(Array.from(f.index(mixed).workCategories),['delivery']);
  assert.equal(f.recomputes(),3);
});

test('cancel/restore cannot silently discard verified Service completion',()=>{
  const f=fixture(),order={orderStatus:'cancelled',workCategories:['billing'],
    items:[{productType:'SERVICE'}]};
  assert.throws(()=>f.index(order),/後端核對案件後取消或恢復/);
  assert.equal(f.recomputes(),0);
});
