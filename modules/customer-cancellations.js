/* Customer cancellation and return receiving use live transactions, never optimistic stock writes. */
const customerReturnActionsPending = new Set();
let customerReturnOrders = [];
let customerReturnHasMore = false;
let customerReturnCursor = null;
function customerCancellationActions(supply) {
    if(supply.customerCancellationDisposition==='KEEP_STOCK')return `${supplyCancelActionHtml(supply)} <button type="button" onclick="openSupplyReceipt(${inlineJsValue(supply.id)})">到貨入庫</button>`;
    return `<strong>採購待確認</strong><button type="button" class="btn-danger" onclick="confirmSupplierCancellation(${inlineJsValue(supply.id)})">供應商同意取消</button><button type="button" class="btn-secondary" onclick="keepCancelledPurchaseAsStock(${inlineJsValue(supply.id)})">不同意取消・到貨轉庫存</button>`;
}
window.confirmSupplierCancellation=async function(id){
    if(!canCreatePurchaseOrderCapability())return;
    if(!confirm('請確認供應商已同意取消此品項尚未到貨的數量。系統將扣除對應在途數量，保留已到貨及其他品項。'))return;
    await cancelSupplyOutstanding(id);
};
window.keepCancelledPurchaseAsStock=async function(id){
    if(!canCreatePurchaseOrderCapability()||customerReturnActionsPending.has(id))return;
    const cached=supplyReceivingCache.find(s=>s.id===id);
    await loadWarehouseMaster();
    const direct=cached?.fulfillmentType==='DIRECT_SHIP';
    let warehouseId=cached?.warehouseId||defaultWarehouse()?.id||'';
    if(direct){
        const choices=(warehouseMasterCache||[]).filter(w=>w.active!==false&&w.systemCustody!==true&&w.warehouseType!=='CUSTODY'&&!String(w.id||'').startsWith('custody-'));
        const choice=prompt('供應商須確認改送公司倉庫及地址。\n'+choices.map((w,i)=>`${i+1}：${w.name||w.id}`).join('\n')+'\n輸入倉庫編號：');
        if(choice===null)return;
        warehouseId=choices[Number(choice)-1]?.id||'';
    }
    if(!warehouseId)return alert('請先設定收貨倉庫。');
    if(!confirm('供應商不同意取消：保留在途採購，實際到貨後轉為自由庫存。'+(direct?'供應商已確認改送所選倉庫？':'')))return;
    customerReturnActionsPending.add(id);
    try{
        await commitCancelledPurchaseKeepStock({supplyId:id,warehouseId,expectedDirect:direct});
        try{await loadActiveReceivingSupplyCache(true);renderPurchasingView();}catch(refreshError){markMainPageDirty('orders.po');showActionFeedback('採購處理已完成，請重新開啟採購頁更新清單。','warning');}
        showActionFeedback('已保留採購，到貨後轉庫存。','success');
    }catch(err){alert(actionFailureMessage('採購處理',err,id));}finally{customerReturnActionsPending.delete(id);}
};
window.saveReturnRecord=async function(){
    if(!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))return;
    if(document.getElementById('returnEditId').value)return alert('實收退貨紀錄不可由業務編輯，請由收貨人員處理。');
    const orderId=currentLifecycleOrderId,qty=Number(document.getElementById('returnQty').value),date=document.getElementById('returnDate').value;
    const reason=document.getElementById('returnReason').value.trim(),itemId=document.getElementById('returnItemId').value;
    if(!orderId||!itemId||!date||!(qty>0)||!Number.isFinite(qty))return alert('請選擇退貨品項、日期及大於零的數量。');
    if(customerReturnActionsPending.has(orderId))return;
    customerReturnActionsPending.add(orderId);const button=document.getElementById('returnSaveBtn');button.disabled=true;button.textContent='建立中…';
    // Retain an operation id on an uncertain response; retries cannot create a second request.
    const operationId=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());
    try{
        const saved=await commitCustomerReturnRequest({orderId,itemId,operationId,qty,date,reason});
        const index=ordersCache.findIndex(o=>o.id===orderId);if(index>=0)ordersCache[index]=saved;
        delete button.dataset.operationId;resetReturnForm();renderOrderLifecycleModal();renderOrdersList();renderCustomerReturnRequests(saved);
        showActionFeedback('已建立待收退貨；確認收貨前不增加庫存，不自動補送。','success');
    }catch(err){alert(actionFailureMessage('退貨申請',err,orderId));}finally{customerReturnActionsPending.delete(orderId);button.disabled=false;button.textContent='建立退貨申請';}
};
function renderCustomerReturnRequests(order){
    const target=document.getElementById('returnRequestsSummary');if(!target)return;
    target.innerHTML=(order.returnRequests||[]).map(r=>`<p>${escapeHtml(r.date)}｜${escapeHtml(normalizedOrderItems(order).find(i=>i.itemId===r.itemId)?.itemName||r.itemId)}｜申請 ${Number(r.qty)}／實收 ${Number(r.receivedQty||0)}｜${r.status==='PENDING'?'退貨待收貨':r.status==='CANCELLED'?'已撤回':'退貨結案'} ${r.status==='PENDING'&&canManageOrderLifecycleCapability()?`<button class="btn-secondary" onclick="withdrawCustomerReturn(${inlineJsValue(order.id)},${inlineJsValue(r.id)})">撤回未收數量</button>`:''}</p>`).join('');
}
const originalReturnModalRenderer=renderOrderLifecycleModal;
renderOrderLifecycleModal=function(){originalReturnModalRenderer();const order=ordersCache.find(o=>o.id===currentLifecycleOrderId);if(order)renderCustomerReturnRequests(order);};
window.withdrawCustomerReturn=async function(orderId,id){
    if(!canManageOrderLifecycleCapability()||!confirm('撤回尚未收到的退貨數量？已實收紀錄保留。'))return;
    try{await commitCustomerReturnWithdrawal({orderId,requestId:id});
    await refreshAffectedOrderCaches([orderId]);renderOrderLifecycleModal();}catch(err){alert(err.message);}
};
let customerReturnVisibleLimit=50;
let customerReturnQueueGeneration=0;
window.loadCustomerReturnQueue=async function(more=false){
    const target=document.getElementById('customerReturnQueue');if(!target)return;
    if(!canReceiveInventoryCapability()){target.textContent='退貨收貨由管理員、採購或倉管確認。';return;}
    target.textContent='載入待收退貨…';
    const recovery=globalThis.YUSHIN_V2_RETURN_RECEIPT_EMULATOR===true?customerReturnReceiptRecoveryHtml():'';
    if(recovery)target.innerHTML=recovery+'<p>載入待收退貨…</p>';
    const queueGeneration=++customerReturnQueueGeneration;
    const role=currentUserRole,uid=currentUser?.uid;
    const generation=typeof sessionDataGeneration==='number'?sessionDataGeneration:0;
    const current=()=>queueGeneration===customerReturnQueueGeneration&&role===currentUserRole&&uid===currentUser?.uid&&canReceiveInventoryCapability()
        &&generation===(typeof sessionDataGeneration==='number'?sessionDataGeneration:0);
    try{
        if(!more){
            customerReturnVisibleLimit=50;
            const rows=await readQueryInBatches(db.collection('orders').where('returnPending','==',true).orderBy(firebase.firestore.FieldPath.documentId()),200);
            if(!current())return;
            customerReturnOrders=rows;
        }else customerReturnVisibleLimit+=50;
        const requests=customerReturnOrders.flatMap(o=>(o.returnRequests||[]).filter(r=>r.status==='PENDING'&&Number(r.qty)>Number(r.receivedQty||0)).map(r=>({o,r})));
        const holds=await db.collection('customerReturnReceipts').where('disposition','==','HOLD').limit(50).get();
        if(!current())return;
        target.innerHTML=recovery+(requests.slice(0,customerReturnVisibleLimit).map(({o,r})=>{const item=normalizedOrderItems(o).find(i=>i.itemId===r.itemId);return `<div class="inventory-return-card"><strong>${escapeHtml(o.customerName||o.orderNo||o.id)}</strong><span>${escapeHtml(item?.itemName||r.itemId)}｜待收 ${Number(r.qty)-Number(r.receivedQty||0)}</span>${customerReturnNeedsLocationReceipt(o)?customerReturnReceiptQueueAction(o,r):`<button type="button" onclick="receiveCustomerReturn(${inlineJsValue(o.id)},${inlineJsValue(r.id)},this)">確認退貨收貨</button>`}</div>`;}).join('')||'<p>目前沒有待收退貨。</p>');
        if(requests.length>customerReturnVisibleLimit)target.innerHTML+='<button class="btn-secondary" onclick="loadCustomerReturnQueue(true)">載入更多待收退貨（50）</button>';
        target.innerHTML+='<h4>已實收・待檢／損壞商品（不計入待收數字）</h4>'+holds.docs.map(d=>{const r=d.data();return `<div class="inventory-return-card"><span>${escapeHtml(r.itemName||r.itemId)} × ${r.qty}｜${escapeHtml({INSPECTION:'待檢查',DAMAGED:'損壞'}[r.quality]||r.quality)}｜${escapeHtml(warehouseMasterCache.find(w=>w.id===r.warehouseId)?.warehouseName||r.warehouseId)}</span><button type="button" onclick="releaseCustomerReturnHold(${inlineJsValue(d.id)},this)">確認可再銷售・轉庫存</button></div>`;}).join('');
        if(holds.size===50)target.innerHTML+='<p>待檢商品僅顯示前 50 筆，請先處理目前清單。</p>';
        globalThis.inventoryReturnQueueUpdated?.();
    }catch(err){if(!current())return;target.textContent='退貨收貨載入失敗：'+err.message;if(recovery)target.innerHTML=recovery+'<p role="alert">'+escapeHtml('退貨收貨載入失敗：'+err.message)+'</p>';globalThis.inventoryReturnQueueUpdated?.(err.message);throw err;}
};

