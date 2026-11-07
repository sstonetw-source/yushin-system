const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('admin navigation retires the browser data export and keeps diagnostics in page help', () => {
    const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    const html = read('index.html');
    const help = read('modules/page-help.js');
    const app = read('app.js');
    assert.doesNotMatch(html, /id="admin-(?:sub-)?storage"|id="admin-sub-health"|id="databaseBackup\w*"|id="testDataReset\w*"/);
    assert.doesNotMatch(app, /downloadDatabaseBackup|previewDatabaseBackupUpload|restoreMissingDatabaseBackupDocuments|window\.(?:execute|preview)TestDataReset\s*=/);
    assert.match(help, /window\.switchAdminTab\('health'\)/);
    assert.match(html, /id="systemDataAuditBtn"/);
});
