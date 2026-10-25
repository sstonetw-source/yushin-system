'use strict';
// Actual Chrome -> original login/actions -> Firebase browser SDK -> isolated
// Auth/Functions/Firestore. Component cases retain their presentation shell;
// full-site cases serve unchanged app.js and every original local module.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawnSync}=require('node:child_process'),{build}=require('esbuild'),{chromium}=require('playwright-core');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth}=require('firebase-admin/auth');
const {synchronizeV2OrderFixture}=require('./fixtures/v2-order-initialization.cjs');
const {orderCreationClient}=require('./fixtures/order-creation-client.cjs');
const {initializeApp:clientApp,deleteApp:deleteClientApp}=require('firebase/app');
const {getAuth:clientAuth,connectAuthEmulator,signInWithEmailAndPassword}=require('firebase/auth');
const {commitV2FormalPurchase}=require('../functions/formal-purchase-commit-service');
const root=path.resolve(__dirname,'..'),read=file=>fs.readFileSync(path.join(root,file),'utf8');
const section=(source,a,b)=>{const i=source.indexOf(a),j=source.indexOf(b,i);assert.ok(i>=0&&j>i,'original source boundaries');return source.slice(i,j);};
let app,db,auth,browser,host,origin,sdk;
const password='BrowserEmulatorOnly!123456';
test.before(async()=>{
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,'demo-yushin');
 for(const key of ['FIRESTORE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'])assert.match(process.env[key]||'',/^(127\.0\.0\.1|localhost):[0-9]+$/);
 app=admin.initializeApp({projectId:'demo-yushin'},'real-browser-lifecycle');db=getFirestore(app);auth=getAuth(app);
 const bundle=await build({entryPoints:[path.join(root,'tests/fixtures/v2-browser-firebase.mjs')],bundle:true,write:false,format:'iife',platform:'browser',target:'es2020',logLevel:'silent'});
 sdk=bundle.outputFiles[0].text;
 host=http.createServer((request,response)=>{
  const pathname=new URL(request.url,'http://localhost').pathname;
  if(pathname==='/site'){
   const html=read('index.html').replace(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.8\.0\/firebase-app-compat\.js/g,'/sdk.js')
    .replace(/https:\/\/www\.gstatic\.com\/firebasejs\/10\.8\.0\/firebase-(?:firestore|auth)-compat\.js/g,'/sdk-ready.js')
    .replace('https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js','/vendor/html2canvas.js')
    .replace('https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js','/vendor/jspdf.js');
   response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(html);return;
  }
  if(pathname==='/sdk-ready.js'){response.writeHead(200,{'Content-Type':'application/javascript'});response.end('// Real compat Auth/Firestore already included in sdk.js.');return;}
  const vendor={'/vendor/html2canvas.js':'html2canvas/dist/html2canvas.min.js','/vendor/jspdf.js':'jspdf/dist/jspdf.umd.min.js'}[pathname];
  if(vendor){response.writeHead(200,{'Content-Type':'application/javascript'});response.end(fs.readFileSync(require.resolve(vendor)));return;}
  if(request.url==='/sdk.js'){response.writeHead(200,{'Content-Type':'application/javascript'});response.end(sdk);return;}
  if(/^\/(app\.js|styles\.css|modules\/[\w.-]+\.js|assets\/[\w./-]+)$/.test(pathname)){
   const file=path.resolve(root,'.'+pathname);
   if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
    response.writeHead(200,{'Content-Type':({'.js':'application/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'})[path.extname(file)]||'application/octet-stream'});
    response.end(fs.readFileSync(file));return;
   }
  }
  if(pathname!=='/'){response.writeHead(404);response.end();return;}
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});response.end(harness());
 });
 await new Promise(resolve=>host.listen(0,'127.0.0.1',resolve));origin='http://127.0.0.1:'+host.address().port;
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(name=>spawnSync('which',[name],{encoding:'utf8'})).find(result=>result.status===0)?.stdout.trim();
 assert.ok(executablePath,'Real Chrome required');browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
});
test.after(async()=>{if(browser)await browser.close();if(host)await new Promise(resolve=>host.close(resolve));if(app)await app.delete();});
function harness(){
 const index=read('index.html'),login=section(index,'    <div id="loginScreen"','    <!-- ============ 修改密碼視窗');
 const panel=section(index,'      <section class="panel no-print" id="freeStockRecoveryPanel"','<div id="inventoryStockPanel">');
 return '<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css">'
  +login+'<main id="testApp" hidden><div id="testIdentity"></div><div id="feedback" role="status"></div><div id="orderButtons"></div><div id="inventory-system" class="content-section active">'+panel+'</div></main><script src="/sdk.js"></script></html>';
}
async function seed(width,prefix='browser'){
 const tag=prefix+width,sourceId=tag+'-source',productKey=tag+'-product',warehouseIds=[tag+'-A',tag+'-B'];
 const accounts={};
 for(const role of ['sales','warehouse','purchaser','engineer','admin']){
  const uid=tag+'-'+role,email=uid+'@example.test';await auth.createUser({uid,email,password});
  await db.collection('users').doc(uid).set({role,active:true,name:role,email,code:role==='sales'?'B':role});accounts[role]={uid,email};
 }
 const batch=db.batch(),put=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 put('products',productKey,{productType:'Goods',productId:productKey,itemCode:tag+'-code',model:tag+'-code',brand:'Roche',nameCn:'驗收試劑'});put('inventory',productKey,{productKey,onHand:12,reserved:0,transferFreeInTransit:0});
 for(const warehouseId of warehouseIds){
  put('warehouses',warehouseId,{active:true,warehouseName:warehouseId});
  put('warehouseStocks',warehouseId+'__'+productKey,{warehouseId,productKey,onHand:6,reserved:0,transferFreeInTransit:0});
  put('inventoryLots',tag+'-lot-'+warehouseId,{productKey,warehouseId,receivedQty:6,remainingQty:6,lotNo:tag,expiryDate:'2028-01-01'});
 }
 await batch.commit();
 const create=async(orderId,qty,itemId)=>{
  await db.collection('orders').doc(orderId).set({orderNo:orderId,customerName:'整站驗收客戶',ownerUid:accounts.sales.uid,salesCode:'B',status:'active',orderStatus:'normal',orderDate:'2026-01-01',
   inventoryReservationStatus:'pending',inventoryReservationAttemptId:'browser_sync_'+orderId,deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
   items:[{itemId,productId:productKey,itemCode:tag+'-code',itemName:'驗收試劑',brand:'Roche',unitPrice:100,qty,warehouseId:warehouseIds[0],reservedQty:0,deliveredQty:0,returnedQty:0,dispatchPreparedQty:0,warehouseShippedQty:0,
    fulfillmentType:'WAREHOUSE',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'測試客戶',phone:'02-12345678',address:'測試地址'}}]});
  await synchronizeV2OrderFixture(db,accounts.sales.uid,{orderId,warehouseIds});
 };
 await create(sourceId,12,'S');
 const targets=[];for(let i=0;i<7;i++){const id=tag+'-target-'+i;await create(id,1,'T');targets.push(id);}
 return {sourceId,productKey,warehouseIds,accounts,targets};
}
async function open(page,fixture){
 await page.goto(origin+'/');
 const role=read('src/app/role-capabilities.js'),workspace=read('src/features/orders/order-workspace.js');
 await page.addScriptTag({content:`
  firebase.initializeApp({apiKey:'fake-api-key',authDomain:'demo-yushin.firebaseapp.com',projectId:'demo-yushin',appId:'browser-lifecycle-test'});
  firebase.auth().useEmulator('http://127.0.0.1:9099',{disableWarnings:true});
  const db=firebase.firestore();db.settings({experimentalForceLongPolling:true});db.useEmulator('127.0.0.1',8080);
  let currentUser=null,currentUserRole='',trueUserRole='',currentUserName='',currentUserPhone='',currentUserCode='',mustChangePassword=false;
  let ordersCache=[],pendingLifecycleOrderIds=new Set(),currentDeliveryOrderId=null;
  const sourceId=${JSON.stringify(fixture.sourceId)};
  globalThis.YUSHIN_V2_LIFECYCLE_EMULATOR=true;globalThis.YUSHIN_V2_RECOVERY_EMULATOR=true;
  const readCachedUserProfile=()=>null,writeCachedUserProfile=()=>{},requestHomeScreenStoragePersistence=()=>{},firestoreReadWithTimeout=p=>p;
  const canEditPage=key=>key==='orders.list'&&canManageOrderLifecycleCapability(),canAccessPage=key=>key==='inventory'&&canReceiveInventoryCapability();
  const normalizedOrderStatus=o=>o.orderStatus,normalizedOrderItems=o=>o.items,inventoryProductKey=i=>i.inventoryProductKey||i.productId;
  const deliveryProgressInfo=o=>({remaining:o.items.reduce((sum,i)=>sum+i.qty-(i.deliveredQty||0),0),delivered:o.deliveredQty||0});
  const escapeHtml=s=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const inlineJsValue=s=>JSON.stringify(s).replaceAll('"','&quot;'),localDateString=()=> '2026-10-20';
  const syncOrderIntoPurchasingCaches=()=>{},writeAppDataCache=()=>{},invalidateWarehouseStockCache=()=>{},invalidateProcurementDemandQueue=()=>{},markMainPageDirty=()=>{};
  const renderDeliveryModal=()=>{},renderOrderLifecycleModal=()=>{};
  const warehouseMasterCache=${JSON.stringify(fixture.warehouseIds.map(id=>({id,warehouseName:id})))};
  const showActionFeedback=message=>{document.getElementById('feedback').textContent=message;};
  const beginActionButton=b=>{const state={text:b.textContent};b.disabled=true;return state;},endActionButton=(b,s)=>{b.disabled=false;b.textContent=s.text;};
  const refreshAffectedOrderCaches=async ids=>{for(const id of ids)await db.collection('orders').doc(id).get({source:'server'});};
  const renderOrdersList=()=>{document.getElementById('orderButtons').innerHTML=ordersCache.length?orderLifecycleActionButtons(ordersCache[0],{status:normalizedOrderStatus(ordersCache[0])},deliveryProgressInfo(ordersCache[0]),{}):'';};
  const showApp=()=>{document.getElementById('loginScreen').style.display='none';document.getElementById('testApp').hidden=false;document.getElementById('testIdentity').textContent=currentUserRole;};
  window.authReady=false;
 `});
 await page.addScriptTag({content:section(role,'function hasBusinessCapability(','function canConfirmSupplyReceipt(')
  +section(read('src/app/bootstrap.js'),'function applyUserProfile(','const DEFAULT_LIST_LIMIT')
  +section(role,'window.handleLogin =','window.handleLogout =')});
 await page.addScriptTag({content:read('src/services/order-lifecycle.js')});
 await page.addScriptTag({content:section(workspace,'function orderLifecycleActionButtons(','// Only a fully ready')});
 await page.addScriptTag({content:section(read('src/features/orders/lifecycle-workspace.js'),'function confirmOrderCancellation(','window.toggleOrderProgressStatus')});
 await page.addScriptTag({content:read('modules/free-stock-recovery.js')});
 await page.evaluate(()=>{
  const original=window.retryFreeStockRecovery;window.completedRecoveryClicks=0;
  window.retryFreeStockRecovery=async(...args)=>{try{return await original(...args);}finally{window.completedRecoveryClicks++;}};
 });
 await page.evaluate(async()=>{
  await new Promise(resolve=>{const unsubscribe=firebase.auth().onAuthStateChanged(()=>{unsubscribe();resolve();});});
  currentUser=firebase.auth().currentUser;
  if(currentUser){const profile=await db.collection('users').doc(currentUser.uid).get({source:'server'});applyUserProfile(profile.data());showApp();}
  else document.getElementById('loginScreen').style.display='';
  window.authReady=true;
 });
}
async function login(page,account){
 await page.fill('#loginEmail',account.email);await page.fill('#loginPassword',password);await page.locator('#loginScreen button').click();
 await page.waitForFunction(()=>!document.getElementById('testApp').hidden);
 assert.equal(await page.evaluate(()=>firebase.auth().currentUser.uid),account.uid);
}
async function loadOrder(page){await page.evaluate(async()=>{const snap=await db.collection('orders').doc(sourceId).get({source:'server'});ordersCache=[{id:sourceId,...snap.data()}];renderOrdersList();});}
async function loadSourceRows(page,productKey){
 await page.evaluate(()=>loadFreeStockRecovery());
 for(let pageNumber=0;pageNumber<20;pageNumber++){
  if(!await page.locator('#freeStockRecoveryMore').isVisible())break;
  await page.locator('#freeStockRecoveryMore').click();
 }
 const rows=page.locator('#freeStockRecoveryBody tr').filter({hasText:productKey});if(await rows.count())return rows;
 assert.fail('cancelled source did not appear in bounded recovery panel');
}
async function facts(fixture){
 const readDoc=async(name,id)=>(await db.collection(name).doc(id).get()).data();
 return {source:await readDoc('orders',fixture.sourceId),inventory:await readDoc('inventory',fixture.productKey),
  stocks:await Promise.all(fixture.warehouseIds.map(id=>readDoc('warehouseStocks',id+'__'+fixture.productKey))),
  lots:(await db.collection('inventoryLots').where('productKey','==',fixture.productKey).get()).docs.map(d=>({id:d.id,...d.data()})),
  targets:await Promise.all(fixture.targets.map(id=>readDoc('orders',id)))};
}
for(const width of [1280,390])test('real browser '+width+'px original login cancellation reload and logistics handoff',{timeout:180000},async()=>{
 const fixture=await seed(width),context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage(),errors=[],external=[],calls=[],dialogs=[];
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{dialogs.push({type:dialog.type(),message:dialog.message()});return dialog.type()==='confirm'?dialog.accept():dialog.dismiss();});
 let loseCancel=true,loseRecovery=true;
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['127.0.0.1','localhost'].includes(url.hostname)){external.push(url.hostname);await route.abort();return;}
  if(url.port==='5001'&&request.method()==='POST'){
   const name=url.pathname.split('/').at(-1),data=request.postDataJSON().data;
   assert.ok((await request.allHeaders()).authorization?.startsWith('Bearer '),'browser SDK sends actual Auth token');
   assert.equal(data.actorUid,undefined);assert.equal(data.actorRole,undefined);calls.push({name,data});
   if((name==='setV2OrderLifecycle'&&loseCancel)||(name==='resumeV2FreeStockRecovery'&&loseRecovery)){
    const reply=await route.fetch();assert.equal(reply.status(),200);
    if(name==='setV2OrderLifecycle')loseCancel=false;else loseRecovery=false;
    await route.abort('failed');return;
   }
  }
  await route.continue();
 });
 try{
  await open(page,fixture);await login(page,fixture.accounts.sales);await loadOrder(page);const before=await facts(fixture);
  console.log('Browser '+width+'px: original seller login completed.');
  await page.locator('#orderButtons button').filter({hasText:'取消訂單'}).click();
  await page.waitForFunction(()=>!pendingLifecycleOrderIds.size);
  assert.equal(await page.evaluate(()=>!!pendingV2OrderLifecycle(sourceId)),true,JSON.stringify(dialogs));
  assert.equal((await facts(fixture)).source.orderStatus,'cancelled');
  const operation=await page.evaluate(()=>pendingV2OrderLifecycle(sourceId).operationId);
  await open(page,fixture);assert.equal(await page.evaluate(()=>currentUserRole),'sales');await loadOrder(page);
  await page.locator('#orderButtons button').filter({hasText:'確認前次取消／恢復結果'}).click();
  await page.waitForFunction(()=>!pendingV2OrderLifecycle(sourceId));assert.match(await page.locator('#feedback').textContent(),/取消已完成/);
  const cancellation=calls.filter(row=>row.name==='setV2OrderLifecycle');assert.deepEqual(cancellation[0].data,cancellation[1].data);
  assert.equal(cancellation[0].data.operationId,operation);
  console.log('Browser '+width+'px: committed cancellation reconciled after lost HTTP reply and reload.');
  await page.evaluate(()=>loadFreeStockRecovery());assert.equal(await page.locator('#freeStockRecoveryPanel').isVisible(),false);
  const salesDenied=await page.evaluate(async()=>{try{await firebase.app().functions('asia-east1').httpsCallable('listV2FreeStockRecovery')({});return '';}catch(error){return error.code;}});
  assert.equal(salesDenied,'functions/permission-denied');
  await page.evaluate(()=>firebase.auth().signOut());await open(page,fixture);await login(page,fixture.accounts.warehouse);
  const canceled=await facts(fixture),rows=await loadSourceRows(page,fixture.productKey);assert.deepEqual(await facts(fixture),canceled);
  assert.equal(rows?await rows.count():0,2);const first=rows.first().locator('button');await first.click();
  await page.waitForFunction(()=>document.getElementById('feedback').textContent.includes('配貨結果尚待確認'));
  const firstMovement=calls.find(row=>row.name==='resumeV2FreeStockRecovery').data.movementId;
  assert.equal((await facts(fixture)).targets.reduce((sum,row)=>sum+row.items[0].reservedQty,0),5);
  console.log('Browser '+width+'px: real warehouse login allocated five units before reply interruption.');
  await open(page,fixture);await loadSourceRows(page,fixture.productKey);
  assert.equal(await page.evaluate(()=>currentUserRole),'warehouse');
  await page.evaluate(()=>firebase.auth().signOut());await open(page,fixture);await login(page,fixture.accounts.purchaser);
  await loadSourceRows(page,fixture.productKey);
  for(let step=0;step<5;step++){
   if(!await page.locator('#freeStockRecoveryPanel').isVisible())break;
   const buttons=page.locator('#freeStockRecoveryBody tr').filter({hasText:fixture.productKey}).locator('button');
   if(!await buttons.count())break;
   assert.equal(await buttons.first().isEnabled(),true,await page.locator('#freeStockRecoveryBody').textContent());
   const previous=await page.evaluate(()=>completedRecoveryClicks);await buttons.first().click();
   await page.waitForFunction(count=>completedRecoveryClicks>count,previous);
  }
  assert.equal(await page.locator('#freeStockRecoveryBody tr:visible').filter({hasText:fixture.productKey}).count(),0,
   await page.locator('#freeStockRecoveryBody').textContent());
  const after=await facts(fixture);assert.equal(after.targets.reduce((sum,row)=>sum+row.items[0].reservedQty,0),7);
  assert.equal(after.inventory.onHand,before.inventory.onHand);assert.deepEqual(after.lots,before.lots);
  assert.deepEqual(after.stocks.map(row=>row.onHand),before.stocks.map(row=>row.onHand));
  assert.equal(after.source.orderLifecycleHistory.length,1);assert.equal(after.source.orderStatus,'cancelled');
  const batchId='single-v2-free-batch-source_v2_'+require('node:crypto').createHash('sha256').update(firstMovement).digest('hex').slice(0,40);
  const job=(await db.collection('reservationOperationReceipts').doc(batchId).get()).data();
  assert.equal(job.actorUid,fixture.accounts.purchaser.uid);assert.equal(job.handoffCount,1);assert.equal(job.status,'completed');
  const retries=calls.filter(row=>row.name==='resumeV2FreeStockRecovery'&&row.data.movementId===firstMovement);assert.ok(retries.length>=2);assert.deepEqual(retries[0].data,retries[1].data);
  await open(page,fixture);await page.evaluate(()=>loadFreeStockRecovery());
  for(let scan=0;scan<20&&await page.locator('#freeStockRecoveryMore').isVisible();scan++)await page.locator('#freeStockRecoveryMore').click();
  assert.equal(await page.locator('#freeStockRecoveryMore').isVisible(),false);
  assert.equal(await page.locator('#freeStockRecoveryBody tr:visible').filter({hasText:fixture.productKey}).count(),0);
  assert.deepEqual(await facts(fixture),after);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Browser '+width+'px: purchaser handoff, seven target holds, unchanged physical lots and idempotent reload passed.');
 }catch(error){
  console.log('Browser '+width+'px diagnostic:',JSON.stringify(await page.evaluate(()=>({feedback:document.getElementById('feedback')?.textContent,
   rows:document.getElementById('freeStockRecoveryBody')?.textContent,completedRecoveryClicks:window.completedRecoveryClicks}))));
  throw error;
 }finally{await context.close();}
});

async function siteOpen(page,role){
 await page.goto(origin+'/site');
 if(role){await page.locator('#appContainer').waitFor({state:'visible'});await page.waitForFunction(value=>currentUserRole===value,role);}
 else await page.locator('#loginScreen').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>APP_ENVIRONMENT),'emulator');
 assert.match(await page.locator('#previewEnvironmentBanner').textContent(),/本機 Emulator/);
}
async function siteLogin(page,account,role){
 await page.fill('#loginEmail',account.email);await page.fill('#loginPassword',password);await page.locator('#loginScreen button').click();
 await page.locator('#appContainer').waitFor({state:'visible'});await page.waitForFunction(value=>currentUserRole===value,role);
 assert.equal(await page.evaluate(()=>firebase.auth().currentUser.uid),account.uid);
}
async function siteLogout(page){
 await siteMenu(page);
 await page.locator('button[onclick="handleLogout()"]').click();await page.locator('#loginScreen').waitFor({state:'visible'});
}
async function siteMenu(page){
 const toggle=page.locator('.mobile-nav-toggle');
 if(await toggle.isVisible()){
  // Finish the original container's scroll/autocollapse before opening its menu.
  await page.evaluate(()=>document.getElementById('appContainer').scrollTo({top:0,behavior:'instant'}));
  await page.waitForFunction(()=>document.getElementById('appContainer').scrollTop===0);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  if(await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
  await page.waitForFunction(()=>document.querySelector('.nav-tabs').classList.contains('mobile-open'));
 }
}
async function siteNav(page,key){
 await siteMenu(page);
 await page.locator('.nav-tab[data-main-nav="'+key+'"]').click();
}

// Original unchanged GitHub-served app.js, real signed-in Auth and original
// pending-demand button/confirmation. No synthetic Service invocation.
for(const width of [1280,390])test('original Quick Purchase '+width+'px commits once through guarded demo Callable',{timeout:180000},async()=>{
 const fixture=await multiReceiptSiteFixture(width,'quick-original');
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}});
 const page=await context.newPage(),calls=[],errors=[],external=[];
 await context.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;window.YUSHIN_QUICK_PURCHASE_EMULATOR=true;});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('dialog',dialog=>dialog.accept());
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){external.push(url.hostname);await route.abort();return;}
  if(url.port==='5001'&&request.method()==='POST'&&url.pathname.endsWith('/commitV2QuickPurchase')){
   const payload=request.postDataJSON().data,headers=await request.allHeaders();
   assert.match(headers.authorization||'',/^Bearer /);
   assert.equal(payload.actorUid,undefined);assert.equal(payload.actorRole,undefined);
   calls.push(payload);
  }
  await route.continue();
 });
 try{
  await siteOpen(page);await siteLogin(page,fixture.accounts.purchaser,'purchaser');
  await siteNav(page,'purchasing');
  await page.waitForFunction(orderId=>document.getElementById('purchasePendingBody')?.textContent?.includes(orderId),fixture.orderId);
  const row=page.locator('#purchasePendingBody tr').filter({hasText:fixture.orderId}).filter({hasText:fixture.keys[0]}).first();
  await row.getByRole('button',{name:'已採購',exact:true}).click();
  await page.locator('#quickPurchaseConfirmationOverlay.active').waitFor({state:'visible'});
  assert.equal(await page.locator('#quickPurchaseQty').inputValue(),'3');
  await page.locator('#quickPurchaseSupplier').fill(fixture.supplierName);
  await page.locator('#quickPurchaseCost').fill('19.99');
  await page.locator('#quickPurchaseConfirmationOverlay button[onclick="confirmQuickPurchase()"]').click();
  await page.waitForFunction(()=>document.getElementById('actionFeedback')?.textContent?.includes('已採購，品項已列入待到貨'),null,{timeout:45000});
  assert.equal(calls.length,1,'original button must invoke exactly one authenticated Callable');
  const intent=calls[0],supplyId='manual-'+encodeURIComponent(fixture.orderId)+'-I1';
  assert.equal(intent.orderId,fixture.orderId);assert.equal(intent.itemId,'I1');
  assert.equal(intent.qty,3);assert.equal(intent.supplier,fixture.supplierName);assert.equal(intent.unitCost,19.99);
  assert.match(intent.operationId,/^qp-[A-Za-z0-9_-]{8,76}$/);
  const demandId=require('../modules/procurement-demand-core').demandIdForSource({
   sourceType:'SALES_ORDER',sourceId:fixture.orderId,sourceItemId:'I1'
  });
  const fetch=async(name,id)=>(await db.collection(name).doc(id).get()).data();
  const supply=await fetch('supplyOrders',supplyId),demand=await fetch('procurementDemands',encodeURIComponent(demandId));
  const order=await fetch('orders',fixture.orderId);
  const inventory=await fetch('inventory',fixture.keys[0]);
  const warehouse=await fetch('warehouseStocks',fixture.warehouses[0]+'__'+fixture.keys[0]);
  const other=await fetch('warehouseStocks',fixture.warehouses[1]+'__'+fixture.keys[0]);
  const movement=await fetch('inventoryMovements','quick-'+intent.operationId);
  assert.equal(supply.qty,3);assert.equal(supply.unitCost,19.99);
  assert.equal(demand.orderedQty,3);assert.equal(demand.remainingToOrderQty,0);
  assert.equal(order.items[0].supplyOrderedQty,3);assert.equal(order.items[1].supplyOrderedQty||0,0);
  assert.equal(inventory.incoming,3);assert.equal(warehouse.incoming,3);assert.equal(other.incoming,0);
  assert.equal(inventory.onHand,0);assert.equal(warehouse.onHand,0);
  assert.equal(movement.qty,3);assert.equal(movement.sourceId,supplyId);
  const checkpoint=await page.evaluate(({uid,orderId})=>
   sessionStorage.getItem('quick-purchase-pending:'+encodeURIComponent(uid)+':'+encodeURIComponent(orderId)+':I1'),
   {uid:fixture.accounts.purchaser.uid,orderId:fixture.orderId});
  assert.equal(checkpoint,null);
  const replay=await page.evaluate(async data=>(await firebase.app().functions('asia-east1').httpsCallable('commitV2QuickPurchase')(data)).data,intent);
  assert.equal(replay.status,'already-applied');assert.equal(replay.operationId,intent.operationId);
  assert.equal((await fetch('inventory',fixture.keys[0])).incoming,3);
  assert.equal((await fetch('warehouseStocks',fixture.warehouses[0]+'__'+fixture.keys[0])).incoming,3);
  assert.equal((await fetch('orders',fixture.orderId)).items[0].orderEvents.length,1);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Original Quick Purchase '+width+'px: purchaser, real UI/Callable, single supply/demand/incoming/movement and replay passed.');
 }finally{await context.close();}
});

