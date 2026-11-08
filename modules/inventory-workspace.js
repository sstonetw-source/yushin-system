/* Inventory work uses existing supply/order evidence; exported lists never post stock. */
(function(root){
  function purchaseRows(supplies){
    const seen=new Set();
    return (supplies||[]).filter(s=>{
      if(!s.id||seen.has(s.id)||!['ORDERED','PARTIAL_RECEIPT'].includes(s.status)||(s.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')return false;
      seen.add(s.id);return Number(s.qty)>Number(s.receivedQty||0);
    });
  }
  function returnRows(orders){
    return (orders||[]).flatMap(order=>(order.returnRequests||[])
      .filter(r=>r.status==='PENDING'&&Number(r.qty)>Number(r.receivedQty||0))
      .map(request=>({order,request,remaining:Number(request.qty)-Number(request.receivedQty||0)})));
  }
  function shippingRows(orders,warehouses,mainId,helpers){
    const seen=new Set(),rows=[];
    for(const order of orders||[]){
      if(seen.has(order.id)||helpers.status(order)!=='normal'||helpers.incomplete(order))continue;
      seen.add(order.id);
      for(const item of helpers.items(order)){
        if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')continue;
        const state=helpers.dispatch(order,item);
        const prior=helpers.pending?.(order.id,item.itemId)||null;
        if(!(state.shippable>0)&&!prior)continue;
        const positions=prior?null:helpers.locations?.(order,item);
        if(!prior&&positions===null)continue;
        const sources=prior?[{warehouseId:prior.warehouseId,qty:prior.quantity}]:Array.isArray(positions)?positions:
          [{warehouseId:item.warehouseId||order.warehouseId||mainId||'',qty:state.shippable}];
        for(const source of sources){
          const warehouseId=source.warehouseId,warehouse=warehouses.find(w=>w.id===warehouseId&&w.active!==false);
          if((warehouse?.systemCustody&&!helpers.includeCustody)||item.transferPendingId||!warehouse)continue;
          const qty=prior?prior.quantity:Math.min(state.shippable,source.qty);
          if(!(qty>0))continue;
          const located=Array.isArray(positions)||(!!prior&&!!helpers.locations);
          rows.push({order,item,qty,priorShipment:prior,warehouseId,warehouse,located,
            branch:warehouseId!==mainId,key:order.id+'__'+item.itemId+(located?'__'+warehouseId:'')});
        }
      }
    }
    return rows;
  }
  const api={purchaseRows,returnRows,shippingRows};root.YushinInventoryWorkspace=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;

  let view='stock',receivingKind='purchase',shippingKind='main';
  let returnReady=false,returnError='',loadPromise=null;
  let warehouseError='',workspaceContext='';
  const shipmentPending=new Set();
  function el(id){return document.getElementById(id);}
  function currentShippingRows(){
    return shippingRows(orderWorkQueueCache,warehouseMasterCache,defaultWarehouse()?.id||'',{
      status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState,locations:root.v2WarehouseShipmentLocations,
      pending:(orderId,itemId)=>typeof pendingV2WarehouseShipment==='function'?pendingV2WarehouseShipment(orderId,itemId):null
    });
  }
  function updateBadges(){
    const operational=canReceiveInventoryCapability();
    if(el('inventoryShippingTabBtn'))el('inventoryShippingTabBtn').style.display=operational?'':'none';
    const receive=el('inventoryReceivingTabBtn'),ship=el('inventoryShippingTabBtn');
    if(receive){
      const error=activeReceivingSupplyError||returnError||root.warehouseTransferQueueState?.().error;
      const transferState=root.warehouseTransferQueueState?.();
      const ready=activeReceivingSupplyReady&&returnReady&&(!transferState||transferState.ready);
      const transferCount=transferState?.count||0;
      receive.textContent=error?'收貨（—）':!ready?'收貨（…）':`收貨（${purchaseRows(supplyReceivingCache).length+returnRows(customerReturnOrders).length+transferCount}）`;
      receive.title=error?'部分收貨資料讀取失敗':!ready?'收貨資料讀取中':'';
    }
    if(ship){
      const transfers=root.mainTransferParcelEntries?.();
      const count=currentShippingRows().filter(r=>['CUSTOMER_SHIP','SALES_SHIP'].includes(root.YushinWarehouseLogistics.plan(r.item.deliveryPlan||r.order.shippingInstructions||{}).mode)).length+(transfers?.entries.length||0);
      ship.textContent=orderWorkQueueError||transfers?.error?'寄貨（—）':!orderWorkQueueReady||transfers&&!transfers.ready?'寄貨（…）':`寄貨（${count}）`;
    }
    renderWorkCards();
    renderWorkspaceErrors();
    if(!operational&&view!=='stock')switchInventoryWorkView('stock');
  }
  function renderWorkCards(){
    const counts={purchase:activeReceivingSupplyError?'—':!activeReceivingSupplyReady?'…':purchaseRows(supplyReceivingCache).length,
      returns:returnError?'—':!returnReady?'…':returnRows(customerReturnOrders).length};
    document.querySelectorAll('[data-inventory-receiving-kind]').forEach(button=>{
      const kind=button.dataset.inventoryReceivingKind;
      button.innerHTML=`<span>${kind==='purchase'?'採購收貨':'退貨收貨'}</span><strong>${counts[kind]}${typeof counts[kind]==='number'?' 筆':''}</strong>`;
      button.classList.toggle('active',kind===receivingKind);
      button.setAttribute('aria-pressed',String(kind===receivingKind));
    });
  }
  function renderWorkspaceErrors(){
    const receiving=el('inventoryReceivingError'),shipping=el('inventoryShippingError');
    const receiveError=receivingKind==='purchase'?activeReceivingSupplyError:receivingKind==='transfers'?root.warehouseTransferQueueState?.().error:returnError;
    if(receiving){
      receiving.hidden=!receiveError&&!warehouseError;
      receiving.innerHTML=receiving.hidden?'':`${escapeHtml(receiveError||warehouseError)}<br><button type="button" class="btn-secondary" onclick="retryInventoryWorkspace(this)">重試收貨資料</button>`;
    }
    if(shipping){
      shipping.hidden=!orderWorkQueueError&&!warehouseError;
      shipping.innerHTML=shipping.hidden?'':`${escapeHtml(orderWorkQueueError||warehouseError)}<br><button type="button" class="btn-secondary" onclick="retryInventoryWorkspace(this)">重試寄貨資料</button>`;
    }
  }
  root.retryInventoryWorkspace=async function(button){
    const state=beginActionButton(button,'讀取中…');
    try{await loadInventoryWorkspace(true);}finally{endActionButton(button,state);}
  };
  root.updateInventoryWorkspaceBadges=updateBadges;
  root.renderInventoryPurchaseReceiving=function(){
    const body=el('inventoryReceivingBody');if(!body)return;
    const rows=purchaseRows(supplyReceivingCache).sort((a,b)=>String(a.supplierName||a.supplier||'').localeCompare(String(b.supplierName||b.supplier||''),'zh-Hant')||String(a.purchaseDocumentNo||a.purchaseOrderNo||'').localeCompare(String(b.purchaseDocumentNo||b.purchaseOrderNo||'')));
    const empty=rows.length===0&&activeReceivingSupplyReady&&!activeReceivingSupplyError;const table=body.closest?.('.inventory-work-table');if(table)table.hidden=empty;
    el('inventoryReceivingHead').innerHTML='<th>品項</th><th>收貨資訊</th><th>待收數量</th><th>操作</th>';
    body.innerHTML=rows.slice(0,50).map(s=>{
      const wh=warehouseMasterCache.find(w=>w.id===s.warehouseId);
      const source=receivingSourceOrderForItem(s);
      const canReceive=(source?normalizedOrderStatus(source)==='normal':true)||s.customerCancellationDisposition==='KEEP_STOCK'||(s.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP';
      const remaining=Number(s.qty)-Number(s.receivedQty||0),costVisible=currentUserRole==='admin'||currentUserRole==='purchaser';
      const costKnown=s.unitCost!==undefined&&s.unitCost!==null&&Number.isFinite(Number(s.unitCost));
      const amount=costVisible?(costKnown?`NT$${Number(s.unitCost).toLocaleString()}／NT$${(remaining*Number(s.unitCost)).toLocaleString()}`:'成本待確認'):'依權限不顯示成本';
      const sourceLabel=s.customerCancellationDisposition==='KEEP_STOCK'?'取消訂單轉備貨':s.orderId?'業務訂單':'備貨';
      return `<tr class="warehouse-task-row">
        <td class="warehouse-task-item" data-th="品項"><strong>${escapeHtml(s.itemCode||'')}</strong><span>${escapeHtml(s.itemName||'')}</span></td>
        <td class="warehouse-task-info" data-th="收貨資訊"><span>${escapeHtml(s.supplierName||s.supplier||'未填供應商')}</span><small>收貨倉庫　${escapeHtml(wh?.warehouseName||s.warehouseId||'未指定')}</small>
          <details class="warehouse-task-details"><summary>單據明細</summary><div>
            <p>${sourceLabel} · ${escapeHtml(s.purchaseDocumentNo||s.purchaseOrderNo||s.orderNo||'庫存採購')}</p>
            <p>${escapeHtml(source?.orderNo||source?.quoteNo||s.orderNo||'')} ${escapeHtml(source?.salesName||s.salesName||'')} ${escapeHtml(source?.customerName||s.customerName||'')}</p>
            <p>採購 ${Number(s.qty)} · 已收 ${Number(s.receivedQty||0)}</p>
            ${costVisible?`<p>單價／待收金額　${amount}</p>`:''}
          </div></details>
        </td>
        <td class="warehouse-task-quantity" data-th="待收數量"><small>待收</small><strong>${remaining}</strong></td>
        <td class="warehouse-task-action" data-th="操作"><button type="button" data-receipt-supply="${escapeAttr(s.id)}" onclick="openSupplyReceipt(${inlineJsValue(s.id)})" ${canReceive?'':'disabled'}>確認收貨</button></td>
      </tr>`;
    }).join('');
    root.renderReceiptTasks?.();
    el('inventoryReceivingEmpty').textContent=rows.length||activeReceivingSupplyError||!activeReceivingSupplyReady?'':'目前沒有採購待收貨。';
    el('inventoryReceivingStatus').textContent=activeReceivingSupplyError?'採購收貨資料尚未確認，請重試；以下若有清單，為上次讀取的資料。':!activeReceivingSupplyReady?'正在讀取採購待收貨…':`${rows.length} 筆採購待收貨${rows.length>50?'；先顯示 50 筆，處理後會補上後續品項。':''}。`;
    updateBadges();
  };
  root.inventoryReturnQueueUpdated=function(error=''){
    returnReady=!error;returnError=error;updateBadges();
  };
  root.loadInventoryWorkspace=async function(force=false){
    if(!canReceiveInventoryCapability())return updateBadges();
    if(loadPromise)return loadPromise;
    const context=String(currentUser?.uid||'')+'|'+currentUserRole;
    force=force||context!==workspaceContext;
    workspaceContext=context;
    if(force){returnReady=false;returnError='';warehouseError='';}
    updateBadges();
    const role=currentUserRole,uid=currentUser?.uid;
    loadPromise=Promise.allSettled([loadWarehouseMaster(),loadOrderWorkQueue(force),
      force||!returnReady||returnError?loadCustomerReturnQueue():Promise.resolve(),
      force||!activeReceivingSupplyReady||activeReceivingSupplyError?loadActiveReceivingSupplyCache(true):Promise.resolve(),
      root.loadWarehouseTransferQueue?.(force)||Promise.resolve(),root.loadFreeStockRecovery?.()||Promise.resolve(),
      root.loadMainTransferRequests?.(force)||Promise.resolve()])
      .then(results=>{
        if(role!==currentUserRole||uid!==currentUser?.uid)return;
        warehouseError=results[0].status==='rejected'?'倉庫設定讀取失敗：'+results[0].reason.message:'';
        renderInventoryPurchaseReceiving();renderInventoryShipping();updateBadges();
      }).finally(()=>{loadPromise=null;});
    updateBadges();
    return loadPromise;
  };
  root.switchInventoryWorkView=async function(next){
    next=next===true?'receiving':next===false?'stock':next;
    if(!['stock','receiving','shipping'].includes(next))return;
    if(next!=='stock'&&!canReceiveInventoryCapability())return;
    view=next;inventoryReceivingVisible=next==='receiving';
    for(const key of ['stock','receiving','shipping']){
      const panel=el({stock:'inventoryStockPanel',receiving:'inventoryReceivingPanel',shipping:'inventoryShippingPanel'}[key]);
      if(panel)panel.style.display=key===view?'':'none';
      const button=el({stock:'inventoryStockTabBtn',receiving:'inventoryReceivingTabBtn',shipping:'inventoryShippingTabBtn'}[key]);
      button?.classList.toggle('active',key===view);button?.setAttribute('aria-pressed',String(key===view));
    }
    if(next==='stock'){if(canReceiveInventoryCapability()){await root.loadFreeStockRecovery?.();await loadWarehouseMaster();}return;}
    if(next==='receiving'){
      switchInventoryReceivingKind(receivingKind);
      await loadInventoryWorkspace();
      renderInventoryPurchaseReceiving();
    }else{renderInventoryShipping();await loadInventoryWorkspace();}
  };
  root.switchInventoryReceivingKind=function(kind){
    receivingKind=kind==='returns'?'returns':kind==='transfers'?'transfers':'purchase';
    el('inventoryPurchaseReceivingPanel').style.display=receivingKind==='purchase'?'':'none';
    el('customerReturnPanel').style.display=receivingKind==='returns'?'':'none';
    if(el('inventoryTransferReceivingPanel'))el('inventoryTransferReceivingPanel').style.display=receivingKind==='transfers'?'':'none';
    if(el('inventoryTransferReceivingTab')){el('inventoryTransferReceivingTab').classList.toggle('active',receivingKind==='transfers');el('inventoryTransferReceivingTab').setAttribute('aria-pressed',String(receivingKind==='transfers'));}
    root.renderWarehouseTransfers?.();
    if(receivingKind==='transfers')root.loadWarehouseTransferQueue?.(true);
    renderWorkCards();renderWorkspaceErrors();
  };
  root.inventoryShippingActiveKind=()=>shippingKind;
  root.switchInventoryShippingKind=async function(kind){
    if(!canReceiveInventoryCapability())return;
    shippingKind=kind==='branch'?'branch':'main';
    el('inventoryTransferShippingPanel').style.display=shippingKind==='branch'?'':'none';
    renderInventoryShipping();
    if(shippingKind==='branch'){
      await loadInventoryWorkspace();
      await root.loadMainTransferRequests?.();
      root.renderMainTransferRequests?.();
    }
  };
  root.renderInventoryShipping=function(){
    const all=currentShippingRows().filter(r=>['CUSTOMER_SHIP','SALES_SHIP'].includes(root.YushinWarehouseLogistics.plan(r.item.deliveryPlan||r.order.shippingInstructions||{}).mode));
    const sets={main:all.filter(r=>!r.branch),branch:all.filter(r=>r.branch)};
    const transfers=root.mainTransferParcelEntries?.();
    const confirmed=orderWorkQueueReady&&!orderWorkQueueError;
    for(const [kind,label] of Object.entries({main:'主倉寄貨',branch:'分倉寄貨'})){
      const button=el('inventoryShipping'+kind[0].toUpperCase()+kind.slice(1)+'Btn');if(!button)continue;
      const ready=confirmed&&(kind!=='branch'||!transfers||transfers.ready&&!transfers.error);
      const count=sets[kind].length+(kind==='branch'?(transfers?.entries.length||0):0);
      button.innerHTML='<span>'+label+'</span><strong>'+(ready?count+' 筆':orderWorkQueueError||kind==='branch'&&transfers?.error?'—':'…')+'</strong>';
      button.classList.toggle('active',shippingKind===kind);button.setAttribute('aria-pressed',String(shippingKind===kind));
    }
    updateBadges();
    root.renderWarehouseParcels?.();
  };

  root.openInventoryShipment=async function(orderId,itemId,button){
    if(!canReceiveInventoryCapability()||shipmentPending.has(orderId))return;
    const row=currentShippingRows().find(r=>r.order.id===orderId&&r.item.itemId===itemId);
    if(!row)return showActionFeedback('此品項目前已無可出貨數量，請重新開啟出貨分頁。','warning');
    const prior=row.priorShipment;
    if(prior&&!confirm('上次出貨結果尚未確認。使用原操作識別碼重新核對，不會重複扣帳，是否繼續？'))return;
    const qtyInput=prior?String(prior.quantity):prompt(`${row.item.itemName||row.item.itemCode}，可出貨 ${row.qty}。\n請輸入此次實際出貨數量：`,String(row.qty));
    if(qtyInput===null)return;
    const qty=Number(qtyInput);if(!Number.isFinite(qty)||qty<=0||qty>row.qty)return alert('出貨數量須大於 0，且不能超過待出貨數量。');
    const dateInput=prior?prior.date:prompt('實際出貨日期（YYYY-MM-DD）：',localDateString());if(dateInput===null)return;
    const notes=prior?prior.notes:'';
    const expectedWarehouseId=prior?prior.warehouseId:row.warehouseId;
    const expectedPlan=prior?prior.expectedPlan:JSON.parse(JSON.stringify(root.YushinWarehouseLogistics.plan(row.item.deliveryPlan||row.order.shippingInstructions||{})));
    const operationId=prior?prior.operationId:(button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId()));
    shipmentPending.add(orderId);const buttonState=beginActionButton(button,'出貨中…');
    try{
      await commitInventoryShipment({orderId,itemId,qty,date:dateInput.trim(),notes:notes.trim(),operationId,expectedWarehouseId,expectedPlan});
      delete button.dataset.operationId;
      invalidateWarehouseStockCache(inventoryProductKey(row.item),row.warehouseId);
      try{await refreshAffectedOrderCaches([orderId]);await loadOrderWorkQueue(true);}
      catch(err){showActionFeedback('出貨已儲存，清單更新失敗；請重新開啟倉庫頁。','warning');}
      renderInventoryShipping();markMainPageDirty('inventory','orders.list','orders.po','admin');
      showActionFeedback(shipmentBackendPilotEnabled()?'已登記實際出貨，客戶尚未確認送達。':'已確認實際出貨，庫存與訂單送貨紀錄已同步。','success');
    }catch(err){showActionFeedback('出貨未完成：'+err.message,'warning');}
    finally{shipmentPending.delete(orderId);endActionButton(button,buttonState);}
  };
})(typeof globalThis!=='undefined'?globalThis:this);
