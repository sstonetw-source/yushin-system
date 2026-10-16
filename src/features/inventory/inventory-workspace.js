/* =========================================================
   訂單管理系統
   ========================================================= */
let ordersCache = [];
let currentDeliveryOrderId = null;
let currentLifecycleOrderId = null;
let deliveryPartialFormOpen = false;
const pendingDeliveryOrderIds = new Set();
const pendingLifecycleOrderIds = new Set();
// 同一個狀態欄位寫入期間不接受第二次操作，避免手機連點造成兩個 Firestore
// transaction 交錯，最後畫面被較慢回來的舊結果覆蓋。
const pendingOrderStatusKeys = new Set();
let activeOrderWorkFilter = 'all';
let activeOrderPeriod = 'this-year';
let orderPaginationState = null;
let orderPageLoading = false;
let orderReloadRequested = false;
let orderLoadGeneration = 0;
let orderLoadErrorMessage = '';

function dateOnlyFromTimestamp(value) {
    if (!value) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value);
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// 所有公司共用同一套時間排序：先依業務日期，再依建立時間。
// company 不參與排序，避免又鑫／辰星／鼎新的紀錄被分組後破壞真正的時間順序。
// 舊資料若沒有 createdAt，最後才以單號／文件 id 做穩定排序。
const DOCUMENT_TYPES = Object.freeze({ FORECAST: 'forecast', QUOTE: 'quote', ORDER: 'order', PURCHASE_ORDER: 'purchaseOrder', RECEIPT: 'receipt', INVENTORY_MOVEMENT: 'inventoryMovement' });

function documentLink(type, id, relation = 'related') {
    return { type, id: String(id || ''), relation };
}

function normalizeDocumentLinks(links) {
    const unique = new Map();
    (Array.isArray(links) ? links : []).forEach(link => {
        if (!link?.type || !link?.id) return;
        const normalized = documentLink(link.type, link.id, link.relation || 'related');
        unique.set(`${normalized.type}:${normalized.id}:${normalized.relation}`, normalized);
    });
    return [...unique.values()];
}

function linkedDocumentFields(sourceType = '', sourceId = '', links = []) {
    return {
        sourceType: sourceType || '',
        sourceId: String(sourceId || ''),
        linkedDocuments: normalizeDocumentLinks(links)
    };
}


function compareBusinessRecordsNewestFirst(a, b, dateField, numberField) {
    const dateCompare = String(b?.[dateField] || '').localeCompare(String(a?.[dateField] || ''));
    if (dateCompare) return dateCompare;
    const createdCompare = String(b?.createdAt || '').localeCompare(String(a?.createdAt || ''));
    if (createdCompare) return createdCompare;
    return String(b?.[numberField] || b?.id || '').localeCompare(String(a?.[numberField] || a?.id || ''));
}

// 核銷日期代表完成單據核銷；不代表發票開立或款項入帳。既有核銷操作紀錄可推回日期；
// 若舊資料完全沒有操作紀錄，才暫以訂單日期顯示，避免既有完成訂單從統計消失。
function orderBillingDate(order) {
    if (order?.billingDate) return order.billingDate;
    const history = Array.isArray(order?.statusHistory) ? order.statusHistory : [];
    const billedEntry = [...history].reverse().find(entry => entry.field === 'isBilled' && entry.value);
    return dateOnlyFromTimestamp(billedEntry?.at) || (order?.isBilled ? order.orderDate || '' : '');
}

function orderCompletionDate(order) {
    if (!order?.isBilled || deliveryProgressInfo(order).state !== 'complete') return '';
    const billingDate = orderBillingDate(order);
    const records = savedDeliveryRecords(order);
    const deliveryDate = records.length
        ? records.reduce((latest, record) => {
            const date = record.date || dateOnlyFromTimestamp(record.createdAt);
            return date && date > latest ? date : latest;
        }, '')
        : (order?.isDelivered ? order.orderDate || '' : '');
    const returnDate = savedReturnRecords(order).reduce((latest, record) => {
        const date = record.date || dateOnlyFromTimestamp(record.createdAt);
        return date && date > latest ? date : latest;
    }, '');
    // 核銷、送貨與退貨可跨日補登；訂單重新達成完整履約時，以三條流程最後一個發生日作為完成日。
    return [billingDate, deliveryDate, returnDate].filter(Boolean).sort().pop() || '';
}

function orderPeriodRange() {
    if (activeOrderPeriod === 'custom') {
        return {
            start: document.getElementById('orderPeriodStart')?.value || '',
            end: document.getElementById('orderPeriodEnd')?.value || ''
        };
    }
    return unifiedPeriodRange(activeOrderPeriod);
}

function dateInOrderPeriod(date) {
    const { start, end } = orderPeriodRange();
    if (!start && !end) return true;
    return !!date && (!start || date >= start) && (!end || date <= end);
}

function orderMatchesWorkPeriod(order, category = orderWorkCategory(order)) {
    if (category === 'billing') return true;
    if (category === 'complete') return dateInOrderPeriod(orderCompletionDate(order));
    return dateInOrderPeriod(order.orderDate || '');
}

window.changeOrderPeriod = function(value) {
    activeOrderPeriod = ['this-month', 'last-month', 'this-quarter', 'this-year', 'last-year', 'custom', 'all'].includes(value) ? value : 'this-year';
    const custom = document.getElementById('orderCustomPeriod');
    if (custom) custom.style.display = activeOrderPeriod === 'custom' ? 'flex' : 'none';
    if (activeOrderPeriod === 'custom') {
        const start = document.getElementById('orderPeriodStart');
        const end = document.getElementById('orderPeriodEnd');
        const year = new Date().getFullYear();
        if (start && !start.value) start.value = `${year}-01-01`;
        if (end && !end.value) end.value = dateOnlyFromTimestamp(new Date().toISOString());
    }
    renderOrdersList();
};

let inventoryLoadGeneration=0, inventoryReloadRequested=false, inventoryPendingSupplyError='', inventoryPendingSupplyLoading=false;
let inventoryReceivingWorkCount = 0;
function updateInventoryReceivingCount(count = inventoryReceivingWorkCount) {
    inventoryReceivingWorkCount = Math.max(0, Number(count) || 0);
    const button = document.getElementById('inventoryReceivingTabBtn');
    if (!button) return;
    const error = inventoryPendingSupplyError || activeReceivingSupplyError || orderWorkQueueError;
    const loading = inventoryPendingSupplyLoading || !purchasingReceivingReady || !activeReceivingSupplyReady;
    button.textContent = error ? '待收貨（讀取失敗）' : loading ? '待收貨（讀取中…）' : `待收貨（${inventoryReceivingWorkCount} 筆）`;
    globalThis.updateInventoryWorkspaceBadges?.();
}
async function loadInventoryReceivingSummary() {
    // Reuse the receiving queue, including active work older than the 50-row history page.
    await Promise.all([
        loadPurchasingReceivingQueue(true, {reuseOrders:true}),
        loadOrderWorkQueue(false)
    ]);
    if (!orderWorkQueueReady) throw new Error(orderWorkQueueError || '未完成訂單尚未載入');
    mergeReceivingSourceOrdersIntoOrderCache();
    return supplyReceivingCache;
}
let inventoryCache=[], inventoryCursor=null, inventoryHasMore=true, inventoryLoading=false, inventoryLedgerCache=[], pendingSupplyCache=[];
let inventoryReplenishmentCache=[], inventoryReplenishmentLoading=false;
let warehouseStockCache = new Map();
function invalidateWarehouseStockCache(productKey = '', warehouseId = '') {
    invalidateInventoryLotView(productKey);
    markMainPageDirty('inventory', 'orders.po');
    inventoryReplenishmentCache=[];
    if (productKey && warehouseId) {
        warehouseStockCache.delete(warehouseId + '||' + productKey);
        return;
    }
    if (productKey) {
        [...warehouseStockCache.keys()].filter(key=>key.endsWith('||' + productKey)).forEach(key=>warehouseStockCache.delete(key));
        return;
    }
    warehouseStockCache.clear();
}
function expiryDays(date){if(!date)return null;return Math.ceil((new Date(date+'T23:59:59')-new Date())/86400000);}
function lotStatus(lot){const d=expiryDays(lot.expiryDate);if(d===null)return '';if(d<0)return '已過期';if(d<=30)return '30天內';if(d<=60)return '60天內';if(d<=90)return '90天內';return '';}
function fefoLots(stock){return YushinInventory.sortLotsForIssue(inventoryLotViewState(stock).lots);}
async function runReadJobs(jobs, concurrency = 4) {
    let next=0;
    const results=new Array(jobs.length);
    await Promise.all(Array.from({length:Math.min(concurrency,jobs.length)},async()=>{
        while(next<jobs.length){const index=next++;results[index]=await jobs[index]();}
    }));
    return results;
}
async function loadWarehouseStocksForInventoryPage(items = inventoryCache) {
    const targetCache=warehouseStockCache;
    const uid=currentUser?.uid,role=currentUserRole;
    const isCurrent=()=>targetCache===warehouseStockCache&&uid===currentUser?.uid&&role===currentUserRole;
    await loadWarehouseMaster();
    if(!isCurrent())return;
    const productKeys = [...new Set(items
        .map(item => String(item.productKey || item.productId || '').trim())
        .filter(Boolean))];
    if (!productKeys.length || !warehouseMasterCache.length) return;

    // Firestore 'in' 查詢分批處理目前頁面的 productKey，避免每個品項 × 每個倉庫各讀一次文件。
    const chunkSize = 30;
    const jobs = [];
    warehouseMasterCache.filter(warehouse => warehouse.active !== false).forEach(warehouse => {
        for (let i = 0; i < productKeys.length; i += chunkSize) {
            const keys = productKeys.slice(i, i + chunkSize);
            jobs.push(
                () => firestoreReadWithTimeout(
                    db.collection('warehouseStocks')
                        .where('warehouseId', '==', warehouse.id)
                        .where('productKey', 'in', keys)
                        .get(),
                    '倉庫庫存批次'
                ).then(snapshot => {
                        if(!isCurrent())return;
                        snapshot.docs.forEach(doc => {
                            const data = { id: doc.id, ...doc.data() };
                            const productKey = String(data.productKey || data.productId || '').trim();
                            if (productKey) targetCache.set(warehouse.id + '||' + productKey, data);
                        });
                    })
            );
        }
    });
    await runReadJobs(jobs, 4);
    if(!isCurrent())return;

    // 沒有 warehouseStock 文件的品項也記成 null，避免 render 階段誤以為尚未讀取。
    warehouseMasterCache.filter(warehouse => warehouse.active !== false).forEach(warehouse => {
        productKeys.forEach(productKey => {
            const cacheKey = warehouse.id + '||' + productKey;
            if (!targetCache.has(cacheKey)) targetCache.set(cacheKey, null);
        });
    });
}