for(const width of [1280,390])test('mixed service and Goods original UI '+width+'px: real delivery, completion, billing and lost reply',{timeout:180000},async()=>{
 const tag='mixed-ui-'+width,orderId=tag+'-order',orderNo='YS-'+tag,key=tag+'-goods',serviceKey=tag+'-service';
 const accounts={};
 for(const role of ['sales','warehouse','engineer']){
  const uid=tag+'-'+role,email=uid+'@example.test';await auth.createUser({uid,email,password});
  await db.doc('users/'+uid).set({role,active:true,name:role,email,code:uid});accounts[role]={uid,email};
 }
 const plan={mode:'CUSTOMER_SHIP',contact:'混合單客戶',phone:'02-12345678',address:'台北市驗收地址'};
 const goods={itemId:'G',productId:key,productType:'Goods',itemName:'混合單商品',qty:1,unitPrice:200,
  warehouseId:tag+'-A',fulfillmentType:'WAREHOUSE',deliveryPlan:plan,reservedQty:0,shortageQty:1,deliveredQty:0,returnedQty:0};
 const service={itemId:'S',productId:serviceKey,productType:'Service',serviceKind:'ONSITE_REPAIR',itemName:'現場維修',
  qty:1,unitPrice:100,fulfillmentType:'WAREHOUSE',warehouseId:'',deliveryPlan:{},reservationStatus:'not_required',
  reservedQty:0,shortageQty:0,deliveredQty:0,returnedQty:0};
 const syncAttemptId=tag+'-sync';
 const setup=db.batch();
 setup.set(db.doc('products/'+key),{productType:'Goods',active:true});
 setup.set(db.doc('products/'+serviceKey),{productType:'Service',serviceKind:'ONSITE_REPAIR',active:true});
 setup.set(db.doc('inventory/'+key),{productKey:key,onHand:1,reserved:0});
 for(const [suffix,onHand] of [['A',1],['B',0]]){
  const wh=tag+'-'+suffix;setup.set(db.doc('warehouses/'+wh),{active:true,name:wh});
  setup.set(db.doc('warehouseStocks/'+wh+'__'+key),{warehouseId:wh,productKey:key,onHand,reserved:0});
 }
 setup.set(db.doc('inventoryLots/'+tag+'-lot'),{productKey:key,warehouseId:tag+'-A',receivedQty:1,remainingQty:1,lotNo:'MIX',receivedAt:'2026-10-24T08:00:00Z'});
 setup.set(db.doc('orders/'+orderId),{orderNo,customerName:'混合單客戶',ownerUid:accounts.sales.uid,salesCode:accounts.sales.uid,
  salesName:'sales',status:'active',orderStatus:'normal',orderDate:'2026-10-24',inventoryReservationStatus:'pending',
  inventoryReservationAttemptId:syncAttemptId,orderSchemaVersion:2,itemCount:2,items:[service,goods],totalPrice:300,
  productIds:[serviceKey,key],deliveryRecords:[],returnRecords:[],deliveredQty:0,isDelivered:false,isBilled:false});
 await setup.commit();
 // Source and initialization checkpoint are explicit fixtures. The original
 // reservation, paperwork and physical shipment Services create real proofs.
 await require('../functions/single-item-location-service').commitOrderTwoWarehouse(db,accounts.sales.uid,
  {orderId,itemIds:['S','G'],warehouseIds:[tag+'-A',tag+'-B'],attemptId:tag+'-reserve',syncAttemptId});
 await db.doc('orders/'+orderId).update({inventoryReservationStatus:'completed'});
 await require('../functions/location-dispatch-service').commitLocationDispatchPreparation(db,accounts.warehouse.uid,
  {orderId,itemId:'G',quantity:1,operationId:tag+'-prepare',syncAttemptId});
 await require('../functions/location-shipment-service').commitLocationShipment(db,accounts.warehouse.uid,
  {orderId,itemId:'G',warehouseId:tag+'-A',quantity:1,operationId:tag+'-ship',syncAttemptId,date:'2026-10-24',expectedPlan:plan});
 const physical=async()=>{
  const result={};for(const name of ['inventory','warehouseStocks','inventoryLots','inventoryMovements','inventoryReservations'])
   result[name]=(await db.collection(name).where('productKey','==',key).get()).docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id));
  return result;
 };
 const stock=await physical(),context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}}),page=await context.newPage(),dialogs=[];
 let lose=true;const billingCalls=[];
 await page.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;window.YUSHIN_SERVICE_CASE_EMULATOR=true;window.YUSHIN_V2_DELIVERY_EMULATOR=true;});
 page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){await route.abort();return;}
  if(url.port==='5001'&&request.method()==='POST'&&url.pathname.endsWith('/commitServiceOrderBilling')){
   billingCalls.push(request.postDataJSON().data);
   if(lose&&billingCalls.at(-1).operationId!==billingCalls[0]?.operationId){lose=false;const result=await route.fetch();assert.equal(result.status(),200);await route.abort('failed');return;}
  }
  await route.continue();
 });
 try{
  await siteOpen(page);await siteLogin(page,accounts.sales,'sales');
  await siteOrderAction(page,{sourceId:orderNo},'分批交貨');
  await page.locator('#deliveryFormPanel').waitFor({state:'visible'});
  await page.locator('#deliveryItemId').selectOption('G');await page.locator('#deliveryShipmentId').selectOption(tag+'-ship');
  await page.locator('#deliveryDate').fill('2026-10-24');await page.locator('#deliveryQty').fill('1');
  await page.locator('#deliveryFormPanel button[onclick="saveDeliveryRecord()"]').click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.has(id)&&ordersCache.find(o=>o.id===id)?.deliveredQty===1,orderId);
  await page.locator('#deliveryModalOverlay button[onclick="closeDeliveryModal()"]').click();
  const row=page.locator('#ordersBody > tr').filter({hasText:orderNo});
  await row.getByRole('button',{name:'核銷',exact:true}).click();await page.waitForFunction(()=>!pendingOrderStatusKeys.size);
  assert.equal((await db.doc('orders/'+orderId).get()).data().isBilled,false);assert.ok(dialogs.some(s=>s.includes('尚未全數完成')));
  await siteLogout(page);await siteLogin(page,accounts.engineer,'engineer');await siteNav(page,'orders');
  await page.locator('#serviceCaseEntry').click();await page.locator('#serviceOrderNo').fill(orderNo);
  await page.locator('button[onclick="findServiceCaseOrder()"]').click();await page.locator('#serviceNewCaseId').waitFor({state:'visible'});
  await page.locator('#serviceEvidence').fill('客戶現場校正完成');await page.locator('#serviceNewCaseId').fill('MIX-REPAIR');
  await page.locator('#serviceNewQty').fill('1');await page.locator('#serviceCaseSave').click();
  await page.waitForFunction(()=>!serviceCaseView?.busy&&document.getElementById('serviceCaseMessage')?.textContent==='服務操作已確認。');
  assert.deepEqual((await db.doc('orders/'+orderId).get()).data().workCategories,['billing']);
  await page.locator('button[onclick="closeServiceCases()"]').click();await siteLogout(page);await siteLogin(page,accounts.sales,'sales');await siteNav(page,'orders');
  await row.getByRole('button',{name:'核銷',exact:true}).click();
  await page.waitForFunction(()=>!pendingOrderStatusKeys.size&&!!pendingServiceBillingIntent());
  const original=billingCalls.at(-1);assert.equal((await db.doc('orders/'+orderId).get()).data().isBilled,true);
  await siteOpen(page,'sales');await siteNav(page,'orders');const count=billingCalls.length;
  await row.getByRole('button',{name:/^(核銷|已核銷)$/}).click();await page.waitForFunction(()=>!pendingOrderStatusKeys.size&&!pendingServiceBillingIntent());
  assert.equal(billingCalls.length,count+1);assert.deepEqual(billingCalls.at(-1),original);
  const done=(await db.doc('orders/'+orderId).get()).data();assert.deepEqual(done.workCategories,['complete']);
  assert.equal(done.items[0].deliveredQty,0);assert.equal(done.deliveredQty,1);assert.equal(done.statusHistory.length,1);
  assert.deepEqual(await physical(),stock,'delivery, service completion and billing do not repeat physical debit');
  assert.equal((await db.doc('inventory/'+serviceKey).get()).exists,false);
 }finally{await context.close();}
});

