'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const script = fs.readFileSync(path.join(root, 'tools/build-app.cjs'), 'utf8');
const match = script.match(/const parts = (\[[\s\S]*?\]);/);
assert.ok(match, 'build source manifest is required');
const parts = JSON.parse(match[1]);
test('app.js 由唯一來源清單產生，無重複或遺漏', () => {
  assert.equal(new Set(parts).size, parts.length);
  assert.deepEqual(parts.map(p => p.split('/')[0]).every(p => p === 'src'), true);
  const rebuilt = parts.map(p => fs.readFileSync(path.join(root, p), 'utf8')).join('');
  assert.equal(rebuilt, app);
});
test('每個來源檔及完整輸出均可由 JavaScript parser 解析', () => {
  for (const part of parts) assert.doesNotThrow(() =>
    new vm.Script(fs.readFileSync(path.join(root, part), 'utf8'), { filename: part }));
  assert.doesNotThrow(() => new vm.Script(app, {filename:'app.js'}));
});
test('保留 app.js 的主要交易入口及 Firestore 權限保護器', () => {
  assert.match(app,/function\s+runRoleTransaction\s*\(/);
  assert.match(app,/YushinStockPermissions\.run\s*\(/);
  assert.match(app,/function\s+normalizedOrderItems\s*\(/);
});
