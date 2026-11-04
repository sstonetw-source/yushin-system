const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('const RESTORABLE_BACKUP_COLLECTIONS = new Set([');
const end = source.indexOf('/* ---------- 估價單／訂單全歷史搜尋索引補建 ---------- */', start);
const context = vm.createContext({
  window: {}, firebaseConfig: { projectId: 'production' },
  firebase: { firestore: { Timestamp: { fromDate: date => date } } },
  document: {}, currentUserRole: 'admin', trueUserRole: 'admin'
});
vm.runInContext(source.slice(start, end) + '\nwindow.validateBackupDocuments = validateBackupDocuments;', context);

function backup(rows, collection = 'orders') {
  return { format: 'yu-shing-firestore-backup', version: 1, projectId: 'production',
    documentCount: rows.length, collections: { [collection]: rows } };
}
test('backup upload validates project, count, duplicate paths, and collection boundaries', () => {
  const row = { id: 'o1', path: 'orders/o1', data: { customerName: '測試' } };
  const validate = context.window.validateBackupDocuments;
  assert.equal(validate(backup([row])).length, 1);
  assert.throws(() => validate({ ...backup([row]), projectId: 'another' }), /不同 Firebase/);
  assert.throws(() => validate({ ...backup([row]), documentCount: 2 }), /數量/);
  assert.throws(() => validate(backup([row, row])), /重複/);
  assert.throws(() => validate(backup([{ ...row, path: 'settings/rolePermissions' }])), /路徑/);
  assert.equal(validate(backup([{ id:'u1', path:'users/u1', data:{ role:'admin' } }], 'users')).length, 0);
  assert.equal(validate(backup([{
    id:'SALES_ORDER%3Ao1%3Ai1',
    path:'procurementDemands/SALES_ORDER%3Ao1%3Ai1',
    data:{ demandId:'SALES_ORDER:o1:i1', requestedQty:5, orderedQty:0, receivedQty:0 }
  }], 'procurementDemands')).length, 1);
});

test('browser inspection never restores transaction or permissions documents', () => {
  const inspection = source.slice(start, end);
  const html = fs.readFileSync(require('node:path').join(__dirname, '..', 'index.html'), 'utf8');
  const productMaintenance = fs.readFileSync(require('node:path').join(__dirname, '..', 'src/features/products/product-master-import.js'), 'utf8');
  assert.doesNotMatch(inspection, /window\\.restoreMissingDatabaseBackupDocuments\\s*=/);
  assert.doesNotMatch(inspection, /transaction\\.set\\(ref, row\\.data\\)/);
  assert.doesNotMatch(html, /id="databaseBackupRestoreBtn"|id="testDataResetExecuteBtn"|id="testDataResetPreviewBtn"/);
  assert.doesNotMatch(productMaintenance, /window\\.executeTestDataReset\\s*=|window\\.previewTestDataReset\\s*=/);
  assert.match(html, /不是完整資料庫備份/);
});
