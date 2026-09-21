const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc } = require('firebase/firestore');

let env;
const projectId = 'demo-yushin';

async function seed(path, data) {
  await env.withSecurityRulesDisabled(async ctx => {
    await setDoc(doc(ctx.firestore(), path), data);
  });
}

test.before(async () => {
  env = await initializeTestEnvironment({
    projectId,
    firestore: { rules: fs.readFileSync('firestore.rules', 'utf8') }
  });
});

test.after(async () => {
  await env.cleanup();
});

test.beforeEach(async () => {
  await env.clearFirestore();
  await seed('users/admin', { role:'admin', active:true, salesCode:'ADM' });
  await seed('users/sales1', { role:'sales', active:true, salesCode:'S01', productLineIds:['roche'] });
  await seed('users/sales2', { role:'sales', active:true, salesCode:'S02', productLineIds:[] });
  await seed('users/eng1', { role:'engineer', active:true, salesCode:'E01', productLineIds:['thermo'] });
  await seed('users/buyer1', { role:'purchaser', active:true, salesCode:'P01' });
  await seed('users/wh1', { role:'warehouse', active:true, salesCode:'W01' });
  await seed('users/off1', { role:'sales', active:false, salesCode:'OFF' });
});

function db(uid) {
  return env.authenticatedContext(uid).firestore();
}

test('inactive user is denied', async () => {
  await assertFails(getDoc(doc(db('off1'), 'settings/company')));
});

test('engineer can create own quote and order', async () => {
  const quote = { ownerUid:'eng1', salesCode:'E01', quoteDate:'2026-09-20' };
  await assertSucceeds(setDoc(doc(db('eng1'), 'quotes/q1'), quote));
  await assertSucceeds(setDoc(doc(db('eng1'), 'orders/o1'), { ...quote, orderDate:'2026-09-20' }));
});

test('sales cannot create a commercial document owned by another salesperson', async () => {
  await assertFails(setDoc(doc(db('sales1'), 'orders/o2'), {
    ownerUid:'sales2', salesCode:'S02', orderDate:'2026-09-20'
  }));
});

test('purchaser may assist create order only with a responsible owner', async () => {
  await assertSucceeds(setDoc(doc(db('buyer1'), 'orders/o3'), {
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-09-20'
  }));
  await assertFails(setDoc(doc(db('buyer1'), 'orders/o4'), {
    ownerUid:'buyer1', salesCode:'P01', orderDate:'2026-09-20'
  }));
});

test('engineer self-order is allowed but formal purchase order is denied', async () => {
  await assertSucceeds(setDoc(doc(db('eng1'), 'supplyOrders/s1'), {
    type:'SALES_SELF_ORDER', ownerUid:'eng1', salesCode:'E01', qty:2, cost:100
  }));
  await assertFails(setDoc(doc(db('eng1'), 'purchaseOrders/p1'), { status:'ORDERED' }));
});

test('business owner can perform only scoped fulfillment stock updates', async () => {
  await seed('inventory/p1', { onHand:10, reserved:2, productId:'p1', unitCost:100 });
  await assertSucceeds(updateDoc(doc(db('sales1'), 'inventory/p1'), { reserved:3 }));
  await assertSucceeds(updateDoc(doc(db('sales1'), 'inventory/p1'), { safetyStock:4 }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { productId:'hijack' }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { unitCost:1 }));
  await assertSucceeds(updateDoc(doc(db('wh1'), 'inventory/p1'), { reserved:3 }));
});

test('business owner can change only remaining quantity on an inventory lot', async () => {
  await seed('inventoryLots/lot1', { productId:'p1', remainingQty:5, unitCost:100 });
  await assertSucceeds(updateDoc(doc(db('sales1'), 'inventoryLots/lot1'), {
    remainingQty:4, updatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventoryLots/lot1'), { unitCost:1 }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventoryLots/lot1'), { remainingQty:-1 }));
});

test('assigned product-line owner can read protected cost; unassigned cannot', async () => {
  await seed('productCosts/c1', { productId:'p1', productLineId:'roche', unitCost:100 });
  await assertSucceeds(getDoc(doc(db('sales1'), 'productCosts/c1')));
  await assertFails(getDoc(doc(db('sales2'), 'productCosts/c1')));
});

test('legacy productLine remains compatible with assigned product-line authorization', async () => {
  await seed('productCosts/c2', { productId:'p2', productLine:'roche', unitCost:200 });
  await assertSucceeds(getDoc(doc(db('sales1'), 'productCosts/c2')));
  await assertFails(getDoc(doc(db('sales2'), 'productCosts/c2')));
});

test('only purchaser/admin can create dispatch paperwork record', async () => {
  const data = { ownerUid:'sales1', salesCode:'S01', orderId:'o1', itemId:'i1', qty:1 };
  await assertSucceeds(setDoc(doc(db('buyer1'), 'dispatchRecords/d1'), data));
  await assertFails(setDoc(doc(db('sales1'), 'dispatchRecords/d2'), data));
});

test('responsible business owner can create delivery for own order only', async () => {
  await assertSucceeds(setDoc(doc(db('sales1'), 'deliveries/d1'), {
    ownerUid:'sales1', salesCode:'S01', orderId:'o1', itemId:'i1', qty:1
  }));
  await assertFails(setDoc(doc(db('sales1'), 'deliveries/d2'), {
    ownerUid:'sales2', salesCode:'S02', orderId:'o2', itemId:'i1', qty:1
  }));
});

test('inventory movements and audit logs are immutable', async () => {
  await assertSucceeds(setDoc(doc(db('wh1'), 'inventoryMovements/m1'), {
    ownerUid:'sales1', salesCode:'S01', productId:'p1', qty:1, type:'RECEIPT'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'inventoryMovements/m1'), { qty:2 }));
  await assertSucceeds(setDoc(doc(db('sales1'), 'auditLogs/a1'), {
    actorUid:'sales1', action:'BILLING_TOGGLE'
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'auditLogs/a1'), { action:'OTHER' }));
});

test('purchaser order mutation is limited to dispatch items and updatedAt', async () => {
  await seed('orders/dispatch1', {
    ownerUid:'sales1', salesCode:'S01', customerName:'A',
    items:[{ itemId:'i1', qty:5, dispatchPreparedQty:0 }]
  });
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'orders/dispatch1'), {
    items:[{ itemId:'i1', qty:5, dispatchPreparedQty:5 }],
    updatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('buyer1'), 'orders/dispatch1'), {
    customerName:'Changed'
  }));
});
