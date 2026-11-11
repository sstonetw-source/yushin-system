'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

test('first production load discards only cleared transaction snapshots',()=>{
 const script=fs.readFileSync(require.resolve('../modules/cutover-cache-guard.js'),'utf8');
 const html=fs.readFileSync(require.resolve('../index.html'),'utf8');
 assert.ok(html.indexOf('modules/cutover-cache-guard.js')<html.indexOf('app.js?v='));
 const records=new Map([
  ['yushin-data-cache:v2:U:sales:orders','deleted-order'],
  ['yushin-data-cache:v2:U:sales:inventory','deleted-stock'],
  ['yushin-data-cache:v2:U:sales:purchase-history','deleted-purchase'],
  ['yushin-data-cache:v2:U:sales:quotes','preserved-quote'],
  ['order-draft:U','unsent-draft']
 ]);
 const localStorage={get length(){return records.size;},key:i=>[...records.keys()][i]||null,
  getItem:k=>records.get(k)??null,setItem:(k,v)=>records.set(k,v),removeItem:k=>records.delete(k)};
 const context={localStorage,location:{origin:'https://sstonetw-source.github.io',pathname:'/yushin-system/'}};
 vm.runInNewContext(script,context);
 for(const kind of ['orders','inventory','purchase-history'])
  assert.equal(records.has('yushin-data-cache:v2:U:sales:'+kind),false);
 assert.equal(records.get('yushin-data-cache:v2:U:sales:quotes'),'preserved-quote');
 assert.equal(records.get('order-draft:U'),'unsent-draft');
 // Later valid caches must not be cleared on a normal subsequent page load.
 records.set('yushin-data-cache:v2:U:sales:orders','new-order');
 vm.runInNewContext(script,context);
 assert.equal(records.get('yushin-data-cache:v2:U:sales:orders'),'new-order');
});
test('Emulator and preview environments never clear local records',()=>{
 const script=fs.readFileSync(require.resolve('../modules/cutover-cache-guard.js'),'utf8');
 for(const origin of ['http://localhost:5000','https://preview-20135.web.app']){
  const records=new Map([['yushin-data-cache:v2:U:sales:orders','test-order']]);
  vm.runInNewContext(script,{location:{origin,pathname:'/yushin-system/'},localStorage:{
   getItem:k=>records.get(k),removeItem:k=>records.delete(k),setItem:(k,v)=>records.set(k,v),
   get length(){return records.size;},key:i=>[...records.keys()][i]}});
  assert.equal(records.get('yushin-data-cache:v2:U:sales:orders'),'test-order');
 }
});
