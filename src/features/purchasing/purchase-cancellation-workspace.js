// Purchase cancellation UI and cache refresh; authoritative writes stay in supply-order Service.
const purchaseCancellationInProgress = new Set();

window.cancelSupplyOutstanding = async function(supplyId) {
    if (!canCreatePurchaseOrderCapability()) {
        alert('只有管理員或採購可以取消採購的未到貨數量。');
        return;
    }
    const actionKey = `supply:${supplyId}`;
    const actorUid=currentUser?.uid,actorRole=currentUserRole;
    if (purchaseCancellationInProgress.has(actionKey)) return;

    let supply;
    try {
        const snapshot = await firestoreReadWithTimeout(
            supplyOrdersCollection().doc(supplyId).get(),
            '讀取採購品項狀態'
        );
        if (!snapshot.exists) throw new Error('找不到這筆供應紀錄。');
        supply = { id:snapshot.id, ...snapshot.data() };
    } catch (err) {
        alert('無法讀取採購品項：' + (err?.message || err));
        return;
    }

    if (!['PURCHASING_MANUAL', 'PURCHASING_PO'].includes(supply.type)) {
        alert('此採購方式不支援在這裡取消。');
        return;
    }
    if (isPurchaseTerminalStatus(supply.status)) {
        const label=String(supply.status||'').toUpperCase()==='CLOSED'?'已結案':'已取消';
        showActionFeedback(`這筆採購${label}，沒有待處理的未到貨數量。`, 'success');
        return;
    }
    const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
    if (remaining <= 0) {
        alert('這筆採購已全部到貨，沒有可取消的未到貨數量。');
        return;
    }

    const reasonRaw = prompt(
        `取消品項 ${supply.itemCode || supply.itemName || supply.id} 尚未到貨的 ${remaining} 個。\n採購單：${supply.purchaseDocumentNo || supply.internalNo || supply.id}\n只取消此品項，其他品項不受影響；已到貨的數量不回沖。\n來源訂單仍有效時，未滿足的數量會重新列入待採購。\n\n請輸入原因：`
    );
    if (reasonRaw === null) return;
    const reason = String(reasonRaw || '').trim();
    if (!reason) {
        alert('請填寫取消原因，方便後續追蹤。');
        return;
    }

    purchaseCancellationInProgress.add(actionKey);
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
    let supplyStopped=false;
    try {
        const result = await cancelOutstandingSupplyRecord(
            supply.purchaseDocumentId || supply.internalNo || supply.id,
            supply.id,
            reason,{actorUid,actorRole,onStockCommitted:invalidateWarehouseStockCache,onDemandChanged:invalidateProcurementDemandQueue}
        );
        supplyStopped=true;
        purchaseHistorySupplyCache.set(supply.id, {...supply, status:result.terminalStatus,
            incomingRegisteredQty:0, ...(result.terminalStatus === 'CLOSED' ? {closedQty:result.cancelledQty} : {cancelledQty:result.cancelledQty})});
        supplyReceivingCache = supplyReceivingCache.filter(row => row.id !== supply.id);
        try {
            await loadActiveReceivingSupplyCache(true);
            if (result.orderId) await refreshAffectedOrderCaches([result.orderId]);
        } catch (refreshError) {
            markMainPageDirty('orders.po');
            showActionFeedback('取消已完成，但清單更新失敗；請重新開啟採購頁確認。', 'warning');
            console.warn('取消後更新清單失敗', refreshError);
        }
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        showActionFeedback(
            `${result.terminalStatus==='CLOSED'?'已結案':'已取消'}採購品項 ${supply.itemCode || supply.itemName || supply.id}；取消未到貨數量 ${result.cancelledQty || remaining}，在途庫存已同步。`,
            'success'
        );
    } catch (err) {
        console.error('取消採購品項未到貨失敗：', err);
        alert(supplyStopped||err?.supplyCommitted?'取消已完成，但畫面更新失敗；請重新開啟採購頁確認：'+(err?.message||err)
            :'取消採購品項失敗：' + (err?.message || err) + '。可以重新執行；已成功的異動不會重複扣除。');
    } finally {
        purchaseCancellationInProgress.delete(actionKey);
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        if (document.getElementById('inventory-system')?.classList.contains('active') && inventoryReceivingVisible) renderPurchasingReceivingWorkList(null, null, null, null, true);
    }
};