for(const width of [1280,390])test('original service case UI '+width+'px: four kinds, role handoff and immutable lost-reply recovery',async()=>{
 const tag='service-ui-'+width,orderId=tag+'-order',orderNo='YS-'+tag,accounts={};
 const kinds=['PIPETTE_CALIBRATION','BIOPLEX_LAB','TISSUE_SLICING','ONSITE_REPAIR'];
 for(const role of ['sales','warehouse','engineer','other']){
  const uid=tag+'-'+role,email=uid+'@example.test';await auth.createUser({uid,email,password});
  await db.doc('users/'+uid).set({role:role==='other'?'sales':role,active:true,name:role,email,code:uid});accounts[role]={uid,email};
 }
 const items=kinds.map(kind=>({itemId:kind,productId:tag+'-'+kind,productType:'Service',serviceKind:kind,
  itemName:kind,qty:2,unitPrice:100,reservedQty:0,shortageQty:0,deliveredQty:0,returnedQty:0,
  fulfillmentType:'WAREHOUSE',warehouseId:'',deliveryPlan:{},reservationStatus:'not_required'}));
 for(const item of items)await db.doc('products/'+item.productId).set({active:true,productType:'Service',serviceKind:item.serviceKind});
 // Existing initialized source fixture; original creation/initialization is covered separately.
 const order={orderNo,customerName:tag+'客戶',ownerUid:accounts.sales.uid,salesCode:accounts.sales.uid,
  salesName:'sales',status:'active',orderStatus:'normal',orderDate:new Date().toISOString().slice(0,10),
  inventoryReservationStatus:'completed',inventoryReservationAttemptId:tag+'-sync',
  orderSchemaVersion:2,itemCount:items.length,items,totalPrice:800,productIds:items.map(i=>i.productId),
  deliveryRecords:[],returnRecords:[],deliveredQty:0,isDelivered:false,isBilled:false};
 await db.doc('orders/'+orderId).set(order);
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}}),page=await context.newPage();
 const calls=[],errors=[],external=[],serviceDialogs=[];let lose=true,lookupGate=null,billingLose=false;const billingCalls=[];
 await context.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;window.YUSHIN_SERVICE_CASE_EMULATOR=true;});
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>{serviceDialogs.push(d.message());return d.dismiss();});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){external.push(url.hostname);await route.abort();return;}
  if(lookupGate&&url.port==='5001'&&request.method()==='POST'&&url.pathname.endsWith('/getServiceCaseStatus')
    &&request.postDataJSON().data.orderNo){
   const gate=lookupGate;lookupGate=null;gate.arrived();await gate.released;
  }
  if(url.port==='5001'&&request.method()==='POST'&&url.pathname.endsWith('/commitServiceOrderBilling')){
   assert.ok((await request.allHeaders()).authorization?.startsWith('Bearer '));
   billingCalls.push(request.postDataJSON().data);
   if(billingLose){billingLose=false;const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');return;}
  }
  if(url.port==='5001'&&request.method()==='POST'&&url.pathname.endsWith('/commitServiceCaseEvent')){
   assert.ok((await request.allHeaders()).authorization?.startsWith('Bearer '));
   calls.push(request.postDataJSON().data);
   if(lose){lose=false;const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');return;}
  }
  await route.continue();
 });
 const item=async key=>{
  await page.locator('#serviceItemChoice').selectOption(key);
  await page.waitForFunction(key=>serviceCaseView?.data?.itemId===key,key);
 };
 const start=async(caseId,qty=1)=>{
  await page.locator('#serviceNewCaseId').fill(caseId);await page.locator('#serviceNewQty').fill(String(qty));
  await page.locator('#serviceCaseSave').click();
 };
 const confirmed=()=>page.waitForFunction(()=>!serviceCaseView?.busy&&document.getElementById('serviceCaseMessage')?.textContent==='服務操作已確認。',null,{timeout:45000});
 const advance=async(caseId,evidence)=>{
  await page.locator('#serviceCaseChoice').selectOption(caseId);
  if(evidence)await page.locator('#serviceEvidence').fill(evidence);
  await page.locator('#serviceCaseSave').click();await confirmed();
 };
 const openByNumber=async()=>{
  await siteNav(page,'orders');await page.locator('#serviceCaseEntry').click();
  await page.locator('#serviceOrderNo').fill(orderNo);
  await page.locator('button[onclick="findServiceCaseOrder()"]').click();
  await page.waitForFunction(()=>!!serviceCaseView?.data,null,{timeout:45000});
 };
 const switchRole=async role=>{
  await page.locator('button[onclick="closeServiceCases()"]').click();await siteLogout(page);
  await siteLogin(page,accounts[role],role==='other'?'sales':role);
 };
 try{
  await siteOpen(page);await siteLogin(page,accounts.sales,'sales');await siteNav(page,'orders');
  const row=page.locator('#ordersBody > tr').filter({hasText:tag+'客戶'});await row.waitFor({state:'visible'});
  await row.getByRole('button',{name:'服務案件',exact:true}).click();
  await page.locator('#serviceNewCaseId').waitFor({state:'visible'});
  // Delay the real authorized HTTP lookup, leaving the original handlers intact.
  await page.locator('#serviceNewCaseId').fill('OLD-CASE');await page.locator('#serviceNewQty').fill('1');
  let arrived,release;const requested=new Promise(resolve=>arrived=resolve),released=new Promise(resolve=>release=resolve);
  lookupGate={arrived,released};
  try{
   await page.locator('#serviceOrderNo').fill('MISSING-'+tag);
   await page.locator('button[onclick="findServiceCaseOrder()"]').click();await requested;
   assert.equal(await page.locator('#serviceCaseSave').count(),0);
   assert.equal(await page.locator('#serviceItemChoice').isDisabled(),true);
   await page.evaluate(()=>saveServiceCaseAction());assert.equal(calls.length,0);
  }finally{release();}
  await page.waitForFunction(()=>!serviceCaseView?.orderLookup&&document.getElementById('serviceCaseMessage')?.textContent.includes('不存在'));
  await page.evaluate(()=>saveServiceCaseAction());assert.equal(calls.length,0);
  await page.locator('#serviceOrderNo').fill(orderNo);await page.locator('button[onclick="findServiceCaseOrder()"]').click();
  await page.locator('#serviceNewCaseId').waitFor({state:'visible'});await start('PIP-001',2);
  await page.locator('#serviceCaseRetry').waitFor({state:'visible'});
  const first=calls[0];assert.ok(first.event.id);assert.equal(first.serviceQty,2);
  await siteOpen(page,'sales');await siteNav(page,'orders');await page.locator('#serviceCaseEntry').click();
  await page.locator('#serviceCaseRetry').waitFor({state:'visible'});assert.equal(calls.length,1,'reload never resubmits');
  await page.locator('#serviceCaseRetry').click();await confirmed();
  assert.deepEqual(calls[1],first);
  const {caseDocId}=require('../functions/service-case-service');
  assert.equal((await db.doc('serviceCases/'+caseDocId(orderId,kinds[0],'PIP-001')).get()).data().events.length,1);
  // Recovery shows the original item; select the next service using original controls.
  await page.locator('button[onclick="closeServiceCases()"]').click();await openByNumber();
  await item('BIOPLEX_LAB');await start('BIO-001');await confirmed();
  await item('TISSUE_SLICING');await start('TIS-001',2);await confirmed();
  await switchRole('warehouse');await openByNumber();
  await advance('PIP-001','委外校正公司');await advance('PIP-001');
  await item('TISSUE_SLICING');await advance('TIS-001','組織代工公司');await advance('TIS-001');
  await switchRole('engineer');await openByNumber();
  await item('BIOPLEX_LAB');await advance('BIO-001');await advance('BIO-001','REPORT-001');
  await item('ONSITE_REPAIR');await page.locator('#serviceEvidence').fill('設備校正完成');await start('FIX-001',2);await confirmed();
  await switchRole('sales');await openByNumber();await advance('PIP-001','客戶王先生');
  await item('TISSUE_SLICING');await advance('TIS-001','DELIVERY-001');
  const bounds=await page.locator('#serviceCaseOverlay .modal').boundingBox();assert.ok(bounds.x>=0&&bounds.width<=width);
  assert.equal(await page.locator('#serviceCaseOverlay .modal').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  for(const [kind,id] of [[kinds[0],'PIP-001'],[kinds[1],'BIO-001'],[kinds[2],'TIS-001'],[kinds[3],'FIX-001']]){
   const saved=(await db.doc('serviceCases/'+caseDocId(orderId,kind,id)).get()).data();
   assert.equal(saved.status,'COMPLETED');assert.equal(saved.serviceQty,kind==='BIOPLEX_LAB'?1:2);
   await item(kind);
   const summary=await page.locator('#serviceItemBody').textContent();
   assert.ok(summary.includes(kind==='BIOPLEX_LAB'?'待服務處理':'服務完成・待核銷'));
  }
  const {workCategories:partialCategories,workCategoryUpdatedAt:partialUpdatedAt,...partialFacts}=
   (await db.doc('orders/'+orderId).get()).data();
  assert.deepEqual(partialCategories,['billing','delivery'],'completed siblings coexist with outstanding Bio-Plex work');
  assert.ok(Number.isFinite(Date.parse(partialUpdatedAt)),'verified event timestamps the work index');
  assert.deepEqual(partialFacts,order,'case UI only updates the work index, never stock/delivery/billing order facts');
  for(const entry of items)assert.equal((await db.doc('inventory/'+entry.productId).get()).exists,false);
  assert.equal((await db.collection('supplyOrders').where('sourceId','==',orderId).get()).size,0);
  // Read the original server endpoint once, then show each sibling's progress
  // beneath that exact product in the original desktop/mobile order renderer.
  await page.locator('#verifyServiceOrderButton').click();
  await page.waitForFunction(()=>!!serviceCaseView?.summary);
  const productLines=row.locator('.order-product-cell > div');
  for(const entry of items){
   const line=productLines.filter({hasText:entry.itemName});
   const hint=await line.locator('.service-case-verified-hint').textContent();
   assert.ok(hint.includes(entry.itemId==='BIOPLEX_LAB'?'1/2':'2/2'));
   assert.ok(hint.includes(entry.itemId==='BIOPLEX_LAB'?'待服務處理':'服務完成・待核銷'));
  }
  assert.equal(await row.locator('.order-money-cell .service-case-verified-hint').count(),0);
  // The original billing button must reject the still-partial Bio-Plex work.
  await page.locator('button[onclick="closeServiceCases()"]').click();
  await row.getByRole('button',{name:'核銷',exact:true}).click();
  await page.waitForFunction(()=>!pendingOrderStatusKeys.size);
  assert.equal((await db.doc('orders/'+orderId).get()).data().isBilled,false);
  assert.ok(serviceDialogs.some(message=>message.includes('尚未全數完成')));
  // Finish the remaining commercial quantity through the original case UI.
  await openByNumber();await item('BIOPLEX_LAB');await start('BIO-002');await confirmed();
  await switchRole('engineer');await openByNumber();await item('BIOPLEX_LAB');
  await advance('BIO-002');await advance('BIO-002','REPORT-002');
  const {workCategories:completedCategories,workCategoryUpdatedAt:completedUpdatedAt,...completedFacts}=
   (await db.doc('orders/'+orderId).get()).data();
  assert.deepEqual(completedCategories,['billing'],'all commercial service quantity completed before billing');
  assert.ok(Number.isFinite(Date.parse(completedUpdatedAt)));
  assert.deepEqual(completedFacts,order,'completion classification does not perform delivery or billing');
  await switchRole('sales');await openByNumber();
  await page.locator('button[onclick="closeServiceCases()"]').click();
  billingLose=true;
  await row.getByRole('button',{name:'核銷',exact:true}).click();
  await page.waitForFunction(()=>!pendingOrderStatusKeys.size&&!!pendingServiceBillingIntent());
  const billingFirst=billingCalls.at(-1);
  assert.equal((await db.doc('orders/'+orderId).get()).data().isBilled,true);
  await siteOpen(page,'sales');await siteNav(page,'orders');
  assert.equal(billingCalls.length,2,'reload does not send the pending billing operation');
  await row.getByRole('button',{name:/^(核銷|已核銷)$/}).click();
  await page.waitForFunction(()=>!pendingOrderStatusKeys.size&&!pendingServiceBillingIntent());
  assert.deepEqual(billingCalls.at(-1),billingFirst);
  let billed=(await db.doc('orders/'+orderId).get()).data();
  assert.equal(billed.statusHistory.filter(e=>e.field==='isBilled').length,1);
  assert.deepEqual(billed.workCategories,['complete']);
  // The original date editor is inside a collapsed details panel. Open it as a user would.
  // Date correction still uses the same Callable and recovery checkpoint; no new writer.
  await row.locator('details.order-detail-panel > summary').click();
  const dateEdit=row.locator('input[aria-label="核銷日期"]');assert.equal(await dateEdit.isDisabled(),false);
  const correctedBillingDate=new Date(Date.parse(billed.billingDate+'T00:00:00Z')-86400000).toISOString().slice(0,10);
  billingLose=true;await dateEdit.fill(correctedBillingDate);
  await page.waitForFunction(()=>!pendingOrderStatusKeys.size&&pendingServiceBillingIntent()?.intent.action==='CHANGE_DATE');
  assert.equal(await row.getByRole('button',{name:'已核銷',exact:true}).isDisabled(),false);
  const dateFirst=billingCalls.at(-1);assert.equal(dateFirst.expectedIsBilled,true);
  assert.equal((await db.doc('orders/'+orderId).get()).data().billingDate,correctedBillingDate);
  const beforeReloadCalls=billingCalls.length;
  await siteOpen(page,'sales');await siteNav(page,'orders');assert.equal(billingCalls.length,beforeReloadCalls);
  // The original billing button confirms the pending date, never changes its intent.
  await row.getByRole('button',{name:'已核銷',exact:true}).click();
  await page.waitForFunction(()=>!pendingOrderStatusKeys.size&&!pendingServiceBillingIntent());
  assert.deepEqual(billingCalls.at(-1),dateFirst);
  const dateOrder=(await db.doc('orders/'+orderId).get()).data();
  assert.equal(dateOrder.fieldEditHistory.length,1);assert.equal(dateOrder.statusHistory.length,1);
  assert.equal(dateOrder.billingDate,correctedBillingDate);assert.equal(dateOrder.isBilled,true);
  assert.deepEqual(dateOrder.workCategories,['complete']);
  // A new click after confirmation is a distinct undo, with no inventory effect.
  await row.getByRole('button',{name:'已核銷',exact:true}).click();
  await page.waitForFunction(id=>!pendingOrderStatusKeys.size&&ordersCache.find(o=>o.id===id)?.isBilled===false,orderId);
  billed=(await db.doc('orders/'+orderId).get()).data();
  assert.equal(billed.isBilled,false);assert.equal(billed.statusHistory.length,2);
  assert.deepEqual(billed.workCategories,['billing']);
  assert.deepEqual(billed.items,order.items);assert.deepEqual(billed.deliveryRecords,[]);
  await page.locator('#serviceCaseEntry').click();
  await switchRole('other');await siteNav(page,'orders');await page.locator('#serviceCaseEntry').click();
  await page.locator('#serviceOrderNo').fill(orderNo);await page.locator('button[onclick="findServiceCaseOrder()"]').click();
  await page.waitForFunction(()=>document.getElementById('serviceCaseMessage').textContent.includes('權限'));
  assert.equal(await page.locator('#serviceItemChoice').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Original service UI '+width+'px: actual Auth, four service kinds, sales/warehouse/engineer handoff, minimal authorized order-number lookup, committed lost HTTP reply/reload/same-event proof and original billing refusal/full completion/lost reply/reload/same-ID receipt/date correction/undo with zero physical writes passed. Initialized order remains an explicit fixture boundary.');
 }catch(error){console.log('Service UI diagnostic',JSON.stringify(await page.evaluate(()=>({role:currentUserRole,message:document.getElementById('serviceCaseMessage')?.textContent,body:document.getElementById('serviceCaseBody')?.textContent}))),JSON.stringify({errors,dialogs:serviceDialogs}));throw error;}
 finally{await context.close();}
});
async function multiReceiptSiteFixture(width,prefix='multi-receipt'){
 const tag=prefix+'-'+width,orderId=tag+'-order',keys=[tag+'-P',tag+'-Q'],warehouses=[tag+'-A',tag+'-B'],accounts={};
 for(const role of ['purchaser','warehouse','sales']){
  const uid=tag+'-'+role,email=uid+'@example.test';await auth.createUser({uid,email,password});
  await db.collection('users').doc(uid).set({role,active:true,name:role,email,code:role==='sales'?'B':role});accounts[role]={uid,email};
 }
 const batch=db.batch(),put=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 const supplierId=tag+'-supplier',supplierName=tag+'供應商';
 put('suppliers',supplierId,{active:true,supplierId,supplierName,purchaseHeaderName:supplierName,email:'',leadTimeDays:0});
 put('brandSupplierMappings',tag+'-mapping',{active:true,brandName:'Roche',productLine:tag,supplierId,isDefault:false});
 for(const warehouseId of warehouses)put('warehouses',warehouseId,{active:true,warehouseName:warehouseId});
 for(const key of keys){
  put('products',key,{productType:'Goods',active:true,productId:key,itemCode:key,model:key,brand:'Roche',nameCn:key});
  put('inventory',key,{productKey:key,onHand:0,reserved:0,incoming:0,transferFreeInTransit:0});
  for(const warehouseId of warehouses)put('warehouseStocks',warehouseId+'__'+key,{warehouseId,productKey:key,onHand:0,reserved:0,incoming:0,transferFreeInTransit:0});
 }
 const items=[{itemId:'I1',productId:keys[0],qty:3,warehouseId:warehouses[0]},
  {itemId:'I2',productId:keys[0],qty:2,warehouseId:warehouses[1]},
  {itemId:'I3',productId:keys[1],qty:2,warehouseId:warehouses[0]}].map(row=>({...row,itemCode:row.productId,itemName:row.productId,brand:'Roche',productLine:tag,
   unitPrice:100,fulfillmentType:'WAREHOUSE',reservedQty:0,deliveredQty:0,returnedQty:0,dispatchPreparedQty:0,warehouseShippedQty:0,
   deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'測試客戶',phone:'02-12345678',address:'測試地址'}}));
 await batch.commit();
 const source={orderNo:orderId,customerName:'多品項收貨驗收',ownerUid:accounts.sales.uid,salesCode:'B',status:'active',orderStatus:'normal',
  createdByUid:accounts.sales.uid,createdByRole:'sales',createdAt:new Date().toISOString(),productId:keys[0],productMasterMatched:true,
  itemCount:items.length,orderSchemaVersion:2,orderDate:'2026-10-22',inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_'+tag,
  deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,items};
 const creatorApp=clientApp({apiKey:'fake-api-key',authDomain:'demo-yushin.firebaseapp.com',projectId:'demo-yushin',appId:tag+'-creation'},tag+'-creation');
 try{
  const session=clientAuth(creatorApp);connectAuthEmulator(session,'http://127.0.0.1:9099',{disableWarnings:true});
  await signInWithEmailAndPassword(session,accounts.sales.email,password);
  const creator=orderCreationClient(creatorApp,accounts.sales.uid,'sales');
  const rejected=await creator.create(orderId+'-cost',{...source,items:items.map((item,index)=>index===2?{...item,unitCost:999}:item)})
   .then(()=>null,error=>error.code);
  assert.equal(rejected,'permission-denied');assert.equal((await db.collection('orders').doc(orderId+'-cost').get()).exists,false);
  await creator.create(orderId,source);
  assert.deepEqual((await db.collection('orders').doc(orderId).get()).data(),source);
  for(const key of keys)assert.equal((await db.collection('inventory').doc(key).get()).data().reserved,0,'creation alone does not reserve');
  await synchronizeV2OrderFixture(db,accounts.purchaser.uid,{orderId,warehouseIds:warehouses});
  const initialized=(await db.collection('orders').doc(orderId).get()).data();
  assert.equal(initialized.inventoryReservationStatus,'completed');assert.equal(initialized.items.length,3);
  await creator.create(orderId,{...source,customerName:'stale retry',items:[{...items[0],qty:999}]});
  assert.deepEqual((await db.collection('orders').doc(orderId).get()).data(),initialized,'same-ID create resumes saved facts without overwriting initialization');
 }finally{await deleteClientApp(creatorApp);}
 // Source creation now uses real Auth/Client Rules and the existing Service.
 // v2 initialization remains the explicit Service-adapter fixture boundary.
 // PO documents, commitments and incoming must now come from the original UI.
 const supplyIds=[];
 const snapshot=async()=>{
  const read=async(name,id)=>(await db.collection(name).doc(id).get()).data();
  const supplyRows=(await db.collection('supplyOrders').where('sourceId','==',orderId).get()).docs
   .map(doc=>({id:doc.id,data:doc.data()})).sort((a,b)=>a.data.itemId.localeCompare(b.data.itemId));
  const supplies=supplyRows.map(row=>row.data),liveSupplyIds=supplyRows.map(row=>row.id);
  const po=(await db.collection('purchaseOrders').where('orderIds','array-contains',orderId).get()).docs
   .map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id));
  const extra={};for(const name of ['inventoryLots','inventoryLotCosts','inventoryMovements','inventoryReservations'])
   extra[name]=(await db.collection(name).where('productKey','in',keys).get()).docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id));
  return {order:await read('orders',orderId),po,
   inventory:await Promise.all(keys.map(key=>read('inventory',key))),
   stocks:await Promise.all(keys.flatMap(key=>warehouses.map(id=>read('warehouseStocks',id+'__'+key)))),
   supplies,supplyIds:liveSupplyIds,
   views:await Promise.all(liveSupplyIds.map(id=>read('receivingSupplyOrders',id))),
   demands:await Promise.all(items.map(row=>read('procurementDemands',encodeURIComponent('SALES_ORDER:'+orderId+':'+row.itemId)))),
   receipts:await Promise.all(liveSupplyIds.map(async id=>(await db.collection('receipts').where('supplyOrderId','==',id).get()).docs
    .map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id)))),...extra};
 };
 return {accounts,orderId,keys,warehouses,supplyIds,supplierName,snapshot};
}
async function siteOrderAction(page,fixture,label){
 await siteNav(page,'orders');
 await page.evaluate(()=>ensureBrandSettingsLoaded());
 await page.waitForFunction(()=>!mainPageLoads.has('orders.list')&&!orderPageLoading);
 const row=page.locator('#ordersBody > tr').filter({hasText:fixture.sourceId});await row.waitFor({state:'visible'});
 await row.locator('.order-more-menu > summary').click();await row.locator('button').filter({hasText:label}).click();
}
for(const width of [1280,390])test('full site '+width+'px original PO receipt shipment acknowledgements and same-source return transport',{timeout:360000},async()=>{
 const fixture=await seed(width,'site'),context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}}),page=await context.newPage();
 const errors=[],external=[],calls=[],loaded=new Set();let loseCancel=true,loseRecovery=true,loseRestore=true,losePurchase=true,loseReceipt=true,loseDispatch=true,loseShipment=true,loseDelivery=true,loseReturn=true;
 await context.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;window.YUSHIN_V2_LIFECYCLE_EMULATOR=true;window.YUSHIN_V2_RECOVERY_EMULATOR=true;window.YUSHIN_FORMAL_PURCHASE_EMULATOR=true;window.YUSHIN_V2_RECEIVING_EMULATOR=true;window.YUSHIN_V2_DISPATCH_EMULATOR=true;window.YUSHIN_V2_SHIPMENT_EMULATOR=true;window.YUSHIN_V2_DELIVERY_EMULATOR=true;});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('dialog',dialog=>dialog.type()==='confirm'?dialog.accept():dialog.dismiss());
 page.on('response',response=>{if(response.status()===200)loaded.add(new URL(response.url()).pathname);});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){external.push(url.hostname);await route.abort();return;}
  if(url.port==='5001'&&request.method()==='POST'){
   const name=url.pathname.split('/').at(-1),data=request.postDataJSON().data;
   assert.ok((await request.allHeaders()).authorization?.startsWith('Bearer '));
   assert.equal(data.actorUid,undefined);assert.equal(data.actorRole,undefined);calls.push({name,data});
   const shouldLose=name==='setV2OrderLifecycle'
    ?(data.nextStatus==='normal'?loseRestore:loseCancel)
    :(name==='commitV2FormalPurchase'?losePurchase:(name==='receiveV2Supply'?loseReceipt:(name==='prepareV2OrderDispatch'?loseDispatch:(name==='shipV2WarehouseItem'?loseShipment:(name==='confirmV2ShipmentDelivery'?loseDelivery:(name==='receiveV2CustomerReturn'?loseReturn:(name==='resumeV2FreeStockRecovery'&&loseRecovery)))))));
   if(shouldLose){
    const reply=await route.fetch();assert.equal(reply.status(),200);
    if(name==='setV2OrderLifecycle'){
     if(data.nextStatus==='normal')loseRestore=false;else loseCancel=false;
    }else if(name==='commitV2FormalPurchase')losePurchase=false;
    else if(name==='receiveV2Supply')loseReceipt=false;
    else if(name==='prepareV2OrderDispatch')loseDispatch=false;
    else if(name==='shipV2WarehouseItem')loseShipment=false;
    else if(name==='confirmV2ShipmentDelivery')loseDelivery=false;
    else if(name==='receiveV2CustomerReturn')loseReturn=false;
    else loseRecovery=false;
    await route.abort('failed');return;
   }
  }
  await route.continue();
 });
 try{
  await siteOpen(page);await siteLogin(page,fixture.accounts.sales,'sales');const before=await facts(fixture);
  assert.equal(await page.evaluate(()=>canAccessPage('admin')),false);
  console.log('Full site '+width+'px: original bootstrap and seller profile loaded.');
  await siteOrderAction(page,fixture,'取消訂單');
  await page.waitForFunction(id=>!pendingLifecycleOrderIds.size&&!!pendingV2OrderLifecycle(id),fixture.sourceId);
  assert.equal((await facts(fixture)).source.orderStatus,'cancelled');
  await siteOpen(page,'sales');await siteOrderAction(page,fixture,'確認前次取消／恢復結果');
  await page.waitForFunction(id=>!pendingV2OrderLifecycle(id),fixture.sourceId);
  const cancel=calls.filter(row=>row.name==='setV2OrderLifecycle');assert.equal(cancel.length,2);assert.deepEqual(cancel[0].data,cancel[1].data);
  console.log('Full site '+width+'px: original order list and persisted cancel reconciliation passed.');
  await siteLogout(page);await siteLogin(page,fixture.accounts.warehouse,'warehouse');
  assert.equal(await page.evaluate(()=>canAccessPage('quote')),false);
  assert.equal(await page.evaluate(()=>canManageOrderLifecycleCapability()),false);
  await siteNav(page,'inventory');const canceled=await facts(fixture),rows=await loadSourceRows(page,fixture.productKey);
  assert.deepEqual(await facts(fixture),canceled);assert.equal(await rows.count(),2);await rows.first().locator('button').click();
  await page.waitForFunction(()=>document.getElementById('actionFeedback')?.textContent.includes('配貨結果尚待確認'));
  assert.equal((await facts(fixture)).targets.reduce((sum,row)=>sum+row.items[0].reservedQty,0),5);
  const movement=calls.find(row=>row.name==='resumeV2FreeStockRecovery').data.movementId;
  await siteOpen(page,'warehouse');await siteLogout(page);await siteLogin(page,fixture.accounts.purchaser,'purchaser');
  await siteNav(page,'inventory');await loadSourceRows(page,fixture.productKey);
  // Observe completion only; retain the original handler, renderer and cache invalidation.
  await page.evaluate(()=>{const original=window.retryFreeStockRecovery;window.completedRecoveryClicks=0;
   window.retryFreeStockRecovery=async(...args)=>{try{return await original(...args);}finally{window.completedRecoveryClicks++;}};});
  for(let step=0;step<5;step++){
   const buttons=page.locator('#freeStockRecoveryBody tr:visible').filter({hasText:fixture.productKey}).locator('button');
   if(!await buttons.count())break;
   const previous=await page.evaluate(()=>completedRecoveryClicks);await buttons.first().click();await page.waitForFunction(count=>completedRecoveryClicks>count,previous);
  }
  const after=await facts(fixture);assert.equal(after.targets.reduce((sum,row)=>sum+row.items[0].reservedQty,0),7);
  assert.equal(after.source.orderLifecycleHistory.length,1);assert.equal(after.inventory.onHand,before.inventory.onHand);
  assert.deepEqual(after.stocks.map(row=>row.onHand),before.stocks.map(row=>row.onHand));assert.deepEqual(after.lots,before.lots);
  const batchId='single-v2-free-batch-source_v2_'+require('node:crypto').createHash('sha256').update(movement).digest('hex').slice(0,40);
  const job=(await db.collection('reservationOperationReceipts').doc(batchId).get()).data();
  assert.equal(job.actorUid,fixture.accounts.purchaser.uid);assert.equal(job.handoffCount,1);assert.equal(job.status,'completed');
  await siteOpen(page,'purchaser');await siteNav(page,'inventory');await page.evaluate(()=>loadFreeStockRecovery());
  for(let scan=0;scan<20&&await page.locator('#freeStockRecoveryMore').isVisible();scan++)await page.locator('#freeStockRecoveryMore').click();
  assert.equal(await page.locator('#freeStockRecoveryBody tr:visible').filter({hasText:fixture.productKey}).count(),0);assert.deepEqual(await facts(fixture),after);
  for(const role of ['engineer','admin']){
   await siteLogout(page);await siteLogin(page,fixture.accounts[role],role);await siteOpen(page,role);
   assert.equal(await page.evaluate(()=>canAccessPage('admin')),role==='admin');
   assert.equal(await page.evaluate(()=>canAccessPage('quote')),true);await siteNav(page,'orders');
  }

  // A subsequent restoration must not steal the seven allocations handed off
  // to logistics; it can only reserve the five units still physically free.
  await siteLogout(page);await siteLogin(page,fixture.accounts.sales,'sales');await siteOpen(page,'sales');
  await siteOrderAction(page,fixture,'恢復訂單');
  await page.waitForFunction(id=>!pendingLifecycleOrderIds.size&&!!pendingV2OrderLifecycle(id),fixture.sourceId);
  const restored=await facts(fixture);
  assert.equal(restored.source.orderStatus,'normal');
  assert.equal(restored.source.orderLifecycleHistory.length,2);
  assert.equal(restored.source.items[0].reservedQty,5);
  assert.equal(restored.source.items[0].shortageQty,7);
  assert.equal(restored.inventory.reserved,12);
  assert.equal(restored.stocks.reduce((sum,row)=>sum+row.reserved,0),12);
  assert.equal(restored.targets.reduce((sum,row)=>sum+row.items[0].reservedQty,0),7);
  assert.equal(restored.inventory.onHand,before.inventory.onHand);
  assert.deepEqual(restored.lots,before.lots);
  await siteOpen(page,'sales');await siteOrderAction(page,fixture,'確認前次取消／恢復結果');
  await page.waitForFunction(id=>!pendingV2OrderLifecycle(id),fixture.sourceId);
  const restoreCalls=calls.filter(row=>row.name==='setV2OrderLifecycle'&&row.data.nextStatus==='normal');
  assert.equal(restoreCalls.length,2);assert.deepEqual(restoreCalls[0].data,restoreCalls[1].data);
  assert.deepEqual(await facts(fixture),restored);
  // Even after a later restore, replaying the old committed cancel ID cannot
  // cancel this order again or modify either warehouse's reservation.
  const oldCancellation=calls.find(row=>row.name==='setV2OrderLifecycle'&&row.data.nextStatus==='cancelled').data;
  const oldReplay=await page.evaluate(async input=>(await firebase.app().functions('asia-east1').httpsCallable('setV2OrderLifecycle')(input)).data,oldCancellation);
  assert.equal(oldReplay.status,'already-applied');
  assert.deepEqual(await facts(fixture),restored);
  // The next authoritative business stage is a new shortage demand, not stock
  // or supplier inventory. Verify the *same* restored source is visible to the
  // actual purchaser in the original full-site purchase workspace.
  const demandId=require('../modules/procurement-demand-core').demandIdForSource({
   sourceType:'SALES_ORDER',sourceId:fixture.sourceId,sourceItemId:'S'
  });
  const demandRef=db.collection('procurementDemands').doc(encodeURIComponent(demandId));
  const demandSnap=await demandRef.get();assert.equal(demandSnap.exists,true);
  const demand=demandSnap.data();
  assert.equal(demand.demandId,demandId);
  assert.equal(demand.sourceId,fixture.sourceId);
  assert.equal(demand.sourceItemId,'S');
  assert.equal(demand.requestedQty,7);
  assert.equal(demand.orderedQty,0);
  assert.equal(demand.receivedQty,0);
  assert.equal(demand.remainingToOrderQty,7);
  assert.equal(demand.remainingToReceiveQty,0);
  assert.equal(demand.status,'PENDING');
  assert.equal(restored.inventory.incoming||0,0);
  assert.equal(restored.stocks.reduce((sum,row)=>sum+(row.incoming||0),0),0);
  const sourceDemands=await db.collection('procurementDemands').where('sourceId','==',fixture.sourceId).get();
  assert.equal(sourceDemands.size,1);
  await siteLogout(page);await siteLogin(page,fixture.accounts.purchaser,'purchaser');
  await siteNav(page,'purchasing');
  await page.waitForFunction(orderId=>document.getElementById('purchasePendingBody')?.textContent?.includes(orderId),fixture.sourceId);
  assert.match(await page.locator('#purchasePendingBody').textContent(),new RegExp(fixture.sourceId));
  const poCountBefore=(await db.collection('purchaseOrders').get()).size;
  const supplyCountBefore=(await db.collection('supplyOrders').get()).size;
  const pendingRow=page.locator('#purchasePendingBody tr').filter({hasText:fixture.sourceId});
  assert.equal(await pendingRow.count(),1);
  await pendingRow.getByRole('button',{name:'產生採購單'}).click();
  await page.locator('#poModalOverlay.active').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.getElementById('poSaveStatus')?.textContent?.includes('尚未建立'));
  const proposal=await page.evaluate(()=>poItems.map(item=>({
   orderId:item.orderId,itemId:item.itemId,productId:item.productId,
   itemCode:item.itemCode,qty:item.qty,sourceType:item.sourceType,sourceId:item.sourceId
  })));
  assert.equal(proposal.length,1);
  assert.equal(proposal[0].orderId,fixture.sourceId);
  assert.equal(proposal[0].itemId,'S');
  assert.equal(proposal[0].productId,fixture.productKey);
  assert.equal(proposal[0].itemCode,fixture.sourceId.replace('-source','-code'));
  assert.equal(proposal[0].qty,7);
  assert.equal(proposal[0].sourceType,'SALES_ORDER');
  assert.equal(proposal[0].sourceId,fixture.sourceId);
  // The first Cloud Functions PO migration stage is admission-only, not a
  // second purchasing writer. Auth/role/source/demand are read by Admin SDK
  // from the real Emulator; the browser cannot forge actor or quantities.
  await page.waitForFunction(()=>poNoReady&&!poNoLoading);
  const admission=await page.evaluate(async input=>{
   const callable=firebase.app().functions('asia-east1').httpsCallable('previewV2FormalPurchase');
   const poNo=document.getElementById('poNo').textContent.trim();
   const valid=await callable({poNo,orderId:input.orderId,itemId:'S',qty:4});
   return {plan:valid.data};
  },{orderId:fixture.sourceId});
  assert.equal(admission.plan.orderId,fixture.sourceId);
  assert.equal(admission.plan.itemId,'S');
  assert.equal(admission.plan.demandId,demandId);
  assert.equal(admission.plan.proposedQty,4);
  assert.equal(admission.plan.requestedQty,7);
  assert.equal(admission.plan.remainingToOrderQty,7);
  assert.equal(admission.plan.remainingAfterQty,3);
  assert.equal(admission.plan.status,'preview-only');

  assert.deepEqual(await facts(fixture),restored);
  assert.deepEqual((await demandRef.get()).data(),demand);
  // One accepted + one rejected call per original browser page. The third
  // sequential Functions SDK call had intermittently hit the client transport
  // deadline despite the Emulator handler returning promptly. Forged identity,
  // disabled profile and owned-sales denial are separately tested in the
  // deterministic server security suite.
  console.log('Full site '+width+'px: authenticated PO preflight admits 4/7; no writes.');
  // Opening the original purchase modal was a read-only proposal. The PO
  // commit and incoming-registration stages have not been authorized by UI.
  assert.equal((await db.collection('purchaseOrders').get()).size,poCountBefore);
  assert.equal((await db.collection('supplyOrders').get()).size,supplyCountBefore);
  assert.deepEqual((await demandRef.get()).data(),demand);
  assert.deepEqual(await facts(fixture),restored);
  console.log('Full site '+width+'px: purchaser opened original formal PO draft for seven shortages; no supply or incoming stock was written.');
  // Real original submit click -> original Service -> real Auth Callable.
  // Only physical PDF output is replaced; PO, source, incoming and Rules run.
  await page.evaluate(()=>{window.poPdfOutputs=[];printSavedPoDocument=async(poNo,vendor)=>{
   if(!poListCache.some(row=>row.id===poNo))throw Error('PDF before authoritative PO commit');
   window.poPdfOutputs.push({poNo,vendor});
  };});
  await page.locator('#poVendorName').fill('測試供應商');
  await page.locator('#poDate').fill('2026-10-20');
  await page.locator('#poItemsBody input[onchange*="qty"]').fill('4');
  await page.locator('#poItemsBody input[onchange*="qty"]').blur();
  await page.locator('#poItemsBody input[onchange*="unitPrice"]').fill('20');
  await page.locator('#poItemsBody input[onchange*="unitPrice"]').blur();
  assert.equal(await page.locator('#poVendorName').inputValue(),'測試供應商',
   'editing PO quantity/price must preserve the supplier entered earlier');
  await page.locator('#poVendorName').blur();
  await page.locator('#printPurchaseOrderBtn').click();
  await page.waitForFunction(()=>!poSaveInProgress&&poEditingId&&window.poPdfOutputs.length===1);
  const draftPoId=await page.evaluate(()=>poEditingId);
  const preparedPo=(await db.collection('purchaseOrders').doc(draftPoId).get()).data();
  assert.equal(preparedPo.status,'DRAFT');assert.equal(preparedPo.documentOnly,true);
  assert.equal(calls.filter(row=>row.name==='commitV2FormalPurchase').length,0);
  assert.equal((await db.collection('supplyOrders').get()).size,supplyCountBefore);
  assert.deepEqual((await demandRef.get()).data(),demand);
  assert.deepEqual(await facts(fixture),restored,'document/PDF cannot change stock or source order');
  // Reprint, including a failed PDF, cannot purchase or register incoming.
  await page.locator('#printPurchaseOrderBtn').click();
  await page.waitForFunction(()=>!poSaveInProgress&&window.poPdfOutputs.length===2);
  assert.equal(calls.filter(row=>row.name==='commitV2FormalPurchase').length,0);
  await page.locator('#confirmPoOrderedBtn').click();
  await page.waitForFunction(()=>!formalPurchaseRecoveryRunning&&document.getElementById('actionFeedback')?.textContent?.includes('採購結果尚未確認'),null,{timeout:45000});
  const firstPurchase=calls.filter(row=>row.name==='commitV2FormalPurchase');
  assert.equal(firstPurchase.length,1);
  const commitIntent=firstPurchase[0].data;
  assert.equal((await db.collection('purchaseOrders').get()).size,poCountBefore+1);
  const pendingKey='formal-po-pending:'+encodeURIComponent(fixture.accounts.purchaser.uid);
  const pendingRaw=await page.evaluate(key=>sessionStorage.getItem(key),pendingKey);
  assert.equal(JSON.parse(pendingRaw).poRecord.poNo,commitIntent.poNo);
  assert.equal(await page.evaluate(()=>window.poPdfOutputs.length),2,'confirmation does not produce another PDF');
  assert.equal((await facts(fixture)).inventory.incoming||0,0,'lost PO response has not registered incoming yet');
  // Reload the unchanged original app. The original purchaser must explicitly
  // resume the stored intent; navigation and reading alone cannot submit it.
  await siteOpen(page,'purchaser');await siteNav(page,'purchasing');
  await page.locator('#confirmFormalPurchasePendingBtn').waitFor({state:'visible'});
  assert.equal(calls.filter(row=>row.name==='commitV2FormalPurchase').length,1);
  assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),pendingKey),pendingRaw);
  await page.locator('#confirmFormalPurchasePendingBtn').click();
  await page.waitForFunction(key=>!sessionStorage.getItem(key),pendingKey,{timeout:45000});
  const purchaseCalls=calls.filter(row=>row.name==='commitV2FormalPurchase');
  assert.equal(purchaseCalls.length,2);assert.deepEqual(purchaseCalls[1].data,commitIntent);
  // Reload and repeat recovery: no checkpoint, no second PO or incoming.
  await siteOpen(page,'purchaser');await siteNav(page,'purchasing');
  assert.equal(await page.locator('#formalPurchaseRecoveryPanel').isVisible(),false);
  await page.locator('#purchase-tab-history').click();
  const savedRow=page.locator('#poListBody tr').filter({hasText:commitIntent.poNo});
  await savedRow.locator('button').filter({hasText:'載入'}).click();
  await page.waitForFunction(()=>!poSaveInProgress&&poEditingId&&!poIncomingSyncPending);
  await page.evaluate(()=>{window.poPdfOutputs=[];printSavedPoDocument=async(poNo,vendor)=>window.poPdfOutputs.push({poNo,vendor});});
  await page.locator('#printPurchaseOrderBtn').click();
  await page.waitForFunction(()=>!poSaveInProgress&&window.poPdfOutputs.length===1);
  assert.equal(calls.filter(row=>row.name==='commitV2FormalPurchase').length,2);
  assert.equal(commitIntent.items[0].qty,4);assert.equal(commitIntent.items[0].unitCost,20);
  const savedPo=(await db.collection('purchaseOrders').doc(commitIntent.poNo).get()).data();
  assert.equal(savedPo.items.length,1);
  assert.equal(savedPo.items[0].qty,4);
  assert.equal(savedPo.vendorName,'測試供應商');
  assert.equal(savedPo.company,commitIntent.document.company);
  assert.deepEqual(savedPo.supplierSnapshot,commitIntent.document.supplierSnapshot);
  assert.equal(savedPo.subtotalExTax,80);assert.equal(savedPo.taxAmount,4);assert.equal(savedPo.totalIncTax,84);
  assert.deepEqual(savedPo.linkedDocuments,[{type:'order',id:fixture.sourceId,relation:'source'}]);
  assert.ok(savedPo.searchTokens.length>0);
  assert.deepEqual(await page.evaluate(()=>window.poPdfOutputs),[{poNo:commitIntent.poNo,vendor:'測試供應商'}]);
  const supplyId='po-'+encodeURIComponent(commitIntent.poNo)+'-0';
  assert.deepEqual(savedPo.supplyOrderIds,[supplyId]);
  const savedSupply=(await db.collection('supplyOrders').doc(supplyId).get()).data();
  assert.equal(savedSupply.status,'ORDERED');
  assert.equal(savedSupply.qty,4);
  assert.equal(savedSupply.receivedQty,0);
  assert.equal(savedSupply.incomingRegisteredQty,4);
  assert.equal(savedSupply.warehouseId,fixture.warehouseIds[0]);
  const afterCommit=(await demandRef.get()).data();
  assert.equal(afterCommit.requestedQty,7);
  assert.equal(afterCommit.orderedQty,4);
  assert.equal(afterCommit.remainingToOrderQty,3);
  assert.equal(afterCommit.remainingToReceiveQty,4);
  assert.equal(afterCommit.status,'PARTIALLY_ORDERED');
  const updated=await facts(fixture);
  assert.equal(updated.source.items[0].supplyOrderedQty,4);
  assert.equal(updated.source.items[0].reservedQty,restored.source.items[0].reservedQty);
  assert.equal(updated.inventory.incoming,4);
  assert.equal(updated.inventory.onHand,restored.inventory.onHand);
  updated.stocks.forEach((stock,index)=>{
   assert.equal(stock.incoming||0,index===0?4:0);
   assert.equal(stock.onHand,restored.stocks[index].onHand);assert.equal(stock.reserved,restored.stocks[index].reserved);
  });
  assert.deepEqual(updated.lots,restored.lots);
  assert.deepEqual(updated.targets,restored.targets);
  // The exact same authoritative server Service, under the REAL Emulator
  // transaction, handles lost responses and rejecting stale/forged intents.
  const buyer=fixture.accounts.purchaser.uid;
  const retry=await commitV2FormalPurchase(db,buyer,commitIntent);
  assert.equal(retry.status,'already-applied');
  await assert.rejects(commitV2FormalPurchase(db,buyer,{...commitIntent,items:commitIntent.items.map(row=>({...row,qty:3}))}),{code:'already-exists'});
  await assert.rejects(commitV2FormalPurchase(db,fixture.accounts.sales.uid,{...commitIntent,poNo:commitIntent.poNo+'-sales'}),{code:'permission-denied'});
  await assert.rejects(commitV2FormalPurchase(db,buyer,{...commitIntent,poNo:commitIntent.poNo+'-excess',items:commitIntent.items.map(row=>({...row,qty:8}))}),{code:'failed-precondition'});
  assert.equal((await db.collection('purchaseOrders').get()).size,poCountBefore+1);
  assert.equal((await db.collection('supplyOrders').get()).size,supplyCountBefore+1);
  assert.deepEqual((await demandRef.get()).data(),afterCommit);
  assert.deepEqual(await facts(fixture),updated);
  console.log('Full site '+width+'px: original PO lost its real HTTP reply; unchanged app reloaded and recovered the exact intent, registered four incoming units once and reprinted without another purchase.');
  // Same PO and original receipt dialog: two units arrive, response is lost.
  await page.locator('#poModalOverlay button[onclick="closePurchaseOrderModal()"]').click();
  await page.locator('#purchase-tab-work').click();await page.locator('#purchase-card-receiving').click();
  // The original purchasing button navigates to warehouse receiving first.
  await page.locator('#poListBody button[data-receipt-supply="'+supplyId+'"]').first().click();
  await page.locator('#inventoryReceivingBody button[data-receipt-supply="'+supplyId+'"]').first().click();
  await page.locator('#poReceiptBatchBody .po-receive-qty').fill('2');
  await page.locator('#poReceiptBatchBody .po-receive-lot').fill('PARTIAL-'+width);
  await page.locator('#poReceiptBatchBody .po-receive-expiry').fill('2028-01-01');
  await page.locator('#savePoReceiptBatchBtn').click();
  await page.waitForFunction(id=>receiptTaskJobs.get(receiptTaskKey(id))?.state==='error',supplyId,{timeout:45000});
  const receiptCalls=calls.filter(row=>row.name==='receiveV2Supply');assert.equal(receiptCalls.length,1);
  const receiptIntent=receiptCalls[0].data;
  const partial=await facts(fixture),partialSupply=(await db.collection('supplyOrders').doc(supplyId).get()).data();
  assert.equal(partial.inventory.onHand,updated.inventory.onHand+2);assert.equal(partial.inventory.reserved,updated.inventory.reserved+2);assert.equal(partial.inventory.incoming,2);
  assert.equal(partial.source.items[0].receivedQty,2);assert.equal(partial.source.items[0].reservedQty,7);assert.equal(partial.source.items[0].shortageQty,5);
  assert.equal(partialSupply.receivedQty,2);assert.equal(partialSupply.incomingRegisteredQty,2);
  assert.equal(partial.stocks[0].onHand,updated.stocks[0].onHand+2);assert.deepEqual(partial.stocks[1],updated.stocks[1]);
  assert.deepEqual(partial.targets,updated.targets);assert.equal(partial.lots.length,updated.lots.length+1);
  const receiptProof=(await db.collection('receipts').doc(receiptIntent.operationId).get()).data();
  assert.equal(receiptProof.reservationLocationSchemaVersion,2);assert.equal(receiptProof.qty,2);
  const partialDemand=(await demandRef.get()).data();assert.equal(partialDemand.receivedQty,2);assert.equal(partialDemand.remainingToReceiveQty,2);assert.equal(partialDemand.remainingToOrderQty,3);
  await siteOpen(page,'purchaser');await siteNav(page,'purchasing');
  await page.locator('#receiptTaskStatus button').filter({hasText:'用原資料重試'}).click();
  await page.waitForFunction(id=>!receiptTaskJobs.has(receiptTaskKey(id)),supplyId,{timeout:45000});
  const retried=calls.filter(row=>row.name==='receiveV2Supply');assert.equal(retried.length,2);assert.deepEqual(retried[1].data,receiptIntent);
  assert.deepEqual(await facts(fixture),partial);assert.deepEqual((await db.collection('supplyOrders').doc(supplyId).get()).data(),partialSupply);
  assert.deepEqual((await demandRef.get()).data(),partialDemand);assert.equal((await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).size,1);
  console.log('Full site '+width+'px: original PO partially received two of four through real Auth and original Receiving Service; lost reply/reload reused one receipt, one lot and reduced incoming to two.');

  // Complete the SAME PO through the same original warehouse receipt dialog.
  // Lose this reply too: a different legitimate arrival has its own fixed ID.
  await siteNav(page,'inventory');await page.locator('#inventoryReceivingTabBtn').click();
  await page.locator('#inventoryReceivingBody button[data-receipt-supply="'+supplyId+'"]').first().click();
  await page.locator('#poReceiptBatchBody .po-receive-qty').fill('2');
  await page.locator('#poReceiptBatchBody .po-receive-lot').fill('FINAL-'+width);
  await page.locator('#poReceiptBatchBody .po-receive-expiry').fill('2028-02-01');
  loseReceipt=true;await page.locator('#savePoReceiptBatchBtn').click();
  await page.waitForFunction(id=>receiptTaskJobs.get(receiptTaskKey(id))?.state==='error',supplyId,{timeout:45000});
  const finalIntent=calls.filter(row=>row.name==='receiveV2Supply').at(-1).data;
  assert.notEqual(finalIntent.operationId,receiptIntent.operationId);
  const completed=await facts(fixture),completeSupply=(await db.collection('supplyOrders').doc(supplyId).get()).data();
  assert.equal(completed.inventory.onHand,updated.inventory.onHand+4);assert.equal(completed.inventory.reserved,updated.inventory.reserved+4);assert.equal(completed.inventory.incoming,0);
  assert.equal(completed.source.items[0].receivedQty,4);assert.equal(completed.source.items[0].reservedQty,9);assert.equal(completed.source.items[0].shortageQty,3);
  assert.equal(completeSupply.status,'RECEIVED');assert.equal(completeSupply.receivedQty,4);assert.equal(completeSupply.incomingRegisteredQty,0);
  assert.equal(completed.stocks[0].onHand,updated.stocks[0].onHand+4);assert.equal(completed.stocks[0].incoming,0);assert.deepEqual(completed.stocks[1],updated.stocks[1]);
  assert.deepEqual(completed.targets,updated.targets);assert.equal(completed.lots.length,updated.lots.length+2);
  const completeDemand=(await demandRef.get()).data();assert.equal(completeDemand.receivedQty,4);assert.equal(completeDemand.remainingToReceiveQty,0);assert.equal(completeDemand.remainingToOrderQty,3);
  await siteOpen(page,'purchaser');await siteNav(page,'inventory');
  await page.locator('#receiptTaskStatus button').filter({hasText:'用原資料重試'}).click();
  await page.waitForFunction(id=>!receiptTaskJobs.has(receiptTaskKey(id)),supplyId,{timeout:45000});
  const allReceiptCalls=calls.filter(row=>row.name==='receiveV2Supply');assert.equal(allReceiptCalls.length,4);assert.deepEqual(allReceiptCalls[3].data,finalIntent);
  assert.deepEqual(await facts(fixture),completed);assert.deepEqual((await demandRef.get()).data(),completeDemand);
  assert.equal((await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).size,2);
  assert.equal(await page.locator('#inventoryReceivingBody button[data-receipt-supply="'+supplyId+'"]').count(),0);
  console.log('Full site '+width+'px: same PO completed its final two units; lost reply/reload preserved exactly two receipts and lots, zero incoming and three still unpurchased shortages.');

  // Original purchasing dispatch button prepares the nine held units. Its lost
  // reply survives reload without a second dispatch record or stock mutation.
  await siteNav(page,'purchasing');await page.locator('#purchase-card-dispatch').click();
  const dispatchButton=()=>page.locator('#purchaseDispatchBody button[onclick*="'+fixture.sourceId+'"]');
  await dispatchButton().click();
  await page.waitForFunction(id=>!pendingDispatchOrderIds.size&&!!pendingDispatchPreparation(id,'S'),fixture.sourceId,{timeout:45000});
  const prepared=await facts(fixture),dispatchIntent=calls.find(row=>row.name==='prepareV2OrderDispatch').data;
  assert.equal(dispatchIntent.quantity,9);assert.equal(prepared.source.items[0].dispatchPreparedQty,9);
  assert.deepEqual({...prepared,source:null},{...completed,source:null});
  await siteOpen(page,'purchaser');await siteNav(page,'purchasing');await page.locator('#purchase-card-dispatch').click();
  await dispatchButton().filter({hasText:'確認打單結果'}).click();
  await page.waitForFunction(id=>!pendingDispatchOrderIds.size&&!pendingDispatchPreparation(id,'S'),fixture.sourceId,{timeout:45000});
  const dispatchCalls=calls.filter(row=>row.name==='prepareV2OrderDispatch');assert.equal(dispatchCalls.length,2);assert.deepEqual(dispatchCalls[1].data,dispatchIntent);
  assert.deepEqual(await facts(fixture),prepared);assert.equal((await db.collection('dispatchRecords').where('orderId','==',fixture.sourceId).get()).size,1);

  // Original warehouse selection + batch form, twice for two units. First
  // shipment commits before its HTTP reply is lost; reload resumes that ID.
  await siteLogout(page);await siteLogin(page,fixture.accounts.warehouse,'warehouse');
  async function openShipmentBatch(){
   await siteNav(page,'inventory');await page.locator('#inventoryShippingTabBtn').click();
   await page.waitForFunction(()=>orderWorkQueueReady&&!orderWorkQueueError&&warehouseMasterCache.length>0,null,{timeout:45000});
   const main=await page.evaluate(()=>defaultWarehouse()?.id||'');
   await page.locator(main===fixture.warehouseIds[0]?'#inventoryShippingMainBtn':'#inventoryShippingBranchBtn').click();
   const row=page.locator('#inventoryShippingBody tr[data-shipping-warehouse="'+fixture.warehouseIds[0]+'"]').filter({hasText:fixture.sourceId});
   await row.locator('input[type="checkbox"]').check();await page.locator('#warehouseShippingBatchBtn').click();
   await page.locator('#warehouseShippingBatchConfirm').waitFor({state:'visible'});
  }
  await openShipmentBatch();await page.locator('[data-batch-qty="0"]').fill('2');
  await page.locator('#warehouseShippingBatchDate').fill('2026-10-21');await page.locator('#warehouseShippingBatchConfirm').click();
  await page.waitForFunction(()=>document.getElementById('warehouseShippingBatchConfirm')?.textContent==='重試未完成品項',null,{timeout:45000});
  const firstShipmentIntent=calls.find(row=>row.name==='shipV2WarehouseItem').data;
  const firstShipped=await facts(fixture);assert.equal(firstShipped.source.items[0].warehouseShippedQty,2);
  assert.equal(firstShipped.source.items[0].reservedQty,7);assert.equal(firstShipped.inventory.onHand,prepared.inventory.onHand-2);assert.equal(firstShipped.inventory.reserved,prepared.inventory.reserved-2);
  assert.equal(firstShipped.source.deliveredQty,0);assert.deepEqual(firstShipped.source.deliveryRecords,[]);assert.equal(firstShipped.source.isDelivered,false);
  await siteOpen(page,'warehouse');await openShipmentBatch();assert.equal(await page.locator('[data-batch-qty="0"]').inputValue(),'2');
  await page.locator('#warehouseShippingBatchConfirm').click();
  await page.locator('#warehouseLogisticsOverlay.active').waitFor({state:'hidden'});
  const shipmentCalls=calls.filter(row=>row.name==='shipV2WarehouseItem');assert.equal(shipmentCalls.length,2);assert.deepEqual(shipmentCalls[1].data,firstShipmentIntent);
  assert.deepEqual(await facts(fixture),firstShipped);
  await openShipmentBatch();await page.locator('[data-batch-qty="0"]').fill('2');
  await page.locator('#warehouseShippingBatchDate').fill('2026-10-21');await page.locator('#warehouseShippingBatchConfirm').click();
  await page.locator('#warehouseLogisticsOverlay.active').waitFor({state:'hidden'});
  const shipped=await facts(fixture),shipmentRecords=shipped.source.warehouseShipmentRecords;
  assert.equal(shipmentRecords.length,2);assert.equal(shipped.source.items[0].warehouseShippedQty,4);assert.equal(shipped.source.items[0].reservedQty,5);assert.equal(shipped.source.items[0].shortageQty,3);
  assert.equal(shipped.inventory.onHand,prepared.inventory.onHand-4);assert.equal(shipped.inventory.reserved,prepared.inventory.reserved-4);assert.equal(shipped.inventory.incoming,0);
  assert.equal(shipped.stocks[0].onHand,prepared.stocks[0].onHand-4);assert.equal(shipped.stocks[0].reserved,prepared.stocks[0].reserved-4);assert.deepEqual(shipped.stocks[1],prepared.stocks[1]);assert.deepEqual(shipped.targets,prepared.targets);
  assert.equal(shipped.source.deliveredQty,0);assert.deepEqual(shipped.source.deliveryRecords,[]);assert.equal(shipped.source.isDelivered,false);
  for(const record of shipmentRecords){const proof=(await db.collection('inventoryMovements').doc(record.movementId).get()).data();require('../modules/fulfillment-core').validateShipmentMovement(record,proof,{orderId:fixture.sourceId,itemId:'S',productKey:fixture.productKey});}
  assert.deepEqual((await demandRef.get()).data(),completeDemand);
  console.log('Full site '+width+'px: original dispatch prepared nine once, warehouse split-shipped two plus two with lost-reply/reload retry; two physical debit proofs, no customer delivery and other warehouse/target holds unchanged.');

  // The SAME source owner uses the original order menu and original delivery
  // form. Acknowledgement must never repeat the previous physical stock debit.
  const stockFacts=async()=>{
   const all=await facts(fixture),extra={};
   for(const name of ['inventoryReservations','inventoryMovements','inventoryLotCosts']){
    extra[name]=(await db.collection(name).where('productKey','==',fixture.productKey).get()).docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id));
   }
   return {...all,source:null,...extra,supply:(await db.collection('supplyOrders').doc(supplyId).get()).data(),
    demand:(await demandRef.get()).data(),receipts:(await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).docs.map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id))};
  };
  const physicalBeforeDelivery=await stockFacts();
  await siteLogout(page);await siteLogin(page,fixture.accounts.sales,'sales');
  async function openCustomerDelivery(){
   await siteOrderAction(page,fixture,'分批交貨');
   await page.locator('#deliveryModalOverlay.active').waitFor({state:'visible'});
   await page.locator('#deliveryFormPanel').waitFor({state:'visible'});
  }
  const deliverySave=page.locator('#deliveryFormPanel button[onclick="saveDeliveryRecord()"]');
  await openCustomerDelivery();
  await page.locator('#deliveryShipmentId').selectOption(shipmentRecords[0].id);
  await page.locator('#deliveryDate').fill('2026-10-21');await page.locator('#deliveryQty').fill('1');await page.locator('#deliveryNotes').fill('第一批先收到一件');
  await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  const firstDeliveryIntent=calls.find(row=>row.name==='confirmV2ShipmentDelivery').data;
  const acknowledgedOne=await facts(fixture);assert.equal(acknowledgedOne.source.deliveredQty,1);assert.equal(acknowledgedOne.source.deliveryRecords.length,1);assert.equal(acknowledgedOne.source.isDelivered,false);
  assert.deepEqual(await stockFacts(),physicalBeforeDelivery);assert.deepEqual(acknowledgedOne.source.warehouseShipmentRecords,shipmentRecords);
  await siteOpen(page,'sales');await openCustomerDelivery();
  assert.equal(await page.locator('#deliveryShipmentId').inputValue(),shipmentRecords[0].id);assert.equal(await page.locator('#deliveryShipmentId').isDisabled(),true);assert.equal(await page.locator('#deliveryQty').inputValue(),'1');
  await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  const firstRetry=calls.filter(row=>row.name==='confirmV2ShipmentDelivery');assert.equal(firstRetry.length,2);assert.deepEqual(firstRetry[1].data,firstDeliveryIntent);
  assert.deepEqual(await facts(fixture),acknowledgedOne);assert.deepEqual(await stockFacts(),physicalBeforeDelivery);

  await page.locator('#openPartialDeliveryBtn').click();
  await page.locator('#deliveryShipmentId').selectOption(shipmentRecords[0].id);
  await page.locator('#deliveryDate').fill('2026-10-21');await page.locator('#deliveryQty').fill('1');await page.locator('#deliveryNotes').fill('第一批其餘一件收到');
  await deliverySave.click();
  await page.waitForFunction(()=>!pendingDeliveryOrderIds.size&&document.getElementById('deliveryFormPanel').style.display==='none',null,{timeout:45000});
  const acknowledgedFirst=await facts(fixture);assert.equal(acknowledgedFirst.source.deliveredQty,2);assert.equal(acknowledgedFirst.source.deliveryRecords.length,2);assert.deepEqual(await stockFacts(),physicalBeforeDelivery);
  await page.locator('#openPartialDeliveryBtn').click();
  assert.equal(await page.locator('#deliveryShipmentId option[value="'+shipmentRecords[0].id+'"]').count(),0);
  await page.locator('#deliveryShipmentId').selectOption(shipmentRecords[1].id);
  await page.locator('#deliveryDate').fill('2026-10-21');await page.locator('#deliveryQty').fill('2');await page.locator('#deliveryNotes').fill('第二批兩件收到');
  loseDelivery=true;await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  const finalDeliveryIntent=calls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data;
  assert.notEqual(finalDeliveryIntent.operationId,firstDeliveryIntent.operationId);
  const acknowledgedAllShipments=await facts(fixture);assert.equal(acknowledgedAllShipments.source.deliveredQty,4);assert.equal(acknowledgedAllShipments.source.items[0].deliveredQty,4);assert.equal(acknowledgedAllShipments.source.deliveryRecords.length,3);
  assert.equal(acknowledgedAllShipments.source.isDelivered,false,'all shipped units acknowledged does not complete the twelve-unit order');
  assert.equal(acknowledgedAllShipments.source.items[0].reservedQty,5);assert.equal(acknowledgedAllShipments.source.items[0].shortageQty,3);assert.equal(acknowledgedAllShipments.source.items[0].warehouseShippedQty,4);assert.equal(acknowledgedAllShipments.source.items[0].dispatchPreparedQty,9);
  assert.deepEqual(await stockFacts(),physicalBeforeDelivery);assert.deepEqual(acknowledgedAllShipments.source.warehouseShipmentRecords,shipmentRecords);
  await siteOpen(page,'sales');await openCustomerDelivery();
  assert.equal(await page.locator('#deliveryShipmentId').inputValue(),shipmentRecords[1].id);assert.equal(await page.locator('#deliveryShipmentId').isDisabled(),true);
  await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  const deliveryCalls=calls.filter(row=>row.name==='confirmV2ShipmentDelivery');assert.equal(deliveryCalls.length,5);assert.deepEqual(deliveryCalls[4].data,finalDeliveryIntent);
  assert.deepEqual(await facts(fixture),acknowledgedAllShipments);assert.deepEqual(await stockFacts(),physicalBeforeDelivery);
  const deliveryProgress=require('../modules/fulfillment-core').projectShipmentDelivery({orderId:fixture.sourceId,itemId:'S',productKey:fixture.productKey,orderedQty:12,shipments:shipmentRecords,deliveries:acknowledgedAllShipments.source.deliveryRecords});
  assert.equal(deliveryProgress.confirmedQty,4);assert.equal(deliveryProgress.pendingDeliveryQty,0);assert.equal(deliveryProgress.isDelivered,false);
  assert.equal(acknowledgedAllShipments.source.deliveryHistory.filter(row=>row.source==='shipment_confirmation').length,3);
  console.log('Full site '+width+'px: original owner acknowledged first shipment one plus one and second shipment two; first/final lost replies reloaded with identical intents, three confirmations total and zero stock/reservation/lot/movement changes; twelve-unit order remains incomplete.');

  // This segment exercises browser-SDK provenance with the actual second
  // debit. A later segment enables and tests the original warehouse receipt UI.
  const returnShipment=shipmentRecords[1],returnLot=returnShipment.lotAllocations[0].lotId;
  const trace={orderId:fixture.sourceId,itemId:'S',shipmentId:returnShipment.id,
   syncAttemptId:acknowledgedAllShipments.source.inventoryReservationAttemptId,selections:[{lotId:returnLot,qty:1}]};
  const returnIntent={...trace,operationId:'same_po_return_'+width+'_first',warehouseId:returnShipment.warehouseId,
   date:'2026-10-21',reason:'訂錯貨退回原倉，另單訂購',condition:'RESTOCKABLE',settlement:'CLOSE'};
  async function returnTransport(name,data){
   return page.evaluate(async({name,data})=>{
    try{return {result:(await firebase.app().functions('asia-east1').httpsCallable(name)(data)).data};}
    catch(error){return {error:error.code};}
   },{name,data});
  }
  const beforeReturn=await stockFacts();
  const preview=await returnTransport('previewV2CustomerReturn',trace);
  assert.equal(preview.result.canCommit,false);assert.equal(preview.result.returnQty,1);
  assert.equal(preview.result.warehouseId,returnShipment.warehouseId);assert.deepEqual(await stockFacts(),beforeReturn);
  // Reject source/quantity tampering before the first real receipt, atomically.
  loseReturn=false;
  for(const invalid of [{...returnIntent,warehouseId:fixture.warehouseIds[1]},
    {...returnIntent,selections:[{lotId:returnLot,qty:3}]}]){
   assert.ok((await returnTransport('receiveV2CustomerReturn',invalid)).error);assert.deepEqual(await stockFacts(),beforeReturn);
   assert.deepEqual((await facts(fixture)).source,acknowledgedAllShipments.source);
  }
  loseReturn=true;
  assert.ok((await returnTransport('receiveV2CustomerReturn',returnIntent)).error,'real committed HTTP reply is lost');
  const firstReturn=await facts(fixture),firstReturnFacts=await stockFacts();
  assert.equal(firstReturn.source.returnRecords.length,1);assert.equal(firstReturn.source.returnedQty,1);
  await siteOpen(page,'sales');
  assert.equal((await returnTransport('receiveV2CustomerReturn',returnIntent)).result.status,'already-applied');
  assert.deepEqual(await facts(fixture),firstReturn);assert.deepEqual(await stockFacts(),firstReturnFacts);
  assert.ok((await returnTransport('receiveV2CustomerReturn',{...returnIntent,reason:'changed intent'})).error);
  assert.deepEqual(await stockFacts(),firstReturnFacts);
  const secondReturnIntent={...returnIntent,operationId:'same_po_return_'+width+'_second'};
  assert.equal((await returnTransport('receiveV2CustomerReturn',secondReturnIntent)).result.status,'applied');
  const returned=await facts(fixture),returnedFacts=await stockFacts();
  assert.equal(returned.source.returnRecords.length,2);assert.equal(returned.source.returnedQty,2);
  assert.equal(returned.source.items[0].returnedQty,2);assert.equal(returned.source.items[0].reservedQty,5);
  assert.equal(returned.source.items[0].shortageQty,3);assert.equal(returned.source.deliveredQty,4);assert.equal(returned.source.isDelivered,false);
  assert.deepEqual(returned.source.deliveryRecords,acknowledgedAllShipments.source.deliveryRecords);
  assert.deepEqual(returned.source.warehouseShipmentRecords,shipmentRecords);
  for(const field of ['onHand','reserved','incoming'])assert.equal(returned.inventory[field],shipped.inventory[field]+(field==='onHand'?2:0));
  for(const field of ['onHand','reserved'])assert.equal(returned.stocks[0][field],shipped.stocks[0][field]+(field==='onHand'?2:0));
  assert.deepEqual(returned.stocks[1],shipped.stocks[1]);assert.deepEqual(returned.targets,shipped.targets);
  for(const lot of shipped.lots){
   const actual=returned.lots.find(row=>row.id===lot.id);assert.ok(actual);
   assert.equal(actual.remainingQty,lot.remainingQty+(lot.id===returnLot?2:0));
   if(lot.id!==returnLot)assert.deepEqual(actual,lot);
  }
  assert.equal(returned.lots.length,shipped.lots.length);
  for(const field of ['inventoryLotCosts','supply','demand','receipts'])assert.deepEqual(returnedFacts[field],beforeReturn[field]);
  const ledgerBalances=rows=>rows.map(({updatedAt,...row})=>row);
  assert.deepEqual(ledgerBalances(returnedFacts.inventoryReservations),ledgerBalances(beforeReturn.inventoryReservations));
  const priorMovementIds=new Set(beforeReturn.inventoryMovements.map(row=>row.id));
  assert.deepEqual(returnedFacts.inventoryMovements.filter(row=>priorMovementIds.has(row.id)),beforeReturn.inventoryMovements);
  const returnMovements=returnedFacts.inventoryMovements.filter(row=>!priorMovementIds.has(row.id));assert.equal(returnMovements.length,2);
  for(const proof of returnMovements){assert.equal(proof.action,'location_customer_return');assert.equal(proof.qty,1);assert.equal(proof.reservedDelta,0);assert.equal(proof.actorUid,fixture.accounts.sales.uid);}
  const returnProgress=require('../modules/fulfillment-core').projectShipmentReturns({orderId:fixture.sourceId,itemId:'S',productKey:fixture.productKey,orderedQty:12,
   shipments:shipmentRecords,deliveries:returned.source.deliveryRecords,returns:returned.source.returnRecords});
  assert.equal(returnProgress.closedQty,2);assert.equal(returnProgress.effectiveDeliveredQty,4,'CLOSE remains commercially fulfilled without replacement');assert.equal(returnProgress.replacementQty,0);assert.equal(returnProgress.outstandingQty,8);
  const allReturned=await stockFacts();
  assert.ok((await returnTransport('receiveV2CustomerReturn',{...returnIntent,operationId:'same_po_return_'+width+'_excess'})).error);
  assert.deepEqual(await stockFacts(),allReturned);assert.deepEqual(await facts(fixture),returned);
  const returnCalls=calls.filter(row=>row.name==='receiveV2CustomerReturn'&&row.data.operationId===returnIntent.operationId&&row.data.reason===returnIntent.reason&&row.data.warehouseId===returnIntent.warehouseId&&row.data.selections[0].qty===1);
  assert.equal(returnCalls.length,2);assert.deepEqual(returnCalls[0].data,returnCalls[1].data);
  console.log('Full site '+width+'px: same PO/shipment browser-SDK return transport restored two explicitly selected units to original lot, CLOSE/no replacement, first lost reply retried identically; no duplicate credit, other holds/incoming/cost/receipts unchanged. Original return UI remains unconnected.');

  // Reopen the real purchasing list after each viewport's return without
  // deleting the returned source. Both it and the next fixture must coexist.
  await siteLogout(page);await siteLogin(page,fixture.accounts.purchaser,'purchaser');
  await siteNav(page,'purchasing');
  await page.waitForFunction(orderId=>document.getElementById('purchasePendingBody')?.textContent?.includes(orderId),fixture.sourceId);
  assert.deepEqual(await stockFacts(),allReturned);assert.deepEqual(await facts(fixture),returned);
  console.log('Full site '+width+'px: original purchasing list still renders the returned source with three units to procure; reopening it is read-only.');

  // Request/withdrawal use their ORIGINAL client Service and real Rules.
  // A request is not a physical receipt and must not credit any stock.
  await siteLogout(page);await siteLogin(page,fixture.accounts.sales,'sales');
  async function openReturnRequest(){
   await siteOrderAction(page,fixture,'退貨');
   await page.locator('#returnFormPanel').waitFor({state:'visible'});
  }
  const priorRequests=returned.source.returnRequests||[],requestIds=[];
  for(let n=0;n<2;n++){
   if(n===0)await openReturnRequest();else await page.locator('#openReturnFormBtn').click();
   await page.locator('#returnDate').fill('2026-10-21');await page.locator('#returnQty').fill('1');
   await page.locator('#returnReason').fill('待倉庫實收的退貨申請 '+n);
   await page.locator('#returnSaveBtn').click();
   await page.waitForFunction(id=>!customerReturnActionsPending.has(id)&&document.getElementById('returnRequestsSummary')?.textContent.includes('退貨待收貨'),fixture.sourceId);
   const now=await facts(fixture);assert.equal(now.source.returnRequests.length,priorRequests.length+n+1);
   const request=now.source.returnRequests.at(-1);requestIds.push(request.id);
   assert.equal(request.receivedQty,0);assert.equal(request.status,'PENDING');assert.equal(request.createdByUid,fixture.accounts.sales.uid);
   assert.equal(now.source.returnPending,true);assert.deepEqual(now.source.returnRecords,returned.source.returnRecords);
   assert.deepEqual(await stockFacts(),allReturned);
  }
  assert.equal(await page.locator('#openReturnFormBtn').isHidden(),true,'all remaining delivered units are pending return');
  await siteOpen(page,'sales');await siteOrderAction(page,fixture,'退貨');
  await page.locator('#orderProgressTab-returns').click();
  await page.locator('#returnRequestsSummary').waitFor({state:'visible'});
  assert.equal(await page.locator('#returnRequestsSummary button').count(),2);
  await page.locator('#deliveryModalOverlay button[onclick="closeDeliveryModal()"]').click();
  await siteLogout(page);await siteLogin(page,fixture.accounts.warehouse,'warehouse');
  await siteNav(page,'inventory');await page.locator('#inventoryReceivingTabBtn').click();
  await page.locator('[data-inventory-receiving-kind="returns"]').click();
  await page.waitForFunction(id=>customerReturnOrders.some(o=>o.id===id)&&document.getElementById('customerReturnQueue')?.textContent.includes('申請保留待收'),fixture.sourceId);
  assert.match(await page.locator('#customerReturnQueue').textContent(),/申請保留待收/);
  assert.equal(await page.locator('#customerReturnQueue button[onclick^="receiveCustomerReturn("]').count(),0);
  for(const quality of ['SALEABLE','INSPECTION','DAMAGED']){
   const error=await page.evaluate(async({orderId,requestId,quality})=>{
    try{await commitCustomerReturnReceipt({orderId,requestId,receiptId:'guard_'+quality,qty:1,quality,warehouseId:'unused'});return '';}
    catch(error){return error.message;}
   },{orderId:fixture.sourceId,requestId:requestIds[0],quality});
   assert.match(error,/退貨收貨尚未開放/);assert.deepEqual(await stockFacts(),allReturned);
  }
  await siteLogout(page);await siteLogin(page,fixture.accounts.sales,'sales');
  await siteOrderAction(page,fixture,'退貨');
  await page.locator('#orderProgressTab-returns').click();
  for(const requestId of requestIds){
   await page.locator('#returnRequestsSummary button[onclick*="'+requestId+'"]').click();
   await page.waitForFunction(({orderId,requestId})=>ordersCache.find(o=>o.id===orderId)?.returnRequests.find(r=>r.id===requestId)?.status==='CANCELLED',{orderId:fixture.sourceId,requestId});
  }
  const withdrawn=await facts(fixture);assert.equal(withdrawn.source.returnPending,false);
  for(const id of requestIds){const request=withdrawn.source.returnRequests.find(r=>r.id===id);assert.equal(request.receivedQty,0);assert.equal(request.cancelledBy,fixture.accounts.sales.uid);}
  assert.deepEqual(withdrawn.source.returnRecords,returned.source.returnRecords);assert.equal(withdrawn.source.returnedQty,2);
  assert.deepEqual(await stockFacts(),allReturned);
  await siteOpen(page,'sales');await siteOrderAction(page,fixture,'退貨');
  assert.equal(await page.locator('#returnRequestsSummary button').count(),0);assert.equal(await page.locator('#openReturnFormBtn').isHidden(),false);
  console.log('Full site '+width+'px: original request form created two pending one-unit returns via actual Client Rules, reload preserved both; warehouse queue cannot route v2 into legacy receipt/hold, original owner withdrew both without stock changes. Physical receipt UI remains pending.');

  // Original queue -> explicit original shipment/batch form -> original receipt
  // Service -> true SDK/Callable/transaction. Both partial and final receipts
  // lose their successful HTTP response before a reload and same-ID recovery.
  await context.addInitScript(()=>{window.YUSHIN_V2_RETURN_RECEIPT_EMULATOR=true;});
  if(!await page.locator('#returnFormPanel').isVisible())await page.locator('#openReturnFormBtn').click();
  await page.locator('#returnDate').fill('2026-10-21');await page.locator('#returnQty').fill('2');
  await page.locator('#returnReason').fill('原倉管畫面分批實收');await page.locator('#returnSaveBtn').click();
  await page.waitForFunction(id=>!customerReturnActionsPending.has(id)&&ordersCache.find(o=>o.id===id)?.returnRequests.at(-1).qty===2,fixture.sourceId);
  const uiRequest=(await facts(fixture)).source.returnRequests.at(-1),uiBefore=await facts(fixture),uiBeforeStock=await stockFacts();
  await page.locator('#deliveryModalOverlay button[onclick="closeDeliveryModal()"]').click();
  await siteLogout(page);await siteLogin(page,fixture.accounts.warehouse,'warehouse');
  async function openReturnQueue(){
   await siteNav(page,'inventory');await page.locator('#inventoryReceivingTabBtn').click();
   await page.locator('[data-inventory-receiving-kind="returns"]').click();
   await page.waitForFunction(id=>document.getElementById('customerReturnQueue')?.innerHTML.includes(id),fixture.sourceId);
  }
  // The flag takes effect on the real original page reload, never a replaced handler.
  await siteOpen(page,'warehouse');await openReturnQueue();
  const uiReceiptsBefore=calls.filter(row=>row.name==='receiveV2CustomerReturn').length;
  const chosenShipment=shipmentRecords[0],chosenLot=chosenShipment.lotAllocations[0].lotId;
  for(let n=0;n<2;n++){
   await page.locator('#customerReturnQueue button[onclick*="'+uiRequest.id+'"]').click();
   await page.locator('#customerReturnReceiptOverlay').waitFor({state:'visible'});
   await page.locator('#customerReturnReceiptShipment').selectOption(chosenShipment.id);
   const inputs=page.locator('#customerReturnReceiptLots input');assert.ok(await inputs.count()>0);
   const selected=await page.evaluate(lotId=>customerReturnReceiptView.lots.findIndex(row=>row.lotId===lotId),chosenLot);assert.ok(selected>=0);
   await page.locator('#customerReturnReceiptLot'+selected).fill('1');
   await page.locator('#customerReturnReceiptDate').fill('2026-10-21');
   await page.locator('#customerReturnReceiptSaleable').check();
   loseReturn=true;
   await page.locator('#customerReturnReceiptSave').click();
   await page.waitForFunction(()=>!customerReturnReceiptView?.busy&&document.getElementById('customerReturnReceiptStatus').textContent.includes('結果尚未確認'),null,{timeout:45000});
   const partial=await facts(fixture),request=partial.source.returnRequests.find(r=>r.id===uiRequest.id);
   assert.equal(request.receivedQty,n+1);assert.equal(request.status,n===0?'PENDING':'RECEIVED');
   assert.equal(partial.source.returnPending,n===0);assert.equal(partial.inventory.onHand,uiBefore.inventory.onHand+n+1);
   const matching=calls.filter(row=>row.name==='receiveV2CustomerReturn'&&row.data.requestId===uiRequest.id);
   const intent=matching.at(-1).data;
   assert.equal(intent.shipmentId,chosenShipment.id);assert.deepEqual(intent.selections,[{lotId:chosenLot,qty:1}]);
   const pendingKey='v2-return-receipt:'+encodeURIComponent(fixture.accounts.warehouse.uid)+':'+encodeURIComponent(fixture.sourceId);
   const raw=await page.evaluate(key=>sessionStorage.getItem(key),pendingKey);assert.equal(JSON.parse(raw).intent.operationId,intent.operationId);
   await siteOpen(page,'warehouse');await openReturnQueue();
   const recover=page.locator('#customerReturnQueue button[data-return-recovery="'+fixture.sourceId+'"]');await recover.waitFor({state:'visible'});
   assert.equal(calls.filter(row=>row.name==='receiveV2CustomerReturn'&&row.data.requestId===uiRequest.id).length,n*2+1,'reload must not submit');
   await recover.click();await page.locator('#customerReturnReceiptOverlay').waitFor({state:'visible'});
   assert.equal(await page.locator('#customerReturnReceiptShipment').count(),0,'pending source stays frozen');
   await page.locator('#customerReturnReceiptSave').click();
   await page.waitForFunction(key=>!sessionStorage.getItem(key),pendingKey,{timeout:45000});
   await page.locator('#customerReturnReceiptOverlay').waitFor({state:'hidden'});
   const replay=calls.filter(row=>row.name==='receiveV2CustomerReturn'&&row.data.requestId===uiRequest.id);
   assert.deepEqual(replay.at(-1).data,intent);assert.deepEqual(await facts(fixture),partial,'confirmation must not credit stock twice');
  }
  const uiAfter=await facts(fixture),uiAfterStock=await stockFacts();
  assert.equal(calls.filter(row=>row.name==='receiveV2CustomerReturn').length,uiReceiptsBefore+4);
  assert.equal(uiAfter.source.returnedQty,4);assert.equal(uiAfter.source.deliveredQty,4);assert.equal(uiAfter.source.isDelivered,false);
  assert.equal(uiAfter.source.items[0].reservedQty,5);assert.equal(uiAfter.source.items[0].shortageQty,3);
  assert.deepEqual(uiAfter.source.deliveryRecords,uiBefore.source.deliveryRecords);assert.deepEqual(uiAfter.source.warehouseShipmentRecords,uiBefore.source.warehouseShipmentRecords);
  assert.deepEqual(uiAfter.stocks[1],uiBefore.stocks[1]);assert.deepEqual(uiAfter.targets,uiBefore.targets);
  for(const field of ['inventoryLotCosts','supply','demand','receipts'])assert.deepEqual(uiAfterStock[field],uiBeforeStock[field]);
  assert.deepEqual(ledgerBalances(uiAfterStock.inventoryReservations),ledgerBalances(uiBeforeStock.inventoryReservations));
  const proofs=(await db.collection('customerReturnReceipts').where('orderId','==',fixture.sourceId).get()).docs.map(d=>d.data()).filter(r=>r.requestId===uiRequest.id);
  assert.equal(proofs.length,2);for(const proof of proofs){assert.equal(proof.receivedBy,fixture.accounts.warehouse.uid);assert.equal(proof.quality,'SALEABLE');assert.equal(proof.warehouseId,chosenShipment.warehouseId);}
  console.log('Full site '+width+'px: original warehouse queue and explicit lot form received 1+1 CLOSE; both real successful replies lost, reload offered immutable confirmation even after returnPending=false; original proofs/stock/other holds verified without duplicate credit.');
  // Continue the SAME 12-unit source after all physical receipts, shipments,
  // acknowledgements and CLOSE returns. The original purchaser should still
  // see exactly the three units that were never ordered.
  const remainingBefore=(await demandRef.get()).data();
  assert.equal(remainingBefore.requestedQty,7);
  assert.equal(remainingBefore.orderedQty,4);
  assert.equal(remainingBefore.receivedQty,4);
  assert.equal(remainingBefore.remainingToOrderQty,3);
  assert.equal(remainingBefore.remainingToReceiveQty,0);
  const priorPoCount=(await db.collection('purchaseOrders').get()).size;
  const priorSupplyCount=(await db.collection('supplyOrders').get()).size;
  await siteLogout(page);await siteLogin(page,fixture.accounts.purchaser,'purchaser');
  await siteNav(page,'purchasing');
  // This browser previously visited receiving and dispatch; the selected
  // work-card survives a role handoff. Explicitly choose ordering and use
  // the ORIGINAL refresh action before expecting a new source projection.
  await page.locator('#purchase-card-ordering').click();
  await page.waitForFunction(()=>!pendingPurchaseLoading);
  await page.evaluate(()=>loadPendingPurchaseOrders(true));
  await page.waitForFunction(()=>!pendingPurchaseLoading&&procurementDemandLoaded);
  const status=await page.locator('#purchasePendingStatus').textContent();
  assert.doesNotMatch(status,/讀取失敗/);
  const remainingRow=page.locator('#purchasePendingBody tr').filter({hasText:fixture.sourceId});
  assert.equal(await remainingRow.count(),1);
  await remainingRow.getByRole('button',{name:'產生採購單'}).click();
  await page.locator('#poModalOverlay.active').waitFor({state:'visible'});
  await page.waitForFunction(()=>poNoReady&&!poNoLoading);
  const remainingProposal=await page.evaluate(()=>poItems.map(row=>({
   orderId:row.orderId,itemId:row.itemId,productId:row.productId,qty:row.qty
  })));
  assert.deepEqual(remainingProposal,[{
   orderId:fixture.sourceId,itemId:'S',productId:fixture.productKey,qty:3
  }]);
  await page.evaluate(()=>{window.poPdfOutputs=[];printSavedPoDocument=async(poNo,vendor)=>{
   if(!poListCache.some(row=>row.id===poNo))throw Error('PDF before remaining PO commit');
   window.poPdfOutputs.push({poNo,vendor});
  };});
  await page.locator('#poDate').fill('2026-10-21');
  // A user may enter the supplier before editing quantity and price. Those
  // unrelated line updates must not silently discard the supplier header.
  await page.locator('#poVendorName').fill('測試供應商');
  await page.locator('#poItemsBody input[onchange*="qty"]').fill('3');
  await page.locator('#poItemsBody input[onchange*="qty"]').blur();
  await page.locator('#poItemsBody input[onchange*="unitPrice"]').fill('20');
  await page.locator('#poItemsBody input[onchange*="unitPrice"]').blur();
  const priorPurchaseCalls=calls.filter(row=>row.name==='commitV2FormalPurchase').length;
  // Preserve the pre-submit form state when the UI declines the second PO.
  const beforeRemainingSubmit=await page.evaluate(()=>({
   poNo:document.querySelector('#poNo')?.textContent,
   vendor:document.querySelector('#poVendorName')?.value,
   date:document.querySelector('#poDate')?.value,
   items:poItems.map(item=>({qty:item.qty,unitPrice:item.unitPrice,orderId:item.orderId,itemId:item.itemId})),
   editingId:poEditingId,directStock:poDirectStockMode,
   buttonDisabled:document.querySelector('#printPurchaseOrderBtn')?.disabled,
   buttonText:document.querySelector('#printPurchaseOrderBtn')?.textContent
  }));
  await page.locator('#printPurchaseOrderBtn').click();
  // The click handler starts asynchronously: saveInProgress is initially false.
  // Never treat its initial idle state as proof that the purchase finished.
  try{
   await page.waitForFunction(()=>window.poPdfOutputs.length===1,null,{timeout:45000});
  }catch(error){
   const earlyPurchaseState=await page.evaluate(()=>({pdf:window.poPdfOutputs,status:document.querySelector('#poSaveStatus')?.textContent||'',saveInProgress:poSaveInProgress,pending:poIncomingSyncPending,buttonDisabled:document.querySelector('#printPurchaseOrderBtn')?.disabled}));
   assert.fail('Remaining PO PDF did not complete: '+JSON.stringify({beforeRemainingSubmit,earlyPurchaseState,purchaseCallCount:calls.filter(row=>row.name==='commitV2FormalPurchase').length-priorPurchaseCalls}));
  }
  const purchaseDiagnostic=await page.evaluate(()=>({pending:poIncomingSyncPending,pdf:window.poPdfOutputs,status:document.querySelector('#poSaveStatus')?.textContent||'',modal:document.querySelector('#poModalOverlay')?.className||''}));
  assert.equal(purchaseDiagnostic.pdf.length,1,JSON.stringify(purchaseDiagnostic));
  // The original UI explicitly syncs incoming stock in the background after PDF.
  // A transient pending flag is not a failed purchase; verify persisted facts below.
  assert.equal(calls.filter(row=>row.name==='commitV2FormalPurchase').length,priorPurchaseCalls);
  assert.equal((await db.collection('supplyOrders').get()).size,priorSupplyCount);
  assert.deepEqual(await facts(fixture),uiAfter,'second document alone cannot change purchase or stock');
  assert.deepEqual((await demandRef.get()).data(),remainingBefore);
  await page.locator('#confirmPoOrderedBtn').click();
  await page.waitForFunction(()=>!formalPurchaseRecoveryRunning&&!pendingFormalPurchase()&&poListCache.find(po=>po.id===poEditingId)?.status==='ORDERED',null,{timeout:45000});
  const nextPurchaseCalls=calls.filter(row=>row.name==='commitV2FormalPurchase');
  assert.equal(nextPurchaseCalls.length,priorPurchaseCalls+1);
  const remainingIntent=nextPurchaseCalls.at(-1).data;
  assert.equal(remainingIntent.items.length,1);
  assert.equal(remainingIntent.items[0].orderId,fixture.sourceId);
  assert.equal(remainingIntent.items[0].itemId,'S');
  assert.equal(remainingIntent.items[0].qty,3);
  assert.equal(remainingIntent.items[0].unitCost,20);
  assert.notEqual(remainingIntent.poNo,commitIntent.poNo);
  assert.deepEqual(await page.evaluate(()=>window.poPdfOutputs),[{
   poNo:remainingIntent.poNo,vendor:'測試供應商'
  }]);
  const remainingSupplyId='po-'+encodeURIComponent(remainingIntent.poNo)+'-0';
  // PDF completes before the existing incoming checkpoint; wait for the actual
  // authoritative supply state, not the transient UI flag or a fixed delay.
  const incomingDeadline=Date.now()+45000;
  let remainingSupply;
  do {
   remainingSupply=(await db.collection('supplyOrders').doc(remainingSupplyId).get()).data();
   if(remainingSupply?.incomingRegisteredQty===3)break;
   await new Promise(resolve=>setTimeout(resolve,250));
  }while(Date.now()<incomingDeadline);
  assert.equal(remainingSupply?.incomingRegisteredQty,3,'second PO incoming checkpoint did not finish');
  assert.equal(remainingSupply.qty,3);
  assert.equal(remainingSupply.receivedQty,0);
  assert.equal(remainingSupply.incomingRegisteredQty,3);
  assert.equal(remainingSupply.orderId,fixture.sourceId);
  assert.equal(remainingSupply.itemId,'S');
  const remainingDemand=(await demandRef.get()).data();
  assert.equal(remainingDemand.requestedQty,7);
  assert.equal(remainingDemand.orderedQty,7);
  assert.equal(remainingDemand.receivedQty,4);
  assert.equal(remainingDemand.remainingToOrderQty,0);
  assert.equal(remainingDemand.remainingToReceiveQty,3);
  const afterRemaining=await facts(fixture);
  assert.equal(afterRemaining.source.items[0].supplyOrderedQty,7);
  assert.equal(afterRemaining.source.items[0].receivedQty,4);
  assert.equal(afterRemaining.source.items[0].reservedQty,5);
  assert.equal(afterRemaining.source.items[0].shortageQty,3);
  assert.equal(afterRemaining.source.items[0].warehouseShippedQty,4);
  assert.equal(afterRemaining.source.deliveredQty,4);
  assert.equal(afterRemaining.inventory.incoming,3);
  assert.equal(afterRemaining.stocks[0].incoming,3);
  for(const field of ['onHand','reserved','transferFreeInTransit']){
   assert.equal(afterRemaining.inventory[field],uiAfter.inventory[field]);
   assert.equal(afterRemaining.stocks[0][field],uiAfter.stocks[0][field]);
  }
  assert.deepEqual(afterRemaining.stocks[1],uiAfter.stocks[1]);
  assert.deepEqual(afterRemaining.lots,uiAfter.lots);
  assert.deepEqual(afterRemaining.targets,uiAfter.targets);
  for(const field of ['deliveryRecords','warehouseShipmentRecords','returnRecords','returnRequests'])
   assert.deepEqual(afterRemaining.source[field],uiAfter.source[field]);
  assert.deepEqual((await db.collection('supplyOrders').doc(supplyId).get()).data(),uiAfterStock.supply);
  assert.equal((await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).size,2);
  assert.equal((await db.collection('receipts').where('supplyOrderId','==',remainingSupplyId).get()).size,0);
  const remainingRetry=await commitV2FormalPurchase(db,buyer,remainingIntent);
  assert.equal(remainingRetry.status,'already-applied');
  assert.deepEqual(await facts(fixture),afterRemaining);
  assert.deepEqual((await demandRef.get()).data(),remainingDemand);
  await assert.rejects(commitV2FormalPurchase(db,buyer,{
   ...remainingIntent,items:[{...remainingIntent.items[0],qty:2}]
  }),{code:'already-exists'});
  await assert.rejects(commitV2FormalPurchase(db,buyer,{
   ...remainingIntent,poNo:remainingIntent.poNo+'-EXTRA',
   items:[{...remainingIntent.items[0],qty:1}]
  }),{code:'failed-precondition'});
  assert.equal((await db.collection('purchaseOrders').get()).size,priorPoCount+1);
  assert.equal((await db.collection('supplyOrders').get()).size,priorSupplyCount+1);
  assert.deepEqual(await facts(fixture),afterRemaining);
  console.log('Full site '+width+'px: original purchaser reopened remaining 3/7 shortage after CLOSE returns; second PO and incoming registered once, same-ID replay and overpurchase blocked without extra stock, receipts or shipment.');

  // SAME source after its four CLOSE returns: receive the second PO through
  // the original warehouse UI, without changing prior fulfillment evidence.
  await siteLogout(page);await siteLogin(page,fixture.accounts.warehouse,'warehouse');
  await siteNav(page,'inventory');await page.locator('#inventoryReceivingTabBtn').click();
  await page.locator('[data-inventory-receiving-kind="purchase"]').click();
  async function openRemainingReceipt(qty,lot){
   await page.locator('#inventoryReceivingBody button[data-receipt-supply="'+remainingSupplyId+'"]').first().click();
   await page.locator('#poReceiptBatchBody .po-receive-qty').fill(String(qty));
   await page.locator('#poReceiptBatchBody .po-receive-lot').fill(lot);
   await page.locator('#poReceiptBatchBody .po-receive-expiry').fill('2028-06-01');
  }
  await openRemainingReceipt(1,'AFTER-CLOSE-FIRST-'+width);
  await page.locator('#savePoReceiptBatchBtn').click();
  await page.waitForFunction(id=>!receiptTaskJobs.has(receiptTaskKey(id))&&supplyReceivingCache.find(row=>row.id===id)?.receivedQty===1,remainingSupplyId,{timeout:45000});
  const partialAfterClose=await facts(fixture);
  assert.equal(partialAfterClose.source.items[0].receivedQty,5);assert.equal(partialAfterClose.source.items[0].reservedQty,6);assert.equal(partialAfterClose.source.items[0].shortageQty,2);
  assert.equal(partialAfterClose.inventory.onHand,afterRemaining.inventory.onHand+1);assert.equal(partialAfterClose.inventory.reserved,afterRemaining.inventory.reserved+1);assert.equal(partialAfterClose.inventory.incoming,2);
  assert.deepEqual(partialAfterClose.stocks[1],afterRemaining.stocks[1]);assert.deepEqual(partialAfterClose.targets,afterRemaining.targets);
  await openRemainingReceipt(2,'AFTER-CLOSE-FINAL-'+width);
  loseReceipt=true;await page.locator('#savePoReceiptBatchBtn').click();
  await page.waitForFunction(id=>receiptTaskJobs.get(receiptTaskKey(id))?.state==='error',remainingSupplyId,{timeout:45000});
  const finalAfterCloseIntent=calls.filter(row=>row.name==='receiveV2Supply'&&row.data.supplyId===remainingSupplyId).at(-1).data;
  const fullyReceived=await facts(fixture),lastSupply=(await db.collection('supplyOrders').doc(remainingSupplyId).get()).data(),lastDemand=(await demandRef.get()).data();
  assert.equal(fullyReceived.inventory.onHand,afterRemaining.inventory.onHand+3);assert.equal(fullyReceived.inventory.reserved,afterRemaining.inventory.reserved+3);assert.equal(fullyReceived.inventory.incoming,0);
  assert.equal(fullyReceived.source.items[0].receivedQty,7);assert.equal(fullyReceived.source.items[0].reservedQty,8);assert.equal(fullyReceived.source.items[0].shortageQty,0);assert.equal(fullyReceived.source.items[0].dispatchPreparedQty,9);
  assert.equal(lastSupply.status,'RECEIVED');assert.equal(lastSupply.receivedQty,3);assert.equal(lastSupply.incomingRegisteredQty,0);
  assert.equal(lastDemand.orderedQty,7);assert.equal(lastDemand.receivedQty,7);assert.equal(lastDemand.remainingToOrderQty,0);assert.equal(lastDemand.remainingToReceiveQty,0);
  assert.equal(fullyReceived.lots.length,afterRemaining.lots.length+2);assert.deepEqual(fullyReceived.stocks[1],afterRemaining.stocks[1]);assert.deepEqual(fullyReceived.targets,afterRemaining.targets);
  for(const field of ['warehouseShipmentRecords','deliveryRecords','deliveryHistory','returnRecords','returnHistory','returnRequests','deliveredQty','returnedQty','isDelivered'])assert.deepEqual(fullyReceived.source[field],afterRemaining.source[field]);
  assert.deepEqual((await db.collection('supplyOrders').doc(supplyId).get()).data(),uiAfterStock.supply);
  const receiptProofs=(await db.collection('receipts').where('supplyOrderId','==',remainingSupplyId).get()).docs.map(doc=>doc.data());
  assert.equal(receiptProofs.length,2);assert.deepEqual(receiptProofs.map(row=>row.qty).sort(),[1,2]);
  for(const proof of receiptProofs){assert.equal(proof.reservationLocationSchemaVersion,2);assert.equal(proof.createdByUid,fixture.accounts.warehouse.uid);assert.equal(proof.createdByRole,'warehouse');}
  await siteOpen(page,'warehouse');await siteNav(page,'inventory');
  await page.locator('#receiptTaskStatus button').filter({hasText:'用原資料重試'}).click();
  await page.waitForFunction(id=>!receiptTaskJobs.has(receiptTaskKey(id)),remainingSupplyId,{timeout:45000});
  assert.deepEqual(calls.filter(row=>row.name==='receiveV2Supply'&&row.data.supplyId===remainingSupplyId).at(-1).data,finalAfterCloseIntent);
  assert.deepEqual(await facts(fixture),fullyReceived);assert.deepEqual((await demandRef.get()).data(),lastDemand);
  assert.deepEqual((await db.collection('supplyOrders').doc(remainingSupplyId).get()).data(),lastSupply);
  assert.equal((await db.collection('receipts').where('supplyOrderId','==',remainingSupplyId).get()).size,2);
  console.log('Full site '+width+'px: after shipment, delivery and four CLOSE returns, original warehouse received remaining PO 1+2; final successful reply lost, reload replay kept two receipts/lots and preserved all prior fulfillment and other warehouse.');

  // Ship the five ORIGINAL holds from the OTHER warehouse using its actual
  // location row. Original item.warehouseId remains A throughout this action.
  async function openOtherWarehouseBatch(){
   await siteNav(page,'inventory');await page.locator('#inventoryShippingTabBtn').click();
   await page.waitForFunction(()=>orderWorkQueueReady&&!orderWorkQueueError&&warehouseMasterCache.length>0,null,{timeout:45000});
   const main=await page.evaluate(()=>defaultWarehouse()?.id||'');
   await page.locator(main===fixture.warehouseIds[1]?'#inventoryShippingMainBtn':'#inventoryShippingBranchBtn').click();
   const row=page.locator('#inventoryShippingBody tr[data-shipping-warehouse="'+fixture.warehouseIds[1]+'"]').filter({hasText:fixture.sourceId});
   await row.locator('input[type="checkbox"]').check();await page.locator('#warehouseShippingBatchBtn').click();
   await page.locator('#warehouseShippingBatchConfirm').waitFor({state:'visible'});
  }
  await openOtherWarehouseBatch();assert.equal(await page.locator('[data-batch-qty="0"]').inputValue(),'5');
  await page.locator('#warehouseShippingBatchDate').fill('2026-10-21');
  loseShipment=true;await page.locator('#warehouseShippingBatchConfirm').click();
  await page.waitForFunction(()=>document.getElementById('warehouseShippingBatchConfirm')?.textContent==='重試未完成品項',null,{timeout:45000});
  const otherShipmentIntent=calls.filter(row=>row.name==='shipV2WarehouseItem').at(-1).data;
  assert.equal(otherShipmentIntent.warehouseId,fixture.warehouseIds[1]);assert.equal(otherShipmentIntent.quantity,5);
  const otherShipped=await facts(fixture),newShipment=otherShipped.source.warehouseShipmentRecords.at(-1);
  assert.equal(otherShipped.source.items[0].warehouseId,fixture.warehouseIds[0]);
  assert.equal(otherShipped.source.items[0].warehouseShippedQty,9);assert.equal(otherShipped.source.items[0].reservedQty,3);assert.equal(otherShipped.source.items[0].shortageQty,0);assert.equal(otherShipped.source.items[0].dispatchPreparedQty,9);
  assert.equal(otherShipped.inventory.onHand,fullyReceived.inventory.onHand-5);assert.equal(otherShipped.inventory.reserved,fullyReceived.inventory.reserved-5);assert.equal(otherShipped.inventory.incoming,0);
  assert.deepEqual(otherShipped.stocks[0],fullyReceived.stocks[0]);assert.equal(otherShipped.stocks[1].onHand,fullyReceived.stocks[1].onHand-5);assert.equal(otherShipped.stocks[1].reserved,fullyReceived.stocks[1].reserved-5);
  assert.deepEqual(otherShipped.targets,fullyReceived.targets);assert.deepEqual((await demandRef.get()).data(),lastDemand);
  for(const field of ['deliveryRecords','returnRecords','returnRequests','deliveredQty','returnedQty','isDelivered'])assert.deepEqual(otherShipped.source[field],fullyReceived.source[field]);
  require('../modules/fulfillment-core').validateShipmentMovement(newShipment,(await db.collection('inventoryMovements').doc(newShipment.movementId).get()).data(),{orderId:fixture.sourceId,itemId:'S',productKey:fixture.productKey});
  await siteOpen(page,'warehouse');await openOtherWarehouseBatch();
  assert.equal(await page.locator('[data-batch-qty="0"]').inputValue(),'5');
  await page.locator('#warehouseShippingBatchConfirm').click();await page.locator('#warehouseLogisticsOverlay.active').waitFor({state:'hidden'});
  assert.deepEqual(calls.filter(row=>row.name==='shipV2WarehouseItem').at(-1).data,otherShipmentIntent);
  assert.deepEqual(await facts(fixture),otherShipped);assert.deepEqual((await demandRef.get()).data(),lastDemand);
  assert.equal(otherShipped.source.warehouseShipmentRecords.length,3);
  console.log('Full site '+width+'px: original other-warehouse row shipped its five held units after final receiving; successful reply lost, reload retained frozen warehouse/quantity/id and one debit, source warehouse and prior fulfillment unchanged.');

  // The original owner acknowledges this OTHER-warehouse shipment after the
  // earlier CLOSE returns. Delivery consumes shipment quota, never stock.
  const otherDeliveryPhysicalFacts=async()=>({...await stockFacts(),
   remainingSupply:(await db.collection('supplyOrders').doc(remainingSupplyId).get()).data(),
   remainingReceipts:(await db.collection('receipts').where('supplyOrderId','==',remainingSupplyId).get()).docs
    .map(doc=>({id:doc.id,...doc.data()})).sort((a,b)=>a.id.localeCompare(b.id))});
  const beforeOtherDelivery=await otherDeliveryPhysicalFacts();
  await siteLogout(page);await siteLogin(page,fixture.accounts.sales,'sales');
  await openCustomerDelivery();
  const otherDeliveryOption=page.locator('#deliveryShipmentId option[value="'+newShipment.id+'"]');
  assert.match(await otherDeliveryOption.textContent(),new RegExp(fixture.warehouseIds[1]));
  assert.match(await otherDeliveryOption.textContent(),/待確認 5/);
  await page.locator('#deliveryShipmentId').selectOption(newShipment.id);
  await page.locator('#deliveryDate').fill('2026-10-22');await page.locator('#deliveryQty').fill('2');
  await page.locator('#deliveryNotes').fill('另一倉第一批兩件送達');
  loseDelivery=true;await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  const otherDeliveryIntent=calls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data;
  assert.equal(otherDeliveryIntent.shipmentId,newShipment.id);assert.equal(otherDeliveryIntent.quantity,2);
  for(const id of ['deliveryDate','deliveryQty','deliveryNotes'])assert.equal(await page.locator('#'+id).isDisabled(),true);
  assert.notEqual(otherDeliveryIntent.operationId,finalDeliveryIntent.operationId);
  const otherPartDelivered=await facts(fixture);
  assert.equal(otherPartDelivered.source.deliveredQty,6);assert.equal(otherPartDelivered.source.deliveryRecords.length,4);
  assert.equal(otherPartDelivered.source.deliveryRecords.at(-1).warehouseId,fixture.warehouseIds[1]);
  assert.deepEqual(await otherDeliveryPhysicalFacts(),beforeOtherDelivery);
  await siteOpen(page,'sales');await openCustomerDelivery();
  assert.equal(await page.locator('#deliveryShipmentId').inputValue(),newShipment.id);
  assert.equal(await page.locator('#deliveryShipmentId').isDisabled(),true);
  assert.equal(await page.locator('#deliveryQty').inputValue(),'2');
  assert.equal(await page.locator('#deliveryQty').isDisabled(),true);
  await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  assert.deepEqual(calls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data,otherDeliveryIntent);
  assert.deepEqual(await facts(fixture),otherPartDelivered);
  assert.deepEqual(await otherDeliveryPhysicalFacts(),beforeOtherDelivery);

  await page.locator('#openPartialDeliveryBtn').click();
  assert.match(await otherDeliveryOption.textContent(),/待確認 3/);
  for(const id of ['deliveryDate','deliveryQty','deliveryNotes'])assert.equal(await page.locator('#'+id).isDisabled(),false);
  await page.locator('#deliveryShipmentId').selectOption(newShipment.id);
  await page.locator('#deliveryDate').fill('2026-10-22');await page.locator('#deliveryQty').fill('3');
  await page.locator('#deliveryNotes').fill('另一倉其餘三件送達');
  loseDelivery=true;await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  const otherFinalDeliveryIntent=calls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data;
  assert.equal(otherFinalDeliveryIntent.shipmentId,newShipment.id);assert.equal(otherFinalDeliveryIntent.quantity,3);
  assert.notEqual(otherFinalDeliveryIntent.operationId,otherDeliveryIntent.operationId);
  const otherAllDelivered=await facts(fixture);
  assert.equal(otherAllDelivered.source.deliveredQty,9);assert.equal(otherAllDelivered.source.items[0].deliveredQty,9);
  assert.equal(otherAllDelivered.source.deliveryRecords.length,5);assert.equal(otherAllDelivered.source.isDelivered,false);
  for(const field of ['warehouseShipmentRecords','returnRecords','returnHistory','returnRequests','returnedQty'])
   assert.deepEqual(otherAllDelivered.source[field],otherShipped.source[field]);
  for(const field of ['reservedQty','shortageQty','dispatchPreparedQty','warehouseShippedQty','returnedQty'])
   assert.deepEqual(otherAllDelivered.source.items[0][field],otherShipped.source.items[0][field]);
  assert.deepEqual(otherAllDelivered.source.deliveryRecords.slice(0,3),otherShipped.source.deliveryRecords);
  assert.deepEqual(await otherDeliveryPhysicalFacts(),beforeOtherDelivery);
  await siteOpen(page,'sales');await openCustomerDelivery();
  assert.equal(await page.locator('#deliveryShipmentId').inputValue(),newShipment.id);
  assert.equal(await page.locator('#deliveryShipmentId').isDisabled(),true);
  assert.equal(await page.locator('#deliveryQty').inputValue(),'3');
  await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  assert.deepEqual(calls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data,otherFinalDeliveryIntent);
  assert.deepEqual(await facts(fixture),otherAllDelivered);
  assert.deepEqual(await otherDeliveryPhysicalFacts(),beforeOtherDelivery);
  const afterOtherDeliveryProjection=require('../modules/fulfillment-core').projectOrderShipmentReturns({orderId:fixture.sourceId,
   items:otherAllDelivered.source.items,shipments:otherAllDelivered.source.warehouseShipmentRecords,
   deliveries:otherAllDelivered.source.deliveryRecords,returns:otherAllDelivered.source.returnRecords});
  assert.equal(afterOtherDeliveryProjection.confirmedQty,9);assert.equal(afterOtherDeliveryProjection.pendingDeliveryQty,0);
  assert.equal(afterOtherDeliveryProjection.closedQty,4);assert.equal(afterOtherDeliveryProjection.outstandingQty,3);
  assert.equal(afterOtherDeliveryProjection.isDelivered,false);
  assert.equal(otherAllDelivered.source.deliveryHistory.filter(row=>row.source==='shipment_confirmation').length,5);
  await page.locator('#openPartialDeliveryBtn').click();
  assert.equal(await otherDeliveryOption.count(),0,'fully acknowledged shipment cannot be selected for another new confirmation');
  console.log('Full site '+width+'px: original owner acknowledged OTHER warehouse two plus three after CLOSE returns; both successful replies lost and reloaded with identical frozen intents, five total confirmations, no new stock/reservation/lot/movement writes and three units still outstanding.');

  // Finish the SAME order's three remaining units through original actions.
  // Each final operation succeeds before its response is lost and reloaded.
  await page.locator('#deliveryModalOverlay button[onclick="closeDeliveryModal()"]').click();
  await siteLogout(page);await siteLogin(page,fixture.accounts.purchaser,'purchaser');
  await siteNav(page,'purchasing');await page.locator('#purchase-card-dispatch').click();
  loseDispatch=true;await dispatchButton().click();
  await page.waitForFunction(id=>!pendingDispatchOrderIds.size&&!!pendingDispatchPreparation(id,'S'),fixture.sourceId,{timeout:45000});
  const lastDispatchIntent=calls.filter(row=>row.name==='prepareV2OrderDispatch').at(-1).data;
  assert.equal(lastDispatchIntent.quantity,3);assert.equal(lastDispatchIntent.expectedPreparedQty,9);
  assert.notEqual(lastDispatchIntent.operationId,dispatchIntent.operationId);
  const finalPrepared=await facts(fixture);assert.equal(finalPrepared.source.items[0].dispatchPreparedQty,12);
  assert.deepEqual({...finalPrepared,source:null},{...otherAllDelivered,source:null});
  for(const field of ['warehouseShipmentRecords','deliveryRecords','returnRecords','returnRequests','deliveredQty','returnedQty','isDelivered'])
   assert.deepEqual(finalPrepared.source[field],otherAllDelivered.source[field]);
  assert.deepEqual(await otherDeliveryPhysicalFacts(),beforeOtherDelivery);
  await siteOpen(page,'purchaser');await siteNav(page,'purchasing');await page.locator('#purchase-card-dispatch').click();
  await dispatchButton().filter({hasText:'確認打單結果'}).click();
  await page.waitForFunction(id=>!pendingDispatchOrderIds.size&&!pendingDispatchPreparation(id,'S'),fixture.sourceId,{timeout:45000});
  assert.deepEqual(calls.filter(row=>row.name==='prepareV2OrderDispatch').at(-1).data,lastDispatchIntent);
  assert.deepEqual(await facts(fixture),finalPrepared);
  assert.equal((await db.collection('dispatchRecords').where('orderId','==',fixture.sourceId).get()).size,2);

  await siteLogout(page);await siteLogin(page,fixture.accounts.warehouse,'warehouse');await openShipmentBatch();
  assert.equal(await page.locator('[data-batch-qty="0"]').inputValue(),'3');
  await page.locator('#warehouseShippingBatchDate').fill('2026-10-22');
  loseShipment=true;await page.locator('#warehouseShippingBatchConfirm').click();
  await page.waitForFunction(()=>document.getElementById('warehouseShippingBatchConfirm')?.textContent==='重試未完成品項',null,{timeout:45000});
  const lastShipmentIntent=calls.filter(row=>row.name==='shipV2WarehouseItem').at(-1).data;
  assert.equal(lastShipmentIntent.warehouseId,fixture.warehouseIds[0]);assert.equal(lastShipmentIntent.quantity,3);
  assert.notEqual(lastShipmentIntent.operationId,otherShipmentIntent.operationId);
  const finalShipped=await facts(fixture),lastShipment=finalShipped.source.warehouseShipmentRecords.at(-1);
  assert.equal(finalShipped.source.items[0].warehouseShippedQty,12);assert.equal(finalShipped.source.items[0].reservedQty,0);
  assert.equal(finalShipped.source.items[0].shortageQty,0);assert.equal(finalShipped.source.deliveredQty,9);
  assert.equal(finalShipped.source.isDelivered,false);
  assert.equal(finalShipped.inventory.onHand,finalPrepared.inventory.onHand-3);
  assert.equal(finalShipped.inventory.reserved,finalPrepared.inventory.reserved-3);assert.equal(finalShipped.inventory.incoming,0);
  assert.equal(finalShipped.stocks[0].onHand,finalPrepared.stocks[0].onHand-3);
  assert.equal(finalShipped.stocks[0].reserved,finalPrepared.stocks[0].reserved-3);
  assert.deepEqual(finalShipped.stocks[1],finalPrepared.stocks[1]);assert.deepEqual(finalShipped.targets,finalPrepared.targets);
  assert.deepEqual(finalShipped.source.deliveryRecords,otherAllDelivered.source.deliveryRecords);
  assert.deepEqual(finalShipped.source.returnRecords,otherAllDelivered.source.returnRecords);
  assert.deepEqual((await demandRef.get()).data(),lastDemand);
  require('../modules/fulfillment-core').validateShipmentMovement(lastShipment,
   (await db.collection('inventoryMovements').doc(lastShipment.movementId).get()).data(),
   {orderId:fixture.sourceId,itemId:'S',productKey:fixture.productKey});
  await siteOpen(page,'warehouse');await openShipmentBatch();
  assert.equal(await page.locator('[data-batch-qty="0"]').inputValue(),'3');
  await page.locator('#warehouseShippingBatchConfirm').click();await page.locator('#warehouseLogisticsOverlay.active').waitFor({state:'hidden'});
  assert.deepEqual(calls.filter(row=>row.name==='shipV2WarehouseItem').at(-1).data,lastShipmentIntent);
  assert.deepEqual(await facts(fixture),finalShipped);assert.equal(finalShipped.source.warehouseShipmentRecords.length,4);

  const beforeFinalDelivery=await otherDeliveryPhysicalFacts();
  await siteLogout(page);await siteLogin(page,fixture.accounts.sales,'sales');await openCustomerDelivery();
  await page.locator('#deliveryShipmentId').selectOption(lastShipment.id);
  await page.locator('#deliveryDate').fill('2026-10-22');await page.locator('#deliveryQty').fill('3');
  await page.locator('#deliveryNotes').fill('原來源倉最後三件已送達');
  loseDelivery=true;await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  const lastDeliveryIntent=calls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data;
  assert.equal(lastDeliveryIntent.shipmentId,lastShipment.id);assert.equal(lastDeliveryIntent.quantity,3);
  assert.notEqual(lastDeliveryIntent.operationId,otherFinalDeliveryIntent.operationId);
  const completedSource=await facts(fixture);
  assert.equal(completedSource.source.deliveredQty,12);assert.equal(completedSource.source.items[0].deliveredQty,12);
  assert.equal(completedSource.source.isDelivered,true);assert.equal(completedSource.source.deliveryRecords.length,6);
  assert.deepEqual(await otherDeliveryPhysicalFacts(),beforeFinalDelivery);
  await siteOpen(page,'sales');await openCustomerDelivery();
  assert.equal(await page.locator('#deliveryShipmentId').inputValue(),lastShipment.id);
  assert.equal(await page.locator('#deliveryQty').inputValue(),'3');
  for(const id of ['deliveryShipmentId','deliveryDate','deliveryQty','deliveryNotes'])assert.equal(await page.locator('#'+id).isDisabled(),true);
  await deliverySave.click();
  await page.waitForFunction(id=>!pendingDeliveryOrderIds.size&&!pendingV2DeliveryConfirmation(id),fixture.sourceId,{timeout:45000});
  assert.deepEqual(calls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data,lastDeliveryIntent);
  assert.deepEqual(await facts(fixture),completedSource);assert.deepEqual(await otherDeliveryPhysicalFacts(),beforeFinalDelivery);
  const completedProjection=require('../modules/fulfillment-core').projectOrderShipmentReturns({orderId:fixture.sourceId,
   items:completedSource.source.items,shipments:completedSource.source.warehouseShipmentRecords,
   deliveries:completedSource.source.deliveryRecords,returns:completedSource.source.returnRecords});
  assert.equal(completedProjection.shippedQty,12);assert.equal(completedProjection.confirmedQty,12);
  assert.equal(completedProjection.closedQty,4);assert.equal(completedProjection.outstandingQty,0);
  assert.equal(completedProjection.pendingDeliveryQty,0);assert.equal(completedProjection.isDelivered,true);
  assert.equal(await page.locator('#openPartialDeliveryBtn').isVisible(),false);
  const finalRow=page.locator('#ordersBody > tr').filter({hasText:fixture.sourceId});
  assert.equal(await finalRow.locator('button').filter({hasText:'分批交貨'}).count(),0);
  console.log('Full site '+width+'px: final original dispatch three, source-warehouse shipment three and owner delivery three each lost a successful reply and reloaded the same intent; one final debit, six total confirmations, four CLOSE returns preserved and original order commercially fulfilled with no remaining quota.');

  console.log('Full site '+width+'px: seller restored five free units with seven shortages; lost-reply and stale-cancel retries are immutable.');
  for(const match of read('index.html').matchAll(/<script[^>]+src="([^"?]+)(?:\?[^\"]*)?"/g)){
   if(!match[1].startsWith('https:'))assert.ok(loaded.has('/'+match[1]),'original script loaded: '+match[1]);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Full site '+width+'px: five real role boot/restores, original navigation, seven holds and one handoff passed.');
 }catch(error){
  console.log('Full site '+width+'px diagnostic:',JSON.stringify(await page.evaluate(()=>({role:typeof currentUserRole==='undefined'?'not-booted':currentUserRole,
   loginError:document.getElementById('loginError')?.textContent,feedback:document.getElementById('actionFeedback')?.textContent,
   menu:document.querySelector('.nav-tabs')?.className,scrollTop:document.getElementById('appContainer')?.scrollTop,
   shipping:document.getElementById('inventoryShippingBody')?.textContent,queueReady:orderWorkQueueReady,queueError:orderWorkQueueError,
   locations:typeof v2ShipmentLocationContext==='undefined'?null:{context:v2ShipmentLocationContext,values:[...v2ShipmentLocationCache]},
   shipmentOrders:orderWorkQueueCache.map(o=>({id:o.id,attempt:o.inventoryReservationAttemptId,items:normalizedOrderItems(o)})),warehouses:warehouseMasterCache}))),JSON.stringify(errors));
  throw error;
 }finally{await context.close();}
});

