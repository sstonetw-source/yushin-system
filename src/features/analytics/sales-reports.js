// 管理員銷售統計以「訂單」為準，避免把尚未成交的估價單也算進營收。
function readTradeAnalysisFilters() {
    const {start,end}=salesStatisticsQueryWindow();
    return {start,end,sales:document.getElementById('salesStatsSalesFilter')?.value||'',
        brand:document.getElementById('salesStatsBrandFilter')?.value||'',
        line:document.getElementById('salesStatsLineFilter')?.value||'',
        type:document.getElementById('salesStatsTypeFilter')?.value||''};
}
function tradeAnalysisQueryKey(tab, filters) {
    return JSON.stringify([currentUser?.uid||'',tab,...(tab==='inventory'?[]:[filters.start,filters.end])]);
}
function applyTradeAnalysisSnapshot(snapshot) {
    salesStatisticsOrders=snapshot.orders;
    inventoryAnalysisSupplyOrders=snapshot.supplies;
    inventoryAnalysisDirectShipSupplyOrders=snapshot.supplies.filter(row=>row.fulfillmentType==='DIRECT_SHIP');
    inventoryAnalysisReceipts=[];
    inventoryAnalysisLots=snapshot.lots;
    inventoryAnalysisLotCosts=new Map(snapshot.lotCosts.map(row=>[row.id,row]));
    tradeAnalysisWarehouseStocks=snapshot.stocks;
    tradeAnalysisSourceOrders=new Map(snapshot.sourceOrders.map(row=>[row.id,row]));
    snapshot.products.forEach(row=>cacheProductLookupItem(productMasterDocToPriceItem({id:row.id,data:()=>row})));
    rebuildPriceItemLookup();
}
window.loadSalesStatistics = function(force = false) {
    if (currentUserRole !== 'admin') return Promise.resolve();
    if(force){tradeAnalysisSnapshots.clear();tradeAnalysisRevision++;}
    if (salesStatisticsLoadPromise) return salesStatisticsLoadPromise;
    const filters=tradeAnalysisAppliedFilters||(tradeAnalysisAppliedFilters=readTradeAnalysisFilters());
    const tab=tradeAnalysisTab, key=tradeAnalysisQueryKey(tab,filters);
    if(!document.getElementById('salesStatsStart').value)document.getElementById('salesStatsStart').value=filters.start;
    if(!document.getElementById('salesStatsEnd').value)document.getElementById('salesStatsEnd').value=filters.end;
    if(tab!=='inventory'&&filters.start>filters.end){
        tradeAnalysisReady=false;
        resetSimpleTradeAnalysisDetail();
        setTradeAnalysisLoading(false);
        document.querySelectorAll('.trade-analysis-cards strong').forEach(el=>el.textContent='－');
        document.getElementById('tradeAnalysisStatus').textContent='起日不可晚於迄日。';
        return Promise.resolve();
    }
    const cached=tradeAnalysisSnapshots.get(key);
    if(cached&&Date.now()-cached.loadedAt<60000){
        applyTradeAnalysisSnapshot(cached);
        tradeAnalysisLoadedKey=key;tradeAnalysisReady=true;
        renderSalesStatistics();setTradeAnalysisLoading(false);
        return Promise.resolve();
    }
    tradeAnalysisReady=false;setTradeAnalysisLoading(true);
    const requestedRole=currentUserRole, requestedUid=currentUser?.uid, revision=tradeAnalysisRevision;
    const stillAuthorized=()=>requestedRole===currentUserRole&&requestedUid===currentUser?.uid;
    salesStatisticsLoadPromise=loadTradeAnalysisSnapshot(tab,filters).then(snapshot=>{
        if (requestedRole !== currentUserRole || requestedUid !== currentUser?.uid || revision!==tradeAnalysisRevision) return;
        snapshot.loadedAt=Date.now();
        // Keep only the current period for each tab; never accumulate history in memory.
        for(const [oldKey,value] of tradeAnalysisSnapshots)if(value.tab===tab)tradeAnalysisSnapshots.delete(oldKey);
        tradeAnalysisSnapshots.set(key,snapshot);
        if(key!==tradeAnalysisQueryKey(tradeAnalysisTab,tradeAnalysisAppliedFilters))return;
        applyTradeAnalysisSnapshot(snapshot);
        tradeAnalysisLoadedKey=key;tradeAnalysisReady=true;
        renderSalesStatistics();
    }).catch(err=>{
        if(!stillAuthorized()||key!==tradeAnalysisQueryKey(tradeAnalysisTab,tradeAnalysisAppliedFilters))return;
        tradeAnalysisReady=false;
        document.getElementById('tradeAnalysisStatus').textContent='讀取失敗：'+(err.message||err)+'。請按查詢重試。';
        document.querySelectorAll('.trade-analysis-cards strong').forEach(el=>el.textContent='讀取失敗');
    }).finally(()=>{
        salesStatisticsLoadPromise = null;
        if(!stillAuthorized())return;
        setTradeAnalysisLoading(false);
        if(key!==tradeAnalysisQueryKey(tradeAnalysisTab,tradeAnalysisAppliedFilters)||revision!==tradeAnalysisRevision)loadSalesStatistics();
    });
    return salesStatisticsLoadPromise;
};

async function readDocumentsByIds(collectionName, ids, chunkSize = 30) {
    const uniqueIds = [...new Set((ids || []).map(id => String(id || '').trim()).filter(Boolean))];
    const jobs=[];
    for(let i=0;i<uniqueIds.length;i+=chunkSize){
        const batch=uniqueIds.slice(i,i+chunkSize);
        jobs.push(async()=>{
            const snap=await firestoreReadWithTimeout(db.collection(collectionName==='supplyOrders'&&currentUserRole==='warehouse'&&permissionRulesReady?'receivingSupplyOrders':collectionName).where(firebase.firestore.FieldPath.documentId(),'in',batch).get(),collectionName+' 指定文件');
            return snap.docs.map(doc=>({...doc.data(),id:doc.id}));
        });
    }
    return (await runReadJobs(jobs,4)).flat();
}

async function readTradeAnalysisSuppliesByOrders(ids) {
    const unique=[...new Set(ids.filter(Boolean))],rows=[];
    for(let i=0;i<unique.length;i+=30){
        rows.push(...await readQueryInBatches(supplyOrdersCollection().where('orderId','in',unique.slice(i,i+30))));
    }
    return rows;
}
async function readTradeAnalysisLotCosts(ids) {
    const costs=await readDocumentsByIds('inventoryLotCosts',ids);
    const roots=await readDocumentsByIds('inventoryLotCosts',costs.map(row=>row.costSourceLotId));
    const byId=new Map([...costs,...roots].map(row=>[row.id,row]));
    const effective=costs.map(row=>row.costSourceLotId?{...byId.get(row.costSourceLotId),id:row.id}:row);
    const sources=await readDocumentsByIds('supplyOrders',effective.filter(row=>row.unitCost===undefined).map(row=>row.costSourceSupplyId));
    const supplies=new Map(sources.map(row=>[row.id,row]));
    return effective.map(row=>row.unitCost===undefined&&row.costSourceSupplyId
        ? {...row,unitCost:supplies.get(row.costSourceSupplyId)?.unitCost}:row);
}
async function loadTradeAnalysisSnapshot(tab, {start,end}) {
    const snapshot={tab,orders:[],supplies:[],lots:[],lotCosts:[],stocks:[],sourceOrders:[],products:[]};
    // Each tab reads only the sources used by its cohort/current-stock calculation.
    if(tab==='purchasing'){
        snapshot.supplies=await readQueryInBatches(supplyOrdersCollection()
            .where('orderDate','>=',start).where('orderDate','<=',end).orderBy('orderDate','desc'));
        snapshot.sourceOrders=await readDocumentsByIds('orders',snapshot.supplies.map(row=>row.orderId));
    }else if(tab==='selling'){
        snapshot.orders=await readQueryInBatches(db.collection('orders')
            .where('orderDate','>=',start).where('orderDate','<=',end).orderBy('orderDate','desc'));
        const lines=snapshot.orders.flatMap(salesStatisticOrderLines);
        const events=line=>[...savedDeliveryRecords(line),...savedReturnRecords(line)];
        const lotIds=lines.flatMap(line=>events(line).flatMap(row=>(row.lotAllocations||[]).map(a=>a.lotId)));
        const directOrderIds=lines.filter(line=>events(line).some(row=>!(row.lotAllocations||[]).length)).map(line=>line.id);
        [snapshot.lotCosts,snapshot.supplies]=await Promise.all([
            readTradeAnalysisLotCosts(lotIds),readTradeAnalysisSuppliesByOrders(directOrderIds)
        ]);
    }else if(tab==='inventory'){
        [snapshot.stocks,snapshot.lots]=await Promise.all([
            readQueryInBatches(db.collection('warehouseStocks').where('onHand','>',0).orderBy('onHand')),
            readQueryInBatches(db.collection('inventoryLots').where('remainingQty','>',0).orderBy('remainingQty'))
        ]);
        snapshot.lotCosts=await readTradeAnalysisLotCosts(snapshot.lots.map(row=>row.costLotId||row.id));
        // Transfer lots may reference their root cost, while valuation looks up the lot ID.
        const costs=new Map(snapshot.lotCosts.map(row=>[row.id,row]));
        snapshot.lotCosts=snapshot.lots.map(row=>({...costs.get(row.costLotId||row.id),id:row.id}));
    }
    const records=[...snapshot.supplies,...snapshot.stocks,...snapshot.lots,
        ...snapshot.orders.flatMap(salesStatisticOrderLines),...snapshot.sourceOrders.flatMap(salesStatisticOrderLines)];
    snapshot.products=await readDocumentsByIds('products',records.map(row=>row.productId||row.productKey));
    return snapshot;
}

function protectedAllocationCost(records) {
    return (Array.isArray(records) ? records : []).reduce((sum, record) => {
        return sum + (Array.isArray(record.lotAllocations) ? record.lotAllocations : []).reduce((allocationSum, allocation) => {
            const lotCost = inventoryAnalysisLotCosts.get(allocation.lotId);
            return allocationSum + Number(allocation.qty || 0) * Number(lotCost?.unitCost || 0);
        }, 0);
    }, 0);
}

function protectedHistoricalCogs(start, end) {
    return salesStatisticsOrders.reduce((sum, order) => {
        if (normalizedOrderStatus(order) !== 'normal') return sum;
        const delivered = savedDeliveryRecords(order).filter(record => dateInStatsRange(record.date, start, end));
        const returned = savedReturnRecords(order).filter(record => dateInStatsRange(record.date, start, end));
        return sum + protectedAllocationCost(delivered) - protectedAllocationCost(returned);
    }, 0);
}

function inventoryAnalysisTotals(start,end) {
    let purchase = 0;
    inventoryAnalysisReceipts.forEach(receipt => {
        const lotCost = inventoryAnalysisLotCosts.get(receipt.lotId);
        purchase += Number(receipt.qty || 0) * Number(lotCost?.unitCost || 0);
    });
    // 原廠直送不進倉庫，因此採購成本直接由 supplyOrders 的實際到貨量計入；
    // 未到貨的訂購量仍是在途，不能提前算成期間採購。
    inventoryAnalysisDirectShipSupplyOrders.forEach(supply => {
        purchase += Number(supply.receivedQty || 0) * Number(supply.unitCost || 0);
    });
    const sales = salesStatisticsOrders.flatMap(salesStatisticOrderLines).reduce((sum, order) => {
        const contribution = calculateOrderStatsContribution(order, start, end);
        return sum + contribution.actualSales;
    }, 0);
    const stockValue = inventoryAnalysisLots.reduce((sum, lot) => {
        const lotCost = inventoryAnalysisLotCosts.get(lot.id);
        return sum + Number(lot.remainingQty || 0) * Number(lotCost?.unitCost || 0);
    }, 0);
    // 在途價值直接由 supplyOrders 的未到貨數量計算；PO 文件不再維護到貨狀態。
    const incoming = inventoryAnalysisSupplyOrders
        .filter(supply => (supply.fulfillmentType || 'WAREHOUSE') !== 'DIRECT_SHIP')
        .filter(supply => !isPurchaseTerminalStatus(supply.status))
        .reduce((sum, supply) => {
            const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
            return sum + remaining * Number(supply.unitCost || 0);
        }, 0);
    const cogs = protectedHistoricalCogs(start, end);
    return { purchase, sales, difference: sales - purchase, stockValue, incoming, cogs, grossProfit:sales-cogs };
}
function renderInventoryAnalysisSummary(start,end){
    const t=inventoryAnalysisTotals(start,end);
    const ids={
        invAnalysisPurchases:t.purchase,
        invAnalysisSales:t.sales,
        invAnalysisDifference:t.difference,
        invAnalysisGrossProfit:t.grossProfit,
        invAnalysisStockValue:t.stockValue,
        invAnalysisIncoming:t.incoming
    };
    Object.entries(ids).forEach(([id,v])=>{
        const el=document.getElementById(id);
        if(el)el.innerText=formatStatsMoney(v);
    });
    const rate=document.getElementById('invAnalysisGrossProfitRate');
    if(rate)rate.innerText=t.sales?`毛利率 ${(t.grossProfit/t.sales*100).toFixed(1)}%`:'毛利率 －';
}

