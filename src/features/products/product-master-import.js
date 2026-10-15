/* ---------- Product Master：正式主檔與資料維護 ---------- */
let productMasterMigrationRunning = false;

function productItemWithoutCost(item) {
    const clean = { ...item };
    delete clean.cost;
    delete clean.standardCost;
    delete clean.purchaseCost;
    return clean;
}

function productMasterRecordFromItem(item, source = 'PRODUCT_MASTER') {
    const normalized = normalizeProductMasterItem(item);
    const brand = resolveBrandName(normalized.brand || '');
    const brandEntry = brandMasterEntryForName(brand);
    const status = normalized.active === false ? 'INACTIVE' : 'ACTIVE';
    return {
        productId: normalized.productId || stableProductId(normalized),
        brandId: brandEntry?.id || '',
        brandName: brand,
        manufacturerPartNo: normalized.model || normalized.sku || '',
        normalizedPartNo: normalizeItemCodeLoose(normalized.model || normalized.sku || ''),
        productName: normalized.nameCn || normalized.nameEn || '',
        nameEn: normalized.nameEn || '',
        productLine: normalized.productLine || '',
        productLineId: normalized.productLine || '',
        category: normalized.productType || '',
        productType: normalized.productType || '',
        specification: normalized.spec || '',
        unit: normalized.unit || '',
        listPrice: Number(normalized.price || 0),
        inventoryTracked: !!normalized.inventoryTracked,
        lotTracked: !!normalized.lotTracked,
        expiryTracked: !!normalized.expiryTracked,
        status,
        active: status === 'ACTIVE',
        source: String(normalized.source || source || 'PRODUCT_MASTER').toUpperCase(),
        ...(normalized.createdAt ? { createdAt: normalized.createdAt } : {}),
        updatedAt: new Date().toISOString(),
        updatedBy: currentUser?.uid || ''
    };
}

async function readCollectionForMigration(name, pageSize = 300) {
    const rows = [];
    let cursor = null;
    while (true) {
        let query = db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(pageSize);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(
            query.get(),
            name + ' 遷移資料'
        );
        if (snap.empty) break;
        snap.docs.forEach(doc => rows.push({ ref:doc.ref, id:doc.id, data:doc.data() || {} }));
        cursor = snap.docs[snap.docs.length - 1];
        if (snap.size < pageSize) break;
    }
    return rows;
}

// 共用批次寫入：Firestore 單一 write batch 有筆數上限，因此大型 Product Master／成本更新分批提交。
// 各操作需可安全重跑；若中途網路失敗，已完成的批次保留，使用者可再次執行未完成部分。
async function commitMigrationBatch(operations, chunkSize = 400) {
    const safeOperations = Array.isArray(operations)
        ? operations.filter(operation => typeof operation === 'function')
        : [];
    if (!safeOperations.length) return 0;

    const safeChunkSize = Math.max(1, Math.min(400, Number(chunkSize) || 400));
    let committed = 0;
    for (let i = 0; i < safeOperations.length; i += safeChunkSize) {
        const chunk = safeOperations.slice(i, i + safeChunkSize);
        const batch = db.batch();
        chunk.forEach(operation => operation(batch));
        try {
            await batch.commit();
        } catch (err) {
            err.committedOperations = committed;
            err.totalOperations = safeOperations.length;
            throw err;
        }
        committed += chunk.length;
    }
    return committed;
}
function recordContainsEmbeddedCost(record) {
    return !!record && (record.cogs !== undefined || (Array.isArray(record.lotAllocations) && record.lotAllocations.some(row => row && (row.cost !== undefined || row.unitCost !== undefined))));
}
function inventoryCostMigrationPlan(lots, inventory, receipts, movements, orders = [], warehouseStocks = []) {
    return {
        legacyLots: lots.filter(row => row.data.unitCost !== undefined),
        legacyInventory: inventory.filter(row => row.data.unitCost !== undefined || row.data.cost !== undefined || (Array.isArray(row.data.lots) && row.data.lots.some(lot => lot && (lot.unitCost !== undefined || lot.cost !== undefined)))),
        legacyWarehouseStocks: warehouseStocks.filter(row => row.data.unitCost !== undefined || row.data.cost !== undefined),
        legacyReceipts: receipts.filter(row => row.data.unitCost !== undefined || row.data.purchaseNetAmount !== undefined),
        legacyMovements: movements.filter(row => row.data.unitCost !== undefined || row.data.purchaseNetAmount !== undefined || row.data.cogs !== undefined),
        legacyOrders: orders.filter(row => [...(row.data.deliveryRecords || []), ...(row.data.returnRecords || [])].some(recordContainsEmbeddedCost))
    };
}
async function readCollectionInBatches(collectionName, batchSize = 500) {
    const rows = [];
    let cursor = null;
    while (true) {
        let query = db.collection(collectionName).orderBy(firebase.firestore.FieldPath.documentId()).limit(batchSize);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), collectionName + ' 批次資料');
        snap.forEach(doc => rows.push({ id:doc.id, ...doc.data() }));
        if (snap.size < batchSize) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return rows;
}

async function readQueryInBatches(baseQuery, batchSize = 500) {
    const rows = [];
    let cursor = null;
    while (true) {
        let query = baseQuery.limit(batchSize);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), '批次查詢資料');
        snap.forEach(doc => rows.push({ id:doc.id, ...doc.data() }));
        if (snap.size < batchSize) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return rows;
}

function systemAuditProductKey(record = {}) {
    return String(record.productKey || record.productId || '').trim();
}

const TEST_DATA_RESET_DELETE_COLLECTIONS = [
    'orders','purchaseOrders','procurementDemands','supplyOrders','inventoryReservations','inventoryLots','inventoryLotCosts',
    'receipts','customerReturnReceipts','dispatchRecords','deliveries','inventoryMovements','auditLogs','receivingSupplyOrders'
];
// Immutable operational evidence cannot be partially deleted by the client.
const TEST_DATA_RESET_PROTECTED_COLLECTIONS = ['stockTransfers','stockTransferRequests','stockOperations'];
async function assertClientTestResetSafe() {
    for (const name of TEST_DATA_RESET_PROTECTED_COLLECTIONS) {
        const snap = await firestoreReadWithTimeout(db.collection(name).limit(1).get(), `${name} 初始化安全檢查`);
        if (!snap.empty) throw new Error('系統已有調撥或庫存交易憑證，不能使用前台初始化。請使用後端完整初始化流程，避免留下部分清除資料。');
    }
}
let testDataResetPreviewState = null;

async function countCollectionDocuments(name) {
    let count = 0, cursor = null;
    while (true) {
        let query = db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(500);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), `${name} 文件數量`);
        count += snap.size;
        if (snap.size < 500) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return count;
}

async function deleteCollectionInBatches(name, onProgress) {
    let deleted = 0;
    while (true) {
        const snap = await firestoreReadWithTimeout(
            db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(300).get(),
            `${name} 清除批次`
        );
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(doc => batch.delete(doc.ref));
        await batch.commit();
        deleted += snap.size;
        if (onProgress) onProgress(deleted);
        if (snap.size < 300) break;
    }
    return deleted;
}

async function resetStockCollection(name, status) {
    let cursor = null, updated = 0;
    while (true) {
        let query = db.collection(name).orderBy(firebase.firestore.FieldPath.documentId()).limit(300);
        if (cursor) query = query.startAfter(cursor);
        const snap = await firestoreReadWithTimeout(query.get(), `${name} 庫存歸零批次`);
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(doc => batch.set(doc.ref, {
            onHand:0, reserved:0, available:0, incoming:0, shortage:0,
            updatedAt:new Date().toISOString(), resetBy:currentUser.uid
        }, {merge:true}));
        await batch.commit();
        updated += snap.size;
        if (status) status.textContent = `庫存歸零中：${name} ${updated} 筆…`;
        if (snap.size < 300) break;
        cursor = snap.docs[snap.docs.length - 1];
    }
    return updated;
}

window.previewTestDataReset = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有真正的管理員可以執行系統初始化。');
    const button=document.getElementById('testDataResetPreviewBtn');
    const preview=document.getElementById('testDataResetPreview');
    const wrap=document.getElementById('testDataResetConfirmWrap');
    const status=document.getElementById('testDataResetStatus');
    if(!button||button.disabled)return;
    button.disabled=true;if(wrap)wrap.style.display='none';if(status)status.textContent='';
    try{
        testDataResetPreviewState=null;
        await assertClientTestResetSafe();
        const counts={};
        for(const name of ['quotes',...TEST_DATA_RESET_DELETE_COLLECTIONS,'forecasts','inventory','warehouseStocks']){
            if(preview)preview.textContent=`正在檢查 ${name}…`;
            counts[name]=await countCollectionDocuments(name);
        }
        const forecasts=await readCollectionInBatches('forecasts');
        let progressCount=0;
        for(const forecast of forecasts){
            progressCount += await countCollectionDocuments(`forecasts/${forecast.id}/progress`);
        }
        counts.forecastProgress=progressCount;
        testDataResetPreviewState={counts,checkedAt:new Date().toISOString()};
        const deleteTotal=TEST_DATA_RESET_DELETE_COLLECTIONS.reduce((sum,name)=>sum+(counts[name]||0),0)+(counts.forecasts||0)+progressCount;
        if(preview)preview.textContent=
            `待永久刪除：${deleteTotal} 筆營運文件\n`+
            `Forecast ${counts.forecasts||0}（進度 ${progressCount}）、訂單 ${counts.orders||0}、採購單 ${counts.purchaseOrders||0}、供應／自購 ${counts.supplyOrders||0}\n`+
            `庫存交易相關 ${deleteTotal-(counts.forecasts||0)-progressCount-(counts.orders||0)-(counts.purchaseOrders||0)-(counts.supplyOrders||0)} 筆\n`+
            `另將 inventory ${counts.inventory||0} 筆、warehouseStocks ${counts.warehouseStocks||0} 筆數量歸零。\nMaster Data、帳號、角色、倉庫與系統設定保留。\n`+
            `保留估價單 ${counts.quotes||0} 筆，內容與成交狀態維持原樣；其中指向已清除 Forecast／訂單的連結將無法開啟。`;
        if(wrap)wrap.style.display='';
    }catch(err){
        console.error('檢查測試資料失敗：',err);
        if(preview)preview.textContent='檢查失敗：'+(err.message||err);
        testDataResetPreviewState=null;
    }finally{button.disabled=false;}
};

