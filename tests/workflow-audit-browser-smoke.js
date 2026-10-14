// Actual shared CSS and direct-arrival entry handlers, with isolated data; not a production login.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const app=fs.readFileSync('app.js','utf8');const section=(a,b)=>app.slice(app.indexOf(a),app.indexOf(b,app.indexOf(a)));
const bootstrap=`
let currentUser={uid:'OWNER'},currentUserRole='sales';
const order={id:'O',ownerUid:'OWNER',status:'active',items:[{itemId:'I',itemCode:'A1',qty:3,fulfillmentType:'DIRECT_SHIP',supplyOrderedQty:3,receivedQty:0}]};
let ordersCache=[order],supplyReceivingCache=[],poReceiptTargetId='';
const supply={id:'D',orderId:'O',itemId:'I',ownerUid:'OWNER',fulfillmentType:'DIRECT_SHIP',qty:3,receivedQty:0,status:'ORDERED',itemCode:'A1'};
const normalizedOrderItems=o=>o.items,normalizedOrderStatus=o=>o.status==='active'?'normal':'cancelled',orderInventorySyncIncomplete=()=>false;
const escapeHtml=x=>String(x||'');
const beginActionButton=b=>{if(b.disabled)return null;b.disabled=true;return {};},endActionButton=b=>{if(b)b.disabled=false;};
window.messages=[];const showActionFeedback=x=>messages.push(x);
const readQueryInBatches=async()=>[supply],isPurchaseTerminalStatus=s=>['CANCELLED','CLOSED'].includes(s);
const db={collection:()=>({where(){return this;}})},receiptTaskBlocksSupply=()=>false,ensureReceiptOperationId=()=> 'OP';
window.alert=x=>messages.push(x);
`;
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(name=>spawnSync('which',[name],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
 assert.ok(executablePath,'Headless Chrome is required');
 const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});const errors=[];
 try{
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:900}});page.on('pageerror',e=>errors.push(e.message));
   await page.setContent('<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="appContainer"><div id="actions"></div><div id="poReceiptBatchOverlay" class="eq-modal-overlay"><div class="eq-modal-box"><h3 id="poReceiptBatchTitle"></h3><div class="table-wrap"><table><tbody id="poReceiptBatchBody"></tbody></table></div></div></div></div></body></html>');
   await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
   for(const content of [bootstrap,section('function inlineJsValue(', '// 早期估價單/訂單'),section('function canReceiveInventoryCapability(', 'function canManageEquipmentCapability('),
    section('function directShipReceiptActionHtml(', 'window.openSelfOrderModal ='),section('window.openSupplyReceipt =', 'const receiptTaskJobs =')])await page.addScriptTag({content});
   for(const role of ['sales','engineer','purchaser','warehouse','admin']){
    await page.evaluate(role=>{currentUserRole=role;document.getElementById('poReceiptBatchOverlay').classList.remove('active');document.getElementById('actions').innerHTML=directShipReceiptActionHtml(order);},role);
    assert.equal(await page.locator('#actions button').count(),['sales','engineer','admin'].includes(role)?1:0);
    if(['sales','engineer','admin'].includes(role)){
     await page.locator('#actions button').click();await page.waitForFunction(()=>document.getElementById('poReceiptBatchOverlay').classList.contains('active'));
     assert.match(await page.locator('#poReceiptBatchTitle').textContent(),/原廠直送到貨/);
     assert.equal(await page.locator('.po-receive-qty').inputValue(),'3');assert.equal(await page.locator('.po-receive-lot').isDisabled(),true);
     assert.equal(await page.locator('.po-receive-expiry').isDisabled(),true);
     if(width===390)assert.ok(await page.locator('#actions button').evaluate(el=>el.getBoundingClientRect().height)>=44);
    }
   }
   await page.evaluate(()=>{currentUserRole='sales';currentUser={uid:'OTHER'};document.getElementById('actions').innerHTML=directShipReceiptActionHtml(order);});
   assert.equal(await page.locator('#actions button').count(),0);
   await page.close();console.log(`Workflow ${width}px: five roles, exact owner, direct-arrival quantity and disabled lot fields passed.`);
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(err=>{console.error(err);process.exitCode=1;});
