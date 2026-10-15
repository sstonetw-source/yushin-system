const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const app=fs.readFileSync('app.js','utf8'),html=fs.readFileSync('index.html','utf8');
const fn=name=>{const start=app.indexOf('function '+name+'(');assert.ok(start>=0,name);return app.slice(start,app.indexOf('\n}',start)+2);};
const windowFn=name=>{const start=app.indexOf('window.'+name+' = ');assert.ok(start>=0,name);return app.slice(start,app.indexOf('\n};',start)+3);};

test('pending and failed initial sync do not enter purchase, dispatch or shipping display queues',()=>{
 const x=vm.createContext({itemDispatchState:()=>({pending:2,shippable:1}),orderItemDisplayCategory:o=>o.status==='cancelled'?'closed':'ordering',
  normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',normalizedOrderItems:o=>o.items,
  orderLifecycleInfo:()=>({status:'normal'}),orderItemWorkCategory:()=> 'ordering',procurementDemandForOrderItem:()=>({remainingToOrderQty:3})});
 for(const name of ['orderItemDisplayCategories','pendingProcurementDisplayLines'])vm.runInContext(fn(name),x);
 const item={itemId:'I',qty:5};
 for(const status of ['pending','failed']){
  const order={status:'active',inventoryReservationStatus:status,items:[item]};
  assert.equal(x.orderItemDisplayCategories(order,item).length,0);assert.equal(x.pendingProcurementDisplayLines(order).length,0);
  order.status='cancelled';assert.deepEqual(Array.from(x.orderItemDisplayCategories(order,item)),['closed']);
 }
 const complete={status:'active',inventoryReservationStatus:'completed',items:[item]};
 assert.deepEqual(Array.from(x.orderItemDisplayCategories(complete,item)),['ordering','dispatch','shipping']);
 assert.equal(x.pendingProcurementDisplayLines(complete)[0].qty,3);
});

test('manual stock labels retain quantity semantics and fixed purchaser printing responsibility',()=>{
 const x=vm.createContext({window:{}});vm.runInContext(fn('inventoryAdjustmentTitle'),x);
 assert.equal(x.inventoryAdjustmentTitle('initial'),'手動新增庫存');assert.equal(x.inventoryAdjustmentTitle('scrap'),'報廢');
 assert.match(html,/＋ 手動新增庫存/);assert.match(html,/value="initial">手動新增庫存（含期初庫存）/);
 assert.match(html,/Excel 批次新增/);assert.match(app,/又鑫_庫存批次匯入範本\.xlsx/);
 assert.doesNotMatch(html+fs.readFileSync('modules/page-help.js','utf8'),/行政負責打單|待行政打單|行政完成打單/);
 assert.match(html,/採購負責打單|採購.*打單/);
});

function analysisFixture(){
 const nodes={},sheets=[],rows=[{documentNo:'O1',brand:'Brand',code:'P',name:'Product',line:'Line',type:'Type',values:[1000,800,200,123]}];
 const node=id=>nodes[id]||(nodes[id]={hidden:false,innerHTML:'',textContent:'',setAttribute(name,value){this[name]=value;}});
 const x=vm.createContext({window:null,currentUserRole:'admin',tradeAnalysisTab:'selling',tradeAnalysisSensitiveVisible:true,
  tradeAnalysisReady:true,tradeAnalysisFiltersPending:false,salesStatisticsLoadPromise:null,inventoryAnalysisLots:[],salesStatisticsOrders:[],
  tradeAnalysisSimpleRows:rows,tradeAnalysisSimplePage:0,tradeAnalysisAppliedFilters:{start:'2026-10-01',end:'2026-10-15'},
  document:{getElementById:node},escapeHtml:String,formatStatsMoney:String,localDateString:()=> '2026-10-15',
  salesStatisticOrderLines:o=>o.items||[],populateSalesStatisticsFilters(){},resetSimpleTradeAnalysisDetail(){},buildSimpleTradeAnalysis:()=>rows,
  beginActionButton:()=>({}),endActionButton(){},ensureXlsxLoaded:async()=>{},alert:message=>{throw Error(message);},
  XLSX:{utils:{book_new:()=>({}),json_to_sheet:rows=>rows,book_append_sheet:(_wb,rows,name)=>sheets.push({name,rows})},writeFile(){}}});
 vm.runInContext('window=globalThis',x);
 for(const name of ['simpleTradeAnalysisLabels','renderSimpleTradeAnalysisPage'])vm.runInContext(fn(name),x);
 for(const name of ['renderSalesStatistics','toggleTradeAnalysisSensitive','exportTradeAnalysis'])vm.runInContext(windowFn(name),x);
 return {x,nodes,sheets,rows};
}
test('one privacy flag hides sales margin cards, detail cells and Excel fields without changing rows',async()=>{
 const {x,nodes,sheets,rows}=analysisFixture(),before=structuredClone(rows);
 x.renderSalesStatistics();x.renderSimpleTradeAnalysisPage();
 assert.match(nodes.tradeAnalysisCards.innerHTML,/毛利/);assert.match(nodes.unifiedBrandAnalyticsBody.innerHTML,/>123</);
 x.toggleTradeAnalysisSensitive();x.renderSimpleTradeAnalysisPage();
 assert.doesNotMatch(nodes.tradeAnalysisCards.innerHTML,/毛利/);assert.doesNotMatch(nodes.tradeAnalysisTableHead.innerHTML,/毛利/);
 assert.doesNotMatch(nodes.unifiedBrandAnalyticsBody.innerHTML,/>123</);assert.equal(nodes.tradeAnalysisSensitiveBtn.textContent,'顯示毛利');
 await x.exportTradeAnalysis();
 assert.equal(sheets[0].rows.some(row=>row['項目']==='毛利率'),false);
 assert.equal(sheets[1].rows.some(row=>'毛利' in row||'毛利率' in row),false);assert.equal(sheets[1].rows[0]['銷售金額'],1000);
 assert.deepEqual(rows,before);
 x.toggleTradeAnalysisSensitive();await x.exportTradeAnalysis();assert.equal(sheets[3].rows[0]['毛利'],123);
});
test('privacy remains a sales presentation option and cannot change role or purchasing/inventory totals',()=>{
 const {x}=analysisFixture();
 for(const role of ['sales','engineer','purchaser','warehouse']){x.currentUserRole=role;x.toggleTradeAnalysisSensitive();assert.equal(x.tradeAnalysisSensitiveVisible,true);}
 x.currentUserRole='admin';x.tradeAnalysisSensitiveVisible=false;
 for(const tab of ['purchasing','inventory']){x.tradeAnalysisTab=tab;assert.equal(x.simpleTradeAnalysisLabels().length,3);}
});
test('hiding margin while the Excel library loads cancels an export that would disclose it',async()=>{
 const {x,sheets}=analysisFixture();let resume;
 x.ensureXlsxLoaded=()=>new Promise(resolve=>{resume=resolve;});const exportJob=x.exportTradeAnalysis();
 x.toggleTradeAnalysisSensitive();resume();await assert.rejects(exportJob,/毛利顯示設定已變更/);assert.equal(sheets.length,0);
});
test('role loss during Excel loading does not produce a workbook',async()=>{
 const {x,sheets}=analysisFixture();let resume;
 x.ensureXlsxLoaded=()=>new Promise(resolve=>{resume=resolve;});const exportJob=x.exportTradeAnalysis();
 x.currentUserRole='sales';resume();await assert.rejects(exportJob,/登入身份/);assert.equal(sheets.length,0);
});
