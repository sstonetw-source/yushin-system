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
    const remainingToOrderQty=cancelled?0:Math.max(0,requestedQty-orderedQty);
    const remainingToReceiveQty=cancelled?0:Math.max(0,orderedQty-receivedQty);
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
    if(directShip){
      return normalizeDemand({
        ...input,
        sourceType:SOURCES.SALES_ORDER,
        requestedQty:n(input.requiredSupplyQty),
        orderedQty:n(input.supplyOrderedQty),
        receivedQty:n(input.receivedQty)
      });
    }
    return normalizeDemand({
      ...input,
      sourceType:SOURCES.SALES_ORDER,
      // Warehouse shortage is the live purchase demand. Open in-transit supply
      // is already part of that shortage and must not be added a second time.
      requestedQty:n(input.shortageQty),
      orderedQty:n(input.inTransitQty),
      receivedQty:0
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

  return {
    SOURCES,STATUSES,demandIdForSource,normalizeDemand,fromSalesOrder,fromStockReplenishment,statusLabel,
    demandDocument,applyOrder,applyReceipt,reconcileRequestedQty
  };
});