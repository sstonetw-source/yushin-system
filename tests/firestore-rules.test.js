const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const { collection, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where } = require('firebase/firestore');

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
  await seed('users/admin', { role:'admin', email:'admin@admin.com', name:'admin', salesCode:'ADM' });
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

test('five-role mutation matrix keeps master commercial purchase and receipt boundaries distinct', async () => {
  await assertSucceeds(setDoc(doc(db('admin'), 'brands/roche'), {
    name:'Roche', aliases:[], active:true
  }));
  await assertFails(setDoc(doc(db('sales1'), 'brands/unauthorized'), {
    name:'Unauthorized', active:true
  }));

  await assertSucceeds(setDoc(doc(db('sales1'), 'quotes/matrix-sales'), {
    ownerUid:'sales1', salesCode:'S01', quoteDate:'2026-09-23'
  }));
  await assertSucceeds(setDoc(doc(db('eng1'), 'equipment/matrix-engineer'), {
    ownerUid:'sales1', salesCode:'S01', customerName:'A', model:'M1'
  }));
  await assertSucceeds(setDoc(doc(db('buyer1'), 'purchaseOrders/matrix-purchase'), {
    status:'ORDERED', items:[{ itemCode:'A', qty:2 }]
  }));
  await assertFails(setDoc(doc(db('sales1'), 'purchaseOrders/matrix-sales-po'), {
    status:'ORDERED', items:[{ itemCode:'A', qty:2 }]
  }));

  await assertSucceeds(setDoc(doc(db('wh1'), 'receipts/matrix-receipt'), {
    ownerUid:'sales1', salesCode:'S01', productKey:'p1', qty:2
  }));
  await assertFails(setDoc(doc(db('wh1'), 'orders/matrix-warehouse-order'), {
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-09-23'
  }));
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
  await seed('inventory/p1', { onHand:10, reserved:2, productId:'p1' });
  await assertSucceeds(updateDoc(doc(db('sales1'), 'inventory/p1'), { reserved:3 }));
  await assertSucceeds(updateDoc(doc(db('sales1'), 'inventory/p1'), { safetyStock:4 }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { productId:'hijack' }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { unitCost:1 }));
  await assertSucceeds(updateDoc(doc(db('wh1'), 'inventory/p1'), { reserved:3 }));
});

