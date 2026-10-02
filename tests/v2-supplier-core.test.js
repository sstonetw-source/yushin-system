const test=require('node:test');
const assert=require('node:assert/strict');
const supplier=require('../modules/supplier-core.js');

test('supplier master normalizes contact and default lead time',()=>{
  const x=supplier.normalizeSupplier({
    id:'sup-1',
    supplierName:'  ACME   Bio  ',
    purchaseHeaderName:'',
    email:' Orders@Example.COM ',
    leadTimeDays:14
  });
  assert.equal(x.supplierId,'sup-1');
  assert.equal(x.supplierName,'ACME Bio');
  assert.equal(x.purchaseHeaderName,'ACME Bio');
  assert.equal(x.email,'orders@example.com');
  assert.equal(x.leadTimeDays,14);
});

test('purchase order keeps an immutable supplier snapshot',()=>{
  const snapshot=supplier.snapshotForPurchaseOrder({
    id:'sup-1',
    supplierName:'ACME Bio',
    purchaseHeaderName:'ACME Taiwan',
    email:'old@example.com',
    leadTimeDays:10
  });
  assert.deepEqual(snapshot,{
    supplierId:'sup-1',
    supplierName:'ACME Bio',
    purchaseHeaderName:'ACME Taiwan',
    email:'old@example.com',
    leadTimeDays:10
  });
});

test('delivery contact keeps document names but prefers current supplier email',()=>{
  const po={
    supplierSnapshot:{
      supplierId:'sup-1',
      supplierName:'ACME Bio',
      purchaseHeaderName:'ACME Taiwan',
      email:'old@example.com'
    }
  };
  const contact=supplier.purchaseOrderContact(po,[{
    id:'sup-1',
    supplierName:'ACME Biotech New Name',
    purchaseHeaderName:'ACME New',
    email:'new@example.com',
    active:true
  }]);
  assert.equal(contact.supplierName,'ACME Bio');
  assert.equal(contact.purchaseHeaderName,'ACME Taiwan');
  assert.equal(contact.email,'new@example.com');
  assert.equal(contact.emailSource,'SUPPLIER_MASTER');
});

test('communication event records preparation, not verified sending',()=>{
  const event=supplier.communicationEvent(
    {id:'PO-1',poNo:'PO-1'},
    {supplierId:'sup-1',supplierName:'ACME Bio',email:'orders@example.com'},
    {channel:'WEB_SHARE',preparedAt:'2026-10-02T10:00:00.000Z',createdByUid:'u1',createdBy:'Buyer'}
  );
  assert.equal(event.state,'PREPARED');
  assert.equal(event.verifiedSent,false);
  assert.equal(event.channel,'WEB_SHARE');
  assert.equal(event.recipientEmail,'orders@example.com');
});

test('vendor lead time suggests an expected arrival date without timezone drift',()=>{
  assert.equal(supplier.expectedArrivalDate('2026-10-02',{leadTimeDays:10}),'2026-10-12');
  assert.equal(supplier.expectedArrivalDate('2026-10-30',3),'2026-11-02');
  assert.equal(supplier.expectedArrivalDate('',3),'');
});

test('purchase expected date uses the supplier default lead time',()=>{
  const expected=supplier.purchaseExpectedDate(
    [{itemCode:'A-1'},{itemCode:'A-2'}],
    {supplierId:'S1',leadTimeDays:7},
    '2026-10-02'
  );
  assert.equal(expected,'2026-10-09');
});

test('purchase expected date stays blank when supplier has no default lead time',()=>{
  assert.equal(
    supplier.purchaseExpectedDate([{itemCode:'A-1'}],{supplierId:'S1',leadTimeDays:0},'2026-10-02'),
    ''
  );
});

test('purchase expected date handles month rollover with calendar days',()=>{
  assert.equal(supplier.addCalendarDays('2026-10-30',5),'2026-11-04');
  assert.equal(supplier.addCalendarDays('not-a-date',5),'');
});

test('item expected arrival uses the same supplier default for every item',()=>{
  const supplierMaster={supplierId:'S1',leadTimeDays:3};
  assert.equal(supplier.itemExpectedArrivalDate({itemCode:'A'},supplierMaster,'2026-10-02'),'2026-10-05');
  assert.equal(supplier.itemExpectedArrivalDate({itemCode:'B'},supplierMaster,'2026-10-02'),'2026-10-05');
});
