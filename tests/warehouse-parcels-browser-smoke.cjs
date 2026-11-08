const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES
 ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright' : 'playwright-core');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const chrome=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(name=>spawnSync('which',[name],{encoding:'utf8'})).find(result=>result.status===0)?.stdout.trim();
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
 assert.ok(chrome,'Headless Chrome required');
 const browser=await chromium.launch({executablePath:chrome,args:['--no-sandbox']});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  const context=await browser.newContext({viewport:{width:390,height:844}});
  const page=await context.newPage();
  page.setDefaultTimeout(5000);
  await context.addInitScript(()=>{window.print=()=>{};});
  const commits=new Map(),requests=[];let release,drop=true,failureAt=0;
  page.on('pageerror',e=>{throw e;});
  await page.context().exposeFunction('commitParcelProbe',job=>new Promise(resolve=>{
   requests.push(JSON.parse(JSON.stringify(job)));const attempt=requests.length;
   const execute=()=>{
    if(!commits.has(job.operationId))commits.set(job.operationId,job.qty);
    resolve(drop||attempt===failureAt?(drop=false,{error:'response lost'}):{ok:true});
   };
   if(requests.length===1)release=execute;else execute();
  }));
  async function mount(target=page){
   await target.goto('http://127.0.0.1:'+server.address().port);
   await target.addStyleTag({path:path.join(root,'styles.css')});
   await target.addScriptTag({content:setup});
   await target.addScriptTag({path:path.join(root,'modules/warehouse-logistics.js')});
   await target.addScriptTag({content:`
    warehouseParcelSourceRows=()=>all;
    commitWarehouseParcelJob=async job=>{const result=await commitParcelProbe(job);if(result.error)throw Error(result.error);};
    renderInventoryShipping=()=>renderWarehouseParcels();
   `});
   await target.addScriptTag({path:path.join(root,'modules/warehouse-parcels.js')});
   await target.evaluate(()=>renderWarehouseParcels());
  }
  await mount();
  assert.equal(await page.locator('#warehouseParcelCards .parcel-card').count(),2,'same recipient is split by physical source warehouse');
  await page.evaluate(()=>{window.inventoryShippingActiveKind=()=> 'main';renderWarehouseParcels();});
  assert.equal(await page.locator('#warehouseParcelCards .parcel-card').count(),1,'main-warehouse tab excludes branch parcels');
  assert.match(await page.locator('#warehouseParcelCards').innerText(),/ABC-001/);
  assert.doesNotMatch(await page.locator('#warehouseParcelCards').innerText(),/ABC-003/);
  await page.evaluate(()=>{window.inventoryShippingActiveKind=()=> 'branch';renderWarehouseParcels();});
  assert.equal(await page.locator('#warehouseParcelCards .parcel-card').count(),1,'branch tab excludes main parcels');
  assert.match(await page.locator('#warehouseParcelCards').innerText(),/ABC-003/);
  assert.doesNotMatch(await page.locator('#warehouseParcelCards').innerText(),/ABC-001/);
  await page.evaluate(()=>{delete window.inventoryShippingActiveKind;renderWarehouseParcels();});
  const first=page.locator('#warehouseParcelCards .parcel-card').first();
  assert.match(await first.locator('.parcel-destination').innerText(),/王小姐/,'recipient and address stay prominent');
  assert.match(await first.locator('.parcel-contents').innerText(),/ABC-001/,'product and quantity stay prominent');
  assert.equal(await first.locator('.parcel-extra-details').evaluate(node=>node.open),false,'secondary shipping information starts collapsed');
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
  // A completed first item stays completed when the second reply is lost.
  const before=requests.length;failureAt=before+2;
  await mount();
  await page.locator('#warehouseParcelCards .parcel-card').first().getByRole('button',{name:'確認寄出',exact:true}).click();
  await dialog.getByRole('button',{name:'確認寄出',exact:true}).click();
  await page.locator('.parcel-task').getByRole('button',{name:'核對／重試原寄貨'}).waitFor();
  assert.equal(await page.locator('.parcel-task').innerText().then(t=>t.includes('已確認 1／2')),true);
  const second=await page.context().newPage();
  await mount(second);
  assert.equal(await second.locator('.parcel-task').count(),1,'same-browser tab restores progress');
  const taskId=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('warehouse-parcels:'))))[0].id);
  await Promise.all([page.evaluate(id=>resumeWarehouseParcel(id),taskId),second.evaluate(id=>resumeWarehouseParcel(id),taskId)]);
  await page.waitForFunction(()=>!document.querySelector('.parcel-task'));
  await second.waitForFunction(()=>!document.querySelector('.parcel-task'));
  assert.equal(requests.length,before+3,'cross-tab lock sends only the unfinished item once');
  assert.equal(requests[before+1].operationId,requests[before+2].operationId);
  await second.close();
  const afterRetry=requests.length;
  // Browser storage failure must prevent dispatch and leave the confirmation open.
  await mount();
  await page.locator('#warehouseParcelCards .parcel-card').first().getByRole('button',{name:'確認寄出',exact:true}).click();
  await page.evaluate(()=>{Storage.prototype.setItem=()=>{throw Error('quota');};});
  await dialog.getByRole('button',{name:'確認寄出',exact:true}).click();
  assert.ok(await dialog.isVisible());
  assert.equal(requests.length,afterRetry);
  await dialog.getByRole('button',{name:'返回',exact:true}).click();
  await page.evaluate(()=>{currentUserRole='sales';renderWarehouseParcels();});
  assert.equal(await page.locator('#warehouseParcelCards button').count(),0);
  // Long recipient details and item names remain whole on continued labels.
  await mount();
  await page.evaluate(()=>{
    window.labelAlerts=[];window.alert=message=>labelAlerts.push(message);
    const plan={...recipient,address:'台北市中正區仁愛路一段一百二十三號十二樓之三國際醫療研究中心臨床檢驗科收件處'};
    printWarehouseAddressGroups([{warehouseId:'main',plan,rows:Array.from({length:24},(_,i)=>({qty:i+1,item:{itemCode:'LONG-'+i,itemName:'臨床檢驗用多項生化免疫分析試劑組含配套校正液及品質控制材料'}}))}]);
  });
  await page.waitForFunction(()=>document.getElementById('warehousePrintFrame')?.contentDocument?.querySelectorAll('.label').length>1);
  const printed=await page.locator('#warehousePrintFrame').evaluate(frame=>{
    const doc=frame.contentDocument,ruler=doc.createElement('div');ruler.style.height='67mm';doc.body.append(ruler);
    const limit=ruler.getBoundingClientRect().height;ruler.remove();
    return {pages:[...doc.querySelectorAll('.label')].map(n=>({height:n.getBoundingClientRect().height,recipient:n.querySelector('h2').textContent,address:n.querySelector('.address').textContent})),rows:doc.querySelectorAll('tbody tr').length,limit};
  });
  assert.deepEqual(await page.evaluate(()=>labelAlerts),[]);
  assert.equal(printed.rows,24);
  assert.ok(printed.pages.every(p=>p.height<=printed.limit&&p.recipient.includes('王小姐')&&p.address.endsWith('臨床檢驗科收件處')));
  console.log('PASS recipient grouping, partial quantities, non-blocking confirmation, lost response and reload replay, cross-tab lock, partially completed retry, storage failure, role denial');
 }finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
