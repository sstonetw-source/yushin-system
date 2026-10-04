const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function setup(){
 const calls=[],elements=new Map();
 const element=id=>{if(!elements.has(id))elements.set(id,{value:'',innerHTML:'',textContent:'',classList:{add(){},remove(){}},addEventListener(){}});return elements.get(id);};
 const x=vm.createContext({window:{},trueUserRole:'admin',currentUserRole:'admin',document:{getElementById:element,createElement:()=>element('systemAuditIssueOverlay'),body:{appendChild(){}},querySelector:()=>({})},
 escapeHtml:s=>String(s).replace(/[<>&"']/g,'_'),openProductMasterEditor:async id=>calls.push(['edit',id]),populateProductMasterEditor:(...args)=>calls.push(['create',...args]),
 showActionFeedback:(...args)=>calls.push(['notice',...args]),switchMainTab:()=>{},searchProductManagement:async()=>calls.push(['search',element('productManagementSearch').value]),
 switchInventoryWorkView:async()=>{},runInventoryUnifiedSearchNow:async()=>calls.push(['inventory',element('inventorySearch').value]),ordersCache:[{id:'O1',itemName:'stale'}],
 db:{collection:name=>({doc:id=>({get:async()=>({exists:true,id,data:()=>({itemName:'fresh'})})})})},firestoreReadWithTimeout:p=>p,openDeliveryModal:id=>calls.push(['order',id]),
 openPurchaseOrderTimeline:async id=>calls.push(['purchase',id]),switchAdminTab:()=>{},console
 });
 vm.runInContext(source.slice(source.indexOf('let systemDataAuditIssues = [];'),source.indexOf('window.runSystemDataAudit = async function()')),x);
 const issues=value=>{x.testIssues=value;vm.runInContext('systemDataAuditIssues=testIssues',x);};
 return {x,calls,issues,element};
}
test('audit shortcuts preserve the exact product document identity',async()=>{
 const {x,calls,issues}=setup();issues([{type:'Product Master 缺少品名',target:{kind:'product',record:{id:'exact-doc',productId:'other-id'}}}]);
 await x.window.openSystemAuditIssue(0);assert.deepEqual(calls,[['edit','exact-doc']]);
});
test('encoded warehouse keys yield item code for lookup and a new product draft never inherits stock ID',async()=>{
 const {x,calls,issues}=setup();assert.equal(x.systemAuditItemCode({id:'wh%3A主倉__prd%3ARoche%3A06612601001'}),'06612601001');
 issues([{type:'分倉找不到 Product',target:{kind:'stock',record:{id:'wh:main__code:500-0006',brand:'Roche'}}}]);
 await x.window.followSystemAuditShortcut(0,'product-new');
 assert.equal(Object.keys(calls[0][1]).length,0);assert.equal(calls[0][2].itemCode,'500-0006');assert.equal(calls[0][2].brand,'Roche');
});
test('inventory shortcut clears filters that would hide the affected item',async()=>{
 const {x,calls,issues,element}=setup();issues([{target:{kind:'stock',record:{id:'wh:main__code:A1'}}}]);
 element('inventoryBrandFilter').value='other';element('inventoryPolicyFilter').value='NO_STOCK';element('inventoryStateFilter').value='low';
 await x.window.followSystemAuditShortcut(0,'inventory');assert.deepEqual(calls,[['inventory','A1']]);assert.equal(element('inventoryBrandFilter').value,'');assert.equal(element('inventoryStateFilter').value,'all');
});
test('source order shortcut reads current document before opening progress',async()=>{
 const {x,calls,issues}=setup();issues([{target:{kind:'demand',record:{sourceId:'O1'}}}]);
 await x.window.followSystemAuditShortcut(0,'order');assert.equal(x.ordersCache[0].itemName,'fresh');assert.deepEqual(calls,[['order','O1']]);
});
test('shortcuts are inactive when administrator is viewing as another role',async()=>{
 const {x,calls,issues}=setup();issues([{target:{kind:'product',record:{id:'P1'}}}]);x.currentUserRole='sales';
 await x.window.openSystemAuditIssue(0);await x.window.followSystemAuditShortcut(0,'product-new');assert.equal(calls.length,0);
});