window.executeTestDataReset = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有真正的管理員可以執行系統初始化。');
    const input=document.getElementById('testDataResetConfirmInput');
    const button=document.getElementById('testDataResetExecuteBtn');
    const status=document.getElementById('testDataResetStatus');
    if(!testDataResetPreviewState)return alert('請先執行「檢查待清除資料」。');
    if((input?.value||'').trim()!=='保留估價單清除測試資料')return alert('確認文字不正確。');
    if(!confirm(`最後確認：保留 ${testDataResetPreviewState.counts.quotes||0} 筆估價單，永久清除其他測試營運資料並將庫存歸零？此操作無法復原。`))return;
    button.disabled=true;
    try{
        await assertClientTestResetSafe();
        const forecasts=await readCollectionInBatches('forecasts');
        for(let i=0;i<forecasts.length;i++){
            const forecast=forecasts[i];
            if(status)status.textContent=`清除 Forecast 進度 ${i+1}/${forecasts.length}…`;
            await deleteCollectionInBatches(`forecasts/${forecast.id}/progress`);
        }
        for(const name of TEST_DATA_RESET_DELETE_COLLECTIONS){
            if(status)status.textContent=`清除 ${name}…`;
            await deleteCollectionInBatches(name,n=>{if(status)status.textContent=`清除 ${name}：已刪除 ${n} 筆…`;});
        }
        await deleteCollectionInBatches('forecasts');
        await resetStockCollection('inventory',status);
        await resetStockCollection('warehouseStocks',status);

        forecastCache=[]; forecastHistorySearchResults=[];
        ordersCache=[]; orderHistorySearchResults=[]; pendingPurchaseCache=[]; purchasingDispatchCache=[];
        poListCache=[]; supplyReceivingCache=[]; receivingSourceOrderStatusCache=new Map(); inventoryCache=[];
        orderPaginationState=null; loadedMainPages.clear();
        testDataResetPreviewState=null;
        if(input)input.value='';
        document.getElementById('testDataResetConfirmWrap').style.display='none';
        document.getElementById('testDataResetPreview').textContent='';
        if(status)status.textContent='初始化完成：估價單已保留，其他測試營運資料已清除，庫存與分倉數量已歸零。請重新整理以更新畫面。';
    }catch(err){
        console.error('系統初始化失敗：',err);
        if(status)status.textContent='初始化中斷：'+(err.message||err)+'\n請不要繼續建立新資料，先重新檢查剩餘資料後再執行一次。';
    }finally{button.disabled=false;}
};

let systemDataAuditIssues = [];

