'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const editor=fs.readFileSync(path.join(__dirname,'../src/features/purchasing/purchase-order-editor.js'),'utf8');
const workspace=fs.readFileSync(path.join(__dirname,'../src/features/purchasing/purchasing-workspace.js'),'utf8');
const draft=workspace.slice(workspace.indexOf('window.openOrderPurchaseDraft ='),workspace.indexOf('window.openSelectedPurchaseDraft ='));
function fixture(){
 let release,reject;
 const loading=new Promise((resolve,fail)=>{release=resolve;reject=fail;});
 const nodes=new Map(),alerts=[];
 const node=id=>{if(!nodes.has(id))nodes.set(id,{style:{},value:'',textContent:'',innerText:'',disabled:false,classList:{active:false,add(){this.active=true;},remove(){this.active=false;},contains(){return this.active;}}});return nodes.get(id);};
 const controls=['poVendorName','poDate','poExpectedDate','poLeadDays','qty','unitPrice'].map(node);
 const c=vm.createContext({console,Date,window:null,currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
  document:{getElementById:node,querySelectorAll:selector=>selector.includes('purchasePendingBody')?[]:controls},
  canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
  ordersCache:[{id:'O',company:'yushin'}],normalizedOrderStatus:()=> 'normal',
  pendingPurchaseLines:()=>[{orderId:'O',itemId:'I',qty:3,unitPrice:20}],
  populatePoVendorSuggestions:()=>{},localDateString:()=> '2026-10-21',clearPoExpectedDate:()=>{},
  bestPurchaseOrderCompany:()=> 'yushin',loadSupplierWarehouseMasters:()=>loading,
  preloadPurchaseCostsForItems:async()=>{},alert:message=>alerts.push(message)});
 c.window=c;vm.runInContext(editor,c);
 vm.runInContext(draft,c);
 c.bestPurchaseOrderCompany=()=> 'yushin';c.populatePoVendorSuggestions=()=>{};c.clearPoExpectedDate=()=>{};
 c.switchPoCompany=()=>{};c.generatePoNo=()=>vm.runInContext('poNoReady=true;updatePoSaveButton()',c);
 c.renderPoItemsTable=()=>{};c.updatePoModeUI=()=>{};
 c.autoFillPoSupplier=async(items,isCurrent)=>{await loading;if(isCurrent())node('poVendorName').value='Default supplier';};
 return {c,node,controls,release,reject,alerts};
}
test('original draft is visible but cannot edit or submit until delayed metadata is ready',async()=>{
 const x=fixture(),opening=x.c.openOrderPurchaseDraft('O','I');
 assert.equal(x.node('poModalOverlay').classList.active,true);
 assert.equal(x.node('printPurchaseOrderBtn').disabled,true);
 assert.ok(x.controls.every(control=>control.disabled));
 // Direct invocation must also stop before opening PDF preparation or any writer.
 x.c.canCreatePurchaseOrderCapability=()=>{throw Error('submit escaped loading guard');};
 await x.c.printPurchaseOrder();
 x.release();await opening;
 assert.ok(x.controls.every(control=>!control.disabled));
 assert.equal(x.node('printPurchaseOrderBtn').disabled,false);
 x.node('poVendorName').value='User supplier';
 // Run the actual line update; it must preserve the now editable header.
 x.c.updatePoItem(0,'qty','2');x.c.updatePoItem(0,'unitPrice','25');
 assert.equal(x.node('poVendorName').value,'User supplier');
 assert.equal(vm.runInContext('poItems[0].qty',x.c),2);
 assert.equal(x.alerts.length,0);
});
test('closing a loading draft invalidates its callback before a replacement form opens',async()=>{
 const x=fixture(),opening=x.c.openOrderPurchaseDraft('O','I');
 x.c.closePurchaseOrderModal();
 x.node('poModalOverlay').classList.add('active');
 x.node('poVendorName').value='Replacement';
 vm.runInContext("poItems=[{qty:9}];",x.c);
 x.release();await opening;
 assert.equal(x.node('poVendorName').value,'Replacement');
 assert.equal(vm.runInContext('poItems[0].qty',x.c),9);
 assert.equal(x.alerts.length,0);
});
test('failed metadata load closes the partial draft and releases loading controls',async()=>{
 const x=fixture(),opening=x.c.openOrderPurchaseDraft('O','I');
 x.reject(Error('offline'));await opening;
 assert.equal(x.node('poModalOverlay').classList.active,false);
 assert.ok(x.controls.every(control=>!control.disabled));
 assert.equal(x.node('printPurchaseOrderBtn').disabled,true);
 assert.match(x.alerts[0],/offline/);
});
test('late metadata after account switch cannot change supplier or lines',async()=>{
 const x=fixture(),opening=x.c.openOrderPurchaseDraft('O','I');
 x.c.currentUser={uid:'other'};x.node('poVendorName').value='Other account';
 x.release();await opening;
 assert.equal(x.node('poVendorName').value,'Other account');
 assert.equal(x.alerts.length,0);
});
