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
        if(!(state.shippable>0))continue;
        const warehouseId=item.warehouseId||order.warehouseId||mainId||'';
        const warehouse=warehouses.find(w=>w.id===warehouseId&&w.active!==false);
        if((warehouse?.systemCustody&&!helpers.includeCustody)||item.transferPendingId)continue;
        rows.push({order,item,qty:state.shippable,warehouseId,warehouse,
          branch:warehouseId!==mainId,key:order.id+'__'+item.itemId});
      }
    }
    return rows;
  }
  const api={purchaseRows,returnRows,shippingRows};root.YushinInventoryWorkspace=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;

  let view='stock',receivingKind='purchase',shippingKind='main',shippingLimit=50;
  let returnReady=false,returnError='',loadPromise=null;
  let warehouseError='',workspaceContext='';
  const shipmentPending=new Set();
  function el(id){return document.getElementById(id);}
  function currentShippingRows(){
    return shippingRows(orderWorkQueueCache,warehouseMasterCache,defaultWarehouse()?.id||'',{
      status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState
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
    if(ship)ship.textContent=orderWorkQueueError?'出貨（—）':!orderWorkQueueReady?'出貨（…）':`出貨（${currentShippingRows().length}）`;
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
      shipping.innerHTML=shipping.hidden?'':`${escapeHtml(orderWorkQueueError||warehouseError)}<br><button type="button" class="btn-secondary" onclick="retryInventoryWorkspace(this)">重試出貨資料</button>`;
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
    el('inventoryReceivingHead').innerHTML='<th>來源／採購單</th><th>供應商</th><th>品項</th><th>收貨倉庫</th><th>採購／已收／待收數量</th><th>採購單價／待收金額</th><th>操作</th>';
    body.innerHTML=rows.slice(0,50).map(s=>{
      const wh=warehouseMasterCache.find(w=>w.id===s.warehouseId);
      const source=receivingSourceOrderForItem(s);
      const canReceive=(source?normalizedOrderStatus(source)==='normal':true)||s.customerCancellationDisposition==='KEEP_STOCK'||(s.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP';
      const remaining=Number(s.qty)-Number(s.receivedQty||0),costVisible=currentUserRole==='admin'||currentUserRole==='purchaser';
      const costKnown=s.unitCost!==undefined&&s.unitCost!==null&&Number.isFinite(Number(s.unitCost));
      const amount=costVisible?(costKnown?`NT$${Number(s.unitCost).toLocaleString()}／NT$${(remaining*Number(s.unitCost)).toLocaleString()}`:'成本待確認'):'依權限不顯示成本';
      const sourceLabel=s.customerCancellationDisposition==='KEEP_STOCK'?'取消訂單轉備貨':s.orderId?'業務訂單':'備貨';
      return `<tr><td data-th="來源／採購單"><strong>${sourceLabel}</strong><br>${escapeHtml(s.purchaseDocumentNo||s.purchaseOrderNo||s.orderNo||'庫存採購')}<br>${escapeHtml(source?.orderNo||source?.quoteNo||s.orderNo||'')} ${escapeHtml(source?.salesName||s.salesName||'')} ${escapeHtml(source?.customerName||s.customerName||'')}</td><td data-th="供應商">${escapeHtml(s.supplierName||s.supplier||'未填供應商')}</td><td data-th="品項">${escapeHtml(s.itemCode||'')}<br>${escapeHtml(s.itemName||'')}</td><td data-th="收貨倉庫">${escapeHtml(wh?.warehouseName||s.warehouseId||'未指定')}</td><td data-th="採購／已收／待收數量">${Number(s.qty)}／${Number(s.receivedQty||0)}／<strong>${remaining}</strong></td><td data-th="採購單價／待收金額">${amount}</td><td data-th="操作"><button type="button" onclick="openSupplyReceipt(${inlineJsValue(s.id)})" ${canReceive?'':'disabled'}>確認收貨</button></td></tr>`;
    }).join('');
    el('inventoryReceivingEmpty').textContent=rows.length||activeReceivingSupplyError||!activeReceivingSupplyReady?'':'目前沒有採購待收貨。';
    el('inventoryReceivingStatus').textContent=activeReceivingSupplyError?'採購收貨資料尚未確認，請重試；以下若有清單，為上次讀取的資料。':!activeReceivingSupplyReady?'正在讀取採購待收貨…':`${rows.length} 筆採購待收貨${rows.length>50?'；先顯示 50 筆，處理後會補上後續品項。':''}。原廠直送客戶不列入倉庫收貨。`;
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
      root.loadWarehouseTransferQueue?.(force)||Promise.resolve()])
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
    if(next==='stock')return;
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
  root.switchInventoryShippingKind=function(kind){
    shippingKind=kind==='branch'?'branch':'main';shippingLimit=50;renderInventoryShipping();
  };
  root.renderInventoryShipping=function(){
    const body=el('inventoryShippingBody');if(!body)return;
    const all=currentShippingRows();
    const main=all.filter(r=>!r.branch),branch=all.filter(r=>r.branch);
    const confirmed=orderWorkQueueReady&&!orderWorkQueueError;
    el('inventoryShippingMainBtn').innerHTML=`<span>主倉庫出貨</span><strong>${confirmed?main.length+' 筆':orderWorkQueueError?'—':'…'}</strong>`;
    el('inventoryShippingBranchBtn').innerHTML=`<span>分倉庫出貨</span><strong>${confirmed?branch.length+' 筆':orderWorkQueueError?'—':'…'}</strong>`;
    el('inventoryShippingMainBtn').classList.toggle('active',shippingKind==='main');
    el('inventoryShippingBranchBtn').classList.toggle('active',shippingKind==='branch');
    el('inventoryShippingMainBtn').setAttribute('aria-pressed',String(shippingKind==='main'));
    el('inventoryShippingBranchBtn').setAttribute('aria-pressed',String(shippingKind==='branch'));
    const select=el('inventoryShippingWarehouse'),selected=select.value;
    select.innerHTML='<option value="">全部分倉庫</option>'+warehouseMasterCache.filter(w=>w.active!==false&&!w.systemCustody&&w.id!==defaultWarehouse()?.id).map(w=>`<option value="${escapeAttr(w.id)}">${escapeHtml(w.warehouseName||w.id)}</option>`).join('');
    if(warehouseMasterCache.some(w=>w.id===selected))select.value=selected;
    select.style.display=shippingKind==='branch'?'':'none';
    const mode=el('inventoryDeliveryModeFilter')?.value||'';
    const rows=(shippingKind==='main'?main:branch).filter(r=>(shippingKind==='main'||!select.value||r.warehouseId===select.value)&&(!mode||(r.item.deliveryPlan||r.order.shippingInstructions||{mode:'PICKUP'}).mode===mode));
    body.innerHTML=rows.slice(0,shippingLimit).map(row=>{
      const p=root.YushinWarehouseLogistics?.plan(row.item.deliveryPlan||row.order.shippingInstructions||{})||{mode:'PICKUP'},label=root.YushinWarehouseLogistics?.modes[p.mode]||'業務自取／親送';
      return `<tr><td data-th="選取"><input type="checkbox" aria-label="選取出貨品項" ${root.isWarehouseShippingSelected?.(row.order.id,row.item.itemId)?'checked':''} onchange="toggleWarehouseShippingSelection(${inlineJsValue(row.order.id)},${inlineJsValue(row.item.itemId)},this.checked)"></td><td data-th="訂單／業務／客戶">${escapeHtml(row.order.orderNo||row.order.quoteNo||row.order.id)}<br><strong>${escapeHtml(row.order.salesName||'未指定業務')}</strong><br>${escapeHtml(row.order.customerName||'')}</td><td data-th="品項">${escapeHtml(row.item.itemCode||'')}<br>${escapeHtml(row.item.itemName||'')}</td><td data-th="出貨倉庫">${escapeHtml(row.warehouse?.warehouseName||row.warehouseId||'未指定')}</td><td data-th="交付方式／收件資訊"><strong>${escapeHtml(label)}</strong><br>${escapeHtml(p.contact||'')} ${escapeHtml(p.phone||'')}<br>${escapeHtml(p.address||'')}<br>${escapeHtml(p.condition||'')} ${escapeHtml(p.notes||'')}</td><td data-th="待出數量">${row.qty}</td><td data-th="操作"><div class="inventory-work-actions"><button type="button" class="btn-secondary" onclick="openWarehouseDeliveryPlan(${inlineJsValue(row.order.id)},${inlineJsValue(row.item.itemId)})" ${row.warehouse?'':'disabled'}>交付設定／列印</button><button type="button" onclick="confirmWarehouseDelivery(${inlineJsValue(row.order.id)},${inlineJsValue(row.item.itemId)},this)" ${row.warehouse?'':'disabled'}>${p.mode==='TRANSFER'?'確認調撥寄出':p.mode==='CUSTOMER_SHIP'?'確認實際出貨':'確認交付業務'}</button></div></td></tr>`;
    }).join('');
    el('inventoryShippingMoreBtn').style.display=rows.length>shippingLimit?'':'none';
    el('inventoryShippingStatus').textContent=orderWorkQueueError?'出貨資料尚未確認，請重試；以下若有清單，為上次讀取的資料。':!orderWorkQueueReady?'正在讀取已打單待出貨品項…':`${rows.length} 筆已打單待出貨品項。列印不異動庫存；交付業務及轉倉不代表客戶已收到貨。`;
    root.renderWarehouseCustody?.();
    updateBadges();
  };
  root.loadMoreInventoryShipping=function(){shippingLimit+=50;renderInventoryShipping();};

  root.openInventoryShipment=async function(orderId,itemId,button){
    if(!canReceiveInventoryCapability()||shipmentPending.has(orderId))return;
    const row=currentShippingRows().find(r=>r.order.id===orderId&&r.item.itemId===itemId);
    if(!row)return showActionFeedback('此品項目前已無可出貨數量，請重新開啟出貨分頁。','warning');
    const qtyInput=prompt(`${row.item.itemName||row.item.itemCode}，已打單可出貨 ${row.qty}。\n請輸入此次實際出貨數量：`,String(row.qty));
    if(qtyInput===null)return;
    const qty=Number(qtyInput);if(!Number.isFinite(qty)||qty<=0||qty>row.qty)return alert('出貨數量須大於 0，且不能超過已打單待出數量。');
    const dateInput=prompt('實際出貨日期（YYYY-MM-DD）：',localDateString());if(dateInput===null)return;
    const notes=prompt('實際出貨備註（例如物流單號、冷藏或乾冰）：','');if(notes===null)return;
    const operationId=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());
    shipmentPending.add(orderId);const buttonState=beginActionButton(button,'出貨中…');
    try{
      await commitInventoryShipment({orderId,itemId,qty,date:dateInput.trim(),notes:notes.trim(),operationId});
      delete button.dataset.operationId;
      invalidateWarehouseStockCache(inventoryProductKey(row.item),row.warehouseId);
      try{await refreshAffectedOrderCaches([orderId]);await loadOrderWorkQueue(true);}
      catch(err){showActionFeedback('出貨已儲存，清單更新失敗；請重新開啟庫存頁。','warning');}
      renderInventoryShipping();markMainPageDirty('inventory','orders.list','orders.po','admin');
      showActionFeedback('已確認實際出貨，庫存與訂單送貨紀錄已同步。','success');
    }catch(err){showActionFeedback('出貨未完成：'+err.message,'warning');}
    finally{shipmentPending.delete(orderId);endActionButton(button,buttonState);}
  };
})(typeof globalThis!=='undefined'?globalThis:this);