function systemAuditItemCode(record = {}) {
    const explicit=record.manufacturerPartNo||record.itemCode||record.sku;
    if(explicit)return String(explicit);
    let key=String(record.productKey||record.productId||record.id||'');
    try { key=decodeURIComponent(key); } catch (_) {}
    if(key.includes('__'))key=key.split('__').pop();
    if(key.startsWith('code:'))return key.slice(5);
    if(key.startsWith('prd:'))return key.split(':').slice(2).join(':');
    return key;
}
function systemAuditActionLabel(issue) {
    if(issue.target?.kind==='product')return '編輯產品';
    if(issue.target?.kind==='duplicates')return '比較重複產品';
    if(issue.type.includes('找不到產品主檔'))return '查找／補建產品';
    return '查看並處理';
}
window.openSystemAuditIssue = async function(index) {
    if(trueUserRole!=='admin'||currentUserRole!=='admin')return;
    const issue=systemDataAuditIssues[index];
    if(!issue?.target)return;
    if(issue.target.kind==='product')return openProductMasterEditor(issue.target.record.id);
    let overlay=document.getElementById('systemAuditIssueOverlay');
    if(!overlay){
        overlay=document.createElement('div');overlay.id='systemAuditIssueOverlay';overlay.className='modal-overlay';
        overlay.addEventListener('click',event=>{if(event.target===overlay)overlay.classList.remove('active');});
        document.body.appendChild(overlay);
    }
    const target=issue.target,record=target.record||{},code=systemAuditItemCode(record);
    const action=(label,kind,value='')=>`<button type="button" class="btn-small" onclick="followSystemAuditShortcut(${index},'${kind}',${Number(value)||0})">${escapeHtml(label)}</button>`;
    const actions=[];
    if(target.kind==='duplicates')target.records.forEach((product,i)=>actions.push(action(`編輯 ${product.manufacturerPartNo||product.sku||product.id}（${i+1}）`,'duplicate',i)));
    if(issue.type.includes('找不到產品主檔'))actions.push(action('查找產品','product-search'),action('補建產品','product-new'));
    if(['inventory','stock','supply','demand','reservation'].includes(target.kind)&&code)actions.push(action('查看此品項庫存','inventory'));
    if(target.kind==='order')actions.push(action('開啟來源訂單','order'));
    if(target.kind==='reservation'&&(record.orderId||record.sourceId))actions.push(action('開啟來源訂單','order'));
    if(target.kind==='purchase')actions.push(action('開啟採購單追蹤','purchase'));
    if(target.kind==='supply'&&record.purchaseDocumentId)actions.push(action('開啟採購單追蹤','purchase'));
    if(target.kind==='demand'){
        if(record.sourceType==='SALES_ORDER'&&record.sourceId)actions.push(action('開啟來源訂單','order'));
        (target.supplies||[]).forEach((supply,i)=>{if(supply.purchaseDocumentId)actions.push(action(`開啟供應採購單 ${supply.internalNo||i+1}`,'demand-purchase',i));});
    }
    if(issue.type.includes('倉庫'))actions.push(action('設定倉庫','warehouses'));
    if(target.kind==='user')actions.push(action('人員管理','sales'));
    const guidance=issue.type.includes('找不到產品主檔')?'先查找是否已有正確產品；確認缺少時可補建。建立後請重新執行健康檢查，確認來源資料是否已正確連結。'
        :target.kind==='duplicates'?'逐筆比較產品資料，確認保留的產品後，可在產品管理停用重複品項。'
        :target.kind==='product'?'修改後請重新執行健康檢查。'
        :'先核對下列來源資料，再開啟對應畫面處理；沒有提供編輯入口的關聯異常，需要確認原因後修正。';
    const rows=target.kind==='duplicates'?target.records:[record,...(target.supplies||[])];
    const fields=[['id','紀錄識別碼'],['brand','廠牌'],['brandName','廠牌'],['itemCode','貨號'],['manufacturerPartNo','貨號'],['itemName','品名'],['productName','品名'],['productKey','產品識別碼'],['productId','產品識別碼'],['orderId','來源訂單'],['sourceId','來源識別碼'],['demandId','採購需求'],['purchaseDocumentId','採購單'],['warehouseId','倉庫'],['requestedQty','需求量'],['orderedQty','已採購數量'],['qty','數量'],['receivedQty','已到貨'],['onHand','現有量'],['reserved','預留量']];
    overlay.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="資料健康處理" style="max-width:780px;max-height:85vh;overflow:auto;"><div style="display:flex;justify-content:space-between;gap:12px;"><h3>${escapeHtml(issue.type)}</h3><button type="button" class="btn-secondary" onclick="document.getElementById('systemAuditIssueOverlay').classList.remove('active')">關閉</button></div><p>${escapeHtml(issue.detail)}</p><p>${escapeHtml(guidance)}</p><div style="display:flex;gap:8px;flex-wrap:wrap;margin:12px 0;">${actions.join('')}</div>${rows.map(row=>`<div class="table-wrap"><table><tbody>${fields.filter(([key])=>row[key]!==undefined&&row[key]!==null&&String(row[key])!=='').map(([key,label])=>`<tr><th>${escapeHtml(label)}</th><td style="overflow-wrap:anywhere;">${escapeHtml(String(row[key]))}</td></tr>`).join('')}</tbody></table></div>`).join('')}<p style="font-size:12px;color:#666;">資料為本次檢查的快照。完成後回到資料健康，重新檢查即可確認結果。</p></div>`;
    overlay.classList.add('active');
};
window.followSystemAuditShortcut = async function(index,kind,recordIndex=0) {
    if(trueUserRole!=='admin'||currentUserRole!=='admin')return;
    const issue=systemDataAuditIssues[index];if(!issue?.target)return;
    const target=issue.target,record=target.record||{},code=systemAuditItemCode(record);
    try{
        if(kind==='duplicate')await openProductMasterEditor(target.records[recordIndex]?.id);
        else if(kind==='product-new')populateProductMasterEditor({}, {source:'MANUAL',brand:record.brandName||record.brand||'',itemCode:code,itemName:record.productName||record.itemName||''});
        else if(kind==='product-search'){
            if(!code){showActionFeedback('來源未記錄貨號，請在產品頁用廠牌或品名查找。','warning');}
            switchMainTab('product-system',document.querySelector('[data-main-nav="products"]'));
            document.getElementById('productManagementSearch').value=code||record.itemName||record.productName||'';
            if(document.getElementById('productManagementSearch').value)await searchProductManagement();
        }else if(kind==='inventory'){
            switchMainTab('inventory-system',document.querySelector('[data-main-nav="inventory"]'));
            await switchInventoryWorkView(false);
            ['inventoryBrandFilter','inventoryPolicyFilter'].forEach(id=>{document.getElementById(id).value='';});
            document.getElementById('inventoryStateFilter').value='all';
            document.getElementById('inventorySearch').value=code;
            await runInventoryUnifiedSearchNow();
        }else if(kind==='order'){
            const id=target.kind==='order'?record.id:record.orderId||record.sourceId;
            const snap=await firestoreReadWithTimeout(db.collection('orders').doc(id).get(),'讀取來源訂單');
            if(!snap.exists)throw new Error('來源訂單已不存在，請核對檢查結果中的來源識別碼。');
            ordersCache=ordersCache.filter(row=>row.id!==id).concat({id:snap.id,...snap.data()});
            openDeliveryModal(id);
        }else if(kind==='purchase'||kind==='demand-purchase'){
            const id=kind==='demand-purchase'?target.supplies[recordIndex]?.purchaseDocumentId:target.kind==='purchase'?record.id:record.purchaseDocumentId;
            await openPurchaseOrderTimeline(id);
        }else if(kind==='warehouses'||kind==='sales'){
            switchAdminTab(kind,document.getElementById(`admin-sub-${kind}`));
        }else return;
        document.getElementById('systemAuditIssueOverlay')?.classList.remove('active');
    }catch(err){showActionFeedback('無法開啟處理畫面：'+(err.message||err),'warning');}
};

window.runSystemDataAudit = async function() {
    if (trueUserRole !== 'admin') return;
    const button = document.getElementById('systemDataAuditBtn');
    const status = document.getElementById('systemDataAuditStatus');
    const results = document.getElementById('systemDataAuditResults');
    if (!button || !status || !results || button.disabled) return;
    button.disabled = true;
    button.textContent = '檢查中…';
    status.textContent = '讀取主檔與關聯資料中…';
    results.innerHTML = '';
    systemDataAuditIssues = [];
    document.getElementById('systemAuditIssueOverlay')?.classList.remove('active');
    try {
        const [products, users, warehouses, orders, purchaseOrders, procurementDemands, supplyOrders, inventory, warehouseStocks, reservations] = await Promise.all([
            readCollectionInBatches('products'),
            readCollectionInBatches('users'),
            readCollectionInBatches('warehouses'),
            readCollectionInBatches('orders'),
            readCollectionInBatches('purchaseOrders'),
            readCollectionInBatches('procurementDemands'),
            readCollectionInBatches('supplyOrders'),
            readCollectionInBatches('inventory'),
            readCollectionInBatches('warehouseStocks'),
            readCollectionInBatches('inventoryReservations')
        ]);
        const issues = [];
        const productIds = new Set();
        const productCodes = new Set();
        const duplicateProducts = new Map();
        products.forEach(product => {
            const id = String(product.productId || product.id || '').trim();
            if (id) productIds.add(id);
            const brand = String(product.brandName || product.brand || '').trim();
            const rawCode = String(product.manufacturerPartNo || product.itemCode || product.sku || '').trim();
            const code = normalizeItemCodeLoose(rawCode);
            const name = String(product.productName || product.nameCn || product.nameEn || '').trim();
            const label = [brand || '未設定廠牌', rawCode || id || '未設定貨號'].join(' / ');
            if (!brand) issues.push({ target:{kind:'product',record:product}, type:'產品主檔缺少廠牌', detail:label });
            if (!rawCode) issues.push({ target:{kind:'product',record:product}, type:'產品主檔缺少貨號', detail:label });
            if (!name) issues.push({ target:{kind:'product',record:product}, type:'產品主檔缺少品名', detail:label });
            if (code) productCodes.add(code);
            const duplicateKey = normalizeBrandLookupKey(brand) + '|' + code;
            if (code) {
                const list = duplicateProducts.get(duplicateKey) || [];
                list.push(product);
                duplicateProducts.set(duplicateKey, list);
            }
        });
        duplicateProducts.forEach((list, key) => {
            if (list.length > 1) issues.push({ target:{kind:'duplicates',records:list}, type:'產品主檔重複', detail:`${key}：${list.length} 筆` });
        });

        const validRoles = new Set(['admin','sales','purchaser','warehouse','engineer']);
        users.forEach(user => {
            if (!validRoles.has(String(user.role || ''))) issues.push({ target:{kind:'user',record:user}, type:'人員角色異常', detail:`${user.name || user.email || user.id}：${user.role || '未設定'}` });
        });

        const orderIds = new Set(orders.map(order => String(order.id || '').trim()).filter(Boolean));
        const warehouseIds = new Set(warehouses.filter(w => w.active !== false).map(w => String(w.warehouseId || w.id || '').trim()).filter(Boolean));
        const knownProduct = record => {
            const key = systemAuditProductKey(record);
            const code = normalizeItemCodeLoose(record.itemCode || record.manufacturerPartNo || '');
            return !key && !code ? true : (productIds.has(key) || productCodes.has(code));
        };

        orders.forEach(order => {
            if(String(order.inventoryReservationStatus||'')==='failed'){
                issues.push({ target:{kind:'order',record:order},type:'訂單庫存同步失敗',detail:`${order.orderNo||order.id}｜${order.inventoryReservationError||'庫存預留未完成'}`});
            }
            const orderItems=normalizedOrderItems(order);
            if(!orderItems.length&&!knownProduct(order))issues.push({ target:{kind:'order',record:order}, type:'訂單找不到產品主檔', detail:`${order.orderNo || order.id}｜${order.itemCode || order.productKey || ''}` });
            orderItems.forEach((item,index)=>{
                if(!knownProduct(item))issues.push({ target:{kind:'order',record:order},type:'訂單品項找不到產品主檔',detail:`${order.orderNo||order.id}｜第 ${index+1} 項｜${item.itemCode||item.productId||''}`});
            });
            if ((order.fulfillmentType || '') === 'WAREHOUSE' && order.warehouseId && !warehouseIds.has(String(order.warehouseId))) {
                issues.push({ target:{kind:'order',record:order}, type:'訂單倉庫不存在', detail:`${order.orderNo || order.id}｜${order.warehouseId}` });
            }
        });

        const supplyIds = new Set(supplyOrders.map(row => String(row.id || '').trim()).filter(Boolean));
        const orderById = new Map(orders.map(order => [String(order.id || '').trim(), order]));
        const demandById = new Map(procurementDemands.map(demand => [String(demand.demandId || '').trim(), demand]).filter(([id]) => id));
        const suppliesByDemand = new Map();
        supplyOrders.forEach(supply => {
            const demandId=String(supply.demandId||'').trim();
            if(!demandId)return;
            const rows=suppliesByDemand.get(demandId)||[];
            rows.push(supply);
            suppliesByDemand.set(demandId,rows);
        });

        procurementDemands.forEach(demand => {
            const demandId=String(demand.demandId||'').trim();
            const sourceType=String(demand.sourceType||'').trim();
            const sourceId=String(demand.sourceId||'').trim();
            const sourceItemId=String(demand.sourceItemId||'').trim();
            const requested=Math.max(0,Number(demand.requestedQty||0));
            const ordered=Math.max(0,Number(demand.orderedQty||0));
            const received=Math.max(0,Number(demand.receivedQty||0));
            if(!demandId)issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求缺少識別碼', detail:demand.id || '未知文件' });
            const linkedSupplies=suppliesByDemand.get(demandId)||[];
            if(demandId&&linkedSupplies.length&&globalThis.YushinProcurementDemand?.reconcileLinkedSupplies){
                const linkedProjection=globalThis.YushinProcurementDemand.reconcileLinkedSupplies(demand,linkedSupplies);
                if(Math.abs(linkedProjection.orderedQty-ordered)>1e-9||Math.abs(linkedProjection.receivedQty-received)>1e-9){
                    issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]},
                        type:'採購需求與供應紀錄不同步',
                        detail:`${demandId}｜採購需求已採購 ${ordered}／已到 ${received}；供應紀錄回推已採購 ${linkedProjection.orderedQty}／已到 ${linkedProjection.receivedQty}`
                    });
                }
            }
            if(received>ordered||ordered>requested){
                issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求數量異常', detail:`${demandId || demand.id}｜需求 ${requested}／已採購 ${ordered}／已到 ${received}` });
            }
            if(sourceType==='SALES_ORDER'){
                const sourceOrder=orderById.get(sourceId);
                if(!sourceOrder){
                    issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求來源訂單不存在', detail:`${demandId || demand.id}｜${sourceId || '未指定'}` });
                }else if(sourceItemId&&!normalizedOrderItems(sourceOrder).some(item=>String(item.itemId||'')===sourceItemId)){
                    issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'採購需求來源品項不存在', detail:`${demandId || demand.id}｜${sourceId}／${sourceItemId}` });
                }
            }else if(sourceType==='STOCK_REPLENISHMENT'&&!knownProduct(demand)){
                issues.push({ target:{kind:'demand',record:demand,supplies:suppliesByDemand.get(demand.demandId)||[]}, type:'補庫需求找不到產品主檔', detail:`${demandId || demand.id}｜${demand.itemCode || demand.productKey || sourceId}` });
            }
        });

        purchaseOrders.forEach(po => {
            const itemOrderIds=[...new Set(purchaseItemsFromSavedPo(po).map(item=>String(item.orderId||'').trim()).filter(Boolean))];
            itemOrderIds.forEach(sourceOrderId => {
                if (!orderIds.has(sourceOrderId)) issues.push({ target:{kind:'purchase',record:po}, type:'採購單文件來源訂單不存在', detail:`${po.poNo || po.id}｜${sourceOrderId}` });
            });
            (Array.isArray(po.supplyOrderIds)?po.supplyOrderIds:[]).forEach(supplyId => {
                const id=String(supplyId||'').trim();
                if(id&&!supplyIds.has(id))issues.push({ target:{kind:'purchase',record:po}, type:'採購單文件找不到供應紀錄', detail:`${po.poNo || po.id}｜${id}` });
            });
        });

        supplyOrders.forEach(supply => {
            const sourceOrderId=String(supply.orderId||'').trim();
            const demandId=String(supply.demandId||'').trim();
            if(!demandId)issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄缺少採購需求', detail:`${supply.internalNo || supply.id}｜未記錄 demandId` });
            else if(!demandById.has(demandId))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄找不到採購需求', detail:`${supply.internalNo || supply.id}｜${demandId}` });
            if(sourceOrderId&&!orderIds.has(sourceOrderId))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄來源訂單不存在', detail:`${supply.internalNo || supply.id}｜${sourceOrderId}` });
            if(!knownProduct(supply))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄找不到產品主檔', detail:`${supply.internalNo || supply.id}｜${supply.itemCode || supply.productKey || ''}` });
            const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
            const warehouseId=String(supply.warehouseId||'').trim();
            if(!directShip&&(!warehouseId||!warehouseIds.has(warehouseId)))issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄倉庫異常', detail:`${supply.internalNo || supply.id}｜${warehouseId || '未指定'}` });
            const qty=Math.max(0,Number(supply.qty||0));
            const received=Math.max(0,Number(supply.receivedQty||0));
            if(!(qty>0)||received>qty)issues.push({ target:{kind:'supply',record:supply}, type:'供應紀錄數量異常', detail:`${supply.internalNo || supply.id}｜採購數量 ${qty}／已到 ${received}` });
        });

        inventory.forEach(item => {
            // inventory 只保留產品索引／總覽快取；實際數量以 warehouseStocks 為準。
            // 健康檢查不可再把 aggregate cache 的 onHand / reserved 當成正式庫存錯誤。
            if (!knownProduct(item)) issues.push({ target:{kind:'inventory',record:item}, type:'庫存索引找不到產品主檔', detail:`${item.itemCode || item.id}` });
            const policy=String(item.stockPolicy||'ORDER_ONLY').toUpperCase();
            const safetyStock=Number(item.safetyStock||0);
            if(!Object.values(INVENTORY_STOCK_POLICIES).includes(policy)){
                issues.push({ target:{kind:'inventory',record:item}, type:'庫存策略異常', detail:`${item.itemCode || item.id}｜${policy || '未設定'}` });
            }else if(policy===INVENTORY_STOCK_POLICIES.SAFETY_STOCK && !(safetyStock>0)){
                issues.push({ target:{kind:'inventory',record:item}, type:'安全庫存設定異常', detail:`${item.itemCode || item.id}｜安全庫存 ${safetyStock}` });
            }else if(policy!==INVENTORY_STOCK_POLICIES.SAFETY_STOCK && safetyStock>0){
                issues.push({ target:{kind:'inventory',record:item}, type:'庫存策略與安全庫存不一致', detail:`${item.itemCode || item.id}｜${inventoryStockPolicyLabel(policy)}／安全庫存 ${safetyStock}` });
            }
        });

        warehouseStocks.forEach(stock => {
            if (stock.warehouseId && !warehouseIds.has(String(stock.warehouseId))) issues.push({ target:{kind:'stock',record:stock}, type:'分倉指向不存在倉庫', detail:`${stock.id}｜${stock.warehouseId}` });
            if (!knownProduct(stock)) issues.push({ target:{kind:'stock',record:stock}, type:'分倉找不到產品主檔', detail:`${stock.id}` });
            const n = inventoryNumbers(stock);
            if (n.onHand < 0 || n.reserved < 0 || n.reserved > n.onHand) issues.push({ target:{kind:'stock',record:stock}, type:'分倉數量異常', detail:`${stock.id}｜現有 ${n.onHand}／預留 ${n.reserved}` });
        });

        reservations.filter(r => r.status === 'active').forEach(reservation => {
            const orderId = String(reservation.orderId || reservation.sourceId || reservation.id || '').trim();
            if (orderId && !orderIds.has(orderId)) issues.push({ target:{kind:'reservation',record:reservation}, type:'庫存預留來源訂單不存在', detail:`${reservation.orderNo || reservation.id}｜${orderId}` });
            if (!knownProduct(reservation)) issues.push({ target:{kind:'reservation',record:reservation}, type:'庫存預留找不到產品主檔', detail:`${reservation.orderNo || reservation.id}｜${reservation.productKey || reservation.itemCode || ''}` });
        });

        const counts = `Product ${products.length}、人員 ${users.length}、訂單 ${orders.length}、採購單文件 ${purchaseOrders.length}、採購需求 ${procurementDemands.length}、供應紀錄 ${supplyOrders.length}、庫存索引 ${inventory.length}、分倉 ${warehouseStocks.length}、預留 ${reservations.length}`;
        status.textContent = issues.length ? `檢查完成：${counts}。發現 ${issues.length} 項需確認。` : `檢查完成：${counts}。未發現上述關聯異常。`;
        systemDataAuditIssues = issues;
        results.innerHTML = issues.length
            ? '<div class="table-wrap"><table><thead><tr><th>類型</th><th>內容</th><th>處理</th></tr></thead><tbody>' + issues.slice(0,500).map((issue,index) => `<tr><td>${escapeHtml(issue.type)}</td><td>${escapeHtml(issue.detail)}</td><td><button type="button" class="btn-small" onclick="openSystemAuditIssue(${index})">${escapeHtml(systemAuditActionLabel(issue))}</button></td></tr>`).join('') + '</tbody></table></div>' + (issues.length > 500 ? `<div style="font-size:12px;color:#666;margin-top:6px;">畫面只顯示前 500 項，共 ${issues.length} 項。</div>` : '')
            : '<div style="padding:10px;background:#f4f8f4;border-radius:6px;">目前未發現需要處理的資料關聯異常。</div>';
    } catch (err) {
        console.error('系統資料檢查失敗：', err);
        status.textContent = '檢查失敗：' + err.message;
    } finally {
        button.disabled = false;
        button.textContent = '執行資料檢查';
    }
};

window.previewInventoryCostMigration = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有管理員可以執行庫存成本隔離。');
    const status=document.getElementById('inventoryCostMigrationStatus'), runButton=document.getElementById('inventoryCostMigrationBtn'), previewButton=document.getElementById('inventoryCostMigrationPreviewBtn');
    if(previewButton)previewButton.disabled=true;if(runButton)runButton.disabled=true;if(status)status.innerText='正在分頁掃描舊庫存成本欄位…';
    try{
        // Array.map 會額外傳入 index；不可直接把 readCollectionForMigration 當 callback，
        // 否則第一個集合會把 index 0 誤當 pageSize，造成 Firestore limit(0) 失敗。
        const [lots,inventory,receipts,movements,orders,warehouseStocks]=await Promise.all(
            ['inventoryLots','inventory','receipts','inventoryMovements','orders','warehouseStocks']
                .map(name => readCollectionForMigration(name))
        );
        const plan=inventoryCostMigrationPlan(lots,inventory,receipts,movements,orders,warehouseStocks);window._inventoryCostMigrationPlan=plan;
        const total=plan.legacyLots.length+plan.legacyInventory.length+plan.legacyWarehouseStocks.length+plan.legacyReceipts.length+plan.legacyMovements.length+plan.legacyOrders.length;
        if(status)status.innerText=`預覽完成：批次成本 ${plan.legacyLots.length}、庫存文件 ${plan.legacyInventory.length}、分倉成本 ${plan.legacyWarehouseStocks.length}、收貨 ${plan.legacyReceipts.length}、異動 ${plan.legacyMovements.length}、舊訂單成本 ${plan.legacyOrders.length}。\n`+(total?'請先執行「庫存成本隔離」，完成後再部署新版 Firestore Rules。':'沒有發現舊成本欄位，可直接進行新版 Rules 驗證。');
        if(runButton)runButton.disabled=total===0;
    }catch(err){console.error('庫存成本隔離預覽失敗：',err);if(status)status.innerText='預覽失敗：'+(err.message||err);}
    finally{if(previewButton)previewButton.disabled=false;}
};
window.runInventoryCostMigration = async function() {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') return alert('只有管理員可以執行庫存成本隔離。');
    const plan=window._inventoryCostMigrationPlan;if(!plan)return alert('請先按「預覽庫存成本隔離」。');
    if(!confirm('確定執行庫存成本隔離？\n\n舊 inventoryLots 成本會搬到 inventoryLotCosts；公開庫存、收貨與異動文件中的成本欄位會移除。此步驟應在部署新版 Firestore Rules 前完成。'))return;
    const status=document.getElementById('inventoryCostMigrationStatus'),runButton=document.getElementById('inventoryCostMigrationBtn'),previewButton=document.getElementById('inventoryCostMigrationPreviewBtn');
    if(runButton)runButton.disabled=true;if(previewButton)previewButton.disabled=true;
    const del=firebase.firestore.FieldValue.delete(),ops=[],now=new Date().toISOString(),by=currentUser?.uid||'';
    plan.legacyLots.forEach(row=>{const d=row.data;ops.push(batch=>batch.set(db.collection('inventoryLotCosts').doc(row.id),{lotId:row.id,productKey:d.productKey||'',productId:d.productId||'',warehouseId:d.warehouseId||'',unitCost:Number(d.unitCost||0),sourceType:d.sourceType||'LEGACY_MIGRATION',sourceId:d.sourceId||'',migratedAt:now,migratedBy:by},{merge:true}));ops.push(batch=>batch.update(row.ref,{unitCost:del,costMigratedAt:now}));});
    plan.legacyInventory.forEach(row=>{const patch={costSanitizedAt:now};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.cost!==undefined)patch.cost=del;if(Array.isArray(row.data.lots))patch.lots=row.data.lots.map(lot=>{if(!lot||typeof lot!=='object')return lot;const {unitCost,cost,...rest}=lot;return rest;});ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyWarehouseStocks.forEach(row=>{const patch={costSanitizedAt:now};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.cost!==undefined)patch.cost=del;ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyReceipts.forEach(row=>{const patch={costSanitizedAt:now};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.purchaseNetAmount!==undefined)patch.purchaseNetAmount=del;ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyMovements.forEach(row=>{const patch={costSanitizedAt:now,costPending:true};if(row.data.unitCost!==undefined)patch.unitCost=del;if(row.data.purchaseNetAmount!==undefined)patch.purchaseNetAmount=del;if(row.data.cogs!==undefined)patch.cogs=del;ops.push(batch=>batch.update(row.ref,patch));});
    plan.legacyOrders.forEach(row=>{
        const sanitizeRecord=record=>{
            if(!record||typeof record!=='object')return record;
            const {cogs,...rest}=record;
            if(Array.isArray(rest.lotAllocations)) rest.lotAllocations=rest.lotAllocations.map(allocation=>{
                if(!allocation||typeof allocation!=='object')return allocation;
                const {cost,unitCost,...safe}=allocation;
                return safe;
            });
            return rest;
        };
        ops.push(batch=>batch.update(row.ref,{
            deliveryRecords:(row.data.deliveryRecords||[]).map(sanitizeRecord),
            returnRecords:(row.data.returnRecords||[]).map(sanitizeRecord),
            costSanitizedAt:now
        }));
    });
    try{if(status)status.innerText=`正在隔離 ${ops.length} 筆寫入，請不要關閉頁面…`;await commitMigrationBatch(ops);window._inventoryCostMigrationPlan=null;if(status)status.innerText='庫存成本隔離完成。正在重新檢查…';await window.previewInventoryCostMigration();}
    catch(err){console.error('庫存成本隔離失敗：',err);if(status)status.innerText='隔離中斷：'+(err.message||err)+'。流程可重複執行。';if(runButton)runButton.disabled=false;}
    finally{if(previewButton)previewButton.disabled=false;}
};
// Product Master 以單一標準 Excel 作為人工維護入口；匯入時依 productId 增量新增／更新，不刪除未出現在檔案中的產品。
function setPriceUploadProgress(percent, status, keepVisible = true) {
    const wrap = document.getElementById('priceUploadProgress');
    const statusEl = document.getElementById('priceUploadStatus');
    const percentEl = document.getElementById('priceUploadPercent');
    const bar = document.getElementById('priceUploadProgressBar');
    const safePercent = Math.max(0, Math.min(100, Math.round(percent)));
    if (wrap && statusEl && percentEl && bar) {
        wrap.style.display = keepVisible ? '' : 'none';
        statusEl.innerText = status;
        percentEl.innerText = `${safePercent}%`;
        bar.style.width = `${safePercent}%`;
    }
    const batchStatus = document.getElementById('productBatchMaintenanceStatus');
    if (batchStatus) {
        batchStatus.textContent = status ? `${status} ${safePercent}%` : '';
        batchStatus.style.color = /失敗|錯誤|中斷/.test(String(status || '')) ? '#b42318' : '#12502b';
    }
}

const PRODUCT_MASTER_IMPORT_FIELDS = [
    'productId','brandId','brandName','manufacturerPartNo','normalizedPartNo','productName','nameEn',
    'productLine','productLineId','category','productType','specification','unit','listPrice',
    'inventoryTracked','lotTracked','expiryTracked','status','active','source'
];

function productImportValueEqual(field, currentValue, nextValue) {
    if (field === 'listPrice') return Number(currentValue || 0) === Number(nextValue || 0);
    if (['inventoryTracked','lotTracked','expiryTracked','active'].includes(field)) return !!currentValue === !!nextValue;
    return String(currentValue ?? '') === String(nextValue ?? '');
}

// 只核對本次匯入的文件；正式儲存仍重新讀取，避免沿用過期預覽。

async function loadExistingProductImportState(productIds = [], costProductIds = []) {
    const uniqueProductIds = [...new Set((productIds || []).map(id => String(id || '').trim()).filter(Boolean))];
    const uniqueCostProductIds = [...new Set((costProductIds || []).map(id => String(id || '').trim()).filter(Boolean))];
    const existingProducts = new Map();
    const existingCosts = new Map();

    // 每次最多四個查詢，每個查詢最多 30 個指定 ID，避免大量檔案串行等待或無限制併發。
    for (const [collectionName, requestedIds, target, label] of [
        ['products', uniqueProductIds, existingProducts, '產品匯入產品比對'],
        ['productCosts', uniqueCostProductIds, existingCosts, '產品匯入成本比對']
    ]) {
        for (let offset = 0; offset < requestedIds.length; offset += 120) {
            const queries = [];
            for (let i = offset; i < Math.min(offset + 120, requestedIds.length); i += 30) {
                const ids = requestedIds.slice(i, i + 30);
                queries.push(firestoreReadWithTimeout(
                    db.collection(collectionName).where(firebase.firestore.FieldPath.documentId(), 'in', ids).get(),
                    label
                ));
            }
            const results = await Promise.all(queries);
            results.forEach(snapshot => snapshot.docs.forEach(doc => target.set(doc.id, doc.data() || {})));
        }
    }
    return { existingProducts, existingCosts };
}

// 匯入以廠牌＋貨號辨識產品，沿用雲端文件 ID，成本與訂單引用才能指向同一筆。
async function resolveProductImportIdentities(items) {
    const codeFor = item => normalizeItemCodeLoose(item.model || item.manufacturerPartNo || item.sku || '');
    const rows = items.filter(item => item.model || item.manufacturerPartNo || item.sku);
    if (!rows.length) return;
    const keyFor = item => normalizeBrandLookupKey(resolveBrandName(item.brand || item.brandName || '')) + '::' + codeFor(item);
    const seen = new Set();
    rows.forEach(item => {
        const key = keyFor(item);
        if (seen.has(key)) throw new Error(`貨號「${item.model || item.sku}」在檔案中重複出現（忽略大小寫與符號）。尚未寫入產品或成本。`);
        seen.add(key);
    });
    const codes = [...new Set(rows.map(codeFor))];
    const matches = new Map();
    for (let offset = 0; offset < codes.length; offset += 120) {
        const queries = [];
        for (let i = offset; i < Math.min(offset + 120, codes.length); i += 30) {
            queries.push(firestoreReadWithTimeout(
                db.collection('products').where('normalizedPartNo', 'in', codes.slice(i, i + 30)).get(),
                '產品匯入廠牌與貨號比對'
            ));
        }
        const snapshots = await Promise.all(queries);
        snapshots.forEach(snapshot => snapshot.docs.forEach(doc => {
            const data = doc.data() || {};
            const key = keyFor(data);
            if (!matches.has(key)) matches.set(key, new Map());
            matches.get(key).set(doc.id, data);
        }));
    }
    rows.forEach(item => {
        const candidates = matches.get(keyFor(item));
        if (candidates?.size > 1) throw new Error(`廠牌「${item.brand}」貨號「${item.model || item.sku}」已有 ${candidates.size} 筆產品，無法決定成本應更新哪一筆。請先核對重複產品；本次尚未寫入產品或成本。`);
        if (candidates?.size === 1) item.productId = candidates.keys().next().value;
    });
}

async function syncImportedBrandToFormalProductMaster(imported, storedBrand) {
    const canWriteFormalMaster = currentUserRole === 'admin' || currentUserRole === 'purchaser';
    if (!canWriteFormalMaster) return { productWrites:0, costWrites:0, unchangedRows:0 };

    const normalizedItems = normalizeProductMasterList((imported || []).map(item => ({ ...item, brand: storedBrand })));
    await resolveProductImportIdentities(normalizedItems);
    const productIds = [...new Set(normalizedItems.map(item => item.productId).filter(Boolean))];
    const costProductIds = [...new Set(normalizedItems.filter(item => item.standardCostProvided === true).map(item => item.productId).filter(Boolean))];
    const { existingProducts, existingCosts } = await loadExistingProductImportState(productIds, costProductIds);

    const now = new Date().toISOString();
    const updatedBy = currentUser?.uid || '';
    const operations = [];
    let productWrites = 0;
    let costWrites = 0;
    let unchangedRows = 0;

    normalizedItems.forEach(item => {
        const product = productMasterRecordFromItem(item, 'PRODUCT_IMPORT');
        product.status = item.active === false ? 'INACTIVE' : 'ACTIVE';
        product.active = product.status === 'ACTIVE';
        // 建議售價是選填欄位：匯入既有產品時留白代表「不變更」，
        // 新產品留白則不建立 listPrice，避免把未知價格寫成 0。
        if (item.listPriceProvided !== true) delete product.listPrice;

        const existingProduct = existingProducts.get(product.productId);
        let productPatch = null;
        if (!existingProduct) {
            productPatch = product;
        } else {
            const changed = {};
            PRODUCT_MASTER_IMPORT_FIELDS.forEach(field => {
                if (field === 'listPrice' && item.listPriceProvided !== true) return;
                if (!productImportValueEqual(field, existingProduct[field], product[field])) changed[field] = product[field];
            });
            if (Object.keys(changed).length) productPatch = { ...changed, updatedAt:now, updatedBy };
        }

        if (activeProductImportBatch && productPatch) productPatch = { ...(productPatch || {}), lastImportBatch:activeProductImportBatch.id, lastImportFile:activeProductImportBatch.file, lastImportedAt:activeProductImportBatch.date };
        let costPatch = null;
        if (item.standardCostProvided === true) {
            const standardCost = Number(item.standardCost);
            const existingCost = existingCosts.get(product.productId);
            const nextCost = {
                productId: product.productId,
                productLineId: product.productLineId || product.productLine || '',
                standardCost,
                salesVisible: false
            };
            const changedCost = {};
            Object.keys(nextCost).forEach(field => {
                const current = existingCost?.[field];
                const next = nextCost[field];
                const equal = field === 'standardCost' ? Number(current ?? NaN) === Number(next) : String(current ?? '') === String(next ?? '');
                if (!equal) changedCost[field] = next;
            });
            if (!existingCost || Object.keys(changedCost).length) {
                costPatch = {
                    ...(existingCost ? changedCost : nextCost),
                    source:'PRODUCT_IMPORT',
                    updatedAt:now,
                    updatedBy
                };
            }
        }

        if (!productPatch && !costPatch) {
            unchangedRows += 1;
            return;
        }
        if (productPatch) productWrites += 1;
        if (costPatch) costWrites += 1;
        operations.push(batch => {
            if (productPatch) batch.set(db.collection('products').doc(product.productId), productPatch, { merge:true });
            if (costPatch) batch.set(db.collection('productCosts').doc(product.productId), costPatch, { merge:true });
        });
    });

    await commitMigrationBatch(operations, 200);
    return { productWrites, costWrites, unchangedRows, items:normalizedItems };
}

async function saveProductMasterBrand(imported, brand) {
    brand = resolveBrandName(brand);
    if (!brandMasterEntryForName(brand)) {
        if (currentUserRole === 'admin') {
            await upsertBrandMaster(brand, { active:true });
        } else {
            throw new Error(`廠牌「${brand}」尚未建立廠牌主檔，請先由管理員建立廠牌。`);
        }
    }
    const normalizedItems = normalizeProductMasterList((imported || []).map(item => ({ ...item, brand })));
    const syncResult = await syncImportedBrandToFormalProductMaster(normalizedItems, brand);
    (syncResult.items || normalizedItems).map(productItemWithoutCost).forEach(item => cacheProductLookupItem(item));
    return { brand, ...syncResult };
}


let pendingPriceImportPreview = null;

async function summarizeProductMasterImport(groups, errors = []) {
    const rows = groups.flatMap(group => group.imported.map(raw => normalizeProductMasterItem({ ...raw, brand: group.brand })));
    await resolveProductImportIdentities(rows);
    const uniqueProductIds = [...new Set(rows.map(item => String(item.productId || '').trim()).filter(Boolean))];
    const costProductIds = [...new Set(rows.filter(item => item.standardCostProvided === true).map(item => String(item.productId || '').trim()).filter(Boolean))];
    const { existingProducts, existingCosts } = await loadExistingProductImportState(uniqueProductIds, costProductIds);

    const labels = {
        brandId:'廠牌', brandName:'廠牌', manufacturerPartNo:'貨號', normalizedPartNo:'貨號',
        productName:'中文品名', nameEn:'英文品名', specification:'規格',
        productLine:'產品線', productLineId:'產品線', productType:'產品類型', category:'產品類型',
        unit:'單位', listPrice:'建議售價', inventoryTracked:'庫存管理',
        lotTracked:'批號管理', expiryTracked:'效期管理', status:'啟用狀態', active:'啟用狀態'
    };
    const groupStats = new Map();
    const details = [];
    let added = 0, updated = 0, unchanged = 0, inactive = 0;

    rows.forEach(item => {
        const product = productMasterRecordFromItem(item, 'PRODUCT_IMPORT');
        product.status = item.active === false ? 'INACTIVE' : 'ACTIVE';
        product.active = product.status === 'ACTIVE';
        if (item.listPriceProvided !== true) delete product.listPrice;
        if (!item.active) inactive += 1;

        const existingProduct = existingProducts.get(product.productId);
        const changedFields = [];
        if (existingProduct) {
            PRODUCT_MASTER_IMPORT_FIELDS.forEach(field => {
                if (field === 'listPrice' && item.listPriceProvided !== true) return;
                if (!productImportValueEqual(field, existingProduct[field], product[field])) {
                    const label = labels[field] || field;
                    if (!changedFields.includes(label)) changedFields.push(label);
                }
            });
        }

        if (item.standardCostProvided === true) {
            const existingCost = existingCosts.get(product.productId);
            const nextCost = Number(item.standardCost);
            if (!existingCost || Number(existingCost.standardCost ?? NaN) !== nextCost) {
                changedFields.push('標準成本');
            }
        }

        let action = '不變';
        if (!existingProduct) {
            action = '新增';
            added += 1;
        } else if (changedFields.length) {
            action = '更新';
            updated += 1;
        } else {
            unchanged += 1;
        }

        const groupKey = normalizeBrandLookupKey(item.brand) + '::' + String(item.productLine || '').toLocaleLowerCase();
        if (!groupStats.has(groupKey)) {
            groupStats.set(groupKey, {
                brand:item.brand || '',
                productLine:item.productLine || '',
                count:0, added:0, updated:0, unchanged:0
            });
        }
        const stats = groupStats.get(groupKey);
        stats.count += 1;
        if (action === '新增') stats.added += 1;
        else if (action === '更新') stats.updated += 1;
        else stats.unchanged += 1;

        details.push({
            action,
            brand:item.brand || '',
            productLine:item.productLine || '',
            code:item.model || item.manufacturerPartNo || '',
            name:item.nameCn || item.nameEn || '',
            changedFields
        });
    });

    return {
        total:rows.length,
        added,
        updated,
        unchanged,
        inactive,
        costRows:rows.filter(item => item.standardCostProvided === true).length,
        errorCount:errors.length,
        errors:[...errors],
        brands:[...groupStats.values()],
        details
    };
}

async function confirmProductMasterImport(groups, errors = []) {
    if (errors.length) {
        const errorLines = errors.slice(0, 10).map((message, index) => `錯誤 ${index + 1}｜${message}`);
        const moreErrors = errors.length - errorLines.length;
        setPriceUploadProgress(0, `匯入檔有 ${errors.length} 筆錯誤；尚未讀取或寫入雲端。`, false);
        alert([
            '產品匯入檢查',
            '',
            ...errorLines,
            moreErrors > 0 ? `…另有 ${moreErrors} 筆錯誤未展開` : '',
            '',
            '有錯誤的匯入檔不會寫入雲端。請修正 Excel 後重新選擇檔案。'
        ].filter(Boolean).join('\n'));
        return false;
    }
    setPriceUploadProgress(62, '正在比對現有產品主檔，產生匯入差異預覽…');
    const summary = await summarizeProductMasterImport(groups, errors);
    pendingPriceImportPreview = summary;

    const groupLines = summary.brands.map(item =>
        `${item.brand} / ${item.productLine || '未分類'}：${item.count} 筆（新增 ${item.added}／更新 ${item.updated}／不變 ${item.unchanged}）`
    );
    const changedLines = summary.details
        .filter(item => item.action !== '不變')
        .slice(0, 15)
        .map(item => `${item.action}｜${item.brand} ${item.code || item.name || '未命名'}${item.changedFields.length ? '｜' + item.changedFields.join('、') : ''}`);
    const errorLines = summary.errors.slice(0, 10).map((message, index) => `錯誤 ${index + 1}｜${message}`);
    const moreChanged = summary.details.filter(item => item.action !== '不變').length - changedLines.length;
    const moreErrors = summary.errorCount - errorLines.length;

    const preview = [
        '產品匯入預覽（差異預覽）',
        '',
        ...groupLines,
        '',
        `合計 ${summary.total} 筆：新增 ${summary.added}／更新 ${summary.updated}／不變 ${summary.unchanged}／錯誤 ${summary.errorCount}`,
        `停用標記 ${summary.inactive} 筆；${summary.costRows} 筆含標準成本。`,
        '產品資料與建議售價寫入 products；標準成本寫入受保護的 productCosts。',
        '實際採購價、歷史訂單與庫存批次成本不會被覆蓋。',
        changedLines.length ? '' : null,
        changedLines.length ? '變更明細：' : null,
        ...changedLines,
        moreChanged > 0 ? `…另有 ${moreChanged} 筆變更未展開` : null,
        errorLines.length ? '' : null,
        errorLines.length ? '錯誤明細：' : null,
        ...errorLines,
        moreErrors > 0 ? `…另有 ${moreErrors} 筆錯誤未展開` : null
    ].filter(line => line !== null).join('\n');

    if (summary.errorCount > 0) {
        setPriceUploadProgress(0, `匯入預覽發現 ${summary.errorCount} 筆錯誤；未寫入任何資料。`, false);
        alert(preview + '\n\n有錯誤的匯入檔不會寫入雲端。請修正 Excel 後重新選擇檔案。');
        return false;
    }

    return confirm(preview + '\n\n確認後才會寫入雲端；未出現在檔案中的產品不會被刪除或停用。確定執行匯入嗎？');
}

// Preserve formatted identifiers without converting numeric prices or costs to display text.
function isProductImportPlaceholderCode(value) {
    const key = String(value || '').normalize('NFKC').trim().toLocaleLowerCase()
        .replace(/\s*\/\s*/g, '/')
        .replace(/\s+/g, ' ');
    return key === 'not available/custom item';
}

function normalizeImportedProductCode(brand, value) {
    const code = String(value ?? '').normalize('NFKC').trim();
    if (!code) return '';
    const canonicalBrand = normalizeBrandLookupKey(resolveBrandName(brand || ''));
    // Roche material numbers are 11 digits. Excel commonly stores a leading-zero code
    // as a number, turning e.g. 03654672103 into 3654672103 before import.
    if (canonicalBrand === normalizeBrandLookupKey('Roche') && /^\d{10}$/.test(code)) return `0${code}`;
    return code;
}

function productImportSheetRows(sheet) {
    const rows = XLSX.utils.sheet_to_json(sheet, { defval:'', raw:true });
    const displayed = XLSX.utils.sheet_to_json(sheet, { defval:'', raw:false });
    const identifierHeaders = new Set(['貨號', '型號', 'catno.', 'catno', 'catalogno.', 'catalogno']);
    return rows.map((row, index) => {
        const result = { ...row };
        Object.keys(row).forEach(header => {
            const key = String(header).normalize('NFKC').replace(/\s+/g, '').toLowerCase();
            if (!identifierHeaders.has(key)) return;
            const raw = row[header];
            const formatted = String(displayed[index]?.[header] ?? '').trim();
            result[header] = typeof raw === 'number'
                ? (/^\d+$/.test(formatted) ? formatted : String(raw))
                : String(raw ?? '').trim();
        });
        return result;
    });
}

window.downloadProductMasterTemplate = async function() {
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }
    const headers = ['廠牌','產品線','貨號','中文品名','英文品名','規格','產品類型','單位','建議售價（含稅）','標準成本（含稅）','啟用','庫存管理','批號管理','效期管理'];
    const example = ['Beckman Coulter','Centrifuge','EXAMPLE-001','範例中文品名','Example Product','96 tests','Consumable','EA','1000','600','是','是','否','否'];
    const ws = XLSX.utils.aoa_to_sheet([headers, example]);
    ws.C2.z = '@';
    ws['!cols'] = [22,20,18,28,32,24,14,10,16,16,10,12,12,12].map(wch => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '產品資料');
    XLSX.writeFile(wb, '又鑫_Product_Import.xlsx');
};
window.downloadProductPriceUpdateTemplate = async function() {
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }
    const ws = XLSX.utils.aoa_to_sheet([
        ['貨號','建議售價（含稅）'],
        ['EXAMPLE-001','1200']
    ]);
    ws.A2.z = '@';
    ws['!cols'] = [{ wch:20 }, { wch:18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '價格更新');
    XLSX.writeFile(wb, '廠牌名稱-價格更新.xlsx');
};

window.downloadProductCostUpdateTemplate = async function() {
    if (!canManagePendingProductMaster()) return;
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }
    const ws = XLSX.utils.aoa_to_sheet([
        ['貨號','標準成本（含稅）'],
        ['EXAMPLE-001','600']
    ]);
    ws.A2.z = '@';
    ws['!cols'] = [{ wch:20 }, { wch:18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '成本更新');
    XLSX.writeFile(wb, '廠牌名稱-成本更新.xlsx');
};

window.handleProductPriceExcelUpload = async function(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!(currentUserRole === 'admin' || currentUserRole === 'purchaser')) {
        alert('只有管理員或採購可以批次更新建議售價。');
        input.value = '';
        return;
    }
    if (productBatchMaintenanceInProgress) {
        input.value = '';
        return;
    }
    setProductBatchMaintenanceBusy(true);
    try {
        await ensureXlsxLoaded();
        setPriceUploadProgress(5, '讀取建議售價更新檔…');
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(buffer), { type:'array' });
        const brand = String(file.name || '')
            .replace(/-價格更新.(xlsx|xls)$/i, '')
            .replace(/.(xlsx|xls)$/i, '')
            .normalize('NFKC').trim();
        if (!brand) throw new Error('請將檔名設為「廠牌名稱-價格更新.xlsx」。');

        const normalizeHeader = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
        const rows = [];
        workbook.SheetNames.forEach(sheetName => {
            productImportSheetRows(workbook.Sheets[sheetName]).forEach(row => {
                const entries = Object.entries(row);
                const find = names => {
                    const wanted = new Set(names.map(normalizeHeader));
                    const pair = entries.find(([key]) => wanted.has(normalizeHeader(key)));
                    return pair ? pair[1] : '';
                };
                const code = String(find(['貨號','型號','Cat No.','Catalog No.'])).trim();
                const rawPrice = find(['建議售價（含稅）','建議售價','含稅單價','單價','價格']);
                if (!code && String(rawPrice).trim() === '') return;
                const price = Number(String(rawPrice).replace(/,/g,'').trim());
                if (!code || !Number.isFinite(price) || price < 0) {
                    throw new Error(`價格更新檔有無效資料：貨號「${code || '空白'}」、價格「${rawPrice}」。`);
                }
                rows.push({ code, price });
            });
        });
        if (!rows.length) throw new Error('檔案中沒有可更新的貨號與建議售價。');

        const deduped = [...new Map(rows.map(row => [normalizeItemCodeLoose(row.code), row])).values()];
        setPriceUploadProgress(25, `核對 ${deduped.length} 個貨號…`);
        const resolved = [];
        const missing = [];
        for (let i = 0; i < deduped.length; i += 10) {
            const chunk = deduped.slice(i, i + 10);
            const codes = chunk.map(row => normalizeItemCodeLoose(row.code));
            const snap = await firestoreReadWithTimeout(
                db.collection('products').where('normalizedPartNo', 'in', codes).get(),
                '批次建議售價貨號核對'
            );
            const docs = snap.docs.map(doc => ({ id:doc.id, ...doc.data() }));
            chunk.forEach(row => {
                const normalizedCode = normalizeItemCodeLoose(row.code);
                const matches = docs.filter(doc =>
                    normalizeItemCodeLoose(doc.manufacturerPartNo || doc.sku || '') === normalizedCode &&
                    normalizeBrandLookupKey(doc.brandName || doc.brand || '') === normalizeBrandLookupKey(brand)
                );
                if (matches.length === 1) resolved.push({ product:matches[0], price:row.price });
                else missing.push(row.code);
            });
        }
        if (missing.length) {
            throw new Error(`有 ${missing.length} 個貨號找不到「${brand}」唯一產品主檔：${missing.slice(0,10).join('、')}${missing.length > 10 ? '…' : ''}。未寫入任何資料。`);
        }

        const changed = resolved.filter(({product, price}) => Number(product.listPrice || 0) !== price);
        if (!changed.length) {
            setPriceUploadProgress(100, '檔案中的建議售價都已是最新值。');
            input.value = '';
            return;
        }
        if (!confirm(`建議售價增量更新\n\n廠牌：${brand}\n檔案共 ${deduped.length} 筆\n實際需要更新 ${changed.length} 筆\n\n只會修改這些產品的 listPrice，不會動品名、規格、分類或其他產品。確定更新嗎？`)) {
            setPriceUploadProgress(0, '已取消，未修改資料。', false);
            input.value = '';
            return;
        }

        const now = new Date().toISOString();
        const operations = changed.map(({product, price}) => batch => {
            batch.set(db.collection('products').doc(product.id || product.productId), {
                listPrice:price,
                updatedAt:now,
                updatedBy:currentUser?.uid || ''
            }, { merge:true });
        });
        setPriceUploadProgress(60, `更新 ${changed.length} 筆建議售價…`);
        await commitMigrationBatch(operations);

        changed.forEach(({product, price}) => {
            const id = product.id || product.productId;
            const cached = priceList.find(item => (item.productId || '') === id);
            if (cached) cached.price = price;
            const result = productManagementResults.find(item => (item.productId || item.id) === id);
            if (result) result.listPrice = price;
        });
        rebuildPriceItemLookup();
        if (productManagementResults.length) renderProductManagementResults();
        setPriceUploadProgress(100, `完成：已更新 ${changed.length} 筆建議售價；其他產品主檔未變更。`);
        input.value = '';
    } catch (err) {
        console.error('建議售價增量更新失敗：', err);
        const message = productOperationErrorMessage('建議售價更新（' + file.name + '）', err)
            + (err.totalOperations ? ` 已確認完成 ${err.committedOperations}／${err.totalOperations} 筆；其餘結果待確認。請重新匯入同一檔案，系統會核對後更新。` : '');
        setPriceUploadProgress(0, message);
        alert(message);
        input.value = '';
    } finally {
        setProductBatchMaintenanceBusy(false);
    }
};


window.handleProductCostExcelUpload = async function(input) {
    const file = input?.files?.[0];
    if (!file) return;
    if (!canManagePendingProductMaster()) {
        alert('只有管理員或採購可以批次更新產品成本。');
        input.value = '';
        return;
    }
    if (productBatchMaintenanceInProgress) {
        input.value = '';
        return;
    }
    setProductBatchMaintenanceBusy(true);
    try {
        await ensureXlsxLoaded();
        setPriceUploadProgress(5, '讀取成本更新檔…');
        const buffer = await file.arrayBuffer();
        const workbook = XLSX.read(new Uint8Array(buffer), { type:'array' });
        const brand = String(file.name || '')
            .replace(/-成本更新\.(xlsx|xls)$/i, '')
            .replace(/\.(xlsx|xls)$/i, '')
            .normalize('NFKC').trim();
        if (!brand) throw new Error('請將檔名設為「廠牌名稱-成本更新.xlsx」。');

        const normalizeHeader = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
        const rows = [];
        workbook.SheetNames.forEach(sheetName => {
            productImportSheetRows(workbook.Sheets[sheetName]).forEach(row => {
                const entries = Object.entries(row);
                const find = names => {
                    const wanted = new Set(names.map(normalizeHeader));
                    const pair = entries.find(([key]) => wanted.has(normalizeHeader(key)));
                    return pair ? pair[1] : '';
                };
                const code = String(find(['貨號','型號','Cat No.','Catalog No.'])).trim();
                const rawCost = find(['標準成本（含稅）','標準成本','含稅成本','成本','進貨成本']);
                if (!code && String(rawCost).trim() === '') return;
                const cost = Number(String(rawCost).replace(/,/g,'').trim());
                if (!code || !Number.isFinite(cost) || cost < 0) {
                    throw new Error(`成本更新檔有無效資料：貨號「${code || '空白'}」、成本「${rawCost}」。`);
                }
                rows.push({ code, cost });
            });
        });
        if (!rows.length) throw new Error('檔案中沒有可更新的貨號與標準成本。');

        const deduped = [...new Map(rows.map(row => [normalizeItemCodeLoose(row.code), row])).values()];
        setPriceUploadProgress(25, `核對 ${deduped.length} 個貨號…`);
        const resolved = [];
        const missing = [];
        for (let i = 0; i < deduped.length; i += 10) {
            const chunk = deduped.slice(i, i + 10);
            const codes = chunk.map(row => normalizeItemCodeLoose(row.code));
            const snap = await firestoreReadWithTimeout(
                db.collection('products').where('normalizedPartNo', 'in', codes).get(),
                '批次產品成本貨號核對'
            );
            const docs = snap.docs.map(doc => ({ id:doc.id, ...doc.data() }));
            chunk.forEach(row => {
                const normalizedCode = normalizeItemCodeLoose(row.code);
                const matches = docs.filter(doc =>
                    normalizeItemCodeLoose(doc.manufacturerPartNo || doc.sku || '') === normalizedCode &&
                    normalizeBrandLookupKey(doc.brandName || doc.brand || '') === normalizeBrandLookupKey(brand)
                );
                if (matches.length === 1) resolved.push({ product:matches[0], cost:row.cost });
                else missing.push(row.code);
            });
        }
        if (missing.length) {
            throw new Error(`有 ${missing.length} 個貨號找不到「${brand}」唯一產品主檔：${missing.slice(0,10).join('、')}${missing.length > 10 ? '…' : ''}。未寫入任何成本資料。`);
        }

        const existingCosts = new Map();
        for (let i = 0; i < resolved.length; i += 10) {
            const ids = resolved.slice(i, i + 10).map(({product}) => product.id || product.productId);
            const snap = await firestoreReadWithTimeout(
                db.collection('productCosts')
                    .where(firebase.firestore.FieldPath.documentId(), 'in', ids)
                    .get(),
                '既有產品成本核對'
            );
            snap.docs.forEach(doc => existingCosts.set(doc.id, doc.data() || {}));
        }
        const changed = resolved.filter(({product, cost}) => {
            const id = product.id || product.productId;
            return Number(existingCosts.get(id)?.standardCost ?? NaN) !== cost;
        });
        if (!changed.length) {
            setPriceUploadProgress(100, '檔案中的標準成本都已是最新值。');
            input.value = '';
            return;
        }
        if (!confirm(`產品成本增量更新\n\n廠牌：${brand}\n檔案共 ${deduped.length} 筆\n實際需要更新 ${changed.length} 筆\n\n只會修改 productCosts 的 standardCost，不會修改產品主檔、建議售價或歷史訂單。確定更新嗎？`)) {
            setPriceUploadProgress(0, '已取消，未修改成本資料。', false);
            input.value = '';
            return;
        }

        const now = new Date().toISOString();
        const operations = changed.map(({product, cost}) => batch => {
            const productId = product.id || product.productId;
            batch.set(db.collection('productCosts').doc(productId), {
                productId,
                productLineId: product.productLineId || product.productLine || '',
                standardCost: cost,
                salesVisible: false,
                source: 'COST_UPDATE',
                updatedAt: now,
                updatedBy: currentUser?.uid || ''
            }, { merge:true });
        });
        setPriceUploadProgress(60, `更新 ${changed.length} 筆標準成本…`);
        await commitMigrationBatch(operations);
        visibleProductCostCache.clear();
        setPriceUploadProgress(100, `完成：已更新 ${changed.length} 筆標準成本；產品主檔與建議售價未變更。`);
        input.value = '';
    } catch (err) {
        console.error('產品成本增量更新失敗：', err);
        const message = productOperationErrorMessage('產品成本更新（' + file.name + '）', err)
            + (err.totalOperations ? ` 已確認完成 ${err.committedOperations}／${err.totalOperations} 筆；其餘結果待確認。請重新匯入同一檔案，系統會核對後更新。` : '');
        setPriceUploadProgress(0, message);
        alert(message);
        input.value = '';
    } finally {
        setProductBatchMaintenanceBusy(false);
    }
};

window.handlePriceExcelUpload = async function(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const requestedBrand = pendingPriceListUploadBrand;
    pendingPriceListUploadBrand = '';
    if (brandProductDeleteRunning) {
        alert('正在處理價目表，請完成後再匯入。');
        input.value = '';
        return;
    }
    if (!(currentUserRole === 'admin' || currentUserRole === 'purchaser')) {
        alert('只有管理員或採購可以匯入產品主檔。');
        input.value = '';
        return;
    }

    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        input.value = '';
        return;
    }
    if (productMasterMigrationRunning) {
        input.value = '';
        return;
    }
    productMasterMigrationRunning = true;
    setProductBatchMaintenanceBusy(true);

    setPriceUploadProgress(0, '準備讀取產品匯入…');
    const reader = new FileReader();
    reader.onprogress = function(event) {
        if (!event.lengthComputable) return;
        // 檔案讀取階段使用 0～50%，保留後半段顯示資料整理與同一廠牌多產品線的雲端儲存進度。
        setPriceUploadProgress((event.loaded / event.total) * 50, '讀取 Excel 檔案中…');
    };
    reader.onload = async function(e) {
        try {
            setPriceUploadProgress(55, '正在整理產品、售價與標準成本…');
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });

            const normalizePriceHeader = value => String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase();
            const getField = (row, keys) => {
                for (const k of keys) {
                    if (row[k] !== undefined && row[k] !== '') return row[k];
                }
                const wanted = new Set(keys.map(normalizePriceHeader));
                const matchedKey = Object.keys(row).find(key => wanted.has(normalizePriceHeader(key)));
                if (matchedKey !== undefined && row[matchedKey] !== '') return row[matchedKey];
                return '';
            };

            // 全形英數字／空白轉半形，避免輸入法不小心切到全形模式時，
            // 「Ｂiorad」和「Biorad」被系統誤判成兩個不同的廠牌。
            const toHalfWidth = (str) => String(str || '')
                .replace(/[\uFF01-\uFF5E]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
                .replace(/\u3000/g, ' ')
                .trim();

            // 標準格式以欄位為主。廠牌空白仍可由檔名補；產品線為選填，
            // 不從分頁名稱自動推導，避免沒有產品線的廠牌被誤分類。
            const fallbackBrand = toHalfWidth(String(file.name || '').replace(/\.(xlsx|xls)$/i, '').replace(/^(Product Master|Product Import|又鑫_Product_Import)$/i, ''));
            const brandGroupsMap = new Map();
            const seenProductIds = new Set();
            const importErrors = [];
            let skippedPlaceholderRows = 0;
            workbook.SheetNames.forEach(sheetName => {
                const sheet = workbook.Sheets[sheetName];
                const rows = productImportSheetRows(sheet);

                rows.forEach(row => {
                    const nameCn = String(getField(row, ['中文品名', '品名', '中文名稱'])).trim();
                    const nameEn = String(getField(row, ['英文品名', '英文名稱'])).trim();
                    const rawModel = String(getField(row, ['貨號', '型號'])).trim();
                    if (!rawModel) return;
                    if (isProductImportPlaceholderCode(rawModel)) {
                        skippedPlaceholderRows += 1;
                        return;
                    }

                    const rawBrand = toHalfWidth(getField(row, ['廠牌', '品牌', 'Brand']) || fallbackBrand);
                    const brand = resolveBrandName(rawBrand);
                    if (!brand) { importErrors.push(`貨號「${rawModel}」缺少廠牌。請填寫「廠牌」欄位。`); return; }
                    const model = normalizeImportedProductCode(brand, rawModel);
                    const productLine = toHalfWidth(getField(row, ['產品線', 'Product Line', 'ProductLine']));

                    const productType = normalizeProductTypeValue(getField(row, ['類型', '產品類型', '品項類型', '機器/耗材', '仪器/耗材', 'Type']));
                    const spec = String(getField(row, ['規格', '规格', 'Spec', 'Specification'])).trim();
                    const unit = String(getField(row, ['單位', 'Unit', 'UOM'])).trim();
                    const activeRaw = String(getField(row, ['啟用', '启用', 'Active', 'Status'])).trim().toLocaleLowerCase();
                    const yes = value => ['1', 'true', 'yes', 'y', '是', '啟用', '启用'].includes(String(value || '').trim().toLocaleLowerCase());
                    const inventoryTracked = yes(getField(row, ['庫存管理', '库存管理', 'Inventory Tracked', 'Inventory']));
                    const lotTracked = yes(getField(row, ['批號管理', '批号管理', 'Lot Tracked', 'Lot']));
                    const expiryTracked = yes(getField(row, ['效期管理', 'Expiry Tracked', 'Expiry']));

                    const priceRaw = getField(row, ['建議售價（含稅）', '建議售價', '含稅單價', '單價', '價格']);
                    const listPriceProvided = String(priceRaw ?? '').trim() !== '';
                    const price = listPriceProvided ? Number(String(priceRaw).replace(/,/g, '').trim()) : null;
                    if (listPriceProvided && (!Number.isFinite(price) || price < 0)) { importErrors.push(`貨號「${model}」的建議售價格式不正確。`); return; }

                    const standardCostRaw = getField(row, ['標準成本（含稅）', '標準成本', '含稅成本', '成本', '進貨成本']);
                    const standardCostProvided = String(standardCostRaw ?? '').trim() !== '';
                    const standardCost = standardCostProvided ? Number(String(standardCostRaw).replace(/,/g, '').trim()) : null;
                    if (standardCostProvided && (!Number.isFinite(standardCost) || standardCost < 0)) { importErrors.push(`貨號「${model}」的標準成本格式不正確。`); return; }

                    const importedItem = {
                        nameCn, nameEn, model, brand, productType, productLine, spec, unit,
                        inventoryTracked, lotTracked, expiryTracked,
                        active: activeRaw ? !['0','false','no','n','否','停用'].includes(activeRaw) : true,
                        price, listPriceProvided, standardCost, standardCostProvided, source:'PRODUCT_IMPORT'
                    };
                    const importProductId = stableProductId(importedItem);
                    if (seenProductIds.has(importProductId)) { importErrors.push(`貨號「${model}」在檔案中重複出現。每個廠牌／貨號請只保留一列。`); return; }
                    seenProductIds.add(importProductId);
                    const groupKey = `${normalizeBrandLookupKey(brand)}::${productLine.toLocaleLowerCase()}`;
                    if (!brandGroupsMap.has(groupKey)) brandGroupsMap.set(groupKey, { brand, productLine, imported:[] });
                    brandGroupsMap.get(groupKey).imported.push(importedItem);
                });
            });
            const brandGroups = [...brandGroupsMap.values()];

            if (requestedBrand) {
                const requestedKey = normalizeBrandLookupKey(resolveBrandName(requestedBrand));
                const unexpected = brandGroups.filter(group => normalizeBrandLookupKey(resolveBrandName(group.brand)) !== requestedKey);
                if (unexpected.length) {
                    setPriceUploadProgress(0, `檔案廠牌與「${requestedBrand}」不一致，尚未寫入雲端。`, false);
                    alert(`你是從「${requestedBrand}」點選上傳新版，但檔案內包含其他廠牌：${[...new Set(unexpected.map(group => group.brand))].join('、')}。\n\n請確認檔案後重新上傳。`);
                    input.value = '';
                    return;
                }
            }

            if (!brandGroups.length && !importErrors.length) {
                setPriceUploadProgress(0, '找不到可上傳的產品資料。');
                alert('無法從 Excel 辨識出有效資料。請確認每筆產品至少有廠牌與貨號。');
                input.value = '';
                return;
            }

            if (!await confirmProductMasterImport(brandGroups, importErrors)) {
                setPriceUploadProgress(0, '已取消，尚未寫入雲端。', false);
                input.value = '';
                return;
            }

            activeProductImportBatch = { id:`import-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, file:file.name, date:new Date().toISOString() };
            const savedBrands = [];
            const imported = brandGroups.flatMap(group => group.imported);
            const itemsByBrand = new Map();
            imported.forEach(item => {
                const key = normalizeBrandLookupKey(item.brand);
                if (!itemsByBrand.has(key)) itemsByBrand.set(key, { brand:item.brand, items:[] });
                itemsByBrand.get(key).items.push(item);
            });

            let savedCount = 0;
            let totalProductWrites = 0;
            let totalCostWrites = 0;
            let totalUnchangedRows = 0;
            const priceListMetadataWarnings = [];
            for (const { brand, items } of itemsByBrand.values()) {
                setPriceUploadProgress(70 + (savedCount / Math.max(1, itemsByBrand.size)) * 20, `正在儲存「${brand}」的 ${items.length} 筆產品／售價／成本…`);
                const saveResult = await saveProductMasterBrand(items, brand);
                const storedBrand = saveResult.brand;
                try {
                    await markPriceListImportComplete(storedBrand, items.length, saveResult);
                } catch (metadataErr) {
                    console.warn('價目表版本紀錄寫入失敗：', storedBrand, metadataErr);
                    priceListMetadataWarnings.push(`${storedBrand}：${metadataErr?.message || metadataErr}`);
                }
                totalProductWrites += saveResult.productWrites;
                totalCostWrites += saveResult.costWrites;
                totalUnchangedRows += saveResult.unchangedRows;
                const normalizedImported = saveResult.items || normalizeProductMasterList(items.map(item => ({ ...item, brand: storedBrand })));
                const visibleImported = normalizedImported.map(productItemWithoutCost);

                // 以 productId 增量合併本機快取。只上傳幾筆時，不可把同廠牌其他產品從目前畫面暫時移除。
                // 建議售價留白時，雲端與本機快取都保留既有售價，避免畫面暫時變成 0／空白。
                const merged = new Map(priceList.map(item => [item.productId || stableProductId(item), item]));
                visibleImported.forEach(item => {
                    const id = item.productId || stableProductId(item);
                    const previous = merged.get(id);
                    if (item.listPriceProvided !== true && previous) {
                        merged.set(id, { ...previous, ...item, price:previous.price });
                    } else {
                        merged.set(id, item);
                    }
                });
                priceList = [...merged.values()];

                const lineCount = new Set(items.map(item => item.productLine || '')).size;
                savedBrands.push(`${storedBrand}（${items.length} 筆／${lineCount} 個產品線；產品寫入 ${saveResult.productWrites}、成本寫入 ${saveResult.costWrites}）`);
                savedCount += 1;
            }

            if (totalCostWrites) {
                invalidateVisibleProductCosts();
                purchaseCostCache.clear();
            }
            refreshPriceDatalists();
            renderCompanyAgencyBrandSettings();
            loadProductManagementOverview();
            const skippedText = skippedPlaceholderRows ? `；略過無正式貨號 ${skippedPlaceholderRows} 筆` : '';
            setPriceUploadProgress(100, `完成：檢查 ${imported.length} 筆；產品寫入 ${totalProductWrites}、標準成本寫入 ${totalCostWrites}、完全無變動 ${totalUnchangedRows} 筆${skippedText}。`);
            alert(`產品匯入完成：\n${savedBrands.join('\n')}\n\n已記錄本次匯入批次；未出現在檔案中的產品不會被刪除或停用。標準成本與實際採購價分開保存。${skippedPlaceholderRows ? `\n已略過「Not Available/Custom Item」等無正式貨號列：${skippedPlaceholderRows} 筆。` : ''}${priceListMetadataWarnings.length ? `\n\n注意：產品資料已匯入，但以下價目表版本紀錄失敗：\n${priceListMetadataWarnings.join('\n')}` : ''}`);
        } catch (err) {
            setPriceUploadProgress(0, '儲存雲端失敗，請稍後再試。');
            alert('上傳失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
        } finally {
            activeProductImportBatch = null;
            productMasterMigrationRunning = false;
            setProductBatchMaintenanceBusy(false);
            input.value = '';
        }
    };
    reader.onerror = function() {
        productMasterMigrationRunning = false;
        setProductBatchMaintenanceBusy(false);
        setPriceUploadProgress(0, '讀取 Excel 檔案失敗。');
        alert('讀取 Excel 檔案失敗，請重新選擇檔案。');
        input.value = '';
    };
    reader.readAsArrayBuffer(file);
};


