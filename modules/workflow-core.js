(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinWorkflow=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const RELEASE_MODES=Object.freeze({
    STANDARD:'STANDARD',
    ADVANCE_TO_CUSTOMER:'ADVANCE_TO_CUSTOMER'
  });
  const ADVANCE_STATUSES=Object.freeze({
    REQUESTED:'REQUESTED',
    APPROVED:'APPROVED',
    REJECTED:'REJECTED',
    CLOSED:'CLOSED'
  });
  const ITEM_WORK_CATEGORIES=Object.freeze({
    ORDERING:'ordering',
    ARRIVAL:'arrival',
    DELIVERY:'delivery',
    BILLING:'billing',
    COMPLETE:'complete',
    CLOSED:'closed'
  });

  function n(value){
    const number=Number(value);
    return Number.isFinite(number)?Math.max(0,number):0;
  }

  function hasNumber(value){
    return value!==null&&value!==undefined&&value!==''&&Number.isFinite(Number(value));
  }

  // ERP-style projection: one authoritative calculation for order demand,
  // reservation, procurement, receipt and fulfillment state.
  function projectItem(input={}){
    const orderedQty=n(input.orderedQty??input.qty);
    const fulfillmentType=input.fulfillmentType||'WAREHOUSE';
    const returnedQty=n(input.returnedQty);
    // itemWorkCategory 的 deliveredQty 歷來代表「退貨扣除後的有效送貨量」。
    // app 若同時掌握 gross/effective 會明確傳 effectiveDeliveredQty；
    // 這裡不可在 fallback 再扣一次 returnedQty，否則退貨補送完成仍會被判成未完成。
    const hasExplicitEffective=hasNumber(input.effectiveDeliveredQty);
    const effectiveDeliveredQty=hasExplicitEffective
      ? Math.min(orderedQty,n(input.effectiveDeliveredQty))
      : Math.min(orderedQty,n(input.deliveredQty));
    const grossDeliveredQty=hasNumber(input.grossDeliveredQty)
      ? n(input.grossDeliveredQty)
      : hasExplicitEffective
        ? n(input.deliveredQty)
        : n(input.deliveredQty)+returnedQty;
    const outstandingQty=Math.max(0,orderedQty-effectiveDeliveredQty);

    let reservedQty=0;
    let shortageQty=0;
    if(hasNumber(input.reservedQty)){
      reservedQty=Math.min(outstandingQty,n(input.reservedQty));
      shortageQty=Math.max(0,outstandingQty-reservedQty);
    }else if(hasNumber(input.shortageQty)){
      shortageQty=Math.min(outstandingQty,n(input.shortageQty));
      reservedQty=Math.max(0,outstandingQty-shortageQty);
    }

    const supplyOrderedQty=n(input.supplyOrderedQty);
    const receivedQty=n(input.receivedQty);
    const inTransitQty=Math.max(0,supplyOrderedQty-receivedQty);
    const requiredSupplyQty=fulfillmentType==='DIRECT_SHIP'
      ? orderedQty+returnedQty
      : shortageQty;
    const remainingToOrderQty=fulfillmentType==='DIRECT_SHIP'
      ? Math.max(0,requiredSupplyQty-supplyOrderedQty)
      : Math.max(0,shortageQty-inTransitQty);

    let workCategory;
    if(input.lifecycleStatus&&input.lifecycleStatus!=='normal'){
      workCategory=ITEM_WORK_CATEGORIES.CLOSED;
    }else if(orderedQty>0&&effectiveDeliveredQty>=orderedQty){
      workCategory=input.isBilled?ITEM_WORK_CATEGORIES.COMPLETE:ITEM_WORK_CATEGORIES.BILLING;
    }else if(fulfillmentType==='DIRECT_SHIP'){
      if(remainingToOrderQty>0)workCategory=ITEM_WORK_CATEGORIES.ORDERING;
      else if(receivedQty<requiredSupplyQty)workCategory=ITEM_WORK_CATEGORIES.ARRIVAL;
      else workCategory=ITEM_WORK_CATEGORIES.DELIVERY;
    }else{
      if(remainingToOrderQty>0)workCategory=ITEM_WORK_CATEGORIES.ORDERING;
      else if(shortageQty>0||inTransitQty>0)workCategory=ITEM_WORK_CATEGORIES.ARRIVAL;
      else workCategory=ITEM_WORK_CATEGORIES.DELIVERY;
    }

    return {
      orderedQty,
      fulfillmentType,
      grossDeliveredQty,
      returnedQty,
      effectiveDeliveredQty,
      outstandingQty,
      reservedQty,
      shortageQty,
      supplyOrderedQty,
      receivedQty,
      inTransitQty,
      requiredSupplyQty,
      remainingToOrderQty,
      workCategory
    };
  }

  function procurementQuantities(input={}){
    const p=projectItem(input);
    return {
      requiredSupplyQty:p.requiredSupplyQty,
      supplyOrderedQty:p.supplyOrderedQty,
      receivedQty:p.receivedQty,
      inTransitQty:p.inTransitQty,
      remainingToOrderQty:p.remainingToOrderQty
    };
  }

  function itemWorkCategory(input={}){
    return projectItem(input).workCategory;
  }

  function normalizeCommercialRelease(order={}){
    const commercialReleaseMode=Object.values(RELEASE_MODES).includes(order.commercialReleaseMode)?order.commercialReleaseMode:RELEASE_MODES.STANDARD;
    const advanceDelivery={...(order.advanceDelivery||{})};
    return {...order,commercialReleaseMode,advanceDelivery};
  }

  function validateAdvanceRequest(order={}){
    const normalized=normalizeCommercialRelease(order),errors=[];
    if(normalized.commercialReleaseMode!==RELEASE_MODES.ADVANCE_TO_CUSTOMER)return {valid:true,errors,order:normalized};
    const advance=normalized.advanceDelivery;
    if(!String(advance.reason||'').trim())errors.push('reason');
    if(!String(advance.promisedDocumentDate||'').trim())errors.push('promisedDocumentDate');
    if(!String(advance.requestedByUid||'').trim())errors.push('requestedByUid');
    if(!Object.values(ADVANCE_STATUSES).includes(advance.status))errors.push('status');
    return {valid:errors.length===0,errors,order:normalized};
  }

  function canDeliver(order={}){
    const normalized=normalizeCommercialRelease(order);
    if(normalized.commercialReleaseMode===RELEASE_MODES.STANDARD)return true;
    const advance=normalized.advanceDelivery;
    return [ADVANCE_STATUSES.APPROVED,ADVANCE_STATUSES.CLOSED].includes(advance.status)&&!!advance.approvedByUid&&!!advance.approvedAt;
  }

  function canBill(order={}){
    const normalized=normalizeCommercialRelease(order);
    if(normalized.commercialReleaseMode===RELEASE_MODES.STANDARD)return true;
    const advance=normalized.advanceDelivery;
    return canDeliver(normalized)
      && advance.status===ADVANCE_STATUSES.CLOSED
      && !!String(advance.customerOrderReference||'').trim()
      && !!advance.completedAt;
  }

  return {
    RELEASE_MODES,ADVANCE_STATUSES,ITEM_WORK_CATEGORIES,
    projectItem,procurementQuantities,itemWorkCategory,
    normalizeCommercialRelease,validateAdvanceRequest,canDeliver,canBill
  };
});