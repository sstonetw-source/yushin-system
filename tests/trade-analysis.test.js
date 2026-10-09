const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const core=require('../modules/trade-analysis-core.js');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function fn(name){
    const start=source.indexOf(`function ${name}(`);
    assert.ok(start>=0,name);
    return source.slice(start,source.indexOf('\n}',start)+2);
}
function fixture(){
    const orders=[{id:'O1',orderNo:'SO1',customerName:'客戶甲',salesName:'業務甲',orderDate:'2026-08-01',brand:'主要',productId:'P1',itemCode:'A',itemName:'A品',qty:10,unitPrice:100,totalPrice:1000,
        deliveryRecords:[{id:'D1',date:'2026-10-02',qty:4}],returnRecords:[{id:'R1',date:'2026-10-03',qty:1}]},
        {id:'O2',orderNo:'SO2',customerName:'客戶乙',salesName:'業務乙',orderDate:'2026-08-01',brand:'別家',qty:2,unitPrice:50,totalPrice:100,deliveryRecords:[],returnRecords:[]}];
    const supplies=[{id:'S1',orderId:'O1',productId:'P1',brand:'主要',qty:10,receivedQty:4,unitCost:20,status:'PARTIAL_RECEIPT',fulfillmentType:'DIRECT_SHIP',orderDate:'2026-08-01',purchaseDocumentNo:'PO1',supplier:'供應商甲'},
        {id:'S2',productId:'P1',brand:'主要',qty:4,receivedQty:4,unitCost:30,status:'RECEIVED',orderDate:'2026-08-01',supplier:'供應商乙'},
        {id:'S3',productId:'P1',brand:'主要',qty:5,receivedQty:2,unitCost:99,status:'CANCELLED'}];
    const context=vm.createContext({
        salesStatisticsOrders:orders,inventoryAnalysisSupplyOrders:supplies,
        inventoryAnalysisReceipts:[{id:'RC1',supplyOrderId:'S1',brand:'主要',productId:'P1',receiptDate:'2026-10-01',qty:4,fulfillmentType:'DIRECT_SHIP'},
            {id:'RC2',supplyOrderId:'S2',brand:'主要',productId:'P1',receiptDate:'2026-10-02',qty:4,lotId:'L1',fulfillmentType:'WAREHOUSE'}],
        inventoryAnalysisLots:[{id:'L1',productId:'P1',remainingQty:2,sourceType:'SUPPLY_ORDER',sourceId:'S2'},
            {id:'L2',productId:'P1',remainingQty:1,sourceType:'INITIAL_STOCK'}],
        inventoryAnalysisLotCosts:new Map([['L1',{unitCost:30}]]),tradeAnalysisSourceOrders:new Map(orders.map(row=>[row.id,row])),
        TRADE_ANALYSIS_LABELS:{incoming:'待到貨採購',purchases:'已進貨',pending:'待送貨訂單',sales:'已銷貨',stock:'目前庫存'},
        findPriceItemForOrder:row=>row.productId==='P1'?{model:'A',nameCn:'A品',productId:'P1'}:null,
        statisticBrandForOrder:row=>row.productId==='P1'||row.brand==='主要'?'主要':'其他廠牌',brandIdentityForRecord:row=>({brand:row.productId==='P1'?'主要':row.brand||''}),
        productLineForOrder:row=>row.productId==='P1'?'試劑線':'未分類',productTypeForOrder:row=>row.productId==='P1'?'試劑':'未分類',
        normalizedOrderItems:order=>order.items||[{qty:order.qty}],
        stripPhoneSuffix:value=>value,savedDeliveryRecords:order=>order.deliveryRecords||[],savedReturnRecords:order=>order.returnRecords||[],
        orderQuantity:order=>order.qty,salesAmount:order=>order.totalPrice,orderUnitCostForStats:()=>null,
        normalizedOrderStatus:order=>order.status==='cancelled'?'cancelled':'normal',localDateString:()=> '2026-10-04',isPurchaseTerminalStatus:status=>['CANCELLED','CLOSED'].includes(status)
    });
    ['salesStatisticOrderLines','dateInStatsRange','orderUnitSalesAmount','calculateOrderStatsContribution','tradeAnalysisCost','buildTradeAnalysisRows','tradeAnalysisExportRows'].forEach(name=>vm.runInContext(fn(name),context));
    return context;
}
const filters={start:'2026-10-01',end:'2026-10-04'};
test('partial deliveries and returns split actual versus currently pending, including older orders',()=>{
    const x=fixture();const report=core.summarize(x.buildTradeAnalysisRows(),filters);
    assert.equal(report.totals.sales,300);assert.equal(report.totals.pending,800);
    assert.equal(report.details.sales.length,2);
    assert.equal(report.details.pending.find(row=>row.orderId==='O1').qty,7);
});
test('receipts use event dates, include direct shipment once, and retain older outstanding purchasing',()=>{
    const x=fixture();const report=core.summarize(x.buildTradeAnalysisRows(),filters);
    assert.equal(report.totals.purchases,200);assert.equal(report.totals.incoming,120);
    assert.equal(report.details.purchases.length,2);assert.equal(report.details.incoming.length,1);
    assert.equal(report.details.purchases[0].documentNo,'PO1');
    assert.equal(report.details.purchases[0].customer,'客戶甲');
});
test('stock uses remaining lot quantities and missing protected costs are explicitly excluded',()=>{
    const x=fixture();const report=core.summarize(x.buildTradeAnalysisRows(),filters);
    assert.equal(report.totals.stock,60);assert.equal(report.missing.stock,1);
    assert.equal(report.details.stock.length,2);
    assert.equal(report.details.stock[0].code,'A');
});
test('salesperson applies to sales while shared purchases and stock stay company-wide',()=>{
    const x=fixture();const report=core.summarize(x.buildTradeAnalysisRows(),{...filters,sales:'業務乙'});
    assert.equal(report.totals.sales,0);assert.equal(report.totals.pending,100);
    assert.equal(report.totals.purchases,200);assert.equal(report.totals.incoming,120);assert.equal(report.totals.stock,60);
});
test('brand, product line and product type apply consistently to all five metrics',()=>{
    const rows=fixture().buildTradeAnalysisRows();
    for(const f of [{brand:'主要'},{line:'試劑線'},{type:'試劑'}]){
        const report=core.summarize(rows,{...filters,...f});
        assert.equal(report.totals.pending,700);assert.equal(report.totals.sales,300);
        assert.equal(report.totals.purchases,200);assert.equal(report.totals.incoming,120);assert.equal(report.totals.stock,60);
    }
    const other=core.summarize(rows,{...filters,brand:'其他廠牌'});assert.equal(other.totals.pending,100);assert.equal(other.totals.purchases,0);
});
test('historical date range never excludes current pending and stock',()=>{
    const report=core.summarize(fixture().buildTradeAnalysisRows(),{start:'2026-01-01',end:'2026-01-31'});
    assert.equal(report.totals.sales,0);assert.equal(report.totals.purchases,0);
    assert.equal(report.totals.pending,800);assert.equal(report.totals.incoming,120);assert.equal(report.totals.stock,60);
});
test('cancelled orders stop pending but preserve completed delivery and return transactions',()=>{
    const x=fixture();x.salesStatisticsOrders[0].status='cancelled';
    const report=core.summarize(x.buildTradeAnalysisRows(),filters);
    assert.equal(report.totals.pending,100);assert.equal(report.totals.sales,300);
});
test('Excel detail sums match the same snapshot totals, including negative return rows',()=>{
    const x=fixture();const report=core.summarize(x.buildTradeAnalysisRows(),filters);
    for(const kind of core.kinds){
        const exported=x.tradeAnalysisExportRows(report,kind);
        assert.equal(exported.reduce((sum,row)=>sum+(typeof row['金額']==='number'?row['金額']:0),0),report.totals[kind]);
    }
    assert.equal(x.tradeAnalysisExportRows(report,'sales')[1]['金額'],-100);
});
test('multi-product orders assign deliveries to each item without duplicating sales',()=>{
    const x=fixture();x.salesStatisticsOrders=[{id:'MULTI',salesName:'業務甲',orderNo:'M1',items:[
        {itemId:'I1',productId:'P1',brand:'主要',qty:2,unitPrice:100,totalPrice:200},
        {itemId:'I2',brand:'別家',qty:3,unitPrice:50,totalPrice:150}],
        deliveryRecords:[{itemId:'I1',qty:1,date:'2026-10-02'},{itemId:'I2',qty:2,date:'2026-10-02'}],
        returnRecords:[{itemId:'I2',qty:1,date:'2026-10-03'}]}];
    const report=core.summarize(x.buildTradeAnalysisRows(),filters);
    assert.equal(report.totals.sales,150);assert.equal(report.totals.pending,200);
});
test('zero cost is valid while invalid and absent cost never silently become zero',()=>{
    const x=fixture();for(const value of [null,undefined,'',-1,NaN,'abc'])assert.equal(x.tradeAnalysisCost(value),null);
    assert.equal(x.tradeAnalysisCost(0),0);assert.equal(x.tradeAnalysisCost('5'),5);
});
test('empty filter result has zero totals and no stale detail rows',()=>{
    const report=core.summarize(fixture().buildTradeAnalysisRows(),{...filters,type:'不存在'});
    for(const kind of core.kinds){assert.equal(report.totals[kind],0);assert.equal(report.details[kind].length,0);}
});

