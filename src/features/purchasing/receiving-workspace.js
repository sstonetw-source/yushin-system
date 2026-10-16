// Receipt dialogs, frozen retry jobs and view refresh. Authoritative writes stay in Services.
function receiptOperationStorageKey(supplyId, ownerUid = currentUser?.uid || '') {
    return `yushin-receipt-operation:${ownerUid}:${String(supplyId || '')}`;
}
function ensureReceiptOperationId(supplyId) {
    const key=receiptOperationStorageKey(supplyId);
    let operationId='';
    try { operationId=sessionStorage.getItem(key)||''; } catch (_) {}
    if(!operationId){
        operationId=`receipt-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
        try { sessionStorage.setItem(key,operationId); } catch (_) {}
    }
    poReceiptOperationId=operationId;
    return operationId;
}
function clearReceiptOperationId(supplyId, completedOperationId = '', ownerUid = currentUser?.uid || '') {
    try {
        const key=receiptOperationStorageKey(supplyId,ownerUid);
        if(!completedOperationId||sessionStorage.getItem(key)===completedOperationId)sessionStorage.removeItem(key);
    } catch (_) {}
    if(currentUser?.uid===ownerUid&&(!completedOperationId||poReceiptOperationId===completedOperationId))poReceiptOperationId='';
}
window.closePoReceiptBatch = function() {
    document.getElementById('poReceiptBatchOverlay')?.classList.remove('active');
    const body=document.getElementById('poReceiptBatchBody');
    if(body)body.innerHTML='';
    poReceiptTargetId='';
};


window.receiveSupplyOrder = function(supplyId) {
    if (!canReceiveInventoryCapability()) { alert('您沒有到貨入庫權限。'); return; }
    if (receiptTaskBlocksSupply(supplyId)) return;
    const supply=pendingSupplyCache.find(row=>row.id===supplyId);
    if(!supply)return;
    const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
    if(remaining<=0){alert('這筆訂貨已全部入庫。');return;}
    poReceiptTargetId='supply:'+supplyId;
    ensureReceiptOperationId(supplyId);
    const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
    const title=document.getElementById('poReceiptBatchTitle');
    if(title)title.textContent=directShip ? `原廠直送到貨｜${supply.internalNo||supplyId}` : `到貨入庫｜${supply.internalNo||supplyId}`;
    const body=document.getElementById('poReceiptBatchBody');
    body.innerHTML=`<tr data-index="0">
      <td><input type="checkbox" class="po-receive-select" checked></td>
      <td>${escapeHtml(supply.itemCode||'')}</td>
      <td>${escapeHtml(supply.itemName||'')}</td>
      <td>${Number(supply.qty||0)}</td><td>${Number(supply.receivedQty||0)}</td><td>${remaining}</td>
      <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
      <td><input type="text" class="po-receive-lot" placeholder="批號" ${directShip ? 'disabled' : ''}></td>
      <td><input type="date" class="po-receive-expiry" ${directShip ? 'disabled' : ''}></td>
    </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};


window.openSupplyReceipt = function(supplyId) {
    if (receiptTaskBlocksSupply(supplyId)) return;
    const supply = supplyReceivingCache.find(row => row.id === supplyId);
    if (!supply) { alert('找不到這筆待到貨紀錄，請重新整理。'); return; }
    if (!canConfirmSupplyReceipt(supply)) { showActionFeedback('原廠直送請由該訂單負責業務確認到貨。','warning');return; }

    const ordered = Math.max(0, Number(supply.qty || 0));
    const received = Math.max(0, Number(supply.receivedQty || 0));
    const remaining = Math.max(0, ordered - received);
    if (remaining <= 0) { alert('此品項已全部到貨。'); return; }

    const directShip = (supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
    poReceiptTargetId = `supply:${supply.id}`;
    ensureReceiptOperationId(supply.id);
    const body = document.getElementById('poReceiptBatchBody');
    const title = document.getElementById('poReceiptBatchTitle');
    if (title) title.textContent = directShip
        ? `原廠直送到貨｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`
        : `到貨入庫｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`;
    body.innerHTML = `
        <tr data-index="0">
            <td><input type="checkbox" class="po-receive-select" checked></td>
            <td>${escapeHtml(supply.itemCode || '')}</td>
            <td>${escapeHtml(supply.itemName || '')}</td>
            <td>${ordered}</td><td>${received}</td><td>${remaining}</td>
            <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
            <td><input type="text" class="po-receive-lot" placeholder="批號" ${directShip ? 'disabled' : ''}></td>
            <td><input type="date" class="po-receive-expiry" ${directShip ? 'disabled' : ''}></td>
        </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

const receiptTaskJobs = new Map();
const restoredReceiptTaskUsers = new Set();

function receiptTaskKey(supplyId, ownerUid = currentUser?.uid || '') {
    return `${ownerUid}:${supplyId}`;
}
function persistReceiptTasks(ownerUid) {
    try {
        const jobs=[...receiptTaskJobs.values()].filter(job=>job.ownerUid===ownerUid&&job.state!=='done');
        sessionStorage.setItem(`yushin-receipt-tasks:${ownerUid}`,JSON.stringify(jobs));
    } catch(err) { console.warn('無法暫存背景到貨工作，請保持頁面開啟：',err); }
}
function restoreReceiptTasks() {
    const uid=currentUser?.uid;
    if(!uid||restoredReceiptTaskUsers.has(uid))return;
    restoredReceiptTaskUsers.add(uid);
    try {
        const jobs=JSON.parse(sessionStorage.getItem(`yushin-receipt-tasks:${uid}`)||'[]');
        if(Array.isArray(jobs))jobs.forEach(job=>{
            if(job.ownerUid!==uid||typeof job.supplyId!=='string'||!job.supplyId||typeof job.operationBase!=='string'||!job.operationBase||!Array.isArray(job.entries)||!job.entries.length
                ||job.entries.some(entry=>!Number.isFinite(entry.qty)||entry.qty<=0||!Number.isInteger(entry.itemIndex)||entry.itemIndex<0))return;
            const key=receiptTaskKey(job.supplyId,uid);
            if(!receiptTaskJobs.has(key))receiptTaskJobs.set(key,{...job,state:'error',error:'上次處理結果尚未確認；可用原資料重試，系統不會重複入庫。'});
        });
    } catch(err) { console.warn('背景到貨暫存讀取失敗：',err); }
}
function renderReceiptTasks() {
    const panel=document.getElementById('receiptTaskStatus');
    if(!panel)return;
    const jobs=[...receiptTaskJobs.values()].filter(job=>job.ownerUid===currentUser?.uid);
    panel.hidden=!jobs.length;
    panel.innerHTML=jobs.map(job=>`<div class="receipt-task ${job.state==='error'?'receipt-task-error':''}">
        <span>${escapeHtml(job.label)}：${job.state==='error'?escapeHtml(job.error):'到貨處理中，可繼續其他操作；請保持頁面開啟。'}</span>
        ${job.state==='error'&&(canReceiveInventoryCapability()||['sales','engineer'].includes(currentUserRole))?`<button type="button" class="btn-small" onclick="retryReceiptTask(${inlineJsValue(job.supplyId)})">用原資料重試</button>`:''}
    </div>`).join('');
    document.querySelectorAll('button[data-receipt-supply]').forEach(button=>{
        const job=receiptTaskJobs.get(receiptTaskKey(button.dataset.receiptSupply));
        button.disabled=!!job||button.dataset.receiptConfirmed==='true';
        if(job)button.textContent=job.state==='error'?'到貨待確認':'到貨處理中…';
    });
}
function receiptTaskBlocksSupply(supplyId) {
    restoreReceiptTasks();
    const job=receiptTaskJobs.get(receiptTaskKey(supplyId));
    if(!job)return false;
    renderReceiptTasks();
    showActionFeedback(job.state==='error'?'這筆到貨結果待確認，請使用上方「用原資料重試」。':'這筆到貨正在背景處理，其他品項可繼續操作。','warning');
    return true;
}
window.retryReceiptTask = function(supplyId) {
    if(!canReceiveInventoryCapability()&&!['sales','engineer'].includes(currentUserRole))return;
    const job=receiptTaskJobs.get(receiptTaskKey(supplyId));
    if(!job||job.state!=='error')return;
    // 舊暫存未含角色，只在本人明確重試時補上；新工作跨重試保留原角色。
    if(!job.actorRole)job.actorRole=currentUserRole;
    return runReceiptTask(job);
};
window.addEventListener('beforeunload',event=>{
    if([...receiptTaskJobs.values()].some(job=>job.state==='running')){
        event.preventDefault();event.returnValue='';
    }
});

async function refreshReceiptTaskViews(affectedOrderIds,contextGuard=null) {
    contextGuard?.();
    markMainPageDirty('inventory','orders.list','orders.po','admin');
    const refreshes=[];
    // 已開始的查詢可能早於這次到貨；等它結束後再讀最新資料，避免合併成過期的刷新。
    const pendingReads=[purchasingReceivingLoadPromise,activeReceivingSupplyLoadPromise].filter(Boolean);
    if(pendingReads.length)await Promise.allSettled(pendingReads);
    contextGuard?.();
    if(inventoryReceivingVisible&&document.getElementById('inventory-system')?.classList.contains('active'))refreshes.push(loadPurchasingReceivingQueue(true));
    else if(canAccessPage('inventory')&&document.getElementById('inventory-system')?.classList.contains('active'))refreshes.push(loadInventory(true));
    if(getDataScope('orders')!=='none')refreshes.push(refreshAffectedOrderCaches([...affectedOrderIds]));
    const results=await Promise.allSettled(refreshes);
    if(results.some(result=>result.status==='rejected'))showActionFeedback('到貨已完成；部分畫面同步失敗，重新進入該頁會再載入。','warning');
}

async function runReceiptTask(job) {
    if(job.state==='running'||job.ownerUid!==currentUser?.uid||(!canReceiveInventoryCapability()&&!['sales','engineer'].includes(currentUserRole)))return;
    const assertJobActor=()=>{if(job.ownerUid!==currentUser?.uid||job.actorRole!==currentUserRole)throw new Error('登入帳號或角色已變更，請以原身分確認到貨結果。');};
    job.state='running';job.error='';
    persistReceiptTasks(job.ownerUid);
    renderReceiptTasks();
    const affectedOrderIds=new Set();
    const supplyId=job.supplyId;
    try {
        assertJobActor();
        for(const entry of job.entries){
            assertJobActor();
            if(currentUser?.uid!==job.ownerUid||(!canReceiveInventoryCapability()&&!['sales','engineer'].includes(currentUserRole)))throw new Error('登入身份已變更，請以原帳號確認到貨結果。');
            const operationId=`${job.operationBase}-${entry.itemIndex}`;
            const ids=await receiveSupplyOrderRecord(supplyId,entry.qty,entry.lotNo,entry.expiryDate,operationId,{actorUid:job.ownerUid,actorRole:job.actorRole,onStockCommitted:invalidateWarehouseStockCache});
            assertJobActor();
            ids.forEach(id=>affectedOrderIds.add(id));
        }
        // 核心資料已確認完成後才移除暫存。保留同一個 operationId 供網路中斷重試。
        assertJobActor();
        clearReceiptOperationId(supplyId,job.operationBase,job.ownerUid);
        job.state='done';
        receiptTaskJobs.delete(receiptTaskKey(supplyId,job.ownerUid));
        persistReceiptTasks(job.ownerUid);
        if(currentUser?.uid!==job.ownerUid||currentUserRole!==job.actorRole)return;
        // 暫時移除這筆舊到貨列；部分到貨餘額由後續查詢帶回，不用舊快取推算數量。
        supplyReceivingCache=supplyReceivingCache.filter(row=>row.id!==supplyId);
        pendingSupplyCache=pendingSupplyCache.filter(row=>row.id!==supplyId);
        document.querySelectorAll('button[data-receipt-supply]').forEach(button=>{
            if(button.dataset.receiptSupply===supplyId){button.dataset.receiptConfirmed='true';button.disabled=true;button.textContent='到貨已確認';}
        });
        renderReceiptTasks();
        showActionFeedback(`${job.label}：到貨已確認。`,'success');
        await refreshReceiptTaskViews(affectedOrderIds,assertJobActor);
    } catch(err) {
        if(job.state==='done'){
            if(currentUser?.uid===job.ownerUid&&currentUserRole===job.actorRole)showActionFeedback('到貨已確認；畫面同步失敗，重新進入該頁會再載入。','warning');
            return;
        }
        // 後續分配可能尚未完成；原收貨資料與識別碼必須保留，不能換成新的一筆。
        job.state='error';
        job.error=err?.code==='receipt-allocation-pending'&&err?.receiptCommitted
            ? '已確認到貨，後續處理尚未完成。請用原資料重試。'
            : `結果待確認：${err.message||err}。請用原資料重試。`;
        persistReceiptTasks(job.ownerUid);
        if(currentUser?.uid===job.ownerUid&&currentUserRole===job.actorRole)renderReceiptTasks();
    }
}

window.savePoReceiptBatch = async function() {
    const poId=poReceiptTargetId;
    if(!poId?.startsWith('supply:')){alert('到貨必須從供應紀錄進入，請重新開啟待到貨品項。');return;}
    const supplyId=poId.slice(7);
    if(receiptTaskBlocksSupply(supplyId))return;
    const rows=[...document.querySelectorAll('#poReceiptBatchBody tr')].filter(row=>row.querySelector('.po-receive-select')?.checked);
    const entries=rows.map(row=>({itemIndex:Number(row.dataset.index),qty:Number(row.querySelector('.po-receive-qty')?.value||0),
        lotNo:(row.querySelector('.po-receive-lot')?.value||'').trim(),expiryDate:row.querySelector('.po-receive-expiry')?.value||''}));
    if(!entries.length||entries.some((entry,index)=>!Number.isFinite(entry.qty)||entry.qty<=0||entry.qty>Number(rows[index].querySelector('.po-receive-qty')?.max)||!Number.isInteger(entry.itemIndex))){
        alert('請勾選到貨品項，數量須大於 0 且不可超過未收數量。');return;
    }
    const operationBase=poReceiptOperationId||ensureReceiptOperationId(supplyId);
    const supply=supplyReceivingCache.find(row=>row.id===supplyId)||pendingSupplyCache.find(row=>row.id===supplyId);
    if(!supply||!canConfirmSupplyReceipt(supply)){showActionFeedback('目前沒有這筆到貨確認權限，請重新開啟訂單。','warning');return;}
    const job={supplyId,operationBase,entries,ownerUid:currentUser.uid,actorRole:currentUserRole,label:supply?.itemCode||supply?.itemName||supplyId,state:'queued',error:''};
    receiptTaskJobs.set(receiptTaskKey(supplyId),job);
    persistReceiptTasks(job.ownerUid);
    // 關閉視窗前先保存獨立快照；後續開啟另一筆不會覆寫這筆的數量、批號或識別碼。
    closePoReceiptBatch();
    showActionFeedback('已開始背景確認到貨，可繼續其他操作；請保持頁面開啟。');
    return runReceiptTask(job);
};
