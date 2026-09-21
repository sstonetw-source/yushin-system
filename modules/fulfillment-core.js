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

  function normalizeItem(item = {}, index = 0) {
    const orderedQty = n(item.orderedQty ?? item.qty);
    const reservedQty = clamp(item.reservedQty ?? item.inventoryReservedQty, 0, orderedQty);
    const supplyOrderedQty = clamp(item.supplyOrderedQty ?? item.purchaseOrderedQty, 0, orderedQty);
    const receivedQty = clamp(item.receivedQty, 0, orderedQty);
    const dispatchPreparedQty = clamp(item.dispatchPreparedQty, 0, orderedQty);
    const deliveredQty = clamp(item.deliveredQty, 0, orderedQty);
    const returnedQty = clamp(item.returnedQty, 0, deliveredQty);
    const fulfilledQty = Math.max(0, deliveredQty - returnedQty);
    const outstandingQty = Math.max(0, orderedQty - fulfilledQty);
    const shortageQty = Math.max(0, outstandingQty - reservedQty);
    return {
      ...item,
      itemId: String(item.itemId || `item-${index + 1}`),
      qty: orderedQty,
      orderedQty,
      reservedQty,
      inventoryReservedQty: reservedQty,
      inventoryShortageQty: shortageQty,
      purchaseRequiredQty: shortageQty,
      supplyOrderedQty,
      purchaseOrderedQty: supplyOrderedQty,
      receivedQty,
      dispatchPreparedQty,
      deliveredQty,
      returnedQty,
      shortageQty
    };
  }

  function reserveFromAvailable(item, availableQty) {
    const next = normalizeItem(item);
    const outstanding = Math.max(0, next.orderedQty - (next.deliveredQty - next.returnedQty));
    const target = Math.min(outstanding, n(availableQty));
    return normalizeItem({ ...next, reservedQty: target });
  }

  function applyReceipt(item, qty) {
    const next = normalizeItem(item);
    const receivable = Math.max(0, next.orderedQty - next.receivedQty);
    const received = Math.min(n(qty), receivable);
    const reservationCapacity = Math.max(0, next.orderedQty - next.deliveredQty + next.returnedQty - next.reservedQty);
    const newlyReserved = Math.min(received, reservationCapacity);
    return normalizeItem({
      ...next,
      receivedQty: next.receivedQty + received,
      reservedQty: next.reservedQty + newlyReserved
    });
  }

  function pendingDispatchQty(item) {
    const x = normalizeItem(item);
    return Math.max(0, x.reservedQty - x.dispatchPreparedQty);
  }

  function shippableQty(item) {
    const x = normalizeItem(item);
    return Math.max(0, Math.min(x.dispatchPreparedQty - x.deliveredQty, x.reservedQty));
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
      reservedQty: Math.max(0, x.reservedQty - applied),
      dispatchPreparedQty: Math.max(0, x.dispatchPreparedQty - applied)
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
