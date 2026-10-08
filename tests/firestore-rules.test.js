const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const { collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, setDoc, updateDoc, where, writeBatch } = require('firebase/firestore');

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
  await seed('users/sales1', { role:'sales', active:true, salesCode:'S01' });
  await seed('users/sales2', { role:'sales', active:true, salesCode:'S02' });
  await seed('users/eng1', { role:'engineer', active:true, salesCode:'E01' });
  await seed('users/buyer1', { role:'purchaser', active:true, salesCode:'P01' });
  await seed('users/wh1', { role:'warehouse', active:true, salesCode:'W01' });
  await seed('users/off1', { role:'sales', active:false, salesCode:'OFF' });
  await seed('products/p-order', { productId:'p-order', brandName:'Roche', manufacturerPartNo:'P-ORDER', productName:'Order product', status:'ACTIVE', active:true });
});

const validOrderProduct = {
  productId:'p-order', productMasterMatched:true, procurementType:'PURCHASING_PO'
};

function db(uid) {
  return env.authenticatedContext(uid).firestore();
}

test('inactive user is denied', async () => {
  await assertFails(getDoc(doc(db('off1'), 'settings/company')));
});

test('engineer owns and can edit own quote and order, but cannot access Forecast', async () => {
  const quote = {
    ownerUid:'eng1', salesCode:'E01', quoteDate:'2026-09-20',
    createdByUid:'eng1', createdByName:'Engineer', createdByRole:'engineer'
  };
  await assertSucceeds(setDoc(doc(db('eng1'), 'quotes/q1'), quote));
  await assertSucceeds(setDoc(doc(db('eng1'), 'orders/o1'), { ...validOrderProduct, ...quote, orderDate:'2026-09-20' }));
  await assertFails(setDoc(doc(db('eng1'), 'forecasts/f1'), quote));
  await seed('forecasts/f1', quote);
  await assertSucceeds(updateDoc(doc(db('eng1'), 'quotes/q1'), { quoteDate:'2026-09-21' }));
  await assertSucceeds(updateDoc(doc(db('eng1'), 'orders/o1'), { orderDate:'2026-09-21' }));
  await assertFails(getDoc(doc(db('eng1'), 'forecasts/f1')));
  await assertFails(updateDoc(doc(db('eng1'), 'forecasts/f1'), { quoteDate:'2026-09-21' }));
  await assertFails(setDoc(doc(db('eng1'), 'forecasts/f1/progress/p1'), { text:'update' }));
  await assertSucceeds(getDoc(doc(db('admin'), 'forecasts/f1')));
});

test('engineer may assist salesperson quotes but not salesperson orders; purchaser assistance still requires matching owner code', async () => {
  const assistedQuote = {
    ownerUid:'sales1', salesCode:'S01', quoteDate:'2026-09-20',
    createdByUid:'eng1', createdByName:'Engineer', createdByRole:'engineer'
  };
  await assertSucceeds(setDoc(doc(db('eng1'), 'quotes/assisted-sales'), assistedQuote));
  await assertSucceeds(getDoc(doc(db('eng1'), 'quotes/assisted-sales')));
  await assertSucceeds(updateDoc(doc(db('eng1'), 'quotes/assisted-sales'), { quoteDate:'2026-09-21' }));
  await assertFails(setDoc(doc(db('eng1'), 'quotes/wrong-sales-code'), { ...assistedQuote, salesCode:'S02' }));
  await assertFails(setDoc(doc(db('eng1'), 'orders/assisted-sales'), { ...validOrderProduct,
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-09-20',
    createdByUid:'eng1', createdByName:'Engineer', createdByRole:'engineer'
  }));
  await assertFails(setDoc(doc(db('buyer1'), 'orders/bad-owner-code'), { ...validOrderProduct,
    ownerUid:'sales1', salesCode:'S02', orderDate:'2026-09-20',
    createdByUid:'buyer1', createdByName:'Buyer', createdByRole:'purchaser'
  }));
});

test('purchaser may create quotes for sales and engineers but not reassign commercial orders to engineer', async () => {
  const createdBy = { createdByUid:'buyer1', createdByName:'Buyer', createdByRole:'purchaser' };
  await assertSucceeds(setDoc(doc(db('buyer1'), 'quotes/assisted-sales'), {
    ownerUid:'sales1', salesCode:'S01', quoteDate:'2026-09-20', ...createdBy
  }));
  await assertSucceeds(setDoc(doc(db('buyer1'), 'quotes/assisted-engineer'), {
    ownerUid:'eng1', salesCode:'E01', quoteDate:'2026-09-20', ...createdBy
  }));
  await assertFails(setDoc(doc(db('buyer1'), 'quotes/wrong-engineer-code'), {
    ownerUid:'eng1', salesCode:'S01', quoteDate:'2026-09-20', ...createdBy
  }));
  await assertFails(setDoc(doc(db('buyer1'), 'orders/assisted-engineer'), { ...validOrderProduct,
    ownerUid:'eng1', salesCode:'E01', orderDate:'2026-09-20', ...createdBy
  }));
});

test('commercial creator audit fields cannot be rewritten by normal owner edits', async () => {
  await seed('quotes/creator-audit', {
    ownerUid:'sales1', salesCode:'S01', quoteDate:'2026-09-20',
    createdByUid:'eng1', createdByName:'Engineer', createdByRole:'engineer'
  });
  await assertSucceeds(updateDoc(doc(db('sales1'), 'quotes/creator-audit'), {
    quoteDate:'2026-09-21'
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'quotes/creator-audit'), {
    createdByUid:'sales1', createdByName:'Sales', createdByRole:'sales'
  }));
});

test('legacy commercial documents without creator metadata remain editable', async () => {
  await seed('orders/legacy-creator', {
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-09-20'
  });
  await assertSucceeds(updateDoc(doc(db('sales1'), 'orders/legacy-creator'), {
    orderDate:'2026-09-21'
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'orders/legacy-creator'), {
    createdByUid:'sales1', createdByName:'Sales', createdByRole:'sales'
  }));
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
  await assertFails(setDoc(doc(db('wh1'), 'orders/matrix-warehouse-order'), { ...validOrderProduct,
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-09-23'
  }));
});

test('sales cannot create a commercial document owned by another salesperson', async () => {
  await assertFails(setDoc(doc(db('sales1'), 'orders/o2'), { ...validOrderProduct,
    ownerUid:'sales2', salesCode:'S02', orderDate:'2026-09-20'
  }));
});

test('purchaser may assist create order only with a responsible owner', async () => {
  await assertSucceeds(setDoc(doc(db('buyer1'), 'orders/o3'), { ...validOrderProduct,
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-09-20'
  }));
  await assertFails(setDoc(doc(db('buyer1'), 'orders/o4'), { ...validOrderProduct,
    ownerUid:'buyer1', salesCode:'P01', orderDate:'2026-09-20'
  }));
});

