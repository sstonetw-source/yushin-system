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
    assert.equal(records.length,2);
});

test('retrying PO incoming registration gives feedback and ignores a second tap', async () => {
    const start = app.indexOf('window.printPurchaseOrder = async function()');
    const end = app.indexOf('    if (poItems.length === 0)', start);
    assert.ok(start >= 0 && end > start);
    const button = { disabled:false, innerText:'🖨️ 產生訂購單／輸出 PDF' };
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
        reprintPurchaseOrder:()=>{}, printSavedPoDocument:()=>{printCalls++;}, alert:message=>alerts.push(message)
    });
    vm.runInContext(`let poSaveInProgress=false;\n${app.slice(start,end)}\n}`, context);
    const first = context.window.printPurchaseOrder();
    assert.equal(button.disabled, true);
    assert.match(button.innerText, /同步在途庫存中/);
    await context.window.printPurchaseOrder();
    assert.equal(registrationCalls, 1);
    releaseRegistration();
    await first;
    assert.equal(printCalls, 1);
    assert.equal(button.disabled, false);
    assert.deepEqual(alerts, []);

    context.registerPurchaseIncoming = async () => { throw new Error('網路中斷'); };
    await context.window.printPurchaseOrder();
    assert.equal(printCalls, 1);
    assert.equal(button.disabled, false);
    assert.match(alerts[0], /在途庫存同步尚未完成.*網路中斷/);
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
    assert.match(app, /orderItemWorkCategory\(order,sourceItem\)==='ordering'/);
    assert.match(app, /orderItemWorkCategory\(order,item\)==='delivery'&&itemDispatchState\(order,item\)\.pending>0/);
    assert.match(app, /const itemStatus=orderItemWorkCategory\(o,item\)/);
    assert.match(app, /if\(uncoveredShortage>0\)return 'ordering';/);
    assert.match(app, /if\(shortage>0\|\|ordered>received\)return 'arrival';/);
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