test('workbook uses every matching row with numeric totals and explicit filter scope',async()=>{
    const x=fixture();const report=core.summarize(x.buildTradeAnalysisRows(),filters);report.filters=filters;
    const saved=[];
    Object.assign(x,{currentUserRole:'admin',beginActionButton:()=>({}),endActionButton:()=>{},ensureXlsxLoaded:async()=>{},alert:message=>{throw Error(message);},
        XLSX:{utils:{book_new:()=>({sheets:[]}),json_to_sheet:rows=>({rows}),book_append_sheet:(wb,sheet,name)=>wb.sheets.push({sheet,name})},writeFile:wb=>saved.push(wb)}});
    vm.runInContext("globalThis.runRoleTransaction ||= callback => db.runTransaction(callback); globalThis.supplyOrdersCollection ||= () => db.collection('supplyOrders'); globalThis.syncReceivingSupplyViews ||= () => {};", x);
vm.runInContext('async '+fn('writeTradeAnalysisWorkbook'),x);
    await x.writeTradeAnalysisWorkbook(report,core.kinds,{});
    assert.equal(saved[0].sheets.length,6);
    const sales=saved[0].sheets.find(row=>row.name==='已銷貨').sheet.rows;
    assert.equal(sales.length,3);assert.equal(sales.at(-1)['金額'],300);
    assert.ok(saved[0].sheets[0].sheet.rows.some(row=>row['項目']==='業務篩選範圍'));
    x.currentUserRole='sales';await x.writeTradeAnalysisWorkbook(report,core.kinds,{});
    assert.equal(saved.length,1,'sales role cannot export company costs');
});

