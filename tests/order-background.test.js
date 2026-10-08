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

function productCheckHarness(lookup) {
 const nodes=new Map();
 const node=id=>{if(!nodes.has(id))nodes.set(id,{value:'',dataset:{},innerHTML:'',style:{},focus(){this.focused=true;},scrollIntoView(){}});return nodes.get(id);};
 node('orderItemCode').value='A123';node('orderQty').value='3';node('orderUnitPrice').value='125';
 let brand='Brand';const events=[];
 const c=vm.createContext({window:{},document:{getElementById:node},orderModalOpenGeneration:1,newOrderDraftItems:[],
  clearQuickProductButton(){},clearProductMatchChoices(){},clearOrderProductMatch:input=>{input.dataset.productMasterMatched='0';c.window._orderModalProductId='';},
  getBrandFieldValue:()=>brand,resolveBrandName:s=>s,normalizeItemCodeLoose:s=>String(s).toUpperCase(),
  findProductsByCode:lookup,selectProductCodeMatch:(matches,b)=>{const rows=b?matches.filter(x=>x.brand===b):matches;return rows.length===1?rows[0]:null;},
  stableProductId:x=>x.productId,selectBrandInDropdown(){},onOrderBrandSelectChange(){},applyOrderProductCost:async()=>{},refreshOrderWarehouseStock:async()=>{},
  calcOrderTotal:()=>{node('orderTotalPrice').value=String(Number(node('orderQty').value)*Number(node('orderUnitPrice').value));},
  showQuickProductButton:()=>events.push('create'),showProductMatchChoices:()=>events.push('choose'),
  currentOrderModalItem:()=>({itemCode:node('orderItemCode').value,itemName:'Product',qty:Number(node('orderQty').value),unitPrice:Number(node('orderUnitPrice').value),
   productId:c.window._orderModalProductId,productMasterMatched:node('orderItemCode').dataset.productMasterMatched==='1',productCheckStatus:node('orderItemCode').dataset.productCheckStatus}),
  escapeHtml:s=>s,console
 });
 const a=src.indexOf('async function applyOrderProductMatch'),b=src.indexOf('\nlet orderItemCodeTimer',a);
 vm.runInContext(src.slice(a,b),c);
 const x=src.indexOf('function orderItemProductStatus('),y=src.indexOf('\nwindow.quickCreateNewOrderDraftItem',x);
 vm.runInContext(src.slice(x,y),c);
 return {c,node,events,setBrand:value=>{brand=value;}};
}

test('imported quote item immediately offers quick creation without editing its code; failed reads offer retry instead',async()=>{
 const a=productCheckHarness(async()=>[]);
 await a.c.window.onOrderItemCodeChange(a.node('orderItemCode'));
 assert.equal(a.node('orderItemCode').dataset.productCheckStatus,'missing');assert.deepEqual(a.events,['create']);
 const b=productCheckHarness(async()=>{throw Error('offline');});
 await b.c.window.onOrderItemCodeChange(b.node('orderItemCode'));
 assert.equal(b.node('orderItemCode').dataset.productCheckStatus,'error');assert.equal(b.events.length,0);
 assert.match(b.node('orderProductCheckStatus').innerHTML,/重試/);
});

test('quote product matching and later quick-create matching preserve the agreed price and quantity',async()=>{
 const a=productCheckHarness(async()=>[{productId:'P1',model:'A123',brand:'Brand',nameCn:'Master name',price:999}]);
 a.node('orderItemCode').dataset.preserveOrderPriceCode='A123';
 await a.c.window.onOrderItemCodeChange(a.node('orderItemCode'));
 assert.equal(a.node('orderUnitPrice').value,'125');assert.equal(a.node('orderQty').value,'3');
 assert.equal(a.c.window._orderModalProductId,'P1');assert.equal(a.node('orderItemCode').dataset.productMasterMatched,'1');
 assert.match(a.node('orderProductCheckStatus').innerHTML,/已建檔/);
 delete a.node('orderItemCode').dataset.preserveOrderPriceCode;
 await a.c.window.onOrderItemCodeChange(a.node('orderItemCode'));
 assert.equal(a.node('orderUnitPrice').value,999,'ordinary new-product selection still fills the list price');
});

test('late lookup cannot change an edited brand or a newly opened order',async()=>{
 for(const change of ['brand','modal']) {
  const pending=deferred(),a=productCheckHarness(()=>pending.promise);
  const p=a.c.window.onOrderItemCodeChange(a.node('orderItemCode'));
  if(change==='brand')a.setBrand('Other');else a.c.orderModalOpenGeneration++;
  pending.resolve([{productId:'old',model:'A123',brand:'Brand',price:999}]);await p;
  assert.equal(a.c.window._orderModalProductId,undefined);assert.equal(a.node('orderUnitPrice').value,'125');
 }
});

