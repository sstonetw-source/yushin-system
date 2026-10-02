(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinInventory=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function normalizeStock(data={}){
    const onHand=n(data.onHand);
    const reserved=n(data.reserved);
    const incoming=n(data.incoming);
    return {onHand,reserved,available:Math.max(0,onHand-reserved),incoming};
  }

  function lotTime(value){
    const time=Date.parse(value||'');
    return Number.isFinite(time)?time:Number.MAX_SAFE_INTEGER;
  }

  function sortLotsForIssue(lots=[],expiryManaged=true){
    return [...lots].filter(lot=>n(lot.remainingQty??lot.qty)>0).sort((a,b)=>{
      if(expiryManaged){
        const ae=String(a.expiryDate||''),be=String(b.expiryDate||'');
        if(ae&&be&&ae!==be)return ae.localeCompare(be);
        if(ae&&!be)return -1;
        if(!ae&&be)return 1;
      }
      return lotTime(a.receivedAt)-lotTime(b.receivedAt);
    });
  }

  function allocateLots(lots=[],qty=0,expiryManaged=true){
    let remaining=n(qty);
    const allocations=[];
    for(const lot of sortLotsForIssue(lots,expiryManaged)){
      if(remaining<=0)break;
      const available=n(lot.remainingQty??lot.qty);
      const take=Math.min(available,remaining);
      if(!take)continue;
      const unitCost=n(lot.unitCost);
      allocations.push({
        lotId:lot.id||lot.lotId||'',
        lotNo:lot.lotNo||'',
        expiryDate:lot.expiryDate||'',
        qty:take,
        unitCost,
        cost:take*unitCost
      });
      remaining-=take;
    }
    if(remaining>0)throw new Error('批次庫存不足');
    return {allocations,totalCost:allocations.reduce((sum,row)=>sum+row.cost,0)};
  }

  function reverseLotAllocations(records=[],qty=0){
    let remaining=n(qty);
    const allocations=[];
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
        allocations.push({
          lotId:row.lotId||'',
          lotNo:row.lotNo||'',
          expiryDate:row.expiryDate||'',
          qty:restored,
          unitCost,
          cost:restored*unitCost
        });
        take-=restored;
        remaining-=restored;
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
      if(qty>0){
        const unitCost=n(row.unitCost);
        result.push({...row,qty,unitCost,cost:qty*unitCost});
      }
    }
    return result;
  }

  function availableReturnAllocations(deliveries=[],returns=[]){
    let allocations=[];
    for(const delivery of deliveries){
      allocations.push(...(Array.isArray(delivery.lotAllocations)?delivery.lotAllocations:[]));
    }
    for(const returned of returns){
      allocations=allocationsAfterReversal(
        allocations,
        Array.isArray(returned.lotAllocations)?returned.lotAllocations:[]
      );
    }
    return allocations;
  }

  return {
    normalizeStock,
    sortLotsForIssue,
    allocateLots,
    reverseLotAllocations,
    allocationsAfterReversal,
    availableReturnAllocations
  };
});