test('self-order is restricted to the responsible business owner and becomes immutable after creation', async () => {
  await assertSucceeds(setDoc(doc(db('sales1'), 'supplyOrders/sales-self-order'), {
    type:'SALES_SELF_ORDER', ownerUid:'sales1', salesCode:'S01', qty:2, receivedQty:0, status:'ORDERED', supplier:'Vendor', unitCost:100
  }));
  await assertSucceeds(setDoc(doc(db('eng1'), 'supplyOrders/engineer-self-order'), {
    type:'SALES_SELF_ORDER', ownerUid:'eng1', salesCode:'E01', qty:2, receivedQty:0, status:'ORDERED', supplier:'Vendor', unitCost:100
  }));
  await assertFails(setDoc(doc(db('eng1'), 'supplyOrders/engineer-impersonation'), {
    type:'SALES_SELF_ORDER', ownerUid:'sales1', salesCode:'S01', qty:1, receivedQty:0, status:'ORDERED', supplier:'Vendor', unitCost:100
  }));
  await assertFails(setDoc(doc(db('eng1'), 'supplyOrders/engineer-wrong-code'), {
    type:'SALES_SELF_ORDER', ownerUid:'eng1', salesCode:'S01', qty:1, receivedQty:0, status:'ORDERED', supplier:'Vendor', unitCost:100
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'supplyOrders/sales-self-order'), { qty:99 }));
  await assertFails(updateDoc(doc(db('eng1'), 'supplyOrders/engineer-self-order'), { qty:99 }));
  await assertFails(updateDoc(doc(db('sales1'), 'supplyOrders/sales-self-order'), { receivedQty:2, status:'RECEIVED' }));
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'supplyOrders/sales-self-order'), { qty:3 }));
  await assertFails(setDoc(doc(db('eng1'), 'purchaseOrders/p1'), { status:'ORDERED' }));
});


test('self-order supplier and actual unit cost are required for each new supply record', async () => {
  for (const uid of ['sales1', 'eng1', 'buyer1', 'admin']) {
    const owner = uid === 'eng1' ? 'eng1' : 'sales1';
    const code = owner === 'eng1' ? 'E01' : 'S01';
    const ref=doc(db(uid), 'supplyOrders/self-required-'+uid);
    const base={type:'SALES_SELF_ORDER',ownerUid:owner,salesCode:code,
      supplier:'Vendor',unitCost:15,qty:1,receivedQty:0,status:'ORDERED'};
    await assertFails(setDoc(ref,{...base,supplier:''}));
    await assertFails(setDoc(ref,{...base,supplier:'   '}));
    await assertFails(setDoc(ref,{...base,unitCost:-1}));
    await assertFails(setDoc(ref,{...base,unitCost:'15'}));
    const {unitCost,...missingCost}=base;
    await assertFails(setDoc(ref,missingCost));
    const {supplier,...missingSupplier}=base;
    await assertFails(setDoc(ref,missingSupplier));
    await assertSucceeds(setDoc(ref,{...base,unitCost:0}));
  }
});


test('business owner can perform only scoped fulfillment stock updates', async () => {
  await seed('inventory/p1', { onHand:10, reserved:2, productId:'p1' });
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { reserved:3 }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { safetyStock:4 }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { productId:'hijack' }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/p1'), { unitCost:1 }));
  await assertSucceeds(updateDoc(doc(db('wh1'), 'inventory/p1'), { reserved:3 }));
});

test('inventory planning policy is admin or purchaser managed while warehouse keeps it unchanged', async () => {
  await seed('inventory/policy-buyer', { onHand:10, reserved:0, incoming:0, productId:'p1', stockPolicy:'ORDER_ONLY', safetyStock:0 });
  await seed('inventory/policy-admin', { onHand:10, reserved:0, incoming:0, productId:'p1', stockPolicy:'ORDER_ONLY', safetyStock:0 });
  await seed('inventory/policy-warehouse', { onHand:10, reserved:0, incoming:0, productId:'p1', stockPolicy:'SAFETY_STOCK', safetyStock:5 });

  await assertSucceeds(updateDoc(doc(db('buyer1'), 'inventory/policy-buyer'), {
    stockPolicy:'SAFETY_STOCK', safetyStock:6
  }));
  await assertSucceeds(updateDoc(doc(db('admin'), 'inventory/policy-admin'), {
    stockPolicy:'NO_STOCK'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'inventory/policy-warehouse'), {
    stockPolicy:'ORDER_ONLY'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'inventory/policy-warehouse'), {
    safetyStock:1
  }));
  await assertSucceeds(updateDoc(doc(db('wh1'), 'inventory/policy-warehouse'), {
    onHand:9, updatedAt:'2026-10-02T09:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventory/policy-buyer'), {
    stockPolicy:'NO_STOCK'
  }));
  await assertFails(updateDoc(doc(db('buyer1'), 'inventory/policy-buyer'), {
    stockPolicy:'INVALID'
  }));
});

