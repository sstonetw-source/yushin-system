const fs = require('node:fs');
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails
} = require('@firebase/rules-unit-testing');
const { arrayUnion, collection, deleteDoc, doc, getDoc, getDocs, limit, orderBy, query, setDoc, startAfter, updateDoc, where, writeBatch } = require('firebase/firestore');

let env;

test('members sync only their own Auth token email without changing protected profile fields',async()=>{
 const client=env.authenticatedContext('sales1',{email:'sales1@example.com'}).firestore();
 await assertSucceeds(updateDoc(doc(client,'users/sales1'),{email:'sales1@example.com'}));
 await assertFails(updateDoc(doc(client,'users/sales1'),{email:'other@example.com'}));
 await assertFails(updateDoc(doc(client,'users/sales2'),{email:'sales1@example.com'}));
 for(const patch of [{role:'admin'},{salesCode:'S02'},{active:false},{deliveryDefaults:{mode:'PICKUP'}}])
  await assertFails(updateDoc(doc(client,'users/sales1'),{email:'sales1@example.com',...patch}));
});

test('inventory lots reject invalid quantities and relabelled product location or source for every receiver role',async()=>{
 const base={productKey:'p-order',productId:'p-order',warehouseId:'W1',remainingQty:3,qty:3,sourceType:'SUPPLY_ORDER',sourceId:'S1'};
 for(const uid of ['admin','buyer1','wh1']){
  const ref=doc(db(uid),'inventoryLots/bounded');
  for(const patch of [{remainingQty:-1},{remainingQty:'3'},{qty:-1},{receivedQty:-1},{productKey:''},{warehouseId:''},{cost:9},{costPrice:9}])
   await assertFails(setDoc(ref,{...base,...patch}));
  await assertSucceeds(setDoc(ref,base));
  for(const patch of [{remainingQty:-1},{remainingQty:'2'},{productKey:'OTHER'},{productId:'OTHER'},{warehouseId:'W2'},{sourceId:'S2'},{sourceType:'INITIAL_STOCK'},{unitCost:100}])
   await assertFails(updateDoc(ref,patch));
  await assertSucceeds(updateDoc(ref,{remainingQty:2}));
 }
});

async function seedOperationalReserve(count=1){
 await env.withSecurityRulesDisabled(async ctx=>{
  for(let i=0;i<count;i++)await deleteDoc(doc(ctx.firestore(),'inventoryReservations/evidence__I'+i));
  await deleteDoc(doc(ctx.firestore(),'inventoryMovements/RESERVE-EVIDENCE'));
 });
 const items=Array.from({length:count},(_,i)=>({itemId:'I'+i,productId:'p-order',qty:5,warehouseId:'W1'}));
 await seed('orders/evidence',{ownerUid:'sales1',salesCode:'S01',items});
 await seed('inventory/p-order',{productKey:'p-order',onHand:20,reserved:0,incoming:0});
 await seed('warehouseStocks/W1__p-order',{productKey:'p-order',warehouseId:'W1',onHand:20,reserved:0,incoming:0});
}
function operationalReserveBatch(uid,count=1,{aggregate=true,warehouse=true,movement=true,ids=null,delta=count,reservationPatch={}}={}){
 const client=db(uid),b=writeBatch(client),reservationIds=ids||Array.from({length:count},(_,i)=>'evidence__I'+i);
 if(aggregate)b.update(doc(client,'inventory/p-order'),{reserved:delta});
 if(warehouse)b.update(doc(client,'warehouseStocks/W1__p-order'),{reserved:delta});
 const evidence={inventoryId:'p-order',warehouseStockId:'W1__p-order',previousWarehouseStockId:'W1__p-order',movementId:'RESERVE-EVIDENCE',reservationIds};
 if(movement)b.set(doc(client,'inventoryMovements/RESERVE-EVIDENCE'),{type:'reserve',qty:count,sourceId:'evidence',productKey:'p-order',warehouseId:'W1',reservationStockEvidence:evidence});
 for(let i=0;i<count;i++)b.set(doc(client,'inventoryReservations/evidence__I'+i),{
  orderId:'evidence',itemId:'I'+i,orderItemIndex:i,productKey:'p-order',warehouseId:'W1',ownerUid:'sales1',salesCode:'S01',quantity:1,shortageQty:4,
  stockEvidence:evidence,...reservationPatch
 });return b;
}
test('operational reservation changes require both stock totals and a new matching movement',async()=>{
 for(const uid of ['buyer1','wh1']){
  await seedOperationalReserve();
  const client=db(uid),base={orderId:'evidence',itemId:'I0',orderItemIndex:0,productKey:'p-order',warehouseId:'W1',ownerUid:'sales1',salesCode:'S01',quantity:1};
  await assertFails(setDoc(doc(client,'inventoryReservations/evidence__I0'),base));
  for(const options of [{aggregate:false},{warehouse:false},{movement:false},{delta:2},{ids:['evidence__I0','evidence__I0']},{ids:['other__I0']}])
   await assertFails(operationalReserveBatch(uid,1,options).commit());
  await assertSucceeds(operationalReserveBatch(uid).commit());
  await assertFails(updateDoc(doc(client,'inventoryReservations/evidence__I0'),{quantity:2}));
  await env.withSecurityRulesDisabled(async ctx=>{await deleteDoc(doc(ctx.firestore(),'inventoryMovements/RESERVE-EVIDENCE'));});
 }
});
test('five same-product reservations prove the combined delta without exceeding rule limits',async()=>{
 await seedOperationalReserve(5);
 await assertSucceeds(operationalReserveBatch('buyer1',5).commit());
 const stock=await getDoc(doc(db('buyer1'),'inventory/p-order'));assert.equal(stock.data().reserved,5);
});

test('reservation release on cancellation changes stock once and cannot reuse its ledger',async()=>{
 await seedOperationalReserve();await assertSucceeds(operationalReserveBatch('buyer1').commit());
 await seed('orders/evidence',{ownerUid:'sales1',salesCode:'S01',status:'cancelled',items:[{itemId:'I0',productId:'p-order',qty:5,warehouseId:'W1'}]});
 const client=db('buyer1'),b=writeBatch(client),e={inventoryId:'p-order',warehouseStockId:'W1__p-order',previousWarehouseStockId:'W1__p-order',movementId:'RELEASE-E',reservationIds:['evidence__I0']};
 b.update(doc(client,'inventory/p-order'),{reserved:0});b.update(doc(client,'warehouseStocks/W1__p-order'),{reserved:0});
 b.update(doc(client,'inventoryReservations/evidence__I0'),{quantity:0,shortageQty:0,stockEvidence:e});
 b.set(doc(client,'inventoryMovements/RELEASE-E'),{productKey:'p-order',warehouseId:'W1',sourceId:'evidence',type:'release',qty:-1,reservationStockEvidence:e});
 await assertSucceeds(b.commit());await assertFails(updateDoc(doc(client,'inventoryReservations/evidence__I0'),{quantity:1}));
});

test('reservation warehouse moves must release the source and reserve the destination in the same operation',async()=>{
 await seedOperationalReserve();await assertSucceeds(operationalReserveBatch('buyer1').commit());
 await seed('orders/evidence',{ownerUid:'sales1',salesCode:'S01',items:[{itemId:'I0',productId:'p-order',qty:5,warehouseId:'W2'}]});
 await seed('warehouseStocks/W2__p-order',{productKey:'p-order',warehouseId:'W2',onHand:20,reserved:0,incoming:0});
 const move=source=>{
  const client=db('wh1'),b=writeBatch(client),e={inventoryId:'p-order',warehouseStockId:'W2__p-order',previousWarehouseStockId:'W1__p-order',movementId:'MOVE-E',reservationIds:['evidence__I0']};
  if(source)b.update(doc(client,'warehouseStocks/W1__p-order'),{reserved:0});
  b.update(doc(client,'warehouseStocks/W2__p-order'),{reserved:1});
  b.update(doc(client,'inventoryReservations/evidence__I0'),{warehouseId:'W2',stockEvidence:e});
  b.set(doc(client,'inventoryMovements/MOVE-E'),{productKey:'p-order',warehouseId:'W2',sourceId:'evidence',type:'warehouse_transfer',qty:1,reservationStockEvidence:e});return b.commit();
 };
 await assertFails(move(false));await assertSucceeds(move(true));
});
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

test('purchaser may assist sales and engineer quotes and orders without changing their owner', async () => {
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
  await assertSucceeds(setDoc(doc(db('buyer1'), 'orders/assisted-engineer'), { ...validOrderProduct,
    ownerUid:'eng1', salesCode:'E01', orderDate:'2026-09-20', ...createdBy
  }));
  await assertSucceeds(getDoc(doc(db('eng1'), 'orders/assisted-engineer')));
  await assertFails(getDoc(doc(db('sales1'), 'orders/assisted-engineer')));
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'orders/assisted-engineer'), {remarks:'代辦備註'}));
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'quotes/assisted-engineer'), {quoteDate:'2026-09-21'}));
  await assertFails(updateDoc(doc(db('buyer1'), 'orders/assisted-engineer'), {ownerUid:'sales1',salesCode:'S01'}));
  await assertFails(updateDoc(doc(db('buyer1'), 'quotes/assisted-engineer'), {ownerUid:'sales1',salesCode:'S01'}));
  await assertFails(updateDoc(doc(db('buyer1'), 'orders/assisted-engineer'), {createdByUid:'eng1'}));
  await assertFails(updateDoc(doc(db('buyer1'), 'quotes/assisted-engineer'), {createdByUid:'eng1'}));
  await seed('quotes/closed-assisted-engineer',{ownerUid:'eng1',salesCode:'E01',...createdBy,dealClosed:true});
  await assertSucceeds(updateDoc(doc(db('buyer1'),'quotes/closed-assisted-engineer'),{quoteDate:'2026-09-21'}));
  await assertFails(updateDoc(doc(db('buyer1'),'quotes/closed-assisted-engineer'),{dealClosed:false}));
  for (const patch of [{isBilled:true},{isDelivered:true},{status:'cancelled',orderStatus:'cancelled'}]) {
    await assertFails(updateDoc(doc(db('buyer1'), 'orders/assisted-engineer'), patch));
  }
  for (const owner of [
    {ownerUid:'eng1',salesCode:'S01'},
    {ownerUid:'buyer1',salesCode:'P01'},
    {ownerUid:'wh1',salesCode:'W01'},
    {ownerUid:'off1',salesCode:'OFF'},
    {ownerUid:'nonexistent',salesCode:'X'}
  ]) {
    await assertFails(setDoc(doc(db('buyer1'), 'orders/invalid-assisted-owner'), {...validOrderProduct,...owner,...createdBy}));
    await assertFails(setDoc(doc(db('buyer1'), 'quotes/invalid-assisted-owner'), {...owner,...createdBy}));
  }
  await seed('users/eng1',{role:'engineer',active:true,disabled:true,salesCode:'E01'});
  await assertFails(setDoc(doc(db('buyer1'), 'orders/disabled-engineer'), {...validOrderProduct,ownerUid:'eng1',salesCode:'E01',...createdBy}));
  await assertFails(setDoc(doc(db('buyer1'), 'quotes/disabled-engineer'), {ownerUid:'eng1',salesCode:'E01',...createdBy}));
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
  await assertFails(updateDoc(doc(db('buyer1'), 'orders/reservation-retry'), {
    inventoryReservationStatus:'pending',
    inventoryReservationError:'',
    inventoryReservationUpdatedAt:'2026-09-21T00:00:00Z'
  }));
  await assertSucceeds(updateDoc(doc(db('buyer1'), 'orders/reservation-retry'), {
    inventoryReservationStatus:'pending',
    inventoryReservationAttemptId:'retry-attempt',
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
  await assertFails(buyerBatch.commit());

  const warehouseDb=db('wh1');
  const warehouseBatch=writeBatch(warehouseDb);
  warehouseBatch.update(doc(warehouseDb,'orders/direct-warehouse'),buildOrderFields('direct-supply-warehouse'));
  warehouseBatch.update(doc(warehouseDb,'supplyOrders/direct-supply-warehouse'),supplyFields);
  await assertFails(warehouseBatch.commit());

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

test('business costs cannot bypass protection through nested lines or procurement method changes', async () => {
  const base={...validOrderProduct,ownerUid:'sales1',salesCode:'S01',items:[{itemId:'I1',productId:'p-order',qty:2,procurementType:'PURCHASING_PO'}]};
  await seed('orders/nested-cost',base);
  const ref=doc(db('sales1'),'orders/nested-cost');
  for(const field of ['costPrice','unitCost','cost']){
    await assertFails(updateDoc(ref,{items:[{...base.items[0],[field]:99}]}));
  }
  await assertFails(updateDoc(ref,{procurementType:'SALES_SELF_ORDER',costPrice:99}));
  await assertFails(updateDoc(ref,{items:[{...base.items[0],procurementType:'SALES_SELF_ORDER',costPrice:99}]}));
  await assertSucceeds(updateDoc(ref,{remarks:'正常商務備註'}));
  const self={...base,procurementType:'SALES_SELF_ORDER',items:[{...base.items[0],procurementType:'SALES_SELF_ORDER',costPrice:20}]};
  await seed('orders/self-cost-edit',self);
  await assertSucceeds(updateDoc(doc(db('sales1'),'orders/self-cost-edit'),{items:[{...self.items[0],costPrice:21}]}));
  await assertFails(updateDoc(doc(db('sales1'),'orders/self-cost-edit'),{items:[{...self.items[0],costPrice:-1}]}));
});

test('business order progress cannot be forged without an atomic physical delivery',async()=>{
  await seedStockWorkflow();
  const ref=doc(db('sales1'),'orders/stock-order');
  for(const patch of [{deliveredQty:2},{isDelivered:true},{receivedQty:2},{isArrived:true},{isOrdered:true},{qty:999},
    {deliveryRecords:[{id:'fake',itemId:'item-1',qty:2}],deliveredQty:2,businessDeliveryEvidence:{recordIndex:0}}]){
    await assertFails(updateDoc(ref,patch));
  }
  await assertFails(setDoc(doc(db('sales1'),'inventoryReservations/stock-order__item-1'),{
    orderId:'stock-order',itemId:'item-1',productKey:'p1',warehouseId:'w1',ownerUid:'sales1',salesCode:'S01',quantity:5
  }));
  await assertSucceeds(stockWorkflow(0,5,'reserve'));
  await assertSucceeds(stockWorkflow(-2,3,'ship'));
  const live=(await getDoc(ref)).data();
  await assertSucceeds(updateDoc(ref,{deliveryRecords:live.deliveryRecords.map(r=>({...r,notes:'修正備註'})),businessDeliveryEvidence:{recordIndex:0}}));
  await assertFails(updateDoc(ref,{deliveredQty:3,deliveryRecords:[{id:'ship-1',itemId:'item-1',qty:3}],businessDeliveryEvidence:live.businessDeliveryEvidence}));
  await assertSucceeds(stockWorkflow(2,5,'ship_reversal'));
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

test('procurement demands reject false sources, rewritten identities and inconsistent quantities for operational roles',async()=>{
 await seed('orders/source',{ownerUid:'sales1',salesCode:'S01',items:[{itemId:'A',productId:'p-order',qty:5,warehouseId:'W1'}]});
 const base={demandId:'SALES_ORDER:source:A',sourceType:'SALES_ORDER',sourceId:'source',sourceItemId:'A',sourceItemIndex:0,
  ownerUid:'sales1',salesCode:'S01',productId:'p-order',productKey:'p-order',requestedQty:5,orderedQty:2,receivedQty:1,
  remainingToOrderQty:3,remainingToReceiveQty:1,perOrdered:40,perReceived:20,status:'PARTIALLY_RECEIVED'};
 for(const uid of ['admin','buyer1','wh1']){
  const ref=doc(db(uid),'procurementDemands/'+uid);
  for(const patch of [{sourceId:'missing',demandId:'SALES_ORDER:missing:A'},{sourceItemId:'B',demandId:'SALES_ORDER:source:B'},
   {sourceItemIndex:2},{productKey:'OTHER'},{ownerUid:'sales2'},{receivedQty:3},{orderedQty:6},{requestedQty:'5'},
   {remainingToOrderQty:4},{remainingToReceiveQty:2},{status:'RECEIVED'},{status:'invalid'}])await assertFails(setDoc(ref,{...base,...patch}));
  await assertSucceeds(setDoc(ref,base));
  for(const patch of [{sourceId:'other'},{sourceItemId:'B'},{productId:'OTHER'},{ownerUid:'sales2'},
   {receivedQty:3},{remainingToOrderQty:100},{orderedQty:'2'},{status:'RECEIVED'}])await assertFails(updateDoc(ref,patch));
  await assertSucceeds(updateDoc(ref,{status:'CANCELLED',remainingToOrderQty:0}));
  await assertSucceeds(updateDoc(ref,{receivedQty:2,remainingToReceiveQty:0}));
 }
});
test('operational reservations bind to the exact source item and follow its warehouse through atomic transfer',async()=>{
 await seed('orders/source',{ownerUid:'sales1',salesCode:'S01',items:[{itemId:'A',productId:'p-order',qty:5,warehouseId:'W1'}]});
 const base={orderId:'source',itemId:'A',orderItemIndex:0,productKey:'p-order',ownerUid:'sales1',salesCode:'S01',warehouseId:'W1',quantity:2,shortageQty:3};
 for(const uid of ['admin','buyer1','wh1']){
  const client=db(uid),ref=doc(client,'inventoryReservations/source__A');
  for(const patch of [{orderId:'missing'},{itemId:'B'},{orderItemIndex:3},{productKey:'OTHER'},{ownerUid:'sales2'},
   {quantity:6},{quantity:'2'},{shortageQty:-1},{warehouseId:'W2'}])await assertFails(setDoc(ref,{...base,...patch}));
  await assertSucceeds(setDoc(ref,base));
  for(const patch of [{orderId:'other'},{itemId:'B'},{productKey:'OTHER'},{quantity:6},{shortageQty:'3'},{warehouseId:'W2'}])await assertFails(updateDoc(ref,patch));
 }
 const client=db('admin'),b=writeBatch(client);
 b.update(doc(client,'orders/source'),{items:[{itemId:'A',productId:'p-order',qty:5,warehouseId:'W2'}]});
 b.update(doc(client,'inventoryReservations/source__A'),{warehouseId:'W2'});await assertSucceeds(b.commit());
 await seed('orders/source',{ownerUid:'sales1',salesCode:'S01',status:'cancelled',items:[{itemId:'A',productId:'p-order',qty:5,warehouseId:'W2'}]});
 await assertFails(updateDoc(doc(client,'inventoryReservations/source__A'),{quantity:1}));
 await assertSucceeds(updateDoc(doc(client,'inventoryReservations/source__A'),{quantity:0,shortageQty:0}));
});
test('procurement demand permissions follow ERP ownership', async () => {
  await seed('orders/o1',{ownerUid:'sales1',salesCode:'S01',items:[{itemId:'i1',productId:'p-order',qty:5,warehouseId:'W1'}]});
  const base={
    demandId:'SALES_ORDER:o1:i1',sourceType:'SALES_ORDER',sourceId:'o1',sourceItemId:'i1',
    sourceItemIndex:0,productKey:'p-order',productId:'p-order',
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
const vm = require('node:vm');
const receivingCore = require('../modules/receiving-core.js');
const supplyCore = require('../modules/supply-core.js');
const demandCore = require('../modules/procurement-demand-core.js');

async function directReceiptFixture(uid='sales1',role='sales',ownerUid=uid) {
 const item={itemId:'I',productId:'P',qty:3,orderedQty:3,reservedQty:0,shortageQty:0,receivedQty:0,supplyOrderedQty:3,deliveredQty:0,directShipDeliveredQty:0,fulfillmentType:'DIRECT_SHIP',warehouseId:''};
 const salesCode=ownerUid==='eng1'?'E01':'S01';
 const demand=demandCore.demandDocument({sourceType:'SALES_ORDER',sourceId:'direct-owner',sourceItemId:'I',sourceItemIndex:0,
  productId:'P',productKey:'P',fulfillmentType:'DIRECT_SHIP',ownerUid,salesCode,requestedQty:3,orderedQty:3,receivedQty:0});
 const supply={type:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'direct-owner',sourceItemId:'I',orderId:'direct-owner',itemId:'I',orderItemIndex:0,
  demandId:demand.demandId,ownerUid,salesCode,productId:'P',productKey:'P',qty:3,receivedQty:0,incomingRegisteredQty:0,cancelledQty:0,closedQty:0,
  fulfillmentType:'DIRECT_SHIP',warehouseId:'',status:'ORDERED',unitCost:123,supplier:'Vendor'};
 await seed('orders/direct-owner',{ownerUid,salesCode,status:'active',items:[item],deliveryRecords:[],returnRecords:[],deliveredQty:0,isDelivered:false});
 await seed('supplyOrders/direct-owner',supply);await seed('receivingSupplyOrders/direct-owner',stockPermissions.sanitizeSupply(supply));
 await seed('procurementDemands/'+encodeURIComponent(demand.demandId),demand);
 const client=compatDb(uid),nativeRun=client.runTransaction,plain=value=>JSON.parse(JSON.stringify(value));
 client.runTransaction=callback=>nativeRun(tx=>callback({...tx,set:(ref,data,options)=>options?tx.set(ref,plain(data),options):tx.set(ref,plain(data)),update:(ref,data)=>tx.update(ref,plain(data))}));
 const context=vm.createContext({db:client,currentUser:{uid},currentUserRole:role,permissionRulesReady:true,deliveryActor:()=>uid,localDateString:()=> '2026-10-14',
  YushinSupply:supplyCore,YushinReceiving:receivingCore,YushinProcurementDemand:demandCore,YushinReservation:require('../modules/reservation-core'),window:{YushinReceiving:receivingCore},
  supplyOrdersCollection:()=>client.collection('supplyOrders'),procurementDemandRef:id=>client.collection('procurementDemands').doc(encodeURIComponent(id)),
  procurementDemandDocument:(d,c,m)=>demandCore.demandDocument({...d,...c},m),
  runRoleTransaction:callback=>stockPermissions.run(client,callback,uid,['sales','engineer'].includes(role),role),
  isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED'].includes(s),inventoryProductKey:i=>i.productId,
  orderInventorySyncIncomplete:()=>false,normalizedOrderItems:o=>o.items.map(i=>({...i})),
  normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
  savedDeliveryRecords:o=>o.deliveryRecords||[],returnedQuantity:()=>0,orderQuantity:o=>o.items.reduce((s,i)=>s+i.qty,0),orderWorkIndexFields:()=>({workCategories:['billing']})});
 const app=fs.readFileSync('app.js','utf8');
 vm.runInContext(app.slice(app.indexOf('function canConfirmSupplyReceipt('),app.indexOf('function canManageEquipmentCapability(')),context);
 vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),context);
 return {context,client,supply,demand};
}
for(const [uid,role] of [['sales1','sales'],['eng1','engineer']])test(`${role} confirms own direct shipment partially and retries without cost access or stock movement`,async()=>{
 const f=await directReceiptFixture(uid,role);
 await f.context.receiveSupplyOrderRecord('direct-owner',1,'','','direct-event-1');
 await f.context.receiveSupplyOrderRecord('direct-owner',1,'','','direct-event-1');
 await f.context.receiveSupplyOrderRecord('direct-owner',2,'','','direct-event-2');
 assert.equal((await getDoc(doc(db('admin'),'supplyOrders/direct-owner'))).data().receivedQty,3);
 assert.equal((await getDoc(doc(db('admin'),'supplyOrders/direct-owner'))).data().unitCost,123);
 assert.equal((await getDoc(doc(db('admin'),'orders/direct-owner'))).data().deliveredQty,3);
 assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent(f.demand.demandId)))).data().receivedQty,3);
 assert.equal((await getDocs(collection(db('admin'),'receipts'))).size,2);
 for(const name of ['inventory','warehouseStocks','inventoryLots','inventoryMovements'])assert.equal((await getDocs(collection(db('admin'),name))).size,0);
 await assertFails(getDoc(doc(db(uid),'supplyOrders/direct-owner')));
 await seed('receivingSupplyOrders/another-direct',{ownerUid:'sales2',fulfillmentType:'DIRECT_SHIP'});
 await assertFails(getDoc(doc(db(uid),'receivingSupplyOrders/another-direct')));
});
test('direct arrival rejects purchaser, warehouse, unrelated owner, overreceipt, cancelled order and standalone replay',async()=>{
 for(const [uid,role] of [['buyer1','purchaser'],['wh1','warehouse'],['sales2','sales']]){
  const f=await directReceiptFixture(uid,role,'sales1');
  await assert.rejects(f.context.receiveSupplyOrderRecord('direct-owner',1,'','','forged-'+uid));
 }
 const f=await directReceiptFixture();
 await assert.rejects(f.context.receiveSupplyOrderRecord('direct-owner',4,'','','too-many'));
 await assertFails(updateDoc(doc(db('sales1'),'supplyOrders/direct-owner'),{receivedQty:1,status:'PARTIAL_RECEIPT'}));
 await assertFails(updateDoc(doc(db('sales1'),'procurementDemands/'+encodeURIComponent(f.demand.demandId)),{receivedQty:1,remainingToReceiveQty:2,status:'PARTIALLY_RECEIVED'}));
 await seed('orders/direct-owner',{ownerUid:'sales1',salesCode:'S01',status:'cancelled',items:[],deliveryRecords:[]});
 await assert.rejects(f.context.receiveSupplyOrderRecord('direct-owner',1,'','','cancelled'));
});
test('direct owner can execute the exact cost-free supply query but not another owner scope',async()=>{
 await directReceiptFixture();
 const q=query(collection(db('sales1'),'receivingSupplyOrders'),where('ownerUid','==','sales1'),where('orderId','==','direct-owner'),where('itemId','==','I'),where('fulfillmentType','==','DIRECT_SHIP'),limit(50));
 await assertSucceeds(getDocs(q));
 await assertFails(getDocs(query(collection(db('sales2'),'receivingSupplyOrders'),where('ownerUid','==','sales1'),where('fulfillmentType','==','DIRECT_SHIP'))));
});
test('self-order creation can read a missing cost-free view and creates its exact projection atomically',async()=>{
 const client=compatDb('sales1');
 const self={type:'SALES_SELF_ORDER',ownerUid:'sales1',salesCode:'S01',supplier:'Vendor',unitCost:12,qty:2,status:'ORDERED',fulfillmentType:'WAREHOUSE'};
 await stockPermissions.run(client,async tx=>{
  const ref=client.collection('supplyOrders').doc('new-self');const snapshot=await tx.get(ref);assert.equal(snapshot.exists,false);tx.set(ref,self);
 },'sales1',true,'sales');
 assert.equal((await getDoc(doc(db('admin'),'supplyOrders/new-self'))).data().unitCost,12);
 assert.equal('unitCost' in (await getDoc(doc(db('sales1'),'receivingSupplyOrders/new-self'))).data(),false);
});
test('transfer allocation checkpoint is monotonic and cannot change physical facts or be written by a business role',async()=>{
 await seed('stockTransfers/checkpoint',{status:'RECEIVED',orderId:'',qty:5,reservedQty:0,autoAllocationQty:5,autoAllocatedQty:0,allocationCompleted:false});
 await assertSucceeds(updateDoc(doc(db('buyer1'),'stockTransfers/checkpoint'),{autoAllocatedQty:2,allocationCompleted:false}));
 for(const patch of [{autoAllocatedQty:1},{autoAllocatedQty:6},{qty:9},{autoAllocationQty:9},{status:'IN_TRANSIT'},{allocationCompleted:'true'}])
  await assertFails(updateDoc(doc(db('wh1'),'stockTransfers/checkpoint'),patch));
 await assertFails(updateDoc(doc(db('sales1'),'stockTransfers/checkpoint'),{allocationCompleted:true}));
 await assertSucceeds(updateDoc(doc(db('wh1'),'stockTransfers/checkpoint'),{allocationCompleted:true}));
});

// Exercise the real receipt transaction, not only its individual writes. Current
// order creation stores status=active and does not require an orderStatus field.
for (const [uid, role] of [['admin','admin'], ['buyer1','purchaser'], ['wh1','warehouse']]) {
  test(`${role} receives an active customer order atomically and retries without duplicate stock`, async () => {
    const productKey='prd:qiagen:52304', warehouseId='wh:company';
    const item={itemId:'I1',productId:productKey,qty:1,orderedQty:1,warehouseId,
      reservedQty:0,shortageQty:1,receivedQty:0,supplyOrderedQty:1,fulfillmentType:'WAREHOUSE'};
    await seed('orders/receipt-order',{ownerUid:'sales1',salesCode:'S01',status:'active',items:[item]});
    const demand=demandCore.demandDocument({demandId:'SALES_ORDER:receipt-order:I1',sourceType:'SALES_ORDER',
      sourceId:'receipt-order',sourceItemId:'I1',sourceItemIndex:0,productId:productKey,productKey,
      ownerUid:'sales1',salesCode:'S01',requestedQty:1,orderedQty:1,receivedQty:0,scheduleDate:'2026-10-20'});
    await seed('procurementDemands/'+encodeURIComponent(demand.demandId),demand);
    const supply={type:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'receipt-order',sourceItemId:'I1',
      orderId:'receipt-order',itemId:'I1',orderItemIndex:0,demandId:demand.demandId,ownerUid:'sales1',salesCode:'S01',
      productId:productKey,productKey,itemCode:'52304',qty:1,receivedQty:0,incomingRegisteredQty:1,
      status:'ORDERED',warehouseId,unitCost:10,fulfillmentType:'WAREHOUSE',supplier:'Vendor',
      scheduleDate:'2026-11-01',expectedDate:'2026-11-01'};
    await seed('supplyOrders/receipt-supply',supply);
    await seed('receivingSupplyOrders/receipt-supply',stockPermissions.sanitizeSupply(supply));
    const invPath='inventory/'+encodeURIComponent(productKey);
    const stockPath='warehouseStocks/'+encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey);
    await seed(invPath,{productId:productKey,productKey,onHand:0,reserved:0,incoming:1});
    await seed(stockPath,{productId:productKey,productKey,warehouseId,onHand:0,reserved:0,incoming:1});
    await seed('inventoryReservations/receipt-order__I1',{orderId:'receipt-order',itemId:'I1',orderItemIndex:0,
      ownerUid:'sales1',salesCode:'S01',productKey,warehouseId,quantity:0,shortageQty:1,status:'shortage'});
    const client=compatDb(uid), nativeRun=client.runTransaction;
    const plain=value=>JSON.parse(JSON.stringify(value));
    client.runTransaction=callback=>nativeRun(tx=>callback({...tx,
      set:(ref,data,options)=>options?tx.set(ref,plain(data),options):tx.set(ref,plain(data)),
      update:(ref,data)=>tx.update(ref,plain(data))}));
    const context=vm.createContext({db:client,currentUser:{uid},currentUserRole:role,permissionRulesReady:true,
      deliveryActor:()=>uid,localDateString:()=> '2026-10-12',YushinSupply:supplyCore,YushinReceiving:receivingCore,canConfirmSupplyReceipt:()=>true,
      YushinProcurementDemand:demandCore,YushinReservation:require('../modules/reservation-core'),window:{YushinReceiving:receivingCore},
      supplyOrdersCollection:()=>client.collection(role==='warehouse'?'receivingSupplyOrders':'supplyOrders'),
      procurementDemandRef:id=>id?client.collection('procurementDemands').doc(encodeURIComponent(id)):null,
      procurementDemandDocument:(d,c,m)=>demandCore.demandDocument({...d,...c},m),
      runRoleTransaction:callback=>stockPermissions.run(client,callback,uid,false,role),
      isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED'].includes(s),inventoryProductKey:i=>i.productId,orderInventorySyncIncomplete:()=>false,
      normalizedOrderItems:order=>order.items.map(i=>({...i})),normalizedOrderStatus:order=>
        [order.status,order.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
      inventoryNumbers:i=>({onHand:Number(i.onHand||0),reserved:Number(i.reserved||0),incoming:Number(i.incoming||0)}),
      warehouseStockDocId:(w,p)=>encodeURIComponent(w)+'__'+encodeURIComponent(p),
      orderWorkIndexFields:()=>({workCategories:['dispatch']}),buildInventorySearchTokens:()=>[],
      invalidateWarehouseStockCache:()=>{}});
    const app=fs.readFileSync('app.js','utf8'),start=app.indexOf('async function receiveSupplyOrderRecord(');
    vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),context);
    await context.receiveSupplyOrderRecord('receipt-supply',1,'LOT','','receipt-operation');
    await context.receiveSupplyOrderRecord('receipt-supply',1,'LOT','','receipt-operation');
    for(const path of [invPath,stockPath]){
      const data=(await getDoc(doc(db('admin'),path))).data();
      assert.deepEqual([data.onHand,data.reserved,data.incoming],[1,1,0]);
    }
    assert.equal((await getDoc(doc(db('admin'),'supplyOrders/receipt-supply'))).data().receivedQty,1);
    assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent(demand.demandId)))).data().receivedQty,1);
    assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent(demand.demandId)))).data().scheduleDate,'2026-10-20');
    assert.equal((await getDoc(doc(db('admin'),'supplyOrders/receipt-supply'))).data().expectedDate,'2026-11-01');
    assert.equal((await getDoc(doc(db('admin'),'orders/receipt-order'))).data().items[0].receivedQty,1);
    assert.equal((await getDocs(collection(db('admin'),'receipts'))).size,1);
    assert.equal((await getDocs(collection(db('admin'),'inventoryLots'))).size,1);
  });
}