async function commitInventoryShipment({orderId,itemId,qty,date,notes='',operationId}){
  if(!canReceiveInventoryCapability()||!canAccessPage('inventory'))throw new Error('無庫存出貨權限。');
  if(!operationId||!Number.isFinite(qty)||qty<=0)throw new Error('出貨數量或操作識別碼不正確。');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)throw new Error('請填寫有效的出貨日期。');
  let saved;
  await runRoleTransaction(async tx=>{
    const ref=db.collection('orders').doc(orderId),snapshot=await tx.get(ref);
    if(!snapshot.exists)throw new Error('找不到訂單。');
    const order=snapshot.data(),records=savedDeliveryRecords(order);
    if(records.some(r=>r.id===operationId)){saved=order;return;}
    if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order))throw new Error('訂單已取消或庫存尚未同步。');
    if(!Array.isArray(order.items))throw new Error('舊版訂單須先完成品項整理，才能由倉庫出貨。');
    const item=normalizedOrderItems(order).find(i=>i.itemId===itemId);
    if(item?.transferPendingId)throw new Error('此品項尚在調撥途中。');
    const plan=item?.deliveryPlan||order.shippingInstructions;
    if(plan&&plan.mode!=='CUSTOMER_SHIP')throw new Error('交付方式已變更，請重新確認。');
    if(plan)globalThis.YushinWarehouseLogistics.validatePlan(plan,true);
    if(!item||(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')throw new Error('此品項不屬於倉庫出貨。');
    const state=itemDispatchState(order,item);
    if(qty>state.shippable)throw new Error('出貨數量超過最新已打單可出貨數量。');
    const warehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';
    if(!warehouseMasterCache.some(w=>w.id===warehouseId&&w.active!==false))throw new Error('出貨倉庫不存在或已停用。');
    const actor=deliveryActor(),now=new Date().toISOString();
    const result=await applyInventoryDeliveryDeltaInTransaction(tx,{...order,...item,itemId,warehouseId,isDelivered:false,requireStockReservation:true},qty,actor,orderId);
    const record={id:operationId,orderId,itemId,productKey:inventoryProductKey(item),itemIndex:order.items.findIndex(i=>i.itemId===itemId),warehouseId,date,qty,notes,sourceType:'INVENTORY_SHIPMENT',createdBy:actor,createdByUid:currentUser.uid,createdAt:now,movementId:result.movementId,lotAllocations:result.lotAllocations||[],cogs:0};
    const nextRecords=[...records,record],totalDelivered=nextRecords.reduce((sum,r)=>sum+Number(r.qty||0),0);
    const closedReturns=savedReturnRecords(order).filter(r=>r.settlement==='CLOSE').reduce((sum,r)=>sum+Number(r.qty||0),0);
    const nextItems=order.items.map(i=>i.itemId===itemId?{...i,reservedQty:result.newReservedQty,warehouseShippedQty:state.grossDelivered+qty}:i);
    const history={action:'create',source:'inventory',recordId:operationId,before:null,after:record,by:actor,at:now};
    const updates={inventoryShipmentRecordId:operationId,items:nextItems,deliveryRecords:nextRecords,deliveredQty:totalDelivered,isDelivered:totalDelivered-returnedQuantity(order)+closedReturns>=orderQuantity(order),deliveryHistory:firebase.firestore.FieldValue.arrayUnion(history),updatedAt:now};
    Object.assign(updates,orderWorkIndexFields({...order,...updates}));tx.update(ref,updates);saved={...order,...updates};
  });
  return saved;
}
