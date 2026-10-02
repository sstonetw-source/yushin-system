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