test('either cancellation field blocks supplier receipt until purchasing keeps stock',async()=>{
  for(const status of [{status:'cancelled',orderStatus:'normal'},{status:'voided',orderStatus:'normal'},
    {status:'active',orderStatus:'cancelled'},{status:'active',orderStatus:'voided'}]){
    await seed('orders/cancelled-receipt',status);
    await seed('supplyOrders/cancelled-receipt',{orderId:'cancelled-receipt',qty:1,receivedQty:0,status:'ORDERED'});
    const ref=doc(db('admin'),'supplyOrders/cancelled-receipt');
    await assertFails(updateDoc(ref,{receivedQty:1,status:'RECEIVED'}));
    await seed('supplyOrders/cancelled-receipt',{orderId:'cancelled-receipt',qty:1,receivedQty:0,
      status:'ORDERED',customerCancellationDisposition:'KEEP_STOCK'});
    await assertSucceeds(updateDoc(ref,{receivedQty:1,status:'RECEIVED'}));
  }
});

test('all receiving roles reject live reservations when either order status is cancelled or voided',async()=>{
  for(const status of [{status:'cancelled',orderStatus:'normal'},{status:'voided',orderStatus:'normal'},
    {status:'active',orderStatus:'cancelled'},{status:'active',orderStatus:'voided'}]){
    await seed('orders/cancelled-reservation',{...status,ownerUid:'sales1',salesCode:'S01',
      items:[{itemId:'I1',productId:'P1',qty:1,warehouseId:'W1'}]});
    const data={orderId:'cancelled-reservation',itemId:'I1',orderItemIndex:0,productKey:'P1',warehouseId:'W1',
      ownerUid:'sales1',salesCode:'S01',quantity:1,shortageQty:0,status:'active'};
    for(const uid of ['admin','buyer1','wh1','sales1']){
      const ref=doc(db(uid),'inventoryReservations/cancelled-reservation__I1');
      await assertFails(setDoc(ref,data));
      await assertSucceeds(setDoc(ref,{...data,quantity:0,status:'cancelled'}));
    }
  }
});

test('purchasing may keep cancelled supplier stock regardless of which order status field contains cancellation',async()=>{
  for(const status of [{status:'cancelled',orderStatus:'normal'},{status:'voided',orderStatus:'normal'},
    {status:'active',orderStatus:'cancelled'},{status:'active',orderStatus:'voided'}]){
    await seed('orders/keep-stock-status',status);
    const supply={type:'PURCHASING_PO',orderId:'keep-stock-status',productKey:'P1',status:'ORDERED',qty:1,
      receivedQty:0,fulfillmentType:'WAREHOUSE',warehouseId:'W1',incomingRegisteredQty:1};
    await seed('supplyOrders/keep-stock-status',supply);
    const patch={customerCancellationDisposition:'KEEP_STOCK',customerCancellationResolvedAt:'now',
      customerCancellationResolvedBy:'buyer1',updatedAt:'now'};
    await assertFails(updateDoc(doc(db('wh1'),'supplyOrders/keep-stock-status'),patch));
    await assertSucceeds(updateDoc(doc(db('buyer1'),'supplyOrders/keep-stock-status'),patch));
  }
  await seed('orders/keep-stock-status',{status:'active',orderStatus:'normal'});
  await seed('supplyOrders/keep-stock-status',{type:'PURCHASING_PO',orderId:'keep-stock-status',productKey:'P1',
    status:'ORDERED',qty:1,receivedQty:0,fulfillmentType:'WAREHOUSE',warehouseId:'W1',incomingRegisteredQty:1});
  await assertFails(updateDoc(doc(db('buyer1'),'supplyOrders/keep-stock-status'),{
    customerCancellationDisposition:'KEEP_STOCK',customerCancellationResolvedAt:'now',
    customerCancellationResolvedBy:'buyer1',updatedAt:'now'}));
});