test('details display is bounded to 100 rows while exported report retains all rows',()=>{
    const x=fixture();const rows=x.buildTradeAnalysisRows().filter(row=>row.kind==='sales');
    const report=core.summarize(Array.from({length:101},(_,i)=>({...rows[0],eventId:'D'+i})),filters);report.filters=filters;
    const elements={};
    Object.assign(x,{currentUserRole:'admin',tradeAnalysisReady:true,salesStatisticsLoadPromise:null,tradeAnalysisReport:report,window:{},
        escapeHtml:s=>s,formatStatsMoney:n=>'NT$ '+n,
        document:{getElementById:id=>elements[id]||(elements[id]={classList:{add(){},remove(){}}})}});
    const start=source.indexOf('window.openTradeAnalysisDetail = function');const end=source.indexOf('\n};',start)+3;
    vm.runInContext("globalThis.runRoleTransaction ||= callback => db.runTransaction(callback); globalThis.supplyOrdersCollection ||= () => db.collection('supplyOrders'); globalThis.syncReceivingSupplyViews ||= () => {};", x);
vm.runInContext(source.slice(start,end),x);x.window.openTradeAnalysisDetail('sales');
    assert.equal((elements.tradeAnalysisDetailBody.innerHTML.match(/<tr>/g)||[]).length,100);
    assert.equal(x.tradeAnalysisExportRows(report,'sales').length,101);
    assert.match(elements.tradeAnalysisDetailSummary.textContent,/匯出包含全部明細/);
});

