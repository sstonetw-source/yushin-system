'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DELETE_COLLECTIONS, PRESERVE_COLLECTIONS, ZERO_STOCK_COLLECTIONS,
  classifyRootCollections, stockResetPatch
} = require('../functions/operational-reset-policy');

const observedFormalRoots = [
  'auditLogs', 'brandSupplierMappings', 'brands', 'customers', 'dispatchRecords',
  'equipment', 'forecasts', 'inventory', 'inventoryLotCosts', 'inventoryLots',
  'inventoryMovements', 'inventoryReservations', 'orders', 'priceHistory',
  'procurementDemands', 'productCosts', 'products', 'purchaseOrders', 'quotes',
  'receipts', 'receivingSupplyOrders', 'salesCodes', 'settings', 'stockTransfers',
  'suppliers', 'supplyOrders', 'users', 'warehouseStocks', 'warehouses'
];

test('every observed formal root has exactly one safe action', () => {
  const plan = classifyRootCollections(observedFormalRoots);
  assert.deepEqual(plan.unknown, []);
  assert.equal(plan.deleting.length, 14);
  assert.equal(plan.preserving.length, 13);
  assert.equal(plan.zeroing.length, 2);
  assert.ok(plan.preserving.includes('quotes'));
  assert.ok(!plan.deleting.includes('quotes'));
  assert.ok(plan.preserving.includes('priceHistory'));
  assert.ok(plan.preserving.includes('productCosts'));
  assert.ok(plan.preserving.includes('brandSupplierMappings'));
  assert.ok(PRESERVE_COLLECTIONS.includes('productLines'));
  assert.ok(PRESERVE_COLLECTIONS.includes('quotes'));
  assert.ok(plan.deleting.includes('stockTransfers'));
  assert.ok(plan.preserving.includes('products'));
  assert.ok(plan.preserving.includes('users'));
});

test('all allowlists are disjoint and unknown roots fail classification', () => {
  const all = [...DELETE_COLLECTIONS, ...PRESERVE_COLLECTIONS, ...ZERO_STOCK_COLLECTIONS];
  assert.equal(new Set(all).size, all.length);
  const result = classifyRootCollections([...all, 'unexpectedTransactionCollection']);
  assert.deepEqual(result.unknown, ['unexpectedTransactionCollection']);
});

test('stock reset zeroes quantity fields and clears embedded lots without touching metadata', () => {
  const sample = { brand: 'Qiagen', itemCode: '51104', onHand: 4, reserved: 2, lots: [{ batch: 'old' }] };
  const patch = stockResetPatch(sample, 'admin-cli', '2026-10-28T00:00:00.000Z');
  assert.deepEqual(patch, {
    onHand: 0, reserved: 0, available: 0, incoming: 0, shortage: 0,
    lots: [], updatedAt: '2026-10-28T00:00:00.000Z', resetBy: 'admin-cli'
  });
  assert.equal(sample.onHand, 4);
  assert.deepEqual(sample.lots, [{ batch: 'old' }]);
  assert.equal('brand' in patch, false);
});

test('stock reset preserves a warehouse stock without lots', () => {
  const patch = stockResetPatch({ warehouseId: 'wh', onHand: 8, incoming: 1 }, 'cli', 'now');
  assert.equal(patch.onHand, 0);
  assert.equal(patch.incoming, 0);
  assert.equal('lots' in patch, false);
});

test('stock reset rejects unknown field types before any write', () => {
  assert.throws(() => stockResetPatch({ onHand: '8' }, 'cli', 'now'), /Unexpected stock field type/);
  assert.throws(() => stockResetPatch({ lots: { stale: true } }, 'cli', 'now'), /Unexpected lots type/);
});