function compatDb(uid) {
  const firestore = db(uid);
  let sequence = 0;
  return {
    collection: name => {
      const constraints=[],builder={doc:id=>doc(firestore,name,id||`audit-${Date.now()}-${++sequence}`),
        // vm-loaded browser code creates cross-realm arrays; the modular Node SDK
        // expects native arrays, while production browser code uses one realm.
        where:(field,op,value)=>{constraints.push(where(field,op,Array.isArray(value)?Array.from(value):value));return builder;},
        limit:max=>{constraints.push(limit(max));return builder;},
        startAfter:snapshot=>{constraints.push(startAfter(snapshot));return builder;},
        get:()=>getDocs(query(collection(firestore,name),...constraints))};
      return builder;
    },
    runTransaction: callback => runTransaction(firestore, tx => callback({
      get:async ref=>{const snap=await tx.get(ref);return {exists:snap.exists(),data:()=>snap.data(),id:snap.id,ref};},
      set:(...args)=>tx.set(...args),update:(...args)=>tx.update(...args),delete:(...args)=>tx.delete(...args)
    }))
  };
}
test('audit receipt reads preserve ownership and limit missing-document lookup to admin and purchaser',async()=>{
 for(const uid of ['admin','buyer1'])await assertSucceeds(getDoc(doc(db(uid),'auditLogs/new-operation')));
 for(const uid of ['wh1','sales1','eng1','off1'])await assertFails(getDoc(doc(db(uid),'auditLogs/new-operation')));
 await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),'auditLogs/new-operation')));
 await seed('auditLogs/owned',{actorUid:'buyer1',action:'other',createdAt:'T'});
 await assertSucceeds(getDoc(doc(db('buyer1'),'auditLogs/owned')));
 for(const uid of ['wh1','sales1','eng1'])await assertFails(getDoc(doc(db(uid),'auditLogs/owned')));
 await assertFails(getDocs(collection(db('buyer1'),'auditLogs')));
 await assertSucceeds(getDocs(query(collection(db('buyer1'),'auditLogs'),where('actorUid','==','buyer1'),limit(10))));
 await assertFails(updateDoc(doc(db('buyer1'),'auditLogs/owned'),{actorUid:'sales1'}));
 await assertFails(deleteDoc(doc(db('buyer1'),'auditLogs/owned')));
 await assertFails(setDoc(doc(db('buyer1'),'auditLogs/forged-owner'),{actorUid:'sales1'}));
});
test('new planning receipts enforce exact schema real role and same atomic inventory facts',async()=>{
 const client=db('buyer1'),at='2026-10-16T00:00:00.000Z';
 await seed('inventory/planning-proof',{productKey:'p-order',productId:'p-order',onHand:10,reserved:0,incoming:0,stockPolicy:'ORDER_ONLY',safetyStock:0});
 const base={action:'inventory_policy_set',inventoryId:'planning-proof',actorUid:'buyer1',actorRole:'purchaser',stockPolicy:'SAFETY_STOCK',safetyStock:5,
  previousStockPolicy:'ORDER_ONLY',previousSafetyStock:0,changed:true,createdAt:at};
 await assertFails(setDoc(doc(client,'auditLogs/planning-orphan'),base));
 for(const patch of [{actorUid:'sales1'},{actorRole:'admin'},{createdAt:'x'.repeat(1000)},{extra:'unexpected'},{previousSafetyStock:99},{changed:false},{stockPolicy:'OTHER'},{safetyStock:-1},{stockPolicy:'NO_STOCK',safetyStock:5}]){
  const batch=writeBatch(client);batch.update(doc(client,'inventory/planning-proof'),{stockPolicy:'SAFETY_STOCK',safetyStock:5,updatedAt:at});
  batch.set(doc(client,'auditLogs/planning-forged'),{...base,...patch});await assertFails(batch.commit());
 }
 const omitted={...base};delete omitted.actorRole;await assertFails(setDoc(doc(client,'auditLogs/planning-omitted'),omitted));
 for(const safetyStock of [Infinity,NaN]){
  const invalidNumber=writeBatch(client);invalidNumber.update(doc(client,'inventory/planning-proof'),{stockPolicy:'SAFETY_STOCK',safetyStock,updatedAt:at});
  invalidNumber.set(doc(client,'auditLogs/planning-invalid-number'),{...base,safetyStock});await assertFails(invalidNumber.commit());
 }
 const stock=writeBatch(client);stock.update(doc(client,'inventory/planning-proof'),{stockPolicy:'SAFETY_STOCK',safetyStock:5,updatedAt:at,onHand:20});stock.set(doc(client,'auditLogs/planning-stock'),base);await assertFails(stock.commit());
 for(const uid of ['sales1','eng1','wh1'])await assertFails(setDoc(doc(db(uid),'auditLogs/planning-role-'+uid),{...base,actorUid:uid}));
 const valid=writeBatch(client);valid.update(doc(client,'inventory/planning-proof'),{stockPolicy:'SAFETY_STOCK',safetyStock:5,updatedAt:at});valid.set(doc(client,'auditLogs/planning-valid'),base);await assertSucceeds(valid.commit());
});
test('real planning service commits settings with receipts for admin purchaser and admin purchaser-view and safely replays',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['admin','purchaser']]){
  const id='planning-'+uid+'-'+role,client=compatDb(uid),nativeRun=client.runTransaction,plain=x=>JSON.parse(JSON.stringify(x));
  client.runTransaction=fn=>nativeRun(tx=>fn({...tx,set:(r,d)=>tx.set(r,plain(d)),update:(r,d)=>tx.update(r,plain(d))}));
  await seed('inventory/'+id,{productKey:'p-order',productId:'p-order',onHand:10,reserved:2,incoming:0,stockPolicy:'ORDER_ONLY',safetyStock:0});
  const c=vm.createContext({db:client,YushinInventory:require('../modules/inventory-core'),currentUser:{uid},currentUserRole:role,trueUserRole:uid==='admin'?'admin':role,
   runRoleTransaction:fn=>stockPermissions.run(client,fn,uid,false,role)});vm.runInContext(fs.readFileSync('src/services/inventory-planning.js','utf8'),c);
  const options={operationId:'policy-'+id};await assertSucceeds(c.commitInventoryPlanningSettings(id,'SAFETY_STOCK',5,options));
  await assertSucceeds(updateDoc(doc(db('admin'),'inventory/'+id),{stockPolicy:'NO_STOCK',safetyStock:0}));
  const replay=await assertSucceeds(c.commitInventoryPlanningSettings(id,'SAFETY_STOCK',5,options));assert.equal(replay.patch.stockPolicy,'NO_STOCK');assert.equal(replay.replayed,true);
  assert.equal((await getDoc(doc(db('admin'),'inventory/'+id))).data().onHand,10);
  await assertSucceeds(c.commitInventoryPlanningSettings(id,'NO_STOCK',0,{operationId:'noop-'+id}));
 }
});
test('real archive service checks live lots and warehouses then commits and restores with atomic audit',async()=>{
 const client=compatDb('admin'),nativeRun=client.runTransaction,plain=x=>JSON.parse(JSON.stringify(x));
 client.runTransaction=fn=>nativeRun(tx=>fn({...tx,set:(r,d)=>tx.set(r,plain(d)),update:(r,d)=>tx.update(r,plain(d))}));
 const c=vm.createContext({db:client,YushinInventory:require('../modules/inventory-core'),currentUser:{uid:'admin'},currentUserRole:'admin',trueUserRole:'admin',firestoreReadWithTimeout:p=>p,
  runRoleTransaction:fn=>stockPermissions.run(client,fn,'admin',false,'admin')});vm.runInContext(fs.readFileSync('src/services/inventory-planning.js','utf8'),c);
 await seed('inventory/planning-archive',{productKey:'p-order',productId:'p-order',onHand:0,reserved:0,incoming:0});
 await seed('inventoryLots/archive-lot',{productKey:'p-order',warehouseId:'W1',remainingQty:1,receivedQty:1});
 const input={inventoryId:'planning-archive',productKey:'p-order',archived:true,operationId:'archive-plan'};
 await assert.rejects(c.commitInventoryListArchive(input),/批次/);assert.equal((await getDoc(doc(db('admin'),'auditLogs/archive-plan'))).exists(),false);
 await seed('inventoryLots/archive-lot',{productKey:'p-order',warehouseId:'W1',remainingQty:0,receivedQty:1});
 await assertSucceeds(c.commitInventoryListArchive(input));
 await assertSucceeds(c.commitInventoryListArchive({...input,archived:false,operationId:'restore-plan'}));
 const replay=await assertSucceeds(c.commitInventoryListArchive(input));assert.equal(replay.patch.listArchived,false);assert.equal(replay.replayed,true);
});
test('actual bounded lot readers expose operational batches and exact search for all five active roles without reading costs',async()=>{
 await seed('inventoryLots/read-A',{productKey:'p-order',productId:'p-order',warehouseId:'W1',lotNo:'READ-B',expiryDate:'2027-01-01',remainingQty:3,receivedQty:3});
 await seed('inventoryLots/read-Z',{productKey:'p-order',productId:'p-order',warehouseId:'W1',lotNo:'OLD',expiryDate:'2026-01-01',remainingQty:0,receivedQty:3});
 await seed('inventory/p-order',{productKey:'p-order',productId:'p-order',onHand:3,reserved:0,incoming:0});
 await seed('inventoryLotCosts/read-A',{unitCost:999,lotId:'read-A'});
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse'],['sales1','sales'],['eng1','engineer']]){
  const used=[],client=compatDb(uid),nativeCollection=client.collection;client.collection=name=>{used.push(name);return nativeCollection(name);};
  const c=vm.createContext({db:client,YushinInventory:require('../modules/inventory-core'),firestoreReadWithTimeout:p=>p});
  vm.runInContext(fs.readFileSync('src/infrastructure/inventory-lot-read.js','utf8'),c);
  const page=await assertSucceeds(c.readInventoryLotsForProducts(['p-order']));assert.equal(page.rows.length,1);assert.equal(page.rows[0].qty,3);assert.equal(page.hasMore,false);
  const matched=await assertSucceeds(c.readInventoryLotMatches('READ-B'));assert.equal(matched.rows[0].id,'read-A');
  const expiry=await assertSucceeds(c.readInventoryLotMatches('2027-01-01','expiryDate'));assert.equal(expiry.rows.length,1);
  const items=await assertSucceeds(c.readInventoryForLotProducts(['p-order']));assert.equal(items[0].id,'p-order');
  assert.equal(used.some(name=>name==='inventoryLotCosts'||name==='productCosts'),false);assert.equal(page.rows[0].unitCost,undefined);
  if(['warehouse','sales','engineer'].includes(role))await assertFails(getDoc(doc(db(uid),'inventoryLotCosts/read-A')));
 }
});
test('actual manual inventory service commits initial stock protected cost and targeted scrap for three operational roles',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const key='manual-'+uid,operationId='manual-op-'+uid,client=compatDb(uid),nativeRun=client.runTransaction,plain=x=>JSON.parse(JSON.stringify(x));
  client.runTransaction=fn=>nativeRun(tx=>fn({...tx,set:(r,d,o)=>o?tx.set(r,plain(d),o):tx.set(r,plain(d)),update:(r,d)=>tx.update(r,plain(d))}));
  await seed('products/'+key,{productId:key,productName:'Manual product',manufacturerPartNo:'MANUAL',active:true});
  await seed('warehouses/W1',{active:true,warehouseType:'PHYSICAL'});
  const c=vm.createContext({db:client,currentUser:{uid},currentUserRole:role,currentUserName:uid,YushinInventory:require('../modules/inventory-core'),
   warehouseStockDocId:(w,p)=>w+'__'+p,firestoreReadWithTimeout:p=>p,resolveBrandName:b=>b,brandIdForName:()=>'',buildInventorySearchTokens:()=>[],
   runRoleTransaction:fn=>stockPermissions.run(client,fn,uid,false,role)});
  vm.runInContext(fs.readFileSync('src/services/manual-inventory.js','utf8'),c);
  const request={type:'initial',productKey:key,warehouseId:'W1',operationId,row:{qty:5,unitCost:role==='warehouse'?'':0,lotNo:'B',expiryDate:'2027-01-01'}};
  await assertSucceeds(c.commitManualInventoryAdjustment(request));await assertSucceeds(c.commitManualInventoryAdjustment(request));
  const lot=(await getDoc(doc(db('admin'),'inventoryLots/'+operationId+'-added'))).data(),cost=(await getDoc(doc(db('admin'),'inventoryLotCosts/'+operationId+'-added'))).data();
  assert.equal(lot.remainingQty,5);assert.equal(lot.unitCost,undefined);assert.equal(cost.unitCost,role==='warehouse'?undefined:0);
  assert.equal(cost.costPending,role==='warehouse'?true:undefined);
  if(role==='warehouse')await assertFails(getDoc(doc(db(uid),'inventoryLotCosts/'+operationId+'-added')));
  const scrap={...request,type:'scrap',operationId:'manual-scrap-'+uid,row:{...request.row,qty:2}};
  await assertSucceeds(c.commitManualInventoryAdjustment(scrap));await assertSucceeds(c.commitManualInventoryAdjustment(scrap));
  assert.equal((await getDoc(doc(db('admin'),'inventoryLots/'+operationId+'-added'))).data().remainingQty,3);
  assert.equal((await getDoc(doc(db('admin'),'inventory/'+key))).data().onHand,3);
  const adjust={...request,type:'adjustment',operationId:'manual-adjust-'+uid,row:{...request.row,qty:1}};
  await assertSucceeds(c.commitManualInventoryAdjustment(adjust));
  assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__'+key))).data().onHand,4);
  assert.equal((await getDoc(doc(db('admin'),'inventoryLotCosts/'+adjust.operationId+'-added'))).exists(),false);
 }
});
test('actual count service keeps stock lots and immutable operation aligned for admin purchaser and warehouse',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const key='count-'+uid,client=compatDb(uid),nativeRun=client.runTransaction,plain=x=>JSON.parse(JSON.stringify(x));
  client.runTransaction=fn=>nativeRun(tx=>fn({...tx,set:(r,d,o)=>o?tx.set(r,plain(d),o):tx.set(r,plain(d)),update:(r,d)=>tx.update(r,plain(d))}));
  await seed('inventory/'+key,{productKey:key,productId:key,onHand:10,reserved:2,incoming:0});
  await seed('warehouseStocks/W1__'+key,{productKey:key,productId:key,warehouseId:'W1',onHand:10,reserved:2,incoming:0});
  const c=vm.createContext({db:client,currentUser:{uid},currentUserRole:role,currentUserName:uid,YushinInventory:require('../modules/inventory-core'),
   warehouseStockDocId:(w,p)=>w+'__'+p,firestoreReadWithTimeout:p=>p,resolveBrandName:b=>b,brandIdForName:()=>'',buildInventorySearchTokens:()=>[],
   runRoleTransaction:fn=>stockPermissions.run(client,fn,uid,false,role)});
  vm.runInContext(fs.readFileSync('src/services/inventory-count.js','utf8'),c);
  const request={item:{id:key,productKey:key,productId:key},warehouseId:'W1',target:15,note:'actual Rules',operationId:'count-op-'+uid};
  await assertSucceeds(c.commitInventoryQuantity(request));
  assert.equal((await getDoc(doc(db(uid),'inventory/'+key))).data().onHand,15);
  assert.equal((await getDoc(doc(db(uid),'inventoryLots/'+request.operationId+'-added'))).data().remainingQty,5);
  assert.equal((await getDoc(doc(db('admin'),'inventoryLotCosts/'+request.operationId+'-added'))).exists(),false);
  await assertSucceeds(c.commitInventoryQuantity(request));
  const movement=(await getDoc(doc(db(uid),'inventoryMovements/'+request.operationId))).data();assert.equal(movement.countTarget,15);assert.equal(movement.actorUid,uid);
  await assertFails(updateDoc(doc(db(uid),'inventoryMovements/'+request.operationId),{countTarget:100}));
  const reduced={...request,target:7,operationId:'count-reduce-'+uid};await assertSucceeds(c.commitInventoryQuantity(reduced));
  assert.equal((await getDoc(doc(db(uid),'warehouseStocks/W1__'+key))).data().onHand,7);
 }
});
async function orderInitializationFixture(uid,role,{qty=5,onHand=3,direct=false,ownerUid=uid}={}){
 const id='init-'+uid,productKey='init-product',warehouseId=direct?'':'W1';
 await seed('orders/'+id,{ownerUid,salesCode:ownerUid==='eng1'?'E01':'S01',status:'active',inventoryReservationStatus:'pending',
  items:[{itemId:'I',productId:productKey,itemCode:'INIT',qty,fulfillmentType:direct?'DIRECT_SHIP':'WAREHOUSE',warehouseId}]});
 if(!direct){
  await seed('warehouses/W1',{active:true,isDefault:true});
  await seed('inventory/'+productKey,{productKey,onHand,reserved:0,incoming:0});
  await seed('warehouseStocks/W1__'+productKey,{productKey,warehouseId:'W1',onHand,reserved:0,incoming:0});
 }
 const client=compatDb(uid),nativeRun=client.runTransaction,plain=x=>JSON.parse(JSON.stringify(x));
 client.runTransaction=fn=>nativeRun(tx=>fn({...tx,set:(r,d,o)=>o?tx.set(r,plain(d),o):tx.set(r,plain(d)),update:(r,d)=>tx.update(r,plain(d))}));
 const fulfillment=require('../modules/fulfillment-core');
 const context=vm.createContext({db:client,currentUser:{uid},currentUserName:uid,currentUserCode:ownerUid==='eng1'?'E01':'S01',
  YushinReservation:require('../modules/reservation-core'),YushinWorkflow:require('../modules/workflow-core'),YushinProcurementDemand:demandCore,YushinFulfillment:fulfillment,
  normalizedOrderItems:o=>o.items.map(fulfillment.normalizeItem),normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
  inventoryProductKey:i=>i.productId||'',inventoryRefFor:i=>client.collection('inventory').doc(i.productId),inventoryNumbers:require('../modules/inventory-core').normalizeStock,
  warehouseStockDocId:(w,p)=>w+'__'+p,defaultWarehouse:()=>({id:'W1'}),orderWorkIndexFields:()=>({workCategories:['procurement']}),
  inventoryMovementRecord:(type,qty,orderId,productKey,actor,extra)=>({type,qty,sourceType:'order',sourceId:orderId,productKey,actorUid:uid,...extra}),
  salesCodeForName:()=> 'S01',warehouseMasterCache:[{id:'W1'}],invalidateWarehouseStockCache(){},invalidateProcurementDemandQueue(){},
  runRoleTransaction:fn=>stockPermissions.run(client,fn,uid,['sales','engineer'].includes(role),role)});
 const app=fs.readFileSync('app.js','utf8');
 context.window={};
 vm.runInContext(app.slice(app.indexOf('function procurementDemandForOrderItem('),app.indexOf('function purchasingLifecycleSnapshot(')),context);
 vm.runInContext(fs.readFileSync('src/services/order-reservation.js','utf8'),context);
 return {context,id,client,run:()=>context.reserveSingleOrderItem(id,{}, {itemId:'I'},0)};
}
test('real order initialization atomically publishes item reservation and demand for authorized roles',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{ownerUid:role==='purchaser'?'sales1':uid});
  try{await assertSucceeds(f.run());}catch(error){throw new Error(uid+' initialization: '+error.message);}
  try{await assertSucceeds(f.run());}catch(error){throw new Error(uid+' retry: '+error.message);}
  const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  const demand=(await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).data();
  assert.equal(order.items[0].reservedQty,3);assert.equal(order.items[0].shortageQty,2);assert.equal(demand.remainingToOrderQty,2);
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,3);
 }
});
const unactivatedLocationPatches=[{locationSchemaVersion:2},{locationSchemaVersion:0},{locations:[]},
 {locations:[{warehouseId:'W1',reservedQty:1},{warehouseId:'W2',reservedQty:1}]},
 {allocations:[]},{warehouseAllocations:[]}];
