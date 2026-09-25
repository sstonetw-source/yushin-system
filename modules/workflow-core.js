(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.YushinWorkflow=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  const SUPPLY_SOURCE_TYPES=Object.freeze({
    STOCK:'STOCK',
    STANDARD_PURCHASE:'STANDARD_PURCHASE',
    PEER_TRANSFER:'PEER_TRANSFER'
  });
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
  function n(value){const number=Number(value);return Number.isFinite(number)?Math.max(0,number):0;}
  const ITEM_WORK_CATEGORIES=Object.freeze({
    ORDERING:'ordering',
    ARRIVAL:'arrival',
    DELIVERY:'delivery',
    BILLING:'billing',
    COMPLETE:'complete',
    CLOSED:'closed'
  });
  function itemWorkCategory(input={}){
    if(input.lifecycleStatus&&input.lifecycleStatus!=='normal')return ITEM_WORK_CATEGORIES.CLOSED;
    if(n(input.returnedQty)>0&&n(input.effectiveDeliveredQty)<=0)return ITEM_WORK_CATEGORIES.CLOSED;
    const qty=n(input.orderedQty??input.qty);
    const delivered=n(input.deliveredQty);
    if(qty>0&&delivered>=qty)return input.isBilled?ITEM_WORK_CATEGORIES.COMPLETE:ITEM_WORK_CATEGORIES.BILLING;
    const fulfillmentType=input.fulfillmentType||'WAREHOUSE';
    const required=fulfillmentType==='DIRECT_SHIP'
      ? qty
      : n(input.purchaseRequiredQty??input.inventoryShortageQty);
    const ordered=Math.max(n(input.purchaseOrderedQty),n(input.supplyOrderedQty));
    const received=Math.max(n(input.receivedQty),n(input.purchaseReceivedQty),n(input.supplyReceivedQty));
    if(required>ordered)return ITEM_WORK_CATEGORIES.ORDERING;
    if(required>0&&received<required)return ITEM_WORK_CATEGORIES.ARRIVAL;
    return ITEM_WORK_CATEGORIES.DELIVERY;
  }
  function normalizeSupplyAllocations(item={}){
    const orderedQty=n(item.orderedQty??item.qty);
    const source=Array.isArray(item.supplyAllocations)?item.supplyAllocations:[];
    const supplyAllocations=source.map(row=>({
      ...row,
      type:Object.values(SUPPLY_SOURCE_TYPES).includes(row?.type)?row.type:SUPPLY_SOURCE_TYPES.STANDARD_PURCHASE,
      qty:n(row?.qty)
    })).filter(row=>row.qty>0);
    return {orderedQty,supplyAllocations,allocatedQty:supplyAllocations.reduce((sum,row)=>sum+row.qty,0)};
  }
  function validateSupplyAllocations(item={}){
    const normalized=normalizeSupplyAllocations(item),errors=[];
    if(normalized.supplyAllocations.some(row=>row.type===SUPPLY_SOURCE_TYPES.STOCK&&(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'))errors.push('directShipStock');
    if(normalized.allocatedQty>normalized.orderedQty)errors.push('allocatedQty');
    normalized.supplyAllocations.forEach((row,index)=>{
      if(row.type===SUPPLY_SOURCE_TYPES.PEER_TRANSFER){
        if(!String(row.supplierId||row.supplier||'').trim())errors.push(`supplier:${index}`);
        if(n(row.unitCost)<=0)errors.push(`unitCost:${index}`);
        if(!String(row.endCustomer||item.customerName||'').trim())errors.push(`endCustomer:${index}`);
      }
    });
    return {valid:errors.length===0,errors,...normalized};
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
  return {SUPPLY_SOURCE_TYPES,RELEASE_MODES,ADVANCE_STATUSES,ITEM_WORK_CATEGORIES,itemWorkCategory,normalizeSupplyAllocations,validateSupplyAllocations,normalizeCommercialRelease,validateAdvanceRequest,canDeliver,canBill};
});
