(function(root,factory){
  const receiving=typeof module==='object'&&module.exports?require('./receiving-core.js'):(root&&root.YushinReceiving);
  const api=factory(receiving);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinPurchasingAnalytics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(receiving){
  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function projectSupply(record={}){
    if(!receiving)throw new Error('Receiving core is required.');
    const supply=receiving.normalizeSupply(record);
    const unitCost=n(record.unitCost);
    const cancelled=supply.status==='CANCELLED';
    // 取消後尚未到貨的數量不再算有效採購；已實際到貨仍保留歷史金額。
    const effectiveOrderedQty=cancelled?supply.receivedQty:supply.qty;
    const receivedQty=Math.min(effectiveOrderedQty,supply.receivedQty);
    const incomingQty=cancelled?0:supply.remainingQty;
    const sourceType=String(record.sourceType||'').trim();
    const sourceId=String(record.sourceId||record.orderId||'').trim();
    const isStockReplenishment=sourceType
      ? sourceType==='STOCK_REPLENISHMENT'
      : !sourceId&&record.method!=='SALES_SELF_ORDER'&&record.type!=='SALES_SELF_ORDER';
    const documentKey=String(record.purchaseDocumentId||record.purchaseDocumentNo||record.internalNo||record.id||'').trim();
    const supplier=String(record.supplier||record.supplierName||record.vendorName||'未指定供應商').trim()||'未指定供應商';
    const supplierKey=String(record.supplierId||supplier).trim()||supplier;
    return {
      record,
      supplier,
      supplierKey,
      sourceType:sourceType||(isStockReplenishment?'STOCK_REPLENISHMENT':'SALES_ORDER'),
      sourceId,
      documentKey,
      unitCost,
      effectiveOrderedQty,
      receivedQty,
      incomingQty,
      orderedAmount:effectiveOrderedQty*unitCost,
      receivedAmount:receivedQty*unitCost,
      incomingAmount:incomingQty*unitCost,
      stockAmount:isStockReplenishment?effectiveOrderedQty*unitCost:0,
      customerOrderAmount:isStockReplenishment?0:effectiveOrderedQty*unitCost,
      isStockReplenishment
    };
  }

  function summarize(records=[]){
    const rows=(records||[]).map(projectSupply).filter(row=>row.effectiveOrderedQty>0||row.receivedQty>0);
    const totals={
      lineCount:rows.length,
      documentCount:new Set(rows.map(row=>row.documentKey).filter(Boolean)).size,
      orderedAmount:0,
      receivedAmount:0,
      incomingAmount:0,
      stockAmount:0,
      customerOrderAmount:0
    };
    const suppliers=new Map();

    for(const row of rows){
      totals.orderedAmount+=row.orderedAmount;
      totals.receivedAmount+=row.receivedAmount;
      totals.incomingAmount+=row.incomingAmount;
      totals.stockAmount+=row.stockAmount;
      totals.customerOrderAmount+=row.customerOrderAmount;

      if(!suppliers.has(row.supplierKey)){
        suppliers.set(row.supplierKey,{
          supplier:row.supplier,
          documents:new Set(),
          lineCount:0,
          orderedAmount:0,
          receivedAmount:0,
          incomingAmount:0,
          stockAmount:0,
          customerOrderAmount:0
        });
      }
      const bucket=suppliers.get(row.supplierKey);
      if(row.documentKey)bucket.documents.add(row.documentKey);
      bucket.lineCount++;
      bucket.orderedAmount+=row.orderedAmount;
      bucket.receivedAmount+=row.receivedAmount;
      bucket.incomingAmount+=row.incomingAmount;
      bucket.stockAmount+=row.stockAmount;
      bucket.customerOrderAmount+=row.customerOrderAmount;
    }

    const bySupplier=[...suppliers.values()].map(bucket=>({
      supplier:bucket.supplier,
      documentCount:bucket.documents.size,
      lineCount:bucket.lineCount,
      orderedAmount:bucket.orderedAmount,
      receivedAmount:bucket.receivedAmount,
      incomingAmount:bucket.incomingAmount,
      stockAmount:bucket.stockAmount,
      customerOrderAmount:bucket.customerOrderAmount
    })).sort((a,b)=>b.orderedAmount-a.orderedAmount||a.supplier.localeCompare(b.supplier,'zh-Hant'));

    return {rows,totals,bySupplier};
  }

  return {projectSupply,summarize};
});