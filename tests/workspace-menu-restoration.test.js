const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../src/shared/workspace-interactions.js'), 'utf8');

test('shared menu controller covers quotation, order and purchasing menus', () => {
  for (const menu of ['.quote-more-menu', '.order-more-menu', '.po-more-menu']) {
    assert.ok(source.includes(menu), `missing ${menu} in shared menu selector`);
  }
});

test('restored details open state cannot show action dialog without explicit summary click', () => {
  assert.match(source, /addEventListener\('click',[\s\S]*?closest\?\.\('summary'\)/);
  assert.match(source, /if\(!userActivatedMenus\.has\(menu\)\)\{menu\.open=false;return;\}/);
  assert.match(source, /userActivatedMenus\.delete\(menu\);[\s\S]*?dialog\.showModal\(\)/);
});
