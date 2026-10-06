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
test('receiving support reads actual receipts by date, all open supplies and only active lots',async()=>{
    const calls=[];
    const db={collection:name=>{const query={name,clauses:[],where(...args){this.clauses.push(args);return this;},orderBy(){return this;}};return query;}};
    const x=vm.createContext({db,salesStatisticsOrders:[],salesStatisticOrderLines:o=>[o],
        readQueryInBatches:async q=>{calls.push(q);return q.name==='receipts'?[{id:'R',supplyOrderId:'S',lotId:'L',productId:'P'}]:q.name==='inventoryLots'?[{id:'L',remainingQty:2,productId:'P'}]:[];},
        readDocumentsByIds:async(name,ids)=>{calls.push({name,ids});return name==='supplyOrders'?[{id:'S',unitCost:25}]:[];},
        cacheProductLookupItem:()=>{},productMasterDocToPriceItem:x=>x,rebuildPriceItemLookup:()=>{}});
    x.supplyOrdersCollection=()=>x.db.collection('supplyOrders');
    vm.runInContext('let inventoryAnalysisReceipts,inventoryAnalysisLots,inventoryAnalysisLotCosts,inventoryAnalysisSupplyOrders,inventoryAnalysisDirectShipSupplyOrders,tradeAnalysisSourceOrders;async '+fn('loadInventoryAnalysisSupport'),x);
    await x.loadInventoryAnalysisSupport(filters.start,filters.end);
    assert.deepEqual(calls.find(q=>q.name==='receipts').clauses,[['receiptDate','>=',filters.start],['receiptDate','<=',filters.end]]);
    assert.deepEqual(calls.find(q=>q.name==='inventoryLots').clauses,[['remainingQty','>',0]]);
    assert.equal(calls.find(q=>q.name==='supplyOrders'&&q.clauses).clauses[0][0],'status');
    assert.deepEqual(Array.from(calls.find(q=>q.name==='inventoryLotCosts').ids),['L']);
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
