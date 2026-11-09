const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildStockCutoverRules, TARGETS } = require('../tools/build-stock-cutover-rules.cjs');

const source = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

function blockFor(rules, collection) {
  const opening = `    match /${collection}/{id} {`;
  const start = rules.indexOf(opening);
  const end = rules.indexOf('\n    }', start);
  assert.ok(start >= 0 && end > start, `Missing ${collection} block`);
  return rules.slice(start, end + '\n    }'.length);
}

test('production stock cutover is an explicit generated Rules artifact, not a latent read on every current write', () => {
  const generated = buildStockCutoverRules(source);
  assert.ok(!source.includes('stockWriterCutover'));
  assert.match(generated, /BACKEND-ONLY STOCK WRITER CUTOVER/);
  assert.notEqual(generated, source);
  assert.equal(buildStockCutoverRules(source), generated);
  for (const [collection, methods] of Object.entries(TARGETS)) {
    const before = blockFor(source, collection);
    const after = blockFor(generated, collection);
    for (const method of methods) {
      if (collection === 'inventory' && method === 'update') {
        assert.match(after, /affectedKeys\(\)\.hasOnly\(\[/);
        assert.match(after, /inventoryUpdateWriter\(id\)/);
        assert.match(after, /validInventoryArchiveChange\(id\)/);
        assert.match(after, /!\('unitCost' in request\.resource\.data\)/);
      } else {
        assert.match(after, new RegExp(`allow ${method}: if false;`));
      }
      if (collection !== 'inventory' || method !== 'create') {
        assert.notEqual(before, after, `${collection}.${method} must be retired`);
      }
    }
    assert.match(after, /allow (read|get)/, `${collection} must retain existing read Rules`);
  }
  assert.equal(blockFor(source, 'users'), blockFor(generated, 'users'));
  assert.equal(blockFor(source, 'settings'), blockFor(generated, 'settings'));
});

test('generator refuses to silently skip a missing transaction match or write rule', () => {
  assert.throws(() => buildStockCutoverRules(source.replace('match /inventoryReservations/{id}', 'match /missingReservations/{id}')), /inventoryReservations/);
  assert.throws(() => buildStockCutoverRules(source.replace('allow create: if reservationCreateAllowed(id);', 'allow odd: if reservationCreateAllowed(id);')), /inventoryReservations.create/);
});
