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
    return {onHand,reserved,available:Math.max(0,onHand-reserved-n(data.transferFreeInTransit)),incoming};
  }

  function stockIsEmpty(data={}){
    const zero=value=>(typeof value==='number'||(typeof value==='string'&&value.trim()!==''))
      && Number.isFinite(Number(value)) && Number(value)===0;
    return ['onHand','reserved','incoming','transferInTransit'].every(key=>{
      return zero(data[key]===undefined?0:data[key]);
    }) && (data.lots===undefined||Array.isArray(data.lots)) && (data.lots||[]).every(lot=>{
      const value=lot.remainingQty??lot.qty??0;
      return zero(value);
    });
  }

  function isListArchived(item={},stock=item){
    // New receipts/reservations must make the item visible even if its archive flag remains set.
    return item.listArchived===true && stockIsEmpty({...item,lots:[]}) && stockIsEmpty({...stock,lots:[]});
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
        ...(lot.costLotId?{costLotId:lot.costLotId}:{}),
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

  // Warehouse counts may include manually counted stock without a lot record.
  // Preserve this quantity as an explicit unbatched source, without inventing cost.
  function reconcileStockLots(lots=[],onHand=0,unbatchedId=''){
    if(!Number.isFinite(Number(onHand))||Number(onHand)<0)throw new Error('倉庫現有數量不正確');
    const tracked=lots.reduce((sum,lot)=>{
      const qty=Number(lot.remainingQty??lot.qty??0);
      if(!Number.isFinite(qty)||qty<0)throw new Error('批次數量不正確');
      return sum+qty;
    },0);
    const gap=Number(onHand)-tracked;
    if(gap < -1e-8)throw new Error('批次數量超過倉庫現有數量，請先核對庫存');
    if(gap<=1e-8)return {lots:[...lots],unbatched:null};
    if(!unbatchedId||lots.some(lot=>lot.id===unbatchedId))throw new Error('未分批庫存識別碼衝突');
    const unbatched={id:unbatchedId,lotNo:'',expiryDate:'',receivedQty:gap,remainingQty:gap,unbatched:true};
    return {lots:[...lots,unbatched],unbatched};
  }

  function quantityAdjustmentLots(lots=[],current=0,target=0,reserved=0,unbatchedId='',adjustmentId=''){
    if(!Number.isFinite(target)||target<0||target<Number(reserved||0))throw new Error('盤點數量不可小於已占用數量');
    const result=reconcileStockLots(lots,current,unbatchedId);
    const delta=target-Number(current);
    let allocations=[];
    if(delta<0)allocations=allocateLots(result.lots,-delta).allocations;
    const reduced=new Map(allocations.map(row=>[row.lotId,row.qty]));
    const next=result.lots.map(lot=>({...lot,remainingQty:Number(lot.remainingQty??lot.qty??0)-(reduced.get(lot.id)||0)}));
    if(delta>0){
      if(!adjustmentId||next.some(lot=>lot.id===adjustmentId))throw new Error('盤點庫存識別碼衝突');
      next.push({id:adjustmentId,lotNo:'',expiryDate:'',receivedQty:delta,remainingQty:delta,unbatched:true});
    }
    return {lots:next,allocations,delta};
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
    stockIsEmpty,
    isListArchived,
    sortLotsForIssue,
    allocateLots,
    reconcileStockLots,
    quantityAdjustmentLots,
    reverseLotAllocations,
    allocationsAfterReversal,
    availableReturnAllocations
  };
});