test('legacy delivered flags contribute estimated sales and exclude already delivered pending quantities',()=>{
 const c=fixture();const order=c.salesStatisticsOrders.find(o=>o.id==='O2');
 Object.assign(order,{isDelivered:true,orderDate:'2026-10-02'});
 const rows=c.buildTradeAnalysisRows();const report=core.summarize(rows,filters);
 assert.equal(report.totals.sales,400);assert.equal(report.totals.pending,700);
 const legacy=report.details.sales.find(row=>row.orderId==='O2');
 assert.equal(legacy.qty,2);assert.equal(legacy.date,'2026-10-02');assert.equal(legacy.estimated,true);assert.match(legacy.status,/推估/);
 order.deliveryRecords=[{id:'D2',date:'2026-10-03',qty:2}];
 const actual=c.buildTradeAnalysisRows().filter(row=>row.kind==='sales'&&row.orderId==='O2');
 assert.equal(actual.length,1);assert.equal(actual[0].event,'送貨');assert.equal(actual[0].estimated,undefined);
});
test('legacy multi-item delivered flags preserve line amounts and cancellation keeps actual historical sales',()=>{
 const c=fixture();const order=c.salesStatisticsOrders.find(o=>o.id==='O2');
 Object.assign(order,{isDelivered:true,status:'cancelled',orderDate:'2026-10-02',items:[
  {itemId:'A',qty:1,unitPrice:40,totalPrice:40},{itemId:'B',qty:1,unitPrice:60,totalPrice:60}
 ]});
 const rows=c.buildTradeAnalysisRows().filter(row=>row.orderId==='O2');
 assert.equal(rows.filter(row=>row.kind==='pending').length,0);
 assert.equal(rows.filter(row=>row.kind==='sales').length,2);
 assert.equal(rows.filter(row=>row.kind==='sales').reduce((sum,row)=>sum+row.amount,0),100);
 assert.equal(rows.every(row=>row.estimated),true);
});