test('direct operational and admin batches cannot introduce location fields with otherwise valid stock evidence',async()=>{
 for(const uid of ['buyer1','wh1','admin']){
  await seedOperationalReserve();
  for(const reservationPatch of unactivatedLocationPatches){
   await assertFails(operationalReserveBatch(uid,1,{reservationPatch}).commit());
   assert.equal((await getDoc(doc(db('admin'),'inventory/p-order'))).data().reserved,0);
   assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__p-order'))).data().reserved,0);
   assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/evidence__I0'))).exists(),false);
  }
  await assertSucceeds(operationalReserveBatch(uid).commit());
 }
});
test('business callers cannot bypass the runtime guard by injecting location data into native writes',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer']]){
  for(const patch of unactivatedLocationPatches){
   const f=await orderInitializationFixture(uid,role),originalRun=f.client.runTransaction;
   f.client.runTransaction=callback=>originalRun(tx=>callback({...tx,set:(ref,data,options)=>{
    const record=ref.path.startsWith('inventoryReservations/')?{...data,...patch}:data;
    return options?tx.set(ref,record,options):tx.set(ref,record);
   }}));
   await assertFails(f.run());
   const admin=db('admin');assert.equal((await getDoc(doc(admin,'inventory/init-product'))).data().reserved,0);
   assert.equal((await getDoc(doc(admin,'inventoryReservations/'+f.id+'__I'))).exists(),false);
   assert.equal((await getDoc(doc(admin,'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).exists(),false);
  }
  const legal=await orderInitializationFixture(uid,role);await assertSucceeds(legal.run());
 }
});
test('unknown existing location metadata stays readable for audit but cannot be stripped to bypass the single-warehouse writer',async()=>{
 const client=db('admin'),ref=doc(client,'inventoryReservations/compat__I');
 const base={orderId:'compat',itemId:'I',orderItemIndex:0,productKey:'P',warehouseId:'W1',ownerUid:'sales1',salesCode:'S01',quantity:1,shortageQty:0};
 await seed('orders/compat',{ownerUid:'sales1',salesCode:'S01',status:'active',items:[{itemId:'I',productId:'P',warehouseId:'W1',qty:5}]});
 await seed('inventory/P',{productKey:'P',onHand:5,reserved:1});
 for(const patch of unactivatedLocationPatches){
  await seed(ref.path,{...base,...patch});await assertSucceeds(getDoc(ref));
  await assertFails(updateDoc(ref,{quantity:0}));
  const batch=writeBatch(client);batch.set(ref,{...base,quantity:0});batch.update(doc(client,'inventory/P'),{reserved:0});
  await assertFails(batch.commit());
  assert.equal((await getDoc(ref)).data().quantity,1);
  assert.equal((await getDoc(doc(db('admin'),'inventory/P'))).data().reserved,1);
 }
});
test('actual initialization rejects unmatched company free stock without creating purchase demand for four writers',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{onHand:0,ownerUid:role==='purchaser'?'sales1':uid});
  await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:0,incoming:0});
  await assert.rejects(f.run(),/核對分倉庫存/);
  const client=db('admin');assert.equal((await getDoc(doc(client,'inventory/init-product'))).data().reserved,0);
  assert.equal((await getDoc(doc(client,'warehouseStocks/W1__init-product'))).data().reserved,0);
  assert.equal((await getDoc(doc(client,'inventoryReservations/'+f.id+'__I'))).exists(),false);
  assert.equal((await getDoc(doc(client,'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).exists(),false);
 }
});
test('direct initialization does not need stock writes and purchaser can build it for responsible business owner',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{direct:true,qty:3,ownerUid:role==='purchaser'?'sales1':uid});
  await assertSucceeds(f.run());
  assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).data().remainingToOrderQty,3);
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).exists(),false);
 }
});
test('additional stock during pending retry clears demand through reservation evidence and rejects forged quantity',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer']]){
  const f=await orderInitializationFixture(uid,role);await f.run();
  const demandRef=doc(db(uid),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I'));
  await assertFails(updateDoc(demandRef,{requestedQty:0,remainingToOrderQty:0,status:'PENDING'}));
  await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:3,incoming:0});
  await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:5,reserved:3,incoming:0});
  await assertSucceeds(f.run());
  assert.equal((await getDoc(demandRef)).data().remainingToOrderQty,0);
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,5);
 }
});
async function addInitializationWarehouse(f,qty,master={}){
 await seed('warehouses/W2',{active:true,isDefault:false,...master});
 await seed('warehouseStocks/W2__init-product',{productKey:'init-product',warehouseId:'W2',onHand:qty,reserved:0,incoming:0});
 f.context.warehouseMasterCache.push({id:'W2',active:true});
}
test('real initialization selects another stocked warehouse for all authorized commercial operators',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{onHand:0,ownerUid:role==='purchaser'?'sales1':uid});
  await addInitializationWarehouse(f,5);await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:0,incoming:0});
  try{await assertSucceeds(f.run());await assertSucceeds(f.run());}catch(err){throw Error(uid+' remote initialization: '+err.message);}
  const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  assert.equal(order.items[0].warehouseId,'W2');assert.equal(order.items[0].reservedQty,5);assert.equal(order.items[0].shortageQty,0);
  assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data().reserved,0);
  assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W2__init-product'))).data().reserved,5);
 }
});
test('unheld pending reservation and demand can atomically change warehouse on retry without broadening stock ownership',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{onHand:0,ownerUid:role==='purchaser'?'sales1':uid});await f.run();
  await addInitializationWarehouse(f,5);await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:0,incoming:0});
  try{await assertSucceeds(f.run());await assertSucceeds(f.run());}catch(err){throw Error(uid+' remote zero recovery: '+err.message);}
  const d=(await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).data();
  assert.equal(d.warehouseId,'W2');assert.equal(d.requestedQty,0);assert.equal(d.remainingToOrderQty,0);
  const r=(await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data();assert.equal(r.quantity,5);assert.equal(r.warehouseId,'W2');
 }
});
test('initialization rejects multi-location stock before publishing false purchasing; disabled warehouse is not selected',async()=>{
 const f=await orderInitializationFixture('sales1','sales',{onHand:2});await addInitializationWarehouse(f,3);
 await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:0,incoming:0});
 await assert.rejects(f.run(),/多倉分配/);
 assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,0);
 assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).exists(),false);
 assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).exists(),false);
 await seed('warehouses/W2',{active:false});await assert.rejects(f.run(),/核對分倉庫存/);
 assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().items[0].warehouseId,'W1');
 assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).exists(),false);
});
test('business zero-location exception rejects committed, completed, inactive and custody relocation',async()=>{
 const f=await orderInitializationFixture('sales1','sales',{onHand:0});await f.run();await addInitializationWarehouse(f,5);
 const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 const attempt=(warehouseId='W2')=>{const client=db('sales1'),b=writeBatch(client);b.update(doc(client,'orders/'+f.id),{items:[{...original.items[0],warehouseId}]});b.update(doc(client,'inventoryReservations/'+f.id+'__I'),{warehouseId});return b.commit();};
 for(const change of [{inventoryReservationStatus:'completed'},{items:[{...original.items[0],supplyOrderedQty:1}]},{items:[{...original.items[0],reservedQty:1}]},{items:[{...original.items[0],dispatchPreparedQty:1}]},{items:[{...original.items[0],transferPendingId:'T'}]}]){
  await seed('orders/'+f.id,{...original,...change});await assertFails(attempt());
 }
 await seed('orders/'+f.id,original);await seed('warehouses/W2',{active:false});await assertFails(attempt());
 await seed('warehouses/custody-sales1',{active:true,systemCustody:true,ownerUid:'sales1'});await assertFails(attempt('custody-sales1'));
});
test('purchasing cannot bypass incomplete stock allocation by directly creating customer supply',async()=>{
 for(const uid of ['buyer1','admin'])for(const type of ['PURCHASING_PO','PURCHASING_MANUAL']){
  const ref=doc(db(uid),'supplyOrders/source-readiness-'+uid+'-'+type),data={type,orderId:'source-ready',qty:1,supplier:'Supplier',unitCost:5};
  await assertFails(setDoc(ref,data));
  for(const status of ['pending','failed']){
   await seed('orders/source-ready',{ownerUid:'sales1',inventoryReservationStatus:status});await assertFails(setDoc(ref,data));
  }
  await seed('orders/source-ready',{ownerUid:'sales1',inventoryReservationStatus:'completed'});await assertSucceeds(setDoc(ref,data));
  await env.withSecurityRulesDisabled(async ctx=>deleteDoc(doc(ctx.firestore(),ref.path)));
  await seed('orders/source-ready',{ownerUid:'sales1',inventoryReservationStatus:'completed',status:'cancelled'});await assertFails(setDoc(ref,data));
  await env.withSecurityRulesDisabled(async ctx=>deleteDoc(doc(ctx.firestore(),'orders/source-ready')));
 }
 await assertSucceeds(setDoc(doc(db('buyer1'),'supplyOrders/free-replenish'),{type:'STOCK_REPLENISHMENT',qty:1}));
});
test('shared stock and workflow read predicates retain fixed role, owner, cost and disabled-account boundaries',async()=>{
 const scoped=['orders/read-owner','procurementDemands/read-owner','inventoryReservations/read-owner'];
 for(const path of scoped)await seed(path,{ownerUid:'sales1',salesCode:'S01'});
 const stock=['inventory/read-clean','warehouseStocks/read-clean'];
 for(const path of stock)await seed(path,{productKey:'P',onHand:1,reserved:0});
 for(const uid of ['admin','buyer1','wh1','sales1','eng1']){
  const client=db(uid);
  for(const path of scoped){
   if(['admin','buyer1','wh1','sales1'].includes(uid))await assertSucceeds(getDoc(doc(client,path)));
   else await assertFails(getDoc(doc(client,path)));
   await assertSucceeds(getDoc(doc(client,path+'-missing')));
  }
  for(const path of stock){await assertSucceeds(getDoc(doc(client,path)));await assertSucceeds(getDoc(doc(client,path+'-missing')));}
 }
 for(const path of stock){
  await seed(path,{productKey:'P',onHand:1,reserved:0,unitCost:5});
  await assertSucceeds(getDoc(doc(db('admin'),path)));
  for(const uid of ['buyer1','wh1','sales1','eng1'])await assertFails(getDoc(doc(db(uid),path)));
 }
 await seed('users/sales1',{role:'sales',salesCode:'S01',active:false});
 for(const path of [...scoped,...stock]){await assertFails(getDoc(doc(db('sales1'),path)));await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),path)));}
});
for(const [uid,role] of [['buyer1','purchaser'],['wh1','warehouse']])test(role+' runs actual paged receipt allocation past 500 candidates with durable retry',async()=>{
 const f=await orderInitializationFixture(uid,role,{onHand:0,ownerUid:'sales1'}),fulfillment=require('../modules/fulfillment-core');
 const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 await seed('orders/'+f.id,{...original,orderDate:'2026-01-01',inventoryReservationStatus:'completed',items:original.items.map(i=>fulfillment.normalizeItem({...i,inventoryProductKey:'init-product'}))});
 await seed('inventory/init-product',{productKey:'init-product',onHand:3,reserved:0,incoming:0});
 await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:3,reserved:0,incoming:0});
 await seed('inventoryReservations/'+f.id+'__I',{id:'stale-embedded-id',orderId:f.id,itemId:'I',orderItemIndex:0,ownerUid:'sales1',salesCode:'S01',productKey:'init-product',warehouseId:'W1',quantity:0,shortageQty:5,status:'shortage',orderDate:'2026-01-01'});
 await seed('receipts/PAGED',{productKey:'init-product',warehouseId:'W1',autoAllocationQty:3,autoAllocatedQty:0,allocationCompleted:false});
 await env.withSecurityRulesDisabled(async ctx=>{
  for(let offset=0;offset<550;offset+=450){
   const client=ctx.firestore(),batch=writeBatch(client);
   for(let i=offset;i<Math.min(offset+450,550);i++)batch.set(doc(client,'inventoryReservations/A-FILL-'+String(i).padStart(4,'0')),{orderId:'OTHER-'+i,itemId:'I',productKey:'init-product',warehouseId:'OTHER',quantity:0,shortageQty:1,status:'shortage',orderDate:'2026-02-01'});
   await batch.commit();
  }
 });
 Object.assign(f.context,{firestoreReadWithTimeout:promise=>promise,itemDispatchState:(_o,i)=>fulfillment.dispatchState(i),orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus)});
 const app=fs.readFileSync('app.js','utf8');
 vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),f.context);
 await assertSucceeds(f.context.allocateFreeReceiptStockToShortages('init-product','W1',3,uid,'','PAGED'));
 await assertSucceeds(f.context.allocateFreeReceiptStockToShortages('init-product','W1',3,uid,'','PAGED'));
 assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,3);
 assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().items[0].reservedQty,3);
 assert.equal((await getDoc(doc(db('admin'),'receipts/PAGED'))).data().autoAllocatedQty,3);
 assert.equal((await getDoc(doc(db('admin'),'receipts/PAGED'))).data().allocationCompleted,true);
 assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).data().remainingToOrderQty,2);
});
test('warehouse and unrelated business owner cannot initialize another owner order, cancellation stops admin as well',async()=>{
 for(const [uid,role] of [['wh1','warehouse'],['sales2','sales']]){
  const f=await orderInitializationFixture(uid,role,{ownerUid:'sales1'});
  await assert.rejects(f.run());assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,0);
 }
 const f=await orderInitializationFixture('admin','admin');
 await seed('orders/'+f.id,{ownerUid:'admin',status:'cancelled',items:[{itemId:'I',productId:'init-product',warehouseId:'W1',qty:5}]});
 await assert.rejects(f.run(),/取消／作廢/);assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,0);
});
test('missing demand may be read for deterministic transaction creation but existing documents and lists remain owner scoped',async()=>{
 await assertSucceeds(getDoc(doc(db('sales1'),'procurementDemands/MISSING-INIT')));
 const f=await orderInitializationFixture('sales1','sales',{onHand:0});await f.run();
 const id=encodeURIComponent('SALES_ORDER:'+f.id+':I');
 await assertFails(getDoc(doc(db('sales2'),'procurementDemands/'+id)));
 await assertFails(getDocs(collection(db('sales2'),'procurementDemands')));
});
test('inventory synchronization outcomes reject completed regression, old attempt and cancelled source for every operator',async()=>{
 const refFor=uid=>doc(db(uid),'orders/sync-outcome');
 const base={ownerUid:'sales1',salesCode:'S01',status:'active',inventoryReservationStatus:'pending',inventoryReservationAttemptId:'A',
  inventoryReservationError:'',inventoryReservationUpdatedAt:'2026-10-14',items:[{itemId:'I',productId:'p-order',qty:3}]};
 const patch=(status,id='A')=>({inventoryReservationStatus:status,inventoryReservationAttemptId:id,inventoryReservationError:status==='failed'?'offline':'',inventoryReservationUpdatedAt:'2026-10-14T07:00:00Z'});
 for(const uid of ['sales1','buyer1','admin']){
  await seed('orders/sync-outcome',base);
  await assertFails(updateDoc(refFor(uid),patch('completed','OLD')));
  await assertSucceeds(updateDoc(refFor(uid),patch('pending','B')));
  await assertFails(updateDoc(refFor(uid),patch('failed','A')));
  await assertSucceeds(updateDoc(refFor(uid),patch('completed','B')));
  await assertFails(updateDoc(refFor(uid),patch('failed','B')));
  await assertFails(updateDoc(refFor(uid),patch('pending','C')));
  for(const field of ['status','orderStatus']){
   await seed('orders/sync-outcome',{...base,[field]:'cancelled'});
   await assertFails(updateDoc(refFor(uid),patch('completed')));
   await assertFails(updateDoc(refFor(uid),patch('failed')));
  }
 }
 await seed('orders/sync-outcome',base);
 for(const uid of ['wh1','sales2','eng1'])await assertFails(updateDoc(refFor(uid),patch('pending','B')));
 await assertFails(updateDoc(refFor('sales1'),{...patch('pending','B'),inventoryReservationError:'x'.repeat(1001)}));
});
test('real shared synchronization starts, completes and recovers terminal results for business, engineer and purchaser',async()=>{
 const app=fs.readFileSync('app.js','utf8');
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser']]){
  const f=await orderInitializationFixture(uid,role,{ownerUid:role==='purchaser'?'sales1':uid});
  Object.assign(f.context,{currentUserRole:role,orderReservationSummary:o=>({reservedQty:o.items.reduce((s,i)=>s+Number(i.reservedQty||0),0)}),console:{error(){}},
   reserveInventoryForNewOrder:async()=>f.run()});
  vm.runInContext(app.slice(app.indexOf('function canRetryOrderInventorySync('),app.indexOf('function orderInventorySyncStatusHtml(')),f.context);
  const order={id:f.id,...(await getDoc(doc(db(uid),'orders/'+f.id))).data()};
  await assertSucceeds(f.context.synchronizeOrderInventory(f.id,order,uid));
  assert.equal(order.inventoryReservationStatus,'completed');assert.ok(order.inventoryReservationAttemptId);
  f.context.reserveInventoryForNewOrder=async()=>{throw Error('must not repeat completed operation');};
  await assertSucceeds(f.context.synchronizeOrderInventory(f.id,order,uid));
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,3);
 }
});
test('new order cannot forge completed source checkpoint without the matching source backlink',async()=>{
 const base={...validOrderProduct,ownerUid:'sales1',salesCode:'S01',status:'active',sourceType:'forecast',sourceId:'new-source-checkpoint',
  sourceDocumentSyncStatus:'completed',sourceDocumentSyncError:'',sourceDocumentSyncUpdatedAt:'2026-10-14'};
 await seed('forecasts/new-source-checkpoint',{ownerUid:'sales1',salesCode:'S01',status:'active',linkedDocuments:[]});
 await assertFails(setDoc(doc(db('sales1'),'orders/new-source-checkpoint'),base));
 const client=db('sales1'),b=writeBatch(client);b.update(doc(client,'forecasts/new-source-checkpoint'),{linkedDocuments:[{type:'order',id:'new-source-checkpoint',relation:'created'}]});
 b.set(doc(client,'orders/new-source-checkpoint'),base);await assertSucceeds(b.commit());
});
test('common creation service reads and creates orders under actual commercial role permissions',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const client=compatDb(uid),nativeRun=client.runTransaction;
  client.runTransaction=fn=>nativeRun(tx=>fn({...tx,set:(ref,data)=>tx.set(ref,JSON.parse(JSON.stringify(data)))}));
  const c=vm.createContext({db:client,currentUser:{uid},currentUserRole:role,BUSINESS_STATUS:{ACTIVE:'active'},
   runRoleTransaction:fn=>stockPermissions.run(client,fn,uid,['sales','engineer'].includes(role),role)});
  vm.runInContext(fs.readFileSync('src/services/order-creation.js','utf8'),c);
  const data={...validOrderProduct,ownerUid:role==='engineer'?uid:'sales1',salesCode:role==='engineer'?'E01':'S01',status:'active',
   createdByUid:uid,createdByRole:role,createdByName:uid,inventoryReservationStatus:'pending'};
  const id='common-'+uid;await assertSucceeds(c.commitOrderCreation(id,data));
  const retry=await assertSucceeds(c.commitOrderCreation(id,{...data,customerName:'stale form'}));
  assert.equal(retry.data.customerName,undefined);
 }
});
test('common Forecast creation transaction atomically proves source link under sales and admin Rules',async()=>{
 const {arrayUnion}=require('firebase/firestore');
 for(const [uid,role] of [['sales1','sales'],['admin','admin']]){
  const id='common-forecast-'+uid,client=compatDb(uid),nativeRun=client.runTransaction;
  client.runTransaction=fn=>nativeRun(tx=>fn({...tx,set:(ref,data)=>tx.set(ref,JSON.parse(JSON.stringify(data))),
   update:(ref,data)=>tx.update(ref,{updatedAt:data.updatedAt,linkedDocuments:data.linkedDocuments})}));
  const c=vm.createContext({db:client,currentUser:{uid},currentUserRole:role,BUSINESS_STATUS:{ACTIVE:'active'},DOCUMENT_TYPES:{FORECAST:'forecast',ORDER:'order'},
   firebase:{firestore:{FieldValue:{arrayUnion}}},documentLink:(type,id,relation)=>({type,id,relation}),normalizedOrderStatus:()=> 'normal',
   runRoleTransaction:fn=>stockPermissions.run(client,fn,uid,role==='sales',role)});
  vm.runInContext(fs.readFileSync('src/services/order-creation.js','utf8'),c);
  await seed('forecasts/'+id,{ownerUid:'sales1',salesCode:'S01',status:'active',updatedAt:'V',linkedDocuments:[]});
  const data={...validOrderProduct,ownerUid:'sales1',salesCode:'S01',status:'active',createdByUid:uid,createdByRole:role,createdByName:uid,createdAt:'T',
   inventoryReservationStatus:'pending',sourceType:'forecast',sourceId:id,sourceDocumentSyncStatus:'completed'};
  await assertSucceeds(c.commitOrderCreation(id,data,{linkForecast:true,expectedForecastUpdatedAt:'V'}));
  const source=(await getDoc(doc(db('admin'),'forecasts/'+id))).data();assert.equal(source.linkedDocuments[0].id,id);
  await assertSucceeds(c.commitOrderCreation(id,data,{linkForecast:true,expectedForecastUpdatedAt:'V'}));
  assert.equal((await getDoc(doc(db('admin'),'forecasts/'+id))).data().linkedDocuments.length,1);
 }
});
test('source sync completion requires the actual source backlink and quote closure in the same transaction',async()=>{
 const base={ownerUid:'sales1',salesCode:'S01',status:'active',inventoryReservationStatus:'completed',sourceType:'quote',sourceId:'source-proof',
  sourceDocumentSyncStatus:'pending',items:[{itemId:'I',productId:'p-order',qty:3}]};
 await seed('orders/source-proof',base);await seed('quotes/source-proof',{ownerUid:'sales1',salesCode:'S01',status:'active',linkedDocuments:[]});
 const patch={sourceDocumentSyncStatus:'completed',sourceDocumentSyncError:'',sourceDocumentSyncUpdatedAt:'2026-10-14'};
 await assertFails(updateDoc(doc(db('sales1'),'orders/source-proof'),patch));
 const client=db('sales1'),b=writeBatch(client);b.update(doc(client,'quotes/source-proof'),{dealClosed:true,status:'completed',linkedDocuments:[{type:'order',id:'source-proof',relation:'created'}]});
 b.update(doc(client,'orders/source-proof'),patch);await assertSucceeds(b.commit());
 await assertFails(updateDoc(doc(db('sales1'),'orders/source-proof'),{...patch,sourceDocumentSyncStatus:'failed',sourceDocumentSyncError:'old error'}));
 await seed('orders/source-proof',{...base,status:'cancelled'});
 await assertFails(updateDoc(doc(db('sales1'),'orders/source-proof'),patch));
 await seed('orders/source-proof',base);
 for(const uid of ['wh1','sales2'])await assertFails(updateDoc(doc(db(uid),'orders/source-proof'),{...patch,sourceDocumentSyncStatus:'failed',sourceDocumentSyncError:'offline'}));
 await assertFails(updateDoc(doc(db('sales1'),'orders/source-proof'),{...patch,sourceId:'OTHER'}));
});
test('real source sync works for quote owners, engineer, purchaser assistance and admin without redoing stock',async()=>{
 const app=fs.readFileSync('app.js','utf8'),{arrayUnion}=require('firebase/firestore');
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const id='source-'+uid,ownerUid=role==='engineer'?uid:'sales1',salesCode=role==='engineer'?'E01':'S01';
  const order={ownerUid,salesCode,status:'active',inventoryReservationStatus:'completed',sourceType:'quote',sourceId:id,sourceDocumentSyncStatus:'pending',items:[{itemId:'I',productId:'p-order',qty:3}]};
  await seed('orders/'+id,order);await seed('quotes/'+id,{ownerUid,salesCode,status:'active',linkedDocuments:[]});
  const client=compatDb(uid),nativeRun=client.runTransaction;
  client.runTransaction=fn=>nativeRun(tx=>fn({...tx,update:(ref,data)=>tx.update(ref,{...JSON.parse(JSON.stringify(data)),...('linkedDocuments' in data?{linkedDocuments:data.linkedDocuments}:{})})}));
  const c=vm.createContext({db:client,currentUser:{uid},currentUserRole:role,runRoleTransaction:fn=>stockPermissions.run(client,fn,uid,['sales','engineer'].includes(role),role),
   DOCUMENT_TYPES:{QUOTE:'quote',FORECAST:'forecast',ORDER:'order'},BUSINESS_STATUS:{COMPLETED:'completed'},firebase:{firestore:{FieldValue:{arrayUnion}}},
   documentLink:(type,id,relation)=>({type,id,relation}),localDateString:()=> '2026-10-14',
   normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
   orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus),myQuotesCache:[],quoteHistorySearchResults:[],writeAppDataCache(){},console:{error(){}}});
  vm.runInContext(app.slice(app.indexOf('function canRetryOrderInventorySync('),app.indexOf('async function writeOrderInventorySyncState(')),c);
  vm.runInContext(app.slice(app.indexOf('function orderSourceSyncIncomplete('),app.indexOf('const pendingOrderReservationIds = new Set();')),c);
  const local={...order};assert.equal(await c.syncNewOrderSourceDocuments(id,local,uid),null);
  assert.equal(local.sourceDocumentSyncStatus,'completed');assert.equal(await c.syncNewOrderSourceDocuments(id,local,uid),null);
  assert.equal((await getDoc(doc(db('admin'),'quotes/'+id))).data().linkedDocuments.length,1);
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+id+'__I'))).exists(),false);
 }
});
test('source-only Forecast recovery retains owner access and cannot complete a missing or cancelled source',async()=>{
 const app=fs.readFileSync('app.js','utf8'),{arrayUnion}=require('firebase/firestore'),id='source-forecast';
 const order={ownerUid:'sales1',salesCode:'S01',status:'active',inventoryReservationStatus:'completed',sourceType:'forecast',sourceId:id,sourceDocumentSyncStatus:'failed',items:[{itemId:'I',productId:'p-order',qty:3}]};
 await seed('orders/'+id,order);await seed('forecasts/'+id,{ownerUid:'sales1',salesCode:'S01',status:'active',linkedDocuments:[]});
 const client=compatDb('sales1'),nativeRun=client.runTransaction;
 client.runTransaction=fn=>nativeRun(tx=>fn({...tx,update:(ref,data)=>tx.update(ref,{...JSON.parse(JSON.stringify(data)),...('linkedDocuments' in data?{linkedDocuments:data.linkedDocuments}:{})})}));
 const c=vm.createContext({db:client,currentUser:{uid:'sales1'},currentUserRole:'sales',runRoleTransaction:fn=>stockPermissions.run(client,fn,'sales1',true,'sales'),
  DOCUMENT_TYPES:{QUOTE:'quote',FORECAST:'forecast',ORDER:'order'},BUSINESS_STATUS:{COMPLETED:'completed'},firebase:{firestore:{FieldValue:{arrayUnion}}},
  documentLink:(type,id,relation)=>({type,id,relation}),localDateString:()=> '2026-10-14',
  normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
  orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus),myQuotesCache:[],quoteHistorySearchResults:[],writeAppDataCache(){},console:{error(){}}});
 vm.runInContext(app.slice(app.indexOf('function canRetryOrderInventorySync('),app.indexOf('async function writeOrderInventorySyncState(')),c);
 vm.runInContext(app.slice(app.indexOf('function orderSourceSyncIncomplete('),app.indexOf('const pendingOrderReservationIds = new Set();')),c);
 assert.equal(await c.syncNewOrderSourceDocuments(id,{...order},'sales1'),null);
 await seed('orders/'+id,order);await env.withSecurityRulesDisabled(async ctx=>deleteDoc(doc(ctx.firestore(),'forecasts/'+id)));
 const failed={...order};assert.match((await c.syncNewOrderSourceDocuments(id,failed,'sales1')).message,/已不存在|PERMISSION_DENIED/);assert.equal(failed.sourceDocumentSyncStatus,'failed');
 assert.equal((await getDoc(doc(db('admin'),'forecasts/'+id))).exists(),false);
});
async function seedStockWorkflow(){
  await seed('orders/stock-order',{ownerUid:'sales1',salesCode:'S01',deliveredQty:0,returnedQty:0,
    items:[{itemId:'item-1',productId:'p1',qty:5,warehouseId:'w1'}]});
  await seed('inventory/p1',{productKey:'p1',productId:'p1',onHand:10,reserved:0,incoming:0});
  await seed('warehouseStocks/w1-p1',{productKey:'p1',warehouseId:'w1',onHand:10,reserved:0,incoming:0});
  await seed('inventoryLots/l1',{productKey:'p1',warehouseId:'w1',remainingQty:10});
}
async function stockWorkflow(physicalDelta, reservationQty, type, warehouseId='w1'){
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
      else tx.update(order,{deliveredQty:orderSnap.data().deliveredQty-physicalDelta,
        deliveryRecords:physicalDelta < 0 ? [{id:'ship-1',itemId:'item-1',qty:-physicalDelta}] : []});
    }
    tx.set(res,{orderId:'stock-order',itemId:'item-1',productKey:'p1',warehouseId,ownerUid:'sales1',salesCode:'S01',quantity:reservationQty,shortageQty:0,status:'active'});
    tx.set(client.collection('inventoryMovements').doc(),{sourceId:'stock-order',sourceType:'order',productKey:'p1',ownerUid:'sales1',salesCode:'S01',type,qty:physicalDelta||reserveDelta,lotAllocations:physicalDelta?[{lotId:'l1',qty:type==='ship'?-physicalDelta:physicalDelta}]:[]});
  },'sales1',true,'sales');
}

