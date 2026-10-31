'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const workspace=fs.readFileSync('src/features/orders/order-workspace.js','utf8'),status=fs.readFileSync('src/features/orders/order-status.js','utf8');
const section=(s,a,b)=>s.slice(s.indexOf(a),s.indexOf(b,s.indexOf(a)));
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(x=>spawnSync('which',[x],{encoding:'utf8'})).find(x=>x.status===0)?.stdout.trim();
 assert.ok(executablePath,'Chrome required');const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="actions" class="order-compact-actions"></div></html>');
  await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
  await page.addScriptTag({content:`
   let currentUser={uid:'U'},currentUserRole='admin',currentUserName='Tester',currentDeliveryOrderId=null,activeOrderWorkFilter='all';
   const pendingOrderStatusKeys=new Set(),BUSINESS_STATUS={ACTIVE:'active'};
   let ordersCache=[{id:'O',ownerUid:'U',status:'active',inventoryReservationStatus:'failed',isBilled:false,items:[],statusHistory:[]},{id:'OTHER',status:'active',isBilled:false,items:[],statusHistory:[]}];
   window.billingWrites=[];
   const normalizedOrderStatus=()=> 'normal',orderSourceSyncIncomplete=()=>false,canRetrySourceDocumentSync=()=>false,canManageOrderLifecycleCapability=()=>true,canEditPage=()=>true;
   const inlineJsValue=x=>JSON.stringify(x).replaceAll('"','&quot;'),orderBillingDate=()=>'',localDateString=()=> '2026-10-31',deliveryProgressInfo=()=>({state:'pending'});
   const writeAppDataCache=()=>{},syncOrderIntoPurchasingCaches=()=>{},showActionFeedback=()=>{},syncNewOrderSourceDocuments=async()=>null;
   const firestoreReadWithTimeout=p=>p,db={collection:()=>({doc:id=>({get:async()=>({exists:true,id,data:()=>ordersCache.find(o=>o.id===id)})})})};
   const synchronizeOrderInventory=async(id,order)=>{await new Promise(resolve=>window.finishInventory=()=>{order.inventoryReservationStatus='completed';resolve();});};
   const setOrderBillingStatus=async(id,value,date)=>{billingWrites.push(id);return {isBilled:value,billingDate:date,status:'active',statusHistory:[]};};
   function renderOrdersList(){document.getElementById('actions').innerHTML=orderInventorySyncStatusHtml(ordersCache[0])+'<button onclick="toggleOrderStatus(\\'O\\',\\'isBilled\\',true)">核銷</button>';}
  `});
  await page.addScriptTag({content:section(workspace,'const pendingOrderReservationIds =','async function writeOrderInventorySyncState')});
  await page.addScriptTag({content:section(workspace,'function orderInventorySyncStatusHtml(',"window.addEventListener('beforeunload'")});
  await page.addScriptTag({content:workspace.slice(workspace.indexOf('window.retryOrderInventoryReservation ='))});
  await page.addScriptTag({content:section(status,'window.toggleOrderStatus =','window.updateOrderBillingDate =')});
  await page.evaluate(()=>renderOrdersList());
  await page.getByRole('button',{name:'重試同步',exact:true}).dblclick();
  await page.waitForFunction(()=>!!window.finishInventory);
  assert.equal(await page.getByRole('button',{name:'重試同步',exact:true}).isDisabled(),true);
  await page.evaluate(()=>{toggleOrderStatus('O','isBilled',true);toggleOrderStatus('OTHER','isBilled',true);});
  assert.deepEqual(await page.evaluate(()=>billingWrites),['OTHER']);assert.equal(await page.evaluate(()=>ordersCache[0].isBilled),false);
  await page.evaluate(()=>finishInventory());await page.waitForFunction(()=>!pendingOrderReservationIds.has('O'));
  await page.getByRole('button',{name:'核銷',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>billingWrites),['OTHER','O']);assert.deepEqual(errors,[]);
  await page.close();console.log('Retry/billing '+width+'px passed');
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
