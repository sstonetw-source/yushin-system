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

  function normalizeProductSupplierMapping(record={}){
    const priorityNumber=Number(record.priority??record.sequence??1);
    const leadTimeNumber=Number(record.leadTimeDays??record.delay??0);
    const minimumOrderQtyNumber=Number(record.minimumOrderQty??record.minOrderQty??record.minQty??0);
    return {
      ...record,
      mappingId:text(record.mappingId||record.id),
      productId:text(record.productId),
      itemCode:text(record.itemCode||record.productCode),
      supplierId:text(record.supplierId||record.partnerId),
      supplierPartNo:text(record.supplierPartNo||record.supplierPartNumber||record.vendorProductCode),
      priority:Number.isFinite(priorityNumber)&&priorityNumber>0?Math.floor(priorityNumber):1,
      leadTimeDays:Number.isFinite(leadTimeNumber)&&leadTimeNumber>=0?Math.floor(leadTimeNumber):0,
      minimumOrderQty:Number.isFinite(minimumOrderQtyNumber)&&minimumOrderQtyNumber>0?minimumOrderQtyNumber:0,
      active:record.active!==false
    };
  }

  function validateProductSupplierMapping(record={}){
    const mapping=normalizeProductSupplierMapping(record);
    const errors=[];
    if(!mapping.productId&&!mapping.itemCode)errors.push('product');
    if(!mapping.supplierId)errors.push('supplierId');
    return {valid:errors.length===0,errors,mapping};
  }

  function productSupplierMatches(mapping={},product={}){
    const x=normalizeProductSupplierMapping(mapping);
    if(!x.active)return false;
    const productId=text(product.productId||product.id);
    const itemCode=text(product.itemCode||product.model||product.productCode).toLocaleLowerCase();
    if(productId&&x.productId&&x.productId===productId)return true;
    return !!itemCode&&!!x.itemCode&&x.itemCode.toLocaleLowerCase()===itemCode;
  }

  function selectProductSupplierMapping(mappings=[],product={}){
    return (mappings||[])
      .filter(mapping=>productSupplierMatches(mapping,product))
      .map(normalizeProductSupplierMapping)
      .sort((a,b)=>a.priority-b.priority||a.supplierId.localeCompare(b.supplierId))[0]||null;
  }

  function minimumOrderRule(item={},mappings=[],supplierId=''){
    const requiredSupplierId=text(supplierId);
    const candidates=requiredSupplierId
      ? (mappings||[]).filter(mapping=>normalizeProductSupplierMapping(mapping).supplierId===requiredSupplierId)
      : (mappings||[]);
    const mapping=selectProductSupplierMapping(candidates,item||{});
    const minimumOrderQty=Number(mapping?.minimumOrderQty||0);
    return {
      mapping,
      minimumOrderQty:Number.isFinite(minimumOrderQty)&&minimumOrderQty>0?minimumOrderQty:0
    };
  }

  function validatePurchaseQuantity(item={},qty=0,mappings=[],supplierId=''){
    const quantityNumber=Number(qty);
    const quantity=Number.isFinite(quantityNumber)?Math.max(0,quantityNumber):0;
    const rule=minimumOrderRule(item,mappings,supplierId);
    return {
      ...rule,
      quantity,
      valid:!(rule.minimumOrderQty>0)||quantity>=rule.minimumOrderQty,
      shortage:rule.minimumOrderQty>0?Math.max(0,rule.minimumOrderQty-quantity):0
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

  // Odoo-style vendor lead time projection adapted to Yushin's current
  // single expected-date PO header. Only project when every selected item has
  // an explicit lead time for the selected supplier; otherwise leave it blank
  // rather than inventing a date.
  function expectedArrivalDate(orderDate,mappingOrDays=0){
    const days=mappingOrDays&&typeof mappingOrDays==='object'
      ? normalizeProductSupplierMapping(mappingOrDays).leadTimeDays
      : mappingOrDays;
    return addCalendarDays(orderDate,days);
  }

  function itemExpectedArrivalDate(item={},mappings=[],orderDate='',supplierId=''){
    const base=parseBusinessDate(orderDate);
    if(!base)return '';
    const requiredSupplierId=text(supplierId);
    const candidates=requiredSupplierId
      ? (mappings||[]).filter(mapping=>normalizeProductSupplierMapping(mapping).supplierId===requiredSupplierId)
      : (mappings||[]);
    const mapping=selectProductSupplierMapping(candidates,item||{});
    if(!mapping||!(Number(mapping.leadTimeDays)>0))return '';
    return addCalendarDays(base,mapping.leadTimeDays);
  }

  function purchaseExpectedDate(items=[],mappings=[],orderDate='',supplierId=''){
    const dates=(items||[]).map(item=>itemExpectedArrivalDate(item,mappings,orderDate,supplierId));
    if(!dates.length||dates.some(date=>!date))return '';
    return dates.sort().at(-1)||'';
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
    normalizeProductSupplierMapping,
    validateProductSupplierMapping,
    productSupplierMatches,
    selectProductSupplierMapping,
    minimumOrderRule,
    validatePurchaseQuantity,
    parseBusinessDate,
    addCalendarDays,
    expectedArrivalDate,
    itemExpectedArrivalDate,
    purchaseExpectedDate,
    communicationEvent
  };
});