// ===== 2026-10-02：手機功能選單自動收合 =====
window.collapseMobileMainNav = function() {
    const nav = document.querySelector('.nav-tabs');
    if (!nav?.classList.contains('mobile-open')) return;
    nav.classList.remove('mobile-open');
    const toggle = nav.querySelector('.mobile-nav-toggle');
    toggle?.setAttribute('aria-expanded', 'false');
    toggle?.setAttribute('aria-label', '開啟功能選單');
};

(function bindMobileMainNavAutoCollapse() {
    const nav = document.querySelector('.nav-tabs');
    const app = document.getElementById('appContainer');
    if (!nav || !app) return;

    document.addEventListener('pointerdown', event => {
        if (!nav.classList.contains('mobile-open')) return;
        if (nav.contains(event.target)) return;
        collapseMobileMainNav();
    }, { passive:true });

    app.addEventListener('scroll', () => {
        if (nav.classList.contains('mobile-open')) collapseMobileMainNav();
    }, { passive:true });
})();

window.configureDocumentDownloadFolder = async function(kind) {
    try { await window.DocumentDownloads.choose(kind); }
    catch (err) { if(err.name !== 'AbortError') alert('設定下載資料夾失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。'); }
};
window.resetDocumentDownloadFolder = async function(kind) {
    try { await window.DocumentDownloads.reset(kind); }
    catch (err) { alert('重設下載資料夾失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。'); }
};

