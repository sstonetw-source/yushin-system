// Preview-only bridge to the authenticated Cloud Function. The normal
// per-item Service remains unchanged until complete Preview acceptance.
// This bridge uses the same Reservation Core for initial quantity proposals;
// the server must independently reread and validate ALL authoritative data.
let groupedReservationFunctionsScriptPromise = null;
function groupedReservationPreviewEnabled() {
    return APP_ENVIRONMENT === 'preview'
        && globalThis.YUSHIN_PREVIEW_GROUPED_RESERVATION === true;
}
function sameWarehouseReservationPreviewEnabled() {
    return groupedReservationPreviewEnabled()
        && globalThis.YUSHIN_PREVIEW_SAME_WAREHOUSE_RESERVATION === true;
}
function orderReservationBackendPreviewEnabled() {
    return APP_ENVIRONMENT === 'preview'
        && globalThis.YUSHIN_PREVIEW_ORDER_RESERVATION_BACKEND === true;
}
// Production remains independently default-closed. The server checks the
// project and a separate production gate before accepting any transaction.
function orderReservationBackendEnabled() {
    return orderReservationBackendPreviewEnabled()
        || (APP_ENVIRONMENT === 'production'
            && globalThis.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND === true
            && globalThis.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED === true
            && typeof firebase !== 'undefined'
            && firebase.app().options?.projectId === 'yu-shing-company');
}
function productionReservationLegacyWriterBlocked() {
    return APP_ENVIRONMENT === 'production'
        && globalThis.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED === true;
}
function initialGroupedReservationCandidates(order) {
    if (!groupedReservationPreviewEnabled()
        || order?.inventoryReservationStatus !== 'pending'
        || !/^[a-zA-Z0-9_-]{12,80}$/.test(String(order.inventoryReservationAttemptId||''))
        || normalizedOrderStatus(order) !== 'normal'
        || !Array.isArray(order.items)) return [];
    const groups = new Map();
    for (const [index, item] of order.items.entries()) {
        if (!item || (item.fulfillmentType||'WAREHOUSE') !== 'WAREHOUSE'
            || String(item.productType||'').toUpperCase() === 'SERVICE'
            || !item.warehouseId || String(item.warehouseId).startsWith('custody-')) continue;
        const untouched = ['reservedQty','deliveredQty','returnedQty','supplyOrderedQty',
            'receivedQty','dispatchPreparedQty','warehouseShippedQty'].every(key=>Number(item[key]||0)===0);
        const requested = Number(item.qty??item.orderedQty);
        if (!untouched || item.transferPendingId || item.custodyTransferId
            || !Number.isSafeInteger(requested) || requested<=0 || requested>1000000) continue;
        const productKey=inventoryProductKey(item);
        if (!productKey || !item.productId) continue;
        const itemId=String(item.itemId||`item-${index+1}`);
        if (!groups.has(productKey)) groups.set(productKey,[]);
        groups.get(productKey).push({itemId,warehouseId:item.warehouseId,requested});
    }
    return [...groups].filter(([,rows])=>rows.length>=2&&rows.length<=5
        && new Set(rows.map(row=>row.itemId)).size===rows.length
        && (new Set(rows.map(row=>row.warehouseId)).size===2
            || (sameWarehouseReservationPreviewEnabled()
                && new Set(rows.map(row=>row.warehouseId)).size===1)))
        .map(([productKey,rows])=>({productKey,rows}));
}
async function ensureReservationFunctionsCompat() {
    if (!firebase.functions) {
        if (!groupedReservationFunctionsScriptPromise) {
            groupedReservationFunctionsScriptPromise=new Promise((resolve,reject)=>{
                const script=document.createElement('script');
                script.src='https://www.gstatic.com/firebasejs/10.8.0/firebase-functions-compat.js';
                script.onload=resolve;
                script.onerror=()=>reject(new Error('無法載入 Firebase Functions，跨倉同步未提交。'));
                document.head.appendChild(script);
            }).catch(error=>{groupedReservationFunctionsScriptPromise=null;throw error;});
        }
        await groupedReservationFunctionsScriptPromise;
    }
    if (!firebase.functions) throw new Error('Firebase Functions 尚未初始化，後端預留未提交。');
}
async function groupedReservationPreviewCallable() {
    await ensureReservationFunctionsCompat();
    return firebase.app().functions('asia-east1').httpsCallable('commitGroupedWarehouseReservation');
}
async function commitNewOrderReservationPreview(orderId,liveOrder,actorUid) {
    if (!orderReservationBackendEnabled()) return false;
    if (!actorUid || currentUser?.uid!==actorUid)
        throw new Error('登入身分已變更，停止後端庫存同步。');
    const syncAttemptId=String(liveOrder.inventoryReservationAttemptId||'');
    if (liveOrder.inventoryReservationStatus!=='pending'
        || !/^[a-zA-Z0-9_-]{12,96}$/.test(syncAttemptId))
        throw new Error('訂單同步識別碼已變更，請重新讀取。');
    // Reuse the Functions compat SDK loader; never run a client-side stock
    // transaction after a failed or ambiguous backend result.
    await ensureReservationFunctionsCompat();
    if (!orderReservationBackendEnabled() || currentUser?.uid!==actorUid)
        throw new Error('登入身分或測試環境已變更，停止後端庫存同步。');
    const callable=firebase.app().functions('asia-east1').httpsCallable('commitOrderReservationPreview');
    const reply=await callable({orderId,syncAttemptId});
    if (!orderReservationBackendEnabled())
        throw new Error('預留後端旗標已關閉，請保留原同步識別碼核對交易結果。');
    if (!['applied','already-applied'].includes(reply?.data?.status))
        throw new Error('後端預留回覆不明確，請重新讀取訂單後以原識別碼重試。');
    if (currentUser?.uid!==actorUid)
        throw new Error('後端預留可能已提交，但登入身分已變更，請重新讀取結果。');
    invalidateProcurementDemandQueue();
    return true;
}
async function commitInitialGroupedReservationPreview(orderId,liveOrder,actorUid) {
    const groups=initialGroupedReservationCandidates(liveOrder);
    if (!groups.length) return false;
    if (!actorUid || currentUser?.uid!==actorUid)
        throw new Error('登入身分已變更，停止跨倉庫存同步。');
    if (!globalThis.YushinReservation?.planReservation || !globalThis.YushinInventory?.normalizeStock)
        throw new Error('預留或庫存核心尚未載入。');
    const operationAttempt=liveOrder.inventoryReservationAttemptId;
    let committed=false,crossIndex=0,sameIndex=0;
    for (const group of groups) {
        const {productKey,rows}=group;
        const warehouses=[...new Set(rows.map(row=>row.warehouseId))].sort();
        const sameWarehouse=warehouses.length===1;
        // Preserve legacy two-warehouse attempt IDs even if a same-warehouse
        // group appears earlier in the order. Replays must never swap intents.
        const groupIndex=sameWarehouse?sameIndex++:crossIndex++;
        const companyRef=db.collection('inventory').doc(encodeURIComponent(productKey));
        const warehouseRefs=warehouses.map(wh=>db.collection('warehouseStocks').doc(warehouseStockDocId(wh,productKey)));
        const snaps=await Promise.all([companyRef,...warehouseRefs].map(ref=>
            firestoreReadWithTimeout(ref.get(),'讀取雙倉庫存')));
        if (!snaps[0].exists || warehouseRefs.some((_,i)=>!snaps[i+1].exists))
            throw new Error('雙倉預留缺少公司或實體分倉庫存，請先核對庫存。');
        const balance = data=>{
            const stock=globalThis.YushinInventory.normalizeStock(data);
            for (const field of ['onHand','reserved','transferFreeInTransit']) {
                const value=Number(data[field]||0);
                if (!Number.isSafeInteger(value)||value<0)
                    throw new Error('雙倉庫存來源數量不正確，停止自動預留。');
            }
            if (Number(data.reserved||0)+Number(data.transferFreeInTransit||0)>Number(data.onHand||0))
                throw new Error('雙倉庫存來源預留及途中帳目超過實貨。');
            return stock.available;
        };
        let companyAvailable=balance(snaps[0].data());
        const byWarehouse=new Map(warehouses.map((wh,i)=>[wh,balance(snaps[i+1].data())]));
        const items=[];
        for(const row of rows) {
            const plan=globalThis.YushinReservation.planReservation({
                requestedQty:row.requested,existingQty:0,sameStock:true,
                availableQty:Math.min(companyAvailable,byWarehouse.get(row.warehouseId)),
                inTransitQty:0
            });
            if (!Number.isSafeInteger(plan.reservedQty))
                throw new Error('雙倉預留計算結果不是整數。');
            companyAvailable-=plan.reservedQty;
            byWarehouse.set(row.warehouseId,byWarehouse.get(row.warehouseId)-plan.reservedQty);
            items.push({itemId:row.itemId,quantity:plan.reservedQty});
        }
        // No stock to hold; use the existing item-level Service to publish
        // the shortage and procurement demand without adding server writes.
        if (!items.some(row=>row.quantity>0)) continue;
        if (currentUser?.uid!==actorUid || !groupedReservationPreviewEnabled()
            || (sameWarehouse&&!sameWarehouseReservationPreviewEnabled()))
            throw new Error('登入身分或測試環境已變更，停止跨倉庫存同步。');
        const callable=await groupedReservationPreviewCallable();
        // Derive a stable per-product-group ID from the persisted order sync
        // attempt. Never create a new ID on network retry.
        const attemptId=operationAttempt+(sameWarehouse?'_same_':'_group_')+groupIndex;
        const reply=await callable({orderId,attemptId,syncAttemptId:operationAttempt,items});
        if (!['applied','already-applied'].includes(reply?.data?.status))
            throw new Error('雙倉交易回覆不明確；請重新讀取訂單後使用相同識別碼重試。');
        committed=true;
        if (currentUser?.uid!==actorUid)
            throw new Error('跨倉交易可能已提交，但登入身分已變更；請重新讀取結果。');
        for (const warehouseId of warehouses)
            invalidateWarehouseStockCache(productKey,warehouseId);
    }
    if(committed)invalidateProcurementDemandQueue();
    return committed;
}
