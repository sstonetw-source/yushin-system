(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinSupply=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const TYPES=Object.freeze({PURCHASING_PO:'PURCHASING_PO',SALES_SELF_ORDER:'SALES_SELF_ORDER',STOCK_REPLENISHMENT:'STOCK_REPLENISHMENT'});
  function n(v){const x=Number(v);return Number.isFinite(x)?Math.max(0,x):0;}
  function normalize(record={}){
    const type=Object.values(TYPES).includes(record.type)?record.type:TYPES.PURCHASING_PO;
    const qty=n(record.qty);
    const receivedQty=Math.min(qty,n(record.receivedQty));
    return {...record,type,qty,receivedQty,remainingQty:Math.max(0,qty-receivedQty),status:receivedQty>=qty&&qty>0?'RECEIVED':receivedQty>0?'PARTIAL_RECEIPT':record.status||'ORDERED'};
  }
  function validate(record={}){
    const x=normalize(record),errors=[];
    if(x.qty<=0)errors.push('qty');
    if(!String(x.supplierId||x.supplier||'').trim())errors.push('supplier');
    if(x.type===TYPES.SALES_SELF_ORDER&&n(x.unitCost)<=0)errors.push('unitCost');
    if(x.type!==TYPES.STOCK_REPLENISHMENT&&!String(x.orderId||'').trim())errors.push('orderId');
    if(x.type!==TYPES.STOCK_REPLENISHMENT&&!String(x.itemId||'').trim())errors.push('itemId');
    return {valid:errors.length===0,errors,record:x};
  }
  function applyReceipt(record,qty){
    const x=normalize(record),applied=Math.min(n(qty),x.remainingQty);
    return {appliedQty:applied,record:normalize({...x,receivedQty:x.receivedQty+applied})};
  }
  function createsCustomerDispatch(record){
    const x=normalize(record);
    return x.type!==TYPES.STOCK_REPLENISHMENT&&!!x.orderId&&!!x.itemId;
  }
  function canCreate(role,type){
    if(role==='admin')return true;
    if(type===TYPES.PURCHASING_PO||type===TYPES.STOCK_REPLENISHMENT)return role==='purchaser';
    if(type===TYPES.SALES_SELF_ORDER)return role==='sales'||role==='engineer';
    return false;
  }
  return {TYPES,normalize,validate,applyReceipt,createsCustomerDispatch,canCreate};
});
