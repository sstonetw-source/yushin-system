const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const workflow = require('../modules/workflow-core.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const validation = app.match(/function assertPurchaseLinesAvailable\(order, lines\) \{[\s\S]*?\n\}\n(?=\nfunction printSavedPoDocument)/)?.[0];
assert.ok(validation, 'The PO transaction must validate the live source order');
const validate = vm.runInNewContext(`${validation}\nassertPurchaseLinesAvailable`, {
    normalizedOrderStatus: order => order.status === 'cancelled' ? 'cancelled' : 'normal',
    normalizedOrderItems: order => order.items
});

test('purchasing user-facing copy avoids legacy stock-order and source-order wording', () => {
    assert.doesNotMatch(html, /來源訂單日期/);
    assert.doesNotMatch(app, /原廠備貨是公司庫存採購/);
    assert.match(html, /全部採購單則依正式訂購日期查詢/);
});

test('purchasing has three item-level work queues and no legacy number function', () => {
    for (const view of ['ordering', 'receiving', 'dispatch']) {
        assert.match(html, new RegExp(`id="purchase-card-${view}"`));
    }
    assert.match(html, /id="purchaseCountOrdering"/);
    assert.match(html, /id="purchaseCountReceiving"/);
    assert.match(html, /id="purchaseCountDispatch"/);
    assert.match(html, /id="purchaseAmountOrdering"/);
    assert.match(html, /id="purchaseAmountReceiving"/);
    assert.match(html, /id="purchaseAmountDispatch"/);
    assert.match(app, /switchPurchasingView\(canCreatePurchaseOrderCapability\(\) \? 'ordering' : 'receiving'\)/);
    assert.match(app, /function refreshPurchasingOrderCache\(reset = true\)/);
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
    db.collection = name => ({ doc: id => {
        const key = `${name}/${id ?? ++sequence}`;
        return {key, set:async data => { docs.set(key, {...docs.get(key), ...data}); }};
    }});
    const register = vm.runInNewContext(`${source}\nregisterPurchaseIncoming`, {
        db,
        purchaseItemsFromSavedPo: po => po.items,
        poIncomingKey: item => item.productId,
        defaultWarehouse: () => ({id:'W1'}),
        warehouseStockDocId: (warehouse, key) => `${warehouse}__${key}`,
        inventoryNumbers: data => ({onHand:Number(data.onHand||0),reserved:Number(data.reserved||0),incoming:Number(data.incoming||0)}),
        invalidateWarehouseStockCache: () => {},
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
    assert.equal(docs.get('purchaseOrders/PO1').incomingRegistrationStatus,'completed');
    assert.equal(records.length,2);
});

test('saved PO prints on a separate tap; pending inventory sync retries once', async () => {
    const start = app.indexOf('window.printPurchaseOrder = async function()');
    const end = app.indexOf('    if (poItems.length === 0)', start);
    assert.ok(start >= 0 && end > start);
    const button = { disabled:false, innerText:'🖨️ 列印／輸出 PDF' };
    const savedPo = { id:'PO1', poNo:'PO1', vendorName:'供應商', incomingRegistrationVersion:1 };
    let releaseRegistration;
    let registrationCalls = 0;
    let printCalls = 0;
    const alerts = [];
    const context = vm.createContext({
        window:{}, poEditingId:'PO1', poListCache:[savedPo],
        canCreatePurchaseOrderCapability:()=>true, canAccessPage:()=>true,
        document:{getElementById:()=>button},
        registerPurchaseIncoming:async () => { registrationCalls++; await new Promise(resolve => { releaseRegistration=resolve; }); },
        printSavedPoDocument:()=>{printCalls++;}, updatePoSaveStatus:message=>alerts.push(message),
        updatePoSaveButton:()=>{button.innerText='🖨️ 列印／輸出 PDF';}, alert:message=>alerts.push(message)
    });
    vm.runInContext(`let poSaveInProgress=false; let poIncomingSyncPending=false;\n${app.slice(start,end)}\n}`, context);
    await context.window.printPurchaseOrder();
    assert.equal(printCalls, 1);
    assert.equal(registrationCalls, 0);
    vm.runInContext('poIncomingSyncPending=true', context);
    const first = context.window.printPurchaseOrder();
    assert.equal(button.disabled, true);
    assert.match(button.innerText, /同步在途庫存中/);
    await context.window.printPurchaseOrder();
    assert.equal(registrationCalls, 1);
    releaseRegistration();
    await first;
    assert.equal(printCalls, 1);
    assert.equal(button.disabled, false);
    assert.match(alerts[0], /同步完成/);
    await context.window.printPurchaseOrder();
    assert.equal(printCalls, 2);

    vm.runInContext('poIncomingSyncPending=true', context);
    context.registerPurchaseIncoming = async () => { throw new Error('網路中斷'); };
    await context.window.printPurchaseOrder();
    assert.equal(printCalls, 2);
    assert.equal(button.disabled, false);
    assert.match(alerts.at(-1), /在途庫存同步仍未完成.*網路中斷/);
});

test('PO print opens directly from the user action', () => {
    const start = app.indexOf('function printSavedPoDocument(poNo, vendorName)');
    const end = app.indexOf('\n}\n', start) + 2;
    const calls = [];
    const doc = { title:'訂單', body:{classList:{add:name=>calls.push(name)}} };
    const context = vm.createContext({
        document:doc,
        window:{ print:()=>calls.push('print') },
        preparePurchaseOrderForPrint:()=>calls.push('prepare'),
        requestAnimationFrame:callback=>callback()
    });
    vm.runInContext(app.slice(start,end),context);
    context.printSavedPoDocument('PO-1','供應商');
    assert.deepEqual(calls,['printing-po','prepare','print']);
    assert.equal(doc.title,'PO-1＋供應商');
});

test('direct stock PO opens before supplier and warehouse masters finish loading', () => {
    const source = app.match(/window\.openDirectStockPurchase = async function\(\) \{[\s\S]*?\n\};/)?.[0];
    assert.ok(source);
    const openIndex = source.indexOf("poModalOverlay').classList.add('active')");
    const awaitIndex = source.indexOf('await loadSupplierWarehouseMasters()');
    assert.ok(openIndex >= 0 && awaitIndex > openIndex, 'blank stock PO should be visible before master data finishes loading');
    assert.match(source, /if \(!item\.warehouseId\) item\.warehouseId = warehouseId/);
    assert.doesNotMatch(source.slice(awaitIndex), /renderPoItemsTable\(/);
});

test('PO print prepares text mirrors and keeps rows and totals together', () => {
    const helper = app.match(/function preparePurchaseOrderForPrint\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(helper);
    assert.match(helper, /po-print-field-mirror/);
    assert.match(helper, /input\.setAttribute\('value', input\.value\)/);
    assert.match(styles, /body\.printing-po #printablePO input \{ display:none !important; \}/);
    assert.match(styles, /body\.printing-po \.po-total-section/);
    assert.match(styles, /page-break-inside:avoid !important/);
    assert.match(html, /class="po-total-section"/);
});


test('order work cards and filters use item-level work states', () => {
    assert.match(app, /function orderItemWorkCategory\(order, item\)/);
    assert.match(app, /function orderWorkCategories\(order\)/);
    assert.match(app, /normalizedOrderItems\(order\)\.forEach\(item => \{/);
    assert.match(app, /metrics\[category\]\.count\+\+/);
    assert.match(app, /categories\.includes\(activeOrderWorkFilter\)/);
    assert.match(app, /shown\.map\(category=>map\[category\]\?\.label\)/);
    assert.match(app, /const primaryStatus=orderItemDisplayCategory\(o,item\)/);
    assert.match(app, /訂單狀態：<span class="order-progress-badge">/);
    assert.match(app, /function pendingProcurementDisplayLines\(order\)/);
    assert.match(app, /orderItemDisplayCategories\(order,item\)\.includes\('dispatch'\)/);
    assert.match(app, /\['dispatch', '待打單'\]/);
    assert.match(app, /\['shipping', '待出貨'\]/);
    assert.match(app, /allOrderItems\.filter\(item=>orderItemDisplayCategories\(o,item\)\.includes\(activeOrderWorkFilter\)\)/);
    assert.match(app, /return YushinWorkflow\.itemWorkCategory\(input\);/);
});

test('stock order shows dispatch, shipping, billing and complete as work advances', () => {
    const dispatchSource = app.match(/function itemDispatchState\(order, item\) \{[\s\S]*?\n\}\n(?=\nfunction orderContextActionState)/)?.[0];
    const categorySource = app.match(/function orderItemWorkCategory\(order, item\) \{[\s\S]*?\n\}\n(?=\nfunction orderWorkCategories)/)?.[0];
    assert.ok(dispatchSource && categorySource);
    const ctx = vm.createContext({
        normalizedOrderItems:order=>order.items,
        savedDeliveryRecords:order=>order.deliveryRecords||[],
        savedReturnRecords:()=>[],
        orderLifecycleInfo:()=>({status:'normal',returned:0,effectiveDelivered:0}),
        YushinWorkflow:workflow
    });
    vm.runInContext(`${dispatchSource}\n${categorySource}`,ctx);
    const order={items:[{itemId:'I1',qty:3,orderedQty:3,inventoryShortageQty:0,
        fulfillmentType:'WAREHOUSE',reservedQty:3,dispatchPreparedQty:0}],isBilled:false,deliveryRecords:[]};
    const current=()=>ctx.orderItemDisplayCategory(order,order.items[0]);
    assert.equal(current(),'dispatch');
    order.items[0].dispatchPreparedQty=1;
    assert.equal(current(),'dispatch','a partly prepared line still has a dispatch task');
    assert.equal(ctx.itemDispatchState(order,order.items[0]).shippable,1);
    order.items[0].dispatchPreparedQty=3;
    assert.equal(current(),'shipping');
    order.deliveryRecords=[{itemId:'I1',qty:3}];
    assert.equal(current(),'billing');
    order.isBilled=true;
    assert.equal(current(),'complete');
    order.deliveryRecords=[];
    assert.equal(current(),'shipping','billing before shipment does not complete the order');
});

test('a partly stocked order keeps its shortage and exposes reserved stock to dispatch', () => {
    const dispatchSource = app.match(/function itemDispatchState\(order, item\) \{[\s\S]*?\n\}\n(?=\nfunction orderContextActionState)/)?.[0];
    const categorySource = app.match(/function orderItemWorkCategory\(order, item\) \{[\s\S]*?\n\}\n(?=\nfunction orderWorkIndexFields)/)?.[0];
    assert.ok(dispatchSource && categorySource);
    const context = vm.createContext({
        normalizedOrderItems:order=>order.items,
        savedDeliveryRecords:()=>[],savedReturnRecords:()=>[],
        orderLifecycleInfo:()=>({status:'normal',returned:0,effectiveDelivered:0}),
        YushinWorkflow:workflow
    });
    vm.runInContext(`${dispatchSource}\n${categorySource}`,context);
    const order={items:[{itemId:'I1',qty:10,orderedQty:10,inventoryShortageQty:5,
        purchaseRequiredQty:5,fulfillmentType:'WAREHOUSE',reservedQty:5,dispatchPreparedQty:0}]};
    const item=order.items[0];
    assert.equal(context.orderItemWorkCategory(order,item),'ordering');
    assert.deepEqual(Array.from(context.orderItemDisplayCategories(order,item)),['ordering','dispatch']);
    assert.deepEqual(Array.from(context.orderWorkCategories(order)),['ordering','dispatch']);
    item.dispatchPreparedQty=5;
    assert.deepEqual(Array.from(context.orderWorkCategories(order)),['ordering']);
    item.purchaseOrderedQty=5;
    assert.equal(context.orderItemWorkCategory(order,item),'arrival');
    assert.deepEqual(Array.from(context.orderItemDisplayCategories(order,item)),['arrival']);
});


test('purchasing completed starts at 50 rows and supports loading more', () => {
    assert.match(html, /id="purchaseCompletedMoreBtn"/);
    assert.match(app, /let purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT/);
    assert.match(app, /function visiblePurchasingCompletedRows\(\)/);
    assert.match(app, /window\.loadMorePurchasingCompleted = async function\(\)/);
    assert.match(app, /purchasingCompletedVisibleLimit \+= DEFAULT_LIST_LIMIT/);
    assert.match(app, /await loadPurchasingDispatchOrders\(false\)/);
});

test('purchasing completed excludes unresolved procurement and includes direct ship after arrival', () => {
    const start = app.indexOf('function purchasingCompletedRows()');
    const end = app.indexOf('function renderPurchasingCompletedOrders()', start);
    const source = app.slice(start, end);
    assert.match(source, /const category = orderItemWorkCategory\(order, item\)/);
    assert.match(source, /\['ordering', 'arrival', 'closed'\]\.includes\(category\)/);
    assert.match(source, /const directShip = \(item\.fulfillmentType \|\| order\.fulfillmentType \|\| 'WAREHOUSE'\) === 'DIRECT_SHIP'/);
    assert.match(source, /if \(!directShip &&/);
    assert.match(source, /return rows;/);
    assert.match(app, /return purchasingCompletedRows\(\)\.slice\(0, purchasingCompletedVisibleLimit\)/);
});

test('receiving waits for both order work state and purchase evidence before declaring empty', () => {
    assert.match(app, /function loadPurchasingReceivingQueue\(reset = true\)/);
    assert.match(app, /Promise\.allSettled\(\[[\s\S]*?loadPurchaseOrderPage\(reset\)[\s\S]*?refreshPurchasingOrderCache\(reset\)/);
    assert.match(app, /function purchasingArrivalWorkKeys\(filters = purchaseFilterContext\(\)\)/);
    assert.match(app, /採購紀錄載入中/);
    assert.match(app, /尚未找到對應採購紀錄/);
});

test('purchase-order history search reads every indexed match instead of stopping at 50', () => {
    const start = app.indexOf('async function runPurchaseOrderHistorySearch()');
    const end = app.indexOf('function receivingSourceOrderForItem', start);
    const source = app.slice(start, end);
    assert.match(source, /while\(true\)/);
    assert.match(source, /\.where\('searchTokens','array-contains',token\)/);
    assert.match(source, /if\(snapshot\.size<DEFAULT_LIST_LIMIT\)break/);
    assert.match(source, /cursor=snapshot\.docs\[snapshot\.docs\.length-1\]/);
    assert.match(source, /generation!==poHistorySearchGeneration/);
    assert.match(source, /全歷史搜尋中：已檢查/);
});

test('purchase-order history search does not scan legacy unindexed history', () => {
    const start = app.indexOf('async function runPurchaseOrderHistorySearch()');
    const end = app.indexOf('function receivingSourceOrderForItem', start);
    const source = app.slice(start, end);
    assert.match(source, /where\('searchTokens','array-contains',token\)/);
    assert.doesNotMatch(source, /舊訂購單相容搜尋/);
    assert.doesNotMatch(source, /while\(!done\)/);
});

test('purchase receiving queue calculates progress per PO item',()=>{
    assert.match(app,/function poItemReceiptProgress\(po,item,itemIndex\)/);
    assert.match(app,/const receipt=poItemReceiptProgress\(po,item,itemIndex\)/);
    assert.match(app,/receipt\.remaining<=0/);
    assert.match(app,/receivePurchaseOrderItem\('\$\{escapeAttr\(po\.id\)\}',\$\{itemIndex\}\)/);
});


test('purchase receipt synchronizes received quantity back to the source order item',()=>{
    assert.match(app,/const sourceReceivedQty=Math\.min\(Number\(sourceItem\.qty\|\|sourceItem\.orderedQty\|\|0\),Number\(sourceItem\.receivedQty\|\|0\)\+qty\)/);
    assert.match(app,/\.\.\.row,receivedQty:sourceReceivedQty,/);
    assert.match(app,/inventoryReservedQty:Number\(row\.inventoryReservedQty\|\|0\)\+reserveFromReceipt/);
    assert.match(app,/if\(reserveFromReceipt>0\)\{/);
});


test('self-order receipt uses fulfillment core receivedQty without adding it twice',()=>{
    assert.match(app,/const next=window\.YushinFulfillment\.applyReceipt\(item,qty\);/);
    assert.doesNotMatch(app,/\{\.\.\.next,receivedQty:Number\(item\.receivedQty\|\|0\)\+qty/);
});


test('self-order receipt keeps reservation from fulfillment core without adding reserveQty twice',()=>{
    assert.match(app,/items\[itemIndex\]=\{\.\.\.next,reservedQty:next\.reservedQty,inventoryReservedQty:next\.reservedQty\}/);
    assert.doesNotMatch(app,/reservedQty:Number\(item\.reservedQty\?\?item\.inventoryReservedQty\?\?0\)\+reserveQty/);
    assert.match(app,/reserved:inv\.reserved\+reserveQty/);
});


test('new order reservation persists derived work category index after item reservation is known',()=>{
    assert.match(app,/function orderWorkIndexFields\(order\)/);
    assert.match(app,/workCategories:categories/);
    assert.match(app,/Object\.assign\(updates,orderWorkIndexFields\(order\)\);\s*await db\.collection\('orders'\)\.doc\(orderId\)\.set\(updates,\{merge:true\}\)/);
});


test('purchasing state transitions refresh the derived order work index',()=>{
    assert.match(app,/const nextOrderData=\{\.\.\.orderData,items:nextItems[\s\S]*?\.\.\.orderWorkIndexFields\(nextOrderData\)/);
    assert.match(app,/savedOrder=\{\.\.\.order,items,itemCount:items\.length[\s\S]*?\.\.\.orderWorkIndexFields\(savedOrder\)/);
    assert.match(app,/const nextOrder=\{\.\.\.order,items,itemCount:items\.length[\s\S]*?\.\.\.orderWorkIndexFields\(nextOrder\)/);
    assert.match(app,/const nextSourceOrder=\{\.\.\.sourceOrder,items:nextSourceItems[\s\S]*?\.\.\.orderWorkIndexFields\(nextSourceOrder\)/);
});


test('order lifecycle, delivery and return mutations refresh work category index',()=>{
    assert.match(app,/Object\.assign\(updates,orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)\);/);
    const deliverySync=(app.match(/orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)[\s\S]{0,160}deliveryHistory/g)||[]).length;
    const returnSync=(app.match(/orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)[\s\S]{0,160}returnHistory/g)||[]).length;
    assert.ok(deliverySync>=3,'all delivery mutation paths should refresh the work index');
    assert.ok(returnSync>=2,'all return mutation paths should refresh the work index');
});


test('purchasing work cards reuse the shared recent order cache',()=>{
    assert.match(app,/function refreshPurchasingOrderCache\(reset = true\)/);
    assert.match(app,/pendingPurchaseCache = ordersCache\.filter\(order => pendingProcurementDisplayLines\(order\)\.length > 0\)/);
    assert.match(app,/orderItemDisplayCategories\(order,item\)\.includes\('dispatch'\)/);
    assert.doesNotMatch(app,/where\('workCategories',\s*'array-contains',\s*'ordering'\)/);
    assert.doesNotMatch(app,/where\('workCategories','array-contains','dispatch'\)/);
    assert.match(app,/where\('receiptStatus','in',\['pending','partial'\]\)/);
    assert.match(app,/supplyOrders'\)\.where\('status','in',\['ORDERED','PARTIAL_RECEIPT'\]\)/);
});

test('shortage allocation maintains work indexes',()=>{
    assert.match(app,/allocateFreeReceiptStockToShortages[\s\S]*?orderWorkIndexFields\(nextOrder\)/);
});


test('quote cancellation and legacy delivery cleanup refresh work category index',()=>{
    assert.match(app,/const cancelledOrder = \{\.\.\.order,status:'cancelled'[\s\S]*?orderWorkIndexFields\(cancelledOrder\)/);
    assert.match(app,/clearLegacyDelivery[\s\S]*?Object\.assign\(updates,orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)\)/);
});

test('receiving queue includes self orders but follows the source order arrival state',()=>{
    assert.match(app,/receiptStatus: 'pending'/);
    assert.match(app,/const freshSupply=supplySnapshot\.docs\s*\.map\(doc=>\(\{id:doc\.id,\.\.\.doc\.data\(\)\}\)\)\s*\.filter\(row=>row\.type==='SALES_SELF_ORDER'\|\|row\.type==='PURCHASING_MANUAL'\)/);
    assert.match(app,/業務自行訂購/);
    assert.match(app,/function receivingQueueContext\(record, item\)/);
    assert.match(app,/orderItemDisplayCategories\(sourceOrder,sourceItem\)\.includes\('arrival'\)/);
});

test('manual ordered action records supply and source item only once after an uncertain response', async () => {
    const source = app.match(/const pendingPurchaseOrderKeys = new Set\(\);[\s\S]*?\n(?=window\.openOrderPurchaseDraft)/)?.[0];
    assert.ok(source);
    const order = {items:[{itemId:'I1',itemCode:'P1',itemName:'Product',qty:2,
        productId:'P1',supplier:'Vendor',costPrice:100,warehouseId:'W1',
        procurementType:'PURCHASING_PO',purchaseOrderedQty:0,inventoryShortageQty:2}],orderNo:'O1'};
    let supply, updates = 0;
    const orderRef = {kind:'order'}, supplyRef = {kind:'supply',id:'manual-O1-I1'};
    const button={disabled:false,textContent:'已訂購',isConnected:false};
    const page={classList:{contains:()=>true}},card={};
    const switched=[];
    const context = vm.createContext({
        window:{},document:{getElementById:id=>id==='purchasing-system'?page:id==='purchase-card-receiving'?card:null},
        db:{collection:name=>({doc:()=> name==='orders' ? orderRef : supplyRef}),
            async runTransaction(callback){
                await callback({
                    async get(ref){return ref.kind==='order'
                        ? {exists:true,id:'O1',data:()=>order}
                        : {exists:!!supply,data:()=>supply};},
                    set(ref,data){supply=data;},
                    update(ref,data){Object.assign(order,data);updates++;}
                });
            }},
        canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
        currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
        remainingProcurementQty:(record,item)=>Math.max(0,2-Number(item.purchaseOrderedQty||0)),
        poIncomingKey:()=> 'P1',defaultWarehouse:()=>({id:'W1'}),localDateString:()=> '2026-09-29',
        normalizedOrderStatus:()=> 'normal',
        normalizedOrderItems:record=>record.items,orderWorkIndexFields:()=>({workCategories:['arrival']}),
        ordersCache:[],supplyReceivingCache:[],purchasingView:'ordering',
        syncOrderIntoPurchasingCaches:()=>{},writeAppDataCache:()=>{},renderOrdersList:()=>{},
        switchPurchasingView:(view,tab)=>switched.push([view,tab]),alert:()=>{}
    });
    vm.runInContext(source,context);
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(updates,1);
    assert.equal(order.items[0].purchaseOrderedQty,2);
    assert.equal(order.items[0].supplyOrderedQty,2);
    assert.equal(supply.type,'PURCHASING_MANUAL');
    assert.equal(supply.status,'ORDERED');
    assert.equal(supply.orderDate,'2026-09-29');
    assert.deepEqual(switched,[['receiving',card]]);
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(updates,1,'retry must not increase ordered quantity twice');
});

test('manual ordered action can add a later genuine shortage without duplicating retries', async () => {
    const source = app.match(/const pendingPurchaseOrderKeys = new Set\(\);[\s\S]*?\n(?=window\.openOrderPurchaseDraft)/)?.[0];
    assert.ok(source);
    const order = {items:[{itemId:'I1',itemCode:'P1',itemName:'Product',qty:2,
        productId:'P1',supplier:'Vendor',costPrice:100,warehouseId:'W1',
        procurementType:'PURCHASING_PO',purchaseOrderedQty:0,supplyOrderedQty:0,receivedQty:0,inventoryShortageQty:2}],orderNo:'O1'};
    let supply, updates = 0;
    const orderRef = {kind:'order'}, supplyRef = {kind:'supply',id:'manual-O1-I1'};
    const button={disabled:false,textContent:'已訂購',isConnected:false};
    const context = vm.createContext({
        window:{},document:{getElementById:()=>null},
        db:{collection:name=>({doc:()=> name==='orders' ? orderRef : supplyRef}),
            async runTransaction(callback){
                await callback({
                    async get(ref){return ref.kind==='order'
                        ? {exists:true,id:'O1',data:()=>order}
                        : {exists:!!supply,data:()=>supply};},
                    set(ref,data){supply=data;},
                    update(ref,data){Object.assign(order,data);updates++;}
                });
            }},
        canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
        currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
        remainingProcurementQty:(record,item)=>{
            const ordered=Math.max(Number(item.purchaseOrderedQty||0),Number(item.supplyOrderedQty||0));
            const received=Number(item.receivedQty||0);
            return Math.max(0,Number(item.inventoryShortageQty||0)-Math.max(0,ordered-received));
        },
        poIncomingKey:()=> 'P1',defaultWarehouse:()=>({id:'W1'}),localDateString:()=> '2026-09-30',
        normalizedOrderStatus:()=> 'normal',normalizedOrderItems:record=>record.items,
        orderWorkIndexFields:()=>({workCategories:['arrival']}),ordersCache:[],supplyReceivingCache:[],
        syncOrderIntoPurchasingCaches:()=>{},writeAppDataCache:()=>{},renderOrdersList:()=>{},
        switchPurchasingView:()=>{},alert:()=>{}
    });
    vm.runInContext(source,context);
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(supply.qty,2);
    assert.equal(supply.orderEvents.length,1);
    assert.equal(updates,1);
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(supply.qty,2,'plain retry must remain idempotent');
    assert.equal(supply.orderEvents.length,1);
    assert.equal(updates,1);
    order.items[0].inventoryShortageQty=5;
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(supply.qty,5,'new uncovered shortage is added to the existing manual supply');
    assert.equal(supply.orderEvents.length,2);
    assert.equal(order.items[0].purchaseOrderedQty,5);
    assert.equal(updates,2);
});

test('ordered action is a direct snapshot-based state change without a data-entry modal or product lookup', () => {
    const actionSource = app.match(/function renderPendingPurchaseOrders\(\) \{[\s\S]*?\n\}/)?.[0];
    const saveSource = app.match(/window\.markPurchaseItemOrdered = async function\(orderId, itemId, button\) \{[\s\S]*?\n\};/)?.[0];
    assert.ok(actionSource && saveSource);
    assert.match(actionSource, /markPurchaseItemOrdered[\s\S]*?>已訂購<\/button>/);
    assert.match(saveSource, /switchPurchasingView\('receiving', document\.getElementById\('purchase-card-receiving'\)\)/);
    assert.match(saveSource, /remainingProcurementQty\(order, item\)/);
    assert.doesNotMatch(saveSource, /Product|findProduct|preloadPurchaseCosts|loadSupplierWarehouseMasters|supplierForProduct/);
    assert.doesNotMatch(html, /id="manualPurchaseOverlay"/);
    assert.doesNotMatch(app, /printSupplyOrderDocument/);
});

test('loading another receiving page retains source status for earlier PO rows', async () => {
    const source = app.match(/async function loadPurchaseOrderPage\(reset\) \{[\s\S]*?\n\}\n(?=\nwindow\.loadMyPurchaseOrders)/)?.[0];
    assert.ok(source);
    const purchaseDocs = ['PO1','PO2'].map((id,index) => ({
        id, data:() => ({poNo:id,items:[{orderId:`ORDER${index+1}`}]})
    }));
    const supplyDocs = [
        {id:'FORMAL',data:()=>({type:'PURCHASING_PO',status:'ORDERED'})},
        {id:'SELF',data:()=>({type:'SALES_SELF_ORDER',status:'ORDERED',orderId:'ORDER2',orderDate:'2026-09-27'})},
        {id:'SELF-OLDER',data:()=>({type:'SALES_SELF_ORDER',status:'ORDERED',orderId:'ORDER1',orderDate:'2026-09-26'})}
    ];
    let page = 0;
    let supplyPage = 0;
    const purchaseQuery = {
        where(){return this;}, orderBy(){return this;}, limit(){return this;}, startAfter(){return this;},
        async get(){const docs=[purchaseDocs[page++]];return {docs,size:docs.length,empty:false};}
    };
    const context = vm.createContext({
        window:{}, db:{collection:name => name==='purchaseOrders' ? purchaseQuery : name==='supplyOrders'
            ? {where(){return this;},limit(){return this;},startAfter(){return this;},async get(){const doc=supplyDocs[supplyPage++];const docs=doc?[doc]:[];return {docs,size:docs.length,empty:!docs.length};}}
            : {where(){return this;},async get(){return {docs:purchaseDocs.map((doc,index)=>({id:`ORDER${index+1}`,data:()=>({status:'active'})}))};}}},
        firebase:{firestore:{FieldPath:{documentId:()=>({})}}},
        canAccessPage:()=>true, currentUserRole:'purchaser', purchasingView:'receiving',
        poListPageLoading:false, poListCursor:null, poListHasMore:true, poListCache:[],
        supplyReceivingCache:[], supplyReceivingCursor:null, supplyReceivingHasMore:true,
        receivingSourceOrderStatusCache:new Map(), receivingSourceOrderCache:new Map(), ordersCache:[], DEFAULT_LIST_LIMIT:1,
        BUSINESS_STATUS:{ACTIVE:'active'}, normalizedOrderStatus:()=> 'normal',
        purchaseItemsFromSavedPo:po=>po.items, readAppDataCache:()=>null,
        compareBusinessRecordsNewestFirst:(a,b,dateField,numberField)=>{
            const dateCompare=String(b?.[dateField]||'').localeCompare(String(a?.[dateField]||''));
            return dateCompare || String(b?.[numberField]||'').localeCompare(String(a?.[numberField]||''));
        },
        writeAppDataCache:()=>{}, renderPoList:()=>{}, renderPurchasingWorkCards:()=>{},
        updatePoLoadMoreButton:()=>{}, alert:message=>{throw new Error(message)}
    });
    vm.runInContext(source,context);
    await context.loadPurchaseOrderPage(true);
    assert.equal(context.receivingSourceOrderStatusCache.get('ORDER1'),'normal');
    assert.equal(context.supplyReceivingCache.length,0);
    await context.loadPurchaseOrderPage(false);
    assert.equal(context.poListCache.length,2);
    assert.equal(context.supplyReceivingCache.length,1);
    assert.equal(context.supplyReceivingCache[0].id,'SELF');
    assert.equal(context.receivingSourceOrderStatusCache.get('ORDER1'),'normal');
    assert.equal(context.receivingSourceOrderStatusCache.get('ORDER2'),'normal');
    context.poListHasMore=false;
    await context.loadPurchaseOrderPage(false);
    assert.equal(page,2,'PO query should stop after its last page');
    assert.equal(context.supplyReceivingCache.length,2,'older self-orders remain reachable');
    assert.equal(context.receivingSourceOrderStatusCache.get('ORDER1'),'normal');
});

test('pending purchasing work loads one shared order page at a time without losing older rows', async () => {
    const refreshSource = app.match(/function refreshPurchasingOrderCache\(reset = true\) \{[\s\S]*?\n\}/)?.[0];
    const source = app.match(/window\.loadPendingPurchaseOrders = async function\(reset = true\) \{[\s\S]*?\n\};\n(?=\nconst pendingPurchaseOrderKeys)/)?.[0];
    assert.ok(refreshSource && source);
    let reads=0;
    const context=vm.createContext({
        window:{}, canCreatePurchaseOrderCapability:()=>true, canAccessPage:()=>true,
        pendingPurchaseLoading:false, pendingPurchaseHasMore:true, pendingPurchaseCache:[], pendingPurchaseError:'',
        purchasingOrderRefreshPromise:null, ordersCache:[], orderPaginationState:null,
        loadOrderPage:async reset=>{
            reads++;
            if(reset) context.ordersCache=[{id:'O1'},{id:'O2'}];
            else context.ordersCache.push({id:'O3'});
            context.orderPaginationState={sourceIndex:reads===1?0:1,sources:[{}]};
        },
        pendingProcurementDisplayLines:()=>[{}], writeAppDataCache:()=>{},
        renderPendingPurchaseOrders:()=>{}, renderPurchasingWorkCards:()=>{}
    });
    vm.runInContext(`${refreshSource}\n${source}`,context);
    await context.window.loadPendingPurchaseOrders(true);
    assert.equal(reads,1);
    assert.deepEqual(Array.from(context.pendingPurchaseCache,row=>row.id),['O1','O2']);
    assert.equal(context.pendingPurchaseHasMore,true);
    await context.window.loadPendingPurchaseOrders(false);
    assert.equal(reads,2);
    assert.deepEqual(Array.from(context.pendingPurchaseCache,row=>row.id),['O1','O2','O3']);
    assert.equal(context.pendingPurchaseHasMore,false);
});


test('pending purchasing work reports a shared order-load failure without overwriting the card count', async () => {
    const refreshSource = app.match(/function refreshPurchasingOrderCache\(reset = true\) \{[\s\S]*?\n\}/)?.[0];
    const source = app.match(/window\.loadPendingPurchaseOrders = async function\(reset = true\) \{[\s\S]*?\n\};\n(?=\nconst pendingPurchaseOrderKeys)/)?.[0];
    const renderSource = app.match(/function renderPendingPurchaseOrders\(\) \{[\s\S]*?\n\}\n(?=\nwindow\.loadPendingPurchaseOrders)/)?.[0];
    assert.ok(refreshSource && source && renderSource);
    const context = vm.createContext({
        window:{}, canCreatePurchaseOrderCapability:()=>true, canAccessPage:()=>true,
        pendingPurchaseLoading:false, pendingPurchaseHasMore:true, pendingPurchaseCache:[], pendingPurchaseError:'',
        purchasingOrderRefreshPromise:null, ordersCache:[], orderPaginationState:null,
        loadOrderPage:async()=>{throw new Error('網路中斷');},
        pendingProcurementDisplayLines:()=>[], writeAppDataCache:()=>{},
        renderPendingPurchaseOrders:()=>{}, renderPurchasingWorkCards:()=>{}
    });
    vm.runInContext(`${refreshSource}\n${source}`,context);
    await context.window.loadPendingPurchaseOrders(true);
    assert.match(context.pendingPurchaseError,/網路中斷/);
    assert.doesNotMatch(renderSource,/purchaseCountOrdering/);
});


test('cancelled source is excluded from the order-aligned receiving queue', () => {
    assert.match(app,/if\(!sourceOrder \|\| normalizedOrderStatus\(sourceOrder\)!=='normal'\)return null/);
    assert.match(app,/不屬於目前訂單「待到貨」狀態，不計入上方工作卡/);
    assert.match(app,/if\(normalizedOrderStatus\(sourceOrder\)!=='normal'\)throw new Error\('來源訂單已取消/);
});

test('cancelled warehouse PO receipt moves incoming to free stock exactly once', async () => {
    const start=app.indexOf('async function receiveSinglePoLine(');
    const end=app.indexOf('\nwindow.savePoReceiptBatch =',start);
    assert.ok(start>=0&&end>start);
    const order={status:'cancelled',orderStatus:'cancelled',items:[{itemId:'item-1',qty:3,inventoryReservedQty:0,inventoryShortageQty:0,receivedQty:0}]};
    const docs=new Map([
        ['purchaseOrders/PO1',{items:[{orderId:'O1',orderItemIndex:0,productId:'P1',warehouseId:'W1',qty:3,unitPrice:10}],receiptRecords:[],receiptStatus:'pending'}],
        ['orders/O1',order],
        ['inventory/P1',{onHand:0,reserved:0,incoming:3,lots:[]}],
        ['warehouseStocks/W1__P1',{onHand:0,reserved:0,incoming:3}],
        ['pendingInventoryItems/W1__P1',{incomingQty:3}]
    ]);
    let sequence=0,allocated=0;
    const ref=(name,id)=>({key:`${name}/${id??++sequence}`,id});
    const db={collection:name=>({doc:id=>ref(name,id)}),async runTransaction(callback){
        const writes=[];
        const tx={
            get:async r=>({id:r.id,exists:docs.has(r.key),data:()=>docs.get(r.key)}),
            set:(r,value,options)=>writes.push([r,value,options]),
            update:(r,value)=>writes.push([r,value,{merge:true}])
        };
        await callback(tx);
        writes.forEach(([r,value,options])=>docs.set(r.key,options?.merge?{...docs.get(r.key),...value}:value));
    }};
    const context=vm.createContext({
        db,window:{},currentUserName:'採購',currentUser:null,
        purchaseItemsFromSavedPo:po=>po.items,receivedQuantityForPoItem:(po,index)=>(po.receiptRecords||[]).filter(row=>row.itemIndex===index).reduce((sum,row)=>sum+row.qty,0),
        formalSupplyOrderId:(po,index)=>`${po}_${index}`,normalizedOrderStatus:row=>row.status==='cancelled'?'cancelled':'normal',
        normalizedOrderItems:row=>row.items,poIncomingKey:item=>item.productId,defaultWarehouse:()=>({id:'W1'}),
        warehouseStockDocId:(warehouse,key)=>`${warehouse}__${key}`,inventoryNumbers:row=>({onHand:row.onHand||0,reserved:row.reserved||0,incoming:row.incoming||0}),
        resolveBrandName:name=>name,buildInventorySearchTokens:()=>[],localDateString:()=> '2026-09-27',
        DEFAULT_CURRENCY:'TWD',BUSINESS_STATUS:{ACTIVE:'active',COMPLETED:'completed'},DOCUMENT_TYPES:{PURCHASE_ORDER:'PURCHASE_ORDER'},
        invalidateWarehouseStockCache:()=>{},allocateFreeReceiptStockToShortages:async()=>{allocated++;return {affectedOrderIds:[]};}
    });
    vm.runInContext(app.slice(start,end),context);
    await context.receiveSinglePoLine('PO1',0,3,'LOT1','','receipt-1');
    assert.equal(docs.get('inventory/P1').onHand,3);
    assert.equal(docs.get('inventory/P1').incoming,0);
    assert.equal(docs.get('inventory/P1').reserved,0);
    assert.equal(docs.get('warehouseStocks/W1__P1').onHand,3);
    assert.equal(docs.get('warehouseStocks/W1__P1').incoming,0);
    assert.equal(docs.get('warehouseStocks/W1__P1').reserved,0);
    assert.equal(docs.get('pendingInventoryItems/W1__P1').incomingQty,0);
    assert.deepEqual(docs.get('orders/O1'),order);
    assert.equal(allocated,0);
    assert.equal(docs.get('purchaseOrders/PO1').receiptStatus,'received');
    await context.receiveSinglePoLine('PO1',0,3,'LOT1','','receipt-1');
    assert.equal(docs.get('inventory/P1').onHand,3);
    assert.equal(docs.get('purchaseOrders/PO1').receiptRecords.length,1);
    assert.equal([...docs.keys()].filter(key=>key.startsWith('inventoryLots/')).length,1);
    await assert.rejects(context.receiveSinglePoLine('PO1',0,3,'LOT1','','receipt-2'),/到貨數量不正確/);
    assert.equal(docs.get('inventory/P1').onHand,3);
});

test('purchasing pending card and detail share the same item work-state engine', () => {
    const cardStart=app.indexOf('function renderPurchasingWorkCards()');
    const cardEnd=app.indexOf('window.renderPurchasingView',cardStart);
    const detailStart=app.indexOf('function renderPendingPurchaseOrders()');
    const detailEnd=app.indexOf('window.loadPendingPurchaseOrders',detailStart);
    const helperStart=app.indexOf('function buildOrderItemWorkMetrics(');
    const helperEnd=app.indexOf('window.setOrderWorkFilter',helperStart);
    const displayStart=app.indexOf('function pendingProcurementDisplayLines(order)');
    const displayEnd=app.indexOf('function renderPurchasingWorkCards()',displayStart);
    const formalStart=app.indexOf('function pendingPurchaseLines(order)');
    const formalEnd=app.indexOf('function syncOrderIntoPurchasingCaches',formalStart);
    assert.ok(cardStart>=0&&detailStart>=0&&helperStart>=0&&displayStart>=0&&formalStart>=0);
    assert.match(app.slice(cardStart,cardEnd),/buildOrderItemWorkMetrics\(/);
    assert.match(app.slice(helperStart,helperEnd),/orderItemDisplayCategories\(order,item\)/);
    assert.match(app.slice(displayStart,displayEnd),/orderItemWorkCategory\(order, item\) !== 'ordering'/);
    assert.match(app.slice(detailStart,detailEnd),/pendingProcurementDisplayLines\(order\)/);
    assert.match(app.slice(detailStart,detailEnd),/業務自行訂貨/);
    assert.match(app.slice(formalStart,formalEnd),/procurementType === 'PURCHASING_PO'/);
});

test('PO core transaction commits before the print dialog opens', () => {
    const start=app.indexOf('window.printPurchaseOrder = async function()');
    const end=app.indexOf("window.addEventListener('afterprint'",start);
    const source=app.slice(start,end);
    const awaitIndex=source.indexOf('await commitPromise;');
    const printIndex=source.indexOf('printSavedPoDocument(poNo, vendorName);');
    assert.ok(awaitIndex>=0&&printIndex>awaitIndex,'core PO transaction must finish before print');
    assert.match(source,/registerPurchaseIncoming\(poDocumentId, poRecord, previousPoForIncoming\)\s*\.then/);
});

test('committed PO refreshes item quantities in order and purchasing views', () => {
    const start=app.indexOf('function syncOrderIntoPurchasingCaches(order, options = {}) {');
    const end=app.indexOf('\nfunction renderPendingPurchaseOrders()',start);
    assert.ok(start>=0&&end>start);
    assert.match(app,/committedSourceOrders\.push\(\{id:snapshot\.id,\.\.\.orderData,\.\.\.orderUpdates\}\)/);
    assert.match(app,/syncCommittedPurchaseOrderSources\(committedSourceOrders\)/);
    const oldOrder={id:'O1',items:[{qty:5,purchaseOrderedQty:0}]};
    const writes=[];
    let listRenders=0;
    const context=vm.createContext({
        ordersCache:[oldOrder],pendingPurchaseCache:[oldOrder],purchasingDispatchCache:[],
        purchasingView:'ordering',
        pendingProcurementDisplayLines:order=>order.items[0].purchaseOrderedQty<5?[{}]:[],
        normalizedOrderItems:order=>order.items,
        orderItemDisplayCategories:()=>[],
        normalizedOrderStatus:()=> 'normal',
        receivingSourceOrderStatusCache:new Map(),
        receivingSourceOrderCache:new Map(),
        writeAppDataCache:(kind,rows)=>writes.push([kind,Array.from(rows,row=>row.id)]),
        document:{getElementById:id=>({classList:{contains:()=>id==='order-system'}})},
        renderPurchasingWorkCards:()=>{},renderPurchasingView:()=>{},
        renderPendingPurchaseOrders:()=>{},renderPurchasingDispatchOrders:()=>{},renderPoList:()=>{},
        renderOrdersList:()=>{listRenders++;}
    });
    vm.runInContext(app.slice(start,end),context);
    vm.runInContext("syncCommittedPurchaseOrderSources([{id:'O1',items:[{qty:5,purchaseOrderedQty:3}]}])",context);
    assert.equal(context.ordersCache[0].items[0].purchaseOrderedQty,3);
    assert.equal(context.pendingPurchaseCache[0].items[0].purchaseOrderedQty,3);
    vm.runInContext("syncCommittedPurchaseOrderSources([{id:'O1',items:[{qty:5,purchaseOrderedQty:5}]}])",context);
    assert.equal(context.pendingPurchaseCache.length,0);
    assert.equal(listRenders,2);
    assert.deepEqual(writes.at(-2),['purchase-dispatch',[]]);
    assert.deepEqual(writes.at(-1),['orders',['O1']]);
});


test('order and purchasing cards use the same item-level metric calculator', () => {
    const helper = app.match(/function buildOrderItemWorkMetrics\(orders, categories, include = null\) \{[\s\S]*?\n\}/)?.[0];
    const orderCards = app.match(/function renderOrderWorkCards\(orders\) \{[\s\S]*?\n\}/)?.[0];
    const purchasingCards = app.match(/function renderPurchasingWorkCards\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(helper && orderCards && purchasingCards);
    assert.match(orderCards, /buildOrderItemWorkMetrics\(/);
    assert.match(purchasingCards, /buildOrderItemWorkMetrics\(/);
    assert.match(purchasingCards, /purchaseLineMatchesFilters\(order\.orderDate, order\.salesName, item\.brand, filters\)/);
});

test('formal PO draft opens from the loaded order before secure purchase metadata finishes loading', () => {
    const source = app.match(/window\.openOrderPurchaseDraft = async function\(orderId, itemId = ''\) \{[\s\S]*?\n\};/)?.[0];
    assert.ok(source);
    assert.match(source, /ordersCache\.find\(row => row\.id === orderId\)/);
    assert.match(source, /action\.includes\('openOrderPurchaseDraft\('/);
    const openIndex = source.indexOf("poModalOverlay').classList.add('active')");
    const preloadIndex = source.indexOf('await Promise.all([loadSupplierWarehouseMasters(), preloadPurchaseCosts([order])])');
    assert.ok(openIndex >= 0 && preloadIndex > openIndex, 'modal should be visible before purchase metadata preload completes');
    assert.match(app, /assertPurchaseLinesAvailable\(snapshot\.data\(\), poRecord\.items\.filter/);
});

test('purchase cost preload preserves already resolved costs across repeated PO opens', () => {
    const source = app.match(/async function preloadPurchaseCosts\(orders\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(source);
    assert.doesNotMatch(source, /purchaseCostCache = new Map\(\)/);
    assert.match(source, /if \(purchaseCostCache\.has\(id\)\) return;/);
});


test('new PO cannot be saved until its number is ready', () => {
    const buttonSource = app.match(/function updatePoSaveButton\(\) \{[\s\S]*?\n\}/)?.[0];
    const saveStart = app.indexOf('window.printPurchaseOrder = async function()');
    const saveEnd = app.indexOf('    if (poEditingId) {', saveStart);
    assert.ok(buttonSource && saveStart >= 0 && saveEnd > saveStart);
    assert.match(buttonSource, /waitingForNumber = !poEditingId && !poNoReady/);
    assert.match(buttonSource, /button\.disabled = poSaveInProgress \|\| waitingForNumber/);
    assert.match(app.slice(saveStart, saveEnd), /!poEditingId && !poNoReady/);
});

test('PO number generation ignores stale async results and never falls back to sequence 01 after an error', () => {
    const source = app.match(/window\.generatePoNo = async function\(\) \{[\s\S]*?\n\};/)?.[0];
    assert.ok(source);
    assert.match(source, /const generation = \+\+poNoGeneration/);
    assert.match(source, /if \(generation !== poNoGeneration\) return ''/);
    assert.match(source, /查不到目前最大流水號時不能直接假設 01/);
    assert.doesNotMatch(source, /catch \(e\)[\s\S]*?prefix\}01/);
});

test('closing or reprinting a PO invalidates any pending PO number request', () => {
    const closeSource = app.match(/window\.closePurchaseOrderModal = function\(\) \{[\s\S]*?\n\};/)?.[0];
    const reprintSource = app.match(/window\.reprintPurchaseOrder = function\(poId\) \{[\s\S]*?\n\};/)?.[0];
    assert.ok(closeSource && reprintSource);
    assert.match(closeSource, /poNoGeneration\+\+/);
    assert.match(reprintSource, /poNoGeneration\+\+/);
    assert.match(reprintSource, /poNoReady = true/);
});


test('order and purchasing sales filters use the same stable staff source', () => {
    const helper = app.match(/function workflowSalesFilterNames\(\) \{[\s\S]*?\n\}/)?.[0];
    const orderFilters = app.match(/function populatePurchaserOrderFilters\(\) \{[\s\S]*?\n\}/)?.[0];
    const purchaseFilters = app.match(/function populatePurchasingFilters\(\) \{[\s\S]*?\n\}/)?.[0];
    assert.ok(helper && orderFilters && purchaseFilters);
    assert.match(helper, /salesList\.map\(person => stripPhoneSuffix\(person\.name\)\)/);
    assert.match(orderFilters, /workflowSalesFilterNames\(\)/);
    assert.match(purchaseFilters, /workflowSalesFilterNames\(\)/);
    assert.doesNotMatch(orderFilters, /ordersCache\.map/);
    assert.match(orderFilters, /orderFilterOptionsSignature/);
});

test('purchasing workspace exposes work and history tabs with four order-derived queues', () => {
    assert.match(html, /id="purchase-tab-work"[^>]*>採購工作</);
    assert.match(html, /id="purchase-tab-history"[^>]*>全部採購單</);
    for (const id of ['purchase-card-ordering','purchase-card-receiving','purchase-card-dispatch','purchase-card-completed']) {
        assert.match(html, new RegExp(`id="${id}"`));
    }
    assert.doesNotMatch(html.match(/id="purchasePendingPanel"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '', /<th>來源訂單<\/th>/);
});

test('purchase identity fields stay editable and save-print keeps the secure transaction first', () => {
    const render = app.match(/function renderPoItemsTable\(\) \{[\s\S]*?\n\}/)?.[0] || '';
    assert.match(render, /onchange="updateDirectPoText\(\$\{idx\},'itemName'/);
    assert.match(render, /onchange="onDirectPoCodeChange\(\$\{idx\},this\.value\)"/);
    assert.match(render, /onchange="updateDirectPoText\(\$\{idx\},'brand'/);
    assert.match(app, /'🖨️ 列印 \/ 存為 PDF（自動同步雲端）'/);
    const save = app.match(/window\.printPurchaseOrder = async function\(\) \{[\s\S]*?\n\};/)?.[0] || '';
    assert.ok(save.indexOf('await commitPromise') < save.indexOf('printSavedPoDocument(poNo, vendorName)'));
});