function salesAmount(order) {
    const total = parseFloat(String(order.totalPrice == null ? '' : order.totalPrice).replace(/,/g, ''));
    if (Number.isFinite(total)) return total;
    return (parseFloat(order.qty) || 0) * (parseFloat(order.unitPrice) || 0);
}

// 訂單的 costPrice 是「每單位含稅進貨成本」，故需乘上數量才是該筆訂單的總成本。
function normalizeItemCode(value) {
    return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
}

function normalizeItemCodeLoose(value) {
    return normalizeItemCode(value).replace(/[\-_.\/]+/g, '');
}

function findPriceItemByCodeValue(value, preferredBrand = '') {
    const normalized = normalizeItemCode(value);
    const loose = normalizeItemCodeLoose(value);
    if (!normalized && !loose) return null;
    const preferredKey = normalizeBrandLookupKey(resolveBrandName(preferredBrand || ''));
    const candidates = priceList.filter(item => {
        if (item.status === 'INACTIVE' || item.active === false) return false;
        const codeMatches = normalizeItemCode(item.model) === normalized
            || (!!loose && normalizeItemCodeLoose(item.model) === loose);
        if (!codeMatches) return false;
        if (!preferredKey) return true;
        return normalizeBrandLookupKey(resolveBrandName(item.brand || '')) === preferredKey;
    });
    return candidates.length === 1 ? candidates[0] : null;
}

function cacheProductLookupItem(item) {
    if (!item) return null;
    const productId = item.productId || stableProductId(item);
    const next = normalizeProductMasterItem({ ...item, productId });
    priceList = priceList.filter(row => (row.productId || stableProductId(row)) !== productId);
    if (next.status !== 'INACTIVE' && next.active !== false) priceList.push(next);
    productCodeMatchCache.delete(normalizeItemCodeLoose(next.model || ''));
    rebuildPriceItemLookup();
    return next;
}

async function findProductsByCode(value, options = {}) {
    const normalized = normalizeItemCodeLoose(value);
    if (!normalized) return [];
    if (productCodeMatchCache.has(normalized)) return productCodeMatchCache.get(normalized);
    try {
        // Only page exact-code matches, never scan the product catalogue.
        const active = [];
        let cursor = null;
        while (true) {
            let query = db.collection('products').where('normalizedPartNo', '==', normalized).limit(50);
            if (cursor) query = query.startAfter(cursor);
            const snapshot = await firestoreReadWithTimeout(query.get(), '產品主檔貨號查詢');
            active.push(...snapshot.docs.map(productMasterDocToPriceItem)
                .filter(item => item.status !== 'INACTIVE' && item.active !== false));
            if (snapshot.size < 50) break;
            cursor = snapshot.docs[snapshot.docs.length - 1];
        }
        const merged = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
        active.forEach(item => merged.set(item.productId || stableProductId(item), item));
        priceList = [...merged.values()];
        rebuildPriceItemLookup();
        productCodeMatchCache.set(normalized, active);
        return active;
    } catch (err) {
        console.warn('產品主檔貨號查詢失敗：', err);
        if (options.throwOnError) throw err;
        return [];
    }
}

function selectProductCodeMatch(matches, preferredBrand = '') {
    const preferredKey = normalizeBrandLookupKey(resolveBrandName(preferredBrand || ''));
    if (preferredKey) {
        const preferred = matches.filter(item =>
            normalizeBrandLookupKey(resolveBrandName(item.brand || '')) === preferredKey
        );
        return preferred.length === 1 ? preferred[0] : null;
    }
    return matches.length === 1 ? matches[0] : null;
}

async function findProductByCode(value, preferredBrand = '') {
    return selectProductCodeMatch(await findProductsByCode(value), preferredBrand);
}

function applyQuoteProductMatch(row, match) {
    if (!row || !match) return false;

    const codeInput = row.querySelector('.item-model');
    const lookupBrand = productLookupBrand(codeInput, quoteRowBrandValue(row));
    codeInput.dataset.matchedProductCode = normalizeItemCodeLoose(match.model || codeInput.value);
    if (!lookupBrand) codeInput.dataset.autofillBrand = normalizeBrandLookupKey(resolveBrandName(match.brand || ''));
    row.querySelector('.item-en').value = match.nameEn || '';
    row.querySelector('.item-cn').value = match.nameCn || '';
    row.querySelector('.item-model').value = match.model || row.querySelector('.item-model').value || '';

    const brandSelect = row.querySelector('.item-brand');
    if (brandSelect && match.brand) {
        selectBrandInDropdown(brandSelect, resolveBrandName(match.brand));
        onQuoteBrandSelectChange(brandSelect);
    }

    row.querySelector('.item-product-line').value = match.productLine || '';
    row.querySelector('.item-product-type').value = match.productType || '';
    row.querySelector('.item-product-id').value = match.productId || stableProductId(match);
    const brandIdInput = row.querySelector('.item-brand-id');
    if (brandIdInput) brandIdInput.value = match.brandId || brandIdForName(match.brand || '');
    row.querySelector('.item-spec').value = match.spec || match.specification || '';

    const priceInput = row.querySelector('.inc-price');
    if (priceInput && match.price !== undefined && match.price !== null && String(match.price).trim() !== '') {
        priceInput.value = match.price;
        onIncPriceChange(priceInput);
    } else {
        if (priceInput) { priceInput.value = ''; onIncPriceChange(priceInput); }
        else calculateTotals();
    }
    refreshQuoteWarehouseStock(row);
    return true;
}

window.onItemModelInput = function(input) {
    clearTimeout(quoteProductChecks.get(input)?.timer);
    clearChangedProductDetails(input, 'quote');
    queueProductCodeSuggestions(input.value);
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    const row = input.closest('tr');
    clearProductStockHint(row?.querySelector('.quote-warehouse-stock-hint'));
    ['.item-product-id', '.item-product-line', '.item-product-type'].forEach(key => {
        const field = row?.querySelector(key); if (field) field.value = '';
    });
    input.dataset.autofillStatus = input.value.trim() ? 'checking' : '';
    const check = {};
    quoteProductChecks.set(input, check);
    if (input.value.trim()) check.timer = setTimeout(() => onItemModelChange(input), 180);
};

function stableProductId(item) {
    const canonicalBrand = resolveBrandName(item?.brand || item?.brandName || '');
    const brand = normalizeBrandLookupKey(canonicalBrand);
    const code = normalizeItemCode(item?.model || item?.manufacturerPartNo || item?.sku || '');
    if (code) return `prd:${encodeURIComponent(brand)}:${encodeURIComponent(code)}`;
    const name = String(item?.nameCn || item?.productName || item?.nameEn || '').normalize('NFKC').trim().toLocaleLowerCase();
    return `prd:${encodeURIComponent(brand)}:name:${encodeURIComponent(name)}`;
}

function normalizeProductTypeValue(value) {
    const raw = String(value || '').normalize('NFKC').trim();
    if (!raw) return '';
    const key = raw.replace(/[\s_-]+/g, '').toLocaleLowerCase();
    const aliases = {
        instrument:'Instrument', instruments:'Instrument', 儀器:'Instrument', 仪器:'Instrument', 機器:'Instrument', 机器:'Instrument',
        reagent:'Reagent', reagents:'Reagent', 試劑:'Reagent', 试剂:'Reagent',
        consumable:'Consumable', consumables:'Consumable', 耗材:'Consumable', 消耗品:'Consumable',
        accessory:'Accessory', accessories:'Accessory', 配件:'Accessory', 附件:'Accessory',
        service:'Service', services:'Service', 服務:'Service', 服务:'Service', 維修:'Service', 维修:'Service'
    };
    return aliases[key] || raw;
}

function normalizeProductMasterItem(item) {
    const status = String(item.status || '').trim().toUpperCase();
    const active = item.active !== false && status !== 'INACTIVE';
    return {
        ...item,
        productId: item.productId || stableProductId(item),
        sku: item.sku || item.model || '',
        supplier: String(item.supplier || '').trim(),
        spec: item.spec || '',
        unit: String(item.unit || item.uom || '').trim(),
        productLine: String(item.productLine || '').trim(),
        productType: normalizeProductTypeValue(item.productType || item.category || ''),
        source: String(item.source || '').trim().toUpperCase(),
        status: status || (active ? 'ACTIVE' : 'INACTIVE'),
        inventoryTracked: !!item.inventoryTracked,
        lotTracked: !!item.lotTracked,
        expiryTracked: !!item.expiryTracked,
        active
    };
}

function normalizeProductMasterList(items) {
    return (items || []).map(normalizeProductMasterItem);
}

function brandMasterEntryForName(value) {
    const key = normalizeBrandLookupKey(resolveBrandName(value));
    return getUnifiedBrandEntries(true).find(entry => normalizeBrandLookupKey(entry.name) === key) || null;
}

function brandIdForName(value) {
    return brandMasterEntryForName(value)?.id || '';
}

function productMasterForRecord(record = {}) {
    const productId = String(record?.productId || '').trim();
    if (productId) {
        const product = priceList.find(item =>
            String(item.productId || '') === productId
            && item.status !== 'INACTIVE' && item.active !== false
        );
        if (product) return product;
    }
    return findPriceItemForOrder(record);
}

function brandIdentityForRecord(record = {}) {
    const product = productMasterForRecord(record);
    if (product) {
        const brand = resolveBrandName(product.brand || '');
        return { brand, brandId: product.brandId || brandIdForName(brand) };
    }
    const savedBrandId = String(record?.brandId || '').trim();
    if (savedBrandId) {
        const entry = getUnifiedBrandEntries(true).find(item => item.id === savedBrandId);
        if (entry) return { brand: entry.name, brandId: entry.id };
    }
    const brand = resolveBrandName(record?.brand || '');
    return { brand, brandId: brandIdForName(brand) };
}



async function findProductForPurchaseItem(item) {
    const productId = String(item?.productId || '').trim();
    if (productId) {
        const cached = priceList.find(product => String(product.productId || '') === productId);
        if (cached) return cached;
        try {
            const snap = await firestoreReadWithTimeout(
                db.collection('products').doc(productId).get(),
                '採購產品主檔'
            );
            if (snap.exists) {
                const product = productMasterDocToPriceItem(snap);
                if (product.status !== 'INACTIVE' && product.active !== false) return cacheProductLookupItem(product);
            }
        } catch (err) {
            console.warn('採購產品主檔 productId 查詢失敗：', err);
        }
    }
    const code = item?.itemCode || item?.productCode || item?.code || item?.model || '';
    return code ? await findProductByCode(code) : null;
}

async function preloadPurchaseCostsForItems(purchaseItems = []) {
    // 只解析這次採購單真正會用到的品項；不要因來源訂單還有其他品項就全部查 Product Master / 成本。
    // 已解析成本仍保留在本次登入快取，第二次開同品項不再重查。
    const resolved = await Promise.all((purchaseItems || []).map(async item => ({
        item,
        product: await findProductForPurchaseItem(item)
    })));
    const products = new Map();
    resolved.forEach(({ item, product }) => {
        if (!product) return;
        const id = product.productId || item.productId || stableProductId(product);
        if (id) products.set(id, product);
    });
    await Promise.all([...products.entries()].map(async ([id, item]) => {
        if (purchaseCostCache.has(id)) return;
        const cost = await loadVisibleProductCost(item);
        if (cost !== null && Number.isFinite(cost)) purchaseCostCache.set(id, cost);
    }));
    resolved.forEach(({item, product}) => {
        if (!product) return;
        const id = product.productId || item.productId || stableProductId(product);
        item.productId = id;
        const cost = purchaseCostCache.get(id);
        if (cost !== undefined && cost !== null && Number.isFinite(Number(cost))) item.unitPrice = Number(cost);
    });
}

