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

// One projection for both the delivery card and lifecycle status. CLOSED
// returns do not require replacement stock; never deduct them twice.
function orderDeliveryProjection(order, normalizedItems = null) {
    if (!globalThis.YushinFulfillment?.projectOrderDelivery)
        throw new Error('Fulfillment core 未載入，無法計算有效交付數量。');
    return globalThis.YushinFulfillment.projectOrderDelivery({
        grossDeliveredQty: deliveredQuantity(order, normalizedItems),
        returnedQty: returnedQuantity(order),
        returnRecords: savedReturnRecords(order)
    });
}

function deliveryProgressInfo(order, normalizedItems = null) {
    const total = orderQuantity(order, normalizedItems);
    const {grossDelivered,returned,effectiveDelivered} = orderDeliveryProjection(order, normalizedItems);
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
    const {grossDelivered:delivered,returned,effectiveDelivered} = orderDeliveryProjection(order, normalizedItems);
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
            productType:item.productType||order.productType||'',
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
    const allItems=normalizedItems || normalizedOrderItems(order);
    const items=allItems.filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'
        &&String(item.productType||'').trim().toUpperCase()!=='SERVICE');
    const total=items.reduce((s,item)=>s+Number(item.orderedQty||item.qty||0),0);
    const states=items.map(item=>{const state=dispatchStateByItem?.get(item) || itemDispatchState(order,item);return globalThis.YushinWarehouseLogistics?.businessDeliveryState?globalThis.YushinWarehouseLogistics.businessDeliveryState(order,item,state,defaultWarehouse()?.id||''):state;});
    const ready=states.reduce((s,state)=>s+state.reserved,0);
    const prepared=states.reduce((s,state)=>s+state.prepared,0);
    const delivered=states.reduce((s,state)=>s+state.delivered,0);
    const shippable=states.reduce((s,state)=>s+state.shippable,0);
    const pendingDispatch=states.reduce((s,state)=>s+state.pending,0);
    if(!items.length)return allItems.some(item=>String(item.productType||'').trim().toUpperCase()==='SERVICE')
        ? {state:'not_required',label:'無需實貨出貨',total:0,ready:0,prepared:0,delivered:0,shippable:0,pendingDispatch:0}
        : {state:'direct',label:'原廠直送',total:0,ready:0,prepared:0,delivered:0,shippable:0,pendingDispatch:0};
    if(total>0 && delivered>=total)return {state:'complete',label:'出貨完成',total,ready,prepared,delivered,shippable:0,pendingDispatch:0};
    if(shippable>0)return {state:'shippable',label:`可出貨 ${shippable}/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
    if(pendingDispatch>0)return {state:ready>=Math.max(0,total-delivered)?'pending_dispatch':'partial_dispatch',label:`待打單 ${pendingDispatch}/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
    const waiting=states.find(state=>state.deliveryWait);if(waiting&&ready>0)return {state:'pending',label:waiting.deliveryWait,total,ready,prepared,delivered,shippable,pendingDispatch};
    return {state:'pending',label:`待備貨 0/${total}`,total,ready,prepared,delivered,shippable,pendingDispatch};
}

const pendingDispatchOrderIds = new Set();

