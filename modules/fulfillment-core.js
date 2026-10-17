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
    pendingDispatchQty,
    shippableQty,
    prepareDispatch,
    deliver,
    returnDelivery
  };
});

