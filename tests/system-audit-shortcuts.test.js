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

test('data audit accepts blank optional prices and still finds required fields and duplicates without writes', async () => {
 const {x,element}=setup();
 const products=[
  {id:'P1',brandName:'Roche',manufacturerPartNo:'A1',productName:'One'},
  {id:'P2',brandName:'Roche',manufacturerPartNo:'A2',productName:'Two',listPrice:null},
  {id:'P3',brandName:'Roche',manufacturerPartNo:'A3',productName:'Three',listPrice:''},
  {id:'P4',brandName:'Roche',manufacturerPartNo:'A4',productName:'Four',listPrice:0},
  {id:'P5',brandName:'Roche',manufacturerPartNo:'A1',productName:'Duplicate'},
  {id:'P6'}
 ];
 const reads=[];
 x.readCollectionInBatches=async name=>{reads.push(name);return name==='products'?products:[];};
 x.normalizeItemCodeLoose=value=>String(value||'').toLowerCase();
 x.normalizeBrandLookupKey=value=>String(value||'').toLowerCase();
 x.systemAuditActionLabel=()=> '查看';
 const start=source.indexOf('window.runSystemDataAudit = async function()');
 vm.runInContext(source.slice(start,source.indexOf('\n};',start)+3),x);
 await x.window.runSystemDataAudit();
 const issues=vm.runInContext('systemDataAuditIssues',x);
 assert.deepEqual(Array.from(issues,v=>v.type).sort(),[
  'Product Master 缺少廠牌','Product Master 缺少貨號','Product Master 缺少品名','Product Master 重複'
 ].sort());
 assert.equal(reads.length,10);
 assert.match(element('systemDataAuditStatus').textContent,/檢查完成/);
 assert.equal(element('systemDataAuditBtn').disabled,false);
 assert.equal(element('systemDataAuditBtn').textContent,'執行資料檢查');
});
