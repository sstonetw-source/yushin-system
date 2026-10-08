const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const code=source.slice(source.indexOf('let quickPurchaseConfirmation ='),source.indexOf('window.markPurchaseItemOrdered ='));
function setup(existing=null){
 const nodes={};for(const id of ['quickPurchaseConfirmationOverlay','quickPurchaseSummary','quickPurchaseSupplier','quickPurchaseQty','quickPurchaseCost','quickPurchaseHint'])nodes[id]={value:'',classList:{add:()=>{},remove:()=>{}}};
 const alerts=[],reads=[];const order={items:[{itemId:'i',itemCode:'001',itemName:'Item',productId:'p',supplier:'Vendor'}]};
 const snapshot=(data)=>({exists:!!data,data:()=>data});
 const c=vm.createContext({window:{},document:{getElementById:id=>nodes[id]},alert:x=>alerts.push(x),normalizedOrderStatus:()=> 'normal',normalizedOrderItems:o=>o.items,
 procurementDemandForOrderItem:()=>({remainingToOrderQty:3}),quickPurchaseSupplyId:()=> 'manual-o-i',firestoreReadWithTimeout:p=>p,
 db:{collection:name=>({doc:id=>({get:async()=>{reads.push(name);return snapshot(name==='orders'?order:{standardCost:40});}})})},supplyOrdersCollection:()=>({doc:()=>({get:async()=>snapshot(existing)})})});
 c.closeQuickPurchaseConfirmation=()=>c.window.closeQuickPurchaseConfirmation();vm.runInContext(code,c);return {c,nodes,alerts,reads};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('confirmation brings in protected standard cost and accepts actual price without writing',async()=>{const x=setup();const pending=x.c.requestQuickPurchaseDetails('o','i');await tick();assert.equal(x.nodes.quickPurchaseCost.value,40);assert.equal(x.nodes.quickPurchaseSupplier.value,'Vendor');assert.equal(x.nodes.quickPurchaseQty.value,3);x.nodes.quickPurchaseCost.value='42';x.c.window.confirmQuickPurchase();const details=await pending;assert.equal(details.unitCost,42);assert.equal(details.expectedQty,3);assert.equal(details.supplier,'Vendor');});
test('empty or negative cost blocks confirmation; cancellation resolves without purchase',async()=>{const x=setup();const pending=x.c.requestQuickPurchaseDetails('o','i');await tick();for(const value of ['',-1,'NaN']){x.nodes.quickPurchaseCost.value=value;x.c.window.confirmQuickPurchase();}assert.equal(x.alerts.length,3);x.c.window.closeQuickPurchaseConfirmation();assert.equal(await pending,null);});
test('additional supply uses its actual price and supplier instead of changing old price to standard cost',async()=>{const x=setup({unitCost:33,supplier:'Original Vendor'});const pending=x.c.requestQuickPurchaseDetails('o','i');await tick();assert.equal(x.nodes.quickPurchaseCost.value,33);assert.equal(x.nodes.quickPurchaseSupplier.value,'Original Vendor');x.c.window.closeQuickPurchaseConfirmation();await pending;});
test('cancelled confirmation makes no transaction; invalid confirmed costs fail before transaction',async()=>{
 const action=source.slice(source.indexOf('window.markPurchaseItemOrdered ='),source.indexOf('window.openOrderPurchaseDraft ='));
 for(const details of [null,{supplier:'Vendor',unitCost:-1},{supplier:'',unitCost:50},{supplier:'Vendor',unitCost:NaN}]){
 let transactions=0;const c=vm.createContext({window:{},canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,pendingPurchaseOrderKeys:new Set(),requestQuickPurchaseDetails:async()=>details,
 runRoleTransaction:()=>{transactions++;},alert:()=>{}});vm.runInContext(action,c);await c.window.markPurchaseItemOrdered('o','i');assert.equal(transactions,0);assert.equal(c.pendingPurchaseOrderKeys.size,0);
 }
});

test('explicit zero cost is accepted and preserved for complimentary accessories',async()=>{const x=setup({unitCost:0,supplier:'Vendor'});const pending=x.c.requestQuickPurchaseDetails('o','i');await tick();assert.equal(x.nodes.quickPurchaseCost.value,0);x.nodes.quickPurchaseCost.value='0';x.c.window.confirmQuickPurchase();assert.equal((await pending).unitCost,0);assert.equal(x.alerts.length,0);});