function productMasterDocToPriceItem(doc) {
    const data = doc.data ? doc.data() : doc;
    const brand = resolveBrandName(data.brandName || data.brand || '');
    const priceListActive = isBrandPriceListActive(brand);
    return normalizeProductMasterItem({
        productId: data.productId || doc.id || '',
        brandId: data.brandId || '',
        brand,
        model: data.manufacturerPartNo || data.sku || '',
        sku: data.manufacturerPartNo || data.sku || '',
        nameCn: data.productName || data.nameCn || '',
        nameEn: data.nameEn || '',
        productLine: data.productLine || '',
        productType: data.productType || data.category || '',
        serviceKind: data.serviceKind || '',
        spec: data.specification || data.spec || '',
        unit: data.unit || data.uom || '',
        price: priceListActive ? (data.listPrice ?? data.price ?? 0) : 0,
        priceListActive,
        supplier: data.supplier || '',
        inventoryTracked: data.inventoryTracked === true,
        lotTracked: data.lotTracked === true,
        expiryTracked: data.expiryTracked === true,
        source: data.source || '',
        status: data.status || (data.active === false ? 'INACTIVE' : 'ACTIVE'),
        active: data.active !== false && data.status !== 'INACTIVE'
    });
}

const visibleProductCostCache = new Map();
const visibleProductCostPending = new Map();
let visibleProductCostGeneration = 0;
function invalidateVisibleProductCosts() { visibleProductCostGeneration++; visibleProductCostCache.clear(); visibleProductCostPending.clear(); }

async function loadVisibleProductCost(item) {
    const productId = item?.productId || stableProductId(item || {});
    if (!productId) return null;
    if (typeof isBrandPriceListActive === 'function' && !isBrandPriceListActive(item?.brandName || item?.brand || '')) return null;
    if (currentUserRole !== 'admin' && currentUserRole !== 'purchaser') return null;
    const cacheKey = `${currentUserRole || ''}||${productId}`;
    if (visibleProductCostCache.has(cacheKey)) return visibleProductCostCache.get(cacheKey);
    if (visibleProductCostPending.has(cacheKey)) return visibleProductCostPending.get(cacheKey);
    const generation = visibleProductCostGeneration;
    const request = (async () => {
    try {
        const doc = await firestoreReadWithTimeout(
            db.collection('productCosts').doc(productId).get(),
            '產品成本'
        );
        if (!doc.exists) {
            if (generation === visibleProductCostGeneration) visibleProductCostCache.set(cacheKey, null);
            return null;
        }
        const value = (doc.data() || {}).standardCost;
        const parsed = value === undefined || value === null || String(value).trim() === '' ? NaN : Number(value);
        const cost = Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
        if (generation === visibleProductCostGeneration) visibleProductCostCache.set(cacheKey, cost);
        return cost;
    } catch (_) {
        return null;
    }
    })();
    visibleProductCostPending.set(cacheKey, request);
    try { return await request; }
    finally { if (visibleProductCostPending.get(cacheKey) === request) visibleProductCostPending.delete(cacheKey); }
}

function setOrderCostFieldForProduct(item) {
    const wrap = document.getElementById('orderCostFieldWrap');
    const input = document.getElementById('orderCostPrice');
    if (!wrap || !input) return;
    const selfOrder = document.getElementById('orderProcurementType')?.value === 'SALES_SELF_ORDER';
    const statusWrap=document.getElementById('orderSelfStatusWrap');if(statusWrap)statusWrap.hidden=!selfOrder;
    const supplierWrap=document.getElementById('orderSelfSupplierWrap');if(supplierWrap)supplierWrap.style.display=selfOrder?'':'none';
    const supplierInput=document.getElementById('orderSelfSupplier');if(supplierInput&&!supplierInput.value&&item?.supplier)supplierInput.value=item.supplier;
    const authorized = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    wrap.style.display = selfOrder || authorized ? '' : 'none';
    input.readOnly = !selfOrder;
    input.placeholder = selfOrder ? '尚未下訂可先留白，已下訂可填 0' : '選擇產品後帶入標準成本';
    const label = wrap.querySelector('label');
    if (label && label.firstChild) label.firstChild.textContent = selfOrder ? '含稅單位成本 ' : '含稅標準成本（參考） ';
    if (!selfOrder) input.value = '';
}
window.onOrderProcurementTypeChange = function() {
    const input = document.getElementById('orderCostPrice');
    if (input) { input.value = ''; delete input.dataset.autofillCost; }
    applyOrderProductCost(findPriceItemForOrder({itemCode:document.getElementById('orderItemCode')?.value || '',brand:getBrandFieldValue('orderBrand','orderBrandOther')}));
};
let orderCostRequestGeneration = 0;
async function applyOrderProductCost(item) {
    const generation = ++orderCostRequestGeneration;
    const openingGeneration = orderModalOpenGeneration;
    setOrderCostFieldForProduct(item);
    const input = document.getElementById('orderCostPrice');
    if (!input || !item) return;
    const selfOrder = document.getElementById('orderProcurementType')?.value === 'SALES_SELF_ORDER';
    const initialValue = input.value;
    // A manually entered transaction cost remains authoritative, including zero.
    if (selfOrder && initialValue !== '' && initialValue !== input.dataset.autofillCost) return;
    input.value = '';
    delete input.dataset.autofillCost;
    const cost = await loadVisibleProductCost(item);
    if (generation !== orderCostRequestGeneration || openingGeneration !== orderModalOpenGeneration || input.value !== '') return;
    if (cost !== null && Number.isFinite(cost) && cost >= 0) {
        input.value = String(cost);
        input.dataset.autofillCost = String(cost);
    }
}

function clearQuickProductButton(input) {
    input?.parentElement?.querySelector?.('.quick-product-inline')?.remove();
}

function clearProductMatchChoices(input) {
    input?.parentElement?.querySelector?.('.product-match-choices')?.remove();
}

function showQuickProductButton(input, mode) {
    if (!input || !input.parentElement) return;
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    const wrap = document.createElement('div');
    wrap.className = 'quick-product-inline';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:#6b7280;';
    const hint = document.createElement('span');
    hint.textContent = mode === 'quote' ? '未建檔（估價可直接繼續）' : '此貨號尚未建立產品';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-small btn-secondary quick-product-create-btn';
    button.textContent = mode === 'quote' ? '＋ 建立' : '＋ 快速建立';
    button.onclick = () => openQuickProductCreate(mode, input);
    wrap.append(hint, button);
    input.parentElement.appendChild(wrap);
}

function showProductMatchChoices(input, matches, mode) {
    if (!input || !input.parentElement || !Array.isArray(matches) || matches.length < 2) return;
    clearQuickProductButton(input);
    clearProductMatchChoices(input);
    const wrap = document.createElement('div');
    wrap.className = 'product-match-choices';
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-top:4px;font-size:12px;color:#6b7280;';
    const hint = document.createElement('span');
    hint.textContent = '同一貨號有多個廠牌，請選擇：';
    wrap.appendChild(hint);
    matches.slice(0, 6).forEach(match => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn-small btn-secondary';
        button.textContent = [resolveBrandName(match.brand || ''), match.nameCn || match.nameEn || match.model || '產品'].filter(Boolean).join('｜');
        button.onclick = async () => {
            clearProductMatchChoices(input);
            input.value = match.model || input.value;
            if (mode === 'quote') {
                input.dataset.autofillStatus = 'matched';
                applyQuoteProductMatch(input.closest('tr'), match);
            } else {
                await applyOrderProductMatch(input, match);
            }
        };
        wrap.appendChild(button);
    });
    input.parentElement.appendChild(wrap);
}

function ensureQuickProductModal() {
    let panel = document.getElementById('quickProductOverlay');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'quickProductOverlay';
    panel.className = 'quick-product-inline-panel no-print';
    panel.innerHTML = `
      <div class="quick-product-inline-head">
        <div>
          <strong>快速建立產品</strong>
          <span>不離開目前單據；填完後直接帶回原本貨號欄位。</span>
        </div>
        <button type="button" class="btn-small btn-secondary" onclick="closeQuickProductCreate()">收合</button>
      </div>
      <div class="quick-product-inline-grid">
        <label>廠牌<input id="quickProductBrand" type="text" list="quickProductBrandList" autocomplete="off"><datalist id="quickProductBrandList"></datalist></label>
        <label>貨號<input id="quickProductCode" type="text" autocomplete="off"></label>
        <label class="quick-product-span-2">中文品名<input id="quickProductName" type="text" autocomplete="off"></label>
        <label class="quick-product-span-2">英文品名<input id="quickProductNameEn" type="text" autocomplete="off"></label>
        <label>規格<input id="quickProductSpec" type="text" autocomplete="off"></label>
        <label>建議售價（選填）<input id="quickProductPrice" type="number" min="0"></label>
        <input id="quickProductLine" type="hidden">
      </div>
      <div class="quick-product-inline-actions">
        <button type="button" id="saveQuickProductBtn" onclick="saveQuickProduct()">儲存並帶入</button>
        <button type="button" class="btn-secondary" onclick="closeQuickProductCreate()">稍後再補</button>
      </div>`;
    panel.addEventListener('input', saveQuickProductDraft);
    panel.addEventListener('change', saveQuickProductDraft);
    return panel;
}

const QUICK_PRODUCT_FIELDS = ['Brand', 'Code', 'Name', 'NameEn', 'Spec', 'Line', 'Price'];
function quickProductDraftKey() {
    return currentUser?.uid ? `quick-product-draft:${currentUser.uid}` : '';
}
function saveQuickProductDraft() {
    const key = quickProductDraftKey();
    if (!key) return;
    const fields = Object.fromEntries(QUICK_PRODUCT_FIELDS.map(field => [field, document.getElementById(`quickProduct${field}`)?.value || '']));
    try { localStorage.setItem(key, JSON.stringify(fields)); }
    catch (err) { console.warn('無法暫存產品草稿：', err); }
}
function readQuickProductDraft() {
    try { return JSON.parse(localStorage.getItem(quickProductDraftKey()) || 'null'); }
    catch (_) { return null; }
}
function clearQuickProductDraft() {
    const key = quickProductDraftKey();
    if (key) localStorage.removeItem(key);
}



window.openQuickProductCreate = function(mode, input) {
    const panel = ensureQuickProductModal();
    if (panel.classList.contains('active') && quickProductTarget?.input !== input) saveQuickProductDraft();

    quickProductTarget = { mode, input, row: mode === 'quote' ? input.closest('tr') : null };
    const anchor = mode === 'quote' ? input.closest('.field-row') : input.parentElement;
    if (anchor?.parentElement) anchor.insertAdjacentElement('afterend', panel);

    const brandList = document.getElementById('quickProductBrandList');
    if (brandList) brandList.innerHTML = getUnifiedBrandNames(false).map(name => `<option value="${escapeAttr(name)}"></option>`).join('');
    const currentBrand = mode === 'quote'
        ? quoteRowBrandValue(input.closest('tr'))
        : getBrandFieldValue('orderBrand', 'orderBrandOther');
    document.getElementById('quickProductBrand').value = currentBrand || '';
    document.getElementById('quickProductCode').value = input.value.trim();
    document.getElementById('quickProductName').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-cn')?.value || '')
        : (document.getElementById('orderItemName')?.value || '');
    document.getElementById('quickProductNameEn').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-en')?.value || '')
        : (document.getElementById('orderItemNameEn')?.value || '');
    document.getElementById('quickProductSpec').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-spec')?.value || '')
        : (document.getElementById('orderSpec')?.value || '');
    document.getElementById('quickProductLine').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.item-product-line')?.value || '')
        : (document.getElementById('orderProductLine')?.value || '');
    document.getElementById('quickProductPrice').value = mode === 'quote'
        ? (input.closest('tr')?.querySelector('.inc-price')?.value || '')
        : (document.getElementById('orderUnitPrice')?.value || '');

    const draft = readQuickProductDraft();
    if (draft && normalizeItemCodeLoose(draft.Code) === normalizeItemCodeLoose(input.value.trim())
        && normalizeBrandLookupKey(resolveBrandName(draft.Brand)) === normalizeBrandLookupKey(resolveBrandName(currentBrand))) {
        QUICK_PRODUCT_FIELDS.forEach(field => {
            const node = document.getElementById(`quickProduct${field}`);
            if (node) node.value = draft[field] || '';
        });
    }
    panel.classList.add('active');
};