window.loadInventory=async function(reset=true){
 if(!canAccessPage('inventory'))return;
 if(inventoryLoading){if(reset){inventoryReloadRequested=true;inventoryLoadGeneration++;}return;}
 const generation=++inventoryLoadGeneration, uid=currentUser?.uid, role=currentUserRole;
 const isCurrent=()=>generation===inventoryLoadGeneration&&uid===currentUser?.uid&&role===currentUserRole;
 if(reset){inventoryCursor=null;inventoryHasMore=true;warehouseStockCache=new Map();resetInventoryLotView();if(!inventoryCache.length){const cached=readAppDataCache('inventory');if(cached?.records?.length){inventoryCache=cached.records;renderInventoryList();}}} inventoryLoading=true;
 try{let q=db.collection('inventory').orderBy('updatedAt','desc').limit(DEFAULT_LIST_LIMIT);if(inventoryCursor)q=q.startAfter(inventoryCursor);const snap=await firestoreReadWithTimeout(q.get(),'庫存清單');if(!isCurrent())return;if(!snap.empty)inventoryCursor=snap.docs[snap.docs.length-1];
 const freshRows=snap.docs.map(d=>({id:d.id,...d.data()}));
 if(reset){
   // stale-while-revalidate：舊快取只負責先畫畫面；雲端第一頁成功後必須整頁取代，
   // 否則已刪除／已不符合條件的舊庫存會永遠殘留在本機 cache。
   inventoryCache=freshRows;
 }else{
   freshRows.forEach(x=>{const i=inventoryCache.findIndex(v=>v.id===x.id);if(i>=0)inventoryCache[i]=x;else inventoryCache.push(x);});
 }
 inventoryHasMore=snap.size===DEFAULT_LIST_LIMIT;
 if(reset){inventoryPendingSupplyError='';inventoryPendingSupplyLoading=true;updateInventoryReceivingCount();renderPendingInventoryItems();}
 const auxiliary = reset ? Promise.allSettled([
   firestoreReadWithTimeout((canReceiveInventoryCapability() ? db.collection('inventoryMovements') : db.collection('inventoryMovements').where('ownerUid','==',currentUser.uid)).orderBy('createdAt','desc').limit(DEFAULT_LIST_LIMIT).get(),'庫存異動'),
   canReceiveInventoryCapability() ? loadInventoryReceivingSummary() : Promise.resolve([])
 ]).then(([ledger,supplies])=>{
   if(!isCurrent())return;inventoryPendingSupplyLoading=false;
   if(ledger.status==='fulfilled'){inventoryLedgerCache=ledger.value.docs.map(d=>({id:d.id,...d.data()}));renderInventoryLedger();}
   else console.error('庫存異動讀取失敗',ledger.reason);
   if(supplies.status==='fulfilled'){pendingSupplyCache=supplies.value.filter(row=>(row.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP');renderPurchasingReceivingWorkList(null,null,null,null,true);renderPendingInventoryItems();}
   else { mainPageLoadFailed('inventory'); inventoryPendingSupplyError='在途供應讀取失敗，無法確認待到貨資料。'; renderPendingInventoryItems(); }
 }) : Promise.resolve();

 await Promise.all([loadWarehouseStocksForInventoryPage(),loadInventoryLotsForPage(freshRows)]);
 if(!isCurrent())return;
 writeAppDataCache('inventory', inventoryCache);
 renderInventoryList();renderInventoryLedger();renderPendingInventoryItems();

 }catch(e){if(isCurrent()){mainPageLoadFailed('inventory');alert('讀取庫存失敗：'+e.message);}}finally{inventoryLoading=false;const b=document.getElementById('inventoryLoadMoreBtn');if(b)b.style.display=inventoryHasMore?'':'none';if(inventoryReloadRequested){inventoryReloadRequested=false;loadInventory(true);}}
};
let businessProductSearchGeneration = 0;
let businessProductSearchState = null;
function resetBusinessProductSearchResults() {
    businessProductSearchGeneration += 1;
    businessProductSearchState = null;
    const wrap = document.getElementById('businessProductSearchResults');
    const body = document.getElementById('businessProductSearchBody');
    const status = document.getElementById('businessProductSearchStatus');
    const more = document.getElementById('businessProductSearchMoreBtn');
    if (wrap) wrap.style.display = 'none';
    if (body) body.innerHTML = '';
    if (status) status.textContent = '';
    if (more) more.hidden = true;
}
window.searchBusinessProducts=async function(keyword='', loadMore=false){
    if (!canAccessPage('inventory')) return 0;
    const raw = String(keyword || document.getElementById('inventorySearch')?.value || '').trim();
    if (raw.length < 2) { resetBusinessProductSearchResults(); return 0; }
    const uid = currentUser?.uid, role = currentUserRole;
    let state = businessProductSearchState;
    if (!loadMore || !state || state.raw !== raw || state.uid !== uid || state.role !== role) {
        if (state?.loading && state.raw === raw && state.uid === uid && state.role === role) return 0;
        state = {raw, uid, role, products:new Map(), codeCursor:null, nameCursor:null, codeMore:true, nameMore:true, loading:false};
        businessProductSearchState = state;
    }
    if (state.loading || (!state.codeMore && !state.nameMore)) return state.products.size;
    const generation = ++businessProductSearchGeneration;
    const isCurrent = () => generation === businessProductSearchGeneration && state === businessProductSearchState
        && uid === currentUser?.uid && role === currentUserRole && canAccessPage('inventory');
    const status = document.getElementById('businessProductSearchStatus');
    const wrap = document.getElementById('businessProductSearchResults');
    const body = document.getElementById('businessProductSearchBody');
    const more = document.getElementById('businessProductSearchMoreBtn');
    state.loading = true;
    if (wrap) wrap.style.display = '';
    if (!loadMore && body) body.innerHTML = '';
    if (status) status.textContent = '查詢產品主檔…';
    if (more) more.disabled = true;
    try {
        const normalized=normalizeItemCodeLoose(raw),end=raw+'\uf8ff';
        let codeQuery=db.collection('products').where('normalizedPartNo','==',normalized).limit(25);
        let nameQuery=db.collection('products').orderBy('productName').startAt(raw).endAt(end).limit(25);
        if (state.codeCursor) codeQuery = codeQuery.startAfter(state.codeCursor);
        if (state.nameCursor) nameQuery = nameQuery.startAfter(state.nameCursor);
        const empty = {docs:[], size:0};
        const [codeSnap, nameSnap] = await Promise.all([
            state.codeMore ? firestoreReadWithTimeout(codeQuery.get(), '產品貨號搜尋') : empty,
            state.nameMore ? firestoreReadWithTimeout(nameQuery.get(), '產品名稱搜尋') : empty
        ]);
        if (!isCurrent()) return 0;
        const page = new Map();
        [...codeSnap.docs, ...nameSnap.docs].forEach(doc => {
            const product = {id:doc.id, ...doc.data()};
            if (product.active !== false && product.status !== 'INACTIVE') page.set(doc.id, product);
        });
        const products=[...page.values()];
        const productKeys=[...new Set(products.map(product=>String(product.productId||product.id||'').trim()).filter(Boolean))];
        const stockByProduct = new Map();
        for (let i = 0; i < productKeys.length; i += 25) {
            const keys = productKeys.slice(i, i + 25);
            const stockSnap = await firestoreReadWithTimeout(db.collection('warehouseStocks').where('productKey','in',keys).get(), '產品庫存搜尋');
            if (!isCurrent()) return 0;
            stockSnap.docs.forEach(doc => {
                const row = doc.data(), key = String(row.productKey || row.productId || '').trim();
                if (!key) return;
                const current = stockByProduct.get(key) || {onHand:0,reserved:0,incoming:0,available:0};
                const n = inventoryNumbers(row);
                stockByProduct.set(key, {onHand:current.onHand+n.onHand, reserved:current.reserved+n.reserved,
                    incoming:current.incoming+n.incoming, available:current.available+n.available});
            });
        }
        if (!isCurrent()) return 0;
        products.forEach(product => state.products.set(product.id, {product, stock:stockByProduct.get(String(product.productId || product.id)) || inventoryNumbers({})}));
        state.codeCursor = codeSnap.docs.at(-1) || state.codeCursor;
        state.nameCursor = nameSnap.docs.at(-1) || state.nameCursor;
        state.codeMore = codeSnap.size === 25;
        state.nameMore = nameSnap.size === 25;
        if (body) body.innerHTML = [...state.products.values()].map(({product,stock:n}) =>
            `<tr><td data-th="貨號">${escapeHtml(product.manufacturerPartNo||'')}</td><td data-th="品名">${escapeHtml(product.productName||'')}</td><td data-th="廠牌">${escapeHtml(product.brandName||'')}</td><td data-th="建議售價">${Number(isBrandPriceListActive(product.brandName||product.brand||'') ? (product.listPrice||0) : 0).toLocaleString()}</td><td data-th="現有">${n.onHand}</td><td data-th="預留">${n.reserved}</td><td data-th="可用">${n.available}</td><td data-th="在途">${n.incoming}</td><td data-th="預計">${inventoryProjectedStock(n)}</td></tr>`).join('');
        if (status) status.textContent = state.products.size
            ? `找到 ${state.products.size} 筆產品主檔${state.codeMore || state.nameMore ? '，可載入更多。' : '。'}`
            : state.codeMore || state.nameMore ? '這批沒有啟用產品，可載入更多。' : '查無產品，請確認貨號或品名。';
        if (more) { more.hidden = !state.codeMore && !state.nameMore; more.textContent = '載入更多產品'; }
        return state.products.size;
    } catch (err) {
        if (!isCurrent()) return 0;
        console.error('產品查詢失敗：', err);
        if (status) status.textContent = productOperationErrorMessage('產品搜尋', err);
        if (more) { more.hidden = false; more.textContent = '重試產品搜尋'; }
        return 0;
    } finally {
        state.loading = false;
        if (isCurrent() && more) more.disabled = false;
    }
};
window.loadMoreBusinessProducts = function() {
    if (businessProductSearchState) return window.searchBusinessProducts(businessProductSearchState.raw, true);
};
let inventorySearchTimer=null;
let inventorySearchActive=false;
let inventorySearchLoading=false;
let inventorySearchResults=[];
let inventorySearchGeneration=0;

function buildInventorySearchTokens(record={}){
 const values=[record.itemCode,record.itemName,record.brand,record.productKey,record.productId,
   ...(Array.isArray(record.lots)?record.lots.flatMap(lot=>[lot.lotNo,lot.expiryDate]):[])];
 const tokens=new Set();
 for(const raw of values){
   const normalized=normalizeFullHistorySearchValue(raw);
   if(!normalized)continue;
   tokens.add(normalized);
   const maxGram=Math.min(6,normalized.length);
   for(let size=1;size<=maxGram;size++){
     for(let i=0;i+size<=normalized.length;i++){
       tokens.add(normalized.slice(i,i+size));
       if(tokens.size>=300)return [...tokens];
     }
   }
 }
 return [...tokens];
}

function inventoryRecordMatches(record,keyword){
 const needle=normalizeFullHistorySearchValue(keyword);
 if(!needle)return true;
 const values=[record.itemCode,record.itemName,record.brand,record.productKey,record.productId];
 return values.some(value=>normalizeFullHistorySearchValue(value).includes(needle));
}
window.scheduleInventorySearch=function(){clearTimeout(inventorySearchTimer);inventorySearchGeneration++;inventoryLotSearchState=null;renderInventoryLotSearchControls();const keyword=document.getElementById('inventorySearch')?.value||'';if(!normalizeFullHistorySearchValue(keyword)){inventorySearchLoading=false;inventorySearchActive=false;inventorySearchResults=[];const status=document.getElementById('inventorySearchStatus');if(status)status.textContent='';resetBusinessProductSearchResults();renderInventoryList();return;}inventorySearchTimer=scheduleListSearch(inventorySearchTimer,()=>runInventoryUnifiedSearch());};
window.runInventoryUnifiedSearchNow=function(){clearTimeout(inventorySearchTimer);return runInventoryUnifiedSearch();};
async function runInventoryUnifiedSearch(){const keyword=document.getElementById('inventorySearch')?.value||'';if(!normalizeFullHistorySearchValue(keyword)){resetBusinessProductSearchResults();return;}await Promise.allSettled([runInventorySearch(),window.searchBusinessProducts(keyword)]);}
async function runInventorySearch(){
 const keyword=String(document.getElementById('inventorySearch')?.value||'').trim();
 const normalized=normalizeFullHistorySearchValue(keyword);
 const status=document.getElementById('inventorySearchStatus');
 const generation=++inventorySearchGeneration,uid=currentUser?.uid,role=currentUserRole;
 const isCurrent=()=>generation===inventorySearchGeneration&&uid===currentUser?.uid&&role===currentUserRole&&keyword===String(document.getElementById('inventorySearch')?.value||'').trim();
 inventoryLotSearchState=null;renderInventoryLotSearchControls();
 if(!normalized){inventorySearchLoading=false;inventorySearchActive=false;inventorySearchResults=[];if(status)status.textContent='';renderInventoryList();return;}
 inventorySearchLoading=true;inventorySearchActive=true;inventorySearchResults=[];
 const results=new Map();
 if(status)status.textContent='正在搜尋庫存與完整批號…';
 renderInventoryList();
 try{
   const token=fullHistoryServerToken(keyword);
   let checked=0,cursor=null;
   if(token){
     while(true){
       let query=db.collection('inventory')
         .where('searchTokens','array-contains',token)
         .limit(DEFAULT_LIST_LIMIT);
       if(cursor)query=query.startAfter(cursor);
       const snapshot=await firestoreReadWithTimeout(query.get(),'庫存索引搜尋');
       if(!isCurrent())return;
       checked+=snapshot.size;
       snapshot.docs.forEach(doc=>{
         const row={id:doc.id,...doc.data()};
         if(inventoryRecordMatches(row,keyword))results.set(row.id,row);
       });
       inventorySearchResults=[...results.values()].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
       renderInventoryList();
       if(status)status.textContent=`庫存搜尋中：已檢查 ${checked} 筆候選資料，找到 ${results.size} 筆…`;
       if(snapshot.size<DEFAULT_LIST_LIMIT)break;
       cursor=snapshot.docs[snapshot.docs.length-1];
       await Promise.resolve();
     }
   }
   if(!isCurrent())return;
   const fields=['lotNo',...(/^\d{4}-\d{2}-\d{2}$/.test(keyword)?['expiryDate']:[])];
   const state={keyword,generation,uid,role,results,loading:true,pages:fields.map(field=>({field,cursor:null,hasMore:true}))};
   inventoryLotSearchState=state;
   await appendInventoryLotSearchPage(state);
   if(!isCurrent())return;
   const rows=[...results.values()];
   await Promise.all([loadWarehouseStocksForInventoryPage(rows),loadInventoryLotsForPage(rows)]);
   if(!isCurrent())return;
   inventorySearchResults=rows.sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
   if(status)status.textContent=`找到 ${results.size} 筆庫存${state.pages.some(page=>page.hasMore)?'；批號結果尚未讀完':'；完整批號搜尋完成'}`;
 }catch(err){
   if(isCurrent()){console.error('庫存搜尋失敗：',err);if(status)status.textContent='部分搜尋失敗，請重試；不代表沒有庫存';}
 }finally{
   if(isCurrent()){inventorySearchLoading=false;if(inventoryLotSearchState)inventoryLotSearchState.loading=false;renderInventoryList();renderInventoryLotSearchControls();}
 }
}

let inventoryBrandFilterSignature = '';

function populateInventoryBrandFilter() {
 const select=document.getElementById('inventoryBrandFilter');
 if(!select)return [];
 const selected=select.value;
 const brands=getPrimaryBrandNames();
 const signature=JSON.stringify(brands);
 if(signature!==inventoryBrandFilterSignature){
   select.innerHTML='<option value="">全部廠牌</option>'+brands.map(brand=>
     `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('')
     +`<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
   inventoryBrandFilterSignature=signature;
 }
 if(brands.includes(selected)||selected===OTHER_BRAND_OPTION_KEY)select.value=selected;
 else if(selected)select.value='';
 return brands;
}

function warehouseStockRowsForProduct(productKey) {
 return warehouseMasterCache.filter(warehouse=>warehouse.active!==false).map(warehouse=>{
   const stock=warehouseStockCache.get(warehouse.id+'||'+productKey);
   return {warehouse,n:inventoryNumbers(stock||{})};
 });
}
function warehouseStockTotals(productKey) {
 const rows=warehouseStockRowsForProduct(productKey);
 const onHand=rows.reduce((sum,row)=>sum+row.n.onHand,0);
 const reserved=rows.reduce((sum,row)=>sum+row.n.reserved,0);
 const incoming=rows.reduce((sum,row)=>sum+row.n.incoming,0);
 const available=onHand-reserved;
 return {rows,onHand,reserved,available,incoming,projected:available+incoming};
}

const INVENTORY_STOCK_POLICIES = Object.freeze({
 NO_STOCK:'NO_STOCK',
 SAFETY_STOCK:'SAFETY_STOCK',
 ORDER_ONLY:'ORDER_ONLY'
});

function inventoryStockPolicy(item = {}) {
 const explicit=String(item.stockPolicy||'').toUpperCase();
 if(Object.values(INVENTORY_STOCK_POLICIES).includes(explicit))return explicit;
 return Number(item.safetyStock||0)>0 ? INVENTORY_STOCK_POLICIES.SAFETY_STOCK : INVENTORY_STOCK_POLICIES.ORDER_ONLY;
}

function inventoryStockPolicyLabel(policy) {
 return ({
   NO_STOCK:'不備庫',
   SAFETY_STOCK:'安全庫存',
   ORDER_ONLY:'依訂單採購'
 })[String(policy||'').toUpperCase()] || '依訂單採購';
}

function inventoryProjectedStock(stock = {}) {
 const onHand=Number(stock.onHand||0);
 const reserved=Number(stock.reserved||0);
 const available=Number.isFinite(Number(stock.available)) ? Number(stock.available) : onHand-reserved;
 const incoming=Number(stock.incoming||0);
 return available+incoming;
}

function inventoryAggregateStock(item = {}) {
 const productKey=String(item.productKey||item.productId||'').trim();
 if(!Number(item.transferInTransit||0) && productKey && warehouseMasterCache.filter(row=>row.active!==false).every(row=>warehouseStockCache.has(row.id+'||'+productKey)) && warehouseMasterCache.length)return warehouseStockTotals(productKey);
 const n=inventoryNumbers(item);
 const onHand=Number(n.onHand||0);
 const reserved=Number(n.reserved||0);
 const incoming=Number(n.incoming||0);
 const available=n.available;
 return {rows:productKey?warehouseStockRowsForProduct(productKey):[],onHand,reserved,available,incoming,projected:available+incoming};
}

function inventoryReplenishmentPlan(item = {}, stock = {}) {
 const policy=inventoryStockPolicy(item);
 const safetyStock=Math.max(0,Number(item.safetyStock||0));
 const projected=inventoryProjectedStock(stock);
 const suggestedQty=!globalThis.YushinInventory.isListArchived(item,stock)&&policy===INVENTORY_STOCK_POLICIES.SAFETY_STOCK
   ? Math.max(0,safetyStock-projected)
   : 0;
 return {policy,safetyStock,projected,suggestedQty,needsReplenishment:suggestedQty>0};
}


let inventoryReplenishmentError = '';
function renderInventoryReplenishmentCenter() {
    const body = document.getElementById('purchaseReplenishmentBody');
    const status = document.getElementById('purchaseReplenishmentStatus');
    const details = document.getElementById('purchaseReplenishmentDetails');
    const panel = document.getElementById('purchaseReplenishmentPanel');
    if (!body || !status) return;

    const rows = inventoryReplenishmentCache
        .map(item => ({ item, stock: inventoryAggregateStock(item) }))
        .map(row => ({ ...row, plan: inventoryReplenishmentPlan(row.item, row.stock) }))
        .filter(row => row.plan.needsReplenishment)
        .sort((a, b) => b.plan.suggestedQty - a.plan.suggestedQty || String(a.item.itemCode || '').localeCompare(String(b.item.itemCode || ''), 'zh-Hant'));

    const empty = !inventoryReplenishmentLoading && !inventoryReplenishmentError && !rows.length;
    status.textContent = inventoryReplenishmentError || (inventoryReplenishmentLoading
        ? '正在檢查安全庫存品項…'
        : (rows.length ? `需補貨 ${rows.length} 個品項；建議量已扣除現有預留與在途。` : '✓ 目前沒有需要補貨的品項。'));

    const taskCount = document.getElementById('purchaseCountReplenishment');
    if (taskCount) taskCount.textContent = inventoryReplenishmentError ? '讀取失敗' : inventoryReplenishmentLoading ? '檢查中…' : `${rows.length} 品項`;

    if(details)details.hidden=empty;
    if (panel) panel.classList.toggle('is-empty', empty);

    body.innerHTML = rows.map(({ item, stock, plan }) => `<tr>
        <td data-th="貨號">${escapeHtml(item.itemCode || '')}</td>
        <td data-th="品名">${escapeHtml(item.itemName || '')}</td>
        <td data-th="廠牌">${escapeHtml(item.brand || '')}</td>
        <td data-th="現有">${stock.onHand}</td>
        <td data-th="預留">${stock.reserved}</td>
        <td data-th="可用">${stock.available}</td>
        <td data-th="在途">${stock.incoming}</td>
        <td data-th="預計"><strong>${plan.projected}</strong></td>
        <td data-th="安全庫存">${plan.safetyStock}</td>
        <td data-th="建議補貨"><strong>${plan.suggestedQty}</strong></td>
        <td data-th="操作" class="no-print">${canEditPage('orders.po') ? `<button type="button" class="btn-small" onclick="openInventoryReplenishment(${inlineJsValue(item.id)})">建立採購單</button>${canManageInventoryStockPolicy() ? ` <button type="button" class="btn-small btn-danger" onclick="removeInventoryReplenishmentReminder(${inlineJsValue(item.id)})">停止安全庫存提醒</button>` : ''}` : '僅可查看'}</td>
      </tr>`).join('');
}
window.removeInventoryReplenishmentReminder = async function(inventoryId) {
    if (!canManageInventoryStockPolicy()) return alert('只有管理員或採購可以移除安全庫存提醒。');
    if (!confirm('移除這個品項的安全庫存備貨提醒？\n\n此品項將改為「依訂單採購」，庫存、既有需求與採購單會保留。日後可在庫存設定重新開啟安全庫存。')) return;
    try {
        await saveInventoryPlanningSettings(inventoryId, INVENTORY_STOCK_POLICIES.ORDER_ONLY);
        await loadInventoryReplenishmentCenter(true);
        showActionFeedback('已移除安全庫存備貨提醒。');
    } catch (err) { alert('移除提醒失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。'); }
};
async function loadInventoryReplenishmentCenter(force=false) {
 if(!canAccessPage('orders.po'))return;
 if(inventoryReplenishmentLoading)return;
 if(!force&&!inventoryReplenishmentError&&inventoryReplenishmentCache.length){renderInventoryReplenishmentCenter();return;}
 const uid=currentUser?.uid,role=currentUserRole;
 inventoryReplenishmentLoading=true;
 inventoryReplenishmentError='';
 renderInventoryReplenishmentCenter();
 try{
   const rows=await readQueryInBatches(
     db.collection('inventory')
       .where('stockPolicy','==',INVENTORY_STOCK_POLICIES.SAFETY_STOCK)
       .orderBy(firebase.firestore.FieldPath.documentId()),
     200
   );
   if(uid!==currentUser?.uid||role!==currentUserRole)return;
   inventoryReplenishmentCache=rows;
   await loadWarehouseStocksForInventoryPage(inventoryReplenishmentCache);
 }catch(err){
   if(uid!==currentUser?.uid||role!==currentUserRole)return;
   inventoryReplenishmentError='安全庫存補貨讀取失敗，請重試；尚無法確認是否需要補貨。';
   mainPageLoadFailed('orders.po');
   console.error('補貨中心載入失敗：',err);
   const status=document.getElementById('purchaseReplenishmentStatus');
   if(status)status.textContent='安全庫存補貨讀取失敗，切換頁面後會自動重試。';
 }finally{
   inventoryReplenishmentLoading=false;
   if(uid===currentUser?.uid&&role===currentUserRole)renderInventoryReplenishmentCenter();
 }
}
window.loadInventoryReplenishmentCenter=loadInventoryReplenishmentCenter;

function canManageInventoryStockPolicy() {
 return currentUserRole === 'admin' || currentUserRole === 'purchaser';
}

function inventoryStockPolicyBadge(item = {}) {const policy=inventoryStockPolicy(item),className=policy===INVENTORY_STOCK_POLICIES.SAFETY_STOCK?'is-safety':policy===INVENTORY_STOCK_POLICIES.NO_STOCK?'is-none':'is-order';return `<span class="inventory-policy-badge ${className}">${escapeHtml(inventoryStockPolicyLabel(policy))}</span>`;}

window.renderInventoryList=function(){
 const body=document.getElementById('inventoryListBody');if(!body)return;const k=(document.getElementById('inventorySearch')?.value||'').toLowerCase(),stateFilter=document.getElementById('inventoryStateFilter')?.value||'all',policyFilter=document.getElementById('inventoryPolicyFilter')?.value||'',brands=populateInventoryBrandFilter(),brandFilter=document.getElementById('inventoryBrandFilter')?.value||'',rowsHtml=[],inventoryRows=inventorySearchActive?inventorySearchResults:inventoryCache,activeWarehouseCount=warehouseMasterCache.filter(warehouse=>warehouse.active!==false).length;
 inventoryRows.forEach(x=>{if(brandFilter&&orderBrandFilterValue(x.brand,brands)!==brandFilter)return;const lots=fefoLots(x),productKey=x.productKey||x.productId||'',warehouseState=inventoryAggregateStock(x),warehouseRows=warehouseState.rows,warehouseSearch=warehouseRows.map(row=>row.warehouse.warehouseName||'').join(' '),text=`${x.itemCode||''} ${x.itemName||''} ${x.brand||''} ${warehouseSearch} ${lots.map(l=>l.lotNo).join(' ')}`.toLowerCase();if(!inventorySearchActive&&k&&!text.includes(k))return;const archived=globalThis.YushinInventory.isListArchived(x,warehouseState);if(stateFilter==='archived'?!archived:archived)return;const n=warehouseState,stockPolicy=inventoryStockPolicy(x),safetyStock=Number(x.safetyStock||0),plan=inventoryReplenishmentPlan(x,n);if(policyFilter&&stockPolicy!==policyFilter)return;if(stateFilter==='low'&&!plan.needsReplenishment)return;if(stateFilter==='out'&&n.available>0)return;if(stateFilter==='reserved'&&n.reserved<=0)return;
 const visibleWarehouseRows=warehouseRows.filter(row=>row.n.onHand||row.n.reserved||row.n.incoming),showWarehouseDetail=activeWarehouseCount>1&&visibleWarehouseRows.length>0,warehouseHtml=showWarehouseDetail?visibleWarehouseRows.map(row=>`<div><strong>${escapeHtml(row.warehouse.warehouseName||row.warehouse.id)}</strong>：現有 ${row.n.onHand}／預留 ${row.n.reserved}／可用 ${row.n.available}／在途 ${row.n.incoming}</div>`).join('')+(Number(x.transferInTransit||0)>0?`<div>調撥途中：${Number(x.transferInTransit)}</div>`:''):'－';
 const productMaster=productMasterForRecord({productId:x.productId||productKey,itemCode:x.itemCode||'',brand:x.brand||''}),lotState=inventoryLotViewState(x),showLotDetail=!!(productMaster?.lotTracked||productMaster?.expiryTracked||lots.length||!lotState.complete),lotHtml=inventoryLotCellHtml(x),reserved=n.reserved>0?`<button type="button" class="link-button inventory-reserved-link" onclick="openInventoryReservationDetails(${inlineJsValue(x.productKey||x.id||'')})">${n.reserved}</button>`:'0';
 rowsHtml.push(`<tr class="inventory-list-row"><td data-th="貨號" class="inventory-detail-field">${escapeHtml(x.itemCode||'')}</td><td data-th="品名" class="inventory-primary-cell"><strong class="inventory-item-name">${escapeHtml(x.itemName||x.itemCode||'未命名品項')}${archived?'（已移出）':''}</strong><span class="inventory-mobile-brand">${escapeHtml(x.brand||'')}</span><div class="inventory-mobile-summary"><div><span>可用</span><strong>${n.available}</strong></div><div><span>在途</span><strong>${n.incoming}</strong></div><div><span>預計</span><strong>${plan.projected}</strong></div></div></td><td data-th="廠牌" class="inventory-brand-cell">${escapeHtml(x.brand||'')}</td><td data-th="倉庫位置" class="inventory-detail-field inventory-optional-detail ${showWarehouseDetail?'':'inventory-no-detail'}">${warehouseHtml}</td><td data-th="現有庫存" class="inventory-detail-field">${n.onHand}</td><td data-th="已預留" class="inventory-detail-field">${reserved}</td><td data-th="可用庫存" class="inventory-desktop-metric">${n.available}</td><td data-th="庫存策略" class="inventory-policy-cell">${inventoryStockPolicyBadge(x)}</td><td data-th="安全庫存" class="inventory-detail-field inventory-optional-detail ${stockPolicy===INVENTORY_STOCK_POLICIES.SAFETY_STOCK?'':'inventory-no-detail'}">${stockPolicy===INVENTORY_STOCK_POLICIES.SAFETY_STOCK?safetyStock:'－'}</td><td data-th="在途" class="inventory-desktop-metric">${n.incoming}</td><td data-th="預計庫存" class="inventory-desktop-metric"><strong>${plan.projected}</strong></td><td data-th="批號／效期" class="inventory-detail-field inventory-optional-detail ${showLotDetail?'':'inventory-no-detail'}">${lotHtml}</td><td data-th="操作" class="no-print inventory-actions-cell">${canEditPage('inventory')?`<div class="inventory-row-actions"><button type="button" class="btn-small btn-secondary inventory-details-toggle" onclick="toggleInventoryRowDetails(this)">詳細資料</button><button type="button" class="btn-small inventory-action-quantity" onclick="openInventoryQuantityEditor(${inlineJsValue(x.id)})">修改庫存</button>${canManageInventoryStockPolicy()?`<button type="button" class="btn-small btn-secondary inventory-action-transfer" onclick="openInventoryTransfer(${inlineJsValue(x.id)})" ${activeInventoryWarehouses().length<2?'disabled title="至少需要兩個實體倉庫"':''}>調回主倉備貨</button>`:''}${canManageInventoryStockPolicy()?`<button type="button" class="btn-small btn-secondary inventory-action-policy" onclick="openInventoryPolicySettings(${inlineJsValue(x.id)})">⚙️ 庫存設定</button>`:''}${canManageInventoryList()?`<button type="button" class="btn-small btn-secondary inventory-action-archive" onclick="setInventoryListArchived(${inlineJsValue(x.id)},${!archived},this)" ${!archived&&!globalThis.YushinInventory.stockIsEmpty({...x,...n,lots:[]})?'disabled title="現有、預留、在途及調撥數量必須為零"':''}>${archived?'恢復至庫存列表':'移出庫存列表'}</button>${!archived&&!globalThis.YushinInventory.stockIsEmpty({...x,...n,lots:[]})?'<small class="inventory-action-reason">仍有庫存／預留／在途／調撥，無法移出</small>':''}`:''}</div>`:`<div class="inventory-row-actions"><button type="button" class="btn-small btn-secondary inventory-details-toggle" onclick="toggleInventoryRowDetails(this)">詳細資料</button><span>僅可查看</span></div>`}</td></tr>`);
 });body.innerHTML=rowsHtml.join('');
};
window.toggleInventoryRowDetails=function(button){const row=button?.closest?.('tr');if(!row)return;const expanded=row.classList.toggle('inventory-expanded');button.textContent=expanded?'收合詳細':'詳細資料';};
window.openInventoryReplenishment = async function(inventoryId) {
    if (!canEditPage('orders.po')) { alert('您沒有採購權限。'); return; }
    const button = actionButtonFromEventOrSelector();
    const buttonState = beginActionButton(button, '準備採購單…');
    if (button && !buttonState) return;

    try {
        // 庫存異動會清除補貨快取，但畫面上的列仍可能存在。點擊時以文件識別碼讀取，
        // 不依賴其他頁是否已載入這個品項，也重新確認目前的庫存策略。
        const snapshot=await firestoreReadWithTimeout(db.collection('inventory').doc(inventoryId).get(),'讀取補貨品項');
        if(!snapshot.exists){
            showActionFeedback('這筆庫存品項已不存在，正在重新載入補貨清單。','warning');
            await loadInventoryReplenishmentCenter(true);
            return;
        }
        const item={...snapshot.data(),id:snapshot.id};
        if (inventoryStockPolicy(item) !== INVENTORY_STOCK_POLICIES.SAFETY_STOCK) {
            alert('這個品項目前不是「安全庫存」策略，不會建立主動補庫採購。');
            return;
        }

        await loadSupplierWarehouseMasters();
        const productKey=String(item.productKey||item.productId||'').trim();
        if(productKey)[...warehouseStockCache.keys()].filter(key=>key.endsWith('||'+productKey)).forEach(key=>warehouseStockCache.delete(key));
        await loadWarehouseStocksForInventoryPage([item]);
        const stock = inventoryAggregateStock(item);
        const safetyStock = Math.max(0, Number(item.safetyStock || 0));
        if (!(safetyStock > 0)) {
            alert('請先設定安全庫存，再建立補庫採購。');
            return;
        }

        const demand = globalThis.YushinProcurementDemand?.fromStockReplenishment({
            sourceId:item.id || item.productKey || item.productId || '',
            safetyStock,
            available:stock.available,
            incoming:stock.incoming
        });
        if (!demand) throw new Error('Procurement Demand core 未載入，無法計算補庫需求。');
        const projectedAvailable = stock.available + stock.incoming;
        if (!(demand.remainingToOrderQty > 0)) {
            alert(`目前可用 ${stock.available}、在途 ${stock.incoming}；既有在途到貨後已可達安全庫存 ${safetyStock}，不需重複建立補庫採購。`);
            return;
        }
        const suggestedQty = demand.remainingToOrderQty;

        // 先保存補貨需求，再開採購單；等待期間按鈕會立即顯示「準備採購單…」。
        const demandRef = procurementDemandRef(demand.demandId);
        if (demandRef) {
            const now = new Date().toISOString();
            const demandDoc = procurementDemandDocument(demand, {
                productId:item.productId || item.productKey || '',
                productKey:item.productKey || item.productId || '',
                itemCode:item.itemCode || '',
                itemName:item.itemName || '',
                brand:item.brand || '',
                fulfillmentType:'WAREHOUSE',
                warehouseId:defaultWarehouse()?.id || ''
            }, { createdAt:item.createdAt || now, updatedAt:now });
            await demandRef.set(demandDoc, { merge:true });
            invalidateProcurementDemandQueue();
        }

        const match = await findProductByCode(item.itemCode || '',item.brand || '');
        let unitPrice = 0;
        if (match) {
            const secureCost = await loadVisibleProductCost(match);
            unitPrice = secureCost !== null && Number.isFinite(secureCost)
                ? secureCost
                : Number(match.cost || 0);
        }

        poDirectStockMode = true;
        poEditingId = null;
        poAllItems = [];
        poItems = [{
            orderId:'',
            sourceType:'STOCK_REPLENISHMENT',
            sourceId:demand.sourceId || item.id || item.productKey || item.productId || '',
            demandId:demand.demandId || '',
            demandRequestedQty:demand.requestedQty,
            demandOrderedQty:demand.orderedQty,
            demandReceivedQty:demand.receivedQty,
            itemName:item.itemName || match?.nameCn || match?.nameEn || '',
            itemCode:item.itemCode || match?.model || '',
            productId:item.productId || item.productKey || match?.productId || '',
            brand:resolveBrandName(item.brand || match?.brand || ''),
            qty:suggestedQty,
            unitPrice,
            supplier:match?.supplier || '',
            productLine:match?.productLine || '',
            fulfillmentType:'WAREHOUSE',
            warehouseId:defaultWarehouse()?.id || ''
        }];
        poAllItems = poItems;
        populatePoVendorSuggestions();
        document.getElementById('poVendorName').value = '';
        document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
        document.getElementById('poDate').value = localDateString();
        clearPoExpectedDate();
        await autoFillPoSupplier(poItems);
        switchPoCompany(currentCompany || 'yushin', null, true);
        generatePoNo();
        updatePoModeUI();

        const hint = document.getElementById('poModeHint');
        if (hint) hint.textContent = `安全庫存補貨：${globalThis.YushinProcurementDemand.statusLabel(demand.status)}。目前可用 ${stock.available}，在途 ${stock.incoming}，到貨後預估可用 ${projectedAvailable}，安全庫存 ${safetyStock}，本次仍需採購 ${suggestedQty}。`;
        document.getElementById('poModalOverlay').classList.add('active');
    } catch (err) {
        alert('準備安全庫存採購單失敗：' + (err?.message || err));
    } finally {
        endActionButton(button, buttonState);
    }
};

function inventoryItemById(inventoryId) {return inventoryCache.find(x=>x.id===inventoryId)||inventorySearchResults.find(x=>x.id===inventoryId)||inventoryReplenishmentCache.find(x=>x.id===inventoryId)||null;}
function canManageInventoryList() {
    return trueUserRole === 'admin' && currentUserRole === 'admin';
}
const inventoryListArchiveInProgress = new Set();
window.setInventoryListArchived = async function(inventoryId, archived, button) {
    if (!canManageInventoryList()) { alert('只有管理員視角可以移出或恢復庫存品項。'); return; }
    if (inventoryListArchiveInProgress.has(inventoryId)) return;
    const item = inventoryItemById(inventoryId);
    if (!item || typeof archived !== 'boolean') return;
    if (archived && (!globalThis.YushinInventory.stockIsEmpty({...item,lots:[]})
        || !globalThis.YushinInventory.stockIsEmpty(inventoryAggregateStock(item)))) {
        alert('現有庫存、預留、在途及批號剩餘數量都必須為 0，才能移出庫存列表。'); return;
    }
    if (!confirm(`${archived?'移出庫存列表':'恢復至庫存列表'}：${item.itemCode||'－'}｜${item.itemName||'未命名品項'}？\n\n商品主檔、訂單、採購與出入庫歷史都會保留。${archived?'日後有庫存、預留或在途數量時會再次顯示。':''}`)) return;
    inventoryListArchiveInProgress.add(inventoryId);
    const buttonState = beginActionButton(button, archived?'移出中…':'恢復中…');
    const actorUid = currentUser.uid;
    try {
        const ref = db.collection('inventory').doc(inventoryId);
        const auditRef = db.collection('auditLogs').doc();
        const productKey = item.productKey || item.productId || inventoryId;
        // Include inactive warehouses; re-read every stock document in the transaction.
        const warehouseSnapshot = archived ? await firestoreReadWithTimeout(
            db.collection('warehouseStocks').where('productKey','==',productKey).limit(201).get(), '移出前檢查倉庫庫存'
        ) : null;
        const lotSnapshot=archived?await firestoreReadWithTimeout(db.collection('inventoryLots').where('productKey','==',productKey).limit(201).get(),'移出前檢查實際批次'):null;
        if(lotSnapshot?.size>200)throw new Error('批次超過安全檢查上限。');
        if (warehouseSnapshot?.size > 200) throw new Error('倉庫庫存紀錄超過可安全檢查的範圍，請先整理倉庫紀錄。');
        const patch = await runRoleTransaction(async transaction => {
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到庫存品項，請更新清單。');
            const live = snapshot.data();
            if (!canManageInventoryList() || currentUser?.uid !== actorUid) throw new Error('登入身分已變更，請重新操作。');
            if ((live.listArchived === true) === archived) return null;
            if (archived) {
                if ((live.productKey || live.productId || inventoryId) !== productKey) throw new Error('品項資料已變更，請更新清單。');
                if (!globalThis.YushinInventory.stockIsEmpty({...live,lots:[]})) throw new Error('庫存、預留、在途或批號數量已變更，不能移出。');
                for(const lotDoc of lotSnapshot.docs){const lot=await transaction.get(lotDoc.ref);if(lot.exists&&(!Number.isFinite(Number(lot.data().remainingQty||0))||Number(lot.data().remainingQty||0)!==0))throw new Error('仍有實際批次剩餘量，不能移出。');}
                for (const warehouseDoc of warehouseSnapshot.docs) {
                    const stock = await transaction.get(warehouseDoc.ref);
                    if (stock.exists && !globalThis.YushinInventory.stockIsEmpty(stock.data())) throw new Error('仍有倉庫庫存、預留或在途數量，不能移出。');
                }
            }
            const changedAt = new Date().toISOString();
            const next = {listArchived:archived, listArchiveChangedAt:changedAt,
                listArchiveChangedByUid:actorUid, listArchiveAuditId:auditRef.id, updatedAt:changedAt};
            transaction.update(ref, next);
            transaction.set(auditRef, {action:archived?'inventory_list_archive':'inventory_list_restore',
                inventoryId, productKey, actorUid, createdAt:changedAt,
                itemCode:live.itemCode||'', itemName:live.itemName||'', archived});
            return next;
        });
        if (patch) applyInventoryPlanningPatchToCaches(inventoryId, patch);
        else await loadInventory(true);
        writeAppDataCache('inventory', inventoryCache);
        markMainPageDirty('orders.po');
        renderInventoryList(); renderInventoryReplenishmentCenter();
        showActionFeedback(archived?'已移出庫存列表；商品與歷史紀錄已保留。':'已恢復至庫存列表。');
    } catch (err) {
        alert('庫存列表更新失敗：'+(err?.message||err));
    } finally {
        inventoryListArchiveInProgress.delete(inventoryId);
        endActionButton(button, buttonState);
    }
};
function applyInventoryPlanningPatchToCaches(inventoryId,patch) {[inventoryCache,inventorySearchResults,inventoryReplenishmentCache].forEach(list=>{const item=list.find(x=>x.id===inventoryId);if(item)Object.assign(item,patch);});}
async function saveInventoryPlanningSettings(inventoryId,policy,safetyStock=0) {const next=String(policy||'').toUpperCase();if(!Object.values(INVENTORY_STOCK_POLICIES).includes(next))throw new Error('庫存策略格式不正確。');const normalizedSafety=next===INVENTORY_STOCK_POLICIES.SAFETY_STOCK?Number(safetyStock||0):0;if(next===INVENTORY_STOCK_POLICIES.SAFETY_STOCK&&(!Number.isFinite(normalizedSafety)||normalizedSafety<=0))throw new Error('安全庫存必須是大於 0 的數字。');const patch={stockPolicy:next,safetyStock:normalizedSafety,updatedAt:new Date().toISOString()};await db.collection('inventory').doc(inventoryId).update(patch);applyInventoryPlanningPatchToCaches(inventoryId,patch);inventoryReplenishmentCache=[];markMainPageDirty('orders.po');renderInventoryList();return patch;}
window.setInventoryStockPolicy=async function(inventoryId,policy,requestedSafetyStock=null){if(!canManageInventoryStockPolicy()){alert('只有管理員或採購可以調整庫存策略。');renderInventoryList();return;}const item=inventoryItemById(inventoryId);if(!item)return;const next=String(policy||'').toUpperCase();if(!Object.values(INVENTORY_STOCK_POLICIES).includes(next)){renderInventoryList();return;}let safetyStock=next===INVENTORY_STOCK_POLICIES.SAFETY_STOCK?Number(requestedSafetyStock??item.safetyStock??0):0;if(next===INVENTORY_STOCK_POLICIES.SAFETY_STOCK&&safetyStock<=0&&requestedSafetyStock===null){const raw=prompt(`設定 ${item.itemCode||item.itemName||'品項'} 的安全庫存量`,'1');if(raw===null)return;safetyStock=Number(raw);}try{await saveInventoryPlanningSettings(inventoryId,next,safetyStock);showActionFeedback(`庫存策略已更新為「${inventoryStockPolicyLabel(next)}」。`);}catch(err){renderInventoryList();alert('庫存策略更新失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');}};
window.setInventorySafetyStock=async function(inventoryId){if(!canManageInventoryStockPolicy()){alert('只有管理員或採購可以設定安全庫存。');return;}const item=inventoryItemById(inventoryId);if(!item)return;if(inventoryStockPolicy(item)!==INVENTORY_STOCK_POLICIES.SAFETY_STOCK){alert('請先把庫存策略設為「安全庫存」。');return;}const raw=prompt(`設定 ${item.itemCode||item.itemName||'品項'} 的安全庫存`,String(Number(item.safetyStock||0)));if(raw===null)return;try{await saveInventoryPlanningSettings(inventoryId,INVENTORY_STOCK_POLICIES.SAFETY_STOCK,Number(raw));}catch(err){alert('安全庫存更新失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');}};
let inventoryPolicyEditingId='';
window.openInventoryPolicySettings=function(inventoryId){if(!canManageInventoryStockPolicy()){alert('只有管理員或採購可以調整庫存策略。');return;}const item=inventoryItemById(inventoryId);if(!item){alert('找不到庫存品項。');return;}inventoryPolicyEditingId=inventoryId;const label=document.getElementById('inventoryPolicyItemLabel');if(label)label.textContent=`${item.itemCode||'－'}｜${item.itemName||'未命名品項'}｜${item.brand||'未指定廠牌'}`;document.getElementById('inventoryPolicySettingSelect').value=inventoryStockPolicy(item);document.getElementById('inventorySafetyStockSetting').value=Number(item.safetyStock||0);onInventoryPolicySettingChange();document.getElementById('inventoryPolicyOverlay')?.classList.add('active');};
window.onInventoryPolicySettingChange=function(){const policy=document.getElementById('inventoryPolicySettingSelect')?.value||INVENTORY_STOCK_POLICIES.ORDER_ONLY,row=document.getElementById('inventorySafetyStockSettingRow');if(row)row.style.display=policy===INVENTORY_STOCK_POLICIES.SAFETY_STOCK?'':'none';};
window.closeInventoryPolicySettings=function(){inventoryPolicyEditingId='';document.getElementById('inventoryPolicyOverlay')?.classList.remove('active');};
window.saveInventoryPolicySettings=async function(){if(!canManageInventoryStockPolicy())return alert('您沒有庫存設定權限。');if(!inventoryPolicyEditingId)return;const policy=document.getElementById('inventoryPolicySettingSelect')?.value||INVENTORY_STOCK_POLICIES.ORDER_ONLY,safetyStock=Number(document.getElementById('inventorySafetyStockSetting')?.value||0),button=document.getElementById('saveInventoryPolicySettingsBtn');if(button){button.disabled=true;button.textContent='儲存中…';}try{await saveInventoryPlanningSettings(inventoryPolicyEditingId,policy,safetyStock);closeInventoryPolicySettings();showActionFeedback('庫存設定已更新。');}catch(err){alert('庫存設定儲存失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');}finally{if(button){button.disabled=false;button.textContent='儲存設定';}}};
window.renderPendingInventoryItems=function(){
    updateInventoryReceivingCount();
    const body=document.getElementById('pendingInventoryBody');
    const hint=document.getElementById('pendingInventoryEmptyHint');
    if(!body)return;
    const supplies=pendingSupplyCache.map(x=>{
        const progress=globalThis.YushinSupply?.receiptProgress(x);
        if(!progress)return '';
        const label=x.purchaseDocumentNo||x.internalNo||'供應紀錄';
        const action=canReceiveInventoryCapability()
            ? `<button type="button" class="btn-small btn-secondary" data-receipt-supply="${escapeAttr(x.id)}" onclick="receiveSupplyOrder(${inlineJsValue(x.id)})">${escapeHtml(label)}・入庫</button>`
            : '僅可查看';
        return `<tr>
            <td data-th="貨號">${escapeHtml(x.itemCode||'')}</td>
            <td data-th="品名">${escapeHtml(x.itemName||'')}</td>
            <td data-th="廠牌">${escapeHtml(x.brand||'')}</td>
            <td data-th="在途數量">${progress.remainingQty}</td>
            <td data-th="供應商">${escapeHtml(x.supplier||'')}</td>
            <td data-th="狀態">${escapeHtml(progress.label)}<div class="inventory-row-actions">${action}</div></td>
        </tr>`;
    }).filter(Boolean);
    body.innerHTML=supplies.join('');
    renderReceiptTasks();
    if(hint){hint.textContent=inventoryPendingSupplyError||(inventoryPendingSupplyLoading?'正在讀取待到貨資料…':'目前沒有待到貨品項。');hint.style.display=(inventoryPendingSupplyError||inventoryPendingSupplyLoading||!supplies.length)?'block':'none';}
};
function inventoryMovementTypeLabel(type='') {
    return ({
        initial:'手動新增庫存',
        adjustment:'盤點調整',
        scrap:'報廢',
        warehouse_transfer_out:'倉庫移出',
        warehouse_transfer_in:'倉庫移入',
        purchase_incoming:'採購在途',
        purchase_incoming_cancel:'取消在途',
        purchase_incoming_close:'結束在途',
        receipt:'採購入庫',
        reserve:'訂單預留',
        release:'解除預留',
        reserve_from_receipt:'到貨自動預留',
        reserve_from_free_stock:'自由庫存自動預留',
        ship:'出貨',
        ship_reversal:'撤銷出貨',
        return_in:'客戶退貨入庫',
        return_reversal:'撤銷退貨'
    })[String(type||'')] || String(type||'庫存異動');
}

function inventoryMovementTimeLabel(value='') {
    if(!value)return '';
    const date=new Date(value);
    if(Number.isNaN(date.getTime()))return String(value);
    const pad=n=>String(n).padStart(2,'0');
    return `${date.getFullYear()}/${pad(date.getMonth()+1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function inventoryWarehouseName(warehouseId='') {
    if(!warehouseId)return '';
    return warehouseMasterCache.find(row=>row.id===warehouseId)?.warehouseName || warehouseId;
}

function inventoryMovementProductInfo(movement={}) {
    const key=String(movement.productKey||movement.productId||'').trim();
    const item=[...inventoryCache,...inventorySearchResults].find(row=>String(row.productKey||row.productId||'').trim()===key);
    return {
        code:movement.itemCode||item?.itemCode||key,
        name:movement.itemName||item?.itemName||''
    };
}

function inventoryMovementSourceLabel(movement={}) {
    if(movement.type==='warehouse_transfer_out'||movement.type==='warehouse_transfer_in'){
        const from=inventoryWarehouseName(movement.fromWarehouseId||'');
        const to=inventoryWarehouseName(movement.toWarehouseId||'');
        return from&&to?`${from} → ${to}`:'倉庫移動';
    }
    const sourceType=String(movement.sourceType||'').toUpperCase();
    const sourceId=String(movement.sourceId||'').trim();
    const documentNo=String(movement.purchaseDocumentId||'').trim();
    let label='';
    if(sourceType==='SUPPLY_ORDER')label='採購';
    else if(sourceType==='ORDER')label='訂單';
    else if(sourceType==='MANUAL')label='人工';
    else if(sourceType)label=movement.sourceType;
    const id=documentNo||sourceId;
    if(id&&id!=='quantity-editor')label+=`${label?'｜':''}${id}`;
    if(sourceId==='quantity-editor')label='人工盤點';
    if(movement.note)label+=`${label?'｜':''}${movement.note}`;
    return label||'－';
}

window.renderInventoryLedger=function(){
    const body=document.getElementById('inventoryLedgerBody');
    if(!body)return;
    body.innerHTML=inventoryLedgerCache.map(movement=>{
        const product=inventoryMovementProductInfo(movement);
        const qty=Number(movement.qty||0);
        const qtyLabel=`${qty>0?'+':''}${qty}`;
        return `<tr>
            <td data-th="時間">${escapeHtml(inventoryMovementTimeLabel(movement.createdAt||''))}</td>
            <td data-th="品項"><strong>${escapeHtml(product.code||'－')}</strong>${product.name?`<div class="inventory-ledger-item-name">${escapeHtml(product.name)}</div>`:''}</td>
            <td data-th="類型">${escapeHtml(inventoryMovementTypeLabel(movement.type||''))}</td>
            <td data-th="數量"><strong>${escapeHtml(qtyLabel)}</strong></td>
            <td data-th="來源">${escapeHtml(inventoryMovementSourceLabel(movement))}</td>
            <td data-th="人員">${escapeHtml(movement.createdBy||'')}</td>
        </tr>`;
    }).join('');
};
let inventoryAdjustmentRows = [];
let inventoryAdjustmentSaveInProgress=false;
let inventoryAdjustmentGeneration=0;

function inventoryAdjustmentTitle(type) {return ({initial:'手動新增庫存',adjustment:'批號／效期庫存異動',scrap:'報廢'})[type]||'庫存異動';}
window.onInventoryAdjustmentTypeChange=function(){
    const type=document.getElementById('inventoryAdjustmentType')?.value||'adjustment';
    const title=document.getElementById('inventoryAdjustmentTitle');
    const hint=document.getElementById('inventoryAdjustmentHint');
    if(title)title.innerText=inventoryAdjustmentTitle(type);
    if(!hint)return;
    if(type==='initial'){
        hint.textContent=canCreatePurchaseOrderCapability() ? '輸入貨號後會自動帶入品名與廠牌；請填數量與實際單位成本，零成本請明確填 0。批號／效期可選填。' : '輸入貨號與數量；成本由採購或管理員補登。批號／效期可選填。';
    }else if(type==='scrap'){
        hint.textContent='報廢請輸入正數，系統會自動扣除並保留報廢異動紀錄。';
    }else{
        hint.textContent='一般盤點請使用庫存卡片的「修改庫存」直接輸入盤點後數量；這裡只處理批號／效期品項的增減異動。';
    }
};
window.openInventoryAdjustment = async function(type = 'initial', item = null) {
    if(inventoryAdjustmentSaveInProgress)return;
    if (!canEditPage('inventory')) return;
    const generation=++inventoryAdjustmentGeneration;
    const editorUid=currentUser?.uid,editorRole=currentUserRole;
    const saveButton=document.getElementById('saveInventoryAdjustmentBatchBtn');
    if(saveButton){saveButton.disabled=false;saveButton.textContent='確認儲存';}
    const selectedType = type || 'initial';
    const source = item || null;
    const overlay = document.getElementById('inventoryAdjustmentOverlay');
    const typeSelect = document.getElementById('inventoryAdjustmentType');
    const typeWrap = document.getElementById('inventoryAdjustmentTypeWrap');
    const addRowBtn = document.getElementById('inventoryAddRowBtn');

    inventoryAdjustmentRows = [{
        itemCode: source?.itemCode || '',
        itemName: source?.itemName || '',
        brand: source?.brand || '',
        productId: source?.productId || source?.productKey || '',
        warehouseId: defaultWarehouse()?.id || '',
        qty: 0,
        unitCost: '',
        lotNo: '',
        expiryDate: ''
    }];

    if (typeSelect) {
        typeSelect.value = selectedType;
        typeSelect.disabled = selectedType === 'initial';
        const initialOption = typeSelect.querySelector('option[value="initial"]');
        if (initialOption) initialOption.disabled = selectedType !== 'initial';
    }
    if (typeWrap) typeWrap.style.display = selectedType === 'initial' ? 'none' : '';
    if (addRowBtn) {
        addRowBtn.style.display = selectedType === 'initial' ? '' : 'none';
        addRowBtn.textContent = '＋ 再加一個品項';
    }

    onInventoryAdjustmentTypeChange();
    renderInventoryAdjustmentRows();
    overlay?.classList.add('active');

    try {
        await loadWarehouseMaster();
        if(inventoryAdjustmentSaveInProgress||generation!==inventoryAdjustmentGeneration||editorUid!==currentUser?.uid||editorRole!==currentUserRole)return;
        const fallbackWarehouseId = defaultWarehouse()?.id || '';
        inventoryAdjustmentRows = inventoryAdjustmentRows.map(row => ({
            ...row,
            warehouseId: row.warehouseId || fallbackWarehouseId
        }));
        renderInventoryAdjustmentRows();
    } catch (err) {
        console.warn('手動新增庫存：倉庫主檔載入失敗，先保留目前表單。', err);
    }
};
window.closeInventoryAdjustment = function() {
    inventoryAdjustmentGeneration++;
    const typeSelect = document.getElementById('inventoryAdjustmentType');
    if (typeSelect) typeSelect.disabled = false;
    document.getElementById('inventoryAdjustmentOverlay')?.classList.remove('active');
};



let inventoryQuantityEditingId='';
let inventoryQuantityEditingWarehouseId='';
let inventoryQuantityPendingOperation=null;
let inventoryQuantitySaveInProgress=false;
let inventoryQuantityEditorGeneration=0;

function inventoryQuantityForWarehouse(item, warehouseId='') {
    const productKey=String(item?.productKey||item?.productId||'').trim();
    if(warehouseId&&productKey){
        return Number(inventoryNumbers(warehouseStockCache.get(warehouseId+'||'+productKey)||{}).onHand||0);
    }
    return Number(inventoryAggregateStock(item||{}).onHand||0);
}

function refreshInventoryQuantityEditorValue() {
    const item=inventoryItemById(inventoryQuantityEditingId);
    if(!item)return;
    const current=inventoryQuantityForWarehouse(item,inventoryQuantityEditingWarehouseId);
    const currentEl=document.getElementById('inventoryQuantityCurrent');
    const target=document.getElementById('inventoryQuantityTarget');
    if(currentEl)currentEl.textContent=String(current);
    if(target)target.value=String(current);
}

window.openInventoryQuantityEditor=async function(inventoryId){
    if(inventoryQuantitySaveInProgress)return;
    if(!canEditPage('inventory'))return;
    const item=inventoryItemById(inventoryId);
    if(!item){alert('找不到這個庫存品項，請重新整理後再試。');return;}
    const productMaster=productMasterForRecord({productId:item.productId||item.productKey||'',itemCode:item.itemCode||'',brand:item.brand||''});
    if(productMaster?.lotTracked||productMaster?.expiryTracked){
        alert('此品項有批號／效期管理，為避免總量與批號明細不一致，請使用批號／效期庫存異動。');
        openInventoryAdjustment('adjustment',item);
        return;
    }

    inventoryQuantityEditingId=inventoryId;
    inventoryQuantityEditingWarehouseId='';
    inventoryQuantityPendingOperation=null;
    const generation=++inventoryQuantityEditorGeneration;
    const editorUid=currentUser?.uid,editorRole=currentUserRole;
    const overlay=document.getElementById('inventorySetQuantityOverlay');
    const label=document.getElementById('inventoryQuantityItemLabel');
    const warehouseRow=document.getElementById('inventoryQuantityWarehouseRow');
    const warehouseSelect=document.getElementById('inventoryQuantityWarehouse');
    const currentEl=document.getElementById('inventoryQuantityCurrent');
    const target=document.getElementById('inventoryQuantityTarget');
    const note=document.getElementById('inventoryQuantityNote');
    const saveButton=document.getElementById('saveInventoryQuantityBtn');

    if(label)label.textContent=`${item.itemCode||'－'}｜${item.itemName||'未命名品項'}｜${item.brand||'未指定廠牌'}`;
    if(warehouseRow)warehouseRow.style.display='none';
    if(warehouseSelect){warehouseSelect.innerHTML='<option value="">讀取中…</option>';warehouseSelect.disabled=true;}
    if(currentEl)currentEl.textContent='讀取中…';
    if(target){target.value='';target.disabled=true;}
    if(note)note.value='';
    if(saveButton){saveButton.disabled=true;saveButton.textContent='讀取中…';}
    overlay?.classList.add('active');

    try{
        await loadWarehouseMaster();
        await loadWarehouseStocksForInventoryPage([item]);
        if(generation!==inventoryQuantityEditorGeneration||editorUid!==currentUser?.uid||editorRole!==currentUserRole||inventoryQuantityEditingId!==inventoryId||!overlay?.classList.contains('active'))return;

        const activeWarehouses=warehouseMasterCache.filter(warehouse=>warehouse.active!==false);
        const productKey=String(item.productKey||item.productId||'').trim();
        const preferredWarehouse=activeWarehouses.find(warehouse=>{
            const stock=warehouseStockCache.get(warehouse.id+'||'+productKey);
            return Number(inventoryNumbers(stock||{}).onHand||0)>0;
        })||defaultWarehouse()||activeWarehouses[0]||null;
        inventoryQuantityEditingWarehouseId=preferredWarehouse?.id||'';

        if(warehouseSelect){
            warehouseSelect.innerHTML=activeWarehouses.map(warehouse=>`<option value="${escapeAttr(warehouse.id)}">${escapeHtml(warehouse.warehouseName||warehouse.id)}</option>`).join('');
            warehouseSelect.value=inventoryQuantityEditingWarehouseId;
            warehouseSelect.disabled=false;
        }
        if(warehouseRow)warehouseRow.style.display=activeWarehouses.length>1?'':'none';
        if(target)target.disabled=false;
        refreshInventoryQuantityEditorValue();
        if(saveButton){saveButton.disabled=false;saveButton.textContent='確認修改';}
    }catch(err){
        if(generation!==inventoryQuantityEditorGeneration||editorUid!==currentUser?.uid||editorRole!==currentUserRole)return;
        if(inventoryQuantityEditingId===inventoryId)closeInventoryQuantityEditor();
        alert('讀取庫存資料失敗：'+(err?.message||err));
    }
};

window.onInventoryQuantityWarehouseChange=function(warehouseId){
    inventoryQuantityEditingWarehouseId=String(warehouseId||'');
    refreshInventoryQuantityEditorValue();
};

window.closeInventoryQuantityEditor=function(){
    inventoryQuantityEditorGeneration++;
    inventoryQuantityPendingOperation=null;
    inventoryQuantityEditingId='';
    inventoryQuantityEditingWarehouseId='';
    document.getElementById('inventorySetQuantityOverlay')?.classList.remove('active');
};

window.saveInventoryQuantity=async function(){
    if(inventoryQuantitySaveInProgress)return;
    if(!canEditPage('inventory'))return alert('您只有庫存查看權限。');
    if(!inventoryQuantityEditingId)return;
    const item=inventoryItemById(inventoryQuantityEditingId);
    if(!item){alert('找不到這個庫存品項，請重新整理後再試。');return;}
    const rawTarget=String(document.getElementById('inventoryQuantityTarget')?.value??'').trim();
    const target=Number(rawTarget);
    if(!rawTarget||!Number.isFinite(target)||target<0){alert('盤點後現有數量必須是 0 或正數。');return;}
    const note=String(document.getElementById('inventoryQuantityNote')?.value||'').trim();
    const warehouseId=inventoryQuantityEditingWarehouseId;
    if(!warehouseId){alert('請選擇盤點倉庫。');return;}
    const actorUid=currentUser?.uid,actorRole=currentUserRole;
    const generation=inventoryQuantityEditorGeneration;
    const sameEditor=()=>generation===inventoryQuantityEditorGeneration&&actorUid===currentUser?.uid&&actorRole===currentUserRole;
    const intent={inventoryId:item.id,productKey:item.productKey||item.productId||'',warehouseId,target,note,actorUid,actorRole};
    if(inventoryQuantityPendingOperation&&JSON.stringify(inventoryQuantityPendingOperation.intent)!==JSON.stringify(intent)){
        alert('上一筆盤點尚待確認，請先以原內容重試；確認原結果後重新開啟視窗再做不同盤點。');return;
    }
    if(!inventoryQuantityPendingOperation)inventoryQuantityPendingOperation={
        intent,request:{item:JSON.parse(JSON.stringify(item)),warehouseId,target,note,operationId:lifecycleRecordId(),
            singleWarehouseFallback:warehouseMasterCache.filter(warehouse=>warehouse.active!==false).length===1}
    };
    const request=inventoryQuantityPendingOperation.request;
    const button=document.getElementById('saveInventoryQuantityBtn');
    let committedResult=null;
    inventoryQuantitySaveInProgress=true;
    if(button){button.disabled=true;button.textContent='儲存中…';}
    try{
        const result=await commitInventoryQuantity(request,{actorUid,actorRole,onStockCommitted:invalidateWarehouseStockCache});
        committedResult=result;
        if(!sameEditor())return;
        closeInventoryQuantityEditor();
        await loadInventory(true);
        if(actorUid!==currentUser?.uid||actorRole!==currentUserRole)return;
        showActionFeedback(result.replayed?'原盤點已完成，已確認結果。':result.delta===0?'庫存數量沒有變更。':`庫存已更新：${result.delta>0?'+':''}${result.delta}`);
    }catch(err){
        if(committedResult&&actorUid===currentUser?.uid&&actorRole===currentUserRole)alert('盤點已完成，但庫存清單更新失敗，請重新整理清單：'+(err?.message||err));
        else if(sameEditor())alert((err.inventoryCountCommitted?'盤點已提交，但畫面更新未完成；請以原內容重試確認：':'盤點結果尚未確認，請以原內容重試，勿更改數量重送：')+(err?.message||err));
    }finally{
        inventoryQuantitySaveInProgress=false;
        if(sameEditor()&&button){button.disabled=false;button.textContent='確認修改';}
    }
};

let inventoryTransferEditingId='';

function activeInventoryWarehouses() {
    return warehouseMasterCache.filter(warehouse=>warehouse.active!==false&&!warehouse.systemCustody);
}

function inventoryWarehouseState(item, warehouseId) {
    const key=String(item?.productKey||item?.productId||'').trim();
    return inventoryNumbers(key ? (warehouseStockCache.get(warehouseId+'||'+key)||{}) : {});
}

window.openInventoryTransfer=async function(inventoryId){
    if(!canManageInventoryStockPolicy()||!canEditPage('inventory'))return alert('只有採購或管理員可發起主倉備貨調撥。');
    const item=inventoryItemById(inventoryId);
    if(!item){alert('找不到這個庫存品項，請重新整理後再試。');return;}
    const productMaster=productMasterForRecord({productId:item.productId||item.productKey||'',itemCode:item.itemCode||'',brand:item.brand||''});
    if(Number(item.transferInTransit||0)>0){alert('此品項尚有調撥途中貨品，請先完成收貨。');return;}

    inventoryTransferEditingId=inventoryId;
    const overlay=document.getElementById('inventoryTransferOverlay');
    const label=document.getElementById('inventoryTransferItemLabel');
    const from=document.getElementById('inventoryTransferFrom');
    const to=document.getElementById('inventoryTransferTo');
    const qty=document.getElementById('inventoryTransferQty');
    const hint=document.getElementById('inventoryTransferHint');
    const saveButton=document.getElementById('saveInventoryTransferBtn');
    if(label)label.textContent=`${item.itemCode||'－'}｜${item.itemName||'未命名品項'}｜${item.brand||'未指定廠牌'}`;
    if(from){from.innerHTML='<option value="">讀取中…</option>';from.disabled=true;}
    if(to){to.innerHTML='<option value="">讀取中…</option>';to.disabled=true;}
    if(qty){qty.value='';qty.disabled=true;}
    if(hint)hint.textContent='正在讀取各倉庫庫存…';
    if(saveButton){saveButton.disabled=true;saveButton.textContent='讀取中…';}
    overlay?.classList.add('active');

    try{
        await loadWarehouseMaster();
        const warehouses=activeInventoryWarehouses();
        if(warehouses.length<2){
            if(inventoryTransferEditingId===inventoryId)closeInventoryTransfer();
            alert('目前只有一個啟用中的倉庫，不需要移動庫存。');
            return;
        }
        await loadWarehouseStocksForInventoryPage([item]);
        if(inventoryTransferEditingId!==inventoryId||!overlay?.classList.contains('active'))return;

        const mainId=defaultWarehouse()?.id||'';
        const source=warehouses.filter(w=>w.id!==mainId).find(warehouse=>{
            const n=inventoryWarehouseState(item,warehouse.id);
            return Number(n.onHand||0)-Number(n.reserved||0)>0;
        })||warehouses.find(w=>w.id!==mainId);
        const target=warehouses.find(w=>w.id===mainId);if(!source||!target)throw Error('請先設定主倉與分倉。');
        const options=warehouses.map(warehouse=>`<option value="${escapeAttr(warehouse.id)}">${escapeHtml(warehouse.warehouseName||warehouse.id)}</option>`).join('');
        if(from){from.innerHTML=warehouses.filter(w=>w.id!==mainId).map(w=>`<option value="${escapeAttr(w.id)}">${escapeHtml(w.warehouseName||w.id)}</option>`).join('');from.value=source.id;from.disabled=false;}
        if(to){to.innerHTML=options;to.value=target.id;to.disabled=true;}
        if(qty)qty.disabled=false;
        if(saveButton){saveButton.disabled=false;saveButton.textContent='發起調回主倉';}
        updateInventoryTransferHint();
    }catch(err){
        if(inventoryTransferEditingId===inventoryId)closeInventoryTransfer();
        alert('讀取倉庫庫存失敗：'+(err?.message||err));
    }
};

window.updateInventoryTransferHint=function(){
    const item=inventoryItemById(inventoryTransferEditingId);
    const fromId=document.getElementById('inventoryTransferFrom')?.value||'';
    const toId=document.getElementById('inventoryTransferTo')?.value||'';
    const hint=document.getElementById('inventoryTransferHint');
    if(!item||!hint)return;
    if(fromId===toId){hint.textContent='來源倉庫與目的倉庫不能相同。';return;}
    const source=inventoryWarehouseState(item,fromId);
    const movable=Math.max(0,Number(source.onHand||0)-Number(source.reserved||0));
    const fromName=activeInventoryWarehouses().find(warehouse=>warehouse.id===fromId)?.warehouseName||'來源倉庫';
    const toName=activeInventoryWarehouses().find(warehouse=>warehouse.id===toId)?.warehouseName||'目的倉庫';
    hint.textContent=`${fromName}：現有 ${source.onHand}、已預留 ${source.reserved}，最多可移動 ${movable}；發起後先保留數量；分倉實際寄出後列為調撥途中，${toName} 點收後入庫，公司總庫存不變。`;
};

window.closeInventoryTransfer=function(){
    inventoryTransferEditingId='';
    document.getElementById('inventoryTransferOverlay')?.classList.remove('active');
};

window.saveInventoryTransfer=async function(){
    if(!inventoryTransferEditingId)return;
    const item=inventoryItemById(inventoryTransferEditingId);
    if(!item){alert('找不到這個庫存品項，請重新整理後再試。');return;}
    const fromWarehouseId=document.getElementById('inventoryTransferFrom')?.value||'';
    const toWarehouseId=document.getElementById('inventoryTransferTo')?.value||'';
    const qty=Number(document.getElementById('inventoryTransferQty')?.value);
    if(!fromWarehouseId||!toWarehouseId||fromWarehouseId===toWarehouseId){alert('請選擇不同的來源倉庫與目的倉庫。');return;}
    if(!Number.isFinite(qty)||qty<=0){alert('移動數量必須大於 0。');return;}
    const key=String(item.productKey||item.productId||'').trim();
    if(!key){alert('此庫存缺少產品識別，請先修正產品主檔。');return;}
    const button=document.getElementById('saveInventoryTransferBtn');
    const operationId=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());
    const state=beginActionButton(button,'調撥中…');
    try{
        const request=await createMainTransferRequest({id:operationId,inventoryId:inventoryTransferEditingId,fromWarehouseId,qty});
        delete button.dataset.operationId;
        invalidateWarehouseStockCache(key,fromWarehouseId);invalidateWarehouseStockCache(key,toWarehouseId);
        closeInventoryTransfer();
        try{await loadInventory(true);await loadMainTransferRequests(true);}
        catch(err){showActionFeedback('調回需求已儲存，但清單更新失敗；請重新開啟庫存頁確認。','warning');return;}
        showActionFeedback(request.status==='PENDING'
            ?'調回需求已建立並保留數量；倉管確認寄出後，主倉再點收。'
            :`此調回需求已存在，目前${request.status==='CANCELLED'?'已取消':'已寄出'}，未重複保留庫存。`);
    }catch(err){alert('移動庫存失敗：'+(err?.message||err));}
    finally{endActionButton(button,state);}

};

window.downloadInventoryImportTemplate=async function(){
    try{await ensureXlsxLoaded();}catch(err){alert(err.message);return;}
    const rows=[{'貨號':'5000006','倉庫':'台北倉','數量':10,'實際單位成本':0,'批號':'','效期':'','備註':'範例列，可刪除'}];
    const ws=XLSX.utils.json_to_sheet(rows),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'庫存匯入');XLSX.writeFile(wb,'又鑫_庫存批次匯入範本.xlsx');
};
window.previewInventoryExcelImport=async function(input){
    if(inventoryAdjustmentSaveInProgress)return;
    const generation=inventoryAdjustmentGeneration,importUid=currentUser?.uid,importRole=currentUserRole;
    const file=input?.files?.[0];if(!file)return;
    try{
        if(typeof XLSX==='undefined')throw new Error('Excel 元件尚未載入');
        await loadSupplierWarehouseMasters();
        const data=await file.arrayBuffer(),wb=XLSX.read(data,{type:'array'}),ws=wb.Sheets[wb.SheetNames[0]],rows=XLSX.utils.sheet_to_json(ws,{defval:''});
        if(!rows.length)throw new Error('Excel 沒有資料');
        const parsed=[],errors=[];
        for(let idx=0;idx<rows.length;idx++){
            const row=rows[idx],code=String(row['貨號']||'').trim(),warehouseName=String(row['倉庫']||'').trim(),qty=Number(row['數量']||0);
            if(!code||!warehouseName||!Number.isFinite(qty)||qty===0){errors.push('第 '+(idx+2)+' 列：貨號、倉庫、數量必填');continue;}
            const product=await findProductByCode(code);if(!product){errors.push('第 '+(idx+2)+' 列：產品主檔找不到 '+code);continue;}
            const warehouse=warehouseMasterCache.find(w=>w.active!==false&&String(w.warehouseName||'').trim()===warehouseName);
            if(!warehouse){errors.push('第 '+(idx+2)+' 列：找不到倉庫 '+warehouseName);continue;}
            parsed.push({itemCode:product.model||code,itemName:product.nameCn||product.nameEn||'',brand:resolveBrandName(product.brand||''),productId:product.productId||stableProductId(product),warehouseId:warehouse.id,qty:qty,unitCost:String(row['實際單位成本'] ?? '').trim() === '' ? '' : Number(row['實際單位成本']),lotNo:String(row['批號']||'').trim(),expiryDate:String(row['效期']||'').trim()});
        }
        if(!parsed.length)throw new Error(errors.join('\n')||'沒有可匯入資料');
        if(inventoryAdjustmentSaveInProgress||generation!==inventoryAdjustmentGeneration||importUid!==currentUser?.uid||importRole!==currentUserRole)return;
        inventoryAdjustmentGeneration++;
        inventoryAdjustmentRows=parsed;document.getElementById('inventoryAdjustmentType').value='initial';renderInventoryAdjustmentRows();document.getElementById('inventoryAdjustmentOverlay').classList.add('active');
        let msg='已讀取 '+parsed.length+' 筆，請確認內容後按「確認儲存」。';if(errors.length)msg+='\n另有 '+errors.length+' 筆錯誤：\n'+errors.slice(0,10).join('\n');alert(msg);
    }catch(err){alert('Excel 匯入檢查失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');}
    finally{input.value='';}
};

window.addInventoryAdjustmentRow = function() {
    if(inventoryAdjustmentSaveInProgress)return;
    inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', warehouseId:defaultWarehouse()?.id||'', qty:0, unitCost:'', lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.removeInventoryAdjustmentRow = function(idx) {
    if(inventoryAdjustmentSaveInProgress)return;
    inventoryAdjustmentRows.splice(idx,1);
    if (!inventoryAdjustmentRows.length) inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', warehouseId:defaultWarehouse()?.id||'', qty:0, lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.onInventoryAdjustmentCode = async function(idx, value) {
    if(inventoryAdjustmentSaveInProgress)return;
    const generation=inventoryAdjustmentGeneration,requestedUid=currentUser?.uid,requestedRole=currentUserRole;
    if (!inventoryAdjustmentRows[idx]) return;
    const requestedCode = String(value||'').trim();
    const preferredBrand = resolveBrandName(inventoryAdjustmentRows[idx].brand || '');
    inventoryAdjustmentRows[idx] = {
        ...inventoryAdjustmentRows[idx],
        itemCode: requestedCode,
        itemName: '',
        brand: preferredBrand,
        brandId: brandIdForName(preferredBrand),
        productId: ''
    };
    const match = requestedCode ? await findProductByCode(requestedCode, preferredBrand) : null;
    if(inventoryAdjustmentSaveInProgress||generation!==inventoryAdjustmentGeneration||requestedUid!==currentUser?.uid||requestedRole!==currentUserRole)return;
    if (!inventoryAdjustmentRows[idx] || String(inventoryAdjustmentRows[idx].itemCode||'').trim() !== requestedCode) return;
    if (match) {
        inventoryAdjustmentRows[idx].itemCode = match.model || requestedCode;
        inventoryAdjustmentRows[idx].itemName = match.nameCn || match.nameEn || '';
        inventoryAdjustmentRows[idx].brand = resolveBrandName(match.brand || '');
        inventoryAdjustmentRows[idx].brandId = match.brandId || brandIdForName(match.brand || '');
        inventoryAdjustmentRows[idx].productId = match.productId || stableProductId(match);
    }
    renderInventoryAdjustmentRows();
};

window.updateInventoryAdjustmentRow = function(idx, field, value) {
    if(inventoryAdjustmentSaveInProgress)return;
    if (!inventoryAdjustmentRows[idx]) return;
    inventoryAdjustmentRows[idx][field] = ['qty','unitCost'].includes(field) ? (field==='unitCost' && String(value).trim()==='' ? '' : Number(value||0)) : String(value||'').trim();
    if (field === 'brand') {
        inventoryAdjustmentRows[idx].brand = resolveBrandName(value);
        inventoryAdjustmentRows[idx].brandId = brandIdForName(value);
        if (inventoryAdjustmentRows[idx].itemCode) onInventoryAdjustmentCode(idx, inventoryAdjustmentRows[idx].itemCode);
    }
};

function renderInventoryAdjustmentRows() {
    const body = document.getElementById('inventoryAdjustmentRows');
    if (!body) return;
    const warehouseOptions = warehouseMasterCache
        .filter(w => w.active !== false)
        .map(w => `<option value="${escapeAttr(w.id)}">${escapeHtml(w.warehouseName || w.id)}</option>`)
        .join('');

    body.innerHTML = inventoryAdjustmentRows.map((row, idx) => `
      <tr class="inventory-adjustment-row">
        <td data-label="貨號"><input type="text" list="priceModelList" value="${escapeAttr(row.itemCode || '')}" onchange="onInventoryAdjustmentCode(${idx},this.value)" placeholder="輸入產品主檔貨號"></td>
        <td data-label="品名"><input class="inventory-adjustment-readonly" type="text" value="${escapeAttr(row.itemName || '')}" readonly placeholder="自動帶入"></td>
        <td data-label="廠牌"><input class="inventory-adjustment-readonly" type="text" value="${escapeAttr(row.brand || '')}" readonly placeholder="自動帶入"></td>
        <td data-label="倉庫"><select onchange="updateInventoryAdjustmentRow(${idx},'warehouseId',this.value)"><option value="">請選倉庫</option>${warehouseOptions}</select></td>
        <td data-label="數量"><input type="number" step="any" value="${row.qty || ''}" onchange="updateInventoryAdjustmentRow(${idx},'qty',this.value)" inputmode="decimal" placeholder="本次入庫數量"></td>
        <td data-label="實際單位成本"><input type="number" min="0" step="any" value="${row.unitCost ?? ''}" ${canCreatePurchaseOrderCapability() ? '' : 'disabled'} onchange="updateInventoryAdjustmentRow(${idx},'unitCost',this.value)" inputmode="decimal" placeholder="${canCreatePurchaseOrderCapability() ? '必填；零成本請填 0' : '由採購補成本'}"></td>
        <td data-label="批號（選填）"><input type="text" value="${escapeAttr(row.lotNo || '')}" onchange="updateInventoryAdjustmentRow(${idx},'lotNo',this.value)" placeholder="無批號可留白"></td>
        <td data-label="效期（選填）"><input type="date" value="${escapeAttr(row.expiryDate || '')}" onchange="updateInventoryAdjustmentRow(${idx},'expiryDate',this.value)"></td>
        <td data-label="操作"><button type="button" class="btn-small btn-danger" onclick="removeInventoryAdjustmentRow(${idx})">刪除這筆</button></td>
      </tr>`).join('');

    [...body.querySelectorAll('tr')].forEach((tr, idx) => {
        const select = tr.querySelector('select');
        if (select && inventoryAdjustmentRows[idx]?.warehouseId) select.value = inventoryAdjustmentRows[idx].warehouseId;
    });
}
window.saveInventoryAdjustmentBatch = async function() {
    if(inventoryAdjustmentSaveInProgress)return;
    if(!canEditPage('inventory'))return alert('您只有庫存查看權限。');
    const type=document.getElementById('inventoryAdjustmentType').value;
    const rows=inventoryAdjustmentRows.filter(row=>row.itemCode&&Number(row.qty)).map(row=>{
        row.operationId ||= lifecycleRecordId();
        return JSON.parse(JSON.stringify(row));
    });
    if(!rows.length){alert('請至少輸入一筆貨號與數量。');return;}
    if(rows.some(row=>!row.warehouseId)){alert('請為每筆庫存異動選擇倉庫。');return;}
    if(type==='initial'&&canCreatePurchaseOrderCapability()&&rows.some(row=>String(row.unitCost ?? '').trim()===''||!Number.isFinite(Number(row.unitCost))||Number(row.unitCost)<0)){alert('手動新增庫存請填寫每筆實際單位成本。');return;}
    const actorUid=currentUser?.uid,actorRole=currentUserRole,actorName=currentUserName||currentUser?.email||'';
    const generation=inventoryAdjustmentGeneration;
    const isCurrent=()=>generation===inventoryAdjustmentGeneration&&actorUid===currentUser?.uid&&actorRole===currentUserRole;
    const button=document.getElementById('saveInventoryAdjustmentBatchBtn');
    inventoryAdjustmentSaveInProgress=true;
    if(button){button.disabled=true;button.textContent='儲存中…';}
    const results=[];
    try{
        for(const row of rows){
            if(!isCurrent())break;
            try{
                const match=(row.productId && {productId:row.productId})
                    || findPriceItemByCodeValue(row.itemCode, row.brand);
                if(!match)throw new Error(`產品主檔找不到唯一產品：${row.brand ? row.brand+' / ' : ''}${row.itemCode}`);
                await commitManualInventoryAdjustment({type,productKey:match.productId||stableProductId(match),warehouseId:row.warehouseId,operationId:row.operationId,row},
                    {actorUid,actorRole,actorName,onStockCommitted:invalidateWarehouseStockCache});
                results.push({row,ok:true});
            }catch(e){
                results.push({row,ok:false,error:e?.message||String(e)});
            }
        }
        if(!isCurrent())return;
        const succeeded=results.filter(result=>result.ok);
        const failed=results.filter(result=>!result.ok);
        if(succeeded.length)loadInventory(true).catch(refreshErr=>console.error('庫存異動後背景刷新失敗，已提交資料不回滾',refreshErr));
        if(!failed.length){
            closeInventoryAdjustment();
            alert(`已完成 ${succeeded.length} 筆庫存異動。`);
        }else{
            // 已成功的品項已從表單移除；未知回覆的列保留原操作 ID，避免重複入庫／扣庫存。
            inventoryAdjustmentRows=failed.map(result=>result.row);
            renderInventoryAdjustmentRows();
            const details=failed.slice(0,8).map(result=>`${result.row.itemCode||'未命名品項'}：${result.error}`).join('\n');
            alert(`庫存異動部分完成：成功 ${succeeded.length} 筆，失敗或待確認 ${failed.length} 筆。\n成功的品項已從表單移除；待確認的列請先以原內容重試。更改內容前請先核對原作業結果。\n\n${details}`);
        }
    }finally{
        inventoryAdjustmentSaveInProgress=false;
        if(actorUid===currentUser?.uid&&actorRole===currentUserRole&&button){button.disabled=false;button.textContent='確認儲存';}
    }
};
function inventoryProductKey(record) {
    return String(record?.productId || (record?.itemCode ? `code:${normalizeHistoryItemCode(record.itemCode)}` : '')).trim();
}
function inventoryRefFor(record) {
    const key = inventoryProductKey(record);
    return key ? db.collection('inventory').doc(encodeURIComponent(key)) : null;
}
function inventoryNumbers(data = {}) {
    if (!globalThis.YushinInventory?.normalizeStock) {
        throw new Error('Inventory core 未載入，無法計算庫存狀態。');
    }
    return globalThis.YushinInventory.normalizeStock(data);
}
function inventoryMovementRecord(type, qty, orderId, productKey, actor, extra = {}) {
    return { actorUid:currentUser?.uid||'',ownerUid:currentUser?.uid||'',salesCode:currentUserCode||'',type, qty: Number(qty || 0), productKey, sourceType: DOCUMENT_TYPES.ORDER, sourceId: orderId, createdAt: new Date().toISOString(), createdBy: actor, ...extra };
}

function inventoryReservationPayload(orderId, order, reservedQty, status = 'active') {
    return {
        orderId,
        orderNo: order.orderNo || order.quoteNo || orderId,
        productKey: inventoryProductKey(order),
        itemCode: order.itemCode || '',
        itemName: order.itemName || '',
        customerName: order.customerName || '',
        salesCode: order.salesCode || salesCodeForName(order.salesName),
        salesName: order.salesName || '',
        orderDate: order.orderDate || '',
        quantity: Math.max(0, Number(reservedQty || 0)),
        status,
        updatedAt: new Date().toISOString()
    };
}

window.openInventoryReservationDetails = async function(productKey) {
    const overlay = document.getElementById('inventoryReservationOverlay');
    const body = document.getElementById('inventoryReservationBody');
    const title = document.getElementById('inventoryReservationTitle');
    if (!overlay || !body) return;
    body.innerHTML = '<tr><td colspan="7">讀取中…</td></tr>';
    if (title) title.innerText = '已預留訂單';
    overlay.classList.add('active');
    try {
        const snapshot = await firestoreReadWithTimeout(
            (canReceiveInventoryCapability() ? db.collection('inventoryReservations') : db.collection('inventoryReservations').where('ownerUid','==',currentUser.uid)).where('productKey', '==', productKey).where('status','==','active').limit(100).get(),
            '庫存預留明細'
        );
        const rows = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(item => Number(item.quantity || 0) > 0)
            .sort((x, y) => String(y.orderDate || '').localeCompare(String(x.orderDate || '')));
        body.innerHTML = rows.length ? rows.map(item => `<tr>
            <td>${escapeHtml(item.orderNo || item.orderId || item.id)}</td>
            <td>${escapeHtml(item.customerName || '')}</td>
            <td>${escapeHtml(item.itemCode || '')}</td>
            <td>${escapeHtml(item.itemName || '')}</td>
            <td>${Number(item.quantity || 0)}</td>
            <td>${escapeHtml(item.salesName || item.salesCode || '')}</td>
            <td>${escapeHtml(item.orderDate || '')}</td>
        </tr>`).join('') : '<tr><td colspan="7" style="color:#888;">目前沒有有效預留訂單。</td></tr>';
    } catch (err) {
        body.innerHTML = `<tr><td colspan="7">讀取失敗：${escapeHtml(err.message || String(err))}</td></tr>`;
    }
};

window.closeInventoryReservationDetails = function() {
    document.getElementById('inventoryReservationOverlay')?.classList.remove('active');
};