test('commercial stock reservation delivery and reversal require atomic evidence; returns use protected receipt workflow',async()=>{
  await seedStockWorkflow();
  await assertSucceeds(stockWorkflow(0,5,'reserve'));
  await assertSucceeds(stockWorkflow(-2,3,'ship'));
  await assertSucceeds(stockWorkflow(2,5,'ship_reversal'));
  await assertSucceeds(stockWorkflow(-2,3,'ship'));
  await assertFails(stockWorkflow(1,4,'return_in'));
  const order=await getDoc(doc(db('sales1'),'orders/stock-order'));
  const stock=await getDoc(doc(db('sales1'),'inventory/p1'));
  assert.equal(order.data().returnedQty,0);
  assert.equal(stock.data().onHand,8);
  await assertFails(updateDoc(doc(db('sales1'),'inventory/p1'),{onHand:100}));
  await assertFails(updateDoc(doc(db('sales1'),'inventoryLots/l1'),{remainingQty:100}));
});

test('stock witness cannot be reused for a second stock change',async()=>{
  await seedStockWorkflow();await assertSucceeds(stockWorkflow(0,5,'reserve'));
  const stock=await getDoc(doc(db('sales1'),'inventory/p1'));
  await assertFails(updateDoc(doc(db('sales1'),'inventory/p1'),{reserved:4,stockOperationId:stock.data().stockOperationId}));
});