function simpleFixture(tab){
 const x=fixture();Object.assign(x,{tradeAnalysisTab:tab,salesStatisticsQueryWindow:()=>filters,
 readTradeAnalysisFilters:()=>({...filters,brand:'',line:'',sales:'',type:''}),document:{getElementById:()=>({value:''})},tradeAnalysisWarehouseStocks:[{id:'W',productKey:'P1',productId:'P1',warehouseId:'WH',onHand:2,reserved:1}]});
 x.inventoryAnalysisLots[0].productKey='P1';x.inventoryAnalysisLots[0].warehouseId='WH';
 vm.runInContext(fn('buildSimpleTradeAnalysis'),x);return x;
}
test('purchase cohort balances partial receipt and excludes cancelled outstanding quantities',()=>{
 const x=simpleFixture('purchasing');x.inventoryAnalysisSupplyOrders.forEach(s=>s.orderDate='2026-10-01');
 const rows=x.buildSimpleTradeAnalysis();
 assert.deepEqual(Array.from(rows[0].values),[200,80,120]);
 assert.deepEqual(Array.from(rows[2].values),[198,198,0]);
 for(const r of rows)assert.equal(r.values[0],r.values[1]+r.values[2]);
 x.inventoryAnalysisSupplyOrders[0].status='CLOSED';assert.deepEqual(Array.from(x.buildSimpleTradeAnalysis()[0].values),[80,80,0]);
});
test('sales cohort uses actual shipment costs, net returns and explicit unknown costs',()=>{
 const x=simpleFixture('selling');x.salesStatisticsOrders[0].orderDate='2026-10-01';
 x.salesStatisticsOrders[0].deliveryRecords[0].lotAllocations=[{lotId:'L1',qty:4}];
 x.salesStatisticsOrders[0].returnRecords[0].lotAllocations=[{lotId:'L1',qty:1}];
 assert.deepEqual(Array.from(x.buildSimpleTradeAnalysis()[0].values),[1000,300,700,210]);
 x.inventoryAnalysisLotCosts.clear();assert.equal(x.buildSimpleTradeAnalysis()[0].values[3],null);
 x.salesStatisticsOrders[0].status='cancelled';assert.deepEqual(Array.from(x.buildSimpleTradeAnalysis()[0].values).slice(0,3),[300,300,0]);
});
test('inventory quantity and weighted valuation use warehouse stock and detect missing batch quantities',()=>{
 const x=simpleFixture('inventory');const row=x.buildSimpleTradeAnalysis()[0];
 assert.deepEqual(Array.from(row.quantities),[2,1,1]);assert.deepEqual(Array.from(row.values),[60,30,30]);
 x.tradeAnalysisWarehouseStocks[0].onHand=3;assert.deepEqual(Array.from(x.buildSimpleTradeAnalysis()[0].values),[null,null,null]);
});