window.closeQuickProductCreate = function() {
    const panel = document.getElementById('quickProductOverlay');
    if (panel?.classList.contains('active')) saveQuickProductDraft();
    if (panel) panel.classList.remove('active');
    quickProductTarget = null;
};

window.saveQuickProduct = async function() {
    const brand = resolveBrandName(document.getElementById('quickProductBrand')?.value || '');
    const code = String(document.getElementById('quickProductCode')?.value || '').trim();
    const productName = String(document.getElementById('quickProductName')?.value || '').trim();
    const productNameEn = String(document.getElementById('quickProductNameEn')?.value || '').trim();
    const specification = String(document.getElementById('quickProductSpec')?.value || '').trim();
    const productLine = String(document.getElementById('quickProductLine')?.value || '').trim();
    const priceRaw = document.getElementById('quickProductPrice')?.value ?? '';
    if (!brand || !code || !productName) {
        alert('請填寫廠牌、貨號與品名。');
        return;
    }
    const brandEntry = brandMasterEntryForName(brand);

    const button = document.getElementById('saveQuickProductBtn');
    const actorUid=currentUser?.uid;
    const state = beginActionButton(button, '檢查中…');
    if (!state) return;
    try {
    const normalizedPartNo = normalizeItemCodeLoose(code);
    const duplicate = await findDuplicateProductMaster(brand,code);
    if(currentUser?.uid!==actorUid)throw new Error('登入身分已變更，請以原帳號確認產品建檔結果。');
    if (duplicate) {
        const existing = productMasterDocToPriceItem(duplicate);
        if(existing.status==='INACTIVE'||existing.active===false)throw new Error('此廠牌與貨號的產品已停用，請由主檔管理人員確認，不可重新新增或直接帶入。');
        alert('這個廠牌與貨號已存在，系統會直接使用現有產品。');
        syncSavedProductMaster(duplicate.id,duplicate.data());
        refreshPriceDatalists();
        productCodeMatchCache.delete(normalizedPartNo);
        if (quickProductTarget?.mode === 'quote') applyQuoteProductMatch(quickProductTarget.row, existing);
        if (quickProductTarget?.mode === 'order') {
            quickProductTarget.input.value = existing.model || code;
            orderProductCheckGeneration++;
            await applyOrderProductMatch(quickProductTarget.input, existing);
            checkNewOrderDraftProducts();
        }
        clearQuickProductButton(quickProductTarget?.input);
        closeQuickProductCreate();
        clearQuickProductDraft();
        return;
    }

    const productId = stableProductId({ brand, model: code });
    const now = new Date().toISOString();
    const productDoc = {
        productId,
        brandId: brandEntry?.id || '',
        brandName: brand,
        manufacturerPartNo: code,
        normalizedPartNo,
        productName,
        nameEn: productNameEn,
        specification,
        productLine,
        productLineId: productLine,
        category: '',
        productType: '',
        supplier: '',
        listPrice: Number(priceRaw) || 0,
        status: 'TEMPORARY',
        active: true,
        source: 'QUICK_CREATE',
        createdAt: now,
        createdBy: currentUser?.uid || '',
        updatedAt: now,
        updatedBy: currentUser?.uid || ''
    };
        if (button) button.textContent = '儲存中…';
        await db.runTransaction(async tx=>{
            const ref=db.collection('products').doc(productId);
            const prior=await tx.get(ref);
            if(currentUser?.uid!==actorUid)throw new Error('登入身分已變更。');
            if(prior.exists)throw new Error('其他人已建立這筆產品，請重新查詢貨號後使用既有主檔。');
            tx.set(ref,productDoc);
        });
        if(currentUser?.uid!==actorUid)return;
        const item = productMasterDocToPriceItem({ id: productId, data: () => productDoc });
        syncSavedProductMaster(productId,productDoc);
        refreshPriceDatalists();
        productCodeMatchCache.delete(normalizedPartNo);
        if (quickProductTarget?.mode === 'quote') applyQuoteProductMatch(quickProductTarget.row, item);
        if (quickProductTarget?.mode === 'order') {
            quickProductTarget.input.value = code;
            orderProductCheckGeneration++;
            await applyOrderProductMatch(quickProductTarget.input, item);
            checkNewOrderDraftProducts();
        }
        clearQuickProductButton(quickProductTarget?.input);
        closeQuickProductCreate();
        clearQuickProductDraft();
    } catch (err) {
        alert('快速新增產品失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        endActionButton(button, state);
    }
};

function rebuildPriceItemLookup() {
    priceItemLookup = new Map();
    const codeBuckets = new Map();
    priceList.forEach(item => {
        if (item.status === 'INACTIVE' || item.active === false) return;
        const code = normalizeItemCode(item.model);
        if (!code) return;
        const brand = normalizeBrandLookupKey(resolveBrandName(item.brand || ''));
        const bucket = codeBuckets.get(code) || [];
        bucket.push(item);
        codeBuckets.set(code, bucket);
        if (brand) {
            const key = `brand:${brand}:${code}`;
            // Never silently select the first of multiple active identities.
            priceItemLookup.set(key, priceItemLookup.has(key) ? null : item);
        }
    });
    codeBuckets.forEach((items, code) => {
        if (items.length === 1) priceItemLookup.set(`code:${code}`, items[0]);
    });
}

function findPriceItemForOrder(order = {}) {
    const savedProductId = String(order.productId || '').trim();
    if (savedProductId) {
        const byId = priceList.find(item =>
            String(item.productId || '') === savedProductId
            && item.status !== 'INACTIVE' && item.active !== false
        );
        if (byId) return byId;
    }
    const code = normalizeItemCode(order.itemCode);
    if (!code) return null;
    const orderBrand = normalizeBrandLookupKey(resolveBrandName(order.brand || ''));
    if (orderBrand) return priceItemLookup.get(`brand:${orderBrand}:${code}`) || null;
    return priceItemLookup.get(`code:${code}`) || null;
}

function productLineForOrder(order) {
    if ((order.brand || '').trim() === '維修') return '維修';
    // 銷售分析以 Product Master 為分類真實來源；業務不需要在訂單上判斷或維護產品線。
    const match = findPriceItemForOrder(order);
    const masterLine = (match?.productLine || '').trim();
    if (masterLine) return masterLine;
    // 只有 Product Master 暫時查不到時，才沿用訂單內既有的背景快照。
    const savedLine = (order.productLine || '').trim();
    return savedLine && savedLine !== '未分類' ? savedLine : '未分類';
}

function productTypeForOrder(order) {
    const match = findPriceItemForOrder(order);
    const masterType = (match?.productType || '').trim();
    if (masterType) return masterType;
    const savedType = (order.productType || '').trim();
    return savedType && savedType !== '未分類' ? savedType : '未分類';
}

function statisticBrandForOrder(order) {
    const identity = brandIdentityForRecord(order);
    const brand = identity.brand;
    return statisticBrandAliasLookup().get(normalizeStatisticBrandKey(brand)) || '其他廠牌';
}

function salesStatisticOrderLines(order) {
    const items = normalizedOrderItems(order);
    if (items.length <= 1) return [order];
    return items.map(item => ({
        ...order,
        items: [item], orderSchemaVersion: 2,
        itemId: item.itemId, itemCode: item.itemCode || '', itemName: item.itemName || '',
        productId: item.productId || order.productId || '',
        brand: item.brand || '', productLine: item.productLine || '', productType: item.productType || '',
        procurementType: item.procurementType || order.procurementType || 'PURCHASING_PO',
        qty: Number(item.qty || 0), unitPrice: Number(item.unitPrice || 0),
        totalPrice: Number(item.totalPrice || 0), costPrice: item.costPrice, costSource: item.costSource || order.costSource || '',
        deliveryRecords: savedDeliveryRecords(order).filter(row => row.itemId === item.itemId),
        returnRecords: savedReturnRecords(order).filter(row => row.itemId === item.itemId),
        isDelivered: !!order.isDelivered && savedDeliveryRecords(order).length === 0
    }));
}

function newSalesStatsMetric() {
    return { actualSales: 0, pendingSales: 0, totalSales: 0, actualCost: 0, pendingCost: 0, totalCost: 0, profit: 0, missingCostIds: new Set(), orderIds: new Set(), estimatedSales: 0, estimatedIds: new Set() };
}

function orderUnitSalesAmount(order) {
    const qty = orderQuantity(order);
    return qty ? salesAmount(order) / qty : (parseFloat(order.unitPrice) || 0);
}

function orderStatsProductId(order) {
    const saved = String(order?.productId || '').trim();
    if (saved) return saved;
    const match = findPriceItemForOrder(order || {});
    return String(match?.productId || '').trim();
}

function orderUnitCostForStats(order) {
    if ((order?.procurementType || 'PURCHASING_PO') === 'SALES_SELF_ORDER') {
        const manual = Number(order.costPrice);
        return Number.isFinite(manual) && manual >= 0 ? manual : null;
    }
    const productId = orderStatsProductId(order);
    const standardCost = productId ? Number(purchaseCostCache.get(productId)) : NaN;
    return Number.isFinite(standardCost) && standardCost >= 0 ? standardCost : null;
}

function orderHasCost(order) {
    return orderUnitCostForStats(order) !== null;
}

function dateInStatsRange(date, start, end) {
    return !!date && (!start || date >= start) && (!end || date <= end);
}

function calculateOrderStatsContribution(order, start, end) {
    const empty = { actualQty: 0, pendingQty: 0, actualSales: 0, pendingSales: 0, actualCost: 0, pendingCost: 0, estimatedSales: 0, estimated: false };
    const cancelled = normalizedOrderStatus(order) !== 'normal';
    const totalQty = orderQuantity(order);
    if (!totalQty) return empty;
    const unitSales = orderUnitSalesAmount(order);
    const resolvedUnitCost = orderUnitCostForStats(order);
    const unitCost = resolvedUnitCost === null ? 0 : resolvedUnitCost;
    const cutoff = end || localDateString();
    let actualQty = 0;
    let deliveredByCutoff = 0;
    let estimatedQty = 0;
    const deliveries = savedDeliveryRecords(order);
    if (deliveries.length) {
        deliveries.forEach(record => {
            const qty = parseFloat(record.qty) || 0;
            if (dateInStatsRange(record.date, start, end)) actualQty += qty;
            if (record.date && record.date <= cutoff) deliveredByCutoff += qty;
        });
    } else if (order.isDelivered) {
        // 舊版只留下已送貨布林值，以訂單日期當作推估送貨日。
        const legacyDate = order.orderDate || '';
        if (dateInStatsRange(legacyDate, start, end)) { actualQty += totalQty; estimatedQty += totalQty; }
        if (legacyDate && legacyDate <= cutoff) deliveredByCutoff += totalQty;
    }
    let returnedByCutoff = 0;
    savedReturnRecords(order).forEach(record => {
        const qty = parseFloat(record.qty) || 0;
        if (dateInStatsRange(record.date, start, end)) actualQty -= qty;
        if (record.date && record.date <= cutoff) returnedByCutoff += qty;
    });
    const orderExistsByCutoff = !order.orderDate || order.orderDate <= cutoff;
    const effectiveDelivered = Math.max(0, deliveredByCutoff - returnedByCutoff);
    // 取消／作廢只終止尚未履約的餘額；取消前已實際送貨、退貨仍屬正式歷史。
    const settledReturnQty=savedReturnRecords(order).filter(r=>r.settlement==='CLOSE'&&r.date&&r.date<=cutoff).reduce((sum,r)=>sum+Number(r.qty||0),0);
    const pendingQty = !cancelled && orderExistsByCutoff ? Math.max(0, totalQty - Math.min(totalQty, effectiveDelivered + settledReturnQty)) : 0;
    return {
        actualQty, pendingQty,
        actualSales: actualQty * unitSales,
        pendingSales: pendingQty * unitSales,
        actualCost: actualQty * unitCost,
        pendingCost: pendingQty * unitCost,
        estimatedSales: estimatedQty * unitSales,
        estimated: estimatedQty !== 0
    };
}

function addSalesStatsContribution(metric, order, contribution) {
    metric.actualSales += contribution.actualSales;
    metric.pendingSales += contribution.pendingSales;
    metric.actualCost += contribution.actualCost;
    metric.pendingCost += contribution.pendingCost;
    metric.totalSales = metric.actualSales + metric.pendingSales;
    metric.totalCost = metric.actualCost + metric.pendingCost;
    metric.profit = metric.totalSales - metric.totalCost;
    if (contribution.actualSales || contribution.pendingSales) metric.orderIds.add(order.id);
    if (!orderHasCost(order) && (contribution.actualQty || contribution.pendingQty)) {
        metric.missingCostIds.add(`${order.id}:${orderStatsProductId(order) || order.itemId || 'unknown'}`);
    }
    if (contribution.estimated) {
        metric.estimatedSales += contribution.estimatedSales;
        metric.estimatedIds.add(order.id);
    }
}

function formatStatsMoney(value) {
    const rounded = Math.round(value);
    return `${rounded < 0 ? '-NT$ ' : 'NT$ '}${Math.abs(rounded).toLocaleString()}`;
}

function renderSalesStatsRows(tbodyId, values, grandTotal) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    const entries = Object.entries(values).sort((a, b) => b[1].totalSales - a[1].totalSales);
    tbody.innerHTML = entries.length
        ? entries.map(([name, metric]) => {
            const incompleteCost = metric.missingCostIds.size > 0;
            const rate = incompleteCost ? '待補成本' : metric.totalSales ? (metric.profit / metric.totalSales * 100).toFixed(1) + '%' : '－';
            const share = grandTotal ? (metric.totalSales / grandTotal * 100).toFixed(1) + '%' : '－';
            const costText = `${formatStatsMoney(metric.totalCost)}${incompleteCost ? `（少 ${metric.missingCostIds.size} 筆）` : ''}`;
            return `<tr><td>${escapeHtml(name)}</td><td>${formatStatsMoney(metric.actualSales)}</td><td>${formatStatsMoney(metric.pendingSales)}</td><td>${formatStatsMoney(metric.totalSales)}</td><td>${costText}</td><td>${incompleteCost ? '待補成本' : formatStatsMoney(metric.profit)}</td><td>${rate}</td><td>${share}</td></tr>`;
        }).join('')
        : '<tr><td colspan="8" style="color:#888;">尚無資料</td></tr>';
}

