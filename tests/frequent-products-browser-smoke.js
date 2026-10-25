/* Real product markup/handlers with an isolated query and clipboard fixture. */
const fs=require('node:fs'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright-core');
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(cmd=>spawnSync('which',[cmd],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
 assert.ok(executablePath,'Chrome is required');
 const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']});
 const errors=[];
 try {
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:1000}});page.on('pageerror',e=>errors.push(e.message));
   const fragment=await page.evaluate(html=>{const d=new DOMParser().parseFromString(html,'text/html');const section=d.getElementById('product-system');section.style.display='block';return section.outerHTML;},fs.readFileSync('index.html','utf8'));
   await page.setContent('<html lang="zh-Hant"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="appContainer">'+fragment+'</div></body></html>');
   await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
   await page.addScriptTag({content:`
    let currentUser={uid:'U'},currentUserRole='admin',trueUserRole='admin';
    const canAccessPage=()=>true,canEditPage=()=>true,resolveBrandName=x=>x,normalizeBrandLookupKey=x=>x.toLowerCase(),normalizeItemCodeLoose=x=>x.toLowerCase();
    const escapeHtml=x=>String(x??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;'),escapeAttr=escapeHtml;
    const inlineJsValue=x=>escapeHtml(JSON.stringify(x));
    const getUnifiedBrandEntries=()=>[{name:'Brand',active:true},{name:'Empty',active:true}],getPrimaryBrandNames=()=>['Brand','Empty'];
    const dedupeBrandsCaseInsensitive=x=>[...new Set(x)],brandMasterEntryForName=()=>({aliases:[]}),isBrandPriceListActive=()=>true;
    const firestoreReadWithTimeout=p=>p,firebase={firestore:{FieldPath:{documentId:()=> '__name__'}}};
    let queryCount=0,writeCount=0,copied='',feedback='',alerts=[];
    window.alert=s=>alerts.push(s);const showActionFeedback=s=>feedback=s;
    Object.defineProperty(navigator,'clipboard',{value:{writeText:async s=>{copied=s;}}});
    const records=[{id:'P1',brandName:'Brand',productName:'常賣產品',manufacturerPartNo:'B-001',listPrice:1200,isFrequentlySold:true,active:true,status:'ACTIVE'},
      {id:'P2',brandName:'Brand',productName:'其他產品',manufacturerPartNo:'B-002',listPrice:500,isFrequentlySold:false,active:true,status:'ACTIVE'}];
    const db={collection:()=>{let filters=[],cursor;const q={where:(f,op,v)=>{filters.push([f,v]);return q;},orderBy:()=>q,limit:()=>q,startAfter:d=>{cursor=d;return q;},
      get:async()=>{queryCount++;const docs=records.filter(r=>filters.every(([f,v])=>r[f]===v)).map(r=>({id:r.id,data:()=>({...r})}));return {docs,size:docs.length};},
      doc:id=>({update:async patch=>{writeCount++;Object.assign(records.find(r=>r.id===id),patch);}})};return q;}};
   `});
   for(const file of ['src/features/products/product-management.js','src/features/products/frequent-products.js','src/shared/action-feedback.js'])await page.addScriptTag({content:fs.readFileSync(file,'utf8')});
   await page.evaluate(()=>renderProductBrandBrowser());
   await page.getByRole('button',{name:'Brand',exact:true}).click();
   await page.waitForFunction(()=>productManagementResults.length===1);
   assert.match(await page.locator('#productManagementBody').textContent(),/常賣產品/);assert.doesNotMatch(await page.locator('#productManagementBody').textContent(),/其他產品/);
   await page.getByRole('button',{name:'複製資訊',exact:true}).click();
   assert.equal(await page.evaluate(()=>copied),'廠牌：Brand\n貨號：B-001\n品名：常賣產品\n建議售價：1,200');assert.equal(await page.evaluate(()=>queryCount),1);
   await page.getByRole('button',{name:'Brand',exact:true}).click();assert.equal(await page.evaluate(()=>queryCount),1);
   for(const role of ['sales','engineer','warehouse','purchaser','admin']){
    await page.evaluate(role=>{currentUserRole=role;trueUserRole=role;renderProductManagementResults();},role);
    assert.equal(await page.getByRole('button',{name:'移出常賣',exact:true}).count(),['admin','purchaser'].includes(role)?1:0);
    assert.equal(await page.getByRole('button',{name:'複製資訊',exact:true}).count(),1);
   }
   const row=page.locator('#productManagementBody tr').first();
   if(width===390){assert.equal(await row.locator('button').evaluateAll(bs=>bs.every(b=>b.getBoundingClientRect().height>=44)),true);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);}
   await page.screenshot({path:'/tmp/product-frequent-'+width+'.png',fullPage:true});
   await page.getByRole('button',{name:'移出常賣',exact:true}).click();await page.waitForFunction(()=>writeCount===1&&productManagementResults.length===0);
   await page.evaluate(()=>{productManagementResults=[records[1]];productManagementSourceMode='search';renderProductManagementResults();});
   await page.getByRole('button',{name:'設為常賣',exact:true}).click();await page.waitForFunction(()=>writeCount===2);
   await page.getByRole('button',{name:'Brand',exact:true}).click();await page.waitForFunction(()=>productManagementResults.length===1);
   assert.equal(await page.locator('#productManagementBody').getByText('B-002',{exact:true}).count(),1);
   await page.getByRole('button',{name:'Empty',exact:true}).click();await page.waitForFunction(()=>!productManagementSearchInProgress);
   assert.match(await page.locator('#productManagementSearchStatus').textContent(),/尚未設定/);
   assert.deepEqual(await page.evaluate(()=>alerts),[]);
   console.log(width+'px: shared favourites, cache, copy, five role displays, empty state and layout passed.');await page.close();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
