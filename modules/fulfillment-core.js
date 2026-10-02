(function (root, factory) {
  const receiving = typeof module === 'object' && module.exports ? require('./receiving-core.js') : (root && root.YushinReceiving);
  const api = factory(receiving);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YushinFulfillment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (receiving) {
  function n(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, num) : 0;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(n(value), n(min)), n(max));
  }

  function normalizeItem(item = {}, index = 0) {
    const orderedQty = n(item.orderedQty ?? item.qty);
    // 採購、到貨、打單、送貨與退貨都是累計事件量。
    // 發生退貨後補送時，累計量可以合理超過原始 orderedQty，不能截回原訂購量。
    const supplyOrderedQty = n(item.supplyOrderedQty);
    const receivedQty = n(item.receivedQty);
    const dispatchPreparedQty = n(item.dispatchPreparedQty);
    const deliveredQty = n(item.deliveredQty);
    const returnedQty = Math.min(n(item.returnedQty), deliveredQty);
    const fulfilledQty = clamp(deliveredQty - returnedQty, 0, orderedQty);
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

  function reserveFromAvailable(item, availableQty) {
    const next = normalizeItem(item);
    const outstanding = Math.max(0, next.orderedQty - (next.deliveredQty - next.returnedQty));
    const target = Math.min(outstanding, n(availableQty));
    return normalizeItem({ ...next, reservedQty: target });
  }

  function applyReceipt(item, qty) {
    if (!receiving) throw new Error('Receiving core is required.');
    return normalizeItem(receiving.applyReceiptToOrderItem(normalizeItem(item), qty).item);
  }

  function dispatchState(item = {}) {
    // Dispatch 只需要物流事件量與「目前仍被占用」的庫存。
    // 不先 normalizeItem()，避免在缺少 orderedQty 的輕量快照中把 live reservedQty 截成 0。
    // reservedQty 的合法性由 reservation / inventory transaction 維護；這裡只負責算待打單與可出貨。
    const grossDelivered = n(item.deliveredQty);
    const returned = Math.min(n(item.returnedQty), grossDelivered);
    const delivered = Math.max(0, grossDelivered - returned);
    const reserved = n(item.reservedQty);
    const prepared = n(item.dispatchPreparedQty);
    const preparedOutstanding = Math.max(0, prepared - grossDelivered);
    const shippable = Math.max(0, Math.min(reserved, preparedOutstanding));
    const pending = Math.max(0, reserved - shippable);
    return { delivered, grossDelivered, returned, reserved, prepared, preparedOutstanding, shippable, pending };
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

  function sourceStatus(item) {
    const x = normalizeItem(item);
    if (x.shortageQty <= 0) return '有庫存';
    if (x.supplyOrderedQty > 0) return '已訂貨';
    return '未訂貨';
  }

  function fulfillmentStatus(item) {
    const x = normalizeItem(item);
    const netDelivered = x.deliveredQty - x.returnedQty;
    if (x.orderedQty > 0 && netDelivered >= x.orderedQty) return '全部送貨';
    if (netDelivered > 0) return '部分送貨';
    if (shippableQty(x) > 0) return '可出貨';
    if (pendingDispatchQty(x) > 0) return '待打單';
    if (x.supplyOrderedQty > 0 || x.shortageQty > 0) return '處理中';
    return '處理中';
  }

  function allocateLots(lots, qty, expiryManaged) {
    const wanted = n(qty);
    const eligible = (lots || []).filter(l => n(l.remainingQty) > 0);
    const sorted = [...eligible].sort((a, b) => {
      if (expiryManaged) {
        const ae = a.expiryDate || '9999-12-31';
        const be = b.expiryDate || '9999-12-31';
        if (ae !== be) return ae.localeCompare(be);
      }
      return String(a.receivedAt || '').localeCompare(String(b.receivedAt || ''));
    });
    let remaining = wanted;
    const allocations = [];
    for (const lot of sorted) {
      if (remaining <= 0) break;
      const take = Math.min(remaining, n(lot.remainingQty));
      if (!take) continue;
      allocations.push({
        lotId: lot.id || lot.lotId || '',
        qty: take,
        unitCost: n(lot.unitCost),
        cost: take * n(lot.unitCost)
      });
      remaining -= take;
    }
    return {
      allocations,
      allocatedQty: wanted - remaining,
      shortageQty: remaining,
      cogs: allocations.reduce((sum, a) => sum + a.cost, 0)
    };
  }

  return {
    normalizeItem,
    reserveFromAvailable,
    applyReceipt,
    dispatchState,
    pendingDispatchQty,
    shippableQty,
    prepareDispatch,
    deliver,
    returnDelivery,
    sourceStatus,
    fulfillmentStatus,
    allocateLots
  };
});