test('commercial wrapper rejects inconsistent reserved deltas before commit and still permits the valid atomic flow',async()=>{
 for(const [uid,role,code] of [['sales1','sales','S01'],['eng1','engineer','E01']]){
  await seedStockWorkflow();
  await seed('orders/stock-order',{ownerUid:uid,salesCode:code,items:[{itemId:'item-1',productId:'p1',qty:5,warehouseId:'w1'}]});
  const client=compatDb(uid);
  const attempt=(company,warehouse)=>stockPermissions.run(client,async tx=>{
   const inv=client.collection('inventory').doc('p1'),wh=client.collection('warehouseStocks').doc('w1-p1');
   await tx.get(inv);await tx.get(wh);
   tx.update(inv,{reserved:company});tx.update(wh,{reserved:warehouse});
   tx.set(client.collection('inventoryReservations').doc('stock-order__item-1'),{
    orderId:'stock-order',itemId:'item-1',productKey:'p1',warehouseId:'w1',quantity:1,shortageQty:4,status:'active'});
   tx.set(client.collection('inventoryMovements').doc('CHECK-'+uid),{
    sourceId:'stock-order',sourceType:'order',productKey:'p1',ownerUid:uid,salesCode:code,type:'reserve',qty:1});
  },uid,true,role);
  for(const pair of [[2,1],[1,2],[0,1],[1,0]]){
   await assert.rejects(attempt(...pair),/預留增減.*不一致/);
   assert.equal((await getDoc(doc(db('admin'),'inventory/p1'))).data().reserved,0);
   assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/w1-p1'))).data().reserved,0);
   assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/stock-order__item-1'))).exists(),false);
   assert.equal((await getDoc(doc(db('admin'),'inventoryMovements/CHECK-'+uid))).exists(),false);
  }
  await assertSucceeds(attempt(1,1));
  assert.equal((await getDoc(doc(db('admin'),'inventory/p1'))).data().reserved,1);
  await env.withSecurityRulesDisabled(async ctx=>deleteDoc(doc(ctx.firestore(),'inventoryReservations/stock-order__item-1')));
 }
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
    tx.set(client.collection('inventoryLots').doc('private-lot'),{productKey:'p1',warehouseId:'w1',sourceId:'private-supply',sourceType:'SUPPLY_ORDER',remainingQty:2});
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
 for(const productId of ['p1','p2']){
  await seed('inventory/'+productId,{productKey:productId,onHand:10,reserved:0});
  await seed('warehouseStocks/w1-'+productId,{productKey:productId,warehouseId:'w1',onHand:10,reserved:0});
 }
 await assertSucceeds(stockPermissions.run(client,async tx=>{
  const refs=items.map(item=>client.collection('inventory').doc(item.productId));
  const whRefs=items.map(item=>client.collection('warehouseStocks').doc('w1-'+item.productId));
  await Promise.all(refs.map(ref=>tx.get(ref)));
  await Promise.all(whRefs.map(ref=>tx.get(ref)));
  await tx.get(client.collection('orders').doc('multi-stock'));
  items.forEach((item,i)=>{
   tx.update(refs[i],{reserved:5});
   tx.update(whRefs[i],{reserved:5});
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
  await seed('warehouses/W1',{active:true,warehouseType:'PHYSICAL'});
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

test('Firestore rules reject return receipts into missing, disabled and custody warehouses',async()=>{
 const locations=[
  ['missing',null],
  ['disabled',{active:false,warehouseType:'PHYSICAL'}],
  ['custody',{active:true,warehouseType:'CUSTODY',systemCustody:true}],
  ['custody-prefix',{active:true,warehouseType:'PHYSICAL'}]
 ];
 for(const [label,warehouse] of locations){
  const warehouseId=label==='custody-prefix'?'custody-sales1':'return-'+label;
  if(warehouse)await seed('warehouses/'+warehouseId,warehouse);
  const id='return-guard-'+label;
  const request={id:'Q1',itemId:'I1',qty:1,receivedQty:0,status:'PENDING',settlement:'CLOSE',createdByUid:'sales1'};
  await seed('orders/'+id,{...validOrderProduct,ownerUid:'sales1',salesCode:'S01',deliveredQty:2,returnedQty:0,
    items:[{itemId:'I1',qty:2}],returnRequests:[request],returnRecords:[],returnPending:true});
  const record={id:'R-'+label,requestId:'Q1',itemId:'I1',qty:1,settlement:'CLOSE',quality:'INSPECTION',warehouseId};
  const receipt={orderId:id,requestId:'Q1',requestIndex:0,itemId:'I1',qty:1,quality:'INSPECTION',warehouseId,
    disposition:'HOLD',record,receivedBy:'wh1',ownerUid:'sales1',salesCode:'S01'};
  const client=db('wh1'),batch=writeBatch(client);
  batch.set(doc(client,'customerReturnReceipts/'+record.id),receipt);
  batch.update(doc(client,'orders/'+id),{returnReceiptId:record.id,returnRequests:[{...request,receivedQty:1,status:'RECEIVED'}],
    returnPending:false,returnedQty:1,returnRecords:[record]});
  await assertFails(batch.commit());
 }
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
  await seed('inventoryReservations/warehouse-ship__I1',{orderId:'warehouse-ship',itemId:'I1',orderItemIndex:0,ownerUid:'sales1',salesCode:'S01',productKey:'p-order',warehouseId:'W1',quantity:3});
  return {item,order};
}
function warehouseShipmentBatch(client,uid,item,{stock=true,extra={},qty=1}={}){
  const batch=writeBatch(client),record={id:'SHIP1',orderId:'warehouse-ship',itemId:'I1',itemIndex:0,productKey:'p-order',warehouseId:'W1',date:'2026-10-06',qty,sourceType:'INVENTORY_SHIPMENT',createdByUid:uid,movementId:'SHIP-M1'};
  batch.set(doc(client,'inventoryMovements/SHIP-M1'),{type:'ship',sourceId:'warehouse-ship',itemId:'I1',warehouseId:'W1',productKey:'p-order',qty:-qty,actorUid:uid,warehouseStockId:'W1__p-order',inventoryDocId:'p-order',reservationStockEvidence:{inventoryId:'p-order',warehouseStockId:'W1__p-order',previousWarehouseStockId:'W1__p-order',movementId:'SHIP-M1',reservationIds:['warehouse-ship__I1']}});
  if(stock){batch.update(doc(client,'inventory/p-order'),{onHand:5-qty,reserved:3-qty});batch.update(doc(client,'warehouseStocks/W1__p-order'),{onHand:5-qty,reserved:3-qty});}
  batch.update(doc(client,'inventoryReservations/warehouse-ship__I1'),{quantity:3-qty,stockEvidence:{inventoryId:'p-order',warehouseStockId:'W1__p-order',previousWarehouseStockId:'W1__p-order',movementId:'SHIP-M1',reservationIds:['warehouse-ship__I1']}});
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

async function seedWarehouseLogistics(){
 await seed('warehouses/MAIN',{warehouseName:'又鑫',active:true});await seed('warehouses/EXT',{warehouseName:'勝力',active:true});
 await seed('inventory/P',{productKey:'P',productId:'P',onHand:10,reserved:4,incoming:0,stockPolicy:'ORDER_ONLY',safetyStock:0});
 await seed('warehouseStocks/MAIN__P',{productKey:'P',warehouseId:'MAIN',onHand:10,reserved:4,incoming:0});
 await seed('orders/logistics',{ownerUid:'sales1',salesCode:'S01',status:'active',createdByUid:'sales1',createdByRole:'sales',deliveryRecords:[],items:[{itemId:'A',productId:'P',qty:4,reservedQty:4,warehouseId:'MAIN',dispatchPreparedQty:4}]});
 await seed('inventoryReservations/logistics__A',{orderId:'logistics',itemId:'A',orderItemIndex:0,quantity:4,warehouseId:'MAIN',productKey:'P',ownerUid:'sales1',salesCode:'S01'});
}
function transferData({linked=false,handoff=false}={}){
 return {id:'T',inventoryId:'P',productKey:'P',fromStockId:'MAIN__P',toStockId:handoff?'custody-sales1__P':'EXT__P',fromWarehouseId:'MAIN',toWarehouseId:handoff?'custody-sales1':'EXT',qty:linked?4:3,reservedQty:linked?4:0,kind:handoff?'HANDOFF':'TRANSFER',status:handoff?'RECEIVED':'IN_TRANSIT',createdByUid:'buyer1',orderId:linked?'logistics':'',itemId:linked?'A':'',itemIndex:linked?0:-1,allocations:[{lotId:'L',targetLotId:'T-0',qty:linked?4:3,costLotId:'L'}]};
}
test('warehouse recipient plan cannot change commercial values or another item',async()=>{
 await seedWarehouseLogistics();const old=(await getDoc(doc(db('buyer1'),'orders/logistics'))).data(),p={mode:'SALES_SHIP',warehouseId:'',contact:'Luke',phone:'123',address:'台南',packages:1,condition:'常溫',notes:'',tracking:''};
 const update={items:[{...old.items[0],deliveryPlan:p}],logisticsPlanItemIndex:0,logisticsPlanActorUid:'buyer1',logisticsHistory:[{id:'plan',action:'交付設定'}],updatedAt:'2026-10-09'};
 await assertFails(updateDoc(doc(db('sales2'),'orders/logistics'),update));
 await assertFails(updateDoc(doc(db('buyer1'),'orders/logistics'),{...update,customerName:'changed'}));
 await assertSucceeds(updateDoc(doc(db('buyer1'),'orders/logistics'),update));
});
test('stock transfer requires matching source stock and aggregate transit evidence and denies commercial API writes',async()=>{
 await seedWarehouseLogistics();const data=transferData();
 await assertFails(setDoc(doc(db('buyer1'),'stockTransfers/T'),data));await assertFails(setDoc(doc(db('sales1'),'stockTransfers/T'),data));
 const client=db('buyer1'),b=writeBatch(client);b.set(doc(client,'stockTransfers/T'),data);b.update(doc(client,'warehouseStocks/MAIN__P'),{onHand:7,reserved:4});b.update(doc(client,'inventory/P'),{transferInTransit:3,transferFreeInTransit:3});await assertSucceeds(b.commit());
 await assertFails(updateDoc(doc(client,'stockTransfers/T'),{qty:4}));await assertFails(deleteDoc(doc(db('admin'),'stockTransfers/T')));
 const receipt=writeBatch(client);receipt.update(doc(client,'stockTransfers/T'),{status:'RECEIVED',receivedByUid:'buyer1',receivedAt:'2026-10-09'});receipt.set(doc(client,'warehouseStocks/EXT__P'),{productKey:'P',warehouseId:'EXT',onHand:3,reserved:0,incoming:0});receipt.update(doc(client,'inventory/P'),{transferInTransit:0,transferFreeInTransit:0});await assertSucceeds(receipt.commit());
});
test('order-linked transfer preserves customer delivery and cannot be cancelled or have its pending fields bypassed',async()=>{
 await seedWarehouseLogistics();const client=db('buyer1'),data=transferData({linked:true});
 const old=(await getDoc(doc(client,'orders/logistics'))).data();
 const b=writeBatch(client);b.set(doc(client,'stockTransfers/T'),data);b.update(doc(client,'warehouseStocks/MAIN__P'),{onHand:6,reserved:0});b.update(doc(client,'inventory/P'),{transferInTransit:4,transferFreeInTransit:0});b.update(doc(client,'orders/logistics'),{items:[{...old.items[0],transferPendingId:'T'}],warehouseLogisticsId:'T',logisticsTransfersPending:1,logisticsHistory:[{id:'T'}],workCategories:['delivery'],updatedAt:'2026-10-09'});await assertSucceeds(b.commit());
 await assertFails(updateDoc(doc(db('sales1'),'orders/logistics'),{status:'cancelled'}));await assertFails(updateDoc(doc(db('admin'),'orders/logistics'),{status:'cancelled'}));
 await assertFails(updateDoc(doc(db('sales1'),'orders/logistics'),{logisticsTransfersPending:0,items:old.items}));
 const receipt=writeBatch(client);receipt.update(doc(client,'stockTransfers/T'),{status:'RECEIVED',receivedByUid:'buyer1',receivedAt:'2026-10-09'});receipt.set(doc(client,'warehouseStocks/EXT__P'),{productKey:'P',warehouseId:'EXT',onHand:4,reserved:4,incoming:0});receipt.update(doc(client,'inventory/P'),{transferInTransit:0,transferFreeInTransit:0});receipt.update(doc(client,'orders/logistics'),{items:[{...old.items[0],warehouseId:'EXT',transferPendingId:''}],warehouseLogisticsId:'T',warehouseLogisticsEventId:'T-received',logisticsTransfersPending:0,logisticsHistory:[{id:'T'},{id:'received'}],updatedAt:'2026-10-09'});
 const evidence={inventoryId:'P',warehouseStockId:'EXT__P',previousWarehouseStockId:'MAIN__P',movementId:'T-in',reservationIds:['logistics__A']};
 receipt.update(doc(client,'inventoryReservations/logistics__A'),{warehouseId:'EXT',stockEvidence:evidence});
 receipt.set(doc(client,'inventoryMovements/T-in'),{type:'warehouse_transfer_in',sourceType:'WAREHOUSE_TRANSFER',sourceId:'T',productKey:'P',warehouseId:'EXT',qty:4,reservationStockEvidence:evidence});
 await assertSucceeds(receipt.commit());
 assert.equal((await getDoc(doc(client,'inventoryReservations/logistics__A'))).data().warehouseId,'EXT');
});
test('handoff creates scoped custody location without broadening warehouse master permission and remains unfulfilled',async()=>{
 await seedWarehouseLogistics();const client=db('buyer1'),data=transferData({linked:true,handoff:true}),old=(await getDoc(doc(client,'orders/logistics'))).data();
 await assertFails(setDoc(doc(client,'warehouses/arbitrary'),{warehouseName:'Arbitrary',active:true}));
 const b=writeBatch(client);b.set(doc(client,'stockTransfers/T'),data);b.update(doc(client,'warehouseStocks/MAIN__P'),{onHand:6,reserved:0});b.set(doc(client,'warehouseStocks/custody-sales1__P'),{productKey:'P',warehouseId:'custody-sales1',onHand:4,reserved:4,incoming:0});b.set(doc(client,'warehouses/custody-sales1'),{warehouseName:'業務保管',active:true,isDefault:false,systemCustody:true,warehouseType:'CUSTODY',ownerUid:'sales1',sourceTransferId:'T'});b.update(doc(client,'orders/logistics'),{items:[{...old.items[0],warehouseId:'custody-sales1',custodyTransferId:'T'}],warehouseLogisticsId:'T',logisticsTransfersPending:0,logisticsHistory:[{id:'T'}],updatedAt:'2026-10-09'});await assertSucceeds(b.commit());
 const order=(await getDoc(doc(client,'orders/logistics'))).data();assert.deepEqual(order.deliveryRecords,[]);
 await assertFails(updateDoc(doc(db('sales1'),'orders/logistics'),{status:'cancelled'}));await assertFails(updateDoc(doc(db('sales1'),'orders/logistics'),{items:old.items}));
});


test('responsible salesperson retains scoped stock access after warehouse handoff',async()=>{
 await seedStockWorkflow();
 await seed('orders/stock-order',{ownerUid:'sales1',salesCode:'S01',deliveredQty:0,returnedQty:0,warehouseLogisticsId:'H',logisticsTransfersPending:0,logisticsHistory:[{id:'H'}],items:[{itemId:'item-1',productId:'p1',qty:5,warehouseId:'custody-sales1'}]});
 await seed('warehouseStocks/w1-p1',{productKey:'p1',warehouseId:'custody-sales1',onHand:10,reserved:0,incoming:0});
 await seed('inventoryLots/l1',{productKey:'p1',warehouseId:'custody-sales1',remainingQty:10});
 await assertSucceeds(stockWorkflow(0,5,'reserve','custody-sales1'));
 await assertSucceeds(stockWorkflow(-2,3,'ship','custody-sales1'));
});

test('warehouse initial stock can link pending cost but cannot invent protected costs', async () => {
  const client=db('wh1');
  const pending={lotId:'initial-lot',sourceType:'INITIAL_STOCK',costPending:true};
  await assertFails(setDoc(doc(client,'inventoryLotCosts/initial-lot'),pending));
  await seed('inventoryLots/initial-lot',{sourceType:'INITIAL_STOCK',remainingQty:2});
  await assertSucceeds(setDoc(doc(client,'inventoryLotCosts/initial-lot'),pending));
  for(const field of ['unitCost','cost','costPrice']){
    await seed('inventoryLots/initial-'+field,{sourceType:'INITIAL_STOCK',remainingQty:2});
    await assertFails(setDoc(doc(client,'inventoryLotCosts/initial-'+field),{...pending,lotId:'initial-'+field,[field]:0}));
  }
  await assertSucceeds(updateDoc(doc(db('buyer1'),'inventoryLotCosts/initial-lot'),{unitCost:0,costPending:false}));
});
test('inventory quantities must be numeric rather than strings or booleans', async () => {
  for(const onHand of ['10',true,-1]){
    await assertFails(setDoc(doc(db('admin'),'warehouseStocks/invalid'),{warehouseId:'w',productKey:'p',onHand,reserved:0}));
  }
  await assertSucceeds(setDoc(doc(db('admin'),'warehouseStocks/valid'),{warehouseId:'w',productKey:'p',onHand:0,reserved:0}));
});
test('stock quantities reject over-reservation and invalid incoming on both create and update for operational roles',async()=>{
 for(const uid of ['admin','buyer1','wh1']){
  for(const collectionName of ['inventory','warehouseStocks']){
   const ref=doc(db(uid),collectionName+'/'+uid);
   const valid={productKey:'P',productId:'P',warehouseId:'MAIN',onHand:5,reserved:2,incoming:0};
   for(const patch of [{reserved:6},{onHand:1},{incoming:-1},{incoming:'1'},{incoming:true},{reserved:'2'}]){
    await assertFails(setDoc(ref,{...valid,...patch}));
   }
   await assertSucceeds(setDoc(ref,valid));
   for(const patch of [{reserved:6},{onHand:1},{incoming:-1},{incoming:'1'},{incoming:true},{reserved:'2'}]){
    await assertFails(updateDoc(ref,patch));
   }
   // Reservation release, fractional stock, and normal receipts remain valid.
   await assertSucceeds(updateDoc(ref,{onHand:2.5,reserved:2.5,incoming:1.5}));
   await assertSucceeds(updateDoc(ref,{reserved:0}));
   await assertSucceeds(updateDoc(ref,{onHand:4,incoming:0}));
  }
 }
});
test('warehouse stock cannot be relabelled as another product or warehouse, including by admin',async()=>{
 for(const uid of ['admin','buyer1','wh1']){
  const ref=doc(db(uid),'warehouseStocks/'+uid);
  const valid={productKey:'P',productId:'P',warehouseId:'MAIN',onHand:5,reserved:2,incoming:0};
  for(const patch of [{productKey:''},{warehouseId:''},{productKey:1},{warehouseId:true},{productId:1}]){
   await assertFails(setDoc(ref,{...valid,...patch}));
  }
  await assertSucceeds(setDoc(ref,valid));
  for(const patch of [{productKey:'OTHER'},{warehouseId:'OTHER'},{productId:'OTHER'},{productKey:''},{warehouseId:''}]){
   await assertFails(updateDoc(ref,patch));
  }
  await assertSucceeds(updateDoc(ref,{itemName:'更新顯示品名',onHand:6,reserved:3}));
 }
});
test('commercial owner can edit one unhanded recipient after another item entered custody, but not custody, transit or commercial data',async()=>{
 await seedWarehouseLogistics();const ref=doc(db('sales1'),'orders/logistics'),old=(await getDoc(ref)).data();
 const base={...old,warehouseLogisticsId:'HAND',logisticsHistory:[{id:'HAND'}],items:[old.items[0],{...old.items[0],itemId:'B',warehouseId:'custody-sales1',custodyTransferId:'HAND',deliveryPlan:{mode:'PICKUP'}}]};await seed('orders/logistics',base);
 const plan={mode:'CUSTOMER_SHIP',warehouseId:'',contact:'客戶',phone:'123',address:'地址',packages:1,condition:'常溫',tracking:'',notes:''};
 const update={items:[{...base.items[0],deliveryPlan:plan},base.items[1]],logisticsPlanItemIndex:0,logisticsPlanActorUid:'sales1',logisticsPlanEventId:'PLAN',logisticsHistory:[{id:'HAND'},{id:'PLAN'}],updatedAt:'2026-10-11'};
 await assertFails(updateDoc(doc(db('sales2'),'orders/logistics'),update));await assertFails(updateDoc(ref,{...update,customerName:'改客戶'}));
 await assertSucceeds(updateDoc(ref,update));
 await assertFails(updateDoc(ref,{items:[update.items[0],{...base.items[1],deliveryPlan:plan}]}));
 await assertFails(updateDoc(ref,{...update,items:[update.items[0],{...base.items[1],deliveryPlan:plan}],logisticsPlanItemIndex:1,logisticsPlanEventId:'BAD',logisticsHistory:[...update.logisticsHistory,{id:'BAD'}]}));
 const pending={...base,items:[{...base.items[0],transferPendingId:'T'},base.items[1]]};await seed('orders/logistics',pending);
 await assertFails(updateDoc(ref,{...update,items:[{...pending.items[0],deliveryPlan:plan},pending.items[1]]}));
});
test('commercial address masters and admin salesperson pickup preferences respect role permissions',async()=>{
 const address={shippingAddresses:[{id:'a',contact:'A',phone:'123',address:'台南'}],defaultShippingAddressId:'a',name:'客戶',active:true};
 await assertSucceeds(setDoc(doc(db('sales1'),'customers/recipient'),address));await assertSucceeds(getDoc(doc(db('wh1'),'customers/recipient')));await assertFails(updateDoc(doc(db('wh1'),'customers/recipient'),{defaultShippingAddressId:'other'}));
 await assertSucceeds(updateDoc(doc(db('admin'),'users/sales1'),{deliveryDefaults:{mode:'SALES_SHIP',contact:'業務',phone:'456',address:'高雄'}}));await assertFails(updateDoc(doc(db('sales1'),'users/sales1'),{deliveryDefaults:{mode:'PICKUP'}}));
});

function mainRequestData(){return {id:'REQ',inventoryId:'P',productKey:'P',productId:'P',itemCode:'001',itemName:'試劑',brand:'Qiagen',fromWarehouseId:'EXT',toWarehouseId:'MAIN',fromStockId:'EXT_P',qty:3,status:'PENDING',createdByUid:'buyer1',createdAt:'2026-10-12T00:00:00Z'};}
async function seedMainRequestStock(){
 await seed('warehouses/MAIN',{warehouseName:'主倉',active:true,isDefault:true});await seed('warehouses/EXT',{warehouseName:'分倉',active:true,isDefault:false});
 await seed('inventory/P',{productKey:'P',onHand:20,reserved:5,incoming:0,stockPolicy:'ORDER_ONLY',safetyStock:0});
 await seed('warehouseStocks/EXT_P',{productKey:'P',warehouseId:'EXT',onHand:10,reserved:2,incoming:0});
 await seed('warehouseStocks/MAIN_P',{productKey:'P',warehouseId:'MAIN',onHand:10,reserved:3,incoming:0});
}
function holdMainRequest(uid,patch={}){
 const firestore=db(uid),batch=writeBatch(firestore),r={...mainRequestData(),...patch};
 batch.set(doc(firestore,'stockTransferRequests/REQ'),r);
 batch.update(doc(firestore,'warehouseStocks/EXT_P'),{reserved:5,transferReserved:3});
 batch.update(doc(firestore,'inventory/P'),{reserved:8,transferReserved:3});return batch.commit();
}
test('main replenishment requests require purchasing, main destination and atomic stock holds; read and schema boundaries stay restricted',async()=>{
 await seedMainRequestStock();
 for(const uid of ['sales1','wh1'])await assertFails(holdMainRequest(uid,{createdByUid:uid}));
 await assertFails(holdMainRequest('buyer1',{createdByUid:'admin'}));
 await assertFails(holdMainRequest('buyer1',{extra:'unexpected'}));
 await assertFails(holdMainRequest('buyer1',{qty:100}));
 await assertFails(holdMainRequest('buyer1',{qty:-1}));
 await assertFails(holdMainRequest('buyer1',{toWarehouseId:'EXT'}));
 await assertFails(setDoc(doc(db('buyer1'),'stockTransferRequests/REQ'),mainRequestData()));
 await assertSucceeds(holdMainRequest('buyer1'));
 await assertSucceeds(getDocs(query(collection(db('wh1'),'stockTransferRequests'),where('status','==','PENDING'),limit(50))));
 await assertFails(getDoc(doc(db('sales1'),'stockTransferRequests/REQ')));
 await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),'stockTransferRequests/REQ')));
 await assertFails(updateDoc(doc(db('buyer1'),'stockTransferRequests/REQ'),{qty:4}));
 await assertFails(updateDoc(doc(db('buyer1'),'stockTransferRequests/REQ'),{createdByUid:'admin'}));
 await assertFails(deleteDoc(doc(db('admin'),'stockTransferRequests/REQ')));
});
test('pending replenishment cancellation releases exactly its hold and cannot be replayed or bypassed by warehouse',async()=>{
 await seedMainRequestStock();await assertSucceeds(holdMainRequest('buyer1'));
 const cancel=uid=>{const firestore=db(uid),b=writeBatch(firestore);b.update(doc(firestore,'stockTransferRequests/REQ'),{status:'CANCELLED',cancelledAt:'2026-10-12',cancelledByUid:uid});b.update(doc(firestore,'inventory/P'),{reserved:5,transferReserved:0});b.update(doc(firestore,'warehouseStocks/EXT_P'),{reserved:2,transferReserved:0});return b.commit();};
 await assertFails(cancel('wh1'));
 await assertFails(updateDoc(doc(db('buyer1'),'stockTransferRequests/REQ'),{status:'CANCELLED',cancelledAt:'2026-10-12',cancelledByUid:'buyer1'}));
 await assertSucceeds(cancel('buyer1'));await assertFails(cancel('buyer1'));
});
test('warehouse dispatch converts a pending replenishment hold into a linked immutable transfer and receiving restores free stock',async()=>{
 await seedMainRequestStock();await assertSucceeds(holdMainRequest('buyer1'));
 const uid='wh1',firestore=db(uid),r=mainRequestData();
 const transfer={id:'SEND',requestId:'REQ',inventoryId:'P',productKey:'P',fromWarehouseId:'EXT',toWarehouseId:'MAIN',fromStockId:'EXT_P',toStockId:'MAIN_P',qty:3,reservedQty:0,kind:'TRANSFER',status:'IN_TRANSIT',orderId:'',createdByUid:uid,allocations:[{lotId:'L',qty:3}]};
 await assertFails(updateDoc(doc(firestore,'stockTransferRequests/REQ'),{status:'SHIPPED',transferId:'SEND',shippedAt:'2026-10-12',shippedByUid:uid}));
 const ship=writeBatch(firestore);ship.set(doc(firestore,'stockTransfers/SEND'),transfer);ship.update(doc(firestore,'stockTransferRequests/REQ'),{status:'SHIPPED',transferId:'SEND',shippedAt:'2026-10-12',shippedByUid:uid});ship.update(doc(firestore,'warehouseStocks/EXT_P'),{onHand:7,reserved:2,transferReserved:0});ship.update(doc(firestore,'inventory/P'),{reserved:5,transferReserved:0,transferInTransit:3,transferFreeInTransit:3});await assertSucceeds(ship.commit());
 const receive=writeBatch(firestore);receive.update(doc(firestore,'stockTransfers/SEND'),{status:'RECEIVED',receivedAt:'2026-10-12',receivedByUid:uid});receive.update(doc(firestore,'warehouseStocks/MAIN_P'),{onHand:13,reserved:3});receive.update(doc(firestore,'inventory/P'),{transferInTransit:0,transferFreeInTransit:0});await assertSucceeds(receive.commit());
 await assertFails(updateDoc(doc(firestore,'stockTransferRequests/REQ'),{status:'PENDING'}));
});


test('pending self-order entry permits no embedded cost for its owner and retains delivery snapshot',async()=>{
 for(const [uid,code,role] of [['sales1','S01','sales'],['eng1','E01','engineer']]){
  const item={itemId:'I',productId:'p-order',productMasterMatched:true,itemName:'Product',qty:1,unitPrice:100,procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:false,fulfillmentType:'WAREHOUSE',warehouseId:'W1',deliveryPlan:{mode:'PICKUP',contact:'',phone:'',address:'',warehouseId:'W1',packages:1,notes:''}};
  await assertSucceeds(setDoc(doc(db(uid),'orders/pending-'+uid),{...validOrderProduct,customerName:'Customer',ownerUid:uid,salesCode:code,createdByUid:uid,createdByRole:role,createdByName:uid,procurementType:'SALES_SELF_ORDER',selfOrderAtCreation:true,items:[item]}));
 }
});
test('purchaser may create a pending self-order for an engineer without gaining owner confirmations',async()=>{
 const data={...validOrderProduct,customerName:'Customer',ownerUid:'eng1',salesCode:'E01',createdByUid:'buyer1',createdByRole:'purchaser',createdByName:'Buyer',procurementType:'SALES_SELF_ORDER',selfOrderAtCreation:true,items:[{itemId:'I',productId:'p-order',qty:1,unitPrice:100,procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:false}]};
 await assertSucceeds(setDoc(doc(db('buyer1'),'orders/pending-assisted'),data));
 await assertFails(updateDoc(doc(db('buyer1'),'orders/pending-assisted'),{isBilled:true}));
 await assertFails(setDoc(doc(db('wh1'),'orders/pending-warehouse'),data));
});
test('owner can confirm pending self-order with actual zero cost and supplier in one batch; others cannot claim it',async()=>{
 const item={itemId:'I',productId:'p-order',qty:1,unitPrice:100,procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:false};
 const data={...validOrderProduct,ownerUid:'sales1',salesCode:'S01',createdByUid:'sales1',createdByRole:'sales',procurementType:'SALES_SELF_ORDER',items:[item]};
 await seed('orders/pending-confirm',data);
 const record={type:'SALES_SELF_ORDER',method:'SALES_SELF_ORDER',ownerUid:'sales1',salesCode:'S01',sourceType:'SALES_ORDER',sourceId:'pending-confirm',sourceItemId:'I',qty:1,receivedQty:0,status:'ORDERED',supplier:'Vendor',unitCost:0};
 await assertFails(setDoc(doc(db('sales2'),'supplyOrders/pending-other'),record));
 const client=db('sales1'),batch=writeBatch(client);
 batch.set(doc(client,'supplyOrders/pending-confirm'),record);
 batch.update(doc(client,'orders/pending-confirm'),{items:[{...item,supplier:'Vendor',costPrice:0,supplyOrderedQty:1,selfOrderNos:['SO-TEST'],orderedAt:'2026-10-13',orderEvents:[{id:'pending-confirm',type:'SALES_SELF_ORDER',qty:1}]}]});
 await assertSucceeds(batch.commit());
});


for(const uid of ['admin','buyer1','wh1'])test(uid+' stock recovery metadata is bounded, monotonic and cannot rewrite stock identity',async()=>{
 const base={productKey:'recovery-p',productId:'recovery-p',warehouseId:'W1',onHand:3,reserved:0,incoming:0};
 const ref=doc(db(uid),'warehouseStocks/W1__recovery-p');
 for(const patch of [{allocationPending:'true',allocationRevision:1},{allocationPending:true},{allocationPending:true,allocationRevision:0},{allocationPending:true,allocationRevision:1.5},{allocationPending:true,allocationRevision:1000000001}])await assertFails(setDoc(ref,{...base,...patch}));
 await assertSucceeds(setDoc(ref,{...base,allocationPending:true,allocationRevision:1}));
 for(const patch of [{allocationRevision:0},{allocationRevision:2},{allocationPending:false,onHand:4},{allocationPending:true,allocationRevision:3,onHand:4},{allocationRevision:2,onHand:2},{productKey:'other',allocationPending:false}])await assertFails(updateDoc(ref,patch));
 await assertSucceeds(updateDoc(ref,{onHand:4,allocationRevision:2,allocationPending:true}));
 await assertSucceeds(updateDoc(ref,{allocationPending:false}));
 await assertSucceeds(updateDoc(ref,{reserved:1}));
});
test('business owners cannot clear or fabricate an operational recovery queue',async()=>{
 await seed('warehouseStocks/W1__recovery-business',{productKey:'recovery-business',warehouseId:'W1',onHand:3,reserved:0,incoming:0,allocationRevision:1,allocationPending:true});
 for(const uid of ['sales1','eng1','off1']){
  await assertFails(updateDoc(doc(db(uid),'warehouseStocks/W1__recovery-business'),{allocationPending:false}));
  await assertFails(updateDoc(doc(db(uid),'warehouseStocks/W1__recovery-business'),{allocationPending:true,allocationRevision:2}));
 }
 await assertFails(getDocs(query(collection(env.unauthenticatedContext().firestore(),'warehouseStocks'),where('allocationPending','==',true))));
 await assertSucceeds(getDocs(query(collection(db('buyer1'),'warehouseStocks'),where('allocationPending','==',true),limit(50))));
 await assertSucceeds(getDocs(query(collection(db('wh1'),'warehouseStocks'),where('allocationPending','==',true),limit(50))));
});
for(const [uid,role] of [['buyer1','purchaser'],['wh1','warehouse']])test(role+' actual free stock recovery updates reservation and procurement atomically and clears its durable flag',async()=>{
 const f=await orderInitializationFixture(uid,role,{onHand:0,ownerUid:'sales1'}),fulfillment=require('../modules/fulfillment-core'),recovery=require('../modules/free-stock-recovery');
 const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 await seed('orders/'+f.id,{...original,inventoryReservationStatus:'completed',items:original.items.map(i=>fulfillment.normalizeItem({...i,inventoryProductKey:'init-product'}))});
 await seed('inventoryReservations/'+f.id+'__I',{orderId:f.id,itemId:'I',orderItemIndex:0,ownerUid:'sales1',salesCode:'S01',productKey:'init-product',warehouseId:'W1',quantity:0,shortageQty:5,status:'shortage'});
 await assertSucceeds(stockPermissions.run(f.client,async tx=>{const inv=f.client.collection('inventory').doc('init-product'),wh=f.client.collection('warehouseStocks').doc('W1__init-product');await tx.get(inv);await tx.get(wh);tx.update(inv,{onHand:3});tx.update(wh,{onHand:3});},uid,false,role));
 const pending=(await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data();assert.equal(pending.allocationPending,true);assert.equal(pending.allocationRevision,1);
 Object.assign(f.context,{firestoreReadWithTimeout:p=>p,itemDispatchState:(_o,i)=>fulfillment.dispatchState(i),orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus)});
 const app=fs.readFileSync('app.js','utf8');vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),f.context);
 const options={db:f.client,runTransaction:f.context.runRoleTransaction,allocate:f.context.allocateFreeReceiptStockToShortages,normalize:require('../modules/inventory-core').normalizeStock,stockDocId:(w,p)=>w+'__'+p,assertContext(){},stockId:'W1__init-product',actor:uid};
 await assertSucceeds(recovery.recoverLocation(options));await assertSucceeds(recovery.recoverLocation(options));
 const stock=(await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data();assert.equal(stock.reserved,3);assert.equal(stock.onHand,3);assert.equal(stock.allocationPending,false);assert.equal(stock.allocationRevision,1);
 assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().items[0].reservedQty,3);
 assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).data().remainingToOrderQty,2);
});
for(const [uid,role] of [['sales1','sales'],['eng1','engineer']])test(role+' actual cancellation releases stock and queues recovery without granting recovery control',async()=>{
 const f=await orderInitializationFixture(uid,role);await f.run();
 const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();await seed('orders/'+f.id,{...original,inventoryReservationStatus:'completed'});
 Object.assign(f.context,{savedDeliveryRecords:o=>o.deliveryRecords||[],savedReturnRecords:o=>o.returnRecords||[]});
 const app=fs.readFileSync('app.js','utf8');f.context.DOCUMENT_TYPES={ORDER:'order'};
 vm.runInContext(app.slice(app.indexOf('function inventoryMovementRecord('),app.indexOf('function inventoryReservationPayload(')),f.context);
 vm.runInContext(app.slice(app.indexOf('async function adjustInventoryReservationForLifecycle('),app.indexOf('function confirmOrderCancellation(')),f.context);
 await assertSucceeds(f.context.runRoleTransaction(async tx=>{const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref);await f.context.adjustInventoryReservationForLifecycle(tx,f.id,snap.data(),'cancelled',uid);tx.update(ref,{status:'cancelled',orderStatus:'cancelled'});}));
 const stock=(await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data();assert.equal(stock.reserved,0);assert.equal(stock.onHand,3);assert.equal(stock.allocationPending,true);assert.equal(stock.allocationRevision,1);
 await assertFails(updateDoc(doc(db(uid),'warehouseStocks/W1__init-product'),{allocationPending:false}));
});


function loadActualLifecycle(f){
 Object.assign(f.context,{savedDeliveryRecords:o=>o.deliveryRecords||[],savedReturnRecords:o=>o.returnRecords||[],DOCUMENT_TYPES:{ORDER:'order'}});
 const app=fs.readFileSync('app.js','utf8');
 vm.runInContext(app.slice(app.indexOf('function inventoryMovementRecord('),app.indexOf('function inventoryReservationPayload(')),f.context);
 vm.runInContext(app.slice(app.indexOf('function orderItemProcurementDemandDocument('),app.indexOf('async function persistOrderProcurementDemands(')),f.context);
 vm.runInContext(app.slice(app.indexOf('async function adjustInventoryReservationForLifecycle('),app.indexOf('function confirmOrderCancellation(')),f.context);
 return status=>f.context.runRoleTransaction(async tx=>{
  const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref);
  await f.context.adjustInventoryReservationForLifecycle(tx,f.id,snap.data(),status,f.context.currentUser.uid);
  tx.update(ref,{status:status==='normal'?'active':'cancelled',orderStatus:status});
 });
}
test('cancellation changes the demand and held stock atomically for the owner; unrelated writers cannot close demand',async()=>{
 for(const [uid,role] of [['admin','admin'],['sales1','sales'],['eng1','engineer']]){
  const f=await orderInitializationFixture(uid,role);await f.run();
  const current=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  await seed('orders/'+f.id,{...current,inventoryReservationStatus:'completed'});
  const demandPath='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
  const before=(await getDoc(doc(db('admin'),demandPath))).data();
  assert.equal(before.status,'PENDING');
  const client=db(uid);
  // Administrators retain the pre-existing unrestricted demand update privilege.
  if(role!=='admin'){
   await assertFails(updateDoc(doc(client,demandPath),{status:'CANCELLED',remainingToOrderQty:0}));
   await seed('orders/'+f.id,{...current,inventoryReservationStatus:'pending'});
   await assertFails(updateDoc(doc(client,demandPath),{status:'CANCELLED',remainingToOrderQty:0}));
   await seed('orders/'+f.id,{...current,inventoryReservationStatus:'completed'});
  }
  const run=loadActualLifecycle(f);
  await assertSucceeds(run('cancelled'));
  const after=(await getDoc(doc(db('admin'),demandPath))).data();
  assert.equal(after.status,'CANCELLED');assert.equal(after.remainingToOrderQty,0);
  assert.equal(after.orderedQty,before.orderedQty);assert.equal(after.receivedQty,before.receivedQty);
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,0);
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,0);
 }
});
test('malformed linked demand prevents cancellation from partially releasing reserved inventory',async()=>{
 const f=await orderInitializationFixture('sales1','sales');await f.run();
 const current=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 await seed('orders/'+f.id,{...current,inventoryReservationStatus:'completed'});
 const demandPath='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
 const demand=(await getDoc(doc(db('admin'),demandPath))).data();
 await seed(demandPath,{...demand,productKey:'wrong-product'});
 await assert.rejects(loadActualLifecycle(f)('cancelled'),/不一致/);
 assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().status,'active');
 assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,3);
 assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data().reserved,3);
});
function loadActualPermanentDelete(f){
 loadActualLifecycle(f);
 const app=fs.readFileSync('app.js','utf8');
 vm.runInContext(app.slice(app.indexOf('function assertOrderEligibleForPermanentDelete('),app.indexOf('window.permanentlyDeleteOrder =')),f.context);
 return ()=>f.context.deleteUnfulfilledOrderAtomically(f.id,f.context.currentUser.uid);
}
test('admin permanent deletion atomically releases stock and deletes all linked unpurchased demand and reservations',async()=>{
 for(const [status,onHand] of [['active',3],['cancelled',0]]){
  const f=await orderInitializationFixture('admin','admin',{onHand});await f.run();
  const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  await seed('orders/'+f.id,{...order,status,orderStatus:status,inventoryReservationStatus:'completed'});
  const reservation='inventoryReservations/'+f.id+'__I';
  const demand='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
  if(status==='cancelled')await seed(demand,{...(await getDoc(doc(db('admin'),demand))).data(),status:'CANCELLED',remainingToOrderQty:0});
  await assertSucceeds(loadActualPermanentDelete(f)());
  assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).exists(),false);
  assert.equal((await getDoc(doc(db('admin'),reservation))).exists(),false);
  assert.equal((await getDoc(doc(db('admin'),demand))).exists(),false);
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,0);
  assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data().reserved,0);
 }
});
test('admin deletion refuses hidden supplier commitments; business cannot delete another role protected order',async()=>{
 const f=await orderInitializationFixture('admin','admin');await f.run();
 const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 await seed('orders/'+f.id,{...original,inventoryReservationStatus:'completed'});
 const demand='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
 const linked=(await getDoc(doc(db('admin'),demand))).data();
 await seed(demand,{...linked,orderedQty:1,requestedQty:2,remainingToOrderQty:1,remainingToReceiveQty:1});
 await assert.rejects(loadActualPermanentDelete(f)(),/供應商承諾/);
 assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).exists(),true);
 assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,3);
 assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data().reserved,3);
 const sales=await orderInitializationFixture('sales1','sales');await sales.run();
 const saleOrder=(await getDoc(doc(db('admin'),'orders/'+sales.id))).data();
 await seed('orders/'+sales.id,{...saleOrder,inventoryReservationStatus:'completed'});
 await assertFails(loadActualPermanentDelete(sales)());
 assert.equal((await getDoc(doc(db('admin'),'orders/'+sales.id))).exists(),true);
});
test('actual lifecycle refuses underfunded cancellation for admin and business roles without erasing the original hold',async()=>{
 for(const [uid,role] of [['admin','admin'],['sales1','sales'],['eng1','engineer']]){
  const f=await orderInitializationFixture(uid,role);await f.run();
  const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  await seed('orders/'+f.id,{...original,inventoryReservationStatus:'completed'});
  const run=loadActualLifecycle(f);
  for(const [company,warehouse] of [[1,3],[3,1]]){
   await seed('inventory/init-product',{productKey:'init-product',onHand:3,reserved:company,incoming:0});
   await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:3,reserved:warehouse,incoming:0});
   await assert.rejects(run('cancelled'),/不足|異常/);
   assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,3);
   assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,company);
   assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data().reserved,warehouse);
   assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().status,'active');
  }
  await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:3,reserved:3,incoming:0});
  await assertSucceeds(run('cancelled'));await assertSucceeds(run('normal'));
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,3);
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,3);
 }
});
test('atomic order restoration reopens linked purchase demand for sales, engineer and admin',async()=>{
 for(const [uid,role] of [['admin','admin'],['sales1','sales'],['eng1','engineer']]){
  const f=await orderInitializationFixture(uid,role);await f.run();
  const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  await seed('orders/'+f.id,{...order,inventoryReservationStatus:'completed'});
  const run=loadActualLifecycle(f);
  const id='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
  await assertSucceeds(run('cancelled'));
  const closed=(await getDoc(doc(db('admin'),id))).data();
  assert.equal(closed.status,'CANCELLED');assert.equal(closed.remainingToOrderQty,0);
  if(role!=='admin'){
   const client=db(uid);
   await assertFails(updateDoc(doc(client,id),{status:'PENDING',remainingToOrderQty:2}));
  }
  await assertSucceeds(run('normal'));
  const restored=(await getDoc(doc(db('admin'),id))).data();
  assert.equal(restored.status,'PENDING');assert.equal(restored.requestedQty,2);
  assert.equal(restored.remainingToOrderQty,2);
  assert.equal(restored.orderedQty,closed.orderedQty);assert.equal(restored.receivedQty,closed.receivedQty);
  assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().status,'active');
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,3);
 }
});
test('restoring without a prior demand creates it in the same reservation transaction',async()=>{
 for(const [uid,role] of [['admin','admin'],['sales1','sales'],['eng1','engineer']]){
  const f=await orderInitializationFixture(uid,role,{onHand:0});await f.run();
  const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  const d='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
  await seed('orders/'+f.id,{...order,status:'cancelled',orderStatus:'cancelled',inventoryReservationStatus:'completed'});
  await env.withSecurityRulesDisabled(async c=>c.firestore().doc(d).delete());
  const run=loadActualLifecycle(f);
  await assertSucceeds(run('normal'));
  const demand=(await getDoc(doc(db('admin'),d))).data();
  assert.equal(demand.requestedQty,5);assert.equal(demand.status,'PENDING');
  assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().status,'active');
 }
});
test('restore detects supplier quantity drift and leaves reservation, demand and order untouched',async()=>{
 const f=await orderInitializationFixture('sales1','sales',{onHand:0});await f.run();
 const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 const id='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
 const demand=(await getDoc(doc(db('admin'),id))).data();
 await seed('orders/'+f.id,{...original,status:'cancelled',orderStatus:'cancelled',inventoryReservationStatus:'completed'});
 await seed(id,{...demand,status:'CANCELLED',remainingToOrderQty:0,orderedQty:2,remainingToReceiveQty:2});
 const run=loadActualLifecycle(f);
 await assert.rejects(run('normal'),/不一致|稽核/);
 assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().status,'cancelled');
 assert.equal((await getDoc(doc(db('admin'),id))).data().orderedQty,2);
 assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,0);
});
test('actual restoration respects zero and partial company availability for admin sales and engineer',async()=>{
 for(const [uid,role] of [['admin','admin'],['sales1','sales'],['eng1','engineer']]){
  const f=await orderInitializationFixture(uid,role,{onHand:0});await f.run();
  const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  const reservation=(await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data();
  const run=loadActualLifecycle(f);
  for(const companyReserved of [5,4]){
   await seed('orders/'+f.id,{...original,status:'cancelled',orderStatus:'cancelled',inventoryReservationStatus:'completed'});
   const linkedId='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
   const linked=(await getDoc(doc(db('admin'),linkedId))).data();
   await seed(linkedId,{...linked,status:'CANCELLED',remainingToOrderQty:0});
   await seed('inventoryReservations/'+f.id+'__I',reservation);
   await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:companyReserved,incoming:0});
   await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:5,reserved:0,incoming:0});
   await assertSucceeds(run('normal'));
   const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
   assert.equal(order.items[0].reservedQty,5-companyReserved);assert.equal(order.items[0].shortageQty,companyReserved);
   assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,5);
   assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data().reserved,5-companyReserved);
  }
 }
});

