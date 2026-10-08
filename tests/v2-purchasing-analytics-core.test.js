const test=require('node:test');
const assert=require('node:assert/strict');
const analytics=require('../modules/purchasing-analytics-core.js');
const supply=require('../modules/supply-core.js');

test('ordered supply separates received and incoming amounts',()=>{
  const x=analytics.projectSupply({
    id:'S1',method:'PURCHASING_PO',sourceType:'SALES_ORDER',
    sourceId:'O1',sourceItemId:'I1',qty:10,receivedQty:4,
    status:'PARTIAL_RECEIPT',unitCost:100,supplier:'Supplier A',internalNo:'PO1'
  });
  assert.equal(x.effectiveOrderedQty,10);
  assert.equal(x.orderedAmount,1000);
  assert.equal(x.receivedAmount,400);
  assert.equal(x.incomingAmount,600);
  assert.equal(x.sourceType,supply.SOURCES.SALES_ORDER);
  assert.equal(x.isStockReplenishment,false);
});

test('closed unreceived remainder is excluded from effective purchasing',()=>{
  const x=analytics.projectSupply({
    id:'S1',method:'PURCHASING_PO',sourceType:'SALES_ORDER',
    sourceId:'O1',sourceItemId:'I1',qty:10,receivedQty:4,
    status:'CLOSED',unitCost:100,supplier:'Supplier A',internalNo:'PO1'
  });
  assert.equal(x.effectiveOrderedQty,4);
  assert.equal(x.orderedAmount,400);
  assert.equal(x.receivedAmount,400);
  assert.equal(x.incomingAmount,0);
});

