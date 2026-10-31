'use strict';

// One-time operational reset allowlist. Unknown roots always abort.
const DELETE_COLLECTIONS = Object.freeze([
  'orders', 'purchaseOrders', 'procurementDemands', 'supplyOrders',
  'inventoryReservations', 'inventoryLots', 'inventoryLotCosts',
  'receipts', 'customerReturnReceipts', 'dispatchRecords', 'deliveries',
  'inventoryMovements', 'receivingSupplyOrders', 'forecasts',
  'stockTransfers', 'stockTransferRequests', 'stockOperations',
  'reservationOperationReceipts', 'purchaseOrderCommunications',
  'externalDispatchNotices', 'serviceCases', 'pendingInventoryItems',
  'auditLogs'
]);

const PRESERVE_COLLECTIONS = Object.freeze([
  'brandSupplierMappings', 'brands', 'customers', 'equipment',
  'priceHistory', 'productCosts', 'products', 'productLines', 'quotes',
  'salesCodes', 'settings', 'suppliers', 'users', 'warehouses'
]);

const ZERO_STOCK_COLLECTIONS = Object.freeze(['inventory', 'warehouseStocks']);
const STOCK_FIELDS = Object.freeze(['onHand', 'reserved', 'available', 'incoming', 'shortage']);

function classifyRootCollections(names) {
  const deleteSet = new Set(DELETE_COLLECTIONS);
  const preserveSet = new Set(PRESERVE_COLLECTIONS);
  const zeroSet = new Set(ZERO_STOCK_COLLECTIONS);
  if ([...deleteSet].some(name => preserveSet.has(name) || zeroSet.has(name)) ||
      [...preserveSet].some(name => zeroSet.has(name))) {
    throw new Error('Reset allowlists overlap');
  }
  const roots = [...new Set(names)].sort();
  return {
    deleting: roots.filter(name => deleteSet.has(name)),
    preserving: roots.filter(name => preserveSet.has(name)),
    zeroing: roots.filter(name => zeroSet.has(name)),
    unknown: roots.filter(name => !deleteSet.has(name) && !preserveSet.has(name) && !zeroSet.has(name))
  };
}

// Keep identifying / price / warehouse metadata; reset only known stock projections.
function stockResetPatch(data, resetBy, updatedAt) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid stock document');
  for (const key of STOCK_FIELDS) {
    if (data[key] !== undefined && (!Number.isFinite(data[key]) || typeof data[key] !== 'number')) {
      throw new Error('Unexpected stock field type: ' + key);
    }
  }
  if (data.lots !== undefined && !Array.isArray(data.lots)) throw new Error('Unexpected lots type');
  const patch = Object.fromEntries(STOCK_FIELDS.map(key => [key, 0]));
  if (Object.prototype.hasOwnProperty.call(data, 'lots')) patch.lots = [];
  patch.updatedAt = updatedAt;
  patch.resetBy = resetBy;
  return patch;
}

module.exports = {
  DELETE_COLLECTIONS, PRESERVE_COLLECTIONS, ZERO_STOCK_COLLECTIONS, STOCK_FIELDS,
  classifyRootCollections, stockResetPatch
};
