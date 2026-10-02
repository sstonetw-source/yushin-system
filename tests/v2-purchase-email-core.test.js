const test=require('node:test');
const assert=require('node:assert/strict');
const mail=require('../functions/purchase-email-core.js');

test('purchase email always targets Supplier Master email',()=>{
  const message=mail.composePurchaseOrderMail({
    po:{poNo:'PO-YS-20261002-01-01',company:'yushin',vendorName:'舊抬頭',buyerName:'Buyer'},
    supplier:{supplierName:'正式供應商',email:'ORDERS@SUPPLIER.COM'},
    smtp:{from:'又鑫採購 <purchasing@example.com>'},
    fileName:'PO.pdf'
  });
  assert.equal(message.to,'orders@supplier.com');
  assert.equal(message.subject,'訂購單 PO-YS-20261002-01-01｜又鑫生物科技有限公司');
  assert.match(message.text,/正式供應商 您好/);
  assert.equal(message.attachments[0].filename,'PO.pdf');
});

test('purchase email never accepts an invalid supplier email',()=>{
  assert.throws(()=>mail.composePurchaseOrderMail({
    po:{poNo:'PO-1'},
    supplier:{email:'not-an-email'},
    smtp:{from:'buyer@example.com'}
  }),/SUPPLIER_EMAIL_MISSING/);
});

test('PDF decoder accepts real PDF signature and rejects non-PDF payload',()=>{
  const pdf=Buffer.from('%PDF-1.7\nfake test pdf');
  assert.equal(mail.decodePdfBase64(pdf.toString('base64')).subarray(0,5).toString(),'%PDF-');
  assert.throws(()=>mail.decodePdfBase64(Buffer.from('hello').toString('base64')),/INVALID_PDF/);
});

test('communication record only marks server-confirmed SMTP as sent',()=>{
  const event=mail.communicationRecord({
    poId:'PO-1',
    po:{poNo:'PO-1',supplierId:'SUP-1'},
    supplier:{supplierId:'SUP-1',supplierName:'Supplier',email:'orders@supplier.com'},
    actor:{uid:'U1',name:'Buyer'},
    messageInfo:{messageId:'MSG-1',accepted:['orders@supplier.com'],rejected:[]},
    now:'2026-10-02T05:00:00.000Z'
  });
  assert.equal(event.channel,'SMTP');
  assert.equal(event.state,'SENT');
  assert.equal(event.verifiedSent,true);
  assert.equal(event.messageId,'MSG-1');
});

test('purchase order id cannot escape the Firestore document path',()=>{
  assert.equal(mail.safePurchaseOrderId('PO-YS-1'),'PO-YS-1');
  assert.throws(()=>mail.safePurchaseOrderId('../PO'),/INVALID_PURCHASE_ORDER_ID/);
  assert.throws(()=>mail.safePurchaseOrderId('A/B'),/INVALID_PURCHASE_ORDER_ID/);
});
