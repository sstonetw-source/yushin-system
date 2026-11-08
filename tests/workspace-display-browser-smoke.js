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
   let currentUserRole='purchaser',currentUser={uid:'buyer'},purchasingView='ordering';const order={id:'O',orderNo:'YS-20261026-1',orderDate:'2026-10-26',customerName:'客戶 <測試>',salesName:'負責業務',transactionType:'直',invoiceTitle:'測試發票抬頭',totalPrice:2400,items:[{itemId:'I',itemName:'RNeasy Mini Kit (50) 長品名與規格測試',brand:'Qiagen',itemCode:'74104',productId:'P',unitPrice:120,qty:20,orderedQty:20,shortageQty:15,supplyOrderedQty:17,receivedQty:7,dispatchPreparedQty:10}]};
   let ordersCache=[order],purchasingDispatchCache=[],purchasingDispatchLoading=false,purchasingDispatchError='',purchasingDispatchHasMore=false,purchasingCompletedVisibleLimit=50;
   const pendingDispatchOrderIds=new Set(),selectedPendingPurchaseDemandIds=new Set();
   const procurementDemandCache=[{id:'D',sourceType:'SALES_ORDER',sourceId:'O',sourceItemId:'I',itemCode:'74104',remainingToOrderQty:5}];
   const procurementDemandSourceOrderCache=new Map([['O',order]]);let pendingPurchaseLoading=false,pendingPurchaseError='',procurementDemandHasMore=false;
   const supplyReceivingCache=[{status:'PARTIAL_RECEIPT',unitCost:3,id:'S',orderId:'O',itemId:'I',itemName:'RNeasy Mini Kit (50)',itemCode:'74104',productKey:'P',qty:15,receivedQty:5}];
   const purchasingReceivingReady=true,activeReceivingSupplyReady=true,activeReceivingSupplyError='',purchaseCancellationInProgress=new Set(),purchaseHistorySupplyCache=new Map();
   const isPurchaseTerminalStatus=status=>['CANCELLED','CLOSED'].includes(status);
   const escapeHtml=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),escapeAttr=escapeHtml,inlineJsValue=x=>JSON.stringify(x).replaceAll('"','&quot;');
   const normalizedOrderItems=o=>o.items,orderLifecycleInfo=()=>({status:'normal'}),normalizedOrderStatus=()=> 'normal',orderItemDisplayCategories=(o,i)=>o.serviceFulfillment
     ? [YushinWorkflow.serviceItemWorkCategory(o,i)] : ['dispatch','arrival'];
   const orderInventorySyncIncomplete=()=>false,serviceCaseClientProject=()=> 'demo-yushin';
   const serviceCaseTransport=()=>({call:async(name,input)=>{
     if(name!=='commitOrderServiceAction'||input.action!=='EXECUTE')throw Error('Unexpected service action');
     ordersCache.find(o=>o.id===input.orderId).serviceFulfillment[input.itemId]={EXECUTE:{quantity:1}};
     return {...input,status:'applied'};
   }});
   const refreshAffectedOrderCaches=async()=>renderPendingPurchaseOrders();
   const itemDispatchState=()=>({pending:10,prepared:10,shippable:10}),pendingDispatchPreparation=()=>null,defaultWarehouse=()=>({id:'W'}),purchaseFilterContext=()=>({});
   const purchaseLineMatchesFilters=()=>true,canBusinessSelfOrder=()=>false,updatePendingPurchaseBatchButton=()=>{},purchasingCompletedRows=()=>[],canCreatePurchaseOrderCapability=()=>['purchaser','admin'].includes(currentUserRole);
   const buildReceivingEvidenceIndex=()=>new Map(),receivingEvidenceForWorkItem=()=>[{id:'S'}],receivingDueInfo=()=>({status:'normal',sortRank:2}),receivingPlanRiskInfo=()=>({status:'normal',sortRank:4});
   const visibleProductCostGeneration=0,purchaseCostCache=new Map(),stableProductId=()=> 'P';
   let estimateReads=0,confirmedReads=0;
   const loadVisibleProductCost=async()=>{estimateReads++;purchaseCostCache.set('P',50);return 50;};
   const readTradeAnalysisSuppliesByOrders=async ids=>{
     if(ids.length!==1||ids[0]!=='O')throw Error('Read outside the visible order');
     confirmedReads++;
     return [...supplyReceivingCache,{id:'RECEIVED',orderId:'O',itemId:'I',status:'RECEIVED',qty:2,receivedQty:2,unitCost:10}];
   };
   const runReadJobs=jobs=>Promise.all(jobs.map(job=>job()));
   const formatStatsMoney=value=>'NT$ '+value,receivingSourceOrderForItem=supply=>ordersCache.find(o=>o.id===supply.orderId);
   const canReceiveInventoryCapability=()=>['purchaser','warehouse','admin'].includes(currentUserRole),canConfirmSupplyReceipt=()=>canReceiveInventoryCapability(),supplyCancelActionHtml=()=>'',receivingWaitHtml=()=>'',receivingDueHtml=()=>'',receivingPlanRiskHtml=()=>'',renderReceiptTasks=()=>{};
   const receiptTaskInFlight=()=>false;
   const db={collection:()=>{throw Error('Unexpected database read');}};
  `});
  await page.addScriptTag({content:fs.readFileSync('modules/supplier-core.js','utf8')});
  await page.addScriptTag({content:fs.readFileSync('modules/workflow-core.js','utf8')});
  await page.addScriptTag({content:fs.readFileSync('modules/receiving-core.js','utf8')});
  await page.addScriptTag({content:fs.readFileSync('modules/supply-core.js','utf8')});
  const feedbackSource=fs.readFileSync('src/shared/action-feedback.js','utf8');
  await page.addScriptTag({content:feedbackSource.slice(feedbackSource.indexOf('const uiWorkActions = new Map();'))});
  await page.addScriptTag({content:fs.readFileSync('src/features/orders/service-order-actions.js','utf8')});
  await page.addScriptTag({content:fs.readFileSync('src/shared/workspace-display.js','utf8')});
  await page.addScriptTag({content:source.slice(source.indexOf('let purchaseWorkSupplyRequests'),source.indexOf('let purchaseDemandSummaryRows'))});
  for(const name of ['pendingServicePurchaseRows','renderPendingPurchaseOrders','renderPurchasingDispatchOrders','renderPurchasingCompletedOrders','receivingWorkProgress','renderPurchasingReceivingWorkList'])await page.addScriptTag({content:fn(name)});
  await page.evaluate(()=>{window.renderPurchasingView=()=>{
   if(purchasingView==='ordering')return renderPendingPurchaseOrders();
   if(purchasingView==='dispatch')return renderPurchasingDispatchOrders();
   if(purchasingView==='completed')return renderPurchasingCompletedOrders([{order,item:order.items[0],state:{prepared:10}}]);
   if(purchasingView==='receiving')return renderPurchasingReceivingWorkList();
  };});
  for(const view of ['ordering','dispatch','completed','receiving']){
   await page.evaluate(async view=>{
    purchasingView=view;document.getElementById('purchaseWorkSearch').value='';
    const panels=['purchasePendingPanel','purchaseDispatchPanel','purchaseCompletedPanel','poListPanel'];panels.forEach(id=>document.getElementById(id).style.display='none');
    document.getElementById({ordering:panels[0],dispatch:panels[1],completed:panels[2],receiving:panels[3]}[view]).style.display='block';
    await renderPurchasingView();
   },view);
   const id={ordering:'purchasePendingBody',dispatch:'purchaseDispatchBody',completed:'purchaseCompletedBody',receiving:'poListBody'}[view],row=page.locator('#'+id+' > tr').first();
   assert.match(await row.innerText(),/RNeasy Mini Kit/);assert.match(await row.innerText(),/74104/);assert.match(await row.innerText(),/YS-20261026-1/);assert.equal(await row.locator('測試').count(),0);
   const fields=await row.locator(':scope > td').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-th')));
   assert.ok(fields.indexOf('產品資訊')<fields.indexOf('負責業務'));assert.equal(await row.locator('.workflow-product .workflow-quantity').count(),0);assert.match(await row.locator('td[data-th="進度"]').innerText(),/\d/);
   assert.deepEqual(fields,['訂單日期','客戶名稱','產品資訊','負責業務','金額（含稅）','交易方式','進度','操作']);
   const money=await row.locator('td[data-th="金額（含稅）"]').innerText();
   const amounts={ordering:['600','263','43.83'],dispatch:['2,040','68','3.33'],completed:['2,040','68','3.33'],receiving:['1,200','32','2.67']}[view];
   assert.ok(money.includes('銷售金額：NT$ '+amounts[0]),money);
   assert.ok(money.includes('採購成本：NT$ '+amounts[1]),money);
   assert.ok(money.includes('成本率：'+amounts[2]+'%'),money);
   const transaction=row.locator('td[data-th="交易方式"]');assert.equal(await transaction.innerText(),'直');assert.equal(await transaction.isVisible(),true);
   assert.equal(await row.evaluate(element=>getComputedStyle(element).display),width<769?'grid':'table-row');
   if(view==='receiving') assert.match(await page.locator('#purchaseAmountReceiving').textContent(),/含稅.*NT\$ 32/);
   assert.ok(await row.locator('td[data-th="操作"]').evaluate(cell=>{
    const boundary=cell.getBoundingClientRect();
    return [...cell.querySelectorAll('button, .order-detail-panel > summary')].filter(el=>el.getClientRects().length)
      .every(el=>el.getBoundingClientRect().right<=boundary.right+1);
   }),view+' action controls fit at '+width+'px');
   await row.locator('.order-detail-panel > summary').click();
   await row.locator('dialog[open]').waitFor({state:'visible'});
   assert.equal(await row.locator('dialog').evaluate(e=>e.open),true);
   assert.match(await row.locator('dialog').innerText(),/全部訂單品項[\s\S]*測試發票抬頭/);
   await row.locator('[data-order-drawer-close]').click();
   if(view==='dispatch') assert.equal(await row.locator('button[onclick^="markOrderItemDispatchPrepared"]').isVisible(),true);
   const reference=row.locator('.workflow-record time');assert.equal(await reference.evaluate(e=>e.getClientRects().length),1);
   if(width===390){assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true,view+' page overflow');assert.ok(await page.locator('#purchaseWorkSearch').evaluate(e=>e.getBoundingClientRect().height<=60));assert.ok(await row.locator('button:visible').evaluateAll(nodes=>nodes.every(e=>e.getBoundingClientRect().height>=44)));}
   await page.locator('#purchaseWorkSearch').fill('不存在的產品');assert.equal(await page.locator('#'+id+' > tr').count(),0);
   await page.locator('#purchaseWorkSearch').fill('74104');assert.equal(await page.locator('#'+id+' > tr').count(),1);
   if(process.env.WORKSPACE_SCREENSHOT_DIR){fs.mkdirSync(process.env.WORKSPACE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.WORKSPACE_SCREENSHOT_DIR+'/'+view+'-'+width+'.png',fullPage:true});}
  }
  assert.deepEqual(await page.evaluate(()=>[estimateReads,confirmedReads]),[1,1]);
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
   purchasingView='history'; const poHistorySearchActive=false,poHistorySearchLoading=false,poHistorySearchResults=[],companyData={};
   const poListCache=[{id:'PO1',poNo:'PO-1',poDate:'2026-10-26',vendorName:'供應商',buyerName:'採購',status:'CONFIRMED',items:[{itemName:'採購品項',itemCode:'74104',qty:3,unitPrice:100}]}];
   const purchaseItemsFromSavedPo=p=>p.items,purchaseOrderSupplierContact=()=>'',purchaseHistoryItemReceiptProgress=()=>(globalThis.poReceiptFixture||{remainingQty:0,label:'已到貨'}),poWaitingDays=()=>'',purchaseOrderDocumentStatusLabel=()=> '已確認',canEditPage=()=>true,localDateString=()=> '2026-10-26';
  `});
  const listStart=source.indexOf('window.renderPoList = function('),listEnd=source.indexOf('\n};',listStart)+3;await page.addScriptTag({content:source.slice(listStart,listEnd)});
  await page.evaluate(()=>{document.getElementById('poListSearch').value='';document.getElementById('poListPanel').style.display='block';renderPoList();});
  assert.equal(await page.locator('#poListBody .workflow-product .workflow-quantity').count(),0);assert.match(await page.locator('#poListBody td[data-th="採購成本（含稅）"]').textContent(),/NT\$ 315[\s\S]*比較數量：3/);
  for(const [status,label] of [['DRAFT','尚未採購'],['CANCELLED','未到貨已取消'],['CLOSED','已結案'],['UNKNOWN','已建立']]){
   await page.evaluate(({status,label})=>{globalThis.poReceiptFixture={status,label,remainingQty:0};renderPoList();},{status,label});
   assert.equal(await page.locator('#poListBody td[data-th="等待天數"]').innerText(),label);
  }
  await page.evaluate(()=>{delete globalThis.poReceiptFixture;renderPoList();});
  for(const role of ['sales','engineer','warehouse','purchaser','admin']){
   await page.evaluate(role=>{currentUserRole=role;renderPurchasingDispatchOrders();},role);
   assert.equal(await page.locator('#purchaseDispatchBody button[onclick^="markOrderItemDispatchPrepared"]').count(),['purchaser','admin'].includes(role)?1:0);
   assert.equal((await page.locator('#purchaseDispatchBody .purchase-work-amount').first().innerText()).includes('成本率'),['purchaser','admin'].includes(role));
  }
  await page.evaluate(()=>{
   currentUserRole='purchaser';
   ordersCache.push({id:'SERVICE',customerName:'服務客戶',items:[{itemId:'S',productType:'Service',itemName:'Bio-Plex',qty:1,unitPrice:200}],serviceFulfillment:{}});
   document.getElementById('purchasePendingPanel').style.display='block';
   document.getElementById('purchaseWorkSearch').value='';
   renderPendingPurchaseOrders();
  });
  const service=page.locator('#purchasePendingBody tr').filter({hasText:'Bio-Plex'});
  assert.match(await service.innerText(),/待執行/);
  assert.equal(await service.getByRole('checkbox').count(),0);
  assert.equal(await service.getByRole('button',{name:'建立採購單'}).count(),0);
  await service.getByRole('button',{name:'確認已執行'}).click();
  await service.waitFor({state:'detached'});
  await page.evaluate(()=>renderPurchasingDispatchOrders());
  await page.locator('#purchaseDispatchBody tr').filter({hasText:'Bio-Plex'})
   .getByRole('button',{name:'確認打單'}).waitFor({state:'visible'});
  await page.evaluate(()=>{ordersCache=[];purchasingDispatchCache=[];renderPurchasingDispatchOrders();});assert.equal(await page.locator('#purchaseDispatchBody tr').count(),0);assert.match(await page.locator('#purchaseDispatchStatus').textContent(),/目前沒有/);
  assert.deepEqual(errors,[]);console.log('Unified work lists '+width+'px: four actual queues, escaped references, product quantities, five-role actions, empty state, and cached scoped cost reads.');await page.close();
 }
 const receiptSource=fs.readFileSync('src/features/purchasing/receiving-workspace.js','utf8');
 const start=receiptSource.indexOf('function receiptItemRowHtml('),end=receiptSource.indexOf('window.receiveSupplyOrder =',start);
 for(const width of [320,390,430,1280]){
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.setContent('<html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><body></body></html>');
  await page.evaluate(html=>{
   const parsed=new DOMParser().parseFromString(html,'text/html');
   document.body.append(parsed.getElementById('poReceiptBatchOverlay'));
   document.getElementById('poReceiptBatchOverlay').classList.add('active');
   document.getElementById('poReceiptBatchTitle').textContent='到貨入庫｜MO-20261108-LONG-REFERENCE-測試長單號';
  },html);
  await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
  await page.addScriptTag({content:`const warehouseMasterCache=[{id:'MAIN',name:'又鑫主倉'}];const escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');`+receiptSource.slice(start,end)});
  await page.evaluate(()=>{document.getElementById('poReceiptBatchBody').innerHTML=receiptItemRowHtml({qty:2.5,receivedQty:1,warehouseId:'MAIN',brand:'Qiagen',itemCode:'52304',itemName:'QIAamp RNA Blood Mini Kit (50) 長品名與規格測試'});});
  assert.equal(await page.locator('#poReceiptBatchBody input[type="checkbox"]').count(),0);
  assert.equal(await page.locator('.po-receive-qty').inputValue(),'1.5');
  await page.locator('.po-receive-qty').fill('0.5');
  assert.equal(await page.locator('.po-receive-qty').inputValue(),'0.5');
  assert.match(await page.locator('#poReceiptBatchBody').innerText(),/又鑫主倉/);
  const overflow=await page.locator('#poReceiptBatchOverlay .eq-modal-box').evaluate(box=>[...box.querySelectorAll('input,button,td,h3')].filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.left<0||r.right>innerWidth+1);}).map(el=>el.outerHTML));
  assert.deepEqual(overflow,[],width+'px receipt overflow');
  if(width<768)assert.equal(await page.locator('#poReceiptBatchBody tr').evaluate(row=>getComputedStyle(row).display),'grid');
  if(process.env.WORKSPACE_SCREENSHOT_DIR){fs.mkdirSync(process.env.WORKSPACE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.WORKSPACE_SCREENSHOT_DIR+'/receiving-'+width+'.png',fullPage:true});}
  console.log('Quantity receipt layout '+width+'px passed');await page.close();
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
