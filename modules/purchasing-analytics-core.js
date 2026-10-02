(function(root,factory){
  const receiving=typeof module==='object'&&module.exports
    ? require('./receiving-core.js')
    : (root&&root.YushinReceiving);
  const api=factory(receiving);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinPurchasingAnalytics=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(receiving){
  function n(value){const x=Number(value);return Number.isFinite(x)?Math.max(0,x):0;}
  function projectSupply(record={}){
    if(!receiving?.normalizeSupply)throw new Error('Receiving core is required.');
    const supply=receiving.normalizeSupply(record);
    const cancelled=supply.status==='CANCELLED';
    const effectiveOrderedQty=cancelled?supply.receivedQty:supply.qty;
    const receivedQty=Math.min(supply.receivedQty,effectiveOrderedQty);
    const incomingQty=cancelled?0:supply.remainingQty;
    const unitCost=n(record.unitCost);
    const stockPurchase=!String(record.orderId||'').trim();
    return {
      ...record,
      status:supply.status,
      effectiveOrderedQty,
      receivedQty,
      incomingQty,
      unitCost,
      orderedAmount:effectiveOrderedQty*unitCost,
      receivedAmount:receivedQty*unitCost,
      incomingAmount:incomingQty*unitCost,
      stockPurchase,
      customerPurchase:!stockPurchase,
      supplier:String(record.supplier||record.supplierName||record.vendorName||'未指定供應商').trim()||'未指定供應商',
      purchaseDocumentKey:String(record.purchaseDocumentId||record.purchaseDocumentNo||record.internalNo||record.id||'').trim()
    };
  }
  function summarize(records=[]){
    const rows=records.map(projectSupply);
    const totals={itemCount:0,purchaseOrderCount:0,orderedAmount:0,receivedAmount:0,incomingAmount:0,stockAmount:0,customerAmount:0};
    const purchaseDocuments=new Set();
    const suppliers=new Map();
    for(const row of rows){
      totals.itemCount+=1;
      totals.orderedAmount+=row.orderedAmount;
      totals.receivedAmount+=row.receivedAmount;
      totals.incomingAmount+=row.incomingAmount;
      if(row.stockPurchase)totals.stockAmount+=row.orderedAmount;
      else totals.customerAmount+=row.orderedAmount;
      if(row.purchaseDocumentKey)purchaseDocuments.add(row.purchaseDocumentKey);
      if(!suppliers.has(row.supplier)){
        suppliers.set(row.supplier,{supplier:row.supplier,itemCount:0,purchaseOrderCount:0,orderedAmount:0,receivedAmount:0,incomingAmount:0,stockAmount:0,customerAmount:0,_documents:new Set()});
      }
      const group=suppliers.get(row.supplier);
      group.itemCount+=1;
      group.orderedAmount+=row.orderedAmount;
      group.receivedAmount+=row.receivedAmount;
      group.incomingAmount+=row.incomingAmount;
      if(row.stockPurchase)group.stockAmount+=row.orderedAmount;
      else group.customerAmount+=row.orderedAmount;
      if(row.purchaseDocumentKey)group._documents.add(row.purchaseDocumentKey);
    }
    totals.purchaseOrderCount=purchaseDocuments.size;
    const supplierRows=[...suppliers.values()].map(group=>{
      const {_documents,...rest}=group;
      return {...rest,purchaseOrderCount:_documents.size};
    }).sort((a,b)=>b.orderedAmount-a.orderedAmount||a.supplier.localeCompare(b.supplier));
    return {rows,totals,suppliers:supplierRows};
  }
  return {projectSupply,summarize};
});
