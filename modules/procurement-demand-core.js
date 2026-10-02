(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinProcurementDemand=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const SOURCES=Object.freeze({
    SALES_ORDER:'SALES_ORDER',
    STOCK_REPLENISHMENT:'STOCK_REPLENISHMENT'
  });
  const STATUSES=Object.freeze({
    PENDING:'PENDING',
    PARTIALLY_ORDERED:'PARTIALLY_ORDERED',
    ORDERED:'ORDERED',
    PARTIALLY_RECEIVED:'PARTIALLY_RECEIVED',
    RECEIVED:'RECEIVED',
    CANCELLED:'CANCELLED'
  });

  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function demandIdForSource(record={}){
    const sourceType=Object.values(SOURCES).includes(record.sourceType)?record.sourceType:SOURCES.SALES_ORDER;
    const sourceId=String(record.sourceId||'').trim();
    const sourceItemId=String(record.sourceItemId||'').trim();
    if(sourceType===SOURCES.SALES_ORDER){
      return sourceId&&sourceItemId?`${sourceType}:${sourceId}:${sourceItemId}`:'';
    }
    return sourceId?`${sourceType}:${sourceId}`:'';
  }

  function normalizeDemand(record={}){
    const requestedQty=n(record.requestedQty??record.qty);
    const orderedQty=n(record.orderedQty);
    const receivedQty=Math.min(orderedQty,n(record.receivedQty));
    const cancelled=record.cancelled===true||String(record.status||'').toUpperCase()===STATUSES.CANCELLED;
    // Cancelling/stopping a Material Request prevents further ordering, but any
    // supplier commitment already placed still has to be received/closed.
    const remainingToOrderQty=cancelled?0:Math.max(0,requestedQty-orderedQty);
    const remainingToReceiveQty=Math.max(0,orderedQty-receivedQty);
    let status=STATUSES.PENDING;
    if(cancelled)status=STATUSES.CANCELLED;
    else if(requestedQty>0&&receivedQty>=requestedQty)status=STATUSES.RECEIVED;
    else if(receivedQty>0)status=STATUSES.PARTIALLY_RECEIVED;
    else if(requestedQty>0&&orderedQty>=requestedQty)status=STATUSES.ORDERED;
    else if(orderedQty>0)status=STATUSES.PARTIALLY_ORDERED;

    const perOrdered=requestedQty>0?Math.min(100,(orderedQty/requestedQty)*100):0;
    const perReceived=requestedQty>0?Math.min(100,(receivedQty/requestedQty)*100):0;
    const sourceType=Object.values(SOURCES).includes(record.sourceType)?record.sourceType:SOURCES.SALES_ORDER;
    const sourceId=String(record.sourceId||'');
    const sourceItemId=String(record.sourceItemId||'');
    return {
      ...record,
      sourceType,
      sourceId,
      sourceItemId,
      demandId:String(record.demandId||demandIdForSource({sourceType,sourceId,sourceItemId})),
      scheduleDate:String(record.scheduleDate||record.expectedDate||record.needByDate||''),
      requestedQty,
      orderedQty,
      receivedQty,
      remainingToOrderQty,
      remainingToReceiveQty,
      perOrdered,
      perReceived,
      status
    };
  }

  function fromSalesOrder(input={}){
    const directShip=String(input.fulfillmentType||'WAREHOUSE').toUpperCase()==='DIRECT_SHIP';
    const receivedQty=n(input.receivedQty);
    const explicitOrdered=n(input.supplyOrderedQty);
    const inferredOrdered=receivedQty+n(input.inTransitQty);
    const orderedQty=Math.max(explicitOrdered,inferredOrdered);
    if(directShip){
      return normalizeDemand({
        ...input,
        sourceType:SOURCES.SALES_ORDER,
        // ERP Material Request semantics are cumulative: replacements after a
        // return may legitimately raise total demand above the original order.
        requestedQty:Math.max(n(input.requiredSupplyQty),orderedQty),
        orderedQty,
        receivedQty
      });
    }
    return normalizeDemand({
      ...input,
      sourceType:SOURCES.SALES_ORDER,
      // For warehouse fulfillment, received supply is already consumed history
      // while shortageQty is the live uncovered requirement. Together they form
      // the cumulative procurement need. Never let requestedQty fall below
      // quantities already committed to suppliers.
      requestedQty:Math.max(orderedQty,receivedQty+n(input.shortageQty)),
      orderedQty,
      receivedQty
    });
  }

  function fromStockReplenishment(input={}){
    const safetyStock=n(input.safetyStock);
    const availableQty=n(input.availableQty??input.available);
    const incomingQty=n(input.incomingQty??input.incoming);
    return normalizeDemand({
      ...input,
      sourceType:SOURCES.STOCK_REPLENISHMENT,
      requestedQty:Math.max(0,safetyStock-availableQty),
      orderedQty:incomingQty,
      receivedQty:0
    });
  }

  function statusLabel(status){
    switch(status){
      case STATUSES.PARTIALLY_ORDERED:return '部分已訂購';
      case STATUSES.ORDERED:return '已訂購待到貨';
      case STATUSES.PARTIALLY_RECEIVED:return '部分到貨';
      case STATUSES.RECEIVED:return '已到貨';
      case STATUSES.CANCELLED:return '已取消';
      default:return '待採購';
    }
  }

  // Material Request-like persistent record. Quantities are the durable facts;
  // status/percent/remaining fields are projections refreshed by normalizeDemand().
  function demandDocument(record={},meta={}){
    const demand=normalizeDemand(record);
    if(!demand.demandId)throw new Error('採購需求缺少 demandId');
    const now=String(meta.updatedAt||record.updatedAt||meta.createdAt||record.createdAt||'');
    return {
      demandId:demand.demandId,
      sourceType:demand.sourceType,
      sourceId:demand.sourceId,
      sourceItemId:demand.sourceItemId,
      productId:String(record.productId||''),
      productKey:String(record.productKey||''),
      itemCode:String(record.itemCode||''),
      itemName:String(record.itemName||''),
      brand:String(record.brand||''),
      fulfillmentType:String(record.fulfillmentType||'WAREHOUSE'),
      warehouseId:String(record.warehouseId||''),
      ownerUid:String(record.ownerUid||''),
      salesCode:String(record.salesCode||''),
      salesName:String(record.salesName||''),
      requestedQty:demand.requestedQty,
      orderedQty:demand.orderedQty,
      receivedQty:demand.receivedQty,
      remainingToOrderQty:demand.remainingToOrderQty,
      remainingToReceiveQty:demand.remainingToReceiveQty,
      perOrdered:demand.perOrdered,
      perReceived:demand.perReceived,
      status:demand.status,
      scheduleDate:demand.scheduleDate,
      createdAt:String(record.createdAt||meta.createdAt||now),
      updatedAt:now
    };
  }

  function applyOrder(record={},qty=0){
    const current=normalizeDemand(record);
    const appliedQty=Math.min(n(qty),current.remainingToOrderQty);
    const demand=normalizeDemand({...current,orderedQty:current.orderedQty+appliedQty});
    return {appliedQty,demand};
  }

  function applyReceipt(record={},qty=0){
    const current=normalizeDemand(record);
    const appliedQty=Math.min(n(qty),current.remainingToReceiveQty);
    const demand=normalizeDemand({...current,receivedQty:current.receivedQty+appliedQty});
    return {appliedQty,demand};
  }

  function reconcileRequestedQty(record={},requestedQty=0){
    return normalizeDemand({...record,requestedQty:n(requestedQty)});
  }

  // ERPNext status-updater equivalent: demand progress is derived from linked supplier commitments.
  // A cancelled supply contributes only the quantity that was already physically received.
  function supplyContribution(record={}){
    const qty=n(record.qty);
    const receivedQty=Math.min(qty,n(record.receivedQty));
    const terminal=['CANCELLED','CLOSED'].includes(String(record.status||'').toUpperCase());
    return {
      orderedQty:terminal?receivedQty:qty,
      receivedQty
    };
  }

  function reconcileLinkedSupplies(record={},supplies=[]){
    const current=normalizeDemand(record);
    const demandId=String(current.demandId||'');
    let orderedQty=0,receivedQty=0;
    for(const supply of supplies||[]){
      if(demandId&&String(supply?.demandId||'')!==demandId)continue;
      const contribution=supplyContribution(supply||{});
      orderedQty+=contribution.orderedQty;
      receivedQty+=contribution.receivedQty;
    }
    return normalizeDemand({
      ...current,
      orderedQty,
      receivedQty:Math.min(orderedQty,receivedQty)
    });
  }

  function applySupplyCancellation(record={},supply={}){
    const current=normalizeDemand(record);
    const activeSupply={...supply,status:['CANCELLED','CLOSED'].includes(String(supply.status||'').toUpperCase())?'ORDERED':supply.status};
    const before=supplyContribution(activeSupply);
    const after=supplyContribution({...supply,status:'CANCELLED'});
    const releasedQty=Math.max(0,before.orderedQty-after.orderedQty);
    const orderedQty=Math.max(current.receivedQty,current.orderedQty-releasedQty);
    return {
      releasedQty,
      demand:normalizeDemand({...current,orderedQty})
    };
  }

  function demandDate(value){
    const raw=String(value||'').slice(0,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(raw))return '';
    const [year,month,day]=raw.split('-').map(Number);
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day?raw:'';
  }

  function deliveryPlanRisk(record={},supplies=[]){
    const demand=normalizeDemand(record);
    const requiredDate=demandDate(demand.scheduleDate);
    const neededQty=n(demand.remainingToReceiveQty);
    if(!(neededQty>0))return {
      status:'complete',requiredDate,plannedDate:'',delayDays:0,
      neededQty:0,coveredQty:0,missingQty:0
    };
    if(!requiredDate)return {
      status:'no_required_date',requiredDate:'',plannedDate:'',delayDays:0,
      neededQty,coveredQty:0,missingQty:0
    };

    const demandId=String(demand.demandId||'');
    const rows=(supplies||[]).map(supply=>{
      if(demandId&&String(supply?.demandId||'')&&String(supply.demandId)!==demandId)return null;
      const qty=n(supply?.qty);
      const received=Math.min(qty,n(supply?.receivedQty));
      const terminal=['CANCELLED','CLOSED'].includes(String(supply?.status||'').toUpperCase());
      const remaining=terminal?0:Math.max(0,qty-received);
      if(!(remaining>0))return null;
      return {
        remaining,
        expectedDate:demandDate(supply?.expectedDate||supply?.scheduleDate||'')
      };
    }).filter(Boolean);

    const coveredQty=rows.reduce((sum,row)=>sum+row.remaining,0);
    if(coveredQty+1e-9<neededQty)return {
      status:'uncovered',requiredDate,plannedDate:'',delayDays:0,
      neededQty,coveredQty,missingQty:Math.max(0,neededQty-coveredQty)
    };

    rows.sort((a,b)=>{
      if(!a.expectedDate&&!b.expectedDate)return 0;
      if(!a.expectedDate)return 1;
      if(!b.expectedDate)return -1;
      return a.expectedDate.localeCompare(b.expectedDate);
    });
    let cumulative=0,plannedDate='';
    for(const row of rows){
      cumulative+=row.remaining;
      if(cumulative+1e-9>=neededQty){
        plannedDate=row.expectedDate;
        break;
      }
    }
    if(!plannedDate)return {
      status:'unscheduled',requiredDate,plannedDate:'',delayDays:0,
      neededQty,coveredQty,missingQty:0
    };

    const requiredTime=Date.parse(requiredDate+'T00:00:00Z');
    const plannedTime=Date.parse(plannedDate+'T00:00:00Z');
    const delayDays=Math.max(0,Math.round((plannedTime-requiredTime)/86400000));
    return {
      status:plannedDate>requiredDate?'at_risk':'on_time',
      requiredDate,plannedDate,delayDays,
      neededQty,coveredQty,missingQty:0
    };
  }

  function cancelDemand(record={}){
    const current=normalizeDemand(record);
    return normalizeDemand({...current,cancelled:true,status:STATUSES.CANCELLED});
  }

  function reopenDemand(record={},requestedQty){
    const current=normalizeDemand(record);
    const nextRequested=requestedQty===undefined?current.requestedQty:n(requestedQty);
    return normalizeDemand({
      ...current,
      cancelled:false,
      status:'',
      requestedQty:Math.max(nextRequested,current.orderedQty)
    });
  }

  return {
    SOURCES,STATUSES,demandIdForSource,normalizeDemand,fromSalesOrder,fromStockReplenishment,statusLabel,
    demandDocument,applyOrder,applyReceipt,supplyContribution,reconcileLinkedSupplies,applySupplyCancellation,
    deliveryPlanRisk,reconcileRequestedQty,cancelDemand,reopenDemand
  };
});