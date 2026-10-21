'use strict';
// Actual Chrome -> original login/actions -> Firebase browser SDK -> isolated
// Auth/Functions/Firestore. Component cases retain their presentation shell;
// full-site cases serve unchanged app.js and every original local module.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawnSync}=require('node:child_process'),{build}=require('esbuild'),{chromium}=require('playwright-core');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth}=require('firebase-admin/auth');
const {synchronizeV2OrderFixture}=require('./fixtures/v2-order-initialization.cjs');
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
  await page.locator('#printPurchaseOrderBtn').click();
  await page.waitForFunction(()=>!poSaveInProgress&&document.getElementById('poSaveStatus')?.textContent?.includes('採購結果尚未確認'),null,{timeout:45000});
  const firstPurchase=calls.filter(row=>row.name==='commitV2FormalPurchase');
  assert.equal(firstPurchase.length,1);
  const commitIntent=firstPurchase[0].data;
  assert.equal((await db.collection('purchaseOrders').get()).size,poCountBefore+1);
  const pendingKey='formal-po-pending:'+encodeURIComponent(fixture.accounts.purchaser.uid);
  const pendingRaw=await page.evaluate(key=>sessionStorage.getItem(key),pendingKey);
  assert.equal(JSON.parse(pendingRaw).poRecord.poNo,commitIntent.poNo);
  assert.deepEqual(await page.evaluate(()=>window.poPdfOutputs),[],'unknown reply cannot print a formal document');
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
   const main=await page.evaluate(()=>defaultWarehouse()?.id||'');
   await page.locator(main===fixture.warehouseIds[0]?'#inventoryShippingMainBtn':'#inventoryShippingBranchBtn').click();
   const row=page.locator('#inventoryShippingBody tr').filter({hasText:fixture.sourceId});
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

  // The original v2 return form is NOT connected. This is explicitly a
  // browser-SDK transport/provenance continuation, not an original-UI return
  // acceptance. Use the same real signed-in owner and the actual second debit.
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
  assert.equal(returnProgress.closedQty,2);assert.equal(returnProgress.effectiveDeliveredQty,2);assert.equal(returnProgress.replacementQty,0);assert.equal(returnProgress.outstandingQty,8);
  const allReturned=await stockFacts();
  assert.ok((await returnTransport('receiveV2CustomerReturn',{...returnIntent,operationId:'same_po_return_'+width+'_excess'})).error);
  assert.deepEqual(await stockFacts(),allReturned);assert.deepEqual(await facts(fixture),returned);
  const returnCalls=calls.filter(row=>row.name==='receiveV2CustomerReturn'&&row.data.operationId===returnIntent.operationId&&row.data.reason===returnIntent.reason&&row.data.warehouseId===returnIntent.warehouseId&&row.data.selections[0].qty===1);
  assert.equal(returnCalls.length,2);assert.deepEqual(returnCalls[0].data,returnCalls[1].data);
  console.log('Full site '+width+'px: same PO/shipment browser-SDK return transport restored two explicitly selected units to original lot, CLOSE/no replacement, first lost reply retried identically; no duplicate credit, other holds/incoming/cost/receipts unchanged. Original return UI remains unconnected.');

  console.log('Full site '+width+'px: seller restored five free units with seven shortages; lost-reply and stale-cancel retries are immutable.');
  for(const match of read('index.html').matchAll(/<script[^>]+src="([^"?]+)(?:\?[^\"]*)?"/g)){
   if(!match[1].startsWith('https:'))assert.ok(loaded.has('/'+match[1]),'original script loaded: '+match[1]);
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
  console.log('Full site '+width+'px: five real role boot/restores, original navigation, seven holds and one handoff passed.');
 }catch(error){
  console.log('Full site '+width+'px diagnostic:',JSON.stringify(await page.evaluate(()=>({role:typeof currentUserRole==='undefined'?'not-booted':currentUserRole,
   loginError:document.getElementById('loginError')?.textContent,feedback:document.getElementById('actionFeedback')?.textContent,
   menu:document.querySelector('.nav-tabs')?.className,scrollTop:document.getElementById('appContainer')?.scrollTop}))),JSON.stringify(errors));
  throw error;
 }finally{await context.close();}
});
