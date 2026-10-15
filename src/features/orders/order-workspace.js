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
function fefoLots(stock){return [...(stock.lots||[])].filter(l=>Number(l.qty||0)>0).sort((a,b)=>String(a.expiryDate||'9999-12-31').localeCompare(String(b.expiryDate||'9999-12-31')));}
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
    await loadWarehouseMaster();
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
 if(reset){inventoryCursor=null;inventoryHasMore=true;warehouseStockCache=new Map();if(!inventoryCache.length){const cached=readAppDataCache('inventory');if(cached?.records?.length){inventoryCache=cached.records;renderInventoryList();}}} inventoryLoading=true;
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

 await loadWarehouseStocksForInventoryPage();
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
 const values=[record.itemCode,record.itemName,record.brand,record.productKey,record.productId,
   ...(Array.isArray(record.lots)?record.lots.flatMap(lot=>[lot.lotNo,lot.expiryDate]):[])];
 return values.some(value=>normalizeFullHistorySearchValue(value).includes(needle));
}
window.scheduleInventorySearch=function(){clearTimeout(inventorySearchTimer);const keyword=document.getElementById('inventorySearch')?.value||'';if(!normalizeFullHistorySearchValue(keyword)){inventorySearchActive=false;inventorySearchResults=[];const status=document.getElementById('inventorySearchStatus');if(status)status.textContent='';resetBusinessProductSearchResults();renderInventoryList();return;}inventorySearchTimer=scheduleListSearch(inventorySearchTimer,()=>runInventoryUnifiedSearch());};
window.runInventoryUnifiedSearchNow=function(){clearTimeout(inventorySearchTimer);return runInventoryUnifiedSearch();};
async function runInventoryUnifiedSearch(){const keyword=document.getElementById('inventorySearch')?.value||'';if(!normalizeFullHistorySearchValue(keyword)){resetBusinessProductSearchResults();return;}await Promise.allSettled([runInventorySearch(),window.searchBusinessProducts(keyword)]);}
async function runInventorySearch(){
 const keyword=document.getElementById('inventorySearch')?.value||'';
 const normalized=normalizeFullHistorySearchValue(keyword);
 const status=document.getElementById('inventorySearchStatus');
 if(!normalized){inventorySearchActive=false;inventorySearchResults=[];if(status)status.textContent='';renderInventoryList();return;}
 if(inventorySearchLoading)return;
 inventorySearchLoading=true;inventorySearchActive=true;inventorySearchResults=[];
 const results=new Map();
 if(status)status.textContent='正在搜尋全部庫存…';
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
       checked+=snapshot.size;
       snapshot.docs.forEach(doc=>{
         const row={id:doc.id,...doc.data()};
         if(inventoryRecordMatches(row,keyword))results.set(row.id,row);
       });
       inventorySearchResults=[...results.values()].sort((a,b)=>String(b.updatedAt||'').localeCompare(String(a.updatedAt||'')));
       renderInventoryList();
       if(status)status.textContent=`全庫搜尋中：已檢查 ${checked} 筆候選資料，找到 ${results.size} 筆…`;
       if(snapshot.size<DEFAULT_LIST_LIMIT)break;
       cursor=snapshot.docs[snapshot.docs.length-1];
       await Promise.resolve();
     }
   }
   if(status)status.textContent=`全庫搜尋完成：找到 ${results.size} 筆`;
 }catch(err){
   console.error('庫存全庫搜尋失敗：',err);
   if(status)status.textContent='搜尋失敗，請重試';
 }finally{inventorySearchLoading=false;renderInventoryList();}
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
 const productMaster=productMasterForRecord({productId:x.productId||productKey,itemCode:x.itemCode||'',brand:x.brand||''}),showLotDetail=!!(productMaster?.lotTracked||productMaster?.expiryTracked||lots.length),lotHtml=showLotDetail?(lots.slice(0,3).map(l=>`${escapeHtml(l.lotNo||'無批號')} ${escapeHtml(l.expiryDate||'')} ${lotStatus(l)?'['+lotStatus(l)+']':''}`).join('<br>')||'尚無批號／效期資料'):'－',reserved=n.reserved>0?`<button type="button" class="link-button inventory-reserved-link" onclick="openInventoryReservationDetails(${inlineJsValue(x.productKey||x.id||'')})">${n.reserved}</button>`:'0';
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
    if (!canEditPage('inventory')) return;
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
    const typeSelect = document.getElementById('inventoryAdjustmentType');
    if (typeSelect) typeSelect.disabled = false;
    document.getElementById('inventoryAdjustmentOverlay')?.classList.remove('active');
};



let inventoryQuantityEditingId='';
let inventoryQuantityEditingWarehouseId='';

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
        if(inventoryQuantityEditingId!==inventoryId||!overlay?.classList.contains('active'))return;

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
        if(inventoryQuantityEditingId===inventoryId)closeInventoryQuantityEditor();
        alert('讀取庫存資料失敗：'+(err?.message||err));
    }
};

window.onInventoryQuantityWarehouseChange=function(warehouseId){
    inventoryQuantityEditingWarehouseId=String(warehouseId||'');
    refreshInventoryQuantityEditorValue();
};

window.closeInventoryQuantityEditor=function(){
    inventoryQuantityEditingId='';
    inventoryQuantityEditingWarehouseId='';
    document.getElementById('inventorySetQuantityOverlay')?.classList.remove('active');
};

window.saveInventoryQuantity=async function(){
    if (!canEditPage('inventory')) return alert('您只有庫存查看權限。');
    if(!inventoryQuantityEditingId)return;
    const item=inventoryItemById(inventoryQuantityEditingId);
    if(!item){alert('找不到這個庫存品項，請重新整理後再試。');return;}
    const target=Number(document.getElementById('inventoryQuantityTarget')?.value);
    if(!Number.isFinite(target)||target<0){alert('盤點後現有數量必須是 0 或正數。');return;}
    const note=String(document.getElementById('inventoryQuantityNote')?.value||'').trim();
    const key=String(item.productKey||item.productId||'').trim();
    if(!key){alert('此庫存缺少產品識別，請先修正產品主檔。');return;}
    const warehouseId=inventoryQuantityEditingWarehouseId;
    const ref=db.collection('inventory').doc(item.id||encodeURIComponent(key));
    const whRef=warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key)):null;
    const button=document.getElementById('saveInventoryQuantityBtn');
    if(button){button.disabled=true;button.textContent='儲存中…';}
    let appliedDelta=0;
    const adjustmentId=lifecycleRecordId();
    try{
        await runRoleTransaction(async tx=>{
            const invSnap=await tx.get(ref);
            if(!invSnap.exists)throw new Error('庫存資料已不存在，請重新整理。');
            const whSnap=whRef?await tx.get(whRef):null;
            const old=invSnap.data()||{};
            const n=inventoryNumbers(old);
            const wh=inventoryNumbers(whSnap?.exists?whSnap.data():{});
            const singleWarehouseFallback=!!whRef&&!whSnap?.exists&&warehouseMasterCache.filter(warehouse=>warehouse.active!==false).length===1;
            const effectiveWarehouse=singleWarehouseFallback?n:wh;
            const current=whRef?Number(effectiveWarehouse.onHand||0):Number(n.onHand||0);
            const delta=target-current;
            appliedDelta=delta;
            if(delta===0)return;
            if(!warehouseId)throw new Error('請選擇盤點倉庫。');
            const lotQuery=await firestoreReadWithTimeout(db.collection('inventoryLots').where('productKey','==',key).where('warehouseId','==',warehouseId).limit(201).get(),'盤點批次');
            if(lotQuery.size>200)throw new Error('批次超過安全處理上限。');
            const lotSnaps=await Promise.all(lotQuery.docs.map(doc=>tx.get(doc.ref)));
            const currentLots=lotSnaps.filter(doc=>doc.exists).map(doc=>({...doc.data(),id:doc.id}));
            const balanceRef=db.collection('inventoryLots').doc(adjustmentId+'-balance');
            const addedRef=db.collection('inventoryLots').doc(adjustmentId+'-added');
            const balanceSnap=await tx.get(balanceRef),addedSnap=await tx.get(addedRef);
            if(balanceSnap.exists||addedSnap.exists)throw new Error('盤點操作識別碼衝突，請重新開啟盤點視窗。');
            const lotPlan=YushinInventory.quantityAdjustmentLots(currentLots,current,target,effectiveWarehouse.reserved,balanceRef.id,addedRef.id);
            const now=new Date().toISOString();
            const nextOnHand=Number(n.onHand||0)+delta;
            if(nextOnHand<0)throw new Error('調整後總庫存不可小於 0。');
            const canonicalBrand=resolveBrandName(item.brand||old.brand||'');
            const nextInventory={...old,productKey:key,productId:item.productId||old.productId||key,itemCode:item.itemCode||old.itemCode||'',itemName:item.itemName||old.itemName||'',brand:canonicalBrand,brandId:item.brandId||old.brandId||brandIdForName(canonicalBrand),onHand:nextOnHand,reserved:n.reserved,incoming:n.incoming,updatedAt:now};
            nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
            for(const lot of lotPlan.lots){
                const oldLot=currentLots.find(row=>row.id===lot.id);
                const lotRef=db.collection('inventoryLots').doc(lot.id);
                if(oldLot){
                    if(Number(oldLot.remainingQty??oldLot.qty)!==lot.remainingQty)tx.update(lotRef,{remainingQty:lot.remainingQty,updatedAt:now});
                }else tx.set(lotRef,{productKey:key,productId:item.productId||old.productId||key,warehouseId,lotNo:'',expiryDate:'',receivedQty:lot.receivedQty,remainingQty:lot.remainingQty,unbatched:true,sourceType:lot.id===balanceRef.id?'MANUAL_STOCK_BALANCE':'MANUAL_ADJUSTMENT',sourceId:adjustmentId,receivedAt:now,createdBy:currentUserName||currentUser?.email||''});
            }
            tx.set(ref,nextInventory,{merge:true});
            if(whRef){
                tx.set(whRef,{warehouseId,productKey:key,productId:item.productId||old.productId||key,itemCode:item.itemCode||old.itemCode||'',itemName:item.itemName||old.itemName||'',brand:canonicalBrand,brandId:item.brandId||old.brandId||brandIdForName(canonicalBrand),onHand:target,reserved:effectiveWarehouse.reserved,incoming:effectiveWarehouse.incoming,updatedAt:now},{merge:true});
            }
            tx.set(db.collection('inventoryMovements').doc(),{type:'adjustment',qty:delta,productKey:key,productId:item.productId||old.productId||key,warehouseId,itemCode:item.itemCode||old.itemCode||'',itemName:item.itemName||old.itemName||'',brand:canonicalBrand,brandId:item.brandId||old.brandId||brandIdForName(canonicalBrand),sourceType:'manual',sourceId:adjustmentId,operation:'quantity-editor',lotAllocations:lotPlan.allocations,lotIds:lotPlan.lots.filter(lot=>!currentLots.some(row=>row.id===lot.id)).map(lot=>lot.id),note,createdAt:now,createdBy:currentUserName||currentUser?.email||''});
        });
        if(appliedDelta!==0)invalidateWarehouseStockCache(key,warehouseId);
        closeInventoryQuantityEditor();
        await loadInventory(true);
        showActionFeedback(appliedDelta===0?'庫存數量沒有變更。':`庫存已更新：${appliedDelta>0?'+':''}${appliedDelta}`);
    }catch(err){
        alert('修改庫存失敗：'+(err?.message||err));
    }finally{
        if(button){button.disabled=false;button.textContent='確認修改';}
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
        await createMainTransferRequest({id:operationId,inventoryId:inventoryTransferEditingId,fromWarehouseId,qty});
        delete button.dataset.operationId;
        invalidateWarehouseStockCache(key,fromWarehouseId);invalidateWarehouseStockCache(key,toWarehouseId);
        closeInventoryTransfer();await loadInventory(true);await loadMainTransferRequests(true);
        showActionFeedback('調回需求已建立並保留數量；倉管確認寄出後，主倉再點收。');
    }catch(err){alert('移動庫存失敗：'+(err?.message||err));}
    finally{endActionButton(button,state);}

};

window.downloadInventoryImportTemplate=async function(){
    try{await ensureXlsxLoaded();}catch(err){alert(err.message);return;}
    const rows=[{'貨號':'5000006','倉庫':'台北倉','數量':10,'實際單位成本':0,'批號':'','效期':'','備註':'範例列，可刪除'}];
    const ws=XLSX.utils.json_to_sheet(rows),wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,'庫存匯入');XLSX.writeFile(wb,'又鑫_庫存批次匯入範本.xlsx');
};
window.previewInventoryExcelImport=async function(input){
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
        inventoryAdjustmentRows=parsed;document.getElementById('inventoryAdjustmentType').value='initial';renderInventoryAdjustmentRows();document.getElementById('inventoryAdjustmentOverlay').classList.add('active');
        let msg='已讀取 '+parsed.length+' 筆，請確認內容後按「確認儲存」。';if(errors.length)msg+='\n另有 '+errors.length+' 筆錯誤：\n'+errors.slice(0,10).join('\n');alert(msg);
    }catch(err){alert('Excel 匯入檢查失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');}
    finally{input.value='';}
};

window.addInventoryAdjustmentRow = function() {
    inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', warehouseId:defaultWarehouse()?.id||'', qty:0, unitCost:'', lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.removeInventoryAdjustmentRow = function(idx) {
    inventoryAdjustmentRows.splice(idx,1);
    if (!inventoryAdjustmentRows.length) inventoryAdjustmentRows.push({ itemCode:'', itemName:'', brand:'', warehouseId:defaultWarehouse()?.id||'', qty:0, lotNo:'', expiryDate:'' });
    renderInventoryAdjustmentRows();
};

