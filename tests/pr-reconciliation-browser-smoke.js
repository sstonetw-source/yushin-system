// Actual product/analysis markup, handlers and shared CSS; isolated data only.
const fs=require('node:fs'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
const {chromium}=require('playwright-core');
const app=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8');
const fn=name=>{const start=app.indexOf('function '+name+'(');assert.ok(start>=0);return app.slice(start,app.indexOf('\n}',start)+2);};
const handler=name=>{const start=app.indexOf('window.'+name+' = ');assert.ok(start>=0);return app.slice(start,app.indexOf('\n};',start)+3);};
const bootstrap=`
let currentUserRole='admin',tradeAnalysisTab='selling',tradeAnalysisSensitiveVisible=true,tradeAnalysisReady=true;
let salesStatisticsLoadPromise=null,tradeAnalysisFiltersPending=false,tradeAnalysisSimplePage=0,tradeAnalysisSimpleRows=[];
let tradeAnalysisAppliedFilters={start:'2026-10-01',end:'2026-10-15'};
const inventoryAnalysisLots=[],salesStatisticsOrders=[],inventoryAnalysisSupplyOrders=[],tradeAnalysisWarehouseStocks=[];
const tradeAnalysisSourceOrders=new Map();
let productManagementSearchInProgress=false;
const rows=[{documentNo:'O',brand:'測試廠牌',code:'P',name:'測試產品',values:[1000,800,200,123]}];
const salesStatisticOrderLines=o=>o.items||[],populateSalesStatisticsFilters=()=>{},buildSimpleTradeAnalysis=()=>rows;
const formatStatsMoney=v=>String(v),escapeHtml=v=>String(v),localDateString=()=> '2026-10-15';
const markTradeAnalysisFiltersPending=()=>{},closeTradeAnalysisDetail=()=>{};
const renderAdminStatistics=()=>renderSalesStatistics();
`;
(async()=>{
 const executablePath=process.env.CHROME_EXECUTABLE_PATH||['google-chrome','google-chrome-stable','chromium'].map(cmd=>spawnSync('which',[cmd],{encoding:'utf8'})).find(r=>r.status===0)?.stdout.trim();
 assert.ok(executablePath,'Chrome is required');
 const browser=await chromium.launch({executablePath,args:['--no-sandbox','--disable-dev-shm-usage']}),errors=[];
 try{
  for(const width of [1280,390]){
   const page=await browser.newPage({viewport:{width,height:950},isMobile:width<768,hasTouch:width<768});
   page.on('pageerror',e=>errors.push(e.message));
   const fragment=await page.evaluate(html=>{
    const d=new DOMParser().parseFromString(html,'text/html');
    const product=d.getElementById('product-system'),analysis=d.getElementById('admin-statistics');
    const scope=d.getElementById('tradeAnalysisScope');scope.hidden=true;analysis.appendChild(scope);
    product.style.display='block';analysis.style.display='block';
    return '<html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="appContainer">'+product.outerHTML+analysis.outerHTML+'</div></body></html>';
   },html);
   await page.setContent(fragment);await page.addStyleTag({content:fs.readFileSync('styles.css','utf8')});
   await page.addScriptTag({content:bootstrap});
   for(const name of ['updateProductSearchControls','simpleTradeAnalysisLabels','renderSimpleTradeAnalysisPage','resetSimpleTradeAnalysisDetail'])await page.addScriptTag({content:fn(name)});
   for(const name of ['renderSalesStatistics','toggleTradeAnalysisSensitive','toggleSimpleTradeAnalysisDetail','switchTradeAnalysisTab'])await page.addScriptTag({content:handler(name)});
   await page.evaluate(()=>{document.getElementById('productSearchBrandButtons').textContent='請選擇廠牌（可略過）';updateProductSearchControls();switchTradeAnalysisTab('selling');});
   assert.equal(await page.locator('#productManagementSearch').isDisabled(),false);
   assert.equal(await page.locator('#productManagementSearchBtn').isDisabled(),true);
   await page.locator('#productManagementSearch').fill('P-123');assert.equal(await page.locator('#productManagementSearchBtn').isDisabled(),false);
   assert.equal(await page.locator('#productManagementSearchBrand').inputValue(),'');
   assert.match(await page.locator('#tradeAnalysisCards').textContent(),/毛利/);
   await page.locator('#tradeAnalysisSensitiveBtn').click();assert.equal(await page.locator('#tradeAnalysisSensitiveBtn').textContent(),'顯示毛利');
   assert.doesNotMatch(await page.locator('#tradeAnalysisCards').textContent(),/毛利/);
   // The data loader normally enables detail controls after a successful query.
   await page.locator('#tradeAnalysisToggleBtn').evaluate(el=>el.disabled=false);
   await page.locator('#tradeAnalysisToggleBtn').click();
   assert.doesNotMatch(await page.locator('#tradeAnalysisTableHead').textContent(),/毛利/);
   assert.doesNotMatch(await page.locator('#unifiedBrandAnalyticsBody').textContent(),/123/);
   await page.locator('#tradeAnalysisSensitiveBtn').click();assert.match(await page.locator('#tradeAnalysisCards').textContent(),/毛利/);
   await page.evaluate(()=>switchTradeAnalysisTab('purchasing'));assert.equal(await page.locator('#tradeAnalysisSensitiveBtn').isVisible(),false);
   if(width<768){
    await page.evaluate(()=>switchTradeAnalysisTab('selling'));
    assert.ok(await page.locator('#tradeAnalysisSensitiveBtn').evaluate(el=>el.getBoundingClientRect().height)>=44);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'mobile page must not overflow');
   }
   console.log('PR reconciliation '+width+'px: exact-code controls, margin cards/detail, shared touch sizing passed');
   await page.close();
  }
  assert.deepEqual(errors,[]);
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
