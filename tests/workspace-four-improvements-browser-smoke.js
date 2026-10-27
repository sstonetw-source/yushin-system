'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),{chromium}=require('playwright-core'),{spawnSync}=require('node:child_process');
const read=p=>fs.readFileSync(p,'utf8');
const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','chromium'].map(n=>spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
(async()=>{const browser=await chromium.launch({executablePath,args:['--no-sandbox']});try{for(const width of [1280,390]){
 const page=await browser.newPage({viewport:{width,height:850}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="appContainer"><div id="ordersBody" class="content-section active" style="padding-top:400px"><table><tbody><tr data-menu-title="客戶甲 · YS-1 · 2026-10-27" data-menu-scope="整張訂單操作"><td><details class="order-more-menu"><summary>更多</summary><div class="order-more-menu-popover"><button onclick="window.actionCount=(window.actionCount||0)+1">複製成新訂單</button></div></details></td></tr></tbody></table></div><div style="height:2000px"></div></div>');
 await page.addStyleTag({content:read('styles.css')});await page.addScriptTag({content:read('src/shared/workspace-interactions.js')});
 await page.evaluate(()=>{initializeWorkspaceMenus();initializeWorkspaceMenus();window.scrollTo(0,100);});
 const y=await page.evaluate(()=>scrollY);await page.locator('.order-more-menu > summary').click();await page.locator('.workspace-menu-dialog[open]').waitFor();
 assert.match(await page.locator('.workspace-menu-dialog header').innerText(),/客戶甲.*YS-1/);
 assert.equal(await page.locator('.workspace-menu-dialog').evaluate(d=>d.workspaceSourceSection.id),'ordersBody');
 assert.equal(await page.evaluate(()=>document.body.style.position),'fixed');
 await page.mouse.move(width-3,400);await page.mouse.wheel(0,600);await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>scrollY),0);
 await page.keyboard.press('Escape');await page.waitForFunction(()=>document.body.style.position!=='fixed');assert.equal(await page.evaluate(()=>scrollY),y);
 await page.locator('.order-more-menu > summary').click();await page.locator('.workspace-menu-dialog[open]').waitFor();await page.mouse.click(1,1);await page.waitForFunction(()=>!document.querySelector('.workspace-menu-dialog'));
 await page.locator('.order-more-menu > summary').click();await page.locator('.workspace-menu-dialog[open]').waitFor();await page.getByRole('button',{name:'複製成新訂單'}).click();assert.equal(await page.evaluate(()=>actionCount),1);
 await page.waitForFunction(()=>!document.querySelector('.workspace-menu-dialog'));assert.equal(await page.locator('.order-more-menu-popover').count(),1);
 // Actual personal settings module, scripted own-profile transport; no real writes.
 await page.addScriptTag({content:`
 let currentUser={uid:'SELF',email:'me@example.com'},currentUserRole='sales',currentUserPhone='old';
 let allUsersCache=[{uid:'SELF',name:'本人',code:'S1',phone:'old'}],salesList=[{uid:'SELF',name:'本人'}];
 const defaultWarehouse=()=>({id:'MAIN'}),setOrderShippingInstructions=()=>{};
 const escapeHtml=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;'),escapeAttr=escapeHtml;
 const firestoreReadWithTimeout=p=>p,beginActionButton=(b)=>{b.disabled=true;return {};},endActionButton=b=>b.disabled=false;
 window.writes=[];window.failSave=false;window.savedOrder={deliveryPlan:{mode:'SALES_SHIP',address:'原地址'}};
 const db={collection:name=>{if(name!=='users')throw Error('unexpected collection');return {doc:uid=>{if(uid!=='SELF')throw Error('other user access');return {get:async()=>({exists:true,data:()=>({name:'本人',code:'S1',email:'me@example.com',phone:'old',role:'sales'})}),update:async data=>{if(window.failSave)throw Error('測試離線');window.writes.push({uid,data});}};}};}};
 const firebase={firestore:{FieldValue:{serverTimestamp:()=> 'SERVER_TIMESTAMP'}}};
 `});
 await page.addScriptTag({content:read('modules/warehouse-logistics.js')});await page.addScriptTag({content:read('modules/delivery-settings.js')});
 await page.evaluate(()=>openPersonalSettings());await page.locator('#personalMode').waitFor();assert.equal(await page.locator('#personalSettingsForm input').count(),4);
 await page.locator('#personalMode').selectOption('SALES_SHIP');await page.locator('#personalPhone').fill('0912345678');
 await page.locator('#personalContact').fill('本人收件');await page.locator('#personalDeliveryPhone').fill('0912345678');await page.locator('#personalAddress').fill('台北市測試地址');
 page.on('dialog',dialog=>dialog.accept());await page.locator('#personalSettingsForm [type=submit]').click();await page.waitForFunction(()=>writes.length===1);
 assert.deepEqual(await page.evaluate(()=>Object.keys(writes[0].data).sort()),['deliveryDefaults','phone','updatedAt']);assert.equal(await page.evaluate(()=>writes[0].uid),'SELF');
 assert.equal(await page.evaluate(()=>savedOrder.deliveryPlan.address),'原地址');assert.equal(await page.evaluate(()=>salesList[0].deliveryDefaults.address),'台北市測試地址');
 await page.evaluate(()=>window.failSave=true);await page.locator('#personalSettingsForm [type=submit]').click();await page.waitForFunction(()=>document.getElementById('personalSettingsStatus').textContent.includes('儲存失敗'));
 assert.equal(await page.evaluate(()=>writes.length),1);await page.evaluate(()=>closeDeliverySettings());await page.waitForFunction(()=>document.body.style.position!=='fixed');
 // Actual stock row organizer retains lots, metrics and original handlers in the drawer.
 await page.addScriptTag({content:read('src/shared/workspace-display.js')});
 await page.evaluate(()=>{
 const host=document.getElementById('appContainer');host.innerHTML='<div id="inventory-system"><table id="inventoryListTable"><thead><tr></tr></thead><tbody id="inventoryListBody"></tbody></table></div>';
 const row=document.createElement('tr');const labels=['貨號','品名','廠牌','倉庫位置','現有庫存','已預留','可用庫存','庫存策略','安全庫存','在途','預計庫存','批號／效期','操作'];
 row.innerHTML=labels.map((name,index)=>'<td data-th="'+name+'">'+(index===1?'<strong>試劑</strong>':index===3?'主倉：現有 5／分倉：現有 2':index===11?'批號 LOT-1／效期 2027-01-01':index===12?'<div class="inventory-row-actions"><button class="inventory-details-toggle" onclick="this.closest(\'tr\').querySelector(\'dialog\').showModal()">詳細資料</button><button onclick="window.adjustCalled=true">修改庫存</button></div>':String(index))+'</td>').join('');document.getElementById('inventoryListBody').append(row);organizeInventoryList(document.getElementById('inventoryListBody'),'');
 });
 assert.equal(await page.locator('#inventoryListBody > tr > td').count(),7);assert.equal(await page.locator('#inventoryListBody .inventory-more-menu').count(),1);
 await page.getByRole('button',{name:'詳細資料',exact:true}).click();await page.locator('.inventory-detail-dialog[open]').waitFor();assert.match(await page.locator('.inventory-detail-dialog').innerText(),/LOT-1/);assert.match(await page.locator('.inventory-detail-dialog').innerText(),/分倉/);
 await page.locator('.inventory-detail-dialog button').first().click();await page.waitForFunction(()=>document.body.style.position!=='fixed');
 await page.locator('.inventory-more-menu > summary').click();await page.locator('.workspace-menu-dialog[open]').waitFor();assert.match(await page.locator('.workspace-menu-dialog header').innerText(),/試劑/);await page.getByRole('button',{name:'修改庫存',exact:true}).click();assert.equal(await page.evaluate(()=>adjustCalled),true);
 // Actual inventory renderer: filtering is presentation-only and cannot enable archive.
 await page.evaluate(html=>{const doc=new DOMParser().parseFromString(html,'text/html'),section=doc.getElementById('inventory-system');document.getElementById('appContainer').replaceChildren(section);section.classList.add('active');},read('index.html'));
 await page.addScriptTag({content:`
 const inventoryCache=[{id:'STOCK',itemCode:'CODE-1',itemName:'測試試劑',brand:'測試廠牌',productKey:'P'}],inventorySearchResults=[],inventorySearchActive=false;
 const warehouseStockCache=new Map([['MAIN||P',{}],['BRANCH||P',{}]]);
 const warehouseMasterCache=[{id:'MAIN',warehouseName:'主倉'},{id:'BRANCH',warehouseName:'分倉'}];
 const populateInventoryBrandFilter=()=>[],orderBrandFilterValue=x=>x,fefoLots=()=>[];
 const inventoryAggregateStock=()=>({onHand:12,reserved:1,available:11,incoming:2,rows:[{warehouse:warehouseMasterCache[0],n:{onHand:5,reserved:1,available:4,incoming:2}},{warehouse:warehouseMasterCache[1],n:{onHand:7,reserved:0,available:7,incoming:0}}]});
 const INVENTORY_STOCK_POLICIES={SAFETY_STOCK:'SAFETY_STOCK'},inventoryStockPolicy=()=> 'ORDER_ONLY',inventoryStockPolicyBadge=()=> '依訂單採購',inventoryReplenishmentPlan=(x,n)=>({projected:n.available+n.incoming,needsReplenishment:false});
 const productMasterForRecord=()=>null,inventoryLotViewState=()=>({complete:true}),inventoryLotCellHtml=()=> '批號 LOT-1';
 const canEditPage=()=>['admin','purchaser','warehouse'].includes(currentUserRole),canManageInventoryStockPolicy=()=>['admin','purchaser'].includes(currentUserRole),canManageInventoryList=()=>currentUserRole==='admin',activeInventoryWarehouses=()=>warehouseMasterCache;
 const inlineJsValue=x=>escapeAttr(JSON.stringify(x));
 globalThis.YushinInventory={isListArchived:()=>false,stockIsEmpty:x=>!(x.onHand||x.reserved||x.incoming)};
 `});
 const inventorySource=read('src/features/inventory/inventory-workspace.js');
 await page.addScriptTag({content:inventorySource.slice(inventorySource.indexOf('window.renderInventoryList=function()'),inventorySource.indexOf('window.openInventoryReplenishment ='))});
 await page.evaluate(()=>{currentUserRole='admin';renderInventoryList();});
 assert.equal(await page.locator('#inventoryListBody > tr > td').count(),7);
 assert.equal((await page.locator('#inventoryListBody td[data-th="現有庫存"]').innerText()).trim(),'12');
 await page.locator('#inventoryWarehouseFilter').selectOption('BRANCH');
 assert.equal((await page.locator('#inventoryListBody td[data-th="現有庫存"]').innerText()).trim(),'7');
 assert.equal((await page.locator('#inventoryListBody td[data-th="可用庫存"]').innerText()).trim(),'7');
 assert.equal(await page.locator('.inventory-action-archive').isDisabled(),true);
 await page.evaluate(()=>{warehouseStockCache.delete('BRANCH||P');renderInventoryList();});assert.match(await page.locator('#inventoryListBody td[data-th="現有庫存"]').innerText(),/待確認/);await page.evaluate(()=>{warehouseStockCache.set('BRANCH||P',{});renderInventoryList();});
 await page.locator('.inventory-details-toggle').click();await page.locator('.inventory-detail-dialog[open]').waitFor();assert.match(await page.locator('.inventory-detail-dialog').innerText(),/主倉/);assert.match(await page.locator('.inventory-detail-dialog').innerText(),/LOT-1/);assert.match(await page.locator('.inventory-detail-dialog').innerText(),/預計庫存/);await page.locator('.inventory-detail-dialog button').first().click();
 for(const role of ['sales','engineer','warehouse','purchaser','admin']){await page.evaluate(role=>{currentUserRole=role;renderInventoryList();},role);assert.equal(await page.locator('.inventory-action-quantity').count(),['admin','purchaser','warehouse'].includes(role)?1:0);}
 if(width===390)assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 if(process.env.WORKSPACE_SCREENSHOT_DIR){fs.mkdirSync(process.env.WORKSPACE_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.WORKSPACE_SCREENSHOT_DIR+'/inventory-'+width+'.png',fullPage:true});}
 assert.deepEqual(errors,[]);console.log('Four workspace changes '+width+'px: contextual modal lock/restore/action, own-profile save/failure, immutable old orders, compact inventory and retained lots passed.');await page.close();
}}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
