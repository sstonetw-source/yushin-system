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