function itemDispatchState(order, item) {
    if(orderInventorySyncIncomplete(order))return {ordered:Number(item.orderedQty||item.qty||0),reserved:0,prepared:0,delivered:0,grossDelivered:0,returned:0,shippable:0,pending:0};
    if(globalThis.YUSHIN_V2_DISPATCH_EMULATOR===true
        ||(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'&&globalThis.YUSHIN_PREVIEW_DISPATCH===true)){
        // The Emulator bridge consumes physical shipments, not acknowledgements.
        const source=order.items?.find(row=>row.itemId===item.itemId)||item;
        return {...globalThis.YushinFulfillment.warehouseShipmentState(source),
            delivered:source.deliveredQty??0,grossDelivered:source.deliveredQty??0,returned:source.returnedQty??0};
    }
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
    try{
        const retry=lifecycleProtectedMode()?pendingV2OrderLifecycle(order.id):null;
        if(retry)return `<button type="button" onclick="quickSetOrderLifecycle(${id}, ${inlineJsValue(retry.nextStatus)})">確認前次取消／恢復結果</button>`;
    }catch(err){return `<span role="alert">${escapeHtml(err.message)}</span>`;}
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
    let showPartialDelivery=hasPartialArrival || (items.length > 1 && states.some(state => Number(state?.shippable || 0) > 0));
    if(deliveryConfirmationProtectedMode()){
        try{
            // Customer acknowledgement consumes shipped quota. Once all printed
            // goods leave the warehouse, shippable is zero but arrival is pending.
            const frozen=pendingV2DeliveryConfirmation(order.id);
            const projected=globalThis.YushinFulfillment.projectOrderShipmentReturns({orderId:order.id,items:order.items,
                shipments:order.warehouseShipmentRecords||[],deliveries:order.deliveryRecords||[],returns:order.returnRecords||[]});
            showPartialDelivery=!!frozen||(!orderInventorySyncIncomplete(order)
                &&(order.returnRecords||[]).every(row=>row.settlement==='CLOSE')&&projected.pendingDeliveryQty>0);
        }catch(_){showPartialDelivery=false;}
    }
    return {
        showPartialDelivery: normalizedOrderStatus(order) === 'normal'
            && showPartialDelivery,
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
        .filter(x=>x.state.pending>0||pendingDispatchPreparation(order.id,x.item.itemId))
        .map(({item,state})=>`<button type="button" onclick="markOrderItemDispatchPrepared(${inlineJsValue(order.id)},${inlineJsValue(item.itemId)})" ${pendingDispatchOrderIds.has(order.id+'__'+item.itemId)?'disabled':''}>${pendingDispatchPreparation(order.id,item.itemId)?'確認打單結果':'待打單'}：${escapeHtml(item.itemCode||item.itemName||item.itemId)} × ${pendingDispatchPreparation(order.id,item.itemId)?.quantity||state.pending}</button>`)
        .join('');
}

// Frozen UI intents survive refresh and uncertain replies. Both pages use this
// same entry; quantities are proposals from itemDispatchState, never a new formula.
function dispatchPreparationStorageKey(orderId,itemId,uid=currentUser?.uid) {
    return 'yushin-dispatch-attempt:'+JSON.stringify([uid,orderId,itemId]);
}
function pendingDispatchPreparation(orderId,itemId) {
    try{return JSON.parse(sessionStorage.getItem(dispatchPreparationStorageKey(orderId,itemId))||'null');}
    catch(_){return null;}
}
window.markOrderItemDispatchPrepared = async function(orderId,itemId) {
    if (!(currentUserRole === 'purchaser' || currentUserRole === 'admin')) return;
    const actorUid=currentUser?.uid,actorRole=currentUserRole;
    if(!actorUid)return;
    const isCurrent=()=>currentUser?.uid===actorUid&&currentUserRole===actorRole;
    const key=orderId+'__'+itemId;
    if(pendingDispatchOrderIds.has(key))return;
    pendingDispatchOrderIds.add(key);
    try{
        const storageKey=dispatchPreparationStorageKey(orderId,itemId,actorUid);
        const raw=sessionStorage.getItem(storageKey);
        let attempt;
        try{attempt=raw==null?null:JSON.parse(raw);}
        catch(_){throw new Error('原打單操作憑證無法讀取，已停止提交，請保留此分頁並核對原紀錄。');}
        if(raw!=null&&(!attempt||typeof attempt!=='object'||Array.isArray(attempt)))
            throw new Error('原打單操作憑證不完整，已停止提交，請保留此分頁並核對原紀錄。');
        if(!attempt){
            if(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'&&!dispatchBackendPilotEnabled())
                throw new Error('Preview 出貨準備後端尚未啟用，禁止改走舊交易。');
            const order=ordersCache.find(o=>o.id===orderId)||purchasingDispatchCache.find(o=>o.id===orderId);
            const item=order&&normalizedOrderItems(order).find(i=>i.itemId===itemId);
            if(!item)throw new Error('找不到品項，請更新訂單後重試。');
            const state=itemDispatchState(order,item);
            if(state.pending<=0)throw new Error('此品項目前沒有待打單數量。');
            attempt={operationId:'dispatch-ui-'+db.collection('dispatchRecords').doc().id,
                orderId,itemId,actorUid,actorRole,quantity:state.pending,expectedPreparedQty:state.prepared};
            if(dispatchBackendPilotEnabled())attempt.syncAttemptId=order.inventoryReservationAttemptId;
            // If persistence is unavailable, do not submit an unresumable operation.
            sessionStorage.setItem(storageKey,JSON.stringify(attempt));
        }
        if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
        else if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingDispatchOrders();
        let saved;
        try{saved=await prepareOrderDispatch(orderId,itemId,attempt);}
        catch(err){
            // This code is raised only after reading an absent receipt inside the
            // transaction. Unknown network/permission outcomes retain the intent.
            if(err.code==='dispatch-stale'&&isCurrent())sessionStorage.removeItem(storageKey);
            throw err;
        }
        if(!isCurrent())return;
        sessionStorage.removeItem(storageKey);
        const idx=ordersCache.findIndex(o=>o.id===orderId);
        const savedOrder={...saved,id:orderId};
        if(idx>=0)ordersCache[idx]=savedOrder;
        syncOrderIntoPurchasingCaches(savedOrder, { render:false });
        writeAppDataCache('orders', ordersCache);
    }catch(err){if(isCurrent())alert('打單結果待確認：'+err.message+'\n請更新清單後重試；未確認的作業會沿用原識別碼與數量。');}
    finally{
        pendingDispatchOrderIds.delete(key);
        if(isCurrent()){
            if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
            if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
            if(currentDeliveryOrderId===orderId)renderDeliveryModal();
        }
    }
};


async function refreshAffectedOrderCaches(orderIds = []) {
    const ids=[...new Set(orderIds.filter(Boolean))];
    if(!ids.length)return;
    const cacheUid=currentUser?.uid||'',cacheRole=currentUserRole;
    const refreshedOrders=await readDocumentsByIds('orders',ids);
    if(!cacheUid||currentUser?.uid!==cacheUid||currentUserRole!==cacheRole)throw new Error('登入帳號或角色已變更，請重新載入訂單清單。');
    refreshedOrders.forEach(order=>{
        const index=ordersCache.findIndex(row=>row.id===order.id);
        if(index>=0)ordersCache[index]=order;else ordersCache.unshift(order);
        syncOrderIntoPurchasingCaches(order, { render:false });
    });
    ordersCache.sort((a,b)=>(b.orderDate||'').localeCompare(a.orderDate||''));
    writeAppDataCache('orders',ordersCache);
    if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
}

function canBusinessSelfOrder(order = null) {
    if (currentUserRole === 'admin') return true;
    if (!canSelfOrderCapability(currentUserRole)) return false;
    if (!order) return true;
    return (order.ownerUid && order.ownerUid === currentUser?.uid)
        || (order.salesCode && currentUserCode && order.salesCode === currentUserCode);
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

let selfOrderSupplyAttempt = null;
window.openSelfOrderModal = function(orderId,itemId) {
    const order=ordersCache.find(row=>row.id===orderId);
    const item=normalizedOrderItems(order||{}).find(row=>row.itemId===itemId);
    if(!order||!item||orderInventorySyncIncomplete(order)||!canBusinessSelfOrder(order))return;
    const remaining=remainingProcurementQty(order,item);
    if(remaining<=0){alert('此品項目前沒有尚未訂貨的缺貨數量。');return;}
    selfOrderSupplyAttempt=null;
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
    const fingerprint=JSON.stringify([currentUser?.uid,orderId,itemId,supplier,qty,unitCost,orderDate,notes]);
    if(selfOrderSupplyAttempt?.fingerprint!==fingerprint)selfOrderSupplyAttempt={fingerprint,operationId:lifecycleRecordId()};
    button.disabled=true;button.innerText='建立中…';
    try{
        const {order:savedOrder,internalNo}=await commitSelfOrderSupply(orderId,itemId,{supplier,qty,unitCost,orderDate,notes,operationId:selfOrderSupplyAttempt.operationId});
        selfOrderSupplyAttempt=null;
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
        productType:item.productType||order.productType||'',
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
    // Presentation only: a uniform pure-Service index can describe every line.
    // Never pass this persisted summary to orderWorkIndexFields or a writer.
    if (category !== 'closed' && String(item.productType||'').trim().toUpperCase()==='SERVICE'
        && order.inventoryReservationStatus==='completed'
        && Array.isArray(order.items) && order.items.length>0
        && order.items.some(row=>String(row?.productType||'').trim().toUpperCase()==='SERVICE')
        && Array.isArray(order.workCategories) && order.workCategories.length===1
        && order.items.every(row=>String(row?.productType||'').trim().toUpperCase()==='SERVICE'
            ||orderItemWorkCategory(order,row,lifecycleOverride)===order.workCategories[0])) {
        const saved=order.workCategories[0];
        if ((saved==='billing' && !order.isBilled) || (saved==='complete' && order.isBilled===true)) return saved;
    }
    if (category !== 'delivery') return category;
    if (String(item.productType||'').trim().toUpperCase()==='SERVICE') return category;
    if ((item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return 'shipping';
    return dispatch.pending > 0 ? 'dispatch' : 'shipping';
}

function orderItemDisplayCategories(order, item, lifecycleOverride = null, dispatchOverride = null) {
    const dispatch = dispatchOverride || itemDispatchState(order, item);
    const category=orderItemDisplayCategory(order,item,lifecycleOverride,dispatch);
    if(category!=='closed'&&['pending','failed'].includes(order?.inventoryReservationStatus))return [];
    const warehouse=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'
        &&String(item.productType||'').trim().toUpperCase()!=='SERVICE';
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
        const warehouse=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'
            &&String(item.productType||'').trim().toUpperCase()!=='SERVICE';
        return warehouse && ['ordering','arrival','delivery'].includes(category) && itemDispatchState(order,item).pending>0
            ? [category,'dispatch'] : [category];
    }))];
    if(!categories.length)return ['ordering'];
    return categories;
}

function orderWorkIndexFields(order) {
    const items=normalizedOrderItems(order);
    const hasService=items.some(item=>String(item.productType||'').trim().toUpperCase()==='SERVICE');
    // Registered Service case events are the authority for completion. A
    // subsequent client-side edit must not reset their server-projected queue.
    if (hasService&&Array.isArray(order.workCategories)
        &&(order.workCategoryUpdatedAt||order.workCategories.some(category=>category==='billing'||category==='complete'))) {
        if(orderLifecycleInfo(order).status!=='normal')
            throw new Error('已有服務完成紀錄的訂單須由後端核對案件後取消或恢復。');
        return {};
    }
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
    if (String(item.productType||'').trim().toUpperCase()==='SERVICE'
        && ['billing','complete'].includes(category)
        && orderItemDisplayCategory(order,item,null,state)===category) return qty*unitSales;
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
            await window.loadV2WarehouseShipmentLocations?.(orderWorkQueueCache);
            if (generation !== orderWorkQueueGeneration || uid !== currentUser?.uid || role !== currentUserRole) return;
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
                if (document.getElementById('inventory-system')?.classList.contains('active')) window.renderInventoryShipping?.();
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
    container.innerHTML = definitions.map(([key, label]) => `<button type="button" class="order-work-card ${activeOrderWorkFilter === key ? 'active' : ''}" onclick="setOrderWorkFilter('${key}')"><span>${label}</span><strong>${key !== 'complete' && !orderWorkQueueReady ? (orderWorkQueueError || '讀取中…') : metrics[key].count + ' 品項'}</strong><small>銷售金額 ${formatStatsMoney(metrics[key].amount)}</small></button>`).join('');
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
    return [...new Set(salesList.filter(isSelectableCommercialOwner).map(person => stripPhoneSuffix(person.name)).filter(Boolean))]
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
    window.renderServiceCaseEntry?.();
    const tbody = document.getElementById('ordersBody');
    const searchInput = document.getElementById('orderSearch');
    if (!tbody || !searchInput) return;

    const openedDetails=new Set([...tbody.querySelectorAll('details.order-detail-panel[open]')].map(panel=>panel.dataset.orderId));
    const openedEditors=new Set([...tbody.querySelectorAll('.order-detail-panel:has(.order-commercial-editor[open])')].map(panel=>panel.dataset.orderId));
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
        const detailsEditable=globalThis.YushinOrderCommercialDetails.canEdit(o)&&!window.orderCommercialEditPending?.has(o.id);
        const detailsLocked=!globalThis.YushinOrderCommercialDetails.beforeReceipt(o);
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
        const matchedOrderItems=activeOrderWorkFilter==='all'
            ? allOrderItems
            : allOrderItems.filter(item=>(displayCategoriesByItem.get(item) || []).includes(activeOrderWorkFilter));
        shown++;

        matchedOrderItems.forEach((displayItem,displayIndex)=>{
        const orderItems=[displayItem],displayRowKey=o.id+':'+displayItem.itemId;
        const tr = document.createElement('tr');
        tr.dataset.orderId=o.id;tr.dataset.menuTitle=[o.customerName,o.orderNo||o.quoteNo||'未編單號',o.orderDate].filter(Boolean).join(' · ');
        tr.dataset.menuScope='整張訂單操作';
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
        const inventorySyncPending = pendingOrderReservationIds.has(o.id);
        if (lifecycle.status !== 'normal') {
            tr.classList.add('order-row-closed');
        }
        bindListRowSelection(tr);
        tr.innerHTML = `
            <td class="order-date-cell" data-th="訂單日期">${workflowRecordSummary(o, o.orderDate)}</td>
            <td class="order-customer-cell" data-th="客戶名稱">${o.customerName ? `<button type="button" class="btn-small btn-secondary workflow-customer-link" onclick="showCustomerOrderHistory(${inlineJsValue(o.customerName)})">${escapeHtml(o.customerName)}</button>` : ''}</td>
            <td data-th="產品資訊" class="order-product-cell">${orderItems.map(item=>`<div class="workflow-product-item">${purchaseProductSummary(item, Number(item.orderedQty||item.qty||0), null)}</div>`).join('')}</td>
            <td class="order-sales-cell" data-th="負責業務">${escapeHtml(stripPhoneSuffix(o.salesName))}</td>

            <td data-th="訂單金額" class="order-money-cell">${orderItems.map(item=>workflowSalesAmount(o,item)).join('')}${allOrderItems.length>1&&displayIndex===matchedOrderItems.length-1?`<small class="workflow-order-total">整張訂單合計 NT$ ${escapeHtml(Number(parseFloat(String(o.totalPrice??'').replace(/,/g,''))||0).toLocaleString())}</small>`:''}<small>${o.isBilled ? '已核銷' : '未核銷'}</small></td>
            <td data-th="進度" class="order-progress-cell">${workflowCommercialSummary(o)}${orderItems.map((item,index)=>{const displayCategories=displayCategoriesByItem.get(item)||[];const primaryStatus=displayCategories[0]||'ordering';const itemStatus=['dispatch','shipping'].includes(activeOrderWorkFilter)&&displayCategories.includes(activeOrderWorkFilter)?activeOrderWorkFilter:primaryStatus;const itemStatusMap={ordering:'待採購',arrival:'待到貨',dispatch:'待打單',shipping:'已打單',billing:'待核銷',complete:'已完成',closed:lifecycle.label};const waiting=primaryStatus==='arrival'?waitingDaysFromDate(item.orderedAt):'';const state=dispatchStateByItem.get(item)||itemDispatchState(o,item);const receipt=primaryStatus==='arrival'?receivingWorkProgress(o,item):null;return `<div class="workflow-progress-item">${orderItems.length>1?`<strong>${escapeHtml(item.itemName||item.itemCode||'品項')}</strong>`:''}<small class="order-item-work-status">訂單狀態：<span class="order-progress-badge">${escapeHtml(((lifecycle.status==='normal'&&orderInventorySyncIncomplete(o)) ? (o.inventoryReservationStatus==='failed'?'庫存同步未完成':'庫存同步中…') : ((String(item.productType||'').trim().toUpperCase()==='SERVICE'&&lifecycle.status==='normal'&&primaryStatus==='delivery'?'待服務處理':(lifecycle.status==='normal'&&globalThis.YushinWarehouseLogistics?.shippingStatus(o,item,state)))||itemStatusMap[itemStatus]||'待採購')))}</span>${waiting?`・已等 ${escapeHtml(waiting)}`:''}${state.pending>0?`<span class="workflow-quantity">待打單 ${escapeHtml(state.pending)}</span>`:''}${receipt?`<span class="workflow-quantity">已到貨 ${escapeHtml(receipt.received)}／應到貨 ${escapeHtml(receipt.target)}・待到貨 ${escapeHtml(receipt.remaining)}</span>`:''}${state.shippable>0?`・已有 ${escapeHtml(state.shippable)} 可出貨`:''}</small>${window.serviceCaseVerifiedItemHint?.(o.id,item)||''}</div>`}).join('')}</td>
            <td class="no-print" data-th="操作"><div class="workflow-inline-actions">
                <details class="order-detail-panel" data-order-id="${escapeAttr(displayRowKey)}" ${openedDetails.has(displayRowKey)?'open':''}>
                    <summary aria-haspopup="dialog" aria-expanded="false">明細${window.orderCommercialEditPending?.has(o.id)?'（儲存中…）':''}</summary>
                    <dialog class="order-detail-drawer" aria-label="訂單明細"><header class="order-drawer-heading"><h3>訂單明細</h3><button type="button" class="btn-secondary" data-order-drawer-close autofocus>關閉</button></header><div class="order-detail-content"><section class="order-drawer-section"><h4>訂單摘要</h4><dl class="order-drawer-summary"><div><dt>單號</dt><dd>${escapeHtml(o.orderNo||'—')}</dd></div><div><dt>客戶</dt><dd>${escapeHtml(o.customerName||'—')}</dd></div><div><dt>負責業務</dt><dd>${escapeHtml(stripPhoneSuffix(o.salesName))}</dd></div><div><dt>訂單日期</dt><dd>${escapeHtml(o.orderDate||'—')}</dd></div><div><dt>訂單總額</dt><dd>NT$ ${escapeHtml(Number(parseFloat(String(o.totalPrice??'').replace(/,/g,''))||0).toLocaleString())}</dd></div></dl>${o.quoteNo?`<div class="record-reference">來源估價單 ${escapeHtml(o.quoteNo)}</div>`:''}</section><section class="order-drawer-section"><h4>全部訂單品項</h4><div class="workflow-price-breakdown">${allOrderItems.map(item=>`<div class="${orderItems.includes(item)?'is-current-work-item':''}"><strong>${escapeHtml(item.itemName||item.itemCode||'品項')}</strong>${orderItems.includes(item)?'<small class="order-current-item-label">目前分頁品項</small>':''}<small>${escapeHtml(lifecycle.status!=='normal'?lifecycle.label:(String(item.productType||'').toUpperCase()==='SERVICE'&&(displayCategoriesByItem.get(item)||[]).includes('delivery')?'待服務處理':globalThis.YushinWarehouseLogistics?.shippingStatus(o,item,dispatchStateByItem.get(item))||(displayCategoriesByItem.get(item)||[]).map(workflowWorkCategoryLabel).join('・')))}</small>${window.serviceCaseVerifiedItemHint?.(o.id,item)||''}${workflowSalesAmount(o,item)}</div>`).join('')}</div></section><section class="order-drawer-section"><h4>交付資料</h4>
                        <div class="order-item-prices">${allOrderItems.map(item => `<div><strong>${escapeHtml(item.itemName||item.itemCode||'品項')}</strong><div>採購方式：${escapeHtml(globalThis.YushinOrderCommercialDetails.procurementLabel(item))}</div><div>交付方式：${escapeHtml(globalThis.YushinOrderEntry.deliveryLabel({fulfillmentType:item.fulfillmentType,deliveryPlan:item.deliveryPlan||o.shippingInstructions||{}}))}</div>${canEditOrders&&lifecycle.status==='normal'&&!detailsLocked&&(currentUserRole==='admin'||o.ownerUid===currentUser?.uid||canReceiveInventoryCapability())&&!globalThis.YushinOrderCommercialDetails.itemMoved(item)?`<button type="button" class="btn-small btn-secondary" onclick="openWarehouseDeliveryPlan(${inlineJsValue(o.id)},${inlineJsValue(item.itemId)})">修改交付方式／地址</button>`:''}</div>`).join('')}</div>
                        </section><section class="order-drawer-section"><h4>交易與備註</h4><dl class="order-drawer-summary order-commercial-summary"><div><dt>交易方式</dt><dd>${escapeHtml(o.transactionType||'未選擇')}</dd></div><div><dt>發票抬頭</dt><dd>${escapeHtml(o.invoiceTitle||'—')}</dd></div><div><dt>訂單備註</dt><dd>${escapeHtml(o.remarks||'—')}</dd></div></dl><details class="order-commercial-editor" ${openedEditors.has(displayRowKey)?'open':''}><summary>${detailsEditable?'編輯交易與備註':canManageOrderOps?'成本與交易設定':'查看交易設定'}</summary>${detailsLocked?'<small>已到貨或進入交付流程，訂單交付設定、交易方式及訂單備註已鎖定。</small>':''}
            ${canManageOrderOps ? `
            <div class="no-print order-cost-profit-cell"><label>單位成本</label><input type="number" step="0.01" class="order-cost-input" data-order-id="${o.id}" ${(o.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER' ? 'readonly title="標準成本由產品成本資料帶入"' : ''} value="${o.procurementType === 'SALES_SELF_ORDER' ? (o.costPrice == null ? '' : Number(Number(o.costPrice).toFixed(2))) : ''}" oninput="updateOrderProfitDisplay('${o.id}', this.value)" onchange="updateOrderField('${o.id}','costPrice', this.value === '' ? null : parseFloat(this.value))"><small>毛利：<span id="orderProfit_${o.id}_${displayIndex}">${formatProfitPercent(o.unitPrice, o.costPrice)}</span></small></div>` : ''}
            <div class="order-transaction-cell"><label>交易方式</label>
                <select onchange="updateOrderField('${o.id}','transactionType',this.value)">
                    <option value="" ${!o.transactionType ? 'selected' : ''}>未選擇</option>
                    <option value="直" ${o.transactionType === '直' ? 'selected' : ''}>直</option>
                    <option value="借" ${o.transactionType === '借' ? 'selected' : ''}>借</option>
                    <option value="扣" ${o.transactionType === '扣' ? 'selected' : ''}>扣</option>
                </select>
                ${o.transactionType === '直' ? `<input type="text" aria-label="發票抬頭" placeholder="發票抬頭" value="${escapeAttr(o.invoiceTitle || '')}" onchange="updateOrderField('${o.id}','invoiceTitle',this.value)">` : ''}
                ${o.isBilled ? `<label class="order-invoice-date-label">核銷日期<input type="date" aria-label="核銷日期" ${allOrderItems.some(item=>String(item.productType||'').trim().toUpperCase()==='SERVICE')&&(!window.serviceBillingDateEnabled?.(o)||billingPending)?'disabled title="目前無法修改服務核銷日期"':''} value="${escapeAttr(orderBillingDate(o))}" onchange="updateOrderBillingDate('${o.id}',this.value)"></label>` : ''}
            </div>
            <label class="order-remarks-editor">訂單備註<input type="text" value="${escapeAttr(o.remarks || '')}" placeholder="訂單備註" onchange="updateOrderField('${o.id}','remarks',this.value)"></label>
                    </details></section><section class="order-drawer-section"><button type="button" class="btn-secondary" onclick="openOrderStatusHistory(${inlineJsValue(o.id)})">查看操作紀錄</button></section></div></dialog>
                </details>
                ${orderInventorySyncStatusHtml(o)}
                <div class="order-compact-actions">
                    ${window.serviceCaseActionHtml?.(o)||''}
                    ${selfOrderActionHtml(o, allOrderItems, dispatchStateByItem)}
                    ${directShipReceiptActionHtml(o, allOrderItems)}
                    ${globalThis.YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR===true
                        && lifecycle.status==='normal'&&canManageOrderLifecycleCapability()&&canEditPage('orders.list')
                        && (currentUserRole==='admin'||o.ownerUid===currentUser?.uid)
                        && v3CustodyShipmentItems(o).length===allOrderItems.length
                        && allOrderItems.length>0
                        ? `<button type="button" class="btn-small" onclick="openV3CustodyShipment(${inlineJsValue(o.id)})">業務保管出貨／核對</button>`:''}
                    ${globalThis.YUSHIN_V3_CUSTODY_RETURN_EMULATOR===true
                        && lifecycle.status==='normal'&&canManageOrderLifecycleCapability()&&canEditPage('orders.list')
                        && (currentUserRole==='admin'||o.ownerUid===currentUser?.uid)
                        && allOrderItems.length>0&&allOrderItems.length<=5
                        && (v3CustodyReturnCandidates(o).length>0
                            || allOrderItems.some(item=>unresolvedV3CustodyReturnExists(o.id,item.itemId)))
                        ? `<button type="button" class="btn-small" onclick="openV3CustodyReturn(${inlineJsValue(o.id)})">保管退貨實收／核對</button>`:''}
                    
                    ${canConfirmOrderDelivery && lifecycle.status === 'normal' && deliveryProgress.state !== 'complete' && (fulfillmentProgress.shippable>0 || deliveryPending) ? `<button type="button" class="btn-small" onclick="${useBatchDelivery ? 'openPartialDeliveryForOrder' : 'quickCompleteDelivery'}(${inlineJsValue(o.id)})" ${orderInventorySyncIncomplete(o) || lifecycle.status !== 'normal' || deliveryPending || deliveryProgress.state === 'complete' || fulfillmentProgress.shippable<=0 ? 'disabled' : ''}>${deliveryPending ? '處理中…' : useBatchDelivery ? '確認分批送達' : '確認送達'}</button>` : ''}
                    ${canBusinessSelfOrder(o) ? `<button type="button" class="btn-small order-billing-action ${o.isBilled ? 'btn-secondary' : ''}" onclick="toggleOrderStatus('${o.id}', 'isBilled', ${!o.isBilled})" ${lifecycle.status !== 'normal' || billingPending || inventorySyncPending ? 'disabled' : ''}>${billingPending ? '儲存中…' : o.isBilled ? '已核銷' : '核銷'}</button>` : ''}
                    <details class="order-more-menu">
                        <summary title="更多操作">⋯</summary>
                        <div class="order-more-menu-popover">
                            ${orderLifecycleActionButtons(o, lifecycle, deliveryProgress, contextActions)}
                            <button type="button" onclick="copyOrderAsNew('${o.id}')">複製成新訂單</button>
                            <button type="button" onclick="openOrderStatusHistory('${o.id}')">查看紀錄</button>
                            ${trueUserRole === 'admin' && currentUserRole === 'admin' ? `<button type="button" class="danger-menu-item" onclick="permanentlyDeleteOrder(${inlineJsValue(o.id)})" ${pendingLifecycleOrderIds.has(o.id) ? 'disabled aria-busy="true"' : ''}>${pendingLifecycleOrderIds.has(o.id) ? '處理中…' : '永久刪除'}</button>` : ''}
                        </div>
                    </details>
                </div></div>
            </td>
        `;
        if (!detailsEditable) {
            tr.querySelectorAll('.order-transaction-cell select, .order-transaction-cell input:not([type="date"]), .order-remarks-editor input').forEach(control => {
                control.disabled = true;
                control.setAttribute('aria-readonly', 'true');
            });
        }
        if (!canEditOrders) {
            tr.querySelectorAll('.order-transaction-cell input[type="date"]').forEach(control=>{control.disabled=true;});
            tr.querySelectorAll('.order-more-menu-popover button').forEach(button => {
                const action = button.getAttribute('onclick') || '';
                if (!action.includes('openOrderStatusHistory(')) button.remove();
            });
        }
        organizeOrderRowActions(tr, activeOrderWorkFilter);
        fragment.appendChild(tr);
        });
    });
    tbody.appendChild(fragment);
    tbody.querySelectorAll('tr').forEach(bindOrderDetailDrawer);
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
    return `<div class="inline-status" role="status">${label}${running||canRetry?` <button type="button" class="btn-small" ${running?'disabled aria-busy="true"':''} onclick="retryOrderInventoryReservation(${inlineJsValue(order.id)})">重試同步</button>`:''}</div>`;
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