let tradeAnalysisLoadedKey = '';
const tradeAnalysisSnapshots = new Map();
let tradeAnalysisRevision = 0;
let tradeAnalysisAppliedFilters = null;
let tradeAnalysisSimpleRows = [];
let tradeAnalysisSimplePage = 0;
let tradeAnalysisFiltersPending = false;
let tradeAnalysisReady = false;
let tradeAnalysisReport = null;
let tradeAnalysisDetailKind = '';
let tradeAnalysisDetailReport = null;
let tradeAnalysisSourceOrders = new Map();
let tradeAnalysisTab = 'purchasing';
let tradeAnalysisSensitiveVisible = true;
let tradeAnalysisWarehouseStocks = [];
const TRADE_ANALYSIS_LABELS = {incoming:'待到貨採購',purchases:'已進貨（收貨）',pending:'待送貨訂單',sales:'已銷貨（送貨）',stock:'目前庫存'};

function setTradeAnalysisLoading(loading) {
    const query=document.getElementById('tradeAnalysisQueryBtn');
    if(query){query.disabled=loading;query.textContent=loading?'查詢中…':'查詢';}
    ['tradeAnalysisToggleBtn','tradeAnalysisWorkbookBtn'].forEach(id=>{
        const button=document.getElementById(id);if(button)button.disabled=loading||!tradeAnalysisReady||tradeAnalysisFiltersPending;
    });
    if(loading){
        closeTradeAnalysisDetail();
        resetSimpleTradeAnalysisDetail();
        document.querySelectorAll('.trade-analysis-cards strong').forEach(el=>el.textContent='讀取中…');
        document.getElementById('tradeAnalysisStatus').textContent='正在讀取此分頁所需資料…';
    }
}
window.markTradeAnalysisFiltersPending = function() {
    tradeAnalysisFiltersPending=true;
    setTradeAnalysisLoading(!!salesStatisticsLoadPromise);
    document.getElementById('tradeAnalysisStatus').textContent='篩選條件已變更，請按「查詢」；下方仍為上次查詢結果。';
};
function resetSimpleTradeAnalysisDetail() {
    tradeAnalysisSimplePage=0;
    const panel=document.getElementById('tradeAnalysisSimpleDetail');if(panel)panel.hidden=true;
    const button=document.getElementById('tradeAnalysisToggleBtn');
    if(button){button.textContent='查看明細';button.setAttribute('aria-expanded','false');}
    const body=document.getElementById('unifiedBrandAnalyticsBody');if(body)body.innerHTML='';
}
window.toggleSimpleTradeAnalysisDetail = function() {
    if(!tradeAnalysisReady||salesStatisticsLoadPromise||tradeAnalysisFiltersPending)return;
    const panel=document.getElementById('tradeAnalysisSimpleDetail');panel.hidden=!panel.hidden;
    document.getElementById('tradeAnalysisToggleBtn').textContent=panel.hidden?'查看明細':'收合明細';
    document.getElementById('tradeAnalysisToggleBtn').setAttribute('aria-expanded',String(!panel.hidden));
    if(!panel.hidden)renderSimpleTradeAnalysisPage();
};
window.changeSimpleTradeAnalysisPage = function(delta) {
    if(!tradeAnalysisReady||salesStatisticsLoadPromise||tradeAnalysisFiltersPending)return;
    const last=Math.max(0,Math.ceil(tradeAnalysisSimpleRows.length/50)-1);
    tradeAnalysisSimplePage=Math.max(0,Math.min(last,tradeAnalysisSimplePage+delta));
    renderSimpleTradeAnalysisPage();
};
function renderSimpleTradeAnalysisPage() {
    const quantity=tradeAnalysisTab==='inventory';
    const cols=quantity?['現有數量','已預留數量','可用數量']:simpleTradeAnalysisLabels().filter(label=>label!=='毛利率');
    document.getElementById('tradeAnalysisTableHead').innerHTML='<tr>'+['廠牌','貨號','品名',...cols].map(label=>`<th>${escapeHtml(label)}</th>`).join('')+'</tr>';
    const rows=tradeAnalysisSimpleRows.slice(tradeAnalysisSimplePage*50,(tradeAnalysisSimplePage+1)*50);
    document.getElementById('unifiedBrandAnalyticsBody').innerHTML=rows.map(row=>`<tr><td>${escapeHtml(row.brand)}</td><td>${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td>${(quantity?row.quantities:row.values).slice(0,cols.length).map(value=>`<td>${value===null?'待補成本':quantity?value:formatStatsMoney(value)}</td>`).join('')}</tr>`).join('')||`<tr><td colspan="${cols.length+3}">沒有符合條件的資料。</td></tr>`;
    const pages=Math.max(1,Math.ceil(tradeAnalysisSimpleRows.length/50));
    document.getElementById('tradeAnalysisPageStatus').textContent=`第 ${tradeAnalysisSimplePage+1} / ${pages} 頁，共 ${tradeAnalysisSimpleRows.length} 筆`;
    document.getElementById('tradeAnalysisPrevBtn').disabled=tradeAnalysisSimplePage===0;
    document.getElementById('tradeAnalysisNextBtn').disabled=tradeAnalysisSimplePage>=pages-1;
}
function simpleTradeAnalysisLabels() {
    return tradeAnalysisTab==='purchasing'?['採購金額','實際到貨金額','未到貨金額']:tradeAnalysisTab==='selling'
        ? ['銷售金額','實際出貨金額','未出貨金額',...(tradeAnalysisSensitiveVisible?['毛利','毛利率']:[])]
        : ['現有庫存金額','已預留庫存金額','可用庫存金額'];
}

window.toggleTradeAnalysisSensitive = function() {
    if(currentUserRole!=='admin')return;
    tradeAnalysisSensitiveVisible=!tradeAnalysisSensitiveVisible;
    const button=document.getElementById('tradeAnalysisSensitiveBtn');
    if(button){button.textContent=tradeAnalysisSensitiveVisible?'隱藏毛利':'顯示毛利';button.setAttribute('aria-pressed',String(!tradeAnalysisSensitiveVisible));}
    renderSalesStatistics();
};

function tradeAnalysisCost(value) {
    if(value===null||value===undefined||value==='')return null;
    const n=Number(value);
    return Number.isFinite(n)&&n>=0?n:null;
}

function buildTradeAnalysisRows() {
    const rows=[];
    const supplies=new Map(inventoryAnalysisSupplyOrders.map(row=>[row.id,row]));
    const metadata=(record={})=>{
        const product=findPriceItemForOrder(record);
        return {
            brand:statisticBrandForOrder(record),rawBrand:brandIdentityForRecord(record).brand,
            line:productLineForOrder(record),type:productTypeForOrder(record),
            code:record.itemCode||product?.model||'',name:record.itemName||product?.nameCn||product?.nameEn||'',
            productId:record.productId||product?.productId||''
        };
    };
    const push=(kind,record,qty,unitPrice,extra={})=>{
        rows.push({...metadata(record),kind,qty,unitPrice,amount:unitPrice===null?null:qty*unitPrice,...extra});
    };
    salesStatisticsOrders.flatMap(salesStatisticOrderLines).forEach(order=>{
        const common={customer:order.customerName||'',supplier:'',documentNo:order.orderNo||order.quoteNo||order.id,orderId:order.id,
            sales:stripPhoneSuffix(order.salesName)||'未指定負責業務',sourceId:order.id,itemId:order.itemId||''};
        const unit=orderUnitSalesAmount(order);
        const deliveries = savedDeliveryRecords(order);
        deliveries.forEach(record=>push('sales',order,Number(record.qty||0),unit,{...common,date:record.date,event:'送貨',eventId:record.id||'',status:'已送貨'}));
        if (!deliveries.length && order.isDelivered) {
            push('sales',order,orderQuantity(order),unit,{...common,date:order.orderDate || '',event:'舊資料推估送貨',eventId:'legacy-delivery',status:'已送貨（日期推估）',estimated:true});
        }
        savedReturnRecords(order).forEach(record=>push('sales',order,-Number(record.qty||0),unit,{...common,date:record.date,event:'退貨',eventId:record.id||'',status:'已退貨'}));
        const contribution=calculateOrderStatsContribution(order,'',localDateString());
        if(contribution.pendingQty>0)push('pending',order,contribution.pendingQty,unit,{...common,date:order.orderDate||'',event:'未送貨餘額',status:'待送貨'});
    });
    const supplyContext=(supply={})=>{
        const order=tradeAnalysisSourceOrders.get(supply.orderId)||salesStatisticsOrders.find(row=>row.id===supply.orderId);
        const line=order&&salesStatisticOrderLines(order).find(row=>row.itemId===supply.itemId||row.productId===supply.productId);
        return {record:{...line,...supply,productLine:supply.productLine||line?.productLine||'',productType:supply.productType||line?.productType||''},
            extra:{customer:order?.customerName||'',supplier:supply.supplier||'',documentNo:supply.purchaseDocumentNo||supply.internalNo||supply.id||'',
                orderId:supply.orderId||'',customerOrderNo:order?.orderNo||order?.quoteNo||supply.orderId||'',sales:stripPhoneSuffix(order?.salesName||supply.salesName)||'',sourceId:supply.id||'',
                fulfillment:supply.fulfillmentType==='DIRECT_SHIP'?'原廠直送':'倉庫到貨'}};
    };
    inventoryAnalysisSupplyOrders.forEach(supply=>{
        if(isPurchaseTerminalStatus(supply.status))return;
        const qty=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
        if(!qty)return;
        const context=supplyContext(supply);
        push('incoming',context.record,qty,tradeAnalysisCost(supply.unitCost),{...context.extra,date:supply.orderDate||'',expectedDate:supply.expectedDate||'',event:'未到貨餘額',status:'待到貨'});
    });
    inventoryAnalysisReceipts.forEach(receipt=>{
        const supply=supplies.get(receipt.supplyOrderId)||{};
        const context=supplyContext(supply);
        const lotCost=inventoryAnalysisLotCosts.get(receipt.lotId);
        const cost=receipt.fulfillmentType==='DIRECT_SHIP'?tradeAnalysisCost(supply.unitCost):tradeAnalysisCost(lotCost?.unitCost);
        push('purchases',{...context.record,...receipt,productId:receipt.productId||supply.productId||''},Number(receipt.qty||0),cost,{...context.extra,sourceId:receipt.supplyOrderId||'',date:receipt.receiptDate,event:'到貨',status:'已到貨',eventId:receipt.id,lotNo:receipt.lotNo||''});
    });
    inventoryAnalysisLots.forEach(lot=>{
        const supply=lot.sourceType==='SUPPLY_ORDER'?supplies.get(lot.sourceId)||{}:{};
        const context=supplyContext(supply);
        const lotCost=inventoryAnalysisLotCosts.get(lot.id);
        push('stock',{...context.record,...lot},Number(lot.remainingQty||0),tradeAnalysisCost(lotCost?.unitCost),{
            ...context.extra,date:localDateString(),event:'在庫',status:'在庫',lotNo:lot.lotNo||'',expiryDate:lot.expiryDate||'',warehouseId:lot.warehouseId||'',eventId:lot.id});
    });
    return rows;
}

