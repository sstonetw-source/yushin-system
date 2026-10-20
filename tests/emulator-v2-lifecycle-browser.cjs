'use strict';
// Actual Chrome -> original login/actions -> Firebase browser SDK -> isolated
// Auth/Functions/Firestore. Only navigation/cache presentation is a test shell.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {spawnSync}=require('node:child_process'),{build}=require('esbuild'),{chromium}=require('playwright-core');
const admin=require('firebase-admin'),{getFirestore}=require('firebase-admin/firestore'),{getAuth}=require('firebase-admin/auth');
const {synchronizeV2OrderFixture}=require('./fixtures/v2-order-initialization.cjs');
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
  if(request.url==='/sdk.js'){response.writeHead(200,{'Content-Type':'application/javascript'});response.end(sdk);return;}
  if(request.url==='/styles.css'){response.writeHead(200,{'Content-Type':'text/css'});response.end(read('styles.css'));return;}
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
async function seed(width){
 const tag='browser'+width,sourceId=tag+'-source',productKey=tag+'-product',warehouseIds=[tag+'-A',tag+'-B'];
 const accounts={};
 for(const role of ['sales','warehouse','purchaser','engineer']){
  const uid=tag+'-'+role,email=uid+'@example.test';await auth.createUser({uid,email,password});
  await db.collection('users').doc(uid).set({role,active:true,name:role,code:'B'});accounts[role]={uid,email};
 }
 const batch=db.batch(),put=(name,id,data)=>batch.set(db.collection(name).doc(id),data);
 put('products',productKey,{productType:'Goods'});put('inventory',productKey,{productKey,onHand:12,reserved:0,transferFreeInTransit:0});
 for(const warehouseId of warehouseIds){
  put('warehouses',warehouseId,{active:true,warehouseName:warehouseId});
  put('warehouseStocks',warehouseId+'__'+productKey,{warehouseId,productKey,onHand:6,reserved:0,transferFreeInTransit:0});
  put('inventoryLots',tag+'-lot-'+warehouseId,{productKey,warehouseId,receivedQty:6,remainingQty:6,lotNo:tag,expiryDate:'2028-01-01'});
 }
 await batch.commit();
 const create=async(orderId,qty,itemId)=>{
  await db.collection('orders').doc(orderId).set({ownerUid:accounts.sales.uid,salesCode:'B',status:'active',orderStatus:'normal',orderDate:'2026-01-01',
   inventoryReservationStatus:'pending',inventoryReservationAttemptId:'browser_sync_'+orderId,deliveryRecords:[],returnRecords:[],deliveryHistory:[],deliveredQty:0,isDelivered:false,
   items:[{itemId,productId:productKey,qty,warehouseId:warehouseIds[0],reservedQty:0,deliveredQty:0,returnedQty:0,dispatchPreparedQty:0,warehouseShippedQty:0,
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