for(const width of [1280,390])test('full site '+width+'px original multi-item purchasing receipt dispatch shipment and delivery keep same-product lines separate',{timeout:300000},async()=>{
 const x=await multiReceiptSiteFixture(width),context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}}),page=await context.newPage();
 const errors=[],external=[],calls=[],purchaseCalls=[],dialogs=[],logisticsCalls=[],dropLogistics=new Set();let lose=false,losePurchase=true;
 await context.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;window.YUSHIN_FORMAL_PURCHASE_EMULATOR=true;window.YUSHIN_V2_RECEIVING_EMULATOR=true;window.YUSHIN_V2_DISPATCH_EMULATOR=true;window.YUSHIN_V2_SHIPMENT_EMULATOR=true;window.YUSHIN_V2_DELIVERY_EMULATOR=true;window.YUSHIN_V2_RETURN_RECEIPT_EMULATOR=true;window.YUSHIN_V2_LIFECYCLE_EMULATOR=true;});
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',d=>{dialogs.push(d.message());return d.type()==='confirm'?d.accept():d.dismiss();});
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){external.push(url.hostname);await route.abort();return;}
  if(url.port==='5001'&&request.method()==='POST'&&url.pathname.endsWith('/commitV2FormalPurchase')){
   const data=request.postDataJSON().data;assert.ok((await request.allHeaders()).authorization?.startsWith('Bearer '));
   assert.equal(data.actorUid,undefined);assert.equal(data.actorRole,undefined);purchaseCalls.push(data);
   if(losePurchase){losePurchase=false;const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');return;}
  }
  if(url.port==='5001'&&request.method()==='POST'&&url.pathname.endsWith('/receiveV2Supply')){
   const data=request.postDataJSON().data;assert.ok((await request.allHeaders()).authorization?.startsWith('Bearer '));
   assert.equal(data.actorUid,undefined);assert.equal(data.actorRole,undefined);calls.push(data);
   if(lose){lose=false;const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');return;}
  }
  if(url.port==='5001'&&request.method()==='POST'&&['prepareV2OrderDispatch','shipV2WarehouseItem','confirmV2ShipmentDelivery','receiveV2CustomerReturn','setV2OrderLifecycle'].includes(url.pathname.split('/').at(-1))){
   const name=url.pathname.split('/').at(-1),data=request.postDataJSON().data;
   assert.ok((await request.allHeaders()).authorization?.startsWith('Bearer '));assert.equal(data.actorUid,undefined);assert.equal(data.actorRole,undefined);
   logisticsCalls.push({name,data});const key=name+':'+(name==='setV2OrderLifecycle'?data.nextStatus:data.itemId);
   if(dropLogistics.has(key)){dropLogistics.delete(key);const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');return;}
  }
  await route.continue();
 });
 try{
  const beforePurchase=await x.snapshot();assert.deepEqual(beforePurchase.po,[]);assert.deepEqual(beforePurchase.supplies,[]);
  assert.deepEqual(beforePurchase.inventory.map(i=>i.incoming),[0,0]);
  await siteOpen(page);await siteLogin(page,x.accounts.purchaser,'purchaser');await siteNav(page,'purchasing');
  const pendingRow=id=>page.locator('#purchasePendingBody tr').filter({hasText:x.orderId})
   .filter({has:page.locator('button[onclick*="'+id+'"]')});
  await pendingRow('I3').waitFor({state:'visible'});
  // The existing warehouse rule must reject a mixed-warehouse selection
  // before any document, supply, demand or stock change.
  for(const id of ['I1','I2'])await pendingRow(id).locator('.pending-purchase-batch-select').check();
  await page.locator('#purchasePendingBatchPoBtn').click();
  await page.waitForFunction(()=>!document.getElementById('purchasePendingBatchPoBtn')?.disabled);
  assert.ok(dialogs.some(message=>message.includes('不同入庫倉庫')));assert.equal(purchaseCalls.length,0);
  assert.equal(await page.locator('#poModalOverlay.active').count(),0);assert.deepEqual(await x.snapshot(),beforePurchase);
  await pendingRow('I2').locator('.pending-purchase-batch-select').uncheck();
  await pendingRow('I3').locator('.pending-purchase-batch-select').check();
  await page.locator('#purchasePendingBatchPoBtn').click();
  await page.locator('#poModalOverlay.active').waitFor({state:'visible'});
  async function purchaseCurrentDraft(itemIds,drop){
   await page.waitForFunction(()=>poNoReady&&!poNoLoading&&!poDraftLoading);
   const proposed=await page.evaluate(()=>poItems.map(item=>({itemId:item.itemId,qty:item.qty,warehouseId:item.warehouseId})));
   assert.deepEqual(proposed.map(i=>i.itemId).sort(),itemIds.slice().sort());
   const before=await x.snapshot();
   await page.evaluate(()=>{window.poPdfOutputs=[];printSavedPoDocument=async(poNo,vendor)=>{
    if(!poListCache.some(row=>row.id===poNo))throw Error('PDF before document commit');
    window.poPdfOutputs.push({poNo,vendor});
   };});
   assert.equal(await page.locator('#poVendorName').inputValue(),x.supplierName);
   await page.locator('#poDate').fill('2026-10-22');
   for(let i=0;i<itemIds.length;i++){
    const input=page.locator('#poItemsBody input[onchange*="unitPrice"]').nth(i);
    await input.fill('20');await input.blur();
   }
   await page.locator('#printPurchaseOrderBtn').click();
   await page.waitForFunction(()=>!poSaveInProgress&&poEditingId&&window.poPdfOutputs.length===1);
   const poNo=await page.evaluate(()=>poEditingId),draft=(await db.collection('purchaseOrders').doc(poNo).get()).data();
   assert.equal(draft.status,'DRAFT');assert.equal(draft.documentOnly,true);assert.equal(draft.items.length,itemIds.length);
   assert.deepEqual(await x.snapshot(),before,'document/PDF does not purchase or register incoming');
   await page.locator('#confirmPoOrderedBtn').click();
   const pendingKey='formal-po-pending:'+encodeURIComponent(x.accounts.purchaser.uid);
   await page.waitForFunction(({key,drop})=>!formalPurchaseRecoveryRunning&&(drop?!!sessionStorage.getItem(key):!sessionStorage.getItem(key)),{key:pendingKey,drop},{timeout:45000});
   if(drop){
    const intent=purchaseCalls.at(-1),committed=await x.snapshot();
    assert.deepEqual(committed.inventory,before.inventory,'lost response has not yet registered incoming');
    assert.equal(committed.supplies.length,itemIds.length);assert.ok(committed.supplies.every(s=>s.incomingRegisteredQty===0));
    const pending=await page.evaluate(key=>sessionStorage.getItem(key),pendingKey);
    await siteOpen(page,'purchaser');await siteNav(page,'purchasing');
    await page.locator('#confirmFormalPurchasePendingBtn').waitFor({state:'visible'});
    assert.equal(await page.evaluate(key=>sessionStorage.getItem(key),pendingKey),pending);
    assert.deepEqual(await x.snapshot(),committed,'navigation does not automatically confirm procurement');
    await page.locator('#confirmFormalPurchasePendingBtn').click();
    await page.waitForFunction(key=>!sessionStorage.getItem(key),pendingKey,{timeout:45000});
    assert.deepEqual(purchaseCalls.at(-1),intent,'reload retries the original multi-line intent');
   }else await page.locator('#poModalOverlay.active').waitFor({state:'hidden'});
   const saved=(await db.collection('purchaseOrders').doc(poNo).get()).data();
   assert.equal(saved.status,'ORDERED');assert.equal(saved.documentOnly,false);assert.equal(saved.supplyOrderIds.length,itemIds.length);
   return poNo;
  }
  const firstPo=await purchaseCurrentDraft(['I1','I3'],true),firstOrdered=await x.snapshot();
  assert.deepEqual(firstOrdered.order.items[1],beforePurchase.order.items[1],'same-product B line is not purchased with A lines');
  assert.deepEqual(firstOrdered.demands[1],beforePurchase.demands[1]);
  assert.deepEqual(firstOrdered.inventory.map(i=>i.incoming),[3,2]);
  assert.deepEqual(firstOrdered.stocks.map(i=>i.incoming),[3,0,2,0]);
  await pendingRow('I2').waitFor({state:'visible'});
  await pendingRow('I2').getByRole('button',{name:'產生採購單'}).click();
  await page.locator('#poModalOverlay.active').waitFor({state:'visible'});
  await page.waitForFunction(()=>document.getElementById('poSaveStatus')?.textContent?.includes('尚未建立'));
  const secondPo=await purchaseCurrentDraft(['I2'],false);assert.notEqual(secondPo,firstPo);
  const initial=await x.snapshot();
  assert.equal(initial.po.length,2);assert.equal(initial.supplies.length,3);assert.equal(purchaseCalls.length,3);
  assert.deepEqual(initial.inventory.map(i=>i.incoming),[5,2]);assert.deepEqual(initial.stocks.map(i=>i.incoming),[3,2,2,0]);
  assert.deepEqual(initial.order.items.map(i=>i.supplyOrderedQty),[3,2,2]);
  assert.ok(initial.demands.every(d=>d.remainingToOrderQty===0));
  assert.deepEqual(initial.inventory.map(i=>[i.onHand,i.reserved]),[[0,0],[0,0]]);
  x.supplyIds.push(...initial.supplyIds);
  console.log('Full site '+width+'px: original purchase UI rejects mixed warehouses without writes, groups A I1/I3 and separately buys B I2; document/PDF stays read-only for demand/stock, lost multi-line purchase reply reloads identical intent, two POs/three supplies and incoming 5/2 exactly once. Source creation uses real Auth/Client Rules; v2 initialization remains a Service fixture.');
  await siteLogout(page);await siteLogin(page,x.accounts.warehouse,'warehouse');await siteNav(page,'inventory');
  await page.locator('#inventoryReceivingTabBtn').click();
  async function submit(index,qty,drop){
   const supplyId=x.supplyIds[index];
   await page.locator('#inventoryReceivingBody button[data-receipt-supply="'+supplyId+'"]').click();
   await page.locator('#poReceiptBatchBody .po-receive-qty').fill(String(qty));
   await page.locator('#poReceiptBatchBody .po-receive-lot').fill('MULTI-'+width+'-'+index+'-'+qty);
   await page.locator('#poReceiptBatchBody .po-receive-expiry').fill('2028-01-01');
   lose=drop;await page.locator('#savePoReceiptBatchBtn').click();
   await page.waitForFunction(({id,drop})=>drop?receiptTaskJobs.get(receiptTaskKey(id))?.state==='error':!receiptTaskJobs.has(receiptTaskKey(id)),{id:supplyId,drop},{timeout:45000});
   return calls.at(-1);
  }
  async function retry(index,intent,before){
   await siteOpen(page,'warehouse');await siteNav(page,'inventory');
   await page.locator('#receiptTaskStatus button').filter({hasText:'用原資料重試'}).click();
   await page.waitForFunction(id=>!receiptTaskJobs.has(receiptTaskKey(id)),x.supplyIds[index],{timeout:45000});
   assert.deepEqual(calls.at(-1),intent);assert.deepEqual(await x.snapshot(),before);
   await page.locator('#inventoryReceivingTabBtn').click();
  }
  const first=await submit(0,1,true),partial=await x.snapshot();
  assert.deepEqual(partial.order.items.map(i=>[i.receivedQty??0,i.reservedQty,i.shortageQty]),[[1,1,2],[0,0,2],[0,0,2]]);
  assert.deepEqual(partial.order.items.slice(1),initial.order.items.slice(1));
  assert.deepEqual(partial.stocks.slice(1),initial.stocks.slice(1));assert.deepEqual(partial.inventory[1],initial.inventory[1]);
  assert.equal(partial.inventory[0].onHand,1);assert.equal(partial.inventory[0].reserved,1);assert.equal(partial.inventory[0].incoming,4);
  await retry(0,first,partial);
  await submit(1,2,false);const second=await x.snapshot();
  assert.deepEqual(second.order.items[0],partial.order.items[0]);assert.deepEqual(second.order.items[2],partial.order.items[2]);
  assert.equal(second.stocks[1].onHand,2);assert.equal(second.stocks[1].reserved,2);assert.equal(second.stocks[1].incoming,0);
  assert.deepEqual(second.stocks[0],partial.stocks[0]);assert.deepEqual(second.inventory[1],partial.inventory[1]);
  await submit(2,2,false);const third=await x.snapshot();assert.deepEqual(third.order.items.slice(0,2),second.order.items.slice(0,2));
  const last=await submit(0,2,true),complete=await x.snapshot();
  assert.notEqual(last.operationId,first.operationId);
  assert.deepEqual(complete.order.items.map(i=>[i.receivedQty,i.reservedQty,i.shortageQty]),[[3,3,0],[2,2,0],[2,2,0]]);
  assert.deepEqual(complete.order.items.slice(1),third.order.items.slice(1));
  assert.deepEqual(complete.inventory.map(i=>[i.onHand,i.reserved,i.incoming]),[[5,5,0],[2,2,0]]);
  assert.deepEqual(complete.receipts.map(rows=>rows.length),[2,1,1]);assert.equal(complete.inventoryLots.length,4);assert.equal(complete.inventoryLotCosts.length,4);
  assert.ok(complete.demands.every(d=>d.remainingToOrderQty===0&&d.remainingToReceiveQty===0));
  assert.equal(complete.order.deliveredQty,0);assert.equal(complete.order.isDelivered,false);
  assert.deepEqual(complete.order.deliveryRecords,[]);assert.deepEqual(complete.order.returnRecords,[]);
  assert.ok(complete.order.items.every(i=>i.dispatchPreparedQty===0&&i.warehouseShippedQty===0));
  for(let i=0;i<3;i++){assert.equal(complete.supplies[i].status,'RECEIVED');
   assert.deepEqual(complete.views[i],require('../modules/stock-permissions').sanitizeSupply(complete.supplies[i]));assert.equal(complete.views[i].unitCost,undefined);}
  await retry(0,last,complete);assert.equal(calls.length,6);
  for(const id of x.supplyIds)assert.equal(await page.locator('#inventoryReceivingBody button[data-receipt-supply="'+id+'"]').count(),0);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Full site '+width+'px: original warehouse received three lines (same product in A/B and another product), first/final successful replies lost and reloaded identical receipt IDs; four receipts/lots, no sibling overwrite, zero incoming and no dispatch/shipment/delivery.');

  // All three lines have real PO/receipt proofs and holds. Cancel/restore via
  // the original owner UI before dispatch: release/reclaim holds, never goods.
  await siteLogout(page);await siteLogin(page,x.accounts.sales,'sales');
  for(const [nextStatus,label] of [['cancelled','取消訂單'],['normal','恢復訂單']]){
   dropLogistics.add('setV2OrderLifecycle:'+nextStatus);
   await siteOrderAction(page,{sourceId:x.orderId},label);
   await page.waitForFunction(id=>!pendingLifecycleOrderIds.size&&!!pendingV2OrderLifecycle(id),x.orderId,{timeout:45000});
   const after=await x.snapshot(),cancelled=nextStatus==='cancelled';
   assert.equal(after.order.orderStatus,nextStatus);assert.equal(after.order.items.length,3);
   assert.equal(after.order.itemCount,complete.order.itemCount,'lifecycle preserves the source item-count projection');
   assert.deepEqual(after.order.items.map(i=>i.reservedQty),cancelled?[0,0,0]:[3,2,2]);
   assert.deepEqual(after.order.items.map(i=>i.shortageQty),[0,0,0]);
   assert.deepEqual(after.inventory.map(i=>[i.onHand,i.reserved,i.incoming]),cancelled?[[5,0,0],[2,0,0]]:[[5,5,0],[2,2,0]]);
   assert.deepEqual(after.stocks.map(i=>i.reserved),cancelled?[0,0,0,0]:[3,2,2,0]);
   for(const field of ['inventoryLots','inventoryLotCosts','po','supplies','views','receipts'])assert.deepEqual(after[field],complete[field]);
   assert.ok(after.demands.every(d=>cancelled?d.status==='CANCELLED':d.remainingToOrderQty===0&&d.remainingToReceiveQty===0));
   const intent=logisticsCalls.filter(r=>r.name==='setV2OrderLifecycle').at(-1).data;
   assert.deepEqual(intent.itemIds,['I1','I2','I3']);assert.equal(intent.nextStatus,nextStatus);
   await siteOpen(page,'sales');await siteOrderAction(page,{sourceId:x.orderId},'確認前次取消／恢復結果');
   await page.waitForFunction(id=>!pendingV2OrderLifecycle(id),x.orderId,{timeout:45000});
   assert.deepEqual(logisticsCalls.filter(r=>r.name==='setV2OrderLifecycle').at(-1).data,intent);
   assert.deepEqual(await x.snapshot(),after,'lifecycle confirmation cannot release or reclaim holds twice');
  }
  const beforeDispatch=await x.snapshot();assert.equal(beforeDispatch.order.orderLifecycleHistory.length,2);
  const oldCancel=logisticsCalls.find(r=>r.name==='setV2OrderLifecycle'&&r.data.nextStatus==='cancelled').data;
  const replay=await page.evaluate(async intent=>(await firebase.app().functions('asia-east1').httpsCallable('setV2OrderLifecycle')(intent)).data,oldCancel);
  assert.equal(replay.status,'already-applied');assert.deepEqual(await x.snapshot(),beforeDispatch,'old cancellation cannot undo later restore');
  console.log('Full site '+width+'px: original owner canceled/restored three received lines across A/B, both successful replies lost and reloaded; all seven holds released/reclaimed once, goods/lots/POs unchanged, old cancellation replay preserved later restore.');

  const physical=async()=>{const {order,...rest}=await x.snapshot();return rest;};
  const receivedPhysical=await physical(),ids=['I1','I2','I3'],quantities=[3,2,2];
  await siteLogout(page);await siteLogin(page,x.accounts.purchaser,'purchaser');
  await siteNav(page,'purchasing');await page.locator('#purchase-card-dispatch').click();
  const dispatchButton=id=>page.locator('#purchaseDispatchBody button[onclick*="'+x.orderId+'"][onclick*="'+id+'"]');
  dropLogistics.add('prepareV2OrderDispatch:I2');
  for(const id of ids){
   await dispatchButton(id).click();
   await page.waitForFunction(({orderId,itemId})=>!pendingDispatchOrderIds.size
    &&(itemId==='I2'?!!pendingDispatchPreparation(orderId,itemId):!pendingDispatchPreparation(orderId,itemId)),{orderId:x.orderId,itemId:id},{timeout:45000});
   if(id==='I2'){
    const intent=logisticsCalls.filter(row=>row.name==='prepareV2OrderDispatch').at(-1).data,before=await x.snapshot();
    assert.equal(intent.itemId,id);assert.equal(intent.quantity,2);
    await siteOpen(page,'purchaser');await siteNav(page,'purchasing');await page.locator('#purchase-card-dispatch').click();
    await dispatchButton(id).filter({hasText:'確認打單結果'}).click();
    await page.waitForFunction(orderId=>!pendingDispatchOrderIds.size&&!pendingDispatchPreparation(orderId,'I2'),x.orderId,{timeout:45000});
    assert.deepEqual(logisticsCalls.filter(row=>row.name==='prepareV2OrderDispatch').at(-1).data,intent);
    assert.deepEqual(await x.snapshot(),before);
   }
  }
  const prepared=await x.snapshot();assert.deepEqual(prepared.order.items.map(i=>i.dispatchPreparedQty),quantities);
  assert.deepEqual(await physical(),receivedPhysical);
  assert.equal((await db.collection('dispatchRecords').where('orderId','==',x.orderId).get()).size,3);

  await siteLogout(page);await siteLogin(page,x.accounts.warehouse,'warehouse');
  async function openShipment(id,warehouseId){
   await siteNav(page,'inventory');await page.locator('#inventoryShippingTabBtn').click();
   await page.waitForFunction(()=>orderWorkQueueReady&&!orderWorkQueueError&&warehouseMasterCache.length>0,null,{timeout:45000});
   const main=await page.evaluate(()=>defaultWarehouse()?.id||'');
   await page.locator(main===warehouseId?'#inventoryShippingMainBtn':'#inventoryShippingBranchBtn').click();
   const rows=page.locator('#inventoryShippingBody tr[data-shipping-warehouse="'+warehouseId+'"]').filter({hasText:x.orderId});
   await rows.locator('input[onchange*="'+id+'"]').check();await page.locator('#warehouseShippingBatchBtn').click();
   await page.locator('#warehouseShippingBatchConfirm').waitFor({state:'visible'});
  }
  dropLogistics.add('shipV2WarehouseItem:I2');
  for(const [index,id] of ids.entries()){
   const warehouseIndex=index===1?1:0,warehouseId=x.warehouses[warehouseIndex],productIndex=index===2?1:0,before=await x.snapshot();
   await openShipment(id,warehouseId);assert.equal(await page.locator('[data-batch-qty="0"]').inputValue(),String(quantities[index]));
   await page.locator('#warehouseShippingBatchDate').fill('2026-10-22');await page.locator('#warehouseShippingBatchConfirm').click();
   if(id==='I2')await page.waitForFunction(()=>document.getElementById('warehouseShippingBatchConfirm')?.textContent==='重試未完成品項',null,{timeout:45000});
   else await page.locator('#warehouseLogisticsOverlay.active').waitFor({state:'hidden'});
   const after=await x.snapshot();
   assert.deepEqual(after.order.items.filter(i=>i.itemId!==id),before.order.items.filter(i=>i.itemId!==id));
   assert.equal(after.inventory[productIndex].onHand,before.inventory[productIndex].onHand-quantities[index]);
   assert.equal(after.inventory[productIndex].reserved,before.inventory[productIndex].reserved-quantities[index]);
   assert.deepEqual(after.inventory[1-productIndex],before.inventory[1-productIndex]);
   const changed=productIndex*2+warehouseIndex;
   assert.equal(after.stocks[changed].onHand,before.stocks[changed].onHand-quantities[index]);
   assert.deepEqual(after.stocks.filter((_,i)=>i!==changed),before.stocks.filter((_,i)=>i!==changed));
   assert.equal(after.order.deliveredQty,0);assert.deepEqual(after.order.deliveryRecords,[]);
   if(id==='I2'){
    const intent=logisticsCalls.filter(row=>row.name==='shipV2WarehouseItem').at(-1).data;
    assert.equal(intent.warehouseId,warehouseId);assert.equal(intent.itemId,id);
    await siteOpen(page,'warehouse');await openShipment(id,warehouseId);
    assert.equal(await page.locator('[data-batch-qty="0"]').inputValue(),'2');
    await page.locator('#warehouseShippingBatchConfirm').click();await page.locator('#warehouseLogisticsOverlay.active').waitFor({state:'hidden'});
    assert.deepEqual(logisticsCalls.filter(row=>row.name==='shipV2WarehouseItem').at(-1).data,intent);
    assert.deepEqual(await x.snapshot(),after);
   }
  }
  const shipped=await x.snapshot();assert.equal(shipped.order.warehouseShipmentRecords.length,3);
  assert.deepEqual(shipped.order.items.map(i=>[i.warehouseShippedQty,i.reservedQty,i.shortageQty]),[[3,0,0],[2,0,0],[2,0,0]]);
  assert.ok(shipped.inventory.every(i=>i.onHand===0&&i.reserved===0&&i.incoming===0));
  assert.ok(shipped.inventoryLots.every(lot=>lot.remainingQty===0));
  for(const field of ['po','supplies','views','demands','receipts'])assert.deepEqual(shipped[field],beforeDispatch[field]);
  const shippedPhysical=await physical();
  await siteLogout(page);await siteLogin(page,x.accounts.sales,'sales');
  async function openDelivery(){
   await siteOrderAction(page,{sourceId:x.orderId},'分批交貨');
   await page.locator('#deliveryModalOverlay.active').waitFor({state:'visible'});await page.locator('#deliveryFormPanel').waitFor({state:'visible'});
  }
  await openDelivery();dropLogistics.add('confirmV2ShipmentDelivery:I2');dropLogistics.add('confirmV2ShipmentDelivery:I3');
  const save=page.locator('#deliveryFormPanel button[onclick="saveDeliveryRecord()"]');
  for(const [index,id] of ids.entries()){
   if(index)await page.locator('#openPartialDeliveryBtn').click();
   await page.locator('#deliveryItemId').selectOption(id);
   const shipment=shipped.order.warehouseShipmentRecords.find(row=>row.itemId===id),before=await x.snapshot();
   await page.locator('#deliveryShipmentId').selectOption(shipment.id);
   await page.locator('#deliveryDate').fill('2026-10-22');await page.locator('#deliveryQty').fill(String(quantities[index]));
   await page.locator('#deliveryNotes').fill('多品項 '+id+' 已送達');await save.click();
   await page.waitForFunction(({orderId,lost})=>!pendingDeliveryOrderIds.size
    &&(lost?!!pendingV2DeliveryConfirmation(orderId):!pendingV2DeliveryConfirmation(orderId)),{orderId:x.orderId,lost:index>0},{timeout:45000});
   const after=await x.snapshot();
   assert.deepEqual(after.order.items.filter(i=>i.itemId!==id),before.order.items.filter(i=>i.itemId!==id));
   assert.equal(after.order.items[index].deliveredQty,quantities[index]);
   assert.deepEqual(await physical(),shippedPhysical);
   if(index){
    const intent=logisticsCalls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data;
    assert.equal(intent.itemId,id);assert.equal(intent.shipmentId,shipment.id);
    await siteOpen(page,'sales');await openDelivery();
    assert.equal(await page.locator('#deliveryItemId').inputValue(),id);assert.equal(await page.locator('#deliveryItemId').isDisabled(),true);
    assert.equal(await page.locator('#deliveryShipmentId').inputValue(),shipment.id);
    assert.equal(await page.locator('#deliveryQty').inputValue(),String(quantities[index]));
    await save.click();
    await page.waitForFunction(orderId=>!pendingDeliveryOrderIds.size&&!pendingV2DeliveryConfirmation(orderId),x.orderId,{timeout:45000});
    assert.deepEqual(logisticsCalls.filter(row=>row.name==='confirmV2ShipmentDelivery').at(-1).data,intent);
    assert.deepEqual(await x.snapshot(),after);assert.deepEqual(await physical(),shippedPhysical);
   }
  }
  const done=await x.snapshot();assert.equal(done.order.deliveredQty,7);assert.equal(done.order.isDelivered,true);
  assert.equal(done.order.deliveryRecords.length,3);assert.deepEqual(done.order.items.map(i=>i.deliveredQty),quantities);
  assert.equal(await page.locator('#openPartialDeliveryBtn').isVisible(),false);
  assert.equal(logisticsCalls.filter(row=>row.name==='prepareV2OrderDispatch').length,4);
  assert.equal(logisticsCalls.filter(row=>row.name==='shipV2WarehouseItem').length,4);
  assert.equal(logisticsCalls.filter(row=>row.name==='confirmV2ShipmentDelivery').length,5);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Full site '+width+'px: original three-line paperwork, A/B shipment and per-item customer acknowledgement completed seven goods; same-product siblings preserved, intermediate and full-order lost replies reloaded exact intents, three dispatches/debits/confirmations and zero remaining stock or source holds.');

  // Continue the SAME real order through commercial Client Rules and the
  // original warehouse queue. Same product in A/B must remain item-scoped.
  await page.locator('#deliveryModalOverlay button[onclick="closeDeliveryModal()"]').click();
  await siteOrderAction(page,{sourceId:x.orderId},'退貨');
  await page.locator('#returnFormPanel').waitFor({state:'visible'});
  for(const [id,qty] of [['I1',1],['I2',2]]){
   if(!await page.locator('#returnFormPanel').isVisible())await page.locator('#openReturnFormBtn').click();
   await page.locator('#returnItemId').selectOption(id);
   await page.locator('#returnDate').fill('2026-10-22');await page.locator('#returnQty').fill(String(qty));
   await page.locator('#returnReason').fill('多品項原倉退貨 '+id);await page.locator('#returnSaveBtn').click();
   await page.waitForFunction(({orderId,itemId})=>!customerReturnActionsPending.has(orderId)
    &&ordersCache.find(o=>o.id===orderId)?.returnRequests?.some(r=>r.itemId===itemId),{orderId:x.orderId,itemId:id});
  }
  const requested=await x.snapshot(),requests=requested.order.returnRequests;
  assert.deepEqual(requests.map(r=>[r.itemId,r.qty,r.receivedQty,r.settlement]),[['I1',1,0,'CLOSE'],['I2',2,0,'CLOSE']]);
  assert.deepEqual(await physical(),shippedPhysical,'requests never credit physical stock');
  assert.deepEqual(requested.order.items,done.order.items);
  await page.locator('#deliveryModalOverlay button[onclick="closeDeliveryModal()"]').click();
  await siteLogout(page);await siteLogin(page,x.accounts.warehouse,'warehouse');
  async function returnQueue(){
   await siteNav(page,'inventory');await page.locator('#inventoryReceivingTabBtn').click();
   await page.locator('[data-inventory-receiving-kind="returns"]').click();
   await page.waitForFunction(id=>document.getElementById('customerReturnQueue')?.innerHTML.includes(id),x.orderId);
  }
  await returnQueue();
  const pendingKey='v2-return-receipt:'+encodeURIComponent(x.accounts.warehouse.uid)+':'+encodeURIComponent(x.orderId);
  // Receive B twice before A: global pending must remain true after B closes.
  for(const [id,received] of [['I2',1],['I2',2],['I1',1]]){
   const request=requests.find(r=>r.itemId===id),shipment=shipped.order.warehouseShipmentRecords.find(r=>r.itemId===id);
   const before=await x.snapshot(),lotId=shipment.lotAllocations[0].lotId;
   await page.locator('#customerReturnQueue button[onclick*="'+request.id+'"]').click();
   await page.locator('#customerReturnReceiptOverlay').waitFor({state:'visible'});
   await page.locator('#customerReturnReceiptShipment').selectOption(shipment.id);
   const selected=await page.evaluate(lotId=>customerReturnReceiptView.lots.findIndex(row=>row.lotId===lotId),lotId);
   assert.ok(selected>=0);await page.locator('#customerReturnReceiptLot'+selected).fill('1');
   await page.locator('#customerReturnReceiptDate').fill('2026-10-22');await page.locator('#customerReturnReceiptSaleable').check();
   dropLogistics.add('receiveV2CustomerReturn:'+id);await page.locator('#customerReturnReceiptSave').click();
   await page.waitForFunction(()=>!customerReturnReceiptView?.busy&&document.getElementById('customerReturnReceiptStatus').textContent.includes('結果尚未確認'),null,{timeout:45000});
   const after=await x.snapshot(),intent=logisticsCalls.filter(r=>r.name==='receiveV2CustomerReturn').at(-1).data;
   assert.equal(intent.itemId,id);assert.equal(intent.requestId,request.id);assert.equal(intent.shipmentId,shipment.id);
   assert.equal(intent.warehouseId,shipment.warehouseId);assert.deepEqual(intent.selections,[{lotId,qty:1}]);
   assert.equal(after.order.returnRequests.find(r=>r.id===request.id).receivedQty,received);
   assert.deepEqual(after.order.returnRequests.filter(r=>r.id!==request.id),before.order.returnRequests.filter(r=>r.id!==request.id));
   assert.deepEqual(after.order.items.filter(i=>i.itemId!==id),before.order.items.filter(i=>i.itemId!==id));
   assert.equal(after.order.returnPending,id!=='I1');
   assert.equal(after.inventory[0].onHand,before.inventory[0].onHand+1);assert.equal(after.inventory[0].reserved,0);
   assert.deepEqual(after.inventory[1],before.inventory[1]);
   const stockIndex=id==='I2'?1:0;
   assert.equal(after.stocks[stockIndex].onHand,before.stocks[stockIndex].onHand+1);assert.equal(after.stocks[stockIndex].reserved,0);
   assert.deepEqual(after.stocks.filter((_,i)=>i!==stockIndex),before.stocks.filter((_,i)=>i!==stockIndex));
   const returnedLot=after.inventoryLots.find(l=>l.id===lotId),priorLot=before.inventoryLots.find(l=>l.id===lotId);
   assert.equal(returnedLot.remainingQty,priorLot.remainingQty+1);
   assert.deepEqual(after.inventoryLots.filter(l=>l.id!==lotId),before.inventoryLots.filter(l=>l.id!==lotId));
   for(const field of ['po','supplies','views','demands','receipts','inventoryLotCosts'])assert.deepEqual(after[field],before[field]);
   for(const field of ['warehouseShipmentRecords','deliveryRecords','deliveredQty'])assert.deepEqual(after.order[field],done.order[field]);
   const count=logisticsCalls.filter(r=>r.name==='receiveV2CustomerReturn').length;
   await siteOpen(page,'warehouse');await returnQueue();
   assert.equal(logisticsCalls.filter(r=>r.name==='receiveV2CustomerReturn').length,count,'reload never resubmits');
   await page.locator('#customerReturnQueue button[data-return-recovery="'+x.orderId+'"]').click();
   await page.locator('#customerReturnReceiptOverlay').waitFor({state:'visible'});
   assert.equal(await page.locator('#customerReturnReceiptShipment').count(),0);
   await page.locator('#customerReturnReceiptSave').click();
   await page.waitForFunction(key=>!sessionStorage.getItem(key),pendingKey,{timeout:45000});
   await page.locator('#customerReturnReceiptOverlay').waitFor({state:'hidden'});
   assert.deepEqual(logisticsCalls.filter(r=>r.name==='receiveV2CustomerReturn').at(-1).data,intent);
   assert.deepEqual(await x.snapshot(),after,'same-ID confirmation cannot credit stock or a sibling twice');
  }
  const returned=await x.snapshot();
  assert.equal(returned.order.returnedQty,3);assert.equal(returned.order.returnPending,false);
  assert.deepEqual(returned.order.items.map(i=>i.returnedQty),[1,2,0]);
  assert.deepEqual(returned.inventory.map(i=>[i.onHand,i.reserved,i.incoming]),[[3,0,0],[0,0,0]]);
  assert.equal(returned.order.returnRecords.length,3);
  const proofs=(await db.collection('customerReturnReceipts').where('orderId','==',x.orderId).get()).docs.map(d=>d.data());
  assert.equal(proofs.length,3);
  for(const proof of proofs){assert.equal(proof.receivedBy,x.accounts.warehouse.uid);assert.equal(proof.quality,'SALEABLE');
   assert.equal(proof.warehouseId,x.warehouses[proof.itemId==='I2'?1:0]);assert.equal(proof.requestId,requests.find(r=>r.itemId===proof.itemId).id);}
  assert.equal(logisticsCalls.filter(r=>r.name==='receiveV2CustomerReturn').length,6);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Full site '+width+'px: same-product A/B original return requests and B 1+1 then A 1 physical receipts; all three successful replies lost, reload confirmed original IDs, final pending=false still recoverable, only original warehouse/lot credited once and third item/PO/costs unchanged.');

  // Distinct business entry: the actual CLOSE source opens a clean ordinary order.
  const correctKey='reorder-'+width+'-correct',correctCode='REORDER'+width;
  const correctLot={productKey:correctKey,warehouseId:x.warehouses[0],receivedQty:3,remainingQty:3,lotNo:correctCode};
  const setup=db.batch();
  setup.set(db.collection('products').doc(correctKey),{productId:correctKey,manufacturerPartNo:correctCode,
   normalizedPartNo:correctCode.toLowerCase(),productName:'重新確認的正確商品',brand:'Roche',brandName:'Roche',productType:'Goods',active:true,status:'ACTIVE',listPrice:175});
  setup.set(db.collection('inventory').doc(correctKey),{productKey:correctKey,onHand:3,reserved:0,incoming:0,transferFreeInTransit:0});
  setup.set(db.collection('warehouseStocks').doc(x.warehouses[0]+'__'+correctKey),
   {warehouseId:x.warehouses[0],productKey:correctKey,onHand:3,reserved:0,incoming:0,transferFreeInTransit:0});
  setup.set(db.collection('inventoryLots').doc(correctKey+'-lot'),correctLot);await setup.commit();
  await siteLogout(page);await siteLogin(page,x.accounts.sales,'sales');
  await siteOrderAction(page,{sourceId:x.orderId},'退貨');
  await page.locator('#reorderAfterReturnBtn').waitFor({state:'visible'});await page.locator('#reorderAfterReturnBtn').click();
  await page.locator('#orderModalOverlay.active').waitFor({state:'visible'});
  assert.equal(await page.locator('#orderModalTitle').textContent(),'退貨後重新下單');
  assert.equal(await page.locator('#orderCustomer').inputValue(),returned.order.customerName);
  assert.equal(await page.locator('#orderItemCode').inputValue(),'');assert.equal(await page.locator('#orderUnitPrice').inputValue(),'');
  assert.deepEqual(await page.evaluate(()=>newOrderDraftItems),[],'wrong original items must not be copied');
  await page.waitForFunction(id=>warehouseMasterCache.some(w=>w.id===id)&&document.getElementById('orderWarehouse').value,x.warehouses[0]);
  await page.locator('#orderItemCode').fill(correctCode);await page.locator('#orderItemCode').blur();
  await page.waitForFunction(()=>document.getElementById('orderItemCode').dataset.productCheckStatus==='matched');
  await page.locator('#orderQty').fill('1');await page.locator('#orderUnitPrice').fill('275');
  await page.locator('#saveNewOrderBtn').click();await page.locator('#orderModalOverlay.active').waitFor({state:'hidden'});
  await page.waitForFunction(source=>ordersCache.some(o=>o.returnReorderSource?.orderId===source&&o.inventoryReservationStatus==='completed'),x.orderId,{timeout:45000});
  const owned=await db.collection('orders').where('createdByUid','==',x.accounts.sales.uid).get();
  const reordered=owned.docs.filter(d=>d.data().returnReorderSource?.orderId===x.orderId);
  assert.equal(reordered.length,1);const newId=reordered[0].id,newOrder=reordered[0].data();
  assert.notEqual(newId,x.orderId);assert.deepEqual(newOrder.returnReorderSource,{orderId:x.orderId});
  assert.equal(newOrder.ownerUid,x.accounts.sales.uid);assert.equal(newOrder.customerName,returned.order.customerName);
  assert.equal(newOrder.items.length,1);assert.equal(newOrder.items[0].productId,correctKey);
  assert.equal(newOrder.items[0].qty,1);assert.equal(newOrder.items[0].unitPrice,275);assert.equal(newOrder.totalPrice,275);
  assert.equal(newOrder.items[0].reservedQty,1);assert.equal(newOrder.isDelivered,false);
  assert.deepEqual(newOrder.deliveryRecords||[],[]);assert.deepEqual(newOrder.returnRecords||[],[]);
  for(const ref of [db.collection('inventory').doc(correctKey),db.collection('warehouseStocks').doc(x.warehouses[0]+'__'+correctKey)]){
   const held=(await ref.get()).data();assert.equal(held.onHand,3);assert.equal(held.reserved,1);
  }
  assert.deepEqual((await db.collection('inventoryLots').doc(correctKey+'-lot').get()).data(),correctLot);
  assert.equal((await db.collection('supplyOrders').where('sourceId','==',newId).get()).size,0);
  assert.deepEqual(await x.snapshot(),returned,'new order never changes the returned source or its physical stock');
  await siteOpen(page,'sales');await siteNav(page,'orders');
  const reloaded=await db.collection('orders').where('createdByUid','==',x.accounts.sales.uid).get();
  assert.equal(reloaded.docs.filter(d=>d.data().returnReorderSource?.orderId===x.orderId).length,1);
  assert.deepEqual((await db.collection('orders').doc(newId).get()).data(),newOrder);
  assert.deepEqual(await x.snapshot(),returned);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Full site '+width+'px: actual CLOSE source opened a clean original reorder form; explicitly selected different product and price, one ordinary Client order and independent hold, original source/returns/stock unchanged, reload did not recreate.');
 }catch(error){
  console.log('Multi receipt '+width+'px diagnostic:',JSON.stringify(await page.evaluate(()=>({role:typeof currentUserRole==='undefined'?'none':currentUserRole,
   feedback:document.getElementById('actionFeedback')?.textContent,rows:document.getElementById('inventoryReceivingBody')?.textContent,
   tasks:typeof receiptTaskJobs==='undefined'?[]:[...receiptTaskJobs.values()],
   purchasing:{rows:document.getElementById('purchasePendingBody')?.textContent,status:document.getElementById('poSaveStatus')?.textContent,
    items:typeof poItems==='undefined'?[]:poItems,editing:typeof poEditingId==='undefined'?null:poEditingId}}))),JSON.stringify({errors,dialogs}));throw error;
 }finally{await context.close();}
});

