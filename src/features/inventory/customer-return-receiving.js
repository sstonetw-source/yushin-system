// The original receiving queue owns presentation; the receipt Service owns transmission.
let customerReturnReceiptView=null;
function customerReturnReceiptCurrent(view){
    if(!view||customerReturnReceiptView!==view||currentUser?.uid!==view.uid||currentUserRole!==view.role
        ||view.generation!==sessionDataGeneration||!canReceiveInventoryCapability())
        throw Error('登入身分或收貨畫面已變更，請重新開啟原操作。');
}
window.resetCustomerReturnReceiptView=function(){
    customerReturnReceiptView=null;
    document.getElementById('customerReturnReceiptOverlay')?.classList.remove('active');
    const body=document.getElementById('customerReturnReceiptBody');if(body)body.innerHTML='';
};
window.closeCustomerReturnReceipt=function(){
    if(customerReturnReceiptView?.busy)return;
    resetCustomerReturnReceiptView();
};
function customerReturnReceiptRecoveryHtml(){
    if(!canReceiveInventoryCapability())return '';
    const prefix='v2-return-receipt:'+encodeURIComponent(currentUser?.uid||'')+':';
    try{
        const rows=[];
        for(let i=0;i<sessionStorage.length;i++){
            const key=sessionStorage.key(i);if(!key?.startsWith(prefix))continue;
            const orderId=decodeURIComponent(key.slice(prefix.length));
            try{
                const saved=pendingV2CustomerReturnReceipt(orderId);if(!saved)continue;
                rows.push(`<div class="inventory-return-card"><strong>退貨收貨結果待確認</strong><span>${escapeHtml(orderId)}｜${escapeHtml(saved.intent.date)}｜原申請 ${escapeHtml(saved.intent.requestId)}</span><button type="button" data-return-recovery="${escapeAttr(orderId)}" onclick="openCustomerReturnReceipt(${inlineJsValue(orderId)})">確認前次退貨收貨結果</button></div>`);
            }catch(error){rows.push(`<p role="alert">${escapeHtml(orderId)}：${escapeHtml(error.message)}</p>`);}
        }
        return rows.join('');
    }catch(error){return `<p role="alert">無法讀取退貨待確認資料：${escapeHtml(error.message)}；請保留原分頁並先核對，勿重新收貨。</p>`;}
}
function customerReturnReceiptQueueAction(order,request){
    if(!customerReturnBackendEnabled())
        return '<span role="status">此出貨來源的退貨收貨尚未開放，申請保留待收。</span>';
    try{
        v2CustomerReturnTransport();
        if(pendingV2CustomerReturnReceipt(order.id))return '<span role="status">請先確認上方前次退貨收貨結果。</span>';
        return `<button type="button" onclick="receiveCustomerReturn(${inlineJsValue(order.id)},${inlineJsValue(request.id)},this)">確認退貨收貨</button>`;
    }catch(error){return `<span role="alert">${escapeHtml(error.message)}</span>`;}
}
window.openCustomerReturnReceipt=async function(orderId,requestId){
    let view;
    try{
        const {uid,role}=v2CustomerReturnTransport();
        if(customerReturnReceiptView?.busy)return;
        view={uid,role,generation:sessionDataGeneration,orderId,busy:false};customerReturnReceiptView=view;
        const pending=pendingV2CustomerReturnReceipt(orderId);
        if(pending){view.intent=pending.intent;renderCustomerReturnReceipt(view);return;}
        if(!requestId)throw Error('沒有待確認的退貨收貨。');
        const snap=await db.collection('orders').doc(orderId).get({source:'server'});customerReturnReceiptCurrent(view);
        if(!snap.exists)throw Error('找不到來源訂單。');
        view.order={...snap.data(),id:orderId};view.request=view.order.returnRequests?.find(r=>r.id===requestId);
        if(!view.request||view.request.status!=='PENDING')throw Error('退貨申請已撤回或完成，請重新載入。');
        view.projection=YushinFulfillment.projectOrderShipmentReturns({orderId,items:view.order.items,
            shipments:view.order.warehouseShipmentRecords||[],deliveries:view.order.deliveryRecords||[],returns:view.order.returnRecords||[]});
        view.shipments=view.projection.items.find(row=>row.itemId===view.request.itemId)?.shipments.filter(row=>row.confirmedQty>0)||[];
        if(!view.shipments.length)throw Error('此品項沒有已確認送達的出貨來源。');
        renderCustomerReturnReceipt(view);
    }catch(error){
        if(view&&customerReturnReceiptView!==view)return;
        if(view&&(view.uid!==currentUser?.uid||view.role!==currentUserRole||view.generation!==sessionDataGeneration))return;
        alert(error.message);
    }
};
function renderCustomerReturnReceipt(view){
    customerReturnReceiptCurrent(view);
    const body=document.getElementById('customerReturnReceiptBody'),pending=view.intent;
    if(pending){
        body.innerHTML=`<p>前次結果尚未確認，請以原資料核對。</p><p>訂單：${escapeHtml(pending.orderId)}<br>申請：${escapeHtml(pending.requestId)}<br>原出貨：${escapeHtml(pending.shipmentId)}<br>原倉：${escapeHtml(pending.warehouseId)}<br>日期：${escapeHtml(pending.date)}<br>原因：${escapeHtml(pending.reason)}</p><ul>${pending.selections.map(row=>`<li>批次 ${escapeHtml(row.lotId)}：${row.qty}</li>`).join('')}</ul>`;
    }else{
        body.innerHTML=`<p>${escapeHtml(view.order.customerName||view.order.orderNo||view.orderId)}｜申請 ${view.request.qty}／已收 ${view.request.receivedQty||0}</p><label for="customerReturnReceiptShipment">原出貨紀錄（收到原出貨倉）</label><select id="customerReturnReceiptShipment" onchange="changeCustomerReturnReceiptShipment()"><option value="">請選擇實際退回的出貨來源</option>${view.shipments.map(row=>{const source=view.order.warehouseShipmentRecords.find(s=>s.id===row.shipmentId);return `<option value="${escapeAttr(row.shipmentId)}">${escapeHtml(source.date)}｜${escapeHtml(source.warehouseId)}｜${escapeHtml(row.shipmentId)}</option>`;}).join('')}</select><div id="customerReturnReceiptLots"></div><label for="customerReturnReceiptDate">實收日期</label><input id="customerReturnReceiptDate" type="date" value="${escapeAttr(localDateString())}"><label for="customerReturnReceiptReason">退貨原因</label><textarea id="customerReturnReceiptReason" maxlength="1000">${escapeHtml(view.request.reason||'訂錯貨，退貨結案')}</textarea><label><input id="customerReturnReceiptSaleable" type="checkbox">已確認可再銷售，入庫後結案，不自動補送</label>`;
    }
    document.getElementById('customerReturnReceiptStatus').textContent='';
    const button=document.getElementById('customerReturnReceiptSave');button.disabled=false;button.textContent=pending?'確認前次退貨收貨結果':'確認實收並入庫';
    document.getElementById('customerReturnReceiptOverlay').classList.add('active');
}
window.changeCustomerReturnReceiptShipment=function(){
    const view=customerReturnReceiptView;
    try{
        customerReturnReceiptCurrent(view);if(view.busy||view.intent)return;
        const id=document.getElementById('customerReturnReceiptShipment').value;
        view.shipment=view.order.warehouseShipmentRecords.find(row=>row.id===id&&row.itemId===view.request.itemId);
        view.lots=view.shipment?YushinInventory.availableReturnAllocations([view.shipment],(view.order.returnRecords||[]).filter(row=>row.shipmentId===id)).filter(row=>row.qty>0):[];
        document.getElementById('customerReturnReceiptLots').innerHTML=view.lots.map((row,index)=>`<div class="inventory-return-card"><label for="customerReturnReceiptLot${index}">批號 ${escapeHtml(row.lotNo||row.lotId)}｜效期 ${escapeHtml(row.expiryDate||'未填')}｜原批次餘額 ${row.qty}</label><input id="customerReturnReceiptLot${index}" type="number" min="0" max="${row.qty}" step="1" value="0" aria-label="${escapeAttr('批號 '+(row.lotNo||row.lotId)+' 本次實收數量')}"></div>`).join('')||(view.shipment?'<p>此出貨沒有可退回的原批次。</p>':'');
    }catch(error){document.getElementById('customerReturnReceiptStatus').textContent=error.message;}
};
window.saveCustomerReturnReceipt=async function(){
    const view=customerReturnReceiptView;if(!view||view.busy||view.confirmed)return;
    const status=document.getElementById('customerReturnReceiptStatus'),button=document.getElementById('customerReturnReceiptSave');
    try{
        customerReturnReceiptCurrent(view);
        if(!view.intent){
            if(!view.shipment||!document.getElementById('customerReturnReceiptSaleable').checked)throw Error('請選擇原出貨及批次，並確認商品可再銷售。');
            const selections=(view.lots||[]).map((row,i)=>({lotId:row.lotId,qty:Number(document.getElementById('customerReturnReceiptLot'+i).value)}));
            if(selections.some(row=>!Number.isSafeInteger(row.qty)||row.qty<0))throw Error('實收數量須為非負整數。');
            const selected=selections.filter(row=>row.qty>0);
            const part=view.shipments.find(row=>row.shipmentId===view.shipment.id);
            const plan=YushinInventory.planExplicitShipmentReturn({shipment:view.shipment,confirmedQty:part.confirmedQty,selections:selected,
                priorReturns:(view.order.returnRecords||[]).filter(row=>row.shipmentId===view.shipment.id)});
            if(plan.returnQty>view.request.qty-Number(view.request.receivedQty||0))throw Error('本次實收數量超過申請待收量。');
            const intent=normalizeV2CustomerReturnReceipt({orderId:view.orderId,itemId:view.request.itemId,requestId:view.request.id,
                shipmentId:view.shipment.id,warehouseId:view.shipment.warehouseId,syncAttemptId:view.order.inventoryReservationAttemptId,
                selections:selected,operationId:lifecycleRecordId(),date:document.getElementById('customerReturnReceiptDate').value,
                reason:document.getElementById('customerReturnReceiptReason').value,condition:'RESTOCKABLE',settlement:'CLOSE'});
            // Freeze the visible form too; the Service persists before sending.
            view.intent=intent;renderCustomerReturnReceipt(view);
        }
        view.busy=true;button.disabled=true;status.textContent='正在確認退貨收貨…';
        const saved=await receiveV2CustomerReturnEmulator(view.orderId,view.intent);customerReturnReceiptCurrent(view);
        view.confirmed=true;
        // The receipt has been confirmed; refresh failures cannot turn it into an unknown commit.
        status.textContent='退貨已實收並入庫，不補送。';
        const item=saved.items.find(row=>row.itemId===view.intent.itemId);
        invalidateWarehouseStockCache(item.inventoryProductKey||item.productId,view.intent.warehouseId);markMainPageDirty('inventory','orders.list','orders.po','admin');
        try{
            await refreshAffectedOrderCaches([saved.id]);customerReturnReceiptCurrent(view);
            await loadCustomerReturnQueue();customerReturnReceiptCurrent(view);
            view.busy=false;closeCustomerReturnReceipt();showActionFeedback('退貨已實收並入庫，不補送。','success');
        }catch(refreshError){
            customerReturnReceiptCurrent(view);view.confirmed=true;
            status.textContent='退貨已實收並入庫；清單更新失敗，請關閉後重新開啟倉庫頁。';
        }
    }catch(error){
        if(customerReturnReceiptView!==view||view.uid!==currentUser?.uid||view.role!==currentUserRole||view.generation!==sessionDataGeneration)return;
        status.textContent=view.confirmed?'退貨已實收並入庫；畫面更新失敗，請關閉後重新開啟倉庫頁。':error.message+'；若結果尚未確認，請使用原資料再次確認。';
    }finally{
        if(customerReturnReceiptView===view){view.busy=false;button.disabled=!!view.confirmed;
            button.textContent=view.intent?'確認前次退貨收貨結果':'確認實收並入庫';}
    }
};
