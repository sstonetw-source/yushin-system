(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YushinFulfillment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function n(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, num) : 0;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(n(value), n(min)), n(max));
  }

  // deliveredQty is always cumulative here. Callers exclude CLOSE returns
  // before projecting replacement demand; physical return history stays intact.
  function deliveryQuantities(item = {}) {
    const grossDeliveredQty = n(item.deliveredQty);
    const returnedQty = Math.min(n(item.returnedQty), grossDeliveredQty);
    return { grossDeliveredQty, returnedQty,
      effectiveDeliveredQty: Math.max(0, grossDeliveredQty - returnedQty) };
  }

  // Canonical order-level delivery and return projection. CLOSE means no replacement.
  function projectOrderDelivery({grossDeliveredQty = 0, returnedQty = 0, returnRecords = []} = {}) {
    const grossDelivered = n(grossDeliveredQty);
    const returned = Math.min(grossDelivered, n(returnedQty));
    const closedReturns = Math.min(returned,
      (Array.isArray(returnRecords) ? returnRecords : [])
        .filter(row => row?.settlement === 'CLOSE')
        .reduce((sum, row) => sum + n(row?.qty), 0));
    const effectiveDelivered = deliveryQuantities({
      deliveredQty: grossDelivered,
      returnedQty: returned - closedReturns
    }).effectiveDeliveredQty;
    return {grossDelivered, returned, closedReturns, effectiveDelivered};
  }

  function normalizeItem(item = {}, index = 0) {
    const orderedQty = n(item.orderedQty ?? item.qty);
    // 採購、到貨、打單、送貨與退貨都是累計事件量。
    // 發生退貨後補送時，累計量可以合理超過原始 orderedQty，不能截回原訂購量。
    const supplyOrderedQty = n(item.supplyOrderedQty);
    const receivedQty = n(item.receivedQty);
    const dispatchPreparedQty = n(item.dispatchPreparedQty);
    const delivery = deliveryQuantities(item);
    const deliveredQty = delivery.grossDeliveredQty;
    const returnedQty = delivery.returnedQty;
    const fulfilledQty = clamp(delivery.effectiveDeliveredQty, 0, orderedQty);
    const outstandingQty = Math.max(0, orderedQty - fulfilledQty);
    const reservedQty = clamp(item.reservedQty, 0, outstandingQty);
    const shortageQty = Math.max(0, outstandingQty - reservedQty);
    return {
      ...item,
      itemId: String(item.itemId || `item-${index + 1}`),
      qty: orderedQty,
      orderedQty,
      reservedQty,
      shortageQty,
      supplyOrderedQty,
      receivedQty,
      dispatchPreparedQty,
      deliveredQty,
      returnedQty
    };
  }

  function dispatchState(item = {}) {
    // Dispatch 只需要物流事件量與「目前仍被預留」的庫存。
    // 不先 normalizeItem()，避免在缺少 orderedQty 的輕量快照中把 live reservedQty 截成 0。
    // reservedQty 的合法性由 reservation / inventory transaction 維護；這裡只負責算待打單與可出貨。
    const delivery = deliveryQuantities(item);
    const grossDelivered = delivery.grossDeliveredQty;
    const returned = delivery.returnedQty;
    const delivered = delivery.effectiveDeliveredQty;
    const reserved = n(item.reservedQty);
    const prepared = n(item.dispatchPreparedQty);
    const preparedOutstanding = Math.max(0, prepared - grossDelivered);
    const shippable = Math.max(0, Math.min(reserved, preparedOutstanding));
    const pending = Math.max(0, reserved - shippable);
    return { delivered, grossDelivered, returned, reserved, prepared, preparedOutstanding, shippable, pending };
  }

  // Physical warehouse shipment is a separate event from customer delivery.
  // Reuse the same cumulative preparation budget, with shipped quantity as
  // the consumed budget; never change delivery records through this adapter.
  function warehouseShipmentState(item = {}) {
    const shippedQty = n(item.warehouseShippedQty);
    const state = dispatchState({ deliveredQty: shippedQty,
      reservedQty: item.reservedQty, dispatchPreparedQty: item.dispatchPreparedQty });
    return { shippedQty, reserved: state.reserved, prepared: state.prepared,
      preparedOutstanding: state.preparedOutstanding, shippable: state.shippable, pending: state.pending };
  }

  // Canonical v2 shipment/acknowledgement projection. Legacy deliveries and
  // returns must not be mixed into this explicitly bounded migration contract.
  function projectShipmentDelivery({orderId,itemId,productKey,orderedQty,shipments=[],deliveries=[]} = {}) {
    const ident=value=>{
      if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
        throw Error('出貨或送達識別資料不正確。');
      return value;
    };
    const qty=value=>{
      if(!Number.isSafeInteger(value)||value<0)throw Error('出貨或送達數量必須為非負整數。');
      return value;
    };
    const date=value=>{
      if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)
        ||!Number.isFinite(Date.parse(value+'T00:00:00Z'))
        ||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)
        throw Error('出貨或送達日期不正確。');
      return value;
    };
    [orderId,itemId,productKey].forEach(ident);qty(orderedQty);
    if(!Array.isArray(shipments)||!Array.isArray(deliveries)||shipments.length>200||deliveries.length>200)
      throw Error('出貨或送達紀錄格式不正確或超過安全上限。');
    const source=new Map();let shippedQty=0,confirmedQty=0;
    for(const row of shipments){
      ident(row?.id);ident(row.warehouseId);date(row.date);
      if(source.has(row.id)||row.orderId!==orderId||row.itemId!==itemId||row.productKey!==productKey
        ||row.sourceType!=='WAREHOUSE_CUSTOMER_SHIPMENT'||qty(row.qty)===0)
        throw Error('倉庫出貨紀錄來源不一致或重複。');
      shippedQty=qty(shippedQty+row.qty);
      if(shippedQty>orderedQty)throw Error('倉庫出貨總量超過訂購量。');
      source.set(row.id,{shipment:row,confirmedQty:0});
    }
    const seen=new Set();
    for(const row of deliveries){
      ident(row?.id);ident(row.shipmentId);date(row.date);
      const target=source.get(row.shipmentId);
      if(seen.has(row.id)||!target||row.orderId!==orderId||row.itemId!==itemId||row.productKey!==productKey
        ||row.warehouseId!==target.shipment.warehouseId||row.sourceType!=='WAREHOUSE_SHIPMENT_CONFIRMATION'
        ||qty(row.qty)===0||row.date<target.shipment.date)
        throw Error('客戶送達未對應有效出貨紀錄或日期不一致。');
      seen.add(row.id);target.confirmedQty=qty(target.confirmedQty+row.qty);
      if(target.confirmedQty>target.shipment.qty)throw Error('送達量超過該筆倉庫出貨量。');
      confirmedQty=qty(confirmedQty+row.qty);
    }
    const delivery=projectOrderDelivery({grossDeliveredQty:confirmedQty});
    return {shippedQty,unshippedQty:orderedQty-shippedQty,confirmedQty:delivery.effectiveDelivered,pendingDeliveryQty:shippedQty-delivery.effectiveDelivered,
      isDelivered:orderedQty>0&&delivery.effectiveDelivered===orderedQty,
      shipments:[...source].map(([shipmentId,row])=>({shipmentId,shippedQty:row.shipment.qty,
        confirmedQty:row.confirmedQty,pendingQty:row.shipment.qty-row.confirmedQty}))};
  }

  // Match an immutable physical debit to its source shipment. The backend
  // acknowledgement adapter additionally verifies its normalized intent hash.
  function validateShipmentMovement(shipment,movement,{orderId,itemId,productKey}={}) {
    const same=(a,b)=>{
      if(a===b)return true;
      if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
      const keys=Object.keys(a);
      return keys.length===Object.keys(b).length&&keys.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&same(a[k],b[k]));
    };
    const allocations=shipment?.lotAllocations;
    if(!shipment||shipment.orderId!==orderId||shipment.itemId!==itemId||shipment.productKey!==productKey
      ||shipment.sourceType!=='WAREHOUSE_CUSTOMER_SHIPMENT'
      ||shipment.movementId!=='location-ship-'+shipment.id
      ||!Number.isSafeInteger(shipment.qty)||shipment.qty<=0
      ||!Array.isArray(allocations)||!allocations.length||allocations.length>200
      ||allocations.some(a=>!a||typeof a.lotId!=='string'||!a.lotId||!Number.isSafeInteger(a.qty)||a.qty<=0)
      ||new Set(allocations.map(a=>a.lotId)).size!==allocations.length
      ||allocations.reduce((sum,a)=>sum+a.qty,0)!==shipment.qty
      ||!movement||movement.action!=='location_customer_shipment'||movement.type!=='ship'
      ||movement.sourceId!==orderId||movement.itemId!==itemId||movement.productKey!==productKey
      ||movement.warehouseId!==shipment.warehouseId||movement.qty!==-shipment.qty
      ||!same(movement.lotAllocations,allocations))
      throw Error('來源倉庫出貨與實際扣帳憑證不一致。');
    return true;
  }

  // Physical returns do not erase historical shipments/acknowledgements.
  // CLOSE fulfils that quantity commercially; REPLACE reopens demand.
  function projectShipmentReturns(input={}) {
    const base=projectShipmentDelivery(input),records=input.returns??[];
    if(!Array.isArray(records)||records.length>200)throw Error('退貨紀錄格式不正確或超過安全上限。');
    const seen=new Set(),totals=new Map();let returnedQty=0,closedQty=0;
    // A later acknowledgement of the remaining shipment does not invalidate
    // an earlier return. Validate each return against delivery actually
    // confirmed by that date, in chronological order (input order is a cache).
    for(const row of [...records].sort((a,b)=>String(a?.date||'').localeCompare(String(b?.date||'')))){
      const source=(input.shipments||[]).find(s=>s.id===row?.shipmentId);
      const delivered=base.shipments.find(s=>s.shipmentId===row?.shipmentId);
      if(typeof row?.id!=='string'||!row.id||seen.has(row.id)||!source||!delivered
        ||row.orderId!==input.orderId||row.itemId!==input.itemId||row.productKey!==input.productKey
        ||row.warehouseId!==source.warehouseId||row.sourceType!=='WAREHOUSE_CUSTOMER_RETURN'
        ||!['CLOSE','REPLACE'].includes(row.settlement)||row.condition!=='RESTOCKABLE'
        ||!Number.isSafeInteger(row.qty)||row.qty<=0
        ||typeof row.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)
        ||!Number.isFinite(Date.parse(row.date+'T00:00:00Z'))
        ||new Date(row.date+'T00:00:00Z').toISOString().slice(0,10)!==row.date
        ||row.date<source.date)
        throw Error('退貨未對應有效出貨／送達來源或結案方式不正確。');
      seen.add(row.id);const total=(totals.get(row.shipmentId)||0)+row.qty;
      const confirmedByDate=(input.deliveries||[]).filter(d=>d.shipmentId===row.shipmentId&&d.date<=row.date)
        .reduce((sum,d)=>sum+d.qty,0);
      if(!Number.isSafeInteger(total)||total>confirmedByDate)throw Error('退貨超過該筆當時已送達量。');
      totals.set(row.shipmentId,total);returnedQty+=row.qty;
      if(row.settlement==='CLOSE')closedQty+=row.qty;
    }
    const replacementQty=returnedQty-closedQty;
    const effectiveDeliveredQty=projectOrderDelivery({grossDeliveredQty:base.confirmedQty,returnedQty,
      returnRecords:records}).effectiveDelivered;
    return {...base,returnedQty,closedQty,replacementQty,effectiveDeliveredQty,
      outstandingQty:input.orderedQty-base.shippedQty+replacementQty,
      isDelivered:input.orderedQty>0&&effectiveDeliveredQty===input.orderedQty};
  }

  function pendingDispatchQty(item) {
    return dispatchState(item).pending;
  }

  function shippableQty(item) {
    return dispatchState(item).shippable;
  }

  function prepareDispatch(item, qty) {
    const x = normalizeItem(item);
    const applied = Math.min(n(qty), pendingDispatchQty(x));
    return normalizeItem({ ...x, dispatchPreparedQty: x.dispatchPreparedQty + applied });
  }

  function deliver(item, qty) {
    const x = normalizeItem(item);
    const applied = Math.min(n(qty), shippableQty(x));
    return normalizeItem({
      ...x,
      deliveredQty: x.deliveredQty + applied,
      reservedQty: Math.max(0, x.reservedQty - applied)
    });
  }

  function returnDelivery(item, qty) {
    const x = normalizeItem(item);
    const applied = Math.min(n(qty), Math.max(0, x.deliveredQty - x.returnedQty));
    return normalizeItem({ ...x, returnedQty: x.returnedQty + applied });
  }

  return {
    deliveryQuantities,
    projectOrderDelivery,
    normalizeItem,
    dispatchState,
    warehouseShipmentState,
    projectShipmentDelivery,
    validateShipmentMovement,
    projectShipmentReturns,
    pendingDispatchQty,
    shippableQty,
    prepareDispatch,
    deliver,
    returnDelivery
  };
});

