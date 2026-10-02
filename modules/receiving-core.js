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

  return {STATUSES,normalizeSupply,applyReceipt,applyReceiptToOrderItem,pendingQty};
});
