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

test('cancelled unreceived remainder is excluded from effective purchasing',()=>{
  const x=analytics.projectSupply({
    id:'S1',method:'PURCHASING_PO',sourceType:'SALES_ORDER',
    sourceId:'O1',sourceItemId:'I1',qty:10,receivedQty:4,
    status:'CANCELLED',unitCost:100,supplier:'Supplier A',internalNo:'PO1'
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
    {id:'S1',supplier:'A',brand:'Thermo',method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1',sourceItemId:'I1',qty:2,status:'ORDERED',unitCost:0,purchaseDocumentId:'P1',orderDate:'2026-10-01'}
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

test('supplier lead time is derived from immutable receipt events',()=>{
  const records=[
    {
      id:'S1',supplierId:'SUP1',supplier:'A',
      method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1',sourceItemId:'I1',
      qty:10,receivedQty:10,status:'RECEIVED',unitCost:100,orderDate:'2026-10-01'
    },
    {
      id:'S2',supplierId:'SUP1',supplier:'A',
      method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',
      qty:5,receivedQty:5,status:'RECEIVED',unitCost:100,orderDate:'2026-10-01'
    }
  ];
  const receipts=[
    {supplyOrderId:'S1',qty:4,createdAt:'2026-10-03T10:00:00Z'},
    {supplyOrderId:'S1',qty:6,createdAt:'2026-10-05T10:00:00Z'},
    {supplyOrderId:'S2',qty:5,createdAt:'2026-10-03T00:00:00Z'}
  ];
  const result=analytics.summarize(records,receipts);
  const supplier=result.bySupplier[0];
  assert.equal(supplier.leadTimeCount,2);
  assert.equal(Number(supplier.avgLeadTimeDays.toFixed(1)),3.2);
  assert.equal(result.totals.leadTimeCount,2);
});

test('partial receipts do not count as complete lead time until target quantity is reached',()=>{
  const result=analytics.summarize([
    {id:'S1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:10,receivedQty:4,status:'PARTIAL_RECEIPT',orderDate:'2026-10-01'}
  ],[
    {supplyOrderId:'S1',qty:4,createdAt:'2026-10-02T00:00:00Z'}
  ]);
  assert.equal(result.totals.leadTimeCount,0);
  assert.equal(result.totals.avgLeadTimeDays,null);
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

test('on-time delivery counts only completed supplies with an expected date',()=>{
  const result=analytics.summarize([
    {id:'S1',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:5,receivedQty:5,status:'RECEIVED',orderDate:'2026-10-01',expectedDate:'2026-10-05'},
    {id:'S2',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:5,receivedQty:5,status:'RECEIVED',orderDate:'2026-10-01',expectedDate:'2026-10-03'},
    {id:'S3',supplierId:'SUP1',supplier:'A',method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT',qty:5,receivedQty:2,status:'PARTIAL_RECEIPT',orderDate:'2026-10-01',expectedDate:'2026-10-02'}
  ],[
    {supplyOrderId:'S1',qty:5,createdAt:'2026-10-04T12:00:00Z'},
    {supplyOrderId:'S2',qty:5,createdAt:'2026-10-04T12:00:00Z'},
    {supplyOrderId:'S3',qty:2,createdAt:'2026-10-02T12:00:00Z'}
  ]);
  assert.equal(result.totals.onTimeEligibleCount,2);
  assert.equal(result.totals.onTimeCount,1);
  assert.equal(result.totals.onTimeRate,50);
  assert.equal(result.bySupplier[0].onTimeRate,50);
});
