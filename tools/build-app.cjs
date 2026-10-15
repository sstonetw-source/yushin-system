#!/usr/bin/env node
'use strict';
// Single source of truth: edit src/*, then run 'node tools/build-app.cjs'.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const parts = [
  "src/infrastructure/firebase.js",
  "src/app/bootstrap.js",
  "src/app/navigation.js",
  "src/features/products/product-management.js",
  "src/features/forecasts/forecast-head.js",
  "src/shared/action-feedback.js",
  "src/features/forecasts/forecast-workspace.js",
  "src/features/quotations/quotation-workspace.js",
  "src/features/inventory/inventory-workspace.js",
  "src/services/order-reservation.js",
  "src/features/orders/order-workspace.js",
  "src/features/purchasing/purchasing-workspace.js",
  "src/services/supply-order.js",
  "src/services/receiving.js",
  "src/features/purchasing/purchase-order-editor.js",
  "src/features/quotations/next-quotation.js",
  "src/features/orders/order-status.js",
  "src/features/orders/order-progress.js",
  "src/services/order-lifecycle-reservation.js",
  "src/features/orders/lifecycle-workspace.js",
  "src/services/delivery-stock.js",
  "src/features/orders/delivery-actions.js",
  "src/features/orders/order-creation.js",
  "src/features/equipment/equipment-workspace.js",
  "src/features/administration/brand-settings.js",
  "src/features/analytics/sales-reports.js",
  "src/features/administration/user-and-system-settings.js",
  "src/features/products/product-master-import.js"
];
const actual = parts.map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('');
const output = path.join(root, 'app.js');
if (process.argv.includes('--check')) {
  const committed = fs.readFileSync(output, 'utf8');
  if (committed !== actual) {
    console.error('app.js 與 src 原始碼不一致，請執行 node tools/build-app.cjs 並提交 app.js。');
    process.exitCode = 1;
  } else console.log('app.js 與 src 原始碼完全一致。');
} else {
  fs.writeFileSync(output, actual, 'utf8');
  console.log('已由', parts.length, '個來源檔產生 app.js。');
}
