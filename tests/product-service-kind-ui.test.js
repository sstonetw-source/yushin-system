'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/service-work-core.js');
const source=fs.readFileSync('src/features/products/product-management.js','utf8');
const html=fs.readFileSync('index.html','utf8');
const editor=source.slice(source.indexOf('function ensureProductMasterEditor() {'),
  source.indexOf('function populateProductMasterEditor('));
test('Service subtype editor derives its choices from the one authorized Service Work Core',()=>{
 const existing=new Map(),overlay={addEventListener(){},innerHTML:''};
 const ctx=vm.createContext({globalThis:null,document:{
   getElementById:id=>existing.get(id)||null,createElement:()=>overlay,
   body:{appendChild:element=>existing.set(element.id,element)}
 },escapeHtml:v=>String(v),escapeAttr:v=>String(v)});
 ctx.globalThis=ctx;ctx.YushinServiceWork=core;
 vm.runInContext(editor+'\nensureProductMasterEditor()',ctx);
 for(const kind of Object.keys(core.STEPS))
   assert.match(overlay.innerHTML,new RegExp('<option value="'+kind+'">'));
 assert.match(overlay.innerHTML,/id="pmEditServiceKind"/);
 assert.match(overlay.innerHTML,/updateProductMasterServiceFields\(\)/);
 assert.ok(html.indexOf('modules/service-work-core.js')<html.indexOf('app.js?v'));
});
test('Service product type disables all physical inventory flags; Goods restore flag editability',()=>{
 const nodes=new Map([['pmEditProductType',{value:'Service'}],
   ['pmEditServiceKindField',{hidden:true}],
   ...['pmEditInventoryTracked','pmEditLotTracked','pmEditExpiryTracked']
     .map(id=>[id,{checked:true,disabled:false}])]);
 const ctx=vm.createContext({document:{getElementById:id=>nodes.get(id)||null}});
 vm.runInContext(editor+'\nupdateProductMasterServiceFields()',ctx);
 assert.equal(nodes.get('pmEditServiceKindField').hidden,false);
 for(const id of ['pmEditInventoryTracked','pmEditLotTracked','pmEditExpiryTracked']){
   assert.equal(nodes.get(id).checked,false);assert.equal(nodes.get(id).disabled,true);
 }
 nodes.get('pmEditProductType').value='Reagent';
 vm.runInContext('updateProductMasterServiceFields()',ctx);
 assert.equal(nodes.get('pmEditServiceKindField').hidden,true);
 for(const id of ['pmEditInventoryTracked','pmEditLotTracked','pmEditExpiryTracked'])
   assert.equal(nodes.get(id).disabled,false);
});
