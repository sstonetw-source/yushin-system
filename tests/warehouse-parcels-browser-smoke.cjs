const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
 ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright' : 'playwright-core');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const chrome=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].find(name=>spawnSync('which',[name]).status===0);
const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link[^>]*rel="stylesheet"[^>]*>/gi,'');
const setup=`
 let currentUserRole='warehouse',currentUser={uid:'warehouse'},currentUserName='測試倉管';
 let orderWorkQueueReady=true,orderWorkQueueError='';
 let warehouseMasterCache=[{id:'main',warehouseName:'又鑫主倉'},{id:'branch',warehouseName:'分倉'}];
 const recipient={mode:'CUSTOMER_SHIP',contact:'王小姐',phone:'0912345678',address:'台北市測試路 1 號'};
 const all=[
  {key:'O__A',warehouseId:'main',warehouse:warehouseMasterCache[0],qty:3,order:{id:'O',orderNo:'ORDER-01',salesName:'業務',customerName:'醫院',shippingInstructions:recipient},item:{itemId:'A',itemCode:'ABC-001',itemName:'測試試劑',qty:3}},
  {key:'O2__B',warehouseId:'main',warehouse:warehouseMasterCache[0],qty:2,order:{id:'O2',shippingInstructions:recipient},item:{itemId:'B',itemCode:'ABC-002',itemName:'測試耗材',qty:2}},
  {key:'O3__C',warehouseId:'branch',warehouse:warehouseMasterCache[1],qty:1,order:{id:'O3',shippingInstructions:recipient},item:{itemId:'C',itemCode:'ABC-003',itemName:'分倉試劑',qty:1}}
 ];
 const canReceiveInventoryCapability=()=>currentUserRole==='warehouse',canAccessPage=()=>currentUserRole==='warehouse';
 const firebase={app:()=>({options:{projectId:'demo-yushin'}})};
 const defaultWarehouse=()=>warehouseMasterCache[0];
 const escapeHtml=x=>{const node=document.createElement('div');node.textContent=String(x??'');return node.innerHTML;};
 const escapeAttr=x=>String(x).replace(/&/g,'&amp;').replace(/"/g,'&quot;');
 const inlineJsValue=x=>escapeAttr(JSON.stringify(x));
 const localDateString=()=> '2026-11-07';
 const lifecycleRecordId=()=>crypto.randomUUID();
 const beginActionButton=b=>{b.disabled=true;return {text:b.textContent};};
 const endActionButton=(b,state)=>{b.disabled=false;b.textContent=state.text;};
 const showActionFeedback=text=>window.feedback=text;
 const loadOrderWorkQueue=async()=>{},refreshAffectedOrderCaches=async()=>{},loadInventory=async()=>{},markMainPageDirty=()=>{};
 document.getElementById('authStarting').remove();
 document.getElementById('appContainer').style.display='block';
 document.getElementById('inventory-system').style.display='block';
 document.getElementById('inventoryStockPanel').style.display='none';
 document.getElementById('inventoryShippingPanel').style.display='block';
`;
(async()=>{
 const server=http.createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end(html);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844}});
  page.setDefaultTimeout(5000);
  await page.addInitScript(()=>{window.print=()=>{};});
  const commits=new Map(),requests=[];let release,drop=true;
  page.on('pageerror',e=>{throw e;});
  await page.exposeFunction('commitParcelProbe',job=>new Promise(resolve=>{
   requests.push(JSON.parse(JSON.stringify(job)));
   const execute=()=>{
    if(!commits.has(job.operationId))commits.set(job.operationId,job.qty);
    resolve(drop?(drop=false,{error:'response lost'}):{ok:true});
   };
   if(requests.length===1)release=execute;else execute();
  }));
  async function mount(){
   await page.goto('http://127.0.0.1:'+server.address().port);
   await page.addStyleTag({path:path.join(root,'styles.css')});
   await page.addScriptTag({content:setup});
   await page.addScriptTag({path:path.join(root,'modules/warehouse-logistics.js')});
   await page.addScriptTag({content:`
    warehouseParcelSourceRows=()=>all;
    commitWarehouseParcelJob=async job=>{const result=await commitParcelProbe(job);if(result.error)throw Error(result.error);};
    renderInventoryShipping=()=>renderWarehouseParcels();
   `});
   await page.addScriptTag({path:path.join(root,'modules/warehouse-parcels.js')});
   await page.evaluate(()=>renderWarehouseParcels());
  }
  await mount();
  assert.equal(await page.locator('#warehouseParcelCards .parcel-card').count(),2,'same recipient is split by physical source warehouse');
  const first=page.locator('#warehouseParcelCards .parcel-card').first();
  await first.getByRole('button',{name:'列印貼紙'}).click();
  await page.waitForFunction(()=>document.getElementById('warehousePrintFrame')?.contentDocument?.body?.textContent.includes('ABC-001'));
  const label=await page.locator('#warehousePrintFrame').evaluate(frame=>frame.srcdoc);
  assert.match(label,/100mm 75mm/);
  assert.match(label,/ABC-002/);
  assert.doesNotMatch(label,/ORDER-01/);
  assert.equal(await first.locator('.parcel-items li').count(),2);
  await first.getByRole('button',{name:'確認寄出',exact:true}).click();
  const dialog=page.locator('#warehouseParcelDialog');
  await dialog.getByRole('spinbutton').first().fill('1');
  await dialog.getByRole('button',{name:'確認寄出',exact:true}).click();
  await page.waitForFunction(()=>!document.getElementById('warehouseParcelDialog').open);
  assert.equal(await page.locator('.parcel-task').count(),1);
  await page.locator('#warehouseParcelCards .parcel-card:not(.parcel-task)').getByRole('button',{name:'確認寄出',exact:true}).click();
  assert.ok(await dialog.isVisible(),'other recipients remain operable during a blocked request');
  await dialog.getByRole('button',{name:'返回',exact:true}).click();
  release();
  await page.locator('.parcel-task').getByRole('button',{name:'核對／重試原寄貨'}).waitFor();
  const originalId=requests[0].operationId;
  await mount();
  await page.locator('.parcel-task').getByRole('button',{name:'核對／重試原寄貨'}).click();
  await page.waitForFunction(()=>!document.querySelector('.parcel-task'));
  assert.equal(requests[1].operationId,originalId);
  assert.equal(requests[1].qty,1);
  assert.equal(commits.size,2,'lost-response replay keeps one result per item');
  assert.equal(requests.length,3);
  // Browser storage failure must prevent dispatch and leave the confirmation open.
  await mount();
  await page.locator('#warehouseParcelCards .parcel-card').first().getByRole('button',{name:'確認寄出',exact:true}).click();
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('quota');};});
  await dialog.getByRole('button',{name:'確認寄出',exact:true}).click();
  assert.ok(await dialog.isVisible());
  assert.equal(requests.length,3);
  await dialog.getByRole('button',{name:'返回',exact:true}).click();
  await page.evaluate(()=>{currentUserRole='sales';renderWarehouseParcels();});
  assert.equal(await page.locator('#warehouseParcelCards button').count(),0);
  console.log('PASS recipient grouping, partial quantities, non-blocking confirmation, lost response and reload replay, storage failure, role denial');
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