function buildTradeAnalysisReport(rows = buildTradeAnalysisRows()) {
    const {start,end}=salesStatisticsQueryWindow();
    const filters={start,end,sales:document.getElementById('salesStatsSalesFilter')?.value||'',brand:document.getElementById('salesStatsBrandFilter')?.value||'',
        line:document.getElementById('salesStatsLineFilter')?.value||'',type:document.getElementById('salesStatsTypeFilter')?.value||''};
    return {...globalThis.YushinTradeAnalysis.summarize(rows,filters),filters};
}

function tradeAnalysisExportRows(report,kind) {
    return report.details[kind].map(row=>({
        '交易日期':row.date||'','類別':TRADE_ANALYSIS_LABELS[kind],'交易':row.event,'客戶':row.customer||'','供應商':row.supplier||'',
        '單號':row.documentNo||'','關聯客戶訂單':row.customerOrderNo||'','負責業務':row.sales||'','統計廠牌':row.brand,'實際廠牌':row.rawBrand,
        '產品線':row.line,'產品類型':row.type,'貨號':row.code,'品名':row.name,'數量':row.qty,
        '單價／成本':row.unitPrice===null?'待補成本':row.unitPrice,'金額':row.amount===null?'待補成本':row.amount,
        '狀態':row.status,'到貨方式':row.fulfillment||'','預計到貨日':row.expectedDate||'','倉庫':row.warehouseId||'',
        '批號':row.lotNo||'','效期':row.expiryDate||'','來源紀錄ID':row.sourceId||'','交易紀錄ID':row.eventId||''
    }));
}

window.openTradeAnalysisDetail = function(kind) {
    if(currentUserRole!=='admin'||!tradeAnalysisReady||salesStatisticsLoadPromise||!TRADE_ANALYSIS_LABELS[kind])return;
    tradeAnalysisDetailKind=kind;
    tradeAnalysisDetailReport=tradeAnalysisReport;
    const report=tradeAnalysisDetailReport;
    const detailRows=tradeAnalysisExportRows(report,kind);
    const columns=['交易日期','客戶','供應商','單號','業務','實際廠牌','產品線','產品類型','貨號','品名','數量','單價／成本','金額','交易'];
    document.getElementById('tradeAnalysisDetailTitle').textContent=TRADE_ANALYSIS_LABELS[kind]+'明細';
    document.getElementById('tradeAnalysisDetailSummary').textContent=`共 ${detailRows.length} 筆，合計 ${formatStatsMoney(report.totals[kind])}`+(report.missing[kind]?`；${report.missing[kind]} 筆待補成本，未計入金額`:'')+'。'+(['sales','purchases'].includes(kind)?`期間：${report.filters.start} 至 ${report.filters.end}`:'目前全部餘額');
    document.getElementById('tradeAnalysisDetailHead').innerHTML='<tr>'+columns.map(name=>`<th>${escapeHtml(name)}</th>`).join('')+'</tr>';
    const visible=detailRows.slice(0,100);
    document.getElementById('tradeAnalysisDetailBody').innerHTML=visible.length?visible.map(row=>'<tr>'+columns.map(name=>`<td>${escapeHtml(String(row[name]??''))}</td>`).join('')+'</tr>').join(''):`<tr><td colspan="${columns.length}">沒有符合條件的明細。</td></tr>`;
    if(detailRows.length>100)document.getElementById('tradeAnalysisDetailSummary').textContent+=' 畫面顯示前 100 筆；匯出包含全部明細。';
    document.getElementById('tradeAnalysisDetailOverlay').classList.add('active');
};
window.closeTradeAnalysisDetail = function() {
    document.getElementById('tradeAnalysisDetailOverlay')?.classList.remove('active');
};

async function writeTradeAnalysisWorkbook(report,kinds,button) {
    if(currentUserRole!=='admin'||!report||!kinds.length||kinds.some(kind=>!TRADE_ANALYSIS_LABELS[kind]))return;
    const state=beginActionButton(button,'匯出中…');
    if(button&&!state)return;
    try{
        await ensureXlsxLoaded();
        const wb=XLSX.utils.book_new();
        const filters=report.filters;
        const summary=[
            {'項目':'已完成交易期間','內容':`${filters.start} 至 ${filters.end}`},
            {'項目':'未完成及庫存','內容':'目前全部餘額'},
            ...[['業務',filters.sales||'全部負責業務'],['廠牌',filters.brand||'全部廠牌'],['產品線',filters.line||'全部產品線'],['產品類型',filters.type||'全部類型']].map(([name,value])=>({'項目':name,'內容':value})),
            {'項目':'金額口徑','內容':'銷售含稅；採購及庫存依紀錄單位成本；不混合加總不同單位數量。'},
            {'項目':'負責業務篩選範圍','內容':'只篩銷貨與待送貨；進貨、待到貨、庫存為公司共同數字。'},
            ...kinds.map(kind=>({'項目':TRADE_ANALYSIS_LABELS[kind],'內容':report.totals[kind],'明細筆數':report.details[kind].length,'待補成本筆數':report.missing[kind]}))
        ];
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(summary),'篩選與總計');
        kinds.forEach(kind=>{
            const rows=tradeAnalysisExportRows(report,kind);
            rows.push({'交易':'總計','金額':report.totals[kind],'狀態':report.missing[kind]?`有 ${report.missing[kind]} 筆待補成本`:'完整'});
            const sheet=XLSX.utils.json_to_sheet(rows);
            sheet['!cols']=Object.keys(rows[0]).map(name=>({wch:['品名','客戶','供應商'].includes(name)?28:18}));
            XLSX.utils.book_append_sheet(wb,sheet,TRADE_ANALYSIS_LABELS[kind]);
        });
        XLSX.writeFile(wb,`進銷存-${kinds.length===1?TRADE_ANALYSIS_LABELS[kinds[0]]:'全部明細'}-${filters.start}-${filters.end}.xlsx`);
    }catch(err){alert('匯出失敗：'+(err.message||err));}
    finally{if(button)endActionButton(button,state);}
}
window.exportTradeAnalysisDetail = function() {
    return writeTradeAnalysisWorkbook(tradeAnalysisDetailReport,[tradeAnalysisDetailKind],document.getElementById('tradeAnalysisExport'));
};
window.exportTradeAnalysis = async function() {
    if(currentUserRole!=='admin'||!tradeAnalysisReady||salesStatisticsLoadPromise||tradeAnalysisFiltersPending)return;
    const button=document.getElementById('tradeAnalysisWorkbookBtn');
    const state=beginActionButton(button,'匯出中…');if(!state)return;
    try {
        const filters={...tradeAnalysisAppliedFilters},tab=tradeAnalysisTab;
        const rows=buildSimpleTradeAnalysis(filters);
        const labels=simpleTradeAnalysisLabels().filter(label=>label!=='毛利率');
        const data=rows.map(r=>({'單號':r.documentNo,'廠牌':r.brand,'貨號':r.code,'品名':r.name,'產品線':r.line,'產品類型':r.type,'倉庫':r.warehouse,...Object.fromEntries(labels.map((l,i)=>[l,r.values[i]===null?'待補成本':r.values[i]])),...(r.quantities?{'現有數量':r.quantities[0],'已預留數量':r.quantities[1],'可用數量':r.quantities[2]}:{})}));
        const totals=labels.map((_,i)=>rows.reduce((n,r)=>n+(r.values[i]??0),0));
        const missing=rows.some(r=>r.values.some(v=>v===null));
        data.push({'品名':'總計',...Object.fromEntries(labels.map((l,i)=>[l,i===3&&missing?'待補成本':totals[i]]))});
        const {start,end}=filters;
        const scope=[{'項目':'期間','內容':tradeAnalysisTab==='inventory'?'目前庫存':`${start} 至 ${end} 成立的單據，目前履約進度`},{'項目':'廠牌','內容':filters.brand||'全部'},{'項目':'產品線','內容':filters.line||'全部'},{'項目':'產品類型','內容':filters.type||'全部'},{'項目':'業務','內容':tradeAnalysisTab==='selling'?(filters.sales||'全部'):'公司共同數字'},{'項目':'估值說明','內容':document.getElementById('tradeAnalysisScope').textContent},{'項目':'資料完整性','內容':missing?'缺少成本的金額未計入；毛利待補成本':'完整'}];
        if(tradeAnalysisTab==='selling'&&labels.includes('毛利'))scope.push({'項目':'毛利率','內容':missing?'待補成本':totals[1]?totals[3]/totals[1]:0});
        await ensureXlsxLoaded();
        if(currentUserRole!=='admin'||(tab==='selling'&&labels.includes('毛利')&&!tradeAnalysisSensitiveVisible))
            throw new Error('登入身份或毛利顯示設定已變更，請確認後重新匯出。');
        const wb=XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(scope),'篩選與總計');
        XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(data),'品項明細');
        XLSX.writeFile(wb,`進銷存分析_${tab}_${localDateString()}.xlsx`);
    }catch(err){alert('匯出失敗：'+(err.message||err));}finally{endActionButton(button,state);}
};

