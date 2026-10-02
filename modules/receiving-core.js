(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinReceiving=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const STATUSES=Object.freeze({
    ORDERED:'ORDERED',
    PARTIAL_RECEIPT:'PARTIAL_RECEIPT',
    RECEIVED:'RECEIVED',
    CLOSED:'CLOSED',
    CANCELLED:'CANCELLED'
  });

  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function normalizeSupply(record={}){
    const qty=n(record.qty);
    const receivedQty=Math.min(qty,n(record.receivedQty));
    const rawStatus=String(record.status||'').toUpperCase();
    const terminalStatus=[STATUSES.CANCELLED,STATUSES.CLOSED].includes(rawStatus)?rawStatus:'';
    const remainingQty=terminalStatus?0:Math.max(0,qty-receivedQty);
    const status=terminalStatus
      ? terminalStatus
      : qty>0&&receivedQty>=qty
        ? STATUSES.RECEIVED
        : receivedQty>0
          ? STATUSES.PARTIAL_RECEIPT
          : STATUSES.ORDERED;
    return {
      ...record,
      qty,
      receivedQty,
      remainingQty,
      incomingRegisteredQty:n(record.incomingRegisteredQty),
      status
    };
  }

  function demandAllocation(record={}){
    const current=normalizeSupply(record);
    const explicit=record.demandAllocatedQty!==undefined&&record.demandAllocatedQty!==null&&record.demandAllocatedQty!=='';
    const demandAllocatedQty=explicit?Math.min(current.qty,n(record.demandAllocatedQty)):current.qty;
    return {
      demandAllocatedQty,
      excessStockQty:Math.max(0,current.qty-demandAllocatedQty)
    };
  }

  function receiptAllocation(record={},requestedQty=0){
    const current=normalizeSupply(record);
    const appliedQty=[STATUSES.CANCELLED,STATUSES.CLOSED].includes(current.status)
      ? 0
      : Math.min(n(requestedQty),current.remainingQty);
    const allocation=demandAllocation(current);
    const demandReceivedBefore=Math.min(allocation.demandAllocatedQty,current.receivedQty);
    const demandReceivedAfter=Math.min(allocation.demandAllocatedQty,current.receivedQty+appliedQty);
    const demandReceiptQty=Math.max(0,demandReceivedAfter-demandReceivedBefore);
    return {
      ...allocation,
      appliedQty,
      demandReceiptQty,
      excessReceiptQty:Math.max(0,appliedQty-demandReceiptQty)
    };
  }

  function applyReceipt(record={},requestedQty=0){
    const current=normalizeSupply(record);
    const allocation=receiptAllocation(current,requestedQty);
    if([STATUSES.CANCELLED,STATUSES.CLOSED].includes(current.status)){
      return {...allocation,incomingReleaseQty:0,record:current};
    }
    const appliedQty=allocation.appliedQty;
    const incomingReleaseQty=Math.min(appliedQty,current.incomingRegisteredQty);
    const next=normalizeSupply({
      ...current,
      receivedQty:current.receivedQty+appliedQty,
      incomingRegisteredQty:Math.max(0,current.incomingRegisteredQty-incomingReleaseQty)
    });
    return {...allocation,incomingReleaseQty,record:next};
  }

  function applyReceiptToOrderItem(item={},receiptQty=0){
    const orderedQty=n(item.orderedQty??item.qty);
    const grossDeliveredQty=n(item.deliveredQty);
    const returnedQty=Math.min(grossDeliveredQty,n(item.returnedQty));
    const effectiveDeliveredQty=Math.min(orderedQty,Math.max(0,grossDeliveredQty-returnedQty));
    const outstandingQty=Math.max(0,orderedQty-effectiveDeliveredQty);
    const currentReservedQty=Math.min(outstandingQty,n(item.reservedQty));
    // receiptQty here is the portion of this supplier receipt allocated to the
    // source sales demand, not necessarily the full physical supplier receipt.
    const appliedQty=n(receiptQty);
    const reservedDelta=Math.min(appliedQty,Math.max(0,outstandingQty-currentReservedQty));
    const reservedQty=currentReservedQty+reservedDelta;
    const shortageQty=Math.max(0,outstandingQty-reservedQty);
    const receivedQty=n(item.receivedQty)+appliedQty;
    return {
      appliedQty,
      reservedDelta,
      unreservedReceiptQty:Math.max(0,appliedQty-reservedDelta),
      item:{
        ...item,
        qty:orderedQty,
        orderedQty,
        receivedQty,
        reservedQty,
        shortageQty
      }
    };
  }

  function pendingQty(record={}){
    return normalizeSupply(record).remainingQty;
  }

  // Purchase Receipt snapshot: an immutable receipt event should remain understandable
  // even if the supplier order or customer order changes later. Cost is intentionally
  // excluded; protected inventoryLotCosts remains the source for cost accounting.
  function buildReceiptSnapshot(supply={},event={}){
    const receiptQty=n(event.qty);
    const cumulativeReceivedQty=n(event.cumulativeReceivedQty??supply.receivedQty);
    return {
      receiptId:String(event.receiptId||event.operationId||''),
      operationId:String(event.operationId||event.receiptId||''),
      supplyOrderId:String(event.supplyOrderId||supply.id||''),
      documentSourceType:'SUPPLY_ORDER',
      demandId:String(event.demandId||supply.demandId||''),
      method:String(supply.method||supply.type||''),
      demandSourceType:String(supply.sourceType||''),
      sourceId:String(supply.sourceId||supply.orderId||''),
      sourceItemId:String(supply.sourceItemId||supply.itemId||''),
      orderId:String(supply.orderId||supply.sourceId||''),
      itemId:String(supply.itemId||supply.sourceItemId||''),
      purchaseDocumentId:String(supply.purchaseDocumentId||''),
      purchaseDocumentNo:String(supply.purchaseDocumentNo||''),
      supplyInternalNo:String(supply.internalNo||''),
      supplyOrderDate:String(supply.orderDate||''),
      expectedDate:String(supply.expectedDate||supply.scheduleDate||''),
      scheduleDate:String(supply.scheduleDate||supply.expectedDate||''),
      supplyCreatedAt:String(supply.createdAt||''),
      supplierId:String(supply.supplierId||''),
      supplier:String(supply.supplier||supply.supplierName||''),
      productId:String(supply.productId||''),
      productKey:String(event.productKey??supply.productKey??''),
      itemCode:String(supply.itemCode||''),
      itemName:String(supply.itemName||''),
      brand:String(supply.brand||''),
      ownerUid:String(supply.ownerUid||''),
      salesCode:String(supply.salesCode||''),
      orderedQty:n(supply.qty),
      demandAllocatedQty:demandAllocation(supply).demandAllocatedQty,
      excessStockQty:demandAllocation(supply).excessStockQty,
      qty:receiptQty,
      demandReceiptQty:n(event.demandReceiptQty),
      excessReceiptQty:n(event.excessReceiptQty),
      cumulativeReceivedQty,
      fulfillmentType:String(event.fulfillmentType||supply.fulfillmentType||'WAREHOUSE'),
      warehouseId:String(event.warehouseId??supply.warehouseId??''),
      receiptDate:String(event.receiptDate||''),
      createdAt:String(event.createdAt||''),
      createdBy:String(event.createdBy||''),
      ...(event.extra&&typeof event.extra==='object'?event.extra:{})
    };
  }

  return {STATUSES,normalizeSupply,demandAllocation,receiptAllocation,applyReceipt,applyReceiptToOrderItem,pendingQty,buildReceiptSnapshot};
});