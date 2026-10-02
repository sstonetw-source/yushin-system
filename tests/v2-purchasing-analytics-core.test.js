const test=require('node:test');
const assert=require('node:assert/strict');
const analytics=require('../modules/purchasing-analytics-core.js');

test('ordered supply separates received and incoming amounts',()=>{
  const x=analytics.projectSupply({
    id:'S1',type:'PURCHASING_PO',orderId:'O1',qty:10,receivedQty:4,
    status:'PARTIAL_RECEIPT',unitCost:100,supplier:'Supplier A',internalNo:'PO1'
  });
  assert.equal(x.effectiveOrderedQty,10);
  assert.equal(x.orderedAmount,1000);
  assert.equal(x.receivedAmount,400);
  assert.equal(x.incomingAmount,600);
  assert.equal(x.isStockReplenishment,false);
});

test('cancelled unreceived remainder is excluded from effective purchasing',()=>{
  const x=analytics.projectSupply({
    id:'S1',type:'PURCHASING_PO',orderId:'O1',qty:10,receivedQty:4,
    status:'CANCELLED',unitCost:100,supplier:'Supplier A',internalNo:'PO1'
  });
  assert.equal(x.effectiveOrderedQty,4);
  assert.equal(x.orderedAmount,400);
  assert.equal(x.receivedAmount,400);
  assert.equal(x.incomingAmount,0);
});

test('stock replenishment is separated from customer-order purchasing',()=>{
  const result=analytics.summarize([
    {id:'S1',type:'STOCK_REPLENISHMENT',qty:5,receivedQty:0,status:'ORDERED',unitCost:100,supplier:'A',internalNo:'PO1'},
    {id:'S2',type:'PURCHASING_PO',orderId:'O1',qty:3,receivedQty:3,status:'RECEIVED',unitCost:200,supplier:'A',internalNo:'PO2'}
  ]);
  assert.equal(result.totals.orderedAmount,1100);
  assert.equal(result.totals.stockAmount,500);
  assert.equal(result.totals.customerOrderAmount,600);
  assert.equal(result.totals.receivedAmount,600);
  assert.equal(result.totals.incomingAmount,500);
  assert.equal(result.totals.documentCount,2);
  assert.equal(result.totals.lineCount,2);
});

test('supplier summary counts unique purchase documents and sorts by spend',()=>{
  const result=analytics.summarize([
    {id:'S1',type:'PURCHASING_PO',orderId:'O1',qty:2,receivedQty:0,status:'ORDERED',unitCost:100,supplier:'A',purchaseDocumentId:'P1'},
    {id:'S2',type:'PURCHASING_PO',orderId:'O2',qty:3,receivedQty:0,status:'ORDERED',unitCost:100,supplier:'A',purchaseDocumentId:'P1'},
    {id:'S3',type:'STOCK_REPLENISHMENT',qty:10,receivedQty:10,status:'RECEIVED',unitCost:100,supplier:'B',purchaseDocumentId:'P2'}
  ]);
  assert.equal(result.bySupplier[0].supplier,'B');
  assert.equal(result.bySupplier[0].orderedAmount,1000);
  const a=result.bySupplier.find(row=>row.supplier==='A');
  assert.equal(a.documentCount,1);
  assert.equal(a.lineCount,2);
  assert.equal(a.orderedAmount,500);
});