test('purchasing queues use derived server-side work category queries',()=>{
    assert.match(app,/where\('workCategories',\s*'array-contains',\s*'ordering'\)/);
    assert.match(app,/where\('workCategories','array-contains','delivery'\)/);
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

test('receiving queue includes sales self orders and new POs start pending',()=>{
    assert.match(app,/receiptStatus: 'pending'/);
    assert.match(app,/const freshSupply=supplySnapshot\.docs\s*\.map\(doc=>\(\{id:doc\.id,\.\.\.doc\.data\(\)\}\)\)\s*\.filter\(row=>row\.type==='SALES_SELF_ORDER'\)/);
    assert.match(app,/業務自行訂購/);
    assert.match(app,/sourceStatus!=='normal' && \(item\.fulfillmentType\|\|'WAREHOUSE'\)==='DIRECT_SHIP'\) return/);
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
        receivingSourceOrderStatusCache:new Map(), DEFAULT_LIST_LIMIT:1,
        BUSINESS_STATUS:{ACTIVE:'active'}, normalizedOrderStatus:()=> 'normal',
        purchaseItemsFromSavedPo:po=>po.items, readAppDataCache:()=>null,
        writeAppDataCache:()=>{}, renderPoList:()=>{}, updatePoLoadMoreButton:()=>{}, alert:message=>{throw new Error(message)}
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

test('pending purchasing work loads one page at a time without losing older rows', async () => {
    const source = app.match(/window\.loadPendingPurchaseOrders = async function\(reset = true\) \{[\s\S]*?\n\};\n(?=\nwindow\.openOrderPurchaseDraft)/)?.[0];
    assert.ok(source);
    const docs = ['O1','O2','O3'].map(id=>({id,data:()=>({status:'active'})}));
    let reads=0;
    const query={
        where(){return this;},orderBy(){return this;},limit(){return this;},startAfter(){return this;},
        async get(){const page=++reads===1?docs.slice(0,2):docs.slice(2);return {docs:page,size:page.length,empty:!page.length,forEach:fn=>page.forEach(fn)};}
    };
    const context=vm.createContext({
        window:{}, db:{collection:()=>query}, canCreatePurchaseOrderCapability:()=>true,
        canAccessPage:()=>true, pendingPurchaseLoading:false, pendingPurchaseCursor:null,
        pendingPurchaseHasMore:true, pendingPurchaseCache:[], pendingPurchaseError:'',
        currentUserRole:'purchaser', BUSINESS_STATUS:{ACTIVE:'active'}, DEFAULT_LIST_LIMIT:2,
        readAppDataCache:()=>null, writeAppDataCache:()=>{}, renderPendingPurchaseOrders:()=>{},
        pendingPurchaseLines:()=>[{}], firestoreReadWithTimeout:promise=>promise
    });
    vm.runInContext(source,context);
    await context.window.loadPendingPurchaseOrders(true);
    assert.equal(reads,1);
    assert.deepEqual(Array.from(context.pendingPurchaseCache,row=>row.id),['O1','O2']);
    assert.equal(context.pendingPurchaseHasMore,true);
    await context.window.loadPendingPurchaseOrders(false);
    assert.equal(reads,2);
    assert.deepEqual(Array.from(context.pendingPurchaseCache,row=>row.id),['O1','O2','O3']);
    assert.equal(context.pendingPurchaseHasMore,false);
});

test('missing purchasing index reports an actionable error without showing a misleading zero or console URL', async () => {
    const source = app.match(/window\.loadPendingPurchaseOrders = async function\(reset = true\) \{[\s\S]*?\n\};\n(?=\nwindow\.openOrderPurchaseDraft)/)?.[0];
    assert.ok(source);
    const query = {
        where(){return this;}, orderBy(){return this;}, limit(){return this;},
        async get(){throw Object.assign(new Error('The query requires an index. You can create it here: https://console.firebase.google.com/long-index-url'), {code:'failed-precondition'});}
    };
    const context = vm.createContext({
        window:{}, db:{collection:()=>query}, canCreatePurchaseOrderCapability:()=>true,
        canAccessPage:()=>true, pendingPurchaseLoading:false, pendingPurchaseCursor:null,
        pendingPurchaseHasMore:true, pendingPurchaseCache:[], pendingPurchaseError:'',
        currentUserRole:'purchaser', BUSINESS_STATUS:{ACTIVE:'active'}, DEFAULT_LIST_LIMIT:50,
        readAppDataCache:()=>null, writeAppDataCache:()=>{}, renderPendingPurchaseOrders:()=>{},
        firestoreReadWithTimeout:promise=>promise
    });
    vm.runInContext(source,context);
    await context.window.loadPendingPurchaseOrders(true);
    assert.match(context.pendingPurchaseError,/索引尚未建立/);
    assert.doesNotMatch(context.pendingPurchaseError,/https?:\/\//);
    const renderSource = app.match(/function renderPendingPurchaseOrders\(\) \{[\s\S]*?\n\}\n(?=\nwindow\.loadPendingPurchaseOrders)/)?.[0];
    assert.ok(renderSource);
    const elements = {
        purchasePendingBody:{innerHTML:'',children:[]},
        purchasePendingStatus:{textContent:''},
        purchaseCountOrdering:{textContent:''},
        purchasePendingMoreBtn:{style:{},disabled:false}
    };
    context.document = {getElementById:id=>elements[id]};
    context.renderPendingPurchaseOrders = undefined;
    vm.runInContext(renderSource,context);
    context.renderPendingPurchaseOrders();
    assert.equal(elements.purchaseCountOrdering.textContent,'—');
    assert.match(elements.purchasePendingStatus.textContent,/索引尚未建立/);
});

test('cancelled warehouse source stays in receiving while direct ship remains blocked', () => {
    assert.match(app,/sourceStatus!=='normal' && \(item\.fulfillmentType\|\|'WAREHOUSE'\)==='DIRECT_SHIP'\) return/);
    assert.match(app,/來源訂單已取消・入庫後為自由庫存/);
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

test('committed PO refreshes item quantities in order and purchasing views', () => {
    const start=app.indexOf('function syncOrderIntoPurchasingCaches(order) {');
    const end=app.indexOf('\nfunction renderPendingPurchaseOrders()',start);
    assert.ok(start>=0&&end>start);
    assert.match(app,/committedSourceOrders\.push\(\{id:snapshot\.id,\.\.\.orderData,\.\.\.orderUpdates\}\)/);
    assert.match(app,/syncCommittedPurchaseOrderSources\(committedSourceOrders\)/);
    const oldOrder={id:'O1',items:[{qty:5,purchaseOrderedQty:0}]};
    const writes=[];
    let listRenders=0;
    const context=vm.createContext({
        ordersCache:[oldOrder],pendingPurchaseCache:[oldOrder],purchasingDispatchCache:[],
        purchasingView:'ordering',pendingPurchaseLines:order=>order.items[0].purchaseOrderedQty<5?[{}]:[],
        normalizedOrderItems:order=>order.items,orderItemWorkCategory:()=>'',itemDispatchState:()=>({pending:0}),
        writeAppDataCache:(kind,rows)=>writes.push([kind,Array.from(rows,row=>row.id)]),
        renderPendingPurchaseOrders:()=>{},renderPurchasingDispatchOrders:()=>{},renderOrdersList:()=>{listRenders++;}
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
