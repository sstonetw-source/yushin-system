const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const reservation = require('../modules/reservation-core.js');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const cssSource = fs.readFileSync(path.join(__dirname, '..', 'styles.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const rulesSource = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
const firestoreIndexes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));

function loadPurchaseMapper() {
    const start = appSource.indexOf('function purchaseItemsFromOrder(order)');
    const end = appSource.indexOf('\n}\n\nfunction bestPurchaseOrderCompany', start) + 2;
    assert.ok(start >= 0 && end > start, 'purchaseItemsFromOrder must exist');
    const context = {
        priceItemLookup: new Map([
            ['code:a-1', { cost: 25 }],
            ['brand:acme:b-2', { cost: 40 }]
        ]),
        purchaseCostCache: new Map(),
        stableProductId: item => 'prd:' + String(item?.brand || '').toLowerCase() + ':' + String(item?.model || ''),
        authorizationTypeForProduct: () => 'NON_AUTHORIZED',
        normalizeItemCode: value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLowerCase(),
        remainingProcurementQty: (order, item) => {
            const ordered = Math.max(0, Number(item.supplyOrderedQty || 0));
            const received = Math.max(0, Number(item.receivedQty || 0));
            if ((item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') {
                return Math.max(0, Number(item.orderedQty ?? item.qty ?? 0) + Number(item.returnedQty || 0) - ordered);
            }
            return Math.max(0, Number(item.shortageQty || 0) - Math.max(0, ordered - received));
        }
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    return context.purchaseItemsFromOrder;
}

function loadSavedPurchaseMapper() {
    const start = appSource.indexOf('function purchaseItemsFromSavedPo(po)');
    const end = appSource.indexOf('\n}\n\n// 將不同時期', start) + 2;
    assert.ok(start >= 0 && end > start, 'purchaseItemsFromSavedPo must exist');
    const context = {};
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    return context.purchaseItemsFromSavedPo;
}

test('purchase mapper supports canonical single-item orders', () => {
    const items = loadPurchaseMapper()({ id: 'one', itemName: 'Single', itemCode: 'A-1', brand: 'Acme', qty: '3', shortageQty: 3 });
    assert.equal(items.length, 1);
    assert.deepEqual({ name: items[0].itemName, qty: items[0].qty, cost: items[0].unitPrice }, { name: 'Single', qty: 3, cost: 25 });
});

test('purchase mapper expands modern multi-item orders and field aliases', () => {
    const items = loadPurchaseMapper()({
        id: 'new',
        items: [
            { productName: 'First', productCode: 'A-1', quantity: 2, shortageQty: 2 },
            { name: 'Second', model: 'B-2', manufacturer: 'Acme', count: '4', shortageQty: 4 }
        ]
    });
    assert.equal(items.length, 2);
    assert.deepEqual(items.map(item => [item.itemName, item.qty, item.unitPrice]), [
        ['First', 2, 25],
        ['Second', 4, 40]
    ]);
});

test('purchase mapper supports products and embedded purchase prices', () => {
    const [item] = loadPurchaseMapper()({ id: 'alt', products: [{ nameCn: 'Third', code: 'C-3', qty: 5, shortageQty: 5, purchasePrice: 12 }] });
    assert.deepEqual([item.itemName, item.itemCode, item.qty, item.unitPrice], ['Third', 'C-3', 5, 12]);
});

test('saved purchase orders remain readable with alternate item containers', () => {
    const items = loadSavedPurchaseMapper()({
        orderItems: [{ productName: 'Saved', productCode: 'P-1', quantity: '6', costPrice: '18' }]
    });
    assert.equal(items.length, 1);
    assert.deepEqual([items[0].itemName, items[0].itemCode, items[0].qty, items[0].unitPrice], ['Saved', 'P-1', 6, 18]);
    const [legacyRoot] = loadSavedPurchaseMapper()({ itemName: 'Root', itemCode: 'R-1', qty: 2, unitPrice: 9 });
    assert.deepEqual([legacyRoot.itemName, legacyRoot.qty, legacyRoot.unitPrice], ['Root', 2, 9]);
});

test('order refresh stays paginated and status writes have an in-flight guard', () => {
    const loaderStart = appSource.indexOf('window.loadOrdersFromCloud =');
    const loaderEnd = appSource.indexOf('\n};', loaderStart) + 3;
    const loader = appSource.slice(loaderStart, loaderEnd);
    assert.match(loader, /loadOrderPage\(true\)/);
    assert.doesNotMatch(loader, /while\s*\(/);
    assert.match(appSource, /pendingOrderStatusKeys\.has\(pendingKey\)/);
    assert.match(appSource, /pendingOrderStatusKeys\.delete\(pendingKey\)/);
    const roleSwitchStart = appSource.indexOf('window.switchViewRole =');
    const roleSwitchEnd = appSource.indexOf('\n};', roleSwitchStart) + 3;
    const roleSwitch = appSource.slice(roleSwitchStart, roleSwitchEnd);
    assert.doesNotMatch(roleSwitch, /loadMyQuotesFromCloud\(\)|loadOrdersFromCloud\(\)|loadEquipmentFromCloud\(\)/);
});

test('order loading recovers from suspended mobile reads without blanking cached rows', () => {
    assert.match(appSource, /FIRESTORE_READ_TIMEOUT_MS/);
    assert.match(appSource, /firestoreReadWithTimeout\(query\.get\(\), '訂單'\)/);
    assert.match(appSource, /orderLoadGeneration/);
    assert.match(appSource, /loadOrderPage\(true, \{ force: true, silent: true \}\)/);
    assert.match(appSource, /document\.addEventListener\('visibilitychange'/);
    assert.match(appSource, /window\.addEventListener\('pageshow'/);
    assert.doesNotMatch(appSource, /orderPaginationState = createOrderPaginationState\(\);\s*ordersCache = \[\];/);
    assert.match(cssSource, /#appContainer\.resume-repaint/);
    assert.match(indexSource, /styles\.css\?v=\d{8}-\d+/);
    assert.match(indexSource, /app\.js\?v=\d{8}-\d+/);
});

test('product management uses complete paginated server search without exposing protected cost data', () => {
    assert.match(indexSource, /id="product-system"/);
    assert.match(indexSource, /data-main-nav="products"/);
    const searchStart = appSource.indexOf('window.searchProductManagement =');
    const searchEnd = appSource.indexOf('\n};', searchStart) + 3;
    const productSearch = appSource.slice(searchStart, searchEnd);
    assert.match(productSearch, /db\.collection\('products'\)/);
    assert.match(productSearch, /while \(true\)/);
    assert.match(productSearch, /orderBy\(field\)/);
    assert.match(productSearch, /startAt\(value\)/);
    assert.match(productSearch, /endAt\(value \+ '\\uf8ff'\)/);
    assert.match(productSearch, /limit\(DEFAULT_LIST_LIMIT\)/);
    assert.match(productSearch, /firestoreReadWithTimeout\(query\.get\(\), label\)/);
    assert.match(productSearch, /generation !== productManagementSearchGeneration/);
    assert.doesNotMatch(productSearch, /slice\(0, 50\)/);
    assert.doesNotMatch(productSearch, /productCosts|loadVisibleProductCost/);
    assert.match(appSource, /window\.addProductManagementToQuote/);
    assert.match(appSource, /window\.addProductManagementToOrder/);
});

test('inventory product lookup debounces server search', () => {
    assert.match(indexSource, /id="businessProductSearch"[^>]+oninput="queueBusinessProductSearch\(\)"/);
    assert.match(appSource, /businessProductSearchTimer=scheduleListSearch\(businessProductSearchTimer,\(\)=>searchBusinessProducts\(\)\)/);
    assert.match(appSource, /db\.collection\('products'\).*limit\(25\)/s);
});

test('product management debounces full Product Master search', () => {
    assert.match(indexSource, /oninput="queueProductManagementSearch\(\)"/);
    assert.match(appSource, /productManagementSearchTimer = scheduleListSearch\(productManagementSearchTimer, \(\) => searchProductManagement\(\)\)/);
    assert.match(appSource, /scanPrefix\('normalizedPartNo', normalized/);
    assert.match(appSource, /scanPrefix\('productName', raw/);
    assert.match(appSource, /scanPrefix\('nameEn', raw/);
    assert.match(indexSource, /搜尋會查完整 Product Master/);
});

test('preview host selects isolated Firebase project and exposes a visible environment banner', () => {
    assert.match(appSource, /preview-20135\.firebaseapp\.com/);
    assert.match(appSource, /preview-20135\.web\.app/);
    assert.match(appSource, /projectId: "preview-20135"/);
    assert.match(appSource, /APP_ENVIRONMENT === 'preview'/);
    assert.match(indexSource, /PREVIEW／測試環境｜資料與正式系統分離/);
});

test('quote owner selector lets engineer assist sales while keeping sales self-only', () => {
    assert.match(appSource, /function populateSalesDropdown\(\)/);
    const start = appSource.indexOf('function populateSalesDropdown()');
    const end = appSource.indexOf('\n}\n', start) + 2;
    const selector = appSource.slice(start, end);
    assert.match(selector, /if \(currentUserRole === 'sales'\) return s\.uid === currentUser\?\.uid/);
    assert.match(selector, /if \(currentUserRole === 'engineer'\) return s\.uid === currentUser\?\.uid \|\| role === 'sales'/);
    assert.match(selector, /return role === 'sales' \|\| role === 'engineer'/);
    assert.match(selector, /\? currentUserName : ''/);
    assert.match(rulesSource, /function engineerAssistedSalesQuote/);
    assert.match(rulesSource, /match \/quotes\/\{id\}[\s\S]*?engineerAssistedSalesQuote\(request\.resource\.data\)/);
});

test('Brand Master drives the main brand list while statistics grouping remains independent', () => {
    assert.match(appSource, /function initializePageData\(mainKey, options = \{\}\)[\s\S]*?ensureBrandSettingsLoaded\(\)/);
    assert.match(appSource, /function ensureBrandSettingsLoaded\(\)[\s\S]*?loadSalesStatisticsSettings\(\), loadCompanyAgencyBrandSettings\(\), loadBrandMaster\(\)/);
    const start = appSource.indexOf('function getUnifiedBrandEntries(includeMaintenance = false)');
    const end = appSource.indexOf('\n}\n', start) + 2;
    const context = vm.createContext({
        keyStatisticBrands:['Roche', 'Thermo'],
        brandMasterCache:[{ id:'r', name:'Roche', aliases:['Roche Diagnostics'], active:true }, { id:'x', name:'Unlisted Excel Brand', active:true }],
        keyStatisticBrandAliases:{}, companyAgencyBrands:{ yushin:[], morningstar:[], 'MULTI-LIFE':[] },
        normalizeBrandLookupKey:value => String(value || '').trim().toLowerCase(),
        dedupeBrandsCaseInsensitive:values => [...new Set(values)],
        includesBrandCaseInsensitive:(values, name) => values.includes(name)
    });
    vm.runInContext(appSource.slice(start, end), context);
    assert.deepEqual(Array.from(context.getUnifiedBrandEntries(false), item => item.name), ['Roche', 'Unlisted Excel Brand']);
    assert.deepEqual(new Set(Array.from(context.getUnifiedBrandEntries(true), item => item.name)), new Set(['Roche', 'Unlisted Excel Brand', '維修']));
    const classificationStart = appSource.indexOf('function statisticBrandForOrder(order)');
    const classificationEnd = appSource.indexOf('\n}\n', classificationStart) + 2;
    Object.assign(context, {
        statisticBrandAliasLookup:() => new Map([['roche', 'Roche'], ['thermo', 'Thermo']]),
        normalizeStatisticBrandKey:value => String(value || '').trim().toLowerCase()
    });
    vm.runInContext(appSource.slice(classificationStart, classificationEnd), context);
    assert.equal(context.statisticBrandForOrder({ brand:'Roche' }), 'Roche');
    assert.equal(context.statisticBrandForOrder({ brand:'Unlisted Excel Brand' }), '其他廠牌');
    assert.equal(context.statisticBrandForOrder({ brand:'' }), '其他廠牌');
    assert.equal(context.statisticBrandForOrder({ brand:'維修' }), '維修');
});

test('multi-brand sales statistics split delivery and returns by item without duplicating amounts', () => {
    const start = appSource.indexOf('function salesStatisticOrderLines(order)');
    const end = appSource.indexOf('\n}\n', start) + 2;
    const context = vm.createContext({
        normalizedOrderItems:order => order.items,
        savedDeliveryRecords:order => order.deliveryRecords || [],
        savedReturnRecords:order => order.returnRecords || []
    });
    vm.runInContext(appSource.slice(start, end), context);
    const order = { id:'O-1', brand:'Roche', totalPrice:350,
        items:[
            { itemId:'a', itemName:'A', brand:'Roche', productLine:'試劑', qty:2, unitPrice:100, totalPrice:200 },
            { itemId:'b', itemName:'B', brand:'Other', productLine:'耗材', qty:3, unitPrice:50, totalPrice:150 }
        ],
        deliveryRecords:[{ itemId:'a', qty:1, date:'2026-09-29' }, { itemId:'b', qty:2, date:'2026-09-29' }],
        returnRecords:[{ itemId:'b', qty:1, date:'2026-09-29' }]
    };
    const lines = context.salesStatisticOrderLines(order);
    assert.deepEqual(Array.from(lines, line => line.brand), ['Roche', 'Other']);
    assert.equal(lines.reduce((sum, line) => sum + line.totalPrice, 0), 350);
    assert.deepEqual(Array.from(lines, line => line.deliveryRecords.length), [1, 1]);
    assert.deepEqual(Array.from(lines, line => line.returnRecords.length), [0, 1]);
    assert.deepEqual(Array.from(lines, line => line.productLine), ['試劑', '耗材']);
    const contributionStart = appSource.indexOf('function calculateOrderStatsContribution(order, start, end)');
    const contributionEnd = appSource.indexOf('\n}\n', contributionStart) + 2;
    Object.assign(context, {
        normalizedOrderStatus:() => 'normal',
        orderQuantity:line => Number(line.qty || 0),
        orderUnitSalesAmount:line => line.totalPrice / line.qty,
        orderUnitCostForStats:() => null,
        dateInStatsRange:(date, start, end) => !!date && date >= start && date <= end,
        localDateString:() => '2026-09-29'
    });
    vm.runInContext(appSource.slice(contributionStart, contributionEnd), context);
    const contributions = lines.map(line => context.calculateOrderStatsContribution(line, '2026-09-01', '2026-09-30'));
    assert.equal(contributions.reduce((sum, row) => sum + row.actualSales, 0), 150);
    assert.equal(contributions.reduce((sum, row) => sum + row.pendingSales, 0), 200);
    assert.equal(contributions.reduce((sum, row) => sum + row.actualSales + row.pendingSales, 0), 350);
});

test('purchaser order form assigns a salesperson while preserving creator identity', () => {
    assert.match(indexSource, /id="orderOwnerUid"/);
    const start = appSource.indexOf('window.saveNewOrder = function()');
    const end = appSource.indexOf('\n};', start) + 3;
    const saveOrder = appSource.slice(start, end);
    assert.match(saveOrder, /currentUserRole === 'purchaser' && !assistedOwner/);
    assert.match(saveOrder, /ownerUid: assistedOwner\?\.uid \|\| window\._orderModalQuoteContext\?\.ownerUid \|\| currentUser\?\.uid/);
    assert.match(saveOrder, /\.\.\.commercialCreatorFields\(\)/);
});

test('low-stock inventory can hand off to formal replenishment purchase flow without duplicating incoming stock', () => {
    assert.match(appSource, /openInventoryReplenishment/);
    assert.match(appSource, /safetyStock>0 && n\.available<=safetyStock && n\.available\+n\.incoming<safetyStock && canEditPage\('orders\.po'\)/);
    const start=appSource.indexOf('window.openInventoryReplenishment');
    const end=appSource.indexOf('\nwindow.setInventorySafetyStock',start);
    const source=appSource.slice(start,end);
    assert.match(source,/YushinProcurementDemand\?\.fromStockReplenishment/);
    assert.match(source,/safetyStock,/);
    assert.match(source,/available:stock\.available/);
    assert.match(source,/incoming:stock\.incoming/);
    assert.match(source,/demand\.remainingToOrderQty > 0/);
    assert.match(source,/不需重複建立補庫採購/);
    assert.match(source,/const suggestedQty = demand\.remainingToOrderQty/);
    assert.match(source,/poDirectStockMode = true/);
    assert.match(source,/generatePoNo\(\)/);
});

test('purchase document history shows document age while arrival work uses supply timing', () => {
    assert.match(appSource, /function poWaitingDays\(po\)/);
    assert.match(appSource, /return waitingDaysFromDate\(po\.poDate\)/);
    assert.match(appSource, /primaryStatus==='arrival'\?waitingDaysFromDate\(item\.orderedAt\)/);
    assert.match(appSource, /data-th="建立天數"/);
    assert.match(appSource, /function purchaseHistoryItemReceiptProgress/);
    assert.match(appSource, /YushinSupply\.receiptProgress/);
    assert.match(appSource, /data-th="文件狀態"[\s\S]{0,120}receiptProgress\.label/);
});

test('main navigation exposes focused order and purchasing workspaces', () => {
    assert.match(indexSource, /data-main-nav="orders"/);
    assert.match(indexSource, /data-main-nav="purchasing"/);
    assert.match(appSource, /window\.openOrderWorkspace/);
    assert.match(appSource, /window\.openPurchasingWorkspace/);
});

test('agency settings do not trigger a full orders statistics query', () => {
    const switchStart = appSource.indexOf('window.switchAdminTab =');
    const switchEnd = appSource.indexOf('\n};', switchStart) + 3;
    const adminSwitch = appSource.slice(switchStart, switchEnd);
    const agencyLine = adminSwitch.split('\n').find(line => line.includes("tab === 'agencies'"));
    assert.ok(agencyLine);
    assert.doesNotMatch(agencyLine, /loadSalesStatistics/);
    const statisticsLine = adminSwitch.split('\n').find(line => line.includes("tab === 'statistics'"));
    assert.match(statisticsLine, /salesStatisticsOrders\.length/);
});

test('saving one new order updates the local cache without reloading the list', () => {
    const saveStart = appSource.indexOf('window.saveNewOrder =');
    const saveEnd = appSource.indexOf('\n};', saveStart) + 3;
    const saveOrder = appSource.slice(saveStart, saveEnd);
    assert.match(saveOrder, /newOrderSaveInProgress/);
    assert.match(saveOrder, /ordersCache\s*=\s*\[/);
    assert.match(saveOrder, /renderOrdersList\(\)/);
    assert.doesNotMatch(saveOrder, /loadOrdersFromCloud\(\)/);
    assert.match(saveOrder, /findPriceItemForOrder\(data\)/);
});

test('new order reports committed success even when source quote update fails', async () => {
    const start = appSource.indexOf("    let createdOrderId = '';", appSource.indexOf('window.saveNewOrder ='));
    const end = appSource.indexOf('\n};', start);
    assert.ok(start > 0 && end > start);
    const saveChain = appSource.slice(start, end).replace('    createOrResumeNewOrder(data)', '    return createOrResumeNewOrder(data)');
    const feedbackStart = appSource.indexOf('let actionFeedbackTimer = null;');
    const feedbackEnd = appSource.indexOf('\nwindow.saveNewOrder =', feedbackStart);
    const messages = [];
    const elements = new Map();
    const context = vm.createContext({
        window:{_orderModalQuoteContext:null},
        document:{getElementById:id=>elements.get(id)||null,createElement:()=>({setAttribute(){}}),body:{appendChild:node=>elements.set(node.id,node)}},
        setTimeout:()=>1,clearTimeout:()=>{},
        db:{collection:name=>name==='orders'?{
            doc:()=>({set:async()=>{}})
        }:{doc:()=>({set:async()=>{throw new Error('估價單更新失敗');}})}},
        createOrResumeNewOrder:async data=>({id:'NEW-1',data}),
        data:{sourceType:'QUOTE',sourceId:'Q-1',customerName:'Customer',orderDate:'2026-09-27'},
        DOCUMENT_TYPES:{QUOTE:'QUOTE',FORECAST:'FORECAST',ORDER:'ORDER'},
        BUSINESS_STATUS:{COMPLETED:'completed'},
        firebase:{firestore:{FieldValue:{arrayUnion:()=>({})}}},
        reserveInventoryForNewOrder:async()=>({reservedQty:1,shortageQty:0}),
        inventoryProductKey:()=>'',rememberRecentCustomerName:()=>{},localDateString:()=>'',documentLink:()=>({}),
        myQuotesCache:[],quoteHistorySearchResults:[],ordersCache:[],
        clearSavedOrderDraft:()=>{},closeOrderModal:()=>{},writeAppDataCache:()=>{},renderOrdersList:()=>{},syncOrderIntoPurchasingCaches:()=>{},
        saveButton:{disabled:true,innerText:'儲存中…'},newOrderSaveInProgress:true,
        alert:message=>messages.push(message),console:{error:()=>{}}
    });
    vm.runInContext(appSource.slice(feedbackStart, feedbackEnd), context);
    await vm.runInContext(`(async function(){${saveChain}})()`, context);
    assert.equal(context.ordersCache[0].id,'NEW-1');
    assert.equal(context.newOrderSaveInProgress,false);
    assert.equal(messages.length,1);
    assert.match(messages[0],/訂單已建立.*估價單未標記成交.*請勿重複建立/);
    assert.doesNotMatch(messages[0],/新增失敗/);
    context.data={sourceType:'',customerName:'Customer',orderDate:'2026-09-27'};
    messages.length=0;
    await vm.runInContext(`(async function(){${saveChain}})()`, context);
    assert.equal(messages.length,0);
    assert.match(elements.get('actionFeedback').textContent,/訂單已建立，庫存占用已同步/);
    context.data={sourceType:'',customerName:'Customer',orderDate:'2026-09-27'};
    context.reserveInventoryForNewOrder=async()=>{throw new Error('庫存同步失敗');};
    await vm.runInContext(`(async function(){${saveChain}})()`, context);
    assert.equal(messages.length,1);
    assert.match(messages[0],/訂單編號 NEW-1.*重試同一張訂單.*庫存同步失敗/);
    assert.doesNotMatch(messages[0],/新增失敗/);
});

test('new order creation keeps one document ID across uncertain writes and retries', async () => {
    const start=appSource.indexOf('function orderDraftStorageKey()');
    const end=appSource.indexOf('function orderDraftFieldValue(',start);
    const stored=new Map();
    const documents=new Map();
    let writes=0, uncertain=false;
    const context=vm.createContext({
        ORDER_DRAFT_STORAGE_PREFIX:'order_draft_v2',currentUser:{uid:'USER-1'},
        BUSINESS_STATUS:{ACTIVE:'active'},
        localStorage:{getItem:key=>stored.get(key)||null,setItem:(key,value)=>stored.set(key,value)},
        db:{collection:()=>({doc:id=>({id:id||'ORDER-1'})}),runTransaction:async callback=>{
            let pending;
            await callback({get:async ref=>({exists:documents.has(ref.id),data:()=>documents.get(ref.id)}),
                set:(ref,data)=>{pending={id:ref.id,data};}});
            if(pending){documents.set(pending.id,pending.data);writes++;}
            if(uncertain){uncertain=false;throw new Error('連線中斷，回覆不確定');}
        }}
    });
    vm.runInContext(appSource.slice(start,end),context);
    uncertain=true;
    const order={createdByUid:'USER-1',status:'active',inventoryReservationStatus:'pending'};
    await assert.rejects(context.createOrResumeNewOrder(order),/回覆不確定/);
    assert.equal(stored.get('order_draft_v2:USER-1:pending_order_id'),'ORDER-1');
    const resumed=await context.createOrResumeNewOrder({createdByUid:'USER-1',status:'active',customerName:'不同內容'});
    assert.equal(resumed.id,'ORDER-1');
    assert.equal(resumed.data.customerName,undefined,'retry uses the already committed order');
    assert.equal(writes,1,'retry never creates a second order');
    documents.get('ORDER-1').inventoryReservationStatus='completed';
    assert.equal((await context.createOrResumeNewOrder(order)).data.inventoryReservationStatus,'completed');
    assert.equal(writes,1);
});

test('retrying a partly reserved order does not reserve the same stock twice', async () => {
    const start=appSource.indexOf('async function reserveSingleOrderItem(');
    const end=appSource.indexOf('async function reserveInventoryForNewOrder(',start);
    const rows=new Map([
        ['inventory/P-1',{onHand:10,reserved:0}],
        ['warehouseStocks/W-1__P-1',{onHand:10,reserved:0}]
    ]);
    let reserveMovements=0;
    const db={collection:name=>({doc:id=>({id:`${name}/${id||'MOVEMENT'}`})}),runTransaction:async callback=>{
        const writes=[];
        const result=await callback({
            get:async ref=>({exists:rows.has(ref.id),data:()=>rows.get(ref.id)}),
            update:(ref,patch)=>writes.push(()=>rows.set(ref.id,{...rows.get(ref.id),...patch})),
            set:(ref,patch)=>writes.push(()=>{
                if(ref.id.startsWith('inventoryMovements/') && patch.type==='reserve')reserveMovements++;
                rows.set(ref.id,{...rows.get(ref.id),...patch});
            })
        });
        writes.forEach(write=>write());
        return result;
    }};
    const context=vm.createContext({
        db,YushinReservation:reservation,currentUserName:'Staff',currentUser:{uid:'USER-1'},
        inventoryProductKey:()=> 'P-1',defaultWarehouse:()=>({id:'W-1'}),
        inventoryRefFor:()=>db.collection('inventory').doc('P-1'),
        warehouseStockDocId:()=> 'W-1__P-1',
        inventoryNumbers:row=>({onHand:row.onHand||0,reserved:row.reserved||0,available:(row.onHand||0)-(row.reserved||0)}),
        inventoryMovementRecord:(type,quantity)=>({type,quantity}),
        salesCodeForName:()=>'',invalidateWarehouseStockCache:()=>{},
        YushinReservation:reservation
    });
    vm.runInContext(appSource.slice(start,end),context);
    const order={customerName:'Customer',orderDate:'2026-09-28',salesCode:'S1'};
    const item={itemId:'item-1',qty:4,fulfillmentType:'WAREHOUSE',warehouseId:'W-1'};
    const first=await context.reserveSingleOrderItem('ORDER-1',order,item,0);
    const retry=await context.reserveSingleOrderItem('ORDER-1',order,item,0);
    assert.equal(first.reservedQty,4);
    assert.equal(retry.reservedQty,4);
    assert.equal(rows.get('inventory/P-1').reserved,4);
    assert.equal(rows.get('warehouseStocks/W-1__P-1').reserved,4);
    assert.equal(rows.get('inventoryReservations/ORDER-1__item-1').quantity,4);
    assert.equal(reserveMovements,1);
});


test('moving an order reservation between warehouses releases the old stock before reserving the new stock', async () => {
    const start=appSource.indexOf('async function reserveSingleOrderItem(');
    const end=appSource.indexOf('async function reserveInventoryForNewOrder(',start);
    const rows=new Map([
        ['inventory/P-1',{onHand:15,reserved:4}],
        ['warehouseStocks/W-1__P-1',{onHand:5,reserved:4}],
        ['warehouseStocks/W-2__P-1',{onHand:10,reserved:0}],
        ['inventoryReservations/ORDER-1__item-1',{quantity:4,productKey:'P-1',warehouseId:'W-1'}]
    ]);
    const movements=[];
    let sequence=0;
    const db={collection:name=>({doc:id=>({id:`${name}/${id||'MOV-'+(++sequence)}`})}),runTransaction:async callback=>{
        const writes=[];
        const result=await callback({
            get:async ref=>({exists:rows.has(ref.id),data:()=>rows.get(ref.id)}),
            update:(ref,patch)=>writes.push(()=>rows.set(ref.id,{...rows.get(ref.id),...patch})),
            set:(ref,patch)=>writes.push(()=>{
                if(ref.id.startsWith('inventoryMovements/'))movements.push(patch);
                rows.set(ref.id,{...rows.get(ref.id),...patch});
            })
        });
        writes.forEach(write=>write());
        return result;
    }};
    const context=vm.createContext({
        db,currentUserName:'Staff',currentUser:{uid:'USER-1'},
        inventoryProductKey:()=> 'P-1',defaultWarehouse:()=>({id:'W-1'}),
        inventoryRefFor:()=>db.collection('inventory').doc('P-1'),
        warehouseStockDocId:(warehouse,key)=>`${warehouse}__${key}`,
        inventoryNumbers:row=>({onHand:row.onHand||0,reserved:row.reserved||0,available:Math.max(0,(row.onHand||0)-(row.reserved||0)),incoming:row.incoming||0}),
        inventoryMovementRecord:(type,quantity,orderId,productKey,actor,extra)=>({type,quantity,orderId,productKey,actor,...extra}),
        salesCodeForName:()=>'',invalidateWarehouseStockCache:()=>{},
        YushinReservation:reservation
    });
    vm.runInContext(appSource.slice(start,end),context);
    const order={customerName:'Customer',orderDate:'2026-10-02',salesCode:'S1'};
    const item={itemId:'item-1',qty:4,fulfillmentType:'WAREHOUSE',warehouseId:'W-2'};
    const result=await context.reserveSingleOrderItem('ORDER-1',order,item,0);

    assert.equal(result.reservedQty,4);
    assert.equal(result.shortageQty,0);
    assert.equal(rows.get('inventory/P-1').reserved,4,'aggregate reserved quantity must not drift');
    assert.equal(rows.get('warehouseStocks/W-1__P-1').reserved,0);
    assert.equal(rows.get('warehouseStocks/W-2__P-1').reserved,4);
    assert.equal(rows.get('inventoryReservations/ORDER-1__item-1').warehouseId,'W-2');
    assert.deepEqual(movements.map(row=>[row.type,row.quantity,row.warehouseId]),[
        ['release',-4,'W-1'],
        ['reserve',4,'W-2']
    ]);
});

test('role changes cannot leave an older in-flight page in the cache', () => {
    assert.match(appSource, /const requestedRole = currentUserRole;/);
    assert.match(appSource, /requestedRole !== currentUserRole/);
    assert.match(appSource, /orderReloadRequested = true/);
    assert.match(appSource, /myQuotesReloadRequested = true/);
    const roleSwitchStart = appSource.indexOf('window.switchViewRole =');
    const roleSwitchEnd = appSource.indexOf('\n};', roleSwitchStart) + 3;
    const roleSwitch = appSource.slice(roleSwitchStart, roleSwitchEnd);
    assert.match(roleSwitch, /ordersCache = \[\]/);
    assert.match(roleSwitch, /myQuotesCache = \[\]/);
    assert.match(roleSwitch, /equipmentList = \[\]/);
    assert.match(appSource, /generation !== equipmentLoadGeneration \|\| requestedRole !== currentUserRole/);
});

test('document number generation reads only the newest matching document', () => {
    const quoteStart = appSource.indexOf('window.generateQuoteNo =');
    const quoteEnd = appSource.indexOf('\n};', quoteStart) + 3;
    const quoteGenerator = appSource.slice(quoteStart, quoteEnd);
    assert.match(quoteGenerator, /orderBy\('quoteNo', 'desc'\)/);
    assert.match(quoteGenerator, /limit\(1\)/);
    const poStart = appSource.indexOf('window.generatePoNo =');
    const poEnd = appSource.indexOf('\n};', poStart) + 3;
    const poGenerator = appSource.slice(poStart, poEnd);
    assert.match(poGenerator, /orderBy\('poNo', 'desc'\)/);
    assert.match(poGenerator, /limit\(1\)/);
    assert.match(appSource, /findPriceItemByCodeValue\(value\)/);
});

test('sales statistics uses a bounded cached query and ignores stale roles', () => {
    const start = appSource.indexOf('window.loadSalesStatistics =');
    const end = appSource.indexOf('\n};', start) + 3;
    const loader = appSource.slice(start, end);
    assert.match(loader, /if \(salesStatisticsLoadPromise\) return salesStatisticsLoadPromise/);
    assert.match(loader, /requestedRole !== currentUserRole/);
    assert.match(loader, /salesStatisticsLoadPromise = null/);
    assert.match(loader, /where\('orderDate', '>=', start\)/);
    assert.match(loader, /where\('orderDate', '<=', end\)/);
    assert.match(loader, /where\('updatedAt', '>=', startIso\)/);
    assert.match(loader, /where\('status', '==', BUSINESS_STATUS\.ACTIVE\)/);
    assert.match(loader, /readQueryInBatches/);
    assert.match(loader, /Promise\.all\(\[periodOrders, activityOrders, openOrders\]\)/);
    assert.doesNotMatch(loader, /collection\('orders'\)\.get\(\)/);
});

test('purchase modal chooses a company that does not silently filter every item', () => {
    const start = appSource.indexOf('function bestPurchaseOrderCompany(');
    const end = appSource.indexOf('\n}\n\nwindow.openDirectStockPurchase', start) + 2;
    assert.ok(start >= 0 && end > start);
    const context = {
        isCompanyBrandAllowed: (company, brand) => ({
            yushin: ['Roche'], morningstar: ['Qiagen'], 'MULTI-LIFE': ['Beckman']
        })[company].includes(brand)
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    assert.equal(context.bestPurchaseOrderCompany([], [{ brand: 'Qiagen' }], 'yushin'), 'morningstar');
    assert.equal(context.bestPurchaseOrderCompany([{ company: 'MULTI-LIFE' }], [{ brand: 'Beckman' }], 'yushin'), 'MULTI-LIFE');
    const dealStart = appSource.indexOf('window.markQuoteAsDeal =');
    const dealEnd = appSource.indexOf('\n};', dealStart) + 3;
    assert.match(appSource.slice(dealStart, dealEnd), /company\s*:\s*q\.company\s*\|\|\s*''/);
});

test('billing status is optimistic and ignores a rapid duplicate tap', async () => {
    const start = appSource.indexOf('window.toggleOrderStatus =');
    const end = appSource.indexOf('\n};', start) + 3;
    const order = { id: 'o1', isOrdered: true, isArrived: true, isBilled: false, statusHistory: [] };
    let updatePayload;
    const context = {
        window: {}, BUSINESS_STATUS: { ACTIVE: 'active', COMPLETED: 'completed', CANCELLED: 'cancelled', VOIDED: 'voided' }, ordersCache: [order], pendingOrderStatusKeys: new Set(), activeOrderWorkFilter: 'all',
        canManageOrderLifecycleCapability: () => true, canEditPage: () => true, normalizedOrderStatus: () => 'normal',
        deliveryProgressInfo: () => ({ delivered: 0 }), orderInvoiceDate: () => '', localDateString: () => '2026-09-17',
        prompt: () => { throw new Error('billing must not depend on window.prompt'); }, alert: message => { throw new Error(message); },
        currentUserName: 'Tester', currentUser: null, renderOrdersList: () => {}, writeAppDataCache: () => {},
        orderWorkIndexFields: () => ({ workCategories:['complete'], workCategoryUpdatedAt:'2026-09-17T00:00:00.000Z' }),
        currentDeliveryOrderId: null, renderDeliveryModal: () => {}, renderOrderLifecycleModal: () => {},
        firebase: { firestore: { FieldValue: { arrayUnion: (...entries) => ({ entries }) } } },
        db: {
            collection: () => ({ doc: () => ({}) }),
            runTransaction: async callback => callback({
                get: async () => ({ exists: true, data: () => ({ ...order, isBilled: false, statusHistory: [] }) }),
                update: (_ref, payload) => { updatePayload = payload; }
            })
        },
        Date
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    context.window.toggleOrderStatus('o1', 'isBilled', true);
    context.window.toggleOrderStatus('o1', 'isBilled', true);
    assert.equal(order.isBilled, true);
    assert.equal(context.pendingOrderStatusKeys.has('o1:isBilled'), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(updatePayload.isBilled, true);
    assert.equal(updatePayload.invoiceDate, '2026-09-17');
    assert.equal(context.pendingOrderStatusKeys.has('o1:isBilled'), false);
});

test('failed billing write restores the previous state and unlocks the button', async () => {
    const start = appSource.indexOf('window.toggleOrderStatus =');
    const end = appSource.indexOf('\n};', start) + 3;
    const order = { id: 'o2', isOrdered: true, isArrived: true, isBilled: false, invoiceDate: '', statusHistory: [] };
    let alertMessage = '';
    const context = {
        window: {}, BUSINESS_STATUS: { ACTIVE: 'active', COMPLETED: 'completed', CANCELLED: 'cancelled', VOIDED: 'voided' }, ordersCache: [order], pendingOrderStatusKeys: new Set(), activeOrderWorkFilter: 'billing',
        canManageOrderLifecycleCapability: () => true, canEditPage: () => true, normalizedOrderStatus: () => 'normal',
        deliveryProgressInfo: () => ({ delivered: 0 }), orderInvoiceDate: () => '', localDateString: () => '2026-09-17',
        prompt: () => '2026-09-17', alert: message => { alertMessage = message; },
        currentUserName: 'Tester', currentUser: null, renderOrdersList: () => {}, writeAppDataCache: () => {},
        currentDeliveryOrderId: null, renderDeliveryModal: () => {}, renderOrderLifecycleModal: () => {},
        firebase: { firestore: { FieldValue: { arrayUnion: (...entries) => ({ entries }) } } },
        db: { collection: () => ({ doc: () => ({}) }), runTransaction: async () => { throw new Error('offline'); } },
        Date
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    context.window.toggleOrderStatus('o2', 'isBilled', true);
    assert.equal(order.isBilled, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(order.isBilled, false);
    assert.equal(order.invoiceDate, '');
    assert.equal(context.activeOrderWorkFilter, 'billing');
    assert.equal(context.pendingOrderStatusKeys.has('o2:isBilled'), false);
    assert.match(alertMessage, /已還原/);
});


test('quote and order lists use global business-date ordering across companies', () => {
    assert.match(appSource, /db\.collection\('quotes'\)\.orderBy\('quoteDate', 'desc'\)/);
    assert.match(appSource, /compareBusinessRecordsNewestFirst\(a, b, 'quoteDate', 'quoteNo'\)/);
    assert.match(appSource, /db\.collection\('orders'\)/);
    assert.match(appSource, /orderBy\('orderDate', 'desc'\)/);
    assert.match(appSource, /compareBusinessRecordsNewestFirst\(a, b, 'orderDate', 'id'\)/);
    const compareStart = appSource.indexOf('function compareBusinessRecordsNewestFirst');
    const compareEnd = appSource.indexOf('\n}', compareStart) + 2;
    const comparator = appSource.slice(compareStart, compareEnd);
    assert.doesNotMatch(comparator, /company/);
});


test('quote and order full-history search scan every indexed match with progress feedback', () => {
    assert.match(appSource, /function buildFullHistorySearchTokens/);
    assert.match(appSource, /where\('searchTokens', 'array-contains', queryToken\)/);
    assert.match(appSource, /itemCodeKey: normalizeHistoryItemCode/);
    assert.match(indexSource, /搜尋全部歷史：單號 \/ 抬頭 \/ 客戶 \/ 廠牌 \/ 品項/);
    assert.match(indexSource, /搜尋全部歷史：客戶 \/ 廠牌 \/ 貨號 \/ 品名 \/ 單號/);
    assert.doesNotMatch(indexSource, /orderHistorySearchMoreBtn|quoteHistorySearchMoreBtn/);

    const orderStart = appSource.indexOf('async function runOrderHistorySearch');
    const orderEnd = appSource.indexOf('window.scheduleOrderHistorySearch', orderStart);
    const orderSearch = appSource.slice(orderStart, orderEnd);
    assert.match(orderSearch, /while \(true\)/);
    assert.match(orderSearch, /firestoreReadWithTimeout\(query\.get\(\), '訂單索引搜尋'\)/);
    assert.match(orderSearch, /snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(orderSearch, /全歷史搜尋中：已檢查/);
    assert.match(orderSearch, /generation !== orderHistorySearchGeneration/);
    assert.doesNotMatch(orderSearch, /collection\('orders'\)\.get\(\)/);

    const quoteStart = appSource.indexOf('async function runQuoteHistorySearch');
    const quoteEnd = appSource.indexOf('window.scheduleQuoteHistorySearch', quoteStart);
    const quoteSearch = appSource.slice(quoteStart, quoteEnd);
    assert.match(quoteSearch, /while \(true\)/);
    assert.match(quoteSearch, /firestoreReadWithTimeout\(query\.get\(\), '估價單索引搜尋'\)/);
    assert.match(quoteSearch, /snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(quoteSearch, /全歷史搜尋中：已檢查/);
    assert.match(quoteSearch, /generation !== quoteHistorySearchGeneration/);
    assert.doesNotMatch(quoteSearch, /collection\('quotes'\)\.get\(\)/);
});

test('browser history restores internal pages without forcing Firestore reloads', () => {
    assert.match(appSource, /history\.pushState/);
    assert.match(appSource, /addEventListener\('popstate'/);
    assert.match(appSource, /skipReload: true/);
    assert.match(appSource, /window\.scrollTo/);
    const mainStart = appSource.indexOf('window.switchMainTab =');
    const mainEnd = appSource.indexOf('// 「檢視身份」切換', mainStart);
    assert.match(appSource.slice(mainStart, mainEnd), /pushAppNavigationState/);
    const quoteStart = appSource.indexOf('window.switchQuoteView =');
    const quoteEnd = appSource.indexOf('\n};', quoteStart) + 3;
    assert.match(appSource.slice(quoteStart, quoteEnd), /skipHistory/);
});




test('quote owner wording stays consistently labeled as responsible sales', () => {
    assert.doesNotMatch(appSource, /請選擇負責人/);
    assert.match(indexSource, /負責業務：<\/label><select id="salesName"/);
});

test('quote optional item fields stay collapsed, persist, export only when filled and remember customer preferences', () => {
    assert.match(indexSource, /applyCurrentQuoteCustomerPreferences\(\)/);
    assert.match(appSource, /function quoteExtraDataFromRow\(row\)/);
    assert.match(appSource, /item-origin/);
    assert.match(appSource, /item-lead-time/);
    assert.match(appSource, /item-hospital-code/);
    assert.match(appSource, /item-remarks/);
    assert.doesNotMatch(appSource, /class="item-manufacturer"/);
    assert.match(appSource, /type="hidden" class="item-product-line"/);
    assert.doesNotMatch(appSource, /產品線（選填）/);
    assert.match(appSource, /quote-custom-field-row/);
    assert.match(appSource, /quoteOptionalFields/);
    assert.match(appSource, /FieldValue\.arrayUnion\(\.\.\.quoteOptionalFields\)/);
    const exportStart = appSource.indexOf('window.exportCurrentQuotePdf = async function()');
    const exportEnd = appSource.indexOf('\n};', exportStart) + 3;
    const exportSource = appSource.slice(exportStart, exportEnd);
    assert.match(exportSource, /rememberQuoteCustomerPreferences\(quoteData\.ordererName \|\| quoteData\.clientName, quoteData\.items\)/);
    assert.match(appSource, /renderComparisonExtraFields\(item\.extra, variant\)/);
    assert.match(appSource, /item\.hospitalItemCode/);
});


test('quote PDF uses an isolated fixed grid so mobile card CSS cannot reshape it', () => {
    const renderStart = appSource.indexOf('function renderQuotePdfDocument(quoteData = {})');
    const renderEnd = appSource.indexOf('\n}\n\nfunction createQuotePdfStage', renderStart) + 2;
    const renderSource = appSource.slice(renderStart, renderEnd);
    assert.match(renderSource, /quote-pdf-grid-row quote-pdf-grid-head/);
    assert.match(renderSource, /quote-pdf-grid-row quote-pdf-item-row/);
    assert.match(renderSource, /quote-pdf-bottom/);
    assert.doesNotMatch(renderSource, /<table class="quote-pdf-table">/);
    assert.match(cssSource, /grid-template-columns:4% minmax\(0, 1fr\) 9% 9% 9% 9% !important/);
    assert.match(cssSource, /\.quote-pdf-stage \.quote-pdf-bottom \{/);
    assert.match(appSource, /source\.querySelectorAll\('\.quote-pdf-item-row'\)/);
});


test('quote PDF document is rendered directly from quote data without cloning the editor DOM', () => {
    const renderStart = appSource.indexOf('function renderQuotePdfDocument(quoteData = {})');
    const renderEnd = appSource.indexOf('\n}\n\nfunction createQuotePdfStage', renderStart) + 2;
    const renderSource = appSource.slice(renderStart, renderEnd);
    const stageStart = appSource.indexOf('function createQuotePdfStage(quoteData)');
    const stageEnd = appSource.indexOf('\n}\n\nfunction quotePdfPageHeightPx', stageStart) + 2;
    const stageSource = appSource.slice(stageStart, stageEnd);
    assert.match(renderSource, /quoteData\.items/);
    assert.match(renderSource, /companyData/);
    assert.match(renderSource, /quote-pdf-grid/);
    assert.match(stageSource, /renderQuotePdfDocument\(quoteData\)/);
    assert.doesNotMatch(stageSource, /cloneNode/);
    assert.doesNotMatch(stageSource, /prepareQuoteForPrint/);
    assert.match(appSource, /function paginateQuotePdfDocument\(stage, source\)/);
});


test('quote primary actions focus on PDF delivery workflow without a print button', () => {
    assert.match(indexSource, /id="printBtn"[^>]*>📄 匯出 PDF/);
    assert.match(indexSource, /產生三家估價單/);
    assert.match(indexSource, /製作下一張估價單/);
    assert.doesNotMatch(indexSource, /legacyQuotePrintBtn/);
    assert.doesNotMatch(indexSource, /quote-more-actions/);
});




test('quote PDF paginates by item rows and repeats the column header on each page', () => {
    assert.match(appSource, /function paginateQuotePdfDocument\(stage, source\)/);
    assert.match(appSource, /createQuotePdfPage\(stage, source, true\)/);
    assert.match(appSource, /createQuotePdfPage\(stage, source, false\)/);
    assert.match(appSource, /quote-pdf-grid-head/);
    assert.match(appSource, /current\.page\.scrollHeight > maxHeight/);
    assert.match(appSource, /summaryClone/);
    assert.match(appSource, /finalPage\.page\.appendChild\(summaryClone\)/);
    assert.match(appSource, /finalPage\.items\.prepend\(candidate\)/);
    assert.match(appSource, /donor\.items\.appendChild\(candidate\)/);
    assert.match(appSource, /async function addDocumentPagesToPdf\(pdf, pages, options = \{\}\)/);
});

test('quote and purchase-order browser-print code is removed in favor of the shared PDF engine', () => {
    assert.doesNotMatch(appSource, /handleSaveAndPrint/);
    assert.doesNotMatch(appSource, /printing-quote/);
    assert.doesNotMatch(appSource, /printing-three-quotes/);
    assert.doesNotMatch(appSource, /prepareQuoteForPrint/);
    assert.doesNotMatch(appSource, /markQuotePrintPagination/);
    assert.doesNotMatch(appSource, /printing-po/);
    assert.doesNotMatch(cssSource, /printing-po/);
    assert.doesNotMatch(cssSource, /po-print-field-mirror/);
    assert.match(appSource, /window\.printPurchaseOrder = async function/);
    assert.match(appSource, /async function addDocumentPagesToPdf/);
    assert.match(appSource, /async function printSavedPoDocument/);
});

test('primary quote export generates PDF directly without browser print', () => {
    assert.match(indexSource, /html2canvas@1\.4\.1/);
    assert.match(indexSource, /jspdf@2\.5\.2/);
    assert.match(indexSource, /id="printBtn"[^>]*>📄 匯出 PDF/);
    assert.match(appSource, /printBtn\.addEventListener\('click', exportCurrentQuotePdf\)/);
    assert.match(appSource, /window\.exportCurrentQuotePdf = async function/);
    assert.match(appSource, /addDocumentPagesToPdf/);
    assert.match(appSource, /new window\.jspdf\.jsPDF/);
    assert.match(appSource, /pdf\.save\(quotePdfFileName\(quoteData\)\)/);
    assert.match(appSource, /persistQuoteOutputRecord\(quoteData, 'PDF'\)/);
    assert.match(cssSource, /\.quote-pdf-stage/);
    assert.match(cssSource, /width: 190mm/);
});


test('three-quote export uses the same direct PDF engine', () => {
    assert.match(indexSource, /id="threeQuotePrintBtn"[^>]*>匯出三頁 PDF<\/button>/);
    const start = appSource.indexOf('window.printThreeQuotes = async function()');
    const end = appSource.indexOf('\n};', start) + 3;
    const source = appSource.slice(start, end);
    assert.match(source, /new window\.jspdf\.jsPDF/);
    assert.match(source, /paginateQuotePdfDocument/);
    assert.match(source, /comparisonStage\.querySelectorAll\('\.comparison-quote-page'\)/);
    assert.match(source, /addDocumentPagesToPdf\(pdf, comparisonPages/);
    assert.match(source, /-三家估價\.pdf/);
    assert.doesNotMatch(source, /window\.print\(\)/);
});



test('quote and order search-index migration is admin-only batched and idempotent', () => {
    const start = appSource.indexOf('window.backfillOrderSearchIndex =');
    const end = appSource.indexOf('\n};', start) + 3;
    const migration = appSource.slice(start, end);
    assert.match(migration, /trueUserRole !== 'admin'/);
    assert.match(migration, /currentUserRole !== 'admin'/);
    assert.match(migration, /\['quotes','orders','forecasts','equipment'\]/);
    assert.match(migration, /limit\(200\)/);
    assert.match(migration, /startAfter\(cursor\)/);
    assert.match(migration, /buildFullHistorySearchTokens/);
    assert.match(migration, /data\.itemCodeKey !== normalized/);
    assert.match(migration, /batch\.update/);
    assert.match(migration, /orderSearchIndexAwaitingConfirmation/);
    assert.match(migration, /請在 10 秒內再按一次確認開始/);
    assert.doesNotMatch(migration, /confirm\(/);
    assert.doesNotMatch(migration, /collection\('orders'\)\.get\(\)/);
});


test('new quotes and orders persist createdAt and normalized order item-code keys', () => {
    const saveOrderStart = appSource.indexOf('window.saveNewOrder =');
    const saveOrderEnd = appSource.indexOf('\n};', saveOrderStart) + 3;
    const saveOrder = appSource.slice(saveOrderStart, saveOrderEnd);
    assert.match(saveOrder, /itemCodeKey: normalizeHistoryItemCode\(itemCode\)/);
    assert.match(saveOrder, /buildFullHistorySearchTokens\('order', data\)/);

    const quoteStart = appSource.indexOf('function collectCurrentQuoteRecord()');
    const quoteEnd = appSource.indexOf('\n\nfunction comparisonBaseTotal', quoteStart);
    const quoteSave = appSource.slice(quoteStart, quoteEnd);
    assert.match(quoteSave, /createdAt: new Date\(\)\.toISOString\(\)/);
    const persistStart = appSource.indexOf('function persistQuoteOutputRecord');
    const persistEnd = appSource.indexOf('\n}', persistStart) + 2;
    const persistSource = appSource.slice(persistStart, persistEnd);
    assert.match(persistSource, /buildFullHistorySearchTokens\('quote', quoteData\)/);

    const dealStart = appSource.indexOf('window.markQuoteAsDeal =');
    const dealEnd = appSource.indexOf('\n};', dealStart) + 3;
    const deal = appSource.slice(dealStart, dealEnd);
    assert.match(deal, /openOrderModal\(\{/);
    assert.match(deal, /newOrderDraftItems=items\.slice\(1\)/);
    assert.match(saveOrder, /createdAt: new Date\(\)\.toISOString\(\)/);
});


test('phase 2 product master keeps formal product identity and supports normalized Unit', () => {
    assert.match(appSource, /function stableProductId\(item\)/);
    assert.match(appSource, /function normalizeProductMasterItem\(item\)/);
    assert.match(appSource, /productId:/);
    assert.match(appSource, /inventoryTracked:/);
    assert.match(appSource, /lotTracked:/);
    assert.match(appSource, /expiryTracked:/);
    assert.match(appSource, /supplier:/);
    const productStart = appSource.indexOf('function normalizeProductMasterItem(item)');
    const productEnd = appSource.indexOf('function normalizeProductMasterList', productStart);
    const productSource = appSource.slice(productStart, productEnd);
    assert.match(productSource, /\bunit:\s*String\(item\.unit \|\| item\.uom \|\| ''\)\.trim\(\)/);
    assert.match(appSource, /spec:/);
    assert.match(appSource, /normalizeProductMasterList\(/);
    assert.match(appSource, /collection\('products'\)/);
    assert.doesNotMatch(appSource, /settings\/prices/);
});


test('phase 2 documents link to productId while retaining historical snapshots', () => {
    assert.match(appSource, /class="item-product-id"/);
    assert.match(appSource, /const productId = row\.querySelector\('\.item-product-id'\)\?\.value \|\| ''/);
    assert.match(appSource, /productId, productMasterMatched: !!productId/);
    assert.match(appSource, /data\.productId = priceMatch\.productId/);
    assert.match(appSource, /productId:sourceItem\.productId\|\|priceMatch\?\.productId/);
    assert.match(appSource, /data\.supplier = priceMatch\.supplier/);
    assert.match(appSource, /data\.spec = priceMatch\.spec/);
});

test('phase 2 Product Import supports normalized fields, cost split and preview', () => {
    assert.match(appSource, /又鑫標準 Product Import 匯入預覽/);
    assert.match(appSource, /confirmProductMasterImport\(brandGroups\)/);
    for (const field of ['單位', '標準成本（含稅）', '庫存管理', '批號管理', '效期管理', '啟用']) {
        assert.ok(appSource.includes(field), `missing import field: ${field}`);
    }
    assert.match(appSource, /standardCostProvided/);
    assert.match(appSource, /collection\('productCosts'\)/);
});


test('phase 3 defines a flexible common document relationship layer', () => {
    assert.match(appSource, /const DOCUMENT_TYPES = Object\.freeze/);
    assert.match(appSource, /function documentLink\(type, id, relation/);
    assert.match(appSource, /function normalizeDocumentLinks\(links\)/);
    assert.match(appSource, /function linkedDocumentFields\(sourceType = '', sourceId = '', links = \[\]\)/);
    assert.match(appSource, /sourceType:/);
    assert.match(appSource, /sourceId:/);
    assert.match(appSource, /linkedDocuments:/);
});

test('phase 3 links quote to orders and orders to purchase orders in both directions', () => {
    const dealStart = appSource.indexOf('window.markQuoteAsDeal =');
    const dealEnd = appSource.indexOf('window.unmarkQuoteAsDeal', dealStart);
    const deal = appSource.slice(dealStart, dealEnd);
    assert.match(deal, /DOCUMENT_TYPES\.QUOTE/);
    assert.match(deal, /sourceType:DOCUMENT_TYPES\.QUOTE/);
    assert.match(appSource, /linkedDocuments:firebase\.firestore\.FieldValue\.arrayUnion\(documentLink\(DOCUMENT_TYPES\.ORDER,docRef\.id,'created'\)\)/);

    const poStart = appSource.indexOf('window.printPurchaseOrder =');
    const poEnd = appSource.indexOf("window.addEventListener('afterprint'", poStart);
    const po = appSource.slice(poStart, poEnd);
    assert.match(po, /linkedDocumentFields/);
    assert.match(po, /DOCUMENT_TYPES\.PURCHASE_ORDER/);
    assert.match(po, /linkedDocuments: normalizeDocumentLinks/);
});

test('phase 3 cancels generated orders instead of hard deleting them', () => {
    const start = appSource.indexOf('window.unmarkQuoteAsDeal =');
    const end = appSource.indexOf('/* =========================================================\n   訂單管理系統', start);
    const source = appSource.slice(start, end);
    assert.match(source, /status: 'cancelled'/);
    assert.match(source, /cancelReason: '來源估價單取消成交'/);
    assert.doesNotMatch(source, /batch\.delete/);
});


test('phase 4 forecast is lightweight, paginated and has no expected-close-date requirement', () => {
    assert.match(appSource, /db\.collection\('forecasts'\)/);
    assert.match(appSource, /orderBy\('updatedAt', 'desc'\)/);
    assert.match(appSource, /limit\(DEFAULT_LIST_LIMIT\)/);
    assert.match(appSource, /where\('ownerUid', '==', currentUser/);
    assert.match(appSource, /latestProgress:/);
    const forecastStart = appSource.indexOf('let forecastCache =');
    const forecastEnd = appSource.indexOf('估價單系統', forecastStart);
    assert.doesNotMatch(appSource.slice(forecastStart, forecastEnd), /expectedClose|closeDate|預計成交日期/);
});

test('phase 4 supports forecast manual edit, quote conversion, order conversion and quote-origin creation', () => {
    for (const fn of ['saveForecast', 'createQuoteFromForecast', 'createOrderFromForecast', 'createForecastFromQuote']) {
        assert.ok(appSource.includes(fn), 'missing '+fn);
    }
    assert.match(appSource, /DOCUMENT_TYPES\.FORECAST/);
    assert.match(appSource, /FieldValue\.arrayUnion\(documentLink\(DOCUMENT_TYPES\.QUOTE/);
    assert.match(appSource, /FieldValue\.arrayUnion\(documentLink\(DOCUMENT_TYPES\.ORDER/);
});

test('phase 4 forecast permission is integrated into the common permission system', () => {
    assert.match(appSource, /key: 'forecast'/);
    assert.match(appSource, /'forecast-system':'forecast'/);
    assert.match(appSource, /canViewAllData\('forecast'\)/);
    assert.match(appSource, /canEditPage\('forecast'\)/);
});


test('phase 5 inventory uses on-hand reserved available incoming and transaction-backed movements', () => {
    assert.match(appSource, /function inventoryNumbers\(data = \{\}\)/);
    assert.match(appSource, /globalThis\.YushinInventory\?\.normalizeStock/);
    assert.match(appSource, /return globalThis\.YushinInventory\.normalizeStock\(data\)/);
    assert.match(appSource, /incoming/);
    assert.match(appSource, /collection\('inventoryMovements'\)/);
    assert.match(appSource, /inventoryMovementRecord\([\s\S]*?'reserve'/);
    assert.match(appSource, /'ship'/);
});

test('phase 5 order creation reserves only available stock and records shortage', () => {
    const start=appSource.indexOf('async function reserveSingleOrderItem');
    const end=appSource.indexOf('async function reserveInventoryForNewOrder',start);
    const s=appSource.slice(start,end);
    assert.match(s,/globalThis\.YushinReservation\?\.planReservation/);
    assert.match(s,/globalThis\.YushinReservation\.planReservation/);
    assert.match(s,/plan\.additionalReserveQty/);
    assert.match(s,/plan\.releaseQty/);
    assert.match(s,/oldProductKey/);
    assert.match(s,/oldWarehouseId/);
    assert.doesNotMatch(s,/const preservedQty=/);
    assert.doesNotMatch(s,/const additionalReservable=/);
    assert.match(appSource,/await reserveInventoryForNewOrder\(docRef\.id, data\)/);
});

test('phase 5 shipment consumes both aggregate and selected warehouse stock transactionally', () => {
    const start=appSource.indexOf('async function applyInventoryDeliveryDeltaInTransaction');
    const end=appSource.indexOf('function applyInventoryDeliveryInTransaction',start);
    const s=appSource.slice(start,end);
    assert.match(s,/warehouseId/);
    assert.match(s,/warehouseStocks/);
    assert.match(s,/onHand:\s*Math\.max\(0,inv\.onHand-deltaQty\)/);
    assert.match(s,/onHand:\s*wh\.onHand\s*-\s*deltaQty/);
    assert.match(s,/reserved:\s*Math\.max\(0,\s*inv\.reserved\s*\+\s*reservedDelta\)/);
    assert.match(s,/'ship'/);
});

test('phase 5 cancelling and restoring orders adjusts reservations without deleting inventory history', () => {
    const start=appSource.indexOf('async function adjustInventoryReservationForLifecycle');
    const end=appSource.indexOf('window.quickSetOrderLifecycle',start);
    const s=appSource.slice(start,end);
    assert.match(s,/nextStatus === 'cancelled'/);
    assert.match(s,/order_restored/);
    assert.match(s,/inventoryMovementRecord\([\s\S]*?'release'/);
    assert.doesNotMatch(s,/\.delete\(/);
});


test('inventory full search uses indexed pagination without legacy collection scans', () => {
    const start=appSource.indexOf('async function runInventorySearch');
    const end=appSource.indexOf('function populateInventoryBrandFilter',start);
    const s=appSource.slice(start,end);
    assert.match(s,/where\('searchTokens','array-contains',token\)/);
    assert.match(s,/if\(cursor\)query=query\.startAfter\(cursor\)/);
    assert.match(s,/if\(snapshot\.size<DEFAULT_LIST_LIMIT\)break/);
    assert.doesNotMatch(s,/舊庫存相容搜尋/);
    assert.doesNotMatch(s,/orderBy\('updatedAt','desc'\)/);
});

test('phase 6 supply orders register incoming cache without increasing on-hand', () => {
    const start=appSource.indexOf('async function registerPurchaseIncoming');
    const end=appSource.indexOf('let poReceiptTargetId',start);
    const s=appSource.slice(start,end);
    assert.match(s,/incoming:Math\.max\(0,inv\.incoming\+delta\)/);
    assert.match(s,/warehouseStocks/);
    assert.doesNotMatch(s,/onHand:inv\.onHand\+delta/);
    assert.doesNotMatch(s,/pendingInventoryItems/);
    assert.match(s,/incomingRegisteredQty:targetQty/);
    assert.match(s,/sourceType:'SUPPLY_ORDER'/);
    assert.match(s,/nextInventory\.searchTokens=buildInventorySearchTokens\(nextInventory\)/);
});

test('phase 6 supply receipt decreases incoming and increases warehouse stock with partial receipts', () => {
    const start=appSource.indexOf('async function receiveSupplyOrderRecord');
    const end=appSource.indexOf('window.openSupplyReceipt',start);
    const source=appSource.slice(start,end);
    assert.match(source,/YushinSupply\.normalize\(\{\.\.\.supply,id:supplyId\}\)/);
    assert.match(source,/YushinReceiving\.buildReceiptSnapshot\(procurement/);
    assert.match(source,/YushinSupply\.applyReceipt\(procurement,qty\)/);
    assert.match(source,/const incomingRelease=receiptPlan\.incomingReleaseQty/);
    assert.match(source,/onHand:inv\.onHand\+qty/);
    assert.match(source,/incoming:Math\.max\(0,inv\.incoming-incomingRelease\)/);
    assert.match(source,/onHand:wh\.onHand\+qty/);
    assert.match(source,/incoming:Math\.max\(0,wh\.incoming-incomingRelease\)/);
    assert.match(source,/incomingRegisteredQty:receiptPlan\.record\.incomingRegisteredQty/);
    assert.match(source,/collection\('receipts'\)/);
    assert.doesNotMatch(source,/pendingInventoryItems/);
    assert.doesNotMatch(source,/receiptRecords/);
    assert.doesNotMatch(source,/receiptStatus/);
});

test('phase 6 supports direct stock purchase independent of customer orders and new Product Master items', () => {
    const start=appSource.indexOf('window.openDirectStockPurchase');
    const end=appSource.indexOf('window.openPurchaseOrderModal',start);
    const s=appSource.slice(start,end);
    assert.match(s,/orderId:\s*''/);
    assert.match(s,/loadSupplierWarehouseMasters/);
    assert.doesNotMatch(s,/ensurePriceListLoaded/);
    assert.match(s,/addDirectPoItem/);
    assert.match(s,/poDirectStockMode = true/);
    assert.match(s,/generatePoNo/);
});


test('phase 7 inventory provides ledger lots expiry FEFO and controlled adjustments',()=>{
 assert.match(appSource,/function fefoLots\(stock\)/);assert.match(appSource,/function lotStatus\(lot\)/);
 assert.match(appSource,/30天內/);assert.match(appSource,/60天內/);assert.match(appSource,/90天內/);
 assert.match(appSource,/inventoryMovements/);assert.match(indexSource,/value="initial"/);assert.match(indexSource,/value="adjustment"/);assert.match(indexSource,/value="scrap"/);
 assert.match(appSource,/orderBy\('updatedAt','desc'\)\.limit\(DEFAULT_LIST_LIMIT\)/);
 assert.match(appSource,/orderBy\('createdAt','desc'\)\.limit\(DEFAULT_LIST_LIMIT\)/);
});

test('inventory refresh gives immediate feedback and bounded Firestore reads',()=>{
 assert.match(indexSource,/id="inventoryRefreshBtn"[\s\S]*?>↻ 更新<\/button>/);
 const start=appSource.indexOf('window.loadInventory=async function');
 const end=appSource.indexOf('\n};',start)+3;
 const source=appSource.slice(start,end);
 assert.match(source,/inventoryRefreshBtn/);
 assert.match(source,/載入中…/);
 assert.match(source,/firestoreReadWithTimeout\(q\.get\(\),'庫存清單'\)/);
 assert.match(source,/firestoreReadWithTimeout\(db\.collection\('inventoryMovements'\)[\s\S]*?'庫存異動'\)/);
});


test('phase 8 adds warehouse to UI permission architecture',()=>{assert.match(appSource,/warehouse: '倉管'/);assert.match(appSource,/key: 'inventory'/);});


test('phase 9 analysis separates actual receipts sales stock value incoming and purchase-sales difference',()=>{
 assert.match(appSource,/function inventoryAnalysisTotals\(start,end\)/);
 assert.match(appSource,/where\('type','==','receipt'\)/);
 assert.match(appSource,/difference:\s*sales\s*-\s*purchase/);
 assert.match(appSource,/stockValue/);assert.match(appSource,/incoming/);
 assert.match(appSource,/readQueryInBatches\(receiptQuery\)/);
});
test('phase 8 fixed role permissions include warehouse role without an editable permission matrix',()=>{assert.match(appSource,/warehouse:\s*Object\.freeze/);assert.doesNotMatch(appSource,/saveAdminUserCapabilities/);});


test('phase 10 keeps inventory analysis queries bounded and server-filtered',()=>{
 assert.match(appSource,/where\('type','==','receipt'\)/);
 assert.match(appSource,/const receiptQuery = db\.collection\('inventoryMovements'\)[\s\S]{0,500}where\('type','==','receipt'\)/);
 assert.doesNotMatch(appSource,/collection\('inventoryMovements'\)\.get\(\)/);
});
test('phase 10 role model consistently documents warehouse',()=>{
 assert.match(appSource,/admin' \/ 'sales' \/ 'purchaser' \/ 'warehouse' \/ 'engineer'/);
});


test('system unification uses a shared Brand Master compatibility layer', () => {
    assert.match(appSource, /function getUnifiedBrandEntries/);
    assert.match(appSource, /function resolveBrandName/);
    assert.match(appSource, /function loadBrandMaster/);
    assert.match(appSource, /syncLegacyBrandSettingsToMaster/);
    assert.match(appSource, /getUnifiedBrandNames/);
});

test('order brand filter uses selectable brands and groups alternate spelling and custom brands', () => {
    const start = appSource.indexOf('function orderBrandFilterValue(');
    const end = appSource.indexOf('\nwindow.renderOrdersList =', start);
    assert.ok(start >= 0 && end > start);
    const controls = Object.fromEntries(['purchaserOrderFilters', 'orderSalesFilter', 'orderBrandFilter'].map(id =>
        [id, { style: {}, value: '', innerHTML: '' }]));
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
    const context = {
        document: { getElementById: id => controls[id] },
        ordersCache: [
            { salesName: '王先生', brand: 'Biorad' },
            { salesName: '王先生', brand: 'B iorad' },
            { salesName: '王先生', brand: '自行輸入品牌' }
        ],
        salesList: [{ name: '王先生' }],
        OTHER_BRAND_OPTION_KEY: '其他廠牌',
        normalizeBrandLookupKey: normalize,
        resolveBrandName: value => normalize(value) === 'biorad' ? 'Bio-Rad' : value,
        getPriceListBrands: () => ['Beckman', 'Bio-Rad'],
        canViewAllData: () => true,
        stripPhoneSuffix: value => value,
        escapeAttr: value => value,
        escapeHtml: value => value
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    const brands = context.populatePurchaserOrderFilters();
    assert.deepEqual(Array.from(brands), ['Beckman', 'Bio-Rad']);
    assert.match(controls.orderBrandFilter.innerHTML, />Bio-Rad<\/option>/);
    assert.doesNotMatch(controls.orderBrandFilter.innerHTML, />B iorad<\/option>|>Biorad<\/option>/);
    assert.match(controls.orderBrandFilter.innerHTML, />其他廠牌<\/option>/);
    assert.equal(context.orderBrandFilterValue('B iorad', brands), 'Bio-Rad');
    assert.equal(context.orderBrandFilterValue('自行輸入品牌', brands), '其他廠牌');
    assert.equal(context.orderBrandFilterValue('', brands), '');
    const initStart = appSource.indexOf('function initializePageData(mainKey');
    const initEnd = appSource.indexOf('\nfunction ensureSalesListLoaded', initStart);
    const initSource = appSource.slice(initStart, initEnd);
    assert.match(initSource, /ensureBrandSettingsLoaded\(\)\.then/);
    assert.match(initSource, /if \(mainKey === 'orders\.list' && canAccessPage\('orders\.list'\)\) renderOrdersList\(\)/);
    assert.match(appSource, /orderItems\.some\(item => orderBrandFilterValue\(item\.brand, selectableBrands\) === brandFilter\)/);
});

test('purchasing and orders share brand names and date range semantics across work queues', () => {
    const start = appSource.indexOf('const purchasingViewLoaded = new Set();');
    const end = appSource.indexOf('\nwindow.switchPurchasingView =', start);
    assert.ok(start >= 0 && end > start);
    const controls = {
        poPeriodFilter: { value: 'this-year' },
        purchaseSalesFilter: { value: '', innerHTML: '' },
        purchaseBrandFilter: { value: '', innerHTML: '' },
        purchasePeriodStart: { value: '' },
        purchasePeriodEnd: { value: '' },
        purchaseCustomPeriod: { style: {} }
    };
    const context = {
        window: {}, document: { getElementById: id => controls[id] },
        salesList: [{ name: '王先生' }],
        getPriceListBrands: () => ['Bio-Rad', 'Beckman'],
        OTHER_BRAND_OPTION_KEY: '其他廠牌',
        escapeAttr: value => value, escapeHtml: value => value,
        stripPhoneSuffix: value => value,
        workflowSalesFilterNames: () => ['王先生'],
        unifiedPeriodRange: key => key === 'this-year' ? { start: '2026-01-01', end: '2026-12-31' } : { start: '', end: '' },
        normalizeBusinessDate: value => value,
        orderBrandFilterValue: value => String(value || '').replace(/[\s-]/g, '').toLowerCase() === 'biorad' ? 'Bio-Rad' : value,
        purchasingView: 'ordering',
        renderPendingPurchaseOrders: () => {}, renderPurchasingDispatchOrders: () => {}, renderPoList: () => {},
        dateOnlyFromTimestamp: value => value.slice(0, 10)
    };
    vm.createContext(context);
    vm.runInContext(appSource.slice(start, end), context);
    context.populatePurchasingFilters();
    assert.match(controls.purchaseBrandFilter.innerHTML, />Bio-Rad<\/option>/);
    controls.purchaseSalesFilter.value = '王先生';
    controls.purchaseBrandFilter.value = 'Bio-Rad';
    assert.equal(context.purchaseLineMatchesFilters('2026-09-28', '王先生', 'B iorad'), true);
    assert.equal(context.purchaseLineMatchesFilters('2025-09-28', '王先生', 'Biorad'), false);
    assert.equal(context.purchaseLineMatchesFilters('2026-09-28', '李先生', 'Biorad'), false);
    assert.equal(context.purchaseLineMatchesFilters('2026-09-28', '王先生', 'Beckman'), false);
    controls.poPeriodFilter.value = 'custom';
    controls.purchasePeriodStart.value = '2026-09-20';
    controls.purchasePeriodEnd.value = '2026-09-25';
    assert.equal(context.purchaseLineMatchesFilters('2026-09-28', '王先生', 'Biorad'), false);
    assert.equal(context.purchaseLineMatchesFilters('2026-09-24', '王先生', 'Biorad'), true);
    const receivingStart=appSource.indexOf('function renderPurchasingReceivingWorkList');
    const receivingEnd=appSource.indexOf('\nwindow.renderPoList',receivingStart);
    const receivingSource=appSource.slice(receivingStart,receivingEnd);
    assert.match(receivingSource, /purchaseLineMatchesFilters\(order\.orderDate, order\.salesName, item\.brand, filters\)/);
    assert.match(receivingSource, /purchaseLineMatchesFilters\(date, salesName, brand, filters\)/);
    assert.match(indexSource, /id="poPeriodFilter" onchange="changePurchasePeriod\(this\.value\)"/);
});

test('Brand Master compatibility removal is guarded by a read-only full-source audit', () => {
    assert.match(indexSource, /id="brandMasterAuditBtn"/);
    assert.match(indexSource, /onclick="previewBrandMasterCompatibilityAudit\(\)"/);
    assert.match(appSource, /function buildBrandMasterCompatibilityAudit/);
    assert.match(appSource, /canRemoveCompatibilityLayer/);
    assert.match(appSource, /const historicalCollections = \['orders', 'quotes', 'forecasts', 'equipment'\]/);
    const audit = appSource.slice(
        appSource.indexOf('window.previewBrandMasterCompatibilityAudit'),
        appSource.indexOf('function normalizeThermoBrandList')
    );
    assert.match(audit, /readCollectionForMigration\('products'\)/);
    assert.doesNotMatch(audit, /\.set\(|\.update\(|\.delete\(|db\.batch\(/);
});

test('Forecast brand entry is limited to active Brand Master brands', () => {
    assert.match(indexSource, /<select id="forecastBrand">/);
    assert.doesNotMatch(indexSource, /id="forecastBrandList"/);
    assert.match(appSource, /function populateForecastBrandDropdown/);
    assert.match(appSource, /getUnifiedBrandEntries\(false\)/);
    assert.match(appSource, /此廠牌不在啟用中的 Brand Master/);
});

test('new business records persist stable salesCode while keeping legacy owner fields', () => {
    assert.match(appSource, /salesCode:\s*currentUserCode/);
    assert.match(appSource, /function salesCodeForName/);
    assert.match(appSource, /function belongsToCurrentUser\(salesName, ownerUid, salesCode/);
    assert.match(appSource, /collection\('salesCodes'\)/);
});

test('sales handoff changes the sales-code holder instead of rewriting historical sales names', () => {
    const start = appSource.indexOf('window.executeSalesTransfer =');
    const end = appSource.indexOf('// 依 Firestore batch 500 筆上限', start);
    const s = appSource.slice(start, end);
    assert.match(s, /salesCodes/);
    assert.match(s, /handoffHistory/);
    assert.match(s, /backfillSalesCodeForLegacyRecords/);
    assert.doesNotMatch(s, /\{\s*salesName:\s*toName\s*\}/);
});

test('inventory reservation is traceable to occupying orders without order-level quantity mirrors', () => {
    assert.match(appSource, /inventoryReservations/);
    assert.match(appSource, /openInventoryReservationDetails/);
    assert.match(appSource, /reservedQty/);
    assert.match(appSource, /shortageQty/);
    assert.doesNotMatch(appSource, /inventoryReservedQty/);
    assert.doesNotMatch(appSource, /inventoryShortageQty/);
});

test('unknown order items do not create inventory before purchase receipt', () => {
    const start = appSource.indexOf('async function reserveSingleOrderItem');
    const end = appSource.indexOf('async function reserveInventoryForNewOrder', start);
    const s = appSource.slice(start, end);
    const missingProductReturn=s.indexOf('if(!productKey)return');
    const transactionStart=s.indexOf('await db.runTransaction');
    assert.ok(missingProductReturn>=0 && transactionStart>missingProductReturn);
    assert.match(s.slice(missingProductReturn,transactionStart), /reservationError:'missing_product_master'/);
    assert.match(s,/globalThis\.YushinReservation\.planReservation/);
    assert.doesNotMatch(s, /tx\.set\(warehouseRef[\s\S]*?onHand/);
});

test('period semantics are shared across Quote Order and PO while Forecast uses status/history search', () => {
    assert.match(appSource, /function unifiedPeriodRange/);
    assert.match(appSource, /function dateInUnifiedPeriod/);
    assert.doesNotMatch(appSource, /forecastPeriodFilter/);
    assert.match(appSource, /myQuotePeriodFilter/);
    assert.match(appSource, /poPeriodFilter/);
    assert.match(appSource, /this-month/);
    assert.match(appSource, /this-quarter/);
    assert.match(indexSource, /id="forecastStatusFilter"/);
    assert.match(indexSource, /id="forecastSearch"/);
});

test('permission routing includes Product Forecast and Inventory workspaces', () => {
    const start = appSource.indexOf('function getActivePermissionPage');
    const end = appSource.indexOf('function applyPermissionVisibility', start);
    const s = appSource.slice(start, end);
    assert.match(s, /forecast-system/);
    assert.match(s, /product-system/);
    assert.match(s, /inventory-system/);
    assert.match(appSource, /function firstAccessibleMainPage\(\)[\s\S]*?\['quote', 'forecast', 'products', 'orders', 'orders\.po', 'inventory', 'equipment'\]/);
});


test('shared Customer Master is persisted and legacy order Unit is retired', () => {
    assert.match(appSource, /function customerIdForName/);
    assert.match(appSource, /function syncCustomerMaster/);
    assert.match(appSource, /customerId:/);
    assert.doesNotMatch(appSource, /document\.getElementById\('orderUnit'\)/);
    assert.doesNotMatch(indexSource, /id="orderUnit"/);
});

test('inventory UI exposes reservation and pending-item detail without duplicate HTML ids', () => {
    assert.match(indexSource, /id="inventoryReservationOverlay"/);
    assert.match(indexSource, /id="pendingInventoryBody"/);
    const ids = [...indexSource.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    assert.deepEqual([...new Set(duplicates)], []);
});

test('Firestore rules deny unspecified collections and enforce sales-code ownership', () => {
    assert.match(rulesSource, /function owns\(data\)/);
    assert.match(rulesSource, /match \/forecasts\/\{forecastId\}\/progress\/\{progressId\}/);
    assert.match(rulesSource, /businessInventoryOperationalUpdate/);
    assert.match(rulesSource, /match \/\{document=\*\*\}/);
    assert.match(rulesSource, /allow read, write: if false/);
    assert.doesNotMatch(rulesSource, /match \/\{document=\*\*\}[\s\S]*allow read: if signedIn/);
});

test('all major product-entry screens put item code before downstream product fields', () => {
    const orderCode = indexSource.indexOf('id="orderItemCode"');
    const orderName = indexSource.indexOf('id="orderItemName"');
    const orderBrand = indexSource.indexOf('id="orderBrand"');
    assert.ok(orderCode >= 0 && orderName > orderCode && orderBrand > orderName);

    const quoteRowStart = appSource.indexOf('window.addQuoteRow');
    const quoteRowEnd = appSource.indexOf('window.deleteQuoteRow', quoteRowStart);
    const quoteRow = appSource.slice(quoteRowStart, quoteRowEnd);
    assert.ok(quoteRow.indexOf('class="item-model"') >= 0);
    assert.ok(quoteRow.indexOf('class="item-model"') < quoteRow.indexOf('class="item-cn"'));
});


test('phase 14 canonical lifecycle statuses preserve cancellation semantics without hard delete', () => {
    assert.match(appSource, /const BUSINESS_STATUS = Object\.freeze/);
    assert.match(appSource, /ACTIVE: 'active'/);
    assert.match(appSource, /COMPLETED: 'completed'/);
    assert.match(appSource, /CANCELLED: 'cancelled'/);
    assert.match(appSource, /VOIDED: 'voided'/);
    const lifecycleStart = appSource.indexOf('window.quickSetOrderLifecycle =');
    const lifecycleEnd = appSource.indexOf('window.toggleOrderProgressStatus', lifecycleStart);
    const lifecycle = appSource.slice(lifecycleStart, lifecycleEnd);
    assert.match(lifecycle, /status: nextStatus === 'cancelled' \? BUSINESS_STATUS\.CANCELLED : BUSINESS_STATUS\.ACTIVE/);
    assert.doesNotMatch(lifecycle, /db\.collection\([^\n]+\)\.doc\([^\n]+\)\.delete\(/);
});

test('phase 15 quotes orders and purchase orders persist explicit currency tax and tax-basis metadata', () => {
    assert.match(appSource, /const DEFAULT_CURRENCY = 'TWD'/);
    assert.match(appSource, /const DEFAULT_TAX_RATE = 0\.05/);
    assert.match(appSource, /function grossAmountMetadata/);
    assert.match(appSource, /function netAmountMetadata/);
    assert.match(appSource, /priceIncludesTax: true/);
    assert.match(appSource, /priceIncludesTax: false/);
    assert.match(appSource, /subtotalExTax/);
    assert.match(appSource, /taxAmount/);
    assert.match(appSource, /totalIncTax/);
});

test('phase 16 inventory analysis uses protected lot costs without copying cost into operational inventory', () => {
    const start = appSource.indexOf('function inventoryAnalysisTotals');
    const end = appSource.indexOf('function renderInventoryAnalysisSummary', start);
    const source = appSource.slice(start, end);
    assert.match(appSource, /readDocumentsByIds\('inventoryLotCosts', \[\.\.\.requiredLotIds\]\)/);
    assert.match(source, /inventoryAnalysisLotCosts\.get\(receipt\.lotId\)/);
    assert.match(source, /inventoryAnalysisLotCosts\.get\(lot\.id\)/);
    assert.doesNotMatch(source, /receipt\.unitCost|receipt\.purchaseNetAmount|stock\.unitCost/);
});

test('phase 17 Forecast PO and Inventory provide mobile data labels and card layout', () => {
    assert.match(appSource, /data-th="客戶"/);
    assert.match(appSource, /data-th="到貨進度"/);
    assert.match(appSource, /data-th="可用庫存"/);
    assert.match(cssSource, /Phase 17：Forecast／採購／庫存手機版一致化/);
    assert.match(cssSource, /#forecastTable td\[data-th\]::before/);
    assert.match(cssSource, /#poListPanel table td\[data-th\]::before/);
    assert.match(cssSource, /#inventory-system td\[data-th\]::before/);
});

test('phase 18 statistics avoid all-history downloads and important writes stamp updatedAt', () => {
    const start = appSource.indexOf('window.loadSalesStatistics =');
    const end = appSource.indexOf('\n};', start) + 3;
    const loader = appSource.slice(start, end);
    assert.match(loader, /Promise\.all\(\[periodOrders, activityOrders, openOrders\]\)/);
    assert.match(loader, /readQueryInBatches/);
    assert.doesNotMatch(loader, /db\.collection\('orders'\)\.get\(\)/);
    assert.match(appSource, /updatedAt:\s*(?:now|history\.at|new Date\(\)\.toISOString\(\))/);
    assert.match(appSource, /updatedAt: history\.at/);
});

test('phase 19 Firestore rules enforce role boundaries for PO inventory reservations and equipment', () => {
    assert.match(rulesSource, /match \/purchaseOrders\/\{id\}/);
    assert.match(rulesSource, /allow read: if admin\(\) \|\| purchaser\(\) \|\| warehouse\(\)/);
    assert.match(rulesSource, /match \/inventoryReservations\/\{id\}/);
    assert.match(rulesSource, /businessReservationOperationalUpdate\(\)/);
    assert.match(rulesSource, /match \/equipment\/\{id\}/);
    assert.match(rulesSource, /admin\(\) \|\| engineer\(\) \|\| \(businessOwner\(\) && owns\(resource\.data\)\)/);
    assert.match(rulesSource, /allow read, write: if false/);
});

test('phase 20 core workflow contracts are all represented in regression coverage', () => {
    const required = [
        'forecasts', 'quotes', 'orders', 'supplyOrders', 'purchaseOrders', 'inventoryReservations',
        'inventoryMovements', 'salesCodes', 'brands', 'customers'
    ];
    required.forEach(name => assert.match(appSource, new RegExp(name)));
    assert.match(appSource, /reserveInventoryForNewOrder/);
    assert.match(appSource, /registerPurchaseIncoming/);
    assert.match(appSource, /receiveSupplyOrderRecord/);
    assert.doesNotMatch(appSource, /window\.receivePurchaseOrder/);
    assert.match(appSource, /applyInventoryDeliveryInTransaction/);
    assert.match(appSource, /syncLegacyBrandSettingsToMaster/);
    assert.match(appSource, /executeSalesTransfer/);
});


test('forecast quote-origin keeps line-item snapshots for later order splitting', () => {
    const start = appSource.indexOf('window.createForecastFromQuote');
    const end = appSource.indexOf('window.markQuoteAsDeal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /items:\s*items\.map/);
    assert.match(s, /model:\s*item\.model/);
    assert.match(s, /qty:\s*Number\(item\.qty/);
    assert.match(s, /subtotal:\s*parseMoney\(item\.subtotal\)/);
});

test('forecast to order supports one-item prefill and multi-item split', () => {
    assert.match(appSource, /async function forecastOrderItems/);
    assert.match(appSource, /function forecastItemToOrderSource/);
    assert.match(appSource, /async function createForecastOrdersDirectly/);
    const start = appSource.indexOf('window.createOrderFromForecast');
    const end = appSource.indexOf('估價單系統', start);
    const s = appSource.slice(start, end);
    assert.match(s, /items\.length === 1/);
    assert.match(s, /openOrderModal\(forecastItemToOrderSource/);
    assert.match(s, /createForecastOrdersDirectly\(forecast, items\)/);
});

test('order modal accepts Forecast source data and uses the actual source-link fields', () => {
    const start = appSource.indexOf('window.openOrderModal = function');
    const end = appSource.indexOf('function populateOrderCustomerSuggestions', start);
    const s = appSource.slice(start, end);
    assert.match(s, /function\(source = null\)/);
    assert.match(s, /orderItemCode/);
    assert.match(s, /orderItemName/);
    assert.match(s, /orderQty/);
    assert.match(s, /orderUnitPrice/);
    assert.match(s, /_orderModalSourceLink/);
    assert.match(s, /_orderModalProductId/);
});

test('Forecast edit hides workflow fields and history is available from the main list', () => {
    assert.match(indexSource, /id="forecastWorkflowSection"/);
    assert.match(indexSource, /id="forecastHistoryOverlay"/);
    assert.match(indexSource, /id="forecastHistoryBody"/);
    assert.match(appSource, /openForecastHistoryModal/);
    assert.match(appSource, />紀錄<\/button>/);
    const start = appSource.indexOf('window.openForecastModal');
    const end = appSource.indexOf('window.closeForecastModal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /workflowSection\.style\.display = 'none'/);
    assert.match(s, /currentProgressSection\.style\.display = 'none'/);
});

test('Forecast basic edits preserve Stage and status for the progress workflow', () => {
    const start = appSource.indexOf('window.saveForecast');
    const end = appSource.indexOf('window.openForecastProgressModal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /existing\?\.stage/);
    assert.match(s, /existing\?\.status/);
    assert.match(s, /基本資料更新/);
});


test('quote optional-field preferences belong to the customer name before the invoice title', () => {
    assert.match(appSource, /function quotePreferenceCustomerName\(\)/);
    assert.match(appSource, /document\.getElementById\('ordererName'\)\?\.value[\s\S]*document\.getElementById\('clientName'\)\?\.value/);
    assert.match(indexSource, /id="clientName"[^>]+onchange="applyCurrentQuoteCustomerPreferences\(\)"/);
    assert.match(indexSource, /id="ordererName"[^>]+onchange="applyCurrentQuoteCustomerPreferences\(\)"/);
    const exportStart = appSource.indexOf('window.exportCurrentQuotePdf = async function()');
    const exportEnd = appSource.indexOf('\n};', exportStart) + 3;
    assert.match(appSource.slice(exportStart, exportEnd), /rememberQuoteCustomerPreferences\(quoteData\.ordererName \|\| quoteData\.clientName, quoteData\.items\)/);
});

test('quote item-code auto-fill waits for Product Master and reacts while typing', () => {
    assert.match(appSource, /function findPriceItemByCodeValue/);
    assert.match(appSource, /function applyQuoteProductMatch/);
    assert.match(appSource, /window\.onItemModelInput/);
    assert.match(appSource, /await findProductByCode\(value\)/);
    assert.match(appSource, /oninput="onItemModelInput\(this\)"/);
});

test('quote item-code auto-fill fills product identity brand and current price', () => {
    const start = appSource.indexOf('function applyQuoteProductMatch');
    const end = appSource.indexOf('let quoteModelInputTimer', start);
    const s = appSource.slice(start, end);
    assert.match(s, /item-en/);
    assert.match(s, /item-cn/);
    assert.match(s, /item-model/);
    assert.match(s, /selectBrandInDropdown/);
    assert.match(s, /item-product-id/);
    assert.match(s, /inc-price/);
    assert.match(s, /onIncPriceChange/);
});

test('quote product lookup tolerates harmless item-code punctuation only when unique', () => {
    const start = appSource.indexOf('function findPriceItemByCodeValue');
    const end = appSource.indexOf('function applyQuoteProductMatch', start);
    const s = appSource.slice(start, end);
    assert.match(s, /normalizeItemCodeLoose/);
    assert.match(s, /candidates\.length === 1/);
});


test('order item-code autofill waits for Product Master and fills sale/cost fields', () => {
    const start = appSource.indexOf('window.onOrderItemCodeChange');
    const end = appSource.indexOf('window.saveToStorage', start);
    const s = appSource.slice(start, end);
    assert.match(s, /await findProductByCode/);
    assert.doesNotMatch(s, /await ensurePriceListLoaded/);
    assert.match(s, /orderItemName/);
    assert.match(s, /orderUnitPrice/);
    assert.match(s, /applyOrderProductCost/);
    assert.match(s, /_orderModalProductId/);
    assert.match(s, /onOrderItemCodeInput/);
});

test('direct stock purchase uses the formal PO modal and supports batch items', () => {
    const start = appSource.indexOf('window.openDirectStockPurchase');
    const end = appSource.indexOf('window.openPurchaseOrderModal', start);
    const s = appSource.slice(start, end);
    assert.match(s, /poDirectStockMode = true/);
    assert.match(s, /addDirectPoItem/);
    assert.match(s, /generatePoNo/);
    assert.match(s, /poModalOverlay/);
    assert.match(appSource, /purchaseType: poItems\.every\(item => !item\.orderId\) \? 'stock' : 'order'/);
});

test('supply receiving uses the shared batch modal with quantity lot and expiry', () => {
    assert.match(indexSource, /id="poReceiptBatchOverlay"/);
    assert.match(indexSource, /id="poReceiptBatchBody"/);
    assert.match(appSource, /window\.savePoReceiptBatch/);
    assert.match(appSource, /receiveSupplyOrderRecord/);
    assert.doesNotMatch(appSource, /receiveSinglePoLine/);
    assert.match(appSource, /lotNo/);
    assert.match(appSource, /expiryDate/);
});

test('manual inventory changes support batch rows instead of browser prompts', () => {
    assert.match(indexSource, /id="inventoryAdjustmentOverlay"/);
    assert.match(indexSource, /id="inventoryAdjustmentRows"/);
    assert.match(appSource, /window\.addInventoryAdjustmentRow/);
    assert.match(appSource, /window\.saveInventoryAdjustmentBatch/);
    const start = appSource.indexOf('window.openInventoryAdjustment');
    const end = appSource.indexOf('function inventoryProductKey', start);
    const s = appSource.slice(start, end);
    assert.doesNotMatch(s, /prompt\('貨號'/);
    const saveStart = appSource.indexOf('window.saveInventoryAdjustmentBatch =');
    const saveEnd = appSource.indexOf('function inventoryProductKey', saveStart);
    const save = appSource.slice(saveStart, saveEnd);
    assert.match(save, /const results=\[\]/);
    assert.match(save, /results\.push\(\{row,ok:true\}\)/);
    assert.match(save, /results\.push\(\{row,ok:false,error:/);
    assert.match(save, /inventoryAdjustmentRows=failed\.map\(result=>result\.row\)/);
    assert.match(save, /成功的品項已從表單移除/);
});


test('Product Master v2 uses targeted server lookup instead of a 500-row overlay', () => {
    assert.match(appSource, /async function findProductByCode/);
    assert.match(appSource, /where\('normalizedPartNo', '==', normalized\)\.limit\(20\)/);
    assert.match(appSource, /productMasterDocToPriceItem/);
    assert.doesNotMatch(appSource, /function loadProductMasterOverlay/);
    assert.doesNotMatch(appSource, /collection\('products'\)\.limit\(500\)/);
});

test('Product Master no longer uses an agency attribute for cost visibility', () => {
    const editorStart = appSource.indexOf('function ensureProductMasterEditor');
    const editorEnd = appSource.indexOf('\nfunction populateProductMasterEditor', editorStart);
    const editorSource = appSource.slice(editorStart, editorEnd);
    assert.doesNotMatch(editorSource, /pmEditAuthorization|代理屬性/);
    assert.doesNotMatch(appSource, /authorizationTypeForProduct/);
    assert.match(appSource, /productType: data\.productType \|\| data\.category \|\| ''/);
});

test('quick product creation is temporary, duplicate-safe and can be used from quote or order', () => {
    assert.match(appSource, /window\.openQuickProductCreate/);
    assert.match(appSource, /window\.saveQuickProduct/);
    assert.match(appSource, /status: 'TEMPORARY'/);
    assert.match(appSource, /normalizedPartNo/);
    assert.match(appSource, /where\('normalizedPartNo', '==', normalizedPartNo\)/);
    assert.match(appSource, /showQuickProductButton\(input, 'quote'\)/);
    assert.match(appSource, /showQuickProductButton\(input, 'order'\)/);
});

test('standard product costs are restricted to purchaser/admin', () => {
    const start = appSource.indexOf('async function loadVisibleProductCost');
    const end = appSource.indexOf('\nfunction setOrderCostFieldForProduct', start);
    const source = appSource.slice(start, end);
    assert.match(source, /currentUserRole !== 'admin' && currentUserRole !== 'purchaser'/);
    assert.match(source, /db\.collection\('productCosts'\)\.doc\(productId\)/);
    assert.doesNotMatch(source, /salesVisible|authorizationType/);
});

test('sales self-order uses manual transaction cost independent of brand agency status', () => {
    const start = appSource.indexOf('window.saveNewOrder');
    const end = appSource.indexOf('function loadOrdersFromCloud', start);
    const source = appSource.slice(start, end);
    assert.match(source, /firstItem\.procurementType === 'SALES_SELF_ORDER'/);
    assert.match(source, /business_manual_transaction_cost/);
    assert.doesNotMatch(source, /NON_AUTHORIZED|authorizationTypeForProduct/);
});

test('Firestore rules keep Product Master standard costs purchaser/admin only', () => {
    assert.match(rulesSource, /match \/productCosts\/\{id\}[\s\S]*?allow read: if admin\(\) \|\| purchaser\(\)/);
    assert.match(rulesSource, /allow create, update: if admin\(\) \|\| purchaser\(\)/);
    assert.match(rulesSource, /match \/productLines\/\{id\}/);
    assert.doesNotMatch(rulesSource, /visibleNonAuthorizedCost|ownTemporaryNonAuthorizedCost/);
    assert.doesNotMatch(rulesSource, /assignedProductLine|productLineIds/);
});




test('database backup includes formal Product Master and cost collections', () => {
    assert.match(appSource, /'products'/);
    assert.match(appSource, /'productCosts'/);
    assert.match(appSource, /'brands'/);
});

test('Product Management is the single daily Product Import entry', () => {
    assert.doesNotMatch(indexSource, /Product Master v2 遷移/);
    assert.doesNotMatch(indexSource, /id="productMasterMigrationPreviewBtn"/);
    assert.doesNotMatch(indexSource, /id="admin-sub-prices"/);
    assert.doesNotMatch(indexSource, /id="admin-prices"/);
    assert.match(indexSource, /id="productManagementTools"/);
    assert.match(indexSource, /id="productBatchMaintenance"/);
    assert.match(indexSource, />批次匯入</);
    assert.match(indexSource, /下載標準範本/);
    assert.match(indexSource, /查看欄位規則/);
    assert.match(indexSource, /只處理本次檔案中的品項/);
});


test('Phase 2-6 completion integrates supplier mapping, warehouses and direct ship', () => {
    assert.match(appSource, /db\.collection\('suppliers'\)/);
    assert.match(appSource, /db\.collection\('brandSupplierMappings'\)/);
    assert.match(appSource, /db\.collection\('warehouses'\)/);
    assert.match(appSource, /db\.collection\('warehouseStocks'\)/);
    assert.match(appSource, /function supplierForProduct/);
    assert.match(appSource, /function defaultWarehouse/);
    assert.match(appSource, /DIRECT_SHIP/);
    assert.match(appSource, /WAREHOUSE/);
});

test('direct-ship purchase analysis counts only received supply quantity', () => {
    const start = appSource.indexOf('function inventoryAnalysisTotals');
    const end = appSource.indexOf('function renderInventoryAnalysisSummary', start);
    const source = appSource.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(source, /Number\(supply\.receivedQty \|\| 0\) \* Number\(supply\.unitCost \|\| 0\)/);
    assert.doesNotMatch(source, /Number\(supply\.qty \|\| 0\) \* Number\(supply\.unitCost \|\| 0\)/);
});

test('Phase 2-6 direct ship bypasses inventory reservation, incoming and receiving', () => {
    const reserveStart = appSource.indexOf('async function reserveSingleOrderItem');
    const reserveEnd = appSource.indexOf('async function reserveInventoryForNewOrder', reserveStart);
    const reserve = appSource.slice(reserveStart, reserveEnd);
    assert.match(reserve, /fulfillmentType\|\|'WAREHOUSE'\)===\'DIRECT_SHIP\'/);
    assert.match(reserve, /reservedQty\s*:\s*0/);
    assert.doesNotMatch(reserve, /inventoryReservedQty\s*:\s*0/);
    assert.match(reserve, /warehouseId\s*:\s*''/);

    const incomingStart = appSource.indexOf('async function registerPurchaseIncoming');
    const incomingEnd = appSource.indexOf('window.receivePurchaseOrder', incomingStart);
    const incoming = appSource.slice(incomingStart, incomingEnd);
    assert.match(incoming, /if \(\(supply\.fulfillmentType \|\| 'WAREHOUSE'\) === 'DIRECT_SHIP'\) return/);
});

test('Phase 2-6 security rules cover supplier and warehouse master collections', () => {
    assert.match(rulesSource, /match \/suppliers\/\{id\}/);
    assert.match(rulesSource, /match \/brandSupplierMappings\/\{id\}/);
    assert.match(rulesSource, /match \/warehouses\/\{id\}/);
    assert.match(rulesSource, /match \/warehouseStocks\/\{id\}/);
});

test('Phase 2-6 keeps Customer Reference, Equipment Master and sales ownership compatibility', () => {
    assert.match(appSource, /function syncCustomerMaster/);
    assert.match(appSource, /customerId/);
    assert.match(appSource, /ownerUid/);
    assert.match(appSource, /salesCode/);
    assert.match(rulesSource, /match \/equipment\/\{id\}/);
    assert.match(rulesSource, /function owns\(data\)/);
});

test('V2 formal purchase documents create authoritative supply lines', () => {
    assert.match(appSource, /function formalSupplyOrderId/);
    assert.match(appSource, /db\.collection\('supplyOrders'\)\.doc\(supplyId\)/);
    assert.match(appSource, /type:'PURCHASING_PO'/);
    assert.match(appSource, /method:'PURCHASING_PO'/);
    assert.match(appSource, /sourceType:item\.sourceType\|\|\(item\.orderId\?'SALES_ORDER':'STOCK_REPLENISHMENT'\)/);
    assert.match(appSource, /sourceId:item\.orderId\|\|item\.sourceId\|\|''/);
    assert.match(appSource, /sourceItemId:item\.itemId\|\|''/);
    assert.match(appSource, /purchaseDocumentId:poDocumentId/);
    assert.match(appSource, /purchaseDocumentNo:poNo/);
    assert.match(appSource, /poRecord\.supplyOrderIds=supplyOrderIds/);
});

test('V2 initial stock separates operational lot from protected cost', () => {
    assert.match(indexSource, /實際單位成本/);
    assert.match(appSource, /sourceType:'INITIAL_STOCK'/);
    assert.match(appSource, /remainingQty:delta,sourceType:'INITIAL_STOCK'/);
    assert.match(appSource, /inventoryLotCosts/);
    assert.match(appSource, /unitCost:Number\(row\.unitCost/);
});

test('V2 returns restore and reverse exact delivery lots', () => {
    assert.match(appSource, /availableReturnAllocations/);
    assert.match(appSource, /previousReturnRecord/);
    assert.match(appSource, /lotAllocations,cogs/);
});

test('V2 manual orders and copies preserve multiple items', () => {
    assert.match(indexSource, /addCurrentOrderItemToDraft/);
    assert.match(appSource, /let newOrderDraftItems/);
    assert.match(appSource, /const items=\[\.\.\.newOrderDraftItems/);
    assert.match(appSource, /normalizedOrderItems\(source\)\.map\(normalizeNewOrderItem\)/);
    assert.match(appSource, /itemCount:items\.length,orderSchemaVersion:2/);
});

test('V2 product lookup is server bounded and shows sale and inventory quantities', () => {
    assert.match(indexSource, /searchBusinessProducts/);
    const start=appSource.indexOf('window.searchBusinessProducts');
    const end=appSource.indexOf('window.renderInventoryList',start);
    const source=appSource.slice(start,end);
    assert.match(source, /where\('normalizedPartNo','==',normalized\)\.limit\(25\)/);
    assert.match(source, /orderBy\('productName'\).*limit\(25\)/s);
    assert.doesNotMatch(source, /db\.collection\('products'\)\.get\(\)/);
});

test('V2 personnel UI uses fixed role permissions and removes product-line responsibility', () => {
    assert.doesNotMatch(indexSource, /負責產品線/);
    assert.doesNotMatch(appSource, /saveAdminUserCapabilities/);
    assert.doesNotMatch(appSource, /productLineIds/);
    assert.match(appSource, /const rolePermissions = Object\.freeze/);
});

test('engineer cannot open or create Forecast while sales and admin retain access', () => {
    const engineerPermissions = appSource.match(/engineer: Object\.freeze\(\{ forecast:'([^']+)'/);
    const engineerScope = appSource.match(/engineer: Object\.freeze\(\{ quotes:'own', forecasts:'([^']+)'/);
    assert.equal(engineerPermissions?.[1], 'none');
    assert.equal(engineerScope?.[1], 'none');
    assert.match(appSource, /function canCreateForecastCapability\(role = currentUserRole\) \{\s*return role === 'admin' \|\| role === 'sales';/);
    assert.match(appSource, /window\.openForecastModal = function\(id = ''\) \{\s*if \(!canCreateForecastCapability\(\) \|\| !canEditPage\('forecast'\)\) return;/);
    assert.match(appSource, /window\.saveForecast = async function\(\) \{\s*if \(forecastSaveInProgress \|\| !canCreateForecastCapability\(\) \|\| !canEditPage\('forecast'\)\) return;/);
    assert.match(appSource, /window\.createForecastFromQuote = async function\(quoteNo\) \{\s*if \(!canCreateForecastCapability\(\) \|\| !canEditPage\('forecast'\)\)/);
    assert.match(rulesSource, /match \/forecasts\/\{id\} \{\s*allow read: if admin\(\) \|\| \(sales\(\) && owns\(resource\.data\)\);/);
});

test('personnel screen omits duplicate dashboard while safety stock remains available', () => {
    assert.doesNotMatch(indexSource, /adminDashboardCards/);
    assert.match(appSource, /limit\(100\)/);
    assert.match(appSource, /setInventorySafetyStock/);
    assert.match(appSource, /safetyStock,updatedAt/);
});

test('V2 generic order status toggler only permits reversible billing state', () => {
  const source = fs.readFileSync('app.js', 'utf8');
  const start = source.indexOf('window.toggleOrderStatus = function(orderId, field, newValue)');
  assert.ok(start >= 0);
  const block = source.slice(start, start + 700);
  assert.match(block, /field !== 'isBilled'/);
  assert.doesNotMatch(block, /isOrdered|isArrived/);
});

test('quick delivery no longer synthesizes legacy ordered or arrived states', () => {
  const source = fs.readFileSync('app.js', 'utf8');
  const start = source.indexOf('window.quickCompleteDelivery = async function');
  const end = source.indexOf('window.quickCancelAllDelivery = async function', start);
  assert.ok(start >= 0 && end > start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /updates\s*=\s*\{[^}]*isOrdered:\s*true/s);
  assert.doesNotMatch(block, /updates\s*=\s*\{[^}]*isArrived:\s*true/s);
});

test('equipment removal uses soft disable and never Firestore delete', () => {
  const app = fs.readFileSync('app.js', 'utf8');
  const start = app.indexOf('window.deleteEquipment = function');
  const end = app.indexOf('function equipmentLogRealIndex', start);
  const block = app.slice(start, end);
  assert.match(block, /active:false/);
  assert.match(block, /disabledAt/);
  assert.doesNotMatch(block, /\.delete\s*\(/);
});


test('V2 legacy inventory cost migration is paginated and moves cost out of operational collections', () => {
    assert.match(appSource, /function readCollectionForMigration/);
    assert.match(appSource, /FieldPath\.documentId\(\)/);
    assert.match(appSource, /inventoryLotCosts/);
    assert.match(appSource, /FieldValue\.delete\(\)/);
    assert.doesNotMatch(indexSource, /預覽庫存成本隔離/);
    assert.doesNotMatch(indexSource, /執行庫存成本隔離/);
});


test('V2 historical COGS is reproducible from exact lot allocations and protected costs', () => {
    assert.match(appSource, /function protectedAllocationCost/);
    assert.match(appSource, /inventoryAnalysisLotCosts\.get\(allocation\.lotId\)/);
    assert.match(appSource, /function protectedHistoricalCogs/);
    assert.match(appSource, /protectedAllocationCost\(delivered\) - protectedAllocationCost\(returned\)/);
    assert.match(appSource, /grossProfit:sales-cogs/);
});


test('V2 backup and storage audit include fulfillment and protected cost collections', () => {
    for (const name of ['inventoryLots','inventoryLotCosts','receipts','supplyOrders','dispatchRecords']) {
        assert.match(appSource, new RegExp("'" + name + "'"));
    }
    assert.match(appSource, /受保護批次成本/);
    assert.match(appSource, /供應／訂貨紀錄/);
});


test('V2 admin UI no longer exposes the legacy migration deployment panel', () => {
    assert.doesNotMatch(indexSource, /部署 PR #30 的 Firestore Rules \/ Indexes/);
    assert.doesNotMatch(indexSource, /庫存成本隔離，直到顯示 0/);
    assert.match(indexSource, /匯入標準產品檔/);
});


test('warehouse master save has immediate feedback and duplicate-submit guard', () => {
    const start = appSource.indexOf('window.saveWarehouseMaster');
    const end = appSource.indexOf('window.disableWarehouseMaster', start);
    const source = appSource.slice(start, end);
    assert.match(source, /button\.disabled = true/);
    assert.match(source, /儲存中/);
    assert.match(source, /permission-denied/);
    assert.match(source, /button\.disabled = false/);
});


test('new purchase documents do not persist receipt workflow state', () => {
    const start=appSource.indexOf('window.printPurchaseOrder = async function()');
    const end=appSource.indexOf("window.addEventListener('afterprint'",start);
    const source=appSource.slice(start,end);
    assert.doesNotMatch(source,/receiptStatus:/);
    assert.doesNotMatch(source,/receiptRecords:/);
    assert.match(source,/poRecord\.supplyOrderIds=supplyOrderIds/);
});

test('formal purchase document derives ordered progress from supplyOrders only', () => {
    assert.match(appSource, /supplyOrderedQty:cumulative/);
    assert.doesNotMatch(appSource, /purchaseOrderedQty:cumulative/);
    assert.match(appSource, /function purchaseProgressInfo/);
    assert.match(appSource, /procurementQuantities/);
    assert.match(appSource, /已訂貨・待到貨/);
});


test('V2 order history presents derived purchase and fulfillment progress instead of legacy ordered/arrived truth', () => {
    const start = appSource.indexOf('function renderOrderStatusHistory');
    const end = appSource.indexOf('async function applyInventoryDeliveryDeltaInTransaction', start);
    const source = appSource.slice(start, end);
    assert.match(source, /purchaseProgressInfo\(order\)/);
    assert.match(source, /fulfillmentProgressInfo\(order\)/);
    assert.doesNotMatch(source, /\['isOrdered', '訂貨'\], \['isArrived', '到貨'\]/);
});

test('stock replenishment always creates a valid warehouse supply path', () => {
    const start = appSource.indexOf('window.printPurchaseOrder');
    const end = appSource.indexOf('window.closePurchaseOrderModal', start);
    const source = appSource.slice(start, end);
    assert.match(source, /新增庫存採購單是公司庫存採購，不能設定為原廠直送/);
    assert.match(source, /新增庫存採購單必須指定入庫倉庫/);
    assert.match(source, /purchaseType: poItems\.every\(item => !item\.orderId\) \? 'stock' : 'order'/);
    assert.match(source, /db\.collection\('supplyOrders'\)\.doc\(supplyId\)/);
    assert.match(source, /warehouseId:\(item\.fulfillmentType\|\|'WAREHOUSE'\)==='DIRECT_SHIP'\?'':/);
});

test('ordered action belongs to purchasing while the order list only shows progress', () => {
    const start = appSource.indexOf('window.renderOrdersList = function()');
    const end = appSource.indexOf('window.retryOrderInventoryReservation', start);
    const actions = appSource.slice(start, end);
    assert.doesNotMatch(actions, /openOrderPurchaseDraft/);
    const purchasingStart = appSource.indexOf('function renderPendingPurchaseOrders');
    const purchasingEnd = appSource.indexOf('window.loadPendingPurchaseOrders =', purchasingStart);
    assert.match(appSource.slice(purchasingStart, purchasingEnd), /markPurchaseItemOrdered[\s\S]*?已訂購/);
    assert.match(appSource.slice(purchasingStart, purchasingEnd), /openOrderPurchaseDraft[\s\S]*?產生訂購單/);
    const saveStart = appSource.indexOf('window.printPurchaseOrder = async function()');
    const saveEnd = appSource.indexOf("window.addEventListener('afterprint'", saveStart);
    const save = appSource.slice(saveStart, saveEnd);
    assert.match(save, /poEditingId = savedPo\.id;[\s\S]*?訂購單 \$\{poNo\} 已同步雲端/);
    // PO 會同時更新來源訂單與採購資料；核心 transaction 必須先成功，才可開啟可對外使用的列印文件。
    assert.match(save, /await commitPromise;[\s\S]*?printSavedPoDocument\(poNo, vendorName\);/);
    assert.doesNotMatch(save, /printSavedPoDocument\(poNo, vendorName\);[\s\S]*?await commitPromise/);
    // 在途庫存仍維持背景同步，不阻塞列印。
    assert.doesNotMatch(save, /await registerPurchaseIncoming\(poDocumentId, poRecord\);[\s\S]*?printSavedPoDocument\(poNo, vendorName\)/);
    assert.match(indexSource, /id="poSaveStatus" role="status"/);
});


test('batch supply receipt reports partial success and requires a warehouse', () => {
    assert.match(appSource, /尚未指定入庫倉庫/);
    assert.match(appSource, /let completed = 0/);
    assert.match(appSource, /已成功確認 \$\{completed\} 個品項到貨/);
    assert.match(appSource, /已成功的資料不會重複處理/);
    assert.match(appSource, /到貨必須從供應紀錄進入/);
});

test('partial delivery save blocks duplicate taps', () => {
    const start = appSource.indexOf('window.saveDeliveryRecord');
    const end = appSource.indexOf('window.deleteDeliveryRecord', start);
    const source = appSource.slice(start, end);
    assert.match(source, /pendingDeliveryOrderIds\.has\(orderId\)/);
    assert.match(source, /pendingDeliveryOrderIds\.add\(orderId\)/);
    assert.match(source, /儲存中…/);
    assert.match(source, /pendingDeliveryOrderIds\.delete\(orderId\)/);
});

test('all multi-item orders require item-level delivery even when direct ship', () => {
    const start = appSource.indexOf('window.quickCompleteDelivery');
    const end = appSource.indexOf('window.quickCancelAllDelivery', start);
    const source = appSource.slice(start, end);
    assert.match(source, /const allItems=normalizedOrderItems\(cachedOrder\)/);
    assert.match(source, /if \(allItems\.length > 1\)/);
    assert.match(source, /確保送貨與退貨都能追蹤到正確品項/);
});

test('legacy cost migration sanitizes delivery and return allocations embedded in orders', () => {
    assert.match(appSource, /function recordContainsEmbeddedCost/);
    assert.match(appSource, /legacyOrders: orders\.filter/);
    assert.match(appSource, /deliveryRecords:\(row\.data\.deliveryRecords\|\|\[\]\)\.map\(sanitizeRecord\)/);
    assert.match(appSource, /returnRecords:\(row\.data\.returnRecords\|\|\[\]\)\.map\(sanitizeRecord\)/);
});


test('cancel and restore reservations are item-aware', () => {
  const start=appSource.indexOf('async function adjustInventoryReservationForLifecycle');
  const end=appSource.indexOf('window.quickSetOrderLifecycle',start);
  const source=appSource.slice(start,end);
  assert.match(source,/const items = normalizedOrderItems\(order\)/);
  assert.match(source,/order_cancelled/);
  assert.match(source,/order_restored/);
  assert.match(source,/stockStates = new Map/);
  assert.match(source,/db\.collection\('inventoryReservations'\)\.doc\(\`\$\{orderId\}__\$\{itemId\}\`\)/);
  assert.doesNotMatch(source,/reservationDocRef\(orderId\)/);
  assert.match(source,/items:nextItems,updatedAt:now/);
  assert.doesNotMatch(source,/inventoryReservedQty/);
  assert.doesNotMatch(source,/inventoryShortageQty/);
});

test('delivery and return deletes reject duplicate submissions and cancelled orders can return delivered goods', () => {
  const ds=appSource.slice(appSource.indexOf('window.deleteDeliveryRecord'),appSource.indexOf('window.clearLegacyDelivery'));
  assert.match(ds,/pendingDeliveryOrderIds\.has\(orderId\)/);
  assert.match(ds,/pendingDeliveryOrderIds\.delete\(orderId\)/);
  const rs=appSource.slice(appSource.indexOf('window.deleteReturnRecord'),appSource.indexOf('window.updateOrderField'));
  assert.match(rs,/pendingReturnOrderIds\.has\(orderId\)/);
  assert.match(rs,/pendingReturnOrderIds\.delete\(orderId\)/);
  assert.match(appSource,/已取消訂單仍可能有取消前已實際送出的商品/);
});


test('system data audit follows supplyOrders as procurement truth', () => {
  const start=appSource.indexOf('window.runSystemDataAudit = async function()');
  const end=appSource.indexOf('window.previewInventoryCostMigration',start);
  const source=appSource.slice(start,end);
  assert.ok(start>=0&&end>start);
  assert.match(source,/readCollectionInBatches\('supplyOrders'\)/);
  assert.match(source,/const supplyIds = new Set\(supplyOrders\.map/);
  assert.match(source,/供應紀錄來源訂單不存在/);
  assert.match(source,/供應紀錄倉庫異常/);
  assert.match(source,/供應紀錄數量異常/);
  assert.match(source,/訂購單文件找不到供應紀錄/);
  assert.doesNotMatch(source,/po\.orderId \|\| po\.sourceOrderId/);
});

test('legacy cost migration also sanitizes aggregate and warehouse stock cost fields', () => {
  assert.match(appSource,/legacyWarehouseStocks/);
  assert.match(appSource,/warehouseStocks/);
  assert.match(appSource,/costSanitizedAt/);
});


test('database backup covers governed master, audit, delivery and Forecast progress data', () => {
  for (const name of ['productLines','priceHistory','deliveries','auditLogs']) assert.match(appSource,new RegExp("'"+name+"'"));
  assert.doesNotMatch(appSource,/collectionGroup\('progress'\)/);
  assert.match(appSource,/collection\('progress'\)/);
  assert.match(appSource,/data\.forecastProgress/);
  assert.match(appSource,/path:\`forecasts\/\$\{forecast\.id\}\/progress\/\$\{id\}\`/);
});

test('Forecast list queries have production composite indexes for every ownership path', () => {
  const forecastIndexes = firestoreIndexes.indexes
    .filter(index => index.collectionGroup === 'forecasts')
    .map(index => index.fields.map(field => `${field.fieldPath}:${field.order}`).join(','));

  assert.ok(forecastIndexes.includes('status:ASCENDING,updatedAt:DESCENDING'),
    'admin Forecast status query requires a status + updatedAt composite index');
  assert.ok(forecastIndexes.includes('salesCode:ASCENDING,status:ASCENDING,updatedAt:DESCENDING'),
    'salesCode-owned Forecast query requires its composite index');
  assert.ok(forecastIndexes.includes('ownerUid:ASCENDING,status:ASCENDING,updatedAt:DESCENDING'),
    'legacy ownerUid-owned Forecast query requires its composite index');
});


test('new order drafts are per-user, restorable and cleared only after successful save', () => {
  assert.match(appSource,/ORDER_DRAFT_STORAGE_PREFIX = 'order_draft_v2'/);
  assert.match(appSource,/currentUser\?\.uid \|\| 'anonymous'/);
  assert.match(appSource,/function collectOrderDraft\(\)/);
  assert.match(appSource,/window\.restoreSavedOrderDraft=function/);
  assert.match(appSource,/window\.clearSavedOrderDraft=function/);
  const saveStart=appSource.indexOf('window.saveNewOrder');
  const saveEnd=appSource.indexOf('// 匯出指定日期區間',saveStart);
  assert.match(appSource.slice(saveStart,saveEnd),/clearSavedOrderDraft\(\{ silent:true,clearPending:true \}\)/);
});

test('admin storage exposes a read-only legacy-cost audit without an execution button', () => {
  assert.match(indexSource,/id="inventoryCostMigrationPreviewBtn"/);
  assert.match(indexSource,/onclick="previewInventoryCostMigration\(\)"/);
  assert.match(indexSource,/只讀取並統計舊庫存/);
  assert.doesNotMatch(indexSource,/onclick="runInventoryCostMigration\(\)"/);
  const preview=appSource.slice(appSource.indexOf('window.previewInventoryCostMigration'),appSource.indexOf('window.runInventoryCostMigration'));
  assert.match(preview,/\.map\(name => readCollectionForMigration\(name\)\)/);
  assert.doesNotMatch(preview,/\.map\(readCollectionForMigration\)/);
});

test('production HTML cache-busts local application assets after main deployments', () => {
  assert.match(indexSource,/styles\.css\?v=\d{8}-\d+/);
  assert.match(indexSource,/modules\/workflow-core\.js\?v=\d{8}-\d+/);
  assert.match(indexSource,/app\.js\?v=\d{8}-\d+/);
  assert.match(indexSource,/modules\/fulfillment-core\.js\?v=\d{8}-\d+/);
});

test('Forecast full-history search scans every indexed match with progress feedback', () => {
    assert.match(indexSource, /id="forecastSearch"[\s\S]*?oninput="scheduleForecastHistorySearch\(\)"/);
    assert.match(indexSource, /id="forecastHistorySearchStatus"/);
    assert.match(appSource, /buildFullHistorySearchTokens\('forecast', record\)/);
    assert.match(appSource, /scopedHistorySearchQuery\('forecasts', queryToken\)\.limit\(DEFAULT_LIST_LIMIT\)/);
    assert.match(appSource, /where\('searchTokens', 'array-contains', queryToken\)/);
    const start = appSource.indexOf('async function runForecastHistorySearch');
    const end = appSource.indexOf('window.scheduleForecastHistorySearch', start);
    const source = appSource.slice(start, end);
    assert.match(source, /while \(true\)/);
    assert.match(source, /firestoreReadWithTimeout\(query\.get\(\), 'Forecast 索引搜尋'\)/);
    assert.match(source, /snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(source, /全歷史搜尋中：已檢查/);
    assert.match(source, /generation !== forecastHistorySearchGeneration/);
    assert.match(appSource, /forecastHistorySearchTimer = scheduleListSearch\(forecastHistorySearchTimer, \(\) => runForecastHistorySearch\(true\)\)/);
});


test('order list does not block on full Product Master loading', () => {
    const start = appSource.indexOf("if (mainKey === 'orders.list')");
    const end = appSource.indexOf("if (mainKey === 'orders.po')", start);
    const source = appSource.slice(start, end);
    assert.match(source, /ensureSalesListLoaded\(\)/);
    assert.match(source, /loadOrdersFromCloud\(\)/);
    assert.doesNotMatch(source, /ensurePriceListLoaded\(\)/);
});


test('cached session restore does not initialize the same active page twice',()=>{
  assert.match(appSource,/let lastShowAppInitKey = '';/);
  assert.match(appSource,/if \(lastShowAppInitKey !== initKey\) \{\s*lastShowAppInitKey = initKey;\s*initializePageData\(activeMainKey\);/);
  assert.match(appSource,/lastShowAppInitKey = '';\s*showLoginScreen\(\);/);
});


test('three-quote output compacts layout as item count grows', () => {
    const start = appSource.indexOf('function renderComparisonQuotePage(companyKey, percent, variant)');
    const end = appSource.indexOf('\n}\n\nconst quoteImagePreloadCache', start) + 2;
    assert.ok(start >= 0 && end > start);
    const source = appSource.slice(start, end);
    assert.match(source, /items\.length >= 7 \? ' comparison-quote-dense' : items\.length >= 4 \? ' comparison-quote-compact'/);
    assert.match(source, /comparison-style-\$\{variant\}\$\{densityClass\}/);
    assert.match(cssSource, /\.comparison-quote-page\.comparison-quote-compact/);
    assert.match(cssSource, /\.comparison-quote-page\.comparison-quote-dense/);
    assert.match(cssSource, /\.comparison-style-b\.comparison-quote-compact \.comparison-product-list \{ gap:1\.5mm; margin-top:2mm; \}/);
    assert.match(cssSource, /\.comparison-style-a\.comparison-quote-dense \.comparison-product-item \{ min-height:7\.5mm; padding:1mm 0; \}/);
});


test('equipment full-history search scans every indexed match with progress feedback', () => {
    assert.match(indexSource, /id="eqSearchInput"[^>]+oninput="scheduleEquipmentSearch\(\)"/);
    assert.match(indexSource, /id="equipmentSearchStatus"/);
    const start = appSource.indexOf('async function runEquipmentSearch');
    const end = appSource.indexOf('function populateEquipmentListFilters', start);
    const source = appSource.slice(start, end);
    assert.match(source, /while \(true\)/);
    assert.match(source, /where\('searchTokens', 'array-contains', queryToken\)/);
    assert.match(source, /firestoreReadWithTimeout\(query\.get\(\), '儀器索引搜尋'\)/);
    assert.match(source, /snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(source, /全資料搜尋中：已檢查/);
    assert.match(source, /generation !== equipmentSearchGeneration/);
    assert.doesNotMatch(source, /equipmentSearchCursor/);
    assert.match(appSource, /if \(equipmentSearchActive\) return;[\s\S]*?loadEquipmentFromCloud\(false\)/);
});


test('order and equipment refresh buttons provide immediate loading feedback', () => {
    assert.match(indexSource, /id="orderRefreshBtn"[^>]*>↻ 更新<\/button>/);
    assert.match(indexSource, /id="equipmentRefreshBtn"[^>]*>↻ 更新<\/button>/);
    const orderStart=appSource.indexOf('function updateOrderLoadMoreButton');
    const orderEnd=appSource.indexOf('\n}',orderStart)+2;
    const orderSource=appSource.slice(orderStart,orderEnd);
    assert.match(orderSource,/orderRefreshBtn/);
    assert.match(orderSource,/refreshButton\.disabled = orderPageLoading/);
    assert.match(orderSource,/更新中…/);

    const equipmentStart=appSource.indexOf('window.loadEquipmentFromCloud = function');
    const equipmentEnd=appSource.indexOf('window.loadMoreEquipment',equipmentStart);
    const equipmentSource=appSource.slice(equipmentStart,equipmentEnd);
    assert.match(equipmentSource,/equipmentRefreshBtn/);
    assert.match(equipmentSource,/refreshButton\.disabled = true/);
    assert.match(equipmentSource,/firestoreReadWithTimeout\(query\.get\(\), '儀器清單'\)/);
    assert.match(equipmentSource,/firestore-read-timeout/);
    assert.match(equipmentSource,/refreshButton\.textContent = '↻ 更新'/);
});


test('quote history pagination uses bounded read timeout without requiring a manual refresh button', () => {
    assert.doesNotMatch(indexSource, /id="quoteHistoryRefreshBtn"/);
    const loadStart=appSource.indexOf('async function loadMyQuotesPage');
    const loadEnd=appSource.indexOf('window.loadMyQuotesFromCloud',loadStart);
    const loadSource=appSource.slice(loadStart,loadEnd);
    assert.match(loadSource,/firestoreReadWithTimeout\(query\.get\(\), '估價單'\)/);
    assert.match(loadSource,/firestore-read-timeout/);
    assert.match(loadSource,/DEFAULT_LIST_LIMIT/);
});


test('purchasing refresh buttons provide feedback and purchasing reads are bounded', () => {
    assert.match(indexSource, /id="purchasePendingRefreshBtn"[^>]*>↻ 更新<\/button>/);
    assert.match(indexSource, /id="purchasePoRefreshBtn"[^>]*>↻ 更新<\/button>/);
    assert.match(indexSource, /id="purchaseDispatchRefreshBtn"[^>]*>↻ 更新<\/button>/);
    assert.match(indexSource, /id="purchaseCompletedRefreshBtn"[^>]*>↻ 更新<\/button>/);

    const poButtonStart=appSource.indexOf('function updatePoLoadMoreButton');
    const poButtonEnd=appSource.indexOf('\n}',poButtonStart)+2;
    const poButtonSource=appSource.slice(poButtonStart,poButtonEnd);
    assert.match(poButtonSource,/purchasePoRefreshBtn/);
    assert.match(poButtonSource,/refreshButton\.disabled = poListPageLoading/);
    assert.match(poButtonSource,/更新中…/);

    const pageStart=appSource.indexOf('async function loadPurchaseOrderPage');
    const pageEnd=appSource.indexOf('window.loadMyPurchaseOrders',pageStart);
    const pageSource=appSource.slice(pageStart,pageEnd);
    assert.match(pageSource,/firestoreReadWithTimeout\(query\.get\(\), '訂購單清單'\)/);
    assert.match(pageSource,/firestoreReadWithTimeout\(supplyQuery\.get\(\), '待到貨供應'\)/);
    assert.match(pageSource,/待到貨來源訂單/);

    const pendingStart=appSource.indexOf('window.loadPendingPurchaseOrders = async function');
    const pendingEnd=appSource.indexOf('const pendingPurchaseOrderKeys',pendingStart);
    const pendingSource=appSource.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/purchasePendingRefreshBtn/);
    assert.match(pendingSource,/更新中…/);

    const dispatchStart=appSource.indexOf('async function loadPurchasingDispatchOrders');
    const dispatchEnd=appSource.indexOf('window.loadPurchasingDispatchOrders',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/purchaseCompletedRefreshBtn/);
    assert.match(dispatchSource,/purchaseDispatchRefreshBtn/);
    assert.match(dispatchSource,/更新中…/);
});


test('purchase draft fallback read is bounded', () => {
    const start=appSource.indexOf('window.openOrderPurchaseDraft = async function');
    const end=appSource.indexOf('function updatePoLoadMoreButton',start);
    const source=appSource.slice(start,end);
    assert.match(source,/firestoreReadWithTimeout\([\s\S]*?db\.collection\('orders'\)\.doc\(orderId\)\.get\(\)[\s\S]*?'訂購單來源訂單'/);
    assert.match(source,/button\.textContent = '開啟中…'/);
});


test('purchase history reuses cache without resetting on every tab switch', () => {
    const loadStart=appSource.indexOf('async function loadPurchaseOrderPage');
    const loadEnd=appSource.indexOf('window.loadMyPurchaseOrders',loadStart);
    const loadSource=appSource.slice(loadStart,loadEnd);
    assert.match(loadSource,/purchasingView === 'receiving'[\s\S]*?supplyReceivingCursor = null[\s\S]*?else \{[\s\S]*?poListCursor = null/);
    assert.match(loadSource,/readAppDataCache\('purchase-history'\)/);
    assert.match(loadSource,/if \(query\) \{[\s\S]*?writeAppDataCache\('purchase-history', poListCache\)/);
    assert.doesNotMatch(loadSource,/writeAppDataCache\('purchase-receiving', poListCache\)/);

    const switchStart=appSource.indexOf("} else if (view === 'history') {");
    const switchEnd=appSource.indexOf("} else if (view === 'dispatch') {",switchStart);
    const switchSource=appSource.slice(switchStart,switchEnd);
    assert.match(switchSource,/readAppDataCache\('purchase-history'\)/);
    assert.match(switchSource,/purchasingViewLoaded\.has\('history'\)/);
    assert.doesNotMatch(switchSource,/poListCache = \[\]/);

    const buttonStart=appSource.indexOf('function updatePoLoadMoreButton');
    const buttonEnd=appSource.indexOf('\n}',buttonStart)+2;
    const buttonSource=appSource.slice(buttonStart,buttonEnd);
    assert.match(buttonSource,/purchasingView === 'receiving' \? supplyReceivingHasMore : poListHasMore/);
});

test('completed purchasing queue uses mobile card layout like other work queues', () => {
    assert.match(cssSource, /#purchasePendingStatus, #purchaseDispatchStatus, #purchaseCompletedStatus/);
    assert.match(cssSource, /#purchaseCompletedPanel \.table-wrap/);
    assert.match(cssSource, /#purchaseCompletedPanel table, #purchaseCompletedPanel tbody, #purchaseCompletedPanel tr, #purchaseCompletedPanel td/);
    assert.match(cssSource, /#purchaseCompletedPanel td\[data-th\]::before/);
    assert.match(cssSource, /#purchaseCompletedPanel td\[data-th="操作"\]/);
});


test('admin view-role switch clears purchasing session state', () => {
    const start=appSource.indexOf('window.switchViewRole = function(role)');
    const end=appSource.indexOf('\nfunction actuallySwitchMainTab',start);
    const source=appSource.slice(start,end);
    assert.match(source,/loadedMainPages\.clear\(\)/);
    assert.match(source,/lastShowAppInitKey = ''/);
    assert.match(source,/myQuotesCache = \[\]/);
    assert.match(source,/ordersCache = \[\]/);
    assert.match(source,/forecastCache = \[\]/);
    assert.match(source,/inventoryCache = \[\]/);
    assert.match(source,/equipmentList = \[\]/);
    assert.match(source,/pendingPurchaseCache = \[\]/);
    assert.match(source,/poHistorySearchResults = \[\]/);
    assert.match(source,/supplyReceivingCache = \[\]/);
    assert.match(source,/receivingSourceOrderStatusCache = new Map\(\)/);
    assert.match(source,/purchasingDispatchCache = \[\]/);
    assert.match(source,/purchasingCompletedVisibleLimit = DEFAULT_LIST_LIMIT/);
    assert.match(source,/purchasingViewLoaded\.clear\(\)/);
});


test('purchasing work queues reuse orders cache without duplicate local copies', () => {
    assert.doesNotMatch(appSource, /purchase-receiving/);
    assert.doesNotMatch(appSource, /['"]purchase-pending['"]/);
    assert.doesNotMatch(appSource, /['"]purchase-dispatch['"]/);

    const hydrateStart=appSource.indexOf("if (mainKey === 'orders.po') {");
    const hydrateEnd=appSource.indexOf('\n    }\n}',hydrateStart)+7;
    const hydrateSource=appSource.slice(hydrateStart,hydrateEnd);
    assert.match(hydrateSource,/readAppDataCache\('orders'\)/);
    assert.doesNotMatch(hydrateSource,/pendingPurchaseCache = cached/);
    assert.doesNotMatch(hydrateSource,/purchasingDispatchCache = cached/);

    const orderingStart=appSource.indexOf("if (view === 'ordering') {");
    const orderingEnd=appSource.indexOf("} else if (view === 'receiving') {",orderingStart);
    assert.doesNotMatch(appSource.slice(orderingStart,orderingEnd),/readAppDataCache/);

    const dispatchStart=appSource.indexOf("} else if (view === 'dispatch') {");
    const dispatchEnd=appSource.indexOf("} else renderPurchasingCompletedOrders",dispatchStart);
    assert.doesNotMatch(appSource.slice(dispatchStart,dispatchEnd),/readAppDataCache/);
});


test('session restore and foreground account checks use bounded Firestore reads', () => {
    const authStart=appSource.indexOf('firebase.auth().onAuthStateChanged(function(user)');
    const authEnd=appSource.indexOf('\n});\n\nfunction getPagePermission',authStart);
    const authSource=appSource.slice(authStart,authEnd);
    assert.match(authSource,/firestoreReadWithTimeout\([\s\S]*?db\.collection\('users'\)\.doc\(user\.uid\)\.get\(\)[\s\S]*?'登入狀態驗證'/);

    const resumeStart=appSource.indexOf('function revalidateCurrentUserAccess()');
    const resumeEnd=appSource.indexOf('\nfunction recoverVisibleAppAfterResume',resumeStart);
    const resumeSource=appSource.slice(resumeStart,resumeEnd);
    assert.match(resumeSource,/firestoreReadWithTimeout\([\s\S]*?db\.collection\('users'\)\.doc\(user\.uid\)\.get\(\)[\s\S]*?'帳號狀態驗證'/);
});


test('order and purchasing initialization avoid duplicate brand-driven renders', () => {
    const start=appSource.indexOf('function initializePageData(mainKey');
    const end=appSource.indexOf('\nfunction ensureSalesListLoaded',start);
    const source=appSource.slice(start,end);

    assert.match(source,/\['quote', 'forecast', 'orders\.list', 'inventory', 'equipment', 'admin'\]\.includes\(mainKey\)/);
    assert.doesNotMatch(source,/\['quote', 'forecast', 'orders\.list', 'orders\.po'/);

    const orderStart=source.indexOf("if (mainKey === 'orders.list')");
    const orderEnd=source.indexOf("if (mainKey === 'orders.po')",orderStart);
    const orderSource=source.slice(orderStart,orderEnd);
    assert.match(orderSource,/loadOrdersFromCloud\(\)/);
    assert.doesNotMatch(orderSource.replace(/\/\/.*$/gm, ''),/loadBrandMaster\(\)\.then/);

    const purchaseStart=source.indexOf("if (mainKey === 'orders.po')");
    const purchaseEnd=source.indexOf("if (mainKey === 'inventory')",purchaseStart);
    const purchaseSource=source.slice(purchaseStart,purchaseEnd);
    assert.match(purchaseSource,/switchPurchasingView\(canCreatePurchaseOrderCapability\(\) \? 'ordering' : 'receiving'\)/);
    assert.match(purchaseSource,/Promise\.allSettled\(\[ensureSalesListLoaded\(\), ensureBrandSettingsLoaded\(\)\]\)/);
    assert.equal((purchaseSource.match(/renderPurchasingView\(\)/g) || []).length, 0);
    assert.equal((purchaseSource.match(/populatePurchasingFilters\(\)/g) || []).length, 1);
    assert.doesNotMatch(purchaseSource,/loadBrandMaster\(\)\.then/);
});

test('own-order viewers skip full sales-list load', () => {
    const start=appSource.indexOf("if (mainKey === 'orders.list') {");
    const end=appSource.indexOf("if (mainKey === 'orders.po')",start);
    const source=appSource.slice(start,end);
    assert.match(source,/if \(canViewAllData\('orders'\)\) \{[\s\S]*?ensureSalesListLoaded\(\)/);
    assert.match(source,/loadOrdersFromCloud\(\)/);
});


test('purchase draft preloads only selected lines and bounds supporting reads', () => {
    const helperStart=appSource.indexOf('async function preloadPurchaseCostsForItems');
    const helperEnd=appSource.indexOf('\n\nfunction productMasterDocToPriceItem',helperStart);
    const helperSource=appSource.slice(helperStart,helperEnd);
    assert.match(helperSource,/purchaseItems \|\| \[\]/);
    assert.match(helperSource,/findProductForPurchaseItem\(item\)/);
    assert.match(helperSource,/loadVisibleProductCost\(item\)/);

    const openStart=appSource.indexOf('window.openOrderPurchaseDraft = async function');
    const openEnd=appSource.indexOf('function updatePoLoadMoreButton',openStart);
    const openSource=appSource.slice(openStart,openEnd);
    assert.match(openSource,/preloadPurchaseCostsForItems\(items\)/);
    assert.doesNotMatch(openSource,/preloadPurchaseCosts\(\[order\]\)/);

    const productStart=appSource.indexOf('async function findProductForPurchaseItem');
    const productEnd=appSource.indexOf('async function preloadPurchaseCostsForItems',productStart);
    assert.match(appSource.slice(productStart,productEnd),/firestoreReadWithTimeout\([\s\S]*?'採購 Product Master'/);

    const costStart=appSource.indexOf('async function loadVisibleProductCost');
    const costEnd=appSource.indexOf('function setOrderCostFieldForProduct',costStart);
    assert.match(appSource.slice(costStart,costEnd),/firestoreReadWithTimeout\([\s\S]*?'產品成本'/);

    const poNoStart=appSource.indexOf('window.generatePoNo = async function');
    const poNoEnd=appSource.indexOf('function renderPoItemsTable',poNoStart);
    assert.match(appSource.slice(poNoStart,poNoEnd),/firestoreReadWithTimeout\([\s\S]*?'訂購單號'/);
});

test('shared batch master reads are bounded', () => {
    const collectionStart=appSource.indexOf('async function readCollectionInBatches');
    const collectionEnd=appSource.indexOf('async function readQueryInBatches',collectionStart);
    assert.match(appSource.slice(collectionStart,collectionEnd),/firestoreReadWithTimeout\(query\.get\(\), collectionName \+ ' 批次資料'\)/);

    const queryStart=appSource.indexOf('async function readQueryInBatches');
    const queryEnd=appSource.indexOf('function systemAuditProductKey',queryStart);
    assert.match(appSource.slice(queryStart,queryEnd),/firestoreReadWithTimeout\(query\.get\(\), '批次查詢資料'\)/);

    const warehouseStart=appSource.indexOf('async function loadWarehouseMaster');
    const warehouseEnd=appSource.indexOf('async function loadSupplierWarehouseMasters',warehouseStart);
    assert.match(appSource.slice(warehouseStart,warehouseEnd),/firestoreReadWithTimeout\([\s\S]*?'倉庫主檔'/);
});


test('opening linked purchase orders and supply sync checks are bounded', () => {
    const idsStart=appSource.indexOf('async function readDocumentsByIds');
    const idsEnd=appSource.indexOf('async function loadInventoryAnalysisSupport',idsStart);
    const idsSource=appSource.slice(idsStart,idsEnd);
    assert.match(idsSource,/firestoreReadWithTimeout\([\s\S]*?collectionName \+ ' 指定文件'/);

    const openStart=appSource.indexOf('window.openPurchaseOrderFromOrder = async function');
    const openEnd=appSource.indexOf('/* =========================================================\n   產生訂購單',openStart);
    const openSource=appSource.slice(openStart,openEnd);
    assert.match(openSource,/beginActionButton\(button, '開啟中…'\)/);
    assert.match(openSource,/firestoreReadWithTimeout\([\s\S]*?'訂購單紀錄'/);
    assert.match(openSource,/await reprintPurchaseOrder\(po\.id\)/);
    assert.match(openSource,/endActionButton\(button, buttonState\)/);
});


test('receipt allocation and affected-order refresh use bounded batched reads', () => {
    const allocateStart=appSource.indexOf('async function allocateFreeReceiptStockToShortages');
    const allocateEnd=appSource.indexOf('async function refreshAffectedOrderCaches',allocateStart);
    const allocateSource=appSource.slice(allocateStart,allocateEnd);
    assert.match(allocateSource,/firestoreReadWithTimeout\(q\.get\(\),'庫存占用候選'\)/);

    const refreshStart=appSource.indexOf('async function refreshAffectedOrderCaches');
    const refreshEnd=appSource.indexOf('async function receiveSupplyOrderRecord',refreshStart);
    const refreshSource=appSource.slice(refreshStart,refreshEnd);
    assert.match(refreshSource,/readDocumentsByIds\('orders',ids\)/);
    assert.doesNotMatch(refreshSource,/\.doc\(id\)\.get\(\)/);
});

test('customer transaction history reads are bounded', () => {
    const start=appSource.indexOf('window.showCustomerOrderHistory = async function');
    const end=appSource.indexOf('window.closeCustomerOrderHistory',start);
    const source=appSource.slice(start,end);
    assert.match(source,/firestoreReadWithTimeout\(scopedHistorySearchQuery\('orders',[\s\S]*?'客戶訂單歷史'\)/);
    assert.match(source,/firestoreReadWithTimeout\(scopedHistorySearchQuery\('quotes',[\s\S]*?'客戶估價歷史'\)/);
});


test('shared brand settings reads are bounded', () => {
    const companyStart=appSource.indexOf('function loadCompanyAgencyBrandSettings');
    const companyEnd=appSource.indexOf('\nfunction loadSalesStatisticsSettings',companyStart);
    const companySource=appSource.slice(companyStart,companyEnd);
    assert.match(companySource,/firestoreReadWithTimeout\([\s\S]*?companyAgencyBrands[\s\S]*?'公司代理廠牌設定'/);

    const statsStart=appSource.indexOf('function loadSalesStatisticsSettings');
    const statsEnd=appSource.indexOf('\nlet brandSettingsLoadPromise',statsStart);
    const statsSource=appSource.slice(statsStart,statsEnd);
    assert.match(statsSource,/firestoreReadWithTimeout\([\s\S]*?salesStatistics[\s\S]*?'重點廠牌設定'/);
});


test('interactive quote forecast product reads are bounded', () => {
    assert.equal((appSource.match(/Product Master 重複貨號檢查/g) || []).length, 2);
    for (const label of [
        'Forecast 歷史紀錄',
        'Forecast Product Master',
        'Forecast 來源估價單',
        '複製估價單',
        '建立 Forecast 的估價單',
        '成交轉訂單估價單'
    ]) assert.match(appSource, new RegExp(label));

    const copyStart=appSource.indexOf('window.copyQuoteAsNew = async function');
    const copyEnd=appSource.indexOf('/* ---------- 我的估價單',copyStart);
    assert.match(appSource.slice(copyStart,copyEnd),/firestoreReadWithTimeout/);

    const dealStart=appSource.indexOf('window.markQuoteAsDeal = async function');
    const dealEnd=appSource.indexOf('window.unmarkQuoteAsDeal',dealStart);
    assert.match(appSource.slice(dealStart,dealEnd),/firestoreReadWithTimeout/);
});


test('product save buttons show feedback during duplicate checks', () => {
    const editorStart=appSource.indexOf('window.saveProductMasterEditor = async function');
    const editorEnd=appSource.indexOf('\n};',editorStart)+3;
    const editorSource=appSource.slice(editorStart,editorEnd);
    assert.match(editorSource,/beginActionButton\(button, '檢查中…'\)[\s\S]*?Product Master 重複貨號檢查/);
    assert.match(editorSource,/button\.textContent = '儲存中…'/);
    assert.match(editorSource,/endActionButton\(button, state\)/);

    const quickStart=appSource.indexOf('window.saveQuickProduct = async function');
    const quickEnd=appSource.indexOf('\n};',quickStart)+3;
    const quickSource=appSource.slice(quickStart,quickEnd);
    assert.match(quickSource,/beginActionButton\(button, '檢查中…'\)[\s\S]*?Product Master 重複貨號檢查/);
    assert.match(quickSource,/button\.textContent = '儲存中…'/);
    assert.match(quickSource,/endActionButton\(button, state\)/);
});


test('customer preference and inventory detail reads are bounded', () => {
    assert.match(appSource,/客戶估價偏好/);
    assert.match(appSource,/庫存占用明細/);

    const preferenceStart=appSource.indexOf('window.applyCustomerQuotePreferences = async function');
    const preferenceEnd=appSource.indexOf('\nwindow.addQuoteCustomField',preferenceStart);
    assert.match(appSource.slice(preferenceStart,preferenceEnd),/firestoreReadWithTimeout/);

    const reservationStart=appSource.indexOf('window.openInventoryReservationDetails = async function');
    const reservationEnd=appSource.indexOf('\nwindow.closeInventoryReservationDetails',reservationStart);
    assert.match(appSource.slice(reservationStart,reservationEnd),/firestoreReadWithTimeout/);
});


test('forecast warehouse and business product reads are bounded', () => {
    const forecastStart=appSource.indexOf('window.loadForecasts = async function');
    const forecastEnd=appSource.indexOf('let forecastHistorySearchActive',forecastStart);
    assert.match(appSource.slice(forecastStart,forecastEnd),/firestoreReadWithTimeout\(query\.get\(\), 'Forecast 清單'\)/);

    const warehouseStart=appSource.indexOf('async function warehouseStockSnapshot');
    const warehouseEnd=appSource.indexOf('let orderWarehouseStockRefreshGeneration',warehouseStart);
    assert.match(appSource.slice(warehouseStart,warehouseEnd),/firestoreReadWithTimeout\(ref\.get\(\), '倉庫庫存'\)/);

    const searchStart=appSource.indexOf('window.searchBusinessProducts=async function');
    const searchEnd=appSource.indexOf('let inventorySearchTimer',searchStart);
    const searchSource=appSource.slice(searchStart,searchEnd);
    assert.match(searchSource,/產品貨號搜尋/);
    assert.match(searchSource,/產品名稱搜尋/);
    assert.match(searchSource,/產品庫存搜尋/);
});


test('own-scope forecast does not preload full staff directory', () => {
    const loadStart=appSource.indexOf('window.loadForecasts = async function');
    const loadEnd=appSource.indexOf('let forecastHistorySearchActive',loadStart);
    const loadSource=appSource.slice(loadStart,loadEnd);
    assert.match(loadSource,/if \(canViewAllData\('forecast'\)\) await ensureSalesListLoaded\(\)/);
    assert.match(loadSource,/else populateForecastSalesFilter\(\)/);

    const initStart=appSource.indexOf('function initializePageData(mainKey');
    const initEnd=appSource.indexOf('\nfunction ensureSalesListLoaded',initStart);
    const initSource=appSource.slice(initStart,initEnd);
    const blockStart=initSource.indexOf("if (mainKey === 'forecast')");
    const blockEnd=initSource.indexOf("if (mainKey === 'quote')",blockStart);
    const block=initSource.slice(blockStart,blockEnd);
    assert.match(block,/if \(canViewAllData\('forecast'\)\)/);
    assert.match(block,/else \{\s*populateForecastSalesFilter\(\)/);
});


test('admin maintenance reads are bounded', () => {
    const transferStart=appSource.indexOf('async function legacySalesDocsInPages');
    const transferEnd=appSource.indexOf('async function countLegacyRecordsForSalesCode',transferStart);
    const transferSource=appSource.slice(transferStart,transferEnd);
    assert.match(transferSource,/firestoreReadWithTimeout\([\s\S]*?collectionName \+ ' 舊業務資料'/);

    const executeStart=appSource.indexOf('window.executeSalesTransfer = async function');
    const executeEnd=appSource.indexOf('// 依 Firestore batch 500 筆上限',executeStart);
    const executeSource=appSource.slice(executeStart,executeEnd);
    assert.match(executeSource,/firestoreReadWithTimeout\([\s\S]*?'業務代號交接紀錄'/);

    const indexStart=appSource.indexOf('window.backfillOrderSearchIndex = async function');
    const indexEnd=appSource.indexOf('/* ---------- Product Master',indexStart);
    const indexSource=appSource.slice(indexStart,indexEnd);
    assert.match(indexSource,/firestoreReadWithTimeout\([\s\S]*?搜尋索引補建/);

    const migrationStart=appSource.indexOf('async function readCollectionForMigration');
    const migrationEnd=appSource.indexOf('function recordContainsEmbeddedCost',migrationStart);
    assert.match(appSource.slice(migrationStart,migrationEnd),/firestoreReadWithTimeout\([\s\S]*?遷移資料/);

    const importStart=appSource.indexOf('async function summarizeProductMasterImport');
    const importEnd=appSource.indexOf('async function confirmProductMasterImport',importStart);
    const importSource=appSource.slice(importStart,importEnd);
    assert.match(importSource,/firestoreReadWithTimeout\([\s\S]*?'Product Master 匯入比對'/);
    assert.match(importSource,/FieldPath\.documentId\(\), 'in', ids/);
    assert.match(importSource,/uniqueProductIds/);
    assert.doesNotMatch(importSource,/Promise\.all\(chunk\.map/);
});


test('test data reset reads are bounded', () => {
    const start=appSource.indexOf('async function countCollectionDocuments');
    const end=appSource.indexOf('\nwindow.previewTestDataReset',start);
    const source=appSource.slice(start,end);
    assert.match(source,/firestoreReadWithTimeout\(query\.get\(\), `\$\{name\} 文件數量`\)/);
    assert.match(source,/firestoreReadWithTimeout\([\s\S]*?limit\(300\)\.get\(\)[\s\S]*?`\$\{name\} 清除批次`/);
    assert.match(source,/firestoreReadWithTimeout\(query\.get\(\), `\$\{name\} 庫存歸零批次`\)/);
});


test('own-scope equipment page avoids full staff preload', () => {
    const dropdownStart=appSource.indexOf('function populateEquipmentSalesDropdown');
    const dropdownEnd=appSource.indexOf('\nfunction loadCompanyAgencyBrandSettings',dropdownStart);
    const dropdownSource=appSource.slice(dropdownStart,dropdownEnd);
    assert.match(dropdownSource,/canViewAllEquipment\(\)[\s\S]*?salesList[\s\S]*?currentUserName/);

    const assetStart=appSource.indexOf('function getNextAssetId');
    const assetEnd=appSource.indexOf('// 型號輸入時',assetStart);
    const assetSource=appSource.slice(assetStart,assetEnd);
    assert.match(assetSource,/salesName === currentUserName && currentUserCode/);

    const initStart=appSource.indexOf("if (mainKey === 'equipment') {");
    const initEnd=appSource.indexOf("if (mainKey === 'admin')",initStart);
    const initSource=appSource.slice(initStart,initEnd);
    assert.match(initSource,/if \(canViewAllEquipment\(\)\) \{[\s\S]*?ensureSalesListLoaded\(\)/);
    assert.match(initSource,/else \{[\s\S]*?populateEquipmentSalesDropdown\(\)/);
    assert.doesNotMatch(initSource,/loadBrandMaster\(\)\.then\(renderEquipmentList\)/);
});


test('company agency settings do not rebuild product datalists', () => {
    const start=appSource.indexOf('function loadCompanyAgencyBrandSettings');
    const end=appSource.indexOf('\nfunction loadSalesStatisticsSettings',start);
    const source=appSource.slice(start,end);
    assert.match(source,/renderCompanyAgencyBrandSettings\(\)/);
    const executable = source.replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(executable,/refreshPriceDatalists\(\)/);
});


test('inventory initialization avoids duplicate brand-driven render', () => {
    const start=appSource.indexOf("if (mainKey === 'inventory') {");
    const end=appSource.indexOf("if (mainKey === 'equipment')",start);
    const source=appSource.slice(start,end);
    assert.match(source,/loadInventory\(true\)/);
    assert.doesNotMatch(source,/loadBrandMaster\(\)\.then\(renderInventoryList\)/);
});


test('purchasing order refresh updates cache without duplicate render', () => {
    const orderStart=appSource.indexOf('async function loadOrderPage');
    const orderEnd=appSource.indexOf('\nwindow.loadOrdersFromCloud',orderStart);
    const orderSource=appSource.slice(orderStart,orderEnd);
    assert.match(orderSource,/if \(!options\.skipRender\) \{[\s\S]*?renderOrdersList\(\)[\s\S]*?renderPurchasingView\(\)/);
    assert.doesNotMatch(orderSource,/if \(!options\.skipRender\) \{[\s\S]*?renderPurchasingWorkCards\(\)/);

    const refreshStart=appSource.indexOf('function refreshPurchasingOrderCache');
    const refreshEnd=appSource.indexOf('\nfunction loadPurchasingReceivingQueue',refreshStart);
    const refreshSource=appSource.slice(refreshStart,refreshEnd);
    assert.match(refreshSource,/loadOrderPage\(reset, \{ silent: true, skipRender: true \}\)/);
});

test('purchaser order edit fields match visible order UI', () => {
    const start=rulesSource.indexOf('function purchaserOrderWorkflowUpdate()');
    const end=rulesSource.indexOf('function warehouseOrderWorkflowUpdate()',start);
    const source=rulesSource.slice(start,end);
    for (const field of ['costPrice','transactionType','invoiceTitle','remarks','invoiceDate','fieldEditHistory']) {
        assert.match(source,new RegExp("'" + field + "'"));
    }
    assert.match(source,/sameCommercialOwner\(\)/);
    assert.doesNotMatch(source,/'ownerUid'/);
    assert.doesNotMatch(source,/'salesCode'/);
    assert.doesNotMatch(source,/'unitPrice'/);
});


test('purchasing work tabs reuse one shared orders refresh', () => {
    assert.match(appSource,/let purchasingOrdersReady = false/);

    const refreshStart=appSource.indexOf('function refreshPurchasingOrderCache');
    const refreshEnd=appSource.indexOf('\nfunction loadPurchasingReceivingQueue',refreshStart);
    const refreshSource=appSource.slice(refreshStart,refreshEnd);
    assert.match(refreshSource,/options\.reuseOrders && purchasingOrdersReady/);
    assert.match(refreshSource,/purchasingOrdersReady = true/);

    const switchStart=appSource.indexOf('window.switchPurchasingView = function');
    const switchEnd=appSource.indexOf('\nasync function loadPurchasingDispatchOrders',switchStart);
    const switchSource=appSource.slice(switchStart,switchEnd);
    assert.match(switchSource,/loadPendingPurchaseOrders\(true, \{ reuseOrders:true \}\)/);
    assert.match(switchSource,/loadPurchasingReceivingQueue\(true, \{ reuseOrders:true \}\)/);
    assert.match(switchSource,/loadPurchasingDispatchOrders\(true, \{ reuseOrders:true \}\)/);

    const roleStart=appSource.indexOf('window.switchViewRole = function');
    const roleEnd=appSource.indexOf('\nfunction actuallySwitchMainTab',roleStart);
    assert.match(appSource.slice(roleStart,roleEnd),/purchasingOrdersReady = false/);
});


test('quote form loads staff only for roles that need owner selection', () => {
    const start=appSource.indexOf('function ensureQuoteFormInitialized');
    const end=appSource.indexOf('\n\nwindow.openChangePasswordModal',start);
    const source=appSource.slice(start,end);
    assert.match(source,/currentUserRole === 'admin' \|\| currentUserRole === 'purchaser' \|\| currentUserRole === 'engineer'/);
    assert.match(source,/ensureSalesListLoaded\(\)/);
    assert.match(source,/else \{[\s\S]*?populateSalesDropdown\(\)/);

    const selectorStart=appSource.indexOf('function populateSalesDropdown()');
    const selectorEnd=appSource.indexOf('\n// 依目前輸入的業務姓名',selectorStart);
    const selectorSource=appSource.slice(selectorStart,selectorEnd);
    assert.match(selectorSource,/currentUserRole === 'engineer'[\s\S]*?s\.uid === currentUser\?\.uid \|\| role === 'sales'/);

    const phoneStart=appSource.indexOf('function updateSalesPhoneDisplay');
    const phoneEnd=appSource.indexOf('\nfunction populateEquipmentSalesDropdown',phoneStart);
    const phoneSource=appSource.slice(phoneStart,phoneEnd);
    assert.match(phoneSource,/selectedName === currentUserName/);
    assert.match(phoneSource,/currentUserPhone/);
});


test('order list calculates row progress summaries once', () => {
    const start=appSource.indexOf('window.renderOrdersList = function()');
    const end=appSource.indexOf('window.retryOrderInventoryReservation',start);
    const source=appSource.slice(start,end);
    assert.equal((source.match(/deliveryProgressInfo\(o, allOrderItems\)/g) || []).length, 1);
    assert.equal((source.match(/fulfillmentProgressInfo\(o, allOrderItems, dispatchStateByItem\)/g) || []).length, 1);
    assert.equal((source.match(/orderContextActionState\(o, allOrderItems, dispatchStateByItem\)/g) || []).length, 1);
    assert.match(source,/const dispatchStatesByOrder = new Map\(baseOrders\.map/);
    assert.match(source,/const dispatchStateByItem = dispatchStatesByOrder\.get\(o\.id\) \|\| new Map\(\)/);
    assert.match(source,/const displayCategoriesByItem = new Map/);
    assert.match(source,/const deliveryPending = pendingDeliveryOrderIds\.has\(o\.id\)/);
    assert.match(source,/const billingPending = pendingOrderStatusKeys\.has\(o\.id \+ ':isBilled'\)/);
    assert.match(source,/const lifecyclePending = pendingLifecycleOrderIds\.has\(o\.id\)/);
});

test('order work cards reuse normalized order items', () => {
    const amountStart=appSource.indexOf('function orderItemWorkAmount');
    const amountEnd=appSource.indexOf('\nfunction buildOrderItemWorkMetrics',amountStart);
    const amountSource=appSource.slice(amountStart,amountEnd);
    assert.match(amountSource,/totalQtyOverride = null/);
    assert.match(amountSource,/totalQtyOverride === null \? orderQuantity\(order\) : totalQtyOverride/);

    const metricsStart=appSource.indexOf('function buildOrderItemWorkMetrics');
    const metricsEnd=appSource.indexOf('\nwindow.setOrderWorkFilter',metricsStart);
    const metricsSource=appSource.slice(metricsStart,metricsEnd);
    assert.match(metricsSource,/normalizedItemsByOrder\?\.get\(order\.id\) \|\| normalizedOrderItems\(order\)/);
    assert.match(metricsSource,/orderItemWorkAmount\(order,item,category,totalQty,dispatch\)/);
    assert.match(metricsSource,/const dispatch = orderDispatchStates\?\.get\(item\) \|\| itemDispatchState\(order, item\)/);

    const cardsStart=appSource.indexOf('function renderOrderWorkCards');
    const cardsEnd=appSource.indexOf('\nfunction createOrderPaginationState',cardsStart);
    const cardsSource=appSource.slice(cardsStart,cardsEnd);
    assert.match(cardsSource,/normalizedItemsByOrder = null, dispatchStatesByOrder = null, lifecyclesByOrder = null/);

    const listStart=appSource.indexOf('window.renderOrdersList = function()');
    const listEnd=appSource.indexOf('window.retryOrderInventoryReservation',listStart);
    const listSource=appSource.slice(listStart,listEnd);
    assert.match(listSource,/renderOrderWorkCards\(baseOrders, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder\)/);
});

test('read-only order roles see non-editable row controls', () => {
    const start=appSource.indexOf('window.renderOrdersList = function()');
    const end=appSource.indexOf('\nwindow.retryOrderInventoryReservation',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const canEditOrders = canEditPage\('orders\.list'\)/);
    assert.match(source,/if \(!canEditOrders\)/);
    assert.match(source,/order-transaction-cell select, \.order-transaction-cell input/);
    assert.match(source,/td\[data-th="備註"\] input/);
    assert.match(source,/control\.disabled = true/);
    assert.match(source,/openOrderStatusHistory/);
    assert.match(source,/button\.remove\(\)/);
});


test('shared brand and warehouse master reads are bounded', () => {
    const warehouseStart=appSource.indexOf('async function loadWarehouseMaster');
    const warehouseEnd=appSource.indexOf('\nasync function loadSupplierWarehouseMasters',warehouseStart);
    const warehouseSource=appSource.slice(warehouseStart,warehouseEnd);
    assert.match(warehouseSource,/firestoreReadWithTimeout\([\s\S]*?warehouses[\s\S]*?'倉庫主檔'/);

    const companyStart=appSource.indexOf('function loadCompanyAgencyBrandSettings');
    const companyEnd=appSource.indexOf('\nfunction loadSalesStatisticsSettings',companyStart);
    const companySource=appSource.slice(companyStart,companyEnd);
    assert.match(companySource,/firestoreReadWithTimeout\([\s\S]*?companyAgencyBrands[\s\S]*?'公司代理廠牌設定'/);

    const statsStart=appSource.indexOf('function loadSalesStatisticsSettings');
    const statsEnd=appSource.indexOf('\nlet brandSettingsLoadPromise',statsStart);
    const statsSource=appSource.slice(statsStart,statsEnd);
    assert.match(statsSource,/firestoreReadWithTimeout\([\s\S]*?salesStatistics[\s\S]*?'重點廠牌設定'/);
});


test('purchasing render reuses normalized order items', () => {
    const cardsStart=appSource.indexOf('function renderPurchasingWorkCards');
    const cardsEnd=appSource.indexOf('\nfunction purchasingCompletedRows',cardsStart);
    const cardsSource=appSource.slice(cardsStart,cardsEnd);
    assert.match(cardsSource,/const itemMap = normalizedItemsByOrder \|\| new Map/);
    assert.match(cardsSource,/const stateMap = dispatchStatesByOrder \|\| purchasingDispatchStateSnapshot\(itemMap\)/);
    assert.match(cardsSource,/const lifecycleMap = lifecyclesByOrder \|\| purchasingLifecycleSnapshot\(itemMap\)/);
    assert.match(cardsSource,/buildOrderItemWorkMetrics\([\s\S]*?itemMap,[\s\S]*?stateMap,[\s\S]*?lifecycleMap/);
    assert.match(cardsSource,/purchasingCompletedRows\(filters, itemMap, stateMap, lifecycleMap\)/);

    const rowsStart=appSource.indexOf('function purchasingCompletedRows');
    const rowsEnd=appSource.indexOf('\nfunction renderPurchasingCompletedOrders',rowsStart);
    const rowsSource=appSource.slice(rowsStart,rowsEnd);
    assert.match(rowsSource,/normalizedItemsByOrder\?\.get\(order\.id\) \|\| normalizedOrderItems\(order\)/);
    assert.match(rowsSource,/dispatchStatesByOrder\?\.get\(order\.id\)/);
    assert.match(rowsSource,/lifecyclesByOrder\?\.get\(order\.id\)/);

    const viewStart=appSource.indexOf('window.renderPurchasingView = function()');
    const viewEnd=appSource.indexOf('\nwindow.changePurchasePeriod',viewStart);
    const viewSource=appSource.slice(viewStart,viewEnd);
    assert.match(viewSource,/const normalizedItemsByOrder = new Map/);
    assert.match(viewSource,/const dispatchStatesByOrder = purchasingDispatchStateSnapshot\(normalizedItemsByOrder\)/);
    assert.match(viewSource,/const lifecyclesByOrder = purchasingLifecycleSnapshot\(normalizedItemsByOrder\)/);
    assert.match(viewSource,/renderPurchasingWorkCards\(normalizedItemsByOrder, completedRows, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
});

test('page initialization avoids duplicate purchasing and quote brand renders', () => {
    const hydrateStart=appSource.indexOf('function hydratePageFromLocalCache');
    const hydrateEnd=appSource.indexOf('\nfunction initializePageData',hydrateStart);
    const hydrateSource=appSource.slice(hydrateStart,hydrateEnd);
    const poStart=hydrateSource.indexOf("if (mainKey === 'orders.po')");
    const poSource=hydrateSource.slice(poStart);
    assert.doesNotMatch(poSource,/renderPurchasingWorkCards\(\)/);

    const initStart=appSource.indexOf('function initializePageData');
    const initEnd=appSource.indexOf('\nfunction ensureSalesListLoaded',initStart);
    const initSource=appSource.slice(initStart,initEnd);
    assert.doesNotMatch(initSource,/if \(mainKey === 'quote'\) populateQuoteBrandDropdowns\(\)/);
});

test('quote number lookup has bounded Firestore wait', () => {
    const start=appSource.indexOf('window.generateQuoteNo = async function()');
    const end=appSource.indexOf('\nwindow.onSalesChange',start);
    const source=appSource.slice(start,end);
    assert.match(source,/firestoreReadWithTimeout\([\s\S]*?collection\('quotes'\)[\s\S]*?'估價單號'/);
});


test('new quote persistence cannot overwrite an existing quote number', () => {
    const start=appSource.indexOf('function persistQuoteOutputRecord');
    const end=appSource.indexOf('\nfunction quoteDataForPdfExport',start);
    const source=appSource.slice(start,end);
    assert.match(source,/db\.runTransaction\(async transaction/);
    assert.match(source,/transaction\.get\(quoteRef\)/);
    assert.match(source,/snapshot\.exists && !updatingExisting/);
    assert.match(source,/quote-number-conflict/);
    assert.match(source,/transaction\.set\(quoteRef, quoteData, \{ merge: true \}\)/);
    assert.match(source,/setQuoteEditingContext\(quoteData\.quoteNo\)/);
});

test('first quote PDF waits for safe quote creation before rendering', () => {
    const start=appSource.indexOf('window.exportCurrentQuotePdf = async function()');
    const end=appSource.indexOf('\nwindow.loadQuoteFromCloud',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const isNewQuote = !editingQuoteNo \|\| editingQuoteNo !== quoteData\.quoteNo/);
    assert.match(source,/if \(isNewQuote\)[\s\S]*?await persistQuoteOutputRecord\(quoteData, 'PDF'\)/);
    const persistIndex=source.indexOf("await persistQuoteOutputRecord(quoteData, 'PDF')");
    const stageIndex=source.indexOf('createQuotePdfStage(quoteData)');
    assert.ok(persistIndex >= 0 && stageIndex > persistIndex);
});

test('legacy quote lookup keeps the loaded quote number and editing context', () => {
    const start=appSource.indexOf('async function fetchAndFillQuote');
    const end=appSource.indexOf('\nwindow.openQuoteFromAdmin',start);
    const source=appSource.slice(start,end);
    assert.match(source,/firestoreReadWithTimeout\([\s\S]*?'載入估價單'/);
    assert.match(source,/applyCompanyTheme\(data\.company \|\| 'yushin'\)/);
    assert.doesNotMatch(source,/switchCompany\(/);
    assert.match(source,/setQuoteEditingContext\(data\.quoteNo \|\| qNo\)/);
});


test('receiving refresh coalesces final purchasing render', () => {
    const queueStart=appSource.indexOf('function loadPurchasingReceivingQueue');
    const queueEnd=appSource.indexOf('\nlet purchasingFilterOptionsSignature',queueStart);
    const queueSource=appSource.slice(queueStart,queueEnd);
    assert.match(queueSource,/loadPurchaseOrderPage\(reset, \{ deferRender:true \}\)/);
    assert.match(queueSource,/renderPurchasingView\(\)/);

    const pageStart=appSource.indexOf('async function loadPurchaseOrderPage');
    const pageEnd=appSource.indexOf('\nwindow.loadMyPurchaseOrders',pageStart);
    const pageSource=appSource.slice(pageStart,pageEnd);
    assert.match(pageSource,/const deferRender = options\.deferRender === true/);
    assert.match(pageSource,/if \(!deferRender\) \{[\s\S]*?purchasingView === 'receiving'\) renderPurchasingView\(\)[\s\S]*?else renderPoList\(\)/);
    assert.doesNotMatch(pageSource,/if \(!deferRender\) renderPurchasingWorkCards\(\)/);
});

test('existing quote output preserves audit and background metadata', () => {
    const start=appSource.indexOf('function persistQuoteOutputRecord');
    const end=appSource.indexOf('\nfunction quoteDataForPdfExport',start);
    const source=appSource.slice(start,end);
    assert.match(source,/if \(snapshot\.exists && updatingExisting\)/);
    assert.match(source,/quoteData\.createdAt = existing\.createdAt \|\| quoteData\.createdAt/);
    assert.match(source,/quoteData\.createdByUid = existing\.createdByUid/);
    assert.match(source,/quoteData\.createdByName = existing\.createdByName/);
    assert.match(source,/quoteData\.createdByRole = existing\.createdByRole/);
    assert.match(source,/transaction\.set\(quoteRef, quoteData, \{ merge: true \}\)/);
});


test('purchasing detail render reuses normalized item snapshots', () => {
    const pendingLinesStart=appSource.indexOf('function pendingProcurementDisplayLines');
    const pendingLinesEnd=appSource.indexOf('\nfunction renderPurchasingWorkCards',pendingLinesStart);
    const pendingLinesSource=appSource.slice(pendingLinesStart,pendingLinesEnd);
    assert.match(pendingLinesSource,/normalizedItems \|\| normalizedOrderItems\(order\)/);
    assert.match(pendingLinesSource,/dispatchStateByItem\?\.get\(item\)/);
    assert.match(pendingLinesSource,/lifecycleOverride \|\| orderLifecycleInfo\(order, items\)/);

    const viewStart=appSource.indexOf('window.renderPurchasingView = function()');
    const viewEnd=appSource.indexOf('\nwindow.changePurchasePeriod',viewStart);
    const viewSource=appSource.slice(viewStart,viewEnd);
    assert.match(viewSource,/renderPendingPurchaseOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(viewSource,/renderPurchasingDispatchOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(viewSource,/renderPoList\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
});

test('remaining interactive Firestore reads are bounded', () => {
    const forecastStart=appSource.indexOf('window.createForecastFromQuote = async function');
    const forecastEnd=appSource.indexOf('\nwindow.markQuoteAsDeal',forecastStart);
    const forecastSource=appSource.slice(forecastStart,forecastEnd);
    assert.match(forecastSource,/firestoreReadWithTimeout\([\s\S]*?Forecast 重複來源檢查/);

    const inventoryStart=appSource.indexOf('async function loadWarehouseStocksForInventoryPage');
    const inventoryEnd=appSource.indexOf('\nwindow.loadInventory=',inventoryStart);
    const inventorySource=appSource.slice(inventoryStart,inventoryEnd);
    assert.match(inventorySource,/firestoreReadWithTimeout\([\s\S]*?倉庫庫存批次/);

    const equipmentStart=appSource.indexOf('function loadEquipmentFromCloudThenReopen');
    const equipmentEnd=appSource.indexOf('\n// 依 Firestore batch',equipmentStart);
    const equipmentSource=appSource.slice(equipmentStart,equipmentEnd);
    assert.match(equipmentSource,/firestoreReadWithTimeout\([\s\S]*?儀器單筆資料/);
});


test('completed purchasing load-more avoids double render after fetching', () => {
    const start=appSource.indexOf('window.loadMorePurchasingCompleted = async function()');
    const end=appSource.indexOf('\nwindow.renderPurchasingView',start);
    const source=appSource.slice(start,end);
    assert.match(source,/await loadPurchasingDispatchOrders\(false\);\s*return;/);
    assert.match(source,/renderPurchasingCompletedOrders\(loadedRows\)/);
});


test('receiving work list indexes supply evidence once per render', () => {
    const indexStart=appSource.indexOf('function buildReceivingEvidenceIndex');
    const indexEnd=appSource.indexOf('\nfunction receivingEvidenceForWorkItem',indexStart);
    const indexSource=appSource.slice(indexStart,indexEnd);
    assert.match(indexSource,/supplyReceivingCache\.forEach/);
    assert.match(indexSource,/::id:/);
    assert.match(indexSource,/::idx:/);

    const renderStart=appSource.indexOf('function renderPurchasingReceivingWorkList');
    const renderEnd=appSource.indexOf('\nwindow.renderPoList',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/const evidenceIndex = buildReceivingEvidenceIndex\(\)/);
    assert.match(renderSource,/receivingEvidenceForWorkItem\(order, item, itemIndex, evidenceIndex\)/);
});


test('quote numbering fails closed and preserves editing identity', () => {
    const start=appSource.indexOf('window.generateQuoteNo = async function()');
    const end=appSource.indexOf('\n// 估價單可歸屬業務或工程師',start);
    const source=appSource.slice(start,end);
    assert.match(source,/if \(editingQuoteNo && !restoringQuoteDraft\)/);
    assert.match(source,/quoteNoInput\.value = editingQuoteNo/);
    assert.doesNotMatch(source,/prefix\}01/);
    assert.match(source,/quoteNoInput\.value = ''/);
    assert.match(source,/無法取得安全的估價單號/);

    const salesStart=appSource.indexOf('window.onSalesChange = function()');
    const salesEnd=appSource.indexOf('\n};',salesStart)+3;
    assert.match(appSource.slice(salesStart,salesEnd),/if \(!editingQuoteNo\) generateQuoteNo\(\)/);

    const dropdownStart=appSource.indexOf('function populateSalesDropdown()');
    const dropdownEnd=appSource.indexOf('\n// 依目前輸入的業務姓名',dropdownStart);
    assert.match(appSource.slice(dropdownStart,dropdownEnd),/if \(!restoringQuoteDraft && !editingQuoteNo\) generateQuoteNo\(\)/);
});


test('product master search throttles intermediate table renders', () => {
    const start=appSource.indexOf('window.searchProductManagement = async function()');
    const end=appSource.indexOf('\nfunction ensureProductMasterEditor',start);
    const source=appSource.slice(start,end);
    assert.match(source,/let lastIntermediateRenderAt = 0/);
    assert.match(source,/now - lastIntermediateRenderAt >= 100/);
    assert.match(source,/productManagementResults = \[\.\.\.map\.values\(\)\][\s\S]*?renderProductManagementResults\(\);[\s\S]*?if \(status\) \{/);
    assert.match(source,/完成，共 \$\{productManagementResults\.length\} 筆/);
});


test('quote list filters avoid rebuilding unchanged options', () => {
    const brandStart=appSource.indexOf('function populateMyQuoteBrandFilter');
    const brandEnd=appSource.indexOf('\nfunction populateMyQuoteSalesFilter',brandStart);
    const brandSource=appSource.slice(brandStart,brandEnd);
    assert.match(appSource,/let myQuoteBrandFilterSignature = ''/);
    assert.match(brandSource,/signature !== myQuoteBrandFilterSignature/);

    const salesStart=appSource.indexOf('function populateMyQuoteSalesFilter');
    const salesEnd=appSource.indexOf('\nwindow.renderMyQuotesList',salesStart);
    const salesSource=appSource.slice(salesStart,salesEnd);
    assert.match(appSource,/let myQuoteSalesFilterSignature = ''/);
    assert.match(salesSource,/signature !== myQuoteSalesFilterSignature/);
});


test('quote list builds item search text only when searching', () => {
    const start=appSource.indexOf('window.renderMyQuotesList = function()');
    const end=appSource.indexOf('\nwindow.createForecastFromQuote',start);
    const source=appSource.slice(start,end);
    assert.match(source,/if \(!quoteHistorySearchActive && keyword\) \{[\s\S]*?const itemSearchText/);
    assert.match(source,/if \(!searchable\.includes\(keyword\)\) return/);
});


test('purchasing refresh loaders reuse normalized item snapshots', () => {
    const pendingStart=appSource.indexOf('window.loadPendingPurchaseOrders = async function');
    const pendingEnd=appSource.indexOf('\nconst pendingPurchaseOrderKeys',pendingStart);
    const pendingSource=appSource.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/normalizedItemsByOrder = new Map/);
    assert.match(pendingSource,/pendingProcurementDisplayLines\([\s\S]*?normalizedItemsByOrder\.get\(order\.id\),[\s\S]*?dispatchStatesByOrder\.get\(order\.id\),[\s\S]*?lifecyclesByOrder\.get\(order\.id\)/);
    assert.match(pendingSource,/renderPendingPurchaseOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);

    const dispatchStart=appSource.indexOf('async function loadPurchasingDispatchOrders');
    const dispatchEnd=appSource.indexOf('\nwindow.loadPurchasingDispatchOrders',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/normalizedItemsByOrder = new Map/);
    assert.match(dispatchSource,/renderPurchasingDispatchOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(dispatchSource,/renderPurchasingCompletedOrders\(completedRows\)/);
});

test('Product Master search renders results in 100-row UI pages', () => {
    assert.match(indexSource,/id="productManagementMoreRow"/);
    assert.match(indexSource,/id="productManagementMoreBtn"[^>]*onclick="loadMoreProductManagementResults\(\)"/);
    const stateStart=appSource.indexOf('let productManagementResults = []');
    const stateEnd=appSource.indexOf('let pendingProductMasterLoading',stateStart);
    const stateSource=appSource.slice(stateStart,stateEnd);
    assert.match(stateSource,/const PRODUCT_MANAGEMENT_RENDER_STEP = 100/);
    assert.match(stateSource,/let productManagementVisibleLimit = PRODUCT_MANAGEMENT_RENDER_STEP/);
    const renderStart=appSource.indexOf('function updateProductManagementMoreButton');
    const renderEnd=appSource.indexOf('window.clearProductManagementSearch',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/productManagementResults\.slice\(0, productManagementVisibleLimit\)/);
    assert.match(renderSource,/productManagementVisibleLimit \+= PRODUCT_MANAGEMENT_RENDER_STEP/);
    assert.match(cssSource,/\.product-load-more-row/);
});


test('product master search sorts only when rendering', () => {
    const start=appSource.indexOf('window.searchProductManagement = async function()');
    const end=appSource.indexOf('\nfunction ensureProductMasterEditor',start);
    const source=appSource.slice(start,end);
    const throttleStart=source.indexOf('if (now - lastIntermediateRenderAt >= 100)');
    const throttleEnd=source.indexOf('\n        }', throttleStart)+10;
    const throttleSource=source.slice(throttleStart,throttleEnd);
    assert.match(throttleSource,/productManagementResults = \[\.\.\.map\.values\(\)\]/);
    assert.match(source,/if \(generation !== productManagementSearchGeneration\) return;\s*productManagementResults = \[\.\.\.map\.values\(\)\]/);
});


test('order list skips search-string work when no keyword and batches DOM insertion', () => {
    const start=appSource.indexOf('window.renderOrdersList = function()');
    const end=appSource.indexOf('window.retryOrderInventoryReservation',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const fragment = document\.createDocumentFragment\(\)/);
    assert.match(source,/if \(!orderHistorySearchActive && keyword\) \{[\s\S]*?const itemSearchable[\s\S]*?const searchable/);
    assert.match(source,/fragment\.appendChild\(tr\)/);
    assert.match(source,/tbody\.appendChild\(fragment\)/);
    assert.doesNotMatch(source,/tbody\.appendChild\(tr\)/);
});


test('high frequency lookup reads are bounded', () => {
    assert.match(appSource,/firestoreReadWithTimeout\([\s\S]*?db\.collection\('products'\)\.doc\(productId\)\.get\(\)[\s\S]*?'Product Master'/);
    assert.match(appSource,/firestoreReadWithTimeout\([\s\S]*?db\.collection\('quotes'\)\.doc\(forecast\.sourceId\)\.get\(\)[\s\S]*?'Forecast 來源估價單'/);
    assert.match(appSource,/firestoreReadWithTimeout\([\s\S]*?db\.collection\('customers'\)[\s\S]*?\.limit\(20\)[\s\S]*?'Customer Master 客戶建議'/);
    assert.match(appSource,/firestoreReadWithTimeout\([\s\S]*?db\.collection\('customers'\)\.doc\(customerId\)\.get\(\)[\s\S]*?'客戶估價偏好'/);
});


test('purchasing work queues batch DOM row insertion', () => {
    const pendingStart=appSource.indexOf('function renderPendingPurchaseOrders(');
    const pendingEnd=appSource.indexOf('window.loadPendingPurchaseOrders =',pendingStart);
    const pendingSource=appSource.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/const fragment = document\.createDocumentFragment\(\)/);
    assert.match(pendingSource,/fragment\.appendChild\(row\)/);
    assert.match(pendingSource,/body\.appendChild\(fragment\)/);
    assert.doesNotMatch(pendingSource,/body\.appendChild\(row\)/);

    const dispatchStart=appSource.indexOf('function renderPurchasingDispatchOrders(');
    const dispatchEnd=appSource.indexOf('function pendingPurchaseLines(',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/const fragment=document\.createDocumentFragment\(\)/);
    assert.match(dispatchSource,/fragment\.appendChild\(tr\)/);
    assert.match(dispatchSource,/body\.appendChild\(fragment\)/);
    assert.doesNotMatch(dispatchSource,/body\.appendChild\(tr\)/);
});


test('purchase history skips hidden work-card calculations', () => {
    const renderStart=appSource.indexOf('window.renderPurchasingView = function()');
    const renderEnd=appSource.indexOf('\nwindow.changePurchasePeriod',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/if \(purchasingView === 'history'\) \{[\s\S]*?renderPoList\(\);[\s\S]*?return;/);

    const switchStart=appSource.indexOf('window.switchPurchasingView = function');
    const switchEnd=appSource.indexOf('\nasync function loadPurchasingDispatchOrders',switchStart);
    const switchSource=appSource.slice(switchStart,switchEnd);
    assert.match(switchSource,/const workflowView = !\['history', 'analytics'\]\.includes\(view\)/);
    assert.match(switchSource,/const normalizedItemsByOrder = workflowView[\s\S]*?: null/);
    assert.match(switchSource,/if \(workflowView\) renderPurchasingWorkCards/);
});


test('history search throttles intermediate list renders', () => {
    const orderStart=appSource.indexOf('function runOrderHistorySearch()');
    const orderEnd=appSource.indexOf('\nwindow.scheduleOrderHistorySearch',orderStart);
    const orderSource=appSource.slice(orderStart,orderEnd);
    assert.match(orderSource,/let lastIntermediateRenderAt = 0/);
    assert.match(orderSource,/now - lastIntermediateRenderAt >= 100 \|\| snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(orderSource,/orderHistorySearchResults = \[\.\.\.records\.values\(\)\][\s\S]*?renderOrdersList\(\)[\s\S]*?全歷史搜尋完成/);

    const quoteStart=appSource.indexOf('function runQuoteHistorySearch()');
    const quoteEnd=appSource.indexOf('\nwindow.scheduleQuoteHistorySearch',quoteStart);
    const quoteSource=appSource.slice(quoteStart,quoteEnd);
    assert.match(quoteSource,/let lastIntermediateRenderAt = 0/);
    assert.match(quoteSource,/now - lastIntermediateRenderAt >= 100 \|\| snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(quoteSource,/quoteHistorySearchResults = \[\.\.\.records\.values\(\)\][\s\S]*?renderMyQuotesList\(\)[\s\S]*?全歷史搜尋完成/);
});


test('forecast and equipment history searches throttle intermediate renders', () => {
    const forecastStart=appSource.indexOf('async function runForecastHistorySearch');
    const forecastEnd=appSource.indexOf('\nwindow.scheduleForecastHistorySearch',forecastStart);
    const forecastSource=appSource.slice(forecastStart,forecastEnd);
    assert.match(forecastSource,/let lastIntermediateRenderAt = 0/);
    assert.match(forecastSource,/now - lastIntermediateRenderAt >= 100 \|\| snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(forecastSource,/forecastHistorySearchResults = \[\.\.\.records\.values\(\)\][\s\S]*?renderForecastList\(\)[\s\S]*?全歷史搜尋完成/);

    const equipmentStart=appSource.indexOf('function runEquipmentSearch()');
    const equipmentEnd=appSource.indexOf('\nwindow.scheduleEquipmentSearch',equipmentStart);
    const equipmentSource=appSource.slice(equipmentStart,equipmentEnd);
    assert.match(equipmentSource,/let lastIntermediateRenderAt = 0/);
    assert.match(equipmentSource,/now - lastIntermediateRenderAt >= 100 \|\| snapshot\.size < DEFAULT_LIST_LIMIT/);
    assert.match(equipmentSource,/equipmentSearchResults = \[\.\.\.records\.values\(\)\][\s\S]*?renderEquipmentList\(\)[\s\S]*?全資料搜尋完成/);
});


test('equipment list reuses filter options and batches row insertion', () => {
    const filterStart=appSource.indexOf("let equipmentFilterOptionsSignature = ''");
    const filterEnd=appSource.indexOf('\nwindow.renderEquipmentList',filterStart);
    const filterSource=appSource.slice(filterStart,filterEnd);
    assert.match(filterSource,/const signature = JSON\.stringify\(\[canSeeAll, names, brands\]\)/);
    assert.match(filterSource,/if \(signature !== equipmentFilterOptionsSignature\)/);
    assert.match(filterSource,/equipmentFilterOptionsSignature = signature/);

    const renderStart=appSource.indexOf('window.renderEquipmentList = function()');
    const renderEnd=appSource.indexOf('\nfunction escapeHtml',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/const fragment = document\.createDocumentFragment\(\)/);
    assert.match(renderSource,/fragment\.appendChild\(tr\)/);
    assert.match(renderSource,/tbody\.appendChild\(fragment\)/);
    assert.doesNotMatch(renderSource,/tbody\.appendChild\(tr\)/);
});


test('forecast list reuses filter options and batches row insertion', () => {
    const brandStart=appSource.indexOf("let forecastBrandFilterSignature = ''");
    const brandEnd=appSource.indexOf('\nfunction populateForecastBrandDropdown',brandStart);
    const filterSource=appSource.slice(brandStart,brandEnd);
    assert.match(filterSource,/if \(signature !== forecastBrandFilterSignature\)/);
    assert.match(filterSource,/forecastBrandFilterSignature = signature/);
    assert.match(filterSource,/if \(signature !== forecastSalesFilterSignature\)/);
    assert.match(filterSource,/forecastSalesFilterSignature = signature/);

    const renderStart=appSource.indexOf('window.renderForecastList = function()');
    const renderEnd=appSource.indexOf('\nwindow.openForecastModal',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/const fragment = document\.createDocumentFragment\(\)/);
    assert.match(renderSource,/fragment\.appendChild\(row\)/);
    assert.match(renderSource,/body\.appendChild\(fragment\)/);
    assert.doesNotMatch(renderSource,/body\.appendChild\(row\)/);
});


test('quote list batches row insertion', () => {
    const start=appSource.indexOf('window.renderMyQuotesList = function()');
    const end=appSource.indexOf('\n// 成交：',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const fragment = document\.createDocumentFragment\(\)/);
    assert.match(source,/fragment\.appendChild\(tr\)/);
    assert.match(source,/tbody\.appendChild\(fragment\)/);
    assert.doesNotMatch(source,/tbody\.appendChild\(tr\)/);
});


test('receipt shortage allocation skips stale candidates without blocking later orders', () => {
    const start=appSource.indexOf('async function allocateFreeReceiptStockToShortages');
    const end=appSource.indexOf('\nasync function refreshAffectedOrderCaches',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const skippedCandidateIds = new Set\(\)/);
    assert.match(source,/filter\(row=>!skippedCandidateIds\.has\(row\.id\)\)/);
    assert.match(source,/if\(skipCandidate\)\{[\s\S]*?skippedCandidateIds\.add\(candidate\.id\);[\s\S]*?continue;/);
    assert.match(source,/if\(take<=0\)\{stopAllocation=true;return;\}/);
    assert.match(source,/if\(stopAllocation\)break;/);
});


test('successful history searches avoid duplicate final render', () => {
    const cases = [
        ['async function runOrderHistorySearch', '\nwindow.scheduleOrderHistorySearch', 'orderHistorySearchResults', 'updateOrderHistorySearchUi', 'renderOrdersList'],
        ['async function runQuoteHistorySearch', '\nwindow.scheduleQuoteHistorySearch', 'quoteHistorySearchResults', 'updateQuoteHistorySearchUi', 'renderMyQuotesList'],
        ['async function runForecastHistorySearch', '\nwindow.scheduleForecastHistorySearch', 'forecastHistorySearchResults', 'updateForecastHistorySearchStatus', 'renderForecastList']
    ];
    cases.forEach(([startTerm,endTerm,resultName,statusName,renderName]) => {
        const start=appSource.indexOf(startTerm);
        const end=appSource.indexOf(endTerm,start);
        const source=appSource.slice(start,end);
        const catchAt=source.indexOf('} catch (err)');
        const success=source.slice(0,catchAt);
        const completionAt=success.lastIndexOf('全歷史搜尋完成');
        assert.ok(completionAt > 0);
        const completionWindow=success.slice(Math.max(0,completionAt-500));
        assert.match(completionWindow,new RegExp(resultName + ' ='));
        assert.match(completionWindow,new RegExp(statusName + '\\('));
        assert.doesNotMatch(completionWindow,new RegExp(renderName + '\\(\\)'));
        const finallySource=source.slice(source.indexOf('} finally {'));
        assert.match(finallySource,new RegExp(renderName + '\\(\\)'));
    });
});

test('receipt allocation retry resumes after committed receipt without duplicate stock', () => {
    const allocateStart=appSource.indexOf('async function allocateFreeReceiptStockToShortages');
    const allocateEnd=appSource.indexOf('\nasync function refreshAffectedOrderCaches',allocateStart);
    const allocateSource=appSource.slice(allocateStart,allocateEnd);
    assert.match(allocateSource,/receiptId=''/);
    assert.match(allocateSource,/receiptId:receiptId\|\|''/);

    const receiptStart=appSource.indexOf('async function receiveSupplyOrderRecord');
    const receiptEnd=appSource.indexOf('\nwindow.openSupplyReceipt',receiptStart);
    const receiptSource=appSource.slice(receiptStart,receiptEnd);
    assert.match(receiptSource,/autoAllocationQty/);
    assert.match(receiptSource,/processedReceipt=receipt/);
    assert.match(receiptSource,/where\('receiptId','==',operationKey\)/);
    assert.match(receiptSource,/alreadyAllocated/);
    assert.match(receiptSource,/receipt-allocation-pending/);
    assert.doesNotMatch(receiptSource,/if\(alreadyProcessed\)return/);

    const saveStart=appSource.indexOf('window.savePoReceiptBatch = async function()');
    const saveEnd=appSource.indexOf('\nfunction purchaseItemsFromSavedPo',saveStart);
    const saveSource=appSource.slice(saveStart,saveEnd);
    assert.match(saveSource,/err\?\.code==='receipt-allocation-pending'/);
    assert.match(saveSource,/保留同一個 operationId/);
});


test('purchase receiving and history lists batch row insertion', () => {
    const receivingStart=appSource.indexOf('function renderPurchasingReceivingWorkList');
    const receivingEnd=appSource.indexOf('\nwindow.renderPoList',receivingStart);
    const receivingSource=appSource.slice(receivingStart,receivingEnd);
    assert.match(receivingSource,/const fragment = document\.createDocumentFragment\(\)/);
    assert.match(receivingSource,/fragment\.appendChild\(tr\)/);
    assert.match(receivingSource,/tbody\.appendChild\(fragment\)/);
    assert.doesNotMatch(receivingSource,/tbody\.appendChild\(tr\)/);

    const historyStart=appSource.indexOf('window.renderPoList = function');
    const historyEnd=appSource.indexOf('\n\/\/ 把「採購訂單」',historyStart);
    const historySource=appSource.slice(historyStart,historyEnd);
    assert.match(historySource,/const fragment = document\.createDocumentFragment\(\)/);
    assert.match(historySource,/fragment\.appendChild\(tr\)/);
    assert.match(historySource,/tbody\.appendChild\(fragment\)/);
    assert.doesNotMatch(historySource,/tbody\.appendChild\(tr\)/);
});

test('receiving list reuses purchasing normalized item snapshot', () => {
    const receivingStart=appSource.indexOf('function renderPurchasingReceivingWorkList(');
    const receivingEnd=appSource.indexOf('\nwindow.renderPoList',receivingStart);
    const receivingSource=appSource.slice(receivingStart,receivingEnd);
    assert.match(receivingSource,/normalizedItemsByOrder = null, filterContext = null, dispatchStatesByOrder = null, lifecyclesByOrder = null/);
    assert.match(receivingSource,/normalizedItemsByOrder\?\.get\(order\.id\) \|\| normalizedOrderItems\(order\)/);
    assert.match(receivingSource,/dispatchStatesByOrder\?\.get\(order\.id\)/);
    assert.match(receivingSource,/lifecyclesByOrder\?\.get\(order\.id\)/);

    const poStart=appSource.indexOf('window.renderPoList = function(');
    const poEnd=appSource.indexOf('\n// 把「採購訂單」',poStart);
    const poSource=appSource.slice(poStart,poEnd);
    assert.match(poSource,/renderPurchasingReceivingWorkList\(normalizedItemsByOrder, filterContext, dispatchStatesByOrder, lifecyclesByOrder\)/);

    const viewStart=appSource.indexOf('window.renderPurchasingView = function()');
    const viewEnd=appSource.indexOf('\nwindow.changePurchasePeriod',viewStart);
    const viewSource=appSource.slice(viewStart,viewEnd);
    assert.match(viewSource,/renderPoList\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
});

test('receipt allocation counter prevents concurrent retry over-allocation', () => {
    const allocateStart=appSource.indexOf('async function allocateFreeReceiptStockToShortages');
    const allocateEnd=appSource.indexOf('\nasync function refreshAffectedOrderCaches',allocateStart);
    const source=appSource.slice(allocateStart,allocateEnd);
    assert.match(source,/const receiptRef=receiptId\?db\.collection\('receipts'\)\.doc\(receiptId\):null/);
    assert.match(source,/receiptRemaining=receiptRef\?Math\.max\(0,receiptTarget-receiptAllocated\):remaining/);
    assert.match(source,/const take=Math\.min\(remaining,receiptRemaining,liveShortage/);
    assert.match(source,/autoAllocatedQty:nextAllocated/);
    assert.match(source,/allocationCompleted:nextAllocated>=receiptTarget/);

    const receiptStart=appSource.indexOf('async function receiveSupplyOrderRecord');
    const receiptEnd=appSource.indexOf('\nwindow.openSupplyReceipt',receiptStart);
    const receiptSource=appSource.slice(receiptStart,receiptEnd);
    assert.match(receiptSource,/autoAllocatedQty:0/);
    assert.match(receiptSource,/reconciledAllocated=Math\.max\(currentAllocated,alreadyAllocated\)/);
    assert.match(receiptSource,/freeQty=Math\.max\(0,allocationTarget-reconciledAllocated\)/);
});


test('item dispatch state avoids renormalizing the whole order', () => {
    const start=appSource.indexOf('function itemDispatchState(order, item)');
    const end=appSource.indexOf('\nfunction orderContextActionState',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const singleItem = Array\.isArray\(order\?\.items\) && order\.items\.length === 1/);
    assert.doesNotMatch(source,/normalizedOrderItems\(order\)/);
    assert.match(source,/!r\.itemId\s*&&\s*singleItem/);
});


test('delivery history reuses normalized item lookup', () => {
    const start=appSource.indexOf('function renderDeliveryModal()');
    const end=appSource.indexOf('\nwindow.editDeliveryRecord',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const deliveryItems=normalizedOrderItems\(order\)/);
    assert.match(source,/const deliveryItemNameById=new Map\(deliveryItems\.map/);
    assert.match(source,/deliveryItemNameById\.get\(record\.itemId\)/);
    assert.equal((source.match(/normalizedOrderItems\(order\)/g)||[]).length,1);
});


test('order row summaries reuse normalized items', () => {
    const quantityStart=appSource.indexOf('function orderQuantity(order, normalizedItems = null)');
    const lifecycleEnd=appSource.indexOf('\nfunction purchaseProgressInfo',quantityStart);
    const progressSource=appSource.slice(quantityStart,lifecycleEnd);
    assert.match(progressSource,/normalizedItems \|\| normalizedOrderItems\(order\)/);
    assert.match(progressSource,/orderQuantity\(order, normalizedItems\)/);
    assert.match(progressSource,/deliveredQuantity\(order, normalizedItems\)/);

    const contextStart=appSource.indexOf('function orderContextActionState');
    const contextEnd=appSource.indexOf('\nwindow.markOrderItemDispatchPrepared',contextStart);
    const contextSource=appSource.slice(contextStart,contextEnd);
    assert.match(contextSource,/dispatchStateByItem = null/);
    assert.match(contextSource,/function dispatchActionHtml\(order, normalizedItems = null, dispatchStateByItem = null\)/);

    const selfStart=appSource.indexOf('function selfOrderActionHtml');
    const selfEnd=appSource.indexOf('\nwindow.openSelfOrderModal',selfStart);
    const selfSource=appSource.slice(selfStart,selfEnd);
    assert.match(selfSource,/function selfOrderActionHtml\(order, normalizedItems = null, dispatchStateByItem = null\)/);

    const renderStart=appSource.indexOf('window.renderOrdersList = function()');
    const renderEnd=appSource.indexOf('\nwindow.retryOrderInventoryReservation',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/deliveryProgressInfo\(o, allOrderItems\)/);
    assert.match(renderSource,/fulfillmentProgressInfo\(o, allOrderItems, dispatchStateByItem\)/);
    assert.match(renderSource,/orderContextActionState\(o, allOrderItems, dispatchStateByItem\)/);
    assert.match(renderSource,/dispatchActionHtml\(o, allOrderItems, dispatchStateByItem\)/);
    assert.match(renderSource,/selfOrderActionHtml\(o, allOrderItems, dispatchStateByItem\)/);
});

test('receipt allocation progress has narrowly scoped Firestore update permission', () => {
    const start=rulesSource.indexOf('match /receipts/{id}');
    const end=rulesSource.indexOf('\n    // Purchaser records completion',start);
    const source=rulesSource.slice(start,end);
    assert.match(source,/allow update: if canReceiveInventory\(\)/);
    assert.match(source,/affectedKeys\(\)\.hasOnly\(\[[\s\S]*?'autoAllocatedQty'[\s\S]*?'allocationCompleted'[\s\S]*?'allocationUpdatedAt'/);
    assert.match(source,/autoAllocatedQty', 0\) >= resource\.data\.get\('autoAllocatedQty', 0\)/);
    assert.match(source,/autoAllocatedQty', 0\) <= resource\.data\.get\('autoAllocationQty', 0\)/);
});


test('work metrics reuse one dispatch state per item', () => {
    const categoryStart=appSource.indexOf('function orderItemWorkCategory');
    const categoryEnd=appSource.indexOf('\n// 倉庫品項',categoryStart);
    const categorySource=appSource.slice(categoryStart,categoryEnd);
    assert.match(categorySource,/lifecycleOverride = null, dispatchOverride = null/);
    assert.match(categorySource,/dispatchOverride \|\| itemDispatchState/);

    const metricsStart=appSource.indexOf('function buildOrderItemWorkMetrics');
    const metricsEnd=appSource.indexOf('\nwindow.setOrderWorkFilter',metricsStart);
    const metricsSource=appSource.slice(metricsStart,metricsEnd);
    assert.match(metricsSource,/const lifecycle = lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo\(order, items\)/);
    assert.match(metricsSource,/const orderDispatchStates = dispatchStatesByOrder\?\.get\(order\.id\) \|\| null/);
    assert.match(metricsSource,/const dispatch = orderDispatchStates\?\.get\(item\) \|\| itemDispatchState\(order, item\)/);
    assert.match(metricsSource,/orderItemDisplayCategories\(order,item,lifecycle,dispatch\)/);
    assert.match(metricsSource,/orderItemWorkAmount\(order,item,category,totalQty,dispatch\)/);
});

test('order rows reuse one dispatch snapshot across status summaries', () => {
    const fulfillmentStart=appSource.indexOf('function fulfillmentProgressInfo');
    const fulfillmentEnd=appSource.indexOf('\nconst pendingDispatchOrderIds',fulfillmentStart);
    const fulfillmentSource=appSource.slice(fulfillmentStart,fulfillmentEnd);
    assert.match(fulfillmentSource,/dispatchStateByItem = null/);
    assert.match(fulfillmentSource,/dispatchStateByItem\?\.get\(item\) \|\| itemDispatchState/);

    const listStart=appSource.indexOf('window.renderOrdersList = function()');
    const listEnd=appSource.indexOf('\nwindow.retryOrderInventoryReservation',listStart);
    const listSource=appSource.slice(listStart,listEnd);
    assert.match(listSource,/const dispatchStatesByOrder = new Map\(baseOrders\.map/);
    assert.match(listSource,/const dispatchStateByItem = dispatchStatesByOrder\.get\(o\.id\) \|\| new Map\(\)/);
    assert.match(listSource,/const displayCategoriesByItem = new Map/);
    assert.match(listSource,/fulfillmentProgressInfo\(o, allOrderItems, dispatchStateByItem\)/);
    assert.match(listSource,/orderContextActionState\(o, allOrderItems, dispatchStateByItem\)/);
    assert.match(listSource,/dispatchActionHtml\(o, allOrderItems, dispatchStateByItem\)/);
});

test('procurement views reuse dispatch state while calculating quantities', () => {
    const demandStart=appSource.indexOf('function procurementDemandForOrderItem');
    const remainingStart=appSource.indexOf('function remainingProcurementQty',demandStart);
    const demandSource=appSource.slice(demandStart,remainingStart);
    assert.match(demandSource,/dispatchOverride = null/);
    assert.match(demandSource,/dispatchOverride \|\| itemDispatchState\(order,item\)/);
    assert.match(demandSource,/YushinWorkflow\?\.procurementQuantities/);
    assert.match(demandSource,/YushinProcurementDemand\?\.fromSalesOrder/);

    const remainingEnd=appSource.indexOf('\nfunction purchasingLifecycleSnapshot',remainingStart);
    const remainingSource=appSource.slice(remainingStart,remainingEnd);
    assert.match(remainingSource,/procurementDemandForOrderItem\(order,item,dispatchOverride\)\.remainingToOrderQty/);

    const pendingStart=appSource.indexOf('function pendingProcurementDisplayLines');
    const pendingEnd=appSource.indexOf('\nfunction standaloneReceivingSupplyMetrics',pendingStart);
    const pendingSource=appSource.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/const lifecycle = lifecycleOverride \|\| orderLifecycleInfo\(order, items\)/);
    assert.match(pendingSource,/const dispatch = dispatchStateByItem\?\.get\(item\) \|\| itemDispatchState\(order, item\)/);
    assert.match(pendingSource,/orderItemWorkCategory\(order, item, lifecycle, dispatch\)/);
    assert.match(pendingSource,/const demand = procurementDemandForOrderItem\(order, item, dispatch\)/);
    assert.match(pendingSource,/const qty = demand\.remainingToOrderQty/);
    assert.match(pendingSource,/demandStatusLabel:globalThis\.YushinProcurementDemand/);

    const completedStart=appSource.indexOf('function purchasingCompletedRows');
    const completedEnd=appSource.indexOf('\nfunction renderPurchasingCompletedOrders',completedStart);
    const completedSource=appSource.slice(completedStart,completedEnd);
    assert.match(completedSource,/const lifecycle = lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo\(order, items\)/);
    assert.match(completedSource,/const state = orderDispatchStates\?\.get\(item\) \|\| itemDispatchState\(order, item\)/);
    assert.match(completedSource,/orderItemWorkCategory\(order, item, lifecycle, state\)/);
});


test('receiving source lookup uses indexed order map', () => {
    const helperStart=appSource.indexOf('function receivingSourceOrderForItem');
    const helperEnd=appSource.indexOf('\nfunction receivingEvidenceEntry',helperStart);
    const helperSource=appSource.slice(helperStart,helperEnd);
    assert.match(helperSource,/function receivingSourceOrderForItem\(item, orderById = null\)/);
    assert.match(helperSource,/orderById\?\.get\(item\.orderId\)/);
    assert.match(helperSource,/receivingSourceOrderCache\.get\(item\.orderId\)/);

    const renderStart=appSource.indexOf('function renderPurchasingReceivingWorkList');
    const renderEnd=appSource.indexOf('\nwindow.renderPoList',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/const orderById = new Map\(ordersCache\.map\(order => \[order\.id, order\]\)\)/);
    assert.match(renderSource,/receivingSourceOrderForItem\(supply, orderById\)/);
});

test('purchase history removes unreachable legacy receiving path', () => {
    assert.doesNotMatch(appSource,/function purchasingArrivalWorkKeys/);
    assert.doesNotMatch(appSource,/function receivingQueueContext/);
    assert.doesNotMatch(appSource,/function receivingSourceItem/);

    const renderStart=appSource.indexOf('window.renderPoList = function');
    const renderEnd=appSource.indexOf('\n// 把「採購訂單」',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/if \(purchasingView === 'receiving'\) \{[\s\S]*?renderPurchasingReceivingWorkList[\s\S]*?return;/);
    assert.doesNotMatch(renderSource,/purchasingView === 'receiving'\) supplyReceivingCache\.forEach/);
    assert.doesNotMatch(renderSource,/const arrivalWorkKeys/);
    assert.doesNotMatch(renderSource,/const receivingItemKeys/);
});

test('purchasing cards and completed rows share dispatch snapshots', () => {
    const cardsStart=appSource.indexOf('function renderPurchasingWorkCards');
    const cardsEnd=appSource.indexOf('\nfunction purchasingCompletedRows',cardsStart);
    const cardsSource=appSource.slice(cardsStart,cardsEnd);
    assert.match(cardsSource,/const stateMap = dispatchStatesByOrder \|\| purchasingDispatchStateSnapshot\(itemMap\)/);
    assert.match(cardsSource,/const lifecycleMap = lifecyclesByOrder \|\| purchasingLifecycleSnapshot\(itemMap\)/);
    assert.match(cardsSource,/buildOrderItemWorkMetrics\([\s\S]*?itemMap,[\s\S]*?stateMap,[\s\S]*?lifecycleMap/);
    assert.match(cardsSource,/purchasingCompletedRows\(filters, itemMap, stateMap, lifecycleMap\)/);

    const viewStart=appSource.indexOf('window.renderPurchasingView = function()');
    const viewEnd=appSource.indexOf('\nwindow.changePurchasePeriod',viewStart);
    const viewSource=appSource.slice(viewStart,viewEnd);
    assert.match(viewSource,/const dispatchStatesByOrder = purchasingDispatchStateSnapshot\(normalizedItemsByOrder\)/);
    assert.match(viewSource,/const lifecyclesByOrder = purchasingLifecycleSnapshot\(normalizedItemsByOrder\)/);
    assert.match(viewSource,/purchasingCompletedRows\(filters, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(viewSource,/renderPurchasingWorkCards\(normalizedItemsByOrder, completedRows, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
});

test('normalized order items index delivery records once per order', () => {
    const start=appSource.indexOf('function normalizedOrderItems(order)');
    const end=appSource.indexOf('\nfunction ensureOrderItemCompatibility',start);
    const source=appSource.slice(start,end);
    assert.match(source,/const deliveryQtyByItemId = new Map\(\)/);
    assert.match(source,/const returnQtyByItemId = new Map\(\)/);
    assert.match(source,/deliveryRecords\.forEach/);
    assert.match(source,/returnRecords\.forEach/);
    assert.match(source,/deliveryQtyByItemId\.get\(itemId\)/);
    assert.match(source,/returnQtyByItemId\.get\(itemId\)/);
    assert.doesNotMatch(source,/deliveryRecords\.filter/);
    assert.doesNotMatch(source,/returnRecords\.filter/);

    const context=vm.createContext({
        window:{},
        Map,
        Number,
        String,
        Math,
        normalizeHistoryItemCode:value=>String(value||'').toUpperCase(),
        resolveBrandName:value=>value,
        parseMoney:value=>Number(value||0)
    });
    vm.runInContext(source,context);
    const rows=context.normalizedOrderItems({
        items:[
            {itemId:'a',itemCode:'A',brand:'Roche',qty:2,unitPrice:10},
            {itemId:'b',itemCode:'B',brand:'Bio-Rad',qty:3,unitPrice:20}
        ],
        deliveryRecords:[
            {itemId:'a',qty:1},{itemId:'a',qty:1},{itemId:'b',qty:2}
        ],
        returnRecords:[{itemId:'b',qty:1}]
    });
    assert.equal(rows[0].deliveredQty,2);
    assert.equal(rows[0].returnedQty,0);
    assert.equal(rows[1].deliveredQty,2);
    assert.equal(rows[1].returnedQty,1);

    const single=context.normalizedOrderItems({
        items:[{itemCode:'ONLY',qty:2}],
        deliveryRecords:[{qty:2}],
        returnRecords:[{qty:1}]
    });
    assert.equal(single[0].itemId,'item-1');
    assert.equal(single[0].deliveredQty,2);
    assert.equal(single[0].returnedQty,1);
});


test('order work cards and rows share dispatch snapshots', () => {
    const cardsStart=appSource.indexOf('function renderOrderWorkCards');
    const cardsEnd=appSource.indexOf('\nfunction createOrderPaginationState',cardsStart);
    const cardsSource=appSource.slice(cardsStart,cardsEnd);
    assert.match(cardsSource,/dispatchStatesByOrder = null, lifecyclesByOrder = null/);
    assert.match(cardsSource,/buildOrderItemWorkMetrics\([\s\S]*?normalizedItemsByOrder,[\s\S]*?dispatchStatesByOrder,[\s\S]*?lifecyclesByOrder/);

    const listStart=appSource.indexOf('window.renderOrdersList = function()');
    const listEnd=appSource.indexOf('\nwindow.retryOrderInventoryReservation',listStart);
    const listSource=appSource.slice(listStart,listEnd);
    assert.match(listSource,/const dispatchStatesByOrder = new Map\(baseOrders\.map/);
    assert.match(listSource,/itemDispatchState\(order, item\)/);
    assert.match(listSource,/renderOrderWorkCards\(baseOrders, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(listSource,/const dispatchStateByItem = dispatchStatesByOrder\.get\(o\.id\) \|\| new Map\(\)/);
});

test('normalized fulfillment snapshot avoids rescanning delivery records', () => {
    const normalizeStart=appSource.indexOf('function normalizedOrderItems(order)');
    const normalizeEnd=appSource.indexOf('\nfunction ensureOrderItemCompatibility',normalizeStart);
    const normalizeSource=appSource.slice(normalizeStart,normalizeEnd);
    assert.match(normalizeSource,/Object\.defineProperty\(normalized, '__fulfillmentSnapshot'/);
    assert.match(normalizeSource,/enumerable:false/);

    const dispatchStart=appSource.indexOf('function itemDispatchState(order, item)');
    const dispatchEnd=appSource.indexOf('\nfunction orderContextActionState',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/const hasSnapshot = item\?\.__fulfillmentSnapshot === true/);
    assert.match(dispatchSource,/hasSnapshot[\s\S]*?item\.deliveredQty/);
    assert.match(dispatchSource,/hasSnapshot[\s\S]*?item\.returnedQty/);
    assert.match(dispatchSource,/: savedDeliveryRecords\(order\)\.filter/);
    assert.match(dispatchSource,/: savedReturnRecords\(order\)\.filter/);
});


test('purchasing work queues share one dispatch snapshot per render', () => {
    const helperStart=appSource.indexOf('function purchasingDispatchStateSnapshot');
    const helperEnd=appSource.indexOf('\nfunction pendingProcurementDisplayLines',helperStart);
    const helperSource=appSource.slice(helperStart,helperEnd);
    assert.match(helperSource,/new Map\(items\.map\(item => \[item, itemDispatchState\(order, item\)\]\)\)/);

    const pendingLinesStart=appSource.indexOf('function pendingProcurementDisplayLines');
    const pendingLinesEnd=appSource.indexOf('\nfunction renderPurchasingWorkCards',pendingLinesStart);
    const pendingLinesSource=appSource.slice(pendingLinesStart,pendingLinesEnd);
    assert.match(pendingLinesSource,/dispatchStateByItem = null/);
    assert.match(pendingLinesSource,/dispatchStateByItem\?\.get\(item\) \|\| itemDispatchState/);

    const viewStart=appSource.indexOf('window.renderPurchasingView = function()');
    const viewEnd=appSource.indexOf('\nwindow.changePurchasePeriod',viewStart);
    const viewSource=appSource.slice(viewStart,viewEnd);
    assert.match(viewSource,/purchasingDispatchStateSnapshot\(normalizedItemsByOrder\)/);
    assert.match(viewSource,/renderPendingPurchaseOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(viewSource,/renderPurchasingDispatchOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);

    const dispatchStart=appSource.indexOf('function renderPurchasingDispatchOrders');
    const dispatchEnd=appSource.indexOf('\nfunction pendingPurchaseLines',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/dispatchStatesByOrder = null/);
    assert.match(dispatchSource,/states\?\.get\(item\) \|\| itemDispatchState/);

    const pendingRenderStart=appSource.indexOf('function renderPendingPurchaseOrders');
    const pendingRenderEnd=appSource.indexOf('\nwindow.loadPendingPurchaseOrders',pendingRenderStart);
    const pendingRenderSource=appSource.slice(pendingRenderStart,pendingRenderEnd);
    assert.match(pendingRenderSource,/dispatchStatesByOrder = null/);
    assert.match(pendingRenderSource,/dispatchStatesByOrder\?\.get\(order\.id\)/);
});


test('order work cards and rows share lifecycle snapshots', () => {
    const metricsStart=appSource.indexOf('function buildOrderItemWorkMetrics');
    const metricsEnd=appSource.indexOf('\nwindow.setOrderWorkFilter',metricsStart);
    const metricsSource=appSource.slice(metricsStart,metricsEnd);
    assert.match(metricsSource,/lifecyclesByOrder = null/);
    assert.match(metricsSource,/lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo\(order, items\)/);

    const cardsStart=appSource.indexOf('function renderOrderWorkCards');
    const cardsEnd=appSource.indexOf('\nfunction createOrderPaginationState',cardsStart);
    const cardsSource=appSource.slice(cardsStart,cardsEnd);
    assert.match(cardsSource,/lifecyclesByOrder = null/);
    assert.match(cardsSource,/dispatchStatesByOrder,[\s\S]*?lifecyclesByOrder/);

    const listStart=appSource.indexOf('window.renderOrdersList = function()');
    const listEnd=appSource.indexOf('\nwindow.retryOrderInventoryReservation',listStart);
    const listSource=appSource.slice(listStart,listEnd);
    assert.match(listSource,/const lifecyclesByOrder = new Map\(baseOrders\.map/);
    assert.match(listSource,/renderOrderWorkCards\(baseOrders, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(listSource,/const lifecycle = lifecyclesByOrder\.get\(o\.id\) \|\| orderLifecycleInfo\(o, allOrderItems\)/);
});


test('receiving details reuse purchasing dispatch snapshots', () => {
    const receivingStart=appSource.indexOf('function renderPurchasingReceivingWorkList');
    const receivingEnd=appSource.indexOf('\nwindow.renderPoList',receivingStart);
    const receivingSource=appSource.slice(receivingStart,receivingEnd);
    assert.match(receivingSource,/dispatchStatesByOrder = null/);
    assert.match(receivingSource,/const lifecycle = lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo\(order, items\)/);
    assert.match(receivingSource,/const orderDispatchStates = dispatchStatesByOrder\?\.get\(order\.id\) \|\| null/);
    assert.match(receivingSource,/const dispatch = orderDispatchStates\?\.get\(item\) \|\| itemDispatchState\(order, item\)/);
    assert.match(receivingSource,/orderItemDisplayCategories\(order, item, lifecycle, dispatch\)/);

    const poStart=appSource.indexOf('window.renderPoList = function');
    const poEnd=appSource.indexOf('\n// 把「採購訂單」',poStart);
    const poSource=appSource.slice(poStart,poEnd);
    assert.match(poSource,/dispatchStatesByOrder = null/);
    assert.match(poSource,/lifecyclesByOrder = null/);
    assert.match(poSource,/renderPurchasingReceivingWorkList\(normalizedItemsByOrder, filterContext, dispatchStatesByOrder, lifecyclesByOrder\)/);

    const viewStart=appSource.indexOf('window.renderPurchasingView = function()');
    const viewEnd=appSource.indexOf('\nwindow.changePurchasePeriod',viewStart);
    assert.match(appSource.slice(viewStart,viewEnd),/renderPoList\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);

    const switchStart=appSource.indexOf('window.switchPurchasingView = function');
    const switchEnd=appSource.indexOf('\nasync function loadPurchasingDispatchOrders',switchStart);
    assert.match(appSource.slice(switchStart,switchEnd),/view === 'receiving'[\s\S]*?renderPoList\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
});


test('purchasing support data refreshes filters without rescanning order rows', () => {
    const start=appSource.indexOf("if (mainKey === 'orders.po') {");
    const end=appSource.indexOf("if (mainKey === 'inventory')",start);
    const source=appSource.slice(start,end);
    assert.match(source,/Promise\.allSettled\(\[ensureSalesListLoaded\(\), ensureBrandSettingsLoaded\(\)\]\)/);
    assert.match(source,/populatePurchasingFilters\(\)/);
    assert.doesNotMatch(source,/if \(canAccessPage\('orders\.po'\)\) renderPurchasingView\(\)/);
});


test('purchasing cards and completed rows share lifecycle snapshots', () => {
    const helperStart=appSource.indexOf('function purchasingLifecycleSnapshot');
    const helperEnd=appSource.indexOf('\nfunction purchasingDispatchStateSnapshot',helperStart);
    const helperSource=appSource.slice(helperStart,helperEnd);
    assert.match(helperSource,/orderLifecycleInfo\(order, itemMap\.get\(order\.id\) \|\| \[\]\)/);

    const cardsStart=appSource.indexOf('function renderPurchasingWorkCards');
    const cardsEnd=appSource.indexOf('\nfunction purchasingCompletedRows',cardsStart);
    const cardsSource=appSource.slice(cardsStart,cardsEnd);
    assert.match(cardsSource,/lifecyclesByOrder = null/);
    assert.match(cardsSource,/const lifecycleMap = lifecyclesByOrder \|\| purchasingLifecycleSnapshot\(itemMap\)/);
    assert.match(cardsSource,/buildOrderItemWorkMetrics\([\s\S]*?stateMap,[\s\S]*?lifecycleMap/);
    assert.match(cardsSource,/purchasingCompletedRows\(filters, itemMap, stateMap, lifecycleMap\)/);

    const completedStart=appSource.indexOf('function purchasingCompletedRows');
    const completedEnd=appSource.indexOf('\nfunction renderPurchasingCompletedOrders',completedStart);
    const completedSource=appSource.slice(completedStart,completedEnd);
    assert.match(completedSource,/lifecyclesByOrder = null/);
    assert.match(completedSource,/lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo/);

    const viewStart=appSource.indexOf('window.renderPurchasingView = function()');
    const viewEnd=appSource.indexOf('\nwindow.changePurchasePeriod',viewStart);
    const viewSource=appSource.slice(viewStart,viewEnd);
    assert.match(viewSource,/const lifecyclesByOrder = purchasingLifecycleSnapshot\(normalizedItemsByOrder\)/);
    assert.match(viewSource,/renderPurchasingWorkCards\(normalizedItemsByOrder, completedRows, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
});


test('purchasing background refresh reuses painted rows while preserving loading feedback', () => {
    const receivingStart=appSource.indexOf('function loadPurchasingReceivingQueue');
    const receivingEnd=appSource.indexOf('\nlet purchasingFilterOptionsSignature',receivingStart);
    const receivingSource=appSource.slice(receivingStart,receivingEnd);
    assert.match(receivingSource,/if \(options\.reuseOrders\) \{[\s\S]*?待到貨資料載入中…[\s\S]*?\} else \{[\s\S]*?renderPoList\(\)/);

    const pendingStart=appSource.indexOf('window.loadPendingPurchaseOrders = async function');
    const pendingEnd=appSource.indexOf('\nconst pendingPurchaseOrderKeys',pendingStart);
    const pendingSource=appSource.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/if \(options\.reuseOrders\) \{[\s\S]*?purchasePendingStatus[\s\S]*?載入中…[\s\S]*?\} else \{[\s\S]*?renderPendingPurchaseOrders\(\)/);

    const dispatchStart=appSource.indexOf('async function loadPurchasingDispatchOrders');
    const dispatchEnd=appSource.indexOf('\nwindow\.loadPurchasingDispatchOrders',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/if \(options\.reuseOrders\) \{[\s\S]*?purchaseDispatchStatus[\s\S]*?載入中…/);
});


test('receiving parallel refresh preserves older source orders', () => {
    const helperStart=appSource.indexOf('function mergeReceivingSourceOrdersIntoOrderCache()');
    const helperEnd=appSource.indexOf('\nasync function loadPurchaseOrderPage',helperStart);
    const helperSource=appSource.slice(helperStart,helperEnd);
    assert.match(helperSource,/receivingSourceOrderCache\.forEach/);
    assert.match(helperSource,/new Map\(ordersCache\.map\(order => \[order\.id, order\]\)\)/);
    assert.match(helperSource,/writeAppDataCache\('orders', ordersCache\)/);

    const loaderStart=appSource.indexOf('async function loadPurchaseOrderPage');
    const loaderEnd=appSource.indexOf('\nwindow.loadMyPurchaseOrders',loaderStart);
    const loaderSource=appSource.slice(loaderStart,loaderEnd);
    assert.match(loaderSource,/receivingSourceOrderCache=nextSourceOrders/);
    assert.match(loaderSource,/mergeReceivingSourceOrdersIntoOrderCache\(\)/);

    const queueStart=appSource.indexOf('function loadPurchasingReceivingQueue');
    const queueEnd=appSource.indexOf('\nlet purchasingFilterOptionsSignature',queueStart);
    const queueSource=appSource.slice(queueStart,queueEnd);
    assert.match(queueSource,/Promise\.allSettled/);
    assert.match(queueSource,/mergeReceivingSourceOrdersIntoOrderCache\(\)[\s\S]*?renderPurchasingView\(\)/);
});


test('purchasing detail queues reuse lifecycle snapshots', () => {
    const pendingStart=appSource.indexOf('function renderPendingPurchaseOrders');
    const pendingEnd=appSource.indexOf('\nwindow.loadPendingPurchaseOrders',pendingStart);
    const pendingSource=appSource.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/lifecyclesByOrder = null/);
    assert.match(pendingSource,/lifecyclesByOrder\?\.get\(order\.id\)/);

    const dispatchStart=appSource.indexOf('function renderPurchasingDispatchOrders');
    const dispatchEnd=appSource.indexOf('\nfunction pendingPurchaseLines',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/lifecyclesByOrder = null/);
    assert.match(dispatchSource,/lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo/);

    const receivingStart=appSource.indexOf('function renderPurchasingReceivingWorkList');
    const receivingEnd=appSource.indexOf('\nwindow.renderPoList',receivingStart);
    const receivingSource=appSource.slice(receivingStart,receivingEnd);
    assert.match(receivingSource,/lifecyclesByOrder = null/);
    assert.match(receivingSource,/lifecyclesByOrder\?\.get\(order\.id\) \|\| orderLifecycleInfo/);

    const switchStart=appSource.indexOf('window.switchPurchasingView = function');
    const switchEnd=appSource.indexOf('\nasync function loadPurchasingDispatchOrders',switchStart);
    const switchSource=appSource.slice(switchStart,switchEnd);
    assert.match(switchSource,/const lifecyclesByOrder = workflowView[\s\S]*?purchasingLifecycleSnapshot\(normalizedItemsByOrder\)[\s\S]*?: null/);
    assert.match(switchSource,/renderPendingPurchaseOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(switchSource,/renderPurchasingDispatchOrders\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
    assert.match(switchSource,/renderPoList\(normalizedItemsByOrder, filters, dispatchStatesByOrder, lifecyclesByOrder\)/);
});


test('completed purchasing load-more reuses one render snapshot', () => {
    const start=appSource.indexOf('window.loadMorePurchasingCompleted = async function()');
    const end=appSource.indexOf('\n};',start)+3;
    const source=appSource.slice(start,end);
    assert.match(source,/const normalizedItemsByOrder = new Map/);
    assert.match(source,/const dispatchStatesByOrder = purchasingDispatchStateSnapshot\(normalizedItemsByOrder\)/);
    assert.match(source,/const lifecyclesByOrder = purchasingLifecycleSnapshot\(normalizedItemsByOrder\)/);
    assert.match(source,/purchasingCompletedRows\([\s\S]*?normalizedItemsByOrder,[\s\S]*?dispatchStatesByOrder,[\s\S]*?lifecyclesByOrder/);
    assert.match(source,/renderPurchasingWorkCards\([\s\S]*?loadedRows,[\s\S]*?dispatchStatesByOrder,[\s\S]*?lifecyclesByOrder/);
    assert.doesNotMatch(source,/renderPurchasingWorkCards\(\)/);
});


test('order cache refresh avoids hidden purchasing renders', () => {
    const loadStart=appSource.indexOf('async function loadOrderPage');
    const loadEnd=appSource.indexOf('\nwindow.loadOrdersFromCloud',loadStart);
    const loadSource=appSource.slice(loadStart,loadEnd);
    assert.doesNotMatch(loadSource,/else if \(canAccessPage\('orders\.po'\)\) renderPurchasingWorkCards\(\)/);
    assert.match(loadSource,/document\.getElementById\('purchasing-system'\)\?\.classList\.contains\('active'\)\) renderPurchasingView\(\)/);

    const listStart=appSource.indexOf('window.renderOrdersList = function()');
    const listEnd=appSource.indexOf('\nwindow.retryOrderInventoryReservation',listStart);
    const listSource=appSource.slice(listStart,listEnd);
    assert.match(listSource,/purchasing-system[\s\S]*?renderPurchasingView\(\)/);
    assert.doesNotMatch(listSource,/purchasing-system[\s\S]*?renderPurchasingWorkCards\(\)/);

    const forecastStart=appSource.indexOf('window.createOrderFromForecast = async function');
    const forecastEnd=appSource.indexOf('\n\n\n\/\* =========================================================',forecastStart);
    const forecastSource=appSource.slice(forecastStart,forecastEnd);
    assert.doesNotMatch(forecastSource,/if \(canAccessPage\('orders\.po'\)\) renderPurchasingWorkCards\(\)/);
});


test('self-order capability is aligned between frontend and Firestore rules', () => {
    const capabilityStart=appSource.indexOf('function canSelfOrderCapability');
    const capabilityEnd=appSource.indexOf('\nfunction canCreatePurchaseOrderCapability',capabilityStart);
    const capabilitySource=appSource.slice(capabilityStart,capabilityEnd);
    assert.match(capabilitySource,/return hasBusinessCapability\(role\)/);

    const actionStart=appSource.indexOf('function canBusinessSelfOrder');
    const actionEnd=appSource.indexOf('\nfunction selfOrderActionHtml',actionStart);
    const actionSource=appSource.slice(actionStart,actionEnd);
    assert.match(actionSource,/canSelfOrderCapability\(currentUserRole\)/);
    assert.doesNotMatch(actionSource,/currentUserRole !== 'sales'/);
    const ruleStart=rulesSource.indexOf('match /supplyOrders/{id}');
    const ruleEnd=rulesSource.indexOf('\n    match /inventory/{id}',ruleStart);
    const ruleSource=rulesSource.slice(ruleStart,ruleEnd);
    assert.match(ruleSource,/allow create: if admin\(\) \|\| purchaser\(\)[\s\S]*?businessOwner\(\)[\s\S]*?SALES_SELF_ORDER/);
    assert.match(ruleSource,/request\.resource\.data\.ownerUid == request\.auth\.uid/);
    assert.match(ruleSource,/request\.resource\.data\.salesCode == salesCode\(\)/);
    assert.doesNotMatch(ruleSource,/allow create: if admin\(\) \|\| purchaser\(\)[\s\S]*?\|\| \(sales\(\)/);
});


test('purchasing cache sync performs one unified active render', () => {
    const start=appSource.indexOf('function syncOrderIntoPurchasingCaches');
    const end=appSource.indexOf('\nfunction syncCommittedPurchaseOrderSources',start);
    const source=appSource.slice(start,end);
    assert.match(source,/options\.render === false/);
    assert.match(source,/purchasing-system/);
    assert.match(source,/renderPurchasingView\(\)/);
    assert.doesNotMatch(source,/renderPurchasingWorkCards\(\)/);
    assert.doesNotMatch(source,/renderPendingPurchaseOrders\(\)/);
    assert.doesNotMatch(source,/renderPurchasingDispatchOrders\(\)/);
    assert.doesNotMatch(source,/renderPoList\(\)/);
});


test('purchasing queues reuse already loaded order cache without duplicate render work', () => {
    const orderLoadStart=appSource.indexOf('async function loadOrderPage');
    const orderLoadEnd=appSource.indexOf('\nwindow.loadOrdersFromCloud',orderLoadStart);
    const orderLoadSource=appSource.slice(orderLoadStart,orderLoadEnd);
    assert.match(orderLoadSource,/writeAppDataCache\('orders', ordersCache\);[\s\S]*?purchasingOrdersReady = true/);

    const pendingStart=appSource.indexOf('window.loadPendingPurchaseOrders = async function');
    const pendingEnd=appSource.indexOf('\nconst pendingPurchaseOrderKeys',pendingStart);
    const pendingSource=appSource.slice(pendingStart,pendingEnd);
    assert.match(pendingSource,/if \(options\.reuseOrders && purchasingOrdersReady\)/);
    assert.match(pendingSource,/pendingPurchaseHasMore = !!orderPaginationState/);
    assert.match(pendingSource,/return ordersCache/);

    const dispatchStart=appSource.indexOf('async function loadPurchasingDispatchOrders');
    const dispatchEnd=appSource.indexOf('\nwindow\.loadPurchasingDispatchOrders',dispatchStart);
    const dispatchSource=appSource.slice(dispatchStart,dispatchEnd);
    assert.match(dispatchSource,/if \(options\.reuseOrders && purchasingOrdersReady\)/);
    assert.match(dispatchSource,/purchasingDispatchHasMore = !!orderPaginationState/);
    assert.match(dispatchSource,/return ordersCache/);
});


test('receiving page load performs one unified render', () => {
    const start=appSource.indexOf('async function loadPurchaseOrderPage');
    const end=appSource.indexOf('\nwindow.loadMyPurchaseOrders',start);
    const source=appSource.slice(start,end);
    assert.match(source,/mergeReceivingSourceOrdersIntoOrderCache\(\)/);
    assert.doesNotMatch(source,/mergeReceivingSourceOrdersIntoOrderCache\(\);[\s\S]{0,120}renderPurchasingWorkCards\(\)/);
    assert.match(source,/if \(!deferRender\) \{[\s\S]*?purchasingView === 'receiving'\) renderPurchasingView\(\);[\s\S]*?else renderPoList\(\)/);
});


test('deferred receiving load merges source orders only after parallel reads finish', () => {
    const pageStart=appSource.indexOf('async function loadPurchaseOrderPage');
    const pageEnd=appSource.indexOf('\nwindow.loadMyPurchaseOrders',pageStart);
    const pageSource=appSource.slice(pageStart,pageEnd);
    assert.match(pageSource,/if \(!deferRender && purchasingView === 'receiving' && nextSourceOrders\.size\) \{/);

    const queueStart=appSource.indexOf('function loadPurchasingReceivingQueue');
    const queueEnd=appSource.indexOf('\nlet purchasingFilterOptionsSignature',queueStart);
    const queueSource=appSource.slice(queueStart,queueEnd);
    assert.match(queueSource,/loadPurchaseOrderPage\(reset, \{ deferRender:true \}\)/);
    assert.match(queueSource,/mergeReceivingSourceOrdersIntoOrderCache\(\)/);
    assert.match(queueSource,/renderPurchasingView\(\)/);
});


test('warehouse receiving capability is separate from purchase editing', () => {
    assert.match(appSource,/warehouse:\s*Object\.freeze\([^\n]*'orders\.po':'view'/);
    assert.match(appSource,/function canReceiveInventoryCapability\(role = currentUserRole\) \{[\s\S]*?role === 'warehouse'/);

    const receivingStart=appSource.indexOf('function renderPurchasingReceivingWorkList');
    const receivingEnd=appSource.indexOf('\nwindow.renderPoList',receivingStart);
    const receivingSource=appSource.slice(receivingStart,receivingEnd);
    assert.equal((receivingSource.match(/!canReceiveInventoryCapability\(\)/g)||[]).length,2);
    assert.doesNotMatch(receivingSource,/!canEditPage\('orders\.po'\)/);

    const openStart=appSource.indexOf('window.openSupplyReceipt = function');
    const openEnd=appSource.indexOf('\nwindow.savePoReceiptBatch',openStart);
    assert.match(appSource.slice(openStart,openEnd),/if \(!canReceiveInventoryCapability\(\)\) return/);

    const saveStart=appSource.indexOf('window.savePoReceiptBatch = async function');
    const saveEnd=appSource.indexOf('\nfunction purchaseItemsFromSavedPo',saveStart);
    assert.match(appSource.slice(saveStart,saveEnd),/if \(!canReceiveInventoryCapability\(\) \|\| poReceiptSaveInProgress\) return/);

    const stockStart=appSource.indexOf('window.openDirectStockPurchase = async function');
    const stockEnd=appSource.indexOf('\nwindow.closePurchaseOrder',stockStart);
    assert.match(appSource.slice(stockStart,stockEnd),/if \(!canEditPage\('orders\.po'\)\) return/);
});

test('warehouse receiving UI matches Firestore receive capability', () => {
    assert.match(rulesSource,/function canReceiveInventory\(\) \{[\s\S]*?admin\(\) \|\| purchaser\(\) \|\| warehouse\(\)/);
    assert.match(appSource,/倉管模式：可以確認到貨與入庫/);
    assert.match(appSource,/window\.receiveSupplyOrder = function\(supplyId\) \{[\s\S]*?canReceiveInventoryCapability\(\)/);
});


test('business reservation rules preserve reservation identity and narrow stock writes', () => {
    const helperStart=rulesSource.indexOf('function businessReservationOperationalUpdate()');
    const helperEnd=rulesSource.indexOf('\n\n    function businessInventoryLotOperationalUpdate',helperStart);
    const helper=rulesSource.slice(helperStart,helperEnd);
    assert.match(helper,/owns\(resource\.data\)/);
    assert.match(helper,/owns\(request\.resource\.data\)/);
    ['ownerUid','salesCode','orderId','itemId','productKey','warehouseId'].forEach(field => {
        assert.match(helper,new RegExp(`get\\('${field}', ''\\) == resource\\.data\\.get\\('${field}', ''\\)`));
    });
    assert.match(helper,/affectedKeys\(\)\.hasOnly\(\[[\s\S]*?'quantity'[\s\S]*?'shortageQty'[\s\S]*?'status'[\s\S]*?'updatedAt'/);
    assert.match(helper,/get\('quantity', 0\) >= 0/);
    assert.match(helper,/get\('shortageQty', 0\) >= 0/);

    const inventoryStart=rulesSource.indexOf('function businessInventoryOperationalUpdate()');
    const inventoryEnd=rulesSource.indexOf('\n\n    function businessReservationOperationalUpdate',inventoryStart);
    const inventoryHelper=rulesSource.slice(inventoryStart,inventoryEnd);
    assert.match(inventoryHelper,/affectedKeys\(\)\.hasOnly\(\[[\s\S]*?'onHand'[\s\S]*?'reserved'[\s\S]*?'updatedAt'/);
    assert.doesNotMatch(inventoryHelper,/'lots'/);
    assert.doesNotMatch(inventoryHelper,/'safetyStock'/);

    const reservationStart=rulesSource.indexOf('match /inventoryReservations/{id}');
    const reservationEnd=rulesSource.indexOf('\n\n    match /inventoryLots/{id}',reservationStart);
    const reservationRule=rulesSource.slice(reservationStart,reservationEnd);
    assert.match(reservationRule,/allow update: if admin\(\) \|\| purchaser\(\) \|\| warehouse\(\)[\s\S]*?businessReservationOperationalUpdate\(\)/);
});


test('equipment data scope agrees with engineer all-company access', () => {
    assert.match(appSource,/sales:\s*Object\.freeze\(\{[^\n]*equipment:'own'/);
    assert.match(appSource,/engineer:\s*Object\.freeze\(\{[^\n]*equipment:'all'/);
    const start=appSource.indexOf('function canViewAllEquipment()');
    const end=appSource.indexOf('\nwindow.loadEquipmentFromCloud',start);
    const source=appSource.slice(start,end);
    assert.match(source,/return canManageEquipmentCapability\(\)/);
    assert.match(appSource,/function canManageEquipmentCapability\(role = currentUserRole\)[\s\S]*?role === 'admin' \|\| role === 'engineer'/);
    const ruleStart=rulesSource.indexOf('match /equipment/{id}');
    const ruleEnd=rulesSource.indexOf('\n    match /',ruleStart+10);
    const ruleSource=rulesSource.slice(ruleStart,ruleEnd);
    assert.match(ruleSource,/allow read: if admin\(\) \|\| engineer\(\)/);
    assert.match(ruleSource,/allow create: if admin\(\) \|\| engineer\(\)/);
    assert.match(ruleSource,/allow update: if admin\(\) \|\| engineer\(\)/);
});


test('multi-item Forecast conversion tracks inventory reservation outcome', () => {
    const start=appSource.indexOf('async function createForecastOrdersDirectly');
    const end=appSource.indexOf('\nwindow.createOrderFromForecast',start);
    const source=appSource.slice(start,end);
    assert.match(source,/inventoryReservationStatus:'pending'/);
    assert.match(source,/inventoryReservationStatus:'completed'/);
    assert.match(source,/inventoryReservationStatus:'failed'/);
    assert.match(source,/reservationFailures:reservationResults\.filter/);
    assert.doesNotMatch(source,/Promise\.allSettled\(created\.map\(order=>reserveInventoryForNewOrder/);
});


test('order lifecycle follows procurement dispatch delivery billing and return states', () => {
    const workflow = require('../modules/workflow-core.js');
    const fulfillment = require('../modules/fulfillment-core.js');

    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal', orderedQty:10, deliveredQty:0, isBilled:false,
        fulfillmentType:'WAREHOUSE', shortageQty:6, supplyOrderedQty:0, receivedQty:0
    }), 'ordering');

    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal', orderedQty:10, deliveredQty:0, isBilled:false,
        fulfillmentType:'WAREHOUSE', shortageQty:6, supplyOrderedQty:6, receivedQty:0
    }), 'arrival');

    let item=fulfillment.normalizeItem({
        orderedQty:10, reservedQty:10, shortageQty:0,
        supplyOrderedQty:6, receivedQty:6, dispatchPreparedQty:0,
        deliveredQty:0, returnedQty:0
    });
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal', orderedQty:item.orderedQty, deliveredQty:0, isBilled:false,
        fulfillmentType:'WAREHOUSE', shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty, receivedQty:item.receivedQty
    }), 'delivery');
    assert.equal(fulfillment.pendingDispatchQty(item),10);
    assert.equal(fulfillment.shippableQty(item),0);

    item=fulfillment.prepareDispatch(item,10);
    assert.equal(fulfillment.pendingDispatchQty(item),0);
    assert.equal(fulfillment.shippableQty(item),10);

    item=fulfillment.deliver(item,10);
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal', orderedQty:item.orderedQty,
        deliveredQty:item.deliveredQty-item.returnedQty, isBilled:false,
        fulfillmentType:'WAREHOUSE', shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty, receivedQty:item.receivedQty
    }), 'billing');
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal', orderedQty:item.orderedQty,
        deliveredQty:item.deliveredQty-item.returnedQty, isBilled:true,
        fulfillmentType:'WAREHOUSE', shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty, receivedQty:item.receivedQty
    }), 'complete');

    item=fulfillment.returnDelivery(item,2);
    item=fulfillment.normalizeItem({...item,reservedQty:2});
    assert.equal(workflow.itemWorkCategory({
        lifecycleStatus:'normal', orderedQty:item.orderedQty,
        deliveredQty:item.deliveredQty-item.returnedQty, isBilled:true,
        fulfillmentType:'WAREHOUSE', shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty, receivedQty:item.receivedQty
    }), 'delivery');
    assert.equal(fulfillment.pendingDispatchQty(item),2);

    const displayStart=appSource.indexOf('function orderItemDisplayCategory');
    const displayEnd=appSource.indexOf('\nfunction orderItemDisplayCategories',displayStart);
    const displaySource=appSource.slice(displayStart,displayEnd);
    assert.match(displaySource,/if \(category !== 'delivery'\) return category/);
    assert.match(displaySource,/return dispatch\.pending > 0 \? 'dispatch' : 'shipping'/);
});



test('Product Master product line is optional in manual editor', () => {
    const uiStart=appSource.indexOf('function ensureProductMasterEditor');
    const uiEnd=appSource.indexOf('\nfunction populateProductMasterEditor',uiStart);
    const uiSource=appSource.slice(uiStart,uiEnd);
    assert.match(uiSource,/<label>產品線<\/label>/);
    assert.doesNotMatch(uiSource,/產品線 \*/);

    const saveStart=appSource.indexOf('window.saveProductMasterEditor = async function');
    const saveEnd=appSource.indexOf('\nfunction productManagementSource',saveStart);
    const saveSource=appSource.slice(saveStart,saveEnd);
    assert.match(saveSource,/if \(!brand \|\| !code \|\| !productName\)/);
    assert.doesNotMatch(saveSource,/!productLine\)/);
});
test('Product Import is incremental, splits standard cost securely, and never removes omitted products', () => {
    const syncStart=appSource.indexOf('async function syncImportedBrandToFormalProductMaster');
    const syncEnd=appSource.indexOf('\nasync function saveProductMasterBrand',syncStart);
    const syncSource=appSource.slice(syncStart,syncEnd);
    assert.match(syncSource,/db\.collection\('products'\)/);
    assert.match(syncSource,/db\.collection\('productCosts'\)/);
    assert.match(syncSource,/salesVisible: false/);
    assert.match(syncSource,/PRODUCT_MASTER_IMPORT_FIELDS/);
    assert.match(syncSource,/item\.listPriceProvided !== true\) delete product\.listPrice/);
    assert.match(syncSource,/field === 'listPrice' && item\.listPriceProvided !== true/);
    assert.match(syncSource,/commitMigrationBatch\(operations, 200\)/);
    assert.doesNotMatch(syncSource,/\.delete\(/);

    const templateStart=appSource.indexOf('window.downloadProductMasterTemplate = async function');
    const templateEnd=appSource.indexOf('\nwindow.downloadProductPriceUpdateTemplate',templateStart);
    const templateSource=appSource.slice(templateStart,templateEnd);
    assert.match(templateSource,/建議售價（含稅）/);
    assert.match(templateSource,/標準成本（含稅）/);
    assert.match(templateSource,/單位/);
    assert.match(templateSource,/又鑫_Product_Import\.xlsx/);

    const uploadStart=appSource.indexOf('window.handlePriceExcelUpload = async function');
    const uploadSource=appSource.slice(uploadStart, uploadStart + 16000);
    assert.match(uploadSource,/standardCostRaw/);
    assert.match(uploadSource,/標準成本格式不正確/);
    assert.match(uploadSource,/const listPriceProvided = String\(priceRaw \?\? ''\)\.trim\(\) !== ''/);
    assert.match(uploadSource,/price, listPriceProvided, standardCost, standardCostProvided/);
    assert.match(uploadSource,/price:previous\.price/);
    assert.match(uploadSource,/以 productId 增量合併本機快取/);
    assert.match(uploadSource,/未出現在檔案中的產品不會被刪除或停用/);
    assert.match(uploadSource,/標準成本與實際採購價分開保存/);
    assert.doesNotMatch(uploadSource,/缺少產品線/);
    assert.doesNotMatch(uploadSource,/fallbackProductLine/);

    const confirmStart=appSource.indexOf('async function confirmProductMasterImport');
    const confirmEnd=appSource.indexOf('\n\nwindow.downloadProductMasterTemplate',confirmStart);
    const confirmSource=appSource.slice(confirmStart,confirmEnd);
    assert.match(confirmSource,/產品資料與建議售價寫入 products/);
    assert.match(confirmSource,/標準成本寫入受保護的 productCosts/);
    assert.match(confirmSource,/實際採購價、歷史訂單與庫存批次成本不會被覆蓋/);
});



test('order lifecycle actions are hidden from purchaser and guarded by business capability', () => {
    const capabilityStart=appSource.indexOf('function canManageOrderLifecycleCapability');
    const capabilityEnd=appSource.indexOf('\nfunction canCreatePurchaseOrderCapability',capabilityStart);
    const capabilitySource=appSource.slice(capabilityStart,capabilityEnd);
    assert.match(capabilitySource,/return hasBusinessCapability\(role\)/);

    const renderStart=appSource.indexOf('window.renderOrdersList = function');
    const renderEnd=appSource.indexOf('\nwindow.retryOrderInventoryReservation',renderStart);
    const renderSource=appSource.slice(renderStart,renderEnd);
    assert.match(renderSource,/const canManageOrderLifecycle = canManageOrderLifecycleCapability\(\)/);
    assert.match(renderSource,/canManageOrderLifecycle[\s\S]*?quickSetOrderLifecycle/);
    assert.match(renderSource,/canManageOrderLifecycle[\s\S]*?openReturnManagement/);

    ['quickSetOrderLifecycle','quickCompleteDelivery','quickCancelAllDelivery','saveDeliveryRecord','deleteDeliveryRecord','saveOrderLifecycleStatus','saveReturnRecord','deleteReturnRecord','toggleOrderStatus'].forEach(name => {
        const start=appSource.indexOf('window.'+name+' =');
        const source=appSource.slice(start,start+500);
        assert.match(source,/canManageOrderLifecycleCapability\(\)/, name+' must enforce business lifecycle capability');
    });
});


test('critical role matrix stays aligned between UI capabilities and Firestore rules', () => {
    const capabilityStart=appSource.indexOf('function hasBusinessCapability');
    const capabilityEnd=appSource.indexOf('\nfunction commercialCreatorFields',capabilityStart);
    const capabilities=appSource.slice(capabilityStart,capabilityEnd);
    assert.match(capabilities,/hasBusinessCapability[\s\S]*?role === 'admin' \|\| role === 'sales' \|\| role === 'engineer'/);
    assert.match(capabilities,/canManageOrderLifecycleCapability[\s\S]*?return hasBusinessCapability\(role\)/);
    assert.match(capabilities,/canCreatePurchaseOrderCapability[\s\S]*?role === 'admin' \|\| role === 'purchaser'/);
    assert.match(capabilities,/canReceiveInventoryCapability[\s\S]*?role === 'admin' \|\| role === 'purchaser' \|\| role === 'warehouse'/);
    assert.match(capabilities,/canManageEquipmentCapability[\s\S]*?role === 'admin' \|\| role === 'engineer'/);
    assert.match(appSource,/function canViewAllEquipment\(\) \{\s*return canManageEquipmentCapability\(\);/);

    assert.match(appSource,/warehouse:\s*Object\.freeze\([^\n]*'orders\.po':'view'/);
    assert.match(appSource,/engineer:\s*Object\.freeze\([^\n]*'orders\.po':'none'[^\n]*equipment:'edit'/);
    assert.match(appSource,/purchaser:\s*Object\.freeze\([^\n]*'orders\.po':'edit'[^\n]*inventory:'edit'/);

    const dispatchStart=appSource.indexOf('function dispatchActionHtml');