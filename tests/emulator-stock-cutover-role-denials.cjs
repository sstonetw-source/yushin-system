const test = require('node:test');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { deleteDoc, doc, getDoc, setDoc, setLogLevel, updateDoc } = require('firebase/firestore');
const { buildStockCutoverRules, TARGETS } = require('../tools/build-stock-cutover-rules.cjs');

setLogLevel('silent');

test('candidate backend-only Rules reject all nine stock ledger writers for every role', async () => {
  const rules = buildStockCutoverRules(fs.readFileSync('firestore.rules', 'utf8'));
  const env = await initializeTestEnvironment({
    projectId: 'demo-yushin-all-stock-writers-cutover',
    firestore: { rules }
  });
  const roleUsers = [
    ['admin', 'admin'], ['buyer', 'purchaser'], ['keeper', 'warehouse'],
    ['seller', 'sales'], ['engineer', 'engineer'], ['inactive', 'warehouse']
  ];
  const collections = Object.keys(TARGETS);
  assert.equal(collections.length, 9);
  const stock = {
    productKey: 'p-order', warehouseId: 'W1', onHand: 5, reserved: 0,
    incoming: 0, remainingQty: 5, quantity: 1,
    stockPolicy: 'ORDER_ONLY', safetyStock: 0
  };
  try {
    await env.withSecurityRulesDisabled(async ctx => {
      const db = ctx.firestore();
      for (const [uid, role] of roleUsers) {
        await setDoc(doc(db, `users/${uid}`), {
          role, active: uid !== 'inactive', salesCode: uid
        });
      }
      for (const collection of collections) {
        await setDoc(doc(db, `${collection}/cutover-existing`), stock);
      }
    });

    for (const [uid] of roleUsers) {
      const db = env.authenticatedContext(uid).firestore();
      for (const collection of collections) {
        const methods = TARGETS[collection];
        if (methods.includes('create')) {
          await assertFails(setDoc(doc(db, `${collection}/cutover-new`), stock));
        }
        if (methods.includes('update')) {
          const field = collection === 'inventory' ? 'onHand' : 'remainingQty';
          await assertFails(updateDoc(doc(db, `${collection}/cutover-existing`), {
            [field]: 4
          }));
        }
        if (methods.includes('delete')) {
          await assertFails(deleteDoc(doc(db, `${collection}/cutover-existing`)));
        }
      }
    }

    const adminDb = env.authenticatedContext('admin').firestore();
    await assertSucceeds(getDoc(doc(adminDb, 'inventory/cutover-existing')));
    await assertSucceeds(updateDoc(doc(adminDb, 'inventory/cutover-existing'), {
      stockPolicy: 'SAFETY_STOCK', safetyStock: 1
    }));
  } finally {
    await env.cleanup();
  }
});
