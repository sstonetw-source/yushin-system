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
  function lotTime(value){const t=Date.parse(value||'');return Number.isFinite(t)?t:Number.MAX_SAFE_INTEGER;}
  function sortLotsForIssue(lots=[]){
    return [...lots].filter(l=>n(l.remainingQty??l.qty)>0).sort((a,b)=>{
      const ae=String(a.expiryDate||''),be=String(b.expiryDate||'');
      if(ae&&be&&ae!==be)return ae.localeCompare(be);
      if(ae&&!be)return -1;
      if(!ae&&be)return 1;
      return lotTime(a.receivedAt)-lotTime(b.receivedAt);
    });
  }
  function allocateLots(lots=[],qty=0){
    let remaining=n(qty);const allocations=[];
    for(const lot of sortLotsForIssue(lots)){
      if(remaining<=0)break;
      const available=n(lot.remainingQty??lot.qty),take=Math.min(available,remaining);
      if(!take)continue;
      const unitCost=n(lot.unitCost);
      allocations.push({lotId:lot.id||'',lotNo:lot.lotNo||'',expiryDate:lot.expiryDate||'',qty:take,unitCost,cost:take*unitCost});
      remaining-=take;
    }
    if(remaining>0)throw new Error('批次庫存不足');
    return {allocations,totalCost:allocations.reduce((s,row)=>s+row.cost,0)};
  }
  function reverseLotAllocations(records=[],qty=0){
    let remaining=n(qty);const allocations=[];
    for(const record of [...records].reverse()){
      if(remaining<=0)break;
      const recordQty=n(record.qty);
      const rows=Array.isArray(record.lotAllocations)?record.lotAllocations:[];
      const available=Math.min(recordQty,rows.reduce((sum,row)=>sum+n(row.qty),0));
      let take=Math.min(available,remaining);
      for(const row of [...rows].reverse()){
        if(take<=0)break;
        const restored=Math.min(n(row.qty),take);
        if(!restored)continue;
        const unitCost=n(row.unitCost);
        allocations.push({lotId:row.lotId||'',lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',qty:restored,unitCost,cost:restored*unitCost});
        take-=restored;remaining-=restored;
      }
    }
    if(remaining>0)throw new Error('找不到足夠的原始出貨批次，無法安全還原庫存');
    return {allocations,totalCost:allocations.reduce((sum,row)=>sum+row.cost,0)};
  }
  function allocationsAfterReversal(allocations=[],reversed=[]){
    const remainingByLot=new Map();
    for(const row of reversed)remainingByLot.set(row.lotId,n(remainingByLot.get(row.lotId))+n(row.qty));
    const result=[];
    for(const row of allocations){
      const restoreLeft=n(remainingByLot.get(row.lotId));
      const removed=Math.min(n(row.qty),restoreLeft);
      remainingByLot.set(row.lotId,Math.max(0,restoreLeft-removed));
      const qty=n(row.qty)-removed;
      if(qty>0){const unitCost=n(row.unitCost);result.push({...row,qty,unitCost,cost:qty*unitCost});}
    }
    return result;
  }
  return {TYPES,normalize,validate,applyReceipt,createsCustomerDispatch,canCreate,sortLotsForIssue,allocateLots,reverseLotAllocations,allocationsAfterReversal};
});
