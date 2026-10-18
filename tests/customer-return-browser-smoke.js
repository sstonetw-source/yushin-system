'use strict';
// Actual existing return UI and extracted Service; memory transport only.
// Real Client SDK/Rules and physical stock posting are covered by Emulator tests.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const code=fs.readFileSync('modules/customer-cancellations.js','utf8');
const a=code.indexOf('window.receiveCustomerReturn='),b=code.indexOf('window.releaseCustomerReturnHold=',a);assert.ok(a>=0&&b>a);
const bootstrap=`
let currentUser={uid:'receiver'},currentUserRole='warehouse',customerReturnOrders=[],ordersCache=[];
const customerReturnActionsPending=new Set(),warehouseMasterCache=[{id:'A',active:true,warehouseName:'測試倉'}];
let sequence=0,lost=true;window.alerts=[];window.feedback=[];
const canReceiveInventoryCapability=()=>['admin','purchaser','warehouse'].includes(currentUserRole);
const normalizedOrderItems=o=>o.items,savedDeliveryRecords=o=>o.deliveryRecords,savedReturnRecords=o=>o.returnRecords;
const returnItemDeliveredQty=(o,id)=>o.deliveryRecords.filter(r=>r.itemId===id).reduce((s,r)=>s+r.qty,0);
const returnItemReturnedQty=(o,id)=>o.returnRecords.filter(r=>r.itemId===id).reduce((s,r)=>s+r.qty,0);
const deliveryActor=()=>currentUser.uid,localDateString=()=> '2026-10-18',orderWorkIndexFields=()=>({});
const db={collection:n=>({doc:id=>({path:n+'/'+id})})},loadWarehouseMaster=async()=>{};
const docs=new Map([['orders/O',{id:'O',ownerUid:'sales',salesCode:'S',items:[{itemId:'I',qty:2,warehouseId:'A'}],returnRequests:[{id:'Q',itemId:'I',qty:2,receivedQty:0,status:'PENDING'}],returnRecords:[],deliveryRecords:[{itemId:'I',qty:2,lotAllocations:[{lotId:'L',qty:2}]}]}],['warehouses/A',{active:true}]]);
async function runRoleTransaction(fn){const writes=[];await fn({get:async r=>({exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))}),set:(r,data)=>writes.push([r.path,data]),update:(r,data)=>writes.push([r.path,{...docs.get(r.path),...data}])});for(const [p,d] of writes)docs.set(p,d);if(lost&&writes.length){lost=false;throw Error('模擬成功回覆遺失');}}
const prompt=message=>message.includes('商品狀況')?'2':'1',alert=m=>alerts.push(m),lifecycleRecordId=()=> 'return-ui-'+(++sequence);
const actionFailureMessage=(_a,e)=>e.message,showActionFeedback=(m,t)=>feedback.push(m),markMainPageDirty=()=>{};
async function refreshAffectedOrderCaches(){ordersCache=[structuredClone(docs.get('orders/O'))];}
async function loadCustomerReturnQueue(){customerReturnOrders=[structuredClone(docs.get('orders/O'))];}
window.start=async()=>{await loadCustomerReturnQueue();document.getElementById('receive').onclick=function(){return receiveCustomerReturn('O','Q',this);};};
`;
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();assert.ok(executablePath,'Chrome required');
 const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><button type="button" id="receive">確認退貨收貨</button></html>');
  await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
  for(const content of [fs.readFileSync('modules/inventory-core.js','utf8'),bootstrap,fs.readFileSync('src/services/customer-return.js','utf8'),code.slice(a,b)])await page.addScriptTag({content});
  await page.evaluate(()=>start());await page.locator('#receive').click();await page.waitForFunction(()=>alerts.length===1);
  assert.equal(await page.evaluate(()=>docs.get('orders/O').returnRecords.length),1);
  await page.locator('#receive').click();await page.waitForFunction(()=>feedback.length>0);
  assert.equal(await page.evaluate(()=>docs.get('orders/O').returnRecords.length),1);
  assert.equal(await page.evaluate(()=>docs.get('customerReturnReceipts/return-ui-1').disposition),'HOLD');
  assert.equal(await page.evaluate(()=>[...docs.keys()].some(k=>k.startsWith('inventory/'))),false);
  assert.equal(await page.locator('#receive').isEnabled(),true);
  for(const role of ['sales','engineer']){await page.evaluate(async r=>{currentUserRole=r;await receiveCustomerReturn('O','Q',document.getElementById('receive'));},role);assert.equal(await page.evaluate(()=>docs.get('orders/O').returnRecords.length),1);}
  for(const role of ['admin','purchaser'])assert.equal(await page.evaluate(r=>{currentUserRole=r;return canReceiveInventoryCapability();},role),true);
  assert.deepEqual(errors,[]);console.log('Customer return '+width+'px: original click UI -> shared Service/Core, HOLD, uncertain receipt retry, no virtual stock and five-role contract passed.');await page.close();
 }}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
