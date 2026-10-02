const test=require('node:test');
const assert=require('node:assert/strict');
const supplier=require('../modules/supplier-core.js');

test('supplier master normalizes name header and email',()=>{
  const x=supplier.normalizeSupplier({
    id:'sup-1',
    supplierName:'  ACME   Bio  ',
    purchaseHeaderName:'',
    email:' Orders@Example.COM '
  });
  assert.equal(x.supplierId,'sup-1');
  assert.equal(x.supplierName,'ACME Bio');
  assert.equal(x.purchaseHeaderName,'ACME Bio');
  assert.equal(x.email,'orders@example.com');
});

test('purchase order keeps an immutable supplier snapshot',()=>{
  const snapshot=supplier.snapshotForPurchaseOrder({
    id:'sup-1',
    supplierName:'ACME Bio',
    purchaseHeaderName:'ACME Taiwan',
    email:'old@example.com'
  });
  assert.deepEqual(snapshot,{
    supplierId:'sup-1',
    supplierName:'ACME Bio',
    purchaseHeaderName:'ACME Taiwan',
    email:'old@example.com'
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

test('product-specific supplier mapping outranks by priority',()=>{
  const selected=supplier.selectProductSupplierMapping([
    {productId:'P1',supplierId:'S2',priority:2,leadTimeDays:7},
    {productId:'P1',supplierId:'S1',priority:1,supplierPartNo:'V-100',leadTimeDays:3},
    {productId:'P2',supplierId:'S3',priority:1}
  ],{productId:'P1',itemCode:'A-100'});
  assert.equal(selected.supplierId,'S1');
  assert.equal(selected.supplierPartNo,'V-100');
  assert.equal(selected.leadTimeDays,3);
});

test('product supplier relation can match by item code when product id is unavailable',()=>{
  const selected=supplier.selectProductSupplierMapping([
    {itemCode:'ABC-1',supplierId:'S1',priority:1}
  ],{itemCode:'abc-1'});
  assert.equal(selected.supplierId,'S1');
});

test('product supplier relation requires product identity and supplier',()=>{
  assert.equal(supplier.validateProductSupplierMapping({productId:'P1',supplierId:'S1'}).valid,true);
  assert.deepEqual(supplier.validateProductSupplierMapping({supplierId:'S1'}).errors,['product']);
  assert.deepEqual(supplier.validateProductSupplierMapping({productId:'P1'}).errors,['supplierId']);
});


test('vendor lead time suggests an expected arrival date without timezone drift',()=>{
  assert.equal(supplier.expectedArrivalDate('2026-10-02',{leadTimeDays:10}),'2026-10-12');
  assert.equal(supplier.expectedArrivalDate('2026-10-30',3),'2026-11-02');
  assert.equal(supplier.expectedArrivalDate('',3),'');
});


test('purchase expected date uses the longest explicit lead time for the selected supplier',()=>{
  const expected=supplier.purchaseExpectedDate([
    {productId:'P1',itemCode:'A-1'},
    {productId:'P2',itemCode:'A-2'}
  ],[
    {productId:'P1',supplierId:'S1',priority:1,leadTimeDays:3},
    {productId:'P2',supplierId:'S1',priority:1,leadTimeDays:7}
  ],'2026-10-02','S1');
  assert.equal(expected,'2026-10-09');
});

test('purchase expected date stays blank when any item lacks selected supplier lead time',()=>{
  const expected=supplier.purchaseExpectedDate([
    {productId:'P1'},
    {productId:'P2'}
  ],[
    {productId:'P1',supplierId:'S1',priority:1,leadTimeDays:3},
    {productId:'P2',supplierId:'S2',priority:1,leadTimeDays:5}
  ],'2026-10-02','S1');
  assert.equal(expected,'');
});

test('purchase expected date handles month rollover with calendar days',()=>{
  assert.equal(supplier.addCalendarDays('2026-10-30',5),'2026-11-04');
  assert.equal(supplier.addCalendarDays('not-a-date',5),'');
});


test('item expected arrival date follows the selected supplier mapping',()=>{
  const mappings=[
    {productId:'P1',supplierId:'S1',priority:1,leadTimeDays:3},
    {productId:'P1',supplierId:'S2',priority:1,leadTimeDays:9}
  ];
  assert.equal(supplier.itemExpectedArrivalDate({productId:'P1'},mappings,'2026-10-02','S1'),'2026-10-05');
  assert.equal(supplier.itemExpectedArrivalDate({productId:'P1'},mappings,'2026-10-02','S2'),'2026-10-11');
  assert.equal(supplier.itemExpectedArrivalDate({productId:'P2'},mappings,'2026-10-02','S1'),'');
});


test('supplier minimum order quantity validates purchase quantities',()=>{
  const mappings=[
    {productId:'P1',supplierId:'S1',priority:1,minimumOrderQty:5},
    {productId:'P1',supplierId:'S2',priority:1,minimumOrderQty:2}
  ];
  const tooSmall=supplier.validatePurchaseQuantity({productId:'P1'},3,mappings,'S1');
  assert.equal(tooSmall.valid,false);
  assert.equal(tooSmall.minimumOrderQty,5);
  assert.equal(tooSmall.shortage,2);

  const enough=supplier.validatePurchaseQuantity({productId:'P1'},5,mappings,'S1');
  assert.equal(enough.valid,true);
  assert.equal(enough.shortage,0);

  const otherSupplier=supplier.validatePurchaseQuantity({productId:'P1'},2,mappings,'S2');
  assert.equal(otherSupplier.valid,true);
  assert.equal(otherSupplier.minimumOrderQty,2);
});

test('missing supplier MOQ leaves existing purchase quantities unrestricted',()=>{
  const result=supplier.validatePurchaseQuantity(
    {productId:'P2'},1,
    [{productId:'P1',supplierId:'S1',minimumOrderQty:10}],
    'S1'
  );
  assert.equal(result.valid,true);
  assert.equal(result.minimumOrderQty,0);
});

test('product supplier mapping normalizes common MOQ field names',()=>{
  assert.equal(supplier.normalizeProductSupplierMapping({minQty:'3'}).minimumOrderQty,3);
  assert.equal(supplier.normalizeProductSupplierMapping({minOrderQty:4}).minimumOrderQty,4);
  assert.equal(supplier.normalizeProductSupplierMapping({minimumOrderQty:-1}).minimumOrderQty,0);
});
