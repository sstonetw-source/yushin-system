// Browser checkpoint only. The existing PO and incoming Services own all writes.
let formalPurchaseRecoveryRunning = false;
function formalPurchasePendingKey() {
    return 'formal-po-pending:' + encodeURIComponent(currentUser?.uid || '');
}
function pendingFormalPurchase() {
    const raw = sessionStorage.getItem(formalPurchasePendingKey());
    if (!raw) return null;
    try {
        const pending = JSON.parse(raw), po = pending?.poRecord;
        if (pending.version !== 1 || pending.actorUid !== currentUser?.uid
            || pending.actorRole !== currentUserRole || !['admin','purchaser'].includes(pending.actorRole)
            || !po || typeof po.poNo !== 'string' || !po.poNo || po.poNo.includes('/')
            || !Array.isArray(po.items) || !po.items.length)
            throw Error('invalid checkpoint');
        return pending;
    } catch (_) {
        throw Error('前次採購紀錄無法核對，請以原帳號及角色查核；請勿另建採購單。');
    }
}
function rememberFormalPurchase(poRecord, actorUid, actorRole) {
    if (actorUid !== currentUser?.uid || actorRole !== currentUserRole)
        throw Error('登入身分已變更，無法儲存採購作業。');
    if (!Array.isArray(poRecord?.items) || !poRecord.items.length
        || (globalThis.YUSHIN_FORMAL_PURCHASE_EMULATOR === true && (poRecord.items.length > 5 || poRecord.items.some(item => !item.orderId || !item.itemId
            || (item.sourceType && item.sourceType !== 'SALES_ORDER')
            || (item.fulfillmentType || 'WAREHOUSE') !== 'WAREHOUSE'))))
        throw Error('採購後端試點目前只支援 1–5 個客戶訂單實體入庫品項。');
    if (pendingFormalPurchase()) throw Error('請先確認前次採購結果，勿另建採購單。');
    const pending = {version:1, actorUid, actorRole, poRecord};
    // A failed storage write stops the operation BEFORE the server is called.
    sessionStorage.setItem(formalPurchasePendingKey(), JSON.stringify(pending));
    renderFormalPurchaseRecovery();
}
function clearFormalPurchasePending(poNo, actorUid, actorRole) {
    if (currentUser?.uid !== actorUid || currentUserRole !== actorRole) return;
    const pending = pendingFormalPurchase();
    if (pending?.poRecord.poNo === poNo) sessionStorage.removeItem(formalPurchasePendingKey());
    renderFormalPurchaseRecovery();
}
function cacheCommittedFormalPurchase({poRecord, committedSourceOrders, committedSupplyOrders}) {
    invalidateProcurementDemandQueue();
    syncCommittedPurchaseOrderSources(committedSourceOrders);
    if (committedSupplyOrders.length) {
        const supplyMap = new Map(supplyReceivingCache.map(row => [row.id, row]));
        committedSupplyOrders.forEach(row => supplyMap.set(row.id, row));
        supplyReceivingCache = [...supplyMap.values()]
            .sort((a,b) => String(b.orderDate || b.createdAt || '').localeCompare(String(a.orderDate || a.createdAt || '')));
    }
    const savedPo = {id:poRecord.poNo, ...poRecord};
    const index = poListCache.findIndex(po => po.id === savedPo.id);
    if (index >= 0) poListCache[index] = savedPo;
    else poListCache.unshift(savedPo);
    return savedPo;
}
function renderFormalPurchaseRecovery() {
    const panel = document.getElementById('formalPurchaseRecoveryPanel');
    if (!panel) return;
    panel.hidden = true;
    if (!currentUser?.uid
        || !canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    try {
        const pending = pendingFormalPurchase();
        if (!pending) return;
        panel.textContent = `採購單 ${pending.poRecord.poNo} 的結果尚待確認。`;
        const button = document.createElement('button');
        button.type = 'button'; button.id = 'confirmFormalPurchasePendingBtn';
        button.textContent = formalPurchaseRecoveryRunning ? '核對中…' : '確認前次採購結果';
        button.disabled = formalPurchaseRecoveryRunning || poSaveInProgress;
        button.onclick = recoverFormalPurchase;
        panel.appendChild(button);
    } catch (error) { panel.textContent = error.message; }
    panel.hidden = false;
}
async function recoverFormalPurchase() {
    if (formalPurchaseRecoveryRunning || poSaveInProgress) return;
    const uid = currentUser?.uid, role = currentUserRole;
    let confirmedPoNo = '';
    const check = () => {
        if (!uid || currentUser?.uid !== uid || currentUserRole !== role
            || !canCreatePurchaseOrderCapability() || !canAccessPage('orders.po'))
            throw Error('登入身分已變更，請以原帳號確認採購結果。');
    };
    try {
        check();
        const pending = pendingFormalPurchase();
        if (!pending) return;
        formalPurchaseRecoveryRunning = true;
        renderFormalPurchaseRecovery();
        const result = await commitFormalPurchaseOrder(pending.poRecord, {actorUid:uid, actorRole:role});
        check();
        const savedPo = cacheCommittedFormalPurchase(result);
        await registerPurchaseIncoming(savedPo.id, savedPo,
            {actorUid:uid, actorRole:role, onStockCommitted:invalidateWarehouseStockCache});
        check();
        confirmedPoNo = savedPo.poNo;
        clearFormalPurchasePending(savedPo.poNo, uid, role);
        if (poEditingId === savedPo.id) poIncomingSyncPending = false;
        if (document.getElementById('poModalOverlay')?.classList.contains('active')
            && document.getElementById('poNo')?.textContent?.trim() === savedPo.poNo)
            closePurchaseOrderModal();
        showActionFeedback(`採購單 ${savedPo.poNo} 已確認，在途同步完成；可由原採購單下載 PDF。`, 'success');
        renderPurchasingView();
    } catch (error) {
        if (currentUser?.uid === uid && currentUserRole === role)
            showActionFeedback(confirmedPoNo
                ? `採購單 ${confirmedPoNo} 與在途已確認，但畫面更新未完成：${error.message}`
                : '採購結果尚未確認：' + error.message, 'warning');
    } finally {
        formalPurchaseRecoveryRunning = false;
        renderFormalPurchaseRecovery();
    }
}
window.recoverFormalPurchase = recoverFormalPurchase;

// Explicit business confirmation. PDF and document reads never enter this path.
window.confirmSavedPurchaseOrder = async function(poId) {
    if(formalPurchaseRecoveryRunning || poSaveInProgress || poDraftLoading
        || !canCreatePurchaseOrderCapability() || !canAccessPage('orders.po'))return;
    const uid=currentUser?.uid,role=currentUserRole,generation=sessionDataGeneration;
    try {
        if(pendingFormalPurchase())throw Error('請先使用「確認前次採購結果」核對未完成作業，再確認其他文件。');
        const snap=await db.collection('purchaseOrders').doc(poId).get({source:'server'});
        if(currentUser?.uid!==uid || currentUserRole!==role || sessionDataGeneration!==generation)return;
        if(!snap.exists)throw Error('找不到原採購文件。');
        const record=snap.data();
        if(record.status!=='DRAFT' || record.documentOnly!==true)throw Error('此文件已確認或已停止，請更新清單並核對原採購紀錄。');
        if(!confirm(`確認採購單 ${record.poNo} 已向供應商下單？本次將登記文件上的品項與數量，並列入待到貨。`))return;
        rememberFormalPurchase(record,uid,role);
        await recoverFormalPurchase();
    } catch(error) {
        if(currentUser?.uid===uid && currentUserRole===role)showActionFeedback(error.message,'warning');
    }
};
