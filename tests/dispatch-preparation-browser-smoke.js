'use strict';
// Real production renderers, click handler and Service/Core, with an in-memory
// transaction transport. Actual Client SDK + Rules integration is tested separately.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const read=p=>fs.readFileSync(p,'utf8');
const workspace=read('src/features/orders/order-workspace.js'),purchasing=read('src/features/purchasing/purchasing-workspace.js');
function section(s,a,b){const start=s.indexOf(a),end=s.indexOf(b,start);assert.ok(start>=0&&end>start);return s.slice(start,end);}
const scripts=[read('modules/fulfillment-core.js'),read('modules/order-entry-core.js'),
 `let currentUser={uid:'buyer'},currentUserRole='purchaser',ordersCache=[],purchasingDispatchCache=[],currentDeliveryOrderId=null;
 const pendingDispatchOrderIds=new Set();let sequence=0;
 const db={collection:n=>({doc:id=>({id:id||'AAAAAAAAAAAA'+Date.now()+'-'+(++sequence),path:n+'/'+id})})};
 const normalizedOrderStatus=o=>o.status==='cancelled'?'cancelled':'normal',normalizedOrderItems=o=>structuredClone(o.items);
 const orderInventorySyncIncomplete=o=>['pending','failed'].includes(o.inventoryReservationStatus);
 const itemDispatchState=(o,i)=>orderInventorySyncIncomplete(o)?{pending:0,prepared:0}:YushinFulfillment.dispatchState(i);
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
  await page.locator('#purchaseDispatchBody button').first().click();await page.waitForFunction(()=>!pendingDispatchPreparation('O','I'));
  assert.equal(docs.get('orders/O').items[0].dispatchPreparedQty,3);
  assert.equal([...docs.keys()].filter(p=>p.startsWith('dispatchRecords/')).length,1);
  await page.locator('#purchaseDispatchBody button').first().click();await page.waitForFunction(()=>ordersCache[0].items[0].dispatchPreparedQty===5);
  assert.equal([...docs.keys()].filter(p=>p.startsWith('dispatchRecords/')).length,2);
  for(const role of ['sales','engineer','warehouse']){await page.evaluate(r=>{currentUserRole=r;renderOrdersList();renderPurchasingView();},role);assert.equal(await page.locator('#orderActions button').count(),0);assert.equal(await page.locator('#purchaseDispatchBody button').count(),0);}
  await page.evaluate(()=>{currentUserRole='admin';renderOrdersList();renderPurchasingView();});assert.equal(await page.locator('#purchaseDispatchBody button').count(),1);
  assert.deepEqual(errors,[]);console.log(`Dispatch ${width}px: real renderers -> shared Service/Core, lost reply, reload, cross-page retry, new arrival and five-role visibility passed.`);await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
