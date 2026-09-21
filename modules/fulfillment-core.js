(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YushinFulfillment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const n = value => Math.max(0, Number(value || 0));

  function normalizeItem(item = {}, index = 0) {
    const orderedQty = n(item.orderedQty ?? item.qty);
    const reservedQty = Math.min(orderedQty, n(item.reservedQty ?? item.inventoryReservedQty));
    const deliveredQty = Math.min(orderedQty, n(item.deliveredQty));
    const returnedQty = Math.min(deliveredQty, n(item.returnedQty));
    const receivedQty = n(item.receivedQty);
    const supplyOrderedQty = n(item.supplyOrderedQty ?? item.purchaseOrderedQty);
    const dispatchPreparedQty = Math.min(orderedQty, n(item.dispatchPreparedQty));
    const shortageQty = Math.max(0, orderedQty - reservedQty - deliveredQty);
    return {
      ...item,
      itemId: String(item.itemId || `item-${index + 1}`),
      orderedQty,
      qty: orderedQty,
      reservedQty,
      inventoryReservedQty: reservedQty,
      shortageQty,
      inventoryShortageQty: shortageQty,
      purchaseRequiredQty: shortageQty,
      supplyOrderedQty,
      purchaseOrderedQty: supplyOrderedQty,
      receivedQty,
      dispatchPreparedQty,
      deliveredQty,
      returnedQty
    };
  }

  function reserve(orderedQty, availableQty) {
    const ordered = n(orderedQty);
    const available = n(availableQty);
    const reservedQty = Math.min(ordered, available);
    return { reservedQty, shortageQty: Math.max(0, ordered - reservedQty) };
  }

  function applyReceipt(item, qty) {
    const current = normalizeItem(item);
    const receiptQty = n(qty);
    const outstanding = Math.max(0, current.orderedQty - current.reservedQty - current.deliveredQty);
    const newlyReserved = Math.min(receiptQty, outstanding);
    return normalizeItem({
      ...current,
      receivedQty: current.receivedQty + receiptQty,
      reservedQty: current.reservedQty + newlyReserved
    });
  }

  function pendingDispatchQty(item) {
    const x = normalizeItem(item);
    return Math.max(0, x.reservedQty - x.dispatchPreparedQty);
  }

  function shippableQty(item) {
    const x = normalizeItem(item);
    return Math.max(0, Math.min(x.dispatchPreparedQty, x.reservedQty) - x.deliveredQty);
  }

  function prepareDispatch(item, qty) {
    const x = normalizeItem(item);
    const requested = n(qty);
    const max = pendingDispatchQty(x);
    if (requested <= 0 || requested > max) throw new Error(`待打單數量只有 ${max}`);
    return normalizeItem({ ...x, dispatchPreparedQty: x.dispatchPreparedQty + requested });
  }

  function deliver(item, qty) {
    const x = normalizeItem(item);
    const requested = n(qty);
    const max = shippableQty(x);
    if (requested <= 0 || requested > max) throw new Error(`可出貨數量只有 ${max}`);
    return normalizeItem({
      ...x,
      deliveredQty: x.deliveredQty + requested,
      reservedQty: Math.max(0, x.reservedQty - requested)
    });
  }

  function supplyStatus(item) {
    const x = normalizeItem(item);
    if (x.shortageQty <= 0) return { state: 'stock', label: '有庫存' };
    if (x.supplyOrderedQty > 0) return { state: 'ordered', label: '已訂貨' };
    return { state: 'pending', label: '未訂貨' };
  }

  function aggregate(items = []) {
    return items.map(normalizeItem).reduce((a, x) => ({
      orderedQty: a.orderedQty + x.orderedQty,
      reservedQty: a.reservedQty + x.reservedQty,
      shortageQty: a.shortageQty + x.shortageQty,
      supplyOrderedQty: a.supplyOrderedQty + x.supplyOrderedQty,
      receivedQty: a.receivedQty + x.receivedQty,
      dispatchPreparedQty: a.dispatchPreparedQty + x.dispatchPreparedQty,
      deliveredQty: a.deliveredQty + x.deliveredQty,
      returnedQty: a.returnedQty + x.returnedQty
    }), { orderedQty:0,reservedQty:0,shortageQty:0,supplyOrderedQty:0,receivedQty:0,dispatchPreparedQty:0,deliveredQty:0,returnedQty:0 });
  }

  return { normalizeItem, reserve, applyReceipt, pendingDispatchQty, shippableQty, prepareDispatch, deliver, supplyStatus, aggregate };
});