// Exercise the existing production-path manual form and initialization too.
// This is the single-warehouse legacy contract, not the v2 transport fixture.
for(const multi of [false,true])for(const width of [1280,390])test('full site '+width+'px original '+(multi?'multi-item ':'')+'manual order form creates and reserves through real Client Rules',{timeout:120000},async()=>{
 const tag=(multi?'manual-multi-':'manual-entry-')+width,uid=tag+'-sales',email=uid+'@example.test',key=tag+'-product',warehouseId='MANUAL-ENTRY',otherWarehouse='MANUAL-ENTRY-B',code=(multi?'MULTI':'MANUAL')+width;
 await auth.createUser({uid,email,password});await db.collection('users').doc(uid).set({role:'sales',active:true,name:'手動建單業務',email,code:'B'});
 const batch=db.batch(),put=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 put('warehouses',warehouseId,{warehouseName:'手動建單驗收倉',active:true,isDefault:true});
 put('products',key,{productId:key,manufacturerPartNo:code,normalizedPartNo:code.toLowerCase(),
  productName:'原表單建單試劑',brand:'Roche',brandName:'Roche',productType:'Goods',active:true,status:'ACTIVE',listPrice:100});
 put('inventory',key,{productKey:key,onHand:3,reserved:0,incoming:0,transferFreeInTransit:0});
 put('warehouseStocks',warehouseId+'__'+key,{warehouseId,productKey:key,onHand:multi?2:3,reserved:0,incoming:0,transferFreeInTransit:0});
 const lot={productKey:key,warehouseId,receivedQty:multi?2:3,remainingQty:multi?2:3,lotNo:tag,expiryDate:'2028-01-01'};
 put('inventoryLots',tag+'-lot',lot);
 if(multi){
  put('warehouses',otherWarehouse,{warehouseName:'手動建單驗收分倉',active:true});
  put('warehouseStocks',otherWarehouse+'__'+key,{warehouseId:otherWarehouse,productKey:key,onHand:1,reserved:0,incoming:0,transferFreeInTransit:0});
  put('inventoryLots',tag+'-other-lot',{productKey:key,warehouseId:otherWarehouse,receivedQty:1,remainingQty:1,lotNo:tag+'-B',expiryDate:'2028-01-01'});
  put('products',key+'-Q',{productId:key+'-Q',manufacturerPartNo:code+'Q',normalizedPartNo:(code+'Q').toLowerCase(),productName:'另一建單試劑',brand:'Roche',brandName:'Roche',productType:'Goods',active:true,status:'ACTIVE',listPrice:150});
  put('inventory',key+'-Q',{productKey:key+'-Q',onHand:2,reserved:0,incoming:0,transferFreeInTransit:0});
  put('warehouseStocks',warehouseId+'__'+key+'-Q',{warehouseId,productKey:key+'-Q',onHand:2,reserved:0,incoming:0,transferFreeInTransit:0});
  put('inventoryLots',tag+'-q-lot',{productKey:key+'-Q',warehouseId,receivedQty:2,remainingQty:2,lotNo:tag+'-Q',expiryDate:'2028-01-01'});
 }
 await batch.commit();
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}}),page=await context.newPage(),errors=[],dialogs=[],external=[],functions=[];
 await context.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;});
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>{dialogs.push(dialog.message());return dialog.type()==='confirm'?dialog.accept():dialog.dismiss();});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){external.push(url.hostname);await route.abort();return;}
  if(url.port==='5001')functions.push(url.pathname);
  await route.continue();
 });
 try{
  await siteOpen(page);await siteLogin(page,{uid,email},'sales');await siteNav(page,'orders');
  await page.locator('button[onclick="openOrderModal()"]').click();await page.locator('#orderModalOverlay.active').waitFor({state:'visible'});
  await page.waitForFunction(id=>warehouseMasterCache.some(w=>w.id===id)&&document.getElementById('orderWarehouse').value===id,warehouseId);
  await page.locator('#orderCustomer').fill(tag+'客戶');await page.locator('#orderItemCode').fill(code);await page.locator('#orderItemCode').blur();
  await page.waitForFunction(()=>document.getElementById('orderItemCode').dataset.productCheckStatus==='matched');
  await page.locator('#orderQty').fill('2');await page.locator('#orderUnitPrice').fill('100');
  assert.equal(await page.locator('#orderProcurementType').inputValue(),'PURCHASING_PO');
  assert.equal(await page.locator('#orderDeliveryChoice').inputValue(),'BUSINESS');
  if(multi){
   await page.locator('button[onclick="addCurrentOrderItemToDraft()"]').click();
   await page.waitForFunction(()=>newOrderDraftItems.length===1);
   await page.locator('#orderItemCode').fill(code);await page.locator('#orderItemCode').blur();
   await page.waitForFunction(()=>document.getElementById('orderItemCode').dataset.productCheckStatus==='matched');
   await page.locator('#orderQty').fill('1');await page.locator('#orderUnitPrice').fill('100');
   // Distinct actual destinations keep the same product as separate lines;
   // identical destination/price entries intentionally merge in the original UI.
   await page.locator('#orderDeliveryChoice').selectOption('CUSTOMER');
   const details=page.locator('#orderRecipientDetails');if(!await details.evaluate(node=>node.open))await details.locator('summary').click();
   await page.waitForFunction(()=>document.getElementById('orderAddressStatus')?.textContent!=='讀取常用地址…');
   await page.locator('#orderShippingContact').fill('原表單收件人');await page.locator('#orderShippingPhone').fill('02-12345678');
   await page.locator('#orderShippingAddress').fill('台北市手動多品項驗收地址');
   await page.locator('button[onclick="addCurrentOrderItemToDraft()"]').click();await page.waitForFunction(()=>newOrderDraftItems.length===2);
   await page.locator('#orderItemCode').fill(code+'Q');await page.locator('#orderItemCode').blur();
   await page.waitForFunction(()=>document.getElementById('orderItemCode').dataset.productCheckStatus==='matched');
   await page.locator('#orderQty').fill('2');await page.locator('#orderUnitPrice').fill('150');
   await page.locator('#orderDeliveryChoice').selectOption('BUSINESS');
  }
  await page.locator('#saveNewOrderBtn').click();await page.locator('#orderModalOverlay.active').waitFor({state:'hidden'});
  await page.waitForFunction(uid=>ordersCache.some(o=>o.createdByUid===uid&&o.inventoryReservationStatus==='completed'),uid,{timeout:45000});
  const snapshot=await db.collection('orders').where('createdByUid','==',uid).get();assert.equal(snapshot.size,1);
  const orderId=snapshot.docs[0].id,order=snapshot.docs[0].data(),item=order.items[0];
  assert.equal(order.ownerUid,uid);assert.equal(order.salesCode,'B');assert.equal(order.customerName,tag+'客戶');
  assert.equal(order.itemCount,multi?3:1);assert.equal(order.items.length,multi?3:1);assert.equal(item.productId,key);assert.equal(item.qty,2);
  assert.equal(item.unitPrice,100);assert.equal(order.totalPrice,multi?600:200);assert.equal(item.warehouseId,warehouseId);
  assert.equal(item.reservedQty,2);assert.equal(item.shortageQty,0);assert.equal(order.inventoryReservationStatus,'completed');
  const ledger=(await db.collection('inventoryReservations').doc(orderId+'__'+item.itemId).get()).data();
  assert.equal(ledger.quantity,2);assert.equal(ledger.warehouseId,warehouseId);assert.equal(ledger.productKey,key);
  const physical=async()=>({inventory:(await db.collection('inventory').doc(key).get()).data(),
   stock:(await db.collection('warehouseStocks').doc(warehouseId+'__'+key).get()).data(),
   lot:(await db.collection('inventoryLots').doc(tag+'-lot').get()).data(),
   ...(multi?{otherStock:(await db.collection('warehouseStocks').doc(otherWarehouse+'__'+key).get()).data(),
    otherLot:(await db.collection('inventoryLots').doc(tag+'-other-lot').get()).data(),
    qInventory:(await db.collection('inventory').doc(key+'-Q').get()).data(),qStock:(await db.collection('warehouseStocks').doc(warehouseId+'__'+key+'-Q').get()).data(),
    qLot:(await db.collection('inventoryLots').doc(tag+'-q-lot').get()).data()}:{} )});
  const held=await physical();assert.equal(held.inventory.onHand,3);assert.equal(held.inventory.reserved,multi?3:2);
  assert.equal(held.stock.onHand,multi?2:3);assert.equal(held.stock.reserved,2);assert.deepEqual(held.lot,lot);
  if(multi){
   assert.deepEqual(order.items.map(i=>[i.productId,i.qty,i.reservedQty,i.shortageQty,i.warehouseId]),[[key,2,2,0,warehouseId],[key,1,1,0,otherWarehouse],[key+'-Q',2,2,0,warehouseId]]);
   assert.equal(new Set(order.items.map(i=>i.itemId)).size,3);assert.equal(order.items[1].deliveryPlan.mode,'CUSTOMER_SHIP');
   assert.equal(order.items[1].deliveryPlan.address,'台北市手動多品項驗收地址');assert.equal(order.items[2].deliveryPlan.mode,'PICKUP');
   for(const row of order.items){const hold=(await db.collection('inventoryReservations').doc(orderId+'__'+row.itemId).get()).data();
    assert.equal(hold.quantity,row.qty);assert.equal(hold.productKey,row.productId);assert.equal(hold.warehouseId,row.warehouseId);}
   assert.equal(held.otherStock.onHand,1);assert.equal(held.otherStock.reserved,1);assert.equal(held.otherLot.remainingQty,1);
   assert.equal(held.qInventory.onHand,2);assert.equal(held.qInventory.reserved,2);assert.equal(held.qStock.onHand,2);assert.equal(held.qStock.reserved,2);assert.equal(held.qLot.remainingQty,2);
  }
  assert.equal((await db.collection('supplyOrders').where('sourceId','==',orderId).get()).size,0);
  assert.deepEqual(order.deliveryRecords||[],[]);assert.deepEqual(order.returnRecords||[],[]);assert.equal(order.isDelivered,false);
  await siteOpen(page,'sales');await siteNav(page,'orders');
  await page.locator('#ordersBody > tr').filter({hasText:tag+'客戶'}).waitFor({state:'visible'});
  assert.equal((await db.collection('orders').where('createdByUid','==',uid).get()).size,1);
  assert.deepEqual((await db.collection('orders').doc(orderId).get()).data(),order);assert.deepEqual(await physical(),held);
  assert.deepEqual(functions,[],'manual production path does not use isolated v2 callables');
  assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Full site '+width+'px '+(multi?'three lines/two products/two warehouses':'single line')+': actual manual blank form/product lookup created one owned order and initialized the original per-item warehouse holds through Client Rules; physical stock/lots unchanged, reload read-only, no v2 initialization fixture or Callable.');
 }catch(error){
  console.log('Manual entry '+width+'px diagnostic:',JSON.stringify(await page.evaluate(()=>({feedback:document.getElementById('actionFeedback')?.textContent,
   check:document.getElementById('orderProductCheckStatus')?.textContent,warehouse:document.getElementById('orderWarehouse')?.value,
   orders:typeof ordersCache==='undefined'?[]:ordersCache.filter(o=>o.customerName?.startsWith('manual-'))}))),JSON.stringify({errors,dialogs,functions}));throw error;
 }finally{await context.close();}
});

