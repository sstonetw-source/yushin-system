const test=require('node:test');
const assert=require('node:assert/strict');
const analytics=require('../modules/purchase-analytics-core.js');

test('normal supply keeps ordered received and incoming quantities aligned',()=>{
  const line=analytics.normalizeLine({
    id:'S1',qty:10,receivedQty:4,unitCost:100,status:'PARTIAL_RECEIPT',
    supplierId:'SUP1',supplier:'供應商 A',orderId:'O1',purchaseDocumentId:'PO1'
  });
  assert.equal(line.effectiveOrderedQty,10);
  assert.equal(line.receivedQty,4);
  assert.equal(line.incomingQty,6);
  assert.equal(line.orderedAmount,1000);
  assert.equal(line.receivedAmount,400);
  assert.equal(line.incomingAmount,600);
  assert.equal(line.customerOrderPurchase,true);
});

test('cancelled unreceived remainder is removed from effective purchasing',()=>{
  const line=analytics.normalizeLine({
    qty:10,receivedQty:4,unitCost:100,status:'CANCELLED',orderId:'O1'
  });
  assert.equal(line.effectiveOrderedQty,4);
  assert.equal(line.receivedQty,4);
  assert.equal(line.incomingQty,0);
  assert.equal(line.orderedAmount,400);
});

test('fully cancelled never received supply is excluded from aggregate',()=>{
  const result=analytics.aggregate([
    {id:'S1',qty:5,receivedQty:0,unitCost:100,status:'CANCELLED',supplier:'A'}
  ]);
  assert.equal(result.total.lineCount,0);
  assert.equal(result.total.orderedAmount,0);
  assert.equal(result.suppliers.length,0);
});

test('stock replenishment and customer order purchasing are separated',()=>{
  const result=analytics.aggregate([
    {id:'S1',type:'STOCK_REPLENISHMENT',qty:5,unitCost:100,status:'ORDERED',supplier:'A',purchaseDocumentId:'PO1'},
    {id:'S2',type:'PURCHASING_PO',orderId:'O1',qty:3,unitCost:200,status:'ORDERED',supplier:'A',purchaseDocumentId:'PO2'}
  ]);
  assert.equal(result.total.stockAmount,500);
  assert.equal(result.total.customerOrderAmount,600);
  assert.equal(result.total.orderedAmount,1100);
});

test('supplier grouping uses supplier id instead of display-name variations',()=>{
  const result=analytics.aggregate([
    {id:'S1',supplierId:'SUP1',supplier:'ABC Co.',qty:1,unitCost:100,status:'ORDERED',purchaseDocumentId:'PO1'},
    {id:'S2',supplierId:'SUP1',supplier:'ABC COMPANY',qty:2,unitCost:100,status:'ORDERED',purchaseDocumentId:'PO1'}
  ]);
  assert.equal(result.suppliers.length,1);
  assert.equal(result.suppliers[0].documentCount,1);
  assert.equal(result.suppliers[0].lineCount,2);
  assert.equal(result.suppliers[0].orderedAmount,300);
});

test('aggregate include callback supports page filters without changing accounting rules',()=>{
  const result=analytics.aggregate([
    {id:'S1',brand:'A',qty:2,unitCost:100,status:'ORDERED',supplier:'One'},
    {id:'S2',brand:'B',qty:3,unitCost:100,status:'ORDERED',supplier:'Two'}
  ],line=>line.brand==='B');
  assert.equal(result.total.lineCount,1);
  assert.equal(result.total.orderedAmount,300);
  assert.equal(result.suppliers[0].supplierName,'Two');
});