window.cancelPurchaseOrderOutstanding = async function(poId) {
    if(!canCreatePurchaseOrderCapability()){alert('只有管理員或採購可以停止採購單未到貨數量。');return;}
    if(purchaseCancellationInProgress.has(poId))return;
    const actorUid=currentUser?.uid,actorRole=currentUserRole;
    const cached=poListCache.find(po=>po.id===poId)||poHistorySearchResults.find(po=>po.id===poId);
    let po=cached;
    try{
        const fresh=await firestoreReadWithTimeout(db.collection('purchaseOrders').doc(poId).get(),'讀取採購單取消狀態');
        if(!fresh.exists)throw new Error('找不到這張採購單。');
        po={id:fresh.id,...fresh.data()};
    }catch(err){
        alert('無法讀取採購單：'+(err?.message||err));
        return;
    }
    if(isPurchaseTerminalStatus(po.status)){
        const label=String(po.status||'').toUpperCase()==='CLOSED'?'已結案':'已取消';
        showActionFeedback(`這張採購單${label}，沒有待處理的未到貨數量。`,'success');
        return;
    }
    const reasonRaw=prompt(`停止採購單 ${po.poNo||po.id} 尚未到貨的數量。\n已實際到貨的數量不會回沖；若已有到貨紀錄，採購單會標示為「已結案」，完全未到貨才標示為「已取消」。\n原訂單會重新出現尚需採購的數量。\n\n請輸入原因：`);
    if(reasonRaw===null)return;
    const reason=String(reasonRaw||'').trim();
    if(!reason){alert('請填寫取消原因，方便後續追蹤。');return;}
    const supplyIds=Array.isArray(po.supplyOrderIds)?po.supplyOrderIds.filter(Boolean):[];
    if(!supplyIds.length){alert('這張採購單沒有可追蹤的供應紀錄，無法安全取消。');return;}

    purchaseCancellationInProgress.add(poId);
    let stopCommitted=false;
    try{
        const {patch,cancelledQty,supplyIds:committedSupplyIds,affectedOrderIds}=await stopPurchaseOrderOutstanding(poId,reason,{actorUid,actorRole,onStockCommitted:invalidateWarehouseStockCache,onDemandChanged:invalidateProcurementDemandQueue});
        if(!patch){alert('這張採購單目前沒有尚未到貨的數量可取消。');return;}
        stopCommitted=true;
        const documentStatus=patch.status;
        const applyPatch=row=>row?.id===poId?Object.assign(row,patch):row;
        poListCache.forEach(applyPatch);
        poHistorySearchResults.forEach(applyPatch);
        supplyReceivingCache=supplyReceivingCache.filter(row=>!committedSupplyIds.includes(row.id));
        try{
            if(affectedOrderIds.length)await refreshAffectedOrderCaches(affectedOrderIds);
        }catch(refreshError){
            markMainPageDirty('orders.po');
            console.warn('停止採購後更新清單失敗',refreshError);
            showActionFeedback('停止採購已完成，但清單更新失敗；請重新開啟採購頁確認。','warning');
        }
        writeAppDataCache('purchase-history',poListCache);
        if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView();
        else renderPoList();
        showActionFeedback(`${documentStatus==='CLOSED'?'已結案':'已取消'} ${po.poNo||poId}；停止未到貨數量 ${cancelledQty}，在途庫存與來源訂單待採購量已同步。`,'success');
    }catch(err){
        console.error('停止採購單未到貨失敗：',err);
        alert(stopCommitted?'停止採購已完成，但畫面更新失敗；請重新開啟採購頁確認：'+(err?.message||err)
            :'停止未完全完成：'+(err?.message||err)+'。可以再次執行同一動作；已完成的供應紀錄不會重複扣除。');
    }finally{
        purchaseCancellationInProgress.delete(poId);
    }
};

