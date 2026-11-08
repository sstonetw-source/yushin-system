'use strict';
// Real Chrome with the actual modal, source handlers and stylesheet; local fixtures only.
const fs=require('node:fs'),assert=require('node:assert/strict');
const {chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(name=>spawnSync('which',[name],{encoding:'utf8'})).find(result=>result.status===0)?.stdout.trim()||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
 const browser=await chromium.launch({executablePath,headless:true,args:['--no-sandbox']});
 try{
 const page=await browser.newPage();const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
 let html=fs.readFileSync('index.html','utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,'');
 await page.setContent(html);await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
 await page.addScriptTag({content:`
 window.errors=[];window.alert=x=>errors.push(x);
 let currentUser={uid:'buyer'},currentUserRole='purchaser',currentUserName='採購',formalPurchaseRecoveryRunning=false;
 const warehouseMasterCache=[{id:'MAIN',name:'公司倉',active:true},{id:'BRANCH',name:'分倉',active:true},{id:'custody-X',systemCustody:true}];
 const defaultWarehouse=()=>warehouseMasterCache[0],canCreatePurchaseOrderCapability=()=>true,canAccessPage=()=>true,canEditPage=()=>true;
 const poListCache=[],getUnifiedBrandNames=()=>['A','B'],escapeHtml=x=>String(x??''),escapeAttr=escapeHtml;
 const resolveBrandName=x=>x,brandIdForName=x=>x,normalizeBrandLookupKey=x=>x,normalizeItemCode=x=>x,stableProductId=x=>x.productId;
 const supplierForProduct=()=>null,purchaseOrderSupplierContact=()=>({}),isPurchaseTerminalStatus=()=>false;
 const products=[{model:'X1',brand:'A',nameCn:'試劑 A',productId:'PA',cost:100},{model:'X1',brand:'B',nameCn:'試劑 B',productId:'PB',cost:120}];
 const findProductsByCode=async()=>products,selectProductCodeMatch=(rows,brand)=>{const matched=brand?rows.filter(x=>x.brand===brand):rows;return matched.length===1?matched[0]:null;};
 const loadVisibleProductCost=async product=>product.cost;
 `});
 await page.addScriptTag({content:fs.readFileSync('modules/supplier-core.js','utf8')});
 await page.addScriptTag({content:fs.readFileSync('src/features/purchasing/purchase-order-editor.js','utf8')});
 await page.evaluate(()=>{
  window.autoFillPoExpectedDate=()=>{};
  document.getElementById('authStarting').style.display='none';
  document.getElementById('appContainer').style.display='block';
  document.getElementById('poModalOverlay').classList.add('active');
  poDirectStockMode=true;poNoReady=true;poItems=[emptyDirectPoItem()];poAllItems=poItems;
  renderPoItemsTable();updatePoModeUI();
 });
 await page.evaluate(()=>onDirectPoCodeChange(0,'X1'));
 assert.equal(await page.locator('select[aria-label="選擇商品"] option').count(),3);
 await page.locator('select[aria-label="選擇商品"]').selectOption('1');
 await page.waitForFunction(()=>poItems[0].productId==='PB');
 assert.equal(await page.locator('#poItemsBody tr td').nth(2).locator('input').inputValue(),'試劑 B');
 await page.locator('#poDefaultWarehouse').selectOption('BRANCH');
 assert.equal(await page.locator('select[aria-label="入庫倉庫"]').inputValue(),'BRANCH');
 assert.equal(await page.locator('select[aria-label="入庫倉庫"] option').count(),3);
 assert.deepEqual(await page.locator('#poItemsTable th').allTextContents(),['貨號','廠牌','品名','入庫倉庫','數量','未稅進貨單價','小計','操作']);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  const bounds=await page.locator('#poItemsTable').boundingBox();assert.ok(bounds.width<width);
  assert.equal(await page.locator('#poItemsTable thead').evaluate(el=>getComputedStyle(el).display),width===390?'none':'table-header-group');
  assert.ok(await page.locator('#confirmPoOrderedBtn').isVisible());
  await page.screenshot({path:'/tmp/yushin-purchase-'+width+'.png',fullPage:true});
 }
 assert.equal(await page.locator('#printPurchaseOrderBtn').textContent(),'下載 PDF');
 assert.deepEqual(await page.evaluate(()=>errors),[]);
 const actions=await page.evaluate(async()=>{
  const calls=[];let finish;
  window.printPurchaseOrder=async options=>{calls.push(['save',options.download]);return {id:'PO1'};};
  window.confirmSavedPurchaseOrder=async id=>{calls.push(['confirm',id]);await new Promise(resolve=>finish=resolve);};
  await savePoDraft();
  const first=confirmCurrentPurchaseOrder();
  await Promise.resolve();await confirmCurrentPurchaseOrder();
  finish();await first;return calls;
 });
 assert.deepEqual(actions,[['save',false],['save',false],['confirm','PO1']]);
 await page.evaluate(()=>document.getElementById('poModalOverlay').classList.remove('active'));
 await page.addScriptTag({content:fs.readFileSync('modules/receiving-core.js','utf8')});
 await page.addScriptTag({content:fs.readFileSync('modules/supply-core.js','utf8')});
 await page.addScriptTag({content:fs.readFileSync('modules/workflow-core.js','utf8')});
 await page.addScriptTag({content:fs.readFileSync('src/shared/workspace-display.js','utf8')});
 const workspace=fs.readFileSync('src/features/purchasing/purchasing-workspace.js','utf8');
 await page.addScriptTag({content:workspace.slice(workspace.indexOf('let purchaseWorkSupplyRequests'),workspace.indexOf('let purchaseDemandSummaryRows'))});
 await page.addScriptTag({content:workspace.slice(workspace.indexOf('function renderPurchasingReceivingWorkList('),workspace.indexOf('window.renderPoList ='))});
 await page.addScriptTag({content:`
 let supplyReceivingCache=[{id:'S',sourceType:'STOCK_REPLENISHMENT',type:'PURCHASING_PO',qty:3,receivedQty:1,unitCost:120,status:'PARTIAL_RECEIPT',itemCode:'X1',itemName:'試劑 B',brand:'B',warehouseId:'BRANCH',purchaseDocumentNo:'PO1',supplier:'供應商 A',orderDate:'2026-11-05'}];
 const ordersCache=[],purchaseHistorySupplyCache=new Map();const purchasingReceivingReady=true,activeReceivingSupplyReady=true;
 const inlineJsValue=JSON.stringify,buildReceivingEvidenceIndex=()=>new Map(),purchaseFilterContext=()=>({}),receivingSourceOrderForItem=()=>null,purchaseLineMatchesFilters=()=>true;
 const canConfirmSupplyReceipt=()=>true,supplyCancelActionHtml=()=>'',receivingDueInfo=()=>({sortRank:3}),receivingWaitHtml=()=>'',receivingDueHtml=()=>'';
 const receiptTaskInFlight=()=>false;
 const renderReceiptTasks=()=>{},formatStatsMoney=value=>'NT$ '+value,localDateString=()=> '2026-11-05';
 document.querySelectorAll('.content-section').forEach(el=>el.classList.remove('active'));
 document.getElementById('purchasing-system').classList.add('active');
 document.getElementById('purchasing-system').style.display='block';
 for(let parent=document.getElementById('purchasing-system');parent;parent=parent.parentElement){parent.hidden=false;if(getComputedStyle(parent).display==='none')parent.style.display='block';}
 document.getElementById('poListPanel').style.display='block';
 document.getElementById('poListBody').closest('table').parentElement.style.display='block';
 window.renderPurchasingView=()=>renderPurchasingReceivingWorkList();
 renderPurchasingReceivingWorkList();
 `});
 assert.deepEqual(pageErrors,[]);
 assert.ok(await page.locator('#poListBody').isVisible());
 const text=await page.locator('#poListBody').textContent();
 assert.match(text,/庫存/);assert.match(text,/PO1/);assert.match(text,/供應商 A/);assert.match(text,/分倉/);assert.match(text,/銷售金額：—[\s\S]*採購成本：NT\$ 252[\s\S]*成本率：—/);
 assert.match(await page.locator('#purchaseAmountReceiving').textContent(),/含稅.*NT\$ 252/);
 assert.equal(await page.locator('#poListBody [data-th="交易方式"]').textContent(),'—');
 assert.match(text,/已到貨 1／應到貨 3/);assert.match(text,/待到貨 2/);
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.locator('#poListBody tr').count(),1);
  assert.ok((width===390?['grid','block']:['table-row']).includes(await page.locator('#poListBody tr').evaluate(el=>getComputedStyle(el).display)));
  await page.screenshot({path:'/tmp/yushin-receiving-'+width+'.png',fullPage:true});
 }
 await page.locator('#purchaseWorkSearch').fill('PO1');await page.evaluate(()=>renderPurchasingReceivingWorkList());assert.equal(await page.locator('#poListBody tr').count(),1);
 await page.locator('#purchaseWorkSearch').fill('無此貨號');await page.evaluate(()=>renderPurchasingReceivingWorkList());assert.equal(await page.locator('#poListBody tr').count(),0);
 assert.deepEqual(pageErrors,[]);
 console.log('PASS real Chrome fixtures: desktop/mobile editor and receiving list, ambiguous product choice, physical warehouses, draft/confirm without PDF, duplicate click, PO search and empty state');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
