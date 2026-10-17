(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinInventory=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const STOCK_POLICIES=Object.freeze({NO_STOCK:'NO_STOCK',SAFETY_STOCK:'SAFETY_STOCK',ORDER_ONLY:'ORDER_ONLY'});
  function stockPolicyFor(record={}){
    const explicit=String(record.stockPolicy||'').toUpperCase();
    return Object.values(STOCK_POLICIES).includes(explicit)?explicit:Number(record.safetyStock||0)>0?STOCK_POLICIES.SAFETY_STOCK:STOCK_POLICIES.ORDER_ONLY;
  }
  function planningSettings(policy,safetyStock=0){
    const stockPolicy=String(policy||'').trim().toUpperCase();
    if(!Object.values(STOCK_POLICIES).includes(stockPolicy))throw new Error('庫存策略格式不正確。');
    const value=stockPolicy===STOCK_POLICIES.SAFETY_STOCK?safetyStock:0;
    if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||(Number(value)<0||Number(value)>Number.MAX_SAFE_INTEGER)||(stockPolicy===STOCK_POLICIES.SAFETY_STOCK&&Number(value)<=0))throw new Error('安全庫存必須是大於 0 的數字。');
    return {stockPolicy,safetyStock:Number(value)};
  }
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
    return ['onHand','reserved','incoming','transferInTransit','transferFreeInTransit'].every(key=>{
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
    if(!Number.isFinite(target)||target<0||target<Number(reserved||0))throw new Error('盤點數量不可小於已預留數量');
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

  function manualAdjustmentLots(lots=[],current=0,delta=0,reserved=0,{lotNo='',expiryDate='',balanceId='',addedId=''}={}){
    if(!Number.isFinite(delta)||delta===0||!Number.isFinite(current)||current<0||!Number.isFinite(reserved)||reserved<0||reserved>current||!Number.isFinite(current+delta)||current+delta<reserved)throw new Error('庫存異動數量不正確或不足以支撐已預留數量');
    if(delta>0||(!lotNo&&!expiryDate)){
      const result=quantityAdjustmentLots(lots,current,current+delta,reserved,balanceId,addedId);
      return {...result,lots:result.lots.map(lot=>lot.id===addedId?{...lot,lotNo,expiryDate,unbatched:!lotNo&&!expiryDate}:lot)};
    }
    const reconciled=reconcileStockLots(lots,current,balanceId);
    const eligible=reconciled.lots.filter(lot=>(!lotNo||(lot.lotNo||'')===lotNo)&&(!expiryDate||(lot.expiryDate||'')===expiryDate));
    const allocations=allocateLots(eligible,-delta).allocations;
    const used=new Map(allocations.map(row=>[row.lotId,row.qty]));
    return {delta,allocations,lots:reconciled.lots.map(lot=>({...lot,remainingQty:Number(lot.remainingQty??lot.qty??0)-(used.get(lot.id)||0)}))};
  }

  function operationalLotRows(records=[]){
    const rows=records.map(record=>{
      const value=record.remainingQty??record.qty;
      if(!['id','productKey','warehouseId'].every(field=>typeof record[field]==='string'&&record[field].trim())||!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<0)throw new Error('批次識別或剩餘數量不正確');
      const receivedAt=typeof record.receivedAt==='string'?record.receivedAt:typeof record.receivedAt?.toDate==='function'?record.receivedAt.toDate().toISOString():'';
      return {id:record.id,productKey:record.productKey,warehouseId:record.warehouseId,lotNo:String(record.lotNo||''),expiryDate:String(record.expiryDate||''),receivedAt,remainingQty:Number(value),qty:Number(value)};
    });
    return sortLotsForIssue(rows);
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
          ...(row.costLotId?{costLotId:row.costLotId}:{}),
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

  // Shared by delivery reversal, customer return and return correction.
  // The transaction re-reads these exact lot IDs; never infer a different
  // warehouse or silently repair a malformed historical batch.
  function planLotRestoration({productKey,warehouseId,allocations=[],lots=[],direction=1}={}){
    if(typeof productKey!=='string'||!productKey||typeof warehouseId!=='string'||!warehouseId)
      throw new Error('原批次還原缺少產品或倉庫識別碼。');
    if(direction!==1&&direction!==-1)throw new Error('原批次還原方向不正確。');
    if(!Array.isArray(allocations)||!allocations.length||!Array.isArray(lots))
      throw new Error('原批次還原明細不正確。');
    const quantity=value=>{
      if(!['number','string'].includes(typeof value)||String(value).trim()===''
        ||!Number.isFinite(Number(value))||Number(value)<0||Number(value)>Number.MAX_SAFE_INTEGER)
        throw new Error('原出貨批次數量不正確，請先核對資料。');
      return Number(value);
    };
    const byId=new Map();
    for(const lot of lots){
      if(!lot||typeof lot.id!=='string'||!lot.id||byId.has(lot.id))
        throw new Error('原出貨批次識別碼缺失或重複。');
      byId.set(lot.id,lot);
    }
    const totals=new Map();
    for(const row of allocations){
      if(typeof row?.lotId!=='string'||!row.lotId)throw new Error('原出貨批次識別碼缺失。');
      const qty=quantity(row.qty);
      if(qty<=0)throw new Error('原批次還原數量必須大於零。');
      totals.set(row.lotId,quantity((totals.get(row.lotId)||0)+qty));
    }
    return [...totals].map(([lotId,qty])=>{
      const lot=byId.get(lotId);
      if(!lot)throw new Error(`找不到原出貨批次 ${lotId}，無法安全還原庫存。`);
      if(lot.productKey!==productKey||lot.warehouseId!==warehouseId)
        throw new Error(`原出貨批次 ${lotId} 的產品或倉庫不一致，請先核對原出貨倉與退貨倉。`);
      const before=quantity(lot.remainingQty),remainingQty=before+direction*qty;
      if(remainingQty<0)throw new Error(`原出貨批次 ${lotId} 庫存不足，無法刪除／縮減退貨。`);
      return {lotId,remainingQty:quantity(remainingQty),qtyDelta:direction*qty};
    });
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

  // The actual returned batch is selected explicitly. A partial customer
  // acknowledgement does not establish which batch in a mixed parcel arrived.
  function planExplicitShipmentReturn({shipment,confirmedQty,selections=[],priorReturns=[]}={}){
    const qty=value=>{
      if(!Number.isSafeInteger(value)||value<0)throw Error('退貨追溯數量必須為非負整數');
      return value;
    };
    const ident=value=>{
      if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
        throw Error('退貨批次識別碼不正確');
      return value;
    };
    if(!shipment||qty(shipment.qty)<=0||qty(confirmedQty)>shipment.qty
      ||!Array.isArray(shipment.lotAllocations)||!shipment.lotAllocations.length||shipment.lotAllocations.length>200
      ||!Array.isArray(selections)||!selections.length||selections.length>200)
      throw Error('退貨追溯來源或明細不正確');
    const lots=new Map();let sourceQty=0,returnQty=0;
    for(const row of availableReturnAllocations([shipment],[])){
      ident(row.lotId);qty(row.qty);
      if(!row.qty||lots.has(row.lotId))throw Error('原出貨批次重複或數量不正確');
      lots.set(row.lotId,row);sourceQty=qty(sourceQty+row.qty);
    }
    if(sourceQty!==shipment.qty)throw Error('原出貨量與實際批次合計不一致');
    if(!Array.isArray(priorReturns)||priorReturns.length>200)throw Error('先前退貨明細不正確');
    let priorQty=0;
    for(const record of priorReturns){
      if(!Array.isArray(record?.lotAllocations)||!record.lotAllocations.length||record.lotAllocations.length>200)
        throw Error('先前退貨批次不正確');
      let total=0;const used=new Set();
      for(const row of record.lotAllocations){
        const source=lots.get(ident(row?.lotId));qty(row.qty);
        if(!source||!row.qty||used.has(row.lotId)||row.qty>source.qty)throw Error('先前退貨超過原批次額度');
        used.add(row.lotId);total=qty(total+row.qty);lots.set(row.lotId,{...source,qty:source.qty-row.qty});
      }
      if(total!==qty(record.qty))throw Error('先前退貨量與批次不一致');
      priorQty=qty(priorQty+total);
    }
    const seen=new Set(),allocations=[];
    for(const row of selections){
      ident(row?.lotId);qty(row.qty);const source=lots.get(row.lotId);
      if(!row.qty||seen.has(row.lotId)||!source||row.qty>source.qty)
        throw Error('指定退貨批次不屬於原出貨或超過該批次數量');
      seen.add(row.lotId);returnQty=qty(returnQty+row.qty);
      allocations.push({lotId:row.lotId,lotNo:source.lotNo||'',expiryDate:source.expiryDate||'',
        qty:row.qty,unitCost:0,cost:0});
    }
    if(qty(returnQty+priorQty)>confirmedQty)throw Error('退貨追溯總量超過該筆出貨已確認送達量');
    return {returnQty,allocations};
  }

  return {
    STOCK_POLICIES,
    stockPolicyFor,
    planningSettings,
    normalizeStock,
    stockIsEmpty,
    isListArchived,
    sortLotsForIssue,
    allocateLots,
    reconcileStockLots,
    quantityAdjustmentLots,
    manualAdjustmentLots,
    operationalLotRows,
    reverseLotAllocations,
    planLotRestoration,
    allocationsAfterReversal,
    availableReturnAllocations,
    planExplicitShipmentReturn
  };
});