window.onInventoryAdjustmentCode = async function(idx, value) {
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
    const type=document.getElementById('inventoryAdjustmentType').value;
    const rows=inventoryAdjustmentRows.filter(row=>row.itemCode&&Number(row.qty));
    if(!rows.length){alert('請至少輸入一筆貨號與數量。');return;}
    if(warehouseMasterCache.length && rows.some(row=>!row.warehouseId)){alert('請為每筆庫存異動選擇倉庫。');return;}
    if(type==='initial'&&canCreatePurchaseOrderCapability()&&rows.some(row=>String(row.unitCost ?? '').trim()===''||!Number.isFinite(Number(row.unitCost))||Number(row.unitCost)<0)){alert('手動新增庫存請填寫每筆實際單位成本。');return;}
    const actor=currentUserName||currentUser?.email||'';
    const button=document.getElementById('saveInventoryAdjustmentBatchBtn');
    if(button){button.disabled=true;button.textContent='儲存中…';}
    const results=[];
    for(const row of rows){
      try{
        const match=(row.productId && priceList.find(item => item.productId === row.productId))
            || findPriceItemByCodeValue(row.itemCode, row.brand);
        if(!match) throw new Error(`產品主檔找不到唯一產品：${row.brand ? row.brand + ' / ' : ''}${row.itemCode}`);
        let delta=Number(row.qty||0);
        if(type==='scrap') delta=-Math.abs(delta);
        const key=match.productId||stableProductId(match);
        const ref=db.collection('inventory').doc(encodeURIComponent(key));
        const whRef=row.warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(row.warehouseId,key)):null;
        await runRoleTransaction(async tx=>{
          const invSnap=await tx.get(ref);
          const whSnap=whRef?await tx.get(whRef):null;
          const old=invSnap.exists?invSnap.data():{}, n=inventoryNumbers(old);
          const wh=inventoryNumbers(whSnap?.exists?whSnap.data():{});
          // warehouseStocks 是實際庫存唯一真相；inventory 只維持總覽快取。
          if(wh.onHand+delta<0) throw new Error(`${row.itemCode} 異動後分倉庫存不可小於 0`);

          let lots=[...(old.lots||[])];
          if(row.lotNo||row.expiryDate){
            const li=lots.findIndex(l=>(l.lotNo||'')===row.lotNo&&(l.expiryDate||'')===row.expiryDate);
            if(li>=0) lots[li]={...lots[li],qty:Number(lots[li].qty||0)+delta};
            else lots.push({lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',qty:delta});
          }
          const now=new Date().toISOString();
          {
            const canonicalBrand=resolveBrandName(match.brand||row.brand||'');
            const nextInventory={...old,productKey:key,productId:key,itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:canonicalBrand,brandId:match.brandId||row.brandId||brandIdForName(canonicalBrand),onHand:n.onHand+delta,reserved:n.reserved,incoming:n.incoming,lots,updatedAt:now};
            nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
            tx.set(ref,nextInventory,{merge:true});
          }
          if(whRef){
            const canonicalBrand=resolveBrandName(match.brand||row.brand||'');
            tx.set(whRef,{warehouseId:row.warehouseId,productKey:key,productId:key,itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:canonicalBrand,brandId:match.brandId||row.brandId||brandIdForName(canonicalBrand),onHand:wh.onHand+delta,reserved:wh.reserved,incoming:wh.incoming,updatedAt:now},{merge:true});
          }
          let authoritativeLotId='';
          if(type==='initial'&&delta>0){
            const lotRef=db.collection('inventoryLots').doc();
            authoritativeLotId=lotRef.id;
            tx.set(lotRef,{productKey:key,productId:key,warehouseId:row.warehouseId||'',lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',receivedQty:delta,remainingQty:delta,sourceType:'INITIAL_STOCK',sourceId:'',receivedAt:now,createdBy:actor});
            tx.set(db.collection('inventoryLotCosts').doc(lotRef.id),{lotId:lotRef.id,productKey:key,productId:key,warehouseId:row.warehouseId||'',...(canCreatePurchaseOrderCapability() ? {unitCost:Number(row.unitCost)} : {costPending:true}),sourceType:'INITIAL_STOCK',sourceId:'',createdAt:now,createdBy:actor});
          }
          const movementBrand=resolveBrandName(match.brand||row.brand||'');
          tx.set(db.collection('inventoryMovements').doc(),{type,qty:delta,productKey:key,productId:key,warehouseId:row.warehouseId||'',itemCode:match.model||row.itemCode,itemName:row.itemName||match.nameCn||match.nameEn||'',brand:movementBrand,brandId:match.brandId||row.brandId||brandIdForName(movementBrand),lotNo:row.lotNo||'',expiryDate:row.expiryDate||'',lotId:authoritativeLotId,sourceType:'manual',sourceId:'',createdAt:now,createdBy:actor});
        });
        if(row.warehouseId) invalidateWarehouseStockCache(key,row.warehouseId);
        results.push({row,ok:true});
      }catch(e){
        results.push({row,ok:false,error:e?.message||String(e)});
      }
    }
    const succeeded=results.filter(result=>result.ok);
    const failed=results.filter(result=>!result.ok);
    if(succeeded.length){
      loadInventory(true).catch(refreshErr => console.error('庫存異動後背景刷新失敗', refreshErr));
    }
    if(!failed.length){
      closeInventoryAdjustment();
      alert(`已完成 ${succeeded.length} 筆庫存異動。`);
    }else{
      // 已成功的列直接從表單移除，避免使用者看到「部分失敗」後整批重按造成重複入庫／重複扣庫存。
      inventoryAdjustmentRows=failed.map(result=>result.row);
      renderInventoryAdjustmentRows();
      const details=failed.slice(0,8).map(result=>`${result.row.itemCode||'未命名品項'}：${result.error}`).join('\n');
      alert(`庫存異動部分完成：成功 ${succeeded.length} 筆，失敗 ${failed.length} 筆。\n成功的品項已從表單移除，請只修正並重試畫面中保留的失敗品項。${details?'\n\n'+details:''}`);
    }
    if(button){button.disabled=false;button.textContent='確認儲存';}
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
async function reserveSingleOrderItem(orderId, order, item, itemIndex, actorUid = currentUser?.uid) {
    const itemId=String(item.itemId||`item-${itemIndex+1}`);
    if(!globalThis.YushinReservation?.planReservation){
        throw new Error('Reservation core 未載入，無法計算庫存預留。');
    }
    const orderRef=db.collection('orders').doc(orderId);
    const syncUid=actorUid;
    const actor=currentUserName||currentUser?.email||'';
    let result,stockToInvalidate=null;
    let releasedStock=null;

    await runRoleTransaction(async tx=>{
        // Read the current source in every retry. Never publish a caller's full-item snapshot.
        const orderSnap=await tx.get(orderRef);
        if(currentUser?.uid!==syncUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
        if(!orderSnap.exists)throw new Error('訂單已不存在，無法同步庫存。');
        order={id:orderId,...orderSnap.data()};
        if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消／作廢的訂單不可同步庫存。');
        itemIndex=(order.items||[]).findIndex((row,index)=>String(row.itemId||`item-${index+1}`)===itemId);
        if(itemIndex<0)throw new Error('訂單品項已變更，請重新讀取後重試同步。');
        item={...order.items[itemIndex],itemId};
        if(order.inventoryReservationStatus==='completed'){result=item;return;}
        if(item.transferPendingId)throw new Error('調撥途中不可重新配置訂單庫存。');
        const normalized=normalizedOrderItems(order)[itemIndex];
        const orderedQty=Math.max(0,Number(normalized.qty||0));
        const effectiveDelivered=Math.max(0,Number(normalized.deliveredQty||0)-Number(normalized.returnedQty||0));
        const requested=Math.max(0,orderedQty-effectiveDelivered);
        const productKey=inventoryProductKey(item);
        let warehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';
        const now=new Date().toISOString();
        const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
        const demandRef=procurementDemandRef(demandId);
        const demandSnap=await tx.get(demandRef);
        const currentDemand=demandSnap.exists?demandSnap.data():null;
        const publish=nextItem=>{
            if(currentUser?.uid!==syncUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
            result=nextItem;
            const items=order.items.map((row,index)=>index===itemIndex?nextItem:row);
            const nextOrder={...order,items};
            const updates={items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now};
            const demandDoc=orderItemProcurementDemandDocument(nextOrder,nextItem,currentDemand,now);
            if(currentDemand||demandDoc.requestedQty>0||demandDoc.orderedQty>0||demandDoc.receivedQty>0)tx.set(demandRef,demandDoc,{merge:true});
            tx.update(orderRef,updates);
        };
        if(!productKey){publish({...item,orderedQty,reservedQty:0,shortageQty:requested,inventoryProductKey:'',reservationError:'missing_product_master'});return;}
        if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'){
            publish({...item,orderedQty,reservedQty:0,shortageQty:0,inventoryProductKey:productKey,warehouseId:'',reservationStatus:'not_required'});return;
        }
        if(!warehouseId)throw new Error('找不到有效倉庫，無法安全配置庫存。');
        const aggregateRef=inventoryRefFor(item);
        const reservationRef=db.collection('inventoryReservations').doc(`${orderId}__${itemId}`);
        const aggregateSnap=aggregateRef?await tx.get(aggregateRef):null;
        const reservationSnap=await tx.get(reservationRef);
        const aggregate=inventoryNumbers(aggregateSnap?.exists?aggregateSnap.data():{});
        const existing=reservationSnap.exists?reservationSnap.data():{};
        const canChoose=globalThis.YushinReservation.reservationLocationCanChange({...item,
            deliveredQty:Math.max(Number(item.deliveredQty||0),Number(normalized.deliveredQty||0)),
            returnedQty:Math.max(Number(item.returnedQty||0),Number(normalized.returnedQty||0))},existing,currentDemand||{});
        const candidateIds=[...new Set([warehouseId,...(canChoose?warehouseMasterCache
            .filter(w=>w.active!==false&&!w.systemCustody&&!String(w.id).startsWith('custody-')).map(w=>w.id):[])])].filter(Boolean);
        const warehouseContexts=await Promise.all(candidateIds.map(async id=>{
            const ref=db.collection('warehouseStocks').doc(warehouseStockDocId(id,productKey));
            const [master,snapshot]=await Promise.all([tx.get(db.collection('warehouses').doc(id)),tx.get(ref)]);
            return {id,ref,snapshot,master:master.exists?{...master.data(),id}:null};
        }));
        if(canChoose){
          const eligibleLocations=warehouseContexts.filter(row=>row.master&&row.master.active!==false
              &&!row.master.systemCustody&&row.master.warehouseType!=='CUSTODY'&&!row.id.startsWith('custody-'));
          const availableAtEligibleLocations=eligibleLocations
              .reduce((sum,row)=>sum+inventoryNumbers(row.snapshot.exists?row.snapshot.data():{}).available,0);
          if(eligibleLocations.length&&aggregateSnap?.exists&&aggregate.available>availableAtEligibleLocations+1e-8)
              throw new Error('公司可用庫存與啟用分倉可用量不一致，請先核對分倉庫存或停用倉庫，避免誤列待採購。');
          const selection=globalThis.YushinReservation.selectSingleWarehouse({
            warehouses:warehouseContexts.map(row=>row.master).filter(Boolean),
            stocks:Object.fromEntries(warehouseContexts.map(row=>[row.id,row.snapshot.exists?row.snapshot.data():{}])),
            currentWarehouseId:warehouseId,requestedQty:requested,aggregateAvailableQty:aggregateSnap?.exists?aggregate.available:0
          });
          if(selection.requiresMultipleLocations)throw new Error('此品項有庫存分散在多倉；目前尚未完成多倉分配，已停止此品項預留與採購需求同步，避免將其他倉現貨誤列為待採購。');
          warehouseId=selection.warehouseId;
        }
        const selected=warehouseContexts.find(row=>row.id===warehouseId);
        if(!selected?.master||selected.master.active===false)throw new Error('找不到啟用的庫存倉庫，請先確認倉庫主檔後重試。');
        const warehouseRef=selected.ref,warehouseSnap=selected.snapshot;
        const warehouse=inventoryNumbers(warehouseSnap.exists?warehouseSnap.data():{});
        const existingQty=Math.max(0,Number(existing.quantity||0));
        const oldProductKey=String(existing.productKey||'');
        const oldWarehouseId=String(existing.warehouseId||'');
        const sameStock=oldProductKey===productKey&&oldWarehouseId===warehouseId;
        if(existingQty>0&&sameStock&&(!aggregateSnap?.exists||!warehouseSnap?.exists)){
            throw new Error('既有預留缺少對應公司或分倉庫存，請先稽核後重試。');
        }

        const plan=globalThis.YushinReservation.planReservation({
            requestedQty:requested,
            existingQty,
            sameStock,
            availableQty:aggregateSnap?.exists?Math.min(warehouse.available,aggregate.available+(oldProductKey===productKey&&!sameStock?existingQty:0)):0,
            inTransitQty:Math.max(0,Number(item.supplyOrderedQty||0)-Number(item.receivedQty||0))
        });

        let oldAggregateRef=null,oldAggregateSnap=null,oldAggregate=null;
        let oldWarehouseRef=null,oldWarehouseSnap=null,oldWarehouse=null;
        if(plan.releaseQty>0&&!sameStock){
            if(!oldProductKey||!oldWarehouseId){
                throw new Error('舊庫存預留缺少產品或倉庫資訊，無法安全重新分配。');
            }
            oldAggregateRef=oldProductKey===productKey
                ? aggregateRef
                : db.collection('inventory').doc(encodeURIComponent(oldProductKey));
            oldWarehouseRef=db.collection('warehouseStocks').doc(warehouseStockDocId(oldWarehouseId,oldProductKey));
            oldAggregateSnap=oldProductKey===productKey
                ? aggregateSnap
                : await tx.get(oldAggregateRef);
            oldWarehouseSnap=await tx.get(oldWarehouseRef);
            if(!oldWarehouseSnap?.exists){
                throw new Error('找不到舊庫存預留所在倉庫，無法安全重新分配。');
            }
            oldAggregate=inventoryNumbers(oldAggregateSnap?.exists?oldAggregateSnap.data():{});
            oldWarehouse=inventoryNumbers(oldWarehouseSnap.data());
        }

        if(aggregateRef&&aggregateSnap?.exists){
            let nextReserved=aggregate.reserved;
            if(plan.releaseQty>0&&oldProductKey===productKey)nextReserved=Math.max(0,nextReserved-plan.releaseQty);
            nextReserved+=plan.additionalReserveQty;
            if(nextReserved!==aggregate.reserved)tx.update(aggregateRef,{reserved:nextReserved,updatedAt:now});
        }
        if(plan.releaseQty>0&&oldProductKey&&oldProductKey!==productKey&&oldAggregateRef&&oldAggregateSnap?.exists){
            tx.update(oldAggregateRef,{reserved:Math.max(0,oldAggregate.reserved-plan.releaseQty),updatedAt:now});
        }

        if(warehouseRef&&warehouseSnap?.exists){
            let nextReserved=warehouse.reserved;
            if(plan.releaseQty>0&&sameStock)nextReserved=Math.max(0,nextReserved-plan.releaseQty);
            nextReserved+=plan.additionalReserveQty;
            if(nextReserved!==warehouse.reserved)tx.update(warehouseRef,{reserved:nextReserved,updatedAt:now});
        }
        if(plan.releaseQty>0&&!sameStock&&oldWarehouseRef&&oldWarehouseSnap?.exists){
            tx.update(oldWarehouseRef,{reserved:Math.max(0,oldWarehouse.reserved-plan.releaseQty),updatedAt:now});
            releasedStock={productKey:oldProductKey,warehouseId:oldWarehouseId};
        }

        if(plan.releaseQty>0){
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(
                'release',-plan.releaseQty,orderId,oldProductKey||productKey,actor,
                {
                    reason:'reservation_reconcile',warehouseId:oldWarehouseId||warehouseId,itemId,
                    fulfillmentType:'WAREHOUSE',ownerUid:order.ownerUid||currentUser?.uid||'',
                    salesCode:order.salesCode||salesCodeForName(order.salesName)||''
                }
            ));
        }
        if(plan.additionalReserveQty>0){
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(
                'reserve',plan.additionalReserveQty,orderId,productKey,actor,
                {
                    warehouseId,itemId,fulfillmentType:'WAREHOUSE',
                    ownerUid:order.ownerUid||currentUser?.uid||'',
                    salesCode:order.salesCode||salesCodeForName(order.salesName)||''
                }
            ));
        }

        tx.set(reservationRef,{
            orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
            itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
            ownerUid:order.ownerUid||currentUser?.uid||'',
            salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
            orderDate:order.orderDate||'',quantity:plan.reservedQty,shortageQty:plan.shortageQty,
            status:plan.status,warehouseId,updatedAt:now
        },{merge:true});

        publish({...item,itemId,orderedQty,reservedQty:plan.reservedQty,shortageQty:plan.shortageQty,inventoryProductKey:productKey,warehouseId});
        stockToInvalidate={productKey,warehouseId};
    });

    if(releasedStock)invalidateWarehouseStockCache(releasedStock.productKey,releasedStock.warehouseId);
    if(stockToInvalidate)invalidateWarehouseStockCache(stockToInvalidate.productKey,stockToInvalidate.warehouseId);
    invalidateProcurementDemandQueue();
    return result;
}
function orderReservationSummary(order) {
    const items=normalizedOrderItems(order);
    return {
        reservedQty:items.reduce((sum,item)=>sum+Math.max(0,Number(item.reservedQty||0)),0),
        shortageQty:items.reduce((sum,item)=>sum+Math.max(0,Number(item.shortageQty||0)),0)
    };
}

function orderItemProcurementDemandDocument(order, item, currentDemand, now) {
    const dispatch=globalThis.YushinFulfillment.dispatchState(normalizedOrderItems(order).find(row=>row.itemId===item.itemId)||item);
    const demand=procurementDemandForOrderItem(order,item,dispatch);
    // A historical mismatch must be audited, not repaired by erasing supplier facts.
    if(currentDemand&&(Number(currentDemand.orderedQty||0)>demand.orderedQty||Number(currentDemand.receivedQty||0)>demand.receivedQty)){
        throw new Error('採購需求與訂單供應進度不一致，請先稽核供應紀錄後重試。');
    }
    return procurementDemandDocument(demand,{
        productId:item.productId||'',productKey:inventoryProductKey(item),
        itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
        fulfillmentType:item.fulfillmentType||order.fulfillmentType||'WAREHOUSE',
        warehouseId:(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'
            ? '' : (item.warehouseId||order.warehouseId||defaultWarehouse()?.id||''),
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',salesName:order.salesName||'',
        // Existing demand dates are independent of supplier ETA.
        scheduleDate:currentDemand?.scheduleDate||demand.scheduleDate||item.requiredByDate||item.scheduleDate||order.requiredByDate||order.expectedDate||''
    },{createdAt:currentDemand?.createdAt||order.createdAt||now,updatedAt:now});
}

async function persistOrderProcurementDemands(orderId, order, items = []) {
    const orderRef=db.collection('orders').doc(orderId);
    // The arguments carry identity only; live quantities and lifecycle always come from Firestore.
    const itemIds=items.map((item,index)=>String(item.itemId||`item-${index+1}`));
    for(const itemId of itemIds){
        const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
        const ref=procurementDemandRef(demandId);
        await runRoleTransaction(async tx=>{
            const orderSnap=await tx.get(orderRef);
            if(!orderSnap.exists)throw new Error('訂單已不存在，無法同步採購需求。');
            const liveOrder={id:orderId,...orderSnap.data()};
            const currentSnap=await tx.get(ref);
            const current=currentSnap.exists?currentSnap.data():null;
            const item=normalizedOrderItems(liveOrder).find(row=>row.itemId===itemId);
            if(!item)throw new Error('訂單品項已變更，請重新讀取後重試同步。');
            const now=new Date().toISOString();
            if(normalizedOrderStatus(liveOrder)!=='normal'){
                if(current){
                    const cancelled=globalThis.YushinProcurementDemand.cancelDemand(current);
                    tx.set(ref,procurementDemandDocument({...current,...cancelled},{},{createdAt:current.createdAt||now,updatedAt:now}),{merge:true});
                }
                return;
            }
            const doc=orderItemProcurementDemandDocument(liveOrder,item,current,now);
            // Do not create empty demands, but clear an existing demand when stock covers it.
            if(current||doc.requestedQty>0||doc.orderedQty>0||doc.receivedQty>0)tx.set(ref,doc,{merge:true});
        });
    }
    invalidateProcurementDemandQueue();
}

async function syncOrderProcurementDemandLifecycle(orderId, order, lifecycleStatus) {
    // Cancellation and restoration use the same live-source projection, not competing batch formulas.
    await persistOrderProcurementDemands(orderId,order,normalizedOrderItems(order));
}

async function reserveInventoryForNewOrder(orderId, order, actorUid = currentUser?.uid) {
    const orderRef=db.collection('orders').doc(orderId);
    const snapshot=await firestoreReadWithTimeout(orderRef.get(),'讀取待同步訂單');
    if(!snapshot.exists)throw new Error('訂單已不存在，無法同步庫存。');
    const liveOrder={id:orderId,...snapshot.data()};
    const items=normalizedOrderItems(liveOrder);
    if(!items.length)throw new Error('訂單缺少正式 items 品項資料，請重新建立訂單。');
    if(items.some(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP')){
        await loadWarehouseMaster(true);
        if(!warehouseMasterLoadPromise)throw new Error('倉庫主檔讀取失敗，請重試同步。');
    }
    if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
    for(let i=0;i<items.length;i++)await reserveSingleOrderItem(orderId,liveOrder,items[i],i,actorUid);
    // Each item transaction has already published stock, reservation, order and demand atomically.
    // Read the result for self-order processing and UI; never overwrite the source with reservedItems.
    const latest=await firestoreReadWithTimeout(orderRef.get(),'讀取庫存同步結果');
    if(!latest.exists)throw new Error('訂單已不存在。');
    if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
    Object.assign(order,{id:orderId,...latest.data()});
    if(normalizedOrderStatus(order)!=='normal')throw new Error('訂單已取消／作廢，停止後續自行訂貨。');
    await registerInitialSelfOrders(orderId,order,actorUid);
    return {...orderReservationSummary(order),items:order.items};
}

function normalizedOrderItems(order) {
    const source = Array.isArray(order?.items) ? order.items : [];
    const deliveryRecords = Array.isArray(order?.deliveryRecords) ? order.deliveryRecords : null;
    const returnRecords = Array.isArray(order?.returnRecords) ? order.returnRecords : null;
    const singleItem = source.length === 1;
    const singleItemId = singleItem ? String(source[0]?.itemId || 'item-1') : '';
    const deliveryQtyByItemId = new Map();
    const returnQtyByItemId = new Map();

    // 一張訂單先各掃一次送貨／退貨紀錄，再由 itemId O(1) 取值。
    // 避免多品項＋多次分批送貨時，每個品項都重新 filter 整份紀錄。
    if (deliveryRecords) {
        deliveryRecords.forEach(row => {
            const itemId = String(row?.itemId || singleItemId || '');
            if (!itemId) return;
            deliveryQtyByItemId.set(itemId,
                (deliveryQtyByItemId.get(itemId) || 0) + Math.max(0, Number(row?.qty || 0)));
        });
    }
    if (returnRecords) {
        returnRecords.forEach(row => {
            const itemId = String(row?.itemId || singleItemId || '');
            if (!itemId || row.settlement === 'CLOSE') return;
            returnQtyByItemId.set(itemId,
                (returnQtyByItemId.get(itemId) || 0) + Math.max(0, Number(row?.qty || 0)));
        });
    }

    return source.map((item, index) => {
        const itemId = String(item.itemId || `item-${index + 1}`);
        // 送貨／退貨紀錄是實際履約的權威來源。若只使用 items 內舊的累計欄位，
        // 「已全數送貨 → 退貨 → 補送」時會把已送過的數量重新誤判成缺貨。
        const grossDeliveredQty = deliveryRecords
            ? (deliveryQtyByItemId.get(itemId) || 0)
            : Math.max(0,Number(item.deliveredQty||0));
        const returnedQty = returnRecords
            ? (returnQtyByItemId.get(itemId) || 0)
            : Math.max(0,Number(item.returnedQty||0));
        const brandIdentity = brandIdentityForRecord(item);
        const base = {
            ...item,
            itemId,
            itemCodeKey: item.itemCodeKey || normalizeHistoryItemCode(item.itemCode || ''),
            brand: brandIdentity.brand,
            brandId: brandIdentity.brandId,
            qty: Number(item.qty || item.orderedQty || 0),
            unitPrice: parseMoney(item.unitPrice || 0),
            totalPrice: parseMoney(item.totalPrice || 0),
            fulfillmentType: item.fulfillmentType || 'WAREHOUSE',
            warehouseId: item.fulfillmentType === 'DIRECT_SHIP' ? '' : (item.warehouseId || ''),
            deliveredQty: grossDeliveredQty,
            returnedQty
        };
        const normalized = window.YushinFulfillment ? window.YushinFulfillment.normalizeItem(base, index) : base;
        // 僅在記憶體標記這個物件的送貨／退貨量已由 deliveryRecords / returnRecords 索引完成。
        // non-enumerable 不會被 spread / JSON / Firestore 寫回，避免快照欄位變成持久資料。
        try {
            Object.defineProperty(normalized, '__fulfillmentSnapshot', {
                value:true, enumerable:false, configurable:true
            });
        } catch (_) {}
        return normalized;
    });
}

function ensureOrderItemCompatibility(order) {
    const items = normalizedOrderItems(order);
    order.items = items;
    order.productIds = productIdsFromItems(items);
    order.orderSchemaVersion = 2;
    order.itemCount = items.length;
    return order;
}

function orderQuantity(order, normalizedItems = null) {
    return (normalizedItems || normalizedOrderItems(order))
        .reduce((sum,item)=>sum+Math.max(0,Number(item.qty||0)),0);
}

function savedDeliveryRecords(order) {
    return Array.isArray(order?.deliveryRecords) ? order.deliveryRecords : [];
}

function deliveredQuantity(order, normalizedItems = null) {
    const records = savedDeliveryRecords(order);
    if (records.length) return records.reduce((sum, record) => sum + (parseFloat(record.qty) || 0), 0);
    // 舊資料只有「已送貨」布林值：視為全數送貨，但不在未確認前改寫雲端資料。
    return order?.isDelivered ? orderQuantity(order, normalizedItems) : 0;
}

function deliveryProgressInfo(order, normalizedItems = null) {
    const total = orderQuantity(order, normalizedItems);
    const grossDelivered = deliveredQuantity(order, normalizedItems);
    const returned = Math.min(returnedQuantity(order), grossDelivered);
    const closedReturns = savedReturnRecords(order).filter(r=>r.settlement==='CLOSE').reduce((sum,r)=>sum+Number(r.qty||0),0);
    const effectiveDelivered = Math.max(0, grossDelivered - returned + closedReturns);
    const delivered = Math.min(effectiveDelivered, total || effectiveDelivered);
    const remaining = Math.max(0, total - delivered);
    const isLegacyEstimated = !!order?.isDelivered && savedDeliveryRecords(order).length === 0;
    const state = total > 0 && delivered >= total ? 'complete' : delivered > 0 ? 'partial' : 'none';
    const label = state === 'complete' ? `已送 ${delivered}/${total}` : state === 'partial' ? `部分 ${delivered}/${total}` : `未送 0/${total || 0}`;
    return { total, delivered, grossDelivered, returned, remaining, state, label, isLegacyEstimated };
}

function savedReturnRecords(order) {
    return Array.isArray(order?.returnRecords) ? order.returnRecords : [];
}

function returnedQuantity(order) {
    return savedReturnRecords(order).reduce((sum, record) => sum + (parseFloat(record.qty) || 0), 0);
}

function normalizedOrderStatus(order) {
    // UI 將取消／作廢視為同一個「不可繼續履約」狀態；底層 status 仍保留 cancelled / voided 以利稽核。
    const canonical = order?.status || '';
    const legacy = order?.orderStatus || '';
    if ([BUSINESS_STATUS.CANCELLED, BUSINESS_STATUS.VOIDED, 'cancelled', 'voided'].includes(canonical)
        || ['cancelled', 'voided'].includes(legacy)) return 'cancelled';
    return 'normal';
}

function orderLifecycleInfo(order, normalizedItems = null) {
    const delivered = deliveredQuantity(order, normalizedItems);
    const returned = Math.min(returnedQuantity(order), delivered);
    const effectiveDelivered = Math.max(0, delivered - returned);
    const status = normalizedOrderStatus(order);
    if (status === 'cancelled') return { status, label: '已取消', css: 'invalid', delivered, returned, effectiveDelivered };
    if (savedReturnRecords(order).some(r=>r.settlement==='CLOSE')) return {status,label:'退貨已收貨・不補送',css:'returned',delivered,returned,effectiveDelivered};
    if (returned > 0 && effectiveDelivered <= 0) return { status, label: '全數退貨・待補送', css: 'returned', delivered, returned, effectiveDelivered };
    if (returned > 0) return { status, label: '部分退貨・待補送', css: 'returned', delivered, returned, effectiveDelivered };
    return { status, label: '正常', css: 'normal', delivered, returned, effectiveDelivered };
}

function purchaseProgressInfo(order) {
    const items=normalizedOrderItems(order);
    if (!items.length) return {state:'not_required',label:'無需採購'};
    let pending=0,inTransit=0,everOrdered=0;
    let allDirect=true;
    items.forEach(item=>{
        const direct=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        if(!direct) allDirect=false;
        const dispatch=itemDispatchState(order,item);
        const returnedQty=direct?dispatch.returned:Number(item.returnedQty??dispatch.returned??0);
        if (!globalThis.YushinWorkflow?.procurementQuantities) {
            throw new Error('Workflow core 未載入，無法計算採購進度。');
        }
        const quantities=globalThis.YushinWorkflow.procurementQuantities({
            orderedQty:item.orderedQty??item.qty,
            fulfillmentType:item.fulfillmentType||order.fulfillmentType||'WAREHOUSE',
            reservedQty:item.reservedQty,
            shortageQty:item.shortageQty,
            supplyOrderedQty:item.supplyOrderedQty,
            receivedQty:item.receivedQty,
            deliveredQty:dispatch.grossDelivered,
            effectiveDeliveredQty:dispatch.delivered,
            returnedQty
        });
        pending+=quantities.remainingToOrderQty;
        inTransit+=quantities.inTransitQty;
        everOrdered+=quantities.supplyOrderedQty;
    });
    if(pending>0&&inTransit>0)return {state:'partial',label:`待採購 ${pending}／在途 ${inTransit}`};
    if(pending>0)return {state:'pending',label:`待採購 ${pending}`};
    if(inTransit>0)return {state:'ordered',label:`已採購・待到貨 ${inTransit}`};
    if(everOrdered>0)return {state:'ordered',label:'採購完成'};
    if(allDirect)return {state:'direct',label:'原廠直送'};
    return {state:'not_required',label:'無需採購'};
}

function fulfillmentProgressInfo(order, normalizedItems = null, dispatchStateByItem = null) {
    const items=(normalizedItems || normalizedOrderItems(order)).filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP');
    const total=items.reduce((s,item)=>s+Number(item.orderedQty||item.qty||0),0);
    const states=items.map(item=>{const state=dispatchStateByItem?.get(item) || itemDispatchState(order,item);return globalThis.YushinWarehouseLogistics?.businessDeliveryState?globalThis.YushinWarehouseLogistics.businessDeliveryState(order,item,state,defaultWarehouse()?.id||''):state;});
    const ready=states.reduce((s,state)=>s+state.reserved,0);
    const prepared=states.reduce((s,state)=>s+state.prepared,0);
    const delivered=states.reduce((s,state)=>s+state.delivered,0);
    const shippable=states.reduce((s,state)=>s+state.shippable,0);
    const pendingDispatch=states.reduce((s,state)=>s+state.pending,0);
    if(!items.length)return {state:'direct',label:'原廠直送',total:0,ready:0,prepared:0,delivered:0,shippable:0,pendingDispatch:0};
    if(total>0 && delivered>=total)return {state:'complete',label:'出貨完成',total,ready,prepared,delivered,shippable:0,pendingDispatch:0};
    if(shippable>0)return {state:'shippable',label:`可出貨 ${shippable}/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
    if(pendingDispatch>0)return {state:ready>=Math.max(0,total-delivered)?'pending_dispatch':'partial_dispatch',label:`待打單 ${pendingDispatch}/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
    const waiting=states.find(state=>state.deliveryWait);if(waiting&&ready>0)return {state:'pending',label:waiting.deliveryWait,total,ready,prepared,delivered,shippable,pendingDispatch};
    return {state:'pending',label:`待備貨 0/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
}

const pendingDispatchOrderIds = new Set();

function itemDispatchState(order, item) {
    if(orderInventorySyncIncomplete(order))return {ordered:Number(item.orderedQty||item.qty||0),reserved:0,prepared:0,delivered:0,grossDelivered:0,returned:0,shippable:0,pending:0};
    // deliveryRecords / returnRecords 仍由頁面層整理；所有物流數量公式交給 fulfillment-core。
    // 這樣訂單頁、採購頁與實際送貨動作不會各自維護一套「待打單／可出貨」算法。
    const hasSnapshot = item?.__fulfillmentSnapshot === true;
    const singleItem = Array.isArray(order?.items) && order.items.length === 1;
    const grossDelivered = hasSnapshot
        ? Math.max(0, Number(item.deliveredQty || 0))
        : savedDeliveryRecords(order).filter(r => ((!r.itemId && singleItem) || r.itemId === item.itemId))
            .reduce((sum, r) => sum + Number(r.qty || 0), 0);
    const returned = hasSnapshot
        ? Math.max(0, Number(item.returnedQty || 0))
        : savedReturnRecords(order).filter(r => r.settlement !== 'CLOSE' && ((!r.itemId && singleItem) || r.itemId === item.itemId))
            .reduce((sum, r) => sum + Number(r.qty || 0), 0);
    if (!globalThis.YushinFulfillment?.dispatchState) {
        throw new Error('Fulfillment core 未載入，無法計算出貨狀態。');
    }
    const dispatchState=globalThis.YushinFulfillment.dispatchState({
        ...item,
        orderedQty: item.orderedQty ?? item.qty,
        deliveredQty: grossDelivered,
        returnedQty: returned
    });
    return item.transferPendingId?{...dispatchState,shippable:0,pending:0,transferring:dispatchState.reserved}:dispatchState;
}

function orderLifecycleActionButtons(order, lifecycle, progress, actions) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return '';
    if (pendingLifecycleOrderIds.has(order.id)) return '<button type="button" disabled>處理中…</button>';
    const id = inlineJsValue(order.id);
    const buttons = [];
    if (lifecycle.status === 'normal') {
        if (actions.showPartialDelivery) buttons.push(`<button type="button" onclick="openPartialDeliveryForOrder(${id})">分批交貨</button>`);
        if (progress.remaining > 0) buttons.push(`<button type="button" class="danger-menu-item" onclick="quickSetOrderLifecycle(${id}, 'cancelled')">${progress.delivered > 0 ? '取消剩餘未送貨數量' : '取消訂單'}</button>`);
    } else {
        buttons.push(`<button type="button" onclick="quickSetOrderLifecycle(${id}, 'normal')">恢復訂單</button>`);
    }
    if (actions.showReturn) buttons.push(`<button type="button" onclick="openReturnManagement(${id})">退貨</button>`);
    return buttons.join('');
}

// Only a fully ready single-item order is safe for one-click delivery.
// Multi-item and partly printed orders must choose an exact item and quantity.
function orderDeliveryRequiresItemForm(items, deliveryProgress, fulfillmentProgress) {
    return (items || []).length !== 1
        || Number(fulfillmentProgress?.shippable || 0) + 1e-9 < Number(deliveryProgress?.remaining || 0);
}

function orderContextActionState(order, normalizedItems = null, dispatchStateByItem = null) {
    const items = normalizedItems || normalizedOrderItems(order);
    const states = items.map(item => dispatchStateByItem?.get(item) || itemDispatchState(order, item));
    const grossDelivered = states.reduce((sum, state) => sum + Math.max(0, Number(state.grossDelivered || 0)), 0);
    const returned = states.reduce((sum, state) => sum + Math.max(0, Number(state.returned || 0)), 0);
    const netDelivered = Math.max(0, grossDelivered - returned);
    // 「分批交貨」只在真的有部分到貨品項時出現。
    // 全數到貨走一般送貨流程；尚未到貨則不提供分批交貨，避免操作選單過早出現。
    const hasPartialArrival = items.some((item, index) => {
        const ordered = Math.max(0, Number(item.orderedQty || item.qty || 0));
        const received = Math.max(0, Number(item.receivedQty || 0));
        const state = states[index];
        // 分批交貨不只要「部分到貨」，還必須真的有尚未交付、目前可出貨的數量。
        // 避免部分到貨紀錄存在，但該批已全數送出時仍顯示無效操作。
        return ordered > 0 && received > 0 && received < ordered && Number(state?.shippable || 0) > 0;
    });
    return {
        showPartialDelivery: normalizedOrderStatus(order) === 'normal'
            && (hasPartialArrival || (items.length > 1 && states.some(state => Number(state?.shippable || 0) > 0))),
        showReturn: netDelivered > 0
    };
}

function dispatchActionHtml(order, normalizedItems = null, dispatchStateByItem = null) {
    if(orderInventorySyncIncomplete(order))return '';
    if (!(currentUserRole === 'purchaser' || currentUserRole === 'admin')) return '';
    if (normalizedOrderStatus(order) !== 'normal') return '';
    return (normalizedItems || normalizedOrderItems(order))
        .filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP')
        .map(item=>({item,state:dispatchStateByItem?.get(item) || itemDispatchState(order,item)}))
        .filter(x=>x.state.pending>0)
        .map(({item,state})=>`<button type="button" onclick="markOrderItemDispatchPrepared(${inlineJsValue(order.id)},${inlineJsValue(item.itemId)})" ${pendingDispatchOrderIds.has(order.id+'__'+item.itemId)?'disabled':''}>待打單：${escapeHtml(item.itemCode||item.itemName||item.itemId)} × ${state.pending}</button>`)
        .join('');
}

window.markOrderItemDispatchPrepared = async function(orderId,itemId) {
    if (!(currentUserRole === 'purchaser' || currentUserRole === 'admin')) return;
    const key=orderId+'__'+itemId;
    if(pendingDispatchOrderIds.has(key))return;
    pendingDispatchOrderIds.add(key);
    if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
    else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingDispatchOrders();
    try{
        let saved;
        await runRoleTransaction(async tx=>{
            const ref=db.collection('orders').doc(orderId);
            const snap=await tx.get(ref);
            if(!snap.exists)throw new Error('找不到訂單。');
            const order=snap.data();
            if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能打單。');
            const tradeValidation=globalThis.YushinOrderEntry.validateTrade(order);if(!tradeValidation.valid)throw new Error(tradeValidation.message);
            const items=normalizedOrderItems(order);
            const index=items.findIndex(item=>item.itemId===itemId);
            if(index<0)throw new Error('找不到訂單品項。');
            const item=items[index],state=itemDispatchState(order,item);
            if(state.pending<=0)throw new Error('此品項目前沒有待打單數量。');
            const now=new Date().toISOString(),actor=deliveryActor();
            items[index]={...item,dispatchPreparedQty:state.prepared+state.pending};
            const dispatchRef=db.collection('dispatchRecords').doc();
            tx.set(dispatchRef,{
                orderId,itemId,qty:state.pending,ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',
                customerName:order.customerName||'',itemCode:item.itemCode||'',itemName:item.itemName||'',
                preparedByUid:currentUser?.uid||'',preparedBy:actor,createdAt:now
            });
            const nextOrder={...order,items,updatedAt:now};
            tx.update(ref,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
            saved=nextOrder;
        });
        const idx=ordersCache.findIndex(o=>o.id===orderId);
        const savedOrder={id:orderId,...saved};
        if(idx>=0)ordersCache[idx]=savedOrder;
        syncOrderIntoPurchasingCaches(savedOrder, { render:false });
        writeAppDataCache('orders', ordersCache);
    }catch(err){alert('標記已打單失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');}
    finally{
        pendingDispatchOrderIds.delete(key);
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        if(currentDeliveryOrderId===orderId)renderDeliveryModal();
    }
};


function canBusinessSelfOrder(order = null) {
    if (currentUserRole === 'admin') return true;
    if (!canSelfOrderCapability(currentUserRole)) return false;
    if (!order) return true;
    return (order.ownerUid && order.ownerUid === currentUser?.uid)
        || (order.salesCode && currentUserCode && order.salesCode === currentUserCode);
}


async function registerInitialSelfOrderSupply(orderId,itemId,{supplier,qty,unitCost,orderDate,notes='',actorUid=currentUser?.uid}) {
        let savedOrder,internalNo='';
        await runRoleTransaction(async tx=>{
            const orderRef=db.collection('orders').doc(orderId);
            const snap=await tx.get(orderRef);
            if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
            if(!snap.exists)throw new Error('找不到訂單。');
            const order=snap.data();

            if(!canBusinessSelfOrder(order)&&!canCreatePurchaseOrderCapability())throw new Error('只有此訂單負責業務可自行訂貨。');
            if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能自行訂貨。');
            const items=normalizedOrderItems(order);
            const index=items.findIndex(row=>row.itemId===itemId);
            if(index<0)throw new Error('找不到訂單品項。');
            const item=items[index];
            if ((item.procurementType || order.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER') throw new Error('此品項設定為交由採購，不能自行訂貨。');
            const supplyRef=supplyOrdersCollection().doc(`self-${encodeURIComponent(orderId)}-${encodeURIComponent(itemId)}`);
            const existingSupply=await tx.get(supplyRef);
            if(existingSupply.exists){savedOrder=order;return;}
            const already=Math.max(0,Number(item.supplyOrderedQty||0));
            const demand=procurementDemandForOrderItem({...order,id:orderId},item);
            const remaining=demand.remainingToOrderQty;
            if(qty>remaining+1e-9)throw new Error(`目前尚未訂貨數量只有 ${remaining}。`);
            internalNo=`SO-${orderDate.replace(/-/g,'')}-${`${orderId.slice(-6)}-${itemId.slice(-6)}`.toUpperCase()}`;
            const now=new Date().toISOString();
            const demandOrderPlan=globalThis.YushinProcurementDemand.applyOrder(demand,qty);
            if(demandOrderPlan.appliedQty!==qty)throw new Error('採購需求數量已變更，請重新整理後再試。');
            const demandRef=procurementDemandRef(demand.demandId);
            const demandDoc=procurementDemandDocument(demandOrderPlan.demand,{
                productId:item.productId||'',
                productKey:inventoryProductKey(item),
                itemCode:item.itemCode||'',
                itemName:item.itemName||'',
                brand:item.brand||'',
                fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||defaultWarehouse()?.id||''),
                ownerUid:order.ownerUid||currentUser?.uid||'',
                salesCode:order.salesCode||currentUserCode||'',
                salesName:order.salesName||currentUserName||'',
                scheduleDate:item.scheduleDate||order.expectedDate||''
            },{
                createdAt:order.createdAt||now,
                updatedAt:now
            });
            const record={
                type:'SALES_SELF_ORDER',method:'SALES_SELF_ORDER',
                sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,demandId:demand.demandId||'',
                internalNo,status:'ORDERED',orderId,itemId,
                ownerUid:order.ownerUid||currentUser?.uid||'',salesCode:order.salesCode||currentUserCode||'',
                salesName:order.salesName||currentUserName||'',
                customerName:order.customerName||'',productId:item.productId||'',productKey:inventoryProductKey(item),
                itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
                qty,receivedQty:0,supplier,unitCost,orderDate,notes,
                fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP' ? '' : (item.warehouseId||defaultWarehouse()?.id||''),
                createdAt:now,createdByUid:currentUser?.uid||'',createdBy:deliveryActor(),createdByRole:currentUserRole
            };
            const validation=window.YushinSupply?.validate(record);
            if(validation&&!validation.valid)throw new Error('自行訂貨資料不完整：'+validation.errors.join(', '));
            if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更，請以原帳號重試同步。');
            tx.set(supplyRef,record);
            if(demandRef)tx.set(demandRef,demandDoc,{merge:true});
            items[index]={
                ...item,
                supplyOrderedQty:already+qty,
                supplier,costPrice:unitCost,
                selfOrderNos:[...new Set([...(item.selfOrderNos||[]),internalNo])],
                orderedAt:item.orderedAt && item.orderedAt < orderDate ? item.orderedAt : orderDate,
                orderEvents:[
                    ...(item.orderEvents||[]).filter(event=>event.id!==supplyRef.id),
                    {id:supplyRef.id,type:'SALES_SELF_ORDER',at:now,date:orderDate,qty,documentNo:internalNo,by:deliveryActor()}
                ]
            };
            savedOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
            tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(savedOrder),updatedAt:now});
        });
    return savedOrder;
}

async function registerInitialSelfOrders(orderId,order,actorUid=currentUser?.uid) {
    if(order.selfOrderAtCreation!==true)return;
    let changed=false;
    try{
        for(const item of normalizedOrderItems(order)){
            if((item.procurementType||order.procurementType)!=='SALES_SELF_ORDER'||item.selfOrderConfirmed!==true)continue;
            const qty=remainingProcurementQty(order,item);
            if(qty<=0)continue;
            const saved=await registerInitialSelfOrderSupply(orderId,item.itemId,{supplier:item.supplier,qty,unitCost:Number(item.costPrice),orderDate:order.orderDate,actorUid});
            Object.assign(order,saved);
            changed=true;
        }
    }finally{
        // Refresh the pending demand once per order, even if a later line fails.
        if(changed)invalidateProcurementDemandQueue();
    }
}
function selfOrderActionHtml(order, normalizedItems = null, dispatchStateByItem = null) {
    if(!canBusinessSelfOrder(order)||normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order))return '';
    return (normalizedItems||normalizedOrderItems(order)).filter(item=>(item.procurementType||order.procurementType)==='SALES_SELF_ORDER'&&remainingProcurementQty(order,item)>0)
        .map(item=>`<button type="button" class="btn-small btn-secondary" onclick="openSelfOrderModal(${inlineJsValue(order.id)},${inlineJsValue(item.itemId)})">確認自行訂貨・${escapeHtml(item.itemCode||item.itemName)}</button>`).join('');
}

function directShipReceiptActionHtml(order, items = normalizedOrderItems(order)) {
    if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order)||!canConfirmSupplyReceipt({...order,fulfillmentType:'DIRECT_SHIP'}))return '';
    return items.filter(item=>item.fulfillmentType==='DIRECT_SHIP'&&Number(item.supplyOrderedQty||0)>Number(item.receivedQty||0))
        .map(item=>`<button type="button" class="btn-small btn-secondary" onclick="openOrderDirectShipReceipt(${inlineJsValue(order.id)},${inlineJsValue(item.itemId)},this)">確認直送到貨・${escapeHtml(item.itemCode||item.itemName)}</button>`).join('');
}
window.openOrderDirectShipReceipt = async function(orderId,itemId,button) {
    const order=ordersCache.find(row=>row.id===orderId);
    if(!order||!canConfirmSupplyReceipt({...order,fulfillmentType:'DIRECT_SHIP'}))return;
    const uid=currentUser?.uid,role=currentUserRole,state=beginActionButton(button,'讀取中…');
    if(button&&!state)return;
    try{
        let query=db.collection('receivingSupplyOrders').where('orderId','==',orderId).where('itemId','==',itemId).where('fulfillmentType','==','DIRECT_SHIP');
        if(role!=='admin')query=query.where('ownerUid','==',uid);
        const records=await readQueryInBatches(query,50);
        if(uid!==currentUser?.uid||role!==currentUserRole)return;
        const supply=records.filter(row=>canConfirmSupplyReceipt(row)&&!isPurchaseTerminalStatus(row.status)&&Number(row.qty||0)>Number(row.receivedQty||0))
            .sort((a,b)=>String(a.orderDate||'').localeCompare(String(b.orderDate||''))||String(a.id).localeCompare(String(b.id)))[0];
        if(!supply)throw new Error('沒有可確認的直送供應紀錄，請更新訂單後再試。');
        supplyReceivingCache=supplyReceivingCache.filter(row=>row.id!==supply.id).concat(supply);
        openSupplyReceipt(supply.id);
    }catch(err){showActionFeedback('直送到貨確認未開啟：'+err.message,'warning');}
    finally{endActionButton(button,state);}
};

window.openSelfOrderModal = function(orderId,itemId) {
    const order=ordersCache.find(row=>row.id===orderId);
    const item=normalizedOrderItems(order||{}).find(row=>row.itemId===itemId);
    if(!order||!item||orderInventorySyncIncomplete(order)||!canBusinessSelfOrder(order))return;
    const remaining=remainingProcurementQty(order,item);
    if(remaining<=0){alert('此品項目前沒有尚未訂貨的缺貨數量。');return;}
    document.getElementById('selfOrderOrderId').value=orderId;
    document.getElementById('selfOrderItemId').value=itemId;
    document.getElementById('selfOrderSupplier').value=item.supplier||'';
    document.getElementById('selfOrderQty').value=remaining;
    document.getElementById('selfOrderQty').max=remaining;
    document.getElementById('selfOrderUnitCost').value=item.costPrice??'';
    document.getElementById('selfOrderDate').value=localDateString();
    document.getElementById('selfOrderNotes').value='';
    const directShip=(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
    document.getElementById('selfOrderStatus').innerText=directShip ? `尚未訂貨 ${remaining}；原廠直送不入庫，到貨後直接更新訂單交貨進度。` : `尚缺 ${remaining}；自行訂貨後會進入待入庫。`;
    document.getElementById('selfOrderItemSummary').innerHTML=`<strong>${escapeHtml(item.itemCode||'')}</strong> ${escapeHtml(item.itemName||'')}<br><span style="color:#666;">客戶：${escapeHtml(order.customerName||'')}</span>`;
    document.getElementById('selfOrderOverlay').classList.add('active');
};

window.closeSelfOrderModal = function() {
    document.getElementById('selfOrderOverlay')?.classList.remove('active');
};

window.saveSelfOrder = async function() {
    if(!canBusinessSelfOrder())return;
    const orderId=document.getElementById('selfOrderOrderId').value;
    const itemId=document.getElementById('selfOrderItemId').value;
    const supplier=document.getElementById('selfOrderSupplier').value.trim();
    const qty=Number(document.getElementById('selfOrderQty').value||0);
    const unitCostText=document.getElementById('selfOrderUnitCost').value.trim();
    const unitCost=Number(unitCostText);
    const orderDate=document.getElementById('selfOrderDate').value||localDateString();
    const notes=document.getElementById('selfOrderNotes').value.trim();
    if(!supplier||!Number.isFinite(qty)||qty<=0||unitCostText===''||!Number.isFinite(unitCost)||unitCost<0){alert('請填寫供應商、有效訂貨數量與實際單位成本（可填 0）。');return;}
    const button=document.getElementById('saveSelfOrderBtn');
    if(button.disabled)return;
    button.disabled=true;button.innerText='建立中…';
    try{
        let savedOrder,internalNo='';
        await runRoleTransaction(async tx=>{
            const orderRef=db.collection('orders').doc(orderId);
            const snap=await tx.get(orderRef);
            if(!snap.exists)throw new Error('找不到訂單。');
            const order=snap.data();
            if(orderInventorySyncIncomplete(order))throw new Error('訂單庫存尚未同步完成');
            if(!canBusinessSelfOrder(order))throw new Error('只有此訂單負責業務可自行訂貨。');
            if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能自行訂貨。');
            const items=normalizedOrderItems(order);
            const index=items.findIndex(row=>row.itemId===itemId);
            if(index<0)throw new Error('找不到訂單品項。');
            const item=items[index];
            if ((item.procurementType || order.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER') throw new Error('此品項設定為交由採購，不能自行訂貨。');
            const already=Math.max(0,Number(item.supplyOrderedQty||0));
            const demand=procurementDemandForOrderItem({...order,id:orderId},item);
            const remaining=demand.remainingToOrderQty;
            if(qty>remaining+1e-9)throw new Error(`目前尚未訂貨數量只有 ${remaining}。`);
            const supplyRef=supplyOrdersCollection().doc();
            internalNo=`SO-${orderDate.replace(/-/g,'')}-${supplyRef.id.slice(0,6).toUpperCase()}`;
            const now=new Date().toISOString();
            const demandOrderPlan=globalThis.YushinProcurementDemand.applyOrder(demand,qty);
            if(demandOrderPlan.appliedQty!==qty)throw new Error('採購需求數量已變更，請重新整理後再試。');
            const demandRef=procurementDemandRef(demand.demandId);
            const demandDoc=procurementDemandDocument(demandOrderPlan.demand,{
                productId:item.productId||'',
                productKey:inventoryProductKey(item),
                itemCode:item.itemCode||'',
                itemName:item.itemName||'',
                brand:item.brand||'',
                fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||defaultWarehouse()?.id||''),
                ownerUid:order.ownerUid||currentUser?.uid||'',
                salesCode:order.salesCode||currentUserCode||'',
                salesName:order.salesName||currentUserName||'',
                scheduleDate:item.scheduleDate||order.expectedDate||''
            },{
                createdAt:order.createdAt||now,
                updatedAt:now
            });
            const record={
                type:'SALES_SELF_ORDER',method:'SALES_SELF_ORDER',
                sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,demandId:demand.demandId||'',
                internalNo,status:'ORDERED',orderId,itemId,
                ownerUid:order.ownerUid||currentUser?.uid||'',salesCode:order.salesCode||currentUserCode||'',
                salesName:order.salesName||currentUserName||'',
                customerName:order.customerName||'',productId:item.productId||'',productKey:inventoryProductKey(item),
                itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
                qty,receivedQty:0,supplier,unitCost,orderDate,notes,
                fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP' ? '' : (item.warehouseId||defaultWarehouse()?.id||''),
                createdAt:now,createdByUid:currentUser?.uid||'',createdBy:deliveryActor(),createdByRole:currentUserRole
            };
            const validation=window.YushinSupply?.validate(record);
            if(validation&&!validation.valid)throw new Error('自行訂貨資料不完整：'+validation.errors.join(', '));
            tx.set(supplyRef,record);
            if(demandRef)tx.set(demandRef,demandDoc,{merge:true});
            items[index]={
                ...item,
                supplyOrderedQty:already+qty,
                supplier,costPrice:unitCost,
                selfOrderNos:[...new Set([...(item.selfOrderNos||[]),internalNo])],
                orderedAt:item.orderedAt && item.orderedAt < orderDate ? item.orderedAt : orderDate,
                orderEvents:[
                    ...(item.orderEvents||[]).filter(event=>event.id!==supplyRef.id),
                    {id:supplyRef.id,type:'SALES_SELF_ORDER',at:now,date:orderDate,qty,documentNo:internalNo,by:deliveryActor()}
                ]
            };
            savedOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
            tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(savedOrder),updatedAt:now});
        });
        const index=ordersCache.findIndex(row=>row.id===orderId);
        const committedOrder={id:orderId,...savedOrder};
        if(index>=0)ordersCache[index]=committedOrder;else ordersCache.unshift(committedOrder);
        syncOrderIntoPurchasingCaches(committedOrder, { render:false });
        writeAppDataCache('orders', ordersCache);
        invalidateProcurementDemandQueue();
        closeSelfOrderModal();
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        alert(`自行訂貨已建立：${internalNo}`);
    }catch(err){alert('自行訂貨失敗：'+err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');}
    finally{button.disabled=false;button.innerText='確認自行訂貨';}
};

function isDeletableOrderDraft(order) {
    if (!order || order.quoteNo || order.purchaseOrderNo) return false;
    const items = normalizedOrderItems(order);
    const hasProcurementEvidence = items.some(item =>
        Math.max(0, Number(item.supplyOrderedQty || 0)) > 0
        || (Array.isArray(item.purchaseDocumentNos) && item.purchaseDocumentNos.some(Boolean))
    ) || (Array.isArray(order.linkedDocuments) && order.linkedDocuments.some(link =>
        link?.type === DOCUMENT_TYPES.PURCHASE_ORDER && link?.id
    ));
    if (hasProcurementEvidence) return false;
    if (order.isDelivered || order.isBilled) return false;
    if (savedDeliveryRecords(order).length || savedReturnRecords(order).length) return false;
    if ((order.statusHistory || []).length || (order.deliveryHistory || []).length || (order.returnHistory || []).length || (order.orderLifecycleHistory || []).length) return false;
    return normalizedOrderStatus(order) === 'normal';
}

function orderWorkCategory(order) {
    // 整張訂單狀態只由各品項的唯一狀態推導，避免另一套 aggregate 判斷
    // 與列表／圖卡／Firestore workCategories 出現不同答案。
    const categories=orderWorkCategories(order);
    if(categories.includes('closed'))return 'closed';
    const priority=['ordering','arrival','delivery','billing','complete'];
    return priority.find(category=>categories.includes(category))||'ordering';
}

function orderItemWorkCategory(order, item, lifecycleOverride = null, dispatchOverride = null) {
    const lifecycle=lifecycleOverride || orderLifecycleInfo(order);
    const dispatch=dispatchOverride || itemDispatchState(order,item);
    const input={
        lifecycleStatus:lifecycle.status,
        returnedQty:dispatch.returned,
        effectiveDeliveredQty:dispatch.delivered,
        orderedQty:item.orderedQty??item.qty,
        deliveredQty:dispatch.grossDelivered,
        isBilled:!!order.isBilled,
        fulfillmentType:item.fulfillmentType||order.fulfillmentType||'WAREHOUSE',
        reservedQty:item.reservedQty,
        shortageQty:item.shortageQty,
        supplyOrderedQty:item.supplyOrderedQty,
        receivedQty:item.receivedQty
    };
    // 單一權威來源：畫面、圖卡、採購與 workCategories 全部交給 workflow-core 判斷。
    return YushinWorkflow.itemWorkCategory(input);
}

// 倉庫品項的採購／到貨／送貨仍共用原本的資料狀態；訂單頁依已打單量
// 把可出貨前的工作分成待打單與待出貨，不另建會與庫存紀錄脫節的旗標。
function orderItemDisplayCategory(order, item, lifecycleOverride = null, dispatchOverride = null) {
    const dispatch = dispatchOverride || itemDispatchState(order, item);
    const category = orderItemWorkCategory(order, item, lifecycleOverride, dispatch);
    if (category !== 'delivery') return category;
    if ((item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return 'shipping';
    return dispatch.pending > 0 ? 'dispatch' : 'shipping';
}

function orderItemDisplayCategories(order, item, lifecycleOverride = null, dispatchOverride = null) {
    const dispatch = dispatchOverride || itemDispatchState(order, item);
    const category=orderItemDisplayCategory(order,item,lifecycleOverride,dispatch);
    if(category!=='closed'&&['pending','failed'].includes(order?.inventoryReservationStatus))return [];
    const warehouse=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP';
    // A single line can be partly printed and partly awaiting paperwork/arrival.
    // Keep both work queues visible, but never present unprinted quantities to sales.
    if(!warehouse || category==='closed' || category==='billing' || category==='complete')return [category];
    const categories=[category];
    if(['ordering','arrival'].includes(category) && dispatch.pending>0)categories.push('dispatch');
    if(category!=='shipping' && dispatch.shippable>0)categories.push('shipping');
    return categories;
}

function orderWorkCategories(order) {
    const lifecycle=orderLifecycleInfo(order);
    if(lifecycle.status!=='normal')return ['closed'];
    const items=normalizedOrderItems(order);
    const categories=[...new Set(items.flatMap(item=>{
        const category=orderItemWorkCategory(order,item);
        const warehouse=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP';
        return warehouse && ['ordering','arrival','delivery'].includes(category) && itemDispatchState(order,item).pending>0
            ? [category,'dispatch'] : [category];
    }))];
    if(!categories.length)return ['ordering'];
    return categories;
}

function orderWorkIndexFields(order) {
    const categories=orderWorkCategories(order);
    return {
        workCategories:categories,
        workCategoryUpdatedAt:new Date().toISOString()
    };
}

function orderItemWorkAmount(order, item, category, totalQtyOverride = null, dispatchOverride = null) {
    const qty=Number(item.orderedQty||item.qty||0);
    const totalQty=totalQtyOverride === null ? orderQuantity(order) : totalQtyOverride;
    const explicitSales=[item.unitPrice,item.salesPrice].find(value=>value!==null&&value!==undefined&&String(value).trim()!==''&&Number.isFinite(Number(value)));
    const unitSales=explicitSales!==undefined?Number(explicitSales):(totalQty?salesAmount(order)/totalQty:(parseFloat(order.unitPrice)||0));
    const state=dispatchOverride || itemDispatchState(order,item);
    // Work-card amounts represent quantities in each action queue, not the full
    // order line repeated when the same line is partly printed or partly waiting.
    if(category==='dispatch')return Math.max(0,Number(state.pending||0))*unitSales;
    if(category==='shipping')return Math.max(0,Number(state.shippable||0))*unitSales;
    if(category==='delivery')return Math.max(0,qty-state.delivered)*unitSales;
    if(category==='billing'||category==='complete')return Math.min(qty,state.delivered)*unitSales;
    if(category==='ordering')return Math.max(0,Number(procurementDemandForOrderItem(order,item,state).remainingToOrderQty||0))*unitSales;
    return qty*unitSales;
}

function buildOrderItemWorkMetrics(orders, categories, include = null, normalizedItemsByOrder = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const metrics = Object.fromEntries(categories.map(category => [category, { count:0, amount:0 }]));
    (orders || []).forEach(order => {
        const items = normalizedItemsByOrder?.get(order.id) || normalizedOrderItems(order);
        const totalQty = items.reduce((sum, item) => sum + Math.max(0, Number(item.qty || 0)), 0);
        const lifecycle = lifecyclesByOrder?.get(order.id) || orderLifecycleInfo(order, items);
        const orderDispatchStates = dispatchStatesByOrder?.get(order.id) || null;
        items.forEach(item => {
            // 工作圖卡同一品項只掃一次送貨／退貨紀錄；分類與金額共用同一份 dispatch state。
            const dispatch = orderDispatchStates?.get(item) || itemDispatchState(order, item);
            orderItemDisplayCategories(order,item,lifecycle,dispatch).forEach(category => {
                if (!metrics[category]) return;
                if (include && !include(order,item,category)) return;
                metrics[category].count++;
                metrics[category].amount += orderItemWorkAmount(order,item,category,totalQty,dispatch);
            });
        });
    });
    return metrics;
}

const OPEN_ORDER_WORK_CATEGORIES = ['ordering','arrival','delivery','dispatch','billing'];
let orderWorkQueueCache = [], orderWorkQueueReady = false, orderWorkQueueError = '';
let orderWorkQueuePromise = null, orderWorkQueueGeneration = 0;
let orderWorkQueueLoadedAt = 0, orderWorkQueueLoadedScope = '';
function pendingOrderWorkQuery() {
    let query = db.collection('orders').where('status','==',BUSINESS_STATUS.ACTIVE)
        .where('workCategories','array-contains-any',OPEN_ORDER_WORK_CATEGORIES);
    if (!canViewAllData('orders') && !canReceiveInventoryCapability()) query = query.where('ownerUid','==',currentUser?.uid || '');
    return query.orderBy('orderDate','desc');
}
async function loadOrderWorkQueue(force = false) {
    if (!canAccessPage('orders.list') && !canAccessPage('orders.po') && !(canAccessPage('inventory') && canReceiveInventoryCapability())) return;
    if (orderWorkQueuePromise && !force) return orderWorkQueuePromise;
    const scope = JSON.stringify([currentUser?.uid || '', currentUserRole]);
    if (!force && orderWorkQueueReady && orderWorkQueueLoadedScope === scope && Date.now() - orderWorkQueueLoadedAt < 15000) return;
    const generation = ++orderWorkQueueGeneration, uid = currentUser?.uid, role = currentUserRole;
    orderWorkQueueReady = false; orderWorkQueueError = '';
    const request = (async () => {
        try {
            const records = await readQueryInBatches(pendingOrderWorkQuery(), 200);
            if (generation !== orderWorkQueueGeneration || uid !== currentUser?.uid || role !== currentUserRole) return;
            const ids = new Set(records.map(row=>row.id));
            const finishedIds = orderWorkQueueCache.filter(row=>!ids.has(row.id)).map(row=>row.id);
            const finished = finishedIds.length ? await readDocumentsByIds('orders', finishedIds) : [];
            if (generation !== orderWorkQueueGeneration || uid !== currentUser?.uid || role !== currentUserRole) return;
            orderWorkQueueCache = records.filter(row=>orderWorkCategories(row).some(category=>OPEN_ORDER_WORK_CATEGORIES.includes(category)));
            const merged = new Map(ordersCache.map(row=>[row.id,row]));
            records.concat(finished).forEach(row=>merged.set(row.id,row));
            finishedIds.filter(id=>!finished.some(row=>row.id===id)).forEach(id=>merged.delete(id));
            ordersCache = [...merged.values()];
            orderWorkQueueReady = true;
            orderWorkQueueLoadedAt = Date.now(); orderWorkQueueLoadedScope = scope;
        } catch (err) {
            if (generation !== orderWorkQueueGeneration || uid !== currentUser?.uid || role !== currentUserRole) return;
            orderWorkQueueError = '未完成工作讀取失敗，請重試';
            mainPageLoadFailed('orders.list'); mainPageLoadFailed('orders.po');
            console.error('未完成訂單讀取失敗：',err);
        } finally {
            if (generation === orderWorkQueueGeneration && uid === currentUser?.uid && role === currentUserRole) {
                if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
                if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
            }
        }
    })();
    orderWorkQueuePromise = request;
    try { return await request; } finally { if (orderWorkQueuePromise === request) orderWorkQueuePromise = null; }
}
window.setOrderWorkFilter = function(filter) {
    activeOrderWorkFilter = activeOrderWorkFilter === filter && filter !== 'all' ? 'all' : filter;
    if (!orderWorkQueueReady) loadOrderWorkQueue();
    renderOrdersList();
};

function renderOrderWorkCards(orders, normalizedItemsByOrder = null, dispatchStatesByOrder = null, lifecyclesByOrder = null) {
    const container = document.getElementById('orderWorkCards');
    if (!container) return;
    const definitions = [
        ['ordering', '待採購'],
        ['arrival', '待到貨'],
        ['dispatch', '待打單'],
        ['shipping', '已打單'],
        ['billing', '待核銷'],
        ['complete', '已完成（已載入）']
    ];
    const metrics = buildOrderItemWorkMetrics(
        orders,
        definitions.map(([key]) => key),
        (order, item, category) => category !== 'complete' || orderMatchesWorkPeriod(order, category),
        normalizedItemsByOrder,
        dispatchStatesByOrder,
        lifecyclesByOrder
    );
    container.innerHTML = definitions.map(([key, label]) => `<button type="button" class="order-work-card ${activeOrderWorkFilter === key ? 'active' : ''}" onclick="setOrderWorkFilter('${key}')"><span>${label}</span><strong>${key !== 'complete' && !orderWorkQueueReady ? (orderWorkQueueError || '讀取中…') : metrics[key].count + ' 筆'}</strong><small>${formatStatsMoney(metrics[key].amount)}</small></button>`).join('');
}

function createOrderPaginationState() {
    const sources = [];
    if (canViewAllData('orders')) {
        sources.push({
            cursor: null,
            exhausted: false,
            query: () => db.collection('orders').orderBy('orderDate', 'desc')
        });
    } else if (currentUser?.uid) {
        // 新版訂單一律寫入 ownerUid。近期列表以 Firebase UID 為唯一權威歸屬，
        // 避免每次進頁為了相容舊 salesCode / salesName 而串行執行 2～3 個重複 Query。
        sources.push({
            cursor: null,
            exhausted: false,
            query: () => db.collection('orders').where('ownerUid', '==', currentUser.uid).orderBy('orderDate', 'desc')
        });
    }
    return { sources, sourceIndex: 0 };
}

function updateOrderLoadMoreButton() {
    const button = document.getElementById('orderLoadMoreBtn');
    const refreshButton = document.getElementById('orderRefreshBtn');
    const hasMore = !!orderPaginationState && orderPaginationState.sourceIndex < orderPaginationState.sources.length;
    if (button) {
        button.style.display = (hasMore || !!orderLoadErrorMessage) ? '' : 'none';
        button.disabled = orderPageLoading;
        button.innerText = orderPageLoading ? '載入中…' : orderLoadErrorMessage || '載入更多（每次 50 筆）';
    }
    if (refreshButton) {
        refreshButton.disabled = orderPageLoading;
        refreshButton.textContent = orderPageLoading ? '更新中…' : '↻ 更新';
    }
}

async function loadOrderPage(reset, options = {}) {
    if (orderPageLoading) {
        if (!options.force) {
            if (reset) orderReloadRequested = true;
            return;
        }
        // iOS 切到背景時，Firestore 的舊 Promise 可能永遠不完成。讓舊代次失效，
        // 新查詢可以立即開始；舊 Promise 之後即使回來也不能覆蓋新畫面。
        orderLoadGeneration++;
        orderPageLoading = false;
        orderReloadRequested = false;
    }
    if (getDataScope('orders') === 'none') {
        ordersCache = [];
        orderPaginationState = null;
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        updateOrderLoadMoreButton();
        return;
    }
    if (reset || !orderPaginationState) {
        orderPaginationState = createOrderPaginationState();
    }
    const generation = ++orderLoadGeneration;
    orderPageLoading = true;
    orderLoadErrorMessage = '';
    const requestedRole = currentUserRole, requestedUid = currentUser?.uid;
    updateOrderLoadMoreButton();
    // 重新整理期間保留舊畫面，避免慢網路時先清空成整頁白色。
    const records = new Map((reset ? [] : ordersCache).map(order => [order.id, order]));
    let remainingReads = DEFAULT_LIST_LIMIT;
    try {
        while (remainingReads > 0 && orderPaginationState.sourceIndex < orderPaginationState.sources.length) {
            const source = orderPaginationState.sources[orderPaginationState.sourceIndex];
            const requested = remainingReads;
            let query = source.query().limit(requested);
            if (source.cursor) query = query.startAfter(source.cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '訂單');
            if (generation !== orderLoadGeneration || requestedUid !== currentUser?.uid) return;
            if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid) {
                orderReloadRequested = true;
                return;
            }
            if (!snapshot.empty) {
                source.cursor = snapshot.docs[snapshot.docs.length - 1];
                snapshot.forEach(doc => records.set(doc.id, { id: doc.id, ...doc.data() }));
                ordersCache = [...records.values()];
            }
            remainingReads -= snapshot.size;
            if (snapshot.size < requested) {
                source.exhausted = true;
                orderPaginationState.sourceIndex++;
            }
        }
        if (generation !== orderLoadGeneration || requestedUid !== currentUser?.uid) return;
        orderWorkQueueCache.forEach(row => { if(!records.has(row.id)) records.set(row.id,row); });
        ordersCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'orderDate', 'id'));
        writeAppDataCache('orders', ordersCache);
        // 訂單頁與採購頁共用同一份 ordersCache；只要這次雲端訂單讀取已成功，
        // 採購頁第一次切入待採購／待打單時就直接沿用，不再重查同一批 orders。
        purchasingOrdersReady = true;
        if (!options.skipRender) {
            if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
            else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        }
    } catch (err) {
        if (generation !== orderLoadGeneration || requestedUid !== currentUser?.uid) return;
        mainPageLoadFailed('orders.list');
        console.error("讀取訂單失敗：", err);
        if (records.size) {
            ordersCache = [...records.values()].sort((a, b) => compareBusinessRecordsNewestFirst(a, b, 'orderDate', 'id'));
        }
        if (!options.skipRender) {
            if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
            else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        }
        if (err?.code === 'firestore-read-timeout') {
            orderLoadErrorMessage = '連線逾時，點此重試';
        } else {
            orderLoadErrorMessage = '讀取失敗，點此重試';
            if (!options.silent) alert('讀取訂單資料失敗，請確認網路或 Firestore 權限設定。');
        }
    } finally {
        if (generation !== orderLoadGeneration || requestedUid !== currentUser?.uid) return;
        orderPageLoading = false;
        updateOrderLoadMoreButton();
        if (orderReloadRequested) {
            orderReloadRequested = false;
            loadOrderPage(true);
        }
    }
}

// 訂單資料範圍由固定角色權限決定：業務/工程師只看自己，採購/倉管查看全部。
// 首次與重新整理只載入 50 筆；歷史資料由「載入更多」明確取得，避免資料增加後
// 每次進入訂單頁都在背景掃完整個 orders 集合。
window.loadOrdersFromCloud = function() {
    return loadOrderPage(true);
};

window.loadMoreOrders = function() {
    return loadOrderPage(false);
};

function normalizeFullHistorySearchValue(value) {
    return String(value || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[\s\-_.\/\\,，。:：;；()（）\[\]{}]+/g, '');
}

function normalizeHistoryItemCode(value) {
    return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function fullHistorySearchValues(type, record = {}) {
    if (type === 'equipment') {
        return [
            record.assetId, record.customerName, record.brand, record.model,
            record.serialNo, record.salesName, record.location, record.notes
        ];
    }
    if (type === 'forecast') {
        return [
            record.customerName, record.brand, record.productName, record.latestProgress,
            record.salesName, forecastStageLabel(record.stage), forecastStatusLabel(record.status)
        ];
    }
    if (type === 'quote') {
        return [
            record.quoteNo, record.clientName, record.ordererName, record.salesName, record.remarks,
            ...(Array.isArray(record.items) ? record.items.flatMap(item => [
                item.brand, item.model, item.nameCn, item.nameEn, item.spec,
                item.origin, item.leadTime, item.hospitalItemCode,
                ...(Array.isArray(item.customFields) ? item.customFields.flatMap(field => [field.label, field.value]) : [])
            ]) : [])
        ];
    }
    return [
        record.id, record.orderNo, record.quoteNo, record.customerName, record.brand,
        record.itemCode, record.itemName, record.salesName, record.purchaseOrderNo,
        record.invoiceTitle, record.productLine, record.spec,
        ...(Array.isArray(record.items) ? record.items.flatMap(item => [
            item.itemId, item.brand, item.itemCode, item.itemName, item.productLine,
            item.productType, item.spec, ...(Array.isArray(item.purchaseOrderNos) ? item.purchaseOrderNos : [])
        ]) : [])
    ];
}

function fullHistoryBaseTokens(type, record = {}) {
    const tokens = new Set();
    const MAX_BASE_TOKENS = 180;
    for (const raw of fullHistorySearchValues(type, record)) {
        const normalized = normalizeFullHistorySearchValue(raw);
        if (!normalized) continue;
        tokens.add(normalized);
        const maxGram = Math.min(6, normalized.length);
        for (let size = 1; size <= maxGram; size += 1) {
            for (let i = 0; i + size <= normalized.length; i += 1) {
                tokens.add(normalized.slice(i, i + size));
                if (tokens.size >= MAX_BASE_TOKENS) return [...tokens];
            }
        }
    }
    return [...tokens];
}

function buildFullHistorySearchTokens(type, record = {}) {
    const base = fullHistoryBaseTokens(type, record);
    const tokens = new Set(base);
    const salesCode = String(record.salesCode || '').trim();
    const ownerUid = String(record.ownerUid || '').trim();
    const salesName = normalizeFullHistorySearchValue(record.salesName || '');
    base.forEach(token => {
        if (salesCode) tokens.add(`sc:${salesCode}:${token}`);
        if (ownerUid) tokens.add(`uid:${ownerUid}:${token}`);
        if (salesName) tokens.add(`sn:${salesName}:${token}`);
    });
    return [...tokens].slice(0, 700);
}

function fullHistoryServerToken(keyword) {
    const normalized = normalizeFullHistorySearchValue(keyword);
    return normalized.length > 6 ? normalized.slice(0, 6) : normalized;
}

function fullHistoryQueryToken(type, keyword) {
    const token = fullHistoryServerToken(keyword);
    if (!token) return '';
    const canViewAll = type === 'quote' ? canViewAllData('quotes')
        : type === 'forecast' ? canViewAllData('forecast')
        : type === 'equipment' ? canViewAllEquipment()
        : canViewAllData('orders');
    if (canViewAll) return token;
    if (currentUserCode) return `sc:${currentUserCode}:${token}`;
    if (currentUser?.uid) return `uid:${currentUser.uid}:${token}`;
    if (currentUserName) return `sn:${normalizeFullHistorySearchValue(currentUserName)}:${token}`;
    return '';
}

function scopedHistorySearchQuery(collectionName, queryToken) {
    let query = db.collection(collectionName).where('searchTokens', 'array-contains', queryToken);
    const scopeKey = collectionName === 'quotes' ? 'quotes' : collectionName === 'forecasts' ? 'forecast' : 'orders';
    if (!canViewAllData(scopeKey)) {
        if (currentUserCode) query = query.where('salesCode', '==', currentUserCode);
        else if (currentUser?.uid) query = query.where('ownerUid', '==', currentUser.uid);
    }
    return query;
}

function fullHistoryRecordMatches(type, record, keyword) {
    const needle = normalizeFullHistorySearchValue(keyword);
    if (!needle) return true;
    return fullHistorySearchValues(type, record)
        .some(value => normalizeFullHistorySearchValue(value).includes(needle));
}

/*
 * 統一全歷史搜尋：估價單／訂單使用 searchTokens 後端索引；
 * 一般列表仍每次只載入 50 筆，搜尋則自動逐頁讀完符合索引的候選資料。
 */
let orderHistorySearchActive = false;
let orderHistorySearchLoading = false;
let orderHistorySearchKeyword = '';
let orderHistorySearchResults = [];
let orderHistorySearchTimer = null;
let orderHistorySearchGeneration = 0;

function updateOrderHistorySearchUi(message = '') {
    const status = document.getElementById('orderHistorySearchStatus');
    if (status) status.innerText = message;
}

async function runOrderHistorySearch() {
    const generation = ++orderHistorySearchGeneration;
    const input = document.getElementById('orderSearch');
    const rawKeyword = input?.value || '';
    const normalized = normalizeFullHistorySearchValue(rawKeyword);
    if (!normalized) {
        orderHistorySearchActive = false;
        orderHistorySearchLoading = false;
        orderHistorySearchKeyword = '';
        orderHistorySearchResults = [];
        updateOrderHistorySearchUi('');
        renderOrdersList();
        return;
    }
    const queryToken = fullHistoryQueryToken('order', rawKeyword);
    if (!queryToken) {
        orderHistorySearchActive = false;
        orderHistorySearchLoading = false;
        orderHistorySearchResults = [];
        updateOrderHistorySearchUi('目前帳號缺少可用的資料歸屬資訊，無法進行全歷史搜尋。');
        renderOrdersList();
        return;
    }

    orderHistorySearchLoading = true;
    orderHistorySearchActive = true;
    orderHistorySearchKeyword = rawKeyword;
    orderHistorySearchResults = [];
    const records = new Map();
    let cursor = null;
    let checked = 0;
    let lastIntermediateRenderAt = 0;
    updateOrderHistorySearchUi('正在搜尋全部歷史訂單…');
    renderOrdersList();

    try {
        while (true) {
            let query = scopedHistorySearchQuery('orders', queryToken).limit(DEFAULT_LIST_LIMIT);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '訂單索引搜尋');
            if (generation !== orderHistorySearchGeneration) return;

            checked += snapshot.size;
            snapshot.forEach(doc => {
                const data = { id: doc.id, ...doc.data() };
                if (fullHistoryRecordMatches('order', data, rawKeyword)) records.set(doc.id, data);
            });
            const now = Date.now();
            if (now - lastIntermediateRenderAt >= 100 || snapshot.size < DEFAULT_LIST_LIMIT) {
                lastIntermediateRenderAt = now;
                orderHistorySearchResults = [...records.values()]
                    .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'orderDate','id'));
                renderOrdersList();
            }
            updateOrderHistorySearchUi(`全歷史搜尋中：已檢查 ${checked} 筆候選資料，找到 ${records.size} 筆…`);

            if (snapshot.size < DEFAULT_LIST_LIMIT) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
            await Promise.resolve();
        }
        if (generation !== orderHistorySearchGeneration) return;
        orderHistorySearchResults = [...records.values()]
            .sort((a,b)=>compareBusinessRecordsNewestFirst(a,b,'orderDate','id'));
        updateOrderHistorySearchUi(`全歷史搜尋完成：找到 ${records.size} 筆`);
    } catch (err) {
        if (generation !== orderHistorySearchGeneration) return;
        console.error('訂單全歷史搜尋失敗：', err);
        orderHistorySearchActive = false;
        orderHistorySearchResults = [];
        updateOrderHistorySearchUi('全歷史搜尋索引尚未補齊，請管理員到資料庫管理執行搜尋索引補建。');
        renderOrdersList();
    } finally {
        if (generation === orderHistorySearchGeneration) {
            orderHistorySearchLoading = false;
            renderOrdersList();
        }
    }
}

window.scheduleOrderHistorySearch = function() {
    clearTimeout(orderHistorySearchTimer);
    const keyword = document.getElementById('orderSearch')?.value || '';
    if (!normalizeFullHistorySearchValue(keyword)) return runOrderHistorySearch();
    orderHistorySearchTimer = scheduleListSearch(orderHistorySearchTimer, () => runOrderHistorySearch());
};

window.searchAllOrderHistory = function() { return runOrderHistorySearch(); };
window.clearOrderHistorySearch = function() {
    clearTimeout(orderHistorySearchTimer);
    orderHistorySearchGeneration++;
    orderHistorySearchLoading = false;
    orderHistorySearchActive = false;
    orderHistorySearchKeyword = '';
    orderHistorySearchResults = [];
    const input = document.getElementById('orderSearch');
    if (input) input.value = '';
    updateOrderHistorySearchUi('');
    renderOrdersList();
};

// 依「成本」跟「單價（售價）」計算利潤%// 依「成本」跟「單價（售價）」計算利潤% = (售價－成本) / 成本 × 100，也就是以成本為基準的加成率
function formatProfitPercent(unitPrice, costPrice) {
    const price = parseFloat(unitPrice);
    const cost = parseFloat(costPrice);
    if (!isFinite(price) || !isFinite(cost) || cost <= 0) return '－';
    const percent = ((price - cost) / cost) * 100;
    return percent.toFixed(1) + '%';
}

// 輸入含稅成本的當下（還沒存雲端前），先在畫面上即時算出利潤%，打字就能馬上看到，不用等存檔
window.updateOrderProfitDisplay = function(orderId, costValue) {
    const o = ordersCache.find(x => x.id === orderId);
    if (!o) return;
    const span = document.getElementById('orderProfit_' + orderId);
    if (span) span.innerText = formatProfitPercent(o.unitPrice, costValue);
};

// 能查看所有人訂單的身份，可依業務與廠牌篩選。
function orderBrandFilterValue(value, selectableBrands) {
    const key = normalizeBrandLookupKey(resolveBrandName(value));
    if (!key) return '';
    return selectableBrands.find(brand => normalizeBrandLookupKey(brand) === key) || OTHER_BRAND_OPTION_KEY;
}

let orderFilterOptionsSignature = '';

function workflowSalesFilterNames() {
    return [...new Set(salesList.map(person => stripPhoneSuffix(person.name)).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
}

function workflowPurchasingBrandNames() {
    // 訂單／採購篩選與估價／訂單輸入共用同一份「獨立統計」主要廠牌清單。
    return getPrimaryBrandNames();
}

function populatePurchaserOrderFilters() {
    const wrap = document.getElementById('purchaserOrderFilters');
    const salesSelect = document.getElementById('orderSalesFilter');
    const brandSelect = document.getElementById('orderBrandFilter');
    if (!wrap || !salesSelect || !brandSelect) return;

    const enabled = canViewAllData('orders');
    wrap.style.display = enabled ? '' : 'none';
    if (!enabled) {
        salesSelect.value = '';
    }

    const salesValue = salesSelect.value;
    const brandValue = brandSelect.value;
    const sales = workflowSalesFilterNames();
    const brands = workflowPurchasingBrandNames();
    const signature = JSON.stringify([enabled, sales, brands]);

    // 訂單頁與採購頁都用正式人員名單，不再依目前載入的 50 筆訂單臨時產生選項。
    // 選項沒變時也不要每次 render 都重建 select DOM。
    if (signature !== orderFilterOptionsSignature) {
        if (enabled) {
            salesSelect.innerHTML = '<option value="">全部負責業務</option>' + sales.map(name =>
                `<option value="${escapeAttr(name)}">${escapeHtml(name)}</option>`).join('');
        }
        brandSelect.innerHTML = '<option value="">全部廠牌</option>' + brands.map(brand =>
            `<option value="${escapeAttr(brand)}">${escapeHtml(brand)}</option>`).join('')
            + `<option value="${OTHER_BRAND_OPTION_KEY}">其他廠牌</option>`;
        orderFilterOptionsSignature = signature;
    }
    if (enabled && sales.includes(salesValue)) salesSelect.value = salesValue;
    else if (enabled && salesSelect.value && !sales.includes(salesSelect.value)) salesSelect.value = '';
    if (brands.includes(brandValue) || brandValue === OTHER_BRAND_OPTION_KEY) brandSelect.value = brandValue;
    else if (brandSelect.value && !brands.includes(brandSelect.value)) brandSelect.value = '';
    return brands;
}


window.renderOrdersList = function() {
    const tbody = document.getElementById('ordersBody');
    const searchInput = document.getElementById('orderSearch');
    if (!tbody || !searchInput) return;

    const canManageOrderOps = currentUserRole === 'purchaser' || currentUserRole === 'admin';
    const canEditOrders = canEditPage('orders.list');
    const canManageOrderLifecycle = canManageOrderLifecycleCapability();
    const canConfirmOrderDelivery = canManageOrderLifecycle;
    const costHeader = document.getElementById('orderCostHeader');
    if (costHeader) costHeader.style.display = '';

    const selectableBrands = populatePurchaserOrderFilters() || [];
    const salesFilter = document.getElementById('orderSalesFilter')?.value || '';
    const brandFilter = document.getElementById('orderBrandFilter')?.value || '';
    const keyword = (searchInput.value || '').toLowerCase();
    tbody.innerHTML = '';
    const fragment = document.createDocumentFragment();
    let shown = 0;

    const visibleOrderSource = orderHistorySearchActive ? orderHistorySearchResults : ordersCache;
    // 同一次列表 render 每筆訂單只 normalize 一次，避免搜尋、廠牌篩選、狀態卡片與產品欄重複處理 items。
    const normalizedItemsByOrder = new Map(visibleOrderSource.map(o => [o.id, normalizedOrderItems(o)]));
    const baseOrders = visibleOrderSource.filter(o => {
        const orderItems = normalizedItemsByOrder.get(o.id) || [];
        if (!orderHistorySearchActive && keyword) {
            const itemSearchable = orderItems.flatMap(item => [
                item.brand, item.itemCode, item.itemName, item.productLine, item.productType, item.spec
            ]).join(' ');
            const searchable = `${o.customerName || ''} ${o.brand || ''} ${o.itemCode || ''} ${o.itemName || ''} ${o.quoteNo || ''} ${o.salesName || ''} ${itemSearchable}`.toLowerCase();
            if (!searchable.includes(keyword)) return false;
        }
        if (salesFilter && stripPhoneSuffix(o.salesName) !== salesFilter) return false;
        if (brandFilter && !orderItems.some(item => orderBrandFilterValue(item.brand, selectableBrands) === brandFilter)
            && orderBrandFilterValue(o.brand, selectableBrands) !== brandFilter) return false;
        return true;
    });
    // 工作圖卡與下方訂單列共用同一份 dispatch snapshot；
    // 每個品項在一次 render 內只掃一次送貨／退貨紀錄。
    const dispatchStatesByOrder = new Map(baseOrders.map(order => {
        const items = normalizedItemsByOrder.get(order.id) || [];
        return [order.id, new Map(items.map(item => [item, itemDispatchState(order, item)]))];
    }));
    const lifecyclesByOrder = new Map(baseOrders.map(order => [
        order.id,
        orderLifecycleInfo(order, normalizedItemsByOrder.get(order.id) || [])
    ]));
    renderOrderWorkCards(baseOrders, normalizedItemsByOrder, dispatchStatesByOrder, lifecyclesByOrder);

    baseOrders.forEach(o => {
        const allOrderItems = normalizedItemsByOrder.get(o.id) || [];
        const lifecycle = lifecyclesByOrder.get(o.id) || orderLifecycleInfo(o, allOrderItems);
        const dispatchStateByItem = dispatchStatesByOrder.get(o.id) || new Map();
        const displayCategoriesByItem = new Map(
            allOrderItems.map(item => [item, orderItemDisplayCategories(o, item, lifecycle, dispatchStateByItem.get(item))])
        );
        const categories=[...new Set(allOrderItems.flatMap(item=>displayCategoriesByItem.get(item) || []))];
        if(activeOrderWorkFilter!=='all'&&!categories.includes(activeOrderWorkFilter))return;
        if (activeOrderWorkFilter === 'complete' && !orderMatchesWorkPeriod(o,'complete')) return;
        // 工作圖卡是以「品項」計數；套用狀態篩選後，產品欄也只顯示該狀態品項，
        // 避免同一張多品項訂單把其他狀態的品項一起帶進來造成誤判。
        const orderItems=activeOrderWorkFilter==='all'
            ? allOrderItems
            : allOrderItems.filter(item=>(displayCategoriesByItem.get(item) || []).includes(activeOrderWorkFilter));
        shown++;

        const tr = document.createElement('tr');
        if (canManageOrderOps && (o.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER') {
            loadVisibleProductCost(findPriceItemForOrder(o) || {productId:o.productId}).then(cost => {
                if (!tr.isConnected || cost === null || !Number.isFinite(cost)) return;
                const input = tr.querySelector('.order-cost-input');
                if (input) input.value = String(Number(cost.toFixed(2)));
                const profit = tr.querySelector('[id^="orderProfit_"]');
                if (profit) profit.textContent = formatProfitPercent(o.unitPrice, cost);
            });
        }
        // 這些摘要共用上方已算好的 dispatch state，不再各自掃描送貨／退貨紀錄。
        const deliveryProgress = deliveryProgressInfo(o, allOrderItems);
        const fulfillmentProgress = canConfirmOrderDelivery ? fulfillmentProgressInfo(o, allOrderItems, dispatchStateByItem) : null;
        const contextActions = orderContextActionState(o, allOrderItems, dispatchStateByItem);
        const useBatchDelivery = orderDeliveryRequiresItemForm(allOrderItems, deliveryProgress, fulfillmentProgress);
        const deliveryPending = pendingDeliveryOrderIds.has(o.id);
        const billingPending = pendingOrderStatusKeys.has(o.id + ':isBilled');
        if (lifecycle.status !== 'normal') {
            tr.classList.add('order-row-closed');
        }
        bindListRowSelection(tr);
        tr.innerHTML = `
            <td class="order-date-cell" data-th="訂單日期">${escapeHtml(o.orderDate || '')}</td>
            <td class="order-customer-cell" data-th="客戶名稱"><div class="record-reference">客戶訂單${o.orderNo ? `・${escapeHtml(o.orderNo)}` : o.quoteNo ? `・來源估價單 ${escapeHtml(o.quoteNo)}` : ''}</div>${o.customerName ? `<button type="button" class="btn-small btn-secondary" onclick="showCustomerOrderHistory(${inlineJsValue(o.customerName)})">${escapeHtml(o.customerName)}</button>` : ''}</td>
            <td class="order-sales-cell" data-th="負責業務">${escapeHtml(stripPhoneSuffix(o.salesName))}</td>
            <td data-th="產品資訊" class="order-product-cell">${orderItems.map((item,index)=>{const displayCategories=displayCategoriesByItem.get(item)||[];const primaryStatus=displayCategories[0]||'ordering';const itemStatus=['dispatch','shipping'].includes(activeOrderWorkFilter)&&displayCategories.includes(activeOrderWorkFilter)?activeOrderWorkFilter:primaryStatus;const itemStatusMap={ordering:'待採購',arrival:'待到貨',dispatch:'待打單',shipping:'已打單',billing:'待核銷',complete:'已完成',closed:lifecycle.label};const waiting=primaryStatus==='arrival'?waitingDaysFromDate(item.orderedAt):'';const state=dispatchStateByItem.get(item)||itemDispatchState(o,item);const parallelDispatch=primaryStatus!=='dispatch'&&state.pending>0;return `<div style="${index?'margin-top:5px;padding-top:5px;border-top:1px solid #eee;':''}"><strong>${escapeHtml(item.itemName || '－')}</strong><small>${escapeHtml(item.brand || '未分類')}${item.itemCode ? `・${escapeHtml(item.itemCode)}` : ''}・${activeOrderWorkFilter==='shipping'?`已打單 ${state.shippable}／訂單數量 ${Number(item.orderedQty||item.qty||0)}`:activeOrderWorkFilter==='dispatch'?`待打單 ${state.pending}／訂單數量 ${Number(item.orderedQty||item.qty||0)}`:Number(item.orderedQty||item.qty||0)}</small><small class="order-item-work-status">訂單狀態：<span class="order-progress-badge">${escapeHtml(((lifecycle.status==='normal'&&orderInventorySyncIncomplete(o)) ? (o.inventoryReservationStatus==='failed'?'庫存同步未完成':'庫存同步中…') : ((lifecycle.status==='normal'&&globalThis.YushinWarehouseLogistics?.shippingStatus(o,item,state))||itemStatusMap[itemStatus]||'待採購')))}</span>${waiting?`・已等 ${escapeHtml(waiting)}`:''}${parallelDispatch&&itemStatus!=='dispatch'?`・另有 ${escapeHtml(state.pending)} 待打單`:''}${state.shippable>0?`・已有 ${escapeHtml(state.shippable)} 可出貨`:''}</small></div>`}).join('')}</td>
            <td data-th="訂單總額" class="order-money-cell"><strong>NT$ ${escapeHtml(Number(parseFloat(String(o.totalPrice ?? '').replace(/,/g, '')) || 0).toLocaleString())}</strong><small>${o.isBilled ? '已核銷' : '未核銷'}</small></td>
            <td class="order-details-cell">
                <div class="order-text-summary">${escapeHtml([o.transactionType ? `交易：${o.transactionType}` : '', o.invoiceTitle || '', o.isBilled && orderBillingDate(o) ? `核銷日期：${orderBillingDate(o)}` : '', o.remarks || ''].filter(Boolean).join('・'))}</div>
                <details class="order-detail-panel">
                    <summary>查看明細${canEditOrders ? '／編輯' : ''}</summary>
                    <div class="order-detail-content">
                        <div class="order-item-prices">${allOrderItems.map(item => `<div>${escapeHtml(item.itemName || item.itemCode || '品項')}：NT$ ${escapeHtml(Number(item.unitPrice || 0).toLocaleString())} × ${escapeHtml(Number(item.orderedQty || item.qty || 0))}</div>`).join('')}</div>
            ${canManageOrderOps ? `
            <div class="no-print order-cost-profit-cell"><label>單位成本</label><input type="number" step="0.01" class="order-cost-input" data-order-id="${o.id}" ${(o.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER' ? 'readonly title="標準成本由產品成本資料帶入"' : ''} value="${o.procurementType === 'SALES_SELF_ORDER' ? (o.costPrice == null ? '' : Number(Number(o.costPrice).toFixed(2))) : ''}" oninput="updateOrderProfitDisplay('${o.id}', this.value)" onchange="updateOrderField('${o.id}','costPrice', this.value === '' ? null : parseFloat(this.value))"><small>毛利：<span id="orderProfit_${o.id}">${formatProfitPercent(o.unitPrice, o.costPrice)}</span></small></div>` : ''}
            <div class="order-transaction-cell"><label>交易資訊</label>
                <select onchange="updateOrderField('${o.id}','transactionType',this.value)">
                    <option value="" ${!o.transactionType ? 'selected' : ''}>未選擇</option>
                    <option value="直" ${o.transactionType === '直' ? 'selected' : ''}>直</option>
                    <option value="借" ${o.transactionType === '借' ? 'selected' : ''}>借</option>
                    <option value="扣" ${o.transactionType === '扣' ? 'selected' : ''}>扣</option>
                </select>
                ${o.transactionType === '直' ? `<input type="text" aria-label="發票抬頭" placeholder="發票抬頭" value="${escapeAttr(o.invoiceTitle || '')}" onchange="updateOrderField('${o.id}','invoiceTitle',this.value)">` : ''}
                ${o.isBilled ? `<label class="order-invoice-date-label">核銷日期<input type="date" aria-label="核銷日期" value="${escapeAttr(orderBillingDate(o))}" onchange="updateOrderBillingDate('${o.id}',this.value)"></label>` : ''}
            </div>
            <label class="order-remarks-editor">備註<input type="text" value="${escapeAttr(o.remarks || '')}" placeholder="備註" onchange="updateOrderField('${o.id}','remarks',this.value)"></label>
                    </div>
                </details>
            </td>
            <td class="no-print" data-th="操作">
                ${orderInventorySyncStatusHtml(o)}
                <div class="order-compact-actions">
                    ${selfOrderActionHtml(o, allOrderItems, dispatchStateByItem)}
                    ${directShipReceiptActionHtml(o, allOrderItems)}
                    
                    ${canConfirmOrderDelivery && lifecycle.status === 'normal' && deliveryProgress.state !== 'complete' && (fulfillmentProgress.shippable>0 || deliveryPending) ? `<button type="button" class="btn-small" onclick="${useBatchDelivery ? 'openPartialDeliveryForOrder' : 'quickCompleteDelivery'}(${inlineJsValue(o.id)})" ${orderInventorySyncIncomplete(o) || lifecycle.status !== 'normal' || deliveryPending || deliveryProgress.state === 'complete' || fulfillmentProgress.shippable<=0 ? 'disabled' : ''}>${deliveryPending ? '處理中…' : useBatchDelivery ? '已送貨（分批）' : '已送貨'}</button>` : ''}
                    ${canBusinessSelfOrder(o) ? `<button type="button" class="btn-small ${o.isBilled ? 'btn-secondary' : ''}" onclick="toggleOrderStatus('${o.id}', 'isBilled', ${!o.isBilled})" ${lifecycle.status !== 'normal' || billingPending ? 'disabled' : ''}>${billingPending ? '儲存中…' : o.isBilled ? '已核銷' : '核銷'}</button>` : ''}
                    <details class="order-more-menu">
                        <summary title="更多操作">⋯</summary>
                        <div class="order-more-menu-popover">
                            ${orderLifecycleActionButtons(o, lifecycle, deliveryProgress, contextActions)}
                            <button type="button" onclick="copyOrderAsNew('${o.id}')">複製成新訂單</button>
                            <button type="button" onclick="openOrderStatusHistory('${o.id}')">紀錄</button>
                            ${trueUserRole === 'admin' && currentUserRole === 'admin' ? `<button type="button" class="danger-menu-item" onclick="permanentlyDeleteOrder(${inlineJsValue(o.id)})" ${pendingLifecycleOrderIds.has(o.id) ? 'disabled aria-busy="true"' : ''}>${pendingLifecycleOrderIds.has(o.id) ? '處理中…' : '永久刪除'}</button>` : ''}
                        </div>
                    </details>
                </div>
            </td>
        `;
        if (!canEditOrders) {
            tr.querySelectorAll('.order-transaction-cell select, .order-transaction-cell input, .order-remarks-editor input').forEach(control => {
                control.disabled = true;
                control.setAttribute('aria-readonly', 'true');
            });
            tr.querySelectorAll('.order-more-menu-popover button').forEach(button => {
                const action = button.getAttribute('onclick') || '';
                if (!action.includes('openOrderStatusHistory(')) button.remove();
            });
        }
        fragment.appendChild(tr);
    });
    tbody.appendChild(fragment);
    document.getElementById('ordersEmptyHint').style.display = shown === 0 ? 'block' : 'none';
    document.getElementById('ordersEmptyHint').textContent = orderHistorySearchLoading || !orderWorkQueueReady ? (orderWorkQueueError || '正在讀取訂單…') : '查無符合條件的訂單。';
    // 採購頁打開時才重算其工作卡；切頁時會用同一份 ordersCache 立即產生。
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
};

function orderSourceSyncIncomplete(order) {
    return ['pending','failed'].includes(order?.sourceDocumentSyncStatus);
}
function canRetrySourceDocumentSync(order) {
    return canRetryOrderInventorySync(order) && (order.sourceType!==DOCUMENT_TYPES.FORECAST
        || currentUserRole==='admin' || (currentUserRole==='sales'&&order.ownerUid===currentUser?.uid));
}
async function syncNewOrderSourceDocuments(orderId,data,actorUid) {
    if(currentUser?.uid!==actorUid)return new Error('登入身份已變更，來源文件同步待確認');
    const orderRef=db.collection('orders').doc(orderId);
    let sourceType='',sourceId='',quotePatch=null;
    try{
        const saved=await runRoleTransaction(async tx=>{
            const snap=await tx.get(orderRef);
            if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更');
            if(!snap.exists)throw new Error('訂單已不存在');
            const order={id:orderId,...snap.data()};
            sourceType=order.sourceType||'';sourceId=order.sourceId||'';
            if(![DOCUMENT_TYPES.QUOTE,DOCUMENT_TYPES.FORECAST].includes(sourceType)||!sourceId)return order;
            if(normalizedOrderStatus(order)!=='normal')throw new Error('訂單已取消／作廢，停止來源文件同步');
            if(orderInventorySyncIncomplete(order))throw new Error('庫存尚未同步完成，來源文件稍後再同步');
            if(order.sourceDocumentSyncStatus==='completed')return order;
            if(!canRetrySourceDocumentSync(order))throw new Error('來源文件請由負責業務或管理員同步');
            const ref=db.collection(sourceType===DOCUMENT_TYPES.QUOTE?'quotes':'forecasts').doc(sourceId);
            const source=await tx.get(ref);
            if(!source.exists)throw new Error('來源文件已不存在，不能重新建立來源文件');
            if(normalizedOrderStatus(source.data())!=='normal')throw new Error('來源文件已取消／作廢，請先確認訂單關聯');
            if(currentUser?.uid!==actorUid)throw new Error('登入身份已變更');
            const now=new Date().toISOString();
            const patch={linkedDocuments:firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.ORDER,orderId,'created')),updatedAt:now};
            if(sourceType===DOCUMENT_TYPES.QUOTE){
                quotePatch={dealClosed:true,dealClosedAt:source.data().dealClosedAt||localDateString(),status:BUSINESS_STATUS.COMPLETED};
                Object.assign(patch,quotePatch);
            }
            tx.update(ref,patch);
            const updates={sourceDocumentSyncStatus:'completed',sourceDocumentSyncError:'',sourceDocumentSyncUpdatedAt:now,updatedAt:now};
            tx.update(orderRef,updates);
            return {...order,...updates};
        });
        if(currentUser?.uid===actorUid){
            Object.assign(data,saved);
            if(quotePatch){
                const cached=myQuotesCache.find(q=>q.quoteNo===sourceId);if(cached)Object.assign(cached,quotePatch);
                const searched=quoteHistorySearchResults.find(q=>q.quoteNo===sourceId);if(searched)Object.assign(searched,quotePatch);
                writeAppDataCache('quotes',myQuotesCache);
            }
        }
        return null;
    }catch(err){
        // The source update and completion checkpoint are atomic. Lost replies must not downgrade completion.
        const latest=await runRoleTransaction(async tx=>{
            const snap=await tx.get(orderRef);
            if(currentUser?.uid!==actorUid||!snap.exists)return null;
            const order={id:orderId,...snap.data()};
            if(!canRetryOrderInventorySync(order))return null;
            if(order.sourceType!==sourceType||order.sourceId!==sourceId||!sourceId)return null;
            if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order))return order;
            if(order.sourceDocumentSyncStatus==='completed')return order;
            const updates={sourceDocumentSyncStatus:'failed',sourceDocumentSyncError:String(err?.message||err).slice(0,1000),sourceDocumentSyncUpdatedAt:new Date().toISOString()};
            tx.update(orderRef,updates);
            return {...order,...updates};
        }).catch(markErr=>{console.error('來源文件同步結果尚未確認：',markErr);return null;});
        if(latest&&currentUser?.uid===actorUid)Object.assign(data,latest);
        return latest?.sourceDocumentSyncStatus==='completed'?null:err;
    }
}

const pendingOrderReservationIds = new Set();
function orderInventorySyncIncomplete(order) {
    return ['pending','failed'].includes(order?.inventoryReservationStatus);
}
function canRetryOrderInventorySync(order) {
    return currentUserRole==='admin'||currentUserRole==='purchaser'
        ||(['sales','engineer'].includes(currentUserRole)&&!!currentUser?.uid&&order?.ownerUid===currentUser.uid);
}
async function writeOrderInventorySyncState(orderId, status, expectedAttemptId, uid, error = '') {
    if(!['pending','completed','failed'].includes(status))throw new Error('不支援的庫存同步狀態。');
    const ref=db.collection('orders').doc(orderId);
    const nextAttemptId=status==='pending'?db.collection('orders').doc().id:'';
    return runRoleTransaction(async tx=>{
        const snap=await tx.get(ref);
        if(currentUser?.uid!==uid)throw new Error('登入身份已變更，請以原帳號重試同步。');
        if(!snap.exists)throw new Error('訂單已不存在。');
        const order={id:orderId,...snap.data()};
        if(!canRetryOrderInventorySync(order))throw new Error('無權同步這筆訂單。');
        const attemptId=String(order.inventoryReservationAttemptId||'');
        if(normalizedOrderStatus(order)!=='normal'||order.inventoryReservationStatus==='completed'||attemptId!==String(expectedAttemptId||'')){
            return {applied:false,order};
        }
        if(status!=='pending'&&order.inventoryReservationStatus!=='pending')return {applied:false,order};
        const updates={inventoryReservationStatus:status,inventoryReservationError:status==='failed'?String(error).slice(0,1000):'',
            inventoryReservationAttemptId:status==='pending'?nextAttemptId:attemptId,inventoryReservationUpdatedAt:new Date().toISOString()};
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        tx.update(ref,updates);
        return {applied:true,order:{...order,...updates}};
    });
}
async function synchronizeOrderInventory(orderId, order, uid = currentUser?.uid) {
    const started=await writeOrderInventorySyncState(orderId,'pending',order.inventoryReservationAttemptId||'',uid);
    Object.assign(order,started.order);
    if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消／作廢的訂單不可同步庫存。');
    if(order.inventoryReservationStatus==='completed')return orderReservationSummary(order);
    if(!started.applied)throw new Error('已有較新的庫存同步工作，請更新這筆訂單後確認結果。');
    const attemptId=order.inventoryReservationAttemptId;
    try{
        await reserveInventoryForNewOrder(orderId,order,uid);
        const finished=await writeOrderInventorySyncState(orderId,'completed',attemptId,uid);
        Object.assign(order,finished.order);
        if(normalizedOrderStatus(order)!=='normal')throw new Error('訂單已取消／作廢，停止後續同步。');
        if(order.inventoryReservationStatus!=='completed')throw new Error('已有較新的庫存同步工作，請更新這筆訂單後確認結果。');
        return {...orderReservationSummary(order),items:order.items};
    }catch(err){
        const failed=await writeOrderInventorySyncState(orderId,'failed',attemptId,uid,String(err?.message||err))
            .catch(markErr=>{console.error('標記庫存同步結果失敗：',markErr);return null;});
        if(failed)Object.assign(order,failed.order);
        // Another attempt may already have completed while this older callback failed.
        if(failed&&normalizedOrderStatus(order)==='normal'&&order.inventoryReservationStatus==='completed')return {...orderReservationSummary(order),items:order.items};
        throw err;
    }
}
function orderInventorySyncStatusHtml(order) {
    if(normalizedOrderStatus(order)!=='normal')return '';
    if(!orderInventorySyncIncomplete(order)&&!orderSourceSyncIncomplete(order))return '';
    const running=pendingOrderReservationIds.has(order.id);
    const label=running?'訂單同步中…':!orderInventorySyncIncomplete(order)?'來源文件同步未完成':order.inventoryReservationStatus==='failed'?'庫存同步未完成':'庫存同步待確認';
    const canRetry=orderInventorySyncIncomplete(order)?canRetryOrderInventorySync(order):canRetrySourceDocumentSync(order);
    return `<div class="inline-status" role="status">${label}${!running&&canRetry?` <button type="button" class="btn-small" onclick="retryOrderInventoryReservation(${inlineJsValue(order.id)})">重試同步</button>`:''}</div>`;
}
window.addEventListener('beforeunload',event=>{
    if(pendingOrderReservationIds.size){event.preventDefault();event.returnValue='';}
});
window.retryOrderInventoryReservation = async function(orderId) {
    const cachedOrder=ordersCache.find(row=>row.id===orderId);
    if(!cachedOrder||!canRetryOrderInventorySync(cachedOrder)||(!orderInventorySyncIncomplete(cachedOrder)&&!orderSourceSyncIncomplete(cachedOrder))||pendingOrderReservationIds.has(orderId))return;
    const uid=currentUser?.uid;
    pendingOrderReservationIds.add(orderId);
    renderOrdersList();
    let order=null;
    try{
        const snap=await firestoreReadWithTimeout(db.collection('orders').doc(orderId).get(),'讀取待同步訂單');
        if(!snap.exists)throw new Error('訂單已不存在');
        order={id:snap.id,...snap.data()};
        if(currentUser?.uid!==uid||!canRetryOrderInventorySync(order))throw new Error('登入身份或權限已變更');
        if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消／作廢的訂單不可同步庫存');
        if(order.inventoryReservationStatus!=='completed'){
            await synchronizeOrderInventory(orderId,order,uid);
        }
        if(currentUser?.uid===uid){
            ordersCache=ordersCache.map(row=>row.id===orderId?order:row);
            syncOrderIntoPurchasingCaches(order);
            const sourceError=await syncNewOrderSourceDocuments(orderId,order,uid);
            if(currentUser?.uid===uid)showActionFeedback(sourceError?'庫存已同步；來源文件更新待確認：'+sourceError.message:'訂單庫存同步完成。',sourceError?'warning':'success');
        }
    }catch(err){
        if(order&&normalizedOrderStatus(order)==='normal'&&currentUser?.uid===uid&&canRetryOrderInventorySync(order)){
            Object.assign(cachedOrder,order);
        }
        if(currentUser?.uid===uid)showActionFeedback('庫存同步未完成，可在同一筆訂單重試：'+(err.message||err),'warning');
    }finally{
        pendingOrderReservationIds.delete(orderId);
        if(currentUser?.uid===uid){writeAppDataCache('orders',ordersCache);renderOrdersList();}
    }
};

