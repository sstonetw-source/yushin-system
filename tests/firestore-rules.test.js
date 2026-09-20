const fs = require('node:fs');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc
} = require('firebase/firestore');

async function main() {
  const testEnv = await initializeTestEnvironment({
    projectId: 'demo-yushin',
    firestore: {
      rules: fs.readFileSync('firestore.rules', 'utf8'),
      host: '127.0.0.1',
      port: 8080
    }
  });

  try {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async context => {
      const db = context.firestore();
      await Promise.all([
        setDoc(doc(db, 'users', 'admin1'), { role: 'admin', code: 'A01' }),
        setDoc(doc(db, 'users', 'sales1'), { role: 'sales', code: 'S01' }),
        setDoc(doc(db, 'users', 'sales2'), { role: 'sales', code: 'S02' }),
        setDoc(doc(db, 'users', 'purchaser1'), { role: 'purchaser', code: 'P01' }),
        setDoc(doc(db, 'users', 'warehouse1'), { role: 'warehouse', code: 'W01' }),
        setDoc(doc(db, 'users', 'engineer1'), { role: 'engineer', code: 'E01' }),

        setDoc(doc(db, 'orders', 'own-order'), {
          salesCode: 'S01', ownerUid: 'sales1', status: 'active',
          totalPrice: 100, linkedDocuments: []
        }),
        setDoc(doc(db, 'orders', 'other-order'), {
          salesCode: 'S02', ownerUid: 'sales2', status: 'active',
          totalPrice: 200, linkedDocuments: []
        }),
        setDoc(doc(db, 'quotes', 'own-quote'), {
          salesCode: 'S01', ownerUid: 'sales1', status: 'active'
        }),
        setDoc(doc(db, 'quotes', 'other-quote'), {
          salesCode: 'S02', ownerUid: 'sales2', status: 'active'
        }),
        setDoc(doc(db, 'equipment', 'own-equipment'), {
          salesCode: 'S01', ownerUid: 'sales1', active: true
        }),
        setDoc(doc(db, 'equipment', 'other-equipment'), {
          salesCode: 'S02', ownerUid: 'sales2', active: true
        }),
        setDoc(doc(db, 'inventory', 'prd1'), {
          onHand: 10, reserved: 2, incoming: 0, lots: []
        }),
        setDoc(doc(db, 'warehouseStocks', 'wh1__prd1'), {
          warehouseId: 'wh1', productKey: 'prd1',
          onHand: 10, reserved: 2, incoming: 0, lots: []
        })
      ]);
    });

    const admin = testEnv.authenticatedContext('admin1').firestore();
    const sales = testEnv.authenticatedContext('sales1').firestore();
    const purchaser = testEnv.authenticatedContext('purchaser1').firestore();
    const warehouse = testEnv.authenticatedContext('warehouse1').firestore();
    const engineer = testEnv.authenticatedContext('engineer1').firestore();

    await assertSucceeds(getDoc(doc(sales, 'orders', 'own-order')));
    await assertFails(getDoc(doc(sales, 'orders', 'other-order')));
    await assertSucceeds(getDoc(doc(purchaser, 'orders', 'other-order')));
    await assertSucceeds(getDoc(doc(warehouse, 'orders', 'other-order')));
    await assertFails(getDoc(doc(engineer, 'orders', 'own-order')));

    await assertSucceeds(getDoc(doc(purchaser, 'quotes', 'other-quote')));
    await assertFails(getDoc(doc(warehouse, 'quotes', 'other-quote')));
    await assertFails(getDoc(doc(engineer, 'quotes', 'other-quote')));

    await assertSucceeds(getDoc(doc(sales, 'equipment', 'own-equipment')));
    await assertFails(getDoc(doc(sales, 'equipment', 'other-equipment')));
    await assertSucceeds(getDoc(doc(engineer, 'equipment', 'other-equipment')));
    await assertFails(getDoc(doc(purchaser, 'equipment', 'other-equipment')));

    await assertFails(deleteDoc(doc(admin, 'quotes', 'own-quote')));
    await assertFails(deleteDoc(doc(admin, 'equipment', 'own-equipment')));

    await assertSucceeds(updateDoc(doc(purchaser, 'orders', 'own-order'), {
      purchaseOrderNo: 'PO-TEST'
    }));
    await assertFails(updateDoc(doc(purchaser, 'orders', 'own-order'), {
      totalPrice: 999999
    }));

    await assertSucceeds(setDoc(doc(sales, 'inventoryMovements', 'own-reserve'), {
      sourceType: 'order',
      sourceId: 'own-order',
      type: 'reserve',
      qty: 1
    }));
    await assertFails(setDoc(doc(sales, 'inventoryMovements', 'other-reserve'), {
      sourceType: 'order',
      sourceId: 'other-order',
      type: 'reserve',
      qty: 1
    }));
    await assertFails(setDoc(doc(sales, 'inventoryMovements', 'manual-adjust'), {
      sourceType: 'manual',
      sourceId: '',
      type: 'adjustment',
      qty: 50
    }));

    await assertSucceeds(updateDoc(doc(sales, 'warehouseStocks', 'wh1__prd1'), {
      onHand: 9,
      reserved: 1,
      lots: [],
      updatedAt: new Date().toISOString()
    }));
    await assertFails(updateDoc(doc(sales, 'warehouseStocks', 'wh1__prd1'), {
      incoming: 999
    }));

    console.log('Firestore role/security rules tests passed.');
  } finally {
    await testEnv.cleanup();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
