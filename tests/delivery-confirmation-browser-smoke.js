'use strict';
// Real original delivery renderer/form and Service/Core with a scripted local transport.
// Real Auth SDK, Callable and Firestore integration is exercised separately.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const read=p=>fs.readFileSync(p,'utf8');
const ui=read('src/features/orders/delivery-actions.js');
const section=(a,b)=>{const i=ui.indexOf(a),j=ui.indexOf(b,i);assert.ok(i>=0&&j>i);return ui.slice(i,j);};
const input=`<html lang="zh-Hant"><meta charset="utf-8"><input id="deliveryEditId" value="">
<div id="deliveryFormPanel"><input id="deliveryDate" value="2026-10-19"><input id="deliveryQty" value="2">
<input id="deliveryNotes" value="已收到"><span id="deliveryFormHint"></span>
<button onclick="saveDeliveryRecord()">確認送達</button></div>
<div id="orderWorkflowSteps"></div><div id="deliveryOrderSummary"></div>
<div id="deliveryFormTitle"></div><button id="deliveryCancelEditBtn"></button>
<button id="openPartialDeliveryBtn"></button><table><tbody id="deliveryRecordsBody"></tbody></table></html>`;
const fixture=()=>({id:'O',ownerUid:'buyer',salesCode:'S',status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
 inventoryReservationAttemptId:'delivery_browser_sync',deliveryRecords:[],returnRecords:[],deliveredQty:0,isDelivered:false,
 items:[{itemId:'I',productId:'P',qty:2,warehouseId:'B',dispatchPreparedQty:2,warehouseShippedQty:2,deliveredQty:0}],
 warehouseShipmentRecords:[{id:'shipment_source_12345',orderId:'O',itemId:'I',productKey:'P',warehouseId:'B',
  sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT',qty:2,date:'2026-10-18'}]});
const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
(async()=>{
 assert.ok(executablePath,'Chrome is required');const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const order=fixture();let calls=0,applied=0,lost=true,reverseCalls=0,reversed=0,reverseLost=true;
  const shipmentBefore=structuredClone(order.warehouseShipmentRecords);
  await page.exposeFunction('deliveryRead',()=>structuredClone(order));
  await page.exposeFunction('deliveryConfirm',payload=>{
   calls++;assert.equal(payload.actorUid,undefined);assert.equal(payload.actorRole,undefined);
   assert.equal(payload.shipmentId,'shipment_source_12345');assert.equal(payload.syncAttemptId,'delivery_browser_sync');
   assert.equal(payload.quantity,2);
   if(!applied){
    applied++;order.deliveryRecords.push({id:payload.operationId,orderId:'O',itemId:'I',shipmentId:payload.shipmentId,
     productKey:'P',warehouseId:'B',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION',qty:2,date:payload.date});
    order.deliveredQty=2;order.items[0].deliveredQty=2;order.isDelivered=true;
   }
   if(lost){lost=false;throw Error('simulated lost delivery reply');}
   return {data:{status:'already-applied',orderId:'O',itemId:'I',shipmentId:payload.shipmentId,recordId:payload.operationId}};
  });
  await page.exposeFunction('deliveryReverse',payload=>{
   reverseCalls++;assert.equal(payload.actorUid,undefined);assert.equal(payload.actorRole,undefined);
   assert.equal(payload.deliveryRecordId,confirmedId);assert.equal(payload.reason,'誤登簽收');
   if(!reversed){reversed++;order.deliveryRecords=[];order.deliveredQty=0;order.items[0].deliveredQty=0;order.isDelivered=false;}
   if(reverseLost){reverseLost=false;throw Error('simulated lost reversal reply');}
   return {data:{status:'already-applied',orderId:'O',itemId:'I',deliveryRecordId:payload.deliveryRecordId,operationId:payload.operationId}};
  });
  let confirmedId;
  await page.route('http://127.0.0.1:4186/' ,route=>route.fulfill({contentType:'text/html',body:input}));
  const setup=async()=>{
   await page.goto('http://127.0.0.1:4186/');
   await page.addScriptTag({content:read('modules/fulfillment-core.js')});
   await page.addScriptTag({content:`let currentUser={uid:'buyer'},currentUserRole='sales',ordersCache=[],currentDeliveryOrderId='O',
      deliveryPartialFormOpen=true,deliveryCreateAttempt=null,pendingDeliveryOrderIds=new Set();
      globalThis.YUSHIN_V2_DELIVERY_EMULATOR=true;
      const app={options:{projectId:'demo-yushin'}};
      globalThis.firebase={app(){return {functions:region=>this.functions(region)};},auth:()=>({app,currentUser:{uid:'buyer'},emulatorConfig:{host:'127.0.0.1',port:9099}}),
       functions:()=>({app,useEmulator:(host,port)=>{if(host!=='127.0.0.1'||port!==5001)throw Error('remote endpoint');},
        httpsCallable:name=>name==='confirmV2ShipmentDelivery'?deliveryConfirm:name==='reverseV2ShipmentDelivery'?deliveryReverse:()=>{throw Error('unexpected endpoint');}})};
      const db={collection:()=>({doc:()=>({get:async()=>{const row=await deliveryRead();return {exists:true,data:()=>row};}})})};
      const canManageOrderLifecycleCapability=()=>['admin','sales','engineer'].includes(currentUserRole),canEditPage=()=>true;
      const normalizedOrderItems=o=>o.items,normalizedOrderStatus=()=> 'normal';
      const savedDeliveryRecords=o=>o.deliveryRecords, savedReturnRecords=o=>o.returnRecords;
      const deliveryProgressInfo=o=>({state:o.isDelivered?'complete':'none',remaining:2-o.deliveredQty,total:2,delivered:o.deliveredQty});
      const orderLifecycleInfo=()=>({status:'normal',label:'正常'});
      const purchaseProgressInfo=()=>({state:'ready',label:'已採購'});
      const fulfillmentProgressInfo=()=>({state:'ready',label:'已出貨'});
      const escapeHtml=s=>String(s||''),escapeAttr=s=>String(s||''),inlineJsValue=s=>JSON.stringify(s).replaceAll(String.fromCharCode(34),'&quot;');
      const formatOrderStatusTime=()=>'',labelOrderProgressRecords=()=>{},localDateString=()=> '2026-10-19';
      const deliveryRecordId=()=> 'browser_'+crypto.randomUUID();
      const resetDeliveryForm=()=>{},renderOrderLifecycleModal=()=>{},renderOrdersList=()=>{};
      window.alerts=[];window.alert=s=>alerts.push(s);window.promptCalls=0;window.prompt=()=>{promptCalls++;return '誤登簽收';};`});
   await page.addScriptTag({content:read('src/services/delivery-records.js')});
   await page.addScriptTag({content:section('function renderDeliveryModal() {','window.editDeliveryRecord =')
      +section('window.saveDeliveryRecord =','window.clearLegacyDelivery =')});
   await page.evaluate(async()=>{ordersCache=[await deliveryRead()];renderDeliveryModal();});
  };
  await setup();
  assert.equal(await page.locator('#deliveryShipmentId option').count(),2);
  await page.selectOption('#deliveryShipmentId','shipment_source_12345');
  await page.locator('[onclick="saveDeliveryRecord()"]').click();
  await page.waitForFunction(()=>alerts.length===1);
  assert.match((await page.evaluate(()=>alerts))[0],/simulated lost delivery reply/);
  assert.equal(applied,1);assert.equal(order.deliveredQty,2);assert.equal(order.warehouseShipmentRecords.length,1);
  await setup();
  assert.equal(await page.locator('#deliveryShipmentId').inputValue(),'shipment_source_12345');
  assert.equal(await page.locator('#deliveryQty').inputValue(),'2');
  await page.locator('[onclick="saveDeliveryRecord()"]').click();
  await page.waitForFunction(()=>!pendingV2DeliveryConfirmation('O'));
  assert.equal(calls,2);assert.equal(applied,1);assert.equal(order.deliveryRecords.length,1);
  confirmedId=order.deliveryRecords[0].id;
  await page.evaluate(()=>{currentUserRole='purchaser';renderDeliveryModal();});
  assert.equal(await page.locator('#deliveryRecordsBody button').count(),0);
  await page.evaluate(()=>{currentUserRole='sales';renderDeliveryModal();});
  await page.locator('#deliveryRecordsBody button').filter({hasText:'撤銷送達確認'}).click();
  await page.waitForFunction(()=>alerts.length===1);
  assert.match((await page.evaluate(()=>alerts))[0],/simulated lost reversal reply/);
  assert.equal(reversed,1);assert.equal(await page.evaluate(()=>promptCalls),1);
  await page.evaluate(()=>{currentUserRole='engineer';renderDeliveryModal();});
  assert.equal(await page.locator('#deliveryRecordsBody button').count(),0);
  assert.match(await page.locator('#deliveryFormHint').textContent(),/原帳號與角色/);
  assert.equal(await page.locator('#deliveryRecordsBody td').filter({hasText:'原帳號與角色'}).isVisible(),true);
  await setup();
  assert.equal(await page.locator('#deliveryRecordsBody button').filter({hasText:'確認撤銷結果'}).count(),1);
  assert.equal(await page.locator('#deliveryRecordsBody button').filter({hasText:'撤銷送達確認'}).count(),0);
  await page.locator('#deliveryRecordsBody button').filter({hasText:'確認撤銷結果'}).click();
  await page.waitForFunction(()=>!pendingV2DeliveryReversal('O'));
  assert.equal(await page.evaluate(()=>promptCalls),0);
  assert.equal(reverseCalls,2);assert.equal(reversed,1);assert.equal(order.deliveredQty,0);
  assert.deepEqual(order.warehouseShipmentRecords,shipmentBefore);
  assert.equal(order.items[0].warehouseShippedQty,2);assert.equal(order.items[0].dispatchPreparedQty,2);
  assert.deepEqual(errors,[]);
  console.log(`V2 delivery ${width}px: original form, exact shipment selection, lost reply, reload, reversal after lost reply and no stock mutation passed.`);
  await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
