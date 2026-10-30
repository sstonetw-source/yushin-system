'use strict';
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('Firestore rules have no unreferenced helper declarations that block Console publishing', () => {
  // This is a conservative source check, not a replacement for Firebase compilation.
  // Ignore comments so a comment mentioning a helper cannot hide a dead declaration.
  const source = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
  const names = [...source.matchAll(/\bfunction\s+(\w+)\s*\(/g)].map(match => match[1]);
  const unused = names.filter(name => [...source.matchAll(new RegExp('\\b' + name + '\\s*\\(', 'g'))].length === 1);
  assert.deepEqual(unused, [], 'Remove unused helpers or connect them to an intended rule after reviewing permissions');
});
