(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinSupplier=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function text(value){
    return String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim();
  }

  function normalizeEmail(value){
    return text(value).toLocaleLowerCase();
  }

  function isValidEmail(value){
    const email=normalizeEmail(value);
    return !email||/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  }

  function normalizeSupplier(record={}){
    const supplierName=text(record.supplierName||record.name);
    return {
      ...record,
      supplierId:text(record.supplierId||record.id),
      supplierName,
      purchaseHeaderName:text(record.purchaseHeaderName)||supplierName,
      email:normalizeEmail(record.email||record.emailId),
      active:record.active!==false
    };
  }

  function validateSupplier(record={}){
    const supplier=normalizeSupplier(record);
    const errors=[];
    if(!supplier.supplierName)errors.push('supplierName');
    if(!isValidEmail(supplier.email))errors.push('email');
    return {valid:errors.length===0,errors,supplier};
  }

  function supplierKey(record={}){
    const x=normalizeSupplier(record);
    return x.supplierId
      ? 'id:'+x.supplierId
      : 'name:'+x.supplierName.toLocaleLowerCase();
  }

  function matchesSupplier(record={},query={}){
    const supplier=normalizeSupplier(record);
    const id=text(query.supplierId||query.id);
    if(id&&(supplier.supplierId===id||text(record.id)===id))return true;
    const names=[
      text(query.supplierName),
      text(query.vendorName),
      text(query.purchaseHeaderName)
    ].filter(Boolean).map(value=>value.toLocaleLowerCase());
    if(!names.length)return false;
    const candidateNames=[
      supplier.supplierName.toLocaleLowerCase(),
      supplier.purchaseHeaderName.toLocaleLowerCase()
    ].filter(Boolean);
    return names.some(name=>candidateNames.includes(name));
  }

  function findLiveSupplier(po={},suppliers=[]){
    return (suppliers||[]).find(record=>record?.active!==false&&matchesSupplier(record,po))||null;
  }

  function documentSnapshot(po={}){
    const snapshot=po.supplierSnapshot&&typeof po.supplierSnapshot==='object'
      ? po.supplierSnapshot
      : {};
    return normalizeSupplier({
      supplierId:snapshot.supplierId||po.supplierId||'',
      supplierName:snapshot.supplierName||po.supplierName||po.vendorName||'',
      purchaseHeaderName:snapshot.purchaseHeaderName||po.vendorName||po.supplierName||'',
      email:snapshot.email||po.supplierEmail||''
    });
  }

  function snapshotForPurchaseOrder(supplier={},fallback={}){
    const normalized=normalizeSupplier({
      ...fallback,
      ...supplier,
      supplierId:supplier.supplierId||supplier.id||fallback.supplierId||fallback.id||''
    });
    return {
      supplierId:normalized.supplierId,
      supplierName:normalized.supplierName,
      purchaseHeaderName:normalized.purchaseHeaderName,
      email:normalized.email
    };
  }

  function purchaseOrderContact(po={},suppliers=[]){
    const snapshot=documentSnapshot(po);
    const live=findLiveSupplier({
      supplierId:snapshot.supplierId||po.supplierId||'',
      supplierName:snapshot.supplierName||po.supplierName||'',
      vendorName:snapshot.purchaseHeaderName||po.vendorName||''
    },suppliers);
    const liveNormalized=live?normalizeSupplier(live):null;
    const liveEmail=liveNormalized?.email||'';
    const snapshotEmail=snapshot.email||'';
    return {
      supplierId:snapshot.supplierId||liveNormalized?.supplierId||'',
      supplierName:snapshot.supplierName||liveNormalized?.supplierName||'',
      purchaseHeaderName:snapshot.purchaseHeaderName||liveNormalized?.purchaseHeaderName||'',
      email:liveEmail||snapshotEmail,
      liveEmail,
      snapshotEmail,
      emailSource:liveEmail?'SUPPLIER_MASTER':snapshotEmail?'PURCHASE_ORDER_SNAPSHOT':'NONE'
    };
  }

  function communicationEvent(po={},contact={},input={}){
    const channel=text(input.channel||'MAILTO').toUpperCase();
    const preparedAt=text(input.preparedAt||input.createdAt);
    return {
      purchaseOrderId:text(po.id||po.poNo),
      purchaseOrderNo:text(po.poNo||po.id),
      supplierId:text(contact.supplierId||po.supplierId),
      supplierName:text(contact.supplierName||po.supplierName||po.vendorName),
      recipientEmail:normalizeEmail(contact.email),
      channel,
      state:'PREPARED',
      verifiedSent:false,
      preparedAt,
      createdAt:preparedAt,
      createdByUid:text(input.createdByUid),
      createdBy:text(input.createdBy)
    };
  }

  return {
    normalizeEmail,
    isValidEmail,
    normalizeSupplier,
    validateSupplier,
    supplierKey,
    matchesSupplier,
    findLiveSupplier,
    documentSnapshot,
    snapshotForPurchaseOrder,
    purchaseOrderContact,
    communicationEvent
  };
});
