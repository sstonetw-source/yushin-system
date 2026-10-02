const test=require('node:test');
const assert=require('node:assert/strict');
const analytics=require('../modules/purchasing-analytics-core.js');

test('cancelled unreceived quantity is excluded from effective purchasing',()=>{
  const result=analytics.summarize([
    {id:'a',qty:10,receivedQty:4,status:'CANCELLED',unitCost:100,supplier:'Vendor',orderId:'O1',purchaseDocumentId:'PO1'}
  ]);
  assert.equal(result.totals.orderedAmount,400);
  assert.equal(result.totals.receivedAmount,400);
  assert.equal(result.totals.incomingAmount,0);
});

test('open supply separates received and incoming amounts',()=>{
  const row=analytics.projectSupply({qty:10,receivedQty:4,status:'PARTIAL_RECEIPT',unitCost:50,supplier:'Vendor',orderId:'O1'});
  assert.deepEqual(
    {ordered:row.orderedAmount,received:row.receivedAmount,incoming:row.incomingAmount},
    {ordered:500,received:200,incoming:300}
  );
});

test('stock replenishment and customer order purchasing are reported separately',()=>{
  const result=analytics.summarize([
    {id:'stock',qty:3,receivedQty:0,status:'ORDERED',unitCost:100,supplier:'A',orderId:'',internalNo:'S1'},
    {id:'customer',qty:2,receivedQty:2,status:'RECEIVED',unitCost:200,supplier:'A',orderId:'O1',internalNo:'S2'}
  ]);
  assert.equal(result.totals.stockAmount,300);
  assert.equal(result.totals.customerAmount,400);
  assert.equal(result.totals.orderedAmount,700);
  assert.equal(result.totals.purchaseOrderCount,2);
});

test('supplier analysis counts distinct purchase documents instead of supply lines',()=>{
  const result=analytics.summarize([
    {id:'1',qty:1,status:'ORDERED',unitCost:100,supplier:'A',purchaseDocumentId:'PO1'},
    {id:'2',qty:2,status:'ORDERED',unitCost:100,supplier:'A',purchaseDocumentId:'PO1'},
    {id:'3',qty:1,status:'ORDERED',unitCost:300,supplier:'B',purchaseDocumentId:'PO2'}
  ]);
  assert.equal(result.totals.purchaseOrderCount,2);
  const a=result.suppliers.find(row=>row.supplier==='A');
  assert.equal(a.purchaseOrderCount,1);
  assert.equal(a.itemCount,2);
  assert.equal(a.orderedAmount,300);
});
