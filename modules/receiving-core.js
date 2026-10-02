(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinReceiving=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const STATUSES=Object.freeze({
    ORDERED:'ORDERED',
    PARTIAL_RECEIPT:'PARTIAL_RECEIPT',
    RECEIVED:'RECEIVED',
    CANCELLED:'CANCELLED'
  });

  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function normalizeSupply(record={}){
    const qty=n(record.qty);
    const receivedQty=Math.min(qty,n(record.receivedQty));
    const cancelled=String(record.status||'').toUpperCase()===STATUSES.CANCELLED;
    const remainingQty=cancelled?0:Math.max(0,qty-receivedQty);
    const status=cancelled
      ? STATUSES.CANCELLED
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

  function applyReceipt(record={},requestedQty=0){
    const current=normalizeSupply(record);
    if(current.status===STATUSES.CANCELLED){
      return {appliedQty:0,incomingReleaseQty:0,record:current};
    }
    const appliedQty=Math.min(n(requestedQty),current.remainingQty);
    const incomingReleaseQty=Math.min(appliedQty,current.incomingRegisteredQty);
    const next=normalizeSupply({
      ...current,
      receivedQty:current.receivedQty+appliedQty,
      incomingRegisteredQty:Math.max(0,current.incomingRegisteredQty-incomingReleaseQty)
    });
    return {appliedQty,incomingReleaseQty,record:next};
  }

  function applyReceiptToOrderItem(item={},receiptQty=0){
    const orderedQty=n(item.orderedQty??item.qty);
    const grossDeliveredQty=n(item.deliveredQty);
    const returnedQty=Math.min(grossDeliveredQty,n(item.returnedQty));
    const effectiveDeliveredQty=Math.min(orderedQty,Math.max(0,grossDeliveredQty-returnedQty));
    const outstandingQty=Math.max(0,orderedQty-effectiveDeliveredQty);
    const currentReservedQty=Math.min(outstandingQty,n(item.reservedQty));
    const appliedQty=n(receiptQty);
    const reservedDelta=Math.min(appliedQty,Math.max(0,outstandingQty-currentReservedQty));
    const reservedQty=currentReservedQty+reservedDelta;
    const shortageQty=Math.max(0,outstandingQty-reservedQty);
    const receivedQty=n(item.receivedQty)+appliedQty;
    return {
      appliedQty,
      reservedDelta,
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
      qty:receiptQty,
      cumulativeReceivedQty,
      fulfillmentType:String(event.fulfillmentType||supply.fulfillmentType||'WAREHOUSE'),
      warehouseId:String(event.warehouseId??supply.warehouseId??''),
      receiptDate:String(event.receiptDate||''),
      createdAt:String(event.createdAt||''),
      createdBy:String(event.createdBy||''),
      ...(event.extra&&typeof event.extra==='object'?event.extra:{})
    };
  }

  return {STATUSES,normalizeSupply,applyReceipt,applyReceiptToOrderItem,pendingQty,buildReceiptSnapshot};
});