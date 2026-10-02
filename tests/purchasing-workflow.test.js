const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const workflow = require('../modules/workflow-core.js');
const fulfillment = require('../modules/fulfillment-core.js');
const supply = require('../modules/supply-core.js');
const receiving = require('../modules/receiving-core.js');

const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const styles = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const validationStart = app.indexOf('function assertPurchaseLinesAvailable(order, lines) {');
const validationEnd = app.indexOf('\n}\n\nfunction poPdfFileName', validationStart) + 2;
const validation = validationStart >= 0 && validationEnd > validationStart ? app.slice(validationStart, validationEnd) : '';
assert.ok(validation, 'The PO transaction must validate the live source order');
const validate = vm.runInNewContext(`${validation}\nassertPurchaseLinesAvailable`, {
    normalizedOrderStatus: order => order.status === 'cancelled' ? 'cancelled' : 'normal',
    normalizedOrderItems: order => order.items,
    remainingProcurementQty: (order, item) => workflow.procurementQuantities({
        orderedQty:item.orderedQty ?? item.qty,
        fulfillmentType:item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE',
        shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty,
        receivedQty:item.receivedQty,
        returnedQty:item.returnedQty
    }).remainingToOrderQty
});

test('purchase order action always uses the one-click print and cloud-sync label', () => {
    const start = app.indexOf('function updatePoSaveButton()');
    const end = app.indexOf('function poIncomingKey', start);
    const source = app.slice(start, end);
    assert.match(source, /📄 匯出 PDF（自動同步雲端）/);
    assert.doesNotMatch(source, /重試同步在途庫存/);
});

