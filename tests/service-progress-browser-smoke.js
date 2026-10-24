'use strict';
// Original list renderer and service UI; scripted authorized reads, no Firebase integration claim.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const read=p=>fs.readFileSync(p,'utf8'),workspace=read('src/features/orders/order-workspace.js');
const renderer=workspace.slice(workspace.indexOf('window.renderOrdersList = function()'),workspace.indexOf('\nfunction orderSourceSyncIncomplete'));
const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
(async()=>{
 assert.ok(executablePath,'Chrome is required');const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="appContainer"><div id="order-system" class="content-section active"><input id="orderSearch"><table id="ordersTable"><tbody id="ordersBody"></tbody></table><p id="ordersEmptyHint"></p></div></div>');
  await page.addStyleTag({content:read('styles.css')});
  await page.addScriptTag({content:`
   let currentUser={uid:'U'},currentUserRole='sales',trueUserRole='sales',sessionDataGeneration=1;
   globalThis.YUSHIN_SERVICE_CASE_EMULATOR=true;
   const items=[{itemId:'I',itemName:'檢測',productType:'SERVICE',qty:2,orderedQty:2},{itemId:'J',itemName:'校正',productType:'SERVICE',qty:2,orderedQty:2}];
   let ordersCache=[{id:'O',orderNo:'YS-1',customerName:'驗收客戶',items,totalPrice:400,isBilled:false}],activeOrderWorkFilter='all';
   const orderHistorySearchActive=false,orderHistorySearchResults=[],orderHistorySearchLoading=false,orderWorkQueueReady=true,orderWorkQueueError='';
   const pendingDeliveryOrderIds=new Set(),pendingOrderStatusKeys=new Set();
   const canEditPage=()=>true,canManageOrderLifecycleCapability=()=>false,populatePurchaserOrderFilters=()=>[],normalizedOrderItems=o=>o.items;
   const itemDispatchState=()=>({pending:0,shippable:0}),orderLifecycleInfo=()=>({status:'normal'}),renderOrderWorkCards=()=>{},orderItemDisplayCategories=()=>['delivery'];
   const deliveryProgressInfo=()=>({state:'pending'}),orderContextActionState=()=>({}),orderDeliveryRequiresItemForm=()=>false,bindListRowSelection=()=>{};
   const stripPhoneSuffix=x=>x||'',orderInventorySyncIncomplete=()=>false,inlineJsValue=x=>JSON.stringify(x).replaceAll(String.fromCharCode(34),'&quot;'),canBusinessSelfOrder=()=>false;
   const orderDeliveryPlanSummary=()=>'',selfOrderActionHtml=()=>'',orderLifecycleActionButtons=()=>'',orderInventorySyncStatusHtml=()=>'',directShipReceiptActionHtml=()=>'';
   const escapeHtml=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),escapeAttr=escapeHtml;
   const serviceCaseTransport=()=>({uid:'U',role:'sales'}),pendingServiceCaseIntent=()=>null;
   const readServiceCases=async()=>({orderId:'O',itemId:'I',itemWorkCategory:'delivery',itemProgress:{orderedQty:2,completedQty:0},cases:[]});
   let reads=0;const readServiceOrderProgress=async()=>{reads++;return {orderId:'O',orderedQty:4,completedQty:2,items:[{itemId:'I',itemName:'檢測',orderedQty:2,completedQty:2,workCategory:'billing'},{itemId:'J',itemName:'校正',orderedQty:2,completedQty:0,workCategory:'delivery'}]};};
   const commitServiceCaseIntent=()=>{throw Error('Unexpected write');};
  `});
  await page.addScriptTag({content:read('src/features/orders/service-cases.js')});
  await page.addScriptTag({content:renderer});
  await page.evaluate(()=>{renderOrdersList();});
  assert.equal(await page.locator('.service-case-verified-hint').count(),0);
  await page.locator('button').filter({hasText:'服務案件'}).click();
  await page.locator('#verifyServiceOrderButton').click();
  await page.waitForFunction(()=>document.querySelectorAll('#ordersBody .service-case-verified-hint').length===2);
  const product=page.locator('#ordersBody .order-product-cell');
  assert.match(await product.locator(':scope > div').nth(0).innerText(),/檢測：上次查核完成 2\/2.*服務完成・待核銷/);
  assert.match(await product.locator(':scope > div').nth(1).innerText(),/校正：上次查核完成 0\/2.*待服務處理/);
  assert.equal(await page.locator('.order-money-cell .service-case-verified-hint').count(),0);
  assert.equal(await page.evaluate(()=>reads),1);
  await page.evaluate(()=>{renderOrdersList();renderOrdersList();});assert.equal(await page.evaluate(()=>reads),1);
  await page.locator('button[onclick="closeServiceCases()"]').click();
  assert.equal(await product.evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  if(process.env.SERVICE_PROGRESS_SCREENSHOT_DIR){fs.mkdirSync(process.env.SERVICE_PROGRESS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:require('node:path').join(process.env.SERVICE_PROGRESS_SCREENSHOT_DIR,'service-progress-'+width+'.png'),fullPage:true});}
  assert.deepEqual(errors,[]);console.log('Service item progress '+width+'px: original renderer, per-item results, no render-triggered reads or writes.');
  await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
