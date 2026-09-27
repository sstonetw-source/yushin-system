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

test('shortage allocation and admin rebuild maintain work indexes',()=>{
    assert.match(app,/allocateFreeReceiptStockToShortages[\s\S]*?orderWorkIndexFields\(nextOrder\)/);
    assert.match(app,/window\.rebuildOrderWorkIndexes = async function/);
});


test('quote cancellation and legacy delivery cleanup refresh work category index',()=>{
    assert.match(app,/const cancelledOrder = \{\.\.\.order,status:'cancelled'[\s\S]*?orderWorkIndexFields\(cancelledOrder\)/);
    assert.match(app,/clearLegacyDelivery[\s\S]*?Object\.assign\(updates,orderWorkIndexFields\(\{\.\.\.order,\.\.\.updates\}\)\)/);
});

test('receiving queue includes sales self orders and new POs start pending',()=>{
    assert.match(app,/receiptStatus: 'pending'/);
    assert.match(app,/const freshSupply=supplySnapshot\.docs\s*\.map\(doc=>\(\{id:doc\.id,\.\.\.doc\.data\(\)\}\)\)\s*\.filter\(row=>row\.type==='SALES_SELF_ORDER'\)/);
    assert.match(app,/業務自行訂購/);
    assert.match(app,/if\(purchasingView === 'receiving' && item\.orderId && receivingSourceOrderStatusCache\.get\(item\.orderId\) !== 'normal'\) return/);
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

test('admin work-index preview is read only and rebuild updates only stale orders', async () => {
    const source=app.match(/function orderWorkIndexNeedsUpdate\(order\) \{[\s\S]*?\n\};\n(?=\nconst TEST_DATA_RESET_DELETE_COLLECTIONS)/)?.[0];
    assert.ok(source);
    const records=[
        {id:'A',expected:['ordering']},
        {id:'B',expected:['delivery'],workCategories:['delivery']},
        {id:'C',expected:['arrival'],workCategories:['ordering']}
    ];
    const docs=records.map(order=>({id:order.id,ref:{id:order.id},data:()=>order}));
    const liveRecords=new Map(records.map(order=>[order.id,order]));
    const previewButton={disabled:false}, rebuildButton={disabled:true}, status={textContent:''};
    const updates=[];
    const purchasingViewLoaded=new Set(['ordering','dispatch']);
    let transactions=0;
    const context=vm.createContext({
        window:{}, trueUserRole:'admin', currentUserRole:'admin',
        document:{getElementById:id=>({orderWorkIndexPreviewBtn:previewButton,orderWorkIndexRebuildBtn:rebuildButton,orderWorkIndexRebuildStatus:status})[id]},
        firebase:{firestore:{FieldPath:{documentId:()=>({})}}},
        db:{collection:()=>({orderBy(){return this;},limit(){return this;},async get(){return {docs,size:docs.length,empty:false};}}),
            runTransaction:async callback=>{transactions++;return callback({
                get:async ref=>({exists:true,data:()=>liveRecords.get(ref.id)}),
                update:(ref,fields)=>updates.push({id:ref.id,fields})
            });}},
        orderWorkCategories:order=>order.expected,
        orderWorkIndexFields:order=>({workCategories:order.expected,workCategoryUpdatedAt:'now'}),
        pendingPurchaseCache:[{}],purchasingDispatchCache:[{}],purchasingViewLoaded,
        confirm:()=>true, alert:message=>{throw new Error(message)},console
    });
    vm.runInContext(source,context);
    await context.window.previewOrderWorkIndexes();
    assert.match(status.textContent,/共 3 筆訂單，2 筆/);
    assert.equal(transactions,0);
    assert.equal(rebuildButton.disabled,false);
    liveRecords.set('C',{...records[2],workCategories:['arrival']});
    await context.window.rebuildOrderWorkIndexes();
    assert.equal(transactions,2);
    assert.deepEqual(updates.map(row=>row.id),['A']);
    assert.deepEqual(updates.map(row=>Object.keys(row.fields).sort()),[
        ['workCategories','workCategoryUpdatedAt']
    ]);
    assert.equal(rebuildButton.disabled,true);
    assert.equal(purchasingViewLoaded.has('ordering'),false);
    assert.equal(purchasingViewLoaded.has('dispatch'),false);
});