function snapshotFixture(records={}) {
    const calls=[];
    const db={collection:name=>({name,clauses:[],where(...args){this.clauses.push(args);return this;},orderBy(){return this;}})};
    const x=fixture();
    Object.assign(x,{db,readQueryInBatches:async q=>{calls.push(q);return records[q.name]||[];},
        readDocumentsByIds:async(name,ids)=>{
            const unique=[...new Set(ids.filter(Boolean))];if(unique.length)calls.push({name,ids:unique});
            return (records[name]||[]).filter(row=>unique.includes(row.id));
        }});
    x.supplyOrdersCollection=()=>db.collection('supplyOrders');
    for(const name of ['readTradeAnalysisSuppliesByOrders','readTradeAnalysisLotCosts','loadTradeAnalysisSnapshot'])vm.runInContext('async '+fn(name),x);
    return {x,calls};
}
test('purchase analysis reads the chosen purchase cohort and source metadata without stock, receipts or all orders',async()=>{
    const {x,calls}=snapshotFixture({supplyOrders:[{id:'S',orderId:'O',productId:'P'}],orders:[{id:'O'}],products:[{id:'P'}]});
    const snapshot=await x.loadTradeAnalysisSnapshot('purchasing',filters);
    assert.deepEqual(calls.map(q=>q.name),['supplyOrders','orders','products']);
    assert.deepEqual(Array.from(calls[0].clauses,args=>Array.from(args)),[['orderDate','>=',filters.start],['orderDate','<=',filters.end]]);
    assert.deepEqual(Array.from(calls[1].ids),['O']);assert.equal(snapshot.supplies.length,1);assert.equal(snapshot.orders.length,0);
});
test('sales cohort reads delivered batch costs and only relevant direct shipment orders, including exhausted lots',async()=>{
    const orders=[{id:'O',productId:'P',deliveryRecords:[{qty:1,lotAllocations:[{lotId:'L',qty:1}]}]},
        {id:'D',deliveryRecords:[{qty:1}]}];
    const {x,calls}=snapshotFixture({orders,inventoryLotCosts:[{id:'L',unitCost:25}],supplyOrders:[{id:'S',orderId:'D',fulfillmentType:'DIRECT_SHIP',unitCost:12}]});
    const snapshot=await x.loadTradeAnalysisSnapshot('selling',filters);
    assert.equal(calls.filter(q=>q.name==='orders').length,1);
    assert.equal(calls.some(q=>['receipts','warehouseStocks','inventoryLots'].includes(q.name)),false);
    assert.deepEqual(Array.from(calls.find(q=>q.name==='inventoryLotCosts').ids),['L']);
    assert.deepEqual(Array.from(calls.find(q=>q.name==='supplyOrders').clauses[0][2]),['D']);
    assert.equal(snapshot.lotCosts[0].unitCost,25);
});
test('stock snapshot uses positive warehouse and lot balances and follows transferred cost roots without order scans',async()=>{
    const {x,calls}=snapshotFixture({warehouseStocks:[{id:'W',productId:'P',onHand:2}],
        inventoryLots:[{id:'T',productId:'P',remainingQty:2,costLotId:'ROOT'}],
        inventoryLotCosts:[{id:'ROOT',costSourceSupplyId:'S'}],supplyOrders:[{id:'S',unitCost:15}]});
    const snapshot=await x.loadTradeAnalysisSnapshot('inventory',filters);
    assert.equal(calls.some(q=>['orders','receipts'].includes(q.name)),false);
    assert.equal(calls.filter(q=>q.name==='supplyOrders').every(q=>q.ids),true);
    assert.deepEqual(Array.from(calls[0].clauses[0]),['onHand','>',0]);
    assert.deepEqual(Array.from(calls[1].clauses[0]),['remainingQty','>',0]);
    assert.equal(snapshot.lotCosts[0].id,'T');assert.equal(snapshot.lotCosts[0].unitCost,15);
});
test('missing costs remain unknown and zero cost remains valid through source resolution',async()=>{
    const {x}=snapshotFixture({inventoryLotCosts:[{id:'L',costSourceLotId:'ROOT'},{id:'ZERO',costSourceSupplyId:'S'},{id:'MISSING'}],
        supplyOrders:[{id:'S',unitCost:0}]});
    const costs=await x.readTradeAnalysisLotCosts(['L','ZERO','MISSING']);
    assert.equal(x.tradeAnalysisCost(costs[0].unitCost),null);
    assert.equal(x.tradeAnalysisCost(costs[1].unitCost),0);
    assert.equal(x.tradeAnalysisCost(costs[2].unitCost),null);
});
test('type and line filters consistently limit all three tab calculations, including empty results',()=>{
    for(const tab of ['purchasing','selling','inventory']){
        const x=simpleFixture(tab);
        x.inventoryAnalysisSupplyOrders.forEach(row=>row.orderDate='2026-10-01');
        x.salesStatisticsOrders.forEach(row=>row.orderDate='2026-10-01');
        const rows=x.buildSimpleTradeAnalysis({...filters,type:'試劑',line:'試劑線'});
        assert.ok(rows.length>0);assert.equal(rows.every(row=>row.type==='試劑'&&row.line==='試劑線'),true);
        assert.equal(x.buildSimpleTradeAnalysis({...filters,type:'不存在'}).length,0);
    }
});

