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
    const leadTimeNumber=Number(record.leadTimeDays??record.delay??0);
    return {
      ...record,
      supplierId:text(record.supplierId||record.id),
      supplierName,
      purchaseHeaderName:text(record.purchaseHeaderName)||supplierName,
      email:normalizeEmail(record.email||record.emailId),
      leadTimeDays:Number.isFinite(leadTimeNumber)&&leadTimeNumber>=0?Math.floor(leadTimeNumber):0,
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
      email:snapshot.email||po.supplierEmail||'',
      leadTimeDays:snapshot.leadTimeDays??po.supplierLeadTimeDays??0
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
      email:normalized.email,
      leadTimeDays:normalized.leadTimeDays
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

  function parseBusinessDate(value){
    const normalized=text(value);
    const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(normalized);
    if(!match)return '';
    const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
    const date=new Date(Date.UTC(year,month-1,day));
    if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return '';
    return normalized;
  }

  function addCalendarDays(value,days=0){
    const normalized=parseBusinessDate(value);
    if(!normalized)return '';
    const [year,month,day]=normalized.split('-').map(Number);
    const offsetNumber=Number(days);
    const offset=Number.isFinite(offsetNumber)?Math.max(0,Math.floor(offsetNumber)):0;
    const date=new Date(Date.UTC(year,month-1,day));
    date.setUTCDate(date.getUTCDate()+offset);
    return date.toISOString().slice(0,10);
  }

  // Simplified vendor lead time: one default number of calendar days per supplier.
  // This keeps automatic ETA without maintaining product-by-product supplier rules.
  function expectedArrivalDate(orderDate,supplierOrDays=0){
    const days=supplierOrDays&&typeof supplierOrDays==='object'
      ? normalizeSupplier(supplierOrDays).leadTimeDays
      : supplierOrDays;
    return addCalendarDays(orderDate,days);
  }

  function itemExpectedArrivalDate(item={},supplierOrDays=0,orderDate=''){
    const supplierDays=supplierOrDays&&typeof supplierOrDays==='object'
      ? normalizeSupplier(supplierOrDays).leadTimeDays
      : Number(supplierOrDays||0);
    if(!(supplierDays>0))return '';
    return expectedArrivalDate(orderDate,supplierDays);
  }

  function purchaseExpectedDate(items=[],supplierOrDays=0,orderDate=''){
    if(!(items||[]).length)return '';
    return itemExpectedArrivalDate(items[0]||{},supplierOrDays,orderDate);
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
    parseBusinessDate,
    addCalendarDays,
    expectedArrivalDate,
    itemExpectedArrivalDate,
    purchaseExpectedDate,
    communicationEvent
  };
});