test('actual restoration cannot reserve in a disabled or custody-designated warehouse for any commercial role',async()=>{
 for(const [uid,role] of [['admin','admin'],['sales1','sales'],['eng1','engineer']]){
  const f=await orderInitializationFixture(uid,role,{onHand:0});await f.run();
  const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  const reservation=(await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data();
  const run=loadActualLifecycle(f);
  for(const warehouse of [{active:false},{active:true,systemCustody:true},{active:true,warehouseType:'CUSTODY'}]){
   await seed('warehouses/W1',warehouse);
   await seed('orders/'+f.id,{...original,status:'cancelled',orderStatus:'cancelled',inventoryReservationStatus:'completed'});
   const linkedId='procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I');
   const linked=(await getDoc(doc(db('admin'),linkedId))).data();
   await seed(linkedId,{...linked,status:'CANCELLED',remainingToOrderQty:0});
   await seed('inventoryReservations/'+f.id+'__I',reservation);
   await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:0,incoming:0});
   await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:5,reserved:0,incoming:0});
   await assert.rejects(run('normal'),/不能恢復預留/);
   assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,0);
   assert.equal((await getDoc(doc(db('admin'),'orders/'+f.id))).data().status,'cancelled');
   assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,0);
  }
  await seed('warehouses/W1',{active:true,isDefault:true});
  await assertSucceeds(run('normal'));
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,5);
 }
});
test('cancelled direct redirect requires a live physical warehouse and atomic incoming totals',async()=>{
 const locations=[['missing',null],['disabled',{active:false}],['custody-flag',{active:true,systemCustody:true}],
  ['custody-type',{active:true,warehouseType:'CUSTODY'}],['custody-prefix',{active:true}],['physical',{active:true,warehouseType:'PHYSICAL'}]];
 for(const [label,warehouse] of locations){
  const warehouseId=label==='custody-prefix'?'custody-redirect':'redirect-'+label;
  const id='redirect-'+label,key=id,stockId=warehouseId+'__'+key;
  if(warehouse)await seed('warehouses/'+warehouseId,warehouse);
  await seed('orders/'+id,{status:'cancelled',orderStatus:'cancelled',ownerUid:'sales1',salesCode:'S01'});
  await seed('supplyOrders/'+id,{type:'PURCHASING_PO',orderId:id,productKey:key,status:'PARTIAL_RECEIPT',
   qty:5,receivedQty:2,fulfillmentType:'DIRECT_SHIP',warehouseId:''});
  await seed('inventory/'+key,{productKey:key,onHand:0,reserved:0,incoming:4});
  await seed('warehouseStocks/'+stockId,{productKey:key,warehouseId,onHand:0,reserved:0,incoming:1});
  const patch={customerCancellationDisposition:'KEEP_STOCK',customerCancellationResolvedAt:'now',customerCancellationResolvedBy:'buyer1',updatedAt:'now',
   originalFulfillmentType:'DIRECT_SHIP',fulfillmentType:'WAREHOUSE',warehouseId,redirectInventoryId:key,redirectWarehouseStockId:stockId,incomingRegisteredQty:3};
  const commit=(uid='buyer1',includeStock=true)=>{
   const client=db(uid),batch=writeBatch(client);
   batch.update(doc(client,'supplyOrders/'+id),{...patch,customerCancellationResolvedBy:uid});
   if(includeStock){batch.update(doc(client,'inventory/'+key),{incoming:7});batch.update(doc(client,'warehouseStocks/'+stockId),{incoming:4});}
   return batch.commit();
  };
  if(label==='physical'){
   for(const uid of ['sales1','eng1','wh1'])await assertFails(commit(uid));
   await assertFails(commit('buyer1',false));
   await assertSucceeds(commit());
  }else{
   await assertFails(commit());
   assert.equal((await getDoc(doc(db('admin'),'inventory/'+key))).data().incoming,4);
   assert.equal((await getDoc(doc(db('admin'),'supplyOrders/'+id))).data().fulfillmentType,'DIRECT_SHIP');
  }
 }
});

test('actual initialization selects physical remote stock over free transit for authorized writers and safely retries',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{onHand:5,ownerUid:role==='purchaser'?'sales1':uid});
  await seed('inventory/init-product',{productKey:'init-product',onHand:10,reserved:0,incoming:0,transferFreeInTransit:5});
  await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:5,reserved:0,incoming:0,transferFreeInTransit:5});
  await seed('warehouses/W2',{active:true});
  await seed('warehouseStocks/W2__init-product',{productKey:'init-product',warehouseId:'W2',onHand:5,reserved:0,incoming:0});
  f.context.warehouseMasterCache.push({id:'W2'});
  await assertSucceeds(f.run());await assertSucceeds(f.run());
  const admin=db('admin'),order=(await getDoc(doc(admin,'orders/'+f.id))).data();
  assert.equal(order.items[0].warehouseId,'W2');assert.equal(order.items[0].reservedQty,5);
  assert.equal((await getDoc(doc(admin,'warehouseStocks/W1__init-product'))).data().reserved,0);
  assert.equal((await getDoc(doc(admin,'warehouseStocks/W2__init-product'))).data().reserved,5);
  assert.equal((await getDoc(doc(admin,'inventory/init-product'))).data().reserved,5);
  assert.equal((await getDoc(doc(admin,'inventoryReservations/'+f.id+'__I'))).data().warehouseId,'W2');
  assert.equal((await getDoc(doc(admin,'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).exists(),false);
 }
});
test('actual initialization refuses a locked custody master before any stock or demand publication',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{ownerUid:role==='purchaser'?'sales1':uid});
  await seed('warehouses/W1',{active:true,warehouseType:'CUSTODY'});
  const admin=db('admin'),orderRef=doc(admin,'orders/'+f.id),before=(await getDoc(orderRef)).data();
  await seed('orders/'+f.id,{...before,items:[{...before.items[0],supplyOrderedQty:1}]});
  await assert.rejects(f.run(),/啟用的庫存倉庫/);
  assert.equal((await getDoc(doc(admin,'inventory/init-product'))).data().reserved,0);
  assert.equal((await getDoc(doc(admin,'warehouseStocks/W1__init-product'))).data().reserved,0);
  assert.equal((await getDoc(doc(admin,'inventoryReservations/'+f.id+'__I'))).exists(),false);
  assert.equal((await getDoc(doc(admin,'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).exists(),false);
 }
});

test('actual reservation sync refuses insufficient company and warehouse balances for authorized roles',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer'],['buyer1','purchaser'],['admin','admin']]){
  const f=await orderInitializationFixture(uid,role,{ownerUid:role==='purchaser'?'sales1':uid});
  await assertSucceeds(f.run());
  const orderRef=doc(db('admin'),'orders/'+f.id),saved=(await getDoc(orderRef)).data();
  await seed('orders/'+f.id,{...saved,items:saved.items.map(item=>({...item,qty:1,orderedQty:1}))});
  for(const path of ['inventory/init-product','warehouseStocks/W1__init-product']){
   const original=(await getDoc(doc(db('admin'),path))).data();
   await seed(path,{...original,reserved:2});
   const paths=['orders/'+f.id,'inventory/init-product','warehouseStocks/W1__init-product',
    'inventoryReservations/'+f.id+'__I','procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')];
   const before=await Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));
   await assert.rejects(f.run(),/不足|核對/);
   const after=await Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));
   assert.deepEqual(after,before,uid+' must not erase the ledger discrepancy');
   await seed(path,original);
  }
 }
});

async function actualShipmentFixture(uid,role){
 const f=await orderInitializationFixture(uid,role,{onHand:5,ownerUid:['purchaser','warehouse'].includes(role)?'sales1':uid});
 // Shipment is tested from an already initialized order. Warehouse users do
 // not own order initialization; that separate service has its own role tests.
 const saved=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 await seed('orders/'+f.id,{...saved,inventoryReservationStatus:'completed',items:saved.items.map(i=>require('../modules/fulfillment-core').normalizeItem({...i,reservedQty:5,dispatchPreparedQty:5})),deliveryRecords:[]});
 await seed('inventory/init-product',{productKey:'init-product',onHand:5,reserved:5,incoming:0});
 await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:5,reserved:5,incoming:0});
 await seed('inventoryReservations/'+f.id+'__I',{orderId:f.id,itemId:'I',orderItemIndex:0,ownerUid:saved.ownerUid,salesCode:saved.salesCode,productKey:'init-product',warehouseId:'W1',quantity:5,shortageQty:0,status:'active'});
 await seed('inventoryLots/issue-'+uid,{productKey:'init-product',productId:'init-product',warehouseId:'W1',remainingQty:5,qty:5,sourceType:'INITIAL_STOCK',sourceId:'issue-'+uid});
 const rawClient=compatDb(uid),plain=x=>JSON.parse(JSON.stringify(x));
 // Keep document references and transactions on one SDK instance.
 f.client.collection=rawClient.collection;
 const clean=data=>{const result=plain(data);if(result.deliveryHistory?.__arrayUnion)result.deliveryHistory=arrayUnion(...result.deliveryHistory.__arrayUnion);return result;};
 f.client.runTransaction=callback=>rawClient.runTransaction(tx=>callback({...tx,
  set:(r,data,o)=>o?tx.set(r,clean(data),o):tx.set(r,clean(data)),update:(r,data)=>tx.update(r,clean(data))}));
 Object.assign(f.context,{YushinInventory:require('../modules/inventory-core'),
  canReceiveInventoryCapability:()=>['admin','purchaser','warehouse'].includes(role),canAccessPage:()=>true,
  warehouseMasterCache:[{id:'W1',active:true}],savedDeliveryRecords:o=>o.deliveryRecords||[],
  savedReturnRecords:o=>o.returnRecords||[],deliveryActor:()=>uid,orderQuantity:o=>o.items.reduce((sum,i)=>sum+i.qty,0),
  orderInventorySyncIncomplete:o=>o.inventoryReservationStatus!=='completed',
  orderDeliveryProjection:o=>require('../modules/fulfillment-core').projectOrderDelivery({grossDeliveredQty:(o.deliveryRecords||[]).reduce((sum,r)=>sum+r.qty,0),returnedQty:0,returnRecords:[]}),
  firebase:{firestore:{FieldValue:{arrayUnion:entry=>({__arrayUnion:[entry]})}}}});
 const app=fs.readFileSync('app.js','utf8');
 vm.runInContext(app.slice(app.indexOf('function inventoryReservationPayload('),app.indexOf('window.openInventoryReservationDetails =')),f.context);
 vm.runInContext(fs.readFileSync('src/services/delivery-stock.js','utf8'),f.context);
 vm.runInContext(fs.readFileSync('src/services/delivery-records.js','utf8'),f.context);
 vm.runInContext(fs.readFileSync('src/services/warehouse-shipment.js','utf8'),f.context);
 f.ship=(qty,operationId)=>f.context.commitInventoryShipment({orderId:f.id,itemId:'I',qty,date:'2026-10-17',operationId,expectedWarehouseId:'W1'});
 return f;
}
test('actual shared issue planner commits partial warehouse shipment and repeat safely under real Rules',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await actualShipmentFixture(uid,role);
  await assertSucceeds(f.ship(2,'partial-'+uid));await assertSucceeds(f.ship(2,'partial-'+uid));
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().onHand,3);
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,3);
  await assertSucceeds(f.ship(3,'remaining-'+uid));
  const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  assert.equal(order.deliveryRecords.length,2);assert.equal(order.deliveredQty,5);assert.equal(order.isDelivered,true);
  for(const path of ['inventory/init-product','warehouseStocks/W1__init-product']){
   const stock=(await getDoc(doc(db('admin'),path))).data();assert.equal(stock.onHand,0);assert.equal(stock.reserved,0);
  }
  assert.equal((await getDoc(doc(db('admin'),'inventoryLots/issue-'+uid))).data().remainingQty,0);
 }
});
test('actual shared issue planner refuses inconsistent company balances without committing order stock lots or ledger',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await actualShipmentFixture(uid,role);
  await seed('inventory/init-product',{productKey:'init-product',onHand:3,reserved:5,incoming:0});
  const paths=['orders/'+f.id,'inventory/init-product','warehouseStocks/W1__init-product','inventoryReservations/'+f.id+'__I','inventoryLots/issue-'+uid];
  const read=()=>Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));
  const before=await read();await assert.rejects(f.ship(2,'invalid-'+uid),/不足|異常|核對/);
  assert.deepEqual(await read(),before);
 }
});
test('commercial roles cannot use the warehouse issue service to bypass dispatch permissions',async()=>{
 for(const [uid,role] of [['sales1','sales'],['eng1','engineer']]){
  const f=await actualShipmentFixture(uid,role);await assert.rejects(f.ship(2,'blocked-'+uid),/無倉庫出貨權限/);
  assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().onHand,5);
 }
});