function loaderFixture() {
    const x=fixture(),elements={},loads=[],applied=[];
    const element=id=>elements[id]||(elements[id]={value:'',textContent:'',innerHTML:'',hidden:false,setAttribute(){}});
    Object.assign(x,{currentUserRole:'admin',currentUser:{uid:'admin'},tradeAnalysisTab:'purchasing',
        tradeAnalysisAppliedFilters:{...filters},tradeAnalysisSnapshots:new Map(),tradeAnalysisRevision:0,
        tradeAnalysisLoadedKey:'',tradeAnalysisReady:false,tradeAnalysisFiltersPending:false,salesStatisticsLoadPromise:null,
        document:{getElementById:element,querySelectorAll:()=>[]},
        setTradeAnalysisLoading:()=>{},renderSalesStatistics:()=>{},resetSimpleTradeAnalysisDetail:()=>{},
        applyTradeAnalysisSnapshot:snapshot=>applied.push(snapshot),
        loadTradeAnalysisSnapshot:(tab,range)=>new Promise((resolve,reject)=>loads.push({tab,range,resolve,reject})),
        readTradeAnalysisFilters:()=>({...filters})});
    vm.runInContext('window=globalThis;'+fn('tradeAnalysisQueryKey'),x);
    const start=source.indexOf('window.loadSalesStatistics =');
    vm.runInContext(source.slice(start,source.indexOf('\n};',start)+3),x);
    return {x,loads,applied,elements};
}
const blankSnapshot=tab=>({tab,orders:[],supplies:[],lots:[],lotCosts:[],stocks:[],sourceOrders:[],products:[]});
test('duplicate queries share one request and same-period filters reuse the tab snapshot',async()=>{
    const {x,loads,applied}=loaderFixture();
    const first=x.loadSalesStatistics();assert.equal(first,x.loadSalesStatistics());assert.equal(loads.length,1);
    loads[0].resolve(blankSnapshot('purchasing'));await first;assert.equal(applied.length,1);
    x.tradeAnalysisAppliedFilters={...filters,type:'試劑'};await x.loadSalesStatistics();assert.equal(loads.length,1);
    const fresh=x.loadSalesStatistics(true);assert.equal(loads.length,2);
    loads[1].resolve(blankSnapshot('purchasing'));await fresh;
});
test('fast tab switching discards old visual results and starts the newest tab after the in-flight request',async()=>{
    const {x,loads,applied}=loaderFixture();const first=x.loadSalesStatistics();
    x.tradeAnalysisTab='selling';x.loadSalesStatistics();
    loads[0].resolve(blankSnapshot('purchasing'));await first;
    assert.equal(applied.length,0);assert.equal(loads.length,2);assert.equal(loads[1].tab,'selling');
    const second=x.salesStatisticsLoadPromise;loads[1].resolve(blankSnapshot('selling'));await second;
    assert.equal(applied.length,1);assert.equal(applied[0].tab,'selling');
});
test('failed or stale-role reads never publish partial snapshots and invalid dates do not query',async()=>{
    const {x,loads,applied,elements}=loaderFixture();let pending=x.loadSalesStatistics();
    loads[0].reject(Error('network'));await pending;
    assert.equal(applied.length,0);assert.equal(x.tradeAnalysisReady,false);assert.match(elements.tradeAnalysisStatus.textContent,/network/);
    pending=x.loadSalesStatistics();x.currentUserRole='sales';loads[1].resolve(blankSnapshot('purchasing'));await pending;
    assert.equal(applied.length,0);assert.equal(x.tradeAnalysisSnapshots.size,0);
    x.currentUserRole='admin';x.tradeAnalysisAppliedFilters={start:'2026-12-01',end:'2026-01-01'};
    await x.loadSalesStatistics();assert.equal(loads.length,2);assert.match(elements.tradeAnalysisStatus.textContent,/起日不可晚於迄日/);
});
test('business mutation invalidates an in-flight snapshot and forces a fresh read',async()=>{
    const {x,loads,applied}=loaderFixture();const first=x.loadSalesStatistics();x.tradeAnalysisRevision++;
    loads[0].resolve(blankSnapshot('purchasing'));await first;
    assert.equal(applied.length,0);assert.equal(loads.length,2);
    const second=x.salesStatisticsLoadPromise;loads[1].resolve(blankSnapshot('purchasing'));await second;assert.equal(applied.length,1);
});
test('cache is scoped to account, tab and dates; inventory ignores transaction dates',()=>{
    const {x}=loaderFixture();const a=x.tradeAnalysisQueryKey('selling',filters);
    assert.notEqual(a,x.tradeAnalysisQueryKey('selling',{...filters,end:'2026-11-01'}));
    assert.notEqual(a,x.tradeAnalysisQueryKey('purchasing',filters));
    assert.equal(x.tradeAnalysisQueryKey('inventory',filters),x.tradeAnalysisQueryKey('inventory',{start:'2000-01-01',end:'2000-01-02'}));
    x.currentUser.uid='other';assert.notEqual(a,x.tradeAnalysisQueryKey('selling',filters));
});
test('new details paginate fifty rows without querying or changing totals',()=>{
    const {x,loads,elements}=loaderFixture();
    Object.assign(x,{tradeAnalysisTab:'selling',tradeAnalysisReady:true,tradeAnalysisSimplePage:0,
        tradeAnalysisSimpleRows:Array.from({length:101},(_,i)=>({brand:'主要',code:String(i),name:'品名',values:[100,80,20,40]})),
        escapeHtml:String,formatStatsMoney:String});
    for(const name of ['simpleTradeAnalysisLabels','renderSimpleTradeAnalysisPage'])vm.runInContext(fn(name),x);
    for(const name of ['toggleSimpleTradeAnalysisDetail','changeSimpleTradeAnalysisPage']){
        const start=source.indexOf('window.'+name+' = function');vm.runInContext(source.slice(start,source.indexOf('\n};',start)+3),x);
    }
    elements.tradeAnalysisSimpleDetail={hidden:true};x.toggleSimpleTradeAnalysisDetail();
    assert.equal((elements.unifiedBrandAnalyticsBody.innerHTML.match(/<tr>/g)||[]).length,50);
    x.changeSimpleTradeAnalysisPage(1);assert.equal((elements.unifiedBrandAnalyticsBody.innerHTML.match(/<tr>/g)||[]).length,50);
    x.changeSimpleTradeAnalysisPage(1);assert.equal((elements.unifiedBrandAnalyticsBody.innerHTML.match(/<tr>/g)||[]).length,1);
    assert.equal(elements.tradeAnalysisNextBtn.disabled,true);assert.equal(loads.length,0);
});
test('current-tab Excel includes all filtered rows and applied product type, independent of draft inputs',async()=>{
    const x=simpleFixture('selling'),sheets=[],elements={};
    x.salesStatisticsOrders[0].orderDate='2026-10-01';
    x.salesStatisticsOrders=Array.from({length:101},(_,i)=>({...x.salesStatisticsOrders[0],id:'O'+i}));
    const applied={...filters,type:'試劑',line:'試劑線'};
    Object.assign(x,{currentUserRole:'admin',tradeAnalysisReady:true,salesStatisticsLoadPromise:null,tradeAnalysisFiltersPending:false,
        tradeAnalysisAppliedFilters:applied,beginActionButton:()=>({}),endActionButton:()=>{},ensureXlsxLoaded:async()=>{},
        document:{getElementById:id=>elements[id]||(elements[id]={value:'未套用的條件',textContent:'計算方式'})},
        alert:message=>{throw Error(message);},XLSX:{utils:{book_new:()=>({}),json_to_sheet:rows=>rows,book_append_sheet:(_wb,rows,name)=>sheets.push({rows,name})},writeFile(){}}});
    vm.runInContext('window=globalThis',x);
    const start=source.indexOf('window.exportTradeAnalysis = async function');vm.runInContext(source.slice(start,source.indexOf('\n};',start)+3),x);
    const rows=x.buildSimpleTradeAnalysis(applied);await x.exportTradeAnalysis();
    const detail=sheets.find(sheet=>sheet.name==='品項明細').rows;
    assert.equal(detail.length,102);assert.equal(detail[0]['產品類型'],'試劑');
    assert.equal(detail.at(-1)['銷售金額'],rows.reduce((n,row)=>n+row.values[0],0));
    assert.equal(sheets[0].rows.find(row=>row['項目']==='產品類型')['內容'],'試劑');
});
