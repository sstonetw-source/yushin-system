'use strict';
// Actual work-list renderers and page markup with isolated, already-loaded data.
// Checks presentation, escaping, responsive layout and read-free re-rendering.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const html=fs.readFileSync('index.html','utf8'),source=fs.readFileSync('src/features/purchasing/purchasing-workspace.js','utf8');
function fn(name){const a=source.indexOf('function '+name+'('),b=source.indexOf('\n}',a);assert.ok(a>=0&&b>a);return source.slice(a,b+2);}
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
 const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
 try{for(const width of [1440,1024,390]){
  const page=await browser.newPage({viewport:{width,height:1000},isMobile:width<768,hasTouch:width<768}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="appContainer"></div></html>');
  await page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html'),p=d.getElementById('purchasing-system');document.getElementById('appContainer').append(p);p.classList.add('active');p.style.display='block';},html);
  await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
  await page.addScriptTag({content:`
   let currentUserRole='purchaser';const order={id:'O',orderNo:'YS-20261026-1',orderDate:'2026-10-26',customerName:'客戶 <測試>',salesName:'負責業務',transactionType:'直',invoiceTitle:'測試發票抬頭',totalPrice:2400,items:[{itemId:'I',itemName:'RNeasy Mini Kit (50) 長品名與規格測試',brand:'Qiagen',itemCode:'74104',unitPrice:120,qty:20,orderedQty:20,shortageQty:15,supplyOrderedQty:15,receivedQty:5,dispatchPreparedQty:10}]};
   let ordersCache=[order],purchasingDispatchCache=[],purchasingDispatchLoading=false,purchasingDispatchError='',purchasingDispatchHasMore=false,purchasingCompletedVisibleLimit=50;
   const pendingDispatchOrderIds=new Set(),selectedPendingPurchaseDemandIds=new Set();
   const procurementDemandCache=[{id:'D',sourceType:'SALES_ORDER',sourceId:'O',sourceItemId:'I',itemCode:'74104',remainingToOrderQty:5}];
   const procurementDemandSourceOrderCache=new Map([['O',order]]);let pendingPurchaseLoading=false,pendingPurchaseError='',procurementDemandHasMore=false;
   const supplyReceivingCache=[{id:'S',orderId:'O',itemId:'I',itemName:'RNeasy Mini Kit (50)',itemCode:'74104',productKey:'P',qty:15,receivedQty:5}];
   const purchasingReceivingReady=true,purchaseCancellationInProgress=new Set();
   const escapeHtml=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),escapeAttr=escapeHtml,inlineJsValue=x=>JSON.stringify(x).replaceAll('"','&quot;');
   const normalizedOrderItems=o=>o.items,orderLifecycleInfo=()=>({status:'normal'}),normalizedOrderStatus=()=> 'normal',orderItemDisplayCategories=()=>['dispatch','arrival'];
   const itemDispatchState=()=>({pending:10,prepared:10,shippable:10}),pendingDispatchPreparation=()=>null,defaultWarehouse=()=>({id:'W'}),purchaseFilterContext=()=>({});
   const purchaseLineMatchesFilters=()=>true,canBusinessSelfOrder=()=>false,updatePendingPurchaseBatchButton=()=>{},purchasingCompletedRows=()=>[],canCreatePurchaseOrderCapability=()=>['purchaser','admin'].includes(currentUserRole);
   const buildReceivingEvidenceIndex=()=>new Map(),receivingEvidenceForWorkItem=()=>[{id:'S'}],receivingDueInfo=()=>({status:'normal',sortRank:2}),receivingPlanRiskInfo=()=>({status:'normal',sortRank:4});
   const canReceiveInventoryCapability=()=>['purchaser','warehouse','admin'].includes(currentUserRole),canConfirmSupplyReceipt=()=>canReceiveInventoryCapability(),supplyCancelActionHtml=()=>'',receivingWaitHtml=()=>'',receivingDueHtml=()=>'',receivingPlanRiskHtml=()=>'',renderReceiptTasks=()=>{},receivingSupplyMetrics=()=>({count:1,quantity:10});
   const db={collection:()=>{throw Error('Unexpected database read');}};
  `});
  await page.addScriptTag({content:fs.readFileSync('src/shared/workspace-display.js','utf8')});
  for(const name of ['renderPendingPurchaseOrders','renderPurchasingDispatchOrders','renderPurchasingCompletedOrders','receivingWorkProgress','renderPurchasingReceivingWorkList'])await page.addScriptTag({content:fn(name)});
  await page.evaluate(()=>{window.renderPurchasingView=()=>{const view=window.fixtureView;if(view==='ordering')renderPendingPurchaseOrders();if(view==='dispatch')renderPurchasingDispatchOrders();if(view==='completed')renderPurchasingCompletedOrders([{order,item:order.items[0],state:{prepared:10}}]);if(view==='receiving')renderPurchasingReceivingWorkList();};});
  for(const view of ['ordering','dispatch','completed','receiving']){
   await page.evaluate(view=>{
    window.fixtureView=view;document.getElementById('purchaseWorkSearch').value='';
    const panels=['purchasePendingPanel','purchaseDispatchPanel','purchaseCompletedPanel','poListPanel'];panels.forEach(id=>document.getElementById(id).style.display='none');
    document.getElementById({ordering:panels[0],dispatch:panels[1],completed:panels[2],receiving:panels[3]}[view]).style.display='block';
    if(view==='ordering')renderPendingPurchaseOrders();if(view==='dispatch')renderPurchasingDispatchOrders();if(view==='completed')renderPurchasingCompletedOrders([{order,item:order.items[0],state:{prepared:10}}]);if(view==='receiving')renderPurchasingReceivingWorkList();
   },view);
   const id={ordering:'purchasePendingBody',dispatch:'purchaseDispatchBody',completed:'purchaseCompletedBody',receiving:'poListBody'}[view],row=page.locator('#'+id+' > tr').first();
   assert.match(await row.innerText(),/RNeasy Mini Kit/);assert.match(await row.innerText(),/74104/);assert.match(await row.innerText(),/YS-20261026-1/);assert.equal(await row.locator('測試').count(),0);
   const fields=await row.locator(':scope > td').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-th')));
   assert.ok(fields.indexOf('產品資訊')<fields.indexOf('負責業務'));assert.equal(await row.locator('.workflow-product .workflow-quantity').count(),0);assert.match(await row.locator('td[data-th="進度"]').innerText(),/\d/);
   assert.match(await row.locator('td[data-th="銷售金額"]').innerText(),/120 × 20[\s\S]*2,400/);
   assert.match(await row.locator('td[data-th="交易／開票資料"]').innerText(),/交易方式：直[\s\S]*測試發票抬頭/);
   await row.locator('.order-detail-panel > summary').click();
   await row.locator('dialog[open]').waitFor({state:'visible'});
   assert.equal(await row.locator('dialog').evaluate(e=>e.open),true);
   assert.match(await row.locator('dialog').innerText(),/全部訂單品項/);
   await row.locator('[data-order-drawer-close]').click();
   if(view==='dispatch') assert.equal(await row.locator('button[onclick^="markOrderItemDispatchPrepared"]').isVisible(),true);
   const reference=row.locator('.workflow-record time');assert.equal(await reference.evaluate(e=>e.getClientRects().length),1);
   if(width===390){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,view+' page overflow');assert.ok(await page.locator('#purchaseWorkSearch').evaluate(e=>e.getBoundingClientRect().height<=60));assert.ok(await row.locator('button:visible').evaluateAll(nodes=>nodes.every(e=>e.getBoundingClientRect().height>=44)));}
   await page.locator('#purchaseWorkSearch').fill('不存在的產品');assert.equal(await page.locator('#'+id+' > tr').count(),0);
   await page.locator('#purchaseWorkSearch').fill('74104');assert.equal(await page.locator('#'+id+' > tr').count(),1);
   if(process.env.WORKSPACE_SCREENSHOT_DIR){fs.mkdirSync(process.env.WORKSPACE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.WORKSPACE_SCREENSHOT_DIR+'/'+view+'-'+width+'.png',fullPage:true});}
  }
  await page.evaluate(()=>{
   document.getElementById('purchaseDispatchPanel').style.display='block';
   document.getElementById('poListPanel').style.display='none';
   order.items.push({itemId:'OTHER',itemName:'同張訂單另一品項',qty:3,unitPrice:50});
   document.getElementById('purchaseWorkSearch').value='74104';renderPurchasingDispatchOrders();
  });
  const detail=page.locator('#purchaseDispatchBody .order-detail-panel');
  await detail.locator(':scope > summary').click();await detail.locator('dialog[open]').waitFor();
  assert.match(await detail.innerText(),/同張訂單另一品項/);
  assert.match(await detail.innerText(),/50 × 3[\s\S]*150/);
  await detail.locator('[data-order-drawer-close]').click();
  await page.evaluate(()=>order.items.pop());
  assert.match(await page.evaluate(()=>workflowSalesAmount(order,{qty:5})),/待確認/);
  assert.match(await page.evaluate(()=>workflowSalesAmount(order,{qty:5,unitPrice:null})),/待確認/);
  assert.match(await page.evaluate(()=>workflowSalesAmount(order,{qty:5,unitPrice:0})),/NT\$ 0/);
  assert.match(await page.evaluate(()=>workflowCommercialSummary({})),/未填寫/);
  await page.addScriptTag({content:`
   const purchasingView='history',poHistorySearchActive=false,poHistorySearchLoading=false,poHistorySearchResults=[],companyData={};
   const poListCache=[{id:'PO1',poNo:'PO-1',poDate:'2026-10-26',vendorName:'供應商',buyerName:'採購',status:'CONFIRMED',items:[{itemName:'採購品項',itemCode:'74104',qty:3,unitPrice:100}]}];
   const purchaseItemsFromSavedPo=p=>p.items,purchaseOrderSupplierContact=()=>'',purchaseHistoryItemReceiptProgress=()=>({remainingQty:0,label:'已到貨'}),poWaitingDays=()=>'',purchaseOrderDocumentStatusLabel=()=> '已確認',canEditPage=()=>true,localDateString=()=> '2026-10-26';
  `});
  const listStart=source.indexOf('window.renderPoList = function('),listEnd=source.indexOf('\n};',listStart)+3;await page.addScriptTag({content:source.slice(listStart,listEnd)});
  await page.evaluate(()=>{document.getElementById('poListSearch').value='';document.getElementById('poListPanel').style.display='block';renderPoList();});
  assert.equal(await page.locator('#poListBody .workflow-product .workflow-quantity').count(),0);assert.match(await page.locator('#poListBody td[data-th="品項金額"]').innerText(),/105 × 3[\s\S]*315/);
  for(const role of ['sales','engineer','warehouse','purchaser','admin']){
   await page.evaluate(role=>{currentUserRole=role;renderPurchasingDispatchOrders();},role);
   assert.equal(await page.locator('#purchaseDispatchBody button[onclick^="markOrderItemDispatchPrepared"]').count(),['purchaser','admin'].includes(role)?1:0);
  }
  await page.evaluate(()=>{ordersCache=[];purchasingDispatchCache=[];renderPurchasingDispatchOrders();});assert.equal(await page.locator('#purchaseDispatchBody tr').count(),0);assert.match(await page.locator('#purchaseDispatchStatus').textContent(),/目前沒有/);
  assert.deepEqual(errors,[]);console.log('Unified work lists '+width+'px: four actual queues, escaped references, product quantities, five-role actions, empty state and no database reads.');await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
