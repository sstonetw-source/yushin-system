const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'app.js'), 'utf8');
const start = source.indexOf('let pendingDatabaseBackup = null;');
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
});

test('restore checks each live document in a transaction and excludes permissions', () => {
  const restore = source.slice(source.indexOf('window.restoreMissingDatabaseBackupDocuments ='),
    source.indexOf('/* ---------- 估價單／訂單全歷史搜尋索引補建 ---------- */'));
  assert.match(restore, /db\.runTransaction\(async transaction/);
  assert.match(restore, /if \(existing\.exists\) return false;/);
  assert.match(restore, /transaction\.set\(ref, row\.data\)/);
  assert.match(source, /collection !== 'users' && collection !== 'settings'/);
});