test('all imported draft rows show their own status and keep quantity and price',async()=>{
 const a=productCheckHarness(async code=>{
  if(code==='ERROR')throw Error('offline');
  if(code==='MISSING')return [];
  if(code==='AMBIGUOUS')return [{productId:'P2',brand:'B'},{productId:'P3',brand:'C'}];
  return [{productId:'P1',brand:'Brand',price:999}];
 });
 a.c.newOrderDraftItems=['FOUND','MISSING','ERROR','AMBIGUOUS'].map(code=>({itemCode:code,itemName:code,brand:code==='AMBIGUOUS'?'':'Brand',qty:2,unitPrice:125}));
 await a.c.checkNewOrderDraftProducts();
 assert.deepEqual(Array.from(a.c.newOrderDraftItems,x=>x.productCheckStatus),['matched','missing','error','ambiguous']);
 for(const item of a.c.newOrderDraftItems){assert.equal(item.qty,2);assert.equal(item.unitPrice,125);}
 assert.match(a.node('newOrderItemsBody').innerHTML,/quickCreateNewOrderDraftItem\(1\)/);
 assert.match(a.node('newOrderItemsBody').innerHTML,/查詢失敗/);assert.match(a.node('newOrderItemsBody').innerHTML,/待選擇產品/);
 const pending=deferred(),b=productCheckHarness(()=>pending.promise);
 const item={itemCode:'OLD',brand:'Brand'};b.c.newOrderDraftItems=[item];const p=b.c.checkNewOrderDraftProducts();
 b.c.orderModalOpenGeneration++;pending.resolve([{productId:'P1',brand:'Brand'}]);await p;
 assert.equal(item.productId,undefined);
});

test('save identifies every unfinished item and focuses the first one without creating an order',()=>{
 const a=productCheckHarness(async()=>[]),messages=[],edited=[];
 a.c.newOrderSaveInProgress=false;
 a.c.newOrderDraftItems=[{itemCode:'A',itemName:'Alpha',qty:1,productCheckStatus:'missing'},{itemCode:'B',itemName:'Beta',qty:1,productCheckStatus:'error'}];
 a.c.alert=s=>messages.push(s);a.c.editNewOrderDraftItem=i=>edited.push(i);
 const start=src.indexOf('window.saveNewOrder = function()'),end=src.indexOf('    const assistedOwner',start);
 vm.runInContext(src.slice(start,end)+'};',a.c);a.c.window.saveNewOrder();
 assert.match(messages[0],/第 1 項 A（未建檔）/);assert.match(messages[0],/第 2 項 B（查詢失敗）/);
 assert.deepEqual(edited,[0]);assert.equal(a.node('orderItemCode').focused,true);
});

test('quick creation applies the saved product immediately despite a cached earlier miss',async()=>{
 for(const duplicate of [false,true]) {
  const a=productCheckHarness(async()=>[]),product={productId:'P1',model:'A123',brand:'Brand',nameCn:'Product',price:999};
  const cache=new Map([['A123',[]]]),writes=[];
  for(const [id,value] of Object.entries({quickProductBrand:'Brand',quickProductCode:'A123',quickProductName:'Product',quickProductPrice:'999'}))a.node(id).value=value;
  a.node('orderItemCode').dataset.preserveOrderPriceCode='A123';
  Object.assign(a.c,{quickProductTarget:{mode:'order',input:a.node('orderItemCode')},currentUser:{uid:'U'},priceList:[],productCodeMatchCache:cache,
   brandMasterEntryForName:()=>({id:'B1'}),normalizeBrandLookupKey:x=>x,productMasterDocToPriceItem:()=>product,
   firestoreReadWithTimeout:async p=>p,beginActionButton:()=>({}),endActionButton(){},refreshPriceDatalists(){},
   closeQuickProductCreate(){},clearQuickProductDraft(){},alert(){},
   db:{collection:()=>({where(){return this;},limit(){return this;},get:async()=>({docs:duplicate?[{data:()=>({brandName:'Brand'})}]:[]}),doc:()=>({set:async data=>writes.push(data)})})}
  });
  const start=src.indexOf('window.saveQuickProduct = async function()'),end=src.indexOf('\nfunction rebuildPriceItemLookup',start);
  vm.runInContext(src.slice(start,end),a.c);await a.c.window.saveQuickProduct();
  assert.equal(cache.has('A123'),false);assert.equal(a.c.window._orderModalProductId,'P1');
  assert.equal(a.node('orderItemCode').dataset.productCheckStatus,'matched');assert.equal(a.node('orderUnitPrice').value,'125');
  assert.equal(writes.length,duplicate?0:1);
 }
});
