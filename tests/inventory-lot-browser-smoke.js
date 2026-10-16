// Actual batch cell, reader and search handlers; isolated data, no Firebase session.
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const workspace=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
const bootstrap=`
let currentUser={uid:'U'},currentUserRole='warehouse',inventorySearchGeneration=0,inventorySearchLoading=false,inventorySearchActive=false,inventorySearchResults=[],fail=false,reads=0;
const DEFAULT_LIST_LIMIT=50,docs=new Map(),item={productKey:'P',itemName:'試劑',lots:[{lotNo:'STALE',qty:999}]};
const escapeHtml=s=>String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),inlineJsValue=s=>"'"+String(s)+"'",lotStatus=()=>'';
const firestoreReadWithTimeout=p=>p,normalizeFullHistorySearchValue=s=>String(s||'').trim().toLowerCase(),fullHistoryServerToken=s=>String(s).toLowerCase();
const loadWarehouseStocksForInventoryPage=async()=>{},runReadJobs=jobs=>Promise.all(jobs.map(job=>job()));
const db={collection:col=>{const filters=[];let max=100,after='';const q={where(f,op,v){filters.push([f,op,v]);return q;},limit(n){max=n;return q;},startAfter(s){after=s.id;return q;},get:async()=>{
 reads++;if(fail)throw Error('offline');const rows=[...docs].filter(([p,d])=>p.startsWith(col+'/')&&p.split('/')[1]>after&&filters.every(([f,op,v])=>op==='in'?v.includes(d[f]):op==='array-contains'?(d[f]||[]).includes(v):d[f]===v)).sort(([a],[b])=>a.localeCompare(b)).slice(0,max);
 return {size:rows.length,docs:rows.map(([p,d])=>({id:p.split('/')[1],data:()=>structuredClone(d)}))};}};return q;}};
const renderInventoryList=()=>{document.getElementById('inventoryListBody').innerHTML=(inventorySearchActive?inventorySearchResults:[item]).map(row=>'<tr class="inventory-list-row inventory-expanded"><td>'+escapeHtml(row.itemName||'試劑')+'</td><td data-th="批號／效期" class="inventory-detail-field">'+inventoryLotCellHtml(row)+'</td></tr>').join('');};
`;
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();assert.ok(executablePath,'Headless Chrome required');
 const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']}),errors=[];
 try{for(const width of [1280,390]){
  const page=await browser.newPage({viewport:{width,height:950}});page.on('pageerror',e=>errors.push(e.message));
  const index=fs.readFileSync('index.html','utf8'),button=index.match(/<button id="inventoryLotSearchMoreBtn"[^]*?<\/button>/)[0];
  await page.setContent('<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="appContainer"><div id="inventory-system" class="content-section active"><input id="inventorySearch"><span id="inventorySearchStatus"></span><div class="table-wrap inventory-main-table-wrap"><table id="inventoryListTable"><tbody id="inventoryListBody"></tbody></table></div>'+button+'</div></div></body></html>');
  await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});await page.addScriptTag({content:bootstrap});
  for(const path of ['modules/inventory-core.js','src/infrastructure/inventory-lot-read.js','src/features/inventory/inventory-lot-view.js'])await page.addScriptTag({content:fs.readFileSync(path,'utf8')});
  await page.addScriptTag({content:workspace.slice(workspace.indexOf('function inventoryRecordMatches('),workspace.indexOf('window.scheduleInventorySearch='))+workspace.slice(workspace.indexOf('async function runInventorySearch('),workspace.indexOf('let inventoryBrandFilterSignature'))});
  await page.evaluate(async()=>{for(let i=0;i<102;i++)docs.set('inventoryLots/L'+String(i).padStart(3,'0'),{productKey:'P',warehouseId:'W',remainingQty:i===101?2:0,lotNo:'REAL',expiryDate:'2027-01-01'});await loadInventoryLotsForPage([item]);renderInventoryList();});
  assert.match(await page.locator('#inventoryListBody').textContent(),/尚未讀完/);assert.doesNotMatch(await page.locator('#inventoryListBody').textContent(),/STALE/);
  await page.locator('#inventoryListBody button').click();await page.waitForFunction(()=>document.getElementById('inventoryListBody').textContent.includes('REAL'));
  assert.equal(await page.evaluate(()=>reads),2);assert.doesNotMatch(await page.locator('#inventoryListBody').textContent(),/尚未讀完/);
  await page.evaluate(async()=>{resetInventoryLotView();fail=true;await loadInventoryLotsForPage([item]);renderInventoryList();});assert.match(await page.locator('#inventoryListBody').textContent(),/讀取失敗/);
  await page.evaluate(()=>{fail=false;});await page.locator('#inventoryListBody button').click();await page.waitForFunction(()=>document.getElementById('inventoryListBody').textContent.includes('尚未讀完'));
  await page.evaluate(async()=>{resetInventoryLotView();docs.clear();for(let i=0;i<51;i++)docs.set('inventoryLots/M'+String(i).padStart(3,'0'),{productKey:i===50?'LAST':'P',warehouseId:'W',remainingQty:1,lotNo:'MATCH'});docs.set('inventory/P',{productKey:'P',itemName:'先讀試劑'});docs.set('inventory/LAST',{productKey:'LAST',itemName:'下一頁試劑'});document.getElementById('inventorySearch').value='MATCH';await runInventorySearch();});
  assert.equal(await page.locator('#inventoryLotSearchMoreBtn').isVisible(),true);assert.doesNotMatch(await page.locator('#inventoryListBody').textContent(),/下一頁試劑/);
  await page.locator('#inventoryLotSearchMoreBtn').click();await page.waitForFunction(()=>document.getElementById('inventoryListBody').textContent.includes('下一頁試劑'));
  assert.equal(await page.locator('#inventoryLotSearchMoreBtn').isVisible(),false);
  await page.screenshot({path:'/tmp/inventory-lot-'+width+'.png',fullPage:true});await page.close();console.log('Inventory lots '+width+'px: authoritative batches, partial paging, error/retry and exact batch search passed.');
 }}finally{await browser.close();}assert.deepEqual(errors,[]);
})().catch(err=>{console.error(err);process.exitCode=1;});
