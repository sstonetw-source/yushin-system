'use strict';
// Real page structure, no app scripts, credentials, network reads or business mutations.
const fs=require('node:fs'),assert=require('node:assert/strict'),cp=require('node:child_process'),{chromium}=require('playwright-core');
const html=fs.readFileSync('index.html','utf8'),css=fs.readFileSync('styles.css','utf8');
const ids=['quote-system','forecast-system','product-system','order-system','purchasing-system','inventory-system','equipment-system','admin-system'];
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','chromium'].map(n=>cp.spawnSync('which',[n],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
 const browser=await chromium.launch({executablePath,args:['--no-sandbox']});
 try{for(const width of [1440,1024,390]){
  const page=await browser.newPage({viewport:{width,height:1000}});
  await page.setContent(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<link\b[^>]*>/gi,''));await page.addStyleTag({content:css});
  await page.evaluate(()=>{document.getElementById('loginScreen').style.display='none';document.getElementById('authStarting').style.display='none';document.getElementById('appContainer').style.display='block';});
  const quoteSource=fs.readFileSync('src/features/quotations/quotation-workspace.js','utf8');
  const rowTemplate=quoteSource.slice(quoteSource.indexOf('window.addQuoteRow =')).match(/tr.innerHTML = `([\s\S]*?)`;/)[1];
  await page.evaluate(template=>{const rowCount=1,itemData={model:'74104',nameCn:'核酸純化試劑組',nameEn:'RNeasy Mini Kit (50)',brand:'Qiagen',spec:'50 preps',qty:2,price:12000},escapeAttr=x=>String(x),brandIdForName=()=>'';document.getElementById('quoteItems').innerHTML='<tr>'+eval('`'+template+'`')+'</tr>';},rowTemplate);
  let first;
  for(const id of ids){
   await page.evaluate(id=>{document.querySelectorAll('.content-section').forEach(e=>{e.style.display=e.id===id?'block':'none';});},id);
   const title=await page.locator('#'+id+' .workspace-page-title').evaluate(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return {x:r.x,y:r.y,font:s.fontFamily,size:s.fontSize,weight:s.fontWeight,color:s.color};});
   first??=title;assert.deepEqual(title,first,'heading alignment and typography: '+id+' '+width);
   const controls=await page.locator('#'+id+' input:not([type=hidden]),#'+id+' select').evaluateAll(es=>es.filter(e=>e.getClientRects().length).map(e=>({font:getComputedStyle(e).fontFamily,bg:getComputedStyle(e).backgroundColor})));assert.ok(controls.every(c=>c.font===title.font),id+' field font');
   if(process.env.WARM_SAND_SCREENSHOT_DIR){fs.mkdirSync(process.env.WARM_SAND_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:process.env.WARM_SAND_SCREENSHOT_DIR+'/'+id+'-'+width+'.png',fullPage:true});}
  }
  await page.evaluate(()=>{document.querySelectorAll('.content-section').forEach(e=>e.style.display=e.id==='quote-system'?'block':'none');});
  const input=page.locator('#clientName');await input.fill('暖砂測試客戶');assert.equal(await input.inputValue(),'暖砂測試客戶');if(width===390){const bounds=await page.locator('#quoteItems tr').boundingBox();assert.ok(bounds.x+bounds.width<=width,'quote card fits viewport');assert.ok(await page.locator('#quoteItems input:not([type=hidden]),#quoteItems textarea,#quoteItems select').evaluateAll(es=>es.filter(e=>e.getClientRects().length).every(e=>e.getBoundingClientRect().right<=innerWidth)));}assert.equal(await input.evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(240, 235, 226)');assert.ok((await input.boundingBox()).height>=44);
  assert.equal(await page.evaluate(()=>getComputedStyle(document.body).backgroundColor),'rgb(216, 208, 195)');
  console.log('Warm sand '+width+'px: all eight module titles, shared control fonts, quote editing and palette.');await page.close();
 }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
