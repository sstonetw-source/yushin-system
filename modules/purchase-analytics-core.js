(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinPurchaseAnalytics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function normalizeKey(value){
    return String(value||'').normalize('NFKC').replace(/\s+/g,' ').trim().toLocaleLowerCase();
  }

  function normalizeLine(record={}){
    const qty=n(record.qty);
    const rawReceived=n(record.receivedQty);
    const status=String(record.status||'').toUpperCase();
    const cancelled=status==='CANCELLED';
    const receivedQty=Math.min(qty,rawReceived);
    // 取消代表「尚未到貨部分不再構成公司承諾」；已實際收到的部分仍保留。
    const effectiveOrderedQty=cancelled?receivedQty:qty;
    const incomingQty=Math.max(0,effectiveOrderedQty-receivedQty);
    const unitCost=n(record.unitCost);
    const orderId=String(record.orderId||'').trim();
    const type=String(record.type||'').toUpperCase();
    const sourceType=String(record.sourceType||'').toUpperCase();
    const stockPurchase=sourceType==='STOCK_REPLENISHMENT'||type==='STOCK_REPLENISHMENT'||!orderId;
    const supplierName=String(record.supplier||record.supplierName||'未設定供應商').trim()||'未設定供應商';
    const supplierId=String(record.supplierId||'').trim();
    const supplierKey=supplierId?('id:'+supplierId):('name:'+normalizeKey(supplierName));
    const documentKey=String(
      record.purchaseDocumentId||record.purchaseDocumentNo||record.internalNo||record.id||''
    ).trim();

    return {
      ...record,
      qty,
      receivedQty,
      effectiveOrderedQty,
      incomingQty,
      unitCost,
      cancelled,
      stockPurchase,
      customerOrderPurchase:!stockPurchase,
      supplierId,
      supplierName,
      supplierKey,
      documentKey,
      orderedAmount:effectiveOrderedQty*unitCost,
      receivedAmount:receivedQty*unitCost,
      incomingAmount:incomingQty*unitCost
    };
  }

  function createBucket(key='',name=''){
    return {
      key,
      supplierName:name||'未設定供應商',
      documentKeys:new Set(),
      lineCount:0,
      orderedQty:0,
      receivedQty:0,
      incomingQty:0,
      orderedAmount:0,
      receivedAmount:0,
      incomingAmount:0,
      stockAmount:0,
      customerOrderAmount:0
    };
  }

  function addLine(bucket,line){
    bucket.lineCount+=1;
    if(line.documentKey)bucket.documentKeys.add(line.documentKey);
    bucket.orderedQty+=line.effectiveOrderedQty;
    bucket.receivedQty+=line.receivedQty;
    bucket.incomingQty+=line.incomingQty;
    bucket.orderedAmount+=line.orderedAmount;
    bucket.receivedAmount+=line.receivedAmount;
    bucket.incomingAmount+=line.incomingAmount;
    if(line.stockPurchase)bucket.stockAmount+=line.orderedAmount;
    else bucket.customerOrderAmount+=line.orderedAmount;
    return bucket;
  }

  function finishBucket(bucket){
    return {
      key:bucket.key,
      supplierName:bucket.supplierName,
      documentCount:bucket.documentKeys.size,
      lineCount:bucket.lineCount,
      orderedQty:bucket.orderedQty,
      receivedQty:bucket.receivedQty,
      incomingQty:bucket.incomingQty,
      orderedAmount:bucket.orderedAmount,
      receivedAmount:bucket.receivedAmount,
      incomingAmount:bucket.incomingAmount,
      stockAmount:bucket.stockAmount,
      customerOrderAmount:bucket.customerOrderAmount
    };
  }

  function aggregate(records=[],include=null){
    const total=createBucket('total','全部');
    const suppliers=new Map();
    const lines=[];

    for(const record of records||[]){
      const line=normalizeLine(record);
      if(include&&!include(line))continue;
      // 完全取消且從未收貨的紀錄不計入有效採購品項。
      if(line.effectiveOrderedQty<=0)continue;
      lines.push(line);
      addLine(total,line);
      if(!suppliers.has(line.supplierKey)){
        suppliers.set(line.supplierKey,createBucket(line.supplierKey,line.supplierName));
      }
      addLine(suppliers.get(line.supplierKey),line);
    }

    const supplierRows=[...suppliers.values()]
      .map(finishBucket)
      .sort((a,b)=>b.orderedAmount-a.orderedAmount||a.supplierName.localeCompare(b.supplierName,'zh-Hant'));

    return {
      total:finishBucket(total),
      suppliers:supplierRows,
      lines
    };
  }

  return {normalizeLine,aggregate};
});