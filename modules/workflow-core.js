(function(root,factory){
  const fulfillment=typeof module==='object'&&module.exports?require('./fulfillment-core.js'):root?.YushinFulfillment;
  const api=factory(fulfillment);
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinWorkflow=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(fulfillment){
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
    const serviceItem=String(input.productType||'').trim().toUpperCase()==='SERVICE';
    const returnedQty=n(input.returnedQty);
    // itemWorkCategory 的 deliveredQty 歷來代表「退貨扣除後的有效送貨量」。
    // app 若同時掌握 gross/effective 會明確傳 effectiveDeliveredQty；
    // 這裡不可在 fallback 再扣一次 returnedQty，否則退貨補送完成仍會被判成未完成。
    const hasExplicitEffective=hasNumber(input.effectiveDeliveredQty);
    const grossDeliveredQty=hasNumber(input.grossDeliveredQty)
      ? n(input.grossDeliveredQty)
      : hasExplicitEffective
        ? n(input.deliveredQty)
        : n(input.deliveredQty)+returnedQty;
    // Explicit cumulative input uses the same projection as dispatch. Legacy
    // deliveredQty-only input remains effective quantity at this boundary.
    const delivery=fulfillment.deliveryQuantities({deliveredQty:grossDeliveredQty,returnedQty});
    // SERVICE fulfillment needs a separate, verified service-completion event.
    // Legacy product deliveryRecords, their cached totals, and billing flags
    // must never close a customer service order (including mixed orders).
    // Until that writer/ledger is integrated, pending service work stays open.
    const effectiveDeliveredQty=serviceItem?0:Math.min(orderedQty,hasExplicitEffective
      ? n(input.effectiveDeliveredQty)
      : hasNumber(input.grossDeliveredQty)?delivery.effectiveDeliveredQty:n(input.deliveredQty));
    const outstandingQty=Math.max(0,orderedQty-effectiveDeliveredQty);

    const shipmentContext=input.warehouseShipmentContext;
    const shipment=shipmentContext===undefined?null:fulfillment.projectShipmentReturns({
      ...shipmentContext,orderedQty:input.orderedQty??input.qty
    });
    if(shipment&&(fulfillmentType!=='WAREHOUSE'||shipment.replacementQty!==0||returnedQty!==shipment.returnedQty
      ||grossDeliveredQty!==shipment.confirmedQty||effectiveDeliveredQty!==shipment.effectiveDeliveredQty
      ||(input.warehouseShippedQty!==undefined&&input.warehouseShippedQty!==shipment.shippedQty)))
      throw Error('倉庫出貨與履約投影不一致，或退貨流程尚未整合。');
    // Customer acknowledgement and remaining physical shipment are separate.
    const stockOutstandingQty=shipment?shipment.outstandingQty:outstandingQty;
    let reservedQty=0;
    let shortageQty=0;
    if(!serviceItem&&hasNumber(input.reservedQty)){
      reservedQty=Math.min(stockOutstandingQty,n(input.reservedQty));
      shortageQty=Math.max(0,stockOutstandingQty-reservedQty);
    }else if(!serviceItem&&hasNumber(input.shortageQty)){
      shortageQty=Math.min(stockOutstandingQty,n(input.shortageQty));
      reservedQty=Math.max(0,stockOutstandingQty-shortageQty);
    }
    if(shipment&&((input.reservedQty!==undefined&&(!Number.isSafeInteger(input.reservedQty)||input.reservedQty!==reservedQty))
      ||(!hasNumber(input.reservedQty)&&input.shortageQty!==undefined&&(!Number.isSafeInteger(input.shortageQty)||input.shortageQty!==shortageQty))))
      throw Error('倉庫尚未出貨量與預留或缺口不一致。');

    const supplyOrderedQty=n(input.supplyOrderedQty);
    const receivedQty=n(input.receivedQty);
    if(serviceItem&&(supplyOrderedQty>0||receivedQty>0||n(input.reservedQty)>0))
      throw Error('服務品項已有供應或實貨預留，須先稽核，不能偽裝為一般實貨需求。');
    const inTransitQty=serviceItem?0:Math.max(0,supplyOrderedQty-receivedQty);
    const requiredSupplyQty=serviceItem?0:fulfillmentType==='DIRECT_SHIP'
      ? orderedQty+returnedQty
      : shortageQty;
    const remainingToOrderQty=serviceItem?0:fulfillmentType==='DIRECT_SHIP'
      ? Math.max(0,requiredSupplyQty-supplyOrderedQty)
      : Math.max(0,shortageQty-inTransitQty);

    let workCategory;
    if(input.lifecycleStatus&&input.lifecycleStatus!=='normal'){
      workCategory=ITEM_WORK_CATEGORIES.CLOSED;
    }else if(orderedQty>0&&effectiveDeliveredQty>=orderedQty){
      workCategory=input.isBilled?ITEM_WORK_CATEGORIES.COMPLETE:ITEM_WORK_CATEGORIES.BILLING;
    }else if(serviceItem){
      // A service awaits its own completion evidence, not warehouse procurement.
      workCategory=ITEM_WORK_CATEGORIES.DELIVERY;
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
      ...(shipment?{stockOutstandingQty,pendingDeliveryQty:shipment.pendingDeliveryQty}:{}),
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
