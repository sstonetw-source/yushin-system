(function(root,factory){
  const supply=typeof module==='object'&&module.exports?require('./supply-core.js'):(root&&root.YushinSupply);
  const api=factory(supply);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinPurchasingAnalytics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(supply){
  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function projectSupply(record={}){
    if(!supply)throw new Error('Supply core is required.');
    const x=supply.normalize(record);
    const unitCost=n(x.unitCost);
    const cancelled=x.status==='CANCELLED';
    const effectiveOrderedQty=cancelled?x.receivedQty:x.qty;
    const receivedQty=Math.min(effectiveOrderedQty,x.receivedQty);
    const incomingQty=cancelled?0:x.remainingQty;
    const isStockReplenishment=x.sourceType===supply.SOURCES.STOCK_REPLENISHMENT;
    const documentKey=String(x.purchaseDocumentId||x.purchaseDocumentNo||x.internalNo||x.id||'').trim();
    const supplierName=String(x.supplier||x.supplierName||'未指定供應商').trim()||'未指定供應商';
    const supplierId=String(x.supplierId||'').trim();
    const supplierKey=supplierId?('id:'+supplierId):('name:'+supplierName.normalize('NFKC').toLocaleLowerCase());

    return {
      record:x,
      supplier:supplierName,
      supplierKey,
      documentKey,
      method:x.method,
      sourceType:x.sourceType,
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
