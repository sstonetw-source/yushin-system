'use strict';
// Real production renderers, click handler and Service/Core, with an in-memory
// transaction transport. Actual Client SDK + Rules integration is tested separately.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const read=p=>fs.readFileSync(p,'utf8');
const workspace=read('src/features/orders/order-workspace.js'),purchasing=read('src/features/purchasing/purchasing-workspace.js');
function section(s,a,b){const start=s.indexOf(a),end=s.indexOf(b,start);assert.ok(start>=0&&end>start);return s.slice(start,end);}
const scripts=[read('src/shared/workspace-display.js'),read('modules/fulfillment-core.js'),read('modules/order-entry-core.js'),
 `let currentUser={uid:'buyer'},currentUserRole='purchaser',ordersCache=[],purchasingDispatchCache=[],currentDeliveryOrderId=null;
 const pendingDispatchOrderIds=new Set();let sequence=0;
 const db={collection:n=>({doc:id=>({id:id||'AAAAAAAAAAAA'+Date.now()+'-'+(++sequence),path:n+'/'+id,get:async()=>{const data=await nativeRead(n+'/'+id);return {exists:!!data,data:()=>data};}})})};
 const normalizedOrderStatus=o=>o.status==='cancelled'?'cancelled':'normal',normalizedOrderItems=o=>structuredClone(o.items);
 const orderInventorySyncIncomplete=o=>['pending','failed'].includes(o.inventoryReservationStatus);
 const savedDeliveryRecords=o=>o.deliveryRecords||[],savedReturnRecords=o=>o.returnRecords||[];
 const deliveryActor=()=>currentUser.uid,orderWorkIndexFields=()=>({});
 const escapeHtml=x=>String(x||''),inlineJsValue=x=>JSON.stringify(x).replaceAll('"','&quot;');
 const defaultWarehouse=()=>({id:'A'}),purchaseFilterContext=()=>({}),purchaseLineMatchesFilters=()=>true;
 const orderLifecycleInfo=()=>({}),orderItemDisplayCategories=(o,i,l,s)=>s.pending>0?['dispatch']:['shipping'];
 let purchasingDispatchLoading=false,purchasingDispatchHasMore=false,purchasingDispatchError='';
 function syncOrderIntoPurchasingCaches(){}function writeAppDataCache(){}function renderDeliveryModal(){}
 function renderOrdersList(){document.getElementById('orderActions').innerHTML=ordersCache.map(o=>dispatchActionHtml(o)).join('');}
 function renderPurchasingView(){renderPurchasingDispatchOrders();}
 window.alerts=[];window.alert=m=>alerts.push(m);
 async function runRoleTransaction(fn){const writes=[];await fn({get:async r=>{const data=await nativeRead(r.path);return {exists:!!data,data:()=>data};},
 set:(r,data)=>writes.push([r.path,data]),update:(r,data)=>writes.push([r.path,data])});await nativeCommit(writes);}
 async function reloadOrder(){ordersCache=[await nativeRead('orders/O')];purchasingDispatchCache=ordersCache;renderOrdersList();renderPurchasingView();}
 `,
 section(workspace,'function itemDispatchState(','function orderLifecycleActionButtons('),
 read('src/services/dispatch-preparation.js'),
 section(workspace,'function dispatchActionHtml(','\n\nasync function refreshAffectedOrderCaches'),
 section(purchasing,'function renderPurchasingDispatchOrders(','\nfunction pendingPurchaseLines(')];
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
 assert.ok(executablePath,'Chrome required');const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{for(const width of [1280,390]){
  let lost=true;const docs=new Map([['orders/O',{id:'O',status:'active',transactionType:'借',orderDate:'2026-10-18',customerName:'測試客戶',salesName:'業務',items:[
   {itemId:'I',productId:'P',warehouseId:'A',itemCode:'A1',qty:5,reservedQty:3,dispatchPreparedQty:0},
   {itemId:'J',productId:'Q',warehouseId:'B',itemCode:'B2',qty:2,reservedQty:2,dispatchPreparedQty:0}]}]]);
  const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('nativeRead',p=>docs.get(p)||null);
  await page.exposeFunction('nativeCommit',writes=>{for(const [p,d] of writes)docs.set(p,{...docs.get(p),...d});if(lost&&writes.length){lost=false;throw Error('模擬成功回覆遺失');}});
  await page.route('http://dispatch.test/',route=>route.fulfill({contentType:'text/html',body:'<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="order-system" class="active"><div id="orderActions"></div></div><div id="purchasing-system"><table><tbody id="purchaseDispatchBody"></tbody></table><div id="purchaseDispatchStatus"></div><button id="purchaseDispatchMoreBtn"></button></div></html>'}));
  async function load(){await page.goto('http://dispatch.test/');await page.addStyleTag({content:read('styles.css')});for(const content of scripts)await page.addScriptTag({content});await page.evaluate(()=>reloadOrder());}
  await load();await page.locator('#orderActions button').first().click();await page.waitForFunction(()=>alerts.length===1);
  assert.equal(docs.get('orders/O').items[0].dispatchPreparedQty,3,JSON.stringify(await page.evaluate(()=>alerts)));
  // A later arrival must not be included in the uncertain operation.
  docs.get('orders/O').items[0].reservedQty=5;
  await load();assert.match(await page.locator('#orderActions button').first().textContent(),/確認打單結果/);
  await page.evaluate(()=>{document.getElementById('order-system').classList.remove('active');document.getElementById('purchasing-system').classList.add('active');});
  await page.locator('#purchaseDispatchBody button[onclick^="markOrderItemDispatchPrepared"]').first().click();await page.waitForFunction(()=>!pendingDispatchPreparation('O','I'));
  assert.equal(docs.get('orders/O').items[0].dispatchPreparedQty,3);
  assert.equal([...docs.keys()].filter(p=>p.startsWith('dispatchRecords/')).length,1);
  await page.locator('#purchaseDispatchBody button[onclick^="markOrderItemDispatchPrepared"]').first().click();await page.waitForFunction(()=>ordersCache[0].items[0].dispatchPreparedQty===5);
  assert.equal([...docs.keys()].filter(p=>p.startsWith('dispatchRecords/')).length,2);
  for(const role of ['sales','engineer','warehouse']){await page.evaluate(r=>{currentUserRole=r;renderOrdersList();renderPurchasingView();},role);assert.equal(await page.locator('#orderActions button').count(),0);assert.equal(await page.locator('#purchaseDispatchBody button[onclick^="markOrderItemDispatchPrepared"]').count(),0);}
  await page.evaluate(()=>{currentUserRole='admin';renderOrdersList();renderPurchasingView();});assert.equal(await page.locator('#purchaseDispatchBody button[onclick^="markOrderItemDispatchPrepared"]').count(),1);
  assert.deepEqual(errors,[]);console.log(`Dispatch ${width}px: real renderers -> shared Service/Core, lost reply, reload, cross-page retry, new arrival and five-role visibility passed.`);await page.close();
 }
 for(const width of [1280,390]){
  const docs=new Map([['orders/O',{id:'O',status:'active',transactionType:'借',inventoryReservationStatus:'completed',inventoryReservationAttemptId:'chrome-v2-sync',orderDate:'2026-10-19',customerName:'多倉測試',items:[
   {itemId:'I',productId:'P',warehouseId:'A',itemCode:'A1',qty:5,reservedQty:2,dispatchPreparedQty:1,warehouseShippedQty:1,deliveredQty:0},
   {itemId:'J',productId:'Q',warehouseId:'B',itemCode:'B2',qty:2,reservedQty:2,dispatchPreparedQty:0}]}]]),calls=[];let lost=true;
  const page=await browser.newPage({viewport:{width,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('nativeRead',p=>docs.get(p)||null);await page.exposeFunction('nativeCommit',()=>{throw Error('legacy v2 write forbidden');});
  await page.exposeFunction('nativeV2Callable',payload=>{
   calls.push(payload);assert.equal(payload.quantity,2);assert.equal(payload.expectedPreparedQty,1);assert.equal(payload.syncAttemptId,'chrome-v2-sync');assert.equal(payload.actorUid,undefined);
   const key='dispatchRecords/v2-'+payload.operationId,exists=docs.has(key);
   if(!exists){docs.set(key,{...payload});docs.get('orders/O').items[0].dispatchPreparedQty=3;}
   if(lost){lost=false;throw Error('模擬 v2 Callable 回覆遺失');}
   return {data:{orderId:'O',itemId:'I',qty:2,preparedQty:3,status:exists?'already-applied':'applied',recordId:'v2-'+payload.operationId}};
  });
  await page.route('http://127.0.0.1:4173/',route=>route.fulfill({contentType:'text/html',body:'<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="order-system" class="active"><div id="orderActions"></div></div><div id="purchasing-system"><table><tbody id="purchaseDispatchBody"></tbody></table><div id="purchaseDispatchStatus"></div><button id="purchaseDispatchMoreBtn"></button></div></html>'}));
  async function loadV2(){await page.goto('http://127.0.0.1:4173/');for(const content of scripts)await page.addScriptTag({content});await page.evaluate(()=>{
   globalThis.YUSHIN_V2_DISPATCH_EMULATOR=true;const app={options:{projectId:'demo-yushin'}};db.app=app;
   globalThis.firebase={app(){return {...app,functions:region=>this.functions(region)};},auth:()=>({app,currentUser:{uid:'buyer'},emulatorConfig:{host:'127.0.0.1',port:9099}}),functions:()=>({app,useEmulator:(host,port)=>{if(host!=='127.0.0.1'||port!==5001)throw Error('remote endpoint forbidden');},httpsCallable:name=>{if(name!=='prepareV2OrderDispatch')throw Error('wrong endpoint');return nativeV2Callable;}})};
  });await page.evaluate(()=>reloadOrder());}
  await loadV2();assert.match(await page.locator('#orderActions button').first().textContent(),/× 2/);await page.locator('#orderActions button').first().click();await page.waitForFunction(()=>alerts.length===1);
  const id=calls[0].operationId;docs.get('orders/O').items[0].reservedQty=4;await loadV2();assert.match(await page.locator('#orderActions button').first().textContent(),/確認打單結果/);
  await page.evaluate(()=>{document.getElementById('order-system').classList.remove('active');document.getElementById('purchasing-system').classList.add('active');});
  await page.locator('#purchaseDispatchBody button[onclick^="markOrderItemDispatchPrepared"]').first().click();await page.waitForFunction(()=>!pendingDispatchPreparation('O','I'));
  assert.equal(calls.length,2);assert.equal(calls[1].operationId,id);assert.equal(docs.get('orders/O').items[0].dispatchPreparedQty,3);assert.equal([...docs.keys()].filter(k=>k.startsWith('dispatchRecords/')).length,1);
  assert.equal(await page.evaluate(()=>itemDispatchState(ordersCache[0],ordersCache[0].items[0]).pending),2);assert.deepEqual(errors,[]);
  console.log(`V2 dispatch ${width}px: original two-page UI, physical shipment Core, frozen sync/baseline and cross-page uncertain reply retry passed (scripted local transport).`);await page.close();
 }

 // The original warehouse confirmation button must retain the same shipment ID
 // after Chrome reload. Real Auth/Callable is covered by the separate Emulator test.
 for(const width of [1280,390]){
  const doc={id:'O',status:'active',inventoryReservationStatus:'completed',inventoryReservationAttemptId:'browser-sync',
   items:[{itemId:'I',productId:'P',warehouseId:'B',qty:2,dispatchPreparedQty:2,warehouseShippedQty:0,
    deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'Customer',phone:'02-12345678',address:'Taipei'}}]};
  let lost=true,calls=0,stockWrites=0;
  const page=await browser.newPage({viewport:{width,height:850}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.exposeFunction('shipmentRead',()=>structuredClone(doc));
  await page.exposeFunction('shipmentCallable',payload=>{
   calls++;assert.equal(payload.warehouseId,'B');assert.equal(payload.syncAttemptId,'browser-sync');
   assert.equal(payload.actorUid,undefined);assert.equal(payload.actorRole,undefined);
   if(!doc.warehouseShipmentRecords){doc.warehouseShipmentRecords=[{id:payload.operationId,orderId:payload.orderId,
    itemId:payload.itemId,warehouseId:payload.warehouseId,qty:payload.quantity,date:payload.date,
    notes:payload.notes,deliveryPlan:payload.expectedPlan}];doc.items[0].warehouseShippedQty=2;stockWrites++;}
   if(lost){lost=false;throw Error('response lost after stock commit');}
   return {data:{status:'already-applied',orderId:'O',itemId:'I',warehouseId:'B',qty:2,movementId:'location-ship-'+payload.operationId}};
  });
  await page.route('http://127.0.0.1:4174/',route=>route.fulfill({contentType:'text/html',body:'<html lang="zh-Hant"><button id="ship" onclick="openInventoryShipment(\'O\',\'I\',this)">確認出貨</button></html>'}));
  const initialize=async()=>{
   await page.goto('http://127.0.0.1:4174/');
   await page.addScriptTag({content:`let currentUser={uid:'buyer'},currentUserRole='purchaser',orderWorkQueueCache=[],warehouseMasterCache=[{id:'B',active:true}];
    globalThis.YUSHIN_V2_SHIPMENT_EMULATOR=true;globalThis.locationSchemaFlag=true;
    const app={options:{projectId:'demo-yushin'}};
    globalThis.firebase={app(){return {options:app.options,functions:region=>this.functions(region)};},auth:()=>({app,currentUser:{uid:'buyer'},emulatorConfig:{host:'127.0.0.1',port:9099}}),
     functions:()=>({app,useEmulator:(host,port)=>{if(host!=='127.0.0.1'||port!==5001)throw Error('remote');},httpsCallable:()=>shipmentCallable})};
    globalThis.db={app,collection:()=>({doc:()=>({get:async()=>{const data=await shipmentRead();return {exists:true,data:()=>data};}})})};
    const canReceiveInventoryCapability=()=>true,canAccessPage=()=>true,defaultWarehouse=()=>({id:'B'});
    const normalizedOrderStatus=()=> 'normal',orderInventorySyncIncomplete=()=>false,normalizedOrderItems=o=>o.items;
    const itemDispatchState=(o,i)=>({shippable:i.dispatchPreparedQty-i.warehouseShippedQty});
    const invalidateWarehouseStockCache=()=>{},refreshAffectedOrderCaches=async()=>{},loadOrderWorkQueue=async()=>{},markMainPageDirty=()=>{};
    const beginActionButton=()=>({}),endActionButton=()=>{},inventoryProductKey=i=>i.productId;
    const renderInventoryShipping=()=>{},localDateString=()=> '2026-10-19',lifecycleRecordId=()=> 'shipment_browser_123456';
    let feedback=[];const showActionFeedback=message=>feedback.push(message);
    globalThis.prompt=(message,def)=>message.includes('日期')?def:'2';globalThis.confirm=()=>true;
   `});
   await page.addScriptTag({content:read('modules/warehouse-logistics.js')});
   await page.addScriptTag({content:read('src/services/warehouse-shipment.js')});
   await page.addScriptTag({content:read('modules/inventory-workspace.js')});
   await page.evaluate(async()=>{orderWorkQueueCache=[await shipmentRead()];});
  };
  await initialize();await page.locator('#ship').click();
  // A click completes event dispatch, not the async Auth/Callable handler.
  // Observe its feedback before asserting the lost-response retry contract.
  await page.waitForFunction(()=>feedback.length>0);
  const shippingFeedback=await page.evaluate(()=>feedback.slice());
  assert.ok(shippingFeedback.some(x=>x.includes('response lost')),JSON.stringify({shippingFeedback,errors}));
  const frozen=await page.evaluate(()=>pendingV2WarehouseShipment('O','I'));
  assert.equal(frozen.quantity,2);assert.equal(stockWrites,1);
  await initialize();assert.equal(await page.evaluate(()=>YushinInventoryWorkspace.shippingRows(orderWorkQueueCache,warehouseMasterCache,'B',
   {status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState,pending:pendingV2WarehouseShipment}).length),1);
  await page.locator('#ship').click();await page.waitForFunction(()=>!pendingV2WarehouseShipment('O','I'));
  assert.equal(calls,2);assert.equal(stockWrites,1);assert.deepEqual(errors,[]);
  console.log(`V2 warehouse ${width}px: original shipping button keeps ID across lost reply and reload without duplicate stock debit.`);
  await page.close();
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