test('business owner can change only remaining quantity on an inventory lot', async () => {
  await seed('inventoryLots/lot1', { productId:'p1', remainingQty:5 });
  await assertFails(updateDoc(doc(db('sales1'), 'inventoryLots/lot1'), {
    remainingQty:4, updatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventoryLots/lot1'), { unitCost:1 }));
  await assertFails(updateDoc(doc(db('sales1'), 'inventoryLots/lot1'), { remainingQty:-1 }));
});

test('business users cannot read Product Master standard costs', async () => {
  await seed('productCosts/p1', { productId:'p1', salesVisible:true, standardCost:100 });
  await seed('productCosts/p2', { productId:'p2', salesVisible:false, standardCost:200 });
  await assertFails(getDoc(doc(db('sales1'), 'productCosts/p1')));
  await assertFails(getDoc(doc(db('sales2'), 'productCosts/p2')));
  await assertSucceeds(getDoc(doc(db('buyer1'), 'productCosts/p1')));
  await assertSucceeds(getDoc(doc(db('buyer1'), 'productCosts/p2')));
});

test('sales may create a temporary product but cannot create or modify Product Master cost', async () => {
  const product = { productId:'p3', status:'TEMPORARY', active:true, source:'QUICK_CREATE', createdBy:'sales1', updatedBy:'sales1', listPrice:0, nameEn:'Test product', specification:'10 tests' };
  await assertSucceeds(setDoc(doc(db('sales1'), 'products/p3'), product));
  await assertFails(updateDoc(doc(db('sales1'), 'products/p3'), { listPrice:1 }));
  await assertFails(setDoc(doc(db('sales2'), 'products/p4'), { ...product, productId:'p4' }));
  await assertFails(setDoc(doc(db('sales1'), 'products/p5'), { ...product, productId:'p5', source:'PRICE_LIST' }));
  await assertFails(setDoc(doc(db('sales1'), 'products/p6'), { ...product, productId:'p6', active:false }));
  const cost = { productId:'p3', productLineId:'Roche', standardCost:100, salesVisible:false, source:'quick_create', updatedAt:'2026-09-23', updatedBy:'sales1' };
  await assertFails(setDoc(doc(db('sales1'), 'productCosts/p3'), cost));
  await assertSucceeds(setDoc(doc(db('buyer1'), 'productCosts/p3'), cost));
  await assertFails(setDoc(doc(db('sales1'), 'priceHistory/p3'), { productId:'p3', unitCost:1 }));
});

test('only admin can permanently delete Product Master and its standard cost', async () => {
  const product = { productId:'delete-admin', brandName:'Roche', manufacturerPartNo:'DEL-1', productName:'Delete test', status:'ACTIVE', active:true };
  await seed('products/delete-admin', product);
  await seed('products/delete-sales', { ...product, productId:'delete-sales' });
  await seed('products/delete-buyer', { ...product, productId:'delete-buyer' });
  await seed('productCosts/delete-admin', { productId:'delete-admin', standardCost:100 });
  await seed('productCosts/delete-sales', { productId:'delete-sales', standardCost:100 });
  await seed('productCosts/delete-buyer', { productId:'delete-buyer', standardCost:100 });

  await assertFails(deleteDoc(doc(db('sales1'), 'products/delete-sales')));
  await assertFails(deleteDoc(doc(db('buyer1'), 'products/delete-buyer')));
  await assertSucceeds(deleteDoc(doc(db('admin'), 'products/delete-admin')));

  await assertFails(deleteDoc(doc(db('sales1'), 'productCosts/delete-sales')));
  await assertFails(deleteDoc(doc(db('buyer1'), 'productCosts/delete-buyer')));
  await assertSucceeds(deleteDoc(doc(db('admin'), 'productCosts/delete-admin')));
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
  await assertFails(setDoc(doc(db('wh1'), 'inventoryLotCosts/newLot'), {
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


test('receiving roles may advance only receipt allocation progress within its target', async () => {
  await seed('receipts/r-progress', {
    receiptId:'r-progress', supplyOrderId:'s1',
    productKey:'p1', warehouseId:'w1', qty:5,
    autoAllocationQty:3, autoAllocatedQty:0, allocationCompleted:false
  });

  await assertSucceeds(updateDoc(doc(db('wh1'), 'receipts/r-progress'), {
    autoAllocatedQty:2,
    allocationCompleted:false,
    allocationUpdatedAt:'2026-10-01T08:00:00Z'
  }));
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'receipts/r-progress'), {
    autoAllocatedQty:3,
    allocationCompleted:true,
    allocationUpdatedAt:'2026-10-01T08:01:00Z'
  }));

  await assertFails(updateDoc(doc(db('wh1'), 'receipts/r-progress'), {
    autoAllocatedQty:2
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'receipts/r-progress'), {
    autoAllocatedQty:4
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'receipts/r-progress'), {
    qty:99
  }));
  await assertFails(updateDoc(doc(db('sales1'), 'receipts/r-progress'), {
    autoAllocatedQty:3
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

test('warehouse cannot mutate purchase-order snapshots; receiving state lives on supply orders', async () => {
  await seed('purchaseOrders/po-receive', {
    poNo:'PO-1', vendorName:'Vendor', items:[{ itemCode:'A', qty:5, unitPrice:100 }],
    status:'active', receiptStatus:'pending', receiptRecords:[]
  });
  await seed('supplyOrders/supply-receive', {
    type:'PURCHASING_PO', qty:5, receivedQty:0, incomingRegisteredQty:5,
    status:'ORDERED', purchaseDocumentId:'po-receive'
  });
  await assertFails(updateDoc(doc(db('wh1'), 'purchaseOrders/po-receive'), {
    receiptRecords:[{ itemIndex:0, qty:2 }],
    receiptStatus:'partial',
    updatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertSucceeds(updateDoc(doc(db('wh1'), 'supplyOrders/supply-receive'), {
    receivedQty:2,
    incomingRegisteredQty:3,
    status:'PARTIAL_RECEIPT',
    updatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'purchaseOrders/po-receive'), {
    vendorName:'Changed'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'purchaseOrders/po-receive'), {
    items:[{ itemCode:'A', qty:999, unitPrice:1 }]
  }));
});



test('purchaser may close only a partially received supply and terminal supply cannot receive again', async () => {
  await seed('supplyOrders/supply-close', {
    type:'PURCHASING_PO', qty:5, receivedQty:2, incomingRegisteredQty:3,
    status:'PARTIAL_RECEIPT', purchaseDocumentId:'po-close'
  });
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'supplyOrders/supply-close'), {
    status:'CLOSED',
    closedQty:3,
    closeReason:'供應商不再出貨',
    closedAt:'2026-10-02T06:00:00Z',
    closedByUid:'buyer1',
    closedBy:'Buyer',
    incomingRegisteredQty:0,
    updatedAt:'2026-10-02T06:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('wh1'), 'supplyOrders/supply-close'), {
    receivedQty:3,
    incomingRegisteredQty:0,
    status:'PARTIAL_RECEIPT',
    updatedAt:'2026-10-02T07:00:00Z'
  }));

  await seed('supplyOrders/supply-close-without-receipt', {
    type:'PURCHASING_PO', qty:5, receivedQty:0, incomingRegisteredQty:5,
    status:'ORDERED', purchaseDocumentId:'po-close-invalid'
  });
  await assertFails(updateDoc(doc(db('buyer1'), 'supplyOrders/supply-close-without-receipt'), {
    status:'CLOSED',
    closedQty:5,
    closeReason:'不應使用結案',
    closedAt:'2026-10-02T06:00:00Z',
    closedByUid:'buyer1',
    closedBy:'Buyer',
    incomingRegisteredQty:0,
    updatedAt:'2026-10-02T06:00:00Z'
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


test('purchaser may update reservation retry metadata but not commercial fields', async () => {
  await seed('orders/reservation-retry', {
    ownerUid:'sales1', salesCode:'S01', customerName:'A',
    inventoryReservationStatus:'failed',
    inventoryReservationError:'timeout',
    inventoryReservationUpdatedAt:'2026-09-20T00:00:00Z'
  });
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'orders/reservation-retry'), {
    inventoryReservationStatus:'pending',
    inventoryReservationError:'',
    inventoryReservationUpdatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('buyer1'), 'orders/reservation-retry'), {
    customerName:'Changed'
  }));
});

test('direct-ship delivery summary requires the matching supply update in the same atomic write', async () => {
  const seedOrder = {
    ownerUid:'sales1', salesCode:'S01', customerName:'A',
    items:[{ itemId:'i1', qty:2, receivedQty:0, deliveredQty:0 }],
    deliveryRecords:[], deliveredQty:0, isDelivered:false
  };
  const seedSupply = {
    type:'PURCHASING_PO',
    orderId:'', itemId:'i1', ownerUid:'sales1', salesCode:'S01', salesName:'Sales',
    customerName:'A', company:'yushin', productId:'p1', productKey:'p1',
    itemCode:'A', itemName:'Product', brand:'Brand', productLine:'',
    fulfillmentType:'DIRECT_SHIP', warehouseId:'', orderDate:'2026-09-21',
    createdAt:'2026-09-21T00:00:00Z', createdByUid:'buyer1', createdBy:'Buyer', createdByRole:'purchaser',
    qty:2, receivedQty:0, incomingRegisteredQty:0, cancelledQty:0, status:'ORDERED'
  };

  await seed('orders/direct-buyer', seedOrder);
  await seed('orders/direct-warehouse', seedOrder);
  await seed('supplyOrders/direct-supply-buyer', { ...seedSupply, orderId:'direct-buyer' });
  await seed('supplyOrders/direct-supply-warehouse', { ...seedSupply, orderId:'direct-warehouse' });

  const buildOrderFields = supplyId => ({
    items:[{ itemId:'i1', qty:2, receivedQty:2, deliveredQty:2 }],
    itemCount:1,
    orderSchemaVersion:2,
    deliveryRecords:[{
      id:'r1', itemId:'i1', qty:2,
      sourceType:'DIRECT_SHIP_RECEIPT', sourceId:supplyId
    }],
    deliveredQty:2,
    isDelivered:true,
    workCategories:['billing'],
    workCategoryUpdatedAt:'2026-09-21T00:00:00Z',
    updatedAt:'2026-09-21T00:00:00Z'
  });
  const supplyFields = {
    receivedQty:2,
    status:'RECEIVED',
    updatedAt:'2026-09-21T00:00:00Z'
  };

  const buyerDb=db('buyer1');
  const buyerBatch=writeBatch(buyerDb);
  buyerBatch.update(doc(buyerDb,'orders/direct-buyer'),buildOrderFields('direct-supply-buyer'));
  buyerBatch.update(doc(buyerDb,'supplyOrders/direct-supply-buyer'),supplyFields);
  await assertSucceeds(buyerBatch.commit());

  const warehouseDb=db('wh1');
  const warehouseBatch=writeBatch(warehouseDb);
  warehouseBatch.update(doc(warehouseDb,'orders/direct-warehouse'),buildOrderFields('direct-supply-warehouse'));
  warehouseBatch.update(doc(warehouseDb,'supplyOrders/direct-supply-warehouse'),supplyFields);
  await assertSucceeds(warehouseBatch.commit());

  await seed('orders/direct-standalone', seedOrder);
  await assertFails(updateDoc(doc(db('wh1'), 'orders/direct-standalone'), buildOrderFields('missing-supply')));
  await assertFails(updateDoc(doc(db('wh1'), 'orders/direct-warehouse'), {
    invoiceTitle:'Changed'
  }));
});


test("business owner cannot take over another user's reservation", async () => {
  await seed('inventoryReservations/res-owned-sales2', {
    ownerUid:'sales2', salesCode:'S02', orderId:'o2', itemId:'i1',
    productKey:'p1', quantity:1, shortageQty:0, status:'active'
  });

  await assertFails(updateDoc(doc(db('sales1'), 'inventoryReservations/res-owned-sales2'), {
    ownerUid:'sales1',
    salesCode:'S01',
    quantity:99
  }));
});

test('business owner may update own reservation without changing ownership', async () => {
  await seed('inventoryReservations/res-owned-sales1', {
    ownerUid:'sales1', salesCode:'S01', orderId:'o1', itemId:'i1',
    productKey:'p1', quantity:2, shortageQty:1, status:'active'
  });

  await assertFails(updateDoc(doc(db('sales1'), 'inventoryReservations/res-owned-sales1'), {
    quantity:1,
    shortageQty:2,
    status:'active',
    updatedAt:'2026-10-01T00:00:00Z'
  }));

  await assertFails(updateDoc(doc(db('sales1'), 'inventoryReservations/res-owned-sales1'), {
    ownerUid:'sales2',
    salesCode:'S02'
  }));
});


test('business owner may probe missing reservation slot but cannot read another owner reservation', async () => {
  await assertSucceeds(getDoc(doc(db('sales1'), 'inventoryReservations/missing-order__item-1')));

  await seed('inventoryReservations/private-sales2', {
    ownerUid:'sales2', salesCode:'S02', orderId:'o2', itemId:'i1',
    productKey:'p1', quantity:1, shortageQty:0, status:'active'
  });
  await assertFails(getDoc(doc(db('sales1'), 'inventoryReservations/private-sales2')));
});


test('business owner may create own reservation movement but cannot forge another owner', async () => {
  await assertSucceeds(setDoc(doc(db('sales1'), 'inventoryMovements/reserve-own'), {
    type:'reserve', qty:1, productKey:'p1', sourceType:'ORDER', sourceId:'o1',
    ownerUid:'sales1', salesCode:'S01'
  }));
  await assertFails(setDoc(doc(db('sales1'), 'inventoryMovements/reserve-other'), {
    type:'reserve', qty:1, productKey:'p1', sourceType:'ORDER', sourceId:'o2',
    ownerUid:'sales2', salesCode:'S02'
  }));
});


test('engineer assisted quote remains creator-scoped', async () => {
  await seed('users/eng2', { role:'engineer', active:true, salesCode:'E02' });
  await seed('quotes/engineer-assisted-scope', {
    ownerUid:'sales1', salesCode:'S01', quoteDate:'2026-09-20',
    createdByUid:'eng1', createdByName:'Engineer 1', createdByRole:'engineer'
  });
  await assertSucceeds(getDoc(doc(db('eng1'), 'quotes/engineer-assisted-scope')));
  await assertFails(getDoc(doc(db('eng2'), 'quotes/engineer-assisted-scope')));
  await assertFails(updateDoc(doc(db('eng2'), 'quotes/engineer-assisted-scope'), { quoteDate:'2026-09-22' }));
});


test('formal order creation requires a real Product Master and blocks embedded standard cost', async () => {
  const base = {
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-10-02',
    createdByUid:'sales1', createdByName:'Sales', createdByRole:'sales'
  };
  await assertFails(setDoc(doc(db('sales1'), 'orders/no-product'), {
    ...base, productMasterMatched:false, procurementType:'PURCHASING_PO'
  }));
  await assertFails(setDoc(doc(db('sales1'), 'orders/fake-product'), {
    ...base, productMasterMatched:true, productId:'does-not-exist', procurementType:'PURCHASING_PO'
  }));
  await assertSucceeds(setDoc(doc(db('sales1'), 'orders/valid-product'), {
    ...base, ...validOrderProduct
  }));
  await assertFails(setDoc(doc(db('sales1'), 'orders/standard-cost-leak'), {
    ...base, ...validOrderProduct, costPrice:123
  }));
  await assertSucceeds(setDoc(doc(db('sales1'), 'orders/self-order-cost'), {
    ...base, ...validOrderProduct, procurementType:'SALES_SELF_ORDER', costPrice:123, costSource:'business_manual_transaction_cost'
  }));
});

test('sales cannot add cost to a formal purchasing order after creation', async () => {
  await seed('orders/formal-cost-update', {
    ownerUid:'sales1', salesCode:'S01', orderDate:'2026-10-02',
    createdByUid:'sales1', createdByName:'Sales', createdByRole:'sales',
    ...validOrderProduct
  });
  await assertFails(updateDoc(doc(db('sales1'), 'orders/formal-cost-update'), { costPrice:99 }));
});

test('purchase communication timeline is purchaser-only and immutable', async () => {
  const event = {
    purchaseOrderId:'PO-1',
    purchaseOrderNo:'PO-1',
    supplierId:'sup-1',
    supplierName:'Supplier',
    recipientEmail:'orders@example.com',
    channel:'MAILTO',
    state:'PREPARED',
    verifiedSent:false,
    preparedAt:'2026-10-02T05:00:00.000Z',
    createdAt:'2026-10-02T05:00:00.000Z',
    createdByUid:'buyer1',
    createdBy:'Buyer'
  };
  await assertFails(setDoc(doc(db('buyer1'),'purchaseOrderCommunications/c1'),event));
  await seed('purchaseOrderCommunications/c1',event);
  await assertFails(setDoc(doc(db('sales1'),'purchaseOrderCommunications/c2'),{...event,createdByUid:'sales1'}));
  await assertFails(setDoc(doc(db('buyer1'),'purchaseOrderCommunications/c3'),{...event,verifiedSent:true}));
  await assertFails(updateDoc(doc(db('buyer1'),'purchaseOrderCommunications/c1'),{state:'SENT'}));
  await assertSucceeds(getDoc(doc(db('buyer1'),'purchaseOrderCommunications/c1')));
  await assertFails(getDoc(doc(db('sales1'),'purchaseOrderCommunications/c1')));
});

test('procurement demand permissions follow ERP ownership', async () => {
  const base={
    demandId:'SALES_ORDER:o1:i1',sourceType:'SALES_ORDER',sourceId:'o1',sourceItemId:'i1',
    ownerUid:'sales1',salesCode:'S01',requestedQty:5,orderedQty:0,receivedQty:0,
    remainingToOrderQty:5,remainingToReceiveQty:0,perOrdered:0,perReceived:0,status:'PENDING',
    createdAt:'2026-10-02T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z'
  };
  await assertSucceeds(setDoc(doc(db('sales1'),'procurementDemands/SALES_ORDER:o1:i1'),base));
  await assertFails(getDoc(doc(db('sales2'),'procurementDemands/SALES_ORDER:o1:i1')));
  await assertSucceeds(getDoc(doc(db('buyer1'),'procurementDemands/SALES_ORDER:o1:i1')));

  await assertSucceeds(updateDoc(doc(db('sales1'),'procurementDemands/SALES_ORDER:o1:i1'),{
    orderedQty:2,remainingToOrderQty:3,remainingToReceiveQty:2,perOrdered:40,status:'PARTIALLY_ORDERED',
    updatedAt:'2026-10-02T01:00:00Z'
  }));
  await assertFails(updateDoc(doc(db('sales1'),'procurementDemands/SALES_ORDER:o1:i1'),{
    receivedQty:1
  }));
  await assertSucceeds(updateDoc(doc(db('buyer1'),'procurementDemands/SALES_ORDER:o1:i1'),{
    receivedQty:1,remainingToReceiveQty:1,perReceived:20,status:'PARTIALLY_RECEIVED',
    updatedAt:'2026-10-02T02:00:00Z'
  }));

  await assertFails(setDoc(doc(db('sales1'),'procurementDemands/STOCK_REPLENISHMENT:p1'),{
    ...base,demandId:'STOCK_REPLENISHMENT:p1',sourceType:'STOCK_REPLENISHMENT',sourceId:'p1',sourceItemId:''
  }));
  await assertSucceeds(setDoc(doc(db('buyer1'),'procurementDemands/STOCK_REPLENISHMENT:p1'),{
    ...base,demandId:'STOCK_REPLENISHMENT:p1',sourceType:'STOCK_REPLENISHMENT',sourceId:'p1',sourceItemId:'',
    ownerUid:'',salesCode:''
  }));
});


async function archiveInventoryBatch(uid, id, archived, auditId='archive-audit', extras={}) {
  const client=db(uid),batch=writeBatch(client),at='2026-10-05T00:00:00.000Z';
  batch.update(doc(client,'inventory/'+id),{listArchived:archived,listArchiveChangedAt:at,
    listArchiveChangedByUid:uid,listArchiveAuditId:auditId,updatedAt:at,...extras});
  batch.set(doc(client,'auditLogs/'+auditId),{action:archived?'inventory_list_archive':'inventory_list_restore',
    actorUid:uid,inventoryId:id,createdAt:at,archived});
  return batch.commit();
}
test('only admin can archive zero stock with a new atomic audit and restore it',async()=>{
  await seed('inventory/archive1',{onHand:0,reserved:0,incoming:0,productId:'p1'});
  for(const uid of ['buyer1','wh1','sales1','eng1','off1'])
    await assertFails(archiveInventoryBatch(uid,'archive1',true,uid+'-audit'));
  await assertFails(updateDoc(doc(db('admin'),'inventory/archive1'),{listArchived:true}));
  await assertSucceeds(archiveInventoryBatch('admin','archive1',true));
  await assertFails(updateDoc(doc(db('buyer1'),'inventory/archive1'),{listArchived:false}));
  await assertFails(updateDoc(doc(db('sales1'),'inventory/archive1'),{reserved:1}));
  await assertSucceeds(archiveInventoryBatch('admin','archive1',false,'restore-audit'));
  await assertFails(deleteDoc(doc(db('admin'),'inventory/archive1')));
});
test('archive rejects nonzero stock and simultaneous quantity reset',async()=>{
  for(const field of ['onHand','reserved','incoming']){
    const id='archive-'+field;await seed('inventory/'+id,{onHand:0,reserved:0,incoming:0,[field]:1});
    await assertFails(archiveInventoryBatch('admin',id,true,field+'-audit'));
    await assertFails(archiveInventoryBatch('admin',id,true,field+'-reset',{[field]:0}));
  }
});
test('archive blocks forged metadata on create, invalid types and audit reuse',async()=>{
  await assertFails(setDoc(doc(db('buyer1'),'inventory/create-archive'),{onHand:0,reserved:0,listArchived:true}));
  await seed('inventory/archive2',{onHand:0,reserved:0,incoming:0});
  await assertFails(archiveInventoryBatch('admin','archive2',true,'wrong-type',{listArchived:'true'}));
  await assertFails(archiveInventoryBatch('admin','archive2',true,'wrong-actor',{listArchiveChangedByUid:'buyer1'}));
  await seed('auditLogs/reused',{actorUid:'admin',inventoryId:'archive2',archived:true,
    action:'inventory_list_archive',createdAt:'2026-10-05T00:00:00.000Z'});
  await assertFails(updateDoc(doc(db('admin'),'inventory/archive2'),{listArchived:true,
    listArchiveChangedByUid:'admin',listArchiveChangedAt:'2026-10-05T00:00:00.000Z',listArchiveAuditId:'reused'}));
});

const stockPermissions = require('../modules/stock-permissions.js');
const { runTransaction } = require('firebase/firestore');
function compatDb(uid) {
  const firestore = db(uid);
  let sequence = 0;
  return {
    collection: name => ({doc:id=>doc(firestore,name,id||`audit-${Date.now()}-${++sequence}`)}),
    runTransaction: callback => runTransaction(firestore, tx => callback({
      get:async ref=>{const snap=await tx.get(ref);return {exists:snap.exists(),data:()=>snap.data(),id:snap.id,ref};},
      set:(...args)=>tx.set(...args),update:(...args)=>tx.update(...args),delete:(...args)=>tx.delete(...args)
    }))
  };
}
async function seedStockWorkflow(){
  await seed('orders/stock-order',{ownerUid:'sales1',salesCode:'S01',deliveredQty:0,returnedQty:0,
    items:[{itemId:'item-1',productId:'p1',qty:5,warehouseId:'w1'}]});
  await seed('inventory/p1',{productKey:'p1',productId:'p1',onHand:10,reserved:0,incoming:0});
  await seed('warehouseStocks/w1-p1',{productKey:'p1',warehouseId:'w1',onHand:10,reserved:0,incoming:0});
  await seed('inventoryLots/l1',{productKey:'p1',warehouseId:'w1',remainingQty:10});
}
async function stockWorkflow(physicalDelta, reservationQty, type){
  const client=compatDb('sales1');
  return stockPermissions.run(client,async tx=>{
    const inv=client.collection('inventory').doc('p1');
    const wh=client.collection('warehouseStocks').doc('w1-p1');
    const res=client.collection('inventoryReservations').doc('stock-order__item-1');
    const order=client.collection('orders').doc('stock-order');
    const lot=client.collection('inventoryLots').doc('l1');
    const invSnap=await tx.get(inv),whSnap=await tx.get(wh),resSnap=await tx.get(res),orderSnap=await tx.get(order),lotSnap=await tx.get(lot);
    const oldReservation=resSnap.exists?resSnap.data().quantity:0;
    const reserveDelta=reservationQty-oldReservation;
    tx.update(inv,{onHand:invSnap.data().onHand+physicalDelta,reserved:invSnap.data().reserved+reserveDelta});
    tx.update(wh,{onHand:whSnap.data().onHand+physicalDelta,reserved:whSnap.data().reserved+reserveDelta});
    if(physicalDelta){
      tx.update(lot,{remainingQty:lotSnap.data().remainingQty+physicalDelta});
      if(type==='return_in')tx.update(order,{returnedQty:orderSnap.data().returnedQty+physicalDelta});
      else tx.update(order,{deliveredQty:orderSnap.data().deliveredQty-physicalDelta});
    }
    tx.set(res,{orderId:'stock-order',itemId:'item-1',productKey:'p1',warehouseId:'w1',ownerUid:'sales1',salesCode:'S01',quantity:reservationQty,shortageQty:0,status:'active'});
    tx.set(client.collection('inventoryMovements').doc(),{sourceId:'stock-order',sourceType:'order',productKey:'p1',ownerUid:'sales1',salesCode:'S01',type,qty:physicalDelta||reserveDelta,lotAllocations:physicalDelta?[{lotId:'l1',qty:type==='ship'?-physicalDelta:physicalDelta}]:[]});
  },'sales1',true,'sales');
}

test('commercial stock reservation delivery reversal and return require atomic source evidence',async()=>{
  await seedStockWorkflow();
  await assertSucceeds(stockWorkflow(0,5,'reserve'));
  await assertSucceeds(stockWorkflow(-2,3,'ship'));
  await assertSucceeds(stockWorkflow(2,5,'ship_reversal'));
  await assertSucceeds(stockWorkflow(-2,3,'ship'));
  await assertSucceeds(stockWorkflow(1,4,'return_in'));
  await assertFails(updateDoc(doc(db('sales1'),'inventory/p1'),{onHand:100}));
  await assertFails(updateDoc(doc(db('sales1'),'inventoryLots/l1'),{remainingQty:100}));
});

test('stock witness cannot be reused for a second stock change',async()=>{
  await seedStockWorkflow();await assertSucceeds(stockWorkflow(0,5,'reserve'));
  const stock=await getDoc(doc(db('sales1'),'inventory/p1'));
  await assertFails(updateDoc(doc(db('sales1'),'inventory/p1'),{reserved:4,stockOperationId:stock.data().stockOperationId}));
});

test('disabled-only accounts are denied by backend and commercial roles may probe missing order and quote IDs',async()=>{
  await seed('users/off2',{role:'sales',salesCode:'S02',active:true,disabled:true});
  await assertFails(getDoc(doc(db('off2'),'products/p-order')));
  await assertSucceeds(getDoc(doc(db('sales1'),'orders/new-slot')));
  await assertSucceeds(getDoc(doc(db('eng1'),'quotes/new-slot')));
});

test('purchaser and warehouse cannot rewrite embedded commercial line fields',async()=>{
  const item={itemId:'i1',productId:'p1',itemCode:'ABC',itemName:'Product',qty:5,unitPrice:100,reservedQty:0,receivedQty:0};
  await seed('orders/protected-lines',{ownerUid:'sales1',salesCode:'S01',items:[item]});
  for(const uid of ['buyer1','wh1']){
    for(const field of ['productId','itemCode','itemName','qty','unitPrice']){
      await assertFails(updateDoc(doc(db(uid),'orders/protected-lines'),{items:[{...item,[field]:field==='qty'||field==='unitPrice'?999:'Changed'}]}));
    }
    await assertSucceeds(updateDoc(doc(db(uid),'orders/protected-lines'),{items:[{...item,receivedQty:2}]}));
  }
});

test('warehouse receives a sanitized supply view and cannot read company purchase costs',async()=>{
  const supply={type:'PURCHASING_PO',status:'ORDERED',qty:5,receivedQty:0,incomingRegisteredQty:5,productKey:'p1',unitCost:120};
  await seed('supplyOrders/private-supply',supply);
  await seed('purchaseOrders/private-po',{items:[{qty:5,unitPrice:120}]});
  await assertSucceeds(setDoc(doc(db('buyer1'),'receivingSupplyOrders/private-supply'),stockPermissions.sanitizeSupply(supply)));
  await assertSucceeds(getDoc(doc(db('wh1'),'receivingSupplyOrders/private-supply')));
  await assertFails(getDoc(doc(db('wh1'),'supplyOrders/private-supply')));
  await assertFails(getDoc(doc(db('wh1'),'purchaseOrders/private-po')));
  await assertFails(setDoc(doc(db('wh1'),'receivingSupplyOrders/forged'),{qty:999}));
  const client=compatDb('wh1');
  await assertSucceeds(stockPermissions.run(client,async tx=>{
    const ref=client.collection('supplyOrders').doc('private-supply');
    const source=await tx.get(ref);
    assert.equal(source.data().unitCost,undefined);
    tx.update(ref,{receivedQty:2,incomingRegisteredQty:3,status:'PARTIAL_RECEIPT'});
    tx.set(client.collection('inventoryLots').doc('private-lot'),{sourceId:'private-supply',sourceType:'SUPPLY_ORDER',remainingQty:2});
    tx.set(client.collection('inventoryLotCosts').doc('private-lot'),{lotId:'private-lot',sourceType:'SUPPLY_ORDER',sourceId:'private-supply',costSourceSupplyId:'private-supply'});
  },'wh1',false,'warehouse'));
  await assertFails(updateDoc(doc(db('buyer1'),'supplyOrders/private-supply'),{unitCost:999}));
  const privateSource=await getDoc(doc(db('buyer1'),'supplyOrders/private-supply'));
  assert.equal(privateSource.data().unitCost,120);
});

test('engineer list and history search include only its own assisted quotes',async()=>{
  await seed('quotes/assisted-list',{ownerUid:'sales1',salesCode:'S01',createdByUid:'eng1',createdByRole:'engineer',quoteDate:'2026-10-06',searchTokens:['product']});
  await seed('quotes/other-assistant',{ownerUid:'sales1',salesCode:'S01',createdByUid:'sales1',createdByRole:'sales',quoteDate:'2026-10-06',searchTokens:['product']});
  const list=query(collection(db('eng1'),'quotes'),where('createdByUid','==','eng1'),where('createdByRole','==','engineer'),orderBy('quoteDate','desc'),limit(50));
  await assertSucceeds(getDocs(list));
  await assertSucceeds(getDocs(query(collection(db('eng1'),'quotes'),where('createdByUid','==','eng1'),where('createdByRole','==','engineer'),where('searchTokens','array-contains','product'),limit(50))));
  await assertFails(getDoc(doc(db('eng1'),'quotes/other-assistant')));
});

test('operational line validation supports thirty lines without losing commercial protection',async()=>{
  const items=Array.from({length:30},(_,i)=>({itemId:'i'+i,productId:'p1',qty:1,unitPrice:100,receivedQty:0}));
  await seed('orders/thirty-lines',{ownerUid:'sales1',salesCode:'S01',items});
  await assertSucceeds(updateDoc(doc(db('buyer1'),'orders/thirty-lines'),{items:items.map(row=>({...row,receivedQty:1}))}));
  await assertSucceeds(updateDoc(doc(db('wh1'),'orders/thirty-lines'),{items:items.map(row=>({...row,receivedQty:2}))}));
  await assertFails(updateDoc(doc(db('buyer1'),'orders/thirty-lines'),{items:items.map((row,i)=>({...row,unitPrice:i===29?1:100}))}));
});

test('multi-product reservation uses the matching product movement for each stock witness',async()=>{
 const client=compatDb('sales1');
 const items=['p1','p2'].map((productId,i)=>({itemId:'item-'+(i+1),productId,qty:5,warehouseId:'w1'}));
 await seed('orders/multi-stock',{ownerUid:'sales1',salesCode:'S01',items});
 for(const productId of ['p1','p2'])await seed('inventory/'+productId,{productKey:productId,onHand:10,reserved:0});
 await assertSucceeds(stockPermissions.run(client,async tx=>{
  const refs=items.map(item=>client.collection('inventory').doc(item.productId));
  await Promise.all(refs.map(ref=>tx.get(ref)));
  await tx.get(client.collection('orders').doc('multi-stock'));
  items.forEach((item,i)=>{
   tx.update(refs[i],{reserved:5});
   tx.set(client.collection('inventoryReservations').doc('multi-stock__'+item.itemId),{orderId:'multi-stock',itemId:item.itemId,productKey:item.productId,warehouseId:'w1',ownerUid:'sales1',salesCode:'S01',quantity:5});
   tx.set(client.collection('inventoryMovements').doc(),{sourceId:'multi-stock',sourceType:'order',productKey:item.productId,ownerUid:'sales1',salesCode:'S01',type:'reserve',qty:5});
  });
 },'sales1',true,'sales'));
});

test('business owner may request a return but may not record received returns directly', async () => {
  const order={...validOrderProduct,ownerUid:'sales1',salesCode:'S01',deliveredQty:2,returnedQty:0,items:[{itemId:'I1',qty:2}],returnRequests:[],returnRecords:[]};
  await seed('orders/customer-return',order);
  const request={id:'Q1',itemId:'I1',qty:1,receivedQty:0,status:'PENDING',settlement:'CLOSE',createdByUid:'sales1'};
  await assertSucceeds(updateDoc(doc(db('sales1'),'orders/customer-return'),{returnRequests:[request],returnPending:true,returnRequestMutationIndex:0}));
  await assertFails(updateDoc(doc(db('sales1'),'orders/customer-return'),{returnedQty:1,returnRecords:[{id:'R1',itemId:'I1',qty:1}]}));
  await assertFails(updateDoc(doc(db('sales2'),'orders/customer-return'),{returnPending:false}));
});
test('warehouse return receipt must atomically settle the pending request and append its matching record',async()=>{
  const request={id:'Q1',itemId:'I1',qty:1,receivedQty:0,status:'PENDING',settlement:'CLOSE',createdByUid:'sales1'};
  const order={...validOrderProduct,ownerUid:'sales1',salesCode:'S01',deliveredQty:2,returnedQty:0,items:[{itemId:'I1',qty:2}],returnRequests:[request],returnRecords:[],returnPending:true};
  await seed('orders/customer-return',order);
  const record={id:'R1',requestId:'Q1',itemId:'I1',qty:1,settlement:'CLOSE',quality:'INSPECTION',warehouseId:'W1'};
  const receipt={orderId:'customer-return',requestId:'Q1',requestIndex:0,itemId:'I1',qty:1,quality:'INSPECTION',warehouseId:'W1',disposition:'HOLD',record,receivedBy:'wh1',ownerUid:'sales1',salesCode:'S01'};
  await assertFails(setDoc(doc(db('wh1'),'customerReturnReceipts/R1'),receipt));
  const client=db('wh1');
  const batch=writeBatch(client);
  batch.set(doc(client,'customerReturnReceipts/R1'),receipt);
  batch.update(doc(client,'orders/customer-return'),{returnReceiptId:'R1',returnRequests:[{...request,receivedQty:1,status:'RECEIVED'}],returnPending:false,returnedQty:1,returnRecords:[record]});
  await assertSucceeds(batch.commit());
  await assertFails(updateDoc(doc(db('sales1'),'customerReturnReceipts/R1'),{disposition:'STOCK',releasedBy:'sales1',releasedAt:'now'}));
});
test('only purchasing can keep a cancelled customer procurement as stock',async()=>{
  await seed('orders/customer-cancelled',{...validOrderProduct,ownerUid:'sales1',salesCode:'S01',orderStatus:'cancelled'});
  await seed('supplyOrders/keep-stock',{orderId:'customer-cancelled',productKey:'P1',status:'ORDERED',qty:2,receivedQty:0,fulfillmentType:'WAREHOUSE',warehouseId:'W1',incomingRegisteredQty:2});
  const patch={customerCancellationDisposition:'KEEP_STOCK',customerCancellationResolvedAt:'now',customerCancellationResolvedBy:'buyer1',updatedAt:'now'};
  await assertFails(updateDoc(doc(db('wh1'),'supplyOrders/keep-stock'),patch));
  await assertSucceeds(updateDoc(doc(db('buyer1'),'supplyOrders/keep-stock'),patch));
});

test('removed external notice feature rejects new notices and updates for all roles',async()=>{
  await seed('externalDispatchNotices/old',{ownerUid:'sales1',salesCode:'S01',status:'NOTIFIED'});
  for(const uid of ['admin','buyer1','wh1','sales1']){
    await assertFails(setDoc(doc(db(uid),'externalDispatchNotices/new'),{status:'NOTIFIED'}));
    await assertFails(updateDoc(doc(db(uid),'externalDispatchNotices/old'),{status:'SHIPPED'}));
  }
});

test('completed delivery blocks cancellation including combined flag reset, for admin and owner', async () => {
  for (const uid of ['admin', 'sales1']) {
    await seed('orders/completed', {ownerUid:'sales1',salesCode:'S01',status:'active',orderStatus:'normal',isDelivered:true,deliveredQty:1,deliveryRecords:[{id:'D1',qty:1}]});
    const ref=doc(db(uid),'orders/completed');
    await assertFails(updateDoc(ref,{status:'cancelled',orderStatus:'cancelled'}));
    await assertFails(updateDoc(ref,{status:'cancelled',orderStatus:'cancelled',isDelivered:false,deliveredQty:0,deliveryRecords:[]}));
    await assertSucceeds(updateDoc(ref,{orderStatusReason:'Delivery note correction'}));
  }
});

test('partial delivery allows remaining cancellation but preserves delivery evidence', async () => {
  await seed('orders/partial-cancel', {ownerUid:'sales1',salesCode:'S01',status:'active',orderStatus:'normal',isDelivered:false,deliveredQty:1,deliveryRecords:[{id:'D1',qty:1}]});
  await assertFails(updateDoc(doc(db('sales1'),'orders/partial-cancel'),{status:'cancelled',orderStatus:'cancelled',deliveryRecords:[]}));
  await assertSucceeds(updateDoc(doc(db('sales1'),'orders/partial-cancel'),{status:'cancelled',orderStatus:'cancelled'}));
});

async function seedWarehouseShipment(){
  const item={itemId:'I1',warehouseId:'W1',productId:'p-order',qty:3,reservedQty:3,dispatchPreparedQty:3};
  const order={...validOrderProduct,ownerUid:'sales1',salesCode:'S01',status:'active',orderStatus:'normal',items:[item],deliveryRecords:[],deliveredQty:0};
  await seed('orders/warehouse-ship',order);
  await seed('inventory/p-order',{productKey:'p-order',onHand:5,reserved:3,incoming:0});
  await seed('warehouseStocks/W1__p-order',{productKey:'p-order',warehouseId:'W1',onHand:5,reserved:3,incoming:0});
  await seed('inventoryReservations/warehouse-ship__I1',{orderId:'warehouse-ship',itemId:'I1',productKey:'p-order',warehouseId:'W1',quantity:3});
  return {item,order};
}
function warehouseShipmentBatch(client,uid,item,{stock=true,extra={},qty=1}={}){
  const batch=writeBatch(client),record={id:'SHIP1',orderId:'warehouse-ship',itemId:'I1',itemIndex:0,productKey:'p-order',warehouseId:'W1',date:'2026-10-06',qty,sourceType:'INVENTORY_SHIPMENT',createdByUid:uid,movementId:'SHIP-M1'};
  batch.set(doc(client,'inventoryMovements/SHIP-M1'),{type:'ship',sourceId:'warehouse-ship',itemId:'I1',warehouseId:'W1',productKey:'p-order',qty:-qty,actorUid:uid,warehouseStockId:'W1__p-order',inventoryDocId:'p-order'});
  if(stock){batch.update(doc(client,'inventory/p-order'),{onHand:5-qty,reserved:3-qty});batch.update(doc(client,'warehouseStocks/W1__p-order'),{onHand:5-qty,reserved:3-qty});}
  batch.update(doc(client,'inventoryReservations/warehouse-ship__I1'),{quantity:3-qty});
  batch.update(doc(client,'orders/warehouse-ship'),{inventoryShipmentRecordId:'SHIP1',items:[{...item,reservedQty:3-qty,warehouseShippedQty:qty}],deliveryRecords:[record],deliveredQty:qty,isDelivered:qty>=3,...extra});
  return batch;
}
test('warehouse shipment records physical stock and reservation in the same atomic batch for receiver roles',async()=>{
  for(const uid of ['wh1','buyer1']){
    const {item}=await seedWarehouseShipment();
    await assertSucceeds(warehouseShipmentBatch(db(uid),uid,item).commit());
    const order=await getDoc(doc(db(uid),'orders/warehouse-ship'));assert.equal(order.data().deliveredQty,1);
    await env.withSecurityRulesDisabled(async ctx=>{await deleteDoc(doc(ctx.firestore(),'inventoryMovements/SHIP-M1'));});
  }
});
test('warehouse shipment rejects stock-free writes, unprepared stock, commercial changes and cancelled orders',async()=>{
  for(const options of [{stock:false},{extra:{unitPrice:999}},{qty:4}]){
    const {item}=await seedWarehouseShipment();await assertFails(warehouseShipmentBatch(db('wh1'),'wh1',item,options).commit());
  }
  let {item}=await seedWarehouseShipment();await seed('orders/warehouse-ship',{...(await getDoc(doc(db('admin'),'orders/warehouse-ship'))).data(),items:[{...item,dispatchPreparedQty:0}]});
  await assertFails(warehouseShipmentBatch(db('wh1'),'wh1',{...item,dispatchPreparedQty:0}).commit());
  ({item}=await seedWarehouseShipment());await assertSucceeds(updateDoc(doc(db('admin'),'orders/warehouse-ship'),{orderStatus:'cancelled',status:'cancelled'}));
  await assertFails(warehouseShipmentBatch(db('wh1'),'wh1',item).commit());
});
test('commercial owner cannot invoke warehouse shipment marker directly',async()=>{
  const {item}=await seedWarehouseShipment();await assertFails(warehouseShipmentBatch(db('sales1'),'sales1',item).commit());
});

test('quick manual purchase requires supplier and nonnegative actual cost for admin and purchaser', async () => {
  for (const uid of ['admin','buyer1']) {
    const ref=doc(db(uid),'supplyOrders/quick-'+uid);
    const base={type:'PURCHASING_MANUAL',supplier:'Vendor',unitCost:50,qty:2,receivedQty:0,status:'ORDERED',incomingRegisteredQty:2};
    await assertFails(setDoc(ref,{...base,supplier:''}));
    await assertSucceeds(setDoc(ref,{...base,unitCost:0}));
    await assertFails(setDoc(ref,{...base,unitCost:-1}));
    const {unitCost,...missingCost}=base;
    await assertFails(setDoc(ref,missingCost));
    await assertFails(setDoc(ref,{...base,unitCost:'50'}));
    await assertSucceeds(setDoc(ref,base));
    await assertFails(updateDoc(ref,{qty:3,unitCost:60}));
    await assertSucceeds(updateDoc(ref,{qty:3,incomingRegisteredQty:3}));
  }
});
