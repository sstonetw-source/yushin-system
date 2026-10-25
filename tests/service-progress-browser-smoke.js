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
   const pendingDeliveryOrderIds=new Set(),pendingOrderStatusKeys=new Set(),pendingLifecycleOrderIds=new Set();
   const canReceiveInventoryCapability=()=>['admin','purchaser','warehouse'].includes(currentUserRole);
   const loadVisibleProductCost=async()=>null,findPriceItemForOrder=()=>null,formatProfitPercent=()=>'';
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
  await page.addScriptTag({content:read('modules/order-commercial-details.js')});
  await page.addScriptTag({content:read('modules/order-entry-core.js')});
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
  await page.evaluate(()=>{
   ordersCache=[{id:'G',ownerUid:'U',salesName:'業務',customerName:'金額驗收',totalPrice:339000,transactionType:'直',remarks:'冷藏配送',status:'active',
    items:[{itemId:'G1',itemName:'RNeasy Mini Kit',itemCode:'74104',brand:'Qiagen',qty:30,orderedQty:30,unitPrice:11300,receivedQty:0,procurementType:'PURCHASING_PO',deliveryPlan:{mode:'PICKUP'}}]}];renderOrdersList();
  });
  const amount=page.locator('.order-money-cell');assert.equal(await amount.getAttribute('data-th'),'訂單金額');assert.match(await amount.innerText(),/11,300 × 30 ＝ NT\$ 339,000/);
  await page.locator('.order-detail-panel summary').click();
  const details=page.locator('.order-detail-panel');assert.match(await details.innerText(),/採購方式：採購統一訂貨/);assert.match(await details.innerText(),/交付方式：我送・主倉自領/);
  assert.equal(await details.locator('.order-remarks-editor input').inputValue(),'冷藏配送');assert.equal(await details.locator('.order-transaction-cell select').isDisabled(),false);
  await page.evaluate(()=>renderOrdersList());assert.equal(await details.getAttribute('open'),'');
  if(width===390)assert.equal(await details.locator('select, input').evaluateAll(nodes=>nodes.every(n=>n.getBoundingClientRect().height>=44)),true);
  for(const role of ['sales','engineer','purchaser','warehouse','admin']){
   await page.evaluate(role=>{currentUserRole=role;trueUserRole=role;renderOrdersList();},role);
   assert.equal(await details.locator('.order-remarks-editor input').isDisabled(),['purchaser','warehouse'].includes(role));
  }
  await page.evaluate(()=>{currentUserRole='sales';trueUserRole='sales';ordersCache[0].items[0].receivedQty=1;renderOrdersList();});
  assert.equal(await details.locator('.order-remarks-editor input').isDisabled(),true);assert.equal(await details.locator('.order-transaction-cell select').isDisabled(),true);
  assert.equal(await details.getByRole('button',{name:'修改交付方式／地址'}).count(),0);assert.match(await details.innerText(),/已鎖定/);
  if(width===390)assert.equal(await page.locator('#ordersTable').evaluate(el=>el.scrollWidth<=el.clientWidth+1),true);
  await page.screenshot({path:'/tmp/order-amount-details-'+width+'.png',fullPage:true});
  if(process.env.SERVICE_PROGRESS_SCREENSHOT_DIR){fs.mkdirSync(process.env.SERVICE_PROGRESS_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:require('node:path').join(process.env.SERVICE_PROGRESS_SCREENSHOT_DIR,'service-progress-'+width+'.png'),fullPage:true});}
  assert.deepEqual(errors,[]);console.log('Service item progress '+width+'px: original renderer, per-item results, no render-triggered reads or writes.');
  await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