// Service sales use the original Client creation/sync path, without fake stock.
for(const mixed of [false,true])for(const width of [1280,390])test('full site '+width+'px original '+(mixed?'Goods plus Service':'Service-only')+' entry has no virtual stock',{timeout:120000},async()=>{
 const tag='service-entry-'+width+'-'+mixed,uid=tag+'-sales',email=uid+'@example.test',serviceKey=tag+'-service',goodsKey=tag+'-goods',warehouseId='SERVICE-ENTRY',code='SVC'+width+(mixed?'M':'S');
 await auth.createUser({uid,email,password});
 await db.collection('users').doc(uid).set({role:'sales',active:true,name:'服務驗收業務',email,code:'B'});
 const batch=db.batch(),put=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 put('products',serviceKey,{productId:serviceKey,manufacturerPartNo:code,normalizedPartNo:code.toLowerCase(),productName:'服務驗收項目',brand:'Roche',brandName:'Roche',productType:'Service',active:true,status:'ACTIVE',listPrice:100});
 if(mixed){
  put('warehouses',warehouseId,{warehouseName:'服務混合單商品倉',active:true,isDefault:true});
  put('products',goodsKey,{productId:goodsKey,manufacturerPartNo:code+'G',normalizedPartNo:(code+'G').toLowerCase(),productName:'混合單實體商品',brand:'Roche',brandName:'Roche',productType:'Goods',active:true,status:'ACTIVE',listPrice:150});
  put('inventory',goodsKey,{productKey:goodsKey,onHand:3,reserved:0,incoming:0,transferFreeInTransit:0});
  put('warehouseStocks',warehouseId+'__'+goodsKey,{warehouseId,productKey:goodsKey,onHand:3,reserved:0,incoming:0,transferFreeInTransit:0});
  put('inventoryLots',tag+'-lot',{productKey:goodsKey,warehouseId,receivedQty:3,remainingQty:3,lotNo:tag,expiryDate:'2028-01-01'});
 }
 await batch.commit();
 const context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}}),page=await context.newPage(),dialogs=[],errors=[],functions=[];
 await context.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;});
 page.on('pageerror',error=>errors.push(error.message));
 page.on('dialog',dialog=>{dialogs.push(dialog.message());return dialog.dismiss();});
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){await route.abort();return;}
  if(url.port==='5001')functions.push(url.pathname);
  await route.continue();
 });
 try{
  await siteOpen(page);await siteLogin(page,{uid,email},'sales');await siteNav(page,'orders');
  await page.locator('button[onclick="openOrderModal()"]').click();await page.locator('#orderModalOverlay.active').waitFor({state:'visible'});
  await page.locator('#orderCustomer').fill(tag+'客戶');
  const selectProduct=async(part,qty,price)=>{
   await page.locator('#orderItemCode').fill(part);await page.locator('#orderItemCode').blur();
   await page.waitForFunction(()=>document.getElementById('orderItemCode').dataset.productCheckStatus==='matched');
   await page.locator('#orderQty').fill(String(qty));await page.locator('#orderUnitPrice').fill(String(price));
  };
  await selectProduct(code,2,100);
  assert.equal(await page.locator('#orderItemCode').getAttribute('data-product-type'),'Service');
  // Deliberately incomplete physical instructions must not block Service entry.
  await page.locator('#orderDeliveryChoice').selectOption('CUSTOMER');
  if(mixed){
   await page.locator('button[onclick="addCurrentOrderItemToDraft()"]').click();await page.waitForFunction(()=>newOrderDraftItems.length===1);
   await selectProduct(code+'G',1,150);
   await page.locator('#orderDeliveryChoice').selectOption('BUSINESS');
   // Keep the original hidden warehouse default. The real reservation Service
   // must discover the warehouse holding this Goods product itself.
  }
  await page.locator('#saveNewOrderBtn').click();await page.locator('#orderModalOverlay.active').waitFor({state:'hidden'});
  await page.waitForFunction(uid=>ordersCache.some(o=>o.createdByUid===uid&&o.inventoryReservationStatus==='completed'),uid,{timeout:45000});
  const snapshot=await db.collection('orders').where('createdByUid','==',uid).get();assert.equal(snapshot.size,1);
  const orderId=snapshot.docs[0].id,order=snapshot.docs[0].data(),service=order.items.find(i=>i.productId===serviceKey);
  assert.equal(order.items.length,mixed?2:1);assert.equal(order.totalPrice,mixed?350:200);
  assert.equal(service.reservedQty,0);assert.equal(service.shortageQty,0);assert.equal(service.warehouseId,'');assert.equal(service.reservationStatus,'not_required');
  assert.deepEqual(service.deliveryPlan,{});assert.equal(order.isDelivered,false);assert.deepEqual(order.deliveryRecords||[],[]);
  const projection=await page.evaluate(({order,serviceKey})=>{
   const item=normalizedOrderItems(order).find(row=>row.productId===serviceKey);
   return {shortage:item.shortageQty,purchase:purchaseProgressInfo(order).state,physicalTotal:fulfillmentProgressInfo(order).total};
  },{order,serviceKey});
  assert.deepEqual(projection,{shortage:0,purchase:'not_required',physicalTotal:mixed?1:0});
  for(const name of ['inventory','inventoryReservations'])assert.equal((await db.collection(name).doc(name==='inventory'?serviceKey:orderId+'__'+service.itemId).get()).exists,false);
  for(const name of ['warehouseStocks','inventoryLots','inventoryMovements'])assert.equal((await db.collection(name).where('productKey','==',serviceKey).get()).size,0);
  assert.equal((await db.collection('procurementDemands').where('sourceId','==',orderId).get()).size,0);
  assert.equal((await db.collection('supplyOrders').where('sourceId','==',orderId).get()).size,0);
  if(mixed){
   const goods=order.items.find(i=>i.productId===goodsKey);
   assert.equal(goods.reservedQty,1);assert.equal(goods.warehouseId,warehouseId);
   assert.equal((await db.collection('inventoryReservations').doc(orderId+'__'+goods.itemId).get()).data().quantity,1);
   const stock=(await db.collection('inventory').doc(goodsKey).get()).data();assert.equal(stock.onHand,3);assert.equal(stock.reserved,1);
   assert.equal((await db.collection('warehouseStocks').doc(warehouseId+'__'+goodsKey).get()).data().reserved,1);
   assert.equal((await db.collection('inventoryLots').doc(tag+'-lot').get()).data().remainingQty,3);
  }
  await siteOpen(page,'sales');await siteNav(page,'orders');
  await page.locator('#ordersBody > tr').filter({hasText:tag+'客戶'}).waitFor({state:'visible'});
  assert.deepEqual((await db.collection('orders').doc(orderId).get()).data(),order);
  assert.equal((await db.collection('orders').where('createdByUid','==',uid).get()).size,1);
  assert.deepEqual(dialogs,[]);assert.deepEqual(errors,[]);assert.deepEqual(functions,[]);
 }catch(error){console.log('Service entry diagnostic',JSON.stringify({tag,dialogs,errors,functions}));throw error;}
 finally{await context.close();}
});

