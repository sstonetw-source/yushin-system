/* Warehouse delivery instructions, immutable transfers and address labels.
   Customer delivery remains the existing order workflow; transfers never create deliveryRecords. */
(function(root){
  const modes={PICKUP:'業務自取／親送',SALES_SHIP:'寄給業務',CUSTOMER_SHIP:'直接寄客戶',TRANSFER:'轉送倉庫'};
  function plan(value={}) {
    return {mode:Object.hasOwn(modes,value.mode)?value.mode:'PICKUP',contact:String(value.contact||'').trim(),phone:String(value.phone||'').trim(),address:String(value.address||'').trim(),warehouseId:String(value.warehouseId||''),packages:Number(value.packages??1),condition:String(value.condition||'常溫'),notes:String(value.notes||''),tracking:String(value.tracking||'')};
  }
  function validatePlan(value,requireRecipient=false){
    const p=plan(value);
    if(!Number.isInteger(p.packages)||p.packages<1||p.packages>99)throw Error('件數須為 1 至 99 的整數。');
    if(p.mode==='TRANSFER'&&!p.warehouseId)throw Error('請選擇收貨倉庫。');
    if(requireRecipient&&p.mode!=='PICKUP'&&(!p.contact||!p.phone||!p.address))throw Error('請填齊收件人、電話與地址。');
    for(const key of ['contact','phone','address','notes','tracking','condition'])if(p[key].length>1000)throw Error('收件資訊過長。');
    return p;
  }
  function bundleKey(row,p){return JSON.stringify([row.warehouseId,p.mode,p.warehouseId,p.contact,p.phone,p.address,p.condition,p.notes]);}
  function partition(rows,getPlan){const groups=new Map();for(const row of rows){const p=validatePlan(getPlan(row),true),key=bundleKey(row,p);if(!groups.has(key))groups.set(key,{warehouseId:row.warehouseId,plan:p,rows:[]});groups.get(key).rows.push(row);}return [...groups.values()];}
  function transferable(stock,qty,reservedQty=0){
    if(!Number.isFinite(qty)||qty<=0)throw Error('數量必須大於 0。');
    if(!Number.isFinite(reservedQty)||reservedQty<0||reservedQty>qty)throw Error('占用數量不正確。');
    if(Number(stock.onHand||0)<qty||Number(stock.reserved||0)<reservedQty||Number(stock.onHand||0)-Number(stock.reserved||0)<qty-reservedQty)throw Error('來源倉庫可移動庫存不足。');
  }
  function batchJobs(list,getPlan,batchId){
    if(!list.length||list.length>100)throw Error('每批請勾選 1 至 100 個品項。');
    const seen=new Set();
    return list.map((row,index)=>{
      if(seen.has(row.key)||!row.warehouse||row.warehouse.systemCustody||!Number.isFinite(row.qty)||row.qty<=0)throw Error('出貨品項、倉庫或數量不正確。');
      seen.add(row.key);const p=validatePlan(getPlan(row),true);
      return {row,plan:p,qty:row.qty,operationId:batchId+'-'+index,done:false,error:''};
    });
  }
  async function processBatch(jobs,commit,progress){
    for(const job of jobs){
      if(job.done)continue;
      try{await commit(job);job.done=true;job.error='';}
      catch(err){job.error=String(err.message||err);progress?.(jobs);break;}
      progress?.(jobs);
    }
    return {completed:jobs.filter(j=>j.done).length,total:jobs.length,complete:jobs.every(j=>j.done)};
  }
  function csvDocument(groups){
    const cell=value=>{let text=String(value??'');if(/^[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
    const header=['出貨倉庫','交付方式','收件人','電話','地址','溫層','配送備註','訂單單號','業務','客戶','貨號','品名','本次數量'];
    const data=groups.flatMap(g=>g.rows.map(r=>[g.warehouseName||g.warehouseId,modes[g.plan.mode],g.plan.contact,g.plan.phone,g.plan.address,g.plan.condition,g.plan.notes,r.order.orderNo||r.order.quoteNo||'',r.order.salesName,r.order.customerName,r.item.itemCode,r.item.itemName,r.qty]));
    return '\uFEFF'+[header,...data].map(row=>row.map(cell).join(',')).join('\r\n');
  }
  function shippingStatus(order,item,state){
    const total=Number(item.orderedQty||item.qty||0),delivered=Number(state.delivered||0);
    if(total>0&&delivered>=total)return '已送貨';
    if(item.transferPendingId)return '轉倉途中';
    if(String(item.warehouseId||'').startsWith('custody-'))return '已交付業務・待送客戶';
    if(delivered>0)return `部分已送貨 ${delivered}／${total}`;
    if((order.logisticsHistory||[]).some(h=>h.itemId===item.itemId&&h.action==='倉庫調撥收貨'))return '已轉倉・待送客戶';
    return '';
  }
  const api={modes,plan,validatePlan,bundleKey,partition,transferable,batchJobs,processBatch,csvDocument,shippingStatus};root.YushinWarehouseLogistics=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);
  let transfers=[],queueReady=false,queueError='',queueContext='',queuePromise=null,editor=null;
  const selected=new Set(),pending=new Set();let transferLimit=50,visibleRows=[],shippingBatch=null,batchOpening=false;
  function allowed(){return canReceiveInventoryCapability()&&canAccessPage('inventory');}
  function rows(includeCustody=false){return root.YushinInventoryWorkspace.shippingRows(orderWorkQueueCache,warehouseMasterCache,defaultWarehouse()?.id||'',{status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState,includeCustody});}
  function rowPlan(row){return plan(row.item.deliveryPlan||row.order.shippingInstructions||{});}
  function context(){return currentUser?.uid+'|'+currentUserRole;}
  root.resetWarehouseLogistics=function(){transfers=[];selected.clear();visibleRows=[];shippingBatch=null;queueReady=false;queueError='';queueContext='';queuePromise=null;editor=null;$('warehouseLogisticsOverlay')?.remove();};
  root.loadWarehouseTransferQueue=async function(force=false){
    if(!allowed())return;
    const ctx=context();if(queueContext!==ctx){root.resetWarehouseLogistics();queueContext=ctx;}
    if(queuePromise)return queuePromise;if(queueReady&&!force)return root.renderWarehouseTransfers();
    queueReady=false;queueError='';root.renderWarehouseTransfers();
    const task=(async()=>{try{
      const snapshot=await firestoreReadWithTimeout(db.collection('stockTransfers').where('status','==','IN_TRANSIT').limit(50).get(),'倉庫調撥收貨');
      if(ctx!==context())return;
      transfers=snapshot.docs.map(doc=>({...doc.data(),id:doc.id}));queueReady=true;
    }catch(err){if(ctx!==context())return;queueError=err.code==='permission-denied'?'調撥功能所需的 Firestore 規則尚未部署。':'調撥資料讀取失敗：'+err.message;
    }finally{if(ctx===context()){queuePromise=null;root.renderWarehouseTransfers();root.updateInventoryWorkspaceBadges?.();}}})();queuePromise=task;return task;
  };
  root.warehouseTransferQueueState=()=>({ready:queueReady,error:queueError,count:transfers.length,hasMore:transfers.length>=50});
  root.renderWarehouseTransfers=function(){
    const body=$('inventoryTransferReceivingBody');if(!body)return;
    body.innerHTML=transfers.map(t=>`<tr><td data-th="來源">${escapeHtml(t.orderId?'業務訂單':'庫存調撥')}<br>${escapeHtml(t.orderNo||t.id)}<br>${escapeHtml(t.salesName||'')}</td><td data-th="寄出方／目的倉">${escapeHtml(warehouseName(t.fromWarehouseId))} → ${escapeHtml(warehouseName(t.toWarehouseId))}</td><td data-th="品項">${escapeHtml(t.itemCode)}<br>${escapeHtml(t.itemName)}</td><td data-th="待收數量">${t.qty}</td><td data-th="操作"><button type="button" onclick="receiveWarehouseTransfer(${inlineJsValue(t.id)},this)">確認調撥收貨</button></td></tr>`).join('');
    $('inventoryTransferReceivingStatus').textContent=queueError||(!queueReady?'讀取中…':`${transfers.length} 筆調撥途中${transfers.length>=50?'，先顯示 50 筆；處理後自動補入下一批':''}。收到實體貨品後才確認入庫。`);
    const card=$('inventoryTransferReceivingTab');if(card)card.innerHTML=`<span>調撥收貨</span><strong>${queueError?'—':queueReady?transfers.length+' 筆':'…'}</strong>`;
  };
  function warehouseName(id){return warehouseMasterCache.find(w=>w.id===id)?.warehouseName||id;}
  function modal(html){let overlay=$('warehouseLogisticsOverlay');if(!overlay){overlay=document.createElement('div');overlay.id='warehouseLogisticsOverlay';overlay.className='eq-modal-overlay no-print';overlay.addEventListener('click',e=>{if(e.target===overlay)root.closeWarehouseLogistics();});document.body.appendChild(overlay);}overlay.innerHTML=`<div class="eq-modal-box warehouse-logistics-modal">${html}</div>`;overlay.classList.add('active');}
  root.closeWarehouseLogistics=function(){if(editor?.busy||shippingBatch?.busy)return;editor=null;shippingBatch=null;$('warehouseLogisticsOverlay')?.classList.remove('active');updateSelection();};
  function fields(p,prefix='logistics'){
    return `<div class="form-grid"><label>交付方式<select id="${prefix}Mode" onchange="warehouseDeliveryModeChanged('${prefix}')">${Object.entries(modes).map(([k,v])=>`<option value="${k}" ${p.mode===k?'selected':''}>${v}</option>`).join('')}</select></label><label>收貨倉庫<select id="${prefix}Warehouse" onchange="warehouseDeliveryModeChanged('${prefix}',true)"><option value="">選擇倉庫</option>${warehouseMasterCache.filter(w=>w.active!==false&&!w.systemCustody).map(w=>`<option value="${escapeAttr(w.id)}" ${p.warehouseId===w.id?'selected':''}>${escapeHtml(w.warehouseName)}</option>`).join('')}</select></label><label>收件人<input id="${prefix}Contact" value="${escapeAttr(p.contact)}"></label><label>電話<input id="${prefix}Phone" value="${escapeAttr(p.phone)}"></label><label class="logistics-wide">地址<input id="${prefix}Address" value="${escapeAttr(p.address)}"></label><label>件數<input id="${prefix}Packages" type="number" min="1" max="99" step="1" value="${p.packages}"></label><label>配送條件<select id="${prefix}Condition">${['常溫','冷藏','冷凍','乾冰'].map(c=>`<option ${p.condition===c?'selected':''}>${c}</option>`).join('')}</select></label><label>物流單號<input id="${prefix}Tracking" value="${escapeAttr(p.tracking)}"></label><label class="logistics-wide">配送備註<input id="${prefix}Notes" value="${escapeAttr(p.notes)}"></label></div>`;
  }
  function readFields(prefix='logistics'){return plan(Object.fromEntries(['mode','warehouseId','contact','phone','address','packages','condition','tracking','notes'].map(key=>[key,$(prefix+({warehouseId:'Warehouse'}[key]||key[0].toUpperCase()+key.slice(1)))?.value||''])));}
  root.warehouseDeliveryModeChanged=function(prefix='logistics',fillWarehouse=false){
    const mode=$(prefix+'Mode')?.value,w=$(prefix+'Warehouse');if(w)w.closest('label').style.display=mode==='TRANSFER'?'':'none';
    if(mode==='TRANSFER'&&fillWarehouse){const wh=warehouseMasterCache.find(x=>x.id===w.value);if(wh){$(prefix+'Address').value=wh.address||wh.shippingAddress||'';$(prefix+'Contact').value=wh.contact||wh.contactName||wh.warehouseName;$(prefix+'Phone').value=wh.phone||'';}}
    if(prefix==='logistics'&&editor&&['PICKUP','SALES_SHIP'].includes(mode)){
      const person=salesList.find(s=>s.uid===editor.row.order.ownerUid||s.code===editor.row.order.salesCode);
      if(!$(prefix+'Contact').value)$(prefix+'Contact').value=person?.name||editor.row.order.salesName||'';
      if(!$(prefix+'Phone').value)$(prefix+'Phone').value=person?.phone||'';
    }
  };
  root.refreshOrderShippingWarehouses=function(){
    const field=$('orderShippingWarehouse');if(!field)return;const current=field.value;
    field.innerHTML='<option value="">選擇倉庫</option>'+warehouseMasterCache.filter(w=>w.active!==false&&!w.systemCustody).map(w=>`<option value="${escapeAttr(w.id)}">${escapeHtml(w.warehouseName)}</option>`).join('');field.value=current;
  };
  root.orderShippingInstructions=()=>readFields('orderShipping');
  root.setOrderShippingInstructions=function(value={}){const host=$('orderShippingFields');if(!host)return;host.innerHTML=fields(plan(value),'orderShipping');root.warehouseDeliveryModeChanged('orderShipping');};
  root.openWarehouseDeliveryPlan=async function(orderId,itemId){
    if(!allowed()||shippingBatch?.busy)return;const row=rows(true).find(r=>r.order.id===orderId&&r.item.itemId===itemId);if(!row)return showActionFeedback('此品項目前沒有倉庫待出數量。','warning');
    editor={row,id:lifecycleRecordId(),busy:false,uid:currentUser.uid,role:currentUserRole};
    modal(`<h3>交付設定</h3><p>${escapeHtml(row.order.salesName||'未指定業務')}｜${escapeHtml(row.order.customerName||'')}<br>${escapeHtml(row.item.itemCode)} ${escapeHtml(row.item.itemName)}｜${escapeHtml(warehouseName(row.warehouseId))}｜待出 ${row.qty}</p>${fields(rowPlan(row))}<p class="inventory-work-status">存設定與列印不異動庫存。寄給業務／業務自取會轉為「業務保管待送」；轉送倉庫則等待目的倉點收入庫。</p><div class="toolbar"><button type="button" id="logisticsSave" onclick="saveWarehouseDeliveryPlan(this)">儲存設定</button><button type="button" class="btn-secondary" onclick="printWarehouseDeliveryEditor('labels')">列印地址貼紙</button><button type="button" class="btn-secondary" onclick="printWarehouseDeliveryEditor('list')">列印出貨清單</button><button type="button" class="btn-secondary" onclick="closeWarehouseLogistics()">關閉</button></div>`);root.warehouseDeliveryModeChanged();
  };
  root.saveWarehouseDeliveryPlan=async function(button){
    if(!editor||editor.busy||!allowed())return;const entry=editor;let p;
    try{p=validatePlan(readFields(),false);}catch(err){return alert(err.message);}
    entry.busy=true;let committed=false;const bs=beginActionButton(button,'儲存中…');
    try{await runRoleTransaction(async tx=>{
      if(entry.uid!==currentUser.uid||entry.role!==currentUserRole)throw Error('登入身分已變更。');
      const ref=db.collection('orders').doc(entry.row.order.id),snap=await tx.get(ref);if(!snap.exists)throw Error('訂單不存在。');const order=snap.data();
      if(normalizedOrderStatus(order)!=='normal')throw Error('訂單已取消。');
      if((order.logisticsHistory||[]).some(h=>h.id===entry.id))return;
      const index=order.items.findIndex(i=>i.itemId===entry.row.item.itemId);if(index<0)throw Error('品項已變更。');
      const now=new Date().toISOString(),items=order.items.map((i,n)=>n===index?{...i,deliveryPlan:p}:i);
      tx.update(ref,{items,logisticsPlanEventId:entry.id,logisticsPlanItemIndex:index,logisticsPlanActorUid:currentUser.uid,logisticsHistory:firebase.firestore.FieldValue.arrayUnion({id:entry.id,action:'交付設定',itemId:entry.row.item.itemId,by:deliveryActor(),at:now,detail:modes[p.mode]+'｜'+p.address}),updatedAt:now});
    });committed=true;await refreshRows(entry.row.order.id);showActionFeedback('交付設定已儲存。');entry.busy=false;root.closeWarehouseLogistics();
    }catch(err){showActionFeedback((committed?'設定已儲存，清單更新失敗：':'儲存失敗：')+err.message,'warning');}finally{entry.busy=false;endActionButton(button,bs);if(editor===entry&&!entry.busy&&$('warehouseLogisticsOverlay')?.classList.contains('active')){/* keep fields on failure */}}
  };
  async function refreshRows(orderId){
    await loadWarehouseMaster(true);if(orderId)await refreshAffectedOrderCaches([orderId]);await loadOrderWorkQueue(true);root.renderInventoryShipping?.();markMainPageDirty('inventory','orders.list','orders.po','admin');
  }
  root.toggleWarehouseShippingSelection=function(orderId,itemId,checked){if(shippingBatch?.busy)return;const key=orderId+'__'+itemId;checked?selected.add(key):selected.delete(key);updateSelection();};
  root.clearWarehouseShippingSelection=()=>{selected.clear();updateSelection();};
  root.isWarehouseShippingSelected=(orderId,itemId)=>selected.has(orderId+'__'+itemId);
  function updateSelection(){
    const status=$('warehouseShippingSelectionStatus'),button=$('warehouseShippingBatchBtn');
    if(status)status.textContent=selected.size?`已勾選 ${selected.size} 個品項`:'尚未勾選品項';
    if(button)button.disabled=!selected.size||!!shippingBatch?.busy||!allowed();
  }
  root.setWarehouseShippingVisibleRows=function(list){visibleRows=list;if(!shippingBatch?.busy)for(const key of [...selected])if(!list.some(r=>r.key===key))selected.delete(key);updateSelection();};
  root.selectVisibleWarehouseShipping=function(checked){if(!allowed()||shippingBatch?.busy)return;for(const row of visibleRows)checked?selected.add(row.key):selected.delete(row.key);root.renderInventoryShipping?.();};
  async function selectedRows(){
    const ctx=context();
    const keys=[...selected];if(!keys.length)throw Error('請先勾選本批品項。');
    await loadOrderWorkQueue(true);const list=rows().filter(r=>keys.includes(r.key));
    if(ctx!==context()||!allowed())throw Error('登入身分或權限已變更。');
    if(keys.some(key=>!list.some(r=>r.key===key)))throw Error('部分品項已出貨或狀態變更，請重新勾選。');
    return list;
  }
  root.exportSelectedWarehouseShipping=async function(button){
    if(!allowed())return;const bs=beginActionButton(button,'匯出中…');
    try{const groups=partition(await selectedRows(),rowPlan).map(g=>({...g,warehouseName:warehouseName(g.warehouseId)}));
      const url=URL.createObjectURL(new Blob([csvDocument(groups)],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');
      link.href=url;link.download='出貨通知清單-'+localDateString()+'.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      showActionFeedback('清單已匯出，可傳給分倉庫；匯出不會登記出貨。','success');
    }catch(err){showActionFeedback('匯出失敗：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
  function batchProgress(jobs){const status=$('warehouseShippingBatchProgress');if(status)status.textContent=`已完成 ${jobs.filter(j=>j.done).length}／${jobs.length} 個品項`;
    for(const [i,j] of jobs.entries()){const el=$('warehouseShippingBatchRow'+i);if(el)el.textContent=j.done?'已完成':j.error?'未完成：'+j.error:'待處理';}
  }
  root.openWarehouseShippingBatch=async function(){
    if(!allowed()||shippingBatch?.busy||batchOpening)return;
    if(shippingBatch?.jobs.some(j=>!j.done)){return showActionFeedback('請先完成或關閉目前的批次視窗。','warning');}
    batchOpening=true;const button=$('warehouseShippingBatchBtn'),bs=beginActionButton(button,'核對中…');
    try{const list=await selectedRows(),jobs=batchJobs(list,rowPlan,lifecycleRecordId());
      if(!queueContext)queueContext=context();
      shippingBatch={jobs,uid:currentUser.uid,role:currentUserRole,busy:false};
      modal(`<h3>確認本批已出貨</h3><p>請確認實體貨品已寄出或交付。分倉庫須收到寄出確認後才登記。</p><label>本批日期<input id="warehouseShippingBatchDate" type="date" value="${localDateString()}"></label><label>物流單號／備註<input id="warehouseShippingBatchNotes" maxlength="500"></label><div class="table-wrap"><table><thead><tr><th>業務／客戶</th><th>品項／目的地</th><th>本次數量</th><th>結果</th></tr></thead><tbody>${jobs.map((j,i)=>`<tr><td>${escapeHtml(j.row.order.salesName)}<br>${escapeHtml(j.row.order.customerName)}</td><td>${escapeHtml(j.row.item.itemCode)} ${escapeHtml(j.row.item.itemName)}<br>${escapeHtml(modes[j.plan.mode])}｜${escapeHtml(j.plan.contact||j.row.order.salesName)}<br>${escapeHtml(j.plan.address)}</td><td><input aria-label="本次出貨數量" data-batch-qty="${i}" type="number" min="0" max="${j.qty}" step="any" value="${j.qty}" ${j.plan.mode==='CUSTOMER_SHIP'?'':'readonly'}></td><td id="warehouseShippingBatchRow${i}">待處理</td></tr>`).join('')}</tbody></table></div><p>寄給客戶會同步訂單已送貨數量；交付業務及轉倉保留各自狀態。轉倉／交付業務須整個品項剩餘數量到齊才能交付。</p><p id="warehouseShippingBatchProgress" role="status"></p><div class="toolbar"><button id="warehouseShippingBatchConfirm" onclick="confirmWarehouseShippingBatch(this)">確認本批已出貨</button><button class="btn-secondary" onclick="closeWarehouseShippingBatch()">關閉</button></div>`);
    }catch(err){showActionFeedback('無法建立出貨批次：'+err.message,'warning');}finally{batchOpening=false;endActionButton(button,bs);updateSelection();}
  };
  root.closeWarehouseShippingBatch=function(){if(shippingBatch?.busy)return;shippingBatch=null;root.closeWarehouseLogistics();updateSelection();};
  root.confirmWarehouseShippingBatch=async function(button){
    const batch=shippingBatch;if(!batch||batch.busy||!allowed())return;
    try{
      if(batch.uid!==currentUser.uid||batch.role!==currentUserRole)throw Error('登入身分已變更，請重新建立批次。');
      if(!batch.started){
        batch.date=$('warehouseShippingBatchDate').value;batch.notes=$('warehouseShippingBatchNotes').value.trim();
        if(!/^\d{4}-\d{2}-\d{2}$/.test(batch.date)||new Date(batch.date+'T00:00:00Z').toISOString().slice(0,10)!==batch.date)throw Error('請填寫有效出貨日期。');
        document.querySelectorAll('[data-batch-qty]').forEach(input=>{const job=batch.jobs[Number(input.dataset.batchQty)],qty=Number(input.value);if(!Number.isFinite(qty)||qty<=0||qty>job.row.qty||(job.plan.mode!=='CUSTOMER_SHIP'&&qty!==job.row.qty))throw Error('請核對本次出貨數量。');job.qty=qty;});
        batch.started=true;document.querySelectorAll('[data-batch-qty],#warehouseShippingBatchDate,#warehouseShippingBatchNotes').forEach(input=>input.disabled=true);
      }
    }catch(err){return showActionFeedback(err.message,'warning');}
    batch.busy=true;const bs=beginActionButton(button,'出貨登記中…');updateSelection();
    try{
      const result=await processBatch(batch.jobs,async job=>{
        if(batch.uid!==currentUser.uid||batch.role!==currentUserRole||!allowed())throw Error('登入身分或權限已變更。');
        const {row,plan:p,qty,operationId}=job;
        if(p.mode==='CUSTOMER_SHIP')await root.commitInventoryShipment({orderId:row.order.id,itemId:row.item.itemId,qty,date:batch.date,notes:batch.notes||p.tracking||p.notes,operationId,expectedWarehouseId:row.warehouseId,expectedPlan:p});
        else await root.commitWarehouseTransfer({id:operationId,orderId:row.order.id,itemId:row.item.itemId,qty,handoff:p.mode!=='TRANSFER',toWarehouseId:p.warehouseId,expectedWarehouseId:row.warehouseId,expectedPlan:p});
        selected.delete(row.key);invalidateWarehouseStockCache(inventoryProductKey(row.item),row.warehouseId);
      },batchProgress);
      try{await refreshAffectedOrderCaches([...new Set(batch.jobs.filter(j=>j.done).map(j=>j.row.order.id))]);await loadWarehouseMaster(true);await loadOrderWorkQueue(true);await loadInventory(true);await root.loadWarehouseTransferQueue(true);root.renderInventoryShipping?.();}
      catch(err){showActionFeedback('已完成的出貨已儲存，清單更新失敗：'+err.message,'warning');}
      markMainPageDirty('inventory','orders.list','orders.po','admin');
      if(result.complete){batch.busy=false;root.closeWarehouseShippingBatch();showActionFeedback(`本批 ${result.total} 個品項已完成，訂單與庫存已同步。`,'success');}
      else {showActionFeedback(`已完成 ${result.completed}／${result.total} 個品項；未完成項目可在此重試，不會重複扣庫存。`,'warning');}
    }finally{batch.busy=false;endActionButton(button,bs);if(shippingBatch===batch)button.textContent='重試未完成品項';updateSelection();}
  };
  function printDocument(groups,kind){
    const pages=[];for(const g of groups){const p=g.plan;
      if(kind==='labels'){
        if(p.mode==='PICKUP')throw Error('業務自取不需地址貼紙，請改列印出貨清單。');validatePlan(p,true);
        for(let n=1;n<=p.packages;n++)pages.push(`<section class="label"><h2>收件人：${escapeHtml(p.contact)}</h2><h2>${escapeHtml(p.phone)}</h2><div class="address">${escapeHtml(p.address)}</div><p>${escapeHtml(p.condition)}｜第 ${n}／${p.packages} 件</p><p>${escapeHtml(p.notes)}</p><p>寄出倉庫：${escapeHtml(warehouseName(g.warehouseId))}</p><small>又鑫生物科技｜02-2100-1008<br>訂單：${escapeHtml([...new Set(g.rows.map(r=>r.order.orderNo||r.order.quoteNo||r.order.id))].join('、'))}</small></section>`);
      }else pages.push(`<section><h2>出貨清單｜${escapeHtml(warehouseName(g.warehouseId))}</h2><p>${escapeHtml(modes[p.mode])}｜${escapeHtml(p.condition)}</p><p>收件人：${escapeHtml(p.contact)}　電話：${escapeHtml(p.phone)}</p><p>地址：${escapeHtml(p.address)}<br>備註：${escapeHtml(p.notes)}</p><table><thead><tr><th>訂單／業務／客戶</th><th>貨號／品名</th><th>數量</th></tr></thead><tbody>${g.rows.map(r=>`<tr><td>${escapeHtml(r.order.orderNo||r.order.quoteNo||r.order.id)}<br>${escapeHtml(r.order.salesName)}｜${escapeHtml(r.order.customerName)}</td><td>${escapeHtml(r.item.itemCode)}<br>${escapeHtml(r.item.itemName)}</td><td>${r.qty}</td></tr>`).join('')}</tbody></table><p>請核對實體數量。本清單與地址貼紙不代表已出貨。</p></section>`);
    }
    let frame=$('warehousePrintFrame');if(frame)frame.remove();frame=document.createElement('iframe');frame.id='warehousePrintFrame';frame.className='warehouse-print-frame';
    frame.onload=()=>{frame.contentWindow.focus();frame.contentWindow.print();};
    frame.srcdoc=`<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><title>${kind==='labels'?'收件地址貼紙':'出貨清單'}</title><style>@page{size:${kind==='labels'?'100mm 150mm':'A4'};margin:8mm}body{font:16px sans-serif;color:#111}section{break-after:page}section:last-child{break-after:auto}.label{overflow-wrap:anywhere}.address{font-size:26px;line-height:1.5}h2{font-size:22px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #666;padding:8px;overflow-wrap:anywhere}thead{display:table-header-group}tr{break-inside:avoid}</style></head><body>${pages.join('')}</body></html>`;
    document.body.appendChild(frame);
  }
  root.printWarehouseDeliveryEditor=function(kind){if(!allowed()||!editor)return;try{const p=validatePlan(readFields(),kind==='labels');printDocument([{warehouseId:editor.row.warehouseId,plan:p,rows:[editor.row]}],kind);}catch(err){alert(err.message);}};
  root.printSelectedWarehouseShipping=async function(kind,button){
    if(!allowed())return;const bs=beginActionButton(button,'核對中…');try{
      await loadOrderWorkQueue(true);const list=rows().filter(r=>selected.has(r.key));if(!list.length)throw Error('請先勾選要併單的品項。');
      const missing=[...selected].filter(key=>!list.some(r=>r.key===key));if(missing.length)throw Error('部分勾選品項已出貨或狀態變更，請重新選擇。');
      const groups=partition(list,rowPlan);printDocument(groups,kind);
    }catch(err){alert(err.message);}finally{endActionButton(button,bs);}
  };
  root.renderWarehouseCustody=function(){
    const host=$('warehouseCustodyQueue');if(!host)return;
    const list=rows(true).filter(r=>r.warehouse?.systemCustody);
    host.innerHTML=list.length?`<details class="warehouse-custody-details"><summary>業務保管待送（${list.length}）</summary><p>貨已交付業務，仍保留客戶訂單占用。送達客戶由業務在訂單頁登錄；需取回時先設定轉送倉庫，再寄回點收。</p><div class="table-wrap inventory-work-table"><table><thead><tr><th>業務／客戶</th><th>品項</th><th>待送數量</th><th>操作</th></tr></thead><tbody>${list.slice(0,50).map(r=>`<tr><td data-th="業務／客戶">${escapeHtml(r.order.salesName)}<br>${escapeHtml(r.order.customerName)}</td><td data-th="品項">${escapeHtml(r.item.itemCode)}<br>${escapeHtml(r.item.itemName)}</td><td data-th="待送數量">${r.qty}</td><td data-th="操作"><button class="btn-secondary" onclick="openWarehouseDeliveryPlan(${inlineJsValue(r.order.id)},${inlineJsValue(r.item.itemId)})">設定退回倉庫</button><button onclick="startOrderWarehouseTransfer(${inlineJsValue(r.order.id)},${inlineJsValue(r.item.itemId)},this)">確認寄回倉庫</button></td></tr>`).join('')}</tbody></table></div></details>`:'';
  };
  root.confirmWarehouseDelivery=async function(orderId,itemId,button){
    if(!allowed())return;const row=rows().find(r=>r.order.id===orderId&&r.item.itemId===itemId);if(!row)return;const p=rowPlan(row);
    if(p.mode==='CUSTOMER_SHIP'){try{validatePlan(p,true);}catch(err){return alert(err.message);}return root.openInventoryShipment(orderId,itemId,button);}
    if(p.mode==='TRANSFER')return root.startOrderWarehouseTransfer(orderId,itemId,button);
    if(p.mode==='SALES_SHIP'){try{validatePlan(p,true);}catch(err){return alert(err.message);}}
    if(!confirm(`${modes[p.mode]}：${row.item.itemCode} × ${row.qty}\n將轉為業務保管待送；客戶訂單不會標為已送貨。`))return;
    const id=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());const bs=beginActionButton(button,'交付中…');
    try{await root.commitWarehouseTransfer({id,orderId,itemId,qty:row.qty,handoff:true});delete button.dataset.operationId;await refreshRows(orderId);await loadInventory(true);showActionFeedback('已交付業務，保留訂單占用；業務送達客戶時再登錄送貨。');}
    catch(err){showActionFeedback('交付未完成：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
  root.startOrderWarehouseTransfer=async function(orderId,itemId,button){
    const row=rows(true).find(r=>r.order.id===orderId&&r.item.itemId===itemId);if(!allowed()||!row)return;const p=rowPlan(row);
    try{validatePlan(p,true);}catch(err){return alert(err.message);}
    if(!confirm(`將 ${row.item.itemCode} × ${row.qty} 寄往 ${warehouseName(p.warehouseId)}？\n目的倉確認收貨前，這批貨無法送貨；不會完成客戶訂單。`))return;
    const id=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());const bs=beginActionButton(button,'調撥中…');
    try{await root.commitWarehouseTransfer({id,orderId,itemId,qty:row.qty,toWarehouseId:p.warehouseId});delete button.dataset.operationId;await refreshRows(orderId);await root.loadWarehouseTransferQueue(true);await loadInventory(true);showActionFeedback('已建立調撥，目的倉收貨後才可出貨。');}
    catch(err){showActionFeedback('調撥未完成：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
  root.receiveWarehouseTransfer=async function(id,button){
    if(!allowed()||pending.has(id))return;if(!confirm('已點收這筆調撥貨品，確認全部入庫？'))return;
    pending.add(id);const bs=beginActionButton(button,'入庫中…');
    try{const result=await root.commitWarehouseTransferReceipt(id);await refreshRows(result.orderId);await loadInventory(true);await root.loadWarehouseTransferQueue(true);showActionFeedback('調撥已入庫，原訂單占用已移到收貨倉庫。');}
    catch(err){showActionFeedback('調撥收貨未完成：'+err.message,'warning');}finally{pending.delete(id);endActionButton(button,bs);}
  };
})(typeof globalThis!=='undefined'?globalThis:this);

/* All stock/location, lot, reservation and order changes are buffered in one role transaction. */
async function commitWarehouseTransfer({id,inventoryId='',fromWarehouseId='',toWarehouseId='',qty,orderId='',itemId='',handoff=false,expectedWarehouseId='',expectedPlan=null}){
  if(!canReceiveInventoryCapability()||!canAccessPage('inventory'))throw Error('無調撥權限。');
  if(!id||!Number.isFinite(qty)||qty<=0)throw Error('調撥資料不正確。');
  const actorUid=currentUser.uid,actorRole=currentUserRole;let saved;
  await runRoleTransaction(async tx=>{
    const transferRef=db.collection('stockTransfers').doc(id),prior=await tx.get(transferRef);
    if(prior.exists){saved=prior.data();if(saved.orderId!==orderId||saved.itemId!==itemId||Number(saved.qty)!==qty||(!orderId&&(saved.inventoryId!==inventoryId||saved.fromWarehouseId!==fromWarehouseId||saved.toWarehouseId!==toWarehouseId)))throw Error('調撥操作識別碼衝突。');return;}
    let order=null,item=null,index=-1,orderRef=null,reservationRef=null,reservation=null;
    if(orderId){
      orderRef=db.collection('orders').doc(orderId);const orderSnap=await tx.get(orderRef);if(!orderSnap.exists)throw Error('訂單不存在。');order=orderSnap.data();
      if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order))throw Error('訂單不可出貨。');
      index=order.items.findIndex(i=>i.itemId===itemId);item=normalizedOrderItems(order)[index];
      if(!item||(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'||item.transferPendingId)throw Error('品項不可調撥。');
      const remaining=Math.max(0,Number(item.qty||item.orderedQty||0)-Math.max(0,Number(item.deliveredQty||0)-Number(item.returnedQty||0)));
      if(qty!==remaining||qty!==Number(item.reservedQty)||qty>itemDispatchState(order,item).shippable)throw Error('轉倉或交付業務須等此品項剩餘數量全部到貨、占用並完成打單，再一次交付，避免後續到貨混到不同倉庫。');
      fromWarehouseId=item.warehouseId||order.warehouseId||defaultWarehouse()?.id||'';inventoryId=inventoryRefFor(item)?.id||'';
      if(handoff){const p=YushinWarehouseLogistics.validatePlan(item.deliveryPlan||order.shippingInstructions||{},false);if(!['PICKUP','SALES_SHIP'].includes(p.mode))throw Error('請先設定交付業務的方式。');if(p.mode==='SALES_SHIP')YushinWarehouseLogistics.validatePlan(p,true);if(!order.ownerUid)throw Error('訂單缺少負責業務。');toWarehouseId='custody-'+order.ownerUid;}
      else{const p=YushinWarehouseLogistics.validatePlan(item.deliveryPlan||order.shippingInstructions||{},true);if(p.mode!=='TRANSFER'||p.warehouseId!==toWarehouseId)throw Error('請先儲存正確的轉倉設定。');}
      if(expectedWarehouseId&&fromWarehouseId!==expectedWarehouseId)throw Error('出貨倉庫已變更，請重新核對。');
      if(expectedPlan&&JSON.stringify(YushinWarehouseLogistics.plan(item.deliveryPlan||order.shippingInstructions||{}))!==JSON.stringify(expectedPlan))throw Error('寄送資訊已變更，請重新核對。');
      reservationRef=db.collection('inventoryReservations').doc(orderId+'__'+itemId);const rs=await tx.get(reservationRef);if(!rs.exists)throw Error('找不到訂單占用。');reservation=rs.data();
      if(Number(reservation.quantity)!==qty||reservation.warehouseId!==fromWarehouseId)throw Error('訂單占用已變更。');
    }else if(handoff)throw Error('業務交付必須有來源訂單。');
    if(!inventoryId||!fromWarehouseId||!toWarehouseId||fromWarehouseId===toWarehouseId)throw Error('請選擇不同的來源與目的倉庫。');
    const invRef=db.collection('inventory').doc(inventoryId),invSnap=await tx.get(invRef);if(!invSnap.exists)throw Error('找不到庫存。');const inv=invSnap.data(),key=String(inv.productKey||inv.productId||'');if(!key)throw Error('庫存缺少產品識別。');
    const sourceWhRef=db.collection('warehouses').doc(fromWarehouseId),destWhRef=db.collection('warehouses').doc(toWarehouseId);
    const sourceWh=await tx.get(sourceWhRef),destWh=await tx.get(destWhRef);if(!sourceWh.exists||sourceWh.data().active===false)throw Error('來源倉庫已停用。');
    if(handoff&&destWh.exists&&(destWh.data().active===false||!destWh.data().systemCustody||destWh.data().ownerUid!==order.ownerUid))throw Error('業務保管位置已停用或不正確。');
    if(!handoff&&(!destWh.exists||destWh.data().active===false||destWh.data().systemCustody))throw Error('目的倉庫不存在或已停用。');
    const fromRef=db.collection('warehouseStocks').doc(warehouseStockDocId(fromWarehouseId,key)),toRef=db.collection('warehouseStocks').doc(warehouseStockDocId(toWarehouseId,key));
    const fromSnap=await tx.get(fromRef),toSnap=handoff?await tx.get(toRef):null;if(!fromSnap.exists)throw Error('來源倉庫無此庫存。');
    const from=fromSnap.data(),reservedQty=orderId?qty:0;YushinWarehouseLogistics.transferable(from,qty,reservedQty);
    const lotQuery=await firestoreReadWithTimeout(db.collection('inventoryLots').where('productKey','==',key).where('warehouseId','==',fromWarehouseId).limit(201).get(),'調撥批次');
    if(lotQuery.size>200)throw Error('批次超過安全處理上限。');
    const lotSnaps=await Promise.all(lotQuery.docs.map(d=>tx.get(d.ref))),trackedLots=lotSnaps.filter(d=>d.exists).map(d=>({...d.data(),id:d.id}));
    const unbatchedRef=db.collection('inventoryLots').doc(id+'-unbatched-source');
    const unbatchedSnap=orderId?null:await tx.get(unbatchedRef);
    if(unbatchedSnap?.exists)throw Error('未分批庫存識別碼衝突。');
    const reconciled=orderId?{lots:trackedLots,unbatched:null}:YushinInventory.reconcileStockLots(trackedLots,Number(from.onHand),unbatchedRef.id);
    const lots=reconciled.lots;
    const allocation=YushinInventory.allocateLots(lots,qty),now=new Date().toISOString(),who=deliveryActor();
    if(actorUid!==currentUser.uid||actorRole!==currentUserRole)throw Error('登入身分已變更。');
    const allocations=allocation.allocations.map((a,n)=>({...a,targetLotId:id+'-'+n,...(lots.find(l=>l.id===a.lotId)?.unbatched?{unbatched:true}:{}),costLotId:lots.find(l=>l.id===a.lotId)?.costLotId||a.lotId}));
    saved={id,inventoryId,productKey:key,productId:inv.productId||key,itemCode:inv.itemCode||item?.itemCode||'',itemName:inv.itemName||item?.itemName||'',brand:inv.brand||'',brandId:inv.brandId||'',fromWarehouseId,toWarehouseId,fromStockId:fromRef.id,toStockId:toRef.id,qty,reservedQty,status:handoff?'RECEIVED':'IN_TRANSIT',kind:handoff?'HANDOFF':'TRANSFER',orderId,itemId,itemIndex:index,orderNo:order?.orderNo||order?.quoteNo||'',salesName:order?.salesName||'',ownerUid:order?.ownerUid||'',salesCode:order?.salesCode||'',allocations,createdAt:now,createdBy:who,createdByUid:actorUid,...(handoff?{receivedAt:now,receivedByUid:actorUid}:{}),deliveryPlan:order?YushinWarehouseLogistics.plan(item.deliveryPlan||order.shippingInstructions||{}):{}};
    tx.set(transferRef,saved);
    tx.update(fromRef,{onHand:Number(from.onHand)-qty,reserved:Number(from.reserved||0)-reservedQty,updatedAt:now});
    if(reconciled.unbatched){
      const lot=reconciled.unbatched,issued=allocations.find(a=>a.lotId===lot.id)?.qty||0;
      tx.set(unbatchedRef,{productKey:key,productId:inv.productId||key,warehouseId:fromWarehouseId,lotNo:'',expiryDate:'',receivedQty:lot.receivedQty,remainingQty:lot.remainingQty-issued,unbatched:true,sourceType:'MANUAL_STOCK_BALANCE',sourceId:id,receivedAt:now,createdBy:who});
    }
    for(const a of allocations){if(a.lotId===reconciled.unbatched?.id)continue;const lot=lots.find(l=>l.id===a.lotId);tx.update(db.collection('inventoryLots').doc(a.lotId),{remainingQty:Number(lot.remainingQty??lot.qty)-a.qty,updatedAt:now});}
    if(handoff){
      if(!destWh.exists)tx.set(destWhRef,{warehouseName:'業務保管｜'+(order.salesName||order.ownerUid),active:true,isDefault:false,warehouseType:'CUSTODY',systemCustody:true,ownerUid:order.ownerUid,sourceTransferId:id});
      const target=toSnap?.exists?toSnap.data():{};
      tx.set(toRef,{productKey:key,productId:inv.productId||key,itemCode:inv.itemCode||'',itemName:inv.itemName||'',brand:inv.brand||'',brandId:inv.brandId||'',warehouseId:toWarehouseId,onHand:Number(target.onHand||0)+qty,reserved:Number(target.reserved||0)+reservedQty,incoming:Number(target.incoming||0),updatedAt:now},{merge:true});
      writeTransferLots(tx,saved,inv,now);
      tx.update(reservationRef,{warehouseId:toWarehouseId,updatedAt:now});
    }else tx.update(invRef,{transferInTransit:Number(inv.transferInTransit||0)+qty,transferFreeInTransit:Number(inv.transferFreeInTransit||0)+qty-reservedQty,updatedAt:now});
    tx.set(db.collection('inventoryMovements').doc(id+'-out'),{type:'warehouse_transfer_out',qty:-qty,productKey:key,warehouseId:fromWarehouseId,fromWarehouseId,toWarehouseId,sourceType:'WAREHOUSE_TRANSFER',sourceId:id,transferId:id,orderId,itemId,createdAt:now,createdBy:who,actorUid});
    if(handoff)tx.set(db.collection('inventoryMovements').doc(id+'-in'),{type:'warehouse_transfer_in',qty,productKey:key,warehouseId:toWarehouseId,fromWarehouseId,toWarehouseId,sourceType:'WAREHOUSE_TRANSFER',sourceId:id,transferId:id,orderId,itemId,createdAt:now,createdBy:who,actorUid});
    if(order){
      const items=order.items.map((i,n)=>n===index?{...i,...(handoff?{warehouseId:toWarehouseId,custodyTransferId:id}:{transferPendingId:id})}:i);
      const next={...order,items};tx.update(orderRef,{items,warehouseLogisticsId:id,warehouseLogisticsEventId:id+'-out',logisticsTransfersPending:Number(order.logisticsTransfersPending||0)+(handoff?0:1),logisticsHistory:firebase.firestore.FieldValue.arrayUnion({id,action:handoff?'倉庫交付業務':'倉庫調撥寄出',itemId,by:who,at:now,detail:fromWarehouseId+' → '+toWarehouseId+' × '+qty}),...orderWorkIndexFields(next),updatedAt:now});
    }
  });return saved;
}
function writeTransferLots(tx,transfer,inventory,now){
  for(const a of transfer.allocations){
    const ref=db.collection('inventoryLots').doc(a.targetLotId);
    tx.set(ref,{productKey:transfer.productKey,productId:transfer.productId,warehouseId:transfer.toWarehouseId,lotNo:a.lotNo||'',expiryDate:a.expiryDate||'',qty:a.qty,remainingQty:a.qty,...(a.unbatched?{unbatched:true}:{}),receivedAt:now,createdAt:now,sourceType:'WAREHOUSE_TRANSFER',sourceId:transfer.id,costLotId:a.costLotId,transferId:transfer.id,itemCode:inventory.itemCode||transfer.itemCode,itemName:inventory.itemName||transfer.itemName});
    tx.set(db.collection('inventoryLotCosts').doc(a.targetLotId),{lotId:a.targetLotId,productKey:transfer.productKey,warehouseId:transfer.toWarehouseId,sourceType:'WAREHOUSE_TRANSFER',sourceId:transfer.id,costSourceLotId:a.costLotId,createdAt:now});
  }
}
async function commitWarehouseTransferReceipt(id){
  if(!canReceiveInventoryCapability()||!canAccessPage('inventory'))throw Error('無調撥收貨權限。');let saved;
  await runRoleTransaction(async tx=>{
    const ref=db.collection('stockTransfers').doc(id),snap=await tx.get(ref);if(!snap.exists)throw Error('調撥不存在。');const t={...snap.data(),id};saved=t;if(t.status==='RECEIVED')return;if(t.status!=='IN_TRANSIT')throw Error('調撥狀態不可收貨。');
    const invRef=db.collection('inventory').doc(t.inventoryId),whRef=db.collection('warehouseStocks').doc(t.toStockId),invSnap=await tx.get(invRef),whSnap=await tx.get(whRef),destWh=await tx.get(db.collection('warehouses').doc(t.toWarehouseId));
    if(!invSnap.exists||!destWh.exists||destWh.data().active===false)throw Error('目的倉庫或庫存不存在。');const inv=invSnap.data(),wh=whSnap.exists?whSnap.data():{};
    if(Number(inv.transferInTransit||0)<t.qty||Number(inv.transferFreeInTransit||0)<t.qty-t.reservedQty)throw Error('調撥途中數量不一致。');
    let order=null,orderRef=null,resRef=null;
    if(t.orderId){orderRef=db.collection('orders').doc(t.orderId);const os=await tx.get(orderRef);if(!os.exists)throw Error('來源訂單不存在。');order=os.data();const item=order.items[t.itemIndex];if(!item||item.itemId!==t.itemId||item.transferPendingId!==id||normalizedOrderStatus(order)!=='normal')throw Error('來源訂單或調撥關聯已變更。');resRef=db.collection('inventoryReservations').doc(t.orderId+'__'+t.itemId);const rs=await tx.get(resRef);if(!rs.exists||Number(rs.data().quantity)!==t.reservedQty)throw Error('來源訂單占用不一致。');}
    const now=new Date().toISOString();tx.update(ref,{status:'RECEIVED',receivedAt:now,receivedByUid:currentUser.uid});
    tx.update(invRef,{transferInTransit:Number(inv.transferInTransit)-t.qty,transferFreeInTransit:Number(inv.transferFreeInTransit||0)-(t.qty-t.reservedQty),updatedAt:now});
    tx.set(whRef,{productKey:t.productKey,productId:t.productId,warehouseId:t.toWarehouseId,itemCode:t.itemCode,itemName:t.itemName,brand:t.brand||'',brandId:t.brandId||'',onHand:Number(wh.onHand||0)+t.qty,reserved:Number(wh.reserved||0)+t.reservedQty,incoming:Number(wh.incoming||0),updatedAt:now},{merge:true});writeTransferLots(tx,t,inv,now);
    tx.set(db.collection('inventoryMovements').doc(id+'-in'),{type:'warehouse_transfer_in',qty:t.qty,productKey:t.productKey,warehouseId:t.toWarehouseId,fromWarehouseId:t.fromWarehouseId,toWarehouseId:t.toWarehouseId,sourceType:'WAREHOUSE_TRANSFER',sourceId:id,transferId:id,orderId:t.orderId,itemId:t.itemId,createdAt:now,createdBy:deliveryActor(),actorUid:currentUser.uid});
    if(order){const items=order.items.map((i,n)=>n===t.itemIndex?{...i,warehouseId:t.toWarehouseId,transferPendingId:''}:i);tx.update(resRef,{warehouseId:t.toWarehouseId,updatedAt:now});tx.update(orderRef,{items,warehouseLogisticsId:id,warehouseLogisticsEventId:id+'-received',logisticsTransfersPending:Math.max(0,Number(order.logisticsTransfersPending||0)-1),logisticsHistory:firebase.firestore.FieldValue.arrayUnion({id:id+'-received',action:'倉庫調撥收貨',itemId:t.itemId,by:deliveryActor(),at:now,detail:t.toWarehouseId+' × '+t.qty}),...orderWorkIndexFields({...order,items}),updatedAt:now});}
  });return saved;
}
if(typeof globalThis!=='undefined'){globalThis.commitWarehouseTransfer=commitWarehouseTransfer;globalThis.commitWarehouseTransferReceipt=commitWarehouseTransferReceipt;}
