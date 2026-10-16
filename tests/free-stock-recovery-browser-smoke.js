/* Real recovery UI and core with isolated stock; no production Firebase session. */
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const html=fs.readFileSync('index.html','utf8'),start=html.indexOf('<section class="panel no-print" id="freeStockRecoveryPanel"');
const panel=html.slice(start,html.indexOf('<div id="inventoryStockPanel">',start));
const bootstrap=`
let currentUser={uid:'receiver'},currentUserRole='warehouse',failAllocation=true,reads=0;
const warehouseMasterCache=[{id:'W',warehouseName:'主倉'}],docs=new Map();
const resetDocs=()=>{docs.clear();docs.set('warehouseStocks/W__P',{productKey:'P',warehouseId:'W',itemCode:'TEST-01',itemName:'試劑',onHand:3,reserved:0,allocationRevision:1,allocationPending:true});docs.set('inventory/P',{productKey:'P',onHand:3,reserved:0});docs.set('warehouses/W',{active:true});};resetDocs();
const canReceiveInventoryCapability=()=>['admin','purchaser','warehouse'].includes(currentUserRole),canAccessPage=()=>true;
const escapeHtml=x=>String(x||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),inlineJsValue=x=>"'"+String(x)+"'";
const inventoryNumbers=d=>({available:Math.max(0,Number(d.onHand||0)-Number(d.reserved||0))}),warehouseStockDocId=(w,p)=>w+'__'+p;
const firestoreReadWithTimeout=p=>p,showActionFeedback=()=>{},deliveryActor=()=> 'Receiver',markMainPageDirty=()=>{},invalidateWarehouseStockCache=()=>{},invalidateProcurementDemandQueue=()=>{},refreshAffectedOrderCaches=async()=>{};
const beginActionButton=b=>{const state={text:b.textContent};b.disabled=true;return state;},endActionButton=(b,s)=>{b.disabled=false;b.textContent=s.text;};
const ref=path=>({path,id:path.split('/').at(-1)}),snap=path=>({id:path.split('/').at(-1),exists:docs.has(path),data:()=>structuredClone(docs.get(path))});
const db={collection:name=>{let max=50,after='';return {doc:id=>ref(name+'/'+id),where(){return this;},limit(n){max=n;return this;},startAfter(s){after=s.id;return this;},get:async()=>{reads++;const rows=[...docs].filter(([path,d])=>path.startsWith(name+'/')&&d.allocationPending===true&&path.split('/').at(-1)>after).slice(0,max);return {docs:rows.map(([path])=>snap(path)),size:rows.length};}}}};
const runRoleTransaction=async fn=>{const writes=[];await fn({get:async r=>snap(r.path),update:(r,d)=>writes.push([r,d])});for(const [r,d] of writes)docs.set(r.path,{...docs.get(r.path),...d});};
const allocateFreeReceiptStockToShortages=async(key,warehouseId,qty)=>{if(failAllocation)throw Error('測試連線中斷');docs.get('warehouseStocks/'+warehouseId+'__'+key).reserved+=qty;docs.get('inventory/'+key).reserved+=qty;return {allocatedQty:qty,affectedOrderIds:[],completionReason:'exhausted'};};
`;
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();assert.ok(executablePath,'Headless Chrome required');
 const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']}),errors=[];
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:950}});page.on('pageerror',e=>errors.push(e.message));
  await page.setContent('<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="appContainer"><div id="inventory-system" class="content-section active">'+panel+'</div></div></body></html>');
  const font=process.env.RECOVERY_FONT?`@font-face{font-family:RecoveryTC;src:url(data:font/otf;base64,${fs.readFileSync(process.env.RECOVERY_FONT).toString('base64')})}body,button{font-family:RecoveryTC,sans-serif!important}`:'';
  await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')+font});
  await page.addScriptTag({content:bootstrap});await page.addScriptTag({content:fs.readFileSync('modules/free-stock-recovery.js','utf8')});
  for(const role of ['sales','engineer','warehouse','purchaser','admin']){
   await page.evaluate(async role=>{currentUserRole=role;resetFreeStockRecovery();resetDocs();reads=0;failAllocation=true;await loadFreeStockRecovery();},role);
   const allowed=['warehouse','purchaser','admin'].includes(role);
   assert.equal(await page.locator('#freeStockRecoveryPanel').isVisible(),allowed);
   assert.equal(await page.evaluate(()=>reads),allowed?1:0);
   if(allowed){assert.match(await page.locator('#freeStockRecoveryBody').textContent(),/TEST-01.*測試連線中斷/s);assert.equal(await page.evaluate(()=>docs.get('warehouseStocks/W__P').allocationPending),true);}
  }
  const button=page.locator('#freeStockRecoveryBody button');if(width===390){assert.ok(await button.evaluate(e=>e.getBoundingClientRect().height)>=44);assert.equal(await page.locator('#freeStockRecoveryBody tr').evaluate(e=>getComputedStyle(e).display),'block');}
  await page.screenshot({path:'/tmp/free-stock-recovery-'+width+'.png',fullPage:true});
  await page.evaluate(()=>{failAllocation=false;});await button.click();await page.waitForFunction(()=>docs.get('warehouseStocks/W__P').allocationPending===false);
  assert.equal(await page.evaluate(()=>docs.get('warehouseStocks/W__P').onHand),3);assert.equal(await page.locator('#freeStockRecoveryPanel').isVisible(),false);
  await page.evaluate(async()=>{resetFreeStockRecovery();docs.clear();reads=0;docs.set('warehouses/W',{active:true});for(let i=0;i<55;i++){const key='P'+String(i).padStart(3,'0');docs.set('warehouseStocks/W__'+key,{productKey:key,warehouseId:'W',onHand:3,reserved:0,allocationPending:true,allocationRevision:1});docs.set('inventory/'+key,{productKey:key,onHand:3,reserved:0});}await loadFreeStockRecovery();});
  assert.equal(await page.locator('#freeStockRecoveryPanel').isVisible(),true);assert.equal(await page.locator('#freeStockRecoveryMore').isVisible(),true);
  assert.equal(await page.evaluate(()=>[...docs].filter(([p,d])=>p.startsWith('warehouseStocks/')&&d.allocationPending).length),5);
  await page.locator('#freeStockRecoveryMore').click();await page.waitForFunction(()=>[...docs].filter(([p,d])=>p.startsWith('warehouseStocks/')&&d.allocationPending).length===0);
  assert.equal(await page.evaluate(()=>reads),2);assert.equal(await page.locator('#freeStockRecoveryPanel').isVisible(),false);
  await page.close();console.log('Free-stock recovery '+width+'px: five-role visibility, no unauthorized queries, failure, retry and 55-row paging passed.');
 }}finally{await browser.close();}assert.deepEqual(errors,[]);
})().catch(err=>{console.error(err);process.exitCode=1;});