// A different writer/permission contract from warehouse fulfillment: the
// original UI with explicit local backend pilot must complete direct ship.
for(const width of [1280,390])test('full site '+width+'px original UI gated PO purchase and owner direct arrival never touch physical stock',{timeout:180000},async()=>{
 const tag='direct-entry-'+width,orderId=tag+'-order',key=tag+'-product',warehouseId=tag+'-warehouse',accounts={};
 for(const role of ['sales','purchaser']){
  const uid=tag+'-'+role,email=uid+'@example.test';await auth.createUser({uid,email,password});
  await db.collection('users').doc(uid).set({role,active:true,name:role,email,code:role==='sales'?'B':role});accounts[role]={uid,email};
 }
 const setup=db.batch(),put=(name,id,data)=>setup.set(db.collection(name).doc(id),data);
 put('products',key,{productId:key,manufacturerPartNo:tag,normalizedPartNo:tag,productName:'原廠直送試劑',
  brand:'Roche',brandName:'Roche',productType:'Goods',productLine:tag,active:true,status:'ACTIVE',listPrice:100});
 put('warehouses',warehouseId,{warehouseName:tag,active:true});
 put('suppliers',tag+'-supplier',{supplierId:tag+'-supplier',supplierName:tag+'供應商',purchaseHeaderName:tag+'供應商',active:true});
 put('brandSupplierMappings',tag+'-mapping',{brandName:'Roche',productLine:tag,supplierId:tag+'-supplier',active:true,isDefault:false});
 put('inventory',key,{productKey:key,onHand:5,reserved:1,incoming:0,transferFreeInTransit:0});
 put('warehouseStocks',warehouseId+'__'+key,{productKey:key,warehouseId,onHand:5,reserved:1,incoming:0,transferFreeInTransit:0});
 put('inventoryLots',tag+'-lot',{productKey:key,warehouseId,lotNo:tag,receivedQty:5,remainingQty:5});
 await setup.commit();
 const source={orderNo:orderId,customerName:tag+'客戶',ownerUid:accounts.sales.uid,salesCode:'B',status:'active',orderStatus:'normal',
  createdByUid:accounts.sales.uid,createdByRole:'sales',createdAt:new Date().toISOString(),productId:key,productMasterMatched:true,
  itemCount:1,orderSchemaVersion:2,orderDate:'2026-10-22',inventoryReservationStatus:'pending',inventoryReservationAttemptId:tag+'-sync',
  deliveryRecords:[],returnRecords:[],deliveredQty:0,isDelivered:false,totalPrice:300,
  items:[{itemId:'I',productId:key,itemCode:tag,itemName:'原廠直送試劑',brand:'Roche',productLine:tag,productType:'Goods',
   qty:3,orderedQty:3,unitPrice:100,reservedQty:0,shortageQty:0,receivedQty:0,supplyOrderedQty:0,deliveredQty:0,returnedQty:0,
   fulfillmentType:'DIRECT_SHIP',warehouseId:'',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'直送收件人',phone:'02-12345678',address:'台北市直送驗收地址'}}]};
 const creatorApp=clientApp({apiKey:'fake-api-key',authDomain:'demo-yushin.firebaseapp.com',projectId:'demo-yushin',appId:tag},tag);
 try{
  const session=clientAuth(creatorApp);connectAuthEmulator(session,'http://127.0.0.1:9099',{disableWarnings:true});
  await signInWithEmailAndPassword(session,accounts.sales.email,password);
  await orderCreationClient(creatorApp,accounts.sales.uid,'sales').create(orderId,source);
 }finally{await deleteClientApp(creatorApp);}
 const physical=async()=>({inventory:(await db.collection('inventory').doc(key).get()).data(),
  stock:(await db.collection('warehouseStocks').doc(warehouseId+'__'+key).get()).data(),
  lots:(await db.collection('inventoryLots').where('productKey','==',key).get()).docs.map(d=>({id:d.id,...d.data()})),
  movements:(await db.collection('inventoryMovements').where('productKey','==',key).get()).docs.map(d=>({id:d.id,...d.data()})),
  reservations:(await db.collection('inventoryReservations').where('productKey','==',key).get()).docs.map(d=>({id:d.id,...d.data()}))});
 const before=await physical(),context=await browser.newContext({serviceWorkers:'block',viewport:{width,height:1000}}),page=await context.newPage();
 const errors=[],dialogs=[],external=[],functions=[],receiptCalls=[];let loseArrival=true;
 await context.addInitScript(()=>{window.YUSHIN_LOCAL_EMULATOR=true;window.YUSHIN_FORMAL_PURCHASE_EMULATOR=true;window.YUSHIN_V2_RECEIVING_EMULATOR=true;});
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',d=>{dialogs.push(d.message());return d.type()==='confirm'?d.accept():d.dismiss();});
 await context.route('**/*',async route=>{const url=new URL(route.request().url());
  if(!['localhost','127.0.0.1'].includes(url.hostname)){external.push(url.hostname);await route.abort();return;}
  if(url.port==='5001'){
   functions.push(url.pathname);
   if(url.pathname.endsWith('/receiveV2Supply')){
    receiptCalls.push(route.request().postDataJSON().data);
    if(loseArrival){loseArrival=false;const reply=await route.fetch();assert.equal(reply.status(),200);await route.abort('failed');return;}
   }
  }
  await route.continue();});
 try{
  await siteOpen(page);await siteLogin(page,accounts.sales,'sales');await siteNav(page,'orders');
  const sourceRow=page.locator('#ordersBody > tr').filter({hasText:orderId});await sourceRow.waitFor({state:'visible'});
  await sourceRow.locator('button[onclick^="retryOrderInventoryReservation("]').click();
  await page.waitForFunction(id=>ordersCache.some(o=>o.id===id&&o.inventoryReservationStatus==='completed')&&!pendingOrderReservationIds.has(id),orderId,{timeout:45000});
  assert.deepEqual(await physical(),before);
  const demandId=encodeURIComponent('SALES_ORDER:'+orderId+':I');
  assert.equal((await db.collection('procurementDemands').doc(demandId).get()).data().remainingToOrderQty,3);
  await siteLogout(page);await siteLogin(page,accounts.purchaser,'purchaser');await siteNav(page,'purchasing');
  const pending=page.locator('#purchasePendingBody tr').filter({hasText:orderId});await pending.waitFor({state:'visible'});
  await pending.getByRole('button',{name:'產生採購單'}).click();await page.locator('#poModalOverlay.active').waitFor({state:'visible'});
  await page.waitForFunction(()=>poNoReady&&!poNoLoading&&!poDraftLoading);
  await page.evaluate(()=>{window.directPdfOutputs=[];printSavedPoDocument=async(poNo,vendor)=>window.directPdfOutputs.push({poNo,vendor});});
  await page.locator('#poVendorName').fill(tag+'供應商');await page.locator('#poVendorName').blur();
  await page.locator('#poItemsBody input[onchange*="unitPrice"]').fill('20');await page.locator('#poItemsBody input[onchange*="unitPrice"]').blur();
  await page.locator('#printPurchaseOrderBtn').click();await page.waitForFunction(()=>!poSaveInProgress&&poEditingId&&window.directPdfOutputs.length===1);
  const poId=await page.evaluate(()=>poEditingId);
  assert.equal((await db.collection('purchaseOrders').doc(poId).get()).data().status,'DRAFT');
  assert.equal((await db.collection('supplyOrders').where('sourceId','==',orderId).get()).size,0);assert.deepEqual(await physical(),before);
  await page.locator('#confirmPoOrderedBtn').click();
  await page.waitForFunction(id=>!formalPurchaseRecoveryRunning&&poListCache.some(p=>p.id===id&&p.status==='ORDERED'),poId,{timeout:45000});
  const po=(await db.collection('purchaseOrders').doc(poId).get()).data();assert.equal(po.supplyOrderIds.length,1);
  const supplyId=po.supplyOrderIds[0],committed=(await db.collection('supplyOrders').doc(supplyId).get()).data();
  assert.equal(committed.fulfillmentType,'DIRECT_SHIP');assert.equal(committed.qty,3);assert.equal(committed.incomingRegisteredQty||0,0);
  assert.deepEqual(await physical(),before);
  await siteLogout(page);await siteLogin(page,accounts.sales,'sales');await siteNav(page,'orders');
  for(const [qty,total] of [[1,1],[2,3]]){
   const row=page.locator('#ordersBody > tr').filter({hasText:orderId});
   await row.locator('button[onclick^="openOrderDirectShipReceipt("]').click();
   await page.locator('#poReceiptBatchOverlay.active').waitFor({state:'visible'});
   assert.equal(await page.locator('#poReceiptBatchBody .po-receive-lot').isDisabled(),true);
   assert.equal(await page.locator('#poReceiptBatchBody .po-receive-expiry').isDisabled(),true);
   await page.locator('#poReceiptBatchBody .po-receive-qty').fill(String(qty));await page.locator('#savePoReceiptBatchBtn').click();
   if(total===1){
    await page.waitForFunction(id=>receiptTaskJobs.get(receiptTaskKey(id))?.state==='error',supplyId,{timeout:45000});
    const partial=(await db.collection('orders').doc(orderId).get()).data(),intent=receiptCalls[0];
    assert.equal(partial.items[0].receivedQty,1);assert.equal(partial.deliveryRecords.length,1);
    const proof=(await db.collection('receipts').doc(intent.operationId).get()).data();
    assert.equal(proof.fulfillmentType,'DIRECT_SHIP');assert.equal(proof.lotNo,undefined);assert.equal(proof.expiryDate,undefined);
    assert.deepEqual(await physical(),before);
    await siteOpen(page,'sales');await siteNav(page,'orders');
    await page.locator('#receiptTaskStatus button').filter({hasText:'用原資料重試'}).click();
    await page.waitForFunction(id=>!receiptTaskJobs.has(receiptTaskKey(id)),supplyId,{timeout:45000});
    assert.deepEqual(receiptCalls[1],intent);
    assert.deepEqual((await db.collection('orders').doc(orderId).get()).data(),partial);
    assert.equal((await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).size,1);
   }
   await page.waitForFunction(({id,total,supplyId})=>ordersCache.some(o=>o.id===id&&o.items[0].receivedQty===total)
    &&!receiptTaskJobs.has(receiptTaskKey(supplyId)),{id:orderId,total,supplyId},{timeout:45000});
   assert.equal((await db.collection('supplyOrders').doc(supplyId).get()).data().receivedQty,total);
   assert.deepEqual(await physical(),before);
  }
  const done=(await db.collection('orders').doc(orderId).get()).data();
  assert.equal(done.deliveredQty,3);assert.equal(done.isDelivered,true);assert.equal(done.items[0].receivedQty,3);
  assert.equal(done.deliveryRecords.length,2);assert.ok(done.deliveryRecords.every(r=>r.sourceType==='DIRECT_SHIP_RECEIPT'&&r.sourceId===supplyId));
  assert.equal((done.warehouseShipmentRecords||[]).length,0);assert.equal(done.items[0].reservedQty,0);
  const demand=(await db.collection('procurementDemands').doc(demandId).get()).data();
  assert.equal(demand.receivedQty,3);assert.equal(demand.remainingToOrderQty,0);assert.equal(demand.remainingToReceiveQty,0);
  const receipts=(await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).docs.map(d=>({id:d.id,...d.data()}));
  assert.equal(receipts.length,2);assert.ok(receipts.every(r=>r.fulfillmentType==='DIRECT_SHIP'&&!r.lotNo&&!r.warehouseId));
  await siteOpen(page,'sales');await siteNav(page,'orders');
  assert.deepEqual((await db.collection('orders').doc(orderId).get()).data(),done);assert.deepEqual(await physical(),before);
  assert.equal((await db.collection('receipts').where('supplyOrderId','==',supplyId).get()).size,2);
  assert.equal(functions.length,4);assert.match(functions[0],/commitV2FormalPurchase/);assert.ok(functions.slice(1).every(path=>/receiveV2Supply/.test(path)));assert.deepEqual(external,[]);assert.deepEqual(errors,[]);
  assert.ok(dialogs.every(message=>message.startsWith('確認採購單 ')),JSON.stringify(dialogs));
  console.log('Full site '+width+'px: original direct source sync, DRAFT/PDF, explicit demo-gated backend purchase and owner arrival 1+2 complete; company/warehouse/lot/movement/reservation unchanged, reload read-only, one gated PO and three gated receipt Functions calls (lost first reply, original intent replay, final arrival). Source form input and physical PDF output remain explicit fixture boundaries.');
 }catch(error){
  console.log('Direct entry '+width+'px diagnostic:',JSON.stringify(await page.evaluate(()=>({role:typeof currentUserRole==='undefined'?'none':currentUserRole,
   feedback:document.getElementById('actionFeedback')?.textContent,po:document.getElementById('poSaveStatus')?.textContent,
   tasks:typeof receiptTaskJobs==='undefined'?[]:[...receiptTaskJobs.values()],orders:typeof ordersCache==='undefined'?[]:ordersCache.filter(o=>o.id.includes('direct-entry'))}))),JSON.stringify({errors,dialogs,functions}));throw error;
 }finally{await context.close();}
});