function populateSalesStatisticsFilters(rows = buildTradeAnalysisRows()) {
    const brand = document.getElementById('salesStatsBrandFilter')?.value || '';
    const classified = rows.filter(row=>!brand||row.brand===brand);
    const selects = [
        { id: 'salesStatsSalesFilter', label: '全部負責業務', values: rows.filter(row=>['sales','pending'].includes(row.kind)).map(row=>row.sales) },
        { id: 'salesStatsBrandFilter', label: '全部廠牌', values: [...getPrimaryBrandNames(), OTHER_BRAND_OPTION_KEY] },
        { id: 'salesStatsTypeFilter', label: '全部產品類型', values: classified.map(row=>row.type) },
        { id: 'salesStatsLineFilter', label: '全部產品線', values: classified.map(row=>row.line) }
    ];
    selects.forEach(({id,label,values})=>{
        const select=document.getElementById(id);
        if(!select)return;
        const selected=select.value;
        const options=[...new Set([...values,selected].filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-Hant'));
        select.innerHTML=`<option value="">${label}</option>`+options.map(value=>`<option value="${escapeAttr(value)}">${escapeHtml(value)}</option>`).join('');
        if(options.includes(selected))select.value=selected;
    });
}

window.renderAdminStatistics = function() {
    if(currentUserRole!=='admin')return;
    tradeAnalysisAppliedFilters=readTradeAnalysisFilters();
    tradeAnalysisFiltersPending=false;
    resetSimpleTradeAnalysisDetail();
    return loadSalesStatistics();
};

window.setSalesStatisticsPeriod = function(period) {
    const now = new Date();
    const year = now.getFullYear();
    let start = '', end = '';
    if (period === 'month') {
        start = localDateString().slice(0,7)+'-01';
        end = localDateString();
    } else if (/^q[1-4]$/.test(period)) {
        const quarter = parseInt(period.slice(1), 10);
        const firstMonth = (quarter - 1) * 3 + 1;
        const lastDay = new Date(year, firstMonth + 2, 0).getDate();
        start = `${year}-${String(firstMonth).padStart(2, '0')}-01`;
        end = `${year}-${String(firstMonth + 2).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    } else if (period === 'ytd') {
        start = `${year}-01-01`;
        end = localDateString();
    } else if (period === 'custom') {
        return;
    }
    document.getElementById('salesStatsStart').value = start;
    document.getElementById('salesStatsEnd').value = end;
    markTradeAnalysisFiltersPending();
};

function buildSalesStatisticsReport() {
    const start = document.getElementById('salesStatsStart')?.value || '';
    const end = document.getElementById('salesStatsEnd')?.value || '';
    const salesFilter = document.getElementById('salesStatsSalesFilter')?.value || '';
    const brandFilter = document.getElementById('salesStatsBrandFilter')?.value || '';
    const typeFilter = document.getElementById('salesStatsTypeFilter')?.value || '';
    const lineFilter = document.getElementById('salesStatsLineFilter')?.value || '';
    const byBrand = {}, bySales = {}, byType = {}, byLine = {}, byTransaction = {};
    const total = newSalesStatsMetric();
    const details = [];

    salesStatisticsOrders.flatMap(salesStatisticOrderLines).forEach(order => {
        const sales = stripPhoneSuffix(order.salesName) || '未指定負責業務';
        const line = productLineForOrder(order);
        const type = productTypeForOrder(order);
        const brand = statisticBrandForOrder(order);
        const transaction = order.transactionType || '未選擇';
        if ((salesFilter && sales !== salesFilter) || (brandFilter && brand !== brandFilter) || (typeFilter && type !== typeFilter) || (lineFilter && line !== lineFilter)) return;
        const contribution = calculateOrderStatsContribution(order, start, end);
        if (!contribution.actualSales && !contribution.pendingSales && !contribution.actualQty && !contribution.pendingQty) return;
        addSalesStatsContribution(total, order, contribution);
        if (!byBrand[brand]) byBrand[brand] = newSalesStatsMetric();
        if (!bySales[sales]) bySales[sales] = newSalesStatsMetric();
        if (!byType[type]) byType[type] = newSalesStatsMetric();
        if (!byLine[line]) byLine[line] = newSalesStatsMetric();
        if (!byTransaction[transaction]) byTransaction[transaction] = newSalesStatsMetric();
        addSalesStatsContribution(byBrand[brand], order, contribution);
        addSalesStatsContribution(bySales[sales], order, contribution);
        addSalesStatsContribution(byType[type], order, contribution);
        addSalesStatsContribution(byLine[line], order, contribution);
        addSalesStatsContribution(byTransaction[transaction], order, contribution);
        details.push({ order, sales, brand, type, line, transaction, contribution });
    });

    return {
        start, end, salesFilter, brandFilter, typeFilter, lineFilter,
        total, byBrand, bySales, byType, byLine, byTransaction, details
    };
}

function renderUnifiedBrandAnalytics() {
    if(tradeAnalysisReady&&!salesStatisticsLoadPromise)renderSalesStatistics();
}

window.switchTradeAnalysisTab = function(tab) {
    if(!['purchasing','selling','inventory'].includes(tab))return;
    tradeAnalysisTab=tab;
    const sensitiveButton=document.getElementById('tradeAnalysisSensitiveBtn');if(sensitiveButton)sensitiveButton.hidden=tab!=='selling';
    document.getElementById('salesStatsSalesField').hidden=tab!=='selling';
    document.querySelectorAll('[data-analysis-period]').forEach(el=>el.hidden=tab==='inventory');
    document.querySelectorAll('[data-analysis-tab]').forEach(el=>{
        el.classList.toggle('active',el.dataset.analysisTab===tab);
        el.setAttribute('aria-selected',String(el.dataset.analysisTab===tab));
    });
    renderAdminStatistics();
};

function buildSimpleTradeAnalysis(filters = readTradeAnalysisFilters()) {
    const {start,end,brand,line,sales,type}=filters;
    const matches=row=>(!brand||statisticBrandForOrder(row)===brand)&&(!line||productLineForOrder(row)===line)&&(!type||productTypeForOrder(row)===type);
    const lotsByStock=new Map();
    inventoryAnalysisLots.forEach(l=>{const key=JSON.stringify([l.warehouseId,l.productKey||l.productId]);if(!lotsByStock.has(key))lotsByStock.set(key,[]);lotsByStock.get(key).push(l);});
    const rows=[];
    const add=(record,values)=>rows.push({documentNo:record.purchaseDocumentNo||record.orderNo||record.id||'',warehouse:record.warehouseId||'',code:record.itemCode||findPriceItemForOrder(record)?.model||record.productKey||'',name:record.itemName||findPriceItemForOrder(record)?.nameCn||'',brand:statisticBrandForOrder(record),line:productLineForOrder(record),type:productTypeForOrder(record),...values});
    if(tradeAnalysisTab==='purchasing')inventoryAnalysisSupplyOrders.forEach(row=>{
        const order=tradeAnalysisSourceOrders.get(row.orderId);
        const item=order?normalizedOrderItems(order).find(item=>String(item.itemId||'')===String(row.itemId||'')):null;
        row={...order,...item,...row};
        if(!matches(row)||!dateInStatsRange(row.orderDate,start,end)||!['ORDERED','PARTIAL_RECEIPT','RECEIVED','CLOSED','CANCELLED'].includes(row.status))return;
        const ordered=Math.max(0,Number(row.qty||0)),received=Math.min(ordered,Math.max(0,Number(row.receivedQty||0)));
        const qty=isPurchaseTerminalStatus(row.status)?received:ordered;
        const unit=tradeAnalysisCost(row.unitCost);
        add(row,{values:[unit===null?null:qty*unit,unit===null?null:received*unit,unit===null?null:(qty-received)*unit],zeroCost:unit===0 && qty>0});
    });
    if(tradeAnalysisTab==='selling')salesStatisticsOrders.flatMap(salesStatisticOrderLines).forEach(row=>{
        if(!matches(row)||!dateInStatsRange(row.orderDate,start,end)||(sales&&stripPhoneSuffix(row.salesName)!==sales))return;
        const c=calculateOrderStatsContribution(row,'',localDateString());
        if(normalizedOrderStatus(row)!=='normal'&&!c.actualQty)return;
        const unit=orderUnitSalesAmount(row),actual=c.actualQty*unit,pending=c.pendingQty*unit;
        let cost=0,known=true,zeroCost=false;
        const records=[...savedDeliveryRecords(row).map(r=>({...r,sign:1})),...savedReturnRecords(row).map(r=>({...r,sign:-1}))];
        records.forEach(r=>{
            const allocations=r.lotAllocations||[];
            if(!allocations.length){
                const supplies=inventoryAnalysisSupplyOrders.filter(s=>s.orderId===row.id&&s.itemId===row.itemId&&s.fulfillmentType==='DIRECT_SHIP'&&s.status!=='CANCELLED');
                const costs=supplies.map(s=>tradeAnalysisCost(s.unitCost));
                if(supplies.length===1&&costs[0]!==null){cost+=r.sign*Number(r.qty||0)*costs[0];if(costs[0]===0&&Number(r.qty||0)>0)zeroCost=true;}else known=false;
                return;
            }
            if(Math.abs(allocations.reduce((n,a)=>n+Number(a.qty||0),0)-Number(r.qty||0))>0.000001)known=false;
            allocations.forEach(a=>{const u=tradeAnalysisCost(inventoryAnalysisLotCosts.get(a.lotId)?.unitCost);if(u===null)known=false;else {cost+=r.sign*Number(a.qty||0)*u;if(u===0&&Number(a.qty||0)>0)zeroCost=true;}});
        });
        if(row.isDelivered&&!savedDeliveryRecords(row).length)known=false;
        add(row,{values:[actual+pending,actual,pending,known?actual-cost:null],actual,zeroCost});
    });
    if(tradeAnalysisTab==='inventory')tradeAnalysisWarehouseStocks.forEach(stock=>{
        const lots=lotsByStock.get(JSON.stringify([stock.warehouseId,stock.productKey||stock.productId]))||[];
        const record={...lots[0],...stock,productId:stock.productId||lots[0]?.productId||stock.productKey};if(!matches(record))return;
        const onHand=Number(stock.onHand||0),reserved=Number(stock.reserved||0);
        let value=0,known=lots.length>0,zeroCost=false;
        lots.forEach(l=>{const cost=tradeAnalysisCost(inventoryAnalysisLotCosts.get(l.id)?.unitCost);if(cost===null)known=false;else {value+=Number(l.remainingQty||0)*cost;if(cost===0&&Number(l.remainingQty||0)>0)zeroCost=true;}});
        if(Math.abs(lots.reduce((n,l)=>n+Number(l.remainingQty||0),0)-onHand)>0.000001)known=false;
        const unit=known&&onHand?value/onHand:null;
        add(record,{values:[unit===null?null:value,unit===null?null:reserved*unit,unit===null?null:(onHand-reserved)*unit],quantities:[onHand,reserved,onHand-reserved],zeroCost});
    });
    return rows;
}

window.renderSalesStatistics = function() {
    if(currentUserRole!=='admin'||!tradeAnalysisReady)return;
    const stockMetadata=new Map(inventoryAnalysisLots.map(lot=>[JSON.stringify([lot.warehouseId,lot.productKey||lot.productId]),lot]));
    const records=tradeAnalysisTab==='selling'?salesStatisticsOrders.flatMap(salesStatisticOrderLines):tradeAnalysisTab==='purchasing'
        ?inventoryAnalysisSupplyOrders.map(row=>{
            const order=tradeAnalysisSourceOrders.get(row.orderId);
            const item=order?normalizedOrderItems(order).find(item=>String(item.itemId||'')===String(row.itemId||'')):null;
            return {...order,...item,...row};
        }):tradeAnalysisWarehouseStocks.map(row=>({...stockMetadata.get(JSON.stringify([row.warehouseId,row.productKey||row.productId])),...row}));
    populateSalesStatisticsFilters(records.map(row=>({kind:tradeAnalysisTab==='selling'?'sales':'stock',brand:statisticBrandForOrder(row),
        sales:stripPhoneSuffix(row.salesName),line:productLineForOrder(row),type:productTypeForOrder(row)})));
    const rows=buildSimpleTradeAnalysis(tradeAnalysisAppliedFilters);
    tradeAnalysisSimpleRows=rows;
    resetSimpleTradeAnalysisDetail();
    const labels=simpleTradeAnalysisLabels();
    const totals=labels.map((_,i)=>rows.reduce((n,row)=>n+(row.values[i]??0),0));
    const missing=rows.filter(row=>row.values.some(value=>value===null)).length;
    document.getElementById('tradeAnalysisCards').innerHTML=labels.map((label,i)=>{
        const text=i===4?(missing?'待補成本':totals[1]?((totals[3]/totals[1])*100).toFixed(1)+'%':'－'):(i===3&&missing?'待補成本':formatStatsMoney(totals[i]));
        return `<div class="sales-stat-card"><span>${label}</span><strong>${escapeHtml(text)}</strong></div>`;
    }).join('');
    document.getElementById('tradeAnalysisScope').textContent=tradeAnalysisTab==='inventory'?'目前分倉數量；預留金額以同品項同倉批次加權平均成本估值。':'依所選期間成立日期篩選，顯示目前累計到貨／出貨進度。取消／結案未履約餘額不計入總額；退貨扣回實際出貨。銷售沿用含稅金額，毛利以可確認的實際批次／直送採購成本計算。';
    const filters=tradeAnalysisAppliedFilters;
    const scope=tradeAnalysisTab==='inventory'?'目前庫存':`${filters.start} 至 ${filters.end} 成立的單據`;
    document.getElementById('tradeAnalysisStatus').textContent=scope+`｜共 ${rows.length} 筆`+(missing?`；${missing} 筆缺少成本或批次數量不一致，金額僅加總可確認成本。${tradeAnalysisTab==='selling'?'毛利與毛利率待補成本後顯示。':''}`:'')+(rows.some(row=>row.zeroCost)?`；${rows.filter(row=>row.zeroCost).length} 筆採用零成本，請確認是否為贈品或尚待補登。`:'');
    if(tradeAnalysisFiltersPending)markTradeAnalysisFiltersPending();
};

function salesStatsMetricExportRows(values, grandTotal, label) {
    return Object.entries(values)
        .sort((a, b) => b[1].totalSales - a[1].totalSales)
        .map(([name, metric]) => ({
            [label]: name,
            '實際送貨金額': Math.round(metric.actualSales),
            '待出貨金額': Math.round(metric.pendingSales),
            '總金額': Math.round(metric.totalSales),
            '總成本': Math.round(metric.totalCost),
            '毛利': metric.missingCostIds.size ? '待補成本' : Math.round(metric.profit),
            '毛利率': metric.missingCostIds.size ? '待補成本' : metric.totalSales ? (metric.profit / metric.totalSales * 100).toFixed(1) + '%' : '－',
            '占比': grandTotal ? (metric.totalSales / grandTotal * 100).toFixed(1) + '%' : '－',
            '成本未填筆數': metric.missingCostIds.size,
            '歷史推估金額': Math.round(metric.estimatedSales)
        }));
}

window.exportSalesStatisticsExcel = async function() {
    populateSalesStatisticsFilters();
    const report = buildSalesStatisticsReport();
    if (!report.start || !report.end) {
        alert('請先選擇統計起訖日期。');
        return;
    }
    if (!report.details.length) {
        alert('目前的日期與篩選條件沒有可匯出的季報資料。');
        return;
    }
    try {
        await ensureXlsxLoaded();
        const { total } = report;
        const summaryRows = [
            { '項目': '統計期間', '內容': `${report.start} 至 ${report.end}` },
            { '項目': '負責業務篩選', '內容': report.salesFilter || '全部負責業務' },
            { '項目': '廠牌篩選', '內容': report.brandFilter || '全部廠牌' },
            { '項目': '類型篩選', '內容': report.typeFilter || '全部類型' },
            { '項目': '產品線篩選', '內容': report.lineFilter || '全部產品線' },
            { '項目': '有效訂單筆數', '內容': total.orderIds.size },
            { '項目': '實際送貨金額', '內容': Math.round(total.actualSales) },
            { '項目': '待出貨金額', '內容': Math.round(total.pendingSales) },
            { '項目': '總金額', '內容': Math.round(total.totalSales) },
            { '項目': '總成本', '內容': Math.round(total.totalCost) },
            { '項目': '毛利', '內容': total.missingCostIds.size ? '待補成本' : Math.round(total.profit) },
            { '項目': '毛利率', '內容': total.missingCostIds.size ? '待補成本' : total.totalSales ? (total.profit / total.totalSales * 100).toFixed(1) + '%' : '－' },
            { '項目': '成本未填筆數', '內容': total.missingCostIds.size },
            { '項目': '歷史推估金額', '內容': Math.round(total.estimatedSales) },
            { '項目': '歷史推估筆數', '內容': total.estimatedIds.size }
        ];
        const detailRows = report.details
            .sort((a, b) => (a.order.orderDate || '').localeCompare(b.order.orderDate || ''))
            .map(({ order, sales, brand, type, line, transaction, contribution }) => {
                const hasCost = orderHasCost(order);
                const totalSales = contribution.actualSales + contribution.pendingSales;
                const totalCost = contribution.actualCost + contribution.pendingCost;
                return {
                    '訂單日期': order.orderDate || '',
                    '來源估價單': order.quoteNo || '',
                    '採購單號': order.purchaseOrderNo || '',
                    '客戶名稱': order.customerName || '',
                    '負責業務': sales,
                    '統計廠牌': brand,
                    '原始廠牌': order.brand || '',
                    '產品類型': type,
                    '產品線': line,
                    '貨號': order.itemCode || '',
                    '品名': order.itemName || '',
                    '交易方式': transaction,
                    '訂單數量': orderQuantity(order),
                    '期間實際送貨數量': contribution.actualQty,
                    '截至迄日待出貨數量': contribution.pendingQty,
                    '實際送貨金額': Math.round(contribution.actualSales),
                    '待出貨金額': Math.round(contribution.pendingSales),
                    '總金額': Math.round(totalSales),
                    '總成本': Math.round(totalCost),
                    '毛利': hasCost ? Math.round(totalSales - totalCost) : '待補成本',
                    '毛利率': hasCost && totalSales ? ((totalSales - totalCost) / totalSales * 100).toFixed(1) + '%' : hasCost ? '－' : '待補成本',
                    '成本狀態': hasCost ? '已填' : '未填',
                    '資料註記': contribution.estimated ? '歷史推估資料' : ''
                };
            });
        const workbook = XLSX.utils.book_new();
        const appendSheet = (rows, name, widths) => {
            const sheet = XLSX.utils.json_to_sheet(rows);
            sheet['!cols'] = widths.map(width => ({ wch: width }));
            XLSX.utils.book_append_sheet(workbook, sheet, name);
        };
        appendSheet(summaryRows, '摘要', [18, 24]);
        appendSheet(salesStatsMetricExportRows(report.byBrand, total.totalSales, '廠牌'), '廠牌', [18, 16, 16, 16, 16, 16, 12, 12, 14, 16]);
        appendSheet(salesStatsMetricExportRows(report.bySales, total.totalSales, '業務'), '業務', [18, 16, 16, 16, 16, 16, 12, 12, 14, 16]);
        appendSheet(salesStatsMetricExportRows(report.byTransaction, total.totalSales, '交易方式'), '交易方式', [18, 16, 16, 16, 16, 16, 12, 12, 14, 16]);
        appendSheet(detailRows, '訂單明細', [12, 16, 16, 22, 12, 14, 14, 14, 14, 16, 28, 12, 12, 18, 18, 16, 16, 16, 16, 16, 12, 14, 16]);
        XLSX.writeFile(workbook, `銷售季報_${report.start}_至_${report.end}.xlsx`);
    } catch (err) {
        console.error('匯出季報失敗：', err);
        alert('匯出季報失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function renderMissingCostOrders() {
    const tbody = document.getElementById('missingCostOrdersBody');
    const summary = document.getElementById('missingCostOrdersSummary');
    if (!tbody || !summary) return;
    const report = buildSalesStatisticsReport();
    const missingRows = report.details.filter(({ order }) => !orderHasCost(order));
    summary.innerText = `${report.start || '未指定'} 至 ${report.end || '未指定'}，依目前篩選條件共 ${missingRows.length} 筆。請填寫每單位含稅進貨成本。`;
    tbody.innerHTML = missingRows.length ? missingRows.map(({ order, sales, brand }) => `
        <tr>
            <td>${escapeHtml(order.orderDate || '')}</td>
            <td>${escapeHtml(order.customerName || '')}</td>
            <td>${escapeHtml(sales)}</td>
            <td>${escapeHtml(brand)}</td>
            <td class="missing-cost-product"><strong>${escapeHtml(order.itemName || '－')}</strong><br><small>${escapeHtml(order.itemCode || '')}</small></td>
            <td>${escapeHtml(String(orderQuantity(order)))}</td>
            <td>${formatStatsMoney(salesAmount(order))}</td>
            <td><input type="number" min="0" step="0.01" class="missing-cost-input" aria-label="${escapeAttr(order.itemName || '訂單')}單位成本" onchange="saveMissingCostFromStats(${inlineJsValue(order.id)},${inlineJsValue(order.itemId || '')},${inlineJsValue(orderStatsProductId(order))},${inlineJsValue(order.procurementType || 'PURCHASING_PO')}, this)"><small class="missing-cost-save-state"></small></td>
        </tr>
    `).join('') : '<tr><td colspan="8" style="color:#888;padding:18px;">目前篩選範圍內沒有缺少成本的訂單。</td></tr>';
}

window.openMissingCostOrders = function() {
    renderMissingCostOrders();
    document.getElementById('missingCostOrdersOverlay')?.classList.add('active');
};

window.closeMissingCostOrders = function() {
    document.getElementById('missingCostOrdersOverlay')?.classList.remove('active');
};

window.saveMissingCostFromStats = async function(orderId, itemId, productId, procurementType, input) {
    if (currentUserRole !== 'admin' && currentUserRole !== 'purchaser') {
        alert('只有採購或管理員可以補填成本。');
        renderMissingCostOrders();
        return;
    }
    const cost = Number(input.value);
    if (input.value === '' || !Number.isFinite(cost) || cost < 0) {
        alert('請輸入大於或等於 0 的單位成本。');
        input.focus();
        return;
    }
    const state = input.parentElement?.querySelector('.missing-cost-save-state');
    input.disabled = true;
    if (state) state.innerText = '儲存中…';
    try {
        if (procurementType === 'SALES_SELF_ORDER') {
            const original = salesStatisticsOrders.find(order => order.id === orderId) || ordersCache.find(order => order.id === orderId);
            if (!original) throw new Error('找不到原訂單。');
            const updates = {
                costPrice: cost,
                costSource: 'manual_transaction_cost_correction',
                updatedAt: new Date().toISOString()
            };
            if (Array.isArray(original.items) && original.items.length) {
                updates.items = original.items.map((item, index) => {
                    const sameItem = itemId ? item.itemId === itemId : index === 0;
                    return sameItem ? { ...item, costPrice:cost, costSource:'manual_transaction_cost_correction' } : item;
                });
            }
            await db.collection('orders').doc(orderId).set(updates, { merge:true });
            const applyLocal = order => {
                if (!order) return;
                order.costPrice = cost;
                order.costSource = 'manual_transaction_cost_correction';
                if (updates.items) order.items = updates.items;
            };
            applyLocal(salesStatisticsOrders.find(order => order.id === orderId));
            applyLocal(ordersCache.find(order => order.id === orderId));
        } else {
            const resolvedProductId = String(productId || '').trim();
            if (!resolvedProductId) throw new Error('這筆訂單找不到產品主檔，無法安全寫入標準成本。');
            const line = salesStatisticsOrders.flatMap(salesStatisticOrderLines)
                .find(order => order.id === orderId && orderStatsProductId(order) === resolvedProductId);
            await db.collection('productCosts').doc(resolvedProductId).set({
                productId: resolvedProductId,
                productLineId: line?.productLine || '',
                standardCost: cost,
                salesVisible: false,
                source: 'STATS_COST_UPDATE',
                updatedAt: new Date().toISOString(),
                updatedBy: currentUser?.uid || ''
            }, { merge:true });
            purchaseCostCache.set(resolvedProductId, cost);
            invalidateVisibleProductCosts();
        }
        renderSalesStatistics();
        renderMissingCostOrders();
    } catch (err) {
        input.disabled = false;
        if (state) state.innerText = '儲存失敗';
        alert('成本儲存失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function inlineJsValue(value) { return escapeAttr(JSON.stringify(String(value ?? ''))); }
function escapeAttr(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 早期估價單/訂單的「業務」欄位存的是「姓名 電話」黏在一起的舊格式（例如「周博恩 0937-907-169」），
// 訂單管理系統的「負責業務」欄位只需要顯示姓名，這裡統一去掉後面的電話號碼
function stripPhoneSuffix(name) {
    if (!name) return '';
    return name.toString().replace(/\s+\d[\d\-]{6,}\s*$/, '').trim();
}

// 點選清單資料列時保留灰底選取狀態；按鈕、輸入框與下拉選單維持原本操作，不會誤切換列。
function bindListRowSelection(row) {
    row.addEventListener('click', event => {
        if (event.target.closest('button, input, select, textarea, label, a, details, summary')) return;
        const tbody = row.parentElement;
        tbody?.querySelectorAll('tr.list-row-selected').forEach(selected => selected.classList.remove('list-row-selected'));
        row.classList.add('list-row-selected');
    });
}

