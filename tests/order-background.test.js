const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const src=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
const chain=src.slice(src.indexOf("    let createdOrderId = '';",src.indexOf('window.saveNewOrder =')),src.indexOf('\n};',src.indexOf("    let createdOrderId = '';",src.indexOf('window.saveNewOrder ='))));
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject};}
function setup(){
 const create=deferred(),reserve=deferred(),events=[],storage=new Map([['pending','O1'],['draft','original']]);
 const x=vm.createContext({window:{_orderModalSourceLink:'old'},currentUser:{uid:'U1'},savingUid:'U1',savingGeneration:1,orderModalOpenGeneration:1,savedDraftKey:'draft',savedPendingKey:'pending',
 localStorage:{getItem:k=>storage.get(k),removeItem:k=>storage.delete(k)},data:{inventoryReservationStatus:'pending',customerName:'C',orderDate:'2026-10-04'},
 pendingOrderReservationIds:new Set(),createOrResumeNewOrder:()=>create.promise,reserveInventoryForNewOrder:async()=>{events.push('reserve');await reserve.promise;},
 db:{collection:()=>({doc:()=>({set:async()=>{}})})},inventoryProductKey:()=> 'P1',orderReservationSummary:()=>({}),rememberRecentCustomerName(){},syncNewOrderSourceDocuments:async()=>null,
 ordersCache:[],writeAppDataCache(){},renderOrdersList(){},syncOrderIntoPurchasingCaches(){},closeOrderModal:()=>events.push('closed'),showActionFeedback:(...a)=>events.push(a),alert:s=>events.push(['alert',s]),
 saveButton:{disabled:true,innerText:'儲存中'},newOrderSaveInProgress:true,console
 });
 return {x,create,reserve,events,storage,run:()=>vm.runInContext(`(async()=>{${chain}})()`,x)};
}
async function tick(){await new Promise(r=>setImmediate(r));}
test('order closes only after confirmed creation and releases form before inventory synchronization completes',async()=>{
 const a=setup(),p=a.run();assert.equal(a.events.includes('closed'),false);a.create.resolve({id:'O1',data:a.x.data});await tick();
 assert.equal(a.events.includes('closed'),true);assert.equal(a.x.newOrderSaveInProgress,false);assert.equal(a.x.ordersCache[0].inventoryReservationStatus,'pending');assert.equal(a.storage.has('pending'),false);
 a.reserve.resolve();await p;assert.equal(a.x.ordersCache[0].inventoryReservationStatus,'completed');
});
test('old background completion does not clear a new form or release its active save',async()=>{
 const a=setup(),p=a.run();a.create.resolve({id:'O1',data:a.x.data});await tick();
 a.x.orderModalOpenGeneration=2;a.x.newOrderSaveInProgress=true;a.x.saveButton.disabled=true;a.x.window._orderModalSourceLink='new';a.storage.set('draft','new draft');
 a.reserve.resolve();await p;assert.equal(a.x.newOrderSaveInProgress,true);assert.equal(a.x.saveButton.disabled,true);assert.equal(a.x.window._orderModalSourceLink,'new');assert.equal(a.storage.get('draft'),'new draft');assert.equal(a.events.filter(e=>e==='closed').length,1);
});
test('background failure retains the created order and exposes retry state without a blocking alert',async()=>{
 const a=setup(),p=a.run();a.create.resolve({id:'O1',data:a.x.data});await tick();a.reserve.reject(Error('offline'));await p;
 assert.equal(a.x.ordersCache[0].id,'O1');assert.equal(a.x.ordersCache[0].inventoryReservationStatus,'failed');assert.equal(a.x.pendingOrderReservationIds.size,0);assert.equal(a.events.some(e=>Array.isArray(e)&&e[0]==='alert'),false);
});
test('uncertain creation leaves modal and recovery identity intact',async()=>{
 const a=setup(),p=a.run();a.create.reject(Error('offline'));await p;assert.equal(a.events.includes('closed'),false);assert.equal(a.storage.get('pending'),'O1');assert.equal(a.x.newOrderSaveInProgress,false);assert.equal(a.events.includes('reserve'),false);
});
test('pending and failed synchronization block purchasing and dispatch calculations',()=>{
 const guard=src.slice(src.indexOf('function orderInventorySyncIncomplete'),src.indexOf('function canRetryOrderInventorySync'));
 const pending=src.slice(src.indexOf('function pendingPurchaseLines'),src.indexOf('\nfunction ',src.indexOf('function pendingPurchaseLines')+10));
 const dispatch=src.slice(src.indexOf('function itemDispatchState'),src.indexOf('function orderContextActionState'));
 const x=vm.createContext({window:{},normalizedOrderItems:()=>{throw Error('unready order should exit early')}});vm.runInContext(guard+pending+dispatch,x);
 for(const state of ['pending','failed']){const order={inventoryReservationStatus:state};assert.equal(x.pendingPurchaseLines(order).length,0);assert.equal(x.itemDispatchState(order,{qty:2}).shippable,0);}
});
function retrySetup(liveStatus='pending'){
 const reserve=deferred(),events=[],x=vm.createContext({window:{addEventListener(){}},currentUser:{uid:'U1'},currentUserRole:'sales',ordersCache:[{id:'O1',createdByUid:'U1',inventoryReservationStatus:'pending'}],
 normalizedOrderStatus:order=>order.status==='cancelled'?'cancelled':'normal',renderOrdersList(){},writeAppDataCache(){},showActionFeedback:(...a)=>events.push(a),syncOrderIntoPurchasingCaches(){},syncNewOrderSourceDocuments:async()=>null,escapeAttr:s=>s,
 db:{collection:()=>({doc:id=>({get:async()=>({exists:true,id,data:()=>({createdByUid:'U1',inventoryReservationStatus:liveStatus})}),set:async updates=>events.push(updates)})})},firestoreReadWithTimeout:p=>p,reserveInventoryForNewOrder:async()=>{events.push('reserve');await reserve.promise;},console
 });
 vm.runInContext(src.slice(src.indexOf('const pendingOrderReservationIds = new Set();'),src.indexOf('// 採購主頁資料')),x);return {x,reserve,events};
}
test('retry restores a pending order using current saved document and blocks double clicks',async()=>{
 const a=retrySetup(),p=a.x.window.retryOrderInventoryReservation('O1');await tick();await a.x.window.retryOrderInventoryReservation('O1');
 assert.equal(a.events.filter(e=>e==='reserve').length,1);a.reserve.resolve();await p;assert.equal(a.x.ordersCache[0].inventoryReservationStatus,'completed');
});
test('retry skips inventory reservation if cloud already completed it',async()=>{
 const a=retrySetup('completed');await a.x.window.retryOrderInventoryReservation('O1');assert.equal(a.events.includes('reserve'),false);assert.equal(a.x.ordersCache[0].inventoryReservationStatus,'completed');
});