test('purchasing user-facing copy avoids legacy stock-order and source-order wording', () => {
    assert.doesNotMatch(html, /來源訂單日期/);
    assert.doesNotMatch(app, /原廠備貨是公司庫存採購/);
    assert.match(html, /全部採購單則依正式訂購日期查詢/);
    assert.match(html, /📄 匯出 PDF（自動同步雲端）/);
    assert.doesNotMatch(app, /確認品項、廠商與單價後再儲存|完成後即可儲存|檢查並儲存中/);
    assert.match(app, /正在同步訂購單到雲端/);
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
    assert.match(app, /function refreshPurchasingOrderCache\(reset = true, options = \{\}\)/);
    assert.match(app, /loadPendingPurchaseOrders\(true/);
    assert.match(app, /loadMyPurchaseOrders\(/);
    assert.match(app, /loadPurchasingDispatchOrders\(true/);
    assert.doesNotMatch(app, /generateNextPoNumber/);
});

test('a PO cannot exceed the remaining need even when lines split the same item', () => {
    const order = { items:[{ itemCode:'A', qty:8, shortageQty:5, supplyOrderedQty:2 }] };
    validate(order, [{orderItemIndex:0,itemCode:'A',qty:2},{orderItemIndex:0,itemCode:'A',qty:1}]);
    assert.throws(() => validate(order, [{orderItemIndex:0,itemCode:'A',qty:2},{orderItemIndex:0,itemCode:'A',qty:2}]), /待採購數量/);
    assert.throws(() => validate({...order,status:'cancelled'}, [{orderItemIndex:0,itemCode:'A',qty:1}]), /取消/);
    assert.throws(() => validate(order, [{orderItemIndex:0,itemCode:'B',qty:1}]), /品項已變更/);
});

test('PO may fill missing source identity when the stable item id still matches', () => {
    const order = { items:[{ itemId:'I1', itemCode:'', qty:3, shortageQty:3, supplyOrderedQty:0 }] };
    assert.doesNotThrow(() => validate(order, [{orderItemIndex:0,itemId:'I1',itemCode:'A-1',qty:1}]));
    assert.throws(() => validate(order, [{orderItemIndex:0,itemId:'OTHER',itemCode:'A-1',qty:1}]), /品項已變更/);
});

test('formal PO backfills only missing source product identity fields', () => {
    const start = app.indexOf('const nextItems=normalizedOrderItems(orderData).map');
    const end = app.indexOf('const nextOrderData=', start);
    const source = app.slice(start, end);
    assert.match(source, /productId:item\.productId\|\|identityLine\?\.productId\|\|''/);
    assert.match(source, /itemCode:item\.itemCode\|\|identityLine\?\.itemCode\|\|''/);
    assert.match(source, /itemName:item\.itemName\|\|identityLine\?\.itemName\|\|''/);
    assert.match(source, /brand:item\.brand\|\|resolveBrandName\(identityLine\?\.brand\|\|''\)/);
});

test('a self order reduces the quantity available to the formal PO', () => {
    const order = { items:[{ itemCode:'A', qty:8, shortageQty:5, supplyOrderedQty:4 }] };
    validate(order, [{orderItemIndex:0,itemCode:'A',qty:1}]);
    assert.throws(() => validate(order, [{orderItemIndex:0,itemCode:'A',qty:2}]), /待採購數量/);
});

test('a fully received partial PO leaves the remaining shortage available for a new PO', () => {
    const order = { items:[{ itemCode:'A', qty:10, shortageQty:3, supplyOrderedQty:4, receivedQty:4 }] };
    assert.doesNotThrow(() => validate(order, [{orderItemIndex:0,itemCode:'A',qty:3}]));
    assert.throws(() => validate(order, [{orderItemIndex:0,itemCode:'A',qty:4}]), /待採購數量/);
});

test('repeating an incoming-stock update does not count the same supply twice', async () => {
    const start = app.indexOf('async function registerPurchaseIncoming(poId, poRecord)');
    const end = app.indexOf('\nasync function cancelOutstandingSupplyRecord', start);
    assert.ok(start >= 0 && end > start);
    const source = app.slice(start, end);
    const docs = new Map([
        ['supplyOrders/S1',{productKey:'P1',productId:'P1',warehouseId:'W1',qty:3,incomingRegisteredQty:0,itemCode:'A',itemName:'產品',brand:'品牌',fulfillmentType:'WAREHOUSE'}],
        ['supplyOrders/S2',{productKey:'P2',productId:'P2',warehouseId:'W1',qty:2,incomingRegisteredQty:0,itemCode:'B',itemName:'產品二',brand:'品牌',fulfillmentType:'WAREHOUSE'}]
    ]);
    const records = [];
    let failSecondItemOnce = true;
    let sequence = 0;
    const db = {
        collection:name=>({doc:id=>({key:`${name}/${id ?? ++sequence}`})}),
        async runTransaction(callback){
            const writes=[];
            const tx={
                get:async ref=>{
                    if(ref.key==='inventory/P2'&&failSecondItemOnce){failSecondItemOnce=false;throw new Error('網路中斷');}
                    return {exists:docs.has(ref.key),data:()=>docs.get(ref.key)};
                },
                set:(ref,data,options)=>writes.push([ref,data,options]),
                update:(ref,data)=>writes.push([ref,data,{merge:true}])
            };
            await callback(tx);
            writes.forEach(([ref,data,options])=>{
                if(ref.key.startsWith('inventoryMovements/')) records.push(data);
                else docs.set(ref.key,options?.merge?{...docs.get(ref.key),...data}:data);
            });
        }
    };
    const register = vm.runInNewContext(`${source}\nregisterPurchaseIncoming`, {
        db,
        defaultWarehouse:()=>({id:'W1'}),
        warehouseStockDocId:(warehouse,key)=>`${warehouse}__${key}`,
        inventoryNumbers:data=>({onHand:Number(data.onHand||0),reserved:Number(data.reserved||0),incoming:Number(data.incoming||0)}),
        invalidateWarehouseStockCache:()=>{},
        resolveBrandName:name=>name,
        buildInventorySearchTokens:row=>[String(row.itemCode||'').toLowerCase()],
        poIncomingKey:item=>item.productId,
        currentUserName:'採購',currentUser:null
    });
    const po={supplyOrderIds:['S1','S2'],items:[
        {productId:'P1',warehouseId:'W1'},
        {productId:'P2',warehouseId:'W1'}
    ]};
    await assert.rejects(register('PO1',po),/網路中斷/);
    await register('PO1',po);
    await register('PO1',po);
    assert.equal(docs.get('inventory/P1').incoming,3);
    assert.deepEqual(docs.get('inventory/P1').searchTokens,['a']);
    assert.equal(docs.get('inventory/P2').incoming,2);
    assert.deepEqual(docs.get('inventory/P2').searchTokens,['b']);
    assert.equal(docs.get('warehouseStocks/W1__P1').incoming,3);
    assert.equal(docs.get('supplyOrders/S1').incomingRegisteredQty,3);
    assert.equal(docs.get('supplyOrders/S2').incomingRegisteredQty,2);
    assert.equal([...docs.keys()].some(key=>key.startsWith('pendingInventoryItems/')),false);
    assert.equal(records.length,2);
});


test('saved PO keeps one-click print behavior while repairing pending incoming sync', async () => {
    const start = app.indexOf('window.printPurchaseOrder = async function()');
    const end = app.indexOf('    if (poItems.length === 0)', start);
    assert.ok(start >= 0 && end > start);
    const button = { disabled:false, innerText:'🖨️ 列印 / 存為 PDF（自動同步雲端）' };
    const savedPo = { id:'PO1', poNo:'PO1', vendorName:'供應商' };
    let releaseRegistration;
    let registrationCalls = 0;
    let printCalls = 0;
    const messages = [];
    const context = vm.createContext({
        window:{}, poEditingId:'PO1', poListCache:[savedPo],
        canCreatePurchaseOrderCapability:()=>true, canAccessPage:()=>true,
        document:{getElementById:()=>button},
        registerPurchaseIncoming:async () => { registrationCalls++; await new Promise(resolve => { releaseRegistration=resolve; }); },
        printSavedPoDocument:()=>{printCalls++;}, updatePoSaveStatus:message=>messages.push(message),
        updatePoSaveButton:()=>{button.innerText='🖨️ 列印 / 存為 PDF（自動同步雲端）';}, alert:message=>messages.push(message)
    });
    vm.runInContext(`let poSaveInProgress=false; let poIncomingSyncPending=false;\n${app.slice(start,end)}\n}`, context);

    await context.window.printPurchaseOrder();
    assert.equal(printCalls, 1);
    assert.equal(registrationCalls, 0);

    vm.runInContext('poIncomingSyncPending=true', context);
    const pendingPrint = context.window.printPurchaseOrder();
    assert.equal(button.disabled, true);
    assert.match(button.innerText, /同步雲端後開啟列印/);
    await context.window.printPurchaseOrder();
    assert.equal(registrationCalls, 1, 'double tap while syncing must not start another sync');
    releaseRegistration();
    await pendingPrint;
    assert.equal(printCalls, 2, 'successful repair should continue directly to print');
    assert.equal(button.disabled, false);
    assert.match(messages.at(-1), /正在產生 PDF/);

    vm.runInContext('poIncomingSyncPending=true', context);
    context.registerPurchaseIncoming = async () => { throw new Error('網路中斷'); };
    await context.window.printPurchaseOrder();
    assert.equal(printCalls, 2, 'failed sync must not silently print an unsynchronized PO');
    assert.equal(button.disabled, false);
    assert.match(messages.at(-1), /在途庫存同步仍未完成.*網路中斷/);
});

test('PO PDF export starts from the user action without browser print', () => {
    const start = app.indexOf('async function printSavedPoDocument(poNo, vendorName)');
    const end = app.indexOf('\n}\n\nwindow.printPurchaseOrder', start) + 2;
    const source = app.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(source, /createPoPdfStage\(\)/);
    assert.match(source, /paginatePoPdfDocument/);
    assert.match(source, /addDocumentPagesToPdf/);
    assert.match(source, /const fileName=poPdfFileName\(poNo, vendorName\)/);
    assert.match(source, /pdf\.save\(fileName\)/);
    assert.doesNotMatch(source, /window\.print\(/);
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

test('PO PDF normalizes form fields and paginates rows while keeping totals together', () => {
    const normalize = app.match(/function normalizePoPdfFields\(root\) \{[\s\S]*?\n\}/)?.[0];
    const paginateStart = app.indexOf('function paginatePoPdfDocument(stage, source)');
    const paginateEnd = app.indexOf('\n}\n\nasync function printSavedPoDocument', paginateStart) + 2;
    const paginate = app.slice(paginateStart, paginateEnd);
    assert.ok(normalize);
    assert.match(normalize, /querySelectorAll\('input'\)/);
    assert.match(normalize, /po-pdf-field-value/);
    assert.match(paginate, /source\.querySelector\('\.po-total-section'\)/);
    assert.match(paginate, /current\.page\.scrollHeight > maxHeight/);
    assert.match(paginate, /finalPage\.page\.appendChild\(summaryClone\)/);
    assert.match(html, /class="po-total-section"/);
});


test('order work cards and filters use item-level work states', () => {
    assert.match(app, /function orderItemWorkCategory\(order, item, lifecycleOverride = null, dispatchOverride = null\)/);
    assert.match(app, /function orderItemDisplayCategories\(order, item, lifecycleOverride = null, dispatchOverride = null\)/);
    assert.match(app, /function buildOrderItemWorkMetrics\(orders, categories, include = null, normalizedItemsByOrder = null, dispatchStatesByOrder = null, lifecyclesByOrder = null\)/);
    assert.match(app, /orderItemDisplayCategories\(order,item,lifecycle,dispatch\)\.forEach/);
    assert.match(app, /metrics\[category\]\.count\+\+/);
    assert.match(app, /\(displayCategoriesByItem\.get\(item\) \|\| \[\]\)\.includes\(activeOrderWorkFilter\)/);
    assert.match(app, /const primaryStatus=displayCategories\[0\]\|\|'ordering'/);
    assert.match(app, /訂單狀態：<span class="order-progress-badge">/);
    assert.match(app, /function pendingProcurementDisplayLines\(order, normalizedItems = null, dispatchStateByItem = null, lifecycleOverride = null\)/);
    assert.match(app, /orderItemWorkCategory\(order, item, lifecycle, dispatch\) !== 'ordering'/);
    assert.match(app, /\['dispatch', '待打單'\]/);
    assert.match(app, /\['shipping', '待出貨'\]/);
    assert.match(app, /return YushinWorkflow\.itemWorkCategory\(input\);/);
});

test('item dispatch state delegates quantity math to fulfillment core', () => {
    const start = app.indexOf('function itemDispatchState(order, item)');
    const end = app.indexOf('\nfunction orderContextActionState', start);
    const source = app.slice(start, end);
    assert.match(source, /YushinFulfillment\?\.dispatchState/);
    assert.doesNotMatch(source, /const preparedOutstanding=Math\.max/);
});

test('stock order shows dispatch, shipping, billing and complete as work advances', () => {
    const dispatchStart = app.indexOf('function itemDispatchState(order, item)');
    const dispatchEnd = app.indexOf('\nfunction orderContextActionState', dispatchStart);
    const categoryStart = app.indexOf('function orderItemWorkCategory(');
    const categoryEnd = app.indexOf('\nfunction orderWorkIndexFields', categoryStart);
    assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart && categoryStart >= 0 && categoryEnd > categoryStart);
    const source = app.slice(dispatchStart, dispatchEnd) + '\n' + app.slice(categoryStart, categoryEnd);
    const ctx = vm.createContext({
        normalizedOrderItems:order=>order.items,
        savedDeliveryRecords:order=>order.deliveryRecords||[],
        savedReturnRecords:()=>[],
        orderLifecycleInfo:()=>({status:'normal',returned:0,effectiveDelivered:0}),
        YushinWorkflow:workflow,YushinFulfillment:fulfillment,
        window:{YushinFulfillment:fulfillment}
    });
    vm.runInContext(source,ctx);
    const order={items:[{itemId:'I1',qty:3,orderedQty:3,shortageQty:0,
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
    const dispatchStart = app.indexOf('function itemDispatchState(order, item)');
    const dispatchEnd = app.indexOf('\nfunction orderContextActionState', dispatchStart);
    const categoryStart = app.indexOf('function orderItemWorkCategory(');
    const categoryEnd = app.indexOf('\nfunction orderWorkIndexFields', categoryStart);
    assert.ok(dispatchStart >= 0 && dispatchEnd > dispatchStart && categoryStart >= 0 && categoryEnd > categoryStart);
    const source = app.slice(dispatchStart, dispatchEnd) + '\n' + app.slice(categoryStart, categoryEnd);
    const context = vm.createContext({
        normalizedOrderItems:order=>order.items,
        savedDeliveryRecords:()=>[],savedReturnRecords:()=>[],
        orderLifecycleInfo:()=>({status:'normal',returned:0,effectiveDelivered:0}),
        YushinWorkflow:workflow,YushinFulfillment:fulfillment,
        window:{YushinFulfillment:fulfillment}
    });
    vm.runInContext(source,context);
    const order={items:[{itemId:'I1',qty:10,orderedQty:10,shortageQty:5,
        fulfillmentType:'WAREHOUSE',reservedQty:5,dispatchPreparedQty:0}]};
    const item=order.items[0];
    assert.equal(context.orderItemWorkCategory(order,item),'ordering');
    assert.deepEqual(Array.from(context.orderItemDisplayCategories(order,item)),['ordering','dispatch']);
    assert.deepEqual(Array.from(context.orderWorkCategories(order)),['ordering','dispatch']);
    item.dispatchPreparedQty=5;
    assert.deepEqual(Array.from(context.orderWorkCategories(order)),['ordering']);
    item.supplyOrderedQty=5;
    assert.equal(context.orderItemWorkCategory(order,item),'arrival');
    assert.deepEqual(Array.from(context.orderItemDisplayCategories(order,item)),['arrival']);
});

test('purchasing completed card is not capped by the visible 50-row page', () => {
    const start = app.indexOf('function renderPurchasingWorkCards(');
    const end = app.indexOf('\nfunction purchasingCompletedRows(', start);
    const source = app.slice(start, end);
    assert.match(source, /const completed = completedRows \|\| purchasingCompletedRows\(filters, itemMap, stateMap, lifecycleMap\)/);
    assert.doesNotMatch(source, /visiblePurchasingCompletedRows\(/);
});

test('purchasing completed starts at 50 rows and supports loading more', () => {
    assert.match(html, /id="purchaseCompletedMoreBtn"/);
    assert.match(app, /let purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT/);
    assert.match(app, /window\.loadMorePurchasingCompleted = async function\(\)/);
    assert.match(app, /purchasingCompletedVisibleLimit \+= DEFAULT_LIST_LIMIT/);
    assert.match(app, /await loadPurchasingDispatchOrders\(false\)/);
});

test('purchasing completed excludes unresolved procurement and includes direct ship after arrival', () => {
    const start = app.indexOf('function purchasingCompletedRows(');
    const end = app.indexOf('\nfunction renderPurchasingCompletedOrders(', start);
    const source = app.slice(start, end);
    assert.match(source, /const category = orderItemWorkCategory\(order, item, lifecycle, state\)/);
    assert.match(source, /\['ordering', 'arrival', 'closed'\]\.includes\(category\)/);
    assert.match(source, /const directShip = \(item\.fulfillmentType \|\| order\.fulfillmentType \|\| 'WAREHOUSE'\) === 'DIRECT_SHIP'/);
    assert.match(source, /if \(!directShip &&/);
    assert.match(source, /return rows;/);
});

test('receiving work list renders one row per order item and keeps PO records in history only', () => {
    assert.match(html, /id="poListHeadRow"/);
    const receivingStart=app.indexOf('function renderPurchasingReceivingWorkList(');
    const receivingEnd=app.indexOf('\nwindow.renderPoList',receivingStart);
    const receiving=app.slice(receivingStart,receivingEnd);
    assert.match(receiving, /ordersCache\.forEach\(order =>/);
    assert.match(receiving, /orderItemDisplayCategories\(order, item, lifecycle, dispatch\)\.includes\('arrival'\)/);
    assert.match(receiving, /const evidence = receivingEvidenceForWorkItem\(order, item, itemIndex, evidenceIndex\)/);
    assert.match(receiving, /已合併在同一品項顯示/);

    const renderStart = app.indexOf('window.renderPoList = function(');
    const renderSource = app.slice(renderStart, app.indexOf('// 把「採購訂單」', renderStart));
    assert.match(renderSource, /if \(purchasingView === 'receiving'\) \{[\s\S]*?renderPurchasingReceivingWorkList\(normalizedItemsByOrder, filterContext, dispatchStatesByOrder, lifecyclesByOrder\);[\s\S]*?return;/);
    assert.match(renderSource, /const poRows = poHistorySearchActive \? poHistorySearchResults : poListCache/);
});

test('receiving evidence uses supplyOrders as the only procurement source', () => {
    const start=app.indexOf('function receivingEvidenceEntry(');
    const end=app.indexOf('\nfunction receivingWorkProgress',start);
    const source=app.slice(start,end);
    assert.match(source,/type:'supply'/);
    assert.match(source,/supplyReceivingCache\.forEach\(supply =>/);
    assert.match(source,/function buildReceivingEvidenceIndex\(\)/);
    assert.match(source,/function receivingEvidenceForWorkItem\(order, item, itemIndex, evidenceIndex = null\)/);
    assert.doesNotMatch(source,/purchaseOrders|poListCache/);
});

test('receiving waits for both order work state and purchase evidence before declaring empty', () => {
    const queueStart=app.indexOf('function loadPurchasingReceivingQueue(');
    const queueEnd=app.indexOf('\nlet purchasingFilterOptionsSignature',queueStart);
    const queue=app.slice(queueStart,queueEnd);
    assert.match(queue,/Promise\.allSettled\(\[[\s\S]*?loadPurchaseOrderPage\(reset, \{ deferRender:true \}\)[\s\S]*?refreshPurchasingOrderCache\(reset, options\)/);
    assert.match(queue,/mergeReceivingSourceOrdersIntoOrderCache\(\)/);
    assert.match(queue,/renderPurchasingView\(\)/);
    assert.match(app,/採購資料載入中/);
    assert.match(app,/尚未找到可操作的採購紀錄/);
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

test('formal PO creates authoritative supplyOrders before saving the document snapshot', () => {
    const printStart = app.indexOf('window.printPurchaseOrder = async function()');
    const printEnd = app.indexOf("window.addEventListener('afterprint'", printStart);
    const printSource = app.slice(printStart, printEnd);
    const transactionStart = printSource.indexOf('const commitPromise = db.runTransaction');
    const transactionEnd = printSource.indexOf('await commitPromise');
    const coreTransaction = printSource.slice(transactionStart, transactionEnd);
    assert.match(coreTransaction, /db\.collection\('supplyOrders'\)\.doc\(supplyId\)/);
    assert.match(coreTransaction, /type:item\.orderId\?'PURCHASING_PO':'STOCK_REPLENISHMENT'/);
    assert.match(coreTransaction, /purchaseDocumentId:poDocumentId/);
    assert.match(coreTransaction, /poRecord\.supplyOrderIds=supplyOrderIds/);
    assert.match(coreTransaction, /supplyOrderedQty:cumulative/);
    assert.doesNotMatch(coreTransaction, /purchaseOrderedQty:cumulative/);
    assert.ok(printSource.indexOf('await commitPromise') < printSource.indexOf('printSavedPoDocument(poNo, vendorName)'));
});

test('purchase receiving queue calculates progress from supply orders only',()=>{
    assert.match(app,/function receivingEvidenceForWorkItem\(order, item, itemIndex, evidenceIndex = null\)/);
    assert.match(app,/supplyReceivingCache\.forEach\(supply =>/);
    assert.match(app,/openSupplyReceipt\('\$\{escapeAttr\(entry\.id\)\}'\)/);
    assert.doesNotMatch(app,/receivePurchaseOrderItem/);
    assert.doesNotMatch(app,/poItemReceiptProgress/);
});

test('supply receipt synchronizes received quantity back to the source order item through receiving core',()=>{
    const start=app.indexOf('async function receiveSupplyOrderRecord');
    const end=app.indexOf('window.openSupplyReceipt',start);
    const source=app.slice(start,end);
    assert.match(source,/const receiptPlan=window\.YushinReceiving\.applyReceiptToOrderItem\(\{\.\.\.item,reservedQty:currentReserved\},qty\)/);
    assert.match(source,/const currentReserved=Math\.max\(0,Number\(reservation\.quantity\|\|0\)\)/);
    assert.match(source,/const next=receiptPlan\.item/);
    assert.match(source,/reserveQty=receiptPlan\.reservedDelta/);
    assert.match(source,/items\[itemIndex\]=\{\.\.\.next,reservedQty:next\.reservedQty\}/);
    assert.match(source,/orderWorkIndexFields\(nextOrder\)/);
    assert.match(source,/window\.YushinReceiving\.applyReceipt\(supply,qty\)/);
});


test('self-order receipt uses receiving core receivedQty without adding it twice',()=>{
    assert.match(app,/const receiptPlan=window\.YushinReceiving\.applyReceiptToOrderItem\(\{\.\.\.item,reservedQty:currentReserved\},qty\);/);
    assert.match(app,/const next=receiptPlan\.item/);
    assert.match(app,/if\(!reservationSnap\.exists\)throw new Error\('來源訂單缺少庫存占用紀錄/);
    assert.doesNotMatch(app,/\{\.\.\.next,receivedQty:Number\(item\.receivedQty\|\|0\)\+qty/);
});


test('self-order receipt keeps reservation from fulfillment core without adding reserveQty twice',()=>{
    assert.match(app,/items\[itemIndex\]=\{\.\.\.next,reservedQty:next\.reservedQty\}/);
    assert.doesNotMatch(app,/items\[itemIndex\]=\{\.\.\.next,reservedQty:next\.reservedQty,inventoryReservedQty:/);
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
    assert.match(app,/const nextOrder=\{\.\.\.order,items,itemCount:items\.length[\s\S]*?\.\.\.orderWorkIndexFields\(nextOrder\)/);
});


test('order lifecycle, delivery and return mutations refresh work category index',()=>{
    assert.match(app,/Object\.assign\(updates,orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)\);/);
    const deliverySync=(app.match(/orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)[\s\S]{0,160}deliveryHistory/g)||[]).length;
    const returnSync=(app.match(/orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)[\s\S]{0,160}returnHistory/g)||[]).length;
    assert.ok(deliverySync>=3,'all delivery mutation paths should refresh the work index');
    assert.ok(returnSync>=2,'all return mutation paths should refresh the work index');
});


test('purchasing work cards reuse the shared recent order cache',()=>{
    assert.match(app,/function refreshPurchasingOrderCache\(reset = true, options = \{\}\)/);
    assert.match(app,/if \(options\.reuseOrders && purchasingOrdersReady\) return Promise\.resolve\(ordersCache\)/);
    assert.match(app,/pendingPurchaseCache = ordersCache\.filter\(order =>/);
    assert.match(app,/pendingProcurementDisplayLines\([\s\S]*?normalizedItemsByOrder\.get\(order\.id\)/);
    assert.match(app,/purchasingDispatchCache = ordersCache\.filter\(order =>/);
    assert.doesNotMatch(app,/where\('workCategories',\s*'array-contains',\s*'ordering'\)/);
    assert.doesNotMatch(app,/where\('workCategories','array-contains','dispatch'\)/);
    assert.match(app,/supplyOrders'\)\.where\('status','in',\['ORDERED','PARTIAL_RECEIPT'\]\)/);
});

test('shortage allocation trusts warehouse stock even when aggregate inventory cache is missing',()=>{
    const start=app.indexOf('async function allocateFreeReceiptStockToShortages');
    const end=app.indexOf('\nasync function refreshAffectedOrderCaches',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/if\(!orderSnap\.exists\|\|!resSnap\.exists\|\|!whSnap\.exists\)/);
    assert.doesNotMatch(source,/!invSnap\.exists\|\|!whSnap\.exists/);
    assert.match(source,/inventoryNumbers\(invSnap\.exists\?invSnap\.data\(\):\{\}\)/);
    assert.match(source,/if\(invSnap\.exists\)tx\.update\(invRef/);
});

test('shortage allocation maintains work indexes',()=>{
    assert.match(app,/allocateFreeReceiptStockToShortages[\s\S]*?orderWorkIndexFields\(nextOrder\)/);
});


test('quote cancellation and legacy delivery cleanup refresh work category index',()=>{
    assert.match(app,/const cancelledOrder = \{\.\.\.order,status:'cancelled'[\s\S]*?orderWorkIndexFields\(cancelledOrder\)/);
    assert.match(app,/clearLegacyDelivery[\s\S]*?Object\.assign\(updates,orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)\)/);
});

test('receiving queue reads every open supply type and follows the source order arrival state',()=>{
    const pageStart=app.indexOf('async function loadPurchaseOrderPage(');
    const pageEnd=app.indexOf('\nwindow.loadMyPurchaseOrders',pageStart);
    const page=app.slice(pageStart,pageEnd);
    assert.match(page,/const freshSupply=supplySnapshot\.docs\.map\(doc=>\(\{id:doc\.id,\.\.\.doc\.data\(\)\}\)\)/);
    assert.doesNotMatch(page,/freshSupply=supplySnapshot\.docs[\s\S]{0,180}filter\(row=>row\.type/);
    assert.match(page,/db\.collection\('supplyOrders'\)\.where\('status','in',\['ORDERED','PARTIAL_RECEIPT'\]\)/);
    assert.match(page,/receivingSourceOrderCache=nextSourceOrders/);

    const listStart=app.indexOf('function renderPurchasingReceivingWorkList(');
    const listEnd=app.indexOf('\nwindow.renderPoList',listStart);
    const list=app.slice(listStart,listEnd);
    assert.match(list,/orderItemDisplayCategories\(order, item, lifecycle, dispatch\)\.includes\('arrival'\)/);
    assert.match(list,/supplyReceivingCache\.forEach\(supply =>/);
});

test('manual ordered action records supply and source item only once after an uncertain response', async () => {
    const source = app.match(/const pendingPurchaseOrderKeys = new Set\(\);[\s\S]*?\n(?=window\.openOrderPurchaseDraft)/)?.[0];
    assert.ok(source);
    const order = {items:[{itemId:'I1',itemCode:'P1',itemName:'Product',qty:2,
        productId:'P1',supplier:'Vendor',costPrice:100,warehouseId:'W1',fulfillmentType:'DIRECT_SHIP',
        procurementType:'PURCHASING_PO',supplyOrderedQty:0,shortageQty:2}],orderNo:'O1'};
    let supply, updates = 0;
    const orderRef = {kind:'order'}, supplyRef = {kind:'supply',id:'manual-O1-I1'};
    const button={disabled:false,textContent:'已訂購',isConnected:false};
    const page={classList:{contains:()=>true}},card={};
    const switched=[];
    const context = vm.createContext({
        window:{},YushinReceiving:receiving,document:{getElementById:id=>id==='purchasing-system'?page:id==='purchase-card-receiving'?card:null},
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
        remainingProcurementQty:(record,item)=>Math.max(0,2-Number(item.supplyOrderedQty||0)),
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
        productId:'P1',supplier:'Vendor',costPrice:100,warehouseId:'W1',fulfillmentType:'DIRECT_SHIP',
        procurementType:'PURCHASING_PO',supplyOrderedQty:0,receivedQty:0,shortageQty:2}],orderNo:'O1'};
    let supply, updates = 0;
    const orderRef = {kind:'order'}, supplyRef = {kind:'supply',id:'manual-O1-I1'};
    const button={disabled:false,textContent:'已訂購',isConnected:false};
    const context = vm.createContext({
        window:{},YushinReceiving:receiving,document:{getElementById:()=>null},
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
            const ordered=Number(item.supplyOrderedQty||0);
            const received=Number(item.receivedQty||0);
            return Math.max(0,Number(item.shortageQty||0)-Math.max(0,ordered-received));
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
    order.items[0].shortageQty=5;
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(supply.qty,5,'new uncovered shortage is added to the existing manual supply');
    assert.equal(supply.orderEvents.length,2);
    assert.equal(order.items[0].supplyOrderedQty,5);
    assert.equal(updates,2);
});

test('ordered action is a direct snapshot-based state change without a data-entry modal or product lookup', () => {
    const actionStart=app.indexOf('function renderPendingPurchaseOrders(');
    const actionEnd=app.indexOf('\nwindow.loadPendingPurchaseOrders',actionStart);
    const actionSource=app.slice(actionStart,actionEnd);
    const saveStart=app.indexOf('window.markPurchaseItemOrdered = async function');
    const saveEnd=app.indexOf('\nwindow.openOrderPurchaseDraft',saveStart);
    const saveSource=app.slice(saveStart,saveEnd);
    assert.ok(actionStart>=0 && actionEnd>actionStart && saveStart>=0 && saveEnd>saveStart);
    assert.match(actionSource, /markPurchaseItemOrdered[\s\S]*?>已訂購<\/button>/);
    assert.match(saveSource, /switchPurchasingView\('receiving', document\.getElementById\('purchase-card-receiving'\)\)/);
    assert.match(saveSource, /remainingProcurementQty\(order, item\)/);
    assert.doesNotMatch(saveSource, /findProduct|preloadPurchaseCosts|loadSupplierWarehouseMasters|supplierForProduct/);
    assert.doesNotMatch(html, /id="manualPurchaseOverlay"/);
    assert.doesNotMatch(app, /printSupplyOrderDocument/);
});

test('loading another receiving page retains source status for earlier supply rows', () => {
    const start=app.indexOf('async function loadPurchaseOrderPage(');
    const end=app.indexOf('\nwindow.loadMyPurchaseOrders',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/const nextSourceStatuses=reset\?new Map\(\):new Map\(receivingSourceOrderStatusCache\)/);
    assert.match(source,/const nextSourceOrders=reset\?new Map\(\):new Map\(receivingSourceOrderCache\)/);
    assert.match(source,/freshSupply\.map\(row=>row\.orderId\)\.filter\(Boolean\)/);
    assert.match(source,/nextSourceOrders\.set\(doc\.id,sourceOrder\)/);
    assert.match(source,/receivingSourceOrderStatusCache=nextSourceStatuses/);
    assert.match(source,/receivingSourceOrderCache=nextSourceOrders/);
});

test('pending purchasing work loads one shared order page at a time without losing older rows', () => {
    const refreshStart=app.indexOf('function refreshPurchasingOrderCache(');
    const refreshEnd=app.indexOf('\nfunction loadPurchasingReceivingQueue',refreshStart);
    const refresh=app.slice(refreshStart,refreshEnd);
    const start=app.indexOf('window.loadPendingPurchaseOrders = async function');
    const end=app.indexOf('\nconst pendingPurchaseOrderKeys',start);
    const source=app.slice(start,end);
    assert.ok(refreshStart>=0&&refreshEnd>refreshStart&&start>=0&&end>start);
    assert.match(refresh,/if \(purchasingOrderRefreshPromise\) return purchasingOrderRefreshPromise/);
    assert.match(refresh,/loadOrderPage\(reset, \{ silent: true, skipRender: true \}\)/);
    assert.match(source,/await refreshPurchasingOrderCache\(reset, options\)/);
    assert.match(source,/pendingPurchaseCache = ordersCache\.filter/);
    assert.match(source,/pendingPurchaseHasMore = !!orderPaginationState/);
});

test('pending purchasing work reports a shared order-load failure without overwriting the card count', () => {
    const start=app.indexOf('window.loadPendingPurchaseOrders = async function');
    const end=app.indexOf('\nconst pendingPurchaseOrderKeys',start);
    const source=app.slice(start,end);
    const renderStart=app.indexOf('function renderPendingPurchaseOrders(');
    const renderEnd=app.indexOf('\nwindow.loadPendingPurchaseOrders',renderStart);
    const renderSource=app.slice(renderStart,renderEnd);
    assert.ok(start>=0&&end>start&&renderStart>=0&&renderEnd>renderStart);
    assert.match(source,/catch \(err\) \{[\s\S]*?pendingPurchaseError = `待採購清單讀取失敗/);
    assert.match(source,/finally \{[\s\S]*?renderPendingPurchaseOrders\(/);
    assert.doesNotMatch(renderSource,/purchaseCountOrdering/);
});

test('cancelled source is excluded from the order-aligned receiving queue', () => {
    const listStart=app.indexOf('function renderPurchasingReceivingWorkList(');
    const listEnd=app.indexOf('\nwindow.renderPoList',listStart);
    const list=app.slice(listStart,listEnd);
    assert.match(list,/const lifecycle = lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo\(order, items\)/);
    assert.match(list,/if \(lifecycle\.status !== 'normal'\) return/);
    assert.match(list,/來源訂單已取消，直送不可確認/);

    const start=app.indexOf('async function receiveSupplyOrderRecord');
    const end=app.indexOf('window.openSupplyReceipt',start);
    assert.match(app.slice(start,end),/來源訂單已取消，不能繼續確認到貨/);
});

test('direct-ship receipt writes the same authoritative delivery records used by order progress', () => {
    const start=app.indexOf('async function receiveSupplyOrderRecord');
    const end=app.indexOf('const productKey=supply.productKey',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/id:`direct-\$\{operationKey\}`/);
    assert.match(source,/deliveryRecords=\[\.\.\.savedDeliveryRecords\(order\),deliveryRecord\]/);
    assert.match(source,/deliveredQty:grossDelivered/);
    assert.match(source,/isDelivered:Math\.max\(0,grossDelivered-returned\)>=total&&total>0/);
    assert.match(source,/orderWorkIndexFields\(nextOrder\)/);
});

test('cancelled warehouse source still receives into free stock while direct ship stays blocked', () => {
    const start=app.indexOf('async function receiveSupplyOrderRecord');
    const end=app.indexOf('window.openSupplyReceipt',start);
    const source=app.slice(start,end);
    const directStart=source.indexOf('if(directShip){');
    const warehouseStart=source.indexOf("const productKey=supply.productKey", directStart);
    const registeredStart=source.indexOf('const registeredIncoming=', warehouseStart);
    assert.ok(directStart>=0&&warehouseStart>directStart&&registeredStart>warehouseStart);
    assert.match(source.slice(directStart,warehouseStart),/來源訂單已取消，不能繼續確認到貨/);
    const warehouseSource=source.slice(warehouseStart,registeredStart);
    assert.match(warehouseSource,/sourceOrderStatus=normalizedOrderStatus\(order\)/);
    assert.match(warehouseSource,/if\(sourceOrderStatus==='normal'\)\{/);
    assert.match(warehouseSource,/const receiptPlan=window\.YushinReceiving\.applyReceiptToOrderItem\(\{\.\.\.item,reservedQty:0\},qty\)/);
    assert.match(warehouseSource,/items\[itemIndex\]=\{\.\.\.item,receivedQty:receiptPlan\.item\.receivedQty\}/);
    assert.match(warehouseSource,/orderWorkIndexFields\(nextOrder\)/);
    assert.doesNotMatch(warehouseSource,/來源訂單已取消，不能繼續確認到貨/);
    assert.match(source,/orderId:supply\.orderId\|\|'',itemId:supply\.itemId\|\|'',sourceOrderStatus,[\s\S]*?productKey,warehouseId,qty/);
});

test('receiving card counts standalone stock replenishment and does not hide it by salesperson', () => {
    const start=app.indexOf('function standaloneReceivingSupplyMetrics');
    const end=app.indexOf('\nfunction renderPurchasingWorkCards',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    let seenFilters=null;
    const context=vm.createContext({
        supplyReceivingCache:[
            {id:'stock-1',type:'STOCK_REPLENISHMENT',status:'ORDERED',orderId:'',fulfillmentType:'WAREHOUSE',qty:10,receivedQty:2,unitCost:100,brand:'Beckman',orderDate:'2026-10-02'},
            {id:'linked-1',type:'PURCHASING_PO',status:'ORDERED',orderId:'O1',fulfillmentType:'WAREHOUSE',qty:5,receivedQty:0,unitCost:200,brand:'Beckman',orderDate:'2026-10-02'},
            {id:'done-1',type:'STOCK_REPLENISHMENT',status:'RECEIVED',orderId:'',fulfillmentType:'WAREHOUSE',qty:3,receivedQty:3,unitCost:300,brand:'Beckman',orderDate:'2026-10-02'}
        ],
        purchaseFilterContext:()=>({start:'',end:'',selectedSales:'Sales A',selectedBrand:'',selectableBrands:['Beckman']}),
        purchaseLineMatchesFilters:(date,sales,brand,filters)=>{seenFilters=filters;return true;},
        YushinReceiving:receiving,
        window:{YushinReceiving:receiving}
    });
    vm.runInContext(source,context);
    const result=context.standaloneReceivingSupplyMetrics();
    assert.deepEqual(JSON.parse(JSON.stringify(result)),{count:1,amount:800});
    assert.equal(seenFilters.selectedSales,'');
    const cardsStart=app.indexOf('function renderPurchasingWorkCards');
    const cardsEnd=app.indexOf('\nfunction purchasingCompletedRows',cardsStart);
    const cards=app.slice(cardsStart,cardsEnd);
    assert.match(cards,/const standaloneReceiving = standaloneReceivingSupplyMetrics\(filters\)/);
    assert.match(cards,/metrics\[category\]\.count \+ extraCount/);
    assert.match(cards,/metrics\[category\]\.amount \+ extraAmount/);
});

test('formal purchase order commit immediately hydrates the receiving supply cache', () => {
    const start=app.indexOf('window.printPurchaseOrder = async function');
    const end=app.indexOf('\n// 「製作下一張估價單」',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/let committedSupplyOrders = \[\]/);
    assert.match(source,/committedSupplyOrders = \[\]/);
    assert.match(source,/committedSupplyOrders\.push\(\{id:supplyId,\.\.\.supplyRecord\}\)/);
    assert.match(source,/const supplyMap = new Map\(supplyReceivingCache\.map/);
    assert.match(source,/committedSupplyOrders\.forEach\(row => supplyMap\.set\(row\.id, row\)\)/);
    assert.match(source,/supplyReceivingCache = \[\.\.\.supplyMap\.values\(\)\]/);
});

test('receiving queue keeps standalone stock and cancelled-order warehouse supplies visible', () => {
    const start=app.indexOf('function renderPurchasingReceivingWorkList(');
    const end=app.indexOf('\nwindow.renderPoList',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/const representedSupplyIds = new Set\(\)/);
    assert.match(source,/supplyReceivingCache\.forEach\(supply =>/);
    assert.match(source,/來源訂單已取消，貨到後轉為可用庫存/);
    assert.match(source,/庫存補貨／非正常訂單供應/);
    assert.match(source,/來源訂單已取消，直送不可確認/);
    assert.match(source,/openSupplyReceipt\('/);
});

test('supply receipt retries are idempotent by operation id', () => {
    const start=app.indexOf('async function receiveSupplyOrderRecord');
    const end=app.indexOf('window.openSupplyReceipt',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/operationKey=String\(operationId\|\|''\)\.trim\(\)/);
    assert.match(source,/const receiptRef=db\.collection\('receipts'\)\.doc\(operationKey\)/);
    assert.match(source,/const receiptSnap=await tx\.get\(receiptRef\)/);
    assert.match(source,/if\(receiptSnap\.exists\)\{/);
    assert.match(source,/alreadyProcessed=true/);
    assert.match(source,/processedReceipt=receipt/);
    assert.match(source,/if\(alreadyProcessed\)\{[\s\S]*?autoAllocationQty/);
    assert.match(source,/where\('receiptId','==',operationKey\)/);
    assert.match(source,/operationId:operationKey/);

    const saveStart=app.indexOf('window.savePoReceiptBatch = async function()');
    const saveEnd=app.indexOf('\nfunction purchaseItemsFromSavedPo',saveStart);
    const save=app.slice(saveStart,saveEnd);
    assert.match(save,/operationBase=poReceiptOperationId\|\|ensureReceiptOperationId\(supplyId\)/);
    assert.match(save,/receiveSupplyOrderRecord\(supplyId,entry\.qty,entry\.lotNo,entry\.expiryDate,operationId\)/);
    assert.match(save,/clearReceiptOperationId\(supplyId\)/);
});

test('multi-item returns require and use an explicit return item selector', () => {
    assert.match(html,/id="returnItemId"/);
    assert.match(html,/onchange="updateReturnFormHint\(\)"/);
    const resetStart=app.indexOf('function returnItemDeliveredQty');
    const saveStart=app.indexOf('window.saveReturnRecord = async function');
    const saveEnd=app.indexOf('window.deleteReturnRecord',saveStart);
    const source=app.slice(resetStart,saveEnd);
    assert.match(source,/populateReturnItemOptions/);
    assert.match(source,/updateReturnFormHint/);
    assert.match(source,/document\.getElementById\('returnItemId'\)\?\.value/);
    assert.match(source,/returnItemReturnedQty/);
});

test('delivery writes keep isDelivered based on net delivered quantity', () => {
    const quickStart=app.indexOf('window.quickCompleteDelivery = async function');
    const quickEnd=app.indexOf('window.quickCancelAllDelivery',quickStart);
    const quick=app.slice(quickStart,quickEnd);
    assert.match(quick,/const alreadyReturned = returnedQuantity\(order\)/);
    assert.match(quick,/const effectiveDelivered = Math\.max\(0, alreadyDelivered - alreadyReturned\)/);
    assert.match(quick,/isDelivered: effectiveAfterDelivery >= total/);

    const saveStart=app.indexOf('window.saveDeliveryRecord = async function');
    const saveEnd=app.indexOf('window.deleteDeliveryRecord',saveStart);
    const save=app.slice(saveStart,saveEnd);
    assert.match(save,/isDelivered: effectiveTotalDelivered >= total/);

    const returnStart=app.indexOf('window.saveReturnRecord = async function');
    const returnEnd=app.indexOf('window.deleteReturnRecord',returnStart);
    const returns=app.slice(returnStart,returnEnd);
    assert.match(returns,/isDelivered:effectiveDelivered>=orderQuantity\(order\)&&orderQuantity\(order\)>0/);
});

test('direct-ship returns create replacement supply demand', () => {
    const workflow=require('../modules/workflow-core.js');
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal',
        returnedQty:2,
        effectiveDeliveredQty:8,
        orderedQty:10,
        deliveredQty:8,
        fulfillmentType:'DIRECT_SHIP',
        supplyOrderedQty:10,
        receivedQty:10,
        isBilled:false
    }), 'ordering');
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal',
        returnedQty:2,
        effectiveDeliveredQty:8,
        orderedQty:10,
        deliveredQty:8,
        fulfillmentType:'DIRECT_SHIP',
        supplyOrderedQty:12,
        receivedQty:10,
        isBilled:false
    }), 'arrival');
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal',
        returnedQty:2,
        effectiveDeliveredQty:10,
        orderedQty:10,
        deliveredQty:10,
        fulfillmentType:'DIRECT_SHIP',
        supplyOrderedQty:12,
        receivedQty:12,
        isBilled:false
    }), 'billing');

    const remainingStart=app.indexOf('function remainingProcurementQty');
    const remainingEnd=app.indexOf('\nfunction pendingProcurementDisplayLines',remainingStart);
    const remainingSource=app.slice(remainingStart,remainingEnd);
    assert.match(remainingSource,/YushinWorkflow\?\.procurementQuantities/);
    assert.match(remainingSource,/remainingToOrderQty/);

    const selfStart=app.indexOf('function selfOrderActionHtml');
    const selfEnd=app.indexOf('\nwindow.openSelfOrderModal',selfStart);
    assert.match(app.slice(selfStart,selfEnd),/remainingProcurementQty\(order,item,dispatchStateByItem\?\.get\(item\) \|\| null\)/);
});

test('restoring an order uses net delivered quantity after returns', () => {
    const start=app.indexOf('async function adjustInventoryReservationForLifecycle');
    const end=app.indexOf('\nwindow.quickSetOrderLifecycle',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/const grossDelivered = deliveries/);
    assert.match(source,/const returned = savedReturnRecords\(order\)/);
    assert.match(source,/const delivered = Math\.max\(0, grossDelivered - returned\)/);
    assert.match(source,/const outstanding = Math\.max\(0, ordered - delivered\)/);
});

test('full returns stay in fulfillment instead of closing the order', () => {
    const workflow=require('../modules/workflow-core.js');
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal',
        returnedQty:10,
        effectiveDeliveredQty:0,
        orderedQty:10,
        deliveredQty:0,
        fulfillmentType:'WAREHOUSE',
        shortageQty:0,
        supplyOrderedQty:10,
        receivedQty:10,
        isBilled:true
    }), 'delivery');

    const categoryStart=app.indexOf('function orderWorkCategories');
    const categoryEnd=app.indexOf('\nfunction orderWorkIndexFields',categoryStart);
    const categorySource=app.slice(categoryStart,categoryEnd);
    assert.ok(categoryStart>=0&&categoryEnd>categoryStart);
    assert.doesNotMatch(categorySource,/lifecycle\.returned>0&&lifecycle\.effectiveDelivered<=0/);
    assert.match(app,/全數退貨・待補送/);
});

test('cancelled orders keep actual delivered sales but no pending sales', () => {
    const start=app.indexOf('function calculateOrderStatsContribution');
    const end=app.indexOf('\nfunction addSalesStatsContribution',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    const context=vm.createContext({
        normalizedOrderStatus:()=> 'cancelled',
        orderQuantity:()=>10,
        orderUnitSalesAmount:()=>100,
        orderUnitCostForStats:order=>Number(order.costPrice),
        savedDeliveryRecords:()=>[{date:'2026-09-01',qty:4}],
        savedReturnRecords:()=>[],
        localDateString:()=> '2026-09-30',
        dateInStatsRange:(date,start,end)=>!!date&&(!start||date>=start)&&(!end||date<=end)
    });
    vm.runInContext(source,context);
    const result=context.calculateOrderStatsContribution({costPrice:50,orderDate:'2026-09-01'},'2026-09-01','2026-09-30');
    assert.equal(result.actualQty,4);
    assert.equal(result.actualSales,400);
    assert.equal(result.pendingQty,0);
    assert.equal(result.pendingSales,0);
    assert.equal(result.actualCost,200);
});

test('completion date includes a later return date when the order is still net complete', () => {
    const start=app.indexOf('function orderCompletionDate');
    const end=app.indexOf('\nfunction orderPeriodRange',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    const context=vm.createContext({
        deliveryProgressInfo:()=>({state:'complete'}),
        orderInvoiceDate:()=> '2026-09-02',
        savedDeliveryRecords:()=>[
            {date:'2026-09-01',qty:10},
            {date:'2026-09-05',qty:2}
        ],
        savedReturnRecords:()=>[{date:'2026-09-10',qty:2}],
        dateOnlyFromTimestamp:value=>String(value||'').slice(0,10)
    });
    vm.runInContext(source,context);
    assert.equal(context.orderCompletionDate({isBilled:true}),'2026-09-10');
});

test('delivery progress uses net delivered quantity after returns', () => {
    const start=app.indexOf('function deliveryProgressInfo');
    const end=app.indexOf('\nfunction savedReturnRecords',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    const context=vm.createContext({
        orderQuantity:()=>10,
        deliveredQuantity:()=>10,
        returnedQuantity:()=>2,
        savedDeliveryRecords:()=>[{qty:10}]
    });
    vm.runInContext(source,context);
    const progress=context.deliveryProgressInfo({isDelivered:true});
    assert.equal(progress.grossDelivered,10);
    assert.equal(progress.returned,2);
    assert.equal(progress.delivered,8);
    assert.equal(progress.remaining,2);
    assert.equal(progress.state,'partial');
});

test('normalized order items derive fulfillment from delivery and return records', () => {
    const start=app.indexOf('function normalizedOrderItems');
    const end=app.indexOf('\nfunction ensureOrderItemCompatibility',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    const context=vm.createContext({
        window:{YushinFulfillment:fulfillment},
        normalizeHistoryItemCode:value=>String(value||'').toLowerCase(),
        resolveBrandName:value=>value||'',
        parseMoney:value=>Number(value||0)
    });
    vm.runInContext(source,context);
    const [item]=context.normalizedOrderItems({
        items:[{itemId:'I1',qty:10,reservedQty:2,shortageQty:0,deliveredQty:0,returnedQty:0,fulfillmentType:'WAREHOUSE'}],
        deliveryRecords:[{itemId:'I1',qty:10}],
        returnRecords:[{itemId:'I1',qty:2}]
    });
    assert.equal(item.deliveredQty,10);
    assert.equal(item.returnedQty,2);
    assert.equal(item.reservedQty,2);
    assert.equal(item.shortageQty,0);
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal',
        orderedQty:item.orderedQty,
        deliveredQty:8,
        returnedQty:2,
        fulfillmentType:'WAREHOUSE',
        shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty,
        receivedQty:item.receivedQty
    }),'delivery');
});

test('dispatch readiness uses live reservation and supports later receipt batches', () => {
    const start=app.indexOf('function itemDispatchState');
    const end=app.indexOf('\nfunction orderContextActionState',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    const context=vm.createContext({
        normalizedOrderItems:order=>order.items||[],
        savedDeliveryRecords:order=>order.deliveryRecords||[],
        savedReturnRecords:order=>order.returnRecords||[],
        YushinFulfillment:fulfillment,
        window:{YushinFulfillment:fulfillment}
    });
    vm.runInContext(source,context);
    const item={itemId:'I1',orderedQty:10,qty:10,reservedQty:5,dispatchPreparedQty:5};
    const afterFirstShipment=context.itemDispatchState({items:[item],deliveryRecords:[{itemId:'I1',qty:5}]},item);
    assert.equal(afterFirstShipment.pending,5);
    assert.equal(afterFirstShipment.shippable,0);

    const syncedAfterShipment={...item,reservedQty:0};
    const shippedState=context.itemDispatchState({items:[syncedAfterShipment],deliveryRecords:[{itemId:'I1',qty:5}]},syncedAfterShipment);
    assert.equal(shippedState.pending,0);

    const secondReceipt={...syncedAfterShipment,reservedQty:5,receivedQty:10};
    const secondBatch=context.itemDispatchState({items:[secondReceipt],deliveryRecords:[{itemId:'I1',qty:5}]},secondReceipt);
    assert.equal(secondBatch.pending,5);
    assert.equal(secondBatch.shippable,0);

    const secondPrepared={...secondReceipt,dispatchPreparedQty:10};
    const ready=context.itemDispatchState({items:[secondPrepared],deliveryRecords:[{itemId:'I1',qty:5}]},secondPrepared);
    assert.equal(ready.pending,0);
    assert.equal(ready.shippable,5);
});

test('cancelled-order returns go back to free stock instead of restoring reservation', () => {
    const start=app.indexOf('async function applyInventoryReturnDeltaInTransaction');
    const end=app.indexOf('\nwindow.quickCompleteDelivery',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/const returnKeepsReservation=normalizedOrderStatus\(order\)==='normal'/);
    assert.match(source,/const nextReservation=returnKeepsReservation\?Math\.max\(0,currentReservation\+deltaQty\):0/);
    assert.match(source,/const reservationStatus=returnKeepsReservation\?\(nextReservation>0\?'active':'fulfilled'\):'released'/);
});

test('multi-item delivery edits cannot make an item delivered quantity lower than its returns', () => {
    const saveStart=app.indexOf('window.saveDeliveryRecord = async function');
    const saveEnd=app.indexOf('window.deleteDeliveryRecord',saveStart);
    const saveSource=app.slice(saveStart,saveEnd);
    assert.match(saveSource,/const itemGrossAfter=itemOtherDelivered\+qty/);
    assert.match(saveSource,/itemGrossAfter\+1e-9<itemReturned/);

    const deleteStart=app.indexOf('window.deleteDeliveryRecord = async function');
    const deleteEnd=app.indexOf('window.clearLegacyDelivery',deleteStart);
    const deleteSource=app.slice(deleteStart,deleteEnd);
    assert.match(deleteSource,/const itemGrossAfter=itemRecords\.filter\(r=>r\.id!==recordId\)/);
    assert.match(deleteSource,/itemGrossAfter\+1e-9<itemReturned/);
});

test('editing a multi-item delivery stays bound to its original item', () => {
    const editStart=app.indexOf('window.editDeliveryRecord = function');
    const editEnd=app.indexOf('\nwindow.saveDeliveryRecord = async function',editStart);
    const editSource=app.slice(editStart,editEnd);
    assert.ok(editStart>=0&&editEnd>editStart);
    assert.match(editSource,/targetItem=orderItems\.find\(item=>item\.itemId===record\.itemId\)/);
    assert.match(editSource,/itemSelect\.disabled=true/);
    assert.match(editSource,/otherDelivered=savedDeliveryRecords\(order\)/);
    assert.match(editSource,/otherNetDelivered=Math\.max\(0,otherDelivered-returned\)/);

    const saveStart=app.indexOf('window.saveDeliveryRecord = async function');
    const saveEnd=app.indexOf('window.deleteDeliveryRecord',saveStart);
    const saveSource=app.slice(saveStart,saveEnd);
    assert.match(saveSource,/const requestedItemId=previous\?\.itemId\|\|document\.getElementById\('deliveryItemId'\)\?\.value/);

    const renderStart=app.indexOf('function renderDeliveryModal');
    const renderEnd=app.indexOf('window.editDeliveryRecord = function',renderStart);
    const renderSource=app.slice(renderStart,renderEnd);
    assert.match(renderSource,/const returned=savedReturnRecords\(order\)/);
    assert.match(renderSource,/const delivered=Math\.max\(0,grossDelivered-returned\)/);
});

test('delivery and return writes synchronize live reservedQty back to order items', () => {
    const deliveryStart=app.indexOf('window.saveDeliveryRecord = async function()');
    const deliveryEnd=app.indexOf('window.deleteDeliveryRecord',deliveryStart);
    const delivery=app.slice(deliveryStart,deliveryEnd);
    assert.match(delivery,/newReservedQty/);
    assert.match(delivery,/updates\.items=syncedItems/);

    const returnStart=app.indexOf('window.saveReturnRecord = async function()');
    const returnEnd=app.indexOf('window.deleteReturnRecord',returnStart);
    const returns=app.slice(returnStart,returnEnd);
    assert.match(returns,/syncedReservedQty/);
    assert.match(returns,/items:syncedItems/);
});

test('receipt modal close function exists and does not discard retry key', () => {
    const start=app.indexOf('window.closePoReceiptBatch = function()');
    const end=app.indexOf('\n\nwindow.receiveSupplyOrder',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/poReceiptBatchOverlay/);
    assert.match(source,/poReceiptTargetId=''/);
    assert.doesNotMatch(source,/clearReceiptOperationId/);
});

test('warehouse receiving no longer mutates purchase-order receipt state', () => {
    const start=app.indexOf('async function receiveSupplyOrderRecord');
    const end=app.indexOf('window.openSupplyReceipt',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/collection\('supplyOrders'\)/);
    assert.match(source,/collection\('receipts'\)/);
    assert.match(source,/warehouseStocks/);
    assert.doesNotMatch(source,/pendingInventoryItems/);
    assert.doesNotMatch(source,/purchaseOrders/);
    assert.doesNotMatch(source,/receiptRecords/);
    assert.doesNotMatch(source,/receiptStatus/);
});


test('purchasing pending card and detail share the same item work-state engine', () => {
    const cardStart=app.indexOf('function renderPurchasingWorkCards(');
    const cardEnd=app.indexOf('\nfunction purchasingCompletedRows',cardStart);
    const detailStart=app.indexOf('function renderPendingPurchaseOrders(');
    const detailEnd=app.indexOf('\nwindow.loadPendingPurchaseOrders',detailStart);
    const helperStart=app.indexOf('function buildOrderItemWorkMetrics(');
    const helperEnd=app.indexOf('\nwindow.setOrderWorkFilter',helperStart);
    const displayStart=app.indexOf('function pendingProcurementDisplayLines(');
    const displayEnd=app.indexOf('\nfunction renderPurchasingWorkCards',displayStart);
    const formalStart=app.indexOf('function pendingPurchaseLines(order)');
    const formalEnd=app.indexOf('\nfunction syncOrderIntoPurchasingCaches',formalStart);
    assert.ok(cardStart>=0&&detailStart>=0&&helperStart>=0&&displayStart>=0&&formalStart>=0);
    assert.match(app.slice(cardStart,cardEnd),/buildOrderItemWorkMetrics\(/);
    assert.match(app.slice(helperStart,helperEnd),/orderItemDisplayCategories\(order,item,lifecycle,dispatch\)/);
    assert.match(app.slice(displayStart,displayEnd),/orderItemWorkCategory\(order, item, lifecycle, dispatch\) !== 'ordering'/);
    assert.match(app.slice(detailStart,detailEnd),/pendingProcurementDisplayLines\([\s\S]*?normalizedItemsByOrder\?\.get\(order\.id\)/);
    assert.match(app.slice(detailStart,detailEnd),/自行訂貨/);
    assert.doesNotMatch(app.slice(detailStart,detailEnd),/業務自行訂貨/);
    assert.match(app.slice(formalStart,formalEnd),/procurementType === 'PURCHASING_PO'/);
});

test('PO core transaction commits before the print dialog opens', () => {
    const start=app.indexOf('window.printPurchaseOrder = async function()');
    const end=app.indexOf("window.addEventListener('afterprint'",start);
    const source=app.slice(start,end);
    const awaitIndex=source.indexOf('await commitPromise;');
    const printIndex=source.indexOf('printSavedPoDocument(poNo, vendorName);');
    assert.ok(awaitIndex>=0&&printIndex>awaitIndex,'core PO transaction must finish before print');
    assert.match(source,/registerPurchaseIncoming\(poDocumentId, poRecord\)\s*\.then/);
});

test('committed PO refreshes item quantities in order and purchasing views', () => {
    assert.match(app,/committedSourceOrders\.push\(\{id:snapshot\.id,\.\.\.orderData,\.\.\.orderUpdates\}\)/);
    assert.match(app,/syncCommittedPurchaseOrderSources\(committedSourceOrders\)/);

    const start=app.indexOf('function syncCommittedPurchaseOrderSources(orders)');
    const end=app.indexOf('\nfunction renderPendingPurchaseOrders',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/ordersCache\.findIndex\(row => row\.id === order\.id\)/);
    assert.match(source,/syncOrderIntoPurchasingCaches\(order, \{ render:false \}\)/);
    assert.match(source,/writeAppDataCache\('orders', ordersCache\)/);
    assert.match(source,/order-system'[\s\S]*?renderOrdersList\(\)/);
    assert.match(source,/purchasing-system'[\s\S]*?renderPurchasingView\(\)/);
});

test('order and purchasing cards use the same item-level metric calculator', () => {
    const helperStart=app.indexOf('function buildOrderItemWorkMetrics(');
    const helperEnd=app.indexOf('\nwindow.setOrderWorkFilter',helperStart);
    const orderStart=app.indexOf('function renderOrderWorkCards(');
    const orderEnd=app.indexOf('\nfunction createOrderPaginationState',orderStart);
    const purchasingStart=app.indexOf('function renderPurchasingWorkCards(');
    const purchasingEnd=app.indexOf('\nfunction purchasingCompletedRows',purchasingStart);
    const helper=app.slice(helperStart,helperEnd);
    const orderCards=app.slice(orderStart,orderEnd);
    const purchasingCards=app.slice(purchasingStart,purchasingEnd);
    assert.ok(helperStart>=0&&helperEnd>helperStart&&orderStart>=0&&orderEnd>orderStart&&purchasingStart>=0&&purchasingEnd>purchasingStart);
    assert.match(orderCards, /buildOrderItemWorkMetrics\(/);
    assert.match(purchasingCards, /buildOrderItemWorkMetrics\(/);
    assert.match(purchasingCards, /purchaseLineMatchesFilters\(order\.orderDate, order\.salesName, item\.brand, filters\)/);
    assert.match(helper,/orderItemDisplayCategories\(order,item,lifecycle,dispatch\)/);
});

test('formal PO draft opens from the loaded order before secure purchase metadata finishes loading', () => {
    const start=app.indexOf("window.openOrderPurchaseDraft = async function(orderId, itemId = '')");
    const end=app.indexOf('\n// 「採購訂單」',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source, /ordersCache\.find\(row => row\.id === orderId\)/);
    assert.match(source, /action\.includes\('openOrderPurchaseDraft\('/);
    const openIndex = source.indexOf("poModalOverlay').classList.add('active')");
    const preloadIndex = source.indexOf('await Promise.all([loadSupplierWarehouseMasters(), preloadPurchaseCostsForItems(items)])');
    assert.ok(openIndex >= 0 && preloadIndex > openIndex, 'modal should be visible before purchase metadata preload completes');
    assert.match(app, /assertPurchaseLinesAvailable\(snapshot\.data\(\), poRecord\.items\.filter/);
});

test('purchase cost preload preserves already resolved costs across repeated PO opens', () => {
    const helperStart=app.indexOf('async function preloadPurchaseCostsForItems(');
    const helperEnd=app.indexOf('\nfunction productMasterDocToPriceItem',helperStart);
    const helper=app.slice(helperStart,helperEnd);
    assert.ok(helperStart>=0&&helperEnd>helperStart);
    assert.doesNotMatch(helper, /purchaseCostCache = new Map\(\)/);
    assert.match(helper, /if \(purchaseCostCache\.has\(id\)\) return;/);

    const draftStart=app.indexOf("window.openOrderPurchaseDraft = async function(orderId, itemId = '')");
    const draftEnd=app.indexOf('\n// 「採購訂單」',draftStart);
    const draft=app.slice(draftStart,draftEnd);
    assert.ok(draftStart>=0&&draftEnd>draftStart);
    assert.match(draft,/preloadPurchaseCostsForItems\(items\)/);
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

test('reopening a saved PO derives incoming sync state from supplyOrders', () => {
    const helper = app.match(/async function purchaseIncomingSyncPending\(po\) \{[\s\S]*?\n\}/)?.[0];
    const reprint = app.match(/window\.reprintPurchaseOrder = async function\(poId\) \{[\s\S]*?\n\};/)?.[0];
    assert.ok(helper && reprint);
    assert.match(helper,/readDocumentsByIds\('supplyOrders', supplyIds\)/);
    assert.match(helper,/incomingRegisteredQty/);
    assert.match(helper,/registeredQty < targetQty/);
    assert.match(reprint,/await purchaseIncomingSyncPending\(po\)/);
});

test('closing or reprinting a PO invalidates any pending PO number request', () => {
    const closeSource = app.match(/window\.closePurchaseOrderModal = function\(\) \{[\s\S]*?\n\};/)?.[0];
    const reprintSource = app.match(/window\.reprintPurchaseOrder = async function\(poId\) \{[\s\S]*?\n\};/)?.[0];
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
    assert.match(html, /id="purchase-tab-history"[^>]*>全部訂購單</);
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
    assert.match(app, /'📄 匯出 PDF（自動同步雲端）'/);
    const save = app.match(/window\.printPurchaseOrder = async function\(\) \{[\s\S]*?\n\};/)?.[0] || '';
    assert.ok(save.indexOf('await commitPromise') < save.indexOf('printSavedPoDocument(poNo, vendorName)'));
});


test('cancelled supply records have no receivable remainder', () => {
    const cancelled=supply.normalize({type:'PURCHASING_PO',qty:10,receivedQty:4,status:'CANCELLED'});
    assert.equal(cancelled.status,'CANCELLED');
    assert.equal(cancelled.receivedQty,4);
    assert.equal(cancelled.remainingQty,0);
    const retry=supply.applyReceipt(cancelled,2);
    assert.equal(retry.appliedQty,0);
    assert.equal(retry.record.receivedQty,4);
});

test('purchase cancellation releases incoming and returns outstanding quantity to procurement', () => {
    const start=app.indexOf('async function cancelOutstandingSupplyRecord');
    const end=app.indexOf('\nwindow.cancelPurchaseOrderOutstanding',start);
    const source=app.slice(start,end);
    assert.ok(start>=0&&end>start);
    assert.match(source,/globalThis\.YushinReceiving\.normalizeSupply\(supply\)/);
    assert.match(source,/supplyProjection\.remainingQty/);
    assert.match(source,/supplyOrderedQty:Math\.max\(receivedForItem,currentSupplyOrdered-remaining\)/);
    assert.match(source,/incoming:Math\.max\(0,inv\.incoming-registeredIncoming\)/);
    assert.match(source,/incoming:Math\.max\(0,wh\.incoming-registeredIncoming\)/);
    assert.match(source,/type:'purchase_incoming_cancel'/);
    assert.match(source,/status:'CANCELLED'/);
    assert.match(source,/incomingRegisteredQty:0/);

    const registerStart=app.indexOf('async function registerPurchaseIncoming');
    const registerEnd=app.indexOf('\nasync function cancelOutstandingSupplyRecord',registerStart);
    const registerSource=app.slice(registerStart,registerEnd);
    assert.match(registerSource,/poRecord\?\.status[\s\S]*?'CANCELLED'/);
    assert.match(registerSource,/supply\.status[\s\S]*?'CANCELLED'/);

    const pendingStart=app.indexOf('async function purchaseIncomingSyncPending');
    const pendingEnd=app.indexOf('\nwindow.reprintPurchaseOrder',pendingStart);
    const pendingSource=app.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/po\?\.status[\s\S]*?'CANCELLED'/);
    assert.match(pendingSource,/supply\.status[\s\S]*?'CANCELLED'/);
});


test('acceptance flow keeps inventory and work states aligned through procurement to completion', () => {
    const fulfillment=require('../modules/fulfillment-core.js');
    const workflow=require('../modules/workflow-core.js');

    const displayCategory=(item,isBilled=false)=>{
        const effectiveDelivered=Math.max(0,Number(item.deliveredQty||0)-Number(item.returnedQty||0));
        const core=workflow.itemWorkCategory({
            lifecycleStatus:'normal',
            orderedQty:item.orderedQty,
            deliveredQty:effectiveDelivered,
            returnedQty:item.returnedQty,
            isBilled,
            fulfillmentType:'WAREHOUSE',
            shortageQty:item.shortageQty,
            supplyOrderedQty:item.supplyOrderedQty,
            receivedQty:item.receivedQty
        });
        if(core!=='delivery')return core;
        return fulfillment.pendingDispatchQty(item)>0?'dispatch':'shipping';
    };

    let inventory={onHand:4,reserved:0,incoming:0};
    let item=fulfillment.reserveFromAvailable({orderedQty:10,fulfillmentType:'WAREHOUSE'},4);
    inventory.reserved=item.reservedQty;
    assert.deepEqual(
        {onHand:inventory.onHand,reserved:inventory.reserved,incoming:inventory.incoming,category:displayCategory(item)},
        {onHand:4,reserved:4,incoming:0,category:'ordering'}
    );

    item=fulfillment.normalizeItem({...item,supplyOrderedQty:6});
    inventory.incoming+=6;
    assert.equal(displayCategory(item),'arrival');
    assert.deepEqual(inventory,{onHand:4,reserved:4,incoming:6});

    item=fulfillment.applyReceipt(item,2);
    inventory.onHand+=2;
    inventory.incoming-=2;
    inventory.reserved=item.reservedQty;
    assert.equal(displayCategory(item),'arrival');
    assert.deepEqual(inventory,{onHand:6,reserved:6,incoming:4});

    item=fulfillment.applyReceipt(item,4);
    inventory.onHand+=4;
    inventory.incoming-=4;
    inventory.reserved=item.reservedQty;
    assert.equal(displayCategory(item),'dispatch');
    assert.deepEqual(inventory,{onHand:10,reserved:10,incoming:0});

    item=fulfillment.prepareDispatch(item,10);
    assert.equal(displayCategory(item),'shipping');

    item=fulfillment.deliver(item,10);
    inventory.onHand-=10;
    inventory.reserved=item.reservedQty;
    assert.equal(displayCategory(item),'billing');
    assert.deepEqual(inventory,{onHand:0,reserved:0,incoming:0});

    assert.equal(displayCategory(item,true),'complete');
});

test('acceptance flow handles partial receipt cancellation and return replacement without stock drift', () => {
    const fulfillment=require('../modules/fulfillment-core.js');
    const workflow=require('../modules/workflow-core.js');

    const displayCategory=(item,isBilled=false)=>{
        const effectiveDelivered=Math.max(0,Number(item.deliveredQty||0)-Number(item.returnedQty||0));
        const core=workflow.itemWorkCategory({
            lifecycleStatus:'normal',
            orderedQty:item.orderedQty,
            deliveredQty:effectiveDelivered,
            returnedQty:item.returnedQty,
            isBilled,
            fulfillmentType:'WAREHOUSE',
            shortageQty:item.shortageQty,
            supplyOrderedQty:item.supplyOrderedQty,
            receivedQty:item.receivedQty
        });
        if(core!=='delivery')return core;
        const gross=Math.max(0,Number(item.deliveredQty||0));
        const reserved=Math.max(0,Number(item.reservedQty||0));
        const prepared=Math.max(0,Number(item.dispatchPreparedQty||0));
        const preparedOutstanding=Math.max(0,prepared-gross);
        const shippable=Math.max(0,Math.min(reserved,preparedOutstanding));
        const pending=Math.max(0,reserved-shippable);
        return pending>0?'dispatch':'shipping';
    };

    let inventory={onHand:4,reserved:0,incoming:0};
    let item=fulfillment.reserveFromAvailable({orderedQty:10,fulfillmentType:'WAREHOUSE'},4);
    inventory.reserved=item.reservedQty;
    item=fulfillment.normalizeItem({...item,supplyOrderedQty:6});
    inventory.incoming=6;
    item=fulfillment.applyReceipt(item,2);
    inventory.onHand+=2;
    inventory.incoming-=2;
    inventory.reserved=item.reservedQty;

    const cancelledOutstanding=Math.max(0,item.supplyOrderedQty-item.receivedQty);
    item=fulfillment.normalizeItem({
        ...item,
        supplyOrderedQty:Math.max(item.receivedQty,item.supplyOrderedQty-cancelledOutstanding)
    });
    inventory.incoming=Math.max(0,inventory.incoming-cancelledOutstanding);
    assert.deepEqual(inventory,{onHand:6,reserved:6,incoming:0});
    assert.equal(item.shortageQty,4);
    assert.equal(displayCategory(item),'ordering');

    item=fulfillment.normalizeItem({
        orderedQty:10,reservedQty:10,shortageQty:0,
        supplyOrderedQty:6,receivedQty:6,dispatchPreparedQty:10,
        deliveredQty:0,returnedQty:0,fulfillmentType:'WAREHOUSE'
    });
    inventory={onHand:10,reserved:10,incoming:0};
    item=fulfillment.deliver(item,10);
    inventory.onHand-=10;
    inventory.reserved=item.reservedQty;
    assert.equal(displayCategory(item,true),'complete');

    item=fulfillment.returnDelivery(item,2);
    inventory.onHand+=2;
    item=fulfillment.normalizeItem({...item,reservedQty:2});
    inventory.reserved=item.reservedQty;
    assert.deepEqual(inventory,{onHand:2,reserved:2,incoming:0});
    assert.equal(displayCategory(item,true),'dispatch');

    item=fulfillment.prepareDispatch(item,2);
    assert.equal(displayCategory(item,true),'shipping');

    item=fulfillment.deliver(item,2);
    inventory.onHand-=2;
    inventory.reserved=item.reservedQty;
    assert.deepEqual(inventory,{onHand:0,reserved:0,incoming:0});
    assert.equal(displayCategory(item,true),'complete');
});


test('acceptance flow keeps direct-ship procurement out of warehouse stock and handles replacements', () => {
    const workflow=require('../modules/workflow-core.js');

    const category=({ordered=10,supplyOrdered=0,received=0,grossDelivered=0,returned=0,billed=false})=>
        workflow.itemWorkCategory({
            lifecycleStatus:'normal',
            orderedQty:ordered,
            deliveredQty:Math.max(0,grossDelivered-returned),
            returnedQty:returned,
            fulfillmentType:'DIRECT_SHIP',
            supplyOrderedQty:supplyOrdered,
            receivedQty:received,
            isBilled:billed
        });

    assert.equal(category({}), 'ordering');
    assert.equal(category({supplyOrdered:10}), 'arrival');
    assert.equal(category({supplyOrdered:10,received:4,grossDelivered:4}), 'arrival');
    assert.equal(category({supplyOrdered:10,received:10,grossDelivered:10}), 'billing');
    assert.equal(category({supplyOrdered:10,received:10,grossDelivered:10,billed:true}), 'complete');

    const afterReturn={supplyOrdered:10,received:10,grossDelivered:10,returned:2,billed:true};
    assert.equal(category(afterReturn), 'ordering');
    assert.deepEqual(
        workflow.procurementQuantities({
            orderedQty:10,fulfillmentType:'DIRECT_SHIP',
            supplyOrderedQty:10,receivedQty:10,returnedQty:2
        }),
        {requiredSupplyQty:12,supplyOrderedQty:10,receivedQty:10,inTransitQty:0,remainingToOrderQty:2}
    );
    assert.equal(category({...afterReturn,supplyOrdered:12}), 'arrival');
    assert.equal(category({...afterReturn,supplyOrdered:12,received:12,grossDelivered:12}), 'complete');

    const receiptStart=app.indexOf('async function receiveSupplyOrderRecord');
    const receiptEnd=app.indexOf('\nwindow.openSupplyReceipt',receiptStart);
    const receiptSource=app.slice(receiptStart,receiptEnd);
    const directStart=receiptSource.indexOf("if(directShip){");
    const warehouseStart=receiptSource.indexOf("const productKey=",directStart);
    const directSource=receiptSource.slice(directStart,warehouseStart);
    assert.match(directSource,/deliveryRecords/);
    assert.match(directSource,/directShipDeliveredQty/);
    assert.doesNotMatch(directSource,/collection\('inventory'\)/);
    assert.doesNotMatch(directSource,/collection\('warehouseStocks'\)/);
    assert.doesNotMatch(directSource,/inventoryMovements/);
});


test('cancelled outstanding quantity becomes purchasable again', () => {
    const workflow=require('../modules/workflow-core.js');
    const before=workflow.procurementQuantities({
        orderedQty:10,
        fulfillmentType:'WAREHOUSE',
        shortageQty:4,
        supplyOrderedQty:6,
        receivedQty:2
    });
    assert.equal(before.inTransitQty,4);
    assert.equal(before.remainingToOrderQty,0);

    const after=workflow.procurementQuantities({
        orderedQty:10,
        fulfillmentType:'WAREHOUSE',
        shortageQty:4,
        supplyOrderedQty:2,
        receivedQty:2
    });
    assert.equal(after.inTransitQty,0);
    assert.equal(after.remainingToOrderQty,4);

    const cancelStart=app.indexOf('async function cancelOutstandingSupplyRecord');
    const cancelEnd=app.indexOf('\nwindow.cancelPurchaseOrderOutstanding',cancelStart);
    const cancelSource=app.slice(cancelStart,cancelEnd);
    assert.match(cancelSource,/supplyOrderedQty:Math\.max\(receivedForItem,currentSupplyOrdered-remaining\)/);

    const validateStart=app.indexOf('function assertPurchaseLinesAvailable');
    const validateEnd=app.indexOf('\nfunction poPdfFileName',validateStart);
    const validateSource=app.slice(validateStart,validateEnd);
    assert.match(validateSource,/const remaining = remainingProcurementQty\(order, source\)/);
    assert.doesNotMatch(validateSource,/purchaseDocumentNos/);
});


test('warehouse quick ordered action registers incoming atomically and idempotently', async () => {
    const source = app.match(/const pendingPurchaseOrderKeys = new Set\(\);[\s\S]*?\n(?=window\.openOrderPurchaseDraft)/)?.[0];
    assert.ok(source);

    const docs=new Map();
    const order={
        items:[{itemId:'I1',itemCode:'P1',itemName:'Product',qty:2,productId:'P1',
            supplier:'Vendor',costPrice:100,warehouseId:'W1',fulfillmentType:'WAREHOUSE',
            procurementType:'PURCHASING_PO',supplyOrderedQty:0,receivedQty:0,shortageQty:2}],
        orderNo:'O1',ownerUid:'sales-1',salesCode:'S01'
    };
    docs.set('orders/O1',order);
    docs.set('inventory/P1',{productKey:'P1',onHand:0,reserved:0,incoming:0});
    docs.set('warehouseStocks/W1__P1',{warehouseId:'W1',productKey:'P1',onHand:0,reserved:0,incoming:0});
    let sequence=0;
    const movements=[];
    const db={
        collection:name=>({doc:id=>{
            const finalId=id||('auto-'+(++sequence));
            return {key:name+'/'+finalId,id:finalId};
        }}),
        async runTransaction(callback){
            const writes=[];
            const tx={
                async get(ref){return {exists:docs.has(ref.key),id:ref.id,data:()=>docs.get(ref.key)};},
                set(ref,data,options){writes.push(['set',ref,data,options]);},
                update(ref,data){writes.push(['update',ref,data,{merge:true}]);}
            };
            await callback(tx);
            writes.forEach(([kind,ref,data,options])=>{
                if(ref.key.startsWith('inventoryMovements/')) movements.push(data);
                const previous=docs.get(ref.key)||{};
                docs.set(ref.key,(kind==='update'||options?.merge)?{...previous,...data}:data);
            });
        }
    };
    const context=vm.createContext({
        window:{},YushinReceiving:receiving,document:{getElementById:()=>null},db,
        canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
        currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
        remainingProcurementQty:(record,item)=>{
            const ordered=Number(item.supplyOrderedQty||0);
            const received=Number(item.receivedQty||0);
            return Math.max(0,Number(item.shortageQty||0)-Math.max(0,ordered-received));
        },
        poIncomingKey:()=> 'P1',defaultWarehouse:()=>({id:'W1'}),localDateString:()=> '2026-10-01',
        normalizedOrderStatus:()=> 'normal',normalizedOrderItems:record=>record.items,
        orderWorkIndexFields:()=>({workCategories:['arrival']}),
        inventoryNumbers:data=>({
            onHand:Number(data?.onHand||0),reserved:Number(data?.reserved||0),incoming:Number(data?.incoming||0)
        }),
        warehouseStockDocId:(warehouse,key)=>warehouse+'__'+key,
        resolveBrandName:value=>value||'',
        buildInventorySearchTokens:()=>['p1'],
        invalidateWarehouseStockCache:()=>{},
        ordersCache:[],supplyReceivingCache:[],
        syncOrderIntoPurchasingCaches:()=>{},writeAppDataCache:()=>{},renderOrdersList:()=>{},
        switchPurchasingView:()=>{},alert:()=>{}
    });
    vm.runInContext(source,context);

    const button={disabled:false,textContent:'已訂購',isConnected:false};
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(docs.get('orders/O1').items[0].supplyOrderedQty,2);
    assert.equal(docs.get('supplyOrders/manual-O1-I1').incomingRegisteredQty,2);
    assert.equal(docs.get('inventory/P1').incoming,2);
    assert.equal(docs.get('warehouseStocks/W1__P1').incoming,2);
    assert.equal(movements.length,1);
    assert.equal(movements[0].qty,2);

    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(docs.get('inventory/P1').incoming,2,'plain retry must not duplicate incoming');
    assert.equal(docs.get('warehouseStocks/W1__P1').incoming,2);
    assert.equal(docs.get('supplyOrders/manual-O1-I1').orderEvents.length,1);
    assert.equal(movements.length,1);

    docs.get('orders/O1').items[0].shortageQty=5;
    await context.window.markPurchaseItemOrdered('O1','I1',button);
    assert.equal(docs.get('orders/O1').items[0].supplyOrderedQty,5);
    assert.equal(docs.get('supplyOrders/manual-O1-I1').qty,5);
    assert.equal(docs.get('supplyOrders/manual-O1-I1').incomingRegisteredQty,5);
    assert.equal(docs.get('inventory/P1').incoming,5);
    assert.equal(docs.get('warehouseStocks/W1__P1').incoming,5);
    assert.equal(movements.length,2);
    assert.equal(movements[1].qty,3);
});

test('quick ordered action writes incoming inside the same transaction', () => {
    const start=app.indexOf('window.markPurchaseItemOrdered = async function');
    const end=app.indexOf('\nwindow.openOrderPurchaseDraft',start);
    const source=app.slice(start,end);
    assert.match(source,/globalThis\.YushinReceiving\.normalizeSupply/);
    assert.match(source,/const targetIncomingQty = directShip \? 0 : supplyProjection\.remainingQty/);
    assert.match(source,/const incomingDelta = targetIncomingQty - registeredIncomingQty/);
    assert.match(source,/collection\('inventory'\)/);
    assert.match(source,/collection\('warehouseStocks'\)/);
    assert.match(source,/type:'purchase_incoming'/);
    assert.match(source,/incomingRegisteredQty:targetIncomingQty/);
    assert.match(source,/單純重試時不增加訂購量或事件，但仍會修復曾中斷的 incoming 同步/);
});


test('quick manual supply can cancel outstanding quantity from the receiving queue', () => {
    const helperStart=app.indexOf('function manualSupplyCancelActionHtml');
    const helperEnd=app.indexOf('\nfunction receivingWorkProgress',helperStart);
    const helperSource=app.slice(helperStart,helperEnd);
    assert.ok(helperStart>=0&&helperEnd>helperStart);
    assert.match(helperSource,/supply\.type !== 'PURCHASING_MANUAL'/);
    assert.match(helperSource,/canCreatePurchaseOrderCapability\(\)/);
    assert.match(helperSource,/purchaseCancellationInProgress\.has\(key\)/);
    assert.match(helperSource,/cancelManualSupplyOutstanding/);

    const listStart=app.indexOf('function renderPurchasingReceivingWorkList');
    const listEnd=app.indexOf('\nwindow.renderPoList',listStart);
    const listSource=app.slice(listStart,listEnd);
    assert.match(listSource,/const supplyById = new Map\(supplyReceivingCache\.map/);
    assert.match(listSource,/manualSupplyCancelActionHtml\(supply\)/);
    assert.equal((listSource.match(/manualSupplyCancelActionHtml\(/g)||[]).length,2);

    const cancelStart=app.indexOf('window.cancelManualSupplyOutstanding = async function');
    const cancelEnd=app.indexOf('\nwindow.cancelPurchaseOrderOutstanding',cancelStart);
    const cancelSource=app.slice(cancelStart,cancelEnd);
    assert.ok(cancelStart>=0&&cancelEnd>cancelStart);
    assert.match(cancelSource,/canCreatePurchaseOrderCapability\(\)/);
    assert.match(cancelSource,/supply\.type !== 'PURCHASING_MANUAL'/);
    assert.match(cancelSource,/const actionKey = `supply:\$\{supplyId\}`/);
    assert.match(cancelSource,/purchaseCancellationInProgress\.add\(actionKey\)/);
    assert.match(cancelSource,/await cancelOutstandingSupplyRecord\(/);
    assert.match(cancelSource,/supplyReceivingCache = supplyReceivingCache\.filter\(row => row\.id !== supply\.id\)/);
    assert.match(cancelSource,/refreshAffectedOrderCaches\(\[result\.orderId\]\)/);
    assert.match(cancelSource,/purchaseCancellationInProgress\.delete\(actionKey\)/);
});

test('quick manual cancellation reuses the same audited cancellation transaction as formal PO cancellation', () => {
    const coreStart=app.indexOf('async function cancelOutstandingSupplyRecord');
    const coreEnd=app.indexOf('\nwindow.cancelManualSupplyOutstanding',coreStart);
    const coreSource=app.slice(coreStart,coreEnd);
    assert.match(coreSource,/incoming:Math\.max\(0,inv\.incoming-registeredIncoming\)/);
    assert.match(coreSource,/incoming:Math\.max\(0,wh\.incoming-registeredIncoming\)/);
    assert.match(coreSource,/supplyOrderedQty:Math\.max\(receivedForItem,currentSupplyOrdered-remaining\)/);
    assert.match(coreSource,/type:'purchase_incoming_cancel'/);
    assert.match(coreSource,/status:'CANCELLED'/);
    assert.match(coreSource,/incomingRegisteredQty:0/);

    const formalStart=app.indexOf('window.cancelPurchaseOrderOutstanding = async function');
    const formalEnd=app.indexOf('\nlet poReceiptTargetId',formalStart);
    const formalSource=app.slice(formalStart,formalEnd);
    assert.match(formalSource,/cancelOutstandingSupplyRecord\(poId,supplyId,reason\)/);
});


test('quick purchase outstanding cancellation reuses safe supply cancellation', () => {
    const actionStart=app.indexOf('function manualSupplyCancelActionHtml');
    const actionEnd=app.indexOf('\nfunction receivingWorkProgress',actionStart);
    const actionSource=app.slice(actionStart,actionEnd);
    assert.ok(actionStart>=0&&actionEnd>actionStart);
    assert.match(actionSource,/supply\.type !== 'PURCHASING_MANUAL'/);
    assert.match(actionSource,/status \|\| ''\)\.toUpperCase\(\) === 'CANCELLED'/);
    assert.match(actionSource,/const remaining = Math\.max\(0, Number\(supply\.qty \|\| 0\) - Number\(supply\.receivedQty \|\| 0\)\)/);
    assert.match(actionSource,/cancelManualSupplyOutstanding/);

    const cancelStart=app.indexOf('window.cancelManualSupplyOutstanding = async function');
    const cancelEnd=app.indexOf('\nwindow.cancelPurchaseOrderOutstanding',cancelStart);
    const cancelSource=app.slice(cancelStart,cancelEnd);
    assert.ok(cancelStart>=0&&cancelEnd>cancelStart);
    assert.match(cancelSource,/canCreatePurchaseOrderCapability\(\)/);
    assert.match(cancelSource,/supply\.type !== 'PURCHASING_MANUAL'/);
    assert.match(cancelSource,/purchaseCancellationInProgress\.add\(actionKey\)/);
    assert.match(cancelSource,/await cancelOutstandingSupplyRecord\(/);
    assert.match(cancelSource,/supplyReceivingCache = supplyReceivingCache\.filter/);
    assert.match(cancelSource,/refreshAffectedOrderCaches\(\[result\.orderId\]\)/);
    assert.match(cancelSource,/purchaseCancellationInProgress\.delete\(actionKey\)/);
});

test('purchase order email/share uses supplier master email and generated PDF blob', () => {
    assert.match(app, /function purchaseOrderSupplierContact\(po=\{\}\)/);
    assert.match(app, /email:\s*normalizeSupplierEmail\(live\?\.email \|\| po\.supplierEmail \|\| ''\)/);
    assert.match(app, /window\.emailPurchaseOrder = async function\(poId\)/);
    assert.match(app, /printSavedPoDocument\(po\.poNo,po\.vendorName,\{download:false\}\)/);
    assert.match(app, /navigator\.canShare\(\{files:\[file\]\}\)/);
    assert.match(app, /mailto:\$\{contact\.email\}/);
    assert.match(app, /lastShareType:shared\?'WEB_SHARE':'MAILTO'/);
});

test('purchase order PDF renderer can return a blob without downloading', () => {
    const start=app.indexOf('async function printSavedPoDocument(poNo, vendorName)');
    const end=app.indexOf('\n\nwindow.printPurchaseOrder',start);
    const source=app.slice(start,end);
    assert.match(source,/const download = options\.download !== false/);
    assert.match(source,/const blob=pdf\.output\('blob'\)/);
    assert.match(source,/if\(download\)/);
    assert.match(source,/return \{blob,fileName\}/);
});

test('supplier master stores one canonical email field and PO snapshots supplierEmail', () => {
    assert.match(app,/email:savedSupplierEmail/);
    assert.match(app,/supplierEmail:normalizeSupplierEmail\(supplierContact\?\.email\|\|''\)/);
    assert.doesNotMatch(app,/poVendorEmail|purchaseEmail|vendorEmail/);
});

test('supplier master stores email and preserves it across brand mappings', () => {
    assert.match(html,/id="supplierMasterEmail"/);
    assert.match(html,/<th>Email<\/th>/);
    const start=app.indexOf('window.saveSupplierMapping = async function');
    const end=app.indexOf('\nwindow.disableSupplierMapping',start);
    const source=app.slice(start,end);
    assert.match(source,/supplierMasterEmail/);
    assert.match(source,/savedSupplierEmail=supplierEmail\|\|normalizeSupplierEmail\(existingSupplier\?\.email\|\|''\)/);
    assert.match(source,/email:savedSupplierEmail/);
});

test('purchase order snapshots supplier identity and email onto PO and supply records', () => {
    const start=app.indexOf('const supplierContact = supplierForVendorName\(vendorName\);');
    const end=app.indexOf('poRecord.searchTokens=purchaseOrderSearchTokens',start);
    const source=app.slice(start,end);
    assert.match(source,/supplierId:supplierContact\?\.id\|\|supplierContact\?\.supplierId\|\|''/);
    assert.match(source,/supplierName:supplierContact\?\.supplierName\|\|vendorName/);
    assert.match(source,/supplierEmail:normalizeSupplierEmail\(supplierContact\?\.email\|\|''\)/);
    const supplyStart=app.indexOf('const supplyRecord={',end);
    const supplyEnd=app.indexOf('transaction.set\(supplyRef,supplyRecord\)',supplyStart);
    const supplySource=app.slice(supplyStart,supplyEnd);
    assert.match(supplySource,/supplierId:poRecord\.supplierId\|\|''/);
    assert.match(supplySource,/supplierEmail:poRecord\.supplierEmail\|\|''/);
});

test('saved PO can prepare a PDF blob and share through any mail app with mailto fallback', () => {
    assert.match(html,/id="emailPurchaseOrderBtn"/);
    const pdfStart=app.indexOf('async function printSavedPoDocument\(poNo, vendorName\)');
    const pdfEnd=app.indexOf('\n\nwindow.printPurchaseOrder',pdfStart);
    const pdfSource=app.slice(pdfStart,pdfEnd);
    assert.match(pdfSource,/pdf\.output\('blob'\)/);
    assert.match(pdfSource,/const download = options\.download !== false/);
    assert.match(pdfSource,/pdf\.save\(fileName\)/);

    const mailStart=app.indexOf('window.emailPurchaseOrder = async function');
    const mailEnd=app.indexOf('\n\n\/\/ 從原始訂單上的訂購單號',mailStart);
    const mailSource=app.slice(mailStart,mailEnd);
    assert.match(mailSource,/navigator\.canShare/);
    assert.match(mailSource,/navigator\.share/);
    assert.match(mailSource,/mailto:\$\{contact\.email\}/);
    assert.match(mailSource,/new File\(\[attachment\.blob\]/);
});

test('vendor suggestions include Supplier Master before purchase history', () => {
    const start=app.indexOf('function populatePoVendorSuggestions\(\)');
    const end=app.indexOf('\n\nwindow.closePurchaseOrderModal',start);
    const source=app.slice(start,end);
    assert.match(source,/supplierMasterCache\.forEach/);
    assert.match(source,/poListCache\.forEach/);
});

test('purchasing analytics workspace is lazy and based on supplyOrders', () => {
    assert.match(html,/id="purchase-tab-analysis"/);
    assert.match(html,/id="purchaseAnalyticsPanel"/);
    assert.match(html,/id="purchaseAnalyticsSupplierBody"/);
    assert.match(app,/window\.loadPurchasingAnalytics = async function\(force = false\)/);
    assert.match(app,/db\.collection\('supplyOrders'\)/);
    assert.match(app,/\['history', 'analytics'\]\.includes\(view\)/);
    assert.match(app,/purchasingAnalyticsLoadedRangeKey !== rangeKey/);
});

test('purchasing analytics delegates accounting rules to its core module', () => {
    assert.match(app,/YushinPurchasingAnalytics\?\.summarize/);
    assert.doesNotMatch(app,/function purchasingAnalyticsProjection/);
});

test('purchasing analytics treats cancelled remainder as removed', () => {
    const analytics=require('../modules/purchasing-analytics-core.js');
    const cancelled=analytics.projectSupply({
        qty:10,receivedQty:4,status:'CANCELLED',unitCost:100,
        method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1'
    });
    assert.equal(cancelled.effectiveOrderedQty,4);
    assert.equal(cancelled.receivedQty,4);
    assert.equal(cancelled.incomingQty,0);
    assert.equal(cancelled.orderedAmount,400);
    assert.equal(cancelled.receivedAmount,400);
    assert.equal(cancelled.incomingAmount,0);
});

test('purchasing analytics separates stock replenishment from customer-order purchasing', () => {
    const analytics=require('../modules/purchasing-analytics-core.js');
    assert.equal(analytics.projectSupply({
        qty:2,unitCost:50,method:'PURCHASING_PO',sourceType:'STOCK_REPLENISHMENT'
    }).isStockReplenishment,true);
    assert.equal(analytics.projectSupply({
        qty:2,unitCost:50,method:'PURCHASING_PO',sourceType:'SALES_ORDER',sourceId:'O1'
    }).isStockReplenishment,false);
});

test('new supply records keep method and demand source separate for analytics filters', () => {
    assert.match(app,/type:'SALES_SELF_ORDER',method:'SALES_SELF_ORDER'[\s\S]*?sourceType:'SALES_ORDER'[\s\S]*?salesName:order\.salesName\|\|currentUserName\|\|''/);
    assert.match(app,/type:'PURCHASING_PO'[\s\S]*?method:'PURCHASING_PO'[\s\S]*?sourceType:item\.orderId\?'SALES_ORDER':'STOCK_REPLENISHMENT'[\s\S]*?salesName:item\.salesName\|\|''/);
});