'use strict';
// Original list buttons, quick action, lifecycle renderer and form handler.
// Scripted transport; the separate Auth suite exercises real Firebase SDKs.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const read=p=>fs.readFileSync(p,'utf8'),section=(source,a,b)=>{
 const i=source.indexOf(a),j=source.indexOf(b,i);assert.ok(i>=0&&j>i);return source.slice(i,j);
};
const actions=read('src/features/orders/delivery-actions.js'),workspace=read('src/features/orders/order-workspace.js');
const html=`<html lang="zh-Hant"><meta charset="utf-8"><div id="list"></div><div id="orderLifecycleActionHint"></div>
<button id="openLifecycleFormBtn" onclick="openOrderLifecycleForm()"></button><button id="openReturnFormBtn"></button>
<button id="reorderAfterReturnBtn"></button><div id="orderStatusEditPanel"><select id="orderLifecycleStatus"></select>
<input id="orderLifecycleDate" value="2026-10-20"><input id="orderLifecycleReason" value="客戶恢復">
<button id="orderLifecycleSaveBtn" onclick="saveOrderLifecycleStatus()">儲存狀態</button><div id="orderLifecycleStatusHint"></div></div>
<div id="returnFormPanel"><input id="returnEditId"></div><table><tbody id="returnRecordsBody"></tbody></table></html>`;
const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
(async()=>{
 assert.ok(executablePath,'Chrome is required');const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[],payloads=[];page.on('pageerror',e=>errors.push(e.message));
  const order={id:'O',orderStatus:'normal',status:'active',inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_browser',
   items:[{itemId:'I',productId:'P',warehouseId:'A',qty:3}],orderLifecycleHistory:[],returnRecords:[]};
  let applied=0,lose=true;
  await page.exposeFunction('lifecycleRead',(name,id)=>name==='orders'?structuredClone(order):
   {orderId:'O',itemId:id.slice(3),locationSchemaVersion:2,lifecycleWarehouseIds:['A','B']});
  await page.exposeFunction('lifecycleCall',payload=>{
   assert.equal(payload.actorUid,undefined);assert.equal(payload.actorRole,undefined);payloads.push(structuredClone(payload));
   assert.deepEqual(payload.warehouseIds,['A','B']);assert.deepEqual(payload.itemIds,['I']);
   if(!order.orderLifecycleHistory.some(h=>h.operationId===payload.operationId)){
    applied++;order.orderStatus=payload.nextStatus;order.status=payload.nextStatus==='cancelled'?'cancelled':'active';
    order.orderLifecycleHistory.push({operationId:payload.operationId,by:'U',actorRole:'sales',after:{status:payload.nextStatus,date:payload.date,reason:payload.reason}});
   }
   if(lose){lose=false;throw Error('lifecycle browser reply lost');}
   return {data:{status:'already-applied',orderId:'O',nextStatus:payload.nextStatus,receiptId:'single-v2-lifecycle-'+payload.operationId,
    items:[{itemId:'I'}],postCommitAllocation:{status:payload.nextStatus==='cancelled'?'recovery-pending':'not-applicable',sources:[]}}};
  });
  await page.route('http://127.0.0.1:4187/',route=>route.fulfill({contentType:'text/html',body:html}));
  const setup=async()=>{
   await page.goto('http://127.0.0.1:4187/');
   await page.addScriptTag({content:`let currentUser={uid:'U'},currentUserRole='sales',ordersCache=[],pendingLifecycleOrderIds=new Set(),
    currentDeliveryOrderId=null,currentLifecycleOrderId='O',orderLifecycleFormOpen=false,orderReturnFormOpen=false;
    globalThis.YUSHIN_V2_LIFECYCLE_EMULATOR=true;
    const app={options:{projectId:'demo-yushin'}};
    const firebase={app(){return {functions:region=>this.functions(region)};},auth:()=>({app,currentUser:{uid:'U'},emulatorConfig:{host:'localhost',port:9099}}),
     functions:()=>({app,useEmulator:(h,p)=>{if(h!=='127.0.0.1'||p!==5001)throw Error('remote transport');},
      httpsCallable:name=>{if(name!=='setV2OrderLifecycle')throw Error('wrong endpoint');return lifecycleCall;}})};
    const db={collection:n=>({doc:id=>({get:async options=>{if(options.source!=='server')throw Error('cache read');const row=await lifecycleRead(n,id);return {exists:true,data:()=>row};}})})};
    const canManageOrderLifecycleCapability=()=>['admin','sales','engineer'].includes(currentUserRole),canEditPage=()=>true;
    const normalizedOrderStatus=o=>o.orderStatus,normalizedOrderItems=o=>o.items,inventoryProductKey=i=>i.productId;
    const deliveryProgressInfo=()=>({remaining:3,delivered:0,grossDelivered:0});
    const orderLifecycleInfo=o=>({status:o.orderStatus}),savedReturnRecords=o=>o.returnRecords;
    const returnItemDeliveredQty=()=>0,returnItemReturnedQty=()=>0,customerReturnPendingQty=()=>0;
    const escapeHtml=s=>String(s||''),inlineJsValue=s=>JSON.stringify(s).replaceAll(String.fromCharCode(34),'&quot;');
    const localDateString=()=> '2026-10-20',syncOrderIntoPurchasingCaches=()=>{},writeAppDataCache=()=>{};
    window.invalidated=[];const invalidateWarehouseStockCache=(p,w)=>invalidated.push([p,w]);
    window.feedback=[];const showActionFeedback=m=>feedback.push(m);
    window.alerts=[];window.alert=m=>alerts.push(m);window.prompts=0;window.confirm=()=>{prompts++;return true;};
    const confirmOrderCancellation=()=>confirm('取消？'),renderDeliveryModal=()=>{},labelOrderProgressRecords=()=>{},
     populateReturnItemOptions=()=>{},updateReturnFormHint=()=>{},onOrderLifecycleStatusChange=()=>{};
    const renderOrdersList=()=>{document.getElementById('list').innerHTML=orderLifecycleActionButtons(ordersCache[0],orderLifecycleInfo(ordersCache[0]),deliveryProgressInfo(),{});};
    const selectOrderProgressTab=()=>{};`});
   await page.addScriptTag({content:read('src/services/order-lifecycle.js')});
   await page.addScriptTag({content:section(workspace,'function orderLifecycleActionButtons(','// Only a fully ready')});
   await page.addScriptTag({content:section(read('src/features/orders/lifecycle-workspace.js'),'function applySavedOrderLifecycle(','window.toggleOrderProgressStatus')});
   await page.addScriptTag({content:section(actions,'function renderOrderLifecycleStatusOptions(','// Customer return mutations')});
   await page.addScriptTag({content:section(read('src/features/orders/order-progress.js'),'window.openOrderLifecycleForm =','window.openReturnForm =')});
   await page.evaluate(async()=>{ordersCache=[await lifecycleRead('orders','O')];renderOrdersList();renderOrderLifecycleModal();});
  };
  await setup();await page.locator('#list button').filter({hasText:'取消訂單'}).click();
  await page.waitForFunction(()=>alerts.length===1);assert.equal(applied,1);assert.equal(order.orderStatus,'cancelled');
  assert.equal(await page.evaluate(()=>ordersCache[0].orderStatus),'normal');
  await setup();assert.equal(await page.locator('#list button').filter({hasText:'確認前次取消／恢復結果'}).count(),1);
  await page.evaluate(()=>{currentUserRole='engineer';renderOrdersList();renderOrderLifecycleModal();});
  assert.equal(await page.locator('#list button').count(),0);
  assert.match(await page.locator('#list').textContent(),/原帳號與角色/);
  assert.equal(await page.locator('#orderLifecycleActionHint').isVisible(),true);
  await page.evaluate(()=>{currentUserRole='sales';renderOrdersList();renderOrderLifecycleModal();});
  await page.locator('#list button').click();await page.waitForFunction(()=>!pendingV2OrderLifecycle('O'));
  assert.equal(applied,1);assert.deepEqual(payloads[1],payloads[0]);
  assert.match((await page.evaluate(()=>feedback))[0],/取消已完成/);
  assert.deepEqual(await page.evaluate(()=>invalidated),[['P','A'],['P','B']]);
  lose=true;await page.locator('#openLifecycleFormBtn').click();
  await page.fill('#orderLifecycleReason','客戶恢復');await page.locator('#orderLifecycleSaveBtn').click();
  await page.waitForFunction(()=>alerts.length===1);assert.equal(applied,2);assert.equal(order.orderStatus,'normal');
  await setup();await page.locator('#openLifecycleFormBtn').click();
  assert.equal(await page.locator('#orderLifecycleStatus').inputValue(),'normal');
  assert.equal(await page.locator('#orderLifecycleDate').isDisabled(),true);
  assert.equal(await page.locator('#orderLifecycleReason').inputValue(),'客戶恢復');
  await page.locator('#orderLifecycleSaveBtn').click();await page.waitForFunction(()=>!pendingV2OrderLifecycle('O'));
  assert.deepEqual(payloads[3],payloads[2]);assert.equal(applied,2);assert.equal(order.orderLifecycleHistory.length,2);
  assert.deepEqual(errors,[]);console.log('V2 lifecycle '+width+'px original quick/form, frozen retry, reload and role warning passed.');
  await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
