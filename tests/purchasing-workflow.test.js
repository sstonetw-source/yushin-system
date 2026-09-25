const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const validation = app.match(/function assertPurchaseLinesAvailable\(order, lines\) \{[\s\S]*?\n\}\n(?=\nfunction printSavedPoDocument)/)?.[0];
assert.ok(validation, 'The PO transaction must validate the live source order');
const validate = vm.runInNewContext(`${validation}\nassertPurchaseLinesAvailable`, {
    normalizedOrderStatus: order => order.status === 'cancelled' ? 'cancelled' : 'normal',
    normalizedOrderItems: order => order.items
});

test('purchasing has three item-level work queues and no legacy number function', () => {
    for (const view of ['ordering', 'receiving', 'dispatch']) {
        assert.match(html, new RegExp(`id="purchase-card-${view}"`));
    }
    assert.match(html, /id="purchaseCountOrdering"/);
    assert.match(html, /id="purchaseCountReceiving"/);
    assert.match(html, /id="purchaseCountDispatch"/);
    assert.match(app, /switchPurchasingView\(canCreatePurchaseOrderCapability\(\) \? 'ordering' : 'receiving'\)/);
    assert.match(app, /loadPendingPurchaseOrders\(true\)/);
    assert.match(app, /loadMyPurchaseOrders\(\)/);
    assert.match(app, /loadPurchasingDispatchOrders\(true\)/);
    assert.doesNotMatch(app, /generateNextPoNumber/);
});

test('a PO cannot exceed the remaining need even when lines split the same item', () => {
    const order = { items:[{ itemCode:'A', qty:8, purchaseRequiredQty:5, purchaseOrderedQty:2 }] };
    validate(order, [{orderItemIndex:0,itemCode:'A',qty:2},{orderItemIndex:0,itemCode:'A',qty:1}]);
    assert.throws(() => validate(order, [{orderItemIndex:0,itemCode:'A',qty:2},{orderItemIndex:0,itemCode:'A',qty:2}]), /待採購數量/);
    assert.throws(() => validate({...order,status:'cancelled'}, [{orderItemIndex:0,itemCode:'A',qty:1}]), /取消/);
    assert.throws(() => validate(order, [{orderItemIndex:0,itemCode:'B',qty:1}]), /品項已變更/);
});

test('a self order reduces the quantity available to the formal PO', () => {
    const order = { items:[{ itemCode:'A', qty:8, purchaseRequiredQty:5, supplyOrderedQty:4 }] };
    validate(order, [{orderItemIndex:0,itemCode:'A',qty:1}]);
    assert.throws(() => validate(order, [{orderItemIndex:0,itemCode:'A',qty:2}]), /待採購數量/);
});

test('repeating an incoming-stock update does not count the same PO twice', async () => {
    const source = app.match(/async function registerPurchaseIncoming\(poId, poRecord, previousPo = null\) \{[\s\S]*?\n\}\n(?=\nlet poReceiptTargetId)/)?.[0];
    assert.ok(source);
    const docs = new Map();
    const records = [];
    let failSecondItemOnce = true;
    const collection = name => ({ doc: id => ({ key:`${name}/${id}` }) });
    const db = {
        collection,
        runTransaction: async callback => callback({
            get: async ref => {
                if (ref.key === 'inventory/P2' && failSecondItemOnce) { failSecondItemOnce = false; throw new Error('網路中斷'); }
                return { exists:docs.has(ref.key), data:() => docs.get(ref.key) };
            },
            set: (ref, data, options) => {
                if (ref.key.startsWith('inventoryMovements/')) records.push(data);
                else docs.set(ref.key, options?.merge ? {...docs.get(ref.key),...data} : data);
            }
        })
    };
    let sequence = 0;
    db.collection = name => ({ doc: id => ({key:`${name}/${id ?? ++sequence}`}) });
    const register = vm.runInNewContext(`${source}\nregisterPurchaseIncoming`, {
        db,
        purchaseItemsFromSavedPo: po => po.items,
        poIncomingKey: item => item.productId,
        defaultWarehouse: () => ({id:'W1'}),
        warehouseStockDocId: (warehouse, key) => `${warehouse}__${key}`,
        inventoryNumbers: data => ({onHand:Number(data.onHand||0),reserved:Number(data.reserved||0),incoming:Number(data.incoming||0)}),
        resolveBrandName: name => name,
        currentUserName:'採購',currentUser:null,
        DOCUMENT_TYPES:{PURCHASE_ORDER:'PURCHASE_ORDER'},
        firebase:{firestore:{FieldValue:{arrayUnion:(...values) => values}}}
    });
    const po = {vendorName:'供應商',items:[
        {productId:'P1',warehouseId:'W1',qty:3,itemCode:'A',itemName:'產品',brand:'品牌'},
        {productId:'P2',warehouseId:'W1',qty:2,itemCode:'B',itemName:'產品二',brand:'品牌'}
    ]};
    await assert.rejects(register('PO1',po), /網路中斷/);
    await register('PO1',po);
    await register('PO1',po);
    assert.equal(docs.get('inventory/P1').incoming,3);
    assert.equal(docs.get('inventory/P2').incoming,2);
    assert.equal(docs.get('warehouseStocks/W1__P1').incoming,3);
    assert.equal(docs.get('pendingInventoryItems/W1__P1').incomingQty,3);
    assert.equal(records.length,2);
});


test('order work cards and filters use item-level work states', () => {
    assert.match(app, /function orderItemWorkCategory\(order, item\)/);
    assert.match(app, /function orderWorkCategories\(order\)/);
    assert.match(app, /normalizedOrderItems\(order\)\.forEach\(item => \{/);
    assert.match(app, /metrics\[category\]\.count\+\+/);
    assert.match(app, /categories\.includes\(activeOrderWorkFilter\)/);
    assert.match(app, /shown\.map\(category=>map\[category\]\?\.label\)/);
    assert.match(app, /const itemStatus=orderItemWorkCategory\(o,item\)/);
    assert.match(app, /訂單狀態：<span class="order-progress-badge">/);
    assert.match(app, /<span class="order-progress-badge">品項狀態<\/span>/);
    assert.match(app, /if\(required>ordered\)return 'ordering';[\s\S]*if\(required>0\)return 'arrival';[\s\S]*if\(dispatch\.reserved>dispatch\.delivered\|\|dispatch\.prepared>dispatch\.delivered\)return 'delivery';/);
});