window.receiveCustomerReturn=async function(orderId,requestId,button){
    if(!canReceiveInventoryCapability()||customerReturnActionsPending.has(requestId))return;
    const order=customerReturnOrders.find(o=>o.id===orderId),request=order?.returnRequests?.find(r=>r.id===requestId);
    if(!request||!button)return;
    if(customerReturnNeedsLocationReceipt(order)){if(globalThis.YUSHIN_V2_RETURN_RECEIPT_EMULATOR===true)return openCustomerReturnReceipt(orderId,requestId);alert('此出貨來源的退貨收貨尚未開放，請保留待收申請。');return;}
    // Lock before prompting or awaiting the warehouse list: a second tap must not start another receipt.
    customerReturnActionsPending.add(requestId);button.disabled=true;
    try{
        const qtyInput=prompt(`待收 ${Number(request.qty)-Number(request.receivedQty||0)} 個。請輸入本次實收數量（可分批）：`);
        if(qtyInput===null)return;
        const qty=Number(qtyInput);
        if(!Number.isFinite(qty)||qty<=0){alert('實收數量須大於零。');return;}
        const qualityInput=prompt('商品狀況：\n1：可再銷售，增加可用庫存\n2：待檢查，分開保管\n3：損壞，分開保管\n輸入 1、2 或 3：');
        const quality={'1':'SALEABLE','2':'INSPECTION','3':'DAMAGED'}[qualityInput];
        if(!quality)return;
        await loadWarehouseMaster();
        const choices=warehouseMasterCache.filter(w=>w.active!==false&&w.systemCustody!==true&&w.warehouseType!=='CUSTODY'&&!String(w.id||'').startsWith('custody-'));
        const warehouseInput=prompt('請選擇實際收貨倉庫：\n'+choices.map((w,i)=>`${i+1}：${w.name||w.warehouseName||w.id}`).join('\n'));
        if(warehouseInput===null)return;
        const warehouseId=choices[Number(warehouseInput)-1]?.id;
        if(!warehouseId){alert('請選擇有效實體倉庫。');return;}
        const item=normalizedOrderItems(order).find(i=>i.itemId===request.itemId);
        if((item?.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'&&item?.warehouseId&&item.warehouseId!==warehouseId){
            alert('請先收到原出貨倉庫；入庫後再使用分倉移轉，避免原批次帳不一致。');return;
        }
        const receiptId=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());
        await commitCustomerReturnReceipt({orderId,requestId,receiptId,qty,quality,warehouseId});
        delete button.dataset.operationId;
        try{await refreshAffectedOrderCaches([orderId]);await loadCustomerReturnQueue();}catch(refreshError){showActionFeedback('退貨已收貨；清單更新失敗，請重新開啟倉庫頁。','warning');}
        markMainPageDirty('inventory','orders.list','orders.po','admin');
        showActionFeedback(quality==='SALEABLE'?'退貨已收貨並入庫，不補送。':'退貨已實收，列為不可用商品，請分開保管。','success');
    }catch(err){alert(actionFailureMessage('退貨收貨',err,requestId));}
    finally{customerReturnActionsPending.delete(requestId);if(button.isConnected)button.disabled=false;}
};
window.releaseCustomerReturnHold=async function(id,button){
    if(!canReceiveInventoryCapability()||customerReturnActionsPending.has(id))return;
    if(!confirm('已確認這批商品可再銷售？將從不可用商品移至可用庫存，不補送原客戶。'))return;
    customerReturnActionsPending.add(id);button.disabled=true;
    try{
        await commitCustomerReturnHoldRelease(id);
        markMainPageDirty('inventory','admin');await loadCustomerReturnQueue();showActionFeedback('已轉為可用庫存。','success');
    }catch(err){alert(actionFailureMessage('轉庫存',err,id));}finally{customerReturnActionsPending.delete(id);if(button.isConnected)button.disabled=false;}
};
window.editReturnRecord=function(){alert('實收退貨不可由業務修改，請由收貨人員確認。');};
window.deleteReturnRecord=function(){alert('實收退貨不可刪除；尚未收貨的申請可撤回。');};

function renderCustomerCancellationQueue(){
    const target=document.getElementById('customerCancellationQueue');if(!target)return;
    const rows=supplyReceivingCache.filter(s=>!isPurchaseTerminalStatus(s.status)&&s.customerCancellationDisposition!=='KEEP_STOCK'&&
      ((receivingSourceOrderStatusCache.get(s.orderId)||normalizedOrderStatus(ordersCache.find(o=>o.id===s.orderId)||{}))==='cancelled'));
    target.hidden=rows.length===0;
    target.innerHTML=rows.length?'<h3>客戶取消・採購待處理</h3>'+rows.map(s=>`<p>${escapeHtml(s.itemName||s.itemCode)}｜未到貨 ${Math.max(0,Number(s.qty)-Number(s.receivedQty||0))}｜${escapeHtml(s.purchaseDocumentNo||s.internalNo||'')} ${canCreatePurchaseOrderCapability()?customerCancellationActions(s):'請採購確認供應商答覆'}</p>`).join(''):'';
}
const originalPurchasingRenderer=renderPurchasingView;
renderPurchasingView=function(){originalPurchasingRenderer();renderCustomerCancellationQueue();};