test('business owner can change only remaining quantity on an inventory lot', async () => {
  await seed('inventoryLots/lot1', { productId:'p1', remainingQty:5 });
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

test('purchaser cannot mutate forecasts as a dispatch workaround', async () => {
  await seed('forecasts/f1', { ownerUid:'sales1', salesCode:'S01', status:'進行中' });
  await assertFails(updateDoc(doc(db('buyer1'), 'forecasts/f1'), { status:'win' }));
});

test('warehouse can update receipt-driven order quantities but not commercial fields', async () => {
  await seed('orders/receipt1', {
    ownerUid:'sales1', salesCode:'S01', customerName:'A',
    items:[{ itemId:'i1', qty:5, reservedQty:0, shortageQty:5 }]
  });
  await assertSucceeds(updateDoc(doc(db('wh1'), 'orders/receipt1'), {
    items:[{ itemId:'i1', qty:5, reservedQty:2, shortageQty:3 }],
    itemCount:1, orderSchemaVersion:2, updatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'orders/receipt1'), { customerName:'Changed' }));
});


test('operational lot is readable but embedded lot cost is denied to business roles', async () => {
  await seed('inventoryLots/publicLot', { productId:'p1', productKey:'p1', warehouseId:'w1', remainingQty:5 });
  await seed('inventoryLots/legacyCostLot', { productId:'p1', productKey:'p1', warehouseId:'w1', remainingQty:5, unitCost:100 });
  await assertSucceeds(getDoc(doc(db('sales1'), 'inventoryLots/publicLot')));
  await assertFails(getDoc(doc(db('sales1'), 'inventoryLots/legacyCostLot')));
  await assertSucceeds(getDoc(doc(db('admin'), 'inventoryLots/legacyCostLot')));
});

test('lot cost is physically protected from sales engineer and warehouse', async () => {
  await seed('inventoryLotCosts/lot1', { lotId:'lot1', productId:'p1', unitCost:100 });
  await assertSucceeds(getDoc(doc(db('admin'), 'inventoryLotCosts/lot1')));
  await assertSucceeds(getDoc(doc(db('buyer1'), 'inventoryLotCosts/lot1')));
  await assertFails(getDoc(doc(db('sales1'), 'inventoryLotCosts/lot1')));
  await assertFails(getDoc(doc(db('eng1'), 'inventoryLotCosts/lot1')));
  await assertFails(getDoc(doc(db('wh1'), 'inventoryLotCosts/lot1')));
});

test('warehouse can create protected lot cost during receipt without being able to read it back', async () => {
  await assertSucceeds(setDoc(doc(db('wh1'), 'inventoryLotCosts/newLot'), {
    lotId:'newLot', productId:'p1', unitCost:120
  }));
  await assertFails(getDoc(doc(db('wh1'), 'inventoryLotCosts/newLot')));
});

test('operational receipt and movement reject embedded cost fields', async () => {
  await assertFails(setDoc(doc(db('wh1'), 'receipts/r-cost'), {
    productKey:'p1', qty:1, unitCost:100
  }));
  await assertFails(setDoc(doc(db('wh1'), 'inventoryMovements/m-cost'), {
    productKey:'p1', qty:1, type:'receipt', unitCost:100
  }));
});

test('business owner can read own self-order but not formal supply order cost record', async () => {
  await seed('supplyOrders/self1', { type:'SALES_SELF_ORDER', ownerUid:'sales1', salesCode:'S01', unitCost:100 });
  await seed('supplyOrders/formal1', { type:'PURCHASING_PO', ownerUid:'sales1', salesCode:'S01', unitCost:80 });
  await assertSucceeds(getDoc(doc(db('sales1'), 'supplyOrders/self1')));
  await assertFails(getDoc(doc(db('sales1'), 'supplyOrders/formal1')));
});


test('shared stock documents reject embedded cost fields', async () => {
  await seed('inventory/legacyCost', { onHand:2, reserved:0, unitCost:100 });
  await seed('warehouseStocks/legacyCost', { onHand:2, reserved:0, unitCost:100 });
  await assertFails(getDoc(doc(db('sales1'), 'inventory/legacyCost')));
  await assertFails(getDoc(doc(db('sales1'), 'warehouseStocks/legacyCost')));
  await assertSucceeds(getDoc(doc(db('admin'), 'inventory/legacyCost')));
  await assertSucceeds(getDoc(doc(db('admin'), 'warehouseStocks/legacyCost')));
  await assertFails(setDoc(doc(db('wh1'), 'inventory/newCost'), { onHand:1, reserved:0, unitCost:50 }));
  await assertFails(setDoc(doc(db('wh1'), 'warehouseStocks/newCost'), { onHand:1, reserved:0, cost:50 }));
});

test('warehouse purchase order update is limited to receipt workflow fields', async () => {
  await seed('purchaseOrders/po-receive', {
    poNo:'PO-1', vendorName:'Vendor', items:[{ itemCode:'A', qty:5, unitPrice:100 }],
    status:'active', receiptStatus:'pending', receiptRecords:[]
  });
  await assertSucceeds(updateDoc(doc(db('wh1'), 'purchaseOrders/po-receive'), {
    receiptRecords:[{ itemIndex:0, qty:2 }],
    receiptStatus:'partial',
    updatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'purchaseOrders/po-receive'), {
    vendorName:'Changed'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'purchaseOrders/po-receive'), {
    items:[{ itemCode:'A', qty:999, unitPrice:1 }]
  }));
});


test('signed-in user can bootstrap-read own user profile', async () => {
  await assertSucceeds(getDoc(doc(db('sales1'), 'users/sales1')));
  await assertFails(getDoc(doc(db('unknown-user'), 'users/sales1')));
});


test('admin without active field can read core production collections', async () => {
  await seed('forecasts/f-admin', { ownerUid:'sales1', salesCode:'S01', status:'進行中' });
  await seed('orders/o-admin', { ownerUid:'sales1', salesCode:'S01', orderDate:'2026-09-21' });
  await seed('inventory/i-admin', { onHand:1, reserved:0 });
  await assertSucceeds(getDoc(doc(db('admin'), 'forecasts/f-admin')));
  await assertSucceeds(getDoc(doc(db('admin'), 'orders/o-admin')));
  await assertSucceeds(getDoc(doc(db('admin'), 'inventory/i-admin')));
});


test('admin without active field can run the exact Forecast list query', async () => {
  await seed('forecasts/f-query', {
    ownerUid:'sales1', salesCode:'S01', status:'active', updatedAt:'2026-09-21T14:00:00Z'
  });
  const q = query(
    collection(db('admin'), 'forecasts'),
    orderBy('updatedAt', 'desc'),
    where('status', '==', 'active'),
    limit(50)
  );
  await assertSucceeds(getDocs(q));
});
