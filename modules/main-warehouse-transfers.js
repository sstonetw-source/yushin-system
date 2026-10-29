/* Main-warehouse replenishment holds free stock until the actual dispatch.
   Customer-order requests use their existing reservation, never a second hold. */
(function(root){
  const mainId=()=>defaultWarehouse()?.id||'';
  const operational=()=>canReceiveInventoryCapability()&&canAccessPage('inventory');
  const purchasing=()=>canManageInventoryStockPolicy()&&canEditPage('inventory');
  let pendingRequests=[],ready=false,error='',loading=null,context='';
  const busy=new Set();
  root.resetMainTransferRequests=function(){pendingRequests=[];ready=false;error='';context='';loading=null;busy.clear();};
  function identity(){return currentUser?.uid+'|'+currentUserRole;}
  root.resumeMainTransferOperation=async function(id,button){
    if(!purchasing()||busy.has(id))return;busy.add(id);const state=beginActionButton(button,'確認中…');
    try{await commitMainTransferRequestBackend(id);
      try{await root.loadMainTransferRequests(true);await loadInventory(true);}
      catch(_){showActionFeedback('原調撥需求已確認，清單更新失敗，請重新開啟庫存頁。','warning');return;}
      showActionFeedback('原調撥需求結果已確認。');
    }catch(err){showActionFeedback(err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
  };
  root.cancelMainTransferRequest=async function(id,button){
    if(!purchasing()||busy.has(id)||!confirm('取消這筆尚未寄出的備貨調回需求，並釋放保留庫存？'))return;
    busy.add(id);const state=beginActionButton(button,'取消中…');
    try{
      await cancelMainTransferRequestRecord(id);
      try{await root.loadMainTransferRequests(true);await loadInventory(true);}
      catch(err){showActionFeedback('需求已取消、保留庫存已釋放，但清單更新失敗；請重新開啟庫存頁。','warning');return;}
      showActionFeedback('需求已取消，保留庫存已釋放。');
    }catch(err){showActionFeedback('取消未完成：'+err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
  };
  root.resumeMainTransferPhysical=async function(action,id,button){
    if(!operational()||busy.has(id))return;busy.add(id);const state=beginActionButton(button,'確認中…');
    try{const result=await commitMainTransferPhysicalBackend(action,id);
      try{await root.loadMainTransferRequests(true);await root.loadWarehouseTransferQueue(true);await loadInventory(true);}
      catch(_){showActionFeedback('原實貨調撥已確認，清單更新失敗，請重新開啟庫存頁。','warning');return;}
      showActionFeedback(result.physicalReceiptOnly?'實貨已入庫；請另按「核對／續傳分配」處理缺貨訂單。':'原調撥實貨結果已確認。',result.physicalReceiptOnly?'warning':'success');
    }catch(err){showActionFeedback(err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
  };
  root.resumeMainTransferAllocation=async function(id,button){
    if(!operational()||busy.has(id))return;busy.add(id);const state=beginActionButton(button,'分配中…');
    try{const result=await resumeMainTransferAllocationBackend(id);
      try{await refreshAffectedOrderCaches(result.affectedOrderIds);await loadInventory(true);await root.loadWarehouseTransferQueue(true);}
      catch(_){showActionFeedback('分配結果已確認，清單更新失敗；請重新開啟庫存頁。','warning');return;}
      showActionFeedback(result.recoveryPending?'實貨已入庫，分配尚未完成；請沿用原調撥繼續處理。':'此批分配已完成核對，未重複入庫。',result.recoveryPending?'warning':'success');
    }catch(err){showActionFeedback(err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
  };
  root.resumeOrderTransferOperation=async function(action,id,button){
    if(!operational()||busy.has(id))return;busy.add(id);const state=beginActionButton(button,'確認中…');
    try{const result=await commitOrderTransferBackend(action,id);await refreshAffectedOrderCaches(result.affectedOrderIds);await loadInventory(true);await root.loadWarehouseTransferQueue(true);await root.loadMainTransferRequests(true);showActionFeedback(action==='DISPATCH'?'原訂單調撥寄出已確認，等待收貨。':'原訂單調撥已收貨，預留已移倉。');}
    catch(err){showActionFeedback('原操作仍須核對：'+err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
  };
  root.dispatchMainTransferRequest=async function(id,button){
    if(!operational()||busy.has(id))return;
    let prior=null;try{prior=typeof pendingMainTransferDispatch==='function'?pendingMainTransferDispatch(id):null;}
    catch(err){showActionFeedback(err.message,'warning');return;}
    if(prior)return root.resumeMainTransferPhysical('DISPATCH',prior.id,button);
    const r=pendingRequests.find(x=>x.id===id);if(!r)return;
    if(!confirm(`確認 ${r.itemCode} × ${r.qty} 已實際從分倉寄回主倉？\n主倉點收前仍不能使用，且不會完成客戶訂單。`))return;
    busy.add(id);const state=beginActionButton(button,'出貨中…');
    const operationId=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());
    try{await root.commitWarehouseTransfer({id:operationId,requestId:id,inventoryId:r.inventoryId,fromWarehouseId:r.fromWarehouseId,toWarehouseId:r.toWarehouseId,qty:r.qty});delete button.dataset.operationId;
      try{await root.loadMainTransferRequests(true);await root.loadWarehouseTransferQueue(true);await loadInventory(true);}
      catch(_){showActionFeedback('已出貨回主倉，但清單更新失敗；請重新開啟庫存頁。','warning');return;}
      showActionFeedback('已出貨回主倉，等待主倉確認已收貨。');
    }catch(err){showActionFeedback('調回出貨結果未確認：'+err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
  };
  root.loadMainTransferRequests=async function(force=false){
    if(!operational())return;if(context!==identity()){pendingRequests=[];ready=false;error='';context=identity();}
    if(loading)return loading;if(ready&&!force)return root.renderMainTransferRequests();
    const requested=context;
    loading=(async()=>{try{const snapshot=await firestoreReadWithTimeout(db.collection('stockTransferRequests').where('status','==','PENDING').limit(50).get(),'主倉備貨調回需求');if(requested!==identity())return;pendingRequests=snapshot.docs.map(d=>({...d.data(),id:d.id}));ready=true;error='';}
    catch(err){if(requested!==identity())return;error=err.code==='permission-denied'?'備貨調回需求需要部署最新版 Firestore 規則。':err.message;}
    finally{loading=null;root.renderMainTransferRequests();}})();return loading;
  };
  root.exportMainTransferRequests=async function(button){
    if(!operational())return;const who=identity(),state=beginActionButton(button,'匯出中…');
    try{
      await root.loadMainTransferRequests(true);await loadOrderWorkQueue(true);if(who!==identity()||error)throw Error(error||'登入身分已變更。');
      const target=defaultWarehouse(),orders=root.YushinWarehouseLogistics.transferRequirements(orderWorkQueueCache,warehouseMasterCache,mainId(),{status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState});
      const stock=pendingRequests.map(r=>({order:{id:r.id,orderNo:'主倉備貨・'+r.id,salesName:'',customerName:''},item:r,qty:r.qty,readyQty:r.qty,warehouseId:r.fromWarehouseId,key:r.id}));
      const groups=new Map();for(const row of [...orders,...stock]){const id=row.warehouseId;if(!groups.has(id))groups.set(id,{warehouseId:id,warehouseName:warehouseMasterCache.find(w=>w.id===id)?.warehouseName||id,plan:{mode:'TRANSFER',warehouseId:mainId(),contact:target?.contact||target?.warehouseName||'主倉',phone:target?.phone||'',address:target?.address||'',condition:'',notes:'訂單預留與主倉備貨依來源分開點收'},rows:[]});groups.get(id).rows.push(row);}
      if(!groups.size)throw Error('目前沒有調回主倉需求。');
      const csv=root.YushinWarehouseLogistics.csvDocument([...groups.values()]),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='目前調回主倉清單-'+localDateString()+'.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(err){showActionFeedback('匯出未完成：'+err.message,'warning');}finally{endActionButton(button,state);}
  };
  root.renderMainTransferRequests=function(){
    const panel=document.getElementById('mainTransferRequestPanel'),body=document.getElementById('mainTransferRequestBody');if(!panel||!body)return;panel.hidden=!operational();if(panel.hidden||document.getElementById('inventoryTransferShippingPanel')?.style.display==='none')return;
    const needs=root.YushinWarehouseLogistics.transferRequirements(orderWorkQueueCache,warehouseMasterCache,mainId(),{status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState});
    const retry=document.getElementById('mainTransferRetry');if(retry)retry.hidden=!error;
    const name=id=>warehouseMasterCache.find(w=>w.id===id)?.warehouseName||id;
    const orderRows=needs.map(r=>({source:`訂單需求｜${r.order.orderNo||r.order.quoteNo||'未編單號'}｜${r.order.salesName||''}｜${r.order.customerName||''}`,warehouseId:r.warehouseId,item:r.item,qty:r.qty,action:`<button type="button" onclick="startOrderWarehouseTransfer(${inlineJsValue(r.order.id)},${inlineJsValue(r.item.itemId)},this)" ${r.readyQty<r.qty?'disabled':''}>登記出貨</button>${r.readyQty<r.qty?'<small>待品項到齊並打單</small>':''}`}));
    const stockRows=pendingRequests.map(r=>({source:'主倉備貨',warehouseId:r.fromWarehouseId,item:r,qty:r.qty,action:`<button type="button" onclick="dispatchMainTransferRequest(${inlineJsValue(r.id)},this)">登記出貨</button>${purchasing()?`<button type="button" class="btn-danger" onclick="cancelMainTransferRequest(${inlineJsValue(r.id)},this)">取消需求</button>`:''}`}));
    const recovery=purchasing()&&typeof pendingMainTransferOperations==='function'?pendingMainTransferOperations():[];
    const physicalRecovery=typeof pendingMainTransferPhysicalOperations==='function'?pendingMainTransferPhysicalOperations().filter(r=>r.action==='DISPATCH'||r.error):[];
    const physicalRecoveryHtml=physicalRecovery.map(r=>`<tr><td colspan="5">${r.error?escapeHtml(r.error):`前次主倉備貨寄出結果待確認 <button type="button" onclick="resumeMainTransferPhysical('DISPATCH',${inlineJsValue(r.id)},this)">確認前次寄出結果</button>`}</td></tr>`).join('');
    const recoveryHtml=recovery.map(r=>`<tr><td colspan="5">${r.error?escapeHtml(r.error):`前次主倉需求${r.action==='CANCEL'?'取消':'建立'}結果待確認 <button type="button" onclick="resumeMainTransferOperation(${inlineJsValue(r.id)},this)">確認前次結果</button>`}</td></tr>`).join('');
    const orderRecovery=typeof pendingOrderTransferOperations==='function'?pendingOrderTransferOperations().filter(p=>p.action==='DISPATCH'||p.error):[];
    const orderHtml=orderRecovery.map(p=>`<tr><td colspan="5">${p.error?escapeHtml(p.error):`訂單調撥寄出結果待確認 <button type="button" onclick="resumeOrderTransferOperation('DISPATCH',${inlineJsValue(p.id)},this)">確認原寄出結果</button>`}</td></tr>`).join('');
    body.innerHTML=orderHtml+recoveryHtml+physicalRecoveryHtml+[...orderRows,...stockRows].map(r=>`<tr><td data-th="來源">${escapeHtml(r.source)}</td><td data-th="分倉">${escapeHtml(name(r.warehouseId))} → ${escapeHtml(name(mainId()))}</td><td data-th="品項">${escapeHtml(r.item.itemCode)}<br>${escapeHtml(r.item.itemName)}</td><td data-th="調回數量">${r.qty}</td><td data-th="操作">${r.action}</td></tr>`).join('');
    const table=body.closest?.('.inventory-work-table');if(table)table.hidden=ready&&!orderRows.length&&!stockRows.length&&!error&&!recovery.length&&!physicalRecovery.length&&!orderRecovery.length;
    document.getElementById('mainTransferRequestStatus').textContent=error||(!ready?'正在讀取調撥出貨工作…':`${orderRows.length} 筆訂單需求、${stockRows.length} 筆主倉備貨${pendingRequests.length>=50?'（備貨先顯示 50 筆）':''}；實際寄出後按登記出貨，主倉收到後在調撥收貨按已收貨。`);
  };
  const original=root.renderInventoryList;
  root.renderInventoryList=function(){const result=original?.apply(this,arguments);if(operational()&&document.getElementById('inventoryTransferShippingPanel')?.style.display!=='none'){root.renderMainTransferRequests();root.loadMainTransferRequests();}return result;};
})(globalThis);

