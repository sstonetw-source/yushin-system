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
 assert.match(overlay.innerHTML,/<option value="Service">服務<\/option>/);
 assert.match(overlay.innerHTML,/id="pmEditServiceKind"/);
 assert.match(overlay.innerHTML,/id="pmEditFrequentlySold"/);
 assert.doesNotMatch(overlay.innerHTML,/pmEdit(?:Inventory|Lot|Expiry)Tracked/);
 assert.match(overlay.innerHTML,/updateProductMasterServiceFields\(\)/);
 assert.ok(html.indexOf('modules/service-work-core.js')<html.indexOf('app.js?v'));
});
test('choosing Service reveals the existing subtype control and Other retains custom product types',()=>{
 const nodes=new Map([['pmEditProductType',{value:'Service'}],
   ['pmEditServiceKindField',{hidden:true}],['pmEditCustomProductType',{value:'Custom',hidden:true}]]);
 const ctx=vm.createContext({document:{getElementById:id=>nodes.get(id)},normalizeProductTypeValue:value=>value});
 vm.runInContext(editor+'\nupdateProductMasterServiceFields()',ctx);
 assert.equal(nodes.get('pmEditServiceKindField').hidden,false);
 assert.equal(nodes.get('pmEditCustomProductType').hidden,true);
 nodes.get('pmEditProductType').value='__custom__';
 vm.runInContext('updateProductMasterServiceFields()',ctx);
 assert.equal(nodes.get('pmEditServiceKindField').hidden,true);
 assert.equal(nodes.get('pmEditCustomProductType').hidden,false);
 assert.equal(vm.runInContext('readProductMasterEditorType()',ctx),'Custom');
});
