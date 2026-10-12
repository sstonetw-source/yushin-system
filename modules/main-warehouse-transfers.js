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
  root.createMainTransferRequest=async function({id,inventoryId,fromWarehouseId,qty}){
    if(!purchasing())throw Error('只有採購或管理員可發起主倉備貨調撥。');
    if(!id||id.length>128||!Number.isFinite(qty)||qty<=0||qty>1000000)throw Error('調回數量或識別碼不正確。');
    const toWarehouseId=mainId(),actorUid=currentUser.uid,actorRole=currentUserRole;
    if(!toWarehouseId||!fromWarehouseId||fromWarehouseId===toWarehouseId)throw Error('請選擇分倉作為來源，目的地固定為主倉。');
    let saved;
    await runRoleTransaction(async tx=>{
      const ref=db.collection('stockTransferRequests').doc(id),prior=await tx.get(ref);
      if(prior.exists){saved=prior.data();if(saved.inventoryId!==inventoryId||saved.fromWarehouseId!==fromWarehouseId||saved.toWarehouseId!==toWarehouseId||Number(saved.qty)!==qty)throw Error('調回操作識別碼衝突。');return;}
      const invRef=db.collection('inventory').doc(inventoryId),invSnap=await tx.get(invRef);
      if(!invSnap.exists)throw Error('找不到庫存。');const inv=invSnap.data(),key=inv.productKey||inv.productId;
      if(!key)throw Error('庫存缺少產品識別。');
      const stockRef=db.collection('warehouseStocks').doc(warehouseStockDocId(fromWarehouseId,key));
      const stockSnap=await tx.get(stockRef),source=await tx.get(db.collection('warehouses').doc(fromWarehouseId)),target=await tx.get(db.collection('warehouses').doc(toWarehouseId));
      if(!stockSnap.exists||!source.exists||source.data().active===false||source.data().systemCustody||!target.exists||target.data().active===false||!target.data().isDefault||target.data().systemCustody)throw Error('主倉或來源分倉設定不正確。');
      const stock=stockSnap.data();
      if(Number(stock.onHand||0)-Number(stock.reserved||0)<qty||Number(inv.onHand||0)-Number(inv.reserved||0)<qty)throw Error('分倉可用庫存不足，請勿調用已占用的貨品。');
      if(actorUid!==currentUser.uid||actorRole!==currentUserRole)throw Error('登入身分已變更。');
      const now=new Date().toISOString();
      saved={id,inventoryId,productKey:key,productId:inv.productId||key,itemCode:inv.itemCode||'',itemName:inv.itemName||'',brand:inv.brand||'',fromWarehouseId,toWarehouseId,fromStockId:stockRef.id,qty,status:'PENDING',createdByUid:actorUid,createdAt:now};
      tx.set(ref,saved);
      tx.update(stockRef,{reserved:Number(stock.reserved||0)+qty,transferReserved:Number(stock.transferReserved||0)+qty,updatedAt:now});
      tx.update(invRef,{reserved:Number(inv.reserved||0)+qty,transferReserved:Number(inv.transferReserved||0)+qty,updatedAt:now});
    });return saved;
  };
  root.cancelMainTransferRequest=async function(id,button){
    if(!purchasing()||busy.has(id)||!confirm('取消這筆尚未寄出的備貨調回需求，並釋放保留庫存？'))return;
    busy.add(id);const state=beginActionButton(button,'取消中…'),actorUid=currentUser.uid;
    try{
      await runRoleTransaction(async tx=>{
        const ref=db.collection('stockTransferRequests').doc(id),snapshot=await tx.get(ref);
        if(!snapshot.exists)throw Error('調回需求不存在。');const r=snapshot.data();if(r.status==='CANCELLED')return;if(r.status!=='PENDING')throw Error('已寄出的調撥不能取消需求。');
        const stockRef=db.collection('warehouseStocks').doc(r.fromStockId),invRef=db.collection('inventory').doc(r.inventoryId),stock=await tx.get(stockRef),inventory=await tx.get(invRef);
        if(!stock.exists||!inventory.exists)throw Error('庫存不存在。');const wh=stock.data(),inv=inventory.data();
        if([wh.reserved,wh.transferReserved,inv.reserved,inv.transferReserved].some(n=>Number(n||0)<r.qty))throw Error('保留庫存數量不一致。');
        if(actorUid!==currentUser.uid||!purchasing())throw Error('登入身分已變更。');const now=new Date().toISOString();
        tx.update(ref,{status:'CANCELLED',cancelledAt:now,cancelledByUid:actorUid});
        tx.update(stockRef,{reserved:Number(wh.reserved)-r.qty,transferReserved:Number(wh.transferReserved)-r.qty,updatedAt:now});
        tx.update(invRef,{reserved:Number(inv.reserved)-r.qty,transferReserved:Number(inv.transferReserved)-r.qty,updatedAt:now});
      });await root.loadMainTransferRequests(true);await loadInventory(true);showActionFeedback('需求已取消，保留庫存已釋放。');
    }catch(err){showActionFeedback('取消未完成：'+err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
  };
  root.dispatchMainTransferRequest=async function(id,button){
    if(!operational()||busy.has(id))return;const r=pendingRequests.find(x=>x.id===id);if(!r)return;
    if(!confirm(`確認 ${r.itemCode} × ${r.qty} 已實際從分倉寄回主倉？\n主倉點收前仍不能使用，且不會完成客戶訂單。`))return;
    busy.add(id);const state=beginActionButton(button,'出貨中…');
    const operationId=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());
    try{await root.commitWarehouseTransfer({id:operationId,requestId:id,inventoryId:r.inventoryId,fromWarehouseId:r.fromWarehouseId,toWarehouseId:r.toWarehouseId,qty:r.qty});delete button.dataset.operationId;await root.loadMainTransferRequests(true);await root.loadWarehouseTransferQueue(true);await loadInventory(true);showActionFeedback('已出貨回主倉，等待主倉確認已收貨。');}
    catch(err){showActionFeedback('調回出貨未完成：'+err.message,'warning');}finally{busy.delete(id);endActionButton(button,state);}
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
      const groups=new Map();for(const row of [...orders,...stock]){const id=row.warehouseId;if(!groups.has(id))groups.set(id,{warehouseId:id,warehouseName:warehouseMasterCache.find(w=>w.id===id)?.warehouseName||id,plan:{mode:'TRANSFER',warehouseId:mainId(),contact:target?.contact||target?.warehouseName||'主倉',phone:target?.phone||'',address:target?.address||'',condition:'',notes:'訂單占用與主倉備貨依來源分開點收'},rows:[]});groups.get(id).rows.push(row);}
      if(!groups.size)throw Error('目前沒有調回主倉需求。');
      const csv=root.YushinWarehouseLogistics.csvDocument([...groups.values()]),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='目前調回主倉清單-'+localDateString()+'.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(err){showActionFeedback('匯出未完成：'+err.message,'warning');}finally{endActionButton(button,state);}
  };
  root.renderMainTransferRequests=function(){
    const panel=document.getElementById('mainTransferRequestPanel'),body=document.getElementById('mainTransferRequestBody');if(!panel||!body)return;panel.hidden=!operational();if(panel.hidden||document.getElementById('inventoryStockPanel')?.style.display==='none')return;
    const needs=root.YushinWarehouseLogistics.transferRequirements(orderWorkQueueCache,warehouseMasterCache,mainId(),{status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState});
    const retry=document.getElementById('mainTransferRetry');if(retry)retry.hidden=!error;
    const name=id=>warehouseMasterCache.find(w=>w.id===id)?.warehouseName||id;
    const orderRows=needs.map(r=>({source:`訂單需求｜${r.order.orderNo||r.order.id}｜${r.order.salesName||''}`,warehouseId:r.warehouseId,item:r.item,qty:r.qty,action:`<button type="button" onclick="startOrderWarehouseTransfer(${inlineJsValue(r.order.id)},${inlineJsValue(r.item.itemId)},this)" ${r.readyQty<r.qty?'disabled':''}>已出貨</button>${r.readyQty<r.qty?'<small>待品項到齊並打單</small>':''}`}));
    const stockRows=pendingRequests.map(r=>({source:'主倉備貨',warehouseId:r.fromWarehouseId,item:r,qty:r.qty,action:`<button type="button" onclick="dispatchMainTransferRequest(${inlineJsValue(r.id)},this)">已出貨</button>${purchasing()?`<button type="button" class="btn-danger" onclick="cancelMainTransferRequest(${inlineJsValue(r.id)},this)">取消需求</button>`:''}`}));
    body.innerHTML=[...orderRows,...stockRows].map(r=>`<tr><td data-th="來源">${escapeHtml(r.source)}</td><td data-th="分倉">${escapeHtml(name(r.warehouseId))} → ${escapeHtml(name(mainId()))}</td><td data-th="品項">${escapeHtml(r.item.itemCode)}<br>${escapeHtml(r.item.itemName)}</td><td data-th="調回數量">${r.qty}</td><td data-th="操作">${r.action}</td></tr>`).join('');
    document.getElementById('mainTransferRequestStatus').textContent=error||`${orderRows.length} 筆訂單需求、${stockRows.length} 筆主倉備貨${pendingRequests.length>=50?'（備貨先顯示 50 筆）':''}；實際寄出後按已出貨，主倉收到後在調撥收貨按已收貨。`;
  };
  const original=root.renderInventoryList;
  root.renderInventoryList=function(){const result=original?.apply(this,arguments);if(operational()){root.renderMainTransferRequests();root.loadMainTransferRequests();}return result;};
})(globalThis);
