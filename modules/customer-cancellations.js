/* Customer cancellation and return receiving use live transactions, never optimistic stock writes. */
const customerReturnActionsPending = new Set();
let customerReturnOrders = [];
let customerReturnHasMore = false;
let customerReturnCursor = null;
function customerReturnPendingQty(order, itemId, excludeId='') {
    return (order.returnRequests||[]).filter(r=>r.itemId===itemId && r.id!==excludeId && r.status==='PENDING')
        .reduce((sum,r)=>sum+Math.max(0,Number(r.qty)-Number(r.receivedQty||0)),0);
}
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
        const choices=(warehouseMasterCache||[]).filter(w=>w.active!==false);
        const choice=prompt('供應商須確認改送公司倉庫及地址。\n'+choices.map((w,i)=>`${i+1}：${w.name||w.id}`).join('\n')+'\n輸入倉庫編號：');
        if(choice===null)return;
        warehouseId=choices[Number(choice)-1]?.id||'';
    }
    if(!warehouseId)return alert('請先設定收貨倉庫。');
    if(!confirm('供應商不同意取消：保留在途採購，實際到貨後轉為自由庫存。'+(direct?'供應商已確認改送所選倉庫？':'')))return;
    customerReturnActionsPending.add(id);
    try{
        let saved;
        await runRoleTransaction(async tx=>{
            const ref=supplyOrdersCollection().doc(id),snap=await tx.get(ref);
            if(!snap.exists)throw new Error('找不到採購品項。');
            const supply={id,...snap.data()};
            const orderSnap=await tx.get(db.collection('orders').doc(supply.orderId));
            if(!orderSnap.exists||normalizedOrderStatus(orderSnap.data())==='normal')throw new Error('客戶訂單未取消，請重新確認。');
            if(isPurchaseTerminalStatus(supply.status))throw new Error('採購已取消／結案。');
            if(supply.customerCancellationDisposition==='KEEP_STOCK')return;
            const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
            if(!remaining)throw new Error('此品項已全部到貨。');
            const key=String(supply.productKey||supply.productId||'');
            const redirect=supply.fulfillmentType==='DIRECT_SHIP';
            if(redirect!==direct)throw new Error('採購收貨方式已變更，請更新清單後重新確認。');
            const invRef=redirect?db.collection('inventory').doc(encodeURIComponent(key)):null;
            const whRef=redirect?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key)):null;
            const invSnap=invRef?await tx.get(invRef):null,whSnap=whRef?await tx.get(whRef):null;
            if(redirect&&!key)throw new Error('缺少產品識別碼。');
            const now=new Date().toISOString();
            const patch={customerCancellationDisposition:'KEEP_STOCK',customerCancellationResolvedAt:now,customerCancellationResolvedBy:currentUser.uid,updatedAt:now};
            if(redirect){
                Object.assign(patch,{originalFulfillmentType:'DIRECT_SHIP',fulfillmentType:'WAREHOUSE',warehouseId,redirectInventoryId:encodeURIComponent(key),redirectWarehouseStockId:warehouseStockDocId(warehouseId,key),incomingRegisteredQty:remaining});
                const info={productKey:key,productId:supply.productId||key,itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',updatedAt:now};
                tx.set(invRef,{...info,incoming:Number(invSnap?.data()?.incoming||0)+remaining},{merge:true});
                tx.set(whRef,{...info,warehouseId,incoming:Number(whSnap?.data()?.incoming||0)+remaining},{merge:true});
                tx.set(db.collection('inventoryMovements').doc('redirect-'+id),{type:'cancelled_direct_ship_redirect',qty:remaining,productKey:key,warehouseId,sourceType:'SUPPLY_ORDER',sourceId:id,createdAt:now,createdBy:deliveryActor()});
            }
            tx.update(ref,patch);saved={...supply,...patch};
            // runRoleTransaction mirrors supply changes to the receiving view atomically.
        });
        try{await loadActiveReceivingSupplyCache(true);renderPurchasingView();}catch(refreshError){markMainPageDirty('orders.po');showActionFeedback('採購處理已完成，請重新開啟採購頁更新清單。','warning');}
        showActionFeedback('已保留採購，到貨後轉庫存。','success');
    }catch(err){alert('採購處理失敗：'+err.message);}finally{customerReturnActionsPending.delete(id);}
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
        let saved;
        await runRoleTransaction(async tx=>{
            const ref=db.collection('orders').doc(orderId),snap=await tx.get(ref);
            if(!snap.exists)throw new Error('找不到訂單。');const order={id:orderId,...snap.data()};
            const requests=[...(order.returnRequests||[])];if(requests.some(r=>r.id===operationId)){saved=order;return;}
            const item=normalizedOrderItems(order).find(i=>i.itemId===itemId);if(!item)throw new Error('找不到原送貨品項。');
            const allowed=returnItemDeliveredQty(order,itemId)-returnItemReturnedQty(order,itemId)-customerReturnPendingQty(order,itemId);
            if(requests.length>=30)throw new Error('每張訂單最多 30 次退貨申請，請先處理既有申請。');
            if(qty>allowed+1e-9)throw new Error(`最多可申請 ${Math.max(0,allowed)} 個；已扣除其他待收退貨。`);
            const now=new Date().toISOString(),record={id:operationId,itemId,qty,receivedQty:0,date,reason,status:'PENDING',settlement:'CLOSE',createdAt:now,createdBy:deliveryActor(),createdByUid:currentUser.uid};
            requests.push(record);const patch={returnRequests:requests,returnPending:true,returnRequestMutationIndex:requests.length-1,updatedAt:now};
            tx.update(ref,patch);saved={...order,...patch};
        });
        const index=ordersCache.findIndex(o=>o.id===orderId);if(index>=0)ordersCache[index]=saved;
        delete button.dataset.operationId;resetReturnForm();renderOrderLifecycleModal();renderOrdersList();renderCustomerReturnRequests(saved);
        showActionFeedback('已建立待收退貨；確認收貨前不增加庫存，不自動補送。','success');
    }catch(err){alert('退貨申請失敗：'+err.message);}finally{customerReturnActionsPending.delete(orderId);button.disabled=false;button.textContent='建立退貨申請';}
};
function renderCustomerReturnRequests(order){
    const target=document.getElementById('returnRequestsSummary');if(!target)return;
    target.innerHTML=(order.returnRequests||[]).map(r=>`<p>${escapeHtml(r.date)}｜${escapeHtml(normalizedOrderItems(order).find(i=>i.itemId===r.itemId)?.itemName||r.itemId)}｜申請 ${Number(r.qty)}／實收 ${Number(r.receivedQty||0)}｜${r.status==='PENDING'?'退貨待收貨':r.status==='CANCELLED'?'已撤回':'退貨結案'} ${r.status==='PENDING'&&canManageOrderLifecycleCapability()?`<button class="btn-secondary" onclick="withdrawCustomerReturn(${inlineJsValue(order.id)},${inlineJsValue(r.id)})">撤回未收數量</button>`:''}</p>`).join('');
}
const originalReturnModalRenderer=renderOrderLifecycleModal;
renderOrderLifecycleModal=function(){originalReturnModalRenderer();const order=ordersCache.find(o=>o.id===currentLifecycleOrderId);if(order)renderCustomerReturnRequests(order);};
window.withdrawCustomerReturn=async function(orderId,id){
    if(!canManageOrderLifecycleCapability()||!confirm('撤回尚未收到的退貨數量？已實收紀錄保留。'))return;
    try{await runRoleTransaction(async tx=>{const ref=db.collection('orders').doc(orderId),snap=await tx.get(ref);const order=snap.data();const requests=(order.returnRequests||[]).map(r=>r.id===id&&r.status==='PENDING'?{...r,status:'CANCELLED',cancelledAt:new Date().toISOString(),cancelledBy:currentUser.uid}:r);tx.update(ref,{returnRequests:requests,returnPending:requests.some(r=>r.status==='PENDING'),returnRequestMutationIndex:requests.findIndex(r=>r.id===id),updatedAt:new Date().toISOString()});});
    await refreshAffectedOrderCaches([orderId]);renderOrderLifecycleModal();}catch(err){alert(err.message);}
};
window.loadCustomerReturnQueue=async function(more=false){
    const target=document.getElementById('customerReturnQueue');if(!target)return;
    if(!canReceiveInventoryCapability()){target.textContent='退貨收貨由管理員、採購或倉管確認。';return;}
    target.textContent='載入待收退貨…';
    try{
        let query=db.collection('orders').where('returnPending','==',true).limit(50);
        if(more&&customerReturnCursor)query=query.startAfter(customerReturnCursor);
        const snap=await query.get();customerReturnCursor=snap.docs.at(-1)||null;customerReturnHasMore=snap.size===50;
        const rows=snap.docs.map(d=>({id:d.id,...d.data()}));customerReturnOrders=more?[...customerReturnOrders,...rows]:rows;
        const holds=await db.collection('customerReturnReceipts').where('disposition','==','HOLD').limit(50).get();
        target.innerHTML=customerReturnOrders.flatMap(o=>(o.returnRequests||[]).filter(r=>r.status==='PENDING').map(r=>{const item=normalizedOrderItems(o).find(i=>i.itemId===r.itemId);return `<p><strong>${escapeHtml(o.customerName||o.orderNo||o.id)}</strong>｜${escapeHtml(item?.itemName||r.itemId)}｜待收 ${Number(r.qty)-Number(r.receivedQty||0)} <button onclick="receiveCustomerReturn(${inlineJsValue(o.id)},${inlineJsValue(r.id)},this)">確認退貨收貨</button></p>`;})).join('')||'<p>目前沒有待收退貨。</p>';
        if(customerReturnHasMore)target.innerHTML+='<button class="btn-secondary" onclick="loadCustomerReturnQueue(true)">載入更多待收退貨</button>';
        target.innerHTML+='<h4>已實收・不可用商品（分開保管）</h4>'+holds.docs.map(d=>{const r=d.data();return `<p>${escapeHtml(r.itemName||r.itemId)} × ${r.qty}｜${escapeHtml({INSPECTION:'待檢查',DAMAGED:'損壞'}[r.quality]||r.quality)}｜${escapeHtml(warehouseMasterCache.find(w=>w.id===r.warehouseId)?.name||r.warehouseId)} <button onclick="releaseCustomerReturnHold(${inlineJsValue(d.id)},this)">確認可再銷售・轉庫存</button></p>`;}).join('');
        if(holds.size===50)target.innerHTML+='<p>待檢商品僅顯示前 50 筆，請先處理目前清單。</p>';
    }catch(err){target.textContent='退貨收貨載入失敗：'+err.message;}
};
async function postCustomerReturnStock(tx,order,item,qty,receiptId,warehouseId){
    const itemDeliveries=savedDeliveryRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
    const itemReturns=savedReturnRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
    if((item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
        // Settlement returns are free stock; never reserve them for the original customer.
        return applyInventoryReturnDeltaInTransaction(tx,{...order,...item,customerReturnSettlement:'CLOSE',warehouseId,itemId:item.itemId,deliveryRecords:itemDeliveries,returnRecords:itemReturns},qty,deliveryActor(),order.id,null);
    }
    const supplyId=(item.receiptEvents||[]).find(e=>e.fulfillmentType==='DIRECT_SHIP'&&e.sourceId)?.sourceId;
    if(!supplyId)throw new Error('直送退貨缺少原採購來源，請先以「待檢」收貨，補齊原採購來源後再转庫存。');
    const supplySnap=await tx.get(db.collection('receivingSupplyOrders').doc(supplyId));
    if(!supplySnap.exists)throw new Error('找不到原直送採購資料，請先以待檢收貨。');
    const key=inventoryProductKey(item),invRef=db.collection('inventory').doc(encodeURIComponent(key)),whRef=db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key));
    const invSnap=await tx.get(invRef),whSnap=await tx.get(whRef),lotRef=db.collection('inventoryLots').doc('return-'+receiptId);
    const now=new Date().toISOString(),info={productKey:key,productId:item.productId||key,itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',updatedAt:now};
    tx.set(invRef,{...info,onHand:Number(invSnap.data()?.onHand||0)+qty},{merge:true});
    tx.set(whRef,{...info,warehouseId,onHand:Number(whSnap.data()?.onHand||0)+qty},{merge:true});
    tx.set(lotRef,{...info,warehouseId,qty,remainingQty:qty,sourceType:'SUPPLY_ORDER',sourceId:supplyId,returnReceiptId:receiptId,receivedAt:now,createdAt:now,lotNo:'退貨-'+receiptId});
    tx.set(db.collection('inventoryLotCosts').doc(lotRef.id),{lotId:lotRef.id,productKey:key,warehouseId,costSourceSupplyId:supplyId,sourceType:'SUPPLY_ORDER',sourceId:supplyId,createdAt:now});
    tx.set(db.collection('inventoryMovements').doc('return-'+receiptId),{type:'customer_return_received',qty,productKey:key,warehouseId,sourceType:'ORDER',sourceId:order.id,returnReceiptId:receiptId,createdAt:now,createdBy:deliveryActor()});
    return {lotAllocations:[{lotId:lotRef.id,qty}],newReservedQty:Number(item.reservedQty||0)};
}
window.receiveCustomerReturn=async function(orderId,requestId,button){
    if(!canReceiveInventoryCapability()||customerReturnActionsPending.has(requestId))return;
    const order=customerReturnOrders.find(o=>o.id===orderId),request=order?.returnRequests?.find(r=>r.id===requestId);
    if(!request)return;
    const qtyInput=prompt(`待收 ${Number(request.qty)-Number(request.receivedQty||0)} 個。請輸入本次實收數量（可分批）：`);
    if(qtyInput===null)return;const qty=Number(qtyInput);
    if(!Number.isFinite(qty)||qty<=0)return alert('實收數量須大於零。');
    const qualityInput=prompt('商品狀況：\n1：可再銷售，增加可用庫存\n2：待檢查，分開保管\n3：損壞，分開保管\n輸入 1、2 或 3：');
    const quality={'1':'SALEABLE','2':'INSPECTION','3':'DAMAGED'}[qualityInput];if(!quality)return;
    await loadWarehouseMaster();const choices=warehouseMasterCache.filter(w=>w.active!==false);
    const warehouseInput=prompt('請選擇實際收貨倉庫：\n'+choices.map((w,i)=>`${i+1}：${w.name||w.id}`).join('\n'));
    if(warehouseInput===null)return;const warehouseId=choices[Number(warehouseInput)-1]?.id;
    if(!warehouseId)return alert('請選擇有效倉庫。');
    const item=normalizedOrderItems(order).find(i=>i.itemId===request.itemId);
    if(item?.fulfillmentType!=='DIRECT_SHIP'&&item?.warehouseId&&item.warehouseId!==warehouseId)return alert('請先收到原出貨倉庫；入庫後再使用分倉移轉，避免原批次帳不一致。');
    const receiptId=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());
    customerReturnActionsPending.add(requestId);button.disabled=true;
    try{
        await commitCustomerReturnReceipt({orderId,requestId,receiptId,qty,quality,warehouseId});
        delete button.dataset.operationId;
        try{await refreshAffectedOrderCaches([orderId]);await loadCustomerReturnQueue();}catch(refreshError){showActionFeedback('退貨已收貨；清單更新失敗，請重新開啟庫存頁。','warning');}
        markMainPageDirty('inventory','orders.list','orders.po','admin');
        showActionFeedback(quality==='SALEABLE'?'退貨已收貨並入庫，不補送。':'退貨已實收，列為不可用商品，請分開保管。','success');
    }catch(err){alert('退貨收貨失敗：'+err.message);}finally{customerReturnActionsPending.delete(requestId);if(button.isConnected)button.disabled=false;}
};
async function commitCustomerReturnReceipt({orderId,requestId,receiptId,qty,quality,warehouseId}){
    if(!canReceiveInventoryCapability())throw new Error('無收貨權限。');
    await runRoleTransaction(async tx=>{
        const receiptRef=db.collection('customerReturnReceipts').doc(receiptId),orderRef=db.collection('orders').doc(orderId);
        const receiptSnap=await tx.get(receiptRef),orderSnap=await tx.get(orderRef);
        if(receiptSnap.exists)return; // Network retry is idempotent.
        if(!orderSnap.exists)throw new Error('來源訂單已不存在。');
        const order={id:orderId,...orderSnap.data()},requests=[...(order.returnRequests||[])],index=requests.findIndex(r=>r.id===requestId);
        if(index<0||requests[index].status!=='PENDING')throw new Error('退貨申請已撤回或完成。');
        const request=requests[index],remaining=Number(request.qty)-Number(request.receivedQty||0);
        if(!Number.isFinite(qty)||qty<=0||qty>remaining+1e-9)throw new Error(`實收數量不可超過 ${remaining}。`);
        const item=normalizedOrderItems(order).find(i=>i.itemId===request.itemId);if(!item)throw new Error('找不到退貨品項。');
        if(returnItemReturnedQty(order,item.itemId)+qty>returnItemDeliveredQty(order,item.itemId)+1e-9)throw new Error('累計實收退貨超過已送貨數量。');
        if(!['SALEABLE','INSPECTION','DAMAGED'].includes(quality)||!warehouseId)throw new Error('收貨狀況或倉庫無效。');
        let result={lotAllocations:[]};
        if(quality==='SALEABLE')result=await postCustomerReturnStock(tx,order,item,qty,receiptId,warehouseId);
        else if(item.fulfillmentType!=='DIRECT_SHIP'){
            const deliveries=savedDeliveryRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
            const returns=savedReturnRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
            const available=YushinInventory.availableReturnAllocations(deliveries,returns);
            result.lotAllocations=YushinInventory.reverseLotAllocations([{qty:available.reduce((s,r)=>s+Number(r.qty||0),0),lotAllocations:available}],qty).allocations;
        }
        const now=new Date().toISOString(),record={id:receiptId,requestId,itemId:item.itemId,date:localDateString(),qty,reason:request.reason||'',settlement:'CLOSE',quality,warehouseId,createdAt:now,createdBy:deliveryActor(),lotAllocations:result.lotAllocations||[]};
        requests[index]={...request,receivedQty:Number(request.receivedQty||0)+qty,status:qty>=remaining?'RECEIVED':'PENDING'};
        const records=[...savedReturnRecords(order),record],patch={returnRequests:requests,returnPending:requests.some(r=>r.status==='PENDING'),returnRecords:records,returnedQty:records.reduce((s,r)=>s+Number(r.qty||0),0),returnReceiptId:receiptId,updatedAt:now};
        if(result.newReservedQty!==undefined)patch.items=order.items.map(i=>i.itemId===item.itemId?{...i,reservedQty:result.newReservedQty}:i);
        Object.assign(patch,orderWorkIndexFields({...order,...patch}));
        tx.set(receiptRef,{orderId,requestId,requestIndex:index,qty,quality,warehouseId,itemId:item.itemId,itemName:item.itemName||'',ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',disposition:quality==='SALEABLE'?'STOCK':'HOLD',record,createdAt:now,receivedBy:currentUser.uid});
        tx.update(orderRef,patch);
    });
}
window.releaseCustomerReturnHold=async function(id,button){
    if(!canReceiveInventoryCapability()||customerReturnActionsPending.has(id))return;
    if(!confirm('已確認這批商品可再銷售？將從不可用商品移至可用庫存，不補送原客戶。'))return;
    customerReturnActionsPending.add(id);button.disabled=true;
    try{
        await runRoleTransaction(async tx=>{
            const receiptRef=db.collection('customerReturnReceipts').doc(id),snap=await tx.get(receiptRef);
            if(!snap.exists)throw new Error('找不到退貨收貨紀錄。');const receipt=snap.data();if(receipt.disposition!=='HOLD')return;
            const orderRef=db.collection('orders').doc(receipt.orderId),orderSnap=await tx.get(orderRef);if(!orderSnap.exists)throw new Error('原訂單已不存在。');
            const order={id:receipt.orderId,...orderSnap.data()},item=normalizedOrderItems(order).find(i=>i.itemId===receipt.itemId);
            const record=savedReturnRecords(order).find(r=>r.id===id);if(!item||!record)throw new Error('找不到原退貨品項或紀錄。');
            await postCustomerReturnStock(tx,{...order,returnRecords:savedReturnRecords(order).filter(r=>r.id!==id)},item,Number(receipt.qty),id,receipt.warehouseId);
            tx.update(receiptRef,{disposition:'STOCK',releasedAt:new Date().toISOString(),releasedBy:currentUser.uid});
        });
        markMainPageDirty('inventory','admin');await loadCustomerReturnQueue();showActionFeedback('已轉為可用庫存。','success');
    }catch(err){alert('轉庫存失敗：'+err.message);}finally{customerReturnActionsPending.delete(id);if(button.isConnected)button.disabled=false;}
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
