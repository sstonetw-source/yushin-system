'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Isolated feature tests execute only their relevant app.js slice. Load the
// actual shared UI presenter into that VM without replacing its existing
// mocked write-button, database, or business-service dependencies.
const source = fs.readFileSync(path.join(__dirname, '../../src/shared/action-feedback.js'), 'utf8');
const start = source.indexOf('const uiWorkActions = new Map();');
if (start < 0) throw Error('Shared UI work manager is missing');
module.exports = function installUiWorkActions(context) {
    vm.runInContext(source.slice(start), context);
};