test('actual original-lot restoration keeps delivery reversal return and return correction aligned atomically',async()=>{
 const f=await actualShipmentFixture('admin','admin');
 f.context.DOCUMENT_TYPES={ORDER:'order'};
 await f.ship(2,'restore-source');
 await f.context.runRoleTransaction(async tx=>{
  const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref),order=snap.data();
  const item={...order,...order.items[0]};
  const result=await f.context.applyInventoryDeliveryDeltaInTransaction(tx,item,-2,'admin',f.id,order.deliveryRecords);
  tx.update(ref,{items:[{...order.items[0],reservedQty:result.newReservedQty}],deliveryRecords:[],deliveredQty:0,isDelivered:false});
 });
 assert.equal((await getDoc(doc(db('admin'),'inventoryLots/issue-admin'))).data().remainingQty,5);
 assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().onHand,5);
 await f.ship(2,'return-source');
 let previous;
 await f.context.runRoleTransaction(async tx=>{
  const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref),order=snap.data();
  const result=await f.context.applyInventoryReturnDeltaInTransaction(tx,{...order,...order.items[0],customerReturnSettlement:'CLOSE'},1,'admin',f.id,null);
  previous={id:'R',qty:1,lotAllocations:result.lotAllocations};
  tx.update(ref,{returnRecords:[previous],returnedQty:1});
 });
 assert.equal((await getDoc(doc(db('admin'),'inventoryLots/issue-admin'))).data().remainingQty,4);
 assert.equal((await getDoc(doc(db('admin'),'inventory/init-product'))).data().reserved,3);
 await f.context.runRoleTransaction(async tx=>{
  const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref),order=snap.data();
  await f.context.applyInventoryReturnDeltaInTransaction(tx,{...order,...order.items[0],customerReturnSettlement:'CLOSE'},-1,'admin',f.id,previous);
  tx.update(ref,{returnRecords:[],returnedQty:0});
 });
 for(const path of ['inventory/init-product','warehouseStocks/W1__init-product']){
  const stock=(await getDoc(doc(db('admin'),path))).data();assert.equal(stock.onHand,3);assert.equal(stock.reserved,3);
 }
 assert.equal((await getDoc(doc(db('admin'),'inventoryLots/issue-admin'))).data().remainingQty,3);
});
test('actual protected reversal and return stop on a foreign batch before queuing stock changes for receiver roles',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await actualShipmentFixture(uid,role);f.context.DOCUMENT_TYPES={ORDER:'order'};
  await f.ship(2,'foreign-source-'+uid);
  const lotPath='inventoryLots/issue-'+uid,lot=(await getDoc(doc(db('admin'),lotPath))).data();
  await seed(lotPath,{...lot,warehouseId:'OTHER'});
  const paths=['orders/'+f.id,lotPath,'inventory/init-product','warehouseStocks/W1__init-product','inventoryReservations/'+f.id+'__I'];
  const read=()=>Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));
  const before=await read();
  for(const kind of ['reversal','return']){
   await assert.rejects(f.context.runRoleTransaction(async tx=>{
    const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref),order=snap.data(),item={...order,...order.items[0]};
    if(kind==='reversal')await f.context.applyInventoryDeliveryDeltaInTransaction(tx,item,-1,uid,f.id,order.deliveryRecords);
    else await f.context.applyInventoryReturnDeltaInTransaction(tx,item,1,uid,f.id,null);
   }),/原出貨批次.*倉庫不一致/);
   assert.deepEqual(await read(),before);
  }
 }
});

test('actual replacement return and correction keep company warehouse and own reservation aligned',async()=>{
 const f=await actualShipmentFixture('admin','admin');f.context.DOCUMENT_TYPES={ORDER:'order'};
 await f.ship(2,'replacement-source');let previous;
 for(const delta of [1,-1]){
  await f.context.runRoleTransaction(async tx=>{
   const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref),order=snap.data(),item={...order,...order.items[0]};
   const result=await f.context.applyInventoryReturnDeltaInTransaction(tx,item,delta,'admin',f.id,delta<0?previous:null);
   if(delta>0)previous={id:'REPLACE',qty:1,lotAllocations:result.lotAllocations};
   tx.update(ref,{items:[{...order.items[0],reservedQty:result.newReservedQty}],returnRecords:delta>0?[previous]:[],returnedQty:delta>0?1:0});
  });
  const expected=delta>0?4:3;
  for(const path of ['inventory/init-product','warehouseStocks/W1__init-product']){
   const stock=(await getDoc(doc(db('admin'),path))).data();assert.equal(stock.onHand,expected);assert.equal(stock.reserved,expected);
  }
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,expected);
  assert.equal((await getDoc(doc(db('admin'),'inventoryLots/issue-admin'))).data().remainingQty,expected);
 }
});
test('actual cancellation followed by return or delivery reversal never recreates a stock reservation',async()=>{
 for(const kind of ['return','reversal']){
  const f=await actualShipmentFixture('admin','admin');f.context.DOCUMENT_TYPES={ORDER:'order'};
  await f.ship(2,'cancel-source-'+kind);await loadActualLifecycle(f)('cancelled');
  await f.context.runRoleTransaction(async tx=>{
   const ref=f.client.collection('orders').doc(f.id),snap=await tx.get(ref),order=snap.data(),item={...order,...order.items[0]};
   if(kind==='return'){
    const result=await f.context.applyInventoryReturnDeltaInTransaction(tx,item,1,'admin',f.id,null);
    tx.update(ref,{returnRecords:[{id:'CANCEL-R',qty:1,lotAllocations:result.lotAllocations}],returnedQty:1});
   }else{
    const result=await f.context.applyInventoryDeliveryDeltaInTransaction(tx,item,-2,'admin',f.id,order.deliveryRecords);
    tx.update(ref,{items:[{...order.items[0],reservedQty:result.newReservedQty}],deliveryRecords:[],deliveredQty:0,isDelivered:false});
   }
  });
  for(const path of ['inventory/init-product','warehouseStocks/W1__init-product']){
   const stock=(await getDoc(doc(db('admin'),path))).data();assert.equal(stock.onHand,kind==='return'?4:5);assert.equal(stock.reserved,0);
  }
  const held=(await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data();assert.equal(held.quantity,0);assert.equal(held.status,'released');
 }
});
test('actual return accounting refuses insufficient reservation accounts before any lot restoration for receiver roles',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await actualShipmentFixture(uid,role);f.context.DOCUMENT_TYPES={ORDER:'order'};await f.ship(2,'raw-account-'+uid);
  await seed('inventory/init-product',{productKey:'init-product',onHand:3,reserved:2,incoming:0});
  const paths=['orders/'+f.id,'inventory/init-product','warehouseStocks/W1__init-product','inventoryLots/issue-'+uid,'inventoryReservations/'+f.id+'__I'];
  const read=()=>Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));const before=await read();
  for(const kind of ['return','reversal']){
   await assert.rejects(f.context.runRoleTransaction(async tx=>{
    const snap=await tx.get(f.client.collection('orders').doc(f.id)),order=snap.data(),item={...order,...order.items[0]};
    if(kind==='return')await f.context.applyInventoryReturnDeltaInTransaction(tx,item,1,uid,f.id,null);
    else await f.context.applyInventoryDeliveryDeltaInTransaction(tx,item,-1,uid,f.id,order.deliveryRecords);
   }),/預留量不足/);
   assert.deepEqual(await read(),before);
  }
 }
});

async function singleReceivingLocationFixture(uid,role){
 const f=await orderInitializationFixture(uid,role,{qty:3,onHand:0,ownerUid:'sales1'}),fulfillment=require('../modules/fulfillment-core');
 const original=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
 await seed('orders/'+f.id,{...original,inventoryReservationStatus:'completed',items:original.items.map(i=>fulfillment.normalizeItem(i))});
 await seed('inventory/init-product',{productKey:'init-product',onHand:9,reserved:4,incoming:0});
 await seed('warehouseStocks/W1__init-product',{productKey:'init-product',warehouseId:'W1',onHand:3,reserved:0,incoming:0});
 await seed('warehouseStocks/OTHER__init-product',{productKey:'init-product',warehouseId:'OTHER',onHand:6,reserved:4,incoming:0});
 await seed('inventoryReservations/'+f.id+'__I',{orderId:f.id,itemId:'I',orderItemIndex:0,ownerUid:'sales1',salesCode:'S01',productKey:'init-product',warehouseId:'W1',quantity:0,shortageQty:3,status:'shortage'});
 await seed('inventoryReservations/REMOTE__I',{orderId:'REMOTE',itemId:'I',ownerUid:'sales1',salesCode:'S01',productKey:'init-product',warehouseId:'OTHER',quantity:4,shortageQty:0,status:'active'});
 await seed('receipts/location-'+uid,{productKey:'init-product',warehouseId:'W1',autoAllocationQty:3,autoAllocatedQty:0,allocationCompleted:false});
 Object.assign(f.context,{firestoreReadWithTimeout:p=>p,itemDispatchState:(_o,item)=>fulfillment.dispatchState(item),orderInventorySyncIncomplete:o=>o.inventoryReservationStatus!=='completed'});
 vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),f.context);
 f.allocate=()=>f.context.allocateFreeReceiptStockToShortages('init-product','W1',3,uid,'','location-'+uid);
 return f;
}
test('actual receipt allocation uses only the receiving warehouse and preserves another warehouse holds on repeat',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await singleReceivingLocationFixture(uid,role);
  const paths=['warehouseStocks/OTHER__init-product','inventoryReservations/REMOTE__I'];
  const read=()=>Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));const before=await read();
  await assertSucceeds(f.allocate());await assertSucceeds(f.allocate());assert.deepEqual(await read(),before);
  const company=(await getDoc(doc(db('admin'),'inventory/init-product'))).data();assert.equal(company.onHand,9);assert.equal(company.reserved,7);
  const local=(await getDoc(doc(db('admin'),'warehouseStocks/W1__init-product'))).data();assert.equal(local.onHand,3);assert.equal(local.reserved,3);
  assert.equal((await getDoc(doc(db('admin'),'inventoryReservations/'+f.id+'__I'))).data().quantity,3);
  assert.equal((await getDoc(doc(db('admin'),'receipts/location-'+uid))).data().autoAllocatedQty,3);
 }
});
test('actual receiving-location allocation refuses corrupt transit before updating any stock checkpoint or demand',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await singleReceivingLocationFixture(uid,role);
  await seed('inventory/init-product',{productKey:'init-product',onHand:9,reserved:4,incoming:0,transferFreeInTransit:-1});
  const paths=['orders/'+f.id,'inventory/init-product','warehouseStocks/W1__init-product','inventoryReservations/'+f.id+'__I','receipts/location-'+uid];
  const read=()=>Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));const before=await read();
  await assert.rejects(f.allocate(),/預留數量不正確/);assert.deepEqual(await read(),before);
  assert.equal((await getDoc(doc(db('admin'),'procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')))).exists(),false);
 }
});

for(const status of ['cancelled','normal'])test('actual '+status+' refuses impossible transit balances atomically and permits corrected retries for admin sales and engineer',async()=>{
 for(const [uid,role] of [['admin','admin'],['sales1','sales'],['eng1','engineer']]){
  const checked=async(phase,fn)=>{try{return await fn();}catch(error){throw new Error(uid+' '+status+' '+phase+': '+error.message,{cause:error});}};
  const f=await orderInitializationFixture(uid,role);await checked('initialize',()=>f.run());
  const order=(await getDoc(doc(db('admin'),'orders/'+f.id))).data();
  await seed('orders/'+f.id,{...order,inventoryReservationStatus:'completed'});
  const run=loadActualLifecycle(f);
  if(status==='normal')await checked('initial cancellation',()=>assertSucceeds(run('cancelled')));
  const reserved=status==='normal'?0:3;
  const company={productKey:'init-product',onHand:3,reserved,incoming:0,transferFreeInTransit:0};
  const warehouse={...company,warehouseId:'W1'};
  const paths=['orders/'+f.id,'inventory/init-product','warehouseStocks/W1__init-product',
   'inventoryReservations/'+f.id+'__I','procurementDemands/'+encodeURIComponent('SALES_ORDER:'+f.id+':I')];
  const snapshots=()=>Promise.all(paths.map(async path=>(await getDoc(doc(db('admin'),path))).data()));
  for(const target of ['company','warehouse']){
   await seed(paths[1],{...company,transferFreeInTransit:target==='company'?4:0});
   await seed(paths[2],{...warehouse,transferFreeInTransit:target==='warehouse'?4:0});
   const before=await snapshots();
   await assert.rejects(run(status),/調撥途中量超過實貨/);
   assert.deepEqual(await snapshots(),before);
  }
  await seed(paths[1],company);await seed(paths[2],warehouse);
  await checked('corrected retry',()=>assertSucceeds(run(status)));
  assert.equal((await getDoc(doc(db('admin'),paths[3]))).data().quantity,status==='normal'?3:0);
  await checked('repeated retry',()=>assertSucceeds(run(status)));
  assert.equal((await getDoc(doc(db('admin'),paths[1]))).data().reserved,status==='normal'?3:0);
 }
});

async function crossWarehouseEvidenceFixture(uid,role,count=2,{mutate=null}={}){
 const id='cross-'+uid,productKey=id,ownerUid=role==='engineer'?'eng1':'sales1',salesCode=role==='engineer'?'E01':'S01';
 const items=Array.from({length:count},(_,i)=>({itemId:'I'+i,productId:productKey,qty:5,warehouseId:i%2?'B':'A'}));
 await seed('orders/'+id,{ownerUid,salesCode,status:'active',inventoryReservationStatus:'completed',items});
 await seed('inventory/'+productKey,{productKey,onHand:40,reserved:0,incoming:0});
 for(const warehouseId of ['A','B'])await seed('warehouseStocks/'+warehouseId+'__'+productKey,{productKey,warehouseId,onHand:20,reserved:0,incoming:0});
 const client=compatDb(uid),native=client.runTransaction;
 if(mutate)client.runTransaction=fn=>native(tx=>fn({...tx,
  set:(ref,data,options)=>{const next=mutate(ref.path,data);if(next===null)return;if(options)tx.set(ref,next,options);else tx.set(ref,next);},
  update:(ref,data)=>{const next=mutate(ref.path,data);if(next!==null)tx.update(ref,next);}}));
 let attempt=0;
 const run=(quantities,{movementAttempt=null}={})=>stockPermissions.run(client,async tx=>{
  const inv=client.collection('inventory').doc(productKey),stocks={},old=[];
  await tx.get(inv);
  for(const warehouseId of ['A','B']){
   stocks[warehouseId]=client.collection('warehouseStocks').doc(warehouseId+'__'+productKey);await tx.get(stocks[warehouseId]);
  }
  for(const item of items)old.push((await tx.get(client.collection('inventoryReservations').doc(id+'__'+item.itemId))).data()?.quantity||0);
  tx.update(inv,{reserved:quantities.reduce((a,b)=>a+b,0)});
  for(const warehouseId of ['A','B'])tx.update(stocks[warehouseId],{reserved:items.reduce((sum,item,i)=>sum+(item.warehouseId===warehouseId?quantities[i]:0),0)});
  items.forEach((item,i)=>tx.set(client.collection('inventoryReservations').doc(id+'__'+item.itemId),{
   orderId:id,itemId:item.itemId,productKey,warehouseId:item.warehouseId,quantity:quantities[i],shortageQty:5-quantities[i]},{merge:true}));
  const movementId=movementAttempt||++attempt;
  for(const warehouseId of ['A','B'])tx.set(client.collection('inventoryMovements').doc(id+'-'+movementId+'-'+warehouseId),{
   productKey,warehouseId,sourceType:'order',sourceId:id,ownerUid,salesCode,type:'reserve',
   qty:items.reduce((sum,item,i)=>sum+(item.warehouseId===warehouseId?quantities[i]-old[i]:0),0)});
 },uid,['sales','engineer'].includes(role),role);
 const paths=['inventory/'+productKey,...['A','B'].map(w=>'warehouseStocks/'+w+'__'+productKey),
  ...items.map(i=>'inventoryReservations/'+id+'__'+i.itemId)];
 const snapshot=()=>Promise.all(paths.map(async p=>{const s=await getDoc(doc(db('admin'),p));return s.exists()?s.data():null;}));
 return {id,productKey,items,run,snapshot};
}
test('actual cross-warehouse wrapper retains authorized five-role access with one company and separate warehouse totals',async()=>{
 for(const [uid,role] of [['admin','admin'],['buyer1','purchaser'],['wh1','warehouse'],['sales1','sales'],['eng1','engineer']]){
  const f=await crossWarehouseEvidenceFixture(uid,role);await assertSucceeds(f.run([2,3]));
  const [company,a,b,...reservations]=await f.snapshot();
  assert.equal(company.reserved,5);assert.equal(a.reserved,2);assert.equal(b.reserved,3);
  assert.equal(company.onHand,40);assert.equal(a.onHand,20);
  if(['purchaser','warehouse'].includes(role))for(const r of reservations){
   assert.equal(r.stockEvidence.crossWarehouse,true);
   const representative=(await getDoc(doc(db('admin'),'inventoryReservations/'+r.stockEvidence.reservationIds[0]))).data();
   assert.equal(representative.warehouseId,r.warehouseId);
  }
 }
});
test('five operational reservations across two warehouses stay within Rules evaluation and document access limits',async()=>{
 for(const [uid,role] of [['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await crossWarehouseEvidenceFixture(uid,role,5);await assertSucceeds(f.run([1,2,1,2,1]));
  const [company,a,b]=await f.snapshot();assert.equal(company.reserved,7);assert.equal(a.reserved,3);assert.equal(b.reserved,4);
 }
});
test('operational warehouse-specific proofs permit partial release and a zero-company exchange but reject movement reuse',async()=>{
 for(const [uid,role] of [['buyer1','purchaser'],['wh1','warehouse']]){
  const f=await crossWarehouseEvidenceFixture(uid,role);await assertSucceeds(f.run([2,3]));
  const before=await f.snapshot();await assertFails(f.run([1,4],{movementAttempt:1}));assert.deepEqual(await f.snapshot(),before);
  for(const quantities of [[1,2],[2,1],[0,0]]){
   await assertSucceeds(f.run(quantities));const [company,a,b]=await f.snapshot();
   assert.equal(company.reserved,quantities[0]+quantities[1]);assert.equal(a.reserved,quantities[0]);assert.equal(b.reserved,quantities[1]);
  }
 }
});
test('native corruption of company warehouse or proof metadata cannot bypass cross-warehouse reservation evidence',async()=>{
 const mutations=[
  (path,data)=>path.startsWith('inventory/')?{...data,reserved:data.reserved+1}:data,
  (path,data)=>path.startsWith('warehouseStocks/A__')?{...data,reserved:data.reserved+1}:data,
  (path,data)=>path.startsWith('warehouseStocks/B__')?null:data,
  (path,data)=>path.startsWith('inventoryMovements/')&&path.endsWith('-B')?null:data,
  (path,data)=>{const key=data.stockEvidence?'stockEvidence':data.reservationStockEvidence?'reservationStockEvidence':'';return key?{...data,[key]:{...data[key],crossWarehouse:'true'}}:data;},
  (path,data)=>{const key=data.stockEvidence?'stockEvidence':data.reservationStockEvidence?'reservationStockEvidence':'';return key?{...data,[key]:{...data[key],crossWarehouse:false}}:data;}
 ];
 for(const [uid,role] of [['buyer1','purchaser'],['wh1','warehouse']])for(const mutate of mutations){
  const f=await crossWarehouseEvidenceFixture(uid,role,2,{mutate}),before=await f.snapshot();
  await assertFails(f.run([2,3]));assert.deepEqual(await f.snapshot(),before);
  assert.equal((await getDoc(doc(db('admin'),'inventoryMovements/'+f.id+'-1-A'))).exists(),false);
 }
});
test('native grouped proofs cannot conceal a nonrepresentative reservation move from an unproved third warehouse',async()=>{
 await seed('orders/hidden-move',{ownerUid:'sales1',salesCode:'S01',items:[
  {itemId:'I0',productId:'P',qty:5,warehouseId:'A'},{itemId:'I1',productId:'P',qty:5,warehouseId:'A'},{itemId:'I2',productId:'P',qty:5,warehouseId:'B'}]});
 await seed('inventory/P',{productKey:'P',onHand:20,reserved:3,incoming:0});
 for(const [warehouseId,reserved] of [['A',1],['B',0],['C',2]])await seed('warehouseStocks/'+warehouseId+'__P',{productKey:'P',warehouseId,onHand:10,reserved,incoming:0});
 for(const [i,warehouseId,quantity] of [[0,'A',1],[1,'C',2],[2,'B',0]])await seed('inventoryReservations/hidden-move__I'+i,{
  orderId:'hidden-move',itemId:'I'+i,orderItemIndex:i,productKey:'P',warehouseId,quantity,ownerUid:'sales1',salesCode:'S01',shortageQty:5-quantity});
 for(const uid of ['buyer1','wh1']){
  const client=db(uid),b=writeBatch(client),evidence={};
  for(const warehouseId of ['A','B']){
   const ids=warehouseId==='A'?[0,1,2]:[2,0,1];
   evidence[warehouseId]={inventoryId:'P',warehouseStockId:warehouseId+'__P',previousWarehouseStockId:warehouseId+'__P',movementId:'hidden-'+warehouseId,
    reservationIds:ids.map(i=>'hidden-move__I'+i),crossWarehouse:true};
   b.update(doc(client,'warehouseStocks/'+warehouseId+'__P'),{reserved:warehouseId==='A'?2:1});
   b.set(doc(client,'inventoryMovements/hidden-'+warehouseId),{productKey:'P',warehouseId,sourceId:'hidden-move',type:'reserve',qty:1,reservationStockEvidence:evidence[warehouseId]});
  }
  for(let i=0;i<3;i++)b.update(doc(client,'inventoryReservations/hidden-move__I'+i),{warehouseId:i===2?'B':'A',quantity:1,stockEvidence:evidence[i===2?'B':'A']});
  await assertFails(b.commit());
  assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/C__P'))).data().reserved,2);
  assert.equal((await getDoc(doc(db('admin'),'warehouseStocks/A__P'))).data().reserved,1);
 }
});
