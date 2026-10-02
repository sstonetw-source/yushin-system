(function(root,factory){
  const receiving=typeof module==='object'&&module.exports?require('./receiving-core.js'):(root&&root.YushinReceiving);
  const api=factory(receiving);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinSupply=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(receiving){
  // ERPNext-style split:
  // method = how we place the supplier order
  // sourceType = why the demand exists
  const METHODS=Object.freeze({
    PURCHASING_PO:'PURCHASING_PO',
    PURCHASING_MANUAL:'PURCHASING_MANUAL',
    SALES_SELF_ORDER:'SALES_SELF_ORDER'
  });
  const SOURCES=Object.freeze({
    SALES_ORDER:'SALES_ORDER',
    STOCK_REPLENISHMENT:'STOCK_REPLENISHMENT'
  });

  function n(v){const x=Number(v);return Number.isFinite(x)?Math.max(0,x):0;}

  function normalize(record={}){
    if(!receiving)throw new Error('Receiving core is required.');
    const method=Object.values(METHODS).includes(record.method)
      ? record.method
      : Object.values(METHODS).includes(record.type)
        ? record.type
        : METHODS.PURCHASING_PO;
    const sourceType=Object.values(SOURCES).includes(record.sourceType)
      ? record.sourceType
      : String(record.orderId||record.sourceId||'').trim()
        ? SOURCES.SALES_ORDER
        : SOURCES.STOCK_REPLENISHMENT;
    return {
      ...receiving.normalizeSupply(record),
      method,
      type:method,
      sourceType,
      sourceId:String(record.sourceId||record.orderId||''),
      sourceItemId:String(record.sourceItemId||record.itemId||'')
    };
  }

  function validate(record={}){
    const x=normalize(record),errors=[];
    if(x.qty<=0)errors.push('qty');
    if(!String(x.supplierId||x.supplier||'').trim())errors.push('supplier');
    if(x.method===METHODS.SALES_SELF_ORDER&&n(x.unitCost)<=0)errors.push('unitCost');
    if(x.sourceType===SOURCES.SALES_ORDER){
      if(!String(x.sourceId||'').trim())errors.push('sourceId');
      if(!String(x.sourceItemId||'').trim())errors.push('sourceItemId');
    }
    return {valid:errors.length===0,errors,record:x};
  }

  function applyReceipt(record,qty){
    if(!receiving)throw new Error('Receiving core is required.');
    const current=normalize(record);
    const result=receiving.applyReceipt(current,qty);
    return {...result,record:{...result.record,method:current.method,type:current.method,sourceType:current.sourceType,sourceId:current.sourceId,sourceItemId:current.sourceItemId}};
  }

  function createsCustomerDispatch(record){
    const x=normalize(record);
    return x.sourceType===SOURCES.SALES_ORDER&&!!x.sourceId&&!!x.sourceItemId;
  }

  function canCreate(role,method){
    if(role==='admin')return true;
    if(method===METHODS.PURCHASING_PO||method===METHODS.PURCHASING_MANUAL)return role==='purchaser';
    if(method===METHODS.SALES_SELF_ORDER)return role==='sales'||role==='engineer';
    return false;
  }

  function demandLabel(record){
    return normalize(record).sourceType===SOURCES.STOCK_REPLENISHMENT?'備庫採購':'客戶訂單採購';
  }

  function receiptProgress(record={}){
    const x=normalize(record);
    const orderedQty=n(x.qty);
    const receivedQty=Math.min(orderedQty,n(x.receivedQty));
    const remainingQty=x.status==='CANCELLED'?0:Math.max(0,orderedQty-receivedQty);
    let receiptStatus='pending';
    let label='待到貨 '+receivedQty+'/'+orderedQty;
    if(x.status==='CANCELLED'){
      receiptStatus='cancelled';
      label=receivedQty>0?'部分到貨 '+receivedQty+'/'+orderedQty+'・其餘取消':'未到貨已取消';
    }else if(x.status==='RECEIVED'){
      receiptStatus='full';
      label='已到貨 '+receivedQty+'/'+orderedQty;
    }else if(x.status==='PARTIAL_RECEIPT'){
      receiptStatus='partial';
      label='部分到貨 '+receivedQty+'/'+orderedQty;
    }
    return {status:x.status,receiptStatus,orderedQty,receivedQty,remainingQty,percent:orderedQty>0?Math.min(100,(receivedQty/orderedQty)*100):0,label};
  }
  return {
    METHODS,SOURCES,
    // TYPES 暫時只作程式內同義名稱，資料上不再把補庫當 type。
    TYPES:METHODS,
    normalize,validate,applyReceipt,createsCustomerDispatch,canCreate,demandLabel,receiptProgress
  };
});