test('stock replenishment is separated from customer-order purchasing by sourceType',()=>{
  const result=analytics.summarize([
    {id:'S1',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:5,receivedQty:0,status:'ORDERED',unitCost:100,supplier:'A',internalNo:'PO1'},
    {id:'S2',method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1',sourceItemId:'I1',qty:3,receivedQty:3,status:'RECEIVED',unitCost:200,supplier:'A',internalNo:'PO2'}
  ]);
  assert.equal(result.totals.orderedAmount,1100);
  assert.equal(result.totals.stockAmount,500);
  assert.equal(result.totals.customerOrderAmount,600);
  assert.equal(result.totals.receivedAmount,600);
  assert.equal(result.totals.incomingAmount,500);
  assert.equal(result.totals.documentCount,2);
  assert.equal(result.totals.lineCount,2);
  assert.deepEqual(result.bySource.map(row=>[row.source,row.orderedAmount]),[
    ['客戶訂單採購',600],
    ['備庫採購',500]
  ]);
});

test('supplier summary groups by supplier id and sorts by spend',()=>{
  const result=analytics.summarize([
    {id:'S1',supplierId:'SUP1',supplier:'A Co.',method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1',sourceItemId:'I1',qty:2,status:'ORDERED',unitCost:100,purchaseDocumentId:'P1'},
    {id:'S2',supplierId:'SUP1',supplier:'A COMPANY',method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O2',sourceItemId:'I2',qty:3,status:'ORDERED',unitCost:100,purchaseDocumentId:'P1'},
    {id:'S3',supplierId:'SUP2',supplier:'B',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:10,receivedQty:10,status:'RECEIVED',unitCost:100,purchaseDocumentId:'P2'}
  ]);
  assert.equal(result.bySupplier[0].supplier,'B');
  assert.equal(result.bySupplier[0].orderedAmount,1000);
  const a=result.bySupplier.find(row=>row.documentCount===1&&row.lineCount===2);
  assert.ok(a);
  assert.equal(a.orderedAmount,500);
});

test('brand and month summaries reuse the same procurement projection',()=>{
  const result=analytics.summarize([
    {id:'S1',supplier:'A',brand:'Thermo',method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1',sourceItemId:'I1',qty:2,receivedQty:2,status:'RECEIVED',unitCost:100,purchaseDocumentId:'P1',orderDate:'2026-09-30'},
    {id:'S2',supplier:'B',brand:'Thermo',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:4,receivedQty:1,status:'PARTIAL_RECEIPT',unitCost:50,purchaseDocumentId:'P2',orderDate:'2026-10-01'}
  ]);
  const thermo=result.byBrand.find(row=>row.brand==='Thermo');
  assert.equal(thermo.documentCount,2);
  assert.equal(thermo.orderedAmount,400);
  assert.equal(thermo.receivedAmount,250);
  assert.deepEqual(result.byMonth.map(row=>row.month),['2026-10','2026-09']);
});

test('missing purchase unit cost is surfaced as a data-quality count',()=>{
  const result=analytics.summarize([
    {id:'S1',supplier:'A',brand:'Thermo',method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1',sourceItemId:'I1',qty:2,status:'ORDERED',unitCost:null,purchaseDocumentId:'P1',orderDate:'2026-10-01'}
  ]);
  assert.equal(result.totals.missingUnitCostCount,1);
  assert.equal(result.byBrand[0].missingUnitCostCount,1);
});

test('ERP supply sourceType is authoritative for stock versus customer demand',()=>{
  const stock=analytics.projectSupply({
    method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',
    qty:2,receivedQty:0,status:'ORDERED',unitCost:50,supplier:'A'
  });
  const customer=analytics.projectSupply({
    method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1',sourceItemId:'I1',
    qty:2,receivedQty:0,status:'ORDERED',unitCost:50,supplier:'A'
  });
  assert.equal(stock.isStockReplenishment,true);
  assert.equal(customer.isStockReplenishment,false);
  assert.equal(stock.stockAmount,100);
  assert.equal(customer.customerOrderAmount,100);
});

test('supplier id groups name variations into one supplier',()=>{
  const result=analytics.summarize([
    {id:'S1',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',supplierId:'SUP1',supplier:'ABC Co.',qty:1,status:'ORDERED',unitCost:100,purchaseDocumentId:'P1'},
    {id:'S2',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',supplierId:'SUP1',supplier:'ABC COMPANY',qty:2,status:'ORDERED',unitCost:100,purchaseDocumentId:'P1'}
  ]);
  assert.equal(result.bySupplier.length,1);
  assert.equal(result.bySupplier[0].documentCount,1);
  assert.equal(result.bySupplier[0].lineCount,2);
  assert.equal(result.bySupplier[0].orderedAmount,300);
});

test('open purchasing aging buckets expose stuck quantity and amount',()=>{
  const result=analytics.summarize([
    {id:'S1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:2,receivedQty:0,status:'ORDERED',unitCost:100,orderDate:'2026-10-08',purchaseDocumentId:'PO1'},
    {id:'S2',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:3,receivedQty:1,status:'PARTIAL_RECEIPT',unitCost:200,orderDate:'2026-09-25',expectedDate:'2026-10-05',purchaseDocumentId:'PO2'},
    {id:'S3',supplier:'B',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:4,receivedQty:0,status:'ORDERED',unitCost:50,orderDate:'2026-09-01',expectedDate:'2026-09-20',purchaseDocumentId:'PO3'},
    {id:'S4',supplier:'B',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:5,receivedQty:5,status:'RECEIVED',unitCost:50,orderDate:'2026-08-01',purchaseDocumentId:'PO4'}
  ],[],{now:'2026-10-10T12:00:00Z'});

  assert.deepEqual(result.agingBuckets.map(row=>row.label),['0–7 天','8–14 天','15–30 天','31+ 天']);
  const first=result.agingBuckets[0];
  assert.equal(first.lineCount,1);
  assert.equal(first.documentCount,1);
  assert.equal(first.incomingQty,2);
  assert.equal(first.incomingAmount,200);

  const mid=result.agingBuckets[2];
  assert.equal(mid.lineCount,1);
  assert.equal(mid.incomingQty,2);
  assert.equal(mid.incomingAmount,400);
  assert.equal(mid.lateLineCount,1);
  assert.equal(mid.lateAmount,400);

  const oldest=result.agingBuckets[3];
  assert.equal(oldest.lineCount,1);
  assert.equal(oldest.incomingQty,4);
  assert.equal(oldest.incomingAmount,200);
  assert.equal(oldest.lateLineCount,1);
  assert.ok(oldest.maxOpenAgeDays>=39);
});

test('open purchasing aging counts only still-incoming supply',()=>{
  const result=analytics.summarize([
    {id:'S1',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:10,receivedQty:4,status:'PARTIAL_RECEIPT',unitCost:100,orderDate:'2026-10-01'},
    {id:'S2',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:5,receivedQty:5,status:'RECEIVED',unitCost:100,orderDate:'2026-09-20'},
    {id:'S3',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:8,receivedQty:0,status:'CANCELLED',unitCost:100,orderDate:'2026-09-01'}
  ],[],{now:'2026-10-10T00:00:00Z'});
  assert.equal(result.totals.openAgeCount,1);
  assert.equal(result.totals.avgOpenAgeDays,9);
  assert.equal(result.totals.maxOpenAgeDays,9);
  assert.equal(result.bySupplier[0].openAgeCount,1);
});

test('late incoming purchase is surfaced by count amount and days overdue',()=>{
  const result=analytics.summarize([
    {id:'S1',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:10,receivedQty:4,status:'PARTIAL_RECEIPT',unitCost:100,orderDate:'2026-10-01',expectedDate:'2026-10-05',purchaseDocumentId:'PO1'},
    {id:'S2',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:5,receivedQty:0,status:'ORDERED',unitCost:100,orderDate:'2026-10-01',expectedDate:'2026-10-12',purchaseDocumentId:'PO2'}
  ],[],{now:'2026-10-10T15:00:00Z'});
  assert.equal(result.totals.lateDocumentCount,1);
  assert.equal(result.totals.lateLineCount,1);
  assert.equal(result.totals.lateAmount,600);
  assert.equal(result.totals.maxLateDays,5);
  assert.equal(result.bySupplier[0].lateLineCount,1);
});



test('complimentary zero-cost supply is complete and totals zero',()=>{const row=analytics.projectSupply({method:'PURCHASING_PO',qty:2,unitCost:0});assert.equal(row.missingUnitCost,false);assert.equal(row.orderedAmount,0);});
