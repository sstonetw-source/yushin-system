const COMPANY_TITLES=Object.freeze({
  yushin:'又鑫生物科技有限公司',
  morningstar:'辰星生物科技有限公司',
  'MULTI-LIFE':'鼎新生物科技有限公司'
});

function text(value){
  return String(value??'').trim();
}

function normalizeEmail(value){
  const email=text(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)?email:'';
}

function safePurchaseOrderId(value){
  const id=text(value);
  if(!id||id.length>160||id.includes('/'))throw new Error('INVALID_PURCHASE_ORDER_ID');
  return id;
}

function companyTitle(company){
  return COMPANY_TITLES[company]||COMPANY_TITLES.yushin;
}

function safePdfFileName(value,poNo=''){
  const fallback=(text(poNo)||'purchase-order')+'.pdf';
  let name=text(value)||fallback;
  name=name.replace(/[\\/:*?"<>|\u0000-\u001f]/g,'-').slice(0,180);
  if(!/\.pdf$/i.test(name))name+='.pdf';
  return name||fallback;
}

function decodePdfBase64(value,maxBytes=8*1024*1024){
  const base64=text(value).replace(/^data:application\/pdf;base64,/i,'').replace(/\s+/g,'');
  if(!base64||!/^[A-Za-z0-9+/]+={0,2}$/.test(base64))throw new Error('INVALID_PDF');
  const buffer=Buffer.from(base64,'base64');
  if(!buffer.length||buffer.length>maxBytes)throw new Error(buffer.length>maxBytes?'PDF_TOO_LARGE':'INVALID_PDF');
  if(buffer.subarray(0,5).toString('ascii')!=='%PDF-')throw new Error('INVALID_PDF');
  return buffer;
}

function composePurchaseOrderMail(input={}){
  const po=input.po||{};
  const supplier=input.supplier||{};
  const smtp=input.smtp||{};
  const poNo=text(po.poNo||po.id);
  const supplierName=text(supplier.supplierName||po.supplierName||po.vendorName)||'您好';
  const buyerName=text(po.buyerName);
  const title=companyTitle(po.company);
  const recipient=normalizeEmail(supplier.email);
  if(!recipient)throw new Error('SUPPLIER_EMAIL_MISSING');
  const from=text(smtp.from);
  if(!from)throw new Error('SMTP_FROM_MISSING');
  const subject='訂購單 '+poNo+'｜'+title;
  const body=supplierName+' 您好：\n\n'
    +'附件為訂購單 '+poNo+'，請查收，謝謝。\n\n'
    +title+(buyerName?'\n採購人員：'+buyerName:'');
  return {
    to:recipient,
    from,
    replyTo:normalizeEmail(smtp.replyTo)||undefined,
    subject,
    text:body,
    attachments:[{
      filename:safePdfFileName(input.fileName,poNo),
      contentType:'application/pdf'
    }]
  };
}

function communicationRecord(input={}){
  const po=input.po||{};
  const supplier=input.supplier||{};
  const actor=input.actor||{};
  const messageInfo=input.messageInfo||{};
  const now=text(input.now);
  const accepted=Array.isArray(messageInfo.accepted)?messageInfo.accepted.map(String):[];
  const rejected=Array.isArray(messageInfo.rejected)?messageInfo.rejected.map(String):[];
  return {
    purchaseOrderId:text(input.poId),
    purchaseOrderNo:text(po.poNo||input.poId),
    supplierId:text(supplier.supplierId||po.supplierId),
    supplierName:text(supplier.supplierName||po.supplierName||po.vendorName),
    recipientEmail:normalizeEmail(supplier.email),
    channel:'SMTP',
    state:'SENT',
    verifiedSent:true,
    preparedAt:now,
    sentAt:now,
    messageId:text(messageInfo.messageId),
    accepted,
    rejected,
    createdByUid:text(actor.uid),
    createdBy:text(actor.name||actor.email)
  };
}

module.exports={
  COMPANY_TITLES,
  normalizeEmail,
  safePurchaseOrderId,
  companyTitle,
  safePdfFileName,
  decodePdfBase64,
  composePurchaseOrderMail,
  communicationRecord
};
